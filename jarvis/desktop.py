"""Einbindung in Windows: eigenes Symbol und eigener Taskleisten-Eintrag statt "Python",
ein zweiter Start holt das laufende Jarvis-Fenster nach vorn, und die Frage, ob gerade
ein Jarvis-Fenster vorne ist."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from .config import ROOT, STATE_DIR

log = logging.getLogger(__name__)

APP_ID = "Jarvis.Assistent"
SHOW_EVENT = "Local\\JarvisFensterZeigen"


def set_app_id() -> None:
    """Damit Windows das Fenster als "Jarvis" gruppiert (eigenes Symbol in der Taskleiste)."""
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception as exc:
        log.debug("AppUserModelID: %s", exc)


def app_icon() -> str | None:
    """Pfad zum Jarvis-Symbol (.ico). Fehlt es, wird es einmal gezeichnet."""
    candidates = [ROOT / "jarvis.ico"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Jarvis" / "jarvis.ico")
    candidates.append(STATE_DIR / "jarvis.ico")
    for path in candidates:
        if path.is_file():
            return str(path)
    try:
        from .tray import save_app_icon

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        save_app_icon(STATE_DIR / "jarvis.ico")
        return str(STATE_DIR / "jarvis.ico")
    except Exception as exc:
        log.debug("Symbol: %s", exc)
        return None


def signal_running_instance() -> bool:
    """Ein zweiter Start (Doppelklick aufs Symbol) sagt dem laufenden Jarvis, dass er sein
    Fenster zeigen soll. True, wenn das geklappt hat."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenEventW.restype = ctypes.c_void_p
        kernel32.SetEvent.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenEventW(0x0002, False, SHOW_EVENT)  # EVENT_MODIFY_STATE
        if not handle:
            return False
        # Wir sind gerade vorne (der Nutzer hat geklickt) und dürfen das Recht weitergeben.
        ctypes.windll.user32.AllowSetForegroundWindow(-1)
        ok = bool(kernel32.SetEvent(handle))
        kernel32.CloseHandle(handle)
        return ok
    except Exception as exc:
        log.debug("Laufenden Jarvis wecken: %s", exc)
        return False


def listen_for_show(callback, stopped: threading.Event) -> bool:
    """Wartet im Hintergrund auf einen zweiten Start und ruft dann `callback` auf."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateEventW.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        handle = kernel32.CreateEventW(None, False, False, SHOW_EVENT)  # setzt sich selbst zurück
        if not handle:
            return False
    except Exception as exc:
        log.debug("Weck-Signal: %s", exc)
        return False

    def wait() -> None:
        while not stopped.is_set():
            if kernel32.WaitForSingleObject(handle, 500) == 0:
                try:
                    callback()
                except Exception:
                    log.exception("Fenster zeigen")

    threading.Thread(target=wait, name="jarvis-weckruf", daemon=True).start()
    return True


def jarvis_in_front() -> bool:
    """True, wenn das Fenster ganz vorn zu Jarvis gehört (dann braucht es keine Einblendung)."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = wintypes.HWND
        hwnd = user32.GetForegroundWindow()
        if not hwnd or user32.IsIconic(hwnd):
            return False
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value == os.getpid()
    except Exception:
        return False
