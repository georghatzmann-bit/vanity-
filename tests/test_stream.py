"""Stream-Modus (stream.py): OBS über den WebSocket, Twitch, Mikrofon und Kamera, Tipp und Trailer."""

import base64
import hashlib
import io
import json
import socket
import struct
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from jarvis import stream
from jarvis.stream import ObsClient, ObsError, Stream, gameplay_scene, is_command, read_setup, wants_end, wants_live, \
    wants_prepare, wants_trailer

PASSWORD = "geheim123"


class FakeObs:
    """Ein OBS-WebSocket-Server (Protokoll 5) zum Testen: Anmeldung mit Passwort, Szenen, Stream an und aus."""

    def __init__(self, password=PASSWORD, scenes=("Startet gleich", "Gameplay", "Pause")):
        self.password = password
        self.scenes = list(scenes)
        self.scene = self.scenes[0]
        self.streaming = False
        self.requests = []
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.port = self.server.getsockname()[1]
        self._stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def close(self):
        self._stop = True
        try:
            self.server.close()
        except OSError:
            pass

    @staticmethod
    def _recv_exact(conn, count):
        data = b""
        while len(data) < count:
            chunk = conn.recv(count - len(data))
            if not chunk:
                raise ConnectionError
            data += chunk
        return data

    def _recv(self, conn):
        first, second = self._recv_exact(conn, 2)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", self._recv_exact(conn, 2))[0]
        elif size == 127:
            size = struct.unpack("!Q", self._recv_exact(conn, 8))[0]
        mask = self._recv_exact(conn, 4)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._recv_exact(conn, size)))
        return first & 0x0F, payload

    @staticmethod
    def _send(conn, data, opcode=0x1):
        payload = json.dumps(data).encode() if opcode == 0x1 else data
        head = bytearray([0x80 | opcode])
        head += bytes([len(payload)]) if len(payload) < 126 else bytes([126]) + struct.pack("!H", len(payload))
        conn.sendall(bytes(head) + payload)

    def _serve(self):
        while not self._stop:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                request += conn.recv(1024)
            key = [line.split(":", 1)[1].strip() for line in request.decode().split("\r\n")
                   if line.lower().startswith("sec-websocket-key")][0]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Accept: " + accept + b"\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n")
            salt, challenge = "salzig", "frage"
            self._send(conn, {"op": 0, "d": {"rpcVersion": 1, "authentication": {"salt": salt, "challenge": challenge}}})
            _, payload = self._recv(conn)
            ident = json.loads(payload)
            secret = base64.b64encode(hashlib.sha256((self.password + salt).encode()).digest()).decode()
            want = base64.b64encode(hashlib.sha256((secret + challenge).encode()).digest()).decode()
            if ident["d"].get("authentication") != want:
                self._send(conn, struct.pack("!H", 4009) + b"Authentication failed.", opcode=0x8)
                conn.close()
                return
            self._send(conn, {"op": 2, "d": {"negotiatedRpcVersion": 1}})
            while True:
                opcode, payload = self._recv(conn)
                if opcode == 0x8:
                    conn.close()
                    return
                message = json.loads(payload)["d"]
                kind = message["requestType"]
                self.requests.append((kind, message.get("requestData") or {}))
                data, ok = {}, True
                if kind == "GetSceneList":
                    data = {"scenes": [{"sceneName": s, "sceneIndex": i} for i, s in enumerate(reversed(self.scenes))]}
                elif kind == "SetCurrentProgramScene":
                    ok = message["requestData"]["sceneName"] in self.scenes
                    if ok:
                        self.scene = message["requestData"]["sceneName"]
                elif kind == "GetStreamStatus":
                    data = {"outputActive": self.streaming}
                elif kind == "StartStream":
                    self.streaming = True
                elif kind == "StopStream":
                    self.streaming = False
                status = {"result": ok, "code": 100 if ok else 600}
                if not ok:
                    status["comment"] = "Keine solche Szene."
                self._send(conn, {"op": 7, "d": {"requestType": kind, "requestId": message["requestId"],
                                                 "requestStatus": status, "responseData": data}})
        except (ConnectionError, OSError, ValueError, IndexError):
            conn.close()


