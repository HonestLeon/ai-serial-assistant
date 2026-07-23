const NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

export function parseNumericLine(line) {
  const text = typeof line === 'object' && line !== null ? String(line.text ?? '') : String(line ?? '')
  const colonIndex = text.indexOf(':')
  const payload = colonIndex >= 0 ? text.slice(colonIndex + 1) : text
  return (payload.match(NUMBER_PATTERN) || []).slice(0, 8).map(Number).filter(Number.isFinite)
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null
  return Number(value.toFixed(digits))
}

export function computeChannelStatistics(lines) {
  const channels = Array.from({ length: 8 }, () => [])
  for (const line of lines || []) {
    parseNumericLine(line).forEach((value, index) => channels[index].push(value))
  }

  return channels.flatMap((values, index) => {
    if (!values.length) return []
    const n = values.length
    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((sum, value) => sum + value, 0) / n
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
    const first = values[0]
    const last = values[n - 1]
    const slope = n > 1 ? (last - first) / (n - 1) : 0
    return [{
      channel: `I${index}`,
      n,
      min: round(min),
      max: round(max),
      mean: round(mean),
      std: round(Math.sqrt(variance)),
      first: round(first),
      last: round(last),
      delta: round(last - first),
      slope: round(slope)
    }]
  })
}

function vectorChange(previous, current, ranges) {
  const length = Math.max(previous.length, current.length)
  let score = 0
  for (let index = 0; index < length; index += 1) {
    const a = previous[index]
    const b = current[index]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    score = Math.max(score, Math.abs(b - a) / (ranges[index] || 1))
  }
  return score
}

/**
 * 变化感知压缩：变化明显的采样点及其相邻点全部保留，平稳区间均匀抽样。
 * 返回的 lines 是“预处理后的完整集合”，AI 侧不再二次截取最近若干行。
 */
export function preprocessSerialLines(lines, options = {}) {
  const source = (lines || []).map((line, index) => ({
    index,
    text: typeof line === 'object' && line !== null ? String(line.text ?? '') : String(line ?? ''),
    time: typeof line === 'object' && line !== null ? line.time ?? null : null,
    values: parseNumericLine(line)
  }))
  if (source.length <= 2) {
    return {
      lines: source,
      inputCount: source.length,
      outputCount: source.length,
      compressionRatio: 1,
      changeThreshold: 0
    }
  }

  const channelValues = Array.from({ length: 8 }, () => [])
  source.forEach((item) => item.values.forEach((value, index) => channelValues[index].push(value)))
  const ranges = channelValues.map((values) => values.length
    ? Math.max(...values) - Math.min(...values)
    : 1)

  const scores = source.map((item, index) =>
    index === 0 ? 0 : vectorChange(source[index - 1].values, item.values, ranges))
  const sortedPositive = scores.filter((score) => score > 0).sort((a, b) => a - b)
  const percentileIndex = Math.floor(sortedPositive.length * 0.7)
  const adaptiveThreshold = sortedPositive[percentileIndex] || 0.02
  const threshold = Math.max(options.changeThreshold ?? 0.02, adaptiveThreshold)
  const targetCount = Math.max(40, Math.min(options.targetCount ?? 260, source.length))
  const stableStride = Math.max(1, Math.ceil(source.length / targetCount))
  const keep = new Set([0, source.length - 1])

  scores.forEach((score, index) => {
    if (score >= threshold) {
      keep.add(Math.max(0, index - 1))
      keep.add(index)
      keep.add(Math.min(source.length - 1, index + 1))
    }
  })

  for (let index = 0; index < source.length; index += stableStride) keep.add(index)
  const output = Array.from(keep).sort((a, b) => a - b).map((index) => source[index])

  return {
    lines: output,
    inputCount: source.length,
    outputCount: output.length,
    compressionRatio: source.length ? round(output.length / source.length, 4) : 1,
    changeThreshold: round(threshold, 6)
  }
}

export function formatStatistics(statistics) {
  if (!statistics?.length) return '无可用数值通道'
  return statistics.map((item) =>
    `${item.channel}: n=${item.n}, min=${item.min}, max=${item.max}, mean=${item.mean}, ` +
    `std=${item.std}, first=${item.first}, last=${item.last}, delta=${item.delta}, slope=${item.slope}`
  ).join('\n')
}
