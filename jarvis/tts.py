"""Text zu Sprache: menschliche Microsoft-Stimme über edge-tts, Windows-Stimme als Reserve.

`Speaker` spricht Sätze nacheinander im Hintergrund und erzeugt den nächsten
Satz schon, während der aktuelle noch läuft.
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import tempfile
import threading
import time
import wave
from typing import Callable

import numpy as np

from .text import speakable

log = logging.getLogger(__name__)


class TextToSpeech:
    def __init__(self, cfg: dict) -> None:
        self._engine = cfg.get("engine", "edge")
        self._voice = cfg.get("voice", "de-DE-ConradNeural")
        self._rate = cfg.get("rate", "+0%")
        self._pitch = cfg.get("pitch", "+0Hz")
        self._edge_failed_at = 0.0

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        """Gibt die gesprochene Fassung von `text` als int16-Samples und Abtastrate zurück."""
        # Nach einem Fehler (z. B. kein Internet) eine Minute lang direkt die Windows-Stimme nehmen.
        if self._engine == "edge" and time.monotonic() - self._edge_failed_at > 60:
            try:
                return synthesize_edge(text, self._voice, self._rate, self._pitch)
            except Exception as exc:
                self._edge_failed_at = time.monotonic()
                log.warning("Microsoft-Stimme nicht erreichbar (%s), nutze Windows-Stimme.", exc)
        return synthesize_windows(text)

    def say(self, text: str) -> None:
        text = speakable(text)
        if text:
            samples, rate = self.synthesize(text)
            play(samples, rate)


def synthesize_edge(text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz") -> tuple[np.ndarray, int]:
    import miniaudio

    mp3 = asyncio.run(_edge_mp3(text, voice, rate, pitch))
    decoded = miniaudio.decode(mp3, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1)
    return np.frombuffer(decoded.samples, dtype=np.int16).copy(), decoded.sample_rate


async def _edge_mp3(text: str, voice: str, rate: str, pitch: str) -> bytes:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate, pitch=pitch)
    audio = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("keine Audiodaten erhalten")
    return bytes(audio)


def synthesize_windows(text: str) -> tuple[np.ndarray, int]:
    """Eingebaute Windows-Stimme (offline). Schreibt eine WAV-Datei und liest sie ein."""
    import pyttsx3

    engine = pyttsx3.init()
    for voice in engine.getProperty("voices"):
        if "de" in (voice.id or "").lower() or "german" in (voice.name or "").lower():
            engine.setProperty("voice", voice.id)
            break
    handle, path = tempfile.mkstemp(suffix=".wav", prefix="jarvis-")
    os.close(handle)
    try:
        engine.save_to_file(text, path)
        engine.runAndWait()
        with wave.open(path, "rb") as wav:
            rate = wav.getframerate()
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            data = wav.readframes(wav.getnframes())
        if width != 2:
            raise RuntimeError(f"unerwartetes WAV-Format ({width * 8} Bit)")
        samples = np.frombuffer(data, dtype=np.int16)
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1).astype(np.int16)
        return samples.copy(), rate
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def play(samples: np.ndarray, rate: int) -> None:
    import sounddevice as sd

    sd.play(samples, rate)
    sd.wait()


def chime(freqs: tuple[int, ...] = (880, 1320)) -> None:
    """Kurze Tonfolge, z. B. aufsteigend wenn Jarvis zuhört."""
    try:
        import sounddevice as sd

        sd.play(chime_samples(freqs), 24000)
        sd.wait()
    except Exception as exc:
        log.debug("Ton konnte nicht abgespielt werden: %s", exc)


def chime_samples(freqs: tuple[int, ...], rate: int = 24000) -> np.ndarray:
    tones = []
    for freq in freqs:
        t = np.linspace(0, 0.09, int(rate * 0.09), endpoint=False)
        envelope = np.minimum(1, np.minimum(t, t[::-1]) * 60)
        tones.append(0.25 * np.sin(2 * np.pi * freq * t) * envelope)
    return np.concatenate(tones).astype(np.float32)


class Speaker:
    """Spricht Sätze nacheinander im Hintergrund.

    Zwei Threads: einer erzeugt die Sprache (dauert bei edge-tts etwa eine halbe
    Sekunde), der andere spielt ab. So entsteht der zweite Satz, während der
    erste noch läuft. `stop()` bricht alles sofort ab.
    """

    def __init__(
        self,
        synthesize: Callable[[str], tuple[np.ndarray, int]],
        player: "Player | None" = None,
        on_level: Callable[[float], None] | None = None,
        on_speaking: Callable[[bool], None] | None = None,
    ) -> None:
        self._synthesize = synthesize
        self._player = player or Player()
        self._on_level = on_level or (lambda _v: None)
        self._on_speaking = on_speaking or (lambda _v: None)
        self._texts: queue.Queue = queue.Queue()
        self._audio: queue.Queue = queue.Queue(maxsize=2)
        self._generation = 0
        self._pending = 0
        self._lock = threading.Condition()
        self._speaking = False
        self.spoken: list[str] = []
        threading.Thread(target=self._synth_worker, name="jarvis-tts", daemon=True).start()
        threading.Thread(target=self._play_worker, name="jarvis-play", daemon=True).start()

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._pending > 0

    def say(self, text: str) -> None:
        text = speakable(text)
        if not text:
            return
        with self._lock:
            self._pending += 1
            generation = self._generation
        self._texts.put((generation, text))

    def stop(self) -> None:
        with self._lock:
            self._generation += 1
            self._pending = 0
            self._lock.notify_all()
        for q in (self._texts, self._audio):
            while True:
                try:
                    q.get_nowait()
                except queue.Empty:
                    break
        self._player.stop()

    def wait(self, timeout: float | None = None) -> bool:
        """Wartet, bis alles gesagt ist. Gibt False zurück, wenn die Zeit abläuft."""
        end = None if timeout is None else time.monotonic() + timeout
        with self._lock:
            while self._pending > 0:
                remaining = None if end is None else end - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._lock.wait(remaining if remaining is not None else 0.5)
        return True

    def _current(self, generation: int) -> bool:
        with self._lock:
            return generation == self._generation

    def _done_one(self, generation: int) -> None:
        with self._lock:
            if generation == self._generation and self._pending > 0:
                self._pending -= 1
            if self._pending == 0:
                self._lock.notify_all()

    def _synth_worker(self) -> None:
        while True:
            generation, text = self._texts.get()
            if not self._current(generation):
                continue
            try:
                samples, rate = self._synthesize(text)
            except Exception as exc:
                log.error("Sprachausgabe fehlgeschlagen: %s", exc)
                self._done_one(generation)
                continue
            if self._current(generation):
                self._audio.put((generation, text, samples, rate))

    def _play_worker(self) -> None:
        while True:
            generation, text, samples, rate = self._audio.get()
            if not self._current(generation):
                continue
            self._set_speaking(True)
            try:
                self._player.play(samples, rate, self._on_level)
                self.spoken.append(text)
            except Exception as exc:
                log.error("Abspielen fehlgeschlagen: %s", exc)
            finally:
                self._done_one(generation)
                if not self.busy:
                    self._on_level(0.0)
                    self._set_speaking(False)

    def _set_speaking(self, value: bool) -> None:
        if value != self._speaking:
            self._speaking = value
            self._on_speaking(value)


class Player:
    """Spielt Audio ab, meldet dabei die Lautstärke (für die Animation) und lässt sich stoppen."""

    def __init__(self) -> None:
        self._stopped = threading.Event()

    def play(self, samples: np.ndarray, rate: int, on_level: Callable[[float], None]) -> None:
        import sounddevice as sd

        self._stopped.clear()
        duration = len(samples) / rate
        sd.play(samples, rate)
        start = time.monotonic()
        window = max(1, rate // 20)
        while not self._stopped.is_set():
            elapsed = time.monotonic() - start
            if elapsed >= duration + 0.05:
                break
            index = int(elapsed * rate)
            chunk = samples[index : index + window].astype(np.float32)
            level = float(np.sqrt(np.mean(chunk**2))) / 8000 if chunk.size else 0.0
            on_level(min(1.0, level))
            time.sleep(0.05)
        if self._stopped.is_set():
            sd.stop()
        else:
            sd.wait()

    def stop(self) -> None:
        self._stopped.set()
        try:
            import sounddevice as sd

            sd.stop()
        except Exception:
            pass
