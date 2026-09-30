"""Erinnerungen: Claude legt sie mit `python -m jarvis.tool erinnern ...` an,
der laufende Jarvis spricht sie zur richtigen Zeit aus."""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

log = logging.getLogger(__name__)

_UNITS = {
    "sekunde": 1, "sekunden": 1, "sek": 1,
    "minute": 60, "minuten": 60, "min": 60,
    "stunde": 3600, "stunden": 3600, "std": 3600,
    "tag": 86400, "tage": 86400, "tagen": 86400,
}
_WORDS = {
    "einer": 1, "eine": 1, "einem": 1, "ein": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5,
    "sechs": 6, "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "fünfzehn": 15,
    "zwanzig": 20, "dreißig": 30, "vierzig": 40, "fünfzig": 50, "halben": 0.5, "halbe": 0.5,
}


class WhenError(ValueError):
    pass


def parse_when(text: str, now: dt.datetime | None = None) -> dt.datetime:
    """Versteht "in 10 Minuten", "in einer halben Stunde", "18:30", "um 18 Uhr",
    "morgen um 8", "morgen 07:15" und "2026-10-01 08:00"."""
    now = now or dt.datetime.now()
    raw = text.strip().lower().replace(",", ".")
    raw = re.sub(r"\s+", " ", raw)

    try:
        return dt.datetime.fromisoformat(raw.replace(" ", "T")) if re.match(r"\d{4}-\d{2}-\d{2}", raw) else _relative(raw, now)
    except WhenError:
        raise
    except ValueError as exc:
        raise WhenError(f"Zeit nicht verstanden: {text}") from exc


def _relative(raw: str, now: dt.datetime) -> dt.datetime:
    match = re.match(r"^in (?:(\d+(?:\.\d+)?)|(\w+))(?: (halbe[n]?))? (\w+)$", raw)
    if match:
        number, word, half, unit = match.groups()
        amount = float(number) if number else _WORDS.get(word)
        if amount is None or unit not in _UNITS:
            raise WhenError(f"Zeit nicht verstanden: {raw}")
        if half:
            amount *= 0.5
        return now + dt.timedelta(seconds=amount * _UNITS[unit])

    day = now.date()
    if raw.startswith("übermorgen"):
        day += dt.timedelta(days=2)
        raw = raw[len("übermorgen"):].strip()
    elif raw.startswith("morgen"):
        day += dt.timedelta(days=1)
        raw = raw[len("morgen"):].strip()
    elif raw.startswith("heute"):
        raw = raw[len("heute"):].strip()
    explicit_day = day != now.date()

    match = re.match(r"^(?:um )?(\d{1,2})(?:[:.](\d{2}))?(?: uhr)?(?: (\d{1,2}))?$", raw)
    if not match:
        raise WhenError(f"Zeit nicht verstanden: {raw}")
    hour = int(match.group(1))
    minute = int(match.group(2) or match.group(3) or 0)
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise WhenError(f"Keine gültige Uhrzeit: {raw}")
    when = dt.datetime.combine(day, dt.time(hour, minute))
    if when <= now and not explicit_day:
        when += dt.timedelta(days=1)
    return when


def spoken_when(when: dt.datetime, now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now()
    clock = f"{when.hour}:{when.minute:02d} Uhr"
    if when.date() == now.date():
        return f"heute um {clock}"
    if when.date() == now.date() + dt.timedelta(days=1):
        return f"morgen um {clock}"
    return f"am {when.day}.{when.month}. um {clock}"


class ReminderStore:
    """Liegt als JSON-Datei im Zustandsordner, damit Claude (anderer Prozess) und
    der laufende Jarvis dieselben Erinnerungen sehen."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def all(self) -> list[dict]:
        try:
            return self._read()
        except OSError:
            return []

    def _read(self) -> list[dict]:
        """Liest die Datei. Ist sie nur kurz gesperrt (Virenscanner, OneDrive, der andere
        Prozess schreibt gerade), wird es noch ein paar Mal versucht und sonst ein Fehler
        gemeldet, damit niemand eine leere Liste zurückschreibt."""
        try:
            raw = _retry(lambda: self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        try:
            data = json.loads(raw)
        except ValueError:
            log.warning("Erinnerungsdatei %s ist kaputt und wird neu angelegt.", self.path)
            return []
        if not isinstance(data, list):
            return []
        return [r for r in data if isinstance(r, dict) and "zeit" in r and "text" in r]

    def add(self, when: dt.datetime, text: str) -> dict:
        reminder = {"id": uuid.uuid4().hex[:8], "zeit": when.isoformat(timespec="seconds"), "text": text}
        with self._lock:
            items = self._read()
            items.append(reminder)
            self._write(items)
        return reminder

    def remove(self, ids: set[str]) -> None:
        with self._lock:
            # Frisch lesen, damit gerade neu angelegte Erinnerungen nicht verloren gehen.
            items = [r for r in self._read() if r.get("id") not in ids]
            self._write(items)

    def due(self, now: dt.datetime | None = None) -> list[dict]:
        now = now or dt.datetime.now()
        result = []
        for r in self.all():
            try:
                if dt.datetime.fromisoformat(r["zeit"]) <= now:
                    result.append(r)
            except ValueError:
                result.append(r)  # kaputter Eintrag: einmal ansagen und damit loswerden
        return result

    def upcoming(self, now: dt.datetime | None = None) -> list[dict]:
        now = now or dt.datetime.now()
        items = []
        for r in self.all():
            try:
                if dt.datetime.fromisoformat(r["zeit"]) > now:
                    items.append(r)
            except ValueError:
                continue
        return sorted(items, key=lambda r: r["zeit"])

    def _write(self, items: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Eigener Name pro Prozess: Jarvis und "python -m jarvis.tool" schreiben evtl. gleichzeitig.
        tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        try:
            _retry(lambda: os.replace(tmp, self.path))
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass


def _retry(action, attempts: int = 8, pause: float = 0.15):
    """Unter Windows sind Dateien manchmal für einen Moment gesperrt."""
    for attempt in range(attempts):
        try:
            return action()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(pause)
