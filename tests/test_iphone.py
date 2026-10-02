"""Das iPhone im Alltag: Sprachbefehle ohne Claude, Mail-Ansagen, Befehle für Claude (jarvis.tool)
und die Oberfläche (Verbinden > iPhone und Mail)."""

import datetime as dt
import io
import json
import logging
import tempfile
import threading
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from tests.fake_icloud import MAILS, PASSWORD, USER, FakeBox, FakeICloud, FakeImap, mail
from jarvis.apple import ICloudCalendar
from jarvis.geheim import Secrets
from jarvis.kalender import Calendar
from jarvis.mail import Mailbox
from jarvis.memory import Memory


class ICloudSetup(unittest.TestCase):
    """Ein Fake-iCloud mit Kalender und Mail, ein leerer Datenordner, Jarvis' Konstanten umgebogen."""

    def setUp(self):
        self.icloud = FakeICloud()
        self.addCleanup(self.icloud.close)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.state = Path(folder.name)
        self.inbox = FakeBox({(USER, PASSWORD)}, dict(MAILS))
        self.gmail = FakeBox({("georg.test@gmail.com", "app-passwort")}, {})
        for patcher in (mock.patch.object(FakeImap, "boxes", {"imap.mail.me.com": self.inbox,
                                                              "imap.gmail.com": self.gmail}),
                        mock.patch("imaplib.IMAP4_SSL", FakeImap),
                        mock.patch.multiple("jarvis.apple", ICLOUD_CALDAV=self.icloud.caldav_url,
                                            ICLOUD_CARDDAV=self.icloud.carddav_url, TRUSTED=("127.0.0.1", "localhost"))):
            patcher.start()
            self.addCleanup(patcher.stop)
        quiet = mock.patch.object(logging.getLogger("jarvis.geheim"), "level", logging.ERROR)  # Linux: nur kodiert
        quiet.start()
        self.addCleanup(quiet.stop)
        self.secrets = Secrets(self.state / "geheim.json")


