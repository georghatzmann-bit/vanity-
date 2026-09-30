"""Setzt Jarvis' Persönlichkeit zusammen: jarvis_home/CLAUDE.md plus Georgs Angaben aus config.toml."""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)


def build_persona(home: Path, state_dir: Path, cfg: dict) -> Path:
    base_file = home / "CLAUDE.md"
    me = cfg.get("ich", {})
    extra = []
    if me.get("ort"):
        extra.append(
            f"- Georg wohnt in {me['ort']}. Wetter, Uhrzeiten und Orte beziehen sich darauf, "
            "wenn er nichts anderes sagt."
        )
    if me.get("notizen"):
        extra.append(f"- {me['notizen']}")
    if not extra:
        return base_file
    try:
        text = base_file.read_text(encoding="utf-8").rstrip() + "\n\n## Über Georg\n\n" + "\n".join(extra) + "\n"
        target = state_dir / "persona.md"
        state_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target
    except OSError as exc:
        log.warning("Persönlichkeit konnte nicht ergänzt werden: %s", exc)
        return base_file
