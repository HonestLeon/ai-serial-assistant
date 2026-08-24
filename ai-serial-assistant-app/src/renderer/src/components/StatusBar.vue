<script setup>
import { ref } from 'vue'
import { Sunny, Moon } from '@element-plus/icons-vue'

const props = defineProps({
  connected: Boolean,
  statusText: String,
  rx: Number,
  tx: Number,
  showHex: Boolean
})

const emit = defineEmits(['toggle-hex'])

const isDark = ref(document.documentElement.classList.contains('dark'))

function toggleTheme() {
  isDark.value = !isDark.value
  if (isDark.value) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  window.dispatchEvent(new CustomEvent('theme-change', { detail: { dark: isDark.value } }))
}
</script>

<template>
  <footer class="status-bar">
    <div class="status-left">
      <button class="hex-toggle" :class="{ active: showHex }" title="切换接收数据的 HEX 显示（仅影响查看，不影响发送编码）" @click="emit('toggle-hex')">HEX</button>
      <div class="connection">
        <div class="status-dot" :style="{ background: connected ? 'var(--state-success)' : 'var(--color-text-tertiary)' }"></div>
        <span class="status-text">{{ statusText }}</span>
      </div>
    </div>

    <div class="status-center">
      <span>UTF-8</span>
      <span class="mono" v-pre>\n</span>
    </div>

    <div class="status-right">
      <button class="theme-toggle" @click="toggleTheme" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
        <el-icon size="13"><Moon v-if="isDark" /><Sunny v-else /></el-icon>
      </button>
      <span class="mono">Rx: <strong>{{ rx.toLocaleString() }}</strong></span>
      <span class="sep">|</span>
      <span class="mono">Tx: <strong>{{ tx.toLocaleString() }}</strong></span>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  height: var(--statusbar-height);
  min-height: var(--statusbar-height);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--color-border-default);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-4);
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.status-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.hex-toggle {
  padding: 1px 6px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  background: transparent;
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  cursor: pointer;
}

.hex-toggle.active {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.connection {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.status-text {
  font-family: var(--font-family-mono);
  color: var(--color-text-secondary);
}

.status-center {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.status-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.15s ease;
}

.theme-toggle:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
}

.mono {
  font-family: var(--font-family-mono);
}

.status-right strong {
  color: var(--color-text-secondary);
  font-weight: normal;
}

.sep {
  color: var(--color-border-default);
}
</style>
