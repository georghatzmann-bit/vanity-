"""Die Werkstatt: Programmieraufträge im Hintergrund, mit Plan, Schritten und Ansage am Ende."""

import base64
import datetime as dt
import json
import os
import sys
import time
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from tests.helpers import RecordingUi, make_fake_claude
from jarvis.brain import ClaudeBrain
from jarvis.config import load_config
from jarvis.workshop import (Job, Workshop, choose_effort, hand_over, is_change_request, is_continue_request, is_wish,
                             is_workshop_request, looks_like_answer, project_folder, project_logo)

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
            # Füllwörter und andere Satzformen, die früher nicht ankamen
            "Hey Jarvis, bau mir bitte schnell eine App für meine Einkaufsliste",
            "Erstelle mir bitte ein Python Programm, das Bilder verkleinert",
            "Ich brauche ein Programm, das meine Fotos nach Datum sortiert",
            "Ich hätte gern eine Webseite für meinen Clan",
            "Schreib mir Code für einen Discord-Bot",
            "Kannst du mir bitte einen Chatbot bauen?",
            "Bau mir eine KI, die meine Mails sortiert",
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

    def test_continue_change_and_answer(self):
        for said in ("Mach in der Werkstatt weiter", "Werkstatt, füg noch einen Befehl hinzu",
                     "Arbeite weiter", "Füg in der Werkstatt noch einen Highscore hinzu"):
            with self.subTest(said=said):
                self.assertTrue(is_continue_request(said))
        self.assertFalse(is_continue_request("Wie weit ist die Werkstatt?"))
        for said in ("Füg dem Bot noch einen Befehl hinzu", "Der Bot startet nicht", "Reparier das Skript",
                     "Mach das Spiel schwerer", "Es funktioniert immer noch nicht"):
            with self.subTest(said=said):
                self.assertTrue(is_change_request(said))
        for said in ("Mach Spotify an", "Mach das Licht heller", "Öffne den Bot-Ordner", "Wie spät ist es?"):
            with self.subTest(said=said):
                self.assertFalse(is_change_request(said))
        self.assertTrue(looks_like_answer("Nimm den Token aus meiner Notiz"))
        self.assertTrue(looks_like_answer("Ja, mach das"))
        for said in ("Wie spät ist es?", "Öffne Spotify", "Erzähl mir einen Witz", "Was ist ein Token?"):
            with self.subTest(said=said):
                self.assertFalse(looks_like_answer(said))

    def test_wishes_while_the_workshop_works(self):
        for said in ("Mach den Hintergrund blau", "Nimm lieber Python", "Füg noch einen Highscore hinzu",
                     "Die Schrift soll größer sein", "Und mach die Gegner schneller", "Der Spieler soll schneller laufen",
                     "Füg dem Bot noch einen Befehl hinzu", "Bau noch ein Menü ein"):
            with self.subTest(said=said):
                self.assertTrue(is_wish(said))
        for said in ("Wie spät ist es?", "Mach das Licht an", "Erzähl mir einen Witz", "Öffne Spotify", "Danke",
                     "Welche Sprache nimmst du?",
                     # Alltag, während die Werkstatt baut: das ist für Jarvis, nicht für das Projekt
                     "Gib mir auch das Wetter für morgen", "Lösch noch die Downloads", "Mach den Bildschirm dunkler",
                     "Schreib mir einen Text für Instagram", "Lass uns noch was anderes machen", "Mach mir noch einen Kaffee",
                     "Nimm lieber den anderen Song", "Das muss ich mir merken", "Man sollte mal wieder aufräumen",
                     "Es soll morgen regnen", "Mach das Fenster größer", "Mach noch ein Foto vom Bildschirm"):
            with self.subTest(said=said):
                self.assertFalse(is_wish(said))

    def test_effort_for_the_workshop(self):
        self.assertEqual(choose_effort("Bau mir ein Spiel, beste Qualität bitte", "opus"), "xhigh")
        self.assertEqual(choose_effort("Denk richtig gründlich nach und bau mir einen Shop", "opus"), "xhigh")
        self.assertEqual(choose_effort("Bau mir schnell mal ein Skript", "sonnet"), "low")
        self.assertEqual(choose_effort("Bau mir einen Bot", "sonnet"), "medium")
        self.assertEqual(choose_effort("Bau mir ein Multiplayer-Spiel mit Login", "opus"), "high")
        self.assertEqual(choose_effort("Bau mir was", "opus", setting="opus", effort="medium"), "medium")

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


