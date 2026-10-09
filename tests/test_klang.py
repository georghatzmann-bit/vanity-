"""Ähnlich klingende Namen (klang.py): Was die Spracherkennung schreibt, findet trotzdem das Richtige."""

import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import klang


class PhoneticsTest(unittest.TestCase):
    def test_koelner_phonetik(self):
        self.assertEqual(klang.koelner("Meyer"), klang.koelner("Maier"))
        self.assertEqual(klang.koelner("Müller"), "657")
        self.assertEqual(klang.koelner("Spotify"), klang.koelner("Spottifei"))
        self.assertEqual(klang.koelner("Discord"), klang.koelner("Diskort"), "englisch eingedeutscht")
        self.assertEqual(klang.koelner("Max"), klang.koelner("Maks"))
        self.assertEqual(klang.koelner(""), "")

    def test_heard_names_find_the_real_ones(self):
        apps = ["Spotify", "Discord", "Steam", "Microsoft Edge", "Visual Studio Code"]
        self.assertEqual(klang.closest("Spottifei", apps), "Spotify")
        self.assertEqual(klang.closest("Diskort", apps), "Discord")
        self.assertEqual(klang.closest("Stiem", apps), "Steam")
        self.assertIsNone(klang.closest("Kühlschrank", apps))
        self.assertIsNone(klang.closest("Danke", ["Anke"], cutoff=0.86, same_start=True), "nie ein anderes Wort")

    def test_app_search_uses_the_sound(self):
        from jarvis.apps import best_match, find_known

        self.assertEqual(find_known("Spottifei").name, "Spotify")
        apps = [("Spotify", "Spotify.exe"), ("Discord", "Discord.exe"), ("Notepad++", "npp")]
        self.assertEqual(best_match("Diskort", apps), ("Discord", "Discord.exe"))
        self.assertIsNone(best_match("Kühlschrank", apps), "zu weit weg: lieber Claude fragen als das Falsche öffnen")

    def test_contacts_and_own_commands(self):
        from jarvis.assistant import Assistant

        assistant = Assistant.__new__(Assistant)
        assistant.memory = mock.Mock(contacts=lambda: [{"name": "Max"}, {"name": "Luca"}, {"name": "Anna"}])
        self.assertEqual(assistant.known_person("Maks"), "Max")
        self.assertEqual(assistant.known_person("Lucka"), "Luca")
        self.assertEqual(assistant.known_person("Peter"), "Peter", "Unbekannte bleiben, wie sie sind")
        self.assertEqual(assistant.known_person("#allgemein"), "#allgemein")

    def test_own_command_by_sound(self):
        import datetime as dt
        import tempfile
        from pathlib import Path

        from jarvis.memory import Memory

        with tempfile.TemporaryDirectory() as folder:
            memory = Memory(Path(folder) / "gedaechtnis.json", now=lambda: dt.datetime(2026, 10, 2, 18, 0))
            memory.teach("Zockmodus", "Öffne Discord und Steam")
            self.assertEqual(memory.command_for("Zogmodus")["key"], "zockmodus")
            self.assertIsNone(memory.command_for("Danke"))
            self.assertIsNone(memory.command_for("Wie spät ist es im Zogmodus heute Abend bitte"), "nur kurze Sätze")


if __name__ == "__main__":
    unittest.main()
