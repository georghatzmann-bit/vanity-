"""Kleiner Web-Eingang, über den Home Assistant (und damit Alexa) Jarvis Befehle schicken kann.

POST /befehl  {"text": "Mach Musik an", "alexa": "wohnzimmer", "sprechen": true}
GET  /status
Jede Anfrage braucht den Kopf "Authorization: Bearer <token>" aus config.toml.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger(__name__)


def make_handler(assistant, token: str, homeassistant=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Jarvis/1"

        def log_message(self, fmt, *args):  # nicht in die Konsole
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            given = header[7:] if header.startswith("Bearer ") else ""
            return bool(token) and hmac.compare_digest(given.encode(), token.encode())

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {"fehler": "Token fehlt oder falsch"})
            if self.path.rstrip("/") == "/status":
                return self._send(200, {"ok": True, "beschaeftigt": assistant.busy})
            return self._send(404, {"fehler": "Unbekannt"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"fehler": "Token fehlt oder falsch"})
            if self.path.rstrip("/") != "/befehl":
                return self._send(404, {"fehler": "Unbekannt"})
            try:
                length = min(int(self.headers.get("Content-Length", 0)), 20_000)
                data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                text = str(data.get("text", "")).strip()
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"fehler": "JSON mit Feld 'text' erwartet"})
            if not text:
                return self._send(400, {"fehler": "Feld 'text' ist leer"})
            log.info("Befehl von Home Assistant: %s", text)
            answer = assistant.handle(text, speak=bool(data.get("sprechen", True)))
            room = data.get("alexa")
            if room and homeassistant is not None and answer:
                try:
                    homeassistant.announce(str(room), answer)
                except Exception as exc:
                    log.warning("Alexa-Ansage fehlgeschlagen: %s", exc)
            return self._send(200, {"antwort": answer})

    return Handler


class CommandServer:
    def __init__(self, cfg: dict, assistant, homeassistant=None) -> None:
        self._token = cfg.get("token", "")
        self._host = cfg.get("host", "0.0.0.0")
        self._port = int(cfg.get("port", 8765))
        self._assistant = assistant
        self._ha = homeassistant
        self._server: ThreadingHTTPServer | None = None

    def start(self) -> str:
        if len(self._token) < 12:
            raise ValueError("Für den Web-Eingang braucht [server] in config.toml ein token mit mindestens 12 Zeichen.")
        handler = make_handler(self._assistant, self._token, self._ha)
        self._server = ThreadingHTTPServer((self._host, self._port), handler)
        threading.Thread(target=self._server.serve_forever, name="jarvis-web", daemon=True).start()
        return f"http://{self._host}:{self._port}/befehl"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
