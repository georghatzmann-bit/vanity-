"""Arbeitsschritte: Was Claude gerade tut, in Worten für Georg.

Claude Code meldet jedes Werkzeug (Befehl, Datei, Websuche ...) im Stream. Hier wird daraus
ein kurzer Satz für die Anzeige ("Installiert Spotify") und einer zum Sagen ("Ich installiere
Spotify."). So steht im Fenster nicht nur "Denkt nach", sondern was wirklich passiert.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import PurePath
from urllib.parse import urlparse


@dataclass
class Step:
    id: str
    tool: str
    label: str  # für die Anzeige: "Installiert Spotify"
    detail: str = ""  # der Befehl, die Datei, die Suche
    kind: str = "other"  # command, app, install, message, file, read, search, web, plan, task, other
    spoken: str = ""  # zum Sagen: "Ich installiere Spotify."
    state: str = "running"  # running, done, error
    started: float = field(default_factory=time.monotonic)
    ended: float | None = None
    todos: list[dict] | None = None  # bei TodoWrite: die geplanten Schritte
    agent: str = ""  # bei Agent/Task: welcher Spezialist (helfer.py: recherche, texte, technik)

    def finish(self, error: bool = False) -> None:
        self.state = "error" if error else "done"
        self.ended = time.monotonic()

    def to_dict(self) -> dict:
        data = {
            "id": self.id, "tool": self.tool, "label": self.label, "detail": self.detail,
            "kind": self.kind, "state": self.state,
            "seconds": round((self.ended or time.monotonic()) - self.started, 1),
        }
        if self.todos is not None:
            data["todos"] = self.todos
        if self.agent:
            data["agent"] = self.agent
        return data


def _short(text: str, limit: int = 90) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _name(path: str) -> str:
    try:
        return PurePath(str(path).replace("\\", "/")).name or str(path)
    except Exception:
        return str(path)


def _quoted(rest: str) -> list[str]:
    """Argumente eines Befehls, Anführungszeichen beachtet."""
    return [a or b for a, b in re.findall(r'"([^"]*)"|(\S+)', rest)]


# jarvis.tool-Befehle (aus jarvis_home/CLAUDE.md) -> (Anzeige, Art, Gesagt)
def _jarvis_tool(sub: str, args: list[str]) -> tuple[str, str, str]:
    first = args[0] if args else ""
    if sub in ("oeffnen", "öffnen", "starten"):
        return f"Öffnet {first}", "app", f"Ich öffne {first}."
    if sub in ("schliessen", "schließen", "beenden"):
        return f"Schließt {first}", "app", f"Ich schließe {first}."
    if sub == "installieren":
        return f"Installiert {first}", "install", f"Ich installiere {first}."
    if sub == "deinstallieren":
        return f"Deinstalliert {first}", "install", f"Ich deinstalliere {first}."
    if sub == "nachricht":
        app = args[0].capitalize() if args else ""
        person = args[1] if len(args) > 1 else ""
        return f"Schreibt {person} auf {app}", "message", f"Ich schreibe {person}."
    if sub in ("erinnern", "erinnerungen", "erinnerung-loeschen"):
        return "Kümmert sich um Erinnerungen", "plan", "Ich notiere das."
    if sub == "bildschirm":
        return "Schaut auf den Bildschirm", "read", "Ich sehe mir den Bildschirm an."
    if sub in ("lautstaerke", "medien"):
        return "Steuert Ton und Musik", "app", ""
    if sub == "admin":
        return "Führt etwas mit Admin-Rechten aus", "command", "Ich brauche dafür kurz Administratorrechte."
    if sub == "papierkorb":
        return "Legt etwas in den Papierkorb", "file", ""
    if sub in ("alexa-sagen", "smarthome"):
        return "Spricht mit dem Smart Home", "app", ""
    if sub == "gaming":
        return "Schaltet den Gaming-Modus", "app", ""
    return f"Jarvis-Befehl {sub}", "command", ""


_COMMANDS: list[tuple[re.Pattern, str, str, str]] = [
    # (Muster, Anzeige mit {0} = erste Gruppe, Art, Gesagt)
    (re.compile(r"\bwinget\s+uninstall\b", re.I), "Deinstalliert ein Programm", "install", "Ich deinstalliere das."),
    (re.compile(r"\bwinget\s+(search|list|show)\b", re.I), "Sucht nach Programmen", "search", ""),
    (re.compile(r"\b(?:pip|pip3|python -m pip)\s+install\b", re.I), "Installiert Python-Pakete", "install", "Ich installiere die nötigen Pakete."),
    (re.compile(r"\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b", re.I), "Installiert Pakete", "install", "Ich installiere die nötigen Pakete."),
    (re.compile(r"\bgit\s+clone\b", re.I), "Lädt ein Projekt herunter", "web", "Ich lade das Projekt herunter."),
    (re.compile(r"\bgit\s+(commit|push|pull|status|diff|log|add|checkout|init)\b", re.I), "Arbeitet mit Git", "command", ""),
    (re.compile(r"\b(?:pytest|unittest|npm\s+(?:run\s+)?test|cargo\s+test|dotnet\s+test)\b", re.I), "Testet den Code", "command", "Ich teste das."),
    (re.compile(r"\b(?:npm\s+run\s+build|cargo\s+build|dotnet\s+build|msbuild|cmake|make\b|pyinstaller)", re.I), "Baut das Programm", "command", "Ich baue das Programm."),
    (re.compile(r"\bpython[0-9.]*(?:\.exe)?\s+(?!-m\s+jarvis)[\"']?([^\s\"']+\.py)", re.I), "Startet {0}", "command", "Ich starte das Skript."),
    (re.compile(r"\b(?:Invoke-WebRequest|Invoke-RestMethod|curl|wget|iwr|irm)\b", re.I), "Lädt etwas aus dem Netz", "web", ""),
    (re.compile(r"\b(?:Start-Process|start\s)\s*[\"']?([^\s\"']+)", re.I), "Startet {0}", "app", ""),
    (re.compile(r"\b(?:Stop-Process|taskkill)\b", re.I), "Beendet ein Programm", "app", ""),
    (re.compile(r"\b(?:Set-ItemProperty|New-ItemProperty|reg\s+add|Set-WinUserLanguageList|Set-Culture|powercfg)\b", re.I), "Ändert eine Windows-Einstellung", "command", "Ich ändere die Einstellung."),
    (re.compile(r"\b(?:Get-Process|tasklist)\b", re.I), "Schaut nach laufenden Programmen", "read", ""),
    (re.compile(r"\b(?:New-Item|mkdir|md)\b", re.I), "Legt Ordner an", "file", ""),
    (re.compile(r"\b(?:Copy-Item|Move-Item|copy|move|xcopy|robocopy)\b", re.I), "Kopiert Dateien", "file", ""),
    (re.compile(r"\b(?:Get-ChildItem|dir|ls)\b", re.I), "Schaut in einen Ordner", "read", ""),
]


def _winget_target(rest: str) -> str:
    """Was winget installieren soll: der Wert hinter --id, sonst das erste Wort ohne Bindestrich."""
    args = _quoted(rest)
    for flag in ("--id", "--name", "-n", "-q", "--query"):
        if flag in args and args.index(flag) + 1 < len(args):
            return args[args.index(flag) + 1]
    return next((a for a in args if not a.startswith("-")), "")


def _command(command: str) -> tuple[str, str, str]:
    jarvis = re.search(r"-m\s+jarvis\.tool\s+([\w\-äöüß]+)(.*)", command)
    if jarvis:
        return _jarvis_tool(jarvis.group(1).lower(), _quoted(jarvis.group(2)))
    winget = re.search(r"\bwinget\s+install\b(.*)", command, re.I)
    if winget:
        target = _winget_target(winget.group(1).split("|")[0].split(";")[0])
        parts = target.split(".")
        if len(parts) >= 2 and parts[1] and not parts[1].isdigit():
            target = parts[1]  # "Spotify.Spotify" -> "Spotify", "Valve.Steam" -> "Steam"
        return (f"Installiert {_short(target, 40)}" if target else "Installiert ein Programm"), "install", "Ich installiere das gerade."
    for pattern, label, kind, spoken in _COMMANDS:
        found = pattern.search(command)
        if found:
            group = found.group(1).strip() if found.groups() and found.group(1) else ""
            text = label.format(_short(group, 40)) if "{0}" in label else label
            if "{0}" in label and not group:
                text = label.replace(" {0}", "")
            return text, kind, spoken
    return "Führt einen Befehl aus", "command", ""


def describe(tool_id: str, tool: str, data: dict | None) -> Step:
    """Macht aus einem Werkzeug-Aufruf von Claude einen Arbeitsschritt."""
    data = data if isinstance(data, dict) else {}
    name = str(tool or "")
    lower = name.lower()
    if lower in ("bash", "powershell"):
        command = str(data.get("command") or "")
        label, kind, spoken = _command(command)
        detail = _short(data.get("description") or command, 140)
        return Step(tool_id, name, label, detail, kind, spoken)
    if lower in ("write",):
        path = str(data.get("file_path") or data.get("path") or "")
        return Step(tool_id, name, f"Schreibt {_name(path)}", path, "file", "Ich schreibe den Code.")
    if lower in ("edit", "multiedit"):
        path = str(data.get("file_path") or data.get("path") or "")
        return Step(tool_id, name, f"Ändert {_name(path)}", path, "file", "Ich passe den Code an.")
    if lower == "notebookedit":
        path = str(data.get("notebook_path") or "")
        return Step(tool_id, name, f"Ändert {_name(path)}", path, "file", "")
    if lower == "read":
        path = str(data.get("file_path") or data.get("path") or "")
        return Step(tool_id, name, f"Liest {_name(path)}", path, "read", "")
    if lower == "glob":
        return Step(tool_id, name, "Sucht Dateien", str(data.get("pattern") or ""), "search", "")
    if lower == "grep":
        return Step(tool_id, name, "Durchsucht Dateien", _short(data.get("pattern") or "", 60), "search", "")
    if lower == "websearch":
        query = _short(data.get("query") or "", 60)
        return Step(tool_id, name, f"Sucht im Netz: {query}" if query else "Sucht im Netz", query, "web", "Ich sehe kurz im Netz nach.")
    if lower == "webfetch":
        url = str(data.get("url") or "")
        host = urlparse(url).netloc.removeprefix("www.") if url else ""
        return Step(tool_id, name, f"Liest {host}" if host else "Liest eine Webseite", url, "web", "Ich lese das nach.")
    if lower == "todowrite":
        todos = [
            {"text": _short(t.get("content") or t.get("activeForm") or "", 80), "state": str(t.get("status") or "pending")}
            for t in (data.get("todos") or []) if isinstance(t, dict)
        ]
        step = Step(tool_id, name, "Plant die Schritte", f"{len(todos)} Schritte", "plan", "")
        step.todos = todos
        return step
    if lower.startswith("mcp__"):
        # Ein Konnektor (Georgs claude.ai-Konnektoren wie Gmail, Google Kalender, Shopify)
        from .konnektoren import display_name, kind_for, split

        server, action = split(name)
        shown = display_name(server)
        return Step(tool_id, name, f"Nutzt {shown}", action.replace("_", " ").replace("-", " "), kind_for(server), "")
    if lower in ("task", "agent"):
        what = _short(data.get("description") or data.get("prompt") or "", 60)
        step = Step(tool_id, name, f"Gibt ab: {what}" if what else "Gibt eine Teilaufgabe ab", what, "task", "")
        step.agent = re.sub(r"[^a-z_-]", "", str(data.get("subagent_type") or "").lower())[:30]
        return step
    return Step(tool_id, name, name or "Arbeitet", "", "other", "")
