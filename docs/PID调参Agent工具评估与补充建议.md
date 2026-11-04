# PID 调参 Agent 工具评估与补充建议

> 日期：2026-11-02
> 范围：`ai-serial-assistant-app/src/renderer/src/services/pidAgent/` 工具集与编排层
> 性质：现状评估 + 改进建议，尚未实施

---

## 一、结论

现有 **5 个基础工具 + 2 个策略工具**已经把「查数据 → 改参数 → 设目标 → 看结果」的闭环跑通，护栏与失败语义（`ok:false` / `waiting` / `stale_data`）也做得比多数同类项目扎实。

但这套工具集的结构性特征是：**写多、读少、无记忆、无等待、无链路诊断**。

真正的短板不在调参算法，而在**模型看不见的状态**：

1. 它不知道自己现在跑的是哪组参数（没有读回工具）；
2. 它不记得前几轮试过什么、哪一轮最好（历史会被上下文压缩掉）；
3. 串口模式下它无法「等」一个采集窗口，只能反复撞击空缓冲；
4. 它无法区分「链路故障」和「控制效果差」。

因此增量方向应优先补齐**读 / 记 / 等 / 诊断**这类工具，而不是继续增加整定策略。

---

## 二、现有工具逐项体检

共 7 个工具：5 个基础工具（`tools/index.mjs`）+ 2 个策略工具（`tools/strategies.mjs`）。
下面逐项给出**参数、返回值、体检结论**。

契约约定：工具内部出错直接 `throw`，由 `agentLoop` 捕获并转成 `isError` 的 toolResult（消息为中文）；
业务性失败（串口下发失败等）不抛错，而是返回带 `ok:false` 或 `status` 的普通结果，避免模型误判为崩溃。

---

### 2.1 `get_channel_stats`　统计 + 阶跃指标 + 达标判定

**参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `timeRange` | `[number, number]` | 是 | `[起始秒, 结束秒]`，相对调参开始；可直接用 `set_target` 返回的 `timeRange` |
| `channels` | `string[]` | 否 | 枚举 `target` / `feedback` / `output` / `speedTarget` / `speed`，默认全部；后两者仅串级仿真提供 |

**返回**

```js
{
  timeRange: [number, number],      // 实际取到的数据区间
  channels: { <channel>: { mean, std, min, max, peak, rms, sampleCount } },
  stepMetrics: {                    // 窗口内最后一次目标变化段的阶跃指标；无有效阶跃时为 null
    valid: true, overshoot, settlingTime, steadyError, rmse, oscillation,
    status,                         // STABLE / STILL_RISING / SLOW_RESPONSE / OVERSHOOTING / OSCILLATING …
    converged, convergenceNote,
    riseTime, stepSize, finalFeedback, finalTarget,
    oscillationPeakCount, oscillationFrequency, hasSignificantOscillation, health,
    limits                          // 验收线，模型可直接对照
  } | { valid: false, targetRamping: true, reason, finalTarget, finalFeedback } | null,
  stepCount: number,                // 窗口内目标变化次数（防止多阶跃混杂）
  finalValues: { target, feedback, output },   // 末段稳态读数
  sampleCount: number,
  clipped: boolean,                 // 查询区间是否被缓冲区边界裁剪
  unavailableChannels?: string[],
  acceptanceCheck: { passed, reason }          // 工具层附加的结构化达标判定
}
```

**体检**：核心工具，质量最高——把指标、验收线、达标结论一次性给全，模型无需自己对照阈值。

- 问题一：只读工具里带了副作用，`check.passed` 为真时直接调用 `controller.onAcceptancePassed(result)`（`tools/index.mjs:126`），
  使「查询」改变会话收敛状态（触发 steer 提示、启动停滞计数），压缩或重放时行为不可预期。
