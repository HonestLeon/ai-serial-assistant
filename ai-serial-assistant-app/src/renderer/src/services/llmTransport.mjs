/**
 * 渲染进程 fetch 适配层：优先走主进程代理（ipcMain 'llm:request'）。
 *
 * 为什么需要：
 * - 渲染进程直连第三方 API 会受 CORS 约束，且 API Key 暴露在页面网络栈；
 * - 主进程已经统一做了超时与中止（llm:abort），渲染层只需保持 fetch 语义。
 *
 * 返回值刻意做成 fetch Response 的最小子集（ok/status/text/json），
 * 因为 callLlm 只依赖这四个成员，tests/ 里也是按这个契约 stub 的。
 */
export function createRendererFetch() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.llm?.request) return null

  return async function ipcFetch(url, init = {}) {
    const requestId = `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const signal = init.signal
    const onAbort = () => api.llm.abort?.(requestId)
    signal?.addEventListener?.('abort', onAbort)
    try {
      const result = await api.llm.request({
        requestId,
        url,
        method: init.method || 'POST',
        headers: init.headers || {},
        body: init.body || '',
        // 透传单次请求超时（浏览器 fetch 会忽略该扩展字段；主进程代理据此设置定时器）
        timeoutMs: init.timeoutMs
      })
      const payload = result || {}
      return {
        ok: !!payload.ok,
        status: Number(payload.status) || 0,
        // 失败时把主进程的 error 文本带上，callLlm 会拼进 "HTTP xxx：detail" 里
        text: async () => String(payload.text || payload.error || ''),
        json: async () => JSON.parse(payload.text || '{}')
      }
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
}
