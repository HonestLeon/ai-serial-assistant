<script setup>
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, MagicStick, Refresh, Setting } from '@element-plus/icons-vue'
import {
  analyzeControlSamples,
  buildStructuredAiContext,
  createSamplesFromChannels
} from '../services/controlAnalysis.mjs'

const props = defineProps({
  serialContext: { type: Object, required: true },
  aiConfig: { type: Object, required: true },
  channelCount: { type: Number, default: 0 }
})

const mapping = reactive({ target: 0, feedback: 1 })
const responseEnabled = ref(false)
const sampleIntervalMs = ref(50)
const metrics = ref(null)
const aiExplanation = ref('')
const aiLoading = ref(false)
const aiError = computed(() => aiExplanation.value.startsWith('AI解释不可用'))
const settingsVisible = ref(false)
const analyzedAt = ref('')
const standards = reactive({
  settlingBandPercent: 5,
  overshootLimit: 20,
  oscillationLimit: 10,
  steadyErrorPercent: 5,
  minimumSamples: 8
})

const channelOptions = computed(() =>
  Array.from({ length: Math.max(1, props.channelCount || 0) }, (_, index) => index)
)

const channelFeatures = computed(() => {
  const count = Math.max(
    props.channelCount || 0,
    props.serialContext.channelHistory.filter((values) => values.length > 0).length
  )
  return Array.from({ length: count }, (_, index) => {
    const history = props.serialContext.channelHistory[index] || []
    // 单遍统计：原先 filter + min/max spread + 三次 reduce + map(Math.abs) 共 ~7 遍
    // 遍历（8 通道 × 1200 样本），串口流下每批刷新都会重算，低配机开销可观
    let n = 0
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let squareSum = 0
    let peak = 0
    let latest = 0
    for (let i = 0; i < history.length; i++) {
      const value = history[i]
      if (!Number.isFinite(value)) continue
      n += 1
      sum += value
      squareSum += value * value
      if (value < min) min = value
      if (value > max) max = value
      const abs = Math.abs(value)
      if (abs > peak) peak = abs
      latest = value
    }
    if (!n) return null
    const mean = sum / n
    return {
      channel: `I${index}`,
      n,
      min,
      max,
      mean,
      peak,
      rms: Math.sqrt(squareSum / n),
      std: Math.sqrt(squareSum / n - mean * mean),
      latest
    }
  }).filter(Boolean)
})

function featureValue(value) {
  if (!Number.isFinite(value)) return '--'
  const magnitude = Math.abs(value)
  return magnitude >= 10000 || (magnitude > 0 && magnitude < 0.001)
    ? value.toExponential(3)
    : Number(value.toFixed(4))
}

const samples = computed(() => createSamplesFromChannels(
  props.serialContext.channelHistory,
  { ...mapping, output: mapping.target },
  sampleIntervalMs.value
))

const metricCards = computed(() => {
  if (!metrics.value?.valid) return []
  return [
    { label: '上升时间', value: unit(metrics.value.riseTime, 's') },
    { label: '稳定时间', value: unit(metrics.value.settlingTime, 's') },
    { label: '超调率', value: unit(metrics.value.overshoot, '%'), danger: metrics.value.overshoot > standards.overshootLimit },
    { label: '稳态误差', value: unit(metrics.value.steadyError, '') },
    { label: '均方根误差', value: unit(metrics.value.rmse, '') },
    { label: '稳态波动', value: unit(metrics.value.oscillation, '%'), danger: metrics.value.oscillation > standards.oscillationLimit }
  ]
})

const stabilityDescription = computed(() =>
  `阶跃后，反馈值进入目标值±${standards.settlingBandPercent}%带宽，并在剩余采样期间持续保持在该范围内。`
)

function unit(value, suffix) {
  return value === null || value === undefined ? '未达到' : `${value}${suffix}`
}

function runAnalysis() {
  metrics.value = analyzeControlSamples(samples.value, {
    settlingBand: standards.settlingBandPercent / 100,
    overshootLimit: standards.overshootLimit,
    oscillationLimit: standards.oscillationLimit,
    steadyErrorLimitRatio: standards.steadyErrorPercent / 100,
    minimumSamples: standards.minimumSamples
  })
  aiExplanation.value = ''
  if (!metrics.value.valid) {
    ElMessage.warning(metrics.value.reason)
    return
  }
  analyzedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
  ElMessage.success('响应分析已按当前判定标准更新')
}

