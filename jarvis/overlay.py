"""Die kleine Jarvis-Anzeige oben am Bildschirm.

Erscheint, sobald Jarvis zuhört, nachdenkt oder spricht, und verschwindet danach wieder.
Sie ist ein eigenes, schlankes Windows-Fenster (kein Browser): immer im Vordergrund,
durchklickbar, ohne Taskleisten-Eintrag und ohne den Fokus zu stehlen. So stört sie
weder beim Arbeiten noch im Spiel. Gezeichnet wird mit Pillow, Windows mischt das Bild
mit echter Transparenz (UpdateLayeredWindow) über den Bildschirm.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from dataclasses import dataclass, field

from .ui import Ui

log = logging.getLogger(__name__)

# Logische Größe (bei 100 % Skalierung). PAD lässt Platz für das Leuchten.
WIDTH = 460
HEIGHT = 64
PAD = 18
TOP_MARGIN = 14

# Dieselben Farben wie im Fenster: eine Akzentfarbe, beim Nachdenken etwas violetter,
# stumm grau, Fehler rot (immer mit Wort daneben)
ACCENT = {
    "listening": (104, 176, 255),
    "thinking": (138, 128, 255),
    "speaking": (110, 140, 255),
    "idle": (110, 140, 255),
    "muted": (108, 114, 130),
    "error": (242, 100, 95),
}
LABELS = {
    "listening": "Hört zu",
    "thinking": "Denkt nach",
    "speaking": "Jarvis",
    "idle": "Jarvis",
    "muted": "Mikrofon aus",
    "error": "Fehler",
}
# So lange bleibt die Anzeige nach dem Ende noch stehen (Sekunden).
LINGER = 3.5
FADE = 0.18


@dataclass
class View:
    """Was die Anzeige gerade zeigt."""

    state: str = "idle"
    text: str = ""
    level: float = 0.0
    changed: float = field(default_factory=time.monotonic)
    activity: str = ""  # was Jarvis gerade tut ("Installiert Spotify"), statt nur "Denkt nach"


# ---------------------------------------------------------------------- Zeichnen

_fonts: dict = {}


def _font(size: int, bold: bool = False):
    from PIL import ImageFont

    key = (size, bold)
    if key in _fonts:
        return _fonts[key]
    names = (
        ["segoeuib.ttf", "seguisb.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf"]
        if bold
        else ["segoeui.ttf", "DejaVuSans.ttf", "arial.ttf"]
    )
    font = None
    for name in names:
        try:
            font = ImageFont.truetype(name, size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    _fonts[key] = font
    return font


def _fit(text: str, font, width: float) -> str:
    """Passt Text in eine Zeile. Zu lang: der letzte Satz, notfalls von vorn gekürzt
    ("… letzter Teil"), damit das Neueste sichtbar bleibt."""
    import re

    text = " ".join(text.split())
    if font.getlength(text) <= width:
        return text
    sentences = [p for p in re.split(r"(?<=[.!?])\s+", text) if p]
    if len(sentences) > 1 and font.getlength(sentences[-1]) <= width:
        return sentences[-1]
    words = (sentences[-1] if sentences else text).split(" ")
    while len(words) > 1 and font.getlength("… " + " ".join(words)) > width:
        words.pop(0)
    shown = "… " + " ".join(words).lstrip(",;: ")
    while shown and font.getlength(shown) > width:
        shown = shown[:-2] + "…"
    return shown


# Dieselbe lebendige Kugel wie im Fenster (gui/web/orb.js): tief, mitte, hell, zwei Nebenfarben,
# wie stark die Form atmet, wie stark sie mit der Stimme wellt und wie schnell der farbige Schein kreist
ORB = {
    "idle": ((16, 22, 84), (62, 92, 255), (196, 206, 255), (138, 92, 255), (48, 182, 255), 0.032, 0.06, 0.12),
    "listening": ((12, 34, 104), (52, 128, 255), (204, 236, 255), (104, 112, 255), (40, 214, 255), 0.04, 0.085, 0.25),
    "thinking": ((26, 16, 92), (98, 84, 255), (214, 204, 255), (170, 96, 255), (72, 148, 255), 0.04, 0.03, 1.6),
    "speaking": ((16, 24, 100), (70, 104, 255), (204, 214, 255), (146, 98, 255), (52, 192, 255), 0.038, 0.1, 0.3),
    "muted": ((26, 28, 36), (80, 85, 98), (150, 154, 166), (96, 100, 114), (90, 98, 112), 0.012, 0.0, 0.03),
    "error": ((86, 18, 28), (226, 84, 84), (255, 204, 198), (255, 120, 104), (214, 70, 128), 0.035, 0.05, 0.2),
}


def _orb(state: str, radius: int, now: float, level: float = 0.0):
    """Jarvis' Kugel wie im Fenster: eine weiche, flüssige Form mit fließendem Licht, Glanz und einem
    farbigen Schein, der mit der Stimme stärker wird. Beim Nachdenken kreist der Schein schneller."""
    import numpy as np
    from PIL import Image

    deep, mid, light, hue_a, hue_b, shape, ripple, spin = ORB.get(state, ORB["idle"])
    deep, mid, light, hue_a, hue_b = (np.array(c, np.float32) for c in (deep, mid, light, hue_a, hue_b))
    grid = _grids.get(radius)
    if grid is None:  # Koordinaten je Größe nur einmal rechnen
        size = radius * 2 + 1
        y, x = np.mgrid[0:size, 0:size].astype(np.float32)
        nx, ny = (x - radius) / max(1, radius), (y - radius) / max(1, radius)
        grid = (nx, ny, np.hypot(nx, ny), np.arctan2(ny, nx))
        if len(_grids) > 8:
            _grids.clear()
        _grids[radius] = grid
    nx, ny, d, th = grid
    t = float(now)
    lv = max(0.0, min(1.0, level))
    v = ripple * lv
    # Rand der Form: langsame, weiche Wellen, mit der Stimme stärker und schneller (wie ein Tropfen)
    edge = 0.66 * (1 + shape * (0.6 * np.sin(2 * th + t * 0.8) + 0.4 * np.sin(3 * th - t * 0.6 + 1.9))
                   + v * (0.55 * np.sin(2 * th - t * 2.6 + 4.1) + 0.45 * np.sin(3 * th + t * 3.3 + 0.7)
                          + 0.2 * np.sin(5 * th - t * 4.4 + 2.2)))
    inside = np.clip((edge - d) * radius, 0, 1)  # weiche, glatte Kante
    # Innen: Verlauf von der Mitte zum tiefen Rand, zwei wandernde farbige Lichter, Glanz oben links
    k = np.clip(d / edge, 0, 1)[..., None] ** 1.5
    rgb = mid * (1 - k) + deep * k
    for color, fx, fy, px, py in ((hue_b, 0.71, 0.53, 0.0, 1.7), (hue_a, 0.43, 0.89, 2.1, 0.4)):
        bx = np.cos(t * 0.8 * fx + px) * 0.3
        by = np.sin(t * 0.8 * fy + py) * 0.3
        glow = np.exp(-((nx - bx) ** 2 + (ny - by) ** 2) / 0.1)[..., None] * 0.8
        rgb = 255 - (255 - rgb) * (1 - glow * color / 255)  # "screen": Licht addiert sich weich
    gloss = np.clip(1 - np.hypot(nx + 0.22, ny + 0.26) / 0.4, 0, 1)[..., None] ** 2
    rgb = rgb + (255 - rgb) * gloss * 0.45
    rim = np.clip(1 - np.abs(d - edge) * radius * 0.8, 0, 1) * np.clip(0.55 - (nx + ny) * 0.6, 0, 1)
    rgb = rgb + (light - rgb) * rim[..., None] * 0.5
    # Außen: farbiger Schein, mal violett, mal türkis, der langsam kreist
    turn = (0.5 + 0.5 * np.sin(th + t * spin))[..., None]
    veil = (hue_a * (1 - turn) + hue_b * turn) * 0.55 + mid * 0.45  # bleibt im Blau der Kugel
    out = np.clip((d - edge) / np.maximum(1.0 - edge, 1e-3), 0, 1)
    halo = (1 - out) ** 2 * (d > edge) * (0.3 + 0.45 * lv)
    color = rgb * inside[..., None] + veil * (1 - inside[..., None])
    alpha = np.clip(inside * 255 + halo * 120 * (1 - inside), 0, 255)
    data = np.dstack([np.clip(color, 0, 255), alpha]).astype(np.uint8)
    return Image.fromarray(data, "RGBA")


_static_cache: dict = {}
_grids: dict = {}


def _background(size: tuple[int, int], scale: float, color: tuple[int, int, int]):
    """Glasfläche mit weichem Leuchten. Ändert sich selten, deshalb zwischengespeichert."""
    from PIL import Image, ImageDraw, ImageFilter

    key = (size, round(scale, 2), color)
    if key in _static_cache:
        return _static_cache[key]
    w, h = size
    pad = round(PAD * scale)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(
        (pad, pad, w - pad - 1, h - pad - 1), radius=(h - 2 * pad) // 2, fill=(0, 0, 0, 110)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=10 * scale))  # weicher Schatten statt Leuchten
    img.alpha_composite(glow)
    pill = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(pill)
    radius = (h - 2 * pad) // 2
    draw.rounded_rectangle((pad, pad, w - pad - 1, h - pad - 1), radius=radius, fill=(20, 22, 27, 240))
    draw.rounded_rectangle(
        (pad, pad, w - pad - 1, h - pad - 1), radius=radius, outline=(255, 255, 255, 30), width=max(1, round(scale))
    )
    img.alpha_composite(pill)
    if len(_static_cache) > 24:
        _static_cache.clear()
    _static_cache[key] = img
    return img


def render(view: View, now: float | None = None, scale: float = 1.0):
    """Zeichnet die Anzeige als RGBA-Bild (für Tests auch ohne Windows nutzbar)."""
    from PIL import ImageDraw

    now = time.monotonic() if now is None else now
    w, h = round((WIDTH + 2 * PAD) * scale), round((HEIGHT + 2 * PAD) * scale)
    color = ACCENT.get(view.state, ACCENT["idle"])
    img = _background((w, h), scale, color).copy()
    draw = ImageDraw.Draw(img)
    pad = PAD * scale
    inner_h = HEIGHT * scale

    # --- Kugel links: dieselbe lebendige Form wie im Fenster
    cx, cy = pad + inner_h / 2, pad + inner_h / 2
    r = inner_h * 0.3
    level = max(0.0, min(1.0, view.level)) if view.state in ("speaking", "listening") else 0.0
    orb_r = max(4, round(r * 1.5 * (1 + 0.06 * level)))
    sprite = _orb(view.state, orb_r, now, level)
    img.alpha_composite(sprite, (round(cx - orb_r), round(cy - orb_r)))

    # --- Text rechts
    left = pad + inner_h + 4 * scale
    right = w - pad - inner_h * 0.5
    bars = view.state == "speaking"
    if bars:
        right -= 34 * scale
    label_font = _font(round(11 * scale), bold=True)
    text_font = _font(round(15 * scale))
    label = LABELS.get(view.state, "Jarvis")
    if view.state == "thinking" and view.activity:
        label = _fit(view.activity, label_font, right - left)
    draw.text((left, pad + inner_h * 0.17), label, font=label_font, fill=(160, 166, 180, 255))
    text = view.text.strip() or {"listening": "Ich höre …", "thinking": "Einen Moment …"}.get(view.state, "")
    if view.state == "thinking" and view.text.strip():
        text = view.text.strip()
    shown = _fit(text, text_font, right - left)
    draw.text((left, pad + inner_h * 0.45), shown, font=text_font, fill=(232, 238, 248, 255))

    # --- Stimm-Balken beim Sprechen
    if bars:
        base_x = w - pad - inner_h * 0.5 - 26 * scale
        for i in range(5):
            wave = 0.5 + 0.5 * math.sin(now * (7 + i * 1.7) + i)
            height = (6 + (10 + 14 * level) * wave) * scale
            x = base_x + i * 6 * scale
            draw.rounded_rectangle(
                (x, cy - height / 2, x + 3 * scale, cy + height / 2), radius=1.5 * scale, fill=color + (220,)
            )
    return img


def premultiplied_bgra(img) -> bytes:
    """RGBA (Pillow) in das Format, das UpdateLayeredWindow will: BGRA, vormultipliziert."""
    import numpy as np

    a = np.asarray(img, dtype=np.uint16)
    alpha = a[..., 3:4]
    rgb = (a[..., :3] * alpha + 127) // 255
    out = np.empty(a.shape, dtype=np.uint8)
    out[..., 0] = rgb[..., 2]
    out[..., 1] = rgb[..., 1]
    out[..., 2] = rgb[..., 0]
    out[..., 3] = alpha[..., 0]
    return out.tobytes()


# ---------------------------------------------------------------------- Logik

class Overlay(Ui):
    """Hört auf die Zustände von Jarvis und blendet die Anzeige passend ein und aus.
    `suppressed()` sagt, wann sie trotzdem nicht erscheinen soll (Gaming-Modus,
    Vollbild-Spiel, Jarvis-Fenster ist offen)."""

    def __init__(self, suppressed=None) -> None:
        self.view = View()
        self._suppressed = suppressed or (lambda: False)
        self._visible_until = 0.0
        self._lock = threading.Lock()
        self._window: _LayeredWindow | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._opacity = 0.0

    # -------- Ui
    _last_answer = ""

    def state(self, value: str) -> None:
        with self._lock:
            if value == self.view.state:
                return
            previous = self.view.state
            now = time.monotonic()
            if value in ("listening", "thinking", "speaking"):
                if value == "listening":
                    self._last_answer = ""
                text = "" if value == "listening" else self.view.text
                self.view = View(value, text, self.view.level)
                self._visible_until = float("inf")
            elif value == "idle":
                # Nach einer Antwort bleibt sie noch kurz stehen.
                busy_before = previous in ("speaking", "thinking", "listening")
                text = self._last_answer or self.view.text
                self.view = View("idle", text if busy_before else "", 0.0)
                self._visible_until = now + LINGER if busy_before and text else min(self._visible_until, now)
            elif value == "muted":
                self.view = View("muted", "Ich höre gerade nicht zu.", 0.0)
                self._visible_until = now + 1.6
            else:
                self.view = View(value, self.view.text, 0.0)
                self._visible_until = now + LINGER

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        if role not in ("user", "jarvis") or not text:
            return
        with self._lock:
            if role == "user":
                self.view.text = f"„{text.strip()}“"
            else:
                self._last_answer = text.strip()
                self.view.text = text.strip()
            if self.view.state == "idle":
                self._visible_until = max(self._visible_until, time.monotonic() + LINGER)

    def level(self, value: float) -> None:
        self.view.level = max(0.0, min(1.0, float(value)))

    def progress(self, step: dict) -> None:
        if step.get("workshop"):
            return  # Die Werkstatt hat ihr eigenes Fenster, hier geht es nur um das Gespräch
        with self._lock:
            if step.get("state") == "running":
                self.view.activity = str(step.get("label") or "")
                self._activity_id = step.get("id")
            elif step.get("id") == getattr(self, "_activity_id", None):
                self.view.activity = ""

    # -------- Anzeige
    def wanted(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if now > self._visible_until:
            return False
        try:
            return not self._suppressed()
        except Exception:
            return True

    def start(self) -> bool:
        if os.name != "nt":
            return False
        self._thread = threading.Thread(target=self._run, name="jarvis-anzeige", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        try:
            window = _LayeredWindow()
        except Exception:
            log.exception("Die Jarvis-Anzeige ließ sich nicht anlegen")
            return
        self._window = window
        shown = False
        last_render = 0.0
        try:
            while not self._stop.is_set():
                window.pump()
                now = time.monotonic()
                target = 1.0 if self.wanted(now) and not _fullscreen_app() else 0.0
                step = 1 / 60 / FADE
                if self._opacity < target:
                    self._opacity = min(target, self._opacity + step * 2)
                elif self._opacity > target:
                    self._opacity = max(target, self._opacity - step)
                if self._opacity <= 0.0:
                    if shown:
                        window.hide()
                        shown = False
                    time.sleep(0.08)
                    continue
                if now - last_render >= 1 / 40:
                    with self._lock:
                        view = View(self.view.state, self.view.text, self.view.level, self.view.changed)
                    image = render(view, now, window.scale)
                    slide = round((1 - self._opacity) * -10 * window.scale)
                    window.update(image, round(255 * self._opacity), slide)
                    last_render = now
                    if not shown:
                        window.show()
                        shown = True
                time.sleep(1 / 60)
        except Exception:
            log.exception("Jarvis-Anzeige abgestürzt")
        finally:
            window.destroy()


def _fullscreen_app() -> bool:
    """True, wenn gerade ein Spiel oder Video im Vollbild läuft (dann keine Anzeige)."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        state = ctypes.c_int(0)
        if ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state)) != 0:
            return False
        # 2 = Vollbild-Programm, 3 = Direct3D-Vollbild, 4 = Präsentationsmodus
        return state.value in (2, 3, 4)
    except Exception:
        return False


