#!/usr/bin/env python3
"""Kunden-Finder: sucht lokale Betriebe OHNE eingetragene Website (Daten: OpenStreetMap).

Beispiel:
    python3 kunden_finder.py --stadt Linz
    python3 kunden_finder.py --stadt "Wels" --branchen friseur,werkstatt --ausgabe wels.csv

Danach direkt Demos bauen:
    python3 demo_generator.py --csv wels.csv --von "Dein Name" --kontakt "Deine Nummer"

Wichtig:
- "Keine Website in OpenStreetMap" heisst NICHT sicher "keine Website". Vor dem Besuch
  kurz pruefen (in der Demo-Uebersicht gibt es dafuer pro Betrieb einen Prueflink).
- Nutzt den freien Nominatim-Dienst von OpenStreetMap. Regeln: max. 1 Anfrage pro Sekunde,
  keine Massenabfragen. Das Script haelt sich daran. Daten: © OpenStreetMap-Mitwirkende (ODbL).
"""

import argparse
import csv
import json
import sys
import time
import urllib.parse
import urllib.request

# Branche -> Suchbegriffe, die Nominatim versteht (englische "special phrases")
SUCHEN = {
    "friseur": ["hairdresser"],
    "kosmetik": ["beauty shop"],
    "werkstatt": ["car repair"],
    "handwerk": ["electrician", "carpenter", "plumber", "painter"],
    "restaurant": ["restaurant"],
    "cafe": ["cafe"],
    "baeckerei": ["bakery"],
    "blumen": ["florist"],
}

TYP_ZU_BRANCHE = {
    "hairdresser": "friseur", "beauty": "kosmetik", "car_repair": "werkstatt",
    "electrician": "handwerk", "carpenter": "handwerk", "plumber": "handwerk", "painter": "handwerk",
    "restaurant": "restaurant", "cafe": "cafe", "bakery": "baeckerei", "florist": "blumen",
}

WEBSITE_TAGS = ("website", "contact:website", "url", "contact:url", "facebook", "contact:facebook",
                "instagram", "contact:instagram")
NUR_ECHTE_WEBSITE = ("website", "contact:website", "url", "contact:url")

FELDER = ["name", "branche", "osm_typ", "strasse", "hausnummer", "plz", "ort", "telefon",
          "oeffnungszeiten", "hat_website_osm", "hat_social_osm", "osm_link"]

USER_AGENT = "lokal-website-finder/1.0 (kleines Einzelprojekt; github.com/georghatzmann-bit)"
_letzte_anfrage = [0.0]


def anfrage(params):
    warte = 1.1 - (time.time() - _letzte_anfrage[0])
    if warte > 0:
        time.sleep(warte)
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "de"})
    for versuch in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                _letzte_anfrage[0] = time.time()
                return json.loads(r.read().decode("utf-8"))
        except Exception as fehler:  # Netzwerkfehler: kurz warten, nochmal
            _letzte_anfrage[0] = time.time()
            if versuch == 2:
                print(f"  ! Anfrage fehlgeschlagen: {fehler}", file=sys.stderr)
                return []
            time.sleep(3 * (versuch + 1))
    return []


def suche(begriff, stadt, land, seiten):
    ergebnisse, ausschliessen = [], []
    for _ in range(seiten):
        params = {"q": f"{begriff} in {stadt}", "format": "jsonv2", "limit": 50,
                  "extratags": 1, "addressdetails": 1}
        if land:
            params["countrycodes"] = land
        if ausschliessen:
            params["exclude_place_ids"] = ",".join(ausschliessen)
        neu = anfrage(params)
        if not neu:
            break
        ergebnisse.extend(neu)
        ausschliessen.extend(str(x["place_id"]) for x in neu)
        if len(neu) < 50:
            break
    return ergebnisse


def main():
    ap = argparse.ArgumentParser(description="Findet lokale Betriebe ohne Website (OpenStreetMap).")
    ap.add_argument("--stadt", required=True)
    ap.add_argument("--branchen", default=",".join(SUCHEN),
                    help="Kommagetrennt: " + ", ".join(SUCHEN))
    ap.add_argument("--land", default="", help="Optional: at, de oder ch")
    ap.add_argument("--seiten", type=int, default=2, help="Seiten à 50 Treffer pro Suchbegriff (Standard 2)")
    ap.add_argument("--alle", action="store_true", help="Auch Betriebe MIT Website ausgeben")
    ap.add_argument("--ausgabe", default="")
    a = ap.parse_args()

    branchen = [b.strip() for b in a.branchen.split(",") if b.strip()]
    falsch = [b for b in branchen if b not in SUCHEN]
    if falsch:
        ap.error(f"Unbekannte Branche(n): {', '.join(falsch)}. Erlaubt: {', '.join(SUCHEN)}")

    gesehen, reihen = set(), []
    for branche in branchen:
        for begriff in SUCHEN[branche]:
            print(f"Suche '{begriff}' in {a.stadt} ...", file=sys.stderr)
            for x in suche(begriff, a.stadt, a.land, a.seiten):
                key = (x.get("osm_type"), x.get("osm_id"))
                name = (x.get("name") or "").strip()
                if key in gesehen or not name:
                    continue
                # Nur Treffer, die wirklich in der Stadt liegen (nicht z.B. "Linzer Strasse" woanders)
                teile = [t.strip().lower() for t in (x.get("display_name") or "").split(",")]
                if a.stadt.strip().lower() not in teile:
                    continue
                gesehen.add(key)
                tags = x.get("extratags") or {}
                adr = x.get("address") or {}
                hat_web = any(t in tags for t in NUR_ECHTE_WEBSITE)
                hat_social = any(t in tags for t in WEBSITE_TAGS if t not in NUR_ECHTE_WEBSITE)
                if hat_web and not a.alle:
                    continue
                reihen.append({
                    "name": name,
                    "branche": TYP_ZU_BRANCHE.get(x.get("type"), branche),
                    "osm_typ": x.get("type", ""),
                    "strasse": adr.get("road", ""),
                    "hausnummer": adr.get("house_number", ""),
                    "plz": adr.get("postcode", ""),
                    "ort": adr.get("city") or adr.get("town") or adr.get("village") or a.stadt,
                    "telefon": tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile") or "",
                    "oeffnungszeiten": tags.get("opening_hours", ""),
                    "hat_website_osm": "ja" if hat_web else "nein",
                    "hat_social_osm": "ja" if hat_social else "nein",
                    "osm_link": f'https://www.openstreetmap.org/{x.get("osm_type")}/{x.get("osm_id")}',
                })

    # Beste Kandidaten zuerst: mit Telefonnummer und Adresse
    reihen.sort(key=lambda r: (r["telefon"] == "", r["strasse"] == "", r["branche"], r["name"]))

    ziel = a.ausgabe or f"kunden-{a.stadt.lower().replace(' ', '-')}.csv"
    with open(ziel, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FELDER)
        w.writeheader()
        w.writerows(reihen)

    pro_branche = {}
    for r in reihen:
        pro_branche[r["branche"]] = pro_branche.get(r["branche"], 0) + 1
    print(f"{len(reihen)} Betriebe ohne eingetragene Website gespeichert in {ziel}", file=sys.stderr)
    for b, n in sorted(pro_branche.items(), key=lambda kv: -kv[1]):
        print(f"  {b}: {n}", file=sys.stderr)


if __name__ == "__main__":
    main()
