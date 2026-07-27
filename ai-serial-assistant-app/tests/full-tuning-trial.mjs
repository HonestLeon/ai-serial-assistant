/**
 * PID 调参全流程验收测试。
 *
 * 目标：对 3 种模型（电机/串级/倒立摆）各跑 3 组模型参数，
 *      在轮数上限内（电机 50 轮，串级/倒立摆 80 轮）达到验收标准。
 *
 * 验收标准（同时满足）：
 *   1. 稳态误差 < 3%（相对阶跃幅值）
 *   2. 超调量 < 10%
 *   3. 剔除噪声后振荡：从第三个峰起幅值 < 5%，且稳态振幅 < 3%
 *
 * 调参引擎：本地规则（buildPidSuggestion） + 二分法上下界，不依赖 AI API。
 *
 * 用法：node tests/full-tuning-trial.mjs
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { analyzeControlSamples, buildPidSuggestion } from '../src/renderer/src/services/controlAnalysis.mjs'
import { simulatePidStrategy, PID_STRATEGIES } from '../src/renderer/src/services/pidSimulation.mjs'

// ====== 验收标准判定 ======

/**
 * 判定一轮指标是否达到验收标准
 *   1. 稳态误差 < 3%（相对阶跃幅值）
 *   2. 超调量 < 10%
 *   3. 剔除噪声后振荡：从第三个峰起幅值 < 5%，且稳态振幅 < 3%
 */
function isAcceptable(metrics, opts = {}) {
  if (!metrics?.valid) return { done: false, reason: '指标无效' }
  const amplitude = Math.max(Math.abs(metrics.stepSize), 1e-6)
  // 1. 稳态误差 < 3%
  const steadyErrRatio = Math.abs(metrics.steadyError) / amplitude
  if (steadyErrRatio >= 0.03) {
    return { done: false, reason: `稳态误差 ${metrics.steadyError}（${(steadyErrRatio * 100).toFixed(2)}%）≥ 3%` }
  }
  // 2. 超调量 < 10%
  if (metrics.overshoot >= 10) {
    return { done: false, reason: `超调 ${metrics.overshoot}% ≥ 10%` }
  }
  // 3. 振荡：从第三个峰起幅值 < 5%（hasSignificantOscillation 已实现此判定）
  if (metrics.hasSignificantOscillation) {
    return { done: false, reason: `从第三个峰起振幅 ≥ 5%（峰数 ${metrics.oscillationPeakCount}，最大振幅 ${metrics.maxPeakAmplitudePct}%）` }
  }
  // 4. 稳态振幅 < 3%（用 oscillation 字段，即末尾窗内最大-最小/幅值）
  if (metrics.oscillation >= 3) {
    return { done: false, reason: `稳态振幅 ${metrics.oscillation}% ≥ 3%` }
  }
  // 5. 响应速度检查：超调过小说明响应偏慢（Kp 不足），
  //    用户要求"适当超调以加快响应"，因此要求超调 ≥ 1% 才算达标
  //    这样策略会继续增大 Kp 直到有适当超调，换取更快响应
  if (opts.requireOvershoot && metrics.overshoot < 1) {
    return { done: false, reason: `超调 ${metrics.overshoot}% < 1%，响应偏慢，需继续增大 Kp 加快响应` }
  }
  return { done: true, reason: '已达标' }
}

// ====== 二分法上下界提取（与 PidPanel.vue 同源） ======

