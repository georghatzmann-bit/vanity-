"""Das Jarvis-Fenster. Python legt Ereignisse in eine Warteschlange, die Seite holt
sie alle 80 ms mit `poll()` ab. So gibt es keine Probleme mit Threads."""

from __future__ import annotations

import collections
import logging
import os
import threading
from pathlib import Path

from ..ui import Ui

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent / "web"


class GuiBridge(Ui):
    """Sammelt alles, was die Oberfläche anzeigen soll."""

    MAX_EVENTS = 500

    def __init__(self) -> None:
        self._events: collections.deque = collections.deque(maxlen=self.MAX_EVENTS)
        self._level: float | None = None
        self._lock = threading.Lock()
        self.info: dict = {"hotkey": "", "mic": "", "model": "", "muted": False, "version": "", "weather": ""}

    def _push(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)

    def drain(self) -> list[dict]:
        with self._lock:
            events = list(self._events)
            self._events.clear()
            if self._level is not None:
                events.append({"type": "level", "value": round(self._level, 3)})
                self._level = None
        return events

    def state(self, value: str) -> None:
        self._push({"type": "state", "value": value})

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        event = {"type": "message", "role": role, "text": text, "final": final}
        if id:
            event["id"] = id
        if model:
            event["model"] = model
        self._push(event)

    def level(self, value: float) -> None:
        # Nur der neueste Pegel zählt, sonst läuft die Warteschlange voll.
        with self._lock:
            self._level = max(0.0, min(1.0, float(value)))

    def toast(self, text: str, kind: str = "info") -> None:
        self._push({"type": "toast", "text": text, "kind": kind})

    def config(self, **values) -> None:
        self.info.update({k: v for k, v in values.items() if v is not None})
        self._push({"type": "config", **values})

    def stats(self, cpu: float, ram: float) -> None:
        self._push({"type": "stats", "cpu": round(cpu, 1), "ram": round(ram, 1)})


class Api:
    """Was die Seite in Python aufrufen darf (window.pywebview.api.*).
    Interne Dinge beginnen mit _, damit pywebview sie nicht an die Seite gibt."""

    def __init__(self, bridge: GuiBridge, assistant, mute, on_setup=None, on_listen=None) -> None:
        self._bridge = bridge
        self._assistant = assistant
        self._mute = mute
        self._on_setup = on_setup
        self._on_listen = on_listen

    def hello(self) -> dict:
        info = dict(self._bridge.info)
        info["muted"] = bool(self._mute and self._mute.muted)
        return info

    def poll(self) -> list:
        return self._bridge.drain()

    def send_text(self, text) -> bool:
        text = str(text or "").strip()
        if not text:
            return False
        self._assistant.submit(text)
        return True

    def toggle_mute(self) -> bool:
        if self._mute is None:
            return False
        self._mute.toggle()
        return self._mute.muted

    def stop(self) -> None:
        self._assistant.stop()

    def listen_now(self) -> dict:
        """Klick auf den Kreis im Fenster: sofort zuhören, ohne "Hey Jarvis"."""
        if self._mute is not None and self._mute.muted:
            return {"ok": False, "reason": "muted"}
        if self._on_listen is None or not self._on_listen():
            return {"ok": False, "reason": "novoice"}
        return {"ok": True, "reason": ""}

    def new_conversation(self) -> None:
        self._assistant.new_conversation()

    def open_setup(self) -> bool:
        """Zahnrad: Einrichtung öffnen. Jarvis schließt sich dafür und startet danach neu."""
        if self._on_setup is None:
            return False
        try:
            self._on_setup()
            return True
        except Exception as exc:
            log.warning("Einrichtung öffnen: %s", exc)
            self._bridge.toast(f"Die Einrichtung ließ sich nicht öffnen: {exc}", "error")
            return False


