"""Handy-App: Antworten in Jarvis' Stimme, Sprechtaste, sicher von überall (Tailscale)."""

import io
import json
import unittest
import urllib.error
import urllib.request
import wave
from unittest import mock

import numpy as np

import tests.helpers  # noqa: F401
from jarvis import tailscale
from jarvis.remote import PhoneUi
from jarvis.server import CommandServer

TOKEN = "handy-schluessel-123456"


class FakeAssistant:
    busy = False
    gaming = False
    mute = None
    workshop = None

    def __init__(self):
        self.submitted = []
        self.spoken = []
        self.heard = []

    def submit(self, text, speak=True):
        self.submitted.append((text, speak))

    def speech_wav(self, text):
        self.spoken.append(text)
        return b"RIFF....WAVEfake"

    def hear(self, data):
        self.heard.append(data)
        return "Öffne Discord" if data.startswith(b"rede") else ""


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.assistant = FakeAssistant()
        self.server = CommandServer({"token": TOKEN, "host": "127.0.0.1", "port": 0}, self.assistant, phone=PhoneUi())
        self.server.start()
        self.addCleanup(self.server.stop)
        self.base = f"http://127.0.0.1:{self.server.port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def post(self, path, body: bytes, kind="application/json", token=TOKEN):
        req = urllib.request.Request(self.base + path, data=body, method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": kind})
        try:
            with self.opener.open(req, timeout=5) as response:
                return response.status, response.headers.get("Content-Type", ""), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, "", exc.read()

    def test_answer_in_jarvis_voice(self):
        code, kind, body = self.post("/api/sprich", json.dumps({"text": "Sehr wohl, Sir."}).encode())
        self.assertEqual((code, kind, body), (200, "audio/wav", b"RIFF....WAVEfake"))
        self.assertEqual(self.assistant.spoken, ["Sehr wohl, Sir."])
        self.assertEqual(self.post("/api/sprich", b'{"text": ""}')[0], 400)
        self.assertEqual(self.post("/api/sprich", b'{"text": "x"}', token="falsch-falsch-falsch")[0], 401)

    def test_talk_button(self):
        code, _, body = self.post("/api/hoeren?sprechen=0", b"rede mit mir", kind="audio/webm")
        self.assertEqual((code, json.loads(body)), (200, {"ok": True, "text": "Öffne Discord"}))
        self.assertEqual(self.assistant.submitted, [("Öffne Discord", False)])
        code, _, body = self.post("/api/hoeren", b"rauschen", kind="audio/mp4")
        self.assertEqual(json.loads(body), {"ok": True, "text": ""}, "nichts verstanden: kein Befehl")
        self.assertEqual(len(self.assistant.submitted), 1)
        self.assertEqual(self.post("/api/hoeren", b"", kind="audio/webm")[0], 400)

    def test_service_worker_is_served(self):
        req = urllib.request.Request(self.base + "/app/sw.js")
        with self.opener.open(req, timeout=5) as response:
            self.assertIn("javascript", response.headers.get("Content-Type", ""))


class AssistantVoiceTest(unittest.TestCase):
    def test_speech_wav_and_hear(self):
        from tests.test_assistant import FakeBrain, make

        assistant, _, _, _ = make(FakeBrain())
        tts = mock.Mock()
        tts.synthesize.return_value = (np.ones(2400, dtype=np.int16) * 300, 24000)
        assistant.tts = tts
        data = assistant.speech_wav("**Sehr wohl**, Sir.")
        tts.synthesize.assert_called_once_with("Sehr wohl, Sir.")
        with wave.open(io.BytesIO(data)) as wav:
            self.assertEqual((wav.getframerate(), wav.getnframes()), (24000, 2400))
        transcriber = mock.Mock()
        transcriber.transcribe.return_value = " Öffne Spotify "
        assistant.transcriber = transcriber
        silence = io.BytesIO()
        with wave.open(silence, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes((np.ones(16000, dtype=np.int16) * 1000).tobytes())
        with mock.patch.dict("sys.modules", {"faster_whisper": mock.Mock(
                decode_audio=lambda f, sampling_rate: np.frombuffer(f.getvalue()[44:], dtype=np.int16).astype(np.float32) / 32768)}):
            self.assertEqual(assistant.hear(silence.getvalue()), "Öffne Spotify")
            self.assertEqual(assistant.hear(silence.getvalue()[:44 + 2000]), "", "zu kurz")


class TailscaleTest(unittest.TestCase):
    STATUS = json.dumps({"BackendState": "Running", "Self": {"DNSName": "georgs-pc.tail1234.ts.net."}})

    def run_with(self, outputs):
        calls = []

        def fake(cmd, **kwargs):
            calls.append(cmd[1:])
            code, out = outputs.pop(0)
            return mock.Mock(returncode=code, stdout=out, stderr="")

        with mock.patch("jarvis.tailscale.subprocess.run", side_effect=fake):
            return calls

    def test_serve_gives_the_https_address(self):
        calls = []

        def fake(cmd, **kwargs):
            calls.append(cmd[1:])
            out = self.STATUS if cmd[1] == "status" else "Available within your tailnet: https://georgs-pc.tail1234.ts.net/"
            return mock.Mock(returncode=0, stdout=out, stderr="")

        with mock.patch("jarvis.tailscale.subprocess.run", side_effect=fake):
            result = tailscale.serve(8765, exe="tailscale")
        self.assertEqual(result, {"ok": True, "url": "https://georgs-pc.tail1234.ts.net/", "enable_url": "", "error": ""})
        self.assertIn(["serve", "--bg", "--https=443", "http://127.0.0.1:8765"], calls)

    def test_https_must_be_allowed_first(self):
        def fake(cmd, **kwargs):
            if cmd[1] == "status":
                return mock.Mock(returncode=0, stdout=self.STATUS, stderr="")
            return mock.Mock(returncode=1, stdout="", stderr="Serve is not enabled on your tailnet.\nTo enable, visit:\n\n"
                             "         https://login.tailscale.com/f/serve?node=abc123\n")

        with mock.patch("jarvis.tailscale.subprocess.run", side_effect=fake):
            result = tailscale.serve(8765, exe="tailscale")
        self.assertFalse(result["ok"])
        self.assertEqual(result["enable_url"], "https://login.tailscale.com/f/serve?node=abc123")

    def test_not_installed_or_logged_out(self):
        self.assertFalse(tailscale.status(exe="")["installed"])
        logged_out = json.dumps({"BackendState": "NeedsLogin", "Self": {"DNSName": ""}})
        with mock.patch("jarvis.tailscale.subprocess.run", return_value=mock.Mock(returncode=0, stdout=logged_out, stderr="")):
            info = tailscale.status(exe="tailscale")
        self.assertEqual((info["installed"], info["running"]), (True, False))
        self.assertIn("anmelden", info["error"])

    def test_window_uses_the_secure_address_for_the_qr_code(self):
        from jarvis.gui.app import Api

        api = Api.__new__(Api)
        api._assistant = mock.Mock(_cfg={"server": {"enabled": True, "token": TOKEN, "port": 8765,
                                                    "https": "https://georgs-pc.tail1234.ts.net/"}}, server=None)
        with mock.patch("jarvis.remote.local_ip", return_value="192.168.1.20"), \
                mock.patch("jarvis.remote.mac_address", return_value=""):
            info = api.phone_info()
        self.assertEqual(info["url"], f"https://georgs-pc.tail1234.ts.net/app/#t={TOKEN}")
        self.assertEqual(info["lan_url"], f"http://192.168.1.20:8765/app/#t={TOKEN}")
        self.assertTrue(info["secure"])


if __name__ == "__main__":
    unittest.main()
