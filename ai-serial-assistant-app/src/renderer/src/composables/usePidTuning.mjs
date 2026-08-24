/**
 * PID 调参状态管理层（Vue 适配层）。
 *
 * 集中持有 PidPanel 调参相关的共享状态与操作（参数、前馈、历史、自动调参生命周期等），
 * 并把无 Vue 的自动调参引擎（services/pidTuningEngine.mjs）桥接回 UI：
 *   - 引擎每轮经 onRound 回调推回 { samples, params, feedforward, history, statusText }，
 *     本模块同步到 refs 供模板展示，并写回 outputParams / feedforwardSelection / tuningHistory；
 *   - 手动分析（analyzeResponse）仍由组件编排，但共享状态统一从这里取。
 *
 * 串口采集/下发、仿真播放、导出/复制等交互与采集能力不在此层（保留在组件）。
 */

import { computed, reactive, ref, watch } from 'vue'
import {
  FEEDFORWARD_GROUPS,
  FEEDFORWARD_ITEMS_BY_ID,
  PID_STRATEGIES,
  formatFeedforwardMask,
  getStrategyConfig
} from '../services/pidSimulation.mjs'
import {
  applyCanonicalPid,
  readCanonicalPid
} from '../services/pidTuningSession.mjs'
import { runAutoTuning as runEngine } from '../services/pidTuningEngine.mjs'

