"""Discord-Server im Hintergrund gestalten: Jarvis' Bot über die Discord-Schnittstelle."""

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.discord_bot import API, DiscordBot, DiscordError

TOKEN = "x" * 72


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeDiscord:
    """Merkt sich Server, Kanäle und Rollen wie Discord. Die erste Anfrage bremst einmal (429)."""

    def __init__(self, throttle=True):
        self.channels = [{"id": "c1", "name": "allgemein", "type": 0, "parent_id": None, "position": 0}]
        self.roles = [{"id": "r0", "name": "@everyone", "position": 0}]
        self.messages = []
        self.calls = []
        self.throttle = throttle
        self.ids = 100

    def __call__(self, request, timeout=None):
        path = request.full_url[len(API):]
        method = request.get_method()
        body = json.loads(request.data) if request.data else None
        self.calls.append((method, path, body))
        assert request.headers["Authorization"] == f"Bot {TOKEN}"
        if self.throttle:
            self.throttle = False
            raise urllib.error.HTTPError(request.full_url, 429, "Too Many", {}, io.BytesIO(b'{"retry_after": 0.01}'))
        if path == "/users/@me":
            return self.reply({"id": "999", "username": "Jarvis"})
        if path == "/oauth2/applications/@me":
            return self.reply({"id": "999"})
        if path == "/users/@me/guilds":
            return self.reply([{"id": "g1", "name": "Georgs Gaming-Zentrale"}])
        if path == "/guilds/g1/channels" and method == "GET":
            return self.reply(self.channels)
        if path == "/guilds/g1/channels" and method == "POST":
            self.ids += 1
            channel = dict(body, id=f"c{self.ids}", position=len(self.channels))
            channel["name"] = channel["name"].lower().replace(" ", "-") if channel["type"] == 0 else channel["name"]
            self.channels.append(channel)
            return self.reply(channel)
        if path.startswith("/channels/") and method == "PATCH":
            channel = next(c for c in self.channels if c["id"] == path.split("/")[2])
            channel.update(body)
            return self.reply(channel)
        if path == "/guilds/g1/roles" and method == "GET":
            return self.reply(self.roles)
        if path == "/guilds/g1/roles" and method == "POST":
            self.ids += 1
            role = dict(body, id=f"r{self.ids}", position=len(self.roles))
            self.roles.append(role)
            return self.reply(role)
        if "/messages" in path and method == "GET":
            channel = path.split("/")[2]
            return self.reply([{"id": f"m{n}", "content": text, "author": {"id": "999"}}
                               for n, (cid, text) in enumerate(self.messages) if cid == channel][::-1])
        if path.endswith("/messages"):
            self.messages.append((path.split("/")[2], body["content"]))
            return self.reply({"id": "m1"})
        if path.endswith("/invites"):
            return self.reply({"code": "abc123"})
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b"{}"))

    @staticmethod
    def reply(data):
        return Response(json.dumps(data).encode())


PLAN = {
    "kategorien": [
        {"name": "Info", "kanaele": [{"name": "regeln", "typ": "text", "thema": "Bitte lesen"},
                                     {"name": "allgemein", "typ": "text"}]},
        {"name": "Gaming", "kanaele": [{"name": "Zocken", "typ": "sprache"}, {"name": "clips", "typ": "text"}]},
    ],
    "rollen": [{"name": "Admin", "farbe": "#e74c3c", "anzeigen": True}, {"name": "Gamer", "farbe": "#3498db"}],
    "nachrichten": [{"kanal": "regeln", "text": "Willkommen! Seid nett zueinander."}],
}


