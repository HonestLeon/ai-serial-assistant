<script setup>
import { computed, ref, reactive, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading, Promotion, VideoPlay, VideoPause, DataAnalysis, Refresh } from '@element-plus/icons-vue'
import {
  analyzeControlSamples,
  buildFeedforwardSuggestion,
  buildPidSuggestion
} from '../services/controlAnalysis.mjs'
import {
  applyPidGuardrails,
  buildFallbackSuggestion
} from '../services/pidSafety.mjs'
import {
  applyCanonicalPid,
  createTuningSession,
  readCanonicalPid,
  registerTuningRound
} from '../services/pidTuningSession.mjs'
import {
  PID_PROMPT_VERSION,
  buildPidJsonSchema,
  buildPidRepairMessage,
  buildPidSystemPrompt,
  buildStructuredPidHistory,
  buildStructuredResponseFormat,
  downsamplePidWaveform,
  parsePidAiResponse,
  pickSuccessfulPidExamples
} from '../services/pidPrompt.mjs'
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

// 当前参数总览（用于UI显示，便于看清调参过程）
const currentParamsOverview = computed(() => {
  const cascade = isCascade.value
  const pid = cascade
    ? {
        '速度环Kp': outputParams.speedKp,
        '速度环Ki': outputParams.speedKi,
        '速度环Kd': outputParams.speedKd,
        '位置环Kp': outputParams.kp,
        '位置环Ki': outputParams.ki,
        '位置环Kd': outputParams.kd
      }
    : {
        Kp: outputParams.kp,
        Ki: outputParams.ki,
        Kd: outputParams.kd
      }
  const ffItems = Object.entries(feedforwardSelection).map(([id, coeff]) => {
    const item = FEEDFORWARD_ITEMS_BY_ID[id]
    return item ? `${item.name.split(' ')[0]}=${coeff}` : null
  }).filter(Boolean)
  // 推断当前阶段
  const eps = 1e-6
  const pVal = Number(cascade ? outputParams.speedKp : outputParams.kp) || 0
  const iVal = Number(cascade ? outputParams.speedKi : outputParams.ki) || 0
  const dVal = Number(cascade ? outputParams.speedKd : outputParams.kd) || 0
  const phase = (!pVal && !iVal && !dVal) || (pVal > eps && !iVal && !dVal) ? 'P'
    : (pVal > eps && iVal > eps && !dVal) ? 'PI'
    : 'PID'
  // 中文 label → 英文 key 映射，供模板 isParamChanged 调用
  const keyMap = cascade
    ? { '速度环Kp': 'speedKp', '速度环Ki': 'speedKi', '速度环Kd': 'speedKd',
        '位置环Kp': 'kp', '位置环Ki': 'ki', '位置环Kd': 'kd' }
    : { Kp: 'kp', Ki: 'ki', Kd: 'kd' }
  return { pid, ffItems, phase, keyMap }
})

// 参数变化高亮：记录上次参数值，AI 应用后对比并标记变化项
const paramChangeHighlight = reactive({})
let prevParamsSnapshot = null
function snapshotAndHighlightChange() {
  if (prevParamsSnapshot) {
    Object.keys(outputParams).forEach((k) => {
      if (prevParamsSnapshot[k] !== outputParams[k]) {
        paramChangeHighlight[k] = Date.now()
      }
    })
  }
  prevParamsSnapshot = { ...outputParams }
}
// 清除高亮（5秒后自动淡出）
function isParamChanged(key) {
  const t = paramChangeHighlight[key]
  if (!t) return false
  return Date.now() - t < 5000
}

// 复制按钮反馈：复制后临时显示"已复制"，1.2s 后恢复
const copyMaskState = ref('idle')  // idle | copied | failed
function copyFeedforwardMask() {
  navigator.clipboard?.writeText(feedforwardMaskLiteral.value).then(
    () => {
      copyMaskState.value = 'copied'
      ElMessage.success(`已复制 ${feedforwardMaskLiteral.value} 到剪贴板`)
      setTimeout(() => { copyMaskState.value = 'idle' }, 1200)
    },
    () => {
      copyMaskState.value = 'failed'
      ElMessage.error('复制失败，请手动选中掩码文本复制')
      setTimeout(() => { copyMaskState.value = 'idle' }, 1200)
    }
  )
}

// 步骤编号：仿真模式从 1 开始（无阶跃信号步骤），串口模式从 1 开始（含阶跃信号）
const stepNumbers = computed(() => {
  if (testMode.value === 'serial') {
    return { step: 1, analysis: 2, output: 3 }
  }
  return { step: 0, analysis: 1, output: 2 }
})
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

// PID 候选参数：从纯 P 开始（Ki=Kd=0），让分阶段调参策略自动从 P 阶段试探 Kp
// 串级策略的 speedKi/speedKd、positionKi/positionKd 会在 applyStrategyDefaults 中按策略重置
const outputParams = reactive({
  kp: '1.0',
  ki: '0',
  kd: '0',
  // 串级策略额外使用
  speedKp: '1.0',
  speedKi: '0',
  speedKd: '0'
})

// I/D 启用开关：默认开启，关闭后强制 Ki=0 / Kd=0 并禁用对应输入框
// 用户可选择只用 P / PI / PD 控制器（不影响仿真，仅约束调参与下发）
const enableI = ref(true)
const enableD = ref(true)

