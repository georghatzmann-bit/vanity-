"""Lagebild für die Kommandozentrale: Mails, Termine, Shop und Werbekonten über Georgs Konnektoren.

Ein eigener Claude-Prozess im Hintergrund (brain.connector_job) liest mit den Konnektoren, die Georg auf
claude.ai verbunden hat (Gmail, Google Kalender, Shopify, Windsor.ai), und antwortet mit einem JSON-Objekt.
Er darf dabei nur lesen: Jede Rückfrage von Claude Code geht an `read_only` (suchen, auflisten, abrufen ja;
senden, entwerfen, markieren, ändern, löschen nie). Was zurückkommt, prüft und kürzt `clean`, bevor es ins
Fenster geht: nur bekannte Felder, Texte in Grenzen, Zahlen als Zahlen.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
import re

from . import konnektoren

log = logging.getLogger(__name__)

MAX_MAILS = 12
MAX_EVENTS = 12

# Verben in Werkzeugnamen, die nur lesen (search_threads, list_events, list-orders, run-analytics-query ...).
# Nur Verben: ein Hauptwort wie "shop" oder "messages" steckt auch in switch-shop oder clear_messages.
READ_WORDS = {
    "get", "list", "search", "read", "query", "find", "fetch", "show", "describe", "count", "lookup", "view",
    "retrieve", "explore",
}
# ... und solche, die schreiben, verschicken oder etwas auslösen: im Hintergrund nie
WRITE_WORDS = (konnektoren.BLOCKED_WORDS | konnektoren.CONFIRM_WORDS | konnektoren.SHOP_WRITE_WORDS | {
    "draft", "label", "unlabel", "mark", "unmark", "move", "archive", "spam", "untrash", "trash", "respond",
    "execute", "action", "run_action", "apply", "upsert", "write", "insert", "save", "schedule", "suggest", "copy",
    "generate", "connect", "manage", "deploy", "submit", "upload", "rename", "pause", "restore", "reset", "create",
    "replace", "clear", "close", "star", "unstar", "snooze", "mute", "approve", "reject", "accept", "decline",
    "assign", "enable", "disable", "start", "stop", "trigger", "invoke", "duplicate", "install", "uninstall",
    "fulfill", "switch", "subscribe", "unsubscribe", "block", "unblock", "revoke", "grant",
})
# Eigene Werkzeuge von Claude Code, die nur Werkzeuge nachladen oder Konnektor-Inhalte lesen
INTERNAL_OK = {"ToolSearch", "MCPSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"}

STATUS = ("wichtig", "offen", "beantwortet", "werbung")
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def read_only(tool: str) -> tuple[bool, str]:
    """Darf der Hintergrund-Prozess dieses Werkzeug benutzen? Nur Konnektoren, und von denen nur Lesendes."""
    tool = str(tool or "")
    if tool in INTERNAL_OK:
        return True, ""
    server, name = konnektoren.split(tool)
    if not server or not name:
        return False, "Im Hintergrund liest Jarvis nur über Konnektoren."
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)  # listEvents -> list_Events
    words = {w for w in re.split(r"[^a-z]+", name.lower()) if w}
    if words & WRITE_WORDS:
        return False, "Im Hintergrund wird nur gelesen, nichts verschickt oder geändert."
    if words & READ_WORDS:
        return True, ""
    return False, "Dieses Werkzeug liest nicht nur. Im Hintergrund ist es gesperrt."


SYSTEM_PROMPT = """Du arbeitest im Hintergrund für Jarvis, Georgs persönlichen Butler. Du sammelst für seine \
Kommandozentrale, was heute zählt, und antwortest am Ende NUR mit einem JSON-Objekt. Du darfst ausschließlich \
lesen: suchen, auflisten, abrufen. Nichts schreiben, nichts verschicken, keine Entwürfe, nichts markieren. \
Arbeite zügig, ohne Erklärungen, und rufe Werkzeuge, die voneinander unabhängig sind, gleichzeitig auf."""


def prompt(connectors: list[str], now: dt.datetime | None = None) -> str:
    """Die Aufgabe für den Hintergrund-Prozess. `connectors`: Namen, die Claude Code zuletzt gemeldet hat."""
    now = now or dt.datetime.now()
    have = ", ".join(connectors) if connectors else "die, die du hast"
    day = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")[now.weekday()]
    return f"""Heute ist {day}, der {now:%d.%m.%Y}, es ist {now:%H:%M} Uhr. Konnektoren: {have}. Fehlt einer, lass seinen Teil weg.

