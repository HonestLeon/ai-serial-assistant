import assert from 'node:assert/strict'
import { createDefaultUserConfig } from '../src/renderer/src/services/pidAgent/types.mjs'
import { createDataBuffer } from '../src/renderer/src/services/pidAgent/dataBuffer.mjs'
import { createPidAgentTools } from '../src/renderer/src/services/pidAgent/tools/index.mjs'

/**
 * 构造 stub controller：内存态 pid/前馈/目标 + 真实 createDataBuffer + 固定 500 点阶跃仿真。
 * 记录 setPid / setFeedforward / setTarget / sendSerialCommand / onSamplesCollected 调用供断言。
 */
const createStubController = ({ userConfig, mode = 'simulation', pid } = {}) => {
  const state = {
    pid: { ...(pid ?? { kp: 1, ki: 0, kd: 0 }) },
    feedforward: {},
    target: 0,
    sessionClock: 0
  }
  const dataBuffer = createDataBuffer()
  const calls = { setPid: [], setFeedforward: [], setTarget: [], sendSerialCommand: [], onSamples: [], onStepTriggered: 0 }
  return {
    calls,
    getMode: () => mode,
    getUserConfig: () => userConfig,
    getDataBuffer: () => dataBuffer,
    getPid: () => ({ ...state.pid }),
    setPid: (newPid, notes) => {
      calls.setPid.push({ newPid: { ...newPid }, notes: [...(notes ?? [])] })
      Object.assign(state.pid, newPid)
    },
    getFeedforward: () => ({ ...state.feedforward }),
    setFeedforward: (newFf) => {
      calls.setFeedforward.push({ ...newFf })
      Object.assign(state.feedforward, newFf)
    },
    getTarget: () => state.target,
    setTarget: (value) => {
      calls.setTarget.push(value)
      state.target = value
    },
    getSessionClock: () => state.sessionClock,
    advanceSessionClock: (seconds) => {
      state.sessionClock += Number(seconds) || 0
    },
    sendSerialCommand: async (cmd) => {
      calls.sendSerialCommand.push(cmd)
    },
    onStepTriggered: () => {
      calls.onStepTriggered += 1
    },
    // 固定 500 点一阶惯性阶跃仿真：t ∈ [0, 9.98]，dt = 0.02s
    runSimulation: async () => {
      const target = state.target
      return Array.from({ length: 500 }, (_, i) => {
        const t = i * 0.02
        const feedback = target * (1 - Math.exp(-t / 1.5))
        return { t, target, feedback, output: feedback }
      })
    },
    onSamplesCollected: null
  }
}

// 按名取工具，缺失时立即失败
const findTool = (tools, name) => {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `工具 ${name} 应存在`)
  return tool
}

// 0. 工具集结构：5 个工具，四要素（name/description/parameters/execute）完整
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  const tools = createPidAgentTools({ controller })
  assert.equal(tools.length, 5)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['get_channel_stats', 'get_channel_data', 'set_pid_params', 'set_feedforward_params', 'set_target']
  )
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  // 缺少 controller 时工厂直接抛错
  assert.throws(() => createPidAgentTools({}), /controller/)
}

// 1. get_channel_stats：手动 push 阶跃样本后查询，含 feedback.mean 与 stepMetrics；非法 timeRange 抛错
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  const tools = createPidAgentTools({ controller })
  const statsTool = findTool(tools, 'get_channel_stats')

  // 构造 ζ=0.3 欠阻尼二阶阶跃（t=1 处目标 0→100），保证 stepMetrics 有效
  const zeta = 0.3
  const omegaN = 5
  const omegaD = omegaN * Math.sqrt(1 - zeta * zeta)
  const samples = []
  for (let i = 0; i <= 250; i += 1) {
    const t = i / 50
    const target = t < 1 ? 0 : 100
    let feedback = 0
    if (t >= 1) {
      const elapsed = t - 1
      const env = Math.exp(-zeta * omegaN * elapsed)
      feedback = 100 * (1 - env * (Math.cos(omegaD * elapsed) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(omegaD * elapsed)))
    }
    samples.push({ t, target, feedback, output: feedback })
  }
  controller.getDataBuffer().push(samples)

  const result = await statsTool.execute({ timeRange: [0, 5] })
  assert.equal(result.sampleCount, 251)
  assert.equal(typeof result.channels.feedback.mean, 'number')
  assert.equal(result.channels.feedback.sampleCount, 251)
  assert.equal(result.stepMetrics.valid, true)
  assert.ok(result.stepMetrics.overshoot > 10)
  assert.equal(typeof result.stepMetrics.status, 'string')

  // 只查 feedback 通道
  const partial = await statsTool.execute({ timeRange: [0, 5], channels: ['feedback'] })
  assert.deepEqual(Object.keys(partial.channels), ['feedback'])

  // 非法 timeRange（start<0）→ 直接 throw（上层转 isError toolResult）
  let thrown = null
  try {
    await statsTool.execute({ timeRange: [-1, 5] })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error)
  assert.ok(thrown.message.includes('时间段'))
}

