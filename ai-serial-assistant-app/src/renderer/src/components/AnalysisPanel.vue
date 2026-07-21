<script setup>
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DataAnalysis, Download, MagicStick, Refresh } from '@element-plus/icons-vue'
import {
  analyzeControlSamples,
  buildPidSuggestion,
  buildStructuredAiContext,
  createSamplesFromChannels
} from '../services/controlAnalysis.mjs'

const props = defineProps({
  serialContext: { type: Object, required: true },
  aiConfig: { type: Object, required: true }
})

const mapping = reactive({ target: 0, feedback: 1, output: 2 })
const sampleIntervalMs = ref(50)
const currentPid = reactive({ kp: 1.8, ki: 0.22, kd: 0.12 })
const metrics = ref(null)
const suggestion = ref(null)
const aiExplanation = ref('')
const aiLoading = ref(false)
const analyzedAt = ref('')

const samples = computed(() => createSamplesFromChannels(
  props.serialContext.channelHistory,
  mapping,
  sampleIntervalMs.value
))

const availableCount = computed(() => samples.value.length)

const metricCards = computed(() => {
  const value = metrics.value
  if (!value?.valid) return []
  return [
    { label: '上升时间', value: formatMetric(value.riseTime, 's') },
    { label: '稳定时间', value: formatMetric(value.settlingTime, 's') },
    { label: '超调率', value: formatMetric(value.overshoot, '%'), danger: value.overshoot > value.limits.overshoot },
    { label: '稳态误差', value: formatMetric(value.steadyError, '') },
    { label: 'RMSE', value: formatMetric(value.rmse, '') },
    { label: '稳态波动', value: formatMetric(value.oscillation, '%'), danger: value.oscillation > value.limits.oscillation }
  ]
})

function formatMetric(value, unit) {
  return value === null || value === undefined ? '未收敛' : `${value}${unit}`
}

function runAnalysis() {
  metrics.value = analyzeControlSamples(samples.value, {
    overshootLimit: 20,
    oscillationLimit: 10,
    settlingBand: 0.05
  })
  if (!metrics.value.valid) {
    suggestion.value = null
    ElMessage.warning(metrics.value.reason)
    return
  }
  suggestion.value = buildPidSuggestion(metrics.value, currentPid)
  analyzedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
  aiExplanation.value = ''
  ElMessage.success('确定性分析完成：候选参数不会自动下发')
}

