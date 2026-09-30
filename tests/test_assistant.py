import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from tests.helpers import RecordingUi, frame
from jarvis.assistant import FILLERS, Assistant
from jarvis.brain import Answer, Cancelled, LimitError, RefusalError
from jarvis.config import load_config
from jarvis.gui.app import Api, GuiBridge
from jarvis.mute import MuteSwitch
from jarvis.reminders import ReminderStore
from jarvis.tts import Speaker
from jarvis.voice import VoiceLoop


class FakeBrain:
    def __init__(self, chunks=None, error=None, delay=0.0, model="claude-sonnet-test"):
        self.chunks = chunks or ["Guten Tag, Sir", ". Heute ist ", "Mittwoch."]
        self.error = error
        self.delay = delay
        self.model = model
        self.asked = []
        self.cancelled = False
        self.reset = 0
        self.notice = None

    def ask(self, text, on_text=None):
        self.asked.append(text)
        end = time.monotonic() + self.delay
        while time.monotonic() < end:
            if self.cancelled:
                raise Cancelled("abgebrochen")
            time.sleep(0.01)
        if self.error:
            raise self.error
        for chunk in self.chunks:
            if on_text:
                on_text(chunk)
        return Answer("".join(self.chunks), self.model)

    def cancel(self):
        self.cancelled = True

    def new_conversation(self):
        self.reset += 1


class FakeSpeaker:
    def __init__(self):
        self.said = []
        self.stopped = 0
        self.busy = False

    def say(self, text):
        self.said.append(text)

    def stop(self):
        self.stopped += 1

    def wait(self, timeout=None):
        return True


def make(brain=None, cfg=None, **kwargs):
    cfg = cfg or load_config()
    ui = RecordingUi()
    speaker = FakeSpeaker()
    mute = MuteSwitch()
    assistant = Assistant(cfg, brain if brain is not None else FakeBrain(), speaker, ui, mute, **kwargs)
    return assistant, ui, speaker, mute


