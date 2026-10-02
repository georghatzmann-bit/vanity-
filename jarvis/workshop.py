"""Die Werkstatt: Programmier- und Bauaufgaben, die Jarvis im Hintergrund erledigt.

"Bau mir einen Discord-Bot, der ..." landet nicht im normalen Gespräch, sondern hier:
eigener Projektordner, gründlicheres Nachdenken, ein Plan mit Schritten (TodoWrite),
Dateien schreiben, Pakete installieren, testen. Das Fenster zeigt alles als Blaupause, das Projekt
als Hologramm: zuerst ein passendes Symbol, dann das logo.svg, das die Werkstatt dafür zeichnet.
Währenddessen bleibt Jarvis ansprechbar; ist die Arbeit fertig, sagt er Bescheid.

Während der Arbeit kann Georg mit Jarvis reden: "Wie weit bist du?" beantwortet Jarvis aus dem Plan,
Wünsche ("Mach den Hintergrund blau", "Nimm lieber Python") gehen direkt in die laufende Arbeit (der
Claude-Prozess liest weiter von stdin, --input-format stream-json), andere Fragen zum Projekt beantwortet
das Gehirn mit dem Stand der Werkstatt im Blick (context()).

Danach geht es am selben Projekt weiter: "Mach in der Werkstatt weiter ...", "Füg dem Bot
noch einen Befehl hinzu", "Der Bot startet nicht" (dieselbe Claude-Sitzung, derselbe Ordner).
Endet die Arbeit mit einer Frage, ist Georgs nächste Antwort für die Werkstatt. Gibt es eine
start.bat, fragt Jarvis, ob er das Ergebnis gleich starten soll.
Erkennt Jarvis einen Bauauftrag nicht selbst, gibt das Gehirn ihn über
`python -m jarvis.tool werkstatt "..."` weiter (Datei HANDOFF im Datenordner).
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import queue
import random
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import konnektoren, versteckt

log = logging.getLogger(__name__)

WORKSHOP_TOOLS = [
    "Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite",
]
# Übergabe vom Gehirn (jarvis.tool werkstatt ...) an die laufende Werkstatt
HANDOFF = "werkstatt-auftrag.json"
RECYCLE_BIN = os.name == "nt"  # gelöschte Projekte in den Papierkorb (nur unter Windows)
DELETE_WINDOW = 45.0  # so lange gilt ein "Ja" auf "Soll ich das Projekt wirklich löschen?" (Sekunden)
# So lange nach dem Ende gilt "Füg noch ... hinzu" als Wunsch zum letzten Projekt (Sekunden) ...
FOLLOW_UP_WINDOW = 30 * 60
# ... und so lange ist eine Antwort auf die Rückfrage am Ende für die Werkstatt.
ANSWER_WINDOW = 10 * 60
# Kommt nach dem Ergebnis so lange nichts mehr, obwohl Georg noch etwas geschickt hat, war es schon
# in der Arbeit drin (Claude Code nimmt Nachrichten auch mitten im Lauf auf). Sekunden.
AFTER_RESULT = 20.0

WORKSHOP_PROMPT = """

## Werkstatt-Modus

Du arbeitest gerade in deiner Werkstatt an einem Programmier- oder Bauauftrag für Georg. Er sieht dir
im Fenster zu, jeder Schritt erscheint dort. Das hier ist kein Gespräch: Arbeite selbstständig, bis
das Ergebnis fertig ist und läuft. Du bist schon in der Werkstatt, also baust du selbst und gibst
nichts mit `jarvis.tool werkstatt` weiter.

- Projektordner: {folder}
  Er existiert schon. Lege alles dort an und arbeite nur dort.
- Ein Ordner allein ist kein Ergebnis. Hör erst auf, wenn das Programm geschrieben und gestartet oder
  getestet ist.
- Stell keine Rückfragen, triff vernünftige Entscheidungen. Georg kann dir aber während der Arbeit
  Nachrichten schicken (Wünsche, Korrekturen, "nimm lieber ..."). Sie beginnen mit "Georg, während du
  arbeitest:". Bau sie ein, ohne von vorn anzufangen, und arbeite weiter, bis alles fertig ist.
- Fehlt etwas, das nur Georg hat (Bot-Token, Passwort, API-Schlüssel), baue trotzdem alles fertig,
  lege eine Vorlage an (zum Beispiel .env.beispiel) und sag am Ende in einem Satz, was er wo eintragen
  muss.
- Mach zuerst mit TodoWrite einen kurzen Plan mit drei bis sieben Schritten und hake sie ab.
- Gibt es im Projektordner noch kein logo.svg, zeichne gleich nach dem Plan eins: ein schlichtes, flaches
  Logo, das zum Projekt passt (ein Roboterkopf für einen Bot, ein Controller für ein Spiel ...). Georg sieht
  es in der Werkstatt als Hologramm. Nur Formen und Linien in kräftigen Farben, möglichst ohne Text,
  <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">, keine Bilder,
  keine Skripte, keine Links nach außen, höchstens 20 KB. Ein kurzer Schritt, keine Designarbeit.
- Teste, was du baust (starten, kurz ausprobieren, Tests). Scheitert ein Befehl, lies die Meldung und
  versuche einen anderen Weg, statt aufzugeben. Fehlen Pakete, installiere sie.
- Georg soll von deinen Tests nichts merken: Öffne nie den Browser, den Explorer oder Dateien und
  Webseiten mit start, Start-Process oder Invoke-Item (das landet auf seinem Bildschirm). Prüfe Webseiten
  mit einem kurzen Skript (Dateien, Links, HTML) oder einem Browser ohne Fenster (headless). Programme mit
  Fenster startest du nur kurz, mit Zeitlimit, und beendest sie wieder; pygame-Spiele mit
  SDL_VIDEODRIVER=dummy. Startet ein Fenster beim Test nicht, kann das am unsichtbaren Arbeitsplatz liegen,
  nicht am Code: dann prüfe die Logik ohne Fenster.
{platform}
- Lege eine kurze LIESMICH.txt an: was es ist und wie man es startet.
- Zum Schluss genau zwei oder drei kurze Sätze für Georg, auf Deutsch, ohne Markdown, wie immer mit
  "Sie" und "Sir": was du gebaut hast und wie er es startet. Das wird vorgelesen. Hast du danach noch
  einen Wunsch von Georg umgesetzt, endest du wieder so, mit dem ganzen Ergebnis.
"""

WINDOWS_HINTS = """- Du bist unter Windows. Nutze PowerShell-Befehle und Windows-Pfade. Lege eine start.bat an, mit der
  Georg das Programm per Doppelklick startet.
- Python: "python" ist eingerichtet ({python}). Für Python-Projekte im Projektordner eine eigene
  Umgebung anlegen (python -m venv .venv), Pakete mit .venv\\Scripts\\python -m pip install ... und
  das Programm mit .venv\\Scripts\\python starten, auch in der start.bat."""
OTHER_HINTS = """- Python: "python" ist eingerichtet ({python}). Für Python-Projekte im Projektordner eine eigene
  Umgebung anlegen (python -m venv .venv) und Pakete dort installieren."""

FOLLOW_UP_PROMPT = """

## Weiter am selben Projekt

