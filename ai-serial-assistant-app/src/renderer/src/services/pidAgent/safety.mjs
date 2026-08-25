/**
 * PID 调参智能体 —— 安全兜底护栏。
 *
 * 纯 JS 模块（无 Vue/DOM/window 依赖），渲染进程与 Node 测试共用。
 *
 * 职责（借鉴 llm-pid-tuner 的 pid_safety + Pi-agent 的安全护栏思路）：
 *   1. set_target 工具每完成一次样本采集后调用 onSamplesCollected(samples)；
 *   2. 用 analyzeControlSamples 得到确定性指标，滚动维护「最佳稳定参数」bestStable
 *      （仅 STABLE 轮次可入选，避免把坏参数记录成回退目标）；
 *   3. 指标越过用户验收阈值（超调/振荡）或相对 bestStable 明显劣化时触发安全兜底：
 *      自动把 PID 参数回退到 bestStable.pid，并产出一条 safety 消息文本。
 *
 * 注意：把 safety 消息推入 steer 队列、终止会话等编排职责在引擎层（agentLoop），
 * 本模块只做判定、回退与消息文本产出，不直接操作对话队列。
 */
import { analyzeControlSamples } from '../controlAnalysis.mjs'
import { maybeUpdateBestResult, shouldRollbackToBest } from '../pidSafety.mjs'

// 与 analyzeControlSamples 的默认阈值保持一致（用户配置缺失时的兜底值）
const finiteOr = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 创建安全兜底护栏。
 *
 * @param {object} options
 * @param {object} options.userConfig        用户配置（使用 acceptance.overshootLimit / oscillationLimit）
 * @param {() => object} options.getPid      读取当前下发中的 PID 参数（快照）
 * @param {(pid: object) => void} options.setPid 回退时写入 PID 参数
 * @param {(event: object) => void} [options.emit] 安全事件回调（{ type:'safety_triggered', message, metrics, rollbackPid }）
 * @returns {{ onSamplesCollected, getBestStable, reset }}
 */
export function createSafetyGuard({ userConfig, getPid, setPid, emit = null }) {
  // 最佳稳定记录：maybeUpdateBestResult 格式 { pid, metrics, score, round }，初始无记录
  let bestStable = null
  // 采集轮次计数（每次 onSamplesCollected 自增）
  let round = 0

  const acceptance = userConfig?.acceptance ?? {}
  const overshootLimit = finiteOr(acceptance.overshootLimit, 20)
  const oscillationLimit = finiteOr(acceptance.oscillationLimit, 10)

  /**
   * 样本采集完成后的安全检测（由 set_target 工具调用）。
   * @param {Array<{t:number,target:number,feedback:number,output?:number}>} samples
   * @returns {{triggered:false, bestUpdated:boolean, metrics:object}
   *          |{triggered:true, message:string, rollbackPid:object|null, metrics:object}}
   */
  const onSamplesCollected = (samples) => {
    // 1. 确定性指标分析（阈值取自用户验收配置）
    const metrics = analyzeControlSamples(samples, {
      overshootLimit,
      oscillationLimit
    })

    // 2. 轮次自增 + 滚动更新最佳稳定记录（仅 STABLE 且更优时更新）
    round += 1
    const prevBest = bestStable
    bestStable = maybeUpdateBestResult(bestStable, { pid: getPid(), metrics, round })
    const bestUpdated = bestStable !== prevBest

    // 3. 触发判定（仅有效指标参与；超调越限 / 真实振荡越限 或 相对最佳记录明显劣化）
    if (metrics.valid) {
      const overshoot = finiteOr(metrics.overshoot, 0)
      const oscillation = finiteOr(metrics.oscillation, 0)
      const rollback = shouldRollbackToBest(bestStable, metrics)
      const overOvershoot = overshoot > overshootLimit
      // 真振荡门槛：包络幅度超限且存在真实过零振荡（峰数 > 0 或明显震荡标记）才触发。
      // oscillation 是尾段包络（max-min）归一化值，串级等慢收敛系统在窗口内未到稳态时
      // 会把「单调残余爬升」误报成高振荡（实测恒定 10~11%）；而 hasSignificantOscillation /
      // oscillationPeakCount 基于过零峰检测，只有反馈真正在目标上下振荡才有峰。
      // 修复后：未收敛爬升不再误触发，真实极限环（Ki 过大、过零振荡）仍会触发。
      const hasRealOscillation =
        Boolean(metrics.hasSignificantOscillation) || (Number(metrics.oscillationPeakCount) || 0) > 0
      const overOscillation = oscillation > oscillationLimit && hasRealOscillation

      if (overOvershoot || overOscillation || rollback.shouldRollback) {
        // 4. 触发安全兜底：回退到最佳稳定参数（无记录时无法回退，仅提示回调）
        const rollbackPid = bestStable?.pid ?? null
        if (rollbackPid !== null) {
          setPid(rollbackPid)
        }

        let message
        if (overOvershoot) {
          message = `[安全机制] 检测到超调 ${overshoot.toFixed(1)}% 超过安全限制 ${overshootLimit}%，`
        } else if (overOscillation) {
          message = `[安全机制] 检测到振荡 ${oscillation.toFixed(1)}% 超过安全限制 ${oscillationLimit}%，`
        } else {
          message = `[安全机制] 检测到响应明显劣化（${rollback.reason}），`
        }
        message += rollbackPid !== null
          ? `参数已自动回退至 ${JSON.stringify(rollbackPid)}。请在后续调参中避免超出该边界。`
          : `暂无已验证的稳定参数可回退，请回调参数。`

        emit?.({ type: 'safety_triggered', message, metrics, rollbackPid })
        return { triggered: true, message, rollbackPid, metrics }
      }
    }

    // 5. 未触发：返回本轮指标与最佳记录是否更新
    return { triggered: false, bestUpdated, metrics }
  }

  return {
    onSamplesCollected,
    /** 当前最佳稳定记录（无记录时为 null） */
    getBestStable: () => bestStable,
    /** 重置内部状态（新一轮调参会话开始时调用） */
    reset: () => {
      bestStable = null
      round = 0
    }
  }
}
