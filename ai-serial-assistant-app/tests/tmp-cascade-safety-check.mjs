/**
 * 串级（位置-速度）PID 安全回退误触发修复验证（临时脚本）。
 *
 * 背景：实测中发现串级策略 5s 仿真窗口内位置环未收敛时，feedback 单调爬升（无过零振荡），
 * 但 oscillation 包络幅度 / stepSize 会稳定超出安全限制（10~11%），导致每轮 set_target 后
 * 安全机制误判"振荡超限"而回退，调参无法推进。本轮修复：
 *   1. safety.mjs：振荡触发加"真振荡门槛"（hasSignificantOscillation / oscillationPeakCount > 0）；
 *   2. pidSafety.shouldRollbackToBest：跨工作点（stepSize/finalTarget 相对差 > 20%）豁免退化回退。
 *
 * 执行：node tests/tmp-cascade-safety-check.mjs
 */

import assert from 'node:assert/strict'
import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'
import { analyzeControlSamples } from '../src/renderer/src/services/controlAnalysis.mjs'
import { createSafetyGuard } from '../src/renderer/src/services/pidAgent/safety.mjs'
import { shouldRollbackToBest } from '../src/renderer/src/services/pidSafety.mjs'
import { createDefaultUserConfig } from '../src/renderer/src/services/pidAgent/types.mjs'

const fmt = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : `${v}`)

// ---------- 场景 1：串级慢收敛（真实仿真）→ 修复后不触发安全回退 ----------
{
  // 复现实测配置：位置环 Kp=5、速度环 Kp 偏小 → 位置响应慢，5s 内未到稳态
  const overrides = {
    target: 50,
    positionKp: 5,
    positionKi: 0,
    positionKd: 0,
    speedKp: 1,
    speedKi: 0,
    speedKd: 0
  }
  const { samples } = simulatePidStrategy('cascade_position', overrides)
  const last = samples[samples.length - 1]
  console.log(`[场景1] 串级慢收敛仿真：final feedback=${fmt(last.feedback)} / target=${fmt(last.target)}`)

  const metrics = analyzeControlSamples(samples, { overshootLimit: 20, oscillationLimit: 10 })
  console.log(
    `  指标: oscillation=${fmt(metrics.oscillation)}% · peakCount=${metrics.oscillationPeakCount} · ` +
    `hasSignificantOscillation=${metrics.hasSignificantOscillation} · status=${metrics.status}`
  )

  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  userConfig.acceptance.oscillationLimit = 10
  let pid = { positionKp: 5, positionKi: 0, positionKd: 0, speedKp: 1, speedKi: 0, speedKd: 0 }
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => ({ ...pid }),
    setPid: (p) => { pid = { ...p } }
  })
  const result = guard.onSamplesCollected(samples)
  console.log(`  安全检测 triggered=${result.triggered}（修复后应为 false）`)

  assert.equal(metrics.oscillationPeakCount, 0, '慢收敛应无过零振荡峰')
  assert.ok(metrics.oscillation > (metrics.limits?.oscillation ?? 10) * 0.9, '包络幅度应接近/超过安全限（复现伪振荡）')
  assert.equal(result.triggered, false, '未收敛爬升不应触发安全回退（修复目标）')
  console.log('  ✅ 慢收敛不再误触发')
}

// ---------- 场景 2：真振荡（过零、有峰）→ 仍触发 ----------
{
  const samples = []
  for (let i = 0; i <= 200; i += 1) {
    const t = i * 0.05
    const target = t < 1 ? 0 : 100
    let feedback = 0
    if (t >= 1) {
      const elapsed = t - 1
      if (elapsed <= 0.2) feedback = (100 / 0.2) * elapsed
      else {
        const phase = Math.floor((elapsed - 0.2) / 0.25) % 2
        feedback = 100 + (phase === 0 ? 15 : -15)
      }
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  const metrics = analyzeControlSamples(samples, { overshootLimit: 20, oscillationLimit: 10 })
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  userConfig.acceptance.oscillationLimit = 10
  let pid = { kp: 8, ki: 2, kd: 0 }
  const guard = createSafetyGuard({ userConfig, getPid: () => pid, setPid: (p) => { pid = p } })
  const result = guard.onSamplesCollected(samples)
  console.log(
    `[场景2] 真振荡（方波过零）仿真：peakCount=${metrics.oscillationPeakCount} · triggered=${result.triggered}`
  )
  assert.ok(metrics.oscillationPeakCount > 0, '真振荡应有峰')
  assert.equal(result.triggered, true, '真振荡超越限仍应触发（回归）')
  console.log('  ✅ 真振荡仍触发')
}

// ---------- 场景 3：跨工作点豁免 → 换目标不误回退；同工作点劣化仍回退 ----------
{
  const bestSmall = {
    pid: { positionKp: 5, speedKp: 1 },
    metrics: { valid: true, status: 'STABLE', rmse: 0.2, steadyError: 0.1, overshoot: 0, oscillation: 1, stepSize: 20, finalTarget: 20 },
    score: 1,
    round: 1
  }
  const curBigSlow = {
    valid: true, status: 'SLOW_RESPONSE', rmse: 6.7, steadyError: 15, overshoot: 0,
    oscillation: 11, stepSize: 50, finalTarget: 50
  }
  const rCross = shouldRollbackToBest(bestSmall, curBigSlow)
  const curSameSlow = { ...curBigSlow, stepSize: 20, finalTarget: 20 }
  const rSame = shouldRollbackToBest(bestSmall, curSameSlow)
  console.log(
    `[场景3] 跨工作点(20→50)回退=${rCross.shouldRollback}（应 false）· 同工作点(20)劣化回退=${rSame.shouldRollback}（应 true）`
  )
  assert.equal(rCross.shouldRollback, false, '跨工作点应豁免')
  assert.equal(rSame.shouldRollback, true, '同工作点劣化仍应回退')
  console.log('  ✅ 跨工作点豁免生效')
}

console.log('\n✅ tmp-cascade-safety-check 全部通过（串级慢收敛不再误触发安全回退）')