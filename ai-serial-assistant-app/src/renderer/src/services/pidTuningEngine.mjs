/**
 * PID 自动调参编排引擎（纯 JS，无 Vue / DOM / window 依赖）。
 *
 * 由 PidPanel.vue 的 runAutoTuning 抽取并接口化，逐行等价迁移（行为零变化）：
 *   每轮：仿真取样 → 确定性分析 → 会话状态机评价（rollback/complete/stagnated/max-rounds）
 *        → 前馈系数整定（可选）→ 生成下一轮候选（hybrid AI / local 本地规则 + 安全护栏）
 *
 * 引擎在内部自持全部调参状态（参数、前馈、历史、会话），可在 Node 环境独立运行；
 * 通过 onRound 回调把每轮快照推给调用方（组件）用于 UI 展示与写回。
 */

import {
  analyzeControlSamples,
  buildFeedforwardSuggestion
} from './controlAnalysis.mjs'
import {
  applyPidGuardrails,
  buildFallbackSuggestion
} from './pidSafety.mjs'
import {
  applyCanonicalPid,
  createTuningSession,
  registerTuningRound
} from './pidTuningSession.mjs'
import { simulatePidStrategy } from './pidSimulation.mjs'
import { callAiForPid as defaultCallAiForPid } from './pidAiClient.mjs'

/**
 * 从调参历史中提取上一个"好"的 Kp（P 阶段、超调在验收标准内、无明显震荡），用于二分法下界。
 * 单环返回 kp，串级返回当前活跃环（speedKp）。
 * 不稳定系统（倒立摆）：PD 阶段（Ki=0，Kd 可非零），好值额外要求稳态振幅<=3%。
 * 等价迁移自 PidPanel.vue extractLastGoodKp。
 */
