"""Lokale Stimme (Pocket TTS) und lokale Spracherkennung (Parakeet), ohne die echten Modelle.
Die echten Modelle prüft der Windows-Build (Schritt "Probe lokale Stimme")."""

import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np

import tests.helpers  # noqa: F401
from jarvis import localvoice


class FakePocket:
    """Wie localvoice.PocketVoice, liefert aber nur einen Ton."""

    instances = []

    def __init__(self, voice="george", fail=False, still_loading=False):
        self.voice = voice
        self.fail = fail
        self.still_loading = still_loading
        self.started = False
        FakePocket.instances.append(self)

    def start(self):
        self.started = True

    def loading(self):
        return self.still_loading

    def usable(self, wait=0.0):
        return True

    def stream(self, text, feed):
        if self.fail:
            raise RuntimeError("kaputt")
        tone = (np.sin(np.arange(24000 * 0.8) / 8) * 8000).astype(np.int16)
        for start in range(0, tone.size, 4800):
            feed(tone[start:start + 4800].tobytes())

    def synthesize(self, text):
        return (np.ones(2400, dtype=np.int16) * 500), 24000


class VoiceTest(unittest.TestCase):
    def setUp(self):
        FakePocket.instances.clear()

    def make(self, cfg=None, installed=True, fail=False, still_loading=False):
        from jarvis.tts import TextToSpeech

        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": installed, "stt": installed}), \
                mock.patch("jarvis.localvoice.PocketVoice", side_effect=lambda voice: FakePocket(voice, fail=fail, still_loading=still_loading)):
            tts = TextToSpeech({"engine": "lokal", "lokal_stimme": "Charles", **(cfg or {})}, Path(folder.name))
        return tts

    def test_local_voice_streams_and_caches(self):
        tts = self.make()
        self.assertEqual(FakePocket.instances[0].voice, "charles")
        self.assertTrue(FakePocket.instances[0].started, "lädt schon beim Start im Hintergrund")
        audio, rate = tts.synthesize("Sehr wohl, Sir.")
        self.assertEqual(rate, 24000)
        self.assertTrue(audio.done.wait(5))  # done kommt erst nach dem Speichern (siehe StreamingAudio.finish)
        self.assertGreater(audio.available(), 0)
        self.assertTrue(tts.used_edge, "die gute Stimme, keine Ersatzstimme")
        cached, _ = tts.synthesize("Sehr wohl, Sir.")
        self.assertIsInstance(cached, np.ndarray, "kurze Sätze kommen beim zweiten Mal aus dem Zwischenspeicher")

    def test_broken_local_voice_falls_back_to_the_offline_voice(self):
        problems = []
        tts = self.make(fail=True)
        tts._on_problem = problems.append
        with mock.patch.object(tts, "_offline", return_value=(np.zeros(10, dtype=np.int16), 22050)) as offline:
            samples, rate = tts.synthesize("Einen Moment, Sir.")
        offline.assert_called_once()
        self.assertEqual(rate, 22050)
        self.assertIn("lokale Stimme", problems[0])

    def test_still_loading_is_no_problem_message(self):
        """Gleich nach dem Start lädt die Stimme noch (auf langsamen PCs eine Minute). Der Satz kommt dann
        von der Ersatzstimme, aber ohne Meldung „spricht gerade nicht“: Es ist ja nichts kaputt."""
        problems = []
        tts = self.make(fail=True, still_loading=True)
        tts._on_problem = problems.append
        with mock.patch.object(tts, "_offline", return_value=(np.zeros(10, dtype=np.int16), 22050)) as offline:
            tts.synthesize("Guten Abend, Sir.")
        offline.assert_called_once()
        self.assertEqual(problems, [])

    def test_loading_state_of_the_real_voice(self):
        go = __import__("threading").Event()
        with mock.patch.object(localvoice.PocketVoice, "_load", lambda voice: (go.wait(5), voice.ready.set())):
            voice = localvoice.PocketVoice("george")
            self.assertFalse(voice.loading(), "noch nicht gestartet")
            voice.start()
            self.assertTrue(voice.loading())
            go.set()
            self.assertTrue(voice.ready.wait(5))
            self.assertFalse(voice.loading())

    def test_selftest_waits_for_the_voice_to_load(self):
        """Der Windows-Build lud die Stimme in 44 s, synthesize wartet nur 30 s: Der Selbsttest scheiterte."""
        waits = []

        class Slow(FakePocket):
            error = None

            def usable(self, wait=0.0):
                waits.append(wait)
                return False

            def synthesize(self, text):
                raise AssertionError("erst sprechen, wenn die Stimme geladen ist")

        signal = types.ModuleType("scipy.signal")
        signal.resample_poly = lambda *a, **k: None
        with mock.patch.object(localvoice, "PocketVoice", Slow), \
                mock.patch.dict(sys.modules, {"scipy": types.ModuleType("scipy"), "scipy.signal": signal}), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(localvoice._selftest_main(), 1)
        self.assertGreaterEqual(waits[0], 300)
        self.assertIn("Stimme lädt nicht", printed.call_args.args[0])

    def test_not_installed_uses_the_other_voices(self):
        tts = self.make(installed=False)
        self.assertEqual(FakePocket.instances, [])
        self.assertIsNone(tts._local)

    def test_config_is_read_as_utf8_on_windows(self):
        """Pocket TTS liest german.yaml mit open(pfad, "r"): Unter Windows (cp1252) scheiterte daran die Stimme."""
        package, utils, config = (types.ModuleType(n) for n in ("pocket_tts", "pocket_tts.utils", "pocket_tts.utils.config"))
        exec("def load(path):\n    with open(path, 'r') as f:\n        return f.read()\n", config.__dict__)
        package.utils, utils.config = utils, config
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(
                sys.modules, {"pocket_tts": package, "pocket_tts.utils": utils, "pocket_tts.utils.config": config}):
            path = Path(folder) / "german.yaml"
            path.write_text("remove_characters:\n  '„': ''\n  '“': ''\n", encoding="utf-8")
            localvoice._utf8_configs()
            localvoice._utf8_configs()  # zweimal schadet nicht
            with mock.patch("builtins.open", wraps=open) as opened:
                self.assertIn("„", config.load(path))
            self.assertEqual(opened.call_args.kwargs.get("encoding"), "utf-8")
            with mock.patch("builtins.open", wraps=open) as opened:
                config.open(path, "rb").close()
            self.assertNotIn("encoding", opened.call_args.kwargs, "Binärdateien bleiben, wie sie sind")

    def test_voice_names(self):
        self.assertEqual(localvoice.voice_id("Stuart_Bell"), "stuart_bell")
        self.assertEqual(localvoice.voice_id("unbekannt"), "george")
        self.assertEqual(len(localvoice.VOICES), 6)


