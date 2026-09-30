import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from tests.helpers import frame
from jarvis.audio import FRAME_SAMPLES, CommandRecorder, resample, resolve_device
from jarvis import mic_setup
from jarvis.config import EXAMPLE_PATH, load_config, save_setting
from jarvis.mute import MUTE_PHRASES, MuteSwitch


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

    def test_listeners_hear_every_change(self):
        mute = MuteSwitch()
        seen = []
        mute.on_change(seen.append)
        mute.toggle()
        mute.toggle()
        self.assertEqual(seen, [True, False])


class ConfigTest(unittest.TestCase):
    def test_example_has_every_section(self):
        cfg = load_config(EXAMPLE_PATH)
        for section in ("ich", "wakeword", "audio", "mute", "listen", "stt", "tts", "answer", "local", "gui", "brain", "gaming", "homeassistant", "server"):
            self.assertIn(section, cfg)
        self.assertEqual(cfg["brain"]["models"], ["sonnet", "haiku", "opus"])
        self.assertFalse(cfg["server"]["enabled"])

    def test_old_user_config_keeps_new_defaults(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.toml"
            path.write_text('[brain]\nmodel = "opus"\n[audio]\ninput_device = "Arctis"\n', encoding="utf-8")
            cfg = load_config(path)
        self.assertEqual(cfg["audio"]["input_device"], "Arctis")
        self.assertTrue(cfg["gui"]["enabled"])
        self.assertIn("tools", cfg["brain"])


if __name__ == "__main__":
    unittest.main()


class HotkeyParseTest(unittest.TestCase):
    def test_parse(self):
        from jarvis.mute import parse_hotkey

        self.assertEqual(parse_hotkey("ctrl+alt+m"), (0x3, ord("M")))
        self.assertEqual(parse_hotkey("Strg + Alt + J"), (0x3, ord("J")))
        self.assertEqual(parse_hotkey("f9"), (0, 0x78))
        self.assertEqual(parse_hotkey("shift+F12"), (0x4, 0x7B))
        self.assertEqual(parse_hotkey("ctrl+pause"), (0x2, 0x13))
        self.assertIsNone(parse_hotkey("ctrl+ä"))
        self.assertIsNone(parse_hotkey("hyper+m"))
        self.assertIsNone(parse_hotkey(""))


class ConfigMergeTest(unittest.TestCase):
    def test_old_config_keeps_new_safety_rules(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from jarvis.config import load_config

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.toml"
            path.write_bytes(
                '\ufeff[brain]\nallowed_tools = ["Read"]\ndisallowed_tools = ["Bash(meins:*)"]\n'.encode("utf-8")
            )
            brain = load_config(path)["brain"]
        self.assertIn("Bash(winget install:*)", brain["disallowed_tools"])
        self.assertIn("Bash(meins:*)", brain["disallowed_tools"])
        self.assertIn("PowerShell", brain["allowed_tools"])

    def test_windows_path_gets_a_hint(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from jarvis.config import load_config

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.toml"
            path.write_text('[brain]\nclaude_path = "C:\\Users\\georg\\claude.exe"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "einfache Anführungszeichen"):
                load_config(path)
