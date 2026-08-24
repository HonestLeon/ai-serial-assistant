# AI 串口调试助手 · 前端 UI 设计审查报告

**审查范围**：14 个前端文件，约 6000 行（`App.vue`、`style.css`、`main.js`、`index.html` 及 `SerialPanel` / `ChannelPanel` / `StatusBar` / `DataMonitor` / `ChartPanel` / `WorkspaceChart` / `AiPanel` / `PidPanel` / `AnalysisPanel` / `WorkspaceAnalysis` 共 10 个业务组件）。

**技术栈**：Electron 42 + Vue 3.5 + Element Plus 2.14 + ECharts 6.1。

**适配基准**：1920 / 1366px，下限 1024px。

**审查方法**：代码级审查 + WCAG 对比度实算（相对亮度公式），全部问题均有文件 / 类名 / 行号依据；标注「需实际渲染验证」的结论尚未经运行时确认。

**遵循规范**：Element Plus 组件规范 + 项目既有 GitHub Primer 风格 token 体系（`style.css` 双主题 CSS 变量）。

---

## 第一部分：问题总览

### 最核心的 3 个设计问题

**问题一：全局反馈体系断裂——操作成败对用户不可见。**
串口链路的全部错误（打开 / 关闭失败、刷新端口失败、DTR/RTS 设置失败、运行时错误）经 `SerialPanel` 五处 `emit('error', …)` 上抛后，被 `App.vue` L169-171 的空函数 `onError` 静默吞掉，串口链路无任何全局反馈组件；`PidPanel` 把参数下发**成功**、应用仿真**成功**、取消下发等文案写入 `error` ref，渲染在与校验错误完全相同的红色错误框（L1513 / L1860-1868）中，成败语义颠倒；`AiPanel` 的 `callAi`（L123-150）无超时、无取消，失败消息与正常 AI 回复以相同气泡样式呈现且无重试入口；清空数据流 / 表格 / 录制 / 波形等不可逆操作全部无二次确认。其结果是：连接、调参、AI 分析三条核心链路上，用户均无法可靠判断操作结果。

**问题二：可读性基准系统性不达标——三级文字色两主题均低于 WCAG AA。**
`--color-text-tertiary` 浅色主题取 `#8b949e`（`style.css` L48）、暗色主题取 `#6e7681`（L93），实算对比度分别为 2.65–3.08:1 与 3.76–4.12:1，全部低于 AA 要求的 4.5:1；且两个色值疑似对调——`#8b949e` 是 Primer **暗色**主题的次级灰却被用于浅色主题，`#6e7681` 恰为其浅色对应档位。该变量被映射为全部输入框 placeholder（`--el-text-color-placeholder`），波及全部 10 个业务组件的表单标签、时间戳、状态文字、指标名与图表轴标签（轴标签还叠加 10px 体系外字号）。再叠加 9px/10px 体系外小字号与 `var(--color-warning)` 等未定义变量的硬编码 fallback 色，可读性成为覆盖面最广的系统性缺陷。

**问题三：规范执行三轨并行——EP 组件、原生控件与硬编码值互不收敛。**
同屏并存三套控件规格：`el-button`（连接控制）与原生 `<button>`（发送 / 清空 / 录制 / 回放 / 导出等）混用，高度 22/24/28px 三档并存，且除 1 处外全部原生按钮类缺失 `:hover`/`:active` 状态；三个组件（`ChannelPanel` / `ChartPanel` / `AnalysisPanel`）从未被任何页面挂载，与在用实现（`DataMonitor` / `WorkspaceChart` / `WorkspaceAnalysis`）形成双轨漂移，其中 `ChartPanel` 内含通道越界与 resize 监听泄漏两个高危潜在缺陷；响应式方面存在 5 个互不相同断点（720/900/960/1100/1180px）且全部基于视口宽度（未扣除 260px 固定侧栏），叠加 260px 全局侧栏 / 380px PID 左栏 / 220px、158px 图表侧栏等固定宽度，1024px 下限分辨率下布局失衡。

### 整体设计水平总结

项目已建立 GitHub Primer 风格的双主题 token 体系（双主题完整成对的背景 / 边框 / 文字 / 通道色板 / 状态色）与清晰的「侧栏 + 波形区 + 工作区标签 + 状态栏」四区布局骨架，规范层完成度约七成；但落地层被原生控件、硬编码色值与断裂的反馈链路稀释，整体处于**中等偏上但一致性失控**的水平——设计体系「形备而神散」，上述三类系统性根因（反馈断裂、可读性不达标、三轨并行）修复后可显著上一个台阶。

---

## 第二部分：详细问题清单

### 高危（影响功能使用，5 项）

#### H1. 串口错误反馈链路完全断裂，失败静默不可诊断
- **问题位置**：`src\renderer\src\App.vue` L169-171（`onError` 空函数，函数体仅含注释 `// 状态栏处理连接错误`）；`src\renderer\src\components\SerialPanel.vue` L66 / L87 / L100 / L111 / L123（五处 `emit('error', …)`，其中 L87 直接传异常对象 `e`，与其他处 `e.message || '…'` 的写法不一致）
- **具体问题**：串口链路无全局反馈组件，App.vue 的 `onError` 为空实现——刷新端口列表失败、打开 / 关闭串口失败（端口占用、权限等）、DTR/RTS 设置失败、串口运行时错误全部被吞掉（说明：全项目并非无 `ElMessage` / `ElMessageBox` 引用，`PidPanel` / `AnalysisPanel` 实际有使用，此问题限定于串口链路）
- **造成影响**：串口打开失败时界面完全静默——按钮 loading 一闪即逝，状态停留在「未连接」，用户无从得知失败原因，核心链路故障不可诊断
- **问题等级**：高危

#### H2. PidPanel 成功消息渲染为红色错误框，参数下发成败语义颠倒
- **问题位置**：`src\renderer\src\components\PidPanel.vue` L1162（`error.value = '已应用至仿真：…（点击"运行仿真"验证）'`）、L1181（`'已取消下发，设备参数未改变'`）、L1188（`error.value = '已下发: ' + cmd`）；渲染点 L1513（`<div v-if="error" class="error-msg">`）；样式 L1860-1868（红底 `rgba(248, 81, 73, 0.08)` / 红边 / `--state-error` 红字）
- **具体问题**：下发 PID 参数**成功**、应用至仿真**成功**、取消下发等成功类信息全部写入与校验错误、发送失败共用的 `error` ref，渲染为红色错误框
- **造成影响**：参数写入设备是本应用最危险的操作，其成败反馈语义颠倒——用户看到红框会误判下发失败而重复下发或中止流程
- **问题等级**：高危

#### H3. AiPanel AI 请求无超时无取消，失败与正常回复零差别
- **问题位置**：`src\renderer\src\components\AiPanel.vue` L123-150（`callAi` 的 fetch 无 AbortController / timeout，已核对确认）；L146-147（catch 后 `return '请求失败：…'`）；L164（该字符串以 `role: 'assistant'` 推入消息列表）；L372 / L384 / L430（loading 期间快捷按钮、指令输入、聊天输入框全部 `:disabled`）
- **具体问题**：请求挂起时整个面板输入永久禁用且无取消手段；错误消息复用 `.message-bubble.assistant` 样式（绿色左边框，L661-666），与正常 AI 回复视觉上零差别；无重试按钮
- **造成影响**：网络异常时对话功能不可恢复（只能无限等待）；错误辨识完全依赖阅读文字内容
- **问题等级**：高危

#### H4. DataMonitor 消息列表无限增长 + index 作 key，长时间运行必然卡顿
- **问题位置**：`src\renderer\src\components\DataMonitor.vue` L199-219（`onSerialData` 中 `messages.value.unshift` 无条数上限，已核对确认；对照同函数内 `tableRows` 有 `MAX_TABLE_ROWS=1000` 保护）；L357-362（`v-for :key="idx"` 数组索引作 key）；无虚拟滚动
- **具体问题**：messages 数组无上限；key 用数组索引，每次 unshift 导致全列表 key 错位、整表重渲染
- **造成影响**：115200 波特率连续接收数分钟即达数万 DOM 节点，滚动与自动跟随卡顿甚至假死
- **问题等级**：高危

#### H5. 三级文字色两主题系统性低于 WCAG AA，波及全部业务组件（合并 2.1 / 2.2 / S8 / A7 / A11 / C6）
- **问题位置**：`src\renderer\src\style.css` L48（light `--color-text-tertiary: #8b949e`）、L93（dark `--color-text-tertiary: #6e7681`），已核对确认；使用位置：`App.vue` `.header-context`（11px）、`.app-version`（10px）及经 `--el-text-color-placeholder`（style.css L144）波及的**全部输入框 placeholder**；`SerialPanel.vue` `.field label`（L347-352）；`StatusBar.vue` 整栏文字（L66-67）；`DataMonitor.vue` `.rec-count` / `.timestamp` / `.empty` / `.interval-label`（L522-526 / L548-552 / L619-623 / L665-668）；`ChannelPanel.vue` `.channel-name`（L100-106）；`PidPanel.vue` `.field label` / `.empty-hint` / `.overview-param .param-name` / `.history-metric`（L1807-1810 / L1842-1851 / L2050-2053 / L1938-1942）；`WorkspaceAnalysis.vue` `.analysis-header span` / `.section-title span` / `.metric span` / `.health-card span`（L344 / L350-351 / L365）；`AnalysisPanel.vue` `.rule-note` / `.candidate-foot`（L262）；`AiPanel.vue` L539 / L552 / L602；图表轴标签（`ChartPanel.vue` L83/L106、`WorkspaceChart.vue` L115/L147，`axisLabel` 另有 10px 体系外字号）
- **具体问题**：light `#8b949e` on `#ffffff` = **3.08:1**、on `#f5f7fa` = **2.87:1**、on `#ebeef5` = **2.65:1**；dark `#6e7681` on `#0d1117` = **4.12:1**、on `#161b22` = **3.76:1**——两主题全部低于正文 AA 要求的 4.5:1，且使用处均为 10–13px 小字。两个色值疑似对调：`#8b949e` 是 Primer 暗色主题的次级灰却被用于浅色主题，`#6e7681` 为其浅色对应档位
- **造成影响**：表单标签、时间戳、帧计数、状态栏整行、指标名、placeholder、图表轴标签等大量信息载体在两主题下可读性不足，1366px 基准屏上尤甚
- **问题等级**：高危（素材单评为中危；提升理由：该问题波及全部 10 个在用业务组件、承担标签 / 时间戳 / 状态 / 轴标签等信息载体的正文级文字，两主题均不达标且根因单一——两个 token 取值错误，属可读性基准缺陷，一行级改动即可全局生效）

