import { analyzeControlSamples, buildPidSuggestion } from '../src/renderer/src/services/controlAnalysis.mjs'
import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'

function extractLastGoodKp(history, overshootLimit) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    const kp = Number(h.pid.kp) || 0
    if (kp > 0 && h.pid.ki === 0 && h.pid.kd === 0) {
      if ((h.metrics.overshoot ?? 0) <= overshootLimit && !h.metrics.hasSignificantOscillation) return kp
    }
  }
  return null
}
function extractLastBadKp(history, overshootLimit) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    const kp = Number(h.pid.kp) || 0
    if (kp > 0 && h.pid.ki === 0 && h.pid.kd === 0) {
      if ((h.metrics.overshoot ?? 0) > overshootLimit * 1.2 || h.metrics.hasSignificantOscillation) return kp
    }
  }
  return null
}

let cur = { kp: 1.0, ki: 0, kd: 0 }
const history = []
const limit = 10
console.log('P→PI 收敛验证（上下界差 < 均值 10%）：')
for (let i = 0; i < 20; i++) {
  const r = simulatePidStrategy('motor_speed', { ...cur })
  const met = analyzeControlSamples(r.samples, { overshootLimit: limit, oscillationLimit: 10 })
  const lastGoodKp = extractLastGoodKp(history, limit)
  const lastBadKp = extractLastBadKp(history, limit)
  history.push({ round: i + 1, pid: { ...cur }, metrics: { ...met } })
  const sug = buildPidSuggestion(met, cur, { lastGoodKp, lastBadKp })
  const tag = met.hasSignificantOscillation ? '震荡' : (met.overshoot > limit * 1.2 ? '超调' : '好')
  const diff = (lastGoodKp && lastBadKp) ? (lastBadKp - lastGoodKp).toFixed(3) : '-'
  const mean10 = (lastGoodKp && lastBadKp) ? (((lastGoodKp + lastBadKp) / 2) * 0.1).toFixed(3) : '-'
  console.log(`轮${i + 1}: kp=${cur.kp.toFixed(3)} → ${sug.kp.toFixed(3)} [${tag}] | 超调=${met.overshoot}% | 下界=${lastGoodKp?.toFixed(3) ?? '-'} 上界=${lastBadKp?.toFixed(3) ?? '-'} 差=${diff} 阈=${mean10} | ${sug.reasons[0].slice(0, 50)}`)
  cur = { kp: sug.kp, ki: sug.ki, kd: sug.kd }
  if (sug.phase !== 'P') { console.log(`  → 进入 ${sug.phase} 阶段（Kp=${cur.kp.toFixed(3)}, Ki=${cur.ki}）`); break }
}
