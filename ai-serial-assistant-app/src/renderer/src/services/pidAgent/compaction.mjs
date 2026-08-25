/**
 * PID 调参智能体 —— 数据上下文压缩。
 *
 * 纯 JS 模块（无 Vue/DOM/window 依赖），渲染进程与 Node 测试共用。
 *
 * 思路（借鉴 Pi-agent 的上下文压缩）：
 *   - 有损留底：只压缩「数据查询类 toolResult」（get_channel_* 的采样/统计结果），
 *     这类消息体积大且信息可再取，是最值得牺牲的部分；
 *   - 保留尾部：最近 retainedTail 条数据块原样保留（智能体通常正在围绕最新数据推理）；
 *   - 独立摘要请求：摘要由外部注入的 summarizeFn（一次独立的 LLM 请求）生成，
 *     本模块不关心摘要怎么来；summarizeFn 抛错时压缩失败但不影响主流程；
 *   - 成组替换：按 assistant 消息分组（一条 assistant 的多个 toolCalls 对应多条
 *     toolResult），组内全部 toolResult 均属待压缩才压缩该组（assistant + 其全部
 *     待压缩 toolResult 一起移除，原位置插入一条 compact 用户消息），否则整组保留，
 *     避免出现「assistant 还在、配对的 toolResult 却没了」的残缺对话。
 *
 * 永不触碰：非数据查询的 toolResult（如 set_pid_params 结果）、所有 user/assistant
 * 文本消息（未入压缩组的）、safety/steer 等关键消息。
 */
import { createUserMessage } from './types.mjs'

const textEncoder = new TextEncoder()
const byteLength = (str) => textEncoder.encode(String(str ?? '')).length

/**
 * 统计消息数组中「数据查询类 toolResult」的 content 字节总数。
 * 只统计 role === 'toolResult' 且 meta.isDataQuery === true 的消息（UTF-8 字节）。
 *
 * @param {Array} messages 消息数组
 * @returns {number}
 */
export function measureDataBytes(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    if (!message || message.role !== 'toolResult') continue
    if (!message.meta || message.meta.isDataQuery !== true) continue
    total += byteLength(message.content)
  }
  return total
}

/**
 * 数据字节超过阈值时压缩历史数据块。
 *
 * @param {object} options
 * @param {Array} options.messages                当前消息数组
 * @param {number} [options.thresholdBytes]       触发阈值（默认 50KB）
 * @param {(dumpText: string) => Promise<string>} options.summarizeFn 摘要函数（必填注入，独立 LLM 请求）
 * @param {number} [options.retainedTail]         保留最近几条数据块（默认 3）
 * @param {(event: object) => void} [options.emit] 压缩事件回调
 * @returns {Promise<{compacted:boolean, messages:Array, beforeBytes:number, afterBytes:number,
 *                    compactedCount?:number, error?:string}>}
 */