class ProjectLogoTest(unittest.TestCase):
    """logo.svg aus dem Projektordner wird zum Hologramm im Fenster, aber nur ein harmloses Bild."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)

    def logo(self, svg, encoding="utf-8"):
        (self.folder / "logo.svg").write_bytes(svg.encode(encoding) if isinstance(svg, str) else svg)
        return project_logo(self.folder)

    def test_a_plain_logo_is_shown(self):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
               '<defs><linearGradient id="g"><stop offset="0" stop-color="#5865F2"/></linearGradient>'
               '<path id="kopf" d="M60 80h136v100H60z"/></defs>'
               '<use href="#kopf" fill="url(#g)"/><use xlink:href="#kopf"/><text x="10" y="20">Bot</text></svg>')
        src = self.logo(svg)
        self.assertTrue(src.startswith("data:image/svg+xml;base64,"))
        self.assertEqual(base64.b64decode(src.split(",", 1)[1]).decode("utf-8"), svg)
        self.assertTrue(self.logo("\ufeff" + svg).startswith("data:"), "mit BOM von Windows-Editoren")
        self.assertTrue(self.logo('<svg viewBox="0 0 24 24" stroke-linejoin="round"><path d="M1 1h2"/></svg>'))

    def test_nothing_without_a_logo(self):
        self.assertEqual(project_logo(self.folder), "")
        self.assertEqual(project_logo(self.folder / "gibt-es-nicht"), "")
        self.assertEqual(self.logo("Hallo, ich bin kein Bild"), "")
        self.assertEqual(self.logo(b"\xff\xfe<\x00s\x00"), "", "kaputte Kodierung")
        self.assertEqual(self.logo("<svg>" + "<!-- x -->" * 6000 + "</svg>"), "", "zu groß")

    def test_nothing_that_could_run_or_load_something(self):
        for bad in (
            '<svg><script>alert(1)</script></svg>',
            '<svg onload="alert(1)"><rect/></svg>',
            '<svg><rect width="9" height="9" onclick = "x()"/></svg>',
            '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
            '<svg><foreignObject><iframe src="https://example.com"/></foreignObject></svg>',
            '<svg><image href="https://example.com/a.png"/></svg>',
            '<svg><use xlink:href="data:image/svg+xml;base64,AAAA#x"/></svg>',
            '<svg><use href="https://example.com/s.svg#a"/></svg>',
            '<svg><rect style="fill: url(https://example.com/x)"/></svg>',
            '<svg><style>@import "https://example.com/x.css";</style></svg>',
            '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>',
        ):
            with self.subTest(bad=bad):
                self.assertEqual(self.logo(bad), "")

    def test_the_window_hears_about_it_once(self):
        ui = RecordingUi()
        shop = Workshop({}, None, ui, lambda text: None)
        job = Job("Bau mir einen Bot", self.folder)
        shop._check_logo(job)
        self.assertEqual(ui.of("workshop"), [], "noch keins da")
        self.logo('<svg viewBox="0 0 256 256"><circle r="9"/></svg>')
        shop._check_logo(job)
        shop._check_logo(job)
        self.assertEqual(len(ui.of("workshop")), 1)
        self.assertEqual(ui.of("workshop")[0][1]["state"], "logo")
        self.logo('<svg viewBox="0 0 256 256"><rect width="9" height="9"/></svg>')
        shop._check_logo(job)
        self.assertEqual(len(ui.of("workshop")), 1, "ohne Hinweis kein neues Lesen")
        shop._check_logo(job, touched=True)
        self.assertEqual(len(ui.of("workshop")), 2, "geändert: das neue Logo")
        self.assertEqual(job.logo, ui.of("workshop")[1][1]["logo"])


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
        # Der ganze Stand für das Fenster (nach einem Neuladen), als JSON übertragbar
        snap = json.loads(json.dumps(self.workshop.snapshot()))
        self.assertEqual((snap["state"], snap["task"], snap["folder"]),
                         ("done", "Bau mir einen Discord-Bot, der Hallo sagt", str(job.folder)))
        self.assertEqual([t["text"] for t in snap["todos"]], ["Ordner anlegen", "Bot schreiben", "Testen"])
        self.assertEqual({s["state"] for s in snap["steps"]}, {"done"})
        self.assertTrue(snap["summary"].startswith("Der Bot ist fertig"))

    def test_tests_run_on_the_invisible_desktop_and_connectors_stay_on(self):
        from jarvis import versteckt

        started = []
        real = versteckt.popen

        def popen(cmd, cwd=None, env=None, hidden=True):
            started.append(hidden)
            return real(cmd, cwd=cwd, env=env, hidden=hidden)

        with mock.patch.object(versteckt, "popen", popen):
            self.workshop.start("Bau mir einen Discord-Bot, der Hallo sagt")
            self.wait()
        self.assertEqual(self.workshop.job.state, "done")
        self.assertEqual(started, [True], "die Werkstatt startet auf dem unsichtbaren Arbeitsplatz")
        args = json.loads((self.workshop.job.folder / "calls.jsonl").read_text(encoding="utf-8").splitlines()[0])["args"]
        self.assertNotIn("--safe-mode", args, "sonst wären Georgs Konnektoren aus (Logo, Deploy ...)")
        self.assertIn("--disable-slash-commands", args)

    def test_invisible_desktop_falls_back_to_a_normal_start(self):
        from jarvis import versteckt

        # Ohne Windows (oder wenn der Desktop nicht geht): ganz normal, mit denselben Leitungen
        proc = versteckt.popen([sys.executable, "-c", "import sys; print('echo:' + sys.stdin.readline().strip())"])
        proc.stdin.write("hallo\n")
        proc.stdin.flush()
        self.assertEqual(proc.stdout.readline().strip(), "echo:hallo")
        self.assertEqual(proc.wait(timeout=10), 0)
        if os.name != "nt":
            self.assertFalse(versteckt.available())

    def test_question_at_the_end_and_answer_continues_the_same_project(self):
        self.workshop.start("Bau mir einen Bot mit Token")
        self.wait()
        job = self.workshop.job
        self.assertEqual(job.question, "Wie lautet Ihr Bot-Token?")
        self.assertTrue(self.said[-1].endswith("Wie lautet Ihr Bot-Token?"))
        self.assertEqual(self.ui.of("workshop")[-1][1]["question"], "Wie lautet Ihr Bot-Token?")
        # Die nächste Antwort gehört der Werkstatt, aber nur eine echte Antwort
        self.assertIsNone(self.workshop.route("Wie spät ist es?", free=False))
        self.assertIsNone(self.workshop.route("Erzähl mir einen Witz"))
        self.assertEqual(self.workshop.route("Der Token steht in meiner Notiz"), "continue")
        said = self.workshop.follow_up("Der Token steht in meiner Notiz")
        self.assertEqual(said, "Sehr wohl, Sir. Ich mache in der Werkstatt weiter.")
        self.wait()
        again = self.workshop.job
        self.assertEqual((again.folder, again.session, again.state), (job.folder, job.session, "done"))
        calls = [json.loads(line) for line in (job.folder / "calls.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 2)
        second = calls[1]["args"]
        self.assertEqual(second[second.index("--resume") + 1], job.session)
        self.assertNotIn("--session-id", second)
        self.assertEqual(calls[1]["cwd"], str(job.folder))
        starts = [e[1] for e in self.ui.of("workshop") if e[1]["state"] == "start"]
        self.assertEqual([e["continues"] for e in starts], [False, True])
        # Nach etwas anderem gilt die Frage nicht mehr
        again.question = "Noch was?"
        self.workshop.forget_question()
        self.assertEqual(again.question, "")

    def test_the_logo_becomes_the_hologram(self):
        self.workshop.start("Bau mir einen Discord-Bot mit Logo")
        self.wait()
        job = self.workshop.job
        self.assertEqual(job.state, "done")
        events = [e[1] for e in self.ui.of("workshop")]
        logos = [e["logo"] for e in events if e["state"] == "logo"]
        self.assertEqual(len(logos), 1, "einmal, sobald logo.svg geschrieben ist")
        self.assertTrue(logos[0].startswith("data:image/svg+xml;base64,"))
        self.assertIn("<circle", base64.b64decode(logos[0].split(",", 1)[1]).decode("utf-8"))
        states = [e["state"] for e in events]
        self.assertLess(states.index("logo"), states.index("done"), "noch während der Arbeit")
        self.assertEqual(events[0]["logo"], "", "ein neues Projekt hat noch keins")
        self.assertEqual(self.workshop.snapshot()["logo"], logos[0], "auch nach einem Neuladen")
        # Am selben Projekt weiter: das Logo ist gleich beim Start da
        self.workshop.follow_up("Füg noch einen Befehl hinzu")
        self.wait()
        starts = [e[1] for e in self.ui.of("workshop") if e[1]["state"] == "start"]
        self.assertEqual(starts[-1]["logo"], logos[0])
        prompt = (self.home / "daten" / "werkstatt-persoenlichkeit.md").read_text(encoding="utf-8")
        self.assertIn("noch kein logo.svg", prompt)

    def test_wish_during_the_work_goes_into_the_running_job(self):
        self.workshop.start("Bau mir einen Discord-Bot, langsam")
        end = time.monotonic() + 5
        while not (self.workshop.job.live and self.workshop.job.sent == 1) and time.monotonic() < end:
            time.sleep(0.05)
        self.assertEqual(self.workshop.route("Mach den Hintergrund blau"), "tell")
        self.assertIsNone(self.workshop.route("Wie spät ist es?", free=False))
        answer = self.workshop.tell("Mach den Hintergrund blau")
        self.assertIn(answer, ["Sehr wohl, Sir. Ich baue das gleich mit ein.", "Notiert, Sir. Das kommt mit hinein.",
                               "Verstanden, Sir. Ich berücksichtige das."])
        context = self.workshop.context()
        self.assertIn("Bau mir einen Discord-Bot, langsam", context)
        self.assertIn("Mach den Hintergrund blau", context)
        self.wait(30)
        job = self.workshop.job
        self.assertEqual(job.state, "done")
        calls = [json.loads(line) for line in (job.folder / "calls.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["pid"], calls[1]["pid"], "in die laufende Arbeit, kein neuer Auftrag")
        self.assertEqual(calls[1]["prompt"], "Georg, während du arbeitest: Mach den Hintergrund blau")
        self.assertIn("Ihr Wunsch: Mach den Hintergrund blau", [e[1]["label"] for e in self.ui.of("progress")])
        self.assertEqual(self.workshop.context(), "", "danach läuft nichts mehr")

    def test_wish_with_a_long_silent_step_is_waited_for(self):
        # Nach der ersten Antwort arbeitet Claude den Wunsch ab, darin eine Installation ohne Ausgabe.
        # Das ist keine Stille "nach getaner Arbeit": die Werkstatt wartet auf die Antwort zum Wunsch.
        with mock.patch("jarvis.workshop.AFTER_RESULT", 1.0):
            self.workshop.start("Bau mir einen Discord-Bot, langsam")
            end = time.monotonic() + 5
            while not (self.workshop.job.live and self.workshop.job.sent == 1) and time.monotonic() < end:
                time.sleep(0.05)
            self.workshop.tell("lange-arbeit")
            self.wait(40)
        job = self.workshop.job
        self.assertEqual(job.state, "done")
        self.assertEqual((job.sent, job.results), (2, 2))
        self.assertIn("Spotify ist installiert", self.said[-1])

    def test_offer_to_start_the_result(self):
        from jarvis.workshop import Job

        folder = self.home / "Werkstatt" / "spiel"
        folder.mkdir(parents=True)
        (folder / "start.bat").write_text("@echo off\n", encoding="utf-8")
        job = Job("Bau mir ein Spiel", folder, model="sonnet")
        self.workshop.job = job
        self.workshop._finish(job, "done", "Das Spiel ist fertig, Sir.")
        self.assertEqual(self.said[-1], "Aus der Werkstatt: Das Spiel ist fertig, Sir. Soll ich es gleich starten?")
        self.assertEqual(self.workshop.route("Ja, bitte"), "run")
        with mock.patch("jarvis.workshop._start_file") as start:
            self.assertIn("startet", self.workshop.run_last())
        start.assert_called_once()
        self.assertIsNone(self.workshop.route("Ja"), "die Frage gilt nur einmal")

    def test_blocked_model_is_not_tried_again(self):
        self.brain.chooser.block("opus", 3600)
        self.assertEqual(self.workshop._usable("opus"), "sonnet")
        self.assertEqual(self.workshop._usable("sonnet"), "sonnet")

    def test_unknown_option_is_dropped_and_the_job_still_runs(self):
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "effort"}):
            self.workshop.start("Bau mir einen Discord-Bot, der Hallo sagt")
            self.wait()
        self.assertEqual(self.workshop.job.state, "done")
        self.assertIn("effort", self.brain._unsupported)
        args = json.loads((self.workshop.job.folder / "calls.jsonl").read_text(encoding="utf-8").splitlines()[-1])["args"]
        self.assertNotIn("--effort", args)

    def test_environment_for_projects(self):
        from jarvis.workshop import Job

        env = self.workshop.environment(Job("Bau mir was", self.home / "x"))
        self.assertEqual((env["PYTHONUTF8"], env["PYTHONIOENCODING"], env["JARVIS_WERKSTATT"]), ("1", "utf-8", "1"))
        self.assertTrue(env["PATH"].startswith(str(Path(env["JARVIS_PYTHON"]).parent)))
        persona = self.workshop._persona(Job("Bau mir was", self.home / "x"))
        text = persona.read_text(encoding="utf-8")
        self.assertTrue(persona.is_absolute())
        self.assertIn("Ein Ordner allein ist kein Ergebnis", text)
        self.assertIn("Stell keine Rückfragen", text)
        self.assertIn("nichts mit `jarvis.tool werkstatt` weiter", text)

    def test_handoff_from_the_brain(self):
        state = self.home / "daten"
        hand_over(state, "Bau mir einen Discord-Bot, der Hallo sagt")
        self.assertTrue(self.workshop.take_handoff(state))
        self.wait()
        self.assertEqual(self.workshop.job.state, "done")
        self.assertFalse((state / "werkstatt-auftrag.json").exists(), "abgeholt")
        self.assertFalse(self.workshop.take_handoff(state), "nichts mehr da")
        # Weiter am selben Projekt
        hand_over(state, "Füg noch einen Befehl hinzu", continue_last=True)
        folder = self.workshop.job.folder
        self.assertTrue(self.workshop.take_handoff(state))
        self.wait()
        self.assertEqual(self.workshop.job.folder, folder)
        # Uralte Übergaben (z. B. nach einem Absturz) werden nicht mehr ausgeführt
        path = hand_over(state, "Bau mir ein Spiel")
        data = json.loads(path.read_text(encoding="utf-8"))
        data["zeit"] = "2020-01-01T00:00:00"
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertFalse(self.workshop.take_handoff(state))

    def test_one_job_at_a_time_and_status_and_cancel(self):
        self.workshop.start("Bau mir ein langsames Spiel")
        time.sleep(1.0)
        self.assertIn("vorigen Auftrag", self.workshop.start("Bau mir noch was"))
        self.assertIn("Schritt", self.workshop.status())
        self.assertTrue(self.workshop.cancel())
        self.wait()
        self.assertEqual(self.workshop.job.state, "cancelled")
        self.assertIn("abgebrochen", self.said[-1])


class ToolHandoffTest(unittest.TestCase):
    def test_tool_writes_the_handoff_but_not_from_inside_the_workshop(self):
        from jarvis import tool

        with TemporaryDirectory() as folder, mock.patch("jarvis.tool.STATE_DIR", Path(folder)), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(tool.main(["werkstatt", "Bau", "mir", "einen", "Bot"]), 0)
            data = json.loads((Path(folder) / "werkstatt-auftrag.json").read_text(encoding="utf-8"))
            self.assertEqual((data["auftrag"], data["weiter"]), ("Bau mir einen Bot", False))
            self.assertIn("Werkstatt übernimmt", printed.call_args[0][0])
            self.assertEqual(tool.main(["werkstatt-weiter", "Füg", "noch", "was", "hinzu"]), 0)
            data = json.loads((Path(folder) / "werkstatt-auftrag.json").read_text(encoding="utf-8"))
            self.assertTrue(data["weiter"])
            with mock.patch.dict("os.environ", {"JARVIS_WERKSTATT": "1"}):
                self.assertEqual(tool.main(["werkstatt", "Bau", "was"]), 1)


class WindowApiTest(unittest.TestCase):
    """Was das Fenster in der Werkstatt aufrufen darf: Stand, Stopp, Ordner öffnen."""

    def setUp(self):
        from jarvis.gui.app import Api, GuiBridge

        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / "Jarvis-Werkstatt"
        self.base.mkdir()
        self.said = []
        self.shop = Workshop({"werkstatt": {"ordner": str(self.base)}}, None, RecordingUi(), self.said.append)
        self.api = Api(GuiBridge(), types.SimpleNamespace(workshop=self.shop), mute=None)

    def test_nothing_to_show_or_stop_without_a_job(self):
        self.assertIsNone(self.api.workshop_state())
        self.assertFalse(self.api.workshop_cancel())
        self.assertIsNone(api_without_workshop().workshop_state())

    def test_state_of_a_finished_job(self):
        from jarvis.steps import describe
        from jarvis.workshop import Job

        job = Job("Bau mir ein Spiel", self.base / "2026-10-01_1530_spiel")
        step = describe("t1", "Write", {"file_path": str(job.folder / "spiel.py")})
        step.finish()
        job.steps.append(step)
        job.todos = [{"text": "Spiel schreiben", "state": "completed"}]
        self.shop.job = job
        self.shop._finish(job, "done", "Das Spiel ist fertig, Sir. Starten Sie es mit start.bat.")
        snap = json.loads(json.dumps(self.api.workshop_state()))
        self.assertEqual(snap["state"], "done")
        self.assertEqual(snap["steps"][0]["label"], "Schreibt spiel.py")
        self.assertEqual(snap["todos"], [{"text": "Spiel schreiben", "state": "completed"}])
        self.assertRegex(snap["begun"], r"^\d\d:\d\d$")
        self.assertGreaterEqual(snap["seconds"], 0)
        self.assertFalse(self.api.workshop_cancel(), "fertige Arbeit lässt sich nicht mehr stoppen")
        self.assertTrue(self.said[-1].startswith("Aus der Werkstatt: Das Spiel ist fertig"))

    def test_projects_bring_their_logo(self):
        game = self.base / "2026-10-01_1530_spiel"
        bot = self.base / "2026-10-01_1600_bot"
        for folder, task in ((game, "Bau mir ein Spiel"), (bot, "Bau mir einen Bot")):
            folder.mkdir()
            (folder / "projekt.json").write_text(json.dumps({"auftrag": task, "zustand": "done"}), encoding="utf-8")
        (game / "logo.svg").write_text('<svg viewBox="0 0 256 256"><circle r="9"/></svg>', encoding="utf-8")
        (bot / "logo.svg").write_text('<svg onload="x()"><circle r="9"/></svg>', encoding="utf-8")
        items = {p["name"]: p for p in json.loads(json.dumps(self.api.workshop_projects()))}
        self.assertTrue(items["Spiel"]["logo"].startswith("data:image/svg+xml;base64,"))
        self.assertEqual(items["Bot"]["logo"], "", "kein Bild, in dem etwas laufen könnte")

    def test_open_folder_only_for_project_folders(self):
        project = self.base / "2026-10-01_1530_spiel"
        project.mkdir()
        outside = Path(self.tmp.name) / "anderswo"
        outside.mkdir()
        with mock.patch("os.startfile", create=True) as start, mock.patch("subprocess.Popen") as popen:
            self.assertTrue(self.api.open_folder(str(project)))
            self.assertFalse(self.api.open_folder(str(outside)))
            self.assertFalse(self.api.open_folder(str(self.base / ".." / "anderswo")))
            self.assertFalse(self.api.open_folder(str(self.base)))
            self.assertFalse(self.api.open_folder(str(project / "fehlt")))
            self.assertFalse(self.api.open_folder(""))
            self.assertFalse(self.api.open_folder(None))
        self.assertEqual(start.call_count + popen.call_count, 1, "nur der Projektordner wurde geöffnet")


def api_without_workshop():
    from jarvis.gui.app import Api, GuiBridge

    return Api(GuiBridge(), types.SimpleNamespace(), mute=None)


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

            def route(self, text, free=True):
                from jarvis.workshop import Workshop

                return Workshop.route(self, text, free)

            job = None

            def forget_question(self):
                pass

        brain = FakeBrain()
        assistant, _ui, _speaker, _ = make(brain)
        assistant.workshop = StubWorkshop()
        self.assertEqual(assistant.handle("Bau mir einen Discord-Bot"), "Sehr wohl, Sir. Ich gehe in die Werkstatt.")
        self.assertEqual(brain.asked, [])
        # Auch wenn ein anderer Sofort-Befehl einen Teil erkennen würde ("Such ...", "Öffne ...")
        self.assertEqual(assistant.handle("Ich brauche ein Programm, das YouTube öffnet und nach Musik sucht"),
                         "Sehr wohl, Sir. Ich gehe in die Werkstatt.")
        self.assertEqual(assistant.workshop.tasks[-1], "Ich brauche ein Programm, das YouTube öffnet und nach Musik sucht")
        assistant.workshop.busy = True
        self.assertEqual(assistant.handle("Wie weit bist du?"), "Ich bin bei Schritt 2 von 3, Sir.")
        self.assertEqual(assistant.handle("Brich die Werkstatt ab"), "Abgebrochen, Sir.")


if __name__ == "__main__":
    unittest.main()


class ModelAndProjectsTest(unittest.TestCase):
    """Opus für große Aufträge, und eine Übersicht über alle Projekte."""

    def test_model_choice(self):
        from jarvis.workshop import choose_model

        self.assertEqual(choose_model("Bau mir einen Discord-Bot, der würfelt"), "sonnet")
        self.assertEqual(choose_model("Bau mir ein Multiplayer-Spiel mit Login, Shop und Datenbank"), "opus")
        self.assertEqual(choose_model("Bau mir gründlich eine Webseite"), "opus")
        self.assertEqual(choose_model("Bau mir ein Spiel mit Login und Datenbank, aber nur kurz mit Sonnet"), "sonnet")
        self.assertEqual(choose_model("Bau mir ein Spiel mit Login und Datenbank", "sonnet"), "sonnet", "fest eingestellt")

    def test_commands(self):
        from jarvis.workshop import match_project

        self.assertEqual(match_project("Welche Projekte habe ich?"), ("list", ""))
        self.assertEqual(match_project("Arbeite am Discord-Bot weiter: füg einen Befehl hinzu"),
                         ("continue", "discord-bot", "füg einen befehl hinzu"))
        self.assertEqual(match_project("Öffne den Ordner vom Discord-Bot"), ("open", "discord-bot"))
        self.assertEqual(match_project("Starte das Projekt Würfelspiel"), ("run", "würfelspiel"))
        self.assertIsNone(match_project("Starte Spotify"))
        self.assertIsNone(match_project("Mach in der Werkstatt weiter"))
        # So schlägt es das Fenster nach einem Fehler vor
        self.assertEqual(match_project("Arbeite an Downloads Sortieren weiter"), ("continue", "downloads sortieren", ""))

    @posix_only
    def test_projects_are_listed_found_and_continued(self):
        with TemporaryDirectory() as tmp:
            home = Path(tmp)
            cfg = load_config()
            cfg["brain"]["claude_path"] = str(make_fake_claude(home))
            cfg["werkstatt"] = {"ordner": str(home / "Werkstatt"), "modell": "auto", "effort": "medium"}
            (home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
            brain = ClaudeBrain(cfg["brain"], home, home / "daten")
            self.addCleanup(brain.close)
            ui, said = RecordingUi(), []
            shop = Workshop(cfg, brain, ui, said.append)

            def wait():
                end = time.monotonic() + 15
                while shop.busy and time.monotonic() < end:
                    time.sleep(0.05)

            shop.start("Bau mir einen Discord-Bot, der Hallo sagt")
            wait()
            first = shop.job.folder
            shop.start("Bau mir ein Würfelspiel")
            wait()
            items = shop.projects()
            names = {p["name"] for p in items}
            self.assertEqual(len(items), 2)
            self.assertIn("Discord Bot Hallo Sagt", names)
            bot = shop.find_project("discord-bot")
            self.assertEqual(Path(bot["folder"]), first)
            self.assertEqual(bot["state"], "done")
            self.assertTrue(bot["session"])
            self.assertEqual(bot["model"], "sonnet")
            self.assertIsNone(shop.find_project("Raumschiff"))
            answer = shop.project_command("Arbeite am Discord-Bot weiter: füg einen Befehl hinzu")
            self.assertIn("Discord Bot Hallo Sagt", answer)
            wait()
            self.assertEqual(shop.job.folder, first, "am alten Projekt weiter, nicht am letzten")
            self.assertTrue(shop.job.resume)
            card = json.loads((first / "projekt.json").read_text(encoding="utf-8"))
            self.assertEqual(len(card["verlauf"]), 2)
            self.assertEqual(card["auftrag"], "Bau mir einen Discord-Bot, der Hallo sagt")
            listed = shop.project_command("Welche Projekte habe ich?")
            self.assertTrue(listed.startswith("2 Projekte, Sir."), listed)
            self.assertIn(("workshop", {"state": "projects"}), ui.events)
            self.assertIn("finde ich nicht", shop.project_command("Starte das Projekt Raumschiff"))
            self.assertIn("keine start.bat", shop.project_command("Starte das Projekt Discord-Bot"))

    def test_opus_falls_back_to_sonnet(self):
        from jarvis.workshop import Job

        cfg = load_config()
        cfg["werkstatt"] = {"modell": "auto"}
        brain = types.SimpleNamespace(claude_path="claude", _unsupported=set(), isolated=True, disallowed_tools=[],
                                      persona_path="", state_dir="")
        shop = Workshop(cfg, brain, RecordingUi(), lambda text: None)
        job = Job("Bau mir ein Multiplayer-Spiel mit Login, Shop und Datenbank", Path("/tmp/x"), model="opus")
        cmd = shop.command(job, Path("/tmp/p.md"))
        self.assertEqual(cmd[cmd.index("--model") + 1], "opus")
        self.assertEqual(cmd[cmd.index("--effort") + 1], "high")
