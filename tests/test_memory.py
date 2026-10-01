"""Das Gedächtnis: Fakten, Kontakte, Gewohnheiten, Routinen und Vorschläge."""

import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.memory import Memory, Occasion, match_memory, parse_birthday


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


def week_of_habits(memory, clock, start=dt.datetime(2026, 9, 21, 18, 0), days=8, minute_shift=(0, 5, -4, 10, 2, -8, 7, 3)):
    """Werktags gegen 18 Uhr Discord und Spotify, am Wochenende nichts."""
    for number in range(days):
        day = start + dt.timedelta(days=number)
        if day.weekday() >= 5:
            continue
        clock.when = day + dt.timedelta(minutes=minute_shift[number % len(minute_shift)])
        memory.record("open", "Discord")
        clock.when += dt.timedelta(minutes=2)
        memory.record("open", "Spotify")


class WindowRememberTest(unittest.TestCase):
    """Das Feld "Merk dir ..." in der Gedächtnis-Ansicht speichert wie der gesprochene Satz."""

    def test_typed_facts_are_stored_like_spoken_ones(self):
        from jarvis.gui.app import Api

        with tempfile.TemporaryDirectory() as folder:
            memory = Memory(Path(folder) / "gedaechtnis.json")
            api = Api.__new__(Api)
            api._assistant = mock.Mock(memory=memory)
            for typed in ("Merk dir, dass ich gern Pizza esse", "merk dir Max hat am 3. Mai Geburtstag",
                          "ich höre gern Rock", "Anna mag Katzen"):
                self.assertTrue(api.remember(typed), typed)
            self.assertEqual([f["text"] for f in memory.facts()],
                             ["Georg sagt: Ich esse gern Pizza", "Max hat am 3. Mai Geburtstag",
                              "Georg sagt: Ich höre gern Rock", "Anna mag Katzen"])
            self.assertFalse(api.remember("   "))


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "gedaechtnis.json"
        self.clock = Clock(dt.datetime(2026, 10, 1, 12, 0))
        self.memory = Memory(self.path, now=self.clock)

    def tearDown(self):
        self.folder.cleanup()

    def test_facts_are_kept_deduplicated_and_forgotten(self):
        self.memory.remember("Georg spielt gern Valorant")
        self.memory.remember("georg spielt gern valorant.")
        self.memory.remember("Georg hört gern Rock")
        self.assertEqual([f["text"] for f in self.memory.facts()], ["Georg spielt gern Valorant", "Georg hört gern Rock"])
        self.assertEqual(self.memory.forget("das mit Valorant"), 1)
        self.assertEqual(len(Memory(self.path).facts()), 1, "auf der Platte gespeichert")

    def test_contacts_remember_the_app(self):
        self.memory.record("message", "Max", app="telegram")
        self.memory.record("message", "Max", app="telegram")
        self.assertEqual(self.memory.contact_app("max"), "telegram")
        self.assertEqual(self.memory.contacts()[0]["anzahl"], 2)
        self.assertEqual(self.memory.contact_app("Anna"), "")

    def test_routines_after_a_few_days(self):
        week_of_habits(self.memory, self.clock)
        routines = self.memory.routines(dt.datetime(2026, 10, 1, 12, 0))
        self.assertEqual(len(routines), 1)
        routine = routines[0]
        self.assertEqual(routine.days, "werktags")
        self.assertEqual(routine.label, "Discord und Spotify")
        self.assertTrue(17 * 60 + 50 <= routine.minute <= 18 * 60 + 15, routine.clock)
        self.assertEqual(routine.commands(), ["Öffne Discord", "Öffne Spotify"])
        self.assertIn("Soll ich?", routine.question())

    def test_voice_channel_is_part_of_a_habit(self):
        for number in range(5):
            self.clock.when = dt.datetime(2026, 9, 21 + number, 20, number)
            self.memory.record("open", "Discord")
            self.clock.when += dt.timedelta(minutes=1)
            self.memory.record("voice", "Zocken")
        routine = self.memory.routines(dt.datetime(2026, 10, 1, 12, 0))[0]
        self.assertEqual(routine.commands(), ["Öffne Discord", "Geh in den Sprachkanal Zocken"])
        self.assertEqual(routine.question(),
                         "Sir, um diese Zeit öffnen Sie meist Discord und gehen in den Sprachkanal Zocken. Soll ich?")
        self.assertEqual(routine.label, "Discord und Sprachkanal Zocken")

    def test_birthday_today_is_announced_once_during_the_day(self):
        self.memory.remember("Max hat am 1. Oktober Geburtstag")
        self.memory.record("message", "Max", app="telegram")
        self.assertIsNone(self.memory.due(dt.datetime(2026, 10, 1, 7, 30)), "nicht vor neun")
        occasion = self.memory.due(dt.datetime(2026, 10, 1, 9, 5))
        self.assertIsInstance(occasion, Occasion)
        self.assertEqual(occasion.question(), "Sir, heute hat Max Geburtstag. Soll ich Max auf Telegram gratulieren?")
        self.assertEqual(occasion.commands(), ["Schreib Max auf Telegram: Alles Gute zum Geburtstag, Max! 🎉"])
        self.memory.offered(occasion, dt.datetime(2026, 10, 1, 9, 5))
        self.assertIsNone(self.memory.due(dt.datetime(2026, 10, 1, 15, 0)), "nur einmal am Tag")
        self.assertIsNone(self.memory.due(dt.datetime(2026, 10, 2, 10, 0)), "am nächsten Tag nicht mehr")

    def test_birthday_with_age_relatives_and_own(self):
        self.memory.remember("Georg sagt: Mein Bruder Tom hat am 01.10.2000 Geburtstag")
        occasion = self.memory.occasion(dt.datetime(2026, 10, 1, 12, 0))
        self.assertEqual(occasion.question(), "Sir, Ihr Bruder Tom wird heute 26. Soll ich Tom auf Discord gratulieren?")
        self.memory.forget("Bruder Tom")
        self.memory.remember("Georg sagt: Meine Mutter hat am 1. Oktober Geburtstag")
        occasion = self.memory.occasion(dt.datetime(2026, 10, 1, 12, 0))
        self.assertEqual((occasion.question(), occasion.commands()), ("Sir, heute hat Ihre Mutter Geburtstag.", []))
        self.memory.forget("Mutter")
        self.memory.remember("Georg sagt: Ich habe am 1. Oktober Geburtstag")
        occasion = self.memory.occasion(dt.datetime(2026, 10, 1, 12, 0))
        self.assertTrue(occasion.question().startswith("Alles Gute zum Geburtstag, Sir."))
        self.assertEqual(occasion.commands(), [])

    def test_upcoming_birthdays(self):
        self.memory.remember("Max hat am 3. Oktober Geburtstag")
        self.memory.remember("Anna hat am 2.10. Geburtstag")
        self.memory.remember("Lisa hat am 1. Mai Geburtstag")
        soon = self.memory.upcoming_birthdays(dt.datetime(2026, 10, 1, 12, 0), days=7)
        self.assertEqual([(b["name"], b["in_tagen"]) for b in soon], [("Anna", 1), ("Max", 2)])

    def test_two_days_are_not_a_habit_and_random_times_neither(self):
        week_of_habits(self.memory, self.clock, days=2)
        self.assertEqual(self.memory.routines(dt.datetime(2026, 10, 1, 12, 0)), [])
        for number, hour in enumerate((8, 13, 22, 16, 10)):
            self.clock.when = dt.datetime(2026, 9, 22 + number, hour, 0)
            self.memory.record("open", "Steam")
        self.assertEqual(self.memory.routines(dt.datetime(2026, 10, 1, 12, 0)), [])

    def test_due_at_the_right_time_only_once_and_not_when_done(self):
        week_of_habits(self.memory, self.clock)
        thursday = dt.datetime(2026, 10, 1)
        self.assertIsNone(self.memory.due(thursday.replace(hour=12)))
        routine = self.memory.due(thursday.replace(hour=18, minute=1))
        self.assertIsNotNone(routine)
        self.memory.offered(routine, thursday.replace(hour=18, minute=1))
        self.assertIsNone(self.memory.due(thursday.replace(hour=18, minute=5)), "heute schon gefragt")
        self.assertIsNone(self.memory.due(dt.datetime(2026, 10, 3, 18, 1)), "Samstag: keine Werktags-Routine")
        friday = dt.datetime(2026, 10, 2, 17, 58)
        self.clock.when = friday
        self.memory.record("open", "Discord")
        self.memory.record("open", "Spotify")
        self.assertIsNone(self.memory.due(friday.replace(minute=59)), "schon selbst gemacht")

    def test_never_and_mostly_no_stop_asking(self):
        week_of_habits(self.memory, self.clock)
        routine = self.memory.due(dt.datetime(2026, 10, 1, 18, 1))
        self.memory.feedback(routine.key, "nie")
        self.assertIsNone(self.memory.due(dt.datetime(2026, 10, 1, 18, 1)))

    def test_context_for_the_brain(self):
        self.assertEqual(self.memory.context(), "")
        self.memory.remember("Georg spielt gern Valorant")
        self.memory.record("message", "Max", app="discord")
        week_of_habits(self.memory, self.clock)
        text = self.memory.context(dt.datetime(2026, 10, 1, 12, 0))
        self.assertIn("Georg spielt gern Valorant", text)
        self.assertIn("Max (discord)", text)
        self.assertIn("werktags gegen", text)
        self.assertIn("jarvis.tool merken", text)

    def test_daily_review_learns_facts(self):
        for number in range(6):
            self.clock.when = dt.datetime(2026, 9, 30, 10 + number, 0)
            self.memory.record("said", f"Starte Valorant, Runde {number}")
        self.clock.when = dt.datetime(2026, 10, 1, 9, 0)
        day = self.memory.digest_due()
        self.assertEqual(day, dt.date(2026, 9, 30))
        self.assertIn("Starte Valorant, Runde 3", self.memory.digest_prompt(day))
        learned = self.memory.apply_digest(day, 'Klar: ["Georg spielt gern Valorant.", 42, "x"]')
        self.assertEqual(learned, ["Georg spielt gern Valorant"])
        self.assertIsNone(self.memory.digest_due(), "für gestern schon erledigt")
        self.assertEqual(self.memory.facts()[0]["quelle"], "gelernt")

    def test_other_processes_writing_the_file_are_seen(self):
        self.memory.remember("Erster Fakt")
        other = Memory(self.path)
        other.remember("Vom Gehirn gemerkt")
        import os
        import time

        later = time.time() + 5
        os.utime(self.path, (later, later))
        self.memory.remember("Dritter Fakt")
        self.assertEqual(len(Memory(self.path).facts()), 3, "nichts überschrieben")

    def test_said_events_are_kept_only_a_few_days(self):
        self.clock.when = dt.datetime(2026, 9, 1, 10, 0)
        self.memory.record("said", "Alter Satz")
        self.memory.record("open", "Spotify")
        self.clock.when = dt.datetime(2026, 9, 10, 10, 0)
        self.memory.record("said", "Neuer Satz")
        kinds = [(e["art"], e["was"]) for e in self.memory.events()]
        self.assertNotIn(("said", "Alter Satz"), kinds)
        self.assertIn(("open", "Spotify"), kinds)


