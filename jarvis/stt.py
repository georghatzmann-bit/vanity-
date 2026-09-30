"""Sprache zu Text mit faster-whisper, komplett lokal."""

from __future__ import annotations

import logging
import re

import numpy as np

log = logging.getLogger(__name__)

# Whisper "hört" bei Rauschen gern Sätze aus Filmuntertiteln. Die werden verworfen.
HALLUCINATIONS = re.compile(
    r"^\W*(untertitel|copyright)|amara\.org|(danke|dank) (fürs|für's|für das|für's) zuschauen",
    re.I,
)


class SpeechToText:
    def __init__(self, model: str, language: str, device: str = "cpu", beam_size: int = 1) -> None:
        self._name = model
        self._language = language
        # 1 = gierige Suche: bei kurzen Befehlen genauso gut wie 5, aber spürbar schneller.
        self._beam_size = max(1, int(beam_size))
        try:
            self._load(device)
        except Exception as exc:
            if device == "cpu":
                raise
            log.warning("Spracherkennung auf %s lädt nicht (%s), nehme den Prozessor.", device, exc)
            self._load("cpu")

    def _load(self, device: str) -> None:
        from faster_whisper import WhisperModel

        compute_type = "int8" if device == "cpu" else "float16"
        try:
            # Erst ohne Internet: Beim Autostart ist das Netz oft noch nicht da, und
            # sonst fragt Hugging Face bei jedem Start nach Updates.
            self._model = WhisperModel(self._name, device=device, compute_type=compute_type, local_files_only=True)
        except Exception:
            self._model = WhisperModel(self._name, device=device, compute_type=compute_type)
        self._device = device

    def transcribe(self, audio: np.ndarray) -> str:
        try:
            return self._transcribe(audio)
        except RuntimeError as exc:
            # Grafikkarte eingestellt, aber CUDA-Bibliotheken fehlen: dann eben der Prozessor.
            if self._device == "cpu":
                raise
            log.warning("Spracherkennung auf %s geht nicht (%s), nehme den Prozessor.", self._device, exc)
            self._load("cpu")
            return self._transcribe(audio)

    def _transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self._model.transcribe(
            audio, language=self._language, beam_size=self._beam_size, vad_filter=True
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
