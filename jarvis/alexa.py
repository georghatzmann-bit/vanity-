"""Alexa spricht mit Jarvis: "Alexa, sag Jarvis, er soll Discord öffnen."

Ohne Home Assistant und ohne Router-Einstellungen: Georg legt einmal einen eigenen
Alexa-Skill an (kostenlos, bei Amazon gehostet, nur für seine Echos). Jarvis erzeugt dafür
den fertigen Code (alexa_skill.py mit eingesetztem Kanal und Schlüssel) und das
Sprachmodell. Skill und PC tauschen die Nachrichten über ntfy.sh aus, einen kostenlosen
Nachrichtendienst: Der PC hört auf "<kanal>-befehl" und antwortet auf "<kanal>-antwort".
Der Kanal ist ein langes Zufallswort, jede Nachricht ist verschlüsselt und signiert
(alexa_skill.seal), alte oder doppelte Nachrichten zählen nicht.
"""

from __future__ import annotations

import collections
import json
import logging
import secrets
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from . import alexa_skill

log = logging.getLogger(__name__)

RELAY = alexa_skill.RELAY
CONSOLE_URL = "https://developer.amazon.com/alexa/console/ask"
MAX_AGE = 120  # Sekunden: ältere Befehle zählen nicht (falls jemand sie wiederholt)

# Beispiele für den Platzhalter "befehl": Je vielfältiger, desto besser fängt Alexa freie Sätze auf.
EXAMPLES = [
    "öffne discord", "öffne spotify", "starte steam", "mach den gaming modus an", "sperre den pc",
    "fahr den pc herunter", "starte den pc neu", "wie spät ist es", "wie wird das wetter morgen",
    "wie wird das wetter am wochenende", "spiel thunderstruck", "spiel musik", "pause", "nächstes lied",
    "mach lauter", "mach leiser", "stell die lautstärke auf dreißig prozent", "schreib max dass ich gleich online komme",
    "sag anna ich bin in zehn minuten da", "öffne den chat mit max", "geh in den sprachkanal zocken",
    "schalte mich in discord stumm", "erinnere mich in zwanzig minuten an den tee", "stell einen timer auf zehn minuten",
    "was steht heute an", "was weißt du über mich", "merk dir dass ich gern pizza esse", "welche projekte habe ich",
    "arbeite am discord bot weiter", "bau mir einen discord bot der würfelt", "wie weit ist die werkstatt",
    "mach den dunkelmodus an", "schalte bluetooth aus", "öffne die bluetooth einstellungen", "such nach katzenvideos",
    "geh auf youtube", "öffne amazon", "navigiere nach graz", "was ist fünfzehn mal dreiundzwanzig",
    "schick den pc in den energiesparmodus", "guten morgen", "gute nacht", "erzähl mir einen witz",
    "was gibt es neues", "öffne meine downloads", "mach den pc aus", "installiere vlc", "schließe chrome",
    "öffne word", "zeig dich", "versteck dich", "neue unterhaltung", "danke", "stopp",
]


def new_secrets() -> dict:
    return {"kanal": "jarvis-" + secrets.token_hex(16), "schluessel": secrets.token_hex(32)}


def interaction_model() -> dict:
    """Das Sprachmodell für die Alexa-Entwicklerkonsole (JSON-Editor)."""
    return {
        "interactionModel": {
            "languageModel": {
                "invocationName": "jarvis",
                "intents": [
                    {"name": "AMAZON.CancelIntent", "samples": []},
                    {"name": "AMAZON.HelpIntent", "samples": []},
                    {"name": "AMAZON.StopIntent", "samples": []},
                    {"name": "AMAZON.NavigateHomeIntent", "samples": []},
                    {"name": "AMAZON.YesIntent", "samples": []},
                    {"name": "AMAZON.NoIntent", "samples": []},
                    {
                        "name": "BefehlIntent",
                        "slots": [{"name": "befehl", "type": "BEFEHL"}],
                        "samples": ["{befehl}", "er soll {befehl}", "sag ihm {befehl}", "bitte {befehl}",
                                    "dass er {befehl}", "kannst du {befehl}"],
                    },
                ],
                "types": [{"name": "BEFEHL", "values": [{"name": {"value": text}} for text in EXAMPLES]}],
            }
        }
    }


def skill_code(channel: str, key: str, relay: str = RELAY) -> str:
    """lambda_function.py für den Skill: alexa_skill.py mit Kanal, Schlüssel und Vermittlungsdienst."""
    source = Path(alexa_skill.__file__).read_text(encoding="utf-8")
    return (source.replace('KANAL = "__KANAL__"', f'KANAL = "{channel}"')
            .replace('SCHLUESSEL = "__SCHLUESSEL__"', f'SCHLUESSEL = "{key}"')
            .replace('RELAY = "https://ntfy.sh"', f'RELAY = "{relay.rstrip("/")}"'))


