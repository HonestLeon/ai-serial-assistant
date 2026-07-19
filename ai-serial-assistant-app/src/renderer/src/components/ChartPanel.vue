<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { View, Hide, Download } from '@element-plus/icons-vue'

const props = defineProps({
  connected: Boolean,
  serialContext: { type: Object, default: null },
  latestPayload: { type: Object, default: null },
  visible: { type: Boolean, default: true }
})

const chartRef = ref(null)
let chart = null
const maxPoints = 200
const seriesData = ref([[]])
const visibleChannels = ref([true, false, false, false, false, false, false, false])

// 显示设置
const yMin = ref('')
const yMax = ref('')
const yAuto = ref(true)
const xRange = ref(200)
const showGrid = ref(true)
const showCrosshair = ref(false)

const isDark = ref(document.documentElement.classList.contains('dark'))

const themeChannelColors = [
  { light: '#e6007e', dark: '#f778ba' },
  { light: '#0969da', dark: '#58a6ff' },
  { light: '#218bff', dark: '#79c0ff' },
  { light: '#9a6700', dark: '#d29922' },
  { light: '#8250df', dark: '#bc8cff' },
  { light: '#1a7f37', dark: '#3fb950' },
  { light: '#d94f00', dark: '#f0883e' },
  { light: '#cf222e', dark: '#f85149' }
]

const themeGridColor = () => isDark.value ? '#30363d' : '#dcdfe6'
const themeSplitColor = () => isDark.value ? '#21262d' : '#e4e7ed'
const themeTextColor = () => isDark.value ? '#6e7681' : '#8b949e'

function channelColors() {
  return themeChannelColors.map(c => isDark.value ? c.dark : c.light)
}

function extractNumbers(text) {
  const str = String(text)
  // FireWater 格式：标签:值，只提取冒号后的数值
  const colonIdx = str.indexOf(':')
  const dataPart = colonIdx >= 0 ? str.slice(colonIdx + 1) : str
  const matches = dataPart.match(/[-+]?\d*\.?\d+/g)
  return matches ? matches.map(Number) : []
}

function getChartOption(keepData = true) {
  const colors = channelColors()
  const seriesOpt = keepData && seriesData.value.length
    ? seriesData.value.map((data, i) => ({
        name: `I${i}`,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: visibleChannels.value[i] ? data : [],
        lineStyle: { color: colors[i], width: 2 },
        itemStyle: { color: colors[i] }
      }))
    : Array.from({ length: 8 }, (_, i) => ({
        name: `I${i}`,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: [],
        lineStyle: { color: colors[i], width: 2 },
        itemStyle: { color: colors[i] }
      }))

  const yAxisOpt = {
    type: 'value',
    splitLine: { show: showGrid.value, lineStyle: { color: themeSplitColor() } },
    axisLine: { lineStyle: { color: themeGridColor() } },
    axisLabel: { color: themeTextColor(), fontSize: 10 }
  }

  if (!yAuto.value) {
    const min = parseFloat(yMin.value)
    const max = parseFloat(yMax.value)
    if (!isNaN(min)) yAxisOpt.min = min
    if (!isNaN(max)) yAxisOpt.max = max
  }

  return {
    backgroundColor: 'transparent',
    grid: { top: 30, right: 20, bottom: 30, left: 50 },
    tooltip: {
      trigger: 'axis',
      axisPointer: showCrosshair.value ? { type: 'cross' } : { type: 'line' }
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: keepData ? (seriesData.value[0]?.map((_, i) => i) || []) : [],
      axisLine: { lineStyle: { color: themeGridColor() } },
      axisLabel: { color: themeTextColor(), fontSize: 10 }
    },
    yAxis: yAxisOpt,
    series: seriesOpt
  }
}

function initChart() {
  if (!chartRef.value) return
  if (chart) chart.dispose()
  chart = echarts.init(chartRef.value)
  chart.setOption(getChartOption(true))
}