### 中危（影响核心体验，25 项）

#### M1. 三个死组件与在用实现双轨漂移（合并 S31 / C1 / A1）
- **问题位置**：`src\renderer\src\components\ChannelPanel.vue`（全文件，全项目无 import）；`src\renderer\src\components\ChartPanel.vue`（全文件，仅 `WorkspaceChart` 在用）；`src\renderer\src\components\AnalysisPanel.vue`（全文件，App.vue L3-10 仅导入其余 7 个组件）
- **具体问题**：三个完整实现的组件未被任何页面挂载，且与在用实现发生漂移：`ChartPanel` 与 `WorkspaceChart` 侧栏宽度 220px vs 158px、图标显式 13px vs 继承字号、清空按钮位置、未连接文案均不一致；`AnalysisPanel` 与 `WorkspaceAnalysis` 的按钮体系、卡片字号、mono 字体均不一致；`ChannelPanel` L36 `<View>/<Hide>` 图标未显式 import，L20 `visible` 为硬编码常量，L87-91 `.eye-icon` 设 `cursor:pointer` 却无 `@click` 绑定
- **造成影响**：同一功能两套视觉规格，后续修改任一份都会造成规范分裂；**潜在高危**：`ChartPanel` 内含两个高危缺陷——通道数无上限（L124-126 `while` 循环无 8 上限，`colors[i]` 越界为 `undefined`，L59-77 生成全部 series）与 resize 监听器泄漏（L216 匿名函数未在 `onUnmounted` 移除，L235-238 仅移除 `theme-change`；且无 ResizeObserver）——若恢复挂载会实际生效；另含 `.channel-row` 为 div 不可键盘操作（L251-257）、无 dataZoom 历史不可回看（L120-143）、`.chart` 缺 `min-height: 0`（L530-535）三处组件内缺陷
- **问题等级**：中危（不影响运行中功能；内含两处高危潜在缺陷随删除即消除）

#### M2. el-button 与原生 button 双轨并存：高度三档 + hover/active 状态大面积缺失（合并 S6 / S18 / C12 / C2）
- **问题位置**：`SerialPanel.vue` L232-244（`el-button` + 原生 `.small-btn` 高 24px）；`DataMonitor.vue` L670-727（`.btn-primary`/`.btn-secondary`/`.btn-auto` 高 28px）、L482-494（`.rec-btn` 高 22px）、L454-473（`.sub-tab`）；`StatusBar.vue` L76-90（`.hex-toggle`）；`ChannelPanel.vue` L87-91（`.eye-icon`）；`ChartPanel.vue` L276/L281-290/L309-313/L326/L426-440/L504-507/L537-546；`WorkspaceChart.vue` L288-298/L311/L314-316/L320-321/L332（`channel-button`/`auto-button`/`export-button`/`clear-button`）
- **具体问题**：连接控制用 EP 按钮（自带 loading/hover 主题态），数据区与状态栏全用手写原生按钮；高度 22/24/28px 三种并存，字号 `--text-xs`/`--text-sm` 混用；除 `StatusBar.vue` L135-138 `.theme-toggle` 外，所有原生按钮类均未定义 `:hover`/`:active`（`.eye-icon` 设 `cursor:pointer` 却无 hover；`.auto-toggle` 有 `.active` 无 hover；`.export-btn` 有 hover 无 active/disabled）；两处导出按钮在零数据时不置禁用
- **造成影响**：EP 按钮与手写按钮的 hover/focus 行为割裂；发送 / 清空 / 录制 / 回放 / 导出等高频操作悬停零反馈，可点击性感知差；同类操作按钮视觉规格不统一
- **问题等级**：中危

#### M3. 危险操作均无二次确认（合并 S16 / C13）
- **问题位置**：`DataMonitor.vue` L177-180（`clear()` 直接清空 messages + tableRows，已核对确认）、L343-346（清空录制按钮）、L234-255（`replayRecording` 先 `await serial.close()` 关闭串口后才插入提示消息）；`App.vue` L71-73（`clearRecording` 直接置空 `recording.data`）；`SerialPanel.vue` L70-91（关闭串口一键直达）；`ChartPanel.vue` L145-151、`WorkspaceChart.vue` L199-207（`clear()` 一次点击丢弃全部已采集波形数据，最多 2000 点）
- **具体问题**：清空数据流 / 数据表 / 录制数据 / 波形，以及「回放前自动关闭串口」全部无 `ElMessageBox.confirm`；回放关闭串口的通知发生在动作完成之后（对照：PidPanel 的下发确认 L1170-1184 是完备的正面范例）
- **造成影响**：误触「清空」不可恢复；正在进行的硬件通信被回放静默中断
- **问题等级**：中危

#### M4. 响应式断点碎片化 + 固定宽度叠加，1024px 下布局失衡（合并 4.3 / 4.1 / 4.2 / A23 / A24 / A25 / C21 / C22 / C24 / S27 / S28）
- **问题位置**：断点：`App.vue` L589（1100px）、`PidPanel.vue` L1681（960px）/ L2215（720px）/ L2446（900px）、`AnalysisPanel.vue` L269（1180px）；固定宽度：`style.css` L24（`--sidebar-width: 260px`，`.sidebar` 另有 `flex-shrink: 0` 双重固定）、`PidPanel.vue` L1662（`.pid-left { flex: 0 0 380px }` 固定不缩）、`AiPanel.vue` L446-448（`.ai-sidebar` 260px 固定 + L418 内联 `style="width: 200px"` 的 el-select、L668-674 config-bar 无 flex-wrap）、`ChartPanel.vue` L340-342（220px）、`WorkspaceChart.vue` L341（158px）；`src\main\index.js` L9-21（BrowserWindow 仅设 `width: 1280`，**未设 minWidth**，已核对确认，窗口可任意缩小）
- **具体问题**：5 个互不相同断点且无 token 化，全部基于视口宽度而非内容区宽度（侧栏恒占 260px，触发时机与内容实际可用宽度不对应）；叠加多处固定宽度后：1024–1100px 区间 `.data-split` 折叠为上下堆叠（App.vue L589-594），以 1024×768 估算每个堆叠面板仅约 146px 高；视口 961–1220px 时 PID 双栏仍生效，左栏 380px 固定 + gap 16px，右栏仅约 305–560px，param-grid 两列字段被压至约 140–270px；`WorkspaceChart` 通道按钮两列网格每列约 67px，小于中文通道名所需约 84px（L343-344、L182）；DataMonitor 工具栏静态内容合计约 600px+ 超出左半区约 470–500px（L308-349 无 flex-wrap，需实际渲染验证）；发送行非输入控件合计约 380–400px 固定宽度，输入框被压至不足百像素（L398-432、L631-646，需实际渲染验证）；PidPanel 左栏 380px 内 param-grid 网格单元约 168px，两个中文 radio-button 固有宽度接近或超过该值（L1240-1259，需实际渲染验证）；图表工具栏 / 头部均无 flex-wrap（ChartPanel L517-523、WorkspaceChart L354，需实际渲染验证）
- **造成影响**：同一缩放过程中不同面板在不同宽度依次重排，布局变化不可预期；1024px 下限分辨率下数据面板高度骤减（表格可见行数为个位数）、PID 右栏字段被裁切、图表通道按钮文字折行、发送输入框不可用
- **问题等级**：中危

#### M5. 引用未定义 CSS 变量，样式静默失效（合并 1.1 / S29 / A4 部分）
- **问题位置**：`App.vue` `.app-version` L386（`border-radius: var(--radius-full)`，token 区 L20-22 仅定义 4/8/12px 三档）；`DataMonitor.vue` L619-623（`.empty` 的 `margin-top: var(--space-8)`，token 区 L15-19 仅定义 `--space-1` 至 `--space-4`）；`PidPanel.vue` L1981 / L2026 / L2030 / L2034 / L2064 / L2301 / L2306 / L2314-2315（`var(--color-warning, #f5a623)`、`var(--color-danger, #e5484d)`、`var(--color-success, #00a870)`——style.css 只定义了 `--state-warning/--state-error/--state-success`，这三个变量**未定义**，永远命中 fallback 值）
- **具体问题**：CSS 规范下引用未定义变量使属性「在计算值时刻无效」：`--radius-full` 使版本徽章圆角回退为 0；`--space-8` 使空状态 margin 归零；带 fallback 的 `--color-*` 三元组则恒定取 fallback 色且不随主题切换
- **造成影响**：版本徽章 `v1.1.0` 渲染为直角矩形而非胶囊形；空状态「等待串口数据...」贴顶显示；phase-tag 等恒用体系外 fallback 色
- **问题等级**：中危

