"""Kleine PC-Aktionen unter Windows: Medientasten, Lautstärke, Bildschirmfoto,
Gaming-Modus, Papierkorb und Programme installieren."""

from __future__ import annotations

import logging
import os
import subprocess
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
        closed = []
        for name in cfg.get("close_apps", []):
            exe = name if name.lower().endswith(".exe") else f"{name}.exe"
            # Ohne /F: Programme dürfen sich normal beenden und nachfragen, ob gespeichert werden soll.
            result = _run(["taskkill", "/IM", exe])
            if result.returncode == 0:
                closed.append(exe)
        if closed:
            done.append("Geschlossen: " + ", ".join(closed))
        if cfg.get("power_plan", True):
            _run(["powercfg", "/setactive", "SCHEME_MIN"])
            done.append("Energieplan Höchstleistung")
        return "Gaming-Modus an. " + ". ".join(done)
    if cfg.get("power_plan", True):
        _run(["powercfg", "/setactive", "SCHEME_BALANCED"])
        done.append("Energieplan Ausbalanciert")
    return "Gaming-Modus aus. " + ". ".join(done)


def to_recycle_bin(path: str) -> str:
    from send2trash import send2trash

    target = Path(os.path.expandvars(os.path.expanduser(path)))
    if not target.exists():
        raise PcError(f"Nicht gefunden: {target}")
    send2trash(str(target))
    return f"In den Papierkorb verschoben: {target}"


def install(package_id: str) -> str:
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    result = _run(
        [
            "winget", "install", "--id", package_id, "-e",
            "--accept-package-agreements", "--accept-source-agreements",
        ],
        timeout=900,
    )
    tail = (result.stdout or result.stderr or "").strip().splitlines()[-3:]
    if result.returncode != 0:
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
