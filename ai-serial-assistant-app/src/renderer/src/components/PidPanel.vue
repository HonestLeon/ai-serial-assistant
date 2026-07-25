<script setup>
import { computed, ref, reactive, onUnmounted, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Promotion, VideoPlay, VideoPause, DataAnalysis, Refresh } from '@element-plus/icons-vue'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  historyToPromptText
} from '../services/controlAnalysis.mjs'
import {
  applyPidGuardrails,
  buildFallbackSuggestion,
  isMetricsAcceptable,
  maybeUpdateBestResult,
  scoreMetrics,
  shouldRollbackToBest
} from '../services/pidSafety.mjs'
import {
  FEEDFORWARD_GROUPS,
  FEEDFORWARD_ITEMS_BY_ID,
  PID_STRATEGIES,
  formatFeedforwardMask,
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
// 前馈勾选状态：{ itemId: coefficient }。空对象表示纯 PID
const feedforwardSelection = reactive({})
const simulationStatus = ref('')

const strategy = computed(() => PID_STRATEGIES[strategyId.value])
const strategyOptions = computed(() => Object.values(PID_STRATEGIES))
// 每栏已勾选的 item id 列表，用于 el-select multiple 双向绑定
const feedforwardSelectedByGroup = reactive(
  Object.fromEntries(FEEDFORWARD_GROUPS.map((g) => [g.id, []]))
)
const feedforwardFormulaText = computed(() => {
  const ids = Object.keys(feedforwardSelection)
  if (!ids.length) return 'u = PID(error)'
  const parts = ids.map((id) => FEEDFORWARD_ITEMS_BY_ID[id]?.formula).filter(Boolean)
  return `u = PID(error) + ${parts.join(' + ')}`
})
// 前馈掩码（C 字面量，如 0x0041u）：由勾选项生成，写入导出的 .h；也可手动复制到已有工程头文件
const feedforwardMaskLiteral = computed(() => formatFeedforwardMask(feedforwardSelection))

function copyFeedforwardMask() {
  navigator.clipboard?.writeText(feedforwardMaskLiteral.value).then(
    () => { simulationStatus.value = `已复制前馈掩码 ${feedforwardMaskLiteral.value} 到剪贴板` },
    () => { simulationStatus.value = '复制失败，请手动选中掩码文本复制' }
  )
}
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
  channel: 1,
  outputChannel: -1
})

const outputParams = reactive({
  kp: '1.8',
  ki: '0.22',
  kd: '0.12',
  // 串级策略额外使用
  speedKp: '2',
  speedKi: '4',
  speedKd: '0.01'
})

const isCascade = computed(() => strategyId.value === 'cascade_position')

const collecting = ref(false)
const analyzing = ref(false)
const response = ref([])
const aiResult = ref('')
const aiParams = ref(null)   // AI 给出的新参数（解析后），用于展示
const autoSend = ref(false)  // 自动下发：AI 给参后直接写入设备，无需人工确认
const deterministicMetrics = ref(null)
const localReasons = ref([])
const error = ref('')

// 调参历史（借鉴 llm-pid-tuner）：每轮 { round, pid, metrics, analysis, thought }
// 用作 LLM 上下文，让 AI 借鉴历史、避免重复无效方向
const tuningHistory = ref([])
// 自动调参循环状态
const autoTuning = ref(false)
const autoTuneRound = ref(0)
const autoTuneStatus = ref('')
let bestResult = null        // { pid, metrics, score, round }
let autoTuneCancel = false
const AUTO_TUNE_MAX_ROUNDS = 20
const AUTO_TUNE_REQUIRED_STABLE = 2  // 连续达标轮数

// 仿真运行状态：'idle' | 'running' | 'paused'
const simRunState = ref('idle')
let simTimer = null
let simFullSamples = []   // 一次性算出的完整样本
let simCursor = 0          // 当前已推送到 response 的样本索引
const SIM_STEP_MS = 30     // 推送间隔（约 33fps）
const SIM_BATCH = 1        // 每次推送的样本数

let collectTimer = null
let firstResponseTime = null

// 前馈勾选变更：增删 feedforwardSelection 中的项；勾选时写入默认系数
function onFeedforwardGroupChange(groupId) {
  const selectedIds = feedforwardSelectedByGroup[groupId]
  const group = FEEDFORWARD_GROUPS.find((g) => g.id === groupId)
  if (!group) return
  // 先移除本组中已取消勾选的项
  Object.keys(feedforwardSelection).forEach((id) => {
    if (group.items.some((it) => it.id === id) && !selectedIds.includes(id)) {
      delete feedforwardSelection[id]
    }
  })
  // 再补上新增的勾选项（用默认系数）
  selectedIds.forEach((id) => {
    if (!(id in feedforwardSelection)) {
      const item = FEEDFORWARD_ITEMS_BY_ID[id]
      feedforwardSelection[id] = item ? item.defaultCoeff : 0
    }
  })
}

