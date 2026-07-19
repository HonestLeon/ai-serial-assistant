<script setup>
import { ref, onMounted, reactive, watch } from 'vue'
import { Refresh, Link, SetUp, MagicStick } from '@element-plus/icons-vue'

const props = defineProps({
  aiConfig: { type: Object, required: true },
  aiSwitches: { type: Object, required: true },
  protocolEngine: { type: String, default: 'raw' }
})

const emit = defineEmits([
  'status-change',
  'error',
  'update-ai-config',
  'update-ai-switches',
  'update-protocol'
])

const ports = ref([])
const connected = ref(false)
const loading = ref(false)
const statusPath = ref('')

const config = reactive({
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
})

const dtrState = ref(false)
const rtsState = ref(false)

const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
const dataBitsOptions = [5, 6, 7, 8]
const stopBitsOptions = [1, 1.5, 2]
const parityOptions = ['none', 'even', 'odd', 'mark', 'space']
const flowOptions = ['none', 'rts/cts', 'xon/xoff']
const aiModels = ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'qwen-turbo']

const localProtocol = ref(props.protocolEngine)

watch(() => props.protocolEngine, (v) => { localProtocol.value = v })

function onProtocolChange() {
  emit('update-protocol')
}

function onAiConfigChange() {
  emit('update-ai-config')
}

function onAiSwitchChange() {
  emit('update-ai-switches')
}

async function refreshPorts() {
  try {
    ports.value = await window.electronAPI.serial.list()
    if (ports.value.length > 0 && !config.path) {
      config.path = ports.value[0].path
    }
  } catch (e) {
    emit('error', e.message || '获取串口列表失败')
  }
}

async function toggleConnection() {
  loading.value = true
  try {
    if (connected.value) {
      await window.electronAPI.serial.close()
    } else {
      await window.electronAPI.serial.open({
        path: config.path,
        baudRate: config.baudRate,
        dataBits: config.dataBits,
        stopBits: config.stopBits,
        parity: config.parity,
        flowControl: config.flowControl,
        protocol: localProtocol.value
      })
    }
  } catch (e) {
    emit('error', e)
  } finally {
    loading.value = false
  }
}

async function toggleDtr() {
  if (!connected.value) return
  dtrState.value = !dtrState.value
  try {
    await window.electronAPI.serial.setDtr(dtrState.value)
  } catch (e) {
    dtrState.value = !dtrState.value
    emit('error', e.message || e)
  }
}

async function toggleRts() {
  if (!connected.value) return
  rtsState.value = !rtsState.value
  try {
    await window.electronAPI.serial.setRts(rtsState.value)
  } catch (e) {
    rtsState.value = !rtsState.value
    emit('error', e.message || e)
  }
}

onMounted(() => {
  refreshPorts()
  window.electronAPI?.serial?.onStatus?.((status) => {
    connected.value = status.connected
    statusPath.value = status.path || ''
    emit('status-change', { ...status, baudRate: config.baudRate })
  })
  window.electronAPI?.serial?.onError?.((msg) => {
    emit('error', msg)
  })
})
</script>

