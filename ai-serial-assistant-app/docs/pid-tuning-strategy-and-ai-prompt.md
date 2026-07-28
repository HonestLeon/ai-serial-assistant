# PID 自动调参：本地策略与 AI 提示词组织

> 本文档面向二次开发者，说明 PID 自动调参模块中**本地确定性策略**与**喂给 AI 的提示词**是如何组织的、两者如何协作。
> 对应代码：`src/renderer/src/services/controlAnalysis.mjs`（本地策略）、`src/renderer/src/components/PidPanel.vue`（提示词组装与调用）。

---

## 一、总体架构：本地优先、AI 增强、护栏兜底

```
                   ┌─────────────────────────────────────┐
 仿真/串口采样 ───► │ analyzeControlSamples（确定性指标）  │
                   └──────────────┬──────────────────────┘
                                  │ metrics
                   ┌──────────────▼──────────────────────┐
                   │ buildFeedforwardSuggestion（前馈整定）│ ── 与 PID 解耦，启发式微调
                   └──────────────┬──────────────────────┘
                                  │
                   ┌──────────────▼──────────────────────┐
                   │ buildPidSuggestion（本地候选基线）    │ ── 分阶段 + 二分法 + tuningOrder 衰减
                   └──────────────┬──────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │无 API Key         │有 API Key          │
              ▼                   ▼                    │
     直接用本地候选        callAiForPid（AI 增强）      │
                            │ 5 次指数退避重试           │
                            ▼                          │
                    applyPidGuardrails（安全护栏裁剪）◄─┘
                            │
                    ┌───────┴───────┐
                    ▼               ▼
              AI 成功 → 用    AI 失败 → buildFallbackSuggestion
              AI 参数          规则兜底（按 status 乘性修正）
```

**三条铁律**：
1. **本地策略永远先跑**：即使配了 AI Key，本地候选也作为基线，AI 失败时直接回退到基线，流程不中断。
2. **AI 只给参数、不做解释**：提示词强制 AI 输出单个 JSON 对象，禁止任何 Markdown/解释/额外文字。
3. **所有参数经安全护栏**：无论来自本地策略还是 AI，最终都要过 `applyPidGuardrails` 裁剪边界与单步增幅。

---

## 二、本地确定性策略：`buildPidSuggestion`

位于 `controlAnalysis.mjs`，纯函数、无副作用、可离线运行。

### 2.1 分阶段调参（核心设计）

策略根据当前参数中 I/D 是否启用，推断调参阶段，**严格按阶段推进，不允许跳阶**：

| 阶段 | 触发条件 | 调整重点 | 强制约束 |
|------|----------|----------|----------|
| **P** | 初始 / 仅 Kp>0 | 在可接受超调内尽量增大 Kp | Ki=Kd=0 |
| **PI** | P 调好后加 Ki | 消除稳态误差，Ki 从小到大 | Kd=0 |
| **PD** | 不稳定系统（倒立摆）起步 | 保留 Kd 阻尼，仅调 Kp | Ki=0 |
| **PID** | PI 后仍有振荡，加 Kd | 增加阻尼抑制超调/振荡 | — |

**阶段切换条件**（以稳定系统 P→PI 为例）：
- Kp 二分区间已收敛（上下界差 < 均值 10%）→ 进入 PI
- Kp 已达上限但仍无超调 → 进入 PI
- 超调已接近验收标准 → 进入 PI

**I/D 开关约束**：用户可在 UI 关闭 I 或 D（选 P/PI/PD 模式），策略会覆盖推断结果：
- `disableI=true` → 不允许 PI/PID 阶段（Ki 永远 0）
- `disableD=true` → 不允许 PD/PID 阶段（Kd 永远 0）
- 两者都禁 → 只允许 P 阶段

### 2.2 Kp 二分法（P/PD 阶段核心）

借鉴 `llm-pid-tuner` 的二分搜索，快速逼近 Kp 临界值：

- **下界 `lastGoodKp`**：从调参历史中提取，无超调（<3%）无震荡的最大 Kp
- **上界 `lastBadKp`**：从历史中提取，超调超限或有明显震荡的最小 Kp
- **当前坏（超调/震荡）**：取 `(lastGoodKp + currentKp) / 2` 向下界靠
- **当前好**：取 `(currentKp + lastBadKp) / 2` 向上界靠
- **区间收敛**：上下界差 < 均值 10% → 进入下一阶段