class AssistantTest(unittest.TestCase):
    def test_answer_is_spoken_sentence_by_sentence(self):
        assistant, ui, speaker, _ = make()
        answer = assistant.handle("Hallo Jarvis")
        self.assertEqual(answer, "Guten Tag, Sir. Heute ist Mittwoch.")
        self.assertEqual(speaker.said, ["Guten Tag, Sir.", "Heute ist Mittwoch."])
        messages = ui.of("message")
        self.assertEqual(messages[0][1:3], ("user", "Hallo Jarvis"))
        partial = [m for m in messages if m[1] == "jarvis" and not m[5]]
        final = [m for m in messages if m[1] == "jarvis" and m[5]]
        self.assertEqual(partial[0][2], "Guten Tag, Sir.")
        self.assertEqual(final[-1][2:5], ("Guten Tag, Sir. Heute ist Mittwoch.", partial[0][3], "claude-sonnet-test"))
        self.assertEqual(ui.states(), ["thinking", "idle"])

    def test_local_commands_do_not_ask_claude(self):
        brain = FakeBrain()
        assistant, ui, speaker, mute = make(brain)
        self.assertIn("Uhr", assistant.handle("Wie spät ist es?"))
        self.assertIn("Heute ist", assistant.handle("Welcher Tag ist heute?"))
        self.assertIn("vorne", assistant.handle("Neue Unterhaltung"))
        self.assertEqual(brain.reset, 1)
        assistant.handle("Mikrofon aus")
        self.assertTrue(mute.muted)
        self.assertEqual(brain.asked, [])

    def test_local_commands_can_be_switched_off(self):
        cfg = load_config()
        cfg["local"]["enabled"] = False
        brain = FakeBrain()
        assistant, *_ = make(brain, cfg)
        assistant.handle("Wie spät ist es?")
        self.assertEqual(brain.asked, ["Wie spät ist es?"])

    def test_errors_are_spoken_in_german(self):
        assistant, ui, speaker, _ = make(FakeBrain(error=LimitError("usage limit reached")))
        answer = assistant.handle("Mach was")
        self.assertIn("Kontingent", answer)
        self.assertEqual(speaker.said, [answer])
        self.assertEqual(ui.of("toast")[0][2], "error")

    def test_refusal_message_points_to_the_test(self):
        assistant, *_ = make(FakeBrain(error=RefusalError("safeguards")))
        self.assertIn("Claude-Test", assistant.handle("hi"))

    def test_filler_when_claude_is_slow(self):
        cfg = load_config()
        cfg["answer"]["ack_after_seconds"] = 0.05
        assistant, _ui, speaker, _ = make(FakeBrain(delay=0.3), cfg)
        assistant.handle("Wie wird das Wetter?")
        self.assertIn(speaker.said[0], FILLERS)
        self.assertEqual(speaker.said[1:], ["Guten Tag, Sir.", "Heute ist Mittwoch."])

    def test_no_filler_when_claude_is_fast(self):
        cfg = load_config()
        cfg["answer"]["ack_after_seconds"] = 0.5
        assistant, _ui, speaker, _ = make(FakeBrain(), cfg)
        assistant.handle("Hallo")
        time.sleep(0.6)
        self.assertEqual(speaker.said, ["Guten Tag, Sir.", "Heute ist Mittwoch."])

    def test_markdown_from_claude_is_cleaned(self):
        assistant, ui, speaker, _ = make(FakeBrain(chunks=["**Erledigt**, Sir. ", "Siehe [Link](https://x.y)."]))
        assistant.handle("Mach was")
        self.assertEqual(speaker.said, ["Erledigt, Sir.", "Siehe Link."])

    def test_submit_runs_in_background_and_stop_cancels(self):
        brain = FakeBrain(delay=5)
        assistant, ui, speaker, _ = make(brain)
        assistant.submit("Such etwas Langes")
        time.sleep(0.2)
        self.assertTrue(assistant.busy)
        assistant.stop()
        deadline = time.monotonic() + 3
        while assistant.busy and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(assistant.busy)
        self.assertTrue(brain.cancelled)
        self.assertGreaterEqual(speaker.stopped, 1)

    def test_due_reminders_are_announced_once(self):
        import datetime as dt

        with TemporaryDirectory() as tmp:
            store = ReminderStore(Path(tmp) / "e.json")
            store.add(dt.datetime.now() - dt.timedelta(seconds=1), "Tee ist fertig")
            store.add(dt.datetime.now() + dt.timedelta(hours=1), "Später")
            assistant, ui, speaker, _ = make(reminders=store)
            assistant.check_reminders()
            assistant.check_reminders()
            self.assertEqual(speaker.said, ["Erinnerung, Sir: Tee ist fertig"])
            self.assertEqual([r["text"] for r in store.all()], ["Später"])

    def test_states_follow_recording_speaking_and_mute(self):
        assistant, ui, _speaker, mute = make()
        assistant.set_recording(True)
        assistant.set_recording(False)
        assistant.set_speaking(True)
        assistant.set_speaking(False)
        mute.mute()
        assistant.update_state()
        self.assertEqual(ui.states(), ["listening", "idle", "speaking", "idle", "muted"])

    def test_without_brain(self):
        assistant = Assistant(load_config(), None, FakeSpeaker(), RecordingUi())
        self.assertIn("Gehirn", assistant.handle("Öffne YouTube"))


class FakePlayer:
    def __init__(self):
        self.played = []
        self.stop_event = threading.Event()

    def play(self, samples, rate, on_level):
        self.stop_event.clear()
        on_level(0.5)
        self.stop_event.wait(len(samples) / rate)
        if not self.stop_event.is_set():
            self.played.append(int(samples[0]))

    def stop(self):
        self.stop_event.set()