export async function compactIfNeeded({
  messages,
  thresholdBytes = 50 * 1024,
  summarizeFn,
  retainedTail = 3,
  emit = null
} = {}) {
  // 1. 测量当前数据字节；低于阈值直接原样返回
  const beforeBytes = measureDataBytes(messages)
  if (beforeBytes < thresholdBytes) {
    return { compacted: false, messages, beforeBytes, afterBytes: beforeBytes }
  }

  const messageList = Array.isArray(messages) ? messages : []

  // 2. 找出所有数据查询 toolResult 的索引；保留最后 retainedTail 条，其余进入待压缩集合
  const dataIndices = []
  messageList.forEach((message, index) => {
    if (message?.role === 'toolResult' && message.meta?.isDataQuery === true) {
      dataIndices.push(index)
    }
  })
  const tailCount = Math.max(0, Math.floor(Number(retainedTail) || 0))
  // 注意 slice(-0) 会返回整个数组，tailCount 为 0 时需显式置空
  const retainedIndices = new Set(tailCount > 0 ? dataIndices.slice(-tailCount) : [])
  const pendingIndices = new Set(dataIndices.filter((index) => !retainedIndices.has(index)))
  if (pendingIndices.size === 0) {
    return { compacted: false, messages, beforeBytes, afterBytes: beforeBytes }
  }

  // 3. 配对：向前就近查找 toolCallId 匹配的 assistant 消息，按 assistant 分组
  //    （一条 assistant 的多个 toolCalls 对应多条 toolResult，需整组一起处理）
  const findOwnerAssistant = (toolResultIndex, toolCallId) => {
    if (!toolCallId) return -1
    for (let i = toolResultIndex - 1; i >= 0; i -= 1) {
      const candidate = messageList[i]
      if (candidate?.role !== 'assistant' || !Array.isArray(candidate.meta?.toolCalls)) continue
      if (candidate.meta.toolCalls.some((call) => call && call.id === toolCallId)) return i
    }
    return -1
  }

  // assistantIndex -> 该 assistant 名下全部 toolResult 的索引（升序）
  const groups = new Map()
  messageList.forEach((message, index) => {
    if (message?.role !== 'toolResult') return
    const owner = findOwnerAssistant(index, message.meta?.toolCallId)
    if (owner < 0) return
    if (!groups.has(owner)) groups.set(owner, [])
    groups.get(owner).push(index)
  })

  // 4. 组内全部 toolResult 均属待压缩才压缩该组，否则整组保留
  //    （尾部保留块、非数据 toolResult 所在的组都会因此整体豁免）
  const compressibleGroups = []
  for (const [assistantIndex, toolResultIndices] of groups) {
    if (toolResultIndices.length === 0) continue
    if (!toolResultIndices.every((index) => pendingIndices.has(index))) continue
    compressibleGroups.push({ assistantIndex, toolResultIndices })
  }
  if (compressibleGroups.length === 0) {
    return { compacted: false, messages, beforeBytes, afterBytes: beforeBytes }
  }

  // 5. 逐组生成 dumpText（toolCall 名 + 参数 + 结果 JSON 拼接）并请求摘要
  //    任一组摘要失败则整体放弃压缩（原数组原样返回，不影响主流程）
  const summaries = []
  try {
    for (const group of compressibleGroups) {
      const assistant = messageList[group.assistantIndex]
      const parts = group.toolResultIndices.map((index) => {
        const toolResult = messageList[index]
        const call = assistant.meta.toolCalls.find((c) => c && c.id === toolResult.meta?.toolCallId)
        const name = call?.name ?? toolResult.meta?.toolName ?? ''
        const args = JSON.stringify(call?.arguments ?? {})
        return `工具调用 ${name}，参数 ${args}，结果 ${toolResult.content ?? ''}`
      })
      const summary = await summarizeFn(parts.join('\n'))
      summaries.push(String(summary ?? ''))
    }
  } catch (error) {
    return {
      compacted: false,
      messages,
      beforeBytes,
      afterBytes: beforeBytes,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  // 6. 组装新数组：移除各压缩组（assistant + 其全部待压缩 toolResult），
  //    在原组起始位置（assistant 原位置）插入一条 compact 摘要消息
  const removeIndices = new Set()
  const insertOrderAt = new Map() // assistantIndex -> 摘要序号
  compressibleGroups.forEach((group, order) => {
    removeIndices.add(group.assistantIndex)
    group.toolResultIndices.forEach((index) => removeIndices.add(index))
    insertOrderAt.set(group.assistantIndex, order)
  })

  const compactMessages = summaries.map((text) => createUserMessage(`[历史数据摘要] ${text}`, 'compact'))
  const newMessages = []
  messageList.forEach((message, index) => {
    if (!removeIndices.has(index)) {
      newMessages.push(message)
      return
    }
    const order = insertOrderAt.get(index)
    if (order !== undefined) {
      newMessages.push(compactMessages[order])
    }
  })

  // 7. 重算压缩后字节，回填 compactInfo（含压缩前后字节数，供 UI 展示压缩收益）
  const afterBytes = measureDataBytes(newMessages)
  compactMessages.forEach((message) => {
    message.meta.compactInfo = { beforeBytes, afterBytes }
  })

  const compactedCount = compressibleGroups.reduce(
    (sum, group) => sum + group.toolResultIndices.length,
    0
  )
  emit?.({ type: 'compaction_applied', beforeBytes, afterBytes, compactedCount })
  return { compacted: true, messages: newMessages, beforeBytes, afterBytes, compactedCount }
}
