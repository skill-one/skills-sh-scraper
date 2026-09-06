#!/usr/bin/env python3
"""Resize generated sticker art into small meme/sticker sizes."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


DEFAULT_SIZES = (512, 240, 120, 50)


def parse_sizes(value: str) -> list[int]:
    sizes: list[int] = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            size = int(item)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"invalid size: {item}") from exc
        if size <= 0:
            raise argparse.ArgumentTypeError(f"size must be positive: {size}")
        sizes.append(size)
    if not sizes:
        raise argparse.ArgumentTypeError("at least one size is required")
    return sizes


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def resize_with_sips(source: Path, output: Path, size: int, background: str) -> None:
    tmp = output.with_suffix(".tmp.png")
    try:
        run(["sips", "--resampleHeightWidthMax", str(size), str(source), "--out", str(tmp)])
        run(["sips", "--padToHeightWidth", str(size), str(size), "--padColor", background, str(tmp), "--out", str(output)])
    finally:
        tmp.unlink(missing_ok=True)


def resize_with_magick(source: Path, output: Path, size: int, background: str) -> None:
    run([
        "magick",
        str(source),
        "-resize",
        f"{size}x{size}",
        "-background",
        f"#{background}",
        "-gravity",
        "center",
        "-extent",
        f"{size}x{size}",
        str(output),
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description="Export small square sticker PNGs.")
    parser.add_argument("source", type=Path, help="Source PNG/JPEG/WebP image")
    parser.add_argument("--out-dir", type=Path, default=None, help="Output directory; defaults to source directory")
    parser.add_argument("--basename", default=None, help="Output basename; defaults to source stem")
    parser.add_argument("--sizes", type=parse_sizes, default=list(DEFAULT_SIZES), help="Comma-separated sizes, default: 512,240,120,50")
    parser.add_argument("--background", default="FFFFFF", help="Padding color as hex without #, default: FFFFFF")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not source.exists():
        print(f"source not found: {source}", file=sys.stderr)
        return 2

    out_dir = (args.out_dir or source.parent).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    basename = args.basename or source.stem

    has_sips = shutil.which("sips") is not None
    has_magick = shutil.which("magick") is not None
    if not has_sips and not has_magick:
        print("missing resize tool: install ImageMagick or run on macOS with sips", file=sys.stderr)
        return 2

    for size in args.sizes:
        output = out_dir / f"{basename}-{size}.png"
        if has_sips:
            resize_with_sips(source, output, size, args.background)
        else:
            resize_with_magick(source, output, size, args.background)
        print(output)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
