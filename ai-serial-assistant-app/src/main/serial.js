import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { createJustFloatFramer } from './justfloat.js'
import { logEvent } from './logger.js'

let currentPort = null
let currentParser = null
let currentOptions = null
/** JustFloat 切帧器（每次打开按协议重建；纯逻辑抽到 justfloat.js 便于单测） */
let justFloatFramer = null
/** 本次连接是否已提示过"帧未对齐"（同一连接只提示一次，避免刷屏） */
let justFloatMisalignReported = false

// 串口写超时：设备不响应 / 驱动挂起时 write 回调可能永不触发，
// 没有上限会让 ipcRenderer.invoke 永久 pending（自动发送与智能体工具一起卡死）
const WRITE_TIMEOUT_MS = 1500

/** 打开/关闭串行化：并发调用会创建两个 SerialPort 抢同一 COM 口 */
let opChain = Promise.resolve()
function serializeSerialOp(op) {
  const run = opChain.then(op, op)
  opChain = run.then(() => undefined, () => undefined)
  return run
}

function getStatus() {
  return {
    connected: currentPort?.isOpen ?? false,
    path: currentOptions?.path ?? null,
    baudRate: currentOptions?.baudRate ?? null
  }
}

/**
 * 向渲染进程发消息的安全封装：窗口销毁后（用户关窗/应用退出）再调用
 * win.webContents.send 会抛 "TypeError: Object has been destroyed"，
 * 且该异常发生在串口数据回调内会成为主进程未捕获异常。统一在此守卫。
 */
function sendToRenderer(win, channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// ---- 串口数据 IPC 批处理 ----
// 高速遥测（数百行/秒）下逐行 webContents.send 的序列化与消息分发开销
// 是主进程与渲染进程共同的 CPU 热点（低配机上直接表现为整卡）。
// 这里按 DATA_BATCH_MS 时间窗聚合为单条数组消息；批内仅 1 条时保持
// 单对象格式（兼容既有监听方的对象契约），渲染层对两种形态都做归一化。
const DATA_BATCH_MS = 25
const DATA_BATCH_MAX = 64
let pendingData = null
let dataFlushTimer = null

function flushPendingData(win) {
  if (dataFlushTimer) {
    clearTimeout(dataFlushTimer)
    dataFlushTimer = null
  }
  if (!pendingData || !pendingData.length) {
    pendingData = null
    return
  }
  const batch = pendingData
  pendingData = null
  sendToRenderer(win, 'serial:data', batch.length === 1 ? batch[0] : batch)
}

function queueSerialData(win, payload) {
  if (!win || win.isDestroyed()) return
  if (!pendingData) pendingData = []
  pendingData.push(payload)
  if (pendingData.length >= DATA_BATCH_MAX) {
    flushPendingData(win)
    return
  }
  if (!dataFlushTimer) {
    dataFlushTimer = setTimeout(() => {
      dataFlushTimer = null
      flushPendingData(win)
    }, DATA_BATCH_MS)
  }
}

async function listPorts() {
  const ports = await SerialPort.list()
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    vendorId: p.vendorId,
    productId: p.productId
  }))
}

/**
 * 创建本次连接使用的 JustFloat 切帧器。
 * 切帧/边界规则在 justfloat.js 内实现（含"单 chunk 超上限不整块丢弃"与异常帧计数），
 * 这里只负责把帧转成渲染层契约的 payload，并把异常反馈成一次 serial:error。
 */
function createFramerForConnection(win) {
  justFloatMisalignReported = false
  return createJustFloatFramer({
    onFrame: ({ floats, byteLength }) => {
      const text = floats.map((value) => value.toFixed(4)).join(' ')
      queueSerialData(win, {
        raw: text,
        hex: Buffer.from(text).toString('hex'),
        bytes: byteLength,
        time: Date.now(),
        protocol: 'justfloat',
        channels: floats
      })
    },
    onOverflow: ({ droppedBytes, misalignedFrames }) => {
      logEvent('warn', 'serial.justfloat_overflow', { droppedBytes, misalignedFrames })
      sendToRenderer(
        win,
        'serial:error',
        `JustFloat 缓冲超过上限仍未检测到帧尾（00 00 80 7F），已丢弃 ${droppedBytes} 字节脏数据` +
        (misalignedFrames ? `（累计 ${misalignedFrames} 个非 4 字节对齐帧）` : '') +
        '，请确认「数据引擎」选择是否正确'
      )
    },
    onMisaligned: ({ misalignedFrames }) => {
      if (justFloatMisalignReported) return
      justFloatMisalignReported = true
      logEvent('warn', 'serial.justfloat_misaligned', { misalignedFrames })
      sendToRenderer(
        win,
        'serial:error',
        `检测到 ${misalignedFrames} 个非 4 字节对齐的 JustFloat 帧（已跳过），请确认数据引擎与波特率`
      )
    }
  })
}

