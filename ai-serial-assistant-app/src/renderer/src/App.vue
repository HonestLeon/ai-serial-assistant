<script setup>
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue'
import { Cpu, Monitor, Operation, Minus, FullScreen, Close } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import SerialPanel from './components/SerialPanel.vue'
import DataMonitor from './components/DataMonitor.vue'
import StatusBar from './components/StatusBar.vue'
import PidAgentPanel from './components/PidAgentPanel.vue'
import WorkspaceChart from './components/WorkspaceChart.vue'
import WorkspaceAnalysis from './components/WorkspaceAnalysis.vue'
import { parseChannelValues } from './services/parseChannelValues.mjs'

const activeTab = ref('data')

// 启动时对持久化的分隔位置做与拖拽一致的 28~72 区间钳制，防止异常存储值破坏布局
const storedTopPercent = Number(localStorage.getItem('workspace_top_percent')) || 52
const topPanePercent = ref(Math.max(28, Math.min(72, storedTopPercent)))
const pidSimulationSamples = ref([])

let resizing = false
let offMaximizeChange = null
const connected = ref(false)
const status = ref({ connected: false, path: null, baudRate: null })
const rxCount = ref(0)
const txCount = ref(0)
const showHex = ref(false)
const detectedChannelCount = ref(0)

// 组件方法引用：串口数据由 App 统一订阅并分发，子组件只负责展示
const dataMonitorRef = ref(null)
const chartRef = ref(null)
const pidAgentRef = ref(null)

// 全局 AI 配置（SerialPanel 和 PID 调参智能体面板共享）
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

// 协议引擎选择：子组件回传值，父组件同时更新状态与持久化（此前只写回旧值）
const protocolEngine = ref(localStorage.getItem('serial_protocol') || 'raw')
function saveProtocol(value) {
  if (typeof value === 'string' && value) protocolEngine.value = value
  localStorage.setItem('serial_protocol', protocolEngine.value)
}

// 录制状态
const MAX_RECORD_FRAMES = 200000
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

// ---------------- 串口数据：唯一订阅点在 App ----------------

// 50 ms 采样下保留约 60 秒，避免阶跃起点过早被滚动窗口淘汰。
const MAX_CONTEXT_SAMPLES = 1200
const DISPLAY_FLUSH_MS = 100

const serialContext = reactive({
  channelHistory: Array.from({ length: 8 }, () => [])
})

/** 只保留通道历史（分析面板消费）；连接信息由 status ref 持有 */
function pushChannelHistory(values) {
  if (!values) return
  const limit = Math.min(values.length, 8)
  for (let i = 0; i < limit; i++) {
    const value = Number(values[i])
    if (!Number.isFinite(value)) continue
    const history = serialContext.channelHistory[i]
    history.push(value)
  }
  for (let i = 0; i < 8; i++) {
    const history = serialContext.channelHistory[i]
    if (history.length > MAX_CONTEXT_SAMPLES + 256) {
      history.splice(0, history.length - MAX_CONTEXT_SAMPLES)
    }
  }
}

/** FireWater 格式「标签:值」：解析逻辑统一在 services/parseChannelValues（支持科学计数法） */

// 展示层批处理：DOM 每 100ms 刷新一次，避免高频遥测把渲染线程打满
const pendingDisplay = []
let displayTimer = null

function scheduleDisplayFlush() {
  if (displayTimer != null) return
  displayTimer = setTimeout(() => {
    displayTimer = null
    const batch = pendingDisplay.splice(0, pendingDisplay.length)
    if (batch.length) dataMonitorRef.value?.appendBatch(batch)
    if (pendingDisplay.length) scheduleDisplayFlush()
  }, DISPLAY_FLUSH_MS)
}

/** 实时数据：计数 / 上下文 / 录制逐帧处理，展示与绘图/智能体按批分发 */
function handleLiveFrames(frames) {
  const valid = []
  for (const frame of frames) {
    if (!frame) continue
    valid.push(frame)
    const rawText = String(frame.raw ?? '')
    // RX 按字节计数（主进程已在 payload.bytes 提供真实字节数）
    rxCount.value += Number(frame.bytes) || rawText.length

    const nums = parseChannelValues(rawText)
    if (nums) {
      detectedChannelCount.value = Math.min(nums.length, 8)
      pushChannelHistory(nums)
    }

    if (recording.active) {
      if (recording.data.length >= MAX_RECORD_FRAMES) {
        recording.active = false
        ElMessage.warning(`录制已达 ${MAX_RECORD_FRAMES} 帧上限，已自动停止`)
      } else {
        recording.data.push({ ...frame, recTime: Date.now() - recording.startTime })
      }
    }
  }
  if (!valid.length) return

  chartRef.value?.appendBatch(valid)
  pidAgentRef.value?.pushSerialBatch(valid)
  pendingDisplay.push(...valid)
  scheduleDisplayFlush()
}

