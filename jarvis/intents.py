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
    # "Gute Nacht": Jarvis bietet an, den PC herunterzufahren ("Geh schlafen" heißt dagegen: Mikrofon aus)
    ("good_night", re.compile(
        r"^(?:gute nacht|nacht|n8)(?: jarvis)?$|^ich (?:geh|gehe) (?:jetzt |dann )?(?:schlafen|ins bett|pennen)$|"
        r"^ich (?:bin|leg mich) (?:jetzt |dann )?(?:weg|im bett|hin)$"
    )),
    # "Danke": sofort, ohne Claude (spart Zeit und Kontingent)
    ("thanks", re.compile(
        r"^(?:(?:super|perfekt|top|cool|gut|ok|okay|alles klar)[, ]+)?(?:danke|danke schön|dankeschön|danke sehr|vielen dank|"
        r"merci|thx|thanks)(?: dir)?(?: jarvis)?(?:,? (?:das war'?s|passt|super))?$|^(?:gut gemacht|sehr gut|perfekt)(?: jarvis)?$"
    )),
    # "Was kannst du?" ist meist die erste Frage: sofort und kurz beantworten
    ("help", re.compile(
        r"^(?:was kannst du(?: (?:alles|so|eigentlich|denn|für mich))*(?: tun| machen)?|was kann ich (?:dich )?(?:alles )?(?:fragen|sagen)|"
        r"(?:zeig|zeige|sag|sage) mir,? was du (?:alles )?kannst|"
        r"hilfe|wobei kannst du (?:mir )?helfen|was sind deine (?:funktionen|befehle))$"
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
        r"^(?:(?:mach|stell|setz|setze|dreh) )?(?:die )?lautstärke (?:auf )?(\d{1,3}) ?(?:%|prozent)?"
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
        r"(mach|schalt) die musik aus|(stopp|stop|pausiere) die musik|halt die musik an|pausiere|pausieren)$"
    )),
    ("media_play", re.compile(
        r"^((musik|wiedergabe) (weiter|fortsetzen|abspielen)|weiter abspielen|play|"
        r"(spiel|spiele) (die |etwas |wieder )?musik( ab| weiter)?|((mach|schalt|schalte) )?(die )?musik (wieder )?an)$"
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
    ("show_desktop", re.compile(
        r"^(?:minimier|minimiere) (?:alle fenster|alles)$|^alles minimieren$|^alle fenster minimieren$|"
        r"^(?:zeig|zeige) (?:mir )?den desktop$|^desktop (?:anzeigen|zeigen)$"
    )),
    ("screenshot", re.compile(
        r"^(?:mach|mache|nimm|schieß|schiess) (?:mir )?(?:mal )?(?:einen |ein |nen )?(?:screenshot|bildschirmfoto)$|"
        r"^screenshot(?: machen| bitte)?$"
    )),
    ("disk_free", re.compile(
        r"^wie ?viel (?:speicher(?:platz)?|platz) (?:ist|habe ich|hab ich|hat der pc|hat mein pc)?(?: noch)? (?:frei|übrig)"
        r"(?: auf (?:der festplatte|den festplatten|meinem pc|dem pc))?$|"
        r"^wie voll (?:ist|sind) (?:meine|die) festplatten?$"
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
    # Ein und aus (nur mit voller Freigabe sofort, sonst fragt Claude nach)
    ("power_abort", re.compile(
        r"^(?:(?:herunterfahren|runterfahren|neustart|shutdown|ausschalten) (?:abbrechen|stoppen|stopp|aufhalten)|"
        r"nicht(?: herunterfahren| runterfahren| neu starten| ausschalten)?|"
        r"(?:brich|breche) das herunterfahren ab|(?:halt|stopp) das herunterfahren)$"
    )),
    ("power_off", re.compile(
        r"^(?:fahr|fahre) (?:den |meinen |die )?(?:pc|computer|rechner|laptop|kiste) (?:herunter|runter)(?: bitte)?$|"
        r"^(?:den |meinen )?(?:pc|computer|rechner|laptop) (?:herunterfahren|runterfahren|ausschalten|ausmachen)$|"
        r"^(?:schalt|schalte|mach|mache) (?:den |meinen |die )?(?:pc|computer|rechner|laptop|kiste) aus$|"
        r"^(?:herunterfahren|runterfahren|pc aus|computer aus|feierabend für heute fahr runter)$|"
        r"^(?:fahr|fahre) (?:dich |alles )?(?:herunter|runter)(?: bitte)?$"
    )),
    ("power_restart", re.compile(
        r"^(?:starte|start) (?:den |meinen |das )?(?:pc|computer|rechner|laptop|windows|system) neu$|"
        r"^(?:den |meinen |das )?(?:pc|computer|rechner|laptop|windows|system) neu ?starten$|^(?:neustart|neu starten|reboot)$"
    )),
    ("power_sleep", re.compile(
        r"^(?:(?:schick|schicke|versetz|versetze|setz|setze) )?(?:den |meinen )?(?:pc|computer|rechner|laptop) "
        r"(?:in den |auf )?(?:energiesparmodus|standby|schlafmodus|ruhemodus)(?: (?:schicken|versetzen))?$|"
        r"^(?:energiesparmodus|standby|ruhezustand)(?: an| bitte)?$|^(?:pc|computer|rechner) (?:schlafen legen|in den standby)$"
    )),
    ("power_logoff", re.compile(r"^(?:melde|meld) (?:mich|georg) ab$|^abmelden$")),
    # Licht (über Home Assistant, sonst Alexa): "Mach das Licht im Wohnzimmer aus", "Dimm das Licht auf 30 Prozent"
    ("light", re.compile(
        r"^(?:(?:mach|mache|schalt|schalte|dreh|drehe|stell|stelle) )?(?:das |die )?(?P<what>licht|lampe|lampen|deckenlicht|stehlampe)"
        r"(?: (?P<prep>im|in der|in dem|auf dem|vom|von der) (?P<room>[\wäöüß -]+?))? (?P<how>an|aus|ein|heller|dunkler|"
        r"auf (?P<pct>\d{1,3}) ?(?:%|prozent)(?: (?:stellen|dimmen))?)$|"
        r"^(?:dimm|dimme) (?:das |die )?(?P<what2>licht|lampe|lampen)(?: (?P<prep2>im|in der|in dem) (?P<room2>[\wäöüß -]+?))?"
        r"(?: auf (?P<pct2>\d{1,3}) ?(?:%|prozent))?$"
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
    ("restart_app", re.compile(
        rf"^{_ASK}(?:starte|start) (?!(?:(?:den|meinen|das|mein) )?(?:pc|computer|rechner|laptop)\b){_FILL}([\wäöüß .+-]+?) neu$|"
        rf"^{_ASK}(?!(?:(?:den|meinen|das|mein) )?(?:pc|computer|rechner|laptop)\b){_FILL}([\wäöüß .+-]+?) neu ?starten$"
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
        r"wie weit ist (?:die )?werkstatt|ist (?:die )?werkstatt (?:schon )?fertig|werkstatt[ -]?(?:status|stand))$"
    )),
    # "Mach Spotify an" nur für bekannte Programme, sonst ist es eher das Licht.
    ("open_known", re.compile(rf"^(?:mach|mache|schalt|schalte) {_FILL}(.+?) an$")),
]

# Bei Fragen ("Ist das Mikrofon aus?") nie stummschalten oder das Gespräch löschen.
_NOT_FOR_QUESTIONS = {"mute", "reset", "window_hide", "lock", "close", "gaming_off", "dark_on", "dark_off", "radio",
                      "power_off", "power_restart", "power_sleep", "power_logoff", "light"}
# Diese Absichten bekommen den Namen des Programms oder Ordners mit.
_WITH_NAME = {"install", "close", "open", "open_known", "folder", "restart_app"}
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
# Zweites Wort eines Namens ("Max Müller"), aber nicht "Max bitte" oder "Max Bescheid"
_MSG_NAME = (rf"(?P<person>{_MSG_WORD}"
             rf"(?:\s+(?!(?:bitte|bescheid|mal|kurz|schnell|noch|auch|gleich|jetzt|sofort)\b){_MSG_WORD})?)"
             r"(?:\s+(?:bitte|mal|kurz|schnell|noch|gleich))*")
_MESSAGE = [
    # Name vor der App: Die App trennt Name und Text, ein Satzzeichen ist nicht nötig.
    re.compile(
        rf"^(?:{_MSG_VERB}|sag|sage)\s+{_MSG_FILL}{_MSG_NOTE}(?:an\s+)?{_MSG_NAME}\s+"
        rf"{_MSG_NOTE}{_MSG_VIA}\s+{_MSG_APP}\s*[,:;\-–—]?\s*(?P<text>.+)$",
        re.I,
    ),
    # App vor dem Namen: Dann muss ein Komma oder Doppelpunkt den Namen vom Text trennen.
    re.compile(
        rf"^{_MSG_VERB}\s+{_MSG_FILL}{_MSG_NOTE}{_MSG_VIA}\s+{_MSG_APP}\s+(?:an\s+)?"
        rf"{_MSG_NAME}\s*[,:]\s*(?P<text>.+)$",
        re.I,
    ),
]
# Ohne App (dann die, über die Georg mit der Person sonst schreibt, sonst Discord). Hier muss
# ein Komma oder Doppelpunkt den Namen vom Text trennen.
_MESSAGE_NO_APP = [
    # "Schreib Max: bin gleich da", "Schick Anna, ich komme später"
    re.compile(rf"^{_MSG_VERB}\s+{_MSG_FILL}{_MSG_NOTE}(?:an\s+)?{_MSG_NAME}\s*[,:]\s*(?P<text>.+)$", re.I),
    # "Sag Max, dass ich später komme", "Sag Max Bescheid, dass ...", "Sag Max, ich bin gleich da"
    re.compile(rf"^(?:sag|sage)\s+{_MSG_FILL}{_MSG_NAME}(?:\s+bescheid)?\s*[,:]\s*(?P<text>.+)$", re.I),
    # "Richte Max aus, dass ich später komme"
    re.compile(rf"^(?:richte|richt)\s+{_MSG_FILL}{_MSG_NAME}\s+aus\s*[,:]?\s*(?P<text>.+)$", re.I),
]
# In einen Discord-Kanal: "Schreib in den Kanal allgemein: Wer ist online?"
_CHANNEL_MESSAGE = re.compile(
    rf"^{_MSG_VERB}\s+{_MSG_FILL}(?:in\s+den|im|in)\s+(?:text)?(?:kanal|channel)\s+#?(?P<channel>[\wÄÖÜäöüß\-]+)"
    rf"(?:\s+{_MSG_VIA}\s+discord)?\s*[,:]\s*(?P<text>.+)$",
    re.I,
)
# Kein Name: "Schreib mir auf Discord ..." ist eher eine Bitte an Jarvis selbst.
_NOT_A_PERSON = {
    "mir", "mich", "uns", "dir", "dich", "ihm", "ihr", "ihnen", "es", "das", "den", "die", "der", "dem",
    "ein", "eine", "einen", "etwas", "was", "alle", "jemandem", "jemand", "nachricht", "an",
    # "meinem Bruder", "deinen Namen": keine Namen, die eine Schnellsuche findet
    "mein", "meine", "meinem", "meinen", "meiner", "dein", "deine", "deinem", "deinen", "deiner",
    "sein", "seine", "seinem", "seinen", "ihrem", "ihren", "unser", "unserem", "unseren", "unserer",
    "eurem", "euren", "allen", "jedem", "keinem", "diesem", "dieser", "diesen",
    # "Sag mal, ...", "Sag Bescheid, wenn ...", "Sag ehrlich, ..."
    "mal", "bitte", "kurz", "schnell", "bescheid", "ehrlich", "einfach", "doch", "nochmal", "jarvis",
    "hallo", "hi", "danke", "ja", "nein", "so", "jetzt", "gleich", "sofort", "nur", "auch", "endlich",
    "lieber", "wieder", "wer", "wie", "wo", "warum", "wann", "welche", "welcher", "welches", "code",
    "einem", "einer", "kein", "keine", "noch", "zuerst", "dann", "danach", "lass", "uns",
    # "Sag gute Nacht, Jarvis", "Sag nichts, ich denke nach"
    "gute", "guten", "gutes", "nichts", "nix", "servus", "tschüss", "tschau",
}
# Text, der mit einem Relativwort anfängt, ist keine Nachricht ("Schreib Python-Code, der ...")
_NOT_A_TEXT = re.compile(r"^(?:der|die|den|dem|welche|welcher|welches|wo|womit|was)\b", re.I)


def _message_text(body: str) -> str | None:
    """Der Text der Nachricht. Indirekte Rede ("dass ich später komme") wird zur direkten
    ("Ich komme später"); was Jarvis nicht sicher umformen kann, macht Claude (None)."""
    body = body.strip()
    if re.match(r"(?:dass|das)\b", body, re.I):
        from .messaging import direct_speech

        return direct_speech(body)
    # "..., wer online ist" ist indirekt (Claude formuliert es um), "Wer ist online?" schon die Nachricht
    question = body.endswith("?") and not re.match(r"(?:ob|weil)\b", body, re.I)
    if (not question and re.match(r"(?:ob|wann|wo|wie|warum|weil|wer)\b", body, re.I)) or _NOT_A_TEXT.match(body):
        return None
    return body or None


def match_message(text: str) -> Intent | None:
    """Erkennt "Schreib <Person> auf <App>, <Text>" (auch "Sag Max, dass ich später komme").
    Ohne genannte App ist arg leer, dann entscheidet der Assistent."""
    raw = re.sub(r"^\s*(?:(?:hey|hallo|okay|ok)\s+)?jarvis[\s,!.]*", "", str(text).strip(), flags=re.I)
    found = _CHANNEL_MESSAGE.match(raw)
    if found:
        body = _message_text(found.group("text"))
        if body:
            return Intent("message", "discord", {"person": "#" + found.group("channel"), "text": body})
        return None
    for patterns, with_app in ((_MESSAGE, True), (_MESSAGE_NO_APP, False)):
        for pattern in patterns:
            found = pattern.match(raw)
            if not found:
                continue
            person = found.group("person").strip(" .,")
            if person.split()[0].lower() in _NOT_A_PERSON:
                continue
            body = _message_text(found.group("text"))
            if body is None:
                return None  # das formuliert Claude besser
            app = re.sub(r"\s", "", found.group("app").lower()) if with_app else ""
            return Intent("message", app, {"person": person, "text": body})
    return None


# ---------------------------------------------------------------------- Discord ohne Maus

_IN_DISCORD = r"(?:\s+(?:auf|in|bei|über)\s+discord)?"
_DISCORD: list[tuple[str, re.Pattern]] = [
    # "Geh in den Sprachkanal Zocken", "Tritt dem Voice-Channel Lobby bei", "Join Voice Lobby"
    ("voice", re.compile(
        r"^(?:geh|gehe|komm|komme|wechsel|wechsle|spring|joine?|tritt|verbinde mich mit|verbind mich mit)\s+"
        r"(?:(?:in|auf|bei)\s+discord\s+)?"
        r"(?:in\s+den\s+|dem\s+|zum\s+|mit\s+dem\s+|in\s+)?(?:sprachkanal|sprach[ -]?channel|voice[ -]?channel|voice|talk)\s+"
        rf"(?P<x>.+?){_IN_DISCORD}(?:\s+bei)?$")),
    # "Geh auf den Server Gilde", "Öffne den Discord-Server Gilde"
    ("server", re.compile(
        r"^(?:öffne|geh|gehe|wechsel|wechsle|spring|zeig mir|zeige mir)\s+(?:auf|in|zu)?\s*(?:den|meinen)?\s*"
        rf"(?:discord[ -]?)?server\s+(?!von\b|für\b)(?P<x>.+?){_IN_DISCORD}$")),
    # "Geh in den Kanal allgemein", "Öffne den Kanal memes auf Discord"
    ("channel", re.compile(
        r"^(?:geh|gehe|wechsel|wechsle|spring)\s+(?:(?:in|auf|bei)\s+discord\s+)?(?:in|zu)\s+(?:den\s+)?(?:text)?(?:kanal|channel)\s+"
        rf"(?!von\b)(?P<x>.+?){_IN_DISCORD}$")),
    ("channel", re.compile(
        r"^(?:öffne|zeig mir|zeige mir)\s+(?:den\s+)?(?:text)?(?:kanal|channel)\s+(?!von\b)(?P<x>.+?)\s+(?:auf|in)\s+discord$")),
    # "Öffne den Chat mit Max", "Geh in den Chat von Anna auf Discord"
    ("person", re.compile(
        r"^(?:öffne|geh|gehe|wechsel|wechsle|spring|zeig mir|zeige mir)\s+(?:in|zu)?\s*(?:den|meinen)?\s*"
        rf"(?:chat|dm|privatchat|unterhaltung|direktnachrichten)\s+(?:mit|von)\s+(?P<x>.+?){_IN_DISCORD}$")),
    # "Ruf Max auf Discord an", "Starte einen Anruf mit Max auf Discord"
    ("call", re.compile(r"^(?:ruf|rufe)\s+(?P<x>.+?)\s+(?:auf|in|über|per)\s+discord\s+an$")),
    ("call", re.compile(r"^(?:starte|start)\s+(?:einen\s+)?(?:anruf|call|sprachanruf)\s+mit\s+(?P<x>.+?)\s+(?:auf|in|über)\s+discord$")),
    # Mikrofon in Discord stumm/laut, taub (nichts hören): Discord schaltet um
    ("deafen", re.compile(
        r"^(?:(?:schalt|schalte|mach|mache|stell|stelle)\s+)?(?:mich\s+)?(?:in|bei|auf)\s+discord\s+(?:taub|wieder hörend)$|"
        r"^discord\s+(?:taub|deafen|undeafen|ton aus|ton an)$|^(?:deafen|undeafen)(?:\s+mich)?(?:\s+(?:in|auf|bei))?\s+discord$")),
    ("mute", re.compile(
        r"^(?:(?:schalt|schalte|mach|mache|stell|stelle)\s+)?(?:mich|mein mikro|mein mikrofon)\s+(?:in|bei|auf)\s+discord\s+"
        r"(?:stumm|laut|wieder laut|an|aus|ein)(?:\s+(?:schalten|stellen))?$|"
        r"^discord\s+(?:stumm|mute|unmute|entstummen|mikro aus|mikro an|mikrofon aus|mikrofon an)$|"
        r"^(?:mute|unmute|entstumme)(?:\s+mich)?(?:\s+(?:in|auf|bei))?\s+discord$")),
]
_DISCORD_NOT_A_TARGET = {"es", "das", "den", "die", "der", "dem", "ihn", "sie", "mich", "dich",
                         "ordner", "einstellungen", "log", "logs", "konsole"}


_CALL_ANYONE = re.compile(r"^(?:ruf|rufe)\s+(?P<x>[\wäöüß][\wäöüß .-]{0,40}?)\s+an$")
# Kein Discord-Anruf: Notrufe, Telefonnummern, Familie und Firmen ("Ruf Mama an", "Ruf bei Pizza Hut an"),
# "uns", "alle", und mit Zeit ("Ruf Max morgen an" ist eher eine Erinnerung). Das übernimmt Claude.
_NOT_CALLABLE = re.compile(
    r"\b(?:polizei|feuerwehr|notruf|notarzt|rettung|krankenwagen|ambulanz|hilfe|\d+|"
    r"bei|mein|meine|meinen|meinem|meiner|uns|euch|jemand|jemanden|niemand|alle|allen|"
    r"mama|mami|papa|papi|mutter|vater|oma|opa|eltern|tante|onkel|arzt|ärztin|doktor|praxis|firma|chef|chefin|"
    r"hotline|support|kundendienst|taxi|pizza|lieferdienst|restaurant|schule|büro|amt|"
    r"morgen|übermorgen|heute|später|gleich|nachher|abends|wieder|zurück|nochmal|noch)\b"
)


def match_discord(text: str) -> Intent | None:
    """Discord-Aktionen über die Schnellsuche und Discords eigene Tasten, ohne Maus."""
    norm = normalize(text)
    found = _CALL_ANYONE.match(norm)
    if found and "discord" not in norm:
        # "Ruf Max an": Discord-Anruf. Schreibt Georg mit Max über WhatsApp, übernimmt Claude (Assistant).
        target = re.sub(r"^(?:den|die|der|dem)\s+", "", found.group("x")).strip(" -")
        if target and target not in _DISCORD_NOT_A_TARGET and not _NOT_CALLABLE.search(target) \
                and not re.search(r"\b(?:whatsapp|telegram|handy|telefon)\b", target):
            return Intent("discord", "call", {"target": target, "any_app": True})
        return None
    if not re.search(r"discord|kanal|channel|voice|sprachkanal|talk|server|chat|dm\b", str(text), re.I):
        return None
    for kind, pattern in _DISCORD:
        found = pattern.match(norm)
        if not found:
            continue
        if kind in ("mute", "deafen"):
            return Intent("discord", kind)
        target = re.sub(r"^(?:dem|den|der|die|das)\s+", "", found.group("x")).strip(" -")
        if not target or target in _DISCORD_NOT_A_TARGET or re.search(r"\b(?:whatsapp|telegram|youtube|twitch)\b", target):
            return None
        if kind == "person" and re.search(r"\b(?:whats ?app|telegram)\b", norm):
            return None
        return Intent("discord", kind, {"target": target})
    return None


# ---------------------------------------------------------------------- Erinnerungen und Timer

_REMIND = [
    # "Erinnere mich in 20 Minuten an den Tee", "Erinnere mich morgen um 8 daran, den Müll rauszubringen"
    re.compile(r"^(?:bitte\s+)?erinnere?\s+mich\s+(?:bitte\s+)?(?P<when>.+?)(?:\s+|(?=,))"
               r"(?P<sep>an|ans|daran,?(?:\s+dass)?|,\s*dass)\s+(?P<what>.+?)[.!]?$", re.I),
    # "Kannst du mich in 10 Minuten an den Tee erinnern?"
    re.compile(r"^(?:kannst|könntest|würdest)\s+du\s+mich\s+(?:bitte\s+)?(?P<when>.+?)\s+"
               r"(?P<sep>an|ans|daran)\s+(?P<what>.+?)\s+erinnern[?.!]?$", re.I),
]
# "Weck mich um 7", "Stell mir einen Wecker auf 6:30" (Uhrzeit, keine Dauer), auch "um halb sieben"
_HOUR = r"(?:\d{1,2}|eins|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)(?![\wäöüß])"
_ALARM = [
    re.compile(r"^(?:bitte\s+)?(?:weck|wecke)\s+mich\s+(?:bitte\s+)?(?:morgen\s+früh\s+|morgen\s+)?"
               r"(?P<when>(?:um\s+)?(?:halb\s+)?" + _HOUR + r"(?:[:.]\d{2})?(?:\s+uhr)?)(?:\s+(?:auf|bitte))?[.!]?$", re.I),
    re.compile(r"^(?:stell|stelle|setz|setze|mach|mache)\s+(?:mir\s+)?(?:bitte\s+)?(?:einen|nen)?\s*wecker\s+"
               r"(?:auf|für|um)\s+(?P<when>(?:halb\s+)?" + _HOUR + r"(?:[:.]\d{2})?(?:\s+uhr)?)[.!]?$", re.I),
]
_TIMER = [
    re.compile(r"^(?:stell|stelle|setz|setze|start|starte|mach|mache)\s+(?:mir\s+)?(?:bitte\s+)?(?:einen|nen|ein)?\s*"
               r"(?:timer|wecker|countdown)\s+(?:auf|für|über|von|in)\s+(?P<dur>.+?)[.!]?$", re.I),
    re.compile(r"^(?:timer|countdown)\s+(?:auf|für|über)?\s*(?P<dur>.+?)[.!]?$", re.I),
]


_MINE = {"mein": "Ihr", "meine": "Ihre", "meinen": "Ihren", "meinem": "Ihrem", "meiner": "Ihrer", "meines": "Ihres"}
_INFINITIVE = {"bin": "sein", "hab": "haben", "habe": "haben", "muss": "müssen", "muß": "müssen", "will": "wollen",
               "kann": "können", "soll": "sollen", "darf": "dürfen", "mag": "mögen", "weiß": "wissen", "tu": "tun"}
_MODAL = {"muss", "muß", "will", "kann", "soll", "darf", "möchte", "sollte", "müsste", "wollte"}


def _for_georg(what: str) -> str:
    """Jarvis sagt die Erinnerung zu Georg: "meinen Tee" wird "Ihren Tee", und aus "(daran, dass) ich die Wäsche
    aufhänge" wird der Merkzettel "die Wäsche aufhängen" (sonst hieße es "Erinnerung, Sir: ich die Wäsche aufhänge")."""
    words = [_MINE.get(w.lower(), w) for w in what.split()]
    if len(words) >= 2 and words[0].lower() == "ich" and "," not in what:
        words = words[1:]
        if words[0].lower() in ("mich", "mir"):
            words = words[1:]
        last = words[-1]
        if last.lower() in _MODAL and len(words) > 1 and words[-2].lower().endswith("n"):
            words = words[:-1]  # "aufhängen muss" -> "aufhängen"
        elif last.lower() in _INFINITIVE:
            words[-1] = _INFINITIVE[last.lower()]
        elif re.search(r"[^aeiouäöü][ae]le$|[^aeiouäöü]ere$", last.lower()):
            words[-1] = last[:-1] + "n"  # "ändere" -> "ändern"
        elif last.lower().endswith("e"):
            words[-1] = last + "n"  # "aufhänge" -> "aufhängen"
    return " ".join(words)


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
        what = _for_georg(what)
        try:
            when = parse_when(found.group("when"), now)
        except ValueError:
            return None
        return Intent("remind", what, {"when": when, "what": what})
    for pattern in _ALARM:
        found = pattern.match(raw)
        if not found:
            continue
        clock = found.group("when").strip(" ,.").replace(".", ":")
        try:
            when = parse_when(clock if clock.lower().startswith("um ") else "um " + clock, now)
        except ValueError:
            return None
        what = "Ihr Wecker. Zeit aufzustehen"
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
                        rf"(?P<q>.+?)(?: ab| vor)?$", re.I)),
    ("play", re.compile(rf"^{_POLITE}(?:spiel|spiele|play)(?: mir)? {_PLEASE}(?P<q>.+?) (?:auf|bei|in|über) "
                        rf"(?P<site>youtube|spotify)(?: ab| vor)?$", re.I)),
    ("play", re.compile(rf"^{_POLITE}(?:spiel|spiele)(?: mir)? {_PLEASE}(?P<q>.+?)(?: ab| vor)?$", re.I)),
    # "Geh auf Reddit", "Öffne die Seite von willhaben", "Öffne YouTube im Browser", "Öffne amazon.de"
    ("go", re.compile(rf"^{_POLITE}(?:geh|gehe|surf|surfe)(?: mal)? (?:auf|zu|nach) (?P<site>.+)$", re.I)),
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
    r"(?:das |den )?(?:nächste|nächsten|vorherige|vorherigen|letzte|letzten) (?:lied|song|titel|stück|video)|"
    r"lauter|leiser|(?:es |das |den |die )?(?:lied |song |video |titel )?(?:nochmal|noch mal|noch einmal|von vorne?)|"
    r"(?:das |den )?(?:lied|song|video|titel) von (?:vorhin|gerade|eben)(?: nochmal| noch mal| noch einmal)?|"
    r"(?:ein|einen|eine) (?:lied|song|video|musikstück))$", re.I)
# Ziele, die keine Orte sind ("Bring mich zum Lachen", "Bring mich nach Hause": die Adresse kennt Maps nicht)
_NO_PLACE = re.compile(r"^(?:hause|haus|heim|lachen|weinen|nachdenken|schlafen|bett)$", re.I)
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
            if re.match(r"ob\b", query, re.I):
                return None  # "Schau nach, ob es Updates gibt": nachsehen soll Claude, nicht Google
            if site and web.search_engine(site) is None:
                continue
            if not query:
                continue
            if not site and web.site(query) is not None:
                return Intent("web", query)  # "Google YouTube": einfach die Seite
            return Intent("search", query, {"site": site.lower() or "google"})
        if name in ("images", "route", "map"):
            if not query or _LOCAL_SEARCH.search(query) or _NO_PLACE.match(query):
                continue
            return Intent(name, query)
        if name == "play":
            if not query or _MEDIA_WORDS.match(query) or (not site and _NOT_PLAYABLE.search(query)):
                continue
            if re.match(r"(?:nicht|kein|keine|keinen|nichts|bitte nicht)\b", query, re.I):
                continue  # "Spiel nicht so laut", "Spiel keine Musik mehr": kein Titel
            query = re.sub(r"^(?:das lied|den song|das video|das album|die playlist|musik von|lieder von|songs von|"
                           r"etwas von|was von|ein lied von|einen song von)\s+", "", query, flags=re.I)
            return Intent("play", query, {"site": site.lower()})
        if name == "go":
            if web.site(site) is None:
                continue  # "Geh auf stumm", "Geh zu meinen Downloads": keine Webseite
            return Intent("web", site)
        if name == "web":
            if not site or site.lower() in {"neu", "nochmal", "zu", "auf", "zurück"}:
                continue
            if re.search(r"\b(?:du|ich|wir)\b", site, re.I):
                continue  # "Öffne die Webseite, die du gebaut hast"
            return Intent("web", site)
    return None


# ---------------------------------------------------------------------- Wetter

_WEATHER_ASK = re.compile(
    r"^(?:(?:wie|was) (?:wird|ist|wirds|sagt|gibts|gibt es)\b.*\bwetter|wetter\b|wettervorhersage|wetterbericht|"
    r"(?:zeig|sag|gib) (?:mir )?(?:das |den )?wetter)|"
    r"^(?:wie )?(?:warm|kalt|heiß) (?:ist|wird|wirds) es\b|"
    r"^wie ?viel(?:e)? grad (?:hat es|ist es|sind es|wird es haben|haben wir|hats|"
    r"hat(?= (?:in|heute|morgen|draußen|gerade|aktuell)\b|$))\b|"
    r"^(?:regnet|schneit) es\b|^wird es (?:\w+ ){0,2}(?:regnen|schneien)\b|^gibt es (?:\w+ ){0,2}(?:regen|schnee)\b|"
    r"^(?:brauche|brauch) ich (?:\w+ )?(?:einen |nen |ne |eine )?(?:regen)?(?:schirm|jacke)\b"
)
_NOT_OUTSIDE = re.compile(
    r"\b(?:mein|meine|meinem|meinen|meiner|cpu|gpu|grafikkarte|prozessor|pc|computer|rechner|laptop|festplatte|"
    r"wasser|pool|kaffee|tee|ofen|backofen|kühlschrank|gefrierschrank|heizung|drinnen|innen|zimmer|wohnzimmer|"
    r"schlafzimmer|kinderzimmer|küche|bad|badezimmer|büro|keller|flur|garage|wohnung|haus|aquarium)\b")
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
    if "wetter" not in norm and _NOT_OUTSIDE.search(norm):
        return None  # "Wie viel Grad hat meine CPU?", "Wie warm ist es im Wohnzimmer?": das weiß Claude (Sensoren)
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
    for special in (match_discord, match_calc, match_web, match_weather):
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
                if name == "open" and re.search(r"(?:^|\s)an$", arg):
                    continue  # "Ruf die Polizei an", "Ruf mich an": kein Programm
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
            if name == "light":
                groups = found.groupdict()
                how = groups.get("how") or ("dimmen" if groups.get("what2") else "")
                pct = groups.get("pct") or groups.get("pct2")
                room = (groups.get("room") or groups.get("room2") or "").strip()
                if how in ("heller", "dunkler"):
                    pct = "80" if how == "heller" else "30"
                elif how == "dimmen" and not pct:
                    pct = "30"
                on = how not in ("aus",) and pct not in ("0", "00", "000")  # "auf 0 Prozent" heißt aus
                return Intent("light", room, {"on": on, "pct": int(pct) if pct and on else None, "said": text.strip(),
                                              "prep": groups.get("prep") or groups.get("prep2") or ""})
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
