"""Jarvis' Gedächtnis: Er lernt Georg von Tag zu Tag besser kennen.

- Fakten: was Georg ihm sagt ("Merk dir, dass ich gern Rock höre") und was Jarvis jede
  Nacht aus den Gesprächen des Tages lernt (Tagesrückblick, siehe `digest_prompt`).
- Kontakte: mit wem Georg über welche App schreibt ("Schreib Max ..." nimmt dann gleich
  die richtige App).
- Gewohnheiten: wann Georg welche Programme und Seiten öffnet. Nach ein paar Tagen erkennt
  Jarvis daraus Routinen ("werktags gegen 18 Uhr Discord und Spotify") und bietet sie zur
  passenden Zeit an. Sagt Georg nein, fragt er seltener, bei "nie" gar nicht mehr.

Das Gehirn bekommt zu Beginn jeder Unterhaltung eine kurze Zusammenfassung (`context`).
Alles bleibt auf dem PC, in daten/gedaechtnis.json.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import statistics
import threading
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# Diese Aktionen zählen für Routinen (Programme und Webseiten öffnen)
ROUTINE_KINDS = {"open", "web"}
KEEP_DAYS = 60  # so lange bleiben Gewohnheiten gespeichert
SAID_DAYS = 3  # Gesagtes nur für den Tagesrückblick, danach weg
MAX_EVENTS = 5000
MAX_FACTS = 200
ROUTINE_DAYS = 21  # Routinen aus den letzten drei Wochen
MIN_DAYS = 3  # ab so vielen Tagen ist es eine Gewohnheit
SPREAD = 60  # Minuten: so nah müssen die Uhrzeiten beieinander liegen
WEEKDAY_NAMES = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]


def _key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\wäöüß ]+", " ", str(text).lower())).strip()


def _minutes(when: dt.datetime) -> int:
    return when.hour * 60 + when.minute


def _clock(minutes: int) -> str:
    return f"{minutes // 60}:{minutes % 60:02d}"


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


@dataclass
class Routine:
    """Eine Gewohnheit: diese Aktionen ungefähr um diese Zeit an diesen Tagen."""

    actions: list[tuple[str, str]]  # (art, Anzeigename), z. B. ("open", "Spotify")
    minute: int  # typische Uhrzeit, Minuten nach Mitternacht
    days: str  # "werktags", "am Wochenende" oder "täglich"
    count: int  # an so vielen Tagen beobachtet
    keys: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return "+".join(sorted(self.keys)) + "|" + self.days

    @property
    def clock(self) -> str:
        return _clock(self.minute)

    @property
    def label(self) -> str:
        return _join([name for _kind, name in self.actions])

    def fits(self, day: dt.date) -> bool:
        weekend = day.weekday() >= 5
        return self.days == "täglich" or (self.days == "am Wochenende") == weekend

    def question(self) -> str:
        return f"Sir, um diese Zeit öffnen Sie meist {self.label}. Soll ich?"

    def commands(self) -> list[str]:
        return [f"Öffne {name}" for _kind, name in self.actions]

    def describe(self) -> str:
        return f"{self.days} gegen {self.clock} Uhr: {self.label}"

    def as_dict(self) -> dict:
        return {"key": self.key, "label": self.label, "uhrzeit": self.clock, "tage": self.days,
                "anzahl": self.count, "befehle": self.commands(), "frage": self.question()}


class Memory:
    def __init__(self, path: Path, now=None) -> None:
        self._path = Path(path)
        self._now = now or dt.datetime.now
        self._lock = threading.RLock()
        self._data: dict | None = None
        self._stamp = 0  # Änderungszeit der Datei beim letzten Lesen oder Schreiben

    def _file_stamp(self) -> int:
        try:
            return self._path.stat().st_mtime_ns
        except OSError:
            return 0

    # ------------------------------------------------------------------ Speichern

    def _load(self) -> dict:
        if self._data is not None and self._file_stamp() != self._stamp:
            self._data = None  # jarvis.tool (das Gehirn) hat etwas dazugeschrieben
        if self._data is None:
            self._stamp = self._file_stamp()
            data: dict = {}
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                pass
            except (OSError, ValueError) as exc:
                log.warning("Gedächtnis nicht lesbar (%s), fange neu an.", exc)
            if not isinstance(data, dict):
                data = {}
            for name, empty in (("fakten", []), ("kontakte", {}), ("ereignisse", []), ("vorschlaege", {})):
                if not isinstance(data.get(name), type(empty)):
                    data[name] = empty
            self._data = data
        return self._data

    def _save(self) -> None:
        data = self._load()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temp = self._path.with_suffix(".tmp")
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temp, self._path)
            self._stamp = self._file_stamp()
        except OSError as exc:
            log.warning("Gedächtnis nicht gespeichert: %s", exc)

    # ------------------------------------------------------------------ Fakten

    def remember(self, text: str, source: str = "georg") -> str:
        """Speichert einen Fakt. Ähnliches wird ersetzt statt doppelt gespeichert."""
        fact = " ".join(str(text).split()).strip(" .,;:")
        if len(fact) < 3:
            return ""
        fact = fact[:1].upper() + fact[1:]
        with self._lock:
            facts = self._load()["fakten"]
            wanted = _key(fact)
            stamp = self._now().isoformat(timespec="minutes")
            for known in facts:
                if _key(known.get("text", "")) == wanted:
                    known["seit"] = stamp  # schon bekannt: nur auffrischen
                    self._save()
                    return known["text"]
            # Ein genauerer Fakt ersetzt einen kürzeren, der ganz in ihm steckt
            facts[:] = [f for f in facts if not (len(_key(f.get("text", ""))) > 8 and _key(f.get("text", "")) in wanted)]
            facts.append({"text": fact[:300], "seit": stamp, "quelle": source})
            del facts[:-MAX_FACTS]
            self._save()
        return fact

    def forget(self, text: str) -> int:
        """Vergisst Fakten, in denen die Wörter vorkommen ("Vergiss das mit der Pizza")."""
        words = [w for w in _key(text).split() if len(w) > 3 and w not in {"dass", "das", "mit", "der", "die", "den", "über"}]
        if not words:
            return 0
        with self._lock:
            facts = self._load()["fakten"]
            keep = [f for f in facts if not all(w in _key(f.get("text", "")) for w in words)]
            removed = len(facts) - len(keep)
            if removed:
                facts[:] = keep
                self._save()
        return removed

    def remove(self, text: str) -> bool:
        """Löscht genau diesen Fakt (Knopf in der Gedächtnis-Ansicht)."""
        with self._lock:
            facts = self._load()["fakten"]
            keep = [f for f in facts if f.get("text") != text]
            if len(keep) == len(facts):
                return False
            facts[:] = keep
            self._save()
        return True

    def forget_all(self) -> None:
        with self._lock:
            self._data = {"fakten": [], "kontakte": {}, "ereignisse": [], "vorschlaege": {}}
            self._save()

    def facts(self) -> list[dict]:
        with self._lock:
            return list(self._load()["fakten"])

    # ------------------------------------------------------------------ Gewohnheiten und Kontakte

    def record(self, kind: str, what: str, **data) -> None:
        """Merkt sich eine Aktion: ("open", "Spotify"), ("message", "Max", app="discord"), ("said", "...")."""
        what = " ".join(str(what).split())[:300]
        if not what:
            return
        now = self._now()
        with self._lock:
            memory = self._load()
            memory["ereignisse"].append({"t": now.isoformat(timespec="minutes"), "art": kind, "was": what,
                                         **({"app": data["app"]} if data.get("app") else {})})
            if kind == "message" and not what.startswith("#"):
                contact = memory["kontakte"].setdefault(_key(what), {"name": what, "anzahl": 0})
                contact.update(name=what, app=data.get("app") or contact.get("app", ""),
                               zuletzt=now.isoformat(timespec="minutes"))
                contact["anzahl"] = int(contact.get("anzahl", 0)) + 1
            self._prune(now)
            self._save()

    def _prune(self, now: dt.datetime) -> None:
        events = self._load()["ereignisse"]
        oldest = (now - dt.timedelta(days=KEEP_DAYS)).isoformat(timespec="minutes")
        said_oldest = (now - dt.timedelta(days=SAID_DAYS)).isoformat(timespec="minutes")
        events[:] = [e for e in events if e.get("t", "") >= (said_oldest if e.get("art") == "said" else oldest)]
        del events[:-MAX_EVENTS]

    def contact_app(self, person: str) -> str:
        with self._lock:
            contact = self._load()["kontakte"].get(_key(person))
            return str(contact.get("app", "")) if contact else ""

    def contacts(self) -> list[dict]:
        with self._lock:
            items = list(self._load()["kontakte"].values())
        return sorted(items, key=lambda c: -int(c.get("anzahl", 0)))

    def events(self, kind: str | None = None, since: dt.datetime | None = None) -> list[dict]:
        with self._lock:
            items = list(self._load()["ereignisse"])
        start = since.isoformat(timespec="minutes") if since else ""
        return [e for e in items if (kind is None or e.get("art") == kind) and e.get("t", "") >= start]

    # ------------------------------------------------------------------ Routinen

    def routines(self, now: dt.datetime | None = None) -> list[Routine]:
        """Gewohnheiten der letzten drei Wochen: dieselbe Aktion an mindestens drei Tagen
        ungefähr zur selben Zeit. Was zur selben Zeit passiert, wird ein Vorschlag."""
        now = now or self._now()
        start = now - dt.timedelta(days=ROUTINE_DAYS)
        firsts: dict[tuple[str, str], dict[dt.date, int]] = {}
        names: dict[tuple[str, str], str] = {}
        for event in self.events(since=start):
            if event.get("art") not in ROUTINE_KINDS:
                continue
            try:
                when = dt.datetime.fromisoformat(event["t"])
            except (KeyError, ValueError):
                continue
            ident = (event["art"], _key(event["was"]))
            names[ident] = event["was"]
            day = firsts.setdefault(ident, {})
            day[when.date()] = min(day.get(when.date(), 24 * 60), _minutes(when))
        found: list[Routine] = []
        for ident, days in firsts.items():
            if len(days) < MIN_DAYS:
                continue
            middle = statistics.median(days.values())
            close = {d: m for d, m in days.items() if abs(m - middle) <= SPREAD}
            if len(close) < MIN_DAYS or len(close) < 0.6 * len(days):
                continue
            weekend = sum(1 for d in close if d.weekday() >= 5)
            if weekend == 0 and len(close) >= MIN_DAYS:
                when = "werktags"
            elif weekend == len(close):
                when = "am Wochenende"
            else:
                when = "täglich"
            found.append(Routine([(ident[0], names[ident])], int(statistics.mean(close.values())), when, len(close),
                                 [f"{ident[0]}:{ident[1]}"]))
        # Was ungefähr zur selben Zeit an denselben Tagen passiert, wird ein Vorschlag
        found.sort(key=lambda r: (r.days, r.minute))
        merged: list[Routine] = []
        for routine in found:
            last = merged[-1] if merged else None
            if last and last.days == routine.days and abs(routine.minute - last.minute) <= 20 and len(last.actions) < 4:
                last.actions += routine.actions
                last.keys += routine.keys
                last.minute = (last.minute + routine.minute) // 2
                last.count = min(last.count, routine.count)
            else:
                merged.append(routine)
        return merged

    def _done_today(self, routine: Routine, now: dt.datetime) -> bool:
        today = dt.datetime.combine(now.date(), dt.time())
        wanted = set(routine.keys)
        return any(f"{e.get('art')}:{_key(e.get('was', ''))}" in wanted for e in self.events(since=today))

    def due(self, now: dt.datetime | None = None) -> Routine | None:
        """Die Routine, die gerade dran ist und noch nicht erledigt oder abgelehnt wurde."""
        now = now or self._now()
        with self._lock:
            answers = self._load()["vorschlaege"]
        for routine in self.routines(now):
            if not routine.fits(now.date()):
                continue
            if not (routine.minute - 5 <= _minutes(now) <= routine.minute + 25):
                continue
            state = answers.get(routine.key, {})
            if state.get("nie") or state.get("angeboten") == now.date().isoformat():
                continue
            if int(state.get("nein", 0)) >= 3 and int(state.get("nein", 0)) > 2 * int(state.get("ja", 0)):
                continue  # meistens abgelehnt: nicht mehr fragen
            if self._done_today(routine, now):
                continue
            return routine
        return None

    def offered(self, routine: Routine, now: dt.datetime | None = None) -> None:
        now = now or self._now()
        with self._lock:
            state = self._load()["vorschlaege"].setdefault(routine.key, {})
            state["angeboten"] = now.date().isoformat()
            state["label"] = routine.label
            self._save()

    def feedback(self, key: str, answer: str) -> None:
        """answer: "ja", "nein" oder "nie"."""
        with self._lock:
            state = self._load()["vorschlaege"].setdefault(key, {})
            if answer == "nie":
                state["nie"] = True
            else:
                state[answer] = int(state.get(answer, 0)) + 1
            self._save()

    # ------------------------------------------------------------------ für das Gehirn

    def context(self, now: dt.datetime | None = None) -> str:
        """Kurze Zusammenfassung für den Anfang einer Unterhaltung. Leer, wenn Jarvis noch nichts weiß."""
        now = now or self._now()
        lines = []
        facts = self.facts()[-40:]
        if facts:
            lines.append("Was du über Georg weißt (aus früheren Gesprächen):")
            lines += [f"- {f['text']}" for f in facts]
        contacts = [c for c in self.contacts()[:10] if c.get("app")]
        if contacts:
            lines.append("Mit wem Georg schreibt: " + ", ".join(f"{c['name']} ({c['app']})" for c in contacts) + ".")
        routines = self.routines(now)[:8]
        if routines:
            lines.append("Georgs Gewohnheiten: " + "; ".join(r.describe() for r in routines) + ".")
        if not lines:
            return ""
        lines.append("Nutze das unaufdringlich. Erfährst du etwas Neues, das auch morgen noch wichtig ist "
                     "(Vorlieben, Projekte, Namen, Termine), merk es dir mit: python -m jarvis.tool merken \"<fakt>\".")
        return "\n".join(lines)

    # ------------------------------------------------------------------ Tagesrückblick

    def digest_due(self, now: dt.datetime | None = None) -> dt.date | None:
        """Der Tag, aus dem Jarvis noch lernen soll (gestern oder früher), sonst None."""
        now = now or self._now()
        with self._lock:
            done = str(self._load().get("rueckblick", ""))
        yesterday = now.date() - dt.timedelta(days=1)
        if done >= yesterday.isoformat():
            return None
        said = [e for e in self.events("said") if e.get("t", "")[:10] <= yesterday.isoformat()
                and e.get("t", "")[:10] > done]
        if len(said) < 5:
            if done < yesterday.isoformat() and not said:
                self.mark_digest(yesterday)  # nichts zu lernen: nicht jedes Mal neu prüfen
            return None
        return yesterday

    def digest_prompt(self, day: dt.date) -> str:
        with self._lock:
            done = str(self._load().get("rueckblick", ""))
        said = [e["was"] for e in self.events("said") if done < e.get("t", "")[:10] <= day.isoformat()][-150:]
        known = "\n".join(f"- {f['text']}" for f in self.facts()[-60:]) or "- (noch nichts)"
        return (
            "Du bist das Gedächtnis von Jarvis, Georgs persönlichem Assistenten. Hier ist, was Georg zuletzt zu "
            "Jarvis gesagt hat, eine Zeile pro Befehl:\n\n" + "\n".join(f"- {s}" for s in said) +
            "\n\nDas weiß Jarvis schon:\n" + known +
            "\n\nSchreib höchstens 8 neue, dauerhaft nützliche Fakten über Georg auf: Vorlieben, Hobbys, Spiele, "
            "Projekte, Personen in seinem Leben, wiederkehrende Termine, wie er angesprochen werden will. Keine "
            "einmaligen Befehle (\"hat Spotify geöffnet\"), nichts, was schon bekannt ist, nichts Erfundenes, nichts "
            "Intimes. Jeder Fakt ein kurzer deutscher Satz in der dritten Person (\"Georg spielt gern Valorant.\"). "
            "Antworte nur mit einem JSON-Array aus Strings, ohne Erklärung. Gibt es nichts Neues: []"
        )

    def apply_digest(self, day: dt.date, answer: str) -> list[str]:
        """Übernimmt die Fakten aus der Antwort des Tagesrückblicks."""
        found = re.search(r"\[.*\]", str(answer), re.S)
        learned: list[str] = []
        if found:
            try:
                items = json.loads(found.group(0))
            except ValueError:
                items = []
            for item in items[:8] if isinstance(items, list) else []:
                if isinstance(item, str) and 5 <= len(item.strip()) <= 200:
                    learned.append(self.remember(item, source="gelernt"))
        self.mark_digest(day)
        return [fact for fact in learned if fact]

    def mark_digest(self, day: dt.date) -> None:
        with self._lock:
            self._load()["rueckblick"] = day.isoformat()
            self._save()


# ---------------------------------------------------------------------- Sätze

_REMEMBER = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?(?:merk|merke)\s+(?:dir|es dir)\s*(?:bitte\s+)?[,:]?\s*"
    r"(?P<dass>dass?\s+)?(?P<fact>.+)$",
    re.I,
)
_FORGET = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?(?:vergiss|vergesse)[,\s]+(?:bitte[,\s]+)?"
    r"(?:dass\s+|das mit\s+(?:dem|der|den)?\s*|alles über\s+)(?P<fact>.+)$",
    re.I,
)

# "Was weißt du über mich?", "Was hast du dir gemerkt?", "Welche Gewohnheiten kennst du?"
_FILL = r"(?:\s+(?:eigentlich|denn|alles|so|schon|bisher|jetzt))*"
_RECALL = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?"
    rf"(?:was\s+(?:weißt|weisst)\s+du{_FILL}\s+(?:über|von)\s+mich"
    rf"|was\s+hast\s+du\s+dir{_FILL}(?:\s+über\s+mich)?\s+gemerkt"
    r"|(?:welche|was\s+für)\s+gewohnheiten\s+(?:habe\s+ich|hab\s+ich|kennst\s+du)"
    rf"|was\s+(?:sind\s+meine|kennst\s+du{_FILL}\s+für)\s+gewohnheiten){_FILL}\s*[?.!]*$",
    re.I,
)
# "Merk dir das" oder "Merk dir, wo ich geparkt habe": ohne Zusammenhang nicht zu speichern,
# das übernimmt Claude (kennt das Gespräch und hat den Befehl "merken").
_NOT_A_FACT = re.compile(r"^(?:das|dies|dieses|es|was|wie|wo|wer|wann|warum|wieso|welche[nmrs]?)\b", re.I)
_LEAD = re.compile(r"^(?:das|dies|dieses)\s*[:,]\s*(?=\S)", re.I)
_ONLY_FILLER = re.compile(r"^(?:bitte|mal|doch|jetzt|gut|schon|einfach|genau|auch)(?:\s+(?:bitte|mal|doch|jetzt|gut|schon|einfach|genau|auch))*[\s.!]*$", re.I)


def _first_to_third(fact: str, clause: bool = False) -> str:
    """"(dass) ich gern Rock höre" -> "Georg sagt: Ich höre gern Rock" (so ist klar, wer "ich" ist)."""
    fact = fact.strip().rstrip(".!")
    if clause:
        from .messaging import direct_speech

        fact = direct_speech("dass " + fact) or fact
    if re.match(r"(?:ich|mein|meine|meinen|meinem|mir|mich)\b", fact, re.I):
        return f"Georg sagt: {fact[:1].upper() + fact[1:]}"
    return fact[:1].upper() + fact[1:]


def match_memory(text: str):
    """("remember", fakt) / ("forget", wörter) / ("recall", "") / None"""
    raw = " ".join(str(text).split()).strip()
    if _RECALL.match(raw):
        return "recall", ""
    found = _REMEMBER.match(raw)
    if found:
        fact = _LEAD.sub("", found.group("fact").strip())  # "Merk dir das: Max hat ..." -> "Max hat ..."
        if len(fact.strip(" .!")) >= 3 and not _NOT_A_FACT.match(fact) and not _ONLY_FILLER.match(fact):
            return "remember", _first_to_third(fact, clause=bool(found.group("dass")))
    found = _FORGET.match(raw)
    if found and len(found.group("fact").strip(" .!")) >= 3:
        return "forget", found.group("fact").strip(" .!")
    return None
