<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { DataLine, Grid, VideoPause, VideoPlay, Delete, Refresh, Cpu } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'

const props = defineProps({
  connected: Boolean,
  showHex: Boolean,
  activeView: { type: String, default: 'stream' },
  showViewTabs: { type: Boolean, default: true },
  recording: { type: Object, default: () => ({ active: false, data: [], startTime: 0 }) }
})
const emit = defineEmits(['data', 'send', 'start-recording', 'stop-recording', 'clear-recording'])

const input = ref('')
const encoding = ref('utf8')
const activeSubTab = ref(props.activeView === 'table' ? 'table' : 'stream')
const messages = ref([])
const tableRows = ref([])
const MAX_TABLE_ROWS = 1000
const MAX_MESSAGES = 5000

// 消息自增 id，用于稳定的 v-for key
let messageId = 0
// 数据表行自增 id（稳定 key，避免下标 key 导致的全量重 patch）
let rowId = 0

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
const SIMULATION_INTERVAL_MS = 50
const simulationState = { feedback: 0, velocity: 0, integral: 0, previousError: 0 }

function resetSimulation() {
  simulateTick = 0
  simulationState.feedback = 0
  simulationState.velocity = 0
  simulationState.integral = 0
  simulationState.previousError = 0
}

// 可重复的欠阻尼阶跃响应：I0=目标，I1=反馈，I2=控制量，I3=误差。
function createControlSimulationLine() {
  const dt = SIMULATION_INTERVAL_MS / 1000
  const time = simulateTick * dt
  const target = time < 1 ? 0 : 100
  const naturalFrequency = 3.2
  const dampingRatio = 0.42
  const acceleration = naturalFrequency ** 2 * (target - simulationState.feedback)
    - 2 * dampingRatio * naturalFrequency * simulationState.velocity
  simulationState.velocity += acceleration * dt
  simulationState.feedback += simulationState.velocity * dt

  const error = target - simulationState.feedback
  simulationState.integral += error * dt
  const derivative = (error - simulationState.previousError) / dt
  simulationState.previousError = error
  const control = Math.max(-100, Math.min(100, 1.8 * error + 0.22 * simulationState.integral + 0.12 * derivative))
  const deterministicNoise = 0.15 * Math.sin(simulateTick * 0.37)

  return `CTRL: ${target.toFixed(3)} ${(simulationState.feedback + deterministicNoise).toFixed(3)} ${control.toFixed(3)} ${error.toFixed(3)}`
}

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
  resetSimulation()
  const doPush = () => {
    const text = createControlSimulationLine()
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
  }, SIMULATION_INTERVAL_MS)
}

const placeholder = computed(() => encoding.value === 'hex' ? '输入十六进制，如: 01 02 0A' : '输入发送数据...')

async function send() {
  if (!input.value.trim() || !props.connected) return
  try {
    await window.electronAPI.serial.send(input.value, encoding.value)
    const len = input.value.length
    messages.value.unshift({
      id: ++messageId,
      type: 'send',
      text: input.value,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ms: new Date().getMilliseconds().toString().padStart(3, '0')
    })
    emit('send', len)
    input.value = ''
  } catch (e) {
    messages.value.unshift({ id: ++messageId, type: 'error', text: e, time: '--:--:--', ms: '000' })
  }
}

