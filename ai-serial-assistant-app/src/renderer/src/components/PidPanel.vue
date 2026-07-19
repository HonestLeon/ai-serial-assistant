<script setup>
import { ref, reactive, onMounted, onUnmounted, watch } from 'vue'
import { Promotion, DataAnalysis } from '@element-plus/icons-vue'

const props = defineProps({
  connected: Boolean,
  aiConfig: { type: Object, required: true },
  serialContext: { type: Object, default: null },
  latestPayload: { type: Object, default: null }
})
const emit = defineEmits(['send'])

const stepConfig = reactive({
  command: 'SET_POINT',
  amplitude: '100',
  duration: 2000,
  channel: 0
})

const outputParams = reactive({
  kp: '',
  ki: '',
  kd: ''
})

const collecting = ref(false)
const analyzing = ref(false)
const response = ref([])
const aiResult = ref('')
const error = ref('')

let collectTimer = null

function startStepTest() {
  if (!props.connected) {
    error.value = '请先连接串口'
    return
  }
  error.value = ''
  response.value = []
  collecting.value = true

  // 发送阶跃信号
  const cmd = `${stepConfig.command} ${stepConfig.amplitude}`
  window.electronAPI.serial.send(cmd, 'utf8').catch(e => {
    error.value = `发送失败: ${e.message || e}`
  })
  emit('send', cmd.length)

  // 采集时长后自动停止
  collectTimer = setTimeout(() => {
    stopCollection()
  }, stepConfig.duration)
}

function stopCollection() {
  collecting.value = false
  if (collectTimer) {
    clearTimeout(collectTimer)
    collectTimer = null
  }
}

function onSerialData(payload) {
  if (!collecting.value) return
  // FireWater 格式：标签:值，只提取冒号后的数值
  const rawText = String(payload.raw)
  const colonIdx = rawText.indexOf(':')
  const dataPart = colonIdx >= 0 ? rawText.slice(colonIdx + 1) : rawText
  const nums = dataPart.match(/[-+]?\d*\.?\d+/g)
  if (nums && nums.length > stepConfig.channel) {
    response.value.push({
      t: response.value.length,
      v: parseFloat(nums[stepConfig.channel])
    })
  }
}

