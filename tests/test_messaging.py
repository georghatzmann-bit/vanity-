"""Chatnachrichten ohne Claude: Erkennung im Satz und der Ablauf in der App."""

import unittest

import tests.helpers  # noqa: F401
from jarvis import messaging
from jarvis.intents import match
from jarvis.messaging import MessagingError, clean_text, send


class FakeDesktop:
    """Tut so, als wäre es Windows. Merkt sich jede Aktion."""

    def __init__(self, running=True, comes_to_front=True, loses_front_after=None):
        self.actions = []
        self.front = "explorer.exe"
        self._running = running
        self._comes = comes_to_front
        self._lose_after = loses_front_after  # nach so vielen Tastenaktionen ist die App nicht mehr vorne
        self._keys = 0
        self.clock = 0.0

    def open_uri(self, uri):
        self.actions.append(("open", uri))
        if self._comes:
            self.front = "discord.exe" if uri.startswith("discord") else "telegram.exe" if uri.startswith("tg") else "whatsapp.exe"

    def running(self, names):
        return self._running

    def foreground_process(self):
        if self._lose_after is not None and self._keys >= self._lose_after:
            return "game.exe"
        return self.front

    def foreground_window(self):
        return 4242

    def press(self, *keys):
        self._keys += 1
        self.actions.append(("press", keys))

    def type(self, text):
        self._keys += 1
        self.actions.append(("type", text))

    def focus(self, hwnd):
        self.actions.append(("focus", hwnd))

    def sleep(self, seconds):
        self.clock += seconds

    def now(self):
        return self.clock


class SendTest(unittest.TestCase):
    def test_discord_message_goes_through_the_quick_switcher(self):
        desk = FakeDesktop()
        said = send("Discord", "Max", "bin gleich da.", desk)
        self.assertEqual(said, "An Max auf Discord gesendet.")
        self.assertEqual(desk.actions, [
            ("open", "discord://-/channels/@me"),
            ("press", ("ctrl", "k")),
            ("type", "@Max"),
            ("press", ("enter",)),
            ("type", "Bin gleich da"),
            ("press", ("enter",)),
            ("focus", 4242),
        ])
        self.assertLess(desk.clock, 3.0, "schnell: unter drei Sekunden Wartezeit")

    def test_whatsapp_picks_the_first_result(self):
        desk = FakeDesktop()
        send("whats app", "Anna", "Ich komme später!", desk)
        presses = [a[1] for a in desk.actions if a[0] == "press"]
        self.assertEqual(presses, [("ctrl", "f"), ("down",), ("enter",), ("enter",)])

    def test_app_that_does_not_come_to_the_front_gets_nothing_typed(self):
        desk = FakeDesktop(comes_to_front=False)
        with self.assertRaises(MessagingError) as ctx:
            send("discord", "Max", "Hallo", desk)
        self.assertIn("nichts geschrieben", str(ctx.exception))
        self.assertFalse([a for a in desk.actions if a[0] in ("press", "type")])

    def test_losing_the_front_window_stops_before_the_text(self):
        desk = FakeDesktop(loses_front_after=2)  # nach Strg+K und dem Namen ist ein Spiel vorne
        with self.assertRaises(MessagingError) as ctx:
            send("discord", "Max", "Geheimer Text", desk)
        self.assertIn("abgebrochen", str(ctx.exception))
        self.assertNotIn(("type", "Geheimer Text"), desk.actions)

    def test_app_that_was_closed_gets_time_to_load(self):
        desk = FakeDesktop(running=False)
        send("discord", "Max", "Hallo", desk)
        self.assertGreater(desk.clock, 3.0)

    def test_unknown_app_and_missing_parts(self):
        with self.assertRaises(MessagingError):
            send("icq", "Max", "Hallo", FakeDesktop())
        with self.assertRaises(MessagingError):
            send("discord", "", "Hallo", FakeDesktop())

    def test_clean_text(self):
        self.assertEqual(clean_text("  bin gleich da.  "), "Bin gleich da")
        self.assertEqual(clean_text("Spielen wir heute?"), "Spielen wir heute?")
        self.assertEqual(clean_text("warte..."), "Warte...")