class AssistantTest(ICloudSetup):
    def setUp(self):
        super().setUp()
        from tests.test_assistant import FakeBrain, make

        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant._disk_checked = float("inf")
        self.assistant.memory = Memory(self.state / "gedaechtnis.json")
        self.secrets.set("apple", PASSWORD)
        self.assistant.mail = Mailbox(self.state, self.secrets, USER, now=lambda: dt.datetime(2026, 10, 2, 12, 0))
        self.phone = ICloudCalendar(self.icloud.account(), self.state / "icloud")
        self.assistant.calendar = Calendar(self.state / "kalender.json", apple=self.phone)
        self.assistant.calendar.refresh()

    def test_new_mails_and_who_wrote_without_claude(self):
        answer = self.assistant.handle("Hab ich neue Mails?")
        self.assertEqual(answer, "Drei neue, Sir: von Amazon, Max Mustermann und Sparkasse KölnBonn.")
        answer = self.assistant.handle("Was schreibt Max?")
        self.assertTrue(answer.startswith("Max hat "), answer)
        self.assertIn("Betreff: Grillen am Samstag? Hi Georg, alles klar, ich bringe den Grill mit.", answer, "ohne Re:")
        self.assertEqual(self.brain.asked, [])
        self.assertEqual(self.inbox.marked_read, [])
        labels = [e[1]["label"] for e in self.ui.of("progress")]
        self.assertIn("Schaut in die Mails", labels)

    def test_everything_else_about_mails_goes_to_claude(self):
        self.assistant.handle("Fass meine Mails von heute zusammen")
        self.assistant.handle("Was schreibt Lisa?")  # keine Mail von Lisa: vielleicht meint Georg etwas anderes
        self.assertEqual(self.brain.asked, ["Fass meine Mails von heute zusammen", "Was schreibt Lisa?"])

    def test_calendar_words_write_to_the_iphone(self):
        answer = self.assistant.handle("Trag übermorgen um 18 Uhr Kinoabend ein")
        self.assertTrue(answer.startswith("Eingetragen, Sir: übermorgen um 18 Uhr Kinoabend."), answer)
        stored = [o["ics"] for o in self.icloud.objects("home").values() if "SUMMARY:Kinoabend" in o["ics"]]
        self.assertEqual(len(stored), 1)
        self.assertIn("um 18 Uhr Kinoabend", self.assistant.handle("Was steht übermorgen an?"))
        self.assertTrue(self.assistant.handle("Lösch den Termin Kinoabend").startswith("Gestrichen, Sir: übermorgen"))
        self.assertFalse([o for o in self.icloud.objects("home").values() if "SUMMARY:Kinoabend" in o["ics"]])
        self.assistant.handle("Trag übermorgen um 20 Uhr Spieleabend ein")
        self.icloud.throttle = True
        answer = self.assistant.handle("Lösch den Termin Spieleabend")
        self.assertTrue(answer.startswith("Den Termin konnte ich im iPhone nicht löschen, Sir. iCloud bremst"), answer)
        self.assertEqual(self.assistant.handle("Lösch den Termin Quidditch"),
                         "Einen Termin „Quidditch“ finde ich nicht, Sir. Termine aus Kalender-Abos ändern Sie bitte dort.")
        self.assertEqual(self.brain.asked, [])

    def new_mail(self, uid, sender, subject):
        self.inbox.add(uid, mail(sender, subject, "Text", "Fri, 02 Oct 2026 13:00:00 +0200"))
        self.assistant.mail._polled = -1e9  # sonst erst in fünf Minuten wieder

    def test_important_mail_is_announced_when_georg_is_at_the_pc(self):
        self.assistant.memory.record("message", "Max", app="discord")
        push = mock.Mock(enabled=True)
        self.assistant.push = push
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            self.assistant.check_mail()  # erster Blick: nur merken
            self.new_mail(201, "Max Mustermann <max.mustermann@gmail.com>", "Kino heute?")
            self.new_mail(202, "Spiele-News <newsletter@spiele.example>", "Max Rabatt!")
            self.assistant.check_mail()
        self.assertEqual(self.speaker.said, ["Sir, eine neue Mail von Max Mustermann: Kino heute?"])
        push.send.assert_not_called()

    def test_while_gaming_or_away_it_goes_to_the_phone(self):
        self.assistant.memory.record("message", "Max", app="discord")
        push = mock.Mock(enabled=True)
        self.assistant.push = push
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=True):
            self.assistant.check_mail()
            self.new_mail(201, "Max Mustermann <max.mustermann@gmail.com>", "Kino heute?")
            self.assistant.check_mail()
        self.assertEqual(self.speaker.said, [], "beim Zocken im Vollbild nicht dazwischenreden")
        self.assertEqual(push.send.call_args.args, ("Sir, eine neue Mail von Max Mustermann: Kino heute?",))
        self.assertIn(("message", "jarvis", "Sir, eine neue Mail von Max Mustermann: Kino heute?", None, "", True),
                      self.ui.events)

    def test_busy_jarvis_keeps_the_mail_for_later_and_switch_off(self):
        self.assistant.memory.record("message", "Max", app="discord")
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            self.assistant.check_mail()
            self.new_mail(201, "Max Mustermann <max.mustermann@gmail.com>", "Kino heute?")
            self.assistant._busy = 1
            self.assistant.check_mail()
            self.assertEqual(self.speaker.said, [])
            self.assistant._busy = 0
            self.assistant.check_mail()
            self.assertEqual(self.speaker.said, ["Sir, eine neue Mail von Max Mustermann: Kino heute?"])
            self.assistant._cfg = dict(self.assistant._cfg, mail={"ansagen": False})
            self.new_mail(202, "Max Mustermann <max.mustermann@gmail.com>", "Und?")
            self.assistant.mail._said_at -= 601
            self.assistant.check_mail()
        self.assertEqual(len(self.speaker.said), 1)


