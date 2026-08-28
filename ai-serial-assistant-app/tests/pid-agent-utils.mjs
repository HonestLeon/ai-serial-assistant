import assert from 'node:assert/strict'
import {
  readCanonicalPid,
  applyCanonicalPid,
  buildSimOverrides,
  buildPidCommand,
  createSerialStepCollector
} from '../src/renderer/src/services/pidAgent/utils.mjs'

// 0. buildPidCommand：固件 PID 下发指令格式（单环 3 参 / 串级 6 参速度环在前）
{
  assert.equal(buildPidCommand({ kp: 2.5, ki: 0.5, kd: 0 }), 'PID 2.5 0.5 0')
  // 串级：速度环三参在前、位置环三参在后（zhichuan 固件 sscanf 顺序）
  assert.equal(
    buildPidCommand(
      { speedKp: 1, speedKi: 0, speedKd: 0, positionKp: 3, positionKi: 0.5, positionKd: 0 },
      { isCascade: true }
    ),
    'PID 1 0 0 3 0.5 0'
  )
  // 字符串值（applyCanonicalPid 写回形态）与缺省键（回退 0）
  assert.equal(buildPidCommand({ kp: '2', ki: undefined, kd: null }), 'PID 2 0 0')
  assert.equal(buildPidCommand(null), 'PID 0 0 0')
}

// 1. readCanonicalPid 单环：只保留 kp/ki/kd 三键（多余的 speed* 被丢弃）
{
  const pid = readCanonicalPid({ kp: 2, ki: 0.5, kd: 0.25, speedKp: 9 })
  assert.deepEqual(pid, { kp: 2, ki: 0.5, kd: 0.25 })
  assert.equal('speedKp' in pid, false)
}

// 2. readCanonicalPid 单环字符串值转数字（applyCanonicalPid 写回的是字符串）
{
  const pid = readCanonicalPid({ kp: '2.5', ki: '0', kd: '0.1' })
  assert.deepEqual(pid, { kp: 2.5, ki: 0, kd: 0.1 })
}

// 3. readCanonicalPid 串级：kp/ki/kd 映射为 positionKp/Ki/Kd，speed* 保留
{
  const pid = readCanonicalPid(
    { kp: 3, ki: 0.2, kd: 0.1, speedKp: 1.5, speedKi: 0.4, speedKd: 0.05 },
    true
  )
  assert.deepEqual(pid, {
    speedKp: 1.5,
    speedKi: 0.4,
    speedKd: 0.05,
    positionKp: 3,
    positionKi: 0.2,
    positionKd: 0.1
  })
  assert.equal('kp' in pid, false)
}

// 4. applyCanonicalPid 单环写回：有限数字转字符串写入，非有限值跳过
{
  const target = { kp: 1, ki: 0, kd: 0 }
  const returned = applyCanonicalPid(target, { kp: 2.5, ki: 'abc', kd: 4 })
  assert.equal(returned, target) // 原地写回并返回同一对象
  assert.equal(target.kp, '2.5')
  assert.equal(target.ki, 0) // 'abc' 非有限数字，不写入
  assert.equal(target.kd, '4')
}

// 5. applyCanonicalPid 单环：null 入参不改动目标
{
  const target = { kp: 1, ki: 0, kd: 0 }
  applyCanonicalPid(target, null)
  assert.deepEqual(target, { kp: 1, ki: 0, kd: 0 })
}

// 6. applyCanonicalPid 串级写回：positionKp → kp、speed* 原位写入，未提供的键不变
{
  const target = { kp: 1, ki: 0, kd: 0, speedKp: 1, speedKi: 0, speedKd: 0 }
  applyCanonicalPid(target, { positionKp: 5, speedKi: 0.3 }, true)
  assert.equal(target.kp, '5') // positionKp 写到 kp（合并形态的位置环）
  assert.equal(target.ki, 0)
  assert.equal(target.kd, 0)
  assert.equal(target.speedKp, 1) // 未提供的不变
  assert.equal(target.speedKi, '0.3')
  assert.equal(target.speedKd, 0)
}

