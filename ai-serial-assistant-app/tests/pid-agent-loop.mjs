import assert from 'node:assert/strict'
import { createUserMessage } from '../src/renderer/src/services/pidAgent/types.mjs'
import {
  createPendingMessageQueue,
  runAgentLoop
} from '../src/renderer/src/services/pidAgent/agentLoop.mjs'

/** 便捷 stub 工厂：构造无副作用的调参工具 */
const makeTool = (name, impl) => ({
  name,
  description: `测试工具 ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: impl ?? (async () => ({ ok: true }))
})

// 0. createPendingMessageQueue：push 暂存 / drain 取出全部并清空 / size 计数
{
  const queue = createPendingMessageQueue()
  assert.equal(queue.size(), 0)
  assert.deepEqual(queue.drain(), [])
  const a = createUserMessage('先别动 kp', 'steer')
  const b = createUserMessage('超调多少', 'followUp')
  queue.push(a)
  queue.push(b)
  assert.equal(queue.size(), 2)
  const drained = queue.drain()
  assert.equal(drained.length, 2)
  assert.equal(drained[0], a)
  assert.equal(drained[1], b)
  assert.equal(queue.size(), 0)
  assert.deepEqual(queue.drain(), [])
}

// 1. 无工具单轮结束：纯文本回复 → stopReason 'stop'、turnCount 1、1 条 assistant
{
  const initial = [createUserMessage('你好')]
  const result = await runAgentLoop({
    llmFn: async () => ({ ok: true, content: '好的', toolCalls: [], finishReason: 'stop' }),
    systemPrompt: 'sys',
    tools: [],
    initialMessages: initial
  })
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.turnCount, 1)
  const assistants = result.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].content, '好的')
  // initialMessages 拷贝使用：入参不被污染
  assert.equal(initial.length, 1)
  assert.equal(initial[0].content, '你好')
}

// 2. 多工具链：set_pid_params → set_target → 纯文本；turnCount 3、2 条 toolResult、按序执行
{
  const callOrder = []
  const setPidParams = makeTool('set_pid_params', async (args) => {
    callOrder.push('set_pid_params')
    return { ok: true, applied: args }
  })
  const setTarget = makeTool('set_target', async (args) => {
    callOrder.push('set_target')
    return { ok: true, applied: args }
  })
  const responses = [
    { ok: true, content: '先调参数', toolCalls: [{ id: 'c1', name: 'set_pid_params', arguments: { kp: 2 } }], finishReason: 'tool_calls' },
    { ok: true, content: '再设目标', toolCalls: [{ id: 'c2', name: 'set_target', arguments: { target: 80 } }], finishReason: 'tool_calls' },
    { ok: true, content: '调整完成', toolCalls: [], finishReason: 'stop' }
  ]
  let idx = 0
  const result = await runAgentLoop({
    llmFn: async () => responses[idx++],
    systemPrompt: 'sys',
    tools: [setPidParams, setTarget],
    initialMessages: [createUserMessage('帮我调参')]
  })
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.turnCount, 3)
  const toolResults = result.messages.filter((m) => m.role === 'toolResult')
  assert.equal(toolResults.length, 2)
  assert.equal(toolResults[0].meta.toolCallId, 'c1')
  assert.equal(toolResults[1].meta.toolCallId, 'c2')
  // 工具 execute 按 toolCalls 顺序串行调用
  assert.deepEqual(callOrder, ['set_pid_params', 'set_target'])
}

// 3. steer 注入：运行前 steerQueue 已有消息 → 第 1 次 llmFn 收到的消息中即含该 steer（user 角色）
{
  const received = []
  const steerQueue = createPendingMessageQueue()
  steerQueue.push(createUserMessage('先别动 kp', 'steer'))
  await runAgentLoop({
    llmFn: async ({ messages }) => {
      received.push(messages)
      return { ok: true, content: '收到', toolCalls: [], finishReason: 'stop' }
    },
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始调参')],
    steerQueue
  })
  assert.equal(received.length, 1)
  // convertToLlm 后 steer 消息为 user 角色（带来源前缀）
  const userMsgs = received[0].filter((m) => m.role === 'user')
  assert.ok(userMsgs.some((m) => m.content.includes('先别动 kp')))
  // drain 后队列清空
  assert.equal(steerQueue.size(), 0)
}

// 4. followUp 重启外层：内层纯文本结束后 followUpQueue 有消息 → 外层继续第 2 轮
{
  const received = []
  const responses = [
    { ok: true, content: '第一轮完成', toolCalls: [], finishReason: 'stop' },
    { ok: true, content: '第二轮完成', toolCalls: [], finishReason: 'stop' }
  ]
  let idx = 0
  const followUpQueue = createPendingMessageQueue()
  followUpQueue.push(createUserMessage('刚才超调多少？', 'followUp'))
  const result = await runAgentLoop({
    llmFn: async ({ messages }) => {
      received.push(messages)
      return responses[idx++]
    },
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    followUpQueue
  })
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.turnCount, 2)
  assert.equal(received.length, 2)
  // 第 2 次 llmFn 收到的消息中已含 followUp 消息（user 角色）
  assert.ok(
    received[1].some((m) => m.role === 'user' && m.content.includes('刚才超调多少'))
  )
}

// 5. maxTurns 兜底：maxTurns=2 且 llmFn 永远返回 toolCalls → stopReason 'max-turns'
{
  let calls = 0
  const result = await runAgentLoop({
    llmFn: async () => {
      calls += 1
      return {
        ok: true,
        content: '继续',
        toolCalls: [{ id: `c${calls}`, name: 'noop', arguments: {} }],
        finishReason: 'tool_calls'
      }
    },
    systemPrompt: 'sys',
    tools: [makeTool('noop')],
    initialMessages: [createUserMessage('开始')],
    maxTurns: 2
  })
  assert.equal(result.stopReason, 'max-turns')
  assert.equal(result.turnCount, 2)
}

// 6. 工具错误不中断：execute 抛错 → toolResult 标记 isError 且含错误信息，循环继续到 stop
{
  const badTool = makeTool('bad_tool', async () => {
    throw new Error('执行失败')
  })
  const responses = [
    { ok: true, content: '调用工具', toolCalls: [{ id: 'c1', name: 'bad_tool', arguments: {} }], finishReason: 'tool_calls' },
    { ok: true, content: '收尾', toolCalls: [], finishReason: 'stop' }
  ]
  let idx = 0
  const result = await runAgentLoop({
    llmFn: async () => responses[idx++],
    systemPrompt: 'sys',
    tools: [badTool],
    initialMessages: [createUserMessage('开始')]
  })
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.turnCount, 2)
  const toolResult = result.messages.find((m) => m.role === 'toolResult')
  assert.equal(toolResult.meta.isError, true)
  assert.ok(toolResult.content.includes('执行失败'))
}

// 7. llm 失败：ok:false → stopReason 'error'，agent_end 事件携带 error 字段
{
  const events = []
  const result = await runAgentLoop({
    llmFn: async () => ({ ok: false, error: 'x' }),
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    emit: async (event) => events.push(event)
  })
  assert.equal(result.stopReason, 'error')
  const endEvent = events.find((e) => e.type === 'agent_end')
  assert.ok(endEvent)
  assert.ok('error' in endEvent)
  assert.equal(endEvent.error, 'x')
}

// 8. shouldStopAfterTurn：第 1 轮后返回 true → stopReason 'user-stop'
{
  let hookCalls = 0
  const result = await runAgentLoop({
    llmFn: async () => ({ ok: true, content: 'ok', toolCalls: [], finishReason: 'stop' }),
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    shouldStopAfterTurn: async ({ turn, messages }) => {
      hookCalls += 1
      assert.equal(turn, 1)
      assert.ok(Array.isArray(messages))
      return true
    }
  })
  assert.equal(result.stopReason, 'user-stop')
  assert.equal(result.turnCount, 1)
  assert.equal(hookCalls, 1)
}

// 8b. shouldStopAfterTurn 返回 { stop: true, reason: 'stop' } → 以自定义原因 'stop' 结束（达标自动收敛的兜底路径）
{
  const result = await runAgentLoop({
    llmFn: async () => ({ ok: true, content: 'ok', toolCalls: [], finishReason: 'stop' }),
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    shouldStopAfterTurn: async () => ({ stop: true, reason: 'stop' })
  })
  assert.equal(result.stopReason, 'stop', '支持 {stop,reason} 自定义终止原因（正常结束）')
  assert.equal(result.turnCount, 1)
}

// 9. 事件顺序：以 agent_start 开头、agent_end 结尾，每轮 turn_start 在 message_start 之前
{
  const events = []
  const responses = [
    { ok: true, content: '调用工具', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], finishReason: 'tool_calls' },
    { ok: true, content: '完成', toolCalls: [], finishReason: 'stop' }
  ]
  let idx = 0
  await runAgentLoop({
    llmFn: async () => responses[idx++],
    systemPrompt: 'sys',
    tools: [makeTool('noop')],
    initialMessages: [createUserMessage('开始')],
    emit: async (event) => events.push(event)
  })
  const types = events.map((e) => e.type)
  assert.equal(types[0], 'agent_start')
  assert.equal(types[types.length - 1], 'agent_end')
  // 2 轮：每轮 turn_start 均先于 message_start
  const turnStartIdxs = types.flatMap((t, i) => (t === 'turn_start' ? [i] : []))
  const messageStartIdxs = types.flatMap((t, i) => (t === 'message_start' ? [i] : []))
  assert.equal(turnStartIdxs.length, 2)
  assert.equal(messageStartIdxs.length, 2)
  for (let i = 0; i < turnStartIdxs.length; i += 1) {
    assert.ok(turnStartIdxs[i] < messageStartIdxs[i])
  }
  // 第 1 轮含工具执行事件，且位于 message_end 与 turn_end 之间
  assert.ok(types.includes('tool_execution_start'))
  assert.ok(types.includes('tool_execution_end'))
  assert.ok(types.indexOf('message_end') < types.indexOf('tool_execution_start'))
  assert.ok(types.indexOf('tool_execution_end') < types.indexOf('turn_end'))
}

// 10. onBeforeLlm：钩子把 messages 替换为空数组 → llmFn 收到的即钩子返回值（空数组）
{
  let hookCalled = false
  const received = []
  await runAgentLoop({
    llmFn: async ({ messages }) => {
      received.push(messages)
      return { ok: true, content: 'ok', toolCalls: [], finishReason: 'stop' }
    },
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    onBeforeLlm: async () => {
      hookCalled = true
      return []
    }
  })
  assert.ok(hookCalled)
  assert.deepEqual(received[0], [])
}

// 11. 未知工具 + executeTool 覆盖（契约细节）：
//     未知工具名 → isError 结果且不中断；executeTool 覆盖替代 tool.execute
{
  const responses = [
    { ok: true, content: '调未知工具', toolCalls: [{ id: 'c1', name: 'ghost_tool', arguments: {} }], finishReason: 'tool_calls' },
    { ok: true, content: '结束', toolCalls: [], finishReason: 'stop' }
  ]
  let idx = 0
  const ghostResult = await runAgentLoop({
    llmFn: async () => responses[idx++],
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')]
  })
  assert.equal(ghostResult.stopReason, 'stop')
  const toolResult = ghostResult.messages.find((m) => m.role === 'toolResult')
  assert.equal(toolResult.meta.isError, true)
  assert.ok(toolResult.content.includes('工具 ghost_tool 不存在'))

  const viaOverride = []
  const resp2 = [
    { ok: true, content: '调工具', toolCalls: [{ id: 'c2', name: 'noop', arguments: { x: 1 } }], finishReason: 'tool_calls' },
    { ok: true, content: '结束', toolCalls: [], finishReason: 'stop' }
  ]
  let idx2 = 0
  await runAgentLoop({
    llmFn: async () => resp2[idx2++],
    systemPrompt: 'sys',
    tools: [makeTool('noop', async () => ({ via: 'tool.execute' }))],
    initialMessages: [createUserMessage('开始')],
    executeTool: async (tool, args) => {
      viaOverride.push({ name: tool.name, args })
      return { via: 'override' }
    }
  })
  assert.deepEqual(viaOverride, [{ name: 'noop', args: { x: 1 } }])
}

// 11. P3b 中止优先：LLM 在途请求期间 signal 被中止且其返回失败 → stopReason 应为 'aborted' 而非 'error'
{
  const controller = new AbortController()
  const result = await runAgentLoop({
    llmFn: async () => {
      controller.abort() // 模拟用户停止导致在途请求被取消
      return { ok: false, error: 'request aborted' }
    },
    systemPrompt: 'sys',
    tools: [],
    initialMessages: [createUserMessage('开始')],
    signal: controller.signal
  })
  assert.equal(result.stopReason, 'aborted', '中止期间请求失败不应被当作错误')
}

console.log('✅ tests/pid-agent-loop.mjs 全部通过')
