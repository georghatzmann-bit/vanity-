"""Die Kommandozentrale: Georgs Tag auf einen Blick, wie im Video "Ich nenne meinen Jarvis Luigi".

Oben steht, seit wann Jarvis im Dienst ist und was er heute schon erledigt hat (Aktivität), dazu Jarvis selbst
(Kugel, Zustand, Wissensnetz) und der Rechner. Darunter die Kennzahlen (Shop über Shopify, Werbekonten über
Windsor.ai, sonst Jarvis' eigene), der Tagesplan (Termine aus dem Kalender und Erinnerungen), der Posteingang
(Gmail), Nachrichten live (tagesschau24) und die Spezialisten mit ihrem Stand.

Mails, Termine, Shop und Werbekonten holt ein eigener Claude-Prozess im Hintergrund über Georgs Konnektoren
(lage.py, brain.connector_job): beim Start, dann alle `[zentrale] aktualisieren_minuten`, solange Georg am PC sitzt
und nicht spielt, und vor dem Briefing. Er darf nur lesen. Das Briefing ("Guten Morgen", "Briefing") liest Jarvis
danach in einem Rutsch vor, ohne auf Claude zu warten, und das Fenster hebt dabei hervor, wovon er gerade spricht.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable

from . import lage
from .ui import Ui

log = logging.getLogger(__name__)

MAX_EVENTS = 300
NEWS_SECONDS = 15 * 60
FRESH_MINUTES = 25  # so alt darf das Lagebild fürs Briefing sein
LIVE_STREAM = "https://tagesschau-live.ard-mcdn.de/tagesschau/live/hls/de/master.m3u8"
CHANNELS_API = "https://www.tagesschau.de/api2u/channels"
NEWS_API = "https://www.tagesschau.de/api2u/homepage"  # die Top-Meldungen der Startseite
USER_AGENT = "Jarvis/2.0 (Kommandozentrale)"

# Die Spezialisten auf der Zentrale. Posteingang, Kalender und Shop arbeiten fürs Lagebild, Recherche, Texte und
# Technik sind Jarvis' Helfer (helfer.py), wenn Claude ihnen etwas abgibt.
AGENTS = (
    {"id": "post", "name": "Posteingang", "kuerzel": "PO", "farbe": "#4f8cff", "leer": "Sichtet Ihre Mails"},
    {"id": "kalender", "name": "Kalender", "kuerzel": "KA", "farbe": "#c86bff", "leer": "Hält Ihren Tag im Blick"},
    {"id": "shop", "name": "Shop", "kuerzel": "SH", "farbe": "#ff9f43", "leer": "Behält Bestellungen im Blick"},
    {"id": "recherche", "name": "Recherche", "kuerzel": "RE", "farbe": "#5ad1ff", "leer": "Bereit für Ihre Fragen"},
    {"id": "texte", "name": "Texte", "kuerzel": "TX", "farbe": "#ff6bb5", "leer": "Schreibt Mails und Posts"},
    {"id": "technik", "name": "Technik", "kuerzel": "TE", "farbe": "#3ddc84", "leer": "Wacht über den Rechner"},
)
AGENT_STATES = ("bereit", "arbeitet", "schreibt", "wartet", "fertig", "fehler")
LAGE_AGENTS = ("post", "kalender", "shop")
REMIND_PREFIX = "In einer Viertelstunde: "

_ART = re.compile(r"^[a-z]{2,16}$")


def _now() -> dt.datetime:
    return dt.datetime.now()


def _https(url) -> bool:
    return isinstance(url, str) and url.startswith("https://") and len(url) < 400


def _image(item: dict, sizes: tuple[str, ...]) -> str:
    """Das Vorschaubild einer Meldung oder Sendung der Tagesschau in einer der gewünschten Größen."""
    variants = ((item or {}).get("teaserImage") or {}).get("imageVariants") or {}
    for size in sizes:
        url = variants.get(size)
        if _https(url) and url.startswith("https://images.tagesschau.de/"):
            return url
    return ""


def _one(count: int, word: str = "eine") -> str:
    """1 -> "eine" (eine Mail, eine Bestellung), sonst die Zahl."""
    return word if count == 1 else str(count)


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def euro(value: float | None, currency: str = "EUR") -> str:
    """1234.5 -> "1.234,50 €" (ganze Beträge ohne Nachkommastellen)."""
    if value is None:
        return "–"
    sign = {"EUR": "€", "USD": "$", "GBP": "£", "CHF": "CHF"}.get(currency, currency)
    whole = abs(value - round(value)) < 0.005
    text = f"{value:,.0f}" if whole else f"{value:,.2f}"
    text = text.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{text} {sign}"


def number(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "–"
    text = f"{value:,.{digits}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return text


def _clock(when: dt.datetime) -> str:
    return f"{when:%H:%M}"


def _spoken_clock(text: str) -> str:
    """"14:00" -> "14 Uhr", "09:30" -> "9:30 Uhr" (die Aussprache macht daraus "neun Uhr dreißig")."""
    found = re.match(r"^(\d{1,2}):(\d{2})$", text or "")
    if not found:
        return text
    hour, minute = int(found.group(1)), found.group(2)
    return f"{hour} Uhr" if minute == "00" else f"{hour}:{minute} Uhr"


class Zentrale:
    """Hält alles für die Kommandozentrale zusammen und meldet Änderungen an die Anzeige (ui.zentrale)."""

    def __init__(self, cfg: dict, brain, ui, state_dir: Path, assistant=None,
                 tell: Callable[[str], None] | None = None, spoken: Callable[..., bool] | None = None,
                 now: Callable[[], dt.datetime] = _now, opener=None, show_window: Callable[[], None] | None = None) -> None:
        section = cfg.get("zentrale", {}) or {}
        self.minutes = max(10, int(section.get("aktualisieren_minuten", 30) or 30))
        self.model = str(section.get("modell", "sonnet") or "sonnet")
        self.effort = str(section.get("effort", "low") or "")
        self._brain = brain
        self._ui = ui
        self._assistant = assistant
        self._tell = tell or (lambda text: None)
        self._spoken = spoken or (lambda timeout=None: True)
        self._now = now
        self._opener = opener or urllib.request.urlopen
        self._show_window = show_window
        self.folder = Path(state_dir) / "zentrale"
        self._lock = threading.RLock()
        self.started = now()
        self._events: list[dict] = []
        self._day = self.started.date()
        self._load_events()
        self._agents = {a["id"]: {"status": "bereit", "text": "", "zeit": "", "fortschritt": None} for a in AGENTS}
        self.lage: dict = {}
        self.lage_at: dt.datetime | None = None
        self.lage_error = ""
        self._lage_running = threading.Event()
        self._lage_done = threading.Event()
        self._load_lage()
        self._news: dict = {}
        self._news_at = 0.0
        self.briefed: dt.date | None = None
        self._brief_run = 0  # zählt jedes Briefing, ein altes hört dann auf
        self._briefing = False
        self.stats: dict = {}
        self._emit_at = 0.0
        self._emit_timer: threading.Timer | None = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------ Anzeige

    def _emit(self, action: str, **data) -> None:
        try:
            self._ui.zentrale({"action": action, **data})
        except AttributeError:
            pass  # eine Anzeige ohne Zentrale (Konsole)
        except Exception as exc:
            log.debug("Zentrale, Anzeige: %s", exc)

    def changed(self) -> None:
        """Das Fenster neu füllen, höchstens alle 2 Sekunden (viele kleine Änderungen werden eine)."""
        with self._lock:
            if self._emit_timer is not None:
                return
            delay = max(0.0, 2.0 - (time.monotonic() - self._emit_at))
            self._emit_timer = threading.Timer(delay, self._flush)
            self._emit_timer.daemon = True
            self._emit_timer.start()

    def _flush(self) -> None:
        with self._lock:
            self._emit_timer = None
            self._emit_at = time.monotonic()
        try:
            self._emit("update", data=self.snapshot())
        except Exception as exc:
            log.debug("Zentrale, Stand: %s", exc)

    def focus(self, area: str) -> None:
        """Beim Vorlesen: diesen Bereich im Fenster hervorheben ("" = keinen)."""
        self._emit("focus", bereich=str(area or ""))

    # ------------------------------------------------------------------ Aktivität

    def _events_file(self, day: dt.date) -> Path:
        return self.folder / f"aktivitaet-{day.isoformat()}.json"

    def _load_events(self) -> None:
        try:
            data = json.loads(self._events_file(self._day).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, list):
            self._events = [e for e in data if isinstance(e, dict) and e.get("text")][-MAX_EVENTS:]

    def _save_events(self) -> None:
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            path = self._events_file(self._day)
            temp = path.with_name(path.name + ".tmp")
            temp.write_text(json.dumps(self._events, ensure_ascii=False), encoding="utf-8")
            temp.replace(path)
        except OSError as exc:
            log.debug("Zentrale, Aktivität speichern: %s", exc)

    def _roll_day(self) -> None:
        today = self._now().date()
        if today != self._day:
            self._day = today
            self._events = []

    def log(self, art: str, text: str, detail: str = "") -> None:
        """Etwas, das Jarvis erledigt hat, in die Aktivität ("Spotify geöffnet", "Lagebild: 17 Mails")."""
        text = " ".join(str(text or "").split())[:90]
        if not text:
            return
        art = art if _ART.match(str(art or "")) else "befehl"
        with self._lock:
            self._roll_day()
            now = self._now()
            self._events.append({"zeit": _clock(now), "ts": round(now.timestamp()), "art": art, "text": text,
                                 "detail": " ".join(str(detail or "").split())[:120]})
            del self._events[:-MAX_EVENTS]
            self._save_events()
        self.changed()

    def events_today(self) -> list[dict]:
        with self._lock:
            self._roll_day()
            return list(self._events)

    def on_duty_since(self) -> dt.datetime:
        """Seit wann Jarvis heute im Dienst ist: Start heute, sonst die erste Aktivität, sonst Mitternacht."""
        now = self._now()
        if self.started.date() == now.date():
            return self.started
        events = self.events_today()
        if events:
            return dt.datetime.fromtimestamp(events[0]["ts"])
        return now.replace(hour=0, minute=0, second=0, microsecond=0)

    # ------------------------------------------------------------------ Spezialisten

    def agent(self, key: str, status: str, text: str = "", progress: float | None = None) -> None:
        """Stand eines Spezialisten: bereit, arbeitet, schreibt, wartet (auf Georg), fertig, fehler."""
        if key not in self._agents or status not in AGENT_STATES:
            return
        with self._lock:
            entry = self._agents[key]
            entry["status"] = status
            entry["text"] = " ".join(str(text or "").split())[:80]
            entry["zeit"] = _clock(self._now())
            entry["fortschritt"] = None if progress is None else max(0.0, min(1.0, float(progress)))
        self.changed()

    def helper_step(self, step: dict) -> None:
        """Ein Arbeitsschritt von Claude (progress): gibt Claude einem Helfer etwas ab (Werkzeug Agent/Task),
        steht das auf der Karte des Spezialisten."""
        if not isinstance(step, dict) or str(step.get("tool") or "") not in ("Agent", "Task"):
            return
        who = str(step.get("agent") or "")
        if who not in ("recherche", "texte", "technik"):
            return
        if step.get("state") == "running":
            self.agent(who, "schreibt" if who == "texte" else "arbeitet", str(step.get("detail") or step.get("label") or ""))
        elif step.get("state") == "done":
            self.agent(who, "fertig", str(step.get("detail") or "Erledigt"))
            self.log(who, f"{dict((a['id'], a['name']) for a in AGENTS)[who]}: {step.get('detail') or 'erledigt'}")
        else:
            self.agent(who, "fehler", "Hat nicht geklappt")

    # ------------------------------------------------------------------ Lagebild (Konnektoren)

    def _lage_file(self) -> Path:
        return self.folder / "lage.json"

    def _load_lage(self) -> None:
        try:
            data = json.loads(self._lage_file().read_text(encoding="utf-8"))
            at = dt.datetime.fromisoformat(str(data.get("zeit")))
        except (OSError, ValueError, TypeError, AttributeError):
            return
        if at.date() == self._now().date() and isinstance(data.get("lage"), dict):
            self.lage = lage.clean(data["lage"])
            self.lage_at = at

    def _save_lage(self) -> None:
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            payload = {"zeit": self.lage_at.isoformat(timespec="seconds") if self.lage_at else "", "lage": self.lage}
            self._lage_file().write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            log.debug("Zentrale, Lagebild speichern: %s", exc)

    def lage_fresh(self, minutes: int = FRESH_MINUTES) -> bool:
        return self.lage_at is not None and (self._now() - self.lage_at).total_seconds() < minutes * 60

    def _system_file(self) -> Path:
        path = self.folder / "lage-anleitung.md"
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            if not path.exists() or path.read_text(encoding="utf-8") != lage.SYSTEM_PROMPT:
                path.write_text(lage.SYSTEM_PROMPT, encoding="utf-8")
        except OSError as exc:
            log.debug("Zentrale, Anleitung: %s", exc)
        return path

    def can_refresh(self) -> bool:
        brain = self._brain
        return brain is not None and bool(getattr(brain, "claude_path", "")) and hasattr(brain, "connector_job") \
            and bool(getattr(brain, "connectors", True))

    def refresh(self, reason: str = "") -> bool:
        """Das Lagebild im Hintergrund neu holen. False, wenn es gerade läuft oder nicht geht."""
        if not self.can_refresh() or self._lage_running.is_set():
            return False
        self._lage_running.set()
        self._lage_done.clear()
        threading.Thread(target=self._refresh_work, args=(reason,), name="jarvis-lagebild", daemon=True).start()
        return True

    def wait_lage(self, timeout: float) -> bool:
        """Wartet, bis ein laufendes Lagebild fertig ist. True, wenn keins (mehr) läuft."""
        if not self._lage_running.is_set():
            return True
        return self._lage_done.wait(timeout)

    def _connectors(self) -> list[str]:
        try:
            from . import konnektoren

            return [c["name"] for c in konnektoren.seen() if c.get("ok")]
        except Exception:
            return []

    def _refresh_work(self, reason: str) -> None:
        started = time.monotonic()
        for key in LAGE_AGENTS:
            self.agent(key, "arbeitet", {"post": "Liest den Posteingang", "kalender": "Liest den Kalender",
                                         "shop": "Prüft Bestellungen"}[key], 0.3)
        try:
            text = self._brain.connector_job(lage.prompt(self._connectors(), self._now()), self._system_file(),
                                             model=self.model, effort=self.effort, allow=lage.read_only, timeout=240)
            data = lage.parse(text)
        except Exception as exc:
            reason_text = str(exc).strip().splitlines()[0][:160] if str(exc).strip() else type(exc).__name__
            log.info("Lagebild: %s", reason_text)
            with self._lock:
                self.lage_error = reason_text
            for key in LAGE_AGENTS:
                self.agent(key, "fehler", "Kam gerade nicht durch")
            self._lage_running.clear()
            self._lage_done.set()
            self.changed()
            return
        with self._lock:
            self.lage = data
            self.lage_at = self._now()
            self.lage_error = ""
            self._save_lage()
        seconds = time.monotonic() - started
        post, calendar, shop = data.get("post"), data.get("kalender"), data.get("shop")
        if post is not None:
            important = sum(1 for m in post["mails"] if m["status"] == "wichtig")
            count = post.get("neu") if post.get("neu") is not None else len(post["mails"])
            self.agent("post", "wartet" if important else "fertig",
                       f"{count} neue Mails" + (f" · {important} wichtig" if important else " gesichtet"))
        else:
            self.agent("post", "bereit", "Gmail nicht verbunden")
        if calendar is not None:
            self.agent("kalender", "fertig", f"{len(calendar['heute'])} Termine heute" +
                       (f" · {calendar['woche']} diese Woche" if calendar.get("woche") else ""))
        else:
            self.agent("kalender", "bereit", "Kalender nicht verbunden")
        if shop is not None:
            self.agent("shop", "fertig", f"{shop.get('bestellungen_heute') or 0} Bestellungen heute"
                       + (f" · {shop['offen']} offen" if shop.get("offen") else ""))
        else:
            self.agent("shop", "bereit", "Shop nicht verbunden")
        parts = []
        if post is not None:
            parts.append(f"{post.get('neu') if post.get('neu') is not None else len(post['mails'])} Mails")
        if calendar is not None:
            parts.append(f"{len(calendar['heute'])} Termine")
        if shop is not None:
            parts.append(f"{shop.get('bestellungen_heute') or 0} Bestellungen")
        self.log("lage", "Lagebild aktualisiert" + (": " + ", ".join(parts) if parts else ""), reason)
        log.info("Lagebild nach %.0f s: %s", seconds, ", ".join(parts) or "ohne Konnektoren")
        self._remind_important()
        self._lage_running.clear()
        self._lage_done.set()
        self.changed()

    def _remind_important(self) -> None:
        """Für den wichtigsten Termin des Tages eine Erinnerung eine Viertelstunde vorher (wie im Video:
        "Und ich werde Sie rechtzeitig daran erinnern"), falls es noch keine gibt."""
        event = self.important_event()
        store = getattr(self._assistant, "reminders", None)
        if event is None or store is None or not hasattr(store, "add"):
            return
        found = re.match(r"^(\d{2}):(\d{2})$", event["start"])
        if not found:
            return
        now = self._now()
        start = now.replace(hour=int(found.group(1)), minute=int(found.group(2)), second=0, microsecond=0)
        when = start - dt.timedelta(minutes=15)
        if when <= now:
            return
        try:
            for r in store.upcoming(now):
                if abs((dt.datetime.fromisoformat(r["zeit"]) - when).total_seconds()) < 20 * 60:
                    return
            store.add(when, f"{REMIND_PREFIX}{event['titel']}")
        except Exception as exc:
            log.debug("Zentrale, Erinnerung: %s", exc)

    def reminded(self, event: dict | None) -> bool:
        """Gibt es für diesen Termin schon eine Erinnerung kurz vorher (von Jarvis oder von Georg)?"""
        store = getattr(self._assistant, "reminders", None)
        found = re.match(r"^(\d{2}):(\d{2})$", (event or {}).get("start", ""))
        if store is None or not found:
            return False
        now = self._now()
        start = now.replace(hour=int(found.group(1)), minute=int(found.group(2)), second=0, microsecond=0)
        try:
            for r in store.upcoming(now - dt.timedelta(hours=1)):
                delta = (start - dt.datetime.fromisoformat(r["zeit"])).total_seconds()
                if 0 <= delta <= 60 * 60:
                    return True
        except Exception as exc:
            log.debug("Zentrale, Erinnerungen prüfen: %s", exc)
        return False

    def important_event(self) -> dict | None:
        calendar = (self.lage or {}).get("kalender") or {}
        events = [e for e in calendar.get("heute") or [] if e["start"] != "Tag"]
        if not events:
            return None
        now = _clock(self._now())
        upcoming = [e for e in events if e["start"] >= now]
        flagged = [e for e in upcoming if e.get("wichtig")]
        return (flagged or upcoming or [None])[0]

    def tick(self) -> None:
        """Einmal pro Minute (aus __main__): Lagebild auffrischen, wenn es alt ist, Georg am PC sitzt und nicht spielt."""
        assistant = self._assistant
        gaming = bool(getattr(assistant, "gaming", False))
        away = False
        if hasattr(assistant, "idle"):
            try:
                away = assistant.idle() > 30 * 60
            except Exception:
                away = False
        stale = self.lage_at is None or (self._now() - self.lage_at).total_seconds() > self.minutes * 60
        if stale and not gaming and not away and time.monotonic() > getattr(self, "_next_try", 0.0):
            if self.refresh("Zeitplan"):
                self._next_try = time.monotonic() + 5 * 60  # nach einem Fehler nicht sofort wieder

    def start(self) -> None:
        """Erstes Lagebild kurz nach dem Start, danach tick() jede Minute."""

        def loop() -> None:
            if self._stop.wait(45):
                return
            while not self._stop.is_set():
                try:
                    self.tick()
                    self.news()
                except Exception as exc:
                    log.debug("Zentrale: %s", exc)
                if self._stop.wait(60):
                    return

        threading.Thread(target=loop, name="jarvis-zentrale", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------ Nachrichten

    def _get(self, url: str, timeout: float = 6) -> dict:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with self._opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def news(self, fresh: bool = False) -> dict:
        """Live-Stream, das neueste Video ("tagesschau in 100 Sekunden") und die Schlagzeilen, alle 15 Minuten neu."""
        with self._lock:
            if self._news and not fresh and time.monotonic() - self._news_at < NEWS_SECONDS:
                return dict(self._news)
        result = {"live": LIVE_STREAM, "video": "", "video_titel": "", "video_bild": "", "schlagzeilen": []}
        try:
            data = self._get(CHANNELS_API)
            for channel in data.get("channels") or []:
                streams = channel.get("streams") or {}
                title = str(channel.get("title") or "")
                if "livestream" in title.lower() and _https(streams.get("adaptivestreaming")):
                    result["live"] = streams["adaptivestreaming"]
                elif not result["video"] and _https(streams.get("h264m")):
                    result["video"] = streams["h264m"]
                    result["video_titel"] = title[:60]
                    result["video_bild"] = _image(channel, ("16x9-512", "16x9-256", "1x1-432", "1x1-256"))
        except Exception as exc:
            log.debug("Zentrale, Sendungen: %s", exc)
        try:
            data = self._get(NEWS_API)
            seen = set()
            for raw in data.get("news") or []:
                title = " ".join(str(raw.get("title") or "").split())
                if not title or title.lower() in seen or raw.get("type") == "video":
                    continue
                seen.add(title.lower())
                link = str(raw.get("shareURL") or raw.get("detailsweb") or "")
                result["schlagzeilen"].append({"titel": title[:110], "oben": " ".join(str(raw.get("topline") or "").split())[:50],
                                               "bild": _image(raw, ("16x9-512", "16x9-256")),
                                               "link": link if _https(link) and "tagesschau.de/" in link else ""})
                if len(result["schlagzeilen"]) >= 6:
                    break
        except Exception as exc:
            log.debug("Zentrale, Schlagzeilen: %s", exc)
        with self._lock:
            if result["schlagzeilen"] or not self._news:
                self._news = result
                self._news_at = time.monotonic()
            return dict(self._news)

    # ------------------------------------------------------------------ Was im Fenster steht

    def _reminders_today(self) -> list[dict]:
        store = getattr(self._assistant, "reminders", None)
        if store is None:
            return []
        now = self._now()
        out = []
        try:
            for r in store.upcoming(now):
                when = dt.datetime.fromisoformat(r["zeit"])
                text = str(r.get("text") or "Erinnerung")
                if when.date() != now.date() or text.startswith(REMIND_PREFIX):
                    continue  # die Erinnerung an den wichtigsten Termin steht schon beim Termin
                out.append({"start": _clock(when), "ende": _clock(when + dt.timedelta(minutes=30)),
                            "titel": text[:60], "art": "erinnerung", "wichtig": False})
        except Exception as exc:
            log.debug("Zentrale, Erinnerungen: %s", exc)
        return out

    def _notes(self) -> tuple[int, list[str]]:
        """(Zahl der Notizen im Notizbuch, die letzten Schnellnotizen oder was Jarvis über Georg weiß)."""
        notebook = getattr(self._assistant, "notebook", None)
        count, latest = 0, []
        folder = getattr(notebook, "folder", None)
        if folder is not None:
            try:
                count = sum(1 for _ in Path(folder).rglob("*.md"))
                quick = Path(folder) / "Notizen" / "Schnellnotizen.md"
                if quick.is_file():
                    lines = [line for line in quick.read_text(encoding="utf-8").splitlines() if line.startswith("- ")]
                    latest = [re.sub(r"^- \*\*[^*]+\*\*\s*", "", line)[:60] for line in lines[-3:]][::-1]
            except OSError:
                pass
        if not latest:
            memory = getattr(self._assistant, "memory", None)
            try:
                facts = memory.facts() if memory is not None else []
                latest = [str(f.get("text") or "")[:60] for f in facts[-3:] if f.get("text")][::-1]
            except Exception:
                latest = []
        return count, latest

    def _games(self) -> dict | None:
        games = getattr(self._assistant, "games", None)
        if games is None:
            return None
        try:
            found = [g for g in games.installed() if not getattr(g, "tool", False)]
        except Exception:
            return None
        if not found:
            return None
        updates = [g for g in found if g.needs_update]
        size = sum(g.size for g in found)
        biggest = sorted(found, key=lambda g: g.size, reverse=True)[:3]
        return {"titel": "Spiele", "werte": [
            {"name": "Installiert", "wert": str(len(found))},
            {"name": "Brauchen Updates", "wert": str(len(updates))},
            {"name": "Auf der Platte", "wert": f"{size / 1e9:,.0f} GB".replace(",", ".")},
            {"name": "Steam / Epic", "wert": f"{sum(1 for g in found if g.store == 'steam')} / "
                                             f"{sum(1 for g in found if g.store == 'epic')}"}],
            "zeilen": [{"name": g.name[:22], "wert": f"{g.size / 1e9:,.0f} GB".replace(",", "."),
                        "trend": "Update" if g.needs_update else ""} for g in biggest]}

    def _account(self) -> dict | None:
        """Die Karte oben links: Werbekonten, sonst der Shop, sonst die Spiele."""
        data = self.lage or {}
        ads, shop = data.get("werbung"), data.get("shop")
        if ads:
            return {"titel": "Werbekonten", "werte": [
                {"name": "Ausgaben heute", "wert": euro(ads.get("ausgaben"))},
                {"name": "ROAS gesamt", "wert": number(ads.get("roas"))}],
                "zeilen": [{"name": a["name"], "wert": euro(a.get("ausgaben")), "trend": number(a.get("roas"))}
                           for a in ads["konten"]]}
        if shop:
            currency = shop.get("waehrung") or "EUR"
            return {"titel": "Shop" + (f" · {shop['name']}" if shop.get("name") else ""), "werte": [
                {"name": "Bestellungen heute", "wert": str(shop.get("bestellungen_heute") or 0)},
                {"name": "Umsatz heute", "wert": euro(shop.get("umsatz_heute"), currency)},
                {"name": "Offen", "wert": str(shop.get("offen") or 0)},
                {"name": "Gestern", "wert": euro(shop.get("umsatz_gestern"), currency)}], "zeilen": []}
        return self._games()

    def _questions(self) -> int:
        """Rückfragen an Georg: ein Vorschlag, auf den er noch nicht geantwortet hat, die Werkstatt wartet auf ihn ..."""
        assistant = self._assistant
        count = 0
        try:
            if assistant is not None and hasattr(assistant, "offer_open") and assistant.offer_open():
                count += 1
            workshop = getattr(assistant, "workshop", None)
            if workshop is not None and hasattr(workshop, "waits_for_answer") and workshop.waits_for_answer():
                count += 1
        except Exception as exc:
            log.debug("Zentrale, Rückfragen: %s", exc)
        post = (self.lage or {}).get("post") or {}
        count += sum(1 for m in post.get("mails") or [] if m["status"] == "wichtig")
        return count

    def _figures(self) -> list[dict]:
        """Die Kennzahlen-Reihe: die erste groß. Werbekonten, sonst Shop, sonst Jarvis' eigener Tag."""
        data = self.lage or {}
        ads, shop, post = data.get("werbung"), data.get("shop"), data.get("post")
        events = self.events_today()
        if ads:
            accounts = ads["konten"]
            cpc = [a["klickpreis"] for a in accounts if a.get("klickpreis") is not None]
            figures = [
                {"name": "ROAS über alle Konten", "wert": number(ads.get("roas")), "unter": f"{len(accounts)} Konten", "gross": True},
                {"name": "Ausgaben heute", "wert": euro(ads.get("ausgaben")), "unter": "alle Konten"},
                {"name": "Klickpreis Ø", "wert": euro(sum(cpc) / len(cpc)) if cpc else "–", "unter": "über alle Konten"},
            ]
        elif shop:
            currency = shop.get("waehrung") or "EUR"
            orders = shop.get("bestellungen_heute") or 0
            basket = (shop.get("umsatz_heute") or 0) / orders if orders else None
            figures = [
                {"name": "Umsatz heute", "wert": euro(shop.get("umsatz_heute"), currency),
                 "unter": f"gestern {euro(shop.get('umsatz_gestern'), currency)}", "gross": True},
                {"name": "Bestellungen heute", "wert": str(orders), "unter": f"gestern {shop.get('bestellungen_gestern') or 0}"},
                {"name": "Ø Warenkorb", "wert": euro(basket, currency) if basket is not None else "–", "unter": "heute"},
                {"name": "Warten auf Versand", "wert": str(shop.get("offen") or 0), "unter": "offene Bestellungen"},
            ]
        else:
            figures = [
                {"name": "Heute erledigt", "wert": str(len(events)), "unter": f"seit {_clock(self.on_duty_since())} Uhr",
                 "gross": True},
            ]
        if post is not None and len(figures) < 4:
            figures.append({"name": "Neue Mails", "wert": str(post.get("neu") if post.get("neu") is not None else len(post["mails"])),
                            "unter": f"{post.get('ungelesen') or 0} ungelesen"})
        calendar = data.get("kalender")
        if calendar is not None and len(figures) < 4:
            figures.append({"name": "Termine heute", "wert": str(len(calendar["heute"])),
                            "unter": f"{calendar.get('woche') or len(calendar['heute'])} diese Woche"})
        reminders = self._reminders_today()
        if len(figures) < 4:
            figures.append({"name": "Erinnerungen heute", "wert": str(len(reminders)), "unter": "noch offen"})
        if len(figures) < 4:
            figures.append({"name": "Gesprochen", "wert": str(sum(1 for e in events if e["art"] == "befehl")),
                            "unter": "Befehle heute"})
        questions = self._questions()
        figures.append({"name": "Rückfragen an Sie", "wert": str(questions), "unter": "aktuell offen",
                        "warn": questions > 0})
        return figures[:5]

    def _plan(self) -> dict:
        data = self.lage or {}
        calendar = data.get("kalender") or {}
        items = [dict(e, art="termin") for e in calendar.get("heute") or []] + self._reminders_today()
        items.sort(key=lambda e: ("" if e["start"] == "Tag" else e["start"]))
        important = self.important_event()
        for item in items:
            item["wichtig"] = bool(important is not None and item.get("art") == "termin"
                                   and item["start"] == important["start"] and item["titel"] == important["titel"])
        week = calendar.get("woche")
        return {"eintraege": items[:14], "woche": week if week is not None else len(calendar.get("heute") or []),
                "verbunden": "kalender" in data}

    def _done_chips(self) -> list[dict]:
        data = self.lage or {}
        fresh = self.lage_at is not None and self.lage_at.date() == self._now().date()
        chips = [{"text": "Posteingang gesichtet", "ok": fresh and "post" in data},
                 {"text": "Kalender sortiert", "ok": fresh and "kalender" in data}]
        if "shop" in data:
            chips.append({"text": "Shop geprüft", "ok": fresh})
        if "werbung" in data:
            chips.append({"text": "Werbekonten geprüft", "ok": fresh})
        chips.append({"text": "Briefing", "ok": self.briefed == self._now().date()})
        important = self.important_event()
        if important is not None:
            chips.append({"text": "Termin vorbereitet", "ok": self.reminded(important)})
        return chips

    def snapshot(self) -> dict:
        """Alles, was die Zentrale im Fenster zeigt."""
        now = self._now()
        events = self.events_today()
        notes_count, notes = self._notes()
        memory = getattr(self._assistant, "memory", None)
        facts = 0
        try:
            facts = len(memory.facts()) if memory is not None else 0
        except Exception:
            facts = 0
        with self._lock:
            agents = []
            for spec in AGENTS:
                state = dict(self._agents[spec["id"]])
                if spec["id"] == "shop" and "shop" not in (self.lage or {}) and state["status"] == "bereit" \
                        and not state["text"]:
                    continue  # ohne Shop-Konnektor keine Shop-Karte
                agents.append({**spec, **state, "text": state["text"] or spec["leer"]})
            age = round((self._now() - self.lage_at).total_seconds() / 60) if self.lage_at else None
            lage_info = {"zeit": _clock(self.lage_at) if self.lage_at else "", "alter": age,
                         "laeuft": self._lage_running.is_set(), "fehler": self.lage_error, "moeglich": self.can_refresh()}
        post = (self.lage or {}).get("post")
        return {
            "kopf": {"ereignisse": len(events), "seit": _clock(self.on_duty_since()), "uhr": _clock(now)},
            "aktivitaet": list(reversed(events[-8:])),
            "erledigt": self._done_chips(),
            "wissen": {"notizen": notes_count, "fakten": facts},
            "konto": self._account(),
            "kennzahlen": self._figures(),
            "tagesplan": self._plan(),
            "post": {"verbunden": post is not None, "neu": (post or {}).get("neu"),
                     "mails": (post or {}).get("mails") or []},
            "nachrichten": self.news(),
            "agenten": agents,
            "notizen": notes,
            "hinweise": (self.lage or {}).get("hinweise") or [],
            "lage": lage_info,
        }

    # ------------------------------------------------------------------ Briefing

    def briefing(self) -> list[dict]:
        """Das Morgen-Briefing zum Vorlesen, Abschnitt für Abschnitt: {"bereich": wo im Fenster, "text": der Satz,
        "titel"/"detail"/"zeit": was dazu oben in der Aktivität aufleuchtet, "ziel": welcher Eintrag hervorgehoben
        wird (Mail-ID, Termin)}. Aus dem Lagebild und Jarvis' eigenem Tag."""
        now = self._now()
        data = self.lage or {}
        part = "Guten Morgen" if 4 <= now.hour < 11 else "Guten Tag" if now.hour < 18 else "Guten Abend"
        segments: list[dict] = []

        def add(area: str, text: str, title: str = "", detail: str = "", when: str = "", target: str = "") -> None:
            segments.append({"bereich": area, "text": text, "titel": title, "detail": detail, "zeit": when,
                             "ziel": target})

        since = self.on_duty_since()
        weather = ""
        if hasattr(self._assistant, "weather_today"):
            try:
                weather = str(self._assistant.weather_today() or "").strip().rstrip(".")
            except Exception as exc:
                log.debug("Zentrale, Wetter: %s", exc)
        first = f"{part}, Sir."
        on_duty = since.date() == now.date() and since.hour >= 4
        if on_duty:
            first += f" Ich bin seit {_spoken_clock(_clock(since))} im Dienst."
        if weather:
            first += f" {weather}."
        add("kopf", first, f"Seit {_clock(since)} im Dienst" if on_duty else part, weather, _clock(since) if on_duty else "")
        done = [e for e in self.events_today() if e["art"] not in ("lage", "briefing")]
        if self.lage_fresh(240) or done:
            sentence = "Während Sie in den Tag gestartet sind, war ich bereits beschäftigt."
            if done:
                sentence += f" {'Eine Sache habe' if len(done) == 1 else f'{len(done)} Dinge habe'} ich heute schon erledigt."
            sentence += " Was ich Ihnen abgenommen habe und was heute noch Sie selbst braucht, sehen wir uns jetzt an."
            add("aktivitaet", sentence, "Heute erledigt", f"{len(done)} Aufgaben" if done else "Lagebild steht")
        post = data.get("post")
        if post is not None:
            mails = post["mails"]
            counts = post.get("zahlen") or {key: sum(1 for m in mails if m["status"] == key) for key in lage.STATUS}
            count = post.get("neu") if post.get("neu") is not None else len(mails)
            important = [m for m in mails if m["status"] == "wichtig"]
            ads, answered, waiting = counts["werbung"], counts["beantwortet"], counts["offen"]
            sentence = "Beginnen wir mit Ihren Mails. "
            if not count:
                sentence += "Seit gestern ist nichts Neues eingegangen."
            else:
                sentence += "Seit gestern ist eine neue Nachricht eingegangen." if count == 1 else \
                    f"Seit gestern sind {count} neue Nachrichten eingegangen."
                bits = []
                if answered:
                    bits.append(f"{_one(answered)} {'ist' if answered == 1 else 'sind'} schon beantwortet")
                if waiting:
                    bits.append(f"{_one(waiting)} {'kann' if waiting == 1 else 'können'} warten")
                if ads:
                    bits.append(f"{_one(ads)} {'will' if ads == 1 else 'wollen'} Ihnen etwas verkaufen")
                if bits:
                    sentence += " " + _sentence(", ".join(bits[:-1]) + " und " + bits[-1] if len(bits) > 1 else bits[0]) + "."
                if important:
                    top = important[0]
                    many = _one(max(len(important), counts["wichtig"]))
                    sentence += (f" Und {many} sollten Sie sich tatsächlich ansehen: {top['von']}, {top['betreff']}."
                                 f" {'Die habe' if many == 'eine' else 'Die wichtigste habe'} ich ganz nach oben gelegt.")
                    add("post", sentence, "Eine Mail sollten Sie ansehen" if len(important) == 1 else
                        f"{len(important)} Mails sollten Sie ansehen", f"{top['von']} · {top['betreff']}", top["zeit"],
                        top["id"] or top["betreff"])
                    sentence = ""
            if sentence:
                add("post", sentence, f"{count} neue Mails" if count != 1 else "Eine neue Mail",
                    f"{answered} beantwortet · {waiting} offen" if count else "Posteingang ist leer")
        ads = data.get("werbung")
        shop = data.get("shop")
        if ads:
            sentence = "Kommen wir zu den Werbekonten."
            if ads.get("roas") is not None:
                sentence += f" Der ROAS über alle Konten liegt bei {number(ads['roas'])}."
            if ads.get("ausgaben") is not None:
                sentence += f" Ausgegeben sind heute {euro(ads['ausgaben'])}."
            add("kennzahlen", sentence, f"ROAS {number(ads.get('roas'))}", f"Ausgaben heute {euro(ads.get('ausgaben'))}",
                target="werbung")
        if shop:
            currency = shop.get("waehrung") or "EUR"
            orders = shop.get("bestellungen_heute") or 0
            sentence = "Kommen wir zum Shop. "
            sentence += (f"Heute {'eine Bestellung' if orders == 1 else f'{orders} Bestellungen'}"
                         f" mit {euro(shop.get('umsatz_heute'), currency)} Umsatz." if orders else
                         "Heute ist noch keine Bestellung eingegangen.")
            if shop.get("umsatz_gestern") is not None:
                sentence += f" Gestern waren es {euro(shop['umsatz_gestern'], currency)}."
            if shop.get("offen"):
                sentence += f" {shop['offen']} {'wartet' if shop['offen'] == 1 else 'warten'} auf den Versand."
            add("kennzahlen", sentence, f"Shop: {orders} {'Bestellung' if orders == 1 else 'Bestellungen'} heute",
                f"Umsatz {euro(shop.get('umsatz_heute'), currency)}", target="shop")
        calendar = data.get("kalender")
        reminders = self._reminders_today()
        if calendar is not None or reminders:
            events = [e for e in (calendar or {}).get("heute") or [] if e["start"] == "Tag" or e["start"] >= _clock(now)]
            sentence = "Dann noch ein Blick in Ihren Kalender. "
            important = self.important_event()
            if not events:
                sentence += "Heute stehen keine Termine mehr an."
            else:
                sentence += "Heute steht ein Termin an." if len(events) == 1 else f"Heute stehen {len(events)} Termine an."
                if important is not None:
                    sentence += f" Der wichtigste um {_spoken_clock(important['start'])}: {important['titel']}."
                    if important.get("ort"):
                        sentence += f" In {important['ort']}." if not important["ort"].lower().startswith(("http", "meet", "zoom", "teams")) else ""
                    if self.reminded(important):
                        sentence += " Und ich erinnere Sie rechtzeitig daran."
            if reminders:
                sentence += f" Dazu {'eine Erinnerung' if len(reminders) == 1 else f'{len(reminders)} Erinnerungen'}."
            if important is not None and events:
                add("tagesplan", sentence, f"{important['titel']}", "Der wichtigste Termin des Tages.", important["start"],
                    f"{important['start']} {important['titel']}")
            else:
                add("tagesplan", sentence, f"{len(events)} Termine heute" if events else "Keine Termine mehr",
                    f"{len(reminders)} Erinnerungen" if reminders else "")
        hints = data.get("hinweise") or []
        if hints:
            add("rueckfragen", hints[0], "Das braucht heute Sie", hints[0])
        news = self._news.get("schlagzeilen") if self._news else []
        if news:
            add("nachrichten", f"In den Nachrichten: {news[0]['titel'].rstrip('.')}.", "Nachrichten", news[0]["titel"])
        add("orb", "Das wäre alles für den Moment, Sir. Was kann ich für Sie tun?")
        return segments

    def command(self, text: str, speak: bool = True) -> str | None:
        """Sätze für die Zentrale: "Briefing", "Guten Morgen", "Zeig die Zentrale", "Aktualisiere die Zentrale".
        None = nicht für die Zentrale."""
        if wants_briefing(text, self._now().hour):
            return self.start_briefing(speak)
        if wants_view(text):
            self._bring_up()
            self.changed()
            return "Die Kommandozentrale, Sir."
        if wants_refresh(text):
            if self._lage_running.is_set():
                return "Ich bin schon dabei, Sir."
            if self.refresh("Georg"):
                self._emit("show")
                return "Sehr wohl, Sir. Ich sehe in Ihre Post, den Kalender und den Shop."
            return "Dafür brauche ich Claude Code mit Ihren Konnektoren, Sir."
        return None

    def _bring_up(self) -> None:
        """Das Fenster mit der Zentrale zeigen, außer Georg spielt gerade."""
        self._emit("show")
        if self._show_window is not None and not getattr(self._assistant, "gaming", False):
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Zentrale, Fenster: %s", exc)

    def start_briefing(self, speak: bool = True) -> str:
        """Das Briefing: Die Begrüßung kommt sofort als Antwort, den Rest liest Jarvis danach Bereich für Bereich
        vor, und das Fenster hebt hervor, wovon er gerade spricht. Ist das Lagebild alt, holt er es währenddessen
        neu. Ohne Stimme (Alexa) kommt alles als ein Text zurück."""
        self.cancel()
        if not self.lage_fresh():
            self.refresh("Briefing")
        segments = self.briefing()
        if not speak:
            if self._lage_running.is_set() and self.wait_lage(6):  # Alexa wartet nicht lange
                segments = self.briefing()
            self.briefed = self._now().date()
            self.log("briefing", "Briefing gehalten")
            return " ".join(part["text"] for part in segments)
        with self._lock:
            self._brief_run += 1
            run = self._brief_run
            self._briefing = True
        self._bring_up()
        self._show_part(segments[0])
        threading.Thread(target=self._brief, args=(run,), name="jarvis-briefing", daemon=True).start()
        return segments[0]["text"]

    def _show_part(self, part: dict | None) -> None:
        if part is None:
            self.focus("")
            return
        self._emit("focus", bereich=part["bereich"], titel=part.get("titel", ""), detail=part.get("detail", ""),
                   zeit=part.get("zeit", ""), ziel=part.get("ziel", ""))

    def _current(self, run: int) -> bool:
        return self._brief_run == run

    def _brief(self, run: int) -> None:
        time.sleep(0.3)  # die Begrüßung ist auf dem Weg zur Stimme
        try:
            self.news()  # die Schlagzeilen, falls sie noch fehlen (während Jarvis grüßt)
        except Exception as exc:
            log.debug("Zentrale, Nachrichten fürs Briefing: %s", exc)
        self._spoken(timeout=40)
        if self._lage_running.is_set() and not self.wait_lage(3) and self._current(run):
            self._tell("Einen Moment, ich sehe noch kurz in Ihre Post.")
            self._spoken(timeout=20)
            self.wait_lage(60)
        for part in self.briefing()[1:]:  # mit dem frischen Lagebild
            if not self._current(run):
                return
            self._show_part(part)
            self._tell(part["text"])
            self._spoken(timeout=90)
        with self._lock:
            if not self._current(run):
                return
            self._briefing = False
        self.focus("")
        self.briefed = self._now().date()
        self.log("briefing", "Briefing gehalten")

    def cancel(self) -> bool:
        """"Stopp": das Briefing nach dem Satz, der gerade läuft, beenden. True = es lief eins."""
        with self._lock:
            was = self._briefing
            self._briefing = False
            self._brief_run += 1
        if was:
            self.focus("")
        return was


