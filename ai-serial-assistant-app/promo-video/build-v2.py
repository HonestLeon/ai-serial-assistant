# -*- coding: utf-8 -*-
"""生成 v2 主合成 index.html 与 renders/film-v2.srt。

复用 build-180.py 的 GLOBAL_CSS / EXTRA_CSS / srt_time / HTML 模板 / 时间轴写法，
画面重排为 8 幕；所有时间点来自 prepare-audio.py 产出的 audio-timing.json。
"""
import html
import io
import json
import os
import re

from script_v2 import SCENES, SCENE_ORDER, kicker_of

BASE = os.path.dirname(os.path.abspath(__file__))
OLD = io.open(os.path.join(BASE, "archive", "film-60s-v3.html"), encoding="utf-8").read()
STYLE_START = OLD.find("<style>")
STYLE_END = OLD.find("</style>")
GLOBAL_CSS = OLD[STYLE_START + 7:STYLE_END]

V1 = io.open(os.path.join(BASE, "build-180.py"), encoding="utf-8").read()
EXTRA_CSS_V1 = re.search(r'EXTRA_CSS = r"""(.*?)"""', V1, re.S).group(1)

T = json.load(io.open(os.path.join(BASE, "audio-timing.json"), encoding="utf-8"))
TOTAL = T["total"]
LINES = T["lines"]
BEATS = T["beats"]
SCENES_T = T["scenes"]


