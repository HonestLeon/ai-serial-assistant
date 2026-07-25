# AI 串口调试助手 · 开发文档

> 本文档面向**开发者**，介绍代码架构、模块职责、进程通信、数据处理与开发命令。
> 最终用户请阅读仓库根目录 [`README.md`](../../README.md)（界面、使用说明）。

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | ^42.5 |
| 前端框架 | Vue 3 | ^3.5 |
| UI 组件库 | Element Plus | ^2.14 |
| 图表库 | ECharts | ^6.1 |
| 串口通信 | serialport | ^13.0 |
| 构建（electron-vite） | Vite | ^7.3 |
| 打包 | electron-builder | ^26.1 |

---

## 架构总览

采用 Electron 标准三进程模型，渲染进程经 Preload 桥接与主进程通信：

```
┌─────────────────────────────────────────────────────┐
│  渲染进程 (Renderer) — Vue 3 + Element Plus          │
│    SerialPanel / DataMonitor / WorkspaceChart /       │
│    WorkspaceAnalysis / AiPanel / PidPanel / StatusBar  │
│            │  window.electronAPI.serial.*             │
└────────────┼──────────────────────────────────────────┘
             │ IPC
┌────────────┼──────────────────────────────────────────┐
│  预加载 (Preload)                                      │
│  contextBridge.exposeInMainWorld('electronAPI')        │
│    serial: { list, open, close, send,                  │
│              setDtr, setRts, onData, onStatus, onError }│
└────────────┼──────────────────────────────────────────┘
             │
┌────────────┼──────────────────────────────────────────┐
│  主进程 (Main) — Node.js + serialport                 │
│    ipcMain.handle('serial:*')                          │
│    SerialPort + ReadlineParser / JustFloat 解析        │
│    webContents.send('serial:data' / 'status' / 'error') │
└───────────────────────────────────────────────────────┘
```

---

## 目录结构

```
ai-serial-assistant-app/
├── electron.vite.config.mjs   # electron-vite 配置（注意是 .mjs）
├── package.json
├── scripts/
│   └── dev.js                 # 开发启动：清 ELECTRON_RUN_AS_NODE 后 electron-vite dev
├── tests/                     # 对应 npm run test:analysis
│   ├── control-analysis.mjs   #   控制指标计算
│   ├── ai-data-context.mjs    #   AI 上下文打包
│   ├── pid-simulation.mjs     #   PID 候选生成
│   └── vue-sfc-compile.cjs    #   Vue SFC 编译校验
└── src/
    ├── main/
    │   ├── index.js           # 入口：建窗、注册 IPC、生命周期
    │   └── serial.js          # 串口封装（list/open/close/send/setDtr/setRts + 协议解析）
    ├── preload/
    │   └── index.js           # contextBridge 暴露 electronAPI
    └── renderer/
        ├── index.html
        └── src/
            ├── main.js        # Vue 初始化、主题管理、全局错误兜底
            ├── App.vue        # 根组件：布局、全局 AI 配置与录制状态、主题 provide
            ├── style.css      # 设计系统（亮/暗双主题 CSS 变量 + Element Plus 覆盖）
            ├── services/      # 纯算法层（无 Vue 依赖，供组件与 tests/ 共用）
            │   ├── controlAnalysis.mjs   #   确定性分析 + 候选生成 + AI 上下文打包
            │   └── pidSimulation.mjs     #   策略注册表 + 物理仿真 + 嵌入式代码生成
            └── components/
                ├── SerialPanel.vue       # 串口配置 + AI 设置 + 协议引擎 + DTR/RTS
                ├── DataMonitor.vue       # 数据流/数据表 + 自动发送 + 录制回放 + 控制响应模拟
                ├── WorkspaceChart.vue    # 动态通道 + 缩放平移 + 标准化绘图（当前使用）
                ├── WorkspaceAnalysis.vue # 响应指标 + 高级判定 + 报告（当前使用）
                ├── AiPanel.vue           # AI 对话 + 快捷操作 + 异常检测 + 协议识别
                ├── PidPanel.vue           # PID 阶跃采集 → 本地分析 → 人工确认下发
                ├── StatusBar.vue         # 状态栏 + 主题/HEX 切换 + 计数
                ├── ChartPanel.vue        # ⚠ 历史遗留，未被 App.vue 引用
                ├── AnalysisPanel.vue      # ⚠ 历史遗留，未被 App.vue 引用
                └── ChannelPanel.vue       # ⚠ 新增「数据通道」面板，当前未被 App.vue 挂载（数据表由 DataMonitor 承担）
```

---

## 组件职责

