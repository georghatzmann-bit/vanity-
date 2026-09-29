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


class Microphone:
    """Liest das Mikrofon in 80-ms-Blöcken (int16, mono, 16 kHz)."""

    def __init__(self) -> None:
        import sounddevice as sd

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
        )
        # Die letzten ~2 Sekunden, um das Grundrauschen zu schätzen.
        self._recent_levels: collections.deque[float] = collections.deque(maxlen=25)

    def __enter__(self) -> "Microphone":
        self._stream.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stream.stop()
        self._stream.close()

    def read(self) -> np.ndarray:
        data, _overflowed = self._stream.read(FRAME_SAMPLES)
        frame = data[:, 0].copy()
        self._recent_levels.append(rms(frame))
        return frame

    def drain(self) -> None:
        """Verwirft Audio, das sich angesammelt hat (z. B. während Jarvis sprach)."""
        while self._stream.read_available >= FRAME_SAMPLES:
            self._stream.read(FRAME_SAMPLES)

    @property
    def noise_floor(self) -> float:
        if not self._recent_levels:
            return 200.0
        return float(np.median(self._recent_levels))


class WakeWord:
    def __init__(self, model_name: str, threshold: float) -> None:
        import openwakeword
        from openwakeword.model import Model

        openwakeword.utils.download_models(model_names=[model_name])
        self._model = Model(wakeword_models=[model_name], inference_framework="onnx")
        self._threshold = threshold

    def detected(self, frame: np.ndarray) -> bool:
        scores = self._model.predict(frame)
        return max(scores.values(), default=0.0) >= self._threshold

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
