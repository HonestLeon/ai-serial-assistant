import { simulatePidStrategy } from '../ai-serial-assistant-app/src/renderer/src/services/pidSimulation.mjs'
import { analyzeControlSamples } from '../ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs'

export const PRESETS = {
  pure: { name: '纯 P · 看稳态误差', kp: 1, ki: 0, kd: 0 },
  slow: { name: '响应偏慢', kp: 0.12, ki: 0.15, kd: 0 },
  overshoot: { name: '明显超调', kp: 0.3, ki: 12, kd: 0.004 },
  balanced: { name: '参考参数', kp: 1.2, ki: 4, kd: 0.002 }
}
export const PARAMS = {
  kp: { min: 0, max: 8, step: 0.01 },
  ki: { min: 0, max: 20, step: 0.01 },
  kd: { min: 0, max: 0.02, step: 0.001 },
  target: { min: 1, max: 30, step: 1 }
}
export function runSimulation(input) {
  const config = {}
  for (const [key, range] of Object.entries(PARAMS)) {
    const value = Number(input[key])
    if (!Number.isFinite(value) || value < range.min || value > range.max) throw new Error(`${key} 超出演示范围`)
    config[key] = value
  }
  const result = simulatePidStrategy('motor_speed', { ...config, duration: 4, dt: 0.002, noise: input.noise ? 0.02 : 0 }, 20261008)
  return { ...result, metrics: analyzeControlSamples(result.samples, { settlingBand: 0.05, overshootLimit: 10, oscillationLimit: 10 }) }
}
export function toCsv(samples) {
  return '\uFEFF时间_s,目标转速_rad_s,反馈转速_rad_s,控制电流_A\r\n' +
    samples.map(s => [s.t, s.target, s.feedback, s.output].join(',')).join('\r\n')
}
