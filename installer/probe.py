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


def top_center(img):
    """Der Bereich oben in der Mitte, in dem die Anzeige erscheint."""
    w, _ = img.size
    return img.convert("RGB").crop((w // 2 - 260, 0, w // 2 + 260, 130))


def changed_pixels(a, b):
    """Wie viele Pixel sich oben in der Mitte deutlich verändert haben. Ob die Anzeige
    heller oder dunkler ist als der Desktop dahinter, spielt so keine Rolle."""
    changed = 0
    for pa, pb in zip(top_center(a).getdata(), top_center(b).getdata()):
        if max(abs(x - y) for x, y in zip(pa, pb)) > 40:
            changed += 1
    return changed


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
overlay = Overlay()
check("Anzeige startet", overlay.start())
overlay.state("listening")
overlay.level(0.7)
time.sleep(1.5)
shot = ImageGrab.grab()
shot.save(OUT / "anzeige-hoert-zu.png")
changed = changed_pixels(before, shot)
check("Anzeige sichtbar beim Zuhören", changed > 400, f"({changed} Pixel verändert)")

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
after = changed_pixels(before, ImageGrab.grab())
check("Anzeige verschwindet danach", after < 200, f"({after} Pixel noch verändert)")
overlay.stop()

print("FEHLER:", ", ".join(failed) if failed else "keine", flush=True)
sys.exit(1 if failed else 0)