class SelfTestTest(ICloudSetup):
    def check(self, cfg):
        from jarvis import selftest

        report = selftest.Report(lambda line: None)
        with mock.patch("jarvis.config.STATE_DIR", self.state):
            selftest.check_iphone(report, cfg)
        return [(c.name, c.status, c.detail) for c in report.checks]

    def test_iphone_and_mail_in_the_self_test(self):
        self.assertEqual(self.check({"apple": {"apple_id": ""}}),
                         [("iPhone (iCloud)", "ok", "nicht verbunden (optional: im Jarvis-Fenster unter Verbinden > iPhone)")])
        cfg = {"apple": {"apple_id": USER}}
        self.assertEqual(self.check(cfg)[0][:2], ("iPhone (iCloud)", "fehler"), "Passwort fehlt")
        self.secrets.set("apple", PASSWORD)
        self.assertEqual(self.check(cfg), [("iPhone (iCloud)", "ok", "3 Kalender, in 2 darf Jarvis eintragen"),
                                           ("Mail iCloud", "ok", "Anmeldung geht (nur lesen)")])
        self.secrets.set("apple", "widerrufen")
        checks = self.check(cfg)
        self.assertEqual([c[:2] for c in checks], [("iPhone (iCloud)", "fehler"), ("Mail iCloud", "fehler")])
        self.assertEqual(checks[0][2], "Apple lehnt das Passwort ab. Bitte ein neues app-spezifisches Passwort erstellen.")


class ToolTest(ICloudSetup):
    def setUp(self):
        super().setUp()
        from jarvis.config import load_config

        self.cfg = load_config()
        self.cfg["apple"] = {"apple_id": USER, "kalender": "", "ausblenden": [], "geburtstage": True, "mail": True}
        self.cfg["kalender"] = {"abos": [], "vorwarnung_minuten": 15}

    def run_tool(self, *args, connected=True):
        from jarvis import tool

        if connected:
            self.secrets.set("apple", PASSWORD)
        out = io.StringIO()
        with mock.patch.object(tool, "STATE_DIR", self.state), mock.patch.object(tool, "load_config", return_value=self.cfg), \
                redirect_stdout(out):
            code = tool.main(list(args))
        return code, out.getvalue()

    def test_appointments_go_to_the_iphone(self):
        code, out = self.run_tool("termin", "übermorgen um 18 uhr", "Kinoabend", "90")
        self.assertEqual(code, 0, out)
        self.assertIn("Termin eingetragen: übermorgen um 18 Uhr Kinoabend (iPhone-Kalender Privat)", out)
        self.assertTrue([o for o in self.icloud.objects("home").values() if "SUMMARY:Kinoabend" in o["ics"]])
        code, out = self.run_tool("termine", "übermorgen")
        self.assertIn("18:00-19:30  Kinoabend [Privat]", out)
        code, out = self.run_tool("termin-loeschen", "Kinoabend")
        self.assertEqual(code, 0, out)
        self.assertIn("Gelöscht: Kinoabend (", out)
        self.assertIn("aus dem iPhone-Kalender Privat", out)
        self.assertEqual(self.run_tool("termin-loeschen", "Kinoabend")[0], 1)

    def test_calendar_list(self):
        code, out = self.run_tool("kalender-liste")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.splitlines(), ["Privat  [schreibbar, neue Termine landen hier]", "Arbeit  [schreibbar]",
                                            "Familie  [nur lesen]"])
        self.cfg["apple"]["apple_id"] = ""
        code, out = self.run_tool("kalender-liste", connected=False)
        self.assertEqual(code, 1)
        self.assertIn("Das iPhone ist nicht verbunden", out)

    def test_mails(self):
        code, out = self.run_tool("mails", "3")
        self.assertEqual(code, 0, out)
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith("icloud:104  "), lines)
        self.assertIn("[neu]  Amazon.de <versand-bestaetigung@amazon.de>  Versandbestätigung", lines[0])
        self.assertTrue(lines[1].startswith("    Ihre Bestellung ist unterwegs"))
        code, out = self.run_tool("mail", "icloud:103")
        self.assertEqual(code, 0, out)
        self.assertIn("Von: Max Mustermann <max.mustermann@gmail.com>", out)
        self.assertIn("Betreff: Re: Grillen am Samstag?", out)
        self.assertIn("Ungelesen (bleibt es auch).", out)
        self.assertIn("Grüße aus Köln!", out)
        code, out = self.run_tool("mail-suche", "Kontoauszug")
        self.assertTrue(out.startswith("icloud:102  "), out)
        self.assertEqual(self.run_tool("mail", "icloud:999")[0], 1)
        self.assertEqual(self.inbox.marked_read, [])

    def test_no_mailbox_yet(self):
        self.cfg["apple"]["apple_id"] = ""
        code, out = self.run_tool("mails", connected=False)
        self.assertEqual(code, 1)
        self.assertIn("Noch kein Postfach verbunden", out)

    def test_memory_lists_iphone_birthdays(self):
        from jarvis.apple import sync_birthdays
        from jarvis.memory import Memory

        memory = Memory(self.state / "gedaechtnis.json")
        sync_birthdays(self.icloud.account(), memory, self.state)
        today = dt.date.today()
        memory.set_address_book([{"name": "Tom Weber", "monat": today.month, "tag": today.day, "jahr": 0}])
        code, out = self.run_tool("gedaechtnis")
        self.assertIn(f"Geburtstage in den nächsten 30 Tagen: Tom Weber am {today:%d.%m.} (heute)", out)


