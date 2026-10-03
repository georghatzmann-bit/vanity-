"""Text zu Sprache, ganz auf dem eigenen PC: die lokale Jarvis-Stimme (Pocket TTS, localvoice.py),
als Reserve Piper (auch lokal). ElevenLabs nur, wenn Georg es ausdrücklich wählt. Eine Windows- oder
Microsoft-Stimme gibt es nicht mehr.

`Speaker` spricht Sätze nacheinander im Hintergrund und erzeugt den nächsten
Satz schon, während der aktuelle noch läuft. Was die Stimmen auf dem PC vorlesen, schreibt aussprache.py vorher
aus ("25.231" -> fünfundzwanzigtausend..., "18:30 Uhr" -> achtzehn Uhr dreißig, "Mails" -> Mehls).
"""

from __future__ import annotations

import hashlib
import logging
import os
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np

from .aussprache import speak
from .text import speakable

log = logging.getLogger(__name__)


class TextToSpeech:
    # Kurze Sätze ("Einen Moment, Sir.") merkt sich Jarvis auf der Festplatte: Beim
    # nächsten Mal kommen sie sofort, ohne Internet-Umweg.
    CACHE_MAX_CHARS = 80
    CACHE_MAX_FILES = 400

    def __init__(self, cfg: dict, cache_dir: Path | None = None, on_problem: Callable[[str], None] | None = None) -> None:
        # "lokal" (Standard) oder "elevenlabs". Alte Einträge ("edge", "windows") heißen jetzt lokal.
        engine = str(cfg.get("engine", "lokal") or "lokal").strip().lower()
        self._engine = engine if engine == "elevenlabs" else "lokal"
        # ElevenLabs (Premium): Schlüssel, Stimme und Modell
        self._eleven = None
        self._eleven_voice = str(cfg.get("elevenlabs_voice", "") or "").strip()
        self._eleven_model = str(cfg.get("elevenlabs_model", "") or "").strip()
        self._eleven_plain = False
        self._eleven_paused_until = 0.0
        # ElevenLabs erlaubt nur wenige Anfragen gleichzeitig (Gratis-Konto: 2), alles darüber
        # lehnt es ab. Jarvis lädt deshalb immer nur einen Satz auf einmal. Das reicht: Ein Satz
        # ist viel schneller geladen, als der davor gesprochen ist.
        self._eleven_slot = threading.BoundedSemaphore(1)
        self._previous = ""
        self._reported_at = -1e9
        self._on_problem = on_problem or (lambda _text: None)
        self._cache_dir = Path(cache_dir) if cache_dir else None
        # Lokal (Pocket TTS): Jarvis' Stimme ganz ohne Internet, siehe localvoice.py. Auch bei
        # ElevenLabs da, als Reserve (dann lädt sie erst, wenn ElevenLabs einmal nicht geht).
        self._local = None
        self._local_voice = str(cfg.get("lokal_stimme", "") or "")  # die gewählte, auch wenn sie erst später kommt
        self._local_quality = str(cfg.get("lokal_qualitaet", "auto") or "auto")  # auto, beste, schnell
        self._local_lock = threading.Lock()
        self.enable_local(cfg.get("lokal_stimme", ""), start=self._engine == "lokal")
        key = str(cfg.get("elevenlabs_key", "") or "").strip()
        if self._engine == "elevenlabs" and key and self._eleven_voice:
            from .elevenlabs import DEFAULT_MODEL, ElevenLabs

            self._eleven = ElevenLabs(key)
            self._eleven_model = self._eleven_model or DEFAULT_MODEL
        self.used_main = False  # kam der letzte Satz von der gewählten Stimme (nicht von der Reserve)?

    def enable_local(self, voice: str = "", start: bool = True) -> bool:
        """Die lokale Stimme dazunehmen, sobald sie installiert ist (beim Start, oder wenn Jarvis
        sie gerade im Hintergrund nachgeholt hat). True = sie ist da."""
        from .localvoice import PocketVoice, installed, model_for, voice_id

        with self._local_lock:
            if self._local is not None:
                return True
            if voice_id(voice or self._local_voice) == "thorsten":
                self._local_voice = "thorsten"
                self._local = ThorstenVoice()
                if start:
                    self._local.start()
                return True
            if not installed()["tts"]:
                log.warning("Die lokale Stimme ist nicht installiert. Bis dahin spricht die Reservestimme (Piper).")
                return False
            self._local_voice = voice_id(voice or self._local_voice)
            self._local = PocketVoice(self._local_voice, model_for(self._local_quality, self._cache_dir))
        if start:
            self._local.start()
        return True

    def improve_local(self, idle: Callable[[], bool] = lambda: True) -> bool | None:
        """Einmal pro PC (Einstellung "auto"): Reicht der Prozessor für das große, deutlichere Modell? Dann
        lädt und misst Jarvis es in einem eigenen Prozess und wechselt ohne Neustart.
        True = spricht jetzt mit dem großen Modell, False = bleibt so, None = gerade viel los, später nochmal."""
        from .localvoice import decide_from_standard, measure, model_for, speed_of, worth_measuring

        local, folder = self._local, self._cache_dir
        if local is None or self._eleven is not None or folder is None:
            return False
        if getattr(local, "model", "standard") in ("gross", "thorsten") or not worth_measuring(self._local_quality, folder):
            return False
        if not idle():  # neben einem Spiel gemessen, wäre jeder PC zu langsam
            return None
        if not local.usable(wait=600):
            return False
        local.synthesize("Sehr wohl, Sir.")  # das erste Mal ist immer langsamer
        if not decide_from_standard(folder, speed_of(local)):
            return False
        if not idle():
            return None
        if measure(folder) != "gross":
            return False
        return self.switch_local(model_for(self._local_quality, folder))

    def switch_local(self, model: str) -> bool:
        """Lädt die lokale Stimme mit einem anderen Modell und wechselt erst, wenn sie bereit ist."""
        from .localvoice import PocketVoice

        voice = PocketVoice(self._local_voice, model)
        voice.start()
        if not voice.usable(wait=900) or voice.model != model:
            log.warning("Lokale Stimme: Modell %s lädt nicht (%s), es bleibt beim alten.", model, voice.error)
            return False
        with self._local_lock:
            self._local = voice
        self.warm_up()
        return True

    @property
    def local_model(self) -> str:
        return getattr(self._local, "model", "") if self._local is not None else ""

    @property
    def local_ready(self) -> bool:
        return self._local is not None and self._local.ready.is_set() and self._local.error is None

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        """Gibt die gesprochene Fassung von `text` als int16-Samples und Abtastrate zurück."""
        cached = self._cache_file(text)
        if cached is not None and cached.exists():
            try:
                with np.load(cached) as data:
                    self.used_main = True
                    return data["samples"].copy(), int(data["rate"])
            except Exception as exc:
                log.debug("Stimmen-Zwischenspeicher: %s", exc)
        if self._eleven is not None and time.monotonic() >= self._eleven_paused_until:
            try:
                store = None if cached is None else (
                    lambda done: self._store(cached, trim_silence(done.samples(), done.rate), done.rate))
                audio = self._eleven_stream(text, on_complete=store)
                self._previous = text
                self.used_main = True
                return audio, audio.rate
            except Exception as exc:
                self._eleven_problem(exc)
        if self._local is not None:
            try:
                # Nur Sätze der Hauptstimme kommen in den Zwischenspeicher (sonst spräche ElevenLabs
                # später mit der lokalen Stimme).
                audio = self._local_stream(spoken(text), cached if self._eleven is None else None)
                self.used_main = self._eleven is None
                return audio, audio.rate
            except Exception as exc:
                if self._local.loading():  # lädt nach 30 s noch (sehr langsamer PC): kein Fehler
                    log.info("Lokale Stimme lädt noch, dieser Satz kommt von der Reservestimme.")
                    return self._offline(spoken(text))
                log.warning("Lokale Stimme: %s. Nehme die Reservestimme.", exc)
                if time.monotonic() - self._reported_at > 600:
                    self._reported_at = time.monotonic()
                    self._on_problem("Die lokale Stimme spricht gerade nicht. Jarvis nimmt so lange die Reservestimme.")
        return self._offline(spoken(text))

    # Ist ElevenLabs kurz ausgelastet, lieber einen Moment warten als die Stimme wechseln.
    BUSY_RETRIES = (0.3, 0.6, 1.0, 1.5)

    def _eleven_stream(self, text: str, on_complete: Callable[["StreamingAudio"], None] | None = None) -> "StreamingAudio":
        """Startet ElevenLabs und kommt zurück, sobald die ersten Töne da sind. `on_complete` (Zwischenspeicher)
        steht schon vor dem Start fest: Kurze Sätze sind oft fertig geladen, bevor diese Funktion zurückkommt."""
        from .elevenlabs import FALLBACK_MODEL, RATE, ElevenLabsError

        busy_waits = list(self.BUSY_RETRIES)
        timeouts = 0
        while True:
            # Der Satz davor muss fertig geladen sein (er wird ja gerade erst gesprochen).
            if not self._eleven_slot.acquire(timeout=20):
                raise ElevenLabsError("net", "Der Satz davor lädt nicht fertig")
            audio = StreamingAudio(RATE)
            audio.on_complete = on_complete
            model, plain, previous = self._eleven_model, self._eleven_plain, self._previous

            def run(audio=audio, model=model, plain=plain, previous=previous) -> None:
                try:
                    for chunk in self._eleven.stream(text, self._eleven_voice, model, previous, plain=plain):
                        audio.feed(chunk)
                    audio.finish()
                except Exception as exc:
                    audio.finish(exc)
                finally:
                    self._eleven_slot.release()

            threading.Thread(target=run, name="jarvis-elevenlabs", daemon=True).start()
            if not audio.ready.wait(8.0):
                timeouts += 1
                if timeouts < 2:
                    log.info("ElevenLabs antwortet langsam, versuche den Satz noch einmal.")
                    continue
                raise ElevenLabsError("net", "ElevenLabs antwortet nicht")
            error = audio.error
            if error is None or audio.available() > 0:
                return audio
            kind = getattr(error, "kind", "other")
            if kind == "busy" and busy_waits:
                time.sleep(busy_waits.pop(0))
                continue
            if kind == "model" and self._eleven_model != FALLBACK_MODEL:
                log.warning("ElevenLabs-Modell %s geht nicht (%s), nehme %s.", self._eleven_model, error, FALLBACK_MODEL)
                self._eleven_model = FALLBACK_MODEL
                continue
            if kind == "param" and not self._eleven_plain:
                self._eleven_plain = True
                continue
            raise error

    # Die lokale Stimme rechnet auf dem Prozessor. Etwas mehr Vorlauf, damit es auch auf
    # langsameren PCs (oder neben einem Spiel) nicht stockt.
    LOCAL_BUFFER_SECONDS = 0.6

    def _local_stream(self, text: str, cached: Path | None = None) -> "StreamingAudio":
        """Startet die lokale Stimme und kommt zurück, sobald genug Ton da ist. Lädt sie noch
        (kurz nach dem Start), wartet Jarvis lieber, als mitten im Gespräch die Stimme zu wechseln."""
        from .localvoice import RATE

        audio = StreamingAudio(int(getattr(self._local, "rate", RATE) or RATE))
        audio.BUFFER_SECONDS = self.LOCAL_BUFFER_SECONDS
        if cached is not None:  # vor dem Start setzen: Kurze Sätze sind fertig, bevor synthesize zurückkommt
            audio.on_complete = lambda done: self._store(cached, trim_silence(done.samples(), done.rate), done.rate)

        def run() -> None:
            try:
                self._local.stream(text, audio.feed)
                audio.finish()
            except Exception as exc:
                audio.finish(exc)

        threading.Thread(target=run, name="jarvis-lokale-stimme-satz", daemon=True).start()
        if not audio.ready.wait(45):
            raise RuntimeError("Die lokale Stimme antwortet nicht")
        if audio.error is not None and audio.available() == 0:
            raise audio.error
        return audio

    def _eleven_problem(self, exc: Exception) -> None:
        kind = getattr(exc, "kind", "other")
        pause = {"key": 1800, "quota": 1800, "plan": 1800, "voice": 1800, "busy": 5, "net": 20}.get(kind, 60)
        self._eleven_paused_until = time.monotonic() + pause
        log.warning("ElevenLabs: %s (Pause %d s, solange spricht die lokale Stimme)", exc, pause)
        if self._local is not None:
            self._local.start()  # als Reserve laden, falls noch nicht geschehen
        tell = {
            "key": "Der ElevenLabs-Schlüssel stimmt nicht. Ich spreche so lange mit meiner lokalen Stimme.",
            "quota": "Das ElevenLabs-Guthaben ist aufgebraucht. Ich spreche so lange mit meiner lokalen Stimme.",
            "plan": (
                "Diese ElevenLabs-Stimme gibt es nur mit Abo. Ich spreche so lange mit meiner lokalen Stimme. "
                "Kostenlos geht eine Stimme, die du in ElevenLabs selbst entwirfst. Mehr dazu in den Einstellungen unter Stimme."
            ),
            "voice": "Die gewählte ElevenLabs-Stimme gibt es nicht mehr. Bitte in den Einstellungen eine andere wählen.",
        }.get(kind)
        if tell and time.monotonic() - self._reported_at > 600:
            self._reported_at = time.monotonic()
            self._on_problem(tell)

    def _offline(self, text: str) -> tuple[np.ndarray, int]:
        """Die Reservestimme: Piper, auch auf dem PC. Geht auch die nicht, schweigt Jarvis lieber
        (die Antwort steht im Fenster), als mit einer Windows-Stimme zu sprechen."""
        self.used_main = False
        voice = piper_voice()
        if voice is not None:
            try:
                samples, rate = voice.synthesize(text)
                return trim_silence(samples, rate), rate
            except Exception as exc:
                log.warning("Reservestimme (Piper): %s", exc)
        if time.monotonic() - self._reported_at > 600:
            self._reported_at = time.monotonic()
            self._on_problem("Die lokale Stimme ist noch nicht bereit. Die Antworten stehen so lange im Fenster.")
        raise RuntimeError("keine lokale Stimme bereit")

    def prepare(self, texts) -> None:
        """Legt feste Sätze im Voraus in den Zwischenspeicher (im Hintergrund aufrufen)."""
        for text in texts:
            text = speakable(text)
            cached = self._cache_file(text)
            if cached is None or cached.exists():
                continue
            try:
                if self._eleven is not None:
                    from .elevenlabs import RATE

                    with self._eleven_slot:  # nicht gleichzeitig mit dem, was Jarvis gerade sagt
                        pcm = self._eleven.speak(text, self._eleven_voice, self._eleven_model, plain=self._eleven_plain)
                    samples, rate = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype=np.int16), RATE
                elif self._local is not None:
                    samples, rate = self._local.synthesize(spoken(text))
                else:
                    return
                self._store(cached, trim_silence(samples, rate), rate)
            except Exception as exc:
                log.debug("Vorbereiten von %r: %s", text, exc)
                return

    def warm_up(self) -> None:
        """Rechnet einmal einen kurzen Satz (im Hintergrund, gleich nach dem Start): Der erste echte Satz
        ist dann nicht langsamer als die anderen. Dabei misst Jarvis, wie schnell der Prozessor die Stimme
        rechnet, und braucht auf schnellen PCs weniger Vorlauf (die Stimme setzt früher ein)."""
        if self._local is None or self._eleven is not None:
            return
        try:
            # Erst fertig laden lassen und einmal rechnen (das erste Mal ist langsamer), dann messen. Sonst zählt
            # die Ladezeit mit: Im Windows-Build kam so 0,1-fach Echtzeit heraus statt 1,9-fach, und Jarvis
            # wartete vor jeder Antwort eine volle Sekunde statt 0,4.
            usable = getattr(self._local, "usable", None)
            if usable is not None and not usable(wait=120):
                log.info("Lokale Stimme vorwärmen: lädt noch")
                return
            self._local.synthesize("Sehr wohl.")
            started = time.monotonic()
            samples, rate = self._local.synthesize("Einen Moment, Sir.")
            took = max(1e-3, time.monotonic() - started)
        except Exception as exc:
            log.info("Lokale Stimme vorwärmen: %s", exc)
            return
        speed = (len(samples) / rate) / took  # > 1: schneller als Echtzeit
        self.LOCAL_BUFFER_SECONDS = local_buffer(speed)
        log.info("Lokale Stimme bereit: %.1f-fach Echtzeit, %.2f s Vorlauf.", speed, self.LOCAL_BUFFER_SECONDS)

    def _cache_file(self, text: str) -> Path | None:
        if self._cache_dir is None or not text or len(text) > self.CACHE_MAX_CHARS:
            return None
        if self._eleven is not None:
            key = "|".join(("elevenlabs", self._eleven_voice, self._eleven_model, text))
        elif self._local is not None:
            # "2": seit aussprache.py und den kürzeren Stücken. Ältere Sätze waren mit Ziffern gesprochen oder ohne
            # Satzende ("Es ist 18:30 Uhr" als Kauderwelsch), die sollen nicht wiederkommen.
            key = "|".join(("lokal2", self._local_voice, getattr(self._local, "model", "standard"), text))
        else:
            return None
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


