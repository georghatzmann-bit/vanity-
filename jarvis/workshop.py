"""Die Werkstatt: Programmier- und Bauaufgaben, die Jarvis im Hintergrund erledigt.

"Bau mir einen Discord-Bot, der ..." landet nicht im normalen Gespräch, sondern hier:
eigener Projektordner, gründlicheres Nachdenken, ein Plan mit Schritten (TodoWrite),
Dateien schreiben, Pakete installieren, testen. Das Fenster zeigt alles als Blaupause.
Währenddessen bleibt Jarvis ansprechbar; ist die Arbeit fertig, sagt er Bescheid.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import queue
import re
import subprocess
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

WORKSHOP_PROMPT = """

## Werkstatt-Modus

Du arbeitest gerade in deiner Werkstatt an einer Programmier- oder Bauaufgabe für Georg. Er sieht
dir im Fenster zu, jeder Schritt erscheint dort.
- Projektordner: {folder}
  Lege alles dort an und arbeite nur dort.
- Arbeite selbstständig, bis es fertig ist und läuft. Frag nicht nach, triff vernünftige Entscheidungen.
- Mach zuerst mit TodoWrite einen kurzen Plan mit drei bis sieben Schritten und hake sie ab.
- Teste, was du baust (starten, Tests laufen lassen), und behebe Fehler selbst.
- Fehlen Pakete, installiere sie (pip, npm, winget).
- Lege eine kurze LIESMICH.txt an: was es ist und wie man es startet.
- Zum Schluss genau zwei oder drei kurze Sätze für Georg, auf Deutsch, ohne Markdown: was du gebaut
  hast und wie er es startet. Das wird vorgelesen.
