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
 * - 退出路径（纯文本收尾 / max-turns / shouldStopAfterTurn / aborted / LLM 失败）
 *   都会先排空队列：前三种若确有未消费消息，会重启一圈让模型处理，
 *   避免"UI 已显示纠偏、模型从未看到"（达标提示与 [安全机制] 通知同样走该队列）。
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
  /** 会话结束原因文本（仅 stopReason === 'error' 时非空） */
  let endError = ''
  /** agent_end 只允许发一次：早退与 finally 共用 emitEnd，避免 UI 收到两条结束事件 */
  let endEmitted = false
  /** 本会话累计 token 用量（各回合相加；服务端未返回 usage 时保持 0） */
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  // 强制终止（max-turns / shouldStop）为消费排队消息而额外重启的次数上限：
  // 每轮最多多跑一个回合，防止"安全通知持续产生 → 排空又可重启"的循环
  let forcedRestartUsed = false

  // 事件转发：emit 未注入时静默跳过；UI 回调抛错不应中断整局调参
  const emitEvent = async (event) => {
    if (typeof emit !== 'function') return
    try {
      await emit(event)
    } catch { /* 忽略 UI 侧异常 */ }
  }

  /** 发送 agent_end（幂等）：早退路径不要再单独 emit，统一走这里或 finally */
  const emitEnd = async () => {
    if (endEmitted) return
    endEmitted = true
    await emitEvent({
      type: 'agent_end',
      stopReason,
      turnCount: turn,
      usage: { ...usageTotal },
      ...(endError ? { error: endError } : {})
    })
  }

  // 工具执行器：默认直接调 tool.execute；config.executeTool 可覆盖（测试注入）
  const runTool = async (tool, args) => {
    if (typeof executeTool === 'function') return await executeTool(tool, args)
    return await tool.execute(args)
  }

  /**
   * 把排队的 steer / followUp 消息落进对话（一次排空两类队列）。
   * 只在退出路径调用：这些消息可能是在最后一轮 LLM 在途时入队的，
   * 若不在退出前 drain，UI 已展示而模型永远看不到（纠偏/达标提示/安全通知都会丢）。
   * @returns {number} 本次落进对话的消息条数
   */
  const flushPendingMessages = () => {
    const pending = [...steerQueue.drain(), ...followUpQueue.drain()]
    for (const message of pending) messages.push(message)
    return pending.length
  }

  await emitEvent({ type: 'agent_start' })

  try {
    outerLoop: while (true) {
      let hasMoreToolCalls = true
      while (hasMoreToolCalls) {
        // ① 每个内层回合开始：drain steer 队列，纠偏消息立即进入对话
        for (const steerMsg of steerQueue.drain()) {
          messages.push(steerMsg)
        }

        // ② 外部已中止：排空尚未消费的消息后跳出全部循环（会话已终止，不再重启）
        if (signal?.aborted) {
          stopReason = 'aborted'
          flushPendingMessages()
          break outerLoop
        }

        // ③ 调 LLM 前钩子：上下文压缩等可在此替换消息数组。
        //   压缩失败（摘要服务不可用等）只降级为"本轮不压缩"，不能中断调参。
        if (typeof onBeforeLlm === 'function') {
          try {
            const next = await onBeforeLlm(messages)
            if (Array.isArray(next)) messages = next
          } catch (error) {
            await emitEvent({ type: 'compaction_error', error: error?.message || String(error) })
          }
        }

        // ④ 回合开始事件（turn 为已完成回合数，即本回合 0-based 索引）
        await emitEvent({ type: 'turn_start', turn })

        // ⑤ 调 LLM：内部 AgentMessage 先经 convertToLlm 翻译为 OpenAI 格式
        let llmResp
        try {
          llmResp = await llmFn({
            systemPrompt,
            messages: convertToLlm(messages),
            tools,
            signal
          })
        } catch (error) {
          // llmFn 自身抛错（而非返回 ok:false）：转成失败结果，走统一的错误收尾
          llmResp = { ok: false, error: error?.message || String(error) }
        }

        // ⑥ LLM 调用失败：结束会话（错误原因随 agent_end 与返回值带出）
        if (!llmResp || llmResp.ok !== true) {
          // 用户停止（signal 已中止）时，在途请求的失败不应被当作"错误"——
          // 否则 UI 会显示"出现错误"而非"已中止"。
          if (signal?.aborted) {
            stopReason = 'aborted'
          } else {
            stopReason = 'error'
            endError = llmResp?.error ?? 'LLM 调用失败'
          }
          flushPendingMessages()
          break outerLoop
        }

        // 累计 token 用量（服务端返回 usage 时；缺失则保持 0）
        if (llmResp.usage) {
          usageTotal.prompt_tokens += Number(llmResp.usage.prompt_tokens) || 0
          usageTotal.completion_tokens += Number(llmResp.usage.completion_tokens) || 0
          usageTotal.total_tokens += Number(llmResp.usage.total_tokens) || 0
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

        // ⑩ 终止判定：命中后先排空队列——若确有未消费消息（中途纠偏/达标提示/安全通知），
        //   重启一圈让模型看到再收尾；下一圈队列已空，会真正退出（最多多一次 LLM 调用）。
        if (turn >= maxTurns) {
          stopReason = 'max-turns'
          if (flushPendingMessages() > 0 && !forcedRestartUsed) {
            forcedRestartUsed = true
            continue outerLoop
          }
          break outerLoop
        }
        if (signal?.aborted) {
          stopReason = 'aborted'
          flushPendingMessages()
          break outerLoop
        }
        // shouldStopAfterTurn 支持两种返回：
        //   true（或 falsy）→ 沿用 'user-stop'（用户停止/安全熔断）
        //   { stop: true, reason?: 'stop' | ... } → 使用 reason（默认 'stop'），
        //   供编排层"达标自动收敛"以正常结束呈现（UI 不显示"用户停止"）
        if (typeof shouldStopAfterTurn === 'function') {
          let stopDecision = false
          try {
            stopDecision = await shouldStopAfterTurn({ turn, messages })
          } catch (error) {
            // 终止判定本身出错：按错误收尾，避免带着未知状态继续调参
            stopReason = 'error'
            endError = error?.message || String(error)
            flushPendingMessages()
            break outerLoop
          }
          if (stopDecision === true || (stopDecision && stopDecision.stop)) {
            stopReason = (stopDecision && typeof stopDecision.reason === 'string')
              ? stopDecision.reason
              : 'user-stop'
            if (flushPendingMessages() > 0 && !forcedRestartUsed) {
              forcedRestartUsed = true
              continue outerLoop
            }
            break outerLoop
          }
        }
      }

      // 内层结束（模型给出纯文本）：排空 steer + followUp，有消息则重启外层
      if (flushPendingMessages() > 0) continue outerLoop
      break
    }
  } catch (error) {
    // 兜底：任何未预期异常都不能让会话"无声结束"——统一以 error 收尾并保留已产生的消息
    stopReason = signal?.aborted ? 'aborted' : 'error'
    if (stopReason === 'error') endError = error?.message || String(error)
    flushPendingMessages()
  } finally {
    await emitEnd()
  }

  return {
    messages,
    turnCount: turn,
    stopReason,
    usage: { ...usageTotal },
    ...(endError ? { error: endError } : {})
  }
}
