/**
 * PID 调参智能体 LLM 客户端：OpenAI 兼容 chat/completions 调用（非流式），支持 tools/tool_calls 协议。
 *
 * 参考 Pi-agent 的消息模型：内部 AgentMessage 与模型消息是两种东西，
 * 发送前必须经 convertToLlm「翻译」——过滤模型不该看的消息（如 UI 通知）、
 * 为 steer/followUp/safety 消息补来源前缀、把内部 toolCalls（对象参数）
 * 转成 OpenAI 协议要求的 JSON 字符串格式。
 *
 * 重试策略与 pidAiClient.mjs 对齐：5 次指数退避 [0,2,4,8,16] 秒；
 * 额外处理部分 OpenAI 兼容后端不支持 function calling 的情况
 * （400/422 且携带 tools 时去掉 tools 立即重试一次）。
 *
 * 本模块不依赖 Vue / DOM / window：fetch 取自 globalThis，可被 tests/ 直接单测。
 */

/** user 消息 kind → 来源前缀（文本中未含时自动补加，帮助模型区分消息来源） */
const USER_KIND_PREFIXES = {
  safety: '[安全机制]',
  steer: '[用户中途插入]',
  followUp: '[用户追加任务]'
}

/**
 * 把内部 AgentMessage 数组翻译为 OpenAI 兼容消息数组。
 *
 * 支持的内部角色：
 *   - user:       { role: 'user', content: 文本, kind?: 'steer'|'followUp'|'safety' }
 *   - assistant:  { role: 'assistant', text: 文本, meta?: { toolCalls: [{ id, name, arguments(对象) }] } }
 *   - toolResult: { role: 'toolResult', content: JSON 字符串, meta: { toolCallId } }
 *   - 其他 role（UI 通知等）：直接跳过，不给模型看
 *
 * @param {Array<object>} agentMessages 内部 AgentMessage 数组
 * @returns {Array<object>} OpenAI 兼容消息数组（role: user / assistant / tool）
 */
export function convertToLlm(agentMessages = []) {
  const messages = []
  for (const msg of agentMessages) {
    if (!msg) continue
    if (msg.role === 'user') {
      let content = typeof msg.content === 'string' ? msg.content : ''
      const prefix = USER_KIND_PREFIXES[msg.kind]
      // 若未含前缀则补加（如「[安全机制] 」），已含则不重复
      if (prefix && content && !content.includes(prefix)) {
        content = `${prefix} ${content}`
      }
      messages.push({ role: 'user', content })
    } else if (msg.role === 'assistant') {
      const text = typeof msg.text === 'string' ? msg.text
        : (typeof msg.content === 'string' ? msg.content : '')
      const message = { role: 'assistant', content: text }
      const toolCalls = msg.meta?.toolCalls ?? []
      if (toolCalls.length > 0) {
        // OpenAI 协议要求 arguments 为 JSON 字符串（内部存对象，这里序列化回去）
        message.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {})
          }
        }))
      }
      messages.push(message)
    } else if (msg.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: msg.meta?.toolCallId,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? null)
      })
    }
    // 其他 role（如 UI 通知）直接跳过：模型只认 user/assistant/tool 三种
  }
  return messages
}

/**
 * 可被 AbortSignal 打断的退避等待。
 * 中止时立即 resolve（由调用方在下一行检查 signal.aborted 后返回），
 * 避免"停止"按钮在退避期间无响应（原实现用裸 setTimeout，最坏等满 16s）。
 * @param {number} seconds 等待秒数（<=0 立即返回）
 * @param {AbortSignal|null} signal 外部中止信号
 */
function waitBeforeRetry(seconds, signal) {
  const ms = Number(seconds) * 1000
  if (!(ms > 0) || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 可重试的 HTTP 状态：限流/超时/服务端错误；其余 4xx 立即失败（重试也不会变好） */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429])

const isRetryableStatus = (status) => status >= 500 || RETRYABLE_STATUS.has(status)

/**
 * 把 HTTP 失败转成可操作的中文说明（直接展示给用户，不再原样抛英文/HTML）。
 * @param {number} status
 * @param {string} detail 响应体片段（已截断）
 */
function describeHttpFailure(status, detail) {
  const suffix = detail ? `：${detail}` : ''
  if (status === 401) return `API Key 无效或已过期（HTTP 401）${suffix}`
  if (status === 403) return `无访问权限（HTTP 403），请确认 Key 的模型权限${suffix}`
  if (status === 404) return `接口或模型不存在（HTTP 404），请检查 baseUrl 与 model${suffix}`
  if (status === 413) return `请求体过大（HTTP 413）${suffix}`
  if (status === 429) return `请求过于频繁或额度不足（HTTP 429）${suffix}`
  if (status === 400 || status === 422) return `请求被服务端拒绝（HTTP ${status}）${suffix}`
  return `HTTP ${status}${suffix}`
}

/**
 * function calling 能力缓存：部分 OpenAI 兼容后端不支持 tools，会稳定返回 400/422。
 * 缓存结论后，同一 baseUrl+model 不再每次先撞一次 400（每回合白费一个 RTT）。
 * @type {Map<string, boolean>}
 */
const toolsSupportCache = new Map()

const toolsCacheKey = (aiConfig) => `${aiConfig?.baseUrl ?? ''}|${aiConfig?.model ?? ''}`

/** 清空 function calling 能力缓存（单测隔离 / 用户更换端点后重置） */
export function resetToolsSupportCache() {
  toolsSupportCache.clear()
}

