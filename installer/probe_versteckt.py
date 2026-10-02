"""Windows-Prüfung: Die Werkstatt testet auf einem unsichtbaren Arbeitsplatz (jarvis/versteckt.py).

Startet ein kleines Programm mit Fenster einmal auf dem unsichtbaren Desktop und einmal normal. Geprüft:
- das Programm läuft dort und meldet den Desktop "JarvisWerkstatt",
- sein Fenster ist von Georgs Desktop aus nicht zu finden (beim normalen Start schon),
- Ein- und Ausgabe über die Leitungen gehen (wie bei Claude Code mit stream-json),
- Rückgabewert und Ende kommen an.
Rückgabewert 0 = alles gut.
"""

import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes as w

# Läuft aus dem Jarvis-Ordner (Push-Location im Workflow): das Skript liegt woanders, also den Ordner selbst
# in den Suchpfad, sonst findet Python das Paket jarvis nicht
sys.path.insert(0, os.getcwd())

from jarvis import versteckt  # noqa: E402

TITLE = "Jarvis-Probe-Unsichtbar"
CHILD = r"""
import ctypes, sys, tkinter
from ctypes import wintypes as w
user32 = ctypes.WinDLL("user32")
user32.GetThreadDesktop.restype = w.HANDLE
desk = user32.GetThreadDesktop(ctypes.windll.kernel32.GetCurrentThreadId())
buf = ctypes.create_unicode_buffer(256)
need = w.DWORD(0)
user32.GetUserObjectInformationW(desk, 2, buf, ctypes.sizeof(buf), ctypes.byref(need))
root = tkinter.Tk()
root.title("TITLE")
root.geometry("320x200+40+40")
root.update()
print("desktop:" + buf.value, flush=True)
line = sys.stdin.readline().strip()
print("echo:" + line + " äöü", flush=True)
root.after(1500, root.destroy)
root.mainloop()
sys.exit(7)
""".replace("TITLE", TITLE)


def visible_here() -> bool:
    user32 = ctypes.WinDLL("user32")
    user32.FindWindowW.argtypes = [w.LPCWSTR, w.LPCWSTR]
    user32.FindWindowW.restype = w.HWND
    return bool(user32.FindWindowW(None, TITLE))


def run(hidden: bool) -> dict:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")  # wie in der Werkstatt
    proc = versteckt.popen([sys.executable, "-c", CHILD], env=env, hidden=hidden)
    first = proc.stdout.readline().strip()
    time.sleep(0.5)
    seen = visible_here()
    proc.stdin.write("hallo\n")
    proc.stdin.flush()
    second = proc.stdout.readline().strip()
    try:
        code = proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = None
    return {"art": type(proc).__name__, "desktop": first, "sichtbar": seen, "echo": second, "code": code}


def main() -> int:
    if not versteckt.available():
        print("Unsichtbarer Arbeitsplatz: nicht verfügbar")
        return 1
    hidden = run(True)
    normal = run(False)
    print("Unsichtbar:", hidden)
    print("Normal:    ", normal)
    ok = (hidden["art"] == "HiddenProcess" and hidden["desktop"] == "desktop:" + versteckt.DESKTOP
          and not hidden["sichtbar"] and hidden["echo"] == "echo:hallo äöü" and hidden["code"] == 7
          and normal["desktop"] == "desktop:Default" and normal["sichtbar"] and normal["code"] == 7)
    print("Unsichtbarer Arbeitsplatz:", "OK" if ok else "FEHLER")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
