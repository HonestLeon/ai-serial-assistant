/**
 * PID AI 客户端：把「喂给 LLM 的上下文 + HTTP 调用 + 解析回退 + 安全护栏」封装为纯异步函数。
 *
 * 从 PidPanel.vue 的 callAiForPid 抽取，逐行等价搬运（行为零变化）：
 *   - system/user 提示词组装（复用 pidPrompt.mjs 纯函数）
 *   - 5 次指数退避重试 [0,2,4,8,16] 秒
 *   - response_format（json_schema）协商回退：部分 OpenAI 兼容后端不支持时自动改普通 JSON 提示词
 *   - parse-repair 循环：模型输出校验失败时把“错误输出 + 校验反馈”追加进 messages 让其自修复
 *   - I/D 开关强制约束、阶段约束后处理、噪声约束
 *   - applyPidGuardrails 安全护栏裁剪（边界 + 单步增幅）
 *   - P 阶段二分法强制覆盖（AI 可能给不合理的 Kp，用 lastGoodKp/lastBadKp 约束）
 *
 * 本模块不依赖 Vue / DOM / window：所有上下文以参数注入，可被 tests/ 直接单测。
 */

import {
  PID_PROMPT_VERSION,
  buildPidJsonSchema,
  buildPidRepairMessage,
  buildPidSystemPrompt,
  buildStructuredPidHistory,
  buildStructuredResponseFormat,
  downsamplePidWaveform,
  parsePidAiResponse,
  pickSuccessfulPidExamples
} from './pidPrompt.mjs'
import { applyPidGuardrails } from './pidSafety.mjs'

/**
 * 调用 AI 给出下一轮 PID 候选参数。
 *
 * @param {object} ctx 扁平上下文（全部由调用方注入，避免访问组件状态）：
 *   - aiConfig: { baseUrl, model, apiKey }          必填
 *   - metrics: analyzeControlSamples 结果            必填
 *   - currentPid: 当前 PID 参数（单环 kp/ki/kd 或串级含 speed* / position*） 必填
 *   - cascade: 是否串级（默认 false）
 *   - enableI / enableD: I/D 开关（默认 true）
 *   - tuningHistory: 调参历史数组（默认 []）
 *   - waveformSamples: 时序波形 [{t,target,feedback,output}]（默认 []）
 *   - tuningOrder: 已格式化的调参顺序字符串数组（前馈·x / Kp …，默认 []）
 *   - scenario: 场景描述文本（仿真/串口已拼好，默认 ''）
 *   - knownModelParams: 仿真模型配置对象或 null（默认 null）
 *   - feedforwardSelection: 前馈勾选 { id: coeff }（默认 {}）
 *   - lastGoodKp / lastBadKp: P 阶段二分法上下界（默认 0）
 * @returns {Promise<{ok:boolean, params?:object, thought?:string, selfCheck?:string,
 *   guardNotes?:string[], phase?:string, structuredOutput?:boolean, error?:string}>}
 */
