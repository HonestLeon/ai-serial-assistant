import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: () => ipcRenderer.invoke('ping'),

  log: (level, msg) => ipcRenderer.send('console:log', level, msg),

  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options) => ipcRenderer.invoke('serial:open', options),
    close: () => ipcRenderer.invoke('serial:close'),
    send: (data, encoding) => ipcRenderer.invoke('serial:send', data, encoding),
    setDtr: (value) => ipcRenderer.invoke('serial:setDtr', value),
    setRts: (value) => ipcRenderer.invoke('serial:setRts', value),
    onData: (callback) => ipcRenderer.on('serial:data', (_, payload) => callback(payload)),
    onStatus: (callback) => ipcRenderer.on('serial:status', (_, payload) => callback(payload)),
    onError: (callback) => ipcRenderer.on('serial:error', (_, message) => callback(message))
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electronAPI = api
}
