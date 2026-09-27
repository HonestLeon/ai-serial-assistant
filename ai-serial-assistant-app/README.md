# AI 串口调试助手 · 开发文档

> 本文档面向**开发者**，介绍代码架构、模块职责、进程通信、数据处理与开发命令。
> 最终用户请阅读仓库根目录 [`README.md`](../README.md)（界面、使用说明）。

## 策略工具扩展（第一版）

`createPidAgentTools({ controller, enableStrategies: true })` 默认返回五个基础工具和两个策略入口；传入 `enableStrategies: false` 保留原有五工具流程。界面通过「启用确定性策略工具（单环试验）」控制该选项，每次会话启动时生效。

| 文件 / 入口 | 职责 |
| --- | --- |
| `src/renderer/src/services/pidAgent/tools/strategies.mjs` | 策略注册清单与单次执行编排；复用 `pidSafety.buildFallbackSuggestion` |
| `list_pid_strategies` | 返回策略清单、适用范围与执行边界 |
| `run_pid_strategy` | 接受 `strategy: staged_pid` 或 `recover_pid`；读最近采集证据、调用基础工具调整与验证 |
| `tools/index.mjs` | 维护最近一次采集的参数/前馈/目标快照，并向策略提供基础工具与安全结果 |
| `tests/pid-agent-strategies.mjs` | 策略测试、stub LLM 路由集成和真实电机仿真/统计/回退链路测试 |

策略不直接写设备、不额外调用模型。每次最多一次调整，统一复用 `set_pid_params` 和 `set_target`；串口采集异步完成，返回等待状态。暂只支持标准单环参数，串级与自定义参数继续走基础工具。

```bash
npm run test:analysis
npm run test:strategies
npm run build
```

第二条命令独立运行新增策略测试，不包含在 `test:analysis` 中。关闭开关可用于同初始条件的新旧 Agent 对照；真实 API 与硬件对照尚未执行。详见 [策略工具设计与验证方案](docs/pid-strategy-tools.md)。

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

采用 Electron 标准三进程模型，渲染进程经 Preload 桥接与主进程通信。渲染进程工作区上下分栏：**上方实时波形持续可见**（可拖动分隔条调整高度），**下方两个标签页切换**：数据（左侧数据流/数据表切换，右侧数据分析）、PID 调参（对话式调参智能体，原「AI 助手」能力已合并于此）：

```
┌─────────────────────────────────────────────────────┐
│  渲染进程 (Renderer) — Vue 3 + Element Plus          │
│    SerialPanel / DataMonitor / WorkspaceChart /       │
│    WorkspaceAnalysis / PidAgentPanel / StatusBar       │
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
│   └── dev.js                 # 开发启动：设置 Electron 镜像环境变量 + electron-vite dev
├── docs/                      # 开发文档
│   ├── pid-tuning-strategy-and-ai-prompt.md #   PID 本地策略与 AI 提示词组织详解
│   ├── llm-pid-tuner-analysis.md          #   llm-pid-tuner 开源项目分析
│   ├── AI-Agent工作原理与使用指南.md        #   从 Pi 项目看懂 AI-Agent（架构/循环/工具/事件）
│   ├── Pi设计思想与实现精要.md            #   Pi 设计思想与实现精要
│   ├── ai-harness-prompt-research.md      #   AI 提示词 harness 调研与反思
│   └── ui-design-audit-report.md          #   UI 设计评审报告
├── pid_waveforms/             # PID 调参波形（测试脚本生成）
│   ├── pure_pid/              #   纯 PID 调参波形（step/multiStep/sine 三种信号）
│   └── with_feedforward/      #   含前馈对比波形（pure_pid / with_feedforward / comparison）
├── tests/                     # 算法自测（npm run test:analysis）+ 独立调参验收脚本
│   ├── control-analysis.mjs   #   控制指标计算
│   ├── ai-data-context.mjs    #   AI 上下文打包
│   ├── pid-simulation.mjs     #   PID 仿真 + 嵌入式代码生成
│   ├── pid-safety.mjs         #   安全护栏
│   ├── pid-prompt.mjs         #   PID 提示词 / Schema / 解析
│   ├── pid-agent-buffer.mjs   #   智能体消息工厂/用户配置校验 + 数据环形缓冲
│   ├── pid-agent-llm.mjs      #   智能体 LLM 客户端（convertToLlm 翻译 + callLlm 协议）
│   ├── pid-agent-tools.mjs    #   智能体 5 工具（护栏校验 / 错误喂回 / 双模式分流）
│   ├── pid-agent-loop.mjs     #   智能体双层循环（steer/followUp 队列 / maxTurns 兜底）
│   ├── pid-agent-safety-compact.mjs  # 智能体安全兜底 + 上下文压缩
│   ├── pid-agent-utils.mjs    #   智能体参数形态转换 / 仿真 overrides 组装
│   ├── vue-sfc-compile.cjs    #   Vue SFC 编译校验
│   ├── feedforward-tuning-trial.mjs  # 前馈调参验收（独立运行，输出到 pid_waveforms/with_feedforward/）
│   └── full-tuning-trial.mjs         # 纯 PID 调参验收（独立运行，输出到 pid_waveforms/pure_pid/）
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
            │   ├── aiDataContext.mjs     #   串口行解析 + 通道统计 + 波形上下文预处理
            │   ├── controlAnalysis.mjs   #   确定性分析 + 候选生成 + 前馈整定 + AI 上下文打包
            │   ├── pidSimulation.mjs     #   策略注册表 + 物理仿真 + 嵌入式代码生成
            │   ├── pidSafety.mjs         #   安全护栏 + 兜底策略 + 评分 + 最佳记录 + 回退判定
            │   ├── pidPrompt.mjs         #   PID 提示词 / JSON Schema / 响应解析 / 历史与波形打包
            │   ├── pidAgent/             #   PID 调参智能体核心层（参考 Pi-agent，纯 JS 可独立测试）
            │   │   ├── types.mjs         #     消息工厂（user/assistant/toolResult + kind 标记）+ UserConfig 校验
            │   │   ├── dataBuffer.mjs    #     带时间戳通道环形缓冲（按时间段 query/stats）
            │   │   ├── llm.mjs           #     OpenAI 兼容 tools 协议调用 callLlm + 消息翻译 convertToLlm
            │   │   ├── systemPrompt.mjs  #     动态系统提示词 buildSystemPrompt（<user_config> 包裹用户配置）
            │   │   ├── tools/index.mjs   #     5 个调参工具 createPidAgentTools（四要素 + 错误喂回协议）
            │   │   ├── agentLoop.mjs     #     双层循环 runAgentLoop + steer/followUp 两阶段消息队列
            │   │   ├── safety.mjs        #     安全兜底 createSafetyGuard（bestStable 回退 + [安全机制] 通知）
            │   │   ├── compaction.mjs    #     上下文压缩 measureDataBytes/compactIfNeeded（仅压缩数据块）
            │   │   └── utils.mjs         #     参数形态转换 readCanonicalPid/applyCanonicalPid + buildSimOverrides
            │   └── embedded-templates/   #   嵌入式调参通信层 .c/.h 模板（zhichuan_pid.c / zhichuan_pid.h）
            ├── composables/
            │   └── usePidAgent.mjs       #   调参智能体 Vue 适配层（事件→refs、steer/followUp/startAgent/stopAgent/串口数据流入）
            └── components/
                ├── SerialPanel.vue       # 串口配置 + AI 设置 + 协议引擎 + DTR/RTS
                ├── DataMonitor.vue       # 数据流/数据表 + 自动发送 + 录制回放 + 控制响应模拟
                ├── WorkspaceChart.vue    # 动态通道 + 缩放平移 + 标准化绘图（当前使用）
                ├── WorkspaceAnalysis.vue # 响应指标 + 高级判定 + 报告（当前使用）
                ├── PidAgentPanel.vue     # 对话式调参智能体面板（左栏调参前配置 + 右栏消息流）
                └── StatusBar.vue         # 状态栏 + 主题/HEX 切换 + 计数
```