export async function callAiForPid(ctx = {}) {
  const {
    aiConfig,
    metrics,
    currentPid,
    cascade = false,
    enableI = true,
    enableD = true,
    tuningHistory = [],
    waveformSamples = [],
    tuningOrder = [],
    scenario = '',
    knownModelParams = null,
    feedforwardSelection = {},
    lastGoodKp = 0,
    lastBadKp = 0
  } = ctx
  if (!aiConfig?.apiKey) {
    return { ok: false, error: '未配置 API Key' }
  }

  const formatSpec = cascade
    ? '{"speedKp":<0-20>,"speedKi":<0-10>,"speedKd":<0-10>,"positionKp":<0-20>,"positionKi":<0-10>,"positionKd":<0-10>,"analysis_summary":"<工程依据摘要>","self_check":"<边界与阶段自检>"}'
    : '{"kp":<0-20>,"ki":<0-10>,"kd":<0-10>,"analysis_summary":"<工程依据摘要>","self_check":"<边界与阶段自检>"}'
  const currentParams = currentPid
  const structuredHistory = buildStructuredPidHistory(tuningHistory, 3200)
  const successfulExamples = pickSuccessfulPidExamples(tuningHistory, 2)
  const waveform = downsamplePidWaveform(waveformSamples, 30)

  // 推断当前调参阶段（与 buildPidSuggestion 一致），同时尊重 I/D 开关
  const eps = 1e-6
  const pVal = cascade ? currentParams.speedKp : currentParams.kp
  const iVal = cascade ? currentParams.speedKi : currentParams.ki
  const dVal = cascade ? currentParams.speedKd : currentParams.kd
  const phase = (!pVal && !iVal && !dVal) || (pVal > eps && !iVal && !dVal) ? 'P'
    : (enableD && pVal > eps && iVal > eps && !dVal) ? 'PI'
    : (enableI && pVal > eps && !iVal && dVal > eps) ? 'PD'
    : (enableI && enableD) ? 'PID'
    : (enableI ? 'PI' : (enableD ? 'PD' : 'P'))
  // 噪声判定
  const noisy = (metrics.oscillation ?? 0) > (metrics.limits?.oscillation ?? 10) * 1.2

  // 可接受超调上限：验收标准的 1.2 倍（P 阶段允许一定超调以换取响应速度）
  const overshootLimit = metrics.limits?.overshoot ?? 20
  const overshootMargin = overshootLimit * 1.2
  const curOvershoot = metrics.overshoot ?? 0
  const fmtPct = (v) => Number(v).toFixed(1)

  // 按阶段生成针对性策略提示，让 AI 明确本轮调整方向
  let phaseStrategy
  if (phase === 'P') {
    const hasOsc = !!metrics.hasSignificantOscillation
    const peakInfo = `峰数 ${metrics.oscillationPeakCount ?? 0}，最大振幅 ${fmtPct(metrics.maxPeakAmplitudePct ?? 0)}%`
    if (hasOsc) {
      phaseStrategy = `当前 P 阶段：检测到明显震荡（${peakInfo}，从第三个峰起振幅应≤5%）。` +
        `应减小 Kp 直到震荡消失。Ki=Kd=0。`
    } else if (curOvershoot > overshootMargin) {
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 超出可接受范围（≤${fmtPct(overshootMargin)}%），应减小 Kp。Ki=Kd=0。`
    } else if (curOvershoot > overshootLimit) {
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 已接近可接受上限（≤${fmtPct(overshootMargin)}%），Kp 已尽量增大。` +
        `可保持当前 Kp 进入 PI 阶段加 Ki 消除稳态误差。`
    } else {
      // 根据稳态误差告诉 AI 应激进还是保守
      const steadyErrRatio = Math.abs(metrics.steadyError ?? 0) / Math.max(Math.abs(metrics.stepSize ?? 1), 1e-6)
      let factorHint
      if (steadyErrRatio > 0.3) {
        factorHint = '稳态误差较大，应激进增大 Kp（×1.5~2.0）'
      } else if (steadyErrRatio > 0.1) {
        factorHint = '稳态误差中等，应中等幅度增大 Kp（×1.3~1.5）'
      } else {
        factorHint = '稳态误差较小，应保守增大 Kp（×1.2~1.3）'
      }
      phaseStrategy = `当前 P 阶段：超调 ${fmtPct(curOvershoot)}% 远低于验收标准 ${fmtPct(overshootLimit)}%，无明显震荡。` +
        `${factorHint}，在可接受超调范围内（≤${fmtPct(overshootMargin)}%）尽量把 Kp 给大。Ki=Kd=0。`
    }
  } else if (phase === 'PI') {
    phaseStrategy = '当前 PI 阶段：P 已调好，加 Ki 消除稳态误差，Kd=0。稳态误差大时增大 Ki，超调时降 P/Ki。'
  } else {
    phaseStrategy = '当前 PID 阶段：加 Kd 抑制超调/振荡。噪声大时禁止加 Kd。'
  }

  const userContent = JSON.stringify({
    提示词版本: PID_PROMPT_VERSION,
    任务: '根据模型事实、响应指标、时序波形、已验证历史和当前阶段，提出下一轮待仿真验证的 PID 参数。',
    输出JSONSchema: buildPidJsonSchema(cascade),
    当前参数: currentParams,
    当前阶段: phase,
    启用积分项: enableI ? '是（Ki 可非 0）' : '否（Ki 必须为 0，仅 P/PD 模式）',
    启用微分项: enableD ? '是（Kd 可非 0）' : '否（Kd 必须为 0，仅 P/PI 模式）',
    响应指标: {
      状态: metrics.status,
      超调率: metrics.overshoot,
      上升时间: metrics.riseTime,
      稳定时间: metrics.settlingTime,
      稳态误差: metrics.steadyError,
      均方根误差: metrics.rmse,
      振荡: metrics.oscillation,
      振荡峰数: metrics.oscillationPeakCount ?? 0,
      振荡频率: metrics.oscillationFrequency ?? null,
      最大峰振幅百分比: metrics.maxPeakAmplitudePct ?? 0,
      明显震荡: metrics.hasSignificantOscillation ? '是（从第三个峰起振幅>5%，应减小 Kp）' : '否',
      采样点数: metrics.sampleCount,
      反馈噪声大: noisy ? '是（禁止加 Kd）' : '否'
    },
    超调空间: {
      当前超调率: `${fmtPct(curOvershoot)}%`,
      验收标准: `${fmtPct(overshootLimit)}%`,
      可接受上限: `${fmtPct(overshootMargin)}%（P 阶段允许达到此值以最大化 Kp）`
    },
    时序波形_均匀下采样: waveform,
    调参历史_按字符预算裁剪: structuredHistory,
    已验证成功案例: successfulExamples,
    场景: scenario,
    已知模型参数: knownModelParams,
    前馈上下文: {
      已启用: Object.keys(feedforwardSelection),
      当前系数: { ...feedforwardSelection },
      约束: '本次 AI 只输出 PID 参数；前馈由独立确定性策略调整，禁止用 PID 同时补偿前馈。'
    },
    调参顺序: tuningOrder,
    调参策略: phaseStrategy,
    安全要求: '参数必须循序渐进，单步增幅不得超过 3 倍。借鉴历史中的 AI 思考，避免重复无效方向。若"启用积分项/启用微分项"为否，对应 Ki/Kd 必须输出 0。'
  }, null, 2)

  const systemContent = buildPidSystemPrompt({
    cascade,
    phase,
    formatSpec,
    hasFeedforward: Object.keys(feedforwardSelection).length > 0
  })
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ]

  // 5 次指数退避重试
  const delays = [0, 2, 4, 8, 16]
  let lastError = ''
  let structuredOutputEnabled = true

  async function requestCompletion(useStructuredOutput) {
    const body = {
      model: aiConfig.model,
      temperature: 0.2,
      messages,
      stream: false
    }
    if (useStructuredOutput) {
      body.response_format = buildStructuredResponseFormat(cascade)
    }
    return fetch(`${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify(body)
    })
  }

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt] * 1000))
    try {
      let res = await requestCompletion(structuredOutputEnabled)
      if (!res.ok && structuredOutputEnabled && [400, 404, 422].includes(res.status)) {
        // OpenAI 兼容后端对 json_schema 支持不一致：自动回退为普通 JSON 提示词，不要求用户手工配置。
        structuredOutputEnabled = false
        res = await requestCompletion(false)
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 240)
        lastError = `HTTP ${res.status}${detail ? `：${detail}` : ''}`
        continue
      }
      const data2 = await res.json()
      const raw = data2.choices?.[0]?.message?.content || ''
      const parsedResult = parsePidAiResponse(raw, cascade)
      if (!parsedResult.ok) {
        lastError = parsedResult.error
        // Instructor 风格自修复：让模型看到自己的错误输出和明确校验反馈。
        messages.push({ role: 'assistant', content: raw.slice(0, 2000) })
        messages.push({ role: 'user', content: buildPidRepairMessage(parsedResult.error, formatSpec) })
        continue
      }
      const parsed = { ...parsedResult.params }
      // I/D 开关强制约束：用户关闭 I/D 时，AI 输出必须强制 Ki/Kd=0（防御 AI 不听话）
      if (!enableI) {
        if (cascade) { parsed.speedKi = 0; parsed.positionKi = 0 }
        else { parsed.ki = 0 }
      }
      if (!enableD) {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      }
      // 阶段约束后处理：P 阶段强制 Ki=Kd=0；PI 阶段强制 Kd=0；噪声大时强制 Kd=0
      if (phase === 'P') {
        if (cascade) { parsed.speedKi = 0; parsed.speedKd = 0; parsed.positionKi = 0; parsed.positionKd = 0 }
        else { parsed.ki = 0; parsed.kd = 0 }
      } else if (phase === 'PI') {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      } else if (phase === 'PD') {
        // PD 阶段强制 Ki=0（保留 Kd）
        if (cascade) { parsed.speedKi = 0; parsed.positionKi = 0 }
        else { parsed.ki = 0 }
      }
      if (noisy) {
        if (cascade) { parsed.speedKd = 0; parsed.positionKd = 0 }
        else { parsed.kd = 0 }
      }
      // 安全护栏裁剪（单步增幅限制 + 边界）
      const guard = applyPidGuardrails(currentParams, parsed)
      // P 阶段二分法强制覆盖：AI 可能给一个不合理的 Kp，用二分上下界强制约束
      const lgKp = Number(lastGoodKp) || 0  // 下界（无超调）
      const lbKp = Number(lastBadKp) || 0   // 上界（超调/震荡）
      if (phase === 'P') {
        const kpKey = cascade ? 'speedKp' : 'kp'
        const curKp = Number(currentParams[kpKey]) || 0
        const overshootMargin = (Number(metrics.limits?.overshoot) || 20) * 1.2
        const isBad = (Number(metrics.overshoot) || 0) > overshootMargin || metrics.hasSignificantOscillation
        const aiKp = Number(guard.params[kpKey]) || 0
        // 收敛判定：上下界差 < 均值的 10%
        const bisectMean = (lgKp > 0 && lbKp > 0) ? (lgKp + lbKp) / 2 : 0
        const bisectConverged = lgKp > 0 && lbKp > 0 && (lbKp - lgKp) < bisectMean * 0.1
        if (bisectConverged) {
          // 区间已收敛 → 强制进入 PI：保持当前 Kp，开启 Ki
          if (cascade) { guard.params.speedKi = 0.5 }
          else { guard.params.ki = 0.5 }
          guard.notes.push(`P 阶段二分区间已收敛（下界 ${lgKp.toFixed(3)} ↔ 上界 ${lbKp.toFixed(3)}），强制进入 PI 阶段`)
        } else if (isBad && lgKp > 0 && lgKp < curKp) {
          // 当前坏 + 有下界 → 二分(下界+当前)/2，覆盖 AI Kp
          const bisect = (lgKp + curKp) / 2
          guard.params[kpKey] = bisect
          guard.notes.push(`P 阶段二分法覆盖 AI Kp: ${aiKp.toFixed(3)} → ${bisect.toFixed(3)}（下界 ${lgKp.toFixed(3)} ↔ 当前 ${curKp.toFixed(3)}）`)
        } else if (!isBad && lbKp > 0 && curKp < lbKp) {
          // 当前好 + 有上界 → 继续二分(当前+上界)/2 逼近上界，覆盖 AI Kp（避免跳过上界）
          const bisect = (curKp + lbKp) / 2
          guard.params[kpKey] = bisect
          guard.notes.push(`P 阶段继续二分逼近上界，覆盖 AI Kp: ${aiKp.toFixed(3)} → ${bisect.toFixed(3)}（当前 ${curKp.toFixed(3)} ↔ 上界 ${lbKp.toFixed(3)}）`)
        }
      }
      return {
        ok: true,
        params: guard.params,
        thought: parsedResult.analysisSummary,
        selfCheck: parsedResult.selfCheck,
        guardNotes: guard.notes,
        phase,
        structuredOutput: structuredOutputEnabled
      }
    } catch (e) {
      lastError = e.message || String(e)
    }
  }
  return { ok: false, error: lastError }
}