#!/usr/bin/env python3
"""Demo-Website-Generator fuer lokale Betriebe.

Erzeugt eine fertige, handyfreundliche Demo-Website als EINE HTML-Datei.
Keine Abhaengigkeiten, keine Google-Fonts, kein Tracking, keine externen Bilder.

Einzelne Demo:
    python3 demo_generator.py --name "Salon Anna" --branche friseur \
        --strasse "Hauptstrasse 5" --plz 4020 --ort Linz \
        --telefon "+43 732 123456" --oeffnungszeiten "Mo-Fr 09:00-18:00; Sa 08:00-12:00" \
        --von "Georg" --kontakt "0660 1234567"

Viele Demos auf einmal (CSV vom kunden_finder.py):
    python3 demo_generator.py --csv kunden.csv --von "Georg" --kontakt "0660 1234567"

Branchen: friseur, kosmetik, werkstatt, handwerk, restaurant, cafe, baeckerei, blumen, allgemein
"""

import argparse
import csv
import html
import re
import sys
import unicodedata
import urllib.parse
from pathlib import Path

# ---------------------------------------------------------------------------
# Branchen: Farben, Texte, Leistungen. Preise sind bewusst als Beispiel markiert.
# ---------------------------------------------------------------------------
BRANCHEN = {
    "friseur": {
        "label": "Friseur",
        "akzent": "#b0756a", "dunkel": "#2b2024", "hell": "#fbf4f2",
        "titel": "Ihr Friseursalon in {ort}",
        "unter": "Schnitt, Farbe und Styling – mit Zeit, Ruhe und ehrlicher Beratung.",
        "cta": "Termin vereinbaren",
        "ueber": "Bei {name} steht Ihr Typ im Mittelpunkt. Wir nehmen uns Zeit für die Beratung, "
                 "arbeiten mit hochwertigen Produkten und sorgen dafür, dass Sie sich nach dem Besuch "
                 "rundum wohlfühlen.",
        "leistungen": [
            ("✂️", "Damenschnitt", "Waschen, Schneiden, Föhnen", "ab 39 €"),
            ("💈", "Herrenschnitt", "Klassisch oder modern, inkl. Styling", "ab 25 €"),
            ("🎨", "Farbe & Strähnen", "Von natürlich bis auffällig", "ab 59 €"),
            ("👰", "Hochsteck & Anlass", "Hochzeit, Ball, Feier", "ab 45 €"),
            ("🧒", "Kinderschnitt", "Mit Geduld und Spaß", "ab 15 €"),
            ("🧴", "Pflege & Bart", "Kur, Bartpflege, Augenbrauen", "ab 12 €"),
        ],
        "preise_zeigen": True,
    },
    "kosmetik": {
        "label": "Kosmetik",
        "akzent": "#9b6fa8", "dunkel": "#251d2a", "hell": "#f8f3fa",
        "titel": "Kosmetik & Wohlfühlen in {ort}",
        "unter": "Professionelle Behandlungen für Haut, Hände und Ihr Wohlbefinden.",
        "cta": "Termin vereinbaren",
        "ueber": "{name} ist Ihr Ort zum Abschalten. Jede Behandlung wird auf Ihre Haut und Ihre "
                 "Wünsche abgestimmt – mit Ruhe, Sorgfalt und hochwertigen Produkten.",
        "leistungen": [
            ("✨", "Gesichtsbehandlung", "Reinigung, Pflege, Massage", "ab 59 €"),
            ("💅", "Maniküre", "Klassisch oder mit Lack", "ab 29 €"),
            ("🦶", "Pediküre", "Pflege für gesunde Füße", "ab 35 €"),
            ("👁️", "Wimpern & Brauen", "Färben, Zupfen, Lifting", "ab 19 €"),
            ("🌿", "Waxing", "Sanfte Haarentfernung", "ab 15 €"),
            ("💆", "Massage", "Entspannung für Körper und Kopf", "ab 45 €"),
        ],
        "preise_zeigen": True,
    },
    "werkstatt": {
        "label": "Kfz-Werkstatt",
        "akzent": "#e0662b", "dunkel": "#1d232b", "hell": "#f4f5f7",
        "titel": "Ihre Kfz-Werkstatt in {ort}",
        "unter": "Service, Reparatur und Prüfung – schnell, ehrlich und zum fairen Preis.",
        "cta": "Termin anfragen",
        "ueber": "Bei {name} bekommen Sie vor jeder Reparatur eine klare Auskunft, was gemacht "
                 "werden muss und was es kostet. Keine Überraschungen – nur saubere Arbeit.",
        "leistungen": [
            ("🔧", "Service & Inspektion", "Nach Herstellervorgabe", "auf Anfrage"),
            ("🛞", "Reifenwechsel", "Inkl. Einlagerung möglich", "ab 39 €"),
            ("✅", "Prüfung & Begutachtung", "Vorbereitung und Abnahme", "auf Anfrage"),
            ("🛑", "Bremsen", "Beläge, Scheiben, Flüssigkeit", "auf Anfrage"),
            ("❄️", "Klima-Service", "Prüfen, Befüllen, Desinfektion", "ab 79 €"),
            ("🚗", "Unfallreparatur", "Abwicklung mit der Versicherung", "auf Anfrage"),
        ],
        "preise_zeigen": True,
    },
    "handwerk": {
        "label": "Handwerk",
        "akzent": "#2f6fdb", "dunkel": "#18202e", "hell": "#f2f6fc",
        "titel": "Ihr Handwerksbetrieb in {ort}",
        "unter": "Zuverlässig, pünktlich und sauber – vom kleinen Auftrag bis zum Projekt.",
        "cta": "Angebot anfragen",
        "ueber": "{name} steht für Qualität aus der Region. Wir beraten ehrlich, halten Termine ein "
                 "und hinterlassen die Baustelle so, wie wir sie vorgefunden haben.",
        "leistungen": [
            ("🛠️", "Reparaturen", "Schnelle Hilfe bei Schäden", "auf Anfrage"),
            ("🏗️", "Neuinstallation", "Planung und Ausführung", "auf Anfrage"),
            ("🔍", "Wartung", "Damit nichts ausfällt", "auf Anfrage"),
            ("🚨", "Notdienst", "Wenn es schnell gehen muss", "auf Anfrage"),
            ("📋", "Beratung vor Ort", "Unverbindlich und kostenlos", "kostenlos"),
            ("🤝", "Für Firmen & Private", "Auch Hausverwaltungen", "auf Anfrage"),
        ],
        "preise_zeigen": True,
    },
    "restaurant": {
        "label": "Restaurant",
        "akzent": "#c0392b", "dunkel": "#2a1c18", "hell": "#fbf6f1",
        "titel": "Gutes Essen in {ort}",
        "unter": "Frisch gekocht, herzlich serviert – wir freuen uns auf Ihren Besuch.",
        "cta": "Tisch reservieren",
        "ueber": "Bei {name} wird mit frischen Zutaten gekocht. Ob schnelles Mittagessen, "
                 "gemütlicher Abend oder Feier mit der Familie – bei uns sind Sie willkommen.",
        "leistungen": [
            ("🍽️", "Mittagsmenü", "Täglich wechselnd", ""),
            ("📖", "Speisekarte", "Klassiker und Saisonales", ""),
            ("🍷", "Getränke", "Ausgewählte Weine und mehr", ""),
            ("🎉", "Feiern & Gruppen", "Geburtstag, Firma, Familie", ""),
            ("🥡", "Zum Mitnehmen", "Einfach vorher anrufen", ""),
            ("🎁", "Gutscheine", "Das perfekte Geschenk", ""),
        ],
        "preise_zeigen": False,
    },
    "cafe": {
        "label": "Café",
        "akzent": "#8a5a3b", "dunkel": "#271c16", "hell": "#faf5ef",
        "titel": "Ihr Café in {ort}",
        "unter": "Guter Kaffee, hausgemachte Kuchen und Zeit zum Durchatmen.",
        "cta": "Tisch reservieren",
        "ueber": "{name} ist der Platz für Ihre Pause. Frisch gebrühter Kaffee, hausgemachte "
                 "Mehlspeisen und eine gemütliche Atmosphäre – allein oder mit Freunden.",
        "leistungen": [
            ("☕", "Kaffeespezialitäten", "Von Espresso bis Cappuccino", ""),
            ("🥐", "Frühstück", "Süß oder herzhaft", ""),
            ("🍰", "Kuchen & Torten", "Hausgemacht", ""),
            ("🥪", "Kleine Speisen", "Für den Hunger zwischendurch", ""),
            ("🎂", "Torten auf Bestellung", "Für Ihren besonderen Tag", ""),
            ("🎁", "Gutscheine", "Ideal zum Verschenken", ""),
        ],
        "preise_zeigen": False,
    },
    "baeckerei": {
        "label": "Bäckerei",
        "akzent": "#c48a3a", "dunkel": "#2a2116", "hell": "#fcf7ee",
        "titel": "Ihre Bäckerei in {ort}",
        "unter": "Jeden Tag frisch gebacken – mit Handwerk und guten Zutaten.",
        "cta": "Vorbestellen",
        "ueber": "Bei {name} wird noch mit Zeit und Handwerk gebacken. Brot, Gebäck und Mehlspeisen "
                 "– jeden Morgen frisch für Sie.",
        "leistungen": [
            ("🍞", "Brot", "Täglich frisch", ""),
            ("🥨", "Gebäck", "Semmeln, Weckerl, Brezen", ""),
            ("🧁", "Mehlspeisen", "Süßes aus eigener Backstube", ""),
            ("☕", "Frühstück & Kaffee", "Auch zum Mitnehmen", ""),
            ("🎂", "Torten auf Bestellung", "Für jeden Anlass", ""),
            ("📦", "Vorbestellung", "Einfach anrufen und abholen", ""),
        ],
        "preise_zeigen": False,
    },
    "blumen": {
        "label": "Blumen",
        "akzent": "#3f8f5a", "dunkel": "#18261d", "hell": "#f2f8f3",
        "titel": "Ihr Blumengeschäft in {ort}",
        "unter": "Frische Blumen und liebevolle Gestaltung für jeden Anlass.",
        "cta": "Strauß bestellen",
        "ueber": "{name} bindet Sträuße mit Liebe zum Detail. Ob kleine Aufmerksamkeit, Hochzeit "
                 "oder Abschied – wir beraten Sie persönlich.",
        "leistungen": [
            ("💐", "Sträuße", "Für jeden Anlass", ""),
            ("💍", "Hochzeitsfloristik", "Brautstrauß bis Tischdeko", ""),
            ("🕊️", "Trauerfloristik", "Würdevoll und persönlich", ""),
            ("🪴", "Pflanzen", "Für Wohnung und Balkon", ""),
            ("🚚", "Lieferservice", "Auf Anfrage", ""),
            ("🎁", "Geschenke", "Kleine Freuden", ""),
        ],
        "preise_zeigen": False,
    },
    "allgemein": {
        "label": "Betrieb",
        "akzent": "#3b5bdb", "dunkel": "#1b1f2e", "hell": "#f3f5fb",
        "titel": "{name} in {ort}",
        "unter": "Persönlich, zuverlässig und direkt vor Ort für Sie da.",
        "cta": "Jetzt anfragen",
        "ueber": "{name} ist Ihr Ansprechpartner in {ort}. Wir nehmen uns Zeit für Ihre Wünsche "
                 "und finden gemeinsam die passende Lösung.",
        "leistungen": [
            ("⭐", "Leistung 1", "Kurze Beschreibung", ""),
            ("⭐", "Leistung 2", "Kurze Beschreibung", ""),
            ("⭐", "Leistung 3", "Kurze Beschreibung", ""),
            ("🤝", "Persönliche Beratung", "Vor Ort oder am Telefon", ""),
            ("📍", "Aus der Region", "Kurze Wege", ""),
            ("📞", "Schnell erreichbar", "Rufen Sie einfach an", ""),
        ],
        "preise_zeigen": False,
    },
}

