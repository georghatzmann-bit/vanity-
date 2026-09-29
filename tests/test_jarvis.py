import json
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis.audio import FRAME_SAMPLES, CommandRecorder  # noqa: E402
from jarvis.brain import BrainError, ClaudeBrain  # noqa: E402
from jarvis.config import load_config  # noqa: E402


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


FAKE_CLAUDE = textwrap.dedent(
    """
    import json, sys
    prompt = sys.stdin.read()
    args = sys.argv[1:]
    with open("calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "prompt": prompt}) + "\\n")
    if prompt == "kaputt":
        print(json.dumps({"is_error": True, "result": "Limit erreicht"}))
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

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_new_conversation_drops_continue(self):
        self.brain.ask("hallo")
        self.brain.new_conversation()
        self.brain.ask("neu")
        self.assertNotIn("--continue", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_error_result_raises(self):
        with self.assertRaises(BrainError):
            self.brain.ask("kaputt")


if __name__ == "__main__":
    unittest.main()
