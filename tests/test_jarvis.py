import json
import sys
import textwrap
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis.audio import FRAME_SAMPLES, CommandRecorder, resample, resolve_device  # noqa: E402
from jarvis.brain import BrainError, ClaudeBrain, RefusalError  # noqa: E402
from jarvis.config import load_config  # noqa: E402
from jarvis.mute import MUTE_PHRASES, MuteSwitch  # noqa: E402


def frame(level: int) -> np.ndarray:
    return np.full(FRAME_SAMPLES, level, dtype=np.int16)


class CommandRecorderTest(unittest.TestCase):
    def test_stops_after_silence_following_speech(self):
        rec = CommandRecorder(silence_seconds=0.4, energy_threshold=1000)
        for _ in range(5):
            self.assertFalse(rec.add(frame(5000)))
        done = [rec.add(frame(10)) for _ in range(5)]
        self.assertEqual(done, [False, False, False, False, True])
        audio = rec.audio()
        self.assertEqual(audio.dtype, np.float32)
        self.assertAlmostEqual(float(audio[0]), 5000 / 32768, places=4)

    def test_gives_up_when_nothing_is_said(self):
        rec = CommandRecorder(start_timeout_seconds=0.8, energy_threshold=1000)
        done = [rec.add(frame(10)) for _ in range(10)]
        self.assertTrue(done[-1])
        self.assertIsNone(rec.audio())

    def test_stops_at_max_length(self):
        rec = CommandRecorder(max_seconds=0.8, energy_threshold=1000)
        done = [rec.add(frame(5000)) for _ in range(10)]
        self.assertTrue(done[-1])
        self.assertFalse(any(done[:-1]))

    def test_automatic_threshold_follows_noise(self):
        self.assertEqual(CommandRecorder(noise_floor=50).threshold, 300)
        self.assertEqual(CommandRecorder(noise_floor=400).threshold, 1000)


