<script setup>
import { computed, ref, reactive, onUnmounted, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Promotion, DataAnalysis } from '@element-plus/icons-vue'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  buildStructuredAiContext
} from '../services/controlAnalysis.mjs'
import {
  CONTROLLER_OUTPUT_PRESETS,
  PID_STRATEGIES,
  generateEmbeddedControllerFiles,
  getStrategyConfig,
  simulatePidStrategy
} from '../services/pidSimulation.mjs'

const props = defineProps({
  connected: Boolean,
  aiConfig: { type: Object, required: true },
  serialContext: { type: Object, default: null },
  latestPayload: { type: Object, default: null }
})
const emit = defineEmits(['send', 'simulation-data'])

const testMode = ref('simulation')
const strategyId = ref('motor_speed')
const simulationConfig = reactive(getStrategyConfig(strategyId.value))
const tuningOrder = ref([...PID_STRATEGIES[strategyId.value].defaultOrder])
const outputPreset = ref('pid_only')
const feedforwardGain = ref(0)
const simulationStatus = ref('')

const strategy = computed(() => PID_STRATEGIES[strategyId.value])
const strategyOptions = computed(() => Object.values(PID_STRATEGIES))
const outputPresetOptions = computed(() => Object.entries(CONTROLLER_OUTPUT_PRESETS).map(([id, item]) => ({
  id,
  ...item
})))
const simulationFields = computed(() => {
  const common = [
    ['duration', '仿真时长 (s)'],
    ['dt', '步长 dt (s)'],
    ['noise', '反馈噪声幅值'],
    ['target', '目标值'],
    ['J', '转动惯量 J'],
    ['outputLimit', '输出限幅']
  ]
  if (strategyId.value === 'inverted_pendulum') {
    return [...common, ['initialAngle', '初始倾角 θ'], ['m', '质量 m'], ['g', '重力加速度 g'], ['l', '质心距离 l']]
  }
  return [...common, ['B', '总阻尼 B'], ['Kt', '转矩常数 Kt']]
})

const stepConfig = reactive({
  command: 'SET_POINT',
  amplitude: '100',
  duration: 2000,
  channel: 1
})

const outputParams = reactive({
  kp: '1.8',
  ki: '0.22',
  kd: '0.12'
})

const collecting = ref(false)
const analyzing = ref(false)
const response = ref([])
const aiResult = ref('')
const deterministicMetrics = ref(null)
const localReasons = ref([])
const error = ref('')

let collectTimer = null
let firstResponseTime = null

function applyStrategyDefaults() {
  Object.keys(simulationConfig).forEach((key) => delete simulationConfig[key])
  Object.assign(simulationConfig, getStrategyConfig(strategyId.value))
  tuningOrder.value = [...strategy.value.defaultOrder]
  if (strategyId.value === 'cascade_position') {
    outputParams.kp = String(simulationConfig.positionKp)
    outputParams.ki = String(simulationConfig.positionKi)
    outputParams.kd = String(simulationConfig.positionKd)
  } else {
    outputParams.kp = String(simulationConfig.kp)
    outputParams.ki = String(simulationConfig.ki)
    outputParams.kd = String(simulationConfig.kd)
  }
  response.value = []
  deterministicMetrics.value = null
  simulationStatus.value = '已载入与真实条件相近的默认模型参数'
}

function moveTuningStep(index, offset) {
  const nextIndex = index + offset
  if (nextIndex < 0 || nextIndex >= tuningOrder.value.length) return
  const order = [...tuningOrder.value]
  ;[order[index], order[nextIndex]] = [order[nextIndex], order[index]]
  tuningOrder.value = order
}

