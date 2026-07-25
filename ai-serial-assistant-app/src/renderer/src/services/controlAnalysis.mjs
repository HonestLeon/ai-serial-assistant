const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const finite = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const mean = (values) => {
  const valid = values.filter(Number.isFinite)
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0
}

const rms = (values) => Math.sqrt(mean(values.map((value) => value * value)))

const fmt = (value, digits = 3) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function findStep(samples) {
  if (samples.length < 2) return 0
  let index = 1
  let largestDelta = -Infinity
  for (let i = 1; i < samples.length; i += 1) {
    const delta = Math.abs(samples[i].target - samples[i - 1].target)
    if (delta > largestDelta) {
      largestDelta = delta
      index = i
    }
  }
  return index
}

function crossingTime(samples, startIndex, threshold, direction) {
  for (let i = Math.max(startIndex, 1); i < samples.length; i += 1) {
    const previous = samples[i - 1].feedback
    const current = samples[i].feedback
    const crossed = direction >= 0
      ? previous < threshold && current >= threshold
      : previous > threshold && current <= threshold
    if (!crossed) continue

    const range = current - previous
    if (Math.abs(range) < 1e-9) return samples[i].t
    const ratio = (threshold - previous) / range
    return samples[i - 1].t + ratio * (samples[i].t - samples[i - 1].t)
  }
  return null
}

function settlingTime(samples, stepIndex, finalTarget, stepSize, bandRatio) {
  const band = Math.max(Math.abs(stepSize) * bandRatio, 1e-6)
  for (let i = stepIndex; i < samples.length; i += 1) {
    const tail = samples.slice(i)
    if (tail.length < 3) continue
    if (tail.every((sample) => Math.abs(sample.feedback - finalTarget) <= band)) {
      return samples[i].t - samples[stepIndex].t
    }
  }
  return null
}

function oscillationAmplitude(values) {
  if (values.length < 3) return 0
  return Math.max(...values) - Math.min(...values)
}

/**
 * 对统一格式的控制响应数据进行确定性分析。
 * 输入：[{ t, target, feedback, output? }]
 */