// 7. applyCanonicalPid ↔ readCanonicalPid 串级往返一致性（合并形态 ⇄ 规范形态）
{
  const merged = { kp: 1, ki: 0, kd: 0, speedKp: 2, speedKi: 0, speedKd: 0 }
  const canonical = readCanonicalPid({ ...merged }, true)
  const restored = applyCanonicalPid({ ...merged }, canonical, true)
  assert.deepEqual(
    { kp: Number(restored.kp), ki: Number(restored.ki), kd: Number(restored.kd) },
    { kp: 1, ki: 0, kd: 0 }
  )
  assert.deepEqual(
    { speedKp: Number(restored.speedKp), speedKi: Number(restored.speedKi), speedKd: Number(restored.speedKd) },
    { speedKp: 2, speedKi: 0, speedKd: 0 }
  )
}

// 8. buildSimOverrides 单环：baseConfig 展开 + target + feedforwardSelection + kp/ki/kd 直接展开
{
  const overrides = buildSimOverrides({
    strategyId: 'motor_speed',
    pid: { kp: 2, ki: 0.5, kd: 0.25 },
    feedforward: { linear: 0.5 },
    target: 8,
    baseConfig: { duration: 4, dt: 0.01 }
  })
  assert.equal(overrides.duration, 4)
  assert.equal(overrides.dt, 0.01)
  assert.equal(overrides.target, 8)
  assert.deepEqual(overrides.feedforwardSelection, { linear: 0.5 })
  assert.equal(overrides.kp, 2)
  assert.equal(overrides.ki, 0.5)
  assert.equal(overrides.kd, 0.25)
}

// 9. buildSimOverrides 单环：非有限 target 不写入（避免 undefined 覆盖策略默认值）
{
  const overrides = buildSimOverrides({
    strategyId: 'motor_speed',
    pid: { kp: 2, ki: 0, kd: 0 },
    feedforward: {},
    target: undefined
  })
  assert.equal('target' in overrides, false)
  assert.deepEqual(overrides.feedforwardSelection, {})
}

// 10. buildSimOverrides cascade_position 键映射：kp/ki/kd → positionKp/Ki/Kd，speed* 保留，单环键不泄漏
{
  const overrides = buildSimOverrides({
    strategyId: 'cascade_position',
    pid: { kp: 3, ki: 0.2, kd: 0.1, speedKp: 1.5, speedKi: 0.4, speedKd: 0.05 },
    feedforward: { gravity: 1 },
    target: 1,
    baseConfig: { duration: 5 }
  })
  assert.equal(overrides.duration, 5)
  assert.equal(overrides.target, 1)
  assert.deepEqual(overrides.feedforwardSelection, { gravity: 1 })
  assert.equal(overrides.positionKp, 3) // pid.kp → positionKp
  assert.equal(overrides.positionKi, 0.2)
  assert.equal(overrides.positionKd, 0.1)
  assert.equal(overrides.speedKp, 1.5) // speed* 原样保留
  assert.equal(overrides.speedKi, 0.4)
  assert.equal(overrides.speedKd, 0.05)
  assert.equal('kp' in overrides, false)
  assert.equal('ki' in overrides, false)
  assert.equal('kd' in overrides, false)
}

// 11. buildSimOverrides cascade_position 兼容规范形态（readCanonicalPid 输出：position* 直接采用）
{
  const pid = readCanonicalPid(
    { kp: 3, ki: 0, kd: 0, speedKp: 1.5, speedKi: 0, speedKd: 0 },
    true
  )
  const overrides = buildSimOverrides({
    strategyId: 'cascade_position',
    pid,
    feedforward: { gravity: 1 },
    target: 0.5
  })
  assert.equal(overrides.positionKp, 3)
  assert.equal(overrides.positionKi, 0)
  assert.equal(overrides.positionKd, 0)
  assert.equal(overrides.speedKp, 1.5)
  assert.equal(overrides.speedKi, 0)
  assert.equal(overrides.speedKd, 0)
  assert.equal(overrides.target, 0.5)
  assert.deepEqual(overrides.feedforwardSelection, { gravity: 1 })
}

