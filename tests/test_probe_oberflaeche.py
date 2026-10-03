"""Die Fenster-Probe des Windows-Builds (installer/probe_oberflaeche.py): WebSocket und DevTools-Protokoll
ohne fremde Pakete. Läuft sie nur auf Windows schief, merkt man es erst im Build, deshalb hier mit einem
kleinen DevTools-Server: große und geteilte Frames, Ping, nachgereichte Skriptfehler."""

import base64
import hashlib
import importlib.util
import json
import socket
import struct
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("probe_oberflaeche", ROOT / "installer" / "probe_oberflaeche.py")
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

LOAD_ERROR = {
    "method": "Runtime.exceptionThrown",
    "params": {"exceptionDetails": {
        "text": "Uncaught", "url": "http://127.0.0.1:8899/zentrale.js", "lineNumber": 41,
        "exception": {"description": "TypeError: el.ticker is null\n    at renderNews (zentrale.js:42:7)"},
    }},
}


class FakeDevTools:
    """Ein winziger DevTools-Server mit einer Seite."""

    def __init__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.received = []
        self.pongs = 0
        self.headers = b""
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def close(self):
        self.server.close()
        self.thread.join(timeout=5)

    @staticmethod
    def _exact(conn, count):
        data = b""
        while len(data) < count:
            chunk = conn.recv(count - len(data))
            if not chunk:
                raise ConnectionError
            data += chunk
        return data

    def _read(self, conn):
        while True:
            b1, b2 = self._exact(conn, 2)
            assert b2 & 0x80, "ein Client muss maskieren"
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(conn, 2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(conn, 8))[0]
            mask = self._exact(conn, 4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._exact(conn, n)))
            opcode = b1 & 0x0F
            if opcode == 0xA:
                self.pongs += 1
                continue
            if opcode == 0x8:
                return None
            return payload.decode("utf-8")

    @staticmethod
    def _frame(payload, opcode, fin=True):
        n = len(payload)
        head = bytes([(0x80 if fin else 0) | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        return head + payload

    def _send(self, conn, message, split=False, ping=False):
        data = json.dumps(message).encode("utf-8")
        if ping:
            conn.sendall(self._frame(b"da?", 0x9))
        if split:
            half = len(data) // 2
            conn.sendall(self._frame(data[:half], 0x1, fin=False) + self._frame(data[half:], 0x0))
        else:
            conn.sendall(self._frame(data, 0x1))

    def _serve(self):
        try:
            conn, _ = self.server.accept()
        except OSError:
            return
        with conn:
            while b"\r\n\r\n" not in self.headers:
                self.headers += conn.recv(1024)
            key = next(line.split(b":", 1)[1].strip() for line in self.headers.split(b"\r\n")
                       if line.lower().startswith(b"sec-websocket-key"))
            accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            while True:
                try:
                    text = self._read(conn)
                except (ConnectionError, OSError):
                    return
                if text is None:
                    return
                request = json.loads(text)
                self.received.append(request)
                method, params = request["method"], request.get("params") or {}
                if method == "Runtime.enable":
                    self._send(conn, LOAD_ERROR)  # beim Laden passiert, kommt mit dem Einschalten
                    self._send(conn, {"id": request["id"], "result": {}})
                elif method == "Runtime.evaluate" and params["expression"] == "kaputt()":
                    self._send(conn, {"id": request["id"], "result": {
                        "result": {"type": "object"},
                        "exceptionDetails": {"text": "Uncaught", "exception": {"description": "ReferenceError: kaputt is not defined"}},
                    }})
                elif method == "Runtime.evaluate":
                    self._send(conn, {"method": "Runtime.consoleAPICalled",
                                      "params": {"type": "error", "args": [{"type": "string", "value": "hls.js: Zugriff verweigert"}]}})
                    value = {"echo": params["expression"], "gross": "x" * 70000}  # über 65535 Byte: Länge mit 8 Byte
                    self._send(conn, {"id": request["id"], "result": {"result": {"type": "object", "value": value}}},
                               split=True, ping=True)
                else:
                    self._send(conn, {"id": request["id"], "error": {"message": f"'{method}' wasn't found"}})


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.devtools = FakeDevTools()
        self.ws = probe.WebSocket(f"ws://127.0.0.1:{self.devtools.port}/devtools/page/1")
        self.tools = probe.DevTools(self.ws)

    def tearDown(self):
        self.ws.close()
        self.devtools.close()

    def test_errors_from_loading_large_split_frames_and_ping(self):
        self.tools.call("Runtime.enable")
        value = self.tools.evaluate("document.title")
        self.assertEqual(value["echo"], "document.title")
        self.assertEqual(len(value["gross"]), 70000)
        self.assertEqual(probe.errors(self.tools.events), ["TypeError: el.ticker is null (zentrale.js:42)"])
        self.assertEqual(probe.console_errors(self.tools.events), ["hls.js: Zugriff verweigert"])
        deadline = time.monotonic() + 5
        while self.devtools.pongs < 1 and time.monotonic() < deadline:
            time.sleep(0.01)  # der Server liest das Pong erst nach seiner Antwort
        self.assertEqual(self.devtools.pongs, 1, "auf Ping kommt Pong")
        self.assertNotIn(b"origin:", self.devtools.headers.lower(), "ohne Origin braucht Chromium kein --remote-allow-origins")

    def test_script_errors_and_unknown_methods_are_reported(self):
        with self.assertRaises(RuntimeError) as caught:
            self.tools.evaluate("kaputt()")
        self.assertIn("ReferenceError: kaputt is not defined", str(caught.exception))
        with self.assertRaises(RuntimeError) as caught:
            self.tools.call("Gibt.esNicht")
        self.assertIn("wasn't found", str(caught.exception))

    def test_bright_and_moving_orb(self):
        from PIL import Image

        dark = Image.new("RGB", (200, 100), (5, 8, 13))
        lit = dark.copy()
        lit.paste((90, 170, 255), (20, 20, 60, 60))  # 40x40 von 80x80 hell
        rect = {"x": 10, "y": 10, "w": 40, "h": 40}  # in CSS-Pixeln, bei 2x doppelt so groß
        bright, a = probe.orb_numbers(lit, rect, 2.0)
        self.assertAlmostEqual(bright, 0.25, places=2)
        _, b = probe.orb_numbers(dark, rect, 2.0)
        self.assertEqual(a.shape, b.shape)


class BriefingCheckTest(unittest.TestCase):
    """Die Probe schreibt mit, welche Bereiche beim Briefing nacheinander leuchten."""

    class Tools:
        def __init__(self, focus):
            self.focus = list(focus)
            self.sent = []
            self.shots = []

        def evaluate(self, expression):
            if "send_text" in expression:
                self.sent.append(expression)
                return True
            return self.focus.pop(0) if self.focus else ""

        def pump(self, seconds):
            pass

        def screenshot(self, name):
            self.shots.append(name)

    def setUp(self):
        probe.failed.clear()
        probe.warned.clear()

    def run_check(self, tools):
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):  # die Probe schreibt für GitHub, hier nur Lärm
            probe.briefing_check(tools)

    def test_highlights_in_order(self):
        tools = self.Tools(["", "aktivitaet", "aktivitaet", "post", "kennzahlen", "nachrichten", "orb", ""])
        self.run_check(tools)
        self.assertIn("Briefing", tools.sent[0])
        self.assertEqual(tools.shots, ["oberflaeche-briefing.png"], "ein Bild beim ersten Leuchten")
        self.assertEqual((probe.failed, probe.warned), ([], []))

    def test_nothing_lights_up(self):
        tools = self.Tools([])
        with unittest.mock.patch.object(probe.time, "monotonic", side_effect=[0, 0, 50]):
            self.run_check(tools)
        self.assertEqual(probe.warned, ["Briefing hebt hervor"], "hängt am Takt der Stimme: nur ein Hinweis")
        self.assertEqual(probe.failed, [], "hält das Release nicht auf")


class DevToolsPortTest(unittest.TestCase):
    """Jarvis öffnet den DevTools-Port nur, wenn die Probe es mit JARVIS_DEVTOOLS_PORT verlangt."""

    def start_window(self, env):
        import collections
        import os
        import sys
        import types
        from unittest import mock

        from jarvis.gui.app import Window

        class Settings(collections.UserDict):
            def __init__(self, initial):
                super().__init__()
                self.data.update(initial)

            def __setitem__(self, key, value):
                if key not in self.data:
                    raise KeyError(key)  # wie pywebview: nur vorhandene Schlüssel
                super().__setitem__(key, value)

        class Event:
            def __iadd__(self, handler):
                return self

        fake = types.ModuleType("webview")
        fake.settings = Settings({"REMOTE_DEBUGGING_PORT": None})
        fake.create_window = lambda *args, **kwargs: types.SimpleNamespace(
            events=types.SimpleNamespace(closing=Event(), closed=Event(), minimized=Event(), before_show=Event()))
        fake.start = lambda *args, **kwargs: None
        with mock.patch.dict(sys.modules, {"webview": fake}), mock.patch.dict(os.environ, env, clear=False):
            if not env:
                os.environ.pop("JARVIS_DEVTOOLS_PORT", None)
            Window(object(), lambda: None, lambda: None, {}).start()
        return fake.settings["REMOTE_DEBUGGING_PORT"]

    def test_port_only_on_request(self):
        self.assertEqual(self.start_window({"JARVIS_DEVTOOLS_PORT": "9229"}), 9229)
        self.assertIsNone(self.start_window({}), "bei Georg bleibt der Port zu")
        self.assertIsNone(self.start_window({"JARVIS_DEVTOOLS_PORT": "an"}))


if __name__ == "__main__":
    unittest.main()
