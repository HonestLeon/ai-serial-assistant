/**
 * settlingTime 等价性与性能（BE-23 回归）。
 *
 * 实现从「正向逐个 slice 尾部 + every」改成「反向找最后一个越界点」：
 *   - 前者最坏 O(n²)，振荡未收敛时 30k 点约 1.7s（渲染线程同步执行）；
 *   - 后者 O(n)，语义必须**完全一致**——本文件用朴素参考实现逐例比对，
 *     覆盖"全程在带内 / 末尾仍在带外 / 样本不足 3 点"等边界。
 */
import assert from 'node:assert/strict'
import { analyzeControlSamples, settlingTime } from '../src/renderer/src/services/controlAnalysis.mjs'

/** 参考实现：改之前的朴素写法（只用于对照，不参与生产） */
function referenceSettlingTime(samples, stepIndex, finalTarget, stepSize, bandRatio) {
  const band = Math.max(Math.abs(stepSize) * bandRatio, 1e-6)
  for (let i = stepIndex; i < samples.length; i += 1) {
    const tail = samples.slice(i)
    if (tail.length < 3) continue
    if (tail.every((sample) => Math.abs(sample.feedback - finalTarget) <= band)) {
      return samples[i].t - samples[stepIndex].t
    }
  }
  return null
}

/** 构造样本：feedback / target 由回调决定 */
const build = (n, feedbackAt, dt = 0.01, targetAt = () => 50) => Array.from({ length: n }, (_, i) => ({
  t: Number((i * dt).toFixed(6)),
  target: targetAt(i, n),
  feedback: feedbackAt(i, n),
  output: 0
}))

/** 带阶跃的目标：前 100 个样本为 0，之后为 50（analyzeControlSamples 需要有效阶跃） */
const stepTarget = (i) => (i < 100 ? 0 : 50)

// 1. 等价性：随机波形 + 定向边界用例，逐例比对
{
  const cases = []
  const rand = (seed) => {
    let s = seed >>> 0
    return () => {
      s = (1664525 * s + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  // 随机噪声收敛 / 未收敛 / 振荡
  for (let seed = 1; seed <= 40; seed += 1) {
    const r = rand(seed)
    const n = 5 + Math.floor(r() * 200)
    const stepIndex = Math.floor(r() * Math.max(1, n - 1))
    const mode = seed % 3
    cases.push({
      name: `random-${seed}`,
      samples: build(n, (i) => {
        if (mode === 0) return 50 * (1 - Math.exp(-(i + 1) / 10))
        if (mode === 1) return 40 + (r() - 0.5) * 3
        return 50 + 4 * Math.sin(i / 2)
      }),
      stepIndex,
      finalTarget: 50,
      stepSize: 50,
      bandRatio: 0.05
    })
  }

  // 定向边界
  cases.push({ name: '全程在带内', samples: build(10, () => 50), stepIndex: 2, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })
  cases.push({ name: '全程在带内但样本不足', samples: build(4, () => 50), stepIndex: 2, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })
  cases.push({ name: '末点在带外', samples: build(10, (i, n) => (i === n - 1 ? 90 : 50)), stepIndex: 2, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })
  cases.push({ name: '倒数第三点在带外', samples: build(10, (i, n) => (i === n - 3 ? 90 : 50)), stepIndex: 2, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })
  cases.push({ name: '阶跃后立即进带', samples: build(10, (i) => (i < 3 ? 0 : 50)), stepIndex: 3, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })
  cases.push({ name: '中间一次越界', samples: build(20, (i) => (i === 10 ? 70 : 50)), stepIndex: 3, finalTarget: 50, stepSize: 50, bandRatio: 0.05 })

  for (const item of cases) {
    const actual = settlingTime(item.samples, item.stepIndex, item.finalTarget, item.stepSize, item.bandRatio)
    const expected = referenceSettlingTime(item.samples, item.stepIndex, item.finalTarget, item.stepSize, item.bandRatio)
    assert.deepEqual(actual, expected, `settlingTime 与参考实现不一致：${item.name}（actual=${actual}, expected=${expected}）`)
  }
}

// 2. 性能：振荡未收敛（调参失败最常见形态），30k 点必须在几十毫秒内完成
{
  const samples = build(30000, (i) => (i < 100 ? 0 : 50 + 3 * Math.sin(i * 0.009)), 0.001, stepTarget)
  analyzeControlSamples(samples) // 预热（JIT），避免把首次编译时间算进指标
  const startedAt = performance.now()
  const metrics = analyzeControlSamples(samples)
  const elapsed = performance.now() - startedAt
  assert.equal(metrics.valid, true, `30k 振荡样本应产出有效指标：${metrics.reason ?? ''}`)
  assert.ok(elapsed < 50, `30k 点分析应 < 50ms，实际 ${elapsed.toFixed(1)}ms`)
}

// 3. 大样本不再依赖 Math.max(...arr)，6 万点（缓冲上限）不抛 RangeError
{
  const samples = build(60000, (i) => (i < 100 ? 0 : 50 + (i % 7) * 0.1), 0.001, stepTarget)
  assert.doesNotThrow(() => analyzeControlSamples(samples))
}

console.log('✅ tests/control-analysis-settling.mjs 全部通过')