class FakeEnv(stream.Env):
    def __init__(self, folder: Path, running=False, exe=True, cameras=("Logitech C920",)):
        self.folder = folder
        self.running = running
        self.exe = folder / "obs" / "bin" / "64bit" / "obs64.exe" if exe else None
        self.cams = list(cameras) if cameras is not None else None
        self.launched = []
        self.opened = []

    def appdata(self):
        return self.folder

    def obs_exe(self):
        return self.exe

    def obs_running(self):
        return self.running

    def launch(self, exe, args):
        self.launched.append((exe, args))

    def open_url(self, url):
        self.opened.append(url)

    def cameras(self):
        return self.cams


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def steam(request, timeout=3):
    url = request.full_url
    if "featuredcategories" in url:
        body = {"top_sellers": {"items": [
            {"id": 1, "name": "Steam Machine", "type": 0}, {"id": 2, "name": "Lethal Company", "type": 0},
            {"id": 3, "name": "Transport Fever 3", "type": 0}, {"id": 4, "name": "Gründerpaket", "type": 1}]}}
    elif "storesearch" in url:
        body = {"items": [{"id": 3321460, "name": "Crimson Desert", "type": "app"}]}
    else:
        body = {"3321460": {"success": True, "data": {"movies": [
            {"name": "Teaser", "hls_h264": "https://video.example/teaser.m3u8", "thumbnail": "https://img/t.jpg"},
            {"name": "Trailer", "hls_h264": "https://video.example/trailer.m3u8", "thumbnail": "https://img/a.jpg",
             "highlight": True}]}}}
    return _Response(json.dumps(body).encode("utf-8"))


def obs_folder(root: Path, enabled=False, password=PASSWORD, auth=True, port=4455):
    config = root / "obs-studio" / "plugin_config" / "obs-websocket"
    config.mkdir(parents=True)
    (config / "config.json").write_text(json.dumps({"server_enabled": enabled, "server_port": port,
                                                    "server_password": password, "auth_required": auth}),
                                        encoding="utf-8")
    scenes = root / "obs-studio" / "basic" / "scenes"
    scenes.mkdir(parents=True)
    (scenes / "Unbenannt.json").write_text(json.dumps({"scene_order": [{"name": "Alt"}]}), encoding="utf-8")
    (scenes / "Stream.json").write_text(json.dumps({"scene_order": [
        {"name": "Startet gleich"}, {"name": "Gameplay"}, {"name": "BRB"}]}), encoding="utf-8")
    (root / "obs-studio" / "user.ini").write_text("[Basic]\nSceneCollection=Stream\nSceneCollectionFile=Stream\n",
                                                  encoding="utf-8")


class SentenceTest(unittest.TestCase):
    def test_sentences(self):
        self.assertEqual(wants_prepare("Ich will streamen"), "")
        self.assertEqual(wants_prepare("Jarvis, ich streame gleich CS2"), "cs2")
        self.assertEqual(wants_prepare("Ich will heute noch Fortnite streamen"), "fortnite")
        self.assertEqual(wants_prepare("Mach den Stream fertig"), "")
        self.assertIsNone(wants_prepare("Was ist ein Stream?"))
        self.assertTrue(wants_live("Geh live"))
        self.assertTrue(wants_live("Starte den Stream"))
        self.assertFalse(wants_live("Starte CS2"))
        self.assertTrue(wants_end("Beende den Stream"))
        self.assertEqual(wants_trailer("Zeig mir den Trailer"), "")
        self.assertEqual(wants_trailer("Kannst du"), None)
        self.assertEqual(wants_trailer("Zeig mir den Trailer von Crimson Desert"), "crimson desert")
        self.assertEqual(wants_trailer("Zeig mir den Crimson Desert Trailer"), "crimson desert")

    def test_sentences_that_are_no_stream_command(self):
        for text in ("Ich will heute nicht streamen", "Ich streame heute nicht", "Ich werde morgen streamen",
                     "Ich will lieber nicht streamen", "Ich streame gerade", "Ich will einen Film streamen"):
            self.assertIsNone(wants_prepare(text), text)
        self.assertEqual(wants_prepare("Ich streame gleich"), "", "gleich ist kein Spiel")
        self.assertEqual(wants_prepare("Ich will heute Abend streamen"), "")
        self.assertEqual(wants_prepare("Ich will eine Runde Valorant streamen"), "valorant")
        for text in ("Lass uns Livemusik hören", "Lass uns livestream schauen", "Geh live auf Instagram"):
            self.assertFalse(wants_live(text), text)
        self.assertTrue(wants_live("Lass uns live gehen"))
        self.assertTrue(wants_live("Wir gehen jetzt live"))
        for text in ("Wie sieht das Wetter morgen aus?", "Wie sieht es aus?", "Wie sieht mein Kalender aus",
                     "Zeig mir die Datei aus"):
            self.assertIsNone(wants_trailer(text), text)

    def test_trailer_names_without_filler(self):
        """"Den neuen Trailer" ist kein Spiel namens "neuen" (das wäre ein falscher Trailer aus der Steam-Suche)."""
        for text in ("Zeig mir den neuen Trailer", "Zeig mir einen Trailer", "Spiel mir den Trailer vor",
                     "Zeig mir den Trailer nochmal", "Zeig mir den Trailer bitte"):
            self.assertEqual(wants_trailer(text), "", text)
        self.assertEqual(wants_trailer("Zeig mir den Trailer von dem neuen Battlefield"), "battlefield")
        self.assertEqual(wants_trailer("Zeig mir den neuen Battlefield Trailer"), "battlefield")
        self.assertEqual(wants_trailer("Zeig mir den Trailer zum Spiel Elden Ring"), "elden ring")
        self.assertEqual(wants_trailer("Zeig mir den GTA 6 Trailer"), "gta 6")
        self.assertTrue(is_command("geh live") and is_command("starte den Stream") and is_command("zeig mir den Trailer"))
        self.assertFalse(is_command("Öffne Spotify") or is_command("starte Steam"))

    def test_gameplay_scene(self):
        self.assertEqual(gameplay_scene(["Starting Soon", "Gameplay", "BRB", "Ende"]), "Gameplay")
        self.assertEqual(gameplay_scene(["Startet gleich", "CS2 Szene", "Chat"], "cs2"), "CS2 Szene")
        self.assertEqual(gameplay_scene(["Intro", "Szene 2"]), "Szene 2")
        self.assertEqual(gameplay_scene([]), "")


