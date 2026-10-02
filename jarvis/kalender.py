"""Termine: eigene ("Trag morgen um 18 Uhr Training ein") und aus Georgs Kalender (Google, Outlook,
iCloud über die geheime iCal-Adresse, nur lesen).

Jarvis sagt kurz vorher Bescheid ("Sir, in 15 Minuten: Zahnarzt"), nennt die Termine im Briefing
und merkt, wenn sich im Kalender etwas ändert ("Ihr Termin morgen um 12 wurde abgesagt").
Eigene Termine liegen in daten/kalender.json, die Kalender-Abos werden alle 15 Minuten gelesen
und für unterwegs ohne Internet zwischengespeichert.

Ist Georgs iPhone verbunden (apple.py), ist der iPhone-Kalender die Quelle: Jarvis liest ihn alle
fünf Minuten, neue Termine landen im gewählten iPhone-Kalender, und "Lösch den Termin ..." löscht
dort. Ist iCloud gerade nicht erreichbar, merkt sich Jarvis den Termin und trägt ihn nach.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import re
import threading
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

FETCH_EVERY = 15 * 60  # Sekunden zwischen zwei Abrufen eines Kalender-Abos
WARN_MINUTES = 15  # so lange vorher sagt Jarvis Bescheid
WATCH_HOURS = 48  # Änderungen in diesem Zeitraum werden angesagt
MAX_OCCURRENCES = 400  # Schutz vor endlosen Wiederholungen
WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
_RRULE_DAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
# Outlook schreibt Windows-Namen statt IANA-Zonen
_WINDOWS_ZONES = {
    "w. europe standard time": "Europe/Berlin", "central europe standard time": "Europe/Budapest",
    "central european standard time": "Europe/Warsaw", "romance standard time": "Europe/Paris",
    "gmt standard time": "Europe/London", "greenwich standard time": "Atlantic/Reykjavik",
    "e. europe standard time": "Europe/Chisinau", "fle standard time": "Europe/Kiev",
    "utc": "UTC", "coordinated universal time": "UTC",
}


@dataclass
class Event:
    title: str
    start: dt.datetime
    end: dt.datetime
    all_day: bool = False
    place: str = ""
    uid: str = ""
    source: str = "jarvis"  # "jarvis" = selbst eingetragen, sonst der Name des Kalenders
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])

    @property
    def key(self) -> str:
        """Erkennt denselben Termin beim nächsten Abruf wieder (auch wenn er verschoben wurde)."""
        return f"{self.source}|{self.uid or self.title}|{self.start.date().isoformat() if self.uid else self.start.isoformat()}"

    def spoken(self, now: dt.datetime, with_day: bool = False) -> str:
        what = self.title + (f" ({self.place})" if self.place else "")
        if self.all_day:
            return f"{_day_word(self.start.date(), now.date()) + ': ' if with_day else ''}{what}"
        clock = _clock(self.start)
        day = (_day_word(self.start.date(), now.date()) + " ") if with_day else ""
        return f"{day}um {clock} {what}"

    def as_dict(self) -> dict:
        return {"id": self.id, "titel": self.title, "start": self.start.isoformat(timespec="minutes"),
                "ende": self.end.isoformat(timespec="minutes"), "ganztags": self.all_day, "ort": self.place,
                "quelle": self.source}


def _clock(when: dt.datetime) -> str:
    return f"{when.hour} Uhr" if when.minute == 0 else f"{when.hour}:{when.minute:02d}"


def _day_word(day: dt.date, today: dt.date) -> str:
    ahead = (day - today).days
    if ahead == 0:
        return "heute"
    if ahead == 1:
        return "morgen"
    if ahead == 2:
        return "übermorgen"
    if 0 < ahead < 7:
        return f"am {WEEKDAYS[day.weekday()]}"
    return f"am {day.day}.{day.month}."


# ---------------------------------------------------------------------- iCal lesen


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


def _unescape(value: str) -> str:
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _parse_line(line: str) -> tuple[str, dict, str]:
    """"DTSTART;TZID=Europe/Berlin:20261002T180000" -> ("DTSTART", {"TZID": "Europe/Berlin"}, "2026...")."""
    head, _, value = line.partition(":")
    # Ein Doppelpunkt in Anführungszeichen gehört zum Parameter (TZID="(UTC+01:00) Amsterdam")
    while head.count('"') % 2 and _:
        more, _, value = value.partition(":")
        head += ":" + more
    name, *params = head.split(";")
    data = {}
    for item in params:
        key, _, val = item.partition("=")
        data[key.upper()] = val.strip('"')
    return name.upper(), data, value


def _zone(name: str):
    if not name:
        return None
    from zoneinfo import ZoneInfo

    name = name.strip().strip('"')
    for candidate in (name, _WINDOWS_ZONES.get(name.lower(), "")):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate)
        except Exception:
            continue
    # "(UTC+01:00) Amsterdam, Berlin, ..." und Ähnliches: lieber Ortszeit als gar nichts
    return None


def _local(value: dt.datetime) -> dt.datetime:
    """In die Ortszeit dieses PCs, ohne Zeitzone (so rechnet Jarvis überall)."""
    if value.tzinfo is None:
        return value
    return value.astimezone().replace(tzinfo=None)


def _parse_time(value: str, params: dict) -> tuple[dt.datetime, bool]:
    """(Zeitpunkt in der Zone des Termins, ganztags?) Die Zone bleibt dran, umgerechnet wird später."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return dt.datetime.strptime(value[:8], "%Y%m%d"), True
    if value.endswith("Z"):
        return dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc), False
    when = dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    zone = _zone(params.get("TZID", ""))
    return (when.replace(tzinfo=zone) if zone else when), False


