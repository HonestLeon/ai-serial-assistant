import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'

let currentPort = null
let currentParser = null
let currentOptions = null
let justFloatBuffer = Buffer.alloc(0)

// JustFloat 尾帧标识: 0x00 0x00 0x80 0x7F
const JUSTFLOAT_TAIL = Buffer.from([0x00, 0x00, 0x80, 0x7f])

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
// 单对象格式（兼容既有监听方的对象契约），DataMonitor 对数组逐条入队。
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

function parseJustFloat(buf) {
  const results = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0x80 && buf[i + 3] === 0x7f) {
      const frameData = buf.slice(0, i)
      if (frameData.length >= 4 && frameData.length % 4 === 0) {
        const floats = []
        for (let j = 0; j < frameData.length; j += 4) {
          floats.push(frameData.readFloatLE(j))
        }
        results.push(floats)
      }
      return { floats: results, consumed: i + 4 }
    }
  }
  return { floats: [], consumed: 0 }
}

async function openPort(win, options) {
  // 重复打开前先等待旧端口真正关闭完成：close() 回调后于新连接执行时会把 currentPort
  // 置 null（竞态），导致新连接被清空。同步 await 消除该竞态。
  if (currentPort?.isOpen) {
    await closePort(win).catch(() => {})
  }

  return new Promise((resolve, reject) => {
    const {
      path,
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

    currentPort = new SerialPort(portConfig)

    if (protocol === 'justfloat') {
      justFloatBuffer = Buffer.alloc(0)
      currentPort.on('data', (chunk) => {
        justFloatBuffer = Buffer.concat([justFloatBuffer, chunk])
        let remaining = justFloatBuffer
        while (remaining.length >= 4) {
          const { floats, consumed } = parseJustFloat(remaining)
          if (consumed === 0) break
          for (const frame of floats) {
            const text = frame.map(v => v.toFixed(4)).join(' ')
            queueSerialData(win, {
              raw: text,
              hex: Buffer.from(text).toString('hex'),
              time: Date.now(),
              protocol: 'justfloat',
              channels: frame
            })
          }
          remaining = remaining.slice(consumed)
        }
        justFloatBuffer = remaining
      })
    } else {
      currentParser = currentPort.pipe(new ReadlineParser({ delimiter: '\n' }))
      currentParser.on('data', (line) => {
        queueSerialData(win, {
          raw: line,
          hex: Buffer.from(line).toString('hex'),
          time: Date.now(),
          protocol: 'raw'
        })
      })
    }

    currentPort.on('error', (err) => {
      sendToRenderer(win, 'serial:error', err.message)
    })

    currentPort.open((err) => {
      if (err) {
        currentPort = null
        currentParser = null
        reject(err.message)
      } else {
        sendToRenderer(win, 'serial:status', getStatus())
        resolve(getStatus())
      }
    })
  })
}

function closePort(win) {
  if (!currentPort) return Promise.resolve(getStatus())

  const port = currentPort
  // 关闭前把批处理中未发送的数据刷出，避免丢最后一窗遥测
  flushPendingData(win)

  // 关闭慢的根因之一：close 时 data/parser 监听仍挂在端口上持续处理新数据，
  // serialport(v13/Windows) 的 close() 需要等底层 poller 挂起的读操作返回——
  // 设备不再发数据时就会一直等待，UI 卡在 loading。故先暂停读取并摘除监听再 close。
  return new Promise((resolve) => {
    let settled = false
    let timer

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { port.removeAllListeners('data') } catch { /* noop */ }
      try {
        currentParser?.removeAllListeners?.('data')
        if (typeof port.unpipe === 'function') port.unpipe(currentParser)
      } catch { /* noop */ }
      currentParser = null
      currentPort = null
      currentOptions = null
      justFloatBuffer = Buffer.alloc(0)
      sendToRenderer(win, 'serial:status', getStatus())
      resolve(getStatus())
    }

    // 超时兜底：部分平台/驱动下 close 回调迟迟不触发（poller 等待数据唤醒等），
    // 无论如何在 CLOSE_TIMEOUT_MS 内清理状态并通知渲染进程，避免"关闭串口"一直转圈。
    const CLOSE_TIMEOUT_MS = 500
    timer = setTimeout(finish, CLOSE_TIMEOUT_MS)

    try {
      if (typeof port.pause === 'function') port.pause()
      port.removeAllListeners('data')
    } catch { /* noop */ }

    port.close(finish)
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

    currentPort.write(buffer, (err) => {
      if (err) reject(err.message)
      else resolve(true)
    })
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
