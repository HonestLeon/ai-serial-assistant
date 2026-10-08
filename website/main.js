import './style.css'
import { PRESETS, PARAMS, runSimulation, toCsv } from './simulation.mjs'
import workspaceImage from '../发布包/images/01-主界面.png'
import analysisImage from '../发布包/images/04-数据分析.png'
import pidImage from '../发布包/images/05-PID调参面板-仿真.png'
import darkImage from '../发布包/images/07-暗色主题.png'

const $ = id => document.getElementById(id)
const shots = [
  [workspaceImage, 'TUNER · 桌面工作区'], [analysisImage, 'TUNER · 数据分析'],
  [pidImage, 'TUNER · PID 仿真调参'], [darkImage, 'TUNER · 深色主题']
]
function selectShot(index) {
  $('product-image').src = shots[index][0]
  $('product-image').alt = shots[index][1] + '实际软件截图'
  $('screenshot-caption').textContent = shots[index][1]
  document.querySelectorAll('[data-shot]').forEach(button => {
    const active = Number(button.dataset.shot) === index
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}
document.querySelectorAll('[data-shot]').forEach(button => button.addEventListener('click', () => selectShot(Number(button.dataset.shot))))
selectShot(0)
$('screenshot-open').addEventListener('click', () => {
  $('dialog-image').src = $('product-image').src
  $('dialog-image').alt = $('product-image').alt
  $('image-dialog').showModal()
})
$('close-dialog').addEventListener('click', () => $('image-dialog').close())
$('image-dialog').addEventListener('click', event => { if (event.target === $('image-dialog')) $('image-dialog').close() })

let latest = null
let baseline = null
let pendingFrame = null
let chartScale = null
const svg = $('response-chart')
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—'
const state = () => ({ ...Object.fromEntries(Object.keys(PARAMS).map(key => [key, Number($(key).value)])), noise: $('noise').checked })
const viewDuration = () => $('zoom-transient').checked ? 1 : 4
const point = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`

function drawChart() {
  const samples = latest.samples
  const all = baseline ? [...samples, ...baseline.samples] : samples
  const values = all.flatMap(s => [s.target, s.feedback]).filter(Number.isFinite)
  const low = Math.min(0, ...values), high = Math.max(1, ...values)
  const span = high - low
  const min = low - span * .07, max = high + span * .14
  const W = 780, H = 340, left = 50, right = 20, top = 17, bottom = 35
  const duration = viewDuration()
  const x = t => left + t / duration * (W - left - right)
  const y = value => H - bottom - (value - min) / (max - min) * (H - top - bottom)
  chartScale = { x, y, left, width: W - left - right }
  const ticks = []
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4
    const yy = y(value)
    ticks.push(`<line x1="${left}" y1="${yy}" x2="${W-right}" y2="${yy}" stroke="#31503b" stroke-width=".7"/><text x="${left-10}" y="${yy+4}" text-anchor="end" fill="#a0b799" font-size="10">${value.toFixed(1)}</text>`)
  }
  for (let t = 0; t <= duration + .0001; t += duration / 8) {
    ticks.push(`<line x1="${x(t)}" y1="${top}" x2="${x(t)}" y2="${H-bottom}" stroke="#294432" stroke-width=".7"/><text x="${x(t)}" y="${H-10}" text-anchor="middle" fill="#a0b799" font-size="10">${t.toFixed(duration === 1 ? 3 : 1)}</text>`)
  }
  const path = (data, key) => data.map((s, i) => `${i ? 'L' : 'M'}${point(x(s.t),y(s[key]))}`).join(' ')
  const target = Number($('target').value)
  const bandTop = y(target * 1.05), bandBottom = y(target * .95)
  svg.innerHTML = `<title>电机速度环阶跃响应：目标和反馈随时间变化</title><desc>当前 Kp ${$('kp').value}、Ki ${$('ki').value}、Kd ${$('kd').value}。超调 ${fmt(latest.metrics.overshoot)}%。</desc>
    <defs><clipPath id="plot-clip"><rect x="${left}" y="${top}" width="${W-left-right}" height="${H-top-bottom}"/></clipPath></defs>
    ${ticks.join('')}<g clip-path="url(#plot-clip)"><rect x="${left}" y="${bandTop}" width="${W-left-right}" height="${bandBottom-bandTop}" fill="#c4f48a" opacity=".04"/>
    ${baseline ? `<path d="${path(baseline.samples,'feedback')}" stroke="#eeae75" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>` : ''}
    <path d="${path(samples,'target')}" stroke="#9eb3bf" stroke-width="1.3" stroke-dasharray="5 5" fill="none"/>
    <path d="${path(samples,'feedback')}" stroke="#c4f48a" stroke-width="2.2" fill="none" stroke-linejoin="round"/>
    <line id="cursor-line" y1="${top}" y2="${H-bottom}" stroke="#d4e6c5" stroke-width="1" opacity="0"/>
    <circle id="cursor-point" r="4" fill="#c4f48a" opacity="0"/></g>`
}

function update() {
  pendingFrame = null
  const config = state()
  if (!$('target').checkValidity()) {
    $('simulation-note').textContent = '请输入 1–30 rad/s 范围内的整数目标转速。'
    $('export').disabled = $('save-baseline').disabled = true
    return
  }
  try {
    latest = runSimulation(config)
    $('export').disabled = $('save-baseline').disabled = false
    for (const key of ['kp','ki','kd']) $(key+'-value').textContent = fmt(config[key], key === 'kd' ? 3 : 2)
    const m = latest.metrics
    $('overshoot').textContent = fmt(m.overshoot) + '%'
    $('steady-error').textContent = fmt(m.steadyError,3)
    $('rmse').textContent = fmt(m.rmse,3)
    $('settling-time').textContent = m.settlingTime == null ? '窗口内未进入' : fmt(m.settlingTime,3)
    $('settling-time').classList.toggle('long-value', m.settlingTime == null)
    $('simulation-note').textContent = latest.truncated ? '当前参数导致仿真提前截断，请降低增益或重置实验。'
      : m.overshoot > 10 ? `反馈越过目标 ${fmt(m.overshoot)}%。尝试减小 Ki，并与保存的曲线比较。`
      : Math.abs(m.steadyError) > config.target * .05 ? `尾段仍有 ${fmt(Math.abs(m.steadyError),3)} rad/s 的误差。可以尝试引入或调整积分作用。`
      : '当前窗口内误差较小。保存曲线，再试试其他参数，观察响应速度与超调的取舍。'
    $('baseline-legend').hidden = !baseline
    $('baseline-note').textContent = baseline
      ? `对照：Kp=${baseline.config.kp}，Ki=${baseline.config.ki}，Kd=${baseline.config.kd}，目标=${baseline.config.target} rad/s${baseline.config.noise ? '（有噪声）' : ''}。橙色为已保存反馈；目标不同时请勿直接比较绝对误差。`
      : '先保存一条曲线，再调整参数，观察前后差异。'
    drawChart()
    $('hover-readout').textContent = '移动鼠标查看采样值'
  } catch (error) {
    $('simulation-note').textContent = '仿真未能完成：' + error.message
    $('export').disabled = $('save-baseline').disabled = true
  }
}
function scheduleUpdate() { if (pendingFrame) cancelAnimationFrame(pendingFrame); pendingFrame = requestAnimationFrame(update) }
function setPreset(id) {
  for (const key of ['kp','ki','kd']) $(key).value = PRESETS[id][key]
  $('preset').value = id
  update()
}
for (const key of Object.keys(PARAMS)) $(key).addEventListener('input', () => { $('preset').value='custom'; scheduleUpdate() })
$('noise').addEventListener('change', scheduleUpdate)
$('preset').addEventListener('change', () => { if (PRESETS[$('preset').value]) setPreset($('preset').value) })
$('save-baseline').addEventListener('click', () => { update(); if (latest && !$('save-baseline').disabled) { baseline = { samples: latest.samples.map(s=>({...s})), config: state() }; update() } })
$('zoom-transient').addEventListener('change', () => { if (latest) drawChart() })
$('reset').addEventListener('click', () => { baseline=null; $('noise').checked=false; $('zoom-transient').checked=false; $('target').value=10; setPreset('pure') })
$('export').addEventListener('click', () => {
  if (!latest) return
  const url = URL.createObjectURL(new Blob([toCsv(latest.samples)],{type:'text/csv;charset=utf-8;'}))
  const link = document.createElement('a'); link.href=url; link.download='TUNER-motor-simulation.csv'; link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
})
svg.addEventListener('pointermove', event => {
  if (!latest || !chartScale) return
  const rect=svg.getBoundingClientRect(), px=(event.clientX-rect.left)/rect.width*780
  const duration = viewDuration()
  const t=Math.max(0,Math.min(duration,(px-chartScale.left)/chartScale.width*duration))
  const sample=latest.samples[Math.min(latest.samples.length-1,Math.round(t/.002))]
  const line=$('cursor-line'), dot=$('cursor-point')
  line.setAttribute('x1',chartScale.x(sample.t));line.setAttribute('x2',chartScale.x(sample.t));line.setAttribute('opacity','.5')
  dot.setAttribute('cx',chartScale.x(sample.t));dot.setAttribute('cy',chartScale.y(sample.feedback));dot.setAttribute('opacity','1')
  $('hover-readout').textContent=`${fmt(sample.t,3)} s · 目标 ${fmt(sample.target)} · 反馈 ${fmt(sample.feedback,3)} rad/s`
})
svg.addEventListener('pointerleave',()=>{ $('cursor-line')?.setAttribute('opacity','0');$('cursor-point')?.setAttribute('opacity','0') })
update()
