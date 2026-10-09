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
from jarvis import autostart, pc, tool
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
        # Schon vorbei: dann morgen. "08:00" ist eindeutig, "8:00" um 15:20 heißt 20 Uhr.
        self.assertEqual(parse_when("08:00", NOW), dt.datetime(2026, 10, 1, 8, 0))
        self.assertEqual(parse_when("8:00", NOW), dt.datetime(2026, 9, 30, 20, 0))
        self.assertEqual(parse_when("morgen um 7", NOW), dt.datetime(2026, 10, 1, 7, 0))
        self.assertEqual(parse_when("übermorgen 9.15", NOW), dt.datetime(2026, 10, 2, 9, 15))
        self.assertEqual(parse_when("2026-10-05 08:00", NOW), dt.datetime(2026, 10, 5, 8, 0))

    def test_nonsense_is_rejected(self):
        for text in ("irgendwann", "in vielen Jahren", "25:00", "24:00", "in -5 minuten", "in 1e9 stunden",
                     "in 0 Minuten", "morgen", "in 100000 Tagen", "31.2. um 8"):
            with self.subTest(text=text), self.assertRaises(WhenError):
                parse_when(text, NOW)

    def test_spoken(self):
        self.assertEqual(spoken_when(dt.datetime(2026, 9, 30, 18, 5), NOW), "heute um 18:05 Uhr")
        self.assertEqual(spoken_when(dt.datetime(2026, 10, 1, 8, 0), NOW), "morgen um 8:00 Uhr")


EVENING = dt.datetime(2026, 9, 30, 19, 45, 10)  # ein Mittwoch


