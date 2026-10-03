import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from tests.helpers import make_fake_claude
from jarvis.brain import Answer, ClaudeBrain, LimitError
from jarvis.config import load_config
from jarvis.modellwahl import Chooser, classify, parse_level

posix_only = unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")


def arg(call, name):
    args = call["args"]
    return args[args.index(name) + 1] if name in args else None


class ClassifyTest(unittest.TestCase):
    """Welche Stufe eine Aufgabe bekommt, nur nach dem Satz."""

    def level(self, text):
        return classify(text)[0]

    def test_short_questions_are_fast(self):
        for text in ("Wie hoch ist der Eiffelturm?", "Wer hat die WM 2014 gewonnen?", "Erzähl mir einen Witz",
                     "Was heißt Schmetterling auf Englisch?", "Hey Jarvis, wie geht's dir?"):
            self.assertEqual(self.level(text), "schnell", text)

    def test_texts_research_and_explanations_are_normal(self):
        for text in ("Schreib mir eine Mail an meinen Vermieter wegen der Heizung",
                     "Recherchier mal, welche Grafikkarte unter 400 Euro gerade gut ist",
                     "Erklär mir, wie ein Kühlschrank funktioniert",
                     "Fass mir den Artikel auf meinem Bildschirm zusammen",
                     "Hast du Ideen für den Geburtstag von meiner Mutter?"):
            self.assertEqual(self.level(text), "normal", text)

    def test_tricky_things_are_thorough(self):
        for text in ("Warum stürzt mein PC beim Zocken immer ab?",
                     "Mein Python-Skript wirft einen Traceback, schau mal",
                     "Vergleich die zwei Handyverträge und sag mir, was sich lohnt",
                     "Discord startet nicht mehr, kannst du das reparieren?",
                     "Wie mache ich meine Steuererklärung als Student?",
                     "Mein Spiel ruckelt total"):
            self.assertEqual(self.level(text), "gruendlich", text)

    def test_georg_can_say_it(self):
        self.assertEqual(self.level("Denk gründlich nach: was ist der beste Weg nach Rom?"), "gruendlich")
        self.assertEqual(self.level("Denk mal richtig gründlich nach, wie ich mein Geld anlegen soll"), "maximal")
        self.assertEqual(self.level("Nimm dein stärkstes Modell und plan meine Woche"), "maximal")
        self.assertEqual(self.level("Kurz und knapp: warum stürzt mein PC ab?"), "schnell")
        self.assertEqual(self.level("Erklär mir ganz kurz, was ein Router ist"), "schnell")

    def test_long_tasks_get_more_thought(self):
        self.assertEqual(self.level("Okay " + "und dann noch das hier " * 10), "normal")
        self.assertEqual(self.level("Hier ist meine Idee " + "mit sehr vielen Einzelheiten " * 40), "gruendlich")

    def test_parse_level(self):
        self.assertEqual(parse_level("opus high"), ("opus", "high"))
        self.assertEqual(parse_level("Sonnet"), ("sonnet", ""))
        self.assertEqual(parse_level(""), ("", ""))


