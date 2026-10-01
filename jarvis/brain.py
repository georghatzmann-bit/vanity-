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
    "refusal": "Das kann ich so leider nicht erledigen, Sir. Versuchen Sie es bitte etwas anders formuliert.",
    "limit": "Mein Kontingent ist für den Moment aufgebraucht, Sir. In ein paar Stunden bin ich wieder ganz der Alte.",
    "login": (
        "Ich bin gerade nicht angemeldet, Sir. Bitte öffnen Sie einmal die Einstellungen, "
        "dort lässt sich das mit zwei Klicks beheben."
    ),
    "network": "Ich erreiche das Internet gerade nicht, Sir.",
    "overloaded": "Meine Leitungen sind gerade überlastet, Sir. Versuchen Sie es bitte gleich noch einmal.",
    "timeout": "Das hat zu lange gedauert, Sir. Ich habe abgebrochen.",
    "missing": "Mir fehlt gerade mein Gehirn, Sir. Bitte öffnen Sie einmal die Einstellungen.",
    "cancelled": "Abgebrochen, Sir.",
    "model": "Mein Gehirn ist gerade nicht erreichbar, Sir. Versuchen Sie es bitte gleich noch einmal.",
    "account": "Mit Ihrem Claude-Konto stimmt etwas nicht, Sir. Bitte schauen Sie einmal auf claude.ai nach.",
    "billing": (
        "Es gibt ein Abrechnungsproblem, Sir. Vermutlich ist noch ein alter API-Schlüssel statt "
        "Ihres Abos eingetragen."
    ),
    "other": "Da ist etwas schiefgegangen, Sir. Die Einzelheiten stehen im Protokoll.",
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
    "Du bist Jarvis, ein höflicher Butler mit trockenem Humor, wie in Iron Man. Antworte immer "
    "auf Deutsch, in ein oder zwei kurzen Sätzen, ohne Markdown, und sprich den Nutzer mit Sir an."
)

WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]