---

## 组件职责

| 组件 | 职责 |
|------|------|
| `SerialPanel` | 串口参数、协议引擎选择（raw / justfloat）、AI 配置（model / baseUrl / apiKey）、DTR / RTS 控制 |
| `DataMonitor` | 数据收发展示、数据表（I0–I7）、自动发送、录制/回放、**控制响应模拟**；在「数据」标签内左侧显示（自带数据流/数据表切换） |
| `WorkspaceChart` | 实时波形绘制：滑动窗口缓冲（MAX_POINTS=2000）、八通道解析、通道显隐、归一化、X 缩放平移、Y 自动/手动、主题联动、CSV/JSON 导出；工作区上方常驻（详见下方「波形分析模块」章节） |
| `WorkspaceAnalysis` | 通道特征统计（EDA）+ 确定性响应分析（上升/稳定时间、超调率、稳态误差、RMSE、稳态波动）+ 高级判定标准 + AI 结构化解释 + 报告导出；在「数据」标签内右侧显示（详见下方「波形分析模块」章节） |
| `PidAgentPanel` | 对话式调参智能体面板：左栏（320px）测试模式切换（仿真 ⇄ 真实串口）+ 仿真策略下拉 + 真实串口的 PID 结构（单环/串级）+ 调参配置（PID 初始值/范围、信号安全范围、前馈「+」自定义添加、场景提示词、串口专属调参策略）+ 当前参数总览（变化高亮）+ 上下文用量指示器 + 开始/停止；右栏对话消息流（用户消息 / steer 中途插入 / 助手思考打字机流式 / 工具调用单行 / 安全警示块 / 上下文压缩条 / 运行失败提示 / 「思考中」动画）+ 输入框（空闲时输入 = 发起调参任务或自由提问——原「AI 助手」能力合并于此；运行中输入 = 中途纠偏）；调参编排详见下方「PID 调参智能体（Agent）」章节 |
| `StatusBar` | 连接状态、Rx/Tx 计数、HEX 切换、主题切换 |

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

> 输出 `metrics` 含 `sampleRate`、`outputPeak` 等，全部 `fmt` 四舍五入。`valid` 为 `false` 时返回 `reason` 供 UI 提示。这一份确定性结果同时被调参智能体复用（`get_channel_stats` 的阶跃指标与安全兜底检测都调用它）——**波形分析在前，调参在后，依赖的就是这个共享函数**。

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
- system prompt：`'你是控制响应解释助手。只解释固定算法给出的指标、判定标准、风险和下一步实验，不生成或下发PID参数。'`——解释侧「不越权」的安全约束（调参智能体侧则经护栏化工具改参，见下一节）。
- 离线/失败：`aiExplanation.value = 'AI解释不可用：…。确定性指标不受影响。'`，UI 照常显示确定性结果。

### 响应分析报告导出（exportReport）