def _duration(value: str) -> dt.timedelta:
    found = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip())
    if not found:
        return dt.timedelta(0)
    sign = -1 if found.group(1) == "-" else 1
    weeks, days, hours, minutes, seconds = (int(x or 0) for x in found.groups()[1:])
    return sign * dt.timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes, seconds=seconds)


def _rrule(value: str) -> dict:
    return {k.upper(): v for k, _, v in (part.partition("=") for part in value.split(";")) if k}


def _occurrences(start: dt.datetime, rule: dict, until_window: dt.datetime) -> list[dt.datetime]:
    """Die Wiederholungen eines Termins (DAILY, WEEKLY mit BYDAY, MONTHLY, YEARLY), in seiner Zone."""
    freq = rule.get("FREQ", "")
    interval = max(1, int(rule.get("INTERVAL", "1") or 1))
    count = int(rule["COUNT"]) if rule.get("COUNT", "").isdigit() else None
    until = None
    if rule.get("UNTIL"):
        try:
            until, _ = _parse_time(rule["UNTIL"], {})
            if until.tzinfo is not None and start.tzinfo is not None:
                until = until.astimezone(start.tzinfo)
            until = until.replace(tzinfo=start.tzinfo)
            if len(rule["UNTIL"]) == 8:  # nur ein Datum: der ganze Tag zählt
                until += dt.timedelta(days=1) - dt.timedelta(seconds=1)
        except ValueError:
            until = None
    limit = until_window.replace(tzinfo=start.tzinfo) if until_window.tzinfo is None else until_window
    days = [_RRULE_DAYS[d[-2:]] for d in rule.get("BYDAY", "").split(",") if d[-2:] in _RRULE_DAYS]
    found: list[dt.datetime] = []
    produced = 0

    def take(when: dt.datetime) -> bool:
        nonlocal produced
        if when < start:
            return True
        if until is not None and when > until:
            return False
        if count is not None and produced >= count:
            return False
        produced += 1
        if when > limit:
            return False
        found.append(when)
        return len(found) < MAX_OCCURRENCES

    if freq == "DAILY":
        when = start
        while take(when):
            when += dt.timedelta(days=interval)
    elif freq == "WEEKLY":
        week = start - dt.timedelta(days=start.weekday())
        for _ in range(5000):
            for day in sorted(days or [start.weekday()]):
                if not take(week + dt.timedelta(days=day)):
                    return found
            week += dt.timedelta(weeks=interval)
    elif freq == "MONTHLY":
        month = 0
        for _ in range(2400):
            year, index = divmod(start.month - 1 + month, 12)
            try:
                when = start.replace(year=start.year + year, month=index + 1)
            except ValueError:  # der 31. im Juni: diesen Monat nicht
                month += interval
                continue
            if not take(when):
                break
            month += interval
    elif freq == "YEARLY":
        for year in range(0, 200, interval):
            try:
                when = start.replace(year=start.year + year)
            except ValueError:  # 29. Februar
                continue
            if not take(when):
                break
    else:
        take(start)
    return found


