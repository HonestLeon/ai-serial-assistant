import assert from 'node:assert/strict'
import { createPidAgentTools } from '../src/renderer/src/services/pidAgent/tools/index.mjs'
import { createDefaultUserConfig } from '../src/renderer/src/services/pidAgent/types.mjs'
import { runAgentLoop } from '../src/renderer/src/services/pidAgent/agentLoop.mjs'
import { createDataBuffer } from '../src/renderer/src/services/pidAgent/dataBuffer.mjs'
import { simulatePidStrategy } from '../src/renderer/src/services/pidSimulation.mjs'
import { createSafetyGuard } from '../src/renderer/src/services/pidAgent/safety.mjs'

function fixture(mode = 'simulation') {
  const config = createDefaultUserConfig()
  let pid = { kp: 1, ki: 0, kd: 0 }, target = 0, clock = 0, range = { start: null, end: null }
  const state = { writes: 0, commands: [], stopped: false, truncated: false, safety: null,
    metric: { valid: true, status: 'SLOW_RESPONSE', rmse: 2, steadyError: 2, overshoot: 0, oscillation: 0, stepSize: 10 } }
  const controller = {
    getUserConfig: () => config, getPid: () => ({ ...pid }), getMode: () => mode,
    setPid: value => { Object.assign(pid, value); state.writes++ },
    getFeedforward: () => ({}), getTarget: () => target, setTarget: value => { target = value },
    getSessionClock: () => clock, advanceSessionClock: value => { clock += value },
    isStopped: () => state.stopped, getTurnCount: () => 0,
    sendSerialCommand: async command => state.commands.push(command),
    runSimulation: async () => Object.assign([{ t: 0, target, feedback: 0 }, { t: 1, target, feedback: target }], { truncated: state.truncated }),
    onSamplesCollected: () => { if (state.safety?.rollbackPid) pid = { ...state.safety.rollbackPid }; return state.safety },
    getDataBuffer: () => ({ getRange: () => range, push: samples => { range = { start: 0, end: samples.at(-1).t } }, stats: () => ({ stepMetrics: { ...state.metric } }) })
  }
  const tools = createPidAgentTools({ controller })
  const call = (name, args) => tools.find(tool => tool.name === name).execute(args)
  return { controller, state, config, tools, call }
}

const a = fixture()
assert.equal((await a.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'needs_data')
await assert.rejects(a.call('run_pid_strategy', { strategy: 'unknown' }))
await a.call('set_target', { value: 10 })
let result = await a.call('run_pid_strategy', { strategy: 'staged_pid' })
assert.equal(result.status, 'evaluated')
assert.equal(result.applied.applied.kp, 1.25)
assert.equal(result.adjustments, 1)
assert.equal(a.state.writes, 1)
const b = fixture()
await b.call('set_target', { value: 10 })
assert.deepEqual(await b.call('run_pid_strategy', { strategy: 'staged_pid' }), result)

await a.call('set_pid_params', { kp: 2 })
assert.equal((await a.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'stale_data')
const c = fixture()
c.config.pid[0].max = 1.1
await c.call('set_target', { value: 10 })
result = await c.call('run_pid_strategy', { strategy: 'staged_pid' })
assert.equal(result.applied.applied.kp, 1.1)
assert.ok(result.applied.guardrailNotes.length)

const d = fixture('serial')
await d.call('set_target', { value: 10 })
assert.equal((await d.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'waiting')
assert.equal(d.state.writes, 0)
assert.deepEqual(d.state.commands, ['SET_POINT 10'])

const e = fixture()
await e.call('set_target', { value: 10 })
e.state.metric.valid = false
assert.equal((await e.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'needs_data')
e.state.stopped = true
assert.equal((await e.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'stopped')
assert.equal(e.state.writes, 0)

const f = fixture()
f.config.pid.push({ key: 'speedKp', init: 1, min: 0, max: 20 })
assert.equal((await f.call('run_pid_strategy', { strategy: 'staged_pid' })).status, 'unsupported')
const g = fixture()
g.state.metric.status = 'OSCILLATING'
await g.call('set_target', { value: 10 })
result = await g.call('run_pid_strategy', { strategy: 'recover_pid' })
assert.equal(result.applied.applied.kp, 0.8)
assert.equal(result.applied.applied.ki, 0)
const h = fixture()
await h.call('set_target', { value: 10 })
h.state.safety = { triggered: true, rollbackPid: { kp: 0.5, ki: 0, kd: 0 } }
result = await h.call('run_pid_strategy', { strategy: 'staged_pid' })
assert.equal(result.status, 'safety_stop')
assert.equal(result.finalPid.kp, 0.5)

// 真实 agent loop 工具路由集成：stub LLM，不产生 API 费用。
const integrated = fixture()
let turn = 0
const loop = await runAgentLoop({ tools: integrated.tools, llmFn: async () => ({ ok: true,
  toolCalls: turn++ === 0 ? [{ id: '1', name: 'set_target', arguments: { value: 10 } }]
    : turn === 2 ? [{ id: '2', name: 'run_pid_strategy', arguments: { strategy: 'staged_pid' } }] : [], content: '' }) })
assert.equal(loop.stopReason, 'stop')
assert.equal(integrated.state.writes, 1)
assert.equal(createPidAgentTools({ controller: integrated.controller, enableStrategies: false }).length, 5)
console.log('pid-agent-strategies: all assertions passed')

// 真实电机仿真、真实统计缓冲与统一回退链路的集成冒烟。
const physical = fixture()
const buffer = createDataBuffer()
physical.controller.getDataBuffer = () => buffer
physical.controller.runSimulation = async () => {
  const simulation = simulatePidStrategy('motor_speed', { ...physical.controller.getPid(), target: physical.controller.getTarget() })
  simulation.samples.truncated = simulation.truncated
  return simulation.samples
}
const guard = createSafetyGuard({ userConfig: physical.config, getPid: physical.controller.getPid, setPid: physical.controller.setPid })
physical.controller.onSamplesCollected = guard.onSamplesCollected
await physical.call('set_target', { value: 10 })
const physicalResult = await physical.call('run_pid_strategy', { strategy: 'staged_pid' })
assert.ok(['evaluated', 'safety_stop'].includes(physicalResult.status), JSON.stringify(physicalResult))
assert.equal(physicalResult.before.stepMetrics.valid, true)
assert.equal(physicalResult.after.stepMetrics.valid, true)
assert.ok(Number.isFinite(physicalResult.after.stepMetrics.rmse))
if (physicalResult.status === 'safety_stop') {
  assert.equal(physicalResult.capture.safety.triggered, true)
  assert.deepEqual(physicalResult.finalPid, physicalResult.capture.safety.rollbackPid)
}
console.log('pid-agent-strategies: motor simulation integration passed')
