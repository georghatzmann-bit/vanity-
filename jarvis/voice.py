"""Die Sprachschleife: wartet auf "Hey Jarvis", nimmt den Befehl auf und gibt ihn weiter.
Im Gespräch hört Jarvis nach jeder Antwort kurz weiter zu, dann reicht einfaches Weiterreden."""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque

from .mute import MuteSwitch

log = logging.getLogger("jarvis")

# Ab diesem Wert zeigt Jarvis "fast erkannt" an, damit man die Schwelle einstellen kann.
NEAR_MISS = 0.2

# Der Signalton nach "Hey Jarvis" dauert knapp 0.2 s. Mit der Verzögerung der
# Lautsprecher kommt sein Echo bis etwa 0.45 s danach im Mikrofon an.
CHIME_ECHO_SECONDS = 0.45

# Gespräch: So viele Sekunden hört Jarvis nach einer Antwort weiter zu, ohne "Hey Jarvis".
CONVERSATION_SECONDS = 8.0
# Ist der Blueprint offen, redet Georg mit Jarvis am Modell (Georg: "dauerhaft reden, er macht es schnell, sagt
# Erledigt, ich sag was, dann macht er direkt weiter"): nach jeder Antwort so lange ohne "Hey Jarvis" zuhören.
BLUEPRINT_SECONDS = 90.0

# "Alles klar", "Okay", "Nein danke": kein Befehl, das Gespräch ist einfach zu Ende.
_DONE = re.compile(
    r"^(?:ok|okay|alles klar|passt|passt schon|gut|super|cool|top|prima|nein|ne|nee|nö|nicht|nichts|nix|"
    r"nein danke|danke nein|das (?:war|wär|wäre) ?s|mehr nicht|nichts mehr|erst mal nicht|erstmal nicht|"
    r"nicht nötig|ich melde mich)$"
)
# Darauf antwortet Jarvis noch, hört danach aber nicht weiter zu.
_LAST_WORDS = ("thanks", "good_night", "bye", "stop", "mute")
# Danach läuft Musik, ein Anruf oder ein Spiel, oder der PC geht aus: auch dann nicht weiter zuhören,
# sonst hält Jarvis Liedtexte oder das Gespräch mit Max für Befehle und antwortet darauf, immer wieder.
_SOUND_AFTER = ("media_play", "media_next", "media_prev", "play", "volume_up", "volume_down", "volume_set",
                "gaming_on", "lock", "power_off", "power_restart", "power_sleep", "power_logoff")
_DISCORD_SOUND = ("voice", "call")


def conversation_turn(text: str) -> str:
    """Was ein Satz im Gespräch bedeutet: "ende" (nur "Alles klar": kein Befehl, Schluss),
    "zuletzt" ("Danke", "Gute Nacht", "Stopp": noch erledigen, dann Schluss) oder "weiter"."""
    from . import intents

    if _DONE.match(intents.normalize(text)):
        return "ende"
    found = intents.match(text)
    if found is not None and (found.name in _LAST_WORDS or found.name in _SOUND_AFTER
                              or (found.name == "discord" and found.arg in _DISCORD_SOUND)):
        return "zuletzt"
    return "weiter"


# "Jarvis" allein, "Hallo Jarvis", "Okay Jarvis": Das Weckwort-Modell kennt nur "Hey Jarvis"
# sicher. Bei einem halben Treffer hört Jarvis kurz weiter und prüft per Spracherkennung,
# ob sein Name am Anfang steht. Ab diesem Wert lohnt die Prüfung.
NAME_CANDIDATE = 0.12
# So lange wartet Jarvis nach einem halben Treffer, ob doch noch ein sicheres "Hey Jarvis" kommt.
NAME_WAIT_FRAMES = 5  # 0.4 s (ein Frame sind 80 ms)
# So viel Ton von vor dem Treffer kommt mit in die Prüfung (der Name selbst).
NAME_PREROLL_FRAMES = 25  # 2 s
# Was Whisper aus "Jarvis" macht, je nach Aussprache.
_NAME = r"(?!gewi[sß])(?:j|dsch|tsch|ch|sch|g)[aeä]h?r?[vw]i[sß]s?"  # "Garvis" ja, "gewiss" nein
_GREETING = r"(?:hey|hei|hi|hallo|halo|okay|ok|servus|moin|yo|na|he|ey|äh|ähm|also|jo)"
# Vor dem Namen darf ein Wort stehen ("Danke, Jarvis") oder eine dieser Floskeln aus zwei Wörtern
_POLITE = r"(?:gute[nr]?\W+(?:nacht|morgen|abend|tag)|vielen\W+dank|danke\W+(?:schön|sehr))"
_NAME_AT_START = re.compile(rf"^\W*(?:{_GREETING}\W+)*(?:{_POLITE}\W+|\w+\W+)?{_NAME}\b\W*", re.I)


