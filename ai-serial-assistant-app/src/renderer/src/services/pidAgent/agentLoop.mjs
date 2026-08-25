/**
 * PID 调参智能体 —— Pi-agent 同构的双层循环引擎。
 *
 * 双层循环结构（与 Pi agent-loop 一致）：
 * - 外层 while：一次「任务回合」。内层结束后 drain followUp 队列，
 *   有追问消息则注入 messages 并重启外层（视为新任务），无则整个循环结束。
 * - 内层 while：单任务内的「LLM ↔ 工具」迭代。只要模型持续产出工具调用
 *   就继续轮转，直到模型给出不含工具调用的纯文本回复（任务完成）。
 *
 * 中途干预：
 * - steerQueue：用户中途纠偏/改向消息，每个内层回合开始时 drain 进 messages，
 *   模型下一轮即可看到（对话不被打断，方向可被纠正）。
 * - AbortSignal / shouldStopAfterTurn：用户停止与安全熔断，回合粒度终止。
 *
 * 事件（emit 回调，event = { type, ...payload }）：
 *   agent_start → 每回合 [ turn_start → message_start → message_end
 *     → (tool_execution_start → tool_execution_end)* ] → turn_end → agent_end
 *
 * 纯 JS ESM 模块（无 Vue / DOM / window 依赖），渲染进程与 Node 测试共用。
 */
import { createAssistantMessage, createToolResultMessage } from './types.mjs'
import { convertToLlm } from './llm.mjs'

/**
 * Pi 式两阶段消息队列：先 push 暂存，drain 时一次性取出全部并清空。
 * 用于 steer（中途纠偏）与 followUp（追问）两类「排队等待注入」的消息。
 * @returns {{push:(msg:object)=>void, drain:()=>Array<object>, size:()=>number}}
 */
export function createPendingMessageQueue() {
  const queue = []
  return {
    /** 入队一条消息（暂存，尚未进入对话） */
    push(msg) {
      if (msg) queue.push(msg)
    },
    /** 取出全部消息并清空队列（两阶段：先积压、后统一注入） */
    drain() {
      const out = queue.slice()
      queue.length = 0
      return out
    },
    /** 当前积压的消息条数 */
    size() {
      return queue.length
    }
  }
}

/**
 * 运行 Pi 同构双层智能体循环。
 *
 * @param {object} config
 * @param {Function} config.llmFn 必填。async ({ systemPrompt, messages, tools, signal })
 *   => { ok, content, toolCalls, finishReason, error? }（注入 callLlm 或测试 stub；
 *   messages 已是 convertToLlm 翻译后的 OpenAI 格式）
 * @param {string} [config.systemPrompt] 系统提示词
 * @param {Array<{name:string, description:string, parameters:object, execute:Function}>} [config.tools]
 *   工具定义列表（execute 为 async (args) => result）
 * @param {Array<object>} [config.initialMessages] 初始内部 AgentMessage 数组（拷贝使用，不污染入参）
 * @param {{drain:()=>Array}} [config.steerQueue] 中途纠偏队列（默认新建空队列）
 * @param {{drain:()=>Array}} [config.followUpQueue] 追问队列（默认新建空队列）
 * @param {Function} [config.shouldStopAfterTurn] async ({turn, messages}) => boolean，
 *   每回合结束后调用，true 则以 'user-stop' 终止（用户停止/安全熔断）
 * @param {AbortSignal} [config.signal] 外部中止信号
 * @param {Function} [config.emit] async (event) => {}，事件回调（见文件头事件清单）
 * @param {number} [config.maxTurns] 最大回合数兜底，默认 50
 * @param {Function} [config.onBeforeLlm] async (messages) => messages，每回合调 LLM 前
 *   调用，可修改/压缩消息数组（上下文压缩挂载点）；返回新数组替换内部 messages
 * @param {Function} [config.executeTool] async (tool, args) => result，工具执行器覆盖
 *   （默认直接调 tool.execute(args)），便于测试注入
 * @returns {Promise<{messages:Array<object>, turnCount:number,
 *   stopReason:'stop'|'max-turns'|'aborted'|'user-stop'|'error'}>}
 */
