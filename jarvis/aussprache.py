"""Aussprache: Text so umschreiben, dass ihn eine Stimme auf dem PC richtig vorliest.

Kleine Sprachmodelle (Pocket TTS, Piper) kennen keine Ziffern und Kürzel: Aus "25.231 Punkten" wird
Kauderwelsch, und manche hören an so einer Stelle mitten im Satz auf. Darum schreibt Jarvis vor dem Sprechen
aus, was ein Mensch sagen würde:
  "25.231"        -> fünfundzwanzigtausendzweihunderteinunddreißig
  "1,2 %"         -> eins Komma zwei Prozent
  "18:30 Uhr"     -> achtzehn Uhr dreißig
  "am 3.10."      -> am dritten Oktober
  "14 °C", "-5°"  -> vierzehn Grad, minus fünf Grad
  "85 GB", "9,99 €", "120 km/h", "2026" (als Jahr), "z. B.", "ca.", "S&P 500", "CS2", "USA"
Angezeigt wird weiter der Originaltext, umgeschrieben wird nur, was gesprochen wird. ElevenLabs kann das
selbst und bekommt den Text unverändert.
"""

from __future__ import annotations

import re

_ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf",
         "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"]
_TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"]
_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
           "November", "Dezember"]
_ORDINAL = {1: "erste", 3: "dritte", 7: "siebte", 8: "achte"}


def _below_100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    if not ones:
        return _TENS[tens]
    return ("ein" if ones == 1 else _ONES[ones]) + "und" + _TENS[tens]


def _below_1000(n: int, last_one: str) -> str:
    """1 bis 999 als ein Wort. last_one: "eins" am Ende (hunderteins), "ein" vor tausend (hunderteintausend)."""
    hundreds, rest = divmod(n, 100)
    out = ("" if hundreds == 1 else _ONES[hundreds]) + "hundert" if hundreds else ""
    if rest == 1:
        out += last_one
    elif rest:
        out += _below_100(rest)
    return out


def _below_million(n: int) -> str:
    thousands, rest = divmod(n, 1000)
    out = ("" if thousands == 1 else _below_1000(thousands, "ein")) + "tausend" if thousands else ""
    if rest:
        # 1100 -> tausendeinhundert (nicht "tausendhundert")
        out += ("ein" if thousands and 100 <= rest < 200 else "") + _below_1000(rest, "eins")
    return out


def number(n: int) -> str:
    """Eine ganze Zahl als Wort (deutsch, bis in die Milliarden): 21 -> einundzwanzig, 101 -> hunderteins,
    25231 -> fünfundzwanzigtausendzweihunderteinunddreißig."""
    if n < 0:
        return "minus " + number(-n)
    if n == 0:
        return "null"
    if n >= 10 ** 12:  # Kundennummern, Telefonnummern: Ziffer für Ziffer
        return " ".join(_ONES[int(d)] for d in str(n))
    parts = []
    for size, one, many in ((10 ** 9, "eine Milliarde", "Milliarden"), (10 ** 6, "eine Million", "Millionen")):
        count, n = divmod(n, size)
        if count:
            parts.append(one if count == 1 else f"{_below_million(count)} {many}")
    if n:
        parts.append(_below_million(n))
    return " ".join(parts)


def year(n: int) -> str:
    """Jahreszahlen wie man sie sagt: 1990 -> neunzehnhundertneunzig, 2026 -> zweitausendsechsundzwanzig."""
    if 1100 <= n < 2000:
        high, low = divmod(n, 100)
        return _below_100(high) + "hundert" + (_below_100(low) if low else "")
    return number(n)


def ordinal(n: int, ending: str = "e") -> str:
    """3 -> dritte(n), 20 -> zwanzigste(n)."""
    if n in _ORDINAL:
        word = _ORDINAL[n]
    elif n < 20:
        word = number(n) + "te"
    else:
        word = number(n) + "ste"
    return word[:-1] + ending if ending != "e" else word


