/**
 * PID 调参智能体 —— 参数与仿真配置工具函数。
 *
 * readCanonicalPid / applyCanonicalPid 逐行等价迁移自 pidTuningSession.mjs
 * （原文件继续保留，两处实现保持行为一致；智能体编排层统一从本模块引用）。
 *
 * 两种参数形态的转换约定：
 *   - 合并形态（currentPid）：{ kp, ki, kd, speedKp, speedKi, speedKd }
 *     （串级策略下 kp/ki/kd 即位置环参数，speed* 为速度环参数）
 *   - 规范形态（工具/展示用）：单环 { kp, ki, kd }；
 *     串级 { speedKp, speedKi, speedKd, positionKp, positionKi, positionKd }
 *
 * buildSimOverrides 把当前参数 / 前馈 / 目标组装为 simulatePidStrategy 的 overrides。
 *
 * 纯 JS ESM 模块（无 Vue/DOM/window 依赖），渲染进程与 Node 测试共用。
 */

export function readCanonicalPid(params, cascade = false) {
  if (cascade) {
    return {
      speedKp: Number(params.speedKp),
      speedKi: Number(params.speedKi),
      speedKd: Number(params.speedKd),
      positionKp: Number(params.kp),
      positionKi: Number(params.ki),
      positionKd: Number(params.kd)
    }
  }
  return {
    kp: Number(params.kp),
    ki: Number(params.ki),
    kd: Number(params.kd)
  }
}

export function applyCanonicalPid(target, pid, cascade = false) {
  if (!pid) return target
  if (cascade) {
    const mapping = {
      speedKp: 'speedKp',
      speedKi: 'speedKi',
      speedKd: 'speedKd',
      positionKp: 'kp',
      positionKi: 'ki',
      positionKd: 'kd'
    }
    Object.entries(mapping).forEach(([source, destination]) => {
      if (Number.isFinite(Number(pid[source]))) target[destination] = String(pid[source])
    })
    return target
  }
  ;['kp', 'ki', 'kd'].forEach((key) => {
    if (Number.isFinite(Number(pid[key]))) target[key] = String(pid[key])
  })
  return target
}

// 宽松取有限数字：undefined / null / 空串 / 非数字一律视为「未提供」返回 undefined
// （表单空值与缺省键不应覆盖仿真策略默认值）
const finiteNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

/**
 * 组装 simulatePidStrategy 的 overrides 配置。
 *
 * @param {object} options
 *   - strategyId: 策略 id（PID_STRATEGIES 键，cascade_position 走串级键映射）
 *   - pid: 当前 PID 参数（合并形态 { kp, ki, kd, speed* } 或规范形态 { position*, speed* } 均可）
 *   - feedforward: 前馈选择 { id: coeff } 映射，写入 feedforwardSelection
 *   - target: 目标值（非有限数时不写入，保留策略默认值）
 *   - baseConfig: 其余仿真配置兜底（duration/dt/noise 等，优先级低于本函数写入的键）
 * @returns {object} overrides：{ ...baseConfig, target, feedforwardSelection, ...pid 键映射 }
 *   - 单环：直接展开 kp/ki/kd
 *   - cascade_position：pid.kp/ki/kd 映射为 positionKp/Ki/Kd（规范形态 position* 直接采用），
 *     speed* 原样保留
 */
export function buildSimOverrides({
  strategyId,
  pid = {},
  feedforward = {},
  target,
  baseConfig = {}
} = {}) {
  const overrides = {
    ...baseConfig,
    feedforwardSelection: { ...feedforward }
  }

  // 目标值：有限数字才写入（undefined/空值不覆盖策略默认 target）
  const targetValue = finiteNumber(target)
  if (targetValue !== undefined) overrides.target = targetValue

  if (strategyId === 'cascade_position') {
    // 位置环：优先取合并形态的 kp/ki/kd，回退规范形态的 positionKp/Ki/Kd
    const positionKp = finiteNumber(pid.kp) ?? finiteNumber(pid.positionKp)
    const positionKi = finiteNumber(pid.ki) ?? finiteNumber(pid.positionKi)
    const positionKd = finiteNumber(pid.kd) ?? finiteNumber(pid.positionKd)
    if (positionKp !== undefined) overrides.positionKp = positionKp
    if (positionKi !== undefined) overrides.positionKi = positionKi
    if (positionKd !== undefined) overrides.positionKd = positionKd
    // 速度环：speed* 原样保留
    const speedKp = finiteNumber(pid.speedKp)
    const speedKi = finiteNumber(pid.speedKi)
    const speedKd = finiteNumber(pid.speedKd)
    if (speedKp !== undefined) overrides.speedKp = speedKp
    if (speedKi !== undefined) overrides.speedKi = speedKi
    if (speedKd !== undefined) overrides.speedKd = speedKd
    return overrides
  }

  // 单环：直接展开 kp/ki/kd
  const kp = finiteNumber(pid.kp)
  const ki = finiteNumber(pid.ki)
  const kd = finiteNumber(pid.kd)
  if (kp !== undefined) overrides.kp = kp
  if (ki !== undefined) overrides.ki = ki
  if (kd !== undefined) overrides.kd = kd
  return overrides
}

/**
 * 串口阶跃窗口采集器（纯函数，无 Vue/DOM 依赖）。
 *
 * 用途：串口模式下 set_target 触发一次阶跃后，设备响应数据经 onSerialData 异步流入，
 * 本采集器按时间窗口收集「这次阶跃」的样本段；窗口时长攒满后回调 onWindowComplete，
 * 调用方（composable）把窗口样本交给安全护栏做自动检测（与仿真模式共用同一判定）。
 *
 * 不阻塞：set_target 工具只负责 trigger()，窗口完成由数据驱动异步触发，
 * 安全通知经 steer 队列在下一回合注入 LLM。
 *
 * @param {object} options
 * @param {number} [options.windowSec=5] 窗口时长（秒，以首帧样本 t 为起点）
 * @param {(state: {target:number, t0:number, t1:number, samples:Array}) => void} options.onWindowComplete 窗口完成回调
 * @returns {{ trigger: () => void, push: (sample: object) => void, isActive: () => boolean }}
 */
export function createSerialStepCollector({ windowSec = 5, onWindowComplete = null } = {}) {
  let active = false
  let windowStart = null
  let samples = []

  const finish = (target) => {
    const t0 = windowStart
    const t1 = samples.length ? samples[samples.length - 1].t : t0
    active = false
    windowStart = null
    const snapshot = [...samples]
    samples = []
    if (typeof onWindowComplete === 'function') {
      onWindowComplete({ target, t0, t1, samples: snapshot })
    }
  }

  return {
    /** 开启新窗口（由 set_target 串口分支调用）；未完成的旧窗口会被丢弃 */
    trigger() {
      active = true
      windowStart = null
      samples = []
    },
    /**
     * 采样流入：仅 active 时收集；首帧确定窗口起点；
     * 拒绝时间回退的乱序帧；窗口攒满（t - windowStart >= windowSec）后自动完成。
     */
    push(sample) {
      if (!active) return
      const t = Number(sample?.t)
      if (!Number.isFinite(t)) return
      if (windowStart === null) {
        windowStart = t
      } else if (t < windowStart) {
        return // 时间回退的乱序帧，丢弃
      }
      samples.push(sample)
      const first = samples[0]
      if (t - windowStart >= windowSec) {
        finish(first?.target ?? sample.target)
      }
    },
    isActive: () => active
  }
}
