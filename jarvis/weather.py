"""Aktuelles Wetter für die Anzeige im Fenster, von Open-Meteo (gratis, ohne Konto)."""

from __future__ import annotations

import json
import logging
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


class Weather:
    def __init__(self, place: str) -> None:
        self.place = place.strip()
        self._coords: tuple[float, float, str] | None = None

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
