"""Web-Eingang von Jarvis: die Handy-App und der Weg für Home Assistant und Alexa.

Handy-App (siehe remote.py):
GET  /app/                 die Web-App (frei abrufbar, ohne Schlüssel nutzlos)
GET  /api/status           Zustand, Wetter, offener Vorschlag, Werkstatt
GET  /api/verlauf?seit=N   neue Nachrichten und Arbeitsschritte
POST /api/befehl           {"text": "Öffne Spotify", "sprechen": false}
POST /api/vorschlag        {"antwort": "ja" | "nein" | "nie"}
POST /api/stopp
GET  /api/projekte         die Werkstatt-Projekte

Home Assistant / Alexa:
POST /befehl  {"text": "Mach Musik an", "alexa": "wohnzimmer", "sprechen": true}  (wartet auf die Antwort)
GET  /status

Jede Anfrage an /api und /befehl braucht den Kopf "Authorization: Bearer <token>" aus config.toml.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent / "gui" / "web" / "handy"
TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
}


def make_handler(assistant, token: str, homeassistant=None, phone=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Jarvis/2"

        def log_message(self, fmt, *args):  # nicht in die Konsole
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, code: int, payload: dict | list) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            given = header[7:] if header.startswith("Bearer ") else ""
            return bool(token) and hmac.compare_digest(given.encode(), token.encode())

        def _json(self) -> dict:
            length = min(int(self.headers.get("Content-Length", 0) or 0), 20_000)
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError("kein Objekt")
            return data

        def _static(self, path: str, query: str = "") -> None:
            name = path[len("/app"):].strip("/") or "index.html"
            target = (APP_DIR / name).resolve()
            if APP_DIR not in target.parents or not target.is_file() or target.suffix not in TYPES:
                return self._send(404, {"fehler": "Unbekannt"})
            body = target.read_bytes()
            if target.suffix == ".webmanifest":
                body = _manifest(body, query, token)
            self.send_response(200)
            self.send_header("Content-Type", TYPES[target.suffix])
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "/app/")
                self.end_headers()
                return
            if path == "/app" or path.startswith("/app/"):
                return self._static(parsed.path, parsed.query)
            if not self._authorized():
                return self._send(401, {"fehler": "Token fehlt oder falsch"})
            if path == "/status":
                return self._send(200, {"ok": True, "beschaeftigt": assistant.busy})
            if path == "/api/status":
                return self._send(200, _status(assistant, phone))
            if path == "/api/verlauf":
                query = urllib.parse.parse_qs(parsed.query)
                try:
                    since = int((query.get("seit") or ["0"])[0])
                except ValueError:
                    since = 0
                return self._send(200, {"eintraege": phone.since(since) if phone is not None else [],
                                        "start": getattr(phone, "started", "")})
            if path == "/api/projekte":
                shop = getattr(assistant, "workshop", None)
                items = shop.projects()[:30] if shop is not None else []
                keep = ("name", "state", "task", "summary", "updated", "model", "start", "folder")
                return self._send(200, {"projekte": [{k: p.get(k) for k in keep} for p in items]})
            return self._send(404, {"fehler": "Unbekannt"})

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path.rstrip("/")
            if not self._authorized():
                return self._send(401, {"fehler": "Token fehlt oder falsch"})
            try:
                data = self._json()
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"fehler": "JSON erwartet"})
            if path == "/api/befehl":
                text = str(data.get("text", "")).strip()[:2000]
                if not text:
                    return self._send(400, {"fehler": "Feld 'text' ist leer"})
                log.info("Befehl vom Handy: %s", text)
                assistant.submit(text, speak=bool(data.get("sprechen", False)))
                return self._send(200, {"ok": True})
            if path == "/api/vorschlag":
                answer = {"ja": "Ja", "nein": "Nein", "nie": "Nie wieder"}.get(str(data.get("antwort", "")))
                if not answer:
                    return self._send(400, {"fehler": "antwort: ja, nein oder nie"})
                assistant.submit(answer, speak=False)
                return self._send(200, {"ok": True})
            if path == "/api/stopp":
                assistant.stop()
                # Wie der Stopp-Knopf im Fenster: auch ein angekündigtes Herunterfahren
                abort = getattr(assistant, "abort_power", None)
                if abort is not None and abort():
                    assistant.announce("Abgebrochen, Sir. Der PC bleibt an.")
                return self._send(200, {"ok": True})
            if path == "/befehl":
                text = str(data.get("text", "")).strip()
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
            return self._send(404, {"fehler": "Unbekannt"})

    return Handler


def _manifest(body: bytes, query: str, token: str) -> bytes:
    """Auf dem iPhone hat die App auf dem Home-Bildschirm einen eigenen Speicher, getrennt von
    Safari, und startet mit start_url. Fragt die App mit dem richtigen Schlüssel, steht er deshalb
    auch in start_url, sonst wäre sie nach dem Hinzufügen nicht verbunden."""
    given = (urllib.parse.parse_qs(query).get("t") or [""])[0]
    if not token or not hmac.compare_digest(given.encode(), token.encode()):
        return body
    data = json.loads(body.decode("utf-8"))
    data["id"] = data.get("id") or data.get("start_url") or "/app/"
    data["start_url"] = "/app/#t=" + token
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def _status(assistant, phone) -> dict:
    shop = getattr(assistant, "workshop", None)
    job = getattr(shop, "job", None) if shop is not None else None
    workshop = None
    if job is not None:
        done = sum(1 for t in job.todos if t.get("state") == "completed")
        workshop = {"auftrag": job.task, "zustand": job.state, "schritte": len(job.todos), "erledigt": done,
                    "zusammenfassung": job.summary}
    mute = getattr(assistant, "mute", None)
    return {
        "ok": True,
        "zustand": getattr(phone, "state_value", "idle") if phone is not None else "idle",
        "beschaeftigt": bool(assistant.busy),
        "stumm": bool(mute is not None and mute.muted),
        "gaming": bool(getattr(assistant, "gaming", False)),
        "wetter": getattr(phone, "weather", "") if phone is not None else "",
        "vorschlag": getattr(phone, "offer", None) if phone is not None else None,
        "werkstatt": workshop,
    }


class CommandServer:
    def __init__(self, cfg: dict, assistant, homeassistant=None, phone=None) -> None:
        self._token = cfg.get("token", "")
        self._host = cfg.get("host", "0.0.0.0")
        self._port = int(cfg.get("port", 8765))
        self._assistant = assistant
        self._ha = homeassistant
        self._phone = phone
        self._server: ThreadingHTTPServer | None = None

    @property
    def running(self) -> bool:
        return self._server is not None

    @property
    def port(self) -> int:
        return self._server.server_address[1] if self._server is not None else self._port

    def start(self) -> str:
        if len(self._token) < 12:
            raise ValueError("Für den Web-Eingang braucht [server] in config.toml ein token mit mindestens 12 Zeichen.")
        handler = make_handler(self._assistant, self._token, self._ha, self._phone)
        self._server = ThreadingHTTPServer((self._host, self._port), handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, name="jarvis-web", daemon=True).start()
        return f"http://{self._host}:{self.port}/"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