- 问题二：`timeRange` 必填，模型只能猜窗口；猜错直接抛「时间段无数据」，白烧一轮。
- 问题三：结果被标记为数据查询（`types.mjs:81`，工具名以 `get_channel_` 开头），超 50KB 会被 `compaction.mjs` 摘要掉，
  历史指标事后不可追溯。

**抛错**：`时间段无数据：[start, end] 内没有采样点`。

---

### 2.2 `get_channel_data`　原始波形（自动下采样）

**参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `timeRange` | `[number, number]` | 是 | 同上 |
| `channels` | `string[]` | 否 | 同上 |
| `maxPoints` | `number` | 否 | 下采样目标点数，默认 30，范围 2–500（`MAX_QUERY_POINTS`） |

**返回**

```js
{
  timeRange: [number, number],
  sampleCount: number,
  downsampled: boolean,
  clipped: boolean,
  data: { <channel>: Array<number | null> },   // 均匀下采样后的序列
  unavailableChannels?: string[]
}
```

**体检**：只有数值序列，没有斜率、饱和占比、噪声水平；模型判断「反馈是否仍在爬升」「输出是否爆炸」只能目测数字。
定位应保持为「看波形细节」的补充工具，不要用它替代统计摘要（描述里已写明，这点做得对）。

---

### 2.3 `set_pid_params`　改参 + 三重护栏（+ 串口真实下发）

**参数**（`additionalProperties: false`，只传需要改的项）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kp` / `ki` / `kd` | `number` | 单环参数；串级配置下自动同义映射到 `positionKp/positionKi/positionKd` |
| `speedKp` / `speedKi` / `speedKd` | `number` | 串级内环（速度环） |
| `positionKp` / `positionKi` / `positionKd` | `number` | 串级外环（位置环） |

**校验顺序**：① 用户配置 `min/max` 裁剪 → ② 系统上限（Kp ≤ 20，Ki/Kd ≤ 10）→ ③ 单步增幅限制（Kp ×3，Ki/Kd ×4）→ ④ 写回；
所有裁剪都会写入 `guardrailNotes`。串口模式下再走 `buildPidCommand` 下发设备。

**返回**

```js
// 仿真
{ applied, previous, guardrailNotes }

// 串口成功
{ applied, previous, guardrailNotes, mode: "serial", message }

// 串口下发失败（关键：显式 ok:false，避免模型按「已生效」继续调参）
{ ok: false, applied, previous, guardrailNotes, mode: "serial", error, message }
```

`applied` 是**实际生效**值（已被裁剪），`previous` 是改前快照，`guardrailNotes` 形如
`kp: 50 → 20（超出用户配置上限 20）`。

**体检**：安全路径设计到位，尤其是下发失败返回 `ok:false` 而不是抛错——这是本项目踩过的坑。

- 缺 `reason` 字段：模型为什么这么改没有留痕，做实验记录 / 报告时无法回溯动机。
- 无「回退」语义：知道 `previous` 但要退回去，模型得自己再拼一次 `set_pid_params`。
- 未知键被静默忽略（只处理 `validKeys` 内的键），schema 层虽已 `additionalProperties:false`，但模型传错时会得到
  「未提供任何参数」而不是「`xxx` 不是可用键」这种可纠正的报错。

---

### 2.4 `set_feedforward_params`　改前馈系数

**参数**：无固定字段，`additionalProperties: { type: "number" }`，键为**前馈项 id**（由用户配置定义，如 `gravity` / `friction`）。

```js
{ "gravity": 1.2 }   // 只传需要修改的项
```

**返回**

```js
// 仿真
{ applied, guardrailNotes }