class SentenceTest(unittest.TestCase):
    def test_remember_and_forget(self):
        self.assertEqual(match_memory("Merk dir, dass ich gern Pizza esse"), ("remember", "Georg sagt: Ich esse gern Pizza"))
        self.assertEqual(match_memory("Jarvis, merk dir: Max hat am 3. Mai Geburtstag."),
                         ("remember", "Max hat am 3. Mai Geburtstag"))
        self.assertEqual(match_memory("Vergiss das mit der Pizza"), ("forget", "Pizza"))
        self.assertEqual(match_memory("Vergiss, dass ich gern Pizza esse"), ("forget", "ich gern Pizza esse"))
        self.assertIsNone(match_memory("Vergiss es"))
        self.assertEqual(match_memory("Merk dir das: Max hat am 3. Mai Geburtstag"),
                         ("remember", "Max hat am 3. Mai Geburtstag"))
        self.assertEqual(match_memory("Merk dir, das ich gern Pizza esse"), ("remember", "Georg sagt: Ich esse gern Pizza"))
        # Ohne Zusammenhang nichts Unsinniges speichern ("Das", "Bitte"), das macht Claude mit dem Gespräch
        for said in ("Merk dir das", "Merk dir das bitte", "Merk dir, was ich gesagt habe", "Merk dir, wo ich geparkt habe"):
            self.assertIsNone(match_memory(said), said)

    def test_birthdays_are_recognized(self):
        cases = {
            "Max hat am 3. Mai Geburtstag": ("Max", "Max", 5, 3, 0),
            "Georg sagt: Mein Bruder Tom hat am 12.03. Geburtstag": ("Ihr Bruder Tom", "Tom", 3, 12, 0),
            "Annas Geburtstag ist am 5. Juni": ("Anna", "Anna", 6, 5, 0),
            "Der Geburtstag von Lisa ist am 1.12.": ("Lisa", "Lisa", 12, 1, 0),
            "Tom Müller hat Geburtstag am 3. Jänner": ("Tom Müller", "Tom Müller", 1, 3, 0),
            "Max ist am 3. Mai 1990 geboren": ("Max", "Max", 5, 3, 1990),
            "Am 3. Mai hat Max Geburtstag": ("Max", "Max", 5, 3, 0),
            "Georg sagt: Meine Mutter hat am 14. Februar Geburtstag.": ("Ihre Mutter", "", 2, 14, 0),
        }
        for text, (shown, name, month, day, year) in cases.items():
            found = parse_birthday(text)
            self.assertEqual((found["shown"], found["name"], found["month"], found["day"], found["year"]),
                             (shown, name, month, day, year), text)
        self.assertTrue(parse_birthday("Georg sagt: Ich habe am 5. Juni Geburtstag")["own"])
        for text in ("Max hat am 33. Mai Geburtstag", "Georg spielt gern Valorant.", "Max hat Geburtstag"):
            self.assertIsNone(parse_birthday(text), text)

    def test_birthdays_of_relatives_and_names_with_s(self):
        # Vorher: "Soll ich Vaters auf Discord gratulieren?", "heute hat Ihrem Bruder Tom Geburtstag", "Luka", "Klau"
        cases = {
            "Der Geburtstag meines Vaters ist am 4. April": ("Ihr Vater", ""),
            "Der Geburtstag meiner Mutter ist am 4. April": ("Ihre Mutter", ""),
            "Der Geburtstag von meinem Bruder Tom ist am 4. April": ("Ihr Bruder Tom", "Tom"),
            "Der Geburtstag meines besten Freundes Lukas ist am 4. April": ("Ihr bester Freund Lukas", "Lukas"),
            "Meines Bruders Geburtstag ist am 4. April": ("Ihr Bruder", ""),
            "Lukas Geburtstag ist am 4. April": ("Lukas", "Lukas"),
            "Lukas' Geburtstag ist am 4. April": ("Lukas", "Lukas"),
            "Klaus Geburtstag ist am 4. April": ("Klaus", "Klaus"),
            "Toms Geburtstag ist am 4. April": ("Tom", "Tom"),
            "Meine beste Freundin Lea hat am 4. April Geburtstag": ("Ihre beste Freundin Lea", "Lea"),
        }
        for text, expected in cases.items():
            found = parse_birthday(text)
            self.assertEqual((found["shown"], found["name"], found["month"], found["day"]), (*expected, 4, 4), text)
        self.assertTrue(parse_birthday("Der Geburtstag von mir ist am 5. Juni")["own"])

    def test_recall(self):
        for said in ("Was weißt du über mich?", "Jarvis, was weißt du eigentlich alles über mich", "Was hast du dir gemerkt?",
                     "Welche Gewohnheiten habe ich?", "Was kennst du denn für Gewohnheiten?"):
            self.assertEqual(match_memory(said), ("recall", ""), said)
        self.assertIsNone(match_memory("Was weißt du über Pizza?"))


class AssistantMemoryTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.folder = tempfile.TemporaryDirectory()
        self.clock = Clock(dt.datetime(2026, 10, 1, 18, 1))
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant.memory = Memory(Path(self.folder.name) / "g.json", now=self.clock)

    def tearDown(self):
        self.folder.cleanup()

    def test_remember_without_claude(self):
        self.assertIn(self.assistant.handle("Merk dir, dass ich gern Rock höre"),
                      ("Notiert, Sir.", "Ist gespeichert, Sir.", "Vermerkt, Sir. Ich vergesse es nicht."))
        self.assertEqual(self.brain.asked, [])
        self.assertEqual(self.assistant.memory.facts()[0]["text"], "Georg sagt: Ich höre gern Rock")

    def test_recall_without_claude(self):
        self.assertIn("Noch nicht viel", self.assistant.handle("Was weißt du über mich?"))
        self.assistant.handle("Merk dir, dass ich gern Rock höre")
        self.assistant.handle("Merk dir: Max hat am 3. Mai Geburtstag")
        week_of_habits(self.assistant.memory, self.clock)
        answer = self.assistant.handle("Was weißt du über mich?")
        self.assertIn("2 Dinge", answer)
        self.assertIn("Max hat am 3. Mai Geburtstag; „Ich höre gern Rock“", answer)
        self.assertIn("Discord", answer)
        self.assertEqual(self.brain.asked, [])

    def test_birthday_offer_sends_congratulations(self):
        self.assistant.memory.remember("Max hat am 1. Oktober Geburtstag")
        self.clock.when = dt.datetime(2026, 10, 1, 10, 0)
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            self.assertTrue(self.assistant.check_suggestions(self.clock.when))
        self.assertEqual(self.speaker.said[-1], "Sir, heute hat Max Geburtstag. Soll ich Max auf Discord gratulieren?")
        # Die Bestätigung ist zufällig ("Gesendet, Sir." nennt Max nicht): hier immer die erste
        with mock.patch("jarvis.messaging.send", return_value="ok") as sent, \
                mock.patch("jarvis.assistant.random.choice", side_effect=lambda options: options[0]):
            answer = self.assistant.handle("Ja, mach")
        self.assertEqual(sent.call_args.args, ("discord", "Max", "Alles Gute zum Geburtstag, Max! 🎉"))
        self.assertEqual(answer, "An Max ist raus, Sir.")
        self.assertEqual(self.brain.asked, [])

    def test_birthday_without_contact_is_only_announced(self):
        self.assistant.memory.remember("Georg sagt: Meine Oma hat am 1. Oktober Geburtstag")
        self.clock.when = dt.datetime(2026, 10, 1, 10, 0)
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            self.assertTrue(self.assistant.check_suggestions(self.clock.when))
        self.assertEqual(self.speaker.said[-1], "Sir, heute hat Ihre Oma Geburtstag.")
        self.assertIsNone(self.assistant._offer, "nichts zu beantworten")

    def test_voice_channel_is_learned(self):
        with mock.patch("jarvis.messaging.discord_open") as opened:
            self.assistant.handle("Geh in den Sprachkanal Zocken")
        opened.assert_called_once_with("zocken", "voice")
        self.assertIn(("voice", "Zocken"), [(e["art"], e["was"]) for e in self.assistant.memory.events()])

    def offer(self):
        week_of_habits(self.assistant.memory, self.clock)
        self.clock.when = dt.datetime(2026, 10, 1, 18, 1)
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            return self.assistant.check_suggestions(self.clock.when)

    def test_suggestion_yes_opens_everything(self):
        self.assertTrue(self.offer())
        self.assertIn("Discord und Spotify", self.speaker.said[-1])
        self.assertTrue(self.assistant.take_follow_up(), "die Antwort geht ohne Hey Jarvis")
        with mock.patch("jarvis.apps.open_app", side_effect=lambda name: f"{name.capitalize()} startet.") as opened:
            answer = self.assistant.handle("Ja, gerne")
        self.assertEqual([c.args[0] for c in opened.call_args_list], ["discord", "spotify"])
        self.assertIn("Discord und Spotify", answer)
        self.assertEqual(self.brain.asked, [])

    def test_suggestion_never(self):
        self.assertTrue(self.offer())
        self.assertEqual(self.assistant.handle("Nein, frag mich nicht mehr"), "Verstanden, Sir. Das frage ich nicht mehr.")
        self.clock.when = dt.datetime(2026, 10, 2, 18, 1)
        self.assertIsNone(self.assistant.memory.due())

    def test_something_else_is_a_normal_command(self):
        self.assertTrue(self.offer())
        self.assistant.handle("Wie spät ist es?")
        self.assertIsNone(self.assistant._offer)

    def test_no_suggestions_while_gaming_or_away(self):
        week_of_habits(self.assistant.memory, self.clock)
        self.clock.when = dt.datetime(2026, 10, 1, 18, 1)
        with mock.patch.object(self.assistant, "_present", return_value=False):
            self.assertFalse(self.assistant.check_suggestions(self.clock.when))
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.assistant, "_fullscreen", return_value=True):
            self.assertFalse(self.assistant.check_suggestions(self.clock.when))

    def test_learns_contacts_and_opened_apps(self):
        with mock.patch("jarvis.messaging.send", return_value="ok"):
            self.assistant.handle("Schreib Max auf Telegram, bin gleich da")
        self.assertEqual(self.assistant.memory.contact_app("Max"), "telegram")
        with mock.patch("jarvis.messaging.send", return_value="ok") as sent:
            self.assistant.handle("Sag Max, dass ich gleich komme")
        sent.assert_called_once_with("telegram", "Max", "Ich komme gleich")
        said = [e["was"] for e in self.assistant.memory.events("said")]
        self.assertIn("Sag Max, dass ich gleich komme", said)