def srt_time(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


# ---------------------------------------------------------------- 追加 CSS
EXTRA_CSS_V2 = EXTRA_CSS_V1 + r"""

      /* ================= v2 追加 ================= */
      /* 解说式字幕：底部对齐、向上生长，避免被画布底边裁切 */
      #caption { bottom: 56px; height: 0; z-index: 45; }
      .sub { left: 140px; right: 140px; bottom: 0; }
      .sub span { max-width: 1400px; padding: 16px 40px; font-size: 34px; line-height: 1.5;
                  letter-spacing: 0.3px; white-space: normal; word-break: break-word; }
      .sub-kick { display: block; margin-bottom: 6px; font-family: var(--font-mono);
                  font-style: normal; font-size: 17px; letter-spacing: 3px; color: var(--cyan); }

      /* 作品名卡 */
      .v2-logo { position: absolute; left: 140px; top: 286px; font-size: 132px; line-height: 1.1;
                 font-weight: 800; letter-spacing: -2px; color: var(--ink); }
      .v2-logo .cyan { color: var(--cyan); }
      .v2-logo .en { font-family: var(--font-mono); font-size: 74px; font-weight: 400;
                     letter-spacing: 8px; color: var(--cyan-soft); }
      .v2-sub { position: absolute; left: 146px; top: 474px; width: 1620px; font-size: 36px;
                line-height: 1.5; letter-spacing: 1px; color: #cbd5e1; }
      .v2-sub .cyan { color: var(--cyan); }
      .v2-kicker { position: absolute; left: 120px; top: 214px; font-family: var(--font-mono);
                   font-size: 20px; letter-spacing: 3px; color: var(--amber); }

      /* 团队 / 成员卡 */
      #b-team .team-row { top: 300px; }
      #b-team .team-card { min-height: 330px; padding: 36px 32px; }
      #b-team .team-name { font-size: 46px; }
      #b-team .team-role { margin-top: 20px; font-size: 26px; line-height: 1.7; color: #cbd5e1; }
      .team-foot { position: absolute; left: 120px; bottom: 170px; width: 1680px;
                   font-size: 23px; color: var(--muted); letter-spacing: 1px; }

      /* 创意逻辑 / 里程碑 / roadmap 共用 evo-row */
      #b-origin .evo-row, #b-timeline .evo-row, #b-roadmap .evo-row { top: 330px; }
      #b-origin .evo-card, #b-timeline .evo-card, #b-roadmap .evo-card { min-height: 280px; }
      #b-timeline .evo-desc, #b-roadmap .evo-desc { font-size: 20px; line-height: 1.7; }
      .origin-note { position: absolute; left: 120px; top: 660px; width: 1680px;
                     font-size: 25px; color: #cbd5e1; }

      /* 问卷 5 卡 */
      #b-survey .stat-row { left: 100px; right: 100px; }
      #b-survey .stat-card { padding: 28px 18px; }
      #b-survey .stat-num { font-size: 68px; }
      #b-survey .stat-label { font-size: 21px; }

      /* 评审意见 4 行 */
      #b-review .feedback-list { top: 300px; }
      #b-review .feedback-row { padding: 30px 0; }

      /* 交付数字 */
      #b-deliver .dash-grid { top: 330px; }

      /* 功能三卡 */
      #b-capability .guard-extra { top: 620px; }

      /* Agent 五步 */
      #b-agent .step-row { top: 380px; left: 160px; right: 160px; width: 1600px; }
      #b-agent .step { font-size: 24px; padding: 22px 8px; }
      .agent-foot { position: absolute; left: 160px; top: 620px; width: 1600px;
                    font-size: 24px; color: var(--muted); }

      /* 实机演示 */
      #b-demo .demo-frame { top: 200px; left: 260px; width: 1400px; height: 660px; }
      #b-demo .demo-badge { top: 150px; right: 260px; }
      #b-demo .step-row { top: 880px; left: 260px; width: 1400px; }

      /* 使用说明 5 步 */
      .flow-row { position: absolute; left: 140px; right: 140px; top: 250px;
                  display: flex; flex-direction: column; gap: 12px; }
      .flow-card { display: flex; align-items: center; gap: 26px; min-height: 96px;
                   padding: 14px 28px; border: 1px solid rgba(34,211,238,0.18);
                   border-radius: 14px; background: rgba(7,16,30,0.86); }
      .flow-card b { font-family: var(--font-mono); font-size: 32px; color: var(--cyan);
                     width: 64px; flex: none; }
      .flow-t { font-size: 28px; font-weight: 700; color: var(--ink); width: 210px; flex: none; }
      .flow-d { font-size: 21px; color: #cbd5e1; line-height: 1.5; }

      /* 零硬件 / 商业模式 */
      #b-zero .guard-extra { top: 330px; }
      #b-zero .guard-card { min-height: 220px; }
      #b-model .unit-row { top: 360px; }
      #b-model .unit-card { min-height: 140px; }
      #b-model .unit-card b { font-size: 34px; }

      /* 片尾：合规说明上移避开字幕，并提高对比度 */
      .end-hand { color: #c2410c; }
      .end-title .orange { color: #c2410c; }
      .end-links { color: #475569; }
      .end-compliance { position: absolute; left: 140px; bottom: 250px; width: 1640px;
                        font-size: 19px; line-height: 1.6; color: #556273; }

      /* 底部安全区：贴底辅助文字与步骤条上移，避开字幕胶囊（字幕顶边约 y=888） */
      .ui-frame { height: 600px; }
      .team-foot { bottom: 300px; }
      #b-survey .stat-foot { bottom: 300px; }
      #b-model .evo-foot { bottom: 300px; }
      #b-demo .demo-frame { height: 580px; }
      #b-demo .step-row { top: 792px; }
"""

# ---------------------------------------------------------------- 字幕
def sub_html(ln):
    body = "<br/>".join(html.escape(s) for s in ln["text"].split("\n"))
    kick = '<em class="sub-kick" data-layout-ignore>%s</em>' % html.escape(kicker_of(ln["scene"]))
    return '<div class="sub" id="sub-%d"><span>%s%s</span></div>' % (ln["i"], kick, body)


SUBS_HTML = "\n".join(sub_html(ln) for ln in LINES)
SRT = "\n".join(
    "%d\n%s --> %s\n%s\n" % (n, srt_time(ln["start"]), srt_time(ln["end"]), ln["text"])
    for n, ln in enumerate(LINES, 1)
)

# ---------------------------------------------------------------- 8 幕画面
def chapter(label, title):
    return ('<div class="chapter"><div class="scene-label">%s</div>'
            '<div class="beat-title">%s</div></div>' % (label, title))


STEPS = ["查数据", "改参数", "设目标", "看响应", "再决策"]
FLOW = [
    ("01", "连接串口", "选协议 Raw / JustFloat / FireWater，刷新端口，115200 8N1，打开串口"),
    ("02", "看波形与数据", "实时多通道波形、数据表 I0–I7，支持录制与一键回放"),
    ("03", "配置 AI", "填模型、Base URL 与 API Key；Key 仅存当前会话"),
    ("04", "开始调参", "切「PID 调参」，选仿真 / 真实串口与策略，填 PID 初值、安全范围、场景提示词"),
    ("05", "看闭环与下发", "输入「开始整定，优先压超调」；实机下发 PID / SET_POINT，约 12 秒采集窗口"),
]

BEATS_HTML = {}

BEATS_HTML["b-title"] = chapter("00 / 作品与团队", "智串AI · TUNER") + """
  <div class="v2-kicker">参赛作品 · AI 应用成果</div>
  <div class="v2-logo">智串<span class="cyan">AI</span> <span class="en">TUNER</span></div>
  <div class="v2-sub">AI 串口调试助手　·　面向<span class="cyan">电赛 / 智能车 / RC / RM</span> 的赛前调参加速器<br>
  把「查资料 → 手动试参 → 盯波形」的数天循环，压成「一句目标 + AI 自主闭环」</div>
"""

BEATS_HTML["b-team"] = chapter("00 / 作品与团队", "咕电子队 · 三人协作") + """
  <div class="team-row">
    <div class="team-card"><div class="team-name">刘双瑞</div><div class="team-role">队长 · 路演负责人<br>后端算法</div></div>
    <div class="team-card"><div class="team-name">吴程龙秀</div><div class="team-role">技术主管<br>前端</div></div>
    <div class="team-card"><div class="team-name">胡雨杨</div><div class="team-role">产品经理<br>调研 · PPT</div></div>
  </div>
  <div class="team-foot">三名人工智能 / 具身智能方向本科生　·　每日立会 + 任务认领看板 + 交叉联调　·　三轮评审迭代</div>
"""

BEATS_HTML["b-origin"] = chapter("01 / 创意的产生", "调研 20+ 款工具，没有一款支持 AI") + """
  <div class="v2-kicker">核心逻辑：先打通数据链路，再叠加自动调参</div>
  <div class="evo-row">
    <div class="evo-card"><div class="evo-date">01</div><div class="evo-title">数据采集</div><div class="evo-desc">串口原始数据流</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">02</div><div class="evo-title">波形绘制</div><div class="evo-desc">多通道实时曲线</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">03</div><div class="evo-title">特征分析</div><div class="evo-desc">确定性响应指标</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">04</div><div class="evo-title">叠加 AI</div><div class="evo-desc">护栏内自主调参</div></div>
  </div>
  <div class="origin-note">起点不是空地，而是「有骨架、缺灵魂」——先做确定性分析，再让 AI 在护栏内动手。</div>
"""

BEATS_HTML["b-quotes"] = chapter("01 / 创意的产生", "他们这样说") + """
  <div class="quote-row">
    <div class="quote-card"><div class="qmark">“</div><div class="qtext">手动调参只能调个大概，经常被压力，变成背锅侠。</div><div class="qauthor">— 电控队员 · 问卷原话</div></div>
    <div class="quote-card"><div class="qmark">“</div><div class="qtext">怕没用，更怕 AI 乱调把机械弄坏。</div><div class="qauthor">— 智能车队员 · 访谈原话</div></div>
    <div class="quote-card"><div class="qmark">“</div><div class="qtext">不能把参数和对应效果联系起来，希望告诉我现象对应什么问题、该怎么调。</div><div class="qauthor">— 电控队员 · 问卷原话</div></div>
  </div>
"""

BEATS_HTML["b-survey"] = chapter("01 / 创意的产生", "7 份问卷，痛点很集中") + """
  <div class="stat-row">
    <div class="stat-card"><div class="stat-num">100%</div><div class="stat-label">反复试错最耗时</div></div>
    <div class="stat-card"><div class="stat-num">42.9%</div><div class="stat-label">单次调参 ≥ 3 天</div></div>
    <div class="stat-card"><div class="stat-num">57.1%</div><div class="stat-label">赛场离线是刚需</div></div>
    <div class="stat-card"><div class="stat-num">85.7%</div><div class="stat-label">愿意赛前试用</div></div>
    <div class="stat-card"><div class="stat-num">71.4%</div><div class="stat-label">要 AI 建议 + 人工确认</div></div>
  </div>
  <div class="stat-foot">来源：赛前问卷 · 7 份有效样本（全 985 低年级）</div>
"""

BEATS_HTML["b-timeline"] = chapter("02 / 创造的过程", "从 6/29 到 8/25，四阶段可运行交付") + """
  <div class="evo-row">
    <div class="evo-card"><div class="evo-date">06-29</div><div class="evo-title">技术选型</div><div class="evo-desc">Electron + Vue 3 骨架<br>确定「数据 → 波形 → 分析」主链路</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">07-22~28</div><div class="evo-title">分析 MVP</div><div class="evo-desc">确定性响应分析<br>PID 仿真与安全护栏雏形</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">08-07</div><div class="evo-title">重构决策</div><div class="evo-desc">调研 AI Harness<br>改为对话式自主智能体</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">08-25</div><div class="evo-title">v1.1.0</div><div class="evo-desc">Agent 上线<br>NSIS 安装包发布</div></div>
  </div>
  <div class="milestone-row">
    <div class="ms"><b>07-17</b> 选题答辩</div>
    <div class="ms"><b>07-20</b> 计划 V1</div>
    <div class="ms"><b>08-01</b> 中期评审</div>
    <div class="ms"><b>08-23</b> 前端大改</div>
    <div class="ms"><b>08-28</b> 结题答辩</div>
  </div>
"""

BEATS_HTML["b-review"] = chapter("02 / 创造的过程", "两条评审意见，两次主动回应") + """
  <div class="feedback-list">
    <div class="feedback-row"><div class="fb-date">08-01</div><div class="fb-topic">意见 ①</div><div class="fb-problem">要找人真实测评并给出证据</div><div class="fb-fix">→ 7 问卷 → 12 深访 → 25 人扩测</div></div>
    <div class="feedback-row"><div class="fb-date">08-01</div><div class="fb-topic">意见 ②</div><div class="fb-problem">校内就有 500 支队伍，如何推广</div><div class="fb-fix">→ MIT 开源 + B 站 / GitHub / 竞赛社群</div></div>
    <div class="feedback-row"><div class="fb-date">08-07</div><div class="fb-topic">关键决策</div><div class="fb-problem">AI 只给建议，试参仍靠手</div><div class="fb-fix">→ 重构为对话式自主智能体</div></div>
    <div class="feedback-row"><div class="fb-date">08-25</div><div class="fb-topic">交付</div><div class="fb-problem">5 条体验反馈全部闭环</div><div class="fb-fix">→ v1.1.0 安装包 + 三份文档</div></div>
  </div>
"""

BEATS_HTML["b-deliver"] = chapter("02 / 创造的过程", "交付物，全部可复现") + """
  <div class="dash-grid">
    <div class="dash-card"><div class="dash-num">28</div><div class="dash-label">源文件</div><div class="dash-sub">8,422 行代码</div></div>
    <div class="dash-card"><div class="dash-num">18</div><div class="dash-label">测试文件</div><div class="dash-sub">12 项自测全绿</div></div>
    <div class="dash-card"><div class="dash-num">51</div><div class="dash-label">验证波形</div><div class="dash-sub">含 CSV 原始数据</div></div>
    <div class="dash-card"><div class="dash-num">v1.1.0</div><div class="dash-label">NSIS 安装包</div><div class="dash-sub">31 次 Git 提交 · 6 篇文档</div></div>
  </div>
"""

BEATS_HTML["b-panorama"] = chapter("03 / 作品功能", "一个工作台：波形 · 分析 · 数据 · 调参") + """
  <div class="ui-frame"><img src="./assets/ui-dark.png" alt="TUNER 主界面" /></div>
  <div class="callout-list">
    <div class="callout-row"><span class="dot"></span><div><div class="c-title">实时波形</div><div class="c-desc">多通道缩放平移 · CSV / JSON 导出</div></div></div>
    <div class="callout-row"><span class="dot"></span><div><div class="c-title">确定性分析</div><div class="c-desc">上升 / 稳定时间 · 超调 · 稳态误差 · RMSE</div></div></div>
    <div class="callout-row"><span class="dot"></span><div><div class="c-title">数据表 · 回放</div><div class="c-desc">I0–I7 结构化 · 一键重放</div></div></div>
    <div class="callout-row"><span class="dot"></span><div><div class="c-title">PID 调参 Agent</div><div class="c-desc">对话式自主闭环</div></div></div>
  </div>
"""

BEATS_HTML["b-capability"] = chapter("03 / 作品功能", "本地算指标，三种仿真策略") + """
  <div class="guard-row">
    <div class="guard-card"><div class="guard-num">01</div><div class="guard-title">确定性响应分析</div><div class="guard-desc">上升 / 稳定时间、超调、稳态误差、RMSE 全部本地计算，离线可用</div></div>
    <div class="guard-card"><div class="guard-num">02</div><div class="guard-title">三种仿真策略</div><div class="guard-desc">电机速度环 · 位置-速度串级 PID · 倒立摆，无需硬件即可体验</div></div>
    <div class="guard-card"><div class="guard-num">03</div><div class="guard-title">技术栈</div><div class="guard-desc">Electron 42 · Vue 3.5 · ECharts 6 · serialport 13</div></div>
  </div>
  <div class="guard-extra">
    <div class="guard-card"><div class="guard-title">AI 解释</div><div class="guard-desc">把指标与数据打包成结构化上下文，只解释现象，不生成、不下发 PID 参数</div></div>
    <div class="guard-card"><div class="guard-title">上下文工程</div><div class="guard-desc">50KB 压缩只压数据块 · 随时插话 steer · 结束后 followUp · 前 5 轮防早收</div></div>
  </div>
"""

BEATS_HTML["b-agent"] = chapter("03 / 作品功能", "一句目标，Agent 自主闭环") + """
  <div class="step-row">""" + "".join(
    '<div class="step"><b>%02d</b>%s</div>' % (i, s) for i, s in enumerate(STEPS, 1)
) + """</div>
  <div class="agent-foot">查数据 → 改参数 → 设目标 → 看响应 → 再决策　·　达标自动收敛　·　运行中可随时插话纠偏</div>
"""

BEATS_HTML["b-guard"] = chapter("03 / 作品功能", "三重护栏，越界自动回退") + """
  <div class="guard-row">
    <div class="guard-card"><div class="guard-num">01</div><div class="guard-title">用户设定范围</div><div class="guard-desc">参数上下限由用户设定，Agent 只在区间内动作</div></div>
    <div class="guard-card"><div class="guard-num">02</div><div class="guard-title">系统硬上限</div><div class="guard-desc">Kp ≤ 20、Ki / Kd ≤ 10；单步增幅拦截，避免一次调过头</div></div>
    <div class="guard-card"><div class="guard-num">03</div><div class="guard-title">越界自动回退</div><div class="guard-desc">超调 &gt; 20% 或振荡 &gt; 10%，回到最佳稳定参数并醒目提示</div></div>
  </div>
  <div class="guard-extra">
    <div class="guard-card"><div class="guard-title">仿真 / 真实串口双模式</div><div class="guard-desc">仿真纯软件、零硬件；实机改参下发 PID、设目标下发 SET_POINT</div></div>
    <div class="guard-card"><div class="guard-title">安全不能靠提示词</div><div class="guard-desc">护栏与回退写进代码机制，正面回应「怕 AI 乱调把机械弄坏」</div></div>
  </div>
"""

_demo = BEATS["b-demo"]
_video_start = round(_demo["start"] + 0.4, 2)
assert _video_start + 11.5 <= _demo["end"], "b-demo 时长不足以容纳 11.5s 演示视频"
BEATS_HTML["b-demo"] = chapter("04 / 作品演示", "实机演示 · 倒立摆仿真") + """
  <div class="demo-frame">
    <video id="agent-video" data-start="%.2f" data-duration="11.5" data-media-start="0" src="./assets/agent/agent-session-v2.mp4" muted playsinline></video>
  </div>
  <div class="demo-badge">仿真演示 · 倒立摆</div>
  <div class="step-row">""" % _video_start + "".join(
    '<div class="step"><b>%02d</b>%s</div>' % (i, s) for i, s in enumerate(STEPS, 1)
) + """</div>
"""

BEATS_HTML["b-case"] = chapter("04 / 作品演示", "倒立摆：102% → 0.24%") + """
  <div class="case-copy">
    <div class="case-kicker">仿真案例 · INVERTED PENDULUM</div>
    <div class="case-big"><span class="red">102%</span> → <span class="green">0.24%</span></div>
    <div class="case-desc">超调 102% 触发安全网，自动回退；Agent 再决策，收敛到 0.24%。</div>
  </div>
  <div class="case-chart">
    <div id="case-curve-reveal" data-layout-allow-overflow>
      <svg viewBox="0 0 980 520" xmlns="http://www.w3.org/2000/svg" data-layout-allow-overflow>
        <line x1="70" y1="430" x2="930" y2="430" stroke="rgba(148,163,184,0.3)" stroke-width="1.5"/>
        <line x1="70" y1="60" x2="70" y2="430" stroke="rgba(148,163,184,0.3)" stroke-width="1.5"/>
        <line x1="70" y1="168" x2="930" y2="168" stroke="rgba(248,113,113,0.55)" stroke-width="1.5" stroke-dasharray="8 8"/>
        <text x="82" y="158" fill="#f87171" font-size="18" font-family="Consolas, monospace">安全线</text>
        <path d="M70 430 L170 430 L215 80 L260 205 L330 380 Q420 440 540 424 L930 420" fill="none" stroke="rgba(248,113,113,0.75)" stroke-width="3"/>
        <path d="M70 430 L190 430 L235 250 L300 360 Q390 430 520 418 L930 414" fill="none" stroke="#34d399" stroke-width="3"/>
        <text x="178" y="62" fill="#f87171" font-size="30" font-family="Consolas, monospace">102%</text>
        <text x="700" y="398" fill="#34d399" font-size="30" font-family="Consolas, monospace">0.24%</text>
        <text x="780" y="470" fill="#94a3b8" font-size="18" font-family="Consolas, monospace">时间</text>
      </svg>
    </div>
  </div>
"""

BEATS_HTML["b-usage"] = chapter("05 / 使用说明", "五步，完成一次调参") + """
  <div class="flow-row">""" + "".join(
    '<div class="flow-card" id="flow-%d"><b>%s</b><div class="flow-t">%s</div><div class="flow-d">%s</div></div>' % (i, n, t, d)
    for i, (n, t, d) in enumerate(FLOW, 1)
) + """</div>
"""

BEATS_HTML["b-zero"] = chapter("05 / 使用说明", "没有硬件，也能完整体验") + """
  <div class="guard-extra">
    <div class="guard-card"><div class="guard-title">零硬件路径</div><div class="guard-desc">点「控制响应模拟」，生成 50ms 采样的二阶欠阻尼阶跃响应</div></div>
    <div class="guard-card"><div class="guard-title">零 Key 路径</div><div class="guard-desc">切到「数据分析」查看本地响应指标，无需硬件、无需 API Key</div></div>
  </div>
"""

BEATS_HTML["b-roadmap"] = chapter("06 / 未来规划", "短期闭环，中期扩场景，长期成默认工具") + """
  <div class="evo-row">
    <div class="evo-card"><div class="evo-date">短期 3 个月</div><div class="evo-title">打通真实闭环</div><div class="evo-desc">接通参数写回链路，完成真实硬件实测<br>GitHub 开源 + B 站上手视频<br>进电赛群 / 智能车社团招募实测</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">中期 · v1.2</div><div class="evo-title">策略与场景扩充</div><div class="evo-desc">直立环 / 舵机环<br>Z-N · 继电离线整定（误差 ≤ 15%）<br>策略模板扩充 · 系统辨识</div></div>
    <div class="evo-arrow">→</div>
    <div class="evo-card"><div class="evo-date">长期</div><div class="evo-title">竞赛圈默认工具</div><div class="evo-desc">FireWater 协议插件<br>云端 LLM 诊断增强<br>让 AI 调参成为备赛标配</div></div>
  </div>
"""

BEATS_HTML["b-model"] = chapter("06 / 未来规划", "免费开源，分层服务") + """
  <div class="unit-row">
    <div class="unit-card"><b>¥0</b><span>MIT 开源 · 完整基础功能 · 已发布</span></div>
    <div class="unit-card"><b>¥10 / 月</b><span>高级版 · 云端报告 / 策略模板（规划中）</span></div>
    <div class="unit-card"><b>按次 API</b><span>≈¥0.06 / 次 · 赛事 / 教育 / 企业</span></div>
  </div>
  <div class="evo-foot">渠道：B 站 + GitHub + 竞赛社群三位一体　·　先服务校内 500 支队伍，首批 50 支种子</div>
"""

BEATS_HTML["b-close"] = """
  <div class="end-card">
    <div class="end-kicker">智串AI · TUNER　|　咕电子队　|　2026.11</div>
    <div class="end-title">把「调参靠经验」，<br>变成「调参靠<span class="teal">数据</span> + <span class="orange">AI</span>」。</div>
    <div class="end-hand">刘双瑞 · 吴程龙秀 · 胡雨杨</div>
    <div class="end-links">GitHub　HonestLeon/ai-serial-assistant　·　Gitee　Honest_Leon/ai-serial-assistant　（MIT · 欢迎试用）</div>
    <div class="end-compliance">本片由 HyperFrames + GSAP 时间轴（本地脚本生成）；解说与画面结构经 AI 辅助起草，由团队人工编排、事实校对与逐帧审片；界面截图与实机录屏均为本作品真实产物。</div>
  </div>
"""

# ---------------------------------------------------------------- 组装 BODY
scene_blocks = []
for sid, label, bids in SCENES:
    inner = []
    for bid in bids:
        inner.append('<div class="beat" id="%s">\n%s\n</div>' % (bid, BEATS_HTML[bid]))
    scene_blocks.append('<div id="sc-%s" class="scene">\n%s\n</div>' % (sid, "\n".join(inner)))
SCENES_HTML = "\n".join(scene_blocks)

_mm, _ss = int(TOTAL) // 60, int(TOTAL) % 60
BODY = f"""
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="{TOTAL:.3f}"
      data-width="1920"
      data-height="1080"
    >
      <div id="film" class="frame">
        <div id="bg"></div>
        <div id="grid" data-layout-allow-overflow></div>
        <div id="flare"></div>
        <div id="scanlines"></div>
        <div id="vignette"></div>

        <div id="hud">
          <div class="hud-left">
            <span class="hud-dot"></span>
            <span data-layout-ignore>TUNER / AI SERIAL ASSISTANT</span>
          </div>
          <div class="hud-right">
            <span data-layout-ignore>作品介绍 / {_mm}:{_ss:02d}</span>
          </div>
        </div>

        <div id="progress-track"><div id="progress-fill"></div></div>

{SCENES_HTML}

        <div id="dip"></div>
        <div id="caption">
          {SUBS_HTML}
        </div>
      </div>
      <audio id="vo" data-start="0" data-duration="{TOTAL:.3f}" data-volume="1" src="./{T['voice']}"></audio>
      <audio id="bgm" data-start="0" data-duration="{TOTAL:.3f}" data-volume="0.22" data-fade-in="1.5" data-fade-out="3" src="./{T['bgm']}"></audio>
    </div>
"""

# ---------------------------------------------------------------- 时间轴
L = []


def add(s):
    L.append(s)


def tw(sel, props, at, method="to"):
    add('tl.%s("%s", { %s }, %.2f);' % (method, sel, props, at))


add("const tl = gsap.timeline({ paused: true });")
add('gsap.set(".scene", { opacity: 0 });')
add('gsap.set(".beat", { opacity: 0 });')
add('gsap.set(".sub", { opacity: 0, y: 12 });')
add('gsap.set("#dip", { opacity: 0 });')
add('gsap.set("#hud", { opacity: 0 });')
add('gsap.set("#progress-fill", { width: 0 });')
add('gsap.set("#case-curve-reveal", { width: 0 });')
add('gsap.set("#sc-s0", { opacity: 1 });')
add('gsap.set("#b-title", { opacity: 1 });')

# 全局
tw("#hud", "opacity: 1, duration: 0.6", 0.2)
tw("#progress-fill", "width: 1920, duration: %.2f, ease: \"none\"" % TOTAL, 0)
tw("#grid", "x: -80, y: -50, duration: %.2f, ease: \"none\"" % TOTAL, 0)
for frac in (0.02, 0.30, 0.62):
    tw("#flare", "opacity: 0.34, duration: 22, ease: \"sine.inOut\"", TOTAL * frac)

# 每个 beat 的进场动画（子元素 stagger）
ANIM = {
    "b-title": [],
    "b-team": [(".team-card", "opacity: 0, y: 24, duration: 0.45, stagger: 0.14")],
    "b-origin": [(".evo-card", "opacity: 0, y: 24, duration: 0.45, stagger: 0.12"),
                 (".evo-arrow", "opacity: 0, duration: 0.3, stagger: 0.1")],
    "b-quotes": [(".quote-card", "opacity: 0, y: 28, duration: 0.5, stagger: 0.16")],
    "b-survey": [(".stat-card", "opacity: 0, y: 24, duration: 0.4, stagger: 0.12")],
    "b-timeline": [(".evo-card", "opacity: 0, y: 24, duration: 0.45, stagger: 0.12"),
                   (".ms", "opacity: 0, y: 16, duration: 0.35, stagger: 0.1")],
    "b-review": [(".feedback-row", "opacity: 0, x: 18, duration: 0.35, stagger: 0.11")],
    "b-deliver": [(".dash-card", "opacity: 0, y: 22, duration: 0.45, stagger: 0.12")],
    "b-panorama": [(".ui-frame", "opacity: 0, x: -26, duration: 0.65"),
                   (".callout-row", "opacity: 0, x: 20, duration: 0.4, stagger: 0.12")],
    "b-capability": [(".guard-row .guard-card", "opacity: 0, y: 26, duration: 0.45, stagger: 0.14"),
                     (".guard-extra .guard-card", "opacity: 0, y: 20, duration: 0.4, stagger: 0.12")],
    "b-agent": [(".step", "opacity: 0, y: 18, duration: 0.4, stagger: 0.12")],
    "b-guard": [(".guard-row .guard-card", "opacity: 0, y: 26, duration: 0.45, stagger: 0.14"),
                (".guard-extra .guard-card", "opacity: 0, y: 20, duration: 0.4, stagger: 0.12")],
    "b-demo": [(".demo-frame", "opacity: 0, scale: 0.97, duration: 0.5")],
    "b-case": [(".case-copy", "opacity: 0, x: -24, duration: 0.5")],
    "b-usage": [(".flow-card", "opacity: 0, x: 24, duration: 0.4, stagger: 0.1")],
    "b-zero": [(".guard-card", "opacity: 0, y: 24, duration: 0.45, stagger: 0.14")],
    "b-roadmap": [(".evo-card", "opacity: 0, y: 24, duration: 0.45, stagger: 0.14")],
    "b-model": [(".unit-card", "opacity: 0, y: 18, duration: 0.4, stagger: 0.12")],
    "b-close": [(".end-title", "opacity: 0, y: 26, duration: 0.6"),
                (".end-hand", "opacity: 0, y: 16, duration: 0.5"),
                (".end-links", "opacity: 0, duration: 0.5"),
                (".end-compliance", "opacity: 0, duration: 0.5")],
}

last_sid = SCENE_ORDER[-1]
last_scene_start = SCENES_T[last_sid]["start"]

for sid in SCENE_ORDER:
    sc = SCENES_T[sid]
    dom = "#sc-" + sid
    tw(dom, "opacity: 1, duration: 0.45", sc["start"])
    if sid != last_sid:
        tw(dom, "opacity: 0, duration: 0.3", sc["end"] - 0.3)
        tw("#dip", "opacity: 0.92, duration: 0.1", sc["end"] - 0.25)
        tw("#dip", "opacity: 0, duration: 0.32", sc["end"] - 0.13)

for bid, b in BEATS.items():
    st, en = b["start"], b["end"]
    tw("#" + bid, "opacity: 1, duration: 0.35", st + 0.05)
    if bid != "b-close":
        tw("#" + bid, "opacity: 0, duration: 0.3", en - 0.3)
    for sel, props in ANIM.get(bid, []):
        tw("#" + bid + " " + sel, props, st + 0.2, "from")

# 五步 / 流程卡依次点亮
for bid in ("b-agent", "b-demo"):
    b = BEATS[bid]
    span = b["end"] - b["start"]
    for k in range(1, 6):
        at = b["start"] + 0.6 + (span - 2.2) * (k - 1) / 5.0
        tw("#%s .step:nth-child(%d)" % (bid, k),
           'backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2',
           at)

b = BEATS["b-usage"]
span = b["end"] - b["start"]
for k in range(1, 6):
    at = b["start"] + 0.6 + (span - 2.2) * (k - 1) / 5.0
    tw("#flow-%d" % k,
       'borderColor: "rgba(52,211,153,0.55)", backgroundColor: "rgba(6,40,32,0.6)", duration: 0.25',
       at)

# 曲线揭示
b = BEATS["b-case"]
tw("#case-curve-reveal", "width: 980, duration: 1.1, ease: \"power2.inOut\"", b["start"] + 0.4)

# 片尾 HUD 淡出
tw("#hud", "opacity: 0, duration: 0.3", last_scene_start - 0.4)

# 字幕
for ln in LINES:
    tw("#sub-%d" % ln["i"], "opacity: 1, y: 0, duration: 0.3", ln["start"])
    tw("#sub-%d" % ln["i"], "opacity: 0, y: -8, duration: 0.25", ln["end"])

add('window.__timelines = window.__timelines || {};')
add('window.__timelines["main"] = tl;')

SCRIPT = "\n      ".join(L)

# 断言：所有绝对时间不越界
_at = []
for line in L:
    m = re.search(r",\s*([0-9]+\.[0-9]{2})\);$", line)
    if m:
        _at.append(float(m.group(1)))
assert max(_at) <= TOTAL + 0.5, "时间轴出现越界时间点: %.2f > %.2f" % (max(_at), TOTAL)
assert LINES[-1]["end"] <= TOTAL, "末条字幕越界"

HTML = f"""<!doctype html>
<html lang="zh-CN" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>智串AI · TUNER 演示视频 v2</title>
    <script src="./assets/gsap.min.js"></script>
    <style>
{GLOBAL_CSS}
{EXTRA_CSS_V2}
    </style>
  </head>
  <body>
{BODY}
    <script>
      {SCRIPT}
    </script>
  </body>
</html>
"""

with io.open(os.path.join(BASE, "index.html"), "w", encoding="utf-8") as f:
    f.write(HTML)
with io.open(os.path.join(BASE, "renders", "film-v2.srt"), "w", encoding="utf-8") as f:
    f.write(SRT)

print("index.html: %d bytes" % len(HTML.encode("utf-8")))
print("film-v2.srt: %d 条, 末条 %.2fs / TOTAL %.2fs" % (len(LINES), LINES[-1]["end"], TOTAL))
print("时间轴语句: %d 条, 最大时间点 %.2fs" % (len(L), max(_at)))
