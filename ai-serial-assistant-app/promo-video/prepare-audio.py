# -*- coding: utf-8 -*-
"""生成 v2 中文配音，并产出驱动整条时间轴的 audio-timing.json。

流程：逐条 TTS -> 实测 wav 时长 -> 累加出每条 start/end、
每个 beat / scene 的显示区间与 TOTAL -> 拼接单条配音轨 -> 扩展 BGM。

TTS 引擎（--engine）：
  auto    Kokoro 模型已就绪则用 hyperframes tts（本地），否则用 edge-tts
  kokoro  npx hyperframes tts（Kokoro-82M，中文音色 zf_xiaobei）
  edge    edge-tts（zh-CN-XiaoxiaoNeural），生成 mp3 后转 24k 单声道 wav

用法：
    python prepare-audio.py
    python prepare-audio.py --engine edge --speed 1.15
    python prepare-audio.py --force        # 强制重生成全部分段
"""
import argparse
import asyncio
import io
import json
import os
import subprocess
import sys
import wave

import numpy as np

from script_v2 import LINES, SCENES, SCENE_ORDER, SCENE_BEATS, tts_text

BASE = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(BASE, "assets", "voice")
MUSIC_DIR = os.path.join(BASE, "assets", "music")
RENDERS = os.path.join(BASE, "renders")
SR = 24000

KOKORO_MODEL = os.path.expanduser("~/.cache/hyperframes/tts/models/kokoro-v1.0.onnx")
KOKORO_VOICES = os.path.expanduser("~/.cache/hyperframes/tts/voices/voices-v1.0.bin")
EDGE_VOICE = "zh-CN-XiaoxiaoNeural"

os.makedirs(VOICE_DIR, exist_ok=True)
os.makedirs(RENDERS, exist_ok=True)


def kokoro_available():
    return (os.path.exists(KOKORO_MODEL) and os.path.getsize(KOKORO_MODEL) > 10_000_000
            and os.path.exists(KOKORO_VOICES) and os.path.getsize(KOKORO_VOICES) > 10_000_000)


def wav_duration(path):
    try:
        import soundfile as sf
        info = sf.info(path)
        return info.frames / float(info.samplerate)
    except Exception:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())


