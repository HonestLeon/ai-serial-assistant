import assert from 'node:assert/strict'
import {
  applyCanonicalPid,
  createTuningSession,
  readCanonicalPid,
  registerTuningRound
} from '../src/renderer/src/services/pidTuningSession.mjs'

const ui = {
  kp: '1',
  ki: '2',
  kd: '3',
  speedKp: '4',
  speedKi: '5',
  speedKd: '6'
}
assert.deepEqual(readCanonicalPid(ui, true), {
  speedKp: 4,
  speedKi: 5,
  speedKd: 6,
  positionKp: 1,
  positionKi: 2,
  positionKd: 3
})
applyCanonicalPid(ui, {
  speedKp: 7,
  speedKi: 8,
  speedKd: 9,
  positionKp: 10,
  positionKi: 1.5,
  positionKd: 0.5
}, true)
assert.equal(ui.kp, '10')
assert.equal(ui.speedKp, '7')

const stable = {
  valid: true,
  status: 'STABLE',
  rmse: 0.2,
  steadyError: 0.1,
  overshoot: 2,
  oscillation: 1
}
const worse = {
  valid: true,
  status: 'OSCILLATING',
  rmse: 4,
  steadyError: 2,
  overshoot: 30,
  oscillation: 20
}
const acceptance = { rmseLimit: 1, steadyErrorLimit: 0.5, overshootLimit: 10 }

let session = createTuningSession({ maxRounds: 8, requiredStable: 2, patience: 3 })
let result = registerTuningRound(session, { round: 1, pid: { kp: 1, ki: 1, kd: 0 }, metrics: stable }, acceptance)
session = result.session
assert.equal(result.outcome.decision, 'continue')
assert.equal(session.bestStable.round, 1)

result = registerTuningRound(session, { round: 2, pid: { kp: 4, ki: 4, kd: 0 }, metrics: worse }, acceptance)
assert.equal(result.outcome.decision, 'rollback')
assert.deepEqual(result.outcome.applyPid, { kp: 1, ki: 1, kd: 0 })

session = createTuningSession({ maxRounds: 8, requiredStable: 2, patience: 3 })
result = registerTuningRound(session, { round: 1, pid: { kp: 1, ki: 1, kd: 0 }, metrics: stable }, acceptance)
result = registerTuningRound(result.session, { round: 2, pid: { kp: 1.1, ki: 1, kd: 0 }, metrics: stable }, acceptance)
assert.equal(result.outcome.decision, 'complete')
assert.equal(result.outcome.isTerminal, true)

session = createTuningSession({ maxRounds: 1, requiredStable: 3, patience: 3 })
result = registerTuningRound(session, { round: 1, pid: { kp: 1, ki: 1, kd: 0 }, metrics: worse }, acceptance)
assert.equal(result.outcome.decision, 'max-rounds')
assert.deepEqual(result.outcome.applyPid, { kp: 1, ki: 1, kd: 0 })

console.log('pid-tuning-session tests passed')
