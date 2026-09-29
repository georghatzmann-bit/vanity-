"""Sprache zu Text mit faster-whisper, komplett lokal."""

from __future__ import annotations

import numpy as np


class SpeechToText:
    def __init__(self, model: str, language: str, device: str = "cpu") -> None:
        from faster_whisper import WhisperModel

        compute_type = "int8" if device == "cpu" else "float16"
        self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self._language = language

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self._model.transcribe(
            audio, language=self._language, beam_size=5, vad_filter=True
        )
        return " ".join(s.text.strip() for s in segments).strip()