**失稳检测**（不稳定系统专用）：振荡 >50% 且稳态误差 >100% → Kp 严重不足，激进增大（×1.6~3.0）。

### 2.3 修正系数表（经验启发式）

每个阶段根据指标给出**乘性修正因子**，典型值：

| 场景 | P | I | D | 说明 |
|------|---|---|---|------|
| P 阶段超调超限 | 0.7 | — | — | 减小 Kp |
| P 阶段稳态误差大 | ×2.0 | — | — | 激进增大 Kp |
| P 阶段稳态误差小 | ×1.25 | — | — | 保守增大 Kp |
| PI 引起超调 | 0.9 | 0.85 | — | 降 P/Ki |
| PI 稳态误差大 | — | ×2.0 | — | 激进增大 Ki |
| PID 超调/震荡 | — | 0.5 | — | 优先减小 Ki |
| PID 稳态振幅>3% | — | — | ×1.4 | 增大 Kd 阻尼 |
| PID 噪声大 | — | — | 0 | 关闭 Kd 回到 PI |

### 2.4 tuningOrder 顺序衰减

`buildPidSuggestion` 接收 `options.tuningOrder`（用户可在 UI 用 ↑/↓ 调整），按位置对修正幅度做指数衰减：

```javascript
const orderFactor = 1 + (factor - 1) * Math.pow(0.5, posIdx)
// posIdx=0 → 完整修正；posIdx=1 → 50%修正；posIdx=2 → 25%修正…
```

**串级环路权重**：再叠加 `spec.loop`（内环 0.3、外环 1.0），体现「先内环后外环」惯例：
```javascript
const finalFactor = 1 + (orderFactor - 1) * spec.loop
```

> **前馈项在 tuningOrder 中的处理**：UI 显示的前馈项 id（如 `linear`）不在 `PARAM_SPEC` 的 `orderName` 中，`indexOf` 返回 -1 时 `posIdx` 回退到 0，不影响 PID 算法——前馈系数由独立的 `buildFeedforwardSuggestion` 整定。

### 2.5 阶段强制清零

每轮修正后，按当前阶段强制清零不应启用的项：
- P 阶段：Ki=Kd=0
- PI 阶段：Kd=0
- PD 阶段：Ki=0

确保参数与阶段始终一致，不会因为历史残留导致「P 阶段却有 Ki」的矛盾。

---

## 三、前馈系数整定：`buildFeedforwardSuggestion`

位于 `controlAnalysis.mjs`，与 PID 调参**完全解耦**——PID 调参时前馈系数不变，前馈整定时 PID 参数不变。

### 3.1 整定逻辑（启发式，每次调整 15%）

| 前馈项 | 调整依据 | 增大条件 | 减小条件 |
|--------|----------|----------|----------|
| `linear`（Kff·target） | 稳态误差方向 | 稳态误差>0（前馈不足） | 稳态误差<0（前馈过度） |
| `targetDeriv`（Kff·d(target)/dt） | 超调 + 响应速度 | 超调小且稳态误差大（响应慢） | 超调大（动态项太大） |
| `gravity`（重力补偿） | 超调 + 稳态误差 | 稳态误差大且无超调（补偿不足） | 超调大（补偿过度） |
| `targetSecondDeriv` | 与 targetDeriv 同向 | 响应偏慢 | 超调偏大 |

### 3.2 调用时机

- **手动分析**（`analyzeResponse`）：勾选了前馈项时，每轮分析都会调用
- **自动调参**（`runAutoTuning`）：每轮仿真后、生成下一轮候选前调用

---

## 四、AI 提示词组织：`callAiForPid`

位于 `PidPanel.vue`，仅在配置了 `aiConfig.apiKey` 时触发。

### 4.1 System Prompt（角色与输出约束）

