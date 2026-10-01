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

    def progress(self, step: dict) -> None:
        self._push({"type": "progress", "step": dict(step)})

    def workshop(self, event: dict) -> None:
        # Laufender Text kommt oft: nur der neueste zählt, sonst läuft die Warteschlange voll.
        if event.get("state") == "text":
            with self._lock:
                for old in [e for e in self._events if e.get("type") == "workshop" and e.get("state") == "text"]:
                    self._events.remove(old)
        self._push({"type": "workshop", **event})

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
        self._on_touched = None  # setzt __main__ (Hintergrund-Modus)

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

    def reminders(self) -> list:
        """Die nächsten Erinnerungen (heute und morgen) für die Spalte "Heute"."""
        import datetime as dt

        store = getattr(self._assistant, "reminders", None)
        if store is None:
            return []
        now = dt.datetime.now()
        rows = []
        for r in store.upcoming(now):
            try:
                when = dt.datetime.fromisoformat(r["zeit"])
            except (KeyError, ValueError):
                continue
            days = (when.date() - now.date()).days
            if days > 1:
                break
            rows.append({"uhr": when.strftime("%H:%M"), "text": str(r.get("text", "")),
                         "tag": "heute" if days == 0 else "morgen"})
        return rows[:8]

    def toggle_gaming(self) -> bool:
        """Schalter in der Spalte links: Gaming-Modus an oder aus."""
        self._assistant.toggle_gaming()
        return not bool(getattr(self._assistant, "gaming", False))

    def touched(self) -> None:
        """Die Seite meldet: Georg hat ins Fenster geklickt. Dann verschwindet es nicht von selbst."""
        if self._on_touched is not None:
            self._on_touched()

    # ------------------------------------------------------------------ Werkstatt

    def workshop_state(self) -> dict | None:
        """Der aktuelle Werkstatt-Auftrag (oder None), damit die Ansicht nach einem Neuladen stimmt."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return None
        try:
            return shop.snapshot()
        except Exception as exc:
            log.debug("Werkstatt-Stand: %s", exc)
            return None

    def workshop_cancel(self) -> bool:
        """Stopp-Knopf in der Werkstatt."""
        shop = getattr(self._assistant, "workshop", None)
        return bool(shop is not None and shop.cancel())

    def open_folder(self, path) -> bool:
        """Öffnet einen Projektordner im Explorer. Nur Ordner in der Werkstatt, sonst nichts."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None or not path:
            return False
        try:
            target = Path(str(path)).resolve()
            base = Path(shop.base).resolve()
        except (OSError, ValueError):
            return False
        if base not in target.parents or not target.is_dir():
            return False
        try:
            if os.name == "nt":
                os.startfile(str(target))  # type: ignore[attr-defined]
            else:
                import subprocess

                subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as exc:
            log.info("Ordner öffnen: %s", exc)
            return False
        return True

    def new_conversation(self) -> None:
        # Erst die laufende Antwort stoppen, sonst landet sie im frisch geleerten Verlauf.
        self._assistant.stop()
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


def place_on_screen(width: int, height: int) -> dict:
    """Größe und Lage für ein Fenster, in logischen Punkten (so rechnet pywebview).

    Das Fenster soll auf den Bildschirm passen, auch bei 150 % Skalierung auf Full HD (dann
    sind nur etwa 1280 x 680 Punkte frei), und mittig über der Taskleiste stehen. Die Lage
    geben wir selbst vor: pywebview 6 setzt die Mitte unter Windows zu spät, das Fenster
    landet sonst an der Standard-Stelle von Windows (nach rechts unten versetzt) und ragt auf
    kleinen Bildschirmen über den Rand."""
    place = {"width": width, "height": height, "x": None, "y": None}
    if os.name != "nt":
        return place
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        area = wintypes.RECT()
        user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0)  # SPI_GETWORKAREA
        left, top = area.left, area.top
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
            left, top = int(left / scale), int(top / scale)
            free_w, free_h = int(free_w / scale), int(free_h / scale)
        if free_w > 400 and free_h > 300:
            width = min(width, free_w - 40)
            height = min(height, free_h - 40)
            place.update(
                width=width,
                height=height,
                x=left + (free_w - width) // 2,
                y=top + (free_h - height) // 2,
            )
    except Exception as exc:
        log.debug("Bildschirmgröße unbekannt: %s", exc)
    return place