def after_name(text: str) -> str | None:
    """Der Befehl nach "Jarvis" ("Jarvis, wie spät ist es?" -> "wie spät ist es?").
    "" = nur der Name, None = der Name steht nicht am Anfang (dann war nichts)."""
    found = _NAME_AT_START.match(str(text or ""))
    if not found:
        return None
    return text[found.end():].strip()


# Endet der Vorab-Text so, kommt sicher noch etwas ("Öffne Spotify und ..."): nicht früher aufhören.
_UNFINISHED = re.compile(r"\b(?:und|oder|aber|dann|mit|für|von|auf|in|an|zu|bis|ob|dass|weil|wenn|noch|auch)\W*$", re.I)


class EarlyText:
    """Vorab-Erkennung: In der ersten kurzen Pause (0,3 s) erkennt Jarvis den Satz schon im Hintergrund.
    Redet Georg weiter, verfällt das. Sonst ist der Text fertig, sobald die Aufnahme endet: Die ganze
    Erkennungszeit fällt weg. Ist der Text ein fertiger Sofort-Befehl ("Öffne Spotify", "Lauter"),
    endet die Aufnahme schon nach knapp einer halben Sekunde Stille statt nach fast einer."""

    WAIT = 2.5  # so lange wartet result() höchstens auf eine Vorab-Erkennung, die noch läuft

    def __init__(self, transcribe, is_command) -> None:
        self._transcribe = transcribe
        self._is_command = is_command
        self._lock = threading.Lock()
        self._generation = 0
        self._pending: threading.Event | None = None  # die gültige Vorab-Erkennung (läuft oder fertig)
        self._text: str | None = None
        self.used = False

    def pause(self, frames: list) -> None:
        import numpy as np

        with self._lock:
            self._generation += 1
            generation, done = self._generation, threading.Event()
            self._pending, self._text = done, None

        def run() -> None:
            try:
                text = self._transcribe(np.concatenate(frames).astype(np.float32) / 32768.0) or ""
            except Exception as exc:
                log.debug("Vorab-Erkennung: %s", exc)
                text = None
            with self._lock:
                if generation == self._generation:
                    self._text = text
            done.set()

        threading.Thread(target=run, name="jarvis-vorab", daemon=True).start()

    def resume(self) -> None:
        with self._lock:
            self._generation += 1
            self._pending, self._text = None, None

    def complete(self) -> bool:
        """Steht vorab schon ein fertiger Sofort-Befehl da?"""
        with self._lock:
            text = self._text
        if not text or _UNFINISHED.search(text):
            return False
        try:
            return bool(self._is_command(text))
        except Exception:
            return False

    def result(self) -> str | None:
        """Der vorab erkannte Text, wenn er noch gilt (seit der Pause kam keine Sprache mehr), sonst None."""
        with self._lock:
            done, generation = self._pending, self._generation
        if done is None or not done.wait(self.WAIT):
            return None
        with self._lock:
            if generation != self._generation or self._text is None:
                return None
            self.used = True
            return self._text


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

    def again(self) -> None:
        """Im Gespräch: ein einzelner, leiser Ton statt des vollen Signals."""
        from .tts import chime

        chime((1320,))

    def muted(self) -> None:
        from .tts import chime

        chime((660, 440))

    def unmuted(self) -> None:
        from .tts import chime

        chime((440, 660, 880))


