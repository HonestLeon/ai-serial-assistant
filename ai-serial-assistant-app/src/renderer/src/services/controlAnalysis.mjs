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
 * 对 feedback 序列做窗口=5 的居中滑动平均，剔除高频噪声。
 * 用于振荡峰检测前预处理；不影响指标统计本身。
 */
function movingAverage(values, window = 5) {
  const half = Math.floor(window / 2)
  return values.map((_, i) => {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j += 1) {
      sum += values[j]
      count += 1
    }
    return sum / count
  })
}

/**
 * 找出阶跃响应后的振荡峰值（过冲峰与回冲谷交替）。
 * 每个峰返回 { index, t, value, amplitude }，amplitude 为偏离最终目标的绝对距离。
 *
 * 关键设计（满足验收要求"剔除噪声项影响后"）：
 *   1. 先对 feedback 做 5 点滑动平均滤波，滤除高频噪声，仅保留低频振荡分量；
 *   2. 只有 feedback 真正超过 finalTarget（出现过冲）之后，才开始记录回冲谷。
 *      这样纯 P 稳态误差（feedback 恒小于 target、从未超过）不会产生任何峰，
 *      不会被误判为震荡；
 *   3. 过滤阈值：偏离 finalTarget 小于 stepSize*2% 的波动视为噪声，不计入。
 *   direction>=0 表示阶跃向上，同侧（超出 finalTarget）为过冲峰，反侧为回冲谷。
 */