/**
 * 幂等的端口清理：摘除监听、清空状态、广播一次断开状态。
 * error / close / 用户主动关闭三条路径都可能调用它，重复调用必须是安全的。
 */
function releasePort(win) {
  if (!currentPort) return
  const port = currentPort
  try { port.removeAllListeners('data') } catch { /* noop */ }
  try { port.removeAllListeners('error') } catch { /* noop */ }
  try { port.removeAllListeners('close') } catch { /* noop */ }
  try {
    currentParser?.removeAllListeners?.('data')
    if (typeof port.unpipe === 'function') port.unpipe(currentParser)
  } catch { /* noop */ }
  currentParser = null
  currentPort = null
  currentOptions = null
  // 切帧器随连接销毁：缓冲里的半帧不再保留，异常计数也归零
  justFloatFramer?.reset()
  justFloatFramer = null
  pendingData = null
  if (dataFlushTimer) {
    clearTimeout(dataFlushTimer)
    dataFlushTimer = null
  }
  sendToRenderer(win, 'serial:status', getStatus())
}

/**
 * 打开串口（串行化入口：与 closePort 共用一条操作链，避免并发打开抢同一个 COM 口）。
 * @param {Electron.BrowserWindow|null} win
 * @param {{path:string, baudRate?:number, dataBits?:number, stopBits?:number,
 *   parity?:string, flowControl?:string, protocol?:string}} options
 */
function openPort(win, options) {
  return serializeSerialOp(() => doOpenPort(win, options))
}

async function doOpenPort(win, options) {
  if (!options || typeof options !== 'object') {
    throw new Error('打开串口参数缺失')
  }
  const { path } = options
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('请选择要打开的串口')
  }

  // 重复打开前先等待旧端口真正关闭完成：close() 回调后于新连接执行时会把 currentPort
  // 置 null（竞态），导致新连接被清空。同步 await 消除该竞态。
  if (currentPort?.isOpen) {
    await doClosePort(win).catch(() => {})
  }

  return new Promise((resolve, reject) => {
    const {
      baudRate = 115200,
      dataBits = 8,
      stopBits = 1,
      parity = 'none',
      flowControl = 'none',
      protocol = 'raw'
    } = options

    currentOptions = { ...options, protocol }

    const portConfig = {
      path,
      baudRate: Number(baudRate),
      dataBits: Number(dataBits),
      stopBits: Number(stopBits),
      parity,
      autoOpen: false
    }

    if (flowControl === 'rts/cts') {
      portConfig.rtscts = true
    } else if (flowControl === 'xon/xoff') {
      portConfig.xon = true
      portConfig.xoff = true
    }

    const port = new SerialPort(portConfig)
    currentPort = port

    if (protocol === 'justfloat') {
      // 按连接捕获切帧器：即便之后新建连接，旧端口残留的回调也不会喂进新会话的缓冲
      const framer = createFramerForConnection(win)
      justFloatFramer = framer
      port.on('data', (chunk) => framer.push(chunk))
    } else {
      justFloatFramer = null
      currentParser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
      currentParser.on('data', (line) => {
        queueSerialData(win, {
          raw: line,
          hex: Buffer.from(line).toString('hex'),
          bytes: Buffer.byteLength(line) + 1,
          time: Date.now(),
          protocol: 'raw'
        })
      })
    }

    // error 只发一次提示，随后统一走 releasePort；close 事件同样兜底
    // （Windows 拔盘通常先触发 close 而不是 error）
    port.on('error', (err) => {
      logEvent('error', 'serial.error', { path, message: err.message })
      sendToRenderer(win, 'serial:error', err.message)
      if (currentPort === port) {
        try { port.close(() => {}) } catch { /* noop */ }
        releasePort(win)
      }
    })
    port.on('close', () => {
      if (currentPort === port) {
        logEvent('info', 'serial.closed', { path })
        releasePort(win)
      }
    })

    port.open((err) => {
      if (err) {
        logEvent('warn', 'serial.open_failed', { path, baudRate: Number(baudRate), error: err.message })
        if (currentPort === port) {
          currentPort = null
          currentParser = null
          currentOptions = null
        }
        reject(err.message)
      } else {
        logEvent('info', 'serial.opened', { path, baudRate: Number(baudRate), protocol })
        sendToRenderer(win, 'serial:status', getStatus())
        resolve(getStatus())
      }
    })
  })
}

