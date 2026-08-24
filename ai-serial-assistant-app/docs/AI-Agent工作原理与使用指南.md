# 从 Pi 项目看懂 AI-Agent：工作原理与日常使用指南

> 这份文档是给你（大一新生，想学 AI-Agent 又想日常用起来）准备的。我们以开源项目 **Pi** 为例，把"AI 编程助手到底是怎么运转的"拆开讲清楚。讲完原理，再回到你日常怎么用好这类工具。

---

## 一、先搞清楚：到底什么是"AI-Agent"？

先思考一下：你平时用的 ChatGPT 和"会自己改代码的 AI"，差别在哪？

普通聊天 AI 是**一问一答**：你提问，它回答，结束。它没有手，也没有脚，只能"说"。

而 AI-Agent（智能体）不一样。它多了一样最关键的东西——**工具（Tools）**。它不仅能"说"，还能"做"：

- 读文件（`read`）
- 写文件（`write`）
- 改文件（`edit`）
- 运行命令（`bash`）

有了工具，它就能**自己动手完成一整件任务**，而不仅仅是回答一个问题。你只需要说一句"帮我把这个项目的测试跑一遍"，它会自己去读代码、找测试文件、运行命令、看结果、发现错误、再改代码……一步步把任务做完。

这个"我动脑 → 我动手 → 看到结果 → 再动脑 → 再动手"的循环，就是 Agent 的核心。学习 Pi 这个项目，就是学习这个循环被工程师们怎么落地成代码的。

---

## 二、Pi 项目全景：三个包，各司其职

Pi 是一个 monorepo（一个仓库装多个包）。要理解 Agent，只需把握三个核心包：

| 包名 | 中文理解 | 它负责什么 |
|------|---------|-----------|
| `packages/ai` | "大脑的嘴" | 统一对接所有大模型（OpenAI、Anthropic、Google…），负责"跟模型说话"和"听模型回答" |
| `packages/agent` | "大脑本身" | Agent 的核心运行时：跑循环、调工具、管状态 |
| `packages/coding-agent` | "身体和手脚" | 把它包装成你在终端里用的命令行工具，提供读文件、跑命令这些实际动作 |

可以这样理解：**ai 包负责"说话"，agent 包负责"思考"，coding-agent 包负责"动手"**。

我们学习时，重点放在中间的 `agent` 包，因为它是 Agent 的"灵魂"。

> 注意：下面讲的原理，不止 Pi 一家在用。Claude Code、Cursor、你用的各种编程助手，底层几乎都是同一套"循环 + 工具"的架构。学会 Pi，一通百通。

---

## 三、项目架构与导读：一份源码地图

> 想靠读代码加深理解，最忌"一头扎进去乱翻"。这一节先给你一份**地图**：代码放在哪、每个文件是干嘛的、按什么顺序读最顺。读完这里，你打开项目就知道该往哪看。

### 3.1 仓库长什么样：先看目录

打开 Pi 仓库根目录，你会看到这样的结构（我们关心的是 `packages/` 下的三个核心包）：

```
pi/
├── packages/
│   ├── ai/            ← 统一的大模型接口层（"大脑的嘴"）
│   │   ├── src/
│   │   │   ├── providers/  每个提供商一个文件（openai.ts、anthropic.ts…）
│   │   │   ├── api/        不同厂商的 API 协议实现
│   │   │   ├── auth/       鉴权（API Key、OAuth）
│   │   │   ├── models.ts  模型注册、查找
│   │   │   └── types.ts    核心类型定义
│   │   └── test/           每个文件的测试
│   │
│   ├── agent/         ← Agent 核心运行时（"大脑本身"）★重点
│   │   ├── src/
│   │   │   ├── agent-loop.ts   核心循环（最值得读！）
│   │   │   ├── agent.ts        封装循环的 Agent 类
│   │   │   ├── types.ts        所有类型定义
│   │   │   ├── stream-fn.ts    流式调用的桥
│   │   │   └── harness/        更高层封装（系统提示词、技能、会话、压缩…）
│   │   └── test/
│   │
│   └── coding-agent/  ← 命令行工具本体（"身体和手脚"）
│       ├── src/
│       │   ├── core/
│       │   │   ├── system-prompt.ts  拼装系统提示词
│       │   │   ├── tools/            内置工具（read/bash/edit/write…）
│       │   │   ├── skills.ts         技能加载
│       │   │   ├── compaction/       上下文压缩
│       │   │   ├── agent-session.ts  会话管理
│       │   │   └── extensions/       插件机制
│       │   └── cli/                  命令行入口
│       └── docs/       使用文档（值得翻一翻）
```

> 注意：`packages/agent/src/harness/` 里还有一套**更完整的 Agent 实现**（包含系统提示词、压缩、会话等），而 `agent.ts` / `agent-loop.ts` 是**最底层的循环**。理解原理，从底层的 `agent-loop.ts` 入手最干净；coding-agent 实际用的是 harness 那套。

### 3.2 推荐阅读顺序：由点到面

别按目录顺序读，按下面这条"从骨到肉"的路径走，每步都能踩在前一步上：

| 步骤 | 读什么 | 能搞懂什么 |
|------|--------|-----------|
| ① | `packages/agent/src/types.ts` | 先看类型，知道"上下文、消息、事件、工具"各自长什么样（地基） |
| ② | `packages/agent/src/agent-loop.ts` | 核心循环：模型怎么说话、工具怎么被调用、怎么反复循环（骨架） |
| ③ | `packages/agent/src/agent.ts` | 循环外面那层封装：状态管理、事件订阅、消息队列（血肉） |
| ④ | `packages/ai/src/types.ts` + `providers/` | 模型、消息、工具结果是啥样，一家提供商怎么被注册进来（大脑的嘴） |
| ⑤ | `packages/coding-agent/src/core/tools/` | 真正"动手"的内置工具长什么样（手脚） |
| ⑥ | `packages/coding-agent/src/core/system-prompt.ts` | 系统提示词怎么从零拼出来（给模型的"剧本"） |
| ⑦ | `packages/agent/src/harness/` | 完整版 Agent 的进阶玩法：压缩、技能、会话（进阶） |

