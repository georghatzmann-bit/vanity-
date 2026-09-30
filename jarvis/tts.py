"""Text zu Sprache: menschliche Microsoft-Stimme über edge-tts, Windows-Stimme als Reserve.

`Speaker` spricht Sätze nacheinander im Hintergrund und erzeugt den nächsten
Satz schon, während der aktuelle noch läuft.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import queue
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from .text import speakable

log = logging.getLogger(__name__)


class TextToSpeech:
    # Kurze Sätze ("Einen Moment, Sir.") merkt sich Jarvis auf der Festplatte: Beim
    # nächsten Mal kommen sie sofort, ohne Internet-Umweg.
    CACHE_MAX_CHARS = 80
    CACHE_MAX_FILES = 400

    def __init__(self, cfg: dict, cache_dir: Path | None = None) -> None:
        self._engine = cfg.get("engine", "edge")
        self._voice = cfg.get("voice", "de-DE-ConradNeural")
        self._rate = cfg.get("rate", "+0%")
        self._pitch = cfg.get("pitch", "+0Hz")
        self._edge_failed_at = 0.0
        self._cache_dir = Path(cache_dir) if cache_dir else None
        self.used_edge = False  # kam der letzte Satz von der Microsoft-Stimme (oder der Ersatzstimme)?

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        """Gibt die gesprochene Fassung von `text` als int16-Samples und Abtastrate zurück."""
        cached = self._cache_file(text)
        if cached is not None and cached.exists():
            try:
                with np.load(cached) as data:
                    self.used_edge = True
                    return data["samples"].copy(), int(data["rate"])
            except Exception as exc:
                log.debug("Stimmen-Zwischenspeicher: %s", exc)
        # Nach einem Fehler (z. B. kein Internet) eine Minute lang direkt die Ersatzstimme nehmen.
        if self._engine == "edge" and time.monotonic() - self._edge_failed_at > 60:
            try:
                samples, rate = synthesize_edge(text, self._voice, self._rate, self._pitch)
                samples = trim_silence(samples, rate)
                if cached is not None:
                    self._store(cached, samples, rate)
                self.used_edge = True
                return samples, rate
            except Exception as exc:
                self._edge_failed_at = time.monotonic()
                log.warning("Microsoft-Stimme nicht erreichbar (%s), nutze die Ersatzstimme.", exc)
        self.used_edge = False
        samples, rate = synthesize_windows(text)
        return trim_silence(samples, rate), rate

    def prepare(self, texts) -> None:
        """Legt feste Sätze im Voraus in den Zwischenspeicher (im Hintergrund aufrufen)."""
        for text in texts:
            text = speakable(text)
            cached = self._cache_file(text)
            if cached is None or cached.exists():
                continue
            try:
                samples, rate = synthesize_edge(text, self._voice, self._rate, self._pitch)
                self._store(cached, trim_silence(samples, rate), rate)
            except Exception as exc:
                log.debug("Vorbereiten von %r: %s", text, exc)
                return

    def _cache_file(self, text: str) -> Path | None:
        if self._cache_dir is None or self._engine != "edge" or not text or len(text) > self.CACHE_MAX_CHARS:
            return None
        key = "|".join((self._voice, self._rate, self._pitch, text))
        return self._cache_dir / (hashlib.sha1(key.encode("utf-8")).hexdigest()[:24] + ".npz")

    def _store(self, path: Path, samples: np.ndarray, rate: int) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp.npz")
            np.savez(tmp, samples=np.asarray(samples, dtype=np.int16), rate=np.int32(rate))
            os.replace(tmp, path)
            files = sorted(path.parent.glob("*.npz"), key=lambda f: f.stat().st_mtime)
            for old in files[: max(0, len(files) - self.CACHE_MAX_FILES)]:
                old.unlink(missing_ok=True)
        except OSError as exc:
            log.debug("Stimmen-Zwischenspeicher: %s", exc)

    def say(self, text: str) -> None:
        text = speakable(text)
        if text:
            samples, rate = self.synthesize(text)
            play(samples, rate)


def trim_silence(samples: np.ndarray, rate: int, lead: float = 0.05, trail: float = 0.18) -> np.ndarray:
    """Schneidet die Stille vor und nach einem Satz auf ein natürliches Maß.
    Die Microsoft-Stimmen liefern vorn etwa 0,2 s und hinten bis zu 0,9 s Stille mit.
    Satz für Satz gesprochen, wirkt Jarvis dadurch zäh."""
    samples = np.asarray(samples)
    if samples.size == 0 or rate <= 0:
        return samples
    level = np.abs(samples.astype(np.int32))
    threshold = max(120, int(level.max() * 0.02))
    loud = np.flatnonzero(level > threshold)
    if loud.size == 0:
        return samples
    start = max(0, int(loud[0] - lead * rate))
    end = min(samples.size, int(loud[-1] + trail * rate) + 1)
    return samples[start:end]


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

    _com_ready()
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


def _com_ready() -> None:
    """Die Windows-Stimme (SAPI) braucht COM im aufrufenden Thread. pyttsx3 richtet das
    nicht selbst ein, und Jarvis spricht aus einem eigenen Thread: ohne diesen Aufruf
    käme dort "CoInitialize wurde nicht aufgerufen"."""
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED, schon aktiv = egal
    except Exception as exc:
        log.debug("COM: %s", exc)


def play(samples: np.ndarray, rate: int) -> None:
    Player().play(samples, rate, lambda level: None)


def chime(freqs: tuple[int, ...] = (880, 1320)) -> None:
    """Kurze Tonfolge, z. B. aufsteigend wenn Jarvis zuhört."""
    try:
        play(chime_samples(freqs), 24000)
    except Exception as exc:
        log.debug("Ton konnte nicht abgespielt werden: %s", exc)


def chime_samples(freqs: tuple[int, ...], rate: int = 24000) -> np.ndarray:
    """Weicher Klang aus kurzen, leicht überlappenden Tönen, die sanft ausklingen.
    Als int16, so wie Player.play() es erwartet. (Als Gleitkommazahlen zwischen -1 und 1
    würde die Umwandlung in int16 alles zu 0 machen: Stille.)"""
    step, length = 0.085, 0.22
    out = np.zeros(int(rate * (step * (len(freqs) - 1) + length)), dtype=np.float64)
    t = np.arange(int(rate * length)) / rate
    envelope = np.minimum(1.0, t / 0.005) * np.exp(-t * 16)
    for i, freq in enumerate(freqs):
        tone = np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(2 * np.pi * 2 * freq * t)
        start = int(rate * step * i)
        out[start : start + t.size] += 0.24 * tone * envelope
    peak = float(np.abs(out).max()) or 1.0
    out *= min(1.0, 0.3 / peak)
    return (out * 32767).astype(np.int16)


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
    """Spielt Audio ab, meldet dabei die Lautstärke (für die Animation) und lässt sich stoppen.

    Jeder Player hat einen eigenen Ausgabe-Stream. sd.play() teilt sich einen globalen
    Stream, dann würde ein Signalton mitten in Jarvis' Satz diesen abschneiden.
    """

    def __init__(self) -> None:
        self._stopped = threading.Event()

    def play(self, samples: np.ndarray, rate: int, on_level: Callable[[float], None]) -> None:
        import sounddevice as sd

        from .audio import PORTAUDIO_LOCK, playing

        self._stopped.clear()
        samples = np.ascontiguousarray(samples, dtype=np.int16).reshape(-1)
        position = [0]
        finished = threading.Event()

        def fill(outdata, frames, time_info, status) -> None:
            start = position[0]
            chunk = samples[start : start + frames]
            outdata[: len(chunk), 0] = chunk
            position[0] = start + len(chunk)
            if len(chunk) < frames:
                outdata[len(chunk) :, 0] = 0
                raise sd.CallbackStop

        window = max(1, rate // 20)
        with playing():
            with PORTAUDIO_LOCK:
                stream = sd.OutputStream(
                    samplerate=rate, channels=1, dtype="int16", callback=fill, finished_callback=finished.set
                )
                stream.start()
            try:
                limit = time.monotonic() + len(samples) / rate + 2.0
                while not finished.wait(0.05):
                    if self._stopped.is_set() or time.monotonic() > limit:
                        break
                    index = position[0]
                    chunk = samples[index : index + window].astype(np.float32)
                    level = float(np.sqrt(np.mean(chunk**2))) / 8000 if chunk.size else 0.0
                    on_level(min(1.0, level))
            finally:
                with PORTAUDIO_LOCK:
                    try:
                        if self._stopped.is_set():
                            stream.abort()
                        else:
                            stream.stop()
                    finally:
                        stream.close()

    def stop(self) -> None:
        self._stopped.set()