export function extractLastGoodKp(history, cascade, overshootLimit, unstable = false) {
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
 * 不稳定系统：振荡>5%即视为坏值（PD 阶段放宽到 5%，不要求 STABLE）。
 * 等价迁移自 PidPanel.vue extractLastBadKp。
 */
export function extractLastBadKp(history, cascade, overshootLimit, unstable = false) {
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

/** 参数展示格式化（等价迁移自 PidPanel.vue formatParamsForDisplay）。 */
export function formatPidForDisplay(params, cascade) {
  if (!params) return ''
  if (cascade) {
    return `速度环 Kp=${params.speedKp}, Ki=${params.speedKi}, Kd=${params.speedKd}；位置环 Kp=${params.positionKp}, Ki=${params.positionKi}, Kd=${params.positionKd}`
  }
  return `Kp=${params.kp}, Ki=${params.ki}, Kd=${params.kd}`
}

/**
 * 组装仿真 overrides（等价迁移自 PidPanel.vue buildSimOverrides）：
 * 物理/信号参数来自 modelConfig + 前馈勾选；PID 参数来自 canonical currentPid，
 * 且尊重 enableI/enableD（关闭时强制对应项为 0）。
 */
export function prepareSimOverrides(strategyId, modelConfig, currentPid, feedforward, enableI, enableD) {
  const overrides = { ...modelConfig, feedforwardSelection: { ...feedforward } }
  if (strategyId === 'cascade_position') {
    overrides.positionKp = Number(currentPid.kp)
    overrides.positionKi = enableI ? Number(currentPid.ki) : 0
    overrides.positionKd = enableD ? Number(currentPid.kd) : 0
    overrides.speedKp = Number(currentPid.speedKp)
    overrides.speedKi = enableI ? Number(currentPid.speedKi) : 0
    overrides.speedKd = enableD ? Number(currentPid.speedKd) : 0
  } else {
    overrides.kp = Number(currentPid.kp)
    overrides.ki = enableI ? Number(currentPid.ki) : 0
    overrides.kd = enableD ? Number(currentPid.kd) : 0
  }
  return overrides
}

/** 将 pid 按 cascade 语义写回 canonical 目标对象（等价迁移自 applyCanonicalPid 用法）。 */
function applyCanonicalCopy(target, pid, cascade) {
  const out = { ...target }
  applyCanonicalPid(out, pid, cascade)
  return out
}

/** 包装 callAiForPid 的上下文：自动调参场景固定为仿真，组装模型信息与调参顺序。 */
function buildAiContext({
  aiConfig, metrics, currentPid, cascade, enableI, enableD,
  tuningHistory, samples, modelConfig, feedforward, tuningOrder, strategy,
  lastGoodKp, lastBadKp
}) {
  return {
    aiConfig,
    metrics,
    currentPid,
    cascade,
    enableI,
    enableD,
    tuningHistory,
    waveformSamples: samples,
    tuningOrder,
    scenario: `仿真测试；模型：${strategy.description}`,
    knownModelParams: { ...modelConfig },
    feedforwardSelection: { ...feedforward },
    lastGoodKp,
    lastBadKp
  }
}

/**
 * 运行一轮完整的自动调参闭环（可在 Node 环境独立执行）。
 *
 * @param {object} config
 *   - settings: { engine, maxRounds, requiredStable, patience }
 *   - strategy: PID_STRATEGIES 中的策略对象
 *   - initialParams: 初始 PID 参数（canonical 单环 kp/ki/kd 或串级 speed* / position*）
 *   - initialHistory: 既有调参历史（如手动轮），并入本会话供二分法等复用（默认 []）
 *   - initialFeedforward: 初始前馈勾选 { id: coeff }（默认 {}）
 *   - modelConfig: 仿真物理/信号配置（PID 部分会被 initialParams 覆盖）
 *   - enableI / enableD: I/D 开关（默认 true）
 *   - aiConfig: { baseUrl, model, apiKey }，engine='hybrid' 且有 Key 时启用 AI
 *   - aiClient: 可选的 AI 客户端实现（默认 pidAiClient.callAiForPid），用于测试注入 stub
 *   - tuningOrder: 已格式化的调参顺序字符串数组（前馈·x / Kp …，透传给 AI）
 *   - onRound: async (state) => {}  每轮回调：{ round, statusText, decision, reason,
 *       samples, roundRecord, history, params, feedforward }，组件据此同步 UI
 *   - onCancel: () => boolean  每轮开头检查，true 则中止（保留已完成轮次，恢复最佳参数）
 * @returns {Promise<{
 *   rounds: Array, history: Array, session: object, outcome: object,
 *   finalPid: object, finalFeedforward: object, cancelled: boolean, durationMs: number
 * }>}
 */
export async function runAutoTuning(config = {}) {
  const {
    settings = {},
    strategy,
    initialParams,
    initialHistory = [],
    initialFeedforward = {},
    modelConfig = {},
    enableI = true,
    enableD = true,
    aiConfig = null,
    aiClient = null,
    tuningOrder = [],
    onRound = null,
    onCancel = null
  } = config

  const cascade = strategy?.id === 'cascade_position'
  const useAi = settings.engine === 'hybrid' && Boolean(aiConfig?.apiKey)
  const callAi = aiClient || defaultCallAiForPid
  let tuningSession = createTuningSession(settings)
  const tuningHistory = [...initialHistory]
  let currentCanonical = { ...initialParams }
  let feedforward = { ...initialFeedforward }
  let cancelled = false
  let terminalOutcome = null
  const t0 = Date.now()
  let statusText = ''

  const emitRound = async (round, samples, decision, reason, roundRecord) => {
    if (!onRound) return
    await onRound({
      round,
      statusText,
      decision,
      reason,
      samples,
      roundRecord,
      history: [...tuningHistory],
      params: { ...currentCanonical },
      feedforward: { ...feedforward }
    })
  }

  for (let round = 1; round <= tuningSession.maxRounds; round += 1) {
    if (typeof onCancel === 'function' && onCancel()) {
      cancelled = true
      statusText = `已取消（完成 ${round - 1} 轮）`
      break
    }
    statusText = `第 ${round}/${tuningSession.maxRounds} 轮：验证当前参数…`

    // 1. 同步运行仿真（一次性算完）
    const testedPid = { ...currentCanonical }
    const overrides = prepareSimOverrides(strategy.id, modelConfig, testedPid, feedforward, enableI, enableD)
    const samples = simulatePidStrategy(strategy.id, overrides).samples
    await emitRound(round, samples, null, '', null)

    // 2. 分析指标
    const metrics = analyzeControlSamples(samples, { ...strategy.acceptance })
    if (!metrics.valid) {
      statusText = `第 ${round} 轮：数据无效，终止`
      terminalOutcome = { decision: 'invalid', reason: statusText }
      await emitRound(round, samples, 'invalid', statusText, null)
      break
    }

    // 3. 会话状态机先评价本轮，再决定完成、回退、停止或继续
    const registered = registerTuningRound(
      tuningSession,
      { pid: testedPid, metrics, round },
      {
        rmseLimit: Math.abs(metrics.stepSize) * 0.05,
        steadyErrorLimit: Math.abs(metrics.stepSize) * 0.02,
        overshootLimit: strategy.acceptance.overshootLimit
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
    tuningHistory.push(historyRecord)

    if (registered.outcome.applyPid) {
      currentCanonical = applyCanonicalCopy(currentCanonical, registered.outcome.applyPid, cascade)
    }
    if (registered.outcome.decision === 'rollback') {
      historyRecord.thought = '安全回退'
      statusText = `第 ${round} 轮：${registered.outcome.reason}`
      await emitRound(round, samples, 'rollback', registered.outcome.reason, registered.roundRecord)
      continue
    }
    if (registered.outcome.isTerminal) {
      historyRecord.thought = registered.outcome.decision === 'complete' ? '已达标' : '停止搜索'
      terminalOutcome = { ...registered.outcome, reason: statusText }
      statusText = `${registered.outcome.reason}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
      terminalOutcome.reason = statusText
      await emitRound(round, samples, registered.outcome.decision, statusText, registered.roundRecord)
      break
    }

    // 4. 为下一轮生成候选（前馈整定 + AI/本地候选）
    statusText = `第 ${round}/${tuningSession.maxRounds} 轮：生成下一轮候选…`
    await emitRound(round, samples, 'continue', '', registered.roundRecord)
    let proposedPid = null
    let thought = ''
    let source = '本地规则'
    let guardNotes = []
    // 前馈系数整定：当勾选了前馈项时，根据本轮指标启发式微调前馈系数
    let ffReasons = []
    if (Object.keys(feedforward).length) {
      const ffSuggestion = buildFeedforwardSuggestion(metrics, { ...feedforward }, { strategyId: strategy.id })
      ffReasons = ffSuggestion.reasons
      feedforward = { ...ffSuggestion.feedforward }
    }
    const lastGoodKp = extractLastGoodKp(tuningHistory, cascade, strategy.acceptance.overshootLimit, !!strategy.unstable)
    const lastBadKp = extractLastBadKp(tuningHistory, cascade, strategy.acceptance.overshootLimit, !!strategy.unstable)
    if (useAi) {
      const resultAi = await callAi(buildAiContext({
        aiConfig, metrics, currentPid: testedPid, cascade, enableI, enableD,
        tuningHistory, samples, modelConfig, feedforward, tuningOrder, strategy,
        lastGoodKp, lastBadKp
      }))
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
      const fallback = buildFallbackSuggestion(metrics, testedPid, { lastGoodKp, lastBadKp, unstable: !!strategy.unstable })
      const guarded = applyPidGuardrails(testedPid, fallback.params)
      proposedPid = guarded.params
      guardNotes = guarded.notes
      if (!thought) thought = fallback.reason
    }
    currentCanonical = applyCanonicalCopy(currentCanonical, proposedPid, cascade)
    historyRecord.proposedPid = { ...proposedPid }
    historyRecord.source = source
    historyRecord.thought = ffReasons.length ? `${ffReasons.join('；')}${thought ? ' | ' + thought : ''}` : thought
    historyRecord.analysis = `下一轮候选：${formatPidForDisplay(proposedPid, cascade)}`
    if (guardNotes.length) {
      historyRecord.analysis += `（护栏：${guardNotes.join('；')}）`
    }
    statusText = `第 ${round} 轮已验证；${source}已生成下一轮候选`
    await emitRound(round, samples, 'continue', statusText, registered.roundRecord)
  }

  // 取消：恢复目前已验证的最佳参数（bestStable || bestObserved）
  if (cancelled) {
    const best = tuningSession.bestStable || tuningSession.bestObserved
    if (best?.pid) {
      currentCanonical = applyCanonicalCopy(currentCanonical, best.pid, cascade)
      statusText += '；已恢复目前已验证的最佳参数'
    }
  }

  return {
    rounds: tuningHistory,
    history: tuningHistory,
    session: tuningSession,
    outcome: terminalOutcome || { decision: cancelled ? 'cancelled' : 'stopped', reason: statusText },
    finalPid: { ...currentCanonical },
    finalFeedforward: { ...feedforward },
    cancelled,
    durationMs: Date.now() - t0
  }
}