function onSerialPayload(payload) {
  handleLiveFrames(Array.isArray(payload) ? payload : [payload])
}

/** 回放：只回放到波形与智能体，不计入 RX/录制，避免污染统计数据 */
function onReplayBatch(frames) {
  const list = Array.isArray(frames) ? frames : [frames]
  if (!list.length) return
  chartRef.value?.appendBatch(list)
  pidAgentRef.value?.pushSerialBatch(list)
}

/** DataMonitor 清空数据时同步清空分析上下文与通道数，保证两侧一致 */
function onClearData() {
  serialContext.channelHistory.forEach((history) => { history.length = 0 })
  detectedChannelCount.value = 0
}

/** 清空波形后通道数同步归零，避免侧栏仍显示 8 个空通道 */
function onChartClear() {
  detectedChannelCount.value = 0
}

let unsubscribeData = null

onMounted(() => {
  unsubscribeData = window.electronAPI?.serial?.onData?.(onSerialPayload) || null
})

onUnmounted(() => {
  unsubscribeData?.()
  unsubscribeData = null
  if (displayTimer) {
    clearTimeout(displayTimer)
    displayTimer = null
  }
  pendingDisplay.length = 0
  window.removeEventListener('pointermove', resizeWorkspace)
  window.removeEventListener('pointerup', endResize)
  window.removeEventListener('pointercancel', endResize)
  window.removeEventListener('blur', endResize)
  offMaximizeChange?.()
})

const tabs = [
  { key: 'data', label: '数据', icon: Monitor, panelId: 'panel-data' },
  { key: 'pid', label: 'PID 调参', icon: Operation, panelId: 'panel-pid' }
]

// ---------------- 上下分隔条 ----------------

function beginResize(event) {
  if (event.button !== undefined && event.button !== 0) return
  resizing = true
  event.currentTarget?.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', resizeWorkspace)
  window.addEventListener('pointerup', endResize)
  window.addEventListener('pointercancel', endResize)
  window.addEventListener('blur', endResize)
}

function resizeWorkspace(event) {
  if (!resizing) return
  const area = document.querySelector('.content-area')
  if (!area) return
  const bounds = area.getBoundingClientRect()
  const percent = ((event.clientY - bounds.top) / bounds.height) * 100
  topPanePercent.value = Math.max(28, Math.min(72, percent))
}

function endResize() {
  if (!resizing) return
  resizing = false
  localStorage.setItem('workspace_top_percent', String(topPanePercent.value))
  window.removeEventListener('pointermove', resizeWorkspace)
  window.removeEventListener('pointerup', endResize)
  window.removeEventListener('pointercancel', endResize)
  window.removeEventListener('blur', endResize)
}

// 键盘调节波形区与工作区高度（分隔条可访问性，与指针拖拽共用同一区间约束）
function resizeWorkspaceByDelta(delta) {
  topPanePercent.value = Math.max(28, Math.min(72, topPanePercent.value + delta))
  localStorage.setItem('workspace_top_percent', String(topPanePercent.value))
}

function onPidSimulationData(samples) {
  pidSimulationSamples.value = [...samples]
}

const statusText = computed(() => {
  if (!status.value.connected) return '未连接'
  return `${status.value.path} @ ${status.value.baudRate}`
})

function onStatusChange(s) {
  connected.value = s.connected
  status.value = s
}

function onError(msg) {
  // 注意：ElMessage.error(message, appContext) 的第二参数并非 options，duration 需以对象形式传入
  ElMessage.error({ message: typeof msg === 'string' ? msg : (msg?.message || '串口操作失败'), duration: 4000 })
}

function onSend(len) {
  txCount.value += len
}

function toggleHex() {
  showHex.value = !showHex.value
}

// ---------------- 窗口控制（Windows 无原生 caption buttons） ----------------

const isMaximized = ref(false)

function minimizeWindow() {
  window.electronAPI?.windowControl?.minimize?.()
}

function toggleMaximizeWindow() {
  window.electronAPI?.windowControl?.toggleMaximize?.()
}

