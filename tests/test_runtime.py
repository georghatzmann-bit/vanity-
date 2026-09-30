"""Fehler aus der zweiten Prüfung: Stopp, Rückfragen, Quellenlisten, hängende Zustände,
fehlendes Mikrofon, Fehler in der Spracherkennung."""

import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from tests.helpers import frame
from tests.test_assistant import FakeBrain, FakeMic, FakeSounds, FakeStt, FakeWake, StopLoop, make
from jarvis.brain import Answer, Cancelled, ClaudeBrain, OverloadedError, Run
from jarvis.config import load_config
from jarvis.gui.app import Api, GuiBridge
from jarvis.tts import Speaker, TextToSpeech
from jarvis.voice import VoiceLoop


class AssistantFixesTest(unittest.TestCase):
    def test_sources_list_is_not_read_aloud(self):
        brain = FakeBrain(chunks=[
            "In Wien sind es 19 Grad. ",
            "Morgen wird es sonnig.\n\nSources:\n",
            "- [Wetter Wien - ORF.at](https://wetter.orf.at/wien)\n",
            "- [Wien Wetter | wetter.com](https://www.wetter.com/wien)\n",
        ])
        assistant, ui, speaker, _ = make(brain)
        answer = assistant.handle("Wie wird das Wetter?")
        self.assertEqual(speaker.said, ["In Wien sind es 19 Grad.", "Morgen wird es sonnig."])
        self.assertNotIn("Sources", answer)
        self.assertNotIn("ORF", " ".join(m[2] for m in ui.of("message")))

    def test_typed_stop_does_not_wait_for_the_answer(self):
        brain = FakeBrain(delay=3)
        assistant, ui, speaker, _ = make(brain)
        assistant.submit("Erzähl mir eine lange Geschichte")
        time.sleep(0.2)
        started = time.monotonic()
        assistant.submit("Stopp")
        self.assertTrue(brain.cancelled)
        self.assertGreaterEqual(speaker.stopped, 1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertIn(("message", "user", "Stopp", None, "", True), ui.events)

    def test_mute_reply_names_only_a_working_hotkey(self):
        assistant, *_ = make()
        self.assertIn("Mikrofon-Knopf", assistant.handle("Mikrofon aus"))
        assistant, *_ = make()
        assistant.hotkey = "ctrl+alt+m"  # von Windows angenommen
        self.assertIn("Steuerung Alt M", assistant.handle("Mikrofon aus"))

    def test_question_opens_a_follow_up(self):
        assistant, *_ = make(FakeBrain(chunks=["Soll ich die Datei löschen, Sir?"]))
        assistant.handle("Lösch die Datei alt.txt")
        self.assertTrue(assistant.take_follow_up())
        self.assertFalse(assistant.take_follow_up())
        assistant, *_ = make(FakeBrain(chunks=["Erledigt, Sir."]))
        assistant.handle("Öffne Notepad")
        self.assertFalse(assistant.take_follow_up())

    def test_transcribing_shows_thinking(self):
        assistant, ui, *_ = make()
        assistant.set_transcribing(True)
        assistant.set_transcribing(False)
        self.assertEqual(ui.states(), ["thinking", "idle"])

    def test_new_conversation_button_stops_the_running_answer(self):
        calls = []

        class A:
            def stop(self):
                calls.append("stop")

            def new_conversation(self):
                calls.append("neu")

        Api(GuiBridge(), A(), None).new_conversation()
        self.assertEqual(calls, ["stop", "neu"])


class HookMic(FakeMic):
    """FakeMic, das beim n-ten Lesen etwas ausführt."""

    def __init__(self, frames, events, hooks):
        super().__init__(frames, events)
        self.hooks = hooks
        self.reads = 0

    def read(self):
        self.reads += 1
        hook = self.hooks.get(self.reads)
        if hook:
            hook()
        return super().read()


class VoiceLoopFixesTest(unittest.TestCase):
    def cfg(self):
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000)
        return cfg

    def test_answer_to_a_question_needs_no_wake_word(self):
        events = []
        assistant, _ui, _speaker, mute = make()
        submitted = []
        assistant.submit = submitted.append
        assistant._busy = 1  # Jarvis spricht noch

        def finished():
            assistant._busy = 0
            assistant._follow_up = True

        frames = [frame(10)] * 2 + [frame(5000)] * 9 + [frame(10)] * 4
        loop = VoiceLoop(self.cfg(), HookMic(frames, events, {2: finished}), FakeWake([], events), FakeStt("Ja"),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(submitted, ["Ja"])
        self.assertIn("chime", events)

    def test_follow_up_can_be_switched_off(self):
        events = []
        cfg = self.cfg()
        cfg["listen"]["follow_up"] = False
        assistant, _ui, _speaker, mute = make()
        submitted = []
        assistant.submit = submitted.append
        assistant._busy = 1

        def finished():
            assistant._busy = 0
            assistant._follow_up = True

        frames = [frame(10)] * 2 + [frame(5000)] * 9 + [frame(10)] * 4
        loop = VoiceLoop(cfg, HookMic(frames, events, {2: finished}), FakeWake([], events), FakeStt("Ja"),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(submitted, [])

    def test_speech_recognition_error_is_survived(self):
        events = []
        assistant, ui, _speaker, mute = make()

        class BrokenStt:
            def transcribe(self, audio):
                raise RuntimeError("Library cublas64_12.dll is not found")

        frames = [frame(10)] * 2 + [frame(5000)] * 9 + [frame(10)] * 4 + [frame(10)] * 3
        loop = VoiceLoop(self.cfg(), FakeMic(frames, events), FakeWake([0.9], events), BrokenStt(),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        with self.assertLogs("jarvis", "ERROR"), self.assertRaises(StopLoop):
            loop.run()
        self.assertTrue(any("Spracherkennung" in m[2] for m in ui.of("message")))
        self.assertEqual(ui.states()[-1], "idle")
        self.assertEqual(events[-1], "stop")

    def test_repeated_errors_switch_voice_off_but_close_the_mic(self):
        events = []
        assistant, ui, _speaker, mute = make()

        class BrokenWake(FakeWake):
            def score(self, _frame):
                raise ValueError("Modell kaputt")

        loop = VoiceLoop(self.cfg(), FakeMic([frame(10)] * 20, events), BrokenWake([], events), None,
                         assistant, mute, FakeSounds(events), "X", hints=None)
        loop._pause = lambda seconds: None
        with self.assertLogs("jarvis", "ERROR"):
            loop.run()
        self.assertIn("Sprachsteuerung ist aus", ui.of("toast")[-1][1])
        self.assertEqual(events[-1], "stop")


class FakePlayer:
    def __init__(self):
        self.played = []
        self.should_stop = None

    def play(self, samples, rate, on_level):
        time.sleep(len(samples) / rate)
        self.played.append(int(samples[0]))

    def stop(self):
        pass


class SpeakerFixesTest(unittest.TestCase):
    def test_failed_last_sentence_does_not_leave_speaking_on(self):
        def synth(text):
            if text == "2":
                time.sleep(0.3)  # kommt erst, wenn Satz 1 schon fertig ist
                raise RuntimeError("kein Internet")
            return np.full(800, int(text), dtype=np.int16), 8000

        speaking = []
        speaker = Speaker(synth, FakePlayer(), on_speaking=speaking.append)
        with self.assertLogs("jarvis.tts", "ERROR"):
            speaker.say("1")
            speaker.say("2")
            self.assertTrue(speaker.wait(timeout=3))
            time.sleep(0.05)
        self.assertEqual(speaking, [True, False])

    def test_stop_between_check_and_play_is_not_lost(self):
        player = FakePlayer()
        speaker = Speaker(lambda t: (np.full(800, int(t), dtype=np.int16), 8000), player)
        self.assertIsNotNone(player.should_stop)
        speaker._playing_generation = speaker._generation
        self.assertFalse(player.should_stop())
        speaker.stop()
        self.assertTrue(player.should_stop())

    def test_human_voice_right_after_boot(self):
        tts = TextToSpeech({"engine": "edge"})
        with mock.patch("jarvis.tts.time.monotonic", return_value=35.0), \
                mock.patch("jarvis.tts.synthesize_edge", return_value=(np.zeros(10, dtype=np.int16), 24000)) as edge, \
                mock.patch("jarvis.tts.synthesize_windows", side_effect=AssertionError("Windows-Stimme")):
            tts.synthesize("Jarvis ist online, Sir.")
        edge.assert_called_once()


class BrainFixesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        (home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        exe = home / "claude"
        exe.write_text("")
        self.brain = ClaudeBrain({"claude_path": str(exe), "models": ["sonnet"]}, home)

    def test_stop_during_overload_pause(self):
        calls = []

        def overloaded(text, on_text=None):
            calls.append(text)
            raise OverloadedError("529 Overloaded")

        self.brain._ask_once = overloaded
        self.brain.notice = lambda text: None
        threading.Timer(0.3, self.brain.cancel).start()
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            self.brain.ask("hi")
        self.assertEqual(len(calls), 1)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_new_conversation_during_an_answer_stays_new(self):
        def run(cmd, text, on_text):
            self.brain.new_conversation()  # Knopf gedrückt, während Claude noch schreibt
            return Run({"type": "result", "subtype": "success", "result": "Hallo", "session_id": "alt"}, "", True, "sonnet")

        self.brain._run = run
        answer = self.brain.ask("hi")
        self.assertIsInstance(answer, Answer)
        self.assertIsNone(self.brain._session)


if __name__ == "__main__":
    unittest.main()
