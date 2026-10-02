"""Gespräch ohne "Hey Jarvis" und "Jarvis" allein als Weckwort."""

import unittest

from tests.helpers import frame
from tests.test_assistant import FakeBrain, FakeMic, FakeSounds, FakeWake, StopLoop, make
from jarvis.config import load_config
from jarvis.voice import VoiceLoop, after_name, conversation_turn


class Said:
    """Spracherkennung, die nacheinander die gegebenen Sätze "hört"."""

    def __init__(self, *texts):
        self.texts = list(texts)
        self.calls = 0

    def transcribe(self, _audio):
        self.calls += 1
        return self.texts.pop(0) if self.texts else ""


class Sounds(FakeSounds):
    def again(self):
        self.events.append("again")


QUIET, LOUD = frame(10), frame(5000)
# Ein gesprochener Satz nach dem Ton: kurz still, dann Sprechen, dann Stille
SENTENCE = [QUIET] + [LOUD] * 6 + [QUIET] * 4


class ConversationTest(unittest.TestCase):
    def run_loop(self, said, frames, scores=(0.9,), **listen):
        events = []
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000, **listen)
        assistant, ui, _speaker, mute = make(FakeBrain())
        submitted = []
        assistant.submit = submitted.append
        loop = VoiceLoop(cfg, FakeMic(frames, events), FakeWake(list(scores), events), said,
                         assistant, mute, Sounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        return submitted, events, ui

    def test_keeps_listening_after_an_answer(self):
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        submitted, events, ui = self.run_loop(Said("Wie spät ist es?", "Und in Tokio?"), frames)
        self.assertEqual(submitted, ["Wie spät ist es?", "Und in Tokio?"])
        self.assertIn("again", events, "im Gespräch ein leiserer Ton")
        self.assertIn(("config", {"gespraech": True}), ui.events)

    def test_alles_klar_ends_the_conversation_without_a_command(self):
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        submitted, _events, ui = self.run_loop(Said("Wie spät ist es?", "Alles klar", "Öffne Spotify"), frames)
        self.assertEqual(submitted, ["Wie spät ist es?"])
        self.assertEqual(ui.events[-1], ("config", {"gespraech": False}))

    def test_danke_is_answered_and_ends_the_conversation(self):
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        submitted, *_ = self.run_loop(Said("Wie spät ist es?", "Danke dir", "Öffne Spotify"), frames)
        self.assertEqual(submitted, ["Wie spät ist es?", "Danke dir"])

    def test_silence_ends_the_conversation(self):
        frames = [QUIET] + SENTENCE + [QUIET] * 12 + SENTENCE + [QUIET] * 3
        submitted, *_ = self.run_loop(Said("Wie spät ist es?", "Öffne Spotify"), frames, gespraech_sekunden=0.5)
        self.assertEqual(submitted, ["Wie spät ist es?"])

    def test_can_be_switched_off(self):
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        submitted, events, _ui = self.run_loop(Said("Wie spät ist es?", "Und in Tokio?"), frames, gespraech=False)
        self.assertEqual(submitted, ["Wie spät ist es?"])
        self.assertNotIn("again", events)


class NameTest(unittest.TestCase):
    def run_loop(self, said, frames, scores, **wakeword):
        events = []
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000, gespraech=False)
        cfg["wakeword"].update(wakeword)
        assistant, _ui, _speaker, mute = make(FakeBrain())
        submitted = []
        assistant.submit = submitted.append
        loop = VoiceLoop(cfg, FakeMic(frames, events), FakeWake(list(scores), events), said,
                         assistant, mute, Sounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        return submitted, events

    def test_jarvis_with_a_command(self):
        # Halber Treffer (0.3), dann redet Georg weiter: "Jarvis, wie spät ist es?"
        frames = [LOUD] * 9 + [QUIET] * 6
        said = Said("Jarvis, wie spät ist es?")
        submitted, events = self.run_loop(said, frames, [0.3])
        self.assertEqual(submitted, ["wie spät ist es?"])
        self.assertNotIn("chime", events, "der Befehl war schon dabei, kein Ton nötig")

    def test_jarvis_alone_gives_the_tone_and_listens(self):
        frames = [LOUD] * 6 + [QUIET] * 14 + SENTENCE + [QUIET] * 2
        said = Said("Jarvis.", "Öffne Spotify")
        submitted, events = self.run_loop(said, frames, [0.3])
        self.assertEqual(submitted, ["Öffne Spotify"])
        self.assertIn("chime", events)

    def test_other_talk_is_ignored_and_checked_less_often(self):
        frames = [LOUD] * 6 + [QUIET] * 14 + [LOUD] * 6 + [QUIET] * 14
        said = Said("Wir gehen morgen ins Kino", "Jarvis, öffne Spotify")
        submitted, _events = self.run_loop(said, frames, [0.3] + [0.0] * 19 + [0.3])
        self.assertEqual(submitted, [])
        self.assertEqual(said.calls, 1, "gleich danach prüft Jarvis nicht schon wieder")

    def test_sure_hey_jarvis_needs_no_check(self):
        frames = [QUIET] * 2 + SENTENCE + [QUIET] * 2
        said = Said("Öffne Spotify")
        submitted, _events = self.run_loop(said, frames, [0.3, 0.9])
        self.assertEqual(submitted, ["Öffne Spotify"])
        self.assertEqual(said.calls, 1)

    def test_can_be_switched_off(self):
        frames = [LOUD] * 9 + [QUIET] * 6
        said = Said("Jarvis, wie spät ist es?")
        submitted, _events = self.run_loop(said, frames, [0.3], name_allein=False)
        self.assertEqual(submitted, [])
        self.assertEqual(said.calls, 0)


class WordsTest(unittest.TestCase):
    def test_name_at_the_start(self):
        self.assertEqual(after_name("Jarvis, wie spät ist es?"), "wie spät ist es?")
        self.assertEqual(after_name("Hallo Jarvis, mach Musik an"), "mach Musik an")
        self.assertEqual(after_name("Okay Jarvis."), "")
        self.assertEqual(after_name("Dschawis, wie wird das Wetter?"), "wie wird das Wetter?")
        self.assertIsNone(after_name("Ich habe Jarvis gesagt"))
        self.assertIsNone(after_name("Wie spät ist es?"))
        self.assertIsNone(after_name("Davis Cup"))

    def test_conversation_words(self):
        for text in ("Alles klar", "Okay.", "Nein danke", "Das war's", "Nichts mehr"):
            self.assertEqual(conversation_turn(text), "ende", text)
        for text in ("Danke!", "Tschüss", "Gute Nacht, Jarvis", "Stopp"):
            self.assertEqual(conversation_turn(text), "zuletzt", text)
        for text in ("Und morgen?", "Ja", "Was ist mit Dienstag?"):
            self.assertEqual(conversation_turn(text), "weiter", text)

    def test_tschuess_is_answered_without_claude(self):
        brain = FakeBrain()
        assistant, _ui, speaker, _mute = make(brain)
        answer = assistant.handle("Tschüss, Jarvis")
        self.assertIn("Sir", answer)
        self.assertEqual(brain.asked, [], "ohne Claude")


if __name__ == "__main__":
    unittest.main()
