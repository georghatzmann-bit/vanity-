"""Grafische Einrichtung: Mikrofon, Stimme, Wohnort, Claude und Extras in sieben Schritten.

Öffnet sich beim ersten Start von selbst (und später über die Einstellungen im Jarvis-Fenster).
Die Seite liegt in gui/web/setup.html, hier ist die Python-Seite dazu (window.pywebview.api).
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from .config import CONFIG_PATH, HOME_DIR, ROOT, STATE_DIR, load_config, save_setting

log = logging.getLogger(__name__)

DONE_MARKER = STATE_DIR / "einrichtung-fertig.txt"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)


def windows_powershell_env(environ) -> dict:
    """Umgebung für Windows PowerShell ohne die Modulpfade von PowerShell 7. Wurde Jarvis aus
    PowerShell 7 gestartet, findet der Claude-Installer sonst Get-FileHash nicht."""
    env = dict(environ)
    for key in [k for k in env if k.upper() == "PSMODULEPATH"]:
        kept = [p for p in env[key].split(";") if p and "\\powershell\\" not in p.lower()]
        env[key] = ";".join(kept)
    return env


# Hörprobe für die Premium-Stimmen (die lokalen haben fertige Hörproben, localvoice.PREVIEW_TEXT)
PREVIEW_TEXT = "Guten Tag, Sir. Alle Systeme sind bereit. Womit darf ich dienen?"

HOTKEYS = [
    {"id": "ctrl+alt+m", "label": "Strg + Alt + M"},
    # Strg + Alt + J ist "Jarvis hört zu"
    {"id": "ctrl+shift+m", "label": "Strg + Umschalt + M"},
    {"id": "f9", "label": "F9"},
    {"id": "pause", "label": "Pause"},
]

SENSITIVE_THRESHOLD = 0.35


def setup_done() -> bool:
    return DONE_MARKER.exists()


def mark_done() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DONE_MARKER.write_text(time.strftime("%Y-%m-%d %H:%M:%S\n"), encoding="utf-8")


def _device(value) -> int | None:
    """Mikrofon aus der Seite: Nummer, oder leer/"default" für das Windows-Standardmikrofon."""
    if value is None or str(value).strip().lower() in ("", "default", "standard", "-1"):
        return None
    return int(value)


# Modellwahl: "auto" wählt Modell und Nachdenken pro Aufgabe (modellwahl.py), oder immer gleich.
MODES = ("auto", "schnell", "gruendlich")


def mode_of(brain_cfg: dict) -> str:
    """Die Modellwahl für die Einstellungen ("normal" und "maximal" zeigt sie als "auto")."""
    mode = str((brain_cfg or {}).get("modellwahl", "auto") or "auto").strip().lower().replace("ü", "ue")
    return mode if mode in MODES else "auto"


def _forget_brain_state() -> None:
    """Die gemerkte Ersatz-Wahl (daten/gehirn.json) soll eine neue Auswahl nicht überstimmen."""
    try:
        (STATE_DIR / "gehirn.json").unlink()
    except OSError:
        pass


def _ha_url(value) -> str:
    """Adresse von Home Assistant. "homeassistant.local:8123" reicht, http:// ergänzt Jarvis."""
    url = str(value or "").strip().rstrip("/")
    if url and not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url


def launch(*args: str) -> None:
    """Startet Jarvis (oder die Einrichtung) als eigenen Prozess ohne Konsolenfenster."""
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    program = str(pythonw if pythonw.exists() else exe)
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([program, "-m", "jarvis", *args], cwd=str(ROOT), creationflags=flags, close_fds=True)


def popup(text: str, error: bool = True) -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, "Jarvis", 0x10 if error else 0x40)
    except Exception:
        pass