### 3.3 每个关键文件怎么读：对照着看

读源码时，**对照着文档前面讲的概念看**，效果最好。这里给出每个核心文件的"阅读锚点"：

**`packages/agent/src/agent-loop.ts`（最重要，反复读）**
- 找 `runLoop` 函数：看它怎么用 `while(true)` + `while(hasMoreToolCalls)` 两层循环把"调模型、执行工具"串起来
- 找 `streamAssistantResponse`：看模型回复是怎么被 stream 出来、怎么判断 `stopReason`、怎么发现 `toolCall`
- 找 `executeToolCalls`：看工具怎么被校验参数、执行、把结果喂回上下文
- 找 `prepareToolCall`：看 `beforeToolCall`（执行前拦截）和参数校验

**`packages/agent/src/agent.ts`（状态与事件）**
- 找 `prompt()` 和 `continue()`：看一次处理怎么开始
- 找 `processEvents`：看各种事件怎么更新内部状态
- 找 `PendingMessageQueue`：看 `steer`（中途纠偏）和 `followUp`（追加任务）的消息队列怎么工作

**`packages/ai/src/providers/openai.ts`（选一家看）**
- 看一个 provider 是怎么用 `createProvider()` 组装起来的：模型目录 + 鉴权 + API 实现
- 感受"换一家提供商，只是换一个 provider 文件"的扩展方式

**`packages/coding-agent/src/core/tools/read.ts`（选一个工具看）**
- 对照第 6 节，看真实工具的 `name` / `description` / `parameters` / `execute` 四要素长什么样

**`packages/coding-agent/src/core/system-prompt.ts`**
- 找 `buildSystemPrompt`：看系统提示词是怎么被"拼"出来的，对照第 9 节

### 3.4 读源码的小技巧

- **先读 `types.ts`**：类型定义是"说明书"，先看类型往往比先看函数更省力
- **跟着测试读**：`test/` 目录里每个测试文件都对应一段特定行为（如 `agent-loop.test.ts`），先看测试"期望什么行为"，再看实现，理解更快
- **善用跳转**：看到 `import` 就跳过去看那个类型/函数，边读边把依赖关系串起来
- **别一次读完**：先读 `agent-loop.ts` 这一个文件读懂 80%，其他文件按需回头查

> 提醒：啃代码时卡住是正常的。遇到不懂的节点，回到文档前面找对应的概念解释，或者直接往下看测试，往往就豁然开朗了。

### 3.5 补个底子：`.ts` 是什么？读代码必会的基础语法

先思考一下：为什么 Pi 的源码文件都叫 `xxx.ts`，而不是 `xxx.js`？

`.ts` 是 **TypeScript** 的缩写，你可以把它理解成"**带类型的 JavaScript**"。它和 JavaScript（`.js`）几乎一模一样，只是额外加了一层**类型标注**——在代码里标明"这个变量是字符串""这个函数的参数是数字"。浏览器和 Node 其实跑不了 TypeScript，但编译器会把它先"翻译"回 JavaScript 再运行。

那为什么要多此一举？好处是：**在代码写错之前，编译器就能帮你发现错误**。比如你把一个数字传给了本应接收字符串的函数，它会在编译时就报错，而不是等到运行时才炸。对读代码的人更是福音——**类型本身就是在"说话"**，告诉你看这个函数要传什么、返回什么。

> 注意：你没学过 TypeScript 也没关系。读 Pi 时你只需要认得出类型标注，剩下的语法和 JavaScript 没区别。下面挑最常碰到的几个讲。

#### 3.5.1 类型标注：`变量名: 类型`

最常见的形式是冒号后面写类型。这是你会在 Pi 里一遍遍看到的东西：

```typescript
const name: string = "pi";        // 字符串
const count: number = 42;         // 数字
const isReady: boolean = false;   // 布尔值 true/false
```

函数的参数和返回值也这么标：

```typescript
function add(a: number, b: number): number {
  //     ↑参数类型          ↑返回类型
  return a + b;
}
```

读的时候，那个冒号后的词就是"类型"，不用细究实现也能大概猜到该传什么。

#### 3.5.2 `interface` 和 `type`：描述"一个东西长什么样"

这是 Pi 里最最常见的。它们用来定义一个"对象"的结构：

```typescript
interface AgentTool {
  name: string;        // 必须有 name，是字符串
  description: string; // 必须有 description，是字符串
  execute: Function;   // 必须有一个可执行的函数
}
```

读完这段，你就知道"一个工具长什么样"了。`type` 和 `interface` 作用几乎一样，可以当成换了个写法。**读代码时，看到 `interface X` 就是在看"X 类型的对象有哪些字段"**。

#### 3.5.3 泛型：`身份证<T>` 这种尖括号

你会频繁看到类似 `AgentTool<any>`、`Array<number>` 的写法。尖括号里的东西叫**泛型（Generic）**，意思是"我不知道具体类型，但你可以填进来"。

```typescript
interface AgentTool<T> {
  // T 是一个"占位符"，用法由使用方决定
  execute: (params: T) => void;
}
```

读的时候，`<T>` 就当成"这个工具的参数类型是 T，具体是什么别处说了算"。`any` 是"随便什么类型都行"（通常是不推荐的做法）。你不需要会写泛型，**只要会认"这里有个占位类型"就够**。

#### 3.5.4 `?` 问号和 `|` 竖线：可选 & 联合

这两个符号在 Pi 里出现频率极高，务必认识：

```typescript
function f(x?: string) {
  //   ↑ 问号 = 这个参数"可有可无"
}

let value: string | null;
//          ↑ 竖线 = "联合类型"，value 要么是 string，要么是 null
```

