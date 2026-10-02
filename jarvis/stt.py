"""Sprache zu Text: Groq (Whisper large-v3-turbo in der Cloud, gratis Schlüssel, sehr schnell
und genau) oder faster-whisper auf dem eigenen PC. Ist Groq gerade nicht erreichbar,
übernimmt der eigene PC, ohne dass Georg etwas merkt."""

from __future__ import annotations

import io
import json
import logging
import re
import threading
import time
import uuid
import wave

import numpy as np

log = logging.getLogger(__name__)


# Whisper "hört" bei Rauschen gern Sätze aus Filmuntertiteln. Die werden verworfen.
HALLUCINATIONS = re.compile(
    r"^\W*(untertitel|copyright)|amara\.org|(danke|dank) (fürs|für's|für das|für's) zuschauen",
    re.I,
)


class SpeechToText:
    """Whisper auf dem eigenen PC (faster-whisper)."""

    def __init__(self, model: str, language: str, device: str = "cpu", beam_size: int = 1, prompt: str = "") -> None:
        self._name = model
        self._language = language
        self._prompt = prompt
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
            audio, language=self._language, beam_size=self._beam_size, vad_filter=True,
            initial_prompt=self._prompt or None,
        )
        return clean_transcript(" ".join(s.text.strip() for s in segments), self._prompt)


GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"


