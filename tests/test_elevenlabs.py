"""ElevenLabs-Stimmen gegen einen kleinen Nachbau des Servers."""

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

import tests.helpers  # noqa: F401
from jarvis.elevenlabs import ElevenLabs, ElevenLabsError, pick_default_voice, usable_on_plan
from jarvis.tts import StreamingAudio, TextToSpeech, materialize


def tone(seconds=0.6, rate=24000, quiet_tail=0.5):
    t = np.arange(int(seconds * rate)) / rate
    loud = (np.sin(2 * np.pi * 220 * t) * 8000).astype(np.int16)
    return np.concatenate([np.zeros(int(0.1 * rate), np.int16), loud, np.zeros(int(quiet_tail * rate), np.int16)])


class FakeElevenLabs:
    def __init__(self):
        self.requests = []
        self.speech_error = None  # (code, body)
        self.model_error_for = set()
        self.tier = "starter"
        # Aus der Bibliothek übernommene Stimmen: mit Gratis-Konto verweigert der Server sie
        self.library_voices = []
        self.audio = tone().tobytes()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _json(self, code, payload):
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                outer.requests.append(("GET", self.path, self.headers.get("xi-api-key"), None))
                if self.headers.get("xi-api-key") != "sk_test":
                    return self._json(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}})
                if self.path.startswith("/v2/voices"):
                    return self._json(200, {"voices": [
                        {"voice_id": "v_rachel", "name": "Rachel", "labels": {"gender": "female", "accent": "american"},
                         "preview_url": "https://x/rachel.mp3", "category": "premade"},
                        {"voice_id": "v_george", "name": "George - Warm, Captivating Storyteller",
                         "labels": {"gender": "male", "accent": "british"}, "preview_url": "https://x/george.mp3",
                         "category": "premade"},
                    ] + [
                        {"voice_id": voice_id, "name": name, "labels": {"gender": "male", "accent": "german"},
                         "category": "professional", "sharing": {"status": "copied", "public_owner_id": "owner1"}}
                        for voice_id, name in outer.library_voices
                    ]})
                if self.path.startswith("/v1/shared-voices"):
                    return self._json(200, {"voices": [
                        {"public_owner_id": "owner1", "voice_id": "v_lib", "name": "Otto", "gender": "male",
                         "accent": "standard", "language": "de", "preview_url": "https://x/otto.mp3"},
                    ]})
                if self.path == "/v1/user/subscription":
                    limit = 10000 if outer.tier == "free" else 30000
                    return self._json(200, {"tier": outer.tier, "character_count": 1200, "character_limit": limit})
                self._json(404, {"detail": "nicht gefunden"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                outer.requests.append(("POST", self.path, self.headers.get("xi-api-key"), body))
                if self.path.startswith("/v1/voices/add/"):
                    return self._json(200, {"voice_id": "v_lib_added"})
                if "/stream" in self.path:
                    voice_id = self.path.split("/")[3]
                    if outer.tier == "free" and voice_id in {v for v, _ in outer.library_voices}:
                        return self._json(402, {"detail": {
                            "type": "payment_required", "code": "paid_plan_required",
                            "message": "Free users cannot use library voices via the API. Please upgrade."}})
                    if outer.speech_error:
                        code, payload = outer.speech_error
                        return self._json(code, payload)
                    if body.get("model_id") in outer.model_error_for:
                        return self._json(400, {"detail": {"status": "model_not_supported",
                                                           "message": "This model is not available for your plan"}})
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/pcm")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    data = outer.audio
                    for i in range(0, len(data), 4801):  # ungerade Stücke: Samples werden geteilt
                        part = data[i:i + 4801]
                        self.wfile.write(f"{len(part):X}\r\n".encode() + part + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    return
                self._json(404, {"detail": "nicht gefunden"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()


class ElevenLabsClientTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeElevenLabs()
        self.api = ElevenLabs("sk_test", base=self.fake.url, timeout=5)

    def tearDown(self):
        self.fake.stop()

    def test_voices_and_default(self):
        voices = self.api.voices()
        self.assertEqual([v["name"] for v in voices], ["Rachel", "George"])
        self.assertEqual(pick_default_voice(voices)["voice_id"], "v_george")
        self.assertEqual(voices[1]["accent"], "british")

    def test_library_and_adding_a_voice(self):
        lib = self.api.library(gender="male")
        self.assertEqual(lib[0]["name"], "Otto")
        self.assertTrue(lib[0]["library"])
        self.assertIn("language=de", self.fake.requests[-1][1])
        self.assertIn("gender=male", self.fake.requests[-1][1])
        self.assertEqual(self.api.add_shared("owner1", "v_lib", "Otto"), "v_lib_added")
        self.assertEqual(self.fake.requests[-1][3], {"new_name": "Otto"})

    def test_subscription(self):
        self.assertEqual(self.api.subscription(), {"tier": "starter", "used": 1200, "limit": 30000})

    def test_stream_delivers_all_pcm(self):
        pcm = self.api.speak("Guten Tag, Sir.", "v_george", "eleven_flash_v2_5", previous_text="Vorher.")
        self.assertEqual(pcm, self.fake.audio)
        method, path, key, body = self.fake.requests[-1]
        self.assertEqual(path, "/v1/text-to-speech/v_george/stream?output_format=pcm_24000")
        self.assertEqual(key, "sk_test")
        self.assertEqual(body["language_code"], "de")  # nur bei Flash/Turbo 2.5
        self.assertEqual(body["previous_text"], "Vorher.")
        self.api.speak("Hallo.", "v_george", "eleven_v4_turbo")
        self.assertNotIn("language_code", self.fake.requests[-1][3])

    def test_errors_are_sorted(self):
        cases = [
            ((401, {"detail": {"status": "invalid_api_key", "message": "Invalid"}}), "key"),
            ((401, {"detail": {"status": "quota_exceeded", "message": "This request exceeds your quota"}}), "quota"),
            ((402, {"detail": {"status": "payment_required", "message": "Payment required"}}), "quota"),
            ((402, {"detail": {"type": "payment_required", "code": "paid_plan_required",
                               "message": "Free users cannot use library voices via the API. Please upgrade."}}), "plan"),
            ((400, {"detail": {"type": "invalid_request", "code": "bad_request",
                               "message": "You need to be on the creator tier or above to use this voice."}}), "plan"),
            ((400, {"detail": {"status": "quota_exceeded", "message": "You have 0 credits remaining"}}), "quota"),
            ((404, {"detail": {"status": "voice_not_found", "message": "Voice not found"}}), "voice"),
            ((429, {"detail": {"status": "too_many_concurrent_requests", "message": "Busy"}}), "busy"),
            ((422, {"detail": [{"loc": ["body", "language_code"], "msg": "not supported"}]}), "param"),
        ]
        for reply, kind in cases:
            with self.subTest(kind=kind, reply=reply):
                self.fake.speech_error = reply
                with self.assertRaises(ElevenLabsError) as ctx:
                    self.api.speak("Hallo.", "v_george")
                self.assertEqual(ctx.exception.kind, kind)

    def test_library_voices_are_marked_and_skipped_on_the_free_plan(self):
        self.fake.library_voices = [("v_daniel_lib", "Daniel - Corporate Narration")]
        voices = self.api.voices()
        self.assertEqual([v["from_library"] for v in voices], [False, False, True])
        library_daniel = voices[2]
        self.assertFalse(usable_on_plan(library_daniel, "free"))
        self.assertTrue(usable_on_plan(library_daniel, "starter"))
        self.assertTrue(usable_on_plan(voices[1], "free"))
        # Gratis-Konto: nie eine Bibliotheks-Stimme vorschlagen, auch wenn sie "Daniel" heißt
        only_library = [library_daniel]
        self.assertIsNone(pick_default_voice(only_library, free=True))
        self.assertEqual(pick_default_voice(only_library)["voice_id"], "v_daniel_lib")
        self.assertEqual(pick_default_voice(voices, free=True)["voice_id"], "v_george")

    def test_wrong_key(self):
        with self.assertRaises(ElevenLabsError) as ctx:
            ElevenLabs("falsch", base=self.fake.url).voices()
        self.assertEqual(ctx.exception.kind, "key")

    def test_no_network(self):
        with self.assertRaises(ElevenLabsError) as ctx:
            ElevenLabs("sk_test", base="http://127.0.0.1:9", timeout=2).voices()
        self.assertEqual(ctx.exception.kind, "net")


class StreamingAudioTest(unittest.TestCase):
    def test_grows_and_trims_the_tail(self):
        audio = StreamingAudio(24000)
        samples = tone(quiet_tail=0.8)
        raw = samples.tobytes()
        audio.feed(raw[:1001])  # halbes Sample am Ende
        self.assertFalse(audio.ready.is_set())
        self.assertEqual(audio.available(), 500)
        audio.feed(raw[1001:20000])
        self.assertTrue(audio.ready.is_set())
        self.assertFalse(audio.complete())
        audio.feed(raw[20000:])
        audio.finish()
        self.assertTrue(audio.complete())
        # hinten bleiben nur etwa 0,18 s Stille
        self.assertLess(audio.available(), len(samples) - int(0.5 * 24000))
        self.assertEqual(audio.read(0, 10).dtype, np.int16)
        # vorn beginnt das Abspielen kurz vor dem ersten Ton
        self.assertAlmostEqual(audio.first_sound(), int(0.05 * 24000), delta=200)

    def test_materialize_waits_for_the_end(self):
        audio = StreamingAudio(24000)

        def later():
            time.sleep(0.1)
            audio.feed(tone().tobytes())
            audio.finish()

        threading.Thread(target=later).start()
        out = materialize(audio)
        self.assertGreater(out.size, 10000)


class ElevenLabsVoiceTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeElevenLabs()
        self.folder = TemporaryDirectory()
        self.problems = []
        cfg = {"engine": "elevenlabs", "voice": "de-DE-ConradNeural", "elevenlabs_key": "sk_test",
               "elevenlabs_voice": "v_george", "elevenlabs_model": "eleven_v4_turbo"}
        self.tts = TextToSpeech(cfg, self.folder.name, on_problem=self.problems.append)
        self.tts._eleven.base = self.fake.url

    def tearDown(self):
        self.fake.stop()
        self.folder.cleanup()

    def test_speaks_with_elevenlabs_and_caches_short_phrases(self):
        audio, rate = self.tts.synthesize("Sehr wohl, Sir.")
        self.assertIsInstance(audio, StreamingAudio)
        self.assertEqual(rate, 24000)
        materialize(audio)
        time.sleep(0.05)
        cached, rate2 = self.tts.synthesize("Sehr wohl, Sir.")
        self.assertIsInstance(cached, np.ndarray, "beim zweiten Mal aus dem Zwischenspeicher")
        self.assertEqual(len([r for r in self.fake.requests if "/stream" in r[1]]), 1)
        # Der vorige Satz geht als Zusammenhang mit
        self.tts.synthesize("Noch ein ganz anderer, längerer Satz, der nicht in den Zwischenspeicher passt, weil er lang ist.")
        self.assertEqual(self.fake.requests[-1][3]["previous_text"], "Sehr wohl, Sir.")

    def test_unavailable_model_falls_back_to_flash(self):
        self.fake.model_error_for = {"eleven_v4_turbo"}
        audio, _ = self.tts.synthesize("Ein Test mit dem Ersatzmodell.")
        self.assertIsInstance(audio, StreamingAudio)
        models = [r[3]["model_id"] for r in self.fake.requests if "/stream" in r[1]]
        self.assertEqual(models, ["eleven_v4_turbo", "eleven_flash_v2_5"])
        self.tts.synthesize("Und noch einer.")
        self.assertEqual(self.fake.requests[-1][3]["model_id"], "eleven_flash_v2_5")

    def test_empty_balance_switches_to_microsoft_and_tells_once(self):
        self.fake.speech_error = (401, {"detail": {"status": "quota_exceeded", "message": "quota exceeded"}})
        with mock.patch("jarvis.tts.synthesize_edge", return_value=(tone(), 24000)) as edge:
            samples, rate = self.tts.synthesize("Ein Satz.")
            self.tts.synthesize("Noch ein Satz.")
        self.assertIsInstance(samples, np.ndarray)
        self.assertEqual(edge.call_count, 2)
        self.assertEqual(len([r for r in self.fake.requests if "/stream" in r[1]]), 1, "danach erst einmal Pause")
        self.assertEqual(len(self.problems), 1)
        self.assertIn("Guthaben", self.problems[0])

    def test_library_voice_on_free_plan_speaks_microsoft_and_explains_once(self):
        self.fake.tier = "free"
        self.fake.library_voices = [("v_lennard", "Lennard - Warm & Trustworthy")]
        self.tts._eleven_voice = "v_lennard"
        with mock.patch("jarvis.tts.synthesize_edge", return_value=(tone(), 24000)) as edge:
            samples, _ = self.tts.synthesize("Ein Satz.")
            self.tts.synthesize("Noch ein Satz.")
        self.assertIsInstance(samples, np.ndarray)
        self.assertEqual(edge.call_count, 2)
        self.assertEqual(len([r for r in self.fake.requests if "/stream" in r[1]]), 1, "danach erst einmal Pause")
        self.assertEqual(len(self.problems), 1)
        self.assertIn("nur mit Abo", self.problems[0])
        self.assertNotIn("Guthaben", self.problems[0])

    def test_without_voice_or_key_it_is_plain_microsoft(self):
        tts = TextToSpeech({"engine": "elevenlabs", "elevenlabs_key": "sk_test"}, None)
        self.assertIsNone(tts._eleven)
        with mock.patch("jarvis.tts.synthesize_edge", return_value=(tone(), 24000)) as edge:
            tts.synthesize("Hallo.")
        edge.assert_called_once()


if __name__ == "__main__":
    unittest.main()
