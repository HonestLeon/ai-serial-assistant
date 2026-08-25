import assert from 'node:assert/strict'
import { convertToLlm, callLlm } from '../src/renderer/src/services/pidAgent/llm.mjs'
import { buildSystemPrompt } from '../src/renderer/src/services/pidAgent/systemPrompt.mjs'

const originalFetch = globalThis.fetch

// stub Response：只实现 callLlm 用到的 ok/status/text/json 四个成员
const okResponse = (data) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(data),
  json: async () => data
})
const errorResponse = (status, detail = '') => ({
  ok: false,
  status,
  text: async () => detail,
  json: async () => ({})
})

/**
 * 用响应序列 stub 掉 globalThis.fetch，跑完 fn 后恢复原始 fetch。
 * responders 每项：Response 形对象，或抛网络异常的函数；超出序列长度时复用最后一项。
 * 返回 calls 数组记录每次请求的 { url, init, body }（body 已反序列化）。
 */
async function withStubbedFetch(responders, fn) {
  const calls = []
  let index = 0
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') })
    const responder = responders[Math.min(index, responders.length - 1)]
    index += 1
    return typeof responder === 'function' ? responder() : responder
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const AI_CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' }
const NO_WAIT_DELAYS = [0, 0, 0, 0, 0]

// ---------- 1. convertToLlm：user / steer / followUp / safety / assistant(toolCalls) / toolResult ----------
const agentMessages = [
  { role: 'user', content: '帮我把 1 号通道调稳，超调控制在 20% 以内' },
  { role: 'user', kind: 'steer', content: '超调还是偏大，保守一点' },
  { role: 'user', kind: 'followUp', content: '调完后再看一眼稳态误差' },
  { role: 'user', kind: 'safety', content: '检测到持续震荡，已回退 Kp' },
  { role: 'user', kind: 'safety', content: '[安全机制] 已再次回退 Kp' },
  {
    role: 'assistant',
    text: '我先查看通道统计，了解动态特性。',
    meta: {
      toolCalls: [{ id: 'call_1', name: 'get_channel_stats', arguments: { channelId: 1, windowSec: 5 } }]
    }
  },
  { role: 'toolResult', content: '{"status":"STABLE","overshoot":18.2}', meta: { toolCallId: 'call_1' } },
  { role: 'assistant', text: '总结：目标已达成。' },
  { role: 'notification', content: 'UI 通知，不应送给模型' }
]
const llmMessages = convertToLlm(agentMessages)
assert.equal(llmMessages.length, 8) // notification 被跳过
assert.deepEqual(llmMessages[0], { role: 'user', content: '帮我把 1 号通道调稳，超调控制在 20% 以内' })
assert.equal(llmMessages[1].role, 'user')
assert.equal(llmMessages[1].content, '[用户中途插入] 超调还是偏大，保守一点')
assert.equal(llmMessages[2].content, '[用户追加任务] 调完后再看一眼稳态误差')
assert.equal(llmMessages[3].content, '[安全机制] 检测到持续震荡，已回退 Kp')
assert.equal(llmMessages[4].content, '[安全机制] 已再次回退 Kp') // 已含前缀不重复加
assert.equal(llmMessages[5].role, 'assistant')
assert.equal(llmMessages[5].content, '我先查看通道统计，了解动态特性。')
assert.deepEqual(llmMessages[5].tool_calls, [
  {
    id: 'call_1',
    type: 'function',
    function: { name: 'get_channel_stats', arguments: '{"channelId":1,"windowSec":5}' }
  }
])
assert.deepEqual(llmMessages[6], {
  role: 'tool',
  tool_call_id: 'call_1',
  content: '{"status":"STABLE","overshoot":18.2}'
})
assert.equal('tool_calls' in llmMessages[7], false) // 无 toolCalls 的 assistant 不带该字段
assert.deepEqual(convertToLlm([]), [])
assert.deepEqual(convertToLlm(), [])

// ---------- 2. callLlm 无 apiKey → 直接失败且不发起请求 ----------
await withStubbedFetch([() => { throw new Error('不应发起请求') }], async (calls) => {
  const empty = await callLlm({ aiConfig: { ...AI_CONFIG, apiKey: '' }, systemPrompt: 's', messages: [] })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, '未配置 API Key')
  const missing = await callLlm({ aiConfig: { baseUrl: 'x', model: 'y' }, systemPrompt: 's', messages: [] })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, '未配置 API Key')
  assert.equal(calls.length, 0)
})

