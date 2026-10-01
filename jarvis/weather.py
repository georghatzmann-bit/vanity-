"""Aktuelles Wetter für die Anzeige im Fenster, von Open-Meteo (gratis, ohne Konto)."""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

# WMO-Wettercodes, zusammengefasst.
CODES = {
    0: "klar", 1: "überwiegend klar", 2: "teils bewölkt", 3: "bewölkt",
    45: "Nebel", 48: "Nebel", 51: "Nieselregen", 53: "Nieselregen", 55: "Nieselregen",
    56: "gefrierender Niesel", 57: "gefrierender Niesel", 61: "leichter Regen", 63: "Regen",
    65: "starker Regen", 66: "gefrierender Regen", 67: "gefrierender Regen", 71: "leichter Schnee",
    73: "Schnee", 75: "starker Schnee", 77: "Schneegriesel", 80: "Regenschauer", 81: "Regenschauer",
    82: "heftige Schauer", 85: "Schneeschauer", 86: "Schneeschauer", 95: "Gewitter",
    96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel",
}


def _get(url: str, timeout: float = 8.0) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "Jarvis/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


RAIN = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}
SNOW = {71, 73, 75, 77, 85, 86}
WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]


class Weather:
    def __init__(self, place: str) -> None:
        self.place = place.strip()
        self._coords: tuple[float, float, str] | None = None
        self._forecast: dict | None = None
        self._forecast_at = -1e9

    def locate(self) -> tuple[float, float, str]:
        if self._coords is None:
            query = urllib.parse.urlencode({"name": self.place, "count": 1, "language": "de", "format": "json"})
            data = _get(f"https://geocoding-api.open-meteo.com/v1/search?{query}")
            results = data.get("results") or []
            if not results:
                raise LookupError(f'Ort "{self.place}" nicht gefunden')
            first = results[0]
            self._coords = (float(first["latitude"]), float(first["longitude"]), first.get("name", self.place))
        return self._coords

    def current(self) -> dict:
        lat, lon, name = self.locate()
        query = urllib.parse.urlencode(
            {"latitude": lat, "longitude": lon, "current": "temperature_2m,weather_code", "timezone": "auto"}
        )
        data = _get(f"https://api.open-meteo.com/v1/forecast?{query}")
        current = data.get("current") or {}
        temp = current.get("temperature_2m")
        code = current.get("weather_code")
        return {
            "place": name,
            "temp": None if temp is None else round(float(temp)),
            "text": CODES.get(int(code), "") if code is not None else "",
        }

    def forecast(self, max_age: float = 600) -> dict:
        """Jetzt und die nächsten sieben Tage, zehn Minuten zwischengespeichert."""
        if self._forecast is not None and time.monotonic() - self._forecast_at < max_age:
            return self._forecast
        lat, lon, name = self.locate()
        query = urllib.parse.urlencode({
            "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 7,
            "current": "temperature_2m,weather_code,precipitation",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        })
        data = _get(f"https://api.open-meteo.com/v1/forecast?{query}", timeout=4.0)
        data["place"] = name
        self._forecast, self._forecast_at = data, time.monotonic()
        return data


def _days(data: dict, when: str, today: dt.date) -> list[int]:
    """Welche Tage der Vorhersage gemeint sind (Indizes in daily)."""
    dates = [dt.date.fromisoformat(d) for d in (data.get("daily") or {}).get("time", [])]
    if not dates:
        return []
    if when == "wochenende":
        return [i for i, d in enumerate(dates) if d.weekday() >= 5][:2]
    if when in [w.lower() for w in WEEKDAYS]:
        wanted = [w.lower() for w in WEEKDAYS].index(when)
        return [next((i for i, d in enumerate(dates) if d.weekday() == wanted and d > today), 0)]
    offset = {"morgen": 1, "übermorgen": 2}.get(when, 0)
    target = today + dt.timedelta(days=offset)
    return [next((i for i, d in enumerate(dates) if d == target), 0)]


