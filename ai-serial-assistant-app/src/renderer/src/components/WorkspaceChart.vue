<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { ElMessageBox } from 'element-plus'
import { Download, Hide, View } from '@element-plus/icons-vue'

const props = defineProps({
  connected: Boolean,
  latestPayload: { type: Object, default: null },
  channelCount: { type: Number, default: 0 },
  simulationSamples: { type: Array, default: () => [] },
  visible: { type: Boolean, default: true }
})

const chartRef = ref(null)
const seriesData = ref([])
const sampleLabels = ref([])
const visibleChannels = ref([])
const seriesNames = ref([])
const normalizeDrawing = ref(false)
const yAuto = ref(true)
const yMin = ref('')
const yMax = ref('')
const simulationMode = ref(false)
const isDark = ref(document.documentElement.classList.contains('dark'))
const MAX_POINTS = 2000
const hasExportData = computed(() => seriesData.value.some((series) => series.length > 0))
let sampleIndex = 0
let chart = null
// ResizeObserver：监听 echarts 容器尺寸变化（拖动分隔条、窗口缩放均可触发）
let resizeObserver = null

const channelCount = computed(() =>
  Math.min(8, simulationMode.value
    ? seriesData.value.length
    : Math.max(props.channelCount || 0, seriesData.value.length))
)

const themeChannelColors = [
  { light: '#e6007e', dark: '#f778ba' },
  { light: '#0969da', dark: '#58a6ff' },
  /* I2 原亮蓝 #218bff/#79c0ff 与 I1 蓝色色相差过小，曲线不可辨，改为青色系（与 style.css --color-channel-2 同步） */
  { light: '#1f9eba', dark: '#39c5cf' },
  { light: '#9a6700', dark: '#d29922' },
  { light: '#8250df', dark: '#bc8cff' },
  { light: '#1a7f37', dark: '#3fb950' },
  { light: '#d94f00', dark: '#f0883e' },
  { light: '#cf222e', dark: '#f85149' }
]

function colors() {
  return themeChannelColors.map((color) => isDark.value ? color.dark : color.light)
}

function extractNumbers(text) {
  const source = String(text)
  const colonIndex = source.indexOf(':')
  const dataPart = colonIndex >= 0 ? source.slice(colonIndex + 1) : source
  const matches = dataPart.match(/[-+]?\d*\.?\d+/g)
  return matches ? matches.slice(0, 8).map(Number) : []
}

function ensureChannels(count) {
  while (seriesData.value.length < count) {
    seriesData.value.push([])
    visibleChannels.value.push(true)
    seriesNames.value.push(`I${seriesNames.value.length}`)
  }
}

function plottedData(data) {
  const valid = data.filter(Number.isFinite)
  if (!normalizeDrawing.value || valid.length < 2) {
    return data.map((raw) => Number.isFinite(raw) ? { value: raw, raw } : null)
  }
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const range = max - min
  return data.map((raw) => Number.isFinite(raw)
    ? { value: range > 0 ? ((raw - min) / range) * 200 - 100 : 0, raw }
    : null)
}

function buildSeries() {
  return Array.from({ length: channelCount.value }, (_, index) => ({
    name: seriesNames.value[index] || `I${index}`,
    type: 'line',
    smooth: true,
    showSymbol: false,
    connectNulls: false,
    data: visibleChannels.value[index] ? plottedData(seriesData.value[index] || []) : [],
    lineStyle: { color: colors()[index], width: 1.8 },
    itemStyle: { color: colors()[index] }
  }))
}

function tooltipFormatter(params) {
  if (!params?.length) return ''
  const rows = params.map((item) => {
    const raw = item.data?.raw
    const value = Number.isFinite(raw) ? raw : item.value
    return `<div style="display:flex;gap:12px;justify-content:space-between">
      <span>${item.marker}${item.seriesName}</span>
      <strong>${Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '--'}</strong>
    </div>`
  }).join('')
  return `<div style="font-size:12px"><div style="margin-bottom:5px">采样点 ${params[0].axisValue}</div>${rows}
    ${normalizeDrawing.value ? `<div style="margin-top:5px;color:${isDark.value ? '#8b949e' : '#57606a'}">曲线已归一化至 -100~100，以上为原始值</div>` : ''}
  </div>`
}