# ---------------------------------------------------------------------- Windows

class _LayeredWindow:
    """Ein randloses, durchklickbares Fenster mit echter Transparenz, oben in der Mitte."""

    CLASS_NAME = "JarvisAnzeige"

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self._ct = ctypes
        self._wt = wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._user32, self._gdi32 = user32, gdi32

        LRESULT = ctypes.c_ssize_t
        self._WNDPROC = WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        class WNDCLASSEXW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.UINT), ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC),
                ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON),
            ]

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
            ]

        class BITMAPINFO(ctypes.Structure):
            _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

        class BLENDFUNCTION(ctypes.Structure):
            _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                        ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]

        class MSG(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("message", wintypes.UINT), ("wParam", wintypes.WPARAM),
                        ("lParam", wintypes.LPARAM), ("time", wintypes.DWORD), ("pt", wintypes.POINT)]

        self._BITMAPINFO, self._BLENDFUNCTION, self._MSG = BITMAPINFO, BLENDFUNCTION, MSG

        user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = LRESULT
        user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
        user32.RegisterClassExW.restype = wintypes.ATOM
        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
        ]
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.GetDC.argtypes = [wintypes.HWND]
        user32.GetDC.restype = wintypes.HDC
        user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        user32.UpdateLayeredWindow.argtypes = [
            wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT), ctypes.POINTER(wintypes.SIZE), wintypes.HDC,
            ctypes.POINTER(wintypes.POINT), wintypes.COLORREF, ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD,
        ]
        user32.UpdateLayeredWindow.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, wintypes.UINT]
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        user32.PeekMessageW.argtypes = [ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
        user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
        user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, wintypes.LPVOID, wintypes.UINT]
        gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
        gdi32.CreateCompatibleDC.restype = wintypes.HDC
        gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
                                           ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        gdi32.CreateDIBSection.restype = wintypes.HBITMAP
        gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        gdi32.SelectObject.restype = wintypes.HGDIOBJ
        gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        gdi32.DeleteDC.argtypes = [wintypes.HDC]
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE

        try:
            # Scharf auch bei 125 % oder 150 % Skalierung
            user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:
            pass

        def wndproc(hwnd, msg, wparam, lparam):
            if msg == 0x0084:  # WM_NCHITTEST: Klicks gehen durch
                return -1
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        self._proc = WNDPROC(wndproc)  # Verweis halten, sonst räumt Python ihn weg
        instance = kernel32.GetModuleHandleW(None)
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._proc
        wc.hInstance = instance
        wc.lpszClassName = self.CLASS_NAME
        user32.RegisterClassExW(ctypes.byref(wc))  # schon registriert ist auch in Ordnung

        WS_EX = 0x00080000 | 0x00000020 | 0x00000008 | 0x00000080 | 0x08000000  # LAYERED|TRANSPARENT|TOPMOST|TOOLWINDOW|NOACTIVATE
        self.hwnd = user32.CreateWindowExW(
            WS_EX, self.CLASS_NAME, "Jarvis Anzeige", 0x80000000, 0, 0, 1, 1, None, None, instance, None  # WS_POPUP
        )
        if not self.hwnd:
            raise OSError(f"CreateWindowExW: {ctypes.get_last_error()}")
        self.scale = self._dpi_scale()
        self._screen_dc = user32.GetDC(None)
        self._mem_dc = gdi32.CreateCompatibleDC(self._screen_dc)
        self._bitmap = None
        self._old = None
        self._bits = ctypes.c_void_p()
        self._size = (0, 0)

    def _dpi_scale(self) -> float:
        try:
            return max(1.0, self._user32.GetDpiForWindow(self.hwnd) / 96)
        except Exception:
            return 1.0

    def _ensure_bitmap(self, size: tuple[int, int]) -> None:
        if size == self._size and self._bitmap:
            return
        ct, gdi32 = self._ct, self._gdi32
        if self._bitmap:
            gdi32.SelectObject(self._mem_dc, self._old)
            gdi32.DeleteObject(self._bitmap)
        info = self._BITMAPINFO()
        info.bmiHeader.biSize = ct.sizeof(info.bmiHeader)
        info.bmiHeader.biWidth = size[0]
        info.bmiHeader.biHeight = -size[1]  # von oben nach unten
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0
        self._bitmap = gdi32.CreateDIBSection(self._mem_dc, ct.byref(info), 0, ct.byref(self._bits), None, 0)
        if not self._bitmap:
            raise OSError("CreateDIBSection fehlgeschlagen")
        self._old = gdi32.SelectObject(self._mem_dc, self._bitmap)
        self._size = size

    def _position(self, size: tuple[int, int], slide: int) -> tuple[int, int]:
        wt, ct = self._wt, self._ct
        area = wt.RECT()
        self._user32.SystemParametersInfoW(0x0030, 0, ct.byref(area), 0)  # SPI_GETWORKAREA
        x = area.left + (area.right - area.left - size[0]) // 2
        y = area.top + round((TOP_MARGIN - PAD) * self.scale) + slide
        return x, y

    def update(self, image, alpha: int, slide: int = 0) -> None:
        ct, wt = self._ct, self._wt
        size = image.size
        self._ensure_bitmap(size)
        data = premultiplied_bgra(image)
        ct.memmove(self._bits, data, len(data))
        x, y = self._position(size, slide)
        blend = self._BLENDFUNCTION(0, 0, max(0, min(255, alpha)), 1)  # AC_SRC_OVER, AC_SRC_ALPHA
        self._user32.UpdateLayeredWindow(
            self.hwnd, self._screen_dc, ct.byref(wt.POINT(x, y)), ct.byref(wt.SIZE(*size)), self._mem_dc,
            ct.byref(wt.POINT(0, 0)), 0, ct.byref(blend), 2,  # ULW_ALPHA
        )

    def show(self) -> None:
        # SW_SHOWNOACTIVATE und ganz nach vorn, ohne den Fokus zu nehmen
        self._user32.ShowWindow(self.hwnd, 4)
        self._user32.SetWindowPos(self.hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # NOSIZE|NOMOVE|NOACTIVATE

    def hide(self) -> None:
        self._user32.ShowWindow(self.hwnd, 0)

    def pump(self) -> None:
        msg = self._MSG()
        while self._user32.PeekMessageW(self._ct.byref(msg), None, 0, 0, 1):  # PM_REMOVE
            self._user32.TranslateMessage(self._ct.byref(msg))
            self._user32.DispatchMessageW(self._ct.byref(msg))

    def destroy(self) -> None:
        try:
            if self._bitmap:
                self._gdi32.SelectObject(self._mem_dc, self._old)
                self._gdi32.DeleteObject(self._bitmap)
            self._gdi32.DeleteDC(self._mem_dc)
            self._user32.ReleaseDC(None, self._screen_dc)
            self._user32.DestroyWindow(self.hwnd)
        except Exception:
            pass
