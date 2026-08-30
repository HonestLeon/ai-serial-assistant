import assert from 'node:assert/strict'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  createSamplesFromChannels,
  sliceLastTransition
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

// P3 斜坡目标检测：末段目标仍在变化 → valid:false + targetRamping（斜坡期指标全是假象）
{
  // 斜坡 0→50（10s，采样到 9.9s 时仍在爬）→ 末段目标持续变化 → 判无效
  const ramping = Array.from({ length: 100 }, (_, i) => {
    const t = i * 0.1
    const target = 5 * t
    return { t, target, feedback: target * 0.9, output: target }
  })
  const r1 = analyzeControlSamples(ramping, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(r1.valid, false, '斜坡进行中不应产出阶跃指标')
  assert.equal(r1.targetRamping, true)
  assert.ok(String(r1.reason).includes('斜坡'))
  assert.equal(typeof r1.finalTarget, 'number')

  // 斜坡完成后（目标稳定 50，反馈收敛）→ 正常产出指标且 targetRamping=false
  const settled = Array.from({ length: 300 }, (_, i) => {
    const t = i * 0.1
    const target = t < 10 ? 5 * t : 50
    const feedback = t < 10 ? target * 0.9 : 50 * (1 - Math.exp(-2 * (t - 10))) + 45 * (t < 10 ? 1 : 0) * 0
    return { t, target, feedback: t < 10 ? feedback : 45 + 5 * (1 - Math.exp(-2 * (t - 10))), output: target }
  })
  const r2 = analyzeControlSamples(settled, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(r2.valid, true, '斜坡完成后应产出阶跃指标')
  assert.equal(r2.targetRamping, false)

  // 常规阶跃（目标一步到位）不受斜坡守卫影响
  const step = createResponse()
  assert.equal(analyzeControlSamples(step).targetRamping, false)
}

// P2 sliceLastTransition：目标变化段切分（多阶跃取末段 / 稳态取全窗 / 斜坡为一段）
{
  // 三段目标：t=0~2 为 0、t=2~6 为 20、t=6~10 为 50 → 窗内两次变化，segment 只含第二段（含基线）
  const twoSteps = []
  for (let i = 0; i <= 100; i += 1) {
    const t = i * 0.1
    const target = t < 2 ? 0 : (t < 6 ? 20 : 50)
    twoSteps.push({ t, target, feedback: target * 0.9, output: target })
  }
  const r1 = sliceLastTransition(twoSteps)
  assert.equal(r1.transitionCount, 2, '窗口内应有两次目标变化')
  assert.ok(r1.segment.length < twoSteps.length, '应切掉第一段')
  assert.equal(r1.segment[0].target, 20, '段首应保留阶跃前基线（目标 20）')
  assert.ok(r1.segment[r1.segment.length - 1].target === 50)

  // 稳态窗口（目标恒定）→ 全窗口 + transitionCount=0
  const steady = Array.from({ length: 50 }, (_, i) => ({
    t: i * 0.1, target: 50, feedback: 48 + Math.sin(i) * 0.2, output: 15
  }))
  const r2 = sliceLastTransition(steady)
  assert.equal(r2.transitionCount, 0)
  assert.equal(r2.segment.length, steady.length)

  // 斜坡（目标持续变化）→ 单个 transition，segment 含斜坡全程
  const ramp = Array.from({ length: 50 }, (_, i) => ({
    t: i * 0.1, target: i, feedback: i * 0.9, output: i
  }))
  const r3 = sliceLastTransition(ramp)
  assert.equal(r3.transitionCount, 1, '连续斜坡为一个目标变化段')
  assert.ok(r3.segment.length > 10)

  // 边界：空数组 / 单样本
  assert.deepEqual(sliceLastTransition([]), { segment: [], transitionCount: 0 })
  assert.deepEqual(
    sliceLastTransition([{ t: 0, target: 0, feedback: 0, output: 0 }]),
    { segment: [{ t: 0, target: 0, feedback: 0, output: 0 }], transitionCount: 0 }
  )
}

// P4 未收敛检测：窗口尾部 feedback 仍在明显上升（响应未完成）→ 指标标注为非稳态，不得当稳态判断
{
  // 场景 A：有差系统（P-only）停在稳态误差处，但尾段仍以每秒 ~4.5 缓慢爬升（目标 50）
  // → 原判定 SLOW_RESPONSE 保留，并附加"尚未收敛"提示；converged=false
  const stillRisingSlow = Array.from({ length: 200 }, (_, i) => {
    const t = i * 0.05
    return { t, target: i < 5 ? 0 : 50, feedback: Math.min(45, 4.5 * t), output: 0 }
  })
  const r1 = analyzeControlSamples(stillRisingSlow, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(r1.valid, true)
  assert.equal(r1.converged, false, '尾段仍在爬升应判定未收敛')
  assert.equal(r1.status, 'SLOW_RESPONSE', '未收敛 + 有差系统仍为 SLOW_RESPONSE')
  assert.ok(String(r1.convergenceNote).includes('尚未收敛'), '应带未收敛提示语')
  assert.ok(String(r1.convergenceNote).includes('速度环'), '提示应引导先整定速度环')

  // 场景 B：响应基本到位（误差 < 5%、RMSE 小）但尾段仍以每秒 ~2 缓慢逼近（目标 100）
  // → 初判 STABLE，因未收敛改写为 STILL_RISING（新枚举）
  const stillRisingStable = Array.from({ length: 200 }, (_, i) => {
    const t = i * 0.05
    const feedback = t < 9 ? 96 * (t / 9) : 96 + (t - 9) * 2
    return { t, target: i < 5 ? 0 : 100, feedback, output: 0 }
  })
  const r2 = analyzeControlSamples(stillRisingStable, { overshootLimit: 20, oscillationLimit: 10 })
  assert.equal(r2.valid, true)
  assert.equal(r2.converged, false, '场景 B 尾段仍在上升应未收敛')
  assert.equal(r2.status, 'STILL_RISING', '未收敛且原本 STABLE 应改写为 STILL_RISING')
  assert.ok(String(r2.convergenceNote).includes('尚未收敛'), '提示语应说明未收敛')

  // 场景 C：等幅振荡（振幅占阶跃 30%，无衰减）——尾段均值差≈0，但振幅未衰减 → 未收敛且判 OSCILLATING
  const sustainedOsc = Array.from({ length: 400 }, (_, i) => {
    const t = i * 0.01
    const base = i < 30 ? 0 : 50
    const osc = t < 0.3 ? 0 : 15 * Math.sin(2 * Math.PI * 3 * (t - 0.3))
    return { t, target: base, feedback: base + osc, output: 15 }
  })
  const r3 = analyzeControlSamples(sustainedOsc, { overshootLimit: 20, oscillationLimit: 12 })
  assert.equal(r3.valid, true)
  assert.equal(r3.converged, false, '等幅振荡尾段振幅未衰减应判未收敛')
  assert.equal(r3.status, 'OSCILLATING', '等幅振荡应矫正为 OSCILLATING（防伪达标）')
  assert.ok(String(r3.convergenceNote).includes('振荡'), '提示语应说明持续振荡')

  // 已收敛（振幅衰减）的常规响应不受影响（既有用例回归）
  const settledMetrics = analyzeControlSamples(createResponse())
  assert.equal(settledMetrics.converged, true, '已收敛响应 converged 应为 true')
  assert.notEqual(settledMetrics.status, 'STILL_RISING')
  assert.notEqual(settledMetrics.status, 'OSCILLATING')
}

console.log('control-analysis: all assertions passed')
