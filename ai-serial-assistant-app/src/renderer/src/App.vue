<script setup>
import { ref, computed, reactive, onUnmounted } from 'vue'
import { Cpu, Monitor, ChatDotRound, Operation } from '@element-plus/icons-vue'
import SerialPanel from './components/SerialPanel.vue'
import DataMonitor from './components/DataMonitor.vue'
import AiPanel from './components/AiPanel.vue'
import StatusBar from './components/StatusBar.vue'
import PidPanel from './components/PidPanel.vue'
import WorkspaceChart from './components/WorkspaceChart.vue'
import WorkspaceAnalysis from './components/WorkspaceAnalysis.vue'

const activeTab = ref('data')
const topPanePercent = ref(Number(localStorage.getItem('workspace_top_percent')) || 52)
const pidSimulationSamples = ref([])
let resizing = false
const connected = ref(false)
const status = ref({ connected: false, path: null, baudRate: null })
const rxCount = ref(0)
const txCount = ref(0)
const showHex = ref(false)
const latestPayload = ref(null)
const detectedChannelCount = ref(0)

// 全局 AI 配置（SerialPanel 和 AiPanel 共享）
const aiConfig = reactive({
  apiKey: sessionStorage.getItem('ai_api_key') || '',
  baseUrl: localStorage.getItem('ai_base_url') || 'https://api.deepseek.com',
  model: localStorage.getItem('ai_model') || 'deepseek-chat'
})

const aiSwitches = reactive({
  anomalyDetection: localStorage.getItem('ai_anomaly_detection') === 'true',
  protocolRecognition: localStorage.getItem('ai_protocol_recognition') === 'true'
})

function saveAiConfig() {
  // Key 仅保留在当前会话，避免长期写入浏览器存储。
  sessionStorage.setItem('ai_api_key', aiConfig.apiKey)
  localStorage.setItem('ai_base_url', aiConfig.baseUrl)
  localStorage.setItem('ai_model', aiConfig.model)
}

function saveAiSwitches() {
  localStorage.setItem('ai_anomaly_detection', String(aiSwitches.anomalyDetection))
  localStorage.setItem('ai_protocol_recognition', String(aiSwitches.protocolRecognition))
}

// 协议引擎选择
const protocolEngine = ref(localStorage.getItem('serial_protocol') || 'raw')
function saveProtocol() {
  localStorage.setItem('serial_protocol', protocolEngine.value)
}

// 录制状态
const recording = reactive({
  active: false,
  data: [],
  startTime: 0
})

function startRecording() {
  recording.active = true
  recording.data = []
  recording.startTime = Date.now()
}

function stopRecording() {
  recording.active = false
}

function clearRecording() {
  recording.data = []
}

const MAX_CONTEXT_LINES = 1000
// 50 ms 采样下保留约 60 秒，避免阶跃起点过早被滚动窗口淘汰。
const MAX_CONTEXT_SAMPLES = 1200

const serialContext = reactive({
  connected: false,
  path: null,
  baudRate: null,
  protocol: 'raw',
  recentLines: [],
  latestValues: Array(8).fill(0),
  channelHistory: Array.from({ length: 8 }, () => []),
  lastProtocol: null,
  lastAnomaly: null
})

function pushSerialContext(payload) {
  const line = String(payload.raw).trim()
  if (!line) return

  serialContext.recentLines.push({
    text: line,
    hex: payload.hex,
    time: payload.time || Date.now()
  })
  if (serialContext.recentLines.length > MAX_CONTEXT_LINES) {
    serialContext.recentLines.shift()
  }

  // FireWater 格式：标签:值，只提取冒号后的数值
  const colonIdx = line.indexOf(':')
  const dataPart = colonIdx >= 0 ? line.slice(colonIdx + 1) : line
  const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
  if (nums) {
    nums.slice(0, 8).forEach((n, i) => {
      const v = parseFloat(n)
      serialContext.latestValues[i] = v
      serialContext.channelHistory[i].push(v)
      if (serialContext.channelHistory[i].length > MAX_CONTEXT_SAMPLES) {
        serialContext.channelHistory[i].shift()
      }
    })
  }
}

