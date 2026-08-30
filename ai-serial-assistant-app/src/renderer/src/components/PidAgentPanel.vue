<script setup>
import { ref, reactive, computed, watch, nextTick, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { usePidAgent } from '../composables/usePidAgent.mjs'

const props = defineProps({
  connected: Boolean,
  aiConfig: { type: Object, default: null },
  latestPayload: { type: Object, default: null }
})
const emit = defineEmits(['send', 'simulation-data'])

// ---------------- 智能体编排实例 ----------------
const agent = usePidAgent({
  getAiConfig: () => props.aiConfig,
  getConnected: () => props.connected,
  onSimulationData: (samples) => emit('simulation-data', samples),
  onSerialSend: (cmd) => {
    // 固件按行解析指令（'\n' 结尾才执行）：工具产出 "SET_POINT 20" 不带换行，
    // 必须补上——否则设备永远收不到完整行，表现为 target/feedback/output 全 0
    const line = String(cmd ?? '').endsWith('\n') ? String(cmd) : `${cmd}\n`
    window.electronAPI?.serial?.send?.(line, 'utf8')
    emit('send', line.length)
  }
})

const {
  // 配置状态
  strategyId, strategyOptions, pidConfig, safetyRange, feedforwardItems, scenePrompt, testMode,
  tuningStrategy, pidStructure,
  addFeedforwardItem, removeFeedforwardItem,
  // 运行状态
  messages, running, turnCount, ctxBytes, stopReason, currentPid, currentFf, paramHighlight,
  // 方法
  startAgent, sendChat, stopAgent
} = agent

// 串口数据流入（真实串口模式下由智能体写入通道数据缓冲）。
// 注意：DataMonitor 已做 100ms 批处理（高频遥测防渲染饱和），本 watch 每批只触发
// 一次（末条样本生效）→ 智能体缓冲以 ~10Hz 采样。对本项目目标系统（τ≈0.25s 电机/
// 位置环）的阶跃指标分析而言采样密度充足，且缓冲不会随设备原始速率膨胀。
watch(() => props.latestPayload, (payload) => {
  if (payload) agent.onSerialData(payload)
})

// ---------------- 左栏派生状态 ----------------

/** 上下文压缩阈值（KB，与 usePidAgent 的 COMPACT_THRESHOLD_BYTES 对应） */
const CTX_LIMIT_KB = 50

const ctxPercent = computed(() => Math.min(100, (Number(ctxBytes.value) / CTX_LIMIT_KB) * 100))
const ctxFillClass = computed(() => {
  if (ctxPercent.value >= 100) return 'full'
  if (ctxPercent.value >= 80) return 'warn'
  return ''
})

/** 串级策略：总览展开位置环 + 速度环六项；单环仅 kp/ki/kd 三项（label 取自 pidConfig 定义表） */
const isCascade = computed(() => strategyId.value === 'cascade_position')
const overviewEntries = computed(() => {
  const keyMap = isCascade.value
    ? { positionKp: 'kp', positionKi: 'ki', positionKd: 'kd', speedKp: 'speedKp', speedKi: 'speedKi', speedKd: 'speedKd' }
    : { kp: 'kp', ki: 'ki', kd: 'kd' }
  return pidConfig
    .map((item) => {
      const currentKey = keyMap[item.key]
      return currentKey ? { key: currentKey, label: item.label, value: currentPid[currentKey] } : null
    })
    .filter(Boolean)
})

// 参数变化高亮：paramHighlight 记录变化时间戳，5 秒内保持绿色（周期刷新 now 使 class 到期回落）
const nowTs = ref(Date.now())
const nowTimer = setInterval(() => { nowTs.value = Date.now() }, 500)

function isParamChanged(key) {
  const ts = Number(paramHighlight[key])
  return ts > 0 && nowTs.value - ts < 5000
}

// ---------------- 前馈项弹窗 ----------------

const FF_PRESETS = [
  { id: 'linear', label: '线性 Kff · target' },
  { id: 'quadratic', label: '二次 Kff · target²' },
  { id: 'sin', label: 'sin Kff · sin(target)' },
  { id: 'cos', label: 'cos Kff · cos(target)' },
  { id: 'gravity', label: '重力补偿 m·g·l·sin(target)' },
  { id: 'bias', label: '常数偏置 Kff' },
  { id: 'deriv', label: '目标一阶导 Kff · d(target)/dt' }
]

const ffDialogVisible = ref(false)
const ffForm = reactive({ type: 'gravity', init: 0.5, min: 0, max: 5 })

function openFfDialog() {
  ffForm.type = 'gravity'
  ffForm.init = 0.5
  ffForm.min = 0
  ffForm.max = 5
  ffDialogVisible.value = true
}

function confirmFfDialog() {
  const preset = FF_PRESETS.find((item) => item.id === ffForm.type)
  addFeedforwardItem({
    id: ffForm.type,
    label: preset ? preset.label : ffForm.type,
    init: ffForm.init,
    min: ffForm.min,
    max: ffForm.max
  })
  ffDialogVisible.value = false
}

// ---------------- 状态与对话交互 ----------------

const STOP_REASON_TEXT = {
  stop: '正常结束',
  'max-turns': '达到回合上限',
  aborted: '已中止',
  'user-stop': '用户停止',
  error: '出现错误'
}

const statusText = computed(() => {
  if (running.value) return '调参运行中'
  if (stopReason.value) {
    return `已停止 · ${STOP_REASON_TEXT[stopReason.value] || stopReason.value}`
  }
  return '等待输入'
})

/**
 * 等待 LLM 首次/下一轮回复：运行中且最后一条消息不是进行中的工具、
 * 也不是已完成的思考文本时，显示"思考中"指示（否则 LLM 慢/失败时对话区毫无反馈）。
 */
const awaitingReply = computed(() => {
  if (!running.value || messages.value.length === 0) return false
  const last = messages.value[messages.value.length - 1]
  if (last.kind === 'user' || last.kind === 'steerUser') return true
  if (last.kind === 'tool' && last.toolStatus !== 'running') return true
  return false
})

const DEFAULT_TASK_TEXT = '请根据用户配置开始调参，达成场景提示词中描述的目标。'
const inputText = ref('')

/** 发送按钮 / 回车：空闲时发起调参任务（sendChat 内部转 startAgent），运行中即中途纠偏 */
function onSendChat() {
  const text = inputText.value.trim()
  if (!text) return
  const pending = sendChat(text)
  inputText.value = ''
  if (pending && typeof pending.catch === 'function') {
    pending.catch((e) => ElMessage.error(e?.message || String(e)))
  }
}

// Enter 发送 / Shift+Enter 换行（isComposing：中文输入法组词确认的回车不触发发送）
function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    onSendChat()
  }
}

