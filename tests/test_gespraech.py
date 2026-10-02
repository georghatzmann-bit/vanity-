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

    def test_music_ends_the_conversation(self):
        # Nach "Mach Musik an" würde Jarvis sonst das Lied hören und den Text für einen Befehl halten
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        submitted, events, _ui = self.run_loop(Said("Mach Musik an", "Never gonna give you up"), frames)
        self.assertEqual(submitted, ["Mach Musik an"])
        self.assertNotIn("again", events)

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
        # Halber Treffer (0.3), Georg redet weiter: Erst sind nur zwei Sekunden geprüft
        # ("Jarvis, wie"), dann hört Jarvis bis zum Satzende zu und erkennt alles neu.
        frames = [LOUD] * 9 + [QUIET] * 6
        said = Said("Jarvis, wie", "Jarvis, wie spät ist es?")
        submitted, events = self.run_loop(said, frames, [0.3])
        self.assertEqual(submitted, ["wie spät ist es?"])
        self.assertNotIn("chime", events, "der Befehl war schon dabei, kein Ton nötig")

    def test_jarvis_alone_gives_the_tone_and_listens(self):
        frames = [LOUD] * 3 + [QUIET] * 3 + SENTENCE + [QUIET] * 2
        said = Said("Jarvis.", "Öffne Spotify")
        submitted, events = self.run_loop(said, frames, [0.3])
        self.assertEqual(submitted, ["Öffne Spotify"])
        self.assertIn("chime", events)
        self.assertEqual(said.calls, 2, "nur der Name: gleich der Ton, keine zweite Prüfung")

    def test_danke_jarvis_is_answered_without_the_tone(self):
        frames = [LOUD] * 3 + [QUIET] * 3 + [QUIET] * 4
        said = Said("Danke, Jarvis.")
        submitted, events = self.run_loop(said, frames, [0.3])
        self.assertEqual(submitted, ["Danke, Jarvis."])
        self.assertNotIn("chime", events)

    def test_other_talk_costs_no_long_recording(self):
        # Ein Fernseher redet weiter: Jarvis prüft nur zwei Sekunden und hört gleich wieder
        # auf "Hey Jarvis", statt den ganzen Satz aufzunehmen.
        frames = [LOUD] * 6 + [LOUD] * 3 + [QUIET] * 2 + SENTENCE + [QUIET] * 2
        said = Said("Wir gehen morgen", "Öffne Spotify")
        submitted, _events = self.run_loop(said, frames, [0.3] + [0.0] * 5 + [0.0] * 4 + [0.9])
        self.assertEqual(submitted, ["Öffne Spotify"])
        self.assertEqual(said.calls, 2)

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
        self.assertIsNone(after_name("Gewiss, das stimmt"))
        self.assertIsNone(after_name("Ganz gewiss nicht"))
        self.assertEqual(after_name("Garvis, wie spät ist es?"), "wie spät ist es?")

    def test_conversation_words(self):
        for text in ("Alles klar", "Okay.", "Nein danke", "Das war's", "Nichts mehr"):
            self.assertEqual(conversation_turn(text), "ende", text)
        for text in ("Danke!", "Tschüss", "Gute Nacht, Jarvis", "Stopp"):
            self.assertEqual(conversation_turn(text), "zuletzt", text)
        for text in ("Und morgen?", "Ja", "Was ist mit Dienstag?", "Öffne Discord"):
            self.assertEqual(conversation_turn(text), "weiter", text)
        # Danach spielt Musik oder läuft ein Anruf: nicht weiter zuhören, sonst werden Liedtexte zu Befehlen
        for text in ("Mach Musik an", "Spiel Thunderstruck", "Spiel Queen auf Spotify", "Nächstes Lied", "Lauter",
                     "Lautstärke auf 50", "Ruf Max auf Discord an", "Geh in den Sprachkanal Zocken", "Gaming-Modus an",
                     "Sperr den PC"):
            self.assertEqual(conversation_turn(text), "zuletzt", text)

    def test_tschuess_is_answered_without_claude(self):
        brain = FakeBrain()
        assistant, _ui, speaker, _mute = make(brain)
        answer = assistant.handle("Tschüss, Jarvis")
        self.assertIn("Sir", answer)
        self.assertEqual(brain.asked, [], "ohne Claude")


if __name__ == "__main__":
    unittest.main()


class GuardTest(unittest.TestCase):
    def cfg(self):
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000)
        return cfg

    def test_no_conversation_while_gaming(self):
        events = []
        assistant, _ui, _speaker, mute = make(FakeBrain())
        assistant.gaming = True
        submitted = []
        assistant.submit = submitted.append
        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        loop = VoiceLoop(self.cfg(), FakeMic(frames, events), FakeWake([0.9], events),
                         Said("Wie spät ist es?", "Und in Tokio?"), assistant, mute, Sounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(submitted, ["Wie spät ist es?"], "beim Zocken redet Georg meist mit anderen")

    def test_own_voice_is_not_a_command(self):
        events = []
        assistant, _ui, speaker, mute = make(FakeBrain())
        submitted = []
        assistant.submit = submitted.append

        class Mic(FakeMic):
            reads = 0

            def read(self):
                Mic.reads += 1
                # Während des Gesprächs meldet sich eine Erinnerung: Jarvis spricht selbst
                assistant._speaking = 14 <= Mic.reads <= 20
                return super().read()

        frames = [QUIET] + SENTENCE + [QUIET] + SENTENCE + [QUIET] * 3
        loop = VoiceLoop(self.cfg(), Mic(frames, events), FakeWake([0.9], events),
                         Said("Wie spät ist es?", "Ihr Timer ist abgelaufen, Sir."), assistant, mute, Sounds(events),
                         "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertIn("again", events, "das Gespräch lief")
        self.assertEqual(submitted, ["Wie spät ist es?"])


class OrbMovementTest(unittest.TestCase):
    """Schnelle Befehle melden der Kugel, was Jarvis tut (eigene Bewegung je Aktion)."""

    def test_quick_commands_tell_the_orb_what_happens(self):
        assistant, ui, _speaker, _mute = make(FakeBrain())
        shown = []
        ui.action = shown.append
        assistant.handle("Wie spät ist es?")
        assistant.handle("Danke")
        self.assertEqual(shown, ["time", "thanks"])

    def test_window_gets_the_movement(self):
        from jarvis.gui.app import GuiBridge

        bridge = GuiBridge()
        bridge.action("music")
        self.assertIn({"type": "action", "kind": "music"}, bridge.drain())
