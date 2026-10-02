"""Jarvis auf dem Handy: Web-App, Schnittstelle mit Schlüssel, Koppeln per QR-Code."""

import json
import unittest
import urllib.error
import urllib.request
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import remote
from jarvis.remote import PhoneUi
from jarvis.server import CommandServer

TOKEN = "handy-schluessel-123456"


class FakeAssistant:
    busy = False
    gaming = False
    mute = None
    workshop = None

    def __init__(self):
        self.submitted = []
        self.stopped = 0

    def submit(self, text, speak=True):
        self.submitted.append((text, speak))

    def stop(self):
        self.stopped += 1

    def handle(self, text, speak=True):
        return "Erledigt, Sir."


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.assistant = FakeAssistant()
        self.phone = PhoneUi()
        self.server = CommandServer({"token": TOKEN, "host": "127.0.0.1", "port": 0}, self.assistant, phone=self.phone)
        self.server.start()
        self.addCleanup(self.server.stop)
        self.base = f"http://127.0.0.1:{self.server.port}"
        # Keine Proxys für den eigenen Rechner
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path, payload=None, token=TOKEN):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with self.opener.open(req, timeout=5) as response:
                body = response.read()
                kind = response.headers.get("Content-Type", "")
                return response.status, json.loads(body) if "json" in kind else body.decode("utf-8")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8")

    def test_app_is_served_without_key_but_api_needs_it(self):
        code, page = self.request("/app/", token="")
        self.assertEqual(code, 200)
        self.assertIn("Mit Jarvis verbinden", page)
        self.assertEqual(self.request("/app/handy.js", token="")[0], 200)
        self.assertEqual(self.request("/app/orb.js", token="")[0], 200)
        self.assertEqual(self.request("/app/manifest.webmanifest", token="")[0], 200)
        self.assertEqual(self.request("/app/../../server.py", token="")[0], 404)
        self.assertEqual(self.request("/app/%2e%2e/%2e%2e/server.py", token="")[0], 404)
        self.assertEqual(self.request("/api/status", token="")[0], 401)
        self.assertEqual(self.request("/api/status", token="falsch-falsch-falsch")[0], 401)

    def test_status_and_conversation(self):
        self.phone.state("thinking")
        self.phone.config(weather="14° · bewölkt · Wien")
        code, status = self.request("/api/status")
        self.assertEqual(code, 200)
        self.assertEqual((status["zustand"], status["wetter"]), ("thinking", "14° · bewölkt · Wien"))
        code, data = self.request("/api/befehl", {"text": "Öffne Spotify"})
        self.assertEqual((code, data), (200, {"ok": True}))
        self.assertEqual(self.assistant.submitted, [("Öffne Spotify", False)], "vom Handy: am PC still")
        self.request("/api/befehl", {"text": "Lauter", "sprechen": True})
        self.assertEqual(self.assistant.submitted[-1], ("Lauter", True))
        self.assertEqual(self.request("/api/befehl", {"text": "  "})[0], 400)
        self.phone.message("user", "Öffne Spotify")
        self.phone.progress({"state": "done", "label": "Öffnet Spotify"})
        self.phone.message("jarvis", "Spotify startet, Sir.")
        self.phone.message("info", "Neue Unterhaltung")  # nicht fürs Handy
        _code, data = self.request("/api/verlauf?seit=0")
        self.assertEqual([(i["art"], i["text"]) for i in data["eintraege"]],
                         [("user", "Öffne Spotify"), ("schritt", "Öffnet Spotify"), ("jarvis", "Spotify startet, Sir.")])
        last = data["eintraege"][-1]["n"]
        self.assertEqual(self.request(f"/api/verlauf?seit={last}")[1]["eintraege"], [])
        # Daran merkt die App einen Neustart von Jarvis (dann zählt er wieder ab 1)
        self.assertEqual(data["start"], self.phone.started)
        self.assertNotEqual(PhoneUi().started, self.phone.started)

    def test_iphone_home_screen_app_keeps_the_key(self):
        # Mit Schlüssel: die App vom Home-Bildschirm startet verbunden (eigener Speicher auf dem iPhone)
        _code, manifest = self.request(f"/app/manifest.webmanifest?t={TOKEN}", token="")
        manifest = json.loads(manifest) if isinstance(manifest, str) else manifest
        self.assertEqual(manifest["start_url"], f"/app/#t={TOKEN}")
        self.assertEqual(manifest["id"], "/app/")
        for query in ("", "?t=falsch-falsch-falsch", "?t="):
            _code, manifest = self.request(f"/app/manifest.webmanifest{query}", token="")
            manifest = json.loads(manifest) if isinstance(manifest, str) else manifest
            self.assertEqual(manifest["start_url"], "/app/", query)

    def test_stop_also_cancels_a_shutdown(self):
        said = []
        self.assistant.abort_power = lambda: True
        self.assistant.announce = said.append
        self.assertEqual(self.request("/api/stopp", {})[0], 200)
        self.assertEqual((self.assistant.stopped, said), (1, ["Abgebrochen, Sir. Der PC bleibt an."]))
        self.assistant.abort_power = lambda: False
        self.request("/api/stopp", {})
        self.assertEqual((self.assistant.stopped, len(said)), (2, 1))

    def test_suggestion_stop_and_root(self):
        self.phone.suggestion({"frage": "Soll ich?"})
        self.assertEqual(self.request("/api/status")[1]["vorschlag"], {"frage": "Soll ich?"})
        self.assertEqual(self.request("/api/vorschlag", {"antwort": "nie"})[0], 200)
        self.assertEqual(self.assistant.submitted[-1], ("Nie wieder", False))
        self.assertEqual(self.request("/api/vorschlag", {"antwort": "vielleicht"})[0], 400)
        self.assertEqual(self.request("/api/stopp", {})[0], 200)
        self.assertEqual(self.assistant.stopped, 1)
        self.assertEqual(self.request("/api/projekte")[1], {"projekte": []})


