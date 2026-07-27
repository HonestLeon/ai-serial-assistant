# llm-pid-tuner 项目分析报告

> 本文档对开源项目 `llm-pid-tuner`（作者：KINGSTON-115, ApexGP，Apache-2.0）的源码进行研读总结，提炼其在 **PID 仿真** 与 **PID 自动调参** 上的实现思路，并指出值得本项目（ai-serial-assistant）借鉴的设计要点。

---

## 一、项目概览

### 1.1 定位

一个用大语言模型（LLM）辅助 PID 调参的实用工具。核心目标是：**真实调参时少走弯路、少炸参数、调差了还能回退**。明确不追求"一键完美"，而是面向"已经能跑但参数不好"的场景。

### 1.2 两条主链路

```
本地仿真模式：simulator.py（热系统仿真）── API(JSON) ──> LLM
真实硬件模式：MCU/firmware.cpp ── Serial(CSV) ──> tuner.py ── API ──> LLM
```

支持三种被控对象来源：
- 内置 Python 加热仿真（`sim/model.py`）
- 真实硬件（`firmware.cpp` 上报 CSV）
- MATLAB/Simulink 联合仿真（`sim/simulink_bridge.py`）

### 1.3 目录结构（仅核心源码）

```
llm-pid-tuner/
├── tuner.py            # 硬件调参主程序（exe 入口）
├── simulator.py        # 仿真调参主程序（含 TUI/控制台/Simulink 三态切换）
├── pid_safety.py       # 安全护栏 + 保底策略 + 最佳记录 + 回退判定
├── system_id.py        # 系统辨识（Z-N 法）→ 初始 PID 建议
├── doctor.py           # 环境/依赖/配置自检
├── benchmark.py        # 固定种子对比工具
├── firmware.cpp        # MCU 端示例固件
├── core/
│   ├── config.py       # 配置管理（config.json + 环境变量覆盖）
│   ├── buffer.py       # 滑动窗口缓冲 + 高级指标计算
│   └── history.py      # 调参历史记录（喂给 LLM 的上下文）
├── llm/
│   ├── client.py       # LLM 客户端（OpenAI/Anthropic SDK + HTTP 回退 + 流式 JSON 解析）
│   └── prompts.py      # 系统提示词（CoT + 严格 JSON 输出）
├── sim/
│   ├── model.py        # 加热仿真模型（一阶热系统）
│   ├── runtime.py      # 事件总线 + 暂停/停止控制器
│   ├── tui.py          # Textual 图形界面
│   └── simulink_bridge.py
└── hw/bridge.py        # 串口桥接
```

---

## 二、PID 仿真的实现

### 2.1 仿真模型（`sim/model.py`）

**被控对象**：一阶惯性热系统（带噪声），模拟 PWM 驱动的加热器。

```python
class HeatingSimulator:
    def __init__(self, kp=1.0, ki=0.1, kd=0.05, random_seed=0):
        self.temp = 20.0            # 初始温度（环境温度）
        self.setpoint = 200.0       # 目标温度
        self.integral = 0.0
        self.prev_error = 0.0
        # 物理参数
        self.heater_coeff = 300.0   # 加热器最高温升
        self.heat_transfer = 0.5    # 加热器→物料传热
        self.cooling_coeff = 0.05   # 物料→环境散热
        self.noise_level = 0.1      # 高斯噪声幅度
        self.rng = random.Random(random_seed)
```

**PID 算法**（标准位置式 + 积分限幅）：

```python
def compute_pid(self):
    error = self.setpoint - self.temp
    self.integral += error * CONTROL_INTERVAL  # CONTROL_INTERVAL = 0.2s
    self.integral = max(-500.0, min(500.0, self.integral))  # 积分限幅 ±500
    derivative = (error - self.prev_error) / CONTROL_INTERVAL
    pid_output = self.kp*error + self.ki*self.integral + self.kd*derivative
    self.pwm = max(0.0, min(255.0, pid_output))  # PWM 限幅 0~255
    self.prev_error = error
```