const tabs = [
  { key: 'data', label: '数据', icon: Monitor },
  { key: 'ai', label: 'AI 助手', icon: ChatDotRound },
  { key: 'pid', label: 'PID 调参', icon: Operation }
]

function beginResize(event) {
  resizing = true
  event.currentTarget?.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', resizeWorkspace)
  window.addEventListener('pointerup', stopResize, { once: true })
}

function resizeWorkspace(event) {
  if (!resizing) return
  const area = document.querySelector('.content-area')
  if (!area) return
  const bounds = area.getBoundingClientRect()
  const percent = ((event.clientY - bounds.top) / bounds.height) * 100
  topPanePercent.value = Math.max(28, Math.min(72, percent))
}

function stopResize() {
  resizing = false
  localStorage.setItem('workspace_top_percent', String(topPanePercent.value))
  window.removeEventListener('pointermove', resizeWorkspace)
}

function onPidSimulationData(samples) {
  pidSimulationSamples.value = [...samples]
}

onUnmounted(() => {
  window.removeEventListener('pointermove', resizeWorkspace)
})

const statusText = computed(() => {
  if (!status.value.connected) return '未连接'
  return `${status.value.path} @ ${status.value.baudRate}`
})

function onStatusChange(s) {
  connected.value = s.connected
  status.value = s
  serialContext.connected = s.connected
  serialContext.path = s.path || null
  serialContext.baudRate = s.baudRate || null
  serialContext.protocol = protocolEngine.value
}

function onError(msg) {
  // 状态栏处理连接错误
}

function onData(payload) {
  rxCount.value += String(payload.raw).length
  latestPayload.value = payload
  // FireWater 格式：标签:值，只提取冒号后的数值
  const rawText = String(payload.raw)
  const colonIdx = rawText.indexOf(':')
  const dataPart = colonIdx >= 0 ? rawText.slice(colonIdx + 1) : rawText
  const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
  if (nums) {
    detectedChannelCount.value = Math.min(nums.length, 8)
  }
  pushSerialContext(payload)

  if (recording.active) {
    recording.data.push({ ...payload, recTime: Date.now() - recording.startTime })
  }
}

function onSend(len) {
  txCount.value += len
}

function toggleHex() {
  showHex.value = !showHex.value
}
</script>