class WindowTest(ICloudSetup):
    def setUp(self):
        super().setUp()
        from jarvis.config import load_config
        from jarvis.gui.app import Api

        cfg = load_config()
        cfg["kalender"] = {"abos": [], "vorwarnung_minuten": 15}
        for patcher in (mock.patch("jarvis.config.STATE_DIR", self.state),
                        mock.patch("jarvis.config.CONFIG_PATH", self.state / "config.toml")):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.assistant = types.SimpleNamespace(
            _cfg=cfg, memory=Memory(self.state / "gedaechtnis.json"), icloud=None, server=None, alexa=None,
            calendar=Calendar(self.state / "kalender.json"), mail=Mailbox(self.state, self.secrets))
        self.api = Api.__new__(Api)
        self.api._assistant = self.assistant

    def wait_for_contacts(self):
        for thread in [t for t in threading.enumerate() if t.name == "jarvis-kontakte"]:
            thread.join(10)

    def test_connect_choose_and_disconnect(self):
        from jarvis.gui.app import DEMO_APPLE

        refused = self.api.apple_connect(USER, "mein-apple-passwort")
        self.assertFalse(refused["ok"])
        self.assertIn("Apple lehnt das Passwort ab. Bitte ein neues app-spezifisches Passwort erstellen.", refused["fehler"])
        self.assertIn("Das normale Apple-ID-Passwort geht hier nicht", refused["fehler"])
        self.assertFalse(self.api.apple_connect("kein-at-zeichen", PASSWORD)["ok"])
        info = self.api.apple_connect(f" {USER} ", "ABCD EFGH IJKL MNOP")  # so tippt man es gern ab
        self.assertTrue(info["ok"], info)
        self.assertEqual(info["fehler"], "")
        self.assertTrue(info["verbunden"])
        self.assertEqual(info["email"], "be•••l@icloud.com")
        self.assertEqual([(c["name"], c["schreibbar"], c["gewaehlt"]) for c in info["kalender"]],
                         [("Privat", True, True), ("Arbeit", True, False), ("Familie", False, False)])
        self.assertEqual(info["mail"]["ungelesen"], 3)
        self.assertEqual(set(info) - {"ok"}, set(DEMO_APPLE), "dieselbe Form wie die Demo-Daten")
        self.assertEqual(set(info["kalender"][0]), set(DEMO_APPLE["kalender"][0]))
        self.assertEqual(set(info["mail"]), set(DEMO_APPLE["mail"]))
        self.assertEqual(set(info["mail"]["letzte"][0]), set(DEMO_APPLE["mail"]["letzte"][0]))
        config = (self.state / "config.toml").read_text(encoding="utf-8")
        self.assertIn(f'apple_id = "{USER}"', config)
        self.assertNotIn(PASSWORD, config)
        self.assertNotIn(PASSWORD, (self.state / "geheim.json").read_text(encoding="utf-8"))
        self.assertEqual(self.secrets.get("apple"), PASSWORD)
        self.assertIsNotNone(self.assistant.calendar.apple)
        self.assertEqual(self.api.connections()["iphone"], True)
        self.wait_for_contacts()
        self.assertEqual(self.api.apple_info()["geburtstage"], 3)

        chosen = self.api.apple_choose_calendar("work")
        self.assertTrue(chosen["ok"])
        self.assertEqual([c["name"] for c in chosen["kalender"] if c["gewaehlt"]], ["Arbeit"])
        self.assertIn('kalender = "Arbeit"', (self.state / "config.toml").read_text(encoding="utf-8"))
        self.assertFalse(self.api.apple_choose_calendar("familie")["ok"], "nur lesen")
        event = self.assistant.calendar.add("Probe", dt.datetime.now() + dt.timedelta(days=2))
        self.assertEqual(event.source, "icloud:work")
        self.assertTrue(self.api.apple_refresh()["verbunden"])

        self.assertEqual(self.api.apple_disconnect(), {"ok": True, "fehler": ""})
        self.assertEqual(self.secrets.get("apple"), "")
        self.assertIn('apple_id = ""', (self.state / "config.toml").read_text(encoding="utf-8"))
        self.assertIsNone(self.assistant.calendar.apple)
        self.assertEqual(self.assistant.memory.address_book(), [])
        self.assertEqual(list((self.state / "icloud").glob("*.json")), [])
        info = self.api.apple_info()
        self.assertFalse(info["verbunden"])
        self.assertEqual((info["kalender"], info["email"]), ([], ""))
        self.assertFalse(self.api.connections()["iphone"])

    def test_mail_accounts(self):
        from jarvis.gui.app import DEMO_MAIL_ACCOUNTS

        self.assertEqual(self.api.mail_accounts(), [])
        refused = self.api.mail_add("gmail", "georg.test@gmail.com", "falsch")
        self.assertFalse(refused["ok"])
        self.assertIn("Gmail braucht ein App-Passwort", refused["fehler"])
        added = self.api.mail_add("gmail", "georg.test@gmail.com", "app-passwort")
        self.assertTrue(added["ok"], added)
        self.assertEqual(added["konto"]["email"], "ge•••t@gmail.com")
        self.assertTrue(self.api.connections()["mail"])
        self.api.apple_connect(USER, PASSWORD)
        accounts = self.api.mail_accounts()
        self.assertEqual([(a["id"], a["automatisch"]) for a in accounts], [("icloud", True), ("gmail", False)])
        self.assertEqual(set(accounts[0]), set(DEMO_MAIL_ACCOUNTS[0]), "dieselbe Form wie die Demo-Daten")
        self.assertFalse(self.api.mail_remove("icloud")["ok"], "kommt mit dem iPhone")
        self.assertEqual(self.api.mail_remove("gmail"), {"ok": True, "fehler": ""})
        self.assertFalse(self.api.mail_remove("gmail")["ok"])
        self.assertEqual([a["id"] for a in self.api.mail_accounts()], ["icloud"])
        self.wait_for_contacts()

    def test_help_buttons(self):
        with mock.patch("jarvis.pc.open_uri") as opened:
            self.assertTrue(self.api.apple_help())
            self.assertTrue(self.api.mail_help("gmail"))
            self.assertFalse(self.api.mail_help("https://anderswo.example"))
        self.assertEqual([c.args[0] for c in opened.call_args_list],
                         ["https://account.apple.com/", "https://myaccount.google.com/apppasswords"])

    def test_demo_data_is_json(self):
        from jarvis.gui.app import DEMO_APPLE, DEMO_MAIL_ACCOUNTS

        self.assertEqual(json.loads(json.dumps(DEMO_APPLE, ensure_ascii=False)), DEMO_APPLE)
        self.assertEqual(json.loads(json.dumps(DEMO_MAIL_ACCOUNTS)), DEMO_MAIL_ACCOUNTS)


if __name__ == "__main__":
    unittest.main()