| 组件 | 职责 |
|------|------|
| `SerialPanel` | 串口参数、协议引擎选择（raw / justfloat）、AI 配置（model / baseUrl / apiKey）、DTR / RTS 控制 |
| `DataMonitor` | 数据收发展示、数据表（I0–I7）、自动发送、录制/回放、**控制响应模拟** |
| `WorkspaceChart` | 实时波形绘制：滑动窗口缓冲（MAX_POINTS=2000）、八通道解析、通道显隐、归一化、X 缩放平移、Y 自动/手动、主题联动、CSV/JSON 导出（详见下方「波形分析模块」章节） |
| `WorkspaceAnalysis` | 通道特征统计（EDA）+ 确定性响应分析（上升/稳定时间、超调率、稳态误差、RMSE、稳态波动）+ 高级判定标准 + AI 结构化解释 + 报告导出；`analyzeControlSamples` 与调参模块共用（详见下方「波形分析模块」章节） |
| `AiPanel` | 对话 + 快捷操作（数据分析/异常诊断/协议解析）+ 异常检测（3σ + stuck）+ 协议启发式识别 |
| `PidPanel` | 调参流程编排与 UI（步骤 0 策略/1 阶跃/2 分析/3 下发）；算法全部外置到 `services/controlAnalysis.mjs` 与 `services/pidSimulation.mjs`（详见下方「PID 辅助调参」章节） |
| `StatusBar` | 连接状态、Rx/Tx 计数、HEX 切换、主题切换 |

> ⚠ **未挂载组件提醒**：`ChartPanel.vue` / `AnalysisPanel.vue` 为早期版本遗留，`ChannelPanel.vue` 为新增的「数据通道」面板，三者当前均未被 `App.vue` 挂载——活动图表/分析组件是 `WorkspaceChart.vue` / `WorkspaceAnalysis.vue`，通道数值由 `DataMonitor` 的「数据表」承担。新增功能请勿引用这些未接入组件，建议后续清理。

---

## 进程通信（IPC）

主进程 `src/main/index.js` 用 `ipcMain.handle` 注册，Preload 用 `contextBridge.exposeInMainWorld('electronAPI', ...)` 暴露。

**Renderer → Main**

| 通道 | 说明 |
|------|------|
| `serial:list` | 枚举可用串口 |
| `serial:open` | 打开（参数 + 协议引擎） |
| `serial:close` | 关闭 |
| `serial:send` | 发送（utf8 / hex） |
| `serial:setDtr` | 设置 DTR 电平 |
| `serial:setRts` | 设置 RTS 电平 |

**Main → Renderer（事件）**

| 通道 | 说明 |
|------|------|
| `serial:data` | 收到的数据行（含解析结果） |
| `serial:status` | 连接状态变更 |
| `serial:error` | 错误通知 |

**安全策略**：`contextIsolation: true`、`nodeIntegration: false`，仅暴露 `electronAPI` 命名空间。

---

## 数据处理与协议解析

主进程 `serial.js` 按 `protocol` 字段分流：

- **Raw**：`ReadlineParser` 以 `\n` 分行，每行用正则 `[-+]?\d*\.?\d+` 提取数字，用于波形与通道数值显示
- **JustFloat**：解析二进制浮点帧（4 字节 LE float × N + 尾帧 `0x00 0x00 0x80 0x7F`），转空格分隔文本下行游
- （注：早期文档提到的 **FireWater 协议当前未实现**，仅 raw / justfloat 可用）

**控制响应模拟**（`DataMonitor.vue`，无需硬件）：二阶欠阻尼模型，dt = 50 ms，t ≥ 1 s 时目标由 0 → 100；输出 `CTRL: <目标> <反馈> <控制量> <误差>` 文本行，经 Raw 通路进入波形/分析，用于离线验证整套链路。

---

## 波形分析模块：组件与算法详解

> 本节面向二次开发者，解释「数据分析」标签页（`WorkspaceAnalysis.vue`）与「实时波形」区（`WorkspaceChart.vue`）背后的实现。设计原则是：**实时绘制与统计量始终本地计算、确定性指标可复现、AI 仅做辅助解释、无网络也能用**。波形分析模块是整套系统的数据底座——调参模块（下一节）复用了本节描述的 `analyzeControlSamples` 确定性算法，即「波形在前、调参在后」架构的落点。

### 模块分工与共享状态

两个组件都挂在 `App.vue` 下，但职责不同：

- **`WorkspaceChart.vue`**：纯可视化。接收数据流，用 ECharts 绘制多通道实时曲线，负责通道显隐、归一化、坐标轴、缩放平移、CSV/JSON 导出。它**不关心控制语义**，只画数。
- **`WorkspaceAnalysis.vue`**：数据分析。读取 `serialContext.channelHistory`（通道历史缓冲）做统计特征（EDA）与响应分析，并把结果打包给 AI、导出 HTML 报告。

两者通过 `App.vue` 提供的 props 拿到同一份数据：

| Prop | 流向 | 含义 |
|------|------|------|
| `serialContext.channelHistory` | → Analysis | 二维数组 `channelHistory[ch]` 为该通道收到的全部有限数值（来自 `serial.js` 解析后的数值流） |
| `latestPayload` | → Chart | 最近一帧原始文本，`WorkspaceChart.appendData` 从中 `extractNumbers` 实时追加 |
| `simulationSamples` | → Chart | 控制响应模拟生成的 `[{ t, target, feedback, output }]`，`loadSimulationSamples` 消费 |
| `aiConfig` | → Analysis | `{ model, baseUrl, apiKey }`，仅用于 AI 解释 |
| `channelCount` | → 两者 | 当前已解析的通道数，用于生成通道下拉/列表 |

