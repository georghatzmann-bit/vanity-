"""Text zu Sprache: menschliche Microsoft-Stimme über edge-tts, Windows-Stimme als Reserve."""

from __future__ import annotations

import asyncio
import logging

import numpy as np

log = logging.getLogger(__name__)


class TextToSpeech:
    def __init__(self, cfg: dict) -> None:
        self._engine = cfg["engine"]
        self._voice = cfg["voice"]
        self._rate = cfg["rate"]
        self._pitch = cfg["pitch"]

    def say(self, text: str) -> None:
        if not text.strip():
            return
        if self._engine == "edge":
            try:
                self._say_edge(text)
                return
            except Exception as exc:  # z. B. kein Internet
                log.warning("Microsoft-Stimme nicht erreichbar (%s), nutze Windows-Stimme.", exc)
        self._say_windows(text)

    def _say_edge(self, text: str) -> None:
        import miniaudio
        import sounddevice as sd

        mp3 = asyncio.run(self._synthesize_edge(text))
        decoded = miniaudio.decode(
            mp3, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1
        )
        samples = np.frombuffer(decoded.samples, dtype=np.int16)
        sd.play(samples, decoded.sample_rate)
        sd.wait()

    async def _synthesize_edge(self, text: str) -> bytes:
        import edge_tts

        communicate = edge_tts.Communicate(
            text, voice=self._voice, rate=self._rate, pitch=self._pitch
        )
        audio = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
        if not audio:
            raise RuntimeError("keine Audiodaten erhalten")
        return bytes(audio)

    def _say_windows(self, text: str) -> None:
        import pyttsx3

        engine = pyttsx3.init()
        for voice in engine.getProperty("voices"):
            if "de" in (voice.id or "").lower() or "german" in (voice.name or "").lower():
                engine.setProperty("voice", voice.id)
                break
        engine.say(text)
        engine.runAndWait()


def chime(freqs: tuple[int, ...] = (880, 1320)) -> None:
    """Kurze Tonfolge, z. B. aufsteigend wenn Jarvis zuhört."""
    import sounddevice as sd

    rate = 24000
    tones = []
    for freq in freqs:
        t = np.linspace(0, 0.09, int(rate * 0.09), endpoint=False)
        envelope = np.minimum(1, np.minimum(t, t[::-1]) * 60)
        tones.append(0.25 * np.sin(2 * np.pi * freq * t) * envelope)
    sd.play(np.concatenate(tones).astype(np.float32), rate)
    sd.wait()
