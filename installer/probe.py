"""Probe auf echtem Windows (GitHub Actions): Startmenü, Jarvis-Anzeige, Fenster-Symbol.

Läuft im installierten Jarvis-Ordner mit Jarvis' eigenem Python. Gibt Messwerte aus und
speichert Bildschirmfotos in probe-bilder/, damit man sieht, was wirklich erscheint.
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.getcwd())

from PIL import ImageGrab  # noqa: E402

from jarvis import apps  # noqa: E402
from jarvis.overlay import Overlay  # noqa: E402

OUT = Path(os.environ.get("PROBE_OUT", "probe-bilder"))
OUT.mkdir(exist_ok=True)
failed = []


def check(name, ok, detail=""):
    print(f"{'OK  ' if ok else 'FEHL'} {name} {detail}", flush=True)
    if not ok:
        failed.append(name)


def top_center_activity(img):
    """Wie viele Pixel oben in der Mitte deutlich hell oder farbig sind (die Anzeige)."""
    w, _ = img.size
    region = img.convert("RGB").crop((w // 2 - 260, 0, w // 2 + 260, 130))
    lit = 0
    for r, g, b in region.getdata():
        if max(r, g, b) > 200 or (b > 150 and b > r + 60):
            lit += 1
    return lit


# 1. Startmenü
started = time.monotonic()
items = apps.load_start_apps()
check("Startmenü gelesen", len(items) > 5, f"{len(items)} Einträge in {time.monotonic() - started:.1f} s")
print("   Beispiele:", [n for n, _ in items[:8]])
edge = apps.best_match("edge", items)
check("'Edge' gefunden", edge is not None, str(edge))
check("'Zaubertrank' nicht gefunden", apps.best_match("zaubertrank", items) is None)

# 2. Jarvis-Anzeige
before = ImageGrab.grab()
base = top_center_activity(before)
overlay = Overlay()
check("Anzeige startet", overlay.start())
overlay.state("listening")
overlay.level(0.7)
time.sleep(1.5)
shot = ImageGrab.grab()
shot.save(OUT / "anzeige-hoert-zu.png")
lit = top_center_activity(shot)
check("Anzeige sichtbar beim Zuhören", lit > base + 400, f"(helle Pixel {lit}, vorher {base})")

overlay.message("user", "Öffne Spotify und spiel meine Playlist")
overlay.state("thinking")
time.sleep(0.8)
overlay.state("speaking")
overlay.message("jarvis", "Spotify läuft, Sir. Ihre Playlist startet gleich.", final=False)
for i in range(10):
    overlay.level(0.3 + 0.07 * i)
    time.sleep(0.05)
ImageGrab.grab().save(OUT / "anzeige-spricht.png")

overlay.state("idle")
time.sleep(5.5)
after = top_center_activity(ImageGrab.grab())
check("Anzeige verschwindet danach", after < base + 200, f"(helle Pixel {after})")
overlay.stop()

print("FEHLER:", ", ".join(failed) if failed else "keine", flush=True)
sys.exit(1 if failed else 0)
