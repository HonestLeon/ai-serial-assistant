import { buildFallbackSuggestion } from '../../pidSafety.mjs'

export const STRATEGIES = Object.freeze([
  { id: 'staged_pid', description: '单环 P→PI→PID 确定性整定；每次最多调整一次并验证，不适用于串级或自定义参数键。' },
  { id: 'recover_pid', description: '单环超调或振荡恢复；复用本地保守建议，只允许降低增益，不宣称恢复成功。' }
])

// 策略只编排已有工具；所有写入、采集和回退继续经过原安全路径。
export function createStrategyTools({ controller, baseTools, getObservation }) {
  const tools = new Map(baseTools.map(tool => [tool.name, tool]))
  const call = (name, args) => tools.get(name).execute(args)
  const stopped = () => controller.isStopped?.() === true
  return [
    {
      name: 'list_pid_strategies',
      description: '查看可用确定性整定策略、适用范围和执行边界。策略无需额外调用模型。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ strategies: STRATEGIES, maxAdjustmentsPerCall: 1,
        fallback: '不适用或证据无效时继续使用 get_channel_stats / set_pid_params / set_target。' })
    },
    {
      name: 'run_pid_strategy',
      description: '执行一次单环确定性策略：读取最近一次 set_target 的完整实测指标→调整→同目标复测。先调用 set_target。自动读取证据，不接受模型编造指标；串口窗口未满返回 waiting，不修改参数。串级不支持，使用基础工具。返回依据、实际参数、验证指标和安全结果；不保证改善。',
      parameters: {
        type: 'object', properties: { strategy: { type: 'string', enum: STRATEGIES.map(s => s.id) } },
        required: ['strategy'], additionalProperties: false
      },
      execute: async (args = {}) => {
        if (!args || Object.keys(args).some(key => key !== 'strategy') || !STRATEGIES.some(s => s.id === args.strategy)) {
          throw new Error('必须指定有效 strategy：staged_pid 或 recover_pid')
        }
        const audit = { strategy: args.strategy, version: 1, adjustments: 0 }
        const finish = (status, reason, extra = {}) => ({ ...audit, status, reason, ...extra })
        if (stopped()) return finish('stopped', '会话已停止')
        const defs = controller.getUserConfig()?.pid ?? []
        if (defs.length !== 3 || !['kp', 'ki', 'kd'].every(key => defs.some(d => d.key === key))) {
          return finish('unsupported', '本版只支持单环 kp/ki/kd；串级请用基础工具分别整定内外环。')
        }
        const observation = getObservation()
        if (!observation) return finish('needs_data', '先调用 set_target 采集当前参数的响应。')
        const current = controller.getPid()
        if (!defs.every(def => ['min', 'max', 'init'].every(key => Number.isFinite(def[key]))
          && def.min >= 0 && def.min <= Math.min(def.max, def.key === 'kp' ? 20 : 10)
          && def.init >= def.min && def.init <= def.max)
          || !['kp', 'ki', 'kd'].every(key => Number.isFinite(current[key]) && current[key] >= 0)) {
          return finish('invalid_config', 'PID 参数或范围不合法，或与系统上限冲突；未修改参数。')
        }
        const matches = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
        if (!matches(current, observation.pid) || !matches(controller.getFeedforward(), observation.feedforward)
          || controller.getTarget() !== observation.target) {
          return finish('stale_data', '采集后参数或目标已改变，必须重新 set_target。')
        }
        if (observation.truncated || (observation.safety?.triggered && (observation.safety.rollbackPid || args.strategy !== 'recover_pid'))) {
          return finish('safety_stop', '最近采集触发安全机制或仿真截断；请查看安全消息并使用基础工具处理。', { safety: observation.safety })
        }
        const range = observation.timeRange
        const available = controller.getDataBuffer().getRange()
        if (available.end == null || available.end < range[1]) return finish('waiting', '采集窗口尚未完成，请等待后再次调用。', { timeRange: range })
        if (available.start > range[0]) return finish('needs_data', '窗口起点已被缓冲区淘汰，重新采集。')
        const before = await call('get_channel_stats', { timeRange: range })
        const metrics = before.stepMetrics
        if (!metrics?.valid || !['STABLE', 'STILL_RISING', 'SLOW_RESPONSE', 'OVERSHOOTING', 'OSCILLATING'].includes(metrics.status)
          || !['rmse', 'steadyError', 'overshoot', 'oscillation', 'stepSize'].every(key => Number.isFinite(metrics[key]))
          || Math.abs(metrics.stepSize) < 1e-9) {
          return finish('needs_data', '缺少有限、有效的阶跃指标，未修改参数。')
        }
        if (before.acceptanceCheck?.passed) return finish('accepted', '当前窗口已达标，无需调整。', { before })
        if (args.strategy === 'recover_pid' && !['OVERSHOOTING', 'OSCILLATING'].includes(metrics.status)) {
          return finish('not_applicable', '恢复策略仅用于超调或振荡。', { before })
        }
        const selected = Object.fromEntries(['kp', 'ki', 'kd'].map(key => [key, current[key]]))
        const suggestion = buildFallbackSuggestion(metrics, selected)
        if (args.strategy === 'recover_pid') {
          for (const key of Object.keys(suggestion.params)) suggestion.params[key] = Math.min(selected[key], suggestion.params[key])
        }
        // 原算法全零 P 无法自启动，使用用户配置的合法初始 P；没有正初值则交回模型。
        if (selected.kp === 0 && suggestion.params.kp === 0) {
          const initial = defs.find(d => d.key === 'kp')?.init
          if (args.strategy === 'staged_pid' && Number.isFinite(initial) && initial > 0) suggestion.params.kp = initial
          else return finish('not_applicable', 'P 为零且没有可用初值，请用基础工具设置初始参数。')
        }
        if (stopped()) return finish('stopped', '调整前会话已停止')
        const applied = await call('set_pid_params', suggestion.params)
        audit.adjustments = 1
        const details = { basis: suggestion.reason, phase: suggestion.phase, before, proposed: suggestion.params, applied }
        if (stopped()) return finish('stopped', '已调整参数，验证前会话停止。', details)
        try {
          const capture = await call('set_target', { value: observation.target })
          if (capture.mode === 'serial') return finish('pending_validation', '已下发一次调整，等待真实数据窗口；尚不能判断改善。', { ...details, capture })
          const after = await call('get_channel_stats', { timeRange: capture.timeRange })
          return finish(capture.safety?.triggered || capture.truncated ? 'safety_stop' : 'evaluated',
            '单次策略结束；依据验证指标和安全结果决定下一步。',
            { ...details, capture, after, finalPid: controller.getPid(), next: '达标则总结，否则选择下一策略或基础工具；安全停止时优先处理安全消息。' })
        } catch (error) {
          return finish('validation_failed', '参数已修改但验证失败；先用基础工具重新采集，不要继续盲调。', { ...details, error: error.message, finalPid: controller.getPid() })
        }
      }
    }
  ]
}