#### M6. 硬编码颜色绕过主题 token 体系（合并 A4 其余 / S5 / C5 / 3.8）
- **问题位置**：`PidPanel.vue` L1862-1863（`.error-msg` 背景 `rgba(248, 81, 73, …)` 为暗色主题错误色 `#f85149`，浅色主题错误色为 `#cf222e`，两主题均不变）；`AiPanel.vue` L509 / L593 / L639（边框色 `rgba(63, 185, 80, …)` 为暗色主题 AI 色 `#3fb950` 的 RGB，浅色 AI 色为 `#1a7f37`）；`AnalysisPanel.vue` L244 / L254-255 / L261 与 `WorkspaceAnalysis.vue` L364（`rgba(34,197,94,.x)`、`rgba(239,68,68,.x)` 为 Tailwind 色值，非本系统 token）；`DataMonitor.vue` L504（`.rec-btn.recording` 背景 `rgba(248, 81, 73, 0.08)`，主题切换时不变）；`ChartPanel.vue` L29-42 与 `WorkspaceChart.vue` L37-50 / L105（16 组图表色值硬编码且两文件重复，tooltip 归一化提示色 `#8b949e` 写死）；`main.js` L65-73（errorHandler 错误横幅内联 `cssText` 硬编码 `background:#f85149; color:#fff`，白字对比度 **3.35:1** 不达标）
- **具体问题**：fallback 与硬编码色均不在 style.css 色板中；主题切换时这些颜色不随 token 变化，暗色主题色被用于浅色主题
- **造成影响**：浅色主题下 phase-tag、运行 / 暂停按钮、engine-note、录制中按钮、错误横幅的色相与全局主题脱节；图表色板双份维护
- **问题等级**：中危

#### M7. Light 主题 EP 主色衍生档位缺失，出现「两种蓝」
- **问题位置**：`src\renderer\src\style.css` L127-157（light 仅覆盖 `--el-color-primary`、light-3、dark-2）；对照 dark 主题 L162-166 完整覆盖 light-3/5/7/9；两主题均缺 light-8
- **具体问题**：EP 的 `--el-color-primary-light-5/7/8/9` 是基于默认蓝 `#409eff` 预计算的静态值，覆盖 `--el-color-primary` 不会联动重算
- **造成影响**：引用这些变量的 EP 组件（primary plain/text 变体按钮、hover 填充等）呈现 `#409eff` 系浅蓝，与全局主色 `#0969da` 不同色系。需实际渲染验证涉及的具体组件
- **问题等级**：中危

#### M8. Dark 主题 success 实心按钮白字对比度严重不足
- **问题位置**：`style.css` L238-244（`.el-button--success` 的 `--el-button-text-color: #ffffff`）+ L107（`--state-success: #3fb950`）；实际使用已确认：`AnalysisPanel.vue` L223、`WorkspaceAnalysis.vue` L305 的「生成解释」/「解释」按钮
- **具体问题**：`#3fb950` 是为深色背景上的前景文字设计的高亮度绿，反用作按钮底色配白字：白 on `#3fb950` = **2.54:1**（对照组合白 on light 主题 `#1a7f37` = 5.08:1 达标）
- **造成影响**：暗色主题下 AI 操作按钮的文字对比度严重不足
- **问题等级**：中危

#### M9. 消息分类与文案转义错误：system 消息标红 + 状态栏显示 `\\n`（合并 S9 / S10）
- **问题位置**：`DataMonitor.vue` L364（三元表达式仅识别 send/receive，system 消息落入 else 分支显示 `Er:` 前缀并套 `--state-error` 红色，L554-561）、L241-245（unshift `type:'system'` 的「开始回放前已自动关闭串口…」）；`StatusBar.vue` L41（`<span class="mono">\\n</span>` 按字面输出为两个反斜杠 + n）
- **具体问题**：中性系统通知被渲染为红色错误行；换行符配置文案信息失真，且项目内无换行符配置入口
- **造成影响**：用户误判发生故障；状态栏显示「UTF-8 \\n」而非「UTF-8 \n」
- **问题等级**：中危

#### M10. 分隔条不可键盘操作、无 ARIA 语义
- **问题位置**：`App.vue` L254-260（`<div class="workspace-resizer" @pointerdown="beginResize">`，无 tabindex / role / aria-orientation / 键盘事件）
- **具体问题**：上下分隔条仅支持 Pointer 拖拽，无 `role="separator"`、不可聚焦、无方向键步进
- **造成影响**：键盘用户完全无法调整波形区 / 工作区高度分配，不满足 WCAG 2.1.1；屏幕阅读器不感知该控件存在
- **问题等级**：中危

#### M11. 暗色主题启动闪白（FOUC）+ 未声明 color-scheme（合并 3.2 / 3.3）
- **问题位置**：`index.html`（无预置背景色、无主题预初始化脚本）；`main.js` L58-63（module 脚本执行时才添加 `.dark` 类，不阻塞首次绘制）；`style.css` 全文 0 处 `color-scheme`（已 grep 验证）、`App.vue` `.sidebar` L455 使用原生 `overflow-y: auto` 滚动条
- **具体问题**：暗色用户首帧可能按 light 主题（白底）渲染后再切换；`:root.dark` 仅替换颜色变量，Chromium 原生滚动条与部分表单控件仍按 light 模式渲染；且侧栏原生滚动条与面板内 el-scrollbar 自绘滚动条两套并存
- **造成影响**：暗色用户每次启动出现白底闪屏（需实际渲染验证闪屏时长）；暗色主题下侧栏出现亮色滚动条（需实际渲染验证）
- **问题等级**：中危

#### M12. 列表滚动跟随体验断裂：暂停无反馈 + AI 对话无跟随（合并 S19 / A16）
- **问题位置**：`DataMonitor.vue` L25 / L38-43（`autoScroll` 由 `scrollTop <= 5` 判定）、L218（`if (autoScroll.value) scrollToTop()`）；`AiPanel.vue` L392-406（`.chat-list` `overflow-y: auto`）、L615-622，全文件无 ref / nextTick / scrollTop 处理
- **具体问题**：DataMonitor 用户下滚查看历史时跟随静默暂停，恢复需手动滚回顶部 5px 阈值内，无「已暂停跟随 / 回到最新」指示；AiPanel 消息超出可视区后新消息渲染在视口底部之外，无滚动跟随、无「回到底部」按钮
- **造成影响**：高频数据流下用户无法感知新数据是否仍在更新；AI 回复到达时用户看不到新内容，需手动下拉
- **问题等级**：中危

#### M13. HEX 三处控件并存且语义不一致
- **问题位置**：`StatusBar.vue` L32（hex-toggle → `showHex` 接收显示格式）；`DataMonitor.vue` L406-409（el-select → `encoding` 发送编码 utf8/hex）与 L410（HEX 按钮 → 同一 `encoding`）
- **具体问题**：状态栏 HEX 按钮（控制「看」）与发送区 HEX 下拉 + 按钮（控制「发」）同名同标签；`showHex` 与 `encoding` 两个状态互不同步；同一 `encoding` 变量有下拉和按钮两个冗余入口
- **造成影响**：用户难以区分「查看 HEX」与「发送 HEX」，两处状态可能一红一白造成困惑
- **问题等级**：中危

#### M14. 「发送(S)」快捷键标注未实现
- **问题位置**：`DataMonitor.vue` L411（按钮文案 `发送(S)`）；全 renderer 仅两处 `@keyup.enter`，无任何 S 键监听
- **具体问题**：按钮文案承诺 S 快捷键，代码中无对应绑定
- **造成影响**：用户按 S 无响应
- **问题等级**：中危

#### M15. 自动发送间隔无有效校验
- **问题位置**：`DataMonitor.vue` L414-421（原生 `input type=number min=100 step=100`，`min` 仅约束步进按钮，手动可键入 0 或负数）；L142-156（`startAutoSend` 直接 `setInterval(doSend, autoSendInterval.value)` 无下限检查）
- **具体问题**：启动自动发送前无 clamp
- **造成影响**：极小间隔将以失控频率向串口写入
- **问题等级**：中危

#### M16. 9px 图表操作提示文字低于可读下限
- **问题位置**：`WorkspaceChart.vue` L354（`.chart-header span { font-size: 9px }`，文案「鼠标滚轮缩放X轴 · 按住拖动平移X轴」，L328 行）
- **具体问题**：9px 为全项目最小字号（token 最小 11px）；ChartPanel 无此提示，两组件信息层级不对齐
- **造成影响**：图表核心操作指引在 1366px 基准屏上接近不可读
- **问题等级**：中危

#### M17. 通道色板 I1/I2 颜色过近，曲线不可辨
- **问题位置**：`ChartPanel.vue` L31-32 与 `WorkspaceChart.vue` L40-41（索引 1/2：浅色 `#0969da` vs `#218bff`，暗色 `#58a6ff` vs `#79c0ff`）
- **具体问题**：两组蓝色色相差极小（RGB 差值约 30/20/10），而 legend 均关闭（`ChartPanel.vue` L100 `legend: { show: false }`；WorkspaceChart 未配置 legend），通道辨识完全依赖侧栏色点
- **造成影响**：8 通道同屏时 I1/I2 两条曲线肉眼难以区分。需实际渲染验证
- **问题等级**：中危

#### M18. 图表画布区无空状态设计
- **问题位置**：`ChartPanel.vue` L328（`.chart` 容器无空态内容）；`WorkspaceChart.vue` L334（`.chart-canvas` 同样无空态，仅侧栏有「等待解析数据通道」文案，L300）
- **具体问题**：无数据时图表区只显示空白坐标轴，无「等待数据 / 支持格式」占位图形或引导文案
- **造成影响**：新用户无从得知需要串口发送 FireWater 格式数据才会出波形，首屏体验为「空白面板」
- **问题等级**：中危

#### M19. dataZoom `moveOnMouseMove: true` 与提示文案「按住拖动」语义冲突
- **问题位置**：`WorkspaceChart.vue` L133-141（inside 型 dataZoom 显式开启 `moveOnMouseMove: true`）vs L328（提示「按住拖动平移X轴」）
- **具体问题**：按 ECharts 语义该配置为鼠标移动（无需按住）即可平移数据窗口，与文案矛盾；且与 `trigger: 'axis'` 十字准线 tooltip 的悬停读值交互叠加
- **造成影响**：若生效，用户悬停查看数值时视图会随光标平移，读值与平移互相干扰。需实际渲染验证
- **问题等级**：中危

