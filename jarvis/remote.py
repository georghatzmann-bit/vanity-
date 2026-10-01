"""Jarvis auf dem Handy: eine Web-App, die der PC selbst ausliefert (im WLAN, kein App-Store).

Georg scannt im Jarvis-Fenster einen QR-Code, das Handy öffnet die App (http://<PC>:8765/app/)
und merkt sich den Schlüssel. Danach: Jarvis schreiben (oder mit dem Mikrofon der
Handy-Tastatur diktieren), Schnellaktionen, Vorschläge beantworten, Werkstatt-Projekte
ansehen. Jeder Aufruf der Schnittstelle braucht den geheimen Schlüssel aus config.toml.

Von unterwegs: Tailscale (kostenlos) auf PC und Handy, dann geht dieselbe Adresse überall.
"""

from __future__ import annotations

import collections
import io
import itertools
import logging
import secrets
import socket
import threading
import time

from .ui import Ui

log = logging.getLogger(__name__)

PORT = 8765


class PhoneUi(Ui):
    """Merkt sich die letzten Nachrichten und Arbeitsschritte für die Handy-App."""

    KEEP = 80

    def __init__(self) -> None:
        self._items: collections.deque = collections.deque(maxlen=self.KEEP)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self.state_value = "idle"
        self.offer: dict | None = None
        self.weather = ""
        self.muted = False

    def _add(self, item: dict) -> None:
        with self._lock:
            item["n"] = next(self._ids)
            item["zeit"] = time.strftime("%H:%M")
            self._items.append(item)

    def state(self, value: str) -> None:
        self.state_value = value

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        if not final or role not in ("user", "jarvis") or not str(text).strip():
            return
        self._add({"art": role, "text": str(text)})

    def toast(self, text: str, kind: str = "info") -> None:
        if kind == "error":
            self._add({"art": "fehler", "text": str(text)})

    def progress(self, step: dict) -> None:
        if step.get("state") == "done" and step.get("label") and not step.get("workshop"):
            self._add({"art": "schritt", "text": str(step["label"])})

    def config(self, **values) -> None:
        if "weather" in values:
            self.weather = str(values.get("weather") or "")
        if "muted" in values:
            self.muted = bool(values.get("muted"))

    def suggestion(self, offer: dict | None) -> None:
        self.offer = offer

    def since(self, number: int = 0) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._items if item["n"] > number]


def new_token() -> str:
    return secrets.token_urlsafe(18)


def local_ip() -> str:
    """Die Adresse des PCs im WLAN/LAN (z. B. 192.168.1.20). Es wird nichts gesendet."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            address = probe.getsockname()[0]
            if address and not address.startswith("127."):
                return address
    except OSError:
        pass
    try:
        address = socket.gethostbyname(socket.gethostname())
        if address and not address.startswith("127."):
            return address
    except OSError:
        pass
    return "127.0.0.1"


def mac_address(ip: str | None = None) -> str:
    """MAC-Adresse der Netzwerkkarte mit dieser Adresse (für "PC einschalten" per Wake-on-LAN)."""
    ip = ip or local_ip()
    try:
        import psutil

        for _name, addresses in psutil.net_if_addrs().items():
            if not any(a.family == socket.AF_INET and a.address == ip for a in addresses):
                continue
            for address in addresses:
                text = str(address.address)
                if len(text) == 17 and text.count(text[2]) == 5 and text[2] in "-:":
                    return text.replace("-", ":").upper()
    except Exception as exc:
        log.debug("MAC-Adresse: %s", exc)
    return ""


def app_url(token: str, ip: str | None = None, port: int = PORT) -> str:
    """Die Adresse für das Handy. Der Schlüssel steht hinter #, geht also nie ins Netz-Protokoll."""
    return f"http://{ip or local_ip()}:{port}/app/#t={token}"


def qr_svg(text: str) -> str:
    """QR-Code als SVG (braucht das Paket qrcode). Leer, wenn es fehlt."""
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return ""
    image = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buffer = io.BytesIO()
    image.save(buffer)
    svg = buffer.getvalue().decode("utf-8")
    return svg[svg.index("<svg"):] if "<svg" in svg else svg