Georg hat einen neuen Wunsch zu diesem Projekt (die Nachricht). Sieh dir bei Bedarf zuerst an, was im
Projektordner schon liegt, dann setz den Wunsch um, teste und beende mit zwei oder drei Sätzen für Georg.
"""

# "Bau mir einen Discord-Bot", "Programmier ein Spiel", "Schreib ein Python-Skript, das ..."
# Eine bloße "Datei" oder "Seite" ("Erstelle eine Datei auf dem Desktop", "Mach mir eine neue Seite
# in Chrome") ist keine Bauaufgabe; als "Batch-Datei" oder "Webseite" schon.
_THING = (
    r"(?:(?:python[- ]?|powershell[- ]?|batch[- ]?|discord[- ]?|telegram[- ]?|web[- ]?|minecraft[- ]?|"
    r"kleine[ns]? |einfache[ns]? |neue[ns]? |eigene[ns]? |coole[ns]? |richtige[ns]? |komplette[ns]? |schöne[ns]? )*"
    r"(?:skript|script|programm|tool|bot|app|anwendung|software|website|webseite|homepage|webapp|spiel|game|"
    r"mod|plugin|addon|add-on|erweiterung|extension|projekt|code|rechner|taschenrechner|dashboard|overlay|"
    r"launcher|installer|automatisierung|makro|ki|chatbot)\w*"
    r"|(?:python|powershell|batch|web|html|internet)[- ]?(?:datei|seite)\w*)"
)
_FILLERS = r"(?:(?:bitte|mal|schnell|kurz|noch|jetzt|gleich|doch|eben|einfach) )*"
_ARTICLE = r"(?:ein|eine|einen|nen|ne|n)"
_WORKSHOP = [
    re.compile(r"^(?:(?:kannst|könntest) du (?:mir )?)?" + _FILLERS + r"(?:programmier|programmiere|entwickel|entwickle|code|coden)\b"),
    re.compile(
        r"^(?:(?:kannst|könntest) du (?:mir )?)?" + _FILLERS +
        r"(?:schreib|schreibe|bau|baue|erstell|erstelle|mach|mache|programmier|programmiere|entwickel|entwickle)\s+"
        r"(?:mir |uns )?" + _FILLERS + _ARTICLE + r"\s+" + _THING
    ),
    re.compile(
        r"^(?:kannst|könntest|würdest) du (?:mir |uns )?" + _FILLERS + _ARTICLE + r"\s+" + _THING +
        r".*\b(?:bauen|schreiben|programmieren|erstellen|machen|entwickeln|coden)$"
    ),
    # "Ich brauche ein Programm, das ...", "Ich hätte gern eine Webseite für ..."
    # ("Ich will ein Spiel spielen", "Ich möchte ein Programm installieren" sind keine)
    re.compile(
        r"^ich (?!.*\b(?:spielen|zocken|installieren|herunterladen|runterladen|downloaden|kaufen|öffnen|starten|"
        r"empfehlen|finden|suchen|sehen|anschauen|löschen|deinstallieren|ausprobieren)\b)"
        r"(?:brauche|bräuchte|brauch|hätte gern|hätte gerne|möchte|will|würde gern|würde gerne|hätte)\s+"
        r"(?:mal |noch |jetzt )?" + _ARTICLE + r"\s+" + _THING + r".*$"
    ),
    # "Schreib mir Code für ...", "Programmier mir was, das ..."
    re.compile(r"^(?:schreib|schreibe)\s+(?:mir |uns )?" + _FILLERS + r"(?:den |einen )?(?:code|quellcode|programmcode)\b"),
    re.compile(r"\bwerkstatt\b"),
    re.compile(r"^(?:fix|fixe|behebe|reparier|repariere)\s+(?:den |die |das )?(?:code|skript|script|programm)\b"),
    # "Behebe den Fehler in meinem Skript", aber nicht "Behebe den Fehler mit dem Sound"
    re.compile(r"^(?:fix|fixe|behebe|reparier|repariere)\s+(?:den |die |das )?(?:fehler|bug)"
               r"(?:$| (?:in|im|bei|an) .*\b(?:code|skript|script|programm|bot|app|spiel|webseite|website|tool|projekt))"),
]
_ARTIFACT_WORDS = (r"(?:bot|skript|script|programm|spiel|game|app|seite|website|webseite|homepage|tool|code|projekt|"
                   r"plugin|mod|befehl|befehle|funktion|fehler|bug)")
# Weiter am letzten Projekt, ausdrücklich: "Mach in der Werkstatt weiter", "Werkstatt, füg noch ... hinzu"
_CONTINUE = re.compile(
    r"^(?:mach|mache|arbeite|arbeit)(?: (?:in der werkstatt|am projekt|daran|damit))? weiter"
    r"(?:$| (?:am|an dem|an der|mit dem|mit der|beim) " + _ARTIFACT_WORDS + r")|"
    r"^werkstatt\b(?! (?:abbrechen|stoppen|stopp|beenden|status))|"
    r"^(?:zurück )?in die werkstatt\b|"
    r"\bin der werkstatt\b(?!.*\?$)"
)
# Wünsche zum gerade gebauten Projekt, ohne die Werkstatt zu nennen (nur kurz nach dem Ende)
_CHANGE_VERB = (r"^(?:füg|füge|bau|baue|mach|mache|änder|ändere|reparier|repariere|fix|fixe|verbesser|verbessere|"
                r"erweiter|erweitere|pass|passe|ergänz|ergänze|teste|test|programmier|programmiere|schreib|schreibe)\b")
_ARTIFACT = r"\b" + _ARTIFACT_WORDS + r"\b"
_BROKEN = re.compile(
    r"^(?:der bot|das skript|das script|das programm|das spiel|die app|die seite|die webseite|das tool|es|er)\s+"
    r"(?:geht|funktioniert|läuft|startet|klappt|reagiert|antwortet)\s+(?:noch |immer noch |gar )?nicht\b"
)


def _norm(text: str) -> str:
    norm = " ".join(re.sub(r"[.,!?;:\"'„“”]", " ", str(text).lower()).split())
    norm = re.sub(r"^(?:(?:hey|hallo|okay|ok) )?jarvis ", "", norm)
    return re.sub(r"^(?:bitte |mal |jetzt |also |okay |ok )+", "", norm)


def is_workshop_request(text: str) -> bool:
    norm = _norm(text)
    # "Mach mir ein Spiel an" heißt starten, nicht bauen.
    if re.match(r"^(?:mach|mache)\b.*\b(?:an|auf|aus|zu)$", norm):
        return False
    # Fragen ("Wie weit ist die Werkstatt?") starten keinen neuen Auftrag.
    if text.strip().endswith("?") or re.match(r"^(?:wie|was|wo|wann|warum|ist|bist|läuft|hast)\b", norm):
        return any(p.search(norm) for p in _WORKSHOP if p.pattern != r"\bwerkstatt\b")
    return any(p.search(norm) for p in _WORKSHOP)


def is_continue_request(text: str) -> bool:
    """Ausdrücklich am letzten Projekt weiter ("Mach in der Werkstatt weiter", "Werkstatt: ...")."""
    norm = _norm(text)
    return bool(_CONTINUE.search(norm)) and not text.strip().endswith("?")


def is_change_request(text: str) -> bool:
    """"Füg dem Bot noch einen Befehl hinzu", "Der Bot startet nicht": klingt nach dem letzten Projekt."""
    norm = _norm(text)
    if _BROKEN.match(norm):
        return True
    if re.match(r"^(?:mach|mache)\b.*\b(?:an|auf|aus|zu)$", norm):
        return False
    return bool(re.match(_CHANGE_VERB, norm)) and bool(re.search(_ARTIFACT, norm))


# Ein Wunsch für die laufende Arbeit: "Mach den Hintergrund blau", "Nimm lieber Python", "Füg noch einen
# Highscore hinzu", "Die Schrift soll größer sein" (nur, wenn kein anderer Sofort-Befehl passt)
_WISH_VERB = re.compile(
    r"^(?:und |aber |ach ja,? |ach,? |übrigens,? |noch was,? |außerdem,? )?(?:nimm|nehm|nehme|verwende|benutz|benutze|"
    r"mach|mache|bau|baue|füg|füge|änder|ändere|pass|passe|ergänz|ergänze|setz|setze|gib|lass|lasse|schreib|"
    r"schreibe|stell|stelle|tausch|tausche|ersetz|ersetze|entfern|entferne|lösch|lösche)\b")
# Worum es im Projekt geht. Allgemeine Wörter ("noch", "auch", "lieber", "Text", "Fenster", "heller") reichen
# nicht: "Gib mir auch das Wetter", "Lösch noch die Downloads" oder "Mach den Bildschirm dunkler" sind
# Befehle für Jarvis, nicht für die Werkstatt. Was hier nicht erkannt wird, gibt das Gehirn weiter (context()).
_WISH_WHAT = re.compile(
    r"\b(?:hintergrund\w*|farbe|farben|schrift\w*|knopf|knöpfe|button|buttons|menü\w*|level|levels|highscore\w*|"
    r"punkte\w*|sound|sounds|soundeffekt\w*|geräusch\w*|logo|icon|design|layout|titel\w*|python|javascript|html|css|"
    r"befehl|befehle|funktion|funktionen|spieler\w*|gegner\w*|figur\w*|blau\w*|rot|rote[nmrs]?|grün\w*|gelb\w*|"
    r"schwarz\w*|weiß\w*|lila|orange|grau\w*|bunt\w*)\b")
_WISH_SHOULD = re.compile(r"^(?:der|die|das|den|es|er|sie|alles|man)\b.*\b(?:soll|sollte|sollen|muss|müssen)\b")
# "Mach mir ...", "Gib mir ...", "Lass uns ...", "Das muss ich ...": das ist für Georg selbst
_FOR_GEORG = re.compile(r"\b(?:ich|mir|mich|uns|wir)\b")


def is_wish(text: str) -> bool:
    """Klingt nach einem Wunsch zum Projekt, an dem die Werkstatt gerade arbeitet."""
    norm = _norm(text)
    if not norm or text.strip().endswith("?") or _NOT_AN_ANSWER.match(norm) or _FOR_GEORG.search(norm):
        return False
    return bool((_WISH_VERB.match(norm) or _WISH_SHOULD.match(norm)) and _WISH_WHAT.search(norm))


# Keine Antwort auf eine Rückfrage, sondern etwas Neues: Fragen und andere Befehle
_NOT_AN_ANSWER = re.compile(
    r"^(?:wie|was|wer|wo|wohin|woher|wann|warum|wieso|weshalb|welche|welcher|welches|wieviel|wie ?viel|"
    r"öffne|starte|schließ|schließe|beende|spiel|spiele|such|suche|zeig|zeige|erzähl|erzähle|sag mir|"
    r"stell|stelle|dreh|drehe|erinnere|erinner|lies|übersetz|übersetze|ruf|rufe|guten (?:morgen|tag|abend)|"
    r"schalt|schalte|gute nacht|tschüss|bis (?:später|dann|morgen))\b|"
    r"^(?:mach|mache)\b.*\b(?:licht|lampe|lampen|fernseher|tv|heizung|musik|radio|rollo|rollos|jalousie|jalousien|"
    r"steckdose|ventilator|klima|hörbuch|podcast)\b|"
    r"^(?:schreib|schreibe|schick|schicke)\b.*\b(?:nachricht|mail|e-mail|sms)\b|"
    r"^(?:danke|dankeschön|danke schön|vielen dank|super|perfekt|toll|klasse|gut gemacht|super gemacht)$"
)


def looks_like_answer(text: str) -> bool:
    """"Nimm den Token aus meiner Notiz", "Ja, mach das": klingt nach einer Antwort, nicht nach etwas Neuem."""
    norm = _norm(text)
    return bool(norm) and not _NOT_AN_ANSWER.match(norm) and not text.strip().endswith("?")


def project_folder(task: str, base: Path, now: dt.datetime | None = None) -> Path:
    """Ein neuer Ordner pro Auftrag: 2026-10-01_1530_discord-bot"""
    now = now or dt.datetime.now()
    words = re.findall(r"[a-zäöüß0-9]+", task.lower())
    skip = {
        "bau", "baue", "mir", "uns", "ein", "eine", "einen", "nen", "ne", "bitte", "mal", "jarvis", "hey",
        "schreib", "schreibe", "erstell", "erstelle", "mach", "mache", "programmier", "programmiere",
        "der", "die", "das", "den", "dem", "und", "mit", "für", "fur", "kannst", "du", "könntest",
        "entwickel", "entwickle", "kleinen", "kleines", "kleine", "einfachen", "einfaches", "neuen", "neues",
        "ich", "brauche", "bräuchte", "möchte", "will", "hätte", "gern", "gerne", "schnell", "noch", "jetzt",
    }
    keep = [w for w in words if w not in skip][:4]
    slug = "-".join(keep) or "projekt"
    slug = (slug.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss"))[:40]
    folder = base / f"{now:%Y-%m-%d_%H%M}_{slug}"
    number = 2
    while folder.exists():
        folder = base / f"{now:%Y-%m-%d_%H%M}_{slug}-{number}"
        number += 1
    return folder


# Woran ein großer Auftrag zu erkennen ist (dann baut Opus, das klügste Modell)
_BIG = re.compile(
    r"\b(?:spiel|game|multiplayer|3d|shop|datenbank|database|komplett|vollständig|ki|chatbot|unity|unreal|"
    r"mod|website mit|app mit|mit login|anmeldung|benutzerkonten|dashboard|server|api|mehrere|mehreren|"
    r"künstliche intelligenz|engine|editor|simulation|plattform|verwaltung|system)\w*", re.I)
_SAYS_OPUS = re.compile(r"\b(?:opus|gründlich|so gut wie möglich|beste qualität|richtig gut|profi|professionell)\b", re.I)
_SAYS_FAST = re.compile(r"\b(?:sonnet|schnell mal|nur kurz|quick)\b", re.I)


def choose_model(task: str, setting: str = "auto") -> str:
    """"auto": Opus für große Aufträge (Spiele, Shops, mehrere Teile, lange Beschreibungen),
    sonst Sonnet. Georg kann es auch sagen ("... mit Opus", "gründlich")."""
    setting = str(setting or "auto").strip().lower()
    if setting not in ("auto", ""):
        return setting
    if _SAYS_OPUS.search(task):
        return "opus"
    if _SAYS_FAST.search(task):
        return "sonnet"
    score = len({m.group(0).lower()[:6] for m in _BIG.finditer(task)})
    score += (len(task) > 160) + (len(task) > 320) + (len(re.findall(r",| und ", task)) >= 4)
    return "opus" if score >= 3 else "sonnet"


def choose_effort(task: str, model: str, setting: str = "auto", effort: str = "medium") -> str:
    """Wie viel die Werkstatt nachdenkt. "auto": große Aufträge (Opus) gründlich, "beste Qualität" oder
    "denk richtig gründlich nach" sehr gründlich, "schnell mal" wenig; sonst wie in config.toml."""
    effort = str(effort or "medium").strip().lower()
    if str(setting or "auto").strip().lower() not in ("auto", ""):
        return effort
    from .modellwahl import classify

    if classify(task)[0] == "maximal" or (_SAYS_OPUS.search(task) and model == "opus"):
        return "xhigh"
    if _SAYS_FAST.search(task):
        return "low"
    if model == "opus" and effort == "medium":
        return "high"
    return effort


PROJECT_FILE = "projekt.json"


def project_name(folder: Path) -> str:
    """"2026-10-01_1530_discord-bot-wuerfel" -> "Discord Bot Wuerfel"."""
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}_\d{4}_", "", folder.name)
    words = [w for w in re.split(r"[-_ ]+", slug) if w]
    return " ".join(w[:1].upper() + w[1:] for w in words) or folder.name


def read_project(folder: Path) -> dict | None:
    """Die Projektkarte (projekt.json), bei älteren Projekten aus dem Werkstatt-Protokoll."""
    folder = Path(folder)
    for name in (PROJECT_FILE, "werkstatt-protokoll.json"):
        try:
            data = json.loads((folder / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        try:
            changed = dt.datetime.fromtimestamp((folder / name).stat().st_mtime).isoformat(timespec="minutes")
        except OSError:
            changed = ""
        return {
            "name": str(data.get("name") or project_name(folder)),
            "folder": str(folder),
            "task": str(data.get("auftrag") or ""),
            "state": str(data.get("zustand") or ""),
            "summary": str(data.get("zusammenfassung") or ""),
            "session": str(data.get("sitzung") or ""),
            "model": str(data.get("modell") or ""),
            "created": str(data.get("erstellt") or ""),
            "updated": str(data.get("zuletzt") or changed),
            "question": str(data.get("frage") or ""),
            "history": list(data.get("verlauf") or [])[-20:],
            "start": (folder / "start.bat").is_file(),
        }
    return None


LOGO_FILE = "logo.svg"
LOGO_MAX_BYTES = 48_000
# Was in einem Logo nichts zu suchen hat: Skripte, eingebettete Seiten und Bilder, Verweise nach außen
# (erlaubt sind nur Verweise im Bild selbst wie url(#verlauf) oder href="#form").
_LOGO_BAD = re.compile(
    r"<\s*(?:script|foreignobject|iframe|embed|object|image|audio|video)\b|<!entity|javascript:|@import|"
    r"\son[a-z]+\s*=|href\s*=\s*[\"']?\s*[^\"'\s#]|url\(\s*[\"']?\s*[^\"'\s#)]",
    re.I,
)


def project_logo(folder: Path) -> str:
    """Das Logo, das die Werkstatt für das Projekt gezeichnet hat (logo.svg), als data:-Adresse für das
    Fenster. Leer, wenn es keins gibt oder etwas Unerwartetes darin steht."""
    path = Path(folder) / LOGO_FILE
    try:
        if path.stat().st_size > LOGO_MAX_BYTES:
            return ""
        text = path.read_bytes().decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return ""
    if "<svg" not in text.lower() or _LOGO_BAD.search(text):
        return ""
    return "data:image/svg+xml;base64," + base64.b64encode(text.encode("utf-8")).decode("ascii")


def project_python() -> str:
    """Ein Python für Georgs Projekte: das, aus dem Jarvis' eigene Umgebung gebaut ist (nicht
    die Umgebung selbst, sonst landen fremde Pakete bei Jarvis). Leer, wenn es keins gibt."""
    path = Path(getattr(sys, "_base_executable", "") or sys.executable)
    if path.name.lower() == "pythonw.exe" and path.with_name("python.exe").exists():
        path = path.with_name("python.exe")
    return str(path) if path.exists() else ""


@dataclass
class Job:
    task: str
    folder: Path
    session: str = field(default_factory=lambda: str(uuid.uuid4()))
    resume: bool = False  # am selben Projekt weiter (gleiche Claude-Sitzung)
    started: float = field(default_factory=time.monotonic)
    begun: str = field(default_factory=lambda: dt.datetime.now().strftime("%H:%M"))
    steps: list = field(default_factory=list)
    todos: list = field(default_factory=list)
    text: str = ""
    state: str = "running"  # running, done, error, cancelled
    summary: str = ""
    detail: str = ""
    ended: float | None = None
    question: str = ""  # endet die Arbeit mit einer Frage, gilt die nächste Antwort der Werkstatt
    model: str = ""  # "opus" oder "sonnet" (choose_model)
    effort: str = ""  # wie viel Claude nachdenkt (choose_effort)
    live: bool = False  # Claude liest noch von stdin: Georgs Wünsche gehen in die laufende Arbeit
    wishes: list = field(default_factory=list)  # was Georg während der Arbeit dazugesagt hat
    sent: int = 0  # Nachrichten an Claude (der Auftrag und Georgs Wünsche)
    results: int = 0  # fertige Antworten von Claude
    start_offer: bool = False  # Jarvis hat gefragt, ob er das Ergebnis starten soll
    logo: str = field(default="", repr=False)  # logo.svg als data:-Adresse (project_logo), fürs Hologramm
    proc: subprocess.Popen | None = field(default=None, repr=False)  # der laufende Claude-Prozess

    def status(self) -> str:
        """Ein Satz für "Wie weit bist du?"."""
        done = sum(1 for t in self.todos if t.get("state") == "completed")
        current = next((t["text"] for t in self.todos if t.get("state") == "in_progress"), "")
        minutes = int((time.monotonic() - self.started) // 60)
        if self.todos:
            where = f"Schritt {min(done + 1, len(self.todos))} von {len(self.todos)}"
            what = f": {current}" if current else ""
            return f"Ich bin bei {where}{what}. Seit {minutes} Minuten dabei, Sir." if minutes else f"Ich bin bei {where}{what}, Sir."
        running = next((s.label for s in reversed(self.steps) if s.state == "running"), "")
        if running:
            return f"Gerade: {running}. Seit {minutes} Minuten dabei, Sir." if minutes else f"Gerade: {running}, Sir."
        return "Ich plane noch, Sir."

    def context(self) -> str:
        """Der Stand für das Gehirn, damit es Fragen zur laufenden Arbeit beantworten kann."""
        minutes = int((time.monotonic() - self.started) // 60)
        marks = {"completed": "[x]", "in_progress": "[>]"}
        plan = ", ".join(f"{marks.get(t.get('state'), '[ ]')} {t.get('text', '')}" for t in self.todos[:10])
        current = next((s.label for s in reversed(self.steps) if getattr(s, "state", "") == "running"), "")
        lines = [f"In deiner Werkstatt läuft gerade ein Auftrag (seit {minutes} Minuten, {self.model or 'Standardmodell'}): "
                 f"„{self.task[:400]}“", f"Projektordner: {self.folder}"]
        if plan:
            lines.append(f"Plan: {plan}")
        if current:
            lines.append(f"Gerade: {current}")
        if self.wishes:
            lines.append("Georgs Wünsche während der Arbeit: " + "; ".join(w[:120] for w in self.wishes[-5:]))
        return "\n".join(lines)

    def message(self, text: str) -> bool:
        """Schickt Claude eine Nachricht in die laufende Arbeit. False, wenn das nicht (mehr) geht."""
        proc = getattr(self, "proc", None)
        if not self.live or proc is None or proc.poll() is not None:
            return False
        data = {"type": "user", "message": {"role": "user", "content": text}}
        try:
            proc.stdin.write(json.dumps(data, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError, AttributeError):
            return False
        self.sent += 1
        return True


@dataclass
class _Wish:
    """Georgs Wunsch während der Arbeit, als Zeile im Ablauf der Werkstatt."""

    id: str
    text: str
    state: str = "done"

    @property
    def label(self) -> str:
        return f"Ihr Wunsch: {self.text}"

    def to_dict(self) -> dict:
        return {"id": self.id, "tool": "Georg", "label": self.label, "detail": "", "kind": "message",
                "state": "done", "seconds": 0, "workshop": True}


class Workshop:
    """Führt immer nur einen Auftrag auf einmal aus, in einem eigenen Claude-Prozess."""

    def __init__(self, cfg: dict, brain, ui, announce: Callable[[str], None], show_window=None) -> None:
        self._cfg = cfg.get("werkstatt", {}) or {}
        self._brain = brain
        self._ui = ui
        self._announce = announce
        self._show_window = show_window
        base = str(self._cfg.get("ordner", "") or "").strip()
        # Immer ein absoluter Pfad: Claude arbeitet im Projektordner, relative Pfade zeigten dann ins Leere.
        self.base = (Path(base).expanduser() if base else Path.home() / "Jarvis-Werkstatt").resolve()
        self.job: Job | None = None
        self._proc: subprocess.Popen | None = None
        self._cancelled = False
        self._lock = threading.Lock()
        self._delete_offer: tuple[str, str, float] | None = None  # (Ordner, Name, gilt bis) nach "Wirklich löschen?"

    @property
    def busy(self) -> bool:
        return self.job is not None and self.job.state == "running"

    # ------------------------------------------------------------------ Wohin gehört ein Satz?

    def route(self, text: str, free: bool = True) -> str | None:
        """"new" = neuer Auftrag, "continue" = am letzten Projekt weiter, "tell" = ein Wunsch für die gerade
        laufende Arbeit, "run" = das fertige Ergebnis starten (Antwort auf "Soll ich es starten?"),
        None = nicht für die Werkstatt. free: kein anderer Sofort-Befehl hat den Satz erkannt (nur dann
        zählt er als Antwort oder Wunsch)."""
        job = self.job
        finished = job is not None and job.state != "running" and job.ended is not None
        since = time.monotonic() - job.ended if finished else 1e9
        if job is not None and job.state == "running":
            if is_continue_request(text) or is_change_request(text) or (free and is_wish(text)):
                return "tell"
            if is_workshop_request(text):
                return "new"  # start() sagt, dass noch gearbeitet wird
            return None
        if finished and job.start_offer and since < ANSWER_WINDOW and free:
            from .tool import confirmed

            if confirmed(text):
                return "run"
            job.start_offer = False  # etwas anderes gesagt: die Frage gilt nicht mehr
        if job is not None and is_continue_request(text):
            return "continue"
        if finished and free and job.question and since < ANSWER_WINDOW and looks_like_answer(text):
            return "continue"  # Antwort auf die Frage, mit der die Arbeit endete
        if finished and since < FOLLOW_UP_WINDOW and is_change_request(text):
            return "continue"
        if is_workshop_request(text):
            return "new"
        return None

    # ------------------------------------------------------------------ Aufträge

    def start(self, task: str) -> str:
        """Startet einen Auftrag im Hintergrund. Gibt den Satz zurück, den Jarvis dazu sagt."""
        with self._lock:
            if self.busy:
                return f"Ich arbeite noch am vorigen Auftrag, Sir. {self.job.status()}"
            if self._brain is None or not getattr(self._brain, "claude_path", ""):
                return "Für die Werkstatt brauche ich mein Gehirn, Sir. Bitte öffnen Sie einmal die Einstellungen."
            folder = project_folder(task, self.base)
            self.job = Job(task, folder, model=self._usable(choose_model(task, self._cfg.get("modell", "auto"))))
            self.job.effort = self._effort(task, self.job.model)
            self._cancelled = False
        self._begin(self.job)
        if self.job.model == "opus":
            return "Sehr wohl, Sir. Ein größeres Projekt, dafür nehme ich mein bestes Werkzeug. Sie können mir im Fenster zusehen."
        return "Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen."

    def follow_up(self, text: str, project: dict | None = None) -> str:
        """Am letzten (oder an einem genannten) Projekt weiter: derselbe Ordner, dieselbe Claude-Sitzung."""
        with self._lock:
            last = self.job
            if last is not None and last.state == "running":
                return "Ich bin noch mitten in der Arbeit, Sir. Sagen Sie es mir gleich, wenn ich fertig bin."
            if self._brain is None or not getattr(self._brain, "claude_path", ""):
                return "Für die Werkstatt brauche ich mein Gehirn, Sir. Bitte öffnen Sie einmal die Einstellungen."
            setting = self._cfg.get("modell", "auto")
            if project is not None and Path(project["folder"]).is_dir():
                model = choose_model(text, setting) if _SAYS_OPUS.search(text) else (project.get("model") or choose_model(text, setting))
                self.job = Job(text, Path(project["folder"]), session=project.get("session") or str(uuid.uuid4()),
                               resume=bool(project.get("session")), model=model)
            elif last is not None and last.folder.is_dir():
                model = choose_model(text, setting) if _SAYS_OPUS.search(text) else (last.model or choose_model(text, setting))
                self.job = Job(text, last.folder, session=last.session, resume=True, model=model)
            else:
                self.job = Job(text, project_folder(text, self.base), model=choose_model(text, setting))
            self.job.model = self._usable(self.job.model)
            self.job.effort = self._effort(text, self.job.model)
            self._cancelled = False
        self._begin(self.job)
        if self.job.resume:
            name = project_name(self.job.folder)
            return f"Sehr wohl, Sir. Ich mache am Projekt {name} weiter." if project else "Sehr wohl, Sir. Ich mache in der Werkstatt weiter."
        return "Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen."

    def _usable(self, model: str) -> str:
        """Ein Modell, das gerade geht: hat das Gehirn gemerkt, dass Opus (oder Fable) im Abo fehlt oder
        sein Kontingent leer ist, nimmt die Werkstatt gleich das nächstkleinere."""
        chooser = getattr(self._brain, "chooser", None)
        seen = set()
        while chooser is not None and model and model not in seen and chooser.blocked(model) and chooser.smaller(model):
            seen.add(model)
            model = chooser.smaller(model)
        return model

    def _block(self, model: str) -> None:
        """Dem Gehirn sagen, dass dieses Modell gerade nicht geht (gilt dann auch für Fragen)."""
        chooser = getattr(self._brain, "chooser", None)
        if chooser is not None:
            chooser.block(model, 6 * 3600, "nicht verfügbar")

    def _effort(self, task: str, model: str) -> str:
        return choose_effort(task, model, self._cfg.get("modell", "auto"), self._cfg.get("effort", "medium"))

    def tell(self, text: str) -> str:
        """Ein Wunsch während der Arbeit ("Mach den Hintergrund blau"): geht sofort in die laufende Arbeit."""
        with self._lock:
            job = self.job
            if job is None or job.state != "running":
                return self.follow_up(text) if job is not None else self.start(text)
            sent = job.message(f"Georg, während du arbeitest: {text}")
            if sent:
                wish = _Wish(f"wunsch-{len(job.wishes) + 1}", text.strip()[:300])
                job.wishes.append(wish.text)
                job.steps.append(wish)
        if not sent:
            return "Ich bin noch mitten in der Arbeit, Sir. Sagen Sie es mir gleich, wenn ich fertig bin."
        self._ui.progress(wish.to_dict())
        log.info("Werkstatt, Wunsch während der Arbeit: %s", text)
        return random.choice(["Sehr wohl, Sir. Ich baue das gleich mit ein.", "Notiert, Sir. Das kommt mit hinein.",
                              "Verstanden, Sir. Ich berücksichtige das."])

    def context(self) -> str:
        """Für das Gehirn: was in der Werkstatt gerade läuft (leer, wenn nichts läuft)."""
        job = self.job
        if job is None or job.state != "running":
            return ""
        return ("<werkstatt>\n" + job.context() + "\nFragt Georg nach der Arbeit, antworte kurz aus diesem Stand (bei "
                "Bedarf liest du Dateien im Projektordner). Will er am Projekt etwas ändern, gib es mit "
                "python -m jarvis.tool werkstatt-weiter \"<Wunsch>\" an die laufende Arbeit weiter und sag nur kurz, "
                "dass du es einbaust.\n</werkstatt>")

    def run_last(self) -> str:
        """Das Ergebnis des letzten Auftrags starten (start.bat)."""
        job = self.job
        if job is None:
            return "In der Werkstatt gibt es noch nichts zu starten, Sir."
        job.start_offer = False
        start = job.folder / "start.bat"
        if not start.is_file():
            return f"{project_name(job.folder)} hat keine start.bat, Sir."
        try:
            _start_file(start, job.folder)
        except OSError as exc:
            log.info("Start von %s: %s", job.folder, exc)
            return f"Das Starten ging leider nicht, Sir: {exc}"
        return random.choice([f"{project_name(job.folder)} startet, Sir.", "Bitte sehr, Sir. Es startet."])

    # ------------------------------------------------------------------ Projekte

    def projects(self) -> list[dict]:
        """Alle Projekte in der Werkstatt, das zuletzt bearbeitete zuerst."""
        try:
            folders = [f for f in self.base.iterdir() if f.is_dir()]
        except OSError:
            return []
        found = [p for p in (read_project(f) for f in folders) if p]
        job = self.job
        for item in found:
            if job is not None and Path(item["folder"]) == job.folder and job.state == "running":
                item["state"] = "running"
        return sorted(found, key=lambda p: p.get("updated", ""), reverse=True)

    def find_project(self, words: str) -> dict | None:
        """Das Projekt, dessen Name oder Auftrag am besten zu den Wörtern passt ("Discord-Bot")."""
        wanted = [w for w in re.findall(r"[a-zäöüß0-9]+", words.lower()) if len(w) > 1 and w not in _PROJECT_FILL]
        if not wanted:
            return None
        best, best_score = None, 0.0
        for item in self.projects():
            name = item["name"].lower().replace("ae", "ä").replace("oe", "ö").replace("ue", "ü") + " " + item["name"].lower()
            hay = name + " " + item["task"].lower()
            score = sum(2 if w in name else 1 if w in hay else 0 for w in wanted) / len(wanted)
            if score > best_score:
                best, best_score = item, score
        return best if best_score >= 1.0 else None

    def project_command(self, text: str) -> str | None:
        """"Welche Projekte habe ich?", "Arbeite am Discord-Bot weiter: ...", "Öffne den Ordner vom
        Discord-Bot", "Starte das Projekt Discord-Bot", "Zeig mir das Projekt Würfelspiel", "Lösch das
        Projekt Würfelspiel" (mit Rückfrage). None = kein Projekt-Befehl."""
        answer = self._answer_delete(text)
        if answer is not None:
            return answer
        found = match_project(text)
        if found is None:
            return None
        action = found[0]
        if action == "list":
            items = self.projects()
            self._ui.workshop({"state": "projects"})
            if self._show_window is not None:
                try:
                    self._show_window()
                except Exception:
                    pass
            if not items:
                return "Die Werkstatt ist noch leer, Sir. Sagen Sie einfach, was ich bauen soll."
            names = [p["name"] for p in items[:3]]
            more = f" und {len(items) - 3} weitere" if len(items) > 3 else ""
            listed = ", ".join(names[:-1]) + " und " + names[-1] if len(names) > 1 else names[0]
            return f"{len(items)} Projekt{'e' if len(items) != 1 else ''}, Sir. Zuletzt: {listed}{more}. Die Liste ist im Fenster."
        project = self.find_project(found[1])
        if project is None and found[1] in _LAST_WORDS:
            items = self.projects()
            project = items[0] if items else None
        if project is None:
            if re.search(r"\b(?:projekt|werkstatt)\b", _norm(text)):
                return f"Ein Projekt namens {found[1]} finde ich nicht, Sir."
            return None  # "Mach mit der Musik weiter", "Öffne den Ordner von Steam": kein Werkstatt-Projekt
        if action == "continue":
            return self.follow_up(text, project)
        if action == "show":
            return self.show_project(project)
        if action == "delete":
            return self._offer_delete(project)
        folder = Path(project["folder"])
        try:
            if action == "open":
                _start_file(folder)
                return f"Der Ordner von {project['name']} ist offen, Sir."
            if not (folder / "start.bat").is_file():
                return f"{project['name']} hat noch keine start.bat, Sir. Sagen Sie: Arbeite am {project['name']} weiter und leg eine Startdatei an."
            _start_file(folder / "start.bat", folder)
            return f"{project['name']} startet, Sir."
        except OSError as exc:
            log.info("Projekt %s: %s", action, exc)
            return f"Das ging leider nicht, Sir: {exc}"

    def _inside(self, folder) -> Path | None:
        """Ein Projektordner direkt in der Werkstatt (mit Projektkarte), sonst None."""
        try:
            target = Path(str(folder or "")).resolve()
            base = Path(self.base).resolve()
        except (OSError, ValueError):
            return None
        if not str(folder or "").strip() or target.parent != base or not target.is_dir():
            return None
        return target if read_project(target) is not None else None

    def _is_live(self, target: Path) -> bool:
        job = self.job
        try:
            return job is not None and job.folder.resolve() == target
        except OSError:
            return False

    def project_view(self, folder) -> dict | None:
        """Ein Projekt zum Ansehen in der Werkstatt: Auftrag, Plan, Ablauf, Dateien, Logo, Verlauf.
        Der gerade laufende (oder letzte) Auftrag kommt mit live = True und dem ganzen Stand."""
        target = self._inside(folder)
        if target is None:
            return None
        info = read_project(target) or {}
        if self._is_live(target):
            snap = self.snapshot() or {}
            snap.update(live=True, history=info.get("history", []), start=info.get("start", False),
                        preview=bool(preview_page(target)), files=project_files(target), created=info.get("created", ""))
            return snap
        try:
            protocol = json.loads((target / "werkstatt-protokoll.json").read_text(encoding="utf-8"))
            if not isinstance(protocol, dict):
                protocol = {}
        except (OSError, ValueError):
            protocol = {}
        try:
            card = json.loads((target / PROJECT_FILE).read_text(encoding="utf-8"))
            seconds = int(card.get("dauer") or 0) if isinstance(card, dict) else 0
        except (OSError, ValueError, TypeError):
            seconds = 0
        state = info.get("state") if info.get("state") in ("done", "error", "cancelled") else "cancelled"
        steps = [dict(s, workshop=True) for s in protocol.get("schritte") or [] if isinstance(s, dict) and s.get("id")]
        todos = [t for t in protocol.get("plan") or [] if isinstance(t, dict)]
        info.update(
            live=False, state=state, steps=steps[-200:], todos=todos[:40], logo=project_logo(target),
            begun=_short_date(info.get("created", "")), seconds=seconds, detail="", text="",
            preview=bool(preview_page(target)), files=project_files(target),
        )
        return info

    def show_project(self, project: dict) -> str:
        """\"Zeig mir das Projekt Würfelspiel\": das Projekt in der Werkstatt-Ansicht im Fenster."""
        self._ui.workshop({"state": "project", "folder": project["folder"], "name": project["name"]})
        if self._show_window is not None:
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Werkstatt-Fenster: %s", exc)
        return random.choice([f"Hier ist {project['name']}, Sir.", f"Bitte sehr, Sir: {project['name']}."])

    def _offer_delete(self, project: dict) -> str:
        target = self._inside(project["folder"])
        if target is None:
            return f"{project['name']} gibt es schon nicht mehr, Sir."
        if self.busy and self._is_live(target):
            return f"An {project['name']} arbeite ich gerade, Sir. Sagen Sie erst: Werkstatt stopp."
        self._delete_offer = (str(target), project["name"], time.monotonic() + DELETE_WINDOW)
        if self.job is not None:
            self.job.start_offer = False  # das nächste \"Ja\" gilt dem Löschen
        return f"Soll ich {project['name']} wirklich löschen, Sir? Es kommt in den Papierkorb."

    def _answer_delete(self, text: str) -> str | None:
        """Georgs Antwort auf \"Soll ich ... wirklich löschen?\". None = keine Antwort darauf."""
        offer, self._delete_offer = self._delete_offer, None
        if offer is None or time.monotonic() > offer[2]:
            return None
        from .tool import confirmed

        if confirmed(text):
            result = self.delete_project(offer[0])
            if result["ok"]:
                where = "liegt jetzt im Papierkorb" if result["trash"] else "ist gelöscht"
                return f"{offer[1]} {where}, Sir."
            return f"Das Löschen ging leider nicht, Sir. {result['error']}".strip()
        if re.match(r"^(?:nein|nö|nee|ne|lieber nicht|doch nicht|abbrechen|lass(?: es| mal)?|nicht löschen)\b", _norm(text)):
            return "Sehr wohl, Sir. Das Projekt bleibt."
        return None

    def delete_project(self, folder) -> dict:
        """Löscht ein Werkstatt-Projekt (unter Windows in den Papierkorb, von dort lässt es sich
        wiederherstellen). {"ok", "name", "trash", "error"}. Nie den Ordner, an dem gerade gearbeitet wird."""
        target = self._inside(folder)
        if target is None:
            return {"ok": False, "name": "", "trash": False, "error": "Das Projekt gibt es nicht mehr."}
        name = (read_project(target) or {}).get("name") or project_name(target)
        with self._lock:
            if self.busy and self._is_live(target):
                return {"ok": False, "name": name, "trash": False,
                        "error": "Daran arbeitet die Werkstatt gerade. Erst stoppen, dann löschen."}
            try:
                trash = _remove(target)
            except OSError as exc:
                log.info("Projekt löschen %s: %s", target, exc)
                return {"ok": False, "name": name, "trash": False, "error": f"Windows sagt: {exc}"}
            if self._is_live(target) or (self.job is not None and not self.job.folder.exists()):
                self.job = None  # \"Mach weiter\" soll nicht in einen gelöschten Ordner führen
        log.info("Werkstatt-Projekt gelöscht (%s): %s", "Papierkorb" if trash else "endgültig", target)
        self._ui.workshop({"state": "deleted", "folder": str(target), "name": name})
        return {"ok": True, "name": name, "trash": trash, "error": ""}

    def _save_project(self, job: Job, state: str) -> None:
        """projekt.json im Projektordner: Name, Auftrag, Stand, Sitzung, Verlauf."""
        path = job.folder / PROJECT_FILE
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        now = dt.datetime.now().isoformat(timespec="minutes")
        data.setdefault("name", project_name(job.folder))
        data.setdefault("auftrag", job.task)
        data.setdefault("erstellt", now)
        data.update(zuletzt=now, zustand=state, sitzung=job.session, modell=job.model)
        if state != "running":
            data["zusammenfassung"] = job.summary
            data["frage"] = job.question
            if job.ended is not None:
                data["dauer"] = round(job.ended - job.started)
        history = data.setdefault("verlauf", [])
        if state == "running":
            history.append({"zeit": now, "wunsch": job.task[:500], "zustand": "running"})
        elif history and history[-1].get("zustand") == "running":
            history[-1]["zustand"] = state
        del history[:-50]
        try:
            job.folder.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            log.debug("Projektkarte: %s", exc)

    def _begin(self, job: Job) -> None:
        self._save_project(job, "running")
        job.logo = project_logo(job.folder)  # am selben Projekt weiter: das Logo ist schon da
        self._ui.workshop({"state": "start", "task": job.task, "folder": str(job.folder), "begun": job.begun,
                           "continues": job.resume, "model": job.model, "name": project_name(job.folder),
                           "logo": job.logo})
        if self._show_window is not None:
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Werkstatt-Fenster: %s", exc)
        threading.Thread(target=self._work, args=(job,), name="jarvis-werkstatt", daemon=True).start()

    def forget_question(self) -> None:
        """Georg hat nach der Rückfrage etwas anderes gesagt: die Frage gilt nicht mehr."""
        if self.job is not None and self.job.state != "running":
            self.job.question = ""

    def take_handoff(self, state_dir: Path) -> bool:
        """Holt einen Auftrag ab, den das Gehirn über jarvis.tool übergeben hat. True = gestartet."""
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
        task = str(data.get("auftrag") or "").strip()
        if not task or age > 120:
            return False
        log.info("Werkstatt-Auftrag vom Gehirn: %s", task)
        project = self.find_project(str(data.get("projekt") or "")) if data.get("projekt") else None
        if self.busy and (data.get("weiter") or (project is not None and Path(project["folder"]) == self.job.folder)):
            said = self.tell(task)  # ein Wunsch für die laufende Arbeit
        else:
            said = self.follow_up(task, project) if data.get("weiter") or project else self.start(task)
        if said.startswith("Ich ") or said.startswith("Für "):
            self._announce(said)  # noch beschäftigt oder kein Gehirn: das soll Georg hören
        return True

    def cancel(self) -> bool:
        job = self.job
        if job is None or job.state != "running":
            return False
        self._cancelled = True
        proc = self._proc
        if proc is not None and proc.poll() is None:
            from .brain import _kill

            _kill(proc)
        return True

    def snapshot(self) -> dict | None:
        """Der ganze Stand für das Fenster (wenn es neu lädt oder Ereignisse verpasst hat)."""
        job = self.job
        if job is None:
            return None
        ended = job.ended if job.state != "running" else None
        return {
            "task": job.task, "folder": str(job.folder), "state": job.state, "begun": job.begun,
            "seconds": round((ended or time.monotonic()) - job.started),
            "todos": list(job.todos), "steps": [s.to_dict() for s in job.steps[-200:]],
            "text": job.text[-4000:], "summary": job.summary, "detail": job.detail,
            "model": job.model, "name": project_name(job.folder), "logo": job.logo,
        }

    def status(self) -> str:
        if self.job is None:
            return "In der Werkstatt ist gerade nichts los, Sir."
        if self.job.state == "running":
            return self.job.status()
        return f"Der letzte Auftrag ist {'fertig' if self.job.state == 'done' else 'abgebrochen'}, Sir. {self.job.summary}".strip()

    # ------------------------------------------------------------------ Arbeit

    def _persona(self, job: Job) -> Path:
        brain = self._brain
        base = Path(getattr(brain, "persona_path", "") or "")
        text = base.read_text(encoding="utf-8") if base.is_file() else "Du bist Jarvis, Georgs Assistent."
        python = project_python() or "nicht gefunden, dann mit winget install Python.Python.3.12 installieren"
        hints = (WINDOWS_HINTS if os.name == "nt" else OTHER_HINTS).format(python=python)
        prompt = WORKSHOP_PROMPT.format(folder=job.folder, platform=hints)
        if job.resume:
            prompt += FOLLOW_UP_PROMPT
        path = (Path(getattr(brain, "state_dir", job.folder) or job.folder) / "werkstatt-persoenlichkeit.md").resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + prompt, encoding="utf-8")
        return path

    def command(self, job: Job, persona: Path) -> list[str]:
        """Der Claude-Aufruf. Kennt die Claude-Version eine Option nicht, lässt Jarvis sie weg
        (dieselbe Liste wie beim Gehirn: brain._unsupported)."""
        brain = self._brain
        unsupported = set(getattr(brain, "_unsupported", set()) or set())
        model = job.model or choose_model(job.task, self._cfg.get("modell", "auto"))
        effort = job.effort or self._effort(job.task, model)
        cmd = [brain.claude_path, "-p", "--output-format", "stream-json", "--verbose"]
        if "include-partial-messages" not in unsupported:
            cmd.append("--include-partial-messages")
        if "input-format" not in unsupported:
            cmd += ["--input-format", "stream-json"]  # Georgs Wünsche während der Arbeit
            if "permission-prompt-tool" not in unsupported:
                # Rückfragen (Konnektoren für Logo, Deploy ...) an Jarvis statt still abgelehnt, siehe brain.live_flags
                cmd += ["--permission-prompt-tool", "stdio"]
        if model:
            cmd += ["--model", model]
        if effort and "effort" not in unsupported:
            cmd += ["--effort", effort]
        if getattr(brain, "isolated", True):
            flags = getattr(brain, "isolation_flags", None)
            if flags is not None:
                cmd += flags()  # ohne Georgs Einstellungen, aber mit seinen Konnektoren (Logo, Deploy ...)
            elif "safe-mode" not in unsupported:
                cmd.append("--safe-mode")
        if "system-prompt-file" in unsupported:
            cmd += ["--append-system-prompt", persona.read_text(encoding="utf-8")[-12000:]]
        else:
            cmd += ["--system-prompt-file", str(persona)]
        if "tools" not in unsupported:
            cmd += ["--tools", *WORKSHOP_TOOLS]
        cmd += ["--allowedTools", *WORKSHOP_TOOLS]
        disallowed = list(getattr(brain, "disallowed_tools", []) or [])
        if disallowed:
            cmd += ["--disallowedTools", *disallowed]
        cmd += ["--permission-mode", "acceptEdits", "--add-dir", str(job.folder)]
        if job.resume:
            cmd += ["--resume", job.session]
        elif "session-id" not in unsupported:
            cmd += ["--session-id", job.session]
        return cmd

    def environment(self, job: Job) -> dict:
        """Wie beim Gehirn, dazu: "python" zeigt auf ein echtes Python (unter Windows sonst oft nur
        der Platzhalter aus dem Microsoft Store), und Python-Programme geben Umlaute aus, ohne
        an der Windows-Konsole (cp1252) abzustürzen."""
        env = self._brain.environment(job.task)
        python = project_python()
        if python:
            folder = Path(python).parent
            extra = [str(folder), str(folder / "Scripts")] if os.name == "nt" else [str(folder)]
            env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
            env["JARVIS_PYTHON"] = python
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["JARVIS_WERKSTATT"] = "1"  # jarvis.tool werkstatt weiß dann: schon in der Werkstatt
        return env

    def _work(self, job: Job) -> None:
        from .brain import UNKNOWN_OPTION

        try:
            job.folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self._finish(job, "error", f"Den Projektordner konnte ich nicht anlegen, Sir. {exc}")
            return
        for _ in range(5):
            try:
                persona = self._persona(job)
                outcome = self._run(job, persona)
            except Exception as exc:
                log.exception("Werkstatt startet nicht")
                self._finish(job, "error", f"Die Werkstatt ließ sich nicht starten, Sir. {exc}", str(exc))
                return
            stream, stderr, timed_out = outcome
            result = stream.result or {}
            if job.model in ("opus", "fable") and result.get("is_error") and re.search(
                    r"model.*(?:not (?:available|found|supported)|invalid|access)|(?:opus|fable).*(?:pro|plan|upgrade)|"
                    r"usage limit|limit reached",
                    str(result.get("result", "")), re.I):
                smaller = "opus" if job.model == "fable" else "sonnet"
                log.warning("Werkstatt: %s geht mit diesem Konto gerade nicht, nehme %s.", job.model, smaller)
                self._block(job.model)
                job.model = smaller
                job.resume = False
                job.session = str(uuid.uuid4())
                job.steps.clear()
                job.text = ""
                continue
            if self._cancelled or timed_out or stream.result is not None:
                break
            unknown = UNKNOWN_OPTION.search(stderr or "")
            unsupported = getattr(self._brain, "_unsupported", None)
            if unknown and isinstance(unsupported, set) and unknown.group(1) not in unsupported:
                unsupported.add(unknown.group(1))  # gilt dann auch fürs Gehirn
                log.warning("Werkstatt: Claude kennt --%s nicht, ohne diese Option nochmal.", unknown.group(1))
                continue
            failure = f"{stderr or ''} {(stream.result or {}).get('result', '') if stream.result else ''}"
            if job.model in ("opus", "fable") and re.search(
                    r"model.*(?:not (?:available|found|supported)|invalid|access)|"
                    r"(?:not (?:available|allowed)|no access).*model|(?:opus|fable).*(?:pro|plan|upgrade)",
                    failure, re.I):
                smaller = "opus" if job.model == "fable" else "sonnet"
                log.warning("Werkstatt: %s geht mit diesem Konto nicht, nehme %s.", job.model, smaller)
                self._block(job.model)
                job.model = smaller
                job.resume = False
                job.session = str(uuid.uuid4())
                continue
            if job.resume and re.search(r"no conversation found|session.*not found", stderr or "", re.I):
                # Die alte Sitzung gibt es nicht mehr: im selben Ordner neu anfangen.
                job.resume = False
                job.session = str(uuid.uuid4())
                continue
            break

        if self._cancelled:
            self._finish(job, "cancelled", "Die Arbeit in der Werkstatt ist abgebrochen, Sir.")
            return
        if timed_out:
            self._finish(job, "error", "In der Werkstatt hat sich zu lange nichts getan, Sir. Ich habe abgebrochen.")
            return
        result = stream.result or {}
        if not result or result.get("is_error"):
            detail = str(result.get("result") or stderr or "keine Ausgabe").strip()[-1500:]
            log.warning("Werkstatt-Fehler: %s", detail)
            self._finish(job, "error", _explain(detail), detail)
            return
        summary = str(result.get("result") or job.text).strip()
        self._finish(job, "done", summary)

    def _run(self, job: Job, persona: Path):
        """Ein Claude-Lauf. Gibt (Stream, stderr, zu lange still) zurück. Mit --input-format stream-json bleibt
        stdin offen: Georgs Wünsche während der Arbeit kommen als weitere Nachrichten dazu (Job.message).
        Fertig ist der Lauf, wenn auf jede Nachricht eine Antwort kam, oder wenn nach der letzten Antwort
        eine Weile nichts mehr passiert (dann war der Wunsch schon in der Arbeit drin)."""
        from .brain import _close, _kill, _pump, _StreamReader, with_time

        started = time.monotonic()
        cmd = self.command(job, persona)
        live = "--input-format" in cmd
        log.info("Werkstatt %s in %s (%s, Nachdenken %s): %s", "weiter" if job.resume else "startet", job.folder,
                 job.model or "Standard", job.effort or "Standard", job.task)
        # Auf einem unsichtbaren Arbeitsplatz (eigener Windows-Desktop): Was Claude zum Testen startet,
        # öffnet seine Fenster dort und nicht auf Georgs Bildschirm (versteckt.py).
        proc = versteckt.popen(cmd, cwd=job.folder, env=self.environment(job),
                               hidden=bool(self._cfg.get("unsichtbar", True)))
        self._proc = proc
        lines: queue.Queue = queue.Queue()
        errors: list = []
        threading.Thread(target=_pump, args=(proc.stdout, lines.put), daemon=True).start()
        err_reader = threading.Thread(target=_pump, args=(proc.stderr, errors.append), daemon=True)
        err_reader.start()
        with self._lock:
            job.proc, job.live, job.sent, job.results = proc, live, 0, 0
            if live:
                live = job.message(with_time(job.task))
                job.live = live
        if not live:
            try:
                proc.stdin.write(with_time(job.task))
            except OSError:
                pass
            finally:
                _close(proc.stdin)

        def on_text(chunk: str) -> None:
            job.text += chunk
            self._ui.workshop({"state": "text", "text": job.text[-4000:]})

        def on_step(step) -> None:
            if step.todos is not None:
                job.todos = step.todos
            if step not in job.steps:
                job.steps.append(step)
            data = step.to_dict()
            data["workshop"] = True
            self._ui.progress(data)
            if step.state != "running":
                self._check_logo(job, LOGO_FILE in str(step.detail).lower())

        stream = _StreamReader(on_text, partial=True, on_step=on_step)
        quiet_limit = float(self._cfg.get("still_minuten", 12)) * 60
        total_limit = float(self._cfg.get("max_minuten", 60)) * 60
        last = time.monotonic()
        exited_at = None
        timed_out = False
        final: dict | None = None
        waiting_since = None  # eine Antwort ist da, Georg hat aber noch etwas geschickt

        def finish_input() -> None:
            with self._lock:
                job.live = False
            _close(proc.stdin)

        while True:
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                now = time.monotonic()
                if waiting_since is not None and not stream.running and now - last > AFTER_RESULT:
                    # Seit der Antwort ist es still (und kein Werkzeug läuft, eine Installation darf dauern):
                    # der Wunsch war schon in der letzten Antwort enthalten
                    finish_input()
                    break
                if now - last > quiet_limit or now - started > total_limit:
                    timed_out = True
                    _kill(proc)
                    break
                if proc.poll() is None:
                    continue
                exited_at = exited_at or now
                if now - exited_at > 1.0:
                    break
                continue
            if line is None:
                break
            last = time.monotonic()
            if konnektoren.answer(proc, line, getattr(self._brain, "connectors", False)):
                continue  # Claude fragt, ob es einen Konnektor benutzen darf
            stream.feed(line)
            if stream.result is None:
                continue
            final, stream.result = stream.result, None
            with self._lock:
                job.results += 1
                more = live and job.live and job.results < job.sent and not final.get("is_error")
                if not more:
                    job.live = False  # im selben Schritt: ein Wunsch, der jetzt noch käme, ginge sonst verloren
            if not more:
                if live:
                    finish_input()
                break
            waiting_since = time.monotonic()  # auf die Antwort zu Georgs Wunsch warten
        stream.result = final
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _kill(proc)
        err_reader.join(timeout=1.0)
        with self._lock:
            job.live = False
            job.proc = None
        self._proc = None
        return stream, "".join(e for e in errors if e), timed_out

    def _check_logo(self, job: Job, touched: bool = False) -> None:
        """Hat die Werkstatt ihr Logo gezeichnet (oder es eben geändert), zeigt das Fenster es als
        Hologramm. Solange es keins gibt, wird nach jedem Schritt kurz nachgesehen."""
        if job.logo and not touched:
            return
        logo = project_logo(job.folder)
        if logo and logo != job.logo:
            job.logo = logo
            self._ui.workshop({"state": "logo", "logo": logo})

    def _finish(self, job: Job, state: str, summary: str, detail: str = "") -> None:
        from .text import speakable

        self._check_logo(job, touched=True)  # zuletzt per Befehl geändert? Dann jetzt das neue
        job.summary = speakable(summary) or summary
        job.detail = detail
        job.ended = time.monotonic()
        sentences = re.split(r"(?<=[.!?])\s+", job.summary.strip())
        last = sentences[-1].strip() if sentences else ""
        job.question = last if state == "done" and last.endswith("?") else ""
        seconds = round(job.ended - job.started)
        self._ui.workshop({
            "state": state, "summary": summary, "detail": detail, "folder": str(job.folder), "seconds": seconds,
            "question": job.question,
        })
        log.info("Werkstatt %s nach %d s: %s", state, seconds, summary[:300])
        save_log(job, state)
        self._save_project(job, state)
        spoken = job.summary
        if state == "done":
            first = re.split(r"(?<=[.!?])\s+", spoken)
            spoken = " ".join(first[:3])
            if job.question and job.question not in spoken:
                spoken = f"{spoken} {job.question}"
            elif not job.question and (job.folder / "start.bat").is_file():
                job.start_offer = True  # "Ja" startet es (route -> "run")
                spoken = f"{spoken} Soll ich es gleich starten?"
            spoken = f"Aus der Werkstatt: {spoken}"
        self._announce(spoken)
        job.state = state  # erst jetzt: wer auf das Ende wartet, hat dann auch die Ansage