def spoken(text: str) -> str:
    """Der Text für die Stimmen auf dem PC: Zahlen, Kürzel und englische Wörter ausgeschrieben (aussprache.py).
    Geht dabei etwas schief, spricht Jarvis lieber den Text, wie er ist, als gar nicht."""
    try:
        return speak(text) or text
    except Exception as exc:
        log.debug("Aussprache: %s", exc)
        return text


def local_buffer(speed: float) -> float:
    """Wie viel Ton da sein muss, bevor die lokale Stimme losspricht, je nachdem, wie viel schneller
    als Echtzeit der Prozessor sie rechnet. Schnell: kaum Vorlauf. Langsam: mehr, damit nichts stockt."""
    if speed >= 3.0:
        return 0.25
    if speed >= 1.8:
        return 0.4
    if speed >= 1.2:
        return 0.6
    return 1.0


def trim_silence(samples: np.ndarray, rate: int, lead: float = 0.05, trail: float = 0.18) -> np.ndarray:
    """Schneidet die Stille vor und nach einem Satz auf ein natürliches Maß. Manche Stimmen liefern
    vorn und hinten viel Stille mit. Satz für Satz gesprochen, wirkt Jarvis dadurch zäh."""
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


# ------------------------------------------------------------------ Piper (auch lokal): Thorsten und die Reserve

