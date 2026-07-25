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
