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
from .text import SentenceSplitter, speakable
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
        self._speaking = False
        self._last_state = ""
        self._ids = itertools.count(1)
        self._worker: threading.Thread | None = None
        if brain is not None and hasattr(brain, "notice"):
            brain.notice = lambda text: self.ui.message("info", text)

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
        elif self._busy:
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
            finally:
                self._busy -= 1
                self.update_state()
        if speak and self.speaker is not None:
            self.speaker.wait(timeout=120)
        self.update_state()
        return answer

    def _local_answer(self, text: str) -> str | None:
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

            hotkey = hotkey_label(self._cfg.get("mute", {}).get("hotkey", ""), spoken=True)
            return f"Sehr wohl, Sir. Mit {hotkey} hole ich Sie wieder zurück." if hotkey else "Sehr wohl, Sir."
        if name == "reset":
            if self.brain is not None:
                self.brain.new_conversation()
            return "Sehr wohl, Sir. Wir fangen von vorne an."
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
            if name in ("media_pause", "media_play"):
                pc.media("pause")
                return ""
            if name == "media_next":
                pc.media("naechstes")
                return ""
            if name == "media_prev":
                pc.media("voriges")
                return ""
        except Exception as exc:
            log.info("Schneller Befehl %s ging nicht (%s), frage Claude.", name, exc)
            return None
        return None

    def _ask_claude(self, text: str, speak: bool) -> str:
        if self.brain is None:
            return "Mein Gehirn ist gerade nicht verbunden, Sir. Ist Claude Code installiert?"
        turn = f"a{next(self._ids)}"
        splitter = SentenceSplitter()
        shown: list[str] = []
        spoken_any = threading.Event()
        started = time.monotonic()

        def on_text(chunk: str) -> None:
            for sentence in splitter.feed(chunk):
                emit(sentence)

        def emit(sentence: str) -> None:
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
        full = speakable(answer.text) or " ".join(shown)
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
        "refusal": "Claude hat abgelehnt (alle Modelle).",
        "limit": "Claude-Kontingent aufgebraucht.",
        "login": "Claude Code ist nicht angemeldet.",
        "network": "Keine Verbindung zu Claude.",
        "overloaded": "Claude ist überlastet.",
        "timeout": "Claude hat zu lange gebraucht.",
        "missing": "Claude Code nicht gefunden.",
    }.get(exc.kind, "Fehler bei Claude, Details in logs/jarvis.log.")