**物理模型更新**（双容热系统：加热器→物料→环境）：

```python
def update(self):
    # 加热器自身温度（一阶跟踪目标温度）
    target_heater_temp = self.ambient_temp + (self.pwm/255.0) * self.heater_coeff
    self.heater_temp += (target_heater_temp - self.heater_temp) * 0.1 * CONTROL_INTERVAL
    # 物料温度（加热器传入 - 散热到环境）
    heat_in = (self.heater_temp - self.temp) * self.heat_transfer
    heat_out = (self.temp - self.ambient_temp) * self.cooling_coeff
    self.temp += (heat_in - heat_out) * CONTROL_INTERVAL
    self.temp += self.rng.gauss(0.0, self.noise_level)  # 加测量噪声
    self.temp = max(0.0, self.temp)
```

### 2.2 仿真特点

| 特点 | 实现方式 | 评价 |
|------|---------|------|
| **物理建模** | 双容热系统（加热器+物料），比单容更贴近真实 | ⭐ 简单实用 |
| **噪声** | `rng.gauss(0, 0.1)`，固定种子可复现 | ⭐ |
| **积分抗饱和** | 硬限幅 ±500（简单粗暴） | ⚠ 不如条件积分 |
| **D 项** | 基于误差变化（derivative on error） | ⚠ 阶跃会爆 D |
| **PWM 变化率限制** | firmware.cpp 中有 `PWM_CHANGE_MAX`，仿真里没有 | ⚠ 不一致 |
| **控制周期** | 0.2s（5Hz），较慢，适合热系统 | ✓ |
| **参数更新后状态清零** | firmware.cpp 中清 integral/prev_error | ⭐ 防饱和 |

### 2.3 仿真运行时（`sim/runtime.py`）

提供事件总线 + 暂停/停止控制器：

```python
@dataclass
class SimulationController:
    stop_event: threading.Event
    run_event: threading.Event  # 用 run_event.is_set() 表示运行中
    def pause(self): self.run_event.clear()
    def resume(self): self.run_event.set()
    def toggle_pause(self) -> bool: ...
    def request_stop(self): self.stop_event.set(); self.run_event.set()
    def wait_until_running(self, poll_interval=0.05) -> bool: ...
```

事件类型：`EVENT_SAMPLE`、`EVENT_ROUND_METRICS`、`EVENT_DECISION`、`EVENT_ROLLBACK`、`EVENT_LIFECYCLE`。这套设计把"调参逻辑"和"展示界面"通过事件队列解耦，TUI 和控制台可以共用同一份逻辑。

---

## 三、PID 自动调参的实现

### 3.1 整体流程（`simulator.py::_run_tuning_loop`）

```
1. [可选] Warm Start：满功率采集温升曲线 → system_identify → Z-N 整定 → 初始 PID
2. 主循环（最多 MAX_TUNING_ROUNDS=50 轮）：
   a. _collect_data: 采满 BUFFER_SIZE=100 个点
   b. buffer.calculate_advanced_metrics: 算误差/超调/稳态/震荡/状态
   c. maybe_update_best_result: 若 STABLE 且优于历史最佳 → 记录
   d. should_rollback_to_best: 若明显劣化 → 回滚到最佳，发 ROLLBACK 事件
   e. 三种提前终止判定：
      - 误差足够小 + STABLE
      - 连续 REQUIRED_STABLE_ROUNDS=2 轮达标
      - LLM 主动返回 status="DONE"
   f. tuner.analyze(prompt_data, history_text): LLM 给新 PID
   g. LLM 失败 → build_fallback_suggestion: 规则兜底
   h. apply_pid_guardrails: 安全护栏裁剪
   i. sim.set_pid: 应用新参数
   j. history.add_record: 记录本轮（PID + 指标 + thought + analysis）
   k. buffer.reset: 清空缓冲，进入下一轮
3. finally: 发布 finished 事件，输出 summary
```

### 3.2 指标计算（`core/buffer.py::calculate_advanced_metrics`）