// 串口（固件无前馈指令，只写上位机）
{ applied, guardrailNotes, mode: "serial", warning }
```

**体检**：串口未生效时显式给 `warning` 是对的——否则模型会按「前馈已生效」评估结果，实测会让后续判断全部失真。

- 抛错较硬：未知 id 直接 `throw`「未知前馈项 id …，可用前馈项：…」（可纠正，尚可）；系数非数字也抛错。
- 与前馈参数同级的问题：**没有工具能判断「该不该开前馈」**。`controlAnalysis.mjs` 里 `buildFeedforwardSuggestion`
  已实现，但没有暴露。

---

### 2.5 `set_target`　改目标 + 触发阶跃采集（验证闭环必经步骤）

**参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `value` | `number` | 是 | 新目标值；仿真按策略物理范围校验（如倒立摆 ±0.18 rad），串口按用户安全范围 |

校验策略：轻微越界裁剪到边界并写 `guardrailNotes`；严重越界（超出范围一个量程以上）直接抛错拒绝。

**返回**

```js
// 仿真：立即采集并写入数据缓冲
{
  ok: true, mode: "simulation", target,
  samplesCollected: number,
  timeRange: [number, number],      // 本次阶跃数据区间，可直接传给 get_channel_*
  truncated: boolean,               // 是否因发散被提前截断
  safety,                           // 采集后安全检测结果（可能触发回退）
  message?,                         // 仅在发散截断时给出原因
  guardrailNotes
}

// 串口：指令下发后异步采集
{
  ok: true, mode: "serial", target, guardrailNotes,
  windowSec: number,                // 采集窗口时长（当前 12s）
  suggestedQuery: [number, number], // 建议的查询区间
  message
}

