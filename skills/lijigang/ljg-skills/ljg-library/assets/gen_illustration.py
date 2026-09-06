#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ljg-library 图解生成器：把一幅「意向画面」生成为带继刚作主角的卡片插画。

用法：
  python3 gen_illustration.py --frame "<英文场景构图+标注>" --out ~/Downloads/x_sketch.png
  --frame 这张图的具体构图（英文）：继刚在做/经历什么、隐喻物件、信息怎么流、要哪几个中文标注。
          由 cast 按「意向画面」写出（见 references/extraction.md 第二部分）。
  --ref   继刚墨像参考图（默认 assets/ljg-portrait.png，同目录）——模型据此把主角画成认得出的继刚。

图解风格固定为吉田诚治式绘本感（绘本感异世界日常空间、暖光斜射、治愈又精致），DNA 已内置，
frame 只写「画什么」、不用写风格词。

依赖 env: LISTENHUB_API_KEY。直接调 marswave（gemini-3-pro-image），绕开任何交互门控，可进批量管线。
返回：把生成的 PNG 写到 --out，并打印路径。失败打印错误并非零退出。
"""
import argparse, base64, json, os, sys, urllib.request, pathlib

API = "https://api.marswave.ai/openapi/v1/images/generation"

# 图解风格 DNA（吉田诚治）+ 主角规格（继刚从参考图生成、认得出）
STYLE = (
    "Warm painterly background illustration in the style of Japanese background artist Yoshida Seiji (吉田誠治), "
    "as in his art book ものがたりの家: a cozy, lived-in fantasy-everyday space told like a storybook. "
    "Soft digital painting with rich environmental detail, solid architecture and accurate perspective, deep sense of place. "
    "Warm low-angle sunlight streaming through windows, gentle glow and floating dust motes; "
    "honey / amber / wood-brown tones, muted teal-green accents, soft cozy shadows. "
    "Wooden beams and floors, shelves crammed with books and jars, potted plants, hanging tools, small everyday clutter — "
    "a magical workshop / old bookshop / quiet library that feels real enough to live in. "
    "Small neat hand-lettered Chinese labels that sit naturally within the scene. "
    "PROTAGONIST: the man in the reference image as a believable small-to-mid figure INHABITING the space "
    "(reading / working / walking through it) — KEEP HIM RECOGNIZABLE (his glasses, beard, hairstyle); "
    "he carries the core action while the warm, detailed environment wraps around him. "
    "Painterly storybook illustration, not pixel art, not flat cartoon, not realistic photo."
)

COMMON = (
  "Generate one standalone 16:9 horizontal Chinese knowledge-card illustration. {dna}\n"
  "The man in the reference image is the recurring PROTAGONIST 你 — render him in the style above and keep him "
  "recognizable; he carries the core action/position, not decoration.\n"
  "SCENE: {frame}\n"
  "Constraints: ONE core idea; keep clear negative space; use only a few short hand-written Chinese labels "
  "(2-8 chars each); no top-left title; no structure-type words on the image; render any Chinese text correctly. "
  "Make the metaphor land at a glance."
)


def find_b64(o):
    if isinstance(o, dict):
        idd = o.get("inlineData") or o.get("inline_data")
        if isinstance(idd, dict) and isinstance(idd.get("data"), str) and len(idd["data"]) > 1000:
            return idd["data"]
        if isinstance(o.get("data"), str) and len(o["data"]) > 1000:
            return o["data"]
        for v in o.values():
            r = find_b64(v)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_b64(v)
            if r:
                return r
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", default=str(pathlib.Path(__file__).with_name("ljg-portrait.png")))
    args = ap.parse_args()

    key = os.environ.get("LISTENHUB_API_KEY")
    if not key:
        sys.exit("ERROR: LISTENHUB_API_KEY not set in env")
    ref_b64 = base64.b64encode(pathlib.Path(args.ref).read_bytes()).decode()
    prompt = COMMON.format(dna=STYLE, frame=args.frame)
    payload = {
        "provider": "google",
        "model": "gemini-3-pro-image-preview",
        "prompt": prompt,
        "imageConfig": {"imageSize": "2K", "aspectRatio": "16:9"},
        "referenceImages": [{"inlineData": {"data": ref_b64, "mimeType": "image/png"}}],
    }
    req = urllib.request.Request(
        API, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Source": "skills"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        resp = json.loads(r.read().decode())
    b = find_b64(resp)
    if not b:
        sys.exit("ERROR: no image in response: " + json.dumps(resp)[:500])
    out = pathlib.Path(os.path.expanduser(args.out))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(b))
    print(str(out))


if __name__ == "__main__":
    main()