```python
def calculate_advanced_metrics(self):
    inputs = [d["input"] for d in data]
    errors = [d["setpoint"] - d["input"] for d in data]
    abs_errors = [abs(e) for e in errors]

    avg_error = sum(abs_errors) / len(abs_errors)       # 平均绝对误差
    max_error = max(abs_errors)                          # 最大误差
    # 超调：max_input 超过 setpoint 的百分比
    overshoot = ((max_input - setpoint) / setpoint) * 100 if max_input > setpoint else 0
    # 稳态误差：末 20% 数据的平均绝对误差
    steady_state_error = mean(abs_errors[-int(n*0.2):])
    # 震荡：误差过零点次数
    zero_crossings = ...
    # 状态判定
    status = "STABLE"
    if zero_crossings > n * 0.3:       status = "OSCILLATING"
    elif overshoot > 5.0:              status = "OVERSHOOTING"
    elif avg_error > 10 and steady_state_error > 5: status = "SLOW_RESPONSE"
```

返回 dict：`{avg_error, max_error, current_error, overshoot, steady_state_error, zero_crossings, status, setpoint}`。

### 3.3 LLM 提示词与输出（`llm/prompts.py` + `llm/client.py`）

**SYSTEM_PROMPT 核心**：

```
你是一个世界顶级的 PID 控制算法专家...

## 核心原则
1. 稳态优先：首要任务是消除稳态误差。
2. 抑制震荡：任何形式的等幅震荡或发散震荡都是不可接受的。
3. 防止超调：对于热力系统，超调可能导致不可逆的后果。
4. 循序渐进：参数调整应平滑，避免剧烈跳变。
5. 借鉴历史：必须仔细阅读「调参历史」，特别是「AI思考过程」，避免重复无效方向。

## 输入信息结构
- 调参历史（最近几轮）：参数、指标、思考过程、总结
- 当前状态：当前 PID 及最新指标
- 当前数据：最近时间序列数据摘要

## 输出格式（严格 JSON）
{
  "thought_process": "详细推理：1... 2... 3...",
  "analysis_summary": "简短总结（50字内）",
  "tuning_action": "INCREASE_P | DECREASE_P | ... | FINE_TUNE | ADJUST_PID",
  "p": <float>,
  "i": <float>,
  "d": <float>,
  "status": "TUNING"  // 达到最优且完全稳定输出 "DONE"
}
```

**LLM 客户端亮点**：

1. **多 provider 支持**：OpenAI / Anthropic SDK，失败回退到 `requests` HTTP 直连
2. **流式 JSON 增量解析**：`JSONStreamFormatter` 边收边打印 `[思考]/[分析]/[调参]/[建议]`，UX 好
3. **5 次指数退避重试**：delays = [2, 4, 8, 16, 32] 秒
4. **JSON 容错解析**：`_extract_json_candidates` 提取裸 JSON、```json``` 代码块、花括号配对三种候选，逐一 `json.loads`
5. **字段清洗 `_sanitize_result`**：p/i/d 必须 finite 且 ≥0；status 只认 "DONE"，其余归一为 "TUNING"；缺字段补默认

### 3.4 上下文打包（`buffer.to_prompt_data` + `history.to_prompt_text`）

**当前数据**（下采样到 30 点）：
```
## Current Status
- 设定值: 200
- 当前 PID: P=1.0, I=0.1, D=0.05
- 平均误差: 45.23
- 最大误差: 180.00
- 超调量: 0.0%
- 稳态误差估算: 12.34
- 震荡检测: 过零点 3 次 (状态: SLOW_RESPONSE)

## 时间序列数据摘要 (采样 30 点):
Timestamp, Input, PWM, Error
0, 20.00, 0.0, 180.00
200, 21.50, 255.0, 178.50
...
```