function chartOption() {
  const axisTextColor = isDark.value ? '#8b949e' : '#57606a'
  const hasData = seriesData.value.some((series) => series.length > 0)
  const yAxis = {
    type: 'value',
    name: normalizeDrawing.value ? '归一化值' : '',
    splitLine: { show: true, lineStyle: { color: isDark.value ? '#21262d' : '#e4e7ed' } },
    axisLine: { lineStyle: { color: isDark.value ? '#30363d' : '#dcdfe6' } },
    axisLabel: { color: axisTextColor, fontSize: 11 }
  }
  if (!yAuto.value) {
    const min = Number(yMin.value)
    const max = Number(yMax.value)
    if (Number.isFinite(min)) yAxis.min = min
    if (Number.isFinite(max)) yAxis.max = max
  }

  return {
    animation: false,
    backgroundColor: 'transparent',
    // title 恒定传入（show 控制显隐）：setOption merge 模式下传 undefined 不会移除已渲染组件，
    // 会导致首批数据到达后空状态文字残留，与波形叠加显示
    title: {
      show: !hasData,
      text: '等待串口数据…',
      subtext: '发送 FireWater 格式数据（如 ch1:1.23, ch2:4.56）即可绘制波形',
      left: 'center',
      top: 'middle',
      textStyle: { color: axisTextColor, fontSize: 13 },
      subtextStyle: { color: axisTextColor, fontSize: 11 }
    },
    grid: { top: 28, right: 18, bottom: 28, left: 48 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: tooltipFormatter
    },
    dataZoom: [{
      type: 'inside',
      xAxisIndex: 0,
      filterMode: 'none',
      zoomOnMouseWheel: true,
      // ECharts inside dataZoom 的 moveOnMouseMove 默认为 true（悬停移动即平移），
      // 必须显式关闭，否则与「按住拖动平移」提示文案及 axis tooltip 悬停读值冲突
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
      preventDefaultMouseMove: true
    }],
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: sampleLabels.value,
      axisLine: { lineStyle: { color: isDark.value ? '#30363d' : '#dcdfe6' } },
      axisLabel: { color: isDark.value ? '#8b949e' : '#57606a', fontSize: 11 }
    },
    yAxis,
    series: buildSeries()
  }
}

function refreshChart(resetOption = false) {
  if (!chart) return
  chart.setOption(chartOption(), { notMerge: resetOption, lazyUpdate: true })
}

function appendData(payload) {
  const values = extractNumbers(payload.raw)
  if (!values.length) return
  simulationMode.value = false
  ensureChannels(values.length)
  seriesNames.value = seriesData.value.map((_, index) => `I${index}`)
  sampleLabels.value.push(sampleIndex++)
  for (let index = 0; index < seriesData.value.length; index += 1) {
    seriesData.value[index].push(Number.isFinite(values[index]) ? values[index] : null)
  }
  if (sampleLabels.value.length > MAX_POINTS) {
    sampleLabels.value.shift()
    seriesData.value.forEach((data) => data.shift())
  }
  refreshChart()
}

function loadSimulationSamples(samples) {
  if (!samples?.length) return
  simulationMode.value = true
  seriesData.value = [[], [], []]
  sampleLabels.value = []
  visibleChannels.value = [true, true, true]
  seriesNames.value = ['目标值', '反馈值', '控制输出']
  sampleIndex = 0
  samples.slice(-MAX_POINTS).forEach((sample) => {
    sampleLabels.value.push(Number(sample.t).toFixed(3))
    seriesData.value[0].push(Number.isFinite(Number(sample.target)) ? Number(sample.target) : null)
    seriesData.value[1].push(Number.isFinite(Number(sample.feedback)) ? Number(sample.feedback) : null)
    seriesData.value[2].push(Number.isFinite(Number(sample.output)) ? Number(sample.output) : null)
    sampleIndex += 1
  })
  refreshChart(true)
}

function toggleChannel(index) {
  visibleChannels.value[index] = !visibleChannels.value[index]
  refreshChart()
}

