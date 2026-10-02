"""Telegram: Koppeln nur mit Code, Fremde werden ignoriert, Text und Sprachnachrichten, der Schlüssel bleibt geheim."""

import io
import json
import logging
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tests.helpers  # noqa: F401
from jarvis import telegram
from jarvis.telegram import TelegramBot, valid_token

TOKEN = "123456789:AAHfakeFAKEfake_fake-FAKEfakeFAKE12345"
OTHER = "987654321:BBHotherOTHERother_oth-OTHERother9876"


def tone_wav(seconds: float = 0.6, rate: int = 24000) -> bytes:
    import numpy as np

    t = np.arange(int(seconds * rate)) / rate
    samples = (np.sin(2 * np.pi * 220 * t) * 9000).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return out.getvalue()


def has_opus() -> bool:
    try:
        import av  # noqa: F401
        import numpy  # noqa: F401
    except ImportError:
        return False
    return True


class FakeTelegram:
    """Ein winziges api.telegram.org: merkt sich jeden Aufruf und liefert vorbereitete Updates aus."""

    def __init__(self, tokens=(TOKEN,), username="jarvis_georg_bot"):
        self.tokens = set(tokens)
        self.username = username
        self.calls = []
        self.updates = []
        self.files = {}
        self.cond = threading.Condition()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, code, payload, raw=None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                # Dateien: /file/bot<token>/<pfad>
                parts = self.path.split("/", 3)
                if len(parts) == 4 and parts[1] == "file" and parts[2][3:] in fake.tokens:
                    data = fake.files.get(parts[3])
                    if data is not None:
                        self._reply(200, None, raw=data)
                        return
                self._reply(404, {"ok": False, "description": "Not Found"})

            def do_POST(self):
                _, bot, method = self.path.split("/", 2)
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                kind = self.headers.get("Content-Type", "")
                if bot[3:] not in fake.tokens:
                    self._reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
                    return
                params = json.loads(body or b"{}") if kind.startswith("application/json") else {"raw": body}
                with fake.cond:
                    fake.calls.append((method, params))
                    fake.cond.notify_all()
                if method == "getMe":
                    self._reply(200, {"ok": True, "result": {"id": 1, "is_bot": True, "username": fake.username}})
                elif method == "getUpdates":
                    offset = int(params.get("offset") or 0)
                    end = time.time() + min(1.0, float(params.get("timeout") or 0))
                    while True:
                        with fake.cond:
                            ready = [u for u in fake.updates if u["update_id"] >= offset]
                            if ready or time.time() >= end:
                                break
                            fake.cond.wait(0.05)
                    self._reply(200, {"ok": True, "result": ready})
                elif method == "getFile":
                    path = f"voice/{params['file_id']}.oga"
                    self._reply(200, {"ok": True, "result": {"file_id": params["file_id"], "file_path": path}})
                else:
                    self._reply(200, {"ok": True, "result": {"message_id": len(fake.calls)}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def push(self, update):
        with self.cond:
            self.updates.append(update)
            self.cond.notify_all()

    def sent(self, method="sendMessage"):
        with self.cond:
            return [params for name, params in self.calls if name == method]

    def texts(self, chat=None):
        return [p["text"] for p in self.sent() if chat is None or p.get("chat_id") == chat]

    def wait_for(self, method, count=1, timeout=5.0):
        end = time.time() + timeout
        with self.cond:
            while len([1 for name, _ in self.calls if name == method]) < count:
                left = end - time.time()
                if left <= 0:
                    raise AssertionError(f"{method} kam nicht ({[name for name, _ in self.calls]})")
                self.cond.wait(left)


class FakeAssistant:
    def __init__(self, answer="Spotify ist offen, Sir.", heard="Öffne Spotify"):
        self.answer = answer
        self.heard = heard
        self.commands = []
        self.audio = []

    def handle(self, text, speak=True):
        self.commands.append((text, speak))
        return self.answer

    def hear(self, data):
        self.audio.append(data)
        return self.heard

    def speech_wav(self, text):
        return tone_wav()


def message(chat, text="", **extra):
    return {"message_id": 1, "chat": {"id": chat, "type": "private"}, "from": {"id": chat, "first_name": "Georg"},
            "text": text, **extra}


class TelegramTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeTelegram()
        self.addCleanup(self.api.close)
        self.saved = {}
        self.assistant = FakeAssistant()

    def bot(self, chat_id=0, **section):
        cfg = {"telegram": {"aktiv": True, "token": TOKEN, "chat_id": chat_id, "name": "jarvis_georg_bot", **section}}
        bot = TelegramBot(cfg, self.assistant, save=lambda s, k, v: self.saved.__setitem__((s, k), v),
                          api=self.api.url, poll_timeout=1)
        self.addCleanup(bot.stop)
        return bot

    def wait_until(self, check, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            if check():
                return
            time.sleep(0.02)
        self.fail("Zustand trat nicht ein")

    # -------------------------------------------------------------- Schlüssel

    def test_token_format(self):
        self.assertTrue(valid_token(TOKEN))
        self.assertTrue(valid_token(f"  {TOKEN}\n"))
        for bad in ("", "123456789", "abc:def", "123456789:kurz", TOKEN + " und mehr"):
            self.assertFalse(valid_token(bad), bad)

    def test_check_names_the_bot(self):
        bot = self.bot()
        bot.username = ""
        self.assertEqual(bot.check(), {"ok": True, "name": "jarvis_georg_bot", "error": ""})
        self.assertEqual(bot.username, "jarvis_georg_bot")

    def test_check_another_key_does_not_take_it_yet(self):
        bot = self.bot()
        result = bot.check(OTHER)
        self.assertFalse(result["ok"])
        self.assertIn("kennt Telegram nicht", result["error"])
        self.assertEqual(bot.token, TOKEN)
        self.assertFalse(bot.check("Hallo")["ok"])
        self.assertEqual([name for name, _ in self.api.calls], [], "falsches Format geht gar nicht erst raus")

    def test_key_never_appears_in_errors_or_log(self):
        bot = self.bot()
        bot._api = "http://127.0.0.1:9"  # niemand da
        with self.assertLogs("jarvis.telegram", level="INFO") as logs:
            self.assertFalse(bot.send("Hallo"))
            result = bot.check()
            bot._reply(42, "x")
        self.assertFalse(result["ok"])
        for text in [result["error"], *logs.output]:
            self.assertNotIn(TOKEN.split(":")[1], text)
            self.assertNotIn(TOKEN, text)

    def test_new_bot_forgets_old_chat(self):
        bot = self.bot(chat_id=42)
        bot._offset = 900
        bot.use_token(OTHER, "anderer_bot")
        self.assertEqual((bot.token, bot.username, bot.chat_id, bot._offset), (OTHER, "anderer_bot", 0, 0))
        self.assertEqual(self.saved[("telegram", "chat_id")], 0)
        bot.use_token(OTHER, "anderer_bot")  # gleicher Schlüssel: nichts zurücksetzen
        self.assertEqual(self.saved[("telegram", "chat_id")], 0)

    # -------------------------------------------------------------- Koppeln

    def test_pairing_with_link_code(self):
        bot = self.bot()
        paired = []
        bot.on_paired = paired.append
        pair = bot.pairing()
        self.assertRegex(pair["code"], r"^\d{6}$")
        self.assertEqual(pair["link"], f"https://t.me/jarvis_georg_bot?start={pair['code']}")
        bot.handle(message(42, f"/start {pair['code']}"))
        self.assertEqual(bot.chat_id, 42)
        self.assertEqual(self.saved[("telegram", "chat_id")], 42)
        self.assertEqual(paired, ["Georg"])
        self.assertIn("Verbunden", self.api.texts(42)[-1])
        self.assertEqual(self.assistant.commands, [])

    def test_pairing_by_typing_the_code(self):
        bot = self.bot()
        code = bot.pairing()["code"]
        bot.handle(message(42, code))
        self.assertEqual(bot.chat_id, 42)

    def test_wrong_or_old_code_does_not_pair(self):
        bot = self.bot()
        code = bot.pairing()["code"]
        wrong = f"{(int(code) + 1) % 1_000_000:06d}"
        bot.handle(message(42, f"/start {wrong}"))
        bot.handle(message(42, "/start"))
        bot.handle(message(42, "Öffne Spotify"))
        self.assertEqual(bot.chat_id, 0)
        bot._pair_until = time.monotonic() - 1  # 15 Minuten vorbei
        bot.handle(message(42, f"/start {code}"))
        self.assertEqual(bot.chat_id, 0)
        self.assertEqual(self.assistant.commands, [])
        self.assertTrue(all("Jarvis-Fenster" in t for t in self.api.texts(42)))

    def test_code_works_only_once(self):
        bot = self.bot()
        code = bot.pairing()["code"]
        bot.handle(message(42, f"/start {code}"))
        bot.unpair()
        bot.handle(message(77, f"/start {code}"))
        self.assertEqual(bot.chat_id, 0)

    def test_strangers_get_one_answer_and_nothing_happens(self):
        bot = self.bot(chat_id=42)
        bot.handle(message(99, "Lösche alle Dateien"))
        bot.handle(message(99, "Öffne Spotify"))
        bot.handle(message(99, "/start 123456"))
        time.sleep(0.2)
        self.assertEqual(self.api.texts(99), ["Dieser Jarvis gehört jemand anderem."])
        self.assertEqual(self.assistant.commands, [])
        self.assertEqual(bot.chat_id, 42)

    # -------------------------------------------------------------- Nachrichten

    def test_text_command(self):
        bot = self.bot(chat_id=42)
        bot.handle(message(42, "Öffne Spotify"))
        self.api.wait_for("sendMessage")
        self.assertEqual(self.assistant.commands, [("Öffne Spotify", False)])
        self.assertEqual(self.api.sent("sendChatAction")[0]["action"], "typing")
        self.assertEqual(self.api.texts(42), ["Spotify ist offen, Sir."])
        self.assertEqual(self.api.sent("sendVoice"), [], "auf Text kommt nur Text")

    def test_help(self):
        bot = self.bot(chat_id=42)
        bot.handle(message(42, "/start"))
        self.assertIn("Sprachnachricht", self.api.texts(42)[0])
        self.assertEqual(self.assistant.commands, [])

    def test_failed_command_still_answers(self):
        bot = self.bot(chat_id=42)

        def broken(text, speak=True):
            raise RuntimeError("kaputt")

        self.assistant.handle = broken
        bot._answer("Öffne Spotify", False)
        self.assertEqual(self.api.texts(42), ["Das hat leider nicht geklappt, Sir."])

    @unittest.skipUnless(has_opus(), "PyAV fehlt")
    def test_voice_message(self):
        bot = self.bot(chat_id=42)
        self.api.files["voice/abc.oga"] = b"OggS-aufnahme"
        bot.handle(message(42, voice={"file_id": "abc", "file_size": 13, "duration": 2}))
        self.api.wait_for("sendVoice")
        self.assertEqual(self.assistant.audio, [b"OggS-aufnahme"])
        self.assertEqual(self.assistant.commands, [("Öffne Spotify", False)])
        self.assertEqual(self.api.texts(42), ["Spotify ist offen, Sir."])
        upload = self.api.sent("sendVoice")[0]["raw"]
        self.assertIn(b'name="voice"; filename="jarvis.ogg"', upload)
        self.assertIn(b"OggS", upload)
        self.assertIn(b"OpusHead", upload)

    def test_voice_answer_can_be_switched_off(self):
        bot = self.bot(chat_id=42, sprache=False)
        self.api.files["voice/abc.oga"] = b"OggS-aufnahme"
        bot._voice({"file_id": "abc"})
        self.assertEqual(self.api.texts(42), ["Spotify ist offen, Sir."])
        self.assertEqual(self.api.sent("sendVoice"), [])

    def test_voice_nothing_understood(self):
        bot = self.bot(chat_id=42)
        self.assistant.heard = ""
        self.api.files["voice/abc.oga"] = b"x"
        bot._voice({"file_id": "abc"})
        self.assertEqual(self.assistant.commands, [])
        self.assertIn("Sir", self.api.texts(42)[0])

    def test_voice_too_long_or_missing(self):
        bot = self.bot(chat_id=42)
        bot._voice({"file_id": "gross", "file_size": telegram.MAX_VOICE_BYTES + 1})
        bot._voice({"file_id": "fehlt"})  # Telegram liefert die Datei nicht
        self.assertEqual(self.api.texts(42), ["Die Sprachnachricht ist mir zu lang, Sir.",
                                              "Die Sprachnachricht konnte ich leider nicht anhören, Sir."])
        self.assertEqual(self.assistant.audio, [])

    def test_notify_only_when_on_and_paired(self):
        self.assertFalse(self.bot(chat_id=0).notify("Termin in 10 Minuten"))
        self.assertFalse(self.bot(chat_id=42, aktiv=False).notify("Termin in 10 Minuten"))
        self.assertTrue(self.bot(chat_id=42).notify("Termin in 10 Minuten"))
        self.assertEqual(self.api.texts(), ["Termin in 10 Minuten"])

    def test_long_text_is_cut(self):
        bot = self.bot(chat_id=42)
        bot.send("x" * 5000)
        self.assertEqual(len(self.api.texts(42)[0]), 4000)

    # -------------------------------------------------------------- Hintergrund

    def test_polling_pairs_and_answers(self):
        bot = self.bot()
        code = bot.pairing()["code"]
        self.assertTrue(bot.start())
        self.assertFalse(bot.start(), "läuft schon")
        self.api.push({"update_id": 500, "message": message(42, f"/start {code}")})
        self.wait_until(lambda: bot.chat_id == 42)
        self.api.push({"update_id": 501, "message": message(42, "Öffne Spotify")})
        self.wait_until(lambda: "Spotify ist offen, Sir." in self.api.texts(42))
        self.assertEqual(bot._offset, 502)
        self.assertEqual(self.assistant.commands, [("Öffne Spotify", False)], "jede Nachricht nur einmal")
        bot.stop()
        self.wait_until(lambda: not bot._thread.is_alive())

    def test_off_and_on_again_keeps_answering(self):
        bot = self.bot(chat_id=42)
        self.assertTrue(bot.start())
        self.api.wait_for("getUpdates")  # wartet gerade auf Telegram
        bot.stop()
        self.assertTrue(bot.start(), "gleich wieder an, ohne Jarvis neu zu starten")
        self.assertTrue(bot.running)
        self.api.push({"update_id": 600, "message": message(42, "Öffne Spotify")})
        self.wait_until(lambda: "Spotify ist offen, Sir." in self.api.texts(42))
        time.sleep(1.2)  # auch die alte Runde hat ihre Antwort von Telegram bekommen
        self.assertEqual(self.assistant.commands, [("Öffne Spotify", False)], "nur einmal erledigt")
        self.assertEqual(bot._offset, 601)

    def test_dropped_connection_does_not_end_polling(self):
        import http.client
        import urllib.request
        from unittest import mock

        bot = self.bot(chat_id=42)
        real = urllib.request.urlopen
        dropped = []

        def flaky(request, *args, **kwargs):
            if not dropped:  # die Leitung bricht mitten in der Antwort ab
                dropped.append(request.full_url)
                raise http.client.IncompleteRead(b"")
            return real(request, *args, **kwargs)

        with mock.patch("urllib.request.urlopen", flaky):
            self.assertTrue(bot.start())
            self.wait_until(lambda: dropped)
            self.api.push({"update_id": 700, "message": message(42, "Öffne Spotify")})
            self.wait_until(lambda: "Spotify ist offen, Sir." in self.api.texts(42), timeout=10)
        self.assertNotIn(TOKEN, bot.last_error)

    def test_dropped_connection_is_a_telegram_error_without_the_key(self):
        import http.client
        from unittest import mock

        bot = self.bot(chat_id=42)
        with mock.patch("urllib.request.urlopen", side_effect=http.client.IncompleteRead(b"")):
            with self.assertRaises(telegram.TelegramError) as caught:
                bot._call("getMe")
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_new_bot_is_asked_right_away(self):
        self.api.tokens.add(OTHER)
        bot = self.bot(chat_id=42)
        self.assertTrue(bot.start())
        self.api.wait_for("getUpdates")
        old = bot._thread
        bot.use_token(OTHER, "anderer_bot")  # während die alte Runde noch auf Telegram wartet
        self.assertIsNot(bot._thread, old, "eine neue Runde mit dem neuen Bot")
        self.assertTrue(bot.running)
        code = bot.pairing()["code"]
        self.api.push({"update_id": 7, "message": message(43, f"/start {code}")})
        self.wait_until(lambda: bot.chat_id == 43)

    def test_off_does_not_poll(self):
        bot = self.bot(aktiv=False)
        self.assertFalse(bot.start())
        self.assertFalse(bot.running)


class AwayTest(unittest.TestCase):
    """Ansagen kommen über Telegram, aber nur, wenn Georg nicht am PC sitzt."""

    def setUp(self):
        from unittest import mock

        from tests.test_assistant import FakeBrain, make as make_assistant

        self.mock = mock
        self.assistant, self.ui, self.speaker, _ = make_assistant(FakeBrain())
        self.bot = mock.Mock(enabled=True, chat_id=42)
        self.assistant.telegram = self.bot
        self.assistant.push = None

    def announce(self, present, text="Erinnerung, Sir: Tee"):
        with self.mock.patch.object(self.assistant, "_present", return_value=present), \
                self.mock.patch.object(self.assistant, "_fullscreen", return_value=False):
            self.assistant.announce(text)
        time.sleep(0.1)

    def test_away_gets_a_message(self):
        self.announce(present=False)
        self.bot.notify.assert_called_once_with("Erinnerung, Sir: Tee")
        self.assertEqual(self.speaker.said[-1], "Erinnerung, Sir: Tee", "am PC wird es trotzdem gesagt")

    def test_at_the_pc_no_message(self):
        self.announce(present=True)
        self.bot.notify.assert_not_called()

    def test_not_paired_no_message(self):
        self.bot.chat_id = 0
        self.announce(present=False)
        self.bot.notify.assert_not_called()


class WindowTest(unittest.TestCase):
    """Verbinden > Telegram: Schlüssel prüfen und speichern, Link zeigen, ausschalten. Der Schlüssel geht nie ans Fenster."""

    def test_setup_pairing_and_off(self):
        import tempfile
        from pathlib import Path
        from unittest import mock

        from jarvis.config import save_setting
        from jarvis.gui.app import Api

        fake = FakeTelegram(tokens=(TOKEN, OTHER))
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as folder, mock.patch("jarvis.config.CONFIG_PATH", Path(folder) / "config.toml"):
            config = Path(folder) / "config.toml"
            bot = TelegramBot({}, FakeAssistant(), save=save_setting, api=fake.url, poll_timeout=1)
            self.addCleanup(bot.stop)
            api = Api.__new__(Api)
            api._assistant = mock.Mock(_cfg={}, telegram=bot)
            api._bridge = mock.Mock()

            info = api.telegram_info()
            self.assertEqual((info["enabled"], info["has_token"], info["paired"]), (False, False, False))
            self.assertFalse(api.telegram_setup("")["ok"])
            bad = api.telegram_setup("kein Schlüssel")
            self.assertFalse(bad["ok"])
            self.assertIn("Bot-Schlüssel", bad["error"])
            self.assertFalse(config.exists())

            result = api.telegram_setup(f"  {TOKEN} ")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["name"], "jarvis_georg_bot")
            self.assertTrue(result["link"].startswith("https://t.me/jarvis_georg_bot?start="))
            try:
                import qrcode  # noqa: F401
            except ImportError:  # optional: ohne steht im Fenster der Link zum Antippen
                self.assertEqual(result["qr"], "")
            else:
                self.assertIn("<svg", result["qr"])
            self.assertTrue(result["running"])
            self.assertNotIn(TOKEN, json.dumps(result), "der Schlüssel bleibt im PC")
            text = config.read_text(encoding="utf-8")
            self.assertIn(f'token = "{TOKEN}"', text)
            self.assertIn("aktiv = true", text)

            bot.handle(message(42, f"/start {result['code']}"))
            self.assertTrue(api.telegram_info()["paired"])
            self.assertIn("chat_id = 42", config.read_text(encoding="utf-8"))
            self.assertTrue(api.connections()["telegram"])
            self.assertTrue(api.telegram_test()["ok"])

            again = api.telegram_setup(TOKEN)  # gleicher Bot: bleibt verbunden, kein neuer Link
            self.assertEqual((again["paired"], again["link"]), (True, ""))
            moved = api.telegram_new_pairing()  # anderes Handy
            self.assertFalse(moved["paired"])
            self.assertRegex(moved["code"], r"^\d{6}$")

            self.assertFalse(api.telegram_voice(False)["voice"])
            self.assertIn("sprache = false", config.read_text(encoding="utf-8"))
            off = api.telegram_off()
            self.assertFalse(off["enabled"])
            self.assertIn("aktiv = false", config.read_text(encoding="utf-8"))
            self.assertFalse(api.connections()["telegram"])


@unittest.skipUnless(has_opus(), "PyAV fehlt")
class OggOpusTest(unittest.TestCase):
    def test_wav_to_voice_message(self):
        import av

        data = telegram.ogg_opus(tone_wav(1.0, 22050))
        self.assertTrue(data.startswith(b"OggS"))
        with av.open(io.BytesIO(data)) as container:
            stream = container.streams.audio[0]
            self.assertEqual(stream.codec_context.name, "opus")
            samples = sum(frame.samples for frame in container.decode(stream))
        self.assertAlmostEqual(samples / 48000, 1.0, delta=0.1)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
