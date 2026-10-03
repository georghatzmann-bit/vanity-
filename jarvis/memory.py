"""Jarvis' Gedächtnis: Er lernt Georg von Tag zu Tag besser kennen.

- Fakten: was Georg ihm sagt ("Merk dir, dass ich gern Rock höre") und was Jarvis jede
  Nacht aus den Gesprächen des Tages lernt (Tagesrückblick, siehe `digest_prompt`).
- Kontakte: mit wem Georg über welche App schreibt ("Schreib Max ..." nimmt dann gleich
  die richtige App).
- Gewohnheiten: wann Georg welche Programme und Seiten öffnet. Nach ein paar Tagen erkennt
  Jarvis daraus Routinen ("werktags gegen 18 Uhr Discord und Spotify") und bietet sie zur
  passenden Zeit an. Sagt Georg nein, fragt er seltener, bei "nie" gar nicht mehr.
- Adressbuch: Geburtstage, die früher aus Georgs iPhone-Kontakten kamen, in einer eigenen Liste
  (nur noch gelesen). Sie laufen über dieselben Geburtstags-Hinweise wie die Fakten.
- Sitzungen: Sitzung für Sitzung, was Georg in einem Rutsch mit Jarvis gemacht hat (bis 20 Minuten Pause).
  Das Gesagte selbst ist nach drei Tagen weg, die Sitzungen mit ihren Themen bleiben. So weiß Jarvis auch
  nächste Woche noch, woran sie zuletzt gearbeitet haben ("Was haben wir zuletzt gemacht?").

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

# Diese Aktionen zählen für Routinen (Programme und Webseiten öffnen, in einen Discord-Sprachkanal gehen)
ROUTINE_KINDS = {"open", "web", "voice"}
KEEP_DAYS = 60  # so lange bleiben Gewohnheiten gespeichert
SAID_DAYS = 3  # Gesagtes nur für den Tagesrückblick, danach weg
MAX_EVENTS = 5000
MAX_FACTS = 200
ROUTINE_DAYS = 21  # Routinen aus den letzten drei Wochen
MIN_DAYS = 3  # ab so vielen Tagen ist es eine Gewohnheit
SPREAD = 60  # Minuten: so nah müssen die Uhrzeiten beieinander liegen
WEEKDAY_NAMES = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
               "November", "Dezember"]
USER = "Georg"  # wie der Nutzer heißt ([ich] name), siehe set_user
MAX_COMMANDS = 60  # eigene Befehle ("Zockmodus")
MAX_TRIGGER_WORDS = 6
MAX_ADDRESS_BOOK = 500  # Geburtstage aus den iPhone-Kontakten
SESSION_GAP = 20  # Minuten Pause: danach beginnt eine neue Sitzung
MAX_SESSIONS = 60  # so viele abgeschlossene Sitzungen bleiben gespeichert
MAX_THEMES = 6  # Themen je Sitzung
SESSION_DAYS = 7  # die Sitzungen dieser Tage bekommt das Gehirn zu Beginn mit
# Diese Wörter braucht Jarvis selbst ("Stopp" hält alles an, "Ja" beantwortet eine Frage).
RESERVED_TRIGGERS = {"stopp", "stop", "halt", "abbrechen", "abbruch", "ja", "nein", "nie wieder", "jarvis"}
_QUOTES = "\"'„“”‚‘’»«"


_SECRET = re.compile(r"passw(?:or)?t|kennwort|password|\bpin\b|pin-?code|passcode|geheimzahl|\btan\b|"
                     r"kreditkarte|\biban\b|sicherheitscode|cvv|zugangsdaten|login-?daten", re.I)


def is_secret(text: str) -> bool:
    """Passwort, PIN, Kreditkarte & Co.: gehört in einen Passwort-Manager, nicht ins Gedächtnis."""
    return bool(_SECRET.search(str(text)))


def set_user(name: str) -> None:
    global USER
    USER = str(name or "").strip() or "Georg"


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
        return _join([f"Sprachkanal {name}" if kind == "voice" else name for kind, name in self._ordered()])

    def _ordered(self) -> list[tuple[str, str]]:
        """Erst öffnen, dann in den Sprachkanal (Discord muss dafür offen sein)."""
        return sorted(self.actions, key=lambda action: action[0] == "voice")

    def fits(self, day: dt.date) -> bool:
        weekend = day.weekday() >= 5
        return self.days == "täglich" or (self.days == "am Wochenende") == weekend

    def question(self) -> str:
        opened = [name for kind, name in self._ordered() if kind != "voice"]
        voices = [name for kind, name in self._ordered() if kind == "voice"]
        parts = []
        if opened:
            parts.append(f"öffnen Sie meist {_join(opened)}")
        if voices:
            parts.append(("gehen in den Sprachkanal " if opened else "gehen Sie meist in den Sprachkanal ") + _join(voices))
        return f"Sir, um diese Zeit {' und '.join(parts)}. Soll ich?"

    def commands(self) -> list[str]:
        return [f"Geh in den Sprachkanal {name}" if kind == "voice" else f"Öffne {name}" for kind, name in self._ordered()]

    def describe(self) -> str:
        return f"{self.days} gegen {self.clock} Uhr: {self.label}"

    def as_dict(self) -> dict:
        return {"key": self.key, "label": self.label, "uhrzeit": self.clock, "tage": self.days,
                "anzahl": self.count, "befehle": self.commands(), "frage": self.question()}


@dataclass
class Occasion:
    """Ein Anlass aus dem Gedächtnis, z. B. ein Geburtstag: einmal am Tag ansagen und, wenn es
    passt, anbieten, etwas zu tun ("Soll ich Max auf Discord gratulieren?")."""

    key: str
    label: str
    text: str  # die Ansage
    offer: str = ""  # die Frage dazu, leer = nur ansagen
    command: str = ""  # was bei "Ja" passiert

    def question(self) -> str:
        return f"{self.text} {self.offer}".strip()

    def commands(self) -> list[str]:
        return [self.command] if self.command else []

    def describe(self) -> str:
        return self.text

    def as_dict(self) -> dict:
        return {"key": self.key, "label": self.label, "uhrzeit": "", "tage": "heute", "anzahl": 0,
                "befehle": self.commands(), "frage": self.question()}


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
            for name, empty in (("fakten", []), ("kontakte", {}), ("ereignisse", []), ("vorschlaege", {}),
                                ("befehle", {}), ("adressbuch", []), ("vorhaben", []), ("sitzungen", [])):
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
        """Speichert einen Fakt. Ähnliches wird ersetzt statt doppelt gespeichert. Passwörter und
        Ähnliches nie: das Gedächtnis liegt offen auf der Platte und geht mit jedem Gespräch an Claude."""
        fact = " ".join(str(text).split()).strip(" .,;:")
        if len(fact) < 3 or is_secret(fact):
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
            self._data = {"fakten": [], "kontakte": {}, "ereignisse": [], "vorschlaege": {}, "befehle": {},
                          "adressbuch": [], "sitzungen": []}
            self._save()

    def facts(self) -> list[dict]:
        with self._lock:
            return list(self._load()["fakten"])

    # ------------------------------------------------------------------ Eigene Befehle

    def teach(self, trigger: str, action: str) -> dict:
        """Ein eigener Befehl: Sagt Georg "Zockmodus", erledigt Jarvis "Öffne Discord und Steam".
        Derselbe Name ersetzt den alten. Geht der Name nicht, kommt ValueError mit dem Grund."""
        name = " ".join(str(trigger).split()).strip(" .,;:!?" + _QUOTES)
        key = command_key(name)
        action = " ".join(str(action).split()).strip(" ,;:" + _QUOTES)
        problem = trigger_problem(key)
        if problem:
            raise ValueError(problem)
        if len(action) < 3 or action.endswith("?"):
            raise ValueError("Was soll ich dann tun, Sir? Zum Beispiel: Wenn ich Zockmodus sage, öffne Discord und Steam.")
        if is_secret(action):
            raise ValueError("Passwörter und PINs gehören nicht in einen Befehl, Sir. Ein Passwort-Manager ist dafür der bessere Ort.")
        with self._lock:
            commands = self._load()["befehle"]
            known = commands.get(key) or {}
            commands[key] = {"name": name[:1].upper() + name[1:], "aktion": action[:500],
                             "seit": self._now().isoformat(timespec="minutes"), "anzahl": int(known.get("anzahl", 0))}
            for old in sorted(commands, key=lambda k: commands[k].get("seit", ""))[: max(0, len(commands) - MAX_COMMANDS)]:
                del commands[old]
            self._save()
            return dict(commands[key], key=key)

    def unteach(self, trigger: str) -> dict | None:
        """Löscht einen eigenen Befehl. Gibt ihn zurück, None = gab es nicht."""
        key = command_key(str(trigger).strip(_QUOTES))
        with self._lock:
            commands = self._load()["befehle"]
            for candidate in _command_candidates(key):
                if candidate in commands:
                    removed = commands.pop(candidate)
                    self._save()
                    return dict(removed, key=candidate)
        return None

    def custom_commands(self) -> list[dict]:
        with self._lock:
            commands = self._load()["befehle"]
            return sorted((dict(v, key=k) for k, v in commands.items() if isinstance(v, dict) and v.get("aktion")),
                          key=lambda c: c.get("name", "").lower())

    def command_for(self, text: str) -> dict | None:
        """Der eigene Befehl, den Georg gerade gesagt hat ("Zockmodus", "Starte den Zockmodus"), sonst None."""
        key = command_key(text)
        if not key or len(key.split()) > MAX_TRIGGER_WORDS + 3:
            return None
        with self._lock:
            commands = self._load()["befehle"]
            if not commands:
                return None
            for candidate in _command_candidates(key):
                found = commands.get(candidate)
                if isinstance(found, dict) and found.get("aktion"):
                    return dict(found, key=candidate)
            # Nach Klang, aber nur, wenn der ganze Satz wie der Befehl klingt ("Zogmodus" -> "Zockmodus"),
            # gleich viele Wörter: "Zockmodus aus" ist nicht "Zockmodus".
            if len(key.split()) <= 2:
                from .klang import closest

                usable = [k for k, v in commands.items() if isinstance(v, dict) and v.get("aktion")
                          and len(k.split()) == len(key.split())]
                heard = closest(key, usable, cutoff=0.86, same_start=True)
                if heard:
                    return dict(commands[heard], key=heard)
        return None

    def used_command(self, key: str) -> None:
        with self._lock:
            found = self._load()["befehle"].get(key)
            if isinstance(found, dict):
                found["anzahl"] = int(found.get("anzahl", 0)) + 1
                found["zuletzt"] = self._now().isoformat(timespec="minutes")
                self._save()

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
            if kind == "said":
                self._track_session(memory, now, what)
            self._prune(now)
            self._save()

    # ------------------------------------------------------------------ Sitzungen

    def _track_session(self, memory: dict, now: dt.datetime, what: str) -> None:
        """Sitzung für Sitzung: Ein Befehl gehört zur laufenden Sitzung, nach 20 Minuten Pause beginnt eine neue."""
        stamp = now.isoformat(timespec="minutes")
        current = memory.get("sitzung")
        if isinstance(current, dict):
            try:
                last = dt.datetime.fromisoformat(str(current.get("ende")))
            except ValueError:
                last = None
            if last is None or now < last or now - last > dt.timedelta(minutes=SESSION_GAP):
                self._close_session(memory)
                current = None
        if not isinstance(current, dict):
            current = memory["sitzung"] = {"start": stamp, "ende": stamp, "anzahl": 0, "themen": []}
        current["ende"] = stamp
        current["anzahl"] = int(current.get("anzahl", 0)) + 1
        themes = current.setdefault("themen", [])
        theme = session_theme(what)
        if theme and len(themes) < MAX_THEMES and _key(theme) not in {_key(t) for t in themes}:
            themes.append(theme)

    @staticmethod
    def _close_session(memory: dict) -> None:
        current = memory.get("sitzung")
        memory["sitzung"] = None
        if isinstance(current, dict) and current.get("start"):
            closed = memory.setdefault("sitzungen", [])
            closed.append({k: current.get(k) for k in ("start", "ende", "anzahl", "themen")})
            del closed[:-MAX_SESSIONS]

    def sessions(self, now: dt.datetime | None = None) -> list[dict]:
        """Die Sitzungen, älteste zuerst: {"start", "ende", "anzahl", "themen", "laufend"}. Die letzte läuft
        noch, solange die Pause kürzer als 20 Minuten ist."""
        now = now or self._now()
        with self._lock:
            data = self._load()
            items = [dict(s) for s in data.get("sitzungen") or [] if isinstance(s, dict) and s.get("start")]
            current = data.get("sitzung")
            if isinstance(current, dict) and current.get("start"):
                items.append({**current, "_aktuell": True})
        out = []
        for item in items:
            is_current = item.pop("_aktuell", False)
            try:
                end = dt.datetime.fromisoformat(str(item.get("ende") or item["start"]))
                dt.datetime.fromisoformat(str(item["start"]))
            except ValueError:
                continue
            item["themen"] = [str(t) for t in item.get("themen") or [] if str(t).strip()]
            item["anzahl"] = int(item.get("anzahl") or 0)
            item["laufend"] = bool(is_current) and dt.timedelta(0) <= now - end <= dt.timedelta(minutes=SESSION_GAP)
            out.append(item)
        return out

    def last_session(self, now: dt.datetime | None = None) -> dict | None:
        """Die letzte Sitzung mit Themen vor der laufenden ("Was haben wir zuletzt gemacht?"). Gibt es keine
        frühere, die laufende."""
        items = self.sessions(now)
        done = [s for s in items if not s["laufend"] and s["themen"]]
        if done:
            return done[-1]
        running = [s for s in items if s["laufend"] and s["themen"]]
        return running[-1] if running else None

    def session_answer(self, now: dt.datetime | None = None) -> str:
        now = now or self._now()
        return spoken_session(self.last_session(now), now)

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

    def due(self, now: dt.datetime | None = None) -> Routine | Occasion | None:
        """Der Anlass oder die Routine, die gerade dran ist und noch nicht erledigt oder abgelehnt wurde."""
        now = now or self._now()
        with self._lock:
            answers = self._load()["vorschlaege"]
        occasion = self.occasion(now)
        if occasion is not None:
            return occasion
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

    def may_offer(self, key: str, now: dt.datetime | None = None, every_days: int = 1) -> bool:
        """Darf Jarvis das jetzt anbieten? Nicht nach "Nie wieder", nicht nach meist "Nein" und
        nicht öfter als alle `every_days` Tage."""
        now = now or self._now()
        with self._lock:
            state = dict(self._load()["vorschlaege"].get(key, {}))
        if state.get("nie"):
            return False
        if int(state.get("nein", 0)) >= 3 and int(state.get("nein", 0)) > 2 * int(state.get("ja", 0)):
            return False
        last = str(state.get("angeboten", ""))
        return not last or last <= (now.date() - dt.timedelta(days=every_days)).isoformat()

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

    # ------------------------------------------------------------------ Adressbuch (iPhone-Kontakte)

    def address_book(self) -> list[dict]:
        with self._lock:
            return [dict(p) for p in self._load()["adressbuch"] if isinstance(p, dict)]

    def _book_birthday(self, person: dict) -> dict:
        """Ein Geburtstag aus dem iPhone im selben Format wie parse_birthday. Gratulieren bietet Jarvis
        nur an, wenn er weiß, wie Georg mit der Person schreibt (Kontakt im Gedächtnis)."""
        name = ""
        for candidate in (person.get("spitzname"), person.get("vorname"), person.get("name")):
            if candidate and self.contact_app(str(candidate)):
                name = str(candidate)
                break
        return {"who": person["name"], "shown": person["name"], "name": name, "own": False,
                "month": int(person["monat"]), "day": int(person["tag"]), "year": int(person.get("jahr") or 0),
                "iphone": True}

    # ------------------------------------------------------------------ Geburtstage

    def birthdays(self) -> list[dict]:
        """Alle Geburtstage: aus den Fakten ("Max hat am 3. Mai Geburtstag") und aus dem iPhone-Adressbuch.
        Steht jemand in beiden, zählt der Fakt."""
        found, seen = [], set()
        for fact in self.facts():
            birthday = parse_birthday(fact.get("text", ""))
            if birthday and (birthday["who"], birthday["month"], birthday["day"]) not in seen:
                seen.add((birthday["who"], birthday["month"], birthday["day"]))
                found.append(birthday)
        known = {(_key(b["who"]), b["month"], b["day"]) for b in found} | \
                {(_key(b["name"]), b["month"], b["day"]) for b in found if b.get("name")}
        for person in self.address_book():
            names = {_key(str(person.get(k) or "")) for k in ("name", "vorname", "spitzname")} - {""}
            if any((name, person["monat"], person["tag"]) in known for name in names):
                continue
            found.append(self._book_birthday(person))
            known.add((_key(person["name"]), person["monat"], person["tag"]))
        return found

    def upcoming_birthdays(self, now: dt.datetime | None = None, days: int = 30) -> list[dict]:
        """Geburtstage in den nächsten Tagen, der nächste zuerst, mit "in_tagen"."""
        today = (now or self._now()).date()
        items = []
        for birthday in self.birthdays():
            next_day = _next_birthday(birthday, today)
            if next_day is not None and (next_day - today).days <= days:
                items.append({**birthday, "datum": next_day.isoformat(), "in_tagen": (next_day - today).days})
        return sorted(items, key=lambda b: b["in_tagen"])

    def occasion(self, now: dt.datetime | None = None) -> Occasion | None:
        """Ein Geburtstag heute, tagsüber einmal angesagt (nicht nachts um zwei)."""
        now = now or self._now()
        if not (9 * 60 <= _minutes(now) <= 21 * 60 + 30):
            return None
        with self._lock:
            answers = self._load()["vorschlaege"]
        for birthday in self.upcoming_birthdays(now, days=0):
            key = f"geburtstag:{_key(birthday['who'])}"
            state = answers.get(key, {})
            if state.get("nie") or state.get("angeboten") == now.date().isoformat():
                continue
            return self._birthday_occasion(birthday, key, now.date())
        return None

    def _birthday_occasion(self, birthday: dict, key: str, today: dt.date) -> Occasion:
        if birthday["own"]:
            return Occasion(key, "Ihr Geburtstag", "Alles Gute zum Geburtstag, Sir. Möge das neue Lebensjahr so "
                                                    "reibungslos laufen wie Ihre Systeme.")
        shown, name = birthday["shown"], birthday["name"]
        age = today.year - birthday["year"] if birthday.get("year") else 0
        text = f"Sir, {shown} wird heute {age}." if 0 < age < 120 else f"Sir, heute hat {shown} Geburtstag."
        if not name:
            return Occasion(key, f"Geburtstag: {shown}", text)
        app = self.contact_app(name) or "discord"
        app_name = {"discord": "Discord", "whatsapp": "WhatsApp", "telegram": "Telegram"}.get(app, "Discord")
        first = name.split()[0]
        return Occasion(key, f"Glückwunsch an {name}", text, f"Soll ich {name} auf {app_name} gratulieren?",
                        f"Schreib {name} auf {app_name}: Alles Gute zum Geburtstag, {first}! 🎉")

    # ------------------------------------------------------------------ für das Gehirn

    def context(self, now: dt.datetime | None = None) -> str:
        """Kurze Zusammenfassung für den Anfang einer Unterhaltung. Leer, wenn Jarvis noch nichts weiß."""
        now = now or self._now()
        lines = []
        facts = self.facts()[-40:]
        if facts:
            lines.append(f"Was du über {USER} weißt (aus früheren Gesprächen):")
            lines += [f"- {f['text']}" for f in facts]
        contacts = [c for c in self.contacts()[:10] if c.get("app")]
        if contacts:
            lines.append(f"Mit wem {USER} schreibt: " + ", ".join(f"{c['name']} ({c['app']})" for c in contacts) + ".")
        routines = self.routines(now)[:8]
        if routines:
            lines.append(f"Gewohnheiten von {USER}: " + "; ".join(r.describe() for r in routines) + ".")
        commands = self.custom_commands()[:20]
        if commands:
            lines.append(f"Eigene Befehle von {USER} (sagt er den Namen, erledigst du, was dahinter steht): "
                         + "; ".join(f"„{c['name']}“ = {c['aktion']}" for c in commands) + ".")
        soon = [b for b in self.upcoming_birthdays(now, days=14) if b.get("iphone")][:6]
        if soon:  # die aus den Fakten stehen oben schon
            lines.append("Geburtstage bald (aus dem iPhone): " + "; ".join(
                f"{b['shown']} am {int(b['datum'][8:10])}. {MONTH_NAMES[int(b['datum'][5:7]) - 1]}" for b in soon) + ".")
        plans = self.plans_for(now.date())
        if plans:
            lines.append(f"Was {USER} heute vorhatte (aus früheren Gesprächen): " + "; ".join(p["was"] for p in plans) + ".")
        oldest = (now - dt.timedelta(days=SESSION_DAYS)).isoformat(timespec="minutes")
        recent = [s for s in self.sessions(now) if not s["laufend"] and s["themen"] and s["start"] >= oldest][-3:]
        if recent:
            lines.append(f"Die letzten Sitzungen mit {USER} (Sitzung für Sitzung, damit du weißt, woran ihr zuletzt "
                         "wart): " + " | ".join(describe_session(s) for s in recent) + ".")
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
        said = [e for e in self.events("said") if done < e.get("t", "")[:10] <= day.isoformat()][-150:]
        lines = []
        for event in said:
            try:
                when = dt.date.fromisoformat(str(event.get("t", ""))[:10])
                stamp = f"({WEEKDAY_NAMES[when.weekday()][:2]} {when.isoformat()}) "
            except ValueError:
                stamp = ""
            lines.append(f"- {stamp}{event['was']}")
        known = "\n".join(f"- {f['text']}" for f in self.facts()[-60:]) or "- (noch nichts)"
        return (
            f"Du bist das Gedächtnis von Jarvis, dem persönlichen Assistenten von {USER}. Hier ist, was {USER} zuletzt zu "
            "Jarvis gesagt hat, eine Zeile pro Befehl, mit dem Tag davor:\n\n" + "\n".join(lines) +
            "\n\nDas weiß Jarvis schon:\n" + known +
            f"\n\nSchreib höchstens 8 neue, dauerhaft nützliche Fakten über {USER} auf: Vorlieben, Hobbys, Spiele, "
            "Projekte, Personen in seinem Leben, wiederkehrende Termine, wie er angesprochen werden will. Keine "
            "einmaligen Befehle (\"hat Spotify geöffnet\"), nichts, was schon bekannt ist, nichts Erfundenes, nichts "
            f"Intimes. Jeder Fakt ein kurzer deutscher Satz in der dritten Person (\"{USER} spielt gern Valorant.\").\n"
            f"Dazu höchstens 5 Vorhaben: was {USER} gesagt hat, dass er noch tun muss oder will (\"Ich muss morgen noch "
            "zur Post\", \"Am Freitag wollte ich das Auto waschen\"), kurz und ohne \"Georg\" (\"zur Post gehen\"), mit "
            "dem Tag als JJJJ-MM-TT, falls er einen nennt (\"morgen\" vom Tag aus gerechnet, an dem er es sagte), sonst "
            "\"\". Nicht: Bitten an Jarvis (Erinnerungen, Timer, Termine eintragen erledigt Jarvis selbst), Erledigtes.\n"
            "Antworte nur mit einem JSON-Objekt, ohne Erklärung: "
            "{\"fakten\": [\"...\"], \"vorhaben\": [{\"was\": \"...\", \"tag\": \"JJJJ-MM-TT\"}]}. "
            "Gibt es nichts Neues: {\"fakten\": [], \"vorhaben\": []}"
        )

    def apply_digest(self, day: dt.date, answer: str) -> list[str]:
        """Übernimmt Fakten (und Vorhaben) aus der Antwort des Tagesrückblicks. Versteht das Objekt
        {"fakten": [...], "vorhaben": [...]} und, wie früher, ein bloßes Array aus Fakten."""
        text = str(answer)
        facts: list = []
        plans: list = []
        found = re.search(r"\{.*\}", text, re.S)
        data = None
        if found:
            try:
                data = json.loads(found.group(0))
            except ValueError:
                data = None
        if isinstance(data, dict):
            facts = data.get("fakten") if isinstance(data.get("fakten"), list) else []
            plans = data.get("vorhaben") if isinstance(data.get("vorhaben"), list) else []
        else:
            found = re.search(r"\[.*\]", text, re.S)
            if found:
                try:
                    items = json.loads(found.group(0))
                except ValueError:
                    items = []
                facts = items if isinstance(items, list) else []
        learned: list[str] = []
        for item in facts[:8]:
            if isinstance(item, str) and 5 <= len(item.strip()) <= 200:
                learned.append(self.remember(item, source="gelernt"))
        self.add_plans(plans, day)
        self.mark_digest(day)
        return [fact for fact in learned if fact]

    # ------------------------------------------------------------------ Vorhaben

    def add_plans(self, items, said_on: dt.date) -> list[str]:
        """Vorhaben aus dem Tagesrückblick ({"was": "zur Post gehen", "tag": "2026-10-03"}), höchstens fünf."""
        clean = []
        for item in list(items or [])[:5]:
            if not isinstance(item, dict):
                continue
            what = " ".join(str(item.get("was", "")).split()).rstrip(".")[:120]
            if len(what) < 4 or is_secret(what):
                continue
            day = str(item.get("tag") or "").strip()
            try:
                day = dt.date.fromisoformat(day).isoformat() if day else ""
            except ValueError:
                day = ""
            clean.append({"was": what, "tag": day, "gesagt": said_on.isoformat()})
        if not clean:
            return []
        today = self._now().date()
        with self._lock:
            data = self._load()
            known = {(p.get("was", "").lower(), p.get("tag", "")) for p in data["vorhaben"] if isinstance(p, dict)}
            fresh = [p for p in clean if (p["was"].lower(), p["tag"]) not in known]
            keep = [p for p in data["vorhaben"] if isinstance(p, dict) and (
                (p.get("tag") or "") >= (today - dt.timedelta(days=7)).isoformat() if p.get("tag")
                else str(p.get("gesagt", "")) >= (today - dt.timedelta(days=14)).isoformat())]
            data["vorhaben"] = (keep + fresh)[-30:]
            self._save()
        return [p["was"] for p in fresh]

    def plans_for(self, day: dt.date) -> list[dict]:
        """Was Georg für diesen Tag vorhatte, und was er ohne Tag vor Kurzem vorhatte und Jarvis noch nicht
        erwähnt hat."""
        with self._lock:
            items = [dict(p) for p in self._load()["vorhaben"] if isinstance(p, dict)]
        recent = (day - dt.timedelta(days=3)).isoformat()
        return [p for p in items if p.get("tag") == day.isoformat()
                or (not p.get("tag") and not p.get("erwaehnt") and str(p.get("gesagt", "")) >= recent)]

    def plans_mentioned(self, plans: list[dict], day: dt.date) -> None:
        """Jarvis hat diese Vorhaben erwähnt: die ohne Tag nicht noch einmal."""
        wanted = {(p.get("was"), p.get("tag", "")) for p in plans}
        with self._lock:
            data = self._load()
            for p in data["vorhaben"]:
                if isinstance(p, dict) and (p.get("was"), p.get("tag", "")) in wanted:
                    p["erwaehnt"] = day.isoformat()
            self._save()

    def mark_digest(self, day: dt.date) -> None:
        with self._lock:
            self._load()["rueckblick"] = day.isoformat()
            self._save()


# ---------------------------------------------------------------------- Geburtstage erkennen

_MONTHS = {
    "januar": 1, "jänner": 1, "jaenner": 1, "jan": 1, "februar": 2, "feber": 2, "feb": 2, "märz": 3, "maerz": 3,
    "mär": 3, "mrz": 3, "april": 4, "apr": 4, "mai": 5, "juni": 6, "jun": 6, "juli": 7, "jul": 7, "august": 8,
    "aug": 8, "september": 9, "sept": 9, "sep": 9, "oktober": 10, "okt": 10, "november": 11, "nov": 11,
    "dezember": 12, "dez": 12,
}
_DATE = (r"(?P<day>\d{1,2})\.?\s*(?:(?P<month>\d{1,2})\.?(?:\s*(?P<year>(?:19|20)\d{2}))?"
         r"|(?P<mname>[A-Za-zÄÖÜäöü]+)\.?(?:\s+(?P<year2>(?:19|20)\d{2}))?)")
_BIRTHDAY = [re.compile(pattern, re.I) for pattern in (
    rf"^(?P<who>.+?)\s+(?:hat|haben|hab|habe)\s+(?:am\s+)?{_DATE}\s+(?:seinen\s+|ihren\s+|meinen\s+)?geburtstag\b",
    rf"^(?P<who>.+?)\s+(?:hat|haben|hab|habe)\s+(?:seinen\s+|ihren\s+|meinen\s+)?geburtstag\s+am\s+{_DATE}",
    rf"^(?:der\s+)?geburtstag\s+(?:von\s+)?(?P<who>.+?)\s+ist\s+am\s+{_DATE}",
    rf"^(?P<who>.+?)\s+geburtstag\s+ist\s+am\s+{_DATE}",
    rf"^(?P<who>.+?)\s+(?:ist|wurde|bin)\s+am\s+{_DATE}\s+geboren",
    rf"^am\s+{_DATE}\s+(?:hat|haben|hab|habe)\s+(?P<who>.+?)\s+(?:seinen\s+|ihren\s+|meinen\s+)?geburtstag$",
)]
_RELATION = {
    "bruder", "schwester", "freund", "freundin", "kumpel", "cousin", "cousine", "onkel", "tante", "opa", "oma",
    "mutter", "vater", "mama", "papa", "mami", "papi", "sohn", "tochter", "chef", "chefin", "kollege", "kollegin",
    "nachbar", "nachbarin", "neffe", "nichte", "enkel", "enkelin", "frau", "mann", "partner", "partnerin",
    "schwager", "schwägerin", "bester", "beste", "besten", "kleiner", "kleine", "großer", "große", "ex",
}
# Jarvis sagt es immer als Subjekt ("Ihr Vater hat heute Geburtstag"), auch aus "meines Vaters" oder "von meinem Bruder"
_OWNER = {"mein": "Ihr", "meine": "Ihre", "meinem": "Ihr", "meiner": "Ihre", "meines": "Ihr", "meinen": "Ihr"}
# Namen, die selbst auf s enden: "Lukas Geburtstag ist am ..." ist Lukas, nicht Luka
_S_NAMES = {
    "andreas", "elias", "jonas", "lukas", "lucas", "matthias", "mathias", "niklas", "nicklas", "nikolas", "nicolas",
    "thomas", "tobias", "mattis", "janis", "jannis", "hans", "jens", "lars", "nils", "niels", "mats", "chris",
    "dennis", "boris", "louis", "carlos", "iris", "doris", "agnes", "ines",
}


def _relation(word: str, owner: str) -> str:
    """Verwandte in der Grundform: "Vaters" -> "Vater", "Freundes" -> "Freund", "besten" -> "bester" nach "Ihr"."""
    low = word.lower()
    if low in ("besten", "kleinen", "großen"):
        return word[:-1] + ("r" if owner == "Ihr" else "")
    if low in _RELATION:
        return word
    for end in ("es", "s", "en", "n"):
        if low.endswith(end) and low[:-len(end)] in _RELATION:
            return word[:-len(end)]
    return word


def parse_birthday(text: str) -> dict | None:
    """"Max hat am 3. Mai Geburtstag" -> {"who": "Max", "shown": "Max", "name": "Max", "month": 5, "day": 3, ...}.
    "name" ist leer, wenn niemand zum Anschreiben dasteht ("Meine Mutter hat ...")."""
    raw = " ".join(str(text).split()).strip(" .")
    if "geburtstag" not in raw.lower() and "geboren" not in raw.lower():
        return None
    raw = re.sub(r"^[\wÄÖÜäöüß-]+ sagt:\s*", "", raw)
    for pattern in _BIRTHDAY:
        found = pattern.match(raw)
        if found:
            break
    else:
        return None
    day = int(found.group("day"))
    if found.group("month"):
        month = int(found.group("month"))
    else:
        month = _MONTHS.get(found.group("mname").lower().rstrip("."), 0)
    year = found.group("year") or found.group("year2")
    try:
        dt.date(2000, month, day)  # 2000 ist ein Schaltjahr: auch der 29. Februar ist gültig
    except ValueError:
        return None
    said = found.group("who")
    who = said.strip(" ,'’")
    words = who.split()
    if not words or len(words) > 5:
        return None
    if (found.re is _BIRTHDAY[3] and len(words) == 1 and who.lower().endswith("s") and not said.endswith(("'", "’"))
            and who.lower() not in _S_NAMES and not who.lower().endswith(("us", "ss"))):
        who = who[:-1]  # "Annas Geburtstag ist am ..."
        words = [who]
    own = who.lower() in ("ich", USER.lower(), "mein", "meiner", "mir")
    owner = _OWNER.get(words[0].lower(), "")
    shown = " ".join(owner if i == 0 and owner else _relation(w, owner) for i, w in enumerate(words))
    name = " ".join(w for w in words if w.lower() not in _OWNER and _relation(w, owner).lower() not in _RELATION
                    and w[:1].isupper())
    return {"who": who, "shown": shown, "name": "" if own else name, "own": own, "month": month, "day": day,
            "year": int(year) if year else 0}


def _next_birthday(birthday: dict, today: dt.date) -> dt.date | None:
    for year in (today.year, today.year + 1):
        try:
            day = dt.date(year, birthday["month"], birthday["day"])
        except ValueError:
            day = dt.date(year, 2, 28)  # 29. Februar in einem normalen Jahr
        if day >= today:
            return day
    return None


# ---------------------------------------------------------------------- Sätze

_REMEMBER = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?(?:merk|merke)\s+(?:dir|es dir)\s*(?:bitte\b)?[,:]?\s*"
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
_NOT_A_FACT = re.compile(
    r"^(?:das|dies|dieses|es|was|wie|wo|wer|wann|warum|wieso|welche[nmrs]?|nicht|nichts|kein|keine|alles|du|dich|dir|"
    r"mit (?:dem|der|den)|(?:den|die|der|dem|diesen|diese|dieses|diesem)(?:\s+\S+)?\s*$)", re.I)
_LEAD = re.compile(r"^(?:das|dies|dieses)\s*[:,]\s*(?=\S)", re.I)
_ONLY_FILLER = re.compile(r"^(?:bitte|mal|doch|jetzt|gut|schon|einfach|genau|auch)(?:\s+(?:bitte|mal|doch|jetzt|gut|schon|einfach|genau|auch))*[\s.!]*$", re.I)


def _first_to_third(fact: str, clause: bool = False) -> str:
    """"(dass) ich gern Rock höre" -> "Georg sagt: Ich höre gern Rock" (so ist klar, wer "ich" ist)."""
    fact = fact.strip().rstrip(".!")
    if clause:
        from .messaging import _split_verb, direct_speech

        converted = direct_speech("dass " + fact)
        # "dass Max mein bester Freund ist" -> "Max ist mein bester Freund"
        # ("dass Max und Tom Brüder sind" -> "Max und Tom sind Brüder")
        named = re.match(r"^([A-ZÄÖÜ][\wäöüß-]+(?:\s+(?:und|oder)\s+[A-ZÄÖÜ][\wäöüß-]+)?)\s+(.+?)\s+([a-zäöüß]{2,})$", fact)
        if converted is None and named and "," not in fact:
            stem, particle = _split_verb(named.group(3))
            converted = " ".join([named.group(1), stem, named.group(2), *([particle] if particle else [])])
        fact = converted or fact
    if re.match(r"(?:ich|mein|meine|meinen|meinem|mir|mich)\b", fact, re.I):
        return f"{USER} sagt: {fact[:1].upper() + fact[1:]}"
    return fact[:1].upper() + fact[1:]


# ---------------------------------------------------------------------- Eigene Befehle erkennen

_CALL = r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte[,\s]+)?"
# "Wenn ich Zockmodus sage, öffne Discord und Steam", "Merk dir: Sobald ich Feierabend sage, ..."
_TEACH = re.compile(
    _CALL + r"(?:(?:merk|merke)\s+dir\s*[:,]?\s*)?(?:bitte\s+)?(?:immer\s+)?(?:wenn|sobald)\s+ich\s+"
    r"(?:(?:in\s+zukunft|ab\s+jetzt|ab\s+sofort|künftig|jetzt|mal|nur|zu\s+dir|dir|(?:das\s+)?nächste\s+mal|nächstes\s+mal)\s+)*"
    r"(?P<trigger>[^,:]{2,60}?)\s+(?:sage|sag|rufe|ruf)\s*(?:[,:]\s*|\s+)(?:dann\s+)?"
    r"(?:(?:sollst|kannst)\s+du\s+|(?:möchte|will)\s+ich,?\s+dass\s+du\s+)?(?P<action>.{3,})$",
    re.I,
)
# "Wenn ich sage: Zockmodus, dann öffne Discord"
_TEACH_SAY_FIRST = re.compile(
    _CALL + r"(?:(?:merk|merke)\s+dir\s*[:,]?\s*)?(?:immer\s+)?(?:wenn|sobald)\s+ich\s+(?:sage|sag)\s*[:,]?\s*"
    r"(?P<trigger>[^,:]{2,60}?)\s*,\s*(?:dann\s+)?(?P<action>.{3,})$",
    re.I,
)
# "Neuer Befehl Zockmodus: öffne Discord und Steam", "Lerne den Befehl Feierabend, schließ alles"
_TEACH_NAMED = re.compile(
    _CALL + r"(?:(?:lern|lerne|speicher|speichere|merk\s+dir)\s+(?:(?:einen|den|diesen)\s+)?(?:neuen\s+)?|neuer\s+|eigener\s+)"
    r"(?:befehl|kommando|sprachbefehl|makro)\s*[:,]?\s*(?P<trigger>[^:=,]{2,60}?)\s*"
    r"(?::|=|,|\s+heißt\s+|\s+bedeutet\s+)\s*(?P<action>.{3,})$",
    re.I,
)
_UNTEACH = re.compile(
    _CALL + r"(?:vergiss|vergesse|lösch|lösche|entferne|entfern)\s+(?:bitte\s+)?(?:den|meinen|diesen)\s+"
    r"(?:eigenen\s+)?(?:befehl|kommando|sprachbefehl|makro)\s*[:,]?\s*(?P<trigger>.{2,60}?)\s*[.!]*$",
    re.I,
)
_LIST_COMMANDS = re.compile(
    _CALL + r"(?:(?:welche|was\s+für)\s+(?:eigenen\s+)?befehle\s+(?:kennst\s+du|hast\s+du|habe\s+ich|hab\s+ich|gibt\s+es)"
    r"(?:\s+(?:von\s+mir|schon|alles|eigentlich|denn|so))*"
    r"|(?:zeig|zeige|nenn|nenne|sag|sage)\s+(?:mir\s+)?(?:meine|alle\s+meine|die)\s+(?:eigenen\s+)?befehle"
    r"|was\s+sind\s+meine\s+(?:eigenen\s+)?befehle)\s*[?.!]*$",
    re.I,
)
_START_WORDS = re.compile(
    r"^(?:starte|start|aktiviere|aktivier|mach|zeit\s+für|wechsle\s+in\s+den|wechsel\s+in\s+den)\s+"
    r"(?:(?:den|die|das|mal|bitte|jetzt)\s+)*(?P<rest>.+?)(?:\s+(?:an|ein|bitte|jetzt))?$")
_END_WORDS = re.compile(r"^(?P<rest>.+?)\s+(?:an|ein|starten|aktivieren|los|bitte|jetzt)$")
_RUN_WORDS = re.compile(r"^(?:führe|führ)\s+(?:(?:den|die|das|mal|bitte)\s+)*(?P<rest>.+?)\s+aus$")


# "Wenn ich dir sage, du sollst ...": kein Name für einen Befehl
_NO_NAME = {"dir", "mir", "es", "das", "dies", "so", "was", "etwas", "nichts", "ihm", "ihr", "euch", "dann", "jetzt",
            "nicht", "irgendwas", "irgendetwas"}
# "Wenn ich morgen Bescheid sage, ...": eine Zeit oder "Bescheid" ist kein Name, das ist ein Gespräch für Claude
_NOT_IN_NAME = {"morgen", "heute", "später", "gleich", "nachher", "nochmal", "wieder", "bescheid"}
# "Wenn ich etwas Falsches sage, ...", "Wenn ich sage, dass es kalt ist, ...": auch kein Name
_NOT_FIRST = {"dass", "etwas", "irgendwas", "irgendetwas"}
# "Wenn ich Licht sage, meine ich die Stehlampe": erklärt ein Wort, ist kein Befehl
_MEANING = re.compile(r"^(?:meine|meinte|mein)\s+ich\b", re.I)


def _is_name(key: str) -> bool:
    words = key.split()
    return (bool(words) and not all(w in _NO_NAME for w in words) and words[0] not in _NOT_FIRST
            and not any(w in _NOT_IN_NAME for w in words))


def command_key(text: str) -> str:
    """"Hey Jarvis, „Zockmodus“!" -> "zockmodus": so vergleicht Jarvis eigene Befehle."""
    words = _key(str(text)).split()
    while words and words[0] in {"hey", "hi", "ok", "okay", "jarvis", "bitte"}:
        words.pop(0)
    while words and words[-1] in {"bitte", "jarvis", "jetzt", "mal"}:
        words.pop()
    return " ".join(words)


def trigger_problem(key: str) -> str:
    """Warum dieser Name kein eigener Befehl sein kann ("" = er geht)."""
    if len(key) < 3:
        return "Der Name ist zu kurz, Sir. Nehmen Sie ein Wort wie Zockmodus oder Feierabend."
    if key in RESERVED_TRIGGERS:
        return f"„{key.capitalize()}“ brauche ich selbst, Sir. Nehmen Sie bitte ein anderes Wort."
    if len(key.split()) > MAX_TRIGGER_WORDS:
        return "Das ist als Name zu lang, Sir. Ein bis drei Wörter sind ideal, zum Beispiel Zockmodus."
    return ""


def _command_candidates(key: str):
    """"starte den zockmodus" -> "starte den zockmodus", "zockmodus" (so passt auch die freie Form)."""
    yield key
    for pattern in (_START_WORDS, _END_WORDS, _RUN_WORDS):
        found = pattern.match(key)
        if found and found.group("rest") != key:
            yield found.group("rest")


# Kein Thema einer Sitzung: Antworten, Lob, Stopp, Uhrzeit, Grüße und die Frage nach der letzten Sitzung selbst
_TRIVIAL = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]*)?(?:ja|nein|nö|jo|jep|klar|genau|danke(?:\s+schön|\s+dir)?|bitte|okay|ok|"
    r"stopp?|halt|abbrechen|weiter|nochmal|noch\s+mal|lauter|leiser|schneller|langsamer|gut|super|perfekt|cool|nice|"
    r"(?:gut|sehr)\s+gemacht|hallo|hi|hey|moin|servus|guten\s+(?:morgen|tag|abend)|gute\s+nacht|tschüss|bis\s+später|"
    r"nie\s+wieder|wie\s+spät\s+ist\s+es|wie\s+viel\s+uhr\s+ist\s+es|was\s+haben\s+wir\s+(?:zuletzt|"
    r"als\s+letztes|letztes\s+mal)\b.*|woran\s+haben\s+wir\s+zuletzt\b.*)?[\s,.!?]*$", re.I)
_RECALL_SESSION = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:"
    r"was\s+haben\s+wir\s+(?:zuletzt|als\s+letztes|das\s+letzte\s+mal|letztes\s+mal|beim\s+letzten\s+mal)"
    r"(?:\s+(?:zusammen|gemeinsam|so))?\s+(?:gemacht|besprochen|gemacht\s+zusammen)"
    r"|woran\s+(?:haben\s+wir|hab\s+ich|habe\s+ich)\s+(?:zuletzt|als\s+letztes|letztes\s+mal)\s+gearbeitet"
    r"|wo\s+(?:waren|sind)\s+wir\s+(?:stehen\s*geblieben|stehengeblieben)"
    r"|(?:was\s+war|zeig\s+mir)\s+(?:unsere|die)\s+letzte\s+sitzung)\s*[?.!]*$",
    re.I,
)


def session_theme(text: str) -> str:
    """Was von einem Befehl als Thema der Sitzung bleibt: kurz, ohne "Jarvis", ohne Passwörter."""
    text = " ".join(str(text or "").split())
    text = re.sub(r"^(?:(?:hey|ok|okay)\s+)?jarvis[,\s]+", "", text, flags=re.I).strip(" ,")
    if len(text) < 3 or _TRIVIAL.match(text) or is_secret(text):
        return ""
    text = text.rstrip(" .!")
    if len(text) > 70:
        text = text[:69].rstrip(" ,") + "…"
    return text[:1].upper() + text[1:]


def describe_session(session: dict) -> str:
    """"Fr 2.10. 20:00–20:40 (5 Befehle): Recherchiere …; Öffne Spotify" fürs Gehirn."""
    start = dt.datetime.fromisoformat(session["start"])
    try:
        end = dt.datetime.fromisoformat(str(session.get("ende") or session["start"]))
    except ValueError:
        end = start
    day = f"{WEEKDAY_NAMES[start.weekday()][:2]} {start.day}.{start.month}."
    count = int(session.get("anzahl") or 0)
    themes = "; ".join(session.get("themen") or [])
    return f"{day} {start:%H:%M}–{end:%H:%M} ({count} {'Befehl' if count == 1 else 'Befehle'}): {themes}"


def spoken_session(session: dict | None, now: dt.datetime) -> str:
    """Die Antwort auf "Was haben wir zuletzt gemacht?"."""
    if not session:
        return ("Dazu habe ich noch nichts, Sir. Ab jetzt merke ich mir Sitzung für Sitzung, woran wir arbeiten.")
    start = dt.datetime.fromisoformat(session["start"])
    days = (now.date() - start.date()).days
    if days == 0:
        when = f"heute ab {start:%H:%M} Uhr"
    elif days == 1:
        when = f"gestern ab {start:%H:%M} Uhr"
    elif days < 7:
        when = f"am {WEEKDAY_NAMES[start.weekday()]} ab {start:%H:%M} Uhr"
    else:
        when = f"am {start.day}. {MONTH_NAMES[start.month - 1]} ab {start:%H:%M} Uhr"
    themes = list(session.get("themen") or [])
    shown = themes[:4]
    more = len(themes) - len(shown)
    lead = "Gerade eben" if session.get("laufend") else "Zuletzt"
    text = f"{lead}, {when}, Sir: " + "; ".join(shown)
    if more > 0:
        text += f"; und {more} {'weiteres' if more == 1 else 'weitere'}"
    return text + "."


def match_memory(text: str):
    """("remember", fakt) / ("forget", wörter) / ("recall", "") / ("teach", (name, aktion)) /
    ("unteach", name) / ("commands", "") / ("session", "") / None"""
    raw = " ".join(str(text).split()).strip()
    if _RECALL.match(raw):
        return "recall", ""
    if _RECALL_SESSION.match(raw):
        return "session", ""
    if _LIST_COMMANDS.match(raw):
        return "commands", ""
    found = _UNTEACH.match(raw)
    if found:
        return "unteach", found.group("trigger").strip(" .!" + _QUOTES)
    for pattern in (_TEACH_SAY_FIRST, _TEACH_NAMED, _TEACH):
        found = pattern.match(raw)
        if (found and not found.group("action").rstrip().endswith("?") and not _MEANING.match(found.group("action"))
                and _is_name(command_key(found.group("trigger")))):
            return "teach", (found.group("trigger").strip(" ,.!" + _QUOTES), found.group("action").strip())
    found = _REMEMBER.match(raw)
    if found:
        fact = _LEAD.sub("", found.group("fact").strip())  # "Merk dir das: Max hat ..." -> "Max hat ..."
        if len(fact.strip(" .!")) >= 3 and not _NOT_A_FACT.match(fact) and not _ONLY_FILLER.match(fact):
            return "remember", _first_to_third(fact, clause=bool(found.group("dass")))
    found = _FORGET.match(raw)
    if found and len(found.group("fact").strip(" .!")) >= 3:
        return "forget", found.group("fact").strip(" .!")
    return None
