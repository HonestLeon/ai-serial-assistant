import assert from 'node:assert/strict'
import {
  createAssistantMessage,
  createDefaultUserConfig,
  createToolResultMessage,
  createUserMessage
} from '../src/renderer/src/services/pidAgent/types.mjs'
import { createSafetyGuard } from '../src/renderer/src/services/pidAgent/safety.mjs'
import { compactIfNeeded, measureDataBytes } from '../src/renderer/src/services/pidAgent/compaction.mjs'

// ---------------------------------------------------------------------------
// 样本构造：t<1 时 target=0，t>=1 时 target=100（阶跃），dt=0.05s
// ---------------------------------------------------------------------------

// 稳定样本：一阶惯性逼近目标，无超调无振荡（status=STABLE）
const makeStableSamples = () => {
  const samples = []
  for (let i = 0; i <= 120; i += 1) {
    const t = i * 0.05
    const target = t < 1 ? 0 : 100
    const feedback = t < 1 ? 0 : 100 * (1 - Math.exp(-3 * (t - 1)))
    samples.push({ t, target, feedback, output: feedback })
  }
  return samples
}

// 超调样本：线性冲到 peak 后指数衰减回目标（overshoot = (peak-100)%，如 125 → 25%）
const makeOvershootSamples = (peak = 125) => {
  const samples = []
  for (let i = 0; i <= 120; i += 1) {
    const t = i * 0.05
    const target = t < 1 ? 0 : 100
    let feedback = 0
    if (t >= 1) {
      const elapsed = t - 1
      feedback = elapsed <= 0.3
        ? (peak / 0.3) * elapsed
        : 100 + (peak - 100) * Math.exp(-3 * (elapsed - 0.3))
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  return samples
}

// 等幅振荡样本：到达目标后叠加 ±15 方波振荡（oscillation=30%，overshoot=15%）
const makeOscillatingSamples = () => {
  const samples = []
  for (let i = 0; i <= 200; i += 1) {
    const t = i * 0.05
    const target = t < 1 ? 0 : 100
    let feedback = 0
    if (t >= 1) {
      const elapsed = t - 1
      if (elapsed <= 0.2) {
        feedback = (100 / 0.2) * elapsed
      } else {
        const phase = Math.floor((elapsed - 0.2) / 0.25) % 2
        feedback = 100 + (phase === 0 ? 15 : -15)
      }
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  return samples
}

// 串级慢收敛样本：5s 窗口内反馈单调爬升、**未到达稳态**（无过零振荡，峰数为 0），
// 尾段仍在爬升 → 包络幅度 / stepSize > 10%（复现实中串级位置环慢收敛导致的「伪振荡」）。
// 构造：t<1s 目标 0→50；1~4.25s 慢爬升至 ~34；4.25~5s 以 ~4.25/0.75 的斜率继续线性爬升到 ~44
const makeSlowConvergeSamples = () => {
  const samples = []
  for (let i = 0; i <= 500; i += 1) {
    const t = i * 0.01
    const target = t < 1 ? 0 : 50
    let feedback = 0
    if (t >= 1) {
      if (t < 4.25) {
        feedback = 33.9 * (1 - Math.exp(-(t - 1) / 1.6))
      } else {
        feedback = 33.9 + ((44 - 33.9) / 0.75) * (t - 4.25)
      }
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  return samples
}

// ---------------------------------------------------------------------------
// Safety：安全兜底护栏
// ---------------------------------------------------------------------------

// 1. 未超限稳定样本：不触发；STABLE 时更新 bestStable
{
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  userConfig.acceptance.oscillationLimit = 10
  let pid = { kp: 1.5, ki: 0.2, kd: 0 }
  const setPidCalls = []
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => pid,
    setPid: (p) => { setPidCalls.push(p); pid = p }
  })

  const result = guard.onSamplesCollected(makeStableSamples())
  assert.equal(result.metrics.valid, true)
  assert.equal(result.metrics.status, 'STABLE')
  assert.equal(result.triggered, false)
  assert.equal(result.bestUpdated, true)
  assert.ok(guard.getBestStable() !== null)
  assert.deepEqual(guard.getBestStable().pid, { kp: 1.5, ki: 0.2, kd: 0 })
  assert.equal(guard.getBestStable().round, 1)
  assert.equal(setPidCalls.length, 0)
}

// 2. 先建立 bestStable，再超调 25%（超过 20% 限制）→ 触发并回退到最佳参数
{
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  const bestPid = { kp: 1.5, ki: 0.2, kd: 0 }
  let pid = { ...bestPid }
  const setPidCalls = []
  const events = []
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => pid,
    setPid: (p) => { setPidCalls.push(p); pid = { ...p } },
    emit: (e) => events.push(e)
  })

  // 第 1 轮：稳定样本建立 bestStable
  guard.onSamplesCollected(makeStableSamples())
  // 第 2 轮：激进的激进参数导致超调 25%
  pid = { kp: 5, ki: 1, kd: 0.5 }
  const result = guard.onSamplesCollected(makeOvershootSamples(125))

  assert.equal(result.metrics.valid, true)
  assert.ok(result.metrics.overshoot > 20)
  assert.equal(result.triggered, true)
  assert.equal(setPidCalls.length, 1)
  assert.deepEqual(setPidCalls[0], bestPid)
  assert.deepEqual(result.rollbackPid, bestPid)
  assert.deepEqual(result.rollbackPid, guard.getBestStable().pid)
  assert.ok(result.message.startsWith('[安全机制]'))
  assert.ok(result.message.includes('超调'))
  assert.ok(result.message.includes('25.0'))
  assert.ok(result.message.includes('回退'))
  assert.ok(result.message.includes(JSON.stringify(bestPid)))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'safety_triggered')
  assert.equal(events[0].message, result.message)
  assert.deepEqual(events[0].rollbackPid, bestPid)
  assert.equal(events[0].metrics, result.metrics)

  // reset：清空最佳记录与轮次计数
  guard.reset()
  assert.equal(guard.getBestStable(), null)
  const afterReset = guard.onSamplesCollected(makeStableSamples())
  assert.equal(afterReset.triggered, false)
  assert.equal(guard.getBestStable().round, 1)
}

// 3. 无 bestStable 时超调 → 触发但 rollbackPid 为 null、不调用 setPid
{
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  let pid = { kp: 5, ki: 1, kd: 0.5 }
  const setPidCalls = []
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => pid,
    setPid: (p) => { setPidCalls.push(p); pid = p }
  })

  const result = guard.onSamplesCollected(makeOvershootSamples(125))
  assert.equal(result.triggered, true)
  assert.equal(result.rollbackPid, null)
  assert.equal(setPidCalls.length, 0)
  assert.equal(guard.getBestStable(), null)
  assert.ok(result.message.includes('超调'))
  assert.ok(result.message.includes('回退'))
  assert.ok(result.message.includes('暂无已验证的稳定参数可回退'))
}