> 注意：`WorkspaceChart` 与 `WorkspaceAnalysis` 各自维护一份绘图/统计状态，不共享响应式变量；它们读的是 `App.vue` 同一来源的 props，因此是「同一份数据、两套消费」，不会出现状态漂移。

### 实时波形绘制（WorkspaceChart.vue）

**数据缓冲与滑动窗口**
- `seriesData` 是 `ref([])` 的二维数组，每通道一条 `[]`；`sampleLabels` 与 `seriesData` 同步 push / shift。
- `MAX_POINTS = 2000`：超出后 `shift()` 丢弃最老一点（见 `appendData`），保证长时间运行内存有界。

**数据解析 `extractNumbers(text)`**
- 若文本含 `:`（如 `CTRL: 100 32 …`），取冒号后段；否则用整段。
- 正则 `[-+]?\d*\.?\d+` 提取数字，最多取前 8 个，对应 I0–I7 八通道。Raw / JustFloat 下行游都走这里。

**通道管理 `ensureChannels` / `toggleChannel`**
- `ensureChannels(count)`：动态补齐通道数组，新通道默认 `visibleChannels = true`，命名为 `I{n}`。
- `toggleChannel(index)`：仅切换该通道 `visibleChannels` 标志，`refreshChart()` 重绘（隐藏通道的 series 置为空数组 `[]`，不占图例）。

**归一化与 Y 轴**
- `normalizeDrawing`：开启时把每通道线性映射到 −100~100（`plottedData`），但 `tooltipFormatter` 与导出用的是 `raw` 原始值——**绘图归一、数据保真**。
- `yAuto` / `yMin` / `yMax`：手动模式下把 `Number` 写进 `chartOption().yAxis.min / max`。

**ECharts 集成要点**
- `chart = echarts.init(chartRef.value)`，`animation: false`（实时刷新不闪）。
- `dataZoom` 仅 `inside`：滚轮缩放 X、拖动平移（`filterMode: 'none'`）。
- `tooltip.formatter` 自定义，显示采样点序号 + 各通道原始值。
- `refreshChart(resetOption)`：`notMerge: resetOption`（清空类操作传 `true`，增量刷新传 `false` + `lazyUpdate`）。

**主题联动**
- 初始 `isDark` 读 `document.documentElement.classList.contains('dark')`。
- 监听 `window` 自定义事件 `theme-change`（`detail.dark`）→ `handleThemeChange` 更新 `isDark` 并重绘。主进程切换主题时 broadcast 此事件（见 `main.js` 主题管理）。

**导出 `exportData(format)`**
- `csv`：表头 `Index, I0..In` + 逐行数据，逗号分隔。
- `json`：`{ exportTime, normalizedOnlyForDrawing, channels: [{ name, visible, rawData }] }`。
- 均用 `Blob + URL.createObjectURL` + 临时 `<a download>` 触发下载。

### 通道特征统计 / EDA（WorkspaceAnalysis）

`channelFeatures` 是 `computed`，对 `channelHistory` 每个有数据的通道实时算：

- 最新值 `latest`、平均值 `mean`、最小/最大 `min/max`
- 绝对峰值 `peak = max(|x|)`（区别于 `max`，对正负摆动的信号更有意义）
- 均方根 `rms = sqrt(mean(x²))`、标准差 `std = sqrt(var)`

> 这些统计量**默认开启、随本地缓存实时计算**，是「无网络时的数据特征降级」落点（对应产品定位里的离线能力）。`featureValue` 把极大/极小数值格式化为科学计数法，避免表格溢出。

### 确定性响应分析（analyzeControlSamples，被调参模块共用）

`runAnalysis()` 调用 `analyzeControlSamples(samples, standards)`，其中 `samples` 由 `createSamplesFromChannels(channelHistory, mapping, sampleIntervalMs)` 对齐生成。判定标准 `standards`（UI 可改，对话框 `saveStandards` 应用）默认：

| 标准 | 默认 | 含义 |
|------|------|------|
| `settlingBandPercent` | 5 | 反馈进入目标 ±5% 并持续保持才算稳定 |
| `overshootLimit` | 20 | 超调率警戒线（%） |
| `oscillationLimit` | 10 | 稳态波动警戒线（%） |
| `steadyErrorPercent` | 5 | 稳态误差 > 阶跃幅值 5% 标风险 |
| `minimumSamples` | 8 | 不足则 `valid: false`，提示先采够 |

`analyzeControlSamples` 算法（位于 `services/controlAnalysis.mjs`，与 PID 调参**共用同一份实现**）：