`exportReport()` 把当前 `metrics + risks + aiExplanation` 拼成一段**自包含 HTML**（内联 CSS），用 Blob 下载为 `智串AI响应分析_<时间戳>.html`。报告末尾带声明：「本报告用于响应分析，不直接控制硬件或下发PID参数。」便于用户直接贴进竞赛设计文档。

### 设计要点小结

- **波形在前、调参在后**：`WorkspaceChart` 打通数据回路，`WorkspaceAnalysis` 的 `analyzeControlSamples` 既是用户看指标的依据，也被调参智能体的数据缓冲统计与安全兜底调用——两套功能共用同一确定性内核，避免重复实现与结果不一致。
- **离线优先**：EDA 统计、`analyzeControlSamples`、报告导出全部本地；AI 仅叠加解释层，缺失不影响核心。
- **安全一致性**：波形分析的 AI 提示词禁止「声称控制硬件 / 下发参数」，只做解释；调参智能体侧 AI 虽可通过工具改参，但每一步都经用户配置范围 + 系统护栏校验并有安全回退兜底——两侧约束一致地保证「AI 不越权」。

---

## PID 调参智能体（Agent）：架构与数据流详解

> 本节面向二次开发者，解释「PID 调参」标签页（`PidAgentPanel.vue`）背后的实现。设计参考 Pi-agent 的对话式智能体架构——**双层循环（Agent Loop）、工具四要素（Tools）、事件驱动、上下文压缩**：LLM 通过工具自主完成「查数据 → 改参数 → 设目标 → 看结果 → 再决策」的完整调参闭环，思考过程实时输出到对话框；确定性算法（指标分析 / 仿真 / 安全护栏）全部本地执行，参数写入受用户配置范围 + 系统护栏约束、越限自动回退——「AI 不越权」由机制保证，而非仅靠提示词。
>
> 📖 调参策略与提示词的背景见 [`docs/pid-tuning-strategy-and-ai-prompt.md`](docs/pid-tuning-strategy-and-ai-prompt.md)（成文于智能体化之前的「本地候选 + AI 单轮给参」链路；其中分阶段调参、Kp 二分法、前馈整定等算法思想已沉淀进智能体系统提示词，安全护栏部分仍完全适用）。

### 1. 总体数据流

```
调参前用户配置（四类：PID 初始值/范围 · 信号安全范围 · 前馈项「+」自定义 · 场景提示词）
        │
        │ buildSystemPrompt：以 <user_config> 标签包裹进系统提示词（全量携带 · 永不压缩）
        ▼
┌───────────────────── runAgentLoop 双层循环（tool_calls 驱动）─────────────────────┐
│                                                                                   │
│   callLlm（OpenAI 兼容 chat/completions + tools 协议；convertToLlm 翻译内部消息）   │
│         │ finish_reason = "tool_calls" → 执行工具；"stop" → 内层结束               │
│         ▼                                                                         │
│   5 个工具串行执行（护栏校验；出错以 isError 喂回模型，循环不中断）                   │
│    ├─ get_channel_stats / get_channel_data ◄── dataBuffer 带时间戳环形缓冲          │
│    ├─ set_pid_params（用户范围 → 系统上限 → 单步增幅，三重校验）                     │
│    ├─ set_feedforward_params（用户范围校验）                                       │
│    └─ set_target ──► 仿真：立即阶跃采样 / 串口：下发 SET_POINT 异步采集             │
│           │ 样本写入 dataBuffer ──► 安全检测 analyzeControlSamples                 │
│           │      └─ 越限/劣化 ──► bestStable 自动回退 + [安全机制] 通知              │
│           │             （UI 红框警示块 + 以 user 角色入 steer 队列喂回 LLM）        │
│         ▼                                                                         │
│   工具结果喂回上下文 ──► 数据字节 > 50KB 时 compactIfNeeded 压缩（仅数据块）         │
│         └──► 下一轮迭代，直到模型输出总结（stop）/ followUp 追加 / 用户停止 /         │
│               maxTurns = 50 兜底                                                   │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │ 事件：agent_start/end · turn_start/end ·
                                    │       message_start/end · tool_execution_start/end
                                    ▼
        usePidAgent（事件 → refs）──► PidAgentPanel 右栏消息流：
        助手思考打字机流式 · 工具调用单行 · 安全警示块 · 上下文压缩提示条
```

### 2. 双层循环引擎（`agentLoop.mjs`）

```
外层 while（任务回合）：
  内层 while（单任务的 LLM ↔ 工具迭代）：
    ① drain steer 队列 → 注入中途纠偏 / 安全通知消息
    ② callLlm（携带全部历史 + tools 定义）
       ├─ finish_reason = "tool_calls" → 校验参数 → 串行执行工具
       │    → toolResult（含 isError）append 到 messages → 继续内层
       └─ finish_reason = "stop" → 内层结束
  内层结束 → drain followUp 队列（用户在运行期间追加的任务）：
    有 → 注入后重启外层（视为新任务）；无 → 循环整体结束
```

