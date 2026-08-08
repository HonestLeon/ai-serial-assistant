const SINGLE_PID_KEYS = ['kp', 'ki', 'kd']
const CASCADE_PID_KEYS = ['speedKp', 'speedKi', 'speedKd', 'positionKp', 'positionKi', 'positionKd']

export const PID_PROMPT_VERSION = '2026-08-08.v1'

function finite(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function round(value, digits = 5) {
  const n = finite(value)
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

export function buildPidJsonSchema(cascade = false) {
  const keys = cascade ? CASCADE_PID_KEYS : SINGLE_PID_KEYS
  const properties = {}
  keys.forEach((key) => {
    properties[key] = {
      type: 'number',
      minimum: 0,
      maximum: key.toLowerCase().endsWith('kp') ? 20 : 10,
      description: `${key} 的下一轮候选值`
    }
  })
  properties.analysis_summary = {
    type: 'string',
    maxLength: 240,
    description: '简明说明指标判断、调节方向和工程依据，不输出隐藏思维链'
  }
  properties.self_check = {
    type: 'string',
    maxLength: 300,
    description: '核对参数范围、阶段约束、调整幅度和预期效果'
  }
  return {
    type: 'object',
    properties,
    required: [...keys, 'analysis_summary', 'self_check'],
    additionalProperties: false
  }
}

export function buildStructuredResponseFormat(cascade = false) {
  return {
    type: 'json_schema',
    json_schema: {
      name: cascade ? 'cascade_pid_candidate' : 'pid_candidate',
      strict: true,
      schema: buildPidJsonSchema(cascade)
    }
  }
}

export function parsePidAiResponse(text, cascade = false) {
  if (!text) return { ok: false, error: '模型返回为空' }
  const cleaned = String(text).trim().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) return { ok: false, error: '未找到完整 JSON 对象' }
  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1))
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error.message}` }
  }
  const keys = cascade ? CASCADE_PID_KEYS : SINGLE_PID_KEYS
  const params = {}
  for (const key of keys) {
    const value = Number(parsed[key])
    const max = key.toLowerCase().endsWith('kp') ? 20 : 10
    if (!Number.isFinite(value)) return { ok: false, error: `${key} 缺失或不是有效数字` }
    if (value < 0 || value > max) return { ok: false, error: `${key}=${value} 超出 0~${max}` }
    params[key] = value
  }
  const analysisSummary = String(parsed.analysis_summary || parsed.thought || '').trim().slice(0, 240)
  const selfCheck = String(parsed.self_check || '').trim().slice(0, 300)
  if (!analysisSummary) return { ok: false, error: '缺少 analysis_summary（工程依据摘要）' }
  return { ok: true, params, analysisSummary, selfCheck }
}

export function downsamplePidWaveform(samples, targetPoints = 30) {
  if (!Array.isArray(samples) || samples.length === 0) return []
  const count = Math.max(2, Math.floor(targetPoints) || 30)
  const indexes = samples.length <= count
    ? samples.map((_, index) => index)
    : Array.from({ length: count }, (_, index) => Math.round(index * (samples.length - 1) / (count - 1)))
  return [...new Set(indexes)].map((index) => {
    const sample = samples[index] || {}
    const target = finite(sample.target)
    const feedback = finite(sample.feedback ?? sample.actual)
    return {
      t: round(sample.t, 4),
      target: round(target),
      feedback: round(feedback),
      error: round(target - feedback),
      output: round(sample.output)
    }
  })
}

function compactMetrics(metrics = {}) {
  return {
    status: metrics.status || 'UNKNOWN',
    rmse: metrics.rmse ?? null,
    overshoot: metrics.overshoot ?? null,
    steadyError: metrics.steadyError ?? null,
    oscillation: metrics.oscillation ?? null
  }
}

function approximateScore(record) {
  if (Number.isFinite(Number(record?.score))) return Number(record.score)
  const m = record?.metrics || {}
  const penalty = m.status === 'STABLE' ? 0 : 10
  return Math.abs(finite(m.rmse)) + Math.abs(finite(m.steadyError)) + finite(m.overshoot) * 0.5 + penalty
}

export function pickSuccessfulPidExamples(history, maxExamples = 2) {
  if (!Array.isArray(history) || history.length < 2) return []
  const candidates = []
  for (let index = 0; index < history.length - 1; index += 1) {
    const current = history[index]
    const next = history[index + 1]
    if (!current?.proposedPid || !next?.metrics) continue
    const before = approximateScore(current)
    const after = approximateScore(next)
    if (!Number.isFinite(before) || !Number.isFinite(after) || after >= before) continue
    candidates.push({
      improvement: before - after,
      input: {
        testedPid: current.testedPid || current.pid,
        metrics: compactMetrics(current.metrics),
        phase: current.phase || null
      },
      output: {
        proposedPid: current.proposedPid,
        basis: current.thought || current.analysis || ''
      },
      verifiedResult: {
        metrics: compactMetrics(next.metrics),
        scoreChange: `${round(before, 3)} -> ${round(after, 3)}`
      }
    })
  }
  return candidates.sort((a, b) => b.improvement - a.improvement).slice(0, Math.max(0, maxExamples))
}

export function buildStructuredPidHistory(history, maxChars = 3200) {
  if (!Array.isArray(history) || history.length === 0) return []
  const selected = []
  let used = 2
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    const distance = history.length - index
    const entry = {
      round: item.round,
      testedPid: item.testedPid || item.pid || null,
      metrics: compactMetrics(item.metrics),
      decision: item.decision || null,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null
    }
    if (distance <= 2) {
      entry.proposedPid = item.proposedPid || null
      entry.source = item.source || null
      entry.basis = String(item.thought || item.analysis || '').slice(0, 260)
    }
    const size = JSON.stringify(entry).length + 1
    if (selected.length && used + size > maxChars) break
    selected.unshift(entry)
    used += size
  }
  return selected
}

export function buildPidSystemPrompt({ cascade = false, phase = 'P', formatSpec = '', hasFeedforward = false } = {}) {
  const cascadeRule = cascade
    ? '这是串级控制。必须优先保证速度内环稳定；当前上下文无法独立证明内环达标时，不得同时大幅修改内外环。每轮优先只调整调参顺序中最靠前的环路参数。'
    : '这是单环控制，每轮只做与当前阶段直接相关的最小必要修改。'
  const feedforwardRule = hasFeedforward
    ? '已启用前馈。PID 与前馈应解耦：本次只输出 PID 候选，前馈系数保持不变；不要用 PID 参数代偿未知前馈误差。'
    : '当前未启用前馈。'
  return [
    '角色：你是审慎的控制系统整定工程师，负责提出“下一轮待仿真验证”的 PID 候选，而不是宣称参数已经有效。',
    '目标优先级：1) 保持闭环稳定；2) 抑制持续振荡和危险超调；3) 降低稳态误差；4) 在前三项满足后提高响应速度。',
    `当前阶段：${phase}。`,
    cascadeRule,
    feedforwardRule,
    '工程原则：只依据提供的模型、波形、指标和已验证历史；信息不足时采取保守小步调整；不得虚构设备结构、单位或未提供的测量结果。',
    '输出要求：只输出一个 JSON 对象，不要 Markdown。analysis_summary 给出简明可审计的工程依据；self_check 核对边界、阶段约束、单步变化及预期改善。',
    `输出格式：${formatSpec}`
  ].join('\n')
}

export function buildPidRepairMessage(error, formatSpec) {
  return `上一轮输出校验失败：${error}。请根据原任务重新输出严格 JSON；不要解释或使用 Markdown。格式必须为：${formatSpec}`
}