1. **清洗**：每点 `finite` 兜底、按 `t` 升序、滤除非法时间。
2. **定位阶跃 `findStep`**：找目标值跳变最大处为 `stepIndex`。
3. **分段**：阶跃前取均值作 `initialTarget / initialFeedback`，末 15% 作 `tail` 取 `finalTarget / finalFeedback`，`stepSize = final - initial`。
4. **上升时间**：`threshold10/90 = initial + 0.1/0.9*(final - initial)`，`crossingTime` 线性插值求穿越时刻，二者之差。
5. **超调率**：阶跃后极值相对 `finalTarget` 的偏离 / 幅值 × 100%。
6. **稳定时间 `settlingTime`**：自 `stepIndex` 起扫描，找到首个「后续 `tail` 全部落在 ±band」的位置（band = `stepSize * bandRatio`）。
7. **稳态误差** `finalTarget - finalFeedback`、**RMSE**（对 `target - feedback` 误差序列）、**稳态波动** `oscillationAmplitude(tail) / amplitude * 100`。
8. **风险判定**：超调/波动超 `limits`、稳态误差超比、窗口内未稳定，分别 push 到 `risks`；据此给 `health`：良好 / 需关注 / 高风险。

> 输出 `metrics` 含 `sampleRate`、`outputPeak` 等，全部 `fmt` 四舍五入。`valid` 为 `false` 时返回 `reason` 供 UI 提示。这一份确定性结果是调参模块 `buildPidSuggestion` 的输入——**波形分析在前，调参在后，依赖的就是这个共享函数**。

### 采样对齐（createSamplesFromChannels）

把八通道 `channelHistory` 对齐成 `[{ t, target, feedback, output }]`：

- `mapping = { target, feedback, output }`（响应分析面板可选手选 I 通道，默认 `target→I0`、`feedback→I1`；代码中 `output` 被显式设为 `mapping.target`，即分析视图下 `output` 复用 target 通道，未单独提供 output 通道选择）。
- 三个通道按**最短长度**对齐，各自取尾部偏移 `offset*` 保证时间轴对齐。
- `dt = sampleIntervalMs / 1000` 作为采样周期，`t = index * dt`。
- 任一通道数据不足，对应值 `finite` 兜底为 0，不会报错。

### AI 结构化解释（requestAiExplanation）

- 先确保 `metrics.valid`（否则跑一次 `runAnalysis`）。
- 无 `apiKey` → `ElMessage.warning('未配置 API Key；确定性响应分析仍可离线使用')` 并 return——**确定性分析完全不依赖网络**。
- 有 Key：`buildStructuredAiContext(metrics, null, { system, scenario })` 生成结构化上下文，附带 `analysisStandard`（稳定性描述、稳态误差阈值、最少采样点），POST 到 `${baseUrl}/chat/completions`。
- system prompt：`'你是控制响应解释助手。只解释固定算法给出的指标、判定标准、风险和下一步实验，不生成或下发PID参数。'`——与调参侧同源的安全约束。
- 离线/失败：`aiExplanation.value = 'AI解释不可用：…。确定性指标不受影响。'`，UI 照常显示确定性结果。

### 响应分析报告导出（exportReport）

`exportReport()` 把当前 `metrics + risks + aiExplanation` 拼成一段**自包含 HTML**（内联 CSS），用 Blob 下载为 `智串AI响应分析_<时间戳>.html`。报告末尾带声明：「本报告用于响应分析，不直接控制硬件或下发PID参数。」便于用户直接贴进竞赛设计文档。

### 设计要点小结

- **波形在前、调参在后**：`WorkspaceChart` 打通数据回路，`WorkspaceAnalysis` 的 `analyzeControlSamples` 既是用户看指标的依据，也是 `buildPidSuggestion` 的输入——两套功能共用同一确定性内核，避免重复实现与结果不一致。
- **离线优先**：EDA 统计、`analyzeControlSamples`、报告导出全部本地；AI 仅叠加解释层，缺失不影响核心。
- **安全一致性**：波形分析与调参的 AI 提示词都禁止「声称控制硬件 / 下发参数」，与产品「辅助式、人工确认」定位一致。

---

## PID 辅助调参：算法与数据流详解

> 本节面向二次开发者，解释「AI 辅助调参」背后的实现细节。设计原则是：**确定性算法跑本地、AI 只做解释、参数必须人工确认下发**。这样既保证离线可用、结果可复现，也避免了「AI 直接控制硬件」的安全风险。

### 总体数据流

```
仿真(simulatePidStrategy) 或 真实串口(onSerialData)
        │  统一采样 [{ t, target, feedback, output }]
        ▼
 analyzeControlSamples ──► 确定性指标 + 风险判定(risks)
        │  指标 + 安全边界
        ▼
 buildPidSuggestion ──► 有界候选参数(Kp/Ki/Kd, 0~20 / 0~10)
        │
        ├─(无 apiKey)──► 直接给出候选，等待人工审查
        │
        └─(有 apiKey)──► buildStructuredAiContext ──► fetch /chat/completions
                              │  system prompt 禁止改边界/禁止声称控硬件
                              ▼
                          aiResult(仅解释, 不参与下发)
        │
        ▼
 sendParams: 数值+边界校验 → ElMessageBox 二次确认 → 下发 "PID kp ki kd"
```

**关键文件职责拆分**（UI 与算法解耦，便于 `tests/` 复用同一份算法）：