<template>
  <div class="app-container">
    <!-- Header -->
    <header class="app-header">
      <div class="header-left">
        <div class="app-icon">
          <el-icon size="14" color="var(--color-text-inverse)"><Cpu /></el-icon>
        </div>
        <span class="app-title">AI 串口调试助手</span>
        <span class="app-version">v1.1.0</span>
      </div>

      <div class="header-context">实时波形持续可见 · 下方切换 数据 / AI 助手 / PID 调参</div>

      <div class="header-right">
        <div class="window-dot" style="background: var(--state-error);"></div>
        <div class="window-dot" style="background: var(--state-warning);"></div>
        <div class="window-dot" style="background: var(--state-success);"></div>
      </div>
    </header>

    <!-- Main Body -->
    <div class="app-body">
      <!-- Sidebar -->
      <aside class="sidebar">
        <SerialPanel
          :ai-config="aiConfig"
          :ai-switches="aiSwitches"
          :protocol-engine="protocolEngine"
          @status-change="onStatusChange"
          @error="onError"
          @update-ai-config="saveAiConfig"
          @update-ai-switches="saveAiSwitches"
          @update-protocol="saveProtocol"
        />
      </aside>

      <!-- Content -->
      <section class="content-area">
        <div
          class="resizable-workspace"
          :style="{ gridTemplateRows: `${topPanePercent}% 8px minmax(0, 1fr)` }"
        >
          <section class="workspace-wave">
            <WorkspaceChart
              :connected="connected"
              :latest-payload="latestPayload"
              :channel-count="detectedChannelCount"
              :simulation-samples="pidSimulationSamples"
              :visible="true"
            />
          </section>

          <div
            class="workspace-resizer"
            title="上下拖动调整波形区与工作区高度"
            @pointerdown="beginResize"
          >
            <span />
          </div>

          <section class="lower-workspace">
            <nav class="lower-tabs">
              <button
                v-for="tab in tabs"
                :key="tab.key"
                :class="{ active: activeTab === tab.key, ai: tab.key === 'ai' }"
                @click="activeTab = tab.key"
              >
                <el-icon size="13"><component :is="tab.icon" /></el-icon>
                {{ tab.label }}
              </button>
            </nav>
            <div class="lower-panel">
              <!-- 数据标签：左侧数据流/数据表（可切换），右侧数据分析 -->
              <div v-show="activeTab === 'data'" class="data-split">
                <div class="data-split-left">
                  <DataMonitor
                    active-view="stream"
                    :show-view-tabs="true"
                    :connected="connected"
                    :show-hex="showHex"
                    :recording="recording"
                    @data="onData"
                    @send="onSend"
                    @start-recording="startRecording"
                    @stop-recording="stopRecording"
                    @clear-recording="clearRecording"
                  />
                </div>
                <div class="data-split-right">
                  <WorkspaceAnalysis
                    :serial-context="serialContext"
                    :ai-config="aiConfig"
                    :channel-count="detectedChannelCount"
                  />
                </div>
              </div>
              <AiPanel
                v-show="activeTab === 'ai'"
                :connected="connected"
                :status-text="statusText"
                :serial-context="serialContext"
                :ai-config="aiConfig"
                :ai-switches="aiSwitches"
                @send="onSend"
                @update-ai-config="saveAiConfig"
                @update-ai-switches="saveAiSwitches"
              />
              <PidPanel
                v-show="activeTab === 'pid'"
                :connected="connected"
                :ai-config="aiConfig"
                :serial-context="serialContext"
                :latest-payload="latestPayload"
                @send="onSend"
                @simulation-data="onPidSimulationData"
              />
            </div>
          </section>
        </div>
      </section>

    </div>

    <!-- Status Bar -->
    <StatusBar
      :connected="connected"
      :status-text="statusText"
      :rx="rxCount"
      :tx="txCount"
      :show-hex="showHex"
      @toggle-hex="toggleHex"
    />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-family-display);
}

.app-header {
  height: var(--header-height);
  min-height: var(--header-height);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border-default);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-4);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app-icon {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  background: var(--color-ai);
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.app-version {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
}

.header-tabs {
  display: flex;
  align-items: center;
  height: 100%;
}

.header-context {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.tab-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 100%;
  padding: 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 150ms ease;
}

.tab-item:hover {
  color: var(--color-text-primary);
}

.tab-item.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 500;
}

.tab-item.active.ai {
  color: var(--color-ai);
  border-bottom-color: var(--color-ai);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.window-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  opacity: 0.8;
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-default);
  overflow-y: auto;
  overflow-x: visible;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}

.content-area {
  flex: 1;
  overflow: hidden;
  background: var(--color-bg-primary);
  display: flex;
  flex-direction: column;
}

.resizable-workspace {
  display: grid;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.workspace-wave {
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.workspace-resizer {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--color-border-default);
  border-bottom: 1px solid var(--color-border-default);
  user-select: none;
  touch-action: none;
}

.workspace-resizer span {
  width: 56px;
  height: 3px;
  border-radius: 3px;
  background: var(--color-border-active);
}

.workspace-resizer:hover span {
  background: var(--color-primary);
}

.lower-workspace {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.lower-tabs {
  display: flex;
  flex-shrink: 0;
  height: 36px;
  padding: 0 12px;
  gap: 4px;
  align-items: stretch;
  border-bottom: 1px solid var(--color-border-default);
  background: var(--color-bg-secondary);
}

.lower-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 13px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.lower-tabs button:hover,
.lower-tabs button.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.lower-tabs button.active.ai {
  color: var(--color-ai);
  border-bottom-color: var(--color-ai);
}

.lower-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.lower-panel > * {
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* 数据标签：左右分栏（左数据流/表，右数据分析） */
.data-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1px;
  width: 100%;
  height: 100%;
  background: var(--color-border-default);
}

.data-split-left,
.data-split-right {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.data-split-left > *,
.data-split-right > * {
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* 窄屏响应式：左右分栏折叠为上下 */
@media (max-width: 1100px) {
  .data-split {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