class PairingTest(unittest.TestCase):
    def test_url_token_and_qr(self):
        token = remote.new_token()
        self.assertGreaterEqual(len(token), 20)
        self.assertEqual(remote.app_url(token, "192.168.1.20"), f"http://192.168.1.20:8765/app/#t={token}")
        svg = remote.qr_svg(remote.app_url(token, "192.168.1.20"))
        try:
            import qrcode  # noqa: F401
        except ImportError:  # optional: ohne steht im Fenster die Adresse zum Abtippen
            self.assertEqual(svg, "")
        else:
            self.assertTrue(svg.startswith("<svg"), svg[:40])

    def test_local_ip_never_fails(self):
        self.assertTrue(remote.local_ip())
        with mock.patch("socket.socket", side_effect=OSError("kein Netz")), \
                mock.patch("socket.gethostbyname", side_effect=OSError("kein Netz")):
            self.assertEqual(remote.local_ip(), "127.0.0.1")

    def test_window_switches_the_phone_connection_on_and_off(self):
        import tempfile
        from pathlib import Path

        from jarvis.gui.app import Api, GuiBridge

        assistant = FakeAssistant()
        assistant._cfg = {"server": {"enabled": False, "token": "", "host": "127.0.0.1", "port": 0}}
        assistant.server = None
        assistant.phone = PhoneUi()
        api = Api(GuiBridge(), assistant, None)
        started = []

        def start():
            server = CommandServer(assistant._cfg["server"], assistant, phone=assistant.phone)
            server.start()
            assistant.server = server
            started.append(server)

        api._start_server = start
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.toml"
            with mock.patch("jarvis.config.CONFIG_PATH", config):
                info = api.phone_enable(True)
                self.assertTrue(info["enabled"])
                self.assertTrue(info["running"])
                self.assertIn("/app/#t=", info["url"])
                self.assertIn("token", config.read_text(encoding="utf-8"))
                first = assistant._cfg["server"]["token"]
                info = api.phone_new_key()
                self.assertNotEqual(assistant._cfg["server"]["token"], first, "neu koppeln: neuer Schlüssel")
                info = api.phone_enable(False)
                self.assertFalse(info["enabled"])
                self.assertIsNone(assistant.server)


if __name__ == "__main__":
    unittest.main()


class ConnectionDotsTest(unittest.TestCase):
    """Die Punkte am Knopf "Verbinden": was läuft, ohne Netzwerkabfrage."""

    def test_connections(self):
        from jarvis.gui.app import Api

        api = Api.__new__(Api)
        api._assistant = mock.Mock(_cfg={"discord": {"bot_token": "x" * 72}},
                                   server=mock.Mock(running=True), alexa=mock.Mock(connected=False))
        self.assertEqual(api.connections(), {"phone": True, "alexa": False, "discord": True, "iphone": False,
                                             "mail": False})
        api._assistant = mock.Mock(_cfg={}, server=None, alexa=None)
        self.assertEqual(api.connections(), {"phone": False, "alexa": False, "discord": False, "iphone": False,
                                             "mail": False})