export function analyzeControlSamples(inputSamples, options = {}) {
  const overshootLimit = finite(options.overshootLimit, 20)
  const oscillationLimit = finite(options.oscillationLimit, 10)
  const steadyErrorLimitRatio = clamp(finite(options.steadyErrorLimitRatio, 0.05), 0.001, 1)
  const minimumSamples = Math.round(clamp(finite(options.minimumSamples, 8), 8, 1000))
  const bandRatio = clamp(finite(options.settlingBand, 0.05), 0.01, 0.2)
  const samples = inputSamples
    .map((sample, index) => ({
      t: finite(sample.t, index),
      target: finite(sample.target),
      feedback: finite(sample.feedback),
      output: finite(sample.output)
    }))
    .filter((sample) => Number.isFinite(sample.t))
    .sort((a, b) => a.t - b.t)

  if (samples.length < minimumSamples) {
    return {
      valid: false,
      reason: `至少需要 ${minimumSamples} 个有效采样点`,
      sampleCount: samples.length
    }
  }

  const stepIndex = findStep(samples)
  const before = samples.slice(0, Math.max(1, stepIndex))
  const tailCount = Math.max(3, Math.round(samples.length * 0.15))
  const tail = samples.slice(-tailCount)
  const initialTarget = mean(before.map((sample) => sample.target))
  const initialFeedback = mean(before.map((sample) => sample.feedback))
  const finalTarget = mean(tail.map((sample) => sample.target))
  const finalFeedback = mean(tail.map((sample) => sample.feedback))
  const stepSize = finalTarget - initialTarget
  const direction = Math.sign(stepSize || finalFeedback - initialFeedback || 1)
  const amplitude = Math.max(Math.abs(stepSize), 1e-6)
  const stepTime = samples[stepIndex].t

  const threshold10 = initialFeedback + 0.1 * (finalTarget - initialFeedback)
  const threshold90 = initialFeedback + 0.9 * (finalTarget - initialFeedback)
  const time10 = crossingTime(samples, stepIndex, threshold10, direction)
  const time90 = crossingTime(samples, stepIndex, threshold90, direction)
  const riseTime = time10 !== null && time90 !== null ? Math.max(0, time90 - time10) : null

  const postStep = samples.slice(stepIndex)
  const extreme = direction >= 0
    ? Math.max(...postStep.map((sample) => sample.feedback))
    : Math.min(...postStep.map((sample) => sample.feedback))
  const overshoot = Math.max(0, direction * (extreme - finalTarget) / amplitude * 100)
  const settling = settlingTime(samples, stepIndex, finalTarget, stepSize, bandRatio)
  const steadyError = finalTarget - finalFeedback
  const errors = postStep.map((sample) => sample.target - sample.feedback)
  const rmse = rms(errors)
  const tailFeedback = tail.map((sample) => sample.feedback)
  const oscillation = oscillationAmplitude(tailFeedback) / amplitude * 100

  const deltas = samples.slice(1).map((sample, index) => sample.t - samples[index].t).filter((v) => v > 0)
  const averageDt = mean(deltas)
  const sampleRate = averageDt > 0 ? 1 / averageDt : null
  const outputPeak = Math.max(...postStep.map((sample) => Math.abs(sample.output)))

  const risks = []
  if (overshoot > overshootLimit) risks.push(`超调 ${fmt(overshoot, 1)}% 超过 ${overshootLimit}% 安全线`)
  if (oscillation > oscillationLimit) risks.push(`稳态波动 ${fmt(oscillation, 1)}% 超过 ${oscillationLimit}% 安全线`)
  if (Math.abs(steadyError) > amplitude * steadyErrorLimitRatio) {
    risks.push(`稳态误差超过阶跃幅值的 ${fmt(steadyErrorLimitRatio * 100, 1)}%`)
  }
  if (settling === null) risks.push('采样窗口内未进入稳定带')

  // 状态判定（借鉴 llm-pid-tuner）：优先级 OSCILLATING > OVERSHOOTING > SLOW_RESPONSE > STABLE
  // 用于 LLM 上下文与安全护栏的回退策略
  // 过零点判定需过滤噪声：仅在误差幅度超过 5% 阶跃幅值时才计入
  const errThreshold = amplitude * 0.05
  let zeroCrossings = 0
  for (let i = 1; i < errors.length; i += 1) {
    const a = errors[i - 1]
    const b = errors[i]
    if (Math.abs(a) < errThreshold || Math.abs(b) < errThreshold) continue
    if (a * b < 0) zeroCrossings += 1
  }
  let status = 'STABLE'
  if (zeroCrossings > errors.length * 0.15) status = 'OSCILLATING'
  else if (overshoot > overshootLimit) status = 'OVERSHOOTING'
  else if (rmse > amplitude * 0.3 && Math.abs(steadyError) > amplitude * steadyErrorLimitRatio) status = 'SLOW_RESPONSE'

  return {
    valid: true,
    sampleCount: samples.length,
    stepIndex,
    stepTime: fmt(stepTime),
    initialTarget: fmt(initialTarget),
    finalTarget: fmt(finalTarget),
    initialFeedback: fmt(initialFeedback),
    finalFeedback: fmt(finalFeedback),
    stepSize: fmt(stepSize),
    sampleRate: fmt(sampleRate, 1),
    riseTime: fmt(riseTime),
    settlingTime: fmt(settling),
    overshoot: fmt(overshoot, 2),
    steadyError: fmt(steadyError),
    rmse: fmt(rmse),
    oscillation: fmt(oscillation, 2),
    outputPeak: fmt(outputPeak),
    status,
    limits: {
      overshoot: overshootLimit,
      oscillation: oscillationLimit,
      settlingBand: bandRatio,
      steadyErrorRatio: steadyErrorLimitRatio,
      minimumSamples
    },
    risks,
    health: risks.length === 0 ? '良好' : risks.length === 1 ? '需关注' : '高风险'
  }
}