/** 模式切换（合并为单按键）：仿真 ⇄ 真实串口；运行中禁用避免数据/参数错乱 */
function toggleTestMode() {
  if (running.value) return
  testMode.value = testMode.value === 'simulation' ? 'serial' : 'simulation'
}

/** 开始调参：取输入框文本（空则用默认任务描述），校验失败经 ElMessage 提示原因 */
async function onStartAgent() {
  if (running.value) return
  const text = inputText.value.trim() || DEFAULT_TASK_TEXT
  try {
    await startAgent(text)
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  }
}

function clearConversation() {
  if (running.value) return
  messages.value = []
}

// ---------------- 打字机与自动滚底 ----------------

const msgFlowRef = ref(null)
const typewriterTimers = new Map()

/** 助手消息打字机：16ms 一帧、每帧 +2 字符，推进 shownLen 至 text.length 后自清理 */
function startTypewriter(msg) {
  const timer = setInterval(() => {
    const alive = messages.value.some((m) => m.id === msg.id)
    if (!alive || msg.shownLen >= msg.text.length) {
      clearInterval(timer)
      typewriterTimers.delete(msg.id)
      return
    }
    msg.shownLen = Math.min(msg.text.length, msg.shownLen + 2)
  }, 16)
  typewriterTimers.set(msg.id, timer)
}

