/**
 * PID 调参智能体 —— Vue composable 编排层。
 *
 * 职责：把 services/pidAgent 下的纯 JS 模块（agentLoop / tools / safety /
 * compaction / llm / systemPrompt / dataBuffer / types）与仿真服务
 * （pidSimulation.simulatePidStrategy）编排成一个可被面板组件直接使用的
 * 响应式状态 + 方法集合。本层不渲染任何 UI，也不直接依赖
 * window.electronAPI（串口下发经注入的 onSerialSend 回调完成）。
 *
 * 注入依赖（调用时返回当前值 / 执行回调）：
 *   - getAiConfig()               → { baseUrl, model, apiKey }
 *   - getConnected()              → boolean（串口连接状态）
 *   - onSimulationData(samples)   → 上抛仿真样本给 App（显示波形）
 *   - onSerialSend(cmd)           → 串口下发（由面板封装 window.electronAPI）
 *
 * 消息流元素结构（messages.value 数组元素）：
 *   { id, kind: 'user'|'steerUser'|'assistant'|'tool'|'safety'|'compact',
 *     text, toolName, toolCallId, toolStatus: 'running'|'done'|'error',
 *     durationMs, shownLen }
 *   assistant 消息 shownLen 初始为 0（打字机动画由面板负责推进），
 *   其余消息 shownLen = text.length（直接全量展示）。
 */
import { ref, reactive, computed, watch } from 'vue'
import { createUserMessage, validateUserConfig } from '../services/pidAgent/types.mjs'
import { createDataBuffer } from '../services/pidAgent/dataBuffer.mjs'
import { callLlm } from '../services/pidAgent/llm.mjs'
import { buildSystemPrompt } from '../services/pidAgent/systemPrompt.mjs'
import { createPidAgentTools } from '../services/pidAgent/tools/index.mjs'
import { runAgentLoop, createPendingMessageQueue } from '../services/pidAgent/agentLoop.mjs'
import { createSafetyGuard } from '../services/pidAgent/safety.mjs'
import { measureDataBytes, compactIfNeeded } from '../services/pidAgent/compaction.mjs'
import { scoreMetrics } from '../services/pidSafety.mjs'
import { PID_STRATEGIES, simulatePidStrategy } from '../services/pidSimulation.mjs'
import {
  readCanonicalPid,
  applyCanonicalPid,
  buildSimOverrides,
  buildPidCommand,
  createSerialStepCollector
} from '../services/pidAgent/utils.mjs'

// 上下文压缩阈值（数据查询类 toolResult 的字节总量超过该值触发压缩）
const COMPACT_THRESHOLD_BYTES = 50 * 1024

// 串口阶跃安全检测窗口时长（秒）：set_target 下发后，自响应首帧计时，
// 攒满该时长即自动对窗口内样本做安全检测。
// 取 12s：实测设备 set_point 为斜坡（0→50 约 8-10s 才到稳态），5s 窗口内系统
// 尚未收敛，指标全失真（SLOW_RESPONSE / 包络虚高）；留裕量覆盖斜坡 + 稳态段。
const SERIAL_STEP_WINDOW_SEC = 12

/**
 * 组装仿真模型物理特性摘要（供 buildSystemPrompt 的 modelSpec 段渲染）。
 * 仅仿真模式提供（策略 defaults 来自 PID_STRATEGIES）；串口模式返回 null，
 * 模型按实测数据说话、不做未知猜测。
 */
function buildModelSpec(strategyId, testMode) {
  if (testMode !== 'simulation') return null
  const strategy = PID_STRATEGIES[strategyId]
  const defaults = strategy?.defaults
  if (!defaults) return null
  const j = Number(defaults.J)
  const b = Number(defaults.B)
  const tau = j > 0 && b > 0 ? Number((j / b).toFixed(2)) : undefined
  const acceptance = strategy.acceptance
  // 宽松取有限数字（缺省返回 undefined，提示词层据此跳过渲染）
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)
  return {
    name: strategy.name,
    description: strategy.description,
    // 仿真教学模式：无 PID 输出限幅（输出幅值由增益与误差决定）
    outputLimits: 'none',
    // 目标物理范围（仿真按策略 targetRange，倒立摆为小角度线性区 ±0.18 rad≈±10°；
    // 串口模式无策略概念，回退用户安全范围）
    targetRange: strategy.targetRange,
    // 不稳定系统标记（倒立摆：纯 P 等幅振荡不收敛，需 Kd 阻尼）
    unstable: strategy.unstable === true,
    // 策略验收线（仿真模式达标判断参照：userConfig 的 overshoot/oscillation 同源）
    acceptance: acceptance && {
      overshootLimit: num(acceptance.overshootLimit),
      riseTimeLimit: num(acceptance.riseTimeLimit),
      settlingTimeLimit: num(acceptance.settlingTimeLimit),
      oscillationLimit: num(acceptance.oscillationLimit),
      settlingBandPercent: num(acceptance.settlingBand) !== undefined
        ? Number(acceptance.settlingBand) * 100
        : undefined
    },
    duration: defaults.duration,
    dt: defaults.dt,
    noise: defaults.noise,
    tau
  }
}

