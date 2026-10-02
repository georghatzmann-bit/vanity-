"""Mikrofon-Eingang: wartet auf "Hey Jarvis" und nimmt dann den Befehl auf."""

from __future__ import annotations

import collections
import contextlib
import logging
import queue
import threading
import time
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000
# openWakeWord erwartet Blöcke von 80 ms (1280 Samples bei 16 kHz).
FRAME_SAMPLES = 1280
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE

log = logging.getLogger(__name__)

# Schützt das Öffnen, Schließen und Neu-Einlesen der Audiogeräte. PortAudio darf nicht
# neu gestartet werden, während irgendwo noch ein Ton läuft.
PORTAUDIO_LOCK = threading.RLock()


_outputs = 0


@contextlib.contextmanager
def playing():
    """Markiert, dass gerade ein Ton läuft (dann wird PortAudio nicht neu gestartet)."""
    global _outputs
    with PORTAUDIO_LOCK:
        _outputs += 1
    try:
        yield
    finally:
        with PORTAUDIO_LOCK:
            _outputs -= 1


def refresh_devices(timeout: float = 30.0) -> None:
    """PortAudio neu starten, damit neu eingesteckte Geräte in der Liste auftauchen.
    Wartet, bis Jarvis nichts mehr abspielt."""
    import sounddevice as sd

    deadline = time.monotonic() + timeout
    while True:
        with PORTAUDIO_LOCK:
            if _outputs == 0 or time.monotonic() > deadline:
                try:
                    sd._terminate()
                    sd._initialize()
                except Exception as exc:
                    log.warning("Audiogeräte konnten nicht neu eingelesen werden: %s", exc)
                return
        time.sleep(0.1)


def rms(frame: np.ndarray) -> float:
    if frame.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))


@dataclass
class CommandRecorder:
    """Sammelt Frames nach dem Wake Word, bis nach dem Sprechen Stille ist.

    Reine Logik ohne Mikrofon, damit sie sich testen lässt.
    """

    silence_seconds: float = 1.2
    max_seconds: float = 20.0
    start_timeout_seconds: float = 6.0
    energy_threshold: float = 0.0
    noise_floor: float = 200.0
    # So lange zählt Lautes noch nicht als "Sprechen hat begonnen" (das Echo des
    # Signaltons). Aufgenommen wird es trotzdem, falls man gleich losredet.
    ignore_seconds: float = 0.0
    # Sprach-KI (Silero VAD): bekommt einen Frame, liefert die Wahrscheinlichkeit für Sprache.
    # Ohne sie entscheidet nur die Lautstärke.
    vad: object = None
    # Vorab-Erkennung (voice.EarlyText): on_pause(frames) bei einer Pause, on_resume() wenn Georg
    # weiterredet, early_end() = "der Vorab-Text ist ein fertiger Sofort-Befehl, nicht länger warten".
    on_pause: object = None
    on_resume: object = None
    early_end: object = None

    # Ab so viel Stille erkennt Jarvis den Satz schon mal vorab (im Hintergrund).
    PAUSE_PEEK = 0.3
    # So viel Stille reicht, wenn der Vorab-Text ein fertiger Sofort-Befehl ist ("Öffne Spotify").
    EARLY_END = 0.45
    # Nur bei kurzen Befehlen: Wer länger redet, hängt eher noch etwas an ("... und Discord").
    EARLY_MAX_SPOKEN = 2.6

    # Ab hier beginnt Sprechen, und solange es darüber bleibt, spricht man noch.
    VAD_START = 0.5
    VAD_KEEP = 0.3
    # Wer länger redet, macht auch längere Denkpausen ("Schreib Max ... äh ... bin gleich da").
    # Ab PAUSE_FROM Sekunden Sprechen wartet Jarvis nach und nach länger auf das Satzende,
    # höchstens PAUSE_EXTRA Sekunden mehr. Kurze Befehle ("Öffne Spotify") bleiben schnell.
    PAUSE_FROM = 0.8
    PAUSE_RATE = 0.25
    PAUSE_EXTRA = 0.8

    def __post_init__(self) -> None:
        self.frames: list[np.ndarray] = []
        self.speech_started = False
        self.silent_frames = 0
        self.speech_frames = 0
        self.peeked = False  # in dieser Pause schon vorab erkannt
        self.ended_early = False

    @property
    def threshold(self) -> float:
        if self.energy_threshold > 0:
            return self.energy_threshold
        return max(300.0, self.noise_floor * 2.5)

    def add(self, frame: np.ndarray) -> bool:
        """Fügt einen Frame hinzu. Gibt True zurück, wenn die Aufnahme fertig ist."""
        self.frames.append(frame)
        elapsed = len(self.frames) * FRAME_SECONDS
        loud = self._is_speech(frame)
        if loud and elapsed > self.ignore_seconds:
            if self.peeked and self.on_resume is not None:
                self.on_resume()  # Georg redet weiter: der Vorab-Text gilt nicht mehr
            self.peeked = False
            self.speech_started = True
            self.silent_frames = 0
            self.speech_frames += 1
        elif self.speech_started and not loud:
            self.silent_frames += 1

        if elapsed >= self.max_seconds:
            return True
        if not self.speech_started:
            return elapsed >= self.start_timeout_seconds
        silence = self.silent_frames * FRAME_SECONDS
        if not self.peeked and self.on_pause is not None and silence >= self.PAUSE_PEEK:
            self.peeked = True
            self.on_pause(list(self.frames))
        if silence >= self.needed_silence:
            return True
        if (self.peeked and self.early_end is not None and silence >= self.EARLY_END
                and self.speech_frames * FRAME_SECONDS <= self.EARLY_MAX_SPOKEN and self.early_end()):
            self.ended_early = True
            return True
        return False

    @property
    def needed_silence(self) -> float:
        """So lange Stille beendet die Aufnahme: kurz bei kurzen Befehlen, länger beim Erzählen."""
        spoken = self.speech_frames * FRAME_SECONDS
        extra = min(self.PAUSE_EXTRA, max(0.0, (spoken - self.PAUSE_FROM) * self.PAUSE_RATE))
        return self.silence_seconds + extra

    def _is_speech(self, frame: np.ndarray) -> bool:
        if self.vad is None:
            return rms(frame) >= self.threshold
        try:
            probability = float(self.vad(frame))
        except Exception as exc:
            log.debug("Sprach-KI: %s", exc)
            self.vad = None
            return rms(frame) >= self.threshold
        # Ganz leise ist nie Sprache (z. B. Rauschen, das die KI für ein Flüstern hält).
        if rms(frame) < max(120.0, self.noise_floor * 1.3):
            return False
        return probability >= (self.VAD_KEEP if self.speech_started else self.VAD_START)

    def audio(self) -> np.ndarray | None:
        """Die Aufnahme als float32 für Whisper, oder None wenn nichts gesagt wurde."""
        if not self.speech_started:
            return None
        pcm = np.concatenate(self.frames)
        return pcm.astype(np.float32) / 32768.0


