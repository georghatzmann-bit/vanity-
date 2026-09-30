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
    "viertelstunde": 900, "viertelstunden": 900,
    "stunde": 3600, "stunden": 3600, "std": 3600, "h": 3600,
    "tag": 86400, "tage": 86400, "tagen": 86400,
    "woche": 604800, "wochen": 604800,
}
_ONES = {"ein": 1, "zwei": 2, "zwo": 2, "drei": 3, "vier": 4, "fünf": 5, "sechs": 6, "sieben": 7, "acht": 8, "neun": 9}
_TENS = {"zwanzig": 20, "dreißig": 30, "dreissig": 30, "vierzig": 40, "fünfzig": 50}
_WORDS = {
    **_ONES, **_TENS, "eins": 1, "eine": 1, "einer": 1, "einem": 1, "einen": 1, "ner": 1,
    "zehn": 10, "elf": 11, "zwölf": 12, "dreizehn": 13, "vierzehn": 14, "fünfzehn": 15,
    "sechzehn": 16, "siebzehn": 17, "achtzehn": 18, "neunzehn": 19,
    "anderthalb": 1.5, "dreiviertel": 0.75,
}
# "einundzwanzig" bis "neunundfünfzig"
_WORDS.update({f"{one}und{ten}": a + b for one, a in _ONES.items() for ten, b in _TENS.items()})
_WEEKDAYS = ["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag"]
_EXAMPLES = (
    '"in 20 minuten", "in 1 stunde 30 minuten", "18:30", "um 8 uhr abends", '
    '"morgen um 8", "Montag um 9", "1.10. um 8", "2026-10-01 08:00"'
)


class WhenError(ValueError):
    pass


def _error(text: str, now: dt.datetime, reason: str = "Zeit nicht verstanden") -> WhenError:
    """Mit der aktuellen Zeit und Beispielen, damit Claude es gleich richtig machen kann."""
    return WhenError(
        f'{reason}: "{text.strip()}". Jetzt ist {_WEEKDAYS[now.weekday()].capitalize()}, '
        f"{now:%d.%m.%Y %H:%M} Uhr. Möglich sind z. B. {_EXAMPLES}."
    )


