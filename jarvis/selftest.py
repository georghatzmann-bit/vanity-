"""`werkzeuge\\Selbsttest.bat`: prüft alles, was Jarvis braucht, und sagt auf Deutsch, was zu tun ist."""

from __future__ import annotations

import datetime as dt
import importlib
import os
import platform
import subprocess
import sys
import time
from dataclasses import dataclass

from .config import CONFIG_PATH, HOME_DIR, LOG_DIR, ROOT, STATE_DIR

LABELS = {"ok": "[ OK ]  ", "warnung": "[WARN]  ", "fehler": "[FEHLER]"}


@dataclass
class Check:
    name: str
    status: str  # ok, warnung, fehler
    detail: str = ""
    hint: str = ""


class Report:
    def __init__(self, out=print) -> None:
        self.checks: list[Check] = []
        self._out = out

    def add(self, name: str, status: str, detail: str = "", hint: str = "") -> Check:
        check = Check(name, status, detail, hint)
        self.checks.append(check)
        line = f"{LABELS[status]} {name}"
        if detail:
            line += f": {detail}"
        self._out(line)
        if hint and status != "ok":
            self._out(f"          -> {hint}")
        return check

    def run(self, name: str, func, *args) -> None:
        """Führt eine Prüfung aus und fängt jeden Absturz als Fehler ab."""
        try:
            func(self, *args)
        except Exception as exc:
            self.add(name, "fehler", f"{type(exc).__name__}: {exc}")

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if c.status == "fehler"]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.status == "warnung"]

    def text(self) -> str:
        lines = []
        for c in self.checks:
            line = f"{LABELS[c.status]} {c.name}"
            if c.detail:
                line += f": {c.detail}"
            lines.append(line)
            if c.hint and c.status != "ok":
                lines.append(f"          -> {c.hint}")
        return "\n".join(lines)


REQUIRED = {
    "numpy": "numpy",
    "sounddevice": "sounddevice",
    "openwakeword": "openwakeword",
    "onnxruntime": "onnxruntime",
    "faster_whisper": "faster-whisper",
}
OPTIONAL = {
    "pocket_tts": ("pocket-tts", "Jarvis' lokale Stimme"),
    "onnx_asr": ("onnx-asr", "lokale Spracherkennung (Parakeet)"),
    "piper": ("piper-tts", "lokale Reservestimme"),
    "keyboard": ("keyboard", "Tastenkürzel zum Stummschalten und Musiktasten"),
    "webview": ("pywebview", "Jarvis-Fenster"),
    "psutil": ("psutil", "CPU- und RAM-Anzeige"),
    "pystray": ("pystray", "Tray-Icon"),
    "PIL": ("pillow", "Tray-Icon und Bildschirmfotos"),
    "send2trash": ("Send2Trash", "Papierkorb statt Löschen"),
}


def check_python(r: Report) -> None:
    version = platform.python_version()
    if sys.version_info >= (3, 11):
        r.add("Python", "ok", version)
    else:
        r.add("Python", "fehler", version, "Python 3.11 bis 3.14 installieren und werkzeuge\\Neu-installieren.bat starten.")


def check_packages(r: Report) -> None:
    missing = []
    for module, package in REQUIRED.items():
        try:
            importlib.import_module(module)
        except Exception as exc:
            missing.append(f"{package} ({type(exc).__name__})")
    if missing:
        r.add("Pakete", "fehler", "fehlen: " + ", ".join(missing), "werkzeuge\\Neu-installieren.bat starten.")
    else:
        r.add("Pakete", "ok", "alle wichtigen Pakete da")
    for module, (package, purpose) in OPTIONAL.items():
        try:
            importlib.import_module(module)
        except Exception as exc:
            r.add(f"Zusatzpaket {package}", "warnung", f"fehlt ({type(exc).__name__}), gebraucht für: {purpose}", "werkzeuge\\Neu-installieren.bat starten.")