def parse_ics(text: str, source: str, start: dt.datetime, end: dt.datetime) -> list[Event]:
    """Alle Termine zwischen start und end (Ortszeit), mit Wiederholungen, Ausnahmen und Absagen."""
    blocks: list[list[tuple[str, dict, str]]] = []
    current: list | None = None
    nested = 0  # Erinnerungen (VALARM) im Termin haben eigene UID und Beschreibung: überspringen
    for line in _unfold(text):
        name, params, value = _parse_line(line)
        if name == "BEGIN" and value.upper() == "VEVENT":
            current, nested = [], 0
        elif name == "END" and value.upper() == "VEVENT" and not nested:
            if current is not None:
                blocks.append(current)
            current = None
        elif current is not None:
            if name == "BEGIN":
                nested += 1
            elif name == "END":
                nested = max(0, nested - 1)
            elif not nested:
                current.append((name, params, value))

    events: list[Event] = []
    overridden: set[tuple[str, dt.datetime]] = set()
    series = []
    for block in blocks:
        props: dict[str, tuple[dict, str]] = {}
        exdates: list[dt.datetime] = []
        for name, params, value in block:
            if name == "EXDATE":
                for part in value.split(","):
                    try:
                        exdates.append(_local(_parse_time(part, params)[0]))
                    except ValueError:
                        pass
            elif name not in props:
                props[name] = (params, value)
        if "DTSTART" not in props:
            continue
        try:
            begin, all_day = _parse_time(props["DTSTART"][1], props["DTSTART"][0])
            if "DTEND" in props:
                finish, _ = _parse_time(props["DTEND"][1], props["DTEND"][0])
            elif "DURATION" in props:
                finish = begin + _duration(props["DURATION"][1])
            else:
                finish = begin + (dt.timedelta(days=1) if all_day else dt.timedelta(0))
        except ValueError:
            continue
        uid = props.get("UID", ({}, ""))[1]
        cancelled = props.get("STATUS", ({}, ""))[1].upper() == "CANCELLED"
        if "RECURRENCE-ID" in props:  # eine geänderte (oder abgesagte) Einzelstunde einer Serie
            try:
                original, _ = _parse_time(props["RECURRENCE-ID"][1], props["RECURRENCE-ID"][0])
                overridden.add((uid, _local(original)))
            except ValueError:
                pass
        if cancelled:
            continue
        title = _unescape(props.get("SUMMARY", ({}, ""))[1]).strip() or "Termin"
        # Das iPhone schreibt die ganze Adresse in mehreren Zeilen: gesagt wird nur die erste
        place = (_unescape(props.get("LOCATION", ({}, ""))[1]).strip().splitlines() or [""])[0].strip()
        length = finish - begin
        rule = _rrule(props["RRULE"][1]) if "RRULE" in props and "RECURRENCE-ID" not in props else {}
        series.append((uid, begin, length, all_day, title, place, rule, exdates))

    for uid, begin, length, all_day, title, place, rule, exdates in series:
        window_end = end + dt.timedelta(days=1)
        if all_day:
            begin = begin.replace(tzinfo=None)
        times = _occurrences(begin, rule, window_end if begin.tzinfo is None else window_end.astimezone()) if rule else [begin]
        for when in times:
            local = when if all_day else _local(when)
            if local in exdates or (uid, local) in overridden and rule:
                continue
            stop = local + length
            if stop <= start or local >= end:
                if not (all_day and local.date() <= start.date() < stop.date()):
                    continue
            events.append(Event(title, local, stop, all_day, place, uid, source))
    return sorted(events, key=lambda e: (e.start, e.title))


# ---------------------------------------------------------------------- Der Kalender


class CalendarError(RuntimeError):
    """Ein Satz für Georg, warum es mit dem Kalender gerade nicht geht."""


