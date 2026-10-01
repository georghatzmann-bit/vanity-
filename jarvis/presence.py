"""Hintergrund-Modus: Jarvis ist unsichtbar da und kommt, wenn man ihn ruft.

Beim Weckwort (oder Strg+Alt+J) erscheint das Jarvis-Fenster ganz vorn, ohne Georg die
Tastatur wegzunehmen. Ist das Gespräch vorbei, verschwindet es nach ein paar Sekunden
wieder, wenn es von selbst gekommen ist. Klickt Georg hinein, bleibt es offen. Beim
Spielen (Gaming-Modus, Vollbild) bleibt es ganz weg, und während die Werkstatt arbeitet,
bleibt es stehen, damit man zusehen kann.
"""

from __future__ import annotations

import logging
import threading

from .ui import Ui

log = logging.getLogger(__name__)


class Presence(Ui):
    HIDE_AFTER = 6.0

    def __init__(self, window, suppressed=None, keep_open=None) -> None:
        self._window = window
        self._suppressed = suppressed or (lambda: False)
        self._keep_open = keep_open or (lambda: False)
        self._auto = False  # von selbst erschienen (dann verschwindet es auch von selbst)
        self._state = "idle"
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    @property
    def auto(self) -> bool:
        return self._auto

    def state(self, value: str) -> None:
        with self._lock:
            self._state = value
            if value in ("listening", "thinking", "speaking"):
                self._cancel()
                if value == "listening" and self._window.hidden and not self._blocked():
                    try:
                        self._window.show_quiet()
                        self._auto = True
                    except Exception as exc:
                        log.debug("Fenster beim Weckwort: %s", exc)
            elif self._auto:
                self._schedule()

    def keep(self) -> None:
        """Georg hat das Fenster angefasst oder selbst geöffnet: nicht mehr von selbst verstecken."""
        with self._lock:
            self._auto = False
            self._cancel()
        try:
            self._window.settle()
        except Exception:
            pass

    def _blocked(self) -> bool:
        try:
            return bool(self._suppressed())
        except Exception:
            return False

    def _cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _schedule(self) -> None:
        self._cancel()
        self._timer = threading.Timer(self.HIDE_AFTER, self._hide_if_quiet)
        self._timer.daemon = True
        self._timer.start()

    def _hide_if_quiet(self) -> None:
        with self._lock:
            self._timer = None
            if not self._auto or self._state in ("listening", "thinking", "speaking"):
                return
            if self._keep_open():
                self._schedule()  # z. B. die Werkstatt arbeitet noch: später nochmal schauen
                return
            self._auto = False
        try:
            self._window.hide()
        except Exception as exc:
            log.debug("Fenster nach dem Gespräch verstecken: %s", exc)
