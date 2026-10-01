"""Der Kern: nimmt einen Befehl (gesprochen, getippt oder von Home Assistant),
erledigt ihn selbst oder fragt Claude, und spricht die Antwort."""

from __future__ import annotations

import contextlib
import datetime as dt
import itertools
import logging
import queue
import random
import re
import threading
import time
import urllib.parse

from . import intents
from .brain import BrainError, Cancelled, RefusalError
from .text import SentenceSplitter, speakable, strip_sources
from .ui import Ui

log = logging.getLogger("jarvis")

FILLERS = [
    "Einen Moment, Sir.",
    "Sehr wohl, Sir.",
    "Ich kümmere mich darum.",
    "Einen Augenblick.",
]

# Arbeitsschritte, die länger dauern, sagt Jarvis an ("Ich installiere Spotify."). Kurze nicht.
PROGRESS_AFTER = 1.5
# Bei langer Arbeit höchstens alle so viele Sekunden ein Zwischenstand, und höchstens so viele.
PROGRESS_EVERY = 25.0
PROGRESS_MAX = 3


# Diese Befehle gelten immer, auch wenn der Satz nach Werkstatt klingt ("Stopp", "Wie weit bist du?").
_BEFORE_WORKSHOP = {"stop", "mute", "reset", "message", "remind", "timer", "workshop_status", "workshop_cancel",
                    "window_show", "window_hide", "setup", "discord", "power_abort", "power_off", "power_restart",
                    "power_sleep", "power_logoff"}
_POWER = {"power_off": "shutdown", "power_restart": "restart", "power_sleep": "sleep", "power_logoff": "logoff"}