# Thorsten in hoher Qualität (114 MB): als eigene Stimme wählbar ("thorsten") und, sobald geladen, auch die Reserve.
# Bis dahin ist die Reserve Thorsten in mittlerer Qualität (63 MB, seit Langem dabei).
PIPER_HIGH = "de_DE-thorsten-high"
PIPER_MODEL = "de_DE-thorsten-medium"
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/"
PIPER_MIN_BYTES = {PIPER_HIGH: 100_000_000, PIPER_MODEL: 50_000_000}
_piper = None
_piper_name = ""
_piper_failed: set[str] = set()
_piper_lock = threading.Lock()
_download_lock = threading.Lock()


def piper_dir() -> Path:
    """Die Offline-Stimme liegt neben der Python-Umgebung, nicht im Jarvis-Ordner:
    So übersteht sie ein neues Entpacken von Jarvis."""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "Jarvis" / "stimmen"
    from .config import STATE_DIR

    return STATE_DIR / "stimmen"


def piper_model_ready(name: str = PIPER_MODEL) -> bool:
    model = piper_dir() / f"{name}.onnx"
    return model.exists() and model.stat().st_size >= PIPER_MIN_BYTES.get(name, 1) and \
        model.with_name(model.name + ".json").exists()


def ensure_piper_model(name: str = PIPER_MODEL) -> bool:
    """Lädt eine Piper-Stimme einmalig herunter (mittel 63 MB, hoch 114 MB). Ohne piper-tts: nichts tun."""
    try:
        import piper  # noqa: F401
    except Exception:
        return False
    folder = piper_dir()
    url = PIPER_BASE + name.rsplit("-", 1)[-1] + "/"
    try:
        with _download_lock:  # Einrichtung und Hintergrund laden nie dieselbe Datei gleichzeitig
            folder.mkdir(parents=True, exist_ok=True)
            for file, minimum in ((f"{name}.onnx.json", 1000), (f"{name}.onnx", PIPER_MIN_BYTES.get(name, 1))):
                target = folder / file
                if target.exists() and target.stat().st_size >= minimum:
                    continue
                part = target.with_name(target.name + ".part")
                with urllib.request.urlopen(url + file, timeout=30) as response, open(part, "wb") as out:
                    while chunk := response.read(1 << 16):
                        out.write(chunk)
                if part.stat().st_size < minimum:
                    raise OSError(f"{file} ist unvollständig")
                os.replace(part, target)
                log.info("Piper-Stimme geladen: %s", target)
        return True
    except Exception as exc:
        log.warning("Piper-Stimme %s nicht geladen: %s", name, exc)
        return False