class Calendar:
    def __init__(self, path: Path, feeds: list[str] | None = None, now=None, opener=None, apple=None) -> None:
        self._path = Path(path)
        self._feeds = [_feed_url(u) for u in (feeds or []) if _feed_url(u)]
        self._now = now or dt.datetime.now
        self._open = opener or urllib.request.urlopen
        self._lock = threading.RLock()
        self._fetched: dict[str, float] = {}
        self._texts: dict[str, str] = {}
        self._errors: dict[str, str] = {}
        self._known: dict[str, Event] | None = None  # Stand beim letzten Vergleich (Änderungen ansagen)
        self._known_sources: set[str] = set()  # welche Kalender dabei schon geladen waren
        self._warned: set[str] = set()
        # Georgs iPhone-Kalender (apple.ICloudCalendar), None = nicht verbunden
        self._apple = apple
        for url in self._feeds:  # der letzte Stand von der Platte: sofort da, auch ohne Internet
            try:
                self._texts[url] = self._cache(url).read_text(encoding="utf-8")
            except OSError:
                pass

    @property
    def apple(self):
        """Der iPhone-Kalender (apple.ICloudCalendar) oder None."""
        return self._apple

    def source_name(self, source: str) -> str:
        """So heißt die Quelle in Listen: "" für eigene Termine, der iPhone-Kalender beim Namen."""
        if source == "jarvis":
            return ""
        if source.startswith("icloud:") and self._apple is not None:
            return self._apple.name_of(source)
        return source

    # ---------------------------------------------------------- eigene Termine

    def _read(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _write(self, items: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_suffix(".tmp")
        temp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, self._path)

    def add(self, title: str, start: dt.datetime, end: dt.datetime | None = None, all_day: bool = False,
            place: str = "") -> Event:
        """Trägt einen Termin ein: ins iPhone, wenn verbunden, sonst bei Jarvis. Ist iCloud gerade nicht
        erreichbar, steht er erst einmal bei Jarvis und wird nachgetragen (refresh)."""
        title = " ".join(str(title).split()).strip(" .,")
        if not title:
            raise ValueError("Der Termin braucht einen Namen.")
        if end is None or end <= start:
            end = start + (dt.timedelta(days=1) if all_day else dt.timedelta(hours=1))
        title, place = title[:1].upper() + title[1:200], place.strip()[:120]
        pending = ""
        if self._apple is not None and self._apple.account is not None:
            from .apple import AppleError

            pending = str(uuid.uuid4()).upper()
            try:
                source, uid = self._apple.add(title, start, end, all_day, place, uid=pending)
                event = Event(title, start, end, all_day, place, uid, source)
                event.id = _stable_id(event)
                return event
            except AppleError as exc:
                log.info("iCloud: %s Der Termin steht erst einmal bei Jarvis und wird nachgetragen.", exc)
        event = Event(title, start, end, all_day, place)
        item = event.as_dict()
        if pending:
            item.update(icloud="offen", uid=pending)  # ins iPhone nachtragen, sobald iCloud erreichbar ist
        with self._lock:
            items = [i for i in self._read() if _still_relevant(i, self._now())]
            items.append(item)
            self._write(items)
        return event

    def remove(self, words: str) -> list[Event]:
        """Löscht den nächsten Termin, in dessen Namen alle Wörter vorkommen: eigene und, wenn verbunden,
        aus dem iPhone (bei einer Serie nur diesen einen). Klappt es mit iCloud nicht: CalendarError."""
        wanted = [w for w in re.findall(r"[\wäöüß]+", str(words).lower()) if len(w) > 1
                  and w not in {"den", "die", "das", "der", "termin", "mein", "meinen", "am", "um", "mit"}]
        if not wanted:
            return []
        now = self._now()
        phone = self._phone_match(wanted, now)
        with self._lock:
            items = self._read()
            gone = [i for i in items if all(w in str(i.get("titel", "")).lower() for w in wanted)
                    and _still_relevant(i, now)]
            if gone:
                gone.sort(key=lambda i: i.get("start", ""))
                first = gone[0]
                own = _from_dict(first)
                # Ein vergangener eigener Termin geht nur vor, wenn im iPhone nichts Passendes kommt.
                if phone is None or (own.end > now and own.start <= phone.start):
                    self._write([i for i in items if i is not first])
                    return [own]
        if phone is None:
            return []
        from .apple import AppleError

        try:
            self._apple.delete(phone.source, phone.uid, phone.start)
        except AppleError as exc:
            raise CalendarError(f"Den Termin konnte ich im iPhone nicht löschen, Sir. {exc}") from None
        return [phone]

    def _phone_match(self, wanted: list[str], now: dt.datetime) -> Event | None:
        """Der nächste Termin aus einem beschreibbaren iPhone-Kalender, der zu den Wörtern passt."""
        if self._apple is None or self._apple.account is None:
            return None
        found = []
        for event in self._apple_events(now - dt.timedelta(hours=1), now + dt.timedelta(days=366)):
            calendar = self._apple.calendar_of(event.source)
            if calendar is None or not calendar.get("schreibbar") or event.end <= now:
                continue
            if all(w in event.title.lower() for w in wanted):
                found.append(event)
        return min(found, key=lambda e: e.start) if found else None

    def not_found(self, words: str) -> str:
        """Der Satz, wenn "Lösch den Termin ..." nichts findet."""
        if self._apple is not None and self._apple.account is not None:
            return f"Einen Termin „{words}“ finde ich nicht, Sir. Termine aus Kalender-Abos ändern Sie bitte dort."
        return (f"Einen eigenen Termin „{words}“ finde ich nicht, Sir. Termine aus Ihrem Google- oder "
                "Outlook-Kalender ändern Sie bitte dort.")

    def own(self) -> list[Event]:
        return [_from_dict(i) for i in self._read() if i.get("start")]

    def _upload_pending(self) -> None:
        """Termine, die beim Eintragen nicht ins iPhone kamen (kein Internet), jetzt nachtragen."""
        if self._apple is None or not self._apple.writable:
            return
        from .apple import AppleError

        with self._lock:
            pending = [i for i in self._read() if i.get("icloud") == "offen" and _still_relevant(i, self._now())]
        for item in pending:
            event = _from_dict(item)
            try:
                self._apple.add(event.title, event.start, event.end, event.all_day, event.place,
                                uid=str(item.get("uid") or ""))
            except AppleError as exc:
                log.info("Nachtragen ins iPhone später: %s", exc)
                return
            with self._lock:
                self._write([i for i in self._read() if i.get("id") != item.get("id")])
            log.info("Ins iPhone nachgetragen: %s", event.title)

    # ---------------------------------------------------------- Kalender-Abos

    def refresh(self, force: bool = False) -> None:
        self._refresh_feeds(force)
        if self._apple is not None:
            try:
                self._apple.refresh(force)  # höchstens alle fünf Minuten, nur geänderte Kalender
                self._upload_pending()
            except Exception:
                log.exception("iPhone-Kalender")

    def _refresh_feeds(self, force: bool = False) -> None:
        import time

        for url in self._feeds:
            if not force and time.monotonic() - self._fetched.get(url, -1e9) < FETCH_EVERY:
                continue
            self._fetched[url] = time.monotonic()
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "Jarvis-Kalender"})
                with self._open(request, timeout=15) as response:
                    text = response.read(5_000_000).decode("utf-8", errors="replace")
                if "BEGIN:VCALENDAR" not in text:
                    raise ValueError("Das ist keine iCal-Adresse (es kam kein Kalender zurück).")
                self._texts[url] = text
                self._errors.pop(url, None)
                self._cache(url).write_text(text, encoding="utf-8")
            except Exception as exc:
                self._errors[url] = str(exc)[:200]
                log.info("Kalender %s: %s", _short(url), exc)
                if url not in self._texts:
                    try:
                        self._texts[url] = self._cache(url).read_text(encoding="utf-8")
                    except OSError:
                        pass

    def refresh_stale(self) -> None:
        """Nur abrufen, was älter als 15 Minuten ist (für kurze Aufrufe wie jarvis.tool).
        Den iPhone-Kalender, wenn sein Stand älter als fünf Minuten ist."""
        import time

        for url in self._feeds:
            try:
                age = time.time() - self._cache(url).stat().st_mtime
            except OSError:
                age = float("inf")
            if age >= FETCH_EVERY:
                self._fetched.pop(url, None)
        self._refresh_feeds()
        if self._apple is not None:
            try:
                self._apple.refresh_stale()
                self._upload_pending()
            except Exception:
                log.exception("iPhone-Kalender")

    def _cache(self, url: str) -> Path:
        name = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
        self._path.parent.mkdir(parents=True, exist_ok=True)
        return self._path.parent / f"kalender-abo-{name}.ics"

    @property
    def errors(self) -> dict[str, str]:
        """Adresse -> Fehler je Kalender-Abo, "icloud" -> Fehler beim iPhone-Kalender."""
        errors = dict(self._errors)
        if self._apple is not None and self._apple.error:
            errors["icloud"] = self._apple.error
        return errors

    # ---------------------------------------------------------- Abfragen

    def events(self, start: dt.datetime, end: dt.datetime) -> list[Event]:
        found = [e for e in self.own() if e.end > start and e.start < end]
        phone = self._apple_events(start, end)
        # Ist derselbe Kalender auch noch als Abo eingetragen, zählt der Termin aus dem iPhone.
        seen = {(e.uid, e.start) for e in phone if e.uid}
        for number, url in enumerate(self._feeds):
            text = self._texts.get(url)
            if text:
                try:
                    found += [e for e in parse_ics(text, f"kalender{number + 1}", start, end)
                              if (e.uid, e.start) not in seen]
                except Exception as exc:
                    log.warning("Kalender %s nicht lesbar: %s", _short(url), exc)
        return sorted(found + phone, key=lambda e: (e.start, e.title))

    def _apple_events(self, start: dt.datetime, end: dt.datetime) -> list[Event]:
        """Termine aus den iPhone-Kalendern (Zwischenspeicher, auch ohne Internet)."""
        if self._apple is None:
            return []
        found = []
        for source, text in self._apple.sources().items():
            try:
                for event in parse_ics(text, source, start, end):
                    event.id = _stable_id(event)
                    found.append(event)
            except Exception as exc:
                log.warning("iPhone-Kalender %s nicht lesbar: %s", source, exc)
        return found

    def day(self, day: dt.date) -> list[Event]:
        begin = dt.datetime.combine(day, dt.time())
        return self.events(begin, begin + dt.timedelta(days=1))

    def upcoming(self, hours: float = 24 * 7) -> list[Event]:
        now = self._now()
        return [e for e in self.events(now, now + dt.timedelta(hours=hours)) if e.all_day or e.start >= now - dt.timedelta(minutes=1)]

    def next_event(self) -> Event | None:
        timed = [e for e in self.upcoming(24 * 30) if not e.all_day]
        return timed[0] if timed else None

    # ---------------------------------------------------------- von selbst Bescheid sagen

    def due_warnings(self, minutes: int = WARN_MINUTES) -> list[Event]:
        """Termine, die in den nächsten `minutes` Minuten beginnen und noch nicht angesagt wurden."""
        now = self._now()
        due = []
        for event in self.events(now, now + dt.timedelta(minutes=minutes + 1)):
            if event.all_day or event.start < now - dt.timedelta(minutes=1):
                continue
            mark = f"{event.key}|{event.start.isoformat()}"
            if mark not in self._warned:
                self._warned.add(mark)
                due.append(event)
        return due

    def changes(self) -> list[str]:
        """Was sich in den Kalender-Abos seit dem letzten Blick geändert hat (nächste 48 Stunden)."""
        now = self._now()
        # Nur Kalender, die schon einmal geladen sind. Kommt einer erst später dazu (erster Abruf beim
        # Start), sind seine Termine nicht "neu", sondern einfach da.
        loaded = {f"kalender{number + 1}" for number, url in enumerate(self._feeds) if self._texts.get(url)}
        own: set[str] = set()
        if self._apple is not None:
            loaded |= set(self._apple.sources())
            own = self._apple.own_keys()  # was Jarvis selbst eingetragen oder gelöscht hat, ist keine Neuigkeit
        current = {e.key: e for e in self.events(now, now + dt.timedelta(hours=WATCH_HOURS)) if e.source in loaded}
        before, self._known = self._known, current
        sources, self._known_sources = self._known_sources, loaded
        if before is None:
            return []
        said = []
        for key, old in before.items():
            if old.start < now or old.source not in loaded or key in own:
                continue
            new = current.get(key)
            if new is None:
                # Ein Termin, der nur aus dem Zeitfenster gerutscht ist, wurde nicht abgesagt.
                if old.start < now + dt.timedelta(hours=WATCH_HOURS - 1):
                    said.append(f"Ihr Termin {old.spoken(now, with_day=True)} wurde abgesagt.")
            elif new.start != old.start:
                said.append(f"{old.title} wurde verschoben, jetzt {new.spoken(now, with_day=True).replace(new.title, '').strip()}.")
        for key, new in current.items():
            if new.source not in sources or key in own:
                continue
            if key not in before and new.start >= now and new.start - now > dt.timedelta(minutes=WARN_MINUTES):
                if new.start < now + dt.timedelta(hours=WATCH_HOURS - 1):
                    said.append(f"Neu im Kalender: {new.spoken(now, with_day=True)}.")
        return said[:5]

    # ---------------------------------------------------------- Sätze

    def describe_day(self, day: dt.date) -> str:
        now = self._now()
        events = [e for e in self.day(day) if day != now.date() or e.all_day or e.end > now]
        word = _day_word(day, now.date())
        word_cap = word[:1].upper() + word[1:]
        if not events:
            return f"{word_cap} steht nichts im Kalender, Sir." if day != now.date() else "Heute steht nichts mehr im Kalender, Sir."
        parts = [e.spoken(now) for e in events[:6]]
        joined = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " und " + parts[-1]
        count = "einen Termin" if len(events) == 1 else f"{len(events)} Termine"
        lead = "Heute haben Sie noch" if day == now.date() else f"{word_cap} haben Sie"
        return f"{lead} {count}, Sir: {joined}."

    def context(self) -> str:
        """Für Claude zu Beginn eines Gesprächs: Termine heute und morgen."""
        now = self._now()
        events = self.events(now, dt.datetime.combine(now.date() + dt.timedelta(days=2), dt.time()))
        if not events:
            return ""
        return "Termine heute und morgen: " + "; ".join(e.spoken(now, with_day=True) for e in events[:12]) + "."