function appendData(payload) {
  const values = extractNumbers(payload.raw)
  if (values.length === 0) return

  while (seriesData.value.length < values.length) {
    seriesData.value.push([])
  }

  values.forEach((v, i) => {
    seriesData.value[i].push(v)
    const windowSize = xRange.value > 0 ? Math.min(xRange.value, maxPoints) : maxPoints
    if (seriesData.value[i].length > windowSize) {
      seriesData.value[i].shift()
    }
  })

  const xData = seriesData.value[0].map((_, i) => i)
  chart.setOption({
    xAxis: { data: xData },
    series: seriesData.value.map((data, i) => ({
      data: visibleChannels.value[i] ? data : []
    }))
  })
}

function clear() {
  seriesData.value = [[]]
  chart.setOption({
    xAxis: { data: [] },
    series: Array.from({ length: 8 }, () => ({ data: [] }))
  })
}

function toggleChannel(i) {
  visibleChannels.value[i] = !visibleChannels.value[i]
  const xData = seriesData.value[0]?.map((_, idx) => idx) || []
  chart.setOption({
    xAxis: { data: xData },
    series: seriesData.value.map((data, idx) => ({
      data: visibleChannels.value[idx] ? data : []
    }))
  })
}

function applyDisplaySettings() {
  chart.setOption(getChartOption(true))
}

function onThemeChange(e) {
  isDark.value = e.detail.dark
  chart.setOption(getChartOption(true))
}