| 文件 | 职责 |
|------|------|
| `components/PidPanel.vue` | 流程编排与 UI（步骤 0 策略/1 阶跃/2 分析/3 下发），不含算法 |
| `services/controlAnalysis.mjs` | 确定性分析 `analyzeControlSamples`、候选生成 `buildPidSuggestion`、AI 上下文打包 `buildStructuredAiContext` |
| `services/pidSimulation.mjs` | 策略注册表 `PID_STRATEGIES`、物理仿真 `simulatePidStrategy`、嵌入式代码生成 `generateEmbeddedControllerFiles` |

> ⚠ 注意：`analyzeControlSamples` 同时被 `WorkspaceAnalysis.vue`（波形分析模块）与 `PidPanel.vue`（调参模块）调用——这正是「先做波形分析、再做调参」架构依赖的落点：调参的指标计算直接复用波形分析的能力。

---

### 1. 策略注册表（`PID_STRATEGIES` / `FEEDFORWARD_LIBRARY`）

策略是「系统模型 + 验收标准 + 默认参数」的聚合对象，定义在 `pidSimulation.mjs`：

```js
motor_speed: {
  name: '电机速度环（一阶模型）',
  parameters: ['Kp', 'Ki', 'Kd'],
  defaultOrder: ['Kp', 'Ki', 'Kd'],               // 调参顺序，用户可在 UI 用 ↑/↓ 调整
  acceptance: { overshootLimit: 20, settlingBand: 0.05, oscillationLimit: 10 }, // 验收阈值
  defaults: { duration, dt, noise, target, J, B, Kt, outputLimit, kp, ki, kd }
}
```

- **`acceptance`**：该策略的验收阈值，被 `analyzeControlSamples` 用来判定 `risks`（超调/稳态波动是否越界）。新增竞赛系统（直立环/舵机环）时，只需在此登记一项即可接入整套调参链路。
- **`defaultOrder`**：调参顺序（如倒立摆把 `Kd` 前置）。`PidPanel.moveTuningStep()` 让用户用 ↑/↓ 调整顺序，`buildPidSuggestion` 会按顺序对修正幅度做指数衰减（排第 0 位完整修正，后续按 `0.5^pos` 衰减），真正落地「调参顺序由用户决定」。
- **`FEEDFORWARD_LIBRARY`**：前馈项库，分三栏（多项式 / 三角函数 / 其他），每栏内多项可勾选、可多选、可跨栏组合，对应规格里的 `F = f_pid(error) + Σ f_ff(target)`：
  - **多项式**：线性 `Kff·target`、二次 `Kff·target²`、三次 `Kff·target³`
  - **三角函数**：sin `Kff·sin(target)`、cos `Kff·cos(target)`、tan `Kff·tan(target)`
  - **其他**：重力补偿 `m·g·l·sin(target)`、常数偏置 `Kff`、符号补偿 `Kff·sign(target)`
  - 勾选状态 `feedforwardSelection` 形如 `{ linear: 0.5, gravity: 1 }`，前馈 = Σ(已勾选项 compute())。每项有独立系数输入框，可实时调整。不勾选任何项即纯 PID。串级策略下，多项式/三角/符号类前馈作用于位置环（叠加到速度目标），重力补偿/常数偏置作用于速度环（叠加到力矩）。

---

### 2. 物理仿真引擎（`simulatePidStrategy`）

不依赖硬件即可验证整条链路。要点：

- **可复现噪声**：`seededRandom(seed=20260723)`（线性同余），`noise()` 用三次采样均值近似高斯。固定种子保证每次仿真结果一致，便于回归比对。
- **标准离散 PID**（`pidStep`）：前向欧拉积分，且**积分项抗饱和**——积分累加被 clamp 到 `±outputLimit`；微分用相邻误差差商 `(error - prevError)/dt`。`pidStep` 输出不再内部 clamp，留给调用方叠加前馈后再统一限幅。
- **前馈真正接入仿真**：`computeFeedforward(config, target)` 按勾选的 `feedforwardSelection` 求和，叠加到 PID 输出。三个模型均生效——这是「前馈控制」卖点首次闭环。
- **三个物理模型**（对应不同微分方程）：
  - `motor_speed`：一阶 `J·dω/dt + B·ω = Kt·i`，被控量转速、控制量电流。前馈叠加到电流。
  - `cascade_position`：双闭环，外环位置 PID 输出速度目标、内环速度 PID 输出电流。多项式/三角/符号类前馈作用于位置环（叠加到速度目标），重力补偿/常数偏置作用于速度环（叠加到力矩）。
  - `inverted_pendulum`：不稳定二阶 `J·θ'' − m·g·l·θ = −T`，以 `measured − target` 作误差；当 `θ` 发散（超出 ±3）时 `break` 提前终止，避免无意义长数组。前馈叠加到力矩。
- 返回 `{ strategy, config, samples }`，`samples` 为统一格式的采样数组，直接进入第 3 步分析。

---

### 3. 确定性响应分析（`analyzeControlSamples`）——调参与波形分析共用的核心

