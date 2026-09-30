"""Simuliert die ganze Kette ohne Mikrofon: erzeugt "Hey Jarvis" und einen
Befehl mit der Computerstimme und schickt beides durch Wake Word,
Aufnahme, Spracherkennung, Befehl und Sprachausgabe."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audio import FRAME_SAMPLES, SAMPLE_RATE, CommandRecorder, rms

WAKE_VOICE = "en-US-GuyNeural"


@dataclass
class Step:
    name: str
    ok: bool
    detail: str


def to_16k(samples: np.ndarray, rate: int) -> np.ndarray:
    """Rechnet ganze Aufnahmen auf 16 kHz um."""
    if rate == SAMPLE_RATE:
        return samples.astype(np.int16)
    x = samples.astype(np.float32)
    ratio = rate / SAMPLE_RATE
    width = max(1, int(round(ratio)))
    if width > 1:
        x = np.convolve(x, np.ones(width, dtype=np.float32) / width, mode="same")
    count = int(len(x) / ratio)
    positions = np.linspace(0, len(x) - 1, count)
    return np.interp(positions, np.arange(len(x)), x).astype(np.int16)


def noise(seconds: float, level: float = 60.0, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(int(seconds * SAMPLE_RATE)) * level).astype(np.int16)


class FakeMic:
    """Liefert eine fertige Aufnahme in 80-ms-Blöcken, wie das echte Mikrofon."""

    def __init__(self, audio: np.ndarray) -> None:
        self._audio = audio
        self._pos = 0
        self.levels: list[float] = []
        self.name = "Simulation"

    def read(self) -> np.ndarray:
        frame = self._audio[self._pos : self._pos + FRAME_SAMPLES]
        self._pos += FRAME_SAMPLES
        if len(frame) < FRAME_SAMPLES:
            frame = np.concatenate([frame, noise((FRAME_SAMPLES - len(frame)) / SAMPLE_RATE)])
        self.levels.append(rms(frame))
        return frame

    @property
    def exhausted(self) -> bool:
        return self._pos >= len(self._audio)

    @property
    def noise_floor(self) -> float:
        return float(np.percentile(self.levels, 20)) if self.levels else 60.0

    def drain(self) -> None:
        pass


def build_recording(synthesize, wake_phrase: str = "Hey Jarvis", command: str = "Wie spät ist es?", german_voice: str = "de-DE-ConradNeural") -> np.ndarray:
    from .tts import synthesize_edge

    wake, wake_rate = synthesize_edge(wake_phrase, WAKE_VOICE, "-5%")
    cmd, cmd_rate = synthesize(command) if synthesize else synthesize_edge(command, german_voice)
    parts = [
        noise(1.0),
        to_16k(wake, wake_rate),
        noise(0.6, seed=2),
        to_16k(cmd, cmd_rate),
        noise(2.5, seed=3),
    ]
    return np.concatenate(parts)


def run_chain(
    cfg: dict, wake, stt, handle, synthesize=None, recording: np.ndarray | None = None,
    expect: tuple[str, ...] = ("spät", "uhr"),
) -> list[Step]:
    """Gibt für jede Station zurück, ob sie geklappt hat."""
    steps: list[Step] = []
    try:
        audio = recording if recording is not None else build_recording(synthesize)
        steps.append(Step("Testsprache erzeugen", True, f"{len(audio) / SAMPLE_RATE:.1f} s"))
    except Exception as exc:
        steps.append(Step("Testsprache erzeugen", False, f"Microsoft-Stimme nicht erreichbar: {exc}"))
        return steps

    mic = FakeMic(audio)
    wake.reset()
    best = 0.0
    while not mic.exhausted:
        best = max(best, wake.score(mic.read()))
        if best >= wake.threshold:
            break
    if best < wake.threshold:
        steps.append(Step('"Hey Jarvis" erkennen', False, f"bester Wert {best:.2f}, nötig {wake.threshold:.2f}"))
        return steps
    steps.append(Step('"Hey Jarvis" erkennen', True, f"Wert {best:.2f}"))

    listen = cfg["listen"]
    recorder = CommandRecorder(
        silence_seconds=listen["silence_seconds"],
        max_seconds=listen["max_seconds"],
        start_timeout_seconds=listen["start_timeout_seconds"],
        energy_threshold=listen["energy_threshold"],
        noise_floor=mic.noise_floor,
    )
    while not recorder.add(mic.read()):
        pass
    command_audio = recorder.audio()
    if command_audio is None:
        steps.append(Step("Befehl aufnehmen", False, "keine Sprache nach dem Wake Word gefunden"))
        return steps
    steps.append(Step("Befehl aufnehmen", True, f"{len(command_audio) / SAMPLE_RATE:.1f} s"))

    text = stt.transcribe(command_audio)
    understood = any(word in text.lower() for word in expect)
    steps.append(Step("Sprache verstehen", understood, f'"{text}"'))
    if not text:
        return steps

    answer = handle(text)
    steps.append(Step("Befehl ausführen", bool(answer), f'"{answer}"'))

    if synthesize and answer:
        try:
            samples, rate = synthesize(answer)
            steps.append(Step("Antwort sprechen", len(samples) > rate // 4, f"{len(samples) / rate:.1f} s Audio"))
        except Exception as exc:
            steps.append(Step("Antwort sprechen", False, str(exc)))
    return steps