def read_wav(path):
    """读成 24000Hz 单声道 float32。"""
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
    except ImportError:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
            ch = w.getnchannels()
            data = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
            if ch > 1:
                data = data.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, SR)
        data = resample_poly(data, SR // g, sr // g).astype("float32")
    return data


# ---------------------------------------------------------------- Kokoro
def gen_kokoro(items, speed, force):
    """逐条调用 hyperframes tts；返回 {idx: wav路径}。"""
    out = {}
    env = dict(os.environ)
    env.setdefault("HYPERFRAMES_PYTHON", sys.executable)  # Windows 的 python3 常是 Store stub
    for idx, text in items:
        wav = os.path.join(VOICE_DIR, "seg-%03d.wav" % idx)
        if os.path.exists(wav) and not force and os.path.getsize(wav) > 1000:
            out[idx] = wav
            continue
        cmd = ["npx", "--yes", "hyperframes@0.8.206", "tts", text,
               "-o", wav, "-v", "zf_xiaobei", "-l", "zh", "-s", str(speed)]
        r = subprocess.run(cmd, cwd=BASE, env=env, capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) < 1000:
            raise RuntimeError("Kokoro TTS 失败 [%d]: %s\n%s\n%s" % (idx, text, r.stdout, r.stderr))
        out[idx] = wav
        print("  kokoro %d/%d" % (idx, len(LINES)), flush=True)
    return out


# ---------------------------------------------------------------- edge-tts
def gen_edge(items, speed, force):
    """并发生成 mp3，再统一转 24k 单声道 wav。"""
    import edge_tts
    rate = "%+d%%" % int(round((speed - 1.0) * 100))
    todo = []
    for idx, text in items:
        wav = os.path.join(VOICE_DIR, "seg-%03d.wav" % idx)
        mp3 = os.path.join(VOICE_DIR, "seg-%03d.mp3" % idx)
        if not (os.path.exists(wav) and not force and os.path.getsize(wav) > 1000):
            todo.append((idx, text, mp3, wav))

    async def synth_all():
        sem = asyncio.Semaphore(4)

        async def one(idx, text, mp3, wav):
            async with sem:
                for attempt in range(3):
                    try:
                        await edge_tts.Communicate(text, EDGE_VOICE, rate=rate).save(mp3)
                        return
                    except Exception as e:
                        if attempt == 2:
                            raise RuntimeError("edge-tts 失败 [%d]: %s" % (idx, e))
                        await asyncio.sleep(1.5 * (attempt + 1))

        await asyncio.gather(*(one(*t) for t in todo))

    if todo:
        print("  edge-tts 并发合成 %d 条 (rate=%s) ..." % (len(todo), rate), flush=True)
        asyncio.run(synth_all())
        for idx, text, mp3, wav in todo:
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3,
                 "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", wav],
                capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("mp3→wav 失败 [%d]: %s" % (idx, r.stderr))
            print("  edge %d/%d" % (idx, len(LINES)), flush=True)

    return {idx: os.path.join(VOICE_DIR, "seg-%03d.wav" % idx) for idx, _ in items}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["auto", "kokoro", "edge"], default="auto")
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--gap", type=float, default=0.35, help="同幕相邻解说间隙")
    ap.add_argument("--scene-gap", type=float, default=0.85, help="幕间间隙")
    ap.add_argument("--tail", type=float, default=6.0, help="片尾停留")
    ap.add_argument("--lead", type=float, default=0.6, help="第一条解说前的画面时间")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    engine = args.engine
    if engine == "auto":
        engine = "kokoro" if kokoro_available() else "edge"
    print("TTS 引擎: %s (语速 %.2f)，共 %d 条" % (engine, args.speed, len(LINES)), flush=True)

    items = [(i, tts_text(text)) for i, (_, _, text) in enumerate(LINES, 1)]
    paths = gen_kokoro(items, args.speed, args.force) if engine == "kokoro" \
        else gen_edge(items, args.speed, args.force)

    segs = []
    for i, (scene, beat, text) in enumerate(LINES, 1):
        path = paths[i]
        dur = wav_duration(path)
        segs.append({"i": i, "scene": scene, "beat": beat, "text": text,
                     "wav": os.path.relpath(path, BASE).replace("\\", "/"),
                     "dur": round(dur, 3)})

    # 由实测时长累加时间轴
    t = args.lead
    prev_scene = None
    for s in segs:
        if prev_scene is not None:
            t += args.scene_gap if s["scene"] != prev_scene else args.gap
        s["start"] = round(t, 3)
        s["end"] = round(t + s["dur"] + 0.25, 3)
        t = s["end"]
        prev_scene = s["scene"]
    total = round(t + args.tail, 3)

    # beat / scene 显示区间（连续，中间不留黑屏）
    scene_start = {}
    for sid in SCENE_ORDER:
        rows = [s for s in segs if s["scene"] == sid]
        scene_start[sid] = round(rows[0]["start"] - 0.8, 3)
    scene_start[SCENE_ORDER[0]] = 0.0
    scene_end = {sid: (scene_start[SCENE_ORDER[n + 1]] if n + 1 < len(SCENE_ORDER) else total)
                 for n, sid in enumerate(SCENE_ORDER)}
    scenes = {sid: {"start": scene_start[sid], "end": scene_end[sid],
                    "label": dict((a, b) for a, b, _ in SCENES)[sid],
                    "beats": SCENE_BEATS[sid]} for sid in SCENE_ORDER}

    beats = {}
    for sid in SCENE_ORDER:
        rows = [s for s in segs if s["scene"] == sid]
        for bid in SCENE_BEATS[sid]:
            brows = [s for s in rows if s["beat"] == bid]
            if brows:
                beats[bid] = {"scene": sid,
                              "start": round(brows[0]["start"] - 0.3, 3),
                              "end": round(brows[-1]["end"] + 0.3, 3)}
        bids = [b for b in SCENE_BEATS[sid] if b in beats]
        for n, bid in enumerate(bids):
            beats[bid]["end"] = beats[bids[n + 1]]["start"] if n + 1 < len(bids) else scene_end[sid]
    for bid in beats:
        beats[bid]["start"] = max(0.0, beats[bid]["start"])

    # 拼接单条配音轨
    print("拼接配音轨 -> assets/voice/voiceover-v2.wav (%.1fs) ..." % total, flush=True)
    buf = np.zeros(int(total * SR) + SR, dtype="float32")
    for s in segs:
        data = read_wav(os.path.join(BASE, s["wav"]))
        pos = int(s["start"] * SR)
        buf[pos:pos + len(data)] += data
    peak = float(np.max(np.abs(buf)))
    if peak > 0.98:
        buf *= 0.98 / peak
    import soundfile as sf
    sf.write(os.path.join(VOICE_DIR, "voiceover-v2.wav"),
             buf[:int(total * SR)], SR, subtype="PCM_16")

    # BGM 扩展到 TOTAL
    bgm_src = os.path.join(MUSIC_DIR, "defense-180.mp3")
    bgm_out = os.path.join(MUSIC_DIR, "defense-v2.mp3")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-stream_loop", "1", "-i", bgm_src,
           "-t", str(total), "-af", "afade=t=out:st=%.2f:d=6" % max(0, total - 6),
           "-c:a", "libmp3lame", "-b:a", "192k", bgm_out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("BGM 扩展失败: " + r.stderr)

    # 断言
    for a, b in zip(segs, segs[1:]):
        assert a["end"] <= b["start"] + 1e-6, "字幕时间重叠: %s/%s" % (a["i"], b["i"])
    assert segs[-1]["end"] <= total, "末条字幕越界"
    for n, sid in enumerate(SCENE_ORDER):
        assert scene_start[sid] < scene_end[sid], "幕区间非法: " + sid
        if n + 1 < len(SCENE_ORDER):
            assert abs(scene_end[sid] - scene_start[SCENE_ORDER[n + 1]]) < 1e-6

    timing = {
        "total": total, "sample_rate": SR, "speed": args.speed, "engine": engine,
        "voice": "assets/voice/voiceover-v2.wav",
        "bgm": "assets/music/defense-v2.mp3",
        "lines": segs, "beats": beats, "scenes": scenes,
        "scene_order": SCENE_ORDER,
    }
    with io.open(os.path.join(BASE, "audio-timing.json"), "w", encoding="utf-8") as f:
        json.dump(timing, f, ensure_ascii=False, indent=2)

    print("完成：TOTAL=%.2fs (%d 条解说, %d 个 beat, %d 幕)" %
          (total, len(segs), len(beats), len(scenes)), flush=True)
    for sid in SCENE_ORDER:
        print("  %s  %6.1f → %6.1f" % (scenes[sid]["label"], scene_start[sid], scene_end[sid]), flush=True)


if __name__ == "__main__":
    main()