def resample(frame: np.ndarray, target: int) -> np.ndarray:
    """Rechnet einen Block auf `target` Samples um (z. B. 48 kHz auf 16 kHz)."""
    if len(frame) == target:
        return frame
    ratio = len(frame) / target
    x = frame.astype(np.float32)
    width = int(round(ratio))
    if width > 1:
        # Einfacher Tiefpass gegen Aliasing vor dem Heruntertakten.
        x = np.convolve(x, np.ones(width, dtype=np.float32) / width, mode="same")
    positions = np.linspace(0, len(x) - 1, target)
    return np.interp(positions, np.arange(len(x)), x).astype(np.int16)


def input_devices() -> list[dict]:
    """Alle Mikrofone mit Index, Name und Treiber. `default` markiert das Mikrofon,
    das in Windows als Standard eingestellt ist."""
    import sounddevice as sd

    hostapis = sd.query_hostapis()
    try:
        default_index = sd.default.device[0]
    except Exception:
        default_index = -1
    all_devices = sd.query_devices()
    real_default = _real_default_input(hostapis, all_devices)
    devices = []
    for index, info in enumerate(all_devices):
        if info["max_input_channels"] < 1:
            continue
        devices.append(
            {
                "index": index,
                "name": info["name"],
                "hostapi": hostapis[info["hostapi"]]["name"],
                "default": index == default_index or same_device(info["name"], real_default),
            }
        )
    return devices


def _real_default_input(hostapis, devices) -> str:
    """Name des echten Standardmikrofons. Unter MME heißt der Standard nur
    "Microsoft Soundmapper", WASAPI nennt das Gerät dahinter beim Namen."""
    for wanted in ("Windows WASAPI", "Windows DirectSound"):
        for api in hostapis:
            if api.get("name") != wanted:
                continue
            index = api.get("default_input_device", -1)
            if index is None or index < 0 or index >= len(devices):
                continue
            name = str(devices[index]["name"]).strip()
            if name and not is_alias(name):
                return name
    return ""