class MicTest:
    """Liest ein Mikrofon im Hintergrund und misst Pegel und "Hey Jarvis"-Wert.
    Der Pegel läuft sofort, die Hey-Jarvis-Erkennung lädt nebenbei (ein paar Sekunden)."""

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._loader: threading.Thread | None = None
        self._wake = None
        self._wake_error = ""
        self.threshold = float(cfg["wakeword"]["threshold"])
        self._reset()

    def _reset(self) -> None:
        self.state = {
            "running": False, "level": 0.0, "wake": 0.0, "best": 0.0, "detected": False,
            "silent": False, "ready": self._wake is not None, "error": "",
        }

    def reload(self) -> None:
        """Neue Weckwort-Einstellung (z. B. Picovoice-Schlüssel): Erkennung neu laden."""
        with self._lock:
            if self._loader is not None and self._loader.is_alive():
                return
            self._wake = None
            self._loader = None
            self._wake_error = ""
        self.preload()

    def preload(self) -> None:
        """Lädt die Hey-Jarvis-Erkennung schon mal, damit der Test gleich losgeht."""
        with self._lock:
            if self._loader is not None or self._wake is not None:
                return
            self._loader = threading.Thread(target=self._load_wake, name="einrichtung-wakeword", daemon=True)
            self._loader.start()

    def _load_wake(self) -> None:
        from .audio import WakeWord

        try:
            wake = WakeWord(self._cfg["wakeword"]["model"], self.threshold, self._cfg["wakeword"].get("picovoice_key", ""))
            with self._lock:
                self._wake = wake
        except Exception as exc:
            log.warning("Hey-Jarvis-Erkennung: %s", exc)
            with self._lock:
                self._wake_error = f"Die Hey-Jarvis-Erkennung lädt nicht ({exc}). Ist das Internet an?"
                self._loader = None

    def start(self, device: int | None) -> dict:
        """`device` None = Windows-Standardmikrofon."""
        from .audio import Microphone, friendly_device_error

        self.stop()
        self.preload()
        try:
            mic = Microphone(device)
        except Exception as exc:
            return {"ok": False, "name": "", "error": friendly_device_error(exc)}
        with self._lock:
            self._reset()
            self.state["running"] = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(mic,), name="einrichtung-mikrofon", daemon=True)
        self._thread.start()
        return {"ok": True, "name": mic.name, "error": ""}

    def _run(self, mic) -> None:
        from .audio import friendly_device_error, rms

        wake = None
        try:
            with mic:
                while not self._stop.is_set():
                    frame = mic.read()
                    if wake is None and self._wake is not None:
                        wake = self._wake
                        wake.reset()
                    score = float(wake.score(frame)) if wake is not None else 0.0
                    with self._lock:
                        s = self.state
                        # Wie im Jarvis-Fenster: normales Sprechen füllt etwa die Hälfte.
                        s["level"] = min(1.0, rms(frame) / 3000)
                        s["wake"] = score
                        s["best"] = max(s["best"], score)
                        s["detected"] = s["detected"] or score >= self.threshold
                        s["silent"] = bool(mic.dead_silent)
                        s["ready"] = wake is not None
                        if self._wake_error and not s["error"]:
                            s["error"] = self._wake_error
        except Exception as exc:
            log.warning("Mikrofontest: %s", exc)
            with self._lock:
                self.state["error"] = friendly_device_error(exc)
        finally:
            with self._lock:
                self.state["running"] = False
                self.state["level"] = 0.0

    def set_threshold(self, value: float) -> None:
        with self._lock:
            self.threshold = value
            if self._wake is not None:
                self._wake.threshold = value

    def poll(self) -> dict:
        with self._lock:
            return {**self.state, "threshold": self.threshold}

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=4)
            self._thread = None