def parse_when(text: str, now: dt.datetime | None = None) -> dt.datetime:
    """Versteht "in 10 Minuten", "in anderthalb Stunden", "18:30", "um 18 Uhr",
    "halb acht", "morgen früh um 8", "Montag um 9", "1.10. um 8" und "2026-10-01 08:00"."""
    now = now or dt.datetime.now()
    raw = text.strip().lower()
    raw = re.sub(r"(\d),(\d)", r"\1.\2", raw)  # "1,5 Stunden"
    raw = re.sub(r"[\"'„“”»«!?,;]", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.sub(r"(?<=[a-zäöüß])\.$", "", raw)  # "in 10 Min."

    try:
        if re.match(r"\d{4}-\d{2}-\d{2}", raw):
            when = dt.datetime.fromisoformat(raw.replace(" ", "T"))
            if when <= now:
                raise _error(text, now, "Das liegt in der Vergangenheit")
            return when
        if raw.startswith("in "):
            return _relative(raw[3:], now, text)
        return _absolute(raw, now, text)
    except WhenError:
        raise
    except (ValueError, OverflowError) as exc:
        raise _error(text, now) from exc


def _number(word: str) -> float | None:
    if re.fullmatch(r"\d+(?:\.\d+)?", word):
        return float(word)
    if word.endswith("einhalb") and word[:-7] in _WORDS:  # "eineinhalb", "zweieinhalb"
        return _WORDS[word[:-7]] + 0.5
    return _WORDS.get(word)


def _relative(rest: str, now: dt.datetime, text: str) -> dt.datetime:
    """Alles nach "in": "2 Stunden und 30 Minuten", "einer Viertelstunde", "anderthalb Stunden"."""
    words = re.findall(r"\d+(?:\.\d+)?|[a-zäöüß]+|\S", rest)
    seconds, i = 0.0, 0
    while i < len(words):
        if words[i] == "und":
            i += 1
            continue
        amount = _number(words[i])
        i += 1
        if i < len(words) and words[i] in ("halbe", "halben", "viertel"):
            amount = amount and amount * (0.25 if words[i] == "viertel" else 0.5)
            i += 1
        if amount is None or i >= len(words) or words[i] not in _UNITS:
            raise _error(text, now)
        seconds += amount * _UNITS[words[i]]
        i += 1
    if seconds <= 0:
        raise _error(text, now)
    if seconds > 2 * 366 * 86400:
        raise _error(text, now, "Das ist zu weit weg")
    return now + dt.timedelta(seconds=seconds)


def _whole(word: str, top: int = 24) -> int | None:
    """Ganze Zahl von 0 bis `top`, als Ziffern oder Wort ("acht", "dreißig")."""
    value = _number(word)
    return int(value) if value is not None and value == int(value) and 0 <= value <= top else None


def _clock(raw: str) -> tuple[int, int, bool] | None:
    """Stunde, Minute und ob es auch 12 Stunden später gemeint sein kann ("um 8")."""
    raw = re.sub(r"^(?:um|gegen|ab) ", "", raw)
    match = re.fullmatch(r"(\d{1,2})(?:[:.](\d{2}))?(?: uhr)?(?: (\d{1,2}))?\.?", raw)
    if match:
        hour = int(match.group(1))
        # "08:00" ist eindeutig, "8:00" oder "um 8" nicht.
        return hour, int(match.group(2) or match.group(3) or 0), not match.group(1).startswith("0")
    match = re.fullmatch(r"(halb|dreiviertel) (\w+)(?: uhr)?", raw)  # "halb acht" = 7:30
    if match and _whole(match.group(2)):
        return (_whole(match.group(2)) - 1) or 12, 30 if match.group(1) == "halb" else 45, True
    match = re.fullmatch(r"(viertel|\w+) (nach|vor) (\w+)(?: uhr)?", raw)  # "viertel nach acht"
    if match and _whole(match.group(3)) is not None:
        minutes = 15 if match.group(1) == "viertel" else _whole(match.group(1), 59)
        hour = _whole(match.group(3))
        if minutes is None or not 0 < minutes < 30:
            return None
        if match.group(2) == "nach":
            return hour, minutes, True
        return (hour - 1) or 12, 60 - minutes, True
    match = re.fullmatch(r"([a-zäöüß]+)(?: uhr)?(?: ([a-zäöüß]+))?", raw)  # "acht uhr dreißig"
    if match and _whole(match.group(1)) is not None:
        minute = _whole(match.group(2), 59) if match.group(2) else 0
        return (_whole(match.group(1)), minute, True) if minute is not None else None
    return None


def _absolute(raw: str, now: dt.datetime, text: str) -> dt.datetime:
    day, explicit, weekday = now.date(), False, False
    date = re.match(r"(?:am )?(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?: |$)", raw)
    if date and 1 <= int(date.group(2)) <= 12:  # "1.10." oder "01.10.2026"
        year = int(date.group(3) or now.year)
        day = dt.date(year + 2000 if year < 100 else year, int(date.group(2)), int(date.group(1)))
        if not date.group(3) and day < now.date():
            day = day.replace(year=day.year + 1)
        explicit, raw = True, raw[date.end():]
    elif re.match(r"(heute|morgen|übermorgen)\b", raw):
        word = raw.split()[0]
        day += dt.timedelta(days={"heute": 0, "morgen": 1, "übermorgen": 2}[word])
        explicit, raw = True, raw[len(word):].strip()
        if word == "heute" and re.match(r"morgen\b", raw):  # "heute morgen" = heute früh
            raw = "früh" + raw[len("morgen"):]
    else:
        match = re.match(r"(?:(?:am|nächsten|nächster|nächste|kommenden|diesen) )*(" + "|".join(_WEEKDAYS) + r")\b", raw)
        if match:
            ahead = (_WEEKDAYS.index(match.group(1)) - now.weekday()) % 7
            if ahead == 0 and "nächst" in match.group(0):
                ahead = 7
            day += dt.timedelta(days=ahead)
            weekday, raw = True, raw[match.end():]

    # Tageszeit: "morgen früh um 8", "um 8 Uhr abends", "12 Uhr mittags"
    part = ""
    match = re.search(r"\b(?:in der |am )?(früh|morgens|vormittags?|mittags?|nachmittags?|abends?|nachts?)\b", raw)
    if match:
        part, raw = match.group(1), raw[: match.start()] + raw[match.end():]
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        raise _error(text, now, "Uhrzeit fehlt")
    clock = _clock(raw)
    if clock is None:
        raise _error(text, now)
    hour, minute, loose = clock
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise _error(text, now, "Keine gültige Uhrzeit")
    if part.startswith(("nachmittag", "abend")) and hour < 12:
        hour += 12
    elif part.startswith("mittag") and 1 <= hour <= 3:
        hour += 12
    elif part.startswith("nacht"):
        if hour == 12:
            hour = 0
        elif 6 <= hour < 12:
            hour += 12
        if hour < 6 and explicit and day == now.date():  # "heute Nacht um 2"
            day += dt.timedelta(days=1)

    when = dt.datetime.combine(day, dt.time(hour, minute))
    # "um 8" um 19:45 heißt 20 Uhr, außer es steht "früh" oder "morgens" dabei.
    if loose and 1 <= hour <= 12 and not part and day == now.date() and when <= now < when + dt.timedelta(hours=12):
        when += dt.timedelta(hours=12)
    if when <= now:
        if explicit:
            raise _error(text, now, "Das liegt in der Vergangenheit")
        when += dt.timedelta(days=7 if weekday else 1)
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
