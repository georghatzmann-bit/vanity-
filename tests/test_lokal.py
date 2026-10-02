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

    def __init__(self, voice="george", fail=False, still_loading=False, model="standard"):
        self.voice = voice
        self.model = model
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
                mock.patch("jarvis.localvoice.PocketVoice",
                           side_effect=lambda voice, model="standard": FakePocket(voice, fail=fail, still_loading=still_loading, model=model)):
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
        self.assertTrue(tts.used_main, "die gute Stimme, keine Reservestimme")
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

    def test_voice_comes_later_without_restart(self):
        """Fehlt die lokale Stimme beim Start, holt Jarvis sie nach (__main__.local_voice) und nimmt sie
        dann sofort dazu, ohne Neustart."""
        tts = self.make(installed=False)
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch("jarvis.localvoice.PocketVoice", side_effect=lambda voice, model="standard": FakePocket(voice, model=model)):
            self.assertTrue(tts.enable_local())
            self.assertTrue(tts.enable_local(), "zweimal schadet nicht")
        self.assertEqual(len(FakePocket.instances), 1)
        self.assertEqual(FakePocket.instances[0].voice, "charles", "die gewählte Stimme")
        audio, rate = tts.synthesize("Sehr wohl, Sir.")
        self.assertEqual(rate, 24000)
        self.assertTrue(tts.used_main)
        self.assertTrue(audio.done.wait(5))  # erst fertig speichern, dann den Ordner aufräumen

    def test_never_a_windows_or_microsoft_voice(self):
        """Georg: "komplett lokal, keine Windows-Stimme". Alte Einstellungen werden zu lokal, und geht
        gar keine lokale Stimme, schweigt Jarvis lieber (die Antwort steht im Fenster)."""
        from jarvis import tts as tts_module

        for old in ("edge", "windows", "", "quatsch"):
            self.assertEqual(self.make({"engine": old})._engine, "lokal", old)
        for name in ("synthesize_edge", "synthesize_windows", "_edge_mp3", "_com_ready"):
            self.assertFalse(hasattr(tts_module, name), name)
        problems = []
        tts = self.make(installed=False)
        tts._on_problem = problems.append
        with mock.patch.object(tts_module, "piper_voice", return_value=None):
            with self.assertRaises(RuntimeError):
                tts.synthesize("Hallo.")
        self.assertIn("im Fenster", problems[0])

    def test_piper_is_the_local_reserve(self):
        class FakePiper:
            def synthesize(self, text):
                return np.full(2205, 8000, np.int16), 22050

        from jarvis import tts as tts_module

        tts = self.make(installed=False)
        with mock.patch.object(tts_module, "piper_voice", return_value=FakePiper()):
            _samples, rate = tts.synthesize("Sehr wohl, Sir.")
        self.assertEqual(rate, 22050)
        self.assertFalse(tts.used_main)

    def test_warm_up_shortens_the_lead_on_fast_pcs(self):
        from jarvis.tts import local_buffer

        self.assertEqual(local_buffer(5.0), 0.25)
        self.assertEqual(local_buffer(2.0), 0.4)
        self.assertEqual(local_buffer(1.3), 0.6)
        self.assertEqual(local_buffer(0.8), 1.0, "langsamer PC: mehr Vorlauf, damit nichts stockt")
        tts = self.make()
        tts.warm_up()  # FakePocket rechnet sofort: sehr schnell
        self.assertEqual(tts.LOCAL_BUFFER_SECONDS, 0.25)
        self.assertEqual(type(tts).LOCAL_BUFFER_SECONDS, 0.6, "nur diese Stimme, nicht alle")

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


