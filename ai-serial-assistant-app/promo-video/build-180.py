import io, math, os

BASE = os.path.dirname(os.path.abspath(__file__))
OLD = io.open(os.path.join(BASE, "archive", "film-60s-v3.html"), encoding="utf-8").read()
STYLE_START = OLD.find("<style>")
STYLE_END = OLD.find("</style>")
GLOBAL_CSS = OLD[STYLE_START + 7:STYLE_END]

EXTRA_CSS = r"""
      /* ================= 180s film ================= */
      .scene { opacity: 0; }
      #scene-hook, #scene-problem, #scene-product, #scene-proof, #scene-market, #scene-close { z-index: 10; }
      .beat { position: absolute; inset: 0; opacity: 0; }
      .chapter { position: absolute; left: 120px; top: 72px; width: 1680px; }
      .beat-title { margin-top: 14px; font-size: 64px; line-height: 1.14; font-weight: 700; letter-spacing: -1.5px; color: var(--ink); }

      /* hook */
      #hook-title { position: absolute; left: 140px; top: 250px; width: 980px; }
      .hook-big { margin-top: 22px; font-size: 126px; line-height: 1.1; font-weight: 800; letter-spacing: -4px; color: var(--ink); }
      #hook-pains { position: absolute; right: 120px; top: 300px; width: 560px; display: flex; flex-direction: column; gap: 22px; }
      .pain { display: flex; align-items: center; gap: 18px; padding: 22px 28px; border: 1px solid rgba(248,113,113,0.28); border-radius: 14px; background: rgba(30, 12, 18, 0.55); font-size: 30px; color: #fecaca; opacity: 0; }
      .pain b { font-family: var(--font-mono); color: var(--red); font-size: 34px; }
      #hook-brand { position: absolute; left: 140px; top: 380px; opacity: 0; }
      .hook-logo { font-size: 150px; line-height: 1; font-weight: 800; letter-spacing: 3px; color: var(--ink); }
      .hook-logo span { color: var(--cyan); }
      .hook-sub { margin-top: 18px; font-size: 38px; color: var(--cyan-soft); letter-spacing: 2px; }
      #hook-wave { position: absolute; left: 0; bottom: 126px; width: 1920px; height: 260px; opacity: 0.42; }
      #hook-wave-reveal { width: 0; height: 260px; overflow: hidden; }
      #hook-wave svg { display: block; width: 1920px; height: 260px; }

      /* quotes */
      .quote-row { position: absolute; left: 120px; right: 120px; top: 318px; display: flex; gap: 30px; }
      .quote-card { flex: 1; min-height: 356px; position: relative; padding: 30px 32px 76px; border: 1px solid rgba(34,211,238,0.18); border-radius: 18px; background: rgba(7,16,30,0.86); box-shadow: 0 24px 60px rgba(0,0,0,0.24); }
      .qmark { font-size: 72px; line-height: 0.9; color: var(--cyan); opacity: 0.55; font-family: Georgia, serif; }
      .qtext { margin-top: 12px; font-size: 30px; line-height: 1.55; color: #e2e8f0; }
      .qauthor { position: absolute; left: 32px; bottom: 28px; font-family: var(--font-mono); font-size: 18px; letter-spacing: 1px; color: var(--muted); }

      /* stats */
      .stat-row { position: absolute; left: 120px; right: 120px; top: 340px; display: flex; gap: 26px; }
      .stat-card { flex: 1; padding: 32px 30px; border: 1px solid rgba(34,211,238,0.18); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .stat-num { font-family: var(--font-mono); font-size: 92px; line-height: 1.05; color: var(--cyan); }
      .stat-num.amber { color: var(--amber); }
      .stat-label { margin-top: 12px; font-size: 24px; line-height: 1.4; color: #cbd5e1; }
      .stat-label .mini { font-size: 18px; color: var(--muted); }
      .stat-foot { position: absolute; left: 120px; bottom: 150px; font-family: var(--font-mono); font-size: 20px; letter-spacing: 2px; color: var(--muted); }

      /* matrix */
      .matrix-wrap { position: absolute; left: 120px; top: 300px; width: 900px; height: 560px; }
      .m-line-h { position: absolute; left: 0; top: 310px; width: 860px; height: 1px; background: rgba(148,163,184,0.26); }
      .m-line-v { position: absolute; left: 430px; top: 20px; width: 1px; height: 540px; background: rgba(148,163,184,0.26); }
      .m-axis-y { position: absolute; left: -96px; top: 250px; transform: rotate(-90deg); transform-origin: center; font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; color: var(--muted); white-space: nowrap; }
      .m-axis-x { position: absolute; left: 560px; bottom: -44px; font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; color: var(--muted); white-space: nowrap; }
      .m-dot { position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #94a3b8; }
      .m-label { position: absolute; font-size: 24px; color: #cbd5e1; white-space: nowrap; }
      .m-sub { position: absolute; font-size: 18px; color: var(--muted); white-space: nowrap; }
      .m-star { position: absolute; right: 46px; top: 42px; font-size: 54px; color: var(--amber); text-align: center; }
      .m-star-label { margin-top: 4px; font-family: var(--font-mono); font-size: 26px; letter-spacing: 4px; color: var(--amber); }
      .matrix-copy { position: absolute; right: 120px; top: 340px; width: 740px; font-size: 40px; line-height: 1.5; font-weight: 700; color: var(--ink); }
      .matrix-copy .small { margin-top: 20px; font-size: 22px; font-weight: 400; color: var(--muted); line-height: 1.6; }

      /* funnel */
      .funnel { position: absolute; left: 160px; top: 300px; width: 800px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
      .f-layer { height: 104px; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #fff; font-size: 32px; font-weight: 700; clip-path: polygon(0 0, 100% 0, 88% 100%, 12% 100%); }
      .f-layer span { margin-top: 2px; font-size: 17px; font-weight: 400; opacity: 0.9; }
      .value-line { position: absolute; right: 130px; top: 390px; width: 700px; font-size: 56px; line-height: 1.35; font-weight: 700; color: var(--ink); }
      .value-line .cyan { color: var(--cyan); }
      .value-note { position: absolute; right: 130px; top: 620px; width: 700px; font-size: 24px; line-height: 1.6; color: var(--muted); }

      /* panorama */
      .ui-frame { position: absolute; left: 100px; top: 260px; width: 1200px; height: 640px; border: 1px solid rgba(34,211,238,0.3); border-radius: 18px; overflow: hidden; background: #07101e; box-shadow: 0 40px 100px rgba(0,0,0,0.45); transform: perspective(2200px) rotateY(-8deg) rotateX(2deg); transform-origin: 50% 50%; }
      .ui-frame img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
      .callout-list { position: absolute; right: 90px; top: 286px; width: 460px; }
      .callout-row { display: flex; gap: 16px; padding: 20px 0; border-bottom: 1px solid rgba(148,163,184,0.16); }
      .callout-row .dot { width: 10px; height: 10px; margin-top: 9px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px rgba(34,211,238,0.8); flex: none; }
      .c-title { font-size: 30px; font-weight: 700; color: var(--ink); }
      .c-desc { margin-top: 6px; font-size: 21px; color: var(--muted); line-height: 1.5; }

      /* demo */
      #pdemo .chapter { top: 56px; width: 1080px; }
      #pdemo .beat-title { font-size: 52px; }
      .demo-frame { position: absolute; left: 300px; top: 176px; width: 1320px; height: 660px; border: 1px solid rgba(34,211,238,0.38); border-radius: 18px; overflow: hidden; background: #060d18; box-shadow: 0 40px 100px rgba(0,0,0,0.5); }
      .demo-frame video { display: block; width: 100%; height: 100%; object-fit: cover; }
      .demo-badge { position: absolute; right: 300px; top: 126px; left: auto; padding: 8px 16px; border: 1px solid rgba(245,158,11,0.45); border-radius: 999px; background: rgba(5,10,20,0.78); font-family: var(--font-mono); font-size: 17px; letter-spacing: 1.5px; color: var(--amber); }
      .step-row { position: absolute; left: 300px; top: 862px; width: 1320px; display: flex; justify-content: space-between; gap: 10px; }
      .step { flex: 1; padding: 14px 8px; border: 1px solid rgba(34,211,238,0.16); border-radius: 12px; background: rgba(7,16,30,0.7); text-align: center; font-size: 22px; color: var(--muted); }
      .step b { display: block; font-family: var(--font-mono); font-size: 15px; color: var(--cyan); margin-bottom: 4px; }
      .step.lit { border-color: rgba(52,211,153,0.55); color: #d1fae5; background: rgba(6, 40, 32, 0.6); }

      /* guardrails */
      .guard-row { position: absolute; left: 120px; right: 120px; top: 320px; display: flex; gap: 28px; }
      .guard-card { flex: 1; padding: 30px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .guard-num { font-family: var(--font-mono); font-size: 48px; color: var(--cyan); }
      .guard-title { margin-top: 10px; font-size: 30px; font-weight: 700; color: var(--ink); }
      .guard-desc { margin-top: 10px; font-size: 21px; line-height: 1.55; color: var(--muted); }
      .guard-extra { position: absolute; left: 120px; right: 120px; top: 640px; display: flex; gap: 28px; }
      .guard-extra .guard-card { flex: 1; min-height: 170px; }

      /* case */
      .case-copy { position: absolute; left: 140px; top: 300px; width: 600px; }
      .case-kicker { font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; color: var(--amber); }
      .case-big { margin-top: 20px; font-family: var(--font-mono); font-size: 120px; line-height: 1; color: var(--ink); }
      .case-big .red { color: var(--red); }
      .case-big .green { color: var(--green); }
      .case-desc { margin-top: 24px; font-size: 25px; line-height: 1.6; color: #cbd5e1; }
      .case-chart { position: absolute; right: 110px; top: 280px; width: 980px; height: 520px; }
      #case-curve-reveal { width: 0; height: 520px; overflow: hidden; }
      #case-curve-reveal svg { display: block; width: 980px; height: 520px; }

      /* evolution */
      .evo-row { position: absolute; left: 120px; right: 120px; top: 360px; display: flex; align-items: center; gap: 16px; }
      .evo-card { flex: 1; min-height: 260px; padding: 28px 24px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .evo-date { font-family: var(--font-mono); font-size: 22px; color: var(--cyan); letter-spacing: 1px; }
      .evo-title { margin-top: 12px; font-size: 30px; font-weight: 700; color: var(--ink); }
      .evo-desc { margin-top: 8px; font-size: 21px; color: var(--muted); line-height: 1.5; }
      .evo-arrow { font-size: 38px; color: var(--cyan); opacity: 0.7; }
      .evo-foot { position: absolute; left: 120px; right: 120px; bottom: 140px; font-size: 24px; color: #cbd5e1; letter-spacing: 0.5px; }

      /* dashboard */
      .dash-grid { position: absolute; left: 120px; right: 120px; top: 280px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; }
      .dash-card { min-height: 230px; padding: 28px 26px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .dash-num { font-family: var(--font-mono); font-size: 68px; line-height: 1.05; color: var(--cyan); }
      .dash-label { margin-top: 10px; font-size: 22px; color: #cbd5e1; line-height: 1.45; }
      .dash-sub { margin-top: 8px; font-size: 17px; color: var(--muted); line-height: 1.4; }
      .milestone-row { position: absolute; left: 120px; right: 120px; top: 600px; display: flex; gap: 16px; }
      .ms { flex: 1; padding: 18px 20px; border: 1px solid rgba(52,211,153,0.26); border-radius: 12px; background: rgba(6,30,26,0.55); font-size: 21px; color: #d1fae5; }
      .ms b { font-family: var(--font-mono); color: var(--green); }
      .ms.warn { border-color: rgba(245,158,11,0.3); background: rgba(35,25,8,0.5); color: #fde68a; }
      .ms.warn b { color: var(--amber); }

      /* deliverables */
      .wave-wall { position: absolute; left: 110px; top: 250px; width: 1120px; height: 640px; display: grid; grid-template-columns: repeat(9, 1fr); grid-auto-rows: 64px; gap: 10px; }
      .wave-tile { border: 1px solid rgba(34,211,238,0.14); border-radius: 8px; background: rgba(7,16,30,0.6); padding: 6px; }
      .wave-tile svg { display: block; width: 100%; height: 100%; }
      .deliver-stats { position: absolute; right: 120px; top: 286px; width: 540px; }
      .deliver-row { display: flex; justify-content: space-between; align-items: baseline; padding: 14px 0; border-bottom: 1px solid rgba(148,163,184,0.16); }
      .deliver-row .k { font-size: 22px; color: var(--muted); }
      .deliver-row .v { font-family: var(--font-mono); font-size: 32px; color: var(--cyan); }
      .deliver-note { margin-top: 18px; font-size: 19px; line-height: 1.6; color: var(--muted); }

      /* stories */
      .story-row { position: absolute; left: 120px; right: 120px; top: 300px; display: flex; gap: 28px; }
      .story-card { flex: 1; min-height: 440px; padding: 32px 30px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .story-tag { font-family: var(--font-mono); font-size: 17px; letter-spacing: 2px; color: var(--cyan); }
      .story-title { margin-top: 14px; font-size: 36px; font-weight: 700; line-height: 1.25; color: var(--ink); }
      .story-body { margin-top: 16px; font-size: 22px; line-height: 1.65; color: #cbd5e1; }
      .story-metric { position: absolute; left: 30px; bottom: 28px; font-family: var(--font-mono); font-size: 24px; color: var(--green); }
      .story-card { position: relative; }

      /* feedback */
      .feedback-list { position: absolute; left: 160px; right: 160px; top: 286px; }
      .feedback-row { display: flex; align-items: center; gap: 26px; padding: 19px 0; border-bottom: 1px solid rgba(148,163,184,0.14); }
      .fb-date { width: 90px; font-family: var(--font-mono); font-size: 22px; color: var(--cyan); }
      .fb-topic { width: 180px; font-size: 22px; color: var(--ink); }
      .fb-problem { flex: 1; font-size: 21px; color: var(--muted); }
      .fb-fix { flex: 1.1; font-size: 21px; color: #d1fae5; }

      /* team */
      .team-row { position: absolute; left: 120px; right: 120px; top: 270px; display: flex; gap: 26px; }
      .team-card { flex: 1; padding: 28px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .team-name { font-size: 30px; font-weight: 700; color: var(--ink); }
      .team-role { margin-top: 8px; font-size: 20px; color: var(--muted); }
      .team-score { margin-top: 18px; font-family: var(--font-mono); font-size: 56px; color: var(--cyan); }
      .res-row { position: absolute; left: 120px; right: 120px; top: 620px; display: flex; gap: 26px; }
      .res-card { flex: 1; padding: 24px; border: 1px solid rgba(34,211,238,0.16); border-radius: 16px; background: rgba(7,16,30,0.7); }
      .res-num { font-family: var(--font-mono); font-size: 44px; color: var(--cyan); }
      .res-label { margin-top: 6px; font-size: 20px; color: var(--muted); line-height: 1.45; }

      /* market */
      .price-row { position: absolute; left: 120px; right: 120px; top: 270px; display: flex; gap: 26px; }
      .price-card { flex: 1; min-height: 360px; padding: 30px; border: 1px solid rgba(34,211,238,0.2); border-radius: 18px; background: rgba(7,16,30,0.86); }
      .price-card.hot { border-color: rgba(52,211,153,0.55); background: rgba(6,30,26,0.72); }
      .price-name { font-size: 24px; color: var(--muted); }
      .price-big { margin-top: 14px; font-family: var(--font-mono); font-size: 72px; color: var(--ink); }
      .price-big .cyan { color: var(--cyan); }
      .price-big .green { color: var(--green); }
      .price-desc { margin-top: 20px; font-size: 21px; line-height: 1.7; color: #cbd5e1; }
      .price-tag { display: inline-block; margin-bottom: 10px; padding: 4px 12px; border-radius: 999px; font-family: var(--font-mono); font-size: 15px; letter-spacing: 1px; }
      .price-tag.done { background: rgba(52,211,153,0.12); color: var(--green); border: 1px solid rgba(52,211,153,0.3); }
      .price-tag.plan { background: rgba(245,158,11,0.1); color: var(--amber); border: 1px solid rgba(245,158,11,0.3); }
      .unit-row { position: absolute; left: 120px; right: 120px; top: 690px; display: flex; gap: 26px; }
      .unit-card { flex: 1; padding: 22px 24px; border: 1px solid rgba(34,211,238,0.16); border-radius: 14px; background: rgba(7,16,30,0.68); }
      .unit-card b { display: block; font-family: var(--font-mono); font-size: 30px; color: var(--cyan); }
      .unit-card span { display: block; margin-top: 6px; font-size: 19px; color: var(--muted); }

      /* revenue + channels */
      .rev-wrap { position: absolute; left: 120px; top: 280px; width: 820px; height: 560px; }
      .rev-title { font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; color: var(--muted); }
      .rev-bars { display: flex; align-items: flex-end; gap: 42px; height: 340px; margin-top: 26px; }
      .rev-col { width: 170px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
      .rev-bar { width: 100%; border-radius: 10px 10px 0 0; background: linear-gradient(180deg, #22d3ee, #0e7490); transform-origin: bottom; }
      .rev-bar.b2 { background: linear-gradient(180deg, #34d399, #0f766e); }
      .rev-bar.b3 { background: linear-gradient(180deg, #f59e0b, #b45309); }
      .rev-val { margin-bottom: 10px; font-family: var(--font-mono); font-size: 26px; color: var(--ink); }
      .rev-cap { margin-top: 12px; font-size: 20px; color: var(--muted); }
      .rev-badge { position: absolute; left: 0; top: -48px; padding: 8px 14px; border: 1px solid rgba(52,211,153,0.35); border-radius: 999px; font-family: var(--font-mono); font-size: 18px; color: var(--green); }
      .channel-wrap { position: absolute; right: 120px; top: 300px; width: 760px; }
      .channel-title { font-family: var(--font-mono); font-size: 18px; letter-spacing: 2px; color: var(--muted); }
      .channel-row { margin-top: 30px; }
      .channel-label { display: flex; justify-content: space-between; font-size: 22px; color: #cbd5e1; }
      .channel-label b { font-family: var(--font-mono); color: var(--cyan); font-weight: 400; }
      .channel-track { margin-top: 8px; height: 14px; border-radius: 999px; background: rgba(148,163,184,0.12); overflow: hidden; }
      .channel-bar { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #22d3ee, #34d399); width: 0; }

      /* 500 */
      .big-funnel { position: absolute; left: 140px; top: 280px; width: 900px; }
      .big-funnel .n { font-family: var(--font-mono); font-size: 190px; line-height: 1; color: var(--ink); }
      .big-funnel .n span { color: var(--cyan); }
      .big-funnel .arrow { font-size: 80px; color: var(--muted); margin: 0 20px; }
      .big-funnel .cap { margin-top: 18px; font-size: 26px; color: var(--muted); }
      .big-line { position: absolute; right: 120px; top: 380px; width: 760px; font-size: 52px; line-height: 1.4; font-weight: 700; color: var(--ink); }
      .big-line .cyan { color: var(--cyan); }
      .big-note { position: absolute; right: 120px; top: 620px; width: 760px; font-size: 22px; line-height: 1.6; color: var(--muted); }

      /* close */
      #scene-close { z-index: 12; }
      .end-card { position: absolute; inset: 0; background: linear-gradient(152deg, #f8fafc 0%, #eef6f8 55%, #fdf7ef 100%); color: #0f172a; }
      .end-card::before { content: ""; position: absolute; inset: 0; background-image: linear-gradient(rgba(14,116,144,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(14,116,144,0.06) 1px, transparent 1px); background-size: 80px 80px; mask-image: radial-gradient(circle at 50% 40%, black 20%, transparent 75%); }
      .end-kicker { position: absolute; left: 140px; top: 180px; font-family: var(--font-mono); font-size: 20px; letter-spacing: 4px; color: #0e7490; }
      .end-title { position: absolute; left: 140px; top: 250px; width: 1640px; font-size: 88px; line-height: 1.22; font-weight: 800; letter-spacing: -2px; color: #0f172a; }
      .end-title .teal { color: #0e7490; }
      .end-title .orange { color: #f97316; }
      .end-hand { position: absolute; left: 140px; top: 620px; font-size: 44px; font-weight: 700; color: #f97316; }
      .end-links { position: absolute; left: 140px; top: 750px; font-family: var(--font-mono); font-size: 22px; letter-spacing: 0.5px; color: #334155; }
      .end-tag { position: absolute; right: 140px; bottom: 130px; font-family: var(--font-mono); font-size: 18px; letter-spacing: 3px; color: #64748b; }
"""