function scrollToBottom() {
  nextTick(() => {
    const el = msgFlowRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 新 assistant 消息（shownLen===0）启动打字机；消息流任何变化（含打字推进）后自动滚底
watch(messages, () => {
  messages.value.forEach((msg) => {
    if (msg.kind === 'assistant' && msg.text && msg.shownLen === 0 && !typewriterTimers.has(msg.id)) {
      startTypewriter(msg)
    }
  })
  scrollToBottom()
}, { deep: true })

function kb(bytes) {
  return (Number(bytes) / 1024).toFixed(1)
}

onUnmounted(() => {
  typewriterTimers.forEach((timer) => clearInterval(timer))
  typewriterTimers.clear()
  clearInterval(nowTimer)
  stopAgent()
})
</script>

<template>
  <div class="pid-agent">
    <!-- ============ 左栏：调参前配置 ============ -->
    <div class="pa-left">

      <!-- 测试模式（单按键切换）+ 仿真策略 -->
      <div class="card">
        <div class="card-title">测试模式 · 仿真策略</div>
        <button
          class="mode-toggle"
          :class="{ serial: testMode === 'serial' }"
          type="button"
          :disabled="running"
          @click="toggleTestMode"
        >
          <span class="mode-name">{{ testMode === 'simulation' ? '仿真测试' : '真实串口' }}</span>
          <span class="mode-switch">{{ testMode === 'simulation' ? '切换为真实串口' : '切换为仿真测试' }}</span>
        </button>
        <div v-if="testMode === 'simulation'" class="strategy-block">
          <el-select v-model="strategyId" size="small">
            <el-option
              v-for="item in strategyOptions"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
          <p class="mode-hint">仿真模式仅需选择策略，场景描述自动按策略说明生成</p>
        </div>
        <p v-else class="mode-hint serial-hint">真实串口：请填写下方「控制场景提示词」与「调参策略」</p>
      </div>

      <!-- ① PID 参数 · 初始值与范围（串口模式附加 PID 结构选择） -->
      <div class="card">
        <div class="card-title">
          <span class="num">1</span> PID 参数 · 初始值与范围
          <span v-if="testMode === 'serial'" class="structure-select">
            <el-radio-group v-model="pidStructure" size="small">
              <el-radio-button value="single">单环</el-radio-button>
              <el-radio-button value="cascade">串级</el-radio-button>
            </el-radio-group>
          </span>
        </div>
        <table class="param-table">
          <thead>
            <tr><th>参数</th><th>初始值</th><th>最小</th><th>最大</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in pidConfig" :key="item.key">
              <td class="param-name">{{ item.label }}</td>
              <td><el-input-number v-model="item.init" :controls="false" size="small" /></td>
              <td><el-input-number v-model="item.min" :controls="false" size="small" /></td>
              <td><el-input-number v-model="item.max" :controls="false" size="small" /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ② 信号安全范围 -->
      <div class="card">
        <div class="card-title"><span class="num">2</span> 信号安全范围<span class="hint">越限告警</span></div>
        <div class="range-row">
          <span class="range-label">控制值</span>
          <el-input-number v-model="safetyRange.control.min" :controls="false" size="small" />
          <span class="sep">~</span>
          <el-input-number v-model="safetyRange.control.max" :controls="false" size="small" />
        </div>
        <div class="range-row">
          <span class="range-label">反馈值</span>
          <el-input-number v-model="safetyRange.feedback.min" :controls="false" size="small" />
          <span class="sep">~</span>
          <el-input-number v-model="safetyRange.feedback.max" :controls="false" size="small" />
        </div>
        <div class="range-row">
          <span class="range-label">目标值</span>
          <el-input-number v-model="safetyRange.target.min" :controls="false" size="small" />
          <span class="sep">~</span>
          <el-input-number v-model="safetyRange.target.max" :controls="false" size="small" />
        </div>
      </div>

      <!-- ③ 前馈项 -->
      <div class="card">
        <div class="card-title"><span class="num">3</span> 前馈项<span class="hint">点 + 自行添加</span></div>
        <button class="ff-add-btn" type="button" @click="openFfDialog">＋ 添加前馈项（含初始值与范围）</button>
        <div v-for="item in feedforwardItems" :key="item.id" class="ff-item">
          <span class="ff-name">{{ item.label }}</span>
          <span class="ff-range">系数 {{ item.init }} ∈ [{{ item.min }}, {{ item.max }}]</span>
          <button class="ff-del" type="button" aria-label="删除前馈项" @click="removeFeedforwardItem(item.id)">×</button>
        </div>
      </div>

      <!-- ④ 控制场景提示词（仅真实串口模式；仿真模式自动按策略说明补齐） -->
      <div v-if="testMode === 'serial'" class="card">
        <div class="card-title"><span class="num">4</span> 控制场景提示词<span class="hint">必填 · 永不压缩</span></div>
        <textarea
          v-model="scenePrompt"
          class="prompt-area"
          placeholder="描述控制场景 / 被控对象、调参目标与特殊约束…"
        ></textarea>
      </div>

      <!-- ⑤ 调参策略（仅真实串口模式，自由文本指导 LLM 整定实机） -->
      <div v-if="testMode === 'serial'" class="card">
        <div class="card-title"><span class="num">5</span> 调参策略<span class="hint">必填 · 自由描述</span></div>
        <textarea
          v-model="tuningStrategy"
          class="prompt-area"
          placeholder="如：分阶段 P→PI→PID；先压超调再降稳态误差；设备目标为斜坡，等待收敛后再评估…"
        ></textarea>
      </div>

      <!-- 当前参数总览 -->
      <div class="card">
        <div class="card-title">当前参数总览</div>
        <div class="overview-params">
          <div
            v-for="entry in overviewEntries"
            :key="entry.key"
            class="overview-param"
            :class="{ changed: isParamChanged(entry.key) }"
          >
            <span class="pn">{{ entry.label }}</span>
            <span class="pv">{{ entry.value }}</span>
          </div>
        </div>
        <div v-if="feedforwardItems.length" class="overview-ff">
          前馈:
          <span v-for="item in feedforwardItems" :key="item.id" class="tagf">
            {{ item.label }}={{ currentFf[item.id] ?? item.init }}
          </span>
        </div>
      </div>

      <!-- 上下文用量 + 启停控制 -->
      <div class="card">
        <div class="card-title">上下文用量（仅数据计入）</div>
        <div class="ctx-meter">
          <div class="ctx-label">
            <span>{{ ctxBytes.toFixed(1) }} KB</span>
            <span>阈值 {{ CTX_LIMIT_KB }} KB</span>
          </div>
          <div class="ctx-bar">
            <div class="ctx-fill" :class="ctxFillClass" :style="{ width: ctxPercent + '%' }"></div>
          </div>
        </div>
        <button v-if="!running" class="start-btn" type="button" @click="onStartAgent">开始调参</button>
        <button v-else class="stop-btn" type="button" @click="stopAgent">停止</button>
      </div>
    </div>

    <!-- ============ 右栏：对话区（Agent 工作台） ============ -->
    <div class="pa-right">
      <div class="chat-header">
        <span class="status-dot" :class="{ running }"></span>
        <span class="status-text">{{ statusText }}</span>
        <span class="turn-badge">回合 {{ turnCount }}</span>
        <div class="right">
          <button class="clear-btn" type="button" :disabled="running" @click="clearConversation">清空对话</button>
        </div>
      </div>

      <div ref="msgFlowRef" class="msg-flow">
        <div v-if="!messages.length" class="flow-bottom-hint">
          空闲时输入 = 发起调参任务或自由提问（原「AI 助手」能力合并于此）<br>
          运行中输入即中途纠偏（steer）· 工具调用 / 安全回退 / 上下文压缩过程将在此消息流实时展示
        </div>

        <div v-for="msg in messages" :key="msg.id" class="msg">
          <!-- 用户消息（steerUser：琥珀色边框 + steer 标签；note：追加任务小标签） -->
          <div
            v-if="msg.kind === 'user' || msg.kind === 'steerUser'"
            class="msg-user"
            :class="{ steer: msg.kind === 'steerUser' }"
          >
            <div class="role">
              用户
              <span v-if="msg.kind === 'steerUser'" class="steer-tag">中途插入 · steer</span>
              <span v-else-if="msg.note" class="note-tag">{{ msg.note }}</span>
            </div>
            <div class="body">{{ msg.text }}</div>
          </div>

          <!-- 助手思考（打字机推进：text.slice(0, shownLen) + 光标） -->
          <div v-else-if="msg.kind === 'assistant'" class="msg-thinking">
            <div class="role">🤔 助手 · 思考</div>
            <div class="body">
              <span class="txt">{{ msg.text.slice(0, msg.shownLen) }}</span>
              <span v-if="msg.shownLen < msg.text.length" class="cursor"></span>
            </div>
          </div>

          <!-- 工具调用单行（执行中 spinner → 完成 ✓ 耗时 / 失败 ✗ 变红；不展示 JSON） -->
          <div
            v-else-if="msg.kind === 'tool'"
            class="tool-line"
            :class="{ done: msg.toolStatus === 'done', err: msg.toolStatus === 'error' }"
          >
            <span class="tool-icon">🔧</span>
            <span class="tool-text">
              <template v-if="msg.toolStatus === 'running'">正在调用 <span class="tool-name">{{ msg.toolName }}</span> 工具…</template>
              <template v-else-if="msg.toolStatus === 'error'">调用 <span class="tool-name">{{ msg.toolName }}</span> 失败</template>
              <template v-else>已调用 <span class="tool-name">{{ msg.toolName }}</span></template>
            </span>
            <span class="tool-status">
              <span v-if="msg.toolStatus === 'running'" class="spinner"></span>
              <template v-else>{{ msg.toolStatus === 'error' ? '✗' : '✓' }} {{ msg.durationMs }}ms</template>
            </span>
          </div>

          <!-- 安全机制警示 -->
          <div v-else-if="msg.kind === 'safety'" class="msg-safety">
            <div class="role">⚠ 安全机制 · 自动回退</div>
            <div class="body">{{ msg.text }}</div>
          </div>

          <!-- 运行失败（LLM 调用失败等：错误原因进聊天流，避免"卡住无反馈"） -->
          <div v-else-if="msg.kind === 'error'" class="msg-error">
            <div class="role">✗ 出错</div>
            <div class="body">{{ msg.text }}</div>
          </div>

          <!-- 上下文压缩 -->
          <div v-else-if="msg.kind === 'compact'" class="msg-compact">
            <span class="icon">📦</span>
            <span>上下文已压缩 <span class="bytes">{{ kb(msg.beforeBytes) }}KB → {{ kb(msg.afterBytes) }}KB</span>（仅数据部分）</span>
          </div>
        </div>

        <!-- 等待 LLM 回复的"思考中"指示（消息流之后追加，非消息实体） -->
        <div v-if="awaitingReply" class="msg-thinking awaiting">
          <div class="role">🤔 助手 · 思考</div>
          <div class="body">
            <span class="thinking-dots"><i></i><i></i><i></i></span>
          </div>
        </div>
      </div>

      <div class="chat-input">
        <div class="input-hint" :class="{ running }">
          {{ running ? '⚡ 运行中 · 输入即中途纠偏（steer）' : '💡 空闲时输入 = 发起调参任务或自由提问（原「AI 助手」能力合并于此）' }}
        </div>
        <div class="input-row">
          <textarea
            v-model="inputText"
            class="chat-textinput"
            rows="1"
            :placeholder="running ? '运行中：例如「稳态误差不用管，优先压超调」…' : '例如：开始整定，优先压超调…'"
            @keydown="onInputKeydown"
          ></textarea>
          <button class="send-btn" type="button" @click="onSendChat">发送</button>
        </div>
      </div>
    </div>

    <!-- 前馈项添加弹窗 -->
    <el-dialog v-model="ffDialogVisible" title="添加前馈项" width="340px" append-to-body>
      <div class="ff-form">
        <div class="ff-field">
          <label>前馈类型（预置模板，可自定义范围）</label>
          <el-select v-model="ffForm.type" size="small">
            <el-option
              v-for="preset in FF_PRESETS"
              :key="preset.id"
              :label="preset.label"
              :value="preset.id"
            />
          </el-select>
        </div>
        <div class="ff-field">
          <label>系数初始值</label>
          <el-input-number v-model="ffForm.init" :controls="false" size="small" />
        </div>
        <div class="ff-field">
          <label>系数取值范围</label>
          <div class="ff-range-grid">
            <el-input-number v-model="ffForm.min" :controls="false" size="small" />
            <el-input-number v-model="ffForm.max" :controls="false" size="small" />
          </div>
        </div>
      </div>
      <template #footer>
        <div class="ff-actions">
          <button class="btn-cancel" type="button" @click="ffDialogVisible = false">取消</button>
          <button class="btn-confirm" type="button" @click="confirmFfDialog">添加</button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pid-agent {
  display: flex;
  height: 100%;
  width: 100%;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
  color: var(--color-text-primary);
}

/* ---- 左栏：配置卡片纵向滚动 ---- */
.pa-left {
  flex: 0 0 320px;
  min-width: 300px;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ---- 右栏：对话工作台 ---- */
.pa-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border-default);
  border-radius: 8px;
  background: var(--color-bg-primary);
  overflow: hidden;
}

.card {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: 8px;
  padding: 10px 11px;
  flex-shrink: 0;
}

.card-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.card-title .num {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--color-ai);
  color: var(--color-text-inverse);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  flex-shrink: 0;
}

.card-title .hint {
  margin-left: auto;
  font-size: 9px;
  color: var(--color-text-tertiary);
  font-weight: 400;
}

/* ---- 策略 + 测试来源 ---- */
.strategy-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 模式切换单按键：全宽、当前模式描边、副文案提示可切换 */
.mode-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
  color: var(--color-text-primary);
}

