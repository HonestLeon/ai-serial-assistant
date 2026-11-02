import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { listPorts, openPort, closePort, send, setDtr, setRts } from './serial.js'
import { requestCompletion, validateModelUrl } from './llmProxy.js'
import { flushLogger, getLogPath, initLogger, logEvent } from './logger.js'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
let mainWindow = null
let quitting = false
/** 进行中的 LLM 请求：requestId → AbortController */
const llmRequests = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    // 自绘标题栏：窗口控制按钮由渲染层通过 IPC 触发（Windows 无原生 caption buttons）
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  // 外链只允许 http/https，避免 file:/自定义 scheme 被 shell 打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url)
    } catch { /* 非法 URL 直接忽略 */ }
    return { action: 'deny' }
  })
  // 阻止页面被导航到外部地址（防止误操作把应用变成浏览器）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = (() => { try { return new URL(url) } catch { return null } })()
    const current = mainWindow?.webContents.getURL() || ''
    if (!target || !current.startsWith(target.origin)) {
      event.preventDefault()
    }
  })

  // 渲染进程崩溃/重载后请求已无人消费：立即中止，避免空跑到 120s 超时
  mainWindow.webContents.on('render-process-gone', () => abortAllLlmRequests())

  mainWindow.on('closed', () => {
    abortAllLlmRequests()
    mainWindow = null
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

function registerWindowControls() {
  ipcMain.on('window:minimize', (event) => windowFromEvent(event)?.minimize())
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => windowFromEvent(event)?.close())
  ipcMain.handle('window:is-maximized', (event) => windowFromEvent(event)?.isMaximized() ?? false)
}

/**
 * LLM 请求主进程代理：
 * - 渲染进程不必直连第三方 API，规避 CORS 与页面侧 Key 暴露；
 * - 统一安全边界（仅 https / 禁止重定向 / 响应体上限，见 llmProxy.js）；
 * - 统一超时与中止（stopAgent 时渲染层发 llm:abort，关窗时 abortAllLlmRequests）。
 * 返回值刻意做成 { ok, status, text, error } 的朴素结构，方便渲染层包装成 fetch 语义。
 */
function registerLlmProxy() {
  ipcMain.handle('llm:request', async (_event, payload) => {
    const { requestId, url, method = 'POST', headers = {}, body = '', timeoutMs } = payload || {}

    const target = validateModelUrl(url)
    if (!target.ok) {
      logEvent('warn', 'llm.rejected', { reason: target.error })
      return { ok: false, status: 0, text: '', error: target.error }
    }
    if (!headers || typeof headers !== 'object') {
      return { ok: false, status: 0, text: '', error: '请求头格式非法' }
    }
    if (typeof body !== 'string') {
      return { ok: false, status: 0, text: '', error: '请求体必须是字符串' }
    }

    const controller = new AbortController()
    if (requestId) llmRequests.set(requestId, controller)
    const startedAt = Date.now()
    try {
      const result = await requestCompletion({
        url: target.url.href,
        method,
        headers,
        body,
        timeoutMs,
        signal: controller.signal
      })
      // 只记 host/状态/耗时：不记 Key、不记请求体（可能含对话内容）
      logEvent(result.ok ? 'info' : 'warn', 'llm.request', {
        host: target.url.host,
        status: result.status,
        ms: Date.now() - startedAt,
        ok: result.ok,
        timedOut: /超时/.test(result.error || '')
      })
      return result
    } finally {
      if (requestId) llmRequests.delete(requestId)
    }
  })
  ipcMain.on('llm:abort', (_event, requestId) => {
    llmRequests.get(requestId)?.abort()
  })
}

/**
 * 中止全部在途请求：窗口关闭 / 渲染进程崩溃后继续跑没有意义，
 * 且会一直占用带宽直到默认 120s 超时。
 */
function abortAllLlmRequests() {
  if (!llmRequests.size) return
  logEvent('info', 'llm.abort_all', { count: llmRequests.size })
  for (const controller of llmRequests.values()) controller.abort()
  llmRequests.clear()
}

// 单实例：两个实例会争抢同一个 COM 口，必须只允许一个
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.ai-serial-assistant.app')
    }

    // 结构化日志（滚动文件）：无法初始化时静默降级为仅控制台，不影响功能
    const logPath = await initLogger(join(app.getPath('userData'), 'logs'))
    logEvent('info', 'app.start', {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      logPath
    })

    ipcMain.handle('ping', () => 'pong')

    ipcMain.handle('serial:list', () => listPorts())
    // 用事件来源窗口而不是全局 mainWindow：多窗口/窗口已重建时不会把数据发到错误的目标
    ipcMain.handle('serial:open', (event, options) =>
      openPort(windowFromEvent(event) ?? mainWindow, options))
    ipcMain.handle('serial:close', (event) =>
      closePort(windowFromEvent(event) ?? mainWindow))
    ipcMain.handle('serial:send', (_, data, encoding) => send(data, encoding))
    ipcMain.handle('serial:setDtr', (_, value) => setDtr(value))
    ipcMain.handle('serial:setRts', (_, value) => setRts(value))

    ipcMain.on('console:log', (_, level, msg) => {
      // 渲染层日志同时落盘：现场只有用户口述时，这是唯一能拿到前端错误的途径
      const prefix = level === 'error' ? '[Renderer ERROR]'
        : level === 'warn' ? '[Renderer WARN]'
          : '[Renderer]'
      console.log(prefix, msg)
      logEvent(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', 'renderer.log', {
        message: typeof msg === 'string' ? msg.slice(0, 4000) : String(msg)
      })
    })

    registerWindowControls()
    registerLlmProxy()
    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 退出前先关串口，避免 Windows 上 COM 口被残留占用；并 flush 未写完的日志
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    logEvent('info', 'app.quit', { logPath: getLogPath() })
    closePort(mainWindow)
      .catch(() => {})
      .then(() => flushLogger())
      .finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
