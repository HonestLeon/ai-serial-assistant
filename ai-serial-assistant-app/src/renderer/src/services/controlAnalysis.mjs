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
 * 找出阶跃响应后的振荡峰值（过冲峰与回冲谷交替）。
 * 每个峰返回 { index, t, value, amplitude }，amplitude 为偏离最终目标的绝对距离。
 *
 * 关键：只有 feedback 真正超过 finalTarget（出现过冲）之后，才开始记录回冲谷。
 * 这样纯 P 稳态误差（feedback 恒小于 target、从未超过）不会产生任何峰，
 * 不会被误判为震荡。
 *
 * 过滤阈值：偏离 finalTarget 小于 stepSize*2% 的波动视为噪声，不计入。
 * direction>=0 表示阶跃向上，同侧（超出 finalTarget）为过冲峰，反侧为回冲谷。
 */
function findOscillationPeaks(samples, startIndex, finalTarget, stepSize, direction) {
  const threshold = Math.abs(stepSize) * 0.02
  const peaks = []
  let hasOvershoot = false  // 是否已经出现过冲（feedback 超过 finalTarget）
  for (let i = startIndex + 1; i < samples.length - 1; i += 1) {
    const prev = samples[i - 1].feedback
    const curr = samples[i].feedback
    const next = samples[i + 1].feedback
    const dev = (curr - finalTarget) * direction      // 同侧为正（过冲）
    const devPrev = (prev - finalTarget) * direction
    const devNext = (next - finalTarget) * direction
    // 同侧局部极大（过冲峰）：feedback 超过 finalTarget 才记录
    if (dev > threshold && dev >= devPrev && dev >= devNext) {
      peaks.push({ index: i, t: samples[i].t, value: curr, amplitude: dev })
      hasOvershoot = true
    }
    // 反侧局部极大（回冲谷）：只有在出现过冲之后才记录
    // 避免稳态误差（feedback 恒小于 target）被误判为回冲谷
    if (hasOvershoot && -dev > threshold && -dev >= -devPrev && -dev >= -devNext) {
      peaks.push({ index: i, t: samples[i].t, value: curr, amplitude: -dev })
    }
  }
  return peaks
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

  // 振荡峰值分析：找出所有过冲峰/回冲谷，用于精确判定震荡
  // 判定标准（振幅为主）：从第三个峰起，振幅不得超过阶跃幅值的 5%
  const oscPeaks = findOscillationPeaks(samples, stepIndex, finalTarget, stepSize, direction)
  const peakAmplitudeLimit = amplitude * 0.05
  // 从第三个峰（索引2）起，振幅超过 5% 阶跃幅值的峰数
  const significantLatePeaks = oscPeaks
    .slice(2)
    .filter((p) => p.amplitude > peakAmplitudeLimit)
  const hasSignificantOscillation = significantLatePeaks.length > 0
  // 频率：取相邻同侧峰（每隔一个取一个）的间隔均值求倒数
  let oscillationFrequency = null
  if (oscPeaks.length >= 3) {
    const sameSide = oscPeaks.filter((_, i) => i % 2 === 0)
    if (sameSide.length >= 2) {
      const intervals = []
      for (let i = 1; i < sameSide.length; i += 1) {
        const dt = sameSide[i].t - sameSide[i - 1].t
        if (dt > 0) intervals.push(dt)
      }
      if (intervals.length) {
        const avgInterval = mean(intervals)
        oscillationFrequency = avgInterval > 0 ? 1 / avgInterval : null
      }
    }
  }
  // 最大峰振幅占阶跃幅值的百分比（用于展示与判定）
  const maxPeakAmplitudePct = oscPeaks.length
    ? Math.max(...oscPeaks.map((p) => p.amplitude)) / amplitude * 100
    : 0

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
    // 振荡峰值分析（用于精确判定震荡）
    oscillationPeakCount: oscPeaks.length,
    oscillationFrequency: fmt(oscillationFrequency, 2),
    maxPeakAmplitudePct: fmt(maxPeakAmplitudePct, 2),
    hasSignificantOscillation,
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
 *
 * 调参策略（工程经验法，借鉴 Ziegler-Nichols 与实践做法）：
 *   阶段 1（纯 P）：在可接受超调范围内（验收标准的 1.2 倍）尽量增大 Kp，以换取响应速度；
 *                  超出可接受范围才减小 Kp；Ki=Kd=0
 *   阶段 2（PI）：  在 P 调好后加 Ki 消除稳态误差，Ki 从小到大
 *   阶段 3（PID）： 若仍有振荡或需抑制超调，再加 Kd 增加阻尼
 *   噪声约束：     若反馈噪声较大（oscillation > 阈值 或 outputPeak 过高），不加 Kd（D 项放大噪声）
 *
 * options.tuningOrder 决定串级调参顺序（单环忽略）。
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
    return { ...base, confidence: '低', reasons: ['有效数据不足，保留当前候选参数'], phase: 'unknown' }
  }

  // 判定阶段：根据当前参数中是否启用 I/D 推断
  const eps = 1e-6
  const pOn = finite(current[isCascade ? 'speedKp' : 'kp'], 0) > eps
  const iOn = finite(current[isCascade ? 'speedKi' : 'ki'], 0) > eps
  const dOn = finite(current[isCascade ? 'speedKd' : 'kd'], 0) > eps
  let phase
  if (!pOn && !iOn && !dOn) phase = 'P'        // 初始：从纯 P 开始
  else if (pOn && !iOn && !dOn) phase = 'P'    // 纯 P 阶段
  else if (pOn && iOn && !dOn) phase = 'PI'    // PI 阶段
  else phase = 'PID'                            // 完整 PID 阶段

  // 噪声约束：稳态振荡大或输出峰值高 → 不加 D
  const noisy = finite(metrics.oscillation, 0) > finite(metrics.limits?.oscillation, 10) * 1.2
    || finite(metrics.outputPeak, 0) > Math.abs(finite(metrics.stepSize, 1)) * 2

  const reasons = []
  const adjustments = []

  // 阶段 1：纯 P。在可接受超调范围内，Kp 能给多大给多大
  if (phase === 'P') {
    // 可接受超调上限：验收标准的 1.2 倍（允许一定超调以换取响应速度）
    const overshootMargin = finite(metrics.limits.overshoot, 20) * 1.2
    const overshootLimit = finite(metrics.limits.overshoot, 20)
    // 稳态误差比（相对阶跃幅值），用于判断 Kp 增大因子
    const steadyErrRatio = Math.abs(finite(metrics.steadyError, 0))
      / Math.max(Math.abs(finite(metrics.stepSize, 1)), 1e-6)
    // 明显震荡判定：从第三个峰起振幅 > 5% 阶跃幅值
    const hasOsc = !!metrics.hasSignificantOscillation
    // 当前活跃环的 Kp（单环用 kp，串级用 speedKp）
    const currentKp = finite(current[isCascade ? 'speedKp' : 'kp'], 0)
    // 二分法上下界：由调用方从历史中提取
    const lastGoodKp = finite(options.lastGoodKp, 0)  // 下界：无超调（<3%）无震荡
    const lastBadKp = finite(options.lastBadKp, 0)    // 上界：超调超限或有明显震荡
    // 当前是否为坏值（超调超限或有明显震荡）
    const isBad = hasOsc || metrics.overshoot > overshootMargin
    // 二分区间是否已收敛（上下界差 < 上下界均值的 10%）
    // 收敛判定优先级最高：无论当前好坏，只要区间收敛就进入 PI
    const bisectMean = (lastGoodKp > 0 && lastBadKp > 0) ? (lastGoodKp + lastBadKp) / 2 : 0
    const bisectConverged = lastGoodKp > 0 && lastBadKp > 0
      && (lastBadKp - lastGoodKp) < bisectMean * 0.1

    if (bisectConverged) {
      // 二分区间已收敛 → Kp 已逼近边界，进入 PI（无论当前好坏）
      adjustments.push({ I: 1.0 })
      reasons.push(`阶段1(P)完成：二分区间已收敛（下界 ${fmt(lastGoodKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}，差值 ${fmt(lastBadKp - lastGoodKp, 3)} < 均值 ${fmt(bisectMean, 3)} 的 10%），进入阶段2(PI)`)
      phase = 'PI'
    } else if (!pOn) {
      // 从零开始：给一个初始 Kp 试探
      adjustments.push({ P: 1.0 })
      reasons.push('阶段1(P)：从零开始，给一个初始 Kp 试探')
    } else if (isBad) {
      // 当前坏（超调/震荡）→ 需要减小 Kp
      const trigger = hasOsc ? '震荡' : '超调'
      const triggerDetail = hasOsc
        ? `峰数${metrics.oscillationPeakCount}，最大振幅 ${fmt(metrics.maxPeakAmplitudePct, 1)}%`
        : `超调 ${fmt(metrics.overshoot, 1)}% > ${fmt(overshootMargin, 1)}%`
      if (lastGoodKp > 0 && lastGoodKp < currentKp) {
        // 有下界 → 二分法取中间值
        const bisect = (lastGoodKp + currentKp) / 2
        adjustments.push({ P: { abs: bisect } })
        reasons.push(`阶段1(P)：${trigger}（${triggerDetail}），二分法取中间值 Kp=${fmt(bisect, 3)}（下界 ${fmt(lastGoodKp, 3)} ↔ 当前 ${fmt(currentKp, 3)}）`)
      } else {
        // 无下界（第一次就超调/震荡）→ 固定因子减小
        adjustments.push({ P: 0.7 })
        reasons.push(`阶段1(P)：${trigger}（${triggerDetail}），减小 Kp`)
      }
    } else if (lastBadKp > 0 && currentKp < lastBadKp) {
      // 已建立上界且当前好 → 继续二分逼近上界（不走增大分支，避免跳过上界）
      const bisect = (currentKp + lastBadKp) / 2
      adjustments.push({ P: { abs: bisect } })
      reasons.push(`阶段1(P)：当前 Kp=${fmt(currentKp, 3)} 无超调，继续二分逼近上界 Kp=${fmt(bisect, 3)}（当前 ${fmt(currentKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}）`)
    } else if (metrics.overshoot > overshootLimit) {
      // 超调已接近验收标准 → Kp 已尽量增大，进入阶段 2
      adjustments.push({ I: 1.0 })
      reasons.push(`阶段1(P)完成：超调 ${fmt(metrics.overshoot, 1)}% 已接近验收标准 ${fmt(overshootLimit, 1)}%，Kp 已尽量增大，进入阶段2(PI)加 Ki 消除稳态误差`)
      phase = 'PI'
    } else {
      // 无上界且超调在可接受范围内 → 根据稳态误差动态增大 Kp
      let factor, desc
      if (steadyErrRatio > 0.3) {
        factor = 2.0
        desc = '稳态误差较大，激进增大 Kp（×2.0）'
      } else if (steadyErrRatio > 0.1) {
        factor = 1.5
        desc = '稳态误差中等，中等幅度增大 Kp（×1.5）'
      } else {
        factor = 1.25
        desc = '稳态误差较小，保守增大 Kp（×1.25）'
      }
      adjustments.push({ P: factor })
      reasons.push(`阶段1(P)：超调 ${fmt(metrics.overshoot, 1)}% 在可接受范围内、无明显震荡，${desc}`)
    }
  }
  // 阶段 2：PI。在 P 调好后加 Ki
  else if (phase === 'PI') {
    if (metrics.overshoot > metrics.limits.overshoot) {
      adjustments.push({ P: 0.9, I: 0.85 })
      reasons.push('阶段2(PI)：PI 引起超调，适度降 P/Ki')
    } else if (Math.abs(metrics.steadyError) > Math.max(Math.abs(metrics.stepSize) * 0.05, 1e-6)) {
      adjustments.push({ I: 1.3 })
      reasons.push('阶段2(PI)：稳态误差偏大，增大 Ki')
    } else if (metrics.oscillation > metrics.limits.oscillation && !noisy) {
      // PI 稳定但有轻微振荡 → 进入阶段 3 加 D
      adjustments.push({ D: 1.0 })
      reasons.push('阶段2(PI)完成：稳态误差已消除，下一轮进入阶段3(PID)加 Kd 抑制振荡')
      phase = 'PID'
    } else if (metrics.oscillation > metrics.limits.oscillation && noisy) {
      adjustments.push({ P: 0.9, I: 0.9 })
      reasons.push('阶段2(PI)：稳态振荡偏大且噪声较大，降 P/Ki（不加 D 以免放大噪声）')
    } else {
      adjustments.push({ I: 1.15 })
      reasons.push('阶段2(PI)：小幅增大 Ki 进一步消除稳态误差')
    }
  }
  // 阶段 3：PID。加 Kd 增加阻尼
  else {
    if (noisy) {
      // 噪声大 → 关闭 D，回到 PI
      adjustments.push({ D: 0.0 })
      reasons.push('阶段3(PID)：检测到反馈噪声较大，关闭 Kd（D 项会放大噪声），回到 PI')
      phase = 'PI'
    } else if (metrics.overshoot > metrics.limits.overshoot || metrics.oscillation > metrics.limits.oscillation) {
      adjustments.push({ D: 1.25, P: 0.95 })
      reasons.push('阶段3(PID)：超调/振荡偏大，增大 Kd 增加阻尼')
    } else if (Math.abs(metrics.steadyError) > Math.max(Math.abs(metrics.stepSize) * 0.05, 1e-6)) {
      adjustments.push({ I: 1.1 })
      reasons.push('阶段3(PID)：稳态误差偏大，小幅增大 Ki')
    } else {
      adjustments.push({ D: 1.1 })
      reasons.push('阶段3(PID)：已基本达标，微调 Kd 优化阻尼')
    }
  }

  const tuningOrder = options.tuningOrder && options.tuningOrder.length
    ? options.tuningOrder
    : (isCascade
        ? ['速度环Kp', '速度环Ki', '位置环Kp', '位置环Ki', '位置环Kd']
        : ['Kp', 'Ki', 'Kd'])

  const result = { ...base }
  paramKeys.forEach((key) => {
    const spec = PARAM_SPEC[key]
    const orderPos = tuningOrder.indexOf(spec.orderName)
    const posIdx = orderPos >= 0 ? orderPos : 0
    let value = result[key]
    // 从零开始时给一个小初始值，否则 0×factor 永远是 0
    if (value < 1e-9 && spec.role === 'P' && phase === 'P') {
      value = 0.5
    }
    adjustments.forEach((adj) => {
      const adjSpec = adj[spec.role]
      if (adjSpec === undefined) return
      // 支持绝对值：{ P: { abs: 3.0 } } 直接设定目标值（用于二分法）
      if (typeof adjSpec === 'object' && adjSpec !== null && 'abs' in adjSpec) {
        value = adjSpec.abs
        return
      }
      // 因子模式：{ P: 1.5 } 按倍数调整
      const factor = adjSpec
      // tuningOrder 顺序衰减：0 位完整修正，后续按 0.5^pos 衰减；再叠加环路权重
      const orderFactor = 1 + (factor - 1) * Math.pow(0.5, posIdx)
      const finalFactor = 1 + (orderFactor - 1) * spec.loop
      value *= finalFactor
    })
    // 阶段约束：P 阶段强制 Ki=Kd=0；PI 阶段强制 Kd=0
    if (phase === 'P' && spec.role !== 'P') value = 0
    else if (phase === 'PI' && spec.role === 'D') value = 0
    result[key] = value
  })

  paramKeys.forEach((key) => {
    result[key] = fmt(clamp(result[key], 0, PARAM_BOUNDS[key]))
  })

  result.confidence = metrics.sampleCount >= 80 ? '中' : '低'
  result.reasons = reasons
  result.phase = phase
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
