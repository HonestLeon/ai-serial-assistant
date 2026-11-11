# -*- coding: utf-8 -*-
import asyncio, os, subprocess
import edge_tts

ROOT = r"d:/HUST/Study/Computer/Trae_contest/ai-serial-assistant"
OUT = os.path.join(ROOT, "音乐试听")
MUSIC = os.path.join(ROOT, "ai-serial-assistant-app/promo-video/assets/music/minimal-emotion.mp3")

TEXT = ("参赛作品：智串AI · TUNER，AI 串口调试助手。"
        "面向电赛、智能车、RC 与 RM 的赛前调参加速器。"
        "7 份问卷：100% 说试错最耗时，42.9% 单次调参超过三天。")

VOICES = [
    ("配音A-云扬-男-专业", "zh-CN-YunyangNeural", "0%", "-2Hz"),
    ("配音B-云健-男-沉稳", "zh-CN-YunjianNeural", "0%", "-2Hz"),
    ("配音C-晓晓-女-慢速", "zh-CN-XiaoxiaoNeural", "0%", "+0Hz"),
]

async def main():
    for name, voice, rate, pitch in VOICES:
        raw = os.path.join(OUT, name + ".mp3")
        await edge_tts.Communicate(TEXT, voice, rate=rate, pitch=pitch).save(raw)
        mixed = os.path.join(OUT, name + "-混BGM.mp3")
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", raw,
            "-stream_loop", "-1", "-i", MUSIC,
            "-filter_complex",
            "[1:a]volume=0.12,atrim=0:30[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]",
            "-map", "[out]", "-b:a", "192k", mixed,
        ], check=True)
        print("ok", name)

asyncio.run(main())
print("ALL DONE")
