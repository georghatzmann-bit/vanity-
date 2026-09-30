"""Das Gehirn: schickt Befehle an Claude Code (headless) und streamt die Antwort."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

# Unter Windows öffnet jeder Unterprozess sonst ein schwarzes Fenster,
# wenn Jarvis mit Oberfläche (ohne Konsole) läuft.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class BrainError(RuntimeError):
    """Claude hat nicht geantwortet. `kind` sagt, warum, `spoken` ist der Satz für Georg."""

    kind = "other"

    @property
    def spoken(self) -> str:
        return SPOKEN_ERRORS.get(self.kind, SPOKEN_ERRORS["other"])


class RefusalError(BrainError):
    """Claudes Sicherheitsfilter hat die Anfrage abgelehnt."""

    kind = "refusal"


class LimitError(BrainError):
    kind = "limit"


class LoginError(BrainError):
    kind = "login"


class NetworkError(BrainError):
    kind = "network"


class OverloadedError(BrainError):
    kind = "overloaded"


class TooSlowError(BrainError):
    kind = "timeout"


class NotInstalledError(BrainError):
    kind = "missing"


class Cancelled(BrainError):
    kind = "cancelled"


SPOKEN_ERRORS = {
    "refusal": (
        "Verzeihung, Sir, Claude lehnt das gerade ab, auch mit den anderen Modellen. "
        "Versuchen Sie es bitte anders formuliert, oder starten Sie einmal start.bat --claude-test."
    ),
    "limit": (
        "Ihr Claude-Kontingent ist gerade aufgebraucht, Sir. "
        "Es füllt sich in ein paar Stunden von selbst wieder auf."
    ),
    "login": (
        "Claude Code ist nicht angemeldet, Sir. Bitte in der Eingabeaufforderung "
        "einmal claude starten und mit Ihrem Pro-Konto anmelden."
    ),
    "network": "Ich erreiche Claude gerade nicht, Sir. Ist das Internet verbunden?",
    "overloaded": "Claude ist gerade überlastet, Sir. Versuchen Sie es bitte gleich noch einmal.",
    "timeout": "Das hat zu lange gedauert, Sir. Ich habe abgebrochen.",
    "missing": (
        "Ich finde Claude Code nicht, Sir. Bitte installieren Sie es und melden Sie sich einmal an."
    ),
    "cancelled": "Abgebrochen, Sir.",
    "other": "Verzeihung, Sir, da ist etwas schiefgelaufen. Die Details stehen in der Logdatei.",
}

_PATTERNS = [
    (RefusalError, re.compile(r"safeguard|usage polic|can't respond to your last message|\[cyber\]", re.I)),
    (LimitError, re.compile(r"usage limit|limit reached|rate.?limit|hit your limit|limit will reset|resets? at", re.I)),
    (LoginError, re.compile(r"/login|invalid api key|not logged in|log ?in again|oauth token|authenticat|unauthori[sz]ed|\b401\b", re.I)),
    (OverloadedError, re.compile(r"overloaded|\b529\b|over capacity", re.I)),
    (NetworkError, re.compile(r"connection error|unable to connect|enotfound|econnrefused|econnreset|etimedout|fetch failed|getaddrinfo|network|socket hang up|certificate", re.I)),
]

UNKNOWN_OPTION = re.compile(r"unknown option '--([\w-]+)'", re.I)

# Kurze Persönlichkeit für den Notfall, wenn der volle Jarvis-Text abgelehnt wird.
SIMPLE_PERSONA = (
    "Du bist Jarvis, ein freundlicher Assistent. Antworte immer auf Deutsch, "
    "in ein bis drei kurzen Sätzen, ohne Markdown, und sprich den Nutzer mit Sir an."
)


def classify(message: str) -> type[BrainError]:
    for error, pattern in _PATTERNS:
        if pattern.search(message):
            return error
    return BrainError


@dataclass
class Answer:
    text: str
    model: str = ""
    session_id: str = ""


@dataclass(frozen=True)
class Attempt:
    model: str
    profile: str  # "jarvis" = volle Persönlichkeit, "einfach" = kurze Notfall-Persönlichkeit

    def label(self) -> str:
        name = self.model or "Standardmodell"
        return name if self.profile == "jarvis" else f"{name}, einfacher Modus"


class ClaudeBrain:
    """Spricht mit `claude -p` und streamt die Antwort Wort für Wort.

    Im abgeschotteten Modus (isolated) startet Claude Code mit --safe-mode, also
    ohne die persönlichen Skills, Plugins, MCP-Server und CLAUDE.md-Dateien des
    Nutzers, und die Persönlichkeit aus jarvis_home/CLAUDE.md kommt als
    Systemprompt. Lehnt ein Modell ab, versucht Jarvis das nächste aus `models`,
    danach dieselben Modelle mit einer ganz kurzen Persönlichkeit. Was zuletzt
    funktioniert hat, merkt sich Jarvis für die nächsten Stunden.
    """

    REMEMBER_SECONDS = 12 * 3600

    def __init__(self, cfg: dict, home: Path, state_dir: Path | None = None, persona: Path | None = None) -> None:
        self._claude = cfg.get("claude_path") or shutil.which("claude")
        if not self._claude:
            raise NotInstalledError(
                "Claude Code wurde nicht gefunden. Installiere es und melde dich einmal mit 'claude' an."
            )
        models = [m for m in (cfg.get("models") or [cfg.get("model", "")]) if m] or [""]
        profiles = ["jarvis", "einfach"] if cfg.get("simple_fallback", True) else ["jarvis"]
        self.attempts = [Attempt(m, p) for p in profiles for m in models]
        self._index = 0
        self._isolated = cfg.get("isolated", True)
        self._timeout = cfg.get("timeout_seconds", 180)
        self._tools = cfg.get("tools", [])
        self._allowed = cfg.get("allowed_tools", [])
        self._disallowed = cfg.get("disallowed_tools", [])
        self._home = home
        self._persona = persona or home / "CLAUDE.md"
        self._state_file = (state_dir / "gehirn.json") if state_dir else None
        self._unsupported: set[str] = set()
        self._session: str | None = None
        self._proc: subprocess.Popen | None = None
        self._cancelled = False
        self.last_model = ""
        self.notice: Callable[[str], None] = lambda text: log.info("%s", text)
        self._load_state()

    # ------------------------------------------------------------------ Zustand

    @property
    def attempt(self) -> Attempt:
        return self.attempts[self._index]

    @property
    def model(self) -> str:
        return self.attempt.model

    @property
    def isolated(self) -> bool:
        return self._isolated and not ({"safe-mode", "system-prompt-file"} & self._unsupported)

    def new_conversation(self) -> None:
        self._session = None

    def cancel(self) -> None:
        """Bricht die laufende Anfrage ab (z. B. bei "Stopp")."""
        self._cancelled = True
        proc = self._proc
        if proc and proc.poll() is None:
            _kill(proc)

    def _load_state(self) -> None:
        if not self._state_file or not self._state_file.exists():
            return
        try:
            data = json.loads(self._state_file.read_text(encoding="utf-8"))
            if time.time() - data.get("zeit", 0) > self.REMEMBER_SECONDS:
                return
            wanted = Attempt(data["modell"], data["modus"])
            if wanted in self.attempts:
                self._index = self.attempts.index(wanted)
        except Exception as exc:
            log.debug("Gehirn-Zustand nicht lesbar: %s", exc)

    def _save_state(self) -> None:
        if not self._state_file:
            return
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            data = {"modell": self.attempt.model, "modus": self.attempt.profile, "zeit": time.time()}
            self._state_file.write_text(json.dumps(data), encoding="utf-8")
        except OSError as exc:
            log.debug("Gehirn-Zustand nicht speicherbar: %s", exc)

    # ------------------------------------------------------------------ Aufruf

    def command(
        self,
        attempt: Attempt | None = None,
        isolated: bool | None = None,
        session: str | None = None,
        resume: bool = False,
    ) -> list[str]:
        attempt = attempt or self.attempt
        isolated = self.isolated if isolated is None else isolated
        cmd = [self._claude, "-p", "--output-format", "stream-json", "--verbose"]
        if "include-partial-messages" not in self._unsupported:
            cmd.append("--include-partial-messages")
        if attempt.model:
            cmd += ["--model", attempt.model]
        if isolated:
            cmd.append("--safe-mode")
            if attempt.profile == "jarvis":
                cmd += ["--system-prompt-file", str(self._persona)]
            else:
                cmd += ["--append-system-prompt", SIMPLE_PERSONA]
        elif attempt.profile == "einfach":
            cmd += ["--append-system-prompt", SIMPLE_PERSONA]
        if self._tools and "tools" not in self._unsupported:
            # Nur die Werkzeuge, die Jarvis braucht: schneller und weniger Ablenkung.
            cmd += ["--tools", *self._tools]
        if self._allowed:
            cmd += ["--allowedTools", *self._allowed]
        if self._disallowed:
            cmd += ["--disallowedTools", *self._disallowed]
        if session:
            if "session-id" in self._unsupported:
                if resume:
                    cmd.append("--continue")
            elif resume:
                cmd += ["--resume", session]
            else:
                cmd += ["--session-id", session]
        return cmd

    def environment(self, text: str) -> dict:
        """Umgebung für Claude: damit `python -m jarvis.tool ...` im Jarvis-Ordner
        mit Jarvis' eigenem Python funktioniert."""
        from .config import ROOT

        env = dict(os.environ)
        python_dir = str(Path(sys.executable).parent)
        env["PATH"] = python_dir + os.pathsep + env.get("PATH", "")
        env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["JARVIS_ROOT"] = str(ROOT)
        env["JARVIS_USER_SAID"] = text[:500]
        return env

    def ask(self, text: str, on_text: Callable[[str], None] | None = None) -> Answer:
        """Fragt Claude. `on_text` bekommt die Antwort Stück für Stück, sobald sie
        entsteht. Bei einer Ablehnung kommt der nächste Versuch aus `attempts` dran,
        in einer neuen Unterhaltung, und dabei bleibt es danach."""
        self._cancelled = False
        overload_retry = True
        while True:
            try:
                answer = self._ask_once(text, on_text=on_text)
                self._save_state()
                return answer
            except RefusalError:
                self._session = None
                if self._index + 1 >= len(self.attempts):
                    # Alles probiert: beim nächsten Mal wieder vorne anfangen.
                    self._index = 0
                    raise
                refused = self.attempt
                self._index += 1
                self.notice(f"{refused.label()} hat abgelehnt, versuche {self.attempt.label()} ...")
            except OverloadedError:
                if not overload_retry:
                    raise
                overload_retry = False
                self.notice("Claude ist überlastet, versuche es gleich noch einmal ...")
                time.sleep(2)

    def _ask_once(
        self,
        text: str,
        attempt: Attempt | None = None,
        isolated: bool | None = None,
        on_text: Callable[[str], None] | None = None,
        keep_session: bool = True,
    ) -> Answer:
        attempt = attempt or self.attempt
        resume = keep_session and self._session is not None
        session = self._session if resume else str(uuid.uuid4())
        for _ in range(4):
            cmd = self.command(attempt, isolated, session if keep_session else None, resume)
            result, stderr, spoke, stream_model = self._run(cmd, text, on_text)
            unknown = UNKNOWN_OPTION.search(stderr or "")
            if result is None and unknown and not spoke and unknown.group(1) not in self._unsupported:
                flag = unknown.group(1)
                self._unsupported.add(flag)
                log.warning(
                    "Diese Claude-Code-Version kennt --%s noch nicht. "
                    "Bitte in der Eingabeaufforderung 'claude update' ausführen.",
                    flag,
                )
                continue
            if result is None and resume and re.search(r"no conversation found|session.*not found", stderr or "", re.I):
                # Die alte Unterhaltung gibt es nicht mehr, also neu anfangen.
                resume, session = False, str(uuid.uuid4())
                continue
            break

        if self._cancelled:
            raise Cancelled("abgebrochen")
        if result is None:
            detail = (stderr or "").strip()[-600:] or "keine Ausgabe"
            error = classify(detail)
            raise error(f"Claude Code meldet einen Fehler: {detail}")
        if result.get("is_error") or result.get("subtype", "success") != "success":
            message = str(result.get("result") or result.get("subtype") or "Unbekannter Fehler")
            error = classify(message)
            if error is RefusalError:
                self._session = None
            raise error(message)

        if keep_session:
            self._session = result.get("session_id") or session
        # modelUsage enthält auch Hilfsmodelle (z. B. Haiku für Titel). Das eigentliche
        # Modell nennt Claude Code beim Start (init).
        used = list(result.get("modelUsage") or {})
        self.last_model = stream_model or (used[0] if used else attempt.model or "")
        return Answer(str(result.get("result") or "").strip(), self.last_model, self._session or "")

    def _run(self, cmd: list[str], text: str, on_text) -> tuple[dict | None, str, bool, str]:
        """Startet Claude, liest den Stream und gibt (Ergebnis, stderr, schon_gesprochen, Modell) zurück."""
        log.debug("Claude-Aufruf: %s", " ".join(cmd[1:]))
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self._home,
                env=self.environment(text),
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=NO_WINDOW,
            )
        except FileNotFoundError as exc:
            raise NotInstalledError(f"Claude Code nicht startbar: {exc}") from exc
        except OSError as exc:
            raise BrainError(f"Claude Code nicht startbar: {exc}") from exc
        self._proc = proc

        stderr_parts: list[str] = []
        reader = threading.Thread(target=lambda: stderr_parts.append(proc.stderr.read()), daemon=True)
        reader.start()
        timed_out = threading.Event()

        def on_timeout() -> None:
            timed_out.set()
            _kill(proc)

        timer = threading.Timer(self._timeout, on_timeout)
        timer.daemon = True
        timer.start()

        # Die Frage geht über stdin, damit gesprochener Text nie als
        # Kommandozeile interpretiert wird.
        try:
            proc.stdin.write(text)
            proc.stdin.close()
        except OSError:
            pass

        stream = _StreamReader(on_text, partial="include-partial-messages" not in self._unsupported)
        try:
            for line in proc.stdout:
                stream.feed(line)
        finally:
            timer.cancel()
            proc.wait()
            reader.join(timeout=5)
            self._proc = None

        stderr = "".join(stderr_parts)
        log.debug(
            "Claude fertig nach %.1f s, Exit %s, Modell %s", time.monotonic() - started,
            proc.returncode, stream.model,
        )
        if stderr.strip():
            log.debug("Claude stderr: %s", stderr.strip()[-1000:])
        if timed_out.is_set():
            raise TooSlowError("Claude hat zu lange gebraucht.")
        if stream.result is None and stream.errors:
            # Kein Ergebnis, aber Fehlermeldungen im Stream (z. B. API-Fehler).
            stderr = "\n".join(stream.errors) + "\n" + stderr
        return stream.result, stderr, stream.spoke, stream.model

    # ------------------------------------------------------------------ Diagnose

    def diagnose(self, text: str = "hi") -> list[tuple[str, str, str]]:
        """Probiert jedes Modell mit und ohne persönliche Erweiterungen.
        Gibt (Modell, Modus, Ergebnis) zurück."""
        rows = []
        models = list(dict.fromkeys(a.model for a in self.attempts))
        for model in models:
            for isolated in (False, True):
                mode = "ohne Erweiterungen" if isolated else "mit deinen Einstellungen"
                rows.append((model or "Standard", mode, self._probe(text, Attempt(model, "jarvis"), isolated)))
        return rows

    def _probe(self, text: str, attempt: Attempt, isolated: bool) -> str:
        try:
            answer = self._ask_once(text, attempt, isolated, keep_session=False)
            return f"OK ({answer.model})"
        except RefusalError:
            return "ABGELEHNT"
        except BrainError as exc:
            return f"FEHLER: {str(exc)[:120]}"


