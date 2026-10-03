"""Peitsche und Lob wie im Video "Response Accelerator": Jarvis antwortet und denkt eine Weile flotter."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from tests.test_assistant import FakeBrain, make
from jarvis.assistant import PRAISE, WHIP_BUSY, WHIP_IDLE
from jarvis.modellwahl import Chooser
from jarvis.zentrale import Zentrale


class ChooserTest(unittest.TestCase):
    def test_hurry_makes_the_next_tasks_one_level_faster(self):
        chooser = Chooser({})
        task = "Schreib mir eine freundliche Mail an meinen Vermieter wegen der Heizung"
        normal = chooser.choose(task, now=1000.0).level
        chooser.hurry(seconds=600, now=1000.0)
        hurried = chooser.choose(task, now=1001.0)
        self.assertEqual(hurried.level, {"gruendlich": "normal", "normal": "schnell"}.get(normal, normal))
        if normal != "schnell":
            self.assertEqual(hurried.reason, "angetrieben")
        self.assertEqual(chooser.choose("Denk richtig gründlich nach: Was ist besser, A oder B?", now=1002.0).reason,
                         "ausdrücklich gewünscht", "ausdrücklich gründlich bleibt gründlich")
        chooser.hurry(seconds=600)
        self.assertTrue(chooser.state()["eilig"])
        chooser.relax()
        self.assertFalse(chooser.hurried())
        self.assertEqual(chooser.choose(task, now=1003.0).level, normal)

    def test_hurry_runs_out(self):
        chooser = Chooser({})
        chooser.hurry(seconds=60, now=0.0)
        self.assertTrue(chooser.hurried(now=59.0))
        self.assertFalse(chooser.hurried(now=61.0))


class FeedbackTest(unittest.TestCase):
    def setUp(self):
        self.brain = FakeBrain()
        self.brain.chooser = Chooser({})
        self.assistant, self.ui, self.speaker, _ = make(self.brain)

    def test_whip_by_voice_and_praise(self):
        answer = self.assistant.handle("Schneller!")
        self.assertIn(answer, WHIP_IDLE)
        self.assertTrue(self.brain.chooser.hurried())
        self.assertEqual(self.brain.asked, [], "ohne Claude")
        self.assertIn(answer, self.speaker.said)
        answer = self.assistant.handle("Gut gemacht, Jarvis")
        self.assertIn(answer, PRAISE)
        self.assertFalse(self.brain.chooser.hurried())

    def test_whip_while_thinking_and_in_the_activity(self):
        with TemporaryDirectory() as tmp:
            self.assistant.zentrale = Zentrale({}, None, mock.Mock(), Path(tmp), self.assistant)
            self.assistant._busy = 1  # Claude denkt gerade nach
            self.assertIn(self.assistant.feedback("peitsche"), WHIP_BUSY)
            self.assistant._busy = 0
            self.assistant.feedback("lob")
            texts = [e["text"] for e in self.assistant.zentrale.events_today()]
        self.assertEqual(texts, ["Angetrieben, beim Nachdenken", "Gelobt"])

    def test_window_whip_answers_at_once(self):
        from jarvis.gui.app import Api, GuiBridge

        bridge = GuiBridge()
        api = Api(bridge, self.assistant, None)
        line = api.feedback("peitsche")
        self.assertIn(line, WHIP_IDLE)
        self.assertIn(line, self.speaker.said)
        self.assertIn(line, [e.get("text") for e in bridge.drain()])
        self.assertIn(api.feedback("lob"), PRAISE)
        self.assertIn(api.feedback("<script>"), WHIP_IDLE, "alles andere ist die Peitsche")

    def test_other_sentences_stay_what_they_were(self):
        self.assistant.handle("Mach die Gegner schneller")
        self.assertFalse(self.brain.chooser.hurried())


if __name__ == "__main__":
    unittest.main()
