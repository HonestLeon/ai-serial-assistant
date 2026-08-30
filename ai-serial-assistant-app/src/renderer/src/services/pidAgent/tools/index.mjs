import { applyPidGuardrails } from '../../pidSafety.mjs'
import { buildPidCommand } from '../utils.mjs'

/**
 * PID 调参智能体 —— 工具集模块。
 *
 * 纯 JS ESM 模块（无 Vue/DOM/window 依赖），渲染进程与 Node 测试共用。
 * 参考Pi-agent 工具四要素：name / description（面向模型可读，写明何时用、怎么传参）/
 * parameters（JSON Schema）/ execute。
 *
 * 工具自身不持有任何状态：读写参数、阶跃仿真、串口指令、数据缓冲、用户配置等
 * 运行时能力全部通过 controller 注入，由引擎层实现并负责 UI 同步。
 *
 * 错误协议：工具内部出错直接 throw Error（消息中文），
 * 由上层智能体循环捕获并转为 isError 的 toolResult 消息；工具内部不吞错、不兜底。
 */

// ---- 模块内私有工具函数（不导出） ----

/**
 * 按范围裁剪单个数值，越界时向 notes 追加一条中文说明。
 * 说明格式与 pidSafety 的护栏说明保持一致，例如：`kp: 50 → 20（超出用户配置上限 20）`。
 * @param {string} key 参数键名（用于说明文案）
 * @param {number} value 待裁剪的数值
 * @param {{min:number, max:number}} range 允许范围
 * @param {string[]} notes 裁剪说明收集数组（原地追加）
 * @param {string} label 范围来源文案（'用户配置' / '用户安全范围'）
 * @returns {number} 裁剪后的值
 */
const clampByRange = (key, value, range, notes, label) => {
  if (value > range.max) {
    notes.push(`${key}: ${value} → ${range.max}（超出${label}上限 ${range.max}）`)
    return range.max
  }
  if (value < range.min) {
    notes.push(`${key}: ${value} → ${range.min}（低于${label}下限 ${range.min}）`)
    return range.min
  }
  return value
}

// get_channel_* 两个工具共用的参数 JSON Schema 片段
const TIME_RANGE_SCHEMA = {
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: '[起始秒, 结束秒]，相对调参开始'
}

const CHANNELS_SCHEMA = {
  type: 'array',
  items: {
    type: 'string',
    enum: ['target', 'feedback', 'output', 'speedTarget', 'speed']
  },
  description: '可选，默认全部。speedTarget（速度指令）/speed（实际速度）仅串级仿真提供，用于诊断外环饱和与内环跟踪'
}

/**
 * 创建 PID 调参智能体工具集（5 个工具，无状态，全部能力来自注入的 controller）。
 *
 * @param {object} options
 * @param {object} options.controller 运行时环境对象，需提供：
 *   - getPid()                       → 当前参数对象 { kp, ki, kd }（串级含 speed 系 / position 系参数）
 *   - setPid(newPid, notes)          → 写回参数（引擎层负责 UI 同步）
 *   - getFeedforward()               → { id: coeff } 映射
 *   - setFeedforward(newFf)          → 写回前馈系数（可部分更新）
 *   - getTarget() / setTarget(value) → 目标值读写
 *   - getMode()                      → 'simulation' | 'serial'
 *   - runSimulation()                → Promise<samples[]>，样本 [{ t, target, feedback, output }]，t 从 0 起
 *   - getSessionClock()              → 当前会话时钟（秒，仿真模式下用于给采集样本加时间偏移）
 *   - advanceSessionClock(seconds)   → 推进会话时钟
 *   - sendSerialCommand(cmd)         → Promise，串口模式下发指令
 *   - onSamplesCollected(samples)    → 可选回调（可为 null），采集完成后的安全检测钩子
 *   - getDataBuffer()                → 通道数据缓冲实例（dataBuffer.mjs 的 createDataBuffer()）
 *   - getUserConfig()                → 用户配置（types.mjs 的 UserConfig）
 * @returns {Array<{name:string, description:string, parameters:object, execute:Function}>}
 */
