"""Einkaufsliste: "Mandelmus ist alle", "Milch gekauft", was draufsteht, Claude kennt sie, jarvis.tool ändert sie."""

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.einkauf import answer, match_einkauf, split_items
from jarvis.memory import Memory


class MatchTest(unittest.TestCase):
    def test_add(self):
        for said, items in [
            ("Setz Mandelmus auf die Einkaufsliste", ["Mandelmus"]),
            ("Schreib Milch und Eier auf meine Einkaufsliste", ["Milch", "Eier"]),
            ("Füg Brot zur Einkaufsliste hinzu", ["Brot"]),
            ("Trag Nudeln in die Einkaufsliste ein", ["Nudeln"]),
            ("Pack noch Bananen auf die Liste", ["Bananen"]),
            ("Einkaufsliste: Milch, Eier und zwei Avocados", ["Milch", "Eier", "zwei Avocados"]),
            ("Das Mandelmus ist alle", ["Mandelmus"]),
            ("Hey Jarvis, der Kaffee ist fast alle.", ["Kaffee"]),
            ("Die Eier sind aufgebraucht", ["Eier"]),
            ("Wir haben keine Milch mehr", ["Milch"]),
        ]:
            self.assertEqual(match_einkauf(said), ("add", items), said)

    def test_show_remove_clear(self):
        for said in ("Was steht auf der Einkaufsliste?", "Einkaufsliste", "Was muss ich noch einkaufen?",
                     "Jarvis, was soll ich einkaufen?", "Zeig mir die Einkaufsliste"):
            self.assertEqual(match_einkauf(said), ("show", []), said)
        self.assertEqual(match_einkauf("Mandelmus gekauft"), ("remove", ["Mandelmus"]))
        self.assertEqual(match_einkauf("Hab die Milch geholt"), ("remove", ["Milch"]))
        self.assertEqual(match_einkauf("Streich Milch von der Einkaufsliste"), ("remove", ["Milch"]))
        self.assertEqual(match_einkauf("Einkaufsliste leeren"), ("clear", []))
        self.assertEqual(match_einkauf("Alles gekauft"), ("clear", []))
        self.assertEqual(match_einkauf("Alles erledigt von der Einkaufsliste"), ("clear", []))
        self.assertIsNone(match_einkauf("Alles erledigt"), "sagt man auch nach der Arbeit: Liste bleibt")

    def test_not_for_the_list(self):
        for said in ("Der Akku ist leer", "Das Licht ist aus", "Das ist alle", "Meine Nerven sind alle",
                     "Hast du Milch gekauft?", "Öffne Spotify", "Setz Max auf die Gästeliste",
                     "Wie spät ist es?", ""):
            self.assertIsNone(match_einkauf(said), said)

    def test_missing_but_not_from_the_supermarket(self):
        # Probleme am PC und Gefühle gehen an Claude, nicht auf die Einkaufsliste
        for said in ("Ich habe keinen Ton mehr", "Ich hab kein Internet mehr", "Wir haben kein WLAN mehr",
                     "Ich habe keine Lust mehr", "Ich habe keine Fragen mehr", "Mein Handy-Akku ist alle",
                     "Das Datenvolumen ist alle"):
            self.assertIsNone(match_einkauf(said), said)
        self.assertEqual(match_einkauf("Die Tinte ist alle"), ("add", ["Tinte"]))
        self.assertEqual(match_einkauf("Setz Brot für die Kinder auf die Einkaufsliste"),
                         ("add", ["Brot für die Kinder"]), "ausdrücklich auf die Liste: immer")

    def test_split_items(self):
        self.assertEqual(split_items("die Milch, ein paar Eier sowie 6 Brötchen und noch Käse"),
                         ["Milch", "Eier", "6 Brötchen", "Käse"])


