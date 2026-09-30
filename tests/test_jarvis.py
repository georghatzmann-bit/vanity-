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
from jarvis import mic_setup  # noqa: E402
from jarvis.config import load_config, save_setting  # noqa: E402
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


    def test_exact_name_wins_over_partial_match(self):
        devices = DEVICES + [
            {"index": 12, "name": "Mikrofon (USB Audio)", "hostapi": "MME", "default": False},
            {"index": 13, "name": "Mikrofon (USB Audio) 2", "hostapi": "MME", "default": False},
        ]
        self.assertEqual(resolve_device("Mikrofon (USB Audio) 2", devices), 13)
        self.assertEqual(resolve_device("Mikrofon (USB Audio)", devices), 12)


WINDOWS_DEVICES = [
    {"index": 0, "name": "Microsoft Soundmapper - Input", "hostapi": "MME", "default": False},
    {"index": 1, "name": "Mikrofonarray (Realtek(R) Audio)", "hostapi": "MME", "default": True},
    {"index": 2, "name": "Headset (Arctis 7 Chat)", "hostapi": "MME", "default": False},
    {"index": 6, "name": "Primärer Soundaufnahmetreiber", "hostapi": "Windows DirectSound", "default": False},
    {"index": 7, "name": "Mikrofonarray (Realtek(R) Audio)", "hostapi": "Windows DirectSound", "default": False},
    {"index": 11, "name": "Headset (Arctis 7 Chat)", "hostapi": "Windows WASAPI", "default": False},
]


class MicSetupTest(unittest.TestCase):
    def test_each_microphone_is_listed_once(self):
        names = [d["name"] for d in mic_setup.choices(WINDOWS_DEVICES)]
        self.assertEqual(names, ["Mikrofonarray (Realtek(R) Audio)", "Headset (Arctis 7 Chat)"])

    def test_picking_a_number_saves_the_name(self):
        from unittest import mock

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.toml"
            answers = iter(["9", "2", ""])
            saved = {}
            with mock.patch.object(mic_setup, "input_devices", return_value=WINDOWS_DEVICES), \
                    mock.patch.object(mic_setup, "level_check", return_value=2500.0), \
                    mock.patch("builtins.input", lambda _prompt="": next(answers)), \
                    mock.patch.object(mic_setup, "save_setting",
                                      lambda *a: saved.setdefault("args", a)), \
                    mock.patch("builtins.print"):
                mic_setup.run()
            self.assertEqual(saved["args"], ("audio", "input_device", "Headset (Arctis 7 Chat)"))
            self.assertFalse(path.exists())


class SaveSettingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.toml"

    def tearDown(self):
        self.tmp.cleanup()

    def test_replaces_existing_value_and_keeps_comments(self):
        self.path.write_text('[audio]\n# Kommentar\ninput_device = ""\n\n[mute]\nhotkey = "f9"\n', encoding="utf-8")
        save_setting("audio", "input_device", 'Headset "Pro"', self.path)
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("# Kommentar", text)
        self.assertIn('hotkey = "f9"', text)
        cfg = load_config(self.path)
        self.assertEqual(cfg["audio"]["input_device"], 'Headset "Pro"')
        self.assertEqual(cfg["mute"]["hotkey"], "f9")

    def test_adds_missing_section(self):
        self.path.write_text('[wakeword]\nthreshold = 0.4\n', encoding="utf-8")
        save_setting("audio", "input_device", "Arctis", self.path)
        cfg = load_config(self.path)
        self.assertEqual(cfg["audio"]["input_device"], "Arctis")
        self.assertEqual(cfg["wakeword"]["threshold"], 0.4)

    def test_adds_key_to_existing_section(self):
        self.path.write_text('[audio]\n\n[mute]\nhotkey = "f9"\n', encoding="utf-8")
        save_setting("audio", "input_device", "Arctis", self.path)
        self.assertEqual(load_config(self.path)["audio"]["input_device"], "Arctis")

    def test_creates_config_from_example(self):
        save_setting("audio", "input_device", "Arctis", self.path)
        cfg = load_config(self.path)
        self.assertEqual(cfg["audio"]["input_device"], "Arctis")
        self.assertIn("[brain]", self.path.read_text(encoding="utf-8"))


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
    import json, os, sys
    prompt = sys.stdin.read()
    args = sys.argv[1:]
    model = args[args.index("--model") + 1] if "--model" in args else ""
    with open("calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "prompt": prompt}) + "\\n")
    if os.environ.get("FAKE_OLD_CLAUDE") and "--safe-mode" in args:
        print("error: unknown option '--safe-mode'", file=sys.stderr)
        sys.exit(1)
    refusal = {"type": "result", "is_error": True, "result":
        "API Error: Sonnet 5.5's safeguards flagged this session. Claude Code can't respond to your last message."}
    if prompt == "kaputt":
        print(json.dumps({"is_error": True, "result": "Limit erreicht"}))
    elif prompt == "abgelehnt" or (prompt.startswith("nur-haiku") and model != "haiku"):
        print(json.dumps(refusal))
        sys.exit(1)
    elif prompt == "absturz":
        print("Traceback: irgendwas", file=sys.stderr)
        sys.exit(2)
    else:
        print(json.dumps({"is_error": False, "result": "Sehr wohl, Sir. " + prompt,
                          "modelUsage": {"claude-" + model + "-test": {}}}))
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
        self.assertIn("--safe-mode", first["args"])
        persona = first["args"][first["args"].index("--system-prompt-file") + 1]
        self.assertTrue(persona.endswith("CLAUDE.md"))
        self.assertEqual(self.brain.last_model, "claude-sonnet-test")

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_new_conversation_drops_continue(self):
        self.brain.ask("hallo")
        self.brain.new_conversation()
        self.brain.ask("neu")
        self.assertNotIn("--continue", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_refusal_falls_back_to_next_model_and_stays_there(self):
        self.brain.ask("hallo")
        self.assertEqual(self.brain.ask("nur-haiku bitte"), "Sehr wohl, Sir. nur-haiku bitte")
        self.assertEqual(self.brain.last_model, "claude-haiku-test")
        sonnet_try, haiku_try = self.calls()[1:]
        self.assertIn("--continue", sonnet_try["args"])
        self.assertNotIn("--continue", haiku_try["args"])
        self.brain.ask("nur-haiku weiter")
        last = self.calls()[-1]["args"]
        self.assertEqual(last[last.index("--model") + 1], "haiku")
        self.assertIn("--continue", last)

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_refusal_from_every_model_raises(self):
        with self.assertRaises(RefusalError):
            self.brain.ask("abgelehnt")
        models = [c["args"][c["args"].index("--model") + 1] for c in self.calls()]
        self.assertEqual(models, ["sonnet", "haiku", "opus"])
        self.brain.ask("weiter")
        self.assertNotIn("--continue", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_old_claude_without_safe_mode_still_works(self):
        from unittest import mock

        with mock.patch.dict("os.environ", {"FAKE_OLD_CLAUDE": "1"}), self.assertLogs("jarvis.brain"):
            self.assertEqual(self.brain.ask("hallo"), "Sehr wohl, Sir. hallo")
        self.assertNotIn("--safe-mode", self.calls()[-1]["args"])

    @unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
    def test_diagnose_reports_each_model_and_mode(self):
        rows = self.brain.diagnose("nur-haiku")
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[0], ("sonnet", "mit deinen Einstellungen", "ABGELEHNT"))
        self.assertEqual(rows[3], ("haiku", "ohne Erweiterungen", "OK (claude-haiku-test)"))
        self.assertNotIn("--safe-mode", self.calls()[0]["args"])
        self.assertIn("--safe-mode", self.calls()[1]["args"])

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
