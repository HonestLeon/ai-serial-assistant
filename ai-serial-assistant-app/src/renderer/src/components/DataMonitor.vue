<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { DataLine, Grid, VideoPause, VideoPlay, Delete, Refresh, Cpu } from '@element-plus/icons-vue'

const props = defineProps({
  connected: Boolean,
  showHex: Boolean,
  recording: { type: Object, default: () => ({ active: false, data: [], startTime: 0 }) }
})
const emit = defineEmits(['data', 'send', 'start-recording', 'stop-recording', 'clear-recording'])

const input = ref('')
const encoding = ref('utf8')
const activeSubTab = ref('stream')
const messages = ref([])
const tableRows = ref([])
const MAX_TABLE_ROWS = 500

// 滚动容器引用
const messageListRef = ref(null)
const tableViewRef = ref(null)
// 是否跟随最新数据（用户手动向下滚动查看历史时暂停跟随）
const autoScroll = ref(true)

function scrollToTop() {
  nextTick(() => {
    if (messageListRef.value && activeSubTab.value === 'stream') {
      messageListRef.value.scrollTop = 0
    }
    if (tableViewRef.value && activeSubTab.value === 'table') {
      tableViewRef.value.scrollTop = 0
    }
  })
}

function onScroll() {
  // 用户向下滚动查看历史时停止自动跟随；滚回顶部时恢复
  const el = activeSubTab.value === 'stream' ? messageListRef.value : tableViewRef.value
  if (!el) return
  autoScroll.value = el.scrollTop <= 5
}

// 自动发送
const autoSendEnabled = ref(false)
const autoSendInterval = ref(1000)
let autoSendTimer = null

// 回放
const replaying = ref(false)
let replayTimers = []

// 模拟数据
const simulating = ref(false)
let simulateTimer = null
let simulateTick = 0

const SIMULATE_TEMPLATES = [
  () => {
    const t = simulateTick * 0.1
    return [
      (50 + 30 * Math.sin(t)).toFixed(2),
      (100 + 20 * Math.cos(t * 0.5)).toFixed(2),
      (25 + 10 * Math.sin(t * 1.5)).toFixed(2),
      (75 + 15 * Math.cos(t * 0.8)).toFixed(2)
    ].join(' ')
  },
  () => `temp=${(25 + Math.random() * 5).toFixed(2)} humidity=${(50 + Math.random() * 10).toFixed(1)}% pressure=${(1013 + Math.random() * 5).toFixed(0)}hPa`,
  () => `{"ch0":${(100 + Math.random() * 50).toFixed(0)},"ch1":${(200 + Math.random() * 30).toFixed(0)},"ch2":${(50 + Math.random() * 20).toFixed(0)}}`,
  () => `AT+STATUS=${(Math.random() * 100).toFixed(0)},RSSI=-${(40 + Math.random() * 30).toFixed(0)}dBm,BAT=${(3.3 + Math.random() * 0.3).toFixed(2)}V`,
  () => `[${new Date().toISOString()}] motor_speed=${(3000 + Math.random() * 500).toFixed(0)}rpm current=${(2.5 + Math.random()).toFixed(2)}A`,
  () => `ACCX(g),ACCY(g),ACCZ(g),GYROX(°/s),GYROY(°/s),GYROZ(°/s): ${(Math.random() - 0.5).toFixed(2)}, ${(Math.random() - 0.5).toFixed(2)}, ${(1 + Math.random() * 0.1).toFixed(2)}, ${(Math.random() * 10 - 5).toFixed(2)}, ${(Math.random() * 10 - 5).toFixed(2)}, ${(Math.random() * 10 - 5).toFixed(2)}`
]

function toggleSimulate() {
  if (simulating.value) {
    simulating.value = false
    if (simulateTimer) {
      clearInterval(simulateTimer)
      simulateTimer = null
    }
    return
  }

  simulating.value = true
  simulateTick = 0
  const doPush = () => {
    const template = SIMULATE_TEMPLATES[simulateTick % SIMULATE_TEMPLATES.length]
    const text = template()
    const now = Date.now()
    const payload = {
      raw: text,
      hex: Array.from(text).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
      time: now,
      simulated: true
    }
    onSerialData(payload)
  }

  doPush()
  simulateTimer = setInterval(() => {
    simulateTick++
    doPush()
  }, 500)
}

