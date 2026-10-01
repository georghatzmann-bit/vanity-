"""Die Werkstatt: Programmier- und Bauaufgaben, die Jarvis im Hintergrund erledigt.

"Bau mir einen Discord-Bot, der ..." landet nicht im normalen Gespräch, sondern hier:
eigener Projektordner, gründlicheres Nachdenken, ein Plan mit Schritten (TodoWrite),
Dateien schreiben, Pakete installieren, testen. Das Fenster zeigt alles als Blaupause.
Währenddessen bleibt Jarvis ansprechbar; ist die Arbeit fertig, sagt er Bescheid.

Danach geht es am selben Projekt weiter: "Mach in der Werkstatt weiter ...", "Füg dem Bot
noch einen Befehl hinzu", "Der Bot startet nicht" (dieselbe Claude-Sitzung, derselbe Ordner).
Endet die Arbeit mit einer Frage, ist Georgs nächste Antwort für die Werkstatt.
Erkennt Jarvis einen Bauauftrag nicht selbst, gibt das Gehirn ihn über
`python -m jarvis.tool werkstatt "..."` weiter (Datei HANDOFF im Datenordner).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

WORKSHOP_TOOLS = [
    "Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite",
]
# Übergabe vom Gehirn (jarvis.tool werkstatt ...) an die laufende Werkstatt
HANDOFF = "werkstatt-auftrag.json"
# So lange nach dem Ende gilt "Füg noch ... hinzu" als Wunsch zum letzten Projekt (Sekunden) ...
FOLLOW_UP_WINDOW = 30 * 60
# ... und so lange ist eine Antwort auf die Rückfrage am Ende für die Werkstatt.
ANSWER_WINDOW = 10 * 60

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
- Stell keine Rückfragen, Georg kann während der Arbeit nicht antworten. Triff vernünftige
  Entscheidungen. Fehlt etwas, das nur Georg hat (Bot-Token, Passwort, API-Schlüssel), baue trotzdem
  alles fertig, lege eine Vorlage an (zum Beispiel .env.beispiel) und sag am Ende in einem Satz, was er
  wo eintragen muss.
- Mach zuerst mit TodoWrite einen kurzen Plan mit drei bis sieben Schritten und hake sie ab.
- Teste, was du baust (starten, kurz ausprobieren, Tests). Scheitert ein Befehl, lies die Meldung und
  versuche einen anderen Weg, statt aufzugeben. Fehlen Pakete, installiere sie.
{platform}
- Lege eine kurze LIESMICH.txt an: was es ist und wie man es startet.
- Zum Schluss genau zwei oder drei kurze Sätze für Georg, auf Deutsch, ohne Markdown, wie immer mit
  "Sie" und "Sir": was du gebaut hast und wie er es startet. Das wird vorgelesen.
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

    @property
    def busy(self) -> bool:
        return self.job is not None and self.job.state == "running"

    # ------------------------------------------------------------------ Wohin gehört ein Satz?

    def route(self, text: str, free: bool = True) -> str | None:
        """"new" = neuer Auftrag, "continue" = am letzten Projekt weiter, None = nicht für die Werkstatt.
        free: kein anderer Sofort-Befehl hat den Satz erkannt (nur dann zählt er als Antwort)."""
        job = self.job
        finished = job is not None and job.state != "running" and job.ended is not None
        since = time.monotonic() - job.ended if finished else 1e9
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
            self.job = Job(task, folder, model=choose_model(task, self._cfg.get("modell", "auto")))
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
            self._cancelled = False
        self._begin(self.job)
        if self.job.resume:
            name = project_name(self.job.folder)
            return f"Sehr wohl, Sir. Ich mache am Projekt {name} weiter." if project else "Sehr wohl, Sir. Ich mache in der Werkstatt weiter."
        return "Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen."

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
        Discord-Bot", "Starte das Projekt Discord-Bot". None = kein Projekt-Befehl."""
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
        if project is None:
            if re.search(r"\b(?:projekt|werkstatt)\b", _norm(text)):
                return f"Ein Projekt namens {found[1]} finde ich nicht, Sir."
            return None  # "Mach mit der Musik weiter", "Öffne den Ordner von Steam": kein Werkstatt-Projekt
        if action == "continue":
            return self.follow_up(text, project)
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
        self._ui.workshop({"state": "start", "task": job.task, "folder": str(job.folder), "begun": job.begun,
                           "continues": job.resume, "model": job.model, "name": project_name(job.folder)})
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
            "model": job.model, "name": project_name(job.folder),
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
        effort = str(self._cfg.get("effort", "medium") or "")
        if model == "opus" and str(self._cfg.get("modell", "auto")).lower() == "auto" and effort == "medium":
            effort = "high"  # großer Auftrag: gründlich nachdenken
        cmd = [brain.claude_path, "-p", "--output-format", "stream-json", "--verbose"]
        if "include-partial-messages" not in unsupported:
            cmd.append("--include-partial-messages")
        if model:
            cmd += ["--model", model]
        if effort and "effort" not in unsupported:
            cmd += ["--effort", effort]
        if getattr(brain, "isolated", True) and "safe-mode" not in unsupported:
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
            if job.model == "opus" and result.get("is_error") and re.search(
                    r"model.*(?:not (?:available|found|supported)|invalid|access)|opus.*(?:pro|plan|upgrade)",
                    str(result.get("result", "")), re.I):
                log.warning("Werkstatt: Opus geht mit diesem Konto nicht, nehme Sonnet.")
                job.model = "sonnet"
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
            if job.model == "opus" and re.search(r"model.*(?:not (?:available|found|supported)|invalid|access)|"
                                                 r"(?:not (?:available|allowed)|no access).*model|opus.*(?:pro|plan|upgrade)",
                                                 failure, re.I):
                log.warning("Werkstatt: Opus geht mit diesem Konto nicht, nehme Sonnet.")
                job.model = "sonnet"
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
        """Ein Claude-Lauf. Gibt (Stream, stderr, zu lange still) zurück."""
        from .brain import NO_WINDOW, _close, _kill, _pump, _StreamReader, with_time

        started = time.monotonic()
        cmd = self.command(job, persona)
        log.info("Werkstatt %s in %s: %s", "weiter" if job.resume else "startet", job.folder, job.task)
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=job.folder,
            env=self.environment(job), text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
        )
        self._proc = proc
        lines: queue.Queue = queue.Queue()
        errors: list = []
        threading.Thread(target=_pump, args=(proc.stdout, lines.put), daemon=True).start()
        err_reader = threading.Thread(target=_pump, args=(proc.stderr, errors.append), daemon=True)
        err_reader.start()
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

        stream = _StreamReader(on_text, partial=True, on_step=on_step)
        quiet_limit = float(self._cfg.get("still_minuten", 12)) * 60
        total_limit = float(self._cfg.get("max_minuten", 60)) * 60
        last = time.monotonic()
        exited_at = None
        timed_out = False
        while stream.result is None:
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                now = time.monotonic()
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
            stream.feed(line)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _kill(proc)
        err_reader.join(timeout=1.0)
        self._proc = None
        return stream, "".join(e for e in errors if e), timed_out

    def _finish(self, job: Job, state: str, summary: str, detail: str = "") -> None:
        from .text import speakable

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
# "Öffne den Ordner vom Discord-Bot", "Öffne das Projekt Würfelspiel"
_OPEN_PROJECT = re.compile(r"^(?:öffne|zeig|zeige)(?: mir)? (?:den ordner (?:vom|von dem|von der|des)|das projekt)\s+(?P<name>.+)$")
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
    found = _RUN_PROJECT.match(norm)
    if found:
        return ("run", found.group("a") or found.group("b"))
    return None


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