**历史记录**（最近 5 轮，每字段截断 500 字符防 prompt 膨胀）：
```
## 调参历史 (最近几轮):

### Round 1
- 采用参数: P=1.0000, I=0.1000, D=0.0500
- 表现指标: AvgErr=45.23, MaxErr=180.00, Overshoot=0.0%, Status=SLOW_RESPONSE
- AI思考过程: 当前误差大且响应慢，需增大 P...
- AI分析总结: 响应偏慢，优先增大 P 提升速度
```

### 3.5 安全护栏（`pid_safety.py`）⭐ 这是最值得借鉴的部分

**1. 参数裁剪 `apply_pid_guardrails`**：

```python
DEFAULT_PID_LIMITS = {
    "p": {"min": 0, "max": 100, "max_increase_ratio": 3.0},  # 单步增幅 ≤ 3x
    "i": {"min": 0, "max":  30, "max_increase_ratio": 4.0},
    "d": {"min": 0, "max": 20, "max_increase_ratio": 4.0},
}
# 逻辑：先按 min/max 裁剪，再按 max_increase_ratio 限制单步增幅
# 例如当前 P=2，LLM 给 P=10，则裁到 min(100, 2*3)=6，并记录 note
```

**2. 保底策略 `build_fallback_suggestion`**（LLM 不可用时）：

| 当前状态 | 保底动作 |
|---------|---------|
| OSCILLATING | P×0.8, I×0.85, D×1.2（降 P/I 增 D 阻尼） |
| OVERSHOOTING 或 overshoot>5 | P×0.85, I×0.9, D×1.15 |
| SLOW_RESPONSE | P×1.25，稳态误差大时 I×1.2 |
| 稳态误差>1 | I×1.15 |
| 其他 | P×1.05, I×1.05（细调） |

**3. 评分 `score_metrics`**：`avg_error + steady_state_error*1.2 + overshoot*0.6 + status_penalty`，越低越好。status_penalty：OSCILLATING=12, OVERSHOOTING=8, 其他非 STABLE=20。

**4. 最佳记录 `maybe_update_best_result`**：**只在 STABLE 时才更新最佳**，避免回滚到坏参数。

**5. 回退判定 `should_rollback_to_best`**：
- best 必须 STABLE 且 current 非 STABLE → 立即回退
- 或 avg/steady/overshoot 任一明显劣化（ratio + margin 双阈值）→ 回退

### 3.6 系统辨识 Warm Start（`system_id.py`）⭐ 第二个值得借鉴的点

**流程**：
1. 满功率（PWM=255）采集 40~80 点温升曲线
2. 计算稳态增益 K = ΔT/ΔPWM
3. 时间常数 τ = 温度达到 63.2% 稳态的时间
4. 延迟 θ = 温度达到 5% 稳态的时间
5. 拟合一阶模型 `G(s) = K·e^(-θs) / (τs+1)`
6. **Ziegler-Nichols 开环反应曲线法**：
   - PID: `Kp = 1.2τ/(Kθ), Ti = 2θ, Td = 0.5θ`
   - 转并联式：`Ki = Kp/Ti, Kd = Kp·Td`
7. 经 `apply_pid_guardrails` 裁剪后作为初始 PID

**价值**：避免从零盲调，LLM 从一个"不会太离谱"的起点开始细调，收敛更快。

### 3.7 硬件协议（`firmware.cpp`）

**上行 CSV**（每 50ms 一行）：
```
timestamp_ms, setpoint, input, pwm, error, kp, ki, kd
```

**下行指令**（三种等价格式）：
```
SET P:1.5 I:0.2 D:0.05
SET KP:1.5 KI:0.2 KD:0.05
PID 1.5 0.2 0.05
SETPOINT:100.0
RESET
STATUS
```

**固件细节**：
- 非阻塞逐字节积累命令缓冲（80 字节），溢出则整行丢弃
- 收到新 PID 后**清零 integral/prev_error/prev_pwm_output**，防饱和防突变
- PWM 变化率限制 `PWM_CHANGE_MAX=500`/周期
- 参数范围校验：Kp≤100, Ki/Kd≤50

---

## 四、值得借鉴的设计要点