const placeholder = computed(() => encoding.value === 'hex' ? '输入十六进制，如: 01 02 0A' : '输入发送数据...')

async function send() {
  if (!input.value.trim() || !props.connected) return
  try {
    await window.electronAPI.serial.send(input.value, encoding.value)
    const len = input.value.length
    messages.value.unshift({
      type: 'send',
      text: input.value,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ms: new Date().getMilliseconds().toString().padStart(3, '0')
    })
    emit('send', len)
    input.value = ''
  } catch (e) {
    messages.value.unshift({ type: 'error', text: e, time: '--:--:--', ms: '000' })
  }
}

function startAutoSend() {
  if (!props.connected || !input.value.trim()) return
  autoSendEnabled.value = true
  const doSend = async () => {
    if (!props.connected || !autoSendEnabled.value) return
    try {
      await window.electronAPI.serial.send(input.value, encoding.value)
      emit('send', input.value.length)
    } catch (e) {
      stopAutoSend()
    }
  }
  doSend()
  autoSendTimer = setInterval(doSend, autoSendInterval.value)
}

function stopAutoSend() {
  autoSendEnabled.value = false
  if (autoSendTimer) {
    clearInterval(autoSendTimer)
    autoSendTimer = null
  }
}

watch(() => props.connected, (v) => {
  if (!v) stopAutoSend()
})

function clear() {
  messages.value = []
  tableRows.value = []
}

function formatTime(payload) {
  const d = new Date(payload.time)
  return {
    t: d.toLocaleTimeString('zh-CN', { hour12: false }),
    ms: d.getMilliseconds().toString().padStart(3, '0')
  }
}

function parseToNumbers(raw) {
  const text = String(raw)
  // FireWater 格式：标签1,标签2,...: 值1,值2,...，只提取冒号后的数值
  const colonIdx = text.indexOf(':')
  const dataPart = colonIdx >= 0 ? text.slice(colonIdx + 1) : text
  const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
  return nums ? nums.slice(0, 8).map(Number) : []
}

function onSerialData(payload) {
  const { t, ms } = formatTime(payload)
  messages.value.unshift({
    type: 'receive',
    text: props.showHex ? payload.hex : payload.raw,
    time: t,
    ms
  })

  // 数据表
  const nums = parseToNumbers(payload.raw)
  if (nums.length > 0) {
    tableRows.value.unshift({ time: t, ms, values: nums })
    if (tableRows.value.length > MAX_TABLE_ROWS) {
      tableRows.value.pop()
    }
  }

  emit('data', payload)
  if (autoScroll.value) scrollToTop()
}

// 录制控制
function toggleRecording() {
  if (props.recording.active) {
    emit('stop-recording')
  } else {
    emit('start-recording')
  }
}

function clearRecording() {
  emit('clear-recording')
}

function replayRecording() {
  if (props.recording.data.length === 0 || replaying.value) return
  replaying.value = true
  replayTimers = []
  const data = [...props.recording.data]
  const baseDelay = data[0]?.recTime || 0

  data.forEach((item) => {
    const delay = item.recTime - baseDelay
    const timer = setTimeout(() => {
      const { t, ms } = formatTime(item)
      messages.value.unshift({
        type: 'receive',
        text: `[回放] ${props.showHex ? item.hex : item.raw}`,
        time: t,
        ms
      })
      const nums = parseToNumbers(item.raw)
      if (nums.length > 0) {
        tableRows.value.unshift({ time: t, ms, values: nums })
        if (tableRows.value.length > MAX_TABLE_ROWS) tableRows.value.pop()
      }
    }, delay)
    replayTimers.push(timer)
  })

  const totalTime = (data[data.length - 1]?.recTime || 0) - baseDelay + 100
  const endTimer = setTimeout(() => { replaying.value = false }, totalTime)
  replayTimers.push(endTimer)
}