class ClaudeCheck:
    """Fragt Claude einmal im Hintergrund. Die Seite holt sich den Stand über poll()."""

    MESSAGES = {
        "login": "Claude Code ist installiert, aber noch nicht mit deinem Pro-Konto angemeldet.",
        "refused": "Claude hat bei allen Modellen abgelehnt, auch mit ganz einfachen Einstellungen.",
        "missing": "Claude Code ist noch nicht installiert.",
        "limit": "Dein Claude-Kontingent ist gerade aufgebraucht. Es füllt sich in ein paar Stunden wieder auf.",
        "network": "Claude ist gerade nicht erreichbar. Ist das Internet an?",
        "account": "Dein Claude-Konto meldet ein Problem. Bitte einmal auf claude.ai nachsehen.",
        "billing": "Claude Code rechnet über einen API-Schlüssel ab statt über dein Pro-Abo.",
        "timeout": "Claude hat zu lange nicht geantwortet.",
    }

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._lock = threading.Lock()
        self.result = {"state": "idle", "message": "", "model": "", "version": "", "detail": "", "note": ""}

    def start(self) -> dict:
        with self._lock:
            if self.result["state"] == "running":
                return {"started": False}
            self.result = {
                "state": "running", "message": "Ich frage Claude ...", "model": "", "version": "",
                "detail": "", "note": "",
            }
        threading.Thread(target=self._run, name="einrichtung-claude", daemon=True).start()
        return {"started": True}

    def _set(self, **values) -> None:
        with self._lock:
            self.result = {**self.result, **values}

    def _run(self) -> None:
        from .brain import BrainError, ClaudeBrain, find_claude
        from .persona import build_persona

        try:
            cfg = load_config()["brain"]
        except Exception:
            cfg = self._cfg["brain"]
        path = find_claude(cfg)
        if not path:
            self._set(state="missing", message=self.MESSAGES["missing"])
            return
        try:
            version = subprocess.run(
                [path, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                stdin=subprocess.DEVNULL,
                timeout=60, creationflags=NO_WINDOW, cwd=str(HOME_DIR),
            ).stdout.strip()
        except Exception:
            version = ""
        self._set(version=version)
        notes: list[str] = []

        def notice(text: str) -> None:
            # "sonnet hat abgelehnt, versuche haiku ..." live auf der Seite zeigen.
            notes.append(text)
            log.info("Claude-Prüfung: %s", text)
            self._set(message=text[:1].upper() + text[1:])

        try:
            cfg = dict(cfg, claude_path=path)
            brain = ClaudeBrain(cfg, HOME_DIR, STATE_DIR, persona=build_persona(HOME_DIR, STATE_DIR, self._cfg))
            brain.notice = notice
            first = brain.attempts[0]
            answer = brain.ask("Antworte nur mit: Test bestanden.")
        except BrainError as exc:
            log.warning("Claude-Prüfung fehlgeschlagen (%s): %s", exc.kind, exc)
            state = {"refusal": "refused", "cancelled": "error", "other": "error"}.get(exc.kind, exc.kind)
            message = self.MESSAGES.get(state, "Claude hat einen Fehler gemeldet.")
            self._set(state=state if state in self.MESSAGES else "error", message=message,
                      detail=str(exc).strip()[:700])
            return
        except Exception as exc:
            log.exception("Claude-Prüfung")
            self._set(state="error", message="Unerwarteter Fehler in Jarvis.", detail=str(exc)[:700])
            return
        note = ""
        speed = mode_of(cfg)
        if brain.attempt != first:
            note = (f"{first.label()} hat nicht geklappt, Jarvis nimmt deshalb {brain.attempt.label()}. "
                    "Das merkt er sich.")
            working = brain.attempt.model
            if working and brain.attempt.profile == "jarvis":
                # Dauerhaft merken: sonst fragt Jarvis jeden Tag zuerst das Modell, das ablehnt.
                models = [working] + [m for m in (cfg.get("models") or []) if m != working]
                try:
                    save_setting("brain", "models", models)
                except OSError as exc:
                    log.warning("Modell-Reihenfolge nicht gespeichert: %s", exc)
        self._set(state="ok", message="Das Gehirn ist verbunden. Jarvis kann denken.", model=answer.model,
                  note=note, speed=speed)

    def poll(self) -> dict:
        with self._lock:
            return dict(self.result)


class SetupApi:
    """Was die Einrichtungsseite in Python aufrufen darf. Interne Dinge beginnen mit _."""

    def __init__(self, cfg: dict, window_ref: list | None = None) -> None:
        self._cfg = cfg
        self._window_ref = window_ref if window_ref is not None else []
        self._mic = MicTest(cfg)
        self._claude = ClaudeCheck(cfg)
        self._devices: dict[int, str] = {}
        self._playing = threading.Lock()
        self._eleven_tier: str | None = None  # Tarif von ElevenLabs, sobald einmal gelesen
        self._local_job: threading.Thread | None = None  # Lokale Stimme einrichten (läuft im Hintergrund)
        self._local_line = ""
        self._local_error = ""
        self.finished: dict | None = None

    # ------------------------------------------------------------ Start

    def hello(self) -> dict:
        from . import __version__
        from .autostart import enabled
        from .brain import find_claude

        cfg = self._cfg
        claude = find_claude(cfg["brain"])
        return {
            "version": __version__,
            "first_run": not setup_done(),
            "values": {
                "mic": str(cfg["audio"].get("input_device") or ""),
                "ort": str(cfg.get("ich", {}).get("ort", "")),
                "name": str(cfg.get("ich", {}).get("name", "")),
                "hotkey": str(cfg["mute"].get("hotkey", "")),
                "threshold": float(cfg["wakeword"]["threshold"]),
                "autostart": enabled(),
                "full_permission": bool(cfg.get("rechte", {}).get("volle_freigabe", True)),
                "ha_url": str(cfg.get("homeassistant", {}).get("url", "")),
                "ha_token_set": bool(cfg.get("homeassistant", {}).get("token")),
                "speed": mode_of(cfg["brain"]),
                "tts_engine": "elevenlabs" if str(cfg["tts"].get("engine", "")) == "elevenlabs" else "lokal",
                "eleven_key_set": bool(str(cfg["tts"].get("elevenlabs_key", "") or "").strip()),
                "eleven_voice": str(cfg["tts"].get("elevenlabs_voice", "") or ""),
                "eleven_voice_name": str(cfg["tts"].get("elevenlabs_voice_name", "") or ""),
                "groq_key_set": bool(str(cfg["stt"].get("groq_key", "") or "").strip()),
                "pico_key_set": bool(str(cfg["wakeword"].get("picovoice_key", "") or "").strip()),
                "gespraech": bool(cfg["listen"].get("gespraech", True)),
                "name_allein": bool(cfg["wakeword"].get("name_allein", True)),
            },
            "claude": {"installed": bool(claude), "path": claude or ""},
        }

    # ------------------------------------------------------------ Mikrofon

    def mics(self) -> list:
        """Die Mikrofone für die Auswahl. `default` = in Windows als Standard eingestellt,
        `current` = das, was Jarvis mit der gespeicherten Einstellung gerade nimmt."""
        from .audio import input_devices, resolve_device, same_device
        from .mic_setup import choices

        self._mic.preload()
        try:
            everything = input_devices()
            devices = choices(everything)
        except Exception as exc:
            log.warning("Mikrofone: %s", exc)
            return []

        def label(name: str) -> str:
            # MME kürzt Namen auf 31 Zeichen. Den vollen Namen kennt WASAPI.
            name = name.strip()
            longer = [d["name"].strip() for d in everything if same_device(name, d["name"])]
            return max(longer, key=len, default=name)

        self._devices = {d["index"]: d["name"] for d in devices}
        saved = str(self._cfg["audio"].get("input_device") or "").strip()
        try:
            current = resolve_device(saved, devices) if saved else None
        except ValueError:
            current = None
        return [
            {
                "id": d["index"], "name": d["name"].strip(), "label": label(d["name"]),
                "api": d["hostapi"], "default": bool(d["default"]), "current": d["index"] == current,
            }
            for d in devices
        ]

    def mic_start(self, device) -> dict:
        return self._mic.start(_device(device))

    def mic_poll(self) -> dict:
        return self._mic.poll()

    def mic_stop(self) -> bool:
        self._mic.stop()
        return True

    def mic_save(self, device) -> dict:
        index = _device(device)
        if index is None:
            # Leer = Windows-Standardmikrofon.
            return self._save("audio", "input_device", "", extra={"name": "Windows-Standardmikrofon"})
        name = self._devices.get(index)
        if name is None:
            self.mics()
            name = self._devices.get(index)
        if name is None:
            return {"ok": False, "name": "", "error": "Dieses Mikrofon gibt es nicht mehr."}
        return self._save("audio", "input_device", name.strip(), extra={"name": name.strip()})

    def conversation_mode(self, on) -> dict:
        """Gespräch: nach jeder Antwort ohne "Hey Jarvis" weiterreden (voice.py)."""
        return self._save("listen", "gespraech", bool(on))

    def name_wake(self, on) -> dict:
        """"Jarvis" allein und andere Anreden über die zweite Prüfung (voice.py, after_name)."""
        return self._save("wakeword", "name_allein", bool(on))

    def wake_sensitive(self, on) -> dict:
        threshold = SENSITIVE_THRESHOLD if on else 0.5
        self._mic.set_threshold(threshold)
        result = self._save("wakeword", "threshold", threshold)
        result["threshold"] = threshold
        return result

    # ------------------------------------------------------------ Lokale Stimme (Standard, ohne Internet)

    def local_state(self) -> dict:
        """Ist die lokale Stimme da, läuft gerade das Einrichten, welche Stimme ist gewählt?"""
        from .localvoice import POCKET_VOICES, VOICES, installed, preview_file, voice_id

        have = installed()
        previews = STATE_DIR / "stimmen"
        busy = self._local_job is not None and self._local_job.is_alive()
        ready = have["tts"] and have["stt"] and all(preview_file(previews, v["id"]).exists() for v in POCKET_VOICES)
        tts, stt = self._cfg["tts"], self._cfg["stt"]
        return {
            "installed": have, "ready": ready and not busy, "busy": busy, "line": self._local_line,
            "error": self._local_error, "voices": VOICES, "voice": voice_id(tts.get("lokal_stimme", "")),
            "active": str(tts.get("engine", "")) == "lokal", "all_local": str(stt.get("engine", "")) == "lokal",
        }

    def local_install(self) -> dict:
        """Einmalig: Pakete installieren, Modelle laden, Hörproben schreiben (eigene Prozesse)."""
        if self._local_job is not None and self._local_job.is_alive():
            return {"ok": True, "error": ""}
        self._local_error = ""
        self._local_line = "Starte …"

        def line(text: str) -> None:
            # pip schreibt viel; für die Anzeige reichen die Zeilen, die etwas sagen
            if text.startswith(("Collecting", "Downloading", "Installing", "Successfully", "Lade", "Hörprobe",
                                "Fertig", "Fehler", "ERROR")):
                self._local_line = text[:160]

        def work() -> None:
            from .localvoice import install, installed, prepare

            if not all(installed().values()):
                ok, last = install(line)
                if not ok:
                    self._local_error = "Die Installation ging nicht. Ist das Internet an? (" + last[:200] + ")"
                    return
            ok, last = prepare(STATE_DIR / "stimmen", line)
            if not ok:
                self._local_error = "Die Modelle ließen sich nicht laden. Ist das Internet an? (" + last[:200] + ")"
                return
            self._local_line = "Fertig. Wählen Sie unten eine Stimme."

        self._local_job = threading.Thread(target=work, name="einrichtung-lokale-stimme", daemon=True)
        self._local_job.start()
        return {"ok": True, "error": ""}

    def local_preview(self, voice) -> dict:
        import wave

        import numpy as np

        from .localvoice import preview_file, voice_id
        from .tts import Player

        path = preview_file(STATE_DIR / "stimmen", str(voice))
        if voice_id(voice) == "thorsten" and not path.exists():
            from .localvoice import thorsten_preview

            if thorsten_preview(STATE_DIR / "stimmen") is None:
                return {"ok": False, "error": "Thorsten wird gerade geladen (etwa 114 MB). Gleich noch einmal tippen."}
        if not path.exists():
            return {"ok": False, "error": "Erst „Lokal einrichten“, dann gibt es Hörproben."}
        if not self._playing.acquire(blocking=False):
            return {"ok": False, "error": "Es spielt gerade schon eine Stimme."}
        try:
            with wave.open(str(path), "rb") as data:
                rate = data.getframerate()
                samples = np.frombuffer(data.readframes(data.getnframes()), dtype=np.int16)
            Player().play(samples, rate, lambda level: None)
            return {"ok": True, "error": ""}
        except Exception as exc:
            log.warning("Lokale Hörprobe: %s", exc)
            return {"ok": False, "error": "Die Hörprobe lässt sich gerade nicht abspielen."}
        finally:
            self._playing.release()

    def local_select(self, voice) -> dict:
        from .localvoice import installed, voice_id

        if voice_id(voice) == "thorsten":
            # Thorsten ist Piper (immer dabei) und braucht pocket-tts nicht. Sein Modell lädt schon mal im Hintergrund.
            from .tts import PIPER_HIGH, ensure_piper_model

            threading.Thread(target=ensure_piper_model, args=(PIPER_HIGH,), name="thorsten-laden", daemon=True).start()
        elif not installed()["tts"]:
            return {"ok": False, "error": "Die lokale Stimme ist noch nicht eingerichtet."}
        result = self._save("tts", "lokal_stimme", voice_id(voice))
        if result["ok"]:
            result = self._save("tts", "engine", "lokal")
        return result

    def local_all(self, on) -> dict:
        """Auch die Spracherkennung auf dem PC (nichts geht mehr ins Internet außer Claude)."""
        from .localvoice import installed

        if on and not installed()["stt"]:
            return {"ok": False, "error": "Die lokale Spracherkennung ist noch nicht eingerichtet."}
        return self._save("stt", "engine", "lokal" if on else "auto")

    # ------------------------------------------------------------ Premium-Stimmen (ElevenLabs)

    def _eleven(self, key: str = ""):
        from .elevenlabs import ElevenLabs

        key = str(key or "").strip() or str(self._cfg["tts"].get("elevenlabs_key", "") or "").strip()
        return ElevenLabs(key) if key else None

    @staticmethod
    def _eleven_error(exc) -> str:
        return {
            "key": "Dieser Schlüssel stimmt nicht. Bitte noch einmal kopieren (er beginnt mit sk_).",
            "quota": "Das ElevenLabs-Guthaben ist aufgebraucht. Im Konto unter Abo nachsehen.",
            "plan": "Diese Stimme gibt ElevenLabs nur mit Abo frei (ab Starter, etwa 6 $ im Monat). "
                    "Kostenlos geht eine Stimme, die du in ElevenLabs selbst entwirfst (Voice Design).",
            "permission": "Dem Schlüssel fehlen Rechte. Erstelle am besten einen neuen ohne Einschränkungen.",
            "net": "ElevenLabs ist gerade nicht erreichbar. Ist das Internet an?",
            "voice": "Diese Stimme gibt es nicht mehr.",
        }.get(getattr(exc, "kind", ""), f"ElevenLabs meldet: {exc}")

    def eleven_check(self, key="") -> dict:
        """Schlüssel prüfen und speichern, dann Kontingent und Stimmen zeigen. Mit Gratis-Konto
        gehen Bibliotheks-Stimmen nicht: Ist so eine gewählt, nimmt Jarvis eine Standard-Stimme."""
        from .elevenlabs import FREE_TIER, ElevenLabsError, pick_default_voice, usable_on_plan

        api = self._eleven(str(key or ""))
        if api is None:
            return {"ok": False, "error": "Bitte zuerst den Schlüssel einfügen."}
        sub = None
        try:
            sub = api.subscription()
        except ElevenLabsError as exc:
            if exc.kind != "permission":
                return {"ok": False, "error": self._eleven_error(exc)}
        try:
            voices = api.voices()
        except ElevenLabsError as exc:
            return {"ok": False, "error": self._eleven_error(exc)}
        if str(key or "").strip():
            saved = self._save("tts", "elevenlabs_key", str(key).strip())
            if not saved["ok"]:
                return saved
        tts = self._cfg["tts"]
        tier = str((sub or {}).get("tier", ""))
        free = tier.lower() == FREE_TIER
        self._eleven_tier = tier if sub else None
        selected = str(tts.get("elevenlabs_voice", "") or "")
        note = ""
        current = next((v for v in voices if v["voice_id"] == selected), None)
        if current is None:
            selected = (pick_default_voice(voices, free) or {}).get("voice_id", "")
        elif not usable_on_plan(current, tier):
            fallback = pick_default_voice(voices, free)
            selected = (fallback or {}).get("voice_id", "")
            if fallback and tts.get("engine") == "elevenlabs":
                switched = self.eleven_select(fallback["voice_id"], fallback["name"])
                if switched["ok"]:
                    note = (f'{current["name"]} kommt aus der Bibliothek und geht mit dem Gratis-Konto nicht. '
                            f'Jarvis spricht jetzt mit {fallback["name"]}. {current["name"]} geht ab dem Starter-Abo.')
        return {
            "ok": True, "error": "", "voices": voices, "selected": selected, "note": note,
            "active": tts.get("engine") == "elevenlabs", "free": free,
            "tier": tier, "used": (sub or {}).get("used", 0), "limit": (sub or {}).get("limit", 0),
        }

    def eleven_library(self, gender="male") -> dict:
        """Deutsche Stimmen aus der ElevenLabs-Bibliothek."""
        from .elevenlabs import ElevenLabsError

        api = self._eleven()
        if api is None:
            return {"ok": False, "error": "Erst den Schlüssel prüfen.", "voices": []}
        try:
            return {"ok": True, "error": "", "voices": api.library(gender=str(gender or ""))}
        except ElevenLabsError as exc:
            return {"ok": False, "error": self._eleven_error(exc), "voices": []}

    def eleven_add(self, public_owner_id, voice_id, name) -> dict:
        """Eine Bibliotheks-Stimme ins eigene Konto holen und gleich nehmen (erst ab Starter-Abo)."""
        from .elevenlabs import FREE_TIER, ElevenLabsError

        api = self._eleven()
        if api is None:
            return {"ok": False, "error": "Erst den Schlüssel prüfen."}
        if self._eleven_free(api):
            return {"ok": False, "error": self._eleven_error(ElevenLabsError("plan", "Gratis-Konto"))}
        try:
            new_id = api.add_shared(str(public_owner_id), str(voice_id), str(name))
        except ElevenLabsError as exc:
            return {"ok": False, "error": self._eleven_error(exc)}
        return self.eleven_select(new_id, name)

    def _eleven_free(self, api) -> bool:
        """Ist das ElevenLabs-Konto ein Gratis-Konto? Unbekannt (Schlüssel ohne Leserecht) gilt als nein."""
        from .elevenlabs import FREE_TIER, ElevenLabsError

        if self._eleven_tier is None:
            try:
                self._eleven_tier = api.subscription()["tier"]
            except ElevenLabsError:
                return False
        return self._eleven_tier.lower() == FREE_TIER

    def _eleven_plan_error(self, api, voice_id: str):
        """Darf das Konto diese Stimme nutzen? Ein Wort zur Probe (kostet 3 Credits). Gibt den
        Fehler zurück, wenn die Stimme ein Abo braucht, sonst None (andere Fehler zählen hier nicht)."""
        from .elevenlabs import DEFAULT_MODEL, FALLBACK_MODEL, ElevenLabsError

        model = str(self._cfg["tts"].get("elevenlabs_model", "") or DEFAULT_MODEL)
        try:
            try:
                api.speak("Ja.", voice_id, model)
            except ElevenLabsError as exc:
                if exc.kind not in ("model", "param"):
                    raise
                api.speak("Ja.", voice_id, FALLBACK_MODEL, plain=True)
        except ElevenLabsError as exc:
            return exc if exc.kind == "plan" else None
        return None

    def eleven_select(self, voice_id, name="") -> dict:
        """Stimme nehmen. Mit Gratis-Konto erst kurz prüfen, ob ElevenLabs sie herausgibt:
        Viele fertige Stimmen gehen erst ab Starter, auch wenn sie im Konto stehen."""
        voice_id, name = str(voice_id or "").strip(), str(name or "").strip()
        if not voice_id:
            return {"ok": False, "error": "Keine Stimme gewählt."}
        api = self._eleven()
        if api is not None and self._eleven_free(api):
            problem = self._eleven_plan_error(api, voice_id)
            if problem is not None:
                return {"ok": False, "locked": True, "error": self._eleven_error(problem)}
        for section, key, value in (("tts", "elevenlabs_voice", voice_id), ("tts", "elevenlabs_voice_name", name),
                                    ("tts", "engine", "elevenlabs")):
            result = self._save(section, key, value)
            if not result["ok"]:
                return result
        return {"ok": True, "error": "", "voice_id": voice_id, "name": name}

    def eleven_preview(self, voice_id) -> dict:
        """Spielt den Begrüßungssatz mit einer ElevenLabs-Stimme (kostet etwa 60 Zeichen Guthaben)."""
        import numpy as np

        from .elevenlabs import DEFAULT_MODEL, FALLBACK_MODEL, RATE, ElevenLabsError
        from .tts import Player, trim_silence

        api = self._eleven()
        if api is None:
            return {"ok": False, "error": "Erst den Schlüssel prüfen."}
        if not self._playing.acquire(blocking=False):
            return {"ok": False, "error": "Es spielt gerade schon eine Stimme."}
        try:
            model = str(self._cfg["tts"].get("elevenlabs_model", "") or DEFAULT_MODEL)
            try:
                pcm = api.speak(PREVIEW_TEXT, str(voice_id), model)
            except ElevenLabsError as exc:
                if exc.kind not in ("model", "param"):
                    raise
                pcm = api.speak(PREVIEW_TEXT, str(voice_id), FALLBACK_MODEL, plain=True)
            samples = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype=np.int16)
            Player().play(trim_silence(samples, RATE), RATE, lambda level: None)
            return {"ok": True, "error": ""}
        except ElevenLabsError as exc:
            return {"ok": False, "error": self._eleven_error(exc)}
        except Exception as exc:
            log.warning("ElevenLabs-Hörprobe: %s", exc)
            return {"ok": False, "error": "Die Hörprobe ließ sich nicht abspielen."}
        finally:
            self._playing.release()

    # ------------------------------------------------------------ Links

    ALLOWED_LINKS = ("https://elevenlabs.io/", "https://console.groq.com/", "https://claude.ai/", "https://console.picovoice.ai/")

    def open_url(self, url) -> bool:
        """Öffnet eine der Anmelde-Seiten im Browser (nur diese, nichts anderes)."""
        url = str(url or "")
        if not url.startswith(self.ALLOWED_LINKS):
            return False
        import webbrowser

        return bool(webbrowser.open(url))

    # ------------------------------------------------------------ Spracherkennung (Groq)

    def groq_check(self, key) -> dict:
        from .stt import check_groq_key

        key = str(key or "").strip()
        ok, error = check_groq_key(key)
        if not ok:
            return {"ok": False, "error": error}
        return self._save("stt", "groq_key", key)

    def picovoice_check(self, key) -> dict:
        """Schlüssel für "Jarvis" ohne Hey prüfen und speichern; der Mikrofon-Test nutzt ihn sofort."""
        from .audio import picovoice_problem

        key = str(key or "").strip()
        if not key:
            return {"ok": False, "error": "Bitte zuerst den Schlüssel einfügen."}
        problem = picovoice_problem(key)
        if problem:
            return {"ok": False, "error": problem}
        saved = self._save("wakeword", "picovoice_key", key)
        if saved["ok"]:
            self._mic.reload()
        return saved

    def picovoice_remove(self) -> dict:
        saved = self._save("wakeword", "picovoice_key", "")
        if saved["ok"]:
            self._mic.reload()
        return saved

    def groq_remove(self) -> dict:
        return self._save("stt", "groq_key", "")

    # ------------------------------------------------------------ Wohnort

    def place_check(self, text) -> dict:
        from .weather import Weather

        text = str(text or "").strip()
        if not text:
            return {"ok": False, "place": "", "temp": None, "text": "", "error": "Bitte einen Ort eintragen."}
        try:
            now = Weather(text).current()
            return {"ok": True, "place": now["place"], "temp": now["temp"], "text": now["text"], "error": ""}
        except LookupError:
            return {"ok": False, "place": "", "temp": None, "text": "", "error": f'"{text}" kenne ich leider nicht. Vielleicht mit Land, z. B. "Wien, Österreich"?'}
        except Exception as exc:
            log.warning("Wetter: %s", exc)
            return {"ok": False, "place": "", "temp": None, "text": "", "error": "Das Wetter ist gerade nicht erreichbar. Der Ort wird trotzdem gespeichert."}

    def place_save(self, text) -> dict:
        return self._save("ich", "ort", str(text or "").strip())

    def name_save(self, text) -> dict:
        """Wie der Nutzer heißt ([ich] name). Leer = Georg. Jarvis sagt trotzdem "Sir"."""
        from .config import user_name

        name = str(text or "").strip()
        if name and user_name({"ich": {"name": name}}) != name:
            return {"ok": False, "error": "Bitte nur den Vornamen, ohne Leerzeichen und Sonderzeichen."}
        return self._save("ich", "name", name)

    # ------------------------------------------------------------ Claude

    def claude_check(self) -> dict:
        return self._claude.start()

    def claude_poll(self) -> dict:
        return self._claude.poll()

    def claude_install(self) -> dict:
        """Öffnet ein PowerShell-Fenster mit dem offiziellen Installer von Claude Code."""
        if os.name != "nt":
            return {"ok": False, "error": "Das geht nur unter Windows."}
        script = (
            "Write-Host 'Claude Code wird installiert ...' -ForegroundColor Cyan; "
            "irm https://claude.ai/install.ps1 | iex; "
            "Write-Host ''; Write-Host 'Fertig. Dieses Fenster kannst du schliessen und im Assistenten auf Nochmal pruefen klicken.' -ForegroundColor Green; "
            "Read-Host 'Enter zum Schliessen'"
        )
        try:
            subprocess.Popen(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                creationflags=NEW_CONSOLE, env=windows_powershell_env(os.environ),
            )
            return {"ok": True, "error": ""}
        except Exception as exc:
            return {"ok": False, "error": f"PowerShell ließ sich nicht öffnen: {exc}"}

    def claude_login(self) -> dict:
        """Öffnet Claude Code in einem Konsolenfenster, dort meldet man sich einmal an."""
        from .brain import find_claude

        path = find_claude(self._cfg["brain"])
        if not path:
            return {"ok": False, "error": "Claude Code ist noch nicht installiert."}
        if os.name != "nt":
            return {"ok": False, "error": "Das geht nur unter Windows."}
        try:
            subprocess.Popen(["cmd", "/k", path], cwd=str(Path.home()), creationflags=NEW_CONSOLE)
            return {"ok": True, "error": ""}
        except Exception as exc:
            return {"ok": False, "error": f"Claude ließ sich nicht öffnen: {exc}"}

    # ------------------------------------------------------------ Extras

    def hotkeys(self) -> list:
        return HOTKEYS

    def hotkey_save(self, hotkey) -> dict:
        return self._save("mute", "hotkey", str(hotkey))

    def brain_speed(self, value) -> dict:
        """Modellwahl: "auto" (Jarvis wählt pro Aufgabe), "schnell" (immer Sonnet mit wenig Nachdenken)
        oder "gruendlich" (immer Opus mit viel Nachdenken). "ausgewogen" von früher heißt jetzt "auto"."""
        key = str(value or "").strip().lower().replace("ü", "ue")
        key = "auto" if key == "ausgewogen" else key
        if key not in MODES:
            return {"ok": False, "error": "Unbekannte Auswahl.", "speed": ""}
        result = self._save("brain", "modellwahl", key, extra={"speed": key})
        if result["ok"]:
            _forget_brain_state()
        return result

    def permission_set(self, on) -> dict:
        """Volle Freigabe an oder aus ([rechte] volle_freigabe)."""
        return self._save("rechte", "volle_freigabe", bool(on))

    def autostart_set(self, on) -> dict:
        from . import autostart

        try:
            if on:
                autostart.enable()
            else:
                autostart.disable()
            return {"ok": True, "enabled": autostart.enabled(), "error": ""}
        except Exception as exc:
            return {"ok": False, "enabled": autostart.enabled(), "error": str(exc)}

    def ha_check(self, url, token) -> dict:
        from .homeassistant import HomeAssistant

        url = _ha_url(url)
        token = str(token or "").strip() or self._cfg.get("homeassistant", {}).get("token", "")
        if not url:
            return {"ok": False, "message": "Bitte die Adresse von Home Assistant eintragen.", "echos": []}
        if not token:
            return {"ok": False, "message": "Bitte auch den Token eintragen (Home Assistant: Profil > Sicherheit > Langlebige Zugriffstoken).", "echos": []}
        ha = HomeAssistant({"url": url, "token": token})
        try:
            ha.ping()
            echos = [
                {"entity": entity, "name": name or entity}
                for entity, name, _state in ha.devices()
                if entity.startswith("media_player.") and ("echo" in entity or "alexa" in (entity + name).lower())
            ]
            message = f"Verbunden. {len(echos)} Echo-Gerät(e) gefunden." if echos else "Verbunden, aber keine Echo-Geräte gefunden (Alexa Media Player installiert?)."
            return {"ok": True, "message": message, "echos": echos}
        except Exception as exc:
            return {"ok": False, "message": str(exc), "echos": []}

    def ha_save(self, url, token, echos=None) -> dict:
        from .homeassistant import _fold

        try:
            save_setting("homeassistant", "url", _ha_url(url))
            if str(token or "").strip():
                save_setting("homeassistant", "token", str(token).strip())
            for echo in echos or []:
                room = _fold(str(echo.get("room", "")))
                room = "".join(c for c in room if c.isascii() and (c.isalnum() or c in "_-"))
                entity = str(echo.get("entity", "")).strip()
                if room and entity:
                    save_setting("homeassistant.alexa", room, entity)
            self._reload()
            return {"ok": True, "error": ""}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------ Ende

    def finish(self, start_now=True) -> dict:
        self._mic.stop()
        try:
            mark_done()
        except OSError as exc:
            log.warning("Einrichtung: %s", exc)
        self.finished = {"start": bool(start_now)}
        window = self._window_ref[0] if self._window_ref else None
        if window is not None:
            threading.Timer(0.3, window.destroy).start()
        return {"ok": True}

    # ------------------------------------------------------------ intern

    def _save(self, section: str, key: str, value, extra: dict | None = None) -> dict:
        try:
            save_setting(section, key, value)
            self._reload()
            return {"ok": True, "error": "", **(extra or {})}
        except Exception as exc:
            log.warning("Speichern %s.%s: %s", section, key, exc)
            return {"ok": False, "error": f"Konnte nicht speichern: {exc}", **(extra or {})}

    def _reload(self) -> None:
        try:
            self._cfg = load_config()
        except Exception as exc:
            log.warning("config.toml: %s", exc)


