# AI Harness 提示词管理调研与 PID 调参借鉴报告

> 本文档系统调研主流开源 AI agent / LLM harness 框架在**提示词组织、上下文管理、输入输出格式约束**上的做法，并结合本项目（ai-serial-assistant）当前 `callAiForPid` 的实现，给出可落地的改进建议。
>
> - 关联代码：[src/renderer/src/components/PidPanel.vue](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue) 的 `callAiForPid`、[src/renderer/src/services/controlAnalysis.mjs](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs) 的 `historyToPromptText` / `buildFeedforwardSuggestion`
> - 关联文档：[docs/pid-tuning-strategy-and-ai-prompt.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/pid-tuning-strategy-and-ai-prompt.md)、[docs/llm-pid-tuner-analysis.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/llm-pid-tuner-analysis.md)
> - 生成时间：2026-08-07

---

## 目录

- [一、调研背景与目标](#一调研背景与目标)
- [二、调研对象概览](#二调研对象概览)
- [三、各框架核心做法对比表](#三各框架核心做法对比表)
- [四、各框架详细分析](#四各框架详细分析)
  - [4.1 OpenAI Agents SDK（openai-agents-python）](#41-openai-agents-sdkopenai-agents-python)
  - [4.2 LangChain / LangGraph](#42-langchain--langgraph)
  - [4.3 Microsoft AutoGen](#43-microsoft-autogen)
  - [4.4 DSPy（斯坦福）](#44-dspy斯坦福)
  - [4.5 Instructor](#45-instructor)
  - [4.6 MetaGPT](#46-metagpt)
  - [4.7 CrewAI](#47-crewai)
  - [4.8 Anthropic Claude 官方 Prompt Engineering 指南](#48-anthropic-claude-官方-prompt-engineering-指南)
  - [4.9 coding agent（Cline / Aider）](#49-coding-agentcline--aider)
  - [4.10 llm-pid-tuner（本项目已借鉴的开源 PID 调参工具）](#410-llm-pid-tuner本项目已借鉴的开源-pid-调参工具)
  - [4.11 控制系统 LLM 前沿论文](#411-控制系统-llm-前沿论文)
- [五、本项目当前提示词实现现状](#五本项目当前提示词实现现状)
  - [5.1 System Prompt](#51-system-prompt)
  - [5.2 User Prompt（结构化 JSON 上下文）](#52-user-prompt结构化-json-上下文)
  - [5.3 阶段策略提示](#53-阶段策略提示)
  - [5.4 解析与护栏](#54-解析与护栏)
  - [5.5 重试策略](#55-重试策略)
  - [5.6 当前实现的优点](#56-当前实现的优点)
  - [5.7 当前实现的问题](#57-当前实现的问题)
- [六、可借鉴的改进点（13 条）](#六可借鉴的改进点13-条)
  - [A. 提示词组织](#a-提示词组织)
  - [B. 上下文管理](#b-上下文管理)
  - [C. 输出格式约束](#c-输出格式约束)
  - [D. 数值可靠性（避免幻觉参数）](#d-数值可靠性避免幻觉参数)
  - [E. 错误处理与评估](#e-错误处理与评估)
- [七、优先级建议](#七优先级建议)
- [八、参考资料](#八参考资料)

---

## 一、调研背景与目标

### 1.1 问题陈述

本项目（ai-serial-assistant）的 **PID / 前馈自动调参功能**效果欠佳，用户反馈其中一个原因是**提示词写得不够好**。为系统化提升提示词质量，特调研主流开源 AI harness 框架的做法，提炼可借鉴的设计模式。

### 1.2 调研目标

- **横向对比**：各大框架如何组织提示词、管理上下文、约束输入输出格式
- **纵向深挖**：针对数值 / 工程类任务（如 PID 调参、控制参数优化）的特殊技巧
- **落地建议**：结合本项目代码现状，给出可直接执行的改进点

### 1.3 调研方法

- 通过 WebSearch + WebFetch 检索 GitHub 仓库源码与官方文档
- 重点查看各框架的 prompt 管理、structured output、retry、evaluation 模块
- 附加检索控制系统 + LLM 的 arXiv 论文（AgenticControl、LLM-R2R 等）

---

## 二、调研对象概览

| # | 框架/项目 | 类型 | 仓库/文档 |
|---|---|---|---|
| 1 | OpenAI Agents SDK | 官方 agent 框架 | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) |
| 2 | LangChain / LangGraph | 通用 LLM 编排 | [python.langchain.com](https://python.langchain.com/docs/concepts/prompt_templates/) |
| 3 | Microsoft AutoGen | 多 agent 对话 | [microsoft/autogen](https://github.com/microsoft/autogen) |
| 4 | DSPy | 程序化提示词优化 | [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) |
| 5 | Instructor | 结构化输出库 | [jxnl/instructor](https://github.com/jxnl/instructor) |
| 6 | MetaGPT | 多 agent 协作 | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) |
| 7 | CrewAI | 角色化多 agent | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) |
| 8 | Anthropic Claude PE 指南 | 官方提示词指南 | [docs.anthropic.com](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags) |
| 9 | Cline / Aider | coding agent | [cline/cline](https://github.com/cline/cline)、[paul-gauthier/aider](https://github.com/paul-gauthier/aider) |
| 10 | llm-pid-tuner | PID 调参专用（已借鉴） | [KINGSTON-115/llm-pid-tuner](https://github.com/KINGSTON-115/llm-pid-tuner) |
| 11 | AgenticControl / LLM-R2R | 控制 + LLM 论文 | [arXiv 2506.19160](https://arxiv.org/abs/2506.19160)、[arXiv 2511.22975](https://arxiv.org/abs/2511.22975) |

---

## 三、各框架核心做法对比表

| 框架/项目 | 提示词组织 | 上下文管理 | 输出格式约束 | 错误处理 | 评估迭代 |
|---|---|---|---|---|---|
| **OpenAI Agents SDK** | `instructions: str \| Callable[ctx→str]`，支持动态指令 | `context` 强类型对象贯穿 agent 链；handoffs 传递 | `output_type=Pydantic Model`，底层用 Structured Outputs strict mode | SDK 内置校验失败自动重试 | ModelGuardrails |
| **LangChain/LangGraph** | `PromptTemplate` / `ChatPromptTemplate`，支持 partial、变量组合 | `trim_messages` 按 token 数裁剪；`RunnablePassthrough` 注入 RAG 检索结果 | `with_structured_output(schema)` 走 function calling | `OutputFixingParser` 自动修复 | LangSmith 平台做 trace 与评估 |
| **AutoGen** | system_message 字符串；可自定义 agent 角色 | GroupChat 管理多 agent 对话历史 | `response_format` Pydantic | 自定义 retry | — |
| **DSPy** | **程序化提示词**：Signature + Module，不写自然语言 prompt | 自动 few-shot 选样（`BootstrapFewShot`） | `dspy.Predict` + `dspy.OutputField` | — | `Evaluate` + `MIPRO` 自动优化 |
| **Instructor** | Pydantic 模型即提示词（字段 docstring 注入 schema） | — | 强制 Pydantic 校验，`mode=JSON/TOOLS/FUNCTIONS` | **`retries=N`：把校验错误回灌给 LLM 让它自我修正** | — |
| **MetaGPT** | Action 内 `PROMPT_TEMPLATE` 常量 + Jinja2 渲染 | `Action` 间用 `Message` 结构化传递 | 显式要求 JSON，`Action.output_class` | — | — |
| **CrewAI** | **YAML 三元组**：`role/goal/backstory` + `task` 分离 | `memory` 模块做短期/长期记忆 | `output_pydantic` / `output_json` | — | — |
| **Claude 官方 PE** | 用 `<context>` / `<instructions>` 等 XML 标签分块 | 长 context 直接放（200K）；XML 标签定位 | prefill `<json>` 强制 JSON 起手 | — | — |
| **Cline / Aider** | system prompt 硬编码在源码中（lint 规则、编辑格式） | 自动注入打开的文件、git diff、最近编辑 | `<attempt_completion>` / `<search_replace>` XML | — | — |
| **llm-pid-tuner** | `prompts.py` 常量 + CoT + 严格 JSON | 历史 5 轮 + 时序下采样 30 点 | 三候选容错解析（裸/代码块/花括号配对） | 5 次退避 + 字段清洗 | 固定种子 benchmark |
| **AgenticControl** | actor-critic 双 agent：planner + critic | 阶跃响应曲线作为图像喂给 VLM | — | critic 拒绝坏参数 | — |
| **LLM-R2R** | 附录完整 agent system prompt 可直接参考 | RAG 检索工艺知识库替代参数记忆 | — | — | — |

---

## 四、各框架详细分析

### 4.1 OpenAI Agents SDK（openai-agents-python）

**仓库**：https://github.com/openai/openai-agents-python
**文档**：https://openai.github.io/openai-agents-python/

#### 提示词组织

- **动态指令**：`Agent(instructions="...")` 可传字符串，也可传 `Callable[RunContextWrapper, str]`，根据运行时上下文动态生成

```python
from agents import Agent, RunContextWrapper

def dynamic_instructions(ctx: RunContextWrapper[str]) -> str:
    return f"用户偏好语言是 {ctx.context}，请用此语言回复。"

agent = Agent(
    name="助手",
    instructions=dynamic_instructions,
)
```

#### 上下文管理

- **强类型 context 对象**：`RunContextWrapper[T]`，类型 T 是用户自定义 dataclass / Pydantic，贯穿整个 agent 调用链

```python
@dataclass
class TuningContext:
    history: list[dict]
    current_pid: dict
    metrics: dict

agent = Agent[TuningContext](name="PID Tuner", ...)
```

- **handoffs**：agent 之间转交时 context 自动传递

#### 输出格式约束

- **Pydantic 输出**：`output_type=Pydantic Model`，SDK 自动用 Structured Outputs strict mode

```python
from pydantic import BaseModel, Field

class PIDParams(BaseModel):
    kp: float = Field(..., ge=0, le=20, description="比例系数")
    ki: float = Field(..., ge=0, le=10, description="积分系数")
    kd: float = Field(..., ge=0, le=10, description="微分系数")
    thought: str = Field(..., max_length=100)

agent = Agent(name="PID Tuner", output_type=PIDParams, ...)
# SDK 保证 result.final_output 是 PIDParams 实例，无需手动解析
```

#### 错误处理

- SDK 内置校验失败重试，模型行为更可预测

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| 动态 instructions | phaseStrategy 可改成 `Callable`，按阶段动态生成 system prompt |
| Pydantic output_type | 直接用 schema 约束输出，省掉 `parseAiParams` 大半逻辑 |
| 强类型 context | 当前 user prompt 是手拼 JSON 字符串，可改成结构化对象 |

---

### 4.2 LangChain / LangGraph

**文档**：https://python.langchain.com/docs/concepts/prompt_templates/

#### 提示词组织

- **PromptTemplate / ChatPromptTemplate**：支持 `{var}` 变量、`partial`、`MessagesPlaceholder`

```python
from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是 PID 调参助手。当前阶段：{phase}。原则：{principles}"),
    ("user", "{metrics_json}"),
    ("placeholder", "{history}"),  # 动态插入历史消息
])
chain = prompt | model | parser
```

#### 上下文管理

- **trim_messages**：按 token 数裁剪历史，保留 system + 最近 N 条

```python
from langchain_core.messages import trim_messages

trimmer = trim_messages(
    max_tokens=4000,
    strategy="last",  # 保留最近
    token_counter=model,
    include_system=True,  # system prompt 不裁
    start_on="human",  # 从第一条 human 开始
)
```

- **RunnablePassthrough**：把 RAG 检索结果注入 prompt

```python
from langchain_core.runnables import RunnablePassthrough

chain = (
    {"context": retriever, "question": RunnablePassthrough()}
    | prompt
    | model
)
```

#### 输出格式约束

- **with_structured_output**：底层走 function calling

```python
from pydantic import BaseModel

class PIDParams(BaseModel):
    kp: float
    ki: float
    kd: float

structured_model = model.with_structured_output(PIDParams)
result = structured_model.invoke("...")  # 返回 PIDParams 实例
```

#### 错误处理

- **OutputFixingParser**：解析失败时让 LLM 自我修复

```python
from langchain.output_parsers import OutputFixingParser
fixing_parser = OutputFixingParser.from_llm(parser=base_parser, llm=model)
```

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| ChatPromptTemplate | 可把 system/user prompt 拆成模板文件，变量化 |
| trim_messages | 当前固定 5 轮，可改成 token 预算裁剪 |
| with_structured_output | 同 OpenAI，直接 schema 约束 |

---

### 4.3 Microsoft AutoGen

**仓库**：https://github.com/microsoft/autogen

#### 提示词组织

- `system_message` 字符串，每个 agent 一个角色
- v0.4+ 支持 `ChatAgent` + `UserProxyAgent` 的对话模式

#### 上下文管理

- **GroupChat**：管理多 agent 对话历史，按 round robin 或 LLM 选下一个发言者
- **Terminate message**：agent 输出特定字符串（如 "TERMINATE"）结束对话

#### 输出格式约束

- `response_format` Pydantic（v0.4+）

#### 借鉴价值

- 多 agent 模式（如 planner + critic）可参考，但本项目单 agent 已够用，暂不需要

---

### 4.4 DSPy（斯坦福）

**仓库**：https://github.com/stanfordnlp/dspy
**论文**：[arXiv 2310.03714](https://arxiv.org/abs/2310.03714)

DSPy 是最具启发性的一个——它**根本不写自然语言提示词**，而是用程序化方式描述任务，让编译器自动优化 prompt。

#### 提示词组织：Signature + Module

```python
import dspy

# Signature：声明输入输出，不写 prompt
class PIDTuneSignature(dspy.Signature):
    """根据响应指标和当前参数，给出新的 PID 参数。"""
    metrics: dict = dspy.InputField(desc="响应指标：超调、稳态误差、振荡等")
    current_pid: dict = dspy.InputField(desc="当前 PID 参数")
    history: list = dspy.InputField(desc="最近 5 轮调参历史")
    new_pid: dict = dspy.OutputField(desc="新 PID 参数")
    reasoning: str = dspy.OutputField(desc="调整理由")

# Module：把 Signature 包装成可调用对象
class PIDTuner(dspy.Module):
    def __init__(self):
        self.predict = dspy.Predict(PIDTuneSignature)
    
    def forward(self, metrics, current_pid, history):
        return self.predict(metrics=metrics, current_pid=current_pid, history=history)
```

#### 上下文管理：自动 few-shot

- **BootstrapFewShot**：从训练集自动挑选"成功的范例"作为 few-shot 注入 prompt

```python
from dspy.teleprompt import BootstrapFewShot

teleprompter = BootstrapFewShot(metric=my_metric_fn)
compiled_tuner = teleprompter.compile(PIDTuner(), trainset=trainset)
```

#### 评估与迭代

- **Evaluate**：批量评估 prompt 效果

```python
from dspy.evaluate import Evaluate

evaluator = Evaluate(devset=testset, num_threads=4, display_progress=True)
scores = evaluator(compiled_tuner, metric=my_metric_fn)
```

- **MIPRO**：自动优化 prompt 的指令部分

#### 借鉴价值（极高）

| 点 | 对本项目的意义 |
|---|---|
| 程序化 Signature | 当前 system prompt 是手写文本，可借鉴 Signature 的"输入输出声明"思路 |
| BootstrapFewShot | 从历史调参成功的范例自动挑 few-shot，比手写"调参策略"更有效 |
| Evaluate | 建立"场景集 + 评估函数"，量化 prompt 改动效果 |

---

### 4.5 Instructor

**仓库**：https://github.com/jxnl/instructor
**文档**：https://python.useinstructor.com/

Instructor 专注于**结构化输出**与**错误自修复**，是 Pydantic + LLM 的标准做法。

#### 提示词组织

- Pydantic 模型即提示词：字段 `docstring` 与 `description` 自动注入 schema

```python
from pydantic import BaseModel, Field

class PIDParams(BaseModel):
    """PID 调参输出"""
    kp: float = Field(..., ge=0, le=20, description="比例系数 Kp")
    ki: float = Field(..., ge=0, le=10, description="积分系数 Ki")
    kd: float = Field(..., ge=0, le=10, description="微分系数 Kd")
    thought: str = Field(..., description="调整思路")
```

#### 输出格式约束 + 错误处理（核心）

- **`retries=N`**：校验失败时，把错误信息回灌给 LLM 让它自我修正

```python
import instructor
from openai import OpenAI

client = instructor.from_openai(OpenAI())

resp = client.chat.completions.create(
    model="gpt-4",
    response_model=PIDParams,
    max_retries=3,  # 失败时把校验错误回灌，最多 3 次
    messages=[{"role": "user", "content": "..."}],
)
# resp 是 PIDParams 实例，无需手动解析
```

底层原理（关键借鉴点）：

```python
# 伪代码：Instructor 重试逻辑
for attempt in range(max_retries):
    raw = llm(messages)
    try:
        return PIDParams.model_validate_json(raw)
    except ValidationError as e:
        # 把错误信息加进对话历史
        messages.append({"role": "assistant", "content": raw})
        messages.append({
            "role": "user",
            "content": f"校验失败：{e}. 请修正后重新输出。"
        })
        # 下一轮 LLM 看到自己上次的输出 + 报错，自我修正
```

#### 借鉴价值（极高）

| 点 | 对本项目的意义 |
|---|---|
| retries 把错误回灌 | 当前 5 次退避用相同 prompt，改成回灌错误，效果会显著提升 |
| Pydantic 字段约束 | `ge=0, le=20` 直接限制范围，省掉 clamp 逻辑 |

---

### 4.6 MetaGPT

**仓库**：https://github.com/FoundationAgents/MetaGPT

#### 提示词组织：Action + PROMPT_TEMPLATE 常量

- 每个 `Action` 类内定义 `PROMPT_TEMPLATE` 常量，用 Jinja2 渲染

```python
from metagpt.actions import Action

class WritePIDCode(Action):
    PROMPT_TEMPLATE: str = """
    角色：你是嵌入式工程师。
    任务：根据 PID 参数 {pid} 生成 C 代码。
    输出格式：完整 .c 文件内容，不要解释。
    """
    
    async def run(self, pid: dict):
        prompt = self.PROMPT_TEMPLATE.format(pid=pid)
        return await self.llm.ask(prompt)
```

#### 上下文管理：Message 结构化传递

- `Action` 间用 `Message` 对象传递，不靠字符串拼接

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| PROMPT_TEMPLATE 常量 | 把 prompt 从函数中抽出来，集中管理 |
| Message 结构化 | 当前 user prompt 手拼 JSON，可改成结构化对象 |

---

### 4.7 CrewAI

**仓库**：https://github.com/crewAIInc/crewAI

#### 提示词组织：YAML 三元组

- Agent 的角色身份用 YAML 定义，与 task 分离

```yaml
# agents.yaml
pid_tuner:
  role: >
    PID 控制算法专家
  goal: >
    根据响应指标和历史，给出最优 PID 参数，确保系统稳定、无超调、无震荡
  backstory: >
    你有 20 年工业控制经验，精通 Ziegler-Nichols、Cohen-Coon 等
    整定方法，对热系统、电机、机器人控制有丰富实战经验。
```

```python
from crewai import Agent, Task, Crew

tuner = Agent(
    role=pid_tuner_config['role'],
    goal=pid_tuner_config['goal'],
    backstory=pid_tuner_config['backstory'],
    llm=llm,
)

task = Task(
    description="根据指标 {metrics} 调参",
    expected_output="JSON: {kp, ki, kd, thought}",
    agent=tuner,
    output_pydantic=PIDParams,
)

crew = Crew(agents=[tuner], tasks=[task])
result = crew.kickoff(inputs={'metrics': metrics})
```

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| role/goal/backstory 三元组 | 当前 system prompt 一句话，缺"专家身份"与" backstory"，可借鉴 |
| task 与 agent 分离 | 把"调参任务"和"PID 专家身份"解耦 |

---

### 4.8 Anthropic Claude 官方 Prompt Engineering 指南

**文档**：https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags

#### 提示词组织：XML 标签分块

- 用 `<context>` / `<instructions>` / `<example>` 等标签明确分块

```xml
<role>你是 PID 调参助手。</role>

<principles>
1. 稳态优先：首要任务是消除稳态误差。
2. 抑制震荡：任何等幅或发散震荡都不可接受。
3. 防止超调：超调可能导致不可逆后果。
4. 循序渐进：参数调整应平滑，避免剧烈跳变。
5. 借鉴历史：仔细阅读调参历史，避免重复无效方向。
</principles>

<context>
<current_pid>{"kp": 1.0, "ki": 0, "kd": 0}</current_pid>
<metrics>{...}</metrics>
<history>{...}</history>
</context>

<output_format>
输出一个 JSON 对象：{"kp": <0-20>, "ki": <0-10>, "kd": <0-10>, "thought": "..."}
</output_format>
```

#### 输出格式约束：prefill

- 在 assistant 消息里 prefill `{`，强制 JSON 起手

```python
messages = [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "{"}  # prefill
]
# 模型只能接着 { 继续输出 JSON
```

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| XML 标签分块 | 当前 user prompt 是一坨 JSON，可用标签区分"角色/原则/上下文/输出格式" |
| prefill | 强制 JSON 起手，减少解析失败 |

---

### 4.9 coding agent（Cline / Aider）

**仓库**：[cline/cline](https://github.com/cline/cline)、[paul-gauthier/aider](https://github.com/paul-gauthier/aider)

#### 提示词组织

- system prompt 硬编码在源码中，包含 lint 规则、编辑格式、工具调用规范
- Cline 用 `<attempt_completion>` / `<read_file>` / `<search_replace>` 等 XML 工具标签
- Aider 用 search/replace 格式，明确要求"只输出修改块，不要全文重写"

#### 上下文管理

- 自动注入：打开的文件、git diff、最近编辑、目录树
- Aider 用 repo map（token 化的文件结构）控制上下文大小

#### 借鉴价值

| 点 | 对本项目的意义 |
|---|---|
| 自动注入相关文件 | 可类比"自动注入相关历史轮次" |
| 明确输出格式 | search/replace 格式思路：让 LLM 只输出"增量"，不重复全文 |

---

### 4.10 llm-pid-tuner（本项目已借鉴的开源 PID 调参工具）

**仓库**：https://github.com/KINGSTON-115/llm-pid-tuner
**本项目对其分析文档**：[docs/llm-pid-tuner-analysis.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/llm-pid-tuner-analysis.md)

本项目已经借鉴了它的：调参历史作上下文、安全护栏、5 次退避、本地兜底。下面是**还没借鉴**的部分。

#### System Prompt（值得逐字对照）

```
你是一个世界顶级的 PID 控制算法专家...

## 核心原则
1. 稳态优先：首要任务是消除稳态误差。
2. 抑制震荡：任何形式的等幅震荡或发散震荡都是不可接受的。
3. 防止超调：对于热力系统，超调可能导致不可逆的后果。
4. 循序渐进：参数调整应平滑，避免剧烈跳变。
5. 借鉴历史：必须仔细阅读「调参历史」，特别是「AI思考过程」，避免重复无效方向。
```

对比本项目当前 system prompt（[PidPanel.vue:799](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L799)）：

```
你是 PID 调参助手。只输出一个 JSON 对象表示新参数，禁止输出任何解释、说明、
Markdown 代码块或额外文字。输出格式：{formatSpec}。所有数值必须在给定范围内。
必须仔细阅读"调参历史"字段，避免重复无效方向。thought 字段限 100 字内简述调整思路，
须说明当前阶段与本次调整方向。
```

**差距**：
- 缺"世界顶级 PID 控制算法专家"身份定位
- 缺 5 条核心原则（稳态优先 / 抑制震荡 / 防止超调 / 循序渐进 / 借鉴历史）
- 只强调"输出格式"，没强调"调参原则"

#### 输出格式（值得借鉴的 CoT 分层）

llm-pid-tuner 的输出 schema：

```json
{
  "thought_process": "详细推理：1... 2... 3...",
  "analysis_summary": "简短总结（50字内）",
  "tuning_action": "INCREASE_P | DECREASE_P | ... | FINE_TUNE | ADJUST_PID",
  "p": <float>,
  "i": <float>,
  "d": <float>,
  "status": "TUNING | DONE"
}
```

对比本项目当前 schema（[PidPanel.vue:703](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L703)）：

```json
{"kp":<0-20>,"ki":<0-10>,"kd":<0-10>,"thought":"<简短思考>"}
```

**差距**：
- 本项目 `thought` 限 100 字，llm-pid-tuner 分 `thought_process`（详细推理）+ `analysis_summary`（50 字摘要），CoT 更完整
- 本项目没有 `tuning_action` 枚举，模型决策动作不显式
- 本项目没有 `status: "DONE"`，无法让 LLM 主动判断"已调好"

#### 时序数据喂给 AI

llm-pid-tuner 的 `buffer.to_prompt_data` 下采样 30 个点喂给 LLM：

```
## 时间序列数据摘要 (采样 30 点):
Timestamp, Input, PWM, Error
0, 20.00, 0.0, 180.00
200, 21.50, 255.0, 178.50
...
```

**本项目完全没有**——只给 13 项标量指标，模型看不到"波形长什么样"。

---

### 4.11 控制系统 LLM 前沿论文

#### 4.11.1 AgenticControl（arXiv 2506.19160）

**论文**：[arxiv.org/abs/2506.19160](https://arxiv.org/abs/2506.19160)

核心做法：
- **actor-critic 双 agent**：planner 给参数，critic 评估参数好坏
- **阶跃响应曲线作为图像**喂给 VLM（视觉语言模型）
- 实验结果：比 MATLAB PIDTuner 降误差 55%

借鉴价值：
- critic 机制：可加一个"参数自校验"步骤，让 LLM 评估自己输出的参数是否合理
- 响应曲线作为图像：本项目仿真已生成 SVG 波形，可考虑喂给多模态模型

#### 4.11.2 LLM-R2R（arXiv 2511.22975）

**论文**：[arxiv.org/abs/2511.22975](https://arxiv.org/abs/2511.22975)

核心做法：
- **附录完整 agent system prompt** 可直接参考
- **RAG 检索工艺知识库**替代参数记忆，避免幻觉

借鉴价值：
- 前馈整定可借鉴 RAG：把"前馈项物理意义 + 调参经验"建成知识库，让 LLM 检索而非记忆

#### 4.11.3 线性反馈控制用于 prompt 优化（arXiv 2501.11979）

**论文**：[arxiv.org/abs/2501.11979](https://arxiv.org/abs/2501.11979)

用 PID 控制器治理 LLM 输出（把 prompt 当作被控对象）。数学上与本项目主题形成有趣呼应，可参考其"用控制论视角看 prompt 优化"的思路。

#### 4.11.4 数值幻觉治理的 4 大技巧

调研中提炼的避免 LLM 给出不合理 PID 参数的通用技巧：

| 技巧 | 做法 | 对本项目的适用性 |
|---|---|---|
| **RAG 替代参数记忆** | 把工艺参数范围、典型值建知识库，LLM 检索而非凭记忆 | 中：前馈项物理意义可建库 |
| **Chain of Verification** | 让 LLM 输出参数后自校验"合理性" | 高：可加 `self_check` 字段 |
| **Self-Consistency** | 同一 prompt 采样多次取中位数/投票 | 高：前 2 轮盲调阶段最易幻觉 |
| **Highlighted CoT** | 在 prompt 中高亮关键约束（如"超调>5%必须减 Kp"） | 高：当前安全要求太笼统 |

---

## 五、本项目当前提示词实现现状

### 5.1 System Prompt

位置：[PidPanel.vue:799](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L799)

```javascript
const systemContent = `你是 PID 调参助手。只输出一个 JSON 对象表示新参数，禁止输出任何解释、说明、
Markdown 代码块或额外文字。输出格式：${formatSpec}。所有数值必须在给定范围内。必须仔细阅读
"调参历史"字段，避免重复无效方向。thought 字段限 100 字内简述调整思路，须说明当前阶段与本次调整方向。`
```

**特点**：
- 一句话定义角色
- 强调输出格式约束
- 要求读历史
- 限制 thought 字数

**问题**：
- 缺领域专家身份定位（"PID 调参助手"过于平淡）
- 缺核心控制原则（稳态优先、抑制震荡等）
- 只强调"格式约束"，没强调"调参哲学"

### 5.2 User Prompt（结构化 JSON 上下文）

位置：[PidPanel.vue:763](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L763)

结构化为 11 个字段的 JSON：

| 字段 | 作用 |
|---|---|
| 任务 | 明确目标 |
| 输出格式 | 锁定 schema |
| 当前参数 | 起点 |
| 当前阶段 | P/PI/PD/PID |
| 启用积分项 / 启用微分项 | I/D 开关约束 |
| 响应指标 | 13 项标量指标 |
| 超调空间 | 调参余量 |
| 调参历史 | 最近 5 轮文本 |
| 场景 | 物理模型描述 |
| 调参顺序 | 用户优先级 |
| 调参策略 | phaseStrategy 本轮方向 |
| 安全要求 | 硬约束 |

**优点**：结构化、字段清晰、约束明确

**问题**：
- 历史是 Markdown 文本而非结构化 few-shot
- 没有时序波形数据
- 没有针对前馈项的提示

### 5.3 阶段策略提示

位置：[PidPanel.vue:731-761](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L731)

按 P/PI/PD/PID 四阶段生成针对性提示：

```javascript
if (phase === 'P') {
  if (hasOsc) phaseStrategy = `...应减小 Kp 直到震荡消失...`
  else if (curOvershoot > overshootMargin) phaseStrategy = `...应减小 Kp...`
  else if (curOvershoot > overshootLimit) phaseStrategy = `...可保持 Kp 进入 PI...`
  else {
    // 根据 steadyErrRatio 选激进/中等/保守
    phaseStrategy = `...应激进增大 Kp（×1.5~2.0）...`
  }
} else if (phase === 'PI') {
  phaseStrategy = '当前 PI 阶段：P 已调好，加 Ki 消除稳态误差...'
} else {
  phaseStrategy = '当前 PID 阶段：加 Kd 抑制超调/振荡...'
}
```

**优点**：阶段推断与本地策略一致，提示精准

**问题**：
- **没有前馈整定阶段策略**（前馈项 `linear`/`targetDeriv`/`gravity`/`targetSecondDeriv` 没有 phaseStrategy 分支）
- 串级模式没有"先内环后外环"的阶段策略

### 5.4 解析与护栏

位置：[PidPanel.vue:512](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L512)（`parseAiParams`）、[PidPanel.vue:838-870](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L838)

```
AI 响应文本
    │
    ▼
parseAiParams:
  1. 剥离 ```json 代码块
  2. 截取首末 { } 之间内容
  3. JSON.parse
  4. 逐字段校验为有限数
  5. clamp 到安全边界
    │
    ▼
I/D 开关强制约束 + 阶段强制清零 + 噪声禁 Kd
    │
    ▼
applyPidGuardrails（单步增幅限制 + 边界）
    │
    ▼
P 阶段二分法强制覆盖（lastGoodKp / lastBadKp）
```

**优点**：多层防护，护栏完善

**问题**：
- 大量容错逻辑本可由 Structured Output 直接消除
- 解析失败时用相同 prompt 重试，没有把错误反馈给 LLM

### 5.5 重试策略

位置：[PidPanel.vue:802](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L802)

```javascript
const delays = [0, 2, 4, 8, 16]  // 秒
for (let attempt = 0; attempt < delays.length; attempt += 1) {
  // 用相同 system/user prompt 重试
  // 失败原因记录到 lastError
}
```

**问题**：
- 每次重试用**相同 prompt**，Instructor 的做法是把上次输出 + 报错回灌，让 LLM 自我修正

### 5.6 当前实现的优点

| 优点 | 来源 |
|---|---|
| 调参历史作上下文 | 借鉴 llm-pid-tuner |
| 阶段策略 phaseStrategy | 本项目原创 |
| JSON 容错解析（三候选） | 借鉴 llm-pid-tuner |
| 5 次指数退避 | 借鉴 llm-pid-tuner |
| 本地兜底 | 本项目原创 |
| 安全护栏 + 单步增幅 | 借鉴 llm-pid-tuner |
| 二分法强制覆盖 | 本项目原创 |

### 5.7 当前实现的问题

| # | 问题 | 影响 | 对标框架 |
|---|---|---|---|
| P1 | System prompt 缺专家身份与控制原则 | 模糊场景决策不稳健 | llm-pid-tuner、CrewAI |
| P2 | prompt 拼接混在函数里，难维护 | 文档与代码易脱节 | MetaGPT、LangChain |
| P3 | 前馈整定无 prompt 与阶段策略 | **前馈调参效果欠佳的直接原因** | 本项目独有缺口 |
| P4 | 历史是文本而非结构化 few-shot | 模型难归纳"指标→参数"映射 | DSPy |
| P5 | 没喂时序波形 | 模型看不到波形形状 | llm-pid-tuner、AgenticControl |
| P6 | 上下文无 token 裁剪 | 长会话 prompt 膨胀 | LangChain `trim_messages` |
| P7 | 手写解析而非 Structured Output | 大量容错逻辑 | OpenAI、Instructor |
| P8 | thought 限 100 字，CoT 不完整 | 推理不充分易幻觉 | llm-pid-tuner |
| P9 | 串级 6 参数无阶段约束 | 内外环可能同时乱调 | AgenticControl actor-critic |
| P10 | 单次采样，无 Self-Consistency | 易给离谱参数 | 数值任务通用做法 |
| P11 | 无自校验机制 | 幻觉参数无拦截 | AgenticControl critic |
| P12 | 重试用相同 prompt | 格式偶错难恢复 | Instructor retries |
| P13 | 无 prompt 评估集 | 改 prompt 靠体感 | DSPy Evaluate |

---

## 六、可借鉴的改进点（13 条）

### A. 提示词组织

#### 改进点 1：强化 System Prompt——加领域专家身份与控制原则

**对标**：llm-pid-tuner system prompt、CrewAI role/goal/backstory

**当前问题**：[PidPanel.vue:799](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L799) 的 system prompt 只有一句话，缺身份定位与控制原则。

**建议改写**（示例）：

```
你是世界顶级的 PID 控制算法专家，精通电机控制、倒立摆、热系统、串级控制等场景，
熟悉 Ziegler-Nichols、Cohen-Coon、IMC 等整定方法。

## 核心原则
1. 稳态优先：首要任务是消除稳态误差。
2. 抑制震荡：任何形式的等幅震荡或发散震荡都不可接受。
3. 防止超调：超调可能损害被控对象，需严格控制。
4. 循序渐进：参数调整应平滑，单步增幅不超过 3 倍。
5. 借鉴历史：必须仔细阅读"调参历史"，特别是 AI 思考过程，避免重复无效方向。
6. 阶段推进：严格按 P→PI→PID（或 P→PD→PID）阶段推进，不允许跳阶。

## 输出约束
只输出一个 JSON 对象表示新参数，禁止输出任何解释、说明、Markdown 代码块或额外文字。
输出格式：{formatSpec}。所有数值必须在给定范围内。
thought 字段简述调整思路，须说明当前阶段与本次调整方向。
```

**收益**：零成本，对模糊场景决策质量提升明显。

---

#### 改进点 2：把 prompt 抽成模板常量 + 动态拼装

**对标**：MetaGPT `PROMPT_TEMPLATE`、LangChain `PromptTemplate`

**当前问题**：system/user prompt 在 `callAiForPid` 函数内字符串拼接，混在 130 行函数里，[docs/pid-tuning-strategy-and-ai-prompt.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/pid-tuning-strategy-and-ai-prompt.md) 文档与代码分离后难同步。

**建议落地**：

新建 `src/renderer/src/services/prompts/pidPrompts.mjs`：

```javascript
// 提示词常量集中管理
export const PID_SYSTEM_PROMPT_TEMPLATE = `
你是世界顶级的 PID 控制算法专家...

## 核心原则
{principles}

## 输出约束
输出格式：{formatSpec}
`

export const PHASE_STRATEGY = {
  P_OSCILLATING: (peakInfo) => `当前 P 阶段：检测到明显震荡（${peakInfo}）...`,
  P_OVERSHOOT_HIGH: (cur, margin) => `当前 P 阶段：超调 ${cur}% 超出可接受范围（≤${margin}%）...`,
  // ...
}

export const CASCADE_SYSTEM_PROMPT = `
你是世界顶级的串级控制专家...
先调内环（速度环）再调外环（位置环），内环未达标前不要碰外环参数。
`
```

**收益**：
- prompt 可版本化、A/B 测试
- 文档可直接从代码生成，避免脱节
- 后续 i18n 容易

---

#### 改进点 3：前馈整定独立 prompt 与阶段策略

**对标**：本项目独有缺口；可参考 LLM-R2R 的 RAG 思路

**当前问题**：[controlAnalysis.mjs:979](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs#L979) 的 `buildFeedforwardSuggestion` 是启发式每次 15%，但 [PidPanel.vue:731-761](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L731) 的 phaseStrategy 只覆盖 P/PI/PD/PID 四阶段，前馈项（`linear` / `targetDeriv` / `gravity` / `targetSecondDeriv`）没有对应的策略提示和输出 schema。

**这是用户反馈"前馈自动调参效果欠佳"的直接原因之一。**

**建议落地**：

1. 前馈项加入输出 schema：

```javascript
const feedforwardFormatSpec = cascade
  ? '{"speedKp":...,"speedKi":...,...,"ff_linear":<0-2>,"ff_targetDeriv":<0-2>,"ff_gravity":<0-2>,"thought":"<...>"}'
  : '{"kp":...,"ki":...,"kd":...,"ff_linear":<0-2>,"ff_targetDeriv":<0-2>,"ff_gravity":<0-2>,"thought":"<...>"}'
```

2. 新增前馈阶段策略：

```javascript
function buildFeedforwardStrategy(metrics, currentFF, ffEnabled) {
  if (!ffEnabled.length) return null
  
  const strategies = []
  if (ffEnabled.includes('linear')) {
    const steadyErr = metrics.steadyError ?? 0
    if (steadyErr > 0.5) strategies.push(`前馈 linear 不足（稳态误差 ${steadyErr.toFixed(2)} > 0），应增大`)
    else if (steadyErr < -0.5) strategies.push(`前馈 linear 过度（稳态误差 ${steadyErr.toFixed(2)} < 0），应减小`)
  }
  if (ffEnabled.includes('gravity')) {
    const overshoot = metrics.overshoot ?? 0
    if (overshoot > 10 && steadyErr > 0.5) strategies.push(`重力补偿不足，应增大 ff_gravity`)
    else if (overshoot > 15) strategies.push(`重力补偿过度，应减小 ff_gravity`)
  }
  // ...
  return strategies.join('；')
}
```

3. system prompt 补充前馈知识：

```
## 前馈整定原则
前馈与 PID 解耦整定：调 PID 时前馈不变，调前馈时 PID 不变。
- linear（Kff·target）：根据稳态误差方向调整，正误差增大，负误差减小
- targetDeriv（Kff·d(target)/dt）：超调小且响应慢时增大，超调大时减小
- gravity（重力补偿）：稳态误差大且无超调时增大，超调大时减小
- targetSecondDeriv：与 targetDeriv 同向
每次调整幅度建议 10%~20%，避免突变。
```

---

### B. 上下文管理

#### 改进点 4：历史打包成结构化 few-shot 范例

**对标**：DSPy `BootstrapFewShot`、Anthropic few-shot 指南

**当前问题**：[historyToPromptText](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs#L1075) 把历史拼成 Markdown 文本，模型需自己归纳"指标→参数"映射。

**建议落地**：

额外挑 1~2 个"成功范例"以 JSON few-shot 形式注入：

```javascript
// 在 user prompt 中新增 few_shot_examples 字段
const fewShotExamples = pickSuccessfulExamples(tuningHistory.value, 2)

userContent = JSON.stringify({
  // ... 原有字段
  few_shot_examples: fewShotExamples.map(r => ({
    input: { 指标: r.metrics, 当前参数: r.pid, 阶段: r.phase },
    output: { 新参数: r.proposedPid, thought: r.thought },
    结果: r.nextMetrics ? `下一轮指标改善：超调 ${r.metrics.overshoot}% → ${r.nextMetrics.overshoot}%` : '成功收敛'
  }))
})
```

**收益**：DSPy 的核心发现是 few-shot 范例比自然语言指令有效得多。

---

#### 改进点 5：把时序波形数据喂给 AI

**对标**：llm-pid-tuner `buffer.to_prompt_data` 下采样 30 点、AgenticControl 把响应曲线作为图像

**当前问题**：只给 13 项标量指标，模型看不到"波形长什么样"——是单调收敛还是振荡收敛，是慢爬还是过冲，光看数字难以判断。

**建议落地**：

参考 llm-pid-tuner 的 `to_prompt_data`，把仿真已有的 `samples` 下采样后塞进 user prompt：

```javascript
function downsampleWaveform(samples, targetPoints = 30) {
  if (samples.length <= targetPoints) return samples
  const step = Math.floor(samples.length / targetPoints)
  const result = []
  for (let i = 0; i < samples.length; i += step) {
    result.push(samples[i])
  }
  return result.slice(0, targetPoints)
}

// 在 user prompt 中新增 时序数据 字段
const waveform = downsampleWaveform(metrics.samples ?? [], 30)
userContent = JSON.stringify({
  // ... 原有字段
  时序数据: waveform.map(s => ({
    t: s.t.toFixed(3),
    target: s.target.toFixed(3),
    actual: s.actual.toFixed(3),
    error: (s.target - s.actual).toFixed(3)
  }))
})
```

**收益**：模型能直接看到波形形状，对"振荡 vs 单调"的判断更准。

---

#### 改进点 6：上下文按 token 预算裁剪

**对标**：LangChain `trim_messages`

**当前问题**：[historyToPromptText](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs#L1075) 固定取最近 5 轮，每轮字段截断 500 字符。但随着轮数增加 + 串级 6 参数 + 前馈项，prompt 仍会膨胀。

**建议落地**：

```javascript
function trimHistoryByTokenBudget(history, maxChars = 2000) {
  let total = 0
  const result = []
  // 从最近往前取
  for (let i = history.length - 1; i >= 0; i--) {
    const round = history[i]
    // 近 2 轮保留完整 thought，早期只保留参数+状态
    const entry = (history.length - i <= 2)
      ? formatFullRound(round)
      : formatCompactRound(round)  // 只保留 参数+状态+评分
    total += entry.length
    if (total > maxChars) break
    result.unshift(entry)
  }
  return result.join('\n')
}
```

**收益**：长会话不爆 prompt，早期轮信息不丢（压缩为关键字段）。

---

### C. 输出格式约束

#### 改进点 7：用 Structured Output / JSON Schema 替代手写解析

**对标**：OpenAI `response_format={"type":"json_schema"}` strict mode、Instructor、LangChain `with_structured_output`

**当前问题**：[parseAiParams](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L512) 做了"剥代码块→截{}→JSON.parse→逐字段校验→clamp"共 5 步容错。如果用户的 LLM 后端支持 OpenAI 兼容的 `response_format: json_schema`（多数国产 API 已支持：DeepSeek、智谱、Kimi、通义千问），可直接传 schema 让模型**结构上不可能**输出非法格式。

**这是投入产出比最高的一项。**

**建议落地**：

```javascript
const pidSchema = {
  type: 'object',
  properties: {
    kp: { type: 'number', minimum: 0, maximum: 20 },
    ki: { type: 'number', minimum: 0, maximum: 10 },
    kd: { type: 'number', minimum: 0, maximum: 10 },
    thought: { type: 'string', maxLength: 200 }
  },
  required: ['kp', 'ki', 'kd', 'thought'],
  additionalProperties: false
}

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify({
    model: props.aiConfig.model,
    temperature: 0.2,
    messages: [...],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'pid_params', schema: pidSchema, strict: true }
    },
    stream: false
  })
})
```

**收益**：
- 省掉 `parseAiParams` 大半逻辑（剥代码块、截 {}、JSON.parse 失败处理）
- 数值范围直接由 schema 约束，`clamp` 变成兜底
- `additionalProperties: false` 防止模型输出多余字段

**注意**：
- 需检测后端是否支持（可加一个 `aiConfig.supportsJsonSchema` 配置项，不支持时回退到当前逻辑）
- 国产 API 的 json_schema 字段名可能略有差异，需测试

---

#### 改进点 8：让 LLM 输出完整推理链而非 100 字摘要

**对标**：llm-pid-tuner `thought_process` + `analysis_summary`、Anthropic CoT 指南

**当前问题**：[PidPanel.vue:704](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L704) 的 schema `thought` 限 100 字，模型为了压缩会省略推理。对数值调参任务，CoT 越完整越不容易给幻觉参数。

**建议落地**：

拆成两字段：

```javascript
const formatSpec = cascade
  ? '{"speedKp":...,"thought_process":"<详细推理：1... 2... 3...>","analysis_summary":"<50字摘要>"}'
  : '{"kp":...,"thought_process":"<详细推理>","analysis_summary":"<50字摘要>"}'
```

system prompt 配套说明：

```
thought_process 字段：详细写出推理过程（1. 分析指标 2. 判断阶段 3. 决定调整方向 4. 估算参数），
不限字数。analysis_summary 字段：50 字内简述本次调整。
```

**收益**：CoT 完整后，模型对参数的"为什么"想得更清楚，幻觉率下降。

---

#### 改进点 9：串级 6 参数 schema 加阶段强制约束

**对标**：AgenticControl actor-critic（先内环后外环）

**当前问题**：[PidPanel.vue:703](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L703) 串级 schema 6 个参数都允许非 0，但阶段策略（P/PI/PD）只对单环有意义。串级应是"先内环后外环"，内环没调好不该碰外环。

**建议落地**：

引入串级阶段：

```javascript
const cascadePhase = inferCascadePhase(currentParams, metrics)
// 'SPEED_P' → 'SPEED_PI' → 'SPEED_PID' → 'POSITION_P' → 'POSITION_PI' → 'POSITION_PID'

const phaseStrategy = buildCascadePhaseStrategy(cascadePhase, metrics)
// SPEED_P 阶段：positionKp/Ki/Kd 必须为 0，只调 speedKp
// SPEED_PID 达标后：解锁 position 环，进入 POSITION_P
```

system prompt 补充：

```
## 串级控制原则
先调内环（速度环）再调外环（位置环）。
内环未达标（rmse > 阈值 或 不稳定）前，外环参数必须保持 0。
内环达标后，外环以"内环已闭合"为前提整定。
```

---

### D. 数值可靠性（避免幻觉参数）

#### 改进点 10：Self-Consistency 多采样投票

**对标**：数值任务标准做法

**当前问题**：[PidPanel.vue:815](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L815) `temperature: 0.2` 单次调用。对"给具体数值"这种易幻觉任务，单次采样风险高。

**建议落地**：

```javascript
async function callAiForPidWithSelfConsistency(metrics, options, n = 3) {
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      callAiForPidOnce(metrics, options, { temperature: 0.7 })
    )
  )
  const valid = results.filter(Boolean)
  if (valid.length === 0) return null
  // 取中位数（比均值更鲁棒）
  return {
    kp: median(valid.map(r => r.kp)),
    ki: median(valid.map(r => r.ki)),
    kd: median(valid.map(r => r.kd)),
    thought: valid[0].thought  // 任取一个
  }
}
```

**使用策略**：
- 前 2 轮（盲调阶段）用 n=3，最易幻觉
- 后期单次即可（已有历史参考）

**权衡**：开销 3 倍 token，但显著降低离谱参数。可做成配置项 `aiConfig.selfConsistency: number`。

---

#### 改进点 11：Chain of Verification——让模型自校验输出合理性

**对标**：AgenticControl critic、Chain of Verification 论文

**当前问题**：模型输出参数后无自校验，幻觉参数直接进护栏。

**建议落地**：

在 schema 中加 `self_check` 字段：

```javascript
const formatSpec = `{"kp":...,"ki":...,"kd":...,
  "thought_process":"<推理>",
  "self_check":"<自检：本轮输出 Kp=X，预期会让超调从 A% 降到 B%，依据是...>"}`
```

护栏层加自检逻辑：

```javascript
function validateSelfCheck(parsed, metrics) {
  // 简单规则：如果 self_check 提到"增大 Kp"但实际 kp 减小了，标记异常
  const mentionsIncrease = /增大|增加|提高/.test(parsed.self_check)
  const actualIncreased = parsed.kp > (currentParams.kp ?? 0)
  if (mentionsIncrease && !actualIncreased) {
    return { ok: false, reason: 'self_check 与实际方向矛盾' }
  }
  return { ok: true }
}

// 在 callAiForPid 解析后
const check = validateSelfCheck(parsed, metrics)
if (!check.ok) {
  // 触发重试，把矛盾反馈给 LLM
  lastError = check.reason
  continue
}
```

---

### E. 错误处理与评估

#### 改进点 12：重试时把解析错误反馈给 LLM

**对标**：Instructor `retries`、LangChain `OutputFixingParser`

**当前问题**：[PidPanel.vue:802-827](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue#L802) 的 5 次退避用**相同 prompt**重试。

**建议落地**（参考 Instructor 底层原理）：

```javascript
const messages = [
  { role: 'system', content: systemContent },
  { role: 'user', content: userContent }
]

for (let attempt = 0; attempt < maxRetries; attempt++) {
  if (delays[attempt] > 0) await delay(delays[attempt] * 1000)
  
  const res = await fetch(url, { ...body: { messages } })
  const raw = (await res.json()).choices?.[0]?.message?.content
  const parsed = parseAiParams(raw, cascade)
  
  if (parsed) return parsed
  
  // 失败时把上次输出 + 报错加入对话，让 LLM 自我修正
  messages.push({ role: 'assistant', content: raw })
  messages.push({
    role: 'user',
    content: `上一轮输出无法解析，错误：${lastError}。请重新输出一个严格的 JSON 对象，格式：${formatSpec}`
  })
}
```

**收益**：对"格式偶发出错"比单纯重试有效得多——LLM 看到自己上次的错误，会主动规避。

---

#### 改进点 13：建立 prompt 评估集

**对标**：DSPy `Evaluate`、OpenAI Evals

**当前问题**：没有量化评估 prompt 改动好坏的方法，改 prompt 靠体感。

**建议落地**：

1. 固定 5~10 个典型场景：

```javascript
// tests/prompt-eval-scenarios.mjs
export const EVAL_SCENARIOS = [
  {
    name: '电机速度环-慢响应',
    strategy: 'motor_speed',
    initialPid: { kp: 0.5, ki: 0, kd: 0 },
    expectedBehavior: '应在 3 轮内 rmse 下降 50% 以上'
  },
  {
    name: '倒立摆-失稳',
    strategy: 'inverted_pendulum',
    initialPid: { kp: 2, ki: 0, kd: 0 },
    expectedBehavior: '应减小 Kp 至稳定，不撞护栏'
  },
  {
    name: '串级位置环-外环振荡',
    strategy: 'cascade_position',
    initialPid: { speedKp: 5, positionKp: 8, ... },
    expectedBehavior: '应先调内环，外环不动'
  },
  // ... 5~10 个场景
]
```

2. 评估脚本：

```javascript
// tests/eval-prompt.mjs
async function evaluatePrompt(systemPrompt, userPromptTemplate) {
  const results = []
  for (const scenario of EVAL_SCENARIOS) {
    const session = createTuningSession(scenario)
    for (let round = 1; round <= 10; round++) {
      const metrics = await simulate(scenario, session.currentPid)
      const aiParams = await callAiForPid(metrics, { ...scenario, systemPrompt, userPromptTemplate })
      session.applyParams(aiParams)
    }
    results.push({
      scenario: scenario.name,
      rounds: session.roundCount,
      finalRmse: session.bestMetrics.rmse,
      hitGuardrail: session.hitGuardrailCount,
      rolledBack: session.rolledBack,
      passed: checkExpectedBehavior(session, scenario.expectedBehavior)
    })
  }
  return results
}
```

3. 改 prompt 时跑一遍，用数据说话。

**收益**：
- 改 prompt 有量化依据
- 回归测试：新 prompt 不能让已通过的场景变差

---

## 七、优先级建议

按"投入产出比"排序：

### 优先级 P0（先做，立即见效）

| # | 改进点 | 投入 | 收益 |
|---|---|---|---|
| **7** | Structured Output 替代手写解析 | 改 `response_format` 一行配置 + 加 schema | 直接干掉大部分解析失败，立刻见效 |
| **1** | 强化 system prompt（加专家身份 + 5 条原则） | 零成本，改字符串 | 模糊场景决策质量提升明显 |
| **3** | 前馈独立 prompt 与阶段策略 | 中等，需补 schema + phaseStrategy 分支 | 直接回应"前馈自动调参效果欠佳" |

### 优先级 P1（中期，质量提升）

| # | 改进点 | 投入 | 收益 |
|---|---|---|---|
| **4** | 历史打包成结构化 few-shot | 小，改 `historyToPromptText` | 模型归纳"指标→参数"更准 |
| **5** | 把时序波形喂给 AI | 小，下采样后塞进 prompt | 模型能看波形形状 |
| **8** | thought 拆成推理链 + 摘要 | 小，改 schema | CoT 完整，幻觉率下降 |
| **12** | 重试时把错误反馈给 LLM | 小，改 retry 循环 | 格式偶错易恢复 |

### 优先级 P2（后期，打磨阶段）

| # | 改进点 | 投入 | 收益 |
|---|---|---|---|
| **9** | 串级阶段强制约束 | 中，需改阶段推断 | 内外环不乱调 |
| **2** | prompt 抽成模板常量 | 中，重构 | 可维护性、A/B 测试 |
| **6** | 上下文 token 预算裁剪 | 小 | 长会话不爆 prompt |
| **10** | Self-Consistency 多采样 | 大（3 倍 token） | 盲调阶段降幻觉 |
| **11** | Chain of Verification 自校验 | 中 | 幻觉参数拦截 |
| **13** | prompt 评估集 | 大 | 改 prompt 有量化依据 |

### 建议执行顺序

1. **先做 #7 + #1**（一天内能完成，立刻见效）
2. **再做 #3**（前馈独立 prompt，直击用户痛点）
3. **接着 #4 + #5 + #8 + #12**（上下文与 CoT 优化）
4. **后期 #9 + #2 + #6**（架构优化）
5. **最后 #10 + #11 + #13**（高级可靠性 + 评估）

---

## 八、参考资料

### 框架与库

- OpenAI Agents SDK：https://github.com/openai/openai-agents-python
- LangChain Prompt Templates：https://python.langchain.com/docs/concepts/prompt_templates/
- LangChain trim_messages：https://python.langchain.com/docs/how_to/trim_messages/
- Microsoft AutoGen：https://github.com/microsoft/autogen
- DSPy：https://github.com/stanfordnlp/dspy
- Instructor：https://github.com/jxnl/instructor
- MetaGPT：https://github.com/FoundationAgents/MetaGPT
- CrewAI：https://github.com/crewAIInc/crewAI

### 官方提示词指南

- Anthropic Claude Prompt Engineering：https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
- Anthropic Structured Output：https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- OpenAI Structured Outputs：https://platform.openai.com/docs/guides/structured-outputs
- OpenAI Cookbook - Structured outputs：https://cookbook.openai.com/examples/structured_outputs_with_demo

### 控制系统 LLM 论文

- AgenticControl：https://arxiv.org/abs/2506.19160
- LLM-R2R：https://arxiv.org/abs/2511.22975
- Linear Feedback Control for Prompt Optimization：https://arxiv.org/abs/2501.11979

### Coding Agent

- Cline：https://github.com/cline/cline
- Aider：https://github.com/paul-gauthier/aider

### 本项目关联文档

- PID 调参策略与 AI 提示词组织：[docs/pid-tuning-strategy-and-ai-prompt.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/pid-tuning-strategy-and-ai-prompt.md)
- llm-pid-tuner 项目分析报告：[docs/llm-pid-tuner-analysis.md](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/docs/llm-pid-tuner-analysis.md)

### 本项目关联代码

- `callAiForPid`：[src/renderer/src/components/PidPanel.vue](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/components/PidPanel.vue) 的 701-870 行
- `parseAiParams`：同文件 512 行
- `historyToPromptText`：[src/renderer/src/services/controlAnalysis.mjs](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/controlAnalysis.mjs) 1075 行
- `buildFeedforwardSuggestion`：同文件 979 行
- `applyPidGuardrails`：[src/renderer/src/services/pidSafety.mjs](file:///d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant/ai-serial-assistant-app/src/renderer/src/services/pidSafety.mjs)

---

> 本文档为调研总结，未修改任何代码文件。落地实施时建议按优先级逐项进行，每项改动后用固定场景回归测试。

## 九、2026-08-08 首轮落地情况

本轮按“高收益、兼容现有 OpenAI-compatible 多模型接口”的原则完成以下改进：

1. 新增 `pidPrompt.mjs` 集中管理 PID 输出 Schema、系统提示词、波形压缩、历史裁剪、成功案例选择和解析修复提示。
2. 默认尝试 `response_format: json_schema` 严格结构化输出；若接口返回 400/404/422，则自动退回普通 JSON 提示词，兼容尚未支持 JSON Schema 的 DeepSeek 或其他兼容后端。
3. AI 上下文新增最多 30 点的均匀下采样波形，保留首尾点，并提供 target、feedback、error、output。
4. 调参历史改为结构化数组并按字符预算从近到远裁剪；从历史相邻轮中自动挑选“下一轮确有改善”的案例作为 verified few-shot。
5. 提示词明确区分“待验证候选”和“已验证结果”，强化稳定性、超调、稳态误差、响应速度四级目标，并加入串级和前馈约束。
6. 重试不再机械重复相同请求：解析或字段校验失败后，将模型上次输出及具体错误回灌，让模型自我修正。
7. 未要求或存储完整隐藏思维链，改用可审计的 `analysis_summary`（工程依据）和 `self_check`（边界、阶段、步幅、预期效果自检）。
8. 保留原有确定性护栏和离线规则引擎；结构化输出只负责提高格式可靠性，不能绕过参数边界、阶段约束和仿真验证。

暂未直接启用 Self-Consistency 三采样，原因是调用成本约为单次的三倍；后续应先用固定评估集证明收益，再决定是否做成可选项。串级“先内环后外环”也未强制切换，因为当前仿真只提供外环综合响应，缺少独立内环阶跃指标，强制阶段推进会制造未经测量支持的判断。
