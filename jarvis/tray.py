"""Tray-Icon unten rechts neben der Uhr: Fenster zeigen, stumm schalten, beenden."""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


ACCENT = (76, 157, 255, 255)
MUTED = (240, 85, 90, 255)


def make_icon_image(size: int = 64, muted: bool = False):
    """Das Jarvis-Zeichen: ein Ring mit Punkt. Blau, stumm rot. Vierfach groß gezeichnet
    und verkleinert, damit die Kanten auch in 16 Pixeln glatt sind."""
    from PIL import Image, ImageDraw

    big = size * 4
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    color = MUTED if muted else ACCENT
    ring = max(4, round(big * 0.09))
    pad = ring // 2 + round(big * 0.06)
    draw.ellipse((pad, pad, big - 1 - pad, big - 1 - pad), outline=color, width=ring)
    dot = big * 0.2
    c = big / 2
    draw.ellipse((c - dot, c - dot, c + dot, c + dot), fill=color)
    return image.resize((size, size), Image.LANCZOS)


def save_app_icon(path) -> None:
    """Symbol für die Desktop-Verknüpfung (werkzeuge/installieren.ps1): das Jarvis-Zeichen
    auf einer dunklen, abgerundeten Fläche, in allen Größen, die Windows braucht."""
    from PIL import Image, ImageDraw

    size = 256
    big = size * 4
    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((8, 8, big - 9, big - 9), radius=big // 5, fill=(21, 25, 34, 255))
    tile = tile.resize((size, size), Image.LANCZOS)
    mark = make_icon_image(160)
    tile.alpha_composite(mark, (48, 48))
    tile.save(str(path), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


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