def wave_tile(i):
    pts = []
    for x in range(0, 121, 6):
        y = 24 + 13 * math.sin((x / 120.0) * math.pi * (2 + (i % 4)) + (i % 7) * 0.9)
        pts.append(f"{x} {y:.1f}")
    color = ["#22d3ee", "#34d399", "#f59e0b"][i % 3]
    d = "M" + " L".join(pts)
    return f'<div class="wave-tile"><svg viewBox="0 0 120 48" xmlns="http://www.w3.org/2000/svg"><path d="{d}" fill="none" stroke="{color}" stroke-width="1.5" opacity="0.85"/></svg></div>'

WAVES = "\n".join(wave_tile(i) for i in range(51))

SUBS = [
    (1, 0.6, 4.2, "竞赛现场，反复试错很花时间。"),
    (2, 4.5, 7.6, "调一遍 3 天，参数越调越乱。"),
    (3, 8.1, 11.6, "TUNER：AI 驱动的竞赛调参加速器。"),
    (4, 12.4, 16.6, "“手动调参只能调个大概，经常被压力，变成背锅侠。”"),
    (5, 16.9, 20.9, "“不能把参数和效果联系起来，希望告诉我该怎么调。”"),
    (6, 21.1, 25.0, "“怕没用，更怕 AI 乱调把机械弄坏。”"),
    (7, 26.0, 29.9, "7 问卷、12 深访、25 扩测；100% 说试错最耗时。"),
    (8, 30.1, 33.2, "42.9% 调参 ≥3 天；57.1% 离线刚需。"),
    (9, 33.2, 38.7, "现有工具多看波形；TUNER 直接调参。"),
    (10, 39.5, 43.6, "全国 7,500 支队伍，华科 500 支；首批 50 支种子。"),
    (11, 44.0, 47.4, "把数天的试错，压成小时级。"),
    (12, 48.5, 52.4, "一个工作台：波形、分析、数据、调参。"),
    (13, 52.7, 57.4, "实时波形、确定性分析、数据回放，全部本地算。"),
    (14, 58.4, 62.4, "一句目标，Agent 自主完成五步闭环。"),
    (15, 62.7, 66.9, "查数据 → 改参数 → 设目标 → 看响应 → 再决策。"),
    (16, 67.2, 69.9, "达标收敛，前 5 轮防早收。"),
    (17, 70.5, 74.4, "三重护栏：用户范围、Kp≤20、单步增幅拦截。"),
    (18, 74.7, 78.7, "超调或振荡越限，自动回退到最佳稳定参数。"),
    (19, 79.0, 81.8, "50KB 压缩，只压数据块。"),
    (20, 82.5, 86.8, "仿真案例：超调 102% 被安全网拦截，再决策后 0.24% 达标。"),
    (21, 91.5, 95.3, "四个版本，四次可运行的交付。"),
    (22, 95.6, 99.4, "8/25，v1.1.0 安装包发布。"),
    (23, 100.5, 104.4, "7→12→25，三阶段样本；5 条反馈全部闭环。"),
    (24, 104.7, 108.7, "诊断有效率 40%→85%，按期交付率 70%→90%。"),
    (25, 112.5, 116.4, "51 波形 · 12 自测 · 18 测试 · v1.1.0。"),
    (26, 120.5, 124.4, "中期评审提出两条批评；我们据此重构了架构与交付方式。"),
    (27, 124.7, 128.4, "熔断真实触发过：硬件超期切降级，上下文失真上压缩。"),
    (28, 128.7, 131.8, "安全不能靠提示词，必须由代码机制化。"),
    (29, 132.5, 136.4, "5 条反馈，5 个版本动作，全部落进 v1.1.0。"),
    (30, 139.5, 143.4, "¥350、182 小时，三个人，换回一整套可验证资产。"),
    (31, 143.7, 147.4, "每 ¥100 换回 3.4 份有效反馈。"),
    (32, 148.5, 152.4, "免费开源，¥10/月高级版，按次 API。"),
    (33, 152.7, 156.4, "客单 ¥120/年，API ≈¥0.06/次；3 位订阅收回现金投入。"),
    (34, 158.5, 162.4, "66.7% 意向；5–25% 转化 → 0.6–3.0 万。"),
    (35, 163.0, 166.4, "渠道来自问卷：B 站、GitHub、竞赛社群。"),
    (36, 168.5, 172.4, "先让华科 500 支队伍用起来，再谈收入。"),
]