# Einträge, hinter denen sich nur "das Windows-Standardmikrofon" verbirgt.
_ALIASES = ("sound mapper", "soundmapper", "primärer soundaufnahmetreiber", "primary sound capture")


def is_alias(name: str) -> bool:
    low = name.lower()
    return any(alias in low for alias in _ALIASES)


def same_device(name: str, other: str) -> bool:
    """MME kürzt Gerätenamen auf 31 Zeichen, WASAPI nicht. Gleich ist, was bis zur
    Kürzung übereinstimmt ("Mikrofon" und "Mikrofonarray (...)" sind verschieden)."""
    a, b = str(name or "").strip(), str(other or "").strip()
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 30 and long_.startswith(short)


def friendly_device_error(exc: Exception) -> str:
    """Macht aus PortAudio-Fehlern einen verständlichen Satz."""
    text = str(exc)
    if "device -1" in text or "no default" in text.lower():
        return "Windows meldet kein Standardmikrofon."
    if "Invalid device" in text or "Invalid number of channels" in text:
        return "Dieses Mikrofon lässt sich nicht öffnen (vielleicht von einem anderen Programm belegt)."
    return text


def resolve_device(spec: str | int | None, devices: list[dict]) -> int | None:
    """Findet das Mikrofon aus der Config: leer = Windows-Standard,
    Zahl = Index, Text = Teil des Namens."""
    if spec is None or spec == "":
        return None
    if isinstance(spec, int) or str(spec).strip().isdigit():
        index = int(spec)
        if any(d["index"] == index for d in devices):
            return index
        raise ValueError(f"Kein Mikrofon mit der Nummer {index}.")
    wanted = str(spec).strip().lower()
    matches = [d for d in devices if wanted in d["name"].lower()]
    if not matches:
        raise ValueError(f'Kein Mikrofon gefunden, dessen Name "{spec}" enthält.')
    # Exakter Name zuerst, und unter Windows ist MME am unkompliziertesten.
    matches.sort(key=lambda d: (d["name"].strip().lower() != wanted, d["hostapi"] != "MME"))
    return matches[0]["index"]


