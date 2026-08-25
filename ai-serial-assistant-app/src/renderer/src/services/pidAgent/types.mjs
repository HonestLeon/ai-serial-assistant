/**
 * PID 调参智能体 —— 消息与用户配置类型定义。
 *
 * 纯 JS 模块（无 Vue/DOM/window 依赖），渲染进程与 Node 测试共用。
 * 消息结构参考 Pi-agent 的对话式智能体：role 区分消息来源，
 * kind 供上下文压缩与安全护栏识别关键消息块（如 steer/safety 不压缩、数据查询块优先压缩）。
 */

/**
 * 消息种类：
 * - normal   普通对话消息
 * - steer    用户中途纠偏/改向指令（打断当前调参方向）
 * - followUp 用户对上一轮结果的追问
 * - safety   安全护栏消息（越界提醒、参数回退、强制终止等）
 * - compact  上下文压缩标记消息（历史块被摘要替换）
 * - summary  阶段性总结消息
 */
export const AGENT_MESSAGE_KINDS = ['normal', 'steer', 'followUp', 'safety', 'compact', 'summary']

/** 消息角色：user 用户输入 / assistant 智能体输出 / toolResult 工具执行结果 */
export const AGENT_MESSAGE_ROLES = ['user', 'assistant', 'toolResult']

// 模块内自增序号：与 Date.now() 组合生成消息 id（同一毫秒内也不重复）
let messageSeq = 0

const nextMessageId = () => {
  messageSeq += 1
  return `msg-${messageSeq}-${Date.now()}`
}

/** 消息公共骨架：所有工厂函数都返回 { id, role, kind, content, timestamp, meta } */
const createMessage = (role, kind, content) => ({
  id: nextMessageId(),
  role,
  kind,
  content,
  timestamp: Date.now(),
  meta: {}
})

/**
 * 创建用户消息。
 * @param {string} text 用户输入文本
 * @param {string} [kind] 消息种类（AGENT_MESSAGE_KINDS 之一，默认 normal）
 * @returns {{id:string, role:'user', kind:string, content:string, timestamp:number, meta:object}}
 */
export function createUserMessage(text, kind = 'normal') {
  return createMessage('user', kind, String(text ?? ''))
}

/**
 * 创建智能体消息。content 为文本，meta.toolCalls 为本轮工具调用计划。
 * 流式输出时外部可直接更新 meta.streaming 与 meta.toolCalls（如补充 arguments）。
 * @param {{text?:string, toolCalls?:Array<{id:string, name:string, arguments:object}>}} [options]
 * @returns {{id:string, role:'assistant', kind:string, content:string, timestamp:number, meta:{toolCalls:Array, streaming:boolean}}}
 */
export function createAssistantMessage({ text = '', toolCalls = [] } = {}) {
  const message = createMessage('assistant', 'normal', String(text ?? ''))
  message.meta.toolCalls = (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
    id: call?.id ?? '',
    name: call?.name ?? '',
    arguments: call?.arguments ?? {}
  }))
  // 流式标记：创建时为 false，流式输出期间置 true，完成后置回 false
  message.meta.streaming = false
  return message
}

/**
 * 创建工具结果消息。content 固定为 result 的 JSON 字符串。
 * meta.isDataQuery 标记数据查询类工具（工具名以 get_channel_ 开头），
 * 供上下文压缩优先识别可压缩的大块数据。
 * @param {{toolCallId?:string, toolName?:string, result?:*, isError?:boolean}} [options]
 * @returns {{id:string, role:'toolResult', kind:string, content:string, timestamp:number, meta:{toolCallId:string, toolName:string, isError:boolean, isDataQuery:boolean}}}
 */
export function createToolResultMessage({ toolCallId = '', toolName = '', result = null, isError = false } = {}) {
  const message = createMessage('toolResult', 'normal', JSON.stringify(result))
  message.meta.toolCallId = toolCallId
  message.meta.toolName = toolName
  message.meta.isError = !!isError
  message.meta.isDataQuery = typeof toolName === 'string' && toolName.startsWith('get_channel_')
  return message
}