def check_config(r: Report, cfg: dict) -> None:
    if not CONFIG_PATH.exists():
        r.add("config.toml", "warnung", "fehlt, Jarvis nutzt die Standardwerte", "Die Einrichtung (Einstellungen im Jarvis-Fenster) legt sie an.")
    else:
        r.add("config.toml", "ok", "lesbar")
    threshold = cfg["wakeword"]["threshold"]
    if not 0.05 <= float(threshold) <= 0.95:
        r.add("Wake-Word-Schwelle", "warnung", f"{threshold} ist ungewöhnlich", "Werte zwischen 0.3 und 0.6 sind üblich.")
    if not cfg["brain"].get("models"):
        r.add("Claude-Modelle", "warnung", "keine Modelle eingetragen", 'In config.toml unter [brain] models = ["sonnet", "haiku", "opus"] setzen.')


def check_folder(r: Report) -> None:
    path = str(ROOT)
    detail = path
    try:
        for folder in (LOG_DIR, STATE_DIR):
            folder.mkdir(parents=True, exist_ok=True)
            probe = folder / ".schreibtest"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
    except OSError as exc:
        r.add("Jarvis-Ordner", "fehler", f"nicht beschreibbar ({exc})", "Jarvis in einen normalen Ordner wie C:\\Jarvis legen.")
        return
    parts = [p.lower() for p in ROOT.parts]
    if ".claude" in parts:
        r.add(
            "Jarvis-Ordner", "warnung", detail,
            'Liegt in einem Ordner namens ".claude". Claude Code behandelt solche Ordner besonders. '
            "Besser einen eigenen Ordner wie C:\\Jarvis nehmen (ANLEITUNG.md, Schritt 1).",
        )
    elif "onedrive" in path.lower():
        r.add(
            "Jarvis-Ordner", "warnung", detail,
            "Liegt in OneDrive. Das geht, OneDrive synchronisiert dann aber Logdateien und Erinnerungen "
            "ständig mit. Ein eigener Ordner wie C:\\Jarvis ist ruhiger.",
        )
    else:
        r.add("Jarvis-Ordner", "ok", detail)
    if ".venv" in sys.executable.replace("\\", "/").split("/") and os.name == "nt":
        r.add(
            "Python-Umgebung", "warnung", sys.executable,
            "Die alte Umgebung im Jarvis-Ordner läuft noch. Jarvis.bat starten, "
            "dann zieht sie nach %LOCALAPPDATA%\\Jarvis um.",
        )


def check_speakers(r: Report, play_sound: bool) -> None:
    import sounddevice as sd

    try:
        info = sd.query_devices(kind="output")
    except Exception:
        r.add("Lautsprecher", "fehler", "Windows meldet keinen Standard-Lautsprecher", "Lautsprecher oder Kopfhörer anschließen und in Windows als Standard wählen.")
        return
    if play_sound:
        from .tts import chime

        chime((660, 880, 1320))
    r.add("Lautsprecher", "ok", info["name"])


def check_voice(r: Report, cfg: dict) -> None:
    """Spricht Jarvis mit seiner lokalen Stimme? (Eine Windows- oder Microsoft-Stimme gibt es nicht mehr.)"""
    from .localvoice import installed
    from .tts import TextToSpeech, materialize

    if not installed()["tts"]:
        r.add("Jarvis-Stimme", "warnung", "die lokale Stimme ist nicht eingerichtet, Jarvis spricht mit der Reservestimme",
              "Einrichtung > Stimme > Lokal > „Lokal einrichten“ klicken (oder werkzeuge\\Neu-installieren.bat).")
        return
    try:
        started = time.monotonic()
        speech = TextToSpeech(dict(cfg["tts"], engine="lokal"))
        samples, rate = speech.synthesize("Selbsttest")
        samples = materialize(samples)
        if not speech.used_main:
            raise RuntimeError("nur die Reservestimme hat geantwortet")
        r.add("Jarvis-Stimme", "ok", f"lokal ({len(samples) / rate:.1f} s Testsatz, {time.monotonic() - started:.0f} s mit Laden)")
    except Exception as exc:
        r.add("Jarvis-Stimme", "warnung", f"die lokale Stimme spricht nicht ({exc})",
              "Einrichtung > Stimme > Lokal > „Nochmal versuchen“ (lädt die Stimme neu).")


