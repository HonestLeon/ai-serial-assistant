import {
  isMetricsAcceptable,
  maybeUpdateBestResult,
  scoreMetrics,
  shouldRollbackToBest
} from './pidSafety.mjs'

export function readCanonicalPid(params, cascade = false) {
  if (cascade) {
    return {
      speedKp: Number(params.speedKp),
      speedKi: Number(params.speedKi),
      speedKd: Number(params.speedKd),
      positionKp: Number(params.kp),
      positionKi: Number(params.ki),
      positionKd: Number(params.kd)
    }
  }
  return {
    kp: Number(params.kp),
    ki: Number(params.ki),
    kd: Number(params.kd)
  }
}

export function applyCanonicalPid(target, pid, cascade = false) {
  if (!pid) return target
  if (cascade) {
    const mapping = {
      speedKp: 'speedKp',
      speedKi: 'speedKi',
      speedKd: 'speedKd',
      positionKp: 'kp',
      positionKi: 'ki',
      positionKd: 'kd'
    }
    Object.entries(mapping).forEach(([source, destination]) => {
      if (Number.isFinite(Number(pid[source]))) target[destination] = String(pid[source])
    })
    return target
  }
  ;['kp', 'ki', 'kd'].forEach((key) => {
    if (Number.isFinite(Number(pid[key]))) target[key] = String(pid[key])
  })
  return target
}

export function createTuningSession(options = {}) {
  return {
    maxRounds: Math.max(1, Number(options.maxRounds) || 12),
    requiredStable: Math.max(1, Number(options.requiredStable) || 2),
    patience: Math.max(1, Number(options.patience) || 4),
    stableStreak: 0,
    noImprovement: 0,
    bestStable: null,
    bestObserved: null,
    rounds: []
  }
}

export function registerTuningRound(session, current, acceptance = {}) {
  const score = scoreMetrics(current.metrics)
  const previousBestStable = session.bestStable
  const rollback = shouldRollbackToBest(previousBestStable, current.metrics)

  let bestObserved = session.bestObserved
  const improved = Number.isFinite(score) && (!bestObserved || score < bestObserved.score - 1e-9)
  if (improved) {
    bestObserved = {
      pid: { ...current.pid },
      metrics: { ...current.metrics },
      score,
      round: current.round
    }
  }

  const bestStable = rollback.shouldRollback
    ? previousBestStable
    : maybeUpdateBestResult(previousBestStable, current)
  const acceptable = isMetricsAcceptable(current.metrics, acceptance)
  const stableStreak = rollback.shouldRollback
    ? 0
    : (acceptable.done ? session.stableStreak + 1 : 0)
  const noImprovement = improved ? 0 : session.noImprovement + 1

  let decision = 'continue'
  let reason = acceptable.reason || ''
  let applyPid = null
  if (rollback.shouldRollback && previousBestStable) {
    decision = 'rollback'
    reason = rollback.reason
    applyPid = previousBestStable.pid
  } else if (stableStreak >= session.requiredStable) {
    decision = 'complete'
    reason = `连续 ${stableStreak} 轮达到验收阈值`
    applyPid = (bestStable || bestObserved)?.pid || current.pid
  } else if (noImprovement >= session.patience && bestObserved) {
    decision = 'stagnated'
    reason = `连续 ${noImprovement} 轮未改善，停止搜索并恢复当前最佳参数`
    applyPid = (bestStable || bestObserved).pid
  } else if (current.round >= session.maxRounds) {
    decision = 'max-rounds'
    reason = `达到 ${session.maxRounds} 轮上限，恢复已验证的最佳参数`
    applyPid = (bestStable || bestObserved)?.pid || current.pid
  }

  const roundRecord = {
    round: current.round,
    testedPid: { ...current.pid },
    pid: { ...current.pid },
    metrics: { ...current.metrics },
    score,
    decision,
    reason,
    isBest: Boolean(improved)
  }

  return {
    session: {
      ...session,
      stableStreak,
      noImprovement,
      bestStable,
      bestObserved,
      rounds: [...session.rounds, roundRecord]
    },
    outcome: {
      decision,
      reason,
      applyPid,
      score,
      acceptable,
      isTerminal: ['complete', 'stagnated', 'max-rounds'].includes(decision)
    },
    roundRecord
  }
}
