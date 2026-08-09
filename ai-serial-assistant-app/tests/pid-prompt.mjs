import assert from 'node:assert/strict'
import {
  buildPidJsonSchema,
  buildPidRepairMessage,
  buildPidSystemPrompt,
  buildStructuredPidHistory,
  buildStructuredResponseFormat,
  downsamplePidWaveform,
  parsePidAiResponse,
  pickSuccessfulPidExamples
} from '../src/renderer/src/services/pidPrompt.mjs'

const singleSchema = buildPidJsonSchema(false)
assert.deepEqual(singleSchema.required.slice(0, 3), ['kp', 'ki', 'kd'])
assert.equal(singleSchema.additionalProperties, false)
assert.equal(buildStructuredResponseFormat(true).json_schema.strict, true)

const parsed = parsePidAiResponse(JSON.stringify({
  kp: 1.2,
  ki: 0.3,
  kd: 0.04,
  analysis_summary: '超调较小，保守增加比例项',
  self_check: '范围和单步变化均符合约束'
}), false)
assert.equal(parsed.ok, true)
assert.equal(parsed.params.kp, 1.2)

const invalid = parsePidAiResponse('{"kp":99,"ki":0,"kd":0,"analysis_summary":"x"}', false)
assert.equal(invalid.ok, false)
assert.match(invalid.error, /超出/)

const samples = Array.from({ length: 101 }, (_, index) => ({
  t: index * 0.01,
  target: 10,
  feedback: index / 10,
  output: index
}))
const waveform = downsamplePidWaveform(samples, 30)
assert.equal(waveform.length, 30)
assert.equal(waveform[0].t, 0)
assert.equal(waveform.at(-1).t, 1)
assert.equal(waveform.at(-1).error, 0)

const history = [
  {
    round: 1,
    pid: { kp: 1, ki: 0, kd: 0 },
    metrics: { status: 'SLOW_RESPONSE', rmse: 5, steadyError: 2, overshoot: 0 },
    proposedPid: { kp: 1.5, ki: 0, kd: 0 },
    thought: '增加 Kp'
  },
  {
    round: 2,
    pid: { kp: 1.5, ki: 0, kd: 0 },
    metrics: { status: 'STABLE', rmse: 1, steadyError: 0.2, overshoot: 2 },
    score: 2
  }
]
assert.equal(pickSuccessfulPidExamples(history, 2).length, 1)
assert.ok(JSON.stringify(buildStructuredPidHistory(history, 800)).length <= 900)

const system = buildPidSystemPrompt({ cascade: true, phase: 'PI', formatSpec: '{}', hasFeedforward: true })
assert.match(system, /速度内环/)
assert.match(system, /前馈/)
assert.match(buildPidRepairMessage('缺少 kd', '{}'), /缺少 kd/)

console.log('pid-prompt tests passed')
