/**
 * JustFloat 切帧器单测（BE-18 回归）。
 *
 * 重点覆盖三条历史缺陷：
 *   1. 单个 chunk 超过缓冲上限时把整块合法数据一起丢掉；
 *   2. 非 4 字节对齐帧静默丢弃、无计数；
 *   3. 溢出后只剩"丢弃"没有任何可观测信号。
 */
import assert from 'node:assert/strict'
import { createJustFloatFramer, DEFAULT_MAX_BUFFER, JUSTFLOAT_TAIL } from '../src/main/justfloat.js'

/** 组一帧：[float32...] + 帧尾 */
const frameOf = (...values) => {
  const body = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => body.writeFloatLE(value, index * 4))
  return Buffer.concat([body, JUSTFLOAT_TAIL])
}

const closeTo = (actual, expected, epsilon = 1e-5) => Math.abs(actual - expected) <= epsilon

// 1. 同一 chunk 内多帧：逐帧回调，浮点值与字节数正确
{
  const frames = []
  const framer = createJustFloatFramer({ onFrame: (frame) => frames.push(frame) })
  framer.push(Buffer.concat([frameOf(1, 2, 3), frameOf(4, 5, 6)]))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0].floats.map((value) => Math.round(value)), [1, 2, 3])
  assert.deepEqual(frames[1].floats.map((value) => Math.round(value)), [4, 5, 6])
  assert.equal(frames[0].byteLength, 3 * 4 + JUSTFLOAT_TAIL.length)
  assert.equal(framer.stats().bufferedBytes, 0)
}

// 2. 跨 chunk 拆帧：半帧先缓存，下一块补齐后只回调一次
{
  const frames = []
  const framer = createJustFloatFramer({ onFrame: (frame) => frames.push(frame) })
  const frame = frameOf(1.5, -2.25)
  framer.push(frame.subarray(0, 5))
  assert.equal(frames.length, 0, '半帧不应回调')
  assert.equal(framer.stats().bufferedBytes, 5)
  framer.push(frame.subarray(5))
  assert.equal(frames.length, 1)
  assert.ok(closeTo(frames[0].floats[0], 1.5))
  assert.ok(closeTo(frames[0].floats[1], -2.25))
  assert.equal(framer.stats().bufferedBytes, 0)
}

// 3. 单个 chunk 超过上限但内含完整帧：必须先切帧，不能整块丢弃（历史缺陷）
{
  const frames = []
  const overflows = []
  const framer = createJustFloatFramer({
    maxBuffer: 64,
    onFrame: (frame) => frames.push(frame),
    onOverflow: (info) => overflows.push(info)
  })
  const payload = Buffer.concat(Array.from({ length: 50 }, (_, i) => frameOf(i)))
  assert.ok(payload.length > 64, '该 chunk 必须超过上限')
  framer.push(payload)
  assert.equal(frames.length, 50, '超过上限的 chunk 中的完整帧必须全部切出')
  assert.equal(overflows.length, 0, '全部切完后没有剩余半帧，不应报溢出')
}

// 4. 非 4 字节对齐帧：跳过 + 计数 + 回调；后面的合法帧仍能解析
{
  const frames = []
  const misaligned = []
  const framer = createJustFloatFramer({
    onFrame: (frame) => frames.push(frame),
    onMisaligned: (info) => misaligned.push(info)
  })
  // 3 字节的"帧"（不是 float32 的整数倍）+ 帧尾
  const bad = Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), JUSTFLOAT_TAIL])
  framer.push(Buffer.concat([bad, frameOf(7)]))
  assert.equal(frames.length, 1, '对齐的合法帧仍应解析')
  assert.ok(closeTo(frames[0].floats[0], 7))
  assert.equal(misaligned.length, 1)
  assert.equal(misaligned[0].misalignedFrames, 1)
  assert.equal(framer.stats().misalignedFrames, 1)
}

// 5. 长期无帧尾：剩余半帧超限时丢弃并上报，缓冲清空后可继续工作
{
  const frames = []
  const overflows = []
  const framer = createJustFloatFramer({
    maxBuffer: 64,
    onFrame: (frame) => frames.push(frame),
    onOverflow: (info) => overflows.push(info)
  })
  const noise = Buffer.alloc(200, 0x5a)
  framer.push(noise)
  assert.equal(overflows.length, 1)
  assert.equal(overflows[0].droppedBytes, 200)
  assert.equal(framer.stats().bufferedBytes, 0, '溢出后缓冲必须清空，不能只增不减')

  framer.push(frameOf(9))
  assert.equal(frames.length, 1, '溢出后应能恢复解析')
}

// 6. reset()：清空缓冲与异常计数（关闭串口 / 切换协议时调用）
{
  const framer = createJustFloatFramer({ maxBuffer: DEFAULT_MAX_BUFFER })
  framer.push(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]))
  assert.equal(framer.stats().bufferedBytes, 5)
  framer.reset()
  assert.deepEqual(framer.stats(), { bufferedBytes: 0, misalignedFrames: 0 })
}

console.log('✅ tests/main-justfloat.mjs 全部通过')