.mode-toggle:hover:not(:disabled) {
  border-color: var(--color-border-active);
}

.mode-toggle.serial {
  border-color: var(--color-ai);
  background: var(--color-ai-muted);
}

.mode-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mode-toggle .mode-name {
  font-size: 12px;
  font-weight: 600;
}

.mode-toggle .mode-switch {
  font-size: 9px;
  color: var(--color-text-tertiary);
}

.mode-toggle.serial .mode-switch {
  color: var(--color-ai);
}

.mode-hint {
  margin: 0;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--color-text-tertiary);
}

.mode-hint.serial-hint {
  padding-top: 2px;
}

/* PID 结构选择（串口模式附加在参数卡标题行右侧） */
.structure-select {
  margin-left: auto;
  display: inline-flex;
}

.structure-select :deep(.el-radio-button__inner) {
  font-size: 9px;
  padding: 4px 8px;
}

/* ---- ① PID 参数表 ---- */
.param-table {
  width: 100%;
  border-collapse: collapse;
}

.param-table th {
  text-align: left;
  font-size: 9px;
  color: var(--color-text-tertiary);
  font-weight: 500;
  padding: 1px 3px 4px;
}

.param-table td {
  padding: 2px 3px;
}

.param-name {
  font-family: var(--font-family-mono);
  font-size: 11px;
  white-space: nowrap;
}

