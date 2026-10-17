#!/usr/bin/env python3
"""Packs natively rendered PNGs into one multi-size .ico (called by scripts/make-icon.mjs).

Usage: python3 scripts/make-ico.py <out.ico> <png> [<png> ...]
Each PNG is stored as-is for its own size (no resampling). Requires Pillow.
"""
import sys

from PIL import Image


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    out, files = sys.argv[1], sys.argv[2:]
    images = [Image.open(f).convert("RGBA") for f in files]
    images.sort(key=lambda im: im.size[0], reverse=True)
    largest = images[0]
    sizes = [im.size for im in images]
    largest.save(out, format="ICO", sizes=sizes, append_images=images[1:])
    with Image.open(out) as check:
        stored = sorted(check.info.get("sizes", set()))
    print("ico: " + ", ".join(f"{w}x{h}" for w, h in stored))
    return 0


if __name__ == "__main__":
    sys.exit(main())