class RecognitionTest(unittest.TestCase):
    def test_local_engine_prefers_parakeet(self):
        from jarvis import stt

        cfg = {"engine": "lokal", "model": "small", "language": "de"}
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch("jarvis.localvoice.ParakeetSpeechToText", return_value="parakeet") as parakeet, \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(cfg), "parakeet")
            parakeet.assert_called_once()
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": False, "stt": False}), \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(cfg), "whisper")
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(dict(cfg, lokal_modell="whisper")), "whisper")

    def test_parakeet_gets_float_audio_and_filters_noise(self):
        heard = []

        class Model:
            def recognize(self, audio, sample_rate):
                heard.append((audio.dtype, sample_rate, round(float(np.max(np.abs(audio))), 2)))
                return "Untertitel im Auftrag des ZDF" if len(heard) > 1 else "Öffne Discord."

        fake = types.SimpleNamespace(load_model=lambda name, quantization=None: Model())
        with mock.patch.dict(sys.modules, {"onnx_asr": fake}):
            recognizer = localvoice.ParakeetSpeechToText()
            loud = (np.ones(16000) * 16384).astype(np.int16)
            self.assertEqual(recognizer.transcribe(loud), "Öffne Discord.")
            self.assertEqual(heard[0], (np.float32, 16000, 0.5))
            self.assertEqual(recognizer.transcribe(loud), "", "Whisper-artige Untertitel-Halluzination")
            self.assertEqual(recognizer.transcribe(np.zeros(100, dtype=np.int16)), "", "zu kurz")


