"""Benachrichtigungen aufs Handy über ntfy.sh."""

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.push import Push, new_topic

TOPIC = "jarvis-" + "a" * 24


class FakeNtfy:
    def __init__(self, busy=0):
        self.sent = []
        self.busy = busy  # so oft bremst ntfy.sh zuerst (429)

    def __call__(self, request, timeout=None):
        if self.busy:
            self.busy -= 1
            raise urllib.error.HTTPError(request.full_url, 429, "Too Many", {}, io.BytesIO(b""))
        self.sent.append((request.full_url, json.loads(request.data.decode("utf-8"))))
        return io.BytesIO(b"{}")


def make(enabled=True, fake=None):
    fake = fake or FakeNtfy()
    push = Push({"handy": {"push": enabled, "push_kanal": TOPIC}}, opener=fake, sleep=lambda s: None)
    return push, fake


class PushTest(unittest.TestCase):
    def test_sends_json_to_the_topic(self):
        push, fake = make()
        self.assertTrue(push.send("Erinnerung, Sir: Tee", priority=4, click="http://192.168.1.20:8765/app/", wait=True))
        url, payload = fake.sent[0]
        self.assertEqual(url, "https://ntfy.sh/")
        self.assertEqual((payload["topic"], payload["message"], payload["priority"], payload["click"]),
                         (TOPIC, "Erinnerung, Sir: Tee", 4, "http://192.168.1.20:8765/app/"))
        self.assertEqual(push.subscribe_url, f"https://ntfy.sh/{TOPIC}")

    def test_off_or_without_topic_sends_nothing(self):
        push, fake = make(enabled=False)
        self.assertFalse(push.send("Hallo", wait=True))
        push = Push({"handy": {"push": True, "push_kanal": ""}}, opener=fake)
        self.assertFalse(push.enabled)
        self.assertEqual(fake.sent, [])

    def test_same_text_only_once_a_minute_and_retry_when_busy(self):
        push, fake = make(fake=FakeNtfy(busy=1))
        self.assertTrue(push.send("Aus der Werkstatt: fertig.", wait=True))
        self.assertFalse(push.send("Aus der Werkstatt: fertig.", wait=True))
        self.assertEqual(len(fake.sent), 1)

    def test_new_topic_is_long_and_random(self):
        first, second = new_topic(), new_topic()
        self.assertTrue(first.startswith("jarvis-") and len(first) == 31)
        self.assertNotEqual(first, second)


class AnnounceTest(unittest.TestCase):
    """Ansagen kommen aufs Handy, aber nur, wenn Georg nicht am PC sitzt."""

    def setUp(self):
        from tests.test_assistant import FakeBrain, make as make_assistant

        self.assistant, self.ui, self.speaker, _ = make_assistant(FakeBrain())
        self.push, self.fake = make()
        self.assistant.push = self.push

    def test_away_gets_a_notification(self):
        with mock.patch.object(self.assistant, "_present", return_value=False), \
                mock.patch.object(self.push, "send", wraps=self.push.send) as sent:
            self.assistant.announce("Erinnerung, Sir: Tee")
        self.assertEqual(self.speaker.said[-1], "Erinnerung, Sir: Tee", "am PC wird es trotzdem gesagt")
        self.assertEqual(sent.call_args.args[0], "Erinnerung, Sir: Tee")
        self.assertEqual(sent.call_args.kwargs["priority"], 4)

    def test_at_the_pc_no_notification(self):
        with mock.patch.object(self.assistant, "_present", return_value=True), \
                mock.patch.object(self.push, "send") as sent:
            self.assistant.announce("Spotify ist installiert, Sir.")
        sent.assert_not_called()


class WindowSwitchTest(unittest.TestCase):
    def test_enable_creates_a_topic_and_test_sends(self):
        from jarvis.gui.app import Api

        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.toml"
            cfg = {}
            api = Api.__new__(Api)
            api._assistant = mock.Mock(_cfg=cfg, push=None)
            api._bridge = mock.Mock()
            with mock.patch("jarvis.config.CONFIG_PATH", config):
                info = api.push_enable(True)
            self.assertTrue(info["enabled"])
            self.assertTrue(info["topic"].startswith("jarvis-"))
            self.assertIn(f'push_kanal = "{info["topic"]}"', config.read_text(encoding="utf-8"))
            self.assertIn("push = true", config.read_text(encoding="utf-8"))
            fake = FakeNtfy()
            api._assistant.push._open = fake
            self.assertTrue(api.push_test()["ok"])
            self.assertEqual(fake.sent[0][1]["topic"], info["topic"])
            with mock.patch("jarvis.config.CONFIG_PATH", config):
                self.assertFalse(api.push_enable(False)["enabled"])
            self.assertFalse(api.push_test()["ok"])
