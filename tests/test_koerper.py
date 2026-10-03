"""Ernährungs-Tagebuch: Essensfotos aus Telegram landen über jarvis.tool essen in denselben Dateien wie beim
Claude-Plugin Körper (ernaehrung.csv und die Tagesdatei), mit Tagessumme und Zielen."""

import csv
import datetime as dt
import io
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import koerper

NOON = dt.datetime(2026, 10, 3, 12, 40)


class KoerperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.folder = self.tmp / "Körper"

    def rows(self):
        with (self.folder / "ernaehrung.csv").open(encoding="utf-8", newline="") as source:
            return list(csv.DictReader(source))

    def test_a_meal_lands_in_the_plugin_files(self):
        result = koerper.add(self.folder, "Nudeln mit Tomatensoße", "300 g", "465", "15,9", 90, 4.5, now=NOON)
        koerper.add(self.folder, "Olivenöl", 10, 88, 0, 0, 10, now=NOON)
        rows = self.rows()
        self.assertEqual(list(rows[0]), list(koerper.FIELDS), "dieselbe Kopfzeile wie im Plugin")
        self.assertEqual(rows[0], {"datum": "2026-10-03", "uhrzeit": "12:40", "mahlzeit": "Mittagessen",
                                   "lebensmittel": "Nudeln mit Tomatensoße", "menge_g": "300", "kcal": "465",
                                   "eiweiss_g": "15.9", "kohlenhydrate_g": "90", "fett_g": "4.5",
                                   "quelle": "Schätzung"})
        self.assertEqual(result["tag"]["kcal"], 465)
        day = (self.folder / "Ernährung" / "2026-10-03.md").read_text(encoding="utf-8")
        self.assertIn("| 12:40 | Mittagessen | Nudeln mit Tomatensoße | 300 g | 465 | 15,9 g | 90 g | 4,5 g |", day)
        self.assertIn("**Summe:** 553 kcal · 15,9 g Eiweiß · 90 g Kohlenhydrate · 14,5 g Fett", day)

    def test_meal_names_follow_the_clock_or_what_georg_says(self):
        for hour, minute, meal in ((7, 0, "Frühstück"), (10, 30, "Frühstück"), (13, 0, "Mittagessen"),
                                   (16, 0, "Snack"), (19, 30, "Abendessen")):
            self.assertEqual(koerper.meal_for(dt.time(hour, minute)), meal)
        row = koerper.add(self.folder, "Apfel", 150, 78, 0.4, 21, 0.3, meal="snack", source="Etikett", now=NOON)["zeile"]
        self.assertEqual((row["mahlzeit"], row["quelle"]), ("Snack", "Etikett"))

    def test_goals_and_the_answer_for_the_brain(self):
        self.folder.mkdir(parents=True)
        (self.folder / "Ziele.md").write_text("# Ziele\n\n- kcal: 2400\n- eiweiss_g: 160\n", encoding="utf-8")
        result = koerper.add(self.folder, "Hähnchenbrust", 200, 330, 62, 0, 7.2, now=NOON)
        said = koerper.describe(result)
        self.assertIn("Eingetragen: Hähnchenbrust, 200 g, 330 kcal (Mittagessen).", said)
        self.assertIn("330 von 2400 kcal, 62 von 160 g Eiweiß", said)
        self.assertNotIn("Noch keine Ziele", said)

    def test_rows_written_by_the_plugin_by_hand_are_kept(self):
        self.folder.mkdir(parents=True)
        (self.folder / "ernaehrung.csv").write_text(
            ",".join(koerper.FIELDS) + "\n2026-10-03,08:00,Frühstück,\"Haferflocken, mit Milch\",80,300,11,50,6,Schätzung",
            encoding="utf-8")  # ohne Zeilenende am Schluss, wie es von Hand passiert
        (self.folder / "Ernährung").mkdir()
        (self.folder / "Ernährung" / "2026-10-03.md").write_text("# Ernährung 2026-10-03\n\nalte Tabelle\n", encoding="utf-8")
        koerper.add(self.folder, "Banane", 120, 107, 1.3, 24, 0.4, now=NOON)
        self.assertEqual([r["lebensmittel"] for r in self.rows()], ["Haferflocken, mit Milch", "Banane"])
        day = (self.folder / "Ernährung" / "2026-10-03.md").read_text(encoding="utf-8")
        self.assertIn("Haferflocken, mit Milch", day)
        self.assertNotIn("alte Tabelle", day, "die Tabelle entsteht aus der CSV, nichts doppelt")

    def test_own_notes_around_the_jarvis_part_stay(self):
        koerper.add(self.folder, "Brot", 50, 120, 4, 22, 1, now=NOON)
        path = self.folder / "Ernährung" / "2026-10-03.md"
        path.write_text(path.read_text(encoding="utf-8") + "\nHeute war ich satt.\n", encoding="utf-8")
        koerper.add(self.folder, "Käse", 30, 110, 7.5, 0, 9, now=NOON)
        day = path.read_text(encoding="utf-8")
        self.assertIn("Heute war ich satt.", day)
        self.assertEqual(day.count("# Ernährung 2026-10-03"), 1)
        self.assertIn("| Käse |", day.replace("12:40 | Mittagessen | ", ""))

    def test_nonsense_is_refused(self):
        for bad in (("", 100, 100, 1, 1, 1), ("Pizza", -5, 100, 1, 1, 1), ("Pizza", "viel", 100, 1, 1, 1)):
            with self.assertRaises(ValueError, msg=bad):
                koerper.add(self.folder, *bad, now=NOON)
        self.assertFalse((self.folder / "ernaehrung.csv").exists())

    def test_tool_command(self):
        from jarvis import tool

        cfg = {"notizbuch": {"ordner": str(self.tmp)}}
        out = io.StringIO()
        with mock.patch.object(tool, "load_config", return_value=cfg), redirect_stdout(out):
            self.assertEqual(tool.main(["essen", "Pizza Margherita", "350", "860", "35", "105", "30", "Abendessen"]), 0)
            self.assertEqual(tool.main(["essen", "heute"]), 0)
            self.assertEqual(tool.main(["essen", "Pizza"]), 1)
        said = out.getvalue()
        self.assertIn("Eingetragen: Pizza Margherita, 350 g, 860 kcal (Abendessen).", said)
        self.assertIn("Abendessen: Pizza Margherita, 350 g, 860 kcal", said)
        self.assertIn("Summe: 860 kcal", said)
        self.assertTrue((self.tmp / "Körper" / "ernaehrung.csv").is_file(), "im Körper-Ordner des Notizbuchs")


if __name__ == "__main__":
    unittest.main()