输入即统一采样 `{t, target, feedback, output}`，全部为纯数学计算，**不联网、可离线**：

1. **清洗与排序**：`map → filter(有限值) → sort(by t)`；`sampleCount < minimumSamples(默认 8)` 直接返回 `valid:false`。
2. **阶跃定位** `findStep`：找相邻 `target` 跳变最大的索引作为阶跃起点。
3. **初值/终值**：阶跃前均值 → `initialFeedback`；阶跃后 15% 尾部均值 → `finalFeedback`/`finalTarget`，以此得 `stepSize`。
4. **上升时间** `crossingTime`：线性插值求反馈穿越 10% / 90% 阈值时刻，`riseTime = t90 − t10`。
5. **超调** `overshoot`：阶跃后极值偏离 `finalTarget` 的比例（按 `direction` 判断正负阶跃）。
6. **稳定时间** `settlingTime`：从阶跃点起，找首个「其后连续窗口全部落入 ±band」的采样点（`band = stepSize × settlingBand`，默认 ±5%）。整窗未收敛返回 `null`。
7. **其余指标**：`steadyError`、`rmse`（误差 RMS）、`oscillation`（尾部极差 / 阶跃幅值）、`sampleRate`、`outputPeak`。
8. **风险判定 `risks`**：超调/稳态波动超出 `acceptance` 阈值、稳态误差过大、未收敛 → 推入 `risks`，并给出 `health`（良好/需关注/高风险）。

> 该函数的输出即为波形分析模块的「响应指标卡」，也是 `buildPidSuggestion` 的输入——一处实现、两处复用。其完整算法步骤与判定标准默认值见上方「波形分析模块」章节的「确定性响应分析」小节。

---

### 4. 候选参数生成（`buildPidSuggestion`）——保守、有界、只给建议

这是「辅助式调参」的算法核心，**只生成候选、绝不自动下发**。支持单环（`kp/ki/kd`）与串级（`speedKp/speedKi/speedKd + positionKp/positionKi/positionKd` 共 6 参数）：

```js
// 单环：base = { kp, ki, kd }；串级：base = { speedKp, speedKi, speedKd, positionKp, positionKi, positionKd }
// 每个参数已 clamp 到 Kp 0~20, Ki/Kd 0~10
if (metrics.overshoot > limit)   { P:0.82, I:0.78, D:1.22 /* 降比例积分、增微分 */ }
if (metrics.oscillation > limit) { P:0.86, I:0.82, D:1.15 /* 降环路激进程度 */ }
if (steadyError 过大)            { I:1.18 /* 小幅加积分 */ }
if (响应保守)                    { P:1.10 /* 小幅提比例 */ }
// 每次修正后再次 clamp 回 0~20 / 0~10
```

- 修正系数均为**经验启发式**（基于经典 PID 调参直觉：超调→降 Kp、振荡→降 Ki、稳态差→升 Ki）。
- **tuningOrder 真正生效**：按用户调整的调参顺序，对修正幅度做指数衰减（`orderFactor = 1 + (factor-1) × 0.5^pos`），排第 0 位的参数完整修正，越靠后修正越小，体现「调参顺序由用户决定」。
- **串级 6 参数**：自动识别 `current` 是否含 `speed*`/`position*` 字段进入串级模式；内环（速度环）修正幅度衰减到 30%，外环（位置环）完整修正，符合「先内环后外环」调参惯例。
- 任何一步都重新 `clamp` 回安全边界，确保候选参数本身不会损坏硬件。
- `confidence` 仅「低 / 中」（样本 ≥80 才中）——**刻意不提供「高」**，提醒用户仍需人工判断。
- 返回 `{ ..., confidence, reasons }`，`reasons` 是一句人能读懂的调整依据，展示在 UI。串级下下发指令为 `PID <speedKp> <speedKi> <speedKd> <positionKp> <positionKi> <positionKd>`。

---

### 5. AI 给参（可选增强，覆盖候选）

仅当配置了 `aiConfig.apiKey` 才触发。AI **只给出新参数**（不再只做解释），并把参数自动填入下方"PID 候选与参数下发"：

- 确定性算法 `buildPidSuggestion` 先给出有界候选作为**基线**（无 Key 或 AI 失败时回退到此）。
- 提示词中**限定死 AI 输出格式**为单个 JSON 对象，禁止任何解释/Markdown/额外文字：
  - 单环：`{"kp":<0-20>,"ki":<0-10>,"kd":<0-10>}`
  - 串级：`{"speedKp":<0-20>,"speedKi":<0-10>,"speedKd":<0-10>,"positionKp":<0-20>,"positionKi":<0-10>,"positionKd":<0-10>}`