```
你是 PID 调参助手。只输出一个 JSON 对象表示新参数，禁止输出任何解释、说明、
Markdown 代码块或额外文字。输出格式：{formatSpec}。
所有数值必须在给定范围内。必须仔细阅读"调参历史"字段，避免重复无效方向。
thought 字段限 100 字内简述调整思路，须说明当前阶段与本次调整方向。
```

**设计意图**：
- 强制 JSON 输出，便于 `parseAiParams` 严格解析（剥离 ```json 代码块、截取首末 `{}`、JSON.parse、逐字段校验）
- 明确禁止解释/Markdown，避免 AI 输出冗长文字干扰解析
- 要求阅读历史，避免重复无效方向

### 4.2 User Prompt（结构化 JSON 上下文）

用户消息是一个格式化的 JSON 对象，包含 10 个字段：

```json
{
  "任务": "根据响应指标、当前参数、调参历史和当前阶段，给出新的 PID 参数。只输出一个 JSON 对象...",
  "输出格式": "{\"kp\":<0-20>,\"ki\":<0-10>,\"kd\":<0-10>,\"thought\":\"<简短思考>\"}",
  "当前参数": { "kp": 1.0, "ki": 0, "kd": 0 },
  "当前阶段": "P",
  "启用积分项": "是（Ki 可非 0）",
  "启用微分项": "是（Kd 可非 0）",
  "响应指标": {
    "状态": "STABLE",
    "超调率": 5.2,
    "上升时间": 0.12,
    "稳定时间": 0.45,
    "稳态误差": 0.03,
    "均方根误差": 0.08,
    "振荡": 1.5,
    "振荡峰数": 2,
    "振荡频率": null,
    "最大峰振幅百分比": 3.1,
    "明显震荡": "否",
    "采样点数": 400,
    "反馈噪声大": "否"
  },
  "超调空间": {
    "当前超调率": "5.2%",
    "验收标准": "10%",
    "可接受上限": "12.0%（P 阶段允许达到此值以最大化 Kp）"
  },
  "调参历史": "（暂无历史，这是第一轮）| 第1轮: kp=1.0 → 超调5.2%, ...",
  "场景": "仿真测试；模型：J·dω/dt + B·ω = Kt·i",
  "调参顺序": ["Kp", "Ki", "Kd"],
  "调参策略": "当前 P 阶段：超调 5.2% 远低于验收标准 10%，无明显震荡。稳态误差较大，应激进增大 Kp（×1.5~2.0）...",
  "安全要求": "参数必须循序渐进，单步增幅不得超过 3 倍。借鉴历史中的 AI 思考，避免重复无效方向。若'启用积分项/启用微分项'为否，对应 Ki/Kd 必须输出 0。"
}
```

### 4.3 各字段设计意图

| 字段 | 作用 | 设计要点 |
|------|------|----------|
| **任务** | 明确目标 | 强制「只输出一个 JSON 对象」，与 system prompt 双重约束 |
| **输出格式** | 锁定 schema | 单环/串级不同格式；含数值范围约束 |
| **当前参数** | 起点 | 让 AI 知道从哪里开始调 |
| **当前阶段** | 调参方向 | P/PI/PD/PID，与本地策略推断一致 |
| **启用积分项/微分项** | I/D 开关约束 | 关闭时 AI 必须输出对应项为 0 |
| **响应指标** | 决策依据 | 13 项指标，含状态/超调/上升时间/稳定时间/稳态误差/RMSE/振荡/噪声等 |
| **超调空间** | 调参余量 | 告诉 AI 当前超调距验收标准还有多少空间，P 阶段允许到 1.2 倍 |
| **调参历史** | 避免重复 | 最近 5 轮的参数+指标+AI思考，让 AI 借鉴历史方向 |
| **场景** | 物理模型 | 仿真模式给模型描述，串口模式给阶跃幅值 |
| **调参顺序** | 用户优先级 | 前馈项在前，PID 项在后；AI 据此判断哪些参数更重要 |
| **调参策略** | 本轮方向 | 按阶段生成针对性提示，明确告诉 AI 本轮该做什么 |
| **安全要求** | 硬约束 | 单步增幅≤3倍 + I/D 开关约束 + 借鉴历史 |

### 4.4 阶段策略提示（`phaseStrategy`）

按当前阶段生成**针对性**提示，让 AI 明确本轮调整方向：

- **P 阶段**：
  - 有震荡 → 减小 Kp 直到震荡消失
  - 超调超限 → 减小 Kp
  - 超调接近上限 → 保持 Kp，可进入 PI
  - 无超调 → 根据稳态误差选择激进/中等/保守增大 Kp
- **PI 阶段**：P 已调好，加 Ki 消除稳态误差，超调时降 P/Ki
- **PID 阶段**：加 Kd 抑制超调/振荡，噪声大时禁止加 Kd

### 4.5 I/D 开关在提示词中的体现

```json
"启用积分项": "是（Ki 可非 0）" | "否（Ki 必须为 0，仅 P/PD 模式）"
"启用微分项": "是（Kd 可非 0）" | "否（Kd 必须为 0，仅 P/PI 模式）"
```

并在 `安全要求` 中再次强调：`若"启用积分项/启用微分项"为否，对应 Ki/Kd 必须输出 0。`

### 4.6 5 次指数退避重试

```
delays = [0, 2, 4, 8, 16]  // 秒
```

- 首次立即重试
- 后续按 2/4/8/16 秒退避
- 每次都用相同的 system/user prompt
- 5 次全失败 → 回退到 `buildFallbackSuggestion` 规则兜底

### 4.7 解析与护栏

```
AI 响应文本
    │
    ▼