def _digits_to_int(text: str) -> int:
    return int(text.replace(".", "").replace(" ", "").replace("'", ""))


def _decimal(whole: str, fraction: str) -> str:
    digits = " ".join(_ONES[int(d)] for d in fraction) if len(fraction) > 2 or fraction.startswith("0") else \
        number(int(fraction))
    return f"{number(_digits_to_int(whole))} Komma {digits}"


# Kürzel, die man als Wort spricht (der Rest wird buchstabiert: USA -> U S A)
_SPOKEN_AS_WORD = {"DAX", "NATO", "NASA", "UNO", "UNESCO", "UNICEF", "FIFA", "UEFA", "OPEC", "AIDS", "LED", "LAN", "WLAN",
                   "PIN", "TÜV", "ADAC", "BAföG", "ESA", "NAS", "RAM", "ROM", "GIF", "JPEG", "PDF", "SMS"}
_SPELL = {"PDF": "P D F", "SMS": "S M S", "LED": "L E D", "PUBG": "P U B G"}

_ABBREVIATIONS = [
    (r"\bz\.\s?B\.", "zum Beispiel"), (r"\bu\.\s?a\.", "unter anderem"), (r"\bd\.\s?h\.", "das heißt"),
    (r"\bbzw\.", "beziehungsweise"), (r"\bca\.", "circa"), (r"\busw\.", "und so weiter"), (r"\betc\.", "et cetera"),
    (r"\bNr\.", "Nummer"), (r"\bTel\.", "Telefon"), (r"\bDr\.", "Doktor"), (r"\bProf\.", "Professor"),
    (r"\bMio\.", "Millionen"), (r"\bMrd\.", "Milliarden"), (r"\bStd\.", "Stunden"), (r"\bMin\.", "Minuten"),
    (r"\bSek\.", "Sekunden"), (r"\binkl\.", "inklusive"), (r"\bexkl\.", "exklusive"), (r"\bevtl\.", "eventuell"),
    (r"\bggf\.", "gegebenenfalls"), (r"\bvs\.", "gegen"), (r"\bSt\.(?= [A-ZÄÖÜ])", "Sankt"), (r"\bStr\.", "Straße"),
    (r"\bo\.\s?ä\.", "oder ähnlich"), (r"\bs\.\s?o\.", "siehe oben"), (r"\bv\.\s?a\.", "vor allem"),
    (r"\bMo\.(?= )", "Montag"), (r"\bDi\.(?= )", "Dienstag"), (r"\bMi\.(?= )", "Mittwoch"), (r"\bDo\.(?= )", "Donnerstag"),
    (r"\bFr\.(?= )", "Freitag"), (r"\bSa\.(?= )", "Samstag"), (r"\bSo\.(?= )", "Sonntag"),
]
# Englische Wörter, die Georg oft hört: so geschrieben, wie man sie auf Deutsch ausspricht. Sonst liest die
# Stimme sie deutsch ("Mails" wie Mais, "Counter-Strike" wie Konterstriche).
_ENGLISH = {
    "E-Mails": "I-Mehls", "E-Mail": "I-Mehl", "Mails": "Mehls", "Mail": "Mehl", "Newsletter": "Njuhsletter",
    "Updates": "Apdäits", "Update": "Apdäit", "Downloads": "Daunlohds", "Download": "Daunlohd",
    "Counter-Strike": "Kaunter-Streik", "Steam": "Stiem", "Epic Games": "Eppik Gäims", "YouTube": "Juhtjuhb",
    "Google": "Guhgel", "Gaming": "Gäiming", "Online": "Onlein", "online": "onlein", "Browser": "Brauser",
    "Shopify": "Schoppifei", "Spotify": "Spottifei", "Playlist": "Pläilist", "Meeting": "Mieting",
    "iPhone": "Eifon", "Laptop": "Läptop", "Software": "Softwär", "Bluetooth": "Bluhtuhs", "WLAN": "Weh-Lahn",
    "Windows": "Windous", "Microsoft": "Maikrosoft", "Bitcoin": "Bitkeun", "Team": "Tiem",
}
_ENGLISH_RE = re.compile(r"(?<![\w-])(" + "|".join(sorted(map(re.escape, _ENGLISH), key=len, reverse=True)) + r")(?![\w-])")