- `?` 表示**可选**：传不传都行
- `|` 表示**联合**：可以是左边这种，也可以是右边那种

比如 `signal?: AbortSignal` 就是"signal 这个参数可选，类型是 AbortSignal"。看到 `A | B` 就记住"它可能是 A，也可能是 B"。

#### 3.5.5 `=>` 箭头函数：简写的函数

Pi 里函数大多用箭头函数写法，别被它吓到：

```typescript
// 普通写法
function add(a: number, b: number) { return a + b; }

// 箭头函数（等价）
const add = (a: number, b: number) => a + b;
```

看到 `const 名字 = (...) => something`，就是在定义一个函数。`=>` 左边是参数，右边是返回值。函数传给函数、`async`、`await` 这些概念，和 JavaScript 完全一样。

#### 3.5.6 `import` / `export`：模块的"进出口"

Pi 拆成很多文件，靠这两个关键字串联：

```typescript
import { Agent } from "./agent.ts";   // 从别的文件"拿"东西进来
export interface AgentTool { ... }     // 把东西"分享"给别的文件
```

读代码时看到 `import`，就可以跳到对应文件去查那个东西的定义——这正是 3.4 里说的"善用跳转"。

---

## 四、Agent 的核心：那个神奇的"循环"

这是全篇最重要的一节。请你先思考一个问题：**"AI 怎么知道该读文件还是该跑命令？"**

答案在 `packages/agent/src/agent-loop.ts` 里。它把整个处理过程写成了一个两层循环。我把它翻译成人话：

```
你（用户）说：帮我修这个 bug
        │
        ▼
   ┌─────────────────────────┐
   │ ① 把你说的话送进上下文   │
   └─────────────────────────┘
        │
        ▼
   ┌─────────────────────────┐
   │ ② 调用大模型             │      ← 模型既会"说话"
   └─────────────────────────┘         也会"请求调用工具"
        │
        ▼
   模型返回了什么？
        │
        ├── 只是普通回复 ──→ 结束，把结果告诉你 ✅
        │
        └── 请求调用工具（比如"读文件"）
              │
              ▼
        ┌─────────────────────────┐
        │ ③ 执行这个工具           │      ← 真正去读文件
        └─────────────────────────┘
              │
              ▼
        ┌─────────────────────────┐
        │ ④ 把工具结果放回上下文   │      ← 模型现在"看到"文件内容了
        └─────────────────────────┘
              │
              ▼
      回到 ②，再次调用模型 ──────→  模型看到结果，继续思考，
                                    ／   可能又要调下一个工具……
                                    └─→ 直到它觉得搞定了，回复你
```

**关键点在这里**：模型不是一次就把任务做完的。它是"说一句话 → 做一件事 → 看到结果 → 再说下一句话"这样**反复循环**，直到认为任务完成。

专业术语叫 **Agent Loop（智能体循环）**。一个"回合（turn）" = 一次模型调用 + 它可能触发的工具执行。