_PROJECT_FILL = {"das", "den", "die", "der", "dem", "projekt", "projekts", "am", "an", "beim", "bei", "mit", "von",
                 "vom", "mein", "meinem", "meinen", "meine", "weiter", "ordner", "werkstatt", "in", "im", "zum", "zur"}

# "Welche Projekte habe ich?", "Zeig mir meine Projekte"
_LIST = re.compile(r"^(?:welche|was für) projekte\b|^(?:zeig|zeige|öffne)(?: mir)? (?:meine |alle |die )?(?:werkstatt[- ]?)?projekte\b|"
                   r"^was (?:hast du|haben wir)(?: (?:schon|alles))* (?:in der werkstatt )?gebaut\b|^(?:öffne|zeig|zeige)(?: mir)? (?:die )?werkstatt$")
# "Arbeite am Discord-Bot weiter: füg einen Befehl hinzu", "Mach beim Projekt Würfelspiel weiter, ..."
_CONTINUE_NAMED = re.compile(
    r"^(?:mach|mache|arbeite|arbeit)\s+(?:am|beim|an dem|an der|an|mit dem|mit der|bei dem|bei der)\s+(?:projekt\s+)?"
    r"(?P<name>.+?)\s+weiter\b[\s,:.-]*(?P<rest>.*)$")