def _from_dict(item: dict) -> Event:
    start = dt.datetime.fromisoformat(item["start"])
    end = dt.datetime.fromisoformat(item.get("ende") or item["start"])
    return Event(str(item.get("titel", "Termin")), start, end, bool(item.get("ganztags")), str(item.get("ort", "")),
                 "", "jarvis", str(item.get("id") or uuid.uuid4().hex[:8]))


def _stable_id(event: Event) -> str:
    """Termine aus dem iPhone behalten bei jedem Lesen dieselbe Kennung (wichtig für "Achtung, da ist schon ...")."""
    mark = f"{event.source}|{event.uid or event.title}|{event.start.isoformat()}"
    return hashlib.sha1(mark.encode("utf-8")).hexdigest()[:8]


def calendar_from_config(cfg: dict, state_dir: Path, account=None) -> Calendar:
    """Der Kalender wie eingestellt: eigene Termine, Abos und, wenn verbunden, Georgs iPhone."""
    from .apple import account_from_config, calendar_for

    if account is None:
        try:
            account = account_from_config(cfg, state_dir)
        except Exception as exc:
            log.warning("iCloud-Konto nicht lesbar: %s", exc)
    return Calendar(Path(state_dir) / "kalender.json", (cfg.get("kalender") or {}).get("abos", []),
                    apple=calendar_for(account, cfg, state_dir))