def run_setup(cfg: dict, start_after: bool = True) -> int:
    """Öffnet den Assistenten. Danach startet (falls gewünscht) Jarvis als neuer Prozess."""
    from .gui.app import WEB_DIR, place_on_screen, webview_available

    ok, reason = webview_available()
    if not ok:
        return run_console_setup(reason)
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text((ROOT / "config.example.toml").read_text(encoding="utf-8"), encoding="utf-8")

    import webview

    window_ref: list = []
    api = SetupApi(cfg, window_ref)
    place = place_on_screen(1000, 720)
    width, height = place["width"], place["height"]
    window = webview.create_window(
        "Jarvis einrichten",
        url=str(WEB_DIR / "setup.html"),
        js_api=api,
        width=width,
        height=height,
        x=place["x"],
        y=place["y"],
        min_size=(min(800, width), min(600, height)),
        background_color="#0f1115",
    )
    window_ref.append(window)

    def dark_title_bar() -> None:
        # Dunkle Titelleiste wie die Seite (base.css --bg), auch wenn Windows auf "hell" steht.
        from .desktop import style_title_bar

        style_title_bar("Jarvis einrichten", "#0f1115")

    try:
        window.events.before_show += dark_title_bar
    except AttributeError:
        pass  # ältere pywebview-Version ohne dieses Ereignis
    try:
        webview.start()
    finally:
        api._mic.stop()
    if not start_after:
        return 0
    if api.finished is not None:
        start = bool(api.finished.get("start"))
    else:
        # Einfach zugemacht: Wurde die Einrichtung schon einmal abgeschlossen (z. B. über
        # die Einstellungen geöffnet), geht es zurück zu Jarvis. Beim ersten Mal nicht.
        start = setup_done()
    if start and not jarvis_running(wait=5.0):
        launch()
    return 0