def with_time(text: str, now=None) -> str:
    """Datum und Uhrzeit vor die Nachricht: So muss Claude nicht erst den PC fragen."""
    import datetime as dt

    now = now or dt.datetime.now()
    stamp = f"{WEEKDAYS[now.weekday()]}, {now.day}. {MONTHS[now.month - 1]} {now.year}, {now:%H:%M} Uhr"
    return f"({stamp})\n{text}"


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
    session: str = ""

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
        # Abgebrochen wird nur, wenn Claude so lange gar nichts mehr meldet. Läuft gerade ein
        # Werkzeug (Installation, Build, Test), darf es deutlich länger still sein.
        self._idle_timeout = float(cfg.get("timeout_seconds", 120))
        self._tool_timeout = float(cfg.get("tool_timeout_seconds", 660))
        self._max_seconds = float(cfg.get("max_seconds", 1800))
        self._tools = cfg.get("tools", [])
        self._effort = str(cfg.get("effort", "") or "").strip()
        self._allowed = cfg.get("allowed_tools", [])
        self._disallowed = cfg.get("disallowed_tools", [])
        self._home = home
        self._persona = persona or home / "CLAUDE.md"
        self.state_dir = state_dir
        self._state_file = (state_dir / "gehirn.json") if state_dir else None
        self._unsupported: set[str] = set()
        self._without_api_key = False
        self._session: str | None = None
        self._conversation = 0
        self._proc: subprocess.Popen | None = None
        self._cancelled = False
        self.last_model = ""
        # Ein Claude-Prozess, der zwischen den Fragen weiterläuft: spart bei jeder Frage den
        # Start von Claude Code (unter Windows 2 bis 3 Sekunden).
        self._live_wanted = bool(cfg.get("live", True))
        self._live: _LiveClaude | None = None
        self._live_lock = threading.RLock()
        # Nach so langer Pause beginnt eine neue Unterhaltung: kleiner Verlauf, schnellere Antworten.
        self._new_after = float(cfg.get("new_after_minutes", 30)) * 60
        self._last_turn_at: float | None = None
        # Was Georg zuletzt gesagt hat, für die Rückfrage-Prüfung in jarvis.tool ("Ja" vor dem Löschen).
        # Eine Datei statt einer Umgebungsvariable, weil der Claude-Prozess weiterläuft.
        self._said_file = (state_dir or home) / "zuletzt-gesagt.txt"
        # Zwischenstände ("Sonnet lehnt ab, versuche Haiku") gehen nur ins Protokoll,
        # `alert` meldet Dinge, um die sich Georg kümmern muss (z. B. ein nötiges Update).
        self.notice: Callable[[str], None] = lambda text: log.info("%s", text)
        self.alert: Callable[[str], None] = lambda text: log.warning("%s", text)
        # Was Jarvis über Georg weiß (memory.Memory.context): kommt an den Anfang jeder Unterhaltung.
        self.context: Callable[[], str] | None = None
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

    # Für die Werkstatt (eigener Claude-Prozess mit denselben Grundeinstellungen)
    @property
    def claude_path(self) -> str:
        return self._claude

    @property
    def persona_path(self) -> Path:
        return self._persona

    @property
    def disallowed_tools(self) -> list[str]:
        return list(self._disallowed)

    @property
    def live_enabled(self) -> bool:
        return self._live_wanted and "input-format" not in self._unsupported

    def new_conversation(self) -> None:
        # Der Zähler sorgt dafür, dass eine gerade laufende Antwort die alte
        # Unterhaltung nicht wieder zurückbringt.
        self._conversation += 1
        self._session = None
        self._drop_live()

    def cancel(self) -> None:
        """Bricht die laufende Anfrage ab (z. B. bei "Stopp")."""
        self._cancelled = True
        proc = self._proc
        if proc and proc.poll() is None:
            _kill(proc)

    def prewarm(self) -> None:
        """Startet Claude schon im Hintergrund, damit die nächste Frage ohne Startzeit läuft."""
        if not self.live_enabled:
            return

        def warm() -> None:
            try:
                with self._live_lock:
                    self._ensure_live(self.attempt, None)
            except Exception as exc:
                log.debug("Vorwärmen von Claude: %s", exc)

        threading.Thread(target=warm, name="jarvis-gehirn-vorwaermen", daemon=True).start()

    def close(self) -> None:
        """Beim Beenden von Jarvis: den laufenden Claude-Prozess mitnehmen."""
        self._drop_live()

    def _drop_live(self) -> None:
        with self._live_lock:
            live, self._live = self._live, None
        if live is not None:
            live.close()

    def _ensure_live(self, attempt: Attempt, isolated: bool | None) -> "_LiveClaude":
        """Der laufende Claude-Prozess für diesen Versuch; startet ihn bei Bedarf (mit dem
        bisherigen Gespräch, falls es eins gibt)."""
        isolated = self.isolated if isolated is None else isolated
        key = (attempt, isolated)
        live = self._live
        if live is not None and (not live.alive() or live.key != key or live.conversation != self._conversation):
            self._live = None
            live.close()
            live = None
        if live is None:
            resume = self._session is not None
            session = self._session or str(uuid.uuid4())
            cmd = self.command(attempt, isolated, session, resume) + ["--input-format", "stream-json"]
            log.debug("Claude-Prozess startet: %s", " ".join(cmd[1:]))
            live = _LiveClaude(cmd, self._home, self.environment(""), key, self._conversation, session)
            self._live = live
        return live

    def _write_said(self, text: str) -> None:
        try:
            self._said_file.parent.mkdir(parents=True, exist_ok=True)
            self._said_file.write_text(text[:500], encoding="utf-8")
        except OSError as exc:
            log.debug("Zuletzt gesagt: %s", exc)

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
        if self._effort and "effort" not in self._unsupported:
            cmd += ["--effort", self._effort]
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

    def oneshot(self, prompt: str, model: str = "haiku", timeout: float = 120) -> str:
        """Eine einzelne Frage ohne Werkzeuge und ohne Verlauf, neben der Unterhaltung her
        (z. B. der nächtliche Tagesrückblick des Gedächtnisses). Gibt den Text zurück."""
        cmd = [self._claude, "-p", "--output-format", "text"]
        if model:
            cmd += ["--model", model]
        if "safe-mode" not in self._unsupported:
            cmd.append("--safe-mode")
        if "tools" not in self._unsupported:
            cmd += ["--tools", ""]
        try:
            result = subprocess.run(
                cmd, input=prompt, capture_output=True, cwd=self._home, env=self.environment(prompt),
                text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BrainError(f"Claude antwortet nicht: {exc}") from exc
        if result.returncode != 0:
            raise classify(result.stderr or result.stdout)(((result.stderr or result.stdout) or "Fehler").strip()[:300])
        return result.stdout.strip()

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
        env["JARVIS_SAID_FILE"] = str(self._said_file)
        if self._without_api_key:
            # Ein alter API-Schlüssel in den Windows-Umgebungsvariablen hat Vorrang vor dem
            # Pro-Abo. Ohne ihn meldet sich Claude Code mit dem Abo an.
            for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
                env.pop(name, None)
        return env

    def ask(self, text: str, on_text: Callable[[str], None] | None = None, on_step=None) -> Answer:
        """Fragt Claude. `on_text` bekommt die Antwort Stück für Stück, sobald sie
        entsteht, `on_step` jeden Arbeitsschritt (Werkzeug) als `steps.Step`. Bei einer
        Ablehnung kommt der nächste Versuch aus `attempts` dran, in einer neuen
        Unterhaltung, und dabei bleibt es danach."""
        self._cancelled = False
        if self._new_after > 0 and self._last_turn_at is not None and time.monotonic() - self._last_turn_at > self._new_after:
            log.info("Lange Pause: neue Unterhaltung.")
            self.new_conversation()
        rescue_from: list[int] = []
        try:
            answer = self._ask_chain(text, on_text, rescue_from, on_step)
            self._last_turn_at = time.monotonic()
            return answer
        except BrainError:
            if rescue_from:
                # Auch der Notfall-Versuch hat nicht geholfen: nächstes Mal wie vorher.
                self._index = rescue_from[0]
            raise
        finally:
            if self.live_enabled and self._live is None and not self._cancelled:
                self.prewarm()  # nach einem Fehler gleich wieder bereit sein

    def _ask_chain(self, text: str, on_text, rescue_from: list[int], on_step=None) -> Answer:
        overload_retry = True
        while True:
            if self._cancelled:
                raise Cancelled("abgebrochen")
            try:
                answer = self._ask_once(text, on_text=on_text, on_step=on_step)
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
                for _ in range(20):
                    if self._cancelled:
                        break
                    time.sleep(0.1)
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
        on_step=None,
    ) -> Answer:
        attempt = attempt or self.attempt
        conversation = self._conversation
        resume = keep_session and self._session is not None
        session = self._session if resume else str(uuid.uuid4())
        # Die normale Unterhaltung läuft über den dauerhaften Prozess, Proben (diagnose) nicht.
        live = self.live_enabled and keep_session
        self._write_said(text)
        prompt = with_time(text)
        if not resume and self.context is not None:
            try:
                known = self.context()
            except Exception as exc:
                log.debug("Gedächtnis: %s", exc)
                known = ""
            if known:
                stamp, _, said = prompt.partition("\n")
                prompt = f"{stamp}\n<gedaechtnis>\n{known}\n</gedaechtnis>\n{said}"
        for _ in range(5):
            if self._cancelled:
                raise Cancelled("abgebrochen")
            if live:
                run = self._run_live(attempt, isolated, text, on_text, prompt=prompt, on_step=on_step)
                session = run.session or session
            else:
                cmd = self.command(attempt, isolated, session if keep_session else None, resume)
                run = self._run(cmd, text, on_text, prompt=prompt, on_step=on_step)
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
                    self.alert(
                        "Claude Code ist veraltet, deshalb laufen deine eigenen Skills mit. "
                        "Bitte einmal 'claude update' in der Eingabeaufforderung ausführen."
                    )
                if flag == "input-format":
                    live = False  # dann wie früher: ein Prozess pro Frage
                continue
            if result is None and (resume or live) and re.search(r"no conversation found|session.*not found", stderr or "", re.I):
                # Die alte Unterhaltung gibt es nicht mehr, also neu anfangen.
                resume, session = False, str(uuid.uuid4())
                self._session = None
                continue
            break

        if self._cancelled:
            raise Cancelled("abgebrochen")
        if run.failed:
            if live:
                self._drop_live()  # nach einem Fehler mit frischem Prozess weiter
            detail = run.error_text()
            error = run.error_class(detail)
            log.warning(
                "Claude meldet einen Fehler (%s, %s, Exit %s, Art %s): %s",
                error.kind, attempt.label(), run.returncode, run.error_kind or "-", detail[:2000],
            )
            if error in NEXT_ATTEMPT:
                self._session = None
            raise error(detail)

        if keep_session and conversation == self._conversation:
            self._session = result.get("session_id") or session
        # modelUsage enthält auch Hilfsmodelle (z. B. Haiku für Titel). Das eigentliche
        # Modell nennt Claude Code beim Start (init).
        used = list(result.get("modelUsage") or {})
        self.last_model = run.model or (used[0] if used else attempt.model or "")
        return Answer(str(result.get("result") or "").strip(), self.last_model, self._session or "")

    def _run(self, cmd: list[str], text: str, on_text, prompt: str | None = None, on_step=None) -> Run:
        """Startet Claude, liest den Stream und sammelt Ergebnis, Fehler und Modell.
        `text` ist, was Georg gesagt hat, `prompt` geht an Claude (mit Datum und Uhrzeit)."""
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

        # Die Frage geht über stdin, damit gesprochener Text nie als
        # Kommandozeile interpretiert wird.
        try:
            proc.stdin.write(text if prompt is None else prompt)
        except OSError:
            pass
        finally:
            _close(proc.stdin)

        stream = _StreamReader(on_text, partial="include-partial-messages" not in self._unsupported, on_step=on_step)
        timed_out = False
        try:
            timed_out = self._read_turn(proc, lines, stream, started)
        finally:
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
        if timed_out:
            raise TooSlowError("Claude hat zu lange nichts mehr gemeldet.")
        return Run(
            stream.result, stderr, stream.spoke, stream.model, stream.refused, stream.error_kind,
            list(stream.errors), proc.returncode,
        )

    def _read_turn(self, proc: subprocess.Popen, lines: queue.Queue, stream: "_StreamReader", started: float) -> bool:
        """Liest Zeilen, bis das Ergebnis da ist oder Claude beendet ist. True, wenn Claude zu
        lange nichts gemeldet hat (dann ist der Prozess beendet)."""
        last = time.monotonic()
        exited_at = None
        while stream.result is None:
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                now = time.monotonic()
                quiet = self._tool_timeout if stream.running else self._idle_timeout
                if now - last > quiet or now - started > self._max_seconds:
                    log.warning(
                        "Claude meldet seit %.0f s nichts (läuft seit %.0f s, Werkzeug aktiv: %s), breche ab.",
                        now - last, now - started, bool(stream.running),
                    )
                    _kill(proc)
                    return True
                if proc.poll() is None:
                    continue
                # Claude ist beendet. Kurz auf restliche Zeilen warten, dann aufhören.
                exited_at = exited_at or now
                if now - exited_at > 1.0:
                    break
                continue
            if line is None:
                break
            last = time.monotonic()
            stream.feed(line)
        return False

    # ------------------------------------------------------------------ Dauerhafter Prozess

    def _run_live(self, attempt: Attempt, isolated: bool | None, text: str, on_text, prompt: str, on_step=None) -> Run:
        """Wie `_run`, aber über den dauerhaft laufenden Claude-Prozess."""
        started = time.monotonic()
        with self._live_lock:
            try:
                live = self._ensure_live(attempt, isolated)
            except FileNotFoundError as exc:
                raise NotInstalledError(f"Claude Code nicht startbar: {exc}") from exc
            except OSError as exc:
                raise BrainError(f"Claude Code nicht startbar: {exc}") from exc
        self._proc = live.proc
        mark = len(live.stderr_parts)
        stream = _StreamReader(on_text, partial="include-partial-messages" not in self._unsupported, on_step=on_step)
        timed_out = False
        try:
            live.send(prompt)
            timed_out = self._read_turn(live.proc, live.lines, stream, started)
        except (OSError, ValueError) as exc:
            log.debug("Claude-Prozess nimmt nichts mehr an: %s", exc)
            time.sleep(0.3)  # Fehlermeldung (z. B. unbekannte Option) noch einsammeln
        finally:
            self._proc = None
        if timed_out or stream.result is None or not live.alive():
            # Abgebrochen, abgestürzt oder zu alt für --input-format: nächstes Mal frisch starten.
            if live.alive():
                _kill(live.proc)
            with self._live_lock:
                if self._live is live:
                    self._live = None
            try:
                live.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            _close(live.proc.stdin)
            live.err_reader.join(timeout=1.0)  # Fehlermeldungen vollständig einsammeln
        stderr = "".join(part for part in list(live.stderr_parts)[mark:] if part)
        log.debug(
            "Claude (dauerhaft, Frage %d) fertig nach %.1f s, Modell %s", live.turns,
            time.monotonic() - started, stream.model,
        )
        if stderr.strip():
            log.debug("Claude stderr: %s", stderr.strip()[-1000:])
        if timed_out:
            raise TooSlowError("Claude hat zu lange nichts mehr gemeldet.")
        return Run(
            stream.result, stderr, stream.spoke, stream.model, stream.refused, stream.error_kind,
            list(stream.errors), live.proc.poll(), session=live.session,
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

    def __init__(self, on_text, partial: bool, on_step=None) -> None:
        self._on_text = on_text
        self._on_step = on_step
        self._partial = partial
        self._any_text = False
        self.spoke = False
        self.result: dict | None = None
        self.model = ""
        self.errors: list[str] = []
        self.refused = False
        self.error_kind = ""
        # Werkzeuge, die Claude gestartet hat (id -> Schritt), und welche davon noch laufen
        self.steps: dict = {}
        self.running: set[str] = set()

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
        elif kind == "user":
            self._tool_results(event.get("message") or {})

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
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self._tool_start(block)
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

    def _tool_start(self, block: dict) -> None:
        from .steps import describe

        tool_id = str(block.get("id") or f"schritt-{len(self.steps) + 1}")
        if tool_id in self.steps:
            return  # dieselbe Nachricht kam schon einmal
        step = describe(tool_id, str(block.get("name") or ""), block.get("input"))
        self.steps[tool_id] = step
        self.running.add(tool_id)
        self._step(step)

    def _tool_results(self, message: dict) -> None:
        content = message.get("content")
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_id = str(block.get("tool_use_id") or "")
            step = self.steps.get(tool_id)
            if step is None or tool_id not in self.running:
                continue
            self.running.discard(tool_id)
            step.finish(error=bool(block.get("is_error")))
            self._step(step)

    def _step(self, step) -> None:
        if self._on_step:
            try:
                self._on_step(step)
            except Exception as exc:
                log.debug("Anzeige des Arbeitsschritts: %s", exc)

    def _emit(self, text: str) -> None:
        if self._on_text:
            if text.strip():
                self.spoke = True
            self._on_text(text)


class _LiveClaude:
    """Ein Claude-Prozess, der zwischen den Fragen weiterläuft. Fragen gehen als JSON-Zeilen
    hinein (--input-format stream-json), die Antworten kommen wie gewohnt als Stream heraus,
    pro Frage mit einem eigenen result-Ereignis."""

    def __init__(self, cmd: list[str], cwd: Path, env: dict, key, conversation: int, session: str) -> None:
        self.key = key
        self.conversation = conversation
        self.session = session
        self.turns = 0
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=NO_WINDOW,
        )
        self.lines: queue.Queue = queue.Queue()
        self.stderr_parts: list = []
        threading.Thread(target=_pump, args=(self.proc.stdout, self.lines.put), daemon=True).start()
        self.err_reader = threading.Thread(target=_pump, args=(self.proc.stderr, self.stderr_parts.append), daemon=True)
        self.err_reader.start()

    def alive(self) -> bool:
        return self.proc.poll() is None

    def send(self, prompt: str) -> None:
        # Reste einer abgebrochenen Frage verwerfen, damit sie nicht als Antwort gelten.
        while True:
            try:
                self.lines.get_nowait()
            except queue.Empty:
                break
        message = {"type": "user", "message": {"role": "user", "content": prompt}}
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        self.turns += 1

    def close(self) -> None:
        _close(self.proc.stdin)
        try:
            self.proc.wait(timeout=3)
        except Exception:
            _kill(self.proc)


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
    """Liest eine Ausgabe zeilenweise, am Ende kommt None. Danach ist die Leitung zu,
    sonst bleibt bei jedem Aufruf ein Datei-Handle offen, bis Python aufräumt."""
    try:
        for line in pipe:
            put(line)
    except (OSError, ValueError):
        pass
    finally:
        try:
            pipe.close()
        except (OSError, ValueError):
            pass
        put(None)


def _close(pipe) -> None:
    """Schließt eine Leitung, auch wenn Claude schon weg ist (dann scheitert das Leeren)."""
    try:
        pipe.close()
    except (OSError, ValueError):
        pass


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