parseAiParams:
  1. 剥离 ```json 代码块
  2. 截取首末 { } 之间内容
  3. JSON.parse
  4. 逐字段校验为有限数
  5. clamp 到安全边界（Kp 0~20, Ki/Kd 0~10）
    │
    ▼
applyPidGuardrails:
  1. 边界裁剪（与解析阶段重复，双保险）
  2. 单步增幅限制（Kp ×3, Ki/Kd ×4）
  3. 返回 { params, notes }
    │
    ▼
applyCanonicalPid → outputParams（UI 实时更新）
```

---

## 五、自动调参闭环：`runAutoTuning`

仅仿真模式可用，构成完整闭环。

### 5.1 双引擎选择

| 引擎 | 条件 | 行为 |
|------|------|------|
| `hybrid` | 有 API Key | AI 给参 + 安全护栏；AI 失败自动切本地规则 |
| `local` | 无 API Key | 纯 `buildFallbackSuggestion` + 护栏，**离线可用** |

### 5.2 单轮流程

```
for round = 1..maxRounds:
  1. simulatePidStrategy → 采样（一次性算完）
  2. analyzeControlSamples → 指标
  3. registerTuningRound → 会话状态机评价
     ├─ rollback  → 回退到 bestStable，streak 清零，continue
     ├─ complete  → 终止，应用最佳参数
     ├─ stagnated → 终止，恢复最佳参数
     └─ max-rounds → 终止，恢复最佳参数
  4. buildFeedforwardSuggestion → 微调前馈系数（若有勾选）
  5. 生成下一轮候选：
     ├─ hybrid: callAiForPid（AI + 护栏）
     └─ local/AI失败: buildFallbackSuggestion + applyPidGuardrails
  6. applyCanonicalPid → 应用候选到 outputParams
```

### 5.3 会话状态机（`pidTuningSession.mjs`）

| decision | 触发条件 | 动作 |
|----------|----------|------|
| `continue` | 未达标、未劣化、未到上限 | 用候选参数进入下一轮 |
| `rollback` | `shouldRollbackToBest` 命中（双阈值劣化） | 回退到 `bestStable.pid` |
| `complete` | 连续 `requiredStable` 轮达标 | 终止，应用最佳参数 |
| `stagnated` | 连续 `patience` 轮无改善 | 终止，恢复最佳参数 |
| `max-rounds` | 达到 `maxRounds` 上限 | 终止，恢复最佳参数 |

**双阈值劣化判定**：rmse/steadyError/overshoot 任一相对 >1.3 倍 **且** 绝对增量 >0.5 → 回退。

---

## 六、安全护栏：`pidSafety.mjs`

所有参数（无论来自本地策略还是 AI）最终都要过护栏：

