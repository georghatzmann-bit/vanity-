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
                log.info("Zweiter Start: Fenster nach vorn")
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


def colorref(hex_color: str) -> int:
    """'#RRGGBB' als Windows-Farbwert (0x00BBGGRR)."""
    value = hex_color.lstrip("#")
    red, green, blue = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    return (blue << 16) | (green << 8) | red


def style_title_bar(title: str, background: str, text: str = "#c9d1dc", border: str = "#1c2533") -> bool:
    """Titelleiste in der Farbe des Fensters, auch wenn Windows auf "hell" steht: Windows 11
    färbt Leiste, Schrift und Rand ein, Windows 10 nimmt wenigstens den dunklen Modus.
    Sucht das eigene Fenster mit genau diesem Titel. True, wenn es gefunden wurde."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        dwmapi = ctypes.windll.dwmapi
        dwmapi.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        found = []

        def visit(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == os.getpid():
                name = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, name, 256)
                kind = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, kind, 256)
                # Nur das pywebview-Fenster, nicht die Anzeige oder das Tray-Fenster.
                if name.value == title and kind.value.startswith("WindowsForms"):
                    found.append(hwnd)
            return True

        user32.EnumWindows(enum_proc(visit), 0)
        for hwnd in found:
            for attribute, value in (
                (20, 1),  # DWMWA_USE_IMMERSIVE_DARK_MODE
                (35, colorref(background)),  # DWMWA_CAPTION_COLOR (ab Windows 11)
                (36, colorref(text)),  # DWMWA_TEXT_COLOR
                (34, colorref(border)),  # DWMWA_BORDER_COLOR
            ):
                number = ctypes.c_int(value)
                dwmapi.DwmSetWindowAttribute(hwnd, attribute, ctypes.byref(number), ctypes.sizeof(number))
        return bool(found)
    except Exception as exc:
        log.debug("Titelleiste: %s", exc)
        return False