class ParseWhenMoreTest(unittest.TestCase):
    def check(self, cases, now=EVENING):
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_when(text, now), expected)

    def test_relative(self):
        after = lambda **kw: EVENING + dt.timedelta(**kw)  # noqa: E731
        self.check({
            "in anderthalb Stunden": after(minutes=90),
            "in eineinhalb Stunden": after(minutes=90),
            "in einer Woche": after(days=7),
            "in einer Viertelstunde": after(minutes=15),
            "in zwölf Minuten": after(minutes=12),
            "in elf Minuten": after(minutes=11),
            "in fünfundzwanzig Minuten": after(minutes=25),
            "in neunundfünfzig Minuten": after(minutes=59),
            "in 2 Stunden und 30 Minuten": after(hours=2, minutes=30),
            "in 1 Stunde 30 Minuten": after(minutes=90),
            "in 10 Min.": after(minutes=10),
            "in 45 min.": after(minutes=45),
            "in 10 Minuten!": after(minutes=10),
            '"in 10 minuten"': after(minutes=10),
            "in ner halben Stunde": after(minutes=30),
        })

    def test_twelve_hours_later_when_the_morning_is_over(self):
        self.check({
            "um 8": dt.datetime(2026, 9, 30, 20, 0),
            "8 Uhr": dt.datetime(2026, 9, 30, 20, 0),
            "heute um 8": dt.datetime(2026, 9, 30, 20, 0),
            "um viertel nach acht": dt.datetime(2026, 9, 30, 20, 15),
            "viertel vor neun": dt.datetime(2026, 9, 30, 20, 45),
            # 7 und 19 Uhr sind beide vorbei: morgen früh.
            "um 7": dt.datetime(2026, 10, 1, 7, 0),
            "halb acht": dt.datetime(2026, 10, 1, 7, 30),
            # Früh, morgens und vormittags bleiben am Vormittag.
            "um 8 früh": dt.datetime(2026, 10, 1, 8, 0),
            "morgens um 8": dt.datetime(2026, 10, 1, 8, 0),
            "vormittags um 10": dt.datetime(2026, 10, 1, 10, 0),
            "morgen früh um 8": dt.datetime(2026, 10, 1, 8, 0),
            "morgen um 8": dt.datetime(2026, 10, 1, 8, 0),
            "08:00": dt.datetime(2026, 10, 1, 8, 0),
        })

    def test_day_and_daytime(self):
        self.check({
            "heute Abend um 8": dt.datetime(2026, 9, 30, 20, 0),
            "heute Abend 20:00": dt.datetime(2026, 9, 30, 20, 0),
            "um 8 Uhr abends": dt.datetime(2026, 9, 30, 20, 0),
            "12 Uhr mittags": dt.datetime(2026, 10, 1, 12, 0),
            "morgen abend um 7": dt.datetime(2026, 10, 1, 19, 0),
            "heute Nacht um 2": dt.datetime(2026, 10, 1, 2, 0),
            "Montag um 9": dt.datetime(2026, 10, 5, 9, 0),
            "am Montag um 9 Uhr": dt.datetime(2026, 10, 5, 9, 0),
            "nächsten Mittwoch um 8": dt.datetime(2026, 10, 7, 8, 0),
            "1.10. um 8": dt.datetime(2026, 10, 1, 8, 0),
            "am 1.10. um 8 Uhr": dt.datetime(2026, 10, 1, 8, 0),
            "01.10.2026 08:00": dt.datetime(2026, 10, 1, 8, 0),
            "1.1. um 8": dt.datetime(2027, 1, 1, 8, 0),
            "acht Uhr dreißig": dt.datetime(2026, 9, 30, 20, 30),
        })

    def test_past_times_are_explained(self):
        for text in ("heute 19:00", "heute um 7", "2026-09-30 08:00", "01.01.2026 08:00"):
            with self.subTest(text=text), self.assertRaises(WhenError) as ctx:
                parse_when(text, EVENING)
            self.assertIn("Vergangenheit", str(ctx.exception))
            self.assertIn("30.09.2026 19:45", str(ctx.exception))

    def test_errors_show_the_time_and_examples(self):
        with self.assertRaises(WhenError) as ctx:
            parse_when("irgendwann", EVENING)
        message = str(ctx.exception)
        self.assertIn("Zeit nicht verstanden", message)
        self.assertIn("Mittwoch, 30.09.2026 19:45", message)
        self.assertIn("morgen um 8", message)


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

    def careful(self):
        """Ohne volle Freigabe ([rechte] volle_freigabe = false)."""
        cfg = tool.load_config()
        cfg["rechte"] = {"volle_freigabe": False}
        return mock.patch.object(tool, "load_config", return_value=cfg)

    def test_full_permission_needs_no_yes(self):
        with mock.patch("jarvis.pc.to_recycle_bin", return_value="In den Papierkorb verschoben") as trash, \
                mock.patch("jarvis.apps.uninstall", return_value="ok") as uninstall:
            self.assertEqual(run_tool("papierkorb", "C:\\Users\\georg\\Desktop\\alt.txt", said="Lösch alt.txt")[0], 0)
            self.assertEqual(run_tool("deinstallieren", "Spotify.Spotify", said="Deinstallier Spotify")[0], 0)
        trash.assert_called_once()
        uninstall.assert_called_once_with("Spotify.Spotify")

    def test_recycle_bin_needs_a_yes(self):
        with self.careful(), mock.patch("jarvis.pc.to_recycle_bin", return_value="In den Papierkorb verschoben") as trash:
            code, out = run_tool("papierkorb", "C:\\Users\\georg\\Desktop\\alt.txt", said="Lösch die Datei alt.txt")
            self.assertEqual(code, 3)
            self.assertIn("Frag Georg zuerst", out)
            trash.assert_not_called()
            code, out = run_tool("papierkorb", "C:\\Users\\georg\\Desktop\\alt.txt", said="Ja, mach das.")
            self.assertEqual(code, 0)
            trash.assert_called_once()

    def test_recycle_bin_refuses_whole_folders(self):
        with TemporaryDirectory() as home, mock.patch.object(Path, "home", return_value=Path(home)):
            home = Path(home)
            for name in ("Desktop", "Documents", "Downloads"):
                (home / name).mkdir()
            (home / "OneDrive" / "Dokumente").mkdir(parents=True)
            with mock.patch("jarvis.pc.to_recycle_bin", return_value="verschoben") as trash:
                for target in (home, home / "Desktop", home / "Downloads", home / "Documents",
                               home / "OneDrive" / "Dokumente", home.parent, Path(home.anchor)):
                    with self.subTest(target=target):
                        code, out = run_tool("papierkorb", str(target), said="Ja")
                        self.assertEqual(code, 1, out)
                        self.assertIn("nicht in den Papierkorb", out)
                trash.assert_not_called()
                code, out = run_tool("papierkorb", str(home / "Desktop" / "alt.txt"), said="Ja")
                self.assertEqual(code, 0, out)
                trash.assert_called_once()
            self.assertTrue(pc.protected(home / "Desktop"))
            self.assertFalse(pc.protected(home / "Desktop" / "Projekt"))
            with self.assertRaises(pc.PcError):
                pc.to_recycle_bin(str(home / "Downloads"))

    def test_volume_in_percent(self):
        with mock.patch("jarvis.pc.set_volume", return_value="Lautstärke auf 30 Prozent.") as set_volume:
            code, out = run_tool("lautstaerke", "30")
            self.assertEqual((code, out.strip()), (0, "Lautstärke auf 30 Prozent."))
            run_tool("lautstaerke", "70%")
        self.assertEqual([c.args for c in set_volume.call_args_list], [(30,), (70,)])
        with mock.patch("jarvis.pc.press") as press:
            self.assertEqual(pc.set_volume(30), "Lautstärke auf 30 Prozent.")
            self.assertEqual(press.call_args_list, [mock.call("volume down", 50), mock.call("volume up", 15)])
            press.reset_mock()
            self.assertEqual(pc.set_volume(150), "Lautstärke auf 100 Prozent.")
            self.assertEqual(press.call_args_list[-1], mock.call("volume up", 50))

    def test_install_runs_without_asking(self):
        with mock.patch("jarvis.pc.install", return_value="Spotify ist installiert.") as install:
            code, out = run_tool("installieren", "spotify", said="Installier Spotify")
        self.assertEqual((code, out.strip()), (0, "Spotify ist installiert."))
        install.assert_called_once_with("spotify")

    def test_uninstall_needs_a_yes(self):
        with self.careful(), mock.patch("jarvis.apps.uninstall", return_value="ok") as uninstall:
            self.assertEqual(run_tool("deinstallieren", "Spotify.Spotify", said="Deinstallier Spotify")[0], 3)
            uninstall.assert_not_called()
            self.assertEqual(run_tool("deinstallieren", "Spotify.Spotify", said="Jarvis, ja bitte")[0], 0)
            uninstall.assert_called_once_with("Spotify.Spotify")

    def test_admin_asks_only_for_destructive_commands(self):
        with mock.patch("jarvis.pc.run_admin", return_value="Erledigt.") as admin:
            code, _ = run_tool("admin", "Set-Service spooler -StartupType Manual", said="Stell den Druckdienst um")
            self.assertEqual(code, 0)
            code, out = run_tool("admin", "Remove-Item C:\\Temp\\alt -Recurse", said="Räum den Temp-Ordner auf")
            self.assertEqual(code, 3)
            self.assertIn("Frag Georg zuerst", out)
            self.assertEqual(admin.call_count, 1)
            code, _ = run_tool("admin", "Remove-Item C:\\Temp\\alt -Recurse", said="Ja, mach das.")
            self.assertEqual(code, 0)
            self.assertEqual(admin.call_count, 2)

    def test_open_and_close_programs(self):
        with mock.patch("jarvis.apps.open_app", return_value="Spotify startet.") as open_app:
            code, out = run_tool("oeffnen", "spotify")
        self.assertEqual((code, out.strip()), (0, "Spotify startet."))
        open_app.assert_called_once_with("spotify")
        from jarvis import apps

        with mock.patch("jarvis.apps.open_app", side_effect=apps.AppNotFound("Zauberei finde ich nicht im Startmenü.")):
            code, out = run_tool("oeffnen", "Zauberei")
        self.assertEqual(code, 1)
        self.assertIn("programme", out)
        with mock.patch("jarvis.apps.close_app", return_value="Discord ist zu.") as close_app:
            self.assertEqual(run_tool("schliessen", "discord")[1].strip(), "Discord ist zu.")
        close_app.assert_called_once_with("discord")

    def test_confirmation_words(self):
        for said in ("Ja", "Ja, bitte.", "Jawohl", "Okay, mach.", "Mach das", "Los!", "Genau", "Jaja", "Na klar.",
                     "Sicher.", "Natürlich.", "Gern.", "Mach's.", "Tu's.", "Yes.", "Los geht's.", "Hm, ja.", "Ähm, ja.",
                     "Okay, Jarvis.", "Jarvis, ja.", "In Ordnung.", "Auf jeden Fall.", "Ja, lösch sie.", "Ja, gerne doch."):
            with self.subTest(said=said):
                self.assertTrue(tool.confirmed(said))
        for said in ("", "Mach das Licht aus", "Lösch alles", "Nein", "Ja wie wäre es wenn du erst noch nachschaust ob",
                     "Ok, nein, doch nicht.", "Okay, warte mal.", "Ja nicht löschen!", "Klar, aber erst morgen.",
                     "Ja, aber nicht den Ordner Bilder.", "Okay, lösch den Ordner Downloads.", "Okay, installier mir Spotify.",
                     "Genau, lösch alles auf dem Desktop.", "Ja, und installier auch noch VLC.", "Ja, äh, nein.",
                     "Nee.", "Moment.", "Ja, stopp.", "Halt!", "Abbrechen.", "Lieber nicht.", "Jarvis.", "Ja?", "Schon gut."):
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


