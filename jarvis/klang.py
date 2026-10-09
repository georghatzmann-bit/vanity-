"""Ähnlich klingende Namen finden: Die Spracherkennung schreibt Namen oft so, wie sie klingen
("Spottifei", "Diskort", "Stiem"). Jarvis findet trotzdem das Richtige (Spotify, Discord, Steam),
bei Programmen, Kontakten, eigenen Befehlen und Werkstatt-Projekten.

Verglichen wird zweimal: die Schreibweise (difflib) und der Klang (Kölner Phonetik, das deutsche
Gegenstück zu Soundex). Englische Schreibweisen werden vorher eingedeutscht ("discord" -> "diskord"),
denn so spricht Georg sie aus.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Iterable

_VOWELS = set("aeijouyäöü")


def plain(text: str) -> str:
    """Kleinbuchstaben ohne Satzzeichen und Leerzeichen."""
    return re.sub(r"[^a-zäöüß0-9]", "", str(text or "").lower())


def _germanize(word: str) -> str:
    """Englische Schreibweisen so, wie man sie auf Deutsch hört."""
    word = word.replace("ß", "s")
    for old, new in (("ck", "k"), ("ph", "f"), ("sh", "sch"), ("th", "t"), ("ee", "i"), ("ea", "i"),
                     ("oo", "u"), ("qu", "kw"), ("tz", "z")):
        word = word.replace(old, new)
    word = re.sub(r"c(?=[aoukrlt]|$)", "k", word)  # discord, creative, mac
    return word.replace("y", "i")


def koelner(text: str) -> str:
    """Kölner Phonetik: gleich klingende deutsche Wörter bekommen denselben Ziffern-Code
    ("Meyer" und "Maier" -> "67")."""
    word = _germanize(re.sub(r"[^a-zäöüß]", "", str(text or "").lower()))
    codes: list[str] = []
    for i, ch in enumerate(word):
        prev = word[i - 1] if i else ""
        nxt = word[i + 1] if i + 1 < len(word) else ""
        if ch in _VOWELS:
            code = "0"
        elif ch == "h":
            code = ""
        elif ch == "b":
            code = "1"
        elif ch == "p":
            code = "3" if nxt == "h" else "1"
        elif ch in "dt":
            code = "8" if nxt and nxt in "csz" else "2"
        elif ch in "fvw":
            code = "3"
        elif ch in "gkq":
            code = "4"
        elif ch == "c":
            if i == 0:
                code = "4" if nxt and nxt in "ahkloqrux" else "8"
            else:
                code = "4" if nxt and nxt in "ahkoqux" and prev not in ("s", "z") else "8"
        elif ch == "x":
            code = "8" if prev and prev in "ckq" else "48"
        elif ch == "l":
            code = "5"
        elif ch in "mn":
            code = "6"
        elif ch == "r":
            code = "7"
        elif ch in "sz":
            code = "8"
        else:
            code = ""
        codes.append(code)
    collapsed: list[str] = []
    for digit in "".join(codes):
        if not collapsed or collapsed[-1] != digit:
            collapsed.append(digit)
    return "".join(collapsed[:1] + [d for d in collapsed[1:] if d != "0"])


def similarity(a: str, b: str) -> float:
    """0 bis 1: wie ähnlich zwei Namen geschrieben sind und klingen (das Bessere von beidem zählt)."""
    pa, pb = plain(a), plain(b)
    if not pa or not pb:
        return 0.0
    if pa == pb:
        return 1.0
    spelled = SequenceMatcher(None, pa, pb).ratio()
    ka, kb = koelner(pa), koelner(pb)
    if len(ka) < 2 or len(kb) < 2:
        return spelled  # zu kurz für einen Klangvergleich ("Ok", "Bo")
    sound = SequenceMatcher(None, ka, kb).ratio()
    if ka[0] != kb[0]:
        sound *= 0.8  # anderer Anfangslaut: eher ein anderes Wort
    return max(spelled, 0.4 * spelled + 0.6 * sound)


def closest(name: str, candidates: Iterable[str], cutoff: float = 0.78, same_start: bool = False) -> str | None:
    """Der Kandidat, der am ähnlichsten klingt, oder None, wenn keiner gut genug passt.
    same_start: nur Kandidaten mit demselben Anfangsbuchstaben ("Danke" ist nie der Befehl "Anke")."""
    best, best_score = None, cutoff
    first = plain(name)[:1]
    for candidate in candidates:
        if same_start and plain(candidate)[:1] != first:
            continue
        score = similarity(name, candidate)
        if score >= best_score and (best is None or score > best_score):
            best, best_score = candidate, score
    return best
