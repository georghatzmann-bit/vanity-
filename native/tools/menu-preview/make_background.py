# Makes a calm, suggested game background (sky, hills, meadow) for the menu preview.
# Deliberately stylised - it is NOT an image from Fortnite.
import sys
from PIL import Image, ImageDraw, ImageFilter
out, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
img = Image.new("RGB", (w, h))
d = ImageDraw.Draw(img)
for y in range(h):
    t = y / h
    if t < 0.58:
        k = t / 0.58
        c = (int(70 + 90 * k), int(120 + 80 * k), int(200 + 35 * k))
    else:
        k = (t - 0.58) / 0.42
        c = (int(84 - 30 * k), int(140 - 50 * k), int(70 - 25 * k))
    d.line([(0, y), (w, y)], fill=c)
d.ellipse([-200, int(h * 0.48), int(w * 0.55), int(h * 0.85)], fill=(70, 125, 72))
d.ellipse([int(w * 0.4), int(h * 0.5), int(w * 1.2), int(h * 0.9)], fill=(62, 115, 66))
d.rectangle([int(w * 0.72), int(h * 0.38), int(w * 0.80), int(h * 0.60)], fill=(150, 112, 78))
d.polygon([(int(w * 0.70), int(h * 0.38)), (int(w * 0.76), int(h * 0.30)), (int(w * 0.82), int(h * 0.38))], fill=(120, 70, 60))
img = img.filter(ImageFilter.GaussianBlur(3))
img = img.convert("RGBA")
open(out, "wb").write(img.tobytes())
print("Background:", out)
