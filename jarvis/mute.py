"""Stumm/Laut-Schalter: per Tastenkürzel oder Sprachbefehl das Mikrofon abschalten."""

from __future__ import annotations

import logging
import os
import re
import threading

log = logging.getLogger(__name__)

# Bewusst eng gefasst, damit "Mach den PC stumm" weiter an Claude geht.
MUTE_PHRASES = re.compile(
    r"\b(mikrofon aus|mikro aus|hör auf zuzuhören|nicht mehr zuhören|schlafmodus|geh schlafen)\b",
    re.I,
)


class MuteSwitch:
    def __init__(self) -> None:
        self._muted = threading.Event()
        self._unmuted = threading.Event()
        self._unmuted.set()
        self._listeners: list = []

    def on_change(self, callback) -> None:
        """`callback(muted)` wird bei jedem Umschalten aufgerufen (z. B. für die Oberfläche)."""
        self._listeners.append(callback)

    def _notify(self) -> None:
        for callback in self._listeners:
            try:
                callback(self.muted)
            except Exception as exc:
                log.debug("Stumm-Anzeige fehlgeschlagen: %s", exc)

    @property
    def muted(self) -> bool:
        return self._muted.is_set()

    def mute(self) -> None:
        self._unmuted.clear()
        self._muted.set()
        self._notify()

    def unmute(self) -> None:
        self._muted.clear()
        self._unmuted.set()
        self._notify()

    def toggle(self) -> None:
        if self.muted:
            self.unmute()
        else:
            self.mute()

    def wait_until_unmuted(self, timeout: float | None = None) -> bool:
        return self._unmuted.wait(timeout)


def register_hotkey(combo: str, callback) -> bool:
    """Registriert ein systemweites Tastenkürzel. Gibt False zurück, wenn das nicht geht.

    Unter Windows über RegisterHotKey: Das schluckt die Tasten (sonst tippt Strg+Alt+M auf
    deutscher Tastatur ein "µ" ins offene Programm) und fällt nicht still aus, wenn der
    PC gerade beschäftigt ist. Die keyboard-Bibliothek ist nur die Reserve.
    """
    if not combo:
        return False
    if os.name == "nt":
        parsed = parse_hotkey(combo)
        if parsed and _register_windows(*parsed, callback):
            return True
    try:
        import keyboard

        keyboard.add_hotkey(combo, callback)
        return True
    except Exception as exc:
        log.warning("Tastenkürzel %s konnte nicht eingerichtet werden (%s).", combo, exc)
        return False


_MODIFIERS = {
    "ctrl": 0x2, "strg": 0x2, "control": 0x2, "steuerung": 0x2,
    "alt": 0x1, "altgr": 0x3, "alt gr": 0x3,
    "shift": 0x4, "umschalt": 0x4, "win": 0x8, "windows": 0x8,
}
_KEYS = {
    "space": 0x20, "leertaste": 0x20, "pause": 0x13, "insert": 0x2D, "einfg": 0x2D,
    "home": 0x24, "pos1": 0x24, "end": 0x23, "ende": 0x23, "scroll lock": 0x91, "rollen": 0x91,
}


def parse_hotkey(combo: str) -> tuple[int, int] | None:
    """"ctrl+alt+m" -> (Modifier-Bits, virtueller Tastencode) für RegisterHotKey."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        return None
    modifiers, key = 0, parts[-1]
    for part in parts[:-1]:
        if part not in _MODIFIERS:
            return None
        modifiers |= _MODIFIERS[part]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return modifiers, ord(key.upper())
    if key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        return modifiers, 0x70 + int(key[1:]) - 1
    if key in _KEYS:
        return modifiers, _KEYS[key]
    return None


def _register_windows(modifiers: int, vk: int, callback) -> bool:
    import ctypes
    from ctypes import wintypes

    ready = threading.Event()
    ok: list[bool] = []

    def loop() -> None:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        MOD_NOREPEAT, WM_HOTKEY = 0x4000, 0x0312
        registered = bool(user32.RegisterHotKey(None, 1, modifiers | MOD_NOREPEAT, vk))
        if not registered:
            log.info("RegisterHotKey fehlgeschlagen (Fehler %s), nehme keyboard.", ctypes.get_last_error())
        ok.append(registered)
        ready.set()
        if not registered:
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY:
                threading.Thread(target=callback, name="jarvis-hotkey-aktion", daemon=True).start()

    threading.Thread(target=loop, name="jarvis-hotkey", daemon=True).start()
    ready.wait(3)
    return bool(ok and ok[0])