class Assistant:
    def __init__(self, cfg: dict, brain, speaker, ui: Ui, mute=None, reminders=None) -> None:
        self._cfg = cfg
        self.brain = brain
        self.speaker = speaker
        self.ui = ui
        self.mute = mute
        self.reminders = reminders
        answer_cfg = cfg.get("answer", {})
        self._ack_after = float(answer_cfg.get("ack_after_seconds", 3.0))
        self._local = cfg.get("local", {}).get("enabled", True)
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()  # immer nur ein Befehl gleichzeitig
        self._busy = 0
        self._recording = False
        self._transcribing = False
        self._speaking = False
        self._follow_up = False
        # Die Stumm-Taste, die wirklich angemeldet werden konnte (setzt __main__).
        self.hotkey = ""
        # Vom Fenster gesetzt: "show"/"hide" zeigt oder versteckt es, open_setup öffnet die Einstellungen.
        self.window_control = None
        self.open_setup = None
        # Die Werkstatt für Programmier- und Bauaufgaben (setzt __main__).
        self.workshop = None
        self.gaming = False
        # Wetter-Quellen je Ort (merkt sich die Koordinaten und die Vorhersage)
        self.weathers: dict = {}
        # Was bei mehreren Befehlen übrig blieb und Claude machen soll
        self._rest = ""
        # Das Gedächtnis (memory.Memory, setzt __main__) und ein offener Vorschlag (Routine, bis wann)
        self.memory = None
        self._offer = None
        self._last_state = ""
        self._ids = itertools.count(1)
        self._worker: threading.Thread | None = None
        if brain is not None and hasattr(brain, "alert"):
            # Zwischenstände des Gehirns bleiben im Protokoll, nur Wichtiges kommt als Hinweis.
            brain.alert = lambda text: (log.warning("%s", text), self.ui.toast(text, "error"))

    # ------------------------------------------------------------------ Zustand

    @property
    def busy(self) -> bool:
        return self._busy > 0 or not self._queue.empty()

    @property
    def speaking(self) -> bool:
        return self._speaking or (self.speaker is not None and self.speaker.busy)

    def set_recording(self, value: bool) -> None:
        self._recording = value
        self.update_state()

    def set_transcribing(self, value: bool) -> None:
        """Während Whisper die Aufnahme in Text umwandelt: "denkt nach" statt "bereit"."""
        self._transcribing = value
        self.update_state()

    def take_follow_up(self) -> bool:
        """True, wenn die letzte gesprochene Antwort eine Frage war (nur einmal)."""
        value, self._follow_up = self._follow_up, False
        return value

    def set_speaking(self, value: bool) -> None:
        """Wird vom Speaker gemeldet, wenn er anfängt oder aufhört zu sprechen."""
        self._speaking = value
        self.update_state()

    def update_state(self) -> None:
        if self.mute is not None and self.mute.muted and not self._busy and not self._speaking:
            state = "muted"
        elif self._recording:
            state = "listening"
        elif self._speaking:
            state = "speaking"
        elif self._busy or self._transcribing:
            state = "thinking"
        else:
            state = "idle"
        if state != self._last_state:
            self._last_state = state
            self.ui.state(state)

    # ------------------------------------------------------------------ Befehle

    def submit(self, text: str, speak: bool = True) -> None:
        """Nimmt einen Befehl an und erledigt ihn im Hintergrund (für Sprache, Oberfläche und Handy).
        speak=False: Antwort nur anzeigen, nicht vorlesen (z. B. vom Handy, wenn Georg nicht am PC ist)."""
        if not text.strip():
            return
        intent = intents.match(text)
        if intent is not None and intent.name == "stop":
            # Sofort, nicht erst nach der laufenden Antwort (die hängt sonst davor in der Schlange).
            self.ui.message("user", text)
            self.stop()
            # "Ein Abbrechen hält mich auf": auch ein laufendes Herunterfahren
            if self.abort_power():
                self.announce("Abgebrochen, Sir. Der PC bleibt an.")
            self.update_state()
            return
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, name="jarvis-befehle", daemon=True)
            self._worker.start()
        self._queue.put((text, speak))
        self.update_state()

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            text, speak = item if isinstance(item, tuple) else (item, True)
            try:
                self.handle(text, speak=speak)
            except Exception:
                log.exception("Unerwarteter Fehler bei: %s", text)
                self.ui.toast("Da ist etwas schiefgelaufen. Details in logs/jarvis.log.", "error")

    def stop(self) -> None:
        """Stoppt die laufende Antwort: Claude und Stimme."""
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        if self.brain is not None:
            self.brain.cancel()
        if self.speaker is not None:
            self.speaker.stop()

    def new_conversation(self) -> None:
        if self.brain is not None:
            self.brain.new_conversation()
        self.ui.message("info", "Neue Unterhaltung")

    def announce(self, text: str) -> None:
        """Sagt etwas von sich aus, z. B. eine Erinnerung."""
        self.ui.message("jarvis", text)
        self.say(text)

    def say(self, text: str) -> None:
        if self.speaker is not None:
            self.speaker.say(text)

    def handle(self, text: str, speak: bool = True) -> str:
        """Erledigt einen Befehl und gibt die Antwort als Text zurück."""
        text = text.strip()
        if not text:
            return ""
        with self._lock:
            self._busy += 1
            self._follow_up = False
            self.update_state()
            try:
                log.info("Befehl: %s", text)
                self.ui.message("user", text)
                self.learn("said", text)
                self._rest = ""
                answer = self._local_answer(text)
                rest, self._rest = self._rest, ""
                if answer is None:
                    answer = self._ask_claude(text, speak)
                else:
                    if answer:
                        self.ui.message("jarvis", answer)
                        if speak:
                            self.say(answer)
                    if rest:
                        # "Öffne Spotify und schreib mir ein Gedicht": den Teil kann nur Claude
                        later = self._ask_claude(rest, speak)
                        answer = " ".join(a for a in (answer, later) if a)
                log.info("Antwort: %s", answer)
                self._follow_up = bool(speak and answer and answer.rstrip().endswith("?"))
            finally:
                self._busy -= 1
                self.update_state()
        if speak and self.speaker is not None:
            self.speaker.wait(timeout=120)
        self.update_state()
        return answer

    def _local_answer(self, text: str) -> str | None:
        """Erledigt schnelle Befehle selbst. None = Claude soll es machen,
        "" = erledigt, ohne etwas zu sagen."""
        offer = self._take_offer()
        if offer is not None:
            answer = self._answer_offer(offer, text)
            if answer is not None:
                return answer
        if self.memory is not None:
            from .memory import match_memory

            remembered = match_memory(text)
            if remembered is not None:
                return self._memory_command(*remembered)
        intent = intents.match(text)
        if self.workshop is not None and (intent is None or intent.name not in _BEFORE_WORKSHOP):
            projects = getattr(self.workshop, "project_command", None)
            answer = projects(text) if projects is not None else None
            if answer is not None:
                return answer
            # Bauaufträge und Wünsche zum letzten Projekt gehen vor die übrigen Sofort-Befehle,
            # sonst schnappt sich "Öffne ..." oder "Such ..." einen Teil davon.
            where = self.workshop.route(text, free=intent is None)
            if where == "new":
                return self.workshop.start(text)
            if where == "continue":
                return self.workshop.follow_up(text)
            self.workshop.forget_question()  # nur die direkte Antwort gehört zur Rückfrage
        if intent is None:
            parts = intents.match_parts(text) if self._local else None
            if parts:
                return self._many(parts)
            return None
        return self._do(intent, text)

    def _many(self, parts) -> str | None:
        """Mehrere Befehle in einem Satz, nacheinander. Was Jarvis davon nicht selbst kann,
        macht danach Claude (self._rest)."""
        said = []
        for number, (piece, intent) in enumerate(parts):
            answer = self._do(intent, piece)
            if answer is None:
                if not said and number == 0:
                    return None  # schon der erste Teil geht nicht: Claude macht alles
                self._rest = " und ".join(p for p, _ in parts[number:])
                break
            if answer:
                said.append(answer)
        return _join(said)

    @contextlib.contextmanager
    def _step(self, label: str, kind: str = "app", detail: str = ""):
        """Zeigt einen schnellen Befehl als Arbeitsschritt im Fenster (läuft, erledigt, Fehler)."""
        step = {"id": f"q{next(self._ids)}", "tool": "Jarvis", "label": label, "detail": detail, "kind": kind,
                "state": "running"}
        started = time.monotonic()
        self.ui.progress(step)
        try:
            yield
        except BaseException:
            self.ui.progress(dict(step, state="error", seconds=round(time.monotonic() - started, 1)))
            raise
        self.ui.progress(dict(step, state="done", seconds=round(time.monotonic() - started, 1)))

    def _do(self, intent, text: str) -> str | None:
        """Ein erkannter Befehl. None = das kann Jarvis nicht selbst, Claude soll es machen."""
        name = intent.name
        if name in ("workshop_status", "workshop_cancel"):
            if self.workshop is None:
                return None
            if name == "workshop_status":
                if not self.workshop.busy and intent is not None and "werkstatt" not in text.lower():
                    return None  # "Bist du fertig?" ohne laufende Arbeit: normale Frage an Claude
                return self.workshop.status()
            return "Abgebrochen, Sir." if self.workshop.cancel() else "In der Werkstatt läuft gerade nichts, Sir."
        if name in ("stop", "power_abort"):
            if self.speaker is not None:
                self.speaker.stop()
            if self.abort_power():
                return "Abgebrochen, Sir. Der PC bleibt an."
            return "" if name == "stop" else None
        if name == "mute" and self.mute is not None:
            self.mute.mute()
            from .mute import hotkey_label

            # Nur ein Tastenkürzel nennen, das Windows auch wirklich angenommen hat.
            hotkey = hotkey_label(self.hotkey, spoken=True) if self.hotkey else ""
            if hotkey:
                return f"Sehr wohl, Sir. Mit {hotkey} hole ich Sie wieder zurück."
            return "Sehr wohl, Sir. Über den Mikrofon-Knopf im Fenster hole ich Sie wieder zurück."
        if name == "reset":
            if self.brain is not None:
                self.brain.new_conversation()
            return "Sehr wohl, Sir. Wir fangen von vorne an."
        if name in ("window_show", "window_hide"):
            if self.window_control is None or not self.window_control("show" if name == "window_show" else "hide"):
                return "Ich habe gerade kein Fenster, Sir. Ich bin nur Stimme."
            if name == "window_show":
                return random.choice(["Hier bin ich, Sir.", "Zu Ihren Diensten, Sir.", "Bitte sehr, Sir."])
            return random.choice(["Ich ziehe mich zurück, Sir. Rufen Sie einfach.", "Sehr wohl. Ich bin im Hintergrund."])
        if name == "setup":
            if self.open_setup is None:
                return None
            threading.Timer(1.5, self.open_setup).start()
            return "Die Einstellungen öffnen sich, Sir."
        if not self._local:
            return None
        if name in _POWER:
            return self._power(_POWER[name])
        now = dt.datetime.now()
        if name == "time":
            return intents.spoken_time(now)
        if name == "date":
            return intents.spoken_date(now.date())
        try:
            from . import pc

            if name == "volume_up":
                pc.volume("lauter")
                return ""
            if name == "volume_down":
                pc.volume("leiser")
                return ""
            if name == "volume_set":
                pc.set_volume(int(intent.arg))
                return ""
            if name in ("media_pause", "media_play"):
                pc.media("pause")
                return ""
            if name == "media_next":
                pc.media("naechstes")
                return ""
            if name == "media_prev":
                pc.media("voriges")
                return ""
            if name in ("gaming_on", "gaming_off"):
                return self._gaming(name == "gaming_on")
            if name == "lock":
                pc.lock()
                return "Gesperrt, Sir."
            if name == "folder":
                return pc.open_folder(intent.arg).replace(" ist offen.", " ist offen, Sir.")
            if name in ("open", "close", "install"):
                return self._app(name, intent.arg)
            if name == "message":
                return self._message(intent.arg, intent.data["person"], intent.data["text"])
            if name == "discord":
                return self._discord(intent)
            if name in ("remind", "timer"):
                return self._remind(name, intent)
            if name in ("web", "search", "images", "route", "map", "play"):
                return self._web(name, intent)
            if name == "settings_page":
                label, uri = pc.settings_page(intent.arg)
                with self._step(f"Öffnet die Einstellungen: {label}", "app", uri):
                    pc.open_uri(uri)
                return random.choice([f"Die Einstellungen für {label}, Sir.", f"{label}-Einstellungen sind offen, Sir."])
            if name in ("dark_on", "dark_off"):
                dark = name == "dark_on"
                with self._step("Schaltet auf dunkel" if dark else "Schaltet auf hell", "app"):
                    pc.dark_mode(dark)
                return "Dunkler Modus, Sir." if dark else "Heller Modus, Sir. Etwas grell, wenn Sie mich fragen."
            if name == "radio":
                return self._radio(intent.arg, bool(intent.data.get("on")))
            if name == "light":
                return self._light(intent)
            if name == "weather":
                return self._weather(intent)
            if name == "calc":
                return self._calc(intent)
        except Exception as exc:
            log.info("Schneller Befehl %s ging nicht (%s), frage Claude.", name, exc)
            return None
        return None

    def _app(self, action: str, target: str) -> str | None:
        """Programme öffnen, schließen und installieren. None = Claude soll es versuchen."""
        from . import apps

        if action == "open":
            try:
                with self._step(f"Öffnet {_display(target)}", "app"):
                    said = apps.open_app(target)
            except apps.AppNotFound:
                return None
            if said.endswith(" startet."):
                name = said.removesuffix(" startet.")
                self.learn("open", name)
                return random.choice([f"{name} startet, Sir.", f"Sehr wohl, {name} kommt.", f"{name}, kommt sofort."])
            self.learn("open", said.removesuffix(" ist offen.") if said.endswith(" ist offen.") else _display(target))
            return said.replace(" ist offen.", " ist offen, Sir.")
        if action == "close":
            try:
                with self._step(f"Schließt {_display(target)}", "app"):
                    said = apps.close_app(target)
            except apps.AppNotFound:
                return None
            return said.replace(" ist zu.", " ist zu, Sir.")
        known = apps.find_known(target)
        if known is None or not known.winget:
            return None  # Claude sucht die passende winget-ID
        self.ui.message("info", f"Installiere {known.name} ...")
        threading.Thread(target=self._install, args=(known,), name="jarvis-installieren", daemon=True).start()
        return random.choice([
            f"Ich installiere {known.name}, Sir. Einen Moment.",
            f"Sehr wohl. {known.name} wird installiert, ich sage Bescheid.",
        ])

    def _web(self, name: str, intent) -> str | None:
        """Webseiten, Suchen, Karten und Abspielen: ein Link, den Windows sofort öffnet."""
        from . import apps, pc, web

        query = intent.arg.strip()
        if name == "web":
            found = web.site(query)
            label, url = found if found else (query[:1].upper() + query[1:], web.first_hit_url(query))
            with self._step(f"Öffnet {label}", "web", url):
                pc.open_uri(url)
            if found:
                self.learn("web", label)
            return random.choice([f"{label} ist offen, Sir.", f"Bitte sehr, {label}.", f"{label}, Sir."])
        if name == "search":
            site = intent.data.get("site") or "google"
            if site == "spotify":
                return self._spotify(query)
            label, url = web.search_url(site, query)
            with self._step(f"Sucht auf {label}: {query}", "search", url):
                pc.open_uri(url)
            if label == "Google":
                return random.choice([f"Hier ist Google zu {query}, Sir.", f"Die Suche nach {query} ist offen, Sir."])
            return random.choice([f"{label} mit {query}, Sir.", f"Hier ist {label} zu {query}, Sir."])
        if name == "images":
            label, url = web.search_url("bilder", query)
            with self._step(f"Sucht Bilder: {query}", "search", url):
                pc.open_uri(url)
            return f"Bilder von {query}, Sir."
        if name == "map":
            label, url = web.search_url("maps", query)
            with self._step(f"Zeigt auf der Karte: {query}", "web", url):
                pc.open_uri(url)
            return f"{query[:1].upper() + query[1:]} auf der Karte, Sir."
        if name == "route":
            url = web.directions_url(query)
            with self._step(f"Plant die Route nach {query}", "web", url):
                pc.open_uri(url)
            return f"Die Route nach {query} ist offen, Sir."
        # Abspielen
        site = intent.data.get("site") or ""
        if site == "spotify":
            return self._spotify(query)
        if not site and (apps.find_known(query) is not None or apps.START_MENU.find(query, strict=True)):
            return self._app("open", query)  # "Spiel Minecraft" heißt: das Spiel starten
        with self._step(f"Sucht auf YouTube: {query}", "web"):
            video = web.first_video(query)
            url = web.video_url(video) if video else web.search_url("youtube", query)[1]
            pc.open_uri(url)
        if video:
            return random.choice([f"{query} läuft, Sir.", f"Bitte sehr, {query}.", f"{query}, kommt sofort."])
        return f"Hier ist YouTube zu {query}, Sir."

    def _spotify(self, query: str) -> str:
        """Spotify sucht, abspielen muss Georg selbst: ohne Spotify-Konto für Entwickler geht es nicht."""
        from . import apps, pc, web

        installed = apps.START_MENU.find("spotify", strict=True) is not None
        url = "spotify:search:" + urllib.parse.quote(query) if installed else web.search_url("spotify", query)[1]
        with self._step(f"Sucht in Spotify: {query}", "app", url):
            pc.open_uri(url)
        return f"Spotify zeigt {query}, Sir. Ein Klick, und es läuft."

    def _radio(self, kind: str, on: bool) -> str | None:
        from . import pc

        label = "Bluetooth" if kind == "bluetooth" else "WLAN"
        try:
            with self._step(f"Schaltet {label} {'ein' if on else 'aus'}", "app"):
                pc.radio(kind, on)
        except pc.RadioMissing:
            return f"Ich finde an diesem PC kein {label}, Sir."
        if label == "WLAN" and not on:
            return "WLAN ist aus, Sir. Ohne Internet höre und spreche ich nur eingeschränkt."
        return f"{label} ist {'an' if on else 'aus'}, Sir."

    def _light(self, intent) -> str | None:
        """Licht über Home Assistant, sonst sagt Jarvis es einem Echo (alles, was Alexa kann).
        Ohne Home Assistant: None, dann erklärt Claude, was es braucht."""
        from .homeassistant import HomeAssistant, HomeAssistantError

        ha = HomeAssistant(self._cfg.get("homeassistant", {}))
        if not ha.configured:
            return None
        room, on, pct = intent.arg, bool(intent.data.get("on", True)), intent.data.get("pct")
        where = f" im {room[:1].upper() + room[1:]}" if room else ""
        label = f"Licht{where} " + ("aus" if not on else f"auf {pct} Prozent" if pct else "an")
        with self._step(label, "app"):
            try:
                ha.light(room, on, pct)
            except HomeAssistantError:
                if not ha.alexa:
                    raise
                ha.alexa_command(room if ha.alexa_target_or_none(room) else ha.first_echo(), intent.data.get("said") or label)
        if not on:
            return random.choice([f"Licht{where} ist aus, Sir.", "Erledigt, Sir. Gemütlich dunkel."])
        if pct:
            return f"Licht{where} auf {pct} Prozent, Sir."
        return random.choice([f"Licht{where} ist an, Sir.", "Es werde Licht, Sir."])

    def _weather(self, intent) -> str | None:
        """Wetter sofort von Open-Meteo, ohne Claude. Ohne Ort fragt Claude nach."""
        from .weather import Weather, spoken_weather

        place = (intent.data.get("place") or str(self._cfg.get("ich", {}).get("ort", ""))).strip()
        if not place:
            return None
        source = self.weathers.get(place.lower())
        if source is None:
            source = self.weathers[place.lower()] = Weather(place)
        with self._step(f"Holt das Wetter für {place[:1].upper() + place[1:]}", "web"):
            data = source.forecast()
        return spoken_weather(data, intent.arg or "heute", intent.data.get("ask", ""))

    def _calc(self, intent) -> str:
        from .calc import spoken

        if intent.data.get("error") == "durch null":
            return "Durch null teilen kann nicht einmal ich, Sir."
        result = spoken(intent.data["value"])
        return random.choice([f"Das macht {result}, Sir.", f"{result}, Sir.", f"Ergibt {result}, Sir."])

    def _message(self, app: str, person: str, text: str) -> str:
        """Chatnachricht ohne Claude-Umweg: in zwei, drei Sekunden statt zwanzig. Ohne genannte
        App die, über die Georg mit der Person sonst schreibt, sonst Discord."""
        from . import messaging

        app = app or self.contact_app(person) or "discord"
        found = messaging.find_app(app)
        where = "Discord" if person.startswith("#") else (found.name if found else app)
        label = f"Schreibt in {person} auf {where}" if person.startswith("#") else f"Schreibt {person} auf {where}"
        step = {"id": f"m{next(self._ids)}", "tool": "Nachricht", "label": label, "detail": text,
                "kind": "message", "state": "running"}
        self.ui.progress(step)
        started = time.monotonic()
        try:
            messaging.send(app, person, text)
        except messaging.MessagingError as exc:
            self.ui.progress(dict(step, state="error", seconds=round(time.monotonic() - started, 1)))
            return f"{exc}"
        self.ui.progress(dict(step, state="done", seconds=round(time.monotonic() - started, 1)))
        self.learn("message", person, app=app)
        if person.startswith("#"):
            return random.choice([f"Steht in {person[1:]}, Sir.", "Gepostet, Sir."])
        return random.choice([f"An {person} ist raus, Sir.", "Gesendet, Sir.", f"Erledigt. {person} hat es."])

    def _discord(self, intent) -> str:
        """Discord ohne Maus: Chats, Kanäle, Server und Sprachkanäle über die Schnellsuche,
        stumm und taub über Discords eigene Tasten. Danach geht es zurück ins Spiel."""
        from . import messaging

        kind, target = intent.arg, intent.data.get("target", "")
        shown = target[:1].upper() + target[1:]
        labels = {
            "person": f"Öffnet den Chat mit {shown}", "channel": f"Öffnet den Kanal {shown}",
            "server": f"Öffnet den Server {shown}", "voice": f"Geht in den Sprachkanal {shown}",
            "call": f"Ruft {shown} an", "mute": "Schaltet das Discord-Mikrofon um", "deafen": "Schaltet den Discord-Ton um",
        }
        try:
            with self._step(labels[kind], "message"):
                if kind in ("mute", "deafen"):
                    messaging.discord_key(kind)
                elif kind == "call":
                    messaging.discord_call(target)
                else:
                    messaging.discord_open(target, kind)
        except messaging.MessagingError as exc:
            return str(exc)
        if kind in ("person", "call"):
            self.learn("message", shown, app="discord")
        return {
            "person": f"Der Chat mit {shown}, Sir.", "channel": f"Kanal {shown}, Sir.", "server": f"Server {shown}, Sir.",
            "voice": f"Sprachkanal {shown}, Sir.", "call": f"Ich rufe {shown} an, Sir.",
            "mute": "Discord-Mikrofon umgeschaltet, Sir.", "deafen": "Discord-Ton umgeschaltet, Sir.",
        }[kind]

    # ------------------------------------------------------------------ Gedächtnis und Vorschläge

    def _memory_command(self, action: str, fact: str) -> str:
        if action == "remember":
            self.memory.remember(fact)
            return random.choice(["Notiert, Sir.", "Ist gespeichert, Sir.", "Vermerkt, Sir. Ich vergesse es nicht."])
        if self.memory.forget(fact):
            return random.choice(["Vergessen, Sir.", "Gelöscht, Sir. Als hätten Sie es nie gesagt."])
        return "Dazu hatte ich mir nichts gemerkt, Sir."

    def check_suggestions(self, now=None) -> bool:
        """Bietet eine Routine an, wenn gerade ihre Zeit ist ("Sir, um diese Zeit öffnen Sie meist
        Discord und Spotify. Soll ich?"). Nie beim Zocken, nie wenn Georg nicht am PC ist."""
        if self.memory is None or not self._cfg.get("gedaechtnis", {}).get("vorschlaege", True):
            return False
        if self.busy or self.speaking or self._recording or self.gaming:
            return False
        if self.mute is not None and self.mute.muted:
            return False
        if not self._present() or self._fullscreen():
            return False
        routine = self.memory.due(now)
        if routine is None:
            return False
        self.memory.offered(routine, now)
        self._offer = (routine, time.monotonic() + 120)
        self.ui.suggestion(routine.as_dict())
        self.ui.message("jarvis", routine.question())
        self._follow_up = True  # die Antwort geht ohne "Hey Jarvis"
        self.say(routine.question())
        return True

    def _present(self) -> bool:
        """Sitzt Georg am PC (Maus oder Tastatur in den letzten fünf Minuten)?"""
        try:
            from .keys import idle_seconds

            return idle_seconds() < 300
        except Exception:
            return False

    def _fullscreen(self) -> bool:
        try:
            from .overlay import _fullscreen_app

            return bool(_fullscreen_app())
        except Exception:
            return False

    def _take_offer(self):
        offer, self._offer = self._offer, None
        if offer is None or time.monotonic() > offer[1]:
            return None
        return offer[0]

    def _answer_offer(self, routine, text: str) -> str | None:
        """Georgs Antwort auf einen Vorschlag. None = war keine Antwort, normal weiter."""
        from .tool import confirmed

        reply = intents.normalize(text)
        self.ui.suggestion(None)
        if re.search(r"\b(?:nie|niemals|nicht mehr fragen|frag (?:mich )?nicht mehr|hör auf damit)\b", reply):
            self.memory.feedback(routine.key, "nie")
            return "Verstanden, Sir. Das frage ich nicht mehr."
        if re.match(r"^(?:nein|nö|nee|ne|nicht jetzt|jetzt nicht|später|lass(?: es| mal)?|nein danke|danke nein)\b", reply):
            self.memory.feedback(routine.key, "nein")
            return random.choice(["Sehr wohl, Sir.", "Wie Sie wünschen."])
        if not confirmed(text):
            return None
        self.memory.feedback(routine.key, "ja")
        rest = []
        for command in routine.commands():
            intent = intents.match(command)
            done = self._do(intent, command) if intent is not None else None
            if done is None:
                rest.append(command)
        if rest:
            self._rest = " und ".join(rest)
        return random.choice([f"Sehr wohl. {routine.label}, Sir.", f"Kommt sofort, Sir: {routine.label}."])

    def contact_app(self, person: str) -> str:
        """Über welche App Georg mit dieser Person sonst schreibt (aus dem Gedächtnis)."""
        memory = getattr(self, "memory", None)
        if memory is None:
            return ""
        try:
            return memory.contact_app(person)
        except Exception:
            return ""

    def learn(self, kind: str, what: str, **data) -> None:
        """Merkt sich, was Georg tut, damit Jarvis Gewohnheiten erkennt (siehe memory.py)."""
        memory = getattr(self, "memory", None)
        if memory is None or not what:
            return
        try:
            memory.record(kind, what, **data)
        except Exception as exc:
            log.debug("Gedächtnis: %s", exc)

    def _remind(self, name: str, intent) -> str | None:
        """Erinnerungen und Timer sofort, ohne Claude."""
        from .reminders import spoken_when

        if self.reminders is None:
            return None
        when = intent.data["when"]
        self.reminders.add(when, intent.data["what"])
        if name == "timer":
            return random.choice([f"Timer läuft, Sir. {intent.arg}.", f"Sehr wohl. {intent.arg}, ab jetzt."])
        return f"Sehr wohl, Sir. Ich erinnere Sie {spoken_when(when)}."

    def _install(self, known) -> None:
        from . import apps

        try:
            said = apps.install(known.name)
        except Exception as exc:
            log.warning("Installation von %s: %s", known.name, exc)
            self.announce(f"{known.name} ließ sich leider nicht installieren, Sir. Einzelheiten stehen im Protokoll.")
            return
        try:
            apps.open_app(known.name)
            started = True
        except Exception:
            started = False
        if "schon installiert" in said:
            self.announce(f"{known.name} war schon installiert, Sir." + (" Ich habe es gestartet." if started else ""))
        else:
            self.announce(f"{known.name} ist installiert, Sir." + (" Es startet gerade." if started else ""))

    @property
    def full_permission(self) -> bool:
        """Georg hat Jarvis volle Freigabe erteilt: kein Nachfragen vor Herunterfahren & Co."""
        return bool(self._cfg.get("rechte", {}).get("volle_freigabe", True))

    def _power_pending(self) -> bool:
        if time.monotonic() < getattr(self, "_power_until", 0.0):
            return True
        try:
            from . import pc

            return pc.power_pending()  # auch, wenn das Gehirn es geplant hat
        except Exception:
            return False

    def abort_power(self) -> bool:
        """Hält ein geplantes Herunterfahren, einen Neustart o. Ä. auf. True, wenn etwas lief."""
        if not self._power_pending():
            return False
        from . import pc

        self._power_until = 0.0
        try:
            return pc.power_abort()
        except Exception as exc:
            log.warning("Herunterfahren ließ sich nicht aufhalten: %s", exc)
            return False

    def _power(self, action: str) -> str | None:
        """Herunterfahren, Neustart, Energiesparen, Abmelden. Ohne volle Freigabe fragt Claude
        erst nach. Mit Vorlauf, in dem "Abbrechen" alles aufhält."""
        from . import pc

        if not self.full_permission:
            return None
        delay = 15 if action in ("shutdown", "restart") else 6
        labels = {"shutdown": "Fährt den PC herunter", "restart": "Startet den PC neu",
                  "sleep": "Schickt den PC in den Energiesparmodus", "logoff": "Meldet ab"}
        with self._step(labels[action], "app", f"in {delay} Sekunden"):
            pc.power(action, delay)
        self._power_until = time.monotonic() + delay
        self.learn("power", action)
        return {
            "shutdown": f"Ich fahre in {delay} Sekunden herunter, Sir. Ein Abbrechen hält mich auf.",
            "restart": f"Neustart in {delay} Sekunden, Sir. Ein Abbrechen hält mich auf.",
            "sleep": "Gute Nacht, Sir. Der PC schläft gleich.",
            "logoff": "Ich melde Sie gleich ab, Sir.",
        }[action]

    def _gaming(self, on: bool) -> str:
        from . import pc

        try:
            pc.gaming_mode(on, self._cfg.get("gaming", {}))
        except Exception as exc:
            log.info("Gaming-Modus: %s", exc)
        self.set_gaming(on)
        if on:
            return "Gaming-Modus aktiv, Sir. Volle Leistung, und ich halte mich im Hintergrund. Viel Erfolg."
        return "Gaming-Modus beendet, Sir. Willkommen zurück."

    def toggle_gaming(self) -> None:
        """Gaming-Modus umschalten (Tray-Menü)."""
        threading.Thread(
            target=lambda: self.announce(self._gaming(not self.gaming)), name="jarvis-gaming", daemon=True
        ).start()

    def set_gaming(self, on: bool) -> None:
        """Im Gaming-Modus läuft Jarvis mit niedriger Priorität und ohne Einblendungen."""
        self.gaming = on
        try:
            import psutil

            proc = psutil.Process()
            if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):
                proc.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if on else psutil.NORMAL_PRIORITY_CLASS)
        except Exception as exc:
            log.debug("Priorität: %s", exc)
        self.ui.config(gaming=on)

    def _ask_claude(self, text: str, speak: bool) -> str:
        if self.brain is None:
            return "Mein Gehirn ist gerade nicht verbunden, Sir. Ist Claude Code installiert?"
        turn = f"a{next(self._ids)}"
        splitter = SentenceSplitter()
        shown: list[str] = []
        spoken_any = threading.Event()
        started = time.monotonic()
        sources = threading.Event()

        def on_text(chunk: str) -> None:
            for sentence in splitter.feed(chunk):
                emit(sentence)

        def emit(sentence: str) -> None:
            # Die Websuche hängt eine Quellenliste an ("Sources: ..."). Die liest Jarvis nicht vor.
            if sources.is_set():
                return
            cut = strip_sources(sentence)
            if cut != sentence.strip():
                sources.set()
                sentence = cut
            clean = speakable(sentence)
            if not clean:
                return
            shown.append(clean)
            self.ui.message("jarvis", " ".join(shown), id=turn, final=False)
            if speak:
                spoken_any.set()
                self.say(clean)

        # Was Claude gerade tut: in der Anzeige sofort, gesagt nur, wenn es dauert.
        said_progress: list[float] = []

        def on_step(step) -> None:
            self.ui.progress(step.to_dict())
            if not speak or step.state != "running" or not step.spoken:
                return

            def tell() -> None:
                if step.state != "running" or not self._busy:
                    return  # schon fertig: nichts ansagen
                now = time.monotonic()
                if len(said_progress) >= PROGRESS_MAX:
                    return
                if said_progress and now - said_progress[-1] < PROGRESS_EVERY:
                    return
                if not said_progress and spoken_any.is_set() and now - started < PROGRESS_EVERY:
                    return  # Claude hat schon selbst etwas gesagt
                said_progress.append(now)
                spoken_any.set()
                self.say(step.spoken)

            later = threading.Timer(PROGRESS_AFTER, tell)
            later.daemon = True
            later.start()

        # Wenn Claude länger braucht, sagt Jarvis schon mal "Einen Moment, Sir."
        timer = None
        if speak and self._ack_after > 0:
            def acknowledge() -> None:
                if not spoken_any.is_set() and self._busy:
                    spoken_any.set()
                    self.say(random.choice(FILLERS))

            timer = threading.Timer(self._ack_after, acknowledge)
            timer.daemon = True
            timer.start()

        try:
            answer = self.brain.ask(text, on_text=on_text, on_step=on_step)
        except Cancelled:
            return ""
        except BrainError as exc:
            if isinstance(exc, RefusalError):
                log.warning("Alle Versuche wurden abgelehnt: %s", exc)
            else:
                log.error("%s", exc)
            message = exc.spoken
            self.ui.message("jarvis", message, id=turn)
            self.ui.toast(_short_reason(exc), "error")
            if speak:
                self.say(message)
            return message
        finally:
            if timer is not None:
                timer.cancel()

        for sentence in splitter.flush():
            emit(sentence)
        full = speakable(strip_sources(answer.text)) or " ".join(shown)
        if not shown and full and speak:
            # Nichts kam gestreamt an (ältere Claude-Version): ganze Antwort vorlesen.
            self.say(full)
        self.ui.message("jarvis", full or "(keine Antwort)", id=turn, model=answer.model, final=True)
        self.ui.config(model=answer.model)
        log.info("Claude (%s) nach %.1f s", answer.model, time.monotonic() - started)
        return full

    # ------------------------------------------------------------------ Erinnerungen

    def check_reminders(self) -> None:
        if self.reminders is None:
            return
        due = self.reminders.due()
        if not due:
            return
        self.reminders.remove({r["id"] for r in due})
        for r in due:
            self.announce(f"Erinnerung, Sir: {r['text']}")


