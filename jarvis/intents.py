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
    ohne doppelte Wörter ("Stopp. Stopp."). Punkte zwischen Buchstaben bleiben ("amazon.de")."""
    text = text.lower().strip()
    text = re.sub(r"(?<!\w)\.|\.(?!\w)", " ", text)
    text = re.sub(r"[,!?;:\"'„“”»«]", " ", text)
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
    # "Öffne die Bluetooth-Einstellungen", "Zeig mir die Einstellungen für WLAN"
    ("settings_page", re.compile(
        r"^(?:öffne|öffnen|zeig|zeige|geh in|gehe in|geh zu|gehe zu|ruf|rufe) (?:mir )?(?:die |den )?(.+?)[ -]?einstellungen$|"
        r"^(?:öffne|zeig|zeige) (?:mir )?(?:die )?einstellungen (?:für|von|zum|zur|zu) (?:den |die |das |dem |der )?(.+)$|"
        r"^(.+?)[ -]?einstellungen (?:öffnen|zeigen|aufmachen)$"
    )),
    ("dark_off", re.compile(
        r"^(?:(?:mach|mache|schalt|schalte|deaktivier|deaktiviere|stell|stelle) )?(?:den |das )?"
        r"(?:dunkel[ -]?modus|dark[ -]?mode|dunkles design) (?:aus|ab|deaktivieren|ausschalten)$|"
        r"^(?:(?:mach|mache|schalt|schalte|aktivier|aktiviere|stell|stelle) )?(?:den |das |auf )?"
        r"(?:hell[ -]?modus|hellen modus|light[ -]?mode|helles (?:design|theme))(?: (?:an|ein|um|aktivieren|einschalten))?$"
    )),
    ("dark_on", re.compile(
        r"^(?:(?:mach|mache|schalt|schalte|aktivier|aktiviere|stell|stelle) )?(?:den |das |auf )?"
        r"(?:dunkel[ -]?modus|dark[ -]?mode|dunkles (?:design|theme)|dunklen modus)(?: (?:an|ein|um|aktivieren|einschalten))?$"
    )),
    ("radio", re.compile(
        r"^(?:(?:mach|mache|schalt|schalte|stell|stelle) )?(?:das |den |die )?(?:bluetooth|wlan|w-lan|wifi|wi-fi) "
        r"(?:an|ein|aus|ab|einschalten|ausschalten|aktivieren|deaktivieren)$|"
        r"^(?:aktivier|aktiviere|deaktivier|deaktiviere) (?:das |den |die )?(?:bluetooth|wlan|w-lan|wifi|wi-fi)$"
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
        r"was macht die werkstatt|(?:status|stand) (?:der|in der) werkstatt|bist du (?:schon )?fertig|"
        r"wie weit ist (?:die )?werkstatt|ist (?:die )?werkstatt (?:schon )?fertig)$"
    )),
    # "Mach Spotify an" nur für bekannte Programme, sonst ist es eher das Licht.
    ("open_known", re.compile(rf"^(?:mach|mache|schalt|schalte) {_FILL}(.+?) an$")),
]

# Bei Fragen ("Ist das Mikrofon aus?") nie stummschalten oder das Gespräch löschen.
_NOT_FOR_QUESTIONS = {"mute", "reset", "window_hide", "lock", "close", "gaming_off", "dark_on", "dark_off", "radio"}
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



# ---------------------------------------------------------------------- Rechnen

_CALC = [
    re.compile(r"^(?:und )?(?:was|wie ?viel|wieviel) (?:ist|sind|ergibt|ergeben|macht|machen|gibt) (?P<expr>.+)$", re.I),
    re.compile(r"^(?:rechne|berechne|rechne mir|berechne mir)(?: mal| bitte| schnell)* (?P<expr>.+?)(?: aus)?$", re.I),
    re.compile(r"^(?P<expr>[\d(].*)$", re.I),
]


def _raw(text: str) -> str:
    """Der Satz ohne "Jarvis" vorne und ohne Satzzeichen am Ende, Groß-/Kleinschreibung bleibt."""
    raw = re.sub(r"^\s*(?:(?:hey|hallo|okay|ok)\s+)?jarvis[\s,!.]*", "", str(text).strip(), flags=re.I)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw.rstrip(" .!?").strip(" „“\"'")


def match_calc(text: str) -> Intent | None:
    """"Was ist 15 mal 23?" -> rechnet sofort. Alles, was keine reine Rechnung ist, geht weiter."""
    from .calc import CalcError, evaluate

    raw = _raw(text)
    for pattern in _CALC:
        found = pattern.match(raw)
        if not found:
            continue
        expr = found.group("expr")
        try:
            value = evaluate(expr)
        except CalcError as exc:
            if str(exc) == "durch null":
                return Intent("calc", expr, {"error": "durch null"})
            continue
        return Intent("calc", expr, {"value": value})
    return None


# ---------------------------------------------------------------------- Webseiten und Suchen

_POLITE = r"(?:(?:kannst|könntest|würdest) du (?:mir )?(?:bitte )?|bitte )?"
_PLEASE = r"(?:(?:bitte|mal|kurz|schnell|doch|gleich) )*"
_ENGINES = (r"(?P<site>youtube|amazon|ebay|willhaben|geizhals|idealo|wikipedia|reddit|twitch|github|netflix|tiktok|"
            r"steam|google maps|maps|google bilder|google|spotify|stack overflow)")
_WEB: list[tuple[str, re.Pattern]] = [
    # "Such auf YouTube nach Katzenvideos", "Schau bei willhaben nach einem Sofa"
    ("search", re.compile(rf"^{_POLITE}(?:such|suche|schau|schaue|guck|gucke)(?: mir)? {_PLEASE}(?:auf|bei|in|im) "
                          rf"(?P<site>[\wäöüß. ]+?) nach (?P<q>.+)$", re.I)),
    # "Such Katzenvideos auf YouTube"
    ("search", re.compile(rf"^{_POLITE}(?:such|suche)(?: mir)? {_PLEASE}(?:nach )?(?P<q>.+?) (?:auf|bei|in|im) {_ENGINES}$",
                          re.I)),
    # "Google mal Pizza in der Nähe", "Such im Internet nach ...", "Such nach ..."
    ("search", re.compile(rf"^{_POLITE}(?:googl?e?|googel)(?: mal| doch| bitte| schnell)*(?: nach)? (?P<q>.+)$", re.I)),
    ("search", re.compile(rf"^{_POLITE}(?:such|suche|schau|schaue)(?: mir)? {_PLEASE}"
                          rf"(?:(?:im (?:internet|netz|web)|online|bei google|auf google|in google|mit google) )?nach (?P<q>.+)$",
                          re.I)),
    ("search", re.compile(rf"^{_POLITE}(?:such|suche)(?: mir)? {_PLEASE}(?:im (?:internet|netz|web) |online )?"
                          rf"(?P<q>(?:ein|eine|einen|einem|ne|nen|das|die|den|alles über|infos über|informationen über)\b.+)$",
                          re.I)),
    # "Zeig mir Bilder vom Eiffelturm"
    ("images", re.compile(rf"^{_POLITE}(?:zeig|zeige|such|suche)(?: mir)? {_PLEASE}(?:ein paar |einige )?(?:bilder|fotos) "
                          rf"(?:von|vom|von der|von dem|zu|zum|zur|über) (?P<q>.+)$", re.I)),
    # "Navigiere nach Graz", "Route zum Stephansplatz", "Zeig mir Hallstatt auf der Karte"
    ("route", re.compile(rf"^{_POLITE}(?:navigier|navigiere|führ|führe|bring|bringe)(?: mich)? {_PLEASE}"
                         rf"(?:nach|zu|zum|zur|in die|ins) (?P<q>.+)$", re.I)),
    ("route", re.compile(r"^(?:route|weg|navigation|wegbeschreibung) (?:nach|zu|zum|zur) (?P<q>.+)$", re.I)),
    ("map", re.compile(rf"^{_POLITE}(?:zeig|zeige)(?: mir)? {_PLEASE}(?P<q>.+?) auf (?:der karte|google maps|maps)$", re.I)),
    # "Spiel Bohemian Rhapsody auf YouTube", "Spiel auf Spotify Queen", "Spiel Thunderstruck"
    ("play", re.compile(rf"^{_POLITE}(?:spiel|spiele|play)(?: mir)? {_PLEASE}(?:auf|bei|in|über) (?P<site>youtube|spotify) "
                        rf"(?P<q>.+?)(?: ab)?$", re.I)),
    ("play", re.compile(rf"^{_POLITE}(?:spiel|spiele|play)(?: mir)? {_PLEASE}(?P<q>.+?) (?:auf|bei|in|über) "
                        rf"(?P<site>youtube|spotify)(?: ab)?$", re.I)),
    ("play", re.compile(rf"^{_POLITE}(?:spiel|spiele)(?: mir)? {_PLEASE}(?P<q>.+?)(?: ab)?$", re.I)),
    # "Geh auf Reddit", "Öffne die Seite von willhaben", "Öffne YouTube im Browser", "Öffne amazon.de"
    ("web", re.compile(rf"^{_POLITE}(?:geh|gehe|surf|surfe)(?: mal)? (?:auf|zu|nach) (?P<site>.+)$", re.I)),
    ("web", re.compile(rf"^{_POLITE}(?:öffne|öffnen|zeig|zeige|ruf|rufe|lade|lad)(?: mir)? {_PLEASE}(?:die |eine )?"
                       rf"(?:web ?seite|website|internetseite|homepage|seite|url) (?:von |vom |der |des )?(?P<site>.+?)(?: auf)?$",
                       re.I)),
    ("web", re.compile(rf"^{_POLITE}(?:öffne|öffnen|mach)(?: mir)? {_PLEASE}(?P<site>.+?) im (?:browser|internet)(?: auf)?$",
                       re.I)),
    ("web", re.compile(rf"^{_POLITE}(?:öffne|öffnen|starte|start)(?: mir)? {_PLEASE}(?P<site>\S+\.[a-z]{{2,4}}(?:/\S*)?)$",
                       re.I)),
]
# Das ist keine Suche oder kein Abspielen, das macht Jarvis anders (oder Claude)
_MEDIA_WORDS = re.compile(
    r"^(?:(?:die |etwas |wieder |mal )?musik(?: weiter| ab| wieder)?|weiter|wieder|ab|was|etwas|irgendwas|"
    r"(?:das |den )?(?:nächste|nächsten|vorherige|vorherigen|letzte|letzten) (?:lied|song|titel|stück|video))$", re.I)
_NOT_PLAYABLE = re.compile(r"\b(?:mit mir|mit uns|gegen mich|ein spiel|eine runde|meine|meinen|mein|was schönes|"
                           r"irgendwas|irgendetwas|etwas)\b", re.I)
_LOCAL_SEARCH = re.compile(r"\b(?:datei|dateien|ordner|desktop|dokument|dokumente|download|downloads|festplatte|"
                           r"laufwerk|pc|computer|rechner|papierkorb|e-?mails?|mails?|postfach)\b", re.I)
_MANY = re.compile(r"\b(?:und dann|und danach|dann|danach|anschließend)\b|\bund (?:öffne|starte|schließ|such|spiel|mach|geh)", re.I)


def match_web(text: str) -> Intent | None:
    """Webseiten öffnen, suchen, abspielen, Karten. Läuft auf dem Originaltext, damit die
    Suche so bleibt, wie Georg sie gesagt hat."""
    from . import web

    raw = _raw(text)
    if _MANY.search(raw):
        return None  # mehrere Befehle: das zerlegt match_parts
    for name, pattern in _WEB:
        found = pattern.match(raw)
        if not found:
            continue
        groups = found.groupdict()
        query = (groups.get("q") or "").strip(" ,.:")
        site = (groups.get("site") or "").strip(" ,.:")
        if name == "search":
            if _LOCAL_SEARCH.search(query) or (site and _LOCAL_SEARCH.search(site)):
                return None  # "Such auf meinem PC nach ...": das ist keine Websuche
            if site and web.search_engine(site) is None:
                continue
            if not query:
                continue
            if not site and web.site(query) is not None:
                return Intent("web", query)  # "Google YouTube": einfach die Seite
            return Intent("search", query, {"site": site.lower() or "google"})
        if name in ("images", "route", "map"):
            if not query or _LOCAL_SEARCH.search(query):
                continue
            return Intent(name, query)
        if name == "play":
            if not query or _MEDIA_WORDS.match(query) or (not site and _NOT_PLAYABLE.search(query)):
                continue
            query = re.sub(r"^(?:das lied|den song|das video|das album|die playlist|musik von|lieder von|songs von|"
                           r"etwas von|was von|ein lied von|einen song von)\s+", "", query, flags=re.I)
            return Intent("play", query, {"site": site.lower()})
        if name == "web":
            if not site or site.lower() in {"neu", "nochmal", "zu", "auf", "zurück"}:
                continue
            return Intent("web", site)
    return None


# ---------------------------------------------------------------------- Wetter

_WEATHER_ASK = re.compile(
    r"^(?:(?:wie|was) (?:wird|ist|wirds|sagt|gibts|gibt es)\b.*\bwetter|wetter\b|wettervorhersage|wetterbericht|"
    r"(?:zeig|sag|gib) (?:mir )?(?:das |den )?wetter)|"
    r"^(?:wie )?(?:warm|kalt|heiß) (?:ist|wird|wirds) es\b|"
    r"^wie ?viel(?:e)? grad (?:hat es|ist es|sind es|hat|wird es haben|haben wir|hats)\b|"
    r"^(?:regnet|schneit) es\b|^wird es (?:\w+ )?(?:regnen|schneien)\b|^gibt es (?:\w+ )?(?:regen|schnee)\b|"
    r"^(?:brauche|brauch) ich (?:\w+ )?(?:einen |nen |ne |eine )?(?:regen)?(?:schirm|jacke)\b"
)
_WHEN = re.compile(r"\b(heute|morgen|übermorgen|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|"
                   r"sonntag|gerade|aktuell|draußen)\b")
_NOT_PLACE = r"(?!(?:heute|morgen|übermorgen|am|gerade|aktuell|draußen|der nähe)\b)"
_PLACE = re.compile(rf"\b(?:in|für) ({_NOT_PLACE}[a-zäöüß][\wäöüß-]*(?: {_NOT_PLACE}[a-zäöüß][\wäöüß-]*){{0,2}})")


def match_weather(text: str) -> Intent | None:
    """"Wie wird das Wetter morgen?", "Regnet es?", "Brauche ich einen Schirm?", "Wie warm ist es in Graz?" """
    norm = normalize(text)
    if not _WEATHER_ASK.search(norm):
        return None
    if re.search(r"\b(?:öffne|app|karte|radar|seite)\b", norm):
        return None  # "Öffne die Wetter-App" ist ein Programm
    when_found = _WHEN.search(norm)
    when = when_found.group(1) if when_found else ""
    if when in ("gerade", "aktuell", "draußen"):
        when = "jetzt"
    if not when:
        # "Regnet es?" fragt nach jetzt, "Wird es regnen?" nach heute
        when = "jetzt" if re.match(r"^(?:regnet|schneit) es\b|^(?:wie )?(?:warm|kalt|heiß) ist es\b|^wie ?viel", norm) else "heute"
    place_found = _PLACE.search(norm)
    place = place_found.group(1).strip() if place_found else ""
    if place in ("der nähe", "der gegend"):
        place = ""
    if re.search(r"\b(?:regnet|regen|regnen|schirm|nass)\b", norm):
        ask = "regen"
    elif re.search(r"\b(?:schneit|schnee|schneien)\b", norm):
        ask = "schnee"
    elif re.search(r"\b(?:warm|kalt|heiß|grad|temperatur)\b", norm) and "wetter" not in norm:
        ask = "temperatur"
    else:
        ask = ""
    return Intent("weather", when, {"place": place, "ask": ask})


def match(text: str) -> Intent | None:
    message = match_message(text)
    if message is not None:
        return message
    reminder = match_reminder(text)
    if reminder is not None:
        return reminder
    for special in (match_calc, match_web, match_weather):
        found = special(text)
        if found is not None:
            return found
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
            if name == "settings_page":
                from .pc import settings_page

                arg = next((g for g in found.groups() if g), "").strip()
                if settings_page(arg) is None:
                    continue  # unbekannte Seite: vielleicht ein Programm ("Öffne die Steam-Einstellungen")
                return Intent(name, arg)
            if name == "radio":
                kind = "bluetooth" if "bluetooth" in norm else "wifi"
                on = not re.search(r"\b(?:aus|ab|ausschalten|deaktivier|deaktiviere|deaktivieren)\b", norm)
                return Intent(name, kind, {"on": on})
            return Intent(name)
    return None


# ---------------------------------------------------------------------- Mehrere Befehle auf einmal

_SPLIT = re.compile(r"\s*,?\s*\b(?:und dann|und danach|und anschließend|und|dann|danach|anschließend)\b\s*|\s*[,;]\s*",
                    re.I)
_VERBS = {"öffne", "öffnen", "starte", "start", "schließe", "schließ", "schliesse", "schliess", "beende", "beend",
          "installiere", "installier", "zeig", "zeige", "such", "suche", "spiel", "spiele", "geh", "gehe"}
# Teile, die selbst mit einem Verb oder Fragewort anfangen, bekommen kein fremdes Verb
_OWN_VERB = {
    "erzähl", "erzähle", "sag", "sage", "schreib", "schreibe", "mach", "mache", "spiel", "spiele", "such", "suche",
    "zeig", "zeige", "öffne", "starte", "schließ", "schließe", "beende", "installiere", "geh", "gehe", "ruf", "rufe",
    "schick", "schicke", "stell", "stelle", "dreh", "drehe", "erinnere", "lies", "frag", "frage", "hol", "hole",
    "kauf", "kaufe", "bestell", "bestelle", "gib", "finde", "find", "bau", "baue", "programmier", "programmiere",
    "prüf", "prüfe", "check", "lösch", "lösche", "schalt", "schalte", "fahr", "fahre", "wie", "was", "wer", "wo",
    "wann", "warum", "welche", "welcher", "welches", "ist", "sind", "kannst", "hast", "bist", "übersetz", "übersetze",
}
_SEARCHABLE = {"youtube", "amazon", "ebay", "willhaben", "geizhals", "idealo", "wikipedia", "reddit", "twitch", "github",
               "netflix", "tiktok", "spotify", "google"}


def match_parts(text: str) -> list[tuple[str, Intent]] | None:
    """"Öffne Spotify und Discord", "Mach den Gaming-Modus an und öffne Steam": jeder Teil
    einzeln. Nur wenn Jarvis jeden Teil selbst kann, sonst None (dann macht es Claude ganz)."""
    raw = _raw(text)
    pieces = [p.strip(" ,.") for p in _SPLIT.split(raw) if p and p.strip(" ,.")]
    if not 2 <= len(pieces) <= 5:
        return None
    verb = ""
    first = pieces[0].split()[0].lower() if pieces[0].split() else ""
    if first in _VERBS:
        verb = first
    parts: list[tuple[str, Intent]] = []
    for piece in pieces:
        intent = match(piece)
        words = piece.lower().split()
        if intent is None and verb and len(words) <= 4 and words[0] not in _OWN_VERB:
            # "Öffne Spotify und Discord": der zweite Teil bekommt das Verb vom ersten
            longer = f"{verb} {piece}"
            intent = match(longer)
            if intent is not None:
                piece = longer
        if intent is None or intent.name in ("stop", "reset", "workshop_cancel", "workshop_status"):
            return None
        parts.append((piece, intent))
    # "Öffne YouTube und such nach Katzen" -> gleich auf YouTube suchen
    merged: list[tuple[str, Intent]] = []
    for piece, intent in parts:
        if merged and intent.name in ("search", "play"):
            last_piece, last = merged[-1]
            opened = re.sub(r"[^a-zäöüß ]", "", last.arg.lower()).strip() if last.name in ("open", "web") else ""
            if opened in _SEARCHABLE and (intent.data.get("site") in ("", "google") or intent.name == "play"):
                site = "youtube" if intent.name == "play" and opened != "spotify" else opened
                data = dict(intent.data, site=site)
                merged[-1] = (f"{last_piece} {piece}", Intent(intent.name, intent.arg, data))
                continue
        merged.append((piece, intent))
    return merged


def spoken_time(now: dt.datetime) -> str:
    if now.minute == 0:
        return f"Es ist {now.hour} Uhr, Sir."
    return f"Es ist {now.hour} Uhr {now.minute}, Sir."


def spoken_date(now: dt.date) -> str:
    return f"Heute ist {WEEKDAYS[now.weekday()]}, der {now.day}. {MONTHS[now.month - 1]}, Sir."
