/**
 * 会话隔离与会话停止后的硬件安全（BE-05 / BE-05b / BE-10 回归）。
 *
 * 覆盖三条曾经成立、会直接影响真机的缺陷：
 *   1. 停止会话后，串口阶跃窗口仍在收样 → 安全护栏触发 → 回退参数被重新下发设备；
 *   2. 停止后串口数据仍被解析并写入会话缓冲（空闲开销 + 为 1 提供燃料）；
 *   3. 重启会话后旧会话的收尾逻辑（finally / 事件回调）污染新会话。
 *
 * 纯 Node 运行：不依赖 DOM，LLM 走 globalThis.fetch stub。
 */
import assert from 'node:assert/strict'
import { usePidAgent } from '../src/renderer/src/composables/usePidAgent.mjs'

const AI_CONFIG = { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'test-key' }

/** 构造一个按脚本返回 chat/completions 响应的 stub fetch */
function stubFetch(responder) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, init = {}) => {
    calls += 1
    const payload = await responder(calls, init)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload
    }
  }
  return { restore: () => { globalThis.fetch = original }, calls: () => calls }
}

const textReply = (content) => ({ choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }] })
const toolReply = (name, args, id = 'call-1') => ({
  choices: [{
    message: {
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    },
    finish_reason: 'tool_calls'
  }]
})

/** 构造一帧 FireWater 格式行 */
const frame = (target, feedback, output, time) => ({
  raw: `target,feedback,output: ${target},${feedback},${output}`,
  time,
  bytes: 32
})

/** 串口会话：首轮回调 set_target，第二轮回调 set_target（制造"停止时窗口正开着"），
 *  第三轮/之后延迟返回纯文本（便于在中途 stop） */
async function startSerialSession(sends, { secondReplyDelayMs = 30, thirdReplyDelayMs = 500 } = {}) {
  const stub = stubFetch(async (turn) => {
    if (turn === 1) return toolReply('set_target', { value: 50 }, 'call-1')
    if (turn === 2) {
      await new Promise((resolve) => setTimeout(resolve, secondReplyDelayMs))
      return toolReply('set_target', { value: 60 }, 'call-2')
    }
    await new Promise((resolve) => setTimeout(resolve, thirdReplyDelayMs))
    return textReply('继续观察')
  })
  const agent = usePidAgent({
    getAiConfig: () => AI_CONFIG,
    getConnected: () => true,
    onSimulationData: () => {},
    onSerialSend: async (cmd) => { sends.push(cmd); return true }
  })
  agent.testMode.value = 'serial'
  agent.tuningStrategy.value = '分阶段 P→PI→PID'
  agent.scenePrompt.value = '直流电机转速控制'
  return { agent, stub }
}

// 1. 停止后继续灌数据：不得再次下发任何指令（尤其是护栏回退的 PID 指令）
{
  const sends = []
  const { agent, stub } = await startSerialSession(sends)
  try {
    const pending = agent.startAgent('开始串口调参')
    await new Promise((resolve) => setTimeout(resolve, 20))

    // ① 先让护栏记录一条"已验证的稳定参数"（bestStable）：
    //    只有这样，停止后若窗口仍在收样并触发超调，才会有 rollbackPid 被真正下发到设备。
    const t0 = Date.now()
    for (let i = 0; i < 250; i += 1) {
      const target = i < 4 ? 0 : 50
      agent.pushSerialBatch([frame(target, target, 1, t0 + i * 50)])
    }
    assert.equal(
      agent.messages.value.filter((message) => message.kind === 'safety').length,
      0,
      '正常收敛窗口不应触发安全回退'
    )

    // ② 等第二轮 set_target（新窗口刚打开）后再停止：这才是"停止时窗口正开着"的真实时序
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(sends, ['SET_POINT 50', 'SET_POINT 60'], '第二轮 set_target 应已下发并开启新窗口')

    const sendsBeforeStop = [...sends]
    agent.stopAgent()
    const result = await pending

    assert.equal(result.stopReason, 'aborted', '停止后会话应以 aborted 结束')
    assert.equal(agent.running.value, false)

    // ③ 停止后灌 15s 数据：超调 80%，若窗口仍在收样必然触发护栏回退并下发 PID 指令
    const t1 = Date.now()
    for (let i = 0; i < 300; i += 1) {
      const target = i < 4 ? 0 : 60
      const feedback = target === 0 ? 0 : 110
      agent.pushSerialBatch([frame(target, feedback, 1, t1 + i * 50)])
    }
    assert.deepEqual(sends, sendsBeforeStop, '停止后不得再向设备下发任何指令')
    assert.equal(
      agent.messages.value.filter((message) => message.kind === 'safety').length,
      0,
      '停止后不得再产生 [安全机制] 消息'
    )
  } finally {
    stub.restore()
  }
}

// 2. 停止后重启新会话：旧会话的收尾不得污染新会话（消息流 / running 状态）
{
  const sends = []
  const { agent, stub } = await startSerialSession(sends)
  try {
    const first = agent.startAgent('第一轮调参')
    await new Promise((resolve) => setTimeout(resolve, 20))
    agent.stopAgent()
    await first

    // 第二轮：直接纯文本结束，消息流应只有新会话的 user + assistant
    stub.restore()
    const stub2 = stubFetch(async () => textReply('第二轮完成'))
    try {
      const second = await agent.startAgent('第二轮调参')
      assert.equal(second.stopReason, 'stop')
      assert.equal(agent.running.value, false)
      const kinds = agent.messages.value.map((message) => message.kind)
      assert.deepEqual(kinds, ['user', 'assistant'], `新会话消息流不应混入旧会话产物，实际: ${kinds.join(',')}`)
      assert.equal(agent.turnCount.value, 1)
    } finally {
      stub2.restore()
    }
  } finally {
    stub.restore()
  }
}

// 3. 空闲（未运行）时灌串口数据：不解析、不写缓冲、不抛错
{
  const sends = []
  const { agent, stub } = await startSerialSession(sends)
  try {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i += 1) agent.pushSerialBatch([frame(0, 0, 0, Date.now() + i * 50)])
    })
    assert.deepEqual(sends, [], '空闲时不应有任何下发')
    assert.equal(agent.messages.value.length, 0, '空闲时不应产生消息')
  } finally {
    stub.restore()
  }
}

console.log('✅ tests/pid-agent-session-isolation.mjs 全部通过')
