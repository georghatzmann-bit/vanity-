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
    def __init__(self, model, threshold, picovoice_key=""):
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
        self.assertTrue(self.api.place_save("  Graz, Österreich ")["ok"])
        self.assertTrue(self.api.hotkey_save("f9")["ok"])
        self.assertEqual(self.api.wake_sensitive(True)["threshold"], setup_wizard.SENSITIVE_THRESHOLD)
        saved = self.saved()
        self.assertEqual(saved["ich"]["ort"], "Graz, Österreich")
        self.assertEqual(saved["mute"]["hotkey"], "f9")
        self.assertEqual(saved["wakeword"]["threshold"], 0.35)
        # Die Einrichtung kennt danach die neuen Werte.
        self.assertEqual(self.api.hello()["values"]["ort"], "Graz, Österreich")
        self.assertEqual(self.api.hello()["values"]["tts_engine"], "lokal", "Standard: die lokale Stimme")
        self.assertEqual(self.api.wake_sensitive(False)["threshold"], 0.5)
        self.assertEqual(self.saved()["wakeword"]["threshold"], 0.5)

    def test_conversation_and_name_switches(self):
        values = self.api.hello()["values"]
        self.assertTrue(values["gespraech"], "Gespräch ist von Anfang an an")
        self.assertTrue(values["name_allein"])
        self.assertTrue(self.api.conversation_mode(False)["ok"])
        self.assertTrue(self.api.name_wake(False)["ok"])
        saved = self.saved()
        self.assertIs(saved["listen"]["gespraech"], False)
        self.assertIs(saved["wakeword"]["name_allein"], False)
        values = self.api.hello()["values"]
        self.assertFalse(values["gespraech"])
        self.assertFalse(values["name_allein"])

    def test_name_is_saved_and_checked(self):
        self.assertTrue(self.api.name_save("  Lisa ")["ok"])
        self.assertEqual(self.saved()["ich"]["name"], "Lisa")
        self.assertEqual(self.api.hello()["values"]["name"], "Lisa")
        self.assertFalse(self.api.name_save("Lisa Müller")["ok"], "nur der Vorname")
        self.assertTrue(self.api.name_save("")["ok"], "leer = Georg")

    def test_full_permission_switch(self):
        # Ohne Eintrag gilt die volle Freigabe, der Schalter speichert [rechte] volle_freigabe.
        self.assertTrue(self.api.hello()["values"]["full_permission"])
        self.assertTrue(self.api.permission_set(False)["ok"])
        self.assertIs(self.saved()["rechte"]["volle_freigabe"], False)
        self.assertFalse(self.api.hello()["values"]["full_permission"])
        self.assertTrue(self.api.permission_set(True)["ok"])
        self.assertIs(self.saved()["rechte"]["volle_freigabe"], True)

    def test_old_microsoft_voice_setting_reads_as_local(self):
        self.api._cfg["tts"]["engine"] = "edge"
        self.assertEqual(self.api.hello()["values"]["tts_engine"], "lokal")
        self.assertFalse(hasattr(setup_wizard, "VOICES"), "keine Microsoft-Stimmen mehr zur Auswahl")

    def test_hello_describes_the_start(self):
        info = self.api.hello()
        self.assertTrue(info["first_run"])
        self.assertIn("version", info)
        self.assertEqual(
            set(info["values"]),
            {"mic", "ort", "name", "hotkey", "threshold", "autostart", "full_permission", "ha_url", "ha_token_set",
             "speed", "tts_engine", "eleven_key_set", "eleven_voice", "eleven_voice_name", "groq_key_set",
             "pico_key_set", "gespraech", "name_allein"},
        )

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