- **循环驱动**：以模型返回的 `finish_reason`（OpenAI 兼容协议的 `tool_calls` / `stop`）作为继续/停止依据，不自行猜测模型意图。
- **两阶段消息队列** `createPendingMessageQueue`（先 push 暂存、drain 时一次性取出并清空）：`steer()`（运行中纠偏，每个内层回合开始时注入——对话不被打断、方向可被纠正）与 `followUp()`（Agent 即将整体结束时注入，视为新任务重启外层）。输入框在调参运行期间保持可用。
- **停止条件**：① 模型说完了（`stop` 且无 followUp）；② 用户点击停止（`AbortSignal` → `aborted`）；③ `shouldStopAfterTurn` 钩子（安全熔断等场景 → `user-stop`）；④ `maxTurns = 50` 防御性兜底（超出以 `max-turns` 强制终止）。
- **事件驱动**：循环只派发事件、不碰 UI——`agent_start/end`、`turn_start/end`、`message_start/end`（流式思考）、`tool_execution_start/end`；另有压缩模块的 `compaction_applied` 与安全模块的 `safety_triggered`。UI（`usePidAgent`）与日志各自订阅。
- **压缩挂载点**：`onBeforeLlm(messages) => messages` 在每回合调 LLM 前调用，`usePidAgent` 在此挂载 `compactIfNeeded`（见第 5 节）。

---

### 3. 工具集（`tools/index.mjs`，5 个）

每个工具按 Pi 四要素定义：`name` / `description`（面向模型可读，必须写明「何时用、怎么传参」——模型只能看到描述）/ `parameters`（JSON Schema）/ `execute`。工具自身无状态，参数读写、阶跃仿真、串口下发、数据缓冲、用户配置等运行时能力全部经注入的 `controller` 获得（由 `usePidAgent` 组装实现）：

| 工具 | 参数 | 行为 | 护栏 |
|------|------|------|------|
| `get_channel_stats` | `timeRange: [起, 止]`（秒，相对调参开始）；`channels?`（默认全部） | 返回时间段内各通道统计特征（mean/std/min/max/peak/rms/sampleCount）；段内含阶跃时附加控制指标（overshoot/settlingTime/steadyError/rmse/status，复用 `analyzeControlSamples`）。调参开始与每次改参后应先调用了解系统特性 | 时间段非法（如起始为负）→ `isError` 喂回 |
| `get_channel_data` | `timeRange`；`channels?`；`maxPoints?`（默认 30） | 返回时间段各通道原始数据 `{t, target, feedback, output}`（均匀下采样至 maxPoints），用于观察波形细节；描述中提示模型「数据量大时优先用 stats」 | 同上 |
| `set_pid_params` | `kp?/ki?/kd?`（串级另含 `speed*/position*`），只传要改的项 | 写回参数（左栏「当前参数总览」实时高亮变化），返回 `{applied, previous, guardrailNotes}`；修改后需调 `set_target` 验证 | 三重校验：① 用户配置范围裁剪（越界裁剪并说明，如 `kp: 50 → 20（超出用户配置上限 20）`）→ ② 系统上限（Kp≤20、Ki/Kd≤10）→ ③ 单步增幅限制（Kp×3、Ki/Kd×4），后两重复用 `applyPidGuardrails` |
| `set_feedforward_params` | `{ <前馈项id>: <新系数> }`，只传要改的项 | 写回前馈系数，返回 `{applied, guardrailNotes}`；需重力/摩擦等补偿改善跟踪或稳态误差时使用 | 未知 id / 非数字 → `isError`（附可用前馈项列表）；越界按用户配置范围裁剪并说明 |
| `set_target` | `value: number` | 修改目标值并触发阶跃采集（调参验证的必经步骤）。仿真模式：立即用当前参数跑 `simulatePidStrategy`，样本按会话时钟偏移写入 dataBuffer，返回本次 `timeRange`（可直接传给 get_channel_*）；串口模式：下发 `SET_POINT <value>`，响应经串口数据流异步进入 dataBuffer，稍后用 `get_channel_stats` 查看 | 严重越界（超出目标安全范围一个量程以上）→ `isError` 拒绝执行；轻微软出 → 裁剪到边界并说明；采集完成自动触发安全检测（见第 6 节） |

**错误喂回协议**：工具内部不吞错、不兜底，出错直接 `throw Error`（中文消息），由循环捕获转为 `isError: true` 的 toolResult 喂回模型——**循环不中断**，模型看到错误原因后自行纠错重试（如传错时间段后修正参数重查）。

---

### 4. 调参前用户配置（仿真四类 + 串口专属两项）

面板左栏在「开始调参」前按模式要求提供：

1. **PID 参数初始值及取值范围**：每参数一行（初始值 | 最小 | 最大）；单环 3 项（Kp/Ki/Kd），`cascade_position` 串级策略自动展开 6 项（位置环 + 速度环，键名与 `set_pid_params` 的 schema 一一对应）。取值范围作为工具护栏第一重硬约束。**真实串口模式**额外提供 **PID 结构**（单环 / 串级）选择——决定 `PID` 指令 3 参或 6 参下发。
2. **信号安全取值范围**：控制值 / 反馈值 / 目标值各自的 min~max，用于 `set_target` 校验与数据异常检测（串口模式与设备物理量程对齐）。
3. **前馈项「+」自定义添加**：点击「＋添加前馈项」从预设模板（线性 / 二次 / sin / cos / 重力补偿 / 常数偏置 / 目标一阶导）选择，填系数初始值与取值范围；已添加项列表展示、可删除；前馈项 id 由所选模板生成。
4. **控制场景提示词**：多行文本，描述被控对象、调参目标与特殊约束。**真实串口模式必填**；仿真模式若留空则按所选策略自动拼接默认场景（策略自带物理模型说明），不因空场景报错。
5. **调参策略**（真实串口专属，必填）：自由文本指导 LLM 如何整定实机（如「分阶段 P→PI→PID；先压超调再降稳态误差；设备目标为斜坡，等待收敛后再评估」），注入 system prompt 的 `<user_config>`。

