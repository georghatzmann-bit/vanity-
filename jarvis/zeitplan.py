"""Zeitpläne: Befehle, die Jarvis regelmäßig von selbst erledigt.

"Jeden Morgen um 8 Uhr: Briefing", "Werktags um 18 Uhr öffne Discord und Spotify",
"Jeden Freitag um 20 Uhr: Zockmodus", "Täglich um 23 Uhr: Gute Nacht".

Zur Zeit führt Jarvis den Befehl aus, als hätte Georg ihn gesagt. Sitzt Georg nicht am PC, kommt
die Antwort aufs Handy. Läuft gerade ein Spiel im Vollbild, wartet Jarvis damit (bis zu einer
Stunde). War der PC zur Zeit aus, holt Jarvis es nach, wenn er innerhalb einer Stunde startet.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import threading
import uuid
from pathlib import Path

log = logging.getLogger(__name__)

LATE_MINUTES = 60  # so lange darf ein Zeitplan später kommen (PC war aus, Spiel lief)
MAX_SCHEDULES = 40
DAY_NAMES = ["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag"]
SPOKEN_DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
ALL_DAYS = list(range(7))
WORKDAYS = list(range(5))
WEEKEND = [5, 6]


def _days(word: str) -> tuple[list[int], str]:
    """("jeden morgen" -> alle Tage, "früh"), ("werktags" -> Mo-Fr, ""), ("montags" -> [0], "") ..."""
    word = " ".join(word.lower().split())
    if word in ("täglich", "jeden tag", "jeden morgen", "jeden abend", "jeden mittag", "jeden nachmittag", "jede nacht"):
        part = {"jeden morgen": "früh", "jeden abend": "abends", "jeden nachmittag": "nachmittags", "jede nacht": "nachts",
                "jeden mittag": "mittags"}.get(word, "")
        return ALL_DAYS, part
    if word in ("werktags", "an werktagen", "unter der woche", "montags bis freitags", "von montag bis freitag"):
        return WORKDAYS, ""
    if word in ("jedes wochenende", "an wochenenden", "wochenends", "samstags und sonntags"):
        return WEEKEND, ""
    days = []
    for index, name in enumerate(DAY_NAMES):
        if re.search(rf"\b{name}s?\b", word):
            days.append(index)
    return days, ""


def describe_days(days: list[int]) -> str:
    days = sorted(set(days))
    if days == ALL_DAYS:
        return "täglich"
    if days == WORKDAYS:
        return "werktags"
    if days == WEEKEND:
        return "am Wochenende"
    names = [SPOKEN_DAYS[d] + "s" for d in days]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


def describe(item: dict) -> str:
    hour, minute = (int(x) for x in item["uhrzeit"].split(":"))
    clock = f"{hour} Uhr" if minute == 0 else f"{hour}:{minute:02d} Uhr"
    return f"{describe_days(item['tage'])} um {clock}: {item['befehl']}"


class Schedules:
    def __init__(self, path: Path, now=None) -> None:
        self._path = Path(path)
        self._now = now or dt.datetime.now
        self._lock = threading.RLock()

    def _read(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return [i for i in data if isinstance(i, dict) and i.get("befehl")] if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _write(self, items: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_suffix(".tmp")
        temp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, self._path)

    def all(self) -> list[dict]:
        with self._lock:
            return sorted(self._read(), key=lambda i: (i["uhrzeit"], i["tage"]))

    def add(self, days: list[int], clock: dt.time, action: str) -> dict:
        action = " ".join(str(action).split()).strip(" ,.:")
        days = sorted({d for d in days if 0 <= d <= 6})
        if not days:
            raise ValueError("An welchen Tagen, Sir? Zum Beispiel: Werktags um 18 Uhr öffne Discord.")
        if len(action) < 2:
            raise ValueError("Was soll ich dann tun, Sir?")
        item = {"id": uuid.uuid4().hex[:6], "tage": days, "uhrzeit": f"{clock.hour:02d}:{clock.minute:02d}",
                "befehl": action[:1].upper() + action[1:300], "erledigt": ""}
        now = self._now()
        if now.time() >= clock and now.weekday() in days:
            item["erledigt"] = now.date().isoformat()  # heute ist die Zeit schon vorbei: ab morgen
        with self._lock:
            items = self._read()
            items = [i for i in items if not (i["uhrzeit"] == item["uhrzeit"] and i["tage"] == days
                                               and i["befehl"].lower() == item["befehl"].lower())]
            items.append(item)
            self._write(items[-MAX_SCHEDULES:])
        return item

    def remove(self, words: str) -> dict | None:
        """Löscht den Zeitplan, in dessen Befehl (oder Uhrzeit) die Wörter vorkommen."""
        wanted = [w for w in re.findall(r"[\wäöüß:]+", str(words).lower())
                  if w not in {"den", "die", "das", "der", "zeitplan", "mein", "meinen", "um", "uhr", "für"}]
        with self._lock:
            items = self._read()
            for item in items:
                text = f"{item['befehl']} {item['uhrzeit']} {describe(item)}".lower()
                if wanted and all(w in text for w in wanted):
                    items.remove(item)
                    self._write(items)
                    return item
        return None

    def due(self, now: dt.datetime | None = None, hold: bool = False) -> list[dict]:
        """Was jetzt dran ist (und als erledigt markiert wird). hold=True: gerade nicht stören
        (Spiel im Vollbild), dann bleibt es offen, solange es nicht zu spät ist."""
        now = now or self._now()
        found = []
        with self._lock:
            items = self._read()
            changed = False
            for item in items:
                hour, minute = (int(x) for x in item["uhrzeit"].split(":"))
                planned = dt.datetime.combine(now.date(), dt.time(hour, minute))
                if now.weekday() not in item["tage"] or now < planned or item.get("erledigt") == now.date().isoformat():
                    continue
                late = now - planned > dt.timedelta(minutes=LATE_MINUTES)
                if hold and not late:
                    continue
                item["erledigt"] = now.date().isoformat()
                changed = True
                if late:
                    log.info("Zeitplan verpasst (zu spät): %s", describe(item))
                    continue
                found.append(dict(item))
            if changed:
                self._write(items)
        return found


# ---------------------------------------------------------------------- Sätze

# Nur Wiederkehrendes: "jeden Freitag" und "freitags", aber nicht "(am) Freitag" (das ist ein Termin).
_WEEKDAY = r"(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)"
_DAY_PHRASE = (r"(?:jeden\s+(?:tag|morgen|abend|mittag|nachmittag)|jede\s+nacht|täglich|werktags|an\s+werktagen|"
               r"unter\s+der\s+woche|jedes\s+wochenende|an\s+wochenenden|wochenends|"
               r"(?:jeden\s+" + _WEEKDAY + r"|" + _WEEKDAY + r"s)"
               r"(?:\s*(?:,|und)\s*(?:jeden\s+" + _WEEKDAY + r"|" + _WEEKDAY + r"s))*)")
_SCHEDULE = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?(?:ab\s+jetzt\s+)?"
    r"(?P<days>" + _DAY_PHRASE + r")\s+(?:(?P<part1>früh|morgens|abends|nachmittags)\s+)?um\s+"
    r"(?P<clock>\d{1,2}(?:[:.]\d{2})?)\s*(?:uhr)?(?:\s+(?P<part2>früh|morgens|vormittags|mittags|abends|nachmittags|nachts))?"
    r"\s*[:,]?\s+(?:(?:sollst|kannst|könntest|würdest)\s+du\s+|(?:möchte|will)\s+ich,?\s+(?:dass\s+du\s+)?)?(?P<action>.{2,})$",
    re.I,
)
_LIST = re.compile(r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:welche|was\s+für)\s+zeitpläne\s+(?:habe|hab)\s+ich"
                   r"|^(?:zeig|zeige|nenn)\s+(?:mir\s+)?(?:meine|die)\s+zeitpläne|^was\s+sind\s+meine\s+zeitpläne", re.I)
_REMOVE = re.compile(r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?(?:lösch|lösche|streich|streiche|entferne|entfern)"
                     r"\s+(?:bitte\s+)?(?:den|meinen)\s+zeitplan\s+(?P<words>.+?)\s*[.!]*$", re.I)


def parse_schedule(text: str):
    """(tage, uhrzeit, befehl) oder None."""
    found = _SCHEDULE.match(" ".join(str(text).split()).strip())
    if not found:
        return None
    days, part = _days(found.group("days"))
    part = (found.group("part1") or found.group("part2") or part or "").lower()
    clock = found.group("clock").replace(".", ":")
    hour, _, minute = clock.partition(":")
    hour, minute = int(hour), int(minute or 0)
    if part.startswith(("abend", "nachmittag")) and hour < 12:
        hour += 12
    if part.startswith("nacht") and hour == 12:
        hour = 0
    if not (0 <= hour < 24 and 0 <= minute < 60) or not days:
        return None
    action = found.group("action").strip(" .!")
    if action.endswith("?") or len(action) < 2 or _STATEMENT.match(action):
        return None
    return days, dt.time(hour, minute), action


# "Freitags um 20 Uhr spiele ich Fußball", "Jeden Montag um 9 ist Meeting": Georg erzählt etwas, das ist
# kein Befehl für Jarvis (sonst schickte Jarvis jede Woche "spiele ich Fußball" los). Das bekommt Claude.
_STATEMENT = re.compile(r"^(?:[\wäöüß]+\s+(?:ich|wir|du|er|man)\b|(?:ist|sind|war|waren|hat|haben|gibt)\b)", re.I)


def match_schedule(text: str):
    """("add", (tage, uhrzeit, befehl)) / ("list", "") / ("remove", wörter) / None"""
    raw = " ".join(str(text).split()).strip(" ?!.")
    if _LIST.match(raw):
        return "list", ""
    found = _REMOVE.match(raw)
    if found:
        return "remove", found.group("words")
    parsed = parse_schedule(text)
    return ("add", parsed) if parsed else None
