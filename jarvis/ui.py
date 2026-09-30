"""Anzeigen: Konsole, Oberfläche oder beides. Alle Teile melden sich nur hierüber."""

from __future__ import annotations

import logging
import threading

log = logging.getLogger("jarvis")

STATES = ("idle", "listening", "thinking", "speaking", "muted", "error")


class Ui:
    """Stille Grundform. Konsole und Oberfläche überschreiben, was sie brauchen."""

    def state(self, value: str) -> None:
        pass

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        pass

    def level(self, value: float) -> None:
        pass

    def toast(self, text: str, kind: str = "info") -> None:
        pass

    def config(self, **values) -> None:
        pass

    def stats(self, cpu: float, ram: float) -> None:
        pass


class ConsoleUi(Ui):
    """Schreibt das Gespräch ins Konsolenfenster."""

    def __init__(self, idle_hint: str = "") -> None:
        self._last_state = ""
        self._lock = threading.Lock()
        # Im Sprachmodus: 'Sag "Hey Jarvis" ...', sobald Jarvis wieder bereit ist.
        self.idle_hint = idle_hint
        # Im Tippmodus steht "Du: ..." schon da, weil man es gerade getippt hat.
        self.show_user = True

    def state(self, value: str) -> None:
        if value == self._last_state:
            return
        previous, self._last_state = self._last_state, value
        if value == "listening":
            self._print("Ich höre ...")
        elif value == "idle" and previous in ("thinking", "speaking") and self.idle_hint:
            self._print(self.idle_hint)

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        if not final:
            return
        if role == "user":
            if self.show_user:
                self._print(f"\nDu: {text}")
        elif role == "jarvis":
            tag = f" [{model}]" if model else ""
            self._print(f"Jarvis{tag}: {text}")
        else:
            self._print(f"  ({text})")

    def toast(self, text: str, kind: str = "info") -> None:
        self._print(f"{'!! ' if kind == 'error' else ''}{text}")

    def _print(self, text: str) -> None:
        with self._lock:
            try:
                print(text, flush=True)
            except (OSError, ValueError, AttributeError):
                pass  # kein Konsolenfenster (z. B. Autostart ohne Fenster)


class MultiUi(Ui):
    """Reicht alles an mehrere Anzeigen weiter."""

    def __init__(self, *uis: Ui) -> None:
        self.uis = list(uis)

    def add(self, ui: Ui) -> None:
        self.uis.append(ui)

    def _each(self, name: str, *args, **kwargs) -> None:
        for ui in self.uis:
            try:
                getattr(ui, name)(*args, **kwargs)
            except Exception as exc:
                log.debug("Anzeige %s.%s fehlgeschlagen: %s", type(ui).__name__, name, exc)

    def state(self, value):
        self._each("state", value)

    def message(self, role, text, id=None, model="", final=True):
        self._each("message", role, text, id=id, model=model, final=final)

    def level(self, value):
        self._each("level", value)

    def toast(self, text, kind="info"):
        self._each("toast", text, kind)

    def config(self, **values):
        self._each("config", **values)

    def stats(self, cpu, ram):
        self._each("stats", cpu, ram)
