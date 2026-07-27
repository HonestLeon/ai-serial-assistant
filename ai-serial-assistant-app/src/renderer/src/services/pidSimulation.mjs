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

// 前馈项计算：遍历已勾选项求和。feedforwardSelection 形如 { linear: 0.5, gravity: 1 }
// 未勾选（不在对象中）的项不参与；coeff 为该项系数
function computeFeedforward(config, target) {
  return computeFeedforwardFiltered(config, target, null, null)
}

// 只计算指定 id 集合内的前馈项
function computeFeedforwardOnly(config, target, includeIds) {
  return computeFeedforwardFiltered(config, target, includeIds, null)
}

// 排除指定 id 集合的前馈项
function computeFeedforwardExcluding(config, target, excludeIds) {
  return computeFeedforwardFiltered(config, target, null, excludeIds)
}

function computeFeedforwardFiltered(config, target, includeIds, excludeIds) {
  const selection = config.feedforwardSelection || {}
  const ids = Object.keys(selection)
  if (!ids.length) return 0
  const ctx = {
    target,
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
    acceptance: { overshootLimit: 10, settlingBand: 0.05, oscillationLimit: 10 },
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
    acceptance: { overshootLimit: 15, settlingBand: 0.04, oscillationLimit: 8 },
    defaults: {
      duration: 5,
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
  sign: 0x0100
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

export function simulatePidStrategy(strategyId, overrides = {}, seed = 20260723) {
  const strategy = PID_STRATEGIES[strategyId] || PID_STRATEGIES.motor_speed
  const config = getStrategyConfig(strategy.id, overrides)
  const random = seededRandom(seed)
  const samples = []
  const steps = Math.max(2, Math.round(config.duration / config.dt))

  if (strategy.id === 'motor_speed') {
    let omega = 0
    const state = { integral: 0, previousError: 0 }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = index === 0 ? 0 : config.target
      const measured = omega + noise(random, config.noise)
      const error = activeTarget - measured
      // D项基于测量变化（derivative on measurement），避免阶跃时D项爆炸
      const pidOut = pidStep(state, error, config.dt, config, config.outputLimit, config.outputLimit, measured)
      const current = clamp(pidOut + computeFeedforward(config, activeTarget), -config.outputLimit, config.outputLimit)
      omega += ((config.Kt * current - config.B * omega) / config.J) * config.dt
      samples.push({ t: index * config.dt, target: activeTarget, feedback: measured, output: current })
    }
  } else if (strategy.id === 'cascade_position') {
    let position = 0
    let omega = 0
    const positionState = { integral: 0, previousError: 0 }
    const speedState = { integral: 0, previousError: 0 }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = index === 0 ? 0 : config.target
      const measuredPosition = position + noise(random, config.noise)
      // 位置环：PID 输出速度目标。多项式/三角函数/符号类前馈作用于位置环（叠加到速度目标）
      const polyTrigSignFF = computeFeedforwardExcluding(config, activeTarget, ['gravity', 'bias'])
      const positionPidOut = pidStep(positionState, activeTarget - measuredPosition, config.dt, {
        kp: config.positionKp,
        ki: config.positionKi,
        kd: config.positionKd
      }, config.speedLimit, config.speedLimit, measuredPosition)
      const speedTarget = clamp(positionPidOut + polyTrigSignFF, -config.speedLimit, config.speedLimit)
      const measuredSpeed = omega + noise(random, config.noise * 4)
      const speedPidOut = pidStep(speedState, speedTarget - measuredSpeed, config.dt, {
        kp: config.speedKp,
        ki: config.speedKi,
        kd: config.speedKd
      }, config.outputLimit, config.outputLimit, measuredSpeed)
      // 速度环：输出电流/力矩。重力补偿/常数偏置作用于内环（叠加到力矩）
      const innerFF = computeFeedforwardOnly(config, activeTarget, ['gravity', 'bias'])
      const current = clamp(speedPidOut + innerFF, -config.outputLimit, config.outputLimit)
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
    }
  } else {
    let theta = config.initialAngle
    let thetaDot = 0
    const state = { integral: 0, previousError: theta }
    for (let index = 0; index <= steps; index += 1) {
      const activeTarget = index === 0 ? config.initialAngle : config.target
      const measured = theta + noise(random, config.noise)
      // 该模型中正力矩 T 出现在方程右侧的负号前，故以 measured-target 作为控制误差。
      // 倒立摆为不稳定系统，D项需响应target跳变以产生初始回复力矩，故保持 error-based
      const pidOut = pidStep(state, measured - activeTarget, config.dt, config, config.outputLimit)
      const torque = clamp(pidOut + computeFeedforward(config, activeTarget), -config.outputLimit, config.outputLimit)
      const thetaAcceleration = (config.m * config.g * config.l * theta - torque) / config.J
      thetaDot += thetaAcceleration * config.dt
      theta += thetaDot * config.dt
      samples.push({ t: index * config.dt, target: activeTarget, feedback: measured, output: torque })
      if (!Number.isFinite(theta) || Math.abs(theta) > 3) break
    }
  }

  return { strategy, config, samples }
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