// 4. 等幅振荡超限（oscillation=30% > 10%，overshoot=15% 未超）→ 振荡触发
{
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  userConfig.acceptance.oscillationLimit = 10
  let pid = { kp: 8, ki: 2, kd: 0 }
  const setPidCalls = []
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => pid,
    setPid: (p) => { setPidCalls.push(p); pid = p }
  })

  const result = guard.onSamplesCollected(makeOscillatingSamples())
  assert.equal(result.metrics.valid, true)
  assert.ok(result.metrics.oscillation > 10)
  assert.ok(result.metrics.overshoot <= 20) // 确认不是超调触发的
  assert.equal(result.triggered, true)
  assert.ok(result.message.includes('振荡'))
  assert.ok(result.message.includes(result.metrics.oscillation.toFixed(1)))
}

// 4.5 串级慢收敛（无真实振荡）→ 修复后不应误触发安全回退
//    （oscillation 包络 > 10% 但 oscillationPeakCount = 0、hasSignificantOscillation = false）
{
  const userConfig = createDefaultUserConfig()
  userConfig.acceptance.overshootLimit = 20
  userConfig.acceptance.oscillationLimit = 10
  let pid = { kp: 5, ki: 0, kd: 0 }
  const setPidCalls = []
  const guard = createSafetyGuard({
    userConfig,
    getPid: () => pid,
    setPid: (p) => { setPidCalls.push(p); pid = p }
  })

  const result = guard.onSamplesCollected(makeSlowConvergeSamples())
  assert.equal(result.metrics.valid, true)
  assert.ok(result.metrics.oscillation > 10, '包络振荡幅度应超过 10%（复现伪振荡）')
  assert.equal(result.metrics.oscillationPeakCount, 0, '无过零振荡峰')
  assert.equal(result.metrics.hasSignificantOscillation, false)
  assert.equal(result.triggered, false, '未收敛爬升不应误触发安全回退')
  assert.equal(setPidCalls.length, 0)
}

