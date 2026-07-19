import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { listPorts, openPort, closePort, send, setDtr, setRts } from './serial.js'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.ai-serial-assistant.app')
  }

  ipcMain.handle('ping', () => 'pong')

  ipcMain.handle('serial:list', () => listPorts())
  ipcMain.handle('serial:open', (_, options) => openPort(mainWindow, options))
  ipcMain.handle('serial:close', () => closePort(mainWindow))
  ipcMain.handle('serial:send', (_, data, encoding) => send(data, encoding))
  ipcMain.handle('serial:setDtr', (_, value) => setDtr(value))
  ipcMain.handle('serial:setRts', (_, value) => setRts(value))

  ipcMain.on('console:log', (_, level, msg) => {
    const prefix = level === 'error' ? '[Renderer ERROR]'
      : level === 'warn' ? '[Renderer WARN]'
      : '[Renderer]'
    console.log(prefix, msg)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
