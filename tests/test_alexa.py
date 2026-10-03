"""Alexa spricht mit Jarvis: Skill-Code, Verschlüsselung und der Weg über einen ntfy-Kanal."""

import collections
import json
import threading
import time
import unittest
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import alexa, alexa_skill
from jarvis.alexa import AlexaBridge


class FakeRelay:
    """Ein winziges ntfy.sh: POST /<kanal> legt ab, GET /<kanal>/json?since=… streamt."""

    def __init__(self):
        self.messages = collections.defaultdict(list)
        self.cond = threading.Condition()
        self.count = 0
        self.closing = False
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                topic = self.path.strip("/")
                body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
                with relay.cond:
                    relay.count += 1
                    relay.messages[topic].append({"id": f"m{relay.count}", "time": int(time.time()), "event": "message",
                                                  "topic": topic, "message": body})
                    relay.cond.notify_all()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                topic = parsed.path.strip("/").rsplit("/json", 1)[0]
                since = (urllib.parse.parse_qs(parsed.query).get("since") or ["0"])[0]
                self.send_response(200)
                self.end_headers()
                sent = set()
                self.wfile.write(b'{"event":"open"}\n')
                self.wfile.flush()
                end = time.time() + 8
                while time.time() < end and not relay.closing:
                    with relay.cond:
                        items = list(relay.messages[topic])
                    passed = not since.startswith("m")
                    for item in items:
                        if since.startswith("m"):
                            if item["id"] == since:
                                passed = True
                                continue
                            if not passed:
                                continue
                        elif item["time"] < int(since):
                            continue
                        if item["id"] in sent:
                            continue
                        sent.add(item["id"])
                        self.wfile.write((json.dumps(item) + "\n").encode())
                        self.wfile.flush()
                    with relay.cond:
                        relay.cond.wait(0.05)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.closing = True
        self.server.shutdown()
        self.server.server_close()


class FakeAssistant:
    def __init__(self, answer="Es ist 22 Uhr, Sir."):
        self.answer = answer
        self.handled = []

    def handle(self, text, speak=True):
        self.handled.append((text, speak))
        return self.answer


