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
  buildFallbackSuggestion
} from '../services/pidSafety.mjs'
import {
  applyCanonicalPid,
  readCanonicalPid
} from '../services/pidTuningSession.mjs'
import {
  FEEDFORWARD_GROUPS,
  FEEDFORWARD_ITEMS_BY_ID,
  generateEmbeddedControllerFiles,
  simulatePidStrategy
} from '../services/pidSimulation.mjs'
import {
  extractLastBadKp,
  extractLastGoodKp
} from '../services/pidTuningEngine.mjs'
import { callAiForPid } from '../services/pidAiClient.mjs'
import { usePidTuning } from '../composables/usePidTuning.mjs'

const props = defineProps({
  connected: Boolean,
  aiConfig: { type: Object, required: true },
  serialContext: { type: Object, default: null },
  latestPayload: { type: Object, default: null }
})
const emit = defineEmits(['send', 'simulation-data'])

const {
  testMode, strategyId, simulationConfig, simulationStatus, strategy, strategyOptions, isCascade,
  feedforwardSelection, feedforwardSelectedByGroup, feedforwardFormulaText, feedforwardMaskLiteral,
  outputParams, enableI, enableD, tuningOrder,
  response, analyzing, deterministicMetrics, aiParams, aiResult, localReasons, error, success, autoSend,
  tuningHistory, autoTuning, autoTuneRound, autoTuneStatus, autoTuneSettings,
  currentParamsOverview, isParamChanged,
  formatTuningOrderItem, moveTuningStep, onFeedforwardGroupChange, applyStrategyDefaults,
  buildSimOverrides, applyCandidate, clearAll: clearTuningState,
  cancelAutoTuning, startAutoTuning
} = usePidTuning()

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

const collecting = ref(false)

// 仿真运行状态：'idle' | 'running' | 'paused'
const simRunState = ref('idle')
const simulationPlaybackRate = ref(5)
let simTimer = null
let simFullSamples = []   // 一次性算出的完整样本
let simCursor = 0          // 当前已推送到 response 的样本索引
const SIM_STEP_MS = 30     // 推送间隔（约 33fps）

let collectTimer = null
let firstResponseTime = null

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

  // 调用 AI 给出新参数（含历史上下文 + 5 次指数退避重试 + 安全护栏；逻辑见 services/pidAiClient.mjs）
  const result = await callAiForPid({
    aiConfig: props.aiConfig,
    metrics: deterministicMetrics.value,
    currentPid: testedPid,
    cascade: isCascade.value,
    enableI: enableI.value,
    enableD: enableD.value,
    tuningHistory: tuningHistory.value,
    waveformSamples: response.value,
    tuningOrder: tuningOrder.value.map(formatTuningOrderItem),
    scenario: testMode.value === 'simulation'
      ? `仿真测试；模型：${strategy.value.description}`
      : `真实串口阶跃测试；阶跃幅值 ${stepConfig.amplitude}`,
    knownModelParams: testMode.value === 'simulation' ? { ...simulationConfig } : null,
    feedforwardSelection: { ...feedforwardSelection },
    lastGoodKp,
    lastBadKp
  })
  analyzing.value = false
  if (!result.ok) {
    // AI 失败：用保底策略生成候选，保证流程不中断
    const fallback = buildFallbackSuggestion(deterministicMetrics.value, testedPid, { lastGoodKp, lastBadKp })
    applyCandidate(fallback.params, isCascade.value)
    const phaseTag = fallback.phase ? ` [阶段: ${fallback.phase}]` : ''
    aiResult.value = `AI 调用失败（${result.error}），已用保底策略${phaseTag}：${fallback.reason}。参数已填入下方。`
    return false
  }

  // AI 给出的参数填入候选（覆盖确定性基线）
  aiParams.value = result.params
  applyCandidate(result.params, isCascade.value)
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
 * 自动调参（薄壳）：风险确认后交由 composable 启动无 Vue 的自动调参引擎
 * （services/pidTuningEngine.mjs），每轮经 onRound 回调同步 UI 与写回参数。
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
  await startAutoTuning({
    aiConfig: props.aiConfig,
    onRoundExtra: () => { emit('simulation-data', response.value) }
  })
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
    success.value = `已应用至仿真：${cmdPreview}（点击“运行仿真”验证）`
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
      success.value = '已取消下发，设备参数未改变'
      return
    }
  }
  try {
    await window.electronAPI.serial.send(cmd, 'utf8')
    emit('send', cmd.length)
    success.value = `已下发: ${cmd}`
  } catch (e) {
    error.value = `下发失败: ${e.message || e}`
  }
}

function clearAll() {
  stopSimulation()
  firstResponseTime = null
  clearTuningState()
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
              <el-tag v-if="autoTuneRound > 0" size="small" type="info">第 {{ autoTuneRound }}/{{ autoTuneSettings.maxRounds }} 轮</el-tag>
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
          <div v-if="success" class="success-msg">{{ success }}</div>
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
          <!-- 校验错误与 PID 输入框同卡展示，便于对照修正（与步骤 2 共用同一个 error/success） -->
          <div v-if="error" class="error-msg">{{ error }}</div>
          <div v-if="success" class="success-msg">{{ success }}</div>
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
  /* 允许在窄窗口收缩（原 flex: 0 0 380px 固定不缩导致 1024px 下右栏被压至约 305px） */
  flex: 0 1 380px;
  min-width: 320px;
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

/* I/D 模式开关：等宽文字、间距与选中态，贴合现有设计语言 */
.pid-mode-switches {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}
.pid-mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text-secondary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
}
.pid-mode-switch:hover {
  color: var(--color-text-primary);
  border-color: var(--color-border-active);
}
.pid-mode-switch:has(input:checked) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--color-primary-muted);
}
.pid-mode-switch input {
  accent-color: var(--color-primary);
  cursor: pointer;
}
.pid-mode-tag {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-ai);
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
  background: var(--color-primary-muted);
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
  background: var(--state-error-muted);
  border: 1px solid var(--state-error-muted);
  border-radius: var(--radius-sm);
  color: var(--state-error);
  font-size: var(--text-xs);
}

/* 成功消息：与错误提示区分，绿色 AI 色基调 */
.success-msg {
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: var(--color-ai-subtle);
  border: 1px solid var(--color-ai-muted);
  border-radius: var(--radius-sm);
  color: var(--state-success);
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
  color: var(--state-warning);
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
  background: var(--state-error-muted);
  color: var(--state-error);
}
.phase-tag.phase-pi {
  background: var(--state-warning-muted);
  color: var(--state-warning);
}
.phase-tag.phase-pid {
  background: var(--state-success-muted);
  color: var(--state-success);
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
  background: var(--state-success-muted);
  border-color: var(--state-success);
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
  background: var(--state-error);
}

/* 仿真暂停中：按钮变橙，提示再点按即继续 */
.btn-primary.btn-paused {
  background: var(--state-warning);
}

/* 自动调参按钮：紫色调，与普通仿真按钮区分 */
.btn-primary.btn-auto-tune {
  background: var(--color-ai, #7c5cff);
}
.btn-secondary.btn-auto-tune-cancel {
  border-color: var(--state-error);
  color: var(--state-error);
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
</style>