.param-table :deep(.el-input-number) {
  width: 100%;
}

/* ---- ② 安全范围行 ---- */
.range-row {
  display: grid;
  grid-template-columns: 52px 1fr 12px 1fr;
  gap: 5px;
  align-items: center;
  margin-bottom: 6px;
}

.range-row:last-child {
  margin-bottom: 0;
}

.range-label {
  font-size: 10px;
  color: var(--color-text-secondary);
}

.range-row .sep {
  color: var(--color-text-tertiary);
  text-align: center;
  font-size: 10px;
}

.range-row :deep(.el-input-number) {
  width: 100%;
}

/* ---- ③ 前馈项 ---- */
.ff-add-btn {
  width: 100%;
  padding: 6px;
  background: transparent;
  color: var(--color-ai);
  border: 1px dashed var(--color-ai);
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  margin-bottom: 7px;
  font-family: inherit;
}

.ff-add-btn:hover {
  background: var(--color-ai-muted);
}

.ff-item {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 5px;
  padding: 5px 8px;
  margin-bottom: 5px;
  font-size: 10px;
}

.ff-item:last-child {
  margin-bottom: 0;
}

.ff-item .ff-name {
  font-weight: 600;
}

.ff-item .ff-range {
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
  font-size: 9px;
}

.ff-item .ff-del {
  margin-left: auto;
  color: var(--color-text-tertiary);
  cursor: pointer;
  border: none;
  background: none;
  font-size: 13px;
  padding: 0;
  line-height: 1;
}