function clearFeedforward() {
  Object.keys(feedforwardSelection).forEach((id) => delete feedforwardSelection[id])
  FEEDFORWARD_GROUPS.forEach((g) => { feedforwardSelectedByGroup[g.id] = [] })
}

function applyStrategyDefaults() {
  Object.keys(simulationConfig).forEach((key) => delete simulationConfig[key])
  Object.assign(simulationConfig, getStrategyConfig(strategyId.value))
  tuningOrder.value = [...strategy.value.defaultOrder]
  if (strategyId.value === 'cascade_position') {
    outputParams.kp = String(simulationConfig.positionKp)
    outputParams.ki = String(simulationConfig.positionKi)
    outputParams.kd = String(simulationConfig.positionKd)
    outputParams.speedKp = String(simulationConfig.speedKp)
    outputParams.speedKi = String(simulationConfig.speedKi)
    outputParams.speedKd = String(simulationConfig.speedKd)
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

// 仿真按钮：运行中点按→暂停；暂停中点按→继续；空闲点按→从头开始
function runSimulation() {
  if (simRunState.value === 'running') {
    pauseSimulation()
    return
  }
  if (simRunState.value === 'paused') {
    resumeSimulation()
    return
  }
  startSimulation()
}

function buildSimOverrides() {
  const overrides = { ...simulationConfig, feedforwardSelection: { ...feedforwardSelection } }
  if (strategyId.value === 'cascade_position') {
    overrides.positionKp = Number(outputParams.kp)
    overrides.positionKi = Number(outputParams.ki)
    overrides.positionKd = Number(outputParams.kd)
    overrides.speedKp = Number(outputParams.speedKp)
    overrides.speedKi = Number(outputParams.speedKi)
    overrides.speedKd = Number(outputParams.speedKd)
  } else {
    overrides.kp = Number(outputParams.kp)
    overrides.ki = Number(outputParams.ki)
    overrides.kd = Number(outputParams.kd)
  }
  return overrides
}

function startSimulation() {
  error.value = ''
  const overrides = buildSimOverrides()
  const result = simulatePidStrategy(strategyId.value, overrides)
  simFullSamples = result.samples
  simCursor = 0
  response.value = []
  deterministicMetrics.value = null
  localReasons.value = []
  simRunState.value = 'running'
  simulationStatus.value = '仿真运行中…'
  simTimer = setInterval(pushSimBatch, SIM_STEP_MS)
}

function pushSimBatch() {
  if (simCursor >= simFullSamples.length) {
    finishSimulation()
    return
  }
  const next = simFullSamples.slice(simCursor, simCursor + SIM_BATCH)
  response.value = response.value.concat(next)
  emit('simulation-data', response.value)
  simCursor += next.length
  simulationStatus.value = `仿真运行中… ${simCursor}/${simFullSamples.length}`
}

function pauseSimulation() {
  if (simTimer) {
    clearInterval(simTimer)
    simTimer = null
  }
  simRunState.value = 'paused'
  simulationStatus.value = `已暂停（${simCursor}/${simFullSamples.length}）`
}

function resumeSimulation() {
  simRunState.value = 'running'
  simulationStatus.value = '仿真运行中…'
  simTimer = setInterval(pushSimBatch, SIM_STEP_MS)
}

function finishSimulation() {
  if (simTimer) {
    clearInterval(simTimer)
    simTimer = null
  }
  simRunState.value = 'idle'
  simulationStatus.value = `仿真完成：${simFullSamples.length} 点；反馈已叠加可复现的小幅噪声`
  analyzeResponse()
}

function stopSimulation() {
  if (simTimer) {
    clearInterval(simTimer)
    simTimer = null
  }
  simRunState.value = 'idle'
  simFullSamples = []
  simCursor = 0
  simulationStatus.value = '已停止'
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
    feedforwardSelection: { ...feedforwardSelection }
  })
  downloadText(files.header.filename, files.header.content)
  setTimeout(() => downloadText(files.source.filename, files.source.content), 120)
  simulationStatus.value = `已生成 ${files.header.filename} 与 ${files.source.filename}（通信层；前馈掩码 ${feedforwardMaskLiteral.value} 已写入 .h）`
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
    // output 通道：-1 表示不采集，output 记为 0；否则读取对应通道
    const output = stepConfig.outputChannel >= 0 && nums.length > stepConfig.outputChannel
      ? parseFloat(nums[stepConfig.outputChannel])
      : 0
    const timestamp = Number(payload.time) || Date.now()
    if (firstResponseTime === null) {
      firstResponseTime = timestamp
      response.value.push({ t: 0, target: 0, feedback, output })
    }
    response.value.push({
      t: Math.max(0.001, (timestamp - firstResponseTime) / 1000),
      target: Number(stepConfig.amplitude),
      feedback,
      output
    })
  }
}