### ⭐⭐⭐ 强烈建议借鉴

#### 1. 调参历史作为 LLM 上下文（`core/history.py`）

每轮记录 `{round, pid, metrics, analysis, thought}`，最近 5 轮打包进 prompt。**这是本项目当前缺失的关键环节**——我们的 AI 调参是"无记忆"的单次调用，LLM 不知道上一轮调了什么、效果如何，容易重复无效方向。

**建议落地**：在 `PidPanel.vue` 增加 `tuningHistory` 状态，每轮 AI 调参后 push 一条记录，调用 AI 时把最近 3~5 轮的 `{参数, 指标, AI分析}` 拼进 prompt。

#### 2. 安全护栏 + 单步增幅限制（`pid_safety.py::apply_pid_guardrails`）

`max_increase_ratio` 限制单步增幅（如 P 最多翻 3 倍），防止 LLM 一拍脑袋给出 10 倍参数炸设备。**比我们当前的简单边界检查（Kp 0~20）强得多**。

**建议落地**：在 `controlAnalysis.mjs` 或 `PidPanel.vue` 的 AI 参数应用前增加此逻辑。

#### 3. 保底策略（`build_fallback_suggestion`）

LLM 不可用或返回异常时，根据当前 status 用规则生成保守建议（OSCILLATING→降P增D 等）。**保证调参流程不中断**。

**建议落地**：AI 调用 try/catch 失败时，用规则生成候选参数。

#### 4. 最佳记录 + 自动回退（`maybe_update_best_result` + `should_rollback_to_best`）

只在 STABLE 时记录最佳；明显劣化时自动回退。**这是"调差了还能回退"承诺的实现保障**。

**建议落地**：在仿真模式下，每轮记录最佳参数，下一轮劣化时自动回退并提示用户。

#### 5. 系统辨识 Warm Start（`system_id.py`）

满功率采一段阶跃响应 → Z-N 整定 → 初始 PID。**避免从零盲调**。

**建议落地**：可在"真实串口"模式下增加"系统辨识"按钮，采一段阶跃数据后给出初始 PID 建议。仿真模式因为参数已知可不做。

### ⭐⭐ 建议借鉴

#### 6. 多轮自动调参循环（而非单次调用）

`simulator.py` 的 `_run_tuning_loop` 是一个**多轮自动循环**：采数 → 分析 → LLM → 应用 → 再采数。最多 50 轮，达标提前结束。**我们当前是用户手动点"AI 分析"→ AI 给参数 → 用户手动应用 → 用户手动运行仿真，没有自动循环**。

**建议落地**：在仿真模式下增加"自动调参"按钮，点击后自动循环 N 轮直到达标或达上限。每轮把波形和分析推给用户看。

#### 7. 多种提前终止条件

- 误差足够小 + STABLE
- 连续 N 轮达标
- LLM 主动返回 `status="DONE"`
- 明显劣化回退后已达标

**建议落地**：自动调参循环中实现这些终止条件。

#### 8. 指标的"状态判定"（STABLE/OSCILLATING/OVERSHOOTING/SLOW_RESPONSE）

用过零点次数、超调量、误差组合判定状态。**比单纯的数值指标更易于 LLM 理解和决策**。

**建议落地**：在 `controlAnalysis.mjs` 的 `analyzeControlSamples` 输出中增加 `status` 字段。

#### 9. LLM 流式 JSON 增量解析（`JSONStreamFormatter`）

边收边打印 `[思考]/[分析]/[建议]`，用户不用等完整响应。UX 极佳。

**建议落地**：AI 调参调用改用流式 API，前端增量渲染思考过程。工作量大，可作为后续优化。

#### 10. 事件总线解耦（`sim/runtime.py`）

调参逻辑通过事件队列（SAMPLE/METRICS/DECISION/ROLLBACK/LIFECYCLE）与 UI 通信。TUI/控制台/Simulink 共用同一份逻辑。

**建议落地**：我们的 `PidPanel.vue` 当前是逻辑和 UI 耦合的。若后续要做自动调参循环，可考虑把核心逻辑抽成 service，通过事件驱动 UI 更新。