class ObsClientTest(unittest.TestCase):
    def setUp(self):
        self.obs = FakeObs()

    def tearDown(self):
        self.obs.close()

    def test_login_and_requests(self):
        with ObsClient("127.0.0.1", self.obs.port, PASSWORD) as client:
            names = [s["sceneName"] for s in client.request("GetSceneList")["scenes"]]
            client.request("SetCurrentProgramScene", {"sceneName": "Gameplay"})
            with self.assertRaises(ObsError) as caught:
                client.request("SetCurrentProgramScene", {"sceneName": "Gibt es nicht"})
        self.assertEqual(sorted(names), sorted(self.obs.scenes))
        self.assertEqual(self.obs.scene, "Gameplay")
        self.assertEqual(str(caught.exception), "Keine solche Szene.")

    def test_wrong_password_and_no_server(self):
        with self.assertRaises(ObsError) as caught:
            with ObsClient("127.0.0.1", self.obs.port, "falsch"):
                pass
        self.assertEqual(str(caught.exception), "Das Passwort für OBS stimmt nicht.")
        with self.assertRaises(ObsError):
            with ObsClient("127.0.0.1", self.obs.port, ""):
                pass
        free = socket.socket()
        free.bind(("127.0.0.1", 0))
        port = free.getsockname()[1]
        free.close()
        with self.assertRaises(ObsError):
            ObsClient("127.0.0.1", port, PASSWORD, timeout=1).open()

    def test_connection_reset_is_an_obs_error(self):
        class Reset:
            def settimeout(self, _seconds):
                pass

            def sendall(self, _data):
                pass

            def recv(self, _size):
                raise ConnectionResetError(10054, "Eine vorhandene Verbindung wurde vom Remotehost geschlossen")

            def close(self):
                pass

        with self.assertRaises(ObsError) as caught:
            ObsClient(connect=lambda address, timeout: Reset()).open()
        self.assertEqual(str(caught.exception), "OBS hat die Verbindung unterbrochen.")
        with ObsClient("127.0.0.1", self.obs.port, PASSWORD) as client:
            client._sock.close()
            client._sock = Reset()  # OBS geht gerade zu
            with self.assertRaises(ObsError):
                client.request("GetStreamStatus")


class StreamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ui = mock.Mock()
        self.assistant = mock.Mock(mic_name="Headset (Arctis 7 Chat)", gaming=False, zentrale=None)
        self.assistant.games.installed.return_value = [mock.Mock(name="lc")]
        self.assistant.games.installed.return_value[0].name = "Lethal Company"

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, env, **kwargs):
        return Stream({}, self.assistant, self.ui, env=env, opener=steam, **kwargs)

    def test_prepare_starts_obs_on_the_gameplay_scene(self):
        obs_folder(self.root)
        env = FakeEnv(self.root)
        answer = self.make(env).prepare("cs2")
        self.assertEqual(env.launched, [(env.exe, ["--disable-shutdown-check", "--scene", "Gameplay"])])
        self.assertIn("OBS startet auf der Szene Gameplay.", answer)
        self.assertIn("Mikrofon und Kamera sind verbunden.", answer)
        self.assertIn("Ihr Twitch ist offen.", answer)
        self.assertEqual(env.opened, [stream.TWITCH_DASHBOARD])
        self.assertIn("Sagen Sie Bescheid, wenn es live gehen soll, Sir.", answer)
        self.assertIn("Übrigens, Sir: Transport Fever 3 ist gerade auf Platz 2 der Steam-Bestseller.", answer,
                      "ohne Hardware und ohne Spiele, die Georg schon hat")
        config = json.loads((self.root / "obs-studio" / "plugin_config" / "obs-websocket" / "config.json").read_text())
        self.assertTrue(config["server_enabled"], "mit Passwort darf Jarvis den Server einschalten")

    def test_websocket_without_password_stays_off(self):
        obs_folder(self.root, password="", auth=False)
        env = FakeEnv(self.root, cameras=())
        answer = self.make(env).prepare()
        config = json.loads((self.root / "obs-studio" / "plugin_config" / "obs-websocket" / "config.json").read_text())
        self.assertFalse(config["server_enabled"], "ohne Passwort stünde OBS offen im Netz")
        self.assertIn("eine Kamera finde ich nicht", answer)

    def test_running_obs_switches_scene_and_goes_live(self):
        fake = FakeObs()
        self.addCleanup(fake.close)
        obs_folder(self.root, enabled=True, port=fake.port)
        env = FakeEnv(self.root, running=True)
        live = self.make(env)
        self.assertIn("Ihr OBS steht auf der Szene Gameplay.", live.prepare())
        self.assertEqual(fake.scene, "Gameplay")
        self.assertEqual(env.launched, [])
        self.assertEqual(live.command("Geh live"), "Sie sind live, Sir. Viel Erfolg.")
        self.assertTrue(fake.streaming)
        self.assertEqual(live.command("Beende den Stream"), "Der Stream ist beendet, Sir. Gut gemacht.")
        self.assertFalse(fake.streaming)

    def test_just_started_obs_gets_a_moment(self):
        """"Öffne OBS und geh live": OBS läuft schon, sein Server nimmt aber erst nach ein paar Sekunden an."""
        fake = FakeObs()
        self.addCleanup(fake.close)
        obs_folder(self.root, enabled=True, port=fake.port)
        tries = []

        def refuse(address, timeout):
            raise ConnectionRefusedError(10061, "Es konnte keine Verbindung hergestellt werden")

        def client(host, port, password):
            tries.append(port)
            return ObsClient(host, port, password, connect=refuse if len(tries) <= 2 else None)

        live = self.make(FakeEnv(self.root, running=True), client=client)
        slept = []
        live._sleep = slept.append
        self.assertEqual(live.go_live(), "Sie sind live, Sir. Viel Erfolg.")
        self.assertTrue(fake.streaming)
        self.assertEqual(slept, [2, 2])

        never = self.make(FakeEnv(self.root, running=True),
                          client=lambda host, port, password: ObsClient(host, port, password, connect=refuse))
        slept = []
        never._sleep = slept.append
        self.assertTrue(never.go_live().startswith("OBS hört gerade nicht auf mich"))
        self.assertEqual(sum(slept), stream.OBS_WAIT_SECONDS, "wartet nicht ewig")

    def test_running_obs_without_websocket_is_honest(self):
        obs_folder(self.root, enabled=False)
        env = FakeEnv(self.root, running=True)
        live = self.make(env)
        self.assertIn("WebSocket-Server-Einstellungen", live.prepare())
        self.assertIn("Drücken Sie in OBS auf Stream starten", live.go_live())

    def test_without_obs(self):
        env = FakeEnv(self.root, exe=False)
        self.assertIn("OBS finde ich nicht", self.make(env).prepare())

    def test_trailer_plays_in_the_window(self):
        env = FakeEnv(self.root)
        shown = []
        live = self.make(env, show_window=lambda: shown.append(True))
        self.assertEqual(live.command("Zeig mir den Trailer von Crimson Desert"), "Sehr wohl, Sir. Der Trailer zu Crimson Desert.")
        self.ui.trailer.assert_called_once_with({"titel": "Crimson Desert", "url": "https://video.example/trailer.m3u8",
                                                 "bild": "https://img/a.jpg"})
        self.assertEqual(shown, [True])

    def test_trailer_for_the_tip_and_youtube_fallback(self):
        env = FakeEnv(self.root)
        live = self.make(env)
        self.assertEqual(live.trailer(), "Von welchem Spiel, Sir?")
        live.prepare()
        with mock.patch.object(live, "trailer_url", return_value=("", "")), \
                mock.patch("jarvis.web.first_video", return_value="abcdefghijk"):
            answer = live.command("Zeig mir den Trailer")
        self.assertEqual(answer, "Sehr wohl, Sir. Der Trailer zu Transport Fever 3 läuft auf YouTube.",
                         "das Spiel aus dem Tipp")
        self.assertEqual(env.opened[-1], "https://www.youtube.com/watch?v=abcdefghijk")

    def test_setup_reads_the_current_collection(self):
        obs_folder(self.root, enabled=True, port=4466)
        setup = read_setup(self.root)
        self.assertEqual((setup.port, setup.password, setup.enabled), (4466, PASSWORD, True))
        self.assertEqual(setup.scenes, ["Startet gleich", "Gameplay", "BRB"])

    def test_wake_up_like_in_the_video(self):
        from jarvis.assistant import WAKE_LINES
        from tests.test_assistant import make

        assistant, _ui, _speaker, _ = make()
        self.assertIn(assistant.handle("Jarvis, wach auf"), WAKE_LINES)
        self.assertIn(assistant.handle("Wake up"), WAKE_LINES)
        self.assertTrue(assistant.take_follow_up(), "die Antwort ist eine Frage: weiter zuhören")
        self.assertEqual(assistant.brain.asked, [])

    def test_assistant_routes_stream_sentences(self):
        from tests.test_assistant import make

        assistant, _ui, _speaker, _ = make()
        obs_folder(self.root)
        assistant.stream = Stream({}, assistant, None, env=FakeEnv(self.root), opener=steam)
        assistant.mic_name = "Headset"
        answer = assistant.handle("Ich will streamen", speak=False)
        self.assertIn("OBS startet auf der Szene Gameplay.", answer)
        self.assertEqual(assistant.brain.asked, [], "ohne Claude")

    def test_the_first_sentence_comes_at_once(self):
        from tests.test_assistant import make

        assistant, ui, speaker, _ = make()
        obs_folder(self.root)
        env = FakeEnv(self.root)
        heard_before_obs = []
        launch = env.launch
        env.launch = lambda *args: (heard_before_obs.append(list(speaker.said)), launch(*args))[1]
        assistant.stream = Stream({}, assistant, ui, env=env, opener=steam)
        assistant.mic_name = "Headset"
        answer = assistant.handle("Ich will streamen")
        first = heard_before_obs[0]
        self.assertEqual(len(first), 1, "Jarvis sagt schon etwas, bevor OBS startet")
        self.assertIn(first[0], ("Verstanden, Sir, machen wir uns bereit.", "Sehr wohl, Sir. Alles für den Stream."))
        self.assertTrue(answer.startswith("OBS startet auf der Szene Gameplay."), "und sagt es nicht zweimal")
        self.assertEqual(speaker.said, [first[0], answer])
        shown = [e[2] for e in ui.events if e[0] == "message" and e[1] == "jarvis"]
        self.assertEqual(shown, [first[0], answer])

    def test_stream_part_in_a_longer_sentence(self):
        """"Öffne Spotify und geh live": den zweiten Teil macht der Stream-Modus, nicht "Öffne das Programm live"."""
        from jarvis import intents
        from tests.test_assistant import make

        found = intents.match_parts("Öffne Spotify und starte den Stream", is_command)
        self.assertEqual([i.name for _p, i in found], ["open", "extern"])
        fake = FakeObs()
        self.addCleanup(fake.close)
        obs_folder(self.root, enabled=True, port=fake.port)
        assistant, _ui, _speaker, _ = make()
        assistant.stream = Stream({}, assistant, None, env=FakeEnv(self.root, running=True), opener=steam)
        with mock.patch("jarvis.apps.open_app", return_value="Spotify startet.") as opened:
            answer = assistant.handle("Öffne Spotify und geh live", speak=False)
        opened.assert_called_once()
        self.assertIn("Sie sind live, Sir.", answer)
        self.assertTrue(fake.streaming)
        self.assertEqual(assistant.brain.asked, [], "ohne Claude")

    def test_weather_question_is_no_trailer(self):
        from tests.test_assistant import make

        assistant, _ui, _speaker, _ = make()
        env = FakeEnv(self.root)
        ui = mock.Mock()
        assistant.stream = Stream({}, assistant, ui, env=env, opener=steam)
        with mock.patch("jarvis.web.first_video", return_value="abcdefghijk"):
            answer = assistant.handle("Wie sieht das Wetter morgen aus?", speak=False)
        self.assertNotIn("Trailer", answer)
        self.assertEqual(env.opened, [], "kein YouTube-Trailer zu \"Das Wetter Morgen\"")
        ui.trailer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