# "Öffne den Ordner vom Discord-Bot"
_OPEN_PROJECT = re.compile(r"^(?:öffne|zeig|zeige)(?: mir)? den ordner (?:vom|von dem|von der|des)(?: projekt)?\s+(?P<name>.+)$")
# "Zeig mir das Projekt Würfelspiel", "Öffne das Projekt Discord-Bot", "Zeig mir den Discord-Bot aus der Werkstatt",
# "Zeig mir das letzte Projekt": das Projekt im Fenster ansehen
_SHOW_PROJECT = re.compile(
    r"^(?:öffne|zeig|zeige|lade|hol|hole)(?: mir)? (?:(?:das|dein|mein) projekt\s+(?P<a>.+)|"
    r"(?:den|das|die)\s+(?P<b>.+?)\s+aus der werkstatt|das\s+(?P<c>[^ ]+?)[- ]projekt)(?: an| her| auf)?$")
# "Lösch das Projekt Würfelspiel", "Entferne den Discord-Bot aus der Werkstatt", "Lösch das letzte Projekt"
_DELETE_PROJECT = re.compile(
    r"^(?:lösch|lösche|entfern|entferne|schmeiß|schmeiss|wirf)(?: mir)?\s+(?:(?:das|mein) projekt\s+(?P<a>.+?)|"
    r"(?:den|das|die)\s+(?P<b>.+?)\s+aus der werkstatt|das\s+(?P<c>[^ ]+?)[- ]projekt)(?: weg| raus)?$")