class AlexaBridge:
    """Hört auf Befehle vom Alexa-Skill und schickt Jarvis' Antworten zurück."""

    def __init__(self, cfg: dict, assistant, relay: str | None = None) -> None:
        alexa = cfg.get("alexa", {}) or {}
        self.channel = str(alexa.get("kanal") or "")
        self.key = str(alexa.get("schluessel") or "")
        self._assistant = assistant
        self._relay = (relay or str(alexa.get("vermittlung") or "") or RELAY).rstrip("/")
        self._stopped = threading.Event()
        self._seen: collections.deque = collections.deque(maxlen=300)
        self._thread: threading.Thread | None = None
        self.connected = False
        self.last_command = 0.0

    @property
    def configured(self) -> bool:
        return self.channel.startswith("jarvis-") and len(self.key) == 64

    def start(self) -> bool:
        if not self.configured:
            return False
        self._thread = threading.Thread(target=self._listen, name="jarvis-alexa", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stopped.set()

    # ------------------------------------------------------------------ Empfang

    def _listen(self) -> None:
        since = str(int(time.time()) - 5)
        wait = 2.0
        while not self._stopped.is_set():
            url = f"{self._relay}/{self.channel}-befehl/json?" + urllib.parse.urlencode({"since": since})
            try:
                with urllib.request.urlopen(url, timeout=90) as stream:  # ntfy schickt alle 45 s ein Lebenszeichen
                    self.connected = True
                    wait = 2.0
                    for line in stream:
                        if self._stopped.is_set():
                            return
                        try:
                            event = json.loads(line.decode("utf-8"))
                        except ValueError:
                            continue
                        if event.get("event") != "message":
                            continue
                        since = str(event.get("id") or since)
                        self.receive(str(event.get("message") or ""))
            except Exception as exc:
                log.debug("Alexa-Kanal: %s", exc)
            self.connected = False
            if self._stopped.wait(wait):
                return
            wait = min(wait * 2, 60.0)

    def receive(self, message: str) -> bool:
        """Eine Nachricht vom Skill. True, wenn sie echt, neu und frisch war (dann wird geantwortet)."""
        payload = alexa_skill.unseal(message, self.key)
        if not payload or not isinstance(payload, dict):
            return False
        ident = str(payload.get("id") or "")
        text = str(payload.get("text") or "").strip()
        if not ident or not text or ident in self._seen:
            return False
        try:
            age = abs(time.time() - float(payload.get("zeit", 0)))
        except (TypeError, ValueError):
            return False
        if age > MAX_AGE:
            return False
        self._seen.append(ident)
        self.last_command = time.time()
        threading.Thread(target=self._answer, args=(ident, text), name="jarvis-alexa-antwort", daemon=True).start()
        return True

    def _answer(self, ident: str, text: str) -> None:
        from .text import speakable

        self.post({"id": ident, "art": "ack", "zeit": int(time.time())})
        log.info("Befehl von Alexa: %s", text)
        try:
            answer = self._assistant.handle(text, speak=False)
        except Exception as exc:
            log.warning("Alexa-Befehl: %s", exc)
            answer = "Da ist leider etwas schiefgegangen, Sir."
        said = (speakable(answer) or answer or "Erledigt, Sir.").strip()[:600]
        self.post({"id": ident, "art": "antwort", "text": said, "zeit": int(time.time())})

    def post(self, payload: dict) -> bool:
        """Schickt eine Antwort an den Skill. Bremst ntfy.sh (429), kurz warten und nochmal."""
        import urllib.error

        data = alexa_skill.seal(payload, self.key).encode("ascii")
        for pause in (0.3, 0.8, 1.5, 0):
            request = urllib.request.Request(f"{self._relay}/{self.channel}-antwort", data=data, method="POST")
            try:
                urllib.request.urlopen(request, timeout=10).read()
                return True
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or not pause:
                    log.warning("Alexa-Antwort ging nicht raus: %s", exc)
                    return False
            except Exception as exc:
                log.warning("Alexa-Antwort ging nicht raus: %s", exc)
                return False
            time.sleep(pause)
        return False

    # ------------------------------------------------------------------ Prüfen

    def self_test(self, text: str = "Wie spät ist es?") -> str:
        """Schickt einen Befehl so, wie der Skill es tut, und wartet auf die Antwort."""
        said, acked = alexa_skill.frage_jarvis(text, self.channel, self.key, self._relay, warten=8.0)
        if said:
            return said
        raise RuntimeError("Jarvis hat den Befehl bekommen, aber nicht rechtzeitig geantwortet." if acked
                           else "Über ntfy.sh kam nichts an. Internet prüfen und nochmal versuchen.")
