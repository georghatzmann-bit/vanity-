"""Text für die Sprachausgabe vorbereiten und in Sätze zerlegen."""

from __future__ import annotations

import re

# Nach diesen Wörtern ist ein Punkt kein Satzende ("z. B.", "Dr.", "Nr. 5").
_ABBREVIATIONS = {
    "z", "b", "bzw", "ca", "dr", "nr", "usw", "etc", "evtl", "ggf", "inkl", "st",
    "str", "u", "a", "d", "h", "vgl", "min", "max", "mio", "mrd", "prof", "hr", "fr",
    "ggü", "sog", "zzgl", "abs", "bspw", "tel", "jan", "feb", "mär", "apr", "jun",
    "jul", "aug", "sep", "sept", "okt", "nov", "dez", "mo", "di", "mi", "do", "sa", "so",
}

_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+|www\.\S+")
_CODE_BLOCK = re.compile(r"```.*?```", re.S)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_LIST_MARKER = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+", re.M)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.M)
_EMPHASIS = re.compile(r"(\*\*|\*)(\S(?:.*?\S)?)\1")
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF]")


def speakable(text: str) -> str:
    """Macht aus Claudes Antwort Text, der sich gut vorlesen lässt:
    ohne Markdown, Links, Codeblöcke und Emojis."""
    text = _CODE_BLOCK.sub(" ", text)
    text = _MARKDOWN_LINK.sub(r"\1", text)
    text = _URL.sub("", text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _HEADING.sub("", text)
    text = _LIST_MARKER.sub("", text)
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
            if match.group().startswith(".") and self._is_abbreviation(buffer[: match.start()]):
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
    def _is_abbreviation(before: str) -> bool:
        word = re.search(r"(\w+)$", before)
        if not word:
            return False
        token = word.group(1)
        # "3." oder "1." in "am 3. Oktober" ist kein Satzende.
        return token.isdigit() or token.lower() in _ABBREVIATIONS