class Microphone:
    """Liest das Mikrofon in 80-ms-Blöcken und liefert immer int16, mono, 16 kHz.

    Das Audio kommt über einen Callback in eine Warteschlange. So merkt `read()` nach
    ein paar Sekunden ohne Daten, dass das Mikrofon weg ist (Headset abgesteckt,
    Ruhezustand), statt ewig zu warten.
    """

    READ_TIMEOUT = 3.0
    BUFFER_SECONDS = 10.0

    def __init__(self, device: str | int | None = None, fallback: bool = False) -> None:
        """`fallback`: Gibt es das eingestellte Mikrofon gerade nicht (Headset abgesteckt),
        erst einmal das Windows-Standardmikrofon nehmen. `missing` nennt dann das fehlende."""
        import sounddevice as sd

        self._sd = sd
        self._spec = device
        self._stream = None
        self._queue: queue.Queue = queue.Queue()
        # Die letzten ~5 Sekunden, um das Grundrauschen zu schätzen.
        self._recent_levels: collections.deque[float] = collections.deque(maxlen=62)
        self.frames_read = 0
        self.peak = 0
        self.missing = ""
        try:
            index = resolve_device(device, input_devices())
        except ValueError as exc:
            if not fallback:
                raise
            log.warning("%s Nehme vorerst das Windows-Standardmikrofon.", exc)
            self.missing = str(device)
            index = None
        self._select(index)

    def _select(self, device: int | None) -> None:
        sd = self._sd
        self.device = device
        info = sd.query_devices(device, "input")
        self.name = info["name"]
        if device is None and is_alias(self.name):
            # "Microsoft Soundmapper" sagt niemandem etwas: das echte Gerät dahinter zeigen.
            try:
                real = _real_default_input(sd.query_hostapis(), sd.query_devices())
                if real:
                    self.name = f"{real} (Windows-Standard)"
            except Exception as exc:
                log.debug("Standardmikrofon unbekannt: %s", exc)
        try:
            sd.check_input_settings(device=device, samplerate=SAMPLE_RATE, channels=1, dtype="int16")
            self.rate = SAMPLE_RATE
        except Exception:
            # Manche Treiber können kein 16 kHz, dann rechnen wir selbst um.
            self.rate = int(info["default_samplerate"])
        self._block = int(round(self.rate * FRAME_SECONDS))

    def start(self) -> None:
        if self._stream is not None:
            return
        self._queue = buffer = queue.Queue(maxsize=int(self.BUFFER_SECONDS / FRAME_SECONDS))

        def on_audio(indata, frames, time_info, status) -> None:
            chunk = indata[:, 0].copy()
            try:
                buffer.put_nowait(chunk)
            except queue.Full:
                # Niemand liest gerade (Jarvis denkt nach): das älteste Stück verwerfen.
                try:
                    buffer.get_nowait()
                    buffer.put_nowait(chunk)
                except (queue.Empty, queue.Full):
                    pass

        with PORTAUDIO_LOCK:
            stream = self._sd.InputStream(
                device=self.device,
                samplerate=self.rate,
                channels=1,
                dtype="int16",
                blocksize=self._block,
                callback=on_audio,
            )
            stream.start()
        self._stream = stream

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        with PORTAUDIO_LOCK:
            try:
                stream.abort()
            finally:
                stream.close()

    def reopen(self) -> None:
        """Nach einem Ausfall: Geräteliste neu einlesen und das Mikrofon wieder öffnen.
        Ist das eingestellte Mikrofon weg, nimmt Jarvis vorerst das Windows-Standardmikrofon."""
        try:
            self.stop()
        except Exception:
            pass
        refresh_devices()
        try:
            device = resolve_device(self._spec, input_devices())
            self.missing = ""
        except ValueError as exc:
            log.warning("%s Nehme vorerst das Standardmikrofon.", exc)
            device = None
            self.missing = str(self._spec)
        self._select(device)
        self.frames_read = 0
        self.peak = 0
        self.start()

    def __enter__(self) -> "Microphone":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    def read(self) -> np.ndarray:
        if self._stream is None:
            raise OSError("Das Mikrofon ist nicht geöffnet.")
        try:
            data = self._queue.get(timeout=self.READ_TIMEOUT)
        except queue.Empty:
            raise OSError("Das Mikrofon liefert keine Daten mehr (abgesteckt oder nach dem Ruhezustand?).") from None
        frame = resample(data, FRAME_SAMPLES)
        self._recent_levels.append(rms(frame))
        self.frames_read += 1
        self.peak = max(self.peak, int(np.abs(frame.astype(np.int32)).max(initial=0)))
        return frame

    def drain(self) -> None:
        """Verwirft Audio, das sich angesammelt hat (z. B. während Jarvis sprach)."""
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    @property
    def noise_floor(self) -> float:
        if not self._recent_levels:
            return 200.0
        # Leise Momente zählen, damit gesprochene Wörter den Wert nicht hochtreiben.
        return float(np.percentile(self._recent_levels, 20))

    @property
    def dead_silent(self) -> bool:
        """True, wenn nach 3 Sekunden nur exakte Nullen kamen. Das passiert,
        wenn Windows den Mikrofonzugriff für Desktop-Apps blockiert."""
        return self.frames_read >= 38 and self.peak == 0


class VoiceActivity:
    """Silero VAD (kommt mit openWakeWord): erkennt Sprache viel zuverlässiger als die
    Lautstärke, auch bei Lüfter, Musik oder Tastaturgeklapper. So endet die Aufnahme
    schneller und schneidet trotzdem keine Sätze ab."""

    def __init__(self) -> None:
        from openwakeword.vad import VAD

        self._vad = VAD()

    def reset(self) -> None:
        self._vad.reset_states()

    def __call__(self, frame: np.ndarray) -> float:
        # 1280 Samples = 2 Stücke à 40 ms, wie openWakeWord es selbst macht.
        return float(self._vad.predict(frame, frame_size=640))


class JarvisKeyword:
    """Porcupine (Picovoice) mit dem eingebauten Weckwort "Jarvis": So reicht auch "Jarvis"
    allein, ohne "Hey". Braucht einen kostenlosen Schlüssel von console.picovoice.ai."""

    def __init__(self, key: str, sensitivity: float = 0.6) -> None:
        import pvporcupine

        self._engine = pvporcupine.create(access_key=key, keywords=["jarvis"], sensitivities=[sensitivity])
        self.frame_length = int(self._engine.frame_length)
        self._buffer = np.zeros(0, dtype=np.int16)

    def detect(self, frame: np.ndarray) -> bool:
        self._buffer = np.concatenate([self._buffer, np.asarray(frame, dtype=np.int16).reshape(-1)])
        hit = False
        while len(self._buffer) >= self.frame_length:
            chunk, self._buffer = self._buffer[: self.frame_length], self._buffer[self.frame_length :]
            if self._engine.process(chunk.tolist()) >= 0:
                hit = True
        return hit

    def reset(self) -> None:
        self._buffer = np.zeros(0, dtype=np.int16)

    def close(self) -> None:
        try:
            self._engine.delete()
        except Exception:
            pass