function saveStandards() {
  settingsVisible.value = false
  if (samples.value.length >= standards.minimumSamples) runAnalysis()
}

async function requestAiExplanation() {
  if (!metrics.value?.valid) runAnalysis()
  if (!metrics.value?.valid) return
  if (!props.aiConfig.apiKey) {
    ElMessage.warning('未配置 API Key；确定性响应分析仍可离线使用')
    return
  }

  aiLoading.value = true
  const context = buildStructuredAiContext(metrics.value, null, {
    system: '串口采集控制对象',
    scenario: '响应指标解释'
  })
  context.analysisStandard = {
    stability: stabilityDescription.value,
    steadyErrorLimit: `${standards.steadyErrorPercent}%`,
    minimumSamples: standards.minimumSamples
  }
  try {
    const response = await fetch(`${props.aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
            content: '你是控制响应解释助手。只解释固定算法给出的指标、判定标准、风险和下一步实验，不生成或下发PID参数。'
          },
          { role: 'user', content: JSON.stringify(context, null, 2) }
        ]
      })
    })
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`)
    const result = await response.json()
    aiExplanation.value = result.choices?.[0]?.message?.content || '模型未返回可用内容'
  } catch (error) {
    aiExplanation.value = `AI解释不可用：${error.message}。确定性指标不受影响。`
  } finally {
    aiLoading.value = false
  }
}