def check_microphone(r: Report, cfg: dict, seconds: float) -> None:
    from .audio import Microphone, friendly_device_error, rms

    spec = cfg["audio"]["input_device"]
    try:
        mic = Microphone(spec)
    except Exception as exc:
        detail = friendly_device_error(exc)
        r.add("Mikrofon", "fehler", detail, "Mikrofon anschließen, dann in der Einrichtung (werkzeuge\\Einrichtung.bat) auswählen.")
        return
    loudest = 0.0
    with mic:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            loudest = max(loudest, rms(mic.read()))
    name = f"{mic.name} ({mic.rate} Hz)"
    if mic.peak == 0:
        r.add(
            "Mikrofon", "fehler", f"{name}: absolute Stille",
            'Windows-Einstellungen > Datenschutz und Sicherheit > Mikrofon > "Desktop-Apps den Zugriff erlauben" '
            "einschalten, oder in der Einrichtung ein anderes wählen.",
        )
    elif loudest < 150:
        r.add("Mikrofon", "warnung", f"{name}: sehr leise (Pegel {loudest:.0f})", "Während des Tests sprechen. Bleibt es leise, in der Einrichtung ein anderes wählen.")
    else:
        r.add("Mikrofon", "ok", f"{name}, Pegel bis {loudest:.0f}")


def load_models(r: Report, cfg: dict):
    wake = stt = None
    try:
        from .audio import WakeWord

        wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"], cfg["wakeword"].get("picovoice_key", ""))
        r.add("Wake Word", "ok", f"{cfg['wakeword']['model']}, Schwelle {cfg['wakeword']['threshold']}")
    except Exception as exc:
        r.add("Wake Word", "fehler", f"Modell lädt nicht ({exc})", "Internet prüfen und werkzeuge\\Neu-installieren.bat starten.")
    try:
        from .stt import SpeechToText

        started = time.monotonic()
        stt = SpeechToText(
            cfg["stt"]["model"], cfg["stt"]["language"], cfg["stt"]["device"], cfg["stt"].get("beam_size", 1)
        )
        r.add("Spracherkennung", "ok", f"Whisper {cfg['stt']['model']} auf {cfg['stt']['device']} ({time.monotonic() - started:.0f} s)")
    except Exception as exc:
        hint = "Internet prüfen (beim ersten Mal lädt Whisper etwa 500 MB)."
        if cfg["stt"]["device"] != "cpu":
            hint = 'In config.toml unter [stt] device = "cpu" setzen.'
        r.add("Spracherkennung", "fehler", str(exc), hint)
    return wake, stt


def check_chain(r: Report, cfg: dict, wake, stt) -> None:
    from .assistant import Assistant
    from .simulate import run_chain
    from .tts import TextToSpeech

    if wake is None or stt is None:
        r.add("Ganze Kette", "warnung", "übersprungen, weil ein Modell fehlt")
        return
    assistant = Assistant(cfg, brain=None, speaker=None, ui=_SilentUi())
    tts = TextToSpeech(cfg["tts"])
    steps = run_chain(cfg, wake, stt, lambda text: assistant.handle(text, speak=False), tts.synthesize)
    for step in steps:
        r.add(f"Kette: {step.name}", "ok" if step.ok else "fehler", step.detail)


class _SilentUi:
    def __getattr__(self, _name):
        return lambda *a, **k: None