`validateUserConfig` 做必填校验（PID 初始值/范围必填；仿真场景可自动补齐，串口场景提示词与调参策略必填；安全范围与前馈可选，有默认值），未完成点击「开始调参」会提示缺失项并阻止启动。配置信息经 `buildSystemPrompt` 以 `<user_config>` XML 风格标签包裹进系统提示词，**每次调 LLM 全量携带、永不压缩**——保证模型在任何压缩策略下都能看到完整的参数边界、信号安全范围、场景背景与调参策略。

---

### 5. 上下文压缩策略（`compaction.mjs`）

- **度量**：`measureDataBytes` 只统计「数据查询类 toolResult」（`get_channel_*` 的返回，创建消息时以 `meta.isDataQuery` 标记）的 UTF-8 字节总量——这类消息体积大且信息可再取，是最值得牺牲的部分。
- **阈值**：50KB（`COMPACT_THRESHOLD_BYTES = 50 * 1024`，约为 AI 上下文窗口的十分之一）。每回合调 LLM 前（`onBeforeLlm` 挂载点）检测，数据字节超阈值即触发 `compactIfNeeded`。
- **压缩动作**（借鉴 Pi：有损留底、保留尾部、独立请求）：
  1. 保留最近 `retainedTail = 3` 条数据块原样（智能体通常正围绕最新数据推理）；
  2. 其余旧数据块发起**独立 LLM 摘要请求**（不带 tools、不复用对话缓存）总结为紧凑摘要（保留关键数值：各时间段指标、参数变更序列、超调/震荡特征）；
  3. 摘要以 `compact` 消息**成组替换**原数据块（按 assistant 消息分组：一条 assistant 的多个 toolCall 对应的 toolResult 整组处理，assistant + 待压缩 toolResult 一起移除、原位置插入摘要消息，避免「assistant 还在、配对 toolResult 没了」的残缺对话）；摘要请求失败不影响主流程。
- **永不压缩**：系统提示词中的用户四类配置、所有用户消息（含 steer / followUp）、助手思考文本、安全通知消息。
- **UI 呈现**：对话流插入「📦 上下文已压缩 xKB → yKB（仅数据部分）」提示条；左栏上下文用量指示条实时显示「数据 xKB / 阈值 50KB」并按 80% / 100% 变色。

---

### 6. 安全兜底（`safety.mjs`，复用 `pidSafety`）

- **触发点**：`set_target` 每次样本采集完成后调用 `onSamplesCollected` → `analyzeControlSamples` 确定性指标（阈值取用户验收配置，缺省超调 20% / 振荡 10%）。
- **bestStable 滚动维护**：复用 `maybeUpdateBestResult`——**仅 STABLE 轮次**可入选最佳稳定记录，避免把坏参数记录成回退目标。
- **触发条件**：超调 / 振荡越限，或 `shouldRollbackToBest` 判定相对 bestStable 双阈值劣化（相对 >1.3 倍且绝对增量 >0.5）。
- **动作**：参数自动回退至 `bestStable.pid`（无记录时无法回退，仅提示回调参数），并生成 `[安全机制] 检测到超调 x% 超过安全限制 y%，参数已自动回退至 …` 消息，双通道送达：① UI 以红框警示块醒目显示；② 以 user 角色推入 steer 队列喂回 LLM（下一回合即可见），模型据此调整探索策略（如收到通知后改用更小 Kp 做二分）。

---

### 7. 仿真与串口双模式

工具内部按测试来源（`testMode`）分流，启动前串口模式会校验设备已连接：

- **仿真模式**（默认）：`set_target` → `buildSimOverrides` 组装当前参数/前馈/目标 → `simulatePidStrategy` 跑一次阶跃仿真（三个物理模型：电机速度环一阶 `J·dω/dt + B·ω = Kt·i` / 串级位置双闭环 / 倒立摆不稳定二阶；固定种子可复现噪声、积分项抗饱和），样本经 `onSimulationData` 上抛 `App.vue` 绘制到上方波形区，同时按会话时钟偏移写入 dataBuffer 并触发安全检测，返回本次 `timeRange`——**波形在前、对话调参在后**的产品形态保持不变。
- **串口模式**：`set_target` 下发 `SET_POINT <value>`、`set_pid_params` 真实下发 `PID` 指令（单环 3 参 / 串级 6 参速度环在前）、安全回退时把回退参数经 `PID` 指令同步下发设备；指令由发送层统一补 `\n` 结尾。面板 watch `latestPayload` → `onSerialData` 把每帧串口数据（`标签:值` 文本行，冒号后取前三个数作 target/feedback/output，不足三个跳过）按首帧时间戳换算为相对秒写入 dataBuffer——`get_channel_*` 工具即可按时间段查询真实响应。阶跃采集窗口约 12s（`SERIAL_STEP_WINDOW_SEC`），`set_target` 返回 `suggestedQuery` 建议查询区间；统计只分析窗口内最新一次目标变化段（`stepCount` / `finalValues`），并检测斜坡目标（`targetRamping`）与未收敛（`STILL_RISING`）。前馈系数经 `SET` 指令下发设备待接入（见「进度与路线图」进行中项）。

---

### 8. 关键文件职责拆分

（UI 与算法解耦：`services/pidAgent/` 全部纯 JS、无 Vue/DOM/window 依赖，渲染进程与 Node `tests/` 共用同一份实现）

