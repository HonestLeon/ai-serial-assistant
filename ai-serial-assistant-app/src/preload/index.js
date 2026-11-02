import { contextBridge, ipcRenderer } from 'electron'

/**
 * 统一的 IPC 订阅封装：返回取消函数。
 * 渲染进程组件必须在 onUnmounted 调用，避免 HMR / 组件重建后同一通道被重复处理。
 */
function subscribe(channel, callback) {
  const listener = (_, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: () => ipcRenderer.invoke('ping'),

  log: (level, msg) => ipcRenderer.send('console:log', level, msg),

  /** 自绘标题栏窗口控制（Windows 无原生按钮） */
  windowControl: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (callback) => subscribe('window:maximized', callback)
  },

  /** LLM 请求经主进程转发：绕开渲染进程 CORS，API Key 不进入页面网络栈 */
  llm: {
    request: (payload) => ipcRenderer.invoke('llm:request', payload),
    abort: (requestId) => ipcRenderer.send('llm:abort', requestId)
  },

  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options) => ipcRenderer.invoke('serial:open', options),
    close: () => ipcRenderer.invoke('serial:close'),
    send: (data, encoding) => ipcRenderer.invoke('serial:send', data, encoding),
    setDtr: (value) => ipcRenderer.invoke('serial:setDtr', value),
    setRts: (value) => ipcRenderer.invoke('serial:setRts', value),
    onData: (callback) => subscribe('serial:data', callback),
    onStatus: (callback) => subscribe('serial:status', callback),
    onError: (callback) => subscribe('serial:error', callback)
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