class VoiceLoop:
    def __init__(self, cfg: dict, mic, wake, stt, assistant, mute: MuteSwitch, sounds, hotkey: str, hints=print,
                 vad=None) -> None:
        self._cfg = cfg
        self._vad = vad
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
        # Gespräch: Nach einer Antwort auf einen gesprochenen Befehl hört Jarvis kurz weiter zu.
        self._conversation = bool(cfg["listen"].get("gespraech", True))
        self._conversation_seconds = float(cfg["listen"].get("gespraech_sekunden", CONVERSATION_SECONDS))
        self._talking = False
        self._shown_talking = False
        # "Jarvis" allein und andere Anreden (zweite Stufe, siehe after_name)
        self._by_name = bool(cfg.get("wakeword", {}).get("name_allein", True))
        self._recent: deque = deque(maxlen=NAME_PREROLL_FRAMES)
        self._name_wait: int | None = None
        self._name_pause_until = 0.0
        self._name_misses = 0
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
        if self._was_active and not active:
            # Jarvis hat eine Frage gestellt ("Soll ich ... löschen?") oder wir sind im Gespräch:
            # Die Antwort geht ohne "Hey Jarvis".
            question = bool(assistant.take_follow_up()) and self._follow_up
            if self._talking and not self._may_talk():
                self._end_conversation()
            # Am Blueprint geht es nach jedem "Erledigt" ohne Weckwort weiter, auch wenn Georg auf das Modell
            # gewartet und dazwischen nichts gesagt hat.
            working = self._conversation and self._blueprint_open() and self._may_talk()
            if question or (self._talking and self._conversation) or working:
                self._was_active = False
                self._listen(follow_up=True, question=question)
                return
        self._was_active = active
        if not active:
            self._level_tick += 1
            if self._level_tick % 3 == 0:
                ui.level(min(1.0, rms(frame) / 3000))

        score = wake.score(frame)
        threshold = wake.threshold
        if not active:
            self._recent.append(frame)  # während Jarvis spricht, nicht: das wäre seine eigene Stimme
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
            if active or not self._by_name:
                self._name_wait = None
            elif self._name_wait is not None:
                self._name_wait += 1
                if self._name_wait >= NAME_WAIT_FRAMES:
                    self._name_wait = None
                    self._check_name()
            elif score >= NAME_CANDIDATE and now >= self._name_pause_until:
                self._name_wait = 0
            return
        self._name_wait = None

        if active:
            log.info("Unterbrochen durch %s (%.2f)", "Klick" if clicked else "Hey Jarvis", score)
            assistant.stop()
        self._listen()

    def _listen(self, follow_up: bool = False, question: bool = False) -> None:
        """Ton, Befehl aufnehmen, in Text umwandeln und an Jarvis geben.
        follow_up: ohne "Hey Jarvis" nach einer Antwort (question: Jarvis hat etwas gefragt)."""
        from .audio import record_command

        mic, wake, assistant, ui = self._mic, self._wake, self._assistant, self._assistant.ui
        # Was sich bis hierhin angestaut hat, ist noch "Hey Jarvis" selbst.
        mic.drain()
        self._recent.clear()
        talking = follow_up and not question
        # Den Ton nebenher abspielen und sofort aufnehmen: Wer gleich weiterredet
        # ("Hey Jarvis, wie spät ist es?"), verliert so kein Wort. Das Echo des Tons
        # startet die Aufnahme nicht (ignore_seconds). Im Gespräch ein leiserer Ton.
        sound = getattr(self._sounds, "again", None) if talking else None
        threading.Thread(target=sound or self._sounds.listening, name="jarvis-ton", daemon=True).start()
        listen_cfg = self._cfg["listen"]
        if follow_up:
            if self._conversation and self._blueprint_open():
                seconds = max(self._conversation_seconds, BLUEPRINT_SECONDS)
            elif self._talking and self._conversation:
                seconds = self._conversation_seconds
            else:
                seconds = min(5.0, float(listen_cfg["start_timeout_seconds"]))
            listen_cfg = dict(listen_cfg, start_timeout_seconds=seconds)
        if talking:
            self._shown_talking = True
            ui.config(gespraech=True)
        # Spricht Jarvis währenddessen selbst (eine Erinnerung meldet sich), darf seine eigene
        # Stimme im Gespräch nicht als Befehl zählen.
        spoke = []

        def level(value: float) -> None:
            ui.level(value)
            if assistant.speaking:
                spoke.append(True)

        early = EarlyText(self._stt.transcribe, self._is_command) if listen_cfg.get("vorab", True) else None
        assistant.set_recording(True)
        try:
            audio = record_command(mic, listen_cfg, on_level=level, ignore_seconds=CHIME_ECHO_SECONDS, vad=self._vad,
                                   early=early)
        finally:
            assistant.set_recording(False)
        if audio is not None and follow_up and spoke:
            log.info("Verworfen: Jarvis hat während der Aufnahme selbst gesprochen")
            audio = None
        if audio is None:
            if not follow_up:
                ui.message("info", "Nichts gehört. Sprich direkt nach dem Ton.")
            elif self._talking:
                log.info("Gespräch zu Ende (nichts mehr gesagt)")
            self._end_conversation()
        else:
            assistant.set_transcribing(True)
            started = time.monotonic()
            try:
                text = early.result() if early is not None else None
                if text is None:
                    text = self._stt.transcribe(audio)
                log.info(
                    "Erkannt in %.2f s (%s%s, %.1f s Aufnahme): %s", time.monotonic() - started,
                    getattr(self._stt, "last_engine", "") or "lokal", ", vorab" if early is not None and early.used else "",
                    len(audio) / 16000, text,
                )
                assistant.timing = {"heard_at": started, "recognized": time.monotonic() - started}
            except Exception:
                log.exception("Spracherkennung")
                ui.message("info", "Nicht verstanden (Fehler in der Spracherkennung, Details in logs\\jarvis.log).")
                text = None
            finally:
                assistant.set_transcribing(False)
            if not text:
                if text == "" and not follow_up:
                    ui.message("info", "Nichts verstanden.")
                self._end_conversation()
            else:
                self._take(text, talking)
        wake.reset()
        mic.drain()
        self._recent.clear()

    def _take(self, text: str, talking: bool = False) -> None:
        """Gibt einen gesprochenen Befehl weiter. Danach geht das Gespräch weiter, außer bei
        "Danke", "Tschüss" oder "Stopp". Ein bloßes "Alles klar" im Gespräch ist kein Befehl."""
        turn = conversation_turn(text) if self._conversation else "zuletzt"
        if talking and turn == "ende":
            log.info("Gespräch beendet: %s", text)
            self._end_conversation()
            return
        noticed = getattr(self._assistant, "noticed", None)
        if noticed is not None:
            noticed()  # wer mit Jarvis spricht, sitzt am PC (auch ohne Maus und Tastatur)
        self._assistant.submit(text)
        self._talking = turn == "weiter"
        if not self._talking:
            self._end_conversation()
        # Auch bei einer ganz schnellen Antwort zählt: Jarvis war dran (für die Rückfrage).
        self._was_active = True
        if not self._barge_in:
            self._wait_until_idle()

    def _end_conversation(self) -> None:
        self._talking = False
        if self._shown_talking:
            self._shown_talking = False
            self._assistant.ui.config(gespraech=False)

    def _blueprint_open(self) -> bool:
        blueprint = getattr(self._assistant, "blueprint", None)
        return bool(blueprint is not None and getattr(blueprint, "active", False))

    def _may_talk(self) -> bool:
        """Beim Zocken (Gaming-Modus, Vollbild) kein Gespräch: Dann redet Georg meist mit anderen. Am offenen
        Blueprint zählt Vollbild nicht (das ist dann Jarvis' eigenes Fenster)."""
        assistant = self._assistant
        if getattr(assistant, "gaming", False):
            return False
        if self._blueprint_open():
            return True
        fullscreen = getattr(assistant, "_fullscreen", None)
        try:
            return not (fullscreen is not None and fullscreen())
        except Exception:
            return True

    def _check_name(self) -> None:
        """Zweite Stufe für "Jarvis" allein, "Hallo Jarvis" und Co.: Erst nur die letzten zwei
        Sekunden in Text umwandeln. Steht der Name nicht vorn, passiert nichts (und Jarvis prüft
        eine Weile seltener, damit Fernseher und Gespräche ihn nicht ständig beschäftigen).
        Steht er vorn und Georg redet weiter, hört Jarvis bis zum Satzende zu."""
        from .audio import record_more, rms

        mic = self._mic
        frames = list(self._recent)
        self._recent.clear()
        loud = max(300.0, float(getattr(mic, "noise_floor", 200.0)) * 2.5)
        rest = None
        said = ""
        if any(rms(f) >= loud for f in frames):
            said = self._transcribe(frames)
            rest = after_name(said)
        if rest is None:
            self._name_misses = min(self._name_misses + 1, 5)
            self._name_pause_until = time.monotonic() + 4 * 2 ** (self._name_misses - 1)
            self._wake.reset()
            mic.drain()
            return
        self._name_misses = 0
        if rest or any(rms(f) >= loud for f in frames[-3:]):
            # "Jarvis, wie spät ..." geht noch weiter: bis zum Satzende aufnehmen, alles neu erkennen
            more = record_more(mic, self._cfg["listen"], vad=self._vad)
            full = after_name(self._transcribe(frames + more))
            if full is not None and len(full) >= len(rest):
                rest = full
        self._wake.reset()
        mic.drain()
        log.info("Mit Namen angesprochen: %s", rest or said)
        if rest:
            self._take(rest)
        elif self._is_command(said):
            self._take(said)  # "Danke, Jarvis", "Gute Nacht, Jarvis": gleich antworten, ohne Ton
        else:
            self._listen()

    @staticmethod
    def _is_command(text: str) -> bool:
        from . import intents, spiele

        return intents.match(text) is not None or spiele.is_command(text)

    def _transcribe(self, frames: list) -> str:
        import numpy as np

        if not frames:
            return ""
        try:
            return self._stt.transcribe(np.concatenate(frames).astype(np.float32) / 32768.0) or ""
        except Exception as exc:
            log.debug("Namensprüfung: %s", exc)
            return ""

    def _wait_until_idle(self) -> None:
        # Kurz warten, bis der Befehl angenommen ist, dann bis alles gesagt ist.
        time.sleep(0.2)
        while self._assistant.busy or self._assistant.speaking:
            if self.stopped.is_set():
                return
            time.sleep(0.1)

    def _sleep_while_muted(self) -> None:
        self._end_conversation()
        self._name_wait = None
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