1. Posteingang (Gmail): Threads im Posteingang der letzten zwei Tage, höchstens 25 (zum Beispiel Suche "in:inbox newer_than:2d").
   Für jeden: Absender (nur der Name), Betreff, Uhrzeit der letzten Nachricht ("HH:MM" wenn heute, sonst "gestern" oder "TT.MM."),
   status: "wichtig" (ein Mensch will etwas von Georg, Rechnung, Frist, Termin), "offen" (Post von Menschen),
   "beantwortet" (die letzte Nachricht im Thread ist von Georg), "werbung" (Newsletter, Angebote, automatische Mails),
   dazu "kurz" (ein knapper Satz, worum es geht) und "id" (Thread-ID). Zähle, wie viele seit gestern neu sind, wie viele
   ungelesen, und wie viele aller neuen Threads in jeden status fallen ("zahlen", zusammen so viele wie "neu").
2. Kalender: Termine von heute bis in 7 Tagen. Für heute jeden mit Start, Ende ("HH:MM", ganztägig: "Tag"), Titel, Ort,
   und "wichtig": true für den wichtigsten des Tages. Dazu, wie viele Termine es diese Woche insgesamt sind.
3. Shop (Shopify): Shop-Name, Währung, Umsatz und Bestellungen heute und gestern, Zahl der offenen (nicht versendeten) Bestellungen.
4. Werbekonten (Windsor.ai): je Konto (Meta, Google, TikTok ...) Ausgaben heute, ROAS, Klickpreis; dazu ROAS und Ausgaben gesamt.
5. Höchstens drei "hinweise": was Georg heute wirklich selbst tun sollte, je ein kurzer Satz.