class _PiperVoice:
    def __init__(self, model: Path) -> None:
        from piper import PiperVoice

        self._voice = PiperVoice.load(str(model))
        self._lock = threading.Lock()
        self.rate = int(getattr(getattr(self._voice, "config", None), "sample_rate", 22050) or 22050)

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        # espeak liest das englische "Sir" als "Sieh-er". "Sörr" klingt richtig.
        text = re.sub(r"\bSir\b", "Sörr", text)
        with self._lock:
            chunks = list(self._voice.synthesize(text))
        if not chunks:
            raise RuntimeError("keine Audiodaten")
        self.rate = int(chunks[0].sample_rate)
        return np.concatenate([c.audio_int16_array for c in chunks]), self.rate


def piper_voice():
    """Die geladene Piper-Stimme oder None (nicht installiert oder noch nicht heruntergeladen). Thorsten in hoher
    Qualität, sobald er da ist (dann ohne Neustart), sonst in mittlerer."""
    global _piper, _piper_name
    with _piper_lock:
        if _piper is not None and (_piper_name == PIPER_HIGH or not piper_model_ready(PIPER_HIGH)):
            return _piper
        for name in (PIPER_HIGH, PIPER_MODEL):
            if name in _piper_failed or not piper_model_ready(name):
                continue
            if _piper is not None and _piper_name == name:
                return _piper
            try:
                _piper, _piper_name = _PiperVoice(piper_dir() / f"{name}.onnx"), name
                return _piper
            except Exception as exc:
                log.warning("Piper-Stimme %s lässt sich nicht laden: %s", name, exc)
                _piper_failed.add(name)
        return _piper


