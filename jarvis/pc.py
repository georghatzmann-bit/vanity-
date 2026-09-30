"""Kleine PC-Aktionen unter Windows: Medientasten, Lautstärke, Bildschirmfoto,
Gaming-Modus, Papierkorb und Programme installieren."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

MEDIA_KEYS = {
    "pause": "play/pause media",
    "play": "play/pause media",
    "weiter": "play/pause media",
    "naechstes": "next track",
    "nächstes": "next track",
    "voriges": "previous track",
    "zurueck": "previous track",
    "zurück": "previous track",
    "stopp": "stop media",
}

# Virtuelle Tastencodes, falls die keyboard-Bibliothek nicht geht.
_VK = {
    "play/pause media": 0xB3,
    "next track": 0xB0,
    "previous track": 0xB1,
    "stop media": 0xB2,
    "volume up": 0xAF,
    "volume down": 0xAE,
    "volume mute": 0xAD,
}


class PcError(RuntimeError):
    pass


def press(key: str, times: int = 1) -> None:
    """Drückt eine Medientaste (z. B. "volume up")."""
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    try:
        import keyboard

        for _ in range(times):
            keyboard.send(key)
        return
    except Exception as exc:
        log.debug("keyboard.send(%s) ging nicht (%s), nutze Windows direkt.", key, exc)
    import ctypes

    code = _VK[key]
    for _ in range(times):
        ctypes.windll.user32.keybd_event(code, 0, 0, 0)
        ctypes.windll.user32.keybd_event(code, 0, 2, 0)


def media(action: str) -> str:
    key = MEDIA_KEYS.get(action.lower())
    if not key:
        raise PcError(f"Unbekannte Medienaktion: {action}. Möglich: pause, weiter, naechstes, voriges.")
    press(key)
    return {
        "next track": "Nächster Titel.",
        "previous track": "Voriger Titel.",
        "stop media": "Wiedergabe gestoppt.",
    }.get(key, "Wiedergabe umgeschaltet.")


def volume(direction: str, steps: int = 5) -> str:
    direction = direction.lower()
    if direction in ("lauter", "hoch", "up"):
        press("volume up", steps)
        return "Lauter."
    if direction in ("leiser", "runter", "down"):
        press("volume down", steps)
        return "Leiser."
    if direction in ("stumm", "aus", "mute", "an", "ton"):
        press("volume mute")
        return "Ton umgeschaltet."
    raise PcError(f"Unbekannt: {direction}. Möglich: lauter, leiser, stumm.")


def set_volume(percent: int) -> str:
    """Stellt die Lautstärke auf etwa `percent` Prozent: erst ganz leise, dann
    hoch. Jeder Tastendruck sind unter Windows 2 Prozent."""
    percent = max(0, min(100, int(percent)))
    press("volume down", 50)
    press("volume up", round(percent / 2))
    return f"Lautstärke auf {percent} Prozent."


def screenshot(path: Path) -> Path:
    from PIL import ImageGrab

    path.parent.mkdir(parents=True, exist_ok=True)
    image = ImageGrab.grab(all_screens=True)
    # Kleiner machen, damit Claude es schnell lesen kann.
    image.thumbnail((1920, 1920))
    image.save(path)
    return path


def gaming_mode(on: bool, cfg: dict) -> str:
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    done = []
    if on:
        closed, still = [], []
        for name in cfg.get("close_apps", []):
            exe = name if name.lower().endswith(".exe") else f"{name}.exe"
            if not _running(exe):
                continue
            # Ohne /F: Programme dürfen sich normal beenden und nachfragen, ob gespeichert werden soll.
            _run(["taskkill", "/IM", exe])
            for _ in range(10):
                if not _running(exe):
                    break
                time.sleep(0.3)
            (still if _running(exe) else closed).append(exe)
        if closed:
            done.append("Geschlossen: " + ", ".join(closed))
        if still:
            done.append("Laufen noch (wohl im Tray oder fragen nach): " + ", ".join(still))
        if cfg.get("power_plan", True):
            done.append(_power(True))
        return "Gaming-Modus an. " + ". ".join(done)
    if cfg.get("power_plan", True):
        done.append(_power(False))
    return "Gaming-Modus aus. " + ". ".join(done)


# Windows 11 hat oft nur den Plan "Ausbalanciert" und dafür einen Leistungsmodus
# (Einstellungen > System > Strom). Diese IDs schalten ihn um.
_OVERLAY_BEST = "ded574b5-45a0-4f42-8737-46345c09c238"
_OVERLAY_NONE = "00000000-0000-0000-0000-000000000000"


def _power(high: bool) -> str:
    plan = "SCHEME_MIN" if high else "SCHEME_BALANCED"
    if _run(["powercfg", "/setactive", plan]).returncode == 0:
        return "Energieplan Höchstleistung" if high else "Energieplan Ausbalanciert"
    try:
        import ctypes
        import uuid

        guid = uuid.UUID(_OVERLAY_BEST if high else _OVERLAY_NONE)
        raw = ctypes.create_string_buffer(guid.bytes_le, 16)
        if ctypes.windll.powrprof.PowerSetActiveOverlayScheme(raw) == 0:
            return "Leistungsmodus Beste Leistung" if high else "Leistungsmodus Ausbalanciert"
    except Exception as exc:
        log.debug("Leistungsmodus: %s", exc)
    return "Den Energieplan konnte ich nicht umstellen"


def _running(exe: str) -> bool:
    result = _run(["tasklist", "/FI", f"IMAGENAME eq {exe}", "/NH", "/FO", "CSV"])
    return exe.lower() in (result.stdout or "").lower()


def windows_path(path: str) -> Path:
    """Nimmt auch Pfade aus Git Bash ("/c/Users/...") und mit %USERPROFILE% oder ~."""
    path = path.strip().strip('"')
    path = re.sub(r"^/([a-zA-Z])(/|$)", r"\1:/", path)
    return Path(os.path.expandvars(os.path.expanduser(path)))


# Diese Ordner selbst nie in den Papierkorb, ihren Inhalt schon.
_KEEP_FOLDERS = ("Desktop", "Documents", "Dokumente", "Downloads")


def protected(target: Path) -> bool:
    """Laufwerke, der Benutzerordner (und alles darüber) sowie Desktop,
    Dokumente und Downloads selbst, auch die in OneDrive."""
    def key(path: Path) -> str:
        return os.path.normcase(os.path.abspath(path))

    target = Path(os.path.abspath(target))
    if target.parent == target:
        return True
    home = Path.home()
    if Path(key(home)).is_relative_to(key(target)):
        return True
    keep = set()
    for base in [home, *home.glob("OneDrive*")]:
        keep.add(key(base))
        keep.update(key(base / name) for name in _KEEP_FOLDERS)
    return key(target) in keep


def trash_target(path: str) -> Path:
    """Der Pfad für den Papierkorb, oder ein Fehler bei ganzen Ordnern wie dem Desktop."""
    target = windows_path(path)
    if protected(target):
        raise PcError(f"{target} verschiebe ich nicht in den Papierkorb. Nur einzelne Dateien oder Unterordner.")
    return target


def to_recycle_bin(path: str) -> str:
    from send2trash import send2trash

    target = trash_target(path)
    if not target.exists():
        raise PcError(f"Nicht gefunden: {target}")
    send2trash(str(target))
    return f"In den Papierkorb verschoben: {target}"


def install(package_id: str, wait_seconds: float = 100) -> str:
    """Installiert mit winget. Dauert es länger als `wait_seconds`, läuft winget im
    Hintergrund weiter (Claude bricht Befehle nach etwa zwei Minuten ab)."""
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    log_file = Path(tempfile.gettempdir()) / "jarvis-installieren.log"
    flags = NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with open(log_file, "w", encoding="utf-8", errors="replace") as out:
        proc = subprocess.Popen(
            [
                "winget", "install", "--id", package_id, "-e",
                "--accept-package-agreements", "--accept-source-agreements",
            ],
            stdout=out,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
        )
        try:
            code = proc.wait(timeout=wait_seconds)
        except subprocess.TimeoutExpired:
            return f"Die Installation von {package_id} läuft noch im Hintergrund und ist gleich fertig."
    text = log_file.read_text(encoding="utf-8", errors="replace")
    tail = [line.strip() for line in text.splitlines() if line.strip()][-3:]
    if code != 0:
        raise PcError("Installation fehlgeschlagen: " + " ".join(tail))
    return f"{package_id} ist installiert."


def _run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    log.debug("Starte %s", cmd)
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=NO_WINDOW,
    )