// 2. get_channel_data：默认 maxPoints=30 均匀下采样；可指定 maxPoints
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  const tools = createPidAgentTools({ controller })
  const dataTool = findTool(tools, 'get_channel_data')
  controller.getDataBuffer().push(
    Array.from({ length: 300 }, (_, i) => ({ t: i / 10, target: 100, feedback: i, output: i * 0.5 }))
  )

  const result = await dataTool.execute({ timeRange: [0, 29.9] })
  assert.equal(result.sampleCount, 300)
  assert.equal(result.downsampled, true)
  assert.equal(result.data.t.length, 30)
  assert.equal(result.data.t[0], 0)
  assert.equal(result.data.t[29], 29.9)
  assert.equal(result.data.feedback.length, 30)

  const wide = await dataTool.execute({ timeRange: [0, 29.9], maxPoints: 100 })
  assert.equal(wide.data.t.length, 100)
}

// 3. set_pid_params 用户配置范围裁剪：kp=50（用户范围 [0,20]）→ 20；正常 kp=2.5 无 note
{
  const controller = createStubController({
    userConfig: createDefaultUserConfig(),
    pid: { kp: 10, ki: 0, kd: 0 }
  })
  const tools = createPidAgentTools({ controller })
  const pidTool = findTool(tools, 'set_pid_params')

  const clipped = await pidTool.execute({ kp: 50 })
  assert.equal(clipped.applied.kp, 20)
  assert.equal(clipped.previous.kp, 10)
  assert.ok(clipped.guardrailNotes.some((note) => note.includes('kp: 50')))
  assert.equal(controller.getPid().kp, 20)

  const normal = await pidTool.execute({ kp: 2.5 })
  assert.equal(normal.applied.kp, 2.5)
  assert.deepEqual(normal.guardrailNotes, [])
  assert.equal(controller.getPid().kp, 2.5)
}

// 4. set_pid_params 单步增幅限制：current kp=1 → 请求 kp=10 → 裁到 3（1×3）
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  const tools = createPidAgentTools({ controller })
  const pidTool = findTool(tools, 'set_pid_params')

  const result = await pidTool.execute({ kp: 10 })
  assert.equal(result.applied.kp, 3)
  assert.ok(result.guardrailNotes.some((note) => note.includes('单步增幅')))
  assert.equal(controller.getPid().kp, 3)
}

// 5. set_pid_params 空对象 throw；未知键被忽略（有效键仍生效）
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  const tools = createPidAgentTools({ controller })
  const pidTool = findTool(tools, 'set_pid_params')

  await assert.rejects(pidTool.execute({}), /未提供任何参数/)
  await assert.rejects(pidTool.execute({ kp2: 99 }), /未提供任何参数/)

  const result = await pidTool.execute({ kp: 2, kp2: 99 })
  assert.deepEqual(result.applied, { kp: 2 })
  assert.deepEqual(result.guardrailNotes, [])
}

// 6. set_feedforward_params：越界裁剪到范围 + 未知 id throw
{
  const userConfig = createDefaultUserConfig()
  userConfig.feedforward = [{ id: 'gravity', label: '重力补偿', init: 1, min: 0, max: 5 }]
  const controller = createStubController({ userConfig })
  const tools = createPidAgentTools({ controller })
  const ffTool = findTool(tools, 'set_feedforward_params')

  const clipped = await ffTool.execute({ gravity: 8 })
  assert.equal(clipped.applied.gravity, 5)
  assert.ok(clipped.guardrailNotes.some((note) => note.includes('gravity: 8')))
  assert.equal(controller.getFeedforward().gravity, 5)

  await assert.rejects(ffTool.execute({ foo: 1 }), /未知前馈项/)
}