class ThorstenVoice:
    """Thorsten (Piper, hohe Qualität) als Jarvis' Stimme: wie localvoice.PocketVoice, aber ohne pocket-tts.
    Lädt sein Modell beim ersten Start selbst (114 MB). Bis es da ist, spricht er in mittlerer Qualität
    (die Reserve, gleicher Sprecher), danach ohne Neustart in hoher."""

    model = "thorsten"

    def __init__(self) -> None:
        self.voice = "thorsten"
        self.ready = threading.Event()
        self.error: Exception | None = None
        self._started = False

    @property
    def rate(self) -> int:
        voice = piper_voice()
        return voice.rate if voice is not None else 22050

    def start(self) -> None:
        if not self._started:
            self._started = True
            threading.Thread(target=self._load, name="jarvis-thorsten", daemon=True).start()

    def _load(self) -> None:
        started = time.monotonic()
        try:
            if not piper_model_ready(PIPER_HIGH):
                ensure_piper_model(PIPER_HIGH)
            if piper_voice() is None:
                ensure_piper_model(PIPER_MODEL)
            voice = piper_voice()
            if voice is None:
                raise RuntimeError("Piper-Stimme fehlt (kein Internet beim ersten Start?)")
            log.info("Lokale Stimme thorsten (%s) bereit (%.1f s).", _piper_name or "Piper", time.monotonic() - started)
        except Exception as exc:
            self.error = exc
            log.warning("Lokale Stimme Thorsten lädt nicht: %s", exc)
        finally:
            self.ready.set()

    def loading(self) -> bool:
        return self._started and not self.ready.is_set()

    def usable(self, wait: float = 0.0) -> bool:
        self.start()
        self.ready.wait(wait)
        return self.ready.is_set() and self.error is None and piper_voice() is not None

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        # Lädt die hohe Qualität noch (erster Start nach dem Update, 114 MB), spricht Thorsten sofort in mittlerer:
        # Warten müsste Georg nur, wenn noch gar keine Piper-Stimme da ist.
        voice = piper_voice()
        if voice is None and self.usable(wait=30):
            voice = piper_voice()
        if voice is None:
            raise RuntimeError(f"Thorsten nicht bereit: {self.error or 'lädt noch'}")
        self.start()
        samples, rate = voice.synthesize(text)
        return trim_silence(samples, rate), rate

    def stream(self, text: str, feed: Callable[[bytes], None]) -> None:
        """Piper rechnet ein Stück immer im Ganzen. Lange Sätze kommen darum Teilsatz für Teilsatz (am Komma, das
        Komma bleibt dran und klingt wie eins): Jarvis spricht los, während der Rest noch entsteht."""
        for part in clauses(text):
            samples, _ = self.synthesize(part)
            feed(np.asarray(samples, dtype=np.int16).tobytes())


