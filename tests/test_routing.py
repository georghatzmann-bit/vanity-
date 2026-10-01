"""Sätze, die nicht beim falschen Sofort-Befehl landen dürfen (dann antwortet lieber Claude)."""

import unittest

import tests.helpers  # noqa: F401
from jarvis import calc, intents


class WrongTurnTest(unittest.TestCase):
    def test_go_only_to_real_websites(self):
        self.assertEqual(intents.match("Geh auf Reddit").name, "web")
        self.assertEqual(intents.match("Geh auf amazon.de").arg, "amazon.de")
        for said in ("Geh auf stumm", "Geh zu meinen Downloads", "Geh auf den Desktop", "Geh nach oben",
                     "Geh zu Bett", "Gehe auf die nächste Seite"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertTrue(found is None or found.name != "web", found)

    def test_playing_needs_a_title(self):
        for said in ("Spiel lauter", "Spiel leiser", "Spiel nochmal", "Spiel das Lied nochmal", "Spiel von vorne",
                     "Spiel den Song von vorhin nochmal", "Spiel mir ein Lied vor"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertTrue(found is None or found.name != "play", found)
        self.assertEqual(intents.match("Spiel mir Thunderstruck vor").arg, "Thunderstruck")
        self.assertEqual(intents.match("Spiel ein Lied von Queen").arg, "Queen")

    def test_no_google_or_maps_for_things_that_are_not_searches(self):
        for said in ("Schau nach ob es neue Updates gibt", "Bring mich nach Hause", "Bring mich zum Lachen",
                     "Öffne die Webseite die du gebaut hast"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertTrue(found is None or found.name not in ("search", "route", "web"), found)
        self.assertEqual(intents.match("Bring mich zum Bahnhof").name, "route")

    def test_huge_sums_go_to_claude_instead_of_failing(self):
        for said in ("Was ist eine Million hoch hundert", "Was ist 999999 hoch 100", "Was ist 999999,5 hoch 100"):
            with self.subTest(said=said):
                self.assertIsNone(intents.match(said))
        with self.assertRaises(calc.CalcError):
            calc.evaluate("1000000 hoch 100")


if __name__ == "__main__":
    unittest.main()
