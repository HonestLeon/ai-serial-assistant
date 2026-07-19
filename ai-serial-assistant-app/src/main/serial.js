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

function openPort(win, options) {
  if (currentPort?.isOpen) {
    closePort()
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
            win.webContents.send('serial:data', {
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
        win.webContents.send('serial:data', {
          raw: line,
          hex: Buffer.from(line).toString('hex'),
          time: Date.now(),
          protocol: 'raw'
        })
      })
    }

    currentPort.on('error', (err) => {
      win.webContents.send('serial:error', err.message)
    })

    currentPort.open((err) => {
      if (err) {
        currentPort = null
        currentParser = null
        reject(err.message)
      } else {
        win.webContents.send('serial:status', getStatus())
        resolve(getStatus())
      }
    })
  })
}

function closePort(win) {
  if (!currentPort) return Promise.resolve(getStatus())

  return new Promise((resolve) => {
    currentPort.close(() => {
      if (win) {
        win.webContents.send('serial:status', getStatus())
      }
      currentPort = null
      currentParser = null
      currentOptions = null
      justFloatBuffer = Buffer.alloc(0)
      resolve(getStatus())
    })
  })
}

function send(data, encoding = 'utf8') {
  if (!currentPort?.isOpen) {
    throw new Error('串口未打开')
  }

  return new Promise((resolve, reject) => {
    const buffer = encoding === 'hex' ? Buffer.from(data.replace(/\s/g, ''), 'hex') : Buffer.from(data, 'utf8')
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
