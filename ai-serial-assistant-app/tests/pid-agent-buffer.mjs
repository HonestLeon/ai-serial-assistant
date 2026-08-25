import assert from 'node:assert/strict'
import {
  AGENT_MESSAGE_KINDS,
  AGENT_MESSAGE_ROLES,
  createAssistantMessage,
  createDefaultUserConfig,
  createToolResultMessage,
  createUserMessage,
  validateUserConfig
} from '../src/renderer/src/services/pidAgent/types.mjs'
import { createDataBuffer } from '../src/renderer/src/services/pidAgent/dataBuffer.mjs'
import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'

// 1. push + getRange：100 条 t∈[0,9.9] 样本，范围正确
{
  const buffer = createDataBuffer()
  const samples = Array.from({ length: 100 }, (_, i) => ({
    t: i / 10,
    target: 100,
    feedback: i,
    output: i * 0.5
  }))
  assert.equal(buffer.push(samples), 100)
  assert.deepEqual(buffer.getRange(), { start: 0, end: 9.9, count: 100 })
  assert.ok(buffer.totalBytes() > 0)
}

// 2. query 下采样：区间 300 点查 maxPoints=30 → 30 点且首尾包含
{
  const buffer = createDataBuffer()
  buffer.push(Array.from({ length: 300 }, (_, i) => ({
    t: i / 10,
    target: 100,
    feedback: i,
    output: i * 0.5
  })))
  const result = buffer.query({ timeRange: [0, 29.9], maxPoints: 30 })
  assert.equal(result.sampleCount, 300)
  assert.equal(result.downsampled, true)
  assert.equal(result.clipped, false)
  assert.equal(result.data.t.length, 30)
  assert.equal(result.data.t[0], 0)
  assert.equal(result.data.t[29], 29.9)
  assert.equal(result.data.target.length, 30)
  assert.equal(result.data.feedback.length, 30)
  assert.equal(result.data.output.length, 30)
}

// 3. query 越界截断：查 [5, 999] → timeRange 被截断且 clipped 为 true
{
  const buffer = createDataBuffer()
  buffer.push(Array.from({ length: 100 }, (_, i) => ({
    t: i / 10,
    target: 100,
    feedback: i,
    output: i
  })))
  const result = buffer.query({ timeRange: [5, 999], maxPoints: 1000 })
  assert.equal(result.clipped, true)
  assert.deepEqual(result.timeRange, [5, 9.9])
  assert.equal(result.sampleCount, 50)
  assert.equal(result.downsampled, false)
}

// 4. query 无数据抛错（区间与缓冲无交集 / 缓冲为空）
{
  const buffer = createDataBuffer()
  buffer.push(Array.from({ length: 10 }, (_, i) => ({ t: i, target: 0, feedback: 0, output: 0 })))
  assert.throws(() => buffer.query({ timeRange: [50, 60] }), /时间段无数据/)
  const empty = createDataBuffer()
  assert.throws(() => empty.query({ timeRange: [0, 1] }), /时间段无数据/)
}

