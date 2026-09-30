import datetime as dt
import io
import json
import threading
import unittest
import urllib.request
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import autostart, tool
from jarvis.homeassistant import HomeAssistant, HomeAssistantError
from jarvis.reminders import ReminderStore, WhenError, parse_when, spoken_when
from jarvis.server import CommandServer

NOW = dt.datetime(2026, 9, 30, 15, 20)


class ParseWhenTest(unittest.TestCase):
    def test_relative(self):
        self.assertEqual(parse_when("in 10 Minuten", NOW), NOW + dt.timedelta(minutes=10))
        self.assertEqual(parse_when("in einer Stunde", NOW), NOW + dt.timedelta(hours=1))
        self.assertEqual(parse_when("in einer halben Stunde", NOW), NOW + dt.timedelta(minutes=30))
        self.assertEqual(parse_when("in 1,5 Stunden", NOW), NOW + dt.timedelta(minutes=90))
        self.assertEqual(parse_when("in 30 sekunden", NOW), NOW + dt.timedelta(seconds=30))

    def test_clock_times(self):
        self.assertEqual(parse_when("18:30", NOW), dt.datetime(2026, 9, 30, 18, 30))
        self.assertEqual(parse_when("um 18 Uhr", NOW), dt.datetime(2026, 9, 30, 18, 0))
        self.assertEqual(parse_when("um 18 Uhr 45", NOW), dt.datetime(2026, 9, 30, 18, 45))
        # Schon vorbei: dann morgen.
        self.assertEqual(parse_when("8:00", NOW), dt.datetime(2026, 10, 1, 8, 0))
        self.assertEqual(parse_when("morgen um 7", NOW), dt.datetime(2026, 10, 1, 7, 0))
        self.assertEqual(parse_when("übermorgen 9.15", NOW), dt.datetime(2026, 10, 2, 9, 15))
        self.assertEqual(parse_when("2026-10-05 08:00", NOW), dt.datetime(2026, 10, 5, 8, 0))

    def test_nonsense_is_rejected(self):
        for text in ("irgendwann", "in vielen Jahren", "25:00", "um halb acht"):
            with self.subTest(text=text), self.assertRaises(WhenError):
                parse_when(text, NOW)

    def test_spoken(self):
        self.assertEqual(spoken_when(dt.datetime(2026, 9, 30, 18, 5), NOW), "heute um 18:05 Uhr")
        self.assertEqual(spoken_when(dt.datetime(2026, 10, 1, 8, 0), NOW), "morgen um 8:00 Uhr")