class FakeRegistry:
    def __init__(self):
        self.value = None

    def get(self):
        return self.value

    def set(self, value):
        self.value = value

    def delete(self):
        had, self.value = self.value is not None, None
        return had


class AutostartTest(unittest.TestCase):
    def test_command_starts_hidden_without_console(self):
        line = autostart.command(Path("C:/Users/georg/AppData/Local/Programs/Jarvis"),
                                 Path("C:/Users/georg/AppData/Local/Jarvis/venv/Scripts/pythonw.exe"))
        self.assertEqual(
            line,
            '"C:/Users/georg/AppData/Local/Jarvis/venv/Scripts/pythonw.exe" '
            '"C:/Users/georg/AppData/Local/Programs/Jarvis/Jarvis.pyw" --hintergrund',
        )

    def test_enable_and_disable_and_old_file_goes(self):
        reg = FakeRegistry()
        with TemporaryDirectory() as tmp, mock.patch.dict("os.environ", {"APPDATA": tmp}):
            old = autostart.startup_dir()
            old.mkdir(parents=True)
            (old / "Jarvis.cmd").write_text("@echo off")
            autostart.enable(reg)
            self.assertIn("--hintergrund", reg.value)
            self.assertFalse((old / "Jarvis.cmd").exists())
            self.assertTrue(autostart.enabled(reg))
            self.assertTrue(autostart.disable(reg))
            self.assertFalse(autostart.enabled(reg))
            self.assertFalse(autostart.disable(reg))

    def test_launcher_file_exists(self):
        from jarvis.config import ROOT

        self.assertIn("from jarvis.__main__ import main", (ROOT / "Jarvis.pyw").read_text(encoding="utf-8"))


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
