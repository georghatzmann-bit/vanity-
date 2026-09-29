"""Das Gehirn: schickt Befehle an Claude Code (headless) und liefert die Antwort."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


class BrainError(RuntimeError):
    pass


class ClaudeBrain:
    """Spricht mit `claude -p`. Die Unterhaltung wird mit --continue fortgesetzt,
    und die Persönlichkeit kommt aus jarvis_home/CLAUDE.md."""

    def __init__(self, cfg: dict, home: Path) -> None:
        self._claude = cfg["claude_path"] or shutil.which("claude")
        if not self._claude:
            raise BrainError(
                "Claude Code wurde nicht gefunden. Installiere es und melde dich einmal mit 'claude' an."
            )
        self._timeout = cfg["timeout_seconds"]
        self._allowed = cfg["allowed_tools"]
        self._disallowed = cfg["disallowed_tools"]
        self._home = home
        self._continue = False

    def new_conversation(self) -> None:
        self._continue = False

    def command(self) -> list[str]:
        cmd = [self._claude, "-p", "--output-format", "json"]
        if self._allowed:
            cmd += ["--allowedTools", *self._allowed]
        if self._disallowed:
            cmd += ["--disallowedTools", *self._disallowed]
        if self._continue:
            cmd.append("--continue")
        return cmd

    def ask(self, text: str) -> str:
        # Der Befehl geht über stdin, damit gesprochener Text nie als
        # Kommandozeile interpretiert wird.
        try:
            proc = subprocess.run(
                self.command(),
                input=text,
                cwd=self._home,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self._timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise BrainError("Claude hat zu lange gebraucht.") from exc

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()[-500:]
            raise BrainError(f"Claude Code meldet einen Fehler: {detail}")
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise BrainError("Unerwartete Antwort von Claude Code.") from exc
        if data.get("is_error"):
            raise BrainError(str(data.get("result") or "Unbekannter Fehler"))

        self._continue = True
        return str(data.get("result", "")).strip()