/**
 * 创建 PID 调参智能体编排实例。
 * @param {object} injections 面板注入的四个回调（见文件头注释）
 * @returns 编排层接口（配置状态 / 运行状态 / 方法），见文件头与下方 return
 */
export function usePidAgent({ getAiConfig, getConnected, onSimulationData, onSerialSend } = {}) {
  // ---------------- 配置状态（面板表单直接绑定） ----------------

  /** 仿真策略 id（PID_STRATEGIES 键） */
  const strategyId = ref('motor_speed')
  const enableStrategyTools = ref(true)
  /** 策略下拉选项 [{ id, name }] */
  const strategyOptions = Object.values(PID_STRATEGIES).map((strategy) => ({
    id: strategy.id,
    name: strategy.name
  }))

  /**
   * PID 参数定义表（面板按此渲染表单，工具按此校验参数键与范围）。
   * 默认为单环三项；策略切换时按策略默认参数重建（串级展开为位置环 + 速度环六项）。
   */
  const pidConfig = reactive([
    { key: 'kp', label: 'Kp', init: 1.0, min: 0, max: 20 },
    { key: 'ki', label: 'Ki', init: 0, min: 0, max: 10 },
    { key: 'kd', label: 'Kd', init: 0, min: 0, max: 10 }
  ])

  /** 信号安全范围（control 为控制量/输出，feedback 为反馈量，target 为目标量） */
  const safetyRange = reactive({
    control: { min: -100, max: 100 },
    feedback: { min: 0, max: 120 },
    target: { min: 0, max: 100 }
  })

  /** 前馈项定义表 [{ id, label, init, min, max }] */
  const feedforwardItems = reactive([])

  /** 场景描述提示词（串口模式必填；仿真模式可空，启动时自动按策略说明补齐） */
  const scenePrompt = ref('')

  /** 调参测试模式：'simulation' 仿真 | 'serial' 串口实机 */
  const testMode = ref('simulation')

  /** 调参策略（自由文本，仅串口模式使用；仿真模式由 LLM 自主决策） */
  const tuningStrategy = ref('')
  /** 串口模式参数结构：'single' 单环 kp/ki/kd | 'cascade' 位置-速度串级六参 */
  const pidStructure = ref('single')

  /** 追加前馈项（id 重复时忽略；缺省字段按兜底值补齐） */
  function addFeedforwardItem(item) {
    if (!item || !item.id) return
    if (feedforwardItems.some((existing) => existing.id === item.id)) return
    feedforwardItems.push({
      id: String(item.id),
      label: String(item.label ?? item.id),
      init: Number(item.init) || 0,
      min: Number.isFinite(Number(item.min)) ? Number(item.min) : 0,
      max: Number.isFinite(Number(item.max)) ? Number(item.max) : 10
    })
  }

  /** 移除前馈项（同步清理 currentFf 中的系数） */
  function removeFeedforwardItem(id) {
    const index = feedforwardItems.findIndex((item) => item.id === id)
    if (index >= 0) feedforwardItems.splice(index, 1)
    if (id in currentFf) delete currentFf[id]
  }

  // ---------------- 运行状态（面板展示用） ----------------

  /** 显示用消息流（元素结构见文件头注释） */
  const messages = ref([])
  /** 智能体是否运行中 */
  const running = ref(false)
  /** 已完成回合数 */
  const turnCount = ref(0)
  /** 数据上下文占用量（KB，数据查询类 toolResult 统计） */
  const ctxBytes = ref(0)
  /** 会话终止原因：'' | 'stop' | 'max-turns' | 'aborted' | 'user-stop' | 'error' */
  const stopReason = ref('')

  /**
   * 当前下发中的 PID 参数（合并形态：串级下 kp/ki/kd 即位置环参数）。
   * 注意：applyCanonicalPid 写回的是字符串（沿用旧 PidPanel 的表单值习惯），
   * 读取统一经 readCanonicalPid 转为数字。
   */
  const currentPid = reactive({ kp: 1, ki: 0, kd: 0, speedKp: 1, speedKi: 0, speedKd: 0 })
  /** 当前前馈系数 { id: coeff } */
  const currentFf = reactive({})
  /** 当前目标值 */
  const currentTarget = ref(0)
  /** 参数变化高亮时间戳（key → 最近一次变化的 Date.now()，面板据此做高亮动画） */
  const paramHighlight = reactive({})

  // ---------------- 编排层内部状态（会话级闭包变量，startAgent 时重置） ----------------

  /** 通道数据缓冲（串口采样流与仿真阶跃样本统一写入） */
  let dataBuffer = createDataBuffer()
  /** 会话时钟（秒，仿真模式：每次阶跃仿真后推进；串口数据时间轴独立换算） */
  let sessionClock = 0
  /** 串口模式数据时间轴起点（首帧样本时间戳，null 表示尚未收到数据） */
  let serialStartTime = null
  /** 中途纠偏队列（安全护栏消息也走这里） */
  let steerQueue = createPendingMessageQueue()
  /** 追问队列（内层循环结束后由外层循环 drain） */
  let followUpQueue = createPendingMessageQueue()
  /** 中止控制器（stopAgent 调用 abort） */
  let abortController = null
  /** 安全护栏实例（startAgent 时重建，bestStable 随之重置） */
  let safetyGuard = null
  /** 串口阶跃窗口采集器（startAgent 时重建）：set_target(serial) 触发、数据流入收样、窗口满自动安全检测 */
  let serialCollector = null
  /** UI 消息自增序号（与 Date.now 组合保证 id 唯一） */
  let uiMessageSeq = 0

  // ------ 达标自动收敛状态（会话级，startAgent 重置） ------
  /** 是否已注入过"达标收敛"提示（一次会话只提示一次） */
  let acceptanceNotified = false
  /** 达标后"持续无改善"的轮数（≥2 则主循环自动正常结束） */
  let stagnantTurns = 0
  /** 达标时的 scoreMetrics 基线（后续轮次对照是否确有改善） */
  let lastScore = null
  /** 达标自动收敛的最小调参轮次：前 MIN_ACCEPTANCE_TURN 轮只观察/整定，不判定达标、不自动结束
   *  （防止 set_target 首轮即达标导致 agent 过早总结，剥夺完整调参过程） */
  const MIN_ACCEPTANCE_TURN = 5

  const nextUiMessageId = () => {
    uiMessageSeq += 1
    return `ui-${uiMessageSeq}-${Date.now()}`
  }

  /** 按 pidConfig 定义表读取某键的 init 值（缺省回退 fallback） */
  const readInit = (key, fallback = 0) => {
    const entry = pidConfig.find((item) => item?.key === key)
    const value = Number(entry?.init)
    return Number.isFinite(value) ? value : fallback
  }

  /**
   * 重置运行期参数：currentPid 按 pidConfig 的 init 初始化
   * （串级下 kp/ki/kd ← position* 条目 init，speed* 同步对应 init；
   * 单环下 speed* 回退同步 kp/ki/kd 的 init），currentFf 按前馈项 init，目标归零。
   */
  function resetRuntimeParams() {
    currentPid.kp = readInit('kp', readInit('positionKp', 1))
    currentPid.ki = readInit('ki', readInit('positionKi', 0))
    currentPid.kd = readInit('kd', readInit('positionKd', 0))
    currentPid.speedKp = readInit('speedKp', currentPid.kp)
    currentPid.speedKi = readInit('speedKi', currentPid.ki)
    currentPid.speedKd = readInit('speedKd', currentPid.kd)
    Object.keys(currentFf).forEach((id) => delete currentFf[id])
    feedforwardItems.forEach((item) => {
      if (item?.id) currentFf[item.id] = Number(item.init) || 0
    })
    currentTarget.value = 0
  }

  /**
   * 按 PID 参数结构重建 pidConfig 定义表：
   * 'single' → kp/ki/kd 三项；'cascade' → 位置环 + 速度环六项
   * （键名与 set_pid_params 工具 schema 的 position 环 / speed 环键一一对应）。
   * defaults 提供初始值（缺省键按兜底默认值，兼容串口模式无策略 defaults 的场景）。
   */
  function applyPidStructureConfig(structure, defaults = {}) {
    if (structure === 'cascade') {
      pidConfig.splice(
        0,
        pidConfig.length,
        { key: 'positionKp', label: '位置环Kp', init: defaults.positionKp ?? 3, min: 0, max: 20 },
        { key: 'positionKi', label: '位置环Ki', init: defaults.positionKi ?? 0, min: 0, max: 10 },
        { key: 'positionKd', label: '位置环Kd', init: defaults.positionKd ?? 0, min: 0, max: 10 },
        { key: 'speedKp', label: '速度环Kp', init: defaults.speedKp ?? 1, min: 0, max: 20 },
        { key: 'speedKi', label: '速度环Ki', init: defaults.speedKi ?? 0, min: 0, max: 10 },
        { key: 'speedKd', label: '速度环Kd', init: defaults.speedKd ?? 0, min: 0, max: 10 }
      )
      return
    }
    pidConfig.splice(
      0,
      pidConfig.length,
      { key: 'kp', label: 'Kp', init: defaults.kp ?? 1, min: 0, max: 20 },
      { key: 'ki', label: 'Ki', init: defaults.ki ?? 0, min: 0, max: 10 },
      { key: 'kd', label: 'Kd', init: defaults.kd ?? 0, min: 0, max: 10 }
    )
  }

  /**
   * 仿真策略切换：按策略默认参数建键集（cascade_position → 串级六参，其余单环三键），
   * 初始值取该策略 defaults；行为与原实现一致。
   */
  function applyStrategyPidConfig(id) {
    const strategy = PID_STRATEGIES[id] ?? PID_STRATEGIES.motor_speed
    applyPidStructureConfig(id === 'cascade_position' ? 'cascade' : 'single', strategy.defaults)
  }

  // 策略切换：重建参数定义表（下一次会话生效）；运行中不重置 currentPid（避免破坏当前会话）
  watch(strategyId, (id) => {
    applyStrategyPidConfig(id)
    if (!running.value) resetRuntimeParams()
  })

  // 串口模式 PID 结构切换：同样重建参数定义表（仿真策略选择与串口结构互不影响）
  watch(pidStructure, (structure) => {
    applyPidStructureConfig(structure)
    if (!running.value) resetRuntimeParams()
  })

  /** 串级判定：按模式取值——仿真看策略 id，串口看 PID 结构 */
  const effectiveCascade = computed(() =>
    testMode.value === 'serial'
      ? pidStructure.value === 'cascade'
      : strategyId.value === 'cascade_position'
  )

  // ---------------- 智能体事件 → UI 消息流 / 运行状态同步 ----------------

  /**
   * 事件回调（同时传给 runAgentLoop / compactIfNeeded / safetyGuard）。
   * 注意：safety_triggered 不在这里推 UI 消息（onSamplesCollected 统一推送，避免重复）。
   */
  const emit = async (event) => {
    if (!event || typeof event !== 'object') return
    switch (event.type) {
      case 'message_end': {
        // assistant 消息完成：有可见文本才推（纯工具调用轮不推消息）
        const text = typeof event.message?.content === 'string' ? event.message.content : ''
        if (text.trim()) {
          messages.value.push({
            id: nextUiMessageId(),
            kind: 'assistant',
            text,
            toolName: null,
            toolStatus: null,
            durationMs: null,
            shownLen: 0 // 打字机动画由面板负责推进
          })
        }
        break
      }
      case 'tool_execution_start': {
        const toolName = String(event.name ?? '')
        const text = `${toolName} ${JSON.stringify(event.args ?? {})}`
        messages.value.push({
          id: nextUiMessageId(),
          kind: 'tool',
          text,
          toolName,
          toolCallId: String(event.toolCallId ?? ''),
          toolStatus: 'running',
          durationMs: null,
          shownLen: text.length
        })
        break
      }
      case 'tool_execution_end': {
        // 优先按 toolCallId 精确匹配，兜底从后往前找同名且仍在 running 的工具消息
        let target = null
        if (event.toolCallId) {
          target =
            messages.value.find(
              (m) => m.kind === 'tool' && m.toolCallId === event.toolCallId
            ) ?? null
        }
        if (!target) {
          for (let i = messages.value.length - 1; i >= 0; i -= 1) {
            const m = messages.value[i]
            if (m.kind === 'tool' && m.toolName === event.name && m.toolStatus === 'running') {
              target = m
              break
            }
          }
        }
        if (target) {
          target.toolStatus = event.isError ? 'error' : 'done'
          target.durationMs = Number(event.durationMs) || 0
        }
        break
      }
      case 'turn_end':
        turnCount.value = Number(event.turn) || 0
        break
      case 'compaction_applied': {
        const text =
          `已压缩历史数据：${(event.beforeBytes / 1024).toFixed(1)}KB → ` +
          `${(event.afterBytes / 1024).toFixed(1)}KB`
        messages.value.push({
          id: nextUiMessageId(),
          kind: 'compact',
          text,
          toolName: null,
          toolStatus: null,
          durationMs: null,
          beforeBytes: event.beforeBytes,
          afterBytes: event.afterBytes,
          shownLen: text.length
        })
        break
      }
      case 'agent_end': {
        stopReason.value = String(event.stopReason ?? '')
        // 失败要进聊天流：此前仅更新顶部状态行，LLM 失败时对话区毫无反馈，
        // 用户看到的就是"发完任务卡住不动"。这里补一条醒目的错误消息。
        if (event.stopReason === 'error') {
          const text = `调参已中止：${event.error || 'LLM 调用失败'}`
          messages.value.push({
            id: nextUiMessageId(),
            kind: 'error',
            text,
            toolName: null,
            toolStatus: null,
            durationMs: null,
            shownLen: text.length
          })
        }
        break
      }
      default:
        break
    }
  }

  // ---------------- 上下文压缩（独立摘要 LLM 请求） ----------------

  /** 摘要函数：把历史数据块 dump 文本压缩为紧凑摘要（失败抛错，由 compactIfNeeded 捕获） */
  const summarizeFn = async (dump) => {
    const result = await callLlm({
      aiConfig: getAiConfig?.() ?? null,
      systemPrompt:
        '你是控制数据压缩助手。把输入的历史调参数据总结为紧凑摘要，' +
        '保留：各时间段关键指标（超调/稳态误差/RMSE）、参数变更序列、异常特征。直接输出摘要正文。',
      messages: [{ role: 'user', content: dump }],
      tools: []
    })
    if (!result.ok) throw new Error(result.error)
    return result.content
  }

  /** 每回合调 LLM 前的压缩钩子：更新 ctxBytes，超阈值时压缩历史数据块 */
  const onBeforeLlm = async (msgs) => {
    ctxBytes.value = measureDataBytes(msgs) / 1024
    if (ctxBytes.value < COMPACT_THRESHOLD_BYTES / 1024) return msgs
    const result = await compactIfNeeded({
      messages: msgs,
      thresholdBytes: COMPACT_THRESHOLD_BYTES,
      summarizeFn,
      retainedTail: 3,
      emit
    })
    ctxBytes.value = result.afterBytes / 1024
    return result.messages
  }

  // ---------------- 启动智能体 ----------------

  /**
   * 启动一次调参会话（校验配置 → 重置会话状态 → 组装 controller 与工具 → 运行主循环）。
   * @param {string} taskText 调参任务描述（作为首条用户消息）
   * @returns {Promise<{messages:Array, turnCount:number, stopReason:string}>}
   * @throws 配置校验失败 / 串口未连接 / 任务描述为空时抛错（面板捕获后提示）
   */
  async function startAgent(taskText) {
    const text = String(taskText ?? '').trim()
    if (!text) throw new Error('任务描述不能为空')
    if (running.value) return

    // 串口模式需要已连接设备（仿真模式不检查）
    if (testMode.value === 'serial' && typeof getConnected === 'function' && !getConnected()) {
      throw new Error('串口模式下请先连接设备，再启动调参智能体')
    }

    // 串口模式调参策略必填（自由文本：指导 LLM 如何整定实机）
    if (testMode.value === 'serial' && !tuningStrategy.value.trim()) {
      throw new Error('串口模式请先填写调参策略（如：分阶段 P→PI→PID，先压超调再降稳态误差）')
    }

    // 会话启动前强制同步参数键集（applyStrategyPidConfig / applyPidStructureConfig 由 watch
    // 异步触发，可能晚于本函数执行——若沿用旧键集，串级模式下 set_pid_params 会用错参数键
    // （kp 键静默无效或直接被判"未提供任何参数"）。此处显式同步，保证 userConfig.pid 与
    // 当前键集（串口按结构 position*/speed* 或 kp/ki/kd；仿真按策略）一致；
    // currentPid 由下方 resetRuntimeParams 初始化。
    if (testMode.value === 'serial') applyPidStructureConfig(pidStructure.value)
    else applyStrategyPidConfig(strategyId.value)

    // 仿真模式场景描述自动补齐：策略自带物理模型说明，无需用户输入；
    // 已填内容优先，否则按所选策略拼接默认场景（校验因此不会因空场景报错）
    const resolvedScene = (() => {
      const manual = scenePrompt.value.trim()
      if (testMode.value !== 'simulation') return manual
      if (manual) return manual
      const strategy = PID_STRATEGIES[strategyId.value] ?? PID_STRATEGIES.motor_speed
      return `${strategy.name}（${strategy.description}）。调参目标：驱动响应在参数与信号安全范围内达成稳定、低超调。`
    })()

    // 验收线：串口模式保持通用 20%/10%（不动实机验收行为）；
    // 仿真模式按所选策略 acceptance 注入（cascade=15/8，motor=10/10，pendulum=25/12），
    // 使 agent 的达标判断与仿真模型验收一致（此前硬编码 20/10 与策略验收线脱节）。
    const serialAcceptance = { overshootLimit: 20, oscillationLimit: 10 }
    const strategyAcceptance = PID_STRATEGIES[strategyId.value]?.acceptance ?? {}
    const acceptance = testMode.value === 'serial'
      ? serialAcceptance
      : {
          overshootLimit: Number.isFinite(Number(strategyAcceptance.overshootLimit))
            ? Number(strategyAcceptance.overshootLimit)
            : serialAcceptance.overshootLimit,
          oscillationLimit: Number.isFinite(Number(strategyAcceptance.oscillationLimit))
            ? Number(strategyAcceptance.oscillationLimit)
            : serialAcceptance.oscillationLimit
        }

    // ① 组装 userConfig（buildSystemPrompt 契约形态：pidParams / safetyRange / feedforwardItems）
    //    深拷贝并做字段适配：定义表 {key,label,init} → 提示词 {name,initial,min,max}
    const userConfig = {
      pidParams: pidConfig.map((item) => ({
        name: item.label ?? item.key,
        initial: Number(item.init),
        min: Number(item.min),
        max: Number(item.max)
      })),
      safetyRange: {
        control: [safetyRange.control.min, safetyRange.control.max],
        feedback: [safetyRange.feedback.min, safetyRange.feedback.max],
        target: [safetyRange.target.min, safetyRange.target.max]
      },
      feedforwardItems: feedforwardItems.map((item) => ({
        name: item.label ?? item.id,
        initial: Number(item.init),
        min: Number(item.min),
        max: Number(item.max)
      })),
      scenePrompt: resolvedScene,
      // 串口模式调参策略（自由文本）注入，仿真模式不提供
      tuningStrategy: testMode.value === 'serial' ? tuningStrategy.value.trim() : '',
      overshootLimit: acceptance.overshootLimit,
      oscillationLimit: acceptance.oscillationLimit,
      // 运行模式（systemPrompt 渲染串口模式专属引导用）
      mode: testMode.value,
      // 仿真模式注入模型物理特性（串口模式不提供，模型按实测数据说话）
      modelSpec: buildModelSpec(strategyId.value, testMode.value)
    }

    // ② validateUserConfig 兼容校验（types.mjs 基于 {pid, safety, feedforward, scenePrompt} 结构，做适配转换）
    const check = validateUserConfig({
      pid: pidConfig.map((item) => ({ ...item })),
      safety: {
        output: { min: safetyRange.control.min, max: safetyRange.control.max },
        feedback: { min: safetyRange.feedback.min, max: safetyRange.feedback.max },
        target: { min: safetyRange.target.min, max: safetyRange.target.max }
      },
      feedforward: feedforwardItems.map((item) => ({ ...item })),
      scenePrompt: resolvedScene
    })
    if (!check.ok) {
      throw new Error(`${check.reason}：${check.missing.join(',')}`)
    }

    // ③ 初始化会话状态（缓冲 / 时钟 / 消息流 / 计数全部重置）
    // 缓冲携带验收线（limits 与提示词/护栏同源，避免 agent 看到"两条线"）
    dataBuffer = createDataBuffer({
      acceptance: { overshootLimit: acceptance.overshootLimit, oscillationLimit: acceptance.oscillationLimit }
    })
    sessionClock = 0
    serialStartTime = null
    messages.value = []
    turnCount.value = 0
    ctxBytes.value = 0
    stopReason.value = ''
    Object.keys(paramHighlight).forEach((key) => delete paramHighlight[key])
    // 达标收敛状态重置（新会话从零开始）
    acceptanceNotified = false
    stagnantTurns = 0
    lastScore = null

    // 内部用户配置（types.mjs 的 UserConfig 形态：工具集与安全护栏使用）
    const internalUserConfig = {
      pid: pidConfig.map((item) => ({ ...item })),
      safety: {
        output: { min: safetyRange.control.min, max: safetyRange.control.max },
        feedback: { min: safetyRange.feedback.min, max: safetyRange.feedback.max },
        target: { min: safetyRange.target.min, max: safetyRange.target.max }
      },
      feedforward: feedforwardItems.map((item) => ({ ...item })),
      scenePrompt: resolvedScene,
      acceptance: { overshootLimit: acceptance.overshootLimit, oscillationLimit: acceptance.oscillationLimit }
    }

    // ④ 当前参数初始化
    resetRuntimeParams()

    // ⑤ 队列与中止控制器
    steerQueue = createPendingMessageQueue()
    followUpQueue = createPendingMessageQueue()
    abortController = new AbortController()

    // ⑥ controller 实现（createPidAgentTools 的运行时环境契约）

    /** 当前参数快照（规范形态：单环三键 / 串级六键，值均为数字；串级判定动态读取当前策略） */
    const getPidSnapshot = () => readCanonicalPid({ ...currentPid }, effectiveCascade.value)

    /** 写回参数（合并形态 + 变化高亮；applyCanonicalPid 沿用旧实现，写回字符串值） */
    const setPidHandler = (newPid) => {
      if (!newPid || typeof newPid !== 'object') return
      const before = { ...currentPid }
      applyCanonicalPid(currentPid, newPid, effectiveCascade.value)
      // 参数变化高亮：与快照比对，变化的键打时间戳
      Object.keys(currentPid).forEach((key) => {
        if (Number(currentPid[key]) !== Number(before[key])) {
          paramHighlight[key] = Date.now()
        }
      })
    }

    /** 安全护栏（bestStable 随重建重置；emit 走统一事件处理，safety_triggered 不重复推消息）。
     *  mode 双策略：仿真全量回退；串口仅硬越限回退（劣化误触发实测会毁掉整局调参） */
    safetyGuard = createSafetyGuard({
      userConfig: internalUserConfig,
      getPid: getPidSnapshot,
      setPid: setPidHandler,
      emit,
      mode: testMode.value
    })

    /**
     * 样本采集完成后的统一安全检测入口（仿真模式 set_target 与串口窗口完成共用）：
     * 触发安全兜底时把护栏消息推入 steer 队列并显示到消息流（emit 事件里不重复推）。
     */
    const notifySamplesCollected = (samples) => {
      if (!safetyGuard) return { triggered: false, bestUpdated: false, metrics: null }
      const result = safetyGuard.onSamplesCollected(samples)
      if (result && result.triggered) {
        steerQueue.push(createUserMessage(result.message, 'safety'))
        messages.value.push({
          id: nextUiMessageId(),
          kind: 'safety',
          text: result.message,
          toolName: null,
          toolStatus: null,
          durationMs: null,
          shownLen: result.message.length
        })
        // 串口模式：回退参数必须同步下发设备——护栏 setPid 只写上位机内存，
        // 若不下发，设备仍跑越限参数，上位机/设备参数分裂（回退形同虚设）。
        if (result.rollbackPid && testMode.value === 'serial') {
          const cmd = buildPidCommand(result.rollbackPid, {
            isCascade: effectiveCascade.value
          })
          Promise.resolve(onSerialSend?.(cmd)).catch(() => {
            // 下发失败静默：串口错误已有 serial:error 通道上报，不阻塞安全流程
          })
        }
      }
      return result
    }

    // 串口阶跃窗口采集器：set_target(serial) 经 controller.onStepTriggered 触发开启，
    // onSerialData 流入期间按窗口收样，窗口满后自动对窗口样本做安全检测（即通知 LLM 与 UI）
    serialCollector = createSerialStepCollector({
      windowSec: SERIAL_STEP_WINDOW_SEC,
      onWindowComplete: (state) => notifySamplesCollected(state.samples)
    })

    const controller = {
      isStopped: () => abortController?.signal.aborted === true,
      getPid: getPidSnapshot,
      setPid: setPidHandler,
      getFeedforward: () => ({ ...currentFf }),
      setFeedforward: (newFf) => {
        Object.entries(newFf ?? {}).forEach(([id, value]) => {
          if (Number.isFinite(Number(value))) currentFf[id] = Number(value)
        })
      },
      getTarget: () => currentTarget.value,
      setTarget: (value) => {
        currentTarget.value = Number(value)
      },
      getMode: () => testMode.value,
      // 目标物理范围：仿真按策略 targetRange（倒立摆小角度线性区），串口回退用户安全范围
      getTargetRange: () => {
        if (testMode.value !== 'simulation') {
          return { min: safetyRange.target.min, max: safetyRange.target.max }
        }
        const strategy = PID_STRATEGIES[strategyId.value]
        return strategy?.targetRange ?? { min: safetyRange.target.min, max: safetyRange.target.max }
      },
      // 阶跃仿真：用当前参数/前馈/目标组装 overrides 后跑一次仿真，样本上抛面板显示波形
      runSimulation: async () => {
        const overrides = buildSimOverrides({
          strategyId: strategyId.value,
          pid: getPidSnapshot(),
          feedforward: { ...currentFf },
          target: currentTarget.value,
          baseConfig: {}
        })
        const result = simulatePidStrategy(strategyId.value, overrides)
        const samples = result.samples
        // 发散截断标记随样本数组传播（数组可挂属性，tools set_target 读取后提示 agent）
        samples.truncated = result.truncated === true
        if (result.truncated) samples.truncateReason = result.truncateReason
        onSimulationData?.(samples)
        return result.samples
      },
      sendSerialCommand: async (cmd) => {
        await onSerialSend?.(cmd)
      },
      getSessionClock: () => sessionClock,
      advanceSessionClock: (seconds) => {
        sessionClock += Number(seconds) || 0
      },
      getDataBuffer: () => dataBuffer,
      getUserConfig: () => internalUserConfig,
      // 当前已完成调参轮次（工具层/编排层判定"达标"的门槛依据）
      getTurnCount: () => turnCount.value,
      // 串口阶跃采集窗口时长（set_target 串口分支组装 suggestedQuery 用）
      getStepWindowSec: () => SERIAL_STEP_WINDOW_SEC,
      // 样本采集完成后的安全检测（仿真模式 set_target 调用；串口模式由窗口采集器完成回调驱动）
      onSamplesCollected: notifySamplesCollected,
      // 串口阶跃已下发：开启/重置窗口采集（真实数据流入 onSerialData 后在此窗口内收样）
      onStepTriggered: () => {
        serialCollector?.trigger()
      },
      /**
       * 达标收敛（get_channel_stats 返回 acceptanceCheck.passed=true 时由工具层调用）：
       * 首次注入"已满足验收线"收敛提示；之后记录停滞轮数（无改善累计），
       * 由 runAgentLoop 的 shouldStopAfterTurn 在停滞 ≥2 轮时以 'stop' 正常结束。
       */
      onAcceptancePassed: (statsResult) => {
        const sm = statsResult?.stepMetrics
        if (!sm || !running.value) return
        // 前 MIN_ACCEPTANCE_TURN 轮为观察/整定期：首轮即达标不视为"已完成任务"，
        // 不注入收敛提示、不启动停滞计数（防止 set_target 首轮达标就过早总结）
        if (turnCount.value < MIN_ACCEPTANCE_TURN) return
        const score = Number.isFinite(Number(sm.rmse)) ? scoreMetrics(sm) : null
        if (!acceptanceNotified) {
          acceptanceNotified = true
          lastScore = score
          stagnantTurns = 0
          const limits = sm.limits ?? {}
          const text =
            `✅ 当前参数已满足全部验收线：超调 ${sm.overshoot}% ≤ ${limits.overshoot}%、` +
            `振荡 ${sm.oscillation} ≤ ${limits.oscillation}、已收敛（converged）、` +
            `稳态误差 |${sm.steadyError}| ≤ 5% 阶跃幅值。` +
            `调参目标已达成：请输出最终调参结论（含最终参数与指标表）并结束本轮调参；除非用户明确要求继续优化。`
          steerQueue.push(createUserMessage(text, 'steer'))
          messages.value.push({
            id: nextUiMessageId(),
            kind: 'steerUser',
            text,
            toolName: null,
            toolStatus: null,
            durationMs: null,
            shownLen: text.length
          })
          return
        }
        // 已提示过：仅更新停滞计数（确有改善则刷新基线）
        if (Number.isFinite(score) && Number.isFinite(lastScore) && score < lastScore - 0.05) {
          lastScore = score
          stagnantTurns = 0
        } else {
          stagnantTurns += 1
        }
      }
    }

    const tools = createPidAgentTools({ controller, enableStrategies: enableStrategyTools.value })

    // ⑦ 动态系统提示词
    const systemPrompt = buildSystemPrompt({ userConfig, tools })

    // ⑧ 首条用户消息（initialMessages 给主循环；messages 流同步显示）
    const initialMessages = [createUserMessage(text)]
    messages.value.push({
      id: nextUiMessageId(),
      kind: 'user',
      text,
      toolName: null,
      toolStatus: null,
      durationMs: null,
      shownLen: text.length
    })

    // ⑨ 运行主循环（双层循环：LLM ↔ 工具迭代 + steer/followUp 队列干预）
    running.value = true
    try {
      return await runAgentLoop({
        llmFn: ({ systemPrompt: prompt, messages: llmMessages, tools: llmTools, signal }) =>
          callLlm({
            aiConfig: getAiConfig?.() ?? null,
            systemPrompt: prompt,
            messages: llmMessages,
            tools: llmTools,
            signal
          }),
        systemPrompt,
        tools,
        initialMessages,
        steerQueue,
        followUpQueue,
        signal: abortController.signal,
        emit,
        maxTurns: 50,
        onBeforeLlm,
        // 达标自动收敛：已提示达标且 agent 仍持续微调无改善（连续 ≥2 轮）→ 以 'stop' 正常结束，
        // 不再依赖 LLM 自觉 / maxTurns 兜底（根治"达标后拉到 50 轮"）
        shouldStopAfterTurn: async () => {
          if (!acceptanceNotified) return false
          if (stagnantTurns >= 2) return { stop: true, reason: 'stop' }
          return false
        }
      })
    } finally {
      running.value = false
    }
  }

  // ---------------- 会话干预与数据流入 ----------------

  /** 中途纠偏：运行中插入 steer 消息（主循环每个内层回合开始时 drain） */
  function steer(text) {
    const value = String(text ?? '').trim()
    if (!value || !running.value || !steerQueue) return
    steerQueue.push(createUserMessage(value, 'steer'))
    messages.value.push({
      id: nextUiMessageId(),
      kind: 'steerUser',
      text: value,
      toolName: null,
      toolStatus: null,
      durationMs: null,
      shownLen: value.length
    })
  }

  /** 追问：内层循环结束后由外层循环 drain 注入（视为新任务重启循环） */
  function followUp(text) {
    const value = String(text ?? '').trim()
    if (!value || !running.value || !followUpQueue) return
    followUpQueue.push(createUserMessage(value, 'followUp'))
    messages.value.push({
      id: nextUiMessageId(),
      kind: 'user',
      text: value,
      note: '追加任务',
      toolName: null,
      toolStatus: null,
      durationMs: null,
      shownLen: value.length
    })
  }

  /** 聊天输入统一入口：运行中视为纠偏，空闲时启动新会话（返回 startAgent 的 Promise 供面板捕获错误） */
  function sendChat(text) {
    const value = String(text ?? '').trim()
    if (!value) return undefined
    if (running.value) {
      steer(value)
      return undefined
    }
    return startAgent(value)
  }

  /** 停止智能体（中止信号 → 主循环以 'aborted' 终止） */
  function stopAgent() {
    abortController?.abort()
  }

  /**
   * 串口数据流入（面板 watch latestPayload 后调用）：
   * FireWater 格式「标签:值」——冒号后正则提数，取前三个作为 [target, feedback, output]，
   * t 按首帧样本时间换算为相对秒，写入通道数据缓冲（供 get_channel_* 工具查询）。
   */
  function onSerialData(payload) {
    if (!payload || testMode.value !== 'serial' || !dataBuffer) return
    const rawText = String(payload.raw ?? '')
    if (!rawText) return
    const colonIdx = rawText.indexOf(':')
    const dataPart = colonIdx >= 0 ? rawText.slice(colonIdx + 1) : rawText
    const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
    if (!nums || nums.length < 3) return
    const [target, feedback, output] = nums.slice(0, 3).map(Number)
    const timestamp = Number(payload.time) || Date.now()
    if (serialStartTime === null) serialStartTime = timestamp
    const t = Math.max(0, (timestamp - serialStartTime) / 1000)
    const sample = { t, target, feedback, output }
    dataBuffer.push(sample)
    // 若正处于 set_target(serial) 触发的阶跃窗口内，窗口满后自动触发安全检测
    serialCollector?.push(sample)
  }

  // ---------------- 派生状态 ----------------

  /** 仿真用前馈选择（{ id: coeff } 映射：当前系数，缺省回退定义表 init） */
  const feedforwardSelectionForSim = computed(() => {
    const selection = {}
    feedforwardItems.forEach((item) => {
      if (!item?.id) return
      const coeff = Number(currentFf[item.id])
      selection[item.id] = Number.isFinite(coeff) ? coeff : Number(item.init) || 0
    })
    return selection
  })

  return {
    // 配置状态
    strategyId,
    enableStrategyTools,
    strategyOptions,
    pidConfig,
    safetyRange,
    feedforwardItems,
    scenePrompt,
    testMode,
    tuningStrategy,
    pidStructure,
    addFeedforwardItem,
    removeFeedforwardItem,
    // 运行状态
    messages,
    running,
    turnCount,
    ctxBytes,
    stopReason,
    currentPid,
    currentFf,
    currentTarget,
    paramHighlight,
    // 方法
    startAgent,
    steer,
    followUp,
    sendChat,
    stopAgent,
    onSerialData,
    feedforwardSelectionForSim
  }
}
