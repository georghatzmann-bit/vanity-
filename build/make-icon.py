"""Erzeugt build/icon.png (1024 px) und build/icon.ico (16-256 px) fuer den Konto-Retter.

Aufruf:  python3 build/make-icon.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
S = 1024  # Arbeitsgroesse, wird fuer kleine Groessen sauber herunterskaliert


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make():
    # Hintergrund: abgerundetes Quadrat mit diagonalem Verlauf (Akzentfarbe)
    top, bottom = (99, 102, 241), (124, 58, 237)
    grad = Image.new("RGB", (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = lerp(top, bottom, (x + y) / (2 * S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # Schild als eine glatte Form: oben gerade Schultern, unten zwei Kurven zur Spitze
    cx = S / 2
    top_y, shoulder_y, side_end_y, tip_y = S * 0.19, S * 0.26, S * 0.50, S * 0.85
    half_w = S * 0.28

    def bez(p0, p1, p2, n=60):
        return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0],
                 (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1])
                for t in (i / n for i in range(n + 1))]

    right = [(cx, top_y), (cx + half_w, shoulder_y), (cx + half_w, side_end_y)]
    right += bez((cx + half_w, side_end_y), (cx + half_w, S * 0.74), (cx, tip_y))
    left = [(2 * cx - x, y) for (x, y) in reversed(right)]
    d.polygon(right + left, fill=(255, 255, 255, 255))
    # Haken
    w = int(S * 0.065)
    pts = [(cx - S * 0.12, S * 0.53), (cx - S * 0.025, S * 0.625), (cx + S * 0.14, S * 0.43)]
    d.line(pts, fill=(109, 80, 240, 255), width=w, joint="curve")
    for p in (pts[0], pts[2]):
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=(109, 80, 240, 255))

    img.save(HERE / "icon.png")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(HERE / "icon.ico", sizes=sizes)
    img.resize((256, 256), Image.LANCZOS).save(HERE.parent / "src" / "renderer" / "img" / "icon.png")


if __name__ == "__main__":
    (HERE.parent / "src" / "renderer" / "img").mkdir(parents=True, exist_ok=True)
    make()
    print("icon.png und icon.ico erstellt")