/** 关闭串口（串行化入口，与 openPort 共用操作链） */
function closePort(win) {
  return serializeSerialOp(() => doClosePort(win))
}

function doClosePort(win) {
  if (!currentPort) return Promise.resolve(getStatus())
  const port = currentPort

  // 关闭前把批处理中未发送的数据刷出，避免丢最后一窗遥测
  flushPendingData(win)

  // 关闭慢的根因之一：close 时 data/parser 监听仍挂在端口上持续处理新数据，
  // serialport(v13/Windows) 的 close() 需要等底层 poller 挂起的读操作返回——
  // 设备不再发数据时就会一直等待，UI 卡在 loading。故先暂停读取并摘除监听再 close。
  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (currentPort === port) {
        logEvent('info', 'serial.closed', { path: currentOptions?.path ?? null, reason: 'requested' })
        releasePort(win)
      }
      resolve(getStatus())
    }

    // 超时兜底：部分平台/驱动下 close 回调迟迟不触发（poller 等待数据唤醒等），
    // 无论如何在 CLOSE_TIMEOUT_MS 内清理状态并通知渲染进程，避免"关闭串口"一直转圈。
    timer = setTimeout(finish, 500)

    try {
      if (typeof port.pause === 'function') port.pause()
      port.removeAllListeners('data')
    } catch { /* noop */ }

    try {
      port.close(finish)
    } catch {
      finish()
    }
  })
}

function send(data, encoding = 'utf8') {
  if (!currentPort?.isOpen) {
    throw new Error('串口未打开')
  }

  return new Promise((resolve, reject) => {
    let buffer
    try {
      if (encoding === 'hex') {
        // 非法 hex 会被 Buffer.from 静默截断（甚至得到 0 字节），表现为"发送成功但对端收不到"。
        // 这里显式校验：非法字符、奇数长度、空内容都直接抛错。
        const cleaned = String(data ?? '').replace(/\s+/g, '')
        if (!cleaned) throw new Error('HEX 发送内容为空')
        if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
          throw new Error(`HEX 含非十六进制字符：${cleaned.slice(0, 16)}`)
        }
        if (cleaned.length % 2 !== 0) {
          throw new Error('HEX 长度必须为偶数（每字节两位）')
        }
        buffer = Buffer.from(cleaned, 'hex')
      } else {
        const text = String(data ?? '')
        if (!text) throw new Error('发送内容为空')
        buffer = Buffer.from(text, 'utf8')
      }
      if (!buffer?.length) throw new Error('发送内容为空')
    } catch (e) {
      reject(e.message)
      return
    }

    const port = currentPort
    if (!port?.isOpen) {
      reject('串口未打开')
      return
    }
    let settled = false
    let timer = null
    // 写超时兜底：设备不响应时 write 回调可能永不触发，
    // 不设上限会让渲染层 invoke 永久 pending（自动发送会越堆越多）
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(true)
    }
    timer = setTimeout(
      () => {
        logEvent('warn', 'serial.write_timeout', { bytes: buffer.length, timeoutMs: WRITE_TIMEOUT_MS })
        finish(`串口写入超时（${WRITE_TIMEOUT_MS}ms 未完成，设备可能未响应）`)
      },
      WRITE_TIMEOUT_MS
    )

    try {
      port.write(buffer, (err) => finish(err ? err.message : null))
    } catch (e) {
      finish(e?.message || String(e))
    }
  })
}

function setDtr(value) {
  if (!currentPort?.isOpen) throw new Error('串口未打开')
  currentPort.set({ dtr: !!value })
}

function setRts(value) {
  if (!currentPort?.isOpen) throw new Error('串口未打开')
  currentPort.set({ rts: !!value })
}

export { getStatus, listPorts, openPort, closePort, send, setDtr, setRts }