| 文件 | 职责 |
|------|------|
| `services/pidAgent/types.mjs` | 消息工厂（`createUserMessage` / `createAssistantMessage` / `createToolResultMessage`；role: user/assistant/toolResult，kind: normal/steer/followUp/safety/compact/summary）+ `createDefaultUserConfig` / `validateUserConfig` 校验 |
| `services/pidAgent/dataBuffer.mjs` | 带时间戳通道环形缓冲：`push`（串口流 / 仿真样本统一写入）、`query`（按时间段取原始数据、自动下采样）、`stats`（统计特征 + 阶跃指标，内嵌 `analyzeControlSamples`） |
| `services/pidAgent/llm.mjs` | `callLlm`（OpenAI 兼容 chat/completions + tools 协议、5 次指数退避、部分后端不支持 function calling 时去 tools 重试一次）+ `convertToLlm`（内部消息 → 协议消息翻译：steer/followUp/safety 补来源前缀、toolCalls 对象参数转 JSON 字符串、过滤模型不该看的消息） |
| `services/pidAgent/systemPrompt.mjs` | `buildSystemPrompt`：智能体身份与工作方式 + 工具清单与使用建议 + `<user_config>` 包裹的四类配置 + 验收/安全阈值 |
| `services/pidAgent/tools/index.mjs` | `createPidAgentTools`：第 3 节的 5 个工具（四要素定义、无状态、能力经 controller 注入、错误 throw 由循环转 isError） |
| `services/pidAgent/agentLoop.mjs` | `runAgentLoop` 双层循环 + `createPendingMessageQueue` 两阶段队列 + `maxTurns` 兜底 + 事件派发 + `onBeforeLlm` 压缩挂载点 |
| `services/pidAgent/safety.mjs` | `createSafetyGuard`：采集后指标分析 + bestStable 维护 + 参数回退 + `[安全机制]` 消息产出（入队 / 终止等编排职责在引擎层，本模块只做判定与回退） |
| `services/pidAgent/compaction.mjs` | `measureDataBytes` / `compactIfNeeded`：仅压缩数据块、retainedTail=3、独立摘要请求、成组替换 |
| `services/pidAgent/utils.mjs` | `readCanonicalPid` / `applyCanonicalPid`（合并形态 ↔ 规范形态：单环三键 / 串级六键，迁移自旧调参会话模块）+ `buildSimOverrides`（组装仿真 overrides） |
| `composables/usePidAgent.mjs` | Vue 适配层：配置状态（pidConfig / safetyRange / feedforwardItems / scenePrompt / testMode）+ 事件 → refs（messages / running / turnCount / ctxBytes / paramHighlight）+ `startAgent` / `steer` / `followUp` / `sendChat` / `stopAgent` / `onSerialData` + controller 组装与系统提示词/工具/压缩装配 |
| `components/PidAgentPanel.vue` | 对话式面板（职责见上方组件职责表）：打字机推进、自动滚底、参数变化高亮、上下文用量条、前馈「+」弹窗 |

**复用的既有模块**（本次智能体化改造不动）：

| 文件 | 在智能体中的角色 |
|------|------------------|
| `services/pidSimulation.mjs` | `PID_STRATEGIES` 策略注册表（面板「仿真策略」下拉 + 串级六参数展开）+ `simulatePidStrategy` 阶跃仿真（`set_target` 仿真模式数据源）+ `generateEmbeddedControllerFiles` 嵌入式导出 |
| `services/controlAnalysis.mjs` | `analyzeControlSamples` 确定性指标——`dataBuffer.stats` 与安全兜底共用（与波形分析模块同一份实现）；另有 `buildPidSuggestion` 等本地候选函数保留为纯函数库（`tests/` 覆盖，智能体链路不再使用） |
| `services/pidSafety.mjs` | `applyPidGuardrails`（系统上限 + 单步增幅，`set_pid_params` 第二三重校验）+ `maybeUpdateBestResult` / `shouldRollbackToBest`（安全兜底） |
| `services/aiDataContext.mjs` | 串口行解析 + 通道统计纯函数库（`tests/` 覆盖，数据侧共用底座） |
| `services/pidPrompt.mjs` | 提示词 / JSON Schema / 响应解析纯函数库（`tests/` 覆盖，智能体化之前的给参链路产物） |

> ⚠ 注意：`analyzeControlSamples` 同时被 `WorkspaceAnalysis.vue`（波形分析模块）与 `pidAgent`（`dataBuffer.stats` + `safety.mjs`）调用——这正是「先做波形分析、再做调参」架构依赖的落点：调参的指标计算直接复用波形分析的能力。其完整算法步骤与判定标准默认值见上方「波形分析模块」章节的「确定性响应分析」小节。

---

### 9. 嵌入式集成（`generateEmbeddedControllerFiles` + 模板文件）

把当前配置导出为可移植的 `.h / .c`（服务层能力，由 `tests/pid-simulation.mjs` 覆盖验证；导出入口曾位于旧版步骤式调参面板，UI 入口随面板重构移除，可按需重新接入）。**模板文件独立存放，便于审查修改**：

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