#### M20. 四组件标题栏 / 信息架构无统一模式
- **问题位置**：`AnalysisPanel.vue` L132-142（`.page-head`：eyebrow + h2 22px + 描述 + 动作按钮）；`WorkspaceAnalysis.vue` L202-214（`.analysis-header`：strong 14px + span 10px + 三个圆形图标按钮）；`PidPanel.vue` L1233-1238（`.step-card` / `.step-header` / `.step-number`：数字圆圈 + 标题 + tag）；`AiPanel.vue`（无页面标题，仅侧栏 `.section-header` 11px 大写 tertiary）
- **具体问题**：同为下工作区 Tab 面板，四种不同的头部结构、字号层级与动作区位置
- **造成影响**：用户在 Tab 间切换时视觉模型不连续，应用无统一「面板标题栏」规范
- **问题等级**：中危

#### M21. phase-tag / engine-note 等 fallback 色对比度严重不足
- **问题位置**：`PidPanel.vue` L2027-2034（`.phase-tag.phase-pi`：`#f5a623` on `rgba(245,166,35,.15)` 混合底）、L1978-1982（`.engine-note`：`#f5a623` on 白底）、L2023-2026（`.phase-tag.phase-p`：`#e5484d` on 12% 同色底 ≈ 3.0:1）
- **具体问题**：`#f5a623` on 白底实算 ≈ **2.03:1**，为 11px 粗体文本，远低于 AA
- **造成影响**：调参阶段徽章（P/PI/PID）与引擎提示是流程关键信息，可读性最差
- **问题等级**：中危

#### M22. AiPanel 对话无 markdown 渲染，代码 / 数据非等宽字体
- **问题位置**：`AiPanel.vue` L402-404（气泡内直接 `{{ msg.content }}`）、L647-654（`.message-bubble` 无 `font-family: var(--font-family-mono)`；对照 PidPanel `.ai-result pre` L1885-1893 与 WorkspaceAnalysis `.feature-table` L353 均使用 mono）
- **具体问题**：LLM 返回 markdown（代码块、表格、加粗）时以原始符号呈现；参数 / 日志片段用比例字体
- **造成影响**：AI 分析串口数据的核心输出可读性差，与 PidPanel 的 AI 结果展示标准不一致
- **问题等级**：中危

#### M23. 自动调参与多步骤流程缺少进度指示组件
- **问题位置**：`PidPanel.vue` L224（`autoTuneRound` 仅在 script 中赋值 / 清零，模板从未渲染）；L1329（进度仅以 `.status-badge` 一行 11px mono 药丸展示 `autoTuneStatus` 文本）；L147-152（步骤编号为静态 `.step-number` 圆圈，无「已完成 / 进行中」状态样式）；全文件无 `el-steps` / `el-progress`
- **具体问题**：12 轮自动调参运行期间，轮次进度只有文本徽章；三步骤流程无步骤条，步骤完成态不可视
- **造成影响**：「调参进度 / 阶段视觉突出」核心诉求未满足，长时间运行时用户无法感知阶段推进
- **问题等级**：中危

#### M24. PID 参数校验错误展示位置远离出错字段
- **问题位置**：`PidPanel.vue` L1132-1144（`sendParams` 的数字 / 边界校验写入 `error.value`）；唯一 `.error-msg` 渲染点在**步骤 2 卡片**（L1513），而 PID 输入框位于**步骤 3 卡片**（L1572-1620）
- **具体问题**：错误渲染点与输入控件分属不同步骤卡片
- **造成影响**：用户正关注步骤 3 的输入框时，错误出现在其视口上方另一卡片内，可能被滚动位置遮挡
- **问题等级**：中危

#### M25. I/D 模式开关的 CSS 类未定义样式
- **问题位置**：`PidPanel.vue` L1560-1570（模板使用 `.pid-mode-switches` / `.pid-mode-switch` + 原生 `<input type="checkbox">` + 裸文本 "I"/"D"）；style 段经全文检索**不存在**相关规则
- **具体问题**：该控件将以浏览器默认复选框外观渲染（需实际渲染验证）；仅靠 `:title` 悬停提示说明含义
- **造成影响**：步骤 3 头部的模式切换器视觉上未完成，与整体设计语言脱节
- **问题等级**：中危

### 低危（美观优化，31 项）

#### L1. 硬编码尺寸 / 字号普遍绕过 token（合并 1.5 / S3 / S4 / C3 / C4 / A5 部分）
- **问题位置**：`App.vue`（`.app-version` 10px L384、`.lower-tabs` 36px/12px/4px L519-521、button 5px/13px L530-531、`.workspace-resizer span` 56px/3px/圆角 3px L497-501、`.header-right` gap 6px L434、`font-weight: 600` L379 已有 `--weight-semibold`）；`SerialPanel.vue` L235（内联 `width: 100%`）；`DataMonitor.vue` L406（内联 `width: 80px` 编码下拉）；`StatusBar.vue` L79（`.hex-toggle` 圆角 2px，同栏 `.theme-toggle` 用 4px）；`ChartPanel.vue` L326/L290（内联样式）、L432（10px）；`WorkspaceChart.vue` L340-356（padding 10px、字号 11px/10px/9px、gap 4px/3px/5px 全硬编码）；`AiPanel.vue` L499/L539/L552/L602 与 `WorkspaceAnalysis.vue` L344/350-351/361/365-366（10px 档位约 10+ 处，用于正文级文本）
- **造成影响**：token 体系被架空的范围扩大；header 左内边距 16px 与 lower-tabs 12px 使垂直堆叠的 chrome 层左缘错位 4px；10px 中文正文在 1366px 屏幕低于可读下限
- **问题等级**：低危

#### L2. 表单未用 el-form、label 规格不一、区块图标颜色无规律（合并 S1 / S2 / A3）
- **问题位置**：`SerialPanel.vue` L136-289（`.field` 结构）、L342-352（label 11px tertiary、`margin-bottom: 2px` 小于最小间距档 4px）、L133/L182/L256（三个相邻区块图标分别取 primary 蓝 / secondary 灰 / ai 绿）；`PidPanel.vue` L1807-1810（label 11px tertiary）；`WorkspaceAnalysis.vue` L361（10px secondary）；`AnalysisPanel.vue` L241（12px secondary）；`AiPanel.vue` L516-523（11px secondary）；全项目无一处 `el-form`
- **造成影响**：label 尺寸（10/11/12px）与颜色在同一产品内不统一；同类设置分组着色不同，视觉规则不可推导
- **问题等级**：低危

#### L3. 图标尺寸 12/13/14px 混用（合并 1.5 部分 / S13 / C8）
- **问题位置**：`SerialPanel.vue` L133/L182/L256（14）；`DataMonitor.vue` L310/L314（13）与 L324/L333/L337/L344（12）；`StatusBar.vue` L46（13）；`ChannelPanel.vue` L36（12）；`App.vue` L207/L270（14/13）；`ChartPanel.vue` L258/L310/L314（显式 13）；`WorkspaceChart.vue` L295/L320/L321（未设 size，继承按钮 font-size：channel-button 11px、export-button 10px）；通道色点 8px vs 7px
- **造成影响**：跨组件图标大小节奏不齐，部分图标实际渲染小于 12px
- **问题等级**：低危

#### L4. v-model 直接改写 props 成员，绕过单向数据流（合并 S25 / A21）
- **问题位置**：`SerialPanel.vue` L262（`v-model="props.aiConfig.model"`）、L275/L279/L283/L287；`AiPanel.vue` L330/L334、L409-411
- **造成影响**：数据流不可追踪，重构为 props 拷贝时会静默失效
- **问题等级**：低危

#### L5. 声明字体实际不可用 + 输入框等宽字体策略不自洽（合并 2.5 / 2.6）
- **问题位置**：`style.css` L8-9（`'Inter'`、`'JetBrains Mono'`，index.html 无 webfont 引入、无 `@font-face`，Windows 实际回退 Segoe UI / Microsoft YaHei / Consolas）；L272-276（`.el-input__inner` 全局强制 mono 13px，含 API Key / Base URL 等非串口场景；`.el-textarea__inner` 仅 L252-257 处理背景未设字体）
- **造成影响**：设计体系声明的字体与实际渲染字体不一致；单行与多行输入字体体系割裂
- **问题等级**：低危

#### L6. 标签页视觉层级与状态区分不足（合并 2.4 / 3.4 / S7）
- **问题位置**：`style.css` L11-13（token 仅 11/13/14 三档，无 16px+ 标题级字号）；`App.vue` L536（`.lower-tabs button` 用体系最小字号 11px）、L540-544（hover 与 active 共用同一声明块，已核对确认；active 无字重 / 背景差异，AI 标签 hover 变主色蓝、active 变 AI 绿）、L546-549；`DataMonitor.vue` L445-452（`.sub-tabs` 高 32px / `--text-sm`，与 `.lower-tabs` 高 36px / `--text-xs` 参数不一致）
- **造成影响**：鼠标扫过未选中标签呈现与选中态一致的外观，无法定位当前标签页；信息层级全靠颜色单维度承载；嵌套标签栏层级感模糊
- **问题等级**：低危

#### L7. App.vue 死代码：约 40 行未使用的 tab 样式
- **问题位置**：`App.vue` scoped style L392-396（`.header-tabs`）、L403-429（`.tab-item` 及 hover/active/ai 变体）
- **具体问题**：模板中已无任何元素挂载这两个类（现行 tab 实现为 `.lower-tabs button`），但完整样式仍保留；死代码中的 `transition: all 150ms ease`、active 态 `font-weight: 500` 恰是现行 tab 所缺失的
- **造成影响**：两套 tab 样式并存易改错目标
- **问题等级**：低危

