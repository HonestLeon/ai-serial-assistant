<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { Avatar, Histogram, Warning, Document, Promotion } from '@element-plus/icons-vue'
import {
  computeChannelStatistics,
  formatStatistics,
  preprocessSerialLines
} from '../services/aiDataContext.mjs'

const props = defineProps({
  connected: Boolean,
  statusText: { type: String, default: '未连接' },
  serialContext: {
    type: Object,
    default: () => ({
      connected: false,
      path: null,
      baudRate: null,
      recentLines: [],
      latestValues: Array(8).fill(0),
      channelHistory: Array.from({ length: 8 }, () => []),
      lastProtocol: null,
      lastAnomaly: null
    })
  },
  aiConfig: { type: Object, required: true },
  aiSwitches: { type: Object, required: true }
})
const emit = defineEmits(['send', 'update-ai-config', 'update-ai-switches'])

const models = [
  'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1',
  'deepseek-chat', 'deepseek-reasoner',
  'qwen-turbo', 'qwen-plus', 'qwen-max',
  'glm-4-flash', 'glm-4-plus', 'glm-4.5',
  'claude-3-5-haiku', 'claude-3-5-sonnet',
  'moonshot-v1-8k', 'yi-lightning'
]
const quickActions = [
  { label: '数据分析', icon: Histogram, prompt: 'analyze' },
  { label: '异常诊断', icon: Warning, prompt: 'diagnose' },
  { label: '协议解析', icon: Document, prompt: 'protocol' },
  { label: '发送指令', icon: Promotion, prompt: 'command' }
]

const messages = ref([
  {
    role: 'assistant',
    content: '你好，我是你的串口调试 AI 助手。可以帮你分析数据、建议波特率或解释报错信息。'
  }
])
const input = ref('')
const loading = ref(false)
let abortController = null
const chatListRef = ref(null)
const commandInput = ref('')
const detectedProtocol = ref(null)
const detectedAnomaly = ref(null)
const backgroundKnowledge = ref(localStorage.getItem('ai_serial_background') || '')

const preprocessingSummary = computed(() => {
  const result = preprocessSerialLines(props.serialContext.recentLines)
  return `${result.inputCount} → ${result.outputCount} 行`
})

const connectionDisplay = computed(() => {
  return props.connected ? props.statusText : '未连接'
})

function saveConfig() {
  emit('update-ai-config')
}

function saveSwitches() {
  emit('update-ai-switches')
}

function saveBackgroundKnowledge() {
  localStorage.setItem('ai_serial_background', backgroundKnowledge.value)
}

function formatContext() {
  const ctx = props.serialContext
  const processed = preprocessSerialLines(ctx.recentLines)
  const statistics = computeChannelStatistics(ctx.recentLines)
  const latest = statistics.map((item) => `${item.channel}=${item.last}`).join(', ') || '无'
  const processedText = processed.lines.length
    ? processed.lines.map((item) => `[${item.index}] ${item.text}`).join('\n')
    : '无'

  return [
    '[任务约束]',
    '只依据以下数据作答；不得臆测单位、通道含义或硬件型号。背景知识与数据冲突时应明确指出。',
    '',
    '[用户提供的数据说明/背景知识]',
    backgroundKnowledge.value.trim() || '未提供',
    '',
    '[连接与协议]',
    `连接状态：${ctx.connected ? `${ctx.path} @ ${ctx.baudRate}` : '未连接'}`,
    `协议识别：${detectedProtocol.value ? `${detectedProtocol.value.name}（${detectedProtocol.value.confidence}）` : '未识别'}`,
    `最新值：${latest}`,
    '',
    '[每通道统计量]',
    formatStatistics(statistics),
    '',
    '[预处理说明]',
    `原始 ${processed.inputCount} 行，变化感知压缩后 ${processed.outputCount} 行，保留比例 ${processed.compressionRatio}，变化阈值 ${processed.changeThreshold}。`,
    '变化区段及相邻采样优先保留，平稳区段下采样。以下是预处理后的全部数据，并非仅截取末尾。',
    '',
    '[预处理后的原始数据（全部）]',
    processedText,
    '',
    '[本地异常检测]',
    detectedAnomaly.value?.summary || '未启用或暂无结果'
  ].join('\n')
}

