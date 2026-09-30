"""Die Sprachschleife: wartet auf "Hey Jarvis", nimmt den Befehl auf und gibt ihn weiter."""

from __future__ import annotations

import logging
import threading
import time

from .mute import MuteSwitch

log = logging.getLogger("jarvis")

# Ab diesem Wert zeigt Jarvis "fast erkannt" an, damit man die Schwelle einstellen kann.
NEAR_MISS = 0.2

# Der Signalton nach "Hey Jarvis" dauert knapp 0.2 s. Mit der Verzögerung der
# Lautsprecher kommt sein Echo bis etwa 0.45 s danach im Mikrofon an.
CHIME_ECHO_SECONDS = 0.45

PRIVACY_HINT = (
    "Vom Mikrofon kommt absolute Stille. Meist blockiert Windows den Zugriff: "
    "Einstellungen > Datenschutz und Sicherheit > Mikrofon > "
    '"Desktop-Apps den Zugriff auf das Mikrofon erlauben" einschalten. '
    "Oder es ist das falsche Mikrofon: in den Einstellungen (oben rechts im Jarvis-Fenster) das richtige wählen."
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
        self._follow_up = cfg["listen"].get("follow_up", True)
        self._warned_silence = False
        self._last_hint = 0.0
        self._level_tick = 0
        self._was_active = False
        self._fallback_checked = time.monotonic()
        self._trigger = threading.Event()
        self.stopped = threading.Event()

    # So viele Fehler hintereinander (ohne Mikrofon-Fehler) übersteht die Schleife.
    MAX_ERRORS = 5
    # So oft (Sekunden) schaut Jarvis nach dem eigenen Mikrofon, solange das Ersatzmikrofon läuft.
    FALLBACK_CHECK_SECONDS = 30

    def listen_now(self) -> bool:
        """Zuhören wie nach "Hey Jarvis", aber per Klick (Kreis im Jarvis-Fenster).
        Geht nicht, solange das Mikrofon stumm ist."""
        if self._mute.muted:
            return False
        self._trigger.set()
        return True

    def prompt(self) -> None:
        self._hints(f'\nSag "Hey Jarvis" ...  ({self._hotkey} = stumm/laut, Strg+C = beenden)')

    def run(self) -> None:
        """Läuft, bis `stopped` gesetzt wird oder Strg+C kommt. Fällt das Mikrofon aus
        (Headset abgesteckt, Ruhezustand), versucht Jarvis es immer wieder zu öffnen,
        erst schnell, dann alle 10 Sekunden. Tippen geht in der Zeit weiter.
        Andere Fehler (z. B. in der Spracherkennung) überlebt die Schleife auch, erst nach
        vielen hintereinander gibt sie auf."""
        self.prompt()
        self._mic.start()
        failures = 0
        errors = 0
        try:
            while not self.stopped.is_set():
                try:
                    self._step()
                    if failures >= 2:
                        self._assistant.ui.toast("Das Mikrofon ist wieder da.", "info")
                    failures = 0
                    errors = 0
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    if isinstance(exc, OSError) or "PortAudio" in type(exc).__name__:
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
                        continue
                    errors += 1
                    log.exception("Fehler in der Sprachsteuerung (Nr. %d)", errors)
                    if errors >= self.MAX_ERRORS:
                        self._assistant.ui.toast(
                            f"Die Sprachsteuerung ist aus ({exc}). Tippen geht weiter. Details in logs\\jarvis.log.",
                            "error",
                        )
                        self._assistant.ui.message("info", "Sprachsteuerung aus. Du kannst Jarvis unten etwas schreiben.")
                        return
                    self._assistant.set_transcribing(False)
                    self._assistant.set_recording(False)
                    self._pause(1.0)
        finally:
            try:
                self._mic.stop()
            except Exception:
                pass

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
        from .audio import rms

        mic, wake, assistant, ui = self._mic, self._wake, self._assistant, self._assistant.ui
        if self._mute.muted:
            self._sleep_while_muted()
            return

        frame = mic.read()
        if getattr(mic, "missing", "") and not (assistant.busy or assistant.speaking):
            # Läuft gerade das Ersatzmikrofon: ab und zu schauen, ob das eigene wieder da ist.
            now = time.monotonic()
            if now - self._fallback_checked > self.FALLBACK_CHECK_SECONDS:
                self._fallback_checked = now
                self._reopen(0)
                if not getattr(mic, "missing", ""):
                    ui.toast(f"Dein Mikrofon ist wieder da: {mic.name}", "info")
                return
        if not self._warned_silence and mic.dead_silent:
            ui.toast(PRIVACY_HINT, "error")
            self._warned_silence = True

        active = assistant.busy or assistant.speaking
        if self._was_active and not active and assistant.take_follow_up() and self._follow_up:
            # Jarvis hat eine Frage gestellt ("Soll ich ... löschen?"): Die Antwort
            # geht ohne "Hey Jarvis".
            self._was_active = False
            self._listen(follow_up=True)
            return
        self._was_active = active
        if not active:
            self._level_tick += 1
            if self._level_tick % 3 == 0:
                ui.level(min(1.0, rms(frame) / 3000))

        score = wake.score(frame)
        threshold = wake.threshold
        clicked = self._trigger.is_set()
        if clicked:
            self._trigger.clear()
            log.info("Zuhören per Klick")
        elif active:
            if not self._barge_in:
                return
            # Während Jarvis spricht, hört das Mikrofon seine eigene Stimme mit.
            # Deshalb muss "Hey Jarvis" dann deutlicher sein.
            threshold = max(threshold + 0.2, 0.75)
        if not clicked and score < threshold:
            now = time.monotonic()
            if not active and score >= NEAR_MISS and now - self._last_hint > 2:
                self._hints(f"  (fast erkannt: {score:.2f}, nötig sind {wake.threshold:.2f})")
                self._last_hint = now
            return

        if active:
            log.info("Unterbrochen durch %s (%.2f)", "Klick" if clicked else "Hey Jarvis", score)
            assistant.stop()
        self._listen()

    def _listen(self, follow_up: bool = False) -> None:
        """Ton, Befehl aufnehmen, in Text umwandeln und an Jarvis geben."""
        from .audio import record_command

        mic, wake, assistant, ui = self._mic, self._wake, self._assistant, self._assistant.ui
        # Was sich bis hierhin angestaut hat, ist noch "Hey Jarvis" selbst.
        mic.drain()
        # Den Ton nebenher abspielen und sofort aufnehmen: Wer gleich weiterredet
        # ("Hey Jarvis, wie spät ist es?"), verliert so kein Wort. Das Echo des Tons
        # startet die Aufnahme nicht (ignore_seconds).
        threading.Thread(target=self._sounds.listening, name="jarvis-ton", daemon=True).start()
        listen_cfg = self._cfg["listen"]
        if follow_up:
            listen_cfg = dict(listen_cfg, start_timeout_seconds=min(5.0, float(listen_cfg["start_timeout_seconds"])))
        assistant.set_recording(True)
        try:
            audio = record_command(mic, listen_cfg, on_level=ui.level, ignore_seconds=CHIME_ECHO_SECONDS)
        finally:
            assistant.set_recording(False)
        if audio is None:
            if not follow_up:
                ui.message("info", "Nichts gehört. Sprich direkt nach dem Ton.")
        else:
            assistant.set_transcribing(True)
            try:
                text = self._stt.transcribe(audio)
            except Exception:
                log.exception("Spracherkennung")
                ui.message("info", "Nicht verstanden (Fehler in der Spracherkennung, Details in logs\\jarvis.log).")
                text = None
            finally:
                assistant.set_transcribing(False)
            if text == "":
                ui.message("info", "Nichts verstanden.")
            elif text:
                assistant.submit(text)
                # Auch bei einer ganz schnellen Antwort zählt: Jarvis war dran (für die Rückfrage).
                self._was_active = True
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
        self._trigger.clear()  # ein Klick von vor dem Stummschalten zählt nicht mehr
        self._mic.start()
        self._wake.reset()
        self._assistant.update_state()
        self.prompt()