def _still_relevant(item: dict, now: dt.datetime) -> bool:
    """Eigene Termine, die länger als 30 Tage vorbei sind, räumt Jarvis weg."""
    try:
        return dt.datetime.fromisoformat(item.get("ende") or item["start"]) > now - dt.timedelta(days=30)
    except (KeyError, ValueError):
        return False


def _feed_url(url: str) -> str:
    url = str(url or "").strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    return url if url.lower().startswith("https://") else ""


def _short(url: str) -> str:
    return re.sub(r"(https://[^/]+/).*", r"\1…", url)


# ---------------------------------------------------------------------- Gesprochenes verstehen

_DAY_WORDS = r"(?:heute|morgen|übermorgen|(?:am\s+|nächsten\s+|kommenden\s+|diesen\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|am\s+\d{1,2}\.\s?\d{1,2}\.(?:\d{2,4})?)"
_ASK = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:"
    r"was\s+steht\s+(?P<a>" + _DAY_WORDS + r"|diese\s+woche)?\s*(?:noch\s+)?an"
    r"|was\s+(?:habe|hab)\s+ich\s+(?P<b>" + _DAY_WORDS + r"|diese\s+woche)?\s*(?:noch\s+)?(?:vor|für\s+termine)"
    r"|(?:welche|was\s+für)\s+termine\s+(?:habe|hab)\s+ich\s*(?P<c>" + _DAY_WORDS + r"|diese\s+woche)?(?:\s+noch)?"
    r"|(?:habe|hab)\s+ich\s+(?P<d>" + _DAY_WORDS + r")?\s*(?:noch\s+)?(?:einen\s+termin|termine|was\s+vor)"
    r"|wann\s+ist\s+mein\s+nächster\s+termin|was\s+ist\s+mein\s+nächster\s+termin"
    r"|(?:zeig|zeige|nenn|sag)\s+(?:mir\s+)?(?:meine|die)\s+termine(?:\s+(?P<e>" + _DAY_WORDS + r"|diese\s+woche))?"
    r")\s*[?.!]*$",
    re.I,
)
_ADD = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?"
    # "Schreib Max morgen an" heißt Max anschreiben: "an" nur bei "setz ... an" (ansetzen)
    r"(?:(?:trag|trage|schreib|schreibe)\s+(?:mir\s+|dir\s+|bitte\s+)*(?P<a>.+?)\s+(?:in\s+(?:den|meinen)\s+kalender\s+)?ein"
    r"|(?:setz|setze)\s+(?:mir\s+|dir\s+|bitte\s+)*(?P<s>.+?)\s+(?:in\s+(?:den|meinen)\s+kalender\s+)?(?:ein|an)"
    r"|(?:neuer|neuen)\s+termin\s*[:,]?\s*(?P<b>.+)"
    r"|termin\s*[:,]\s*(?P<c>.+))\s*[.!]*$",
    re.I,
)
_REMOVE = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?"
    r"(?:(?:lösch|lösche|streich|streiche|entferne|entfern)\s+(?:bitte\s+)?(?:den|meinen)\s+termin\s+(?P<a>.+?)"
    r"|(?:sag|sage)\s+(?:bitte\s+)?(?:den|meinen)\s+termin\s+(?P<b>.+?)\s+ab)\s*[.!]*$",
    re.I,
)
_CLOCK = r"\d{1,2}(?::\d{2}|\.\d{2})?"
_PART = r"(?:früh|morgens|vormittags?|mittags?|nachmittags?|abends?)(?![\wäöüß])"  # nicht "Frühstück"
_TIME = re.compile(
    r"(?P<when>(?:" + _DAY_WORDS + r"\s+)?(?:" + _PART + r"\s+)?(?:"
    # "von 18 bis 19 Uhr", "18-19 Uhr"
    r"(?:von\s+)?(?P<from>" + _CLOCK + r")\s*(?:uhr\s*)?(?:bis|-)\s*(?P<until>" + _CLOCK + r")\s*uhr"
    # "um 18 Uhr", "18:30", "um 8 Uhr abends", "um 18 Uhr bis 19:30"
    r"|(?:um\s+)?(?P<at>" + _CLOCK + r")\s*uhr(?:\s+" + _PART + r")?(?:\s*(?:bis|-)\s*(?P<until2>" + _CLOCK + r")\s*(?:uhr)?)?"
    r"|(?:um\s+)?(?P<at2>\d{1,2}:\d{2})(?:\s*(?:bis|-)\s*(?P<until3>" + _CLOCK + r")\s*(?:uhr)?)?"
    # "heute Abend um 8 Kino": "um" und eine Zahl ohne "Uhr"
    r"|um\s+(?P<at3>\d{1,2})(?![\d:.])(?:\s+" + _PART + r")?"
    r"))",
    re.I,
)
# Ganze Wörter: "Morgenrunde" und "Sonntagsbraten" sind kein Tag
_ALL_DAY = re.compile(r"(?<![\wäöüß])(?P<when>" + _DAY_WORDS + r")(?![\wäöüß])", re.I)
_FILL = re.compile(r"^(?:(?:einen|ein|den|meinen|termin|für|fürs|am|um|noch)\s+)+|(?:\s+(?:ein|an|termin|für))+$", re.I)


