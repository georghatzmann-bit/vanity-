"""Was in der Nähe ist: der nächste Supermarkt zu einem Standort (für die Einkaufsliste unterwegs).

Die Daten kommen aus OpenStreetMap über die Overpass-API (kostenlos, ohne Konto). Dorthin geht nur der Standort
selbst, gerundet auf etwa 10 Meter, und nur, wenn Georg Jarvis über Telegram seinen Standort schickt.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import urllib.parse
import urllib.request
from typing import Callable

log = logging.getLogger(__name__)

OVERPASS = "https://overpass-api.de/api/interpreter"
RADIUS = 1500  # Meter
CACHE_SECONDS = 30 * 60
WALK_METERS_PER_MINUTE = 80


def distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Luftlinie in Metern (Haversine)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def spoken_distance(meters: float) -> str:
    if meters < 1000:
        return f"{max(10, int(round(meters / 10.0)) * 10)} Meter"
    km = round(meters / 1000.0, 1)
    return (f"{km:.1f}".replace(".", ",") + " Kilometer").replace(",0 ", " ")


def walk_minutes(meters: float) -> int:
    return max(1, int(round(meters / WALK_METERS_PER_MINUTE)))


def _query(lat: float, lon: float, radius: int) -> str:
    return (f"[out:json][timeout:10];(node[\"shop\"=\"supermarket\"](around:{radius},{lat:.4f},{lon:.4f});"
            f"way[\"shop\"=\"supermarket\"](around:{radius},{lat:.4f},{lon:.4f}););out center 40;")


def _post(url: str, query: str, timeout: float) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST",
                                     headers={"User-Agent": "Jarvis-Assistent/2 (privat, Einkaufsliste)",
                                              "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def parse(data: dict, lat: float, lon: float) -> list[dict]:
    """Overpass-Antwort -> Supermärkte, nächster zuerst: {id, name, lat, lon, meter, adresse}."""
    shops = []
    for item in (data or {}).get("elements") or []:
        if not isinstance(item, dict):
            continue
        tags = item.get("tags") or {}
        here = item if "lat" in item else (item.get("center") or {})
        try:
            s_lat, s_lon = float(here["lat"]), float(here["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        name = str(tags.get("name") or tags.get("brand") or "").strip()
        if not name:
            continue
        street = " ".join(p for p in (str(tags.get("addr:street") or "").strip(),
                                      str(tags.get("addr:housenumber") or "").strip()) if p)
        shops.append({"id": f"{item.get('type', 'node')}/{item.get('id', '')}", "name": name[:60],
                      "lat": s_lat, "lon": s_lon, "meter": distance(lat, lon, s_lat, s_lon),
                      "adresse": street[:80]})
    shops.sort(key=lambda s: s["meter"])
    return shops


class Nearby:
    """Sucht Supermärkte in der Nähe, mit kleinem Zwischenspeicher (ein Gitter von etwa 200 Metern)."""

    def __init__(self, url: str = OVERPASS, fetch: Callable[[str, str, float], dict] | None = None,
                 timeout: float = 12) -> None:
        self._url = url
        self._fetch = fetch or _post
        self._timeout = timeout
        self._cache: dict[tuple, tuple[float, list[dict]]] = {}
        self._lock = threading.Lock()

    def supermarkets(self, lat: float, lon: float, radius: int = RADIUS) -> list[dict]:
        cell = (round(lat * 500), round(lon * 500), radius)  # etwa 200 x 150 Meter
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(cell)
            if hit is not None and now - hit[0] < CACHE_SECONDS:
                return [dict(s, meter=distance(lat, lon, s["lat"], s["lon"])) for s in hit[1]]
        try:
            shops = parse(self._fetch(self._url, _query(lat, lon, radius), self._timeout), lat, lon)
        except Exception as exc:  # kein Netz, Overpass überlastet: dann eben ohne
            log.info("Supermärkte in der Nähe: %s", type(exc).__name__)
            return []
        with self._lock:
            if len(self._cache) > 200:
                self._cache.clear()
            self._cache[cell] = (now, shops)
        return [dict(s, meter=distance(lat, lon, s["lat"], s["lon"])) for s in shops]

    def nearest(self, lat: float, lon: float, radius: int = RADIUS) -> dict | None:
        shops = self.supermarkets(lat, lon, radius)
        return shops[0] if shops else None