### ⭐ 可选借鉴

#### 11. 严格 JSON 输出 + 容错解析

提示词限定死 JSON 格式，客户端用三种候选（裸 JSON / 代码块 / 花括号配对）容错解析。**我们已经在做**，可参考其字段清洗逻辑（p/i/d 必须 finite 且 ≥0）。

#### 12. 5 次指数退避重试

LLM 调用失败时按 [2,4,8,16,32] 秒重试。**简单有效**。

#### 13. 三种被控对象来源统一接口

Python 仿真 / 真实硬件 / Simulink 都实现 `compute_pid + update + get_data` 接口，调参循环不感知差异。**架构清晰**。

#### 14. 提示词的"借鉴历史"原则

显式要求 LLM "必须仔细阅读调参历史，特别是 AI 思考过程，避免重复无效方向"。**比单纯堆数据更有效**。

---

## 五、对比：llm-pid-tuner vs 本项目（ai-serial-assistant）

| 维度 | llm-pid-tuner | 本项目当前 |
|------|--------------|-----------|
| **定位** | 纯 PID 调参工具 | 串口调试助手 + AI + PID 调参 |
| **被控对象** | 单一热系统（一阶） | 三种策略（电机/串级/倒立摆）⭐ 我们更丰富 |
| **PID 算法** | 标准位置式 + 积分硬限幅 | 条件积分抗饱和 + derivative on measurement ⭐ 我们更先进 |
| **前馈控制** | ❌ 无 | ✅ 多项式/三角/重力等 9 项可勾选 ⭐ 我们独有 |
| **串级控制** | ❌ 无 | ✅ 位置-速度串级 ⭐ 我们独有 |
| **AI 调参模式** | 多轮自动循环 + 历史 + 回退 | 多轮实验会话 + AI/离线双引擎 + 可配置终止条件 ✅ |
| **安全护栏** | 单步增幅限制 + 保底策略 + 最佳记录 + 回退 | 单步增幅限制 + 稳定最佳记录 + 劣化回退 + 停滞停止 ✅ |
| **系统辨识** | Z-N 法 Warm Start | ❌ 无 ⚠ 他们独有 |
| **AI 上下文** | 历史 + 指标 + 状态 + 时序摘要 | 当前指标 + 时序 ⚠ 他们更全 |
| **流式输出** | ✅ JSON 增量解析 | ❌ 一次性返回 ⚠ 他们 UX 更好 |
| **嵌入式集成** | firmware.cpp（PID 在 MCU） | 函数指针注入式（PID 在上位机）⭐ 架构不同 |
| **离线能力** | 需 LLM（可本地 Ollama） | 确定性分析 + 本地规则自动调参闭环 ⭐ 我们更强 |
| **UI** | Textual TUI（终端） | Electron + Vue + ECharts ⭐ 我们更现代 |

### 总结

**我们的优势**：被控对象更丰富（电机/串级/倒立摆）、PID 算法更先进（抗饱和 + D on measurement）、前馈控制、串级控制、离线确定性分析、现代 UI。

**他们的优势**：**自动调参闭环**（多轮循环 + 历史 + 回退 + 保底）、安全护栏（单步增幅限制）、系统辨识 Warm Start、流式 JSON 输出。

**最值得借鉴的 3 点**：
1. **调参历史作为 LLM 上下文**（核心提升 AI 调参质量）
2. **安全护栏 + 单步增幅限制 + 保底策略**（核心提升安全性）
3. **多轮自动调参循环 + 最佳记录 + 自动回退**（核心实现"自动调参"承诺）

这三点共同构成了一个**真正闭环的自动调参系统**。本项目已将其改造成“可验证的实验会话”：每轮区分实测参数与待验证候选，候选只有经过下一轮仿真后才可能成为最佳结果；AI 缺失或失败时自动切换本地规则，最终恢复已验证的最佳参数。

### 2026-07-25 落地修正