def _short_reason(exc: BrainError) -> str:
    return {
        "refusal": "Das wurde abgelehnt, auch mit den anderen Modellen.",
        "limit": "Das Claude-Kontingent ist gerade aufgebraucht.",
        "login": "Nicht angemeldet. Einstellungen > Gehirn hilft.",
        "network": "Keine Internetverbindung.",
        "overloaded": "Gerade überlastet, gleich nochmal versuchen.",
        "timeout": "Hat zu lange gedauert.",
        "missing": "Claude Code fehlt. Einstellungen > Gehirn hilft.",
        "model": "Gerade kein Modell erreichbar.",
        "account": "Das Claude-Konto meldet ein Problem (claude.ai).",
        "billing": "Abgerechnet wird über einen API-Schlüssel statt über das Abo.",
    }.get(exc.kind, "Fehler: " + (str(exc).strip().splitlines() or ["unbekannt"])[0][:160])


def _join(answers: list[str]) -> str:
    """Mehrere kurze Antworten zu einer: nur die letzte endet mit "Sir"."""
    answers = [a.strip() for a in answers if a and a.strip()]
    if len(answers) < 2:
        return answers[0] if answers else ""
    trimmed = [re.sub(r",? Sir\.$", ".", a) for a in answers[:-1]]
    return " ".join(trimmed + [answers[-1]])


def _display(name: str) -> str:
    """So heißt es in der Anzeige: "youtube" -> "YouTube", "vs code" -> "Visual Studio Code"."""
    from . import apps, web

    known = apps.find_known(name)
    if known is not None:
        return known.name
    site = web.site(name)
    if site is not None:
        return site[0]
    return name[:1].upper() + name[1:]