_LAST_WORDS = {"letzte", "letzten", "neueste", "neuesten", "aktuelle", "aktuellen"}
# "Starte das Projekt Discord-Bot", "Starte den Discord-Bot aus der Werkstatt"
_RUN_PROJECT = re.compile(r"^(?:starte|start|führ|führe)\s+(?:das projekt\s+(?P<a>.+?)|(?:den|das|die)\s+(?P<b>.+?)\s+aus der werkstatt)(?: aus)?$")


def match_project(text: str):
    """("list", "") / ("continue", name, rest) / ("open", name) / ("run", name) oder None."""
    norm = _norm(text)
    if _LIST.search(norm):
        return ("list", "")
    found = _CONTINUE_NAMED.match(norm)
    if found and found.group("name") not in ("projekt", "letzten projekt", "der werkstatt", "dem projekt"):
        return ("continue", found.group("name"), found.group("rest").strip())
    found = _OPEN_PROJECT.match(norm)
    if found:
        return ("open", found.group("name"))
    found = _DELETE_PROJECT.match(norm)
    if found:
        return ("delete", _project_words(found))
    found = _SHOW_PROJECT.match(norm)
    if found:
        return ("show", _project_words(found))
    found = _RUN_PROJECT.match(norm)
    if found:
        return ("run", found.group("a") or found.group("b"))
    return None