def _ask_day(word: str, now: dt.datetime) -> dt.date | None | str:
    word = " ".join(str(word or "").lower().split())
    if not word or word == "heute":
        return now.date()
    if word == "diese woche":
        return "woche"
    if word in ("morgen", "übermorgen"):
        return now.date() + dt.timedelta(days=1 if word == "morgen" else 2)
    date = re.search(r"(\d{1,2})\.\s?(\d{1,2})\.(\d{2,4})?", word)
    if date:
        year = int(date.group(3) or now.year)
        try:
            day = dt.date(year + 2000 if year < 100 else year, int(date.group(2)), int(date.group(1)))
        except ValueError:
            return None
        return day if date.group(3) or day >= now.date() else day.replace(year=day.year + 1)
    for index, name in enumerate(("montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag")):
        if name in word:
            ahead = (index - now.weekday()) % 7
            if ahead == 0 and "nächst" in word:
                ahead = 7
            return now.date() + dt.timedelta(days=ahead)
    return None


def parse_event(text: str, now: dt.datetime) -> tuple[str, dt.datetime, dt.datetime | None, bool] | None:
    """"morgen um 18 Uhr Training" -> ("Training", morgen 18:00, None, False). None = nicht sicher."""
    from .reminders import WhenError, parse_when

    text = " ".join(str(text).split()).strip(" .,!")
    found = _TIME.search(text)
    if found:
        whole = found.group("when")
        clock = (found.group("from") or found.group("at") or found.group("at2") or found.group("at3")).replace(".", ":")
        until = found.group("until") or found.group("until2") or found.group("until3")
        day = _ALL_DAY.search(whole)
        part = re.search(_PART, whole, re.I)
        rest = (text[: found.start()] + " " + text[found.end():]).strip()
        later_day = None if day else _ALL_DAY.search(rest)  # "um 20 Uhr heute Kino": der Tag steht dahinter
        later_part = None if part else re.search(r"\b" + _PART + r"\b", rest, re.I)
        when_day = day.group("when") if day else later_day.group("when") if later_day else ""
        when_part = part.group(0) if part else later_part.group(0) if later_part else ""
        phrase = " ".join(x for x in (when_day, f"um {clock} uhr", when_part) if x)
        try:
            start = parse_when(phrase, now)
        except WhenError:
            return None
        end = None
        if until:
            hour, _, minute = until.replace(".", ":").partition(":")
            try:
                end = start.replace(hour=int(hour), minute=int(minute or 0))
            except ValueError:
                end = None
            if end is not None and end <= start:
                end = end + dt.timedelta(hours=12) if end.hour < 12 and end + dt.timedelta(hours=12) > start else None
        title = rest
        for extra in (later_day, later_part):
            if extra is not None:
                title = title.replace(extra.group(0), " ", 1)
        all_day = False
    else:
        found = _ALL_DAY.search(text)
        if not found:
            return None
        day = _ask_day(found.group("when"), now)
        if not isinstance(day, dt.date):
            return None
        start, end, all_day = dt.datetime.combine(day, dt.time()), None, True
        title = (text[: found.start()] + " " + text[found.end():]).strip()
    title = _FILL.sub("", " ".join(title.split())).strip(" ,.:")
    title = _FILL.sub("", title).strip(" ,.:")
    if len(title) < 2 or re.fullmatch(r"(?:ein|an|einen termin|termin)", title, re.I):
        return None
    if re.match(r"(?:den\s+|einen\s+)?(?:wecker|timer|alarm|erinnerung)\b", title, re.I):
        return None  # "Setz morgen um 7 Uhr den Wecker an" ist kein Termin
    return title[:1].upper() + title[1:], start, end, all_day


