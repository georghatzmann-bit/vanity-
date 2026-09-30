"""Die Einrichtung (setup_wizard) und was dazugehört: Speichern, Claude finden, Start-Sperre."""

import sys
import threading
import time
import tomllib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from tests.helpers import frame, make_fake_claude
from jarvis import setup_wizard
from jarvis.brain import find_claude
from jarvis.config import load_config, save_setting, toml_value

DEVICES = [
    {"index": 1, "name": "Microsoft Soundmapper - Input", "hostapi": "MME", "default": False},
    {"index": 2, "name": "Mikrofon (Realtek(R) Audio) ", "hostapi": "MME", "default": True},
    {"index": 3, "name": "Headset (HyperX Cloud)", "hostapi": "MME", "default": False},
    {"index": 7, "name": "Mikrofon (Realtek(R) Audio)", "hostapi": "Windows WASAPI", "default": False},
]


class FakeMic:
    """Liefert erst Stille, dann lautes Sprechen."""

    def __init__(self, device):
        if int(device) == 99:
            raise ValueError("Gerät 99 gibt es nicht")
        self.name = "Test-Mikrofon"
        self.dead_silent = False
        self._count = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def read(self):
        time.sleep(0.005)
        self._count += 1
        return frame(0 if self._count < 5 else 3000)


class FakeWake:
    def __init__(self, model, threshold):
        self.threshold = threshold

    def reset(self):
        pass

    def score(self, samples):
        return 0.9 if np.abs(samples).max() > 1000 else 0.0


class SetupTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config_path = root / "config.toml"
        self.state = root / "daten"
        self.home = root / "home"
        self.home.mkdir()
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        for patch in (
            mock.patch("jarvis.config.CONFIG_PATH", self.config_path),
            mock.patch.object(setup_wizard, "DONE_MARKER", self.state / "einrichtung-fertig.txt"),
            mock.patch.object(setup_wizard, "STATE_DIR", self.state),
            mock.patch.object(setup_wizard, "HOME_DIR", self.home),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.api = setup_wizard.SetupApi(load_config())

    def saved(self) -> dict:
        return tomllib.loads(self.config_path.read_text(encoding="utf-8-sig"))


class SettingsTest(SetupTestCase):
    def test_choices_are_saved_to_config(self):
        self.assertTrue(self.api.voice_save("de-DE-KillianNeural")["ok"])
        self.assertTrue(self.api.place_save("  Graz, Österreich ")["ok"])
        self.assertTrue(self.api.hotkey_save("f9")["ok"])
        self.assertEqual(self.api.wake_sensitive(True)["threshold"], setup_wizard.SENSITIVE_THRESHOLD)
        saved = self.saved()
        self.assertEqual(saved["tts"]["voice"], "de-DE-KillianNeural")
        self.assertEqual(saved["ich"]["ort"], "Graz, Österreich")
        self.assertEqual(saved["mute"]["hotkey"], "f9")
        self.assertEqual(saved["wakeword"]["threshold"], 0.35)
        # Die Einrichtung kennt danach die neuen Werte.
        self.assertEqual(self.api.hello()["values"]["voice"], "de-DE-KillianNeural")
        self.assertEqual(self.api.wake_sensitive(False)["threshold"], 0.5)
        self.assertEqual(self.saved()["wakeword"]["threshold"], 0.5)

    def test_hello_describes_the_start(self):
        info = self.api.hello()
        self.assertTrue(info["first_run"])
        self.assertIn("version", info)
        self.assertEqual(
            set(info["values"]),
            {"mic", "ort", "voice", "hotkey", "threshold", "autostart", "ha_url", "ha_token_set", "speed"},
        )
        self.assertEqual(len(self.api.voices()), len(setup_wizard.VOICES))
        self.assertTrue(all(v["id"].endswith("Neural") for v in self.api.voices()))

    def test_microphones_are_listed_once_and_saved_by_name(self):
        with mock.patch("jarvis.audio.input_devices", return_value=DEVICES):
            mics = self.api.mics()
            self.assertEqual([m["name"] for m in mics], ["Mikrofon (Realtek(R) Audio)", "Headset (HyperX Cloud)"])
            self.assertTrue(mics[0]["default"])
            result = self.api.mic_save(3)
        self.assertTrue(result["ok"])
        self.assertEqual(self.saved()["audio"]["input_device"], "Headset (HyperX Cloud)")
        with mock.patch("jarvis.audio.input_devices", return_value=[]):
            self.assertFalse(self.api.mic_save(42)["ok"])

    def test_alexa_rooms_are_saved_as_table(self):
        echos = [
            {"room": "Küche", "entity": "media_player.echo_kueche"},
            {"room": "Wohn zimmer!", "entity": "media_player.echo_wz"},
            {"room": "", "entity": "media_player.ohne_raum"},
        ]
        self.assertTrue(self.api.ha_save("http://homeassistant.local:8123", "abc\"def", echos)["ok"])
        ha = self.saved()["homeassistant"]
        self.assertEqual(ha["url"], "http://homeassistant.local:8123")
        self.assertEqual(ha["token"], 'abc"def')
        self.assertEqual(ha["alexa"], {"kueche": "media_player.echo_kueche", "wohnzimmer": "media_player.echo_wz"})
        # Ohne neuen Token bleibt der alte stehen.
        self.api.ha_save("http://ha:8123", "", [])
        self.assertEqual(self.saved()["homeassistant"]["token"], 'abc"def')

    def test_place_check_reports_unknown_places_kindly(self):
        class FakeWeather:
            def __init__(self, place):
                self.place = place

            def current(self):
                if self.place == "Nirgendwo":
                    raise LookupError("unbekannt")
                return {"place": "Wien", "temp": 14, "text": "bewölkt"}

        with mock.patch("jarvis.weather.Weather", FakeWeather):
            self.assertEqual(self.api.place_check("wien")["place"], "Wien")
            self.assertIn("kenne ich leider nicht", self.api.place_check("Nirgendwo")["error"])
            self.assertFalse(self.api.place_check("  ")["ok"])

    def test_finish_marks_setup_done_and_closes_window(self):
        closed = threading.Event()
        window = mock.Mock(destroy=closed.set)
        api = setup_wizard.SetupApi(load_config(), [window])
        self.assertFalse(setup_wizard.setup_done())
        self.assertTrue(api.finish(True)["ok"])
        self.assertTrue(setup_wizard.setup_done())
        self.assertEqual(api.finished, {"start": True})
        self.assertTrue(closed.wait(3))


class MicTestTest(SetupTestCase):
    def test_level_and_wake_word_are_measured(self):
        with mock.patch("jarvis.audio.Microphone", FakeMic), mock.patch("jarvis.audio.WakeWord", FakeWake):
            started = self.api.mic_start(2)
            self.assertTrue(started["ok"], started)
            self.assertEqual(started["name"], "Test-Mikrofon")
            deadline = time.monotonic() + 3
            state = self.api.mic_poll()
            while not state["detected"] and time.monotonic() < deadline:
                time.sleep(0.02)
                state = self.api.mic_poll()
            self.assertTrue(state["detected"])
            self.assertGreater(state["level"], 0.5)
            self.assertAlmostEqual(state["best"], 0.9)
            self.api.mic_stop()
            self.assertFalse(self.api.mic_poll()["running"])

    def test_broken_microphone_is_explained(self):
        with mock.patch("jarvis.audio.Microphone", FakeMic):
            result = self.api.mic_start(99)
        self.assertFalse(result["ok"])
        self.assertTrue(result["error"])


class ClaudeCheckTest(SetupTestCase):
    def wait(self) -> dict:
        deadline = time.monotonic() + 20
        result = self.api.claude_poll()
        while result["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            result = self.api.claude_poll()
        return result

    def test_working_claude(self):
        save_setting("brain", "claude_path", str(make_fake_claude(self.home)))
        self.assertTrue(self.api.claude_check()["started"])
        self.assertFalse(self.api.claude_check()["started"])  # läuft schon
        result = self.wait()
        self.assertEqual(result["state"], "ok", result)
        self.assertTrue(result["model"].startswith("claude-"))

    def test_missing_claude(self):
        with mock.patch("jarvis.brain.find_claude", return_value=None):
            self.api.claude_check()
            result = self.wait()
        self.assertEqual(result["state"], "missing")


class FindClaudeTest(unittest.TestCase):
    def test_configured_path_wins_only_if_it_exists(self):
        with TemporaryDirectory() as tmp:
            exe = Path(tmp) / "claude.exe"
            exe.write_text("x")
            self.assertEqual(find_claude({"claude_path": str(exe)}), str(exe))
            which = {"claude": "/usr/bin/claude"}.get
            with mock.patch("shutil.which", side_effect=which):
                self.assertEqual(find_claude({"claude_path": str(Path(tmp) / "weg.exe")}), "/usr/bin/claude")

    def test_usual_places_after_fresh_install(self):
        with TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".local" / "bin").mkdir(parents=True)
            (home / ".local" / "bin" / "claude.exe").write_text("x")
            with mock.patch("shutil.which", return_value=None), mock.patch("pathlib.Path.home", return_value=home):
                self.assertEqual(find_claude({}), str(home / ".local" / "bin" / "claude.exe"))
            with mock.patch("shutil.which", return_value=None), mock.patch("pathlib.Path.home", return_value=home / "leer"), \
                    mock.patch.dict("os.environ", {"APPDATA": str(home / "leer")}):
                self.assertIsNone(find_claude({}))


class TomlValueTest(unittest.TestCase):
    def test_values_survive_a_round_trip(self):
        for value in (True, False, 0.35, 3, "C:\\Users\\Georg\\claude.exe", 'Er sagte "Hallo"', "Zeile\neins",
                      ["haiku", "sonnet"]):
            with self.subTest(value=value):
                self.assertEqual(tomllib.loads(f"x = {toml_value(value)}")["x"], value)


class OpenSetupTest(unittest.TestCase):
    def test_gear_button(self):
        from jarvis.gui.app import Api, GuiBridge

        bridge = GuiBridge()
        calls = []
        self.assertTrue(Api(bridge, None, None, lambda: calls.append(1)).open_setup())
        self.assertEqual(calls, [1])
        self.assertFalse(Api(bridge, None, None).open_setup())

        def broken():
            raise OSError("kaputt")

        self.assertFalse(Api(bridge, None, None, broken).open_setup())
        self.assertEqual(bridge.drain()[-1]["kind"], "error")


class SingleInstanceTest(unittest.TestCase):
    def test_second_start_is_refused_until_the_first_ends(self):
        import os

        if os.name == "nt":
            self.skipTest("Windows nutzt einen Mutex")
        from jarvis import __main__ as main

        with TemporaryDirectory() as tmp, mock.patch.object(main, "STATE_DIR", Path(tmp)):
            self.assertTrue(main.claim_single_instance("TestSperre"))
            first = main._instance_lock
            self.assertFalse(main.claim_single_instance("TestSperre"))
            started = time.monotonic()
            self.assertFalse(main.claim_single_instance("TestSperre", wait=0.5))
            self.assertGreaterEqual(time.monotonic() - started, 0.5)
            first.close()
            self.assertTrue(main.claim_single_instance("TestSperre"))
            main._instance_lock.close()

    def test_setup_sees_a_running_jarvis(self):
        import os

        if os.name == "nt":
            self.skipTest("Windows nutzt einen Mutex")
        from jarvis import __main__ as main

        with TemporaryDirectory() as tmp, mock.patch.object(main, "STATE_DIR", Path(tmp)), \
                mock.patch.object(setup_wizard, "STATE_DIR", Path(tmp)):
            self.assertFalse(setup_wizard.jarvis_running())
            self.assertTrue(main.claim_single_instance())
            self.assertTrue(setup_wizard.jarvis_running(wait=0.3))
            threading.Timer(0.3, main._instance_lock.close).start()
            self.assertFalse(setup_wizard.jarvis_running(wait=3))


if __name__ == "__main__":
    unittest.main()


class WindowsDefaultMicTest(SetupTestCase):
    DEVICES = [
        {"index": 0, "name": "Microsoft Soundmapper - Input", "hostapi": "MME", "default": True},
        {"index": 1, "name": "Mikrofonarray (Realtek(R) Audi", "hostapi": "MME", "default": True},
        {"index": 2, "name": "Headset (Arctis 7 Chat)", "hostapi": "MME", "default": False},
        {"index": 4, "name": "Mikrofonarray (Realtek(R) Audio)", "hostapi": "Windows WASAPI", "default": True},
    ]

    def test_full_names_and_what_jarvis_uses_now(self):
        save_setting("audio", "input_device", "Headset (Arctis 7 Chat)")
        self.api._reload()
        with mock.patch("jarvis.audio.input_devices", return_value=self.DEVICES):
            mics = self.api.mics()
        by_id = {m["id"]: m for m in mics}
        # MME kürzt den Namen, angezeigt wird der volle.
        self.assertEqual(by_id[1]["label"], "Mikrofonarray (Realtek(R) Audio)")
        self.assertEqual(by_id[2]["label"], "Headset (Arctis 7 Chat)")
        self.assertTrue(by_id[1]["default"])
        self.assertTrue(by_id[2]["current"])
        self.assertFalse(by_id[1]["current"])

    def test_windows_default_can_be_chosen_again(self):
        save_setting("audio", "input_device", "Headset (Arctis 7 Chat)")
        result = self.api.mic_save("")
        self.assertTrue(result["ok"])
        self.assertEqual(self.saved()["audio"]["input_device"], "")
        opened = []

        class Recorder(FakeMic):
            def __init__(self, device):
                opened.append(device)
                self.name = "Standard"
                self.dead_silent = False
                self._count = 0

        with mock.patch("jarvis.audio.Microphone", Recorder), mock.patch("jarvis.audio.WakeWord", FakeWake):
            started = self.api.mic_start("")
            self.api.mic_stop()
        self.assertTrue(started["ok"])
        self.assertEqual(opened, [None])


class SetupPageTest(unittest.TestCase):
    """Die Seite muss zur Python-Seite passen: jede Methode, die setup.js aufruft,
    gibt es in SetupApi (sonst hängt ein Knopf still)."""

    def test_every_call_from_the_page_exists(self):
        import re

        from jarvis.gui.app import WEB_DIR

        script = (WEB_DIR / "setup.js").read_text(encoding="utf-8")
        called = set(re.findall(r"call\('([a-z_]+)'", script))
        self.assertGreater(len(called), 15)
        missing = sorted(name for name in called if not callable(getattr(setup_wizard.SetupApi, name, None)))
        self.assertEqual(missing, [])
        for page, assets in (("setup.html", ("base.css", "setup.css", "setup.js")),
                             ("index.html", ("base.css", "style.css", "app.js"))):
            html = (WEB_DIR / page).read_text(encoding="utf-8")
            for asset in assets:
                self.assertIn(asset, html, page)
                self.assertTrue((WEB_DIR / asset).exists(), asset)

    def test_main_window_calls_exist(self):
        import re

        from jarvis.gui.app import WEB_DIR, Api

        script = (WEB_DIR / "app.js").read_text(encoding="utf-8")
        called = set(re.findall(r"window\.pywebview\.api\.([a-z_]+)\(", script))
        self.assertIn("open_setup", called)
        self.assertEqual(sorted(n for n in called if not callable(getattr(Api, n, None))), [])


@unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
class ClaudeCheckTest(SetupTestCase):
    def check(self, refuse: str) -> dict:
        from tests.helpers import make_fake_claude

        save_setting("brain", "claude_path", str(make_fake_claude(self.home)))
        check = setup_wizard.ClaudeCheck(load_config())
        with mock.patch.dict("os.environ", {"FAKE_REFUSE": refuse}), self.assertLogs("jarvis", "INFO"):
            check._run()
        return check.poll()

    def test_fallback_model_is_explained_and_kept(self):
        result = self.check("sonnet")
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["model"], "claude-haiku-test")
        self.assertIn("Sonnet hat nicht geklappt, Jarvis nimmt deshalb Haiku", result["note"])
        # Dauerhaft: Jarvis fragt ab jetzt zuerst Haiku.
        self.assertEqual(self.saved()["brain"]["models"], ["haiku", "sonnet", "opus"])
        self.assertEqual(result["speed"], "schnell")

    def test_speed_choice_saves_the_model_order(self):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "gehirn.json").write_text("{}", encoding="utf-8")
        self.assertTrue(self.api.brain_speed("gründlich")["ok"])
        self.assertEqual(self.saved()["brain"]["models"], ["opus", "sonnet", "haiku"])
        self.assertFalse((self.state / "gehirn.json").exists(), "die alte Ersatz-Wahl darf nicht überstimmen")
        self.assertEqual(self.api.hello()["values"]["speed"], "gruendlich")
        self.assertFalse(self.api.brain_speed("turbo")["ok"])

    def test_refusal_everywhere_shows_claudes_own_words(self):
        result = self.check("sonnet,haiku,opus")
        self.assertEqual(result["state"], "refused")
        self.assertIn("safeguards", result["detail"])


