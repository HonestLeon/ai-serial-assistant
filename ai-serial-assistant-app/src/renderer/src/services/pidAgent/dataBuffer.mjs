import { analyzeControlSamples, sliceLastTransition } from '../controlAnalysis.mjs'

/**
 * PID 调参智能体 —— 带时间戳的通道数据环形缓冲。
 *
 * 纯 JS 模块（无 Vue/DOM/window 依赖）。串口采样流持续 push 进缓冲，
 * 智能体工具（get_channel_data / get_channel_stats 等）按时间段 query/stats，
 * 阶跃响应指标直接复用 controlAnalysis 的确定性分析。
 */

// ---- 模块内私有工具函数（不导出） ----

const finite = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// 保留 6 位小数，控制进入 LLM 上下文的数值长度
const round6 = (value) => Number(value.toFixed(6))

// 缓冲支持的数据通道
const KNOWN_CHANNELS = ['target', 'feedback', 'output']
// 可选诊断通道（串级仿真的速度指令/实际速度）：仅显式请求时返回，不参与默认查询
const EXTRA_CHANNELS = ['speedTarget', 'speed']
const ALL_CHANNELS = [...KNOWN_CHANNELS, ...EXTRA_CHANNELS]

// 归一化通道列表：仅保留已知通道并去重；全部非法时回退为默认三通道
const sanitizeChannels = (channels) => {
  const list = Array.isArray(channels) && channels.length ? channels : KNOWN_CHANNELS
  const result = []
  for (const channel of list) {
    if (ALL_CHANNELS.includes(channel) && !result.includes(channel)) result.push(channel)
  }
  return result.length ? result : [...KNOWN_CHANNELS]
}

// 二分查找：第一个 t ≥ time 的索引
// 起点容差：会话时钟由浮点累加而来（如 4.1 累计三次得 12.2999...），查询端点会略大于
// 段首样本时刻；若无容差会把段首样本（含 target 跳变的阶跃起点）误剔除，
// 导致选区 target 恒定 → stepSize=0 → 阶跃指标归一化炸裂。容差取 1e-9（远小于采样间隔）。
const LOWER_BOUND_EPS = 1e-9
const lowerBound = (samples, time) => {
  let low = 0
  let high = samples.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].t < time - LOWER_BOUND_EPS) low = mid + 1
    else high = mid
  }
  return low
}

// 二分查找：第一个 t > time 的索引
const upperBound = (samples, time) => {
  let low = 0
  let high = samples.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].t <= time) low = mid + 1
    else high = mid
  }
  return low
}

// 单通道统计：mean / std(总体标准差) / min / max / peak(绝对峰值) / rms
const channelStats = (values) => {
  const count = values.length
  if (!count) {
    return { mean: 0, std: 0, min: 0, max: 0, peak: 0, rms: 0, sampleCount: 0 }
  }
  let sum = 0
  let squareSum = 0
  let min = Infinity
  let max = -Infinity
  let peak = 0
  for (const value of values) {
    sum += value
    squareSum += value * value
    if (value < min) min = value
    if (value > max) max = value
    const abs = Math.abs(value)
    if (abs > peak) peak = abs
  }
  const mean = sum / count
  let varianceSum = 0
  for (const value of values) varianceSum += (value - mean) * (value - mean)
  return {
    mean: round6(mean),
    std: round6(Math.sqrt(varianceSum / count)),
    min: round6(min),
    max: round6(max),
    peak: round6(peak),
    rms: round6(Math.sqrt(squareSum / count)),
    sampleCount: count
  }
}

/**
 * 创建通道数据环形缓冲。
 * @param {{capacitySec?:number, maxSamples?:number, acceptance?:{overshootLimit:number, oscillationLimit:number}}} [options]
 *   - capacitySec：时间容量（秒），淘汰 t < 最新t - capacitySec 的旧样本
 *   - maxSamples：样本总量上限，超出时淘汰最旧样本
 *   - acceptance：验收线（超调/振荡上限），决定 analyzeControlSamples 的 limits；
 *     缺省 20/10（串口模式与缺省路径）
 */