def webview_available() -> tuple[bool, str]:
    """Prüft, ob das Fenster gehen kann. Gibt (ok, Grund) zurück."""
    try:
        import webview  # noqa: F401
    except Exception as exc:
        return False, f"pywebview fehlt ({exc})"
    if not (WEB_DIR / "index.html").exists():
        return False, "gui/web/index.html fehlt"
    import os

    if os.name == "nt" and not webview2_installed():
        return False, "Microsoft Edge WebView2 fehlt"
    return True, ""


def webview2_installed() -> bool:
    """WebView2 ist bei Windows 11 dabei, bei Windows 10 manchmal nicht."""
    try:
        import winreg
    except ImportError:
        return True
    key = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    alt = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for root, path in (
        (winreg.HKEY_LOCAL_MACHINE, key),
        (winreg.HKEY_LOCAL_MACHINE, alt),
        (winreg.HKEY_CURRENT_USER, alt),
    ):
        try:
            with winreg.OpenKey(root, path) as handle:
                version, _ = winreg.QueryValueEx(handle, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def fit_to_screen(width: int, height: int) -> tuple[int, int]:
    """Das Fenster soll auf den Bildschirm passen, auch bei 150 % Skalierung auf Full HD
    (dann sind nur etwa 1280 x 680 Punkte frei). Größen in logischen Punkten."""
    if os.name != "nt":
        return width, height
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        area = wintypes.RECT()
        user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0)  # SPI_GETWORKAREA
        free_w, free_h = area.right - area.left, area.bottom - area.top
        aware = 0
        try:
            user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            aware = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext())
        except Exception:
            pass
        if aware:
            # Das Programm sieht echte Pixel, das Fenster wird aber in Punkten angegeben.
            scale = ctypes.windll.shcore.GetScaleFactorForDevice(0) / 100 or 1.0
            free_w, free_h = int(free_w / scale), int(free_h / scale)
        if free_w > 400 and free_h > 300:
            width = min(width, free_w - 40)
            height = min(height, free_h - 40)
    except Exception as exc:
        log.debug("Bildschirmgröße unbekannt: %s", exc)
    return width, height


class Window:
    """Öffnet das Fenster und hält es am Laufen. `start()` blockiert, bis es geschlossen wird."""

    def __init__(self, api: Api, on_started, on_closed, cfg: dict) -> None:
        self._api = api
        self._on_started = on_started
        self._on_closed = on_closed
        self._cfg = cfg
        self._window = None
        self._hidden = False
        self._closed_lock = threading.Lock()
        self._closed_done = False
        self.allow_close = True

    def start(self) -> None:
        import webview

        width, height = fit_to_screen(int(self._cfg.get("width", 1200)), int(self._cfg.get("height", 780)))
        self._window = webview.create_window(
            "Jarvis",
            # Ein lokaler Pfad: pywebview liefert die Seite über einen kleinen lokalen Server aus.
            url=str(WEB_DIR / "index.html"),
            js_api=self._api,
            width=width,
            height=height,
            min_size=(min(800, width), min(600, height)),
            background_color="#0f1115",
            text_select=True,
        )
        self._window.events.closing += self._closing
        self._window.events.closed += self._closed
        try:
            webview.start(self._on_started, debug=bool(self._cfg.get("debug", False)))
        finally:
            # Aufräumen, bevor das Programm endet (das closed-Ereignis läuft in einem
            # eigenen Thread und käme sonst evtl. zu spät).
            self._closed()

    def _closed(self) -> None:
        with self._closed_lock:
            if self._closed_done:
                return
            self._closed_done = True
            try:
                self._on_closed()
            except Exception:
                log.exception("Aufräumen nach dem Schließen")

    def _closing(self):
        if self.allow_close:
            return True
        # Ins Tray-Icon verstecken statt beenden.
        self.hide()
        return False

    def show(self) -> None:
        if self._window is not None:
            self._window.show()
            self._window.restore()
            self._hidden = False

    def hide(self) -> None:
        if self._window is not None:
            self._window.hide()
            self._hidden = True

    def toggle(self) -> None:
        self.show() if self._hidden else self.hide()

    def destroy(self) -> None:
        self.allow_close = True
        if self._window is not None:
            self._window.destroy()