// 串口下发失败：不开启采集窗口，避免后续读到上一次阶跃的旧数据
{ ok: false, mode: "serial", target, guardrailNotes, error, message }
```

**体检**：全项目设计最完整的工具——返回区间、发散标记、安全结果、串口建议窗口，还区分「未开始采集」与「已开始」两种失败。

- 串口分支把「等待」推给了模型（提示「稍后用 get_channel_stats 查询」），但基础工具没有等待原语，
  模型只能轮询撞空；策略工具有 `waiting` 状态，基础工具没有对应能力。
- 仿真分支同步返回，串口分支异步返回，**两种模式返回结构差异较大**，模型需要额外推理分支；
  若统一成「始终返回一个可用查询区间 + 就绪状态」，行为会更可预测。

---

### 2.6 `list_pid_strategies`　策略清单

**参数**：无（`additionalProperties: false`）。

**返回**

```js
{
  strategies: [{ id, description }],   // staged_pid / recover_pid
  maxAdjustmentsPerCall: 1,
  fallback: "不适用或证据无效时继续使用 get_channel_stats / set_pid_params / set_target。"
}
```

**体检**：廉价、必要，把「有哪些确定性策略、边界在哪」从提示词搬到工具结果，降低提示词负担。

---

### 2.7 `run_pid_strategy`　执行一次确定性整定

**参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `strategy` | `string` | 是 | 枚举 `staged_pid` / `recover_pid` |

**内部执行**：读最近一次 `set_target` 的快照 → 校验数据未失效 → 用 `get_channel_stats` 取指标 →
`buildFallbackSuggestion` 生成候选（`recover_pid` 额外限制候选增益不增加）→ `set_pid_params` → 同目标 `set_target` 复测 →
`get_channel_stats` 对比。全程复用基础工具，不另建安全逻辑。

**返回**

```js
{ strategy, version: 1, adjustments: 0 | 1, status, reason, ...extra }
```

`status` 取值：

| status | 含义 | 是否已改参 |
| --- | --- | --- |
| `evaluated` | 完成一次调整 + 复测 | 是 |
| `accepted` | 当前窗口已达标，无需调整 | 否 |
| `waiting` | 串口采集窗口未满 | 否 |
| `needs_data` | 无有效阶跃指标 / 窗口已被淘汰 | 否 |
| `stale_data` | 采集后参数、前馈或目标已变 | 否 |
| `unsupported` | 只支持单环 `kp/ki/kd` | 否 |
| `invalid_config` | 参数或范围不合法 | 否 |
| `not_applicable` | 恢复策略但当前非超调/振荡 | 否 |
| `safety_stop` | 最近采集触发安全机制或仿真截断 | 否 |
| `serial_send_failed` | 参数或目标下发设备失败 | 参数可能已改（仅上位机） |
| `pending_validation` | 串口已下发调整，等待真实窗口 | 是 |
| `validation_failed` | 已改参但复测异常 | 是 |
| `stopped` | 会话已停止 | — |

`extra` 依状态携带：`basis`（依据）、`phase`（P/PI/PID 阶段）、`before`（调整前完整统计）、`proposed` / `applied`、
`capture`（复测返回）、`after`（复测指标）、`finalPid`、`next`（后续建议）、`safety`、`timeRange`。

**体检**：契约最严谨的一个工具——不接受模型传入指标（防伪造）、旧数据拒绝、一次只改一次、失败不宣称成功。

- 只支持单环 3 键（`tools/strategies.mjs:36`），而串级是内置三种仿真策略之一，串级场景下这个工具直接 `unsupported`，
  形同虚设。
- `evaluated` 只给「已评估」，不给「是否改善」的结构化结论，模型仍需自己比对 `before/after`；可考虑直接返回 `improved` 布尔。

---

### 2.8 体检小结（横向对比）

| 工具 | 有写副作用 | 结果可被压缩 | 失败可纠正 | 主要短板 |
| --- | --- | --- | --- | --- |
| `get_channel_stats` | **是**（达标回调） | **是** | 抛错信息明确 | 必填窗口 + 副作用 |
| `get_channel_data` | 否 | 是 | 是 | 无导数/饱和/噪声 |
| `set_pid_params` | 是（设计如此） | 否 | 部分（未知键静默） | 无 reason、无回退 |
| `set_feedforward_params` | 是（设计如此） | 否 | 是 | 无「是否该开」的证据 |
| `set_target` | 是（设计如此） | 否 | 是 | 两模式返回结构差异大 |
| `list_pid_strategies` | 否 | 否 | — | 无 |
| `run_pid_strategy` | 是（设计如此） | 否 | 是 | 不支持串级 |

共同特征：**7 个工具里只有 2 个是纯读**（且都可被压缩），**没有任何一个能读回当前参数、历史实验或链路状态**。
这是下一节所有建议的共同出发点。

---

## 三、四个结构性缺口

### 3.1 没有「读回状态」的工具（最严重）

controller 已经具备全部读能力：

- `getPid()` / `getFeedforward()` / `getTarget()` / `getMode()`
- `getTargetRange()` / `getDataBuffer().getRange()` / `getSessionClock()`
（见 `composables/usePidAgent.mjs:712-771`）

但**一个都没有暴露成工具**。后果：

- 安全回退、用户中途 steer、参数被裁剪之后，模型对「当前生效参数」只能靠记忆重建；
- `get_channel_stats` 被标记为数据查询（`types.mjs:81`，工具名以 `get_channel_` 开头），超过 50KB 会被 `compaction.mjs` 摘成一段摘要 —— **历史指标与参数对应关系会被抹掉**，模型无法事后做 A/B 对比；
- 每次调用都要猜 `timeRange`，猜错就抛「时间段无数据」，白烧一轮。

### 3.2 没有实验记录与最优解回退

`safety.mjs:129` 已经维护 `getBestStable()`，`maybeUpdateBestResult` / `shouldRollbackToBest` 也在运行，但模型看不到 best 是哪组参数、指标多少。

调参本质是搜索，而当前 agent **没有搜索记忆**：不能回答「上上轮那组更好，退回去」，只能线性往下试。

### 3.3 串口模式没有等待与链路诊断

- **无等待**：`set_target` 返回 `suggestedQuery` 后，模型只能反复调用 `get_channel_stats` 撞击空缓冲（窗口 12s，`SERIAL_STEP_WINDOW_SEC`）。策略工具有 `waiting`，基础工具没有对应能力。
- **静默丢帧**：`onSerialData` 中 `nums.length < 3` 直接 return（`composables/usePidAgent.mjs:944-948`）。「没数据」可能是接线、帧格式、波特率、通道数不足或设备未响应，**模型完全无法区分**，只会重复 `set_target` 盲调。这正是此前「无论怎么调反馈都一样」事故的温床。

### 3.4 只有阶跃，缺少真实硬件约束的度量

仿真输出无限幅（系统提示词已说明），但真实设备一定有饱和、死区、量化噪声。

`get_channel_stats` 给出的是**整窗**均值 / 标准差 / 峰值，不区分瞬态与稳态，也不给输出饱和占比 —— 而这两项恰恰决定 Kd 能否加、Ki 是否积分饱和。

---

## 四、建议新增的工具

按性价比排序。P0 具备「投入小、影响直接」的特征，建议先做。

### P0

#### ① `get_session_state`（无参数）

返回：模式 / 策略 / 是否串级 / 当前 pid + feedforward + target / 各参数范围与验收线 / 缓冲区间 `[start, end]` / 会话时钟 / 每通道是否有数据 / 策略工具是否开启。

- **成本极低**：全部是 controller 现成 getter，纯读、零副作用。
- **收益最大**：消除猜窗口、消除参数记忆丢失，模型每轮都能自校准。
- 配套改动：把 `get_channel_stats.timeRange` 改为**可选**，缺省取「最近一次目标变化段」，与 `sliceLastTransition` 语义天然一致。

#### ② `get_tuning_history({ limit? })`

返回最近 N 轮的紧凑表：

```
{ round, pid, feedforward, target, overshoot, settlingTime,
  steadyError, rmse, status, accepted, safetyTriggered, at }