"""

# "Bau mir einen Discord-Bot", "Programmier ein Spiel", "Schreib ein Python-Skript, das ..."
# Eine bloße "Datei" oder "Seite" ("Erstelle eine Datei auf dem Desktop", "Mach mir eine neue Seite
# in Chrome") ist keine Bauaufgabe; als "Batch-Datei" oder "Webseite" schon.
_THING = (
    r"(?:(?:python[- ]?|powershell[- ]?|batch[- ]?|discord[- ]?|web[- ]?|minecraft[- ]?|kleine[ns]? |"
    r"einfache[ns]? |neue[ns]? |eigene[ns]? )*"
    r"(?:skript|script|programm|tool|bot|app|anwendung|website|webseite|homepage|spiel|game|mod|"
    r"plugin|addon|add-on|projekt|code|rechner|taschenrechner|dashboard|overlay|launcher|"
    r"installer|automatisierung|makro)\w*"
    r"|(?:python|powershell|batch|web|html|internet)[- ]?(?:datei|seite)\w*)"
)
_WORKSHOP = [
    re.compile(r"^(?:(?:kannst|könntest) du (?:mir )?)?(?:programmier|programmiere|entwickel|entwickle|code|coden)\b"),
    re.compile(
        r"^(?:(?:kannst|könntest) du (?:mir )?)?(?:schreib|schreibe|bau|baue|erstell|erstelle|mach|mache|"
        r"programmier|programmiere|entwickel|entwickle)\s+(?:mir |uns )?(?:ein|eine|einen|nen|ne)\s+" + _THING
    ),
    re.compile(
        r"^(?:kannst|könntest|würdest) du (?:mir |uns )?(?:bitte )?(?:ein|eine|einen|nen|ne)\s+" + _THING +
        r".*\b(?:bauen|schreiben|programmieren|erstellen|machen|entwickeln|coden)$"
    ),
    re.compile(r"\bwerkstatt\b"),
    re.compile(r"^(?:fix|fixe|behebe|reparier|repariere)\s+(?:den |die |das )?(?:fehler|bug|code|skript|programm)\b"),
]


def is_workshop_request(text: str) -> bool:
    norm = " ".join(re.sub(r"[.,!?;:\"'„“”]", " ", text.lower()).split())
    norm = re.sub(r"^(?:(?:hey|hallo|okay|ok) )?jarvis ", "", norm)
    norm = re.sub(r"^(?:bitte |mal |jetzt )+", "", norm)
    # "Mach mir ein Spiel an" heißt starten, nicht bauen.
    if re.match(r"^(?:mach|mache)\b.*\b(?:an|auf|aus|zu)$", norm):
        return False
    # Fragen ("Wie weit ist die Werkstatt?") starten keinen neuen Auftrag.
    if text.strip().endswith("?") or re.match(r"^(?:wie|was|wo|wann|warum|ist|bist|läuft|hast)\b", norm):
        return any(p.search(norm) for p in _WORKSHOP if p.pattern != r"\bwerkstatt\b")
    return any(p.search(norm) for p in _WORKSHOP)


def project_folder(task: str, base: Path, now: dt.datetime | None = None) -> Path:
    """Ein neuer Ordner pro Auftrag: 2026-10-01_1530_discord-bot"""
    now = now or dt.datetime.now()
    words = re.findall(r"[a-zäöüß0-9]+", task.lower())
    skip = {
        "bau", "baue", "mir", "uns", "ein", "eine", "einen", "nen", "ne", "bitte", "mal", "jarvis", "hey",
        "schreib", "schreibe", "erstell", "erstelle", "mach", "mache", "programmier", "programmiere",
        "der", "die", "das", "den", "dem", "und", "mit", "für", "fur", "kannst", "du", "könntest",
        "entwickel", "entwickle", "kleinen", "kleines", "kleine", "einfachen", "einfaches", "neuen", "neues",
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


@dataclass
class Job:
    task: str
    folder: Path
    started: float = field(default_factory=time.monotonic)
    steps: list = field(default_factory=list)
    todos: list = field(default_factory=list)
    text: str = ""
    state: str = "running"  # running, done, error, cancelled
    summary: str = ""

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
        self.base = Path(base).expanduser() if base else Path.home() / "Jarvis-Werkstatt"
        self.job: Job | None = None
        self._proc: subprocess.Popen | None = None
        self._cancelled = False
        self._lock = threading.Lock()

    @property
    def busy(self) -> bool:
        return self.job is not None and self.job.state == "running"

    def start(self, task: str) -> str:
        """Startet einen Auftrag im Hintergrund. Gibt den Satz zurück, den Jarvis dazu sagt."""
        with self._lock:
            if self.busy:
                return f"Ich arbeite noch am vorigen Auftrag, Sir. {self.job.status()}"
            if self._brain is None or not getattr(self._brain, "claude_path", ""):
                return "Für die Werkstatt brauche ich mein Gehirn, Sir. Bitte öffnen Sie einmal die Einstellungen."
            folder = project_folder(task, self.base)
            self.job = Job(task, folder)
            self._cancelled = False
        self._ui.workshop({"state": "start", "task": task, "folder": str(folder)})
        if self._show_window is not None:
            try:
                self._show_window()
            except Exception as exc:
                log.debug("Werkstatt-Fenster: %s", exc)
        threading.Thread(target=self._work, args=(self.job,), name="jarvis-werkstatt", daemon=True).start()
        return "Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen."

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

    def status(self) -> str:
        if self.job is None:
            return "In der Werkstatt ist gerade nichts los, Sir."
        if self.job.state == "running":
            return self.job.status()
        return f"Der letzte Auftrag ist {'fertig' if self.job.state == 'done' else 'abgebrochen'}, Sir. {self.job.summary}".strip()

    # ------------------------------------------------------------------ Arbeit

    def _persona(self, folder: Path) -> Path:
        brain = self._brain
        base = Path(getattr(brain, "persona_path", "") or "")
        text = base.read_text(encoding="utf-8") if base.is_file() else "Du bist Jarvis, Georgs Assistent."
        path = Path(getattr(brain, "state_dir", folder) or folder) / "werkstatt-persoenlichkeit.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + WORKSHOP_PROMPT.format(folder=folder), encoding="utf-8")
        return path

    def command(self, folder: Path, persona: Path) -> list[str]:
        brain = self._brain
        model = str(self._cfg.get("modell", "sonnet") or "")
        effort = str(self._cfg.get("effort", "medium") or "")
        cmd = [brain.claude_path, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if model:
            cmd += ["--model", model]
        if effort:
            cmd += ["--effort", effort]
        if getattr(brain, "isolated", True):
            cmd.append("--safe-mode")
        cmd += ["--system-prompt-file", str(persona)]
        cmd += ["--tools", *WORKSHOP_TOOLS, "--allowedTools", *WORKSHOP_TOOLS]
        disallowed = list(getattr(brain, "disallowed_tools", []) or [])
        if disallowed:
            cmd += ["--disallowedTools", *disallowed]
        cmd += ["--permission-mode", "acceptEdits", "--add-dir", str(folder), "--session-id", str(uuid.uuid4())]
        return cmd

    def _work(self, job: Job) -> None:
        from .brain import NO_WINDOW, _kill, _pump, _StreamReader, with_time

        started = time.monotonic()
        try:
            job.folder.mkdir(parents=True, exist_ok=True)
            persona = self._persona(job.folder)
            cmd = self.command(job.folder, persona)
            log.info("Werkstatt startet in %s: %s", job.folder, job.task)
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=job.folder,
                env=self._brain.environment(job.task), text=True, encoding="utf-8", errors="replace",
                creationflags=NO_WINDOW,
            )
        except Exception as exc:
            log.exception("Werkstatt startet nicht")
            self._finish(job, "error", f"Die Werkstatt ließ sich nicht starten, Sir. {exc}")
            return
        self._proc = proc
        lines: queue.Queue = queue.Queue()
        errors: list = []
        threading.Thread(target=_pump, args=(proc.stdout, lines.put), daemon=True).start()
        threading.Thread(target=_pump, args=(proc.stderr, errors.append), daemon=True).start()
        try:
            proc.stdin.write(with_time(job.task))
            proc.stdin.close()
        except OSError:
            pass

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
        self._proc = None

        if self._cancelled:
            self._finish(job, "cancelled", "Die Arbeit in der Werkstatt ist abgebrochen, Sir.")
            return
        if timed_out:
            self._finish(job, "error", "In der Werkstatt hat sich zu lange nichts getan, Sir. Ich habe abgebrochen.")
            return
        result = stream.result or {}
        if not result or result.get("is_error"):
            detail = str(result.get("result") or "".join(e for e in errors if e) or "keine Ausgabe")[-600:]
            log.warning("Werkstatt-Fehler: %s", detail)
            self._finish(job, "error", "In der Werkstatt ist etwas schiefgegangen, Sir. Die Einzelheiten stehen im Fenster.", detail)
            return
        summary = str(result.get("result") or job.text).strip()
        self._finish(job, "done", summary)

    def _finish(self, job: Job, state: str, summary: str, detail: str = "") -> None:
        from .text import speakable

        job.summary = speakable(summary) or summary
        seconds = round(time.monotonic() - job.started)
        self._ui.workshop({
            "state": state, "summary": summary, "detail": detail, "folder": str(job.folder), "seconds": seconds,
        })
        log.info("Werkstatt %s nach %d s: %s", state, seconds, summary[:300])
        save_log(job, state)
        spoken = job.summary
        if state == "done":
            first = re.split(r"(?<=[.!?])\s+", spoken)
            spoken = " ".join(first[:3])
            spoken = f"Aus der Werkstatt: {spoken}"
        self._announce(spoken)
        job.state = state  # erst jetzt: wer auf das Ende wartet, hat dann auch die Ansage


def save_log(job: Job, state: str = "") -> None:
    """Schreibt den Ablauf in den Projektordner (werkstatt-protokoll.json)."""
    try:
        data = {"auftrag": job.task, "zustand": state or job.state, "zusammenfassung": job.summary,
                "schritte": [s.to_dict() for s in job.steps], "plan": job.todos}
        (job.folder / "werkstatt-protokoll.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        log.debug("Werkstatt-Protokoll: %s", exc)
