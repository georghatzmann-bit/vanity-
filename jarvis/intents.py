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
    """Kleinbuchstaben, ohne Satzzeichen, ohne "Jarvis" am Anfang oder Ende und
    ohne doppelte Wörter ("Stopp. Stopp.")."""
    text = text.lower().strip()
    text = re.sub(r"[.,!?;:\"'„“”»«]", " ", text)
    text = re.sub(r"^\s*(hey\s+|hallo\s+|okay\s+|ok\s+)?jarvis\b", " ", text)
    text = re.sub(r"\bjarvis\s*$", " ", text)
    text = re.sub(r"\b(bitte|mal|doch|jetzt)\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\b(\w+)(?: \1\b)+", r"\1", text)


# Leicht: "etwas lauter", "noch leiser", "mach die Musik lauter".
_MORE = r"(?:(?:noch|etwas|viel|ein bisschen|ein wenig|ein stück) )?"
_MAKE = r"(?:(?:mach|stell|dreh)(?: die musik| den ton| es| die lautstärke)? )?"

_RULES: list[tuple[str, re.Pattern]] = [
    ("stop", re.compile(
        r"^(?:(?:okay|ok|also|na|danke) )*"
        r"(?:stopp?|abbrechen|brich ab|sei (?:still|ruhig)|ruhe|halt|halt die klappe|schluss|genug|"
        r"hör auf|höre auf|aufhören|(?:das|es) reicht|schon gut)(?: danke)?$"
    )),
    # Verankert: "Ist mein Mikrofon aus?" oder "das Mikrofon aus dem Schrank" sind keine Befehle.
    ("mute", re.compile(
        r"^(?:(?:mach|schalt|schalte) )?(?:(?:das|dein|den) )?(?:mikrofon|mikro) "
        r"(?:aus|ausschalten|abschalten|stumm|stummschalten|stumm schalten)$|"
        r"^(?:schlafmodus|(?:geh|gehe) (?:schlafen|in den schlafmodus)|"
        r"(?:hör|höre) (?:auf zuzuhören|nicht mehr zu)|nicht mehr zuhören|stumm ?schalten)$"
    )),
    ("reset", re.compile(
        r"^(?:(?:lass uns|starte|beginne|beginn) )?(?:(?:ein|eine) )?(?:neue unterhaltung|neues gespräch)"
        r"(?: (?:starten|beginnen|anfangen))?$|"
        r"^(?:vergiss alles|(?:fang|fange) (?:nochmal |noch mal |neu )?(?:von )?vorne an)$"
    )),
    ("time", re.compile(
        r"^(?:wie spät(?: ist es| haben wir(?: es)?)?|wie ?viel uhr(?: ist es| haben wir)?|"
        r"(?:sag mir |was ist )?die uhrzeit|uhrzeit)(?: gerade| eigentlich)*$"
    )),
    ("date", re.compile(
        r"^(welcher tag ist heute|welchen tag haben wir( heute)?|welches datum (ist|haben wir) heute|"
        r"welches datum haben wir|den wievielten haben wir( heute)?|was ist heute für ein (tag|datum)|"
        r"was für ein tag ist heute|datum)$"
    )),
    ("volume_set", re.compile(
        r"^(?:(?:mach|stell|setz|setze|dreh) )?(?:die )?lautstärke auf (\d{1,3}) ?(?:%|prozent)?"
        r"(?: (?:stellen|setzen|drehen))?$"
    )),
    ("volume_up", re.compile(
        rf"^{_MORE}{_MAKE}{_MORE}lauter$|^(?:(?:mach|stell|dreh) )?(?:die )?lautstärke (?:hoch|rauf|lauter)$"
    )),
    ("volume_down", re.compile(
        rf"^{_MORE}{_MAKE}{_MORE}leiser$|^(?:(?:mach|stell|dreh) )?(?:die )?lautstärke (?:runter|leiser)$"
    )),
    ("media_pause", re.compile(
        r"^((musik|wiedergabe|lied|song|video) (pause|pausieren|anhalten|stoppen|stopp|stop|aus)|pause|"
        r"(mach|schalt) die musik aus|(stopp|stop|pausiere) die musik|halt die musik an)$"
    )),
    ("media_play", re.compile(r"^((musik|wiedergabe) (weiter|fortsetzen|abspielen)|weiter abspielen|play)$")),
    ("media_next", re.compile(r"^(nächstes (lied|stück|video|titel)|nächster (song|titel)|skip|überspringen)$")),
    ("media_prev", re.compile(r"^((vorheriges|voriges|letztes) (lied|stück|video)|(vorheriger|voriger) (song|titel))$")),
]

# Bei Fragen ("Ist das Mikrofon aus?") nie stummschalten oder das Gespräch löschen.
_NOT_FOR_QUESTIONS = {"mute", "reset"}


def match(text: str) -> Intent | None:
    norm = normalize(text)
    if not norm:
        return None
    question = "?" in text
    for name, pattern in _RULES:
        if question and name in _NOT_FOR_QUESTIONS:
            continue
        found = pattern.search(norm)
        if found:
            if name == "volume_set":
                return Intent(name, str(min(int(found.group(1)), 100)))
            return Intent(name)
    return None


def spoken_time(now: dt.datetime) -> str:
    if now.minute == 0:
        return f"Es ist {now.hour} Uhr, Sir."
    return f"Es ist {now.hour} Uhr {now.minute}, Sir."


def spoken_date(now: dt.date) -> str:
    return f"Heute ist {WEEKDAYS[now.weekday()]}, der {now.day}. {MONTHS[now.month - 1]}, Sir."
