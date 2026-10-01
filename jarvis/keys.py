"""Tastatur und Fenster unter Windows: Tasten drücken, Text tippen, nachsehen, welches
Programm vorne ist. Alles über die Windows-Schnittstelle (SendInput), ohne Zusatzpakete.

Text geht als Unicode-Zeichen hinein (KEYEVENTF_UNICODE). So spielt das Tastaturlayout
keine Rolle, und Umlaute, @ und Emojis kommen genau so an, wie sie gemeint sind.
"""

from __future__ import annotations

import logging
import os
import time

log = logging.getLogger(__name__)

VK = {
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "enter": 0x0D, "esc": 0x1B, "tab": 0x09, "backspace": 0x08, "space": 0x20,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27, "home": 0x24, "end": 0x23,
}
VK.update({chr(c).lower(): c for c in range(ord("A"), ord("Z") + 1)})
VK.update({str(d): 0x30 + d for d in range(10)})

_INPUT_KEYBOARD = 1
_KEYUP = 0x0002
_UNICODE = 0x0004


class KeysUnavailable(RuntimeError):
    pass


def _api():
    if os.name != "nt":
        raise KeysUnavailable("Tastatur-Steuerung gibt es nur unter Windows.")
    import ctypes
    from ctypes import wintypes

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class _UNION(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _UNION)]

    user32 = ctypes.windll.user32
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
    user32.GetForegroundWindow.restype = wintypes.HWND
    return ctypes, user32, INPUT, KEYBDINPUT


def _send(events: list[tuple[int, int, int]]) -> None:
    """events: (virtuelle Taste, Unicode-Zeichen, Flags)"""
    ctypes, user32, INPUT, KEYBDINPUT = _api()
    array = (INPUT * len(events))()
    for i, (vk, scan, flags) in enumerate(events):
        array[i].type = _INPUT_KEYBOARD
        array[i].u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    sent = user32.SendInput(len(events), array, ctypes.sizeof(INPUT))
    if sent != len(events):
        raise KeysUnavailable("Windows hat die Tastendrücke nicht angenommen.")


def press(*keys: str) -> None:
    """Drückt eine Tastenkombination, z. B. press("ctrl", "k") oder press("enter")."""
    codes = []
    for key in keys:
        code = VK.get(key.lower())
        if code is None:
            raise ValueError(f"Unbekannte Taste: {key}")
        codes.append(code)
    events = [(code, 0, 0) for code in codes] + [(code, 0, _KEYUP) for code in reversed(codes)]
    _send(events)


def type_text(text: str) -> None:
    """Tippt Text Zeichen für Zeichen (Unicode, unabhängig vom Tastaturlayout)."""
    units = text.encode("utf-16-le")
    events = []
    for i in range(0, len(units), 2):
        unit = int.from_bytes(units[i:i + 2], "little")
        events.append((0, unit, _UNICODE))
        events.append((0, unit, _UNICODE | _KEYUP))
    for start in range(0, len(events), 200):  # in Häppchen, sonst verschluckt manches Programm Zeichen
        _send(events[start:start + 200])
        time.sleep(0.01)


def foreground_window() -> int:
    _ctypes, user32, _INPUT, _KB = _api()
    return int(user32.GetForegroundWindow() or 0)


def foreground_process() -> str:
    """Name des Programms, dem das vordere Fenster gehört (klein geschrieben), sonst ""."""
    try:
        ctypes, user32, _INPUT, _KB = _api()
        from ctypes import wintypes

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        import psutil

        return psutil.Process(pid.value).name().lower()
    except Exception:
        return ""


def focus(hwnd: int) -> bool:
    """Holt ein Fenster wieder nach vorn (z. B. das, in dem Georg vorher war)."""
    if not hwnd:
        return False
    try:
        _ctypes, user32, _INPUT, _KB = _api()
        # Windows lässt nur nach einer Eingabe das Fenster wechseln: kurz Alt tippen.
        _send([(VK["alt"], 0, 0), (VK["alt"], 0, _KEYUP)])
        return bool(user32.SetForegroundWindow(hwnd))
    except Exception as exc:
        log.debug("Fenster zurückholen: %s", exc)
        return False
