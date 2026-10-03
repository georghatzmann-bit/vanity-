"""Wie Jarvis Georg anspricht: "Sir" wie im Film (Standard) oder z. B. "Chef" wie im Video ([ich] anrede).

Jarvis' feste Sätze sind mit "Sir" geschrieben. apply() tauscht das Wort beim Anzeigen, Sprechen und Schicken aus,
Claude bekommt die Anrede über die Persönlichkeit (persona.py).
"""

from __future__ import annotations

import re

DEFAULT = "Sir"
_word = DEFAULT
_SIR = re.compile(r"\bSir\b")


def clean(word: str) -> str:
    word = " ".join(str(word or "").split()).strip(" .,;:!?\"'")
    if not word or len(word) > 24 or not re.fullmatch(r"[\wÄÖÜäöüß.\- ]+", word):
        return DEFAULT
    return word[:1].upper() + word[1:]


def set_word(word: str) -> str:
    global _word
    _word = clean(word)
    return _word


def word() -> str:
    return _word


def from_config(cfg: dict) -> str:
    return clean(((cfg or {}).get("ich") or {}).get("anrede") or DEFAULT)


def apply(text: str) -> str:
    """"Sehr wohl, Sir." -> "Sehr wohl, Chef." (unverändert, solange die Anrede "Sir" ist)."""
    if _word == DEFAULT or not text or "Sir" not in text:
        return text
    return _SIR.sub(_word, text)


# ---------------------------------------------------------------------- Ton

TONES = ("butler", "locker")


def tone_from_config(cfg: dict) -> str:
    tone = str(((cfg or {}).get("ich") or {}).get("ton") or "butler").strip().lower()
    return tone if tone in TONES else "butler"


def persona_section(tone: str, word: str) -> str:
    """Für jarvis_home/CLAUDE.md: der lockere Ton wie im Video (Georg: "er soll genau so reden")."""
    if tone != "locker":
        return ""
    return (
        "## Dein Ton (Georg wollte es so)\n\n"
        f"- Locker, warm und natürlich wie ein persönlicher Assistent, der mitdenkt, nicht steif. Weiter per „Sie“, "
        f"die Anrede ist „{word}“.\n"
        "- Kleine Alltagssätze sind erlaubt, wie ein Mensch am Telefon: „Ach, und wo Sie gerade eh unterwegs sind …“, "
        f"„Gute Fahrt, {word}.“, „Tschau, tschau.“ Kein Butler-Humor in jedem Satz.\n"
        "- Denk einen Schritt weiter: Hat sich etwas geändert (ein Termin wurde verschoben), sag es und schlag gleich "
        "vor, was Georg mit der Zeit machen könnte. Steht etwas auf der Einkaufsliste und er ist unterwegs, erwähn es.\n"
    )


_NAME = r"(?P<word>[A-Za-zÄÖÜäöüß][\wÄÖÜäöüß.\-]{1,22})"
_CALL_ME = [
    re.compile(rf"^(?:bitte )?(?:nenn|nenne) mich(?: ab jetzt| ab sofort| von jetzt an| bitte| einfach| doch| wieder| lieber)* {_NAME}$", re.I),
    re.compile(rf"^(?:bitte )?(?:sag|sage)(?: ab jetzt| ab sofort| bitte| einfach| doch| wieder| lieber)* {_NAME} zu mir$", re.I),
    re.compile(rf"^(?:bitte )?(?:sprich|red|rede) mich(?: ab jetzt| ab sofort| bitte| einfach| doch| wieder| lieber)* "
               rf"(?:mit|als) {_NAME} an$", re.I),
]
_LOOSE = re.compile(r"^(?:(?:sprich|rede|red|sei)(?: ab jetzt| ab sofort| bitte| mal| doch| etwas| ein bisschen| wieder)* "
                    r"(?:lockerer|locker|entspannter|lässiger|lässig|wie (?:ein kumpel|ein freund|im video))|"
                    r"(?:lockerer|lockerer ton|ton locker))$", re.I)
_FORMAL = re.compile(r"^(?:(?:sprich|rede|red|sei)(?: ab jetzt| ab sofort| bitte| mal| doch| wieder)* "
                     r"(?:förmlich|förmlicher|wie ein butler|vornehm|vornehmer|seriös|seriöser|wieder normal)|"
                     r"(?:butler ton|ton butler|förmlicher ton))$", re.I)
_NOT_WORDS = {"an", "so", "mal", "nicht", "nie", "nochmal", "später", "morgen", "jetzt", "das", "es", "dich", "dir"}


def match_talk(text: str) -> tuple[str, str] | None:
    """("anrede", "Chef") / ("ton", "locker"|"butler") / None"""
    raw = " ".join(str(text or "").split()).strip(" .!?")
    raw = re.sub(r"^(?:hey |hallo |ok |okay )?jarvis[, ]+", "", raw, flags=re.I)
    raw = re.sub(r"[,]?\s*jarvis$", "", raw, flags=re.I)
    for pattern in _CALL_ME:
        found = pattern.match(raw)
        if found and found.group("word").lower() not in _NOT_WORDS:
            return "anrede", clean(found.group("word"))
    if _LOOSE.match(raw):
        return "ton", "locker"
    if _FORMAL.match(raw):
        return "ton", "butler"
    return None