function closeWindow() {
  window.electronAPI?.windowControl?.close?.()
}

onMounted(async () => {
  try {
    const api = window.electronAPI?.windowControl
    if (!api) return
    isMaximized.value = (await api.isMaximized?.()) === true
    offMaximizeChange = api.onMaximizeChange?.((value) => { isMaximized.value = !!value }) || null
  } catch { /* 窗口控制不可用时保持默认状态 */ }
})
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

      <div class="header-context">实时波形持续可见 · 下方切换 数据 / PID 调参</div>

      <div class="window-controls">
        <button class="window-btn" type="button" aria-label="最小化" title="最小化" @click="minimizeWindow">
          <el-icon size="14"><Minus /></el-icon>
        </button>
        <button
          class="window-btn"
          type="button"
          :aria-label="isMaximized ? '还原' : '最大化'"
          :title="isMaximized ? '还原' : '最大化'"
          @click="toggleMaximizeWindow"
        >
          <el-icon size="13"><FullScreen /></el-icon>
        </button>
        <button class="window-btn close" type="button" aria-label="关闭" title="关闭" @click="closeWindow">
          <el-icon size="14"><Close /></el-icon>
        </button>
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
              ref="chartRef"
              :connected="connected"
              :channel-count="detectedChannelCount"
              :simulation-samples="pidSimulationSamples"
              @clear="onChartClear"
            />
          </section>

          <div
            class="workspace-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整波形区与工作区高度"
            :aria-valuenow="Math.round(topPanePercent)"
            aria-valuemin="28"
            aria-valuemax="72"
            tabindex="0"
            title="上下拖动调整波形区与工作区高度（方向键微调，Esc 结束拖动）"
            @pointerdown="beginResize"
            @keydown.up.prevent="resizeWorkspaceByDelta(3)"
            @keydown.down.prevent="resizeWorkspaceByDelta(-3)"
            @keydown.esc="endResize"
          >
            <span />
          </div>

          <section class="lower-workspace">
            <nav class="lower-tabs" role="tablist" aria-label="工作区视图">
              <button
                v-for="tab in tabs"
                :id="`tab-${tab.key}`"
                :key="tab.key"
                role="tab"
                :aria-selected="activeTab === tab.key ? 'true' : 'false'"
                :aria-controls="tab.panelId"
                :class="{ active: activeTab === tab.key }"
                @click="activeTab = tab.key"
              >
                <el-icon size="13"><component :is="tab.icon" /></el-icon>
                {{ tab.label }}
              </button>
            </nav>
            <div class="lower-panel">
              <!-- 数据标签：左侧数据流/数据表（可切换），右侧数据分析 -->
              <div
                v-show="activeTab === 'data'"
                id="panel-data"
                class="data-split"
                role="tabpanel"
                aria-labelledby="tab-data"
              >
                <div class="data-split-left">
                  <DataMonitor
                    ref="dataMonitorRef"
                    :active="activeTab === 'data'"
                    :connected="connected"
                    :show-hex="showHex"
                    :recording="recording"
                    @send="onSend"
                    @replay-batch="onReplayBatch"
                    @clear-data="onClearData"
                    @start-recording="startRecording"
                    @stop-recording="stopRecording"
                    @clear-recording="clearRecording"
                  />
                </div>
                <div class="data-split-right">
                  <WorkspaceAnalysis
                    :active="activeTab === 'data'"
                    :serial-context="serialContext"
                    :ai-config="aiConfig"
                    :channel-count="detectedChannelCount"
                  />
                </div>
              </div>
              <PidAgentPanel
                v-show="activeTab === 'pid'"
                id="panel-pid"
                ref="pidAgentRef"
                role="tabpanel"
                aria-labelledby="tab-pid"
                :connected="connected"
                :ai-config="aiConfig"
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
  /* 无原生标题栏：整条 header 作为拖拽区，按钮单独 no-drag */
  -webkit-app-region: drag;
  user-select: none;
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

.header-context {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.window-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.window-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.window-btn.close:hover {
  background: var(--state-error);
  color: var(--color-text-inverse);
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

.workspace-resizer:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
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
  transition: color 150ms ease, border-bottom-color 150ms ease;
}

/* hover 仅变色，不加下划线；active 才有下划线 + 字重，二者可区分 */
.lower-tabs button:hover {
  color: var(--color-primary);
}

.lower-tabs button.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: var(--weight-medium);
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