class ChooserTest(unittest.TestCase):
    def test_levels_map_to_model_and_effort(self):
        chooser = Chooser({})
        choice = chooser.choose("Warum ist mein Laptop so langsam?")
        self.assertEqual((choice.level, choice.model, choice.effort), ("gruendlich", "opus", "high"))
        self.assertEqual(choice.label(), "Opus · gründlich")
        self.assertEqual(chooser.choose("Wie spät ist es in Tokio?").model, "sonnet")

    def test_own_levels_from_config(self):
        chooser = Chooser({"stufe_schnell": "haiku", "stufe_gruendlich": "opus xhigh"})
        self.assertEqual(chooser.make("schnell").model, "haiku")
        self.assertEqual(chooser.make("schnell").effort, "low")
        self.assertEqual(chooser.make("gruendlich").effort, "xhigh")

    def test_fixed_mode_and_off(self):
        self.assertEqual(Chooser({"modellwahl": "gründlich"}).choose("Wie spät ist es?").level, "gruendlich")
        self.assertIsNone(Chooser({"modellwahl": "aus"}).choose("Warum stürzt alles ab?"))

    def test_follow_up_stays_on_the_level_of_the_task(self):
        chooser = Chooser({})
        chooser.choose("Warum stürzt mein PC beim Zocken ab?", now=100.0)
        self.assertEqual(chooser.choose("Und wie behebe ich das?", now=130.0).level, "gruendlich")
        self.assertEqual(chooser.choose("Wer hat die WM 2014 gewonnen?", now=160.0).level, "schnell")
        # Später ist es keine Nachfrage mehr.
        chooser.choose("Warum stürzt mein PC beim Zocken ab?", now=200.0)
        self.assertEqual(chooser.choose("Und was ist damit?", now=900.0).level, "schnell")

    def test_correction_thinks_harder(self):
        chooser = Chooser({})
        chooser.choose("Wie viele Einwohner hat Berlin?", now=10.0)
        choice = chooser.choose("Nein, das stimmt nicht", now=20.0)
        self.assertEqual(choice.level, "normal")
        self.assertIn("Korrektur", choice.reason)
        self.assertEqual(chooser.choose("Falsch, versuch es nochmal", now=30.0).level, "gruendlich")
        # Ein bloßes "Nein" ist eine Antwort, keine Korrektur.
        chooser.choose("Wie viele Einwohner hat Berlin?", now=40.0)
        self.assertEqual(chooser.choose("Nein", now=45.0).level, "schnell")

    def test_blocked_model_is_replaced_by_the_next_smaller(self):
        chooser = Chooser({})
        chooser.block("opus", 3600, "nicht verfügbar")
        choice = chooser.make("gruendlich")
        self.assertEqual((choice.model, choice.effort), ("sonnet", "high"))
        chooser.block("fable", 3600)
        self.assertEqual(chooser.make("maximal").model, "sonnet")
        self.assertIn("opus", chooser.state()["blocked"])

    def test_answer_label(self):
        self.assertEqual(Answer("x", "claude-opus-5-5", level="gruendlich").label, "Opus · gründlich")
        self.assertEqual(Answer("x", "claude-sonnet-5-5").label, "Sonnet")
        self.assertEqual(Answer("x", "").label, "")