class ClaudeInstallEnvTest(unittest.TestCase):
    def test_drops_powershell7_module_paths(self):
        # So erbt es Windows PowerShell, wenn Jarvis aus PowerShell 7 gestartet wurde
        env = setup_wizard.windows_powershell_env({
            "PSMODULEPATH": r"C:\Users\G\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;"
                            r"c:\program files\powershell\7\Modules;C:\Program Files\WindowsPowerShell\Modules;"
                            r"C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules",
            "PATH": "x",
        })
        self.assertEqual(env["PSMODULEPATH"],
                         r"C:\Program Files\WindowsPowerShell\Modules;C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules")
        self.assertEqual(env["PATH"], "x")

    def test_without_module_path(self):
        self.assertEqual(setup_wizard.windows_powershell_env({"PATH": "x"}), {"PATH": "x"})


class TomlValueTest(unittest.TestCase):
    def test_values_survive_a_round_trip(self):
        for value in (True, False, 0.35, 3, "C:\\Users\\Georg\\claude.exe", 'Er sagte "Hallo"', "Zeile\neins",
                      ["haiku", "sonnet"]):
            with self.subTest(value=value):
                self.assertEqual(tomllib.loads(f"x = {toml_value(value)}")["x"], value)


class SaveFromManyThreadsTest(unittest.TestCase):
    def test_nothing_lost_and_the_file_stays_readable(self):
        # Fenster, Stimme und Hinweise speichern gleichzeitig: ohne Sperre gingen Werte verloren
        # oder config.toml war danach kaputt (Jarvis startet dann nicht mehr)
        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text("[test]\n", encoding="utf-8")
            start = threading.Barrier(30)

            def save(i):
                start.wait()
                save_setting("test", f"wert{i}", i, path)

            threads = [threading.Thread(target=save, args=(i,)) for i in range(30)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8"))["test"],
                             {f"wert{i}": i for i in range(30)})


class UpgradeConfigTest(unittest.TestCase):
    def test_old_default_gets_the_new_value_once(self):
        from jarvis.config import EXAMPLE_PATH, upgrade_config

        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            # Eine config.toml von früher: Kopie der alten Vorlage, ohne [intern].
            old = EXAMPLE_PATH.read_text(encoding="utf-8").replace("silence_seconds = 0.9", "silence_seconds = 1.2")
            old = old.replace("max_seconds = 60", "max_seconds = 20").split("[intern]")[0]
            path.write_text(old, encoding="utf-8")
            # Stufe für Stufe (1.2 -> 0.9 -> 0.7 -> 0.9), gemeldet wird nur der Endwert.
            self.assertEqual(upgrade_config(path), ["listen.silence_seconds = 0.9", "listen.max_seconds = 60"])
            data = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["listen"]["silence_seconds"], 0.9)
            self.assertEqual(data["listen"]["max_seconds"], 60)
            from jarvis.config import CONFIG_VERSION

            self.assertEqual(data["intern"]["config_version"], CONFIG_VERSION)
            # Wer danach selbst 1.2 einträgt, behält das.
            save_setting("listen", "silence_seconds", 1.2, path)
            self.assertEqual(upgrade_config(path), [])
            self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8"))["listen"]["silence_seconds"], 1.2)

    def test_old_conrad_settings_get_the_more_natural_ones(self):
        from jarvis.config import EXAMPLE_PATH, upgrade_config

        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            # Die Microsoft-Stimme gibt es nicht mehr, alte Dateien haben die Zeilen aber noch.
            text = EXAMPLE_PATH.read_text(encoding="utf-8").replace("[tts]\n", '[tts]\nrate = "+5%"\npitch = "-4Hz"\n')
            path.write_text(text.split("[intern]")[0], encoding="utf-8")
            self.assertEqual(upgrade_config(path), ['tts.rate = -5%', 'tts.pitch = -8Hz'])

    def test_voice_and_recognition_become_local(self):
        """Georg: "Voice komplett lokal, keine Windows-Stimme". Version 7 stellt alte Dateien um, die
        Schlüssel bleiben."""
        from jarvis.config import EXAMPLE_PATH, load_config, upgrade_config

        for tts_engine, stt_engine in (("edge", "auto"), ("windows", "groq"), ("elevenlabs", "auto")):
            with self.subTest(tts=tts_engine, stt=stt_engine), TemporaryDirectory() as folder:
                path = Path(folder) / "config.toml"
                text = EXAMPLE_PATH.read_text(encoding="utf-8").split("[intern]")[0]
                text = text.replace('engine = "lokal"\n# Für "lokal"', f'engine = "{tts_engine}"\n# Für "lokal"')
                text = text.replace('engine = "lokal"\n# Auf dem eigenen PC', f'engine = "{stt_engine}"\n# Auf dem eigenen PC')
                text = text.replace('groq_key = ""', 'groq_key = "gsk_behalten"')
                path.write_text(text + '\n[intern]\nconfig_version = 6\n', encoding="utf-8")
                self.assertEqual(load_config(path)["tts"]["engine"], tts_engine)
                changes = upgrade_config(path)
                self.assertEqual(sorted(changes), ["stt.engine = lokal", "tts.engine = lokal"])
                cfg = load_config(path)
                self.assertEqual((cfg["tts"]["engine"], cfg["stt"]["engine"]), ("lokal", "lokal"))
                self.assertEqual(cfg["stt"]["groq_key"], "gsk_behalten")

    def test_changed_value_is_kept(self):
        from jarvis.config import EXAMPLE_PATH, upgrade_config

        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            text = EXAMPLE_PATH.read_text(encoding="utf-8").replace("silence_seconds = 0.9", "silence_seconds = 1.5")
            path.write_text(text.split("[intern]")[0], encoding="utf-8")
            self.assertEqual(upgrade_config(path), [])
            self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8"))["listen"]["silence_seconds"], 1.5)