// AI 参数安全边界（与 sendParams 一致）
const PARAM_BOUNDS = { kp: 20, ki: 10, kd: 10, speedKp: 20, speedKi: 10, speedKd: 10, positionKp: 20, positionKi: 10, positionKd: 10 }

// 从 AI 文本响应中解析 JSON 参数；解析或越界失败返回 null
function parseAiParams(text, cascade) {
  if (!text) return null
  let s = String(text).trim().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first < 0 || last < 0 || last <= first) return null
  let obj
  try { obj = JSON.parse(s.slice(first, last + 1)) } catch { return null }
  const keys = cascade
    ? ['speedKp', 'speedKi', 'speedKd', 'positionKp', 'positionKi', 'positionKd']
    : ['kp', 'ki', 'kd']
  const out = {}
  for (const k of keys) {
    const v = Number(obj[k])
    if (!Number.isFinite(v)) return null
    out[k] = Math.min(PARAM_BOUNDS[k], Math.max(0, v))
  }
  // thought 字段可选，限 200 字
  if (typeof obj.thought === 'string') out.thought = obj.thought.slice(0, 200)
  return out
}

function formatParamsForDisplay(params, cascade) {
  if (!params) return ''
  if (cascade) {
    return `速度环 Kp=${params.speedKp}, Ki=${params.speedKi}, Kd=${params.speedKd}；位置环 Kp=${params.positionKp}, Ki=${params.positionKi}, Kd=${params.positionKd}`
  }
  return `Kp=${params.kp}, Ki=${params.ki}, Kd=${params.kd}`
}

async function analyzeResponse() {
  if (response.value.length < 5) {
    error.value = '采集数据不足，请先执行阶跃测试'
    return false
  }

  error.value = ''
  analyzing.value = true
  aiResult.value = ''
  aiParams.value = null
  deterministicMetrics.value = analyzeControlSamples(response.value, {
    ...strategy.value.acceptance
  })
  if (!deterministicMetrics.value.valid) {
    error.value = deterministicMetrics.value.reason
    analyzing.value = false
    return false
  }

  // 确定性算法先给出有界候选作为基线（无 AI Key 或 AI 失败时回退到此）
  const candidate = buildPidSuggestion(deterministicMetrics.value, outputParams, { tuningOrder: tuningOrder.value })
  Object.keys(candidate).forEach((key) => {
    if (key in outputParams) outputParams[key] = String(candidate[key])
  })
  localReasons.value = candidate.reasons

  if (!props.aiConfig.apiKey) {
    aiResult.value = '已完成本地确定性分析。未配置 AI API Key，候选参数（确定性算法）已填入下方。'
    analyzing.value = false
    return false
  }

  // 调用 AI 给出新参数（含历史上下文 + 5 次指数退避重试 + 安全护栏）
  const result = await callAiForPid(deterministicMetrics.value, { thought: '' })
  analyzing.value = false
  if (!result.ok) {
    // AI 失败：用保底策略生成候选，保证流程不中断
    const fallback = buildFallbackSuggestion(deterministicMetrics.value, outputParams)
    Object.keys(fallback.params).forEach((key) => {
      if (key in outputParams) outputParams[key] = String(fallback.params[key])
    })
    aiResult.value = `AI 调用失败（${result.error}），已用保底策略：${fallback.reason}。参数已填入下方。`
    return false
  }

  // AI 给出的参数填入候选（覆盖确定性基线）
  aiParams.value = result.params
  Object.keys(result.params).forEach((key) => {
    if (key in outputParams) outputParams[key] = String(result.params[key])
  })
  aiResult.value = `AI 已给出新参数并填入下方候选：${formatParamsForDisplay(result.params, isCascade.value)}`
  if (result.guardNotes.length) {
    aiResult.value += `\n安全护栏：${result.guardNotes.join('；')}`
  }

  // 自动下发：已连接串口时直接写入设备，无需人工确认
  if (autoSend.value && props.connected) {
    await sendParams()
  }
  return true
}

/**
 * 调用 AI 给出新 PID 参数（核心逻辑，被 analyzeResponse 与自动调参循环复用）。
 * 包含：历史上下文打包 + 5 次指数退避重试 + 严格 JSON 解析 + 安全护栏裁剪。
 * @returns {Promise<{ok:boolean, params?:object, thought?:string, guardNotes?:string[], error?:string}>}
 */
