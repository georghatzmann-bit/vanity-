"""
BuildDuel - kleiner lokaler Server (wird von start.bat gestartet)

Warum nicht einfach "python -m http.server"?
  1. Unter Windows liefert Python .js-Dateien manchmal mit dem falschen Typ
     aus (je nach Registry "text/plain"). Dann laedt der Browser das Spiel
     nicht. Hier stehen die richtigen Typen fest im Code.
  2. "Kein Zwischenspeichern": Nach einem Update siehst du sofort die neue
     Version und nicht eine alte aus dem Browser-Speicher.
  3. Ist Port 8000 belegt, nimmt der Server automatisch 8001, 8002 ...
  4. Er oeffnet den Browser erst, wenn er wirklich bereit ist.
  5. Er hoert nur auf diesem PC (127.0.0.1) - niemand im WLAN kann zugreifen,
     und die Windows-Firewall fragt nicht nach.

Aufruf:  python tools/server.py [--port 8000] [--no-browser]
Beenden: Fenster schliessen oder Strg + C
"""

import sys

# Zuerst die Version pruefen - die Module weiter unten gibt es in Python 2 nicht.
# Fehler-Code 3 sagt start.bat: "Python zu alt, versuch Node.js".
if sys.version_info < (3, 6):
    print("Python ist zu alt (mindestens 3.6 noetig). Bitte neu installieren: https://www.python.org/downloads/")
    sys.exit(3)

import argparse  # noqa: E402
import errno  # noqa: E402
import http.server  # noqa: E402
import os  # noqa: E402
import socketserver  # noqa: E402
import threading  # noqa: E402
import webbrowser  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Ordner BuildDuel
HOST = "127.0.0.1"
PORTS_TO_TRY = 11  # 8000 bis 8010

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # "directory" gibt es erst ab Python 3.7 - darum oben os.chdir(ROOT)
        super().__init__(*args, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME_TYPES:
            return MIME_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Nur Probleme anzeigen (z. B. "404 = Datei nicht gefunden"), sonst Ruhe im Fenster.
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        if status >= 400:
            print("  Hinweis: {} -> Fehler {}".format(self.path, status))

    def log_error(self, *args):
        pass  # wird schon in log_request gemeldet


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # Unter Windows erlaubt "reuse address", dass ZWEI Server denselben Port
    # belegen - dann weiss man nie, wer antwortet. Darum dort ausschalten.
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        # Abgebrochene Verbindungen (Tab geschlossen, neu geladen) sind normal.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def open_server(first_port):
    last_error = None
    for port in range(first_port, first_port + PORTS_TO_TRY):
        try:
            return Server((HOST, port), Handler), port
        except OSError as exc:
            last_error = exc
            in_use = exc.errno in (errno.EADDRINUSE, errno.EACCES, 10048, 10013)
            if not in_use:
                raise
    raise last_error


def main():
    parser = argparse.ArgumentParser(description="BuildDuel lokaler Server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="Browser nicht automatisch oeffnen")
    args = parser.parse_args()

    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        print("FEHLER: index.html nicht gefunden in " + ROOT)
        print("Bitte den ganzen Ordner BuildDuel entpacken und start.bat darin starten.")
        return 2

    os.chdir(ROOT)
    try:
        server, port = open_server(args.port)
    except OSError as exc:
        print("FEHLER: Kein freier Port zwischen {} und {} gefunden ({}).".format(
            args.port, args.port + PORTS_TO_TRY - 1, exc))
        print("Schliesse andere Server-Fenster (z. B. ein zweites start.bat) und versuche es nochmal.")
        return 4

    url = "http://localhost:{}/".format(port)
    print("")
    print("  BuildDuel laeuft:  " + url)
    print("  Tests:             " + url + "tests/tests.html")
    print("")
    if port != args.port:
        print("  Hinweis: Port {} war belegt, darum jetzt Port {}.".format(args.port, port))
        print("  Gespeicherte Einstellungen gelten pro Adresse - am besten das andere")
        print("  Programm auf Port {} schliessen und start.bat neu starten.".format(args.port))
        print("")
    print("  Dieses Fenster OFFEN lassen, solange du spielst.")
    print("  Beenden: Fenster schliessen oder Strg + C druecken.")
    print("")
    sys.stdout.flush()

    if not args.no_browser:
        # Kurz warten, bis serve_forever laeuft, dann Browser oeffnen.
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server beendet.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