class Listener(Ui):
    """Hört mit, was Jarvis tut (dieselben Ereignisse wie das Fenster), und trägt das Erledigte in die Aktivität
    der Zentrale ein: Sofort-Befehle, was Claude über Konnektoren und Programme gemacht hat, die Spezialisten,
    die Werkstatt, Modelle im Blueprint und Lageberichte. Lesen, Suchen und Dateien zählen nicht, das wäre zu viel."""

    CLAUDE_KINDS = ("app", "install", "message", "calendar", "music", "build")
    SAME_SECONDS = 120  # derselbe Eintrag so kurz danach noch einmal: weglassen

    def __init__(self, zentrale: Zentrale) -> None:
        self._zentrale = zentrale
        self._recent: dict[str, float] = {}

    def _log(self, art: str, text: str, detail: str = "") -> None:
        now = time.monotonic()
        if now - self._recent.get(text, -1e9) < self.SAME_SECONDS:
            return
        self._recent = {k: v for k, v in self._recent.items() if now - v < self.SAME_SECONDS}
        self._recent[text] = now
        self._zentrale.log(art, text, detail)

    def progress(self, step: dict) -> None:
        if not isinstance(step, dict) or step.get("workshop"):
            return  # die Werkstatt meldet sich selbst, wenn sie fertig ist
        tool = str(step.get("tool") or "")
        if tool in ("Agent", "Task"):
            self._zentrale.helper_step(step)
            return
        if step.get("state") != "done":
            return
        label = str(step.get("label") or "")
        if not label:
            return
        if tool == "Jarvis":
            self._log("befehl", label)
        elif tool.startswith("mcp__"):
            self._log("konnektor", label, str(step.get("detail") or ""))
        elif tool == "WebSearch":
            self._log("recherche", label)
        elif step.get("kind") in self.CLAUDE_KINDS:
            self._log("claude", label)

    def workshop(self, event: dict) -> None:
        state = event.get("state")
        if state == "done":
            summary = re.split(r"(?<=[.!?])\s+", str(event.get("summary") or "").strip())[0]
            self._log("werkstatt", "Werkstatt: " + (summary or "Auftrag fertig"), str(event.get("folder") or ""))
        elif state == "error":
            self._log("werkstatt", "Werkstatt: Auftrag mit Fehler beendet")

    def blueprint(self, event: dict) -> None:
        action = event.get("action")
        if action == "done" and event.get("ok"):
            name = str((event.get("scene") or {}).get("name") or "").strip()
            self._log("blueprint", f"Blueprint: {name} gebaut" if name else "Blueprint: Modell gebaut")
        elif action == "render" and event.get("state") == "done":
            self._log("blueprint", "Blueprint: Foto aus Blender")
        elif action == "saved":
            self._log("blueprint", f"Blueprint gespeichert: {event.get('name') or 'Modell'}")

    def world(self, event: dict) -> None:
        if event.get("action") == "news" and event.get("items"):
            self._log("weltlage", f"Lagebericht: {len(event['items'])} Meldungen", str(event.get("title") or ""))


