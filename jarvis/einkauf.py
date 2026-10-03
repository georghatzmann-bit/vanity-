"""Die Einkaufsliste: "Mandelmus ist alle", "Setz Milch auf die Einkaufsliste", "Was steht auf der Einkaufsliste?",
"Mandelmus gekauft". Ohne Claude, sofort. Die Liste liegt im Gedächtnis (memory.Memory.shopping), Claude kennt sie
aus dem Kontext und ändert sie mit `python -m jarvis.tool einkauf`.

Über Telegram mit Standort sagt Jarvis außerdem, wo der nächste Supermarkt ist, und meldet sich unterwegs von
selbst, wenn Georg an einem vorbeikommt und etwas auf der Liste steht (telegram.py, naehe.py).
"""

from __future__ import annotations

import random
import re

_LIST = r"(?:die |meine |unsere |der |meiner |unserer )?einkaufs?liste"
_ART = re.compile(r"^(?:(?:der|die|das|den|dem|ein|eine|einen|etwas|noch|bitte|neue|neuen|neues|neuer|mehr|"
                  r"paar|ein paar|n|ne|nen|mein|meine|meinen|meiner|unser|unsere|unseren)\s+)+", re.I)

_ADD = [
    # "Setz Mandelmus auf die Einkaufsliste", "Schreib Milch und Eier auf meine Einkaufsliste", "Füg Brot zur Einkaufsliste hinzu"
    re.compile(rf"^(?:kannst du |könntest du )?(?:bitte )?(?:setz|setze|schreib|schreibe|pack|packe|tu|tue|nimm|füg|füge|"
               rf"trag|trage)\s+(?P<items>.+?)\s+(?:mit\s+)?(?:auf|zur|zu|in|ein in)\s+(?:{_LIST}|(?:die |meine )?liste)"
               rf"(?:\s+(?:hinzu|drauf|ein))?"
               rf"(?:\s+bitte)?$", re.I),
    # "Auf die Einkaufsliste: Milch", "Einkaufsliste: Milch und Eier"
    re.compile(rf"^(?:auf |zur )?{_LIST}\s*[:,-]\s*(?P<items>.+)$", re.I),
    # "Mandelmus ist alle", "Die Eier sind aufgebraucht", "Der Kaffee ist fast alle"
    re.compile(r"^(?:(?:oh|ach|übrigens|und)[, ]+)?(?P<items>.+?)\s+(?:ist|sind)\s+(?:fast\s+|schon\s+|gleich\s+)?"
               r"(?:alle|aufgebraucht|alle geworden)$", re.I),
    # "Wir haben keine Milch mehr", "Ich hab kein Mandelmus mehr"
    re.compile(r"^(?:wir haben|ich habe|ich hab|hab|haben wir|habe)\s+(?:kein|keine|keinen)\s+(?P<items>.+?)\s+mehr$", re.I),
]
_SHOW = [
    re.compile(rf"^(?:was (?:steht|ist|haben wir|habe ich|hab ich) (?:alles |gerade |noch )?(?:auf|in) {_LIST}|"
               rf"(?:zeig|zeige|lies|sag)(?: mir)? {_LIST}(?: vor)?|{_LIST}(?: zeigen| vorlesen)?)$", re.I),
    re.compile(r"^was (?:muss|soll|wollte) ich (?:noch |alles )?(?:einkaufen|kaufen|besorgen|holen|mitbringen)$", re.I),
]
_REMOVE = [
    # "Mandelmus gekauft", "Hab die Milch geholt", "Ich habe Eier und Brot gekauft"
    re.compile(r"^(?:ich )?(?:habe |hab )?(?P<items>.+?)\s+(?:gekauft|geholt|besorgt|eingekauft|mitgebracht)$", re.I),
    # "Streich Milch von der Einkaufsliste", "Nimm Brot von der Liste"
    re.compile(rf"^(?:streich|streiche|lösch|lösche|nimm|entfern|entferne|hak|hake)\s+(?P<items>.+?)\s+"
               rf"(?:von|aus|auf)\s+(?:der |meiner )?(?:einkaufs)?liste(?:\s+(?:runter|ab|weg))?$", re.I),
]
_CLEAR = re.compile(rf"^(?:{_LIST} (?:leeren|löschen|ist erledigt|zurücksetzen)|(?:leer|lösch|leere|lösche) {_LIST}|"
                    r"alles (?:gekauft|eingekauft|besorgt|erledigt)(?: von der (?:einkaufs)?liste)?)$", re.I)


