"""Handy-App: Antworten in Jarvis' Stimme, Sprechtaste, sicher von überall (Tailscale)."""

import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

import tests.helpers  # noqa: F401
from jarvis import tailscale
from jarvis.remote import PhoneUi
from jarvis.server import CommandServer

TOKEN = "handy-schluessel-123456"
posix_only = unittest.skipIf(sys.platform == "win32", "Test-Starter ist ein Shell-Skript")

# Wie das echte tailscale: status --json, serve (gleich fertig, wartet auf die Freigabe von HTTPS, Fehler, hängt)
FAKE_TAILSCALE = r"""
import json, os, sys, time
args = sys.argv[1:]
with open(os.environ["FAKE_TS_CALLS"], "a", encoding="utf-8") as f:
    f.write(" ".join(args) + "\n")
mode = os.environ.get("FAKE_TS", "ok")
if args[:1] == ["status"]:
    print(json.dumps({"BackendState": "Running", "Self": {"DNSName": "georgs-pc.tail1234.ts.net."}}))
    sys.exit(0)
if args[:1] == ["serve"] and "off" in args:
    sys.exit(0)
if mode == "ok":
    print("Available within your tailnet:\n\nhttps://georgs-pc.tail1234.ts.net/\n|-- proxy http://127.0.0.1:8765", flush=True)
    sys.exit(0)
if mode == "freigabe":
    print("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n", flush=True)
    while not os.path.exists(os.environ["FAKE_TS_FLAG"]):
        time.sleep(0.05)
    print("Success.", flush=True)
    sys.exit(0)
if mode == "fehler":
    print("error: serve config denied", flush=True)
    sys.exit(1)
time.sleep(30)
"""


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

    def fake_tailscale(self, mode):
        """Ein nachgebautes tailscale(.exe): status --json und serve wie das echte (posix: Shell-Starter)."""
        folder = Path(self.enterContext(TemporaryDirectory()))
        script = folder / "fake_tailscale.py"
        script.write_text(FAKE_TAILSCALE, encoding="utf-8")
        launcher = folder / "tailscale"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        launcher.chmod(0o755)
        self.flag = folder / "erlaubt"
        self.calls = folder / "aufrufe.txt"
        self.enterContext(mock.patch.dict(os.environ, {"FAKE_TS": mode, "FAKE_TS_FLAG": str(self.flag),
                                                         "FAKE_TS_CALLS": str(self.calls)}))
        self.addCleanup(tailscale.stop, str(launcher))  # wartet ein serve noch: beenden
        return str(launcher)

    @posix_only
    def test_serve_gives_the_https_address(self):
        exe = self.fake_tailscale("ok")
        result = tailscale.serve(8765, exe=exe)
        self.assertEqual(result, {"ok": True, "url": "https://georgs-pc.tail1234.ts.net/", "enable_url": "",
                                  "pending": False, "error": ""})
        self.assertIn("serve --bg --https=443 http://127.0.0.1:8765", self.calls.read_text(encoding="utf-8"))

    @posix_only
    def test_waits_for_the_approval_and_switches_on_by_itself(self):
        """Georgs Fehler: "tailscale serve ... timed out after 40 seconds". Tailscale wartet, bis HTTPS im Konto
        erlaubt ist, und gibt dafür einen Link aus. Der kommt jetzt sofort, und danach geht es von selbst."""
        exe = self.fake_tailscale("freigabe")
        done = []
        finished = threading.Event()
        started = time.monotonic()
        result = tailscale.serve(8765, exe=exe, on_done=lambda r: (done.append(r), finished.set()))
        self.assertLess(time.monotonic() - started, 5, "nicht erst nach 40 Sekunden")
        self.assertEqual((result["ok"], result["pending"]), (False, True))
        self.assertEqual(result["enable_url"], "https://login.tailscale.com/f/serve?node=abc123")
        self.assertIn("erlauben", result["error"])
        again = tailscale.serve(8765, exe=exe)
        self.assertEqual((again["pending"], again["enable_url"]), (True, result["enable_url"]), "kein zweites Warten")
        self.flag.write_text("ja")  # Georg klickt im Browser auf "Enable"
        self.assertTrue(finished.wait(10))
        self.assertEqual(done, [{"ok": True, "url": "https://georgs-pc.tail1234.ts.net/", "enable_url": "",
                                 "pending": False, "error": ""}])

    @posix_only
    def test_errors_and_no_answer_are_reported(self):
        exe = self.fake_tailscale("fehler")
        self.assertEqual(tailscale.serve(8765, exe=exe)["error"], "error: serve config denied")
        exe = self.fake_tailscale("haengt")
        started = time.monotonic()
        result = tailscale.serve(8765, exe=exe, wait=1.0)
        self.assertLess(time.monotonic() - started, 5)
        self.assertFalse(result["ok"])
        self.assertIn("antwortet nicht", result["error"])

    @posix_only
    def test_switching_off_ends_the_waiting(self):
        exe = self.fake_tailscale("freigabe")
        done = []
        finished = threading.Event()
        result = tailscale.serve(8765, exe=exe, on_done=lambda r: (done.append(r), finished.set()))
        self.assertTrue(result["pending"])
        self.assertTrue(tailscale.stop(exe))
        self.assertTrue(finished.wait(10))
        self.assertFalse(done[0]["ok"])
        self.assertIn("serve --https=443 off", self.calls.read_text(encoding="utf-8"))

    def test_window_opens_the_approval_page_and_saves_the_address_later(self):
        from jarvis.gui.app import Api, GuiBridge

        api = Api(GuiBridge(), mock.Mock(_cfg={"server": {"port": 8765}}, server=None), mute=None)
        waiting = {"ok": False, "url": "", "enable_url": "https://login.tailscale.com/f/serve?node=abc123",
                   "pending": True, "error": tailscale.WAITING}
        with mock.patch("jarvis.tailscale.serve", return_value=waiting) as serve, \
                mock.patch("jarvis.pc.open_uri") as opened, mock.patch("jarvis.config.save_setting") as saved:
            self.assertTrue(api.tailscale_enable(True)["pending"])
            opened.assert_called_once_with("https://login.tailscale.com/f/serve?node=abc123")
            saved.assert_not_called()
            serve.call_args.kwargs["on_done"]({"ok": True, "url": "https://georgs-pc.tail1234.ts.net/",
                                               "enable_url": "", "pending": False, "error": ""})
            saved.assert_called_once_with("server", "https", "https://georgs-pc.tail1234.ts.net/")
        self.assertEqual(api._assistant._cfg["server"]["https"], "https://georgs-pc.tail1234.ts.net/")
        self.assertIn("Sicher von überall ist an", json.dumps(api.poll(), ensure_ascii=False))

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
