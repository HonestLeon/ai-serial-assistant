# AI 串口调试助手

基于 **Electron + Vue 3** 的智能串口调试桌面应用，面向嵌入式开发、硬件调试和 IoT 场景。集成实时波形绘制、AI 数据分析、PID 调参辅助等能力，提供深色专业风格的统一界面体验。

---

## 一、项目简介

AI 串口调试助手致力于打造一款现代化的串口通信工具，在传统的收发、波形查看功能之上，引入 AI 能力帮助用户：

- 自动识别通信协议与数据异常
- 分析波形特征并给出优化建议
- 辅助 PID 参数整定（发送阶跃 → 采集响应 → AI 分析 → 下发参数）

项目采用 Electron 构建跨平台桌面应用，渲染进程使用 Vue 3 + Element Plus 进行界面开发，主进程通过 `serialport` 库实现底层串口通信。

---

## 二、技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 42.x |
| 构建工具 | electron-vite + Vite 7 |
| 前端框架 | Vue 3.5.x |
| UI 组件库 | Element Plus 2.14.x |
| 图标 | @element-plus/icons-vue |
| 图表 | ECharts 6.x |
| 串口通信 | serialport 13.x |
| 进程通信 | Electron IPC + Preload 脚本 |

---

## 三、代码架构

项目采用 Electron 经典的三进程架构：主进程（Main）、预加载脚本（Preload）、渲染进程（Renderer）。

```
ai-serial-assistant-app/
├── src/main/
│   ├── index.js          # 主进程入口：窗口创建、IPC 注册、生命周期管理
│   └── serial.js         # 串口服务：枚举/打开/关闭/发送/接收
├── src/preload/
│   └── index.js          # 安全桥接：将 serial API 暴露给渲染进程
└── src/renderer/
    ├── index.html        # 渲染进程入口 HTML
    └── src/
        ├── main.js       # Vue 应用初始化、Element Plus 注册
        ├── style.css     # 全局样式与设计系统变量
        ├── App.vue       # 应用主布局：标题栏、三栏布局、状态栏
        └── components/
            ├── SerialPanel.vue    # 串口配置与连接控制
            ├── DataMonitor.vue    # 数据收发/数据流/数据表
            ├── ChartPanel.vue     # 实时波形图
            ├── AiPanel.vue        # AI 对话与快捷操作
            ├── ChannelPanel.vue   # 数据通道列表
            └── StatusBar.vue      # 底部状态栏
```

### 3.1 主进程（Main Process）

- 负责创建 BrowserWindow、加载渲染页面
- 通过 `ipcMain.handle` 注册串口相关 IPC 通道
- 调用 `serial.js` 中的 `listPorts`、`openPort`、`closePort`、`send` 完成硬件交互
- 接收串口数据后通过 `webContents.send` 推送到渲染进程

### 3.2 预加载脚本（Preload）

- 使用 `contextBridge.exposeInMainWorld` 向渲染进程暴露 `window.electronAPI`
- 提供 `serial.list()`、`serial.open()`、`serial.close()`、`serial.send()` 等异步调用
- 提供 `serial.onData()`、`serial.onStatus()`、`serial.onError()` 等事件监听
- 保持 `contextIsolation: true`，避免直接暴露 Node.js API 到前端

### 3.3 渲染进程（Renderer Process）

- Vue 3 组合式 API 开发组件
- 各页面通过 `v-show` 切换，避免频繁挂载/卸载
- 数据流、波形图、AI 助手、PID 调参分别对应独立组件
- 通过 `window.electronAPI.serial` 与主进程通信

---

## 四、设计系统

项目参考 VOFA+ 风格并加入 AI 主题色，采用统一的深色设计系统：

```css
:root {
  /* 背景层级 */
  --color-bg-primary: #0d1117;
  --color-bg-secondary: #161b22;
  --color-bg-tertiary: #1c2333;

  /* 文字层级 */
  --color-text-primary: #e6edf3;
  --color-text-secondary: #8b949e;
  --color-text-tertiary: #6e7681;

  /* 品牌与 AI 强调色 */
  --color-primary: #58a6ff;
  --color-ai: #3fb950;

  /* 状态色 */
  --state-success: #3fb950;
  --state-warning: #d29922;
  --state-error: #f85149;

  /* 数据通道色 */
  --color-channel-0: #f778ba;
  --color-channel-1: #58a6ff;
  --color-channel-2: #79c0ff;
  --color-channel-3: #d29922;
  --color-channel-4: #bc8cff;
  --color-channel-5: #3fb950;
  --color-channel-6: #f0883e;
  --color-channel-7: #f85149;

  /* 布局 */
  --sidebar-width: 260px;
  --right-panel-width: 220px;
  --header-height: 40px;
  --statusbar-height: 28px;
}
```