async function analyzeResponse() {
  if (response.value.length < 5) {
    error.value = '采集数据不足，请先执行阶跃测试'
    return
  }

  error.value = ''
  analyzing.value = true
  aiResult.value = ''

  const data = response.value.map(p => `t=${p.t}, y=${p.v.toFixed(4)}`).join('\n')
  const systemPrompt = `你是 PID 控制专家。根据以下阶跃响应数据，分析系统特性（超调量、上升时间、调节时间、稳态误差），并给出推荐的 PID 参数。请按以下格式输出：
分析：...
推荐参数：
Kp=xxx
Ki=xxx
Kd=xxx
理由：...`

  const userPrompt = `阶跃响应数据（共 ${response.value.length} 点，阶跃幅值 ${stepConfig.amplitude}）：\n${data}\n\n请分析并推荐 PID 参数。`

  try {
    const res = await fetch(`${props.aiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: props.aiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      })
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data2 = await res.json()
    aiResult.value = data2.choices?.[0]?.message?.content || '（无返回内容）'

    // 尝试解析推荐参数
    const kpMatch = aiResult.value.match(/Kp\s*[=:]\s*([-\d.]+)/i)
    const kiMatch = aiResult.value.match(/Ki\s*[=:]\s*([-\d.]+)/i)
    const kdMatch = aiResult.value.match(/Kd\s*[=:]\s*([-\d.]+)/i)
    if (kpMatch) outputParams.kp = kpMatch[1]
    if (kiMatch) outputParams.ki = kiMatch[1]
    if (kdMatch) outputParams.kd = kdMatch[1]
  } catch (e) {
    error.value = `AI 分析失败: ${e.message}`
  } finally {
    analyzing.value = false
  }
}

async function sendParams() {
  if (!props.connected) {
    error.value = '请先连接串口'
    return
  }
  error.value = ''
  const cmd = `PID ${outputParams.kp} ${outputParams.ki} ${outputParams.kd}`
  try {
    await window.electronAPI.serial.send(cmd, 'utf8')
    emit('send', cmd.length)
    error.value = `已下发: ${cmd}`
  } catch (e) {
    error.value = `下发失败: ${e.message || e}`
  }
}

function clearAll() {
  response.value = []
  aiResult.value = ''
  error.value = ''
  outputParams.kp = ''
  outputParams.ki = ''
  outputParams.kd = ''
}

// 监听父组件传来的数据（兼容真实串口和模拟数据）
watch(() => props.latestPayload, (payload) => {
  if (payload) onSerialData(payload)
})

onUnmounted(() => {
  stopCollection()
})
</script>

<template>
  <div class="pid-panel">
    <div class="pid-content">
      <!-- 步骤 1: 阶跃信号配置 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">1</div>
          <div class="step-title">阶跃信号发送</div>
          <el-tag v-if="collecting" type="warning" effect="dark" size="small">采集中</el-tag>
        </div>
        <div class="step-body">
          <div class="param-grid">
            <div class="field">
              <label>阶跃指令</label>
              <el-input v-model="stepConfig.command" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>幅值</label>
              <el-input v-model="stepConfig.amplitude" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>采集时长 (ms)</label>
              <el-input v-model.number="stepConfig.duration" type="number" size="small" :disabled="collecting" />
            </div>
            <div class="field">
              <label>采集通道</label>
              <el-select v-model="stepConfig.channel" size="small" :disabled="collecting">
                <el-option v-for="i in 8" :key="i - 1" :label="`I${i - 1}`" :value="i - 1" />
              </el-select>
            </div>
          </div>
          <div class="action-row">
            <button class="btn-primary" :disabled="!connected || collecting" @click="startStepTest">
              <el-icon size="13"><Promotion /></el-icon>
              <span>发送阶跃信号</span>
            </button>
            <button v-if="collecting" class="btn-danger" @click="stopCollection">停止采集</button>
            <span v-if="response.length > 0" class="data-count">已采集 {{ response.length }} 点</span>
          </div>
        </div>
      </div>

      <!-- 步骤 2: AI 分析 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">2</div>
          <div class="step-title">AI 参数分析</div>
        </div>
        <div class="step-body">
          <div class="action-row">
            <button class="btn-ai" :disabled="analyzing || response.length < 5" @click="analyzeResponse">
              <el-icon size="13"><DataAnalysis /></el-icon>
              <span>{{ analyzing ? '分析中...' : 'AI 分析响应' }}</span>
            </button>
            <button class="btn-secondary" @click="clearAll">清空</button>
          </div>
          <div v-if="error" class="error-msg">{{ error }}</div>
          <div v-if="aiResult" class="ai-result">
            <div class="result-label">AI 分析结果：</div>
            <pre>{{ aiResult }}</pre>
          </div>
        </div>
      </div>

      <!-- 步骤 3: 参数下发 -->
      <div class="step-card">
        <div class="step-header">
          <div class="step-number">3</div>
          <div class="step-title">参数下发</div>
        </div>
        <div class="step-body">
          <div class="param-grid">
            <div class="field">
              <label>Kp</label>
              <el-input v-model="outputParams.kp" size="small" placeholder="比例系数" />
            </div>
            <div class="field">
              <label>Ki</label>
              <el-input v-model="outputParams.ki" size="small" placeholder="积分系数" />
            </div>
            <div class="field">
              <label>Kd</label>
              <el-input v-model="outputParams.kd" size="small" placeholder="微分系数" />
            </div>
          </div>
          <div class="action-row">
            <button class="btn-primary" :disabled="!connected" @click="sendParams">
              <el-icon size="13"><Promotion /></el-icon>
              <span>下发 PID 参数</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pid-panel {
  display: flex;
  height: 100%;
  color: var(--color-text-primary);
  overflow-y: auto;
  padding: var(--space-4);
}

.pid-content {
  max-width: 720px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.step-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.step-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border-default);
  background: var(--color-bg-tertiary);
}

.step-number {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-ai);
  color: var(--color-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: 700;
  flex-shrink: 0;
}

.step-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.step-body {
  padding: var(--space-4);
}

.param-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.data-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
}

.error-msg {
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: rgba(248, 81, 73, 0.08);
  border: 1px solid rgba(248, 81, 73, 0.2);
  border-radius: var(--radius-sm);
  color: var(--state-error);
  font-size: var(--text-xs);
}

.ai-result {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-ai);
  border-radius: var(--radius-sm);
}

.result-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-ai);
  margin-bottom: var(--space-1);
}

.ai-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-text-inverse);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-ai {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-ai);
  border-radius: var(--radius-sm);
  background: var(--color-ai-muted);
  color: var(--color-ai);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-ai:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--state-error);
  color: var(--color-text-inverse);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary {
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  white-space: nowrap;
}
</style>
