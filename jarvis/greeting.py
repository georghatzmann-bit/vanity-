"""Begrüßung beim Start: Tageszeit, Wetter und was heute noch ansteht. So wirkt Jarvis
wie jemand, der schon mitdenkt, bevor man fragt."""

from __future__ import annotations

import datetime as dt
import threading


def build_greeting(now: dt.datetime, weather: dict | None = None, upcoming: list[dict] | None = None,
                   events: list[str] | None = None, birthdays: list[str] | None = None) -> str:
    hour = now.hour
    if hour < 5:
        parts = ["Noch wach, Sir?"]
    elif hour < 11:
        parts = ["Guten Morgen, Sir."]
    elif hour < 18:
        parts = ["Guten Tag, Sir."]
    else:
        parts = ["Guten Abend, Sir."]
    if weather and weather.get("temp") is not None:
        text = str(weather.get("text") or "").strip()
        parts.append(f"Draußen: {weather['temp']} Grad" + (f", {text}." if text else "."))
    today = []
    for r in upcoming or []:
        try:
            when = dt.datetime.fromisoformat(r["zeit"])
        except (KeyError, ValueError):
            continue
        if when.date() == now.date() and when > now:
            today.append((when, str(r.get("text", "")).strip()))
    today.sort()
    if events:  # aus dem Kalender, schon gesprochen: "um 18 Uhr Training"
        shown = events[:3]
        joined = shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + " und " + shown[-1]
        parts.append(f"Im Kalender heute: {joined}.")
    if len(today) == 1:
        when, text = today[0]
        parts.append(f"Heute um {when:%H:%M} erinnere ich Sie an: {text}.")
    elif today:
        when, text = today[0]
        parts.append(f"Heute stehen noch {len(today)} Erinnerungen an, die nächste um {when:%H:%M}: {text}.")
    elif not events and not birthdays:
        parts.append("Alle Systeme bereit.")
    if birthdays:
        names = birthdays[:3]
        joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]
        parts.append(f"Und {joined} {'hat' if len(names) == 1 else 'haben'} heute Geburtstag.")
    return " ".join(parts)


def current_weather(place: str, timeout: float = 4.0) -> dict | None:
    """Wetter holen, aber nie länger als `timeout` Sekunden auf die Begrüßung warten lassen."""
    if not place:
        return None
    box: list = []

    def fetch() -> None:
        try:
            from .weather import Weather

            box.append(Weather(place).current())
        except Exception:
            pass

    worker = threading.Thread(target=fetch, name="jarvis-begruessung", daemon=True)
    worker.start()
    worker.join(timeout)
    return box[0] if box else None