// ---------- 3. callLlm 成功：tool_calls 响应解析 + 请求体检查 ----------
const toolCallResponse = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: '我先查看通道统计。',
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'set_pid_params', arguments: '{"kp":2.5,"ki":0,"kd":0}' }
          }
        ]
      }
    }
  ],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
}
await withStubbedFetch([okResponse(toolCallResponse)], async (calls) => {
  const result = await callLlm({
    aiConfig: { ...AI_CONFIG, baseUrl: 'https://api.example.com/v1/' }, // 带尾斜杠验证去斜杠
    systemPrompt: '系统提示词',
    messages: [{ role: 'user', content: '开始调参' }],
    tools: [{ name: 'set_pid_params', description: '设置 PID 参数', parameters: { type: 'object' } }],
    retryDelays: NO_WAIT_DELAYS
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, '我先查看通道统计。')
  assert.equal(result.finishReason, 'tool_calls') // finishReason 透传
  assert.deepEqual(result.toolCalls, [
    { id: 'call_9', name: 'set_pid_params', arguments: { kp: 2.5, ki: 0, kd: 0 } } // arguments 解析为对象
  ])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.usage.total_tokens, 150)
  // 请求体检查
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test')
  assert.equal(calls[0].body.model, 'test-model')
  assert.equal(calls[0].body.temperature, 0.2)
  assert.equal(calls[0].body.stream, false)
  assert.equal(calls[0].body.tool_choice, 'auto')
  assert.deepEqual(calls[0].body.tools, [
    {
      type: 'function',
      function: { name: 'set_pid_params', description: '设置 PID 参数', parameters: { type: 'object' } }
    }
  ])
  assert.equal(calls[0].body.messages[0].role, 'system')
  assert.equal(calls[0].body.messages[0].content, '系统提示词')
  assert.equal(calls[0].body.messages[1].role, 'user')
  assert.equal(calls[0].body.messages[1].content, '开始调参')
})

// ---------- 4. arguments 非法 JSON → 解析为 {} 且不抛错（warnings 注明） ----------
const badArgsResponse = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [
          { id: 'call_10', type: 'function', function: { name: 'get_channel_data', arguments: '{kp: 未闭合' } },
          { id: 'call_11', type: 'function', function: { name: 'get_channel_stats' } } // arguments 缺省 → {}
        ]
      }
    }
  ]
}
await withStubbedFetch([okResponse(badArgsResponse)], async () => {
  const result = await callLlm({
    aiConfig: AI_CONFIG,
    systemPrompt: 's',
    messages: [],
    tools: [{ name: 'get_channel_data', description: '获取波形', parameters: { type: 'object' } }],
    retryDelays: NO_WAIT_DELAYS
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.toolCalls[0].arguments, {})
  assert.deepEqual(result.toolCalls[1].arguments, {})
  assert.equal(result.toolCalls[0].name, 'get_channel_data')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /get_channel_data/)
})

// ---------- 5. 重试：前两次 500、第三次成功 → ok 且 fetch 调 3 次 ----------
const plainSuccess = {
  choices: [{ finish_reason: 'stop', message: { content: '调参完成' } }],
  usage: { total_tokens: 42 }
}
await withStubbedFetch(
  [errorResponse(500, 'server error'), errorResponse(502, 'bad gateway'), okResponse(plainSuccess)],
  async (calls) => {
    const result = await callLlm({
      aiConfig: AI_CONFIG,
      systemPrompt: 's',
      messages: [],
      retryDelays: NO_WAIT_DELAYS
    })
    assert.equal(result.ok, true)
    assert.equal(result.content, '调参完成')
    assert.equal(result.finishReason, 'stop')
    assert.deepEqual(result.toolCalls, [])
    assert.equal(result.usage.total_tokens, 42)
    assert.equal(calls.length, 3)
  }
)
// 网络异常同样触发重试：第一次抛异常、第二次成功
await withStubbedFetch([() => { throw new Error('network down') }, okResponse(plainSuccess)], async (calls) => {
  const result = await callLlm({ aiConfig: AI_CONFIG, systemPrompt: 's', messages: [], retryDelays: NO_WAIT_DELAYS })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
})

// ---------- 6. 400 且带 tools → 自动去 tools 重试（第二次 body 不含 tools） ----------
await withStubbedFetch(
  [errorResponse(400, 'tools not supported'), okResponse(plainSuccess)],
  async (calls) => {
    const result = await callLlm({
      aiConfig: AI_CONFIG,
      systemPrompt: 's',
      messages: [],
      tools: [{ name: 'get_channel_stats', description: '获取通道统计', parameters: { type: 'object' } }],
      retryDelays: NO_WAIT_DELAYS
    })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].body.tools) // 第一次带 tools
    assert.equal(calls[0].body.tools[0].function.name, 'get_channel_stats')
    assert.equal('tools' in calls[1].body, false) // 第二次去掉 tools
    assert.equal('tool_choice' in calls[1].body, false) // 无 tools 时一并去掉 tool_choice
  }
)