class _StreamReader:
    """Wertet die Zeilen von `--output-format stream-json` aus."""

    def __init__(self, on_text, partial: bool) -> None:
        self._on_text = on_text
        self._partial = partial
        self._any_text = False
        self.spoke = False
        self.result: dict | None = None
        self.model = ""
        self.errors: list[str] = []

    def feed(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            self.errors.append(line[:500])
            return
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        if kind == "result":
            self.result = event
        elif kind == "system" and event.get("subtype") == "init":
            self.model = event.get("model", "")
        elif kind == "stream_event" and self._partial:
            self._stream_event(event.get("event") or {})
        elif kind == "assistant":
            self._assistant(event.get("message") or {})

    def _stream_event(self, event: dict) -> None:
        etype = event.get("type")
        if etype == "content_block_start" and (event.get("content_block") or {}).get("type") == "text":
            if self._any_text:
                # Neuer Textblock (z. B. nach einem Werkzeug): Satzgrenze erzwingen.
                self._emit("\n\n")
        elif etype == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                self._any_text = True
                self._emit(delta["text"])

    def _assistant(self, message: dict) -> None:
        texts = [
            block.get("text", "")
            for block in message.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        text = "".join(texts)
        if not text:
            return
        if message.get("model") == "<synthetic>" or text.startswith("API Error"):
            # Fehlermeldungen von Claude Code selbst werden nie vorgelesen.
            self.errors.append(text)
            return
        if self._partial:
            return  # schon über die Teilstücke gekommen
        if self._any_text:
            self._emit("\n\n")
        self._any_text = True
        self._emit(text)

    def _emit(self, text: str) -> None:
        if self._on_text:
            if text.strip():
                self.spoke = True
            self._on_text(text)


def _kill(proc: subprocess.Popen) -> None:
    """Beendet Claude samt Unterprozessen (unter Windows sonst bleiben Reste hängen)."""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                creationflags=NO_WINDOW,
            )
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
