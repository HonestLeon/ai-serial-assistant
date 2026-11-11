# -*- coding: utf-8 -*-
import io, json, os, re

BASE = os.path.dirname(os.path.abspath(__file__))
T = json.load(io.open(os.path.join(BASE, "audio-timing.json"), encoding="utf-8"))
html = io.open(os.path.join(BASE, "index.html"), encoding="utf-8").read()
srt = io.open(os.path.join(BASE, "renders", "film-v2.srt"), encoding="utf-8").read()

issues = []
def chk(cond, msg):
    if not cond:
        issues.append(msg)

lines = T["lines"]
chk('data-duration="%.3f"' % T["total"] in html, "root data-duration 不符")
chk(html.count('class="sub"') == len(lines), "sub 数量 %d != %d" % (html.count('class="sub"'), len(lines)))
chk(html.count('class="beat"') == len(T["beats"]), "beat 数量 %d != %d" % (html.count('class="beat"'), len(T["beats"])))
chk(html.count('class="scene"') == len(T["scenes"]), "scene 数量 %d != %d" % (html.count('class="scene"'), len(T["scenes"])))
chk('id="vo"' in html, "缺少配音轨")
chk('id="bgm"' in html, "缺少 BGM 轨")
for rel in [T["voice"], T["bgm"], "assets/ui-dark.png", "assets/agent/agent-session-v2.mp4", "assets/gsap.min.js"]:
    chk(os.path.exists(os.path.join(BASE, rel)), "资源缺失: " + rel)

ids = set(int(x) for x in re.findall(r'tl\.to\("#sub-(\d+)"', html))
chk(ids == set(range(1, len(lines) + 1)), "sub id 覆盖 %d/%d" % (len(ids), len(lines)))

m = re.search(r'id="agent-video"[^>]*data-start="([\d.]+)"', html)
if m:
    vs = float(m.group(1))
    bd = T["beats"].get("b-demo", {})
    chk(vs + 11.5 <= bd.get("end", 0) + 1e-6, "演示视频越界 %.2f+11.5 > %.2f" % (vs, bd.get("end", 0)))
else:
    issues.append("未找到 agent-video data-start")

for pat in ["{TOTAL", "{SCENES_HTML", "{SUBS_HTML", "{GLOBAL_CSS", "{EXTRA_CSS"]:
    chk(pat not in html, "残留占位符 " + pat)

for a, b in zip(lines, lines[1:]):
    chk(a["end"] <= b["start"] + 1e-6, "字幕重叠 %d/%d" % (a["i"], b["i"]))
chk(lines[-1]["end"] <= T["total"], "末条字幕越界")

blocks = [b for b in srt.split(chr(10) + chr(10)) if b.strip()]
chk(len(blocks) == len(lines), "SRT 条数 %d != %d" % (len(blocks), len(lines)))

for sid, sc in T["scenes"].items():
    chk(sc["end"] > sc["start"], "幕区间非法 " + sid)

for sid in T["scene_order"]:
    sc = T["scenes"][sid]
    bs = [T["beats"][b] for b in sc["beats"] if b in T["beats"]]
    if bs:
        chk(abs(bs[0]["start"] - sc["start"]) < 1.2, "幕首 beat 起点偏差 " + sid)

print("静态自检：问题 %d 个" % len(issues))
for i in issues:
    print("  - " + i)
print("TOTAL %.2fs | %d 条字幕 | %d beat | %d 幕" % (T["total"], len(lines), len(T["beats"]), len(T["scenes"])))