#### L8. window-dot 内联样式绕过体系 + 误导性 affordance
- **问题位置**：`App.vue` 模板 L216-218（`style="background: var(--state-error);"` 等三条内联样式）；CSS `.window-dot` L437-442、`.header-right` L431-435
- **具体问题**：三个装饰圆点用内联 style 区分颜色而非 modifier class；`gap: 6px`、12px 尺寸、`opacity: 0.8` 均硬编码；三个圆点形似窗口控制按钮但无任何点击行为
- **造成影响**：样式无法通过 class 统一覆写；构成误导性 affordance（需实际渲染验证）
- **问题等级**：低危

#### L9. `.sidebar` 的 `overflow-x: visible` 声明无效
- **问题位置**：`App.vue` `.sidebar` L455-456
- **具体问题**：CSS 规范规定当一轴为非 visible 值时，另一轴的 `visible` 被计算为 `auto`
- **造成影响**：侧栏内容超宽时出现横向滚动条而非溢出展示。需实际渲染验证具体触发场景
- **问题等级**：低危

#### L10. EP border/fill 层级映射与命名梯度倒置
- **问题位置**：`style.css` L147-150、L153-156（light）；L184-187、L190-193（dark 同构）
- **具体问题**：EP 语义上 `extra-light < lighter < light`（逐级变浅），但映射为 light=`#e4e7ed`（较浅）/ lighter=`#dcdfe6`（较深），fill 同理
- **造成影响**：依赖「lighter 应更浅」假设的 EP 内部样式拿到更深的边框 / 填充，跨组件浅色层次不一致。需实际渲染验证
- **问题等级**：低危

#### L11. el-switch 全局染绿与色彩语义冲突
- **问题位置**：`style.css` L341-344（`.el-switch.is-checked .el-switch__core { background-color: var(--color-ai); }` 全局覆盖）
- **具体问题**：所有打开态开关统一染成 AI 绿（覆盖 EP 默认主色蓝），而体系中绿色被明确定义为 AI 身份色
- **造成影响**：非 AI 语境的开关（如 HEX 显示切换）开启态也是绿色，绿色同时承载「AI 身份」与「开关开启」两种语义
- **问题等级**：低危

#### L12. Tab ARIA 语义缺失 + 焦点样式覆盖不统一（合并 3.7 / C17）
- **问题位置**：`App.vue` L263-273（`<nav class="lower-tabs">` + 原生 button，无 `role="tablist"/"tab"/"tabpanel"`、无 `aria-selected`）；全局层无任何 `:focus-visible` 定制（已 grep 验证，仅 PidPanel 内部 5 处局部实现）；`ChartPanel.vue` L460（`.range-inputs input { outline: none }` 且无 `:focus` 替代样式）vs `WorkspaceChart.vue` L351（保留原生 outline）
- **造成影响**：屏幕阅读器用户获得的信息结构不完整；键盘用户无法感知焦点位置（WCAG 2.4.7）；全局控件与 PidPanel 自定义按钮焦点表现不一致
- **问题等级**：低危

#### L13. 面板切换与按钮 hover 均无过渡，无 reduced-motion 适配
- **问题位置**：`App.vue` L276/L299/L310（三个面板 `v-show` 硬切换，未包裹 `<Transition>`）、L527-538（`.lower-tabs button` 无 transition）；全项目未检索到 `prefers-reduced-motion`
- **造成影响**：切换观感生硬，与 body 主题切换 0.2s 过渡（style.css L223）的节奏不统一
- **问题等级**：低危

#### L14. 拖拽过程缺少拖拽态反馈 + 每次 pointermove 查询 DOM
- **问题位置**：`App.vue` `resizeWorkspace` L133-140（每次 pointermove 执行 `document.querySelector('.content-area')` + `getBoundingClientRect()`）
- **具体问题**：拖拽中没有为 resizer/body 添加 active 类或全局 cursor 样式；同时每帧执行查询与布局读取
- **造成影响**：拖拽手感反馈不足；高频强制样式重算在低配机器上有掉帧风险
- **问题等级**：低危

#### L15. 持久化的分隔位置加载时不做范围校验
- **问题位置**：`App.vue` L13（`Number(localStorage.getItem('workspace_top_percent')) || 52`）
- **具体问题**：拖拽时 clamp 到 28–72（L139），但启动读取存储值时不 clamp
- **造成影响**：异常存储值导致上下区域比例严重失衡，直到用户手动拖拽一次才纠正
- **问题等级**：低危

#### L16. `100vw/100vh` 使用与 header 文本无截断策略
- **问题位置**：`App.vue` `.app-container` L342-343（`height: 100vh; width: 100vw`）；`.header-context` L398-401（无 `white-space`/`min-width`/`text-overflow` 控制）
- **造成影响**：极窄窗口下提示文本可能换行并撑破 40px 固定高度的 header。需实际渲染验证
- **问题等级**：低危

#### L17. 连接状态视觉突出度不足
- **问题位置**：`SerialPanel.vue` L245-248、L411-416（`.status-dot` 6px）；`StatusBar.vue` L98-102（`.status-dot` 6px）
- **具体问题**：连接 / 断开仅由 6px 圆点颜色区分，断开态与普通禁用文字同用三级灰
- **造成影响**：连接状态是串口工具的首要状态，在 28px 高状态栏、11px 文字环境中辨识度低
- **问题等级**：低危

#### L18. 表格列无最小宽度 + 状态栏文字无截断保护（合并 S12 / S30）
- **问题位置**：`DataMonitor.vue` L377-392（9 列表格）与 L584-613（th/td 无 min-width）；`StatusBar.vue` L104-107（`.status-text` 无 max-width/text-overflow）、L48-50（Rx/Tx 计数同样无省略）
- **造成影响**：窄分栏下需横向滚动才能看到 I5–I7 通道数据；极窄窗口下左侧文案可能与中部「UTF-8」区重叠（需实际渲染验证）
- **问题等级**：低危

#### L19. 通道面板底部色点为纯装饰
- **问题位置**：`ChannelPanel.vue` L45-49、L125-134（`.panel-footer` 内 8 个 `.dot`）
- **具体问题**：底部 8 个色点与上方通道行颜色一一重复，无文字说明、无交互
- **造成影响**：零信息增量的装饰占据面板底部空间
- **问题等级**：低危

#### L20. 仅图标的刷新按钮无提示、无加载态
- **问题位置**：`SerialPanel.vue` L192（`<el-button :icon="Refresh" size="small" :disabled="connected" @click="refreshPorts" />`）
- **造成影响**：图标含义无提示可依；枚举端口慢时无反馈
- **问题等级**：低危

#### L21. 发送失败提示淹没在数据流中
- **问题位置**：`DataMonitor.vue` L137-139（catch 中 unshift `type:'error'` 行，时间戳占位 `'--:--:--'`）
- **造成影响**：错误行被后续高频数据顶走，失败易被忽略
- **问题等级**：低危

#### L22. 永久禁用的「数据接口」下拉无解释
- **问题位置**：`SerialPanel.vue` L169-174（`<el-select size="small" disabled>` 无 v-model、无 tooltip）
- **造成影响**：用户不理解禁用原因及未来是否有 TCP/蓝牙等选项
- **问题等级**：低危

#### L23. Y 轴手动范围校验静默 + WorkspaceChart 每击键全量刷新（合并 C18）
- **问题位置**：`ChartPanel.vue` L86-91（`isNaN` 静默忽略）；`WorkspaceChart.vue` L117-122（`Number.isFinite` 静默忽略）+ L273（`watch([normalizeDrawing, yAuto, yMin, yMax], () => refreshChart())`，每输入事件即触发）
- **造成影响**：min≥max 或非数字输入被静默丢弃，无输入框错误态；触发时机不一致
- **问题等级**：低危

#### L24. 导出与清空均无结果反馈，空数据可导出（合并 C19 / C12 部分）
- **问题位置**：`ChartPanel.vue` L173-212、`WorkspaceChart.vue` L209-241（exportData 静默触发下载）；两文件均未调用 ECharts `showLoading`；两处导出按钮在零数据时不置禁用（`ChartPanel.vue` L504-507、`WorkspaceChart.vue` L352）
- **造成影响**：用户无法确认导出是否发生；空数据仍会导出仅含表头的 CSV 文件；连接等待期界面无动态反馈
- **问题等级**：低危

#### L25. xRange 输入未做值域钳制反馈
- **问题位置**：`ChartPanel.vue` L290（`min="10" max="200"` 为 HTML 属性，`v-model.number` 可键入任意值）+ L130（`Math.min(xRange.value, maxPoints)` 静默钳制）
- **造成影响**：键入 500 时窗口实际仍按 200 生效，输入框显示值与实际行为不符
- **问题等级**：低危

#### L26. 长表单折叠用原生 details + 文本符号指示符
- **问题位置**：`PidPanel.vue` L1333-1442（三处原生 `<details class="collapse-section">`）、L1727-1736（折叠箭头为 CSS `content: '▶'`）、L1437-1438（调参顺序按钮用 `↑`/`↓` 文本）
- **具体问题**：以原生 details + 自绘样式替代 EP 折叠面板，指示符 / 排序按钮用文本符号而非 EP 图标
- **造成影响**：图标语言在同一面板内混用两套
- **问题等级**：低危

#### L27. 指标卡片数值字体 / 单位规则跨组件不一致（合并 A12 / A13）
- **问题位置**：`PidPanel.vue` L2242-2247（`.metric-strip strong` mono、无字号定义）；`WorkspaceAnalysis.vue` L365（`.metric strong`：`font: 600 14px var(--font-family-mono)`）；`AnalysisPanel.vue` L252-253（20px，**无 mono**）；单位规则：`PidPanel.vue` L1517（`riseTime ?? '--'` 渲染为 `--s`）、L1518（`settlingTime ?? '未收敛'` 无单位后缀）、L1519（rmse 无单位）
- **造成影响**：数字对齐性与专业感不一致；单位缺失 / 错位（`--s`）造成误读
- **问题等级**：低危

