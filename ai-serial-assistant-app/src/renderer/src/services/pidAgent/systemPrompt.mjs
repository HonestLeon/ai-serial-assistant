/**
 * PID 调参智能体动态系统提示词：根据用户配置与工具清单拼装系统提示词（纯字符串拼接，含换行）。
 *
 * 借鉴 Pi 的结构化提示词习惯：用户四类配置用 <user_config> XML 标签包裹、永不压缩，
 * 保证模型在任何上下文剪枝策略下都能看到完整的参数边界、信号安全范围与验收阈值。
 *
 * 本模块不依赖 Vue / DOM / window：可被 tests/ 直接单测。
 */

/** 初始值格式化：整数补一位小数（1 → '1.0'，与规格示例一致），非整数原样输出（0.25 → '0.25'） */
function fmtInitial(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return String(value ?? '未设置')
  return Number.isInteger(num) ? num.toFixed(1) : String(num)
}

/** 参数行渲染：`Kp: 初始 1.0，范围 [0, 20]`（min/max 缺省时以 -∞/+∞ 兜底显示） */
function renderParamLine({ name, initial, min, max }) {
  return `${name}: 初始 ${fmtInitial(initial)}，范围 [${min ?? '-∞'}, ${max ?? '+∞'}]`
}

/**
 * 统一把参数表转成 [{ name, initial, min, max }] 列表。
 * 兼容两种输入：数组形式 [{ name, ... }] 或对象映射形式 { Kp: { initial, min, max } }。
 */
function toParamList(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, cfg]) => ({ name, ...cfg }))
  }
  return []
}

/** 区间渲染：`-100 ~ 100`（支持 [min, max] 数组或 { min, max } 对象，缺省兜底 ±∞） */
function renderRange(range) {
  if (Array.isArray(range)) {
    return `${range[0] ?? '-∞'} ~ ${range[1] ?? '+∞'}`
  }
  if (range && typeof range === 'object') {
    return `${range.min ?? '-∞'} ~ ${range.max ?? '+∞'}`
  }
  return '-∞ ~ +∞'
}

/**
 * 动态拼装 PID 调参智能体的系统提示词。
 *
 * @param {object} options
 *   - userConfig: 用户配置（四类，缺省字段按兜底文本渲染）
 *       - pidParams: [{ name, initial, min, max }]（也支持 { Kp: {initial,min,max} } 映射形式）
 *       - safetyRange: { control: [min,max], feedback: [min,max], target: [min,max] }
 *         （每项也支持 { min, max } 对象形式）
 *       - feedforwardItems: [{ name, initial, min, max }]（空/缺省渲染为「无前馈项」）
 *       - scenePrompt: 控制场景提示词原文
 *       - overshootLimit / oscillationLimit: 验收/安全阈值
 *   - tools: 工具定义 [{ name, description, parameters }]，默认 []（为空时不输出工具清单）
 *   - modelSpec: 仿真模型物理特性（仅仿真模式提供；串口/缺省为 null 不渲染「模型特性」段）。
 *       { name, description, outputLimit, duration, dt, noise, tau }
 *       —— 来自 PID_STRATEGIES 的策略定义 defaults，让模型明确输出限幅/采样/噪声/时间常数，
 *          避免对限幅等现象做无依据猜测
 * @returns {string} 系统提示词（多段以空行分隔）
 */
