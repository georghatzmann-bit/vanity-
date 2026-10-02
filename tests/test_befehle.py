"""Eigene Befehle: "Wenn ich Zockmodus sage, öffne Discord und Steam", danach reicht "Zockmodus"."""

import datetime as dt
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.memory import Memory, match_memory


class ParseTest(unittest.TestCase):
    def test_ways_to_teach(self):
        for said, expected in [
            ("Wenn ich Zockmodus sage, öffne Discord und Steam", ("Zockmodus", "öffne Discord und Steam")),
            ("Jarvis, wenn ich „Feierabend“ sage, dann schließ alle Programme", ("Feierabend", "schließ alle Programme")),
            ("Merk dir: Sobald ich Kino sage, mach das Licht aus", ("Kino", "mach das Licht aus")),
            ("Wenn ich sage: Lernzeit, dann spiel Lofi auf Spotify", ("Lernzeit", "spiel Lofi auf Spotify")),
            ("Neuer Befehl Zockmodus: öffne Discord", ("Zockmodus", "öffne Discord")),
            ("Lerne den Befehl Feierabend, schließ alles", ("Feierabend", "schließ alles")),
            ("Wenn ich Zockmodus sage, sollst du Discord öffnen", ("Zockmodus", "Discord öffnen")),
        ]:
            self.assertEqual(match_memory(said), ("teach", expected), said)

    def test_not_a_command(self):
        for said in ("Wenn ich nach Hause komme, mach das Licht an", "Wenn ich morgen aufstehe, sag mir das Wetter",
                     "Wenn ich Hallo sage, was machst du dann?", "Wenn ich dir sage, du sollst leiser sein, dann hör auf",
                     "Wenn ich es dir sage, dann mach es", "Wenn ich morgen Bescheid sage, mach das Licht an"):
            self.assertIsNone(match_memory(said), said)
        self.assertEqual(match_memory("Merk dir, dass ich Pizza mag")[0], "remember")

    def test_list_and_delete(self):
        self.assertEqual(match_memory("Welche Befehle kennst du?"), ("commands", ""))
        self.assertEqual(match_memory("Was sind meine eigenen Befehle?"), ("commands", ""))
        self.assertEqual(match_memory("Lösch den Befehl Zockmodus"), ("unteach", "Zockmodus"))
        self.assertEqual(match_memory("Vergiss den Befehl „Feierabend“"), ("unteach", "Feierabend"))


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.memory = Memory(Path(self.folder.name) / "g.json", now=lambda: dt.datetime(2026, 10, 2, 18, 0))

    def tearDown(self):
        self.folder.cleanup()

    def test_free_forms_find_the_command(self):
        self.memory.teach("Zockmodus", "öffne Discord und Steam")
        for said in ("Zockmodus", "Hey Jarvis, Zockmodus!", "Starte den Zockmodus", "Zockmodus an",
                     "Führe Zockmodus aus", "zockmodus bitte"):
            self.assertEqual(self.memory.command_for(said)["aktion"], "öffne Discord und Steam", said)
        for said in ("Zockmodus aus", "Öffne Discord", "Was ist der Zockmodus?"):
            self.assertIsNone(self.memory.command_for(said), said)

    def test_same_name_replaces_and_reserved_words_are_refused(self):
        self.memory.teach("Zockmodus", "öffne Discord")
        self.memory.teach("„zockmodus“", "öffne Steam")
        self.assertEqual([(c["name"], c["aktion"]) for c in self.memory.custom_commands()], [("Zockmodus", "öffne Steam")])
        for name in ("Stopp", "ja", "x"):
            with self.assertRaises(ValueError):
                self.memory.teach(name, "öffne Discord")
        with self.assertRaises(ValueError):
            self.memory.teach("Bank", "tipp mein Passwort ein")

    def test_context_tells_claude(self):
        self.memory.teach("Feierabend", "schließ Discord und spiel Lofi")
        self.assertIn("„Feierabend“ = schließ Discord und spiel Lofi", self.memory.context())


class AssistantTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.folder = tempfile.TemporaryDirectory()
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant.memory = Memory(Path(self.folder.name) / "g.json")
        self.assistant._disk_checked = float("inf")

    def tearDown(self):
        self.folder.cleanup()

    def test_teach_then_one_word_does_everything_without_claude(self):
        answer = self.assistant.handle("Wenn ich Zockmodus sage, öffne Discord und Steam")
        self.assertIn("„Zockmodus“", answer)
        with mock.patch("jarvis.apps.open_app", side_effect=lambda name: f"{name} startet.") as opened:
            answer = self.assistant.handle("Zockmodus")
        self.assertEqual([c.args[0] for c in opened.call_args_list], ["discord", "steam"])
        self.assertIn("steam", answer.lower())
        self.assertEqual(self.brain.asked, [])
        self.assertIn(("Eigener Befehl: Zockmodus", "done"), [(e[1]["label"], e[1]["state"]) for e in self.ui.of("progress")])
        self.assertEqual(self.assistant.memory.custom_commands()[0]["anzahl"], 1)

    def test_what_jarvis_cannot_do_alone_goes_to_claude(self):
        self.assistant.handle("Wenn ich Witzestunde sage, erzähl mir einen Witz über Programmierer")
        self.assistant.handle("Witzestunde")
        self.assertEqual(self.brain.asked, ["erzähl mir einen Witz über Programmierer"])

    def test_list_delete_and_refuse(self):
        self.assertIn("Noch keine eigenen Befehle", self.assistant.handle("Welche Befehle kennst du?"))
        self.assistant.handle("Wenn ich Zockmodus sage, öffne Discord")
        self.assistant.handle("Neuer Befehl Feierabend: schließ Discord")
        self.assertEqual(self.assistant.handle("Was sind meine Befehle?"),
                         "Sie haben 2 eigene Befehle, Sir: „Feierabend“ und „Zockmodus“.")
        self.assertEqual(self.assistant.handle("Lösch den Befehl Zockmodus"), "Der Befehl „Zockmodus“ ist gelöscht, Sir.")
        self.assertIn("kenne ich nicht", self.assistant.handle("Lösch den Befehl Zockmodus"))
        self.assertIn("brauche ich selbst", self.assistant.handle("Wenn ich Stopp sage, öffne Discord"))
        self.assertEqual(self.brain.asked, [])

    def test_stop_still_stops(self):
        self.assistant.memory.teach("Feierabend", "schließ Discord")
        self.assertIsNone(self.assistant.memory.command_for("Stopp"))


class WindowAndPhoneTest(unittest.TestCase):
    def test_window_shows_and_deletes_commands(self):
        from jarvis.gui.app import Api

        with tempfile.TemporaryDirectory() as folder:
            memory = Memory(Path(folder) / "g.json")
            api = Api.__new__(Api)
            api._assistant = mock.Mock(memory=memory)
            self.assertTrue(api.remember("Wenn ich Zockmodus sage, öffne Discord und Steam"))
            self.assertEqual(memory.facts(), [], "kein Fakt, sondern ein Befehl")
            state = api.memory_state()
            self.assertEqual(state["commands"], [{"key": "zockmodus", "name": "Zockmodus",
                                                  "action": "öffne Discord und Steam", "count": 0}])
            self.assertTrue(api.command_forget("zockmodus"))
            self.assertEqual(api.memory_state()["commands"], [])

    def test_phone_gets_the_commands_as_buttons(self):
        from jarvis.server import _status

        with tempfile.TemporaryDirectory() as folder:
            memory = Memory(Path(folder) / "g.json")
            memory.teach("Zockmodus", "öffne Discord und Steam")
            assistant = mock.Mock(memory=memory, busy=False, workshop=None, gaming=False, mute=None)
            self.assertEqual(_status(assistant, None)["befehle"], [{"name": "Zockmodus", "aktion": "öffne Discord und Steam"}])


class ToolTest(unittest.TestCase):
    def test_claude_can_teach_list_and_delete(self):
        from jarvis import tool

        with tempfile.TemporaryDirectory() as folder, mock.patch.object(tool, "STATE_DIR", Path(folder)):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(tool.main(["befehl", "Kino", "Mach das Licht aus und die Lautstärke auf 40"]), 0)
                self.assertEqual(tool.main(["befehle"]), 0)
                self.assertEqual(tool.main(["befehl-loeschen", "Kino"]), 0)
                self.assertEqual(tool.main(["befehl", "Stopp", "öffne Discord"]), 1)
            text = out.getvalue()
            self.assertIn("Eigener Befehl gespeichert: „Kino“", text)
            self.assertIn("Kino: Mach das Licht aus und die Lautstärke auf 40", text)
            self.assertIn("Befehl gelöscht: Kino", text)
            self.assertIn("brauche ich selbst", text)


if __name__ == "__main__":
    unittest.main()