def check_groq_key(key: str, timeout: float = 8.0) -> tuple[bool, str]:
    """Prüft einen Groq-Schlüssel, ohne Audio zu verbrauchen. Gibt (ok, Fehlertext) zurück."""
    import urllib.error
    import urllib.request

    key = (key or "").strip()
    if not key:
        return False, "Bitte zuerst den Schlüssel einfügen."
    request = urllib.request.Request(GROQ_MODELS_URL, headers={"Authorization": f"Bearer {key}", "User-Agent": "Jarvis"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return False, "Dieser Schlüssel stimmt nicht. Bitte noch einmal kopieren (er beginnt mit gsk_)."
        return False, f"Groq meldet einen Fehler ({exc.code}). Bitte gleich noch einmal versuchen."
    except (urllib.error.URLError, TimeoutError, OSError):
        return False, "Groq ist gerade nicht erreichbar. Ist das Internet an?"
    models = {m.get("id") for m in data.get("data", []) if isinstance(m, dict)}
    if models and not any(str(m).startswith("whisper") for m in models):
        return False, "Der Schlüssel geht, aber Whisper ist für dieses Konto nicht freigeschaltet."
    return True, ""


class CloudSpeechToText:
    """Groq: Whisper large-v3-turbo, meist in 0,2 bis 0,5 Sekunden. Kostenloser Schlüssel von
    console.groq.com. Klappt es nicht (kein Netz, Limit, falscher Schlüssel), übernimmt
    `fallback` (Whisper auf dem eigenen PC), der erst bei Bedarf geladen wird."""

    URL = "https://api.groq.com/openai/v1/audio/transcriptions"
    TIMEOUT = 6.0
    # So lange nach einem Fehler direkt den eigenen PC nehmen.
    PAUSE_AFTER_ERROR = 60.0

    def __init__(self, key: str, model: str = "whisper-large-v3-turbo", language: str = "de", prompt: str = "",
                 fallback=None, on_problem=None) -> None:
        self._key = key.strip()
        self._model = model or "whisper-large-v3-turbo"
        self._language = language
        self._prompt = prompt
        self._fallback_factory = fallback
        self._fallback = None
        self._fallback_lock = threading.Lock()
        self._paused_until = 0.0
        self._on_problem = on_problem or (lambda _text: None)
        self._warned: set[str] = set()
        self.last_engine = ""

    def warm_up_fallback(self) -> None:
        """Den eigenen PC schon mal bereit machen (im Hintergrund), damit ein Ausfall nicht bremst."""
        try:
            self._local()
        except Exception as exc:
            log.warning("Spracherkennung auf dem eigenen PC lädt nicht: %s", exc)

    def _local(self):
        with self._fallback_lock:
            if self._fallback is None and self._fallback_factory is not None:
                self._fallback = self._fallback_factory()
            return self._fallback

    def transcribe(self, audio: np.ndarray) -> str:
        if time.monotonic() >= self._paused_until:
            try:
                text = self._cloud(audio)
                self.last_engine = "groq"
                return text
            except CloudError as exc:
                self._paused_until = time.monotonic() + (exc.pause if exc.pause is not None else self.PAUSE_AFTER_ERROR)
                log.warning("Groq-Spracherkennung: %s. Nehme den eigenen PC.", exc)
                if exc.tell and exc.kind not in self._warned:
                    self._warned.add(exc.kind)
                    self._on_problem(exc.tell)
        local = self._local()
        if local is None:
            raise RuntimeError("Keine Spracherkennung verfügbar.")
        self.last_engine = "lokal"
        return local.transcribe(audio)

    def _cloud(self, audio: np.ndarray) -> str:
        import urllib.error
        import urllib.request

        fields = {"model": self._model, "language": self._language, "response_format": "json", "temperature": "0"}
        if self._prompt:
            fields["prompt"] = self._prompt
        body, content_type = multipart(fields, ("file", "befehl.wav", to_wav(audio), "audio/wav"))
        request = urllib.request.Request(
            self.URL, data=body, method="POST",
            headers={"Authorization": f"Bearer {self._key}", "Content-Type": content_type, "User-Agent": "Jarvis"},
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self.TIMEOUT) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code in (401, 403):
                raise CloudError(
                    "key", f"Schlüssel abgelehnt ({exc.code})", pause=600,
                    tell="Der Groq-Schlüssel für die Spracherkennung stimmt nicht. Ich erkenne Sprache jetzt auf deinem PC.",
                ) from None
            if exc.code == 429:
                wait = float(exc.headers.get("retry-after") or 30)
                raise CloudError("limit", f"Limit erreicht, {wait:.0f} s Pause", pause=wait) from None
            raise CloudError("http", f"HTTP {exc.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CloudError("net", f"nicht erreichbar ({exc})", pause=30) from None
        log.debug("Groq-Spracherkennung in %.2f s", time.monotonic() - started)
        return clean_transcript(str(data.get("text", "")), self._prompt)


class CloudError(RuntimeError):
    def __init__(self, kind: str, message: str, pause: float | None = None, tell: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.pause = pause
        self.tell = tell


def to_wav(audio: np.ndarray, rate: int = 16000) -> bytes:
    """float32 (-1..1) oder int16 in eine WAV-Datei (16 kHz, mono, 16 Bit)."""
    if audio.dtype != np.int16:
        audio = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(audio.tobytes())
    return buffer.getvalue()


def multipart(fields: dict, file: tuple[str, str, bytes, str]) -> tuple[bytes, str]:
    """Baut einen multipart/form-data-Körper (wie ein Formular mit Datei-Upload)."""
    boundary = "jarvis" + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    field, filename, data, mime = file
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode("utf-8") + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def make_transcriber(cfg: dict, ort: str = "", on_problem=None):
    """Die passende Spracherkennung laut config.toml ([stt])."""
    engine = str(cfg.get("engine", "auto")).lower()
    key = str(cfg.get("groq_key", "") or "").strip()
    # Eine Wortliste als Hinweis hat im Test mehr verdorben als geholfen, deshalb ohne.
    prompt = str(cfg.get("prompt", "") or "")

    def whisper():
        return SpeechToText(cfg["model"], cfg["language"], cfg.get("device", "cpu"), cfg.get("beam_size", 1), prompt)

    def local():
        # Parakeet (lokale Spracherkennung aus der Einrichtung): auf dem Prozessor viel schneller als Whisper
        from .localvoice import installed

        if installed()["stt"] and cfg.get("lokal_modell", "parakeet") == "parakeet":
            try:
                from .localvoice import ParakeetSpeechToText

                return ParakeetSpeechToText()
            except Exception as exc:
                log.warning("Parakeet lädt nicht (%s), nehme Whisper.", exc)
        return whisper()

    if key and engine in ("auto", "groq", "cloud"):
        return CloudSpeechToText(key, cfg.get("groq_model", "whisper-large-v3-turbo"), cfg["language"], prompt,
                                 fallback=local, on_problem=on_problem)
    return local()


def clean_transcript(text: str, prompt: str = "") -> str:
    text = text.strip()
    if not text or HALLUCINATIONS.search(text):
        return ""
    # Bei Stille wiederholt Whisper manchmal nur die Wortliste: das ist kein Befehl.
    if prompt:
        def plain(value: str) -> str:
            return re.sub(r"\W+", " ", value.lower()).strip()

        if plain(text) and plain(text) in plain(prompt):
            return ""
    # Nur Satzzeichen oder ein einzelnes Füllwort ist kein Befehl.
    if not re.search(r"\w", text) or re.fullmatch(r"\W*(äh|ähm|hm|mhm|ah)\W*", text, re.I):
        return ""
    return text
