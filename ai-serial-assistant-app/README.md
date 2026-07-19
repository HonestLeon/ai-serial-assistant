# AI 串口调试助手

> 基于 Electron + Vue 3 的智能串口调试工具，集成实时数据监控、波形可视化、AI 辅助分析与 PID 调参。

## 项目简介

AI 串口调试助手是一款面向嵌入式开发、硬件调试场景的桌面应用。它在传统串口调试工具基础上，引入 AI 能力，帮助开发者更高效地进行数据采集、协议解析、异常诊断与控制参数整定。

## 核心功能

- **串口配置与连接**：支持端口、波特率、数据位、停止位、校验位、流控（None / RTS-CTS / XON-XOFF）等完整参数配置
- **DTR / RTS 控制**：连接后可独立切换 DTR、RTS 电平信号
- **协议引擎**：支持 Raw（文本行）与 JustFloat（4 字节 LE 浮点帧）两种数据解析引擎
- **数据流监控**：实时显示收发数据（Rx/Tx），支持文本/HEX 编码切换，带毫秒时间戳
- **数据表视图**：自动解析数值，以表格形式展示时间戳 + I0-I7 通道值
- **自动发送**：可设间隔（ms）定时循环发送，断开连接自动停止
- **数据录制与回放**：一键录制串口数据流，按原始时间间隔回放，支持清空
- **模拟数据**：离线演示按钮，定时推送示例数据行，无需硬件即可体验全部功能
- **实时波形图**：基于 ECharts 的多通道（I0-I7）实时波形，支持通道显隐、Y 轴范围手动/自动、X 轴窗口设置、网格开关、十字准线
- **波形导出**：一键导出当前波形数据为 CSV 或 JSON 格式
- **AI 助手**：对接 OpenAI 兼容 API（支持 GPT-4o、DeepSeek、通义千问等），提供数据分析、异常诊断、协议解析、指令发送等快捷操作
- **实时异常检测**：基于 3σ 统计与 stuck 检测的本地实时异常告警
- **协议自动识别**：启发式识别 JSON / AT 指令 / CSV / Modbus HEX / ASCII 日志等格式
- **串口上下文注入**：每次 AI 对话自动携带最近 10 条数据、通道数值、协议/异常结果
- **数据通道面板**：8 通道实时数值显示，色彩区分
- **PID 调参**：阶跃信号发送 → 响应采集 → AI 分析推荐 Kp/Ki/Kd → 参数下发，完整闭环
- **明暗主题**：完整的亮色/暗色双主题，支持 localStorage 持久化

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | ^42.5 |
| 前端框架 | Vue 3 | ^3.5 |
| UI 组件库 | Element Plus | ^2.14 |
| 图表库 | ECharts | ^6.1 |
| 串口通信 | serialport | ^13.0 |
| 构建工具 | electron-vite + Vite | ^5.0 / ^7.3 |
| 打包工具 | electron-builder | ^26.1 |

## 项目结构

```
ai-serial-assistant-app/
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.js           # 应用入口、窗口创建、IPC 注册
│   │   └── serial.js          # 串口操作封装（list/open/close/send/setDtr/setRts/JustFloat 解析）
│   ├── preload/               # 预加载脚本
│   │   └── index.js           # contextBridge 桥接，暴露 electronAPI
│   └── renderer/              # 渲染进程（Vue 3 SPA）
│       ├── index.html
│       └── src/
│           ├── main.js        # Vue 应用初始化、主题管理
│           ├── App.vue        # 根组件、布局骨架、全局 AI 配置与录制状态
│           ├── style.css      # 设计系统（CSS 变量、主题、Element Plus 覆盖）
│           └── components/
│               ├── SerialPanel.vue    # 串口配置 + AI 设置 + 协议引擎 + DTR/RTS
│               ├── DataMonitor.vue    # 数据流/数据表 + 自动发送 + 录制/回放 + 模拟数据
│               ├── ChartPanel.vue     # 实时波形 + 轴范围/网格/准线 + 导出
│               ├── AiPanel.vue        # AI 对话 + 快捷操作 + 异常检测 + 协议识别
│               ├── PidPanel.vue       # PID 阶跃采集 → AI 分析 → 参数下发
│               ├── ChannelPanel.vue   # 通道数值面板
│               └── StatusBar.vue      # 底部状态栏
├── demo/                      # 纯 HTML 可交互演示（无需 Electron）
│   └── index.html             # 完整功能演示页面
├── electron.vite.config.js    # electron-vite 配置
└── package.json
```

## 架构说明

采用 Electron 标准三进程模型，通过 IPC 实现进程间通信：