class SealTest(unittest.TestCase):
    def test_round_trip_and_tampering(self):
        key = alexa.new_secrets()["schluessel"]
        sealed = alexa_skill.seal({"id": "1", "text": "Öffne Discord"}, key)
        self.assertEqual(alexa_skill.unseal(sealed, key), {"id": "1", "text": "Öffne Discord"})
        self.assertNotIn("Discord", sealed, "verschlüsselt, nicht lesbar")
        self.assertIsNone(alexa_skill.unseal(sealed, alexa.new_secrets()["schluessel"]), "falscher Schlüssel")
        broken = sealed[:20] + ("A" if sealed[20] != "A" else "B") + sealed[21:]
        self.assertIsNone(alexa_skill.unseal(broken, key))
        self.assertIsNone(alexa_skill.unseal("kein base64 ???", key))
        self.assertNotEqual(alexa_skill.seal({"a": 1}, key), alexa_skill.seal({"a": 1}, key), "jedes Mal anders")

    def test_skill_code_and_model(self):
        secret = alexa.new_secrets()
        code = alexa.skill_code(secret["kanal"], secret["schluessel"])
        self.assertIn(f'KANAL = "{secret["kanal"]}"', code)
        self.assertIn(f'SCHLUESSEL = "{secret["schluessel"]}"', code)
        compile(code, "lambda_function.py", "exec")
        self.assertIn("def lambda_handler", code)
        model = alexa.interaction_model()["interactionModel"]["languageModel"]
        self.assertEqual(model["invocationName"], "jarvis")
        intent = next(i for i in model["intents"] if i["name"] == "BefehlIntent")
        self.assertIn("{befehl}", intent["samples"])
        values = [v["name"]["value"] for v in model["types"][0]["values"]]
        self.assertGreater(len(values), 40)
        self.assertEqual(len(values), len(set(values)), "keine doppelten Beispiele")
        self.assertTrue(all(v == v.lower() for v in values))
        json.dumps(alexa.interaction_model())


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.relay = FakeRelay()
        self.addCleanup(self.relay.close)
        self.secret = alexa.new_secrets()
        self.assistant = FakeAssistant()
        self.bridge = AlexaBridge({"alexa": self.secret}, self.assistant, relay=self.relay.url)
        self.addCleanup(self.bridge.stop)

    def test_alexa_asks_and_jarvis_answers(self):
        self.assertTrue(self.bridge.start())
        end = time.time() + 5
        while not self.bridge.connected and time.time() < end:
            time.sleep(0.02)
        self.assertTrue(self.bridge.connected)
        said, acked = alexa_skill.frage_jarvis("Wie spät ist es?", self.secret["kanal"], self.secret["schluessel"],
                                               self.relay.url, warten=5)
        self.assertEqual((said, acked), ("Es ist 22 Uhr, Sir.", True))
        self.assertEqual(self.assistant.handled, [("Wie spät ist es?", False)], "am PC still, Alexa spricht")
        # Der ganze Skill, wie Alexa ihn aufruft
        event = {"request": {"type": "IntentRequest", "intent": {"name": "BefehlIntent",
                                                                  "slots": {"befehl": {"value": "öffne discord"}}}}}
        with mock.patch.object(alexa_skill, "KANAL", self.secret["kanal"]), \
                mock.patch.object(alexa_skill, "SCHLUESSEL", self.secret["schluessel"]), \
                mock.patch.object(alexa_skill, "RELAY", self.relay.url):
            reply = alexa_skill.lambda_handler(event, None)
        self.assertEqual(reply["response"]["outputSpeech"]["text"], "Es ist 22 Uhr, Sir.")
        self.assertTrue(reply["response"]["shouldEndSession"])
        self.assertEqual(self.assistant.handled[-1], ("öffne discord", False))
        self.assertEqual(self.bridge.self_test(), "Es ist 22 Uhr, Sir.")

    def test_fake_old_and_repeated_messages_are_ignored(self):
        key = self.secret["schluessel"]
        now = int(time.time())
        self.assertFalse(self.bridge.receive("unsinn"))
        self.assertFalse(self.bridge.receive(alexa_skill.seal({"id": "a", "text": "Fahr runter", "zeit": now},
                                                              alexa.new_secrets()["schluessel"])))
        self.assertFalse(self.bridge.receive(alexa_skill.seal({"id": "b", "text": "Fahr runter", "zeit": now - 600}, key)))
        message = alexa_skill.seal({"id": "c", "text": "Wie spät ist es?", "zeit": now}, key)
        with mock.patch.object(self.bridge, "post"):
            self.assertTrue(self.bridge.receive(message))
            self.assertFalse(self.bridge.receive(message), "zweimal dieselbe Nachricht: nur einmal")

    def test_skill_answers_in_time_even_after_other_messages(self):
        # Alexa wartet höchstens acht Sekunden. Kommt kurz vor der Frist eine fremde Nachricht
        # (eine Quittung, ein anderer Befehl), darf readline() danach nicht noch einmal ganz warten.
        kanal = self.secret["kanal"]

        def noise():
            time.sleep(0.8)
            request = urllib.request.Request(f"{self.relay.url}/{kanal}-antwort", data=b"fremd", method="POST")
            urllib.request.urlopen(request, timeout=2).read()

        threading.Thread(target=noise, daemon=True).start()
        start = time.time()
        said, acked = alexa_skill.frage_jarvis("öffne discord", kanal, self.secret["schluessel"], self.relay.url,
                                               warten=1.2)
        self.assertEqual((said, acked), ("", False))
        self.assertLess(time.time() - start, 1.7)

    def test_questions_keep_alexa_listening_and_yes_no_reach_jarvis(self):
        question = {"request": {"type": "IntentRequest", "intent": {"name": "BefehlIntent",
                                                                     "slots": {"befehl": {"value": "gute nacht"}}}}}
        with mock.patch.object(alexa_skill, "frage_jarvis",
                               return_value=("Gute Nacht, Sir. Soll ich den PC herunterfahren?", True)):
            reply = alexa_skill.lambda_handler(question, None)
        self.assertFalse(reply["response"]["shouldEndSession"], "Alexa hört weiter zu")
        self.assertIn("reprompt", reply["response"])
        yes = {"request": {"type": "IntentRequest", "intent": {"name": "AMAZON.YesIntent"}}}
        with mock.patch.object(alexa_skill, "frage_jarvis", return_value=("Der PC fährt herunter, Sir.", True)) as asked:
            reply = alexa_skill.lambda_handler(yes, None)
        asked.assert_called_once_with("Ja")
        self.assertTrue(reply["response"]["shouldEndSession"])
        names = [i["name"] for i in alexa.interaction_model()["interactionModel"]["languageModel"]["intents"]]
        self.assertIn("AMAZON.YesIntent", names)
        self.assertIn("AMAZON.NoIntent", names)

    def test_pc_off_and_slow_answers(self):
        with mock.patch.object(alexa_skill, "KANAL", self.secret["kanal"]), \
                mock.patch.object(alexa_skill, "SCHLUESSEL", self.secret["schluessel"]), \
                mock.patch.object(alexa_skill, "RELAY", self.relay.url), \
                mock.patch.object(alexa_skill, "WARTEN", 1.0):
            event = {"request": {"type": "IntentRequest", "intent": {"name": "BefehlIntent",
                                                                      "slots": {"befehl": {"value": "öffne discord"}}}}}
            reply = alexa_skill.lambda_handler(event, None)  # niemand hört zu: PC aus
            self.assertIn("antwortet nicht", reply["response"]["outputSpeech"]["text"])
            launch = alexa_skill.lambda_handler({"request": {"type": "LaunchRequest"}}, None)
            self.assertFalse(launch["response"]["shouldEndSession"])
            stop = alexa_skill.lambda_handler({"request": {"type": "IntentRequest", "intent": {"name": "AMAZON.StopIntent"}}}, None)
            self.assertTrue(stop["response"]["shouldEndSession"])
            empty = alexa_skill.lambda_handler({"request": {"type": "IntentRequest", "intent": {"name": "BefehlIntent", "slots": {}}}}, None)
            self.assertIn("Wie bitte", empty["response"]["outputSpeech"]["text"])