1. 新增统一 PID 参数映射，修复串级控制中 `positionKp/positionKi/positionKd` 无法正确写回位置环的问题。
2. 新增调参会话状态机，先使用“前一轮最佳结果”判断劣化，再更新最佳记录，避免回滚判断与当前结果自比较。
3. 每轮记录“实测参数、指标评分、决策、待验证候选及候选来源”，防止把未经仿真的 AI 建议当成有效结果。
4. 自动调参支持“混合引擎”和“本地规则引擎”；未配置 API Key 时可完整离线运行。
5. 增加最大轮数、连续达标轮数和无改善停止轮数；达到终止条件、轮数上限或用户取消时恢复已验证的最佳参数。
6. 仿真播放增加 1×、5×、20×和即时完成，避免小步长模型按单点刷新导致等待过久。

---

## 六、2026-07-26 二刷：dev 分支自 `3d4e401` 以来的更新

> 上次分析基于 main 分支提交 `3d4e401 docs: replace latest-verified branch guidance`。本次用 Git 核查发现：**真正的功能更新在 `origin/dev`**（main 主要是文档同步），自 `3d4e401` 以来约 40+ 个非 merge 提交、+6611 行。下面是更新全貌与可借鉴点。

### 6.1 更新概况

- `3d4e401` 在 **main**（文档提交）；功能主线在 **origin/dev**。
- 规模：40+ 非 merge 提交，`git diff --stat 3d4e401..origin/dev` 显示 +6611/-1377 行，涉及 43 个文件。
- 性质：既有架构重构（调参循环拆分、LLM 拆模块、Simulink 大改），也有新功能（硬件配置文件、可配置护栏、运行时改目标值、PLC Modbus），还有若干正确性修复（达标观察、护栏语义、双环应用）。

### 6.2 主要新功能 / 重构

| 类别 | 提交 / 文件 | 内容 |
|---|---|---|
| **调参架构重构** | `core/tuning_session.py` / `tuning_engine.py` / `tuning_loop.py` | 把单体 `_run_tuning_loop` 拆成 `TuningSessionState` + `RoundEvaluation` + `DecisionOutcome` 数据类 + `evaluate_completed_round` / `finalize_decision` / `record_observation_round` / `apply_rollback`。逻辑与 UI 进一步解耦 |
| **硬件配置文件** #35 | `hw/profiles.py` | `generic_serial_csv` / `stm32f407_openmv`(双控制器+视觉中心 80,60) / `mspm0_datavision`，含 `board_family`、`controller_count`、采样格式提示、`build_profile_commands` 指令构造器 |
| **可配置护栏** #38 | `pid_safety.py` | `get_pid_limits(mode)` 分三套：`DEFAULT_PID_LIMITS`(硬件 P1000/I250/D250)、`PYTHON_SIM_PID_LIMITS`(P5000/I500/D500)、`SIMULINK_PID_LIMITS`(P5000/I500/D500，ratio 放宽到 5/6)；并支持 `CONFIG["PID_LIMITS"]` 按 mode 覆盖 |
| **运行时改目标值** #43 | `core/adapters.py` 等 | TUI 里实时改 setpoint，跨 Python sim / Simulink / 可写硬件 profile 统一处理 |
| **PLC Modbus 适配器** #46 | 新 `plc/` 模块（modbus/pid_semantics/profile/environment/demo） | 把 PID 调参延伸到 PLC，含 example_profile.json |
| **达标观察** #32 | `tuning_session.record_observation_round` | 达标后不立即停、不请求新参数，保持当前 PID 观察 `REQUIRED_STABLE_ROUNDS`(默认 3)轮；期间劣化则清零恢复调参 |
| 工程化 | 多文件 | `core/i18n.py`(多语言)、`launcher.py`、`llm-pid-tuner.spec`+`build_ubuntu_package.sh`(打包)、`core/csv_export.py`、`core/env.py`+`doctoring.py`(环境诊断)、LLM 拆成 `providers/response_parser/stream_formatter`、Simulink 大改(`block_discovery`/`controller_io`/`matlab_runtime`/`pre_tuning_dialog` 等) |