def _project_words(found) -> str:
    name = (found.group("a") or found.group("b") or found.group("c") or "").strip()
    return "letzte" if re.fullmatch(r"(?:das |den )?(?:letzte|letzten|neueste|neuesten)(?: projekt)?", name) else name


def _short_date(iso: str) -> str:
    """\"2026-10-01T15:30\" -> \"01.10. 15:30\" (für das Schriftfeld)."""
    try:
        return dt.datetime.fromisoformat(str(iso)).strftime("%d.%m. %H:%M")
    except ValueError:
        return ""


# Was beim Ansehen eines Projekts nicht als Datei zählt: Umgebungen, Pakete, Zwischenstände
_SKIP_DIRS = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".idea", ".vscode", "dist", "build",
              ".mypy_cache", ".pytest_cache"}
_SKIP_FILES = {PROJECT_FILE, "werkstatt-protokoll.json"}


def project_files(folder: Path, limit: int = 80) -> list[dict]:
    """Die Dateien eines Projekts (ohne Umgebungen und Jarvis' eigene Karten), die neuesten zuerst."""
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if name in _SKIP_FILES or name.startswith("."):
                continue
            path = Path(root) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            found.append((stat.st_mtime, {"path": str(path), "size": stat.st_size}))
            if len(found) > 2000:
                break
    found.sort(key=lambda item: item[0], reverse=True)
    return [item for _, item in found[:limit]]