class UpgradeToJarvis2Test(unittest.TestCase):
    def test_old_install_rules_and_window_settings_are_updated(self):
        from jarvis.config import EXAMPLE_PATH, load_config, upgrade_config

        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            text = EXAMPLE_PATH.read_text(encoding="utf-8").split("[intern]")[0]
            text = text.replace("close_to_tray = true", "close_to_tray = false")
            # Die alte, mehrzeilige Sperrliste mit "winget install"
            text = text.replace('"Bash(winget uninstall:*)",', '"Bash(winget install:*)", "Bash(winget uninstall:*)",')
            text = text.replace('"PowerShell(winget uninstall:*)",', '"PowerShell(winget install:*)", "PowerShell(winget uninstall:*)",')
            path.write_text(text, encoding="utf-8")
            changes = upgrade_config(path)
            self.assertIn("gui.close_to_tray = True", changes)
            cfg = load_config(path)
        self.assertEqual(cfg["listen"]["silence_seconds"], 0.9)
        self.assertTrue(cfg["gui"]["close_to_tray"])
        self.assertTrue(cfg["gui"]["start_hidden"])
        blocked = cfg["brain"]["disallowed_tools"]
        self.assertNotIn("Bash(winget install:*)", blocked)
        self.assertNotIn("PowerShell(winget install:*)", blocked)
        self.assertIn("PowerShell(Remove-Item:*)", blocked)
        self.assertIn("PowerShell(winget uninstall:*)", blocked)


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