function stopReplay() {
  replaying.value = false
  replayTimers.forEach(t => clearTimeout(t))
  replayTimers = []
}

onMounted(() => {
  window.electronAPI?.serial?.onData?.(onSerialData)
})

onUnmounted(() => {
  stopAutoSend()
  stopReplay()
  if (simulateTimer) {
    clearInterval(simulateTimer)
    simulateTimer = null
  }
})
</script>

<template>
  <div class="data-monitor">
    <!-- Sub tabs -->
    <div class="sub-tabs">
      <button class="sub-tab" :class="{ active: activeSubTab === 'stream' }" @click="activeSubTab = 'stream'">
        <el-icon size="13"><DataLine /></el-icon>
        <span>数据流</span>
      </button>
      <button class="sub-tab" :class="{ active: activeSubTab === 'table' }" @click="activeSubTab = 'table'">
        <el-icon size="13"><Grid /></el-icon>
        <span>数据表</span>
      </button>
      <div class="recording-controls">
        <button
          class="rec-btn sim"
          :class="{ active: simulating }"
          @click="toggleSimulate"
          title="无需硬件串口，定时推送示例数据用于离线演示"
        >
          <el-icon size="12"><Cpu /></el-icon>
          <span>{{ simulating ? '停止模拟' : '模拟数据' }}</span>
        </button>
        <button
          class="rec-btn"
          :class="{ recording: recording.active }"
          :disabled="!connected && !recording.active && !simulating"
          @click="toggleRecording"
        >
          <el-icon size="12"><VideoPause v-if="recording.active" /><VideoPlay v-else /></el-icon>
          <span>{{ recording.active ? '停止录制' : '录制' }}</span>
        </button>
        <button class="rec-btn" :disabled="recording.data.length === 0 || replaying" @click="replayRecording">
          <el-icon size="12"><Refresh /></el-icon>
          <span>回放</span>
        </button>
        <button v-if="replaying" class="rec-btn stop" @click="stopReplay">
          <span>停止回放</span>
        </button>
        <button class="rec-btn" :disabled="recording.data.length === 0" @click="clearRecording">
          <el-icon size="12"><Delete /></el-icon>
          <span>清空录制</span>
        </button>
        <span v-if="recording.data.length > 0" class="rec-count">已录制 {{ recording.data.length }} 帧</span>
      </div>
    </div>

    <!-- 数据流视图 -->
    <div
      v-show="activeSubTab === 'stream'"
      ref="messageListRef"
      class="message-list"
      @scroll="onScroll"
    >
      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        class="message-row"
        :class="{ alt: idx % 2 === 1, [msg.type]: true }"
      >
        <span class="timestamp">[{{ msg.time }}.{{ msg.ms }}]</span>
        <span class="direction" :class="msg.type">{{ msg.type === 'send' ? 'Tx:' : msg.type === 'receive' ? 'Rx:' : 'Er:' }}</span>
        <span class="payload">{{ msg.text }}</span>
      </div>
      <div v-if="messages.length === 0" class="empty">等待串口数据...</div>
    </div>

    <!-- 数据表视图 -->
    <div
      v-show="activeSubTab === 'table'"
      ref="tableViewRef"
      class="table-view"
      @scroll="onScroll"
    >
      <table class="data-table">
        <thead>
          <tr>
            <th>时间戳</th>
            <th v-for="i in 8" :key="i">I{{ i - 1 }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in tableRows" :key="idx" :class="{ alt: idx % 2 === 1 }">
            <td class="ts-cell">{{ row.time }}.{{ row.ms }}</td>
            <td v-for="i in 8" :key="i" class="val-cell">
              {{ row.values[i - 1] !== undefined ? row.values[i - 1].toFixed(3) : '—' }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="tableRows.length === 0" class="empty">暂无表格数据...</div>
    </div>

    <!-- Bottom send area -->
    <div class="send-area">
      <div class="send-row">
        <el-input
          v-model="input"
          :placeholder="placeholder"
          size="small"
          :disabled="!connected"
          @keyup.enter="!autoSendEnabled && send()"
        />
        <el-select v-model="encoding" size="small" style="width: 80px" :disabled="!connected">
          <el-option label="文本" value="utf8" />
          <el-option label="HEX" value="hex" />
        </el-select>
        <button class="btn-secondary" :disabled="!connected" @click="encoding = encoding === 'hex' ? 'utf8' : 'hex'">HEX</button>
        <button class="btn-primary" :disabled="!connected || autoSendEnabled" @click="send">发送(S)</button>
        <button class="btn-secondary" @click="clear">清空</button>
        <div class="auto-send-group">
          <input
            v-model.number="autoSendInterval"
            type="number"
            min="100"
            step="100"
            class="interval-input"
            :disabled="!connected || autoSendEnabled"
          />
          <span class="interval-label">ms</span>
          <button
            class="btn-auto"
            :class="{ active: autoSendEnabled }"
            :disabled="!connected"
            @click="autoSendEnabled ? stopAutoSend() : startAutoSend()"
          >
            {{ autoSendEnabled ? '停止自动' : '自动发送' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-monitor {
  display: flex;
  flex-direction: column;
  height: 100%;
  color: var(--color-text-primary);
}

.sub-tabs {
  display: flex;
  align-items: center;
  height: 32px;
  border-bottom: 1px solid var(--color-border-default);
  padding: 0 var(--space-4);
  flex-shrink: 0;
}

.sub-tab {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 100%;
  padding: 0 var(--space-3);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  cursor: pointer;
  font-family: var(--font-family-display);
}

.sub-tab.active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 500;
}

.recording-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.rec-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.rec-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.rec-btn.recording {
  border-color: var(--state-error);
  color: var(--state-error);
  background: rgba(248, 81, 73, 0.08);
}

.rec-btn.stop {
  border-color: var(--state-warning);
  color: var(--state-warning);
}

.rec-btn.sim {
  border-color: var(--color-ai);
  color: var(--color-ai);
}

.rec-btn.sim.active {
  background: var(--color-ai-muted);
  font-weight: 600;
}

.rec-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2) 0;
  font-family: var(--font-family-mono);
  font-size: var(--text-sm);
  line-height: 1.7;
}

.message-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 1px var(--space-4);
}