#### L28. AI 解释错误以内联正文呈现，无错误态无重试
- **问题位置**：`WorkspaceAnalysis.vue` L161-162（`aiExplanation = 'AI解释不可用：…'` 渲染于 L307 `.ai-text`）；`AnalysisPanel.vue` L106 同构
- **具体问题**：错误文本与正常解释使用同一容器样式
- **造成影响**：失败与成功输出不可区分（与 H3 同根因，严重度较低）
- **问题等级**：低危

#### L29. 两处「导出报告」按钮 disabled 策略不一致
- **问题位置**：`AnalysisPanel.vue` L140（无 `:disabled`，L113-115 点击后才 `ElMessage.warning`）；对照 `WorkspaceAnalysis.vue` L212（`:disabled="!responseEnabled"`）
- **造成影响**：同一操作在两个组件中一个前置禁用、一个事后 toast
- **问题等级**：低危

#### L30. 阶跃幅值初始值为字符串，与 el-input-number 类型约定不符
- **问题位置**：`PidPanel.vue` L170（`amplitude: '100'` 字符串）、L1465（`el-input-number v-model="stepConfig.amplitude"`）；消费端均做 `Number(...)` 转换
- **造成影响**：潜在显示 / 步进行为异常。需实际渲染验证
- **问题等级**：低危

#### L31. WorkspaceAnalysis 特征表在 1024px 下必然横向滚动（信息性，素材定性为可接受取舍）
- **问题位置**：`WorkspaceAnalysis.vue` L352-355（`.feature-table { min-width: 820px }` + `.feature-table-wrap { overflow-x: auto }` + sticky 首列）
- **造成影响**：溢出处理本身正确（滚动 + 冻结首列），但主要统计列需滚动才能看到；属可接受的取舍
- **问题等级**：低危

---

## 第三部分：分优先级修改计划

### 高优先级（立即改，8 项）

#### 1. 接通串口错误反馈链路
- **修改内容**：实现 `App.vue` 的 `onError`，以 `ElMessage.error` 全局提示；`SerialPanel` 五处 emit 统一传 `e.message` 字符串
- **涉及文件**：`src\renderer\src\App.vue`、`src\renderer\src\components\SerialPanel.vue`
- **修改思路**：当前 `onError`（L169-171）为空函数。补齐实现：

```js
// App.vue（已核对：onError 当前仅有注释占位）
import { ElMessage } from 'element-plus'

function onError(msg) {
  ElMessage.error(typeof msg === 'string' ? msg : (msg?.message || '串口操作失败'), { duration: 4000 })
}
```

```js
// SerialPanel.vue L87：统一消息形态，与其他四处 e.message || '…' 的写法对齐
catch (e) {
  emit('error', e.message || '打开串口失败')
}
```

- **预期收益**：串口打开 / 关闭 / 刷新 / DTR/RTS 失败不再静默，核心链路故障可诊断（解决 H1）

#### 2. PidPanel 成功 / 失败消息分离
- **修改内容**：新增 `success` ref，成功类文案不再写入 `error`；渲染独立的绿色提示（或改用 `ElMessage.success` 一次性提示）
- **涉及文件**：`src\renderer\src\components\PidPanel.vue`
- **修改思路**：L1162 / L1181 / L1188 三处成功类文案改写 `success.value`；L1513 渲染点旁新增成功分支：

```vue
<!-- PidPanel.vue：替换 L1513 单一渲染点 -->
<div v-if="error" class="error-msg">{{ error }}</div>
<div v-if="success" class="success-msg">{{ success }}</div>
```

```css
/* PidPanel.vue：与 .error-msg（L1860-1868）对称，使用已定义的语义 token */
.success-msg {
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: var(--color-ai-subtle);
  border: 1px solid var(--color-ai-muted);
  border-radius: var(--radius-sm);
  color: var(--state-success);
  font-size: var(--text-xs);
}
```

- **预期收益**：参数下发成败语义恢复正确，消除红框误判（解决 H2）

#### 3. AiPanel 请求健壮性：超时 + 取消 + 失败独立样式 + 重试
- **修改内容**：`callAi` 增加 AbortController 超时（60s）；loading 期间提供「停止」按钮可取消；失败消息使用独立红色边框变体类；最后一条失败消息附「重试」按钮
- **涉及文件**：`src\renderer\src\components\AiPanel.vue`
- **修改思路**：基于已核对的 L123-150 改造：

```js
// AiPanel.vue
let abortController = null

async function callAi(customMessages) {
  saveConfig()
  loading.value = true
  abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 60000)
  try {
    const baseUrl = String(props.aiConfig.baseUrl || '').replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.aiConfig.apiKey}`
      },
      body: JSON.stringify({ model: props.aiConfig.model, messages: customMessages, stream: false }),
      signal: abortController.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return data.choices?.[0]?.message?.content || '（无返回内容）'
  } finally {
    clearTimeout(timer)
    loading.value = false
    abortController = null
  }
}
```

```js
// sendMessage（L152-163）：让错误以 isError 标记入列，而非与正常回复同构
try {
  const reply = await callAi(msgs)
  messages.value.push({ role: 'assistant', content: reply })
} catch (e) {
  messages.value.push({ role: 'assistant', content: `请求失败：${e.message}`, isError: true })
}
```

```vue
<!-- 气泡渲染：失败消息加变体类；loading 时保留一个可点的「停止」按钮 -->
<div v-for="msg in messages" class="message-bubble"
     :class="[msg.role, { 'message-error': msg.isError }]">
  {{ msg.content }}
</div>
```

```css
/* AiPanel.vue：失败消息独立样式（对照 .message-bubble.assistant 绿色左边框 L661-666） */
.message-bubble.message-error {
  border-left: 2px solid var(--state-error);
  background: var(--message-alt-bg);
}
```

- **预期收益**：网络异常时对话可取消、可重试、错误可辨识（解决 H3）

#### 4. DataMonitor 消息上限与稳定 key
- **修改内容**：`messages` 增加 `MAX_MESSAGES = 5000` 截断（渲染层保护，不涉业务逻辑）；为每条消息分配自增 `id` 作为 key
- **涉及文件**：`src\renderer\src\components\DataMonitor.vue`
- **修改思路**：基于已核对的 L199-219 改造：

```js
// DataMonitor.vue
const MAX_MESSAGES = 5000
let messageId = 0

function onSerialData(payload) {
  const { t, ms } = formatTime(payload)
  messages.value.unshift({
    id: ++messageId,
    type: 'receive',
    text: props.showHex ? payload.hex : payload.raw,
    time: t,
    ms
  })
  if (messages.value.length > MAX_MESSAGES) {
    messages.value.length = MAX_MESSAGES // unshift 在头部，截尾部即最旧数据
  }
  // ……其余逻辑保持不变（tableRows 已有 MAX_TABLE_ROWS=1000 保护）
}
```

```vue
<!-- L357-362：key 从数组索引改为稳定 id -->
<div v-for="msg in messages" :key="msg.id" :class="['msg-row', msg.type]">
```

- **预期收益**：长时间运行不再产生数万 DOM 节点，滚动与跟随恢复流畅（解决 H4）

#### 5. tertiary 色值修正（对调 + 补浅色档）
- **修改内容**：浅色 `--color-text-tertiary` 由 `#8b949e` 改为 `#57606a`（或最小改动对调为 `#6e7681`），暗色由 `#6e7681` 改为 `#8b949e`
- **涉及文件**：`src\renderer\src\style.css`（L48、L93）
- **修改思路**：两个现值疑似对调（`#8b949e` 是 Primer 暗色主题次级灰、`#6e7681` 为其浅色对应档）。对调后实算：暗色 `#8b949e` on `#0d1117` ≈ **6.15:1**、on `#161b22` ≈ **5.62:1**，全部达标；浅色若仅对调（`#6e7681`）白底 ≈ 4.59:1 达标但 sidebar 背景 `#f5f7fa` 上 ≈ 4.3:1 仍不足，故浅色建议直接取 Primer 浅色 tertiary 档 `#57606a`（on `#ffffff` ≈ 6.4:1、on `#f5f7fa` ≈ 6.0:1、on `#ebeef5` ≈ 5.5:1，三种背景全达标）：

```css
/* style.css */
:root {
  --color-text-tertiary: #57606a; /* 原 #8b949e（Primer 暗色次级灰，误用于浅色） */
}
:root.dark {
  --color-text-tertiary: #8b949e; /* 原 #6e7681（Primer 浅色对应档，误用于暗色） */
}
```

- **预期收益**：一行级改动全局生效，全部 10 个组件的标签 / 时间戳 / 状态文字 / placeholder / 轴标签恢复 AA 达标（解决 H5 的色值根因；图表组件内硬编码的轴标签色见中优先级第 5 项）

#### 6. 未定义 CSS 变量修复
- **修改内容**：`style.css` 补 `--radius-full: 999px`、`--space-8: 32px`；PidPanel 的 `--color-warning/danger/success` 全部替换为已定义的 `--state-warning/error/success`
- **涉及文件**：`src\renderer\src\style.css`、`src\renderer\src\components\PidPanel.vue`
- **修改思路**：

```css
/* style.css 共享 token 区（L20-22 圆角档位后追加） */
:root {
  --radius-full: 999px;
  --space-8: 32px;
}
```

```css
/* PidPanel.vue L1981/L2026/L2030/L2034/L2064/L2301/L2306/L2314-2315：
   逐一替换变量名（去掉 fallback，落到主题 token） */
/* var(--color-warning, #f5a623)  →  var(--state-warning) */
/* var(--color-danger, #e5484d)   →  var(--state-error)   */
/* var(--color-success, #00a870)  →  var(--state-success) */
```