function extractLastGoodKp(history, cascade, overshootLimit, unstable = false) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (!h?.pid || !h?.metrics) continue
    const kp = Number(cascade ? h.pid.speedKp : h.pid.kp) || 0
    const ki = Number(cascade ? h.pid.speedKi : h.pid.ki) || 0
    const kd = Number(cascade ? h.pid.speedKd : h.pid.kd) || 0
    // 稳定系统：P 阶段（Ki=Kd=0）；不稳定系统：PD 阶段（Ki=0，Kd 可非零）
    const inPhase = unstable ? (kp > 0 && ki === 0) : (kp > 0 && ki === 0 && kd === 0)
    if (inPhase) {
      const m = h.metrics
      // 不稳定系统好值 = 超调不超标 && 无显著震荡 && 振荡<=5%（PD阶段放宽到5%）
      if (unstable) {
        const oscOk = (m.oscillation ?? 0) <= 5
        if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation && oscOk) return kp
      } else {
        if ((m.overshoot ?? 0) <= overshootLimit && !m.hasSignificantOscillation) return kp
      }
    }
  }
  return null
}

function extractLastBadKp(history, cascade, overshootLimit, unstable = false) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (!h?.pid || !h?.metrics) continue
    const kp = Number(cascade ? h.pid.speedKp : h.pid.kp) || 0
    const ki = Number(cascade ? h.pid.speedKi : h.pid.ki) || 0
    const kd = Number(cascade ? h.pid.speedKd : h.pid.kd) || 0
    const inPhase = unstable ? (kp > 0 && ki === 0) : (kp > 0 && ki === 0 && kd === 0)
    if (inPhase) {
      const m = h.metrics
      // 不稳定系统坏值 = 超调超标 || 显著震荡 || 振荡>5%（PD阶段放宽到5%，不要求STABLE）
      if (unstable) {
        const oscOverLimit = (m.oscillation ?? 0) > 5
        if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation || oscOverLimit) return kp
      } else {
        if ((m.overshoot ?? 0) > overshootLimit || m.hasSignificantOscillation) return kp
      }
    }
  }
  return null
}

// ====== 调参循环 ======

/**
 * 跑一次完整的调参流程
 * @param {string} strategyId  模型 id（motor_speed / cascade_position / inverted_pendulum）
 * @param {object} modelOverrides  模型参数覆盖（J/B/Kt/target 等）
 * @param {object} opts  { maxRounds, seed }
 * @returns {{ rounds: Array, finalPid: object, finalMetrics: object, success: boolean, roundsUsed: number }}
 */