Antworte NUR mit diesem JSON (kein Markdown, keine Erklärung), Teile ohne Konnektor weglassen:
{{"post": {{"neu": 0, "ungelesen": 0, "zahlen": {{"wichtig": 0, "offen": 0, "beantwortet": 0, "werbung": 0}},
           "mails": [{{"von": "", "betreff": "", "zeit": "07:03", "status": "wichtig", "kurz": "", "id": ""}}]}},
 "kalender": {{"heute": [{{"start": "14:00", "ende": "15:00", "titel": "", "ort": "", "wichtig": true}}], "woche": 0}},
 "shop": {{"name": "", "waehrung": "EUR", "umsatz_heute": 0, "umsatz_gestern": 0, "bestellungen_heute": 0,
           "bestellungen_gestern": 0, "offen": 0}},
 "werbung": {{"konten": [{{"name": "Meta", "ausgaben": 0, "roas": 0, "klickpreis": 0}}], "roas": 0, "ausgaben": 0}},
 "hinweise": [""]}}"""


# ---------------------------------------------------------------------- Prüfen, was zurückkommt


def _text(value, limit: int = 80) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit].rstrip() + ("…" if len(text) > limit else "")


def _num(value, high: float = 1e12) -> float | None:
    try:
        number = float(str(value).replace(",", ".")) if not isinstance(value, (int, float)) else float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return round(min(number, high), 2)


def _count(value) -> int | None:
    number = _num(value, 1e7)
    return int(number) if number is not None else None


def _time(value) -> str:
    text = str(value or "").strip()
    if text.lower() in ("tag", "ganztägig", "ganztags"):
        return "Tag"
    found = _TIME.match(text)
    if found:
        return f"{int(found.group(1)):02d}:{found.group(2)}"
    return _text(text, 10)


def extract(text: str) -> dict | None:
    """Das JSON-Objekt aus der Antwort, auch wenn Claude doch etwas davor oder Markdown drumherum schreibt."""
    text = str(text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.M)
    start = text.find("{")
    while start >= 0:
        depth = 0
        for index in range(start, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        data = json.loads(text[start:index + 1])
                    except ValueError:
                        break
                    return data if isinstance(data, dict) else None
        start = text.find("{", start + 1)
    return None


def clean(data) -> dict:
    """Nur bekannte Felder in sinnvollen Grenzen. Fehlt ein Teil, fehlt er auch hier."""
    out: dict = {}
    if not isinstance(data, dict):
        return out
    post = data.get("post")
    if isinstance(post, dict):
        mails = []
        for raw in post.get("mails") or []:
            if not isinstance(raw, dict):
                continue
            status = str(raw.get("status") or "offen").lower()
            mails.append({"von": _text(raw.get("von"), 40) or "Unbekannt", "betreff": _text(raw.get("betreff"), 70),
                          "zeit": _time(raw.get("zeit")), "status": status if status in STATUS else "offen",
                          "kurz": _text(raw.get("kurz"), 110), "id": re.sub(r"[^\w-]", "", str(raw.get("id") or ""))[:40]})
        order = {"wichtig": 0, "offen": 1, "beantwortet": 2, "werbung": 3}
        mails.sort(key=lambda m: order[m["status"]])
        raw_counts = post.get("zahlen") if isinstance(post.get("zahlen"), dict) else {}
        counts = {key: _count(raw_counts.get(key)) for key in STATUS}
        for key in STATUS:  # was Claude nicht gezählt hat, aus der Liste
            if counts[key] is None:
                counts[key] = sum(1 for m in mails if m["status"] == key)
        out["post"] = {"neu": _count(post.get("neu")), "ungelesen": _count(post.get("ungelesen")), "zahlen": counts,
                       "mails": mails[:MAX_MAILS]}
    calendar = data.get("kalender")
    if isinstance(calendar, dict):
        events = []
        for raw in calendar.get("heute") or []:
            if not isinstance(raw, dict) or not _text(raw.get("titel")):
                continue
            events.append({"start": _time(raw.get("start")), "ende": _time(raw.get("ende")), "titel": _text(raw.get("titel"), 60),
                           "ort": _text(raw.get("ort"), 40), "wichtig": bool(raw.get("wichtig"))})
        events.sort(key=lambda e: ("" if e["start"] == "Tag" else e["start"]))
        out["kalender"] = {"heute": events[:MAX_EVENTS], "woche": _count(calendar.get("woche"))}
    shop = data.get("shop")
    if isinstance(shop, dict) and any(_num(shop.get(k)) is not None for k in ("umsatz_heute", "bestellungen_heute", "offen")):
        currency = re.sub(r"[^A-Za-z€$£]", "", str(shop.get("waehrung") or "EUR"))[:3].upper() or "EUR"
        out["shop"] = {"name": _text(shop.get("name"), 40), "waehrung": currency,
                       **{k: _num(shop.get(k)) for k in ("umsatz_heute", "umsatz_gestern")},
                       **{k: _count(shop.get(k)) for k in ("bestellungen_heute", "bestellungen_gestern", "offen")}}
    ads = data.get("werbung")
    if isinstance(ads, dict):
        accounts = []
        for raw in ads.get("konten") or []:
            if isinstance(raw, dict) and _text(raw.get("name")):
                accounts.append({"name": _text(raw.get("name"), 20), "ausgaben": _num(raw.get("ausgaben")),
                                 "roas": _num(raw.get("roas"), 1000), "klickpreis": _num(raw.get("klickpreis"), 1000)})
        if accounts:
            out["werbung"] = {"konten": accounts[:6], "roas": _num(ads.get("roas"), 1000), "ausgaben": _num(ads.get("ausgaben"))}
    hints = [_text(h, 140) for h in data.get("hinweise") or [] if isinstance(h, str) and h.strip()]
    if hints:
        out["hinweise"] = hints[:3]
    return out


def parse(text: str) -> dict:
    """Antwort des Hintergrund-Prozesses -> geprüftes Lagebild. ValueError, wenn kein JSON darin steht."""
    data = extract(text)
    if data is None:
        raise ValueError("Keine Daten in der Antwort.")
    return clean(data)