/**
 * @typedef {object} AgentParamConfig
 * @property {string} key   参数键名（如 kp/ki/kd）
 * @property {string} label 展示名称
 * @property {number} init  初始值（要求 min ≤ init ≤ max）
 * @property {number} min   下限
 * @property {number} max   上限
 */

/**
 * 用户提供的调参配置（会话启动前由 UI 表单或自然语言解析生成）。
 * @typedef {object} UserConfig
 * @property {Array<AgentParamConfig>} pid PID 参数定义列表
 * @property {{output:{min:number,max:number}, feedback:{min:number,max:number}, target:{min:number,max:number}}} safety 安全限幅（输出/反馈/目标）
 * @property {Array<{id:string, label:string, init:number, min:number, max:number}>} feedforward 前馈系数定义列表
 * @property {string} scenePrompt 场景描述提示词（被控对象、调参目标、特殊约束）
 * @property {{overshootLimit:number, oscillationLimit:number}} acceptance 验收阈值（安全检测用）
 */

/** 默认用户配置：单环 PID + 常用安全限幅 + 默认验收阈值 */
export function createDefaultUserConfig() {
  return {
    pid: [
      { key: 'kp', label: 'Kp', init: 1.0, min: 0, max: 20 },
      { key: 'ki', label: 'Ki', init: 0, min: 0, max: 10 },
      { key: 'kd', label: 'Kd', init: 0, min: 0, max: 10 }
    ],
    safety: {
      output: { min: -100, max: 100 },
      feedback: { min: 0, max: 120 },
      target: { min: 0, max: 100 }
    },
    feedforward: [], // [{ id, label, init, min, max }]
    scenePrompt: '',
    acceptance: { overshootLimit: 20, oscillationLimit: 10 } // 安全检测阈值
  }
}

// 校验参数定义列表（pid / feedforward 共用）：
// 每项 init/min/max 必须为有限数，且 min ≤ init ≤ max
const collectParamIssues = (list, prefix, missing, reasons) => {
  list.forEach((item, index) => {
    const path = `${prefix}[${index}]`
    if (!item || typeof item !== 'object') {
      missing.push(`${path}.init`, `${path}.min`, `${path}.max`)
      reasons.push(`${path} 不是有效的参数定义`)
      return
    }
    const badFields = ['init', 'min', 'max'].filter((field) => !Number.isFinite(Number(item[field])))
    if (badFields.length) {
      badFields.forEach((field) => missing.push(`${path}.${field}`))
      reasons.push(`${path} 的 ${badFields.join('/')} 必须为有限数字`)
      return
    }
    if (item.min > item.init || item.init > item.max) {
      missing.push(`${path}.init`)
      reasons.push(`${path} 初始值 ${item.init} 不在 [${item.min}, ${item.max}] 范围内`)
    }
  })
}

/**
 * 校验用户配置完整性（pid 每项 init/min/max 有限且 min ≤ init ≤ max、
 * scenePrompt 非空、feedforward 每项同 pid 校验）。
 * @param {UserConfig} config
 * @returns {{ok:true}|{ok:false, missing:string[], reason:string}}
 */
export function validateUserConfig(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, missing: ['config'], reason: '配置对象缺失' }
  }
  const missing = []
  const reasons = []

  if (!Array.isArray(config.pid) || config.pid.length === 0) {
    missing.push('pid')
    reasons.push('pid 参数数组缺失或为空')
  } else {
    collectParamIssues(config.pid, 'pid', missing, reasons)
  }

  if (typeof config.scenePrompt !== 'string' || config.scenePrompt.trim() === '') {
    missing.push('scenePrompt')
    reasons.push('场景描述 scenePrompt 不能为空')
  }

  if (!Array.isArray(config.feedforward)) {
    missing.push('feedforward')
    reasons.push('feedforward 必须为数组')
  } else {
    collectParamIssues(config.feedforward, 'feedforward', missing, reasons)
  }

  if (missing.length) {
    return { ok: false, missing, reason: reasons.join('；') }
  }
  return { ok: true }
}