- 用户消息携带：当前参数、响应指标（超调率/上升时间/稳定时间/稳态误差/RMSE/振荡/采样点数）、场景描述。
- `parseAiParams` 解析返回：剥离 ```json 代码块、截取首末 `{}`、`JSON.parse`、逐字段校验为有限数并 clamp 到安全边界。
- 解析成功 → 覆盖 `outputParams`（候选区实时更新）；解析失败 → 保留确定性基线并提示。
- 离线/无 Key 时跳过 AI，仍有本地候选，保证「无网可用」。

---

### 6. 下发与安全管理（`sendParams`）

- 先校验参数是否为有限数；再按**安全边界**拦截：`Kp∈[0,20]`、`Ki,Kd∈[0,10]`（串级 6 参数同此边界），越界直接报错不发送。
- 默认 `ElMessageBox.confirm` **二次确认弹窗**（警告样式），显示完整参数（串级显示速度环/位置环两组），用户必须主动点「确认下发」；取消则参数不变。
- **自动下发**：步骤 3 提供「自动下发」复选框。勾选时弹出风险警告（可能导致设备失控/超速/过流/损坏、网络异常可能下发错误参数、建议先仿真验证并做好急停准备），用户确认后开启；开启后 `sendParams` 跳过二次确认，AI 给参后（若已连接串口）自动写入设备。
- 下发指令格式：单环 `PID <kp> <ki> <kd>`，串级 `PID <speedKp> <speedKi> <speedKd> <positionKp> <positionKi> <positionKd>`（utf8），由用户固件侧约定解析——这也是「自动调参闭环」目前唯一依赖外部约定的地方（见下方待办）。

---

### 7. 嵌入式集成（`generateEmbeddedControllerFiles` + 模板文件）

一键把当前配置导出为可移植的 `.h / .c`。**模板文件独立存放，便于审查修改**：

- 模板目录：`src/renderer/src/services/embedded-templates/zhichuan_pid.h` 与 `zhichuan_pid.c`，是真实的 C 源文件，含占位符（`__GUARD__` / `__FF_MASK__` / `__NAME__`）与详细注释。
- 代码读取：渲染进程用 Vite `?raw` 动态导入（构建时内联为字符串），Node 测试环境用 `fs.readFileSync` 读取真实文件。两种环境共用同一份模板源，保证「改模板即生效」。

**设计定位：通信层，不含 PID/前馈计算。** 自动调参的前提是：上位机的"参数变更指令"与"目标值变更指令"能真正改变嵌入式芯片里的变量，并能回读目标值与反馈值。因此 `.c/.h` 采用**函数指针注入**式集成——用户只需把 `.c/.h` 加入原工程并配置好几个函数指针，即可启用自动调参，**无需改动既有控制逻辑**（PID 与前馈计算仍在用户原工程中执行）。

`.h` 用函数指针指向用户工程已有的：
- `read_feedback` / `read_target`：反馈/目标获取函数
- `set_param`：参数变更函数（修改某个 PID/前馈值，type 见 `ZHICHUAN_PARAM_*` 宏）
- `set_target`：目标值变更函数（阶跃指令触发）
- `serial_write` / `serial_read`：串口收发函数

`.c` 实现两个函数：
1. **`zhichuan_periodic_send(cfg)`**（周期发送数据）：用用户配置的 `read_target`/`read_feedback`/`serial_write` 函数指针，按 `"target,feedback\n"` 格式向串口发送数据，供上位机采集响应曲线。建议在控制循环里以固定周期调用。
2. **`zhichuan_parse_command(cfg, byte)`**（解析串口指令并修改 PID/前馈值）：用用户配置的 `set_param`/`set_target` 函数指针，解析上位机下发的串口命令并对应修改 PID/前馈值/目标值。支持的指令（文本行，以 `\n` 结尾，不区分大小写）：
   - `SET_POINT <value>`：修改目标值（阶跃）
   - `PID <kp> <ki> <kd>`：单环批量设主参数
   - `PID <spKp> <spKi> <spKd> <poKp> <poKi> <poKd>`：串级批量设 6 参数
   - `SET <type> <value>`：单参数修改（`type` 见 `ZHICHUAN_PARAM_*` 宏，含前馈系数）

**前馈项掩码**：因为前馈项是勾选开启、事先不确定哪些项被启用，采用掩码解决。每个前馈项分配一个 bit（`ZHICHUAN_FF_LINEAR`=0x0001、`ZHICHUAN_FF_GRAVITY`=0x0040 等，见 `.h`），勾选好已开启的前馈项后，上位机生成一个总掩码（如勾选线性+重力 → `0x0041u`）：
- 导出时自动写入 `.h` 的 `#define ZHICHUAN_FF_MASK`
- UI 上同时显示掩码值，可一键复制，手动粘贴到已有工程的头文件对应位置
- 用户工程据此掩码判断运行时启用哪些前馈项，示例：
  ```c
  float ff = 0.0f;
  if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_LINEAR)   ff += kff_linear * target;
  if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_GRAVITY)  ff += m * g * l * sinf(target);
  ```

> 注：PID/前馈系数本身不硬编码在 `.c/.h` 里，运行时由上位机 `PID`/`SET` 指令下发到用户工程的变量中。

---

### 8. 测试覆盖（`tests/`）

MVP 自测脚本直接 import 上述 `services` 中的纯函数，保证「算法实现」与「算法验证」同源：