/**
 * 调用 OpenAI 兼容 chat/completions（非流式），支持 tools/tool_calls 协议。
 *
 * @param {object} options
 *   - aiConfig: { baseUrl, model, apiKey }   必填（apiKey 缺失直接返回失败）
 *   - systemPrompt: 系统提示词（buildSystemPrompt 产物，作为首条 system 消息）
 *   - messages: OpenAI 消息数组（convertToLlm 产物，不含 system）
 *   - tools: 调参工具定义 [{ name, description, parameters }]，默认 []
 *   - signal: 外部 AbortSignal（可为 null）；中止时中断 fetch 并停止重试
 *   - retryDelays: 重试退避秒数表，默认 [0,2,4,8,16]（测试可注入 [0,0,0,0,0] 绕过等待）；
 *     等待期间可被 signal 立即打断；仅 408/409/425/429/5xx 与网络异常会重试
 *   - timeoutMs: 单次请求超时（默认 120s）：服务端挂起不返回时按失败重试，
 *     避免 UI 长时间无反馈地"卡住"；外部 signal 中止不受此限立即返回
 * @returns {Promise<{ok:boolean, content?:string,
 *   toolCalls?:Array<{id:string, name:string, arguments:object}>,
 *   finishReason?:string, usage?:object|null, warnings?:string[], error?:string}>}
 *   arguments 解析失败时该条 toolCall 的 arguments 为 {}，并在 warnings 中注明。
 */
export async function callLlm({
  aiConfig,
  systemPrompt,
  messages,
  tools = [],
  signal = null,
  retryDelays = [0, 2, 4, 8, 16],
  timeoutMs = 120000,
  /** 可注入的 fetch 实现：渲染进程传入走主进程代理的版本；默认用全局 fetch（单测可 stub） */
  fetchImpl = null
} = {}) {
  if (!aiConfig?.apiKey) {
    return { ok: false, error: '未配置 API Key' }
  }

  const requestMessages = [
    { role: 'system', content: systemPrompt ?? '' },
    ...(messages ?? [])
  ]
  // 部分 OpenAI 兼容后端不支持 function calling：已知不支持就直接不带 tools，
  // 未知时先带 tools，遇 400/422 再去掉并记住结论
  const cacheKey = toolsCacheKey(aiConfig)
  const toolsSupported = toolsSupportCache.get(cacheKey) !== false
  let toolsEnabled = tools.length > 0 && toolsSupported

  /** 单次请求（每次尝试独立的 AbortController：外部中止 + 本尝试超时各自独立） */
  async function requestCompletion(includeTools, controller) {
    const body = {
      model: aiConfig.model,
      temperature: 0.2,
      stream: false,
      messages: requestMessages
    }
    if (includeTools) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
      body.tool_choice = 'auto'
    }
    const doFetch = fetchImpl || globalThis.fetch
    return doFetch(`${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // 扩展字段：主进程代理据此设置自己的超时（原生 fetch 会忽略未知选项）
      timeoutMs
    })
  }

  let lastError = ''
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    // 退避必须可被外部中止：否则用户点"停止"要等满当前退避档（最坏 16s）才返回
    await waitBeforeRetry(retryDelays[attempt], signal)
    if (signal?.aborted) {
      return { ok: false, error: '请求已中止' }
    }
    const attemptController = new AbortController()
    const onOuterAbort = () => attemptController.abort()
    signal?.addEventListener('abort', onOuterAbort)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      attemptController.abort()
    }, timeoutMs)
    try {
      let res = await requestCompletion(toolsEnabled, attemptController)
      if (!res.ok && toolsEnabled && (res.status === 400 || res.status === 422)) {
        // 后端可能不支持 function calling：去掉 tools/tool_choice 立即重试一次，并记住结论
        toolsEnabled = false
        toolsSupportCache.set(cacheKey, false)
        res = await requestCompletion(false, attemptController)
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 240)
        lastError = describeHttpFailure(res.status, detail)
        // 4xx（除限流/超时类）重试也不会成功：立即失败，别让用户白等 30s 退避
        if (!isRetryableStatus(res.status)) return { ok: false, error: lastError }
        continue
      }
      // 带 tools 成功 → 记下"该端点支持 function calling"，后续直接带 tools
      if (toolsEnabled) toolsSupportCache.set(cacheKey, true)
      const data = await res.json()
      const choice = data.choices?.[0]
      const finishReason = choice?.finish_reason ?? 'stop'
      const content = choice?.message?.content ?? ''
      const warnings = []
      const toolCalls = (choice?.message?.tool_calls ?? []).map((tc) => {
        let args = {}
        try {
          // 安全解析：arguments 缺省按 '{}'；非法 JSON 不抛错，给 {} 并记入 warnings
          args = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          warnings.push(`工具 ${tc.function?.name ?? '(unknown)'} 的 arguments 不是合法 JSON，已按空对象处理`)
        }
        return { id: tc.id, name: tc.function?.name, arguments: args }
      })
      return { ok: true, content, toolCalls, finishReason, usage: data.usage ?? null, warnings }
    } catch (e) {
      if (signal?.aborted) {
        return { ok: false, error: '请求已中止' }
      }
      if (timedOut) {
        lastError = `请求超时（${Math.round(timeoutMs / 1000)}s 无响应）`
        continue
      }
      lastError = e?.message || String(e)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }
  return { ok: false, error: lastError }
}
