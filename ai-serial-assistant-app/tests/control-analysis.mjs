import assert from 'node:assert/strict'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  createSamplesFromChannels
} from '../src/renderer/src/services/controlAnalysis.mjs'

function createResponse({ damping = 0.45, count = 200 } = {}) {
  const dt = 0.05
  let feedback = 0
  let velocity = 0
  return Array.from({ length: count }, (_, index) => {
    const target = index < 20 ? 0 : 100
    const acceleration = 3.2 ** 2 * (target - feedback) - 2 * damping * 3.2 * velocity
    velocity += acceleration * dt
    feedback += velocity * dt
    return { t: index * dt, target, feedback, output: target - feedback }
  })
}

const metrics = analyzeControlSamples(createResponse())
assert.equal(metrics.valid, true)
assert.equal(metrics.sampleCount, 200)
assert.ok(metrics.riseTime > 0)
assert.ok(metrics.overshoot > 0)
assert.ok(metrics.rmse > 0)

const suggestion = buildPidSuggestion(metrics, { kp: 1.8, ki: 0.22, kd: 0.12 })
assert.ok(suggestion.kp >= 0 && suggestion.kp <= 20)
assert.ok(suggestion.ki >= 0 && suggestion.ki <= 10)
assert.ok(suggestion.kd >= 0 && suggestion.kd <= 10)

const channels = createSamplesFromChannels([[0, 1, 2], [3, 4, 5], [6, 7, 8]], { target: 0, feedback: 1, output: 2 }, 50)
assert.deepEqual(channels[2], { t: 0.1, target: 2, feedback: 5, output: 8 })

const invalid = analyzeControlSamples([{ t: 0, target: 0, feedback: 0 }])
assert.equal(invalid.valid, false)

console.log('control-analysis: all assertions passed')