export function createSamplesFromChannels(channelHistory, mapping = {}, sampleIntervalMs = 50) {
  const targetIndex = finite(mapping.target, 0)
  const feedbackIndex = finite(mapping.feedback, 1)
  const outputIndex = finite(mapping.output, 2)
  const target = channelHistory?.[targetIndex] || []
  const feedback = channelHistory?.[feedbackIndex] || []
  const output = channelHistory?.[outputIndex] || []
  const count = Math.min(target.length, feedback.length)
  const offsetTarget = target.length - count
  const offsetFeedback = feedback.length - count
  const offsetOutput = Math.max(0, output.length - count)
  const dt = Math.max(1, finite(sampleIntervalMs, 50)) / 1000

  return Array.from({ length: count }, (_, index) => ({
    t: index * dt,
    target: finite(target[offsetTarget + index]),
    feedback: finite(feedback[offsetFeedback + index]),
    output: finite(output[offsetOutput + index])
  }))
}

// 参数角色与环路权重：外环/单环完整修正，内环（速度环）修正幅度衰减到 30%
const PARAM_SPEC = {
  kp: { role: 'P', loop: 1, orderName: 'Kp' },
  ki: { role: 'I', loop: 1, orderName: 'Ki' },
  kd: { role: 'D', loop: 1, orderName: 'Kd' },
  positionKp: { role: 'P', loop: 1, orderName: '位置环Kp' },
  positionKi: { role: 'I', loop: 1, orderName: '位置环Ki' },
  positionKd: { role: 'D', loop: 1, orderName: '位置环Kd' },
  speedKp: { role: 'P', loop: 0.3, orderName: '速度环Kp' },
  speedKi: { role: 'I', loop: 0.3, orderName: '速度环Ki' },
  speedKd: { role: 'D', loop: 0.3, orderName: '速度环Kd' }
}

const PARAM_BOUNDS = { kp: 20, ki: 10, kd: 10, positionKp: 20, positionKi: 10, positionKd: 10, speedKp: 20, speedKi: 10, speedKd: 10 }

/**
 * 只生成“候选参数”，绝不直接下发硬件。
 * 支持单环（kp/ki/kd）与串级（speedKp/speedKi/speedKd + positionKp/positionKi/positionKd）。
 * options.tuningOrder 决定调参顺序：排在前的参数承担更大修正幅度（指数衰减 0.5^pos）。
 */