function exportReport() {
  if (!metrics.value?.valid) {
    ElMessage.warning('请先生成响应分析')
    return
  }
  const escape = (value) => String(value ?? '').replace(/[&<>]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
  const rows = metricCards.value
    .map((item) => `<tr><td>${escape(item.label)}</td><td>${escape(item.value)}</td></tr>`)
    .join('')
  const risks = metrics.value.risks.length
    ? metrics.value.risks.map((risk) => `<li>${escape(risk)}</li>`).join('')
    : '<li>当前判定标准下未发现明显风险</li>'
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>智串AI响应分析报告</title>
  <style>body{font:14px/1.7 system-ui;margin:40px;color:#17202a}h1{color:#13795b}table{border-collapse:collapse;width:100%;max-width:720px}td{border:1px solid #ccd6dd;padding:8px}.tag{padding:3px 10px;background:#e9f8f1;color:#13795b;border-radius:20px}</style>
  <body><h1>智串AI · 响应分析报告</h1><p>生成时间：${escape(analyzedAt.value)}</p>
  <p>数据量：${metrics.value.sampleCount}点｜状态：<span class="tag">${escape(metrics.value.health)}</span></p>
  <h2>判定标准</h2><p>${escape(stabilityDescription.value)}</p>
  <p>稳态误差阈值：阶跃幅值的${standards.steadyErrorPercent}%；最少采样点：${standards.minimumSamples}。</p>
  <h2>确定性指标</h2><table>${rows}</table><h2>风险</h2><ul>${risks}</ul>
  <h2>AI结构化解释</h2><pre style="white-space:pre-wrap">${escape(aiExplanation.value || '未调用在线模型')}</pre>
  <p><strong>声明：</strong>本报告用于响应分析，不直接控制硬件或下发PID参数。</p></body></html>`
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `智串AI响应分析_${Date.now()}.html`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="workspace-analysis">
    <header class="analysis-header">
      <div>
        <strong>数据分析</strong>
        <span>{{ channelFeatures.length }} 个有效通道 · {{ samples.length }} 个对齐采样点</span>
      </div>
      <div class="header-actions">
        <el-tooltip content="设置稳定带宽、误差阈值和最少采样点" placement="bottom">
          <el-button circle size="small" :icon="Setting" :disabled="!responseEnabled" @click="settingsVisible = true" />
        </el-tooltip>
        <el-button circle size="small" :icon="Refresh" :disabled="!responseEnabled" @click="runAnalysis" />
        <el-button circle size="small" :icon="Download" :disabled="!responseEnabled" @click="exportReport" />
      </div>
    </header>

    <section class="analysis-scroll">
      <section class="feature-section">
        <div class="section-title">
          <div>
            <strong>通道数据特征</strong>
            <span>默认开启，基于当前本地缓存实时计算</span>
          </div>
          <el-tag type="success" size="small">已开启</el-tag>
        </div>
        <div v-if="channelFeatures.length" class="feature-table-wrap">
          <table class="feature-table">
            <thead>
              <tr>
                <th>通道</th><th>样本数</th><th>最新值</th><th>平均值</th>
                <th>最小值</th><th>最大值</th><th>绝对峰值</th><th>均方根</th><th>标准差</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in channelFeatures" :key="item.channel">
                <td><strong>{{ item.channel }}</strong></td>
                <td>{{ item.n }}</td>
                <td>{{ featureValue(item.latest) }}</td>
                <td>{{ featureValue(item.mean) }}</td>
                <td>{{ featureValue(item.min) }}</td>
                <td>{{ featureValue(item.max) }}</td>
                <td>{{ featureValue(item.peak) }}</td>
                <td>{{ featureValue(item.rms) }}</td>
                <td>{{ featureValue(item.std) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="empty-features">等待解析数值通道后生成统计特征。</p>
      </section>

      <section class="response-section">
        <div class="section-title">
          <div>
            <strong>响应分析（可选）</strong>
            <span>适用于具有目标值与反馈值的阶跃响应数据</span>
          </div>
          <el-switch v-model="responseEnabled" size="small" />
        </div>

        <template v-if="responseEnabled">
          <div class="mapping-grid">
            <label>目标
              <el-select v-model="mapping.target" size="small">
                <el-option v-for="index in channelOptions" :key="index" :label="`I${index}`" :value="index" />
              </el-select>
            </label>
            <label>反馈
              <el-select v-model="mapping.feedback" size="small">
                <el-option v-for="index in channelOptions" :key="index" :label="`I${index}`" :value="index" />
              </el-select>
            </label>
          </div>
          <label class="sample-field">采样间隔
            <el-input-number v-model="sampleIntervalMs" size="small" :min="1" :max="5000" controls-position="right" />
            <span>ms</span>
          </label>

          <button v-if="!metrics?.valid" class="primary-action" @click="runAnalysis">生成响应分析</button>

          <template v-else>
            <div class="health-card" :class="{ good: metrics.health === '良好' }">
              <span>响应状态</span>
              <strong>{{ metrics.health }}</strong>
              <small>{{ metrics.sampleRate || '--' }} Hz · {{ metrics.sampleCount }}点</small>
            </div>
            <div class="metrics-grid">
              <div v-for="item in metricCards" :key="item.label" class="metric" :class="{ danger: item.danger }">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
            </div>

            <section class="analysis-card">
              <strong>判定依据</strong>
              <p>{{ stabilityDescription }}</p>
              <ul v-if="metrics.risks.length">
                <li v-for="risk in metrics.risks" :key="risk">{{ risk }}</li>
              </ul>
              <p v-else class="safe">当前标准下未发现明显风险。</p>
            </section>

            <section class="analysis-card">
              <div class="card-title">
                <strong>AI 结构化解释（可选）</strong>
                <div class="card-actions">
                  <el-button v-if="aiError" type="danger" size="small" :icon="Refresh" :loading="aiLoading" @click="requestAiExplanation">重试</el-button>
                  <el-button type="success" size="small" :icon="MagicStick" :loading="aiLoading" @click="requestAiExplanation">解释</el-button>
                </div>
              </div>
              <p v-if="aiExplanation" class="ai-text" :class="{ 'ai-text-error': aiError }">{{ aiExplanation }}</p>
              <p v-else>AI仅解释指标和风险；本页不生成PID参数。</p>
            </section>
          </template>
        </template>
      </section>
    </section>

    <el-dialog v-model="settingsVisible" title="响应分析高级设置" width="520px">
      <div class="advanced-form">
        <label>稳定带宽（±%）
          <el-input-number v-model="standards.settlingBandPercent" :min="1" :max="20" :step="1" />
          <small>反馈进入目标值的该百分比范围并持续保持，才判定为稳定。</small>
        </label>
        <label>超调率警戒线（%）
          <el-input-number v-model="standards.overshootLimit" :min="0" :max="200" />
        </label>
        <label>稳态波动警戒线（%）
          <el-input-number v-model="standards.oscillationLimit" :min="0" :max="100" />
        </label>
        <label>稳态误差警戒线（阶跃幅值%）
          <el-input-number v-model="standards.steadyErrorPercent" :min="0.1" :max="100" :step="0.5" />
        </label>
        <label>最少有效采样点
          <el-input-number v-model="standards.minimumSamples" :min="8" :max="1000" />
        </label>
      </div>
      <template #footer>
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" @click="saveStandards">应用并重新分析</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.workspace-analysis { display: flex; height: 100%; min-height: 0; flex-direction: column; color: var(--color-text-primary); background: var(--color-bg-secondary); }
.analysis-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border-default); }.analysis-header div:first-child { display: flex; flex-direction: column; }.analysis-header strong { font-size: var(--text-sm); font-weight: var(--weight-semibold); }.analysis-header span { color: var(--color-text-tertiary); font-size: var(--text-xs); }
.header-actions { display: flex; gap: 5px; }.analysis-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.feature-section,.response-section { padding: 12px; border: 1px solid var(--color-border-default); border-radius: var(--radius-md); background: var(--color-bg-primary); }
.response-section { margin-top: 10px; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.section-title > div { display: flex; flex-direction: column; gap: 2px; }
.section-title strong { font-size: 13px; }
.section-title span { color: var(--color-text-tertiary); font-size: var(--text-xs); }
.feature-table-wrap { max-width: 100%; overflow-x: auto; }
.feature-table { width: 100%; min-width: 820px; border-collapse: collapse; font-family: var(--font-family-mono); font-size: 11px; }
.feature-table th,.feature-table td { padding: 7px 9px; border-bottom: 1px solid var(--color-border-default); text-align: right; white-space: nowrap; }
.feature-table th:first-child,.feature-table td:first-child { position: sticky; left: 0; text-align: left; background: var(--color-bg-primary); }
.feature-table th { color: var(--color-text-tertiary); font-weight: 500; }
.feature-table td { color: var(--color-text-secondary); }
.feature-table tbody tr:hover { background: var(--color-bg-tertiary); }
.feature-table td strong { color: var(--color-primary); }
.empty-features { margin: 16px 0; color: var(--color-text-tertiary); font-size: 11px; text-align: center; }
.mapping-grid { display: grid; grid-template-columns: repeat(2, minmax(140px, 1fr)); gap: 8px; }.mapping-grid label, .sample-field { display: flex; flex-direction: column; gap: 4px; color: var(--color-text-secondary); font-size: var(--text-xs); }
.sample-field { position: relative; margin-top: 8px; }.sample-field > span { position: absolute; right: 8px; bottom: 7px; color: var(--color-text-tertiary); }
.primary-action { width: 100%; margin-top: 12px; padding: 8px; border: 0; border-radius: var(--radius-sm); background: var(--color-primary); color: var(--color-text-inverse); cursor: pointer; font-weight: 600; }
.health-card { display: flex; flex-direction: column; margin-top: 12px; padding: 12px; border: 1px solid rgba(239,68,68,.4); border-radius: var(--radius-md); background: var(--color-bg-primary); }.health-card.good { border-color: rgba(34,197,94,.5); }.health-card span,.health-card small { color: var(--color-text-tertiary); font-size: var(--text-xs); }.health-card strong { margin: 3px 0; color: var(--state-warning); font-size: 20px; }.health-card.good strong { color: var(--state-success); }
.metrics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }.metric { padding: 9px; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: var(--color-bg-primary); }.metric span { display: block; color: var(--color-text-tertiary); font-size: var(--text-xs); }.metric strong { display: block; margin-top: 4px; font: 600 14px var(--font-family-mono); }.metric.danger strong { color: var(--state-error); }
.analysis-card { margin-top: 8px; padding: 11px; border: 1px solid var(--color-border-default); border-radius: var(--radius-md); background: var(--color-bg-primary); }.analysis-card > strong,.card-title strong { font-size: 12px; }.analysis-card p,.analysis-card li { color: var(--color-text-secondary); font-size: var(--text-sm); line-height: 1.55; }.analysis-card ul { padding-left: 17px; color: var(--state-error); }.analysis-card .safe { color: var(--state-success); }.card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.card-actions { display: flex; gap: 5px; }.ai-text { white-space: pre-wrap; }.ai-text-error { color: var(--state-error); }
.advanced-form { display: grid; gap: 14px; }.advanced-form label { display: grid; grid-template-columns: 1fr 160px; align-items: center; gap: 10px; }.advanced-form small { grid-column: 1 / -1; color: var(--color-text-tertiary); }
</style>