**前馈项掩码**：因为前馈项由用户按需添加、事先不确定哪些项被启用，采用掩码解决。每个前馈项分配一个 bit（`ZHICHUAN_FF_LINEAR`=0x0001、`ZHICHUAN_FF_GRAVITY`=0x0040 等，见 `.h`），确定已启用的前馈项后，上位机生成一个总掩码（如线性+重力 → `0x0041u`）：
- 导出时自动写入 `.h` 的 `#define ZHICHUAN_FF_MASK`
- 掩码值随导出配置生成（如 `0x0041u`），可手动粘贴到已有工程的头文件对应位置
- 用户工程据此掩码判断运行时启用哪些前馈项，示例：
  ```c
  float ff = 0.0f;
  if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_LINEAR)   ff += kff_linear * target;
  if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_GRAVITY)  ff += m * g * l * sinf(target);
  ```

> 注：PID/前馈系数本身不硬编码在 `.c/.h` 里，运行时由上位机 `PID`/`SET` 指令下发到用户工程的变量中。

---

### 10. 测试覆盖（`tests/`）

自测脚本直接 import 上述 `services` 中的纯函数，保证「算法实现」与「算法验证」同源：

- `control-analysis.mjs`：喂入构造的阶跃响应，断言指标（超调/稳定时间等）计算正确，并验证 `buildPidSuggestion` 的 tuningOrder 衰减与串级 6 参数支持。
- `ai-data-context.mjs`：验证 `buildStructuredAiContext` 打包的结构化上下文。
- `pid-simulation.mjs`：验证 `simulatePidStrategy` 三个策略的采样有效性；验证 `generateEmbeddedControllerFiles` 生成的是通信层（含 `zhichuan_periodic_send`/`zhichuan_parse_command`、不含 PID 计算逻辑）、前馈掩码按勾选正确生成（如 linear+gravity → 0x0041u、全选 → 0x01FFu、无勾选 → 0x0000u）。
- `pid-safety.mjs`：验证 `applyPidGuardrails` 的边界裁剪与单步增幅限制、`buildFallbackSuggestion` 按 status 的乘性修正、`scoreMetrics` / `maybeUpdateBestResult`（仅 STABLE 更新）/ `shouldRollbackToBest`（双阈值劣化）/ `isMetricsAcceptable` 的判定。
- `pid-prompt.mjs`：验证 `pidPrompt.mjs` 的 JSON Schema / 结构化输出格式、`parsePidAiResponse` 解析、历史与波形打包、成功案例挑选。
- `pid-agent-buffer.mjs`：验证智能体消息工厂与用户配置校验（`types.mjs`），以及带时间戳环形缓冲的写入与按时间段查询/统计（`dataBuffer.mjs`）。
- `pid-agent-llm.mjs`：验证 `convertToLlm` 消息翻译（kind 来源前缀 / toolCalls 协议格式）与 `callLlm` 的请求组装、指数退避与错误处理（fetch stub）。
- `pid-agent-tools.mjs`：验证 5 个工具的护栏校验（用户范围裁剪 / 系统上限与增幅限制 / 目标严重越界拒绝）、错误喂回与仿真/串口双模式分流（stub controller）。
- `pid-agent-loop.mjs`：验证双层循环——`tool_calls` 驱动的多工具链、steer/followUp 队列注入时机、`maxTurns` 兜底、工具错误不中断、事件顺序与五种停止原因（stop/max-turns/aborted/user-stop/error）。
- `pid-agent-safety-compact.mjs`：验证安全兜底（bestStable 维护 / 超调与振荡越限回退 / `[安全机制]` 消息与事件 / 无记录时不回退）与上下文压缩（字节度量只计数据块 / 阈值触发 / retainedTail 尾部保留 / 摘要失败不影响主流程）。
- `pid-agent-utils.mjs`：验证参数形态转换（单环/串级的 `readCanonicalPid` / `applyCanonicalPid`，含字符串写回值转数字）与 `buildSimOverrides` 组装。
- `vue-sfc-compile.cjs`：用 `@vue/compiler-sfc` 编译所有 `.vue` 组件，捕获模板/脚本语法错误（兼容 npm 与 pnpm 安装环境）。

运行：`npm run test:analysis`（上述 12 个自测脚本；`full-tuning-trial` / `feedforward-tuning-trial` 不在此命令内，作为独立调参验收脚本单独运行）。

> **独立调参验收脚本**（不进入 `test:analysis`，手动运行以生成波形）：

- `full-tuning-trial.mjs`：纯 PID 调参验收，跑三个策略（电机/串级/倒立摆）× 三组参数 × 三种信号（step/multiStep/sine），输出波形到 `pid_waveforms/pure_pid/`。
- `feedforward-tuning-trial.mjs`：前馈调参验收，对比纯 PID / 含前馈 / 仅前馈三种模式的响应，输出波形到 `pid_waveforms/with_feedforward/`。

---

## 状态与主题

- **主题**：`main.js` 读取 `localStorage.theme`，**默认浅色**；`StatusBar` 切换时给 `<html>` 加/去 `.dark` 类并 dispatch `theme-change` 事件，`WorkspaceChart` 监听后刷新 ECharts 配色。设计系统在 `style.css` 用 `:root`（浅）与 `:root.dark`（深）两套 CSS 变量。
- **AI 配置**：`App.vue` 用 `reactive aiConfig` 经 prop 下发各面板；`apiKey` 存 `sessionStorage`（仅当前会话），`baseUrl` / `model` 存 `localStorage`。
- **录制状态**：`App.vue` 维护，回放时自动关闭串口以避免实时与历史数据混合。

---

