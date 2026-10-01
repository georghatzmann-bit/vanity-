import unittest
from unittest import mock
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
        self.assertIn("Bash(Remove-Item:*)", brain["disallowed_tools"])
        self.assertIn("PowerShell(winget uninstall:*)", brain["disallowed_tools"])
        # Installieren darf Jarvis seit Version 2 ohne Nachfrage.
        self.assertNotIn("PowerShell(winget install:*)", brain["disallowed_tools"])
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


class FakeSoundDevice:
    """So sieht PortAudio unter Windows aus: dasselbe Gerät unter mehreren Treibern,
    MME mit gekürzten Namen und dem "Soundmapper" als Standard."""

    def __init__(self):
        self.default = mock.Mock(device=(0, 5))
        self._devices = [
            {"name": "Microsoft Soundmapper - Input", "hostapi": 0, "max_input_channels": 2},
            {"name": "Mikrofon", "hostapi": 0, "max_input_channels": 1},
            {"name": "Mikrofonarray (Realtek(R) Audi", "hostapi": 0, "max_input_channels": 2},
            {"name": "Headset (Arctis 7 Chat)", "hostapi": 0, "max_input_channels": 1},
            {"name": "Mikrofonarray (Realtek(R) Audio)", "hostapi": 1, "max_input_channels": 2},
            {"name": "Lautsprecher (Realtek(R) Audio)", "hostapi": 1, "max_input_channels": 0},
        ]

    def query_hostapis(self):
        return [
            {"name": "MME", "default_input_device": 0},
            {"name": "Windows WASAPI", "default_input_device": 4},
        ]

    def query_devices(self):
        return self._devices


class DefaultMicrophoneTest(unittest.TestCase):
    def test_same_device_across_drivers(self):
        from jarvis.audio import same_device

        self.assertTrue(same_device("Mikrofonarray (Realtek(R) Audi", "Mikrofonarray (Realtek(R) Audio)"))
        self.assertTrue(same_device(" Headset (Arctis 7 Chat) ", "Headset (Arctis 7 Chat)"))
        # Ein kurzer Name ist kein gekürzter Name.
        self.assertFalse(same_device("Mikrofon", "Mikrofonarray (Realtek(R) Audio)"))
        self.assertFalse(same_device("", "Mikrofon"))

    def test_real_default_is_marked_not_just_the_soundmapper(self):
        import sys

        from jarvis.audio import input_devices

        with mock.patch.dict(sys.modules, {"sounddevice": FakeSoundDevice()}):
            devices = input_devices()
        marked = [d["name"] for d in devices if d["default"]]
        self.assertIn("Mikrofonarray (Realtek(R) Audi", marked)
        self.assertIn("Mikrofonarray (Realtek(R) Audio)", marked)
        self.assertNotIn("Mikrofon", marked)
        self.assertNotIn("Headset (Arctis 7 Chat)", marked)
        # Nur Eingänge.
        self.assertNotIn("Lautsprecher (Realtek(R) Audio)", [d["name"] for d in devices])