def _clean(text: str) -> str:
    text = " ".join(str(text).split()).strip()
    text = re.sub(r"^(?:hey |hallo |ok |okay )?jarvis[, ]+", "", text, flags=re.I)
    text = re.sub(r"[,]?\s*jarvis$", "", text, flags=re.I)
    return text.strip(" .!?")


_COUNTS = {"zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "zwölf", "halbes", "halbe",
           "eine", "einen"}


def split_items(text: str) -> list[str]:
    """"Milch, Eier und zwei Avocados" -> ["Milch", "Eier", "zwei Avocados"]."""
    parts = re.split(r"\s*,\s*|\s+und\s+|\s+sowie\s+|\s*;\s*|\s+&\s+", str(text).strip(" .!?"))
    items = []
    for part in parts:
        part = _ART.sub("", part.strip()).strip(" .!?")
        if part and len(part) <= 60:
            first = part.split()[0].lower()
            items.append(part if first in _COUNTS or first[:1].isdigit() else part[:1].upper() + part[1:])
    return items


def match_einkauf(text: str) -> tuple[str, list[str]] | None:
    """("add", [..]) / ("remove", [..]) / ("show", []) / ("clear", []) / None (nicht für die Einkaufsliste)."""
    raw = _clean(text)
    if not raw or len(raw) > 160:
        return None
    for pattern in _SHOW:
        if pattern.match(raw):
            return "show", []
    if str(text).strip().endswith("?"):
        return None  # "Hast du Milch gekauft?" ist eine Frage, kein Abhaken
    if _CLEAR.match(raw):
        return "clear", []
    for pattern in _REMOVE:
        found = pattern.match(raw)
        if found:
            items = split_items(found.group("items"))
            if items:
                return "remove", items
    for pattern in _ADD:
        found = pattern.match(raw)
        if found:
            items = [i for i in split_items(found.group("items")) if not _NOT_AN_ITEM.match(i)]
            if items:
                return "add", items
    return None


# "Das ist alle" oder "Es ist alle" sagt nicht, was fehlt
_NOT_AN_ITEM = re.compile(r"^(?:das|es|alles|der|die|alle|sie|er|wir|ihr|nichts|zeit|geld|akku|batterie|nerven|"
                          r"kräfte|kraft|ideen|leute|kinder|gäste)$", re.I)


def join(items: list[str]) -> str:
    items = [i for i in items if i]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " und " + items[-1]


def answer(memory, action: str, items: list[str]) -> str | None:
    """Erledigt den Befehl. None = doch nichts für die Einkaufsliste (dann antwortet Claude)."""
    if action == "show":
        listed = memory.shopping()
        if not listed:
            return "Ihre Einkaufsliste ist leer, Sir."
        return f"Auf Ihrer Einkaufsliste, Sir: {join(listed)}."
    if action == "clear":
        memory.shop_clear()
        return random.choice(["Die Einkaufsliste ist leer, Sir.", "Erledigt, Sir. Die Einkaufsliste ist leer."])
    if action == "add":
        added = memory.shop_add(items)
        if not added:
            return f"{join(items)} steht schon auf der Liste, Sir."
        return random.choice([f"Steht auf der Einkaufsliste, Sir: {join(added)}.",
                              f"Notiert, Sir. {join(added)} kommt auf die Einkaufsliste."])
    if action == "remove":
        removed = memory.shop_remove(items)
        if not removed:
            return None  # "Ich habe ein neues Auto gekauft": Unterhaltung, nichts von der Liste
        left = memory.shopping()
        rest = f" Noch offen: {join(left)}." if left else " Die Liste ist jetzt leer."
        return f"Abgehakt, Sir: {join(removed)}.{rest}"
    return None
