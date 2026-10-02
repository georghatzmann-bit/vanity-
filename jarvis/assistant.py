"""Der Kern: nimmt einen Befehl (gesprochen, getippt oder von Home Assistant),
erledigt ihn selbst oder fragt Claude, und spricht die Antwort."""

from __future__ import annotations

import contextlib
import datetime as dt
import itertools
import logging
import os
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
        # Ein fälliger Vorschlag, der auf die nächste Antwort wartet (Routine, bis wann)
        self._tip = None
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
        """Sagt etwas von sich aus, z. B. eine Erinnerung. Sitzt Georg nicht am PC, kommt es auch
        als Benachrichtigung aufs Handy (wenn eingeschaltet, siehe push.py)."""
        self.ui.message("jarvis", text)
        self.say(text)
        self._push(text)

    def speech_wav(self, text: str) -> bytes:
        """Ein Satz in Jarvis' Stimme als WAV-Datei (für die Handy-App)."""
        import io
        import wave

        from .text import speakable
        from .tts import materialize

        tts = getattr(self, "tts", None)
        text = speakable(text)[:600]
        if tts is None or not text:
            raise RuntimeError("Keine Stimme verfügbar")
        samples, rate = tts.synthesize(text)
        samples = materialize(samples)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(int(rate))
            out.writeframes(samples.astype("<i2").tobytes())
        return buffer.getvalue()

    def hear(self, data: bytes) -> str:
        """Aufnahme vom Handy (webm, mp4 oder wav) in Text. Leer = nichts verstanden."""
        import io

        transcriber = getattr(self, "transcriber", None)
        if transcriber is None:
            from .stt import make_transcriber

            transcriber = self.transcriber = make_transcriber(self._cfg["stt"])
        from faster_whisper import decode_audio

        audio = decode_audio(io.BytesIO(data), sampling_rate=16000)
        if audio.size < 16000 * 0.3:
            return ""
        return transcriber.transcribe(audio).strip()

    def _push(self, text: str) -> None:
        push = getattr(self, "push", None)
        if push is None or not push.enabled or not text:
            return
        try:
            # Sitzt Georg am PC, hört er es. Mit Controller im Vollbild zählt Windows keine Eingaben,
            # er ist aber trotzdem da.
            if self._present() or self._fullscreen():
                return
        except Exception:
            pass
        push.send(text, priority=4 if text.startswith("Erinnerung") else 3, click=self._phone_link())

    def _phone_link(self) -> str:
        """Tippen auf die Benachrichtigung öffnet die Handy-App (ohne Schlüssel, den hat das Handy schon)."""
        server = getattr(self, "server", None)
        if server is None or not getattr(server, "running", False):
            return ""
        try:
            from .remote import local_ip

            return f"http://{local_ip()}:{server.port}/app/"
        except Exception:
            return ""

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
                    tip = self._take_tip(answer)
                    if tip:
                        self.ui.message("jarvis", tip)
                        if speak:
                            self.say(tip)
                        answer = f"{answer} {tip}"
                else:
                    tip = "" if rest else self._take_tip(answer)
                    if tip:
                        answer = f"{answer} {tip}"
                    if answer:
                        self.ui.message("jarvis", answer)
                        if speak:
                            self.say(answer)
                    if rest:
                        # "Öffne Spotify und schreib mir ein Gedicht": den Teil kann nur Claude
                        later = self._ask_claude(rest, speak)
                        answer = " ".join(a for a in (answer, later) if a)
                log.info("Antwort: %s", answer)
                self._journal(text, answer)
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
            own = self.memory.command_for(text)
            if isinstance(own, dict):
                return self._custom(own)
        if getattr(self, "schedules", None) is not None:
            from .zeitplan import match_schedule

            planned = match_schedule(text)
            if planned is not None:
                return self._schedule_command(*planned)
        if getattr(self, "calendar", None) is not None:
            from .kalender import match_calendar

            planned = match_calendar(text, dt.datetime.now())
            if planned is not None:
                return self._calendar_command(*planned)
        if getattr(self, "notebook", None) is not None:
            from .notebook import match_notebook

            noted = match_notebook(text)
            if noted is not None:
                return self._notebook_command(*noted)
        if getattr(self, "shop", None) is not None:
            from .shop import match_shop

            asked = match_shop(text)
            if asked is not None:
                return self._shop_command(asked)
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
        if name == "disk_free":
            return self._disk_free()
        if name == "good_night":
            return self._good_night()
        if name == "thanks":
            return random.choice(["Gern geschehen, Sir.", "Stets zu Diensten, Sir.", "Immer gern, Sir.",
                                  "Keine Ursache, Sir."])
        if name == "help":
            return ("Fast alles am PC, Sir: Programme öffnen und installieren, Discord und Chats ohne Maus, Erinnerungen, "
                    "Wetter, Musik, Licht, den PC herunterfahren, und in der Werkstatt programmiere ich für Sie. "
                    "Sagen Sie zum Beispiel: Schreib Max auf Discord, bin gleich da.")
        if name == "time":
            return intents.spoken_time(now)
        if name == "date":
            return intents.spoken_date(now.date())
        try:
            from . import pc

            if name == "show_desktop":
                from . import keys

                keys.press("win", "d")
                return ""
            if name == "screenshot":
                from . import keys

                keys.press("win", "printscreen")
                return random.choice(["Screenshot ist gespeichert, Sir. Er liegt unter Bilder, Screenshots.",
                                      "Festgehalten, Sir. Unter Bilder, Screenshots."])
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
            if name == "restart_app":
                return self._restart_app(intent.arg)
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

    def _restart_app(self, target: str) -> str | None:
        """"Starte Discord neu": schließen, kurz warten, wieder öffnen. None = Claude soll es versuchen."""
        from . import apps

        try:
            with self._step(f"Startet {_display(target)} neu", "app"):
                try:
                    apps.close_app(target)
                    time.sleep(1.5)
                except apps.AppNotFound:
                    pass  # lief nicht: einfach starten
                said = apps.open_app(target)
        except apps.AppNotFound:
            return None
        name = said.removesuffix(" startet.").removesuffix(" ist offen.")
        return random.choice([f"{name} startet neu, Sir.", f"Sehr wohl, {name} kommt frisch."])

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
        device = intent.data.get("device") or ""
        # "Licht in der Küche", nicht "Licht im Küche"
        where = f" {intent.data.get('prep') or 'im'} {room[:1].upper() + room[1:]}" if room else ""
        what = device[:1].upper() + device[1:] if device else "Licht"
        label = f"{what}{where} " + ("aus" if not on else f"auf {pct} Prozent" if pct else "an")
        with self._step(label, "app"):
            try:
                # "decke" findet "Deckenlicht" und "Küche Decke"
                ha.light(" ".join(w for w in ({"deckenlicht": "decke"}.get(device, device), room) if w), on, pct)
            except HomeAssistantError:
                if not ha.alexa:
                    raise
                ha.alexa_command(room if ha.alexa_target_or_none(room) else ha.first_echo(), intent.data.get("said") or label)
        if not on:
            return random.choice([f"{what}{where} ist aus, Sir.", "Erledigt, Sir. Gemütlich dunkel."])
        if pct:
            return f"{what}{where} auf {pct} Prozent, Sir."
        return random.choice([f"{what}{where} ist an, Sir.", "Es werde Licht, Sir."])

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
        if intent.data.get("any_app") and self.contact_app(target) in ("whatsapp", "telegram"):
            return None  # "Ruf Max an", Max schreibt aber über WhatsApp: das versucht Claude
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
        elif kind == "voice":
            self.learn("voice", shown)
        return {
            "person": f"Der Chat mit {shown}, Sir.", "channel": f"Kanal {shown}, Sir.", "server": f"Server {shown}, Sir.",
            "voice": f"Sprachkanal {shown}, Sir.", "call": f"Ich rufe {shown} an, Sir.",
            "mute": "Discord-Mikrofon umgeschaltet, Sir.", "deafen": "Discord-Ton umgeschaltet, Sir.",
        }[kind]

    # ------------------------------------------------------------------ Gedächtnis und Vorschläge

    def _custom(self, own: dict) -> str:
        """Ein eigener Befehl ("Zockmodus"): erledigt, was dahinter steht, als hätte Georg es gesagt.
        Was Jarvis davon nicht selbst kann, macht Claude (self._rest)."""
        action = own["aktion"]
        self.memory.used_command(own["key"])
        with self._step(f"Eigener Befehl: {own['name']}", "app", action):
            intent = intents.match(action)
            if intent is not None and intent.name != "stop":
                answer = self._do(intent, action)
            else:
                parts = intents.match_parts(action) if self._local else None
                answer = self._many(parts) if parts else None
        if answer is None:
            self._rest = action
            return ""
        return answer

    def _journal(self, said: str, answer: str) -> None:
        """Jedes Gespräch ins Tagebuch des Notizbuchs (Passwörter und Ähnliches nicht)."""
        notebook = getattr(self, "notebook", None)
        if notebook is None or not self._cfg.get("notizbuch", {}).get("tagebuch", True):
            return
        try:
            from .memory import is_secret

            if is_secret(said) or is_secret(answer):
                said, answer = "(etwas Vertrauliches, nicht notiert)", ""
            names = [c.get("name", "") for c in self.memory.contacts()[:40]] if self.memory is not None else []
            notebook.log(said, answer, names)
            if time.monotonic() - notebook.last_sync > 600:
                notebook.last_sync = time.monotonic()
                threading.Thread(target=notebook.sync, args=(self.memory,), name="jarvis-notizbuch", daemon=True).start()
        except Exception as exc:
            log.debug("Notizbuch: %s", exc)

    def _notebook_command(self, action: str, text: str) -> str:
        notebook = self.notebook
        if action == "open":
            try:
                notebook.sync(self.memory)
                if os.name == "nt":
                    os.startfile(str(notebook.folder))  # Explorer, oder Obsidian, wenn Georg es so eingestellt hat
            except Exception as exc:
                log.warning("Notizbuch öffnen: %s", exc)
                return f"Das Notizbuch liegt in {notebook.folder}, Sir. Öffnen ging gerade nicht."
            return "Das Notizbuch ist offen, Sir."
        from .memory import is_secret

        if is_secret(text):
            return "Passwörter und PINs schreibe ich lieber nicht auf, Sir. Ein Passwort-Manager ist dafür der bessere Ort."
        if text.lower().startswith("dass "):
            from .messaging import direct_speech

            text = direct_speech(text) or text[5:]
        try:
            notebook.note(text[:1].upper() + text[1:])
        except Exception as exc:
            log.warning("Notiz: %s", exc)
            return "Die Notiz ging gerade nicht ins Notizbuch, Sir."
        return random.choice(["Notiert, Sir. Steht im Notizbuch.", "Ist im Notizbuch, Sir."])

    def _calendar_command(self, action: str, data) -> str:
        calendar = self.calendar
        now = dt.datetime.now()
        if action == "ask":
            if data == "next":
                event = calendar.next_event()
                if event is None:
                    return "In den nächsten 30 Tagen steht nichts im Kalender, Sir."
                return f"Ihr nächster Termin, Sir: {event.spoken(now, with_day=True)}."
            if data == "woche":
                events = calendar.upcoming(24 * 7)
                if not events:
                    return "Diese Woche steht nichts im Kalender, Sir."
                parts = [e.spoken(now, with_day=True) for e in events[:8]]
                more = f" und {len(events) - 8} weitere" if len(events) > 8 else ""
                return f"In den nächsten sieben Tagen, Sir: {'; '.join(parts)}{more}."
            said = calendar.describe_day(data)
            notes = self._reminders_on(data, now)
            if notes:  # "Was steht heute an?" meint auch die Erinnerungen, nicht nur den Kalender
                said += f" Erinnerungen: {_join_names(notes)}."
            return said
        if action == "remove":
            gone = calendar.remove(data)
            if not gone:
                return (f"Einen eigenen Termin „{data}“ finde ich nicht, Sir. Termine aus Ihrem Google- oder "
                        "Outlook-Kalender ändern Sie bitte dort.")
            return f"Gestrichen, Sir: {gone[0].spoken(now, with_day=True)}."
        title, start, end, all_day = data
        event = calendar.add(title, start, end, all_day)
        clash = [e for e in calendar.events(event.start, event.end) if e.id != event.id and not e.all_day
                 and not event.all_day]
        said = f"Eingetragen, Sir: {event.spoken(now, with_day=True)}."
        if clash:
            said += f" Achtung, da ist schon {clash[0].spoken(now)}."
        return said

    def _reminders_on(self, day: dt.date, now: dt.datetime) -> list[str]:
        if self.reminders is None:
            return []
        notes = []
        for item in self.reminders.upcoming(now):
            try:
                when = dt.datetime.fromisoformat(item["zeit"])
            except (KeyError, ValueError):
                continue
            if when.date() == day:
                # "Der Timer ist abgelaufen." und "Ihr Wecker. Zeit aufzustehen" klingen in der Liste schief
                text = str(item.get("text", "")).strip().rstrip(".")
                text = "Timer" if text == "Der Timer ist abgelaufen" else "Wecker" if text.startswith("Ihr Wecker") else text
                notes.append(f"um {when.hour}:{when.minute:02d} Uhr {text}".strip())
        return notes[:5]

    def _schedule_command(self, action: str, data) -> str:
        from .zeitplan import describe

        schedules = self.schedules
        if action == "list":
            items = schedules.all()
            if not items:
                return ("Noch keine Zeitpläne, Sir. Sagen Sie zum Beispiel: Jeden Morgen um 8 Uhr Briefing, "
                        "oder: Werktags um 18 Uhr öffne Discord.")
            return "Ihre Zeitpläne, Sir: " + "; ".join(describe(i) for i in items[:8]) + "."
        if action == "remove":
            gone = schedules.remove(data)
            return f"Gelöscht, Sir: {describe(gone)}." if gone else f"Einen Zeitplan „{data}“ finde ich nicht, Sir."
        days, clock, command = data
        try:
            item = schedules.add(days, clock, command)
        except ValueError as exc:
            return str(exc)
        return f"Eingerichtet, Sir: {describe(item)}."

    def check_schedules(self, now=None) -> None:
        """Zeitpläne zur Zeit erledigen. Läuft gerade ein Spiel im Vollbild, kurz warten."""
        schedules = getattr(self, "schedules", None)
        if schedules is None:
            return
        try:
            hold = bool(self._fullscreen()) or self.busy
        except Exception:
            hold = False
        for item in schedules.due(now, hold=hold):
            threading.Thread(target=self._run_scheduled, args=(item,), name="jarvis-zeitplan", daemon=True).start()

    def _run_scheduled(self, item: dict) -> None:
        command = item["befehl"]
        log.info("Zeitplan: %s", command)
        try:
            present = self._present()
        except Exception:
            present = True
        answer = self.handle(command, speak=present)
        if not present and answer:
            self._push(f"{command}: {answer}")

    def _shop_command(self, kind: str) -> str:
        """"Wie läuft der Shop?" und "Wann kommt die nächste Auszahlung?" sofort, ohne Claude."""
        from .shop import ShopError, spoken_payout, spoken_summary

        shop = self.shop
        if not shop.configured:
            return ("Der Shop ist noch nicht verbunden, Sir. Im Fenster unter Verbinden > Shop geht das in "
                    "zwei Minuten.")
        try:
            if kind == "payout":
                return spoken_payout(shop.payouts(), shop._now().date())
            return spoken_summary(shop.summary())
        except ShopError as exc:
            log.warning("Shop: %s", exc)
            return str(exc)

    def check_shop(self) -> None:
        """Neue Bestellungen ansagen ("Neue Bestellung im Shop, Sir: 29 Euro"), aufs Handy, wenn Georg
        weg ist. Beim Zocken im Vollbild nur aufs Handy, nicht in die Ohren."""
        shop = getattr(self, "shop", None)
        if shop is None or not shop.configured or not shop.announce_orders:
            return
        from .shop import ShopError, spoken_order

        try:
            fresh = shop.new_orders()
        except ShopError as exc:
            log.info("Shop: %s", exc)
            return
        for order in fresh[:5]:
            text = spoken_order(order)
            if self.gaming or self._fullscreen():
                self.ui.message("jarvis", text)
                push = getattr(self, "push", None)
                if push is not None and push.enabled:
                    push.send(text, priority=3, click=self._phone_link())
            else:
                self.announce(text)

    def check_calendar(self) -> None:
        """Kurz vor einem Termin Bescheid sagen, und Änderungen im Kalender ansagen."""
        calendar = getattr(self, "calendar", None)
        if calendar is None:
            return
        minutes = int(self._cfg.get("kalender", {}).get("vorwarnung_minuten", 15) or 0)
        if minutes > 0:
            for event in calendar.due_warnings(minutes):
                left = max(1, round((event.start - dt.datetime.now()).total_seconds() / 60))
                where = f" ({event.place})" if event.place else ""
                self.announce(f"Sir, in {left} Minuten: {event.title}{where}." if left > 1
                              else f"Sir, jetzt: {event.title}{where}.")
        for change in calendar.changes():
            self.announce(f"Sir, eine Änderung im Kalender: {change}")

    def _commands_list(self) -> str:
        commands = self.memory.custom_commands()
        if not commands:
            return ("Noch keine eigenen Befehle, Sir. Sagen Sie zum Beispiel: Wenn ich Zockmodus sage, "
                    "öffne Discord und Steam. Danach reicht das eine Wort.")
        if len(commands) == 1:
            return f"Ein eigener Befehl, Sir: „{commands[0]['name']}“, das heißt: {commands[0]['aktion']}."
        names = [f"„{c['name']}“" for c in commands[:12]]
        return f"Sie haben {len(commands)} eigene Befehle, Sir: {_join_names(names)}."

    def _memory_command(self, action: str, fact) -> str:
        if action == "recall":
            return self._recall()
        if action == "commands":
            return self._commands_list()
        if action == "teach":
            trigger, what = fact
            try:
                saved = self.memory.teach(trigger, what)
            except ValueError as exc:
                return str(exc)
            return random.choice([
                f"Verstanden, Sir. Ab jetzt reicht „{saved['name']}“, und ich erledige: {saved['aktion']}.",
                f"Notiert, Sir. Sagen Sie „{saved['name']}“, dann heißt das: {saved['aktion']}.",
            ])
        if action == "unteach":
            removed = self.memory.unteach(fact)
            if removed is None:
                return f"Einen eigenen Befehl „{fact}“ kenne ich nicht, Sir."
            return f"Der Befehl „{removed['name']}“ ist gelöscht, Sir."
        if action == "remember":
            from .memory import is_secret

            if is_secret(fact):
                return ("Passwörter und PINs merke ich mir lieber nicht, Sir. Mein Gedächtnis ist dafür nicht "
                        "sicher genug. Ein Passwort-Manager ist der bessere Ort.")
            self.memory.remember(fact)
            return random.choice(["Notiert, Sir.", "Ist gespeichert, Sir.", "Vermerkt, Sir. Ich vergesse es nicht."])
        if self.memory.forget(fact):
            return random.choice(["Vergessen, Sir.", "Gelöscht, Sir. Als hätten Sie es nie gesagt."])
        return "Dazu hatte ich mir nichts gemerkt, Sir."

    def _good_night(self) -> str:
        """"Gute Nacht": kurz verabschieden und anbieten, den PC herunterzufahren. Ein "Ja" fährt ihn
        mit Vorlauf herunter ("Stopp" hält es auf), "Nie wieder" stellt die Frage ab."""
        from .memory import Occasion

        hello = random.choice(["Gute Nacht, Sir.", "Schlafen Sie gut, Sir."])
        key = "gute-nacht:herunterfahren"
        if self.memory is None or not self.memory.may_offer(key, every_days=0):
            return hello
        occasion = Occasion(key, "PC herunterfahren", hello, "Soll ich den PC herunterfahren?", "Fahr den PC herunter")
        self.memory.offered(occasion)
        self._offer = (occasion, time.monotonic() + 60)
        return occasion.question()

    def _disk_free(self) -> str:
        """"Wie viel Speicher ist frei?" sofort: freie Gigabyte auf jedem eingebauten Laufwerk."""
        try:
            import psutil

            drives = []
            for part in psutil.disk_partitions(all=False):
                opts = (part.opts or "").lower()
                if not part.fstype or "cdrom" in opts or "removable" in opts:
                    continue
                try:
                    usage = psutil.disk_usage(part.mountpoint)
                except OSError:
                    continue
                if usage.total < 20 * 1024 ** 3:
                    continue
                name = part.mountpoint.rstrip("\\/").rstrip(":") or part.mountpoint
                drives.append((name, int(usage.free / 1024 ** 3)))
        except Exception as exc:
            log.debug("Speicher: %s", exc)
            return None
        if not drives:
            return None
        first, rest = drives[0], drives[1:5]
        text = f"Auf Laufwerk {first[0]} sind {first[1]} Gigabyte frei"
        text += "".join(f", auf {name} {free}" for name, free in rest)
        return text + ", Sir."

    def _recall(self) -> str:
        """"Was weißt du über mich?" sofort aus dem Gedächtnis, ohne Claude."""
        facts = self.memory.facts()
        routines = self.memory.routines()
        if not facts and not routines:
            return "Noch nicht viel, Sir. Sagen Sie „Merk dir, …“, und ich behalte es. Ihre Gewohnheiten lerne ich mit der Zeit von selbst."

        def spoken(text: str) -> str:
            said = re.match(r"[\wÄÖÜäöüß-]+ sagt:\s*(.+)$", text)
            return f"„{said.group(1)}“" if said else text

        parts = []
        if facts:
            count = "eine Sache" if len(facts) == 1 else f"{len(facts)} Dinge"
            latest = [spoken(f.get("text", "")) for f in facts[-3:]][::-1]
            parts.append(f"Ich weiß {count} über Sie, Sir. Zuletzt: " + "; ".join(latest) + ".")
        if routines:
            habit = "Gewohnheit" if len(routines) == 1 else "Gewohnheiten"
            parts.append(f"{habit}: " + "; ".join(r.describe() for r in routines[:2]) + ".")
        soon = [b for b in self.memory.upcoming_birthdays(days=14) if not b["own"]][:1]
        if soon:
            days = soon[0]["in_tagen"]
            when = "heute" if days == 0 else "morgen" if days == 1 else f"in {days} Tagen"
            parts.append(f"{soon[0]['shown']} hat {when} Geburtstag.")
        parts.append("Alles steht im Fenster unter Gedächtnis.")
        return " ".join(parts)

    # So lange wartet ein Vorschlag auf die nächste Antwort, danach verfällt er (eine Routine hat
    # ihre Zeit sowieso nur ungefähr eine halbe Stunde lang).
    TIP_MINUTES = 30

    def check_suggestions(self, now=None) -> bool:
        """Merkt sich, was gerade passt: eine Routine ("um diese Zeit öffnen Sie meist Discord und
        Spotify"), einen Geburtstag oder eine fast volle Festplatte. Jarvis zeigt dafür kein Fenster
        und unterbricht nicht, sondern sagt es als Ergänzung zu seiner nächsten Antwort ("..., Sir.
        Übrigens: ... Soll ich?"). Nur ein Geburtstag ohne Frage wird abends notfalls von selbst gesagt,
        damit er nicht untergeht. Nie beim Zocken, nie wenn Georg nicht am PC ist."""
        if self.memory is None or not self._cfg.get("gedaechtnis", {}).get("vorschlaege", True):
            return False
        if self._tip is not None and time.monotonic() < self._tip[1]:
            return self._announce_late(now)
        self._tip = None
        if self.gaming or not self._present() or self._fullscreen():
            return False
        routine = self.memory.due(now) or self._disk_notice(now)
        if routine is None:
            return False
        self._tip = (routine, time.monotonic() + self.TIP_MINUTES * 60)
        return True

    def _announce_late(self, now=None) -> bool:
        """Ein Geburtstag, der bis zum Abend auf keine Antwort passte: dann doch von selbst sagen
        (mit "Soll ich gratulieren?", wenn Jarvis weiß, wie), wenn Georg da ist und nichts los ist."""
        routine = self._tip[0]
        now = now or dt.datetime.now()
        if now.hour < 18 or not getattr(routine, "key", "").startswith("geburtstag"):
            return False
        if self.busy or self.speaking or self._recording or self.gaming:
            return False
        if (self.mute is not None and self.mute.muted) or not self._present() or self._fullscreen():
            return False
        self._tip = None
        self.memory.offered(routine, now)
        if routine.commands():  # "Soll ich Max gratulieren?": das Ja geht ohne "Hey Jarvis"
            self._offer = (routine, time.monotonic() + 120)
            self._follow_up = True
        self.ui.message("jarvis", routine.question())
        self.say(routine.question())
        return True

    def _take_tip(self, answer: str) -> str:
        """Der wartende Vorschlag als Ergänzung zur Antwort ("Übrigens, Sir: ..."), oder "".
        Nicht, wenn Jarvis selbst gerade etwas fragt, wenn schon ein Vorschlag offen ist oder
        Georg zockt. Mit Frage darin geht Georgs "Ja" ohne "Hey Jarvis" (die Antwort endet auf "?")."""
        if self._tip is None or self.memory is None:
            return ""
        routine, until = self._tip
        if time.monotonic() > until:
            self._tip = None
            return ""
        answer = str(answer or "").strip()
        if not answer or answer.endswith("?") or self._offer is not None or self.gaming or self._fullscreen():
            return ""
        self._tip = None
        self.memory.offered(routine)
        if routine.commands():
            self._offer = (routine, time.monotonic() + 120)
        return tip_sentence(routine.question())

    def _disk_notice(self, now=None):
        """Eine fast volle Festplatte (bei Spielen schnell passiert), höchstens alle drei Tage und
        nur tagsüber: "Sir, auf Laufwerk C sind nur noch 6 Gigabyte frei. Soll ich nachsehen, ...?" """
        from .memory import Occasion

        now = now or dt.datetime.now()
        if time.monotonic() < getattr(self, "_disk_checked", 0.0) or not 9 <= now.hour < 22:
            return None
        self._disk_checked = time.monotonic() + 3600  # höchstens einmal pro Stunde nachsehen
        try:
            from . import pc

            low = pc.low_disks()
        except Exception as exc:
            log.debug("Festplatten: %s", exc)
            return None
        for drive, free in low:
            key = f"speicher:{drive.lower()}"
            if not self.memory.may_offer(key, now, every_days=3):
                continue
            amount = "weniger als ein Gigabyte" if free < 1 else "ein Gigabyte" if free == 1 else f"{free} Gigabyte"
            return Occasion(key, f"Laufwerk {drive} fast voll", f"Sir, auf Laufwerk {drive} ist nur noch {amount} frei."
                            if free <= 1 else f"Sir, auf Laufwerk {drive} sind nur noch {amount} frei.",
                            "Soll ich nachsehen, was dort am meisten Platz braucht?",
                            f"Schau schnell nach, was auf Laufwerk {drive} am meisten Platz braucht (Downloads, Spiele-Ordner "
                            f"wie Steam, Papierkorb, Temp, ohne das ganze Laufwerk zu durchsuchen), und schlag vor, was weg kann")
        return None

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
        if re.search(r"\b(?:nie|niemals|nicht mehr fragen|frag (?:mich )?nicht mehr|hör auf damit)\b", reply):
            self.memory.feedback(routine.key, "nie")
            return "Verstanden, Sir. Das frage ich nicht mehr."
        if re.match(r"^(?:nein|nö|nee|ne|nicht jetzt|jetzt nicht|später|lass(?: es| mal)?|nein danke|danke nein)\b", reply):
            self.memory.feedback(routine.key, "nein")
            return random.choice(["Sehr wohl, Sir.", "Wie Sie wünschen."])
        if not confirmed(text):
            return None
        self.memory.feedback(routine.key, "ja")
        rest, said = [], []
        for command in routine.commands():
            intent = intents.match(command)
            done = self._do(intent, command) if intent is not None else None
            if done is None:
                rest.append(command)
            elif done:
                said.append(done)
        if rest:
            self._rest = " und ".join(rest)
        from .memory import Occasion

        if isinstance(routine, Occasion):
            return " ".join(said) or "Sehr wohl, Sir."  # "An Max ist raus, Sir." oder warum nicht
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
        if str(intent.data["what"]).startswith("Ihr Wecker"):
            return f"Sehr wohl, Sir. Ich wecke Sie {spoken_when(when)}."
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


def tip_sentence(question: str) -> str:
    """Ein Vorschlag als Ergänzung zur Antwort: "Sir, um diese Zeit ... Soll ich?" wird
    "Übrigens, Sir: Um diese Zeit ... Soll ich?"."""
    text = str(question or "").strip()
    if not text:
        return ""
    if text.startswith("Sir, "):
        text = text[5:]
        return "Übrigens, Sir: " + text[:1].upper() + text[1:]
    return "Übrigens: " + text


def _join_names(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


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
