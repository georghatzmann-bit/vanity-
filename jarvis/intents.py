"""Schnelle Befehle, die Jarvis selbst erledigt, ohne Claude zu fragen.

Das spart Zeit und das Pro-Kontingent. Die Muster sind bewusst eng, damit alles
andere weiter an Claude geht.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]


@dataclass
class Intent:
    name: str
    arg: str = ""


def normalize(text: str) -> str:
    """Kleinbuchstaben, ohne Satzzeichen und ohne vorangestelltes "Jarvis"."""
    text = text.lower().strip()
    text = re.sub(r"[.,!?;:\"'„“”»«]", " ", text)
    text = re.sub(r"^\s*(hey\s+|hallo\s+|okay\s+|ok\s+)?jarvis\b", " ", text)
    text = re.sub(r"\b(bitte|mal|doch|jetzt)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


_RULES: list[tuple[str, re.Pattern]] = [
    ("stop", re.compile(r"^(stopp?|stop|abbrechen|brich ab|sei (still|ruhig)|ruhe|halt|schluss|genug)$")),
    # Nicht verankert: "Mach das Mikrofon aus" soll auch gehen.
    ("mute", re.compile(
        r"\b(mikrofon aus|mikro aus|hör auf zuzuhören|nicht mehr zuhören|schlafmodus|geh schlafen)\b"
    )),
    ("reset", re.compile(r"(neue unterhaltung|neues gespräch|vergiss alles|fang (von )?vorne an)")),
    ("time", re.compile(r"^(wie spät ist es|wie viel uhr ist es|wieviel uhr ist es|uhrzeit|wie spät)$")),
    ("date", re.compile(
        r"^(welcher tag ist heute|welches datum (ist|haben wir) heute|welches datum haben wir|"
        r"den wievielten haben wir( heute)?|was ist heute für ein tag|datum)$"
    )),
    ("volume_up", re.compile(r"^((mach|stell)( die musik| den ton| es)? lauter|lauter)$")),
    ("volume_down", re.compile(r"^((mach|stell)( die musik| den ton| es)? leiser|leiser)$")),
    ("media_pause", re.compile(r"^((musik|wiedergabe|lied|song|video) (pause|pausieren|anhalten|stoppen)|pause)$")),
    ("media_play", re.compile(r"^((musik|wiedergabe) (weiter|fortsetzen|abspielen)|weiter abspielen|play)$")),
    ("media_next", re.compile(r"^(nächstes (lied|stück|video|titel)|nächster (song|titel)|skip|überspringen)$")),
    ("media_prev", re.compile(r"^((vorheriges|voriges|letztes) (lied|stück|video)|(vorheriger|voriger) (song|titel))$")),
]


def match(text: str) -> Intent | None:
    norm = normalize(text)
    if not norm:
        return None
    for name, pattern in _RULES:
        if pattern.search(norm):
            return Intent(name)
    return None


def spoken_time(now: dt.datetime) -> str:
    if now.minute == 0:
        return f"Es ist {now.hour} Uhr, Sir."
    return f"Es ist {now.hour} Uhr {now.minute}, Sir."


def spoken_date(now: dt.date) -> str:
    return f"Heute ist {WEEKDAYS[now.weekday()]}, der {now.day}. {MONTHS[now.month - 1]}, Sir."
