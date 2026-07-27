/**
 * 调参过程诊断脚本：打印每轮的关键信息
 */
import { analyzeControlSamples, buildPidSuggestion } from '../src/renderer/src/services/controlAnalysis.mjs'
import { simulatePidStrategy, PID_STRATEGIES } from '../src/renderer/src/services/pidSimulation.mjs'

function extractLastGoodKp(history, cascade, overshootLimit, unstable = false) {
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
        const oscOk = (m.oscillation ?? 0) <= 5
        if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation && oscOk) return kp
      } else {
        if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation) return kp
      }
    }
  }
  return null
}
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
        if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation || oscOverLimit) return kp
      } else {
        if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation) return kp
      }
    }
  }
  return null
}

function diagnose(strategyId, overrides, maxRounds = 30) {
  console.log(`\n--- ${strategyId} ${JSON.stringify(overrides)} ---`)
  const strategy = PID_STRATEGIES[strategyId]
  const cascade = strategyId === 'cascade_position'
  const unstable = !!strategy.unstable
  const overshootLimit = strategy.acceptance.overshootLimit
  let current = unstable
    ? { kp: 0, ki: 0, kd: strategy.defaults.kd || 1.0 }
    : cascade
      ? { speedKp: 1.0, speedKi: 0, speedKd: 0, positionKp: 3, positionKi: 0, positionKd: 0 }
      : { kp: 1.0, ki: 0, kd: 0 }
  const history = []
  const kpKey = cascade ? 'speedKp' : 'kp'
  for (let round = 1; round <= maxRounds; round += 1) {
    const sim = simulatePidStrategy(strategyId, { ...current, ...overrides }, 20260723 + round)
    const m = analyzeControlSamples(sim.samples, { ...strategy.acceptance })
    const lgKp = extractLastGoodKp(history, cascade, overshootLimit, unstable)
    const lbKp = extractLastBadKp(history, cascade, overshootLimit, unstable)
    history.push({ round, pid: { ...current }, metrics: { ...m } })
    const sug = buildPidSuggestion(m, current, { tuningOrder: strategy.defaultOrder, lastGoodKp: lgKp || 0, lastBadKp: lbKp || 0, unstable })
    const ck = current[kpKey]
    const sk = sug[kpKey]
    const cki = cascade ? current.speedKi : current.ki
    const ski = cascade ? sug.speedKi : sug.ki
    const ckd = cascade ? current.speedKd : current.kd
    const skd = cascade ? sug.speedKd : sug.kd
    console.log(
      `R${round}: Kp=${ck.toFixed(3)}→${sk.toFixed(3)} Ki=${cki.toFixed(3)}→${ski.toFixed(3)} Kd=${ckd.toFixed(3)}→${skd.toFixed(3)} | ` +
      `超调=${m.overshoot}% 稳态误差=${m.steadyError} 振荡=${m.oscillation}% ` +
      `峰数=${m.oscillationPeakCount} 显著震荡=${m.hasSignificantOscillation} ` +
      `status=${m.status} | 下界=${lgKp?.toFixed(3) ?? '-'} 上界=${lbKp?.toFixed(3) ?? '-'} | ` +
      `${sug.phase} | ${sug.reasons[0]?.slice(0, 50) ?? ''}`
    )
    current = cascade
      ? { speedKp: sug.speedKp, speedKi: sug.speedKi, speedKd: sug.speedKd,
          positionKp: sug.positionKp, positionKi: sug.positionKi, positionKd: sug.positionKd }
      : { kp: sug.kp, ki: sug.ki, kd: sug.kd }
  }
}

// 电机C：小惯量大阻尼，target=12
// diagnose('motor_speed', { J: 0.01, B: 0.20, Kt: 0.6, target: 12 }, 50)
// 串级C：小惯量大阻尼
diagnose('cascade_position', { J: 0.01, B: 0.20, Kt: 0.6, target: 0.8 }, 80)