// ---------- 7. 中止 signal：不发起请求 ----------
const abortedController = new AbortController()
abortedController.abort()
await withStubbedFetch([() => { throw new Error('不应发起请求') }], async (calls) => {
  const result = await callLlm({
    aiConfig: AI_CONFIG,
    systemPrompt: 's',
    messages: [],
    signal: abortedController.signal,
    retryDelays: NO_WAIT_DELAYS
  })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})
assert.equal(globalThis.fetch, originalFetch) // fetch 已恢复

// ---------- 8. buildSystemPrompt：<user_config> / 参数行 / scenePrompt 原文 / 工具名清单 ----------
const userConfig = {
  pidParams: [
    { name: 'Kp', initial: 1, min: 0, max: 20 },
    { name: 'Ki', initial: 0.5, min: 0, max: 10 },
    { name: 'Kd', initial: 0, min: 0, max: 5 }
  ],
  safetyRange: { control: [-100, 100], feedback: [0, 50], target: [0, 50] },
  feedforwardItems: [{ name: '重力补偿', initial: 1, min: 0, max: 5 }],
  scenePrompt: '直流电机速度环，额定负载，目标 300 RPM',
  overshootLimit: 20,
  oscillationLimit: 10
}
const agentTools = [
  { name: 'get_channel_stats', description: '获取通道统计指标', parameters: { type: 'object' } },
  { name: 'get_channel_data', description: '获取通道波形数据', parameters: { type: 'object' } },
  { name: 'set_pid_params', description: '设置 PID 参数', parameters: { type: 'object' } },
  { name: 'set_feedforward_params', description: '设置前馈参数', parameters: { type: 'object' } },
  { name: 'set_target', description: '设置目标值触发阶跃', parameters: { type: 'object' } }
]
const prompt = buildSystemPrompt({ userConfig, tools: agentTools })
assert.ok(prompt.includes('<user_config>'))
assert.ok(prompt.includes('</user_config>'))
assert.ok(prompt.includes('Kp: 初始 1.0，范围 [0, 20]'))
assert.ok(prompt.includes('Ki: 初始 0.5，范围 [0, 10]'))
assert.ok(prompt.includes('Kd: 初始 0.0，范围 [0, 5]'))
assert.ok(prompt.includes('控制值: -100 ~ 100'))
assert.ok(prompt.includes('反馈值: 0 ~ 50'))
assert.ok(prompt.includes('目标值: 0 ~ 50'))
assert.ok(prompt.includes('重力补偿: 初始 1.0，范围 [0, 5]'))
assert.ok(prompt.includes('直流电机速度环，额定负载，目标 300 RPM')) // scenePrompt 原文
assert.ok(prompt.includes('超调率上限: 20'))
assert.ok(prompt.includes('振荡次数上限: 10'))
for (const t of agentTools) {
  assert.ok(prompt.includes(`- ${t.name}: ${t.description}`)) // 工具名清单
}
assert.ok(prompt.includes('PID 调参智能体'))
assert.ok(prompt.includes('[安全机制]'))
assert.ok(prompt.includes('不要虚构数据'))
// 无前馈项时渲染兜底文本；对象映射形式的前馈/参数表同样支持
const noFeedforwardPrompt = buildSystemPrompt({
  userConfig: { ...userConfig, feedforwardItems: [], pidParams: { Kp: { initial: 2, min: 0, max: 20 } } },
  tools: agentTools
})
assert.ok(noFeedforwardPrompt.includes('无前馈项'))
assert.ok(noFeedforwardPrompt.includes('Kp: 初始 2.0，范围 [0, 20]'))

// ---------- 8+. buildSystemPrompt modelSpec：仿真模型特性注入 ----------
const modelSpecPrompt = buildSystemPrompt({
  userConfig,
  tools: agentTools,
  modelSpec: {
    name: '电机速度环（一阶模型）',
    description: 'J·dω/dt + B总·ω = Kt·i',
    outputLimit: 12,
    duration: 4,
    dt: 0.01,
    noise: 0.08,
    tau: 0.25
  }
})
assert.ok(modelSpecPrompt.includes('模型特性（仿真模式'))
assert.ok(modelSpecPrompt.includes('输出限幅: 12'))
assert.ok(modelSpecPrompt.includes('采样: 4s @ 100Hz（噪声 0.08）'))
assert.ok(modelSpecPrompt.includes('时间常数 τ: 0.25s'))
assert.ok(modelSpecPrompt.includes('以 get_channel_stats 返回的 finalFeedback 与目标值对照为准'))

// 串口/缺省 modelSpec：不渲染「模型特性」段
const nullSpecPrompt = buildSystemPrompt({ userConfig, tools: agentTools, modelSpec: null })
assert.ok(!nullSpecPrompt.includes('模型特性'))

// P3a 使用建议：引导先 set_target 采集，再查询（消除空缓冲首查报错）
assert.ok(prompt.includes('先调用 set_target 触发一次阶跃采集'))

console.log('✅ tests/pid-agent-llm.mjs 全部通过')