def match_calendar(text: str, now: dt.datetime):
    """("ask", tag | "woche" | "next") / ("add", (titel, start, ende, ganztags)) / ("remove", wörter) / None"""
    raw = " ".join(str(text).split()).strip()
    found = _ASK.match(raw)
    if found:
        if re.search(r"nächster\s+termin", raw, re.I):
            return "ask", "next"
        word = next((g for g in found.groupdict().values() if g), "")
        day = _ask_day(word, now)
        return ("ask", day) if day is not None else None
    found = _REMOVE.match(raw)
    if found:
        return "remove", (found.group("a") or found.group("b") or "").strip(" .")
    found = _ADD.match(raw)
    if found:
        event = parse_event(found.group("a") or found.group("s") or found.group("b") or found.group("c") or "", now)
        if event is not None:
            return "add", event
    return None


def parse_slot(when: str, now: dt.datetime) -> tuple[dt.datetime, bool]:
    """"morgen um 18 Uhr", "Freitag 9:30", "2026-10-05 09:00" oder nur "Samstag" (ganztags)."""
    from .reminders import WhenError, parse_when

    try:
        return parse_when(when, now), False
    except WhenError:
        day = _ask_day(when, now)
        if isinstance(day, dt.date):
            return dt.datetime.combine(day, dt.time()), True
        raise
