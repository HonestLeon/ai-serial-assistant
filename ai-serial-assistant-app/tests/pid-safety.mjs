// 验证 pidSafety.mjs 与 controlAnalysis.mjs 的 status 字段
import { analyzeControlSamples } from '../src/renderer/src/services/controlAnalysis.mjs'
import {
  applyPidGuardrails,
  buildFallbackSuggestion,
  scoreMetrics,
  maybeUpdateBestResult,
  shouldRollbackToBest,
  isMetricsAcceptable
} from '../src/renderer/src/services/pidSafety.mjs'
import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'

let pass = 0, fail = 0
function assert(name, cond) {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name) }
}

console.log('1. analyzeControlSamples 新增 status 字段')
{
  const r = simulatePidStrategy('motor_speed', {})
  const m = analyzeControlSamples(r.samples, { overshootLimit: 20, oscillationLimit: 10 })
  assert('metrics 含 status 字段', typeof m.status === 'string')
  assert('默认参数 status 应为 STABLE', m.status === 'STABLE')
  console.log('     status =', m.status, ', rmse =', m.rmse, ', overshoot =', m.overshoot)
}

console.log('2. 振荡场景应判定为 OSCILLATING')
{
  // 故意用过大 kp 制造振荡
  const r = simulatePidStrategy('motor_speed', { kp: 10, ki: 8, kd: 0.001 })
  const m = analyzeControlSamples(r.samples, { overshootLimit: 20, oscillationLimit: 10 })
  console.log('     status =', m.status, ', overshoot =', m.overshoot, ', oscillation =', m.oscillation)
  assert('应非 STABLE', m.status !== 'STABLE')
}

console.log('3. applyPidGuardrails 单步增幅限制')
{
  const cur = { kp: 2, ki: 1, kd: 0.5 }
  const proposed = { kp: 10, ki: 5, kd: 2 }  // kp 想翻 5 倍
  const g = applyPidGuardrails(cur, proposed)
  assert('kp 应被裁到 6 (2*3)', g.params.kp === 6)
  assert('应有裁剪 note', g.notes.length > 0)
  console.log('     notes =', g.notes)
}

console.log('4. applyPidGuardrails 边界裁剪')
{
  const cur = { kp: 1, ki: 1, kd: 1 }
  const proposed = { kp: 100, ki: 50, kd: 50 }
  const g = applyPidGuardrails(cur, proposed)
  assert('kp 不超过 20', g.params.kp <= 20)
  assert('ki 不超过 10', g.params.ki <= 10)
  assert('kd 不超过 10', g.params.kd <= 10)
}

console.log('5. buildFallbackSuggestion 按状态生成保守建议（分阶段）')
{
  // P 阶段：只调 P
  const m1 = { status: 'OSCILLATING', steadyError: 0.5 }
  const c1 = { kp: 4, ki: 0, kd: 0 }
  const f1 = buildFallbackSuggestion(m1, c1)
  assert('P 阶段：震荡时 Kp 应降低', f1.params.kp < c1.kp)
  assert('P 阶段：Ki 应保持为 0', f1.params.ki === 0)
  assert('P 阶段：Kd 应保持为 0', f1.params.kd === 0)
  console.log('     P阶段 reason =', f1.reason, ', phase =', f1.phase)

  // PI 阶段：P 和 I 可调，D 保持为 0
  const m2 = { status: 'SLOW_RESPONSE', steadyError: 2 }
  const c2 = { kp: 4, ki: 0.5, kd: 0 }
  const f2 = buildFallbackSuggestion(m2, c2)
  assert('PI 阶段：响应慢时 Ki 应增大', f2.params.ki > c2.ki)
  assert('PI 阶段：Kd 应保持为 0', f2.params.kd === 0)
  console.log('     PI阶段 reason =', f2.reason, ', phase =', f2.phase)

  // PID 阶段：震荡时 D 可增大
  const m3 = { status: 'OSCILLATING', steadyError: 0.5 }
  const c3 = { kp: 4, ki: 2, kd: 0.5 }
  const f3 = buildFallbackSuggestion(m3, c3)
  assert('PID 阶段：震荡时 Kp 应降低', f3.params.kp < c3.kp)
  assert('PID 阶段：震荡时 D 应增大', f3.params.kd > c3.kd)
  console.log('     PID阶段 reason =', f3.reason, ', phase =', f3.phase)

  // 噪声约束：噪声大时 D 强制为 0
  const m4 = { status: 'STABLE', steadyError: 0.1, oscillation: 15, limits: { oscillation: 10 } }
  const c4 = { kp: 4, ki: 2, kd: 0.5 }
  const f4 = buildFallbackSuggestion(m4, c4)
  assert('噪声大时 Kd 应强制为 0', f4.params.kd === 0)
  console.log('     噪声约束 reason =', f4.reason)

  // STABLE 且 P 阶段 → 应进入 PI 阶段
  const m5 = { status: 'STABLE', steadyError: 0.1, oscillation: 2, limits: { oscillation: 10 } }
  const c5 = { kp: 4, ki: 0, kd: 0 }
  const f5 = buildFallbackSuggestion(m5, c5)
  assert('P 阶段稳定后应进入 PI（Ki > 0）', f5.params.ki > 0)
  console.log('     P→PI 升级 reason =', f5.reason, ', phase =', f5.phase)
}