function buildSystemPrompt() {
  return `你是 AI 串口调试助手，熟悉嵌入式开发、控制系统、硬件调试与串口协议分析。
回答必须引用具体通道、统计量或采样序号作为依据；区分“数据事实”“推测”和“建议”。不得虚构单位、字段语义或设备状态。
若证据不足，请明确需要用户补充什么信息。当前上下文如下：

${formatContext()}`
}

async function callAi(customMessages) {
  saveConfig()
  loading.value = true
  abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 60000)
  try {
    const baseUrl = String(props.aiConfig.baseUrl || '').replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: props.aiConfig.model,
        messages: customMessages,
        stream: false
      }),
      signal: abortController.signal
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = await response.json()
    return { ok: true, content: data.choices?.[0]?.message?.content || '（无返回内容）' }
  } catch (e) {
    const reason = abortController.signal.aborted ? '请求超时（60s）' : (e.message || '未知错误')
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
    loading.value = false
    abortController = null
  }
}

// 新消息产生后自动滚动到底部，跟随最新对话
watch(() => messages.value.length, async () => {
  await nextTick()
  if (chatListRef.value) {
    chatListRef.value.scrollTop = chatListRef.value.scrollHeight
  }
})

async function sendMessage() {
  if (!input.value.trim()) return
  const userMsg = input.value.trim()
  messages.value.push({ role: 'user', content: userMsg })
  input.value = ''

  const msgs = [
    { role: 'system', content: buildSystemPrompt() },
    ...messages.value.slice(-10).map(m => ({ role: m.role, content: m.content }))
  ]
  const reply = await callAi(msgs)
  if (reply.ok) {
    messages.value.push({ role: 'assistant', content: reply.content })
  } else {
    messages.value.push({ role: 'assistant', content: `请求失败：${reply.error}`, isError: true })
  }
}

function runProtocolRecognition() {
  if (!props.aiSwitches.protocolRecognition) return
  const lines = props.serialContext.recentLines
  if (lines.length === 0) {
    detectedProtocol.value = null
    return
  }

  const samples = lines.slice(-20).map(l => l.text)
  const joined = samples.join('\n')
  let result = { name: '未知/原始数据', confidence: '低' }

  if (samples.some(s => s.trim().startsWith('{') || s.trim().startsWith('['))) {
    result = { name: 'JSON', confidence: '高' }
  } else if (samples.some(s => /^AT[+/=A-Z0-9?]+/i.test(s.trim()))) {
    result = { name: 'AT 指令', confidence: '高' }
  } else if (samples.some(s => /\b(0x[0-9A-Fa-f]{2}\s*){4,}/.test(s))) {
    result = { name: 'Modbus/HEX 帧', confidence: '中' }
  } else if (samples.some(s => s.includes(',') && /[-+]?\d*\.?\d+/.test(s))) {
    result = { name: 'CSV 数值', confidence: '高' }
  } else if (samples.some(s => /^[^:]+:[\s]*[-+]?\d/.test(s.trim()))) {
    result = { name: 'FireWater（标签:值）', confidence: '高' }
  } else if (/^\s*[-+]?\d*\.?\d+(\s+[-+]?\d*\.?\d+)*\s*$/.test(joined.split('\n')[0])) {
    result = { name: '空格分隔数值', confidence: '高' }
  } else if (/^[\x20-\x7E\r\n]+$/.test(joined) && samples.some(s => /[A-Za-z]/.test(s))) {
    result = { name: 'ASCII 文本日志', confidence: '中' }
  }

  detectedProtocol.value = result
  props.serialContext.lastProtocol = result
}

function runAnomalyDetection() {
  if (!props.aiSwitches.anomalyDetection) {
    detectedAnomaly.value = null
    return
  }

  const history = props.serialContext.channelHistory
  const anomalies = []

  history.forEach((channelData, idx) => {
    if (channelData.length < 10) return
    const n = channelData.length
    const mean = channelData.reduce((a, b) => a + b, 0) / n
    const variance = channelData.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
    const std = Math.sqrt(variance) || 1e-6
    const latest = channelData[n - 1]
    const zScore = Math.abs((latest - mean) / std)

    if (zScore > 3) {
      anomalies.push(`I${idx} 通道当前值 ${latest.toFixed(3)} 偏离均值 ${mean.toFixed(3)} 超过 3σ（z=${zScore.toFixed(2)}）`)
    }

    const stuckWindow = Math.min(20, n)
    const recent = channelData.slice(-stuckWindow)
    const allSame = recent.every(v => v === recent[0])
    if (allSame && stuckWindow >= 10) {
      anomalies.push(`I${idx} 通道最近 ${stuckWindow} 个采样 stuck 在 ${recent[0]}`)
    }
  })

  if (anomalies.length > 0) {
    detectedAnomaly.value = { summary: anomalies.join('；') }
  } else {
    detectedAnomaly.value = { summary: '未检测到明显异常' }
  }
  props.serialContext.lastAnomaly = detectedAnomaly.value
}

