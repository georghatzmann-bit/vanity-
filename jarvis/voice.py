"""Die Sprachschleife: wartet auf "Hey Jarvis", nimmt den Befehl auf und gibt ihn weiter."""

from __future__ import annotations

import logging
import threading
import time

from .mute import MuteSwitch

log = logging.getLogger("jarvis")

# Ab diesem Wert zeigt Jarvis "fast erkannt" an, damit man die Schwelle einstellen kann.
NEAR_MISS = 0.2

PRIVACY_HINT = (
    "Vom Mikrofon kommt absolute Stille. Meist blockiert Windows den Zugriff: "
    "Einstellungen > Datenschutz und Sicherheit > Mikrofon > "
    '"Desktop-Apps den Zugriff auf das Mikrofon erlauben" einschalten. '
    "Oder es ist das falsche Mikrofon: in der Einrichtung (Zahnrad) das richtige wählen."
)


class Sounds:
    def listening(self) -> None:
        from .tts import chime

        chime((880, 1320))

    def muted(self) -> None:
        from .tts import chime

        chime((660, 440))

    def unmuted(self) -> None:
        from .tts import chime

        chime((440, 660, 880))


class VoiceLoop:
    def __init__(self, cfg: dict, mic, wake, stt, assistant, mute: MuteSwitch, sounds, hotkey: str, hints=print) -> None:
        self._cfg = cfg
        self._mic = mic
        self._wake = wake
        self._stt = stt
        self._assistant = assistant
        self._mute = mute
        self._sounds = sounds
        self._hotkey = hotkey
        self._hints = hints or (lambda _text: None)
        self._barge_in = cfg["listen"].get("barge_in", True)
        self._warned_silence = False
        self._last_hint = 0.0
        self._level_tick = 0
        self.stopped = threading.Event()

    def prompt(self) -> None:
        self._hints(f'\nSag "Hey Jarvis" ...  ({self._hotkey} = stumm/laut, Strg+C = beenden)')

    def run(self) -> None:
        """Läuft, bis `stopped` gesetzt wird oder Strg+C kommt. Fällt das Mikrofon aus
        (Headset abgesteckt, Ruhezustand), versucht Jarvis es immer wieder zu öffnen,
        erst schnell, dann alle 10 Sekunden. Tippen geht in der Zeit weiter."""
        self.prompt()
        self._mic.start()
        failures = 0
        while not self.stopped.is_set():
            try:
                self._step()
                if failures >= 2:
                    self._assistant.ui.toast("Das Mikrofon ist wieder da.", "info")
                failures = 0
            except Exception as exc:
                # Nur Audio-Fehler abfangen, alles andere ist ein echter Fehler.
                if not isinstance(exc, OSError) and "PortAudio" not in type(exc).__name__:
                    raise
                failures += 1
                log.warning("Mikrofon-Fehler Nr. %d (%s), versuche es neu zu öffnen ...", failures, exc)
                if failures == 1:
                    self._assistant.ui.toast("Mikrofon-Problem, ich versuche es neu zu öffnen ...", "error")
                elif failures == 3:
                    self._assistant.ui.toast(
                        "Das Mikrofon ist weg. Ich versuche es alle 10 Sekunden wieder. Tippen geht weiter.",
                        "error",
                    )
                self._reopen(2 if failures < 3 else 10)
        self._mic.stop()

    def _reopen(self, delay: float) -> None:
        try:
            self._mic.stop()
        except Exception:
            pass
        self._pause(delay)
        if self.stopped.is_set():
            return
        try:
            # Geräteliste neu einlesen, damit ein wieder eingestecktes Headset gefunden wird.
            reopen = getattr(self._mic, "reopen", None)
            if reopen:
                reopen()
            else:
                self._mic.start()
            self._assistant.ui.config(mic=getattr(self._mic, "name", None))
        except Exception as exc:
            log.warning("Mikrofon lässt sich noch nicht öffnen: %s", exc)

    def _pause(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while not self.stopped.is_set() and time.monotonic() < end:
            time.sleep(0.25)

    def _step(self) -> None:
        from .audio import record_command, rms

        mic, wake, assistant, ui = self._mic, self._wake, self._assistant, self._assistant.ui
        if self._mute.muted:
            self._sleep_while_muted()
            return

        frame = mic.read()
        if not self._warned_silence and mic.dead_silent:
            ui.toast(PRIVACY_HINT, "error")
            self._warned_silence = True

        active = assistant.busy or assistant.speaking
        if not active:
            self._level_tick += 1
            if self._level_tick % 3 == 0:
                ui.level(min(1.0, rms(frame) / 3000))

        score = wake.score(frame)
        threshold = wake.threshold
        if active:
            if not self._barge_in:
                return
            # Während Jarvis spricht, hört das Mikrofon seine eigene Stimme mit.
            # Deshalb muss "Hey Jarvis" dann deutlicher sein.
            threshold = max(threshold + 0.2, 0.75)
        if score < threshold:
            now = time.monotonic()
            if not active and score >= NEAR_MISS and now - self._last_hint > 2:
                self._hints(f"  (fast erkannt: {score:.2f}, nötig sind {wake.threshold:.2f})")
                self._last_hint = now
            return

        if active:
            log.info("Unterbrochen durch Hey Jarvis (%.2f)", score)
            assistant.stop()
        self._sounds.listening()
        mic.drain()
        assistant.set_recording(True)
        try:
            audio = record_command(mic, self._cfg["listen"], on_level=ui.level)
        finally:
            assistant.set_recording(False)
        if audio is None:
            ui.message("info", "Nichts gehört. Sprich direkt nach dem Ton.")
        else:
            text = self._stt.transcribe(audio)
            if not text:
                ui.message("info", "Nichts verstanden.")
            else:
                assistant.submit(text)
                if not self._barge_in:
                    self._wait_until_idle()
        wake.reset()
        mic.drain()

    def _wait_until_idle(self) -> None:
        # Kurz warten, bis der Befehl angenommen ist, dann bis alles gesagt ist.
        time.sleep(0.2)
        while self._assistant.busy or self._assistant.speaking:
            if self.stopped.is_set():
                return
            time.sleep(0.1)

    def _sleep_while_muted(self) -> None:
        self._mic.stop()
        self._assistant.update_state()
        self._sounds.muted()
        self._hints(f"\n[STUMM] Mikrofon ist aus. {self._hotkey} drücken, um es wieder einzuschalten.")
        while not self._mute.wait_until_unmuted(timeout=0.5):
            if self.stopped.is_set():
                return
        self._sounds.unmuted()
        self._hints("[LAUT] Ich höre wieder zu.")
        self._mic.start()
        self._wake.reset()
        self._assistant.update_state()
        self.prompt()