// ---------------------------------------------------------------------------
// Compaction：数据上下文压缩
// ---------------------------------------------------------------------------

// 构造一个数据查询组：assistant(toolCall) + toolResult（数据查询，约 8KB JSON）
const makeDataGroup = (callId, marker, size = 8 * 1024) => ([
  createAssistantMessage({
    text: `查询 ${marker} 数据`,
    toolCalls: [{ id: callId, name: 'get_channel_stats', arguments: { block: marker } }]
  }),
  createToolResultMessage({
    toolCallId: callId,
    toolName: 'get_channel_stats',
    result: { channel: 'feedback', block: marker, data: 'x'.repeat(size) }
  })
])

// 5 个独立数据块 + 非数据 toolResult + user 文本消息
const buildFiveBlockMessages = () => [
  createUserMessage('任务开始：请把超调压到 10% 以内'),
  ...makeDataGroup('call-1', '块-1'),
  ...makeDataGroup('call-2', '块-2'),
  ...makeDataGroup('call-3', '块-3'),
  ...makeDataGroup('call-4', '块-4'),
  ...makeDataGroup('call-5', '块-5'),
  createUserMessage('下一轮继续调参'),
  createAssistantMessage({
    text: '应用新参数',
    toolCalls: [{ id: 'call-6', name: 'set_pid_params', arguments: { kp: 2 } }]
  }),
  createToolResultMessage({ toolCallId: 'call-6', toolName: 'set_pid_params', result: { ok: true } }),
  createUserMessage('结束')
]

// 5. measureDataBytes：只统计数据查询块（非数据块不计入）
{
  const messages = [
    createUserMessage('开始'),
    createToolResultMessage({ toolCallId: 'c1', toolName: 'get_channel_stats', result: { data: 'y'.repeat(1000) } }),
    createToolResultMessage({
      toolCallId: 'c2',
      toolName: 'set_pid_params',
      result: { ok: true, applied: { kp: 1, ki: 0, kd: 0 } }
    })
  ]
  const dataBytes = new TextEncoder().encode(messages[1].content).length
  assert.ok(dataBytes > 1000)
  // 恰好等于数据块字节 → 非数据块（set_pid_params 结果）完全未计入
  assert.equal(measureDataBytes(messages), dataBytes)
  assert.equal(measureDataBytes([messages[2]]), 0)
  assert.equal(measureDataBytes([]), 0)
  assert.equal(measureDataBytes(null), 0)
}

// 6. 未超阈值：compacted false、messages 引用不变、不调用 summarizeFn
{
  const messages = [
    createUserMessage('你好'),
    ...makeDataGroup('c1', '小块', 100)
  ]
  let summarizeCalls = 0
  const result = await compactIfNeeded({
    messages,
    thresholdBytes: 1024 * 1024,
    summarizeFn: async () => { summarizeCalls += 1; return '不应被调用' }
  })
  assert.equal(result.compacted, false)
  assert.equal(result.messages === messages, true)
  assert.equal(result.beforeBytes, measureDataBytes(messages))
  assert.equal(result.afterBytes, result.beforeBytes)
  assert.equal(summarizeCalls, 0)
}

