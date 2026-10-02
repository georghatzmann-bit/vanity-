"""Die Weltlage ("Gottes Auge"): eine Satelliten-Erde im Fenster, Jarvis fliegt zu jeder Meldung und liest sie vor.

"Jarvis, zeig mir, was in der Welt passiert" holt die neuesten Meldungen der Tagesschau, findet zu jeder den Ort
(orte.py, ohne Internet und ohne Claude, darum sofort) und schickt sie ans Fenster (weltlage.js). Dort dreht sich
die Erde zur ersten Meldung, Jarvis liest sie vor, dann die nächste. "Was passiert in Deutschland" nimmt die
Inlandsmeldungen, "Flieg nach Tokio" fliegt einfach hin. Dazu Börsenkurse (DAX, S&P 500, Bitcoin) und auf Wunsch
der Flugverkehr darüber (OpenSky Network, live).

Quellen (alle ohne Schlüssel): tagesschau.de (Nachrichten), Yahoo Finance (Kurse), OpenSky Network (Flüge),
OpenStreetMap Nominatim (Orte, die orte.py nicht kennt), wheretheiss.at (wo die Raumstation gerade fliegt). Die Satellitenbilder lädt das Fenster selbst (EOX,
Sentinel-2 cloudless). Fällt eine Quelle aus, fehlt nur dieser Teil.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from . import orte

log = logging.getLogger(__name__)

NEWS_API = "https://www.tagesschau.de/api2u/news/"
MARKETS_API = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1d"
FLIGHTS_API = "https://opensky-network.org/api/states/all"
GEOCODE_API = "https://nominatim.openstreetmap.org/search"
REVERSE_API = "https://nominatim.openstreetmap.org/reverse"
ISS_API = "https://api.wheretheiss.at/v1/satellites/25544"
USER_AGENT = "Jarvis/2.0 (persoenlicher Sprachassistent)"

KINDS = {  # was Georg sehen will -> Ressort der Tagesschau, Überschrift im Fenster, Satz am Anfang
    "welt": ("ausland", "Lage · Welt", "Lagebericht, Sir."),
    "deutschland": ("inland", "Lage · Deutschland", "Einen Moment, Sir. Hier ist die Lage in Deutschland."),
    "wirtschaft": ("wirtschaft", "Lage · Wirtschaft", "Die Wirtschaftslage, Sir."),
}
MAX_ITEMS = 7
MARKETS = [("DAX", "^GDAXI", "Punkte"), ("S&P 500", "^GSPC", "Punkte"), ("Bitcoin", "BTC-EUR", "Euro")]
MARKETS_SECONDS = 300
FLIGHTS_SECONDS = 45  # OpenSky ohne Konto: 400 Abfragen am Tag, das Fenster rechnet dazwischen weiter
FLIGHTS_MAX = 700
FLIGHTS_PAUSE = 900  # zu viele Abfragen (429): so lange nicht mehr fragen
PAUSE_BETWEEN = 0.7  # Sekunden Stille zwischen zwei Meldungen (die Erde fliegt schon los)
HANDOFF = "weltlage-auftrag.json"  # das Gehirn zeigt einen Ort (python -m jarvis.tool weltlage "<ort>")


# ---------------------------------------------------------------------- Quellen


def _get(url: str, opener=None, timeout: float = 12, headers: dict | None = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    opener = opener or urllib.request.urlopen
    with opener(request, timeout=timeout) as response:
        return response.read()


def _images(raw: dict) -> dict:
    """Das Foto zur Meldung: klein für die Liste, groß für die Meldungskarte, dazu Bildtext und Quelle."""
    teaser = raw.get("teaserImage") or {}
    variants = teaser.get("imageVariants") or {}

    def pick(keys) -> str:
        for key in keys:
            url = str(variants.get(key) or "")
            if url.startswith("https://"):
                return url
        return ""

    small = pick(("16x9-384", "16x9-256", "16x9-512", "1x1-144"))
    return {"bild": small, "bild_gross": pick(("16x9-960", "16x9-640", "16x9-1280", "16x9-512")) or small,
            "bild_text": " ".join(str(teaser.get("alttext") or "").split())[:200],
            "bild_quelle": " ".join(str(teaser.get("copyright") or "").split())[:120]}


def _sentence(text: str) -> str:
    text = " ".join(str(text or "").split())
    return text if not text or text[-1] in ".!?" else text + "."


def to_item(raw: dict, ressort: str) -> dict | None:
    """Eine Meldung der Tagesschau, wie das Fenster und die Stimme sie brauchen."""
    if not isinstance(raw, dict) or raw.get("type") not in ("story", None):
        return None
    title = " ".join(str(raw.get("title") or "").split())
    if not title:
        return None
    topline = " ".join(str(raw.get("topline") or "").split())
    first = " ".join(str(raw.get("firstSentence") or "").split())
    tags = " ".join(str(t.get("tag") or "") for t in raw.get("tags") or [] if isinstance(t, dict))
    geotags = " ".join(str(t.get("tag") or "") for t in raw.get("geotags") or [] if isinstance(t, dict))
    place = orte.find(geotags, title, topline, first, tags)
    if place is None and ressort == "inland":
        place = orte.lookup("Deutschland")
    item = {
        "id": str(raw.get("sophoraId") or raw.get("externalId") or title)[:120],
        "titel": title, "oben": topline, "satz": first, **_images(raw),
        "link": str(raw.get("shareURL") or raw.get("detailsweb") or ""),
        "zeit": str(raw.get("date") or ""), "ort": None,
    }
    if place is not None:
        item["ort"] = place.as_dict()
    item["sprechen"] = spoken(item)
    return item


def spoken(item: dict) -> str:
    """Was Jarvis zu einer Meldung sagt: die Schlagzeile, bei kurzen oder fragenden auch der erste Satz
    ("Wahlkampf mit Schulpolitik?" allein versteht niemand)."""
    title = re.sub(r"\s+-\s+", ", ", item["titel"]).strip().rstrip(":")
    first = item.get("satz") or ""
    if first and (title.endswith("?") or len(title.split()) < 6):
        return _sentence(title) + " " + _sentence(first)
    return _sentence(title)


def fetch_news(kind: str = "welt", opener=None, limit: int = MAX_ITEMS) -> list[dict]:
    """Die neuesten Meldungen mit Ort (die ohne Ort kommen ans Ende, damit die Erde etwas zu zeigen hat)."""
    ressort = KINDS.get(kind, KINDS["welt"])[0]
    data = json.loads(_get(f"{NEWS_API}?ressort={ressort}", opener).decode("utf-8"))
    items, seen = [], set()
    for raw in data.get("news") or []:
        item = to_item(raw, ressort)
        if item is None or item["titel"].lower() in seen:
            continue
        seen.add(item["titel"].lower())
        items.append(item)
    placed = [i for i in items if i["ort"]]
    rest = [i for i in items if not i["ort"]]
    chosen = (placed + rest)[:limit]
    for item in chosen:  # Meldungen über die Raumstation: dorthin, wo sie gerade wirklich ist
        if item["ort"] and item["ort"]["name"] == orte.WELTRAUM.name:
            live = iss_position(opener)
            if live is not None:
                item["ort"] = live
    return chosen


def iss_position(opener=None) -> dict | None:
    """Wo die Raumstation gerade über der Erde fliegt (live)."""
    try:
        data = json.loads(_get(ISS_API, opener, timeout=5).decode("utf-8"))
        return {"name": "Raumstation ISS", "lat": round(float(data["latitude"]), 3), "lon": round(float(data["longitude"]), 3),
                "km": 2500, "hoehe": round(float(data.get("altitude") or 420)), "iss": True}
    except Exception as exc:
        log.info("Raumstation: %s", exc)
        return None


def region_name(lat: float, lon: float, opener=None) -> str:
    """Über welchem Land ein Punkt liegt ("" = über dem Meer oder unbekannt)."""
    try:
        query = urllib.parse.urlencode({"lat": f"{lat:.3f}", "lon": f"{lon:.3f}", "format": "json", "zoom": 3,
                                        "accept-language": "de"})
        data = json.loads(_get(f"{REVERSE_API}?{query}", opener, timeout=5).decode("utf-8"))
    except Exception:
        return ""
    address = data.get("address") if isinstance(data, dict) else None
    return str((address or {}).get("country") or "")


def fetch_markets(opener=None) -> list[dict]:
    """DAX, S&P 500 und Bitcoin: Stand und Veränderung zum Vortag in Prozent."""
    result = []
    for name, symbol, unit in MARKETS:
        try:
            data = json.loads(_get(MARKETS_API.format(symbol=urllib.parse.quote(symbol)), opener,
                                   headers={"User-Agent": "Mozilla/5.0"}).decode("utf-8"))
            meta = data["chart"]["result"][0]["meta"]
            price = float(meta["regularMarketPrice"])
            before = float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
            change = (price - before) / before * 100 if before else 0.0
            result.append({"name": name, "wert": round(price, 2), "prozent": round(change, 2), "einheit": unit})
        except Exception as exc:
            log.debug("Kurs %s: %s", name, exc)
    return result


def markets_sentence(markets: list[dict]) -> str:
    """Zum Vorlesen: "Der DAX steht bei 24.312 Punkten, plus 0,4 Prozent. ..." """
    if not markets:
        return "An die Börsenkurse komme ich gerade nicht heran, Sir."
    names = {"DAX": "Der DAX", "S&P 500": "Der S und P 500", "Bitcoin": "Bitcoin"}
    units = {"Punkte": "Punkten", "Euro": "Euro"}
    parts = []
    for m in markets:
        value = f"{m['wert']:,.0f}".replace(",", ".")
        percent = f"{abs(m['prozent']):.1f}".replace(".", ",")
        trend = "unverändert" if percent == "0,0" else f"{'plus' if m['prozent'] > 0 else 'minus'} {percent} Prozent"
        parts.append(f"{names.get(m['name'], m['name'])} steht bei {value} {units.get(m['einheit'], m['einheit'])}, {trend}.")
    return " ".join(parts)


def fetch_flights(box: tuple[float, float, float, float], opener=None) -> list[dict]:
    """Flugzeuge in der Luft über einem Ausschnitt (Süden, Westen, Norden, Osten in Grad)."""
    south, west, north, east = box
    query = urllib.parse.urlencode({"lamin": f"{south:.2f}", "lomin": f"{west:.2f}",
                                    "lamax": f"{north:.2f}", "lomax": f"{east:.2f}"})
    data = json.loads(_get(f"{FLIGHTS_API}?{query}", opener, timeout=15).decode("utf-8"))
    planes = []
    for row in data.get("states") or []:
        try:
            lat, lon, ground = row[6], row[5], row[8]
            if lat is None or lon is None or ground:
                continue
            planes.append({"id": str(row[0]), "ruf": str(row[1] or "").strip(), "land": str(row[2] or ""),
                           "lat": round(float(lat), 4), "lon": round(float(lon), 4),
                           "hoehe": round(float(row[13] if row[13] is not None else (row[7] or 0))),
                           "tempo": round(float(row[9] or 0), 1), "kurs": round(float(row[10] or 0), 1)})
        except (TypeError, ValueError, IndexError):
            continue
    return planes[:FLIGHTS_MAX]


def geocode(name: str, opener=None) -> orte.Ort | None:
    """Ein Ort für "Flieg nach ...": erst das eigene Verzeichnis, sonst OpenStreetMap."""
    place = orte.lookup(name)
    if place is not None:
        return place
    try:
        query = urllib.parse.urlencode({"q": name, "format": "json", "limit": 1, "accept-language": "de"})
        found = json.loads(_get(f"{GEOCODE_API}?{query}", opener, timeout=6).decode("utf-8"))
    except Exception as exc:
        log.info("Ortssuche %s: %s", name, exc)
        return None
    if not found:
        return None
    hit = found[0]
    try:
        south, north, west, east = (float(v) for v in hit.get("boundingbox") or [])
        km = max(5.0, min(4000.0, max(north - south, (east - west) * 0.7) * 111))
    except (TypeError, ValueError):
        km = 30.0
    label = str(hit.get("name") or str(hit.get("display_name") or name).split(",")[0]).strip() or name
    return orte.Ort(label, round(float(hit["lat"]), 4), round(float(hit["lon"]), 4), round(km, 1))


# ---------------------------------------------------------------------- Sprache


def _norm(text: str) -> str:
    norm = " ".join(re.sub(r"[.,!?;:\"'„“”]", " ", str(text).lower()).split())
    norm = re.sub(r"^(?:(?:hey|hallo|okay|ok) )?jarvis ", "", norm)
    return re.sub(r"^(?:bitte |mal |jetzt |also |okay |ok |und |danke )+", "", norm).replace(" bitte", "").strip()


_VIEW = r"(?:weltlage|weltkarte|welt-?ansicht|erde|globus|gottes auge|god'?s eye|satelliten(?:bild|ansicht|karte)?)"
_OPEN = re.compile(rf"^(?:(?:öffne|zeig|zeige|starte|start|aktivier|aktiviere)(?: mir)? )?(?:die |den |das )?{_VIEW}"
                   r"(?: an| auf| öffnen| starten| zeigen)?$")
_CLOSE = re.compile(rf"^(?:(?:schließ|schließe|beende|verlass|verlasse)(?: die| den| das)? {_VIEW}|{_VIEW} (?:zu|aus|schließen)|"
                    r"(?:(?:geh|gehe|bring mich) )?(?:zurück )?(?:zum|ins) hauptmenü|hauptmenü)$")
_WORLD = re.compile(r"^(?:(?:zeig|zeige|sag|sage|erzähl|erzähle)(?: mir)?(?: mal)? )?(?:was|was so) (?:gerade |heute |aktuell )?"
                    r"(?:in der welt|auf der welt|weltweit) (?:passiert|los ist|geschieht)$|"
                    r"^was (?:passiert|ist los|geschieht) (?:gerade |heute |aktuell )?(?:in der welt|auf der welt|weltweit)$|"
                    r"^(?:(?:gib|zeig|zeige)(?: mir)? (?:den |einen |die )?)?(?:lagebericht|weltlage(?:bericht)?|welt-?nachrichten|"
                    r"nachrichten aus (?:aller )?welt|lage der welt)(?: welt)?$")
_GERMANY = re.compile(r"^(?:(?:zeig|zeige|sag|sage|erzähl|erzähle)(?: mir)?(?: mal)? )?(?:was|was so) (?:gerade |heute |aktuell )?"
                      r"in deutschland (?:passiert|los ist|geschieht)$|"
                      r"^was (?:passiert|ist los|geschieht) (?:gerade |heute |aktuell )?in deutschland$|"
                      r"^(?:(?:gib|zeig|zeige)(?: mir)? (?:den |einen )?)?(?:lagebericht deutschland|lage in deutschland|"
                      r"deutschland-?nachrichten|nachrichten aus deutschland|inlandsnachrichten)$")
_ECONOMY = re.compile(r"^(?:(?:zeig|zeige|gib)(?: mir)? (?:die )?)?(?:wirtschaftsnachrichten|wirtschaftslage|"
                      r"nachrichten (?:aus der|zur) wirtschaft)$")
_MARKETS = re.compile(r"^(?:wie (?:steht|stehen|läuft|laufen) (?:der |die )?(?:dax|börse|börsen|aktien|märkte|kurse)(?: gerade| heute)?|"
                      r"(?:was macht|was machen) (?:der |die )?(?:dax|börse|börsen|märkte|kurse)(?: gerade| heute)?|"
                      r"börsenkurse|marktbericht|(?:zeig|zeige)(?: mir)? (?:die )?(?:börse|kurse|märkte))$")
_FLY = re.compile(r"^(?:flieg|fliege|zoom|zoome|bring mich|geh|gehe|spring|springe|navigier|navigiere)(?: mir| uns)?"
                  r"(?: mal)? (?:nach|zu|zum|zur|auf|über|in|ins) (?P<where>.+?)(?: rein| ran| hin)?$")
_SHOW = re.compile(r"^(?:zeig|zeige)(?: mir| uns)? (?:mal )?(?P<where>.+?)(?: auf der (?:karte|erde|weltkarte)| von oben| aus dem all)?$")
_HOLO_WORDS = r"(?:hologramm|holo)(?:-?modus|-?ansicht|-?erde|-?globus)?"
_SAT_WORDS = (r"(?:satellitenbild(?:er)?|satellitenansicht|satelliten-?modus|echte erde|echte ansicht|echtes bild|"
              r"normale ansicht|normale erde|foto-?ansicht|foto-?modus)")
_LOOK = re.compile(r"^(?:(?:zeig|zeige|mach|schalt|schalte|wechsel|wechsle|stell|stelle)(?: mir)? )?(?:die |das |den )?"
                   r"(?:(?P<earth>erde|welt|weltkugel|weltlage|globus) )?(?:als |zum |zur |in den |in die |auf (?:den |die |das )?)?"
                   rf"(?:(?P<holo>{_HOLO_WORDS})|(?P<sat>{_SAT_WORDS}))(?: (?P<sw>an|ein|aus|um))?$")
_NEXT = re.compile(r"^(?:weiter|nächste(?: meldung| nachricht)?|die nächste|überspring\w*|skip)$")
_BACK = re.compile(r"^(?:zurück|vorherige(?: meldung| nachricht)?|die vorherige|noch ?mal(?: die letzte)?)$")
_FLIGHTS = re.compile(r"^(?:(?:zeig|zeige)(?: mir)? (?:den |die )?)?(?P<what>flugverkehr|flugzeuge|flüge|luftverkehr)"
                      r"(?: (?P<sw>an|aus|ein|weg|ausblenden|einblenden))?$")
_ISS = re.compile(r"^(?:wo (?:ist|fliegt|steckt) (?:gerade |jetzt )?(?:die )?(?:iss|raumstation)(?: gerade| jetzt)?|"
                  r"(?:zeig|zeige)(?: mir)? (?:die )?(?:iss|raumstation)|(?:flieg|fliege) (?:zur|zu der) (?:iss|raumstation))$")
_HANDS = re.compile(r"^(?:(?P<on>starte|start|aktivier|aktiviere|schalt|schalte|mach)|(?P<off>beende|stopp|stoppe|deaktivier|"
                    r"deaktiviere))?(?: die)? (?:hand-?steuerung|gesten-?steuerung|steuerung (?:mit|per) (?:der )?hand)"
                    r"(?: (?P<sw>an|ein|aus|ab))?$|^(?:hand-?steuerung|gesten-?steuerung) (?P<sw2>an|ein|aus|ab|starten|beenden)$")
_ZOOM = re.compile(r"^(?:(?:zoom|zoome|geh|gehe|flieg|fliege) )?(?P<dir>rein|hinein|näher|ran|raus|heraus|hinaus|weiter weg)"
                   r"(?: zoomen)?$|^(?P<dir2>näher ran|weiter raus|ganz raus)$")
_NOT_A_PLACE = re.compile(r"\b(?:fenster|programm\w*|ordner|datei\w*|desktop|bildschirm|einstellung\w*|projekt\w*|"
                          r"blaupause|werkstatt|verlauf|gedächtnis|lied\w*|musik|video\w*|bild\w*|foto\w*|website|"
                          r"webseite|seite|nachricht\w*|mail\w*|termin\w*|wetter|uhr|zeit)\b")


class Weltlage:
    """Was gerade auf der Erde zu sehen ist, und die Meldungen, die Jarvis vorliest."""

    def __init__(self, cfg: dict, ui, say: Callable[[str], None], wait: Callable[..., bool],
                 show_window: Callable[[], None] | None = None, hush: Callable[[], None] | None = None,
                 opener=None) -> None:
        """say: sagen (und im Fenster zeigen), wait(timeout): warten, bis es gesagt ist, hush: sofort still."""
        section = cfg.get("weltlage", {}) or {}
        self.limit = int(section.get("meldungen", MAX_ITEMS) or MAX_ITEMS)
        self._ui = ui
        self._say = say
        self._wait = wait
        self._show_window = show_window
        self._hush = hush
        self._opener = opener
        self.active = False  # im Fenster offen
        self.items: list[dict] = []
        self.look = ""  # "holo" oder "satellit", leer = wie das Fenster es zuletzt hatte
        self.kind = ""
        self.index = -1
        self._run = 0  # zählt die Lageberichte: ein neuer beendet den alten
        self._running = False
        self._skip = threading.Event()
        self._back = False
        self._lock = threading.Lock()
        self._markets: tuple[float, list[dict]] = (0.0, [])
        self._flights: dict[str, tuple[float, list[dict]]] = {}
        self._flights_paused_until = 0.0

    # ------------------------------------------------------------------ Anzeige

    def _emit(self, action: str, **data) -> None:
        try:
            self._ui.world({"action": action, **data})
        except AttributeError:
            pass  # eine Anzeige ohne Erde (Konsole)
        except Exception as exc:
            log.debug("Weltlage, Anzeige: %s", exc)

    def state(self) -> dict:
        return {"active": self.active, "items": list(self.items), "kind": self.kind, "index": self.index,
                "busy": self.busy, "title": KINDS.get(self.kind, ("", "Gottes Auge", ""))[1], "look": self.look}

    @property
    def busy(self) -> bool:
        return self._running

    def open(self, quiet: bool = False) -> str:
        self.active = True
        self._emit("open", **self.state())
        if self._show_window is not None:
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Weltlage, Fenster: %s", exc)
        return "" if quiet else "Satellitenverbindung steht, Sir."

    def close(self) -> str:
        self.cancel()
        self.active = False
        self._emit("close")
        return "Sehr wohl, Sir."

    def set_active(self, on: bool) -> None:
        self.active = bool(on)
        if not on:
            self.cancel()

    # ------------------------------------------------------------------ Sprache

    def command(self, text: str, elsewhere: bool = False) -> str | None:
        """Ein Satz für die Weltlage. None = nicht für die Weltlage. elsewhere: eine andere Ansicht ist offen
        (die Blaupause), dann gilt die Handsteuerung dort."""
        norm = _norm(text)
        if not norm:
            return None
        hands = _HANDS.match(norm)
        if hands:
            switch = hands.group("sw") or hands.group("sw2") or ""
            on = not (hands.group("off") or switch in ("aus", "ab", "beenden"))
            if on and not self.active and not elsewhere:
                self.open(quiet=True)
            self._emit("hands", on=on)
            return "Sehr wohl, Sir. Handsteuerung aktiv." if on else "Handsteuerung aus, Sir."
        look = _LOOK.match(norm)
        # "Hologramm" allein gilt nur hier, wenn die Weltlage offen ist (sonst schaltet es die Blaupause um)
        if look and (look.group("earth") or (self.active and not elsewhere)):
            holo = bool(look.group("holo"))
            if look.group("sw") == "aus":
                holo = not holo  # "Hologramm aus" = Satellitenbild
            return self.set_look("holo" if holo else "satellit")
        if _WORLD.match(norm):
            return self.briefing("welt")
        if _GERMANY.match(norm):
            return self.briefing("deutschland")
        if _ECONOMY.match(norm):
            return self.briefing("wirtschaft")
        if _OPEN.match(norm):
            return self.open()
        if _MARKETS.match(norm):
            return markets_sentence(self.markets())
        if _ISS.match(norm):
            return self.iss()
        if not self.active:
            flown = _FLY.match(norm)
            if flown and norm.startswith(("flieg", "fliege")):
                return self.fly(flown.group("where"))
            return None
        if self._running and not (_NEXT.match(norm) or _BACK.match(norm)):
            self.cancel()  # Georg fragt etwas anderes: der Lagebericht hört auf
        if _CLOSE.match(norm):
            return self.close()
        if _NEXT.match(norm):
            return self.next()
        if _BACK.match(norm):
            return self.previous()
        flights = _FLIGHTS.match(norm)
        if flights:
            on = (flights.group("sw") or "an") in ("an", "ein", "einblenden")
            self._emit("layer", name="flights", on=on)
            return "Flugverkehr eingeblendet, Sir." if on else "Flugverkehr ausgeblendet, Sir."
        zoom = _ZOOM.match(norm)
        if zoom:
            way = zoom.group("dir") or zoom.group("dir2") or ""
            closer = way in ("rein", "hinein", "näher", "ran", "näher ran")
            self._emit("view", what="zoom", factor=0.45 if closer else (6.0 if way == "ganz raus" else 2.2))
            return "Sehr wohl, Sir."
        flown = _FLY.match(norm) or _SHOW.match(norm)
        if flown and not _NOT_A_PLACE.search(flown.group("where")):
            # Nur "Flieg nach ..." sucht auch im Internet. "Geh in den Gaming-Modus", "Gehe zu Discord" oder
            # "Navigiere zu Google" meinen meist etwas anderes: ohne bekannten Ort geht es normal weiter.
            return self.fly(flown.group("where"), explicit=norm.startswith(("flieg ", "fliege ")))
        return None

    def set_look(self, mode: str) -> str:
        """Die Erde als Hologramm (leuchtende Kontinente, wie im Film) oder als Satellitenbild."""
        self.look = "holo" if mode == "holo" else "satellit"
        if not self.active:
            self.open(quiet=True)
        self._emit("look", mode=self.look)
        return "Hologramm-Ansicht, Sir." if self.look == "holo" else "Satellitenbild, Sir."

    def fly(self, where: str, explicit: bool = True) -> str | None:
        where = re.sub(r"^(?:den |die |das |dem |der )", "", where.strip())
        place = geocode(where, self._opener) if explicit else orte.lookup(where)
        if place is None:
            return f"{where[:1].upper() + where[1:]} finde ich auf der Karte nicht, Sir." if explicit else None
        if not self.active:
            self.open(quiet=True)
        self._emit("fly", ort=place.as_dict())
        return f"Kurs auf {place.name}, Sir."

    def iss(self) -> str:
        """"Wo ist die ISS gerade?": hinfliegen und sagen, worüber sie fliegt."""
        live = iss_position(self._opener)
        if live is None:
            return "Die Raumstation finde ich gerade nicht, Sir. Die Bahndaten sind nicht erreichbar."
        if not self.active:
            self.open(quiet=True)
        self._emit("fly", ort=live)
        land = region_name(live["lat"], live["lon"], self._opener)
        where = f"über {land}" if land else "über dem Meer"
        return f"Die Raumstation fliegt gerade {where}, Sir, in {live['hoehe']} Kilometern Höhe."

    # ------------------------------------------------------------------ Lagebericht

    def briefing(self, kind: str = "welt") -> str:
        """Holt die Meldungen und liest sie vor, während die Erde von Ort zu Ort fliegt."""
        self.cancel()
        with self._lock:
            self._run += 1
            run = self._run
            self._running = True
        self.kind = kind
        if not self.active:
            self.open(quiet=True)
        self._emit("loading", kind=kind, title=KINDS.get(kind, KINDS["welt"])[1])
        threading.Thread(target=self._brief, args=(run, kind), name="jarvis-weltlage", daemon=True).start()
        return KINDS.get(kind, KINDS["welt"])[2]

    def _current(self, run: int) -> bool:
        return self._run == run and self._running

    def _brief(self, run: int, kind: str) -> None:
        try:
            try:
                items = fetch_news(kind, self._opener, self.limit)
            except Exception as exc:
                log.warning("Weltlage, Nachrichten: %s", exc)
                items = []
            if not self._current(run):
                return
            self.items, self.index = items, -1
            self._emit("news", items=items, kind=kind, title=KINDS.get(kind, KINDS["welt"])[1])
            threading.Thread(target=self._push_markets, daemon=True).start()
            if not items:
                self._say("Die Nachrichten erreiche ich gerade nicht, Sir.")
                return
            time.sleep(0.4)
            self._wait(60)  # erst den Anfang ("Lagebericht, Sir.") ausreden lassen
            position = 0
            while 0 <= position < len(items) and self._current(run):
                self._skip.clear()
                self.index = position
                self._emit("focus", index=position)
                if self._skip.wait(1.2):  # die Erde fliegt schon, Jarvis setzt kurz danach ein
                    position = self._step(position)
                    continue
                if not self._current(run):
                    return
                self._say(items[position]["sprechen"])
                while self._current(run) and not self._skip.is_set():
                    if self._wait_briefly():
                        break
                if not self._current(run):
                    return
                if self._skip.is_set():
                    position = self._step(position)
                    continue
                self._skip.wait(PAUSE_BETWEEN)
                position = self._step(position) if self._skip.is_set() else position + 1
            if self._current(run):
                self._emit("done")
                self._say("Das war die Lage, Sir.")
        finally:
            with self._lock:
                if self._run == run:
                    self._running = False

    def _step(self, position: int) -> int:
        back, self._back = self._back, False
        return max(0, position - 1) if back else position + 1

    def _wait_briefly(self) -> bool:
        """Wartet höchstens 0,3 Sekunden aufs Ausreden (dazwischen zählen "Weiter" und "Stopp")."""
        return bool(self._wait(0.3))

    def _quiet(self) -> None:
        if self._hush is not None:
            try:
                self._hush()
            except Exception as exc:
                log.debug("Weltlage, still: %s", exc)

    def next(self) -> str:
        if not self.items:
            return "Es läuft gerade kein Lagebericht, Sir."
        if self._running:
            self._quiet()
            self._skip.set()
            return ""
        self.index = min(len(self.items) - 1, self.index + 1)
        self._emit("focus", index=self.index)
        return self.items[self.index]["sprechen"]

    def previous(self) -> str:
        if not self.items:
            return "Es läuft gerade kein Lagebericht, Sir."
        if self._running:
            self._back = True
            self._quiet()
            self._skip.set()
            return ""
        self.index = max(0, self.index - 1)
        self._emit("focus", index=self.index)
        return self.items[self.index]["sprechen"]

    def cancel(self) -> bool:
        """Hält den Lagebericht an (nach dem Satz, der gerade läuft). True = es lief einer."""
        with self._lock:
            was = self._running
            self._running = False
        self._skip.set()
        return was

    def focus(self, index: int) -> None:
        """Georg tippt im Fenster auf eine Meldung: Jarvis liest sie vor (der Lagebericht hört auf)."""
        self.cancel()
        if 0 <= index < len(self.items):
            self.index = index
            self._emit("focus", index=index)
            self._say(self.items[index]["sprechen"])

    # ------------------------------------------------------------------ Vom Gehirn

    def take_handoff(self, state_dir: Path) -> bool:
        """Ein Ort, den das Gehirn zeigen will ("Wo liegt Bhutan?"). True = übernommen."""
        path = Path(state_dir) / HANDOFF
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        try:
            path.unlink()
        except OSError:
            pass
        try:
            age = (dt.datetime.now() - dt.datetime.fromisoformat(str(data.get("zeit")))).total_seconds()
        except (TypeError, ValueError):
            age = 0
        where = str(data.get("ort") or "").strip()[:120]
        if not where or age > 120:
            return False
        kind = str(data.get("lage") or "")
        if kind in KINDS:
            self.briefing(kind)
            return True
        # Die Ortssuche kann ins Internet gehen: nicht in der Schleife, die auch die Erinnerungen prüft
        threading.Thread(target=self._show_place, args=(where,), name="jarvis-weltlage-ort", daemon=True).start()
        return True

    def _show_place(self, where: str) -> None:
        place = geocode(where, self._opener)
        if place is None:
            log.info("Weltlage vom Gehirn: %s nicht gefunden", where)
            return
        if not self.active:
            self.open(quiet=True)
        self._emit("fly", ort=place.as_dict())

    # ------------------------------------------------------------------ Kurse und Flüge

    def markets(self) -> list[dict]:
        at, cached = self._markets
        if cached and time.monotonic() - at < MARKETS_SECONDS:
            return cached
        fresh = fetch_markets(self._opener)
        if fresh:
            self._markets = (time.monotonic(), fresh)
        return fresh or cached

    def _push_markets(self) -> None:
        try:
            self._emit("markets", items=self.markets())
        except Exception as exc:
            log.debug("Weltlage, Kurse: %s", exc)

    def flights(self, box) -> dict:
        """Flugzeuge über dem Ausschnitt, den das Fenster gerade zeigt. {"planes", "error", "wait"}"""
        try:
            south, west, north, east = (float(v) for v in box)
        except (TypeError, ValueError):
            return {"planes": [], "error": "Ausschnitt fehlt"}
        south, north = max(-85.0, min(south, north)), min(85.0, max(south, north))
        if north - south > 40 or (east - west) % 360 > 60:
            return {"planes": [], "error": "Bitte näher heran, Sir: Flugzeuge zeige ich ab Landesgröße."}
        if time.monotonic() < self._flights_paused_until:
            return {"planes": [], "error": "OpenSky braucht eine Pause.",
                    "wait": round(self._flights_paused_until - time.monotonic())}
        key = f"{south:.0f},{west:.0f},{north:.0f},{east:.0f}"
        at, cached = self._flights.get(key, (0.0, []))
        if cached and time.monotonic() - at < FLIGHTS_SECONDS:
            return {"planes": cached, "error": "", "age": round(time.monotonic() - at)}
        try:
            planes = fetch_flights((south, west, north, east), self._opener)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                self._flights_paused_until = time.monotonic() + FLIGHTS_PAUSE
                return {"planes": cached, "error": "OpenSky braucht eine Pause (zu viele Abfragen heute)."}
            return {"planes": cached, "error": f"OpenSky antwortet mit Fehler {exc.code}."}
        except Exception as exc:
            log.info("Weltlage, Flüge: %s", exc)
            return {"planes": cached, "error": "Der Flugverkehr ist gerade nicht erreichbar."}
        if len(self._flights) > 20:
            self._flights.clear()
        self._flights[key] = (time.monotonic(), planes)
        return {"planes": planes, "error": "", "age": 0}


def hand_over(state_dir: Path, where: str = "", kind: str = "") -> Path:
    """Für jarvis.tool: das Gehirn zeigt einen Ort auf der Erde oder startet einen Lagebericht."""
    path = Path(state_dir) / HANDOFF
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"ort": where or kind, "lage": kind, "zeit": dt.datetime.now().isoformat(timespec="seconds")}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path
