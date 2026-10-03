"""Welches Claude-Modell und wie viel Nachdenken: Jarvis wählt es für jede Aufgabe selbst.

Die meisten Befehle sind kurz ("Wie hoch ist der Eiffelturm?", "Mach die Musik leiser und öffne Discord"),
dafür reicht Sonnet mit wenig Nachdenken, und Jarvis antwortet flott. Texte, Recherche und Erklärungen
bekommen mittleres Nachdenken. Knifflige Sachen (Fehlersuche am PC, Code, Planung, Analysen, Geld und
Verträge) bekommen Opus mit gründlichem Nachdenken. Ganz oben steht "maximal", nur wenn Georg es will
("Denk richtig gründlich nach", "Nimm das stärkste Modell").

Georg kann jederzeit eingreifen: "schnell", "kurz und knapp", "denk gründlich nach", "mit Opus".
Korrigiert er Jarvis ("Das stimmt nicht"), denkt Jarvis beim nächsten Mal eine Stufe gründlicher, und
eine kurze Nachfrage zu einer gründlichen Antwort bleibt gründlich.

Geht ein Modell mit Georgs Abo nicht (oder ist sein Kontingent dafür aufgebraucht), merkt sich Jarvis das
für ein paar Stunden und nimmt das nächstkleinere. Wird das Wochenkontingent knapp (ab 90 Prozent oder wenn
Claude warnt, siehe verbrauch.py), denkt Jarvis eine Stufe sparsamer, außer Georg will es ausdrücklich gründlich.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass

LEVELS = ("schnell", "normal", "gruendlich", "maximal")
SPOKEN = {"schnell": "schnell", "normal": "normal", "gruendlich": "gründlich", "maximal": "maximal"}
# Modell und Nachdenken je Stufe (in config.toml unter [brain] änderbar, z. B. stufe_maximal = "opus xhigh")
DEFAULT_LEVELS = {
    "schnell": ("sonnet", "low"),
    "normal": ("sonnet", "medium"),
    "gruendlich": ("opus", "high"),
    "maximal": ("fable", "high"),
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Geht ein Modell nicht, kommt das nächstkleinere dran.
SMALLER = {"fable": "opus", "opus": "sonnet", "sonnet": "haiku"}
# Ohne Antwort so viel länger warten, bevor Jarvis abbricht (gründliches Nachdenken ist lange still).
PATIENCE = {"schnell": 1.0, "normal": 1.0, "gruendlich": 2.0, "maximal": 4.0}
# So lange gilt eine kurze Nachfrage noch als Teil der vorigen Aufgabe (Sekunden).
FOLLOW_UP_SECONDS = 4 * 60
NAMES = {"haiku": "Haiku", "sonnet": "Sonnet", "opus": "Opus", "fable": "Fable"}


@dataclass(frozen=True)
class Choice:
    level: str  # schnell, normal, gruendlich, maximal
    model: str  # haiku, sonnet, opus, fable (oder ein voller Modellname)
    effort: str  # low ... max, leer = Standard von Claude Code
    reason: str = ""

    def label(self) -> str:
        """Für Fenster und Protokoll: "Opus · gründlich"."""
        return f"{model_name(self.model)} · {SPOKEN.get(self.level, self.level)}"

    @property
    def patience(self) -> float:
        return PATIENCE.get(self.level, 1.0)


def model_name(model: str) -> str:
    """"opus" -> "Opus", "claude-sonnet-5-5" -> "Sonnet"."""
    low = str(model or "").lower()
    for key, name in NAMES.items():
        if key in low:
            return name
    return model or "Standard"


def family(model: str) -> str:
    """"claude-opus-5-5" -> "opus" (für die Liste der gerade gesperrten Modelle)."""
    low = str(model or "").lower()
    return next((key for key in NAMES if key in low), low)


def parse_level(value) -> tuple[str, str]:
    """"opus high" -> ("opus", "high"), "sonnet" -> ("sonnet", ""), ungültig -> ("", "")."""
    words = str(value or "").lower().replace(",", " ").split()
    model = next((w for w in words if w not in EFFORTS), "")
    effort = next((w for w in words if w in EFFORTS), "")
    return model, effort


# ---------------------------------------------------------------------- Woran man die Stufe erkennt

def _words(*parts: str) -> re.Pattern:
    return re.compile(r"\b(?:" + "|".join(parts) + r")", re.I)


# Georg sagt es ausdrücklich
_SAYS_MAX = _words(
    r"ultrathink", r"denk (?:mal )?(?:richtig|ganz|sehr|extrem|wirklich|besonders|maximal) (?:\w+ )?(?:gründlich|genau|tief|lange|intensiv|gut)",
    r"so gründlich wie (?:möglich|es geht|du kannst)", r"mit (?:voller|maximaler|aller) (?:denkleistung|power|kraft|leistung)",
    r"(?:mit|nimm|nutz|nutze) (?:fable|(?:dem|deinem|das|dein|den|deinen) (?:stärkste|beste|klügste|schlauste)[nms]? modell)",
    r"(?:nimm|lass) dir (?:richtig |ruhig |alle |viel )?zeit", r"maximal(?:e|es)? (?:nachdenken|denkleistung)",
)
_SAYS_DEEP = _words(
    r"gründlich", r"sorgfältig", r"genau (?:überlegen|überleg|nachdenken|prüfen|anschauen|ansehen)",
    r"denk (?:mal |gut |kurz |bitte |erst )?(?:darüber |drüber )?nach", r"überleg (?:dir )?(?:das )?(?:mal |gut |genau |bitte )",
    r"mit opus", r"ausführlich", r"im detail", r"detailliert", r"schritt für schritt", r"tiefgehend", r"präzise",
)
_SAYS_FAST = _words(
    r"kurz und knapp", r"nur (?:ganz )?kurz", r"auf die schnelle", r"in (?:einem|zwei) sätzen?", r"ganz kurz",
    r"mit haiku", r"schnelle frage", r"kurze frage",
    r"(?:antworte|antwort|sag|sage|erklär|erkläre|fass|beschreib|beschreibe) (?:mir |es |das |bitte )*(?:ganz |nur )?(?:kurz|schnell)\b",
)
# Knifflig: Code, Fehlersuche, Analysen, Planung, Geld, Recht, Gesundheit
_DEEP_TOPICS = [
    ("Code", _words(
        r"code\b", r"quellcode", r"programmier", r"skript", r"script", r"python", r"javascript", r"typescript",
        r"java\b", r"c\+\+", r"c#", r"html", r"css\b", r"sql\b", r"regex", r"regulären? ausdruck", r"json\b",
        r"\bapi\b", r"\bbug", r"debug", r"stacktrace", r"traceback", r"exception", r"kompilier", r"compiler",
        r"github", r"\bgit\b", r"docker", r"linux", r"kommandozeile", r"terminal", r"powershell-(?:skript|befehl)",
        r"batch-?datei", r"excel-?formel", r"formel für", r"makro",
    )),
    ("Fehlersuche", _words(
        r"warum (?:geht|funktioniert|startet|läuft|lädt|klappt|reagiert|stürzt|hängt|ruckelt|ist (?:mein|der|die|das))",
        r"(?:funktioniert|geht|startet|lädt|klappt|reagiert) (?:\w+ )?(?:nicht|kaum)(?: mehr)?\b", r"stürzt (?:\w+ )?ab",
        r"absturz", r"abstürze", r"bluescreen", r"fehlermeldung", r"fehlercode", r"problem (?:mit|bei)", r"ruckelt",
        r"laggt", r"\blags?\b", r"hängt sich auf", r"friert (?:\w+ )?ein", r"(?:ist|wird) (?:so |total |extrem )?langsam",
        r"reparier", r"beheb", r"diagnos", r"treiber", r"überhitz", r"kein (?:ton|bild|internet|sound)",
    )),
    ("Analyse", _words(
        r"analysier", r"analyse", r"vergleich", r"bewerte", r"abwäg", r"vor- und nachteile", r"pro und contra",
        r"strategie", r"konzept", r"optimier", r"durchrechn", r"rechne (?:mir )?(?:aus|durch)", r"kalkulation",
        r"\bplan(?:e|ung)? (?:für|mir|meinen|meine|eine|einen|das|die)", r"entscheid", r"was ist besser",
        r"was (?:lohnt|rentiert) sich", r"beweis", r"gleichung", r"rätsel", r"logik",
    )),
    ("Geld und Recht", _words(
        r"steuer", r"finanz", r"invest", r"aktie", r"kredit", r"versicherung", r"vertrag", r"rechtlich",
        r"gesetz", r"anwalt", r"abmahnung", r"mietrecht", r"kündigungsfrist", r"widerruf",
    )),
    ("Gesundheit", _words(r"symptom", r"medizin", r"medikament", r"nebenwirkung", r"diagnose", r"schmerz")),
]
# Mittel: Texte, Recherche, Erklärungen, Ideen, Aufräumen am PC
_NORMAL_TOPICS = [
    ("Text", _words(
        r"formulier", r"verfass", r"entwurf", r"entwirf", r"übersetz", r"zusammenfass", r"fass .{1,60} zusammen",
        r"korrigier", r"umformulier", r"gedicht", r"geschichte", r"\brede\b", r"bewerbung", r"anschreiben",
        r"\bbrief", r"e-?mail an", r"mail an", r"schreib (?:mir )?(?:einen|eine|ein) (?:text|mail|e-mail|brief|post|beitrag|beschreibung|bewertung)",
    )),
    ("Recherche", _words(
        r"recherchier", r"such (?:mir )?(?:raus|heraus)", r"find (?:mir )?(?:raus|heraus)", r"finde (?:mir )?(?:raus|heraus)",
        r"informier", r"was gibt es neues", r"was gibt's neues", r"neuigkeiten", r"nachrichten (?:über|zu|von)",
        r"aktuelle[nrs]?\b", r"testbericht", r"bewertungen",
    )),
    ("Erklärung", _words(
        r"erklär", r"wie funktioniert", r"was ist der unterschied", r"unterschied zwischen", r"wieso", r"weshalb",
        r"warum (?:ist|sind|hat|haben|gibt|kann|können|wird|werden|soll)",
    )),
    ("Ideen", _words(
        r"ideen?\b", r"vorschläge", r"vorschlag", r"empfiehl", r"empfehlung", r"tipps?\b", r"was soll ich",
        r"was würdest du", r"hilf mir", r"wie kann ich", r"wie mache ich", r"wie schaffe ich",
    )),
    ("Mehrere Schritte", _words(
        r"organisier", r"aufräum", r"räum .{1,40} auf", r"sortier", r"alle (?:dateien|fenster|programme|bilder|fotos)",
        r"einricht", r"richte .{1,40} ein", r"konfigurier", r"automatisch", r"jede[nrs]? (?:datei|ordner)",
        r"\bund dann\b", r"\bdanach\b", r"anschließend",
    )),
]
# "Das stimmt nicht", "Falsch", "Versuch es nochmal": beim nächsten Mal gründlicher (ein bloßes "Nein"
# ist meist die Antwort auf eine Frage, keine Korrektur)
_CORRECTION = re.compile(
    r"^(?:(?:nein|nee|nö)[,.!]? )?(?:falsch|quatsch|stimmt nicht|das stimmt (?:so )?nicht|das ist (?:falsch|nicht richtig|quatsch)|"
    r"so nicht|das war (?:falsch|nicht richtig|nicht das|nicht gemeint)|du (?:hast dich|irrst dich|liegst falsch)|"
    r"das meinte ich nicht|das wollte ich nicht|das klappt (?:so )?nicht|das geht (?:so )?nicht|"
    r"versuch(?:'s| es)? (?:nochmal|noch einmal|anders)|probier(?:'s| es)? (?:nochmal|noch einmal|anders))\b", re.I)
# Klingt nach einer Nachfrage zur vorigen Aufgabe ("Und wie behebe ich das?", "Warum?", "Mach weiter")
_FOLLOW_UP = re.compile(
    r"^(?:und|aber|also|dann|ok|okay|gut|alles klar|weiter|mach weiter|noch|warum|wieso|weshalb|was ist mit|"
    r"wie ist es mit|geht das|klappt das|kannst du das|kannst du es|zeig)\b|"
    r"\b(?:dies|dieses|diese|dieser|dafür|damit|davon|daran|darauf|dazu|dabei|davor|danach)\b|\bdas\W*$", re.I)


def _normalize(text: str) -> str:
    text = " ".join(str(text or "").lower().split())
    return re.sub(r"^(?:(?:hey|hallo|okay|ok) )?jarvis[,:]?\s*", "", text)


def classify(text: str) -> tuple[str, str]:
    """Die Stufe für eine Aufgabe, nur nach dem Text: (Stufe, Grund)."""
    norm = _normalize(text)
    if not norm:
        return "schnell", "leer"
    if _SAYS_MAX.search(norm):
        return "maximal", "ausdrücklich gewünscht"
    deep = next((name for name, pattern in _DEEP_TOPICS if pattern.search(norm)), "")
    words = len(norm.split())
    if _SAYS_FAST.search(norm):
        return "schnell", "ausdrücklich kurz"
    if _SAYS_DEEP.search(norm):
        return "gruendlich", "ausdrücklich gewünscht"
    if deep:
        return "gruendlich", deep
    if words > 140:
        return "gruendlich", "lange Aufgabe"
    normal = next((name for name, pattern in _NORMAL_TOPICS if pattern.search(norm)), "")
    if normal:
        return "normal", normal
    if words > 45:
        return "normal", "längere Aufgabe"
    return "schnell", "kurze Frage"


class Chooser:
    """Wählt pro Aufgabe die Stufe und damit Modell und Nachdenken.

    modellwahl (in [brain]): "auto" (empfohlen), fest "schnell", "normal", "gruendlich" oder "maximal",
    oder "aus" (dann wie früher: das erste Modell aus `models` mit `effort`).
    """

    def __init__(self, cfg: dict | None = None, sparing=None) -> None:
        cfg = cfg or {}
        self._sparing = sparing  # () -> bool: Kontingent knapp? (Standard: verbrauch.sparing)
        mode = str(cfg.get("modellwahl", "auto") or "auto").strip().lower().replace("ü", "ue")
        self.mode = mode if mode in LEVELS or mode in ("auto", "aus") else "auto"
        self.levels: dict[str, tuple[str, str]] = {}
        for level, (model, effort) in DEFAULT_LEVELS.items():
            own_model, own_effort = parse_level(cfg.get(f"stufe_{level}", ""))
            self.levels[level] = (own_model or model, own_effort or effort)
        self._blocked: dict[str, tuple[float, str]] = {}  # Modell -> (bis wann, warum)
        self._lock = threading.Lock()
        self.last: Choice | None = None
        self._last_at = 0.0
        self._hurry_until = 0.0  # Georg hat angetrieben ("Schneller!", die Peitsche): bis dahin eine Stufe flotter

    @property
    def enabled(self) -> bool:
        return self.mode != "aus"

    # ------------------------------------------------------------------ Wahl

    def choose(self, text: str, now: float | None = None) -> Choice | None:
        """Die Wahl für diese Aufgabe (None = Modellwahl aus)."""
        if not self.enabled:
            return None
        now = time.monotonic() if now is None else now
        if self.mode in LEVELS:
            level, reason = self.mode, "fest eingestellt"
        else:
            level, reason = classify(text)
            level, reason = self._in_context(text, level, reason, now)
            if self.hurried(now) and level in ("normal", "gruendlich") and reason != "ausdrücklich gewünscht":
                level, reason = LEVELS[LEVELS.index(level) - 1], "angetrieben"
            if level in ("gruendlich", "maximal") and reason != "ausdrücklich gewünscht" and self.sparing():
                level, reason = LEVELS[LEVELS.index(level) - 1], "Kontingent knapp"
        choice = self.make(level, reason)
        self.last, self._last_at = choice, now
        return choice

    def _in_context(self, text: str, level: str, reason: str, now: float) -> tuple[str, str]:
        """Kurze Nachfragen bleiben auf der Stufe der vorigen Aufgabe, eine Korrektur geht eine Stufe hoch."""
        last = self.last
        if last is None or now - self._last_at > FOLLOW_UP_SECONDS or reason in ("ausdrücklich kurz", "ausdrücklich gewünscht"):
            return level, reason
        norm = _normalize(text)
        rank = LEVELS.index
        if _CORRECTION.match(norm):
            higher = LEVELS[min(rank(last.level) + 1, rank("gruendlich"))] if last.level != "maximal" else "maximal"
            if rank(higher) > rank(level):
                return higher, "Korrektur: gründlicher"
        if len(norm.split()) <= 12 and rank(last.level) > rank(level) and _FOLLOW_UP.search(norm):
            return last.level, "Nachfrage"
        return level, reason

    def make(self, level: str, reason: str = "") -> Choice:
        """Modell und Nachdenken für eine Stufe. Ein gerade gesperrtes Modell wird durch das
        nächstkleinere ersetzt (das Nachdenken bleibt)."""
        model, effort = self.levels.get(level, self.levels["schnell"])
        seen = set()
        while self.blocked(model) and family(model) in SMALLER and model not in seen:
            seen.add(model)
            model = SMALLER[family(model)]
        return Choice(level, model, effort, reason)

    # ------------------------------------------------------------------ Antreiben und Loben

    def hurry(self, seconds: float = 15 * 60, now: float | None = None) -> None:
        """Georg treibt an: eine Weile denkt Jarvis eine Stufe flotter (gründlich wird normal, normal wird schnell).
        Was Georg ausdrücklich gründlich will, bleibt gründlich."""
        now = time.monotonic() if now is None else now
        self._hurry_until = now + max(60.0, seconds)

    def relax(self) -> None:
        """Georg lobt: wieder so gründlich wie die Aufgabe es braucht."""
        self._hurry_until = 0.0

    def sparing(self) -> bool:
        """Ist das Claude-Kontingent knapp? Ein kaputter Zähler bremst nie."""
        try:
            if self._sparing is not None:
                return bool(self._sparing())
            from .verbrauch import sparing

            return sparing()
        except Exception:
            return False

    def hurried(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return now < self._hurry_until

    # ------------------------------------------------------------------ Gesperrte Modelle

    def block(self, model: str, seconds: float, why: str = "") -> None:
        """Dieses Modell eine Weile nicht nehmen (gibt es im Abo nicht, Kontingent dafür aufgebraucht)."""
        if not model:
            return
        with self._lock:
            self._blocked[family(model)] = (time.monotonic() + max(60.0, seconds), why)

    def blocked(self, model: str) -> bool:
        key = family(model)
        with self._lock:
            until = self._blocked.get(key)
            if until is None:
                return False
            if time.monotonic() >= until[0]:
                del self._blocked[key]
                return False
            return True

    def smaller(self, model: str) -> str:
        """Das nächstkleinere Modell (für den sofortigen zweiten Versuch), leer = keins."""
        return SMALLER.get(family(model), "")

    def state(self) -> dict:
        """Für die Einstellungen: Modus, Stufen und was gerade gesperrt ist."""
        with self._lock:
            blocked = {k: why for k, (until, why) in self._blocked.items() if until > time.monotonic()}
        return {"mode": self.mode, "levels": {k: " ".join(v).strip() for k, v in self.levels.items()},
                "blocked": blocked, "last": self.last.label() if self.last else "", "eilig": self.hurried()}