设计稿源文件位于 `AI串口助手前端界面设计/` 目录，包含：

- `pages/main-workspace.html`：工作区设计稿
- `pages/waveform.html`：波形图设计稿
- `pages/ai-chat.html`：AI 助手设计稿
- `pages/pid-tuning.html`：PID 调参设计稿
- `pages/ui-demo.html`：UI 组件示例 Demo
- `colors_and_type.css`：颜色与字体规范

---

## 五、开发环境

### 5.1 前置依赖

- Node.js 18+
- npm 9+ 或 pnpm 8+
- Windows / macOS / Linux

### 5.2 安装依赖

```bash
cd ai-serial-assistant-app
npm install
```

> 国内环境已配置 `.npmrc` 使用 Electron 国内镜像，可加速 Electron 与 electron-builder 二进制文件下载。

### 5.3 开发运行

```bash
npm run dev
```

启动后 Electron 窗口会自动打开，渲染进程开发服务器运行在 `http://localhost:5173/`。

### 5.4 生产构建

```bash
npm run build
```

构建产物输出到 `out/` 目录：

- `out/main/index.js`：主进程代码
- `out/preload/index.mjs`：预加载脚本
- `out/renderer/`：渲染进程资源

### 5.5 打包发布

```bash
npm run dist
```

使用 electron-builder 生成对应平台的安装包。

---

## 六、开发测试

### 6.1 当前测试方式

- **构建验证**：运行 `npm run build` 检查主进程、预加载脚本、渲染进程是否全部编译通过
- **界面验证**：运行 `npm run dev` 启动 Electron 应用，检查布局、主题、组件渲染
- **串口验证**：连接实际串口设备，测试端口枚举、打开/关闭、数据收发、实时波形

### 6.2 调试技巧

- 渲染进程 DevTools：在 Electron 窗口中按 `Ctrl+Shift+I`（Windows/Linux）或 `Cmd+Option+I`（macOS）
- 主进程日志：终端直接查看 `console.log` 输出
- 串口数据监听：在 `DataMonitor.vue` 的消息列表中观察 Rx/Tx 数据

### 6.3 常见问题

| 问题 | 解决方案 |
|------|----------|
| Electron 下载慢 | 已配置 `.npmrc` 国内镜像，必要时手动设置 `ELECTRON_MIRROR` |
| 串口打开失败 | 检查设备是否被其他程序占用，或尝试以管理员权限运行 |
| 图标构建报错 | 确保使用 `@element-plus/icons-vue` 实际导出的图标名称 |

---

## 七、当前进度

### 已完成 ✅

- [x] Electron + Vue 3 项目骨架搭建
- [x] 串口服务封装（list / open / close / send / receive）
- [x] IPC 安全桥接（Preload 脚本）
- [x] 深色主题设计系统落地（颜色、字体、间距、布局变量）
- [x] 应用主布局（标题栏 + 三栏布局 + 状态栏）
- [x] 串口配置面板（SerialPanel）
- [x] 数据收发区（DataMonitor）
- [x] 实时波形图（ChartPanel + ECharts）
- [x] AI 对话面板（AiPanel）
- [x] 数据通道面板（ChannelPanel）
- [x] 状态栏组件（StatusBar）
- [x] Element Plus 图标兼容性修复
- [x] UI 示例 Demo（ui-demo.html）
- [x] 生产构建通过验证

### 进行中 🚧

- [ ] AI 后端服务接入（OpenAI / DeepSeek API 调用）
- [ ] 实时异常检测算法
- [ ] PID 调参完整流程实现
- [ ] 数据表视图（Grid）
- [ ] 数据导出与日志保存

### 待完成 📋

- [ ] 单元测试与 E2E 测试
- [ ] 应用打包与自动更新
- [ ] 多语言支持
- [ ] 用户配置持久化
- [ ] 协议插件机制（Raw / JustFloat / 自定义）

---

## 八、贡献与许可

- 作者：AI Serial Assistant Team
- 许可证：MIT

欢迎提交 Issue 和 PR，共同完善这款面向开发者的串口调试工具。