.ff-item .ff-del:hover {
  color: var(--state-error);
}

/* ---- ④ 场景提示词 ---- */
.prompt-area {
  width: 100%;
  min-height: 62px;
  resize: vertical;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 5px;
  color: var(--color-text-primary);
  font-size: 11px;
  line-height: 1.55;
  padding: 6px 8px;
  outline: none;
  font-family: inherit;
}

.prompt-area:focus {
  border-color: var(--color-border-active);
}

.prompt-area::placeholder {
  color: var(--color-text-tertiary);
}

/* ---- 当前参数总览 ---- */
.overview-params {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 8px;
}

.overview-param {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  padding: 3px 9px;
  min-width: 60px;
  transition: background 0.3s, border-color 0.3s;
}

.overview-param.changed {
  background: var(--state-success-muted);
  border-color: var(--state-success);
}

.overview-param .pn {
  font-size: 9px;
  color: var(--color-text-tertiary);
}

.overview-param .pv {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-family-mono);
}

.overview-ff {
  margin-top: 7px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.overview-ff .tagf {
  display: inline-block;
  padding: 1px 6px;
  margin-left: 4px;
  background: var(--color-ai-muted);
  color: var(--color-ai);
  border: 1px solid var(--color-border-default);
  border-radius: 3px;
  font-family: var(--font-family-mono);
  font-size: 9px;
}

/* ---- 上下文用量 + 启停按钮 ---- */
.ctx-meter {
  margin-bottom: 8px;
}

.ctx-label {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--color-text-tertiary);
  margin-bottom: 3px;
  font-family: var(--font-family-mono);
}

