/**
 * 主进程 LLM 代理边界单测（BE-09 / BE-17 回归）。
 *
 * 覆盖：地址白名单（仅 https + 本机 http）、禁止重定向、响应体上限、超时与外中止。
 * 全部走注入的 fetchImpl，不需要真实网络。
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  readBodyWithLimit,
  requestCompletion,
  validateModelUrl
} from '../src/main/llmProxy.js'

/** 构造带流式 body 的假响应 */
const streamResponse = (chunks, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  body: {
    getReader() {
      let index = 0
      return {
        read: async () => (index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true }),
        cancel: async () => {}
      }
    }
  }
})

const textResponse = (text, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => text })

// 1. 地址校验：仅 https，本机允许 http，其余一律拒绝
{
  assert.equal(validateModelUrl('https://api.deepseek.com').ok, true)
  assert.equal(validateModelUrl('https://api.deepseek.com/v1').ok, true)
  assert.equal(validateModelUrl('http://localhost:11434/v1').ok, true, '本机自建端点应放行')
  assert.equal(validateModelUrl('http://127.0.0.1:8000').ok, true)
  assert.equal(validateModelUrl('http://[::1]:8000').ok, true)

  const plainHttp = validateModelUrl('http://api.deepseek.com')
  assert.equal(plainHttp.ok, false, '外网 http 必须拒绝（Key 明文出网）')
  assert.match(plainHttp.error, /https/)

  assert.equal(validateModelUrl('ftp://example.com').ok, false)
  assert.equal(validateModelUrl('not-a-url').ok, false)
  assert.equal(validateModelUrl('').ok, false)
}

// 2. 响应体上限：流式累计，超限立即中止并报可读错误
{
  const oversize = await readBodyWithLimit(streamResponse([Buffer.alloc(6), Buffer.alloc(6)]), 8)
  assert.equal(oversize.ok, false)
  assert.match(oversize.error, /上限/)

  const withinBudget = await readBodyWithLimit(streamResponse([Buffer.from('ab'), Buffer.from('cd')]), 8)
  assert.equal(withinBudget.ok, true)
  assert.equal(withinBudget.text, 'abcd')

  // 无流式 body 的兜底路径也要按字节判定
  const fallback = await readBodyWithLimit(textResponse('x'.repeat(16)), 8)
  assert.equal(fallback.ok, false)

  assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024)
}

// 3. 正常请求：禁止重定向、透传 method/headers/body，返回朴素结构
{
  const seen = []
  const result = await requestCompletion({
    url: 'https://api.example.com/v1/chat/completions',
    method: 'POST',
    headers: { Authorization: 'Bearer k' },
    body: '{"model":"m"}',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return textResponse('{"choices":[]}')
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.text, '{"choices":[]}')
  assert.equal(seen[0].init.redirect, 'error', '必须禁止跟随重定向，避免 https→http 降级泄露 Key')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer k')
  assert.equal(seen[0].init.body, '{"model":"m"}')
}

// 4. 非 2xx：ok=false 但保留 status/text（渲染层拼 "HTTP xxx：detail"）
{
  const result = await requestCompletion({
    url: 'https://api.example.com',
    fetchImpl: async () => textResponse('bad key', { ok: false, status: 401 })
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(result.text, 'bad key')
}

// 5. 响应体超限：返回错误而不是把整个响应读进内存
{
  const result = await requestCompletion({
    url: 'https://api.example.com',
    maxResponseBytes: 8,
    fetchImpl: async () => streamResponse([Buffer.alloc(32)])
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /上限/)
}

// 6. 重定向被拒：把 undici 的 "unexpected redirect" 转成可读中文（含 cause 包装的情况）
{
  const result = await requestCompletion({
    url: 'https://api.example.com',
    fetchImpl: async () => { throw new Error('unexpected redirect') }
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /重定向/)

  const wrapped = new TypeError('fetch failed')
  wrapped.cause = new Error('unexpected redirect')
  const fromCause = await requestCompletion({
    url: 'https://api.example.com',
    fetchImpl: async () => { throw wrapped }
  })
  assert.match(fromCause.error, /重定向/, 'undici 把原因放在 cause 里时也应识别')
}

// 7. 外部中止（stopAgent / 关窗）：立即返回"请求已中止"，不等超时
{
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = requestCompletion({
    url: 'https://api.example.com',
    signal: controller.signal,
    fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  })
  setTimeout(() => controller.abort(), 30)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error, '请求已中止')
  assert.ok(Date.now() - startedAt < 1000)
}

// 8. 本次超时：默认 120s 常量存在；显式 timeoutMs 到点产出超时错误
{
  assert.equal(DEFAULT_TIMEOUT_MS, 120000)
  const startedAt = Date.now()
  const result = await requestCompletion({
    url: 'https://api.example.com',
    timeoutMs: 1000,
    fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.ok(Date.now() - startedAt >= 900)
}

console.log('✅ tests/main-llm-proxy.mjs 全部通过')