// 7. 超阈值压缩：5 个数据块各 ~8KB，阈值 10KB，保留尾部 3 条 → 压缩前 2 组
{
  const messages = buildFiveBlockMessages()
  const dumpTexts = []
  const events = []
  const result = await compactIfNeeded({
    messages,
    thresholdBytes: 10 * 1024,
    retainedTail: 3,
    summarizeFn: async (dumpText) => { dumpTexts.push(dumpText); return '参数探索摘要文本' },
    emit: (e) => events.push(e)
  })

  assert.equal(result.compacted, true)
  assert.ok(result.beforeBytes > result.afterBytes)
  assert.equal(result.beforeBytes, measureDataBytes(messages))
  assert.equal(result.afterBytes, measureDataBytes(result.messages))
  assert.equal(result.compactedCount, 2)

  // 插入的 compact 消息：kind='compact'、含 [历史数据摘要] 与摘要文本、meta.compactInfo 正确
  const compactMsgs = result.messages.filter((m) => m.kind === 'compact')
  assert.equal(compactMsgs.length, 2)
  compactMsgs.forEach((m) => {
    assert.equal(m.role, 'user')
    assert.ok(m.content.includes('[历史数据摘要]'))
    assert.ok(m.content.includes('参数探索摘要文本'))
    assert.deepEqual(m.meta.compactInfo, { beforeBytes: result.beforeBytes, afterBytes: result.afterBytes })
  })
  // 摘要消息插在原组起始位置（原 assistant 的位置，紧跟首条 user 消息之后）
  assert.equal(result.messages[0].content, '任务开始：请把超调压到 10% 以内')
  assert.equal(result.messages[1].kind, 'compact')
  assert.equal(result.messages[2].kind, 'compact')

  // 被压缩组的 assistant / toolResult 已移除（call-1、call-2）
  assert.equal(result.messages.filter((m) => m.meta?.toolCallId === 'call-1' || m.meta?.toolCallId === 'call-2').length, 0)
  assert.equal(
    result.messages.filter((m) => m.meta?.toolCalls?.some((c) => c.id === 'call-1' || c.id === 'call-2')).length,
    0
  )

  // 最后 3 个数据块保留
  const dataLeft = result.messages.filter((m) => m.role === 'toolResult' && m.meta.isDataQuery)
  assert.equal(dataLeft.length, 3)
  assert.deepEqual(dataLeft.map((m) => m.meta.toolCallId), ['call-3', 'call-4', 'call-5'])

  // 非数据 toolResult 与 user 文本消息原样保留（对象引用不变）
  const nonData = result.messages.find((m) => m.meta?.toolCallId === 'call-6')
  assert.ok(nonData !== undefined)
  assert.equal(nonData.meta.toolName, 'set_pid_params')
  assert.equal(nonData.meta.isDataQuery, false)
  assert.equal(result.messages.some((m) => m === messages[0]), true)
  assert.equal(result.messages.filter((m) => m.role === 'user' && m.kind === 'normal').length, 3)

  // summarizeFn 收到含工具名/参数/结果 JSON 的 dumpText
  assert.equal(dumpTexts.length, 2)
  assert.ok(dumpTexts[0].includes('get_channel_stats'))
  assert.ok(dumpTexts[0].includes('块-1'))
  assert.ok(dumpTexts[1].includes('块-2'))

  // emit 事件
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'compaction_applied')
  assert.equal(events[0].beforeBytes, result.beforeBytes)
  assert.equal(events[0].afterBytes, result.afterBytes)
  assert.equal(events[0].compactedCount, 2)
}

// 8. summarizeFn 抛错：compacted false、带 error 字段、原数组原样返回
{
  const messages = buildFiveBlockMessages()
  const result = await compactIfNeeded({
    messages,
    thresholdBytes: 10 * 1024,
    retainedTail: 3,
    summarizeFn: async () => { throw new Error('摘要服务不可用') }
  })
  assert.equal(result.compacted, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  assert.ok(result.error.includes('摘要服务不可用'))
  assert.equal(result.messages === messages, true)
  assert.equal(measureDataBytes(result.messages), result.beforeBytes)
}

// 9. retainedTail 保护：同一 assistant 带 5 个 toolCalls（其中 3 个在尾部保留区）
//    → 组内存在非待压缩成员，整组保留不压缩
{
  const assistant = createAssistantMessage({
    text: '一次性查询 5 个数据块',
    toolCalls: [1, 2, 3, 4, 5].map((n) => ({
      id: `call-${n}`,
      name: 'get_channel_stats',
      arguments: { block: `块-${n}` }
    }))
  })
  const toolResults = [1, 2, 3, 4, 5].map((n) => createToolResultMessage({
    toolCallId: `call-${n}`,
    toolName: 'get_channel_stats',
    result: { block: `块-${n}`, data: 'x'.repeat(8 * 1024) }
  }))
  const messages = [createUserMessage('任务开始'), assistant, ...toolResults, createUserMessage('结束')]

  let summarizeCalls = 0
  const result = await compactIfNeeded({
    messages,
    thresholdBytes: 10 * 1024,
    retainedTail: 3,
    summarizeFn: async () => { summarizeCalls += 1; return '不应被调用' }
  })

  assert.equal(result.compacted, false)
  assert.equal(summarizeCalls, 0)
  assert.equal(result.messages === messages, true) // 整组未被动
  assert.equal(result.messages.filter((m) => m.role === 'toolResult' && m.meta.isDataQuery).length, 5)
  assert.equal(result.messages.some((m) => m.kind === 'compact'), false)
  assert.equal(result.messages.some((m) => m === assistant), true)
}

console.log('✅ tests/pid-agent-safety-compact.mjs 全部通过')