class SpeakerTest(unittest.TestCase):
    def synth(self, text):
        return np.full(800, int(text), dtype=np.int16), 8000  # 0,1 s pro Satz

    def test_plays_in_order_and_reports_speaking(self):
        player = FakePlayer()
        speaking = []
        speaker = Speaker(self.synth, player, on_speaking=speaking.append)
        for n in ("1", "2", "3"):
            speaker.say(n)
        self.assertTrue(speaker.wait(timeout=3))
        self.assertEqual(player.played, [1, 2, 3])
        self.assertEqual(speaking, [True, False])

    def test_stop_drops_everything_queued(self):
        player = FakePlayer()
        speaker = Speaker(lambda t: (np.full(8000, int(t), dtype=np.int16), 8000), player)
        for n in ("1", "2", "3"):
            speaker.say(n)
        time.sleep(0.2)
        speaker.stop()
        self.assertTrue(speaker.wait(timeout=1))
        time.sleep(0.3)
        self.assertEqual(player.played, [])
        speaker.say("4")
        speaker.wait(timeout=3)
        self.assertEqual(player.played, [4])

    def test_synthesis_error_does_not_block(self):
        def synth(text):
            if text == "5":
                raise RuntimeError("kein Internet")
            return self.synth(text)

        player = FakePlayer()
        speaker = Speaker(synth, player)
        with self.assertLogs("jarvis.tts", "ERROR"):
            speaker.say("5")
            speaker.say("6")
            self.assertTrue(speaker.wait(timeout=3))
        self.assertEqual(player.played, [6])


class GuiBridgeTest(unittest.TestCase):
    def test_events_and_latest_level_only(self):
        bridge = GuiBridge()
        bridge.state("listening")
        bridge.level(0.2)
        bridge.level(0.7)
        bridge.message("jarvis", "Hallo", id="a1", model="m", final=False)
        events = bridge.drain()
        self.assertEqual(events[0], {"type": "state", "value": "listening"})
        self.assertEqual(events[1], {"type": "message", "role": "jarvis", "text": "Hallo", "final": False, "id": "a1", "model": "m"})
        self.assertEqual(events[-1], {"type": "level", "value": 0.7})
        self.assertEqual(bridge.drain(), [])

    def test_api(self):
        bridge = GuiBridge()
        submitted = []

        class A:
            def submit(self, text):
                submitted.append(text)

            def stop(self):
                submitted.append("STOP")

            def new_conversation(self):
                submitted.append("NEU")

        mute = MuteSwitch()
        api = Api(bridge, A(), mute)
        bridge.config(hotkey="STRG+ALT+M", mic="Headset")
        self.assertEqual(api.hello()["mic"], "Headset")
        self.assertTrue(api.send_text("  Öffne YouTube "))
        self.assertFalse(api.send_text("   "))
        self.assertTrue(api.toggle_mute())
        self.assertFalse(api.toggle_mute())
        api.stop()
        api.new_conversation()
        self.assertEqual(submitted, ["Öffne YouTube", "STOP", "NEU"])
        self.assertFalse([name for name in vars(api) if not name.startswith("_")], "nichts Internes an die Seite geben")

    def test_listen_now(self):
        bridge = GuiBridge()
        mute = MuteSwitch()
        clicks = []
        api = Api(bridge, None, mute, None, lambda: clicks.append(1) or True)
        self.assertEqual(api.listen_now(), {"ok": True, "reason": ""})
        self.assertEqual(clicks, [1])
        mute.mute()
        self.assertEqual(api.listen_now()["reason"], "muted")
        mute.unmute()
        self.assertEqual(Api(bridge, None, mute).listen_now()["reason"], "novoice")
        self.assertEqual(Api(bridge, None, mute, None, lambda: False).listen_now()["reason"], "novoice")


class StopLoop(Exception):
    pass


class FakeMic:
    def __init__(self, frames, events):
        self.frames = list(frames)
        self.events = events
        self.dead_silent = False
        self.noise_floor = 100.0

    def start(self):
        self.events.append("start")

    def stop(self):
        self.events.append("stop")

    def read(self):
        if not self.frames:
            raise StopLoop
        return self.frames.pop(0)

    def drain(self):
        self.events.append("drain")


class FakeWake:
    threshold = 0.5

    def __init__(self, scores, events):
        self.scores = list(scores)
        self.events = events

    def score(self, _frame):
        return self.scores.pop(0) if self.scores else 0.0

    def reset(self):
        self.events.append("reset")


class FakeSounds:
    def __init__(self, events, mute=None):
        self.events = events
        self.mute = mute

    def listening(self):
        self.events.append("chime")

    def muted(self):
        self.events.append("muted")
        threading.Timer(0.05, self.mute.unmute).start()

    def unmuted(self):
        self.events.append("unmuted")