class AlexaCheckTest(SetupTestCase):
    def test_missing_address_or_token_is_explained_in_plain_words(self):
        self.assertIn("Adresse", self.api.ha_check("", "")["message"])
        result = self.api.ha_check("homeassistant.local:8123", "")
        self.assertFalse(result["ok"])
        self.assertIn("Token", result["message"])
        self.assertNotIn("config.toml", result["message"])

    def test_address_without_http_is_completed(self):
        seen = {}

        class FakeHa:
            def __init__(self, cfg):
                seen.update(cfg)

            def ping(self):
                return "API running."

            def devices(self):
                return [("media_player.echo_kueche", "Echo Küche", "idle"), ("light.flur", "Flur", "on")]

        with mock.patch("jarvis.homeassistant.HomeAssistant", FakeHa):
            result = self.api.ha_check("homeassistant.local:8123", "geheim")
        self.assertTrue(result["ok"])
        self.assertEqual(seen["url"], "http://homeassistant.local:8123")
        self.assertEqual([e["entity"] for e in result["echos"]], ["media_player.echo_kueche"])

    def test_saved_address_is_the_tested_one(self):
        with mock.patch.object(self.api, "_reload"):
            self.assertTrue(self.api.ha_save("homeassistant.local:8123/", "geheim")["ok"])
        self.assertEqual(self.saved()["homeassistant"]["url"], "http://homeassistant.local:8123")