async function requestAiExplanation() {
  if (!metrics.value?.valid || !suggestion.value) runAnalysis()
  if (!metrics.value?.valid) return
  if (!props.aiConfig.apiKey) {
    ElMessage.warning('未配置 DeepSeek API Key；本地确定性分析仍可正常使用')
    return
  }

  aiLoading.value = true
  aiExplanation.value = ''
  const context = buildStructuredAiContext(metrics.value, suggestion.value, {
    system: '串口采集的一阶/多阶控制对象',
    scenario: '电赛赛前阶跃响应调参'
  })
  try {
    const baseUrl = props.aiConfig.baseUrl.replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: props.aiConfig.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是控制工程解释助手。只能基于给定指标解释，不得声称已控制硬件，不得越过参数边界。输出：现象、证据、候选调整理由、风险、下一步实验。'
          },
          { role: 'user', content: JSON.stringify(context, null, 2) }
        ]
      })
    })
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`)
    const data = await response.json()
    aiExplanation.value = data.choices?.[0]?.message?.content || '模型未返回可用内容'
  } catch (error) {
    aiExplanation.value = `AI 解释不可用：${error.message}。本地确定性指标与候选参数不受影响。`
  } finally {
    aiLoading.value = false
  }
}

function exportReport() {
  if (!metrics.value?.valid) {
    ElMessage.warning('请先完成一次确定性分析')
    return
  }
  const escape = (value) => String(value ?? '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  const rows = metricCards.value.map((item) => `<tr><td>${escape(item.label)}</td><td>${escape(item.value)}</td></tr>`).join('')
  const reasons = suggestion.value.reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>智串AI控制响应报告</title><style>body{font:14px/1.7 system-ui;margin:40px;color:#17202a}h1{color:#13795b}table{border-collapse:collapse;width:100%;max-width:720px}td,th{border:1px solid #ccd6dd;padding:8px;text-align:left}.tag{display:inline-block;padding:3px 10px;background:#e9f8f1;color:#13795b;border-radius:20px}</style><body><h1>智串AI · 控制响应分析报告</h1><p>生成时间：${escape(analyzedAt.value)}</p><p>数据量：${metrics.value.sampleCount} 点｜健康状态：<span class="tag">${escape(metrics.value.health)}</span></p><h2>确定性指标</h2><table><tbody>${rows}</tbody></table><h2>有界 PID 候选</h2><p>Kp=${suggestion.value.kp}，Ki=${suggestion.value.ki}，Kd=${suggestion.value.kd}；置信度：${suggestion.value.confidence}</p><ul>${reasons}</ul><h2>风险提示</h2><ul>${metrics.value.risks.map((risk) => `<li>${escape(risk)}</li>`).join('') || '<li>当前阈值内未发现明显风险</li>'}</ul><h2>AI 解释</h2><pre style="white-space:pre-wrap">${escape(aiExplanation.value || '未调用在线模型')}</pre><p><strong>声明：</strong>本报告仅提供候选建议，参数必须经人工确认后才能下发设备。</p></body></html>`
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `智串AI分析报告_${Date.now()}.html`
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <div class="analysis-page">
    <div class="page-head">
      <div>
        <div class="eyebrow"><el-icon><DataAnalysis /></el-icon> 本地确定性分析</div>
        <h2>把波形变成可复核的调参证据</h2>
        <p>先计算指标，再让 AI 解释；任何参数只进入候选区，不会自动下发。</p>
      </div>
      <div class="head-actions">
        <el-button :icon="Refresh" @click="runAnalysis">重新分析</el-button>
        <el-button type="primary" :icon="Download" @click="exportReport">导出报告</el-button>
      </div>
    </div>

    <div class="config-card">
      <div class="field">
        <label>目标值通道</label>
        <el-select v-model="mapping.target">
          <el-option v-for="index in 8" :key="index" :label="`I${index - 1}`" :value="index - 1" />
        </el-select>
      </div>
      <div class="field">
        <label>反馈值通道</label>
        <el-select v-model="mapping.feedback">
          <el-option v-for="index in 8" :key="index" :label="`I${index - 1}`" :value="index - 1" />
        </el-select>
      </div>
      <div class="field">
        <label>控制量通道</label>
        <el-select v-model="mapping.output">
          <el-option v-for="index in 8" :key="index" :label="`I${index - 1}`" :value="index - 1" />
        </el-select>
      </div>
      <div class="field">
        <label>采样间隔</label>
        <el-input-number v-model="sampleIntervalMs" :min="1" :max="5000" controls-position="right" />
        <span class="unit">ms</span>
      </div>
      <div class="sample-state" :class="{ ready: availableCount >= 8 }">
        {{ availableCount }} 个对齐采样点
      </div>
    </div>

    <div v-if="!metrics?.valid" class="empty-state">
      <el-icon><DataAnalysis /></el-icon>
      <h3>等待控制响应数据</h3>
      <p>在“工作区”开启控制响应模拟，或连接设备采集目标值、反馈值和控制量，然后点击“重新分析”。</p>
      <el-button type="primary" @click="runAnalysis">开始确定性分析</el-button>
    </div>

    <template v-else>
      <div class="summary-row">
        <div class="health-card" :class="metrics.health === '良好' ? 'good' : 'warn'">
          <span>响应健康度</span>
          <strong>{{ metrics.health }}</strong>
          <small>{{ metrics.sampleCount }} 点 · {{ metrics.sampleRate || '--' }} Hz</small>
        </div>
        <div v-for="item in metricCards" :key="item.label" class="metric-card" :class="{ danger: item.danger }">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </div>
      </div>

      <div class="result-grid">
        <section class="panel">
          <div class="panel-title">风险与诊断依据</div>
          <ul v-if="metrics.risks.length" class="risk-list">
            <li v-for="risk in metrics.risks" :key="risk">{{ risk }}</li>
          </ul>
          <div v-else class="safe-note">当前数据在默认阈值内：超调 ≤20%，稳态波动 ≤10%。</div>
          <div class="rule-note">这些结论来自固定算法，可重复计算；AI 不参与指标数值的生成。</div>
        </section>

        <section class="panel candidate">
          <div class="panel-title">有界 PID 候选参数</div>
          <div class="pid-values">
            <div><span>Kp</span><strong>{{ suggestion.kp }}</strong></div>
            <div><span>Ki</span><strong>{{ suggestion.ki }}</strong></div>
            <div><span>Kd</span><strong>{{ suggestion.kd }}</strong></div>
          </div>
          <ul class="reason-list">
            <li v-for="reason in suggestion.reasons" :key="reason">{{ reason }}</li>
          </ul>
          <div class="candidate-foot">置信度：{{ suggestion.confidence }} · 仅作为候选，不自动写入设备</div>
        </section>
      </div>

      <section class="panel ai-panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">DeepSeek 结构化解释（可选）</div>
            <p>只发送指标、候选参数和安全规则，不发送无边界的控制指令。</p>
          </div>
          <el-button type="success" :icon="MagicStick" :loading="aiLoading" @click="requestAiExplanation">生成解释</el-button>
        </div>
        <div v-if="aiExplanation" class="ai-output">{{ aiExplanation }}</div>
        <div v-else class="ai-placeholder">未调用在线模型。离线确定性分析和报告导出仍可完整使用。</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analysis-page { height: 100%; overflow: auto; padding: 24px; background: var(--color-bg-primary); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
.page-head h2 { margin: 6px 0; font-size: 22px; }
.page-head p, .panel-head p { margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.eyebrow { display: flex; gap: 6px; align-items: center; color: var(--color-ai); font-size: 12px; font-weight: 600; }
.head-actions { display: flex; gap: 8px; }
.config-card { display: flex; align-items: flex-end; gap: 14px; padding: 14px; border: 1px solid var(--color-border-default); border-radius: 10px; background: var(--color-bg-secondary); }
.field { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 116px; }
.field label { color: var(--color-text-secondary); font-size: 12px; }
.unit { position: absolute; right: 10px; bottom: 8px; color: var(--color-text-tertiary); font-size: 11px; }
.sample-state { margin-left: auto; padding: 8px 12px; border-radius: 20px; background: var(--color-bg-tertiary); color: var(--color-text-tertiary); font-size: 12px; }
.sample-state.ready { background: rgba(34, 197, 94, .12); color: var(--state-success); }
.empty-state { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--color-text-secondary); }
.empty-state .el-icon { font-size: 48px; color: var(--color-border-default); }
.empty-state h3 { margin: 14px 0 6px; color: var(--color-text-primary); }
.empty-state p { max-width: 560px; margin: 0 0 18px; line-height: 1.7; }
.summary-row { display: grid; grid-template-columns: 1.3fr repeat(6, 1fr); gap: 10px; margin: 16px 0; }
.health-card, .metric-card { min-width: 0; padding: 14px; border: 1px solid var(--color-border-default); border-radius: 10px; background: var(--color-bg-secondary); }
.health-card span, .metric-card span { display: block; color: var(--color-text-secondary); font-size: 11px; }
.health-card strong, .metric-card strong { display: block; margin-top: 7px; font-size: 20px; }
.health-card small { color: var(--color-text-tertiary); }
.health-card.good { border-color: rgba(34, 197, 94, .5); }.health-card.good strong { color: var(--state-success); }
.health-card.warn, .metric-card.danger { border-color: rgba(239, 68, 68, .5); }.health-card.warn strong, .metric-card.danger strong { color: var(--state-error); }
.result-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.panel { padding: 18px; border: 1px solid var(--color-border-default); border-radius: 10px; background: var(--color-bg-secondary); }
.panel-title { font-size: 14px; font-weight: 600; }
.risk-list, .reason-list { margin: 14px 0; padding-left: 20px; color: var(--color-text-secondary); line-height: 1.8; }
.risk-list { color: var(--state-error); }
.safe-note { margin: 16px 0; padding: 12px; border-radius: 8px; background: rgba(34, 197, 94, .1); color: var(--state-success); }
.rule-note, .candidate-foot { color: var(--color-text-tertiary); font-size: 11px; }
.pid-values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
.pid-values div { padding: 12px; border-radius: 8px; background: var(--color-bg-tertiary); }
.pid-values span { color: var(--color-text-tertiary); font-size: 11px; }.pid-values strong { display: block; margin-top: 4px; font-size: 20px; color: var(--color-ai); }
.ai-panel { margin-top: 14px; }.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.ai-output { margin-top: 14px; padding: 14px; border-radius: 8px; background: var(--color-bg-tertiary); white-space: pre-wrap; line-height: 1.7; }
.ai-placeholder { margin-top: 14px; color: var(--color-text-tertiary); font-size: 12px; }
@media (max-width: 1180px) { .summary-row { grid-template-columns: repeat(4, 1fr); }.result-grid { grid-template-columns: 1fr; } }
</style>
