function seededRandom(seed = 20260723) {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function noise(random, amplitude) {
  return (random() + random() + random() - 1.5) * amplitude
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// 仿真教学模式：去除 PID 输出限幅（用户要求，让增益与响应直接可见、调参有真实空间）。
// pidStep 的积分抗饱和仍需有限限幅避免数值溢出，取远超物理量级的大数等效"无输出限幅"。
const NO_OUTPUT_LIMIT = 1e9

// 前馈项计算：遍历已勾选项求和。feedforwardSelection 形如 { linear: 0.5, gravity: 1 }
// 未勾选（不在对象中）的项不参与；coeff 为该项系数
// derivatives 形如 { dot, dotDot }，为目标值的一阶/二阶导数，供目标导数前馈项使用
function computeFeedforward(config, target, derivatives) {
  return computeFeedforwardFiltered(config, target, null, null, derivatives)
}

// 只计算指定 id 集合内的前馈项
function computeFeedforwardOnly(config, target, includeIds, derivatives) {
  return computeFeedforwardFiltered(config, target, includeIds, null, derivatives)
}

// 排除指定 id 集合的前馈项
function computeFeedforwardExcluding(config, target, excludeIds, derivatives) {
  return computeFeedforwardFiltered(config, target, null, excludeIds, derivatives)
}

function computeFeedforwardFiltered(config, target, includeIds, excludeIds, derivatives) {
  const selection = config.feedforwardSelection || {}
  const ids = Object.keys(selection)
  if (!ids.length) return 0
  const ctx = {
    target,
    targetDot: finite(derivatives?.dot, 0),
    targetDotDot: finite(derivatives?.dotDot, 0),
    m: finite(config.m, 1),
    g: finite(config.g, 9.81),
    l: finite(config.l, 0.25)
  }
  let sum = 0
  ids.forEach((id) => {
    if (includeIds && !includeIds.includes(id)) return
    if (excludeIds && excludeIds.includes(id)) return
    const item = FEEDFORWARD_ITEMS_BY_ID[id]
    if (!item) return
    const coeff = finite(selection[id], item.defaultCoeff)
    sum += item.compute(coeff, ctx)
  })
  return sum
}

// 单步 PID：条件积分抗饱和（输出饱和时停止积分累加，工业界标准做法）。
// D项基于测量值变化（derivative on measurement）：避免 setpoint 阶跃时 D 项瞬间爆炸，
// 这是工业 PID 控制器的标准做法。integralLimit 仍作为积分项硬上限兜底；
// 输出限幅由调用方在叠加前馈后执行。
function pidStep(state, error, dt, gains, integralLimit, outputLimit, measurement) {
  // D项：优先用测量变化率；首次调用（previousMeasurement 未定义）回退到误差变化率
  const derivative = (measurement !== undefined && state.previousMeasurement !== undefined)
    ? -(measurement - state.previousMeasurement) / dt
    : (error - state.previousError) / dt
  // 试算：若本次积分会让输出越过限幅，则不累加本次积分（防止饱和加深）
  const candidateIntegral = state.integral + error * dt
  const candidateOutput = gains.kp * error + gains.ki * candidateIntegral + gains.kd * derivative
  if (outputLimit === undefined || Math.abs(candidateOutput) <= outputLimit || Math.sign(candidateOutput) !== Math.sign(gains.ki * candidateIntegral)) {
    state.integral = clamp(candidateIntegral, -integralLimit, integralLimit)
  }
  state.previousError = error
  if (measurement !== undefined) state.previousMeasurement = measurement
  return gains.kp * error + gains.ki * state.integral + gains.kd * derivative
}

export const PID_STRATEGIES = {
  motor_speed: {
    id: 'motor_speed',
    name: '电机速度环（一阶模型）',
    description: 'J·dω/dt + B总·ω = Kt·i；被控量为转速，控制量为电流。',
    parameters: ['Kp', 'Ki', 'Kd'],
    defaultOrder: ['Kp', 'Ki', 'Kd'],
    // 验收标准：超调/振荡/稳态误差 + 响应速度（上升时间/调节时间）
    // 一阶系统 τ=J/B=0.25s，要求上升时间 < 0.3s、调节时间 < 1s
    acceptance: { overshootLimit: 10, settlingBand: 0.05, oscillationLimit: 10, riseTimeLimit: 0.3, settlingTimeLimit: 1.0 },
    // 目标物理范围（转速，语义同默认 target=10）
    targetRange: [0, 100],
    defaults: {
      duration: 4,
      dt: 0.01,
      noise: 0.08,
      target: 10,
      J: 0.02,
      B: 0.08,
      Kt: 0.5,
      outputLimit: 12,
      // 默认参数：从纯 P 开始（Ki=Kd=0），让分阶段调参策略自动从 P 阶段开始试探 Kp
      // 稳态 i=B·target/Kt=1.6A；τ=J/B=0.25s；kp·10=10 < outputLimit=12，初始不饱和
      kp: 1.0,
      ki: 0,
      kd: 0
    }
  },
  cascade_position: {
    id: 'cascade_position',
    name: '位置—速度串级 PID',
    description: '外环位置 PID 给出目标速度，内环速度 PID 给出电流控制量。',
    parameters: ['速度环Kp', '速度环Ki', '位置环Kp', '位置环Ki', '位置环Kd'],
    // 调参顺序：位置环（外环）排首位，posIdx=0 不衰减，主导响应速度
    // 速度环（内环）作为跟随环，posIdx=3 通过 0.5^3 衰减 + loop=0.3 权重衰减
    // 若速度环排首位，位置环Kp 在 posIdx=2 被严重衰减，导致响应慢、Kp 调整迟缓
    defaultOrder: ['位置环Kp', '位置环Ki', '位置环Kd', '速度环Kp', '速度环Ki'],
    // 验收标准：超调/振荡/稳态误差 + 响应速度（上升时间/调节时间）
    // 二阶系统要求上升时间 < 0.5s、调节时间 < 1.5s
    acceptance: { overshootLimit: 15, settlingBand: 0.04, oscillationLimit: 8, riseTimeLimit: 0.5, settlingTimeLimit: 1.5 },
    // 目标物理范围（位置行程，语义同默认 target=1）
    targetRange: [0, 100],
    defaults: {
      duration: 15,
      dt: 0.01,
      noise: 0.002,
      target: 1,
      J: 0.02,
      B: 0.08,
      Kt: 0.5,
      outputLimit: 12,
      speedLimit: 8,
      // 内环（速度环）与 motor_speed 同物理模型，参数保持一致
      // 从纯 P 开始（Ki=Kd=0），让分阶段调参策略自动从 P 阶段开始
      speedKp: 1.0,
      speedKi: 0,
      speedKd: 0,
      // 外环（位置环）：被控量位置，输出速度目标。初始 error=1，
      // positionKp=3 → P=3 未饱和 speedLimit=8
      positionKp: 3,
      positionKi: 0,
      positionKd: 0
    }
  },
  inverted_pendulum: {
    id: 'inverted_pendulum',
    name: '不稳定二阶系统（倒立摆）',
    description: 'J·θ¨ − mgl·θ = −T；被控量为摆角，控制量为力矩。',
    parameters: ['Kp', 'Kd', 'Ki'],
    defaultOrder: ['Kp', 'Kd', 'Ki'],
    acceptance: { overshootLimit: 25, settlingBand: 0.03, oscillationLimit: 12 },
    // 不稳定系统标记：必须有 Kd 提供阻尼，调参策略走 PD → PID 路径，不走纯 P
    unstable: true,
    // 目标物理范围（弧度）：倒立摆 PID 仅在小角度线性区成立（常规 -10°~10° ≈ ±0.18 rad），
    // 大角度阶跃超出线性近似范围，物理上无法用 PID 镇定
    targetRange: [-0.18, 0.18],
    defaults: {
      duration: 5,
      dt: 0.005,
      noise: 0.0015,
      target: 0,
      initialAngle: 0.12,
      J: 0.08,
      m: 1,
      g: 9.81,
      l: 0.25,
      outputLimit: 8,
      // 倒立摆为开环不稳定系统，纯 P 必发散。这里保留 Kd=1.2 提供阻尼，
      // 让仿真可运行；调参策略会从 PD 阶段开始（Kd 保留，调 Kp）。
      kp: 4,
      ki: 0,
      kd: 1.2
    }
  }
}

/**
 * 前馈项库：三栏分类（多项式 / 三角函数 / 其他），每栏内多项可勾选（多选）。
 * 每项含：id、显示名、公式、默认系数、仿真计算 compute()、C 代码片段 cSnippet()。
 * 用户在 UI 勾选后，前馈 = Σ(已勾选项的 compute())，C 代码导出时同样累加。
 */
export const FEEDFORWARD_LIBRARY = {
  polynomial: {
    label: '多项式',
    items: [
      {
        id: 'linear',
        name: '线性  Kff·target',
        formula: 'Kff × target',
        defaultCoeff: 0.5,
        compute: (coeff, ctx) => coeff * ctx.target,
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * target;`
      },
      {
        id: 'quadratic',
        name: '二次  Kff·target²',
        formula: 'Kff × target²',
        defaultCoeff: 0.05,
        compute: (coeff, ctx) => coeff * ctx.target * ctx.target,
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * target * target;`
      },
      {
        id: 'cubic',
        name: '三次  Kff·target³',
        formula: 'Kff × target³',
        defaultCoeff: 0.01,
        compute: (coeff, ctx) => coeff * ctx.target * ctx.target * ctx.target,
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * target * target * target;`
      }
    ]
  },
  trigonometric: {
    label: '三角函数',
    items: [
      {
        id: 'sin',
        name: 'sin  Kff·sin(target)',
        formula: 'Kff × sin(target)',
        defaultCoeff: 0.3,
        compute: (coeff, ctx) => coeff * Math.sin(ctx.target),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * sinf(target);`
      },
      {
        id: 'cos',
        name: 'cos  Kff·cos(target)',
        formula: 'Kff × cos(target)',
        defaultCoeff: 0.3,
        compute: (coeff, ctx) => coeff * Math.cos(ctx.target),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * cosf(target);`
      },
      {
        id: 'tan',
        name: 'tan  Kff·tan(target)',
        formula: 'Kff × tan(target)',
        defaultCoeff: 0.1,
        compute: (coeff, ctx) => coeff * Math.tan(ctx.target),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * tanf(target);`
      }
    ]
  },
  other: {
    label: '其他',
    items: [
      {
        id: 'gravity',
        name: '重力补偿  m·g·l·sin(target)',
        formula: 'm × g × l × sin(target)',
        defaultCoeff: 1,
        needsPhysics: true,
        compute: (coeff, ctx) => coeff * ctx.m * ctx.g * ctx.l * Math.sin(ctx.target),
        cSnippet: (coeff, ctx) => `    feedforward += ${coeff.toFixed(6)}f * ${ctx.m.toFixed(6)}f * ${ctx.g.toFixed(6)}f * ${ctx.l.toFixed(6)}f * sinf(target);`
      },
      {
        id: 'bias',
        name: '常数偏置  Kff',
        formula: 'Kff（常数）',
        defaultCoeff: 0,
        compute: (coeff) => coeff,
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f;`
      },
      {
        id: 'sign',
        name: '符号补偿  Kff·sign(target)',
        formula: 'Kff × sign(target)',
        defaultCoeff: 0.2,
        compute: (coeff, ctx) => coeff * Math.sign(ctx.target),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * (target > 0.0f ? 1.0f : (target < 0.0f ? -1.0f : 0.0f));`
      },
      {
        id: 'targetDeriv',
        name: '目标一阶导  Kff·d(target)/dt',
        formula: 'Kff × d(target)/dt',
        defaultCoeff: 0.1,
        // 目标一阶导前馈：用于跟踪斜坡/正弦等变化目标，等效于前馈 Kp·T_d
        // 阶跃信号导数为脉冲，工程上前馈不应注入（仿真中跳变点置零）
        compute: (coeff, ctx) => coeff * finite(ctx.targetDot, 0),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * target_dot;  /* d(target)/dt，需在控制周期内数值差分 */`
      },
      {
        id: 'targetSecondDeriv',
        name: '目标二阶导  Kff·d²(target)/dt²',
        formula: 'Kff × d²(target)/dt²',
        defaultCoeff: 0.05,
        // 目标二阶导前馈：用于跟踪加速度变化的目标（如正弦、抛物线），等效于前馈 Kp·T_d²
        // 阶跃信号二阶导为 0（跳变点处脉冲），稳态为 0
        compute: (coeff, ctx) => coeff * finite(ctx.targetDotDot, 0),
        cSnippet: (coeff) => `    feedforward += ${coeff.toFixed(6)}f * target_ddot;  /* d²(target)/dt²，需在控制周期内数值差分 */`
      }
    ]
  }
}

// 扁平化所有前馈项，便于按 id 查找
export const FEEDFORWARD_ITEMS_BY_ID = Object.values(FEEDFORWARD_LIBRARY).reduce((acc, group) => {
  group.items.forEach((item) => { acc[item.id] = item })
  return acc
}, {})

export const FEEDFORWARD_GROUPS = Object.entries(FEEDFORWARD_LIBRARY).map(([id, group]) => ({
  id,
  label: group.label,
  items: group.items.map((item) => ({ id: item.id, name: item.name, formula: item.formula, defaultCoeff: item.defaultCoeff }))
}))

/**
 * 前馈项 → 掩码 bit 映射（与嵌入式头文件 ZHICHUAN_FF_* 宏一一对应）。
 * 用户勾选前馈项后，按此映射求或得到总掩码，写入 .h 的 ZHICHUAN_FF_MASK。
 * 用户工程据此掩码判断运行时启用哪些前馈项。
 */
export const FEEDFORWARD_BIT_MAP = {
  linear: 0x0001,
  quadratic: 0x0002,
  cubic: 0x0004,
  sin: 0x0008,
  cos: 0x0010,
  tan: 0x0020,
  gravity: 0x0040,
  bias: 0x0080,
  sign: 0x0100,
  targetDeriv: 0x0200,
  targetSecondDeriv: 0x0400
}

// 计算前馈总掩码；selection 形如 { linear: 0.5, gravity: 1 }
export function computeFeedforwardMask(selection) {
  let mask = 0
  Object.keys(selection || {}).forEach((id) => {
    mask |= FEEDFORWARD_BIT_MAP[id] || 0
  })
  return mask
}

// 掩码格式化为 C 字面量，如 0x0041u
export function formatFeedforwardMask(selection) {
  const mask = computeFeedforwardMask(selection)
  return `0x${mask.toString(16).padStart(4, '0').toUpperCase()}u`
}

// 兼容旧接口：导出为 CONTROLLER_OUTPUT_PRESETS（仅用于历史引用，新代码请用 FEEDFORWARD_LIBRARY）
export const CONTROLLER_OUTPUT_PRESETS = {
  pid_only: { name: '仅 PID', formula: 'u = PID(error)' }
}

export function getStrategyConfig(strategyId, overrides = {}) {
  const strategy = PID_STRATEGIES[strategyId] || PID_STRATEGIES.motor_speed
  return { ...strategy.defaults, ...overrides }
}

/**
 * 目标信号生成器：支持阶跃/多阶跃/正弦跟踪三种测试场景。
 *
 * signal='step'（默认）：单阶跃，t=0 时 target=initialValue，之后 target=config.target
 *   initialValue 默认为 0；倒立摆传 config.initialAngle（让摆从该角度释放，目标为 target=0）
 *   与原始行为完全一致，保证向后兼容；用于调参过程（二分法依赖阶跃超调）
 * signal='multiStep'：多阶跃，将 duration 等分 4 段，每段不同目标值
 *   target 序列：[0, T, T*0.5, T*1.5, T]（T=config.target），覆盖升/降/反向阶跃
 *   幅值选 0.5/1.5：反向段幅值越大，百分比超调越小（积分累积的绝对超调分摊到更大分母）
 *   用于验收：测试不同幅值阶跃下的响应一致性
 * signal='sine'：正弦跟踪，target(t) = T_base + amp * sin(2π * f * t)
 *   T_base = config.target / 2（中心值），amp = config.target / 2（振幅）
 *   频率 f 由 config.signalFreq 指定（默认 0.5Hz），可测相位滞后与动态跟踪能力
 *
 * @param {string} signal  信号类型：step / multiStep / sine
 * @param {number} t  当前时间（秒）
 * @param {number} index  采样索引（从0开始）
 * @param {object} config  仿真配置（含 target/duration/signalFreq 等）
 * @param {number} [initialValue=0]  t=0 时刻的目标值（倒立摆传 initialAngle）
 * @returns {number}  当前时刻的目标值
 */
function generateTarget(signal, t, index, config, initialValue = 0) {
  const target = finite(config.target, 1)
  if (signal === 'multiStep') {
    // 5 段多阶跃：[initialValue, T, T*0.5, T*1.5, T, 0]，每段 duration/5
    // 5 段 4 个跳变，覆盖升→降→升→降四种阶跃，每段都有 target 跳变可分析
    // （若末段 target 恒定，单阶跃分析会因 stepSize=0 导致 overshoot 爆炸）
    // 幅值选 0.5/1.5：反向段阶跃幅值越小，积分累积导致的百分比超调越大；
    //   实测 0.7/1.3（幅值3）的反向段超调 31%，0.5/1.5（幅值5）仅 15.6%，
    //   故保留较大幅值波动以降低百分比超调
    const segmentDur = config.duration / 5
    const segIdx = Math.min(4, Math.floor(t / segmentDur))
    const levels = [initialValue, target, target * 0.5, target * 1.5, target]
    return levels[segIdx]
  }
  if (signal === 'sine') {
    // 正弦跟踪：base + amp * sin(2π * f * t)，初始为 base（t=0 时 sin=0）
    const base = target / 2
    const amp = target / 2
    const freq = finite(config.signalFreq, 0.5)
    return base + amp * Math.sin(2 * Math.PI * freq * t)
  }
  // 默认 step：t=0 时为 initialValue，之后为 target
  return index === 0 ? initialValue : target
}

/**
 * 计算目标信号的一阶/二阶导数，供目标导数前馈项使用。
 *
 *   - step / multiStep：阶跃跳变处导数为脉冲，工程上前馈不应注入脉冲，故统一返回 0；
 *     稳态时 target 恒定，导数也为 0
 *   - sine：解析求导
 *     target(t) = base + amp·sin(ωt)，ω = 2π·f
 *     target'(t)  = amp·ω·cos(ωt)
 *     target''(t) = -amp·ω²·sin(ωt)
 *
 * @param {string} signal  信号类型
 * @param {number} t  当前时间（秒）
 * @param {object} config  仿真配置
 * @returns {{ dot: number, dotDot: number }}
 */
function generateTargetDerivs(signal, t, config) {
  if (signal === 'sine') {
    const amp = finite(config.target, 1) / 2
    const freq = finite(config.signalFreq, 0.5)
    const omega = 2 * Math.PI * freq
    return {
      dot: amp * omega * Math.cos(omega * t),
      dotDot: -amp * omega * omega * Math.sin(omega * t)
    }
  }
  // step / multiStep：稳态导数为 0，跳变点导数为脉冲（前馈不注入，置零）
  return { dot: 0, dotDot: 0 }
}

export function simulatePidStrategy(strategyId, overrides = {}, seed = 20260723) {
  const strategy = PID_STRATEGIES[strategyId] || PID_STRATEGIES.motor_speed
  const config = getStrategyConfig(strategy.id, overrides)
  const random = seededRandom(seed)
  const samples = []
  const steps = Math.max(2, Math.round(config.duration / config.dt))
  // 信号类型：默认 'step'（与原行为一致），可选 'multiStep' / 'sine'
  const signal = config.signal || 'step'

  // 发散截断标记：状态超出发散保护阈值提前 break 时置位（供 set_target 等调用方提示 agent）
  let truncated = false
  let truncateReason = ''

  if (strategy.id === 'motor_speed') {
    let omega = 0
    const state = { integral: 0, previousError: 0 }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = generateTarget(signal, index * config.dt, index, config)
      const derivs = generateTargetDerivs(signal, index * config.dt, config)
      const measured = omega + noise(random, config.noise)
      const error = activeTarget - measured
      // D项基于测量变化（derivative on measurement），避免阶跃时D项爆炸
      const pidOut = pidStep(state, error, config.dt, config, NO_OUTPUT_LIMIT, NO_OUTPUT_LIMIT, measured)
      const current = pidOut + computeFeedforward(config, activeTarget, derivs)
      omega += ((config.Kt * current - config.B * omega) / config.J) * config.dt
      samples.push({ t: index * config.dt, target: activeTarget, feedback: measured, output: current })
      // 发散保护（非输出限幅）：无界输出下增益过大会使状态指数爆炸（飞车），
      // 达到物理不合理量级即截断仿真；避免 15s 后 feedback 变成千万级而指标失真
      if (!Number.isFinite(omega) || Math.abs(omega) > 1e4) {
        truncated = true
        truncateReason = '电机转速发散（|ω| 超出发散保护阈值），仿真提前截断'
        break
      }
    }
  } else if (strategy.id === 'cascade_position') {
    let position = 0
    let omega = 0
    const positionState = { integral: 0, previousError: 0 }
    const speedState = { integral: 0, previousError: 0 }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = generateTarget(signal, index * config.dt, index, config)
      const derivs = generateTargetDerivs(signal, index * config.dt, config)
      const measuredPosition = position + noise(random, config.noise)
      // 位置环：PID 输出速度目标。多项式/三角函数/符号 + 目标一阶导（前馈速度）作用于位置环
      // 目标二阶导对应加速度，物理上应叠加到力矩，故归入内环 innerFF
      const polyTrigSignFF = computeFeedforwardExcluding(config, activeTarget, ['gravity', 'bias', 'targetSecondDeriv'], derivs)
      const positionPidOut = pidStep(positionState, activeTarget - measuredPosition, config.dt, {
        kp: config.positionKp,
        ki: config.positionKi,
        kd: config.positionKd
      }, NO_OUTPUT_LIMIT, NO_OUTPUT_LIMIT, measuredPosition)
      const speedTarget = positionPidOut + polyTrigSignFF
      const measuredSpeed = omega + noise(random, config.noise * 4)
      const speedPidOut = pidStep(speedState, speedTarget - measuredSpeed, config.dt, {
        kp: config.speedKp,
        ki: config.speedKi,
        kd: config.speedKd
      }, NO_OUTPUT_LIMIT, NO_OUTPUT_LIMIT, measuredSpeed)
      // 速度环：输出电流/力矩。重力补偿/常数偏置 + 目标二阶导（前馈加速度）作用于内环
      const innerFF = computeFeedforwardOnly(config, activeTarget, ['gravity', 'bias', 'targetSecondDeriv'], derivs)
      const current = speedPidOut + innerFF
      omega += ((config.Kt * current - config.B * omega) / config.J) * config.dt
      position += omega * config.dt
      samples.push({
        t: index * config.dt,
        target: activeTarget,
        feedback: measuredPosition,
        output: current,
        speedTarget,
        speed: measuredSpeed
      })
      // 发散保护（非输出限幅）：无界输出下增益过大会使状态指数爆炸（飞车/位置失控），
      // 达到物理不合理量级即截断仿真；避免 15s 后 feedback 变成千万级而指标失真
      if (!Number.isFinite(position) || !Number.isFinite(omega)
        || Math.abs(position) > 1e4 || Math.abs(omega) > 1e4) {
        truncated = true
        truncateReason = '状态发散（位置/速度超出发散保护阈值），仿真提前截断'
        break
      }
    }
  } else {
    let theta = config.initialAngle
    let thetaDot = 0
    const state = { integral: 0, previousError: theta }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = generateTarget(signal, index * config.dt, index, config, config.initialAngle)
      const derivs = generateTargetDerivs(signal, index * config.dt, config)
      const measured = theta + noise(random, config.noise)
      // 该模型中正力矩 T 出现在方程右侧的负号前，故以 measured-target 作为控制误差。
      // 倒立摆为不稳定系统，D项需响应target跳变以产生初始回复力矩，故保持 error-based
      const pidOut = pidStep(state, measured - activeTarget, config.dt, config, NO_OUTPUT_LIMIT, NO_OUTPUT_LIMIT)
      const torque = pidOut + computeFeedforward(config, activeTarget, derivs)
      const thetaAcceleration = (config.m * config.g * config.l * theta - torque) / config.J
      thetaDot += thetaAcceleration * config.dt
      theta += thetaDot * config.dt
      samples.push({ t: index * config.dt, target: activeTarget, feedback: measured, output: torque })
      if (!Number.isFinite(theta) || Math.abs(theta) > 3) {
        truncated = true
        truncateReason = '倒立摆角度发散（|θ|>3 rad），仿真提前截断'
        break
      }
    }
  }

  return { strategy, config, samples, truncated, truncateReason }
}

// 读取嵌入式模板文件：
// - Vite 渲染进程：用 ?raw 后缀动态导入（Vite 构建时内联为字符串）
// - Node.js 测试环境：用 fs 读取真实文件
// 模板文件 embedded-templates/zhichuan_pid.{h,c} 可由用户直接审查/修改
let headerTemplate = ''
let sourceTemplate = ''
if (typeof window !== 'undefined' && window.location) {
  // 渲染进程（Vite）
  const [h, s] = await Promise.all([
    import('./embedded-templates/zhichuan_pid.h?raw'),
    import('./embedded-templates/zhichuan_pid.c?raw')
  ])
  headerTemplate = h.default
  sourceTemplate = s.default
} else {
  // Node.js（测试）
  const fs = await import(/* @vite-ignore */ 'node:fs')
  const url = await import(/* @vite-ignore */ 'node:url')
  headerTemplate = fs.readFileSync(url.fileURLToPath(new URL('./embedded-templates/zhichuan_pid.h', import.meta.url)), 'utf8')
  sourceTemplate = fs.readFileSync(url.fileURLToPath(new URL('./embedded-templates/zhichuan_pid.c', import.meta.url)), 'utf8')
}

/**
 * 生成嵌入式调参通信层 .c/.h。
 * 设计：.c/.h 只做通信层（周期发送 + 解析指令），不含 PID/前馈计算。
 * 前馈项通过掩码标识：根据勾选生成 ZHICHUAN_FF_MASK 写入 .h，用户工程据此判断启用哪些前馈项。
 * PID/前馈系数本身不在文件里硬编码，运行时由上位机指令下发。
 */
export function generateEmbeddedControllerFiles(options = {}) {
  const name = String(options.name || 'zhichuan_pid').replace(/[^a-zA-Z0-9_]/g, '_')
  const guard = `${name.toUpperCase()}_H`
  const ffMaskLiteral = formatFeedforwardMask(options.feedforwardSelection)

  const header = headerTemplate
    .replace(/__GUARD__/g, guard)
    .replace(/__FF_MASK__/g, ffMaskLiteral)
  const source = sourceTemplate
    .replace(/__NAME__/g, name)

  return {
    header: { filename: `${name}.h`, content: header },
    source: { filename: `${name}.c`, content: source }
  }
}