export function createDataBuffer({ capacitySec = 600, maxSamples = 60000, acceptance } = {}) {
  const capacity = Math.max(1, finite(capacitySec, 600))
  const sampleLimit = Math.max(2, Math.round(finite(maxSamples, 60000)))
  // 验收线：与提示词/护栏保持一致（仿真按策略注入，串口/缺省回退 20/10）
  const acceptanceLimits = acceptance && Number.isFinite(Number(acceptance.overshootLimit))
    ? acceptance
    : { overshootLimit: 20, oscillationLimit: 10 }
  /** @type {Array<{t:number, target:number, feedback:number, output:number}>} */
  const samples = []

  // 淘汰旧数据：先按时间容量，再按总量上限
  const evict = () => {
    if (samples.length) {
      const cutoff = samples[samples.length - 1].t - capacity
      const keepFrom = lowerBound(samples, cutoff)
      if (keepFrom > 0) samples.splice(0, keepFrom)
    }
    if (samples.length > sampleLimit) samples.splice(0, samples.length - sampleLimit)
  }

  /**
   * 写入采样数据（单条或数组）。t 为相对调参开始的秒数，缓冲按 t 升序维护；
   * 返回实际写入的样本数（非法样本会被跳过）。
   * @param {{t:number, target:number, feedback:number, output:number}|Array} input
   */
  const push = (input) => {
    const list = Array.isArray(input) ? input : [input]
    const firstNew = samples.length
    let added = 0
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const t = Number(item.t)
      if (!Number.isFinite(t)) continue
      // 可选诊断字段（串级仿真样本的 speedTarget/speed）：有限数才写入，
      // 串口/单环样本缺省时不写（查询序列化为 null，agent 可辨"不可用"）
      const sp = Number(item.speedTarget)
      const v = Number(item.speed)
      samples.push({
        t,
        target: finite(item.target),
        feedback: finite(item.feedback),
        output: finite(item.output),
        ...(Number.isFinite(sp) ? { speedTarget: sp } : {}),
        ...(Number.isFinite(v) ? { speed: v } : {})
      })
      added += 1
    }
    if (!added) return 0
    // 串口流式数据天然按 t 递增，仅当乱序写入时才整体重排（避免每次 push 都排序）
    let sorted = firstNew === 0 || samples[firstNew].t >= samples[firstNew - 1].t
    for (let i = firstNew + 1; sorted && i < samples.length; i += 1) {
      if (samples[i - 1].t > samples[i].t) sorted = false
    }
    if (!sorted) samples.sort((a, b) => a.t - b.t)
    evict()
    return added
  }

  // 解析查询区间：参数非法直接抛错；越界部分截断到缓冲范围并标记 clipped
  const resolveRange = (timeRange) => {
    if (!Array.isArray(timeRange) || timeRange.length !== 2) {
      throw new Error('时间段参数非法：需要 [start, end] 形式')
    }
    const rawStart = Number(timeRange[0])
    const rawEnd = Number(timeRange[1])
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd <= rawStart) {
      throw new Error(`时间段参数非法：start=${timeRange[0]}, end=${timeRange[1]}（要求 start ≥ 0 且 end > start）`)
    }
    if (!samples.length) {
      throw new Error('时间段无数据：缓冲区为空')
    }
    const bufferStart = samples[0].t
    const bufferEnd = samples[samples.length - 1].t
    let start = rawStart
    let end = rawEnd
    let clipped = false
    if (start < bufferStart) {
      start = bufferStart
      clipped = true
    }
    if (end > bufferEnd) {
      end = bufferEnd
      clipped = true
    }
    if (end <= start) {
      throw new Error(`时间段无数据：[${rawStart}, ${rawEnd}] 与缓冲范围 [${bufferStart}, ${bufferEnd}] 无交集`)
    }
    return { start, end, clipped }
  }

  // 截取闭区间 [start, end] 内的样本
  const sliceRange = (start, end) => samples.slice(lowerBound(samples, start), upperBound(samples, end))

  /**
   * 按时间段查询通道数据（供 get_channel_data 工具使用）。
   * @param {{timeRange:[number,number], channels?:string[], maxPoints?:number}} [options]
   * @returns {{timeRange:[number,number], sampleCount:number, downsampled:boolean, clipped:boolean, data:{t:number[], target?:number[], feedback?:number[], output?:number[]}}}
   *   - timeRange：实际返回的数据区间（首/末样本时刻）
   *   - sampleCount：区间内原始样本数；超过 maxPoints 时索引法均匀下采样（首尾点必含）
   *   - clipped：请求区间是否被截断到缓冲范围
   * @throws {Error} 区间无数据时抛错
   */
  const query = ({ timeRange, channels = KNOWN_CHANNELS, maxPoints = 30 } = {}) => {
    const { start, end, clipped } = resolveRange(timeRange)
    const rangeSamples = sliceRange(start, end)
    if (!rangeSamples.length) {
      throw new Error(`时间段无数据：[${start}, ${end}] 内没有采样点`)
    }
    const count = rangeSamples.length
    const limit = Math.max(2, Math.round(finite(maxPoints, 30)))
    let selected = rangeSamples
    let downsampled = false
    if (count > limit) {
      // 索引法均匀下采样：等距取 limit 个索引，i=0 与 i=limit-1 对应首尾样本
      downsampled = true
      const step = (count - 1) / (limit - 1)
      selected = []
      for (let i = 0; i < limit; i += 1) {
        selected.push(rangeSamples[Math.round(i * step)])
      }
    }
    const data = { t: selected.map((sample) => sample.t) }
    for (const channel of sanitizeChannels(channels)) {
      data[channel] = selected.map((sample) => sample[channel])
    }
    return {
      timeRange: [selected[0].t, selected[selected.length - 1].t],
      sampleCount: count,
      downsampled,
      clipped,
      data
    }
  }

  /**
   * 按时间段统计通道指标与阶跃响应指标（供 get_channel_stats 工具使用）。
   * @param {{timeRange:[number,number], channels?:string[]}} [options]
   * @returns {{timeRange:[number,number], channels:Object<string, {mean:number, std:number, min:number, max:number, peak:number, rms:number, sampleCount:number}>, stepMetrics:({valid:true, overshoot:number, settlingTime:number, steadyError:number, rmse:number, oscillation:number, status:string, riseTime:number, stepSize:number, finalFeedback:number, finalTarget:number, oscillationPeakCount:number, oscillationFrequency:number|null, hasSignificantOscillation:boolean, health:string, limits:object}|null), sampleCount:number, clipped:boolean}}
   * @throws {Error} 区间无数据时抛错
   */
  const stats = ({ timeRange, channels = KNOWN_CHANNELS } = {}) => {
    const { start, end, clipped } = resolveRange(timeRange)
    const rangeSamples = sliceRange(start, end)
    if (!rangeSamples.length) {
      throw new Error(`时间段无数据：[${start}, ${end}] 内没有采样点`)
    }
    const channelResult = {}
    for (const channel of sanitizeChannels(channels)) {
      channelResult[channel] = channelStats(rangeSamples.map((sample) => sample[channel]))
    }

    // 阶跃响应指标只分析「窗口内最后一次目标变化段」（含阶跃前基线）：
    // 查询窗口常跨越多轮 set_target 累积的缓冲，整窗分析会让 findStep 取到任意一次
    // 跳变，指标混杂所有工况（实测：多次查询返回完全相同的脏指标、峰数虚高）。
    // stepCount 告知窗口内目标变化次数；finalValues 提供末段稳态读数
    // （稳态窗口 stepMetrics 为 null 时，LLM 仍能读到当前稳态值）。
    const { segment, transitionCount } = sliceLastTransition(rangeSamples)
    const tailCount = Math.max(3, Math.round(segment.length * 0.15))
    const tail = segment.slice(-tailCount)
    const finalValues = {
      target: finite(tail.map((s) => s.target).reduce((a, b) => a + b, 0) / tail.length),
      feedback: finite(tail.map((s) => s.feedback).reduce((a, b) => a + b, 0) / tail.length),
      output: finite(tail.map((s) => s.output).reduce((a, b) => a + b, 0) / tail.length)
    }
    // 阶跃响应指标复用确定性分析（阈值与默认验收线一致；acceptance 支持按模式/策略注入）
    const analysis = analyzeControlSamples(segment, {
      overshootLimit: acceptanceLimits.overshootLimit,
      oscillationLimit: acceptanceLimits.oscillationLimit
    })
    const stepMetrics = analysis.valid
      ? {
          valid: true,
          overshoot: analysis.overshoot,
          settlingTime: analysis.settlingTime,
          steadyError: analysis.steadyError,
          rmse: analysis.rmse,
          oscillation: analysis.oscillation,
          status: analysis.status,
          // 未收敛标记：尾段仍在变化时指标为非稳态中途值（STILL_RISING / 提示语）
          converged: analysis.converged,
          convergenceNote: analysis.convergenceNote,
          // 扩展字段：帮助 LLM 精准对照验收线、区分峰值与稳态（消除数值误读）
          riseTime: analysis.riseTime,                                    // 上升时间（秒）
          stepSize: analysis.stepSize,                                    // 阶跃幅值（归一化基线）
          finalFeedback: analysis.finalFeedback,                          // 稳态段反馈末值
          finalTarget: analysis.finalTarget,                              // 稳态段目标末值
          oscillationPeakCount: analysis.oscillationPeakCount,            // 振荡峰数
          oscillationFrequency: analysis.oscillationFrequency,            // 振荡频率（Hz，无法判定时 null）
          hasSignificantOscillation: analysis.hasSignificantOscillation,  // 明显震荡标记
          health: analysis.health,                                        // 良好/需关注/高风险
          limits: analysis.limits                                         // 验收线（LLM 直接对照）
        }
      : analysis.valid === false && analysis.targetRamping
        // 斜坡进行中：保留 targetRamping 标记与原因（null 会丢失关键语义）
        ? {
            valid: false,
            targetRamping: true,
            reason: analysis.reason,
            finalTarget: analysis.finalTarget,
            finalFeedback: analysis.finalFeedback
          }
        : null
    return {
      timeRange: [rangeSamples[0].t, rangeSamples[rangeSamples.length - 1].t],
      channels: channelResult,
      stepMetrics,
      stepCount: transitionCount,
      finalValues,
      sampleCount: rangeSamples.length,
      clipped
    }
  }

  /** 当前缓冲时间范围（空缓冲返回 { start: null, end: null, count: 0 }） */
  const getRange = () => ({
    start: samples.length ? samples[0].t : null,
    end: samples.length ? samples[samples.length - 1].t : null,
    count: samples.length
  })

  /** 清空缓冲 */
  const clear = () => {
    samples.length = 0
  }

  /** 估算缓冲占用的上下文字节数（全部样本 JSON 长度，供上下文计量参考） */
  const totalBytes = () => (samples.length ? JSON.stringify(samples).length : 0)

  return { push, query, stats, getRange, clear, totalBytes }
}