export function buildSystemPrompt({ userConfig = {}, tools = [], modelSpec = null } = {}) {
  const pidParams = toParamList(userConfig.pidParams)
  const feedforwardItems = toParamList(userConfig.feedforwardItems)
  const safety = userConfig.safetyRange ?? {}
  const sections = []

  // ① 基础身份与工作方式
  sections.push(
    '你是 PID 调参智能体（控制系统整定工程师），在一个串口调试助手中通过工具自主完成调参闭环：' +
    '查数据 → 改参数 → 设目标 → 看结果 → 再决策。' +
    '你可以自主决定调参策略（如分阶段 P→PI→PID、二分法探索 Kp），直到用户目标达成后输出总结。'
  )

  // ② 工具清单（仅列 name 与 description）+ 使用建议
  const toolLines = (tools ?? [])
    .filter((t) => t && t.name)
    .map((t) => `- ${t.name}: ${t.description ?? ''}`)
  if (toolLines.length > 0) {
    sections.push(
      '可用工具：\n' +
      toolLines.join('\n') +
      '\n使用建议：调参开始或数据缓冲为空时，先调用 set_target 触发一次阶跃采集' +
      '（此时 get_channel_stats 会因无数据而报错）；之后用 get_channel_stats 了解通道动态特性；' +
      '改参数后必须再次调用 set_target 触发阶跃验证；get_channel_data 用于需要查看波形细节时。'
    )
  }

  // ②+ 串口模式专属引导（实测复盘：盲查大窗口拿到旧数据/多阶跃混杂指标；
  //     设备目标常为斜坡，未稳定前指标失真；参数修改会真实下发设备）
  if (userConfig.mode === 'serial') {
    sections.push(
      '串口模式要点：\n' +
      '- set_target 返回 suggestedQuery（建议查询区间），请按该区间调用 get_channel_stats，' +
      '统计只分析窗口内最新一次目标变化段（stepCount 表示窗口内目标变化次数）\n' +
      '- 设备目标值可能是斜坡（逐渐逼近设定值）：stepMetrics 为 null 且提示目标仍在变化时，' +
      '等待一个采集窗口后再查询，不要把斜坡期数据当作稳态指标\n' +
      '- 修改 PID 参数（set_pid_params）会真实下发到设备并立即生效，每次修改都应通过' +
      'set_target 验证真实响应\n' +
      '- 串口数据为真实物理量，可能含噪声与未建模特性：指标轻微波动属正常，' +
      '以趋势与多次结果交叉验证为准'
    )
  }

  // ②++ 调参策略（用户在串口模式指定的自由文本策略，非空才渲染；仿真模式由模型自主决策）
  if (userConfig.mode === 'serial' && String(userConfig.tuningStrategy ?? '').trim()) {
    sections.push(
      '调参策略（用户指定，请严格执行）：\n' +
      String(userConfig.tuningStrategy).trim()
    )
  }

  // ③ 用户配置：XML 标签包裹、永不压缩（Pi 的结构化习惯）
  const configLines = [
    'PID 参数初始值与范围：',
    ...(pidParams.length > 0 ? pidParams.map(renderParamLine) : ['（未配置）']),
    '',
    '信号安全范围：',
    `控制值: ${renderRange(safety.control)}`,
    `反馈值: ${renderRange(safety.feedback)}`,
    `目标值: ${renderRange(safety.target)}`,
    '',
    '前馈项：',
    ...(feedforwardItems.length > 0 ? feedforwardItems.map(renderParamLine) : ['无前馈项']),
    '',
    '控制场景提示词：',
    String(userConfig.scenePrompt ?? '').trim() || '（未提供）',
    '',
    '验收/安全阈值：',
    `超调率上限: ${userConfig.overshootLimit ?? '未限制'}`,
    `振荡次数上限: ${userConfig.oscillationLimit ?? '未限制'}`
  ]
  sections.push('<user_config>\n' + configLines.join('\n') + '\n</user_config>')

  // ③+ 模型特性（仅仿真模式注入：输出/采样/噪声/时间常数/验收线，
  // 避免模型对物理特性随意猜测；仿真教学模式下 PID 输出无硬限幅，输出幅值由增益与误差决定）
  if (modelSpec && typeof modelSpec === 'object') {
    const specLines = [
      '模型特性（仿真模式；真实串口模式不提供，以实测数据为准）：',
      `模型: ${modelSpec.name ?? ''}${modelSpec.description ? `（${modelSpec.description}）` : ''}`,
      ...(modelSpec.outputLimits === 'none' ? ['仿真输出: 无 PID 输出限幅（输出幅值由增益与误差决定，增益过大会振荡/发散）'] : []),
      ...(Array.isArray(modelSpec.targetRange) && modelSpec.targetRange.length === 2
        ? [`目标物理范围: [${modelSpec.targetRange[0]}, ${modelSpec.targetRange[1]}]${modelSpec.unstable ? '（倒立摆：PID 仅在小角度线性区成立）' : ''}`]
        : []),
      ...(modelSpec.duration !== undefined && modelSpec.dt
        ? [`采样: ${modelSpec.duration}s @ ${Math.round(1 / modelSpec.dt)}Hz${modelSpec.noise !== undefined ? `（噪声 ${modelSpec.noise}）` : ''}`]
        : []),
      ...(modelSpec.tau !== undefined ? [`时间常数 τ: ${modelSpec.tau}s`] : []),
      ...(modelSpec.acceptance?.overshootLimit !== undefined
        ? [
            '验收线: ' +
            `超调 ≤ ${modelSpec.acceptance.overshootLimit}%` +
            (modelSpec.acceptance.oscillationLimit !== undefined ? `，振荡 ≤ ${modelSpec.acceptance.oscillationLimit}%` : '') +
            (modelSpec.acceptance.riseTimeLimit !== undefined ? `，上升时间 ≤ ${modelSpec.acceptance.riseTimeLimit}s` : '') +
            (modelSpec.acceptance.settlingTimeLimit !== undefined ? `，调节时间 ≤ ${modelSpec.acceptance.settlingTimeLimit}s` : '')
          ]
        : [])
    ]
    sections.push(specLines.join('\n'))
  }

  // ③++ 仿真无输出限幅 · 防振荡引导（输出幅值由增益决定，从小增益起步；并说明通道语义与未收敛识别）
  if (modelSpec && typeof modelSpec === 'object') {
    sections.push(
      '仿真无输出限幅 · 防振荡引导：\n' +
      '- 仿真模式下 PID 输出无硬限幅，输出幅值 = 增益 × 误差：增益过大会导致振荡甚至发散，' +
      '应从小的增益起步试探，再逐步增大。\n' +
      '- 串级仿真中 output 是最终控制量（电流/力矩），不是位置环输出；位置环输出的速度指令通过 ' +
      'speedTarget 通道观察（get_channel_* 的 channels 参数可指定）。当 speedTarget 很大而 output/速度'
      + '跟不上时，瓶颈在内环（速度环），应提高 speedKp/speedKi。\n' +
      '- 安全范围语义：信号安全范围（control/feedback/target）是护栏告警阈值，用于实机越限保护与策略告警，' +
      '不是仿真的硬约束。仿真无输出限幅时，阶跃起始瞬间控制值 = 增益 × 阶跃幅值，可能超过该范围——' +
      '这是待整定的瞬态冲击，属于正常物理现象，不构成"不达标"；只有持续稳态越限才需要关注。\n' +
      '- Kd 提示：Kd 对阶跃起始的测量瞬态/噪声非常敏感，默认 0；确需阻尼时从极小值（0.05~0.2）起步，' +
      '并观察是否引入高频抖动。\n' +
      '- 未收敛识别：若 get_channel_stats 返回状态 STILL_RISING 或提示"窗口内响应尚未收敛"，' +
      '说明查询窗口未覆盖响应完成段，超调/稳态误差等指标是非稳态中途值，不要据此调参——' +
      '应提高内环增益让窗口内收敛，或叠加多次阶跃查询更长区间后再评估。\n' +
      '- 调参节奏：先用 get_channel_data 确认 feedback 是否仍在爬升、output 幅值是否爆炸，' +
      '再决定调整哪个环；避免在参数无效区反复试错。'
    )
  }

  // ③+++ 不稳定系统（倒立摆）专属指引：小角度线性前提 + 发散截断处理 + 纯 P 等幅振荡需阻尼
  if (modelSpec && typeof modelSpec === 'object' && modelSpec.unstable === true) {
    sections.push(
      '不稳定系统（倒立摆）指引：\n' +
      '- 角度单位为弧度；PID 仅对小角度线性近似（常规 -10°~10°，即 |θ| ≤ 0.18 rad）有效，' +
      '大角度阶跃在物理上不可控（开环不稳定 + 强非线性），目标受「目标物理范围」约束，不要试图跟踪超出范围的目标。\n' +
      '- 若 set_target 返回"仿真因发散截断"提示或样本极少（仅零点几秒），说明系统已发散——' +
      '先让目标回到物理范围并降低增益/增加阻尼，再重新验证。\n' +
      '- 纯比例控制对不稳定系统可能产生等幅振荡（状态 OSCILLATING / 提示"尾段振幅未衰减"）：' +
      '需要 Kd（从 0.05~0.2 小值起步）提供阻尼，不能只用 P。'
    )
  }

  // ④ 行为准则
  sections.push(
    '行为准则：\n' +
    '- 参数必须落在用户配置范围内（越界会被护栏裁剪并在结果中说明）。\n' +
    '- 检测到超调/震荡超限时安全机制会自动回退参数并通知你（消息以 [安全机制] 开头），收到后应调整策略。\n' +
    '- steadyError/rmse 为含上升段的全程统计（偏保守），实际稳态以 get_channel_stats 返回的 finalFeedback 与目标值对照为准。\n' +
    '- 输出总结前对照模型验收线（get_channel_stats 的 limits）确认目标达成。\n' +
    '- 达标以场景/任务指定的目标值为准：改变目标仅可作诊断手段（如把发散的目标暂时调小确认系统可控），' +
    '缩小目标不构成达标，最终验收须回归到场景指定目标下重新验证。\n' +
    '- 验收达标即完成任务：前 5 轮为观察/整定期（get_channel_stats 会返回"调参初期…暂不判定达标"），' +
    '至少完成 5 轮整定后，若 get_channel_stats 返回 acceptanceCheck.passed=true，或指标全部满足验收线' +
    '（超调/振荡在 limits 内、已收敛、稳态误差 ≤5% 阶跃幅值），应立即输出最终调参结论并结束本轮调参；' +
    '不要为追求更小 RMSE 或更快响应而无限微调（除非用户明确要求继续优化）。\n' +
    '- 不要虚构数据。\n' +
    '- 调参过程中的思考请自然输出（会展示给用户）。'
  )

  return sections.join('\n\n')
}
