import assert from 'node:assert/strict'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  createSamplesFromChannels
} from '../src/renderer/src/services/controlAnalysis.mjs'

function createResponse({ damping = 0.45, count = 200 } = {}) {
  const dt = 0.05
  let feedback = 0
  let velocity = 0
  return Array.from({ length: count }, (_, index) => {
    const target = index < 20 ? 0 : 100
    const acceleration = 3.2 ** 2 * (target - feedback) - 2 * damping * 3.2 * velocity
    velocity += acceleration * dt
    feedback += velocity * dt
    return { t: index * dt, target, feedback, output: target - feedback }
  })
}

const metrics = analyzeControlSamples(createResponse())
assert.equal(metrics.valid, true)
assert.equal(metrics.sampleCount, 200)
assert.ok(metrics.riseTime > 0)
assert.ok(metrics.overshoot > 0)
assert.ok(metrics.rmse > 0)

const suggestion = buildPidSuggestion(metrics, { kp: 1.8, ki: 0.22, kd: 0.12 })
assert.ok(suggestion.kp >= 0 && suggestion.kp <= 20)
assert.ok(suggestion.ki >= 0 && suggestion.ki <= 10)
assert.ok(suggestion.kd >= 0 && suggestion.kd <= 10)
assert.ok(typeof suggestion.phase === 'string', 'suggestion 应含 phase 字段')

// 分阶段调参策略测试
// 1. P 阶段：从零开始，Ki=Kd=0，应增大 Kp
const sugP0 = buildPidSuggestion(metrics, { kp: 0, ki: 0, kd: 0 })
assert.equal(sugP0.phase, 'P', '初始应为 P 阶段')
assert.equal(sugP0.ki, 0, 'P 阶段 Ki 应为 0')
assert.equal(sugP0.kd, 0, 'P 阶段 Kd 应为 0')
assert.ok(sugP0.kp > 0, 'P 阶段应增大 Kp')

// 2. P 阶段：已有 Kp 但超调过大，仍保持 P 阶段
const overshootMetrics = { ...metrics, overshoot: metrics.limits.overshoot + 5 }
const sugP1 = buildPidSuggestion(overshootMetrics, { kp: 2, ki: 0, kd: 0 })
assert.equal(sugP1.phase, 'P', 'P 阶段超调过大仍应为 P 阶段')
assert.equal(sugP1.ki, 0, 'P 阶段 Ki 应为 0')
assert.equal(sugP1.kd, 0, 'P 阶段 Kd 应为 0')
assert.ok(sugP1.kp < 2, 'P 阶段超调应减小 Kp')

// 3. PI 阶段：有 Kp 和 Ki，无 Kd
const sugPI = buildPidSuggestion(metrics, { kp: 2, ki: 0.5, kd: 0 })
assert.equal(sugPI.phase, 'PI', '有 Kp+Ki 应为 PI 阶段')
assert.equal(sugPI.kd, 0, 'PI 阶段 Kd 应为 0')

// 4. PID 阶段：三个都有
const sugPID = buildPidSuggestion(metrics, { kp: 2, ki: 0.5, kd: 0.1 })
assert.equal(sugPID.phase, 'PID', '三个参数都有应为 PID 阶段')

const channels = createSamplesFromChannels([[0, 1, 2], [3, 4, 5], [6, 7, 8]], { target: 0, feedback: 1, output: 2 }, 50)
assert.deepEqual(channels[2], { t: 0.1, target: 2, feedback: 5, output: 8 })

const invalid = analyzeControlSamples([{ t: 0, target: 0, feedback: 0 }])
assert.equal(invalid.valid, false)

const stricterMinimum = analyzeControlSamples(createResponse({ count: 40 }), { minimumSamples: 50 })
assert.equal(stricterMinimum.valid, false)
assert.match(stricterMinimum.reason, /50/)

const customStandards = analyzeControlSamples(createResponse(), {
  settlingBand: 0.03,
  steadyErrorLimitRatio: 0.02,
  overshootLimit: 10,
  oscillationLimit: 5
})
assert.equal(customStandards.limits.settlingBand, 0.03)
assert.equal(customStandards.limits.steadyErrorRatio, 0.02)

// P0 防护：目标恒定（stepSize ≈ 0）→ 判定无效，绝不产出归一化爆炸数值
// （此前 amplitude 兜底 1e-6，会把微小 stepSize 放大成亿级 overshoot/oscillation）
{
  const noStep = Array.from({ length: 200 }, (_, i) => ({
    t: i * 0.05, target: 50, feedback: 50, output: 0
  }))
  const r = analyzeControlSamples(noStep, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(r.valid, false, '目标恒定无阶跃应判定无效')
  assert.ok(String(r.reason).includes('阶跃'), 'reason 应说明未检测到阶跃')

  // 极小步进（1e-5 < minStepSize=1e-4）同样不应产出指标
  const tiny = Array.from({ length: 200 }, (_, i) => ({
    t: i * 0.05, target: i === 0 ? 0 : 1e-5, feedback: i < 100 ? 0 : 1e-5, output: 0
  }))
  const rt = analyzeControlSamples(tiny, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(rt.valid, false, 'stepSize 低于 minStepSize 应判定无效')
}

console.log('control-analysis: all assertions passed')