@posix_only
class BrainChoiceTest(unittest.TestCase):
    """Das Gehirn nimmt pro Frage Modell und Nachdenken aus der Modellwahl."""

    live = False

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / "daten"
        self.cfg = load_config()["brain"]
        self.cfg["claude_path"] = str(make_fake_claude(self.home))
        self.cfg["live"] = self.live
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(self.cfg, self.home, self.state)

    def tearDown(self):
        self.brain.close()
        self.tmp.cleanup()

    def calls(self):
        lines = (self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]

    def controls(self):
        path = self.home / "controls.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def test_quick_question_is_fast_and_tricky_one_thorough(self):
        answer = self.brain.ask("Wie hoch ist der Eiffelturm?")
        self.assertEqual(answer.level, "schnell")
        self.assertEqual(answer.label, "Sonnet · schnell")
        answer = self.brain.ask("Warum stürzt mein PC beim Zocken immer ab?")
        self.assertEqual(answer.model, "claude-opus-test")
        self.assertEqual(answer.label, "Opus · gründlich")
        first, second = self.calls()
        self.assertEqual((first["model"], first["effort"]), ("sonnet", "low"))
        self.assertEqual((second["model"], second["effort"]), ("opus", "high"))

    def test_conversation_continues_across_models(self):
        self.brain.ask("Wie hoch ist der Eiffelturm?")
        self.brain.ask("Warum stürzt mein PC beim Zocken immer ab?")
        first, second = self.calls()
        if self.live:
            self.assertEqual(first["pid"], second["pid"], "im laufenden Prozess umgestellt")
            self.assertEqual(self.controls()[-1]["request"]["settings"], {"model": "opus", "effortLevel": "high"})
        else:
            self.assertEqual(arg(second, "--resume"), arg(first, "--session-id"))

    def test_unavailable_big_model_falls_back_and_is_remembered(self):
        notes = []
        self.brain.notice = notes.append
        with mock.patch.dict("os.environ", {"FAKE_NO_MODEL": "opus"}):
            answer = self.brain.ask("Warum stürzt mein PC beim Zocken immer ab?")
            self.assertEqual(answer.model, "claude-sonnet-test")
            self.assertEqual(self.calls()[-1]["effort"], "high", "gleich viel Nachdenken mit dem kleineren Modell")
            self.assertIn("Opus ist nicht verfügbar, versuche Sonnet", notes[0])
            self.assertTrue(self.brain.chooser.blocked("opus"))
            before = len(self.calls())
            self.brain.ask("Mein Spiel ruckelt total, woran liegt das?")
        self.assertEqual(len(self.calls()), before + 1, "kein neuer Versuch mit Opus")
        self.assertEqual(self.calls()[-1]["model"], "sonnet")

    def test_used_up_opus_falls_back_to_sonnet(self):
        with mock.patch.dict("os.environ", {"FAKE_LIMIT_MODEL": "opus"}):
            answer = self.brain.ask("Vergleich die zwei Handyverträge für mich")
        self.assertEqual(answer.model, "claude-sonnet-test")
        self.assertTrue(self.brain.chooser.blocked("opus"))

    def test_used_up_sonnet_is_not_retried(self):
        with mock.patch.dict("os.environ", {"FAKE_LIMIT_MODEL": "sonnet,opus,haiku"}), self.assertRaises(LimitError):
            self.brain.ask("Wie hoch ist der Eiffelturm?")
        self.assertEqual(len(self.calls()), 1)

    def test_model_choice_off_works_like_before(self):
        cfg = dict(self.cfg, modellwahl="aus", effort="medium")
        brain = ClaudeBrain(cfg, self.home, self.state)
        try:
            answer = brain.ask("Warum stürzt mein PC beim Zocken immer ab?")
        finally:
            brain.close()
        self.assertEqual((self.calls()[-1]["model"], self.calls()[-1]["effort"]), ("sonnet", "medium"))
        self.assertEqual(answer.label, "Sonnet")


@posix_only
class LiveBrainChoiceTest(BrainChoiceTest):
    live = True

    def test_old_claude_restarts_for_another_model(self):
        with mock.patch.dict("os.environ", {"FAKE_NO_CONTROL": "1"}):
            self.brain.ask("Wie hoch ist der Eiffelturm?")
            self.brain.ask("Warum stürzt mein PC beim Zocken immer ab?")
            first, second = self.calls()
            self.assertNotEqual(first["pid"], second["pid"])
            self.assertEqual(arg(second, "--model"), "opus")
            self.assertEqual(arg(second, "--effort"), "high")
            self.assertEqual(arg(second, "--resume"), arg(first, "--session-id"), "das Gespräch geht weiter")
            self.assertIn("apply_flag_settings", self.brain._unsupported)
            # Danach versucht Jarvis das Umstellen nicht mehr, er startet gleich neu.
            self.brain.ask("Wie spät ist es in Tokio?")
        self.assertEqual(len(self.controls()), 1)
        self.assertEqual(self.calls()[-1]["model"], "sonnet")

    def test_prewarm_uses_the_quick_level(self):
        self.brain.prewarm()
        for _ in range(60):
            if self.brain._live is not None:
                break
            import time

            time.sleep(0.05)
        self.assertEqual((self.brain._live.model, self.brain._live.effort), ("sonnet", "low"))


if __name__ == "__main__":
    unittest.main()