export function usePidTuning() {
  // ============ 测试来源 / 策略注册表 ============
  const testMode = ref('simulation')
  const strategyId = ref('motor_speed')
  const simulationConfig = reactive(getStrategyConfig(strategyId.value))
  const simulationStatus = ref('')
  const strategy = computed(() => PID_STRATEGIES[strategyId.value])
  const strategyOptions = computed(() => Object.values(PID_STRATEGIES))
  const isCascade = computed(() => strategyId.value === 'cascade_position')

  // ============ 前馈勾选 ============
  const feedforwardSelection = reactive({})
  const feedforwardSelectedByGroup = reactive(
    Object.fromEntries(FEEDFORWARD_GROUPS.map((g) => [g.id, []]))
  )
  const feedforwardFormulaText = computed(() => {
    const ids = Object.keys(feedforwardSelection)
    if (!ids.length) return 'u = PID(error)'
    const parts = ids.map((id) => FEEDFORWARD_ITEMS_BY_ID[id]?.formula).filter(Boolean)
    return `u = PID(error) + ${parts.join(' + ')}`
  })
  const feedforwardMaskLiteral = computed(() => formatFeedforwardMask(feedforwardSelection))

  // ============ PID 候选参数 / I-D 开关 ============
  const outputParams = reactive({
    kp: '1.0',
    ki: '0',
    kd: '0',
    speedKp: '1.0',
    speedKi: '0',
    speedKd: '0'
  })
  const enableI = ref(true)
  const enableD = ref(true)

  // 调参顺序（默认策略默认顺序，前馈项默认在前）
  const tuningOrder = ref([...PID_STRATEGIES[strategyId.value].defaultOrder])

  // ============ 分析 / AI 结果 ============
  const response = ref([])
  const analyzing = ref(false)
  const deterministicMetrics = ref(null)
  const aiParams = ref(null)
  const aiResult = ref('')
  const localReasons = ref([])

  // ============ 提示 / 错误 / 成功 ============
  const error = ref('')
  const success = ref('')
  // 新错误出现时清除旧的成功提示，避免过期成功信息与新错误同屏误导
  watch(error, (v) => {
    if (v) success.value = ''
  })

  // 自动下发（仅在串口模式显示；由组件负责确认弹窗与串口写）
  const autoSend = ref(false)

  // ============ 调参历史 / 自动调参 ============
  const tuningHistory = ref([])
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

  // ============ 参数变化高亮 ============
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
  function isParamChanged(key) {
    const t = paramChangeHighlight[key]
    if (!t) return false
    return Date.now() - t < 5000
  }

  // ============ 当前参数总览（阶段 + 高亮 keyMap） ============
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
    const keyMap = cascade
      ? { '速度环Kp': 'speedKp', '速度环Ki': 'speedKi', '速度环Kd': 'speedKd',
          '位置环Kp': 'kp', '位置环Ki': 'ki', '位置环Kd': 'kd' }
      : { Kp: 'kp', Ki: 'ki', Kd: 'kd' }
    return { pid, ffItems, phase, keyMap }
  })

  // ============ I/D 开关切换时立即同步参数 ============
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

  // ============ 调参顺序管理 ============
  const pidParamNames = computed(() => [...strategy.value.defaultOrder])

  function rebuildTuningOrder() {
    const ffIds = Object.keys(feedforwardSelection)
    const pidNames = pidParamNames.value
    const keptItems = tuningOrder.value.filter((id) =>
      ffIds.includes(id) || pidNames.includes(id)
    )
    const newFfIds = ffIds.filter((id) => !keptItems.includes(id))
    const missingPid = pidNames.filter((id) => !keptItems.includes(id))
    tuningOrder.value = [...newFfIds, ...keptItems, ...missingPid]
  }
  // 前馈勾选变化时自动同步调参顺序（新增项默认置顶，取消勾选的项自动移除）
  watch(feedforwardSelection, () => {
    rebuildTuningOrder()
  }, { deep: true })

  function formatTuningOrderItem(item) {
    const ffItem = FEEDFORWARD_ITEMS_BY_ID[item]
    if (ffItem) {
      const shortName = ffItem.name.split(' ')[0]
      return `前馈·${shortName}`
    }
    return item
  }

  function moveTuningStep(index, offset) {
    const nextIndex = index + offset
    if (nextIndex < 0 || nextIndex >= tuningOrder.value.length) return
    const order = [...tuningOrder.value]
    ;[order[index], order[nextIndex]] = [order[nextIndex], order[index]]
    tuningOrder.value = order
  }

  // ============ 前馈勾选变更 ============
  function onFeedforwardGroupChange(groupId) {
    const selectedIds = feedforwardSelectedByGroup[groupId]
    const group = FEEDFORWARD_GROUPS.find((g) => g.id === groupId)
    if (!group) return
    Object.keys(feedforwardSelection).forEach((id) => {
      if (group.items.some((it) => it.id === id) && !selectedIds.includes(id)) {
        delete feedforwardSelection[id]
      }
    })
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

  // ============ 策略切换 ============
  function applyStrategyDefaults() {
    Object.keys(simulationConfig).forEach((key) => delete simulationConfig[key])
    Object.assign(simulationConfig, getStrategyConfig(strategyId.value))
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

  // ============ 参数应用 / 历史 ============
  function applyCandidate(pid, cascade) {
    if (!pid) return
    applyCanonicalPid(outputParams, pid, cascade)
    snapshotAndHighlightChange()
  }

  function appendHistory(record) {
    if (record) tuningHistory.value.push(record)
  }

  function clearAll() {
    response.value = []
    aiResult.value = ''
    aiParams.value = null
    deterministicMetrics.value = null
    localReasons.value = []
    error.value = ''
    success.value = ''
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

  // ============ 仿真 overrides（组件与引擎共用） ============
  function buildSimOverrides() {
    const overrides = { ...simulationConfig, feedforwardSelection: { ...feedforwardSelection } }
    if (strategyId.value === 'cascade_position') {
      overrides.positionKp = Number(outputParams.kp)
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

  // ============ 自动调参（引擎桥接） ============
  function cancelAutoTuning() {
    autoTuneCancel = true
  }

  /**
   * 启动自动调参闭环（引擎无 Vue 运行，本函数负责状态桥接）。
   * @param {object} opts { aiConfig, onRoundExtra } onRoundExtra(state) 由组件注入（如 emit 仿真数据）
   */
  async function startAutoTuning({ aiConfig = null, onRoundExtra = null } = {}) {
    autoTuning.value = true
    autoTuneCancel = false
    autoTuneStatus.value = ''
    const cascade = isCascade.value

    const result = await runEngine({
      settings: { ...autoTuneSettings },
      strategy: strategy.value,
      initialParams: readCanonicalPid(outputParams, cascade),
      initialHistory: tuningHistory.value,
      initialFeedforward: { ...feedforwardSelection },
      modelConfig: { ...simulationConfig },
      enableI: enableI.value,
      enableD: enableD.value,
      aiConfig,
      tuningOrder: tuningOrder.value.map(formatTuningOrderItem),
      onRound: async (state) => {
        autoTuneRound.value = state.round
        autoTuneStatus.value = state.statusText
        if (state.samples) response.value = state.samples
        if (state.params) applyCandidate(state.params, cascade)
        // 引擎本轮前馈系数
        Object.keys(state.feedforward || {}).forEach((id) => {
          if (Object.prototype.hasOwnProperty.call(state.feedforward, id)) {
            feedforwardSelection[id] = state.feedforward[id]
          }
        })
        Object.keys(feedforwardSelection).forEach((id) => {
          if (!state.feedforward || !(id in state.feedforward)) delete feedforwardSelection[id]
        })
        if (state.history) tuningHistory.value = [...state.history]
        if (onRoundExtra) await onRoundExtra(state)
        // 每轮给 UI 短暂刷新时间（等价原组件里 await setTimeout 让界面呈现轮次过程）
        await new Promise((r) => setTimeout(r, 60))
      },
      onCancel: () => autoTuneCancel
    })

    tuningSession = result.session
    tuningHistory.value = [...result.history]
    // 终止/取消后把引擎最终参数（含取消时恢复的最佳参数）写回并同步前馈
    applyCandidate(result.finalPid, cascade)
    applyFeedforwardSync(result.finalFeedforward)
    autoTuneStatus.value = result.outcome.reason || autoTuneStatus.value
    autoTuning.value = false
    autoTuneRound.value = 0
    return result

    function applyFeedforwardSync(ff) {
      Object.keys(ff || {}).forEach((id) => {
        if (Object.prototype.hasOwnProperty.call(ff, id)) feedforwardSelection[id] = ff[id]
      })
      Object.keys(feedforwardSelection).forEach((id) => {
        if (!ff || !(id in ff)) delete feedforwardSelection[id]
      })
    }
  }

  return {
    // refs / reactive
    testMode, strategyId, simulationConfig, simulationStatus, strategy, strategyOptions, isCascade,
    feedforwardSelection, feedforwardSelectedByGroup, feedforwardFormulaText, feedforwardMaskLiteral,
    outputParams, enableI, enableD, tuningOrder,
    response, analyzing, deterministicMetrics, aiParams, aiResult, localReasons, error, success, autoSend,
    tuningHistory, autoTuning, autoTuneRound, autoTuneStatus, autoTuneSettings,
    // computeds
    currentParamsOverview, pidParamNames,
    // functions
    isParamChanged, snapshotAndHighlightChange,
    formatTuningOrderItem, moveTuningStep, onFeedforwardGroupChange, clearFeedforward,
    applyStrategyDefaults, buildSimOverrides,
    applyCandidate, appendHistory, clearAll,
    cancelAutoTuning, startAutoTuning
  }
}