"""
BuildDuel - kleiner lokaler Server (wird von start.bat gestartet)

Warum nicht einfach "python -m http.server"?
  1. Unter Windows liefert Python .js-Dateien manchmal mit dem falschen Typ
     aus (je nach Registry "text/plain"). Dann laedt der Browser das Spiel
     nicht. Hier stehen die richtigen Typen fest im Code.
  2. "Kein Zwischenspeichern": Nach einem Update siehst du sofort die neue
     Version und nicht eine alte aus dem Browser-Speicher.
  3. Ist Port 8000 belegt, nimmt der Server automatisch 8001, 8002 ...
     (sperrt Windows den ganzen Bereich, dann 18000 ... oder einen freien).
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
import socket  # noqa: E402
import socketserver  # noqa: E402
import threading  # noqa: E402
import webbrowser  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Ordner BuildDuel
HOST = "127.0.0.1"
PORTS_TO_TRY = 11  # 8000 bis 8010, danach 18000 bis 18010, zuletzt ein beliebiger freier Port
IN_USE_CODES = (errno.EADDRINUSE, 10048)  # 10048 = Windows: "Adresse wird bereits verwendet"
BLOCKED_CODES = (errno.EACCES, 10013)  # 10013 = Windows: Port gesperrt (oft WSL/Docker/Hyper-V)

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


def port_answers(port):
    """True, wenn auf diesem PC schon ein anderes Programm auf dem Port antwortet.

    Wichtig unter Windows: Dort darf unser Server 127.0.0.1:8000 belegen, obwohl
    ein anderes Programm schon auf "allen Adressen" (0.0.0.0 oder ::) lauscht.
    Der Browser wuerde bei "localhost" dann womoeglich das ANDERE Programm
    erreichen. Darum vorher anklopfen - bei IPv4 und IPv6.
    """
    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.3)
                if probe.connect_ex((address, port)) == 0:
                    return True
        except OSError:
            pass  # z. B. IPv6 auf diesem PC ausgeschaltet
    return False


def error_code(exc):
    return getattr(exc, "winerror", None) or exc.errno


def open_server(first_port):
    """Sucht einen freien Port. Gibt (server, port, windows_hat_gesperrt) zurueck."""
    candidates = list(range(first_port, first_port + PORTS_TO_TRY))
    candidates += list(range(first_port + 10000, first_port + 10000 + PORTS_TO_TRY))
    candidates.append(0)  # 0 = das Betriebssystem waehlt einen freien Port
    blocked = False
    last_error = None
    for port in candidates:
        if port and port_answers(port):
            continue
        try:
            server = Server((HOST, port), Handler)
            return server, server.server_address[1], blocked
        except OSError as exc:
            last_error = exc
            code = error_code(exc)
            if code in BLOCKED_CODES:
                blocked = True
            elif code not in IN_USE_CODES:
                raise
    raise last_error or OSError("kein freier Port")


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
        server, port, blocked = open_server(args.port)
    except OSError as exc:
        print("FEHLER: Der Server konnte keinen Port oeffnen ({}).".format(exc))
        print("Starte den PC neu und versuche es nochmal. Hilft das nicht: Screenshot an Claude.")
        return 4

    url = "http://localhost:{}/".format(port)
    print("")
    print("  BuildDuel laeuft:  " + url)
    print("  Tests:             " + url + "tests/tests.html")
    print("")
    if port != args.port and blocked:
        print("  Hinweis: Windows sperrt Port {} (oft wegen WSL, Docker oder Hyper-V),".format(args.port))
        print("  darum jetzt Port {}. Das ist in Ordnung.".format(port))
        print("  Gespeicherte Einstellungen gelten aber pro Adresse.")
        print("")
    elif port != args.port:
        print("  Hinweis: Port {} war belegt, darum jetzt Port {}.".format(args.port, port))
        print("  Gespeicherte Einstellungen gelten pro Adresse - am besten das andere")
        print("  Programm auf Port {} schliessen und start.bat neu starten.".format(args.port))
        print("")
    print("  Dieses Fenster OFFEN lassen, solange du spielst.")
    print("  Beenden: Fenster schliessen oder Strg + C druecken.")
    print("")
    sys.stdout.flush()

    def open_browser():
        try:
            opened = webbrowser.open(url)
        except Exception:  # noqa: BLE001 - jeder Fehler heisst: nicht geklappt
            opened = False
        if not opened:
            print("  Browser konnte nicht geoeffnet werden. Bitte selbst oeffnen: " + url)
            sys.stdout.flush()

    if not args.no_browser:
        # Kurz warten, bis serve_forever laeuft, dann Browser oeffnen.
        threading.Timer(0.6, open_browser).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server beendet.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