watch(() => props.serialContext.recentLines.length, () => {
  runProtocolRecognition()
  runAnomalyDetection()
})

watch(() => props.aiSwitches.protocolRecognition, (enabled) => {
  if (enabled) runProtocolRecognition()
  else detectedProtocol.value = null
  saveSwitches()
})

watch(() => props.aiSwitches.anomalyDetection, (enabled) => {
  if (enabled) runAnomalyDetection()
  else detectedAnomaly.value = null
  saveSwitches()
})

async function handleQuickAction(action) {
  if (action.prompt === 'command') {
    const cmd = commandInput.value.trim()
    if (!cmd) {
      messages.value.push({ role: 'assistant', content: '请输入要发送的指令内容。' })
      return
    }
    if (!props.connected) {
      messages.value.push({ role: 'assistant', content: '串口未连接，无法发送指令。' })
      return
    }
    try {
      await window.electronAPI.serial.send(cmd, 'utf8')
      emit('send', cmd.length)
      messages.value.push({ role: 'assistant', content: `已发送指令：${cmd}` })
      commandInput.value = ''
    } catch (e) {
      messages.value.push({ role: 'assistant', content: `发送失败：${e.message || e}` })
    }
    return
  }

  let userPrompt = ''
  switch (action.prompt) {
    case 'analyze':
      userPrompt = '请分析最近接收到的串口数据，总结数据趋势、通道变化特征，并给出调试建议。'
      break
    case 'diagnose':
      userPrompt = '请基于最近的波形与数值，诊断是否存在异常（如噪声、漂移、 stuck、突变等），并给出可能原因与排查建议。'
      break
    case 'protocol':
      userPrompt = '请尝试解析最近串口数据的协议格式，说明可能的数据帧结构、字段含义，并给出解析建议。'
      break
  }

  messages.value.push({ role: 'user', content: `[${action.label}] ${userPrompt}` })
  const msgs = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userPrompt }
  ]
  const reply = await callAi(msgs)
  if (reply.ok) {
    messages.value.push({ role: 'assistant', content: reply.content })
  } else {
    messages.value.push({ role: 'assistant', content: `请求失败：${reply.error}`, isError: true })
  }
}
</script>

