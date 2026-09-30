"""Stumm/Laut-Schalter: per Tastenkürzel oder Sprachbefehl das Mikrofon abschalten."""

from __future__ import annotations

import logging
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
    """Registriert ein systemweites Tastenkürzel. Gibt False zurück, wenn das nicht geht."""
    if not combo:
        return False
    try:
        import keyboard

        keyboard.add_hotkey(combo, callback)
        return True
    except Exception as exc:
        log.warning("Tastenkürzel %s konnte nicht eingerichtet werden (%s).", combo, exc)
        return False