# OSM-Typen (aus dem Kunden-Finder) -> Branche
OSM_ZU_BRANCHE = {
    "hairdresser": "friseur", "beauty": "kosmetik", "car_repair": "werkstatt",
    "electrician": "handwerk", "plumber": "handwerk", "carpenter": "handwerk",
    "painter": "handwerk", "roofer": "handwerk", "tiler": "handwerk",
    "hvac": "handwerk", "locksmith": "handwerk", "glaziery": "handwerk",
    "restaurant": "restaurant", "fast_food": "restaurant", "cafe": "cafe",
    "bakery": "baeckerei", "pastry": "baeckerei", "florist": "blumen",
}

TAGE = {"Mo": "Mo", "Tu": "Di", "We": "Mi", "Th": "Do", "Fr": "Fr", "Sa": "Sa", "Su": "So",
        "PH": "Feiertag"}

ICON = {
    "tel": '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 '
           '19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 '
           '2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 '
           '2.81.7A2 2 0 0 1 22 16.92z"/>',
    "pin": '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    "uhr": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
}


def svg(name):
    return ('<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + ICON[name] + "</svg>")


def e(text):
    return html.escape(str(text or ""), quote=True)


def slug(text):
    t = (text or "demo").lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        t = t.replace(a, b)
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode("ascii")
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t[:60] or "demo"


def tel_link(nummer):
    n = (nummer or "").split(";")[0].strip()
    plus = n.startswith("+")
    ziffern = re.sub(r"\D", "", n)
    return ("+" if plus else "") + ziffern if ziffern else ""


def oeffnungszeiten_zeilen(roh):
    """Wandelt OSM-Format ('Mo-Fr 08:00-18:00; Sa 08:00-12:00') in Tabellenzeilen um."""
    if not roh or not roh.strip():
        return None
    if roh.strip() == "24/7":
        return [("Täglich", "rund um die Uhr")]
    zeilen = []
    teile = []
    for stueck in roh.split(";"):
        # Manche Eintraege trennen mit Komma statt Semikolon: "Mo-Fr 06:00-21:00, Sa 08:00-12:00"
        teile.extend(re.split(r"(?<=\d),\s*(?=[A-Z])", stueck))
    for teil in teile:
        teil = teil.strip()
        if not teil:
            continue
        teil = re.sub(r"\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b", lambda m: TAGE[m.group(1)], teil)
        teil = re.sub(r"\boff\b|\bclosed\b", "geschlossen", teil)
        teil = re.sub(r",\s*", ", ", teil)
        m = re.match(r"^([A-Za-zäöü,\-\s]+?)\s+(\d.*|geschlossen)$", teil)
        if m:
            tage = m.group(1).replace("-", "–")
            zeit = m.group(2).replace("-", "–").replace(", ", " & ")
            zeilen.append((tage, zeit))
        else:
            zeilen.append((teil, ""))
    return zeilen or None


def baue_demo(d, von="", kontakt=""):
    b = BRANCHEN.get(d.get("branche") or "allgemein", BRANCHEN["allgemein"])
    name = (d.get("name") or "").strip() or "Ihr Betrieb"
    ort = (d.get("ort") or "").strip() or "Ihrer Region"
    strasse = " ".join(x for x in [(d.get("strasse") or "").strip(),
                                   (d.get("hausnummer") or "").strip()] if x)
    plz_ort = " ".join(x for x in [(d.get("plz") or "").strip(), (d.get("ort") or "").strip()] if x)
    adresse = ", ".join(x for x in [strasse, plz_ort] if x)
    telefon = (d.get("telefon") or "").split(";")[0].strip()
    tel = tel_link(telefon)
    fmt = {"name": name, "ort": ort}

    route = "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(
        f"{name} {adresse}".strip())

    cta_href = f"tel:{tel}" if tel else "#kontakt"
    cta_text = b["cta"]

    karten = []
    for icon, titel, text, preis in b["leistungen"]:
        p = f'<span class="preis">{e(preis)}</span>' if (b["preise_zeigen"] and preis) else ""
        karten.append(
            f'<article class="karte"><div class="icon">{icon}</div><h3>{e(titel)}</h3>'
            f'<p>{e(text)}</p>{p}</article>')

    zeilen = oeffnungszeiten_zeilen(d.get("oeffnungszeiten"))
    if zeilen:
        zeiten_html = "".join(f"<tr><th>{e(t)}</th><td>{e(z)}</td></tr>" for t, z in zeilen)
        zeiten_hinweis = ""
    else:
        zeiten_html = ("<tr><th>Mo–Fr</th><td>08:00–18:00</td></tr>"
                       "<tr><th>Sa</th><td>08:00–12:00</td></tr>")
        zeiten_hinweis = '<p class="hinweis">Platzhalter – wird mit Ihren echten Zeiten ersetzt.</p>'

    preis_hinweis = ('<p class="hinweis mitte">Beispielpreise – werden durch Ihre echten Preise ersetzt.</p>'
                     if b["preise_zeigen"] else "")

    banner_von = f" von {e(von)}" if von else ""
    banner_kontakt = f' · Kontakt: <a href="tel:{e(tel_link(kontakt))}">{e(kontakt)}</a>' if kontakt else ""

    tel_block = (f'<a class="zeile" href="tel:{e(tel)}">{svg("tel")}<span>{e(telefon)}</span></a>'
                 if tel else f'<div class="zeile">{svg("tel")}<span>Telefonnummer folgt</span></div>')
    adr_block = (f'<a class="zeile" href="{e(route)}" target="_blank" rel="noopener">{svg("pin")}'
                 f'<span>{e(adresse)}</span></a>' if adresse else
                 f'<div class="zeile">{svg("pin")}<span>Adresse folgt</span></div>')

    return f"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{e(name)} – {e(b["label"])} in {e(ort)} (Entwurf)</title>
