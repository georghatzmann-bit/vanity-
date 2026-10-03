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


class WorkshopTurnTest(unittest.TestCase):
    """Die Werkstatt kommt vor den Sofort-Befehlen dran: Sie darf sich nur echte Bauaufträge nehmen."""

    def test_using_is_not_building(self):
        from jarvis.workshop import is_workshop_request

        for said in ("Ich will ein Spiel spielen", "Ich möchte ein Game zocken", "Ich will ein neues Spiel kaufen",
                     "Ich möchte ein Programm installieren", "Behebe den Fehler mit dem Sound"):
            with self.subTest(said=said):
                self.assertFalse(is_workshop_request(said))
        for said in ("Ich brauche ein Programm, das meine Fotos umbenennt", "Behebe den Fehler in meinem Skript",
                     "Behebe den Fehler"):
            with self.subTest(said=said):
                self.assertTrue(is_workshop_request(said))
        self.assertEqual(intents.match("Werkstatt Status").name, "workshop_status")

    def test_everyday_commands_are_no_answer_to_its_question(self):
        from jarvis.workshop import is_continue_request, looks_like_answer

        for said in ("Mach das Licht an", "Schalte den Fernseher ein", "Mach die Heizung wärmer", "Danke",
                     "Gute Nacht", "Mach mit der Musik weiter", "Schreib mir eine Nachricht an Mama auf WhatsApp"):
            with self.subTest(said=said):
                self.assertFalse(looks_like_answer(said))
        for said in ("Ja, mach das", "Nein danke", "Blau", "Nimm den Token aus meiner Notiz"):
            with self.subTest(said=said):
                self.assertTrue(looks_like_answer(said))
        self.assertFalse(is_continue_request("Mach weiter mit dem Hörbuch"))
        for said in ("Mach weiter", "Mach in der Werkstatt weiter", "Arbeite weiter am Bot"):
            with self.subTest(said=said):
                self.assertTrue(is_continue_request(said))


class ProjectCommandTest(unittest.TestCase):
    """Sätze, die wie Werkstatt-Projektbefehle gebaut sind, aber kein Projekt meinen."""

    def test_unknown_names_fall_through_unless_a_project_is_meant(self):
        from tempfile import TemporaryDirectory

        from jarvis.workshop import Workshop
        from tests.helpers import RecordingUi

        with TemporaryDirectory() as base:
            shop = Workshop({"werkstatt": {"ordner": base}}, None, RecordingUi(), lambda text: None)
            for said in ("Mach mit der Musik weiter", "Mach mit dem Hörbuch weiter", "Öffne den Ordner von Steam",
                         "Öffne den Ordner vom Desktop"):
                with self.subTest(said=said):
                    self.assertIsNone(shop.project_command(said))
            self.assertIn("finde ich nicht", shop.project_command("Starte das Projekt Würfelspiel"))
            self.assertIn("finde ich nicht", shop.project_command("Mach beim Projekt Würfelspiel weiter"))


class MessageTurnTest(unittest.TestCase):
    """Nachrichten gehen ohne Rückfrage raus: Ein Gruß an Jarvis darf keine werden."""

    def test_greetings_and_asides_are_no_messages(self):
        for said in ("Sag gute Nacht, Jarvis", "Sag Guten Morgen, Jarvis", "Sag nichts, ich denke nach",
                     "Schreib in den Kanal allgemein, wer online ist"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertTrue(found is None or found.name != "message", found)
        found = intents.match("Schreib in den Kanal allgemein: Wer ist online?")
        self.assertEqual((found.name, found.data["text"]), ("message", "Wer ist online?"))
        self.assertEqual(intents.match("Sag Max, dass ich gleich komme").data["text"], "Ich komme gleich")
        self.assertNotEqual(intents.match("Öffne den Server Ordner").name, "discord")


class LightTest(unittest.TestCase):
    def test_zero_percent_means_off(self):
        for said in ("Stell das Licht auf 0 Prozent", "Dimm das Licht auf 0 Prozent"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertEqual((found.name, found.data["on"], found.data["pct"]), ("light", False, None))
        self.assertEqual(intents.match("Stell das Licht auf 10 Prozent").data["pct"], 10)

    def test_answer_keeps_the_preposition(self):
        from unittest import mock

        from jarvis.config import load_config
        from tests.test_assistant import FakeBrain, make

        cfg = load_config()
        cfg["homeassistant"] = {"url": "http://ha.local:8123", "token": "t"}
        assistant, _ui, _speaker, _ = make(FakeBrain(), cfg=cfg)
        with mock.patch("jarvis.homeassistant.HomeAssistant.light", return_value="ok") as light:
            answer = assistant.handle("Mach das Licht in der Küche auf 40 Prozent")
            self.assertEqual(answer, "Licht in der Küche auf 40 Prozent, Sir.")
            light.assert_called_with("küche", True, 40)
            # "Stehlampe": genau diese Lampe, nicht das erste Licht im Haus
            self.assertIn(assistant.handle("Mach die Stehlampe im Wohnzimmer aus"),
                          ("Stehlampe im Wohnzimmer ist aus, Sir.", "Erledigt, Sir. Gemütlich dunkel."))
            light.assert_called_with("stehlampe wohnzimmer", False, None)
            assistant.handle("Mach die Stehlampe an")
            light.assert_called_with("stehlampe", True, None)
            assistant.handle("Mach das Deckenlicht in der Küche an")
            light.assert_called_with("decke küche", True, None)
            assistant.handle("Stell das Licht auf 0 Prozent")
            light.assert_called_with("", False, None)


class PowerAbortTest(unittest.TestCase):
    """Jarvis sagt "Ein Abbrechen hält mich auf": das muss auch über den echten Weg klappen
    (Sprache und Tippen gehen über submit, und "Abbrechen"/"Stopp" wird dort sofort erledigt)."""

    def test_saying_stop_during_the_countdown_keeps_the_pc_on(self):
        from unittest import mock

        from jarvis import pc
        from tests.test_assistant import FakeBrain, make

        for said in ("Abbrechen", "Stopp", "Jarvis, stopp!"):
            with self.subTest(said=said):
                assistant, ui, _speaker, _ = make(FakeBrain())
                with mock.patch.object(pc, "power", return_value="ok"), \
                        mock.patch.object(pc, "power_pending", return_value=False):
                    assistant.handle("Fahr den PC herunter")
                with mock.patch.object(pc, "power_abort", return_value=True) as abort:
                    assistant.submit(said)
                abort.assert_called_once()
                self.assertIn("Der PC bleibt an", " ".join(str(e) for e in ui.events))

    def test_stop_without_a_countdown_does_not_touch_windows(self):
        from unittest import mock

        from jarvis import pc
        from tests.test_assistant import FakeBrain, make

        assistant, _ui, _speaker, _ = make(FakeBrain())
        with mock.patch.object(pc, "power_pending", return_value=False), \
                mock.patch.object(pc, "power_abort") as abort:
            assistant.submit("Stopp")
        abort.assert_not_called()


if __name__ == "__main__":
    unittest.main()
