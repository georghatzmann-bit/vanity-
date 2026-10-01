"""Benachrichtigungen aufs Handy über ntfy.sh (kostenlose App "ntfy" für iPhone und Android).

Was Jarvis sonst nur am PC ansagt ("Erinnerung, Sir: Tee", "Aus der Werkstatt: ...",
"Spotify ist installiert"), kommt so auch aufs Handy, wenn Georg gerade nicht am PC sitzt.
Georg abonniert in der App einmal den Kanal, einen langen Zufallsnamen. Die Nachrichten selbst
laufen unverschlüsselt über ntfy.sh, wie eine SMS: nur wer den Kanalnamen kennt, sieht sie.
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

RELAY = "https://ntfy.sh"
REPEAT_SECONDS = 60  # dieselbe Nachricht nicht zweimal in einer Minute


def new_topic() -> str:
    return "jarvis-" + secrets.token_hex(12)


class Push:
    def __init__(self, cfg: dict, opener=None, sleep=time.sleep) -> None:
        handy = cfg.get("handy", {}) or {}
        self.topic = str(handy.get("push_kanal") or "")
        self.enabled = bool(handy.get("push")) and self.topic.startswith("jarvis-") and len(self.topic) >= 20
        self.relay = str(handy.get("vermittlung") or RELAY).rstrip("/")
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._lock = threading.Lock()
        self._recent: dict[str, float] = {}

    @property
    def subscribe_url(self) -> str:
        return f"{self.relay}/{self.topic}" if self.topic else ""

    def send(self, text: str, title: str = "Jarvis", priority: int = 3, click: str = "", wait: bool = False) -> bool:
        """Schickt eine Benachrichtigung. Ohne wait im Hintergrund (True heißt dann nur: unterwegs)."""
        text = " ".join(str(text or "").split())
        if not self.enabled or not text:
            return False
        now = time.monotonic()
        with self._lock:
            self._recent = {t: at for t, at in self._recent.items() if now - at < REPEAT_SECONDS}
            if text in self._recent:
                return False
            self._recent[text] = now
        payload = {"topic": self.topic, "title": title, "message": text[:3500], "priority": int(priority),
                   "tags": ["robot"]}
        if click:
            payload["click"] = click
        if wait:
            return self._post(payload)
        threading.Thread(target=self._post, args=(payload,), name="jarvis-push", daemon=True).start()
        return True

    def _post(self, payload: dict) -> bool:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        for pause in (0.5, 1.5, 0):
            request = urllib.request.Request(self.relay + "/", data=data, method="POST",
                                             headers={"Content-Type": "application/json"})
            try:
                with self._open(request, timeout=10) as response:
                    response.read()
                return True
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or not pause:
                    log.warning("Benachrichtigung aufs Handy ging nicht raus: %s", exc)
                    return False
            except Exception as exc:
                log.warning("Benachrichtigung aufs Handy ging nicht raus: %s", exc)
                return False
            self._sleep(pause)
        return False