class ReminderStoreTest(unittest.TestCase):
    def test_add_due_remove(self):
        with TemporaryDirectory() as tmp:
            store = ReminderStore(Path(tmp) / "erinnerungen.json")
            early = store.add(NOW - dt.timedelta(minutes=1), "Tee")
            later = store.add(NOW + dt.timedelta(hours=1), "Wäsche")
            self.assertEqual([r["text"] for r in store.due(NOW)], ["Tee"])
            self.assertEqual([r["text"] for r in store.upcoming(NOW)], ["Wäsche"])
            store.remove({early["id"]})
            self.assertEqual([r["id"] for r in store.all()], [later["id"]])

    def test_locked_file_is_never_overwritten_with_nothing(self):
        with TemporaryDirectory() as tmp:
            store = ReminderStore(Path(tmp) / "erinnerungen.json")
            store.add(NOW + dt.timedelta(hours=1), "Tee")
            with mock.patch.object(Path, "read_text", side_effect=PermissionError(13, "gesperrt")):
                with mock.patch("jarvis.reminders.time.sleep"):
                    self.assertEqual(store.all(), [])  # Anzeige: einfach leer
                    with self.assertRaises(PermissionError):
                        store.add(NOW + dt.timedelta(hours=2), "Pizza")
            self.assertEqual([r["text"] for r in store.all()], ["Tee"])
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])

    def test_broken_file_is_empty(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "erinnerungen.json"
            path.write_text("{kaputt", encoding="utf-8")
            self.assertEqual(ReminderStore(path).all(), [])


def run_tool(*args, said=""):
    out = io.StringIO()
    with mock.patch.dict("os.environ", {"JARVIS_USER_SAID": said}), redirect_stdout(out):
        code = tool.main(list(args))
    return code, out.getvalue()


class ToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.patch = mock.patch.object(tool, "STATE_DIR", Path(self.tmp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_help(self):
        code, out = run_tool("hilfe")
        self.assertEqual(code, 0)
        self.assertIn("erinnern", out)

    def test_remind_and_list(self):
        code, out = run_tool("erinnern", "in 20 minuten", "Der Tee ist fertig")
        self.assertEqual(code, 0, out)
        self.assertIn("Erinnerung gespeichert", out)
        code, out = run_tool("erinnerungen")
        self.assertIn("Der Tee ist fertig", out)
        rid = out.split()[0]
        code, out = run_tool("erinnerung-loeschen", rid)
        self.assertEqual(code, 0)
        self.assertIn("Keine Erinnerungen", run_tool("erinnerungen")[1])

    def test_bad_time_is_a_readable_error(self):
        code, out = run_tool("erinnern", "irgendwann", "Tee")
        self.assertEqual(code, 1)
        self.assertIn("Zeit nicht verstanden", out)

    def test_recycle_bin_needs_a_yes(self):
        with mock.patch("jarvis.pc.to_recycle_bin", return_value="In den Papierkorb verschoben") as trash:
            code, out = run_tool("papierkorb", "C:\\Users\\georg\\Desktop\\alt.txt", said="Lösch die Datei alt.txt")
            self.assertEqual(code, 3)
            self.assertIn("Frag Georg zuerst", out)
            trash.assert_not_called()
            code, out = run_tool("papierkorb", "C:\\Users\\georg\\Desktop\\alt.txt", said="Ja, mach das.")
            self.assertEqual(code, 0)
            trash.assert_called_once()

    def test_install_needs_a_yes(self):
        with mock.patch("jarvis.pc.install", return_value="ok") as install:
            self.assertEqual(run_tool("installieren", "Spotify.Spotify", said="Installier Spotify")[0], 3)
            self.assertEqual(run_tool("installieren", "Spotify.Spotify", said="Jarvis, ja bitte")[0], 0)
            install.assert_called_once_with("Spotify.Spotify")

    def test_confirmation_words(self):
        for said in ("Ja", "Ja, bitte.", "Jawohl", "Okay, mach.", "Mach das", "Los!", "Genau"):
            with self.subTest(said=said):
                self.assertTrue(tool.confirmed(said))
        for said in ("", "Mach das Licht aus", "Lösch alles", "Nein", "Ja wie wäre es wenn du erst noch nachschaust ob"):
            with self.subTest(said=said):
                self.assertFalse(tool.confirmed(said))

    def test_unknown_command(self):
        code, out = run_tool("zaubern")
        self.assertEqual(code, 1)
        self.assertIn("Unbekannter Befehl", out)


class FakeHomeAssistant:
    """Ein winziger Home-Assistant-Nachbau für Tests."""

    def __init__(self):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, code, payload):
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.requests.append(("GET", self.path, None, self.headers.get("Authorization")))
                if self.headers.get("Authorization") != "Bearer geheim":
                    return self._reply(401, {})
                if self.path == "/api/":
                    return self._reply(200, {"message": "API running."})
                if self.path == "/api/states":
                    return self._reply(200, [
                        {"entity_id": "light.wohnzimmer", "state": "off", "attributes": {"friendly_name": "Wohnzimmer Licht"}},
                        {"entity_id": "media_player.echo_kueche", "state": "idle", "attributes": {"friendly_name": "Echo Küche"}},
                    ])
                return self._reply(404, {})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"null")
                outer.requests.append(("POST", self.path, body, self.headers.get("Authorization")))
                return self._reply(200, [])

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()


class HomeAssistantTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeHomeAssistant()
        self.ha = HomeAssistant({"url": self.fake.url, "token": "geheim", "alexa": {"Küche": "media_player.echo_kueche"}})

    def tearDown(self):
        self.fake.close()

    def test_announce_on_echo(self):
        self.assertIn("küche", self.ha.announce("küche", "Das Essen ist fertig"))
        method, path, body, auth = self.fake.requests[-1]
        self.assertEqual((method, path), ("POST", "/api/services/notify/alexa_media"))
        self.assertEqual(body, {"message": "Das Essen ist fertig", "target": ["media_player.echo_kueche"], "data": {"type": "announce"}})
        self.assertEqual(auth, "Bearer geheim")

    def test_room_names_with_and_without_umlauts(self):
        ha = HomeAssistant({"url": self.fake.url, "token": "geheim", "alexa": {"kueche": "media_player.echo_kueche", "Wohn Zimmer": "media_player.wz"}})
        self.assertEqual(ha.alexa_target("Küche"), "media_player.echo_kueche")
        self.assertEqual(ha.alexa_target("wohnzimmer"), "media_player.wz")
        self.assertEqual(ha.alexa_target("media_player.echo_bad"), "media_player.echo_bad")

    def test_unknown_room_lists_known_ones(self):
        with self.assertRaisesRegex(HomeAssistantError, "Bekannt: Küche"):
            self.ha.announce("Bad", "Hallo")

    def test_turn_on_by_friendly_name(self):
        self.assertEqual(self.ha.turn("Wohnzimmer Licht", True), "light.wohnzimmer ist an.")
        self.assertEqual(self.fake.requests[-1][1:3], ("/api/services/homeassistant/turn_on", {"entity_id": "light.wohnzimmer"}))

    def test_bad_token_and_missing_setup_are_explained(self):
        bad = HomeAssistant({"url": self.fake.url, "token": "falsch"})
        with self.assertRaisesRegex(HomeAssistantError, "token prüfen"):
            bad.ping()
        with self.assertRaisesRegex(HomeAssistantError, "noch nicht eingerichtet"):
            HomeAssistant({}).ping()

    def test_unreachable(self):
        with self.assertRaisesRegex(HomeAssistantError, "nicht erreichbar"):
            HomeAssistant({"url": "http://127.0.0.1:9", "token": "x"}, timeout=1).ping()


class CommandServerTest(unittest.TestCase):
    def test_token_protected_command(self):
        class FakeAssistant:
            busy = False
            said = []

            def handle(self, text, speak=True):
                self.said.append((text, speak))
                return "Erledigt, Sir."

        assistant = FakeAssistant()
        server = CommandServer({"token": "sehr-geheimes-wort", "host": "127.0.0.1", "port": 0}, assistant)
        server.start()
        port = server._server.server_address[1]
        try:
            def post(token, payload):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/befehl", data=json.dumps(payload).encode(), method="POST",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                )
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    return exc.code, json.loads(exc.read())

            self.assertEqual(post("falsch", {"text": "Licht an"})[0], 401)
            self.assertEqual(post("sehr-geheimes-wort", {"text": ""})[0], 400)
            code, data = post("sehr-geheimes-wort", {"text": "Licht an", "sprechen": False})
            self.assertEqual((code, data), (200, {"antwort": "Erledigt, Sir."}))
            self.assertEqual(assistant.said, [("Licht an", False)])
        finally:
            server.stop()

    def test_short_token_is_refused(self):
        with self.assertRaises(ValueError):
            CommandServer({"token": "kurz"}, None).start()


class AutostartTest(unittest.TestCase):
    def test_launcher_text(self):
        text = autostart.launcher_text(Path("C:/Users/georg/Jarvis Ordner"), Path("C:/Users/georg/Jarvis Ordner/.venv/Scripts/pythonw.exe"))
        self.assertIn("chcp 65001", text)
        self.assertIn('cd /d "C:/Users/georg/Jarvis Ordner"', text)
        self.assertIn('start "" "C:/Users/georg/Jarvis Ordner/.venv/Scripts/pythonw.exe" -m jarvis', text)
        self.assertTrue(text.endswith("\r\n"))

    def test_enable_and_disable(self):
        with TemporaryDirectory() as tmp, mock.patch.dict("os.environ", {"APPDATA": tmp}):
            path = autostart.enable()
            self.assertTrue(path.exists())
            self.assertTrue(autostart.enabled())
            self.assertTrue(autostart.disable())
            self.assertFalse(autostart.enabled())


if __name__ == "__main__":
    unittest.main()


class WeatherTest(unittest.TestCase):
    def test_current(self):
        from jarvis import weather

        answers = {
            "geocoding": {"results": [{"latitude": 48.2, "longitude": 16.37, "name": "Wien"}]},
            "forecast": {"current": {"temperature_2m": 13.6, "weather_code": 61}},
        }
        calls = []

        def fake_get(url, timeout=8.0):
            calls.append(url)
            return answers["geocoding" if "geocoding" in url else "forecast"]

        with mock.patch.object(weather, "_get", fake_get):
            source = weather.Weather("wien")
            self.assertEqual(source.current(), {"place": "Wien", "temp": 14, "text": "leichter Regen"})
            source.current()
        self.assertEqual(sum("geocoding" in c for c in calls), 1)  # Ort nur einmal suchen

    def test_unknown_place(self):
        from jarvis import weather

        with mock.patch.object(weather, "_get", lambda url, timeout=8.0: {}):
            with self.assertRaises(LookupError):
                weather.Weather("Nirgendwo").current()