- **预期收益**：版本徽章恢复胶囊形、空状态恢复预期间距、phase-tag 等随主题正确取色（解决 M5）

#### 7. 危险操作二次确认
- **修改内容**：清空数据流 / 数据表、清空录制、清空波形统一包 `ElMessageBox.confirm`；回放前关闭串口改为**事前**确认
- **涉及文件**：`src\renderer\src\components\DataMonitor.vue`、`src\renderer\src\components\WorkspaceChart.vue`、`src\renderer\src\App.vue`
- **修改思路**：以已核对的 `DataMonitor.clear()`（L177-180）为例，其余清空入口同构：

```js
import { ElMessageBox } from 'element-plus'

async function clear() {
  try {
    await ElMessageBox.confirm('将清空数据流与数据表的全部记录，且不可恢复。', '清空数据', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  messages.value = []
  tableRows.value = []
}
```

`replayRecording`（DataMonitor L234-255）在 `serial.close()` **之前**插入确认（「回放将自动关闭当前串口连接，是否继续？」）；PidPanel 已有的 confirm 模式（L1170-1184）可直接复用。
- **预期收益**：误触不可逆操作得到拦截，硬件通信不再被静默中断（解决 M3）

#### 8. 两处文案 / 分类错误修复
- **修改内容**：StatusBar 换行符文案改用 `v-pre` 输出 `\n` 字面量；DataMonitor 为 system 消息增加独立分支（`Sy:` 前缀 + 中性色）
- **涉及文件**：`src\renderer\src\components\StatusBar.vue`、`src\renderer\src\components\DataMonitor.vue`
- **修改思路**：

```vue
<!-- StatusBar.vue L41：v-pre 阻止转义歧义，输出 "\n" 而非 "\\n" -->
<span class="mono" v-pre>\n</span>
```

```js
// DataMonitor.vue L364：三元表达式增加 system 分支
const prefix = msg.type === 'send' ? 'Tx:'
  : msg.type === 'receive' ? 'Rx:'
  : msg.type === 'system' ? 'Sy:'
  : 'Er:'
```

```css
/* DataMonitor.vue：system 行使用中性色，不套 .direction.error 的 --state-error */
.direction.system { color: var(--color-text-secondary); }
```

- **预期收益**：消除「系统通知被标红」「显示 \\n」两处信息失真（解决 M9）

### 中优先级（迭代改，10 项）

#### 1. 原生按钮统一状态体系
- **修改内容**：新增全局 `.btn-base` 基类（或逐步迁移为 `el-button size="small"`），为全部原生按钮类补 `:hover`/`:active`/`:disabled`
- **涉及文件**：`src\renderer\src\style.css`、`DataMonitor.vue`、`SerialPanel.vue`、`StatusBar.vue`、`WorkspaceChart.vue`、`ChartPanel.vue`
- **修改思路**：

```css
/* style.css 全局追加：覆盖素材中列出的全部原生按钮类 */
.rec-btn, .btn-primary, .btn-secondary, .btn-auto,
.small-btn, .hex-toggle, .sub-tab, .eye-icon,
.channel-button, .auto-button, .export-button, .clear-button {
  transition: background-color 150ms ease, border-color 150ms ease,
              color 150ms ease, opacity 150ms ease;
}
.btn-primary:hover, .channel-button:hover { background: var(--color-primary-hover); }
.btn-secondary:hover, .auto-button:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-border-active);
}
.rec-btn:active, .btn-primary:active { transform: translateY(0.5px); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
```

- **预期收益**：高频操作恢复悬停 / 按下反馈，原生按钮与 EP 按钮行为一致（解决 M2 的状态缺失部分）

#### 2. 死组件处置
- **修改内容**：删除 `ChannelPanel.vue`、`ChartPanel.vue`、`AnalysisPanel.vue`，或明确收敛计划（保留哪个实现、何时删除）
- **涉及文件**：`src\renderer\src\components\ChannelPanel.vue`、`ChartPanel.vue`、`AnalysisPanel.vue`
- **修改思路**：三组件均未被 import；建议直接删除——`ChartPanel` 内两处高危潜在缺陷（通道越界 C11、resize 泄漏 C16）随删除消除；若暂不删除，至少在文件头注明「未挂载，勿在此基础上迭代」并修复 C11/C16
- **预期收益**：消除双轨漂移源，避免后续改错目标（解决 M1）

#### 3. 暗色主题 FOUC + color-scheme
- **修改内容**：`index.html` 内联预置主题脚本（首帧前应用 `.dark` 类）；`:root.dark` 声明 `color-scheme: dark`
- **涉及文件**：`src\renderer\index.html`、`src\renderer\src\style.css`
- **修改思路**：

```html
<!-- index.html <head> 内、任何 module 脚本之前（key 与 main.js 持久化所用的同一 localStorage 键保持一致） -->
<script>
  try {
    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.classList.add('dark')
    }
  } catch (e) { /* localStorage 不可用时按浅色渲染 */ }
</script>
```

```css
/* style.css */
:root.dark {
  color-scheme: dark; /* 原生滚动条/表单控件随暗色渲染 */
}
```

- **预期收益**：暗色用户启动不再闪白；侧栏原生滚动条与深色背景一致（解决 M11）

#### 4. EP 浅色主题主色档位补齐
- **修改内容**：`style.css` light 块补 `--el-color-primary-light-5/7/8/9`
- **涉及文件**：`src\renderer\src\style.css`
- **修改思路**：按 EP「与白色按比例混合」的档位规则，基于 `#0969da` 计算建议值（对照 `#409eff` 默认档位的生成方式）：

```css
/* style.css light 块（L127-157 区域）追加：
   light-N = #0969da 与白色按 (N/10) 比例混合的近似值 */
:root {
  --el-color-primary-light-5: #84b4ed;
  --el-color-primary-light-7: #b5d2f4;
  --el-color-primary-light-8: #cee1f8;
  --el-color-primary-light-9: #e6f0fb;
}
/* dark 块建议同步补 light-8（两主题均缺） */
```

- **预期收益**：消除「两种蓝」，EP 组件浅色态与全局主色同色系（解决 M7；具体受影响组件需实际渲染验证）

#### 5. 图表可读性
- **修改内容**：axisLabel 字号 10→11（或 12）且颜色随主题正确取值；9px 操作提示提至 11px；修正 `moveOnMouseMove` 与文案矛盾
- **涉及文件**：`src\renderer\src\components\WorkspaceChart.vue`、`ChartPanel.vue`（若保留）
- **修改思路**：

```js
// WorkspaceChart.vue L115/L147、ChartPanel.vue L83/L106：
// 色值与第 5 项高优先级修正一致（浅色取 Primer 浅色档、暗色取次级灰），字号提到 11
axisLabel: { color: isDark ? '#8b949e' : '#57606a', fontSize: 11 }
```

```css
/* WorkspaceChart.vue L354：9px → 11px（token 最小档） */
.chart-header span { font-size: var(--text-xs); }
```

```js
// WorkspaceChart.vue L133-141：二选一——删除 moveOnMouseMove: true（保持「按住拖动」语义），
// 或改文案为「鼠标移动平移X轴」；推荐前者（保留 axis tooltip 悬停读值体验）
```

- **预期收益**：轴刻度与操作指引在 1366px 屏可读，悬停读值不再与平移冲突（解决 M16、M19，收尾 H5 轴标签部分）

#### 6. 图表空状态设计
- **修改内容**：图表画布区无数据时显示引导文案（FireWater 格式说明）
- **涉及文件**：`src\renderer\src\components\WorkspaceChart.vue`
- **修改思路**：用 ECharts title 实现（不引依赖、不加 DOM）：

```js
// WorkspaceChart.vue getChartOption 内
title: {
  show: seriesData.every((s) => s.data.length === 0),
  text: '等待串口数据…',
  subtext: '发送 FireWater 格式数据（如 ch1:1.23,ch2:4.56）即可绘制波形',
  left: 'center',
  top: 'middle',
  textStyle: { color: themeTextColor, fontSize: 13 },
  subtextStyle: { color: themeTextColor, fontSize: 11 }
}
```

- **预期收益**：新用户首屏不再面对空白坐标轴（解决 M18）

#### 7. 自动滚动暂停反馈 + HEX 控件语义区分
- **修改内容**：DataMonitor 暂停跟随时显示「已暂停 · 回到最新」按钮；状态栏 HEX 更名（如「HEX 显示」）或加 tooltip 区分收 / 发
- **涉及文件**：`src\renderer\src\components\DataMonitor.vue`、`StatusBar.vue`
- **修改思路**：利用现有 `autoScroll`（`scrollTop <= 5` 判定）反推暂停态，在消息区顶部叠一个按钮：

```vue
<!-- DataMonitor.vue 消息容器内：!autoScroll 时显示 -->
<transition name="fade">
  <button v-if="!autoScroll" class="resume-follow" @click="scrollToTop">
    已暂停跟随 · 回到最新
  </button>
</transition>
```

StatusBar L32 的 hex-toggle 增加原生 `title="切换接收数据的 HEX 显示（仅影响查看，不影响发送编码）"`；DataMonitor 发送区 HEX 控件统一保留下拉、移除冗余按钮（或按钮改文案「以 HEX 发送」）
- **预期收益**：滚动暂停可感知、可一键恢复；「看 HEX」与「发 HEX」不再混淆（解决 M12、M13）

#### 8. PidPanel 调参进度可视化
- **修改内容**：渲染已存在但未使用的 `autoTuneRound`（「第 X/12 轮」徽章或 `el-progress`）；步骤卡增加完成态样式
- **涉及文件**：`src\renderer\src\components\PidPanel.vue`
- **修改思路**：

