"""Tray-Icon unten rechts neben der Uhr: Fenster zeigen, stumm schalten, beenden."""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def make_icon_image(size: int = 64, muted: bool = False):
    """Zeichnet einen kleinen Arc Reactor als Symbol."""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    color = (255, 77, 94, 255) if muted else (79, 216, 255, 255)
    glow = (color[0], color[1], color[2], 90)
    s = size
    draw.ellipse((2, 2, s - 3, s - 3), outline=glow, width=max(2, s // 16))
    draw.ellipse((s * 0.14, s * 0.14, s * 0.86, s * 0.86), outline=color, width=max(2, s // 12))
    for i in range(8):
        import math

        angle = i * math.pi / 4
        r1, r2 = s * 0.24, s * 0.34
        cx = cy = s / 2
        draw.line(
            (cx + r1 * math.cos(angle), cy + r1 * math.sin(angle), cx + r2 * math.cos(angle), cy + r2 * math.sin(angle)),
            fill=color,
            width=max(1, s // 20),
        )
    draw.ellipse((s * 0.36, s * 0.36, s * 0.64, s * 0.64), fill=(220, 248, 255, 255) if not muted else color)
    return image


def save_app_icon(path) -> None:
    """Symbol für die Desktop-Verknüpfung (werkzeuge/installieren.ps1):
    leuchtender Arc Reactor auf dunklem Kreis, in allen Größen, die Windows braucht."""
    from PIL import Image, ImageDraw, ImageFilter

    size = 256
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((6, 6, size - 7, size - 7), fill=(5, 12, 22, 255), outline=(79, 216, 255, 110), width=5)
    reactor = make_icon_image(196)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow.alpha_composite(reactor, (30, 30))
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)))
    image.alpha_composite(glow)
    image.save(str(path), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


class Tray:
    def __init__(self, on_show, on_toggle_mute, on_quit, is_muted) -> None:
        self._on_show = on_show
        self._on_toggle_mute = on_toggle_mute
        self._on_quit = on_quit
        self._is_muted = is_muted
        self._icon = None

    def start(self) -> bool:
        try:
            import pystray

            menu = pystray.Menu(
                pystray.MenuItem("Jarvis anzeigen", lambda: self._on_show(), default=True),
                pystray.MenuItem(
                    "Mikrofon stumm", lambda: self._on_toggle_mute(), checked=lambda _item: self._is_muted()
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Jarvis beenden", lambda: self._on_quit()),
            )
            self._icon = pystray.Icon("jarvis", make_icon_image(), "Jarvis", menu)
            self._icon.run_detached()
            return True
        except Exception as exc:
            log.warning("Tray-Icon nicht möglich: %s", exc)
            self._icon = None
            return False

    def set_muted(self, muted: bool) -> None:
        if self._icon is None:
            return
        try:
            self._icon.icon = make_icon_image(muted=muted)
            self._icon.title = "Jarvis (stumm)" if muted else "Jarvis"
            self._icon.update_menu()
        except Exception as exc:
            log.debug("Tray-Icon nicht aktualisierbar: %s", exc)

    def stop(self) -> None:
        if self._icon is not None:
            try:
                # Erst unsichtbar machen, sonst bleibt unter Windows ein "Geister-Symbol" stehen.
                self._icon.visible = False
            except Exception:
                pass
            try:
                self._icon.stop()
            except Exception:
                pass