function findOscillationPeaks(samples, startIndex, finalTarget, stepSize, direction) {
  const threshold = Math.abs(stepSize) * 0.02
  // 滑动平均滤波：剔除高频噪声后再检测峰（"剔除噪声项影响"）
  const feedbacks = samples.map((s) => s.feedback)
  const filtered = movingAverage(feedbacks, 5)
  const peaks = []
  let hasOvershoot = false  // 是否已经出现过冲（feedback 超过 finalTarget）
  for (let i = startIndex + 1; i < samples.length - 1; i += 1) {
    const prev = filtered[i - 1]
    const curr = filtered[i]
    const next = filtered[i + 1]
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
  // 稳态振幅：直接计算末尾窗真实振幅（不滤波）
  // 验收标准"剔除噪声项影响"是指峰检测剔除高频噪声峰（findOscillationPeaks 已做滤波），
  // 但稳态振幅应反映真实振荡（包括 Ki 过大导致的极限环），不能被滑动平均滤掉
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

// positionKp 上限设为 8：串级位置环输出速度目标，positionKp·error 受 speedLimit（默认 8）限制
// target=0.8 时 positionKp=10 会让 speedTarget=8 持续饱和，导致极限环振荡（Kd 无法抑制）
// 上限 8 让 target≥1 时 positionKp·error ≤ 8 不饱和；target<1 时仍有饱和风险，由调参策略识别处理
const PARAM_BOUNDS = { kp: 20, ki: 10, kd: 10, positionKp: 8, positionKi: 10, positionKd: 10, speedKp: 20, speedKi: 10, speedKd: 10 }

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
  // 串级以位置环（外环）为主导：阶段判断基于 positionKp/positionKi/positionKd
  // 速度环（内环）作为跟随环，其 Kp 在 P 阶段也参与调整但权重较低
  const eps = 1e-6
  const pOn = finite(current[isCascade ? 'positionKp' : 'kp'], 0) > eps
  const iOn = finite(current[isCascade ? 'positionKi' : 'ki'], 0) > eps
  const dOn = finite(current[isCascade ? 'positionKd' : 'kd'], 0) > eps
  // unstable 选项：用于不稳定系统（倒立摆/平衡车），必须有 Kd 提供阻尼
  // 不稳定系统不走纯 P 阶段，从 PD 起步（Kp=0 也有 Kd），调好 Kp 后直接加 Ki 进 PID
  const unstable = !!options.unstable
  let phase
  if (unstable) {
    if (!iOn) phase = 'PD'        // 起始/调Kp阶段：Kd 保留，Ki=0
    else phase = 'PID'            // 加 Ki 阶段
  } else if (!pOn && !iOn && !dOn) phase = 'P'        // 初始：从纯 P 开始
  else if (pOn && !iOn && !dOn) phase = 'P'    // 纯 P 阶段
  else if (pOn && iOn && !dOn) phase = 'PI'    // PI 阶段
  else phase = 'PID'                            // 完整 PID 阶段

  // 噪声约束：稳态振荡大或输出峰值高 → 不加 D（不稳定系统例外，Kd 是必需阻尼）
  const noisy = !unstable && (
    finite(metrics.oscillation, 0) > finite(metrics.limits?.oscillation, 10) * 1.2
    || finite(metrics.outputPeak, 0) > Math.abs(finite(metrics.stepSize, 1)) * 2
  )

  const reasons = []
  const adjustments = []

  // 阶段 PD：不稳定系统（倒立摆/平衡车）专用。保留 Kd 提供阻尼，仅调 Kp
  // 与 P 阶段同样的二分法逻辑，但 Kd 不变（不被强制清零）
  if (phase === 'PD') {
    const overshootMargin = finite(metrics.limits.overshoot, 20) * 1.2
    const overshootLimit = finite(metrics.limits.overshoot, 20)
    const steadyErrRatio = Math.abs(finite(metrics.steadyError, 0))
      / Math.max(Math.abs(finite(metrics.stepSize, 1)), 1e-6)
    const hasOsc = !!metrics.hasSignificantOscillation
    // PD 阶段目的是调 Kp，振荡标准放宽到 5%（验收标准 3% 留给 PID 阶段）
    // 不要求 STABLE 状态：不稳定系统在 Kp 不足时振荡大但 status=SLOW_RESPONSE，仍应视为坏值
    const oscOverLimit = finite(metrics.oscillation, 0) > 5
    const currentKp = finite(current[isCascade ? 'positionKp' : 'kp'], 0)
    const lastGoodKp = finite(options.lastGoodKp, 0)
    const lastBadKp = finite(options.lastBadKp, 0)
    const isBad = hasOsc || oscOverLimit || metrics.overshoot > overshootMargin
    const bisectMean = (lastGoodKp > 0 && lastBadKp > 0) ? (lastGoodKp + lastBadKp) / 2 : 0
    const bisectConverged = lastGoodKp > 0 && lastBadKp > 0
      && (lastBadKp - lastGoodKp) < bisectMean * 0.1

    if (bisectConverged) {
      // Kp 收敛 → 加 Ki 进入 PID
      // 不稳定系统 Ki 起始值更小（0.05），避免引入过大超调和震荡
      const kiInit = unstable ? 0.05 : 0.3
      adjustments.push({ I: { abs: kiInit } })
      reasons.push(`阶段PD完成：Kp 二分区间已收敛（下界 ${fmt(lastGoodKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}），加 Ki 进入 PID`)
      phase = 'PID'
    } else if (!pOn) {
      // Kp=0 起始：给一个初始 Kp 试探（不稳定系统起始 Kp 更大，由初始值逻辑处理）
      adjustments.push({ P: 1.0 })
      reasons.push('阶段PD：Kp=0，给一个初始 Kp 试探（Kd 保留阻尼）')
    } else if (isBad) {
      const trigger = hasOsc ? '震荡' : (oscOverLimit ? `稳态振幅${fmt(metrics.oscillation, 1)}%>5%` : '超调')
      const triggerDetail = hasOsc
        ? `峰数${metrics.oscillationPeakCount}，最大振幅 ${fmt(metrics.maxPeakAmplitudePct, 1)}%`
        : oscOverLimit
          ? `稳态振幅 ${fmt(metrics.oscillation, 1)}% > 5%`
          : `超调 ${fmt(metrics.overshoot, 1)}% > ${fmt(overshootMargin, 1)}%`
      // 失稳检测：振荡极大（>50%）且稳态误差极大 → Kp 严重不足，应增大 Kp
      // （倒立摆等不稳定系统在 Kp 不足时会发散，减小 Kp 只会让系统更不稳定）
      const diverged = finite(metrics.oscillation, 0) > 50
        && steadyErrRatio > 1.0
      if (diverged) {
        const factor = steadyErrRatio > 5 ? 3.0 : (steadyErrRatio > 2 ? 2.0 : 1.6)
        adjustments.push({ P: factor })
        reasons.push(`阶段PD：系统失稳（振荡 ${fmt(metrics.oscillation, 1)}%，稳态误差 ${fmt(steadyErrRatio * 100, 1)}%），Kp 严重不足，激进增大 Kp（×${factor}）`)
      } else if (lastGoodKp > 0 && lastGoodKp < currentKp) {
        const bisect = (lastGoodKp + currentKp) / 2
        adjustments.push({ P: { abs: bisect } })
        reasons.push(`阶段PD：${trigger}（${triggerDetail}），二分法取中间值 Kp=${fmt(bisect, 3)}（下界 ${fmt(lastGoodKp, 3)} ↔ 当前 ${fmt(currentKp, 3)}）`)
      } else if (lastBadKp > 0 && currentKp < lastBadKp * 0.5) {
        // 当前 Kp 远小于上界 → 直接二分到上界附近
        const bisect = (currentKp + lastBadKp) / 2
        adjustments.push({ P: { abs: bisect } })
        reasons.push(`阶段PD：${trigger}（${triggerDetail}），当前 Kp 远小于上界，二分逼近上界 Kp=${fmt(bisect, 3)}（当前 ${fmt(currentKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}）`)
      } else {
        adjustments.push({ P: 0.7 })
        reasons.push(`阶段PD：${trigger}（${triggerDetail}），减小 Kp`)
      }
    } else if (lastBadKp > 0 && currentKp < lastBadKp) {
      const bisect = (currentKp + lastBadKp) / 2
      adjustments.push({ P: { abs: bisect } })
      reasons.push(`阶段PD：当前 Kp=${fmt(currentKp, 3)} 无超调，继续二分逼近上界 Kp=${fmt(bisect, 3)}（当前 ${fmt(currentKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}）`)
    } else if (metrics.overshoot > overshootLimit) {
      // 超调已接近验收标准 → Kp 已尽量增大，进入 PID 加 Ki
      const kiInit = unstable ? 0.05 : 0.3
      adjustments.push({ I: { abs: kiInit } })
      reasons.push(`阶段PD完成：超调 ${fmt(metrics.overshoot, 1)}% 已接近验收标准 ${fmt(overshootLimit, 1)}%，加 Ki 进入 PID`)
      phase = 'PID'
    } else {
      let factor, desc
      if (steadyErrRatio > 0.3) { factor = 1.6; desc = '稳态误差较大，增大 Kp（×1.6）' }
      else if (steadyErrRatio > 0.1) { factor = 1.4; desc = '稳态误差中等，增大 Kp（×1.4）' }
      else { factor = 1.2; desc = '稳态误差较小，保守增大 Kp（×1.2）' }
      adjustments.push({ P: factor })
      reasons.push(`阶段PD：超调 ${fmt(metrics.overshoot, 1)}% 在可接受范围内、无明显震荡，${desc}（Kd 保留）`)
    }
  }
  // 阶段 1：纯 P。在可接受超调范围内，Kp 能给多大给多大
  else if (phase === 'P') {
    // 可接受超调上限：验收标准的 1.2 倍（允许一定超调以换取响应速度）
    const overshootMargin = finite(metrics.limits.overshoot, 20) * 1.2
    const overshootLimit = finite(metrics.limits.overshoot, 20)
    // 稳态误差比（相对阶跃幅值），用于判断 Kp 增大因子
    const steadyErrRatio = Math.abs(finite(metrics.steadyError, 0))
      / Math.max(Math.abs(finite(metrics.stepSize, 1)), 1e-6)
    // 明显震荡判定：从第三个峰起振幅 > 5% 阶跃幅值
    const hasOsc = !!metrics.hasSignificantOscillation
    // 当前活跃环的 Kp（单环用 kp，串级用 positionKp 外环主导）
    const currentKp = finite(current[isCascade ? 'positionKp' : 'kp'], 0)
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
      // 给 Ki 一个明确起始值（避免 0 × 1.0 = 0 的死锁）
      adjustments.push({ I: { abs: 0.3 } })
      reasons.push(`阶段1(P)完成：二分区间已收敛（下界 ${fmt(lastGoodKp, 3)} ↔ 上界 ${fmt(lastBadKp, 3)}，差值 ${fmt(lastBadKp - lastGoodKp, 3)} < 均值 ${fmt(bisectMean, 3)} 的 10%），进入阶段2(PI)`)
      phase = 'PI'
    } else if (currentKp >= PARAM_BOUNDS[isCascade ? 'positionKp' : 'kp'] * 0.99) {
      // Kp 已达上限但仍无超调/坏值 → Kp 已尽力，进入 PI 加 Ki 消除稳态误差
      // （串级位置环纯P有稳态误差，必须加Ki消除；单环电机纯P也可能有稳态误差）
      adjustments.push({ I: { abs: 0.3 } })
      reasons.push(`阶段1(P)完成：Kp=${fmt(currentKp, 2)} 已达上限 ${PARAM_BOUNDS[isCascade ? 'positionKp' : 'kp']}，进入阶段2(PI)加 Ki 消除稳态误差`)
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
      adjustments.push({ I: { abs: 0.3 } })
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
    } else if (finite(metrics.oscillation, 0) > 3) {
      // 稳态振幅 > 3%（验收标准）
      // 区分两种情况：
      //   1. Kp 临界振荡（P 阶段就有振荡，稳态误差大，Kp 未达上限）→ 减小 Kp 抑制振荡，增大 Ki 补偿稳态误差
      //      典型场景：小惯量系统 Kp 临近失稳，加 Kd 会放大噪声失稳，只能减小 Kp
      //   2. Ki 引起极限环（Kp 已达上限或稳态误差小）→ 加 Kd 增加阻尼抑制
      const steadyErrRatio = Math.abs(finite(metrics.steadyError, 0))
        / Math.max(Math.abs(finite(metrics.stepSize, 1)), 1e-6)
      const currentKp = finite(current[isCascade ? 'positionKp' : 'kp'], 0)
      const kpBound = PARAM_BOUNDS[isCascade ? 'positionKp' : 'kp']
      // Kp 临界振荡判定：稳态误差大 + Kp 未达上限（Kp 还有空间但已振荡）
      // 若 Kp 已达上限，稳态误差大是 Kp 力不能及（如位置环 Kp 饱和），振荡是 Ki 极限环
      const kpCriticalOsc = steadyErrRatio > 0.05 && currentKp < kpBound * 0.99
      if (kpCriticalOsc) {
        // Kp 临界振荡：减小 Kp 抑制振荡，增大 Ki 补偿稳态误差
        adjustments.push({ P: 0.85, I: 1.3 })
        reasons.push(`阶段2(PI)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且稳态误差大（${fmt(steadyErrRatio * 100, 1)}%），Kp 临界振荡，减小 Kp 抑制振荡、增大 Ki 补偿稳态误差`)
      } else {
        // Ki 极限环：加 Kd 增加阻尼抑制（而非减小 Ki，因为需要 Ki 消除稳态误差）
        adjustments.push({ D: 1.0 })
        reasons.push(`阶段2(PI)完成：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3%，进入阶段3(PID)加 Kd 抑制振荡`)
        phase = 'PID'
      }
    } else if (Math.abs(metrics.steadyError) > Math.max(Math.abs(metrics.stepSize) * 0.05, 1e-6)) {
      // 稳态误差偏大：根据误差大小动态选择 Ki 增长因子（加速收敛）
      const steadyErrRatio = Math.abs(metrics.steadyError) / Math.max(Math.abs(metrics.stepSize), 1e-6)
      let factor, desc
      if (steadyErrRatio > 0.2) { factor = 2.0; desc = '稳态误差较大，激进增大 Ki（×2.0）' }
      else if (steadyErrRatio > 0.05) { factor = 1.5; desc = '稳态误差中等，中等幅度增大 Ki（×1.5）' }
      else { factor = 1.2; desc = '稳态误差较小，保守增大 Ki（×1.2）' }
      adjustments.push({ I: factor })
      reasons.push(`阶段2(PI)：${desc}`)
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
    const currentKd = finite(current[isCascade ? 'speedKd' : 'kd'], 0)
    const currentKi = finite(current[isCascade ? 'speedKi' : 'ki'], 0)
    const kdBound = PARAM_BOUNDS[isCascade ? 'speedKd' : 'kd']
    const oscOverLimit = finite(metrics.oscillation, 0) > 3
    const hasHighOvershoot = metrics.overshoot > metrics.limits.overshoot
    const hasSigOsc = !!metrics.hasSignificantOscillation
    // 失稳检测：系统失稳（status≠STABLE 且振荡很大）
    const destabilized = metrics.status !== 'STABLE' && finite(metrics.oscillation, 0) > 20

    if (destabilized) {
      if (unstable) {
        // 不稳定系统失稳：回到 PD 阶段（Ki=0），保留 Kd 阻尼，Kp 由下一轮 PD 重新探索
        adjustments.push({ I: 0.0 })
        reasons.push(`阶段3(PID)：系统失稳（振荡 ${fmt(metrics.oscillation, 1)}%），不稳定系统回到 PD 阶段（清零 Ki）`)
        phase = 'PD'
      } else {
        // 稳定系统失稳：Kd 过大放大噪声
        // 减半 Kd 重试，而不是直接清零（避免 Kd=0 → PI 振荡 → 又加 Kd=起始值 → 又失稳 的死循环）
        // 直到 Kd 减到很小仍失稳，才关闭 Kd 改为减小 Kp
        const currentKd = finite(current[isCascade ? 'speedKd' : 'kd'], 0)
        if (currentKd > 0.01) {
          adjustments.push({ D: 0.5 })
          reasons.push(`阶段3(PID)：Kd=${fmt(currentKd, 3)} 引入失稳（振荡 ${fmt(metrics.oscillation, 1)}%），减半 Kd 重试`)
        } else {
          // Kd 已很小仍失稳 → 关闭 Kd，回到 PI 减小 Kp 抑制振荡
          adjustments.push({ D: 0.0, P: 0.85, I: 1.2 })
          reasons.push(`阶段3(PID)：Kd=${fmt(currentKd, 4)} 已很小仍失稳，关闭 Kd 回到 PI，减小 Kp 抑制振荡、增大 Ki 补偿稳态误差`)
          phase = 'PI'
        }
      }
    } else if (hasHighOvershoot || hasSigOsc) {
      // 超调/显著震荡：Ki 是主因（PID 阶段刚加 Ki），优先减小 Ki 而非增大 Kd
      // 增大 Kd 会放大高频噪声、加剧震荡，所以只有 Ki 已很小时才增大 Kd
      if (currentKi > 0.05) {
        adjustments.push({ I: 0.5 })
        reasons.push(`阶段3(PID)：超调 ${fmt(metrics.overshoot, 1)}%/震荡（峰数 ${metrics.oscillationPeakCount}），减小 Ki（${fmt(currentKi, 3)}→${fmt(currentKi * 0.5, 3)}）`)
      } else if (currentKd < kdBound * 0.95) {
        adjustments.push({ D: 1.3 })
        reasons.push(`阶段3(PID)：超调 ${fmt(metrics.overshoot, 1)}% 但 Ki 已很小，增大 Kd 增加阻尼（Kd ${fmt(currentKd, 2)}→${fmt(currentKd * 1.3, 2)}）`)
      } else {
        adjustments.push({ P: 0.85 })
        reasons.push(`阶段3(PID)：超调 ${fmt(metrics.overshoot, 1)}% 且 Kd 已达上限，减小 Kp`)
      }
    } else if (oscOverLimit && finite(current[isCascade ? 'positionKp' : 'kp'], 0) > 0.5) {
      // 稳态振幅 > 3% 但系统稳定无显著震荡
      const currentKp = finite(current[isCascade ? 'positionKp' : 'kp'], 0)
      const kpBound = PARAM_BOUNDS[isCascade ? 'positionKp' : 'kp']
      const steadyErrRatio = Math.abs(finite(metrics.steadyError, 0))
        / Math.max(Math.abs(finite(metrics.stepSize, 1)), 1e-6)
      const kpAtBound = currentKp >= kpBound * 0.99
      // 稳定系统：稳态误差大 + 振荡大 + Kp 未达上限 → Kp 临界振荡（非 Ki 极限环）
      // 减小 Kp 抑制振荡，增大 Ki 补偿稳态误差（典型场景：小惯量系统 Kp 临近失稳）
      // 若 Kp 已达上限，稳态误差大是 Kp 力不能及，振荡是 Ki 极限环，应增大 Kd
      const kpCriticalOsc = !unstable && steadyErrRatio > 0.05 && !kpAtBound
      // Kp 饱和极限环：Kp 达上限 + Kd 已较大 + 振荡未改善 → 速度目标饱和导致极限环
      // Kd 无法抑制这种饱和振荡，只能减小 Kp 解除饱和（不增大 Ki，因为 Ki 已够大）
      const kpSaturationOsc = !unstable && kpAtBound && currentKd > 0.5
      if (kpCriticalOsc) {
        adjustments.push({ P: 0.85, I: 1.3 })
        reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且稳态误差大（${fmt(steadyErrRatio * 100, 1)}%），Kp 临界振荡，减小 Kp 抑制振荡、增大 Ki 补偿稳态误差`)
      } else if (kpSaturationOsc) {
        // Kp 饱和极限环：减小 Kp 解除速度目标饱和（不增大 Ki，避免加剧极限环）
        adjustments.push({ P: 0.9 })
        reasons.push(`阶段3(PID)：Kp=${fmt(currentKp, 2)} 达上限且 Kd=${fmt(currentKd, 2)} 较大，振荡 ${fmt(metrics.oscillation, 1)}% 未改善，Kp 饱和导致极限环，减小 Kp 解除饱和`)
      } else if (unstable && currentKd > 2) {
        // 不稳定系统 Kd 过大（>2）会放大噪声导致振荡加剧（D项噪声 ∝ Kd×noise/dt）
        // 减小 Kd 以降低噪声放大；同时若稳态误差大则增大 Kp 提供更强回复力矩
        if (steadyErrRatio > 0.1) {
          adjustments.push({ D: 0.7, P: 1.2 })
          reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且 Kd=${fmt(currentKd, 2)} 过大放大噪声、稳态误差大，减小 Kd 并增大 Kp`)
        } else {
          adjustments.push({ D: 0.7 })
          reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且 Kd=${fmt(currentKd, 2)} 过大放大噪声，减小 Kd`)
        }
      } else if (unstable && steadyErrRatio > 0.1) {
        // 不稳定系统稳态误差大 → Kp 不足，增大 Kp 提供更强回复力矩（而非减小 Kp）
        adjustments.push({ P: 1.3 })
        reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且稳态误差大（${fmt(steadyErrRatio * 100, 1)}%），增大 Kp 提供更强回复力矩`)
      } else if (currentKd < kdBound * 0.95) {
        adjustments.push({ D: 1.4 })
        reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3%，增大 Kd 增加阻尼（Kd ${fmt(currentKd, 2)}→${fmt(currentKd * 1.4, 2)}）`)
      } else {
        // Kd 已达上限才减小 Kp
        adjustments.push({ P: 0.85, I: 0.9 })
        reasons.push(`阶段3(PID)：稳态振幅 ${fmt(metrics.oscillation, 1)}% > 3% 且 Kd 已达上限 ${fmt(kdBound, 1)}，减小 Kp`)
      }
    } else if (noisy && !unstable) {
      // 噪声大 → 关闭 D，回到 PI（不稳定系统例外，Kd 必需）
      adjustments.push({ D: 0.0 })
      reasons.push('阶段3(PID)：检测到反馈噪声较大，关闭 Kd（D 项会放大噪声），回到 PI')
      phase = 'PI'
    } else if (Math.abs(metrics.steadyError) > Math.max(Math.abs(metrics.stepSize) * 0.05, 1e-6)) {
      // 稳态误差偏大：根据误差大小动态选择 Ki 增长因子（加速收敛）
      const steadyErrRatio = Math.abs(metrics.steadyError) / Math.max(Math.abs(metrics.stepSize), 1e-6)
      let factor, desc
      if (steadyErrRatio > 0.3) { factor = 2.0; desc = '稳态误差较大，激进增大 Ki（×2.0）' }
      else if (steadyErrRatio > 0.1) { factor = 1.5; desc = '稳态误差中等，中等幅度增大 Ki（×1.5）' }
      else { factor = 1.3; desc = '稳态误差较小，保守增大 Ki（×1.3）' }
      adjustments.push({ I: factor })
      reasons.push(`阶段3(PID)：${desc}`)
    } else {
      adjustments.push({ D: 1.1 })
      reasons.push('阶段3(PID)：已基本达标，微调 Kd 优化阻尼')
    }
  }

  // 默认调参顺序：串级以位置环（外环）为主，位置环Kp 排首位（posIdx=0 不衰减）
  // 速度环作为内环跟随，其 Kp 调整通过 loop=0.3 权重衰减
  const tuningOrder = options.tuningOrder && options.tuningOrder.length
    ? options.tuningOrder
    : (isCascade
        ? ['位置环Kp', '位置环Ki', '位置环Kd', '速度环Kp', '速度环Ki']
        : ['Kp', 'Ki', 'Kd'])

  const result = { ...base }
  paramKeys.forEach((key) => {
    const spec = PARAM_SPEC[key]
    const orderPos = tuningOrder.indexOf(spec.orderName)
    const posIdx = orderPos >= 0 ? orderPos : 0
    let value = result[key]
    // 从零开始时给一个小初始值，否则 0×factor 永远是 0
    // 不稳定系统（倒立摆）需要更大起始 Kp 才能克服重力失稳（Kp > mgl/J）
    // 串级位置环（外环）需要更大起始 Kp 才能获得足够快的响应
    if (value < 1e-9 && spec.role === 'P' && (phase === 'P' || phase === 'PD')) {
      if (unstable) value = 5.0
      else if (isCascade && key === 'positionKp') value = 2.0  // 位置环起始值更大以加快响应
      else value = 0.5
    }
    // PI 阶段从 0 开始 Ki 时给一个起始值（避免 Ki=0 死锁）
    // 不稳定系统 Ki 起始值更小（0.05），避免引入过大超调和震荡
    if (value < 1e-9 && spec.role === 'I' && (phase === 'PI' || phase === 'PID')) {
      value = unstable ? 0.05 : 0.3
    }
    // PID 阶段从 0 开始 Kd 时给一个起始值
    // 起始值取 0.01（而非 0.05）：小惯量系统（J=0.01, dt=0.01）D 项 = Kd·d/dt，
    // Kd=0.05 时 D 项增益 = 5，易放大噪声失稳；Kd=0.01 时 D 项增益 = 1，更安全
    if (value < 1e-9 && spec.role === 'D' && phase === 'PID' && !unstable) {
      value = 0.01
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
    // 阶段约束：
    //   P 阶段强制 Ki=Kd=0
    //   PI 阶段强制 Kd=0
    //   PD 阶段强制 Ki=0（保留 Kd）
    if (phase === 'P' && spec.role !== 'P') value = 0
    else if (phase === 'PI' && spec.role === 'D') value = 0
    else if (phase === 'PD' && spec.role === 'I') value = 0
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
