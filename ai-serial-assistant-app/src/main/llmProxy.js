/**
 * 主进程 LLM 代理的核心实现 —— 纯 Node 模块（不 import electron），可直接单测。
 *
 * 渲染层受 CSP 限制不能直连模型服务，请求统一由主进程转发；这里是转发的安全与资源边界：
 *   1. **仅允许 https**（本地调试的 http://localhost / 127.0.0.1 / [::1] 例外）：
 *      否则 API Key 会以明文出网；
 *   2. **禁止重定向**（`redirect: 'error'`）：避免 https → http 降级把 Key 送出去；
 *   3. **响应体上限**：异常/恶意端点不能把主进程内存撑爆（默认 8MB）；
 *   4. **超时与中止统一**：外部 signal（stopAgent / 关窗）与本次超时各自独立触发 abort。
 *
 * 返回结构保持 `{ ok, status, text, error? }` 的朴素约定——渲染层据此还原 fetch 语义。
 */

/** 响应体上限（字节）：正常 chat/completions 响应远小于此值 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** 默认超时：与渲染层 callLlm 的 timeoutMs 默认值一致 */
export const DEFAULT_TIMEOUT_MS = 120000

/** 允许 http 的本机主机名（本地自建模型端点） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const formatBytes = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
  : `${Math.max(1, Math.round(bytes / 1024))}KB`)

/**
 * 校验模型地址：只接受 https，或指向本机的 http。
 * @param {unknown} rawUrl
 * @returns {{ok: true, url: URL} | {ok: false, error: string}}
 */
export function validateModelUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, error: '模型地址不是合法 URL' }
  }
  if (url.protocol === 'https:') return { ok: true, url }
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return { ok: true, url }
  return {
    ok: false,
    error: `仅支持 https 模型地址（本地调试可用 http://localhost），当前：${url.protocol}//${url.host}`
  }
}

/**
 * 读取响应体并施加字节上限（流式累计，超限立即取消，不把整个响应读进内存）。
 * @param {object} response fetch 响应（需有 body.getReader 或 text()）
 * @param {number} [maxBytes]
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function readBodyWithLimit(response, maxBytes = MAX_RESPONSE_BYTES) {
  const limit = Math.max(1, Number(maxBytes) || MAX_RESPONSE_BYTES)
  const body = response?.body

  // 无流式 body（测试 stub / 老实现）时退化为整体读取，再按字节数判定
  if (!body || typeof body.getReader !== 'function') {
    const text = typeof response?.text === 'function' ? await response.text() : ''
    const value = String(text ?? '')
    if (Buffer.byteLength(value, 'utf8') > limit) {
      return { ok: false, error: `响应体超过 ${formatBytes(limit)} 上限` }
    }
    return { ok: true, text: value }
  }

  const reader = body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > limit) {
      try { await reader.cancel() } catch { /* 取消失败不影响结论 */ }
      return { ok: false, error: `响应体超过 ${formatBytes(limit)} 上限，已中止读取` }
    }
    chunks.push(chunk)
  }
  return { ok: true, text: Buffer.concat(chunks, total).toString('utf8') }
}

/**
 * 执行一次模型请求。
 *
 * @param {object} options
 * @param {string|URL} options.url 目标地址（调用方应先用 validateModelUrl 校验）
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal|null} [options.signal] 外部中止信号（llm:abort / 关窗）
 * @param {Function} [options.fetchImpl] 可注入 fetch（单测用）
 * @param {number} [options.maxResponseBytes]
 * @returns {Promise<{ok: boolean, status: number, text: string, error?: string}>}
 */
export async function requestCompletion({
  url,
  method = 'POST',
  headers = {},
  body = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  fetchImpl = null,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, status: 0, text: '', error: '当前运行环境不支持 fetch' }
  }

  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  signal?.addEventListener('abort', onExternalAbort)
  let timedOut = false
  const effectiveTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, effectiveTimeout)

  try {
    const response = await doFetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      // 禁止跟随重定向：https 跳 http 会把 Authorization 明文发出去
      redirect: 'error'
    })

    const read = await readBodyWithLimit(response, maxResponseBytes)
    if (!read.ok) return { ok: false, status: response.status, text: '', error: read.error }
    return { ok: !!response.ok, status: response.status, text: read.text }
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        status: 0,
        text: '',
        error: `请求超时（${Math.round(effectiveTimeout / 1000)}s 无响应）`
      }
    }
    if (signal?.aborted) return { ok: false, status: 0, text: '', error: '请求已中止' }
    // undici 会把底层原因放在 cause 里（如 redirect:'error' 命中时的 "unexpected redirect"），
    // 拼进消息里，避免只看到无信息量的 "fetch failed"
    const base = error?.message || String(error)
    const cause = error?.cause?.message
    const message = cause && cause !== base ? `${base}（${cause}）` : base
    if (/redirect/i.test(message)) {
      return { ok: false, status: 0, text: '', error: `模型地址返回重定向，已拒绝跟随：${message}` }
    }
    return { ok: false, status: 0, text: '', error: message }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