```
┌─────────────────────────────────────────────────────┐
│  渲染进程 (Renderer)                                 │
│  Vue 3 + Element Plus                                │
│    ├─ SerialPanel  ─┐                                │
│    ├─ DataMonitor  ─┤  window.electronAPI.serial.*  │
│    ├─ ChartPanel   ─┤───────────────────────────────┼──┐
│    ├─ AiPanel      ─┤                                │  │
│    ├─ PidPanel     ─┤                                │  │
│    └─ StatusBar    ─┘                                │  │ IPC
└─────────────────────────────────────────────────────┘  │
                                                          │
┌─────────────────────────────────────────────────────┐  │
│  预加载脚本 (Preload)                                 │  │
│  contextBridge.exposeInMainWorld('electronAPI')      │──┘
│    serial: { list, open, close, send,                │
│              setDtr, setRts,                         │
│              onData, onStatus, onError }             │
└─────────────────────────────────────────────────────┘  │
                                                          │
┌─────────────────────────────────────────────────────┐  │
│  主进程 (Main)                                        │  │
│    ipcMain.handle('serial:list' / 'open' /           │──┘
│                     'close' / 'send' /               │
│                     'setDtr' / 'setRts')             │
│    SerialPort + ReadlineParser / JustFloat 解析      │
│    webContents.send('serial:data' / 'status' /       │
│                     'error')                         │
└─────────────────────────────────────────────────────┘
```

### IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `serial:list` | Renderer → Main | 列举可用串口 |
| `serial:open` | Renderer → Main | 打开串口（含参数 + 协议引擎） |
| `serial:close` | Renderer → Main | 关闭串口 |
| `serial:send` | Renderer → Main | 发送数据（utf8/hex） |
| `serial:setDtr` | Renderer → Main | 设置 DTR 电平 |
| `serial:setRts` | Renderer → Main | 设置 RTS 电平 |
| `serial:data` | Main → Renderer | 推收到的数据行 |
| `serial:status` | Main → Renderer | 连接状态变更 |
| `serial:error` | Main → Renderer | 错误通知 |

### 安全策略

- `contextIsolation: true`：上下文隔离
- `nodeIntegration: false`：禁用渲染进程 Node 集成
- 通过 `contextBridge` 最小化暴露面，仅暴露 `electronAPI` 命名空间

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

启动后自动打开 DevTools（detach 模式）。

### 构建打包

```bash
# 构建产物（不打包）
npm run build

# 构建并打包为安装包
npm run dist
```

### 离线演示

无需硬件串口设备，点击数据流页面的「模拟数据」按钮即可定时推送示例数据，体验波形、AI 上下文注入、数据表等全部功能。

也可直接用浏览器打开 `demo/index.html` 体验可交互的完整功能演示。

## 使用指南

### 1. 连接串口

1. 在左侧「协议与连接」区域选择数据引擎（Raw / JustFloat）
2. 在「串口参数」区域点击刷新按钮获取可用端口列表
3. 选择端口、波特率、数据位、停止位、校验位、流控（默认 115200, 8N1）
4. 点击「打开串口」按钮建立连接
5. 连接后可点击 DTR / RTS 按钮切换硬件控制信号

### 2. 数据收发

- **接收**：数据流标签页实时显示收到的数据，带时间戳与方向标识（Rx/Tx）
- **数据表**：切换到「数据表」子标签查看结构化的通道数值表格
- **发送**：底部输入框输入内容，选择文本或 HEX 编码，点击发送或按回车
- **自动发送**：设置间隔（ms）后点击「自动发送」定时循环发送
- **HEX 模式**：状态栏点击 HEX 按钮切换显示编码
- **模拟数据**：点击「模拟数据」按钮启动/停止离线数据推送

### 3. 数据录制与回放

- 点击「录制」按钮开始录制串口数据流
- 点击「停止录制」结束录制
- 点击「回放」按原始时间间隔重放录制的数据
- 点击「清空录制」清除录制数据

### 4. 波形监控

切换到「波形图」标签页：

- 左侧通道列表点击眼睛图标可显隐对应通道
- **Y 轴范围**：切换自动/手动，手动时可设 Min / Max
- **X 轴范围**：设置滚动窗口点数（10-200）
- **网格线**：开关切换网格显隐
- **十字准线**：开关切换 tooltip 十字准线
- **导出**：点击「导出 CSV」或「导出 JSON」保存当前波形数据
- 数据中解析出的数字会自动绘制为曲线，支持亮暗主题自适应配色

### 5. AI 助手

切换到「AI 助手」标签页：