// 当开关切换时立即同步参数（关闭 → 强制 0；开启 → 保持 0 让策略自行试探）
watch(enableI, (on) => {
  if (!on) {
    outputParams.ki = '0'
    outputParams.speedKi = '0'
  }
})
watch(enableD, (on) => {
  if (!on) {
    outputParams.kd = '0'
    outputParams.speedKd = '0'
  }
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
const autoTuneSettings = reactive({
  engine: 'hybrid',
  maxRounds: 12,
  requiredStable: 2,
  patience: 4
})
let tuningSession = null
let autoTuneCancel = false

// 仿真运行状态：'idle' | 'running' | 'paused'
const simRunState = ref('idle')
const simulationPlaybackRate = ref(5)
let simTimer = null
let simFullSamples = []   // 一次性算出的完整样本
let simCursor = 0          // 当前已推送到 response 的样本索引
const SIM_STEP_MS = 30     // 推送间隔（约 33fps）

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

// PID 参数名集合（用于区分 PID 项与前馈项）
const pidParamNames = computed(() => [...strategy.value.defaultOrder])

/**
 * 重建调参顺序：前馈项默认在前（按勾选顺序），PID 项在后（按策略默认顺序）。
 * 保留用户已调整的相对顺序：已在 tuningOrder 中的项保持原顺序，新增前馈项插到最前。
 * - 前馈项用 id（如 'linear'）表示，PID 项用中文名（如 'Kp'）表示
 * - 调参顺序仅影响 UI 展示与 AI 上下文；buildPidSuggestion 内部按 orderName 匹配，
 *   未匹配的前馈 id 会被自动忽略，不影响 PID 算法
 */
function rebuildTuningOrder() {
  const ffIds = Object.keys(feedforwardSelection)
  const pidNames = pidParamNames.value
  // 当前 tuningOrder 中仍在用的项（前馈仍勾选 + PID 项仍在策略中）
  const keptItems = tuningOrder.value.filter((id) =>
    ffIds.includes(id) || pidNames.includes(id)
  )
  // 新增的前馈项（在 tuningOrder 中不存在）——默认插到最前
  const newFfIds = ffIds.filter((id) => !keptItems.includes(id))
  // 缺失的 PID 项（策略切换后新出现的）——补到末尾
  const missingPid = pidNames.filter((id) => !keptItems.includes(id))
  tuningOrder.value = [...newFfIds, ...keptItems, ...missingPid]
}

// 前馈勾选变化时自动同步调参顺序（新增项默认置顶，取消勾选的项自动移除）
watch(feedforwardSelection, () => {
  rebuildTuningOrder()
}, { deep: true })

// 调参顺序项的显示名：前馈项显示「前馈·<简称>」，PID 项原样显示
function formatTuningOrderItem(item) {
  const ffItem = FEEDFORWARD_ITEMS_BY_ID[item]
  if (ffItem) {
    const shortName = ffItem.name.split(' ')[0]
    return `前馈·${shortName}`
  }
  return item
}

function applyStrategyDefaults() {
  Object.keys(simulationConfig).forEach((key) => delete simulationConfig[key])
  Object.assign(simulationConfig, getStrategyConfig(strategyId.value))
  // 先重置为纯 PID 顺序，再调用 rebuildTuningOrder 把已勾选的前馈项插到前面
  tuningOrder.value = [...strategy.value.defaultOrder]
  rebuildTuningOrder()
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
    // I/D 关闭时强制 0，保证仿真与开关一致
    overrides.positionKi = enableI.value ? Number(outputParams.ki) : 0
    overrides.positionKd = enableD.value ? Number(outputParams.kd) : 0
    overrides.speedKp = Number(outputParams.speedKp)
    overrides.speedKi = enableI.value ? Number(outputParams.speedKi) : 0
    overrides.speedKd = enableD.value ? Number(outputParams.speedKd) : 0
  } else {
    overrides.kp = Number(outputParams.kp)
    overrides.ki = enableI.value ? Number(outputParams.ki) : 0
    overrides.kd = enableD.value ? Number(outputParams.kd) : 0
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
  const dt = Math.max(0.0001, Number(simulationConfig.dt) || 0.01)
  const batchSize = simulationPlaybackRate.value === 0
    ? simFullSamples.length
    : Math.max(1, Math.ceil((SIM_STEP_MS / 1000 / dt) * simulationPlaybackRate.value))
  const next = simFullSamples.slice(simCursor, simCursor + batchSize)
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

function formatParamsForDisplay(params, cascade) {
  if (!params) return ''
  if (cascade) {
    return `速度环 Kp=${params.speedKp}, Ki=${params.speedKi}, Kd=${params.speedKd}；位置环 Kp=${params.positionKp}, Ki=${params.positionKi}, Kd=${params.positionKd}`
  }
  return `Kp=${params.kp}, Ki=${params.ki}, Kd=${params.kd}`
}

/**
 * 从调参历史中提取上一个"好"的 Kp（P 阶段、超调在验收标准内、无明显震荡），用于二分法下界。
 * 单环返回 kp，串级返回当前活跃环（speedKp）。
 * 不稳定系统（倒立摆）：PD 阶段（Ki=0，Kd 可非零），好值额外要求稳态振幅<=3%。
 */
function extractLastGoodKp(history, cascade, overshootLimit, unstable = false) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (!h?.pid || !h?.metrics) continue
    const kp = Number(cascade ? h.pid.speedKp : h.pid.kp) || 0
    const ki = Number(cascade ? h.pid.speedKi : h.pid.ki) || 0
    const kd = Number(cascade ? h.pid.speedKd : h.pid.kd) || 0
    // P 阶段判定：稳定系统 Ki=Kd=0；不稳定系统（PD 阶段）Ki=0、Kd 可非零
    const inPhase = unstable ? (kp > 0 && ki === 0) : (kp > 0 && ki === 0 && kd === 0)
    if (inPhase) {
      const m = h.metrics
      if (unstable) {
        // 不稳定系统好值：振荡<=5%（PD阶段放宽到5%，不要求STABLE）
        const oscOk = (m.oscillation ?? 0) <= 5
        if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation && oscOk) {
          return kp
        }
      } else if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation) {
        return kp
      }
    }
  }
  return null
}

/**
 * 从调参历史中提取上一个"坏"的 Kp（P 阶段、超调超限或有明显震荡），用于二分法上界。
 * 一旦建立上界，P 阶段就只二分不增大，收敛到无超调边界。
 * 不稳定系统：振荡>5%即视为坏值（PD阶段放宽到5%，不要求STABLE）。
 */
