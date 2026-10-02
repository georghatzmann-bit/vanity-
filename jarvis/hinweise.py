"""Jarvis meldet sich von selbst: Hinweise, ohne dass Georg fragt.

Wie ein guter Butler sagt Jarvis Bescheid, wenn etwas seltsam ist: ein Programm reagiert nicht mehr,
ein Prozess frisst seit Minuten den Prozessor, der Arbeitsspeicher ist voll, der Akku fast leer,
das Internet ist weg, ein neues Programm startet heimlich mit Windows, Windows wartet seit Tagen auf
einen Neustart, die Grafikkarte wird sehr heiß. Und wenn Georg etwas zu vergessen droht: morgens ein
kurzer Überblick über den Tag, abends der frühe Termin von morgen, nachts um halb zwei der Hinweis, dass
um neun der Zahnarzt wartet, zwei Termine, die sich überschneiden, eine Mail von einem Menschen, die
seit gestern ungelesen ist, und was passiert ist, während er weg war. Nach drei Stunden am Stück schlägt
er eine Pause vor.

Die Regeln dafür: Nie beim Zocken oder im Vollbild, nie mitten in ein Gespräch, nicht dasselbe zweimal,
zwischen zwei Hinweisen ein paar Minuten Ruhe, und gesprochen wird nur, wenn Georg am PC sitzt (Dringendes
kommt sonst aufs Handy). "Nie wieder" nach einem Hinweis stellt diese Art Hinweis ab.

Die Prüfungen selbst sind einfache Funktionen über Messwerte (`Lage`), damit sie sich ohne Windows testen
lassen. Die Messwerte holt `SystemProbe` (psutil, Registry, Windows-API).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Was Jarvis beobachtet (alles in [hinweise] abschaltbar)
KINDS = ("pc", "internet", "sicherheit", "termine", "post", "morgens", "zurueck", "pausen")
# Wichtigkeit: 2 = dringend (auch aufs Handy), 1 = bald (sobald Georg da ist), 0 = wenn es passt
URGENT, SOON, NORMAL = 2, 1, 0

# Programme, über die Jarvis nicht meckert (Windows selbst, Virenschutz, Updates, Jarvis' Helfer)
_SYSTEM = {
    "system idle process", "system", "idle", "registry", "memory compression", "secure system", "smss.exe",
    "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "explorer.exe",
    "msmpeng.exe", "mssense.exe", "nissrv.exe", "tiworker.exe", "trustedinstaller.exe", "wuauclt.exe",
    "musnotification.exe", "searchindexer.exe", "searchprotocolhost.exe", "searchfilterhost.exe",
    "wmiprvse.exe", "audiodg.exe", "fontdrvhost.exe", "sihost.exe", "ctfmon.exe", "runtimebroker.exe",
    "taskhostw.exe", "spoolsv.exe", "conhost.exe", "dllhost.exe", "compattelrunner.exe", "msiexec.exe",
    "windows defender", "securityhealthservice.exe", "smartscreen.exe", "systemsettings.exe", "lockapp.exe",
    "startmenuexperiencehost.exe", "shellexperiencehost.exe", "textinputhost.exe", "widgets.exe",
    "mousocoreworker.exe", "usocoreworker.exe", "werfault.exe", "wermgr.exe",
}
# Programme, die absichtlich lange viel rechnen (Aufnahme, Videoschnitt, Entpacken, Downloads): kein Alarm
_HEAVY_BY_DESIGN = {
    "obs64.exe", "obs32.exe", "streamlabs obs.exe", "handbrake.exe", "ffmpeg.exe", "blender.exe", "resolve.exe",
    "adobe premiere pro.exe", "afterfx.exe", "steam.exe", "steamservice.exe", "epicgameslauncher.exe",
    "battle.net.exe", "7zg.exe", "7zfm.exe", "winrar.exe", "msbuild.exe", "cl.exe", "link.exe",
}


@dataclass
class Hint:
    """Ein Hinweis, den Jarvis von selbst sagt. Dieselbe Form wie memory.Occasion (key, label,
    question(), commands()), damit "Ja", "Nein" und "Nie wieder" genauso funktionieren."""

    key: str  # wiedererkennbar ("haengt:discord"), damit es nicht zweimal kommt
    kind: str  # Art für die Einstellungen (KINDS)
    text: str  # was Jarvis sagt
    offer: str = ""  # die Frage dazu ("Soll ich es neu starten?")
    command: str = ""  # was bei "Ja" passiert, als hätte Georg es gesagt
    action: Callable[[], str] | None = None  # oder das hier (gibt den Satz danach zurück)
    priority: int = NORMAL
    repeat_hours: float = 24.0  # frühestens dann wieder
    ttl: float = 30 * 60  # so lange darf er warten, bis es passt (Sekunden)
    group: str = ""  # "Nie wieder" gilt für alle Hinweise dieser Gruppe (leer = die Art)
    created: float = field(default_factory=time.monotonic)

    @property
    def label(self) -> str:
        return self.text[:60]

    def question(self) -> str:
        return f"{self.text} {self.offer}".strip()

    def commands(self) -> list[str]:
        return [self.command] if self.command else []

    def describe(self) -> str:
        return self.text

    @property
    def mute_key(self) -> str:
        return self.group or self.kind

    def expired(self, now: float | None = None) -> bool:
        return (time.monotonic() if now is None else now) - self.created > self.ttl


@dataclass
class Lage:
    """Wie es gerade aussieht (eine Messung). Alles optional: None = unbekannt."""

    now: dt.datetime
    idle: float = 0.0  # Sekunden ohne Maus und Tastatur
    hung: list[tuple[str, str]] | None = None  # (Programm, Prozessdatei) der Fenster, die nicht reagieren
    busy: list[tuple[str, float]] | None = None  # (Prozessdatei, Prozent der ganzen CPU)
    ram: float | None = None  # Prozent belegt
    ram_top: str = ""  # wer am meisten Arbeitsspeicher braucht (Prozessdatei)
    battery: tuple[int, bool] | None = None  # (Prozent, am Strom)
    online: bool | None = None
    reboot: bool | None = None
    autostart: dict[str, str] | None = None  # Eintrag -> Befehl
    gpu_temp: float | None = None
    foreground: str = ""  # Prozessdatei des Fensters, mit dem Georg gerade arbeitet

    @property
    def present(self) -> bool:
        return self.idle < 300


def app_name(image: str) -> str:
    """"Discord.exe" -> "Discord", "chrome.exe" -> "Chrome"."""
    name = re.sub(r"\.exe$", "", str(image or "").strip(), flags=re.I)
    known = {"msedge": "Edge", "chrome": "Chrome", "firefox": "Firefox", "code": "Visual Studio Code",
             "winword": "Word", "excel": "Excel", "powerpnt": "PowerPoint", "outlook": "Outlook",
             "olk": "Outlook", "steamwebhelper": "Steam", "obs64": "OBS", "vlc": "VLC"}
    if name.lower() in known:
        return known[name.lower()]
    return name[:1].upper() + name[1:] if name else ""


def _clock(when: dt.datetime) -> str:
    return f"{when.hour} Uhr" if when.minute == 0 else f"{when.hour}:{when.minute:02d} Uhr"


def _join(parts: list[str]) -> str:
    parts = [p for p in parts if p]
    if len(parts) < 2:
        return parts[0] if parts else ""
    return ", ".join(parts[:-1]) + " und " + parts[-1]


class Watcher:
    """Sammelt Hinweise. `check(lage, ...)` gibt neue zurück; was davon gesagt wird und wann, entscheidet
    der Assistent (Assistant.check_hints). Merkt sich, was wann gesagt wurde und was Georg abgestellt hat
    (daten/hinweise.json)."""

    def __init__(self, cfg: dict | None = None, state_path: Path | None = None) -> None:
        cfg = cfg or {}
        if "hinweise" in cfg:  # die ganze config.toml oder nur der Abschnitt [hinweise]
            cfg = cfg.get("hinweise") or {}
        self.enabled = bool(cfg.get("aktiv", True))
        self.kinds = {kind for kind in KINDS if cfg.get(kind, True)}
        self.session_hours = float(cfg.get("pause_nach_stunden", 3) or 0)
        self._path = Path(state_path) if state_path else None
        self._lock = threading.RLock()
        self._state = self._load()
        # Was über mehrere Messungen beobachtet wird
        self._hung_seen: dict[str, int] = {}
        self._busy_seen: dict[str, int] = {}
        self._ram_seen = 0
        self._gpu_seen = 0
        self._offline_seen = 0
        self._offline_said = False
        self._battery_said = 0  # Stufe, die in dieser Entladung schon gesagt wurde (1 = knapp, 2 = fast leer)
        self._last_idle = 0.0
        self._last_tick: dt.datetime | None = None
        self._active_since: float | None = None  # Sekunden-Zeitstempel (monotonic) seit Georg am Stück da ist
        self._session_said = False
        self._post_next = 0.0

    # ------------------------------------------------------------------ Gedächtnis

    def _load(self) -> dict:
        data: dict = {}
        if self._path is not None:
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
        if not isinstance(data, dict):
            data = {}
        for name, empty in (("gesagt", {}), ("aus", []), ("autostart", None), ("neustart_seit", "")):
            if not isinstance(data.get(name), type(empty)) and empty is not None:
                data[name] = empty
        return data

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temp = self._path.with_suffix(".tmp")
            temp.write_text(json.dumps(self._state, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temp, self._path)
        except OSError as exc:
            log.debug("Hinweise nicht gespeichert: %s", exc)

    def allowed(self, hint: Hint, now: dt.datetime | None = None) -> bool:
        """Darf dieser Hinweis jetzt kommen? Nicht, wenn die Art aus ist, Georg ihn abgestellt hat oder er
        vor Kurzem schon kam."""
        if not self.enabled or hint.kind not in self.kinds:
            return False
        now = now or dt.datetime.now()
        with self._lock:
            if self._state.get("pausiert") and hint.priority < URGENT:
                return False  # "Hinweise aus": nur noch Dringendes
            if hint.mute_key in self._state["aus"] or hint.key in self._state["aus"]:
                return False
            last = self._state["gesagt"].get(hint.key)
        if not last:
            return True
        try:
            return now - dt.datetime.fromisoformat(last) >= dt.timedelta(hours=hint.repeat_hours)
        except ValueError:
            return True

    def said(self, hint: Hint, now: dt.datetime | None = None) -> None:
        now = now or dt.datetime.now()
        with self._lock:
            said = self._state["gesagt"]
            said[hint.key] = now.isoformat(timespec="seconds")
            # Alte Einträge (älter als zwei Wochen) nicht ewig mitschleppen
            limit = (now - dt.timedelta(days=14)).isoformat(timespec="seconds")
            for key in [k for k, v in said.items() if str(v) < limit]:
                del said[key]
            self._save()

    def feedback(self, hint: Hint, answer: str) -> None:
        """"nie": diese Art Hinweis nicht mehr. "nein" und "ja" ändern nichts weiter."""
        if answer != "nie":
            return
        with self._lock:
            if hint.mute_key not in self._state["aus"]:
                self._state["aus"].append(hint.mute_key)
                self._save()

    def muted(self) -> list[str]:
        with self._lock:
            return list(self._state["aus"])

    def unmute_all(self) -> None:
        with self._lock:
            self._state["aus"] = []
            self._save()

    def pause(self, on: bool) -> None:
        """"Hinweise aus" (nur noch Dringendes) und "Hinweise wieder an" (dann auch alles Abgestellte)."""
        with self._lock:
            self._state["pausiert"] = bool(on)
            if not on:
                self._state["aus"] = []
            self._save()

    @property
    def paused(self) -> bool:
        with self._lock:
            return bool(self._state.get("pausiert"))

    def mark_brief(self, day: dt.date) -> None:
        """Der Überblick für heute ist schon gesagt (z. B. in der Begrüßung beim Start)."""
        with self._lock:
            self._state["ueberblick"] = day.isoformat()
            self._save()

    # ------------------------------------------------------------------ Prüfungen

    def check(self, lage: Lage, calendar=None, reminders=None, memory=None, weather: Callable[[], str] | str = "",
              away: Callable[[], list[str]] | None = None, push_at: Callable | None = None) -> list[Hint]:
        """Neue Hinweise aus einer Messung (und dem, was Kalender, Erinnerungen und Gedächtnis wissen).
        `away` liefert die Ansagen, die Georg verpasst hat (nur gefragt, wenn er gerade zurückkommt)."""
        if not self.enabled:
            return []
        hints: list[Hint] = []
        returned = self._presence(lage)
        for check in (self._hung, self._busy, self._ram, self._battery, self._gpu, self._internet,
                      self._reboot, self._autostart):
            try:
                hints += check(lage)
            except Exception:
                log.exception("Hinweis-Prüfung %s", check.__name__)
        try:
            hints += self._session(lage)
            if calendar is not None:
                hints += self._calendar(lage, calendar, push_at)
            if memory is not None:
                hints += self._plans(lage, memory)
            if returned is not None:
                missed = away() if away is not None else []
                hints += self._welcome(lage, returned, calendar, reminders, memory, weather, missed)
        except Exception:
            log.exception("Hinweise aus Kalender und Gedächtnis")
        return [h for h in hints if self.allowed(h, lage.now)]

    def _presence(self, lage: Lage) -> float | None:
        """Wie lange Georg weg war, wenn er gerade zurückgekommen ist (sonst None). Schlief der PC zwischen
        zwei Messungen, zählt die Zeit mit. Merkt sich außerdem, seit wann er am Stück da ist (Pause)."""
        returned = None
        if self._last_tick is not None:
            gap = max(0.0, (lage.now - self._last_tick).total_seconds())
            away = self._last_idle + (gap if gap > 120 else 0.0)
            if lage.present and away >= 15 * 60:
                returned = away
            if gap > 10 * 60:  # der PC hat geschlafen: das war eine Pause
                self._active_since = None
                self._session_said = False
        if lage.idle >= 10 * 60:
            self._active_since = None
            self._session_said = False
        elif self._active_since is None and lage.present:
            self._active_since = time.monotonic()
        self._last_idle, self._last_tick = lage.idle, lage.now
        return returned

    # ------------------------------------------------------------------ Seltsames am PC

    def _hung(self, lage: Lage) -> list[Hint]:
        if lage.hung is None or "pc" not in self.kinds:
            return []
        now_hung = {}
        for title, image in lage.hung:
            if image and image.lower() not in _SYSTEM:
                now_hung[image.lower()] = (title, image)
        self._hung_seen = {k: self._hung_seen.get(k, 0) + 1 for k in now_hung}
        hints = []
        for key, count in self._hung_seen.items():
            if count != 2:  # zweimal hintereinander (eine halbe Minute), dann einmal sagen
                continue
            _, image = now_hung[key]
            name = app_name(image)
            hints.append(Hint(f"haengt:{key}", "pc", f"Sir, {name} reagiert seit einer halben Minute nicht mehr.",
                              "Soll ich es neu starten?", action=lambda image=image, name=name: restart_hung(image, name),
                              priority=SOON, repeat_hours=1, ttl=5 * 60, group=f"haengt:{key}"))
        return hints

    def _busy(self, lage: Lage) -> list[Hint]:
        """Ein Programm (kein Windows-Dienst) braucht seit drei Minuten mehr als die Hälfte des Prozessors."""
        if lage.busy is None or "pc" not in self.kinds:
            return []
        heavy = {}
        skip = _SYSTEM | _HEAVY_BY_DESIGN | {lage.foreground.lower()}
        for image, percent in lage.busy:
            # Was Georg gerade vorne benutzt (ein Spiel im Fenster, ein Export), darf rechnen.
            if percent >= 50 and image and image.lower() not in skip:
                heavy[image.lower()] = image
        self._busy_seen = {k: self._busy_seen.get(k, 0) + 1 for k in heavy}
        hints = []
        for key, count in self._busy_seen.items():
            if count != 6:  # sechs Messungen à 30 Sekunden
                continue
            name = app_name(heavy[key])
            hints.append(Hint(f"cpu:{key}", "pc", f"Sir, {name} beschäftigt seit ein paar Minuten den halben Prozessor.",
                              f"Soll ich {name} schließen?", command=f"Schließ {name}", repeat_hours=6,
                              ttl=10 * 60, group=f"cpu:{key}"))
        return hints

    def _ram(self, lage: Lage) -> list[Hint]:
        if lage.ram is None or "pc" not in self.kinds:
            return []
        self._ram_seen = self._ram_seen + 1 if lage.ram >= 92 else 0
        if self._ram_seen != 3:
            return []
        top = app_name(lage.ram_top) if lage.ram_top and lage.ram_top.lower() not in _SYSTEM else ""
        if top:
            return [Hint("ram", "pc", f"Sir, der Arbeitsspeicher ist fast voll, am meisten braucht {top}.",
                         f"Soll ich {top} schließen?", command=f"Schließ {top}", priority=SOON, repeat_hours=4,
                         ttl=10 * 60)]
        return [Hint("ram", "pc", "Sir, der Arbeitsspeicher ist fast voll. Ein paar Programme zu schließen würde helfen.",
                     priority=SOON, repeat_hours=4, ttl=10 * 60)]

    def _battery(self, lage: Lage) -> list[Hint]:
        if lage.battery is None or "pc" not in self.kinds:
            return []
        percent, plugged = lage.battery
        if plugged:
            self._battery_said = 0
            return []
        if percent <= 7 and self._battery_said < 2:
            self._battery_said = 2
            return [Hint("akku:leer", "pc", f"Sir, der Akku ist fast leer: {percent} Prozent. Bitte das Ladekabel.",
                         priority=URGENT, repeat_hours=0.5, ttl=10 * 60, group="akku")]
        if percent <= 15 and self._battery_said < 1:
            self._battery_said = 1
            return [Hint("akku:knapp", "pc", f"Sir, der Akku hat nur noch {percent} Prozent.",
                         priority=SOON, repeat_hours=1, ttl=15 * 60, group="akku")]
        return []

    def _gpu(self, lage: Lage) -> list[Hint]:
        if lage.gpu_temp is None or "pc" not in self.kinds:
            return []
        self._gpu_seen = self._gpu_seen + 1 if lage.gpu_temp >= 88 else 0
        if self._gpu_seen != 2:
            return []
        return [Hint("gpu:heiss", "pc", f"Sir, die Grafikkarte hat {round(lage.gpu_temp)} Grad. Das ist sehr heiß, "
                     "ein Blick auf Lüfter und Staub könnte nicht schaden.", priority=SOON, repeat_hours=12,
                     ttl=20 * 60, group="gpu")]

    def _internet(self, lage: Lage) -> list[Hint]:
        if lage.online is None or "internet" not in self.kinds:
            return []
        if lage.online:
            self._offline_seen = 0
            if self._offline_said:
                self._offline_said = False
                return [Hint(f"internet:wieder:{lage.now:%Y%m%d%H%M}", "internet", "Das Internet ist wieder da, Sir.",
                             repeat_hours=0, ttl=10 * 60, group="internet")]
            return []
        self._offline_seen += 1
        if self._offline_seen == 2:  # zwei Messungen hintereinander (etwa zwei Minuten)
            self._offline_said = True
            return [Hint(f"internet:weg:{lage.now:%Y%m%d%H%M}", "internet",
                         "Sir, die Internetverbindung ist weg. Ich sage Bescheid, wenn sie wieder da ist.",
                         priority=SOON, repeat_hours=0, ttl=15 * 60, group="internet")]
        return []

    def _reboot(self, lage: Lage) -> list[Hint]:
        """Windows wartet seit über einem Tag auf einen Neustart für Updates."""
        if lage.reboot is None or "sicherheit" not in self.kinds:
            return []
        with self._lock:
            since = str(self._state.get("neustart_seit") or "")
            if not lage.reboot:
                if since:
                    self._state["neustart_seit"] = ""
                    self._save()
                return []
            if not since:
                self._state["neustart_seit"] = lage.now.isoformat(timespec="minutes")
                self._save()
                return []
        try:
            waiting = lage.now - dt.datetime.fromisoformat(since)
        except ValueError:
            return []
        if waiting < dt.timedelta(hours=20) or not 10 <= lage.now.hour < 22:
            return []
        days = waiting.days
        when = "seit gestern" if days <= 1 else f"seit {days} Tagen"
        return [Hint("neustart", "sicherheit", f"Sir, Windows wartet {when} auf einen Neustart für Updates. "
                     "Vielleicht heute Abend, wenn Sie fertig sind.", repeat_hours=72, ttl=60 * 60)]

    def _autostart(self, lage: Lage) -> list[Hint]:
        """Ein neues Programm startet mit Windows (das erste Mal merkt sich Jarvis nur, was schon da ist)."""
        if lage.autostart is None or "sicherheit" not in self.kinds:
            return []
        current = {name: str(value)[:300] for name, value in lage.autostart.items() if "jarvis" not in name.lower()}
        with self._lock:
            known = self._state.get("autostart")
            if known != sorted(current):
                self._state["autostart"] = sorted(current)
                self._save()
        if not isinstance(known, list):
            return []
        hints = []
        for name in sorted(set(current) - set(known))[:2]:
            shown = re.sub(r"^[^|]*\|", "", name)
            hints.append(Hint(f"autostart:{name.lower()}", "sicherheit",
                              f"Sir, seit eben startet ein neues Programm mit Windows: {shown}.",
                              "Soll ich nachsehen, ob das harmlos ist?",
                              command=f"Schau dir den Autostart-Eintrag „{shown}“ an (Befehl: {current[name]}) und sag mir "
                                      "kurz, was das ist und ob es harmlos ist. Nichts löschen.",
                              priority=SOON, repeat_hours=24 * 365, ttl=2 * 3600, group="autostart"))
        return hints

    # ------------------------------------------------------------------ Pausen

    def _session(self, lage: Lage) -> list[Hint]:
        if "pausen" not in self.kinds or self.session_hours <= 0 or self._session_said or not lage.present:
            return []
        if self._active_since is None:
            return []
        hours = (time.monotonic() - self._active_since) / 3600
        if hours < self.session_hours:
            return []
        self._session_said = True
        spoken = {2: "zwei", 3: "drei", 4: "vier", 5: "fünf"}.get(int(hours), str(int(hours)))
        return [Hint(f"pause:{lage.now:%Y%m%d%H}", "pausen", f"Sir, Sie sitzen seit {spoken} Stunden am Stück. "
                     "Fünf Minuten Pause würden Ihren Augen guttun.", repeat_hours=2, ttl=30 * 60, group="pausen")]

    # ------------------------------------------------------------------ Termine

    def _calendar(self, lage: Lage, calendar, push_at: Callable | None) -> list[Hint]:
        if "termine" not in self.kinds:
            return []
        now = lage.now
        hints = []
        tomorrow = now.date() + dt.timedelta(days=1)
        # Abends: der frühe Termin von morgen
        if 20 <= now.hour < 24 and lage.present:
            early = [e for e in calendar.day(tomorrow) if not e.all_day and e.start.hour < 10]
            if early:
                first = early[0]
                where = f" ({first.place})" if first.place else ""
                hint = Hint(f"morgen-frueh:{first.key}", "termine",
                            f"Sir, morgen um {_clock(first.start)} haben Sie {first.title}{where}.",
                            repeat_hours=20, ttl=60 * 60)
                if push_at is not None:
                    remind = first.start - dt.timedelta(hours=1)
                    if remind > now + dt.timedelta(hours=1):
                        hint.offer = f"Soll ich Sie um {_clock(remind)} aufs Handy erinnern?"
                        hint.action = lambda when=remind, event=first: push_at(
                            when, f"In einer Stunde: {event.title}" + (f" ({event.place})" if event.place else ""))
                hints.append(hint)
        # Spät nachts, und morgens wartet früh ein Termin
        if 0 <= now.hour < 4 and lage.present and (now.hour > 0 or now.minute >= 30):
            soon = [e for e in calendar.day(now.date()) if not e.all_day and now < e.start and e.start.hour < 11]
            if soon:
                first = soon[0]
                clock = f"halb {now.hour + 1}" if now.minute >= 30 else f"{now.hour} Uhr" if now.hour else "nach Mitternacht"
                hints.append(Hint(f"spaet:{now.date().isoformat()}", "termine",
                                  f"Sir, es ist schon {clock}, und um {_clock(first.start)} wartet {first.title}. "
                                  "Nur, damit Sie es wissen.", repeat_hours=20, ttl=60 * 60))
        # Zwei Termine in den nächsten zwei Tagen überschneiden sich
        events = [e for e in calendar.events(now, now + dt.timedelta(hours=48)) if not e.all_day and e.start > now]
        for index, first in enumerate(events):
            for second in events[index + 1:]:
                if second.start < first.end and first.title != second.title:
                    day = "heute" if first.start.date() == now.date() else "morgen" if first.start.date() == tomorrow \
                        else f"am {first.start.day}.{first.start.month}."
                    hints.append(Hint(f"ueberschneidung:{first.key}:{second.key}", "termine",
                                      f"Sir, {day} überschneiden sich zwei Termine: um {_clock(first.start)} {first.title} "
                                      f"und um {_clock(second.start)} {second.title}.", repeat_hours=24 * 7, ttl=2 * 3600,
                                      group="ueberschneidung"))
                    return hints
        return hints

    def _plans(self, lage: Lage, memory) -> list[Hint]:
        """Nachmittags, was Georg für heute vorhatte (aus dem Tagesrückblick), falls es morgens nicht schon
        im Überblick oder in der Begrüßung war."""
        plans_for = getattr(memory, "plans_for", None)
        if "termine" not in self.kinds or plans_for is None or not lage.present or not 13 <= lage.now.hour < 21:
            return []
        today = lage.now.date()
        plans = [p for p in plans_for(today) if p.get("erwaehnt") != today.isoformat()][:3]
        if not plans:
            return []
        memory.plans_mentioned(plans, today)
        return [Hint(f"vorhaben:{today.isoformat()}", "termine", "Übrigens, Sir: Sie wollten heute noch "
                     + _join([p["was"] for p in plans]) + ".", repeat_hours=20, ttl=2 * 3600, group="vorhaben")]

    # ------------------------------------------------------------------ Willkommen (morgens, zurück)

    def _welcome(self, lage: Lage, away_seconds: float, calendar, reminders, memory, weather,
                 away: list[str]) -> list[Hint]:
        """Georg kommt an den PC: morgens der Tagesüberblick, sonst (falls etwas war) "Während Sie weg waren"."""
        now = lage.now
        if "morgens" in self.kinds and 5 <= now.hour < 13 and self._state.get("ueberblick") != now.date().isoformat() \
                and away_seconds >= 3 * 3600:
            if callable(weather):
                try:
                    weather = weather()
                except Exception as exc:
                    log.debug("Überblick, Wetter: %s", exc)
                    weather = ""
            brief = morning_brief(now, calendar, reminders, memory, str(weather or ""), away)
            with self._lock:
                self._state["ueberblick"] = now.date().isoformat()
                self._save()
            if brief:
                return [Hint(f"morgens:{now.date().isoformat()}", "morgens", brief, priority=SOON, repeat_hours=12,
                             ttl=20 * 60)]
            return []
        if "zurueck" in self.kinds and away:
            items = list(dict.fromkeys(a.strip() for a in away if a and a.strip()))[:4]
            if items:
                text = "Willkommen zurück, Sir. Während Sie weg waren: " + " ".join(
                    i if i.endswith((".", "!", "?")) else i + "." for i in items)
                return [Hint(f"zurueck:{now:%Y%m%d%H%M}", "zurueck", text, priority=SOON, repeat_hours=0,
                             ttl=10 * 60, group="zurueck")]
        return []


    # ------------------------------------------------------------------ Post

    def post(self, now: dt.datetime, mail, people, read: Callable[[str], str | None] | None = None) -> list[Hint]:
        """Eine Mail von einem Menschen aus Georgs Kontakten, die seit gestern ungelesen ist (höchstens alle
        zwei Stunden nachgesehen, das braucht das Internet)."""
        if not self.enabled or "post" not in self.kinds or mail is None or not getattr(mail, "configured", False):
            return []
        if time.monotonic() < self._post_next or not 9 <= now.hour < 22:
            return []
        self._post_next = time.monotonic() + 2 * 3600
        from .mail import is_important

        try:
            _, messages = mail.unread(15, days=4)
        except Exception as exc:
            log.info("Hinweise, Mails: %s", exc)
            return []
        for message in messages:
            if not message.unread or message.date is None or not is_important(message, people):
                continue
            age = now - message.date
            if not dt.timedelta(hours=20) <= age <= dt.timedelta(days=4):
                continue
            days = (now.date() - message.date.date()).days
            when = "von gestern" if days <= 1 else f"vom {WEEKDAYS[message.date.weekday()]}"
            about = f", Betreff: {message.subject}" if message.subject else ""
            hint = Hint(f"post:{message.id}", "post", f"Sir, die Mail von {message.who} {when} ist noch ungelesen{about}.",
                        repeat_hours=24 * 30, ttl=2 * 3600, group="post")
            if read is not None:
                hint.offer = "Soll ich sie vorlesen?"
                hint.action = lambda who=message.who: read(who) or "Die Mail finde ich gerade nicht, Sir."
            if self.allowed(hint, now):
                return [hint]
        return []


WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]


def morning_brief(now: dt.datetime, calendar=None, reminders=None, memory=None, weather: str = "",
                  away: list[str] | None = None) -> str:
    """Der kurze Überblick am Morgen: Wetter, Termine, Erinnerungen, Geburtstage. Leer, wenn nichts ansteht."""
    parts: list[str] = []
    hello = "Guten Morgen, Sir." if now.hour < 11 else "Guten Tag, Sir."
    events = []
    if calendar is not None:
        try:
            events = [e for e in calendar.day(now.date()) if e.all_day or e.end > now]
        except Exception as exc:
            log.debug("Überblick, Kalender: %s", exc)
    if events:
        said = [e.title if e.all_day else f"um {_clock(e.start)} {e.title}" for e in events[:3]]
        more = f", und noch {len(events) - 3} weitere" if len(events) > 3 else ""
        parts.append(("Heute steht an: " if len(events) > 1 else "Heute: ") + _join(said) + more + ".")
    if reminders is not None:
        try:
            notes = []
            for item in reminders.upcoming(now):
                when = dt.datetime.fromisoformat(item["zeit"])
                text = str(item.get("text", "")).strip().rstrip(".")
                if when.date() == now.date() and not text.startswith("Ihr Wecker") and text != "Der Timer ist abgelaufen":
                    notes.append(f"um {_clock(when)} {text}")
            if notes:
                parts.append("Erinnerungen: " + _join(notes[:3]) + ".")
        except Exception as exc:
            log.debug("Überblick, Erinnerungen: %s", exc)
    if memory is not None:
        try:
            today = [b for b in memory.upcoming_birthdays(now, days=0) if not b.get("own")]
            if today:
                names = [b["shown"] for b in today[:3]]
                parts.append(f"{_join(names)} {'hat' if len(names) == 1 else 'haben'} heute Geburtstag.")
        except Exception as exc:
            log.debug("Überblick, Geburtstage: %s", exc)
        parts += plans_sentence(memory, now.date())
    for item in (away or [])[:2]:
        parts.append(item if item.endswith(".") else item + ".")
    if not parts and not weather:
        return ""
    if weather:
        parts.insert(0, weather.rstrip(".") + ".")
    return " ".join([hello] + parts)


def plans_sentence(memory, day: dt.date) -> list[str]:
    """"Sie wollten heute: zur Post gehen." aus den Vorhaben im Gedächtnis (danach als erwähnt markiert)."""
    plans_for = getattr(memory, "plans_for", None)
    if plans_for is None:
        return []
    try:
        plans = plans_for(day)[:3]
        if not plans:
            return []
        memory.plans_mentioned(plans, day)
    except Exception as exc:
        log.debug("Vorhaben: %s", exc)
        return []
    return ["Sie wollten heute: " + _join([p["was"] for p in plans]) + "."]


# ---------------------------------------------------------------------- Messen (Windows)

class SystemProbe:
    """Holt die Messwerte. Teure Dinge (Internet, Autostart, Neustart) nur alle paar Minuten."""

    def __init__(self) -> None:
        self._next: dict[str, float] = {}
        self._cache: dict[str, object] = {}
        self._procs: dict[int, object] = {}
        self._own: set[int] = set()

    def _every(self, name: str, seconds: float, fetch: Callable[[], object]) -> object:
        now = time.monotonic()
        if now >= self._next.get(name, 0.0):
            self._next[name] = now + seconds
            try:
                self._cache[name] = fetch()
            except Exception as exc:
                log.debug("Messung %s: %s", name, exc)
                self._cache[name] = None
        return self._cache.get(name)

    def measure(self, now: dt.datetime | None = None, idle: float = 0.0, gpu_temp: float | None = None) -> Lage:
        lage = Lage(now or dt.datetime.now(), idle=idle, gpu_temp=gpu_temp)
        lage.hung = hung_windows()
        lage.foreground = foreground_app()
        lage.busy, lage.ram, lage.ram_top = self._processes()
        lage.battery = battery()
        lage.online = self._every("online", 60, online)
        lage.reboot = self._every("reboot", 30 * 60, reboot_pending)
        lage.autostart = self._every("autostart", 10 * 60, autostart_entries)
        return lage

    def _processes(self) -> tuple[list[tuple[str, float]] | None, float | None, str]:
        """CPU je Programm (seit der letzten Messung, in Prozent der ganzen CPU), RAM belegt und wer am
        meisten Arbeitsspeicher braucht. Jarvis selbst und seine Helfer (Claude, Werkstatt) zählen nicht."""
        try:
            import psutil
        except ImportError:
            return None, None, ""
        try:
            me = psutil.Process()
            self._own = {me.pid} | {child.pid for child in me.children(recursive=True)}
        except Exception:
            self._own = {os.getpid()}
        cores = psutil.cpu_count() or 1
        cpu: dict[str, float] = {}
        memory: dict[str, int] = {}
        alive = {}
        for proc in psutil.process_iter(["name", "memory_info"]):
            if proc.pid in self._own or proc.pid == 0:
                continue
            known = self._procs.get(proc.pid, proc)
            alive[proc.pid] = known
            name = proc.info.get("name") or ""
            try:
                percent = known.cpu_percent(None) / cores
            except Exception:
                continue
            if proc.pid in self._procs:  # erst ab der zweiten Messung aussagekräftig
                cpu[name] = cpu.get(name, 0.0) + percent
            info = proc.info.get("memory_info")
            if info is not None:
                memory[name] = memory.get(name, 0) + int(getattr(info, "rss", 0))
        self._procs = alive
        busy = sorted(cpu.items(), key=lambda item: -item[1])[:5]
        top = max((n for n in memory if n.lower() not in _SYSTEM), key=lambda n: memory[n], default="")
        try:
            ram = float(psutil.virtual_memory().percent)
        except Exception:
            ram = None
        return busy, ram, top


def _user32():
    """user32 mit festen Argumenttypen (Fenster-Handles sind Zeiger, nicht int)."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    for name, args, result in (
        ("IsWindowVisible", [wintypes.HWND], wintypes.BOOL),
        ("IsHungAppWindow", [wintypes.HWND], wintypes.BOOL),
        ("GetWindowTextLengthW", [wintypes.HWND], ctypes.c_int),
        ("GetWindowTextW", [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
        ("GetWindowThreadProcessId", [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
        ("GetForegroundWindow", [], wintypes.HWND),
    ):
        function = getattr(user32, name)
        function.argtypes, function.restype = args, result
    return user32


def foreground_app() -> str:
    """Die Prozessdatei des Fensters ganz vorne ("Valorant.exe"), leer wenn unbekannt."""
    if os.name != "nt":
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        import psutil

        user32 = _user32()
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return psutil.Process(pid.value).name() if pid.value else ""
    except Exception:
        return ""


def hung_windows() -> list[tuple[str, str]] | None:
    """Sichtbare Fenster mit Titel, die nicht mehr reagieren: [(Titel, Prozessdatei)]."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        import psutil

        user32 = _user32()
        found: list[tuple[str, int]] = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def each(hwnd, _param):
            if user32.IsWindowVisible(hwnd) and user32.IsHungAppWindow(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buffer, length + 1)
                    pid = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    found.append((buffer.value, pid.value))
            return True

        user32.EnumWindows(callback_type(each), 0)
        result = []
        for title, pid in found:
            try:
                result.append((title, psutil.Process(pid).name()))
            except Exception:
                continue
        return result
    except Exception as exc:
        log.debug("Hängende Fenster: %s", exc)
        return None


def battery() -> tuple[int, bool] | None:
    try:
        import psutil

        info = psutil.sensors_battery()
    except Exception:
        return None
    if info is None:
        return None
    return int(round(info.percent)), bool(info.power_plugged)


def online(timeout: float = 4.0) -> bool:
    """Ist das Internet da? Dieselbe Adresse, mit der Windows es prüft, ersatzweise ein bekannter Server."""
    try:
        with urllib.request.urlopen("http://www.msftconnecttest.com/connecttest.txt", timeout=timeout) as response:
            if b"Microsoft" in response.read(200):
                return True
    except Exception:
        pass
    import socket

    for host in ("1.1.1.1", "8.8.8.8"):
        try:
            with socket.create_connection((host, 443), timeout=timeout):
                return True
        except OSError:
            continue
    return False


def reboot_pending() -> bool | None:
    if os.name != "nt":
        return None
    import winreg

    keys = (r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending")
    for path in keys:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path):
                return True
        except OSError:
            continue
    return False


def autostart_entries() -> dict[str, str] | None:
    """Was mit Windows startet: Run-Schlüssel (Benutzer und PC) und die Autostart-Ordner."""
    if os.name != "nt":
        return None
    import winreg

    found: dict[str, str] = {}
    places = [(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", "Benutzer"),
              (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "PC"),
              (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", "PC")]
    for root, path, where in places:
        try:
            with winreg.OpenKey(root, path) as key:
                index = 0
                while True:
                    try:
                        name, value, _ = winreg.EnumValue(key, index)
                    except OSError:
                        break
                    found[f"{where}|{name}"] = str(value)
                    index += 1
        except OSError:
            continue
    folders = [Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs/Startup",
               Path(os.environ.get("PROGRAMDATA", "")) / "Microsoft/Windows/Start Menu/Programs/StartUp"]
    for folder in folders:
        try:
            for item in folder.iterdir():
                if item.name.lower() != "desktop.ini":
                    found[f"Ordner|{item.stem}"] = str(item)
        except OSError:
            continue
    return found


def restart_hung(image: str, name: str) -> str:
    """Ein hängendes Programm hart beenden und neu starten."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/IM", image], capture_output=True, creationflags=NO_WINDOW)
        time.sleep(1.5)
    try:
        from . import apps

        apps.open_app(name)
    except Exception as exc:
        log.info("Neustart von %s: %s", name, exc)
        return f"{name} ist beendet, Sir. Von selbst starten ließ es sich nicht."
    return f"{name} startet neu, Sir."
