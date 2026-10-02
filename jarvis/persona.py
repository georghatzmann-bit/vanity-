"""Setzt Jarvis' Persönlichkeit zusammen: jarvis_home/CLAUDE.md plus Georgs Angaben aus config.toml."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .config import user_name

log = logging.getLogger(__name__)


FULL_PERMISSION = (
    "- Georg hat dir volle Freigabe erteilt. Du fragst nicht nach, sondern machst es einfach, auch "
    "Programme deinstallieren, Dateien in den Papierkorb legen, Administrator-Befehle, Herunterfahren, "
    "Neustarten, Energiesparen und Abmelden. Endgültig löschen (statt Papierkorb), Laufwerke formatieren "
    "und die Registry ausräumen tust du trotzdem nicht. Nur zwei Dinge fragst du kurz: etwas kaufen oder "
    "bezahlen, und Nachrichten oder E-Mails in Georgs Namen, deren Inhalt er nicht selbst gesagt hat."
)


def _permissions(text: str, full: bool) -> str:
    """Der Abschnitt zwischen <!-- rueckfragen --> und <!-- /rueckfragen -->: mit voller Freigabe
    ersetzt, sonst ohne die Markierungen."""
    start, end = "<!-- rueckfragen -->", "<!-- /rueckfragen -->"
    if start not in text or end not in text:
        return text
    before, rest = text.split(start, 1)
    middle, after = rest.split(end, 1)
    return before + (FULL_PERMISSION if full else middle.strip("\n")) + after


def build_persona(home: Path, state_dir: Path, cfg: dict) -> Path:
    base_file = home / "CLAUDE.md"
    me = cfg.get("ich", {})
    full = bool(cfg.get("rechte", {}).get("volle_freigabe", True))
    extra = []
    if me.get("ort"):
        extra.append(
            f"- Georg wohnt in {me['ort']}. Wetter, Uhrzeiten und Orte beziehen sich darauf, "
            "wenn er nichts anderes sagt."
        )
    if me.get("notizen"):
        extra.append(f"- {me['notizen']}")
    try:
        text = _permissions(base_file.read_text(encoding="utf-8"), full).rstrip() + "\n"
        if extra:
            text += "\n## Über Georg\n\n" + "\n".join(extra) + "\n"
        name = user_name(cfg)
        if name != "Georg":
            text = re.sub(r"\bGeorg", name, text)  # Jarvis ist für Georg geschrieben, hier heißt der Nutzer anders
        target = state_dir / "persona.md"
        state_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target
    except OSError as exc:
        log.warning("Persönlichkeit konnte nicht ergänzt werden: %s", exc)
        return base_file