.message-row.alt {
  background: var(--message-alt-bg);
}

.timestamp {
  color: var(--color-text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
}

.direction {
  font-weight: 500;
  flex-shrink: 0;
}

.direction.receive { color: var(--color-ai); }
.direction.send { color: var(--color-primary); }
.direction.error { color: var(--state-error); }

.payload {
  color: var(--color-text-primary);
  word-break: break-all;
}

.payload.send {
  color: var(--color-text-secondary);
}

.table-view {
  flex: 1;
  overflow: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border-default);
  padding: 4px 8px;
  text-align: right;
  color: var(--color-text-tertiary);
  font-weight: 600;
  white-space: nowrap;
}

.data-table th:first-child {
  text-align: left;
}

.data-table td {
  padding: 2px 8px;
  text-align: right;
  border-bottom: 1px solid var(--color-border-subtle);
}

.data-table td.ts-cell {
  text-align: left;
  color: var(--color-text-tertiary);
}

.data-table td.val-cell {
  color: var(--color-text-primary);
}

.data-table tr.alt td {
  background: var(--message-alt-bg);
}

.empty {
  color: var(--color-text-tertiary);
  text-align: center;
  margin-top: var(--space-8);
}

.send-area {
  border-top: 1px solid var(--color-border-default);
  padding: var(--space-2) var(--space-4);
  flex-shrink: 0;
}

.send-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.send-row .el-input {
  flex: 1;
}

.auto-send-group {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: var(--space-1);
}

.interval-input {
  width: 60px;
  height: 28px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  text-align: center;
  outline: none;
}

.interval-input:disabled {
  opacity: 0.5;
}

.interval-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.btn-primary {
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-text-inverse);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  white-space: nowrap;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-auto {
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  white-space: nowrap;
}

.btn-auto:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-auto.active {
  background: var(--color-primary-muted);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}
</style>
