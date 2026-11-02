import { ref } from 'vue'

/** 主题单一来源：main.js 启动时初始化，StatusBar 切换，图表监听 theme-change 事件 */
const isDark = ref(false)

export function applyTheme(dark) {
  isDark.value = !!dark
  document.documentElement.classList.toggle('dark', isDark.value)
}

export function initTheme() {
  let stored = ''
  try {
    stored = localStorage.getItem('theme') || ''
  } catch {
    stored = ''
  }
  applyTheme(stored === 'dark')
}

export function toggleTheme() {
  applyTheme(!isDark.value)
  try {
    localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  } catch { /* localStorage 不可用时仅当前会话生效 */ }
  window.dispatchEvent(new CustomEvent('theme-change', { detail: { dark: isDark.value } }))
}

export function useTheme() {
  return { isDark, toggleTheme }
}
