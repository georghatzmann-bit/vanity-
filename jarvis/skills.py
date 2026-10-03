"""Fähigkeiten (Skills): Anleitungen, die Claude nur liest, wenn er sie gerade braucht.

Jede Fähigkeit ist ein Ordner mit einer SKILL.md, wie bei Claude Code: oben Name und eine Zeile
Beschreibung, darunter die Anleitung. In Jarvis' Persönlichkeit steht nur die Liste (Name,
Beschreibung, Pfad). So bleibt die Persönlichkeit kurz und schnell, und trotzdem weiß Claude bei
Recherchen, der PC-Pflege oder dem Morgen-Briefing genau, wie es geht.

Mitgeliefert: jarvis_home/faehigkeiten. Selbst gelernt (Georg zeigt Jarvis etwas, Jarvis schreibt
es auf): daten/faehigkeiten. Eine gelernte Fähigkeit mit gleichem Namen ersetzt die mitgelieferte.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

SKILL_FILE = "SKILL.md"
MAX_SKILLS = 80
MAX_BYTES = 60_000


@dataclass
class Skill:
    name: str
    description: str
    path: Path
    learned: bool = False

    def as_dict(self) -> dict:
        return {"name": self.name, "description": self.description, "learned": self.learned, "path": str(self.path)}


def skill_dirs(home: Path, state_dir: Path) -> list[Path]:
    return [Path(home) / "faehigkeiten", Path(state_dir) / "faehigkeiten"]


def _frontmatter(text: str) -> dict:
    """Die Kopfzeilen zwischen --- und --- (nur einfache "schlüssel: wert"-Zeilen)."""
    found = re.match(r"^﻿?---\s*\n(.*?)\n---\s*(?:\n|$)", text, re.S)
    data: dict[str, str] = {}
    if not found:
        return data
    for line in found.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip():
            data[key.strip().lower()] = value.strip().strip("\"'")
    return data


def read_skill(folder: Path, learned: bool = False) -> Skill | None:
    path = folder / SKILL_FILE
    try:
        if path.stat().st_size > MAX_BYTES:
            log.warning("Fähigkeit %s ist zu groß, übersprungen.", folder.name)
            return None
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None
    head = _frontmatter(text)
    name = head.get("name") or folder.name
    description = " ".join(head.get("description", "").split())
    if not description:
        log.warning("Fähigkeit %s hat keine Beschreibung, übersprungen.", folder.name)
        return None
    return Skill(name=name, description=description[:300], path=path, learned=learned)


def load_skills(home: Path, state_dir: Path) -> list[Skill]:
    """Alle Fähigkeiten, gelernte überschreiben mitgelieferte mit gleichem Namen."""
    found: dict[str, Skill] = {}
    for number, base in enumerate(skill_dirs(home, state_dir)):
        try:
            folders = sorted(p for p in base.iterdir() if p.is_dir())
        except OSError:
            continue
        for folder in folders:
            skill = read_skill(folder, learned=number == 1)
            if skill is not None:
                found[skill.name.lower()] = skill
    return sorted(found.values(), key=lambda s: s.name.lower())[:MAX_SKILLS]


def stamp(home: Path, state_dir: Path) -> tuple:
    """Ändert sich, sobald eine Fähigkeit dazukommt oder sich ändert (für das Neu-Zusammensetzen)."""
    marks = []
    for base in skill_dirs(home, state_dir):
        try:
            for path in sorted(base.glob(f"*/{SKILL_FILE}")):
                marks.append((str(path), path.stat().st_mtime_ns))
        except OSError:
            continue
    return tuple(marks)


def persona_section(skills: list[Skill], builtin_dir: Path, learned_dir: Path) -> str:
    """Der Abschnitt für die Persönlichkeit: welche Fähigkeiten es gibt und wo die Anleitung liegt."""
    lines = [
        "## Deine Fähigkeiten",
        "",
        "Für diese Aufgaben gibt es eine genaue Anleitung. Passt eine zur Aufgabe, lies zuerst ihre SKILL.md mit dem "
        f"Read-Werkzeug und folge ihr: `{Path(builtin_dir) / '<name>' / SKILL_FILE}`, selbst gelernte (mit *) in "
        f"`{Path(learned_dir) / '<name>' / SKILL_FILE}`. Für alles andere brauchst du keine.",
        "",
    ]
    for skill in skills:
        folder = skill.path.parent.name
        lines.append(f"- {folder}{'*' if skill.learned else ''}: {skill.description}")
    lines += [
        "",
        "Zeigt Georg dir, wie etwas geht, das öfter vorkommt, oder sagt er \"Lern das\", leg eine neue Fähigkeit an "
        "(Fähigkeit faehigkeit-lernen).",
    ]
    return "\n".join(lines) + "\n"


def slug(name: str) -> str:
    """Ordnername für eine Fähigkeit: "Video rendern" -> "video-rendern"."""
    text = str(name).strip().lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(a, b)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:48].strip("-")


def save_skill(state_dir: Path, name: str, description: str, body: str) -> Path:
    """Speichert eine gelernte Fähigkeit (ersetzt eine gleichnamige). Gibt den Pfad der SKILL.md zurück."""
    folder_name = slug(name)
    description = " ".join(str(description).split())
    body = str(body).strip()
    if not folder_name:
        raise ValueError("Die Fähigkeit braucht einen Namen.")
    if len(description) < 10:
        raise ValueError("Die Beschreibung ist zu kurz. Sie sagt, wann die Fähigkeit passt (ein Satz).")
    if len(body) < 20:
        raise ValueError("Die Anleitung ist zu kurz.")
    if body.startswith("---"):
        body = re.sub(r"^---\s*\n.*?\n---\s*\n?", "", body, count=1, flags=re.S).strip()
    text = f"---\nname: {folder_name}\ndescription: {description}\n---\n\n{body}\n"
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("Die Anleitung ist zu lang (höchstens 60 KB).")
    folder = Path(state_dir) / "faehigkeiten" / folder_name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / SKILL_FILE
    path.write_text(text, encoding="utf-8")
    return path


def remove_skill(state_dir: Path, name: str) -> bool:
    """Löscht eine gelernte Fähigkeit (mitgelieferte bleiben)."""
    folder = Path(state_dir) / "faehigkeiten" / slug(name)
    path = folder / SKILL_FILE
    if not path.exists():
        return False
    path.unlink()
    try:
        folder.rmdir()
    except OSError:
        pass
    return True
