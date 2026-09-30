"""Das Gehirn: schickt Befehle an Claude Code (headless) und liefert die Antwort."""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


class BrainError(RuntimeError):
    pass


class RefusalError(BrainError):
    """Claudes Sicherheitsfilter hat die Anfrage abgelehnt."""


REFUSAL = re.compile(r"safeguard|usage polic|can't respond to your last message", re.I)
UNKNOWN_ISOLATION_FLAG = re.compile(r"unknown option '--(safe-mode|system-prompt-file)'", re.I)


class ClaudeBrain:
    """Spricht mit `claude -p`. Die Unterhaltung wird mit --continue fortgesetzt.

    Im abgeschotteten Modus (isolated) startet Claude Code mit --safe-mode, also
    ohne die persönlichen Skills, Plugins, MCP-Server und CLAUDE.md-Dateien des
    Nutzers, und die Persönlichkeit aus jarvis_home/CLAUDE.md kommt als
    Systemprompt. Lehnt ein Modell ab, versucht Jarvis das nächste aus `models`.
    """

    def __init__(self, cfg: dict, home: Path) -> None:
        self._claude = cfg["claude_path"] or shutil.which("claude")
        if not self._claude:
            raise BrainError(
                "Claude Code wurde nicht gefunden. Installiere es und melde dich einmal mit 'claude' an."
            )
        models = cfg.get("models") or [cfg.get("model", "")]
        self._models = [m for m in models if m] or [""]
        self._model_index = 0
        self._isolated = cfg.get("isolated", True)
        self._timeout = cfg["timeout_seconds"]
        self._allowed = cfg["allowed_tools"]
        self._disallowed = cfg["disallowed_tools"]
        self._home = home
        self._persona = home / "CLAUDE.md"
        self._continue = False
        self.last_model = ""

    @property
    def model(self) -> str:
        return self._models[self._model_index]

    def new_conversation(self) -> None:
        self._continue = False

    def command(self, model: str | None = None, isolated: bool | None = None) -> list[str]:
        model = self.model if model is None else model
        isolated = self._isolated if isolated is None else isolated
        cmd = [self._claude, "-p", "--output-format", "json"]
        if model:
            cmd += ["--model", model]
        if isolated:
            cmd += ["--safe-mode", "--system-prompt-file", str(self._persona)]
        if self._allowed:
            cmd += ["--allowedTools", *self._allowed]
        if self._disallowed:
            cmd += ["--disallowedTools", *self._disallowed]
        if self._continue:
            cmd.append("--continue")
        return cmd

    def ask(self, text: str) -> str:
        """Fragt das aktuelle Modell. Bei einer Ablehnung kommt das nächste Modell
        in einer neuen Unterhaltung dran, und dabei bleibt es danach."""
        while True:
            try:
                return self._ask_once(text)
            except RefusalError:
                if self._model_index + 1 >= len(self._models):
                    raise
                refused = self.model
                self._model_index += 1
                print(f"  ({refused or 'Standardmodell'} hat abgelehnt, versuche {self.model} ...)")

    def _ask_once(self, text: str, model: str | None = None, isolated: bool | None = None) -> str:
        # Der Befehl geht über stdin, damit gesprochener Text nie als
        # Kommandozeile interpretiert wird.
        proc = self._run(self.command(model, isolated), text)
        if isolated is None and self._isolated and UNKNOWN_ISOLATION_FLAG.search(proc.stderr or ""):
            log.warning(
                "Diese Claude-Code-Version kann Jarvis noch nicht abschotten. "
                "Bitte in der Eingabeaufforderung 'claude update' ausführen."
            )
            self._isolated = False
            proc = self._run(self.command(model, False), text)

        data = _parse_result(proc.stdout)
        if data is None:
            detail = (proc.stderr or proc.stdout).strip()[-500:]
            raise BrainError(f"Claude Code meldet einen Fehler: {detail or 'keine Ausgabe'}")
        if data.get("is_error") or proc.returncode != 0:
            message = str(data.get("result") or "Unbekannter Fehler")
            if REFUSAL.search(message):
                # Claude rät, danach in einer neuen Sitzung weiterzumachen.
                self._continue = False
                raise RefusalError(message)
            raise BrainError(message)

        self._continue = True
        used = list(data.get("modelUsage") or {})
        self.last_model = used[0] if used else (model or self.model)
        return str(data.get("result", "")).strip()

    def _run(self, cmd: list[str], text: str) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                cmd,
                input=text,
                cwd=self._home,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self._timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise BrainError("Claude hat zu lange gebraucht.") from exc

    def diagnose(self, text: str = "hi") -> list[tuple[str, str, str]]:
        """Probiert jedes Modell mit und ohne persönliche Erweiterungen.
        Gibt (Modell, Modus, Ergebnis) zurück."""
        rows = []
        for model in self._models:
            for isolated in (False, True):
                mode = "ohne Erweiterungen" if isolated else "mit deinen Einstellungen"
                self._continue = False
                try:
                    self._ask_once(text, model, isolated)
                    result = f"OK ({self.last_model})"
                except RefusalError:
                    result = "ABGELEHNT"
                except BrainError as exc:
                    result = f"FEHLER: {str(exc)[:120]}"
                rows.append((model or "Standard", mode, result))
        self._continue = False
        return rows


def _parse_result(stdout: str) -> dict | None:
    """Liest das JSON-Ergebnis von `claude -p --output-format json`."""
    text = stdout.strip()
    if not text:
        return None
    for candidate in (text, text.splitlines()[-1]):
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return None