### 6.3 值得本项目借鉴的（按优先级）

#### ① 一个可直接改的 bug：达标观察逻辑（最高优先）

他们 #32 修的正是我们现在有的隐患。

- **他们的修复**：某轮满足 `GOOD_ENOUGH_*` 阈值后，**保持当前 PID、不请求 LLM 新参数**，进入"观察轮"；连续 `REQUIRED_STABLE_ROUNDS`（默认 3）轮都稳定才停；观察期间劣化则清零稳定计数、恢复正常调参。
- **我们的现状**：`pidTuningSession.mjs::registerTuningRound` 中，当 `acceptable.done` 为真但 `stableStreak < requiredStable` 时，decision 是 `'continue'`；而 `PidPanel.vue::runAutoTuning` 在 `continue` 分支会**继续生成并应用下一轮候选参数**——这就把刚达标的好的 PID 给改掉了，破坏了"连续稳定 N 轮才停"的本意。
- **借鉴做法**：加一个 `'observe'` decision——达标但未达连续轮数时，保持当前 PID、不生成新候选，直接进下一轮观察；期间劣化则 `shouldRollbackToBest` 接管。改动小、收益明确。

#### ② 分模式安全护栏（高优先）

- **他们的做法**：限幅按模式分三套，关键洞察是**仿真植物的增益尺度跟硬件差几个数量级，用同一套限幅会撞天花板**。
- **我们的现状**：`pidSafety.mjs` 的 `PID_LIMITS` 是 `Kp 0~20、Ki/Kd 0~10`，仿真和硬件通用。对需要大 Kp 的仿真对象（如倒立摆模型），自动调参时很可能被 Kp=20 卡死、搜不到解。
- **借鉴做法**：`PID_LIMITS` 改为 `getPidLimits(mode)`，sim 模式放宽（如 Kp 0~500、Ki/Kd 0~100），hardware 模式收紧（保留现值），并允许策略注册表覆盖。

#### ③ 硬件配置文件（中优先，契合现有待办）

- **他们的做法**：`hw/profiles.py` 让用户选板子就能自动带出协议格式 / 控制器数 / 指令模板 / 视觉中心。
- **借鉴做法**：对应我们"策略模板扩充（直立环/速度环/舵机环等更多竞赛系统预设）"的待办——但他们是按"板卡"分，我们是按"控制对象"分，两者可结合：**竞赛板卡预设（STM32/ESP32/STC51）× 控制对象预设（速度环/位置环/直立环）**，新手开箱即用。

#### ④ 其他可参考的细节

- **串级回退带 `secondary_pid`**：双控制器场景的回退同时恢复主/副环参数——我们串级 6 参数回退时可借鉴。
- **运行时多目标值验证**：一个 setpoint 调好后换另一个再验——竞赛里多工况验证有用。
- **PLC Modbus 适配器**：工业协议，对电赛/智能车场景相关性低，可作为未来"协议插件"的参考实现模式。
- **调参会话数据类拆分**（State/RoundEvaluation/DecisionOutcome）：我们 `pidTuningSession.mjs` 已覆盖核心状态机，但他们的 `RoundEvaluation` 含 `good_enough_detail`、`best_result_updated` 等字段，日志可观测性更好，可按需补。
- **i18n / 打包 / 环境诊断**：工程化打磨，优先级不高，按需取用。

### 6.4 小结

本次二刷最大的收获是两个**直接影响调参正确性**的点：
1. **observe 观察 bug**（#32）——我们当前的 `continue` 分支会破坏达标观察，应加 `'observe'` decision。
2. **分模式护栏**（#38）——仿真/硬件用同一套限幅会在仿真侧撞天花板，应分模式。

两者都是改动小、收益明确的借鉴项。硬件配置文件（#35）则是中期可做、能显著降低上手门槛的功能，与我们已有的"策略模板扩充"待办天然契合。

