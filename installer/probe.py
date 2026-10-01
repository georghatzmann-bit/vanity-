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


def changed_pixels(before, after):
    """Wie viele Pixel sich oben in der Mitte deutlich verändert haben (dort sitzt die Anzeige)."""
    import numpy as np

    w, _ = before.size
    box = (w // 2 - 260, 0, w // 2 + 260, 130)
    a = np.asarray(before.convert("RGB").crop(box), dtype=np.int16)
    b = np.asarray(after.convert("RGB").crop(box), dtype=np.int16)
    return int((np.abs(a - b).max(axis=2) > 40).sum())


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
import ctypes  # noqa: E402

hwnd = overlay._window.hwnd if overlay._window else None
check("Anzeige sichtbar beim Zuhören", bool(hwnd and ctypes.windll.user32.IsWindowVisible(hwnd)),
      f"({changed_pixels(before, shot)} Pixel oben in der Mitte verändert)")

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
check("Anzeige verschwindet danach", not ctypes.windll.user32.IsWindowVisible(hwnd))
overlay.stop()

# 3. Sofort-Schalter: Dunkelmodus (Registry) und Funk (Windows-Funkschalter über PowerShell)
import winreg  # noqa: E402

from jarvis import pc  # noqa: E402

_THEME = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"


def light_theme():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _THEME) as key:
            return winreg.QueryValueEx(key, "AppsUseLightTheme")[0]
    except OSError:
        return None


was_light = light_theme()
started = time.monotonic()
pc.dark_mode(True)
check("Dunkelmodus an", light_theme() == 0, f"in {time.monotonic() - started:.1f} s")
pc.dark_mode(False)
check("Dunkelmodus aus", light_theme() == 1)
if was_light == 0:
    pc.dark_mode(True)
for kind in ("bluetooth", "wifi"):
    # Ein Server in GitHub Actions hat meist keinen Funk: "kein ..." ist dort die richtige Antwort.
    started = time.monotonic()
    try:
        outcome = pc.radio(kind, True)
    except pc.RadioMissing as exc:
        outcome = f"kein Funk ({exc})"
    except Exception as exc:
        outcome = f"Fehler: {exc!r}"
    print(f"   Funk {kind}: {outcome} ({time.monotonic() - started:.1f} s)", flush=True)

# 4. Bildschirm lesen und Fenster ohne Maus (nur Messwerte, ein Server kann manches nicht)
import subprocess  # noqa: E402

from jarvis import screen  # noqa: E402

started = time.monotonic()
shot_path = screen.capture(OUT / "bildschirm-klein.jpg")
print(f"   Bildschirmfoto: {shot_path.stat().st_size // 1024} KB in {time.monotonic() - started:.1f} s", flush=True)
try:
    from PIL import Image, ImageDraw, ImageFont

    card = Image.new("RGB", (900, 220), "white")
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 64)
    except OSError:
        font = ImageFont.load_default()
    ImageDraw.Draw(card).text((30, 60), "JARVIS LIEST 4711", fill="black", font=font)
    card.save(OUT / "ocr-probe.png")
    started = time.monotonic()
    lines = screen.read_text(image=OUT / "ocr-probe.png")
    seen = " ".join(l["t"] for l in lines)
    print(f"   Texterkennung: {seen!r} in {time.monotonic() - started:.1f} s "
          f"({'OK' if '4711' in seen else 'nicht erkannt'})", flush=True)
except Exception as exc:
    print(f"   Texterkennung: Fehler {exc!r}", flush=True)
editor = None
try:
    editor = subprocess.Popen(["notepad.exe"])
    time.sleep(2.5)
    started = time.monotonic()
    names = [w["titel"] for w in screen.windows()]
    print(f"   Fenster: {len(names)} in {time.monotonic() - started:.1f} s, z. B. {names[:6]}", flush=True)
    title = next((n for n in names if "Notepad" in n or "Editor" in n), "Notepad")
    started = time.monotonic()
    print("   Ohne Tastatur schreiben:", screen.type_into(title, "", "Hallo von Jarvis"),
          f"({time.monotonic() - started:.1f} s)", flush=True)
    time.sleep(0.5)
    seen = " ".join(l["t"] for l in screen.read_text())
    print(f"   Text im Editor sichtbar: {'OK' if 'Jarvis' in seen else 'nicht gesehen'}", flush=True)
    found = screen.elements(title, 60)
    print(f"   Elemente im Editor: {[(e.get('art'), e.get('name')) for e in found[:8]]}", flush=True)
except Exception as exc:
    print(f"   Fenster ohne Maus: Fehler {exc!r}", flush=True)
finally:
    if editor is not None:
        subprocess.run(["taskkill", "/f", "/pid", str(editor.pid)], capture_output=True)

print("FEHLER:", ", ".join(failed) if failed else "keine", flush=True)
sys.exit(1 if failed else 0)