_UNITS = [
    (r"km/h", "Kilometer pro Stunde"), (r"TB", "Terabyte"), (r"GB", "Gigabyte"), (r"MB", "Megabyte"), (r"KB", "Kilobyte"),
    (r"GHz", "Gigahertz"), (r"MHz", "Megahertz"), (r"Hz", "Hertz"), (r"km", "Kilometer"), (r"kg", "Kilo"),
    (r"cm", "Zentimeter"), (r"mm", "Millimeter"), (r"ms", "Millisekunden"), (r"kWh", "Kilowattstunden"), (r"W", "Watt"),
    (r"fps", "Bilder pro Sekunde"), (r"FPS", "Bilder pro Sekunde"), (r"Mbit/s", "Megabit pro Sekunde"),
    (r"€", "Euro"), (r"EUR", "Euro"), (r"\$", "Dollar"), (r"USD", "Dollar"), (r"%", "Prozent"),
]
_NUM = r"\d{1,3}(?:\.\d{3})+|\d+"


def speak(text: str) -> str:
    """Der Text so, wie ihn ein Mensch vorlesen würde (für die Stimmen auf dem PC)."""
    text = str(text or "")
    if not re.search(r"[\d&%€$°+/]|[A-ZÄÖÜ]{2}|\b[a-zA-Z]\.\s?[a-zA-Z]\.|\b(?:bzw|ca|usw|etc|Nr|Dr|inkl|evtl|ggf|vs)\.",
                     text) and not _ENGLISH_RE.search(text):
        return text
    for pattern, words in _ABBREVIATIONS:
        # "z. B." und am Satzanfang "Z. B.": groß bleibt groß
        text = re.sub(pattern, lambda m, w=words: w[:1].upper() + w[1:] if m.group(0)[:1].isupper() else w, text,
                      flags=re.IGNORECASE)
    text = _ENGLISH_RE.sub(lambda m: _ENGLISH[m.group(1)], text)
    text = re.sub(r"\bkm/h\b", "Kilometer pro Stunde", text)

    # Uhrzeit: 18:30 Uhr -> achtzehn Uhr dreißig, 7:05 -> sieben Uhr fünf, 18 Uhr -> achtzehn Uhr
    def clock(m: re.Match) -> str:
        hours, minutes = int(m.group(1)), int(m.group(2))
        if hours > 24 or minutes > 59:
            return m.group(0)
        spoken = f"{number(hours)} Uhr"
        return spoken + (f" {number(minutes)}" if minutes else "")

    text = re.sub(r"\b(\d{1,2}):(\d{2})(?:\s?Uhr)?\b", clock, text)

    # Datum: am 3.10.2026 -> am dritten Oktober zweitausendsechsundzwanzig, 24.12. -> vierundzwanzigster Dezember
    def date(m: re.Match) -> str:
        before, day, month, yr = m.group(1) or "", int(m.group(2)), int(m.group(3)), m.group(4)
        if not (1 <= day <= 31 and 1 <= month <= 12):
            return m.group(0)
        bound = bool(re.search(r"(?:\bam|\bvom|\bzum|\bbis|\bseit|\bab|\bdem|\bden)\s*$", before, re.I))
        spoken = f"{ordinal(day, 'en' if bound else 'er')} {_MONTHS[month - 1]}"
        if yr:
            number_year = int(yr) if len(yr) == 4 else 2000 + int(yr)
            spoken += f" {year(number_year)}"
        return before + spoken

    text = re.sub(r"((?:\b\w+\s)?)\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2}(?!\d))?(?!\d)", date, text)

    # Grad: 14 °C, -5°, 21,5 °C
    text = re.sub(r"((?<![\w,.])[-−])?(\d+(?:,\d+)?)\s?°(?:\s?C\b)?",
                  lambda m: ("minus " if m.group(1) else "") + _plain_number(m.group(2)) + " Grad", text)

    # Geld mit Cent: 9,99 € -> neun Euro neunundneunzig
    def money(m: re.Match) -> str:
        whole, cents = _digits_to_int(m.group(1)), int(m.group(2))
        spoken = f"{number(whole)} Euro"
        return spoken + (f" {number(cents)}" if cents else "")

    text = re.sub(rf"\b({_NUM}),(\d{{2}})\s?(?:€|EUR\b|Euro\b)", money, text)

    # Einheiten hinter Zahlen: 85 GB, 120 km/h, 1,2 %
    for unit, word in _UNITS:
        text = re.sub(rf"(?<=\d)\s?{unit}(?![A-Za-zÄÖÜäöü])", f" {word}", text)

    # Kürzel mit & und Zahlen: S&P 500 -> S und P fünfhundert, CS2 -> C S zwei
    text = re.sub(r"\b([A-Z])&([A-Z])\b", r"\1 und \2", text)
    text = re.sub(r"(?<=\w)\s?&\s?(?=\w)", " und ", text)
    text = re.sub(r"\b([A-ZÄÖÜ]{1,4})(\d{1,3})\b", lambda m: f"{_spell(m.group(1))} {number(int(m.group(2)))}", text)
    text = re.sub(r"\b[A-ZÄÖÜ]{2,5}\b", lambda m: _acronym(m.group(0)), text)

    # Von-bis und Schrägstrich zwischen Zahlen: "10-14" -> zehn bis vierzehn, "24/7" -> vierundzwanzig sieben
    text = re.sub(r"(?<![\d.,])(\d+)\s?[-–]\s?(\d+)(?![\d.,])", r"\1 bis \2", text)
    text = re.sub(r"(?<=\d)\s?/\s?(?=\d)", " ", text)

    # Jahreszahlen nach "im Jahr", "seit", "bis", "von" oder allein zwischen 1100 und 2099
    text = re.sub(r"\b(1[1-9]\d{2}|20\d{2})\b(?![.,]\d)", lambda m: year(int(m.group(1))), text)

    # Kommazahlen, große Zahlen mit Punkt, Minus, Plus
    text = re.sub(rf"(?<![\d.,])({_NUM}),(\d+)(?![\d.])", lambda m: _decimal(m.group(1), m.group(2)), text)
    text = re.sub(r"(?<![\d.,])(\d+)\.(\d{1,2})(?![\d.])", lambda m: _decimal(m.group(1), m.group(2)), text)  # 1.5 GB
    text = re.sub(r"(?<![\w.,])[-−](?=\d)", "minus ", text)
    text = re.sub(r"(?<=\d)\s?\+\s?(?=\d)", " plus ", text)
    text = re.sub(rf"(?<![\d.,])({_NUM})(?![\d,]|\.\d)", lambda m: number(_digits_to_int(m.group(1))), text)
    text = text.replace("und/oder", "und oder")
    text = re.sub(r"(?<=[A-Za-zÄÖÜäöüß])\s*/\s*(?=[A-Za-zÄÖÜäöüß])", " oder ", text)
    text = text.replace("/", " ")
    return re.sub(r"\s{2,}", " ", text).strip()


def _plain_number(text: str) -> str:
    if "," in text:
        whole, fraction = text.split(",", 1)
        return _decimal(whole, fraction)
    return number(_digits_to_int(text))


def _spell(letters: str) -> str:
    return " ".join(letters)


def _acronym(word: str) -> str:
    if word in _SPELL:
        return _SPELL[word]
    if word in _SPOKEN_AS_WORD:
        return word.capitalize() if word.isupper() else word
    if len(word) <= 3 or not re.search(r"[AEIOUÄÖÜ]", word[1:]):
        return _spell(word)
    return word.capitalize()