class RecognitionTest(unittest.TestCase):
    def test_messages_are_recognised_with_their_original_text(self):
        cases = {
            "Schreib Max auf Discord, bin gleich da.": ("discord", "Max", "bin gleich da."),
            "Hey Jarvis, schick Anna über WhatsApp: Ich komme 10 Minuten später!":
                ("whatsapp", "Anna", "Ich komme 10 Minuten später!"),
            "Schreib bitte Max Müller auf Discord bin in fünf Minuten online":
                ("discord", "Max Müller", "bin in fünf Minuten online"),
            "Schick eine Nachricht an Lisa auf Telegram, kannst du mich anrufen?":
                ("telegram", "Lisa", "kannst du mich anrufen?"),
            "Schreib auf Discord an Tom: Spielen wir heute Abend?": ("discord", "Tom", "Spielen wir heute Abend?"),
        }
        for said, (app, person, text) in cases.items():
            with self.subTest(said=said):
                intent = match(said)
                self.assertEqual((intent.name, intent.arg, intent.data), ("message", app, {"person": person, "text": text}))

    def test_other_sentences_are_not_messages(self):
        for said in (
            "Schreib Max auf Discord, dass ich später komme.",  # indirekte Rede: Claude formuliert um
            "Schreib mir auf Discord eine Erinnerung",
            "Schreib ein Gedicht über den Herbst",
            "Schreib Python-Code, der Dateien sortiert",
            "Schreib meinem Bruder auf WhatsApp, bin da",
            "Schreib auf Discord an Tom bin gleich da",  # ohne Komma unklar, wo der Name aufhört
        ):
            with self.subTest(said=said):
                intent = match(said)
                self.assertTrue(intent is None or intent.name != "message", intent)


class ReminderRecognitionTest(unittest.TestCase):
    def test_reminders_and_timers_without_claude(self):
        import datetime as dt

        from jarvis.intents import match_reminder

        now = dt.datetime(2026, 10, 1, 14, 0)
        cases = {
            "Erinnere mich in 20 Minuten an den Tee.": ("remind", "14:20", "den Tee"),
            "Erinnere mich um 18 Uhr ans Training": ("remind", "18:00", "das Training"),
            "Erinnere mich morgen um 8 daran, den Müll rauszubringen": ("remind", "08:00", "den Müll rauszubringen"),
            "Kannst du mich in 10 Minuten an die Wäsche erinnern?": ("remind", "14:10", "die Wäsche"),
            "Stell einen Timer auf 10 Minuten": ("timer", "14:10", "Der Timer ist abgelaufen."),
            "Starte einen Timer für eine halbe Stunde": ("timer", "14:30", "Der Timer ist abgelaufen."),
        }
        for said, (name, clock, what) in cases.items():
            with self.subTest(said=said):
                intent = match_reminder(said, now)
                self.assertEqual((intent.name, intent.data["when"].strftime("%H:%M"), intent.data["what"]), (name, clock, what))
        self.assertIsNone(match_reminder("Erinnere mich irgendwann an das", now), "unklare Zeit: Claude fragt nach")

    def test_assistant_stores_the_reminder(self):
        import tempfile
        from pathlib import Path

        from jarvis.reminders import ReminderStore
        from tests.test_assistant import FakeBrain, make

        with tempfile.TemporaryDirectory() as folder:
            store = ReminderStore(Path(folder) / "erinnerungen.json")
            brain = FakeBrain()
            assistant, _ui, _speaker, _ = make(brain, reminders=store)
            answer = assistant.handle("Erinnere mich in 20 Minuten an den Tee")
            self.assertTrue(answer.startswith("Sehr wohl, Sir. Ich erinnere Sie"))
            self.assertEqual([r["text"] for r in store.all()], ["den Tee"])
            self.assertEqual(brain.asked, [])


class ToolTest(unittest.TestCase):
    def test_tool_command(self):
        from unittest import mock

        from jarvis import tool

        with mock.patch.object(messaging, "send", return_value="An Max auf Discord gesendet.") as sent, \
                mock.patch("builtins.print") as printed:
            self.assertEqual(tool.main(["nachricht", "discord", "Max", "Bin", "gleich", "da"]), 0)
        sent.assert_called_once_with("discord", "Max", "Bin gleich da")
        printed.assert_called_with("An Max auf Discord gesendet.")


if __name__ == "__main__":
    unittest.main()