1. 在左侧 SerialPanel 的「AI 设置」区域配置模型、Base URL、API Key（配置自动保存到 localStorage）
2. **快捷操作**：点击「数据分析」「异常诊断」「协议解析」自动构造带串口上下文的 prompt 调用 AI
3. **发送指令**：在指令输入框输入内容，点击「发送指令」直接通过串口发送
4. **实时异常检测**：开启开关后，基于 3σ 统计与 stuck 检测实时告警
5. **协议自动识别**：开启开关后，启发式识别 JSON / AT / CSV / Modbus HEX / ASCII 等格式
6. 自由对话：输入问题并发送，AI 会自动携带最近 10 条数据与通道数值作为上下文

> 支持的模型：gpt-4o-mini、gpt-4o、deepseek-chat、qwen-turbo

### 6. PID 调参

切换到「PID 调参」标签页：

1. **阶跃信号发送**：配置阶跃指令、幅值、采集时长、通道，点击发送
2. **AI 参数分析**：采集完成后点击「AI 分析响应」，AI 分析超调量/上升时间/调节时间并推荐 Kp/Ki/Kd
3. **参数下发**：确认或编辑参数后点击「下发 PID 参数」通过串口发送

## 设计系统

项目内置完整的 CSS 变量设计系统（`src/renderer/src/style.css`）：

- **色彩**：主色（蓝）、AI 色（绿）、状态色（成功/警告/错误）、8 通道专属色
- **字体**：显示字体 Inter / 等宽字体 JetBrains Mono
- **间距/圆角**：4px 基准网格
- **主题**：亮色默认 / 暗色（`.dark` 类切换），Element Plus 变量同步覆盖

## 开发说明

### 数据协议

- **Raw 模式**：使用 `ReadlineParser`（以 `\n` 分行），每行数据通过正则 `[-+]?\d*\.?\d+` 提取数字用于波形与通道数值显示
- **JustFloat 模式**：解析二进制浮点帧（4 字节 LE float × N + 尾帧 `0x00 0x00 0x80 0x7F`），解析后转为空格分隔文本兼容下游

### 主题切换

- 通过 `StatusBar` 中的主题按钮切换
- 状态保存于 `localStorage.theme`
- 切换时派发 `theme-change` 自定义事件，`ChartPanel` 监听并刷新 ECharts 配色

### 离线演示 Demo

`demo/index.html` 是一个纯前端单文件 HTML 页面，无需 Electron 和 Node.js，用浏览器直接打开即可体验：

- 模拟串口连接与数据推送
- 数据流监控与数据表
- 实时波形图（ECharts CDN）
- AI 对话模拟（内置规则引擎）
- PID 调参流程演示
- 通道面板与状态栏

## 功能完成度

| 模块 | 功能点 | 状态 |
|------|--------|------|
| **串口配置** | 端口列表获取 | ✅ |
| | 参数配置（波特率/数据位/停止位/校验位/流控） | ✅ |
| | 连接/断开控制 | ✅ |
| | DTR/RTS 控制 | ✅ |
| | 协议引擎（Raw / JustFloat） | ✅ |
| **数据流监控** | 实时接收显示 | ✅ |
| | 数据发送（文本/HEX） | ✅ |
| | 编码切换显示 | ✅ |
| | 时间戳显示 | ✅ |
| | 数据表视图 | ✅ |
| | 自动发送 | ✅ |
| | 数据录制与回放 | ✅ |
| | 模拟数据 | ✅ |
| **实时波形** | 多通道显示（I0-I7） | ✅ |
| | 通道显隐切换 | ✅ |
| | 滚动窗口 | ✅ |
| | Y 轴范围设置 | ✅ |
| | X 轴范围设置 | ✅ |
| | 网格线开关 | ✅ |
| | 十字准线 | ✅ |
| | 波形导出（CSV/JSON） | ✅ |
| **AI 助手** | 对话界面 | ✅ |
| | API 配置（Base URL / Key / Model） | ✅ |
| | 模型支持 | ✅ |
| | 快捷操作按钮 | ✅ |
| | 实时异常检测 | ✅ |
| | 协议自动识别 | ✅ |
| | 串口上下文注入 | ✅ |
| **PID 调参** | 阶跃信号发送 | ✅ |
| | 响应数据采集 | ✅ |
| | AI 参数分析 | ✅ |
| | 参数下发 | ✅ |
| **界面交互** | 亮暗主题切换 | ✅ |
| | Rx/Tx 计数 | ✅ |
| | 连接状态显示 | ✅ |

### 后续计划

- [ ] 多协议支持（Modbus / CAN / UART 自定义协议）
- [ ] 云端数据同步与远程调试
- [ ] 历史数据持久化与离线分析

## 许可证

MIT
