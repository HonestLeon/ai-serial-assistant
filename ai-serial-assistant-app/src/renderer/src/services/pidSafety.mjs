/**
 * PID 调参安全护栏与闭环辅助（借鉴 llm-pid-tuner 的 pid_safety.py）。
 *
 * 提供五项能力，全部为纯函数（无副作用，便于测试）：
 *   1. applyPidGuardrails      — 参数裁剪 + 单步增幅限制（防 LLM 一拍脑袋给 10 倍参数炸设备）
 *   2. buildFallbackSuggestion — LLM 不可用时按当前 status 给保守建议，保证流程不中断
 *   3. scoreMetrics            — 对指标打分（越低越好），用于“最佳记录”与“劣化判定”
 *   4. maybeUpdateBestResult   — 仅在 STABLE 时更新最佳，避免回滚到坏参数
 *   5. shouldRollbackToBest    — 明显劣化时建议回退到最佳参数
 *
 * 与 controlAnalysis.mjs / pidSimulation.mjs 解耦：本模块只接收已经算好的 metrics
 * 与 PID 参数对象，不关心它们是怎么来的。
 */

function finite(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// 与 controlAnalysis.mjs 的 PARAM_BOUNDS 保持一致
const PID_LIMITS = {
  kp:         { min: 0, max: 20, maxIncreaseRatio: 3.0 },
  ki:         { min: 0, max: 10, maxIncreaseRatio: 4.0 },
  kd:         { min: 0, max: 10, maxIncreaseRatio: 4.0 },
  positionKp: { min: 0, max: 20, maxIncreaseRatio: 3.0 },
  positionKi: { min: 0, max: 10, maxIncreaseRatio: 4.0 },
  positionKd: { min: 0, max: 10, maxIncreaseRatio: 4.0 },
  speedKp:    { min: 0, max: 20, maxIncreaseRatio: 3.0 },
  speedKi:    { min: 0, max: 10, maxIncreaseRatio: 4.0 },
  speedKd:    { min: 0, max: 10, maxIncreaseRatio: 4.0 }
}

/**
 * 安全护栏：先按 min/max 裁剪，再按 maxIncreaseRatio 限制单步增幅。
 * 例如当前 Kp=2、LLM 给 Kp=10，则裁到 min(20, 2*3)=6，并在 notes 中记录。
 *
 * @param {object} current  当前参数 { kp, ki, kd, ... }
 * @param {object} proposed  LLM/规则给出的新参数
 * @returns {{ params: object, notes: string[] }}
 */
export function applyPidGuardrails(current, proposed) {
  const keys = Object.keys(proposed).filter((k) => k in PID_LIMITS)
  const out = {}
  const notes = []
  keys.forEach((k) => {
    const lim = PID_LIMITS[k]
    const cur = finite(current[k], 0)
    let v = finite(proposed[k], cur)
    // 单步增幅限制：新值不得超过 cur * maxIncreaseRatio（仅在 cur>0 时生效）
    if (cur > 1e-9) {
      const maxAllowed = cur * lim.maxIncreaseRatio
      if (v > maxAllowed) {
        notes.push(`${k}: ${proposed[k]} → ${maxAllowed.toFixed(4)}（受单步增幅限制 ×${lim.maxIncreaseRatio}）`)
        v = maxAllowed
      }
    }
    // 边界裁剪
    if (v > lim.max) { notes.push(`${k}: ${v} → ${lim.max}（超过上限）`); v = lim.max }
    if (v < lim.min) { notes.push(`${k}: ${v} → ${lim.min}（低于下限）`); v = lim.min }
    out[k] = Number(v.toFixed(6))
  })
  return { params: out, notes }
}

/**
 * LLM 不可用 / 返回异常时的保底策略：遵循 P→PI→PID 分阶段调参，与 buildPidSuggestion 同策略。
 *
 * @param {object} metrics  analyzeControlSamples 的结果（需含 status 字段）
 * @param {object} current  当前参数
 * @returns {{ params: object, reason: string }}
 */
export function buildFallbackSuggestion(metrics, current, options = {}) {
  const eps = 1e-6
  const keys = Object.keys(current).filter((k) => k in PID_LIMITS)
  // 推断当前阶段（与 buildPidSuggestion 一致）
  const pKey = keys.find((k) => k === 'kp' || k === 'positionKp' || k === 'speedKp')
  const iKey = keys.find((k) => k === 'ki' || k === 'positionKi' || k === 'speedKi')
  const dKey = keys.find((k) => k === 'kd' || k === 'positionKd' || k === 'speedKd')
  const pOn = pKey ? finite(current[pKey], 0) > eps : false
  const iOn = iKey ? finite(current[iKey], 0) > eps : false
  const dOn = dKey ? finite(current[dKey], 0) > eps : false
  let phase
  if (!pOn && !iOn && !dOn) phase = 'P'
  else if (pOn && !iOn && !dOn) phase = 'P'
  else if (pOn && iOn && !dOn) phase = 'PI'
  else phase = 'PID'

  // 噪声约束
  const noisy = finite(metrics?.oscillation, 0) > finite(metrics?.limits?.oscillation, 10) * 1.2

  // 上一个无超调无震荡的 Kp（用于 P 阶段二分法下界）
  const lastGoodKp = finite(options.lastGoodKp, 0)
  // 上一个超调/震荡的 Kp（用于 P 阶段二分法上界）
  const lastBadKp = finite(options.lastBadKp, 0)
  const currentKp = pKey ? finite(current[pKey], 0) : 0
  // P 阶段减小 Kp 时是否可用二分法（当前坏 + 有下界）
  const canBisectDown = phase === 'P' && lastGoodKp > 0 && lastGoodKp < currentKp
  // P 阶段当前好但有上界 → 继续二分逼近上界
  const canBisectUp = phase === 'P' && lastBadKp > 0 && currentKp < lastBadKp
  // 二分区间是否已收敛（上下界差 < 上下界均值的 10%）
  const bisectMean = (lastGoodKp > 0 && lastBadKp > 0) ? (lastGoodKp + lastBadKp) / 2 : 0
  const bisectConverged = phase === 'P' && lastGoodKp > 0 && lastBadKp > 0
    && (lastBadKp - lastGoodKp) < bisectMean * 0.1

  const factor = { P: 1, I: 1, D: 1 }
  // 二分法目标值（非 null 时直接设定，覆盖因子）
  let bisectP = null
  let reason = '保底策略：'
  switch (metrics?.status) {
    case 'OSCILLATING':
      if (phase === 'P' && bisectConverged) {
        // P 阶段二分区间已收敛 → 进入 PI（即使当前震荡）
        factor.I = 0.5
        reason += `P 阶段二分区间已收敛（下界 ${lastGoodKp.toFixed(3)} ↔ 上界 ${lastBadKp.toFixed(3)}），进入 PI 阶段加 Ki`
        phase = 'PI'
      } else if (phase === 'PID') { factor.P = 0.85; factor.I = 0.85; factor.D = 1.2; reason += '检测到震荡，降低当前活跃项' }
      else if (phase === 'PI') { factor.P = 0.85; factor.I = 0.85; reason += '检测到震荡，降低当前活跃项' }
      else if (canBisectDown) {
        bisectP = (lastGoodKp + currentKp) / 2
        reason += `P 阶段检测到震荡，二分法取中间值 Kp=${bisectP.toFixed(3)}（下界 ${lastGoodKp.toFixed(3)} ↔ 当前 ${currentKp.toFixed(3)}）`
      }
      else { factor.P = 0.8; reason += '检测到震荡，降低当前活跃项' }
      break
    case 'OVERSHOOTING':
      if (phase === 'P' && bisectConverged) {
        // P 阶段二分区间已收敛 → 进入 PI（即使当前超调）
        factor.I = 0.5
        reason += `P 阶段二分区间已收敛（下界 ${lastGoodKp.toFixed(3)} ↔ 上界 ${lastBadKp.toFixed(3)}），进入 PI 阶段加 Ki`
        phase = 'PI'
      } else if (phase === 'PID') { factor.P = 0.9; factor.D = 1.15; reason += '检测到超调，降低当前活跃项' }
      else if (phase === 'PI') { factor.P = 0.9; factor.I = 0.9; reason += '检测到超调，降低当前活跃项' }
      else if (canBisectDown) {
        bisectP = (lastGoodKp + currentKp) / 2
        reason += `P 阶段检测到超调，二分法取中间值 Kp=${bisectP.toFixed(3)}（下界 ${lastGoodKp.toFixed(3)} ↔ 当前 ${currentKp.toFixed(3)}）`
      }
      else { factor.P = 0.85; reason += '检测到超调，降低当前活跃项' }
      break
    case 'SLOW_RESPONSE':
      if (phase === 'P') { factor.P = 1.25 }
      else if (phase === 'PI') { factor.I = 1.2 }
      else { factor.P = 1.1; factor.I = 1.1 }
      reason += '响应过慢，增大当前活跃项'
      break
    default:
      // STABLE
      if (phase === 'P') {
        if (bisectConverged) {
          // 二分区间已收敛 → 进入 PI
          factor.I = 0.5
          reason += `P 阶段二分区间已收敛（下界 ${lastGoodKp.toFixed(3)} ↔ 上界 ${lastBadKp.toFixed(3)}），进入 PI 阶段加 Ki`
          phase = 'PI'
        } else if (canBisectUp) {
          // 当前好但有上界 → 继续二分逼近上界（避免走增大分支跳过上界）
          bisectP = (currentKp + lastBadKp) / 2
          reason += `P 阶段当前 Kp=${currentKp.toFixed(3)} 无超调，继续二分逼近上界 Kp=${bisectP.toFixed(3)}（当前 ${currentKp.toFixed(3)} ↔ 上界 ${lastBadKp.toFixed(3)}）`
        } else {
          // 无上界 → P 阶段稳定且不超调，进入 PI（开 I）
          factor.I = 0.5  // 从小开始
          reason += 'P 阶段已稳定，进入 PI 阶段加 Ki'
          phase = 'PI'
        }
      } else if (phase === 'PI') {
        if (Math.abs(finite(metrics?.steadyError, 0)) > 1) {
          factor.I = 1.15
          reason += '稳态误差偏大，小幅增大 Ki'
        } else if (!noisy) {
          factor.D = 0.5  // 从小开始
          reason += 'PI 阶段已稳定，进入 PID 阶段加 Kd'
          phase = 'PID'
        } else {
          factor.I = 1.05
          reason += '稳态误差已消除且噪声大，维持 PI（不加 D）'
        }
      } else {
        factor.D = 1.1
        reason += 'PID 已稳定，微调 Kd 优化阻尼'
      }
  }

  const out = {}
  keys.forEach((k) => {
    if (!(k in PID_LIMITS)) return
    const role = k.toLowerCase().includes('kp') ? 'P'
      : k.toLowerCase().includes('ki') ? 'I'
      : 'D'
    // 阶段约束
    if (phase === 'P' && role !== 'P') { out[k] = 0; return }
    if (phase === 'PI' && role === 'D') { out[k] = 0; return }
    // 噪声约束：噪声大时 D 强制为 0
    if (role === 'D' && noisy) { out[k] = 0; return }
    // 从零开始升级时给一个初始小值，否则 0×factor 永远是 0
    const cur = finite(current[k], 0)
    if (cur < 1e-9 && role === 'I' && phase === 'PI') {
      out[k] = 0.3
      return
    }
    if (cur < 1e-9 && role === 'D' && phase === 'PID') {
      out[k] = 0.05
      return
    }
    // 二分法：P 阶段减小 Kp 时直接设定目标值，覆盖因子计算
    if (role === 'P' && bisectP !== null) {
      out[k] = Number(clamp(bisectP, 0, PID_LIMITS[k].max).toFixed(6))
      return
    }
    const v = cur * factor[role]
    out[k] = Number(clamp(v, 0, PID_LIMITS[k].max).toFixed(6))
  })
  return { params: out, reason, phase }
}

/**
 * 指标评分（越低越好）。综合平均误差、稳态误差、超调、状态惩罚。
 * 用于“最佳记录”比较与“劣化判定”。
 *
 * @param {object} metrics  analyzeControlSamples 的结果（需含 status 字段）
 * @returns {number}
 */
export function scoreMetrics(metrics) {
  if (!metrics || !metrics.valid) return Infinity
  const avgErr = finite(metrics.rmse, 0)            // 用 rmse 代替 avg_error
  const steadyErr = Math.abs(finite(metrics.steadyError, 0))
  const overshoot = finite(metrics.overshoot, 0)
  const oscillation = finite(metrics.oscillation, 0)
  let statusPenalty = 0
  switch (metrics.status) {
    case 'OSCILLATING':   statusPenalty = 12; break
    case 'OVERSHOOTING':  statusPenalty = 8;  break
    case 'SLOW_RESPONSE': statusPenalty = 6;  break
    default:              statusPenalty = 0         // STABLE
  }
  return avgErr + steadyErr * 1.2 + overshoot * 0.6 + oscillation * 0.3 + statusPenalty
}

/**
 * 判定是否更新最佳记录：仅在 STABLE 时更新，避免回滚到坏参数。
 *
 * @param {object|null} best   当前最佳 { pid, metrics, score }
 * @param {object} current     当前 { pid, metrics }
 * @returns {object|null}      新的最佳（若不更新则返回原 best）
 */
export function maybeUpdateBestResult(best, current) {
  if (!current?.metrics?.valid) return best
  if (current.metrics.status !== 'STABLE') return best
  const score = scoreMetrics(current.metrics)
  if (!best || score < best.score) {
    return {
      pid: { ...current.pid },
      metrics: { ...current.metrics },
      score,
      round: current.round
    }
  }
  return best
}

/**
 * 判定是否应回退到最佳参数。
 *  - best 必须存在且 STABLE，current 非 STABLE → 立即回退
 *  - 或 avg/steady/overshoot 任一明显劣化（ratio + margin 双阈值）→ 回退
 *
 * @param {object|null} best
 * @param {object} currentMetrics
 * @returns {{ shouldRollback: boolean, reason: string }}
 */
export function shouldRollbackToBest(best, currentMetrics) {
  if (!best || !best.metrics || !currentMetrics?.valid) {
    return { shouldRollback: false, reason: '' }
  }
  // 1. best STABLE 且 current 非 STABLE → 立即回退
  if (best.metrics.status === 'STABLE' && currentMetrics.status !== 'STABLE') {
    return {
      shouldRollback: true,
      reason: `状态由 ${best.metrics.status} 退化为 ${currentMetrics.status}，回退到最佳参数`
    }
  }
  // 2. 量化劣化判定
  const checks = [
    { name: 'rmse',        best: best.metrics.rmse,        cur: currentMetrics.rmse },
    { name: 'steadyError', best: Math.abs(best.metrics.steadyError), cur: Math.abs(currentMetrics.steadyError) },
    { name: 'overshoot',   best: best.metrics.overshoot,   cur: currentMetrics.overshoot }
  ]
  for (const c of checks) {
    const b = finite(c.best, 0)
    const cur = finite(c.cur, 0)
    // 双阈值：相对劣化 > 1.3 倍 且 绝对增量 > 0.5
    if (cur > b * 1.3 && cur - b > 0.5) {
      return {
        shouldRollback: true,
        reason: `${c.name} 由 ${b.toFixed(3)} 劣化到 ${cur.toFixed(3)}，回退到最佳参数`
      }
    }
  }
  return { shouldRollback: false, reason: '' }
}

/**
 * 终止条件判定：是否已达到可接受的状态。
 *  - status === STABLE
 *  - rmse / |steadyError| / overshoot 均在阈值内
 *
 * @param {object} metrics
 * @param {object} opts  { rmseLimit, steadyErrorLimit, overshootLimit }
 * @returns {{ done: boolean, reason: string }}
 */
export function isMetricsAcceptable(metrics, opts = {}) {
  if (!metrics?.valid) return { done: false, reason: '' }
  if (metrics.status !== 'STABLE') return { done: false, reason: '' }
  const rmseLimit = finite(opts.rmseLimit, 1.0)
  const steadyErrorLimit = finite(opts.steadyErrorLimit, 0.5)
  const overshootLimit = finite(opts.overshootLimit, 10)
  if (finite(metrics.rmse, Infinity) > rmseLimit) {
    return { done: false, reason: `rmse ${metrics.rmse} > ${rmseLimit}` }
  }
  if (Math.abs(finite(metrics.steadyError, Infinity)) > steadyErrorLimit) {
    return { done: false, reason: `稳态误差 ${metrics.steadyError} 超过 ${steadyErrorLimit}` }
  }
  if (finite(metrics.overshoot, Infinity) > overshootLimit) {
    return { done: false, reason: `超调 ${metrics.overshoot}% 超过 ${overshootLimit}%` }
  }
  return { done: true, reason: '已达标：STABLE + 各指标在阈值内' }
}
