"""Home Assistant und Alexa: Jarvis spricht über deine Echos und schaltet Geräte.

Braucht in Home Assistant die Integration "Alexa Media Player" (über HACS) und
einen langlebigen Zugriffsschlüssel (Profil > Sicherheit > Langlebige Zugriffstoken).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger(__name__)


class HomeAssistantError(RuntimeError):
    pass


class HomeAssistant:
    def __init__(self, cfg: dict, timeout: float = 8.0) -> None:
        self.url = (cfg.get("url") or "").rstrip("/")
        self._token = cfg.get("token") or ""
        self.alexa: dict = dict(cfg.get("alexa") or {})
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.url and self._token)

    def _request(self, method: str, path: str, body: dict | None = None):
        if not self.configured:
            raise HomeAssistantError(
                "Home Assistant ist noch nicht eingerichtet. Trag url und token in config.toml "
                "unter [homeassistant] ein."
            )
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self.url + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8") or "null"
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise HomeAssistantError("Home Assistant lehnt den Zugriffsschlüssel ab (token prüfen).") from exc
            if exc.code == 404:
                raise HomeAssistantError(f"Home Assistant kennt {path} nicht.") from exc
            raise HomeAssistantError(f"Home Assistant meldet Fehler {exc.code}.") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise HomeAssistantError(f"Home Assistant unter {self.url} nicht erreichbar ({exc}).") from exc

    def ping(self) -> str:
        data = self._request("GET", "/api/")
        return (data or {}).get("message", "ok")

    def states(self) -> list[dict]:
        return self._request("GET", "/api/states") or []

    def state(self, entity_id: str) -> dict:
        return self._request("GET", f"/api/states/{entity_id}") or {}

    def call(self, domain: str, service: str, data: dict | None = None):
        return self._request("POST", f"/api/services/{domain}/{service}", data or {})

    def find(self, name: str) -> str:
        """Findet eine Entität per ID ("light.wohnzimmer") oder Anzeigename ("Wohnzimmer Licht")."""
        if "." in name and " " not in name:
            return name
        wanted = name.lower().strip()
        matches = []
        for s in self.states():
            friendly = str((s.get("attributes") or {}).get("friendly_name", "")).lower()
            if wanted == friendly:
                return s["entity_id"]
            if wanted in friendly or wanted in s["entity_id"]:
                matches.append(s["entity_id"])
        switchable = [m for m in matches if m.split(".")[0] in ("light", "switch", "fan", "cover", "media_player", "climate", "scene", "script")]
        if switchable or matches:
            return (switchable or matches)[0]
        raise HomeAssistantError(f'Kein Gerät gefunden, das "{name}" heißt.')

    def turn(self, name: str, on: bool) -> str:
        entity = self.find(name)
        domain = entity.split(".")[0]
        if domain in ("scene", "script"):
            self.call(domain, "turn_on", {"entity_id": entity})
            return f"{entity} gestartet."
        self.call("homeassistant", "turn_on" if on else "turn_off", {"entity_id": entity})
        return f"{entity} ist {'an' if on else 'aus'}."

    def find_light(self, room: str = "") -> str:
        """Das Licht in einem Raum ("Wohnzimmer", "Küche") oder, ohne Raum, das erste Licht."""
        words = [_fold(w) for w in str(room).split() if w.strip()]
        lights = [s for s in self.states() if str(s.get("entity_id", "")).startswith(("light.", "switch."))]

        def text(state: dict) -> str:
            friendly = str((state.get("attributes") or {}).get("friendly_name", ""))
            return _fold(friendly) + " " + _fold(str(state.get("entity_id", "")))

        found = [s for s in lights if all(w in text(s) for w in words)] if words else lights
        if not found:
            raise HomeAssistantError(f"Kein Licht für {room or 'diesen Raum'} gefunden.")
        found.sort(key=lambda s: (not s["entity_id"].startswith("light."),
                                  not any(k in text(s) for k in ("licht", "lampe", "light"))))
        return found[0]["entity_id"]

    def light(self, room: str = "", on: bool = True, brightness: int | None = None) -> str:
        """Licht an/aus oder auf eine Helligkeit in Prozent ("Wohnzimmer", 30)."""
        entity = self.find_light(room)
        data: dict = {"entity_id": entity}
        if not on:
            self.call("homeassistant", "turn_off", data)
            return f"{entity} ist aus."
        if brightness is not None and entity.startswith("light."):
            data["brightness_pct"] = max(1, min(100, int(brightness)))
            self.call("light", "turn_on", data)
            return f"{entity} auf {data['brightness_pct']} Prozent."
        self.call("homeassistant", "turn_on", data)
        return f"{entity} ist an."

    def alexa_command(self, room: str, text: str) -> str:
        """Lässt ein Echo einen Sprachbefehl ausführen, als hätte Georg ihn gesagt (Alexa Media
        Player, "custom"): damit geht alles, was Alexa kann, z. B. "Schalte das Licht aus"."""
        target = self.alexa_target(room)
        if not target.startswith("media_player."):
            raise HomeAssistantError("Für Alexa-Befehle braucht es ein Echo als media_player in Home Assistant.")
        self.call("media_player", "play_media", {"entity_id": target, "media_content_type": "custom",
                                                  "media_content_id": text})
        return f"Alexa ({room}) macht: {text}"

    def alexa_target_or_none(self, room: str) -> str:
        try:
            return self.alexa_target(room) if room else ""
        except HomeAssistantError:
            return ""

    def first_echo(self) -> str:
        return next(iter(self.alexa), "") if self.alexa else ""

    def alexa_target(self, room: str) -> str:
        key = _fold(room)
        for name, target in self.alexa.items():
            if _fold(name) == key:
                return target
        for name, target in self.alexa.items():
            if key and (key in _fold(name) or _fold(name) in key):
                return target
        if room.strip().startswith(("media_player.", "notify.")):
            return room.strip()
        known = ", ".join(self.alexa) or "keine"
        raise HomeAssistantError(f'Kein Echo für "{room}" eingetragen. Bekannt: {known}.')

    def announce(self, room: str, text: str) -> str:
        """Lässt ein Echo-Gerät etwas ansagen (Alexa Media Player)."""
        target = self.alexa_target(room)
        if target.startswith("notify."):
            self.call("notify", target.split(".", 1)[1], {"message": text, "data": {"type": "announce"}})
        else:
            self.call("notify", "alexa_media", {"message": text, "target": [target], "data": {"type": "announce"}})
        return f"Ansage an {room} geschickt."

    def devices(self, filter_text: str = "") -> list[tuple[str, str, str]]:
        rows = []
        for s in self.states():
            entity = s.get("entity_id", "")
            if entity.split(".")[0] not in ("light", "switch", "fan", "cover", "media_player", "climate", "scene", "script", "sensor"):
                continue
            friendly = str((s.get("attributes") or {}).get("friendly_name", ""))
            if filter_text and filter_text.lower() not in (entity + friendly).lower():
                continue
            rows.append((entity, friendly, str(s.get("state", ""))))
        return rows


def _fold(text: str) -> str:
    """"Küche", "kueche" und "Kueche " sollen gleich sein."""
    text = text.lower().strip()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss"), (" ", ""), ("_", ""), ("-", "")):
        text = text.replace(a, b)
    return text