// 5. stats：阶跃样本（ζ=0.3 欠阻尼二阶近似，理论超调 ≈ 37%）
{
  const buffer = createDataBuffer()
  const zeta = 0.3
  const omegaN = 5
  const omegaD = omegaN * Math.sqrt(1 - zeta * zeta)
  const samples = []
  for (let i = 0; i <= 250; i += 1) {
    const t = i / 50 // 0 ~ 5s，dt = 0.02s；t=1 处目标从 0 阶跃到 100
    const target = t < 1 ? 0 : 100
    let feedback = 0
    if (t >= 1) {
      const elapsed = t - 1
      const envelope = Math.exp(-zeta * omegaN * elapsed)
      feedback = 100 * (1 - envelope * (Math.cos(omegaD * elapsed) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(omegaD * elapsed)))
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  buffer.push(samples)
  const result = buffer.stats({ timeRange: [0, 5] })
  assert.equal(result.sampleCount, 251)
  assert.equal(result.channels.feedback.sampleCount, 251)
  assert.equal(result.stepMetrics.valid, true)
  assert.ok(result.stepMetrics.overshoot > 0)
  assert.ok(result.stepMetrics.overshoot > 10)
  assert.equal(typeof result.stepMetrics.status, 'string')
  // 扩展字段（B 改进）：riseTime/limits/stepSize/finalFeedback 应随指标一同返回
  assert.ok(Number.isFinite(result.stepMetrics.riseTime), 'riseTime 应为数字')
  assert.ok(Number.isFinite(result.stepMetrics.stepSize), 'stepSize 应为数字')
  assert.equal(result.stepMetrics.limits.overshoot, 20, 'limits 应含验收线')
  assert.equal(result.stepMetrics.limits.oscillation, 10)
  assert.ok('finalFeedback' in result.stepMetrics, 'finalFeedback 应存在')
  assert.ok('hasSignificantOscillation' in result.stepMetrics, 'hasSignificantOscillation 应存在')
  assert.equal(typeof result.stepMetrics.health, 'string', 'health 应为状态字符串')
  assert.ok(result.channels.feedback.peak > 120)
  assert.ok(result.channels.feedback.max > 120)
  assert.equal(result.channels.target.min, 0)
  assert.equal(result.channels.target.max, 100)
}

// 6. 环形淘汰：capacitySec=5，push 到 t=20 后旧数据被淘汰
{
  const buffer = createDataBuffer({ capacitySec: 5 })
  for (let i = 0; i <= 200; i += 1) {
    buffer.push({ t: i / 10, target: 100, feedback: i, output: i })
  }
  const range = buffer.getRange()
  assert.ok(range.start >= 15)
  assert.equal(range.end, 20)
  assert.equal(range.count, 51)

  // maxSamples 总量淘汰：100 条上限 50 → 只留最新 50 条
  const capped = createDataBuffer({ maxSamples: 50 })
  capped.push(Array.from({ length: 100 }, (_, i) => ({ t: i, target: 0, feedback: i, output: 0 })))
  assert.equal(capped.getRange().count, 50)
  assert.equal(capped.getRange().start, 50)
  capped.clear()
  assert.deepEqual(capped.getRange(), { start: null, end: null, count: 0 })
}

// 7. types.mjs：消息工厂字段完整 + 配置校验
{
  assert.deepEqual(AGENT_MESSAGE_KINDS, ['normal', 'steer', 'followUp', 'safety', 'compact', 'summary'])
  assert.deepEqual(AGENT_MESSAGE_ROLES, ['user', 'assistant', 'toolResult'])

  const user = createUserMessage('把超调压到 10% 以内', 'steer')
  assert.equal(user.role, 'user')
  assert.equal(user.kind, 'steer')
  assert.equal(user.content, '把超调压到 10% 以内')
  assert.equal(typeof user.id, 'string')
  assert.ok(user.id.length > 0)
  assert.equal(typeof user.timestamp, 'number')
  assert.deepEqual(user.meta, {})
  assert.equal(createUserMessage('你好').kind, 'normal')

  const assistant = createAssistantMessage({
    text: '先看最近一段反馈数据',
    toolCalls: [{ id: 'call-1', name: 'get_channel_stats', arguments: { channel: 'feedback' } }]
  })
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.kind, 'normal')
  assert.equal(assistant.content, '先看最近一段反馈数据')
  assert.equal(assistant.meta.streaming, false)
  assert.equal(assistant.meta.toolCalls.length, 1)
  assert.equal(assistant.meta.toolCalls[0].id, 'call-1')
  assert.equal(assistant.meta.toolCalls[0].name, 'get_channel_stats')
  assert.deepEqual(assistant.meta.toolCalls[0].arguments, { channel: 'feedback' })
  const bare = createAssistantMessage()
  assert.equal(bare.content, '')
  assert.deepEqual(bare.meta.toolCalls, [])

  const toolResult = createToolResultMessage({
    toolCallId: 'call-1',
    toolName: 'get_channel_stats',
    result: { mean: 1.5 }
  })
  assert.equal(toolResult.role, 'toolResult')
  assert.equal(toolResult.content, JSON.stringify({ mean: 1.5 }))
  assert.equal(toolResult.meta.toolCallId, 'call-1')
  assert.equal(toolResult.meta.toolName, 'get_channel_stats')
  assert.equal(toolResult.meta.isError, false)
  assert.equal(toolResult.meta.isDataQuery, true)
  const failed = createToolResultMessage({ toolCallId: 'call-2', toolName: 'apply_pid', result: { ok: false }, isError: true })
  assert.equal(failed.meta.isError, true)
  assert.equal(failed.meta.isDataQuery, false)

  assert.notEqual(createUserMessage('a').id, createUserMessage('b').id)

  // 空 scenePrompt → ok:false
  const emptyPrompt = createDefaultUserConfig()
  const emptyResult = validateUserConfig(emptyPrompt)
  assert.equal(emptyResult.ok, false)
  assert.ok(emptyResult.missing.includes('scenePrompt'))

  // 合法配置 → ok:true
  const valid = createDefaultUserConfig()
  valid.scenePrompt = '直流电机速度环，目标 60 RPM，期望快速稳定'
  assert.deepEqual(validateUserConfig(valid), { ok: true })

  // pid init 超范围 → ok:false
  const badPid = createDefaultUserConfig()
  badPid.scenePrompt = '直流电机速度环'
  badPid.pid[0].init = 50
  const badResult = validateUserConfig(badPid)
  assert.equal(badResult.ok, false)
  assert.ok(badResult.missing.includes('pid[0].init'))
}

// 8. P2a 区间起点容差：多段拼接的浮点累计误差（12.2999...）不得剔除段首跳变样本
//    （修复前：查询 [12.3,16.3] 选区 target 恒定 → stepSize=0 → 归一化爆炸成亿级超调）
{
  const buffer = createDataBuffer()
  let clock = 0
  for (const [kp, ki] of [[1, 0], [3, 1], [5, 2], [8, 3]]) {
    const { samples } = simulatePidStrategy('motor_speed', { kp, ki, kd: 0, target: 50 })
    const off = clock
    buffer.push(samples.map((s) => ({ ...s, t: s.t + off })))
    clock += samples[samples.length - 1].t + 0.1
  }
  const q = buffer.query({ timeRange: [12.3, 16.3], maxPoints: 40 })
  assert.ok(Math.abs(q.data.t[0] - 12.3) < 0.02, '选区应包含段首跳变样本（容差命中）')
  const stat = buffer.stats({ timeRange: [12.3, 16.3] })
  assert.equal(stat.stepMetrics.valid, true, '含段首样本后应能识别阶跃')
  assert.ok(Number.isFinite(stat.stepMetrics.overshoot), 'overshoot 应为有限值（无归一化爆炸）')
  assert.ok(stat.stepMetrics.overshoot < 1000, 'overshoot 不应为亿级爆炸值')
}

console.log('✅ tests/pid-agent-buffer.mjs 全部通过')