# ---------------------------------------------------------------------- Sätze

_BRIEFING = re.compile(
    r"^(?:(?:hey |hallo |ok |okay )?jarvis[, ]+)?(?:(?:gib|mach|halt|halte)(?: mir)? (?:das |ein |mein |dein )?)?"
    r"(?:morgen[- ]?briefing|briefing|tages[- ]?briefing|tagesüberblick|lagebild|überblick)(?: bitte| geben| halten)?$|"
    r"^(?:(?:hey |hallo )?jarvis[, ]+)?(?:was steht (?:heute )?an|was liegt (?:heute )?an|was steht heute so an|"
    r"wie sieht mein tag aus|was habe ich heute vor|was hab ich heute vor)$", re.I)
_MORNING = re.compile(r"^(?:(?:hey |hallo )?jarvis[, ]+)?guten morgen(?: jarvis)?$", re.I)
_SHOW = re.compile(r"^(?:(?:zeig|zeige|öffne|öffnen)(?: mir)? )?(?:die |das )?(?:kommandozentrale|zentrale|dashboard)"
                   r"(?: an| öffnen| zeigen)?$", re.I)
_REFRESH = re.compile(r"^(?:aktualisier\w*|lade neu|neu laden)(?: die| das)?(?: zentrale| lagebild| dashboard)?$|"
                      r"^(?:hol|hole)(?: mir)? (?:die )?(?:neuesten |aktuellen )?(?:mails|post|zahlen) ?(?:rein|neu)?$", re.I)


def wants_briefing(text: str, hour: int | None = None) -> bool:
    """ "Briefing", "Was steht heute an?", morgens auch "Guten Morgen"."""
    norm = " ".join(re.sub(r"[.,!?;:\"„“]", " ", str(text or "")).lower().split())
    if _BRIEFING.match(norm):
        return True
    hour = dt.datetime.now().hour if hour is None else hour
    return bool(_MORNING.match(norm)) and 4 <= hour < 12


def wants_view(text: str) -> bool:
    norm = " ".join(re.sub(r"[.,!?;:\"„“]", " ", str(text or "")).lower().split())
    return bool(_SHOW.match(norm))


def wants_refresh(text: str) -> bool:
    norm = " ".join(re.sub(r"[.,!?;:\"„“]", " ", str(text or "")).lower().split())
    return bool(_REFRESH.match(norm))
