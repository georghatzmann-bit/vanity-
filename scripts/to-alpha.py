#!/usr/bin/env python3
"""Macht schwarze Hintergründe der Higgsfield-Bilder/-Clips durchsichtig.

Helligkeit -> Deckkraft (so wie "Negativ multiplizieren"/Screen), die Farbe wird entsprechend
aufgehellt, damit das Leuchten gleich stark bleibt.
  python3 scripts/to-alpha.py image <eingang.png> <ausgang.png> [schwelle]
  python3 scripts/to-alpha.py video <ffmpeg> <eingang.mp4> <ausgang.webm> <breite> [schwelle]
"""
import subprocess
import sys

import numpy as np
from PIL import Image


def to_rgba(rgb, floor=10):
    a = rgb.astype(np.float32)
    m = a.max(axis=2)
    alpha = np.clip((m - floor) / (255 - floor), 0, 1)
    # weiche Kante unten, damit Rauschen im Schwarz verschwindet
    alpha = alpha ** 0.9
    safe = np.maximum(alpha, 1e-3)[..., None]
    color = np.clip(a / 255 / safe, 0, 1) * 255
    out = np.dstack([color, alpha * 255]).astype(np.uint8)
    return out


def image(src, dst, floor=10):
    rgb = np.asarray(Image.open(src).convert('RGB'))
    Image.fromarray(to_rgba(rgb, floor), 'RGBA').save(dst, optimize=True)


def video(ffmpeg, src, dst, width, floor=10):
    probe = subprocess.run([ffmpeg, '-i', src], capture_output=True, text=True).stderr
    import re
    w, h = map(int, re.search(r', (\d{2,5})x(\d{2,5})', probe).groups())
    out_w = int(width)
    out_h = int(round(h * out_w / w / 2) * 2)
    dec = subprocess.Popen([ffmpeg, '-loglevel', 'error', '-i', src, '-vf', f'scale={out_w}:{out_h}:flags=lanczos', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    enc = subprocess.Popen([ffmpeg, '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{out_w}x{out_h}', '-r', '24', '-i', '-',
                            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-auto-alt-ref', '0', dst], stdin=subprocess.PIPE)
    size = out_w * out_h * 3
    n = 0
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(out_h, out_w, 3)
        enc.stdin.write(to_rgba(rgb, floor).tobytes())
        n += 1
    enc.stdin.close()
    enc.wait()
    dec.wait()
    print('frames', n)


if __name__ == '__main__':
    if sys.argv[1] == 'image':
        image(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 10)
    else:
        video(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6]) if len(sys.argv) > 6 else 10)
