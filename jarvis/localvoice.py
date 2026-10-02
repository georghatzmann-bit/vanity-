"""Stimme und Spracherkennung ganz auf dem eigenen PC, ohne Internet und ohne Abo.

- Stimme: Pocket TTS von Kyutai mit dem deutschen Modell (etwa 220 MB, Lizenz CC-BY-4.0). Klingt
  natürlich, läuft auf dem Prozessor, die ersten Töne kommen nach etwa 0,2 Sekunden. Auf schnellen PCs
  nimmt Jarvis von selbst das große deutsche Modell (24 Schichten, etwa 640 MB, ab pocket-tts 3.3): Im
  Test verstand die Spracherkennung davon 7 bis 10 % der Wörter falsch statt 11 bis 15 %. Es rechnet
  aber nur etwa halb so schnell, darum misst Jarvis einmal pro PC, ob es reicht (modell_fuer, messen).
- Spracherkennung: Parakeet TDT 0.6B v3 von NVIDIA über onnx-asr (etwa 670 MB, CC-BY-4.0). Im Test
  sechsmal so schnell wie Whisper small auf dem Prozessor und mindestens so genau.

Das ist Jarvis' Standard: Der Installer richtet beides gleich mit ein (pip-Pakete und Modelle zusammen
etwa 1,3 GB). Ging das nicht (kein Internet), holt Jarvis es im Hintergrund nach (ensure_installed),
in der Einrichtung geht es auch per Klick. Installieren, Modelle laden und Hörproben laufen in eigenen
Prozessen (`python -m jarvis.localvoice ...`), damit ein neues numpy nie in ein laufendes Jarvis gerät.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import platform
import re
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
PACKAGES = ["pocket-tts>=3.3.0", "onnx-asr[cpu,hub]"]
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# Die beiden deutschen Modelle. "gross" lädt quantisiert (int8): ein Drittel schneller, gleich gut verständlich.
MODELS = {"standard": "german", "gross": "german_24l"}
BIG_VERSION = (3, 3, 0)  # ab dieser pocket-tts-Version gibt es das große deutsche Modell
# Das große Modell rechnet etwa halb so schnell wie das Standardmodell. Erst wenn das Standardmodell
# mindestens so viel schneller als Echtzeit ist, lohnt der Versuch (sonst 640 MB umsonst geladen) ...
BIG_TRY_FROM = 2.6
# ... und das große selbst muss mindestens so schnell sein, damit nichts stockt, auch neben einem Spiel.
BIG_MIN_SPEED = 1.4
CHOICE_FILE = "modell.json"  # im Ordner daten/stimmen: was die Messung auf diesem PC ergab
RETRY_AFTER = 24 * 3600  # Messen ging nicht (kein Internet): frühestens morgen wieder

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


# ---------------------------------------------------------------------- Welches Modell


def pocket_version() -> tuple[int, ...]:
    try:
        from importlib.metadata import version

        return tuple(int(part) for part in re.findall(r"\d+", version("pocket-tts"))[:3])
    except Exception:
        return ()


def big_possible() -> bool:
    return pocket_version() >= BIG_VERSION


def quality(value) -> str:
    """[tts] lokal_qualitaet: "auto" (misst einmal pro PC), "beste" (immer das große) oder "schnell"."""
    value = str(value or "").strip().lower()
    if value in ("beste", "gross", "groß", "hoch"):
        return "beste"
    if value in ("schnell", "standard", "klein"):
        return "schnell"
    return "auto"


def _this_pc() -> str:
    """Neuer Prozessor (oder die Daten auf einen anderen PC kopiert): dann misst Jarvis neu."""
    return f"{platform.processor() or platform.machine()}|{os.cpu_count() or 0}"


def read_choice(folder: Path | None) -> dict:
    if folder is None:
        return {}
    try:
        data = json.loads((Path(folder) / CHOICE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get("pc") == _this_pc() else {}


def write_choice(folder: Path, **values) -> dict:
    data = {"pc": _this_pc(), "zeit": time.time(), **values}
    target = Path(folder) / CHOICE_FILE
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + ".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, target)
    except OSError as exc:
        log.debug("Stimmenwahl speichern: %s", exc)
    return data


def model_for(setting, folder: Path | None) -> str:
    """Welches Modell spricht: "standard" oder "gross"."""
    setting = quality(setting)
    if setting == "schnell" or not big_possible():
        return "standard"
    if setting == "beste":
        return "gross"
    return "gross" if read_choice(folder).get("modell") == "gross" else "standard"


def worth_measuring(setting, folder: Path | None) -> bool:
    """Noch nicht gemessen ("auto"): Lohnt sich ein Blick aufs große Modell?"""
    if quality(setting) != "auto" or folder is None or not big_possible():
        return False
    choice = read_choice(folder)
    if choice.get("modell") in MODELS:
        return False
    return time.time() - float(choice.get("fehler", 0) or 0) > RETRY_AFTER


def decide_from_standard(folder: Path, speed: float) -> bool:
    """Das Standardmodell ist gemessen. True = schnell genug, das große zu probieren (messen()).
    Sonst bleibt es beim Standardmodell, und Jarvis fragt auf diesem PC nicht wieder."""
    if speed >= BIG_TRY_FROM:
        return True
    write_choice(folder, modell="standard", tempo_standard=round(speed, 2))
    log.info("Lokale Stimme: %.1f-fach Echtzeit, das große Modell wäre zu langsam. Es bleibt beim Standard.", speed)
    return False


def speed_of(voice: "PocketVoice", text: str = PREVIEW_TEXT) -> float:
    """Wie viel schneller als Echtzeit die Stimme rechnet (> 1 = schneller)."""
    started = time.monotonic()
    samples, rate = voice.synthesize(text)
    return (len(samples) / rate) / max(1e-3, time.monotonic() - started)


def _threads() -> int:
    """Nicht alle Kerne: Läuft nebenbei ein Spiel, soll es davon nichts merken."""
    return max(2, min(4, (os.cpu_count() or 4) // 2))


# ---------------------------------------------------------------------- Stimme


class PocketVoice:
    """Die deutsche Pocket-TTS-Stimme. Lädt im Hintergrund (start), spricht dann Satz für Satz."""

    def __init__(self, voice: str = DEFAULT_VOICE, model: str = "standard") -> None:
        self.voice = voice_id(voice)
        self.model = model if model in MODELS else "standard"
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
            self._model = self._load_model(TTSModel)
            self._state = self._model.get_state_for_audio_prompt(self.voice)
            log.info("Lokale Stimme %s (%s) bereit (%.1f s).", self.voice, MODELS[self.model], time.monotonic() - started)
        except Exception as exc:
            self.error = exc
            log.warning("Lokale Stimme lädt nicht: %s", exc)
        finally:
            self.ready.set()

    def _load_model(self, TTSModel):
        """Das große Modell quantisiert. Geht das nicht (alte Version, kein Internet für die 640 MB), spricht
        das Standardmodell: lieber die bekannte Stimme als keine."""
        if self.model == "gross":
            for quantize in (True, False):
                try:
                    return TTSModel.load_model(language=MODELS["gross"], quantize=quantize)
                except Exception as exc:
                    log.warning("Großes Stimmmodell%s lädt nicht: %s", " (quantisiert)" if quantize else "", exc)
            self.model = "standard"
        return TTSModel.load_model(language=MODELS["standard"])

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


def measure(folder: Path, on_line: Callable[[str], None] | None = None, timeout: float = 3600) -> str:
    """Das große Modell laden (etwa 640 MB) und messen, in einem eigenen Prozess (so stört es das laufende
    Jarvis nicht). Gibt das Modell zurück, das auf diesem PC künftig spricht."""
    ok, last = _run([_python(), "-m", "jarvis.localvoice", "messen", str(folder)], on_line, timeout)
    if not ok:
        log.info("Großes Stimmmodell messen: %s", last)
    return model_for("auto", folder)


def preview_file(previews: Path, voice: str) -> Path:
    return Path(previews) / f"lokal-{voice_id(voice)}.wav"


_ensuring = threading.Lock()


def ensure_installed(previews: Path, on_line: Callable[[str], None] | None = None) -> bool:
    """Holt Stimme und Spracherkennung nach, wenn sie fehlen (der Installer richtet sie sonst gleich mit
    ein, ohne Internet ging das aber nicht). Läuft in eigenen Prozessen, im Hintergrund.
    True = gerade frisch eingerichtet (vorher fehlte etwas, jetzt ist alles da)."""
    have = installed()
    if all(have.values()) and all(preview_file(previews, v["id"]).exists() for v in VOICES):
        return False
    if not _ensuring.acquire(blocking=False):
        return False  # läuft schon (z. B. aus der Einrichtung)
    try:
        fresh = not all(have.values())
        if fresh:
            log.info("Lokale Stimme fehlt, Jarvis richtet sie im Hintergrund ein.")
            ok, last = install(on_line)
            if not ok:
                log.warning("Lokale Stimme ließ sich nicht installieren: %s", last)
                return False
        ok, last = prepare(previews, on_line)
        if not ok:
            log.warning("Modelle der lokalen Stimme ließen sich nicht laden: %s", last)
            return False
        return fresh and all(installed().values())
    finally:
        _ensuring.release()


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


def _measure_big(folder: Path) -> str:
    """Lädt das große Modell, misst, wie schnell es rechnet, und hält das Ergebnis fest. Passt es, macht
    es auch die Hörproben neu (sie sollen so klingen, wie Jarvis dann wirklich spricht)."""
    print("Lade die beste Stimme (etwa 640 MB) ...", flush=True)
    voice = PocketVoice(DEFAULT_VOICE, "gross")
    voice.start()
    if not voice.usable(wait=3000) or voice.model != "gross":
        write_choice(folder, fehler=time.time(), grund=str(voice.error or "lädt nicht")[:200])
        print("Die beste Stimme ließ sich gerade nicht laden, es bleibt bei der Standardstimme.", flush=True)
        return "standard"
    voice.synthesize("Sehr wohl, Sir.")  # das erste Mal ist immer langsamer
    started, seconds = time.monotonic(), 0.0
    for text in (PREVIEW_TEXT, "Sehr wohl, Sir. Discord und Steam sind offen, der Gaming-Modus ist an."):
        samples, rate = voice.synthesize(text)
        seconds += len(samples) / rate
    speed = seconds / max(1e-3, time.monotonic() - started)
    model = "gross" if speed >= BIG_MIN_SPEED else "standard"
    write_choice(folder, modell=model, tempo_gross=round(speed, 2))
    if model != "gross":
        print(f"Die beste Stimme wäre auf diesem PC zu langsam ({speed:.1f}-fach Echtzeit), es bleibt beim Standard.",
              flush=True)
        return model
    for item in VOICES:
        print(f"Hörprobe: {item['name']} ...", flush=True)
        state = voice._model.get_state_for_audio_prompt(item["id"])
        _write_wav(preview_file(folder, item["id"]), _pcm16(voice._model.generate_audio(state, PREVIEW_TEXT)), RATE)
    print(f"Beste Stimme läuft flüssig ({speed:.1f}-fach Echtzeit), Jarvis nimmt sie.", flush=True)
    return model


def _configured_quality() -> str:
    try:
        from .config import load_config

        return quality((load_config().get("tts") or {}).get("lokal_qualitaet", "auto"))
    except Exception:
        return "auto"


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
    # Gleich bei der Installation (der PC hat gerade nichts anderes zu tun): Reicht er fürs große Modell?
    if worth_measuring(_configured_quality(), previews):
        voice.synthesize("Sehr wohl, Sir.")
        if decide_from_standard(previews, speed_of(voice)):
            voice = None  # Speicher frei machen fürs große Modell
            _measure_big(previews)
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
    if args[:1] == ["messen"] and len(args) > 1:
        _measure_big(Path(args[1]))
        return 0
    if args[:1] == ["selbsttest"]:
        return _selftest_main()
    print("Aufruf: python -m jarvis.localvoice vorbereiten <ordner> | messen <ordner> | selbsttest")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