def clauses(text: str, longer_than: int = 70, at_least: int = 30) -> list[str]:
    """Ein langer Satz in Teilsätze (an Komma, Semikolon, Doppelpunkt), jeder mindestens at_least Zeichen lang."""
    text = str(text or "").strip()
    if len(text) <= longer_than:
        return [text] if text else []
    parts: list[str] = []
    for piece in re.split(r"(?<=[,;:])\s+", text):
        if parts and (len(parts[-1]) < at_least or len(piece) < at_least // 2):
            parts[-1] += " " + piece
        else:
            parts.append(piece)
    if len(parts) > 1 and len(parts[-1]) < at_least // 2:
        parts[-2] += " " + parts.pop()
    return parts


def play(samples: np.ndarray, rate: int) -> None:
    Player().play(samples, rate, lambda level: None)


def materialize(samples, timeout: float = 30.0) -> np.ndarray:
    """Fertige Samples, auch wenn die Stimme noch streamt (wartet dann bis zum Ende)."""
    if isinstance(samples, StreamingAudio):
        samples.done.wait(timeout)
        if samples.error is not None and samples.available() == 0:
            raise samples.error
        return trim_silence(samples.samples(), samples.rate)
    return samples


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


class StreamingAudio:
    """Sprache, die noch aus dem Netz kommt (ElevenLabs). Der Player spielt schon den
    Anfang, während der Rest lädt. Stille vorn wird übersprungen, hinten abgeschnitten."""

    # So viel Ton muss da sein, bevor das Abspielen beginnt (gegen Aussetzer)
    BUFFER_SECONDS = 0.25

    def __init__(self, rate: int) -> None:
        self.rate = rate
        self._data = bytearray()
        self._lock = threading.Lock()
        self.ready = threading.Event()  # genug Ton da, fertig oder Fehler
        self.done = threading.Event()
        self.error: Exception | None = None
        self.end: int | None = None
        self.on_complete: Callable[["StreamingAudio"], None] | None = None

    def feed(self, chunk: bytes) -> None:
        with self._lock:
            self._data.extend(chunk)
            enough = len(self._data) // 2 >= self.rate * self.BUFFER_SECONDS
        if enough:
            self.ready.set()

    def finish(self, error: Exception | None = None) -> None:
        self.error = error
        samples = self.samples()
        if samples.size:
            trimmed = trim_silence(samples, self.rate, lead=10.0)  # nur hinten kürzen
            self.end = len(trimmed)
        else:
            self.end = 0
        # Erst speichern, dann "fertig" melden: Wer auf das Ende wartet, findet den
        # Satz danach sicher im Zwischenspeicher.
        if error is None and self.on_complete is not None and samples.size:
            try:
                self.on_complete(self)
            except Exception as exc:
                log.debug("Zwischenspeicher: %s", exc)
        self.done.set()
        self.ready.set()

    def samples(self) -> np.ndarray:
        with self._lock:
            raw = bytes(self._data[: len(self._data) // 2 * 2])
        out = np.frombuffer(raw, dtype=np.int16)
        return out if self.end is None else out[: self.end]

    def available(self) -> int:
        with self._lock:
            n = len(self._data) // 2
        return n if self.end is None else min(n, self.end)

    def complete(self) -> bool:
        return self.done.is_set()

    def first_sound(self) -> int:
        """Wo die Sprache anfängt (etwas davor, damit nichts abgeschnitten wird)."""
        head = self.samples()[: self.rate]
        loud = np.flatnonzero(np.abs(head.astype(np.int32)) > max(120, int(np.abs(head).max(initial=0)) * 0.02))
        return max(0, int(loud[0]) - int(0.05 * self.rate)) if loud.size else 0

    def read(self, start: int, count: int) -> np.ndarray:
        with self._lock:
            n = len(self._data) // 2
            stop = min(n if self.end is None else min(n, self.end), start + count)
            if stop <= start:
                return np.zeros(0, dtype=np.int16)
            return np.frombuffer(bytes(self._data[start * 2 : stop * 2]), dtype=np.int16)


class _ArraySource:
    """Fertige Samples mit derselben Schnittstelle wie StreamingAudio."""

    def __init__(self, samples: np.ndarray) -> None:
        self._samples = np.ascontiguousarray(samples, dtype=np.int16).reshape(-1)

    def available(self) -> int:
        return len(self._samples)

    def complete(self) -> bool:
        return True

    def first_sound(self) -> int:
        return 0

    def read(self, start: int, count: int) -> np.ndarray:
        return self._samples[start : start + count]


class Speaker:
    """Spricht Sätze nacheinander im Hintergrund.

    Zwei Threads: einer erzeugt die Sprache (dauert je nach Stimme eine Zehntel- bis eine halbe
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
        self._playing_generation = -1
        self._speaking_lock = threading.Lock()
        self.spoken: list[str] = []
        # Der Player fragt beim Abspielen nach, ob der Satz noch dran ist. So geht kein
        # "Stopp" verloren, das genau zwischen Prüfen und Losspielen kommt.
        self._player.should_stop = lambda: not self._current(self._playing_generation)
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
                if not self.busy:
                    # Der vorige Satz ist schon fertig gespielt: sonst bliebe "spricht" hängen.
                    self._on_level(0.0)
                    self._set_speaking(False)
                continue
            if self._current(generation):
                self._audio.put((generation, text, samples, rate))

    def _play_worker(self) -> None:
        while True:
            generation, text, samples, rate = self._audio.get()
            if not self._current(generation):
                continue
            self._playing_generation = generation
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
        with self._speaking_lock:
            if value == self._speaking:
                return
            self._speaking = value
        self._on_speaking(value)


class Player:
    """Spielt Audio ab, meldet dabei die Lautstärke (für die Animation) und lässt sich stoppen.

    Jeder Player hat einen eigenen Ausgabe-Stream. sd.play() teilt sich einen globalen
    Stream, dann würde ein Signalton mitten in Jarvis' Satz diesen abschneiden.
    """

    def __init__(self) -> None:
        self._stopped = threading.Event()
        self.should_stop: Callable[[], bool] | None = None

    def _cancelled(self) -> bool:
        return self._stopped.is_set() or bool(self.should_stop and self.should_stop())

    def play(self, samples, rate: int, on_level: Callable[[float], None]) -> None:
        """Spielt fertige Samples oder StreamingAudio ab (das darf noch wachsen)."""
        import sounddevice as sd

        from .audio import PORTAUDIO_LOCK, playing

        self._stopped.clear()
        source = samples if isinstance(samples, StreamingAudio) else _ArraySource(samples)
        position = [source.first_sound()]
        finished = threading.Event()

        def fill(outdata, frames, time_info, status) -> None:
            start = position[0]
            chunk = source.read(start, frames)
            outdata[: len(chunk), 0] = chunk
            position[0] = start + len(chunk)
            if len(chunk) < frames:
                outdata[len(chunk) :, 0] = 0
                if source.complete() and position[0] >= source.available():
                    raise sd.CallbackStop

        window = max(1, rate // 20)
        with playing():
            with PORTAUDIO_LOCK:
                stream = sd.OutputStream(
                    samplerate=rate, channels=1, dtype="int16", callback=fill, finished_callback=finished.set
                )
                stream.start()
            try:
                last_position, last_progress = position[0], time.monotonic()
                while not finished.wait(0.05):
                    if self._cancelled():
                        break
                    if position[0] != last_position:
                        last_position, last_progress = position[0], time.monotonic()
                    elif time.monotonic() - last_progress > (2.0 if source.complete() else 10.0):
                        break  # hängt (kein Ton mehr vom Gerät oder aus dem Netz)
                    chunk = source.read(position[0], window).astype(np.float32)
                    level = float(np.sqrt(np.mean(chunk**2))) / 8000 if chunk.size else 0.0
                    on_level(min(1.0, level))
            finally:
                with PORTAUDIO_LOCK:
                    try:
                        if self._cancelled():
                            stream.abort()
                        else:
                            stream.stop()
                    finally:
                        stream.close()

    def stop(self) -> None:
        self._stopped.set()