| 函数 | 作用 |
|------|------|
| `applyPidGuardrails` | 边界裁剪（Kp 0~20, Ki/Kd 0~10）+ 单步增幅限制（Kp ×3, Ki/Kd ×4） |
| `buildFallbackSuggestion` | AI 不可用时按 `metrics.status` 保守乘性修正 |
| `scoreMetrics` | 评分（越低越好）：`rmse + 1.2·|steadyError| + 0.6·overshoot + 0.3·oscillation + 状态惩罚` |
| `maybeUpdateBestResult` | **仅在 STABLE 时**更新最佳记录 |
| `shouldRollbackToBest` | 双阈值劣化 → 回退 |
| `isMetricsAcceptable` | 终止条件：STABLE 且 rmse/稳态误差/超调均在阈值内 |

---

## 七、调参历史与上下文传递

### 7.1 `tuningHistory`（本地维护）

每轮记录：
```javascript
{
  round: 1,
  pid: { kp, ki, kd },          // 本轮测试参数
  metrics: { ... },              // 本轮响应指标
  analysis: '',                  // 会话状态机给出的评价
  thought: '',                   // AI 思考或本地规则说明
  proposedPid: null,             // 下一轮候选参数
  source: '手动分析' | 'AI + 安全护栏' | '本地规则'
}
```

### 7.2 `historyToPromptText`（喂给 AI）

把最近 5 轮历史打包为可读文本，让 AI：
- 借鉴历史中有效的调整方向
- 避免重复无效方向（如已试过大 Kp 导致震荡，不再重复）
- 理解调参轨迹（从 P→PI→PID 的推进过程）

### 7.3 `extractLastGoodKp` / `extractLastBadKp`

从历史中提取 Kp 二分法的上下界：
- `lastGoodKp`：无超调（<3%）无震荡的最大 Kp
- `lastBadKp`：超调超限或有明显震荡的最小 Kp

这两个值同时传给本地策略（`buildPidSuggestion`）和 AI（作为 `currentPid` 的上下文），保证两者用同一份历史。

---

## 八、本地策略与 AI 的协作关系

| 维度 | 本地策略 | AI |
|------|----------|-----|
| **角色** | 基线候选 + 阶段推断 + 二分法 | 增强/覆盖基线 |
| **输入** | metrics + current + tuningOrder + lastGoodKp/lastBadKp | 同左（打包为 JSON） |
| **输出** | `{ kp, ki, kd, confidence, reasons, phase }` | `{ kp, ki, kd, thought }` |
| **约束** | 阶段强制清零 + clamp 边界 | 提示词约束 + 解析 clamp + 护栏增幅限制 |
| **失败处理** | 永远成功（有保底） | 5 次重试 → 回退到本地规则 |
| **离线** | ✅ 可用 | ❌ 不可用 |
| **可复现** | ✅ 确定性 | ❌ temperature=0.2 有随机性 |

**协作流程**：
1. 本地策略先跑，给出基线候选和阶段判断
2. AI 拿到同样的 metrics + 历史 + 阶段策略提示，给出自己的参数
3. AI 参数过护栏裁剪后覆盖基线
4. AI 失败 → 用本地基线
5. 无 API Key → 直接用本地基线

这种设计保证了：**有 AI 时更智能，无 AI 时仍可用，AI 出错时不失控**。

---

## 九、相关文件索引

| 文件 | 职责 |
|------|------|
| `services/controlAnalysis.mjs` | `analyzeControlSamples`（指标）、`buildPidSuggestion`（本地候选）、`buildFeedforwardSuggestion`（前馈整定）、`historyToPromptText`（历史打包） |
| `services/pidSimulation.mjs` | `PID_STRATEGIES`（策略注册表）、`simulatePidStrategy`（仿真）、`FEEDFORWARD_LIBRARY`（前馈项库） |
| `services/pidSafety.mjs` | `applyPidGuardrails`（护栏）、`buildFallbackSuggestion`（兜底）、`scoreMetrics`（评分） |
| `services/pidTuningSession.mjs` | `createTuningSession` / `registerTuningRound`（会话状态机） |
| `components/PidPanel.vue` | `callAiForPid`（提示词组装与 AI 调用）、`runAutoTuning`（自动调参闭环）、`analyzeResponse`（手动分析） |
