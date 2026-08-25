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

  // ③+ 模型特性（仅仿真模式注入：输出限幅/采样/噪声/时间常数，避免模型对限幅等现象猜测）
  if (modelSpec && typeof modelSpec === 'object') {
    const specLines = [
      '模型特性（仿真模式；真实串口模式不提供，以实测数据为准）：',
      `模型: ${modelSpec.name ?? ''}${modelSpec.description ? `（${modelSpec.description}）` : ''}`,
      ...(modelSpec.outputLimit !== undefined ? [`输出限幅: ${modelSpec.outputLimit}`] : []),
      ...(modelSpec.duration !== undefined && modelSpec.dt
        ? [`采样: ${modelSpec.duration}s @ ${Math.round(1 / modelSpec.dt)}Hz${modelSpec.noise !== undefined ? `（噪声 ${modelSpec.noise}）` : ''}`]
        : []),
      ...(modelSpec.tau !== undefined ? [`时间常数 τ: ${modelSpec.tau}s`] : [])
    ]
    sections.push(specLines.join('\n'))
  }

  // ④ 行为准则
  sections.push(
    '行为准则：\n' +
    '- 参数必须落在用户配置范围内（越界会被护栏裁剪并在结果中说明）。\n' +
    '- 检测到超调/震荡超限时安全机制会自动回退参数并通知你（消息以 [安全机制] 开头），收到后应调整策略。\n' +
    '- steadyError/rmse 为含上升段的全程统计（偏保守），实际稳态以 get_channel_stats 返回的 finalFeedback 与目标值对照为准。\n' +
    '- 输出总结前对照模型验收线（get_channel_stats 的 limits）确认目标达成。\n' +
    '- 不要虚构数据。\n' +
    '- 调参过程中的思考请自然输出（会展示给用户）。'
  )

  return sections.join('\n\n')
}