async function callAiForPid(metrics, options = {}) {
  const cascade = isCascade.value
  const formatSpec = cascade
    ? '{"speedKp":<0-20>,"speedKi":<0-10>,"speedKd":<0-10>,"positionKp":<0-20>,"positionKi":<0-10>,"positionKd":<0-10>,"thought":"<简短思考>"}'
    : '{"kp":<0-20>,"ki":<0-10>,"kd":<0-10>,"thought":"<简短思考>"}'
  const currentParams = cascade
    ? { speedKp: outputParams.speedKp, speedKi: outputParams.speedKi, speedKd: outputParams.speedKd, positionKp: outputParams.kp, positionKi: outputParams.ki, positionKd: outputParams.kd }
    : { kp: outputParams.kp, ki: outputParams.ki, kd: outputParams.kd }
  const historyText = historyToPromptText(tuningHistory.value, 5)
  const userContent = JSON.stringify({
    任务: '根据响应指标、当前参数和调参历史，给出新的 PID 参数。只输出一个 JSON 对象，禁止任何解释、Markdown 或额外文字。',
    输出格式: formatSpec,
    当前参数: currentParams,
    响应指标: {
      状态: metrics.status,
      超调率: metrics.overshoot,
      上升时间: metrics.riseTime,
      稳定时间: metrics.settlingTime,
      稳态误差: metrics.steadyError,
      均方根误差: metrics.rmse,
      振荡: metrics.oscillation,
      采样点数: metrics.sampleCount
    },
    调参历史: historyText || '（暂无历史，这是第一轮）',
    场景: testMode.value === 'simulation'
      ? `仿真测试；模型：${strategy.value.description}`
      : `真实串口阶跃测试；阶跃幅值 ${stepConfig.amplitude}`,
    安全要求: '参数必须循序渐进，单步增幅不得超过 3 倍。借鉴历史中的 AI 思考，避免重复无效方向。'
  }, null, 2)

  const systemContent = `你是 PID 调参助手。只输出一个 JSON 对象表示新参数，禁止输出任何解释、说明、Markdown 代码块或额外文字。输出格式：${formatSpec}。所有数值必须在给定范围内。必须仔细阅读"调参历史"字段，避免重复无效方向。thought 字段限 100 字内简述调整思路。`

  // 5 次指数退避重试
  const delays = [0, 2, 4, 8, 16]
  let lastError = ''
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt] * 1000))
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
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent }
          ],
          stream: false
        })
      })
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue }
      const data2 = await res.json()
      const raw = data2.choices?.[0]?.message?.content || ''
      const parsed = parseAiParams(raw, cascade)
      if (!parsed) { lastError = '返回格式无法解析'; continue }
      // 安全护栏裁剪（单步增幅限制 + 边界）
      const guard = applyPidGuardrails(currentParams, parsed)
      return {
        ok: true,
        params: guard.params,
        thought: parsed.thought || '',
        guardNotes: guard.notes
      }
    } catch (e) {
      lastError = e.message || String(e)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * 自动调参循环（借鉴 llm-pid-tuner 的 _run_tuning_loop）。
 * 仅在仿真模式下可用：每轮 仿真→分析→AI→应用→记录历史，直到达标或达上限。
 * 终止条件：① 指标达标且连续 AUTO_TUNE_REQUIRED_STABLE 轮稳定 ② 超过 AUTO_TUNE_MAX_ROUNDS ③ 用户取消
 * 安全机制：仅在 STABLE 时更新最佳；劣化时自动回退到最佳参数。
 */
async function runAutoTuning() {
  if (testMode.value !== 'simulation') {
    error.value = '自动调参仅在仿真模式下可用'
    return
  }
  if (autoTuning.value) return
  if (!props.aiConfig.apiKey) {
    error.value = '请先配置 AI API Key'
    return
  }
  // 风险提示
  try {
    await ElMessageBox.confirm(
      '自动调参将在仿真模式下连续多轮调用 AI 调整 PID 参数。\n\n' +
      '说明：\n• 最多 ' + AUTO_TUNE_MAX_ROUNDS + ' 轮，达标后提前结束\n' +
      '• 仅在 STABLE 时记录最佳参数\n' +
      '• 检测到劣化时自动回退到最佳参数\n' +
      '• 每轮参数与指标会写入调参历史\n\n' +
      '确定开始自动调参吗？',
      '自动调参',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'info' }
    )
  } catch {
    return
  }

  autoTuning.value = true
  autoTuneCancel = false
  bestResult = null
  let consecutiveStable = 0
  const t0 = Date.now()

  try {
    for (let round = 1; round <= AUTO_TUNE_MAX_ROUNDS; round += 1) {
      if (autoTuneCancel) {
        autoTuneStatus.value = `已取消（完成 ${round - 1} 轮）`
        break
      }
      autoTuneRound.value = round
      autoTuneStatus.value = `第 ${round}/${AUTO_TUNE_MAX_ROUNDS} 轮：运行仿真…`

      // 1. 同步运行仿真（一次性算完，不走 setInterval，避免循环与定时器交织）
      const overrides = buildSimOverrides()
      const result = simulatePidStrategy(strategyId.value, overrides)
      response.value = result.samples
      emit('simulation-data', response.value)
      await new Promise((r) => setTimeout(r, 50))  // 让 UI 刷新

      // 2. 分析指标
      const metrics = analyzeControlSamples(response.value, { ...strategy.value.acceptance })
      if (!metrics.valid) {
        autoTuneStatus.value = `第 ${round} 轮：数据无效，终止`
        break
      }
      deterministicMetrics.value = metrics

      // 3. 记录当前轮的"参数+指标"快照（用于历史与最佳比较）
      const currentPid = isCascade.value
        ? { speedKp: Number(outputParams.speedKp), speedKi: Number(outputParams.speedKi), speedKd: Number(outputParams.speedKd), positionKp: Number(outputParams.kp), positionKi: Number(outputParams.ki), positionKd: Number(outputParams.kd) }
        : { kp: Number(outputParams.kp), ki: Number(outputParams.ki), kd: Number(outputParams.kd) }

      // 4. 最佳记录 + 劣化回退判定（在调 AI 之前，先看本轮效果）
      bestResult = maybeUpdateBestResult(bestResult, { pid: currentPid, metrics, round })
      const rollback = shouldRollbackToBest(bestResult, metrics)
      if (rollback.shouldRollback && bestResult) {
        autoTuneStatus.value = `第 ${round} 轮：${rollback.reason}，已回退`
        Object.keys(bestResult.pid).forEach((k) => {
          if (k in outputParams) outputParams[k] = String(bestResult.pid[k])
        })
        tuningHistory.value.push({
          round, pid: currentPid, metrics, analysis: rollback.reason, thought: '自动回退'
        })
        await new Promise((r) => setTimeout(r, 200))
        continue
      }

      // 5. 终止条件①：指标达标且连续稳定
      const acceptable = isMetricsAcceptable(metrics, {
        rmseLimit: Math.abs(metrics.stepSize) * 0.05,
        steadyErrorLimit: Math.abs(metrics.stepSize) * 0.02,
        overshootLimit: strategy.value.acceptance.overshootLimit
      })
      if (acceptable.done) {
        consecutiveStable += 1
        if (consecutiveStable >= AUTO_TUNE_REQUIRED_STABLE) {
          autoTuneStatus.value = `第 ${round} 轮：连续 ${consecutiveStable} 轮达标，自动调参完成（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
          tuningHistory.value.push({
            round, pid: currentPid, metrics, analysis: acceptable.reason, thought: '已达标'
          })
          break
        }
      } else {
        consecutiveStable = 0
      }

      // 6. 调用 AI 给新参数
      autoTuneStatus.value = `第 ${round}/${AUTO_TUNE_MAX_ROUNDS} 轮：调用 AI…`
      const aiResult = await callAiForPid(metrics)
      let thought = ''
      let analysis = ''
      if (aiResult.ok) {
        Object.keys(aiResult.params).forEach((k) => {
          if (k in outputParams) outputParams[k] = String(aiResult.params[k])
        })
        thought = aiResult.thought || ''
        analysis = formatParamsForDisplay(aiResult.params, isCascade.value)
        if (aiResult.guardNotes.length) analysis += `（护栏：${aiResult.guardNotes.join('；')}）`
      } else {
        // AI 失败：保底策略
        const fallback = buildFallbackSuggestion(metrics, outputParams)
        Object.keys(fallback.params).forEach((k) => {
          if (k in outputParams) outputParams[k] = String(fallback.params[k])
        })
        thought = `AI失败: ${aiResult.error}`
        analysis = `保底：${fallback.reason}`
      }
      tuningHistory.value.push({ round, pid: currentPid, metrics, analysis, thought })
      autoTuneStatus.value = `第 ${round} 轮完成：${analysis}`
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!autoTuneCancel && autoTuneStatus.value.startsWith('第')) {
      // 循环正常结束但未达标
    }
  } finally {
    autoTuning.value = false
  }
}

function cancelAutoTuning() {
  autoTuneCancel = true
}

async function onAutoSendChange(val) {
  if (!val) return
  try {
    await ElMessageBox.confirm(
      '自动下发会将 AI 给出的参数直接写入设备，无需人工确认。\n\n风险提示：\n• AI 参数可能不稳定，可能导致设备失控、超速、过流或损坏\n• 网络异常或模型异常时可能下发错误参数\n• 建议先在仿真模式验证，并在安全工况、做好急停准备的前提下使用\n\n确定开启自动下发吗？',
      '自动下发风险警告',
      { confirmButtonText: '我已知晓风险，开启', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    autoSend.value = false
  }
}

async function sendParams() {
  // 仿真模式：不下发硬件，仅把 outputParams 确认为仿真所用参数（buildSimOverrides 会读取）。
  // 这样构成“调参 → 下发（确认）→ 运行仿真 → 再调参”的闭环。
  const isSimulation = testMode.value === 'simulation'
  if (!isSimulation && !props.connected) {
    error.value = '请先连接串口'
    return
  }
  error.value = ''
  const cascade = isCascade.value
  const values = cascade
    ? {
        speedKp: Number(outputParams.speedKp),
        speedKi: Number(outputParams.speedKi),
        speedKd: Number(outputParams.speedKd),
        positionKp: Number(outputParams.kp),
        positionKi: Number(outputParams.ki),
        positionKd: Number(outputParams.kd)
      }
    : {
        kp: Number(outputParams.kp),
        ki: Number(outputParams.ki),
        kd: Number(outputParams.kd)
      }
  const allFinite = Object.values(values).every(Number.isFinite)
  if (!allFinite) {
    error.value = 'PID 参数必须是有效数字'
    return
  }
  const outOfBounds = Object.entries(values).some(([key, v]) => {
    const max = key.startsWith('kp') || key.endsWith('Kp') ? 20 : 10
    return v < 0 || v > max
  })
  if (outOfBounds) {
    error.value = '参数超出 MVP 安全边界：Kp 0~20，Ki 0~10，Kd 0~10'
    return
  }
  // 仿真模式：同步回 simulationConfig 并提示，跳过串口下发与人工确认
  if (isSimulation) {
    if (cascade) {
      simulationConfig.positionKp = values.positionKp
      simulationConfig.positionKi = values.positionKi
      simulationConfig.positionKd = values.positionKd
      simulationConfig.speedKp = values.speedKp
      simulationConfig.speedKi = values.speedKi
      simulationConfig.speedKd = values.speedKd
    } else {
      simulationConfig.kp = values.kp
      simulationConfig.ki = values.ki
      simulationConfig.kd = values.kd
    }
    const cmdPreview = cascade
      ? `PID ${values.speedKp} ${values.speedKi} ${values.speedKd} ${values.positionKp} ${values.positionKi} ${values.positionKd}`
      : `PID ${values.kp} ${values.ki} ${values.kd}`
    error.value = `已应用至仿真：${cmdPreview}（点击“运行仿真”验证）`
    return
  }
  const cmdParts = cascade
    ? ['PID', values.speedKp, values.speedKi, values.speedKd, values.positionKp, values.positionKi, values.positionKd]
    : ['PID', values.kp, values.ki, values.kd]
  const cmd = cmdParts.join(' ')
  // 自动下发模式跳过人工确认；否则需二次确认
  if (!autoSend.value) {
    const confirmMsg = cascade
      ? `即将下发串级 PID（速度环 ${values.speedKp} ${values.speedKi} ${values.speedKd}，位置环 ${values.positionKp} ${values.positionKi} ${values.positionKd}）。请确认设备已处于安全工况，并已记录原参数以便回退。`
      : `即将下发 PID ${values.kp} ${values.ki} ${values.kd}。请确认设备已处于安全工况，并已记录原参数以便回退。`
    try {
      await ElMessageBox.confirm(confirmMsg, '人工确认后下发', {
        confirmButtonText: '确认下发',
        cancelButtonText: '取消',
        type: 'warning'
      })
    } catch {
      error.value = '已取消下发，设备参数未改变'
      return
    }
  }
  try {
    await window.electronAPI.serial.send(cmd, 'utf8')
    emit('send', cmd.length)
    error.value = `已下发: ${cmd}`
  } catch (e) {
    error.value = `下发失败: ${e.message || e}`
  }
}

function clearAll() {
  stopSimulation()
  response.value = []
  aiResult.value = ''
  aiParams.value = null
  deterministicMetrics.value = null
  localReasons.value = []
  error.value = ''
  firstResponseTime = null
  tuningHistory.value = []
  bestResult = null
  autoTuneRound.value = 0
  autoTuneStatus.value = ''
  outputParams.kp = '1.0'
  outputParams.ki = '1.5'
  outputParams.kd = '0.015'
  outputParams.speedKp = '1.0'
  outputParams.speedKi = '1.5'
  outputParams.speedKd = '0.015'
  clearFeedforward()
}

// 监听父组件传来的数据（兼容真实串口和模拟数据）
watch(() => props.latestPayload, (payload) => {
  if (payload) onSerialData(payload)
})

onUnmounted(() => {
  stopCollection()
  stopSimulation()
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
              <button
                class="btn-primary"
                :class="{ 'btn-running': simRunState === 'running', 'btn-paused': simRunState === 'paused' }"
                @click="runSimulation"
              >
                <el-icon size="13">
                  <VideoPause v-if="simRunState === 'running'" />
                  <VideoPlay v-else />
                </el-icon>
                <span>{{ simRunState === 'running' ? '暂停' : (simRunState === 'paused' ? '继续' : '运行仿真并分析') }}</span>
              </button>
              <button
                v-if="simRunState !== 'idle'"
                class="btn-secondary"
                @click="stopSimulation"
              >停止</button>
              <button class="btn-secondary" @click="applyStrategyDefaults">恢复默认模型</button>
              <button
                v-if="!autoTuning"
                class="btn-primary btn-auto-tune"
                :disabled="testMode !== 'simulation' || !aiConfig.apiKey || simRunState !== 'idle'"
                @click="runAutoTuning"
              >
                <el-icon size="13"><Refresh /></el-icon>
                <span>自动调参</span>
              </button>
              <button
                v-else
                class="btn-secondary btn-auto-tune-cancel"
                @click="cancelAutoTuning"
              >取消自动调参</button>
              <span class="data-count">{{ autoTuning ? autoTuneStatus : simulationStatus }}</span>
            </div>
          </template>

          <div class="subsection-title">前馈项（多选，可跨栏组合；不勾选即纯 PID）</div>
          <div class="ff-groups">
            <div v-for="group in FEEDFORWARD_GROUPS" :key="group.id" class="ff-group">
              <label class="ff-group-label">{{ group.label }}</label>
              <el-select
                v-model="feedforwardSelectedByGroup[group.id]"
                multiple
                collapse-tags
                collapse-tags-tooltip
                size="small"
                placeholder="点击勾选"
                @change="onFeedforwardGroupChange(group.id)"
              >
                <el-option
                  v-for="item in group.items"
                  :key="item.id"
                  :label="item.name"
                  :value="item.id"
                />
              </el-select>
            </div>
          </div>
          <div v-if="Object.keys(feedforwardSelection).length" class="ff-coeffs">
            <div v-for="(coeff, id) in feedforwardSelection" :key="id" class="field ff-coeff-field">
              <label>{{ FEEDFORWARD_ITEMS_BY_ID[id]?.name || id }} · 系数</label>
              <el-input-number
                v-model="feedforwardSelection[id]"
                size="small"
                :controls="false"
                :step="0.01"
              />
            </div>
          </div>
          <div class="formula">{{ feedforwardFormulaText }}</div>
          <div class="ff-mask-row">
            <span class="ff-mask-label">前馈掩码（已自动写入导出的 .h；如需手动粘贴到已有工程可复制）：</span>
            <code class="ff-mask-value">{{ feedforwardMaskLiteral }}</code>
            <button class="btn-secondary btn-mini" @click="copyFeedforwardMask">复制</button>
          </div>

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
              <label>反馈采集通道</label>
              <el-select v-model="stepConfig.channel" size="small" :disabled="collecting">
                <el-option v-for="i in 8" :key="i - 1" :label="`I${i - 1}`" :value="i - 1" />
              </el-select>
            </div>
            <div class="field">
              <label>控制量采集通道</label>
              <el-select v-model="stepConfig.outputChannel" size="small" :disabled="collecting">
                <el-option label="不采集（记为 0）" :value="-1" />
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
            <div class="step-title">确定性分析 + AI 给参</div>
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
            <div><span>状态</span><strong>{{ deterministicMetrics.status }}</strong></div>
            <div><span>超调率</span><strong>{{ deterministicMetrics.overshoot }}%</strong></div>
            <div><span>上升时间</span><strong>{{ deterministicMetrics.riseTime ?? '--' }}s</strong></div>
            <div><span>稳定时间</span><strong>{{ deterministicMetrics.settlingTime ?? '未收敛' }}</strong></div>
            <div><span>均方根误差</span><strong>{{ deterministicMetrics.rmse }}</strong></div>
          </div>
          <ul v-if="localReasons.length" class="reason-list">
            <li v-for="reason in localReasons" :key="reason">{{ reason }}</li>
          </ul>
          <div v-if="aiResult" class="ai-result">
            <div class="result-label">AI 结果（参数已自动填入下方"PID 候选与参数下发"）：</div>
            <pre>{{ aiResult }}</pre>
          </div>
          <details v-if="tuningHistory.length" class="history-details">
            <summary>调参历史（{{ tuningHistory.length }} 轮）</summary>
            <div class="history-list">
              <div v-for="h in tuningHistory.slice(-10)" :key="h.round" class="history-item">
                <div class="history-round">Round {{ h.round }} · {{ h.metrics?.status || '--' }}</div>
                <div class="history-pid">{{ h.pid ? Object.entries(h.pid).map(([k,v]) => `${k}=${v}`).join(', ') : '' }}</div>
                <div class="history-metric">rmse={{ h.metrics?.rmse }}, 超调={{ h.metrics?.overshoot }}%, 稳态误差={{ h.metrics?.steadyError }}</div>
                <div v-if="h.thought" class="history-thought">思考：{{ h.thought }}</div>
                <div v-if="h.analysis" class="history-analysis">{{ h.analysis }}</div>
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- 步骤 3: PID 候选与参数下发 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">3</div>
          <div class="step-title">PID 候选与参数下发</div>
        </div>
        <div class="step-body">
          <template v-if="isCascade">
            <div class="subsection-title">速度环（内环）</div>
            <div class="param-grid">
              <div class="field">
                <label>速度环 Kp</label>
                <el-input v-model="outputParams.speedKp" size="small" placeholder="比例系数" />
              </div>
              <div class="field">
                <label>速度环 Ki</label>
                <el-input v-model="outputParams.speedKi" size="small" placeholder="积分系数" />
              </div>
              <div class="field">
                <label>速度环 Kd</label>
                <el-input v-model="outputParams.speedKd" size="small" placeholder="微分系数" />
              </div>
            </div>
            <div class="subsection-title">位置环（外环）</div>
            <div class="param-grid">
              <div class="field">
                <label>位置环 Kp</label>
                <el-input v-model="outputParams.kp" size="small" placeholder="比例系数" />
              </div>
              <div class="field">
                <label>位置环 Ki</label>
                <el-input v-model="outputParams.ki" size="small" placeholder="积分系数" />
              </div>
              <div class="field">
                <label>位置环 Kd</label>
                <el-input v-model="outputParams.kd" size="small" placeholder="微分系数" />
              </div>
            </div>
          </template>
          <template v-else>
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
          </template>
          <div class="action-row">
            <button class="btn-primary" :disabled="!connected && testMode !== 'simulation'" @click="sendParams">
              <el-icon size="13"><Promotion /></el-icon>
              <span>{{ testMode === 'simulation' ? '应用至仿真' : '下发 PID 参数' }}</span>
            </button>
            <button class="btn-secondary" @click="exportEmbeddedController">导出 .c / .h</button>
            <el-checkbox v-model="autoSend" class="auto-send-cb" @change="onAutoSendChange">
              自动下发
            </el-checkbox>
            <span class="safety-note">边界：Kp 0~20，Ki/Kd 0~10；{{ autoSend ? '已开启自动下发，无需二次确认。' : '点击后仍需二次确认。' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pid-panel {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-4);
  color: var(--color-text-primary);
}

.pid-content {
  max-width: 1040px;
  width: 100%;
  margin: 0 auto;
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

/* 调参历史折叠区 */
.history-details {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
}
.history-details summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--color-text-secondary);
  user-select: none;
}
.history-list {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.history-item {
  padding: var(--space-2);
  border-left: 2px solid var(--color-border-default);
  background: var(--color-bg-secondary);
  border-radius: 2px;
}
.history-round {
  font-weight: 600;
  color: var(--color-text-primary);
}
.history-pid {
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
  margin-top: 2px;
}
.history-metric {
  color: var(--color-text-tertiary);
  font-size: 10px;
  margin-top: 2px;
}
.history-thought,
.history-analysis {
  color: var(--color-ai);
  margin-top: 2px;
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

/* 前馈三栏勾选 */
.ff-groups {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.ff-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ff-group-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: 600;
}

.ff-coeffs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.ff-coeff-field :deep(.el-input-number) {
  width: 100%;
}

.ff-mask-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-2);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
}

.ff-mask-label {
  color: var(--color-text-tertiary);
}

.ff-mask-value {
  font-family: var(--font-family-mono);
  color: var(--color-text-primary);
  background: var(--color-bg-secondary);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}

.btn-mini {
  padding: 2px 8px;
  font-size: var(--text-xs);
}

.auto-send-cb {
  margin-left: var(--space-1);
  /* el-checkbox 默认有较大右 margin，这里压一下避免撑开行 */
  margin-right: 0;
}
.auto-send-cb :deep(.el-checkbox__label) {
  font-size: var(--text-xs);
  padding-left: 4px;
}

@media (max-width: 720px) {
  .ff-groups {
    grid-template-columns: 1fr;
  }
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

/* 仿真运行中：按钮变红，提示再点按即暂停 */
.btn-primary.btn-running {
  background: var(--color-danger, #e5484d);
}

/* 仿真暂停中：按钮变橙，提示再点按即继续 */
.btn-primary.btn-paused {
  background: var(--color-warning, #f5a623);
}

/* 自动调参按钮：紫色调，与普通仿真按钮区分 */
.btn-primary.btn-auto-tune {
  background: var(--color-ai, #7c5cff);
}
.btn-primary.btn-auto-tune:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary.btn-auto-tune-cancel {
  border-color: var(--color-danger, #e5484d);
  color: var(--color-danger, #e5484d);
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
