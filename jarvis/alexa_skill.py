"""Der Alexa-Skill "Jarvis" (läuft bei Amazon, "Von Alexa gehostet", Python).

Jarvis setzt KANAL und SCHLUESSEL ein und zeigt den fertigen Code zum Kopieren an
(siehe jarvis/alexa.py). Nur Python-Bordmittel, kein ask-sdk nötig.

"Alexa, sag Jarvis, er soll Discord öffnen": Der Skill schickt den Befehl verschlüsselt
über ntfy.sh an den PC, wartet bis zu sechs Sekunden auf Jarvis' Antwort und spricht sie.
"""

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

KANAL = "__KANAL__"
SCHLUESSEL = "__SCHLUESSEL__"
RELAY = "https://ntfy.sh"
WARTEN = 6.0  # Sekunden: Alexa wartet höchstens acht


# ---------------------------------------------------------------------- Verschlüsselung (wie jarvis/alexa.py)

def _keys(schluessel=None):
    key = bytes.fromhex(schluessel or SCHLUESSEL)
    return hmac.new(key, b"jarvis-enc", hashlib.sha256).digest(), hmac.new(key, b"jarvis-mac", hashlib.sha256).digest()


def _stream(key, nonce, length):
    out = b""
    counter = 0
    while len(out) < length:
        out += hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return out[:length]


def seal(payload, schluessel=None):
    enc, mac = _keys(schluessel)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    nonce = os.urandom(16)
    body = bytes(a ^ b for a, b in zip(data, _stream(enc, nonce, len(data))))
    tag = hmac.new(mac, nonce + body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(nonce + body + tag).decode("ascii")


def unseal(text, schluessel=None):
    try:
        raw = base64.urlsafe_b64decode(str(text).strip().encode("ascii"))
    except Exception:
        return None
    if len(raw) < 48:
        return None
    nonce, body, tag = raw[:16], raw[16:-32], raw[-32:]
    try:
        enc, mac = _keys(schluessel)
    except ValueError:
        return None
    if not hmac.compare_digest(tag, hmac.new(mac, nonce + body, hashlib.sha256).digest()):
        return None
    try:
        return json.loads(bytes(a ^ b for a, b in zip(body, _stream(enc, nonce, len(body)))).decode("utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------- Weg zum PC

def frage_jarvis(text, kanal=None, schluessel=None, relay=None, warten=None):
    """Schickt den Befehl und wartet auf die Antwort. Gibt (antwort, quittiert) zurück."""
    kanal, relay, warten = kanal or KANAL, relay or RELAY, warten or WARTEN
    ident = uuid.uuid4().hex
    start = time.time()
    message = seal({"id": ident, "text": text, "zeit": int(start)}, schluessel).encode("ascii")
    for pause in (0.4, 0):
        request = urllib.request.Request(relay + "/" + kanal + "-befehl", data=message, method="POST")
        try:
            urllib.request.urlopen(request, timeout=3).read()
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or not pause:
                raise
            time.sleep(pause)
    url = relay + "/" + kanal + "-antwort/json?" + urllib.parse.urlencode({"since": int(start) - 2})
    acked = False
    try:
        with urllib.request.urlopen(url, timeout=warten) as stream:
            while time.time() - start < warten:
                line = stream.readline()
                if not line:
                    break
                try:
                    event = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if event.get("event") != "message":
                    continue
                payload = unseal(event.get("message", ""), schluessel)
                if not payload or payload.get("id") != ident:
                    continue
                if payload.get("art") == "ack":
                    acked = True
                    continue
                return str(payload.get("text") or "Erledigt, Sir."), True
    except Exception:
        pass  # Zeit um oder Verbindung weg
    return "", acked


# ---------------------------------------------------------------------- Alexa

def antwort(text, ende=True, nachfrage=None):
    response = {"outputSpeech": {"type": "PlainText", "text": text[:7000]}, "shouldEndSession": ende}
    if nachfrage:
        response["reprompt"] = {"outputSpeech": {"type": "PlainText", "text": nachfrage}}
    return {"version": "1.0", "response": response}


def befehl_aus(request):
    slots = (request.get("intent") or {}).get("slots") or {}
    slot = slots.get("befehl") or {}
    value = str(slot.get("value") or "").strip()
    if not value:
        # Wert aus der Erkennung, falls Alexa ihn nur dort hinterlegt
        for resolution in ((slot.get("resolutions") or {}).get("resolutionsPerAuthority") or []):
            for item in resolution.get("values") or []:
                value = str((item.get("value") or {}).get("name") or "").strip()
                if value:
                    break
    return value


def lambda_handler(event, context):
    request = (event or {}).get("request") or {}
    kind = request.get("type", "")
    if kind == "LaunchRequest":
        return antwort("Jarvis hier. Was kann ich tun, Sir?", ende=False, nachfrage="Was soll ich tun, Sir?")
    if kind == "SessionEndedRequest":
        return {"version": "1.0", "response": {}}
    if kind != "IntentRequest":
        return antwort("Das habe ich nicht verstanden.")
    name = (request.get("intent") or {}).get("name", "")
    if name in ("AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"):
        return antwort("Bis später, Sir.")
    if name == "AMAZON.HelpIntent":
        return antwort("Sagen Sie einfach, was ich am PC tun soll, zum Beispiel: Öffne Discord, oder: Wie wird das "
                       "Wetter morgen?", ende=False, nachfrage="Was soll ich tun?")
    text = befehl_aus(request)
    if not text:
        return antwort("Wie bitte, Sir?", ende=False, nachfrage="Was soll ich tun?")
    try:
        said, acked = frage_jarvis(text)
    except Exception:
        return antwort("Ich erreiche den Vermittlungsdienst gerade nicht. Bitte gleich noch einmal.")
    if said:
        return antwort(said)
    if acked:
        return antwort("Ich kümmere mich darum, Sir. Das dauert einen Moment.")
    return antwort("Ihr PC antwortet nicht, Sir. Ist er an, und läuft Jarvis?")
