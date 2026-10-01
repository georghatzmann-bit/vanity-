"""Discord-Server gestalten, im Hintergrund, ohne Maus: über einen eigenen Discord-Bot.

Georg legt einmal einen Bot an (Discord Developer Portal, zwei Minuten) und lädt ihn mit
Administratorrechten auf seinen Server ein. Dann kann Jarvis, während Georg zockt:
Kategorien, Text- und Sprachkanäle und Rollen anlegen, umbenennen, sortieren, Themen
setzen, Begrüßungs- und Regel-Nachrichten posten und Einladungen erzeugen. Löschen nur
nach Georgs Ja.

Pläne als JSON (das Gehirn schreibt sie, apply_plan setzt sie um, ohne Doppeltes):
{"kategorien": [{"name": "Info", "kanaele": [{"name": "regeln", "typ": "text", "thema": "..."}]}],
 "rollen": [{"name": "Admin", "farbe": "#e74c3c", "anzeigen": true}],
 "nachrichten": [{"kanal": "regeln", "text": "..."}]}
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

API = "https://discord.com/api/v10"
USER_AGENT = "DiscordBot (https://github.com/georghatzmann-bit/vanity-, 2.0)"
TYPES = {"text": 0, "sprache": 2, "voice": 2, "kategorie": 4, "ankuendigung": 5, "ankündigung": 5, "buehne": 13,
         "bühne": 13, "forum": 15}
TYPE_NAMES = {0: "Text", 2: "Sprache", 4: "Kategorie", 5: "Ankündigung", 13: "Bühne", 15: "Forum"}
ADMIN = 8  # Berechtigung "Administrator"


class DiscordError(RuntimeError):
    """Etwas ging nicht. Der Text ist für Georg gedacht."""


def _key(name: str) -> str:
    """Kanalnamen vergleichen: Discord macht aus "Allgemeiner Chat" "allgemeiner-chat"."""
    text = re.sub(r"[^\w]+", "-", str(name).lower(), flags=re.UNICODE).strip("-")
    return text


def _color(value) -> int:
    if isinstance(value, int):
        return value
    text = str(value or "").strip().lstrip("#")
    try:
        return int(text, 16) if text else 0
    except ValueError:
        return 0


class DiscordBot:
    def __init__(self, token: str, opener=None, sleep=time.sleep) -> None:
        self._token = str(token or "").strip()
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep

    @property
    def configured(self) -> bool:
        return len(self._token) > 50

    # ------------------------------------------------------------------ Anfragen

    def request(self, method: str, path: str, body: dict | None = None, reason: str = "") -> dict | list | None:
        if not self.configured:
            raise DiscordError("Der Discord-Bot ist noch nicht eingerichtet (Jarvis-Fenster: Verbinden, Bereich Discord).")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        for attempt in range(5):
            request = urllib.request.Request(API + path, data=data, method=method, headers={
                "Authorization": f"Bot {self._token}", "User-Agent": USER_AGENT, "Content-Type": "application/json",
                **({"X-Audit-Log-Reason": urllib.parse.quote(reason)} if reason else {}),
            })
            try:
                with self._open(request, timeout=15) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as exc:
                text = exc.read().decode("utf-8", "replace")
                if exc.code == 429 and attempt < 4:
                    try:
                        wait = float(json.loads(text).get("retry_after", 1))
                    except ValueError:
                        wait = 1.0
                    self._sleep(min(wait, 10.0) + 0.1)
                    continue
                if exc.code == 401:
                    raise DiscordError("Discord lehnt den Bot-Token ab. Bitte im Developer Portal einen neuen erzeugen.") from exc
                if exc.code == 403:
                    raise DiscordError("Dem Bot fehlen Rechte auf diesem Server. Bitte mit Administratorrechten neu einladen.") from exc
                if exc.code == 404:
                    raise DiscordError("Das gibt es auf Discord nicht (mehr).") from exc
                raise DiscordError(f"Discord meldet Fehler {exc.code}: {text[:200]}") from exc
            except (urllib.error.URLError, OSError) as exc:
                raise DiscordError(f"Discord ist gerade nicht erreichbar ({exc}).") from exc
        raise DiscordError("Discord bremst gerade (zu viele Anfragen). Bitte gleich noch einmal.")

    # ------------------------------------------------------------------ Lesen

    def me(self) -> dict:
        return self.request("GET", "/users/@me") or {}

    def application_id(self) -> str:
        app = self.request("GET", "/oauth2/applications/@me") or {}
        return str(app.get("id") or self.me().get("id") or "")

    def invite_url(self) -> str:
        """Link, mit dem Georg den Bot auf seinen Server holt (mit Administratorrechten)."""
        return ("https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(
            {"client_id": self.application_id(), "scope": "bot applications.commands", "permissions": str(ADMIN)}))

    def guilds(self) -> list[dict]:
        return list(self.request("GET", "/users/@me/guilds") or [])

    def guild(self, name: str = "") -> dict:
        """Der Server mit diesem Namen, ohne Namen der erste (meist hat Georg nur einen)."""
        items = self.guilds()
        if not items:
            raise DiscordError("Der Bot ist noch auf keinem Server. Bitte zuerst einladen.")
        if not name:
            return items[0]
        wanted = _key(name)
        for item in items:
            if _key(item.get("name", "")) == wanted:
                return item
        for item in items:
            if wanted in _key(item.get("name", "")):
                return item
        raise DiscordError(f"Einen Server namens {name} kennt der Bot nicht. Er ist auf: "
                           + ", ".join(i.get("name", "?") for i in items) + ".")

    def channels(self, guild_id: str) -> list[dict]:
        return list(self.request("GET", f"/guilds/{guild_id}/channels") or [])

    def roles(self, guild_id: str) -> list[dict]:
        return list(self.request("GET", f"/guilds/{guild_id}/roles") or [])

    def structure(self, guild_name: str = "") -> str:
        """Der Server als Text: Kategorien mit Kanälen, dann Rollen (für Vorschläge des Gehirns)."""
        guild = self.guild(guild_name)
        channels = self.channels(guild["id"])
        lines = [f"Server: {guild.get('name')} (id {guild['id']})"]
        by_parent: dict = {}
        for channel in channels:
            by_parent.setdefault(channel.get("parent_id"), []).append(channel)
        for channel in sorted(by_parent.get(None, []), key=lambda c: (c.get("type") == 4, c.get("position", 0))):
            if channel.get("type") == 4:
                continue
            lines.append(f"- #{channel['name']} ({TYPE_NAMES.get(channel.get('type'), channel.get('type'))})")
        for category in sorted((c for c in channels if c.get("type") == 4), key=lambda c: c.get("position", 0)):
            lines.append(f"Kategorie {category['name']}:")
            for channel in sorted(by_parent.get(category["id"], []), key=lambda c: c.get("position", 0)):
                topic = f" – {channel['topic']}" if channel.get("topic") else ""
                lines.append(f"  - #{channel['name']} ({TYPE_NAMES.get(channel.get('type'), channel.get('type'))}){topic}")
        roles = [r for r in self.roles(guild["id"]) if r.get("name") != "@everyone" and not r.get("managed")]
        if roles:
            lines.append("Rollen: " + ", ".join(r["name"] for r in sorted(roles, key=lambda r: -r.get("position", 0))))
        return "\n".join(lines)

    # ------------------------------------------------------------------ Schreiben

    def find_channel(self, guild_id: str, name: str, kind: int | None = None) -> dict | None:
        wanted = _key(name.lstrip("#"))
        for channel in self.channels(guild_id):
            if _key(channel.get("name", "")) == wanted and (kind is None or channel.get("type") == kind):
                return channel
        return None

    def create_channel(self, guild_id: str, name: str, kind: str = "text", category: str = "", topic: str = "") -> dict:
        body: dict = {"name": name, "type": TYPES.get(str(kind).lower(), 0)}
        if category:
            parent = self.find_channel(guild_id, category, 4) or self.create_channel(guild_id, category, "kategorie")
            body["parent_id"] = parent["id"]
        if topic and body["type"] in (0, 5, 15):
            body["topic"] = topic[:1024]
        return self.request("POST", f"/guilds/{guild_id}/channels", body, reason="Jarvis") or {}

    def create_role(self, guild_id: str, name: str, color="", hoist: bool = False) -> dict:
        return self.request("POST", f"/guilds/{guild_id}/roles",
                            {"name": name, "color": _color(color), "hoist": bool(hoist), "mentionable": True},
                            reason="Jarvis") or {}

    def send(self, channel_id: str, text: str) -> dict:
        return self.request("POST", f"/channels/{channel_id}/messages", {"content": str(text)[:2000]}) or {}

    def invite(self, channel_id: str) -> str:
        data = self.request("POST", f"/channels/{channel_id}/invites", {"max_age": 0, "max_uses": 0}, reason="Jarvis") or {}
        return f"https://discord.gg/{data.get('code', '')}"

    def delete_channel(self, channel_id: str) -> None:
        self.request("DELETE", f"/channels/{channel_id}", reason="Jarvis")

    def apply_plan(self, plan: dict, guild_name: str = "") -> list[str]:
        """Setzt einen Plan um. Was es schon gibt (gleicher Name), bleibt und wird höchstens
        einsortiert oder bekommt das Thema. Gibt die Änderungen als Sätze zurück."""
        if not isinstance(plan, dict):
            raise DiscordError("Der Plan muss ein JSON-Objekt sein.")
        guild = self.guild(guild_name or str(plan.get("server") or ""))
        gid = guild["id"]
        done: list[str] = []
        existing = self.channels(gid)

        def lookup(name: str, kind: int) -> dict | None:
            wanted = _key(name)
            return next((c for c in existing if _key(c.get("name", "")) == wanted and c.get("type") == kind), None)

        for number, category in enumerate(plan.get("kategorien") or []):
            cname = str(category.get("name") or "").strip()
            if not cname:
                continue
            parent = lookup(cname, 4)
            if parent is None:
                parent = self.request("POST", f"/guilds/{gid}/channels", {"name": cname, "type": 4, "position": number},
                                      reason="Jarvis") or {}
                existing.append(parent)
                done.append(f"Kategorie {cname} angelegt")
            for item in category.get("kanaele") or category.get("kanäle") or []:
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                kind = TYPES.get(str(item.get("typ") or "text").lower(), 0)
                topic = str(item.get("thema") or "")[:1024]
                channel = lookup(name, kind)
                if channel is None:
                    body = {"name": name, "type": kind, "parent_id": parent.get("id")}
                    if topic and kind in (0, 5, 15):
                        body["topic"] = topic
                    channel = self.request("POST", f"/guilds/{gid}/channels", body, reason="Jarvis") or {}
                    existing.append(channel)
                    done.append(f"{TYPE_NAMES.get(kind, 'Kanal')}-Kanal {name} angelegt")
                    continue
                change: dict = {}
                if parent.get("id") and channel.get("parent_id") != parent.get("id"):
                    change["parent_id"] = parent["id"]
                if topic and kind in (0, 5, 15) and channel.get("topic") != topic:
                    change["topic"] = topic
                if change:
                    self.request("PATCH", f"/channels/{channel['id']}", change, reason="Jarvis")
                    channel.update(change)
                    done.append(f"{name} {'einsortiert' if 'parent_id' in change else 'mit Thema'}")
        known_roles = {_key(r.get("name", "")) for r in self.roles(gid)}
        for role in plan.get("rollen") or []:
            name = str(role.get("name") or "").strip()
            if name and _key(name) not in known_roles:
                self.create_role(gid, name, role.get("farbe", ""), bool(role.get("anzeigen", False)))
                known_roles.add(_key(name))
                done.append(f"Rolle {name} angelegt")
        for message in plan.get("nachrichten") or []:
            target = lookup(str(message.get("kanal") or ""), 0) or lookup(str(message.get("kanal") or ""), 5)
            if target and str(message.get("text") or "").strip():
                self.send(target["id"], str(message["text"]))
                done.append(f"Nachricht in {target.get('name')} gepostet")
        return done