export function buildPidSuggestion(metrics, current = {}, options = {}) {
  const isCascade = Object.keys(current).some((key) => key.startsWith('speed') || key.startsWith('position'))
  const paramKeys = isCascade
    ? ['speedKp', 'speedKi', 'speedKd', 'positionKp', 'positionKi', 'positionKd']
    : ['kp', 'ki', 'kd']
  const base = {}
  paramKeys.forEach((key) => {
    base[key] = clamp(finite(current[key], 0), 0, PARAM_BOUNDS[key])
  })

  if (!metrics?.valid) {
    return { ...base, confidence: '低', reasons: ['有效数据不足，保留当前候选参数'] }
  }

  const tuningOrder = options.tuningOrder && options.tuningOrder.length
    ? options.tuningOrder
    : (isCascade
        ? ['速度环Kp', '速度环Ki', '位置环Kp', '位置环Ki', '位置环Kd']
        : ['Kp', 'Ki', 'Kd'])

  const reasons = []
  const adjustments = []
  if (metrics.overshoot > metrics.limits.overshoot) {
    adjustments.push({ P: 0.82, I: 0.78, D: 1.22 })
    reasons.push('超调偏大：降低比例/积分并增加微分阻尼')
  }
  if (metrics.oscillation > metrics.limits.oscillation) {
    adjustments.push({ P: 0.86, I: 0.82, D: 1.15 })
    reasons.push('稳态振荡偏大：降低环路激进程度')
  }
  if (Math.abs(metrics.steadyError) > Math.max(Math.abs(metrics.stepSize) * 0.05, 1e-6)) {
    adjustments.push({ I: 1.18 })
    reasons.push('稳态误差偏大：小幅增加积分作用')
  }
  if (metrics.overshoot <= 5 && metrics.settlingTime !== null && metrics.riseTime !== null && metrics.riseTime > metrics.settlingTime * 0.55) {
    adjustments.push({ P: 1.10 })
    reasons.push('响应较保守：小幅提高比例增益')
  }
  if (!reasons.length) reasons.push('当前响应满足基础阈值，建议先保持参数并扩大样本验证')

  const result = { ...base }
  paramKeys.forEach((key) => {
    const spec = PARAM_SPEC[key]
    const orderPos = tuningOrder.indexOf(spec.orderName)
    const posIdx = orderPos >= 0 ? orderPos : 0
    let value = result[key]
    adjustments.forEach((adj) => {
      const factor = adj[spec.role]
      if (!factor) return
      // tuningOrder 顺序衰减：0 位完整修正，后续按 0.5^pos 衰减；再叠加环路权重
      const orderFactor = 1 + (factor - 1) * Math.pow(0.5, posIdx)
      const finalFactor = 1 + (orderFactor - 1) * spec.loop
      value *= finalFactor
    })
    result[key] = value
  })

  paramKeys.forEach((key) => {
    result[key] = fmt(clamp(result[key], 0, PARAM_BOUNDS[key]))
  })

  result.confidence = metrics.sampleCount >= 80 ? '中' : '低'
  result.reasons = reasons
  return result
}

export function buildStructuredAiContext(metrics, suggestion, extra = {}) {
  return {
    task: '解释控制响应并审核 PID 候选参数，禁止直接控制硬件',
    system: extra.system || '未指定',
    scenario: extra.scenario || '阶跃响应分析',
    deterministicMetrics: metrics,
    boundedCandidate: suggestion,
    safetyRules: [
      'AI 只能解释和提出建议，参数必须由用户确认后下发',
      'Kp 范围 0~20，Ki 范围 0~10，Kd 范围 0~10',
      '超调率默认不得超过 20%，稳态波动默认不得超过 10%',
      '信息不足时必须明确说明，不得虚构设备模型或结论'
    ]
  }
}

/**
 * 把调参历史（最近几轮）打包为 LLM 可读文本。
 * 借鉴 llm-pid-tuner 的 history.to_prompt_text：每轮记录 {参数, 指标, AI分析}，
 * 让 LLM “借鉴历史、避免重复无效方向”。
 *
 * @param {Array} history  每项形如 { round, pid, metrics, analysis, thought }
 * @param {number} maxRounds  最多打包几轮（默认 5）
 * @returns {string}
 */
export function historyToPromptText(history, maxRounds = 5) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const recent = history.slice(-maxRounds)
  const lines = ['## 调参历史（最近几轮，请仔细借鉴，避免重复无效方向）：']
  recent.forEach((h) => {
    const pidStr = h.pid
      ? Object.entries(h.pid).map(([k, v]) => `${k}=${v}`).join(', ')
      : '未知'
    const m = h.metrics || {}
    const metricsStr = [
      `status=${m.status || '未知'}`,
      `rmse=${m.rmse ?? 'N/A'}`,
      `overshoot=${m.overshoot ?? 'N/A'}%`,
      `steadyError=${m.steadyError ?? 'N/A'}`,
      `oscillation=${m.oscillation ?? 'N/A'}%`
    ].join(', ')
    lines.push(`### Round ${h.round ?? '?'}`)
    lines.push(`- 参数: ${pidStr}`)
    lines.push(`- 指标: ${metricsStr}`)
    if (h.thought) lines.push(`- AI思考: ${String(h.thought).slice(0, 300)}`)
    if (h.analysis) lines.push(`- 分析总结: ${String(h.analysis).slice(0, 200)}`)
  })
  return lines.join('\n')
}