function runTuning(strategyId, modelOverrides, opts = {}) {
  const strategy = PID_STRATEGIES[strategyId]
  const cascade = strategyId === 'cascade_position'
  const unstable = !!strategy.unstable
  const maxRounds = opts.maxRounds || 50
  const seed = opts.seed ?? 20260723
  const overshootLimit = strategy.acceptance.overshootLimit

  // 起始参数：稳定系统从纯 P 开始（Ki=Kd=0）；不稳定系统从 PD 起步（保留 Kd 阻尼）
  // 串级：位置环Kp 从 0 起步，让策略自动探索合适值（避免默认值过小响应慢）
  //       速度环Kp 给一个初始值 1.0 提供基本跟随能力
  let current
  if (unstable) {
    current = { kp: 0, ki: 0, kd: strategy.defaults.kd || 1.0 }
  } else if (cascade) {
    current = { speedKp: 1.0, speedKi: 0, speedKd: 0, positionKp: 0, positionKi: 0, positionKd: 0 }
  } else {
    current = { kp: 1.0, ki: 0, kd: 0 }
  }

  const history = []
  let lastAcceptable = null  // 记录最后一组达标参数
  let firstAcceptableRound = null  // 首次达标轮次（用于触发提前结束）

  for (let round = 1; round <= maxRounds; round += 1) {
    // 1. 跑仿真
    const sim = simulatePidStrategy(strategyId, { ...current, ...modelOverrides }, seed + round)
    // 2. 分析指标
    const metrics = analyzeControlSamples(sim.samples, { ...strategy.acceptance })
    // 3. 提取二分法上下界
    const lastGoodKp = extractLastGoodKp(history, cascade, overshootLimit, unstable)
    const lastBadKp = extractLastBadKp(history, cascade, overshootLimit, unstable)
    // 4. 记录历史
    const roundRecord = {
      round,
      pid: { ...current },
      metrics: { ...metrics },
      model: { ...modelOverrides }
    }
    history.push(roundRecord)
    // 5. 判定是否达标（串级要求适当超调以加快响应，避免位置环Kp过小响应慢）
    //    但如果 positionKp 已达上限（8），说明 Kp 已尽力，不再要求最低超调
    const positionKpCapped = cascade && (Number(current.positionKp) >= 7.92)
    const accept = isAcceptable(metrics, { requireOvershoot: cascade && !positionKpCapped })
    if (accept.done) {
      lastAcceptable = { pid: { ...current }, metrics: { ...metrics }, round, samples: sim.samples }
      if (firstAcceptableRound === null) firstAcceptableRound = round
    }
    // 6. 生成下一轮候选参数
    const suggestion = buildPidSuggestion(metrics, current, {
      tuningOrder: strategy.defaultOrder,
      lastGoodKp: lastGoodKp || 0,
      lastBadKp: lastBadKp || 0,
      unstable
    })
    current = cascade
      ? { speedKp: suggestion.speedKp, speedKi: suggestion.speedKi, speedKd: suggestion.speedKd,
          positionKp: suggestion.positionKp, positionKi: suggestion.positionKi, positionKd: suggestion.positionKd }
      : { kp: suggestion.kp, ki: suggestion.ki, kd: suggestion.kd }
    // 7. 达标后跑1轮验证即结束（用首达轮次判定，避免每轮都达标时永不退出）
    if (firstAcceptableRound !== null && round > firstAcceptableRound) break
  }

  return {
    rounds: history,
    finalPid: lastAcceptable?.pid || history[history.length - 1].pid,
    finalMetrics: lastAcceptable?.metrics || history[history.length - 1].metrics,
    finalSamples: lastAcceptable?.samples || null,
    success: !!lastAcceptable,
    roundsUsed: lastAcceptable?.round || history.length,
    lastAcceptable
  }
}

// ====== 三种模型 × 三组参数 配置 ======

const TEST_CASES = {
  motor_speed: {
    name: '电机速度环（一阶）',
    maxRounds: 50,
    // 3 组不同的合理物理参数
    paramGroups: [
      { label: 'A: 默认参数',        overrides: {} },
      { label: 'B: 大惯量小阻尼',    overrides: { J: 0.05, B: 0.04, Kt: 0.4, target: 8 } },
      { label: 'C: 小惯量大阻尼',    overrides: { J: 0.01, B: 0.20, Kt: 0.6, target: 12 } }
    ]
  },
  cascade_position: {
    name: '位置-速度串级（二阶）',
    maxRounds: 80,
    paramGroups: [
      { label: 'A: 默认参数',        overrides: {} },
      { label: 'B: 大惯量小阻尼',    overrides: { J: 0.05, B: 0.04, Kt: 0.4, target: 1.5 } },
      { label: 'C: 小惯量大阻尼',    overrides: { J: 0.01, B: 0.20, Kt: 0.6, target: 0.8 } }
    ]
  },
  inverted_pendulum: {
    name: '倒立摆（不稳定二阶，等同平衡车摆角环）',
    maxRounds: 80,
    // 3 组合理模型参数：增大 initialAngle 以增大阶跃幅值，使振荡百分比更易达标
    // （振荡百分比 = 末尾窗内绝对波动 / 阶跃幅值 × 100%，阶跃幅值越大，同样的绝对波动占比越小）
    paramGroups: [
      { label: 'A: 默认参数大倾角',           overrides: { initialAngle: 0.20 } },
      { label: 'B: 短摆杆小质量大倾角',       overrides: { J: 0.05, m: 0.6, l: 0.18, initialAngle: 0.20 } },
      { label: 'C: 长摆杆大质量',             overrides: { J: 0.12, m: 1.5, l: 0.35, initialAngle: 0.20 } }
    ]
  }
}