def _day_word(day: dt.date, today: dt.date, by_name: bool = False) -> str:
    delta = (day - today).days
    if by_name and delta > 0:
        return f"Am {WEEKDAYS[day.weekday()]}"
    return {0: "Heute", 1: "Morgen", 2: "Übermorgen"}.get(delta, f"Am {WEEKDAYS[day.weekday()]}")


def _at(daily: dict, key: str, index: int):
    values = daily.get(key) or []
    return values[index] if index < len(values) else None


def spoken_weather(data: dict, when: str = "heute", ask: str = "", today: dt.date | None = None) -> str:
    """Ein, zwei kurze Sätze zum Vorlesen. ask: "" (Wetter), "regen", "schnee", "temperatur"."""
    today = today or dt.date.today()
    place = data.get("place") or ""
    current = data.get("current") or {}
    daily = data.get("daily") or {}
    now_temp = current.get("temperature_2m")
    now_code = current.get("weather_code")
    now_text = CODES.get(int(now_code), "") if now_code is not None else ""
    in_place = f" in {place}" if place else ""

    if when == "jetzt":
        if ask == "regen":
            wet = (current.get("precipitation") or 0) > 0 or (now_code is not None and int(now_code) in RAIN)
            return f"Ja, Sir, gerade regnet es{in_place}." if wet else f"Nein, Sir, gerade ist es{in_place} trocken."
        if ask == "schnee":
            snowing = now_code is not None and int(now_code) in SNOW
            return f"Ja, Sir, es schneit{in_place}." if snowing else f"Nein, Sir, es schneit nicht{in_place}."
        if now_temp is None:
            raise LookupError("keine aktuellen Werte")
        text = f", {now_text}" if now_text and ask != "temperatur" else ""
        return f"Gerade {round(now_temp)} Grad{in_place}{text}, Sir."

    days = _days(data, when, today)
    if not days:
        raise LookupError("keine Vorhersage")
    sentences = []
    for index in days:
        day = dt.date.fromisoformat(daily["time"][index])
        word = _day_word(day, today, by_name=when == "wochenende")
        low, high = _at(daily, "temperature_2m_min", index), _at(daily, "temperature_2m_max", index)
        code, rain = _at(daily, "weather_code", index), _at(daily, "precipitation_probability_max", index)
        text = CODES.get(int(code), "") if code is not None else ""
        if ask == "regen":
            if rain is None:
                rainy = code is not None and int(code) in RAIN
                return f"Ja, Sir. {word}{in_place} {text}." if rainy else f"Eher nicht, Sir. {word}{in_place} {text}."
            if rain >= 60:
                return f"Ja, Sir. {word} {rain} Prozent Regenrisiko{in_place}. Nehmen Sie einen Schirm mit."
            if rain >= 30:
                return f"Vielleicht, Sir. {word} liegt das Regenrisiko{in_place} bei {rain} Prozent."
            if rain < 10:
                return f"Nein, Sir. {word} bleibt es{in_place} trocken."
            return f"Eher nicht, Sir. {word} nur {rain} Prozent Regenrisiko{in_place}."
        if ask == "schnee":
            snowy = code is not None and int(code) in SNOW
            return f"Ja, Sir. {word}{in_place} {text}." if snowy else f"Nein, Sir. {word} kein Schnee{in_place}."
        if low is not None and high is not None:
            temps = f"{round(low)} bis {round(high)} Grad"
        else:
            temps = f"bis {round(high)} Grad" if high is not None else ""
        if ask == "temperatur":
            sentences.append(f"{word}{in_place if not sentences else ''} {temps}".strip())
            continue
        parts = [p for p in (temps, text) if p]
        if rain is not None and rain >= 20:
            parts.append(f"Regenrisiko {rain} Prozent")
        sentences.append(f"{word}{in_place if not sentences else ''} " + ", ".join(parts))
    answer = ". ".join(sentence.strip() for sentence in sentences)
    if when == "heute" and now_temp is not None and ask in ("", "temperatur"):
        answer += f". Gerade sind es {round(now_temp)} Grad"
    if ask == "" and any((_at(daily, "precipitation_probability_max", i) or 0) >= 60 for i in days):
        return answer + ". Ein Schirm wäre klug, Sir."
    return answer + ", Sir."
