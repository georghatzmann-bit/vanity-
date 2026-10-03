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


# Dieselbe Kugel wie im Fenster (gui/web/orb.js): feine Linien, ruhig, leicht von oben gesehen.
# Je Zustand: Linienfarbe, Tönung, wie stark sie einfließt, Helligkeit, wie stark die Oberfläche
# atmet und mit der Stimme schwingt, Drehtempo und ob beim Nachdenken ein heller Streifen durchläuft
ORB = {
    "idle": ((226, 230, 240), (150, 168, 255), 0.14, 0.55, 0.035, 0.05, 0.1, 0.0),
    "listening": ((236, 240, 252), (150, 176, 255), 0.42, 0.78, 0.045, 0.09, 0.16, 0.0),
    "thinking": ((232, 232, 250), (172, 164, 255), 0.34, 0.7, 0.04, 0.03, 0.34, 1.0),
    "speaking": ((236, 240, 252), (142, 166, 255), 0.4, 0.8, 0.045, 0.1, 0.18, 0.0),
    "muted": ((118, 122, 134), (118, 122, 134), 0.0, 0.4, 0.012, 0.0, 0.03, 0.0),
    "error": ((238, 206, 204), (242, 100, 95), 0.55, 0.7, 0.03, 0.04, 0.08, 0.0),
}
ORB_TILT = -0.36
ORB_RINGS = 11
ORB_SEG = 44
ORB_SUPERSAMPLE = 3  # PIL zeichnet Linien ohne Glättung: groß zeichnen, dann weich verkleinern


def _orb(state: str, radius: int, now: float, level: float = 0.0):
    """Jarvis' Kugel wie im Fenster: eine ruhige Kugel aus feinen Linien, die sich langsam dreht.
    Mit der Stimme laufen Wellen durch die Ringe, beim Nachdenken ein heller Streifen."""
    import numpy as np
    from PIL import Image, ImageDraw

    ink, tint, mix, alpha, amp, ripple, spin, wave = ORB.get(state, ORB["idle"])
    lv = max(0.0, min(1.0, level))
    ss = ORB_SUPERSAMPLE
    size = radius * 2 + 1
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    c = big / 2
    big_r = radius * ss * 0.72 * (1 + 0.035 * lv)
    k = mix * (0.7 + lv * 0.6)
    color = tuple(round(a + (b - a) * k) for a, b in zip(ink, tint))
    t = float(now)
    v = (np.arange(ORB_RINGS) + 0.5) / ORB_RINGS
    phi = (v * math.pi)[:, None]
    lam = (np.arange(ORB_SEG + 1) / ORB_SEG * 2 * math.pi)[None, :]
    rho = np.sin(phi)
    surface = 1 + rho * (amp * (0.55 * np.sin(2 * lam + 3 * phi + t * 0.55) + 0.45 * np.sin(3 * phi - lam - t * 0.4))
                         + ripple * lv * (0.7 * np.sin(7 * phi - t * 6) + 0.3 * np.sin(2 * lam + 3 * phi - t * 3)))
    turn = lam + t * spin
    x = rho * np.cos(turn) * surface
    z = rho * np.sin(turn) * surface
    y = np.cos(phi) * surface
    y2 = y * math.cos(ORB_TILT) - z * math.sin(ORB_TILT)
    z2 = y * math.sin(ORB_TILT) + z * math.cos(ORB_TILT)
    px, py = c + x * big_r, c + y2 * big_r
    depth = (z2[:, :-1] + z2[:, 1:]) / 2
    base = alpha * (0.85 + lv * 0.3)
    stripe = (t * 0.55) % 1.3
    width = max(1, round(0.9 * ss))
    # Hinten nur angedeutet, vorne klar: so wirkt sie räumlich
    for lo, hi, strength in ((-2.0, -0.3, 0.16), (-0.3, 0.3, 0.45), (0.3, 2.0, 1.0)):
        for i in range(ORB_RINGS):
            band = wave * math.exp(-((v[i] - stripe) ** 2) / 0.006) if wave else 0.0
            fill = color + (max(0, min(255, round(255 * base * (1 + band * 1.4) * strength))),)
            run: list = []
            for j in range(ORB_SEG):
                if lo <= depth[i, j] < hi:
                    if not run:
                        run.append((px[i, j], py[i, j]))
                    run.append((px[i, j + 1], py[i, j + 1]))
                elif run:
                    if len(run) > 1:
                        draw.line(run, fill=fill, width=width)
                    run = []
            if len(run) > 1:
                draw.line(run, fill=fill, width=width)
    lines = img.resize((size, size), Image.LANCZOS)
    out = _orb_glow(size, tint, lv, alpha).copy()
    out.alpha_composite(lines)
    return out


def _orb_glow(size: int, tint: tuple, level: float, alpha: float):
    """Leiser Schein hinter der Kugel und ein wenig Licht innen (je Größe und Stärke zwischengespeichert)."""
    import numpy as np
    from PIL import Image

    key = ("glow", size, tint, round(level, 1), round(alpha, 2))
    if key in _static_cache:
        return _static_cache[key]
    r = size / 2
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.hypot(x - r + 0.5, y - r + 0.5) / max(r, 1)
    glow = np.clip(1 - d, 0, 1) ** 2 * (0.16 + 0.3 * level) * min(1.0, alpha * 1.6)
    rgb = np.zeros((size, size, 3), np.float32) + np.array(tint, np.float32)
    data = np.dstack([rgb, np.clip(glow * 255, 0, 255)]).astype(np.uint8)
    img = Image.fromarray(data, "RGBA")
    if len(_static_cache) > 48:
        _static_cache.clear()
    _static_cache[key] = img
    return img


_static_cache: dict = {}


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
                (x, cy - height / 2, x + 3 * scale, cy + height / 2), radius=1.5 * scale, fill=(196, 206, 240, 200)
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


def _foreground_is_ours() -> bool:
    """True, wenn das Fenster ganz vorne zu Jarvis selbst gehört (sein Fenster im Vollbild ist kein Spiel)."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32")
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value == os.getpid()
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
