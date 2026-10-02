"""Stimme und Spracherkennung ganz auf dem eigenen PC, ohne Internet und ohne Abo.

- Stimme: Pocket TTS von Kyutai mit dem deutschen Modell (etwa 220 MB, Lizenz CC-BY-4.0). Klingt
  natürlich, läuft auf dem Prozessor, die ersten Töne kommen nach etwa 0,2 Sekunden.
- Spracherkennung: Parakeet TDT 0.6B v3 von NVIDIA über onnx-asr (etwa 670 MB, CC-BY-4.0). Im Test
  sechsmal so schnell wie Whisper small auf dem Prozessor und mindestens so genau.

Beides kommt erst auf Wunsch dazu (Einrichtung, Schritt Stimme, "Lokal"): pip-Pakete und Modelle
zusammen etwa 1,3 GB. Installieren, Modelle laden und Hörproben laufen in eigenen Prozessen
(`python -m jarvis.localvoice ...`), damit ein neues numpy nie in ein laufendes Jarvis gerät.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from typing import Callable

import numpy as np

log = logging.getLogger(__name__)

RATE = 24000  # Pocket TTS liefert 24 kHz
STT_MODEL = "nemo-parakeet-tdt-0.6b-v3"
PACKAGES = ["pocket-tts", "onnx-asr[cpu,hub]"]
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# Im Test (Rückübersetzung mit Parakeet) waren alle gut verständlich; George am klarsten.
VOICES = [
    {"id": "george", "name": "George", "desc": "Ruhig und klar, am besten verständlich", "recommended": True},
    {"id": "charles", "name": "Charles", "desc": "Die tiefste Stimme, sehr gelassen"},
    {"id": "juergen", "name": "Jürgen", "desc": "Natürlich, mittlere Tonlage"},
    {"id": "michael", "name": "Michael", "desc": "Tief und weich"},
    {"id": "javert", "name": "Javert", "desc": "Ernst und bestimmt"},
    {"id": "stuart_bell", "name": "Stuart", "desc": "Heller und freundlich"},
]
VOICE_IDS = {v["id"] for v in VOICES}
DEFAULT_VOICE = "george"
PREVIEW_TEXT = "Guten Abend, Sir. Alle Systeme laufen einwandfrei. Womit kann ich dienen?"


def installed() -> dict:
    """Welche Teile da sind (ohne sie zu laden, also schnell)."""
    importlib.invalidate_caches()  # gerade erst installiert (Einrichtung): sonst sieht Python es nicht sofort
    return {"tts": importlib.util.find_spec("pocket_tts") is not None,
            "stt": importlib.util.find_spec("onnx_asr") is not None}


def voice_id(value: str) -> str:
    value = str(value or "").strip().lower()
    return value if value in VOICE_IDS else DEFAULT_VOICE


def _threads() -> int:
    """Nicht alle Kerne: Läuft nebenbei ein Spiel, soll es davon nichts merken."""
    return max(2, min(4, (os.cpu_count() or 4) // 2))


# ---------------------------------------------------------------------- Stimme


class PocketVoice:
    """Die deutsche Pocket-TTS-Stimme. Lädt im Hintergrund (start), spricht dann Satz für Satz."""

    def __init__(self, voice: str = DEFAULT_VOICE) -> None:
        self.voice = voice_id(voice)
        self.ready = threading.Event()
        self.error: Exception | None = None
        self._model = None
        self._state = None
        self._lock = threading.Lock()
        self._started = False

    def start(self) -> None:
        if not self._started:
            self._started = True
            threading.Thread(target=self._load, name="jarvis-lokale-stimme", daemon=True).start()

    def _load(self) -> None:
        try:
            import torch
            from pocket_tts import TTSModel

            torch.set_num_threads(_threads())
            _utf8_configs()
            started = time.monotonic()
            self._model = TTSModel.load_model(language="german")
            self._state = self._model.get_state_for_audio_prompt(self.voice)
            log.info("Lokale Stimme %s bereit (%.1f s).", self.voice, time.monotonic() - started)
        except Exception as exc:
            self.error = exc
            log.warning("Lokale Stimme lädt nicht: %s", exc)
        finally:
            self.ready.set()

    def loading(self) -> bool:
        """Lädt noch: die ersten Sekunden nach dem Start, auf langsamen PCs auch eine Minute."""
        return self._started and not self.ready.is_set()

    def usable(self, wait: float = 0.0) -> bool:
        self.start()
        self.ready.wait(wait)
        return self.ready.is_set() and self.error is None and self._model is not None

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        if not self.usable(wait=30):
            raise RuntimeError(f"Lokale Stimme nicht bereit: {self.error or 'lädt noch'}")
        with self._lock:
            audio = self._model.generate_audio(self._state, text)
        return _pcm16(audio), RATE

    def stream(self, text: str, feed: Callable[[bytes], None]) -> None:
        """Gibt den Satz Stück für Stück weiter (int16-Bytes), sobald es berechnet ist."""
        if not self.usable(wait=30):
            raise RuntimeError(f"Lokale Stimme nicht bereit: {self.error or 'lädt noch'}")
        with self._lock:
            for chunk in self._model.generate_audio_stream(self._state, text):
                feed(_pcm16(chunk).tobytes())


def _utf8_configs() -> None:
    """Pocket TTS liest seine YAML-Datei ohne Angabe der Kodierung. Unter Windows ist das cp1252, und
    das deutsche Modell scheitert an den Anführungszeichen „“ darin ('charmap' codec can't decode).
    Nur in diesem Modul liest open() darum Text als UTF-8, der Rest von Jarvis bleibt, wie er ist."""
    try:
        from pocket_tts.utils import config as module
    except Exception:
        return
    if getattr(module, "_jarvis_utf8", False):
        return

    def utf8_open(file, mode="r", *args, **kwargs):
        if "b" not in mode and len(args) < 2 and kwargs.get("encoding") is None:
            kwargs["encoding"] = "utf-8"
        return open(file, mode, *args, **kwargs)

    module.open = utf8_open
    module._jarvis_utf8 = True


def _pcm16(audio) -> np.ndarray:
    try:
        audio = audio.detach().cpu().numpy()
    except AttributeError:
        audio = np.asarray(audio)
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    return (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)


# ---------------------------------------------------------------------- Spracherkennung


class ParakeetSpeechToText:
    """Parakeet v3 auf dem Prozessor. Erkennt die Sprache selbst (Deutsch klappt im Test sicher)."""

    def __init__(self) -> None:
        import onnx_asr

        started = time.monotonic()
        self._model = onnx_asr.load_model(STT_MODEL, quantization="int8")
        self._lock = threading.Lock()
        log.info("Lokale Spracherkennung (Parakeet) bereit (%.1f s).", time.monotonic() - started)

    def transcribe(self, audio: np.ndarray) -> str:
        from .stt import clean_transcript

        audio = np.asarray(audio)
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        audio = audio.astype(np.float32).reshape(-1)
        if audio.size < 1600:  # unter 0,1 Sekunden: nichts gesagt
            return ""
        with self._lock:
            text = self._model.recognize(audio, sample_rate=16000)
        return clean_transcript(str(text or ""))


# ---------------------------------------------------------------------- Einrichten (eigene Prozesse)


def install(on_line: Callable[[str], None] | None = None, timeout: float = 3600) -> tuple[bool, str]:
    """pip-Pakete installieren (einmalig, etwa 500 MB). Gibt (ok, letzte Meldung) zurück."""
    cmd = [_python(), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", *PACKAGES]
    return _run(cmd, on_line, timeout)


def prepare(previews: Path, on_line: Callable[[str], None] | None = None, timeout: float = 3600) -> tuple[bool, str]:
    """Modelle laden (einmalig, etwa 900 MB) und die Hörproben aller Stimmen schreiben."""
    cmd = [_python(), "-m", "jarvis.localvoice", "vorbereiten", str(previews)]
    return _run(cmd, on_line, timeout)


def preview_file(previews: Path, voice: str) -> Path:
    return Path(previews) / f"lokal-{voice_id(voice)}.wav"


def _python() -> str:
    """python.exe statt pythonw.exe: pip braucht eine Ausgabe, ein Fenster kommt trotzdem nicht."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        return str(exe.parent / "python.exe")
    return str(exe)


def _run(cmd: list[str], on_line, timeout: float) -> tuple[bool, str]:
    from .config import ROOT

    last = ""
    try:
        proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    except OSError as exc:
        return False, str(exc)
    killer = threading.Timer(timeout, proc.kill)
    killer.start()
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            last = line
            if on_line is not None:
                try:
                    on_line(line)
                except Exception:
                    pass
        proc.wait()
    finally:
        killer.cancel()
    return proc.returncode == 0, last


def _write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with wave.open(str(temp), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(np.asarray(samples, dtype=np.int16).tobytes())
    os.replace(temp, path)


def _prepare_main(previews: Path) -> int:
    print("Lade die Stimme (etwa 220 MB) ...", flush=True)
    voice = PocketVoice(DEFAULT_VOICE)
    voice.start()
    if not voice.usable(wait=1800):
        print(f"Fehler: Stimme lädt nicht: {voice.error}", flush=True)
        return 1
    for item in VOICES:
        target = preview_file(previews, item["id"])
        if target.exists():
            continue
        print(f"Hörprobe: {item['name']} ...", flush=True)
        state = voice._model.get_state_for_audio_prompt(item["id"])
        _write_wav(target, _pcm16(voice._model.generate_audio(state, PREVIEW_TEXT)), RATE)
    print("Lade die Spracherkennung (etwa 670 MB) ...", flush=True)
    try:
        ParakeetSpeechToText()
    except Exception as exc:
        print(f"Fehler: Spracherkennung lädt nicht: {exc}", flush=True)
        return 1
    print("Fertig: Stimme und Spracherkennung laufen ohne Internet.", flush=True)
    return 0


def _selftest_main() -> int:
    """Für den Windows-Build: deutsch sprechen und wieder erkennen."""
    from scipy.signal import resample_poly

    sentence = "Guten Abend, Sir. Die Erinnerung für morgen ist eingetragen."
    voice = PocketVoice(DEFAULT_VOICE)
    started = time.monotonic()
    # Erster Start nach der Installation: Windows prüft die frischen Dateien (torch), das kann
    # länger dauern als die 30 s, die ein Satz im Gespräch höchstens wartet.
    if not voice.usable(wait=600):
        print(f"Fehler: Stimme lädt nicht: {voice.error or 'nach 10 Minuten noch nicht fertig'}", flush=True)
        return 1
    print(f"Stimme geladen in {time.monotonic() - started:.1f} s", flush=True)
    samples, rate = voice.synthesize(sentence)
    seconds = samples.size / rate
    print(f"Stimme: {seconds:.1f} s Sprache in {time.monotonic() - started:.1f} s (mit Laden)", flush=True)
    first = []
    begin = time.monotonic()
    voice.stream("Sehr wohl, Sir.", lambda chunk: first.append(time.monotonic() - begin) if not first else None)
    print(f"Erste Töne nach {first[0]:.2f} s", flush=True)
    stt = ParakeetSpeechToText()
    audio = resample_poly(samples.astype(np.float32) / 32768.0, 2, 3).astype(np.float32)
    begin = time.monotonic()
    text = stt.transcribe(audio)
    print(f"Erkannt in {time.monotonic() - begin:.2f} s: {text}", flush=True)
    words = {"abend", "erinnerung", "morgen", "eingetragen"}
    found = {w for w in words if w in text.lower()}
    if len(found) < 3:
        print(f"Fehler: zu wenig erkannt ({sorted(found)})", flush=True)
        return 1
    print("Lokale Stimme und Spracherkennung OK", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    for stream in (sys.stdout, sys.stderr):  # Umlaute in der Ausgabe dürfen nie abbrechen
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.WARNING)
    if args[:1] == ["vorbereiten"] and len(args) > 1:
        return _prepare_main(Path(args[1]))
    if args[:1] == ["selbsttest"]:
        return _selftest_main()
    print("Aufruf: python -m jarvis.localvoice vorbereiten <ordner> | selbsttest")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
