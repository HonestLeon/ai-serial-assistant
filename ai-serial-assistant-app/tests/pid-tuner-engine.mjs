/**
 * PID 自动调参引擎回归测试（tests/pid-tuner-engine.mjs）。
 *
 * 验证解耦后的纯 JS 引擎（services/pidTuningEngine.mjs）：
 *   1. 无 Vue 依赖（源码级检查）；
 *   2. 本地规则引擎可在 Node 环境跑完整闭环（轮次 / 终止决策 / 参数合规 / 可复现）；
 *   3. hybrid 引擎 AI 客户端可按需注入 stub（成功 → AI 源；失败 → 回退本地规则）；
 *   4. 取消：onCancel 在首轮生效，立即终止且恢复初始参数。
 *
 * 运行：node tests/pid-tuner-engine.mjs（已挂入 npm run test:analysis）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PID_STRATEGIES } from '../src/renderer/src/services/pidSimulation.mjs'
import { runAutoTuning } from '../src/renderer/src/services/pidTuningEngine.mjs'

// ---------- 1. 无 Vue 依赖 ----------
for (const file of ['pidTuningEngine.mjs', 'pidAiClient.mjs']) {
  const src = readFileSync(new URL(`../src/renderer/src/services/${file}`, import.meta.url), 'utf8')
  assert.ok(!/from\s+['"]vue['"]/.test(src), `${file} 不应引入 vue`)
  assert.ok(!/\bwindow\./.test(src), `${file} 不应引用全局 window`)
  assert.ok(!/\bdocument\./.test(src), `${file} 不应引用全局 document`)
}

// ---------- 用户态参数合规校验（Kp 0~20，Ki/Kd 0~10） ----------
function assertParamsInBounds(pid) {
  for (const [key, value] of Object.entries(pid)) {
    const numeric = Number(value)
    assert.ok(Number.isFinite(numeric), `${key} 应为有限数，实际 ${value}`)
    const max = key.toLowerCase().endsWith('kp') ? 20 : 10
    assert.ok(numeric >= 0 && numeric <= max, `${key}=${value} 超出 0~${max}`)
  }
}

// ---------- 2. local 引擎完整闭环 ----------
{
  const strategy = PID_STRATEGIES.motor_speed
  const result = await runAutoTuning({
    settings: { engine: 'rules', maxRounds: 12, requiredStable: 2, patience: 4 },
    strategy,
    initialParams: { kp: 1, ki: 0, kd: 0 },
    modelConfig: { ...strategy.defaults },
    enableI: true,
    enableD: true
  })

  assert.ok(result.history.length >= 1, `应至少完成 1 轮，实际 ${result.history.length}`)
  assert.ok(result.history.length <= 12, '轮次数不应超过 maxRounds')
  assert.ok(['complete', 'stagnated', 'max-rounds', 'invalid'].includes(result.outcome.decision),
    `终止决策异常：${result.outcome.decision}`)
  // 每轮记录应结构化完整
  for (const record of result.history) {
    assert.ok(record.metrics?.valid, '每轮指标应有效（无效轮已提前终止不入历史）')
    assert.ok(Number.isInteger(record.round), '每轮应有整数 round')
    assert.ok(record.score !== undefined, '每轮应有评分')
  }
  // 终止参数合规
  assertParamsInBounds(result.finalPid)
  // 本地规则引擎结果可复现（固定随机种子）
  const again = await runAutoTuning({
    settings: { engine: 'rules', maxRounds: 12, requiredStable: 2, patience: 4 },
    strategy,
    initialParams: { kp: 1, ki: 0, kd: 0 },
    modelConfig: { ...strategy.defaults },
    enableI: true,
    enableD: true
  })
  assert.deepEqual(again.finalPid, result.finalPid, '固定种子下本地规则引擎应可复现')
  assert.equal(again.history.length, result.history.length, '可复现轮数应一致')
  console.log(`[pid-tuner-engine] local 闭环通过：${result.history.length} 轮，决策=${result.outcome.decision}`)
}

// ---------- 3. hybrid 引擎 + AI stub ----------
{
  const strategy = PID_STRATEGIES.motor_speed
  let aiCalls = 0
  const stubAi = async () => {
    aiCalls += 1
    if (aiCalls === 1) {
      return { ok: true, params: { kp: 2, ki: 0, kd: 0 }, thought: 'stub 成功', selfCheck: 'ok', guardNotes: [], phase: 'P' }
    }
    return { ok: false, error: 'stub 模拟失败' }
  }
  const result = await runAutoTuning({
    settings: { engine: 'hybrid', maxRounds: 4, requiredStable: 2, patience: 4 },
    strategy,
    initialParams: { kp: 1, ki: 0, kd: 0 },
    modelConfig: { ...strategy.defaults },
    enableI: true,
    enableD: true,
    aiConfig: { baseUrl: 'https://example.invalid', model: 'test', apiKey: 'test-key' },
    aiClient: stubAi
  })
  assert.ok(aiCalls >= 1, 'hybrid 引擎应调用 AI 客户端')
  // 引擎内部自「第 2 轮起」更换 ai 未命中会因 proposeNext 分支继续（用规则兜底）
  assert.ok(result.history.some((r) => r.source === 'AI + 安全护栏'), '成功轮应标记 AI 来源')
  assert.ok(result.history.some((r) => r.source === '本地规则'), 'AI 失败轮应回退本地规则')
  assertParamsInBounds(result.finalPid)
  console.log(`[pid-tuner-engine] hybrid + AI stub 通过：AI 调用 ${aiCalls} 次，轮数 ${result.history.length}`)
}

// ---------- 4. onCancel 首轮生效 ----------
{
  const strategy = PID_STRATEGIES.motor_speed
  let cancelChecks = 0
  const cancelFirst = () => {
    cancelChecks += 1
    return cancelChecks === 1 // 第一轮即取消
  }
  const result = await runAutoTuning({
    settings: { engine: 'rules', maxRounds: 6, requiredStable: 2, patience: 4 },
    strategy,
    initialParams: { kp: 1.0, ki: 0, kd: 0 },
    modelConfig: { ...strategy.defaults },
    enableI: true,
    enableD: true,
    onCancel: cancelFirst
  })
  assert.equal(result.cancelled, true, '应标记为取消')
  assert.equal(result.outcome.decision, 'cancelled', '取消后终止决策应为 cancelled')
  assert.ok(result.history.length === 0, '首轮取消不应产生任何轮次记录')
  assert.equal(result.finalPid.kp, 1.0, '无最佳记录时取消应恢复初始参数')
  console.log(`[pid-tuner-engine] 取消路径通过：首轮取消立即终止`)
}

// ---------- 5. onRound 回调可见完整状态 ----------
{
  const strategy = PID_STRATEGIES.motor_speed
  let roundStates = 0
  let sawSamples = false
  await runAutoTuning({
    settings: { engine: 'rules', maxRounds: 2, requiredStable: 2, patience: 4 },
    strategy,
    initialParams: { kp: 1, ki: 0, kd: 0 },
    modelConfig: { ...strategy.defaults },
    enableI: true,
    enableD: true,
    onRound: async (state) => {
      roundStates += 1
      if (Array.isArray(state.samples) && state.samples.length) sawSamples = true
      assert.ok(Number.isInteger(state.round), 'onRound 应携带轮次号')
      assert.ok(typeof state.statusText === 'string', 'onRound 应携带状态文本')
    }
  })
  assert.ok(roundStates >= 1, 'onRound 应被调用至少一次')
  assert.ok(sawSamples, 'onRound 应携带仿真样本')
  console.log(`[pid-tuner-engine] onRound 回调通过：${roundStates} 次`)
}

console.log('✅ tests/pid-tuner-engine.mjs 全部通过')