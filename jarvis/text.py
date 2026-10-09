"""Text für die Sprachausgabe vorbereiten und in Sätze zerlegen."""

from __future__ import annotations

import re

# Nach diesen Wörtern ist ein Punkt kein Satzende ("ca. 20", "Dr. Müller", "Nr. 5").
# Einzelne Buchstaben ("z. B.", "d. h.") regelt _is_abbreviation selbst.
_ABBREVIATIONS = {
    "bzw", "ca", "dr", "nr", "usw", "etc", "evtl", "ggf", "inkl", "st",
    "str", "vgl", "min", "max", "mio", "mrd", "prof", "hr", "fr",
    "ggü", "sog", "zzgl", "abs", "bspw", "tel", "jan", "feb", "mär", "apr", "jun",
    "jul", "aug", "sep", "sept", "okt", "nov", "dez", "mo", "di", "mi", "do", "sa",
}

_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"<?((?:https?://|www\.)[^\s<>()\[\]\"']+)>?", re.I)
_CODE_BLOCK = re.compile(r"```.*?```", re.S)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_BULLET = re.compile(r"^[ \t]*(?:[-*•]|\d+\))[ \t]+", re.M)
# "1. Äpfel" nur in echten Listen entfernen, sonst bleibt "3. Oktober ist ein Feiertag" heil.
_NUMBERED = re.compile(r"^[ \t]*\d+\.[ \t]+", re.M)
_TABLE_RULE = re.compile(r"^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$", re.M)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.M)
_EMPHASIS = re.compile(r"(\*\*|\*)(\S(?:.*?\S)?)\1")
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\uFE0F\u200D]")
# "Sources:", "**Quellen:**", "## Sources": ab hier folgt nur noch die Linkliste der Websuche.
_SOURCES = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:sources?|quellen?(?:angaben)?)[ \t]*(?:\*\*|__)?[ \t]*(?::|$)",
    re.I | re.M,
)


def starts_sources(sentence: str) -> bool:
    """True, wenn mit diesem Satz die Quellenliste beginnt ("Sources:", "**Quellen:**")."""
    return bool(_SOURCES.match(sentence.lstrip()))


def strip_sources(text: str) -> str:
    """Schneidet die Quellenliste am Ende der Antwort ab."""
    match = _SOURCES.search(text)
    return (text[: match.start()] if match else text).strip()


def _url_host(match: re.Match) -> str:
    """Aus "https://www.orf.at/wetter/," wird "orf.at," (Satzzeichen bleiben)."""
    url = match.group(1)
    tail = re.search(r"[.,;:!?]*$", url).group()
    url = url[: len(url) - len(tail)]
    host = re.sub(r"^(?:https?://)?(?:www\.)?", "", url, flags=re.I)
    return re.split(r"[/?#:]", host)[0] + tail


def speakable(text: str) -> str:
    """Macht aus Claudes Antwort Text, der sich gut vorlesen lässt:
    ohne Markdown, Links, Codeblöcke und Emojis."""
    text = _CODE_BLOCK.sub(" ", text)
    text = _MARKDOWN_LINK.sub(r"\1", text)
    text = _URL.sub(_url_host, text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _TABLE_RULE.sub("", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    if len(_NUMBERED.findall(text)) >= 2:
        text = _NUMBERED.sub("", text)
    # Rechnen: "3 * 4 = 12" wird "3 mal 4 gleich 12".
    text = re.sub(r"(\d)\s*[*×]\s*(?=\d)", r"\1 mal ", text)
    text = re.sub(r"(?<=[\d)])\s*=\s*(?=[\d(-])", " gleich ", text)
    text = _EMPHASIS.sub(r"\2", text)
    text = _EMOJI.sub("", text)
    text = text.replace("|", " ").replace("#", " ").replace("*", "")
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"\s+([,.!?;:])", r"\1", text).strip()


class SentenceSplitter:
    """Sammelt gestreamten Text und gibt ganze Sätze heraus, sobald sie fertig sind.
    So kann Jarvis den ersten Satz schon sprechen, während Claude weiterschreibt."""

    MIN_CHARS = 12

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, chunk: str) -> list[str]:
        self._buffer += chunk
        sentences = []
        while True:
            cut = self._find_end()
            if cut is None:
                break
            sentence, self._buffer = self._buffer[:cut].strip(), self._buffer[cut:]
            if sentence:
                sentences.append(sentence)
        return sentences

    def flush(self) -> list[str]:
        rest, self._buffer = self._buffer.strip(), ""
        return [rest] if rest else []

    def _find_end(self) -> int | None:
        buffer = self._buffer
        # Ein Absatz beendet immer den Satz.
        paragraph = buffer.find("\n\n")
        for match in re.finditer(r"[.!?…:;]+[\"'»“”)]*\s", buffer):
            end = match.end()
            if paragraph != -1 and paragraph < match.start():
                break
            if len(buffer[:end].strip()) < self.MIN_CHARS:
                continue
            if match.group().startswith(".") and self._is_abbreviation(buffer[: match.start()], buffer[end:end + 1]):
                continue
            if match.group().startswith(":") or match.group().startswith(";"):
                # Doppelpunkte nur trennen, wenn schon ein längeres Stück da ist.
                if len(buffer[:end].strip()) < 40:
                    continue
            return end
        if paragraph != -1 and paragraph >= 1:
            return paragraph + 2
        return None

    @staticmethod
    def _is_abbreviation(before: str, after: str = "") -> bool:
        word = re.search(r"(\w+)$", before)
        if not word:
            return False
        token = word.group(1)
        if token.isdigit():
            # "am 3. Oktober" ist kein Satzende, "im Jahr 2024." schon.
            return len(token) <= 2
        if len(token) == 1:
            # "z. B.", "u. a.", "d. h.", "i. d. R.", aber "Plan B." beendet den Satz.
            return token.islower() or bool(re.search(r"\b\w\.\s?\w$", before))
        if token.lower() == "so":
            # "am So. um 9" gegenüber "gut so. Soll ich"; ohne nächstes Zeichen noch warten.
            return not after or after.islower() or after.isdigit()
        return token.lower() in _ABBREVIATIONS