def preview_page(folder: Path) -> Path | None:
    """Eine Webseite im Projekt zum Ansehen im Browser: index.html, sonst die einzige .html-Datei."""
    folder = Path(folder)
    for name in ("index.html", "index.htm"):
        if (folder / name).is_file():
            return folder / name
    try:
        pages = [p for p in folder.iterdir() if p.suffix.lower() in (".html", ".htm") and p.is_file()]
    except OSError:
        return None
    return pages[0] if len(pages) == 1 else None


def _writable(func, path, _exc) -> None:
    """Schreibgeschützte Dateien (z. B. in .git) beim endgültigen Löschen trotzdem entfernen."""
    try:
        os.chmod(path, 0o700)
        func(path)
    except OSError:
        pass


def _to_recycle_bin(path: Path) -> bool:
    """Windows: in den Papierkorb (SHFileOperationW mit FOF_ALLOWUNDO), ohne Rückfrage-Fenster."""
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    fo_delete, silent, no_confirm, allow_undo, no_error_ui = 0x3, 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW(None, fo_delete, str(path) + "\0", None, allow_undo | no_confirm | silent | no_error_ui,
                         False, None, None)
    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))  # type: ignore[attr-defined]
    if code != 0 or op.fAnyOperationsAborted:
        log.info("Papierkorb ging nicht (%s) für %s", code, path)
    return not path.exists()