class SecondStartTest(unittest.TestCase):
    """Doppelklick, während Jarvis noch lädt: Das Fenster kommt, sobald es da ist."""

    def test_request_while_loading_waits_for_the_window(self):
        from jarvis.desktop import ShowRequests

        shown = []
        requests = ShowRequests()
        requests.fire()  # zweiter Start, das Fenster gibt es noch nicht
        self.assertEqual(shown, [])
        requests.connect(lambda: shown.append("zeigen"))
        self.assertEqual(shown, ["zeigen"])
        requests.fire()  # später: sofort
        self.assertEqual(shown, ["zeigen", "zeigen"])

    def test_no_request_no_window(self):
        from jarvis.desktop import ShowRequests

        shown = []
        ShowRequests().connect(lambda: shown.append("zeigen"))
        self.assertEqual(shown, [])  # der Autostart bleibt unsichtbar

    def test_broken_show_does_not_stop_the_start(self):
        from jarvis.desktop import ShowRequests

        requests = ShowRequests()
        requests.fire()

        def broken():
            raise RuntimeError("Fenster weg")

        with self.assertLogs("jarvis.desktop", "ERROR"):
            requests.connect(broken)  # kein Absturz: Sprachsteuerung und Tray starten trotzdem

    def test_listening_starts_before_the_slow_part(self):
        from types import SimpleNamespace

        from jarvis import __main__ as main
        from jarvis import desktop

        order = []

        class Loaded(Exception):
            pass

        def build_core(*_args, **_kwargs):
            order.append("laden")
            raise Loaded

        args = SimpleNamespace(hintergrund=True, silent=True)
        with mock.patch.object(desktop, "listen_for_show", lambda *_a: order.append("hoeren") or True), \
                mock.patch.object(desktop, "set_app_id", lambda: None), \
                mock.patch.object(main, "build_core", build_core):
            with self.assertRaises(Loaded):
                main.run_gui({"gui": {}}, args)
        self.assertEqual(order, ["hoeren", "laden"])

    def test_second_start_keeps_trying_while_the_first_starts(self):
        from jarvis import desktop

        tries = iter([False, False, True])
        with mock.patch.object(desktop.os, "name", "nt"), \
                mock.patch.object(desktop, "_signal_once", lambda: next(tries)), \
                mock.patch.object(desktop.time, "sleep", lambda _s: None):
            self.assertTrue(desktop.signal_running_instance(wait=5.0))

        with mock.patch.object(desktop.os, "name", "nt"), \
                mock.patch.object(desktop, "_signal_once", lambda: False), \
                mock.patch.object(desktop.time, "sleep", lambda _s: None), \
                mock.patch.object(desktop.time, "monotonic", side_effect=[0.0, 1.0, 6.0]):
            self.assertFalse(desktop.signal_running_instance(wait=5.0))

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
        for page, assets in (("setup.html", ("base.css", "setup.css", "orb.js", "setup.js")),
                             ("index.html", ("base.css", "style.css", "werkstatt.css", "werkstatt.js", "orb.js", "app.js"))):
            html = (WEB_DIR / page).read_text(encoding="utf-8")
            for asset in assets:
                self.assertIn(asset, html, page)
                self.assertTrue((WEB_DIR / asset).exists(), asset)

    def test_orb_is_one_renderer_for_pc_and_phone(self):
        # Die Handy-App bekommt nur ihren eigenen Ordner ausgeliefert, darum liegt dort eine Kopie
        from jarvis.gui.app import WEB_DIR

        pc = (WEB_DIR / "orb.js").read_text(encoding="utf-8")
        self.assertEqual((WEB_DIR / "handy" / "orb.js").read_text(encoding="utf-8"), pc,
                         "handy/orb.js muss eine Kopie von gui/web/orb.js sein")
        self.assertIn("window.JarvisOrb", pc)
        handy = (WEB_DIR / "handy" / "index.html").read_text(encoding="utf-8")
        self.assertLess(handy.index("orb.js"), handy.index("handy.js"))
        self.assertIn("'orb.js'", (WEB_DIR / "handy" / "sw.js").read_text(encoding="utf-8"))

    def test_main_window_calls_exist(self):
        import re

        from jarvis.gui.app import WEB_DIR, Api

        script = (WEB_DIR / "app.js").read_text(encoding="utf-8")
        called = set(re.findall(r"window\.pywebview\.api\.([a-z_]+)\(", script))
        self.assertIn("open_setup", called)
        self.assertEqual(sorted(n for n in called if not callable(getattr(Api, n, None))), [])


@unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")
class ClaudeCheckFallbackTest(SetupTestCase):
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
        self.assertEqual(result["speed"], "auto")

    def test_model_choice_is_saved(self):
        self.assertEqual(self.api.hello()["values"]["speed"], "auto", "ab Werk wählt Jarvis selbst")
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "gehirn.json").write_text("{}", encoding="utf-8")
        self.assertTrue(self.api.brain_speed("gründlich")["ok"])
        self.assertEqual(self.saved()["brain"]["modellwahl"], "gruendlich")
        self.assertFalse((self.state / "gehirn.json").exists(), "die alte Ersatz-Wahl darf nicht überstimmen")
        self.assertEqual(self.api.hello()["values"]["speed"], "gruendlich")
        self.assertTrue(self.api.brain_speed("ausgewogen")["ok"], "die Auswahl von früher")
        self.assertEqual(self.saved()["brain"]["modellwahl"], "auto")
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


class PremiumSettingsTest(SetupTestCase):
    """Einrichtung: ElevenLabs-Stimmen und Groq-Schlüssel gegen nachgebaute Server."""

    def setUp(self):
        super().setUp()
        from tests.test_elevenlabs import FakeElevenLabs

        self.fake = FakeElevenLabs()
        self.addCleanup(self.fake.stop)
        patch = mock.patch("jarvis.elevenlabs.BASE", self.fake.url)
        patch.start()
        self.addCleanup(patch.stop)

    def test_eleven_key_voices_and_choice(self):
        bad = self.api.eleven_check("falsch")
        self.assertFalse(bad["ok"])
        self.assertIn("Schlüssel stimmt nicht", bad["error"])
        self.assertFalse(self.config_path.exists(), "ein falscher Schlüssel wird nicht gespeichert")
        result = self.api.eleven_check("sk_test")
        self.assertTrue(result["ok"], result)
        self.assertEqual([v["name"] for v in result["voices"]], ["Rachel", "George"])
        self.assertEqual(result["selected"], "v_george", "Jarvis schlägt die britische Stimme vor")
        self.assertEqual((result["used"], result["limit"]), (1200, 30000))
        self.assertEqual(self.saved()["tts"]["elevenlabs_key"], "sk_test")
        self.assertTrue(self.api.eleven_select("v_george", "George")["ok"])
        tts = self.saved()["tts"]
        self.assertEqual((tts["engine"], tts["elevenlabs_voice"], tts["elevenlabs_voice_name"]), ("elevenlabs", "v_george", "George"))
        values = self.api.hello()["values"]
        self.assertTrue(values["eleven_key_set"])
        self.assertEqual(values["eleven_voice_name"], "George")
        self.assertEqual(values["tts_engine"], "elevenlabs")
        # Eine Microsoft-Stimme gibt es nicht mehr: zurück geht es nur zur lokalen Stimme
        self.assertFalse(hasattr(self.api, "voice_save"))
        self.assertFalse(hasattr(self.api, "voices"))

    def test_library_voice_is_added_and_chosen(self):
        self.api.eleven_check("sk_test")
        library = self.api.eleven_library("male")
        self.assertEqual(library["voices"][0]["name"], "Otto")
        result = self.api.eleven_add("owner1", "v_lib", "Otto")
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.saved()["tts"]["elevenlabs_voice"], "v_lib_added")

    def test_free_account_switches_away_from_a_library_voice(self):
        # Lennard wurde gewählt, als das Konto noch ein Abo hatte
        self.fake.library_voices = [("v_lennard", "Lennard - Warm & Trustworthy")]
        self.assertTrue(self.api.eleven_select("v_lennard", "Lennard")["ok"])
        self.fake.tier = "free"
        result = self.api.eleven_check("sk_test")
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["free"])
        self.assertEqual((result["used"], result["limit"]), (1200, 10000))
        self.assertEqual(result["selected"], "v_george")
        self.assertIn("Lennard", result["note"])
        self.assertIn("Starter", result["note"])
        tts = self.saved()["tts"]
        self.assertEqual((tts["engine"], tts["elevenlabs_voice"], tts["elevenlabs_voice_name"]), ("elevenlabs", "v_george", "George"))

    def test_free_account_tries_a_voice_before_taking_it(self):
        # Neue Standard-Stimmen sehen aus wie normale, ElevenLabs verweigert sie aber Gratis-Konten
        self.fake.tier = "free"
        self.fake.locked_ids = {"v_rachel"}
        self.api.eleven_check("sk_test")
        refused = self.api.eleven_select("v_rachel", "Rachel")
        self.assertFalse(refused["ok"])
        self.assertTrue(refused["locked"])
        self.assertIn("Voice Design", refused["error"])
        probe = [r for r in self.fake.requests if "/stream" in r[1]][-1]
        self.assertEqual(probe[3]["text"], "Ja.", "nur ein Wort zur Probe")
        self.assertNotEqual(self.saved()["tts"].get("elevenlabs_voice"), "v_rachel")
        self.assertTrue(self.api.eleven_select("v_george", "George")["ok"])
        self.assertEqual(self.saved()["tts"]["elevenlabs_voice"], "v_george")

    def test_paid_account_takes_a_voice_without_trying(self):
        self.api.eleven_check("sk_test")
        self.assertTrue(self.api.eleven_select("v_george", "George")["ok"])
        self.assertFalse(any("/stream" in r[1] for r in self.fake.requests), "kein Guthaben verbraucht")

    def test_free_account_does_not_take_library_voices(self):
        self.fake.tier = "free"
        self.api.eleven_check("sk_test")
        result = self.api.eleven_add("owner1", "v_lib", "Otto")
        self.assertFalse(result["ok"])
        self.assertIn("Starter", result["error"])
        self.assertFalse(any("/v1/voices/add/" in r[1] for r in self.fake.requests), "gar nicht erst übernommen")

    def test_paid_account_keeps_its_library_voice(self):
        self.fake.library_voices = [("v_lennard", "Lennard - Warm & Trustworthy")]
        self.assertTrue(self.api.eleven_select("v_lennard", "Lennard")["ok"])
        result = self.api.eleven_check("sk_test")
        self.assertFalse(result["free"])
        self.assertEqual((result["selected"], result["note"]), ("v_lennard", ""))
        self.assertEqual(self.saved()["tts"]["elevenlabs_voice"], "v_lennard")

    def test_picovoice_key_is_checked_saved_and_used_by_the_mic_test(self):
        with mock.patch("jarvis.audio.picovoice_problem", return_value="Dieser Schlüssel stimmt nicht."):
            self.assertFalse(self.api.picovoice_check("falsch")["ok"])
        self.assertFalse(self.api.hello()["values"]["pico_key_set"])
        with mock.patch("jarvis.audio.picovoice_problem", return_value=""), \
                mock.patch.object(self.api._mic, "reload") as reload:
            self.assertTrue(self.api.picovoice_check("gut")["ok"])
        reload.assert_called_once()
        self.assertEqual(self.saved()["wakeword"]["picovoice_key"], "gut")
        self.assertTrue(self.api.hello()["values"]["pico_key_set"])

    def test_links_only_to_the_sign_up_pages(self):
        with mock.patch("webbrowser.open", return_value=True) as opened:
            self.assertTrue(self.api.open_url("https://console.groq.com/keys"))
            self.assertFalse(self.api.open_url("https://example.com/boese"))
            self.assertFalse(self.api.open_url("file:///C:/Windows"))
        self.assertEqual(opened.call_count, 1)

    def test_groq_key(self):
        import json as _json
        import threading as _threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                ok = self.headers.get("Authorization") == "Bearer gsk_gut"
                data = _json.dumps({"data": [{"id": "whisper-large-v3-turbo"}]} if ok else {"error": "invalid"}).encode()
                self.send_response(200 if ok else 401)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        _threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        with mock.patch("jarvis.stt.GROQ_MODELS_URL", f"http://127.0.0.1:{server.server_port}/openai/v1/models"):
            self.assertIn("gsk_", self.api.groq_check("gsk_falsch")["error"])
            self.assertTrue(self.api.groq_check("gsk_gut")["ok"])
        self.assertEqual(self.saved()["stt"]["groq_key"], "gsk_gut")
        self.assertTrue(self.api.hello()["values"]["groq_key_set"])


if __name__ == "__main__":
    unittest.main()