- `control-analysis.mjs`：喂入构造的阶跃响应，断言指标（超调/稳定时间等）计算正确，并验证 `buildPidSuggestion` 的 tuningOrder 衰减与串级 6 参数支持。
- `ai-data-context.mjs`：验证 `buildStructuredAiContext` 打包的结构化上下文。
- `pid-simulation.mjs`：验证 `simulatePidStrategy` 三个策略的采样有效性；验证 `generateEmbeddedControllerFiles` 生成的是通信层（含 `zhichuan_periodic_send`/`zhichuan_parse_command`、不含 PID 计算逻辑）、前馈掩码按勾选正确生成（如 linear+gravity → 0x0041u、全选 → 0x01FFu、无勾选 → 0x0000u）。
- `vue-sfc-compile.cjs`：用 `@vue/compiler-sfc` 编译所有 `.vue` 组件，捕获模板/脚本语法错误（兼容 npm 与 pnpm 安装环境）。

运行：`npm run test:analysis`。

---

## 状态与主题

- **主题**：`main.js` 读取 `localStorage.theme`，**默认浅色**；`StatusBar` 切换时给 `<html>` 加/去 `.dark` 类并 dispatch `theme-change` 事件，`WorkspaceChart` 监听后刷新 ECharts 配色。设计系统在 `style.css` 用 `:root`（浅）与 `:root.dark`（深）两套 CSS 变量。
- **AI 配置**：`App.vue` 用 `reactive aiConfig` 经 prop 下发各面板；`apiKey` 存 `sessionStorage`（仅当前会话），`baseUrl` / `model` 存 `localStorage`。
- **录制状态**：`App.vue` 维护，回放时自动关闭串口以避免实时与历史数据混合。

---

## 开发命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 经 `scripts/dev.js` 启动：先删除 `ELECTRON_RUN_AS_NODE`（避免 Electron 以纯 Node 模式运行导致 `require('electron')` 异常），再 `electron-vite dev` |
| `npm run build` | `electron-vite build`，产物到 `out/`（out/main、out/preload、out/renderer） |
| `npm run dist` | `electron-vite build && electron-builder`，生成安装包 |
| `npm run test:analysis` | 跑 `tests/` 下 4 个脚本：控制指标计算、AI 上下文、PID 候选、Vue SFC 编译 |

> 调试：`npm run dev` 启动时 `isDev` 为真（`electron-vite dev` 设了 `ELECTRON_RENDERER_URL`），`src/main/index.js` 会在 `ready-to-show` 时自动 `openDevTools({ mode: 'detach' })`；生产构建不会开。随时也可手动 `Ctrl+Shift+I`（macOS `Cmd+Option+I`）开关。主进程日志看终端。

---

## 开发须知

- **`.npmrc`**：已配置 Electron 国内镜像，安装 electron / electron-builder 二进制更快；必要时设 `ELECTRON_MIRROR`。
- **vue-router**：`package.json` 含 `vue-router` 依赖，但当前 App **未使用路由**（单页 + 标签页切换），属冗余依赖，可移除。
- **遗留组件**：`ChartPanel` / `AnalysisPanel` 未被挂载，别在新功能里引用。
- **logger 暂禁用**：`main.js` 中 `setupLogger()`（转发 `console` 到主进程）被注释，为排查 el-select 下拉问题时关闭；恢复需验证。
- **配置文件名**：是 `electron.vite.config.mjs`（**不是** `.js`）。
- **无 `demo/` 目录**：旧文档提到的 `demo/index.html` 离线演示页已不存在，离线体验请用应用内「控制响应模拟」。

---

## 进度与路线图

### 已完成 ✅

- 三进程骨架、IPC 桥接、亮/暗双主题
- 串口全参数配置、DTR/RTS、Raw / JustFloat 解析
- 数据流/数据表、自动发送、录制回放、控制响应模拟
- ECharts 多通道波形（缩放/平移/显隐/标准化/导出）
- AI 助手（OpenAI 兼容接入、上下文注入、异常检测、协议识别）
- 确定性响应分析、PID 辅助调参（本地候选 + AI 给参 + 人工确认/自动下发）
- 策略注册表（多系统 / 多控制结构差异化调参，含仿真 / 真实串口测试来源与验收指标）
- 参数安全限制（Kp 0~20、Ki/Kd 0~10 边界 + 二次确认下发，防异常参数损坏硬件）
- 嵌入式集成（一键导出 `.c/.h` 控制器代码）
- MVP 自测（`tests/` 4 脚本）

### 进行中 🚧

- 异常自动回退（超调 / 震荡越界时自动回退上一稳定态；当前仅提供手动回退提示与二次确认，自动化待实现）
- 离线信号处理降级（Z-N / 继电自整定，无网可用）
- 策略模板扩充（直立环 / 速度环 / 舵机环等更多竞赛系统预设与精细前馈项）

### 待完成 📋

- 协议插件机制（FireWater / 自定义二进制等）
- 系统辨识与多通信方式（J-Link / Ozone）
- 单元测试 / E2E 扩展、多语言、配置持久化

---

## 许可证

MIT