class BrainContextTest(unittest.TestCase):
    """Das Gehirn bekommt das Gedächtnis am Anfang jeder Unterhaltung, nicht bei jeder Frage."""

    def run_brain(self, live):
        import json

        from jarvis.brain import ClaudeBrain
        from jarvis.config import load_config
        from tests.helpers import make_fake_claude

        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            cfg = load_config()["brain"]
            cfg["claude_path"] = str(make_fake_claude(home))
            cfg["live"] = live
            (home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
            brain = ClaudeBrain(cfg, home, home / "daten")
            brain.context = lambda: "Was du über Georg weißt:\n- Georg spielt gern Valorant"
            try:
                brain.ask("Hallo")
                brain.ask("Und jetzt?")
                brain.new_conversation()
                brain.ask("Neues Gespräch")
            finally:
                brain.new_conversation()
            calls = [json.loads(line) for line in (home / "calls.jsonl").read_text(encoding="utf-8").splitlines()]
        raws = [c["raw"] for c in calls]
        self.assertEqual(len(raws), 3)
        self.assertIn("<gedaechtnis>", raws[0])
        self.assertIn("Georg spielt gern Valorant", raws[0])
        self.assertTrue(raws[0].rstrip().endswith("Hallo"))
        self.assertNotIn("<gedaechtnis>", raws[1])
        self.assertIn("<gedaechtnis>", raws[2], "neue Unterhaltung: wieder dabei")
        self.assertRegex(raws[0], r"^\(.*Uhr\)\n<gedaechtnis>")

    def test_not_live(self):
        self.run_brain(False)

    def test_live(self):
        self.run_brain(True)

    def test_oneshot_has_no_tools_and_returns_text(self):
        from jarvis.brain import ClaudeBrain
        from jarvis.config import load_config

        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            cfg = load_config()["brain"]
            cfg["claude_path"] = "claude"
            cfg["live"] = False
            with mock.patch("jarvis.brain.find_claude", return_value="claude"):
                brain = ClaudeBrain(cfg, home, home / "daten")
            done = mock.Mock(returncode=0, stdout='["Georg spielt gern Valorant."]\n', stderr="")
            with mock.patch("jarvis.brain.subprocess.run", return_value=done) as run:
                self.assertEqual(brain.oneshot("Was hast du gelernt?"), '["Georg spielt gern Valorant."]')
            cmd = run.call_args.args[0]
            self.assertEqual(cmd[cmd.index("--tools") + 1], "")
            self.assertEqual(cmd[cmd.index("--model") + 1], "haiku")
            self.assertEqual(run.call_args.kwargs["input"], "Was hast du gelernt?")


if __name__ == "__main__":
    unittest.main()