function exportData(format) {
  const colors = channelColors()
  let content = ''
  let filename = ''
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  if (format === 'csv') {
    const header = ['Index', ...Array.from({ length: seriesData.value.length }, (_, i) => `I${i}`)]
    content = header.join(',') + '\n'
    const maxLen = Math.max(...seriesData.value.map(d => d.length), 0)
    for (let i = 0; i < maxLen; i++) {
      const row = [i]
      for (let j = 0; j < seriesData.value.length; j++) {
        row.push(seriesData.value[j][i] !== undefined ? seriesData.value[j][i].toFixed(6) : '')
      }
      content += row.join(',') + '\n'
    }
    filename = `waveform_${timestamp}.csv`
  } else {
    const data = {
      exportTime: new Date().toISOString(),
      channels: seriesData.value.map((d, i) => ({
        name: `I${i}`,
        color: colors[i],
        visible: visibleChannels.value[i],
        data: d
      }))
    }
    content = JSON.stringify(data, null, 2)
    filename = `waveform_${timestamp}.json`
  }

  const blob = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(() => {
  initChart()
  window.addEventListener('resize', () => chart?.resize())
  window.addEventListener('theme-change', onThemeChange)
})

// 监听父组件传来的数据（兼容真实串口和模拟数据）
watch(() => props.latestPayload, (payload) => {
  if (payload && chart) appendData(payload)
})

// 切换到波形标签时 resize 图表（v-show 隐藏时容器尺寸为 0）
watch(() => props.visible, (v) => {
  if (v && chart) {
    nextTick(() => {
      chart.resize()
      chart.setOption(getChartOption(true))
    })
  }
})

onUnmounted(() => {
  chart?.dispose()
  window.removeEventListener('theme-change', onThemeChange)
})

defineExpose({ clear })
</script>

<template>
  <div class="chart-panel">
    <aside class="chart-sidebar">
      <div class="panel-section">
        <div class="section-header">
          <span>通道</span>
        </div>
        <div class="channel-list">
          <div
            v-for="i in 8"
            :key="i - 1"
            class="channel-row"
            :class="{ hidden: !visibleChannels[i - 1] }"
            @click="toggleChannel(i - 1)"
          >
            <el-icon size="13" class="eye-icon">
              <View v-if="visibleChannels[i - 1]" />
              <Hide v-else />
            </el-icon>
            <div class="channel-dot" :style="{ background: channelColors()[i - 1], opacity: visibleChannels[i - 1] ? 1 : 0.35 }"></div>
            <span class="channel-name">I{{ i - 1 }}</span>
          </div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">
          <span>显示设置</span>
        </div>
        <div class="setting-row">
          <span>Y轴范围</span>
          <button class="auto-toggle" :class="{ active: yAuto }" @click="yAuto = !yAuto; applyDisplaySettings()">
            {{ yAuto ? '自动' : '手动' }}
          </button>
        </div>
        <div class="range-inputs">
          <input v-model="yMin" type="number" :disabled="yAuto" placeholder="Min" @change="applyDisplaySettings" />
          <span>~</span>
          <input v-model="yMax" type="number" :disabled="yAuto" placeholder="Max" @change="applyDisplaySettings" />
        </div>
        <div class="setting-row">
          <span>X轴范围</span>
          <span class="auto-label">{{ xRange }} 点</span>
        </div>
        <div class="range-inputs">
          <input v-model.number="xRange" type="number" min="10" max="200" step="10" style="width: 100%" @change="applyDisplaySettings" />
        </div>
        <div class="toggle-setting">
          <span>网格线</span>
          <el-switch v-model="showGrid" size="small" @change="applyDisplaySettings" />
        </div>
        <div class="toggle-setting">
          <span>十字准线</span>
          <el-switch v-model="showCrosshair" size="small" @change="applyDisplaySettings" />
        </div>
      </div>

      <div class="divider"></div>

      <div class="panel-section">
        <div class="section-header">
          <span>数据导出</span>
        </div>
        <div class="export-buttons">
          <button class="export-btn" @click="exportData('csv')">
            <el-icon size="13"><Download /></el-icon>
            <span>导出 CSV</span>
          </button>
          <button class="export-btn" @click="exportData('json')">
            <el-icon size="13"><Download /></el-icon>
            <span>导出 JSON</span>
          </button>
        </div>
      </div>
    </aside>

    <section class="chart-main">
      <div class="chart-toolbar">
        <span class="chart-title">实时波形</span>
        <el-tag v-if="connected" type="success" effect="dark" size="small">接收中</el-tag>
        <el-tag v-else type="info" effect="dark" size="small">未连接</el-tag>
        <button class="btn-secondary" style="margin-left: auto" @click="clear">清空</button>
      </div>
      <div ref="chartRef" class="chart" />
    </section>
  </div>
</template>

<style scoped>
.chart-panel {
  display: flex;
  height: 100%;
  color: var(--color-text-primary);
}

.chart-sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-default);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.panel-section {
  padding: var(--space-3);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

.divider {
  height: 1px;
  background: var(--color-border-default);
  margin: 0 var(--space-3);
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.channel-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.channel-row:hover {
  background: var(--color-bg-tertiary);
}

.channel-row.hidden {
  opacity: 0.7;
}

.eye-icon {
  color: var(--color-text-secondary);
}

.channel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-name {
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  color: var(--color-text-primary);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.auto-label {
  color: var(--color-primary);
  font-family: var(--font-family-mono);
}

.auto-toggle {
  padding: 1px 6px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-tertiary);
  font-size: 10px;
  cursor: pointer;
  font-family: var(--font-family-mono);
}

.auto-toggle.active {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.range-inputs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.range-inputs input {
  flex: 1;
  width: 44px;
  height: 22px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  text-align: center;
  outline: none;
}

.range-inputs input:disabled {
  opacity: 0.5;
}

.range-inputs span {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.toggle-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.export-buttons {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.export-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-default);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: all 150ms ease;
}

.export-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-border-active);
}

.chart-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--space-3);
}

.chart-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  flex-shrink: 0;
}

.chart-title {
  font-weight: 600;
  color: var(--color-text-primary);
}

.chart {
  flex: 1;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
}

.btn-secondary {
  height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
}
</style>