在代码里，这个循环就是 [agent-loop.ts](file:///d:/HUST/Study/Computer/Pi_agent/pi/packages/agent/src/agent-loop.ts#L155-L275) 里的两层 `while`：

- **外层循环**：处理"你中途又追加的消息"（follow-up）
- **内层循环**：不断"调模型 → 执行工具 → 再调模型"，直到没有工具要调为止

> 记住这三个词，后面会反复用到：**上下文（context）、工具（tool）、回合（turn）**。

### 4.1 源码详解：`runLoop` —— 两重循环的真身

上面的流程图画的是"道理"，下面是"真身"。打开 `packages/agent/src/agent-loop.ts`，找到 `runLoop` 函数（约第 155 行）。下面的代码**有删减**（用 `// …` 标注省略的部分），但骨架一字未动：

```typescript
// runLoop（agent-loop.ts 第 155 行起）——全文件最值得读的一段
async function runLoop(initialContext, newMessages, config, signal, emit, streamFunction) {
  let currentContext = initialContext;
  // 开场先捞一次 steering 消息（用户可能在我还没开工时已经打字了）
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  // ── 外层循环：处理 Follow-up（等全部做完后才追加的任务） ──
  while (true) {
    let hasMoreToolCalls = true;

    // ── 内层循环：调模型 → 跑工具 → 再调模型 ──
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // ① 把用户中途塞进来的消息（steer / follow-up）注入上下文
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          currentContext.messages.push(message);
        }
        pendingMessages = [];
      }

      // ② 调一次大模型，拿回一条回复
      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);

      // ③ 回复若是 error / aborted，直接收工
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // ④ 数一数回复里有没有"我想调用工具"
      const toolCalls = message.content.filter((c) => c.type === "toolCall");

      const toolResults = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        // ⑤ 去执行这些工具，把结果收进 toolResults，并塞回上下文
        const batch = await executeToolCalls(currentContext, message, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;   // ← 内层循环的"命门"
        for (const result of toolResults) {
          currentContext.messages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      // ⑥ 用户中途按 Enter 发的消息，在这里被捞出来（下一轮注入）
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 内层循环走完 = 模型不再调工具。看看有没有 follow-up 在排队
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;   // 塞回去，再来一轮
      continue;
    }
    break;   // 没有追加任务，彻底结束
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

**两个最值得品味的点：**

**① `hasMoreToolCalls` 是内层循环的"命门"。** 它决定"要不要继续转"。模型只要还想调工具，它就是 `true`，循环就继续；某回合模型只是纯说话（没有 `toolCall`），它就变 `false`，内层循环自然停下。**"能不能继续做"这件事，完全由模型上一回合的回复说了算**——这正是 Agent 的核心分工：*模型负责想，循环负责做，做的节奏跟着想的节奏走*。

细心的你会注意到：`hasMoreToolCalls = !batch.terminate`，而不是简单写成 `true`。这是给工具留的一个"紧急刹车"——如果这一批工具的结果全都带着 `terminate: true`（例如某个工具说"行了，到此为止"），那么即使还有工具调用，循环也会停下。日常使用中很难触发，但它在设计上很重要：**"什么时候结束"的决定权，也可以交给工具**。

**② 双层循环各管一件事。** 内层循环管"这一件事做没做完"（工具链），外层循环管"还有没有下一件事"（用户追加的消息）。两者靠 `pendingMessages` 数组接力：follow-up 被塞进来后 `continue` 回外层顶部，再跌进内层走同一套流水线。**不管消息是什么时候来的，都走同一条"注入 → 思考 → 执行"的路**——这就是为什么你可以一边看它干活，一边随时追加指令。

> 小知识：代码里的 `config.getSteeringMessages` / `getFollowUpMessages` 背后是两个队列（`PendingMessageQueue`）。它们支持两种取法：`one-at-a-time`（一次只取最早一条，默认）和 `all`（一次全取）。这就是 `/settings` 里 `steeringMode`、`followUpMode` 两个选项的来历。

---

## 五、模型是怎么"要求"调用工具的？

上面说模型会"请求调用工具"，这个请求长什么样？这就要看 `packages/ai` 包了。

大模型在生成回复时，可以选择生成**两种内容块**：

1. **普通文字**（`text`）—— 就是它想对你说的话
2. **工具调用**（`toolCall`）—— 它说："我想调用 `read` 这个工具，参数是 `path=xxx`"

模型不会真的去读文件，它只是**提出请求**。真正动手的是 Agent 循环。

看一下模型返回的消息结构（在 `packages/ai` 里的 `AssistantMessage`）：

```typescript
{
  role: "assistant",
  stopReason: "toolUse",          // 关键！说明"我想用工具"
  content: [
    { type: "toolCall",           // 一个工具调用请求
      name: "read",
      arguments: { path: "src/main.ts" } }
  ]
}
```

注意那个 `stopReason`。它是模型"停下来的原因"：

- `stop` → 说完了，结束
- `toolUse` → 我要调用工具（Agent 循环看到这个，就知道该去执行了）
- `length` → 输出超出长度上限
- `error` / `aborted` → 出错了 / 被取消了

Agent 循环在 [agent-loop.ts 的 203 行](file:///d:/HUST/Study/Computer/Pi_agent/pi/packages/agent/src/agent-loop.ts#L202-L222) 这样判断：

```typescript
const toolCalls = message.content.filter((c) => c.type === "toolCall");
if (toolCalls.length > 0) {
    // 有工具调用 → 去执行工具
    hasMoreToolCalls = true;   // 让循环继续
}
```

一句话总结：**模型负责"想"，Agent 循环负责"做"**。模型说"我要用工具"，循环就真的去用，然后把结果喂回去，循环继续。

### 5.1 源码详解：一条"想用工具"的回复是怎么流出来的

模型不是一口气说完一句话，而是**一个片段一个片段**地往外吐。接收这些片段的地方，是 `agent-loop.ts` 的 `streamAssistantResponse`（第 281 行）。它的骨架是这样（同样有删减，`// …` 表示我省略的细节）：

```typescript
// streamAssistantResponse（agent-loop.ts 第 281 行起）
async function streamAssistantResponse(context, config, signal, emit, streamFunction) {
  // ① 发送前，把内部消息"翻译"成模型能懂的格式（第六节细讲）
  let messages = context.messages;
  if (config.transformContext) messages = await config.transformContext(messages, signal); // 可选的修剪/压缩
  const llmMessages = await config.convertToLlm(messages);                                  // 必选的翻译
  const llmContext = { systemPrompt: context.systemPrompt, messages: llmMessages, tools: context.tools };

  // ② 调用大模型，拿到一个"流"（边生成边返回）
  const response = await streamFunction(config.model, llmContext, { ...config, signal });

  let partialMessage = null;   // 记录"生成到一半"的消息
  for await (const event of response) {
    switch (event.type) {
      case "start":            // 模型开始生成：把半成品先放进上下文
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_delta":       // 又多生成了一个字
      case "thinking_delta":   //   或者又多了一段思考
      case "toolcall_delta":   //   或者工具调用的参数又多了一点
        partialMessage = event.partial;
        context.messages[context.messages.length - 1] = partialMessage;   // 就地更新半成品
        await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
        break;

      case "done":             // 生成完了
      case "error": {
        const finalMessage = await response.result();   // 拿到完整消息
        context.messages[context.messages.length - 1] = finalMessage;   // 用完整版替换半成品
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;   // ← 带着 stopReason 和 content 回去
      }
    }
  }
}
```

**这一段的三个逻辑要点：**

1. **"打字效果"的真相。** 每一个 `text_delta` 就是模型吐出的一个片段。循环每次收到片段，都用 `message_update` 事件广播一次。你看到的一行行"打字机"效果，就是界面监听这些事件渲染出来的——这也是为什么你能实时看着模型边想边写。

2. **"半成品"也活在上下文里。** 模型生成过程中，`context.messages` 的最后一条始终是**最新状态的半成品**（`start` 时塞进去，`delta` 时就地替换）。等 `done` 到来，再用完整消息换掉它。这样上下文永远反映"模型此刻正在说什么"。

3. **这个函数返回一条 `AssistantMessage`，带着 `stopReason` 和 `content`**——它正是回到 `runLoop` 后判定"要不要调工具"的依据。模型是"说完了"还是"想用工具"，就藏在 `stopReason` 里。

回到 `runLoop`，模型到底想干嘛，靠这几行解码：

```typescript
// runLoop 里，拿到回复后立即做的判断
const toolCalls = message.content.filter((c) => c.type === "toolCall");  // 筛出所有"工具调用"块
if (toolCalls.length > 0) {
  const batch = await executeToolCalls(currentContext, message, config, signal, emit);  // 有 → 去执行
  hasMoreToolCalls = !batch.terminate;  // 执行完继续转
} else {
  hasMoreToolCalls = false;             // 没有 → 本轮结束
}
```

`message.content` 是一个数组，里面每一项要么是文字块（`{ type: "text" }`），要么是工具调用块（`{ type: "toolCall", name, arguments }`）。一行 `filter` 就把"模型想调的工具"全筛出来了。

> 顺带说明：上面第五节那句 `hasMoreToolCalls = true` 是更简化的表达。严格写法是 `!batch.terminate`——多出来的 `terminate` 是一个"刹车"开关（含义见 4.1），日常阅读时可以忽略它。

---

## 六、消息流转：AgentMessage → LLM Message 的"翻译"

细心的你可能发现了：Agent 内部用的消息，和模型能理解的消息，其实**不是同一种东西**。

- Agent 内部：`AgentMessage`，除了 `user`、`assistant`、`toolResult`，还可能有各种自定义类型（比如 UI 通知）
- 大模型只认三种：`user`（用户）、`assistant`（助手）、`toolResult`（工具结果）

所以每次调用模型前，Agent 都要做一次**"翻译"**，把内部消息转成模型能懂的消息。这个翻译函数叫 `convertToLlm`。

流程是这样（在 `agent.ts` 里）：

```
AgentMessage[] ──transformContext??──> AgentMessage[] ──convertToLlm──> Message[] ──> 大模型
   （压缩、注入上下文）                 （过滤掉 UI 消息、转格式）
```

两个钩子作用不同：
- `transformContext`：可选，在发送前**修剪/压缩**旧消息（省 token）
- `convertToLlm`：必选，**过滤 + 转换**，保证只把模型能理解的东西送过去

这就解释了为什么开发者能往对话里塞各种自定义消息，而模型不会被搞懵——因为翻译层把不该给模型看的都挡掉了。

### 6.1 源码详解：`convertToLlm` 到底做了什么

`convertToLlm` 的"默认版"短得惊人——就一个 `filter`（`agent.ts` 第 33 行）：

```typescript
// agent.ts：如果不自己提供 convertToLlm，就用这个默认翻译
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" ||      // 用户的话
      message.role === "assistant" || // 助手的话
      message.role === "toolResult",  // 工具的结果
  );
}
```

**它的全部逻辑就是：只留这三种角色，其余全删。** 看起来简单，其实是整套系统的一个关键设计：Agent 内部的 `AgentMessage` 可以有很多自定义角色（比如"通知""进度条"这类 UI 专用的），但**大模型只认这三种**。这条 `filter` 就是一道闸门，保证任何奇怪的内部消息都到不了模型眼前。

如果你想做得更细，`types.ts` 的注释里给了"高级版"的例子：

```typescript
convertToLlm: (messages) =>
  messages.flatMap((m) => {
    if (m.role === "custom") {
      // 自定义消息：转换成 user 消息，让模型能看到
      return [{ role: "user", content: m.content, timestamp: m.timestamp }];
    }
    if (m.role === "notification") {
      // UI 专属消息：直接删掉，不给模型
      return [];
    }
    return [m];   // 标准消息：原样放行
  });
```

**这一节要和上一节的 `streamAssistantResponse` 对着看**：`convertToLlm` 在每次调模型前执行（就是那个函数里的第 ① 步），它的输入是 Agent 内部消息，输出是模型消息。**一道闸门 + 一个翻译**，让"Agent 内部世界可以很丰富"和"模型只认三种角色"这两件事同时成立，互不打架。

> 日常启示：如果你想往对话里塞"只有界面显示、不给模型看"的东西（比如一个进度通知），就定义一个自定义角色，然后在 `convertToLlm` 里把它过滤掉。这就是"把不该给模型看的都挡掉"的正规做法。

---

## 七、工具（Tool）：Agent 的"手脚"

工具是 Agent 区别于聊天机器人的核心。在 Pi 里，一个工具这样定义（来自 `packages/agent` 的 README）：

```typescript
const readFileTool: AgentTool = {
  name: "read_file",                       // 工具名（模型通过名字调用它）
  description: "Read a file's contents",   // 描述（告诉模型什么时候用它）
  parameters: Type.Object({                // 参数结构（用 TypeBox 定义，还能自动校验）
    path: Type.String({ description: "File path" }),
  }),
  execute: async (toolCallId, params) => {
    const content = await fs.readFile(params.path, "utf-8");
    return { content: [{ type: "text", text: content }] };  // 返回结果
  },
};
```

一个工具最基本的四要素：**名字、描述、参数、执行函数**。

> 先思考一下：为什么 `description` 和 `parameters` 这么重要？
> 因为模型**看不到工具的实现代码**，它只能靠"名字 + 描述 + 参数说明"来判断什么时候该用这个工具、该怎么传参数。所以描述写得越清楚，模型就越会用对。

**工具执行分两种模式**（`packages/agent` 支持）：

- `parallel`（并行，默认）：模型一次调多个工具时，同时执行，更快
- `sequential`（串行）：一个接一个执行，适合有依赖关系的

**工具出错怎么办？** 注意：工具内部应该**抛异常**，而不是返回错误文本。Agent 循环会捕获异常，把它标记为 `isError: true` 的 `toolResult` 喂回给模型，让模型看到错误、自己想办法重试或换方案。这就是 Agent 能"从错误中恢复"的秘密。

### 7.1 源码详解：真实的 `read` 工具长什么样

上面那个 `readFileTool` 是我按官方 README 简化的示意（四要素够清楚，但离真实工具还有距离）。真实的 `read` 工具在 `packages/coding-agent/src/core/tools/read.ts`（第 209 行起），四要素一个不少，只是更"丰满"（下面删掉了 UI 渲染相关的细节，用 `// …` 标注）：

```typescript
// read.ts：真实工具的四要素
const readSchema = Type.Object({                       // ← 参数结构（用 TypeBox 定义）
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createReadToolDefinition(cwd, options) {
  return {
    name: "read",                                     // ← 名字
    label: "read",
    description:                                        // ← 描述：告诉模型"什么时候用、怎么用"
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). " +
      "Images are sent as attachments. For text files, output is truncated to 2000 lines " +
      "or 50KB (whichever is hit first). Use offset/limit for large files. " +
      "When you need the full file, continue with offset until complete.",
    parameters: readSchema,                           // ← 参数
    async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate, ctx) {
      // ① 检查文件在不在、能不能读
      await ops.access(absolutePath);
      // ② 判断是图片还是文本（图片会作为 attachment 传给模型）
      const mimeType = await ops.detectImageMimeType(absolutePath);
      if (mimeType) {
        // 图片：读出来、必要时缩放，返回 { type: "image" } 内容块
        // …
      } else {
        // 文本：读出来 → 按 offset/limit 切片 → 超长就截断
        const truncation = truncateHead(selectedContent);
        // ③ 如果被截断了，告诉模型"从第几行接着读"
        const nextOffset = endLineDisplay + 1;
        const outputText =
          truncation.content + `\n\n[Showing lines X-Y of N. Use offset=${nextOffset} to continue.]`;
        return { content: [{ type: "text", text: outputText }], details: { truncation } };
      }
    },
  };
}
```

**读真实工具，重点看三件事：**

1. **`description` 就是给模型看的"说明书"。** 注意它写得多具体——连"读大文件用 offset/limit、被截断就 offset 继续读"这种使用技巧都写进去了。**模型看不到工具的实现，它全凭这段描述决定"什么时候用、参数怎么填"**。描述写得越像说明书，模型用得越准。这是所有工具设计里最值得花心思的一环。

2. **工具会刻意"把话说完"：截断后告诉模型接着读。** 你看 `execute` 里，一旦文件太大被截断，它返回的内容带着一句 `Use offset=X to continue.`。这不是给人看的，是**给模型看的提示**——模型读完这段，会自己发起下一个 `read`（带 offset）继续读。一个工具链就这样被"接力"起来。这就是为什么 Agent 能自动完成"读完整本代码"这种大任务：**工具在设计时就想着怎么让模型顺畅地走"下一步"**。

3. **`details` 是"给界面看、不给模型看"的旁白。** 返回值分两半：`content`（进上下文的正文，模型能看到）和 `details`（附加信息，比如截断详情，主要给界面渲染）。对照第六节就明白了——`convertToLlm` 能安全过滤，正因为能进模型上下文的只有 `content`。

### 7.2 源码详解：工具到底是怎么被"执行"的

看完工具长什么样，再看循环里工具是怎么被跑起来的。`agent-loop.ts` 的 `executeToolCalls`（第 411 行）先决定并行还是串行：

```typescript
// executeToolCalls：决定执行策略
async function executeToolCalls(currentContext, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");

  // 只要有一个工具声明"我必须串行"，整个批次就退化成串行
  const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );

  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);   // 一个接一个
  }
  return executeToolCallsParallel(...);        // 一起上（默认）
}
```

无论哪种模式，每个工具都要先过一道"安检"——`prepareToolCall`（第 600 行）：

```typescript
// prepareToolCall：执行前的"安检"
async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal) {
  // 1. 按名字找工具
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    // 模型喊了一个不存在的工具 → 直接返回错误结果
    return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
  }

  // 2. 校验参数（TypeBox 按 schema 自动校验）
  const validatedArgs = validateToolArguments(tool, preparedToolCall);

  // 3. 执行前的钩子 beforeToolCall 可以"拦截"这次调用（权限控制就在这做）
  if (config.beforeToolCall) {
    const beforeResult = await config.beforeToolCall({ toolCall, args: validatedArgs, context: currentContext }, signal);
    if (beforeResult?.block) {
      // 被拦下 → 返回"错误结果"，模型会看到拦截原因
      return {
        kind: "immediate",
        result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
        isError: true,
      };
    }
  }
  return { kind: "prepared", toolCall, tool, args: validatedArgs };   // 万事俱备，可以执行
}
```

真正跑工具那一步（`executePreparedToolCall`，第 670 行），是整个系统"容错设计"的缩影：

```typescript
// executePreparedToolCall：调用 execute，并把所有失败都转成"错误结果"
async function executePreparedToolCall(prepared, signal, emit) {
  try {
    const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, onUpdate);
    return { result, isError: false };
  } catch (error) {
    // 工具抛异常 → 不炸掉整个循环，而是转成 isError: true 的结果喂回给模型
    return { result: createErrorToolResult(error.message), isError: true };
  }
}
```

**这里藏着整个 Agent 最核心的容错思想：循环本身几乎从不"向上抛异常"。** 任何一个环节出问题（工具不存在、参数不对、被拦截、工具内部抛错），都被转换成一条 `isError: true` 的 `toolResult` 放回上下文。模型"看到"这条错误记录后自己决定怎么办：换个参数重试、换别的工具、或者干脆告诉用户"我失败了"。**出错不是终点，而是模型思考的新输入**——这就是 Agent 看起来"会自我纠错"的底层原因。

> 对照第六节：这条 `isError: true` 的 `toolResult` 会被 `createToolResultMessage` 整理成一条正式消息塞进上下文，再经由 `convertToLlm` 翻译给模型看。整条链路是打通的。

---

## 八、事件系统：让"界面"跟得上"大脑"

Agent 在后台忙碌的时候，你是能看到它实时输出的（那些一行行冒出来的文字、工具调用记录）。这靠的是**事件系统（Event System）**。

Agent 循环每走一步，就往外派发一个**事件**（`AgentEvent`），`Agent.subscribe()` 注册的监听器能实时收到。常见事件：

| 事件 | 含义 |
|------|------|
| `agent_start` / `agent_end` | 整个 Agent 处理开始 / 结束 |
| `turn_start` / `turn_end` | 一个回合开始 / 结束 |
| `message_start` / `message_update` / `message_end` | 消息开始 / 流式更新 / 完成 |
| `tool_execution_start` / `update` / `end` | 工具开始执行 / 进度 / 完成 |

拿你输入"帮我读 config.json"举例，完整事件流（来自 `packages/agent` README）：

```
agent_start
turn_start
message_start/end   ← 记录你的话
message_start       ← 模型开始回复
message_update      ← 模型一边生成一边推送（流式打字效果）
message_end         ← 模型这条回复完成
tool_execution_start ← 模型要求读 config.json，开始执行
tool_execution_end   ← 读完了
turn_end             ← 本回合结束（工具结果已就绪）
turn_start           ← 下一回合：把结果喂回模型
message_start/update/end ← 模型基于结果继续回复
turn_end
agent_end            ← 全部完成
```

这套事件流有两大好处：

1. **界面能实时刷新**：你看到的"打字效果"和"工具调用记录"，都是监听这些事件渲染出来的
2. **各部分解耦**：大脑（循环）只负责派发事件，界面（TUI）、日志、统计各自订阅自己关心的就行

### 8.1 源码详解：`processEvents` —— 事件是怎么驱动"状态"的

事件不只是"发出去就完了"。在 `Agent` 类里，每一个事件都会先驱动一次内部状态更新，再广播给订阅者。看 `agent.ts` 的 `processEvents`（第 544 行）：

```typescript
// agent.ts：每个事件先更新内部状态，再通知订阅者
private async processEvents(event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "message_start":
      this._state.streamingMessage = event.message;           // 记录"正在生成的消息"
      break;

    case "message_end":
      this._state.streamingMessage = undefined;
      this._state.messages.push(event.message);               // 消息完成，收进正式记录
      break;

    case "tool_execution_start":
      this._state.pendingToolCalls.add(event.toolCallId);     // 记一笔"这个工具在跑"
      break;

    case "tool_execution_end":
      this._state.pendingToolCalls.delete(event.toolCallId);  // 跑完了，销掉
      break;

    case "turn_end":
      if (event.message.errorMessage) {
        this._state.errorMessage = event.message.errorMessage; // 记下最近的错误
      }
      break;
  }

  // 状态更新完毕，再按注册顺序逐个通知订阅者（界面、日志、统计…）
  for (const listener of this.listeners) {
    await listener(event, signal);
  }
}
```

**这是"事件系统"和"状态管理"衔接的枢纽。** 事件在这里是"双通道"：

- **往内**：驱动 `AgentState`。`streamingMessage`（正在流式生成的消息）、`pendingToolCalls`（正在跑的工具集合）、`messages`（完整对话记录）、`errorMessage`（最近一次错误）——这就是 `agent.state` 里你能实时读到的状态。
- **往外**：驱动订阅者。界面监听事件做增量渲染，日志监听事件做审计，统计模块累加事件算 token 和费用。**互不干扰，各取所需。**

这套设计带来的直接好处：**界面不需要自己拼状态**，它只要跟着事件流做增量更新就行；而任何想获取"此刻全貌"的地方（比如调试、导出），直接读 `agent.state` 即可。

**值得留意的一点：`processEvents` 是 `await` 订阅者的。** 事件不是"发了就走"，而是要等监听者处理完（`listener(event)` 返回）才继续。这保证了界面刷新和内部状态"同步"——你看到的界面不会比大脑慢半拍。代价是：监听者别写耗时逻辑，否则会拖慢整个 Agent。

---

## 九、上下文管理：记忆的"取舍"艺术

Agent 处理长任务会遇到一个现实问题：**大模型的"记忆"是有限制的**（上下文窗口，比如几万 token）。聊得越长，塞进模型的内容越多，要么超限，要么越来越贵、越来越慢。

Pi 怎么解决？靠**会话（Session）和压缩（Compaction）**。

### 9.1 会话（Session）

每次对话都会存成一个 JSONL 文件（一种一行一条 JSON 的格式），记录所有消息。存成树状结构，支持**分支**（branching）——比如你试了方案 A 不理想，可以回到某个时间点，从那里再试方案 B，历史记录都在。

日常对应操作：`/tree` 查看会话树、`/fork` 从某个点分叉、`/resume` 恢复历史会话。

### 9.2 压缩（Compaction）

当上下文快满时，Pi 会**自动把早期的旧消息"总结"成一段摘要**，只保留最近的消息。这样既省 token，又不丢关键信息。

> 注意：压缩是**有损的**（lossy）。细节会被"概括"掉，就像你写读书笔记，不会把整本书抄下来。所以重要信息最好记在文件里（比如 `AGENTS.md`）而不是只放在对话里。

好消息是：**完整历史仍然存在 JSONL 文件里**，随时可以 `/tree` 回去看。所以压缩只是"给模型的临时记忆缩水"，不是"你的记录被删了"。

---

## 十、系统提示词是怎么拼出来的？

Agent 每次调模型，都会带上一段"剧本"叫**系统提示词（System Prompt）**，告诉模型"你是谁、你会什么、该怎么做"。Pi 的 `buildSystemPrompt`（在 `packages/coding-agent`）会动态拼装这段内容：

1. 基础身份："你是 pi 里面的编程助手，你会读文件、跑命令、改代码……"
2. **可用工具清单**：只列当前启用的工具和一句话说明
3. **行为准则**："回答要简洁""改文件时把路径写清楚"
4. **项目上下文**：把项目里的 `AGENTS.md`（项目规则文件）拼进来
5. **技能列表**：如果需要，把可用的 Skills 列出来

这就是为什么你项目里的 `AGENTS.md` 能被助手"记住"——它被拼进了系统提示词，模型每次都能看到。

> 日常启示：**把项目的约定、常用命令、目录结构写进 `AGENTS.md`**，比每次对话里反复交代高效得多。这就是"给模型一份长期记忆"。

---

## 十一、扩展机制：让它"长"出你想要的能力

Pi 的哲学是"内核极简，能力靠扩展"。它不硬塞功能，而是给你几种"长能力"的方式：

| 机制 | 是什么 | 适用场景 |
|------|--------|---------|
| **Skills（技能）** | 一段 Markdown 写的"操作手册"，`SKILL.md` 里写清楚"什么时候用、具体步骤" | 教模型做某类特定任务（比如"如何部署到服务器"） |
| **Prompt Templates** | 可复用的提示词模板，`/名称` 一键展开 | 常用需求的快捷方式（比如"帮我 review 代码"） |
| **Extensions（扩展）** | 真正的 TypeScript 代码，能注册新工具、新命令、新 UI | 想给 Agent 加真正的新能力（比如自定义一个部署工具） |
| **Packages（包）** | 把上面这些打包分享/安装 | 用别人写好的能力，或分享你的 |

重点讲讲 **Skills**，因为它最贴近日常。一个 Skill 就是一个文件夹里的 `SKILL.md`：

```markdown
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

模型在系统提示词里看到"有这样一个技能，做哪类任务时该用"，遇到匹配的任务就会**按需加载**这个技能文件，照着它教的步骤做。这就是"给模型现场补课"。

> 注意：Skills 只是"说明书"，扩展（Extensions）才是"真手脚"。技能教模型怎么做，扩展给模型真正的新工具。

---

## 十二、底层一层：模型与提供商（pi-ai 包）

最后看最底层。`packages/ai` 包做了一件很贴心的事——**把几十家 LLM 提供商的差异抹平，统一成一套接口**。

- **Provider（提供商）**：OpenAI、Anthropic、Google、DeepSeek……每家都有自己的 API 格式和鉴权方式
- **Model（模型）**：某个提供商下的具体模型（如 `gpt-4o`、`claude-sonnet`）
- **统一接口**：无论底层是谁，你都是 `models.stream(model, context)` 这样调用

好处是：**同一个 Agent 内核，可以无缝切换模型**。甚至可以在对话中途换模型（Cross-Provider Handoff）——比如先用便宜的快速模型，遇到难题再切到更强的模型，上下文还能保留。

鉴权也有讲究：支持 API Key、OAuth 登录（用订阅账号）、环境变量等多种方式，自动解析刷新。

这层离你日常使用较远，但理解它有助于明白：**Agent 工具和具体用什么模型是解耦的**，你可以自由选择性价比合适的模型。

---

## 十三、串起来：一张完整的"运转图"

把前面所有内容串起来，一次完整任务全貌：

```
你输入指令
   │
   ▼
[Pi 启动] 拼系统提示词（身份 + 工具清单 + AGENTS.md + Skills）
   │
   ▼
┌────────────── Agent Loop（核心循环）──────────────┐
│ ① 把消息翻译成模型能懂的格式（convertToLlm）        │
│ ② 调用大模型（pi-ai 层，自动解析鉴权）              │
│ ③ 模型返回：文字 or 工具调用请求？                  │
│    ├─ 文字 → 结束，展示给你                        │
│    └─ 工具调用 → 校验参数 → 执行工具 → 结果喂回     │
│       → 回到 ②（循环直到任务完成）                 │
│ ④ 每步都向外派发事件，界面实时显示                  │
│ ⑤ 上下文太长 → 自动压缩                            │
└────────────────────────────────────────────────┘
   │
   ▼
  会话存入 JSONL，可随时 /resume、/tree、/fork
```

---

## 十四、对你日常使用 Agent 工具的启示

学完原理，这些"内功"能直接指导你日常操作：

### 1. 把话说清楚，想象你在给一个"看不见手"的人交代
Agent 靠"名字+描述+参数"用工具，靠你的话理解意图。指令越具体（目标、约束、文件路径、验收标准），它越少走弯路。别只说"帮我修 bug"，要说"src/main.ts 第 10 行报错：xxx，帮我修好并跑测试验证"。

### 2. 善用"上下文"，建立长期记忆
把项目约定写进 `AGENTS.md`（或它支持的其他上下文文件），一次受益整个项目。别每次对话都重新交代一遍。

### 3. 留意"回合"和"停顿"
看到它调用工具、读文件、跑命令，别急着打断。给它一个完整循环的机会。如果它卡住或方向错了，及时 `steer`（中途纠正）比等它做完再返工高效。

### 4. 理解"压缩有损"
长对话时，早期细节可能被总结掉。**关键信息写进文件**，别只依赖对话记忆。重要的历史，用会话的 `/tree`、`/fork` 管理，而不是无限堆在一个对话里。

### 5. 学会用 Skills 给它"补课"
遇到重复性的特定任务（部署、格式化、特定规范），把它整理成一个 Skill 或 Prompt Template，一劳永逸。

### 6. 知道模型和工具是解耦的
任务简单用便宜快的模型，复杂推理切强模型。别一个模型用到死。

### 7. 让它"自己动手"，而不只是"告诉你怎么做"
Agent 的价值在于它有工具、能循环。给它整任务（"重构这个函数并跑测试"），而不是只问"这段代码该怎么改"。

---

## 十五、最后说两句

这篇文档以 Pi 为标本，把 AI-Agent 的骨架给你拆开看了：**一个会反复循环的"思考器"，配上一双会调用的"手"（工具），再配上一套"记忆"（上下文）和"传声筒"（事件）**。

这套架构不是 Pi 独有，而是整个 AI-Agent 领域的通用范式。理解了它，你再看任何 Agent 工具（Claude Code、Cursor、各种编程助手），都能一眼看穿它在干什么。

学习建议：读完这篇，自己打开 `packages/agent/src/agent-loop.ts` 对照着看一遍，比读十遍文档都管用。代码就是最好的老师。

祝你玩得开心，学有所得。