```vue
<!-- L1329 status-badge 旁：轮次进度 -->
<el-tag v-if="autoTuneRound > 0" size="small" type="info">
  第 {{ autoTuneRound }}/12 轮
</el-tag>
```

```css
/* 步骤完成态：为 .step-number 圆圈增加完成变体（配合 script 中已有的流程状态） */
.step-number.done {
  background: var(--color-ai-muted);
  color: var(--state-success);
  border-color: var(--state-success);
}
```

- **预期收益**：12 轮自动调参的推进过程可视，长时间运行有阶段感知（解决 M23）

#### 9. 1024px 布局修复
- **修改内容**：main 进程 BrowserWindow 设 `minWidth: 1024`；PidPanel 左栏 380px 改可收缩；断点统一为一组约定值
- **涉及文件**：`src\main\index.js`、`src\renderer\src\components\PidPanel.vue`、`src\renderer\src\style.css`、`App.vue`、`AnalysisPanel.vue`（断点取值统一）
- **修改思路**：已核对 BrowserWindow（L9-21）当前仅设 width/height：

```js
// src/main/index.js
mainWindow = new BrowserWindow({
  width: 1280,
  height: 800,
  minWidth: 1024,   // 与适配下限一致，杜绝更窄窗口进入未适配区间
  minHeight: 680,
  // ……其余配置保持不变
})
```

```css
/* PidPanel.vue L1662：允许收缩而非固定 380px */
.pid-left { flex: 0 1 380px; min-width: 320px; }
```

断点统一：媒体查询不支持 CSS 变量，故在 `style.css` 头部以注释形式约定常量档位（如 **720 / 960 / 1100** 三档：720 单列堆叠、960 双栏收窄、1100 data-split 折叠），各组件 `@media` 取值统一到这三档（现状 720/900/960/1100/1180 五档收敛为三档）；有条件时进一步迁移到容器查询，使断点响应内容区实际宽度而非视口宽度
- **预期收益**：1024px 下不再出现字段裁切、面板 146px 高、通道按钮折行等问题（解决 M4）

#### 10. AiPanel 气泡可读性 + 对话自动滚动
- **修改内容**：不引新依赖前提下，气泡内容 `pre-wrap` + 代码 / 日志等宽变体类；补对话自动滚动
- **涉及文件**：`src\renderer\src\components\AiPanel.vue`
- **修改思路**：

```css
/* AiPanel.vue：markdown 原始符号呈现的折中处理（不引 markdown 依赖） */
.message-bubble {
  white-space: pre-wrap;   /* 保留 LLM 输出的换行与缩进 */
  word-break: break-word;
}
.message-bubble.mono {
  font-family: var(--font-family-mono); /* 需要等宽的片段用变体类标记 */
  font-size: var(--text-xs);
}
```

```js
// 对话自动滚动（对照 DataMonitor 的 scrollToTop 模式）
import { nextTick, ref, watch } from 'vue'

const chatListRef = ref(null)
watch(() => messages.value.length, async () => {
  await nextTick()
  const el = chatListRef.value
  if (el) el.scrollTop = el.scrollHeight
})
```

```vue
<!-- L392：<div class="chat-list" ref="chatListRef"> -->
```

- **预期收益**：AI 输出的换行 / 缩进 / 等宽片段可读，新回复自动进入视野（解决 M22、M12 的 AiPanel 部分）

### 低优先级（有空再改，8 项）

#### 1. 硬编码尺寸 token 化
- **修改内容**：`App.vue`（10px 字号 L384、36px/12px/5px/13px L519-531、56px/3px L497-501、6px L434、`font-weight: 600` L379）、`WorkspaceChart.vue`（L340-356 的 padding/margin/字号/gap 全套硬编码）、`StatusBar.vue` L79 圆角 2px、`DataMonitor.vue` L406 内联 80px——逐项映射到最近的 token 档位或补充 token（如 `--icon-sm: 12px`、`--icon-md: 14px`）
- **涉及文件**：`App.vue`、`WorkspaceChart.vue`、`StatusBar.vue`、`DataMonitor.vue`、`style.css`
- **修改思路**：优先消灭内联样式与体系外档位（2px/3px/5px/6px/9px/10px/36px/56px），无法映射的值在 token 区补档
- **预期收益**：token 体系恢复单一事实来源（收尾 L1、L3）

#### 2. App.vue 死代码 tab 样式删除
- **修改内容**：删除 L392-396（`.header-tabs`）与 L403-429（`.tab-item` 及变体）约 40 行未使用样式
- **涉及文件**：`src\renderer\src\App.vue`
- **修改思路**：删除前将死代码中的 `transition: all 150ms ease` 与 active 态 `font-weight: 500` 迁移到现行 `.lower-tabs button`（正是 L6/L13 所缺）
- **预期收益**：消除双套 tab 样式，顺手补齐过渡与选中字重

#### 3. 可访问性补齐
- **修改内容**：分隔条加 `role="separator"` / `tabindex="0"` / 方向键步进；lower-tabs 加 `tablist` 语义；全局 `:focus-visible` 样式
- **涉及文件**：`App.vue`、`style.css`
- **修改思路**：

```html
<!-- App.vue L254-260 -->
<div class="workspace-resizer" role="separator" aria-orientation="horizontal"
     aria-label="调整波形区与工作区高度" tabindex="0"
     @pointerdown="beginResize"
     @keydown.arrow-up.prevent="resizeBy(2)"
     @keydown.arrow-down.prevent="resizeBy(-2)" />
```

```html
<!-- App.vue L263-273 -->
<nav class="lower-tabs" role="tablist">
  <button role="tab" :aria-selected="activeTab === 'data'" ...>数据</button>
</nav>
```

```css
/* style.css 全局（对照 PidPanel 内部已有的 5 处局部实现） */
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
```

- **预期收益**：键盘用户可操作分隔条与标签页，焦点表现全局统一（解决 M10、L12）

#### 4. 图标尺寸统一
- **修改内容**：定义 `--icon-sm: 12px`、`--icon-md: 14px` 两档，全部 `el-icon` 的 size 与继承字号的裸图标收敛到两档
- **涉及文件**：`style.css`、`SerialPanel.vue`、`DataMonitor.vue`、`StatusBar.vue`、`ChannelPanel.vue`、`App.vue`、`WorkspaceChart.vue`
- **修改思路**：现状 12/13/14 混用且 WorkspaceChart 有 11px/10px 继承值，统一为 12（内联小按钮）/ 14（区块标题）两档
- **预期收益**：跨组件图标节奏一致

#### 5. 表格列 min-width + 状态栏文字截断
- **修改内容**：DataMonitor 9 列表格为 th/td 设 `min-width`（时间列约 90px、数值列约 64px）；StatusBar `.status-text` 加省略
- **涉及文件**：`DataMonitor.vue`、`StatusBar.vue`
- **修改思路**：

```css
/* DataMonitor.vue */
th, td { min-width: 64px; white-space: nowrap; }
/* StatusBar.vue */
.status-text {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- **预期收益**：窄分栏下关键列不被挤压，状态栏不重叠（解决 L18、L16 的截断部分）

#### 6. el-switch 染绿回退主色
- **修改内容**：删除 style.css L341-344 的全局 `--color-ai` 覆盖，开关恢复 EP 主色蓝；确有 AI 语境的开关用局部类（如 `.ai-context .el-switch.is-checked …`）染绿
- **涉及文件**：`src\renderer\src\style.css`
- **修改思路**：绿色让位给「AI 身份」单一语义，全局开关回归主操作色
- **预期收益**：色彩语义不再冲突（解决 L11）

#### 7. 切换过渡
- **修改内容**：`.lower-tabs button` 加 150ms transition；主题 / 面板过渡尊重 `prefers-reduced-motion`
- **涉及文件**：`App.vue`、`style.css`
- **修改思路**：

```css
.lower-tabs button {
  transition: color 150ms ease, border-bottom-color 150ms ease;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

- **预期收益**：标签切换与 hover 色变不再生硬跳变（解决 L13）

#### 8. 字体声明与回退链修正
- **修改内容**：二选一——打包引入 Inter / JetBrains Mono（或改用系统字体栈），或保留回退但更新注释说明实际按 Segoe UI / Microsoft YaHei / Consolas 渲染；同时收敛 `.el-input__inner` 的全局 mono 策略（仅串口 / 命令类输入用 mono，自然语言 / URL 输入用界面字体）
- **涉及文件**：`src\renderer\src\style.css`
- **修改思路**：声明与实际渲染一致优先于引入新依赖；mono 策略用局部类（如 `.input-mono .el-input__inner`）替代全局覆盖
- **预期收益**：字体体系声明可信，输入场景字体选择自洽（解决 L5）

---

## 附：统计与对照说明

- **问题条目**：高危 5 项（H1–H5）、中危 25 项（M1–M25）、低危 31 项（L1–L31），合计 61 项；均由四份审查素材的 100 余条原始问题按「跨组件同类合并」原则归并而来，原始行号与类名证据完整保留于各条目。
- **修改计划**：高优先级 8 项、中优先级 10 项、低优先级 8 项，合计 26 项；高优先级 8 项对应全部 5 个高危项及 3 个影响面最大的中危项（M3 / M5 / M9）。
- **对比度数据**：全部按 WCAG 相对亮度公式实算；「需实际渲染验证」标注的结论（共 20 处）未经运行时确认，修复前建议先行验证。
- **正面确认**（无需修改，供参考）：PidPanel 危险操作确认完备（串口下发 / 自动下发 / 自动调参三处 confirm）、仿真运行按钮状态切换规范、WorkspaceAnalysis 头部按钮 disabled + tooltip 配合良好、WorkspaceChart 的 ResizeObserver 实现正确、分隔条有 title 提示与 pointer capture、图标全部来自 `@element-plus/icons-vue` 无 emoji 混用。
