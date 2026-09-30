"""Jarvis mit Windows starten: legt eine kleine Datei in den Autostart-Ordner."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .config import ROOT

FILE_NAME = "Jarvis.cmd"


def startup_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("Der Autostart-Ordner geht nur unter Windows.")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def launcher_text(root: Path, pythonw: Path) -> str:
    # chcp 65001, damit Ordnernamen mit Umlauten stimmen. "start" öffnet Jarvis
    # ohne Konsolenfenster (pythonw), der Autostart-Eintrag selbst schließt sich sofort.
    return (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        f'cd /d "{root}"\r\n'
        f'start "" "{pythonw}" -m jarvis\r\n'
    )


def pythonw_path() -> Path:
    exe = Path(sys.executable)
    candidate = exe.with_name("pythonw.exe")
    return candidate if candidate.exists() else exe


def enable() -> Path:
    target = startup_dir() / FILE_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 ohne BOM: cmd liest die Datei nach chcp 65001 richtig.
    target.write_bytes(launcher_text(ROOT, pythonw_path()).encode("utf-8"))
    return target


def disable() -> bool:
    target = startup_dir() / FILE_NAME
    if target.exists():
        target.unlink()
        return True
    return False


def enabled() -> bool:
    try:
        return (startup_dir() / FILE_NAME).exists()
    except RuntimeError:
        return False
