"""Jarvis mit Windows starten: ein Eintrag unter "Autostart" in der Registry (HKCU\\...\\Run).

Er startet Jarvis.pyw mit pythonw, also ohne Konsolenfenster, und mit --hintergrund:
Jarvis läuft dann unsichtbar, nur das Symbol neben der Uhr ist da.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .config import ROOT

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "Jarvis"
# Frühere Jarvis-Versionen legten eine kleine Datei in den Autostart-Ordner.
OLD_FILE_NAME = "Jarvis.cmd"


class _WindowsRegistry:
    def get(self) -> str | None:
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                value, _ = winreg.QueryValueEx(key, VALUE_NAME)
                return str(value)
        except FileNotFoundError:
            return None

    def set(self, value: str) -> None:
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, value)

    def delete(self) -> bool:
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, VALUE_NAME)
            return True
        except FileNotFoundError:
            return False


def registry():
    if os.name != "nt":
        raise RuntimeError("Der Autostart geht nur unter Windows.")
    return _WindowsRegistry()


def pythonw_path() -> Path:
    exe = Path(sys.executable)
    candidate = exe.with_name("pythonw.exe")
    return candidate if candidate.exists() else exe


def command(root: Path = ROOT, pythonw: Path | None = None) -> str:
    """Die Zeile im Autostart: pythonw startet Jarvis.pyw unsichtbar im Hintergrund."""
    pythonw = pythonw or pythonw_path()
    return f'"{pythonw}" "{root / "Jarvis.pyw"}" --hintergrund'


def startup_dir() -> Path | None:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def _remove_old_file() -> bool:
    folder = startup_dir()
    old = folder / OLD_FILE_NAME if folder else None
    if old is not None and old.exists():
        old.unlink()
        return True
    return False


def enable(reg=None) -> str:
    reg = reg or registry()
    reg.set(command())
    _remove_old_file()
    return f"HKEY_CURRENT_USER\\{RUN_KEY}\\{VALUE_NAME}"


def disable(reg=None) -> bool:
    reg = reg or registry()
    removed = reg.delete()
    return _remove_old_file() or removed


def enabled(reg=None) -> bool:
    try:
        reg = reg or registry()
        if reg.get():
            return True
    except Exception:
        pass
    folder = startup_dir()
    return bool(folder and (folder / OLD_FILE_NAME).exists())