<template>
  <div class="serial-panel">
    <!-- Protocol & Connection -->
    <div class="section">
      <div class="section-title">
        <el-icon size="14" color="var(--color-primary)"><Link /></el-icon>
        <span>协议与连接</span>
      </div>
      <div class="field">
        <label>数据引擎</label>
        <el-select
          v-model="localProtocol"
          size="small"
          :disabled="connected"
          @change="onProtocolChange"
        >
          <el-option label="Raw（文本行）" value="raw" />
          <el-option label="JustFloat（浮点帧）" value="justfloat" />
          <el-option label="FireWater（标签:值）" value="firewater" />
        </el-select>
      </div>
      <div class="field">
        <label>数据接口</label>
        <el-select size="small" disabled>
          <el-option label="串口" value="serial" />
        </el-select>
      </div>
    </div>

    <div class="divider"></div>

    <!-- Serial Parameters -->
    <div class="section">
      <div class="section-title">
        <el-icon size="14" color="var(--color-text-secondary)"><SetUp /></el-icon>
        <span>串口参数</span>
      </div>
      <div class="param-grid">
        <div class="field">
          <label>端口</label>
          <div class="select-row">
            <el-select v-model="config.path" :disabled="connected" size="small">
              <el-option v-for="p in ports" :key="p.path" :label="p.path" :value="p.path" />
            </el-select>
            <el-button :icon="Refresh" size="small" :disabled="connected" @click="refreshPorts" />
          </div>
        </div>
        <div class="field">
          <label>波特率</label>
          <el-select v-model="config.baudRate" :disabled="connected" size="small">
            <el-option v-for="b in baudRates" :key="b" :label="b" :value="b" />
          </el-select>
        </div>
        <div class="field">
          <label>数据位</label>
          <el-select v-model="config.dataBits" :disabled="connected" size="small">
            <el-option v-for="d in dataBitsOptions" :key="d" :label="d" :value="d" />
          </el-select>
        </div>
        <div class="field">
          <label>停止位</label>
          <el-select v-model="config.stopBits" :disabled="connected" size="small">
            <el-option v-for="s in stopBitsOptions" :key="s" :label="s" :value="s" />
          </el-select>
        </div>
        <div class="field">
          <label>校验位</label>
          <el-select v-model="config.parity" :disabled="connected" size="small">
            <el-option v-for="p in parityOptions" :key="p" :label="p" :value="p" />
          </el-select>
        </div>
        <div class="field">
          <label>流控</label>
          <el-select v-model="config.flowControl" :disabled="connected" size="small">
            <el-option v-for="f in flowOptions" :key="f" :label="f" :value="f" />
          </el-select>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- Connection Control -->
    <div class="section">
      <el-button
        :type="connected ? 'danger' : 'success'"
        size="small"
        style="width: 100%"
        :loading="loading"
        @click="toggleConnection"
      >
        {{ connected ? '关闭串口' : '打开串口' }}
      </el-button>
      <div class="dtr-rts">
        <button class="small-btn" :class="{ active: dtrState }" :disabled="!connected" @click="toggleDtr">DTR</button>
        <button class="small-btn" :class="{ active: rtsState }" :disabled="!connected" @click="toggleRts">RTS</button>
      </div>
      <div class="status-box">
        <div class="status-dot" :style="{ background: connected ? 'var(--state-success)' : 'var(--color-text-tertiary)' }"></div>
        <span>{{ connected ? `已连接 ${statusPath}` : '未连接' }}</span>
      </div>
    </div>

    <div class="divider"></div>

    <!-- AI Settings -->
    <div class="section">
      <div class="section-title ai">
        <el-icon size="14" color="var(--color-ai)"><MagicStick /></el-icon>
        <span>AI 设置</span>
      </div>
      <div class="field">
        <label>AI 模型</label>
        <el-select
          v-model="props.aiConfig.model"
          size="small"
          filterable
          allow-create
          default-first-option
          placeholder="选择或输入模型名"
          @change="onAiConfigChange"
        >
          <el-option v-for="m in aiModels" :key="m" :label="m" :value="m" />
        </el-select>
      </div>
      <div class="field">
        <label>Base URL</label>
        <el-input v-model="props.aiConfig.baseUrl" size="small" @change="onAiConfigChange" />
      </div>
      <div class="field">
        <label>API Key</label>
        <el-input v-model="props.aiConfig.apiKey" size="small" type="password" show-password @change="onAiConfigChange" />
      </div>
      <div class="toggle-row">
        <span>实时异常检测</span>
        <el-switch v-model="props.aiSwitches.anomalyDetection" size="small" @change="onAiSwitchChange" />
      </div>
      <div class="toggle-row">
        <span>协议自动识别</span>
        <el-switch v-model="props.aiSwitches.protocolRecognition" size="small" @change="onAiSwitchChange" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.serial-panel {
  overflow: visible;
  padding-bottom: var(--space-4);
  color: var(--color-text-primary);
}

.section {
  padding: var(--space-3) var(--space-4);
  overflow: visible;
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.section-title.ai {
  color: var(--color-ai);
}

.divider {
  height: 1px;
  background: var(--color-border-subtle);
  margin: 0 var(--space-4);
}

.field {
  margin-bottom: var(--space-2);
  overflow: visible;
}

.field label {
  display: block;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-bottom: 2px;
}

.param-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.select-row {
  display: flex;
  gap: var(--space-1);
}

.select-row .el-select {
  flex: 1;
}

.dtr-rts {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.small-btn {
  flex: 1;
  height: 24px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  font-family: var(--font-family-mono);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.small-btn.active {
  background: var(--color-primary-muted);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.status-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2);
  background: var(--color-bg-primary);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
</style>
