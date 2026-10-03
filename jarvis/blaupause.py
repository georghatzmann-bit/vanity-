"""Blueprint (früher "Blaupause"): 3D-Modelle als Hologramm, wie in Tony Starks Werkstatt.

Georg sagt "Generiere einen Iron-Man-Helm" oder "Bau mir eine Drohne als Hologramm". Claude zeichnet das
Modell aus Grundformen (Quader, Kugel, Zylinder, Kegel, Ring, Kapsel, Drehkörper, Extrusion, Rohr) und weichen
Formen für Organisches (Herz, Tiere, Figuren: Kugeln und Stäbe, die ineinanderfließen, weich.py) und schickt es Teil
für Teil als JSON-Zeilen. Jedes Teil erscheint sofort im Fenster und baut sich als
Hologramm auf. Danach geht alles per Sprache:

- sofort, ohne Claude: "Mach das größer", "Dreh das Objekt", "Zoom rein", "Explosionsansicht",
  "Zeig mir das Triebwerk genauer", "Nur den Rumpf", "Mach die Flügel rot", "Entferne die Antenne",
  "Rückgängig", "Von oben", "Drahtmodell", "Speicher das als Drohne", "Exportier als STL", "Hol das Herz"
- Animationen, sofort: "Animier das so, dass es verschmilzt", "Lass es schmelzen", "Lass das Herz schlagen",
  "Lass es schweben", "Lös es auf", "Animation aus"
- mit Claude: "Füg noch zwei Raketen an die Flügel", "Mach den Rumpf schlanker", "Setz ein Cockpit drauf"
- mit Blender (blender.py): "Render das" macht ein Foto wie aus dem Fotostudio, "Öffne das in Blender" eine
  .blend-Datei zum Weiterbauen. Fehlt Blender, installiert Jarvis es.

Solange der Blueprint offen ist, hört Jarvis ohne "Hey Jarvis" weiter zu (voice.BLUEPRINT_SECONDS) und antwortet
knapp: "Sofort, Sir." und danach "Erledigt, Sir.". Was Georg sagt, während Claude noch baut, kommt in eine
Warteschlange und wird direkt danach erledigt.

Python hält das Modell (die Wahrheit für Speichern, Rückgängig und Claude), das Fenster zeichnet es
(blaupause.js mit three.js). Alles, was von Claude kommt, wird geprüft (clean_part): nur bekannte Formen,
Zahlen in sinnvollen Grenzen, Farben als #rrggbb, höchstens MAX_PARTS Teile.
"""

from __future__ import annotations

import base64
import copy
import datetime as dt
import json
import logging
import math
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Iterable

log = logging.getLogger(__name__)

MAX_PARTS = 200
MAX_UNDO = 40
STL_MAX_BYTES = 40 * 1024 * 1024
FOLDER = "Blaupausen"

FORMS = ("quader", "kugel", "zylinder", "kegel", "ring", "kapsel", "drehkoerper", "extrusion", "rohr", "weich")
_FORM_ALIASES = {
    "box": "quader", "würfel": "quader", "cube": "quader", "sphere": "kugel", "ball": "kugel",
    "cylinder": "zylinder", "cone": "kegel", "torus": "ring", "capsule": "kapsel", "lathe": "drehkoerper",
    "drehkörper": "drehkoerper", "extrude": "extrusion", "tube": "rohr", "pipe": "rohr",
    "blob": "weich", "organisch": "weich", "metaball": "weich", "metaballs": "weich", "soft": "weich",
}
# Animationen, die Jarvis sofort zeigt (blaupause.js), mit seiner Antwort. "" = Animation aus.
ANIMATIONS = {
    "verschmelzen": "Es verschmilzt, Sir.", "schmelzen": "Es schmilzt, Sir.", "pulsieren": "Es schlägt, Sir.",
    "schweben": "Es schwebt, Sir.", "aufloesen": "Es löst sich auf, Sir.", "": "Animation aus, Sir.",
}
MATERIALS = ("metall", "matt", "glas", "leuchten", "holo")
DEFAULT_COLOR = "#7fd8ff"

COLORS = {
    "rot": "#e53935", "rote": "#e53935", "blau": "#1e88e5", "hellblau": "#4fc3f7", "dunkelblau": "#1a237e",
    "grün": "#43a047", "gelb": "#fdd835", "orange": "#fb8c00", "lila": "#8e24aa", "violett": "#8e24aa",
    "pink": "#ec407a", "rosa": "#f48fb1", "weiß": "#f5f5f5", "schwarz": "#212121", "grau": "#9e9e9e",
    "silber": "#cfd8dc", "gold": "#ffc107", "golden": "#ffc107", "braun": "#795548", "türkis": "#26c6da",
    "cyan": "#00e5ff", "kupfer": "#b87333", "chrom": "#e0e6eb",
}

SYSTEM_PROMPT = """Du bist J.A.R.V.I.S. in Tony Starks Werkstatt und konstruierst 3D-Modelle, die als Hologramm \
angezeigt werden. Du antwortest NUR mit JSON-Zeilen: eine Anweisung pro Zeile, kein Text davor oder danach, \
kein Markdown, keine Codeblöcke.

Anweisungen:
{"op":"neu","name":"Kurzer Name","beschreibung":"Ein Satz, was es ist","groesse_m":0.3}  (nur bei einem neuen Modell, als erste Zeile; groesse_m = echte Höhe des Gegenstands in Metern, z. B. Helm 0.3, Auto 1.5, Rakete 70)
{"op":"teil", ...Teil...}  (ein Teil hinzufügen; mit vorhandener id ersetzt es das Teil)
{"op":"aendern","id":"...", ...nur die geänderten Felder...}
{"op":"entfernen","id":"..."}
{"op":"name","name":"...","beschreibung":"..."}
{"op":"animation","art":"verschmelzen"}  (nur wenn Georg eine Bewegung will: verschmelzen, schmelzen, pulsieren, schweben, aufloesen; "" = aus)
{"op":"sagen","text":"Höchstens ein kurzer Satz (Sie-Form, Butler-Ton)"}  (nur bei einem neuen Modell, als letzte Zeile; bei Änderungen weglassen: Jarvis sagt dann nur "Erledigt")

Ein Teil:
{"op":"teil","id":"triebwerk_links","name":"Triebwerk links","gruppe":"Antrieb","form":"zylinder","masse":[0.12,0.15,0.5],"pos":[-0.6,0.8,0],"dreh":[90,0,0],"farbe":"#b0bec5","material":"metall"}

Formen und ihre Maße ("masse"):
- quader: [breite, höhe, tiefe]  (mit "rundung": r abgerundete Kanten, z. B. 0.02: wirkt hochwertig bei Gehäusen, Panzerplatten, Displays)
- kugel: [radius]  (mit "skala":[x,y,z] zu einem Ellipsoid strecken)
- zylinder: [radius_oben, radius_unten, höhe]
- kegel: [radius, höhe]
- ring: [radius, dicke]  (Torus in der x-y-Ebene; mit dreh [90,0,0] liegt er flach)
- kapsel: [radius, länge]
- drehkoerper: statt masse "profil":[[r,y],[r,y],...]  (Umriss rechts der y-Achse, um y gedreht: Rümpfe, Helme, Vasen, Düsen, Flaschen)
- extrusion: statt masse "umriss":[[x,y],...] und "tiefe":d  (flaches Profil in z ausgezogen: Flügel, Flossen, Platten, Zahnräder, Embleme); \
optional "loecher":[[[x,y],...],...] für Aussparungen (Fenster, Lüftungsschlitze, Speichen)
- rohr: statt masse "pfad":[[x,y,z],...] und "radius":r  (Kabel, Rohre, Bögen, Griffe, Kufen)
- weich: statt masse "kugeln":[[x,y,z,r],...] und/oder "staebe":[[x1,y1,z1,x2,y2,z2,r],...], dazu "glaette":k \
(0.05 bis 0.4). Die Kugeln und Stäbe fließen wie flüssiges Metall glatt ineinander, je größer k, desto weicher. \
Für alles Organische: Herz, Organe, Tiere, Köpfe, Figuren, Hände, Früchte, Pflanzen, Wolken, Tropfen, Schleim. \
Beispiel Herz: {"op":"teil","id":"herz","name":"Herz","form":"weich","kugeln":[[-0.28,1.3,0,0.36],[0.28,1.3,0,0.36],\
[0,1.0,0,0.36],[0,0.65,0,0.24],[0,0.35,0,0.12]],"glaette":0.25,"skala":[1,1,0.75],"pos":[0,0,0],"farbe":"#c62828","material":"matt"}
Optional bei jedem Teil: "skala":[x,y,z]; bei extrusion "fase" (Kantenrundung 0 bis 0.05).

Regeln:
- Das ganze Modell ist etwa 2 Einheiten groß, steht auf dem Boden (y=0) und ist um x=0, z=0 zentriert. \
y zeigt nach oben, z nach vorne zum Betrachter. "dreh" in Grad.
- "pos" ist die Mitte des Teils. Bei drehkoerper, extrusion und rohr gelten die Koordinaten relativ zu "pos".
- Baue wie ein Industriedesigner in Tony Starks Werkstatt, detailliert und glaubwürdig: erst die Hauptformen \
(Rumpf, Hülle, Rahmen) in richtigen Proportionen, dann Details: Fugen und Panellinien (dünne Quader), Schrauben \
und Nieten (kleine Zylinder), Lüftungsschlitze, Lichter und Displays (material leuchten), Kabel und Leitungen (rohr), \
Gelenke. 30 bis 120 Teile, je nach Objekt. Lebendiges und Weiches (Herz, Tiere, Figuren, Organe, Früchte) als \
weich, das sieht echt aus statt aus Klötzen gebaut; dazu passende Details (Adern als rohr, Augen als kugel). Glatte \
technische Rundungen (Helme, Rümpfe, Karosserien) als drehkoerper mit 8 bis 16 Profilpunkten, mit "skala" oval gemacht. Kanten von Gehäusen abrunden ("rundung"). Symmetrische \
Teile links und rechts spiegeln. Teile sollen sich berühren oder leicht überlappen, nichts schwebt lose.
- "gruppe" für Baugruppen (z. B. "Rumpf", "Antrieb", "Cockpit", "Elektronik"): Explosionsansicht und Fokus \
arbeiten mit den Gruppen.
- "id": kurz, nur a-z, 0-9 und _, eindeutig. "name": deutsch, kurz.
- "material": metall (glänzend), matt, glas (durchsichtig), leuchten (selbstleuchtend: Lichter, Reaktoren, \
Displays, Düsenglühen), holo.
- Farben realistisch und stimmig; leuchtende Teile hell (z. B. #7fd8ff, #ffb74d).
- Beim Ändern eines vorhandenen Modells nur die nötigen Anweisungen (teil, aendern, entfernen), nicht alles \
neu, und schnell: keine Erklärungen. Ist ein Teil ausgewählt und sagt Georg "das", "es" oder "hier", meint er dieses Teil.
- Höchstens 200 Teile. Keine Erklärungen außerhalb von "sagen".
"""


