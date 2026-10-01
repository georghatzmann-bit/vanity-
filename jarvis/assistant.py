"""Der Kern: nimmt einen Befehl (gesprochen, getippt oder von Home Assistant),
erledigt ihn selbst oder fragt Claude, und spricht die Antwort."""

from __future__ import annotations

import datetime as dt
import itertools
import logging
import queue
import random
import threading
import time

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
        self.gaming = False
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

    def submit(self, text: str) -> None:
        """Nimmt einen Befehl an und erledigt ihn im Hintergrund (für Sprache und Oberfläche)."""
        if not text.strip():
            return
        intent = intents.match(text)
        if intent is not None and intent.name == "stop":
            # Sofort, nicht erst nach der laufenden Antwort (die hängt sonst davor in der Schlange).
            self.ui.message("user", text)
            self.stop()
            self.update_state()
            return
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, name="jarvis-befehle", daemon=True)
            self._worker.start()
        self._queue.put(text)
        self.update_state()

    def _work(self) -> None:
        while True:
            text = self._queue.get()
            try:
                self.handle(text)
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
                answer = self._local_answer(text)
                if answer is None:
                    answer = self._ask_claude(text, speak)
                elif answer:
                    self.ui.message("jarvis", answer)
                    if speak:
                        self.say(answer)
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
        intent = intents.match(text)
        if intent is None:
            return None
        name = intent.name
        if name == "stop":
            if self.speaker is not None:
                self.speaker.stop()
            return ""
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
        except Exception as exc:
            log.info("Schneller Befehl %s ging nicht (%s), frage Claude.", name, exc)
            return None
        return None

    def _app(self, action: str, target: str) -> str | None:
        """Programme öffnen, schließen und installieren. None = Claude soll es versuchen."""
        from . import apps

        if action == "open":
            try:
                said = apps.open_app(target)
            except apps.AppNotFound:
                return None
            if said.endswith(" startet."):
                name = said.removesuffix(" startet.")
                return random.choice([f"{name} startet, Sir.", f"Sehr wohl, {name} kommt.", f"{name}, kommt sofort."])
            return said.replace(" ist offen.", " ist offen, Sir.")
        if action == "close":
            try:
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
            answer = self.brain.ask(text, on_text=on_text)
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