// 7. set_target 仿真模式：立即采集 500 点入缓冲、目标更新、会话时钟推进、安全钩子触发
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() })
  controller.onSamplesCollected = async (samples) => {
    controller.calls.onSamples.push(samples.length)
  }
  const tools = createPidAgentTools({ controller })
  const targetTool = findTool(tools, 'set_target')

  const first = await targetTool.execute({ value: 60 })
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'simulation')
  assert.equal(first.target, 60)
  assert.equal(first.samplesCollected, 500)
  assert.ok(Math.abs(first.timeRange[0] - 0) < 1e-9)
  assert.ok(Math.abs(first.timeRange[1] - 9.98) < 1e-9)
  assert.deepEqual(first.guardrailNotes, [])
  assert.equal(controller.getTarget(), 60)
  assert.ok(controller.getDataBuffer().getRange().end > 0)
  assert.equal(controller.getDataBuffer().getRange().count, 500)
  assert.deepEqual(controller.calls.onSamples, [500])

  // 第二次 set_target：会话时钟已推进，新一段数据从正偏移开始
  const second = await targetTool.execute({ value: 80 })
  assert.ok(second.timeRange[0] > 0)
  assert.ok(Math.abs(second.timeRange[0] - (first.timeRange[1] + 0.1)) < 1e-9)
  assert.ok(controller.getSessionClock() > 10)
  assert.equal(controller.getDataBuffer().getRange().count, 1000)
}

// 7b. set_target 目标安全范围：轻微软出裁剪到边界，严重越界直接拒绝
{
  const controller = createStubController({ userConfig: createDefaultUserConfig() }) // target [0, 100]
  const tools = createPidAgentTools({ controller })
  const targetTool = findTool(tools, 'set_target')

  const clipped = await targetTool.execute({ value: 150 })
  assert.equal(clipped.target, 100)
  assert.ok(clipped.guardrailNotes.some((note) => note.includes('150')))
  assert.equal(controller.getTarget(), 100)

  await assert.rejects(targetTool.execute({ value: 300 }), /严重超出/)
}

// 8. set_target 串口模式：下发 SET_POINT 指令，不在本地仿真
{
  const controller = createStubController({ userConfig: createDefaultUserConfig(), mode: 'serial' })
  const tools = createPidAgentTools({ controller })
  const targetTool = findTool(tools, 'set_target')

  const result = await targetTool.execute({ value: 50 })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'serial')
  assert.equal(result.target, 50)
  assert.deepEqual(controller.calls.sendSerialCommand, ['SET_POINT 50'])
  assert.equal(controller.calls.onStepTriggered, 1, '串口模式下应声明已发起阶跃（触发窗口采集）')
  assert.equal(controller.getTarget(), 50)
  assert.equal(controller.getDataBuffer().getRange().count, 0)
  assert.ok(result.message.includes('get_channel_stats'))
}

// 9. P1b 串级键映射：串级配置（position*/speed*）下接受单环键 kp/ki/kd → 映射到位置环
{
  const cascadeConfig = {
    ...createDefaultUserConfig(),
    pid: [
      { key: 'positionKp', label: '位置环Kp', init: 1, min: 0, max: 20 },
      { key: 'positionKi', label: '位置环Ki', init: 0, min: 0, max: 10 },
      { key: 'positionKd', label: '位置环Kd', init: 0, min: 0, max: 10 },
      { key: 'speedKp', label: '速度环Kp', init: 1, min: 0, max: 20 },
      { key: 'speedKi', label: '速度环Ki', init: 0, min: 0, max: 10 },
      { key: 'speedKd', label: '速度环Kd', init: 0, min: 0, max: 10 }
    ]
  }
  const controller = createStubController({
    userConfig: cascadeConfig,
    pid: { speedKp: 1, speedKi: 0, speedKd: 0, positionKp: 1, positionKi: 0, positionKd: 0 }
  })
  const tools = createPidAgentTools({ controller })
  const setPid = findTool(tools, 'set_pid_params')

  // 单环键在串级下应映射到位置环
  const r1 = await setPid.execute({ kp: 3 })
  assert.equal(r1.applied.positionKp, 3, 'kp 应映射为 positionKp')
  assert.equal('kp' in r1.applied, false, '不应残留单环键 kp')
  assert.equal(controller.getPid().positionKp, 3, '控制器参数应更新位置环')
  assert.deepEqual(r1.guardrailNotes, [], '无越界不应有裁剪说明')

  // 多键同时映射
  const r2 = await setPid.execute({ kp: 5, ki: 2 })
  assert.equal(r2.applied.positionKp, 5)
  assert.equal(r2.applied.positionKi, 2)

  // 显式串级键原样生效（语义不受污染；speedKp 受单步增幅限制，当前 1 → 上限 3，取 2 验证镜像）
  const r3 = await setPid.execute({ positionKp: 5, speedKp: 2 })
  assert.equal(r3.applied.positionKp, 5)
  assert.equal(r3.applied.speedKp, 2)
}

console.log('✅ tests/pid-agent-tools.mjs 全部通过')