.ctx-bar {
  height: 4px;
  background: var(--color-bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.ctx-fill {
  height: 100%;
  width: 0%;
  background: var(--color-primary);
  border-radius: 2px;
  transition: width 0.5s, background 0.3s;
}

.ctx-fill.warn {
  background: var(--state-warning);
}

.ctx-fill.full {
  background: var(--state-error);
}

.start-btn {
  width: 100%;
  padding: 8px;
  background: var(--color-ai);
  color: var(--color-text-inverse);
  border: none;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.start-btn:hover {
  filter: brightness(1.08);
}

.stop-btn {
  width: 100%;
  padding: 6px;
  background: transparent;
  color: var(--state-error);
  border: 1px solid var(--state-error);
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.stop-btn:hover {
  background: var(--state-error-muted);
}

/* ---- 对话区头部 ---- */
.chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--color-border-default);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
}

.status-dot.running {
  background: var(--state-success);
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.status-text {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.turn-badge {
  font-size: 9px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-default);
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
}

.chat-header .right {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.clear-btn {
  padding: 3px 10px;
  font-size: 10px;
  cursor: pointer;
  background: transparent;
  color: var(--color-text-tertiary);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  font-family: inherit;
}

.clear-btn:hover:not(:disabled) {
  color: var(--color-text-secondary);
  border-color: var(--color-border-active);
}

.clear-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---- 消息流 ---- */
.msg-flow {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.msg {
  margin-bottom: 11px;
  animation: fadeUp 0.25s ease;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}

.flow-bottom-hint {
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 10.5px;
  padding: 4px 0;
  line-height: 1.8;
}

.msg-user {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 7px;
  padding: 7px 10px;
}

.msg-user .role {
  font-size: 9px;
  color: var(--color-primary);
  font-weight: 700;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.msg-user .body {
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.msg-user.steer {
  border-color: var(--state-warning);
  background: var(--state-warning-muted);
}

.msg-user.steer .role {
  color: var(--state-warning);
}

.steer-tag {
  display: inline-block;
  font-size: 8px;
  padding: 0 5px;
  border: 1px solid var(--state-warning);
  border-radius: 3px;
  color: var(--state-warning);
}

.note-tag {
  display: inline-block;
  font-size: 8px;
  padding: 0 5px;
  border: 1px solid var(--color-primary);
  border-radius: 3px;
  color: var(--color-primary);
}

/* 助手思考块：绿色左边框 + 打字机光标 */
.msg-thinking .role {
  font-size: 9px;
  color: var(--color-ai);
  font-weight: 700;
  margin-bottom: 3px;
}

.msg-thinking .body {
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.65;
  border-left: 2px solid var(--color-ai);
  padding-left: 9px;
  white-space: pre-wrap;
}

.cursor {
  display: inline-block;
  width: 6px;
  height: 12px;
  background: var(--color-ai);
  vertical-align: -1px;
  margin-left: 2px;
  animation: blink 0.8s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* 工具调用单行（不展开 JSON 详情） */
.tool-line {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  background: var(--color-bg-primary);
  padding: 6px 11px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.tool-line .tool-icon {
  font-size: 11px;
}

.tool-line .tool-name {
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-primary);
}

.tool-line .tool-status {
  margin-left: auto;
  font-size: 9px;
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-line.done .tool-status {
  color: var(--state-success);
}

.tool-line.err .tool-status {
  color: var(--state-error);
}

.tool-line.err .tool-text {
  color: var(--state-error);
}

.spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 2px solid var(--color-border-default);
  border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 安全机制警示块 */
.msg-safety {
  border: 1px solid var(--state-error);
  border-left-width: 3px;
  background: var(--state-error-muted);
  border-radius: 6px;
  padding: 7px 10px;
}

.msg-safety .role {
  font-size: 9px;
  color: var(--state-error);
  font-weight: 700;
  margin-bottom: 2px;
}

.msg-safety .body {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--state-error);
  white-space: pre-wrap;
}

/* 运行失败消息（LLM 调用失败等原因进聊天流） */
.msg-error {
  border: 1px solid var(--state-error);
  border-left-width: 3px;
  background: var(--state-error-muted);
  border-radius: 6px;
  padding: 7px 10px;
}

.msg-error .role {
  font-size: 9px;
  color: var(--state-error);
  font-weight: 700;
  margin-bottom: 2px;
}

.msg-error .body {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--state-error);
  white-space: pre-wrap;
  word-break: break-all;
}

/* 等待 LLM 回复的"思考中"指示（三点跳动动画） */
.awaiting .thinking-dots {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.awaiting .thinking-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: thinking-bounce 1.2s ease-in-out infinite;
}

.awaiting .thinking-dots i:nth-child(2) {
  animation-delay: 0.2s;
}

.awaiting .thinking-dots i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes thinking-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* 上下文压缩条 */
.msg-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border: 1px dashed var(--color-primary);
  border-radius: 6px;
  background: var(--color-primary-muted);
  padding: 7px 10px;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.msg-compact .icon {
  font-size: 13px;
}

.msg-compact .bytes {
  font-family: var(--font-family-mono);
  color: var(--color-primary);
}

/* ---- 输入区 ---- */
.chat-input {
  flex-shrink: 0;
  padding: 9px 12px 11px;
  border-top: 1px solid var(--color-border-default);
  background: var(--color-bg-secondary);
}

.input-hint {
  font-size: 9.5px;
  color: var(--color-text-tertiary);
  margin-bottom: 5px;
}

.input-hint.running {
  color: var(--state-warning);
}

.input-row {
  display: flex;
  gap: 7px;
}

.chat-textinput {
  flex: 1;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  color: var(--color-text-primary);
  font-size: 12px;
  padding: 7px 10px;
  outline: none;
  resize: none;
  font-family: inherit;
  line-height: 1.5;
}

.chat-textinput:focus {
  border-color: var(--color-border-active);
}

.chat-textinput::placeholder {
  color: var(--color-text-tertiary);
}

.send-btn {
  padding: 0 16px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  font-family: inherit;
}

.send-btn:hover {
  filter: brightness(1.1);
}

/* ---- 前馈弹窗 ---- */
.ff-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ff-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ff-field label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.ff-field :deep(.el-input-number),
.ff-field :deep(.el-select) {
  width: 100%;
}

.ff-range-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.ff-actions {
  display: flex;
  gap: 7px;
}

.ff-actions button {
  flex: 1;
  padding: 7px;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}

.btn-confirm {
  background: var(--color-ai);
  color: var(--color-text-inverse);
  border: none;
  font-weight: 600;
}

.btn-confirm:hover {
  filter: brightness(1.08);
}

.btn-cancel {
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border-default);
}

.btn-cancel:hover {
  border-color: var(--color-border-active);
}
</style>
