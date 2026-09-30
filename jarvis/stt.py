"""Sprache zu Text mit faster-whisper, komplett lokal."""

from __future__ import annotations

import re

import numpy as np

# Whisper "hört" bei Rauschen gern Sätze aus Filmuntertiteln. Die werden verworfen.
HALLUCINATIONS = re.compile(
    r"^\W*(untertitel|copyright)|amara\.org|(danke|dank) (fürs|für's|für das|für's) zuschauen",
    re.I,
)


class SpeechToText:
    def __init__(self, model: str, language: str, device: str = "cpu") -> None:
        from faster_whisper import WhisperModel

        compute_type = "int8" if device == "cpu" else "float16"
        try:
            # Erst ohne Internet: Beim Autostart ist das Netz oft noch nicht da, und
            # sonst fragt Hugging Face bei jedem Start nach Updates.
            self._model = WhisperModel(model, device=device, compute_type=compute_type, local_files_only=True)
        except Exception:
            self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self._language = language

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self._model.transcribe(
            audio, language=self._language, beam_size=5, vad_filter=True
        )
        return clean_transcript(" ".join(s.text.strip() for s in segments))


def clean_transcript(text: str) -> str:
    text = text.strip()
    if not text or HALLUCINATIONS.search(text):
        return ""
    # Nur Satzzeichen oder ein einzelnes Füllwort ist kein Befehl.
    if not re.search(r"\w", text) or re.fullmatch(r"\W*(äh|ähm|hm|mhm|ah)\W*", text, re.I):
        return ""
    return text
