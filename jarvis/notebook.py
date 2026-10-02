"""Jarvis' Notizbuch: ein Ordner voller Markdown-Dateien, den Georg in Obsidian (kostenlos) als
Tresor öffnen kann. Dann ist alles verlinkt und als Netz zu sehen.

- Tagebuch/2026-10-02.md: jedes Gespräch des Tages (wer was gesagt hat) und was Jarvis nachts gelernt hat
- Gedächtnis.md: was Jarvis über Georg weiß, seine eigenen Befehle und Gewohnheiten
- Personen/Max.md: alles zu einer Person (App, Geburtstag, Fakten), mit Platz für eigene Notizen
- Recherchen/<Titel>.md: ausführliche Antworten, die Claude als Bericht ablegt
- Notizen/Schnellnotizen.md: "Notiere: Milch kaufen"

Alles bleibt auf dem PC. Was Jarvis selbst schreibt, steht zwischen <!-- jarvis:anfang --> und
<!-- jarvis:ende -->; was Georg darunter oder darüber ergänzt, bleibt erhalten.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import re
import threading
from pathlib import Path

log = logging.getLogger(__name__)

START, END = "<!-- jarvis:anfang -->", "<!-- jarvis:ende -->"
WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
          "November", "Dezember"]
MAX_ANSWER = 600
MAX_FILES = 3000  # beim Suchen höchstens so viele Dateien


def default_folder() -> Path:
    return Path.home() / "Jarvis-Notizbuch"


def folder_from_config(cfg: dict) -> Path:
    raw = str((cfg.get("notizbuch") or {}).get("ordner", "") or "").strip()
    return Path(os.path.expandvars(os.path.expanduser(raw))) if raw else default_folder()


def safe_title(title: str, fallback: str = "Notiz") -> str:
    """Ein Dateiname, den Windows und Obsidian mögen (ohne : / \\ ? * " < > | # ^ [ ])."""
    text = re.sub(r'[<>:"/\\|?*#^\[\]\x00-\x1f]+', " ", str(title))
    text = " ".join(text.split()).strip(" .")
    return text[:80].strip(" .") or fallback


def spoken_day(day: dt.date) -> str:
    return f"{WEEKDAYS[day.weekday()]}, {day.day}. {MONTHS[day.month - 1]} {day.year}"


def _one_line(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _replace_block(old: str, block: str, head: str) -> str:
    """Ersetzt Jarvis' Teil einer Seite. Fehlt er, kommt er unter die Überschrift."""
    block = f"{START}\n{block.strip()}\n{END}"
    if START in old and END in old:
        before, rest = old.split(START, 1)
        _, after = rest.split(END, 1)
        return before + block + after
    if old.strip():
        return old.rstrip() + "\n\n" + block + "\n"
    return f"{head}\n\n{block}\n"


class Notebook:
    def __init__(self, folder: Path, now=None, user: str = "Georg") -> None:
        self.folder = Path(folder)
        self._now = now or dt.datetime.now
        self._user = user or "Georg"
        self._lock = threading.RLock()
        self.last_sync = 0.0

    # ------------------------------------------------------------------ Schreiben

    def _write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)

    def _append(self, path: Path, head: str, lines: str) -> None:
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            fresh = not path.exists()
            with open(path, "a", encoding="utf-8") as out:
                if fresh:
                    out.write(head.rstrip() + "\n\n")
                out.write(lines.rstrip("\n") + "\n")

    def day_path(self, day: dt.date) -> Path:
        return self.folder / "Tagebuch" / f"{day.isoformat()}.md"

    def log(self, said: str, answer: str, names: list[str] | None = None) -> None:
        """Ein Gespräch ins Tagebuch: was Georg gesagt hat und was Jarvis geantwortet hat."""
        said = _one_line(said, 500)
        if not said:
            return
        now = self._now()
        said = link_names(said, names or [])
        line = f"- **{now:%H:%M}** {self._user}: {said}"
        answer = _one_line(answer, MAX_ANSWER)
        if answer:
            line += f"\n  - Jarvis: {answer}"
        head = f"# {spoken_day(now.date())}\n\nAlle Gespräche des Tages. Zurück zum [[Start]].\n\n## Gespräche"
        self._append(self.day_path(now.date()), head, line)

    def learned(self, day: dt.date, facts: list[str]) -> None:
        """Was Jarvis nachts aus dem Tag gelernt hat, unter den Tag."""
        facts = [_one_line(f, 300) for f in facts if str(f).strip()]
        if not facts:
            return
        head = f"# {spoken_day(day)}\n\nZurück zum [[Start]]."
        self._append(self.day_path(day), head, "\n## Gelernt\n\n" + "\n".join(f"- {f}" for f in facts))

    def note(self, text: str, title: str = "Schnellnotizen") -> Path:
        """Eine kurze Notiz ("Notiere: Milch kaufen"), mit Datum und Uhrzeit."""
        text = _one_line(text, 2000)
        if len(text) < 2:
            raise ValueError("Die Notiz ist leer.")
        now = self._now()
        path = self.folder / "Notizen" / f"{safe_title(title, 'Schnellnotizen')}.md"
        self._append(path, f"# {safe_title(title, 'Schnellnotizen')}\n\nZurück zum [[Start]].",
                     f"- **{now.day}.{now.month}. {now:%H:%M}** {text}")
        return path

    def report(self, title: str, text: str) -> Path:
        """Ein Bericht (Recherche, Vergleich, Anleitung). Gleicher Titel: eine zweite Datei."""
        text = str(text or "").strip()
        if len(text) < 20:
            raise ValueError("Der Bericht ist zu kurz.")
        name = safe_title(title, "Bericht")
        folder = self.folder / "Recherchen"
        path = folder / f"{name}.md"
        number = 2
        with self._lock:
            while path.exists():
                path = folder / f"{name} ({number}).md"
                number += 1
            if not text.lstrip().startswith("#"):
                text = f"# {name}\n\n{text}"
            now = self._now()
            first, _, rest = text.partition("\n")
            text = f"{first}\n\n*Von Jarvis, {spoken_day(now.date())}. Zurück zum [[Start]].*\n{rest}"
            self._write(path, text.rstrip() + "\n")
        return path

    # ------------------------------------------------------------------ Lesen

    def day_text(self, day: dt.date) -> str:
        try:
            return self.day_path(day).read_text(encoding="utf-8")
        except OSError:
            return ""

    def search(self, words: str, limit: int = 20) -> list[tuple[str, int, str]]:
        """Zeilen, in denen alle Wörter vorkommen: (Datei, Zeile, Text), neueste Dateien zuerst."""
        wanted = [w for w in re.findall(r"[\wäöüß-]+", str(words).lower()) if len(w) > 1]
        if not wanted:
            return []
        try:
            files = sorted(self.folder.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:MAX_FILES]
        except OSError:
            return []
        hits = []
        for path in files:
            if any(part.startswith(".") for part in path.relative_to(self.folder).parts):
                continue  # .obsidian, .trash
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for number, line in enumerate(lines, 1):
                low = line.lower()
                if all(w in low for w in wanted):
                    hits.append((str(path.relative_to(self.folder)), number, line.strip()[:300]))
                    if len(hits) >= limit:
                        return hits
        return hits

    # ------------------------------------------------------------------ Übersicht

    def sync(self, memory=None) -> None:
        """Schreibt Start, Gedächtnis und Personen neu (nur Jarvis' Teil der Seiten)."""
        import time

        with self._lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            people = self._sync_people(memory) if memory is not None else []
            if memory is not None:
                self._sync_memory(memory)
            self._sync_start(people)
            self.last_sync = time.monotonic()

    def _page(self, path: Path, head: str, block: str) -> None:
        try:
            old = path.read_text(encoding="utf-8")
        except OSError:
            old = ""
        new = _replace_block(old, block, head)
        if new != old:
            self._write(path, new)

    def _sync_memory(self, memory) -> None:
        lines = [f"Stand: {self._now():%d.%m.%Y %H:%M}. Ändern oder löschen im Jarvis-Fenster (Gedächtnis).", ""]
        facts = memory.facts()
        lines.append(f"## Was Jarvis über {self._user} weiß")
        lines += [f"- {f.get('text', '')}" for f in facts] or ["- Noch nichts."]
        commands = memory.custom_commands()
        if commands:
            lines += ["", "## Eigene Befehle"]
            lines += [f"- **{c['name']}**: {c['aktion']}" for c in commands]
        routines = memory.routines()
        if routines:
            lines += ["", "## Gewohnheiten"]
            lines += [f"- {r.describe()}" for r in routines]
        self._page(self.folder / "Gedächtnis.md", "# Gedächtnis", "\n".join(lines))

    def _sync_people(self, memory) -> list[str]:
        people: dict[str, dict] = {}
        for contact in memory.contacts()[:40]:
            name = str(contact.get("name", "")).strip()
            if _proper_name(name):
                people.setdefault(name, {})["app"] = (contact.get("app", ""), contact.get("anzahl", 0))
        for birthday in memory.upcoming_birthdays(days=366):
            name = str(birthday.get("name") or "").strip()
            if not birthday.get("own") and _proper_name(name):
                people.setdefault(name, {})["birthday"] = birthday
        facts = [f.get("text", "") for f in memory.facts()]
        for name, info in sorted(people.items()):
            lines = []
            if info.get("app"):
                app, count = info["app"]
                if app:
                    lines.append(f"- Schreibt mit {self._user} über: {app.capitalize()}" + (f" ({count}-mal)" if count else ""))
            birthday = info.get("birthday")
            if birthday:
                day = dt.date.fromisoformat(birthday["datum"])
                lines.append(f"- Geburtstag: {day.day}. {MONTHS[day.month - 1]}")
            about = [f for f in facts if re.search(rf"\b{re.escape(name)}\b", f)]
            if about:
                lines.append(f"- Was Jarvis über {name} weiß:")
                lines += [f"  - {f}" for f in about[:20]]
            lines.append("")
            lines.append("Erwähnt im [[Start|Tagebuch]]: siehe Rückverweise unten in Obsidian.")
            self._page(self.folder / "Personen" / f"{safe_title(name)}.md", f"# {name}", "\n".join(lines))
        return sorted(people)

    def _sync_start(self, people: list[str]) -> None:
        def names(sub: str, limit: int) -> list[str]:
            try:
                files = sorted((self.folder / sub).glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
            except OSError:
                return []
            return [p.stem for p in files[:limit]]

        days = sorted(names("Tagebuch", 400), reverse=True)[:14]
        lines = ["## Letzte Tage"]
        lines += [f"- [[{d}]]" for d in days] or ["- Noch keine Gespräche."]
        lines += ["", "## Personen", " · ".join(f"[[{p}]]" for p in people) or "Noch keine."]
        reports = names("Recherchen", 20)
        lines += ["", "## Recherchen"]
        lines += [f"- [[{r}]]" for r in reports] or ["- Noch keine. Sag zum Beispiel: Recherchiere die besten Gaming-Mäuse."]
        notes = names("Notizen", 20)
        lines += ["", "## Notizen"]
        lines += [f"- [[{n}]]" for n in notes] or ["- Noch keine. Sag zum Beispiel: Notiere, Milch kaufen."]
        lines += ["", "[[Gedächtnis]]: was Jarvis über Sie weiß."]
        head = ("# Jarvis-Notizbuch\n\nHier schreibt Jarvis mit: jedes Gespräch im Tagebuch, was er über Sie weiß, "
                "Personen, Recherchen und Notizen. Tipp: Öffnen Sie diesen Ordner in Obsidian (kostenlos) mit "
                "\"Ordner als Tresor öffnen\", dann sehen Sie alles verlinkt.")
        self._page(self.folder / "Start.md", head, "\n".join(lines))


def _proper_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-ZÄÖÜ][\wäöüß-]{1,30}(?: [A-ZÄÖÜ][\wäöüß-]{1,30})?", name or ""))


def link_names(text: str, names: list[str]) -> str:
    """"Schreib Max, ..." -> "Schreib [[Max]], ...": So verbindet Obsidian Tage und Personen."""
    for name in sorted({n for n in names if _proper_name(n)}, key=len, reverse=True):
        text = re.sub(rf"(?<!\[)\b{re.escape(name)}\b(?!\])", f"[[{name}]]", text, count=1)
    return text


# ---------------------------------------------------------------------- Sätze

_CALL = r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:bitte\s+)?"
# "Notizblock öffnen" (Editor) und "Notierst du das?" sind keine Notiz; "Schreib auf WhatsApp an Max, ..." ist eine
# Nachricht. Darum ein ganzes Wort und bei "schreib auf" ein Doppelpunkt, Komma oder "dass" danach.
_NOTE = re.compile(
    _CALL + r"(?:(?:notiere|notier|notiz|schreib(?:e)?\s+(?:das\s+|es\s+|mir\s+)?(?:in|ins)\s+(?:mein\s+|das\s+|dein\s+)?"
    r"notizbuch)\b(?:\s+(?:bitte|mal|dir|mir))*\s*[:,]?|"
    r"schreib(?:e)?\s+(?:mir\s+)?auf(?:\s+(?:bitte|mal))*(?:\s*[:,]|(?=\s+(?:dass|wann|wo|was|wie)\b)))"
    r"\s*(?P<text>.{2,})$",
    re.I,
)
_OPEN = re.compile(
    _CALL + r"(?:(?:öffne|öffn|zeig|zeige)(?:\s+mir)?\s+(?:(?:mein|das|dein)\s+)?notizbuch|"
    r"(?:(?:mein|das|dein)\s+)?notizbuch\s+(?:öffnen|zeigen|anzeigen))(?:\s+bitte)?[\s.!]*$",
    re.I,
)
_FILLER_END = re.compile(r"(?:\s+(?:bitte|mal|jetzt|auf))+$", re.I)


def match_notebook(text: str):
    """("note", text) / ("open", "") / None"""
    raw = " ".join(str(text).split()).strip()
    if _OPEN.match(raw):
        return "open", ""
    found = _NOTE.match(raw)
    if found:
        note = found.group("text").strip(" .!")
        if len(note) >= 2 and _FILLER_END.sub("", note).lower() not in {"das", "es", "dies", "bitte", "das hier"}:
            return "note", note[:1].upper() + note[1:]
    return None
