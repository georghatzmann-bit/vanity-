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

    def stats(self, cpu: float, ram: float, gpu: dict | None = None) -> None:
        pass

    def progress(self, step: dict) -> None:
        """Ein Arbeitsschritt von Claude: begonnen (state "running") oder fertig ("done", "error").
        Felder: id, tool, label ("Installiert Spotify"), detail, kind, state, seconds."""
        pass

    def workshop(self, event: dict) -> None:
        """Die Werkstatt: state "start" (task, folder, logo), "text" (text), "logo" (logo: das Projekt-Logo
        als data:image/svg+xml), "done"/"error"/"cancelled" (summary, folder, seconds). Die Arbeitsschritte
        kommen als progress mit workshop=True."""
        pass

    def suggestion(self, offer: dict | None) -> None:
        """Ein Vorschlag aus Georgs Routinen (memory.Routine.as_dict), None = keiner mehr."""
        pass

    def action(self, kind: str) -> None:
        """Was Jarvis gerade tut ("music", "weather", "timer", ...): Die Kugel zeigt dazu eine
        eigene kurze Bewegung (orb.js, gesture)."""
        pass


class ConsoleUi(Ui):
    """Schreibt das Gespräch ins Konsolenfenster."""

    def __init__(self, idle_hint: str = "") -> None:
        self._last_state = ""
        self._last_line = ""
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
            if self._last_line != self.idle_hint:
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

    def progress(self, step: dict) -> None:
        if step.get("state") == "running" and step.get("label"):
            self._print(f"  … {step['label']}")

    def workshop(self, event: dict) -> None:
        state = event.get("state")
        if state == "start":
            self._print(f"[Werkstatt] {event.get('task', '')} -> {event.get('folder', '')}")
        elif state in ("done", "error", "cancelled"):
            self._print(f"[Werkstatt {state}] {event.get('summary', '')}")

    def _print(self, text: str) -> None:
        with self._lock:
            self._last_line = text
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

    def _each(self, method: str, /, *args, **kwargs) -> None:
        # "/": config(name="Georg") darf ein Feld "name" haben, ohne mit dem Methodennamen zu kollidieren
        for ui in self.uis:
            try:
                getattr(ui, method)(*args, **kwargs)
            except Exception as exc:
                log.debug("Anzeige %s.%s fehlgeschlagen: %s", type(ui).__name__, method, exc)

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

    def stats(self, cpu, ram, gpu=None):
        self._each("stats", cpu, ram, gpu)

    def progress(self, step):
        self._each("progress", step)

    def workshop(self, event):
        self._each("workshop", event)

    def suggestion(self, offer):
        self._each("suggestion", offer)

    def action(self, kind):
        self._each("action", kind)
