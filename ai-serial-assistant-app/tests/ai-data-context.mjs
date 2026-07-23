import assert from 'node:assert/strict'
import {
  computeChannelStatistics,
  parseNumericLine,
  preprocessSerialLines
} from '../src/renderer/src/services/aiDataContext.mjs'

assert.deepEqual(parseNumericLine('speed,error: 12.5,-0.4'), [12.5, -0.4])

const lines = Array.from({ length: 1000 }, (_, index) => ({
  text: `data: ${index < 500 ? 1 : 10},${index / 10}`,
  time: index
}))
const processed = preprocessSerialLines(lines, { targetCount: 120 })
assert.equal(processed.inputCount, 1000)
assert.ok(processed.outputCount < 300)
assert.ok(processed.lines.some((line) => line.index === 500), '应保留突变点')
assert.equal(processed.lines.at(-1).index, 999)

const stats = computeChannelStatistics(lines)
assert.equal(stats.length, 2)
assert.equal(stats[0].n, 1000)
assert.equal(stats[0].min, 1)
assert.equal(stats[0].max, 10)

console.log('ai-data-context: ok')
