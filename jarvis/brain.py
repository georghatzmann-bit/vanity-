"""Das Gehirn: schickt Befehle an Claude Code (headless) und streamt die Antwort."""

from __future__ import annotations

import json
import logging
import os
import queue
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


class ModelUnavailableError(BrainError):
    """Das Modell gibt es für dieses Konto gerade nicht (dann kommt das nächste dran)."""

    kind = "model"


class AccountError(BrainError):
    """Das Claude-Konto braucht Aufmerksamkeit (gesperrt, Bestätigung nötig)."""

    kind = "account"


class BillingError(BrainError):
    kind = "billing"


class Cancelled(BrainError):
    kind = "cancelled"


SPOKEN_ERRORS = {
    "refusal": (
        "Verzeihung, Sir, Claude lehnt das gerade ab, auch mit den anderen Modellen. "
        "Versuchen Sie es bitte anders formuliert, oder starten Sie einmal den Claude-Test im Ordner werkzeuge."
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
    "model": "Kein Claude-Modell steht Ihnen gerade zur Verfügung, Sir.",
    "account": "Ihr Claude-Konto meldet ein Problem, Sir. Bitte schauen Sie einmal auf claude.ai nach.",
    "billing": (
        "Claude meldet ein Abrechnungsproblem, Sir. Vermutlich ist Claude Code mit einem API-Schlüssel "
        "statt mit Ihrem Pro-Abo angemeldet."
    ),
    "other": "Verzeihung, Sir, Claude hat einen Fehler gemeldet. Die Einzelheiten stehen im Fenster und in der Logdatei.",
}

_PATTERNS = [
    (
        RefusalError,
        re.compile(
            r"safeguard|usage polic|can.?t respond to (your last|this) message|can.?t help with this"
            r"|flagged this (message|session|request)|anthropic\.com/legal/aup|\[cyber\]",
            re.I,
        ),
    ),
    (ModelUnavailableError, re.compile(r"issue with the selected model|may not exist or you may not have access|is not available on your", re.I)),
    (BillingError, re.compile(r"credit balance|billing", re.I)),
    (AccountError, re.compile(r"account (is )?(on hold|suspended|disabled)|organization (has been )?disabled|verification required|verify your", re.I)),
    (LimitError, re.compile(r"usage limit|limit reached|rate.?limit|hit your limit|limit will reset|resets? at", re.I)),
    (LoginError, re.compile(r"/login|invalid api key|not logged in|log ?in again|oauth token|authenticat|unauthori[sz]ed|\b401\b", re.I)),
    (OverloadedError, re.compile(r"overloaded|\b529\b|over capacity", re.I)),
    (NetworkError, re.compile(r"connection error|unable to connect|enotfound|econnrefused|econnreset|etimedout|fetch failed|getaddrinfo|network|socket hang up|certificate", re.I)),
]

# Die Fehlerart, die Claude Code bei API-Fehlern mitschickt (Feld "error" der Nachricht).
ERROR_KINDS: dict[str, type[BrainError]] = {
    "authentication_failed": LoginError,
    "oauth_org_not_allowed": LoginError,
    "account_on_hold": AccountError,
    "verification_required": AccountError,
    "billing_error": BillingError,
    "rate_limit": LimitError,
    "overloaded": OverloadedError,
    "server_error": OverloadedError,
    "model_not_found": ModelUnavailableError,
}

# Bei diesen Fehlern kommt der nächste Versuch (anderes Modell, einfachere Einstellung) dran.
NEXT_ATTEMPT = (RefusalError, ModelUnavailableError)

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
    # "jarvis" = volle Persönlichkeit, "einfach" = kurze Notfall-Persönlichkeit,
    # "reden" = kurze Persönlichkeit ganz ohne Werkzeuge (letzter Ausweg: nur Unterhaltung)
    profile: str

    def label(self) -> str:
        name = self.model[:1].upper() + self.model[1:] if self.model else "Standardmodell"
        if self.profile == "einfach":
            return f"{name}, einfacher Modus"
        if self.profile == "reden":
            return f"{name}, nur Unterhaltung"
        return name


@dataclass
class Run:
    """Was ein Aufruf von Claude Code geliefert hat."""

    result: dict | None
    stderr: str = ""
    spoke: bool = False
    model: str = ""
    refused: bool = False
    error_kind: str = ""
    errors: list[str] | None = None
    returncode: int | None = None

    @property
    def failed(self) -> bool:
        r = self.result
        return r is None or bool(r.get("is_error")) or r.get("subtype", "success") != "success"

    def error_text(self) -> str:
        """Alles, was Claude Code zum Fehler gesagt hat, ohne Wiederholungen."""
        parts: list[str] = []
        r = self.result or {}
        text = r.get("result")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
        for item in r.get("errors") or []:
            if isinstance(item, dict):
                item = item.get("message") or item.get("error") or json.dumps(item, ensure_ascii=False)
            if str(item).strip():
                parts.append(str(item).strip())
        parts += [e.strip() for e in (self.errors or []) if e and e.strip()]
        if self.stderr.strip():
            parts.append(self.stderr.strip()[-600:])
        if not parts and r.get("subtype") not in (None, "success"):
            parts.append(str(r.get("subtype")))
        unique = list(dict.fromkeys(parts))
        return "\n".join(unique) if unique else f"keine Ausgabe (Exit {self.returncode})"

    def error_class(self, text: str) -> type[BrainError]:
        if self.refused:
            return RefusalError
        guessed = classify(text)
        if guessed is RefusalError:
            return guessed
        return ERROR_KINDS.get(self.error_kind) or guessed


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
        self._claude = find_claude(cfg)
        if not self._claude:
            raise NotInstalledError(
                "Claude Code wurde nicht gefunden. Installiere es und melde dich einmal mit 'claude' an."
            )
        models = [m for m in (cfg.get("models") or [cfg.get("model", "")]) if m] or [""]
        profiles = ["jarvis", "einfach"] if cfg.get("simple_fallback", True) else ["jarvis"]
        self.attempts = [Attempt(m, p) for p in profiles for m in models]
        if cfg.get("simple_fallback", True):
            # Ganz zum Schluss: nur reden, ohne Werkzeuge. Dann kann Jarvis zwar nichts am PC
            # tun, aber wenigstens antworten.
            self.attempts.append(Attempt("haiku" if "haiku" in models else models[0], "reden"))
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
        self._without_api_key = False
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
        elif attempt.profile != "jarvis":
            cmd += ["--append-system-prompt", SIMPLE_PERSONA]
        if attempt.profile == "reden" and "tools" not in self._unsupported:
            cmd += ["--tools", ""]  # gar keine Werkzeuge
        else:
            if self._tools and "tools" not in self._unsupported:
                # Nur die Werkzeuge, die Jarvis braucht: schneller und weniger Ablenkung.
                cmd += ["--tools", *self._tools]
            if self._allowed:
                cmd += ["--allowedTools", *self._allowed]
        if self._disallowed and attempt.profile != "reden":
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
        if self._without_api_key:
            # Ein alter API-Schlüssel in den Windows-Umgebungsvariablen hat Vorrang vor dem
            # Pro-Abo. Ohne ihn meldet sich Claude Code mit dem Abo an.
            for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
                env.pop(name, None)
        return env

    def ask(self, text: str, on_text: Callable[[str], None] | None = None) -> Answer:
        """Fragt Claude. `on_text` bekommt die Antwort Stück für Stück, sobald sie
        entsteht. Bei einer Ablehnung kommt der nächste Versuch aus `attempts` dran,
        in einer neuen Unterhaltung, und dabei bleibt es danach."""
        self._cancelled = False
        rescue_from: list[int] = []
        try:
            return self._ask_chain(text, on_text, rescue_from)
        except BrainError:
            if rescue_from:
                # Auch der Notfall-Versuch hat nicht geholfen: nächstes Mal wie vorher.
                self._index = rescue_from[0]
            raise

    def _ask_chain(self, text: str, on_text, rescue_from: list[int]) -> Answer:
        overload_retry = True
        while True:
            try:
                answer = self._ask_once(text, on_text=on_text)
                self._save_state()
                return answer
            except NEXT_ATTEMPT as exc:
                self._session = None
                if self._index + 1 >= len(self.attempts):
                    # Alles probiert: beim nächsten Mal wieder vorne anfangen.
                    rescue_from[:] = [0]
                    raise
                failed = self.attempt
                self._index += 1
                why = "hat abgelehnt" if isinstance(exc, RefusalError) else "ist nicht verfügbar"
                self.notice(f"{failed.label()} {why}, versuche {self.attempt.label()} ...")
            except OverloadedError:
                if not overload_retry:
                    raise
                overload_retry = False
                self.notice("Claude ist überlastet, versuche es gleich noch einmal ...")
                time.sleep(2)
            except (LoginError, BillingError):
                if self._without_api_key or not _api_key_set():
                    raise
                # Ein API-Schlüssel aus den Umgebungsvariablen verdrängt das Pro-Abo.
                self._without_api_key = True
                self.notice("Claude Code nutzt einen API-Schlüssel statt deines Abos, versuche es mit dem Abo ...")
            except BrainError as exc:
                if type(exc) is not BrainError or rescue_from:
                    raise  # Kontingent, Netz, Konto, Abbruch ...: ein anderer Versuch hilft nicht
                # Unbekannter Fehler: einmal ganz einfach probieren (kurze Persönlichkeit, keine
                # Werkzeuge). Klappt das, bleibt Jarvis dabei, bis wieder alles geht.
                rescue = next((i for i, a in enumerate(self.attempts) if a.profile == "reden"), None)
                if rescue is None or rescue == self._index:
                    raise
                rescue_from.append(self._index)
                failed = self.attempt
                self._session = None
                self._index = rescue
                self.notice(f"{failed.label()} meldet einen Fehler, versuche {self.attempt.label()} ...")

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
            run = self._run(cmd, text, on_text)
            result, stderr = run.result, run.stderr
            unknown = UNKNOWN_OPTION.search(stderr or "")
            if result is None and unknown and not run.spoke and unknown.group(1) not in self._unsupported:
                flag = unknown.group(1)
                self._unsupported.add(flag)
                log.warning(
                    "Diese Claude-Code-Version kennt --%s noch nicht. "
                    "Bitte in der Eingabeaufforderung 'claude update' ausführen.",
                    flag,
                )
                if flag in ("safe-mode", "system-prompt-file", "tools"):
                    self.notice(
                        "Claude Code ist veraltet, deshalb laufen deine eigenen Skills mit. "
                        "Bitte einmal 'claude update' in der Eingabeaufforderung ausführen."
                    )
                continue
            if result is None and resume and re.search(r"no conversation found|session.*not found", stderr or "", re.I):
                # Die alte Unterhaltung gibt es nicht mehr, also neu anfangen.
                resume, session = False, str(uuid.uuid4())
                continue
            break

        if self._cancelled:
            raise Cancelled("abgebrochen")
        if run.failed:
            detail = run.error_text()
            error = run.error_class(detail)
            log.warning(
                "Claude meldet einen Fehler (%s, %s, Exit %s, Art %s): %s",
                error.kind, attempt.label(), run.returncode, run.error_kind or "-", detail[:2000],
            )
            if error in NEXT_ATTEMPT:
                self._session = None
            raise error(detail)

        if keep_session:
            self._session = result.get("session_id") or session
        # modelUsage enthält auch Hilfsmodelle (z. B. Haiku für Titel). Das eigentliche
        # Modell nennt Claude Code beim Start (init).
        used = list(result.get("modelUsage") or {})
        self.last_model = run.model or (used[0] if used else attempt.model or "")
        return Answer(str(result.get("result") or "").strip(), self.last_model, self._session or "")

    def _run(self, cmd: list[str], text: str, on_text) -> Run:
        """Startet Claude, liest den Stream und sammelt Ergebnis, Fehler und Modell."""
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

        # Beide Ausgaben lesen eigene Threads. Startet Claude ein Programm (z. B. Notepad),
        # erbt es unter Windows oft die Ausgabe-Handles, dann kommt das Dateiende erst,
        # wenn das Programm wieder zu ist. Deshalb zählt das result-Ereignis, nicht das Ende.
        stderr_parts: list[str] = []
        lines: queue.Queue = queue.Queue()
        threading.Thread(target=_pump, args=(proc.stdout, lines.put), daemon=True).start()
        err_reader = threading.Thread(target=_pump, args=(proc.stderr, stderr_parts.append), daemon=True)
        err_reader.start()
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
        exited_at = None
        try:
            while stream.result is None:
                try:
                    line = lines.get(timeout=0.25)
                except queue.Empty:
                    if proc.poll() is None:
                        continue
                    # Claude ist beendet. Kurz auf restliche Zeilen warten, dann aufhören.
                    exited_at = exited_at or time.monotonic()
                    if time.monotonic() - exited_at > 1.0:
                        break
                    continue
                if line is None:
                    break
                stream.feed(line)
        finally:
            timer.cancel()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                log.warning("Claude beendet sich nach der Antwort nicht, wird beendet.")
                proc.kill()
            err_reader.join(timeout=0.5 if stream.result is not None else 3)
            self._proc = None

        stderr = "".join(part for part in list(stderr_parts) if part)
        log.debug(
            "Claude fertig nach %.1f s, Exit %s, Modell %s", time.monotonic() - started,
            proc.returncode, stream.model,
        )
        if stderr.strip():
            log.debug("Claude stderr: %s", stderr.strip()[-1000:])
        if timed_out.is_set():
            raise TooSlowError("Claude hat zu lange gebraucht.")
        return Run(
            stream.result, stderr, stream.spoke, stream.model, stream.refused, stream.error_kind,
            list(stream.errors), proc.returncode,
        )

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
        self.refused = False
        self.error_kind = ""

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
        elif kind == "system":
            self._system(event)
        elif kind == "stream_event" and self._partial:
            self._stream_event(event.get("event") or {})
        elif kind == "assistant":
            message = event.get("message") or {}
            if event.get("error"):
                self.error_kind = str(event["error"])
            if message.get("stop_reason") == "refusal":
                self.refused = True
            self._assistant(message)

    def _system(self, event: dict) -> None:
        subtype = event.get("subtype")
        if subtype == "init":
            self.model = event.get("model", "")
        elif subtype == "model_fallback" and event.get("fallback_model"):
            # Claude Code ist selbst auf ein anderes Modell ausgewichen.
            self.model = str(event["fallback_model"])
        elif subtype == "model_refusal_no_fallback":
            self.refused = True
            if event.get("content"):
                self.errors.append(str(event["content"])[:1000])

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


def _api_key_set() -> bool:
    return any(os.environ.get(name) for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"))


def find_claude(cfg: dict | None = None) -> str | None:
    """Sucht Claude Code: Eintrag in config.toml, dann PATH, dann die üblichen Orte.
    (Direkt nach der Installation kennt ein laufendes Programm den neuen PATH noch nicht.)"""
    configured = str((cfg or {}).get("claude_path") or "").strip()
    if configured:
        if Path(configured).expanduser().is_file() or shutil.which(configured):
            return configured
        log.warning("claude_path in config.toml gibt es nicht (%s), ich suche selbst.", configured)
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    candidates = [home / ".local" / "bin" / "claude.exe", home / ".local" / "bin" / "claude"]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "npm" / "claude.cmd")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _pump(pipe, put) -> None:
    """Liest eine Ausgabe zeilenweise, am Ende kommt None."""
    try:
        for line in pipe:
            put(line)
    except (OSError, ValueError):
        pass
    finally:
        put(None)


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
