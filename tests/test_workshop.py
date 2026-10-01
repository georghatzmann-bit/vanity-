"""Die Werkstatt: Programmieraufträge im Hintergrund, mit Plan, Schritten und Ansage am Ende."""

import datetime as dt
import json
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tests.helpers import RecordingUi, make_fake_claude
from jarvis.brain import ClaudeBrain
from jarvis.config import load_config
from jarvis.workshop import Workshop, is_workshop_request, project_folder

posix_only = unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")


class RecognitionTest(unittest.TestCase):
    def test_build_requests_go_to_the_workshop(self):
        for said in (
            "Bau mir einen Discord-Bot, der jeden Morgen das Wetter postet",
            "Hey Jarvis, programmier mir ein kleines Spiel",
            "Schreib mir ein Python-Skript, das meine Downloads sortiert",
            "Erstelle eine Webseite für meinen Clan",
            "Kannst du mir ein Tool bauen?",
            "Mach mir eine Batch-Datei, die Discord und Steam startet",
            "Ab in die Werkstatt: ein Taschenrechner",
            "Behebe den Fehler in meinem Skript",
        ):
            with self.subTest(said=said):
                self.assertTrue(is_workshop_request(said))

    def test_other_requests_do_not(self):
        for said in (
            "Schreib mir ein Gedicht über den Herbst",
            "Wie wird das Wetter morgen?",
            "Öffne Discord",
            "Mach das Licht an",
            "Schreib Max auf Discord, bin gleich da",
            "Erstelle eine Datei namens Einkauf auf dem Desktop",
            "Mach mir eine neue Seite in Chrome",
            "Mach mir ein Spiel an",
            "Wie weit ist die Werkstatt?",
            "Ist die Werkstatt schon fertig?",
        ):
            with self.subTest(said=said):
                self.assertFalse(is_workshop_request(said))

    def test_questions_about_the_workshop_are_status(self):
        from jarvis import intents

        for said in ("Wie weit ist die Werkstatt?", "Ist die Werkstatt schon fertig?", "Wie weit bist du?"):
            with self.subTest(said=said):
                self.assertEqual(intents.match(said).name, "workshop_status")

    def test_project_folder_names(self):
        with TemporaryDirectory() as base:
            now = dt.datetime(2026, 10, 1, 15, 30)
            first = project_folder("Bau mir einen Discord-Bot, der Hallo sagt", Path(base), now)
            self.assertEqual(first.name, "2026-10-01_1530_discord-bot-hallo-sagt")
            first.mkdir()
            second = project_folder("Bau mir einen Discord-Bot, der Hallo sagt", Path(base), now)
            self.assertEqual(second.name, "2026-10-01_1530_discord-bot-hallo-sagt-2")
            self.assertEqual(project_folder("Programmier was", Path(base), now).name, "2026-10-01_1530_was")


@posix_only
class WorkshopRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        cfg = load_config()
        cfg["brain"]["claude_path"] = str(make_fake_claude(self.home))
        cfg["werkstatt"] = {"ordner": str(self.home / "Werkstatt"), "modell": "sonnet", "effort": "medium"}
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(cfg["brain"], self.home, self.home / "daten")
        self.addCleanup(self.brain.close)
        self.ui = RecordingUi()
        self.said = []
        self.shown = []
        self.workshop = Workshop(cfg, self.brain, self.ui, self.said.append, show_window=lambda: self.shown.append(1))

    def wait(self, seconds=15):
        end = time.monotonic() + seconds
        while self.workshop.busy and time.monotonic() < end:
            time.sleep(0.05)
        self.assertFalse(self.workshop.busy)

    def test_a_job_runs_in_the_background_and_reports_back(self):
        answer = self.workshop.start("Bau mir einen Discord-Bot, der Hallo sagt")
        self.assertIn("Werkstatt", answer)
        self.assertEqual(self.shown, [1], "das Fenster kommt nach vorn, damit Georg zusehen kann")
        self.wait()
        job = self.workshop.job
        self.assertEqual(job.state, "done")
        self.assertTrue(job.folder.is_dir())
        self.assertEqual([t["text"] for t in job.todos], ["Ordner anlegen", "Bot schreiben", "Testen"])
        states = [e[1]["state"] for e in self.ui.of("workshop")]
        self.assertEqual(states[0], "start")
        self.assertEqual(states[-1], "done")
        labels = [e[1]["label"] for e in self.ui.of("progress") if e[1]["state"] == "running"]
        self.assertEqual(labels, ["Plant die Schritte", "Schreibt bot.py", "Startet bot.py"])
        self.assertTrue(all(e[1].get("workshop") for e in self.ui.of("progress")))
        self.assertTrue(self.said[0].startswith("Aus der Werkstatt: Der Bot ist fertig"))
        log = json.loads((job.folder / "werkstatt-protokoll.json").read_text(encoding="utf-8"))
        self.assertEqual(log["zustand"], "done")
        call = json.loads((job.folder / "calls.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(call["cwd"], str(job.folder))
        args = call["args"]
        self.assertEqual(args[args.index("--permission-mode") + 1], "acceptEdits")
        self.assertEqual(args[args.index("--add-dir") + 1], str(job.folder))
        self.assertEqual(args[args.index("--effort") + 1], "medium")
        self.assertIn("TodoWrite", args)

    def test_one_job_at_a_time_and_status_and_cancel(self):
        self.workshop.start("Bau mir ein langsames Spiel")
        time.sleep(1.0)
        self.assertIn("vorigen Auftrag", self.workshop.start("Bau mir noch was"))
        self.assertIn("Schritt", self.workshop.status())
        self.assertTrue(self.workshop.cancel())
        self.wait()
        self.assertEqual(self.workshop.job.state, "cancelled")
        self.assertIn("abgebrochen", self.said[-1])


class AssistantWorkshopTest(unittest.TestCase):
    def test_build_request_starts_the_workshop_without_blocking(self):
        from tests.test_assistant import FakeBrain, make

        class StubWorkshop:
            busy = False

            def __init__(self):
                self.tasks = []

            def start(self, task):
                self.tasks.append(task)
                return "Sehr wohl, Sir. Ich gehe in die Werkstatt."

            def status(self):
                return "Ich bin bei Schritt 2 von 3, Sir."

            def cancel(self):
                return True

        brain = FakeBrain()
        assistant, _ui, _speaker, _ = make(brain)
        assistant.workshop = StubWorkshop()
        self.assertEqual(assistant.handle("Bau mir einen Discord-Bot"), "Sehr wohl, Sir. Ich gehe in die Werkstatt.")
        self.assertEqual(brain.asked, [])
        assistant.workshop.busy = True
        self.assertEqual(assistant.handle("Wie weit bist du?"), "Ich bin bei Schritt 2 von 3, Sir.")
        self.assertEqual(assistant.handle("Brich die Werkstatt ab"), "Abgebrochen, Sir.")


if __name__ == "__main__":
    unittest.main()