TITLE_BAR_COLOR = "#080b11"  # wie der Hintergrund des HUD (style.css --hud-bg)


class Window:
    """Öffnet das Fenster und hält es am Laufen. `start()` blockiert, bis es geschlossen wird.
    Mit `hidden` startet Jarvis unsichtbar (nur Tray-Symbol), das Fenster kommt später."""

    def __init__(self, api: Api, on_started, on_closed, cfg: dict, hidden: bool = False, icon: str | None = None) -> None:
        self._api = api
        self._on_started = on_started
        self._on_closed = on_closed
        self._cfg = cfg
        self._window = None
        self._hidden = hidden
        self._icon = icon
        self._closed_lock = threading.Lock()
        self._closed_done = False
        self.allow_close = True

    @property
    def hidden(self) -> bool:
        return self._hidden

    def start(self) -> None:
        import webview

        place = place_on_screen(int(self._cfg.get("width", 1280)), int(self._cfg.get("height", 800)))
        width, height = place["width"], place["height"]
        self._window = webview.create_window(
            "Jarvis",
            # Ein lokaler Pfad: pywebview liefert die Seite über einen kleinen lokalen Server aus.
            url=str(WEB_DIR / "index.html"),
            js_api=self._api,
            width=width,
            height=height,
            x=place["x"],
            y=place["y"],
            min_size=(min(800, width), min(600, height)),
            background_color="#05080d",
            text_select=True,
            hidden=self._hidden,
        )
        self._window.events.closing += self._closing
        self._window.events.closed += self._closed
        try:
            self._window.events.minimized += self._minimized
        except AttributeError:
            pass
        try:
            # Läuft im Fenster-Thread, bevor das Fenster zum ersten Mal erscheint.
            self._window.events.before_show += self._style_title_bar
        except AttributeError:
            pass  # ältere pywebview-Version: dann färbt show() die Leiste
        try:
            options = {"debug": bool(self._cfg.get("debug", False))}
            if self._icon:
                options["icon"] = self._icon
            try:
                webview.start(self._on_started, **options)
            except TypeError:
                # Ältere pywebview-Version ohne icon=
                options.pop("icon", None)
                webview.start(self._on_started, **options)
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

    def _minimized(self) -> None:
        # Hintergrund-Modus: Minimieren lässt Jarvis ganz verschwinden (auch aus der Taskleiste),
        # er hört weiter zu. Zurück kommt er mit "Hey Jarvis", Strg+Alt+J oder dem Tray-Symbol.
        if self._cfg.get("minimize_to_background", True) and self.allow_close is False:
            self.hide()

    def show_quiet(self) -> None:
        """Erscheint ganz vorn, ohne den Fokus zu nehmen (beim Weckwort)."""
        from .. import desktop

        hwnd = desktop.find_window("Jarvis") if self._window is not None else 0
        if not hwnd or not desktop.show_quietly(hwnd):
            self.show()
            return
        self._quiet = True
        self._hidden = False
        try:
            self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
        except Exception:
            pass

    def settle(self) -> None:
        """Georg hat das Fenster angefasst: ab jetzt ein ganz normales Fenster."""
        if getattr(self, "_quiet", False):
            from .. import desktop

            desktop.release_topmost(desktop.find_window("Jarvis"))
            self._quiet = False

    def _style_title_bar(self) -> None:
        """Dunkle Titelleiste in der Farbe des HUD, auch wenn Windows auf "hell" steht."""
        from ..desktop import style_title_bar

        style_title_bar("Jarvis", TITLE_BAR_COLOR)

    def show(self) -> None:
        if self._window is not None:
            self._style_title_bar()
            self._window.show()
            self._window.restore()
            self._hidden = False
            try:
                self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
            except Exception:
                pass

    def hide(self) -> None:
        if self._window is not None:
            self.settle()  # nicht als "immer oben" verstecken, sonst bleibt es beim nächsten Zeigen so
            self._window.hide()
            self._hidden = True

    def toggle(self) -> None:
        self.show() if self._hidden else self.hide()

    def destroy(self) -> None:
        self.allow_close = True
        if self._window is not None:
            self._window.destroy()