function runSimulation() {
  error.value = ''
  const overrides = { ...simulationConfig }
  if (strategyId.value === 'cascade_position') {
    overrides.positionKp = Number(outputParams.kp)
    overrides.positionKi = Number(outputParams.ki)
    overrides.positionKd = Number(outputParams.kd)
  } else {
    overrides.kp = Number(outputParams.kp)
    overrides.ki = Number(outputParams.ki)
    overrides.kd = Number(outputParams.kd)
  }
  const result = simulatePidStrategy(strategyId.value, overrides)
  response.value = result.samples
  emit('simulation-data', result.samples)
  simulationStatus.value = `仿真完成：${result.samples.length} 点；反馈已叠加可复现的小幅噪声`
  deterministicMetrics.value = null
  localReasons.value = []
  analyzeResponse()
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function exportEmbeddedController() {
  const files = generateEmbeddedControllerFiles({
    name: `zhichuan_${strategyId.value}`,
    outputPreset: outputPreset.value,
    kff: feedforwardGain.value,
    ...outputParams
  })
  downloadText(files.header.filename, files.header.content)
  setTimeout(() => downloadText(files.source.filename, files.source.content), 120)
  simulationStatus.value = `已生成 ${files.header.filename} 与 ${files.source.filename}（函数指针接口）`
}

function startStepTest() {
  if (!props.connected) {
    error.value = '请先连接串口'
    return
  }
  error.value = ''
  response.value = []
  deterministicMetrics.value = null
  localReasons.value = []
  firstResponseTime = null
  collecting.value = true

  // 发送阶跃信号
  const cmd = `${stepConfig.command} ${stepConfig.amplitude}`
  window.electronAPI.serial.send(cmd, 'utf8').catch(e => {
    error.value = `发送失败: ${e.message || e}`
  })
  emit('send', cmd.length)

  // 采集时长后自动停止
  collectTimer = setTimeout(() => {
    stopCollection()
  }, stepConfig.duration)
}

function stopCollection() {
  collecting.value = false
  if (collectTimer) {
    clearTimeout(collectTimer)
    collectTimer = null
  }
}

function onSerialData(payload) {
  if (!collecting.value) return
  // FireWater 格式：标签:值，只提取冒号后的数值
  const rawText = String(payload.raw)
  const colonIdx = rawText.indexOf(':')
  const dataPart = colonIdx >= 0 ? rawText.slice(colonIdx + 1) : rawText
  const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
  if (nums && nums.length > stepConfig.channel) {
    const feedback = parseFloat(nums[stepConfig.channel])
    const timestamp = Number(payload.time) || Date.now()
    if (firstResponseTime === null) {
      firstResponseTime = timestamp
      response.value.push({ t: 0, target: 0, feedback, output: 0 })
    }
    response.value.push({
      t: Math.max(0.001, (timestamp - firstResponseTime) / 1000),
      target: Number(stepConfig.amplitude),
      feedback,
      output: 0
    })
  }
}

async function analyzeResponse() {
  if (response.value.length < 5) {
    error.value = '采集数据不足，请先执行阶跃测试'
    return
  }

  error.value = ''
  analyzing.value = true
  aiResult.value = ''
  deterministicMetrics.value = analyzeControlSamples(response.value, {
    ...strategy.value.acceptance
  })
  if (!deterministicMetrics.value.valid) {
    error.value = deterministicMetrics.value.reason
    analyzing.value = false
    return
  }

  const candidate = buildPidSuggestion(deterministicMetrics.value, outputParams)
  outputParams.kp = String(candidate.kp)
  outputParams.ki = String(candidate.ki)
  outputParams.kd = String(candidate.kd)
  localReasons.value = candidate.reasons

  if (!props.aiConfig.apiKey) {
    aiResult.value = '已完成本地确定性分析。未配置 AI API Key，因此跳过在线解释；候选参数仍可由人工审查。'
    analyzing.value = false
    return
  }

  const structuredContext = buildStructuredAiContext(deterministicMetrics.value, candidate, {
    system: strategy.value.name,
    scenario: testMode.value === 'simulation'
      ? `低成本仿真测试；模型：${strategy.value.description}`
      : `真实串口阶跃测试；阶跃幅值 ${stepConfig.amplitude}`
  })

  try {
    const res = await fetch(`${props.aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: props.aiConfig.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你是控制工程解释助手。固定算法已经给出指标和有界候选参数。请解释证据、风险和下一步实验；不得修改边界，不得声称已控制硬件。' },
          { role: 'user', content: JSON.stringify(structuredContext, null, 2) }
        ],
        stream: false
      })
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data2 = await res.json()
    aiResult.value = data2.choices?.[0]?.message?.content || '（无返回内容）'

    // AI 只解释，禁止覆盖确定性算法生成的有界候选参数。
  } catch (e) {
    error.value = `AI 分析失败: ${e.message}`
  } finally {
    analyzing.value = false
  }
}

async function sendParams() {
  if (!props.connected) {
    error.value = '请先连接串口'
    return
  }
  error.value = ''
  const values = {
    kp: Number(outputParams.kp),
    ki: Number(outputParams.ki),
    kd: Number(outputParams.kd)
  }
  if (!Number.isFinite(values.kp) || !Number.isFinite(values.ki) || !Number.isFinite(values.kd)) {
    error.value = 'PID 参数必须是有效数字'
    return
  }
  if (values.kp < 0 || values.kp > 20 || values.ki < 0 || values.ki > 10 || values.kd < 0 || values.kd > 10) {
    error.value = '参数超出 MVP 安全边界：Kp 0~20，Ki 0~10，Kd 0~10'
    return
  }
  try {
    await ElMessageBox.confirm(
      `即将下发 PID ${values.kp} ${values.ki} ${values.kd}。请确认设备已处于安全工况，并已记录原参数以便回退。`,
      '人工确认后下发',
      { confirmButtonText: '确认下发', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    error.value = '已取消下发，设备参数未改变'
    return
  }
  const cmd = `PID ${values.kp} ${values.ki} ${values.kd}`
  try {
    await window.electronAPI.serial.send(cmd, 'utf8')
    emit('send', cmd.length)
    error.value = `已下发: ${cmd}`
  } catch (e) {
    error.value = `下发失败: ${e.message || e}`
  }
}

function clearAll() {
  response.value = []
  aiResult.value = ''
  deterministicMetrics.value = null
  localReasons.value = []
  error.value = ''
  outputParams.kp = '1.8'
  outputParams.ki = '0.22'
  outputParams.kd = '0.12'
}

// 监听父组件传来的数据（兼容真实串口和模拟数据）
watch(() => props.latestPayload, (payload) => {
  if (payload) onSerialData(payload)
})

onUnmounted(() => {
  stopCollection()
})
</script>

<template>
  <div class="pid-panel">
    <div class="pid-content">
      <!-- 策略注册表与低成本仿真 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">0</div>
          <div class="step-title">策略注册表与测试来源</div>
          <el-tag type="success" size="small">仿真不下发硬件</el-tag>
        </div>
        <div class="step-body">
          <div class="param-grid">
            <div class="field">
              <label>测试来源</label>
              <el-radio-group v-model="testMode" size="small">
                <el-radio-button value="simulation">仿真测试</el-radio-button>
                <el-radio-button value="serial">真实串口</el-radio-button>
              </el-radio-group>
            </div>
            <div class="field">
              <label>控制策略</label>
              <el-select v-model="strategyId" size="small" @change="applyStrategyDefaults">
                <el-option
                  v-for="item in strategyOptions"
                  :key="item.id"
                  :label="item.name"
                  :value="item.id"
                />
              </el-select>
            </div>
          </div>
          <div class="strategy-note">
            <strong>{{ strategy.name }}</strong>
            <span>{{ strategy.description }}</span>
            <span>验收：超调 ≤ {{ strategy.acceptance.overshootLimit }}%，稳定带 ±{{ strategy.acceptance.settlingBand * 100 }}%</span>
          </div>

          <template v-if="testMode === 'simulation'">
            <div class="subsection-title">模型参数（已提供接近真实条件的默认值）</div>
            <div class="model-grid">
              <div v-for="[key, label] in simulationFields" :key="key" class="field">
                <label>{{ label }}</label>
                <el-input-number
                  v-model="simulationConfig[key]"
                  size="small"
                  :controls="false"
                  :step="key === 'dt' || key === 'noise' ? 0.001 : 0.1"
                />
              </div>
            </div>
            <div class="action-row">
              <button class="btn-primary" @click="runSimulation">
                <el-icon size="13"><DataAnalysis /></el-icon>
                <span>运行仿真并分析</span>
              </button>
              <button class="btn-secondary" @click="applyStrategyDefaults">恢复默认模型</button>
              <span class="data-count">{{ simulationStatus }}</span>
            </div>
          </template>

          <div class="subsection-title">控制器输出函数</div>
          <div class="param-grid">
            <div class="field">
              <label>输出预设</label>
              <el-select v-model="outputPreset" size="small">
                <el-option v-for="item in outputPresetOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </div>
            <div v-if="outputPreset === 'linear_feedforward'" class="field">
              <label>前馈系数 Kff</label>
              <el-input-number v-model="feedforwardGain" size="small" :controls="false" :step="0.01" />
            </div>
          </div>
          <div class="formula">{{ CONTROLLER_OUTPUT_PRESETS[outputPreset].formula }}</div>

          <div class="subsection-title">调参顺序（由用户决定）</div>
          <div class="order-list">
            <div v-for="(item, index) in tuningOrder" :key="item" class="order-item">
              <span>{{ index + 1 }}. {{ item }}</span>
              <div>
                <button :disabled="index === 0" @click="moveTuningStep(index, -1)">↑</button>
                <button :disabled="index === tuningOrder.length - 1" @click="moveTuningStep(index, 1)">↓</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 步骤 1: 阶跃信号配置 -->
      <div v-if="testMode === 'serial'" class="step-card">
        <div class="step-header">
          <div class="step-number">1</div>
          <div class="step-title">阶跃信号发送</div>
          <el-tag v-if="collecting" type="warning" effect="dark" size="small">采集中</el-tag>
        </div>
        <div class="step-body">
          <div class="param-grid">
            <div class="field">
              <label>阶跃指令</label>
              <el-input v-model="stepConfig.command" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>幅值</label>
              <el-input v-model="stepConfig.amplitude" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>采集时长 (ms)</label>
              <el-input v-model.number="stepConfig.duration" type="number" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>采集通道</label>
              <el-select v-model="stepConfig.channel" size="small" :disabled="collecting">
                <el-option v-for="i in 8" :key="i - 1" :label="`I${i - 1}`" :value="i - 1" />
              </el-select>
            </div>
          </div>
          <div class="action-row">
            <button class="btn-primary" :disabled="!connected || collecting" @click="startStepTest">
              <el-icon size="13"><Promotion /></el-icon>
              <span>发送阶跃信号</span>
            </button>
            <button v-if="collecting" class="btn-danger" @click="stopCollection">停止采集</button>
            <span v-if="response.length > 0" class="data-count">已采集 {{ response.length }} 点</span>
          </div>
        </div>
      </div>

      <!-- 步骤 2: 确定性分析 + 可选 AI 解释 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">2</div>
          <div class="step-title">确定性分析 + AI 解释</div>
        </div>
        <div class="step-body">
          <div class="action-row">
            <button class="btn-ai" :disabled="analyzing || response.length < 5" @click="analyzeResponse">
              <el-icon size="13"><DataAnalysis /></el-icon>
              <span>{{ analyzing ? '分析中...' : '分析响应并生成候选' }}</span>
            </button>
            <button class="btn-secondary" @click="clearAll">清空</button>
          </div>
          <div v-if="error" class="error-msg">{{ error }}</div>
          <div v-if="deterministicMetrics?.valid" class="metric-strip">
            <div><span>超调率</span><strong>{{ deterministicMetrics.overshoot }}%</strong></div>
            <div><span>上升时间</span><strong>{{ deterministicMetrics.riseTime ?? '--' }}s</strong></div>
            <div><span>稳定时间</span><strong>{{ deterministicMetrics.settlingTime ?? '未收敛' }}</strong></div>
            <div><span>均方根误差</span><strong>{{ deterministicMetrics.rmse }}</strong></div>
          </div>
          <ul v-if="localReasons.length" class="reason-list">
            <li v-for="reason in localReasons" :key="reason">{{ reason }}</li>
          </ul>
          <div v-if="aiResult" class="ai-result">
            <div class="result-label">AI 结构化解释（可选，不参与参数下发）：</div>
            <pre>{{ aiResult }}</pre>
          </div>
        </div>
      </div>

      <!-- 步骤 3: PID 候选与参数下发 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">3</div>
          <div class="step-title">PID 候选与参数下发</div>
        </div>
        <div class="step-body">
          <div class="param-grid">
            <div class="field">
              <label>Kp</label>
              <el-input v-model="outputParams.kp" size="small" placeholder="比例系数" />
            </div>
            <div class="field">
              <label>Ki</label>
              <el-input v-model="outputParams.ki" size="small" placeholder="积分系数" />
            </div>
            <div class="field">
              <label>Kd</label>
              <el-input v-model="outputParams.kd" size="small" placeholder="微分系数" />
            </div>
          </div>
          <div class="action-row">
            <button class="btn-primary" :disabled="!connected" @click="sendParams">
              <el-icon size="13"><Promotion /></el-icon>
              <span>下发 PID 参数</span>
            </button>
            <button class="btn-secondary" @click="exportEmbeddedController">导出 .c / .h</button>
            <span class="safety-note">边界：Kp 0~20，Ki/Kd 0~10；点击后仍需二次确认。</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pid-panel {
  display: flex;
  height: 100%;
  color: var(--color-text-primary);
  overflow-y: auto;
  padding: var(--space-4);
}

.pid-content {
  max-width: 1040px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.step-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.step-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border-default);
  background: var(--color-bg-tertiary);
}

.step-number {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-ai);
  color: var(--color-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: 700;
  flex-shrink: 0;
}

.step-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.step-body {
  padding: var(--space-4);
}

.param-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.data-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
}

.error-msg {
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: rgba(248, 81, 73, 0.08);
  border: 1px solid rgba(248, 81, 73, 0.2);
  border-radius: var(--radius-sm);
  color: var(--state-error);
  font-size: var(--text-xs);
}

.ai-result {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-ai);
  border-radius: var(--radius-sm);
}

.result-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-ai);
  margin-bottom: var(--space-1);
}

.ai-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(150px, 1fr));
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.model-grid :deep(.el-input-number) {
  width: 100%;
}

.subsection-title {
  margin: var(--space-3) 0 var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: 600;
}

.strategy-note {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.strategy-note strong {
  color: var(--color-ai);
}

.formula {
  margin-top: calc(-1 * var(--space-2));
  padding: 7px 10px;
  border-left: 3px solid var(--color-primary);
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
}

.order-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.order-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.order-item button {
  width: 22px;
  height: 22px;
  border: 1px solid var(--color-border-default);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.order-item button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.metric-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.metric-strip div {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
}

.metric-strip span {
  display: block;
  color: var(--color-text-tertiary);
  font-size: 10px;
}

.metric-strip strong {
  display: block;
  margin-top: 3px;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
}

.reason-list {
  margin: var(--space-2) 0 0;
  padding-left: 18px;
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  line-height: 1.7;
}

.safety-note {
  color: var(--color-text-tertiary);
  font-size: 10px;
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 4px;
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

.btn-ai {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-ai);
  border-radius: var(--radius-sm);
  background: var(--color-ai-muted);
  color: var(--color-ai);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-ai:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--state-error);
  color: var(--color-text-inverse);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
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

@media (max-width: 900px) {
  .model-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