class BotTest(unittest.TestCase):
    def setUp(self):
        self.discord = FakeDiscord()
        self.bot = DiscordBot(TOKEN, opener=self.discord, sleep=lambda s: None)

    def test_plan_is_applied_once(self):
        done = self.bot.apply_plan(PLAN)
        self.assertIn("Kategorie Info angelegt", done)
        self.assertIn("Sprache-Kanal Zocken angelegt", done)
        self.assertIn("allgemein einsortiert", done, "der vorhandene Kanal kommt in die Kategorie")
        self.assertIn("Rolle Admin angelegt", done)
        self.assertIn("Nachricht in regeln gepostet", done)
        names = [(c["name"], c["type"]) for c in self.discord.channels]
        self.assertEqual(names.count(("allgemein", 0)), 1, "nichts doppelt")
        regeln = next(c for c in self.discord.channels if c["name"] == "regeln")
        self.assertEqual(regeln["topic"], "Bitte lesen")
        admin = next(r for r in self.discord.roles if r["name"] == "Admin")
        self.assertEqual((admin["color"], admin["hoist"]), (0xE74C3C, True))
        self.assertEqual(self.discord.messages, [(regeln["id"], "Willkommen! Seid nett zueinander.")])
        # zweites Mal (etwa nach einem Abbruch): alles ist schon da, auch die Nachricht nicht doppelt
        again = self.bot.apply_plan(PLAN)
        self.assertEqual(again, [])
        self.assertEqual(len(self.discord.messages), 1)
        # Ein neuer Text kommt dagegen raus
        self.bot.apply_plan(dict(PLAN, nachrichten=[{"kanal": "regeln", "text": "Neu: Freitag ist Turnier."}]))
        self.assertEqual(self.discord.messages[-1], (regeln["id"], "Neu: Freitag ist Turnier."))

    def test_structure_and_invites(self):
        self.bot.apply_plan(PLAN)
        text = self.bot.structure()
        self.assertIn("Server: Georgs Gaming-Zentrale", text)
        self.assertIn("Kategorie Gaming:", text)
        self.assertIn("#Zocken (Sprache)", text)
        self.assertIn("Rollen: ", text)
        self.assertEqual(self.bot.invite("c1"), "https://discord.gg/abc123")
        self.assertIn("client_id=999", self.bot.invite_url())
        self.assertIn("permissions=8", self.bot.invite_url())

    def test_errors_are_understandable(self):
        def refuse(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))

        with self.assertRaisesRegex(DiscordError, "Token ab"):
            DiscordBot(TOKEN, opener=refuse).me()
        with self.assertRaisesRegex(DiscordError, "nicht eingerichtet"):
            DiscordBot("").me()
        with self.assertRaisesRegex(DiscordError, "keinen Server|kennt der Bot nicht"):
            self.bot.guild("Fremder Server")

    def test_tool_applies_a_plan_file(self):
        from jarvis import tool

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "plan.json"
            path.write_text(json.dumps(PLAN), encoding="utf-8")
            cfg = tool.load_config()
            cfg["discord"] = {"bot_token": TOKEN}
            out = io.StringIO()
            with mock.patch.object(tool, "load_config", return_value=cfg), \
                    mock.patch("jarvis.discord_bot.urllib.request.urlopen", self.discord), \
                    mock.patch("jarvis.discord_bot.time.sleep"), \
                    mock.patch("sys.stdout", out):
                self.assertEqual(tool.main(["discord-bot", "plan", str(path)]), 0)
            self.assertIn("Kategorie Info angelegt", out.getvalue())

    def test_deleting_a_channel_needs_a_yes(self):
        from jarvis import tool

        cfg = tool.load_config()
        cfg["discord"] = {"bot_token": TOKEN}
        out = io.StringIO()
        with mock.patch.object(tool, "load_config", return_value=cfg), \
                mock.patch("jarvis.discord_bot.urllib.request.urlopen", self.discord), \
                mock.patch.object(tool, "last_said", return_value="Lösch den Kanal allgemein"), \
                mock.patch("sys.stdout", out):
            self.assertEqual(tool.main(["discord-bot", "kanal-loeschen", "allgemein"]), 3)
        self.assertFalse(any(m == "DELETE" for m, _p, _b in self.discord.calls))


if __name__ == "__main__":
    unittest.main()