function startAutoSend() {
  if (!props.connected || !input.value.trim()) return
  // 钳制间隔下限，避免过小的间隔导致的性能问题
  if (autoSendInterval.value < 100) autoSendInterval.value = 100
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

watch(() => props.activeView, (view) => {
  if (view === 'stream' || view === 'table') {
    activeSubTab.value = view
    scrollToTop()
  }
})

// 清空数据流/数据表属不可逆操作，二次确认防止误触
async function clear() {
  try {
    await ElMessageBox.confirm('将清空数据流与数据表的全部记录，且不可恢复。', '清空数据', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  messages.value = []
  tableRows.value = []
  // 待处理队列一并清空，避免清空后 100ms 内又补进一批旧数据
  pendingSerialData.length = 0
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
  // 高频串口流批处理：设备遥测可达数百条/秒，逐条 IPC → 响应式更新 → DOM 重渲染
  // 会把渲染进程打满（UI 卡死、消息流时间戳积压数分钟、按钮无响应）。
  // 这里只入队（普通数组，零响应式成本），由 100ms 定时器批量消费：
  // 同一 tick 内完成全部 unshift 与 emit，Vue 自动合并为一次组件重渲染。
  // 主进程已按 25ms 时间窗聚合 IPC，payload 可能是单对象或数组（数组批）。
  if (Array.isArray(payload)) {
    for (const item of payload) pendingSerialData.push(item)
  } else {
    pendingSerialData.push(payload)
  }
  scheduleFlush()
}

/** 批量刷新间隔：消息流 10Hz 刷新肉眼依然流畅，且渲染开销恒定与数据速率无关 */
const SERIAL_FLUSH_MS = 100
const pendingSerialData = []
let flushTimer = null

function scheduleFlush() {
  if (flushTimer != null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (pendingSerialData.length) {
      flushSerialData()
      // flush 期间又有新数据到达：继续排队下一轮
      if (pendingSerialData.length) scheduleFlush()
    }
  }, SERIAL_FLUSH_MS)
}

function flushSerialData() {
  const batch = pendingSerialData.splice(0, pendingSerialData.length)
  // 先在普通数组里构建整批新消息/新表格行，最后一次性 unshift：
  // 逐条对响应式数组 unshift 是 O(n) 移动/条（n=5000 时高频批下开销显著），
  // 一次 spread unshift 把移动成本合并为单次 O(n+m)。
  const newMessages = []
  const newRows = []
  for (const payload of batch) {
    const { t, ms } = formatTime(payload)
    newMessages.push({
      id: ++messageId,
      type: 'receive',
      text: props.showHex ? payload.hex : payload.raw,
      time: t,
      ms
    })

    // 数据表（稳定自增 id 作 v-for key：若用数组下标作 key，头部插入导致
    // 所有行索引偏移，Vue 会全量重 patch 1000 行 × 9 单元格，低配机直接卡死）
    const nums = parseToNumbers(payload.raw)
    if (nums.length > 0) {
      newRows.push({ id: ++rowId, time: t, ms, values: nums })
    }

    emit('data', payload)
  }
  if (newMessages.length) messages.value.unshift(...newMessages)
  if (newRows.length) {
    tableRows.value.unshift(...newRows)
    if (tableRows.value.length > MAX_TABLE_ROWS) {
      tableRows.value.splice(tableRows.value.length - MAX_TABLE_ROWS)
    }
  }
  // 批量截断一次（而非逐条），同 tick 内全部响应式修改合并为一次重渲染
  if (messages.value.length > MAX_MESSAGES) {
    messages.value.length = MAX_MESSAGES
  }
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

async function clearRecording() {
  try {
    await ElMessageBox.confirm('将清空已录制的全部数据帧，且不可恢复。', '清空录制', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  emit('clear-recording')
}

async function replayRecording() {
  if (props.recording.data.length === 0 || replaying.value) return
  // 回放会中断当前串口通信，必须在动作发生前向用户确认
  if (props.connected) {
    try {
      await ElMessageBox.confirm(
        '回放将自动关闭当前串口连接（避免实时数据与回放数据混合），回放期间无法进行实时收发。是否继续？',
        '开始回放',
        { confirmButtonText: '关闭串口并回放', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return // 用户取消
    }
    stopAutoSend()
    try {
      await window.electronAPI.serial.close()
      messages.value.unshift({
        id: ++messageId,
        type: 'system',
        text: '开始回放前已自动关闭串口，避免实时数据与回放数据混合',
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        ms: new Date().getMilliseconds().toString().padStart(3, '0')
      })
    } catch (error) {
      messages.value.unshift({
        id: ++messageId,
        type: 'error',
        text: `关闭串口失败，已取消回放：${error.message || error}`,
        time: '--:--:--',
        ms: '000'
      })
      return
    }
  }
  replaying.value = true
  replayTimers = []
  const data = [...props.recording.data]
  const baseDelay = data[0]?.recTime || 0

  data.forEach((item) => {
    const delay = item.recTime - baseDelay
    const timer = setTimeout(() => {
      const { t, ms } = formatTime(item)
      messages.value.unshift({
        id: ++messageId,
        type: 'receive',
        text: `[回放] ${props.showHex ? item.hex : item.raw}`,
        time: t,
        ms
      })
      const nums = parseToNumbers(item.raw)
      if (nums.length > 0) {
        // 回放行同样使用自增 id 作稳定 key（v-for 依赖 row.id）
        tableRows.value.unshift({ id: ++rowId, time: t, ms, values: nums })
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
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingSerialData.length = 0
})
</script>

<template>
  <div class="data-monitor">
    <!-- Sub tabs -->
    <div class="sub-tabs">
      <button v-if="showViewTabs" class="sub-tab" :class="{ active: activeSubTab === 'stream' }" @click="activeSubTab = 'stream'">
        <el-icon size="13"><DataLine /></el-icon>
        <span>数据流</span>
      </button>
      <button v-if="showViewTabs" class="sub-tab" :class="{ active: activeSubTab === 'table' }" @click="activeSubTab = 'table'">
        <el-icon size="13"><Grid /></el-icon>
        <span>数据表</span>
      </button>
      <div class="recording-controls">
        <button
          class="rec-btn sim"
          :class="{ active: simulating }"
          @click="toggleSimulate"
          title="无需硬件串口，生成可重复的控制阶跃响应"
        >
          <el-icon size="12"><Cpu /></el-icon>
          <span>{{ simulating ? '停止模拟' : '控制响应模拟' }}</span>
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

    <!-- 数据流视图（v-if：隐藏时不参与 patch，切回时由组件状态重建 DOM） -->
    <div v-if="activeSubTab === 'stream'" class="message-list-container">
      <button v-if="!autoScroll" class="resume-follow" @click="scrollToTop">已暂停跟随 · 回到最新</button>
      <div
        ref="messageListRef"
        class="message-list"
        @scroll="onScroll"
      >
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message-row"
          :class="msg.type"
        >
          <span class="timestamp">[{{ msg.time }}.{{ msg.ms }}]</span>
          <span class="direction" :class="msg.type">{{ msg.type === 'send' ? 'Tx:' : msg.type === 'receive' ? 'Rx:' : msg.type === 'system' ? 'Sy:' : 'Er:' }}</span>
          <span class="payload">{{ msg.text }}</span>
        </div>
        <div v-if="messages.length === 0" class="empty">等待串口数据...</div>
      </div>
    </div>

    <!-- 数据表视图 -->
    <div
      v-if="activeSubTab === 'table'"
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
          <tr v-for="row in tableRows" :key="row.id">
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
        <button class="btn-primary" :disabled="!connected || autoSendEnabled" @click="send">发送</button>
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
  flex-wrap: wrap; /* 窄窗口下录制/回放控制组换行而非溢出裁切 */
  align-items: center;
  min-height: 32px; /* 换行发生时高度自适应（原固定 height: 32px） */
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
  background: var(--state-error-muted);
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

/* 数据流视图外层容器：接管 flex 伸展与最小高度约束，为悬浮按钮提供定位上下文 */
.message-list-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

/* 暂停跟随时悬浮于列表顶部的恢复按钮 */
.resume-follow {
  position: absolute;
  top: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  font-family: var(--font-family-display);
  color: var(--color-primary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-active);
  border-radius: var(--radius-full, 999px);
  box-shadow: var(--el-box-shadow-light, 0 2px 12px rgba(0, 0, 0, 0.2));
  cursor: pointer;
}

.resume-follow:hover {
  background: var(--color-primary-muted);
}

.message-list {
  flex: 1;
  min-height: 0;
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

/* 隔行底色用 CSS nth-child：若绑定 idx 计算的 alt class，头部插入会让
   全部 5000 行 class 重算重写，高频流下是显著 DOM 开销 */
.message-row:nth-child(even) {
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
.direction.system { color: var(--color-text-secondary); }
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

.data-table tbody tr:nth-child(even) td {
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
  flex-wrap: wrap; /* 窄窗口下控件换行而非压缩输入框 */
  align-items: center;
  gap: var(--space-2);
}

.send-row .el-input {
  flex: 1;
  min-width: 160px; /* 防止固定宽度控件（约 380-400px）把输入框压至不可用 */
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