SUBS_HTML = "\n".join(
    f'<div class="sub" id="sub-{i}"><span>{text}</span></div>' for i, a, b, text in SUBS
)

def srt_time(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

SRT = "\n".join(
    f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n" for n, (i, a, b, text) in enumerate(SUBS, 1)
)

BODY = f"""
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="180"
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
            <span>TUNER / AI SERIAL ASSISTANT</span>
          </div>
          <div class="hud-right">
            <span>PROJECT FILM / 3:00</span>
          </div>
        </div>

        <div id="progress-track"><div id="progress-fill"></div></div>

        <!-- 00 hook -->
        <div id="scene-hook" class="scene">
          <div id="hook-title">
            <div class="scene-label">TUNER / PROJECT FILM 3:00</div>
            <div class="hook-big">调一遍，<span class="cyan">三天</span>。</div>
          </div>
          <div id="hook-pains">
            <div class="pain"><b>×</b>调一遍 3 天</div>
            <div class="pain"><b>×</b>参数越调越乱</div>
            <div class="pain"><b>×</b>怕弄坏设备</div>
          </div>
          <div id="hook-brand">
            <div class="hook-logo">TUNER<span>.</span></div>
            <div class="hook-sub">AI 驱动的竞赛调参加速器</div>
          </div>
          <div id="hook-wave">
            <div id="hook-wave-reveal" data-layout-allow-overflow>
              <svg viewBox="0 0 1920 260" xmlns="http://www.w3.org/2000/svg" data-layout-allow-overflow>
                <path d="M0 150 C240 60, 420 240, 660 150 C900 60, 1080 240, 1320 150 C1560 60, 1740 240, 1920 150" fill="none" stroke="rgba(34,211,238,0.55)" stroke-width="2"/>
                <path d="M0 180 C260 100, 460 260, 700 180 C940 100, 1120 260, 1360 180 C1600 100, 1760 260, 1920 180" fill="none" stroke="rgba(52,211,153,0.28)" stroke-width="1.5"/>
              </svg>
            </div>
          </div>
        </div>

        <!-- 01 problem -->
        <div id="scene-problem" class="scene">
          <div class="beat" id="pq">
            <div class="chapter"><div class="scene-label">01 / 看见问题</div><div class="beat-title">调参，很花时间。</div></div>
            <div class="quote-row">
              <div class="quote-card"><div class="qmark">“</div><div class="qtext">算法组给了一个严苛的响应要求，手动调参只能调个大概，经常被压力，变成背锅侠。</div><div class="qauthor">电控队员 · 问卷原话</div></div>
              <div class="quote-card"><div class="qmark">“</div><div class="qtext">不能把参数和对应效果联系起来，希望有个平台告诉我，现象对应什么参数问题、该怎么调。</div><div class="qauthor">电控队员 · 问卷原话</div></div>
              <div class="quote-card"><div class="qmark">“</div><div class="qtext">怕没用，更怕 AI 乱调把机械弄坏。</div><div class="qauthor">智能车队员 · 访谈原话</div></div>
            </div>
          </div>

          <div class="beat" id="pstats">
            <div class="chapter"><div class="scene-label">01 / 看见问题</div><div class="beat-title">三阶段样本，痛点很集中。</div></div>
            <div class="stat-row">
              <div class="stat-card"><div class="stat-num">100%</div><div class="stat-label">认为反复试错最耗时<br><span class="mini">7/7 全票</span></div></div>
              <div class="stat-card"><div class="stat-num amber">42.9%</div><div class="stat-label">单次调参 ≥3 天</div></div>
              <div class="stat-card"><div class="stat-num">85.7%</div><div class="stat-label">愿意赛前试用</div></div>
              <div class="stat-card"><div class="stat-num">57.1%</div><div class="stat-label">认为赛场离线是刚需</div></div>
            </div>
            <div class="stat-foot">7 份问卷 · 12 份深访 · 25 份扩测</div>
          </div>

          <div class="beat" id="pmatrix">
            <div class="chapter"><div class="scene-label">01 / 看见问题</div><div class="beat-title">现有工具多看波形，TUNER 直接调参数。</div></div>
            <div class="matrix-wrap">
              <div class="m-line-h"></div><div class="m-line-v"></div>
              <div class="m-axis-y">越为嵌入式调参而生 →</div>
              <div class="m-axis-x">越会自动调参 →</div>
              <div class="m-dot" style="left:190px;top:390px;"></div><div class="m-label" style="left:110px;top:420px;">VOFA+ / 串口上位机</div><div class="m-sub" style="left:110px;top:452px;">只看波形 · 人工盲调</div>
              <div class="m-dot" style="left:130px;top:500px;"></div><div class="m-label" style="left:60px;top:530px;">普通串口助手</div>
              <div class="m-dot" style="left:470px;top:500px;"></div><div class="m-label" style="left:400px;top:530px;">通用大模型聊天</div><div class="m-sub" style="left:400px;top:562px;">只会聊 · 不会执行</div>
              <div class="m-dot" style="left:560px;top:250px;"></div><div class="m-label" style="left:500px;top:280px;">MATLAB / Simulink</div>
              <div class="m-star">★<div class="m-star-label">TUNER</div></div>
            </div>
            <div class="matrix-copy">右上象限：AI 会动手，也为调参而生。<div class="small">矩阵基于功能定位，不代表市场份额。</div></div>
          </div>

          <div class="beat" id="pfunnel">
            <div class="chapter"><div class="scene-label">01 / 看见问题</div><div class="beat-title">全国 7,500 支，先服务华科 500 支。</div></div>
            <div class="funnel">
              <div class="f-layer" style="width:780px;background:#0e7490;">TAM　7,500 支/年<span>全国电赛 / 智能车 / RM / RC</span></div>
              <div class="f-layer" style="width:600px;background:#0891b2;">SAM　5,000 支/年<span>电控调参刚需</span></div>
              <div class="f-layer" style="width:420px;background:#f97316;">SOM　500 支<span>华科在校盘</span></div>
              <div class="f-layer" style="width:250px;background:#fb923c;">首批　50 支<span>开源种子队伍</span></div>
            </div>
            <div class="value-line">把数天的试错，<br>压缩到<span class="cyan">小时级</span>。</div>
            <div class="value-note">数据口径：高校竞赛队伍数推算，华科 500+ 队为评委口径。</div>
          </div>
        </div>

        <!-- 02 product -->
        <div id="scene-product" class="scene">
          <div class="beat" id="ppanorama">
            <div class="chapter"><div class="scene-label">02 / 做出东西</div><div class="beat-title">一个工作台：波形、分析、数据、调参。</div></div>
            <div class="ui-frame"><img src="./assets/ui-dark.png" alt="TUNER workspace" /></div>
            <div class="callout-list">
              <div class="callout-row"><span class="dot"></span><div><div class="c-title">实时波形</div><div class="c-desc">多通道缩放 · CSV / JSON 导出</div></div></div>
              <div class="callout-row"><span class="dot"></span><div><div class="c-title">确定性分析</div><div class="c-desc">上升 / 稳定时间 · 超调 · 稳态误差 · RMSE</div></div></div>
              <div class="callout-row"><span class="dot"></span><div><div class="c-title">数据表 · 回放</div><div class="c-desc">I0–I7 结构化 · 一键重放</div></div></div>
              <div class="callout-row"><span class="dot"></span><div><div class="c-title">PID 调参 Agent</div><div class="c-desc">对话式自主闭环</div></div></div>
            </div>
          </div>

          <div class="beat" id="pdemo">
            <div class="chapter"><div class="scene-label">02 / 做出东西</div><div class="beat-title">一句目标，Agent 自主闭环。</div></div>
            <div class="demo-frame">
              <video id="agent-video" data-start="58" data-duration="11.5" data-media-start="0" src="./assets/agent/agent-session-v2.mp4" muted playsinline></video>
            </div>
            <div class="demo-badge">仿真演示 · 倒立摆</div>
            <div class="step-row">
              <div class="step" id="step-1"><b>01</b>查数据</div>
              <div class="step" id="step-2"><b>02</b>改参数</div>
              <div class="step" id="step-3"><b>03</b>设目标</div>
              <div class="step" id="step-4"><b>04</b>看响应</div>
              <div class="step" id="step-5"><b>05</b>再决策</div>
            </div>
          </div>

          <div class="beat" id="pguard">
            <div class="chapter"><div class="scene-label">02 / 做出东西</div><div class="beat-title">三重护栏，越界自动回退。</div></div>
            <div class="guard-row">
              <div class="guard-card"><div class="guard-num">01</div><div class="guard-title">用户范围</div><div class="guard-desc">参数下限与上限由用户设定，Agent 只在区间内动作。</div></div>
              <div class="guard-card"><div class="guard-num">02</div><div class="guard-title">系统上限 Kp≤20</div><div class="guard-desc">系统级硬上限；单步增幅拦截，避免一次调过头。</div></div>
              <div class="guard-card"><div class="guard-num">03</div><div class="guard-title">越界自动回退</div><div class="guard-desc">超调或振荡越限，回到最佳稳定参数，并醒目提示。</div></div>
            </div>
            <div class="guard-extra">
              <div class="guard-card"><div class="guard-title">50KB 上下文压缩</div><div class="guard-desc">长会话只压数据块，保留对话尾部；上下文不失真。</div></div>
              <div class="guard-card"><div class="guard-title">随时插话纠偏</div><div class="guard-desc">运行中 steer，结束后追问 followUp；调整方向由人确认。</div></div>
            </div>
          </div>

          <div class="beat" id="pcase">
            <div class="chapter"><div class="scene-label">02 / 做出东西</div><div class="beat-title">倒立摆：102% → 0.24%。</div></div>
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
          </div>

          <div class="beat" id="pevo">
            <div class="chapter"><div class="scene-label">02 / 做出东西</div><div class="beat-title">四个版本，四次可运行的交付。</div></div>
            <div class="evo-row">
              <div class="evo-card"><div class="evo-date">7/19</div><div class="evo-title">原型</div><div class="evo-desc">Raw 波形工具</div></div>
              <div class="evo-arrow">→</div>
              <div class="evo-card"><div class="evo-date">7/26</div><div class="evo-title">确定性分析</div><div class="evo-desc">本地指标 + 护栏雏形</div></div>
              <div class="evo-arrow">→</div>
              <div class="evo-card"><div class="evo-date">8/24</div><div class="evo-title">重构解耦</div><div class="evo-desc">界面大改版 · 模块拆分</div></div>
              <div class="evo-arrow">→</div>
              <div class="evo-card"><div class="evo-date">8/25</div><div class="evo-title">v1.1.0</div><div class="evo-desc">Agent 上线 · 安装包发布</div></div>
            </div>
            <div class="evo-foot">8,422 行代码 · 28 个源文件 · 31 次 Git 提交 · NSIS 安装包</div>
          </div>
        </div>

        <!-- 03 proof -->
        <div id="scene-proof" class="scene">
          <div class="beat" id="pdash">
            <div class="chapter"><div class="scene-label">03 / 证明价值</div><div class="beat-title">三阶段 · 三类对比。</div></div>
            <div class="dash-grid">
              <div class="dash-card"><div class="dash-num">7→12→25</div><div class="dash-label">问卷 → 深访 → 扩测</div><div class="dash-sub">+5 条体验反馈闭环</div></div>
              <div class="dash-card"><div class="dash-num green">40%→85%</div><div class="dash-label">诊断有效率</div><div class="dash-sub">护栏 + 压缩上线后</div></div>
              <div class="dash-card"><div class="dash-num green">70%→90%</div><div class="dash-label">任务按期交付率</div><div class="dash-sub">看板 + 每日立会</div></div>
              <div class="dash-card"><div class="dash-num">5→v1.1.0</div><div class="dash-label">原型 → 安装包</div><div class="dash-sub">辅助建议 → Agent 闭环</div></div>
            </div>
            <div class="milestone-row">
              <div class="ms"><b>M1</b> 底座 ✓</div>
              <div class="ms"><b>M2</b> 分析 ✓</div>
              <div class="ms"><b>M3</b> 调参 ✓</div>
              <div class="ms"><b>M4</b> 发布 ✓</div>
              <div class="ms warn"><b>硬件</b> 写回在途</div>
            </div>
          </div>

          <div class="beat" id="pdeliver">
            <div class="chapter"><div class="scene-label">03 / 证明价值</div><div class="beat-title">交付物全部可复现。</div></div>
            <div class="wave-wall" data-layout-allow-overflow>{WAVES}</div>
            <div class="deliver-stats">
              <div class="deliver-row"><span class="k">验证波形</span><span class="v">51 张</span></div>
              <div class="deliver-row"><span class="k">算法自测</span><span class="v">12 / 12</span></div>
              <div class="deliver-row"><span class="k">测试文件</span><span class="v">18 个</span></div>
              <div class="deliver-row"><span class="k">技术文档</span><span class="v">6 篇</span></div>
              <div class="deliver-row"><span class="k">Git 提交</span><span class="v">31 次</span></div>
              <div class="deliver-row"><span class="k">安装包</span><span class="v">v1.1.0</span></div>
              <div class="deliver-note">波形含 CSV 原始数据；自测命令可现场复跑；安装包双击即用。</div>
            </div>
          </div>

          <div class="beat" id="pstories">
            <div class="chapter"><div class="scene-label">03 / 证明价值</div><div class="beat-title">三件事，三个结果。</div></div>
            <div class="story-row">
              <div class="story-card"><div class="story-tag">01 / 主动性</div><div class="story-title">从中期评审的<br>两条批评出发</div><div class="story-body">8/7 起三天调研 AI Harness，决策重构为对话式智能体；主动 MIT 开源，换社区测评与传播渠道。</div><div class="story-metric">8/25 Agent 上线</div></div>
              <div class="story-card"><div class="story-tag">02 / 不确定性</div><div class="story-title">熔断真实<br>触发过</div><div class="story-body">硬件联调超期，当天切「仿真验收 + 指令集就绪」降级路径；上下文失真，50KB 压缩熔断上线。</div><div class="story-metric">诊断 40% → 85%</div></div>
              <div class="story-card"><div class="story-tag">03 / 体验式学习</div><div class="story-title">两次失败，<br>两条新指标</div><div class="story-body">仿真震荡做 5Why 归因，把「安全不能靠提示词」写进护栏与回退；Electron 三连坑收进启动脚本。</div><div class="story-metric">回退 0 误伤</div></div>
            </div>
          </div>

          <div class="beat" id="pfeedback">
            <div class="chapter"><div class="scene-label">03 / 证明价值</div><div class="beat-title">5 条反馈，5 个版本动作。</div></div>
            <div class="feedback-list">
              <div class="feedback-row"><div class="fb-date">8/8</div><div class="fb-topic">AI 回答</div><div class="fb-problem">结论被无关内容淹没</div><div class="fb-fix">→ 重做提示词与输出格式</div></div>
              <div class="feedback-row"><div class="fb-date">8/23</div><div class="fb-topic">界面布局</div><div class="fb-problem">元素多、上手要摸索</div><div class="fb-fix">→ 整体改版：波形常驻、功能分区</div></div>
              <div class="feedback-row"><div class="fb-date">8/24</div><div class="fb-topic">调参稳定</div><div class="fb-problem">偶发异常，不敢依赖</div><div class="fb-fix">→ 调参拆为独立模块，行为稳定可排查</div></div>
              <div class="feedback-row"><div class="fb-date">8/25</div><div class="fb-topic">自动调参</div><div class="fb-problem">AI 只给建议，试参仍靠手</div><div class="fb-fix">→ 对话式 Agent + 护栏回退</div></div>
              <div class="feedback-row"><div class="fb-date">8/25</div><div class="fb-topic">安装交付</div><div class="fb-problem">开发版门槛高、文档散</div><div class="fb-fix">→ v1.1.0 安装包 + 三份文档</div></div>
            </div>
          </div>

          <div class="beat" id="pteam">
            <div class="chapter"><div class="scene-label">03 / 证明价值</div><div class="beat-title">三个人，182 小时。</div></div>
            <div class="team-row">
              <div class="team-card"><div class="team-name">刘双瑞</div><div class="team-role">算法 · 智能体</div><div class="team-score">100</div></div>
              <div class="team-card"><div class="team-name">胡雨杨</div><div class="team-role">前端 · 联调</div><div class="team-score">100</div></div>
              <div class="team-card"><div class="team-name">吴程龙秀</div><div class="team-role">文档 · 发布</div><div class="team-score">100</div></div>
            </div>
            <div class="res-row">
              <div class="res-card"><div class="res-num">¥350</div><div class="res-label">现金投入<br>API 120 · 云 80 · 激励 150</div></div>
              <div class="res-card"><div class="res-num">182h</div><div class="res-label">团队工时<br>开发 152 + 验证 30</div></div>
              <div class="res-card"><div class="res-num">3.4 份</div><div class="res-label">每 ¥100 换回有效反馈<br>¥29.2 / 份深访</div></div>
            </div>
          </div>
        </div>

        <!-- 04 market -->
        <div id="scene-market" class="scene">
          <div class="beat" id="mprice">
            <div class="chapter"><div class="scene-label">04 / 走向市场</div><div class="beat-title">开源获客，分层变现。</div></div>
            <div class="price-row">
              <div class="price-card"><span class="price-tag done">已发布</span><div class="price-name">免费版</div><div class="price-big">¥0</div><div class="price-desc">MIT 开源 · 完整基础功能<br>波形 / 分析 / 调参底座<br>社区支持</div></div>
              <div class="price-card hot"><span class="price-tag plan">规划中</span><div class="price-name">高级版</div><div class="price-big"><span class="green">¥10</span> / 月</div><div class="price-desc">云端报告 · 团队协作<br>高级策略模板<br>优先支持</div></div>
              <div class="price-card"><span class="price-tag plan">规划中</span><div class="price-name">按次 API</div><div class="price-big">按需</div><div class="price-desc">赛事 / 教育 / 企业集成<br>私有化部署</div></div>
            </div>
            <div class="unit-row">
              <div class="unit-card"><b>¥120 / 年</b><span>客单价（¥10/月）</span></div>
              <div class="unit-card"><b>≈¥0.06 / 次</b><span>API 边际成本</span></div>
              <div class="unit-card"><b>3 位订阅</b><span>收回全部现金投入</span></div>
            </div>
          </div>

          <div class="beat" id="mrev">
            <div class="chapter"><div class="scene-label">04 / 走向市场</div><div class="beat-title">66.7% 意向，三档测算。</div></div>
            <div class="rev-wrap">
              <div class="rev-badge">付费意向 66.7%</div>
              <div class="rev-title">年收入测算 · 5% / 15% / 25% 转化</div>
              <div class="rev-bars">
                <div class="rev-col"><div class="rev-val">¥0.6 万</div><div class="rev-bar" style="height:100px;"></div><div class="rev-cap">5% 保守</div></div>
                <div class="rev-col"><div class="rev-val">¥1.8 万</div><div class="rev-bar b2" style="height:210px;"></div><div class="rev-cap">15% 基准</div></div>
                <div class="rev-col"><div class="rev-val">¥3.0 万</div><div class="rev-bar b3" style="height:320px;"></div><div class="rev-cap">25% 乐观</div></div>
              </div>
            </div>
            <div class="channel-wrap">
              <div class="channel-title">获客渠道偏好 · 问卷 D6</div>
              <div class="channel-row"><div class="channel-label"><span>B 站教程</span><b>57.1%</b></div><div class="channel-track"><div class="channel-bar" style="width:57.1%;"></div></div></div>
              <div class="channel-row"><div class="channel-label"><span>GitHub 开源</span><b>57.1%</b></div><div class="channel-track"><div class="channel-bar" style="width:57.1%;"></div></div></div>
              <div class="channel-row"><div class="channel-label"><span>竞赛 QQ / 微信群</span><b>42.9%</b></div><div class="channel-track"><div class="channel-bar" style="width:42.9%;"></div></div></div>
              <div class="channel-row"><div class="channel-label"><span>老师 / 同学推荐</span><b>42.9%</b></div><div class="channel-track"><div class="channel-bar" style="width:42.9%;"></div></div></div>
            </div>
          </div>

          <div class="beat" id="m500">
            <div class="chapter"><div class="scene-label">04 / 走向市场</div><div class="beat-title">先服务 500 支队伍。</div></div>
            <div class="big-funnel">
              <div class="n">500<span> → </span>50</div>
              <div class="cap">华科在校盘 → 首批开源种子队伍</div>
            </div>
            <div class="big-line">先让华科 500 支队伍<br><span class="cyan">用起来</span>，再谈收入。</div>
            <div class="big-note">首年目标：覆盖华科 500 支 · 50 支种子 · 开源社区 100+ Star。渠道来自问卷 D6。</div>
          </div>
        </div>

        <!-- 05 close -->
        <div id="scene-close" class="scene">
          <div class="end-card">
            <div class="end-kicker">TUNER · 咕电子队 · 2026.11</div>
            <div class="end-title">把「调参靠经验」，<br>变成「调参靠<span class="teal">数据</span> + <span class="orange">AI</span>」。</div>
            <div class="end-hand">接下来 90 秒，讲它怎么被验证。</div>
            <div class="end-links">GitHub　HonestLeon/ai-serial-assistant　·　Gitee　Honest_Leon/ai-serial-assistant　（MIT · 欢迎试用）</div>
            <div class="end-tag">3:00 → 1:30</div>
          </div>
        </div>

        <div id="dip"></div>
        <div id="caption">
          {SUBS_HTML}
        </div>
      </div>
      <audio id="bgm" data-start="0" data-duration="180" data-volume="1" data-fade-in="1.5" data-fade-out="3" src="./assets/music/defense-180.mp3"></audio>
    </div>
"""

# ---------------- timeline ----------------
L = []
def add(s): L.append(s)

add("const tl = gsap.timeline({ paused: true });")
add('gsap.set(".scene", { opacity: 0 });')
add('gsap.set("#scene-hook", { opacity: 1 });')
add('gsap.set(".beat", { opacity: 0 });')
add('gsap.set("#hook-brand", { opacity: 0, y: 14 });')
add('gsap.set("#hook-pains .pain", { opacity: 0, x: 20 });')
add('gsap.set("#hook-wave-reveal", { width: 0 });')
add('gsap.set("#case-curve-reveal", { width: 0 });')
add('gsap.set(".sub", { opacity: 0, y: 12 });')
add('gsap.set("#dip", { opacity: 0 });')
add('gsap.set("#hud", { opacity: 0 });')
add('gsap.set("#progress-fill", { width: 0 });')

# global
add('tl.to("#hud", { opacity: 1, duration: 0.6 }, 0.2);')
add('tl.to("#progress-fill", { width: 1920, duration: 180, ease: "none" }, 0);')
add('tl.to("#grid", { x: -80, y: -50, duration: 180, ease: "none" }, 0);')
add('tl.to("#flare", { opacity: 0.34, duration: 28, ease: "sine.inOut" }, 2);')
add('tl.to("#flare", { opacity: 0.22, duration: 40, ease: "sine.inOut" }, 60);')
add('tl.to("#flare", { opacity: 0.36, duration: 30, ease: "sine.inOut" }, 120);')

# hook
add('tl.to("#scene-hook", { opacity: 1, duration: 0.7 }, 0.05);')
add('tl.to("#hook-wave-reveal", { width: 1920, duration: 2.2, ease: "power2.inOut" }, 0.3);')
add('tl.from("#hook-title .hook-big", { y: 26, duration: 0.7 }, 0.3);')
add('tl.to("#hook-pains .pain", { opacity: 1, x: 0, duration: 0.4, stagger: 0.3 }, 4.6);')
add('tl.to("#hook-title", { opacity: 0, duration: 0.4 }, 8.0);')
add('tl.to("#hook-pains", { opacity: 0, duration: 0.4 }, 8.0);')
add('tl.to("#hook-brand", { opacity: 1, y: 0, duration: 0.6 }, 8.4);')
add('tl.to("#scene-hook", { opacity: 0, duration: 0.3 }, 11.65);')
add('tl.to("#dip", { opacity: 0.92, duration: 0.1 }, 11.75);')
add('tl.to("#dip", { opacity: 0, duration: 0.32 }, 11.87);')

# problem
add('tl.to("#scene-problem", { opacity: 1, duration: 0.45 }, 11.95);')
add('tl.to("#pq", { opacity: 1, duration: 0.35 }, 12.05);')
add('tl.from("#pq .quote-card", { opacity: 0, y: 28, duration: 0.5, stagger: 0.16 }, 12.2);')
add('tl.to("#pq", { opacity: 0, duration: 0.3 }, 21.7);')
add('tl.to("#pstats", { opacity: 1, duration: 0.35 }, 21.95);')
add('tl.from("#pstats .stat-card", { opacity: 0, y: 24, duration: 0.4, stagger: 0.12 }, 22.1);')
add('tl.to("#pstats", { opacity: 0, duration: 0.3 }, 29.75);')
add('tl.to("#pmatrix", { opacity: 1, duration: 0.35 }, 29.95);')
add('tl.from("#pmatrix .m-dot", { opacity: 0, scale: 0.5, duration: 0.4, stagger: 0.14 }, 30.15);')
add('tl.from("#pmatrix .m-star", { opacity: 0, scale: 0.3, duration: 0.5 }, 30.9);')
add('tl.to("#pmatrix", { opacity: 0, duration: 0.3 }, 38.75);')
add('tl.to("#pfunnel", { opacity: 1, duration: 0.35 }, 38.95);')
add('tl.from("#pfunnel .f-layer", { opacity: 0, y: -18, duration: 0.4, stagger: 0.15 }, 39.1);')
add('tl.from("#pfunnel .value-line", { opacity: 0, y: 20, duration: 0.5 }, 39.8);')
add('tl.to("#scene-problem", { opacity: 0, duration: 0.3 }, 47.55);')
add('tl.to("#dip", { opacity: 0.92, duration: 0.1 }, 47.65);')
add('tl.to("#dip", { opacity: 0, duration: 0.32 }, 47.77);')

# product
add('tl.to("#scene-product", { opacity: 1, duration: 0.45 }, 47.85);')
add('tl.to("#ppanorama", { opacity: 1, duration: 0.35 }, 47.95);')
add('tl.from("#ppanorama .ui-frame", { opacity: 0, x: -26, duration: 0.65 }, 48.1);')
add('tl.from("#ppanorama .callout-row", { opacity: 0, x: 20, duration: 0.4, stagger: 0.12 }, 48.5);')
add('tl.to("#ppanorama", { opacity: 0, duration: 0.3 }, 57.75);')
add('tl.to("#pdemo", { opacity: 1, duration: 0.35 }, 57.95);')
add('tl.from("#pdemo .demo-frame", { opacity: 0, scale: 0.97, duration: 0.5 }, 58.0);')
add('tl.to("#step-1", { backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2 }, 58.6);')
add('tl.to("#step-2", { backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2 }, 60.6);')
add('tl.to("#step-3", { backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2 }, 62.6);')
add('tl.to("#step-4", { backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2 }, 64.6);')
add('tl.to("#step-5", { backgroundColor: "rgba(6,40,32,0.6)", borderColor: "rgba(52,211,153,0.55)", color: "#d1fae5", duration: 0.2 }, 66.6);')
add('tl.to("#pdemo", { opacity: 0, duration: 0.3 }, 69.7);')
add('tl.to("#pguard", { opacity: 1, duration: 0.35 }, 69.95);')
add('tl.from("#pguard .guard-row .guard-card", { opacity: 0, y: 26, duration: 0.45, stagger: 0.14 }, 70.1);')
add('tl.from("#pguard .guard-extra .guard-card", { opacity: 0, y: 20, duration: 0.4, stagger: 0.12 }, 74.2);')
add('tl.to("#pguard", { opacity: 0, duration: 0.3 }, 81.75);')
add('tl.to("#pcase", { opacity: 1, duration: 0.35 }, 81.95);')
add('tl.from("#pcase .case-copy", { opacity: 0, x: -24, duration: 0.5 }, 82.1);')
add('tl.to("#case-curve-reveal", { width: 980, duration: 1.1, ease: "power2.inOut" }, 82.4);')
add('tl.to("#pcase", { opacity: 0, duration: 0.3 }, 90.85);')
add('tl.to("#pevo", { opacity: 1, duration: 0.35 }, 91.05);')
add('tl.from("#pevo .evo-card", { opacity: 0, y: 24, duration: 0.45, stagger: 0.12 }, 91.2);')
add('tl.from("#pevo .evo-arrow", { opacity: 0, duration: 0.3, stagger: 0.1 }, 91.5);')
add('tl.to("#scene-product", { opacity: 0, duration: 0.3 }, 99.55);')
add('tl.to("#dip", { opacity: 0.92, duration: 0.1 }, 99.65);')
add('tl.to("#dip", { opacity: 0, duration: 0.32 }, 99.77);')

# proof
add('tl.to("#scene-proof", { opacity: 1, duration: 0.45 }, 99.85);')
add('tl.to("#pdash", { opacity: 1, duration: 0.35 }, 99.95);')
add('tl.from("#pdash .dash-card", { opacity: 0, y: 22, duration: 0.45, stagger: 0.12 }, 100.1);')
add('tl.from("#pdash .ms", { opacity: 0, y: 16, duration: 0.35, stagger: 0.1 }, 103.4);')
add('tl.to("#pdash", { opacity: 0, duration: 0.3 }, 111.75);')
add('tl.to("#pdeliver", { opacity: 1, duration: 0.35 }, 111.95);')
add('tl.from("#pdeliver .wave-tile", { opacity: 0, scale: 0.85, duration: 0.25, stagger: 0.008 }, 112.15);')
add('tl.from("#pdeliver .deliver-row", { opacity: 0, x: 20, duration: 0.35, stagger: 0.08 }, 112.3);')
add('tl.to("#pdeliver", { opacity: 0, duration: 0.3 }, 119.75);')
add('tl.to("#pstories", { opacity: 1, duration: 0.35 }, 119.95);')
add('tl.from("#pstories .story-card", { opacity: 0, y: 24, duration: 0.45, stagger: 0.15 }, 120.1);')
add('tl.to("#pstories", { opacity: 0, duration: 0.3 }, 131.75);')
add('tl.to("#pfeedback", { opacity: 1, duration: 0.35 }, 131.95);')
add('tl.from("#pfeedback .feedback-row", { opacity: 0, x: 18, duration: 0.35, stagger: 0.11 }, 132.1);')
add('tl.to("#pfeedback", { opacity: 0, duration: 0.3 }, 138.75);')
add('tl.to("#pteam", { opacity: 1, duration: 0.35 }, 138.95);')
add('tl.from("#pteam .team-card", { opacity: 0, y: 22, duration: 0.4, stagger: 0.12 }, 139.1);')
add('tl.from("#pteam .res-card", { opacity: 0, y: 16, duration: 0.4, stagger: 0.12 }, 139.6);')
add('tl.to("#scene-proof", { opacity: 0, duration: 0.3 }, 147.55);')
add('tl.to("#dip", { opacity: 0.92, duration: 0.1 }, 147.65);')
add('tl.to("#dip", { opacity: 0, duration: 0.32 }, 147.77);')

# market
add('tl.to("#scene-market", { opacity: 1, duration: 0.45 }, 147.85);')
add('tl.to("#mprice", { opacity: 1, duration: 0.35 }, 147.95);')
add('tl.from("#mprice .price-card", { opacity: 0, y: 26, duration: 0.45, stagger: 0.14 }, 148.1);')
add('tl.from("#mprice .unit-card", { opacity: 0, y: 16, duration: 0.35, stagger: 0.1 }, 152.2);')
add('tl.to("#mprice", { opacity: 0, duration: 0.3 }, 157.75);')
add('tl.to("#mrev", { opacity: 1, duration: 0.35 }, 157.95);')
add('tl.from("#mrev .rev-bar", { scaleY: 0, transformOrigin: "bottom", duration: 0.6, stagger: 0.15 }, 158.2);')
add('tl.from("#mrev .channel-row", { opacity: 0, x: 18, duration: 0.35, stagger: 0.12 }, 159.6);')
add('tl.to("#mrev", { opacity: 0, duration: 0.3 }, 167.75);')
add('tl.to("#m500", { opacity: 1, duration: 0.35 }, 167.95);')
add('tl.from("#m500 .big-funnel .n", { opacity: 0, y: 24, duration: 0.5 }, 168.1);')
add('tl.from("#m500 .big-line", { opacity: 0, y: 20, duration: 0.5 }, 169.2);')
add('tl.to("#scene-market", { opacity: 0, duration: 0.3 }, 173.55);')
add('tl.to("#dip", { opacity: 0.92, duration: 0.1 }, 173.65);')
add('tl.to("#dip", { opacity: 0, duration: 0.35 }, 173.77);')

# close
add('tl.to("#hud", { opacity: 0, duration: 0.3 }, 173.5);')
add('tl.to("#scene-close", { opacity: 1, duration: 0.5 }, 173.85);')
add('tl.from("#scene-close .end-title", { opacity: 0, y: 26, duration: 0.6 }, 174.0);')
add('tl.from("#scene-close .end-hand", { opacity: 0, y: 16, duration: 0.5 }, 177.0);')
add('tl.from("#scene-close .end-links", { opacity: 0, duration: 0.5 }, 177.5);')
add('tl.from("#scene-close .end-tag", { opacity: 0, duration: 0.5 }, 178.0);')

# subtitles
for i, a, b, text in SUBS:
    add(f'tl.to("#sub-{i}", {{ opacity: 1, y: 0, duration: 0.3 }}, {a:.2f});')
    add(f'tl.to("#sub-{i}", {{ opacity: 0, y: -8, duration: 0.25 }}, {b:.2f});')

add('window.__timelines = window.__timelines || {};')
add('window.__timelines["main"] = tl;')

SCRIPT = "\n      ".join(L)

HTML = f"""<!doctype html>
<html lang="zh-CN" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>TUNER · Project Film 3:00</title>
    <script src="./assets/gsap.min.js"></script>
    <style>
{GLOBAL_CSS}
{EXTRA_CSS}
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

io.open(os.path.join(BASE, "index.html"), "w", encoding="utf-8").write(HTML)
io.open(os.path.join(BASE, "renders", "film-180s-v1.srt"), "w", encoding="utf-8").write(SRT)
print("wrote index.html", len(HTML), "bytes; srt", len(SRT), "bytes")