class FakeStt:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio):
        return self.text


class VoiceLoopTest(unittest.TestCase):
    def test_wake_word_records_and_submits(self):
        events = []
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000)
        frames = [frame(10)] * 3 + [frame(5000)] * 5 + [frame(10)] * 4
        assistant, ui, _speaker, mute = make(FakeBrain())
        submitted = []
        assistant.submit = submitted.append
        loop = VoiceLoop(cfg, FakeMic(frames, events), FakeWake([0.1, 0.9], events), FakeStt("Öffne YouTube"),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(submitted, ["Öffne YouTube"])
        self.assertIn("chime", events)
        self.assertEqual(ui.states()[:2], ["listening", "idle"])

    def test_mic_is_closed_while_muted(self):
        events = []
        cfg = load_config()
        assistant, _ui, _speaker, mute = make()
        mute.mute()
        loop = VoiceLoop(cfg, FakeMic([frame(0)] * 3, events), FakeWake([], events), None,
                         assistant, mute, FakeSounds(events, mute), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(events[:6], ["start", "stop", "muted", "unmuted", "start", "reset"])

    def test_hey_jarvis_interrupts_a_running_answer(self):
        events = []
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000)
        assistant, _ui, _speaker, mute = make(FakeBrain())
        assistant._busy = 1  # so tun, als würde Jarvis gerade antworten
        stopped = []
        assistant.stop = lambda: stopped.append(True)
        assistant.submit = lambda text: None
        # 0.6 reicht während einer Antwort nicht (Schwelle 0.75), 0.9 schon.
        frames = [frame(10)] * 2 + [frame(5000)] * 4 + [frame(10)] * 4
        loop = VoiceLoop(cfg, FakeMic(frames, events), FakeWake([0.6, 0.9], events), FakeStt("Stopp"),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(stopped, [True])

    def test_click_on_the_reactor_listens_without_hey_jarvis(self):
        events = []
        cfg = load_config()
        cfg["listen"].update(silence_seconds=0.24, energy_threshold=1000)
        frames = [frame(10)] * 2 + [frame(5000)] * 5 + [frame(10)] * 4
        assistant, _ui, _speaker, mute = make(FakeBrain())
        submitted = []
        assistant.submit = submitted.append
        # Das Wake-Word kommt nie über die Schwelle, trotzdem hört Jarvis nach dem Klick zu.
        loop = VoiceLoop(cfg, FakeMic(frames, events), FakeWake([], events), FakeStt("Wie spät ist es?"),
                         assistant, mute, FakeSounds(events), "X", hints=None)
        self.assertTrue(loop.listen_now())
        with self.assertRaises(StopLoop):
            loop.run()
        self.assertEqual(submitted, ["Wie spät ist es?"])

    def test_click_is_refused_while_muted(self):
        events = []
        assistant, _ui, _speaker, mute = make()
        loop = VoiceLoop(load_config(), FakeMic([], events), FakeWake([], events), None,
                         assistant, mute, FakeSounds(events), "X", hints=None)
        mute.mute()
        self.assertFalse(loop.listen_now())

    def test_microphone_hiccup_is_survived(self):
        events = []
        cfg = load_config()
        assistant, ui, _speaker, mute = make()

        class PortAudioError(Exception):
            pass

        class FlakyMic(FakeMic):
            calls = 0

            def read(self):
                FlakyMic.calls += 1
                if FlakyMic.calls == 2:
                    raise PortAudioError("Unanticipated host error")
                return super().read()

        loop = VoiceLoop(cfg, FlakyMic([frame(10)] * 3, events), FakeWake([], events), None,
                         assistant, mute, FakeSounds(events), "X", hints=None)
        from unittest import mock

        with mock.patch("jarvis.voice.time.sleep"), self.assertRaises(StopLoop):
            loop.run()
        self.assertIn("Mikrofon-Problem", ui.of("toast")[0][1])
        self.assertGreaterEqual(events.count("start"), 2)


if __name__ == "__main__":
    unittest.main()