class ModelChoiceTest(unittest.TestCase):
    """Das große deutsche Modell (deutlicher, halb so schnell): auf schnellen PCs von selbst, einmal gemessen."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        patcher = mock.patch.object(localvoice, "pocket_version", return_value=(3, 3, 0))
        self.version = patcher.start()
        self.addCleanup(patcher.stop)

    def test_quality_setting(self):
        self.assertEqual([localvoice.quality(v) for v in ("", "auto", "Beste", "groß", "schnell", "Standard", "quatsch")],
                         ["auto", "auto", "beste", "beste", "schnell", "schnell", "auto"])

    def test_model_for(self):
        self.assertEqual(localvoice.model_for("auto", self.folder), "standard", "noch nicht gemessen")
        self.assertEqual(localvoice.model_for("beste", self.folder), "gross")
        self.assertEqual(localvoice.model_for("schnell", self.folder), "standard")
        localvoice.write_choice(self.folder, modell="gross", tempo_gross=1.9)
        self.assertEqual(localvoice.model_for("auto", self.folder), "gross")
        self.assertEqual(localvoice.model_for("schnell", self.folder), "standard", "Georgs Einstellung geht vor")
        self.version.return_value = (3, 2, 1)
        self.assertEqual(localvoice.model_for("beste", self.folder), "standard", "alte pocket-tts kennt es nicht")

    def test_other_pc_measures_again(self):
        localvoice.write_choice(self.folder, modell="gross")
        with mock.patch.object(localvoice, "_this_pc", return_value="Anderer Prozessor|4"):
            self.assertEqual(localvoice.model_for("auto", self.folder), "standard")
            self.assertTrue(localvoice.worth_measuring("auto", self.folder))

    def test_worth_measuring_only_once(self):
        self.assertTrue(localvoice.worth_measuring("auto", self.folder))
        self.assertFalse(localvoice.worth_measuring("beste", self.folder))
        self.assertFalse(localvoice.worth_measuring("auto", None))
        localvoice.write_choice(self.folder, fehler=localvoice.time.time())  # kein Internet
        self.assertFalse(localvoice.worth_measuring("auto", self.folder), "frühestens morgen wieder")
        localvoice.write_choice(self.folder, fehler=localvoice.time.time() - 2 * 86400)
        self.assertTrue(localvoice.worth_measuring("auto", self.folder))
        self.version.return_value = ()
        self.assertFalse(localvoice.worth_measuring("auto", self.folder), "pocket-tts fehlt oder ist alt")

    def test_slow_pc_stays_standard_for_good(self):
        self.assertTrue(localvoice.decide_from_standard(self.folder, 3.1))
        self.assertTrue(localvoice.worth_measuring("auto", self.folder), "noch nichts festgehalten")
        self.assertFalse(localvoice.decide_from_standard(self.folder, 1.7))
        self.assertEqual(localvoice.read_choice(self.folder)["modell"], "standard")
        self.assertFalse(localvoice.worth_measuring("auto", self.folder), "fragt nicht bei jedem Start neu")

    def test_big_model_falls_back(self):
        loaded = []

        class TTSModel:
            @staticmethod
            def load_model(language, quantize=False):
                loaded.append((language, quantize))
                if language == "german_24l":
                    raise RuntimeError("kein Internet")
                return "standardmodell"

        voice = localvoice.PocketVoice("george", "gross")
        self.assertEqual(voice._load_model(TTSModel), "standardmodell")
        self.assertEqual(loaded, [("german_24l", True), ("german_24l", False), ("german", False)])
        self.assertEqual(voice.model, "standard", "ehrlich: es spricht das Standardmodell")
        loaded.clear()
        TTSModel.load_model = staticmethod(lambda language, quantize=False: loaded.append((language, quantize)) or "x")
        voice = localvoice.PocketVoice("george", "gross")
        voice._load_model(TTSModel)
        self.assertEqual((loaded, voice.model), ([("german_24l", True)], "gross"))
        self.assertEqual(localvoice.PocketVoice("george", "quatsch").model, "standard")

    def test_measure_big_writes_choice_and_previews(self):
        class Model:
            def get_state_for_audio_prompt(self, voice):
                return voice

            def generate_audio(self, state, text):
                return np.zeros(2400, dtype=np.float32)

        class Fast(FakePocket):
            error = None
            _model = Model()

            def synthesize(self, text):
                return np.zeros(24000 * 3, dtype=np.int16), 24000  # 3 s Ton, sofort fertig

        with mock.patch.object(localvoice, "PocketVoice", lambda voice, model: Fast(voice, model=model)), \
                mock.patch("builtins.print"):
            self.assertEqual(localvoice._measure_big(self.folder), "gross")
        choice = localvoice.read_choice(self.folder)
        self.assertEqual(choice["modell"], "gross")
        self.assertGreater(choice["tempo_gross"], localvoice.BIG_MIN_SPEED)
        for item in localvoice.VOICES:
            self.assertTrue(localvoice.preview_file(self.folder, item["id"]).exists(), "Hörproben in der neuen Stimme")

        class Slow(Fast):
            def synthesize(self, text):
                localvoice.time.sleep(0.05)
                return np.zeros(2400, dtype=np.int16), 24000  # 0,1 s Ton in 0,05 s: nur doppelte Echtzeit ...

        with mock.patch.object(localvoice, "BIG_MIN_SPEED", 5.0), \
                mock.patch.object(localvoice, "PocketVoice", lambda voice, model: Slow(voice, model=model)), \
                mock.patch("builtins.print"):
            self.assertEqual(localvoice._measure_big(self.folder), "standard")  # ... zu langsam
        self.assertEqual(localvoice.read_choice(self.folder)["modell"], "standard")

    def test_measure_big_without_internet(self):
        class Broken(FakePocket):
            error = RuntimeError("kein Internet")

            def usable(self, wait=0.0):
                return False

        with mock.patch.object(localvoice, "PocketVoice", lambda voice, model: Broken(voice, model=model)), \
                mock.patch("builtins.print"):
            self.assertEqual(localvoice._measure_big(self.folder), "standard")
        choice = localvoice.read_choice(self.folder)
        self.assertNotIn("modell", choice)
        self.assertIn("kein Internet", choice["grund"])
        self.assertFalse(localvoice.worth_measuring("auto", self.folder), "nicht gleich nochmal")

    def make_tts(self, quality="auto"):
        from jarvis.tts import TextToSpeech

        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch("jarvis.localvoice.PocketVoice",
                           side_effect=lambda voice, model="standard": FakePocket(voice, model=model)):
            return TextToSpeech({"engine": "lokal", "lokal_qualitaet": quality}, self.folder)

    def test_tts_starts_with_the_measured_model(self):
        self.assertEqual(self.make_tts().local_model, "standard")
        localvoice.write_choice(self.folder, modell="gross")
        self.assertEqual(self.make_tts().local_model, "gross")
        self.assertEqual(self.make_tts("schnell").local_model, "standard")

    def test_improve_switches_without_restart(self):
        tts = self.make_tts()
        old_key = tts._cache_file("Sehr wohl, Sir.")

        def measured(folder, *args, **kwargs):
            localvoice.write_choice(folder, modell="gross", tempo_gross=1.8)
            return "gross"

        with mock.patch.object(localvoice, "speed_of", return_value=3.4), \
                mock.patch.object(localvoice, "measure", side_effect=measured) as measure, \
                mock.patch("jarvis.localvoice.PocketVoice",
                           side_effect=lambda voice, model="standard": FakePocket(voice, model=model)):
            self.assertTrue(tts.improve_local())
        measure.assert_called_once()
        self.assertEqual(tts.local_model, "gross")
        self.assertNotEqual(tts._cache_file("Sehr wohl, Sir."), old_key, "alte Sätze nicht in der neuen Stimme ausgeben")
        self.assertFalse(tts.improve_local(), "schon das große")

    def test_improve_waits_for_a_quiet_moment_and_respects_slow_pcs(self):
        tts = self.make_tts()
        with mock.patch.object(localvoice, "measure") as measure:
            self.assertIsNone(tts.improve_local(idle=lambda: False), "gerade ein Spiel: später")
            with mock.patch.object(localvoice, "speed_of", return_value=1.9):
                self.assertFalse(tts.improve_local())
        measure.assert_not_called()
        self.assertEqual(localvoice.read_choice(self.folder)["modell"], "standard")
        self.assertFalse(tts.improve_local(), "kein zweites Mal")
        self.assertEqual(tts.local_model, "standard")

    def test_standard_cache_keys_stay_valid(self):
        """Wer bleibt, wie er ist, behält seine fertigen Sätze (Schlüssel wie bisher)."""
        import hashlib

        tts = self.make_tts()
        expected = hashlib.sha1("lokal|george|Sehr wohl, Sir.".encode()).hexdigest()[:24] + ".npz"
        self.assertEqual(tts._cache_file("Sehr wohl, Sir.").name, expected)


class RecognitionTest(unittest.TestCase):
    def test_local_engine_prefers_parakeet(self):
        from jarvis import stt

        cfg = {"engine": "lokal", "model": "small", "language": "de"}
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch("jarvis.localvoice.ParakeetSpeechToText", return_value="parakeet") as parakeet, \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(cfg)._current(), "parakeet")
            parakeet.assert_called_once()
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": False, "stt": False}), \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(cfg)._current(), "whisper")
        with mock.patch("jarvis.localvoice.installed", return_value={"tts": True, "stt": True}), \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            self.assertEqual(stt.make_transcriber(dict(cfg, lokal_modell="whisper"))._current(), "whisper")

    def test_local_is_the_default_and_parakeet_comes_later(self):
        """Ohne Angabe erkennt Jarvis auf dem PC (auch mit Groq-Schlüssel). Fehlt Parakeet erst und kommt
        dann dazu, wechselt die Erkennung von selbst."""
        from jarvis import stt

        have = {"stt": False}
        with mock.patch("jarvis.localvoice.installed", side_effect=lambda: {"tts": have["stt"], "stt": have["stt"]}), \
                mock.patch("jarvis.localvoice.ParakeetSpeechToText", return_value="parakeet"), \
                mock.patch.object(stt, "SpeechToText", return_value="whisper"):
            local = stt.make_transcriber({"model": "small", "language": "de", "groq_key": "gsk_x"})
            self.assertIsInstance(local, stt.LocalSpeechToText)
            self.assertEqual(local._current(), "whisper")
            have["stt"] = True
            self.assertEqual(local._current(), "whisper", "prüft nur ab und zu")
            local._checked_at -= stt.LocalSpeechToText.CHECK_EVERY
            self.assertEqual(local._current(), "parakeet")

    def test_warm_up_runs_the_model_once(self):
        from jarvis import stt

        heard = []
        model = types.SimpleNamespace(transcribe=lambda audio: heard.append(audio.size) or "")
        local = stt.LocalSpeechToText(lambda: model, lambda: None)
        local.warm_up()
        self.assertEqual(heard, [16000])

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
        self.assertIn("pocket-tts>=3.3.0", cmd, "erst ab 3.3 gibt es das große deutsche Modell")
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