def _remove(path: Path) -> bool:
    """Löscht einen Projektordner. True = im Papierkorb, False = endgültig gelöscht. OSError, wenn es nicht geht."""
    import shutil

    if RECYCLE_BIN:
        try:
            if _to_recycle_bin(path):
                return True
        except (OSError, AttributeError, ValueError) as exc:
            log.info("Papierkorb: %s", exc)
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_writable)
    else:
        shutil.rmtree(path, onerror=_writable)
    if path.exists():
        raise OSError("Einige Dateien sind noch in Benutzung. Ist das Programm noch offen?")
    return False


def _start_file(path: Path, cwd: Path | None = None) -> None:
    """Öffnet einen Ordner oder startet eine Datei wie ein Doppelklick."""
    if os.name == "nt":
        if cwd is not None:
            os.startfile(str(path), cwd=str(cwd))  # type: ignore[call-arg]
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
        return
    subprocess.Popen(["xdg-open", str(path)], cwd=str(cwd) if cwd else None,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _explain(detail: str) -> str:
    """Ein verständlicher Satz zu einem Werkstatt-Fehler."""
    low = detail.lower()
    if re.search(r"not logged in|please run /login|invalid api key|authentication|unauthori", low):
        return "Claude ist für die Werkstatt nicht angemeldet, Sir. Bitte einmal die Einstellungen öffnen, Bereich Gehirn."
    if re.search(r"usage limit|rate limit|limit reached|credit balance|overloaded", low):
        return "Das Claude-Kontingent ist gerade erschöpft, Sir. Versuchen Sie es etwas später noch einmal."
    if re.search(r"unknown option|unrecognized", low):
        return "Diese Claude-Version ist zu alt für die Werkstatt, Sir. Bitte einmal 'claude update' ausführen."
    return "In der Werkstatt ist etwas schiefgegangen, Sir. Die Einzelheiten stehen im Fenster."


def hand_over(state_dir: Path, task: str, continue_last: bool = False, project: str = "") -> Path:
    """Für jarvis.tool: einen Auftrag an die laufende Werkstatt übergeben."""
    path = Path(state_dir) / HANDOFF
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"auftrag": task, "weiter": continue_last, "projekt": project,
            "zeit": dt.datetime.now().isoformat(timespec="seconds")}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def save_log(job: Job, state: str = "") -> None:
    """Schreibt den Ablauf in den Projektordner (werkstatt-protokoll.json)."""
    try:
        data = {"auftrag": job.task, "zustand": state or job.state, "zusammenfassung": job.summary,
                "schritte": [s.to_dict() for s in job.steps], "plan": job.todos, "sitzung": job.session}
        (job.folder / "werkstatt-protokoll.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        log.debug("Werkstatt-Protokoll: %s", exc)
