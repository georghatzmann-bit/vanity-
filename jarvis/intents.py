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
    ("media_play", re.compile(
        r"^((musik|wiedergabe) (weiter|fortsetzen|abspielen)|weiter abspielen|play|"
        r"(spiel|spiele) (die |etwas |wieder )?musik( ab| weiter)?)$"
    )),
    ("media_next", re.compile(r"^(nächstes (lied|stück|video|titel)|nächster (song|titel)|skip|überspringen)$")),
    ("media_prev", re.compile(r"^((vorheriges|voriges|letztes) (lied|stück|video)|(vorheriger|voriger) (song|titel))$")),
]

# Füllwörter vor einem Programmnamen: "Öffne mir mal kurz den Spotify"
_FILL = r"(?:(?:den|die|das|dem|der|mein|meine|meinen|mir|uns|kurz|schnell|gleich|noch|einmal|wieder|bitte|mal) )*"
# "Gaming-Modus", "Gaming Mode", "Gamingmodus", "Spielemodus"
_GAMING = r"(?:gaming|gamer|game|spiele|spiel)[ -]?(?:modus|mode)"
_ASK = r"(?:(?:kannst|könntest|würdest) du |sei so gut und )?"

_RULES += [
    ("gaming_off", re.compile(
        rf"^{_ASK}(?:(?:mach|mache|schalt|schalte|stell|stelle) )?(?:den )?{_GAMING} "
        r"(?:aus|ab|beenden|deaktivieren|ausschalten|off)$|"
        rf"^(?:beende|beend|deaktiviere|deaktivier|stopp|stoppe) (?:den )?{_GAMING}$"
    )),
    ("gaming_on", re.compile(
        rf"^{_ASK}(?:(?:mach|mache|schalt|schalte|aktivier|aktiviere|starte|start|stell|stelle) )?(?:den )?{_GAMING}"
        r"(?: (?:an|ein|aktivieren|einschalten|starten|on))?$"
    )),
    ("window_show", re.compile(
        r"^(?:zeig|zeige) dich$|^(?:komm|komme) (?:raus|nach vorne|her)$|"
        r"^(?:öffne|zeig|zeige) (?:mir )?(?:dein|das|dein jarvis|das jarvis)[ -]?fenster$|"
        r"^(?:jarvis[ -]?)?fenster (?:öffnen|zeigen|auf)$"
    )),
    ("window_hide", re.compile(
        r"^(?:versteck|verstecke|minimier|minimiere) dich$|^(?:geh|gehe) in den hintergrund$|"
        r"^(?:schließ|schließe|schliess|schliesse|versteck|verstecke|minimier|minimiere) (?:dein|das) fenster$|"
        r"^(?:dein )?fenster (?:zu|schließen|verstecken|minimieren)$"
    )),
    ("setup", re.compile(
        r"^(?:öffne|zeig|zeige) (?:mir )?(?:deine|die jarvis)[ -]?einstellungen$|"
        r"^(?:öffne|starte) (?:die )?einrichtung$|^einrichtung (?:öffnen|starten)$"
    )),
    ("lock", re.compile(
        r"^(?:sperr|sperre) (?:den |meinen )?(?:pc|computer|rechner|bildschirm)$|"
        r"^(?:pc|computer|rechner|bildschirm) sperren$"
    )),
    ("folder", re.compile(
        r"^(?:öffne|zeig|zeige) (?:mir )?(?:den |meinen |meine |die )?(?:ordner )?"
        r"(downloads|download|dokumente|bilder|fotos|desktop|musik|videos)(?: ordner)?$"
    )),
    ("install", re.compile(
        rf"^{_ASK}(?:installiere|installier|instaliere|installieren) {_FILL}(.+?)(?: (?:herunter|runter))?$|"
        rf"^{_ASK}(?:lade|lad|hol|hole) {_FILL}(.+?) (?:herunter|runter|aus dem internet)$|"
        rf"^{_ASK}{_FILL}(.+?) (?:installieren|herunterladen|runterladen)$"
    )),
    ("close", re.compile(
        rf"^{_ASK}(?:schließe|schließ|schliesse|schliess|beende|beend) {_FILL}(.+?)$|"
        rf"^{_ASK}{_FILL}(.+?) (?:schließen|schliessen|beenden|zumachen)$|"
        rf"^(?:mach|mache) {_FILL}(.+?) (?:zu|aus)$"
    )),
    ("open", re.compile(
        rf"^{_ASK}(?:öffne|öffnen|starte|start|launche|ruf|rufe) {_FILL}(.+?)(?: (?:auf|für mich))?$|"
        rf"^{_ASK}{_FILL}(.+?) (?:öffnen|starten|aufmachen|aufrufen)$|"
        rf"^(?:mach|mache) {_FILL}(.+?) auf$|"
        rf"^(?:zeig|zeige) mir {_FILL}(.+?)$"
    )),
    # "Mach Spotify an" nur für bekannte Programme, sonst ist es eher das Licht.
    ("open_known", re.compile(rf"^(?:mach|mache|schalt|schalte) {_FILL}(.+?) an$")),
]

# Bei Fragen ("Ist das Mikrofon aus?") nie stummschalten oder das Gespräch löschen.
_NOT_FOR_QUESTIONS = {"mute", "reset", "window_hide", "lock", "close", "gaming_off"}
# Diese Absichten bekommen den Namen des Programms oder Ordners mit.
_WITH_NAME = {"install", "close", "open", "open_known", "folder"}
# Wörter, die kein Programmname sind ("Öffne es", "Schließ das")
_NOT_A_NAME = {"es", "das", "ihn", "sie", "alles", "dich", "mich", "den", "die", "das fenster", "fenster"}


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
            if name in _WITH_NAME:
                arg = next((g for g in found.groups() if g), "").strip()
                if not arg or arg in _NOT_A_NAME or re.search(r"\b(?:und|oder|dann|danach)\b", arg):
                    continue  # mehrere Dinge auf einmal: das kann Claude besser
                if name == "open_known":
                    from .apps import find_known

                    if find_known(arg) is None:
                        continue
                    name = "open"
                return Intent(name, arg)
            return Intent(name)
    return None


def spoken_time(now: dt.datetime) -> str:
    if now.minute == 0:
        return f"Es ist {now.hour} Uhr, Sir."
    return f"Es ist {now.hour} Uhr {now.minute}, Sir."


def spoken_date(now: dt.date) -> str:
    return f"Heute ist {WEEKDAYS[now.weekday()]}, der {now.day}. {MONTHS[now.month - 1]}, Sir."
