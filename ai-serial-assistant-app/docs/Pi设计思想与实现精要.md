# Pi 设计思想与实现精要：一份写给"自己做 Agent"的借鉴笔记

> 这份文档是给你做另一个 Agent 项目参考用的。它不教怎么用 Pi，而是把 Pi **为什么要这么设计、以及具体怎么落地**一条条拆出来，标出哪些是你做自己的 Agent 时可以借鉴的"内功"。所有内容都对照 Pi 的真实源码（`packages/` 下三个核心包）。

---

## 一、一句话看懂 Pi 的设计哲学

Pi 的设计哲学可以用一句大白话概括：

> **内核只管"最小核心"，其余能力全靠扩展，别让框架反过来规定你的工作流。**

这具体体现在 `packages/coding-agent` README 的 Philosophy 一节里，它连用一串"**不做**"来表明态度：

- `No MCP` —— 不内置 MCP（模型上下文协议），想要就自己用扩展加
- `No sub-agents` —— 不内置子代理，想要就开几个 tmux / 自己写扩展
- `No permission popups` —— 不做权限弹窗，想要就放到容器里 / 自己实现确认流程
- `No plan mode` —— 不做计划模式，要计划就写进文件
- `No built-in to-dos` —— 不内置待办清单（作者认为待办反而会"带偏"模型），用 `TODO.md` 文件
- `No background bash` —— 不做后台命令，用 tmux（可观测、可交互）

**借鉴点**：不要一开始什么都 built-in。先搞清楚你的 Agent 的**最小内核**是什么，把其余变成可插拔。这也是为什么 Pi 能既"极简"又被无数人定制。

---

## 二、整体分层：三个包、三层职责

Pi 是 monorepo，职责切分非常干净，这是它最大的架构优点：

| 包 | 职责 | 一句话 |
|----|------|--------|
| `packages/ai` | **与大模型对话** | 统一抹平几十家提供商的差异，只管"说话/监听" |
| `packages/agent` | **核心大脑** | Agent 循环、状态、事件、工具执行、会话/压缩 |
| `packages/coding-agent` | **命令行肉体** | 系统提示词、内置工具、插件、CLI/TUI 入口 |

三层之间是**单向依赖**：`ai` 最底层，`agent` 依赖 `ai`，`coding-agent` 依赖前两者。

**借鉴点**：把"**对话层（model/LLM）**""**推理层（loop/state）**""**能力层（tools/UX）**"拆成三层，哪怕不做成三个包，也要在代码里做好边界。这样换模型、换 UI、换工具都不会互相牵连。

---

## 三、最核心的设计：Agent Loop（智能体循环）