// 12. buildSimOverrides 单环不展开 speed* 键（单环策略不使用串级键）
{
  const overrides = buildSimOverrides({
    strategyId: 'motor_speed',
    pid: { kp: 2, ki: 0, kd: 0, speedKp: 9 },
    feedforward: {},
    target: 10
  })
  assert.equal('speedKp' in overrides, false)
}

// ============ createSerialStepCollector：串口阶跃窗口采集 ============

// 13. trigger 后进入 active 状态
{
  const collector = createSerialStepCollector({ windowSec: 1, onWindowComplete: null })
  assert.equal(collector.isActive(), false)
  collector.trigger()
  assert.equal(collector.isActive(), true)
}

// 14. 窗口内收样，攒满 windowSec 自动完成回调（samples 为完整窗口副本）
{
  let completed = null
  const collector = createSerialStepCollector({
    windowSec: 1,
    onWindowComplete: (state) => { completed = state }
  })
  collector.trigger()
  collector.push({ t: 0.0, target: 100, feedback: 0 })
  collector.push({ t: 0.1, target: 100, feedback: 10 })
  collector.push({ t: 0.2, target: 100, feedback: 20 })
  assert.equal(completed, null, '窗口未满不应回调')
  assert.equal(collector.isActive(), true)
  collector.push({ t: 0.9, target: 100, feedback: 80 })
  assert.equal(completed, null, 't=0.9 距窗口起点 0.9s < 1s，仍未完成')
  collector.push({ t: 1.0, target: 100, feedback: 90 })
  assert.ok(completed, 't=1.0 距窗口起点恰好 1.0s（>= windowSec），应完成')
  assert.equal(completed.samples.length, 5)
  assert.equal(completed.t0, 0)
  assert.equal(completed.target, 100)
  assert.equal(collector.isActive(), false, '完成后退出 active')
  // 完成后不再收样
  collector.push({ t: 1.1, target: 100, feedback: 92 })
  assert.equal(completed.samples.length, 5)
}

// 15. 未 trigger 时 push 被忽略
{
  let calls = 0
  const collector = createSerialStepCollector({ windowSec: 1, onWindowComplete: () => { calls += 1 } })
  collector.push({ t: 0.1, target: 1, feedback: 0 })
  collector.push({ t: 1.5, target: 1, feedback: 1 })
  assert.equal(calls, 0)
}

// 16. 窗口未满时再次 trigger 重置旧窗口（新窗口从新首帧重新计时）
{
  let completedWindows = []
  const collector = createSerialStepCollector({
    windowSec: 1,
    onWindowComplete: (state) => { completedWindows.push(state.samples.length) }
  })
  collector.trigger()
  collector.push({ t: 0.0, target: 100, feedback: 0 })
  collector.trigger() // 设备在窗口内又收到一次 SET_POINT：旧窗口丢弃
  collector.push({ t: 2.0, target: 120, feedback: 0 })
  collector.push({ t: 3.01, target: 120, feedback: 110 })
  assert.deepEqual(completedWindows, [2], '只完成新窗口（2 条样本），旧窗口被丢弃')
}

// 17. 时间回退的乱序帧被忽略（首帧后 t 早于窗口起点的样本不入窗）
{
  let completed = null
  const collector = createSerialStepCollector({
    windowSec: 1,
    onWindowComplete: (state) => { completed = state }
  })
  collector.trigger()
  collector.push({ t: 0.5, target: 100, feedback: 0 })
  collector.push({ t: 0.2, target: 100, feedback: 0 }) // 早于首帧，丢弃
  collector.push({ t: 1.51, target: 100, feedback: 90 })
  assert.ok(completed)
  assert.equal(completed.samples.length, 2, '乱序帧 0.2 不入窗')
}

// 18. 非法样本（非有限 t / 空对象）被忽略不触发异常
{
  let calls = 0
  const collector = createSerialStepCollector({ windowSec: 1, onWindowComplete: () => { calls += 1 } })
  collector.trigger()
  collector.push({})
  collector.push({ t: Number.NaN, target: 1, feedback: 0 })
  collector.push({ t: 'x', target: 1, feedback: 0 })
  assert.equal(calls, 0)
  assert.equal(collector.isActive(), true)
}

console.log('pid-agent-utils.mjs 全部测试通过')