class InstallTest(unittest.TestCase):
    def test_pip_command_and_progress_lines(self):
        with mock.patch.object(localvoice, "_run", return_value=(True, "Successfully installed")) as run:
            self.assertEqual(localvoice.install(), (True, "Successfully installed"))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[1:4], ["-m", "pip", "install"])
        self.assertIn("pocket-tts", cmd)
        self.assertIn("onnx-asr[cpu,hub]", cmd)
        lines = []
        ok, last = localvoice._run([sys.executable, "-c", "print('eins'); print(''); print('zwei')"], lines.append, 60)
        self.assertTrue(ok)
        self.assertEqual((lines, last), (["eins", "zwei"], "zwei"))
        ok, _ = localvoice._run([sys.executable, "-c", "raise SystemExit(3)"], None, 60)
        self.assertFalse(ok)

    def test_pythonw_is_swapped_for_python(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "python.exe").write_text("")
            with mock.patch.object(localvoice.sys, "executable", str(Path(folder) / "pythonw.exe")):
                self.assertEqual(localvoice._python(), str(Path(folder) / "python.exe"))


class SetupTest(unittest.TestCase):
    def make(self, folder):
        from jarvis.config import load_config
        from jarvis.setup_wizard import SetupApi

        api = SetupApi.__new__(SetupApi)
        api._cfg = load_config()
        api._local_job = None
        api._local_line = ""
        api._local_error = ""
        import threading

        api._playing = threading.Lock()
        saved = []

        def save(section, key, value, extra=None):
            saved.append((section, key, value))
            api._cfg[section][key] = value
            return {"ok": True, "error": ""}

        api._save = save
        return api, saved

    def test_state_select_preview_and_all_local(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch("jarvis.setup_wizard.STATE_DIR", Path(folder)), \
                mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}):
            api, saved = self.make(folder)
            state = api.local_state()
            self.assertFalse(state["ready"], "noch keine Hörproben")
            for v in localvoice.VOICES:
                path = localvoice.preview_file(Path(folder) / "stimmen", v["id"])
                path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(path), "wb") as out:
                    out.setnchannels(1)
                    out.setsampwidth(2)
                    out.setframerate(24000)
                    out.writeframes(np.zeros(240, dtype=np.int16).tobytes())
            self.assertTrue(api.local_state()["ready"])
            self.assertTrue(api.local_select("charles")["ok"])
            self.assertEqual(saved[-2:], [("tts", "lokal_stimme", "charles"), ("tts", "engine", "lokal")])
            self.assertTrue(api.local_state()["active"])
            with mock.patch("jarvis.tts.Player") as player:
                self.assertTrue(api.local_preview("charles")["ok"])
            player.return_value.play.assert_called_once()
            self.assertTrue(api.local_all(True)["ok"])
            self.assertEqual(saved[-1], ("stt", "engine", "lokal"))
            self.assertTrue(api.local_state()["all_local"])
            self.assertTrue(api.local_all(False)["ok"])
            self.assertEqual(saved[-1], ("stt", "engine", "auto"))

    def test_install_runs_in_the_background(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch("jarvis.setup_wizard.STATE_DIR", Path(folder)), \
                mock.patch("jarvis.localvoice.installed", return_value={"tts": False, "stt": False}), \
                mock.patch("jarvis.localvoice.install", return_value=(False, "No matching distribution")):
            api, _ = self.make(folder)
            self.assertTrue(api.local_install()["ok"])
            api._local_job.join(5)
            state = api.local_state()
            self.assertFalse(state["busy"])
            self.assertIn("Installation ging nicht", state["error"])
            self.assertFalse(api.local_select("george")["ok"], "nicht installiert")


if __name__ == "__main__":
    unittest.main()