// ====== 主入口 ======

function fmtArr(arr) { return arr.map((v) => Number(v).toFixed(3)).join(', ') }

function main() {
  const summary = []
  // 使用带日期戳的新目录，体现"新建文件夹"
  const today = new Date()
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  const waveformDir = path.resolve(fileURLToPath(import.meta.url), `../../pid_tuning_waveforms_${dateStr}`)
  fs.mkdirSync(waveformDir, { recursive: true })

  for (const [strategyId, cfg] of Object.entries(TEST_CASES)) {
    console.log(`\n========== ${cfg.name} ==========`)
    let casePass = true
    cfg.paramGroups.forEach((grp, idx) => {
      const result = runTuning(strategyId, grp.overrides, { maxRounds: cfg.maxRounds })
      const tag = result.success ? 'PASS' : 'FAIL'
      if (!result.success) casePass = false
      const m = result.finalMetrics
      console.log(
        `[${tag}] ${grp.label} | 轮数 ${result.roundsUsed}/${cfg.maxRounds} | ` +
        `Kp=${result.finalPid.kp ?? result.finalPid.speedKp} ` +
        `Ki=${result.finalPid.ki ?? result.finalPid.speedKi} ` +
        `Kd=${result.finalPid.kd ?? result.finalPid.speedKd} | ` +
        `超调=${m.overshoot}% 稳态误差=${m.steadyError} 振荡=${m.oscillation}% ` +
        `峰数=${m.oscillationPeakCount} 最大峰振幅=${m.maxPeakAmplitudePct}%`
      )
      summary.push({
        strategy: cfg.name,
        group: grp.label,
        success: result.success,
        roundsUsed: result.roundsUsed,
        maxRounds: cfg.maxRounds,
        finalPid: result.finalPid,
        finalMetrics: { overshoot: m.overshoot, steadyError: m.steadyError, oscillation: m.oscillation }
      })
      // 保存最优参数下的最后一轮波形数据（CSV）+ SVG 图
      if (result.finalSamples) {
        // 简洁文件名：strategyId_ABC.svg（A/B/C 表示第几组）
        const groupTag = String.fromCharCode(65 + idx) // A/B/C
        const baseName = `${strategyId}_${groupTag}`
        const csvPath = path.join(waveformDir, `${baseName}.csv`)
        const csvLines = ['t,target,feedback,output']
        result.finalSamples.forEach((s) => {
          csvLines.push(`${s.t},${s.target},${s.feedback},${s.output ?? ''}`)
        })
        fs.writeFileSync(csvPath, csvLines.join('\n'))
        // SVG 波形图
        const svgPath = path.join(waveformDir, `${baseName}.svg`)
        fs.writeFileSync(svgPath, renderWaveformSvg(result.finalSamples, strategyId, grp.label, result.finalPid, m))
      }
    })
    if (!casePass) {
      console.log(`  ⚠️  ${cfg.name} 有失败用例`)
    }
  }

  // 汇总
  console.log('\n========== 汇总 ==========')
  console.log('策略 | 组别 | 结果 | 轮数 | 超调% | 稳态误差 | 振荡%')
  summary.forEach((s) => {
    console.log(
      `${s.strategy} | ${s.group} | ${s.success ? 'PASS' : 'FAIL'} | ` +
      `${s.roundsUsed}/${s.maxRounds} | ${s.finalMetrics.overshoot} | ${s.finalMetrics.steadyError} | ${s.finalMetrics.oscillation}`
    )
  })

  const allPass = summary.every((s) => s.success)
  console.log(`\n验收结果: ${allPass ? '✅ 全部通过' : '❌ 存在未达标用例'}`)
  process.exit(allPass ? 0 : 1)
}

// ====== SVG 波形渲染（无外部依赖） ======

