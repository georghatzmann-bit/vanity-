"""Kleine PC-Aktionen unter Windows: Medientasten, Lautstärke, Bildschirmfoto,
Gaming-Modus, Papierkorb und Programme installieren."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
import threading
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


def lock() -> None:
    """Sperrt den PC (wie Windows-Taste + L)."""
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    import ctypes

    if not ctypes.windll.user32.LockWorkStation():
        raise PcError("Der PC ließ sich nicht sperren.")


# Bekannte Ordner und ihre Windows-IDs (die echten Pfade, auch wenn sie in OneDrive liegen).
_KNOWN_FOLDERS = {
    "downloads": ("Downloads", "{374DE290-123F-4565-9164-39C4925E467B}"),
    "download": ("Downloads", "{374DE290-123F-4565-9164-39C4925E467B}"),
    "dokumente": ("Dokumente", "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}"),
    "bilder": ("Bilder", "{33E28130-4E1E-4676-835A-98395C3BC3BB}"),
    "fotos": ("Bilder", "{33E28130-4E1E-4676-835A-98395C3BC3BB}"),
    "desktop": ("Desktop", "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}"),
    "musik": ("Musik", "{4BD8D571-6D19-48D3-BE97-422220080E43}"),
    "videos": ("Videos", "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}"),
}
_ENGLISH_FOLDERS = {"Dokumente": "Documents", "Bilder": "Pictures", "Musik": "Music"}


def known_folder(name: str) -> tuple[str, Path]:
    """(Anzeigename, Pfad) eines Benutzerordners wie "Downloads" oder "Bilder"."""
    label, guid = _KNOWN_FOLDERS[name.lower()]
    if os.name == "nt":
        try:
            import ctypes
            import uuid
            from ctypes import wintypes

            raw = ctypes.create_string_buffer(uuid.UUID(guid).bytes_le, 16)
            out = ctypes.c_wchar_p()
            shell32 = ctypes.windll.shell32
            shell32.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(ctypes.c_wchar_p)]
            if shell32.SHGetKnownFolderPath(raw, 0, None, ctypes.byref(out)) == 0 and out.value:
                path = Path(out.value)
                ctypes.windll.ole32.CoTaskMemFree(out)
                return label, path
        except Exception as exc:
            log.debug("Bekannter Ordner %s: %s", name, exc)
    return label, Path.home() / _ENGLISH_FOLDERS.get(label, label)


def open_folder(name: str) -> str:
    label, path = known_folder(name)
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    os.startfile(str(path))  # type: ignore[attr-defined]
    return f"{label} ist offen."


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


def install(target: str, wait_seconds: float = 100) -> str:
    """Installiert mit winget (Name wie "spotify" oder winget-ID). Dauert es länger als
    `wait_seconds`, läuft winget im Hintergrund weiter (Claude bricht Befehle nach etwa
    zwei Minuten ab)."""
    from . import apps

    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    result: dict = {}

    def work() -> None:
        try:
            result["text"] = apps.install(target)
        except Exception as exc:
            result["error"] = exc

    worker = threading.Thread(target=work, name="jarvis-installieren", daemon=False)
    worker.start()
    worker.join(wait_seconds)
    if worker.is_alive():
        return f"Die Installation von {target} läuft noch und ist gleich fertig."
    if "error" in result:
        raise PcError(str(result["error"]))
    return result["text"]


# Befehle, die auch mit Administratorrechten erst nach Georgs Ja laufen.
DESTRUCTIVE = re.compile(
    r"\b(remove-item|ri|rm|rmdir|rd|del|erase|clear-recyclebin|format-volume|format(?!-)|clear-disk|"
    r"initialize-disk|remove-partition|diskpart|stop-computer|restart-computer|shutdown|logoff|"
    r"remove-itemproperty|remove-appxpackage|remove-appxprovisionedpackage|uninstall-package|"
    r"disable-windowsoptionalfeature|bcdedit|vssadmin|takeown|cipher|winget\s+uninstall|msiexec)\b"
    r"|reg(?:\.exe)?\s+delete|icacls\s.*/(?:remove|deny)",
    re.I,
)


def needs_confirmation(command: str) -> bool:
    return bool(DESTRUCTIVE.search(command))


def run_admin(command: str, timeout: float = 300) -> str:
    """Führt einen PowerShell-Befehl mit Administratorrechten aus. Windows zeigt dafür
    die übliche Abfrage (UAC), Georg klickt einmal auf Ja. Gibt die Ausgabe zurück."""
    if os.name != "nt":
        raise PcError("Das geht nur unter Windows.")
    import ctypes
    import uuid
    from ctypes import wintypes

    tag = uuid.uuid4().hex[:8]
    temp = Path(tempfile.gettempdir())
    script = temp / f"jarvis-admin-{tag}.ps1"
    output = temp / f"jarvis-admin-{tag}.txt"
    out = str(output).replace("'", "''")
    script.write_text(
        "$ErrorActionPreference = 'Continue'\r\n"
        "$code = 0\r\n"
        "try {\r\n"
        f"  & {{ {command} }} *>&1 | Out-File -FilePath '{out}' -Encoding utf8 -Width 400\r\n"
        "  if ($LASTEXITCODE) { $code = $LASTEXITCODE }\r\n"
        "} catch {\r\n"
        f"  $_ | Out-File -FilePath '{out}' -Encoding utf8 -Append\r\n"
        "  $code = 1\r\n"
        "}\r\n"
        "exit $code\r\n",
        encoding="utf-8-sig",
    )

    class ShellExecuteInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIconOrMonitor", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    info = ShellExecuteInfo()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x40  # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = "powershell.exe"
    info.lpParameters = f'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{script}"'
    info.nShow = 0  # SW_HIDE
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    try:
        if not shell32.ShellExecuteExW(ctypes.byref(info)):
            if ctypes.get_last_error() == 1223:  # ERROR_CANCELLED
                raise PcError("Georg hat die Administrator-Abfrage abgelehnt.")
            raise PcError(f"Administratorrechte gingen nicht (Fehler {ctypes.get_last_error()}).")
        if kernel32.WaitForSingleObject(info.hProcess, int(timeout * 1000)) != 0:
            raise PcError("Der Befehl mit Administratorrechten läuft noch.")
        code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
        kernel32.CloseHandle(info.hProcess)
        text = output.read_text(encoding="utf-8-sig", errors="replace").strip() if output.exists() else ""
        text = text[-1500:]
        if code.value != 0:
            raise PcError(f"Mit Administratorrechten fehlgeschlagen (Code {code.value}): {text}")
        return text or "Erledigt (mit Administratorrechten)."
    finally:
        for path in (script, output):
            try:
                path.unlink()
            except OSError:
                pass


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
