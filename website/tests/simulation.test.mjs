import assert from 'node:assert/strict'
import { PRESETS, runSimulation, toCsv } from '../simulation.mjs'

const results = Object.fromEntries(Object.entries(PRESETS).map(([id, config]) => {
  const result = runSimulation({ ...config, target: 10, noise: false })
  assert.equal(result.truncated, false, `${id}: must run to completion`)
  assert.ok(result.samples.length >= 2000)
  assert.ok(result.samples.every(s => [s.t, s.target, s.feedback, s.output].every(Number.isFinite)))
  assert.ok(Number.isFinite(result.metrics.rmse))
  return [id, result]
}))
assert.ok(results.pure.metrics.steadyError > 1, 'pure P retains steady-state error')
assert.equal(results.pure.metrics.settlingTime, null)
assert.ok(results.overshoot.metrics.overshoot > 30, 'overshoot preset exposes overshoot')
assert.ok(results.balanced.metrics.overshoot < 10)
assert.ok(Math.abs(results.balanced.metrics.steadyError) < .01)
assert.ok(results.balanced.metrics.settlingTime < .3)
assert.ok(results.slow.metrics.rmse > results.balanced.metrics.rmse)

const config = { ...PRESETS.balanced, target: 10, noise: true }
const noisy = runSimulation(config)
assert.deepEqual(noisy, runSimulation(config), 'fixed seed makes comparison repeatable')
assert.notDeepEqual(noisy.samples, results.balanced.samples)
for (const target of [1, 30]) {
  for (const gain of [{kp:0,ki:0,kd:0}, {kp:8,ki:20,kd:.02}]) {
    const result = runSimulation({...gain,target,noise:true})
    assert.ok(result.samples.every(s => Number.isFinite(s.feedback)))
  }
}
for (const invalid of [{kp:-1},{ki:21},{kd:Infinity},{target:0},{target:31},{kp:NaN}]) {
  assert.throws(() => runSimulation({...config,...invalid}))
}
const csv = toCsv(results.balanced.samples)
assert.ok(csv.startsWith('\uFEFF时间_s,'))
assert.equal(csv.split('\r\n').length, results.balanced.samples.length + 1)
assert.equal(csv.split('\r\n')[1].split(',').length, 4)
console.log('Website simulation: presets, finite samples, repeatability, bounds and CSV passed.')