def jarvis_running(wait: float = 0.0) -> bool:
    """Läuft Jarvis gerade? Nach dem Öffnen der Einstellungen beendet sich der alte Jarvis erst, darum
    bis zu `wait` Sekunden warten."""
    end = time.monotonic() + wait
    while True:
        if not _instance_exists():
            return False
        if time.monotonic() >= end:
            return True
        time.sleep(0.25)


def _instance_exists(name: str = "JarvisSprachassistent") -> bool:
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenMutexW.restype = ctypes.c_void_p
            kernel32.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel32.OpenMutexW(0x00100000, False, "Local\\" + name)  # SYNCHRONIZE
            if handle:
                kernel32.CloseHandle(handle)
                return True
        except Exception as exc:
            log.debug("Mutex: %s", exc)
        return False
    try:
        import fcntl

        with open(STATE_DIR / f"{name.lower()}.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
        return False
    except BlockingIOError:
        return True
    except OSError:
        return False


def run_console_setup(reason: str) -> int:
    """Ohne Fenster (WebView2 fehlt): das Nötigste in der Konsole."""
    from . import mic_setup

    if sys.stdin is None:
        # Gestartet ohne Konsole (Doppelklick): Meldung als kleines Fenster.
        if "WebView2" in reason:
            text = (
                "Für das Jarvis-Fenster fehlt Microsoft Edge WebView2.\n\n"
                "Download: https://developer.microsoft.com/microsoft-edge/webview2/ "
                "(dort den Evergreen Bootstrapper). Danach Jarvis noch einmal starten."
            )
        else:
            text = f"Das Einrichtungsfenster geht nicht ({reason}).\n\nBitte werkzeuge\\Neu-installieren.bat starten."
        log.warning("Einrichtung: %s", reason)
        popup(text)
        return 1
    print(f"Das Einrichtungsfenster geht gerade nicht ({reason}). Wir machen es kurz hier.\n")
    try:
        mic_setup.run()
        place = input("\nDein Wohnort für das Wetter (Enter = überspringen): ").strip()
        if place:
            save_setting("ich", "ort", place)
        mark_done()
    except (KeyboardInterrupt, EOFError):
        print()
    return 0