class TrimSilenceTest(unittest.TestCase):
    def test_long_silence_is_cut_to_a_natural_pause(self):
        from jarvis.tts import trim_silence

        rate = 24000
        speech = (np.sin(np.linspace(0, 400, rate)) * 12000).astype(np.int16)
        samples = np.concatenate([np.zeros(rate // 4, np.int16), speech, np.zeros(rate, np.int16)])
        trimmed = trim_silence(samples, rate)
        self.assertAlmostEqual(len(trimmed) / rate, 1.0 + 0.05 + 0.18, delta=0.01)
        self.assertEqual(len(trim_silence(np.zeros(100, np.int16), rate)), 100, "reine Stille bleibt, wie sie ist")


class VoiceCacheTest(unittest.TestCase):
    def test_short_sentences_come_from_the_cache_the_second_time(self):
        from tempfile import TemporaryDirectory

        from jarvis import tts

        calls = []

        def fake_edge(text, voice, rate="+0%", pitch="+0Hz"):
            calls.append(text)
            return (np.full(2400, 9000, np.int16), 24000)

        with TemporaryDirectory() as folder, mock.patch.object(tts, "synthesize_edge", fake_edge):
            speech = tts.TextToSpeech({"voice": "de-DE-ConradNeural"}, folder)
            first, _ = speech.synthesize("Einen Moment, Sir.")
            again, rate = speech.synthesize("Einen Moment, Sir.")
            speech.synthesize("Ein sehr langer Satz, " * 5)
            speech.synthesize("Ein sehr langer Satz, " * 5)
        self.assertEqual(calls.count("Einen Moment, Sir."), 1)
        self.assertEqual(calls.count("Ein sehr langer Satz, " * 5), 2, "lange Sätze werden nicht gespeichert")
        self.assertTrue(np.array_equal(first, again))
        self.assertEqual(rate, 24000)


class OfflineVoiceTest(unittest.TestCase):
    def test_piper_comes_before_the_windows_voice(self):
        from jarvis import tts

        class FakePiper:
            def synthesize(self, text):
                return np.full(2205, 8000, np.int16), 22050

        problems = []
        speech = tts.TextToSpeech({"voice": "de-DE-ConradNeural"}, on_problem=problems.append)
        with mock.patch.object(tts, "synthesize_edge", side_effect=OSError("SSL: CERTIFICATE_VERIFY_FAILED")), \
                mock.patch.object(tts, "piper_voice", return_value=FakePiper()), \
                mock.patch.object(tts, "synthesize_windows") as windows:
            samples, rate = speech.synthesize("Sehr wohl, Sir.")
        self.assertEqual(rate, 22050)
        windows.assert_not_called()
        self.assertFalse(speech.used_edge)
        self.assertIn("Virenscanner", problems[0])

    def test_windows_voice_is_the_last_resort(self):
        from jarvis import tts

        speech = tts.TextToSpeech({"voice": "de-DE-ConradNeural"})
        with mock.patch.object(tts, "synthesize_edge", side_effect=TimeoutError()), \
                mock.patch.object(tts, "piper_voice", return_value=None), \
                mock.patch.object(tts, "synthesize_windows", return_value=(np.full(100, 5000, np.int16), 16000)):
            _samples, rate = speech.synthesize("Hallo.")
        self.assertEqual(rate, 16000)


class ChimeTest(unittest.TestCase):
    def test_chime_is_audible_after_conversion(self):
        from jarvis.tts import chime_samples

        samples = chime_samples((880, 1320))
        self.assertEqual(samples.dtype, np.int16)
        # Player.play() macht daraus int16. Vorher kam dabei nur Stille heraus.
        played = np.ascontiguousarray(samples, dtype=np.int16)
        self.assertGreater(int(np.abs(played.astype(np.int32)).max()), 5000)


class MissingMicrophoneTest(unittest.TestCase):
    def test_unplugged_microphone_falls_back_to_windows_default(self):
        import sys

        from jarvis.audio import Microphone

        present = [{"index": 2, "name": "Mikrofon (Realtek(R) Audio)", "hostapi": "MME", "default": True}]
        with mock.patch.dict(sys.modules, {"sounddevice": mock.Mock()}), \
                mock.patch("jarvis.audio.input_devices", return_value=present), \
                mock.patch.object(Microphone, "_select", lambda self, device: setattr(self, "device", device)):
            mic = Microphone("Headset (Arctis 7 Chat)", fallback=True)
            self.assertEqual(mic.missing, "Headset (Arctis 7 Chat)")
            self.assertIsNone(mic.device)  # None = Windows-Standard
            # Ohne fallback bleibt es ein klarer Fehler (Mikrofon-Test, Selbsttest).
            with self.assertRaises(ValueError):
                Microphone("Headset (Arctis 7 Chat)")
            self.assertEqual(Microphone("Mikrofon (Realtek(R) Audio)", fallback=True).missing, "")


class ChimeEchoTest(unittest.TestCase):
    def test_echo_of_the_tone_does_not_start_or_end_the_recording(self):
        # Ton-Echo (laut), dann eine Pause, dann der eigentliche Befehl.
        recorder = CommandRecorder(silence_seconds=1.2, start_timeout_seconds=6, ignore_seconds=0.45, noise_floor=60)
        frames = [frame(6000)] * 4 + [frame(0)] * 12 + [frame(3000)] * 10 + [frame(0)] * 16
        done_at = None
        for i, f in enumerate(frames):
            if recorder.add(f):
                done_at = i
                break
        # Ohne das Zeitfenster wäre nach Echo + 1.2 s Stille Schluss gewesen,
        # bevor der Befehl überhaupt anfängt.
        self.assertIsNotNone(done_at)
        self.assertGreater(done_at, 4 + 12 + 10)
        audio = recorder.audio()
        self.assertIsNotNone(audio)

    def test_speaking_right_away_is_kept(self):
        recorder = CommandRecorder(silence_seconds=1.2, ignore_seconds=0.45, noise_floor=60)
        frames = [frame(3000)] * 12 + [frame(0)] * 16
        for f in frames:
            if recorder.add(f):
                break
        # Auch die ersten Blöcke (während des Tons gesprochen) sind in der Aufnahme.
        self.assertGreaterEqual(len(recorder.frames), 12)
        self.assertTrue(recorder.speech_started)


class HotkeyLabelTest(unittest.TestCase):
    def test_labels_for_screen_and_voice(self):
        from jarvis.mute import hotkey_label

        self.assertEqual(hotkey_label("ctrl+alt+m"), "Strg+Alt+M")
        self.assertEqual(hotkey_label("f9"), "F9")
        self.assertEqual(hotkey_label("pause"), "Pause")
        self.assertEqual(hotkey_label("ctrl+alt+m", spoken=True), "Steuerung Alt M")
        self.assertEqual(hotkey_label(""), "")
