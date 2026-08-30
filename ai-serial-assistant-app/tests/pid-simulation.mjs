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

// 去限幅冒烟：级联默认参数 + 大目标（同 agent 测试工况 target=50）
// 修复前：速度指令被 speedLimit=8 钳制 → 5s 只到 ~36；输出被 outputLimit=12 钳制
// 修复后：输出幅值由增益决定，5s 内应显著接近/超过目标
{
  const r = simulatePidStrategy('cascade_position', { target: 50 })
  const maxOut = Math.max(...r.samples.map((s) => Math.abs(s.output)))
  assert.ok(maxOut > 12, `去限幅后 output 峰值应超过原 outputLimit=12（实际 ${maxOut.toFixed(1)}）`)
  const t5 = r.samples.filter((s) => s.t <= 5)
  const fbMax5 = Math.max(...t5.map((s) => s.feedback))
  assert.ok(fbMax5 > 45, `无速度指令限幅后 5s 内反馈应 >45（原被卡在 ~36，实际 ${fbMax5.toFixed(1)}）`)
  // 级联默认窗口 15s（>1000 样本），覆盖完整收敛段
  assert.ok(r.samples.length > 1000, `级联默认仿真窗口约 15s（样本 ${r.samples.length}）`)
  assert.ok(r.samples.every((s) => Number.isFinite(s.output)), '无界输出下数值仍须有限')
}

// 发散截断标记：倒立摆大角度阶跃（超出小角度线性区，如 target=50 弧度）→ 仿真提前截断并标记
{
  const r = simulatePidStrategy('inverted_pendulum', { target: 50 })
  assert.equal(r.truncated, true, '倒立摆大角度目标应因发散截断')
  assert.ok(String(r.truncateReason).includes('发散'), '截断原因应说明发散')
  assert.ok(r.samples.length < 500, '发散截断后样本应远少于完整 5s（1001 点）')

  // 小角度目标（平衡点镇定）正常完整仿真
  const ok = simulatePidStrategy('inverted_pendulum', { target: 0 })
  assert.equal(ok.truncated, false)
  assert.ok(ok.samples.length > 900, '小角度镇定应完整仿真')

  // 策略目标物理范围存在且在合理范围
  const tr = PID_STRATEGIES['inverted_pendulum'].targetRange
  assert.ok(Array.isArray(tr) && tr.length === 2, '倒立摆应配置 targetRange')
  assert.ok(tr[0] >= -0.18 && tr[1] <= 0.18, '倒立摆目标范围应在小角度线性区 ±0.18 rad（≈±10°）')
}

// 验证嵌入式通信层生成：.c/.h 只含通信层函数，不含 PID 计算；前馈项以掩码形式写入 .h
const files = generateEmbeddedControllerFiles({
  name: 'motor_controller',
  feedforwardSelection: { linear: 0.2, gravity: 1 }
})
assert.equal(files.header.filename, 'motor_controller.h')
assert.equal(files.source.filename, 'motor_controller.c')
// .h 含函数指针类型与配置结构体
assert.match(files.header.content, /typedef float\s+\(\*ZhichuanReadFeedbackFn\)/)
assert.match(files.header.content, /typedef void\s+\(\*ZhichuanSetParamFn\)/)
assert.match(files.header.content, /ZhichuanTuningConfig/)
// .h 含两个对外函数声明
assert.match(files.header.content, /zhichuan_periodic_send/)
assert.match(files.header.content, /zhichuan_parse_command/)
// 前馈掩码：linear(0x0001) | gravity(0x0040) = 0x0041
assert.match(files.header.content, /#define ZHICHUAN_FF_MASK\s+0x0041u/)
// .c 含两个函数实现，且不含 PID 计算逻辑
assert.match(files.source.content, /void zhichuan_periodic_send/)
assert.match(files.source.content, /uint8_t zhichuan_parse_command/)
assert.match(files.source.content, /#include "motor_controller\.h"/)
// 通信层不应包含 PID 增益初始化（参数由指令下发，不在文件里硬编码）
assert.ok(!/pid->kp =/.test(files.source.content), '通信层不应含 PID 增益赋值')

// 验证无勾选时掩码为 0x0000u
const noFf = generateEmbeddedControllerFiles({ name: 'no_ff' })
assert.match(noFf.header.content, /#define ZHICHUAN_FF_MASK\s+0x0000u/)

// 验证全勾选时掩码为 0x01FFu（9 项全开）
const allFf = generateEmbeddedControllerFiles({
  name: 'all_ff',
  feedforwardSelection: { linear: 1, quadratic: 1, cubic: 1, sin: 1, cos: 1, tan: 1, gravity: 1, bias: 1, sign: 1 }
})
assert.match(allFf.header.content, /#define ZHICHUAN_FF_MASK\s+0x01FFu/)

console.log('pid-simulation: ok')