```

- 存在理由很硬：数据类 toolResult 会被压缩（`compaction.mjs`），这份记录是**压缩后仍可访问的外部记忆**。
- 顺带解决「前 5 轮硬编码观察期」（`tools/index.mjs:113-114`）这个 hack —— 用「历史轮次 + 是否有实质改善」替代 `turn < 5`，比固定轮次更合理。

#### ③ `restore_params({ to: 'previous' | 'best' | 'initial' })`

- 复用 `getBestStable()` 与会话内的 initial 快照，仍走 `set_pid_params` 原有护栏与串口下发路径。
- 没有它，agent 在「劣化后该退哪」上只能瞎猜；串口模式还要多一次「自己拼 previous 再下发」的往返。

#### ④ `await_capture({ timeoutSec? })`（串口专用）

阻塞到缓冲覆盖 `suggestedQuery` 终点再返回；超时返回 `{ ready:false, elapsed, lastSampleAt }`。

- 直接替代「查询 → 报错 → 再查询」的轮询，省 token 也省轮次。
- 超时本身就是一条诊断信息：设备根本没回数据。

#### ⑤ `check_link_health`（串口专用）

返回：连接状态 / 最近 N 秒有效帧数 / **被丢弃帧数** / 每帧解析出的通道数 / 最近一帧原文与时间戳 / 时间戳抖动。

- 把「静默丢帧」变成可读证据。
- 没有这条，agent 会把链路故障误判为控制问题，然后一路降增益。

### P1

#### ⑥ `identify_plant`（策略工具）

从最近一次阶跃拟合 FOPDT：增益 K、时间常数 τ、纯滞后 L、拟合 R²，并给出 IMC / ZN 建议增益与依据。

- 最符合「策略工具化」初衷：模型不该背调参口诀，应该读被控对象。
- 建议仅作建议，仍走 `set_pid_params` 三重护栏；数据不足返回 `needs_data`，与现有策略状态机保持一致。

#### ⑦ `get_signal_quality({ timeRange })`

返回：输出饱和占比（对照 `safety.output` 上下限）、稳态段噪声 std（与整窗 std 分开）、反馈量化台阶、峰值处是否削顶、有效控制带宽。

- Kd 能不能加、Ki 是否积分饱和、指标是否被饱和污染，全靠这几个数。
- 也可作为 `get_channel_stats` 的扩展字段，但独立更利于控制主指标工具的体积。

#### ⑧ `run_pid_strategy` 支持串级

现状是串级配置直接 `unsupported`（`tools/strategies.mjs:36`），而串级是内置仿真策略之一。

至少应支持「只整内环速度环、外环冻结」，用 speed 通道指标验证。否则串级场景下策略工具形同虚设。

### P2

| 工具 | 说明 |
| --- | --- |
| `set_target_profile` + `analyze_tracking` | `controlAnalysis.mjs` 中 `analyzeSineTracking` / `analyzeMultiStepSamples` / `buildFeedforwardSuggestion` **已实现但完全未接入工具**。做速度环跟踪与前馈整定时是现成弹药，前提是设备支持非阶跃目标指令。 |
| `export_tuning_report` | 把 history 导成参数-指标表（CSV / MD）。演示与交付价值高，对 agent 决策价值低。 |
| `request_user_input` | 实机上「设备是否真的在转 / 是否触发保护」这类物理事实只有人能回答。必须带超时降级，防止会话挂起。 |
| `stop_control` | 失控时由 agent 主动停止输出或结束会话。目前只能靠用户点停止。 |

---

## 五、不建议新增的

- **`run_sweep` 批量扫参**：看似省 3-5 轮，但违背已写入策略契约的「一次调用最多调整一次」（`docs/pid-strategy-tools.md`），且扫参过程中无人值守的真实设备风险不可控。若要做，只能限定仿真 + 显式上限 + 全程记录。
- **允许模型修改验收线 / 安全范围**：一旦可写，「达标」就失去意义。

---

## 六、顺手应当修的两处

1. **`get_channel_stats` 的副作用**：`onAcceptancePassed` 在只读工具中被调用（`tools/index.mjs:126`），使「查询」会改变会话收敛状态，压缩 / 重放时行为不可预期。建议拆成独立的判定入口，或以显式字段返回。
2. **工具描述预算**：7 个工具的中文 description 已经很长，再增加 5 个会明显挤占上下文。建议把长知识（仿真无输出限幅、倒立摆小角度、串级通道语义）从 tool description 移到 systemPrompt 已有段落，或引入 `read_doc(topic)` 按需取用。

---

## 七、优先级总览

| 优先级 | 工具 | 解决的问题 | 实现落点 |
| --- | --- | --- | --- |
| P0 | `get_session_state` | 参数/窗口/通道不可见 | controller 现成 getter |
| P0 | `get_tuning_history` | 压缩后失去实验记忆 | 会话上下文新增 history 数组 |
| P0 | `restore_params` | 劣化后不知退哪 | 复用 `getBestStable` + `set_pid_params` |
| P0 | `await_capture` | 串口轮询空缓冲 | 复用 serialCollector 窗口 |
| P0 | `check_link_health` | 静默丢帧不可见 | `onSerialData` 增加计数 |
| P1 | `identify_plant` | 调参靠试而非测 | 新策略工具，复用 `analyzeControlSamples` |
| P1 | `get_signal_quality` | 饱和与噪声无度量 | 扩展 dataBuffer.stats |
| P1 | 串级策略支持 | 策略工具对串级失效 | `tools/strategies.mjs` |
| P2 | 跟踪/报表/问用户/急停 | 场景扩展 | — |

---

## 八、一句话总结

现在的工具会「动手」，不会「看账本」。

补上 `get_session_state` + `get_tuning_history` + `restore_params` + `await_capture` + `check_link_health` 这五个读写 / 等待类工具，投入最小、对稳定性与轮次的影响最直接；`identify_plant` 与 `get_signal_quality` 则是把调参从「试」变成「测」的关键一步。