def check_claude(r: Report, cfg: dict) -> None:
    from .brain import BrainError, ClaudeBrain

    from .brain import find_claude

    path = find_claude(cfg["brain"])
    if not path:
        r.add("Claude Code", "fehler", "nicht gefunden", "In PowerShell: irm https://claude.ai/install.ps1 | iex, danach einmal claude starten und anmelden.")
        return
    try:
        version = subprocess.run(
            [path, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL,
            timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
    except Exception as exc:
        version = f"Version unbekannt ({exc})"
    r.add("Claude Code", "ok", f"{version} ({path})")

    brain = ClaudeBrain(cfg["brain"], HOME_DIR, STATE_DIR)
    notes: list[str] = []
    brain.notice = notes.append
    started = time.monotonic()
    try:
        answer = brain.ask("Antworte nur mit: Test bestanden.")
    except BrainError as exc:
        hint = {
            "refusal": "werkzeuge\\Claude-Test.bat zeigt, welches Modell ablehnt. Ergebnis an Claude im Jarvis-Projekt schicken.",
            "login": "In der Eingabeaufforderung claude starten und mit dem Pro-Konto anmelden.",
            "limit": "Das Pro-Kontingent ist aufgebraucht, es füllt sich nach ein paar Stunden wieder auf.",
            "network": "Internet prüfen.",
            "account": "Auf claude.ai anmelden und nachsehen, was das Konto meldet.",
            "billing": "Claude Code nutzt einen API-Schlüssel. In der Eingabeaufforderung: claude, dann /login und das Pro-Konto wählen.",
            "model": "In config.toml unter [brain] models andere Modelle eintragen, z. B. [\"haiku\"].",
        }.get(exc.kind, "Claudes eigene Meldung steht links. Details stehen in logs/jarvis.log.")
        r.add("Claude antwortet", "fehler", f"{exc.kind}: {str(exc)[:200]}", hint)
        return
    mode = brain.attempt.label()
    detail = f'"{answer.text[:60]}" von {answer.model} in {time.monotonic() - started:.0f} s'
    if notes or brain.attempt.profile != "jarvis":
        r.add("Claude antwortet", "warnung", detail + f" (erst mit: {mode})", "Die ersten Versuche wurden abgelehnt. Jarvis nutzt jetzt automatisch den, der geht.")
    else:
        r.add("Claude antwortet", "ok", detail)


def check_gui(r: Report) -> None:
    from .gui.app import webview_available

    ok, reason = webview_available()
    if ok:
        r.add("Oberfläche", "ok", "Jarvis-Fenster startklar")
    else:
        hint = "werkzeuge\\Neu-installieren.bat starten."
        if "WebView2" in reason:
            hint = "Microsoft Edge WebView2 Runtime installieren: https://developer.microsoft.com/microsoft-edge/webview2/"
        r.add("Oberfläche", "warnung", f"{reason}, Jarvis läuft dann nur im Konsolenfenster", hint)


def check_hotkey(r: Report, cfg: dict) -> None:
    combo = cfg["mute"]["hotkey"]
    if not combo:
        r.add("Stumm-Taste", "warnung", "keine eingetragen")
        return
    if os.name == "nt":
        from .mute import parse_hotkey

        if parse_hotkey(combo):
            r.add("Stumm-Taste", "ok", combo.upper())
            return
    try:
        import keyboard

        keyboard.parse_hotkey(combo)
        r.add("Stumm-Taste", "ok", combo.upper())
    except Exception as exc:
        r.add("Stumm-Taste", "warnung", f"{combo} geht nicht ({exc})", 'In config.toml unter [mute] z. B. hotkey = "f9" eintragen.')


def check_homeassistant(r: Report, cfg: dict) -> None:
    from .homeassistant import HomeAssistant

    ha = HomeAssistant(cfg.get("homeassistant", {}))
    if not ha.configured:
        r.add("Home Assistant / Alexa", "ok", "nicht eingerichtet (optional, siehe ANLEITUNG.md)")
        return
    try:
        r.add("Home Assistant / Alexa", "ok", f"{ha.url} antwortet ({ha.ping()}), {len(ha.alexa)} Echo-Geräte eingetragen")
    except Exception as exc:
        r.add("Home Assistant / Alexa", "fehler", str(exc), "url und token unter [homeassistant] in config.toml prüfen.")
    server = cfg.get("server", {})
    if server.get("enabled") and len(server.get("token", "")) < 12:
        r.add("Web-Eingang", "fehler", "token zu kurz", "Unter [server] ein token mit mindestens 12 Zeichen eintragen.")


def check_connectors(r: Report, cfg: dict) -> None:
    """Georgs Konnektoren von claude.ai (Gmail, Google Kalender, Shopify ...): Termine, Mails und Shop laufen
    darüber. Optional, deshalb nie ein Fehler."""
    from . import konnektoren
    from .brain import find_claude

    if not (cfg.get("brain") or {}).get("konnektoren", True):
        r.add("Konnektoren", "ok", "abgeschaltet ([brain] konnektoren = false)")
        return
    claude = find_claude(cfg.get("brain") or {})
    if not claude:
        r.add("Konnektoren", "ok", "Claude Code fehlt (siehe oben)")
        return
    found = konnektoren.listed(claude)
    if found is None:
        r.add("Konnektoren", "warnung", "Claude Code hat nicht geantwortet", "Später noch einmal versuchen.")
    elif not found:
        r.add("Konnektoren", "ok", "keine (optional: auf claude.ai unter Einstellungen > Konnektoren Gmail, Google "
              "Kalender oder Shopify verbinden, dann einmal in der Eingabeaufforderung claude starten und /login)")
    else:
        names = ", ".join(c["name"] + ("" if c["ok"] else " (nicht verbunden)") for c in found[:12])
        r.add("Konnektoren", "ok", names)


def check_autostart(r: Report) -> None:
    if os.name != "nt":
        return
    from . import autostart

    r.add("Autostart", "ok", "an" if autostart.enabled() else "aus (einschalten in der Einrichtung)")


def run(cfg: dict, quick: bool = False, out=print) -> Report:
    r = Report(out)
    out(f"Jarvis-Selbsttest, {dt.datetime.now():%d.%m.%Y %H:%M}, {platform.platform()}\n")
    r.run("Python", check_python)
    r.run("Pakete", check_packages)
    r.run("config.toml", check_config, cfg)
    r.run("Jarvis-Ordner", check_folder)
    r.run("Lautsprecher", check_speakers, not quick)
    r.run("Jarvis-Stimme", check_voice, cfg)
    if not quick:
        out("\nSprich jetzt 3 Sekunden lang etwas ins Mikrofon ...")
    r.run("Mikrofon", check_microphone, cfg, 1.0 if quick else 3.0)
    out("\nLade Wake Word und Spracherkennung (beim ersten Mal dauert das) ...")
    wake, stt = None, None
    try:
        wake, stt = load_models(r, cfg)
    except Exception as exc:
        r.add("Modelle", "fehler", str(exc))
    out("\nSpiele die ganze Kette mit einer Computerstimme durch ...")
    r.run("Ganze Kette", check_chain, cfg, wake, stt)
    out("\nFrage Claude, ob er antwortet ...")
    r.run("Claude", check_claude, cfg)
    r.run("Oberfläche", check_gui)
    r.run("Stumm-Taste", check_hotkey, cfg)
    r.run("Home Assistant", check_homeassistant, cfg)
    r.run("Konnektoren", check_connectors, cfg)
    r.run("Autostart", check_autostart)

    out("")
    if r.failed:
        out(f"{len(r.failed)} Problem(e) gefunden. Die Hinweise mit -> sagen, was zu tun ist.")
    elif r.warnings:
        out(f"Jarvis ist startklar, mit {len(r.warnings)} Hinweis(en).")
    else:
        out("Alles bereit. Starte Jarvis mit dem Symbol auf dem Desktop oder Jarvis.bat.")
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        (LOG_DIR / "selbsttest.txt").write_text(r.text() + "\n", encoding="utf-8")
        out(f"Das Ergebnis steht auch in {LOG_DIR / 'selbsttest.txt'}.")
    except OSError:
        pass
    return r