console.log('6. scoreMetrics 越低越好')
{
  const stable = { valid: true, status: 'STABLE', rmse: 0.5, steadyError: 0.1, overshoot: 5, oscillation: 2 }
  const oscillating = { valid: true, status: 'OSCILLATING', rmse: 2, steadyError: 1, overshoot: 15, oscillation: 8 }
  const s1 = scoreMetrics(stable)
  const s2 = scoreMetrics(oscillating)
  assert('STABLE 评分 < OSCILLATING 评分', s1 < s2)
  console.log('     STABLE =', s1, ', OSCILLATING =', s2)
}

console.log('7. maybeUpdateBestResult 仅在 STABLE 时更新')
{
  const stableMetrics = { valid: true, status: 'STABLE', rmse: 0.5, steadyError: 0.1, overshoot: 5, oscillation: 2 }
  const oscillMetrics = { valid: true, status: 'OSCILLATING', rmse: 2, steadyError: 1, overshoot: 15, oscillation: 8 }
  let best = null
  best = maybeUpdateBestResult(best, { pid: { kp: 1 }, metrics: oscillMetrics, round: 1 })
  assert('OSCILLATING 不应更新最佳', best === null)
  best = maybeUpdateBestResult(best, { pid: { kp: 2 }, metrics: stableMetrics, round: 2 })
  assert('STABLE 应更新最佳', best !== null && best.pid.kp === 2)
  const betterStable = { valid: true, status: 'STABLE', rmse: 0.3, steadyError: 0.05, overshoot: 3, oscillation: 1 }
  best = maybeUpdateBestResult(best, { pid: { kp: 3 }, metrics: betterStable, round: 3 })
  assert('更优 STABLE 应再次更新', best.pid.kp === 3)
}

console.log('8. shouldRollbackToBest 劣化判定')
{
  const bestMetrics = { valid: true, status: 'STABLE', rmse: 0.5, steadyError: 0.1, overshoot: 5, oscillation: 2 }
  const best = { pid: { kp: 2 }, metrics: bestMetrics, score: 1, round: 1 }
  // 当前 OSCILLATING → 立即回退
  const badMetrics = { valid: true, status: 'OSCILLATING', rmse: 3, steadyError: 2, overshoot: 25, oscillation: 15 }
  const r1 = shouldRollbackToBest(best, badMetrics)
  assert('状态退化应回退', r1.shouldRollback)
  // 当前仍 STABLE 但 rmse 明显劣化 → 回退
  const worseStable = { valid: true, status: 'STABLE', rmse: 2, steadyError: 0.1, overshoot: 5, oscillation: 2 }
  const r2 = shouldRollbackToBest(best, worseStable)
  assert('量化劣化应回退', r2.shouldRollback)
  // 当前更好 → 不回退
  const betterMetrics = { valid: true, status: 'STABLE', rmse: 0.3, steadyError: 0.05, overshoot: 3, oscillation: 1 }
  const r3 = shouldRollbackToBest(best, betterMetrics)
  assert('更优不应回退', !r3.shouldRollback)
}

console.log('9. isMetricsAcceptable 终止条件')
{
  const good = { valid: true, status: 'STABLE', rmse: 0.3, steadyError: 0.1, overshoot: 5, stepSize: 10 }
  const r1 = isMetricsAcceptable(good, { rmseLimit: 0.5, steadyErrorLimit: 0.2, overshootLimit: 10 })
  assert('达标应 done', r1.done)
  const bad = { valid: true, status: 'OSCILLATING', rmse: 2, steadyError: 1, overshoot: 25, stepSize: 10 }
  const r2 = isMetricsAcceptable(bad, { rmseLimit: 0.5, steadyErrorLimit: 0.2, overshootLimit: 10 })
  assert('未达标不应 done', !r2.done)
  const notStable = { valid: true, status: 'OVERSHOOTING', rmse: 0.3, steadyError: 0.1, overshoot: 5, stepSize: 10 }
  const r3 = isMetricsAcceptable(notStable, { rmseLimit: 0.5, steadyErrorLimit: 0.2, overshootLimit: 10 })
  assert('非 STABLE 不应 done', !r3.done)
}

console.log('\n========================================')
console.log(`通过 ${pass} 项, 失败 ${fail} 项`)
console.log('========================================')
process.exit(fail > 0 ? 1 : 0)