function extractLastBadKp(history, cascade, overshootLimit, unstable = false) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (!h?.pid || !h?.metrics) continue
    const kp = Number(cascade ? h.pid.speedKp : h.pid.kp) || 0
    const ki = Number(cascade ? h.pid.speedKi : h.pid.ki) || 0
    const kd = Number(cascade ? h.pid.speedKd : h.pid.kd) || 0
    const inPhase = unstable ? (kp > 0 && ki === 0) : (kp > 0 && ki === 0 && kd === 0)
    if (inPhase) {
      const m = h.metrics
      if (unstable) {
        const oscOverLimit = (m.oscillation ?? 0) > 5
        if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation || oscOverLimit) {
          return kp
        }
      } else if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation) {
        return kp
      }
    }
  }
  return null
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

  // 指标必须和“产生这组响应的参数”绑定；候选生成后再一次性写回，避免因果错位。
  const testedPid = readCanonicalPid(outputParams, isCascade.value)
  const unstableFlag = !!strategy.value.unstable
  const lastGoodKp = extractLastGoodKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, unstableFlag)
  const lastBadKp = extractLastBadKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, unstableFlag)
  // 记录本轮到调参历史（供下一轮 extractLastGoodKp/extractLastBadKp 提取上下界用于二分法）
  tuningHistory.value.push({
    round: tuningHistory.value.length + 1,
    pid: { ...testedPid },
    metrics: { ...deterministicMetrics.value },
    analysis: '',
    thought: '',
    proposedPid: null,
    source: '手动分析'
  })
  // 前馈系数整定：当勾选了前馈项时，根据指标启发式微调前馈系数（与 PID 调参解耦）
  let ffReasons = []
  const ffIds = Object.keys(feedforwardSelection)
  if (ffIds.length) {
    const ffSuggestion = buildFeedforwardSuggestion(deterministicMetrics.value, { ...feedforwardSelection }, { strategyId: strategyId.value })
    ffReasons = ffSuggestion.reasons
    // 更新前馈系数（只更新发生了变化的项）
    Object.keys(ffSuggestion.feedforward).forEach((id) => {
      feedforwardSelection[id] = ffSuggestion.feedforward[id]
    })
  }

  const candidate = buildPidSuggestion(deterministicMetrics.value, testedPid, {
    tuningOrder: tuningOrder.value,
    lastGoodKp,
    lastBadKp,
    unstable: !!strategy.value.unstable,
    disableI: !enableI.value,
    disableD: !enableD.value
  })
  localReasons.value = [...ffReasons, ...candidate.reasons]

  if (!props.aiConfig.apiKey) {
    applyCanonicalPid(outputParams, candidate, isCascade.value)
    aiResult.value = '已完成本地确定性分析。未配置 AI API Key，候选参数（确定性算法）已填入下方。'
    analyzing.value = false
    return false
  }

  // 调用 AI 给出新参数（含历史上下文 + 5 次指数退避重试 + 安全护栏）
  const result = await callAiForPid(deterministicMetrics.value, { currentPid: testedPid, lastGoodKp, lastBadKp })
  analyzing.value = false
  if (!result.ok) {
    // AI 失败：用保底策略生成候选，保证流程不中断
    const fallback = buildFallbackSuggestion(deterministicMetrics.value, testedPid, { lastGoodKp, lastBadKp })
    applyCanonicalPid(outputParams, fallback.params, isCascade.value)
    snapshotAndHighlightChange()
    const phaseTag = fallback.phase ? ` [阶段: ${fallback.phase}]` : ''
    aiResult.value = `AI 调用失败（${result.error}），已用保底策略${phaseTag}：${fallback.reason}。参数已填入下方。`
    return false
  }

  // AI 给出的参数填入候选（覆盖确定性基线）
  aiParams.value = result.params
  applyCanonicalPid(outputParams, result.params, isCascade.value)
  snapshotAndHighlightChange()  // 高亮变化的参数项，给用户即时反馈
  const phaseTag = result.phase ? ` [阶段: ${result.phase}]` : ''
  aiResult.value = `AI 已给出新参数并填入下方候选${phaseTag}：${formatParamsForDisplay(result.params, isCascade.value)}`
  if (result.guardNotes.length) {
    aiResult.value += `\n安全护栏：${result.guardNotes.join('；')}`
  }
  if (result.thought) {
    aiResult.value += `\n工程依据：${result.thought}`
  }
  if (result.selfCheck) {
    aiResult.value += `\n输出自检：${result.selfCheck}`
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
    ? '{"speedKp":<0-20>,"speedKi":<0-10>,"speedKd":<0-10>,"positionKp":<0-20>,"positionKi":<0-10>,"positionKd":<0-10>,"analysis_summary":"<工程依据摘要>","self_check":"<边界与阶段自检>"}'
    : '{"kp":<0-20>,"ki":<0-10>,"kd":<0-10>,"analysis_summary":"<工程依据摘要>","self_check":"<边界与阶段自检>"}'
  const currentParams = options.currentPid || readCanonicalPid(outputParams, cascade)
  const structuredHistory = buildStructuredPidHistory(tuningHistory.value, 3200)
  const successfulExamples = pickSuccessfulPidExamples(tuningHistory.value, 2)
  const waveform = downsamplePidWaveform(response.value, 30)

  // 推断当前调参阶段（与 buildPidSuggestion 一致），同时尊重 I/D 开关
  //   enableI=false → 不允许 PI/PID 阶段（Ki 始终 0）
  //   enableD=false → 不允许 PD/PID 阶段（Kd 始终 0）
  const eps = 1e-6
  const pVal = cascade ? currentParams.speedKp : currentParams.kp
  const iVal = cascade ? currentParams.speedKi : currentParams.ki
  const dVal = cascade ? currentParams.speedKd : currentParams.kd
  const phase = (!pVal && !iVal && !dVal) || (pVal > eps && !iVal && !dVal) ? 'P'
    : (enableD.value && pVal > eps && iVal > eps && !dVal) ? 'PI'
    : (enableI.value && pVal > eps && !iVal && dVal > eps) ? 'PD'
    : (enableI.value && enableD.value) ? 'PID'
    : (enableI.value ? 'PI' : (enableD.value ? 'PD' : 'P'))
  // 噪声判定
  const noisy = (metrics.oscillation ?? 0) > (metrics.limits?.oscillation ?? 10) * 1.2

  // 可接受超调上限：验收标准的 1.2 倍（P 阶段允许一定超调以换取响应速度）
  const overshootLimit = metrics.limits?.overshoot ?? 20
  const overshootMargin = overshootLimit * 1.2
  const curOvershoot = metrics.overshoot ?? 0
  const fmtPct = (v) => Number(v).toFixed(1)

  // 按阶段生成针对性策略提示，让 AI 明确本轮调整方向
  let phaseStrategy
  if (phase === 'P') {
    const hasOsc = !!metrics.hasSignificantOscillation
    const peakInfo = `峰数 ${metrics.oscillationPeakCount ?? 0}，最大振幅 ${fmtPct(metrics.maxPeakAmplitudePct ?? 0)}%`
    if (hasOsc) {
      phaseStrategy = `当前 P 阶段：检测到明显震荡（${peakInfo}，从第三个峰起振幅应≤5%）。` +
        `应减小 Kp 直到震荡消失。Ki=Kd=0。`
    } else if (curOvershoot > overshootMargin) {
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 超出可接受范围（≤${fmtPct(overshootMargin)}%），应减小 Kp。Ki=Kd=0。`
    } else if (curOvershoot > overshootLimit) {
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 已接近可接受上限（≤${fmtPct(overshootMargin)}%），Kp 已尽量增大。` +
        `可保持当前 Kp 进入 PI 阶段加 Ki 消除稳态误差。`
    } else {
      // 根据稳态误差告诉 AI 应激进还是保守
      const steadyErrRatio = Math.abs(metrics.steadyError ?? 0) / Math.max(Math.abs(metrics.stepSize ?? 1), 1e-6)
      let factorHint
      if (steadyErrRatio > 0.3) {
        factorHint = '稳态误差较大，应激进增大 Kp（×1.5~2.0）'
      } else if (steadyErrRatio > 0.1) {
        factorHint = '稳态误差中等，应中等幅度增大 Kp（×1.3~1.5）'
      } else {
        factorHint = '稳态误差较小，应保守增大 Kp（×1.2~1.3）'
      }
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 远低于验收标准 ${fmtPct(overshootLimit)}%，无明显震荡。` +
        `${factorHint}，在可接受超调范围内（≤${fmtPct(overshootMargin)}%）尽量把 Kp 给大。Ki=Kd=0。`
    }
  } else if (phase === 'PI') {
    phaseStrategy = '当前 PI 阶段：P 已调好，加 Ki 消除稳态误差，Kd=0。稳态误差大时增大 Ki，超调时降 P/Ki。'
  } else {
    phaseStrategy = '当前 PID 阶段：加 Kd 抑制超调/振荡。噪声大时禁止加 Kd。'
  }

  const userContent = JSON.stringify({
    提示词版本: PID_PROMPT_VERSION,
    任务: '根据模型事实、响应指标、时序波形、已验证历史和当前阶段，提出下一轮待仿真验证的 PID 参数。',
    输出JSONSchema: buildPidJsonSchema(cascade),
    当前参数: currentParams,
    当前阶段: phase,
    启用积分项: enableI.value ? '是（Ki 可非 0）' : '否（Ki 必须为 0，仅 P/PD 模式）',
    启用微分项: enableD.value ? '是（Kd 可非 0）' : '否（Kd 必须为 0，仅 P/PI 模式）',
    响应指标: {
      状态: metrics.status,
      超调率: metrics.overshoot,
      上升时间: metrics.riseTime,
      稳定时间: metrics.settlingTime,
      稳态误差: metrics.steadyError,
      均方根误差: metrics.rmse,
      振荡: metrics.oscillation,
      振荡峰数: metrics.oscillationPeakCount ?? 0,
      振荡频率: metrics.oscillationFrequency ?? null,
      最大峰振幅百分比: metrics.maxPeakAmplitudePct ?? 0,
      明显震荡: metrics.hasSignificantOscillation ? '是（从第三个峰起振幅>5%，应减小 Kp）' : '否',
      采样点数: metrics.sampleCount,
      反馈噪声大: noisy ? '是（禁止加 Kd）' : '否'
    },
    超调空间: {
      当前超调率: `${fmtPct(curOvershoot)}%`,
      验收标准: `${fmtPct(overshootLimit)}%`,
      可接受上限: `${fmtPct(overshootMargin)}%（P 阶段允许达到此值以最大化 Kp）`
    },
    时序波形_均匀下采样: waveform,
    调参历史_按字符预算裁剪: structuredHistory,
    已验证成功案例: successfulExamples,
    场景: testMode.value === 'simulation'
      ? `仿真测试；模型：${strategy.value.description}`
      : `真实串口阶跃测试；阶跃幅值 ${stepConfig.amplitude}`,
    已知模型参数: testMode.value === 'simulation' ? { ...simulationConfig } : null,
    前馈上下文: {
      已启用: Object.keys(feedforwardSelection),
      当前系数: { ...feedforwardSelection },
      约束: '本次 AI 只输出 PID 参数；前馈由独立确定性策略调整，禁止用 PID 同时补偿前馈。'
    },
    调参顺序: tuningOrder.value.map(formatTuningOrderItem),
    调参策略: phaseStrategy,
    安全要求: '参数必须循序渐进，单步增幅不得超过 3 倍。借鉴历史中的 AI 思考，避免重复无效方向。若"启用积分项/启用微分项"为否，对应 Ki/Kd 必须输出 0。'
  }, null, 2)

  const systemContent = buildPidSystemPrompt({
    cascade,
    phase,
    formatSpec,
    hasFeedforward: Object.keys(feedforwardSelection).length > 0
  })
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ]

  // 5 次指数退避重试
  const delays = [0, 2, 4, 8, 16]
  let lastError = ''
  let structuredOutputEnabled = true

  async function requestCompletion(useStructuredOutput) {
    const body = {
      model: props.aiConfig.model,
      temperature: 0.2,
      messages,
      stream: false
    }
    if (useStructuredOutput) {
      body.response_format = buildStructuredResponseFormat(cascade)
    }
    return fetch(`${props.aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify(body)
    })
  }

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt] * 1000))
    try {
      let res = await requestCompletion(structuredOutputEnabled)
      if (!res.ok && structuredOutputEnabled && [400, 404, 422].includes(res.status)) {
        // OpenAI 兼容后端对 json_schema 支持不一致：自动回退为普通 JSON 提示词，不要求用户手工配置。
        structuredOutputEnabled = false
        res = await requestCompletion(false)
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 240)
        lastError = `HTTP ${res.status}${detail ? `：${detail}` : ''}`
        continue
      }
      const data2 = await res.json()
      const raw = data2.choices?.[0]?.message?.content || ''
      const parsedResult = parsePidAiResponse(raw, cascade)
      if (!parsedResult.ok) {
        lastError = parsedResult.error
        // Instructor 风格自修复：让模型看到自己的错误输出和明确校验反馈。
        messages.push({ role: 'assistant', content: raw.slice(0, 2000) })
        messages.push({ role: 'user', content: buildPidRepairMessage(parsedResult.error, formatSpec) })
        continue
      }
      const parsed = { ...parsedResult.params }
      // I/D 开关强制约束：用户关闭 I/D 时，AI 输出必须强制 Ki/Kd=0（防御 AI 不听话）
      if (!enableI.value) {
        if (cascade) { parsed.speedKi = 0; parsed.positionKi = 0 }
        else { parsed.ki = 0 }
      }
      if (!enableD.value) {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      }
      // 阶段约束后处理：P 阶段强制 Ki=Kd=0；PI 阶段强制 Kd=0；噪声大时强制 Kd=0
      if (phase === 'P') {
        if (cascade) { parsed.speedKi = 0; parsed.speedKd = 0; parsed.positionKi = 0; parsed.positionKd = 0 }
        else { parsed.ki = 0; parsed.kd = 0 }
      } else if (phase === 'PI') {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      } else if (phase === 'PD') {
        // PD 阶段强制 Ki=0（保留 Kd）
        if (cascade) { parsed.speedKi = 0; parsed.positionKi = 0 }
        else { parsed.ki = 0 }
      }
      if (noisy) {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      }
      // 安全护栏裁剪（单步增幅限制 + 边界）
      const guard = applyPidGuardrails(currentParams, parsed)
      // P 阶段二分法强制覆盖：AI 可能给一个不合理的 Kp，用二分上下界强制约束
      const lgKp = Number(options.lastGoodKp) || 0  // 下界（无超调）
      const lbKp = Number(options.lastBadKp) || 0   // 上界（超调/震荡）
      if (phase === 'P') {
        const kpKey = cascade ? 'speedKp' : 'kp'
        const curKp = Number(currentParams[kpKey]) || 0
        const overshootMargin = (Number(metrics.limits?.overshoot) || 20) * 1.2
        const isBad = (Number(metrics.overshoot) || 0) > overshootMargin || metrics.hasSignificantOscillation
        const aiKp = Number(guard.params[kpKey]) || 0
        // 收敛判定：上下界差 < 均值的 10%
        const bisectMean = (lgKp > 0 && lbKp > 0) ? (lgKp + lbKp) / 2 : 0
        const bisectConverged = lgKp > 0 && lbKp > 0 && (lbKp - lgKp) < bisectMean * 0.1
        if (bisectConverged) {
          // 区间已收敛 → 强制进入 PI：保持当前 Kp，开启 Ki
          if (cascade) { guard.params.speedKi = 0.5 }
          else { guard.params.ki = 0.5 }
          guard.notes.push(`P 阶段二分区间已收敛（下界 ${lgKp.toFixed(3)} ↔ 上界 ${lbKp.toFixed(3)}），强制进入 PI 阶段`)
        } else if (isBad && lgKp > 0 && lgKp < curKp) {
          // 当前坏 + 有下界 → 二分(下界+当前)/2，覆盖 AI Kp
          const bisect = (lgKp + curKp) / 2
          guard.params[kpKey] = bisect
          guard.notes.push(`P 阶段二分法覆盖 AI Kp: ${aiKp.toFixed(3)} → ${bisect.toFixed(3)}（下界 ${lgKp.toFixed(3)} ↔ 当前 ${curKp.toFixed(3)}）`)
        } else if (!isBad && lbKp > 0 && curKp < lbKp) {
          // 当前好 + 有上界 → 继续二分(当前+上界)/2 逼近上界，覆盖 AI Kp（避免跳过上界）
          const bisect = (curKp + lbKp) / 2
          guard.params[kpKey] = bisect
          guard.notes.push(`P 阶段继续二分逼近上界，覆盖 AI Kp: ${aiKp.toFixed(3)} → ${bisect.toFixed(3)}（当前 ${curKp.toFixed(3)} ↔ 上界 ${lbKp.toFixed(3)}）`)
        }
      }
      return {
        ok: true,
        params: guard.params,
        thought: parsedResult.analysisSummary,
        selfCheck: parsedResult.selfCheck,
        guardNotes: guard.notes,
        phase,
        structuredOutput: structuredOutputEnabled
      }
    } catch (e) {
      lastError = e.message || String(e)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * 可复现的自动调参实验：每轮严格记录
 * “实际测试参数 → 指标 → 决策 → 下一轮候选”，避免把未验证候选误当成结果。
 * AI 可用时采用混合引擎；无 API Key 或 AI 失败时自动切换本地规则引擎。
 */
async function runAutoTuning() {
  if (testMode.value !== 'simulation') {
    error.value = '自动调参仅在仿真模式下可用'
    return
  }
  if (autoTuning.value) return
  const useAi = autoTuneSettings.engine === 'hybrid' && Boolean(props.aiConfig.apiKey)
  const engineLabel = useAi ? 'AI + 本地规则混合引擎' : '本地规则引擎（离线）'
  // 风险提示
  try {
    await ElMessageBox.confirm(
      `自动调参将在仿真模式下使用“${engineLabel}”连续运行多轮实验。\n\n` +
      '说明：\n• 最多 ' + autoTuneSettings.maxRounds + ' 轮，达标后提前结束\n' +
      '• 仅在 STABLE 时记录最佳参数\n' +
      '• 检测到劣化时自动回退到最佳参数\n' +
      '• 连续无改善时停止并恢复已验证的最佳参数\n' +
      '• 每轮会分别记录测试参数和下一轮候选\n\n' +
      '确定开始自动调参吗？',
      '自动调参',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'info' }
    )
  } catch {
    return
  }

  autoTuning.value = true
  autoTuneCancel = false
  tuningSession = createTuningSession(autoTuneSettings)
  const t0 = Date.now()

  try {
    for (let round = 1; round <= tuningSession.maxRounds; round += 1) {
      if (autoTuneCancel) {
        autoTuneStatus.value = `已取消（完成 ${round - 1} 轮）`
        break
      }
      autoTuneRound.value = round
      autoTuneStatus.value = `第 ${round}/${tuningSession.maxRounds} 轮：验证当前参数…`

      // 1. 同步运行仿真（一次性算完，不走 setInterval，避免循环与定时器交织）
      const testedPid = readCanonicalPid(outputParams, isCascade.value)
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

      // 3. 会话状态机先评价本轮，再决定完成、回退、停止或继续。
      const registered = registerTuningRound(
        tuningSession,
        { pid: testedPid, metrics, round },
        {
          rmseLimit: Math.abs(metrics.stepSize) * 0.05,
          steadyErrorLimit: Math.abs(metrics.stepSize) * 0.02,
          overshootLimit: strategy.value.acceptance.overshootLimit
        }
      )
      tuningSession = registered.session
      const historyRecord = {
        ...registered.roundRecord,
        analysis: registered.outcome.reason,
        thought: '',
        proposedPid: null,
        source: ''
      }
      tuningHistory.value.push(historyRecord)

      if (registered.outcome.applyPid) {
        applyCanonicalPid(outputParams, registered.outcome.applyPid, isCascade.value)
        snapshotAndHighlightChange()
      }
      if (registered.outcome.decision === 'rollback') {
        historyRecord.thought = '安全回退'
        autoTuneStatus.value = `第 ${round} 轮：${registered.outcome.reason}`
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      if (registered.outcome.isTerminal) {
        historyRecord.thought = registered.outcome.decision === 'complete' ? '已达标' : '停止搜索'
        autoTuneStatus.value = `${registered.outcome.reason}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
        break
      }

      // 4. 为下一轮生成候选。候选只记录为“待验证”，不会冒充本轮结果。
      autoTuneStatus.value = `第 ${round}/${tuningSession.maxRounds} 轮：生成下一轮候选…`
      let proposedPid
      let thought = ''
      let source = '本地规则'
      let guardNotes = []
      // 前馈系数整定：当勾选了前馈项时，根据本轮指标启发式微调前馈系数
      let ffReasonsAuto = []
      if (Object.keys(feedforwardSelection).length) {
        const ffSuggestion = buildFeedforwardSuggestion(metrics, { ...feedforwardSelection }, { strategyId: strategyId.value })
        ffReasonsAuto = ffSuggestion.reasons
        Object.keys(ffSuggestion.feedforward).forEach((id) => {
          feedforwardSelection[id] = ffSuggestion.feedforward[id]
        })
      }
      if (useAi) {
        const lastGoodKpAuto = extractLastGoodKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, !!strategy.value.unstable)
        const lastBadKpAuto = extractLastBadKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, !!strategy.value.unstable)
        const resultAi = await callAiForPid(metrics, { currentPid: testedPid, lastGoodKp: lastGoodKpAuto, lastBadKp: lastBadKpAuto, unstable: !!strategy.value.unstable })
        if (resultAi.ok) {
          proposedPid = resultAi.params
          thought = [
            resultAi.thought,
            resultAi.selfCheck ? `自检：${resultAi.selfCheck}` : ''
          ].filter(Boolean).join('；')
          source = 'AI + 安全护栏'
          guardNotes = resultAi.guardNotes || []
        } else {
          thought = `AI 不可用：${resultAi.error}；已切换本地规则`
        }
      }
      if (!proposedPid) {
        const lastGoodKpAuto = extractLastGoodKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, !!strategy.value.unstable)
        const lastBadKpAuto = extractLastBadKp(tuningHistory.value, isCascade.value, strategy.value.acceptance.overshootLimit, !!strategy.value.unstable)
        const fallback = buildFallbackSuggestion(metrics, testedPid, { lastGoodKp: lastGoodKpAuto, lastBadKp: lastBadKpAuto, unstable: !!strategy.value.unstable })
        const guarded = applyPidGuardrails(testedPid, fallback.params)
        proposedPid = guarded.params
        guardNotes = guarded.notes
        if (!thought) thought = fallback.reason
      }
      applyCanonicalPid(outputParams, proposedPid, isCascade.value)
      snapshotAndHighlightChange()
      historyRecord.proposedPid = { ...proposedPid }
      historyRecord.source = source
      historyRecord.thought = ffReasonsAuto.length ? `${ffReasonsAuto.join('；')}${thought ? ' | ' + thought : ''}` : thought
      historyRecord.analysis = `下一轮候选：${formatParamsForDisplay(proposedPid, isCascade.value)}`
      if (guardNotes.length) {
        historyRecord.analysis += `（护栏：${guardNotes.join('；')}）`
      }
      autoTuneStatus.value = `第 ${round} 轮已验证；${source}已生成下一轮候选`
      await new Promise((r) => setTimeout(r, 100))
    }
    if (autoTuneCancel && tuningSession) {
      const best = tuningSession.bestStable || tuningSession.bestObserved
      if (best?.pid) {
        applyCanonicalPid(outputParams, best.pid, isCascade.value)
        snapshotAndHighlightChange()
        autoTuneStatus.value += '；已恢复目前已验证的最佳参数'
      }
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
  tuningSession = null
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
    <div class="pid-layout">
      <!-- ============ 左栏：策略注册表 + 当前参数总览 ============ -->
      <div class="pid-left">
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

          <!-- 当前参数总览：移到策略注册表内，调参过程中持续可见 -->
          <div class="current-params-overview">
            <div class="overview-header">
              <span class="overview-title">当前参数总览</span>
              <span class="phase-tag" :class="`phase-${currentParamsOverview.phase.toLowerCase()}`">阶段: {{ currentParamsOverview.phase }}</span>
            </div>
            <div class="overview-params">
              <div
                v-for="(val, key) in currentParamsOverview.pid"
                :key="key"
                class="overview-param"
                :class="{ 'param-changed': isParamChanged(currentParamsOverview.keyMap[key]) }"
              >
                <span class="param-name">{{ key }}</span>
                <span class="param-val">{{ val }}</span>
              </div>
            </div>
            <div class="overview-ff">
              <span class="ff-label">前馈:</span>
              <template v-if="currentParamsOverview.ffItems.length">
                <span v-for="ff in currentParamsOverview.ffItems" :key="ff" class="ff-item">{{ ff }}</span>
              </template>
              <span v-else class="ff-none">无（纯 PID 模式）</span>
            </div>
          </div>

          <transition name="mode-fade">
          <div v-if="testMode === 'simulation'" class="sim-block">
            <!-- 运行/自动调参按钮：常驻可见 -->
            <div class="action-row action-row-wrap">
              <button
                class="btn-primary"
                :class="{ 'btn-running': simRunState === 'running', 'btn-paused': simRunState === 'paused' }"
                @click="runSimulation"
              >
                <el-icon size="13" class="is-loading" v-if="simRunState === 'running'"><Loading /></el-icon>
                <el-icon size="13" v-else>
                  <VideoPause v-if="simRunState === 'paused'" />
                  <VideoPlay v-else />
                </el-icon>
                <span>{{ simRunState === 'running' ? '运行中（点击暂停）' : (simRunState === 'paused' ? '继续' : '运行仿真并分析') }}</span>
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
                :disabled="testMode !== 'simulation' || simRunState !== 'idle'"
                @click="runAutoTuning"
              >
                <el-icon size="13" class="is-loading" v-if="autoTuning"><Loading /></el-icon>
                <el-icon size="13" v-else><Refresh /></el-icon>
                <span>自动调参</span>
              </button>
              <button
                v-else
                class="btn-secondary btn-auto-tune-cancel"
                @click="cancelAutoTuning"
              >取消自动调参</button>
              <span v-if="autoTuning || simulationStatus" class="status-badge" :class="{ 'status-active': autoTuning || simRunState === 'running' }">{{ autoTuning ? autoTuneStatus : simulationStatus }}</span>
            </div>

            <!-- 不变参数折叠：模型参数、播放速度、自动调参配置、前馈、调参顺序 -->
            <details class="collapse-section">
              <summary>模型参数 / 仿真播放速度 / 自动调参配置</summary>
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
              <div class="auto-tune-config">
                <div class="field">
                  <label>仿真播放速度</label>
                  <el-select v-model="simulationPlaybackRate" size="small" :disabled="simRunState !== 'idle'">
                    <el-option label="1×（按模型时间）" :value="1" />
                    <el-option label="5×" :value="5" />
                    <el-option label="20×" :value="20" />
                    <el-option label="即时完成" :value="0" />
                  </el-select>
                </div>
                <div class="field">
                  <label>自动调参引擎</label>
                  <el-select v-model="autoTuneSettings.engine" size="small" :disabled="autoTuning">
                    <el-option label="混合（AI 优先，失败转本地）" value="hybrid" />
                    <el-option label="本地规则（离线）" value="rules" />
                  </el-select>
                </div>
                <div class="field">
                  <label>最大轮数</label>
                  <el-input-number v-model="autoTuneSettings.maxRounds" :min="1" :max="30" size="small" :disabled="autoTuning" />
                </div>
                <div class="field">
                  <label>连续达标轮数</label>
                  <el-input-number v-model="autoTuneSettings.requiredStable" :min="1" :max="5" size="small" :disabled="autoTuning" />
                </div>
                <div class="field">
                  <label>无改善停止轮数</label>
                  <el-input-number v-model="autoTuneSettings.patience" :min="1" :max="10" size="small" :disabled="autoTuning" />
                </div>
              </div>
              <div
                v-if="autoTuneSettings.engine === 'hybrid' && !aiConfig.apiKey"
                class="engine-note"
              >
                未配置 AI API Key，本次会自动使用本地规则引擎，不影响闭环仿真。
              </div>
            </details>
          </div>
          </transition>

          <details class="collapse-section">
            <summary>前馈项（{{ Object.keys(feedforwardSelection).length }} 项已勾选）</summary>
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
              <button class="btn-secondary btn-mini" @click="copyFeedforwardMask">
                {{ copyMaskState === 'copied' ? '已复制 ✓' : (copyMaskState === 'failed' ? '复制失败' : '复制') }}
              </button>
            </div>
          </details>

          <details class="collapse-section">
            <summary>调参顺序（由用户决定；前馈项默认在前）</summary>
            <div class="order-list">
              <div v-for="(item, index) in tuningOrder" :key="item" class="order-item">
                <span>{{ index + 1 }}. {{ formatTuningOrderItem(item) }}</span>
                <div>
                  <button :disabled="index === 0" @click="moveTuningStep(index, -1)" aria-label="上移">↑</button>
                  <button :disabled="index === tuningOrder.length - 1" @click="moveTuningStep(index, 1)" aria-label="下移">↓</button>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
      </div>

      <!-- ============ 右栏：阶跃 + 分析 + AI 给参 + PID 下发 ============ -->
      <div class="pid-right">
      <!-- 步骤 1: 阶跃信号配置（仅串口模式） -->
      <transition name="mode-fade">
      <div v-if="testMode === 'serial'" class="step-card">
        <div class="step-header">
          <div class="step-number">{{ stepNumbers.step }}</div>
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
              <el-input-number v-model="stepConfig.amplitude" :controls="false" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>采集时长 (ms)</label>
              <el-input-number v-model="stepConfig.duration" :min="100" :step="100" :controls="false" size="small" :disabled="collecting" />
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
          <div class="action-row action-row-wrap">
            <button class="btn-primary" :disabled="!connected || collecting" @click="startStepTest">
              <el-icon size="13"><Promotion /></el-icon>
              <span>发送阶跃信号</span>
            </button>
            <button v-if="collecting" class="btn-danger" @click="stopCollection">停止采集</button>
            <span v-if="response.length > 0" class="status-badge">已采集 {{ response.length }} 点</span>
            <span v-else-if="!connected" class="empty-hint">未连接串口，无法发送阶跃信号</span>
          </div>
        </div>
      </div>
      </transition>

      <!-- 步骤 2: 确定性分析 + 可选 AI 解释 -->
      <div class="step-card">
        <div class="step-header">
            <div class="step-number">{{ stepNumbers.analysis }}</div>
            <div class="step-title">确定性分析 + AI 给参</div>
          </div>
        <div class="step-body">
          <div class="action-row action-row-wrap">
            <button class="btn-ai" :disabled="analyzing || response.length < 5" @click="analyzeResponse">
              <el-icon size="13" class="is-loading" v-if="analyzing"><Loading /></el-icon>
              <el-icon size="13" v-else><DataAnalysis /></el-icon>
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
          <div v-else-if="!analyzing && response.length < 5" class="empty-hint">
            暂无分析结果，请先{{ testMode === 'simulation' ? '运行仿真' : '发送阶跃信号并采集响应' }}获取数据。
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
              <div v-for="(h, index) in tuningHistory.slice(-10)" :key="`${h.round}-${index}`" class="history-item">
                <div class="history-round">
                  Round {{ h.round }} · {{ h.metrics?.status || '--' }}
                  <el-tag v-if="h.isBest" size="small" type="success">刷新最佳</el-tag>
                  <el-tag v-if="h.decision && h.decision !== 'continue'" size="small" type="warning">{{ h.decision }}</el-tag>
                </div>
                <div class="history-pid">
                  实测：{{ h.testedPid || h.pid ? Object.entries(h.testedPid || h.pid).map(([k,v]) => `${k}=${v}`).join(', ') : '' }}
                </div>
                <div v-if="h.proposedPid" class="history-proposed">
                  待验证（{{ h.source }}）：{{ Object.entries(h.proposedPid).map(([k,v]) => `${k}=${v}`).join(', ') }}
                </div>
                <div class="history-metric">评分={{ Number.isFinite(h.score) ? h.score.toFixed(3) : '--' }}，均方根误差={{ h.metrics?.rmse }}，超调={{ h.metrics?.overshoot }}%，稳态误差={{ h.metrics?.steadyError }}</div>
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
          <div class="step-number">{{ stepNumbers.output }}</div>
          <div class="step-title">PID 候选与参数下发</div>
          <div class="pid-mode-switches">
            <label class="pid-mode-switch" :title="enableI ? '点击关闭积分项（仅 P/PD 模式）' : '点击启用积分项'">
              <input type="checkbox" v-model="enableI" />
              <span>I</span>
            </label>
            <label class="pid-mode-switch" :title="enableD ? '点击关闭微分项（仅 P/PI 模式）' : '点击启用微分项'">
              <input type="checkbox" v-model="enableD" />
              <span>D</span>
            </label>
            <span class="pid-mode-tag">{{ (!enableI && !enableD) ? 'P' : (!enableI) ? 'PD' : (!enableD) ? 'PI' : 'PID' }} 模式</span>
          </div>
        </div>
        <div class="step-body">
          <template v-if="isCascade">
            <div class="subsection-title">速度环（内环）</div>
            <div class="param-grid">
              <div class="field">
                <label>速度环 Kp</label>
                <el-input-number v-model="outputParams.speedKp" :min="0" :max="20" :step="0.1" :controls="false" size="small" placeholder="比例系数" />
              </div>
              <div class="field">
                <label>速度环 Ki</label>
                <el-input-number v-model="outputParams.speedKi" :min="0" :max="10" :step="0.1" :controls="false" size="small" :disabled="!enableI" placeholder="积分系数" />
              </div>
              <div class="field">
                <label>速度环 Kd</label>
                <el-input-number v-model="outputParams.speedKd" :min="0" :max="10" :step="0.01" :controls="false" size="small" :disabled="!enableD" placeholder="微分系数" />
              </div>
            </div>
            <div class="subsection-title">位置环（外环）</div>
            <div class="param-grid">
              <div class="field">
                <label>位置环 Kp</label>
                <el-input-number v-model="outputParams.kp" :min="0" :max="20" :step="0.1" :controls="false" size="small" placeholder="比例系数" />
              </div>
              <div class="field">
                <label>位置环 Ki</label>
                <el-input-number v-model="outputParams.ki" :min="0" :max="10" :step="0.1" :controls="false" size="small" :disabled="!enableI" placeholder="积分系数" />
              </div>
              <div class="field">
                <label>位置环 Kd</label>
                <el-input-number v-model="outputParams.kd" :min="0" :max="10" :step="0.01" :controls="false" size="small" :disabled="!enableD" placeholder="微分系数" />
              </div>
            </div>
          </template>
          <template v-else>
            <div class="param-grid">
              <div class="field">
                <label>Kp</label>
                <el-input-number v-model="outputParams.kp" :min="0" :max="20" :step="0.1" :controls="false" size="small" placeholder="比例系数" />
              </div>
              <div class="field">
                <label>Ki</label>
                <el-input-number v-model="outputParams.ki" :min="0" :max="10" :step="0.1" :controls="false" size="small" :disabled="!enableI" placeholder="积分系数" />
              </div>
              <div class="field">
                <label>Kd</label>
                <el-input-number v-model="outputParams.kd" :min="0" :max="10" :step="0.01" :controls="false" size="small" :disabled="!enableD" placeholder="微分系数" />
              </div>
            </div>
          </template>
          <div class="action-row action-row-wrap">
            <button class="btn-primary" :disabled="!connected && testMode !== 'simulation'" @click="sendParams">
              <el-icon size="13"><Promotion /></el-icon>
              <span>{{ testMode === 'simulation' ? '应用至仿真' : '下发 PID 参数' }}</span>
            </button>
            <button class="btn-secondary" @click="exportEmbeddedController">导出 .c / .h</button>
            <el-checkbox v-if="testMode === 'serial'" v-model="autoSend" class="auto-send-cb" @change="onAutoSendChange">
              自动下发
            </el-checkbox>
          </div>
          <div class="safety-note">
            边界：Kp 0~20，Ki/Kd 0~10；{{ testMode === 'simulation' ? '仿真不会写入硬件。' : (autoSend ? '已开启自动下发，无需二次确认。' : '点击后仍需二次确认。') }}
          </div>
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
  overflow: hidden;
  padding: var(--space-4);
  color: var(--color-text-primary);
}

/* 两栏布局：左策略注册表 + 当前参数总览；右分析 + AI 给参 + 下发 */
.pid-layout {
  display: flex;
  gap: var(--space-4);
  height: 100%;
  width: 100%;
  max-width: 1400px;
  margin: 0 auto;
  align-items: stretch;
}

.pid-left {
  flex: 0 0 380px;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.pid-right {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* 窄屏响应式：960px 以下两栏折叠为单列 */
@media (max-width: 960px) {
  .pid-layout {
    flex-direction: column;
    gap: var(--space-3);
  }
  .pid-left {
    flex: 0 0 auto;
    height: auto;
    max-height: 50vh;
  }
  .pid-right {
    height: auto;
  }
}

.pid-left > .step-card,
.pid-right > .step-card {
  flex: 0 0 auto;
}

/* 折叠面板：仿真不变的参数默认收起 */
.collapse-section {
  margin-top: var(--space-3);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  overflow: hidden;
}

.collapse-section > summary {
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  font-weight: 500;
  font-size: 13px;
  background: var(--color-bg-tertiary);
  list-style: none;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.collapse-section > summary::-webkit-details-marker {
  display: none;
}

.collapse-section > summary::after {
  content: '▶';
  font-size: 10px;
  color: var(--color-text-secondary);
  transition: transform 0.2s;
}

.collapse-section[open] > summary::after {
  transform: rotate(90deg);
}

.collapse-section[open] > summary {
  border-bottom: 1px solid var(--color-border-default);
}

.collapse-section > *:not(summary) {
  padding-left: var(--space-3);
  padding-right: var(--space-3);
}

.collapse-section > *:not(summary):last-child {
  padding-bottom: var(--space-3);
  padding-top: var(--space-3);
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
  position: sticky;
  top: 0;
  z-index: 1;
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

/* action-row-wrap：按钮和状态文本自动换行，避免溢出被裁切 */
.action-row-wrap {
  flex-wrap: wrap;
  row-gap: var(--space-2);
}

/* 状态徽章：比 data-count 更显眼，用于运行/调参状态显示 */
.status-badge {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-default);
}

.status-badge.status-active {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 64, 158, 255), 0.08);
}

/* 空状态提示：引导用户下一步操作 */
.empty-hint {
  margin-top: var(--space-2);
  padding: var(--space-3);
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  background: var(--color-bg-tertiary);
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-sm);
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
  max-height: 400px;
  overflow-y: auto;
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
.history-proposed {
  color: var(--color-ai);
  font-family: var(--font-family-mono);
  margin-top: 2px;
}
.history-metric {
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  margin-top: 2px;
}
.history-thought,
.history-analysis {
  color: var(--color-ai);
  margin-top: 2px;
}

.model-grid {
  display: grid;
  /* 2 列布局适配左栏 380px 宽度，避免横向滚动 */
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.model-grid :deep(.el-input-number) {
  width: 100%;
}

.auto-tune-config {
  display: grid;
  /* 2 列布局适配左栏宽度，避免横向滚动 */
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
}

.auto-tune-config :deep(.el-input-number),
.auto-tune-config :deep(.el-select) {
  width: 100%;
}

.engine-note {
  margin: 0 0 var(--space-2);
  color: var(--color-warning, #f5a623);
  font-size: var(--text-xs);
}

.subsection-title {
  margin: var(--space-3) 0 var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border-default);
  color: var(--color-text-primary);
  font-size: var(--text-sm);
  font-weight: 600;
}
/* 第一个 subsection-title 不需要上边框 */
.subsection-title:first-child {
  border-top: none;
  padding-top: 0;
}

/* 当前参数总览栏 */
.current-params-overview {
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
}
.overview-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.overview-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text-secondary);
}
.phase-tag {
  font-size: var(--text-xs);
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 600;
}
.phase-tag.phase-p {
  background: rgba(229, 72, 77, 0.12);
  color: var(--color-danger, #e5484d);
}
.phase-tag.phase-pi {
  background: rgba(245, 166, 35, 0.15);
  color: var(--color-warning, #f5a623);
}
.phase-tag.phase-pid {
  background: rgba(0, 168, 112, 0.12);
  color: var(--color-success, #00a870);
}
.overview-params {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.overview-param {
  display: flex;
  flex-direction: column;
  padding: 3px 10px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  min-width: 70px;
  transition: background 0.3s, border-color 0.3s;
}
.overview-param .param-name {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.overview-param .param-val {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
}
/* 参数变化高亮：AI 应用后该参数背景闪绿 */
.overview-param.param-changed {
  background: rgba(0, 168, 112, 0.15);
  border-color: var(--color-success, #00a870);
}
.overview-ff {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-top: var(--space-2);
  font-size: var(--text-xs);
}
.overview-ff .ff-label {
  color: var(--color-text-tertiary);
}
.overview-ff .ff-item {
  padding: 1px 8px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: 3px;
  font-family: var(--font-family-mono);
  color: var(--color-ai, #7c5cff);
}
.overview-ff .ff-none {
  color: var(--color-text-tertiary);
  font-style: italic;
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
  margin-top: var(--space-2);
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
  .auto-tune-config {
    grid-template-columns: 1fr;
  }
}

.metric-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
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
  margin-top: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
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
  transition: filter 0.2s, opacity 0.2s, background-color 0.2s;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-primary:active:not(:disabled) {
  filter: brightness(0.95);
}

.btn-primary:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
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
  transition: filter 0.2s, opacity 0.2s;
}

.btn-ai:hover:not(:disabled) {
  filter: brightness(1.05);
}

.btn-ai:active:not(:disabled) {
  filter: brightness(0.95);
}

.btn-ai:focus-visible {
  outline: 2px solid var(--color-ai);
  outline-offset: 2px;
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
  transition: filter 0.2s, opacity 0.2s;
}

.btn-danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-danger:active:not(:disabled) {
  filter: brightness(0.95);
}

.btn-danger:focus-visible {
  outline: 2px solid var(--state-error);
  outline-offset: 2px;
}

.btn-danger:disabled {
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
  transition: filter 0.2s, opacity 0.2s, border-color 0.2s;
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.btn-secondary:active:not(:disabled) {
  filter: brightness(0.95);
}

.btn-secondary:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 调参顺序上移/下移按钮的 hover/focus 状态 */
.order-item button {
  transition: background 0.2s, border-color 0.2s;
}

.order-item button:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.order-item button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

/* 所有 el-input-number 宽度填满父容器 */
.field :deep(.el-input-number) {
  width: 100%;
}

/* 模式切换过渡动画 */
.mode-fade-enter-active,
.mode-fade-leave-active {
  transition: opacity 0.2s;
}
.mode-fade-enter-from,
.mode-fade-leave-to {
  opacity: 0;
}

@media (max-width: 900px) {
  .model-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