这是整个 Pi 的灵魂，也是你做 Agent 第一个要照抄的设计。它在 [`packages/agent/src/agent-loop.ts`](file:///d:/HUST/Study/Computer/Pi_agent/pi/packages/agent/src/agent-loop.ts#L155-L275)。

### 3.1 循环结构：两层 while

```
外层 while (true)：处理"追加的消息"（follow-up）
  内层 while (hasMoreToolCalls || 有中途插入消息)：
    调模型 → 拿到回复
      有 toolCall？→ 执行工具 → 结果喂回 → hasMoreToolCalls = true（继续内层）
      没有？→ hasMoreToolCalls = false（跳出内层）
    内层结束 → 看有没有 follow-up 消息，有则外层继续
```

**关键决策**：用"模型是否要调工具（`stopReason === "toolUse"`）"作为**继续循环的条件**。模型说"我要用工具" → 循环就继续；模型说"我说完了"（`stopReason === "stop"`）→ 结束。

### 3.2 一次回合（turn）的完整流程

`streamAssistantResponse` 负责一次模型调用：

1. 可选 `transformContext` 修剪消息（省 token）
2. `convertToLlm` 把内部消息翻译成模型能懂的格式
3. 调用模型（鉴权、流式）
4. 流式接收，逐块发 `message_update` 事件
5. 结束后，判断 `stopReason`：
   - `toolUse` → 接下来的 `executeToolCalls` 会执行工具
   - `length` → 输出超长，此时工具参数可能不完整，**干脆全部作废不执行**（见 `failToolCallsFromTruncatedMessage`，很好的一次防御性设计）
   - `stop` / `error` → 收尾

**借鉴点**：
- 用 `stopReason` 驱动循环，而不是自己猜
- 工具调用遇到"输出被截断"就**宁可不执行**，把错误喂回给模型让它重发——比执行残缺参数安全得多

### 3.3 工具执行：并行 vs 串行

模型一次可能请求调多个工具。Pi 支持两种策略（`packages/agent` README）：

- `parallel`（默认）：先逐个"预检"（校验 + beforeToolCall 拦截），再把允许执行的**并发**跑，更快
- `sequential`：一个接一个，适合有先后依赖的

注意它有个"**一致性开关**"：只要批里有一个工具标记为串行（`executionMode: "sequential"`），**整批都退化成串行**。避免模型拿并行结果又依赖先后顺序出 bug。

**借鉴点**：并行一时爽，但依赖关系会让结果出错。给"单体要求串行"留一个"整批降级"的开关，是稳妥的做法。

### 3.4 中断式轮询：Steering / Follow-up

Pi 不是傻等模型跑完。你在**模型工作途中**可以随时插入消息，靠的是两个队列（`agent.ts` 里的 `PendingMessageQueue`）：

- **steer（纠偏）**：`steer()` 消息会在当前回合工具执行完后、下一个回合前注入
- **followUp（追加）**：`followUp()` 只在 Agent 快要整体结束时才注入，作为"收尾加任务"

循环里的 `getSteeringMessages()` / `getFollowUpMessages()` 每次回合后都会**轮询**这些队列。

**借鉴点**：真实用户不会按部就班地一条条发。给长任务设计一个"途中可打断"的队列机制，是贴近真实使用的关键。Pi 用"两阶段队列 + 每回合轮询"优雅地解决了"一边跑一边改主意"。

---

## 四、状态管理：可变状态 + 事件驱动

`Agent` 类（[`agent.ts`](file:///d:/HUST/Study/Computer/Pi_agent/pi/packages/agent/src/agent.ts)）是循环的"外壳"，它管理：

- **`state`**：一个可变状态对象，持有 `systemPrompt`、`model`、`thinkingLevel`、`tools`、`messages`、`isStreaming`、`streamingMessage`、`pendingToolCalls`、`errorMessage`
- **事件订阅**：`subscribe()` 注册监听器，`processEvents` 里根据事件类型更新内部状态，再广播给所有监听器

事件类型一大套：`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。

**借鉴点**：**"循环只管派发事件，状态和 UI 各自订阅"** 是缓存解耦的好模式。你的 Agent 想让同时有人脸界面 / 命令行 / 日志 / 统计时，这套"事件发布订阅"能一次解决，不用到处写回调嵌套。

---

## 五、消息模型：内部消息 ≠ 模型消息

Pi 最漂亮的一个抽象：**Agent 内部用的 `AgentMessage` 和模型能理解的 `Message` 是两种东西**，中间用 `convertToLlm` 翻译。

- 内部：可以是 `user` / `assistant` / `toolResult`，还能任意扩展自定义类型（如 UI 通知）
- 模型只认三种：`user` / `assistant` / `toolResult`

消息流（见 `packages/agent` README）：

```
AgentMessage[] →transformContext??→ AgentMessage[] →convertToLlm→ Message[] → 大模型
```

`convertToLlm` 的职责：**过滤掉模型不该看到的（如 UI 消息），把自定义类型转成模型格式**。`transformContext` 的职责：**压缩/剪枝旧消息**。

**借鉴点**：别把"你内部想要的消息"和"模型该看到的消息"画等号。中间加一层翻译，会让你以后能往里塞任意辅助消息（通知、状态、日志）而不污染对话，这是扩展性的关键。

---

## 六、会话与持久化：JSONL + 树状分支

会话存储设计得很聪明（`packages/agent/src/harness/session/`）：

- **格式**：每行一条 JSON（JSONL），方便追加、断点续读
- **结构**：每条记录有 `id` 和 `parentId`，天然形成**树** → 支持"分支"（那一刻分叉成新路线，不用复制整份文件）

对应 CLI：`/tree`（在会话树上跳转）、`/fork`（从某个点分叉新会话）、`/resume`（恢复历史）。

**借鉴点**：用 `parentId` 存成树而不是"一条直线数组"，你的会话就能免费获得"回退到某个历史点重试"的能力。JSONL 比整份 JSON 更适合频繁追加和增量保存。

---

## 七、上下文压缩（Compaction）：记忆的"取舍"

长会话必然撞上上下文窗口上限。Pi 的压缩设计（`packages/agent/src/harness/compaction/`）：

- **自动触发**：接近上限时主动压缩；超出上限时先恢复再压缩
- **手动**：`/compact [自定义指令]`
- **有损但可逆**：把旧历史总结成摘要（压缩有损，但**完整历史仍在 JSONL 里**，可 `/tree` 回去）
- **独立请求**：压缩摘要的生成用独立的 LLM 请求，并刻意**关掉缓存**（`cacheRetention: "none"` + 新 `sessionId`），因为摘要是一次性的、不复用缓存
- **保留尾部**：最近的 `retainedTail` 消息不压缩，原样保留（因为最近的往往最关键）

**实现亮点**（`extractFileOperations`）：压缩时它会**追踪历史里读了哪些文件、改了哪些文件**，把这些"文件级信息"存到压缩条目上。这样即使对话被压缩，关键的文件操作记录仍在，后续能复用。

**借鉴点**：
- 压缩要"有损但留底"——摘要给模型看，完整历史留给自己
- 保留最近一段不压
- 压缩请求别污染正常对话的缓存
- 连"读/改过哪些文件"这种细节都值得在压缩时留下来

---

## 八、系统提示词：动态拼装

`buildSystemPrompt`（`packages/coding-agent/src/core/system-prompt.ts`）不是写死的字符串，而是**按需拼装**：

1. 基础身份（"你是编程助手，会读文件、跑命令……"）
2. **只列当前启用的工具** + 一句 snippet
3. 行为准则（按"有哪些工具"动态加对应准则）
4. **项目上下文**：把 `AGENTS.md` 拼进来（<project_instructions> 包裹）
5. Skills 列表（如果开了 read 工具）
6. 当前工作目录

**借鉴点**：系统提示词应该**动态生成**，而不是写死。工具变了、项目变了、加了技能，提示词就跟着变。用 `<project_instructions>` 这种 XML 风格标签包裹上下文，模型容易区分"这是项目的规则"。

> 注意：`packages/agent/src/harness/system-prompt.ts` 里还有个更精简的 `formatSkillsForSystemPrompt`，用的也是 `<available_skills><skill>` 这种结构化块。Pi 很喜欢用显式标签结构化地塞给模型信息，这个习惯值得学。

---

## 九、可扩展机制：让能力"长出来"

Pi 的极简哲学落地的关键。四层扩展能力：

| 机制 | 本质 | 谁来"长" |
|------|------|---------|
| **Skills（技能）** | `SKILL.md` 一段 Markdown 操作手册 | 模型按需加载照着做 |
| **Prompt Templates** | 可复用的提示词模板 `/name` 展开 | 用户方便，`{{变量}}` 填充 |
| **Extensions（扩展）** | 真正的 TS 代码，注册工具/命令/事件/UI | 开发者真正加新能力 |
| **Packages（包）** | 打包分享上面这些 | 社区共享 / npm 安装 |

**借鉴点**：把"教模型怎么做某件事"（Skills 的 `SKILL.md`）和"给模型真工具"（Extensions）分开，是很清晰的边界。前者用户就能写（不需要会编程），后者才需要代码。

> 安全提醒：Pi README 多次强调——**包/扩展有系统完全访问权限**，要审源码再装。你的 Agent 引入第三方能力时，这条红线也要坚守。

---

## 十、工具系统：四要素 + 校验 + 错误协议

工具定义四要素（`packages/agent` README）：`name`、`description`、`parameters`（TypeBox schema，可校验）、`execute`。

三个高质量设计细节：

1. **参数校验**：`validateToolCall` 用 TypeBox 校验模型传的参数，校验失败**作为错误喂回给模型**让它重试，而不是直接炸
2. **错误协议**：工具内部**抛异常**（不返回错误文本当作正常结果）。循环捕获后标记 `isError: true` 喂回模型，模型看到错误自己改

**借鉴点**：
- `description` / `parameters` 写清楚，因为模型只看得到这些字符串来决定"什么时候用、怎么传参"
- 永远用"**抛异常 + 标记 isError + 喂回模型**"的方式处理工具失败，让错误成为对话的一部分，模型才能真正自治

---

## 十一、抽象层：模型提供商统一（pi-ai）

`packages/ai` 做的核心事：**把几十家 LLM 提供商的差异抹平成一套接口**。

- **Provider（提供商）**：持有自己的模型目录 + 鉴权 + API 实现，用 `createProvider()` 组装
- **Model**：纯数据（无函数），可序列化
- **统一调用**：`models.stream(model, context)` / `models.complete(...)`
- **跨提供商切换**：同一对话中途换模型，消息自动转换（别人的 thinking 块转成 `<thinking>` 文本），上下文保留

**借鉴点**：
- **Model 是纯数据**这点很妙——模型可以序列化、可转移，做"历史会话用的哪个模型"就是 JSON.stringify 一下
- 抽象层统一"鉴权 + 调用 + 错误"，业务层完全无感

---

## 十二、鉴权设计

每个 Provider **自带鉴权**，支持多种来源（`packages/ai`）：

- 动态解析顺序：**显式传入 > 存储的凭据 > 环境变量**，显式永远赢
- `CredentialStore`：一个基于"序列化的读-改-写"的凭据仓库，写入用了锁，**避免并发/多进程把旋转中的 OAuth token 刷两次**
- OAuth：自动登录、自动刷新过期 token；刷新也放在同一把锁里

**借鉴点**：把"缓存里可能有旧 token"和"刷新"放在同一个可串行化的写路径里，是避免权限竞态的成熟做法。多个请求/进程并发时不会互相踩。

---

## 十三、韧性设计：状态回放与恢复（进阶）

在 `packages/agent/src/harness/reducer.ts` 里，Pi 对会话持久化做了一个**相当硬核**的设计：用**"记录日志 + 车道路（lane）"**的方式，把会话的每一步操作以`OperationStartedRecord`、`StepAttemptRecord`、`ToolStartedRecord`、`WriteDeferredRecord` 等**类型化记录**写进日志。恢复时按这些记录**重放**，还专门校验"未完结的操作、不连续的重试、重复的工具调用"等反常状态，遇到就当**损坏**拒绝，而不是瞎修。

（我只能剧透这么多——这套"单写入者记录协议"很深，做严肃 Agent 时才需要。你可以把它当成"用了某种『事件溯源』来保证崩溃后能安全续聊"的范例。）

**借鉴点**：如果你的 Agent 要"长命"（跑很久、要能断点恢复），别只存最新状态，**把"发生了什么"以记录的形式存下来，恢复时重放**。并且要对"坏状态"抱"拒绝而非修补"的保守态度。

---

## 十四、安全与信任（面向真实部署）

- **默认无权限限制**：Pi 本身不自带沙箱，按启动它的进程权限跑——**需要隔离时放进容器**（`containerization.md` 给了 Gondolin / Docker / OpenShell 三种模式）
- **Project Trust（项目信任）**：加载项目本地设置、脚本、扩展前，先问"是否信任这个项目文件夹"，信任决策存在 `trust.json`。非交互模式用 `defaultProjectTrust`（`ask`/`always`/`never`）兜底

**借鉴点**：做一个会**执行代码/改文件**的 Agent，默认就是要"能不受限跑"，但绝不能没有边界意识。用"信任分级 + 可落地容器隔离"的机制，比"全自动但裸奔"稳妥。

---

## 十五、网络与节流（小但实用）

如果你把 Agent 做成后台服务，`packages/ai` 里这些很值得抄：

- **重试**：`retry` / `provider-retry`，带退避策略
- **Abort（中止）**：用 `AbortSignal` 取消在途请求；被中止的消息 `stopReason: "aborted"`，**可以加回上下文继续聊**（不丢进度）
- **溢出防护**：`estimate` / `context-overflow` 估算 token、防上下文爆炸
- **懒加载**：API 实现用 lazy wrapper，第一次用某个提供商才加载它的 SDK —— 减小启动负担和包体积

**借鉴点**：流式 + 可中止 + 可续传 + 带退避的重试，是"在线 Agent"的标配。宁可多写这几层，也不要在生产里裸奔。

---

## 十六、给你自己的 Agent 的"借鉴清单"

如果只带 10 条回去，是哪 10 条？

1. **核心循环**：用"模型 `stopReason === 'toolUse'` ? 执行工具继续 : 结束"驱动一个两层循环（3.1）
2. **停止条件外置**：循环里留一个 `shouldStopAfterTurn` 钩子，让上层能按需"提前停"（`agent.ts`）
3. **消息中间翻译层**（`convertToLlm`）：内部消息和模型消息解耦，留扩展余地（5）
4. **事件发布订阅**：循环事件驱动，UI/日志/统计各自订阅（4）
5. **四要素工具 + 校验 + 抛异常错误协议**（10）
6. **系统提示词动态拼装** + 结构化 `<project_instructions>` 标签（8）
7. **JSONL + parentId 树状会话**，天然支持分支（6）
8. **压缩**：有损留底、保留尾部、压缩请求独立且不污染缓存（7）
9. **Steering / Follow-up 队列**：途中断言、收尾加任务的轮询机制（3.4）
10. **Provider 抽象 + Model 纯数据 + 统一鉴权**（11、12）

**以及三条"方向"上的忠告**：
- 先定**最小内核**，别急着 built-in 一堆功能（1）
- 把"教模型"（Skills）和"给真工具"（Extensions）分层（9）
- 会执行代码的 Agent，**信任分级 + 容器隔离**这条安全底线别省（14）

---

## 结语

Pi 的精髓不是一个炫酷功能，而是一组**克制的架构决策**：极简内核、事件驱动、消息层解耦、可插拔扩展、有损但留底的上下文管理、统一的模型抽象。它的"内涵"都在这些朴实无华的抽象上——这也是它能被无数人拿去自己改的成本来源。

希望这份笔记能让你的 Agent 项目少走些弯路。学有余力，去读 [`agent-loop.ts`](file:///d:/HUST/Study/Computer/Pi_agent/pi/packages/agent/src/agent-loop.ts#L155-L275) 这一个文件，胜过翻十篇博客。