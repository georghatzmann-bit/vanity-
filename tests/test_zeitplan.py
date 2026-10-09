"""Zeitpläne ("Jeden Morgen um 8 Uhr: Briefing"), GPU-Anzeige und Schnellbefehle."""

import datetime as dt
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.zeitplan import Schedules, describe, match_schedule


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


class SentenceTest(unittest.TestCase):
    def test_recurring_only(self):
        self.assertEqual(match_schedule("Jeden Morgen um 8 Uhr: Briefing"),
                         ("add", (list(range(7)), dt.time(8, 0), "Briefing")))
        self.assertEqual(match_schedule("Werktags um 18 Uhr öffne Discord und Spotify"),
                         ("add", ([0, 1, 2, 3, 4], dt.time(18, 0), "öffne Discord und Spotify")))
        self.assertEqual(match_schedule("Jeden Abend um 10: mach das Licht aus")[1][1], dt.time(22, 0))
        self.assertEqual(match_schedule("Montags und Donnerstags um 17:30 Uhr: Training")[1][:2], ([0, 3], dt.time(17, 30)))
        for one_time in ("Samstag um 20 Uhr Kino mit Anna", "Am Freitag um 9 Uhr Meeting", "Am Wochenende um 10 Uhr Fußball",
                         "Erinnere mich morgen um 8 an den Müll", "Jeden Morgen um 8 Uhr, was machst du?"):
            self.assertIsNone(match_schedule(one_time), one_time)
        # Georg erzählt etwas: kein Befehl, den Jarvis jede Woche losschickt
        for statement in ("Freitags um 20 Uhr spiele ich Fußball", "Jeden Montag um 9 Uhr ist Meeting",
                          "Werktags um 7 Uhr muss ich aufstehen", "Sonntags um 10 Uhr gehen wir brunchen"):
            self.assertIsNone(match_schedule(statement), statement)
        self.assertEqual(match_schedule("Jeden Abend um 10 kannst du das Licht ausmachen")[1][2], "das Licht ausmachen")
        self.assertEqual(match_schedule("Jeden Tag um 12 Uhr mittags erinnere mich an Tabletten")[1][1:],
                         (dt.time(12, 0), "erinnere mich an Tabletten"))
        self.assertEqual(match_schedule("Täglich um 8 sag es mir")[1][2], "sag es mir")
        self.assertEqual(match_schedule("Welche Zeitpläne habe ich?"), ("list", ""))
        self.assertEqual(match_schedule("Lösch den Zeitplan Briefing"), ("remove", "Briefing"))


class ScheduleTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.clock = Clock(dt.datetime(2026, 10, 2, 7, 0))  # Freitag früh
        self.plans = Schedules(Path(self.folder.name) / "z.json", now=self.clock)

    def tearDown(self):
        self.folder.cleanup()

    def test_due_once_per_day_and_only_on_its_days(self):
        self.plans.add(list(range(7)), dt.time(8, 0), "Briefing")
        self.plans.add([0, 1, 2, 3, 4], dt.time(18, 0), "öffne Discord")
        self.assertEqual(self.plans.due(dt.datetime(2026, 10, 2, 7, 59)), [])
        self.assertEqual([i["befehl"] for i in self.plans.due(dt.datetime(2026, 10, 2, 8, 0, 20))], ["Briefing"])
        self.assertEqual(self.plans.due(dt.datetime(2026, 10, 2, 8, 1)), [], "nur einmal am Tag")
        self.assertEqual([i["befehl"] for i in self.plans.due(dt.datetime(2026, 10, 2, 18, 0))], ["Öffne Discord"])
        self.assertEqual([i["befehl"] for i in self.plans.due(dt.datetime(2026, 10, 3, 8, 30))], ["Briefing"])
        self.assertEqual([i["befehl"] for i in self.plans.due(dt.datetime(2026, 10, 3, 18, 5))], [], "Samstag: kein Werktag")

    def test_late_start_and_game_running(self):
        self.plans.add(list(range(7)), dt.time(8, 0), "Briefing")
        self.assertEqual(self.plans.due(dt.datetime(2026, 10, 2, 8, 10), hold=True), [], "Spiel im Vollbild: warten")
        self.assertEqual(len(self.plans.due(dt.datetime(2026, 10, 2, 8, 40))), 1, "danach nachholen")
        self.assertEqual(self.plans.due(dt.datetime(2026, 10, 3, 9, 30)), [], "mehr als eine Stunde zu spät: nicht mehr")

    def test_added_after_its_time_starts_tomorrow(self):
        self.clock.when = dt.datetime(2026, 10, 2, 9, 0)
        self.plans.add(list(range(7)), dt.time(8, 0), "Briefing")
        self.assertEqual(self.plans.due(dt.datetime(2026, 10, 2, 9, 1)), [])
        self.assertEqual(describe(self.plans.all()[0]), "täglich um 8 Uhr: Briefing")
        self.assertEqual(self.plans.remove("Briefing")["befehl"], "Briefing")
        self.assertEqual(self.plans.all(), [])


class AssistantTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.folder = tempfile.TemporaryDirectory()
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant.schedules = Schedules(Path(self.folder.name) / "z.json")
        self.assistant._disk_checked = float("inf")

    def tearDown(self):
        self.folder.cleanup()

    def test_create_list_and_delete_without_claude(self):
        self.assertIn("Noch keine Zeitpläne", self.assistant.handle("Welche Zeitpläne habe ich?"))
        self.assertEqual(self.assistant.handle("Werktags um 18 Uhr öffne Discord"),
                         "Eingerichtet, Sir: werktags um 18 Uhr: Öffne Discord.")
        self.assertIn("werktags um 18 Uhr: Öffne Discord", self.assistant.handle("Welche Zeitpläne habe ich?"))
        self.assertEqual(self.assistant.handle("Lösch den Zeitplan Discord"), "Gelöscht, Sir: werktags um 18 Uhr: Öffne Discord.")
        self.assertEqual(self.brain.asked, [])

    def test_due_schedule_runs_and_goes_to_the_phone_when_away(self):
        morning = dt.datetime(2026, 10, 2, 7, 0)
        self.assistant.schedules = Schedules(Path(self.folder.name) / "z2.json", now=Clock(morning))
        self.assistant.schedules.add([4], dt.time(8, 0), "Wie spät ist es?")
        with mock.patch.object(self.assistant, "_fullscreen", return_value=False), \
                mock.patch.object(self.assistant, "_present", return_value=False), \
                mock.patch.object(self.assistant, "_push") as pushed, \
                mock.patch("jarvis.assistant.threading.Thread", side_effect=lambda target, args, **kw: mock.Mock(start=lambda: target(*args))):
            self.assistant.check_schedules(dt.datetime(2026, 10, 2, 8, 0, 30))
        self.assertTrue(pushed.call_args.args[0].startswith("Wie spät ist es?: Es ist"))


class ToolTest(unittest.TestCase):
    def test_tool_commands(self):
        from jarvis import tool

        with tempfile.TemporaryDirectory() as folder:
            out = io.StringIO()
            with mock.patch.object(tool, "STATE_DIR", Path(folder)), redirect_stdout(out):
                self.assertEqual(tool.main(["zeitplan", "jeden Morgen um 7:30", "Briefing"]), 0)
                self.assertEqual(tool.main(["zeitplaene"]), 0)
                self.assertEqual(tool.main(["zeitplan", "irgendwann", "Briefing"]), 1)
                self.assertEqual(tool.main(["zeitplan-loeschen", "Briefing"]), 0)
            text = out.getvalue()
            self.assertIn("Zeitplan eingerichtet: täglich um 7:30 Uhr: Briefing", text)
            self.assertIn("Gelöscht: täglich um 7:30 Uhr: Briefing", text)

    def test_the_examples_in_the_error_work(self):
        """Claude nimmt nach einem Fehler eines der Beispiele: "am Wochenende um 10" ging selbst nicht."""
        import re

        from jarvis import tool

        with tempfile.TemporaryDirectory() as folder:
            out = io.StringIO()
            with mock.patch.object(tool, "STATE_DIR", Path(folder)), redirect_stdout(out):
                self.assertEqual(tool.main(["zeitplan", "irgendwann", "Briefing"]), 1)
                examples = re.findall(r'"([^"]+)"', out.getvalue().split("Beispiele:", 1)[1])
                self.assertGreaterEqual(len(examples), 4)
                for when in examples:
                    self.assertEqual(tool.main(["zeitplan", when, "Spotify starten"]), 0, when)
                self.assertEqual(tool.main(["zeitplan", "Am Wochenende um 10 Uhr", "Discord"]), 0)
            self.assertIn("Zeitplan eingerichtet: am Wochenende um 10 Uhr: Spotify starten", out.getvalue())
            self.assertIn("Zeitplan eingerichtet: am Wochenende um 10 Uhr: Discord", out.getvalue())

    def test_spoken_weekend_stays_an_appointment(self):
        """"Am Wochenende um 10 erinnere mich ans Auto" ist einmalig: das darf kein Zeitplan für jedes Wochenende werden."""
        self.assertIsNone(match_schedule("Am Wochenende um 10 erinnere mich ans Autowaschen"))


class GpuTest(unittest.TestCase):
    def test_nvidia_smi_values_and_no_card(self):
        from jarvis import pc

        with mock.patch.object(pc, "_GPU_MISSING", False), \
                mock.patch("jarvis.pc.subprocess.run", return_value=mock.Mock(stdout="37, 64, 4096, 8192\n")):
            self.assertEqual(pc.gpu_stats(), {"load": 37, "temp": 64, "mem": 50})
        with mock.patch.object(pc, "_GPU_MISSING", False), \
                mock.patch("jarvis.pc.subprocess.run", side_effect=FileNotFoundError("nvidia-smi")):
            self.assertIsNone(pc.gpu_stats())
            self.assertTrue(pc._GPU_MISSING, "danach nicht mehr fragen")

    def test_window_gets_the_gpu(self):
        from jarvis.gui.app import GuiBridge

        bridge = GuiBridge.__new__(GuiBridge)
        events = []
        bridge._push = events.append
        bridge.stats(12.3, 45.6, {"load": 37, "temp": 64, "mem": 50})
        bridge.stats(12.3, 45.6)
        self.assertEqual(events[0]["gpu"], {"load": 37, "temp": 64, "mem": 50})
        self.assertNotIn("gpu", events[1])


if __name__ == "__main__":
    unittest.main()
