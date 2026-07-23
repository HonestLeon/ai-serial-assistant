import assert from 'node:assert/strict'
import {
  PID_STRATEGIES,
  generateEmbeddedControllerFiles,
  simulatePidStrategy
} from '../src/renderer/src/services/pidSimulation.mjs'

for (const strategyId of Object.keys(PID_STRATEGIES)) {
  const result = simulatePidStrategy(strategyId)
  assert.ok(result.samples.length > 100, `${strategyId} 应生成足够采样`)
  assert.ok(result.samples.every((sample) =>
    [sample.t, sample.target, sample.feedback, sample.output].every(Number.isFinite)
  ), `${strategyId} 采样必须为有限数`)
  assert.notEqual(result.samples[0].feedback, result.samples[1].feedback, `${strategyId} 应含反馈噪声/动态`)
}

const files = generateEmbeddedControllerFiles({
  name: 'motor_controller',
  outputPreset: 'linear_feedforward',
  kff: 0.2,
  kp: 2,
  ki: 0.5,
  kd: 0.1
})
assert.equal(files.header.filename, 'motor_controller.h')
assert.match(files.header.content, /typedef float \(\*ZhichuanReadFn\)/)
assert.match(files.source.content, /0\.200000f \* target/)
assert.match(files.source.content, /write_output/)

console.log('pid-simulation: ok')