export async function runAgentLoop(config) {
  const {
    llmFn,
    systemPrompt = '',
    tools = [],
    initialMessages = [],
    steerQueue = createPendingMessageQueue(),
    followUpQueue = createPendingMessageQueue(),
    shouldStopAfterTurn = null,
    signal = null,
    emit = null,
    maxTurns = 50,
    onBeforeLlm = null,
    executeTool = null
  } = config || {}

  if (typeof llmFn !== 'function') {
    throw new Error('runAgentLoop 缺少必填的 llmFn（LLM 调用函数）')
  }

  // 拷贝初始消息：内部只操作副本，不污染调用方传入的数组
  let messages = Array.isArray(initialMessages) ? initialMessages.slice() : []

  // 工具名 → 工具对象索引（未知工具名快速判别）
  const toolMap = new Map(
    (Array.isArray(tools) ? tools : []).map((tool) => [tool?.name, tool])
  )

  let turn = 0 // 已完成回合数（回合开始时的 turn 即该回合的 0-based 索引）
  let stopReason = 'stop'

  // 事件转发：emit 未注入时静默跳过
  const emitEvent = async (event) => {
    if (typeof emit === 'function') await emit(event)
  }

  // 工具执行器：默认直接调 tool.execute；config.executeTool 可覆盖（测试注入）
  const runTool = async (tool, args) => {
    if (typeof executeTool === 'function') return await executeTool(tool, args)
    return await tool.execute(args)
  }

  await emitEvent({ type: 'agent_start' })

  outerLoop: while (true) {
    let hasMoreToolCalls = true
    while (hasMoreToolCalls) {
      // ① 每个内层回合开始：drain steer 队列，纠偏消息立即进入对话
      for (const steerMsg of steerQueue.drain()) {
        messages.push(steerMsg)
      }

      // ② 外部已中止：跳出全部循环
      if (signal?.aborted) {
        stopReason = 'aborted'
        break outerLoop
      }

      // ③ 调 LLM 前钩子：上下文压缩等可在此替换消息数组
      if (typeof onBeforeLlm === 'function') {
        const next = await onBeforeLlm(messages)
        if (Array.isArray(next)) messages = next
      }

      // ④ 回合开始事件（turn 为已完成回合数，即本回合 0-based 索引）
      await emitEvent({ type: 'turn_start', turn })

      // ⑤ 调 LLM：内部 AgentMessage 先经 convertToLlm 翻译为 OpenAI 格式
      const llmResp = await llmFn({
        systemPrompt,
        messages: convertToLlm(messages),
        tools,
        signal
      })

      // ⑥ LLM 调用失败：立即结束（错误原因随 agent_end 事件与返回值带出）
      if (!llmResp || llmResp.ok !== true) {
        // 用户停止（signal 已中止）时，在途请求的失败不应被当作"错误"——
        // 否则 UI 会显示"出现错误"而非"已中止"。
        if (signal?.aborted) {
          stopReason = 'aborted'
          await emitEvent({ type: 'agent_end', stopReason, turnCount: turn })
          return { messages, turnCount: turn, stopReason }
        }
        stopReason = 'error'
        const error = llmResp?.error ?? 'LLM 调用失败'
        await emitEvent({ type: 'agent_end', stopReason, error, turnCount: turn })
        return { messages, turnCount: turn, stopReason }
      }

      // ⑦ 组装 assistant 消息（本期非流式：一次性写出，无 message_update）
      const assistantMessage = createAssistantMessage({
        text: llmResp.content,
        toolCalls: llmResp.toolCalls
      })
      await emitEvent({ type: 'message_start', message: assistantMessage })
      messages.push(assistantMessage)
      await emitEvent({ type: 'message_end', message: assistantMessage })

      // ⑧ 工具调用：按 toolCalls 顺序串行执行
      const toolCalls = Array.isArray(llmResp.toolCalls) ? llmResp.toolCalls : []
      if (toolCalls.length === 0) {
        // 纯文本回复：内层循环自然结束（本任务回合完成）
        hasMoreToolCalls = false
      } else {
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall?.id ?? ''
          const toolName = toolCall?.name ?? ''
          const args = toolCall?.arguments ?? {}
          await emitEvent({ type: 'tool_execution_start', toolCallId, name: toolName, args })

          let isError = false
          let result = null
          const startMs = Date.now()
          try {
            const tool = toolMap.get(toolName)
            if (!tool) {
              // 未知工具名：记录错误结果，不中断循环
              isError = true
              result = { error: `工具 ${toolName} 不存在` }
            } else {
              result = await runTool(tool, args)
            }
          } catch (e) {
            // 工具执行异常：转成错误结果继续循环（单次工具失败 ≠ 智能体失败）
            isError = true
            result = { error: e?.message || String(e) }
          }
          const durationMs = Date.now() - startMs

          messages.push(
            createToolResultMessage({ toolCallId, toolName, result, isError })
          )
          await emitEvent({
            type: 'tool_execution_end',
            toolCallId,
            name: toolName,
            isError,
            durationMs
          })
        }
        hasMoreToolCalls = true
      }

      // ⑨ 回合计数 + 回合结束事件（turn 为当前已完成回合数）
      turn += 1
      await emitEvent({ type: 'turn_end', turn, toolCallCount: toolCalls.length })

      // ⑩ 终止判定：任一命中则跳出全部循环
      if (turn >= maxTurns) {
        stopReason = 'max-turns'
        break outerLoop
      }
      if (signal?.aborted) {
        stopReason = 'aborted'
        break outerLoop
      }
      if (
        typeof shouldStopAfterTurn === 'function' &&
        (await shouldStopAfterTurn({ turn, messages }))
      ) {
        stopReason = 'user-stop'
        break outerLoop
      }
    }

    // 内层结束（模型给出纯文本）：drain followUp 队列，有追问则重启外层
    const followUps = followUpQueue.drain()
    if (followUps.length > 0) {
      for (const followUpMsg of followUps) {
        messages.push(followUpMsg)
      }
      continue outerLoop
    }
    break
  }

  await emitEvent({ type: 'agent_end', stopReason, turnCount: turn })
  return { messages, turnCount: turn, stopReason }
}
