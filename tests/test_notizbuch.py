"""Fähigkeiten (SKILL.md, nur bei Bedarf gelesen) und das Notizbuch (Markdown, Obsidian-Tresor)."""

import datetime as dt
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.config import HOME_DIR, load_config
from jarvis.memory import Memory
from jarvis.notebook import END, START, Notebook, match_notebook, safe_title
from jarvis.skills import load_skills, remove_skill, save_skill


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_builtin_skills_all_have_a_description(self):
        skills = {s.path.parent.name: s for s in load_skills(HOME_DIR, self.state)}
        for name in ("discord-server", "morgen-briefing", "recherche", "notizbuch", "faehigkeit-lernen", "pc-pflege",
                     "spiele", "smart-home", "bildschirm"):
            self.assertIn(name, skills)
            self.assertGreater(len(skills[name].description), 30, name)
            self.assertFalse(skills[name].learned)

    def test_learned_skill_is_saved_listed_and_removed(self):
        path = save_skill(self.state, "Video rendern", "Ein Video mit OBS aufnehmen und für YouTube exportieren.",
                          "# Video rendern\n\n1. OBS öffnen\n2. Aufnahme starten und als MP4 speichern")
        self.assertEqual(path, self.state / "faehigkeiten" / "video-rendern" / "SKILL.md")
        self.assertTrue(path.read_text(encoding="utf-8").startswith("---\nname: video-rendern\ndescription: Ein Video"))
        learned = [s for s in load_skills(HOME_DIR, self.state) if s.learned]
        self.assertEqual([s.name for s in learned], ["video-rendern"])
        self.assertTrue(remove_skill(self.state, "Video rendern"))
        self.assertFalse(remove_skill(self.state, "recherche"), "mitgelieferte bleiben")
        with self.assertRaises(ValueError):
            save_skill(self.state, "x", "zu kurz", "Anleitung mit genug Text darin")

    def test_persona_lists_skills_and_learns_new_ones(self):
        from jarvis.persona import build_persona, persona_refresher

        cfg = load_config()
        text = build_persona(HOME_DIR, self.state, cfg).read_text(encoding="utf-8")
        self.assertIn("## Deine Fähigkeiten", text)
        self.assertIn("- discord-server: ", text)
        self.assertIn("## Notizbuch", text)
        self.assertNotIn("Planformat", text, "die Einzelheiten stehen in der Fähigkeit, nicht im Grundtext")
        refresh = persona_refresher(HOME_DIR, self.state, cfg)
        refresh()  # nichts Neues: bleibt
        save_skill(self.state, "obs-aufnahme", "Ein Video mit OBS aufnehmen und exportieren.", "1. OBS öffnen und aufnehmen")
        refresh()
        self.assertIn("- obs-aufnahme*: Ein Video mit OBS", (self.state / "persona.md").read_text(encoding="utf-8"))

    def test_brain_refreshes_before_starting_claude(self):
        from jarvis.brain import ClaudeBrain

        with mock.patch("jarvis.brain.find_claude", return_value="claude"):
            brain = ClaudeBrain({"models": ["sonnet"]}, HOME_DIR, self.state, persona=self.state / "persona.md")
        called = []
        brain.refresh_persona = lambda: called.append(1)
        brain.command()
        self.assertEqual(called, [1])


class NotebookTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name) / "Notizbuch"
        self.clock = Clock(dt.datetime(2026, 10, 2, 18, 5))
        self.book = Notebook(self.root, now=self.clock)

    def tearDown(self):
        self.folder.cleanup()

    def test_diary_links_people(self):
        self.book.log("Schreib Max, dass ich gleich komme", "An Max ist raus, Sir.", ["Max"])
        self.clock.when = dt.datetime(2026, 10, 2, 18, 9)
        self.book.log("Öffne Discord", "")
        text = (self.root / "Tagebuch" / "2026-10-02.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# Freitag, 2. Oktober 2026"))
        self.assertIn("- **18:05** Georg: Schreib [[Max]], dass ich gleich komme\n  - Jarvis: An Max ist raus, Sir.", text)
        self.assertIn("- **18:09** Georg: Öffne Discord\n", text)
        self.assertEqual(text.count("# Freitag"), 1)

    def test_notes_reports_and_search(self):
        self.book.note("Milch kaufen")
        self.book.note("Max anrufen")
        notes = (self.root / "Notizen" / "Schnellnotizen.md").read_text(encoding="utf-8")
        self.assertIn("- **2.10. 18:05** Milch kaufen", notes)
        first = self.book.report("Beste Gaming-Mäuse 2026: Test", "Die Logitech ist am leichtesten.\n\n| Maus | Gewicht |")
        second = self.book.report("Beste Gaming-Mäuse 2026: Test", "Noch ein Bericht mit genug Text darin.")
        self.assertEqual(first.name, "Beste Gaming-Mäuse 2026 Test.md")
        self.assertEqual(second.name, "Beste Gaming-Mäuse 2026 Test (2).md")
        self.assertTrue(first.read_text(encoding="utf-8").startswith("# Beste Gaming-Mäuse 2026 Test\n\n*Von Jarvis"))
        hits = self.book.search("logitech leicht")
        self.assertEqual([(h[0].replace("\\", "/"), h[2]) for h in hits],
                         [("Recherchen/Beste Gaming-Mäuse 2026 Test.md", "Die Logitech ist am leichtesten.")])
        self.assertEqual(self.book.search(""), [])

    def test_sync_writes_overview_and_keeps_own_notes(self):
        memory = Memory(Path(self.folder.name) / "g.json", now=self.clock)
        memory.remember("Max hat am 3. Mai Geburtstag")
        memory.remember("Max spielt gern Valorant")
        memory.record("message", "Max", app="discord")
        memory.teach("Zockmodus", "öffne Discord und Steam")
        self.book.log("Öffne Discord", "Discord kommt.")
        self.book.sync(memory)
        person = self.root / "Personen" / "Max.md"
        text = person.read_text(encoding="utf-8")
        self.assertIn("- Schreibt mit Georg über: Discord", text)
        self.assertIn("- Geburtstag: 3. Mai", text)
        self.assertIn("  - Max spielt gern Valorant", text)
        person.write_text(text + "\nMeine eigene Notiz: schuldet mir 5 Euro.\n", encoding="utf-8")
        memory.remember("Max mag Pizza")
        self.book.sync(memory)
        text = person.read_text(encoding="utf-8")
        self.assertIn("  - Max mag Pizza", text)
        self.assertIn("Meine eigene Notiz: schuldet mir 5 Euro.", text)
        self.assertEqual(text.count(START), 1)
        start = (self.root / "Start.md").read_text(encoding="utf-8")
        self.assertIn("- [[2026-10-02]]", start)
        self.assertIn("[[Max]]", start)
        self.assertIn("- **Zockmodus**: öffne Discord und Steam", (self.root / "Gedächtnis.md").read_text(encoding="utf-8"))
        self.assertIn(END, start)

    def test_learned_facts_go_under_the_day(self):
        self.book.learned(dt.date(2026, 10, 1), ["Georg spielt gern Valorant."])
        self.assertIn("## Gelernt\n\n- Georg spielt gern Valorant.", self.book.day_text(dt.date(2026, 10, 1)))

    def test_file_names_are_safe(self):
        self.assertEqual(safe_title('Was ist "besser": A/B? [Test]'), "Was ist besser A B Test")
        self.assertEqual(safe_title("..."), "Notiz")

    def test_sentences(self):
        self.assertEqual(match_notebook("Notiere: Milch kaufen"), ("note", "Milch kaufen"))
        self.assertEqual(match_notebook("Jarvis, schreib in mein Notizbuch, dass ich Max anrufen muss"),
                         ("note", "Dass ich Max anrufen muss"))
        self.assertEqual(match_notebook("Notiz: Reifen wechseln"), ("note", "Reifen wechseln"))
        self.assertEqual(match_notebook("Öffne mein Notizbuch"), ("open", ""))
        self.assertIsNone(match_notebook("Schreib Max auf Discord, bin gleich da"))
        self.assertIsNone(match_notebook("Notiere das"))


class AssistantNotebookTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.folder = tempfile.TemporaryDirectory()
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant.memory = Memory(Path(self.folder.name) / "g.json")
        self.assistant.notebook = Notebook(Path(self.folder.name) / "Notizbuch")
        self.assistant.notebook.last_sync = float("inf")  # keine Übersicht im Hintergrund während des Tests
        self.assistant._disk_checked = float("inf")

    def tearDown(self):
        self.folder.cleanup()

    def test_note_without_claude_and_everything_in_the_diary(self):
        answer = self.assistant.handle("Notiere, dass ich Max anrufen muss")
        self.assertIn(answer, ("Notiert, Sir. Steht im Notizbuch.", "Ist im Notizbuch, Sir."))
        self.assertEqual(self.brain.asked, [])
        notes = (self.assistant.notebook.folder / "Notizen" / "Schnellnotizen.md").read_text(encoding="utf-8")
        self.assertIn("Ich muss Max anrufen", notes)
        self.assistant.handle("Wie spät ist es?")
        diary = self.assistant.notebook.day_text(dt.date.today())
        self.assertIn("Georg: Notiere, dass ich Max anrufen muss", diary)
        self.assertIn("Georg: Wie spät ist es?\n  - Jarvis: Es ist", diary)

    def test_secrets_stay_out_of_the_diary(self):
        self.assistant.handle("Notiere: mein Passwort ist geheim123")
        diary = self.assistant.notebook.day_text(dt.date.today())
        self.assertNotIn("geheim123", diary)
        self.assertIn("(etwas Vertrauliches, nicht notiert)", diary)

    def test_open_notebook(self):
        with mock.patch("jarvis.assistant.os.startfile", create=True) as started, \
                mock.patch("jarvis.assistant.os.name", "nt"):
            self.assertEqual(self.assistant.handle("Öffne mein Notizbuch"), "Das Notizbuch ist offen, Sir.")
        started.assert_called_once_with(str(self.assistant.notebook.folder))
        self.assertTrue((self.assistant.notebook.folder / "Start.md").exists())


class ToolTest(unittest.TestCase):
    def test_notebook_and_skill_commands(self):
        from jarvis import tool

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cfg = load_config()
            cfg["notizbuch"] = {"aktiv": True, "ordner": str(root / "Notizbuch"), "tagebuch": True}
            report = root / "bericht.md"
            report.write_text("# Mäuse\n\nDie Logitech G Pro ist am leichtesten.", encoding="utf-8")
            skill = root / "skill.md"
            skill.write_text("# OBS\n\n1. OBS öffnen\n2. Aufnahme starten", encoding="utf-8")
            out = io.StringIO()
            with mock.patch.object(tool, "STATE_DIR", root), mock.patch.object(tool, "load_config", return_value=cfg), \
                    redirect_stdout(out):
                self.assertEqual(tool.main(["notiz", "Milch kaufen"]), 0)
                self.assertEqual(tool.main(["bericht", "Gaming-Mäuse", str(report)]), 0)
                self.assertEqual(tool.main(["notizbuch-suchen", "logitech"]), 0)
                self.assertEqual(tool.main(["notizbuch-tag", "gestern"]), 0)
                self.assertEqual(tool.main(["faehigkeit", "obs-aufnahme", "Ein Video mit OBS aufnehmen.", str(skill)]), 0)
                self.assertEqual(tool.main(["faehigkeiten"]), 0)
                self.assertEqual(tool.main(["faehigkeit-loeschen", "obs-aufnahme"]), 0)
            text = out.getvalue()
            self.assertIn("Notiert in", text)
            self.assertIn("Bericht liegt im Notizbuch", text)
            self.assertIn("Die Logitech G Pro ist am leichtesten.", text)
            self.assertIn("steht nichts im Tagebuch", text)
            self.assertIn("obs-aufnahme [gelernt]: Ein Video mit OBS aufnehmen.", text)
            self.assertIn("Fähigkeit gelöscht.", text)


class WindowTest(unittest.TestCase):
    def test_memory_view_lists_skills_and_opens_the_notebook(self):
        from jarvis.gui.app import Api

        with tempfile.TemporaryDirectory() as folder:
            api = Api.__new__(Api)
            api._assistant = mock.Mock(memory=Memory(Path(folder) / "g.json"),
                                       notebook=Notebook(Path(folder) / "Notizbuch"))
            state = api.memory_state()
            self.assertTrue(state["notebook"])
            self.assertIn("recherche", [s["name"] for s in state["skills"]])
            result = api.notebook_open()
            self.assertTrue(result["ok"])
            self.assertTrue((Path(folder) / "Notizbuch" / "Start.md").exists())


if __name__ == "__main__":
    unittest.main()