class ListTest(unittest.TestCase):
    def setUp(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(folder, ignore_errors=True))
        self.path = folder / "gedaechtnis.json"
        self.memory = Memory(self.path)

    def test_add_remove_without_doubles(self):
        self.assertEqual(self.memory.shop_add(["mandelmus", "Milch"]), ["Mandelmus", "Milch"])
        self.assertEqual(self.memory.shop_add(["Milch", "Passwort 1234"]), [], "doppelt und Geheimes nie")
        self.assertEqual(self.memory.shopping(), ["Mandelmus", "Milch"])
        self.assertEqual(self.memory.shop_remove(["das Mandelmus"]), ["Mandelmus"])
        self.assertEqual(self.memory.shop_remove(["Hafermilch"]), [], "Milch ist nicht Hafermilch")
        self.assertEqual(Memory(self.path).shopping(), ["Milch"], "bleibt gespeichert")
        self.assertEqual(self.memory.shop_clear(), 1)
        self.assertEqual(self.memory.shopping(), [])

    def test_answers(self):
        self.assertEqual(answer(self.memory, "show", []), "Ihre Einkaufsliste ist leer, Sir.")
        self.assertIn("Mandelmus", answer(self.memory, "add", ["Mandelmus"]))
        self.assertEqual(answer(self.memory, "add", ["Mandelmus"]), "Mandelmus steht schon auf der Liste, Sir.")
        answer(self.memory, "add", ["Milch", "Eier"])
        self.assertEqual(answer(self.memory, "show", []), "Auf Ihrer Einkaufsliste, Sir: Mandelmus, Milch und Eier.")
        self.assertEqual(answer(self.memory, "remove", ["Milch"]), "Abgehakt, Sir: Milch. Noch offen: Mandelmus und Eier.")
        self.assertIsNone(answer(self.memory, "remove", ["Auto"]), "nicht auf der Liste: Unterhaltung für Claude")
        answer(self.memory, "clear", [])
        self.assertEqual(self.memory.shopping(), [])

    def test_claude_knows_the_list(self):
        self.memory.shop_add(["Mandelmus"])
        context = self.memory.context()
        self.assertIn("Einkaufsliste: Mandelmus", context)
        self.assertIn("jarvis.tool einkauf", context)

    def test_tool(self):
        from jarvis import tool

        with mock.patch.object(tool, "STATE_DIR", self.path.parent), mock.patch.object(tool, "load_config", return_value={}):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(tool.main(["einkauf", "dazu", "Mandelmus", "Milch"]), 0)
                self.assertEqual(tool.main(["einkauf", "weg", "Milch"]), 0)
                self.assertEqual(tool.main(["einkauf"]), 0)
                self.assertEqual(tool.main(["einkauf", "dazu"]), 1)
        text = out.getvalue()
        self.assertIn("Auf der Einkaufsliste: Mandelmus und Milch.", text)
        self.assertIn("Abgehakt: Milch.", text)
        self.assertIn("Einkaufsliste: Mandelmus.", text)
        self.assertEqual(Memory(self.path).shopping(), ["Mandelmus"])


class AssistantTest(unittest.TestCase):
    def test_spoken_without_claude(self):
        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain)
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(folder, ignore_errors=True))
        assistant.memory = Memory(folder / "gedaechtnis.json")
        self.assertIn("Mandelmus", assistant.handle("Das Mandelmus ist alle", speak=False))
        self.assertEqual(assistant.handle("Was steht auf der Einkaufsliste?", speak=False),
                         "Auf Ihrer Einkaufsliste, Sir: Mandelmus.")
        self.assertIn("Abgehakt", assistant.handle("Mandelmus gekauft", speak=False))
        self.assertEqual(brain.asked, [], "alles ohne Claude")
        assistant.handle("Ich habe ein neues Auto gekauft", speak=False)
        self.assertEqual(len(brain.asked), 1, "nicht auf der Liste: Claude antwortet")

    def test_extra_goes_only_to_claude(self):
        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain)
        assistant.handle("Öffne Spotify", speak=False, extra="(Dazu ein Foto: C:/foto.jpg)")
        self.assertEqual(brain.asked, ["Öffne Spotify\n\n(Dazu ein Foto: C:/foto.jpg)"], "kein Sofort-Befehl")
        shown = [e[2] for e in ui.events if e[0] == "message" and e[1] == "user"]
        self.assertEqual(shown, ["Öffne Spotify"], "der Pfad steht nicht im Verlauf")


if __name__ == "__main__":
    unittest.main()