class ResampleTest(unittest.TestCase):
    def test_48k_block_becomes_16k_block(self):
        t = np.arange(3840) / 48000
        block = (8000 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
        out = resample(block, FRAME_SAMPLES)
        self.assertEqual(out.shape, (FRAME_SAMPLES,))
        self.assertEqual(out.dtype, np.int16)
        self.assertGreater(np.abs(out).max(), 7000)

    def test_16k_block_is_unchanged(self):
        block = frame(123)
        self.assertIs(resample(block, FRAME_SAMPLES), block)


DEVICES = [
    {"index": 1, "name": "Mikrofonarray (Realtek Audio)", "hostapi": "MME", "default": True},
    {"index": 5, "name": "Headset Microphone (Arctis 7)", "hostapi": "Windows WASAPI", "default": False},
    {"index": 9, "name": "Headset Microphone (Arctis 7)", "hostapi": "MME", "default": False},
]


class ResolveDeviceTest(unittest.TestCase):
    def test_empty_means_windows_default(self):
        self.assertIsNone(resolve_device("", DEVICES))

    def test_by_number(self):
        self.assertEqual(resolve_device("5", DEVICES), 5)
        self.assertEqual(resolve_device(1, DEVICES), 1)

    def test_by_name_prefers_mme(self):
        self.assertEqual(resolve_device("arctis", DEVICES), 9)

    def test_unknown_device_explains(self):
        with self.assertRaises(ValueError):
            resolve_device("Blue Yeti", DEVICES)
        with self.assertRaises(ValueError):
            resolve_device("42", DEVICES)


class MuteTest(unittest.TestCase):
    def test_toggle(self):
        mute = MuteSwitch()
        self.assertFalse(mute.muted)
        mute.toggle()
        self.assertTrue(mute.muted)
        self.assertFalse(mute.wait_until_unmuted(timeout=0.01))
        mute.toggle()
        self.assertTrue(mute.wait_until_unmuted(timeout=0.01))

    def test_mute_phrases_do_not_catch_volume_commands(self):
        self.assertTrue(MUTE_PHRASES.search("Jarvis, Mikrofon aus bitte"))
        self.assertTrue(MUTE_PHRASES.search("Hör auf zuzuhören."))
        self.assertFalse(MUTE_PHRASES.search("Mach den PC stumm"))
        self.assertFalse(MUTE_PHRASES.search("Schalte das Mikrofon in Discord aus"))

    def test_voice_loop_stops_mic_while_muted(self):
        from jarvis.__main__ import voice_loop

        class Stop(Exception):
            pass

        events = []

        class Mic:
            dead_silent = False
            reads = 0

            def start(self):
                events.append("start")

            def stop(self):
                events.append("stop")

            def read(self):
                Mic.reads += 1
                if Mic.reads > 3:
                    raise Stop
                return frame(0)

        class Wake:
            threshold = 0.5

            def score(self, _frame):
                return 0.0

            def reset(self):
                events.append("reset")

        class Sounds:
            def listening(self):
                pass

            def muted(self):
                events.append("muted")
                threading.Timer(0.05, mute.unmute).start()

            def unmuted(self):
                events.append("unmuted")

        mute = MuteSwitch()
        mute.mute()
        with self.assertRaises(Stop):
            voice_loop(load_config(), Mic(), Wake(), None, None, print, mute, Sounds(), "X")
        self.assertEqual(events, ["start", "stop", "muted", "unmuted", "start", "reset"])


FAKE_CLAUDE = textwrap.dedent(
    """
    import json, sys
    prompt = sys.stdin.read()
    args = sys.argv[1:]
    with open("calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "prompt": prompt}) + "\\n")
    if prompt == "kaputt":
        print(json.dumps({"is_error": True, "result": "Limit erreicht"}))
    elif prompt == "abgelehnt":
        print(json.dumps({"type": "result", "is_error": True, "result":
            "We're improving these safeguards. Claude Code can't respond to your last message with Opus."}))
        sys.exit(1)
    elif prompt == "absturz":
        print("Traceback: irgendwas", file=sys.stderr)
        sys.exit(2)
    else:
        print(json.dumps({"is_error": False, "result": "Sehr wohl, Sir. " + prompt}))
    """
)


class ClaudeBrainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        script = self.home / "fake_claude.py"
        script.write_text(FAKE_CLAUDE, encoding="utf-8")
        launcher = self.home / "claude"
        launcher.write_text(f"#!/bin/sh\nexec {sys.executable} {script} \"$@\"\n")
        launcher.chmod(0o755)
        cfg = load_config()["brain"]
        cfg["claude_path"] = str(launcher)
        self.brain = ClaudeBrain(cfg, self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def calls(self):
        lines = (self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_prompt_goes_via_stdin_and_conversation_continues(self):
        tricky = 'öffne "Notepad" & del C:\\ ; rm -rf /'
        self.assertEqual(self.brain.ask(tricky), "Sehr wohl, Sir. " + tricky)
        self.brain.ask("und jetzt?")
        first, second = self.calls()
        self.assertEqual(first["prompt"], tricky)
        self.assertNotIn(tricky, first["args"])
        self.assertNotIn("--continue", first["args"])
        self.assertIn("--continue", second["args"])
        self.assertIn("Bash(rm:*)", first["args"])
        self.assertEqual(first["args"][first["args"].index("--model") + 1], "sonnet")

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_new_conversation_drops_continue(self):
        self.brain.ask("hallo")
        self.brain.new_conversation()
        self.brain.ask("neu")
        self.assertNotIn("--continue", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_refusal_is_recognised_and_starts_fresh(self):
        self.brain.ask("hallo")
        with self.assertRaises(RefusalError):
            self.brain.ask("abgelehnt")
        self.brain.ask("weiter")
        self.assertNotIn("--continue", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_crash_without_json_shows_stderr(self):
        with self.assertRaisesRegex(BrainError, "Traceback: irgendwas"):
            self.brain.ask("absturz")

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_error_result_raises(self):
        with self.assertRaises(BrainError):
            self.brain.ask("kaputt")


if __name__ == "__main__":
    unittest.main()