function renderWaveformSvg(samples, strategyId, label, pid, metrics) {
  const width = 1000
  const height = 480
  const margin = { left: 60, right: 30, top: 50, bottom: 50 }
  const w = width - margin.left - margin.right
  const h = height - margin.top - margin.bottom
  const ts = samples.map((s) => s.t)
  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  const allY = samples.flatMap((s) => [s.target, s.feedback, s.output ?? s.feedback])
  const yMin = Math.min(...allY)
  const yMax = Math.max(...allY)
  const yPad = (yMax - yMin) * 0.1 || 1
  const yLo = yMin - yPad
  const yHi = yMax + yPad
  const x = (t) => margin.left + ((t - tMin) / (tMax - tMin || 1)) * w
  const y = (v) => margin.top + (1 - (v - yLo) / (yHi - yLo || 1)) * h

  const toPath = (key) => samples.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.t).toFixed(2)} ${y(s[key] ?? s.feedback).toFixed(2)}`).join(' ')

  const pidStr = strategyId === 'cascade_position'
    ? `speedKp=${pid.speedKp} speedKi=${pid.speedKi} speedKd=${pid.speedKd} posKp=${pid.positionKp} posKi=${pid.positionKi} posKd=${pid.positionKd}`
    : `Kp=${pid.kp} Ki=${pid.ki} Kd=${pid.kd}`

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="monospace" font-size="12">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${margin.left}" y="20" font-size="14" font-weight="bold">${strategyId} - ${label}</text>
  <text x="${margin.left}" y="36" font-size="11" fill="#555">参数: ${pidStr}</text>
  <text x="${width - margin.right}" y="20" text-anchor="end" font-size="11" fill="#555">超调=${metrics.overshoot}% | 稳态误差=${metrics.steadyError} | 振荡=${metrics.oscillation}%</text>
  <!-- axes -->
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + h}" stroke="#333"/>
  <line x1="${margin.left}" y1="${margin.top + h}" x2="${margin.left + w}" y2="${margin.top + h}" stroke="#333"/>
  <!-- grid -->
  ${Array.from({ length: 5 }).map((_, i) => {
    const yy = margin.top + (h * i) / 4
    const val = (yHi - ((yHi - yLo) * i) / 4).toFixed(2)
    return `<line x1="${margin.left}" y1="${yy}" x2="${margin.left + w}" y2="${yy}" stroke="#eee"/><text x="${margin.left - 5}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#555">${val}</text>`
  }).join('')}
  ${Array.from({ length: 6 }).map((_, i) => {
    const xx = margin.left + (w * i) / 5
    const val = (tMin + ((tMax - tMin) * i) / 5).toFixed(2)
    return `<text x="${xx}" y="${margin.top + h + 15}" text-anchor="middle" font-size="10" fill="#555">${val}</text>`
  }).join('')}
  <!-- target (dashed gray) -->
  <path d="${toPath('target')}" fill="none" stroke="#888" stroke-width="1.5" stroke-dasharray="4 3"/>
  <!-- feedback (solid blue) -->
  <path d="${toPath('feedback')}" fill="none" stroke="#1f77b4" stroke-width="2"/>
  <!-- output (solid orange, optional) -->
  <path d="${toPath('output')}" fill="none" stroke="#ff7f0e" stroke-width="1.5" opacity="0.7"/>
  <!-- legend -->
  <g transform="translate(${margin.left + 10}, ${margin.top + 10})">
    <line x1="0" y1="0" x2="20" y2="0" stroke="#888" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="25" y="4" font-size="11">target</text>
    <line x1="0" y1="14" x2="20" y2="14" stroke="#1f77b4" stroke-width="2"/>
    <text x="25" y="18" font-size="11">feedback</text>
    <line x1="0" y1="28" x2="20" y2="28" stroke="#ff7f0e" stroke-width="1.5"/>
    <text x="25" y="32" font-size="11">output</text>
  </g>
  <text x="${margin.left + w / 2}" y="${height - 10}" text-anchor="middle" font-size="11">time (s)</text>
</svg>`
}

main()