<style>
:root {{ --akzent: {b["akzent"]}; --dunkel: {b["dunkel"]}; --hell: {b["hell"]}; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ scroll-behavior: smooth; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1f2328; background: #fff; line-height: 1.6; -webkit-font-smoothing: antialiased; }}
a {{ color: inherit; }}
.entwurf {{ background: #111; color: #fff; font-size: 13px; text-align: center; padding: 8px 12px; }}
.entwurf a {{ color: #ffd479; }}
header {{ position: sticky; top: 0; z-index: 10; background: rgba(255,255,255,.92);
  backdrop-filter: blur(8px); border-bottom: 1px solid #eee; }}
.nav {{ max-width: 1080px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; gap: 12px; }}
.logo {{ font-weight: 800; font-size: 18px; letter-spacing: -.02em; color: var(--dunkel); }}
.logo span {{ color: var(--akzent); }}
.btn {{ display: inline-flex; align-items: center; gap: 8px; background: var(--akzent); color: #fff;
  text-decoration: none; font-weight: 700; padding: 12px 20px; border-radius: 999px; border: 0;
  box-shadow: 0 6px 20px -8px var(--akzent); white-space: nowrap; }}
.btn.klein {{ padding: 9px 16px; font-size: 14px; }}
.btn.hell {{ background: #fff; color: var(--dunkel); box-shadow: none; }}
.hero {{ background: var(--dunkel); background:
  radial-gradient(1200px 500px at 85% -10%, color-mix(in srgb, var(--akzent) 45%, transparent), transparent 60%),
  radial-gradient(700px 400px at 0% 110%, color-mix(in srgb, var(--akzent) 30%, transparent), transparent 60%),
  var(--dunkel); color: #fff; }}
.hero-in {{ max-width: 1080px; margin: 0 auto; padding: 84px 20px 92px; }}
.tag {{ display: inline-block; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #fff; opacity: .9; color: color-mix(in srgb, var(--akzent) 35%, #fff); margin-bottom: 14px; }}
.hero h1 {{ font-size: clamp(34px, 6vw, 60px); line-height: 1.08; letter-spacing: -.03em; max-width: 14ch; }}
.hero p {{ font-size: clamp(17px, 2.2vw, 20px); opacity: .85; max-width: 46ch; margin: 18px 0 30px; }}
.knoepfe {{ display: flex; flex-wrap: wrap; gap: 12px; }}
section {{ padding: 72px 20px; }}
.innen {{ max-width: 1080px; margin: 0 auto; }}
h2 {{ font-size: clamp(26px, 4vw, 36px); letter-spacing: -.02em; color: var(--dunkel); margin-bottom: 8px; }}
.unterzeile {{ color: #5b6470; margin-bottom: 32px; }}
.raster {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }}
.karte {{ background: #fff; border: 1px solid #eceef1; border-radius: 18px; padding: 22px;
  transition: transform .15s ease, box-shadow .15s ease; }}
.karte:hover {{ transform: translateY(-3px); box-shadow: 0 14px 30px -18px rgba(0,0,0,.35); }}
.icon {{ font-size: 28px; width: 52px; height: 52px; display: grid; place-items: center; border-radius: 14px;
  background: var(--hell); margin-bottom: 14px; }}
.karte h3 {{ font-size: 18px; color: var(--dunkel); }}
.karte p {{ color: #5b6470; font-size: 15px; }}
.preis {{ display: inline-block; margin-top: 10px; font-weight: 800; color: var(--akzent); }}
.grau {{ background: var(--hell); }}
.zwei {{ display: grid; grid-template-columns: 1.2fr 1fr; gap: 40px; align-items: start; }}
.ueber p {{ font-size: 18px; color: #3a414a; }}
.vorteile {{ list-style: none; margin-top: 22px; display: grid; gap: 10px; }}
.vorteile li::before {{ content: "✓"; color: var(--akzent); font-weight: 900; margin-right: 10px; }}
.box {{ background: #fff; border-radius: 18px; padding: 24px; border: 1px solid #eceef1; }}
.box h3 {{ display: flex; align-items: center; gap: 8px; color: var(--dunkel); margin-bottom: 12px; }}
table {{ width: 100%; border-collapse: collapse; }}
th, td {{ text-align: left; padding: 8px 0; border-bottom: 1px dashed #e3e6ea; font-size: 15px; }}
th {{ font-weight: 600; color: #3a414a; width: 45%; }}
.zeile {{ display: flex; align-items: center; gap: 10px; text-decoration: none; padding: 10px 0; font-weight: 600; }}
.zeile svg {{ color: var(--akzent); flex: none; }}
.hinweis {{ font-size: 13px; color: #7a828c; margin-top: 10px; }}
.mitte {{ text-align: center; }}
.band {{ background: var(--akzent); color: #fff; text-align: center; }}
.band h2 {{ color: #fff; }}
.band p {{ opacity: .9; margin-bottom: 24px; }}
footer {{ background: var(--dunkel); color: rgba(255,255,255,.7); font-size: 14px; padding: 28px 20px; }}
footer .innen {{ display: flex; flex-wrap: wrap; gap: 12px 24px; justify-content: space-between; }}
footer a {{ color: rgba(255,255,255,.85); }}
.mobil-cta {{ display: none; }}
@media (max-width: 760px) {{
  .zwei {{ grid-template-columns: 1fr; }}
  .nav .btn {{ display: none; }}
  .hero-in {{ padding: 60px 20px 70px; }}
  section {{ padding: 56px 20px; }}
  .mobil-cta {{ display: flex; position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 20;
    justify-content: center; }}
  body {{ padding-bottom: 76px; }}
}}
</style>
</head>
<body>
<div class="entwurf">Entwurf{banner_von} – unverbindlich und kostenlos erstellt für {e(name)}{banner_kontakt}</div>
<header><div class="nav">
  <div class="logo">{e(name)}<span>.</span></div>
  <a class="btn klein" href="{e(cta_href)}">{svg("tel")}{e(cta_text)}</a>
</div></header>

<section class="hero" style="padding:0"><div class="hero-in">
  <div class="tag">{e(b["label"])} · {e(ort)}</div>
  <h1>{e(b["titel"].format(**fmt))}</h1>
  <p>{e(b["unter"])}</p>
  <div class="knoepfe">
    <a class="btn" href="{e(cta_href)}">{svg("tel")}{e(cta_text)}</a>
    <a class="btn hell" href="#kontakt">{svg("pin")}So finden Sie uns</a>
  </div>
</div></section>

<section id="leistungen"><div class="innen">
  <h2>Unsere Leistungen</h2>
  <p class="unterzeile">Was wir für Sie tun können.</p>
  <div class="raster">{"".join(karten)}</div>
  {preis_hinweis}
</div></section>

<section class="grau"><div class="innen zwei">
  <div class="ueber">
    <h2>Über uns</h2>
    <p>{e(b["ueber"].format(**fmt))}</p>
    <ul class="vorteile">
      <li>Persönliche Beratung</li>
      <li>Direkt in {e(ort)}</li>
      <li>Faire, transparente Preise</li>
    </ul>
  </div>
  <div class="box" id="zeiten">
    <h3>{svg("uhr")} Öffnungszeiten</h3>
    <table>{zeiten_html}</table>
    {zeiten_hinweis}
  </div>
</div></section>

<section id="kontakt"><div class="innen zwei">
  <div>
    <h2>Kontakt</h2>
    <p class="unterzeile">Rufen Sie an oder kommen Sie einfach vorbei.</p>
    {tel_block}
    {adr_block}
  </div>
  <div class="box">
    <h3>{svg("pin")} Anfahrt</h3>
    <p>{e(adresse) or "Adresse folgt"}</p>
    <p style="margin-top:14px"><a class="btn klein" href="{e(route)}" target="_blank" rel="noopener">Route planen</a></p>
    <p class="hinweis">Die Karte öffnet sich erst nach Klick – ohne Tracking auf dieser Seite.</p>
  </div>
</div></section>

<section class="band"><div class="innen">
  <h2>Wir freuen uns auf Sie!</h2>
  <p>{e(name)} – {e(b["label"])} in {e(ort)}</p>
  <a class="btn hell" href="{e(cta_href)}">{svg("tel")}{e(cta_text)}</a>
</div></section>

<footer><div class="innen">
  <div>© {e(name)}</div>
  <div><a href="#" title="Wird bei Freischaltung ergänzt">Impressum</a> · <a href="#" title="Wird bei Freischaltung ergänzt">Datenschutz</a></div>
</div></footer>

<div class="mobil-cta"><a class="btn" href="{e(cta_href)}">{svg("tel")}{e(cta_text)}</a></div>
</body>
</html>
"""


def baue_index(eintraege, von=""):
    zeilen = []
    for d, datei in eintraege:
        adr = " ".join(x for x in [d.get("strasse", ""), d.get("hausnummer", ""), d.get("plz", ""),
                                    d.get("ort", "")] if x)
        check = "https://www.google.com/search?q=" + urllib.parse.quote(f'{d.get("name","")} {d.get("ort","")}')
        tel = d.get("telefon", "")
        zeilen.append(
            f'<li><a class="t" href="{e(datei)}">{e(d.get("name"))}</a>'
            f'<span>{e(BRANCHEN.get(d.get("branche"), BRANCHEN["allgemein"])["label"])} · {e(adr)}</span>'
            f'<span>{e(tel) or "keine Telefonnummer"} · <a href="{e(check)}" target="_blank" rel="noopener">'
            f'Website schon vorhanden? prüfen</a></span></li>')
    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Meine Demos ({len(eintraege)})</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0;
  background: #f4f5f7; color: #1f2328; }}
h1 {{ font-size: 22px; padding: 20px; margin: 0; background: #111; color: #fff; }}
ul {{ list-style: none; margin: 0; padding: 12px; display: grid; gap: 10px; }}
li {{ background: #fff; border-radius: 14px; padding: 14px 16px; display: grid; gap: 4px; }}
.t {{ font-weight: 800; font-size: 17px; color: #1b4dd6; text-decoration: none; }}
span {{ color: #5b6470; font-size: 14px; }}
</style></head><body>
<h1>Meine Demos ({len(eintraege)}){" – " + e(von) if von else ""}</h1>
<ul>{"".join(zeilen)}</ul>
</body></html>
"""


def main():
    ap = argparse.ArgumentParser(description="Erzeugt Demo-Websites fuer lokale Betriebe.")
    ap.add_argument("--csv", help="CSV-Datei vom kunden_finder.py (erzeugt viele Demos)")
    ap.add_argument("--name")
    ap.add_argument("--branche", default="allgemein", help=", ".join(BRANCHEN))
    ap.add_argument("--strasse", default="")
    ap.add_argument("--hausnummer", default="")
    ap.add_argument("--plz", default="")
    ap.add_argument("--ort", default="")
    ap.add_argument("--telefon", default="")
    ap.add_argument("--oeffnungszeiten", default="", help='OSM-Format, z.B. "Mo-Fr 09:00-18:00; Sa 09:00-12:00"')
    ap.add_argument("--von", default="", help="Dein Name (steht im Entwurfs-Banner)")
    ap.add_argument("--kontakt", default="", help="Deine Telefonnummer (steht im Entwurfs-Banner)")
    ap.add_argument("--ausgabe", default="demos", help="Ausgabeordner (Standard: demos)")
    a = ap.parse_args()

    out = Path(a.ausgabe)
    out.mkdir(parents=True, exist_ok=True)

    if a.csv:
        with open(a.csv, newline="", encoding="utf-8") as f:
            reihen = list(csv.DictReader(f))
        eintraege, genutzt = [], set()
        for r in reihen:
            if not (r.get("name") or "").strip():
                continue
            r["branche"] = r.get("branche") or OSM_ZU_BRANCHE.get(r.get("osm_typ", ""), "allgemein")
            if r["branche"] not in BRANCHEN:
                r["branche"] = "allgemein"
            basis = slug(f'{r["name"]}-{r.get("ort", "")}')
            datei, n = f"{basis}.html", 2
            while datei in genutzt:
                datei, n = f"{basis}-{n}.html", n + 1
            genutzt.add(datei)
            (out / datei).write_text(baue_demo(r, a.von, a.kontakt), encoding="utf-8")
            eintraege.append((r, datei))
        (out / "index.html").write_text(baue_index(eintraege, a.von), encoding="utf-8")
        print(f"{len(eintraege)} Demos erstellt in {out}/ (Übersicht: {out}/index.html)")
        return

    if not a.name:
        ap.error("--name oder --csv angeben")
    if a.branche not in BRANCHEN:
        ap.error(f"Unbekannte Branche '{a.branche}'. Erlaubt: {', '.join(BRANCHEN)}")
    d = vars(a)
    datei = out / f"{slug(a.name + '-' + a.ort)}.html"
    datei.write_text(baue_demo(d, a.von, a.kontakt), encoding="utf-8")
    print(f"Demo erstellt: {datei}")


if __name__ == "__main__":
    sys.exit(main())
