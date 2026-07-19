import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import './style.css'
import App from './App.vue'

function setupLogger() {
  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const api = window.electronAPI

  function forward(level, orig, args) {
    orig(...args)
    if (api?.log) {
      const msg = args.map(a => {
        if (a instanceof Error) return a.message || String(a)
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a) }
        catch { return String(a) }
      }).join(' ')
      api.log(level, msg)
    }
  }

  console.log = function (...args) { forward('log', origLog, args) }
  console.warn = function (...args) { forward('warn', origWarn, args) }
  console.error = function (...args) { forward('error', origError, args) }
  console.info = function (...args) { forward('log', origLog, args) }
}

// 暂时禁用以排查 el-select 下拉菜单问题
// setupLogger()

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus)

function applyTheme(dark) {
  if (dark) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark')
  applyTheme(dark)
  localStorage.setItem('theme', dark ? 'dark' : 'light')
  window.dispatchEvent(new CustomEvent('theme-change', { detail: { dark } }))
}

const saved = localStorage.getItem('theme')
if (saved === 'dark') {
  applyTheme(true)
} else if (saved === 'light') {
  applyTheme(false)
}

app.config.errorHandler = (err, instance, info) => {
  const msg = err instanceof Error ? (err.message + '\n' + err.stack) : String(err)
  document.title = 'ERROR: ' + String(err.message || err).slice(0, 40)
  // 同时在页面底部显示错误
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#f85149;color:#fff;padding:8px 16px;font-size:12px;z-index:99999;font-family:monospace;max-height:120px;overflow:auto;'
  el.textContent = '[Vue Error] ' + msg
  document.body.appendChild(el)
}

app.provide('theme', {
  isDark: () => document.documentElement.classList.contains('dark'),
  toggle: toggleTheme
})

app.mount('#app')
console.log('[main] App mounted')
