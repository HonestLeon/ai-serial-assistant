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

function pidStep(state, error, dt, gains, outputLimit) {
  state.integral = clamp(state.integral + error * dt, -outputLimit, outputLimit)
  const derivative = (error - state.previousError) / dt
  state.previousError = error
  return clamp(
    gains.kp * error + gains.ki * state.integral + gains.kd * derivative,
    -outputLimit,
    outputLimit
  )
}

export const PID_STRATEGIES = {
  motor_speed: {
    id: 'motor_speed',
    name: '电机速度环（一阶模型）',
    description: 'J·dω/dt + B总·ω = Kt·i；被控量为转速，控制量为电流。',
    parameters: ['Kp', 'Ki', 'Kd'],
    defaultOrder: ['Kp', 'Ki', 'Kd'],
    acceptance: { overshootLimit: 20, settlingBand: 0.05, oscillationLimit: 10 },
    defaults: {
      duration: 4,
      dt: 0.01,
      noise: 0.08,
      target: 10,
      J: 0.02,
      B: 0.08,
      Kt: 0.5,
      outputLimit: 12,
      kp: 2,
      ki: 4,
      kd: 0.02
    }
  },
  cascade_position: {
    id: 'cascade_position',
    name: '位置—速度串级 PID',
    description: '外环位置 PID 给出目标速度，内环速度 PID 给出电流控制量。',
    parameters: ['速度环Kp', '速度环Ki', '位置环Kp', '位置环Ki', '位置环Kd'],
    defaultOrder: ['速度环Kp', '速度环Ki', '位置环Kp', '位置环Ki', '位置环Kd'],
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
      speedKp: 2,
      speedKi: 4,
      speedKd: 0.01,
      positionKp: 4,
      positionKi: 0.3,
      positionKd: 0.15
    }
  },
  inverted_pendulum: {
    id: 'inverted_pendulum',
    name: '不稳定二阶系统（倒立摆）',
    description: 'J·θ¨ − mgl·θ = −T；被控量为摆角，控制量为力矩。',
    parameters: ['Kp', 'Kd', 'Ki'],
    defaultOrder: ['Kp', 'Kd', 'Ki'],
    acceptance: { overshootLimit: 25, settlingBand: 0.03, oscillationLimit: 12 },
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
      kp: 4,
      ki: 0.15,
      kd: 1.2
    }
  }
}

export const CONTROLLER_OUTPUT_PRESETS = {
  pid_only: {
    name: '仅 PID',
    formula: 'u = PID(error)'
  },
  linear_feedforward: {
    name: 'PID + 线性前馈',
    formula: 'u = PID(error) + Kff × target'
  },
  gravity_compensation: {
    name: 'PID + 重力补偿',
    formula: 'u = PID(error) + m × g × l × sin(target)'
  }
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
      const current = pidStep(state, error, config.dt, config, config.outputLimit)
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
      const speedTarget = pidStep(positionState, activeTarget - measuredPosition, config.dt, {
        kp: config.positionKp,
        ki: config.positionKi,
        kd: config.positionKd
      }, config.speedLimit)
      const measuredSpeed = omega + noise(random, config.noise * 4)
      const current = pidStep(speedState, speedTarget - measuredSpeed, config.dt, {
        kp: config.speedKp,
        ki: config.speedKi,
        kd: config.speedKd
      }, config.outputLimit)
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
      const torque = pidStep(state, measured - activeTarget, config.dt, config, config.outputLimit)
      const thetaAcceleration = (config.m * config.g * config.l * theta - torque) / config.J
      thetaDot += thetaAcceleration * config.dt
      theta += thetaDot * config.dt
      samples.push({ t: index * config.dt, target: activeTarget, feedback: measured, output: torque })
      if (!Number.isFinite(theta) || Math.abs(theta) > 3) break
    }
  }

  return { strategy, config, samples }
}

export function generateEmbeddedControllerFiles(options = {}) {
  const name = String(options.name || 'zhichuan_pid').replace(/[^a-zA-Z0-9_]/g, '_')
  const guard = `${name.toUpperCase()}_H`
  const preset = options.outputPreset || 'pid_only'
  const kff = Number(options.kff) || 0
  const kp = Number(options.kp) || 0
  const ki = Number(options.ki) || 0
  const kd = Number(options.kd) || 0
  const header = `#ifndef ${guard}
#define ${guard}

typedef float (*ZhichuanReadFn)(void);
typedef void (*ZhichuanWriteFn)(float value);

typedef struct {
    float kp, ki, kd;
    float integral, previous_error;
    float output_min, output_max;
    ZhichuanReadFn read_feedback;
    ZhichuanWriteFn write_output;
} ZhichuanPid;

void zhichuan_pid_init(ZhichuanPid *pid, ZhichuanReadFn read_fn, ZhichuanWriteFn write_fn);
float zhichuan_pid_update(ZhichuanPid *pid, float target, float dt);

#endif
`
  const feedforward = preset === 'linear_feedforward'
    ? `const float feedforward = ${kff.toFixed(6)}f * target;`
    : preset === 'gravity_compensation'
      ? 'const float feedforward = 9.81f * sinf(target); /* 请按真实 m、l 修正 */'
      : 'const float feedforward = 0.0f;'
  const source = `#include "${name}.h"
#include <math.h>

static float clampf(float value, float min_value, float max_value) {
    return value < min_value ? min_value : (value > max_value ? max_value : value);
}

void zhichuan_pid_init(ZhichuanPid *pid, ZhichuanReadFn read_fn, ZhichuanWriteFn write_fn) {
    pid->kp = ${kp.toFixed(6)}f;
    pid->ki = ${ki.toFixed(6)}f;
    pid->kd = ${kd.toFixed(6)}f;
    pid->integral = 0.0f;
    pid->previous_error = 0.0f;
    pid->output_min = -100.0f;
    pid->output_max = 100.0f;
    pid->read_feedback = read_fn;
    pid->write_output = write_fn;
}

float zhichuan_pid_update(ZhichuanPid *pid, float target, float dt) {
    const float feedback = pid->read_feedback();
    const float error = target - feedback;
    pid->integral += error * dt;
    const float derivative = dt > 0.0f ? (error - pid->previous_error) / dt : 0.0f;
    pid->previous_error = error;
    ${feedforward}
    const float output = clampf(pid->kp * error + pid->ki * pid->integral +
        pid->kd * derivative + feedforward, pid->output_min, pid->output_max);
    pid->write_output(output);
    return output;
}
`
  return {
    header: { filename: `${name}.h`, content: header },
    source: { filename: `${name}.c`, content: source }
  }
}