<template>
  <div class="ai-panel">
    <!-- Sidebar -->
    <aside class="ai-sidebar">
      <div class="panel-section">
        <div class="section-header">连接状态</div>
        <div class="status-card">
          <div class="status-dot" :style="{ background: connected ? 'var(--state-success)' : 'var(--color-text-tertiary)' }"></div>
          <div>
            <div class="status-main">{{ connectionDisplay }}</div>
            <div class="status-sub">{{ detectedProtocol ? detectedProtocol.name : 'Raw 协议' }}</div>
          </div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">AI 模型</div>
        <div class="model-card">
          <el-icon size="13" color="var(--color-ai)"><Avatar /></el-icon>
          <span>{{ props.aiConfig.model }}</span>
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">智能开关</div>
        <div class="toggle-setting">
          <span>实时异常检测</span>
          <el-switch v-model="props.aiSwitches.anomalyDetection" size="small" />
        </div>
        <div class="toggle-setting">
          <span>协议自动识别</span>
          <el-switch v-model="props.aiSwitches.protocolRecognition" size="small" />
        </div>
        <div v-if="detectedProtocol" class="detected-card">
          <div class="detected-title">识别协议</div>
          <div class="detected-value">{{ detectedProtocol.name }}</div>
          <div class="detected-conf">置信度：{{ detectedProtocol.confidence }}</div>
        </div>
        <div v-if="detectedAnomaly" class="detected-card warn">
          <div class="detected-title">异常检测</div>
          <div class="detected-value">{{ detectedAnomaly.summary }}</div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">数据说明 / 背景知识</div>
        <el-input
          v-model="backgroundKnowledge"
          type="textarea"
          :rows="4"
          resize="vertical"
          placeholder="例如：I0 是目标转速，I1 是实际转速，采样周期 10 ms，单位 rpm。"
          @change="saveBackgroundKnowledge"
          @blur="saveBackgroundKnowledge"
        />
        <div class="preprocess-summary">AI 上下文预处理：{{ preprocessingSummary }}</div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">快捷操作</div>
        <div class="quick-actions">
          <button
            v-for="action in quickActions"
            :key="action.label"
            class="quick-btn"
            :disabled="loading"
            @click="handleQuickAction(action)"
          >
            <el-icon size="14"><component :is="action.icon" /></el-icon>
            <span>{{ action.label }}</span>
          </button>
        </div>
        <div class="command-box">
          <el-input
            v-model="commandInput"
            size="small"
            placeholder="输入指令后点击发送指令"
            :disabled="!connected || loading"
          />
        </div>
      </div>
    </aside>

    <!-- Chat Area -->
    <section class="chat-area">
      <div ref="chatListRef" class="chat-list">
        <div
          v-for="(msg, idx) in messages"
          :key="idx"
          class="message-wrapper"
          :class="msg.role"
        >
          <div v-if="msg.role === 'assistant'" class="ai-avatar">
            <el-icon size="14" color="var(--color-ai)"><Avatar /></el-icon>
          </div>
          <div class="message-bubble" :class="[msg.role, { 'message-error': msg.isError }]">
            {{ msg.content }}
          </div>
        </div>
      </div>

      <div class="config-bar">
        <el-input v-model="props.aiConfig.baseUrl" size="small" placeholder="Base URL" @change="saveConfig" />
        <el-input v-model="props.aiConfig.apiKey" size="small" placeholder="API Key" type="password" show-password @change="saveConfig" />
        <el-select
          v-model="props.aiConfig.model"
          size="small"
          filterable
          allow-create
          default-first-option
          placeholder="选择或输入任意模型名"
          style="width: 200px"
          @change="saveConfig"
        >
          <el-option v-for="m in models" :key="m" :label="m" :value="m" />
        </el-select>
      </div>

      <div class="input-bar">
        <el-input
          v-model="input"
          placeholder="输入问题，例如：分析一下刚才的波形"
          size="small"
          :disabled="loading"
          @keyup.enter="sendMessage"
        />
        <el-button type="primary" size="small" :loading="loading" @click="sendMessage">发送</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  height: 100%;
  color: var(--color-text-primary);
}

.ai-sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-default);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.panel-section {
  padding: var(--space-3);
}

.section-header {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
  margin-bottom: var(--space-2);
}

.divider {
  height: 1px;
  background: var(--color-border-default);
  margin: 0 var(--space-3);
}

.status-card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-main {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
}

.status-sub {
  font-size: 10px;
  color: var(--color-text-secondary);
}

.model-card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--color-ai-subtle);
  border: 1px solid var(--color-ai-muted);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--color-ai);
  font-weight: 500;
}

.toggle-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.detected-card {
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-ai);
  border-radius: var(--radius-sm);
}

.detected-card.warn {
  border-left-color: var(--state-warning);
}

.detected-title {
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-bottom: 2px;
}

.detected-value {
  font-size: var(--text-xs);
  color: var(--color-text-primary);
  line-height: 1.5;
  word-break: break-all;
}

.detected-conf {
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.quick-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-default);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: all 150ms ease;
}

.quick-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  border-color: var(--color-border-active);
}

.quick-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quick-btn:first-child {
  background: var(--color-ai-muted);
  color: var(--color-ai);
  border-color: var(--color-ai-glow);
}

.command-box {
  margin-top: var(--space-2);
}

.preprocess-summary {
  margin-top: 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-tertiary);
}

.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.message-wrapper {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.message-wrapper.user {
  justify-content: flex-end;
}

.ai-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-ai-muted);
  border: 1px solid var(--color-ai-glow);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.message-bubble {
  max-width: 65%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-bubble.user {
  background: var(--color-primary-muted);
  color: var(--color-text-primary);
}

.message-bubble.assistant {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border-left: 3px solid var(--color-ai);
  max-width: 70%;
}

/* 请求失败标记：置于 assistant 规则之后，确保同优先级下覆盖其底色/左边框 */
.message-bubble.message-error {
  border-left: 2px solid var(--state-error);
  background: var(--message-alt-bg);
}

.config-bar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border-default);
  background: var(--color-bg-secondary);
}

.input-bar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border-default);
}
</style>
