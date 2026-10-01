"""Probe: Hat der laufende Jarvis (PID als Argument) ein sichtbares Fenster mit dem Titel "Jarvis"?"""

import ctypes
import sys
from ctypes import wintypes

pid = int(sys.argv[1])
user32 = ctypes.windll.user32
found = []
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def visit(hwnd, _):
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value == pid:
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        found.append((title.value, bool(user32.IsWindowVisible(hwnd))))
    return True


user32.EnumWindows(EnumProc(visit), 0)
print("Fenster von Jarvis:", [f for f in found if f[0]])
visible = any(title == "Jarvis" and shown for title, shown in found)
print("Jarvis-Fenster sichtbar:", visible)
sys.exit(0 if visible else 1)
