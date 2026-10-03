"""Das System (wie im Video "AgenticOS"): Aus einem Werkzeug wird ein System, gesteuert aus einem Fenster.

- Agents: Jarvis und seine Spezialisten, jeder mit seinen eigenen Fähigkeiten (Skills) und Werkzeugen, dazu
  live, was er gerade tut. Ein Auftrag an einen Agent ist ein ganz normaler Satz an Jarvis.
- Skills: die häufigsten Aufgaben als Knopf ("Heute planen", "Tiefenrecherche", "Letzte Sitzung").
- Automationen: Zeitpläne, eigene Befehle und Gewohnheiten, die Jarvis von selbst erkennt.
- Gedächtnis: was Jarvis weiß, Sitzung für Sitzung (memory.py), und in der Mitte das Wissensnetz
  (wissensnetz.py), in dem Projekte, Notizen, Recherchen und Personen automatisch verknüpft sind.

Diese Datei liest nur zusammen, was Jarvis ohnehin hat. Sie schaltet nichts frei und startet nichts selbst.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import threading
from pathlib import Path

log = logging.getLogger(__name__)

# Wer was kann. "skills" sind Ordnernamen in jarvis_home/faehigkeiten (nur die vorhandenen werden gezeigt),
# "auftrag" macht aus Georgs Text den Satz an Jarvis ({} = sein Text).
AGENTS = (
    {"id": "jarvis", "name": "Jarvis", "kuerzel": "JA", "rolle": "Ihr Butler: hört zu, antwortet, verteilt die Arbeit",
     "skills": ("morgen-briefing", "tagesplan", "notizbuch", "smart-home", "faehigkeit-lernen"),
     "werkzeuge": ("Sprache", "Programme", "Konnektoren"), "auftrag": "{}", "beispiel": "Öffne Spotify"},
    {"id": "recherche", "name": "Recherche", "kuerzel": "RE", "rolle": "Sucht gründlich, vergleicht, legt einen Bericht ab",
     "skills": ("recherche", "nachrichten"), "werkzeuge": ("Websuche", "Webseiten", "Notizbuch"),
     "auftrag": "Gib das an deinen Spezialisten für Recherche: {}", "beispiel": "Die besten Gaming-Mäuse unter 100 Euro"},
    {"id": "texte", "name": "Texte", "kuerzel": "TX", "rolle": "Schreibt Mails, Nachrichten und Posts, verschickt nie selbst",
     "skills": (), "werkzeuge": ("Entwürfe", "Websuche"),
     "auftrag": "Gib das an deinen Spezialisten für Texte: {}", "beispiel": "Eine freundliche Absage an den Vermieter"},
    {"id": "technik", "name": "Technik", "kuerzel": "TE", "rolle": "Untersucht PC-Probleme, ändert nichts ohne Sie",
     "skills": ("pc-pflege", "bildschirm"), "werkzeuge": ("PowerShell", "Ereignisanzeige"),
     "auftrag": "Gib das an deinen Spezialisten für Technik: {}", "beispiel": "Warum ruckelt Valorant seit gestern?"},
    {"id": "post", "name": "Posteingang", "kuerzel": "PO", "rolle": "Sichtet Ihre Mails fürs Lagebild, nur lesend",
     "skills": ("morgen-briefing",), "werkzeuge": ("Gmail",),
     "auftrag": "Schau in meine Mails: {}", "beispiel": "Ist die Rechnung von Telekom schon da?"},
    {"id": "kalender", "name": "Kalender", "kuerzel": "KA", "rolle": "Hält Ihren Tag und Ihre Woche im Blick",
     "skills": ("tagesplan",), "werkzeuge": ("Google Kalender",),
     "auftrag": "Schau in meinen Kalender: {}", "beispiel": "Wann habe ich nächste Woche Zeit?"},
    {"id": "shop", "name": "Shop", "kuerzel": "SH", "rolle": "Behält Bestellungen und Umsatz im Blick",
     "skills": (), "werkzeuge": ("Shopify",),
     "auftrag": "Schau in meinen Shop: {}", "beispiel": "Wie viele Bestellungen kamen heute?"},
    {"id": "werkstatt", "name": "Werkstatt", "kuerzel": "WE", "rolle": "Baut Programme, Webseiten und Spiele und testet sie",
     "skills": (), "werkzeuge": ("Claude Code", "Unsichtbarer Testplatz"),
     "auftrag": "", "beispiel": "Ein Würfelspiel für Discord"},
    {"id": "blueprint", "name": "Blueprint", "kuerzel": "BP", "rolle": "Entwirft 3D-Modelle als Hologramm",
     "skills": (), "werkzeuge": ("Hologramm", "Blender"),
     "auftrag": "Generiere {}", "beispiel": "Einen Iron-Man-Helm"},
    {"id": "stream", "name": "Stream", "kuerzel": "ST", "rolle": "Bereitet Ihren Stream vor und geht live",
     "skills": ("spiele",), "werkzeuge": ("OBS", "Twitch", "Steam"),
     "auftrag": "Ich will {} streamen", "beispiel": "Valorant"},
)
LAGE_AGENTS = ("post", "kalender", "shop")
HELPERS = ("recherche", "texte", "technik")

# Die Skill-Knöpfe wie im Video ("9 Skills bereit"). "frage": erst etwas eintippen, {} kommt in den Satz.
QUICK = (
    {"id": "briefing", "name": "Morgen-Briefing", "satz": "Briefing", "hinweis": "Mails, Termine, Nachrichten und Wetter vorgelesen"},
    {"id": "heute", "name": "Heute planen", "satz": "Plan meinen Tag", "hinweis": "Termine und Vorhaben als Tagesplan"},
    {"id": "woche", "name": "Woche planen", "satz": "Plan meine Woche", "hinweis": "Die nächsten sieben Tage im Überblick"},
    {"id": "mails", "name": "Mails prüfen", "satz": "Prüf meine Mails und sag mir, was wichtig ist", "hinweis": "Nur lesend, über Ihren Gmail-Konnektor"},
    {"id": "recherche", "name": "Tiefenrecherche", "satz": "Recherchiere gründlich: {}", "frage": "Was soll ich recherchieren?",
     "hinweis": "Mehrere Quellen, mit Bericht im Notizbuch"},
    {"id": "notiz", "name": "Notiz", "satz": "Notiere: {}", "frage": "Was soll ich notieren?", "hinweis": "Landet im Notizbuch, verknüpft sich von selbst"},
    {"id": "weltlage", "name": "Weltlage", "satz": "Zeig mir, was in der Welt passiert", "hinweis": "Die Erde mit den neuesten Meldungen"},
    {"id": "spiele", "name": "Spiele-Updates", "satz": "Welche Spiele brauchen Updates?", "hinweis": "Steam und Epic durchsehen"},
    {"id": "stream", "name": "Stream vorbereiten", "satz": "Ich will streamen", "hinweis": "OBS, Kamera, Mikrofon und Twitch"},
    {"id": "pc", "name": "PC-Pflege", "satz": "Warum ist der PC so langsam?", "hinweis": "Was bremst, was Speicher frisst"},
    {"id": "sitzung", "name": "Letzte Sitzung", "satz": "Was haben wir zuletzt gemacht?", "hinweis": "Woran Sie zuletzt mit Jarvis waren"},
    {"id": "lernen", "name": "Fähigkeit lernen", "satz": "Lern eine neue Fähigkeit: {}", "frage": "Was soll Jarvis lernen?",
     "hinweis": "Ein Ablauf, den Jarvis ab jetzt kann"},
)

STATE_WORDS = {"idle": ("bereit", "Hört auf „Jarvis“"), "listening": ("arbeitet", "Hört zu"),
               "thinking": ("arbeitet", "Denkt nach"), "speaking": ("arbeitet", "Antwortet"),
               "muted": ("wartet", "Mikrofon stumm"), "error": ("fehler", "Störung")}

_CALL = r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?"
_SHOW = re.compile(
    _CALL + r"(?:(?:zeig|zeige|öffne|öffnen)(?:\s+mir)?\s+)?(?:das\s+|dein\s+|mein\s+|die\s+|den\s+|deine\s+)?"
    r"(?:system|agentic\s*os|agenten-?system|wissensnetz|wissens-?netz|knowledge\s+graph|graph|"
    r"alle\s+(?:agents|agenten|spezialisten)|agents|agenten(?:übersicht)?)(?:\s+an|\s+öffnen|\s+zeigen)?(?:\s+bitte)?[\s.!]*$",
    re.I)
_WHO = re.compile(
    _CALL + r"(?:welche|was\s+machen\s+(?:die|meine|deine))\s+(?:agents|agenten|spezialisten)(?:\s+(?:laufen|arbeiten|"
    r"sind\s+(?:gerade\s+)?(?:aktiv|dran|beschäftigt)))?(?:\s+gerade)?\s*[?.!]*$|"
    + _CALL + r"(?:wer|was)\s+(?:arbeitet|läuft)\s+gerade\s*[?.!]*$", re.I)


def match_system(text: str) -> str | None:
    """"show" (Zeig mir das System / das Wissensnetz), "who" (Welche Agents laufen gerade?) oder None."""
    raw = " ".join(str(text or "").split())
    if _SHOW.match(raw):
        return "show"
    if _WHO.match(raw):
        return "who"
    return None


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


class System:
    """Hält das System-Fenster zusammen: Agents, Skills, Automationen, Gedächtnis und das Wissensnetz."""

    def __init__(self, assistant, home_dir: Path, state_dir: Path, ui=None, now=None, show_window=None) -> None:
        self._assistant = assistant
        self._home = Path(home_dir)
        self._state_dir = Path(state_dir)
        self._ui = ui
        self._now = now or dt.datetime.now
        self._show_window = show_window
        self._lock = threading.Lock()
        self._netz = None
        self._netz_folder: Path | None = None

    # ------------------------------------------------------------------ Wissensnetz

    def netz(self):
        from .wissensnetz import Netz

        notebook = getattr(self._assistant, "notebook", None)
        folder = Path(notebook.folder) if notebook is not None else None
        with self._lock:
            if self._netz is None or self._netz_folder != folder:
                self._netz = Netz(folder, getattr(self._assistant, "workshop", None),
                                  getattr(self._assistant, "memory", None), now=self._now)
                self._netz_folder = folder
            return self._netz

    def graph(self, fresh: bool = False) -> dict:
        graph = dict(self.netz().build(fresh=fresh))
        graph["notizbuch"] = getattr(self._assistant, "notebook", None) is not None
        return graph

    def open_node(self, node_id: str) -> dict:
        """Klick auf "Öffnen": die Seite in Obsidian (wenn installiert), sonst im Standardprogramm, ein Projekt im
        Explorer."""
        path = self.netz().path_of(node_id)
        if path is None:
            return {"ok": False, "error": "Dazu gibt es keine Datei."}
        if not path.exists():
            return {"ok": False, "error": "Die Datei gibt es nicht mehr."}
        try:
            how = open_path(path)
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "wie": how}

    # ------------------------------------------------------------------ Stand

    def _skills(self) -> list:
        from .skills import load_skills

        try:
            return load_skills(self._home, self._state_dir)
        except Exception as exc:
            log.debug("System, Fähigkeiten: %s", exc)
            return []

    def _jarvis_state(self) -> tuple[str, str]:
        assistant = self._assistant
        raw = str(getattr(assistant, "_last_state", "") or "idle")
        status, text = STATE_WORDS.get(raw, STATE_WORDS["idle"])
        if raw == "idle" and getattr(assistant, "gaming", False):
            text = "Gaming-Modus: hält sich zurück"
        return status, text

    def _workshop_state(self) -> dict:
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return {"status": "aus", "text": "Ausgeschaltet"}
        job = getattr(shop, "job", None)
        if job is not None and job.state == "running":
            from .workshop import project_name

            todos = list(getattr(job, "todos", []) or [])
            done = sum(1 for t in todos if t.get("state") == "completed")
            progress = done / len(todos) if todos else None
            return {"status": "arbeitet", "text": f"Baut: {project_name(job.folder)}", "fortschritt": progress}
        try:
            count = len(shop.projects())
        except Exception:
            count = 0
        if job is not None and job.state == "done":
            from .workshop import project_name

            return {"status": "fertig", "text": f"Fertig: {project_name(job.folder)}"}
        if job is not None and job.state in ("error", "failed"):
            return {"status": "fehler", "text": "Der letzte Auftrag ist hängen geblieben"}
        return {"status": "bereit", "text": f"{count} {'Projekt' if count == 1 else 'Projekte'}" if count else "Wartet auf einen Auftrag"}

    def _blueprint_state(self) -> dict:
        blueprint = getattr(self._assistant, "blueprint", None)
        if blueprint is None:
            return {"status": "aus", "text": "Ausgeschaltet"}
        name = str((getattr(blueprint, "scene", None) or {}).get("name") or "")
        if getattr(blueprint, "busy", False):
            return {"status": "arbeitet", "text": f"Konstruiert: {name}" if name else "Konstruiert ein Modell"}
        if getattr(blueprint, "active", False):
            return {"status": "bereit", "text": f"Offen: {name}" if name else "Offen, wartet auf ein Modell"}
        return {"status": "bereit", "text": f"Zuletzt: {name}" if name else "Sagen Sie „Blueprint“"}

    def _stream_state(self) -> dict:
        stream = getattr(self._assistant, "stream", None)
        if stream is None:
            return {"status": "aus", "text": "Ausgeschaltet"}
        if getattr(stream, "live", False):
            return {"status": "arbeitet", "text": "Live auf Twitch"}
        return {"status": "bereit", "text": "Sagen Sie „Ich will streamen“"}

    def agents(self) -> list[dict]:
        """Alle Agents mit Stand, Skills und Werkzeugen. Den Shop nur mit Shop-Konnektor."""
        zentrale = getattr(self._assistant, "zentrale", None)
        try:
            states = zentrale.agent_states() if zentrale is not None else {}
        except Exception as exc:
            log.debug("System, Spezialisten: %s", exc)
            states = {}
        from . import zentrale as zentrale_module

        empty = {a["id"]: a["leer"] for a in zentrale_module.AGENTS}
        skills = {s.path.parent.name: s for s in self._skills()}
        learned = [s for s in skills.values() if s.learned]
        connectors = self._connectors()
        out = []
        for spec in AGENTS:
            key = spec["id"]
            if key == "jarvis":
                status, text = self._jarvis_state()
                state = {"status": status, "text": text}
            elif key == "werkstatt":
                state = self._workshop_state()
            elif key == "blueprint":
                state = self._blueprint_state()
            elif key == "stream":
                state = self._stream_state()
            else:
                state = dict(states.get(key) or {"status": "bereit", "text": ""})
                if key == "shop" and zentrale is not None and not zentrale.has_shop() and state.get("status") == "bereit" \
                        and not state.get("text"):
                    continue
                if key == "shop" and zentrale is None:
                    continue
                if key in LAGE_AGENTS and zentrale is None:
                    state = {"status": "aus", "text": "Die Kommandozentrale ist aus"}
                state["text"] = state.get("text") or empty.get(key, "")
            own = [{"name": name, "beschreibung": skills[name].description} for name in spec["skills"] if name in skills]
            if key == "jarvis":
                own += [{"name": s.name, "beschreibung": s.description, "gelernt": True} for s in learned]
            tools = list(spec["werkzeuge"])
            if key == "jarvis" and connectors:
                tools = ["Sprache", "Programme"] + connectors[:4]
            out.append({
                "id": key, "name": spec["name"], "kuerzel": spec["kuerzel"], "rolle": spec["rolle"],
                "status": state.get("status") or "bereit", "text": str(state.get("text") or ""),
                "zeit": str(state.get("zeit") or ""), "fortschritt": state.get("fortschritt"),
                "skills": own, "werkzeuge": tools, "beispiel": spec["beispiel"],
                "auftrag": key == "werkstatt" or bool(spec["auftrag"]),
            })
        return out

    @staticmethod
    def _connectors() -> list[str]:
        """Die Konnektoren, die Claude Code zuletzt als verbunden gemeldet hat ("Gmail", "Google Calendar")."""
        try:
            from . import konnektoren

            return [c["name"] for c in konnektoren.seen() if c.get("ok")]
        except Exception:
            return []

    def quick(self) -> list[dict]:
        """Die Skill-Knöpfe, dazu die selbst gelernten Fähigkeiten."""
        out = [{"id": q["id"], "name": q["name"], "hinweis": q["hinweis"], "frage": q.get("frage", "")} for q in QUICK]
        for skill in [s for s in self._skills() if s.learned][:6]:
            out.append({"id": "gelernt:" + skill.name, "name": skill.name.replace("-", " ").capitalize(),
                        "hinweis": skill.description[:90], "frage": "", "gelernt": True})
        return out

    def automations(self) -> dict:
        """Zeitpläne, eigene Befehle und Gewohnheiten."""
        from .zeitplan import describe_days

        plans = []
        schedules = getattr(self._assistant, "schedules", None)
        if schedules is not None:
            try:
                plans = [{"id": i["id"], "tage": describe_days(i["tage"]), "uhrzeit": i["uhrzeit"], "befehl": i["befehl"]}
                         for i in schedules.all()][:20]
            except Exception as exc:
                log.debug("System, Zeitpläne: %s", exc)
        commands, routines = [], []
        memory = getattr(self._assistant, "memory", None)
        if memory is not None:
            try:
                commands = [{"name": c.get("name", ""), "aktion": c.get("aktion", ""), "anzahl": c.get("anzahl", 0)}
                            for c in memory.custom_commands()][:20]
                routines = [{"text": r.describe(), "anzahl": r.count} for r in memory.routines()][:8]
            except Exception as exc:
                log.debug("System, Befehle: %s", exc)
        return {"zeitplaene": plans, "befehle": commands, "gewohnheiten": routines}

    def memory_overview(self) -> dict:
        memory = getattr(self._assistant, "memory", None)
        if memory is None:
            return {"fakten": 0, "personen": 0, "sitzungen": []}
        try:
            sessions = memory.sessions() if hasattr(memory, "sessions") else []
            shown = []
            for item in reversed(sessions[-8:]):
                start = dt.datetime.fromisoformat(item["start"])
                shown.append({"start": item["start"], "tag": self._day_word(start.date()), "von": f"{start:%H:%M}",
                              "bis": str(item.get("ende") or "")[11:16], "anzahl": item.get("anzahl", 0),
                              "themen": item.get("themen", [])[:4], "laufend": bool(item.get("laufend"))})
            people = [c for c in memory.contacts() if c.get("name")]
            return {"fakten": len(memory.facts()), "personen": len(people), "sitzungen": shown,
                    "gesamt": len(sessions)}
        except Exception as exc:
            log.debug("System, Gedächtnis: %s", exc)
            return {"fakten": 0, "personen": 0, "sitzungen": []}

    def _day_word(self, day: dt.date) -> str:
        today = self._now().date()
        if day == today:
            return "Heute"
        if day == today - dt.timedelta(days=1):
            return "Gestern"
        if (today - day).days < 7:
            return ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")[day.weekday()]
        return f"{day.day}.{day.month}."

    def snapshot(self) -> dict:
        """Alles für die Ansicht "System" (ohne das Netz, das kommt einzeln und seltener)."""
        agents = self.agents()
        quick = self.quick()
        working = [a for a in agents if a["status"] in ("arbeitet", "schreibt")]
        return {
            "agenten": agents,
            "skills": quick,
            "automationen": self.automations(),
            "gedaechtnis": self.memory_overview(),
            "zahlen": {"agenten": len(agents), "aktiv": len(working), "skills": len(quick)},
            "stand": f"{self._now():%H:%M}",
        }

    # ------------------------------------------------------------------ Aufträge

    def skill_sentence(self, skill_id: str, text: str = "") -> str | None:
        """Der Satz an Jarvis für einen Skill-Knopf. None = unbekannt oder es fehlt der Text."""
        skill_id = str(skill_id or "")
        text = " ".join(str(text or "").split())
        if skill_id.startswith("gelernt:"):
            name = skill_id.split(":", 1)[1]
            if not any(s.learned and s.name == name for s in self._skills()):
                return None
            return f"Nutze deine Fähigkeit {name}" + (f": {text}" if text else "")
        spec = next((q for q in QUICK if q["id"] == skill_id), None)
        if spec is None:
            return None
        if "{}" in spec["satz"]:
            return spec["satz"].format(text) if text else None
        return spec["satz"]

    def agent_sentence(self, agent_id: str, text: str) -> str | None:
        """Der Satz an Jarvis für einen Auftrag an einen Agent (nicht für die Werkstatt, die startet direkt)."""
        spec = next((a for a in AGENTS if a["id"] == str(agent_id or "")), None)
        text = " ".join(str(text or "").split()).strip()
        if spec is None or not text or not spec["auftrag"]:
            return None
        return spec["auftrag"].format(text)

    # ------------------------------------------------------------------ Sprache

    def command(self, text: str) -> str | None:
        """"Zeig mir das System", "Öffne das Wissensnetz", "Welche Agents laufen gerade?". None = nicht fürs System."""
        found = match_system(text)
        if found is None:
            return None
        if found == "show":
            self.bring_up()
            graph = self.graph()
            count = graph["zahlen"]["knoten"]
            if count <= 1:
                return "Das System, Sir. Das Wissensnetz wächst mit jedem Gespräch."
            return (f"Das System, Sir. {count} Knoten im Wissensnetz, {graph['zahlen']['kanten']} Verbindungen, "
                    f"davon {graph['zahlen']['auto']} von selbst geknüpft.")
        working = [a for a in self.agents() if a["status"] in ("arbeitet", "schreibt") and a["id"] != "jarvis"]
        waiting = [a for a in self.agents() if a["status"] == "wartet" and a["id"] != "jarvis"]
        if not working and not waiting:
            return "Gerade arbeitet keiner meiner Spezialisten, Sir. Alle sind bereit."
        parts = []
        if working:
            parts.append(("Gerade arbeitet " if len(working) == 1 else "Gerade arbeiten ")
                         + _join([f"{a['name']} ({a['text']})" if a["text"] else a["name"] for a in working]))
        if waiting:
            parts.append(_join([a["name"] for a in waiting]) + (" wartet" if len(waiting) == 1 else " warten") + " auf Sie")
        return ", ".join(parts) + ", Sir."

    def bring_up(self) -> None:
        """Das Fenster mit dem System zeigen (außer im Spiel)."""
        try:
            if self._ui is not None:
                self._ui.system({"action": "show"})
        except AttributeError:
            pass
        except Exception as exc:
            log.debug("System, Anzeige: %s", exc)
        if self._show_window is not None and not getattr(self._assistant, "gaming", False):
            try:
                self._show_window()
            except Exception as exc:
                log.debug("System, Fenster: %s", exc)


def obsidian_installed() -> bool:
    """Ist Obsidian als Programm für obsidian://-Links eingetragen (nur Windows)?"""
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"obsidian\shell\open\command"):
            return True
    except OSError:
        return False


def open_path(path: Path) -> str:
    """Öffnet eine Notizbuch-Seite in Obsidian (wenn installiert) oder sonst im Standardprogramm, einen Ordner im
    Explorer. Gibt zurück, womit ("obsidian", "programm")."""
    import os
    import urllib.parse

    path = Path(path)
    if os.name != "nt":
        raise OSError("Öffnen geht nur unter Windows.")
    if path.is_file() and path.suffix.lower() == ".md" and obsidian_installed():
        os.startfile("obsidian://open?path=" + urllib.parse.quote(str(path), safe=""))
        return "obsidian"
    os.startfile(str(path))
    return "programm"
