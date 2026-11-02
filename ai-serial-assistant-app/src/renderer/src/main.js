import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './style.css'
import App from './App.vue'
import { initTheme } from './composables/useTheme.js'

/**
 * 渲染层日志转发：控制台输出同步到主进程终端（打包后看不到 DevTools 时排查用）。
 * 仅在存在 electronAPI 时启用，浏览器预览下退化为原生 console。
 */
function setupLogger() {
  const api = window.electronAPI
  if (!api?.log) return
  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)

  function forward(level, orig, args) {
    orig(...args)
    const msg = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message || String(a)
      try { return typeof a === 'object' ? JSON.stringify(a) : String(a) } catch { return String(a) }
    }).join(' ')
    api.log(level, msg)
  }

  console.log = (...args) => forward('log', origLog, args)
  console.warn = (...args) => forward('warn', origWarn, args)
  console.error = (...args) => forward('error', origError, args)
  console.info = (...args) => forward('log', origLog, args)
}

setupLogger()

const app = createApp(App)

// Element Plus 组件全量注册；图标不在此注册——各组件按需 import，
// 全局注册 293 个图标只会让产物变大、首屏变慢。
app.use(ElementPlus)

// 主题在挂载前应用，避免首帧闪烁（CSP 下 index.html 不再内联脚本）
initTheme()

// 错误统一走 console.error（已转发到主进程），不再往 body 里堆红色提示条
app.config.errorHandler = (err, instance, info) => {
  console.error('[Vue Error]', info, err)
}

app.mount('#app')