## 开发命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 经 `scripts/dev.js` 启动：设置 Electron 镜像环境变量（`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`）+ 按平台选择 spawn 方式（Windows 用 shell 命令字符串规避 DEP0190 警告），再 `electron-vite dev` |
| `npm run build` | `electron-vite build`，产物到 `out/`（out/main、out/preload、out/renderer） |
| `npm run dist` | `electron-vite build && electron-builder`，生成安装包 |
| `npm run test:analysis` | 跑 `tests/` 下 12 个算法自测脚本：控制指标计算、AI 上下文、PID 仿真、PID 安全护栏、PID 提示词、调参智能体 6 项（缓冲 / LLM / 工具 / 循环 / 安全压缩 / 工具函数）、Vue SFC 编译（不含波形生成验收脚本） |

> 调试：`npm run dev` 启动时 `isDev` 为真（`electron-vite dev` 设了 `ELECTRON_RENDERER_URL`），`src/main/index.js` 会在 `ready-to-show` 时自动 `openDevTools({ mode: 'detach' })`；生产构建不会开。随时也可手动 `Ctrl+Shift+I`（macOS `Cmd+Option+I`）开关。主进程日志看终端。

---

## 开发须知

- **`.npmrc`**：仅保留 `registry=https://registry.npmmirror.com`。Electron 二进制镜像通过环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 在 `scripts/dev.js` 中设置（npm 7+ 不再支持 `.npmrc` 中的 `electron_mirror` / `electron_builder_binaries_mirror` 自定义键，会报 warn）。
- **DEP0190 警告**：`scripts/dev.js` 中 Windows 平台用 `spawn('npx electron-vite dev', { shell: true })`（整条命令字符串），其他平台用 `spawn('npx', ['electron-vite', 'dev'])`（args 数组 + shell:false），规避 Node.js 的「args 数组 + shell:true」安全警告。
- **vue-router**：`package.json` 含 `vue-router` 依赖，但当前 App **未使用路由**（单页 + 标签页切换），属冗余依赖，可移除。
- **logger 暂禁用**：`main.js` 中 `setupLogger()`（转发 `console` 到主进程）被注释，为排查 el-select 下拉问题时关闭；恢复需验证。
- **配置文件名**：是 `electron.vite.config.mjs`（**不是** `.js`）。
- **无 `demo/` 目录**：旧文档提到的 `demo/index.html` 离线演示页已不存在，离线体验请用应用内「控制响应模拟」。

---

## 进度与路线图

### 已完成 ✅

- 三进程骨架、IPC 桥接、亮/暗双主题
- 工作区上下分栏：上方实时波形持续可见（可拖动调整高度），下方两标签切换：**数据**（左数据流/表切换，右数据分析）/ **PID 调参**（对话式智能体，原「AI 助手」独立标签页已合并进该面板——空闲输入即自由对话）
- 串口全参数配置、DTR/RTS、Raw / JustFloat 解析
- 数据流/数据表、自动发送、录制回放、控制响应模拟
- ECharts 多通道波形（缩放/平移/显隐/标准化/导出）
- 确定性响应分析（数据标签页：指标 + 高级判定 + AI 结构化解释 + 报告导出）
- **PID 调参智能体化（参考 Pi-agent）**：双层循环引擎（外层 followUp / 内层 tool_calls 驱动、steer 中途纠偏、maxTurns=50 兜底）+ 5 个调参工具（查统计 / 查原始数据 / 改 PID / 改前馈 / 设目标，护栏校验 + 错误喂回）+ 动态系统提示词（`<user_config>` 包裹四类用户配置）+ 带时间戳通道数据缓冲 + 上下文压缩（50KB 阈值、仅数据块、retainedTail=3、独立摘要请求）+ 事件驱动 UI（思考打字机 / 工具单行 / 安全警示 / 压缩条）
- 策略注册表（多系统预设，保留为智能体面板的「仿真策略」下拉；串级策略自动展开六参数配置）
- 前馈项「+」自定义添加与系数智能体整定（`set_feedforward_params` 工具 + 用户范围护栏）
- 参数安全护栏（用户配置范围 + 系统上限 + 单步增幅三重校验，裁剪原因返回模型，防异常参数损坏硬件）
- 安全兜底（bestStable 自动回退 + `[安全机制]` 通知 LLM 与 UI，工具错误 isError 喂回不中断循环）
- 嵌入式集成（`.c/.h` 通信层模板，函数指针注入式；服务层 + 测试保留，UI 导出入口随旧面板移除）
- npm 警告修复（`.npmrc` 移除无效键 + `dev.js` 环境变量设置镜像 + DEP0190 警告规避）
- MVP 自测（`tests/` 12 个自测脚本，含智能体 6 项）

### 进行中 🚧

- 离线信号处理降级（Z-N / 继电自整定，无网可用）
- 策略模板扩充（直立环 / 速度环 / 舵机环等更多竞赛系统预设与精细前馈项）
- 串口实机调参深化：`set_target` 下发 `SET_POINT` 异步采集 + `set_pid_params` 真实下发 `PID` 指令（单环 3 参 / 串级 6 参速度环在前）+ 安全回退参数同步下发设备 + 12s 阶跃采集窗口（`suggestedQuery` 建议查询区间）+ stats 只分析窗口内最后一次目标变化段（`stepCount` / `finalValues`）+ 斜坡目标检测（`targetRamping`）；剩余：前馈系数经 `SET` 指令下发设备

### 待完成 📋

- 协议插件机制（FireWater / 自定义二进制等）
- 系统辨识与多通信方式（J-Link / Ozone）
- 单元测试 / E2E 扩展、多语言、配置持久化

---

## 许可证

MIT