export function createPidAgentTools({ controller } = {}) {
  if (!controller || typeof controller !== 'object') {
    throw new Error('createPidAgentTools 缺少 controller 运行时环境对象')
  }

  // ---------- 工具 1：get_channel_stats（通道统计查询，透传 dataBuffer.stats） ----------
  const getChannelStatsTool = {
    name: 'get_channel_stats',
    description:
      '获取指定时间段内各通道统计特征（均值/标准差/极值/峰值/RMS/采样数），若段内含阶跃响应还返回控制指标'
      + '（超调/稳定时间/稳态误差/RMSE/振荡/状态）。调参开始与每次修改参数后应先调用了解系统特性。'
      + '何时用：评估上一轮阶跃效果、判断超调/震荡/稳态误差。怎么传参：timeRange 传 [起始秒, 结束秒]'
      + '（相对调参开始的秒数，set_target 返回的 timeRange 可直接使用）；channels 可选，默认全部通道'
      + '（串级仿真可用 speedTarget/speed 诊断外环饱和与内环跟踪）。'
      + '注意：若状态为 STILL_RISING 或提示"窗口内响应尚未收敛"，说明查询窗口未覆盖响应完成段，'
      + '指标均为非稳态中途值，请延长查询区间或提高速度环增益后再查询。',
    parameters: {
      type: 'object',
      properties: {
        timeRange: TIME_RANGE_SCHEMA,
        channels: CHANNELS_SCHEMA
      },
      required: ['timeRange']
    },
    execute: async ({ timeRange, channels } = {}) => {
      const result = controller.getDataBuffer().stats({ timeRange, channels })
      // 结构化达标判定：随 toolResult 直接返回给 LLM（无需自行对照 limits）
      // STABLE 已隐含超调/振荡 ≤ limits；补 converged 与稳态误差排除"未收敛假稳定"
      // 轮次门槛：前 5 轮为观察/整定期（controller.getTurnCount()，缺失视为已满 5 轮），
      //   首轮即达标不判"任务完成"，避免 agent 过早总结、剥夺完整调参过程
      const turn = controller.getTurnCount?.()
      const inObservation = Number.isFinite(Number(turn)) && Number(turn) < 5
      const sm = result?.stepMetrics
      const check = sm?.valid
        ? {
            passed: !inObservation && sm.status === 'STABLE' && sm.converged !== false
              && Math.abs(sm.steadyError) <= Math.abs(sm.stepSize) * 0.05,
            reason: !inObservation
              ? (sm.status === 'STABLE'
                  ? (sm.converged === false ? '已稳定但窗口未收敛' : '达标')
                  : `未达标（${sm.status}）`)
              : `调参初期（前 5 轮观察期），暂不判定达标（当前状态 ${sm.status}）`
          }
        : { passed: false, reason: '无有效阶跃指标' }
      if (check.passed && typeof controller.onAcceptancePassed === 'function') {
        await controller.onAcceptancePassed(result)
      }
      return { ...result, acceptanceCheck: check }
    }
  }

  // ---------- 工具 2：get_channel_data（通道原始数据查询，透传 dataBuffer.query，自动下采样） ----------
  const getChannelDataTool = {
    name: 'get_channel_data',
    description:
      '获取指定时间段各通道原始数据（自动均匀下采样，默认 30 点，用于需要观察波形细节时）。数据量大时慎用，'
      + '优先用 get_channel_stats 获取统计摘要。怎么传参：timeRange 传 [起始秒, 结束秒]（相对调参开始）；'
      + 'maxPoints 为下采样目标点数，默认 30；channels 可选，默认全部通道。',
    parameters: {
      type: 'object',
      properties: {
        timeRange: TIME_RANGE_SCHEMA,
        channels: CHANNELS_SCHEMA,
        maxPoints: { type: 'number', description: '下采样目标点数，默认 30' }
      },
      required: ['timeRange']
    },
    execute: async ({ timeRange, channels, maxPoints } = {}) =>
      controller.getDataBuffer().query({ timeRange, channels, maxPoints })
  }

  // ---------- 工具 3：set_pid_params（修改 PID 参数，三重安全校验） ----------
  const setPidParamsTool = {
    name: 'set_pid_params',
    description:
      '修改 PID 参数（只传需要修改的项，如 {"kp": 2.0}）。参数会经三重安全校验：用户配置范围裁剪、系统上限'
      + '（Kp≤20，Ki/Kd≤10）、单步增幅限制（Kp×3，Ki/Kd×4），越界会被裁剪并在结果 guardrailNotes 中说明原因。'
      + '串口模式下参数会真实下发到设备（PID 指令，串级时速度环三参在前）。'
      + '注意：仿真模式下 PID 输出无限幅，输出幅值由增益与误差决定；目标误差大时优先整定速度环'
      + '（speedKp/speedKi）避免输出过大导致振荡。'
      + '何时用：根据 get_channel_stats 的指标调整参数后。修改后需调用 set_target 触发阶跃验证效果。',
    parameters: {
      type: 'object',
      properties: {
        kp: { type: 'number', description: '比例系数' },
        ki: { type: 'number', description: '积分系数' },
        kd: { type: 'number', description: '微分系数' },
        speedKp: { type: 'number', description: '串级模式下速度环比例系数' },
        speedKi: { type: 'number', description: '串级模式下速度环积分系数' },
        speedKd: { type: 'number', description: '串级模式下速度环微分系数' },
        positionKp: { type: 'number', description: '串级模式下位置环比例系数' },
        positionKi: { type: 'number', description: '串级模式下位置环积分系数' },
        positionKd: { type: 'number', description: '串级模式下位置环微分系数' }
      },
      additionalProperties: false
    },
    execute: async (args = {}) => {
      const userConfig = controller.getUserConfig()
      const pidDefs = Array.isArray(userConfig?.pid) ? userConfig.pid : []
      const validKeys = pidDefs.map((def) => def?.key).filter(Boolean)

      // 串级模式键映射：用户配置为 position*/speed*（6 键）时，把通用单环键 kp/ki/kd
      // 同义映射到位置环 positionKp/Ki/Kd（与 readCanonicalPid 的合并形态语义一致：
      // currentPid.kp 即位置环 Kp）。避免 LLM 用 kp 键在串级下被静默忽略/报错。
      const isCascade = validKeys.includes('positionKp') || validKeys.includes('positionKi')
        || validKeys.includes('speedKp') || validKeys.includes('speedKi')
      const norm = { ...(args ?? {}) }
      if (isCascade) {
        const map = { kp: 'positionKp', ki: 'positionKi', kd: 'positionKd' }
        for (const [generic, specific] of Object.entries(map)) {
          if (generic in norm && !(specific in norm)) {
            norm[specific] = norm[generic]
            delete norm[generic]
          }
        }
      }

      // 只处理用户配置中定义且取值为有限数字的键；未知键忽略（schema 层 additionalProperties:false 已约束）
      const entries = Object.entries(norm).filter(
        ([key, value]) => validKeys.includes(key) && Number.isFinite(Number(value))
      )
      if (!entries.length) {
        throw new Error(`未提供任何参数（可用键：${validKeys.join('、') || '无'}）`)
      }

      // 第一重：按用户配置范围（userConfig.pid 的 min/max）逐项裁剪
      const guardrailNotes = []
      const clamped = {}
      for (const [key, rawValue] of entries) {
        const def = pidDefs.find((item) => item.key === key)
        clamped[key] = clampByRange(key, Number(rawValue), def, guardrailNotes, '用户配置')
      }

      // 第二、三重：系统上限 + 单步增幅限制（pidSafety.applyPidGuardrails）
      const previous = controller.getPid()
      const { params: applied, notes: systemNotes } = applyPidGuardrails(previous, clamped)
      // applyPidGuardrails 只处理系统限幅表内的键；用户自定义键保留第一重裁剪结果
      for (const key of Object.keys(clamped)) {
        if (!(key in applied)) applied[key] = clamped[key]
      }
      const allNotes = [...guardrailNotes, ...systemNotes]

      controller.setPid(applied, allNotes)

      // 串口模式：参数真实下发到设备（zhichuan 固件 PID 指令）。
      // 此前只写上位机内存，设备全程跑旧参数——实测"无论怎么调反馈都一样"的根因。
      if (controller.getMode() === 'serial') {
        await controller.sendSerialCommand(buildPidCommand(controller.getPid(), { isCascade }))
        return {
          applied,
          previous,
          guardrailNotes: allNotes,
          mode: 'serial',
          message: '参数已下发到设备（PID 指令），请调用 set_target 触发阶跃验证'
        }
      }
      return { applied, previous, guardrailNotes: allNotes }
    }
  }

  // ---------- 工具 4：set_feedforward_params（修改前馈系数，按用户配置范围裁剪） ----------
  const setFeedforwardParamsTool = {
    name: 'set_feedforward_params',
    description:
      '修改前馈项系数（只传需要修改的项，键为前馈项 id，如 {"gravity": 1.2}）。系数经用户配置范围校验，'
      + '越界裁剪并在结果 guardrailNotes 中说明。何时用：需要前馈补偿（如重力/摩擦）改善跟踪速度或稳态误差时；'
      + '修改后同样需调用 set_target 验证效果。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: { type: 'number', description: '前馈项系数新值（键为前馈项 id）' },
      required: []
    },
    execute: async (args = {}) => {
      const userConfig = controller.getUserConfig()
      const ffDefs = Array.isArray(userConfig?.feedforward) ? userConfig.feedforward : []
      const entries = Object.entries(args ?? {})
      if (!entries.length) {
        throw new Error('未提供任何前馈系数')
      }

      const applied = {}
      const guardrailNotes = []
      for (const [id, rawValue] of entries) {
        const def = ffDefs.find((item) => item?.id === id)
        if (!def) {
          const available = ffDefs.map((item) => item.id).join('、') || '（配置中未定义任何前馈项）'
          throw new Error(`未知前馈项 id "${id}"，可用前馈项：${available}`)
        }
        const value = Number(rawValue)
        if (!Number.isFinite(value)) {
          throw new Error(`前馈项 ${id} 的系数必须为数字`)
        }
        applied[id] = clampByRange(id, value, def, guardrailNotes, '用户配置')
      }

      controller.setFeedforward(applied)
      return { applied, guardrailNotes }
    }
  }

  // ---------- 工具 5：set_target（修改目标值并触发阶跃采集，调参验证闭环的必经步骤） ----------
  const setTargetTool = {
    name: 'set_target',
    description:
      '修改目标值并触发阶跃响应采集（调参验证的必经步骤）。目标值经物理适用范围校验'
      + '（仿真按策略物理范围，如倒立摆为小角度线性区 ±0.18 rad≈±10°；串口按用户安全范围），'
      + '轻微软出会被裁剪。'
      + '仿真模式下立即采集并返回摘要（timeRange 为本次阶跃数据区间，可直接传给 get_channel_stats/'
      + 'get_channel_data 查询；若系统发散返回"仿真因发散截断"提示，说明该目标/增益下不可控，应降低增益或让目标回到物理范围）；'
      + '串口模式下发指令后异步采集（返回 suggestedQuery 建议查询区间，'
      + '约一个采集窗口后按该区间查询），采集完成会自动进行安全检测，若触发回退会收到 [安全机制] 通知。'
      + '何时用：每次修改 PID/前馈参数后，或需要重新验证当前参数时。',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: '新目标值' }
      },
      required: ['value']
    },
    execute: async (args = {}) => {
      const rawValue = Number(args?.value)
      if (!Number.isFinite(rawValue)) {
        throw new Error('缺少合法的目标值：请在 value 字段传入数字')
      }

      // 目标范围校验：仿真按策略物理范围（倒立摆小角度线性区），串口回退用户安全范围；
      // 轻微软出裁剪到边界并说明，严重越界（超出范围一个量程以上）直接拒绝
      const userConfig = controller.getUserConfig()
      const fallbackRange = userConfig?.safety?.target ?? { min: -Infinity, max: Infinity }
      const range = controller.getTargetRange?.() ?? fallbackRange
      const span = range.max - range.min
      if (rawValue > range.max + span || rawValue < range.min - span) {
        throw new Error(`目标值 ${rawValue} 严重超出物理适用范围 [${range.min}, ${range.max}]，已拒绝执行`)
      }
      const guardrailNotes = []
      const value = clampByRange('target', rawValue, range, guardrailNotes, '物理适用范围')
      controller.setTarget(value)

      // 串口模式：下发目标指令，响应由外部采样流异步进入数据缓冲；
      // 同时声明「已发起阶跃」，由上游串口窗口采集器在采集完成后自动做安全检测。
      // 返回建议查询区间 suggestedQuery：设备 set_point 常为斜坡（实测 ~8-10s 才到稳态），
      // 盲查大窗口只会拿到旧数据/多阶跃混杂指标；按建议区间查「本次阶跃」最可靠。
      if (controller.getMode() === 'serial') {
        await controller.sendSerialCommand(`SET_POINT ${value}`)
        if (typeof controller.onStepTriggered === 'function') controller.onStepTriggered()
        const windowSec = controller.getStepWindowSec?.() ?? 12
        const rangeInfo = controller.getDataBuffer().getRange()
        const tStart = rangeInfo.end ?? 0
        return {
          ok: true,
          mode: 'serial',
          target: value,
          guardrailNotes,
          windowSec,
          suggestedQuery: [Number(tStart.toFixed(1)), Number((tStart + windowSec).toFixed(1))],
          message: `指令已下发，采集窗口约 ${windowSec}s；建议稍后用 get_channel_stats 查询 [${tStart.toFixed(1)}, ${(tStart + windowSec).toFixed(1)}]（统计只分析最新一次目标变化段）`
        }
      }

      // 仿真模式：立即用当前参数与目标跑一次阶跃仿真，
      // 样本按会话时钟加偏移后写入数据缓冲，再推进会话时钟
      const samples = await controller.runSimulation()
      const list = Array.isArray(samples) ? samples : []
      const offset = controller.getSessionClock()
      const pushed = list.map((sample) => ({ ...sample, t: sample.t + offset }))
      if (pushed.length) {
        controller.getDataBuffer().push(pushed)
      }
      const duration = pushed.length ? list[list.length - 1].t : 0
      controller.advanceSessionClock(duration + 0.1)
      if (typeof controller.onSamplesCollected === 'function') {
        await controller.onSamplesCollected(pushed)
      }
      // 发散截断提示：状态超出发散保护阈值提前结束仿真时告知 agent（反馈并非正常响应）
      const truncated = list?.truncated === true
      const truncateMessage = truncated
        ? `⚠ 仿真因发散截断：${list?.truncateReason || '状态发散'}；本次仅采集 ${pushed.length} 点（约 ${duration.toFixed(2)}s），` +
          '反馈并非正常响应，请先降低增益或让目标回到物理可行范围'
        : ''
      return {
        ok: true,
        mode: 'simulation',
        target: value,
        samplesCollected: pushed.length,
        timeRange: [offset, offset + duration],
        truncated,
        ...(truncateMessage ? { message: truncateMessage } : {}),
        guardrailNotes
      }
    }
  }

  return [getChannelStatsTool, getChannelDataTool, setPidParamsTool, setFeedforwardParamsTool, setTargetTool]
}
