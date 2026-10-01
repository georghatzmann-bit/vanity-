"""Schnelle Befehle, die Jarvis selbst erledigt, ohne Claude zu fragen.

Das spart Zeit und das Pro-Kontingent. Die Muster sind bewusst eng, damit alles
andere weiter an Claude geht.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]


@dataclass
class Intent:
    name: str
    arg: str = ""
    data: dict = field(default_factory=dict)


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
    ("workshop_cancel", re.compile(
        r"^(?:brich|breche) (?:die )?(?:werkstatt|arbeit|programmierung) ab$|"
        r"^(?:werkstatt|arbeit) (?:stopp|stoppen|abbrechen|beenden)$|"
        r"^(?:stopp|stoppe|beende) (?:die )?(?:werkstatt|arbeit in der werkstatt)$|"
        r"^(?:hör|höre) auf zu (?:programmieren|bauen|coden)$"
    )),
    ("workshop_status", re.compile(
        r"^(?:wie weit bist du(?: (?:mit dem|mit der|mit den|in der werkstatt).*)?|wie läuft(?:s| es)(?: in der werkstatt)?|"
        r"was macht die werkstatt|(?:status|stand) (?:der|in der) werkstatt|bist du (?:schon )?fertig)$"
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


# ---------------------------------------------------------------------- Nachrichten

# "Schreib Max auf Discord, bin gleich da" / "Schick eine Nachricht an Anna über WhatsApp: ..."
# Läuft auf dem Originaltext, damit die Nachricht ihre Groß- und Kleinschreibung behält.
_MSG_VERB = r"(?:schreib|schreibe|schick|schicke|sende|send)"
_MSG_FILL = r"(?:(?:bitte|mal|kurz|schnell)\s+)*"
_MSG_NOTE = r"(?:(?:eine|ne|'ne)\s+(?:nachricht|message|dm|pn)\s+)?"
_MSG_APP = r"(?P<app>discord|whats\s?app|telegram)"
_MSG_VIA = r"(?:auf|über|ueber|in|per|via|bei)"
_MSG_WORD = r"[A-Za-zÄÖÜäöüß][\wÄÖÜäöüß.\-]*"
_MESSAGE = [
    # Name vor der App: Die App trennt Name und Text, ein Satzzeichen ist nicht nötig.
    re.compile(
        rf"^{_MSG_VERB}\s+{_MSG_FILL}{_MSG_NOTE}(?:an\s+)?(?P<person>{_MSG_WORD}(?:\s+{_MSG_WORD})?)\s+"
        rf"{_MSG_NOTE}{_MSG_VIA}\s+{_MSG_APP}\s*[,:;\-–—]?\s*(?P<text>.+)$",
        re.I,
    ),
    # App vor dem Namen: Dann muss ein Komma oder Doppelpunkt den Namen vom Text trennen.
    re.compile(
        rf"^{_MSG_VERB}\s+{_MSG_FILL}{_MSG_NOTE}{_MSG_VIA}\s+{_MSG_APP}\s+(?:an\s+)?"
        rf"(?P<person>{_MSG_WORD}(?:\s+{_MSG_WORD})?)\s*[,:]\s*(?P<text>.+)$",
        re.I,
    ),
]
# Kein Name: "Schreib mir auf Discord ..." ist eher eine Bitte an Jarvis selbst.
_NOT_A_PERSON = {
    "mir", "mich", "uns", "dir", "dich", "ihm", "ihr", "ihnen", "es", "das", "den", "die", "der", "dem",
    "ein", "eine", "einen", "etwas", "was", "alle", "jemandem", "jemand", "nachricht", "an",
    # "meinem Bruder", "deinen Namen": keine Namen, die eine Schnellsuche findet
    "mein", "meine", "meinem", "meinen", "meiner", "dein", "deine", "deinem", "deinen", "deiner",
    "sein", "seine", "seinem", "seinen", "ihrem", "ihren", "unser", "unserem", "unseren", "unserer",
    "eurem", "euren", "allen", "jedem", "keinem", "diesem", "dieser", "diesen",
}


def match_message(text: str) -> Intent | None:
    """Erkennt "Schreib <Person> auf <App>, <Text>". Sätze mit "dass" ("..., dass ich später
    komme") gehen an Claude, der formuliert sie in eine richtige Nachricht um."""
    raw = re.sub(r"^\s*(?:(?:hey|hallo|okay|ok)\s+)?jarvis[\s,!.]*", "", str(text).strip(), flags=re.I)
    for pattern in _MESSAGE:
        found = pattern.match(raw)
        if not found:
            continue
        person = found.group("person").strip(" .,")
        body = found.group("text").strip()
        if person.split()[0].lower() in _NOT_A_PERSON or not body:
            continue
        if re.match(r"(?:dass|das|ob|wann|wo|wie|warum|weil)\b", body, re.I):
            return None  # indirekte Rede: lieber Claude
        app = re.sub(r"\s", "", found.group("app").lower())
        return Intent("message", app, {"person": person, "text": body})
    return None


# ---------------------------------------------------------------------- Erinnerungen und Timer

_REMIND = [
    # "Erinnere mich in 20 Minuten an den Tee", "Erinnere mich morgen um 8 daran, den Müll rauszubringen"
    re.compile(r"^(?:bitte\s+)?erinnere?\s+mich\s+(?:bitte\s+)?(?P<when>.+?)\s+"
               r"(?P<sep>an|ans|daran,?(?:\s+dass)?)\s+(?P<what>.+?)[.!]?$", re.I),
    # "Kannst du mich in 10 Minuten an den Tee erinnern?"
    re.compile(r"^(?:kannst|könntest|würdest)\s+du\s+mich\s+(?:bitte\s+)?(?P<when>.+?)\s+"
               r"(?P<sep>an|ans|daran)\s+(?P<what>.+?)\s+erinnern[?.!]?$", re.I),
]
_TIMER = [
    re.compile(r"^(?:stell|stelle|setz|setze|start|starte|mach|mache)\s+(?:mir\s+)?(?:bitte\s+)?(?:einen|nen|ein)?\s*"
               r"(?:timer|wecker|countdown)\s+(?:auf|für|über|von|in)\s+(?P<dur>.+?)[.!]?$", re.I),
    re.compile(r"^(?:timer|countdown)\s+(?:auf|für|über)?\s*(?P<dur>.+?)[.!]?$", re.I),
]


def match_reminder(text: str, now: dt.datetime | None = None) -> Intent | None:
    """Erinnerungen und Timer ohne Claude. Versteht Jarvis die Zeit nicht, macht es Claude."""
    from .reminders import parse_when

    raw = re.sub(r"^\s*(?:(?:hey|hallo|okay|ok)\s+)?jarvis[\s,!.]*", "", str(text).strip(), flags=re.I)
    for pattern in _REMIND:
        found = pattern.match(raw)
        if not found:
            continue
        what = found.group("what").strip(" ,.")
        if found.group("sep").lower() == "ans":
            what = "das " + what
        try:
            when = parse_when(found.group("when"), now)
        except ValueError:
            return None
        return Intent("remind", what, {"when": when, "what": what})
    for pattern in _TIMER:
        found = pattern.match(raw)
        if not found:
            continue
        duration = found.group("dur").strip(" ,.")
        try:
            when = parse_when(duration if duration.lower().startswith("in ") else "in " + duration, now)
        except ValueError:
            return None
        return Intent("timer", duration, {"when": when, "what": "Der Timer ist abgelaufen."})
    return None


def match(text: str) -> Intent | None:
    message = match_message(text)
    if message is not None:
        return message
    reminder = match_reminder(text)
    if reminder is not None:
        return reminder
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