// 清空波形属不可逆操作，二次确认防止误触丢失整段采集数据
async function clear() {
  try {
    await ElMessageBox.confirm('将清空全部已采集的波形数据，且不可恢复。', '清空波形', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  seriesData.value = []
  sampleLabels.value = []
  visibleChannels.value = []
  seriesNames.value = []
  sampleIndex = 0
  simulationMode.value = false
  refreshChart(true)
}

function exportData(format) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let content
  let filename
  if (format === 'csv') {
    const header = ['Index', ...Array.from({ length: channelCount.value }, (_, i) => `I${i}`)]
    const rows = sampleLabels.value.map((label, rowIndex) => [
      label,
      ...Array.from({ length: channelCount.value }, (_, channelIndex) =>
        seriesData.value[channelIndex]?.[rowIndex] ?? '')
    ])
    content = [header, ...rows].map((row) => row.join(',')).join('\n')
    filename = `waveform_${timestamp}.csv`
  } else {
    content = JSON.stringify({
      exportTime: new Date().toISOString(),
      normalizedOnlyForDrawing: normalizeDrawing.value,
      channels: Array.from({ length: channelCount.value }, (_, index) => ({
        name: seriesNames.value[index] || `I${index}`,
        visible: visibleChannels.value[index],
        rawData: seriesData.value[index]
      }))
    }, null, 2)
    filename = `waveform_${timestamp}.json`
  }
  const blob = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function handleResize() {
  chart?.resize()
}

function handleThemeChange(event) {
  isDark.value = event.detail.dark
  refreshChart(true)
}

onMounted(() => {
  chart = echarts.init(chartRef.value)
  refreshChart(true)
  // 用 ResizeObserver 监听容器尺寸变化：拖动上下分隔条、窗口缩放都能触发 chart.resize()
  resizeObserver = new ResizeObserver(() => chart?.resize())
  resizeObserver.observe(chartRef.value)
  window.addEventListener('theme-change', handleThemeChange)
})

watch(() => props.latestPayload, (payload) => {
  if (payload) appendData(payload)
})

watch(() => props.simulationSamples, (samples) => {
  loadSimulationSamples(samples)
})

watch(() => props.visible, (visible) => {
  if (visible) nextTick(handleResize)
})

watch([normalizeDrawing, yAuto, yMin, yMax], () => refreshChart())

onUnmounted(() => {
  chart?.dispose()
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('theme-change', handleThemeChange)
})
</script>

<template>
  <div class="workspace-chart">
    <aside class="chart-settings">
      <div class="settings-title">波形设置</div>
      <div v-if="channelCount" class="channel-list">
        <button
          v-for="index in channelCount"
          :key="index"
          class="channel-button"
          :class="{ muted: !visibleChannels[index - 1] }"
          @click="toggleChannel(index - 1)"
        >
          <el-icon><View v-if="visibleChannels[index - 1]" /><Hide v-else /></el-icon>
          <i :style="{ background: colors()[index - 1] }" />
          {{ seriesNames[index - 1] || `I${index - 1}` }}
        </button>
      </div>
      <div v-else class="waiting">等待解析数据通道</div>

      <div class="setting-divider" />
      <label class="switch-row">
        <span>归一化绘图</span>
        <el-switch v-model="normalizeDrawing" size="small" />
      </label>
      <p class="hint">各通道缩放至 -100~100；悬停与导出仍显示原始值。</p>

      <label class="switch-row">
        <span>Y轴范围</span>
        <button class="auto-button" @click="yAuto = !yAuto">{{ yAuto ? '自动' : '手动' }}</button>
      </label>
      <div v-if="!yAuto" class="range-row">
        <input v-model="yMin" type="number" placeholder="Min">
        <span>~</span>
        <input v-model="yMax" type="number" placeholder="Max">
      </div>

      <div class="setting-divider" />
      <button class="export-button" :disabled="!hasExportData" @click="exportData('csv')"><el-icon><Download /></el-icon>CSV</button>
      <button class="export-button" :disabled="!hasExportData" @click="exportData('json')"><el-icon><Download /></el-icon>JSON</button>
    </aside>

    <section class="chart-main">
      <header class="chart-header">
        <div>
          <strong>实时波形</strong>
          <span>鼠标滚轮缩放X轴 · 按住拖动平移X轴</span>
        </div>
        <el-tag v-if="connected" type="success" effect="dark" size="small">接收中</el-tag>
        <el-tag v-else type="info" effect="dark" size="small">离线/未连接</el-tag>
        <button class="clear-button" @click="clear">清空</button>
      </header>
      <div ref="chartRef" class="chart-canvas" />
    </section>
  </div>
</template>

<style scoped>
.workspace-chart { display: flex; height: 100%; min-height: 0; color: var(--color-text-primary); }
.chart-settings { width: 158px; min-width: 158px; padding: 10px; overflow-y: auto; background: var(--color-bg-secondary); border-right: 1px solid var(--color-border-default); }
.settings-title { margin-bottom: 8px; color: var(--color-text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.channel-list { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
/* 158px 侧栏两列时每列约 67px，容不下中文通道名（约 84px），窄屏折叠为单列 */
@media (max-width: 1100px) {
  .channel-list { grid-template-columns: 1fr; }
}
.channel-button { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 4px 6px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-primary); cursor: pointer; font: 11px var(--font-family-mono); }
.channel-button:hover { background: var(--color-bg-tertiary); }.channel-button.muted { opacity: .45; }
.channel-button i { width: 7px; height: 7px; border-radius: 50%; }.waiting { color: var(--color-text-tertiary); font-size: 11px; }
.setting-divider { height: 1px; margin: 10px 0; background: var(--color-border-default); }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--color-text-secondary); font-size: 11px; }
.hint { margin: 0 0 10px; color: var(--color-text-tertiary); font-size: 10px; line-height: 1.45; }
.auto-button { padding: 2px 7px; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: var(--color-bg-tertiary); color: var(--color-primary); font-size: 10px; cursor: pointer; }
.range-row { display: flex; align-items: center; gap: 3px; }.range-row input { width: 52px; min-width: 0; padding: 3px; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: var(--color-bg-primary); color: var(--color-text-primary); font-size: 10px; }
.export-button { display: inline-flex; align-items: center; gap: 3px; margin: 0 4px 4px 0; padding: 4px 7px; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: var(--color-bg-tertiary); color: var(--color-text-secondary); font-size: 10px; cursor: pointer; }
.chart-main { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; padding: 8px 10px 10px; }
.chart-header { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }.chart-header div { display: flex; flex-direction: column; }.chart-header strong { font-size: 13px; }.chart-header span { color: var(--color-text-tertiary); font-size: var(--text-xs); }
.clear-button { margin-left: auto; padding: 3px 8px; border: 1px solid var(--color-border-default); border-radius: var(--radius-sm); background: var(--color-bg-tertiary); color: var(--color-text-secondary); cursor: pointer; font-size: 10px; }
.chart-canvas { flex: 1; min-height: 0; border: 1px solid var(--color-border-default); border-radius: var(--radius-md); background: var(--color-bg-primary); }
</style>