if __name__ == "__main__":
    unittest.main()


class SmartHomeTest(unittest.TestCase):
    """Licht über Home Assistant, sonst ein Sprachbefehl an ein Echo."""

    STATES = [
        {"entity_id": "light.kueche", "attributes": {"friendly_name": "Küche Decke"}, "state": "off"},
        {"entity_id": "light.wohnzimmer_stehlampe", "attributes": {"friendly_name": "Stehlampe Wohnzimmer"}, "state": "on"},
        {"entity_id": "switch.wohnzimmer_tv", "attributes": {"friendly_name": "Wohnzimmer TV"}, "state": "on"},
        {"entity_id": "media_player.echo_wohnzimmer", "attributes": {"friendly_name": "Echo Wohnzimmer"}, "state": "idle"},
    ]

    def make(self):
        from jarvis.homeassistant import HomeAssistant

        ha = HomeAssistant({"url": "http://ha.local:8123", "token": "t", "alexa": {"wohnzimmer": "media_player.echo_wohnzimmer"}})
        calls = []

        def request(method, path, body=None):
            if path == "/api/states":
                return self.STATES
            calls.append((path, body))
            return []

        ha._request = request
        return ha, calls

    def test_lights_by_room_and_brightness(self):
        ha, calls = self.make()
        self.assertEqual(ha.find_light("Küche"), "light.kueche")
        self.assertEqual(ha.find_light("Wohnzimmer"), "light.wohnzimmer_stehlampe", "Licht vor Schalter")
        ha.light("küche", True, 30)
        self.assertEqual(calls[-1], ("/api/services/light/turn_on", {"entity_id": "light.kueche", "brightness_pct": 30}))
        ha.light("küche", False)
        self.assertEqual(calls[-1], ("/api/services/homeassistant/turn_off", {"entity_id": "light.kueche"}))
        ha.alexa_command("wohnzimmer", "Schalte den Fernseher aus")
        self.assertEqual(calls[-1], ("/api/services/media_player/play_media",
                                     {"entity_id": "media_player.echo_wohnzimmer", "media_content_type": "custom",
                                      "media_content_id": "Schalte den Fernseher aus"}))

    def test_assistant_dims_without_claude_or_asks_claude_without_home_assistant(self):
        from jarvis.config import load_config
        from tests.test_assistant import FakeBrain, make

        cfg = load_config()
        cfg["homeassistant"] = {"url": "http://ha.local:8123", "token": "t"}
        brain = FakeBrain()
        assistant, _ui, _speaker, _ = make(brain, cfg=cfg)
        with mock.patch("jarvis.homeassistant.HomeAssistant.light", return_value="ok") as light:
            answer = assistant.handle("Dimm das Licht im Wohnzimmer auf 30 Prozent")
        light.assert_called_once_with("wohnzimmer", True, 30)
        self.assertEqual(answer, "Licht im Wohnzimmer auf 30 Prozent, Sir.")
        self.assertEqual(brain.asked, [])
        cfg2 = load_config()
        cfg2["homeassistant"] = {"url": "", "token": ""}
        brain2 = FakeBrain()
        assistant2, _ui, _speaker, _ = make(brain2, cfg=cfg2)
        assistant2.handle("Mach das Licht aus")
        self.assertEqual(brain2.asked, ["Mach das Licht aus"])

    def test_wake_on_lan_packet(self):
        from jarvis import pc

        sent = []

        class Sock:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def setsockopt(self, *a):
                pass

            def sendto(self, data, address):
                sent.append((data, address))

        with mock.patch("socket.socket", return_value=Sock()):
            pc.wake("3C:7C:3F:12:AB:9E")
        data, address = sent[0]
        self.assertEqual(address, ("255.255.255.255", 9))
        self.assertEqual(data[:6], b"\xff" * 6)
        self.assertEqual(data[6:12], bytes.fromhex("3C7C3F12AB9E"))
        self.assertEqual(len(data), 6 + 16 * 6)
        with self.assertRaises(pc.PcError):
            pc.wake("kein-mac")