def picovoice_problem(key: str) -> str:
    """Prüft einen Picovoice-Schlüssel. Leer, wenn er geht, sonst eine Erklärung."""
    try:
        keyword = JarvisKeyword(key)
    except ImportError:
        return "Das Paket für „Jarvis“ ohne Hey fehlt. Bitte werkzeuge\\Neu-installieren.bat starten."
    except Exception as exc:
        text = str(exc).lower()
        if "access" in text and "key" in text or "invalid" in text or "activation" in text:
            return "Dieser Schlüssel stimmt nicht. Bitte noch einmal von console.picovoice.ai kopieren."
        if "network" in text or "connection" in text or "internet" in text:
            return "Picovoice ist gerade nicht erreichbar. Ist das Internet an?"
        return f"Picovoice meldet: {exc}"
    keyword.close()
    return ""


class WakeWord:
    """ "Hey Jarvis" über openWakeWord, mit Picovoice-Schlüssel zusätzlich "Jarvis" allein."""

    def __init__(self, model_name: str, threshold: float, picovoice_key: str = "") -> None:
        import openwakeword
        from openwakeword.model import Model

        openwakeword.utils.download_models(model_names=[model_name])
        self._model = Model(wakeword_models=[model_name], inference_framework="onnx")
        self.threshold = threshold
        self.keyword: JarvisKeyword | None = None
        key = str(picovoice_key or "").strip()
        if key:
            try:
                self.keyword = JarvisKeyword(key)
                log.info("Weckwort: auch „Jarvis“ allein (Picovoice).")
            except Exception as exc:
                log.warning("„Jarvis“ allein geht gerade nicht (%s), nur „Hey Jarvis“.", exc)

    def score(self, frame: np.ndarray) -> float:
        scores = self._model.predict(frame)
        best = float(max(scores.values(), default=0.0))
        if self.keyword is not None and self.keyword.detect(frame):
            best = max(best, 1.0)
        return best

    def reset(self) -> None:
        self._model.reset()
        if self.keyword is not None:
            self.keyword.reset()


def record_command(
    mic: Microphone, listen_cfg: dict, on_level=None, ignore_seconds: float = 0.0, vad: VoiceActivity | None = None,
    early=None,
) -> np.ndarray | None:
    """Nimmt einen Befehl bis zum Satzende auf. `early` (voice.EarlyText): erkennt in Pausen schon vorab
    und beendet die Aufnahme früher, wenn ein fertiger Sofort-Befehl dasteht."""
    if vad is not None:
        vad.reset()
    recorder = CommandRecorder(
        silence_seconds=listen_cfg["silence_seconds"],
        max_seconds=listen_cfg["max_seconds"],
        start_timeout_seconds=listen_cfg["start_timeout_seconds"],
        energy_threshold=listen_cfg["energy_threshold"],
        noise_floor=mic.noise_floor,
        ignore_seconds=ignore_seconds,
        vad=vad,
        on_pause=early.pause if early is not None else None,
        on_resume=early.resume if early is not None else None,
        early_end=early.complete if early is not None else None,
    )
    while True:
        frame = mic.read()
        if on_level is not None:
            on_level(min(1.0, rms(frame) / 3000))
        if recorder.add(frame):
            return recorder.audio()


def record_more(mic: Microphone, listen_cfg: dict, vad: VoiceActivity | None = None, start_timeout: float = 1.0,
                max_seconds: float = 12.0) -> list[np.ndarray]:
    """Nach einem unsicheren Weckwort ("Jarvis" allein) kurz weiterhören: Redet Georg gleich
    weiter, bis zum Satzende, sonst nach `start_timeout` Sekunden Schluss. Gibt alle Frames
    zurück, auch die stillen (der Name davor soll mit in die Prüfung)."""
    if vad is not None:
        vad.reset()
    recorder = CommandRecorder(
        silence_seconds=listen_cfg["silence_seconds"],
        max_seconds=min(max_seconds, float(listen_cfg["max_seconds"])),
        start_timeout_seconds=start_timeout,
        energy_threshold=listen_cfg["energy_threshold"],
        noise_floor=mic.noise_floor,
        vad=vad,
    )
    while not recorder.add(mic.read()):
        pass
    return recorder.frames
