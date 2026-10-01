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
    "enter": 0x0D, "esc": 0x1B, "tab": 0x09, "backspace": 0x08, "space": 0x20, "delete": 0x2E,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "printscreen": 0x2C,
    # Die Taste rechts neben L (US: Apostroph, deutsch: Ä). Discord: Strg+' startet einen Anruf.
    "quote": 0xDE,
}
VK.update({chr(c).lower(): c for c in range(ord("A"), ord("Z") + 1)})
VK.update({str(d): 0x30 + d for d in range(10)})
# F1 bis F24. F13 bis F24 gibt es auf keiner Tastatur: frei für Tastenkürzel, die kein Spiel stören.
VK.update({f"f{n}": 0x6F + n for n in range(1, 25)})

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
        return bring_to_front(hwnd)
    except Exception as exc:
        log.debug("Fenster zurückholen: %s", exc)
        return False


def _wait_front(user32, hwnd: int, seconds: float) -> bool:
    end = time.monotonic() + seconds
    while True:
        if int(user32.GetForegroundWindow() or 0) == int(hwnd):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.02)


def bring_to_front(hwnd: int) -> bool:
    """Fenster nach vorn, auch wenn es minimiert ist. Windows erlaubt das einem Programm im
    Hintergrund nicht immer; dann helfen (wie bei AutoHotkey) ein Alt-Tipp und zuletzt das
    kurze Koppeln an das vordere Fenster."""
    ctypes, user32, _INPUT, _KB = _api()
    kernel32 = ctypes.windll.kernel32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    if _wait_front(user32, hwnd, 0):
        return True
    user32.SetForegroundWindow(hwnd)
    if _wait_front(user32, hwnd, 0.12):
        return True
    _send([(VK["alt"], 0, 0)])
    try:
        user32.SetForegroundWindow(hwnd)
    finally:
        _send([(VK["alt"], 0, _KEYUP)])
    if _wait_front(user32, hwnd, 0.2):
        return True
    front = user32.GetForegroundWindow()
    theirs = user32.GetWindowThreadProcessId(front, None) if front else 0
    ours = kernel32.GetCurrentThreadId()
    attached = bool(theirs and theirs != ours and user32.AttachThreadInput(ours, theirs, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(ours, theirs, False)
    return _wait_front(user32, hwnd, 0.25)


def window_title(hwnd: int = 0) -> str:
    """Titel eines Fensters (ohne Angabe: des vorderen). Discord zeigt dort den offenen Chat."""
    try:
        ctypes, user32, _INPUT, _KB = _api()
        hwnd = hwnd or user32.GetForegroundWindow()
        if not hwnd:
            return ""
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        return buffer.value
    except Exception:
        return ""


def find_window(names, hint: str = "") -> int:
    """Das Hauptfenster eines laufenden Programms (z. B. Discord), auch minimiert. 0, wenn es
    keins gibt oder es nur im Infobereich neben der Uhr sitzt (dann ist es unsichtbar)."""
    try:
        ctypes, user32, _INPUT, _KB = _api()
        from ctypes import wintypes

        import psutil
    except Exception:
        return 0
    wanted = {str(n).lower() for n in names}
    names_of: dict[int, str] = {}
    found: list[tuple[bool, int, int]] = []

    def visit(hwnd, _param):
        try:
            if not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, 4):  # GW_OWNER: Dialoge
                return True
            if user32.GetWindowTextLengthW(hwnd) == 0:
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value not in names_of:
                try:
                    names_of[pid.value] = psutil.Process(pid.value).name().lower()
                except Exception:
                    names_of[pid.value] = ""
            if names_of[pid.value] in wanted:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
                titled = bool(hint) and hint.lower() in window_title(hwnd).lower()
                found.append((titled, area, int(hwnd)))
        except Exception:
            pass
        return True

    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(visit)
    user32.EnumWindows(callback, 0)
    return max(found)[2] if found else 0


# Tasten, die eine Nachricht verfälschen: Umschalt, Strg, Alt, Windows, Buchstaben, Ziffern, Leertaste,
# Enter, Rücktaste, Tab, Satzzeichen, Ziffernblock. Funktionstasten und Maustasten stören nicht.
_TYPING_KEYS = ([0x08, 0x09, 0x0D, 0x10, 0x11, 0x12, 0x20, 0x5B, 0x5C, 0xE2] + list(range(0x30, 0x3A))
                + list(range(0x41, 0x5B)) + list(range(0x60, 0x70)) + list(range(0xA0, 0xA6))
                + list(range(0xBA, 0xC1)) + list(range(0xDB, 0xE0)))


def keys_held() -> bool:
    """Hält Georg gerade eine Taste gedrückt (W zum Laufen, Umschalt zum Sprinten)?"""
    try:
        _ctypes, user32, _INPUT, _KB = _api()
        return any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in _TYPING_KEYS)
    except Exception:
        return False


def idle_seconds() -> float:
    """Wie lange Maus und Tastatur schon still sind. Unbekannt: sehr lange."""
    try:
        ctypes, user32, _INPUT, _KB = _api()
        from ctypes import wintypes

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 999.0
        kernel32 = ctypes.windll.kernel32
        kernel32.GetTickCount.restype = wintypes.DWORD
        return ((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000.0
    except Exception:
        return 999.0