# ---------------------------------------------------------------------- Prüfen, was von Claude kommt


def _num(value, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return round(min(high, max(low, number)), 4)


def _vec(value, default: list[float], low: float, high: float, size: int = 3) -> list[float]:
    if isinstance(value, (int, float)) and size == 3 and default == [1.0, 1.0, 1.0]:
        value = [value, value, value]  # "skala": 2 heißt in alle Richtungen
    if not isinstance(value, (list, tuple)):
        return list(default)
    out = [_num(v, d, low, high) for v, d in zip(list(value)[:size] + [None] * size, default)]
    return out[:size]


def _points(value, size: int, low: float, high: float, least: int, most: int) -> list[list[float]] | None:
    if not isinstance(value, (list, tuple)):
        return None
    points = []
    for item in list(value)[:most]:
        if isinstance(item, (list, tuple)) and len(item) >= size:
            points.append([_num(v, 0.0, low, high) for v in item[:size]])
    return points if len(points) >= least else None


def _color(value) -> str:
    text = str(value or "").strip().lower()
    if text in COLORS:
        return COLORS[text]
    if re.fullmatch(r"#[0-9a-f]{6}", text):
        return text
    if re.fullmatch(r"#[0-9a-f]{3}", text):
        return "#" + "".join(c * 2 for c in text[1:])
    return DEFAULT_COLOR


def part_id(text: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", str(text or "").lower().replace("ä", "ae").replace("ö", "oe")
                  .replace("ü", "ue").replace("ß", "ss")).strip("_")
    return slug[:40]


def clean_part(raw: dict, fallback_id: str = "") -> dict | None:
    """Ein Teil, wie es das Fenster zeichnen darf. None, wenn es keins ist."""
    if not isinstance(raw, dict):
        return None
    form = str(raw.get("form") or "").strip().lower()
    form = _FORM_ALIASES.get(form, form)
    if form not in FORMS:
        return None
    pid = part_id(raw.get("id") or "") or part_id(fallback_id) or "teil"
    part = {
        "id": pid,
        "name": str(raw.get("name") or pid.replace("_", " ").title())[:60],
        "gruppe": str(raw.get("gruppe") or "")[:40],
        "form": form,
        "pos": _vec(raw.get("pos"), [0.0, 0.0, 0.0], -100, 100),
        "dreh": _vec(raw.get("dreh"), [0.0, 0.0, 0.0], -720, 720),
        "skala": _vec(raw.get("skala"), [1.0, 1.0, 1.0], 0.01, 100),
        "farbe": _color(raw.get("farbe")),
        "material": str(raw.get("material") or "metall").lower() if str(raw.get("material") or "metall").lower()
        in MATERIALS else "metall",
    }
    if raw.get("versteckt"):
        part["versteckt"] = True
    sizes = raw.get("masse")
    if form in ("quader",):
        part["masse"] = _vec(sizes, [0.5, 0.5, 0.5], 0.001, 100)
        rounding = _num(raw.get("rundung"), 0.0, 0.0, 0.5)
        if rounding > 0:
            part["rundung"] = min(rounding, min(part["masse"]) / 2)
    elif form in ("kugel",):
        part["masse"] = _vec(sizes, [0.3], 0.001, 100, size=1)
    elif form == "zylinder":
        part["masse"] = _vec(sizes, [0.2, 0.2, 0.5], 0.0, 100)
        if part["masse"][0] == 0 and part["masse"][1] == 0:
            part["masse"][0] = part["masse"][1] = 0.01
        part["masse"][2] = max(0.001, part["masse"][2])
    elif form == "kegel":
        part["masse"] = _vec(sizes, [0.2, 0.5], 0.001, 100, size=2)
    elif form == "ring":
        part["masse"] = _vec(sizes, [0.4, 0.05], 0.001, 100, size=2)
    elif form == "kapsel":
        part["masse"] = _vec(sizes, [0.15, 0.5], 0.001, 100, size=2)
    elif form == "drehkoerper":
        profile = _points(raw.get("profil"), 2, -100, 100, 2, 64)
        if profile is None:
            return None
        part["profil"] = [[max(0.0, r), y] for r, y in profile]
    elif form == "extrusion":
        outline = _points(raw.get("umriss"), 2, -100, 100, 3, 128)
        if outline is None:
            return None
        part["umriss"] = outline
        part["tiefe"] = _num(raw.get("tiefe"), 0.1, 0.001, 20)
        part["fase"] = _num(raw.get("fase"), 0.0, 0.0, 0.2)
        raw_holes = raw.get("loecher") if isinstance(raw.get("loecher"), list) else []
        holes = [h for h in (_points(x, 2, -100, 100, 3, 64) for x in raw_holes[:24]) if h]
        if holes:
            part["loecher"] = holes
    elif form == "rohr":
        path = _points(raw.get("pfad"), 3, -100, 100, 2, 64)
        if path is None:
            return None
        part["pfad"] = path
        part["radius"] = _num(raw.get("radius"), 0.03, 0.001, 10)
    elif form == "weich":
        balls = [b[:3] + [max(0.005, b[3])] for b in _points(raw.get("kugeln"), 4, -100, 100, 0, 32) or []]
        rods = [r[:6] + [max(0.005, r[6])] for r in _points(raw.get("staebe"), 7, -100, 100, 0, 16) or []]
        if not balls and not rods:
            return None
        if balls:
            part["kugeln"] = balls
        if rods:
            part["staebe"] = rods
        part["glaette"] = _num(raw.get("glaette"), 0.12, 0.0, 1.0)
    return part


def parse_ops(text: str) -> Iterable[dict]:
    """Die Anweisungen aus Claudes Antwort: JSON-Zeilen, zur Not auch ein JSON-Feld oder ein ganzes Modell."""
    text = re.sub(r"^```(?:json|jsonl)?\s*|\s*```\s*$", "", str(text or "").strip(), flags=re.M)
    for line in text.splitlines():
        line = line.strip().rstrip(",")
        if not line or line in ("[", "]"):
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        yield from _ops_from(data)


def _ops_from(data) -> Iterable[dict]:
    if isinstance(data, list):
        for item in data:
            yield from _ops_from(item)
    elif isinstance(data, dict):
        if "op" in data:
            yield data
        elif isinstance(data.get("teile"), list):  # ein ganzes Modell auf einmal
            yield {"op": "neu", "name": data.get("name", ""), "beschreibung": data.get("beschreibung", "")}
            for part in data["teile"]:
                if isinstance(part, dict):
                    yield {"op": "teil", **part}
        elif "form" in data:
            yield {"op": "teil", **data}


_ANIM_STOP = re.compile(
    r"^(?:(?:die )?animation (?:aus|stopp|stop|beenden|anhalten)|(?:stopp?|beende|halt)(?: die)? animation|"
    r"keine animation(?: mehr)?|(?:hör|höre) auf (?:zu |mit dem )?(?:schlagen|pulsieren|schweben|schmelzen|"
    r"verschmelzen|bewegen)|nicht mehr (?:schlagen|pulsieren|schweben|schmelzen|bewegen))$")
_ANIM_KINDS = (
    ("verschmelzen", re.compile(r"\b(?:verschmel\w*|verschmilzt|zusammen ?fließ\w*|fließ\w* (?:\w+ )?zusammen|"
                                r"zusammen ?schmelz\w*|ineinander ?fließ\w*)")),
    ("schmelzen", re.compile(r"\b(?:schmelz\w*|schmilzt|zerfließ\w*|zerläuft|zerlaufen|wie wachs)")),
    ("aufloesen", re.compile(r"\b(?:auflös\w*|löst? (?:es |das |ihn |sie )?(?:sich )?auf\b|zerfall\w*|zerfällt|"
                             r"in (?:partikel|staub)|zerbrösel\w*)")),
    ("pulsieren", re.compile(r"\b(?:pulsier\w*|herzschlag|schlagen|schlägt|pochen|pocht|pumpen|pumpt)\b")),
    ("schweben", re.compile(r"\b(?:schweb\w*|levitier\w*)")),
)
_ANIM_CUE = re.compile(r"\b(?:animier\w*|animation|lass|lasse|soll|mach|mache|zeig|zeige)\b")
_ANIM_ASK = re.compile(r"^(?:animier\w*|animation)(?: (?:das|es|ihn|sie|das modell|das ganze|mal))?(?: an)?$")


def animation_name(value) -> str | None:
    """Der Name einer Animation, wie das Fenster ihn kennt, oder None."""
    text = str(value or "").strip().lower().replace("ö", "oe").replace("ä", "ae").replace("ü", "ue")
    text = {"aus": "", "stopp": "", "keine": "", "pulsiert": "pulsieren", "schlagen": "pulsieren",
            "herzschlag": "pulsieren", "aufloesung": "aufloesen", "zerfallen": "aufloesen"}.get(text, text)
    return text if text in ANIMATIONS else None


def animation_for(norm: str) -> str | None:
    """"Animier das so, dass es verschmilzt" -> "verschmelzen", "Lass es schlagen" -> "pulsieren",
    "Animation aus" -> "", sonst None. Das Wort allein ("Verschmelzen") reicht auch."""
    if _ANIM_STOP.match(norm):
        return ""
    for art, pattern in _ANIM_KINDS:
        hit = pattern.search(norm)
        if hit and (_ANIM_CUE.search(norm) or hit.start() == 0):
            return art
    return None


def empty_scene() -> dict:
    return {"name": "", "beschreibung": "", "teile": []}


def slug(name: str) -> str:
    text = re.sub(r"[^a-z0-9äöüß-]+", "-", str(name or "").lower()).strip("-")
    return text[:60] or "blaupause"


# ---------------------------------------------------------------------- Sätze

def _norm(text: str) -> str:
    norm = " ".join(re.sub(r"[.,!?;:\"'„“”]", " ", str(text).lower()).split())
    norm = re.sub(r"^(?:(?:hey|hallo|okay|ok) )?jarvis ", "", norm)
    return re.sub(r"^(?:bitte |mal |jetzt |also |okay |ok |und )+", "", norm).replace(" bitte", "")


# "Blueprint" schreibt die Spracherkennung auch "Blue Print", "Bluprint" oder "Blu-Print"
_BLUEPRINT = r"(?:blue[- ]?prints?|blu[- ]?prints?|blaupause|blaupausen)(?:[- ]?modus)?"
_OPEN = re.compile(r"^(?:(?:öffne|zeig|zeige|starte|start|aktivier|aktiviere|geh in|wechsel in|wechsle in|mach)(?: mir)? )?"
                   rf"(?:die |den |das |in die |in den |in das )?(?:{_BLUEPRINT}|"
                   r"hologramm[- ]?modus|konstruktions[- ]?modus|3d[- ]?modus|holo[- ]?modus)(?: an| auf| öffnen| starten)?$")
_CLOSE = re.compile(rf"^(?:(?:schließ|schließe|beende|verlass|verlasse)(?: die| den| das)? (?:{_BLUEPRINT}|"
                    rf"hologramm[- ]?modus|konstruktions[- ]?modus)|(?:{_BLUEPRINT}|"
                    r"hologramm[- ]?modus)(?: schließen| beenden| aus| zu))$")
# "Generiere einen Iron-Man-Helm", "Bau mir ein 3D-Modell von einem Auto", "Zeig mir eine Rakete als Hologramm"
_MAKE_VERB = (r"(?:generier|generiere|erstell|erstelle|bau|baue|konstruier|konstruiere|entwirf|entwerf|zeichne|"
              r"modellier|modelliere|design|designe|mach|mache|erzeug|erzeuge)")
_MAKE = re.compile(rf"^{_MAKE_VERB}(?: mir| uns)? (?P<what>.+)$")
# "Generiere/Konstruiere/Modelliere ..." meint (fast) immer ein Modell, auch bei geschlossener Blaupause,
# außer bei Texten, Bildern und Ähnlichem ("Generiere ein Passwort", "Generiere eine Playlist")
# "Hol das Herz": ein Teil mit dem Namen nach vorne holen, sonst das Ding als neues Modell
_FETCH = re.compile(r"^(?:hol|hole|holt)(?: mir| uns)?(?: mal)? (?P<what>.+?)(?: her| hervor| raus| heran| ran| nach vorne)?$")
_STRONG_VERB = re.compile(r"^(?:generier|generiere|konstruier|konstruiere|modellier|modelliere)\b")
_NOT_AN_OBJECT = re.compile(r"\b(?:passwort\w*|text\w*|bild\w*|foto\w*|lied\w*|song\w*|gedicht\w*|liste\w*|name\w*|"
                            r"zusammenfassung\w*|mail\w*|nachricht\w*|antwort\w*|idee\w*|plan|pläne|witz\w*|zitat\w*|"
                            r"rezept\w*|playlist\w*|tabelle\w*|präsentation\w*|video\w*|musik|beat\w*|qr[- ]?code)\b")
_EXPLICIT = re.compile(r"\b(?:3d[- ]?modell\w*|3d|hologramm\w*|blaupause|blue[- ]?print|blu[- ]?print|in 3d|als modell)\b")
_SHOW_AS = re.compile(r"^(?:zeig|zeige)(?: mir)? (?P<what>.+?) (?:als hologramm|in 3d|als 3d[- ]?modell)$")
# Was eher ein Programm ist als ein Gegenstand: gehört in die Werkstatt
_SOFTWARE = re.compile(r"\b(?:bot|discord|programm\w*|skript\w*|script|app|apps|webseite\w*|website|tool|code|plugin|"
                       r"mod|batch|datei|excel|tabelle|logo als svg)\b")
# Wünsche zum Modell, die Claude erledigt ("Füg noch zwei Raketen hinzu", "Mach den Rumpf schlanker")
_EDIT = re.compile(r"^(?:und |noch |jetzt )?(?:füg|füge|setz|setze|häng|hänge|bau|baue|ersetz|ersetze|änder|ändere|"
                   r"mach|mache|gib|verlänger|verlängere|verkürz|verkürze|verbreiter|verbreitere|ergänz|ergänze|"
                   r"montier|montiere|pack|packe|leg|lege|stell|stelle|verschieb|verschiebe|beweg|bewege|richte|"
                   r"richt|kombinier|kombiniere|verbinde|verbind|spiegel|spiegle|dupliziere|duplizier|kopier|kopiere)\b")

# Blender: "Render das", "Mach ein Foto davon", "Zeig es mir fotorealistisch"
_RENDER = re.compile(
    r"^(?:render|rendere|rendern|ränder|rändere|rendre)(?: mir)?(?: (?:das|es|ihn|sie|das modell|das ganze|den "
    rf"{_BLUEPRINT}|das objekt))?(?: (?:mal|jetzt|noch))?(?: (?:in|mit) blender)?(?: (?:fotorealistisch|in echt|"
    r"als foto|realistisch))?$|"
    r"^(?:mach|mache|schieß|schiess|erstell|erstelle|knips|knipse)(?: mir)?(?: (?:mal|noch))? (?:ein |einen |ne |n )?"
    r"(?:foto|fotos|bild|render|rendering|produktfoto|fotorealistisches bild|richtiges foto|echtes foto)"
    r"(?: (?:davon|vom modell|von dem modell|von ihm|von ihr|vom objekt))?(?: (?:in|mit) blender)?$|"
    r"^(?:zeig|zeige)(?: mir)? (?:das|es|das modell|ihn|sie)(?: mir)?(?: mal)? (?:fotorealistisch|als foto|als echtes foto|"
    r"in blender gerendert)$|^(?:fotorealistisch|foto davon|rendering starten|in blender rendern)$")
# "Öffne das in Blender", "Bearbeite es in Blender", "Blender öffnen" (bei offenem Blueprint: mit dem Modell)
_IN_BLENDER = re.compile(
    r"^(?:öffne|öffnen|zeig|zeige|schick|schicke|lade|lad|bring|exportier|exportiere|übergib|gib|mach|mache)"
    r"(?: mir)?(?: (?:das|es|ihn|sie|das modell|das ganze|das objekt|den "
    rf"{_BLUEPRINT}))? (?:in|nach|an|zu|mit) blender(?: (?:öffnen|auf|rüber|weiter))?$|"
    r"^(?:in|mit) blender (?:öffnen|bearbeiten|weiterarbeiten|weitermachen|aufmachen)$|"
    r"^(?:bearbeite|bearbeiten|bearbeit)(?: (?:das|es|ihn|sie|das modell))? (?:in|mit) blender$|"
    r"^(?:(?:öffne|starte|start) )?blender(?: (?:öffnen|starten|auf))?$")

_WORD_NUMBERS = {"einmal": 1, "zweimal": 2, "dreimal": 3, "doppelt": 2, "halb": 0.5, "dreifach": 3, "zehnmal": 10}


# Ein Gegenstand fängt mit Artikel oder Zahl an: "Bau ein Auto", "Mach den Millennium Falcon", nicht "Mach weiter"
_OBJECT = re.compile(r"^(?:ein|eine|einen|einem|einer|der|die|das|den|dem|des|zwei|drei|vier|fünf|sechs|zehn|\d+|"
                     r"neue[nrs]?|kleine[nmrs]?|große[nmrs]?|meine[nmrs]?)\b")


# "Mach es rot", "Mach das ganze Modell rot": gemeint ist das ausgewählte Teil oder alles
_WHOLE_WORDS = {"den", "die", "das", "dem", "der", "es", "ihn", "sie", "ihm", "alles", "alle", "ganz", "ganze", "ganzen",
                "ganzes", "komplett", "modell", "objekt", "ding", "teil", "teile"}


def _everyday(text: str) -> bool:
    """"Mach lauter", "Mach den PC aus", "Mach Spotify auf", "Stell einen Timer": ein Sofort-Befehl wie sonst
    auch, keine Änderung am Modell (beginnt nur zufällig mit "Mach" oder "Stell")."""
    from . import intents

    return intents.match(text) is not None


def _factor(norm: str) -> float | None:
    """"größer" 1.25, "viel größer" 1.6, "doppelt so groß" 2, "um 50 prozent größer" 1.5, "halb so groß" 0.5."""
    percent = re.search(r"(\d+(?:[.,]\d+)?) ?(?:prozent|%)", norm)
    bigger = re.search(r"\b(?:größer|grösser|vergrößer\w*|groß|größe|riesig\w*|länger|breiter|höher|dicker)\b", norm)
    smaller = re.search(r"\b(?:kleiner|verkleiner\w*|klein|winzig\w*|kürzer|schmaler|niedriger|dünner)\b", norm)
    if not bigger and not smaller:
        return None
    if re.search(r"\bdoppelt so\b|\bzweimal so\b", norm):
        return 2.0 if bigger else 0.5
    if re.search(r"\bhalb so\b", norm):
        return 0.5
    if re.search(r"\bdreimal so\b|\bdreifach\b", norm):
        return 3.0 if bigger else 1 / 3
    if percent:
        value = float(percent.group(1).replace(",", ".")) / 100
        return 1 + value if bigger else max(0.05, 1 - value)
    strong = re.search(r"\b(?:viel|deutlich|richtig|sehr|mega|ordentlich)\b", norm)
    weak = re.search(r"\b(?:etwas|bisschen|leicht|wenig|minimal)\b", norm)
    step = 1.6 if strong else 1.1 if weak else 1.25
    return step if bigger else 1 / step


def _degrees(norm: str) -> float:
    found = re.search(r"(\d+) ?grad", norm)
    if found:
        return float(found.group(1))
    if re.search(r"\bhalb\w* (?:umdrehung|runde)\b|\bumdrehen\b|\bwende\b|\bwenden\b", norm):
        return 180.0
    if re.search(r"\b(?:ganze|volle) (?:umdrehung|runde)\b", norm):
        return 360.0
    return 45.0


class Blueprint:
    """Das Modell, das gerade auf dem Blaupausen-Tisch liegt, und alles, was Georg damit macht."""

    def __init__(self, cfg: dict, brain, ui, base: Path, announce: Callable[[str], None],
                 show_window: Callable[[], None] | None = None) -> None:
        section = cfg.get("blaupause", {}) or {}
        self.model = str(section.get("modell", "sonnet") or "sonnet")
        self.effort = str(section.get("effort", "low") or "")
        self._brain = brain
        self._ui = ui
        self._announce = announce
        self._show_window = show_window
        self.folder = Path(base) / FOLDER
        self.scene = empty_scene()
        self.selected = ""
        self.active = False  # die Blaupause ist im Fenster offen
        self.busy = False
        self._undo: list[dict] = []
        self._redo: list[dict] = []
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._cancel = threading.Event()
        self._last_spoken = ""
        # Was Georg sagt, während Claude noch baut: (Wunsch, neu?) der Reihe nach, direkt danach
        self._queue: list[tuple[str, bool]] = []
        # Blender (Foto und .blend-Datei): läuft im Hintergrund, das letzte Foto zeigt das Fenster
        self.blender_setting = str(section.get("blender_pfad", "") or "")
        self.photo = None  # blender.Photo
        self.view: dict | None = None  # Blickwinkel im Fenster, aus dem auch das Foto kommt (set_view)
        self._blender_thread: threading.Thread | None = None
        self._blender_cancel = threading.Event()
        self._blender_after = ""  # "Render das", während Claude noch baut: gleich danach ("foto" oder "blend")

    # ------------------------------------------------------------------ Anzeige

    def _emit(self, action: str, **data) -> None:
        try:
            self._ui.blueprint({"action": action, **data})
        except AttributeError:
            pass  # eine Anzeige ohne Blaupause (Konsole)
        except Exception as exc:
            log.debug("Blaupause, Anzeige: %s", exc)

    def state(self) -> dict:
        with self._lock:
            return {"scene": copy.deepcopy(self.scene), "selected": self.selected, "busy": self.busy,
                    "active": self.active, "undo": len(self._undo), "redo": len(self._redo),
                    "folder": str(self.folder)}

    def _push_scene(self) -> None:
        self._emit("scene", **self.state())

    def open(self, announce: bool = False) -> str:
        self.active = True
        self._emit("open", **self.state())
        self._warm()
        if self._show_window is not None:
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Blaupause, Fenster: %s", exc)
        if self.scene["teile"]:
            return f"Blueprint, Sir. Auf dem Tisch: {self.scene['name'] or 'das letzte Modell'}."
        return "Blueprint, Sir. Was soll ich bauen?"

    def close(self) -> str:
        self.active = False
        self._queue.clear()
        self._emit("close")
        drop = getattr(self._brain, "drop_spare", None)
        if drop is not None:
            drop()
        return "Blueprint geschlossen, Sir."

    def set_active(self, on: bool) -> None:
        """Das Fenster meldet, ob der Blueprint offen ist (dann gehen \"Mach das größer\" & Co. hierher)."""
        was, self.active = self.active, bool(on)
        if self.active and not was:
            self._warm()

    def _warm(self) -> None:
        """Den Claude-Prozess für den nächsten Wunsch schon starten: Unter Windows spart das 2 bis 3 Sekunden."""
        prestart = getattr(self._brain, "prestart_oneshot", None)
        if prestart is None or not self.active or not getattr(self._brain, "claude_path", ""):
            return

        def run() -> None:
            try:
                prestart(self._system_file(), self.model, self.effort)
            except Exception as exc:
                log.debug("Blueprint, Vorstart: %s", exc)

        threading.Thread(target=run, name="jarvis-blueprint-vorstart", daemon=True).start()

    # ------------------------------------------------------------------ Modell ändern

    def _remember(self) -> None:
        self._undo.append(copy.deepcopy(self.scene))
        del self._undo[:-MAX_UNDO]
        self._redo.clear()

    def _find(self, words: str) -> list[dict]:
        """Teile, deren Name, Gruppe oder id zu den Wörtern passt ("das Triebwerk", "die Flügel")."""
        norm = _norm(words)
        norm = re.sub(r"^(?:den|die|das|dem|der|des|einen|eine|ein|alle|beide|beiden)\s+", "", norm).strip()
        if not norm or norm in ("es", "das", "ihn", "sie", "alles", "das ganze", "ganze", "modell", "objekt"):
            return []
        stem = re.sub(r"(?:en|er|e|n|s)$", "", norm) if len(norm) > 4 else norm
        teile = self.scene["teile"]
        groups = [p for p in teile if p.get("gruppe") and (p["gruppe"].lower() == norm or
                                                          p["gruppe"].lower().startswith(stem))]
        if groups:
            return groups
        exact = [p for p in teile if p["name"].lower() == norm or p["id"] == part_id(norm)]
        if exact:
            return exact
        return [p for p in teile if stem and (stem in p["name"].lower() or stem in p["id"].replace("_", " "))]

    def _target(self, words: str) -> tuple[list[dict], str]:
        """(Teile, Beschreibung): genannte Teile, sonst das ausgewählte, sonst alles."""
        found = self._find(words) if words else []
        if found:
            label = found[0]["gruppe"] if len({p.get("gruppe") for p in found}) == 1 and found[0].get("gruppe") \
                and len(found) > 1 else found[0]["name"]
            return found, label
        if not set(_norm(words).split()) <= _WHOLE_WORDS:
            # "Mach den Hintergrund blau": ein Teil, das es nicht gibt. Nicht einfach alles umfärben, das macht Claude.
            return [], words
        if self.selected and not re.search(r"\b(?:alles|ganze|modell|objekt)\b", _norm(words)):
            chosen = [p for p in self.scene["teile"] if p["id"] == self.selected]
            if chosen:
                return chosen, chosen[0]["name"]
        return list(self.scene["teile"]), "das Modell"

    def apply(self, op: dict, emit: bool = True) -> bool:
        """Eine Anweisung (von Claude oder aus dem Fenster) übernehmen. True, wenn sich etwas geändert hat."""
        if not isinstance(op, dict):
            return False
        kind = str(op.get("op") or "").lower()
        with self._lock:
            teile = self.scene["teile"]
            if kind == "neu":
                self.scene = {"name": str(op.get("name") or "")[:80], "beschreibung": str(op.get("beschreibung") or "")[:300],
                              "teile": []}
                size = _num(op.get("groesse_m"), 0.0, 0.0, 100000)
                if size > 0:
                    self.scene["groesse_m"] = size
                self.selected = ""
                if emit:
                    self._emit("op", op={"op": "neu", "name": self.scene["name"],
                                         "beschreibung": self.scene["beschreibung"], "groesse_m": size})
                return True
            if kind == "name":
                if op.get("name"):
                    self.scene["name"] = str(op["name"])[:80]
                if op.get("beschreibung"):
                    self.scene["beschreibung"] = str(op["beschreibung"])[:300]
                if _num(op.get("groesse_m"), 0.0, 0.0, 100000) > 0:
                    self.scene["groesse_m"] = _num(op.get("groesse_m"), 0.0, 0.0, 100000)
                if emit:
                    self._emit("op", op={"op": "name", "name": self.scene["name"],
                                         "beschreibung": self.scene["beschreibung"]})
                return True
            if kind == "teil":
                part = clean_part(op, f"teil_{len(teile) + 1}")
                if part is None:
                    return False
                at = next((i for i, p in enumerate(teile) if p["id"] == part["id"]), -1)
                if at >= 0:
                    teile[at] = part
                elif len(teile) >= MAX_PARTS:
                    return False
                else:
                    teile.append(part)
                if emit:
                    self._emit("op", op={"op": "teil", "teil": part})
                return True
            if kind == "aendern":
                pid = part_id(op.get("id") or "")
                at = next((i for i, p in enumerate(teile) if p["id"] == pid), -1)
                if at < 0:
                    return False
                merged = {**teile[at], **{k: v for k, v in op.items() if k not in ("op", "id")}}
                part = clean_part(merged, pid)
                if part is None:
                    return False
                part["id"] = pid
                teile[at] = part
                if emit:
                    self._emit("op", op={"op": "teil", "teil": part})
                return True
            if kind == "entfernen":
                pid = part_id(op.get("id") or "")
                before = len(teile)
                self.scene["teile"] = [p for p in teile if p["id"] != pid]
                if self.selected == pid:
                    self.selected = ""
                if emit and len(self.scene["teile"]) != before:
                    self._emit("op", op={"op": "entfernen", "id": pid})
                return len(self.scene["teile"]) != before
        return False

    def undo(self) -> str:
        with self._lock:
            if not self._undo:
                return "Da gibt es nichts rückgängig zu machen, Sir."
            self._redo.append(copy.deepcopy(self.scene))
            self.scene = self._undo.pop()
            self.selected = ""
        self._push_scene()
        return "Rückgängig gemacht, Sir."

    def redo(self) -> str:
        with self._lock:
            if not self._redo:
                return "Da gibt es nichts wiederherzustellen, Sir."
            self._undo.append(copy.deepcopy(self.scene))
            self.scene = self._redo.pop()
        self._push_scene()
        return "Wiederhergestellt, Sir."

    def select(self, pid: str) -> dict | None:
        with self._lock:
            pid = part_id(pid)
            part = next((p for p in self.scene["teile"] if p["id"] == pid), None)
            self.selected = part["id"] if part else ""
            return copy.deepcopy(part) if part else None

    def edit_part(self, pid: str, changes: dict) -> bool:
        """Aus dem Fenster: Farbe, Sichtbarkeit oder Entfernen eines Teils (mit Rückgängig)."""
        if not isinstance(changes, dict):
            return False
        with self._lock:
            self._remember()
            if changes.get("entfernen"):
                done = self.apply({"op": "entfernen", "id": pid})
            else:
                allowed = {k: v for k, v in changes.items() if k in ("farbe", "versteckt", "material", "name")}
                if "versteckt" in allowed and not allowed["versteckt"]:
                    allowed["versteckt"] = False
                done = self.apply({"op": "aendern", "id": pid, **allowed})
            if not done:
                self._undo.pop()
            return done

    def _scale(self, parts: list[dict], factor: float) -> None:
        """Teile um ihre gemeinsame Mitte vergrößern (das ganze Modell bleibt auf dem Boden)."""
        if not parts:
            return
        whole = len(parts) == len(self.scene["teile"])
        center = [sum(p["pos"][i] for p in parts) / len(parts) for i in range(3)]
        if whole:
            center[1] = 0.0  # auf dem Boden stehen bleiben
        for p in parts:
            p["skala"] = [round(min(100, max(0.01, s * factor)), 4) for s in p["skala"]]
            p["pos"] = [round(center[i] + (p["pos"][i] - center[i]) * factor, 4) for i in range(3)]

    # ------------------------------------------------------------------ Sprache

    def command(self, text: str) -> str | None:
        """Ein Satz für die Blaupause. None = nicht für die Blaupause (normal weiter)."""
        norm = _norm(text)
        if not norm:
            return None
        if _OPEN.match(norm):
            return self.open()
        if self.active and _CLOSE.match(norm):
            return self.close()
        if self.active and _RENDER.match(norm):
            return self.render_photo()
        if self.active and _IN_BLENDER.match(norm):
            return self.open_in_blender()
        if not self.active and self.scene["teile"]:
            # Blueprint zu, Modell noch da: nur eindeutige Sätze ("Render das", "Öffne das Modell in Blender"),
            # "Mach ein Foto" oder "Öffne Blender" bleiben, was sie sonst sind
            if _RENDER.match(norm) and re.search(r"\b(?:render\w*|ränder\w*|rendre|blender)\b", norm):
                self.open()
                return self.render_photo()
            if _IN_BLENDER.match(norm) and re.search(r"\b(?:das|es|ihn|sie|modell|objekt|ganze)\b", norm):
                return self.open_in_blender()
        fetched = self._fetch(text, norm)
        if fetched is not None:
            return fetched
        made = self._make_request(text, norm)
        if made is not None:
            return made
        if not self.active:
            return None
        local = self._local(norm)
        if local is not None:
            return local
        if self._has_model() and _EDIT.match(norm) and not _SOFTWARE.search(norm) and not _everyday(text):
            return self.generate(text, fresh=False)
        return None

    def _has_model(self) -> bool:
        """Liegt ein Modell auf dem Tisch oder baut Claude gerade eins? Solange noch kein Teil da ist, ist
        "Mach sie rot" trotzdem eine Änderung für die Warteschlange und kein neues Modell."""
        return bool(self.scene["teile"]) or self.busy

    def _make_request(self, text: str, norm: str) -> str | None:
        shown = _SHOW_AS.match(norm)
        if shown:
            return self._start(text, shown.group("what"))
        made = _MAKE.match(norm)
        if not made or _SOFTWARE.search(norm):
            return None
        what = made.group("what")
        explicit = bool(_EXPLICIT.search(norm)) or (bool(_STRONG_VERB.match(norm)) and not _NOT_AN_OBJECT.search(norm))
        if not explicit and not self.active:
            return None
        if not explicit and (_everyday(text) or not _OBJECT.match(what)):
            # Auch bei leerem Tisch kein Modell aus "Mach den PC aus", "Mach das Licht an", "Mach weiter"
            return None
        if self.active and not explicit and self._has_model():
            # Bei offenem Modell ist "Mach ..." meist eine Änderung ("Mach den Rumpf schlanker"),
            # nur "Bau/Generiere mir ein(e/n) ..." ein neues Modell
            if not re.match(rf"^{_MAKE_VERB}(?: mir| uns)? (?:ein|eine|einen|neue|neuen|neues)\b", norm) or \
                    re.match(r"^(?:mach|mache)\b", norm):
                return None
        return self._start(text, what)

    def _fetch(self, text: str, norm: str) -> str | None:
        """"Hol das Herz": Gibt es ein Teil so (im Körper das Herz), kommt es nach vorne, sonst baut Claude es neu.
        "Hol noch ein Rad dazu" ist eine Änderung. Nur bei offenem Blueprint ("Hol mir ein Glas Wasser" sonst nicht)."""
        hit = _FETCH.match(norm)
        if not hit or not self.active or _SOFTWARE.search(norm) or _everyday(text):
            return None
        what = hit.group("what")
        parts = self._find(what) if self.scene["teile"] else []
        if parts:
            return self._focus_on(parts)
        if self._has_model() and re.search(r"\b(?:noch|dazu|daneben|hinzu|zusätzlich|dran)\b", what):
            return self.generate(text, fresh=False)
        return self._start(text, what)

    def _focus_on(self, parts: list[dict]) -> str:
        self.selected = parts[0]["id"]
        self._emit("view", what="focus", ids=[p["id"] for p in parts])
        name = parts[0]["gruppe"] if len(parts) > 1 and parts[0].get("gruppe") else parts[0]["name"]
        return f"{name}, Sir."

    def _start(self, text: str, what: str) -> str:
        if not self.active:
            self.open()
        return self.generate(text, fresh=True)

    def _local(self, norm: str) -> str | None:
        """Alles, was ohne Claude sofort geht."""
        if self.scene["teile"]:
            art = animation_for(norm)
            if art is not None:
                self._emit("view", what="anim", art=art)
                return ANIMATIONS[art]
            if _ANIM_ASK.match(norm):
                return "Wie soll es sich bewegen, Sir? Verschmelzen, schmelzen, schlagen, schweben oder auflösen."
        if re.match(r"^(?:mach(?: das| es)? )?rückgängig$|^(?:mach )?(?:das|es) rückgängig(?: machen)?$|^undo$", norm):
            return self.undo()
        if re.match(r"^(?:wiederherstellen|stell (?:es|das) wieder her|doch wieder|redo)$", norm):
            return self.redo()
        if re.match(r"^(?:explosions(?:ansicht|zeichnung)|zerleg\w*(?: es| das| ihn| sie| das modell)?|"
                    r"(?:nimm|bau|zieh)(?: es| das| ihn| sie)? auseinander|(?:zeig|zeige)(?: mir)? (?:die )?einzelteile)$", norm):
            self._emit("view", what="explode", on=True)
            return "Explosionsansicht, Sir."
        if re.match(r"^(?:(?:bau|setz|füg)(?: es| das| ihn| sie)?(?: wieder)? zusammen|zusammen(?:bauen|setzen|fügen)|"
                    r"explosionsansicht (?:aus|beenden|zu))$", norm):
            self._emit("view", what="explode", on=False)
            return "Wieder zusammengesetzt, Sir."
        spin = re.match(r"^(?:dreh|drehe|rotier|rotiere|wende)\b(?P<rest>.*)$", norm)
        if re.match(r"^(?:lass (?:es|das|ihn|sie|das modell)(?: sich)? drehen|dreh dich|automatisch drehen|"
                    r"(?:auto(?:matische)?[- ]?)?drehung an|rotation an)$", norm):
            self._emit("view", what="spin", on=True)
            return "Sehr wohl, Sir. Es dreht sich."
        if re.match(r"^(?:hör auf (?:zu|mit dem) drehen|nicht mehr drehen|drehung (?:aus|stopp|stop|anhalten)|"
                    r"rotation (?:aus|stopp)|halt (?:es )?still|stillhalten|anhalten)$", norm):
            self._emit("view", what="spin", on=False)
            self._emit("view", what="anim", art="")  # still heißt: auch keine Animation mehr
            return "Steht still, Sir."
        if spin and not re.search(r"\b(?:musik|lauter|leiser|heizung|licht)\b", norm):
            rest = spin.group("rest")
            degrees = _degrees(rest)
            axis = "x" if re.search(r"\b(?:oben|unten|vorne|hinten|kipp\w*)\b", rest) else "y"
            sign = -1 if re.search(r"\b(?:links|unten|gegen den uhrzeigersinn)\b", rest) else 1
            if re.search(r"\b(?:um sich selbst|einmal komplett|einmal ganz)\b", rest):
                degrees = 360.0
            self._emit("view", what="rotate", axis=axis, degrees=sign * degrees)
            return random_choice(["Sehr wohl, Sir.", "Gedreht, Sir.", "Bitte sehr, Sir."])
        if re.match(r"^(?:zoom|zoome)(?: mal)? (?:rein|ran|hinein|näher|heran)$|^(?:näher ran|geh näher ran|"
                    r"komm näher|ran zoomen|reinzoomen|vergrößer die ansicht)$", norm):
            self._emit("view", what="zoom", factor=0.7)
            return "Näher heran, Sir."
        if re.match(r"^(?:zoom|zoome)(?: mal)? (?:raus|heraus|weg)$|^(?:weiter weg|geh weiter weg|raus zoomen|"
                    r"rauszoomen)$", norm):
            self._emit("view", what="zoom", factor=1.45)
            self._emit("view", what="isolate", ids=[])
            return "Etwas Abstand, Sir."
        view = re.match(r"^(?:(?:zeig(?: es| das)?|ansicht|schau|blick)(?: mir)? )?(?:von )?(?P<side>oben|unten|vorne|vorn|hinten|"
                        r"links|rechts|der seite|seitlich|schräg|perspektive)$", norm)
        if view:
            side = {"vorn": "vorne", "der seite": "seite", "seitlich": "seite", "schräg": "perspektive"}.get(
                view.group("side"), view.group("side"))
            self._emit("view", what="camera", side=side)
            return f"Ansicht von {side}, Sir." if side != "perspektive" else "Perspektive, Sir."
        if re.match(r"^(?:ansicht zurücksetzen|zentrier\w*|zurücksetzen|reset|ansicht reset|alles zentrieren)$", norm):
            self._emit("view", what="reset")
            return "Ansicht zurückgesetzt, Sir."
        if re.match(r"^(?:drahtmodell|drahtgitter|wireframe|röntgen\w*|durchsichtig|nur die kanten)$", norm):
            self._emit("view", what="look", mode="draht")
            return "Drahtmodell, Sir."
        if re.match(r"^(?:massiv|solide|normal(?:e ansicht)?|echt(?:e farben)?|in farbe|realistisch)$", norm):
            self._emit("view", what="look", mode="echt")
            return "Echte Farben, Sir."
        if re.match(r"^(?:hologramm(?:[- ]?ansicht)?|holo|als hologramm)$", norm):
            self._emit("view", what="look", mode="holo")
            return "Hologramm, Sir."
        if re.match(r"^(?:beschriftung\w*|beschrifte\w*(?: es| das| alles)?|zeig (?:mir )?die namen)(?: an| ein)?$", norm):
            self._emit("view", what="labels", on=True)
            return "Beschriftet, Sir."
        if re.match(r"^(?:beschriftung\w* (?:aus|weg)|keine beschriftung\w*|namen (?:aus|weg))$", norm):
            self._emit("view", what="labels", on=False)
            return "Ohne Beschriftung, Sir."
        if re.match(rf"^(?:(?:leere|leerer|neue|neuer) {_BLUEPRINT}|alles (?:löschen|weg)|tisch (?:leer|frei)|"
                    r"fang (?:neu|von vorne) an|neues modell)$", norm):
            with self._lock:
                self._remember()
                self.scene = empty_scene()
                self.selected = ""
            self._push_scene()
            return "Der Tisch ist frei, Sir. Was soll ich konstruieren?"
        saved = re.match(rf"^(?:speicher|speichere|sicher|sichere)(?: mir)?(?: (?:das|es|die blaupause|den {_BLUEPRINT}|das modell))?"
                         r"(?: (?:als|unter) (?P<name>.+))?$", norm)
        if saved:
            return self.save_spoken(saved.group("name") or "")
        if re.match(r"^(?:exportier|exportiere|export)(?: (?:das|es|das modell))?(?: als stl| für den 3d[- ]?druck| als 3d[- ]?druck)?$|"
                    r"^(?:als stl (?:speichern|exportieren)|(?:mach|mache) (?:es|das) (?:für den )?3d[- ]?druck(?:fertig| bereit)?)$", norm):
            if not self.scene["teile"]:
                return "Auf dem Tisch liegt noch nichts, Sir."
            self._emit("export", name=self.scene["name"] or "Blueprint")
            return "STL für den 3D-Drucker kommt, Sir."
        load = re.match(rf"^(?:lade|lad|öffne|hol|hole)(?: mir)? (?:die |den |das )?{_BLUEPRINT} (?P<name>.+)$", norm)
        if load:
            return self.load_spoken(load.group("name"))
        if re.match(rf"^(?:zeig|zeige|welche|was für)(?: mir)?(?: meine| alle)? {_BLUEPRINT}(?: habe ich| hab ich)?$", norm):
            items = self.saved()
            self._emit("library", items=items)
            if not items:
                return "Noch keine gespeicherten Blueprints, Sir."
            names = [i["name"] for i in items[:4]]
            return f"{len(items)} Blueprint{'s' if len(items) != 1 else ''}, Sir: " + ", ".join(names) + "."
        if not self.scene["teile"]:
            return None
        if re.match(r"^(?:was ist das|was ist (?:dieses|das) teil|was hab ich (?:da )?ausgewählt)$", norm):
            part = next((p for p in self.scene["teile"] if p["id"] == self.selected), None)
            if part is None:
                return f"Das ist {self.scene['name'] or 'das Modell'}, Sir, aus {len(self.scene['teile'])} Teilen. " \
                       + (self.scene.get("beschreibung") or "")
            group = f" aus der Baugruppe {part['gruppe']}" if part.get("gruppe") else ""
            return f"Das ist {part['name']}{group}, Sir."
        focus = re.match(r"^(?:zeig|zeige)(?: mir)? (?P<what>.+?) (?:genauer|näher|von nahem|im detail|aus der nähe)(?: an)?$|"
                         r"^(?:zoom|zoome|fokus|fokussier\w*|geh|schau)(?: mal)? (?:auf|zu|an) (?P<what2>.+?)(?: ran| heran| genauer)?$|"
                         r"^(?:schau|sieh)(?: dir)? (?P<what3>.+?) genauer an$|^(?:wähl|wähle) (?P<what4>.+?) aus$", norm)
        if focus:
            words = focus.group("what") or focus.group("what2") or focus.group("what3") or focus.group("what4")
            parts = self._find(words)
            if not parts:
                shown = re.sub(r"^(?:den|die|das|dem|der)\s+", "", words)  # "das triebwerk" -> "Triebwerk"
                return f"Ein Teil namens {shown[:1].upper() + shown[1:]} finde ich nicht, Sir."
            return self._focus_on(parts)
        only = re.match(r"^(?:zeig(?: mir)? nur|nur (?:noch )?)(?: den| die| das)? ?(?P<what>.+?)(?: zeigen| anzeigen)?$", norm)
        if only:
            parts = self._find(only.group("what"))
            if parts:
                self._emit("view", what="isolate", ids=[p["id"] for p in parts])
                return "Nur noch das, Sir."
        if re.match(r"^(?:zeig (?:mir )?(?:wieder )?alles|alles (?:wieder )?(?:zeigen|einblenden|anzeigen)|blende alles ein)$", norm):
            self._emit("view", what="isolate", ids=[])
            with self._lock:
                hidden = [p for p in self.scene["teile"] if p.get("versteckt")]
                for p in hidden:
                    p.pop("versteckt", None)
            if hidden:
                self._push_scene()
            return "Alles wieder da, Sir."
        hide = re.match(r"^(?:blende|blend|versteck|verstecke)(?: mir)? (?P<what>.+?)(?: aus)?$", norm)
        if hide:
            parts = self._find(hide.group("what"))
            if parts:
                with self._lock:
                    for p in parts:
                        p["versteckt"] = True
                self._push_scene()
                return "Ausgeblendet, Sir."
        removed = re.match(r"^(?:entfern|entferne|lösch|lösche|weg mit|nimm)(?: das teil| die teile)? (?P<what>.+?)(?: weg| raus| ab)?$", norm)
        if removed:
            parts = self._find(removed.group("what"))
            if parts:
                with self._lock:
                    self._remember()
                    for p in parts:
                        self.apply({"op": "entfernen", "id": p["id"]})
                n = len(parts)
                return f"{'Entfernt' if n == 1 else f'{n} Teile entfernt'}, Sir. Mit „Rückgängig“ ist es wieder da."
        color = re.match(r"^(?:mach|mache|färb|färbe|lackier|lackiere|mal|male)(?: mir)? (?P<what>.+?) (?:in )?(?P<color>"
                         + "|".join(sorted(COLORS, key=len, reverse=True)) + r")(?: an| ein)?$", norm)
        if color:
            parts, label = self._target(color.group("what"))
            if parts:
                with self._lock:
                    self._remember()
                    for p in parts:
                        self.apply({"op": "aendern", "id": p["id"], "farbe": COLORS[color.group("color")]})
                return f"{label[:1].upper() + label[1:]} ist jetzt {color.group('color')}, Sir."
        factor = _factor(norm)
        if factor is not None and re.match(r"^(?:mach|mache|skalier\w*|vergrößer\w*|verkleiner\w*|größer|kleiner|"
                                           r"etwas|viel|ein bisschen|doppelt|halb|um)\b", norm):
            words = re.sub(r"^(?:mach|mache|skalier\w*|vergrößer\w*|verkleiner\w*)\s*", "", norm)
            words = re.sub(r"\b(?:viel|etwas|ein bisschen|bisschen|deutlich|doppelt so|halb so|dreimal so|zweimal so|"
                           r"um \d+(?:[.,]\d+)? ?(?:prozent|%)|größer|kleiner|groß|klein|länger|kürzer|breiter|"
                           r"schmaler|höher|niedriger|dicker|dünner|riesig\w*|winzig\w*)\b", " ", words).strip()
            parts, label = self._target(words)
            if not parts:
                return None
            if re.search(r"\b(?:länger|kürzer|breiter|schmaler|höher|niedriger|dicker|dünner)\b", norm) and \
                    label != "das Modell":
                return None  # eine Richtung ist gemeint: das kann Claude besser
            with self._lock:
                self._remember()
                self._scale(parts, factor)
            self._push_scene()
            percent = round(abs(factor - 1) * 100)
            way = "größer" if factor > 1 else "kleiner"
            return f"{label[:1].upper() + label[1:]} ist jetzt {percent} Prozent {way}, Sir."
        return None

    # ------------------------------------------------------------------ Claude zeichnet

    QUEUE_MAX = 5

    def generate(self, wish: str, fresh: bool = True) -> str:
        """Claude konstruiert (fresh) oder ändert das Modell. Die Teile kommen einzeln ins Fenster. Baut Claude
        gerade, kommt der Wunsch in die Warteschlange und ist direkt danach dran."""
        with self._lock:
            if self._brain is None or not getattr(self._brain, "claude_path", ""):
                return "Dafür brauche ich mein Gehirn, Sir. Bitte öffnen Sie einmal die Einstellungen."
            if self.busy:
                if len(self._queue) >= self.QUEUE_MAX:
                    return "Einen Moment, Sir, ich bin noch dran."
                self._queue.append((str(wish), fresh))
                self._emit("queue", items=[w for w, _ in self._queue])
                return random_choice(["Danach, Sir.", "Kommt gleich, Sir.", "Notiert, Sir."])
            self.busy = True
            self._cancel.clear()
            self._remember()
        self._emit("busy", text=str(wish)[:200], fresh=fresh)
        threading.Thread(target=self._work, args=(str(wish), fresh), name="jarvis-blaupause", daemon=True).start()
        return random_choice(["Sofort, Sir.", "Sehr wohl, Sir.", "Wird gemacht, Sir."])

    def _after(self) -> None:
        """Nach einer Konstruktion: der nächste Wunsch aus der Warteschlange, sonst das gewünschte Foto aus Blender,
        sonst den Prozess vorwärmen."""
        if self._queue:
            self._next()
            return
        kind, self._blender_after = self._blender_after, ""
        if kind:
            said = self._blender_start(kind)
            if said not in ("Ich rendere es, Sir.", "Ich öffne es in Blender, Sir."):
                self._announce(said)  # z. B. "Blender fehlt noch, Sir. Ich installiere es ..."
        self._warm()

    def _next(self) -> None:
        """Der nächste Wunsch aus der Warteschlange, ohne dass Georg nochmal fragen muss."""
        with self._lock:
            if not self._queue or self.busy or self._cancel.is_set():
                return
            wish, fresh = self._queue.pop(0)
            self._emit("queue", items=[w for w, _ in self._queue])
        self.generate(wish, fresh=fresh)

    def cancel(self) -> bool:
        with self._lock:
            had_queue = bool(self._queue or self._blender_after)
            self._queue.clear()
            self._blender_after = ""
        rendering = self._blender_busy()
        if rendering:
            self._blender_cancel.set()  # "Stopp" hält auch Blender an
        if not self.busy:
            return had_queue or rendering
        self._cancel.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        return True

    def _prompt(self, wish: str, fresh: bool) -> str:
        if fresh or not self.scene["teile"]:
            return f"Blaupause: Neues Modell. Georg sagt: „{wish}“"
        compact = json.dumps(self.scene, ensure_ascii=False, separators=(",", ":"))
        chosen = f"\nAusgewählt ist das Teil mit id \"{self.selected}\"." if self.selected else ""
        return (f"Blaupause: Ändere das vorhandene Modell. Georg sagt: „{wish}“{chosen}\n"
                f"Das Modell jetzt (JSON):\n{compact}")

    def _work(self, wish: str, fresh: bool) -> None:
        added = 0
        spoken = ""
        buffer = ""
        error = ""
        started = time.monotonic()

        def take(line: str) -> None:
            nonlocal added, spoken
            for op in parse_ops(line):
                kind = str(op.get("op") or "").lower()
                if kind == "sagen":
                    spoken = str(op.get("text") or "")[:300]
                    continue
                if kind == "animation":
                    art = animation_name(op.get("art"))
                    if art is not None:
                        self._emit("view", what="anim", art=art)
                    continue
                if kind == "neu" and not fresh:
                    continue  # eine Änderung: das Modell bleibt
                if self.apply(op) and kind in ("teil", "aendern", "entfernen"):
                    added += 1

        def on_text(chunk: str) -> None:
            nonlocal buffer
            buffer += chunk
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                take(line)

        try:
            if fresh:
                with self._lock:
                    self.scene = empty_scene()
                    self.selected = ""
                self._emit("op", op={"op": "neu", "name": "", "beschreibung": ""})
            path = self._system_file()
            stream = getattr(self._brain, "stream_oneshot", None)
            if stream is None:
                raise RuntimeError("Diese Jarvis-Version kann noch keine Blaupausen.")
            stream(self._prompt(wish, fresh), system_file=path, model=self.model, effort=self.effort,
                   on_text=on_text, cancel=self._cancel, on_proc=self._set_proc)
            if buffer.strip():
                take(buffer)
        except Exception as exc:
            error = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
            log.info("Blaupause: %s", error)
        finally:
            self._proc = None
            with self._lock:
                self.busy = False
        seconds = round(time.monotonic() - started)
        if self._cancel.is_set():
            self._emit("done", ok=False, cancelled=True, **self.state())
            return
        if fresh and not added:
            # Das neue Modell ist nicht entstanden: Änderungen, die Georg dafür schon gesagt hat, passen nicht mehr,
            # ein gewünschtes Foto auch nicht
            self._blender_after = ""
            with self._lock:
                kept = [item for item in self._queue if item[1]]
                if len(kept) != len(self._queue):
                    self._queue = kept
                    self._emit("queue", items=[w for w, _ in self._queue])
        if error and not added:
            with self._lock:
                if self._undo:
                    self.scene = self._undo.pop()
            self._emit("done", ok=False, error=error, **self.state())
            self._announce("Das ging leider nicht, Sir. " + _explain(error))
            self._blender_after = ""  # kein Foto vom alten Modell
            self._after()
            return
        name = self.scene["name"] or "Das Modell"
        count = len(self.scene["teile"])
        log.info("Blueprint fertig nach %d s: %s, %d Teile (%d Änderungen)", seconds, name, count, added)
        self._emit("done", ok=True, seconds=seconds, said=spoken, **self.state())
        # Georg: "nicht alles erklären, schnell machen und Erledigt sagen". Claudes Satz steht im Fenster.
        if fresh and not added:
            short = "Das hat nicht geklappt, Sir. Sagen Sie es bitte noch einmal anders."
        elif fresh:
            short = random_choice([f"Fertig, Sir. {name}.", f"{name} steht, Sir."])
        else:
            short = "Erledigt, Sir." if added else "Daran hat sich nichts geändert, Sir."
        self._last_spoken = short
        self._announce(short)
        self._after()

    def take_handoff(self, state_dir: Path) -> bool:
        """Holt einen Wunsch ab, den das Gehirn über jarvis.tool übergeben hat. True = übernommen."""
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
        wish = str(data.get("wunsch") or "").strip()[:600]
        if not wish or age > 120:
            return False
        log.info("Blaupause vom Gehirn: %s", wish)
        if not self.active:
            self.open()
        said = self.generate(wish, fresh=not (data.get("aendern") and self.scene["teile"]))
        if said.startswith(("Ich konstruiere noch", "Dafür brauche")):
            self._announce(said)
        return True

    def _set_proc(self, proc) -> None:
        self._proc = proc

    def _system_file(self) -> Path:
        base = Path(getattr(self._brain, "state_dir", "") or self.folder)
        path = base / "blaupause-anleitung.md"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists() or path.read_text(encoding="utf-8") != SYSTEM_PROMPT:
                path.write_text(SYSTEM_PROMPT, encoding="utf-8")
        except OSError as exc:
            log.debug("Blaupause, Anleitung: %s", exc)
        return path

    # ------------------------------------------------------------------ Blender: Foto und .blend-Datei

    def set_view(self, view) -> bool:
        """Das Fenster meldet, aus welchem Winkel Georg das Modell ansieht: {"azimut": Grad (0 = vorne, 90 = rechts),
        "hoehe": Grad über dem Boden}. "Render das" fotografiert dann genau so."""
        if not isinstance(view, dict):
            return False
        try:
            azimuth, height = float(view.get("azimut")), float(view.get("hoehe"))
        except (TypeError, ValueError):
            return False
        if not (math.isfinite(azimuth) and math.isfinite(height)):
            return False
        azimuth = (azimuth + 180.0) % 360.0 - 180.0
        self.view = {"azimut": round(azimuth, 1), "hoehe": round(min(89.0, max(-89.0, height)), 1)}
        return True

    def _blender_busy(self) -> bool:
        return self._blender_thread is not None and self._blender_thread.is_alive()

    def render_photo(self) -> str:
        """\"Render das\": Blender macht ein Foto vom Modell. Läuft im Hintergrund, das Fenster zeigt den Fortschritt
        und danach das Bild."""
        return self._blender_start("foto")

    def open_in_blender(self) -> str:
        """\"Öffne das in Blender\": eine .blend-Datei mit Modell, Licht und Kamera, dann Blender mit Fenster."""
        return self._blender_start("blend")

    def _blender_start(self, kind: str) -> str:
        from . import blender

        with self._lock:
            if self.busy:
                self._blender_after = kind  # erst fertig bauen, dann das Foto vom ganzen Modell
                return "Sobald es steht, Sir."
            if not self.scene["teile"]:
                return "Auf dem Tisch liegt noch nichts, Sir."
            if self._blender_busy():
                return "Blender ist noch beschäftigt, Sir."
            scene = copy.deepcopy(self.scene)
        found = blender.find_blender(self.blender_setting)
        if found is None and not blender.can_install():
            return "Blender ist auf diesem Rechner nicht installiert, Sir."
        self._blender_cancel.clear()
        view = dict(self.view) if self.view else None
        thread = threading.Thread(target=self._blender_work, args=(kind, scene, found, view), name="jarvis-blender",
                                  daemon=True)
        self._blender_thread = thread
        thread.start()
        if found is None:
            return ("Blender fehlt noch, Sir. Ich installiere es, das dauert ein paar Minuten. "
                    "Windows fragt dabei vielleicht nach Ihrer Erlaubnis.")
        return "Ich rendere es, Sir." if kind == "foto" else "Ich öffne es in Blender, Sir."

    def _scratch(self) -> Path:
        return Path(getattr(self._brain, "state_dir", "") or Path(tempfile.gettempdir()) / "jarvis") / "blender"

    def _blender_work(self, kind: str, scene: dict, path, view: dict | None = None) -> None:
        from . import blender

        name = blender.file_name(scene.get("name") or "Blueprint")
        try:
            if path is None:
                self._emit("render", state="install", kind=kind)
                try:
                    blender.install()
                except Exception as exc:
                    raise blender.BlenderError(f"Die Installation ging nicht. {exc}") from None
                path = blender.find_blender(self.blender_setting)
                if path is None:
                    raise blender.BlenderError("Blender ist installiert, aber ich finde es nicht. Der Pfad lässt sich "
                                               "in config.toml unter [blaupause] blender_pfad eintragen.")
            if kind == "blend":
                self._emit("render", state="blend", kind=kind)
                file = blender.make_blend(path, scene, self.folder, name, self._scratch(), cancel=self._blender_cancel,
                                          view=view)
                blender.open_blend(path, file)
                log.info("Blueprint in Blender: %s", file)
                self._emit("render", state="opened", kind=kind, path=str(file))
                return
            self._emit("render", state="start", kind=kind, name=str(scene.get("name") or ""))

            def progress(step: dict) -> None:
                self._emit("render", state="progress", kind=kind, percent=step.get("prozent"), rest=step.get("rest"),
                           note=step.get("hinweis") or "")

            photo = blender.render(path, scene, self.folder, name, self._scratch(), on_progress=progress,
                                   cancel=self._blender_cancel, view=view)
            self.photo = photo
            log.info("Blueprint-Foto nach %.0f s (%s): %s", photo.seconds, photo.device or "?", photo.image)
            self._emit("render", state="done", kind=kind, path=str(photo.image), seconds=photo.seconds,
                       device=photo.device, name=str(scene.get("name") or ""))
            self._announce("Das Foto ist fertig, Sir.")
        except blender.BlenderError as exc:
            if str(exc) == "abgebrochen":
                self._emit("render", state="cancelled", kind=kind)
                return
            log.info("Blender: %s", exc)
            self._emit("render", state="error", kind=kind, error=str(exc)[:300])
            self._announce("Blender hat nicht mitgespielt, Sir. " + str(exc)[:160])
        except Exception as exc:
            log.exception("Blender")
            self._emit("render", state="error", kind=kind, error=str(exc)[:300] or type(exc).__name__)
            self._announce("Blender hat nicht mitgespielt, Sir. Einzelheiten stehen im Protokoll.")

    # ------------------------------------------------------------------ Speichern, Laden, Export

    def save(self, name: str = "") -> Path:
        with self._lock:
            if not self.scene["teile"]:
                raise ValueError("Auf dem Tisch liegt noch nichts.")
            if name:
                self.scene["name"] = str(name)[:80]
            data = copy.deepcopy(self.scene)
        data["gespeichert"] = dt.datetime.now().isoformat(timespec="minutes")
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / f"{slug(data['name'] or 'Blaupause')}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        self._emit("saved", name=data["name"], path=str(path))
        return path

    def save_spoken(self, name: str) -> str:
        try:
            path = self.save(name.strip().title() if name and name.islower() else name)
        except (OSError, ValueError) as exc:
            return f"Das Speichern ging nicht, Sir. {exc}"
        return f"Gespeichert als {self.scene['name'] or path.stem}, Sir."

    def saved(self) -> list[dict]:
        items = []
        try:
            files = sorted(self.folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return []
        for path in files[:100]:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and isinstance(data.get("teile"), list):
                items.append({"name": str(data.get("name") or path.stem), "datei": path.name,
                              "teile": len(data["teile"]), "gespeichert": str(data.get("gespeichert") or "")})
        return items

    def _file(self, name: str) -> Path | None:
        wanted = slug(name)
        for item in self.saved():
            if item["datei"] == name or Path(item["datei"]).stem == wanted or item["name"].lower() == str(name).lower():
                return self.folder / item["datei"]
        found = [i for i in self.saved() if wanted and wanted in Path(i["datei"]).stem]
        return self.folder / found[0]["datei"] if found else None

    def load(self, name: str) -> bool:
        path = self._file(name)
        if path is None:
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        teile = [p for p in (clean_part(t) for t in data.get("teile") or []) if p][:MAX_PARTS]
        with self._lock:
            self._remember()
            self.scene = {"name": str(data.get("name") or path.stem)[:80],
                          "beschreibung": str(data.get("beschreibung") or "")[:300], "teile": teile}
            if _num(data.get("groesse_m"), 0.0, 0.0, 100000) > 0:
                self.scene["groesse_m"] = _num(data.get("groesse_m"), 0.0, 0.0, 100000)
            self.selected = ""
        if not self.active:
            self.open()
        self._push_scene()
        return True

    def load_spoken(self, name: str) -> str:
        if self.load(name):
            return f"{self.scene['name']} liegt auf dem Tisch, Sir."
        return f"Einen Blueprint namens {name} finde ich nicht, Sir."

    def delete(self, name: str) -> bool:
        path = self._file(name)
        if path is None:
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True

    def export_stl(self, name: str, data_b64: str) -> str:
        """Das Fenster rechnet die STL-Datei aus (three.js), Jarvis legt sie in den Blaupausen-Ordner."""
        try:
            data = base64.b64decode(str(data_b64 or ""), validate=True)
        except ValueError:
            raise ValueError("Die Datei kam kaputt an.") from None
        if len(data) < 84 or len(data) > STL_MAX_BYTES:
            raise ValueError("Die Datei ist leer oder zu groß.")
        count = int.from_bytes(data[80:84], "little")
        if 84 + count * 50 != len(data):
            raise ValueError("Das ist keine gültige STL-Datei.")
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / f"{slug(name or self.scene['name'] or 'Blaupause')}.stl"
        path.write_bytes(data)
        return str(path)


HANDOFF = "blaupause-auftrag.json"


def hand_over(state_dir: Path, wish: str, change: bool = False) -> Path:
    """Für jarvis.tool: das Gehirn gibt einen 3D-Wunsch an die Blaupause (\"Kannst du mir ein Auto in 3D bauen?\")."""
    path = Path(state_dir) / HANDOFF
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"wunsch": wish, "aendern": change, "zeit": dt.datetime.now().isoformat(timespec="seconds")}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def random_choice(options: list[str]) -> str:
    import random

    return random.choice(options)


def _explain(error: str) -> str:
    low = error.lower()
    if re.search(r"not logged in|login|unauthori|authentication", low):
        return "Claude ist nicht angemeldet."
    if re.search(r"limit|credit|overloaded", low):
        return "Das Claude-Kontingent ist gerade erschöpft."
    return "Einzelheiten stehen im Protokoll."
