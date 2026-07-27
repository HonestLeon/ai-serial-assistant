import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'
import { analyzeMultiStepSamples } from '../src/renderer/src/services/controlAnalysis.mjs'

const acc = { overshootLimit: 10, settlingBand: 0.05, oscillationLimit: 10, riseTimeLimit: 0.3, settlingTimeLimit: 1.0 }

// B组纯P多阶跃，看各段hasSignificantOscillation和峰详情
const sim = simulatePidStrategy('motor_speed', { kp: 4.77, ki: 0, kd: 0, J: 0.05, B: 0.04, Kt: 0.4, target: 8, signal: 'multiStep', duration: 8, dt: 0.005 }, 20260727)
const m = analyzeMultiStepSamples(sim.samples, acc)
console.log('B组多阶跃:', 'overshoot='+m.overshoot, 'oscillation='+m.oscillation, 'hasSigOsc='+m.hasSignificantOscillation)
if (m.segments) m.segments.forEach((s) => console.log(`  段${s.index + 1}: 超调=${s.overshoot}% 振荡=${s.oscillation}% 上升=${s.riseTime}s 调节=${s.settlingTime}s`))

// 看段2和段4的原始样本（判断是否有真实振荡）
const samples = sim.samples
const jumps = []
for (let i = 1; i < samples.length; i += 1) {
  if (Math.abs(samples[i].target - samples[i - 1].target) > 0.1) jumps.push(i)
}
// 段4: 15→10 (实际是 target*1.5→target), jumps[3]
if (jumps.length >= 4) {
  const seg4Start = Math.max(0, jumps[3] - 1)
  const seg4 = samples.slice(seg4Start)
  console.log(`\n段4: 样本数=${seg4.length}, target=${seg4[1]?.target}`)
  // 输出段4前30样本看feedback轨迹
  seg4.slice(0, 30).forEach((s, i) => console.log(`  [${i}] t=${s.t.toFixed(3)} fb=${s.feedback.toFixed(4)}`))
}
