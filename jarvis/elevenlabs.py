"""ElevenLabs: die natürlichsten Stimmen, kostenpflichtig (ab etwa 6 Dollar im Monat).

Nur die Teile der Schnittstelle, die Jarvis braucht: Stimmen auflisten, deutsche Stimmen
aus der Bibliothek suchen und übernehmen, das Kontingent abfragen und Sprache streamen
(rohes PCM, 24 kHz, 16 Bit mono). Alles mit der Standardbibliothek, ohne Zusatzpakete.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Iterator

log = logging.getLogger(__name__)

BASE = "https://api.elevenlabs.io"
DEFAULT_MODEL = "eleven_v4_turbo"
# Reserve, falls das eingestellte Modell für dieses Konto nicht geht
FALLBACK_MODEL = "eleven_flash_v2_5"
# Diese Modelle akzeptieren language_code (andere melden sonst einen Fehler)
LANGUAGE_MODELS = {"eleven_flash_v2_5", "eleven_turbo_v2_5"}
RATE = 24000
# Bekannte Stimmen, die es in jedem Konto gibt: britisch, ruhig, passend für Jarvis
PREFERRED_NAMES = ("George", "Daniel", "Brian", "Bill")

VOICE_SETTINGS = {"stability": 0.5, "similarity_boost": 0.8, "style": 0.0, "use_speaker_boost": True, "speed": 1.0}


class ElevenLabsError(RuntimeError):
    """`kind`: key (Schlüssel falsch), quota (Guthaben leer), model, param, voice, busy, net, other."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class ElevenLabs:
    def __init__(self, key: str, base: str = BASE, timeout: float = 8.0) -> None:
        self.key = (key or "").strip()
        self.base = base.rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------ Grundlagen

    def _request(self, method: str, path: str, body: dict | None = None, accept: str = "application/json"):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"xi-api-key": self.key, "Accept": accept, "User-Agent": "Jarvis"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            return urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            raise _error(exc) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ElevenLabsError("net", f"ElevenLabs nicht erreichbar ({exc})") from None

    def _json(self, method: str, path: str, body: dict | None = None):
        with self._request(method, path, body) as response:
            return json.loads(response.read().decode("utf-8") or "{}")

    # ------------------------------------------------------------------ Konto und Stimmen

    def subscription(self) -> dict:
        """Kontingent: wie viele Zeichen verbraucht und erlaubt sind, und der Tarif."""
        data = self._json("GET", "/v1/user/subscription")
        return {
            "tier": str(data.get("tier", "")),
            "used": int(data.get("character_count") or 0),
            "limit": int(data.get("character_limit") or 0),
        }

    def voices(self) -> list[dict]:
        """Die Stimmen im Konto (Standardstimmen und selbst hinzugefügte)."""
        data = self._json("GET", "/v2/voices?page_size=100")
        return [_voice(v) for v in data.get("voices", [])]

    def library(self, language: str = "de", gender: str = "", search: str = "", page_size: int = 24) -> list[dict]:
        """Stimmen aus der öffentlichen Bibliothek, z. B. deutsche Männerstimmen."""
        query = {"page_size": page_size, "language": language, "sort": "usage_character_count_1y"}
        if gender:
            query["gender"] = gender
        if search:
            query["search"] = search
        data = self._json("GET", "/v1/shared-voices?" + urllib.parse.urlencode(query))
        rows = []
        for v in data.get("voices", []):
            row = _voice(v)
            row["public_owner_id"] = v.get("public_owner_id", "")
            row["library"] = True
            rows.append(row)
        return rows

    def add_shared(self, public_owner_id: str, voice_id: str, name: str) -> str:
        """Übernimmt eine Bibliotheks-Stimme ins eigene Konto. Gibt die neue voice_id zurück."""
        path = f"/v1/voices/add/{urllib.parse.quote(public_owner_id)}/{urllib.parse.quote(voice_id)}"
        data = self._json("POST", path, {"new_name": name})
        return str(data.get("voice_id") or voice_id)

    # ------------------------------------------------------------------ Sprechen

    def stream(self, text: str, voice_id: str, model: str = DEFAULT_MODEL, previous_text: str = "",
               language: str = "de", plain: bool = False) -> Iterator[bytes]:
        """Liefert die Sprache Stück für Stück als rohes PCM (24 kHz, 16 Bit, mono).
        `plain`: ohne die Zusatzangaben language_code und previous_text."""
        body: dict = {"text": text, "model_id": model, "voice_settings": dict(VOICE_SETTINGS)}
        if not plain:
            if model in LANGUAGE_MODELS:
                body["language_code"] = language
            if previous_text:
                body["previous_text"] = previous_text[-300:]
        path = f"/v1/text-to-speech/{urllib.parse.quote(voice_id)}/stream?output_format=pcm_{RATE}"
        response = self._request("POST", path, body, accept="audio/pcm")
        with response:
            while True:
                chunk = response.read1(8192) if hasattr(response, "read1") else response.read(8192)
                if not chunk:
                    break
                yield chunk

    def speak(self, text: str, voice_id: str, model: str = DEFAULT_MODEL, **kwargs) -> bytes:
        """Wie stream(), aber am Stück (für Hörproben und den Zwischenspeicher)."""
        return b"".join(self.stream(text, voice_id, model, **kwargs))


def pick_default_voice(voices: list[dict]) -> dict | None:
    """Eine gute erste Wahl für Jarvis: eine der ruhigen britischen Standardstimmen,
    sonst die erste männliche, sonst irgendeine."""
    for name in PREFERRED_NAMES:
        for v in voices:
            if v["name"].split(" ")[0].lower() == name.lower():
                return v
    for v in voices:
        if v.get("gender") == "male":
            return v
    return voices[0] if voices else None


def _voice(v: dict) -> dict:
    labels = v.get("labels") or {}
    return {
        "voice_id": str(v.get("voice_id", "")),
        "name": str(v.get("name", "")).split(" - ")[0].strip(),
        "gender": str(v.get("gender") or labels.get("gender") or ""),
        "accent": str(v.get("accent") or labels.get("accent") or ""),
        "age": str(v.get("age") or labels.get("age") or ""),
        "description": str(v.get("description") or labels.get("description") or v.get("descriptive") or "")[:140],
        "category": str(v.get("category", "")),
        "preview_url": str(v.get("preview_url") or ""),
    }


def _error(exc: urllib.error.HTTPError) -> ElevenLabsError:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except Exception:
        raw = ""
    status, message = "", raw[:300]
    try:
        detail = json.loads(raw).get("detail")
        if isinstance(detail, dict):
            status = str(detail.get("status") or detail.get("code") or "")
            message = str(detail.get("message") or message)
        elif isinstance(detail, str):
            message = detail
        elif isinstance(detail, list) and detail:
            message = json.dumps(detail[0], ensure_ascii=False)
    except Exception:
        pass
    text = f"{status} {message}".lower()
    # ElevenLabs meldet ein leeres Guthaben manchmal auch mit 401, deshalb zuerst prüfen.
    if exc.code == 402 or "quota" in text or "credit" in text or "payment" in text:
        kind = "quota"
    elif exc.code == 401 or "invalid_api_key" in text or "api_key" in status:
        kind = "key"
    elif exc.code == 404 or "voice_not_found" in text:
        kind = "voice"
    elif exc.code == 429:
        kind = "busy"
    elif "language_code" in text or "previous_text" in text:
        kind = "param"
    elif "model" in text:
        kind = "model"
    else:
        kind = "other"
    return ElevenLabsError(kind, f"ElevenLabs {exc.code}: {message or exc.reason}")
