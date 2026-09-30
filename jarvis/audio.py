"""Mikrofon-Eingang: wartet auf "Hey Jarvis" und nimmt dann den Befehl auf."""

from __future__ import annotations

import collections
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000
# openWakeWord erwartet Blöcke von 80 ms (1280 Samples bei 16 kHz).
FRAME_SAMPLES = 1280
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE


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

    def __post_init__(self) -> None:
        self.frames: list[np.ndarray] = []
        self.speech_started = False
        self.silent_frames = 0

    @property
    def threshold(self) -> float:
        if self.energy_threshold > 0:
            return self.energy_threshold
        return max(300.0, self.noise_floor * 2.5)

    def add(self, frame: np.ndarray) -> bool:
        """Fügt einen Frame hinzu. Gibt True zurück, wenn die Aufnahme fertig ist."""
        self.frames.append(frame)
        elapsed = len(self.frames) * FRAME_SECONDS
        if rms(frame) >= self.threshold:
            self.speech_started = True
            self.silent_frames = 0
        elif self.speech_started:
            self.silent_frames += 1

        if elapsed >= self.max_seconds:
            return True
        if not self.speech_started:
            return elapsed >= self.start_timeout_seconds
        return self.silent_frames * FRAME_SECONDS >= self.silence_seconds

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
    """Alle Mikrofone mit Index, Name und Treiber."""
    import sounddevice as sd

    hostapis = sd.query_hostapis()
    try:
        default_index = sd.default.device[0]
    except Exception:
        default_index = -1
    devices = []
    for index, info in enumerate(sd.query_devices()):
        if info["max_input_channels"] < 1:
            continue
        devices.append(
            {
                "index": index,
                "name": info["name"],
                "hostapi": hostapis[info["hostapi"]]["name"],
                "default": index == default_index,
            }
        )
    return devices


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
    """Liest das Mikrofon in 80-ms-Blöcken und liefert immer int16, mono, 16 kHz."""

    def __init__(self, device: str | int | None = None) -> None:
        import sounddevice as sd

        self._sd = sd
        self.device = resolve_device(device, input_devices())
        info = sd.query_devices(self.device, "input")
        self.name = info["name"]
        try:
            sd.check_input_settings(
                device=self.device, samplerate=SAMPLE_RATE, channels=1, dtype="int16"
            )
            self.rate = SAMPLE_RATE
        except Exception:
            # Manche Treiber können kein 16 kHz, dann rechnen wir selbst um.
            self.rate = int(info["default_samplerate"])
        self._block = int(round(self.rate * FRAME_SECONDS))
        self._stream = None
        # Die letzten ~5 Sekunden, um das Grundrauschen zu schätzen.
        self._recent_levels: collections.deque[float] = collections.deque(maxlen=62)
        self.frames_read = 0
        self.peak = 0

    def start(self) -> None:
        if self._stream is not None:
            return
        self._stream = self._sd.InputStream(
            device=self.device,
            samplerate=self.rate,
            channels=1,
            dtype="int16",
            blocksize=self._block,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is None:
            return
        self._stream.stop()
        self._stream.close()
        self._stream = None

    def __enter__(self) -> "Microphone":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    def read(self) -> np.ndarray:
        data, _overflowed = self._stream.read(self._block)
        frame = resample(data[:, 0].copy(), FRAME_SAMPLES)
        self._recent_levels.append(rms(frame))
        self.frames_read += 1
        self.peak = max(self.peak, int(np.abs(frame.astype(np.int32)).max(initial=0)))
        return frame

    def drain(self) -> None:
        """Verwirft Audio, das sich angesammelt hat (z. B. während Jarvis sprach)."""
        while self._stream is not None and self._stream.read_available >= self._block:
            self._stream.read(self._block)

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


class WakeWord:
    def __init__(self, model_name: str, threshold: float) -> None:
        import openwakeword
        from openwakeword.model import Model

        openwakeword.utils.download_models(model_names=[model_name])
        self._model = Model(wakeword_models=[model_name], inference_framework="onnx")
        self.threshold = threshold

    def score(self, frame: np.ndarray) -> float:
        scores = self._model.predict(frame)
        return float(max(scores.values(), default=0.0))

    def reset(self) -> None:
        self._model.reset()


def record_command(mic: Microphone, listen_cfg: dict) -> np.ndarray | None:
    recorder = CommandRecorder(
        silence_seconds=listen_cfg["silence_seconds"],
        max_seconds=listen_cfg["max_seconds"],
        start_timeout_seconds=listen_cfg["start_timeout_seconds"],
        energy_threshold=listen_cfg["energy_threshold"],
        noise_floor=mic.noise_floor,
    )
    while not recorder.add(mic.read()):
        pass
    return recorder.audio()
