"""Ernährungs-Tagebuch im Notizbuch, in denselben Dateien wie beim Claude-Plugin Körper (claude-plugins/koerper):
Körper/ernaehrung.csv (eine Zeile je Lebensmittel) und Körper/Ernährung/<JJJJ-MM-TT>.md (der Tag zum Lesen).

Schickt Georg über Telegram ein Foto vom Essen, schätzt Jarvis' Gehirn Mengen und Nährwerte und trägt sie mit
`python -m jarvis.tool essen ...` ein. Ins Notizbuch schreibt bei Jarvis immer Python (wie bei notiz und bericht),
das Gehirn selbst darf dort nichts anlegen.
"""

from __future__ import annotations

import csv
import datetime as dt
import re
import threading
from pathlib import Path

FIELDS = ("datum", "uhrzeit", "mahlzeit", "lebensmittel", "menge_g", "kcal", "eiweiss_g", "kohlenhydrate_g", "fett_g",
          "quelle")
MEALS = ("Frühstück", "Mittagessen", "Snack", "Abendessen")
NUTRIENTS = (("kcal", "kcal"), ("eiweiss_g", "Eiweiß"), ("kohlenhydrate_g", "Kohlenhydrate"), ("fett_g", "Fett"))
CSV_NAME = "ernaehrung.csv"
DAY_FOLDER = "Ernährung"
START, END = "<!-- jarvis:anfang -->", "<!-- jarvis:ende -->"
_lock = threading.Lock()
_GOAL = re.compile(r"^\s*[-*]?\s*(kcal|eiweiss_g|kohlenhydrate_g|fett_g)\s*[:=]\s*(\d+(?:[.,]\d+)?)", re.I | re.M)


def folder_from_config(cfg: dict) -> Path:
    """Der Körper-Ordner im Notizbuch, wie ihn Jarvis auch dem Claude-Plugin gibt."""
    from .claude_plugins import FOLDERS
    from .notebook import folder_from_config as notebook

    return notebook(cfg) / FOLDERS["koerper"]


def meal_for(time: dt.time) -> str:
    """Wie im Plugin: bis 10:30 Frühstück, bis 14:30 Mittagessen, bis 17:30 Snack, danach Abendessen."""
    minutes = time.hour * 60 + time.minute
    for limit, meal in ((10 * 60 + 30, "Frühstück"), (14 * 60 + 30, "Mittagessen"), (17 * 60 + 30, "Snack")):
        if minutes <= limit:
            return meal
    return "Abendessen"


def _meal(text: str) -> str:
    word = str(text or "").strip().lower()
    for meal in MEALS:
        if word and (word == meal.lower() or meal.lower().startswith(word)):
            return meal
    return {"fruehstueck": "Frühstück", "mittag": "Mittagessen", "abend": "Abendessen", "zwischenmahlzeit": "Snack"
            }.get(word, "")


def number(value) -> float:
    """"300", "300 g", "15,9" -> Zahl. Unsinn (negativ, riesig, kein Wert) gibt ValueError."""
    text = re.sub(r"\s*(?:g|kcal|ml)\s*$", "", str(value).strip(), flags=re.I).replace(",", ".")
    result = float(text)
    if not 0 <= result <= 20000:
        raise ValueError(f"unmögliche Menge: {value}")
    return result


def _plain(value: float, digits: int = 1) -> str:
    """Für die CSV: Punkt als Dezimalzeichen, ganze Zahlen ohne Nachkommastelle."""
    rounded = round(value, digits)
    return str(int(rounded)) if rounded == int(rounded) else f"{rounded:.{digits}f}"


def german(value: float, digits: int = 1) -> str:
    return _plain(value, digits).replace(".", ",")


def add(folder: Path, food: str, grams, kcal, protein, carbs, fat, meal: str = "", source: str = "",
        now: dt.datetime | None = None) -> dict:
    """Ein Lebensmittel eintragen. {"zeile", "tag" (Summen), "ziele"}."""
    now = now or dt.datetime.now()
    food = " ".join(str(food or "").split()).strip(" ,;")[:80]
    if not food:
        raise ValueError("Welches Lebensmittel?")
    grams, kcal, protein, carbs, fat = (number(v) for v in (grams, kcal, protein, carbs, fat))
    row = {"datum": now.date().isoformat(), "uhrzeit": now.strftime("%H:%M"),
           "mahlzeit": _meal(meal) or meal_for(now.time()), "lebensmittel": food, "menge_g": _plain(grams, 0),
           "kcal": str(round(kcal)), "eiweiss_g": _plain(protein), "kohlenhydrate_g": _plain(carbs),
           "fett_g": _plain(fat), "quelle": " ".join(str(source or "").split())[:30] or "Schätzung"}
    folder = Path(folder)
    with _lock:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / CSV_NAME
        fresh = not path.exists() or path.stat().st_size == 0
        if not fresh:
            with path.open("rb") as existing:
                existing.seek(-1, 2)
                glue = existing.read(1) not in (b"\n", b"\r")  # von Hand geschrieben, ohne Zeilenende am Schluss
        with path.open("a", encoding="utf-8", newline="") as out:
            if not fresh and glue:
                out.write("\r\n")
            writer = csv.DictWriter(out, fieldnames=FIELDS)
            if fresh:
                writer.writeheader()
            writer.writerow(row)
        rows = day_rows(folder, now.date())
        write_day(folder, now.date(), rows)
    return {"zeile": row, "tag": totals(rows), "ziele": goals(folder)}


def day_rows(folder: Path, day: dt.date) -> list[dict]:
    path = Path(folder) / CSV_NAME
    try:
        with path.open(encoding="utf-8-sig", newline="") as source:
            return [row for row in csv.DictReader(source) if (row.get("datum") or "").strip() == day.isoformat()]
    except (OSError, csv.Error, UnicodeDecodeError):
        return []


def totals(rows: list[dict]) -> dict:
    out = {key: 0.0 for key, _ in NUTRIENTS}
    for row in rows:
        for key in out:
            try:
                out[key] += number(row.get(key) or 0)
            except ValueError:
                pass
    return out


def goals(folder: Path) -> dict:
    """Tagesziele aus Ziele.md ("kcal: 2400", "eiweiss_g: 160"), wie das Plugin sie anlegt."""
    try:
        text = (Path(folder) / "Ziele.md").read_text(encoding="utf-8-sig")
    except OSError:
        return {}
    return {key.lower(): float(value.replace(",", ".")) for key, value in _GOAL.findall(text)}


def write_day(folder: Path, day: dt.date, rows: list[dict]) -> Path:
    """Die Tagesdatei aus der CSV neu schreiben. Was Georg außerhalb des Jarvis-Teils ergänzt hat, bleibt."""
    lines = [f"# Ernährung {day.isoformat()}", "",
             "| Uhrzeit | Mahlzeit | Lebensmittel | Menge | kcal | Eiweiß | KH | Fett |", "|---|---|---|---|---|---|---|---|"]
    for row in rows:
        cells = [row.get("uhrzeit", ""), row.get("mahlzeit", ""), row.get("lebensmittel", "")]
        try:
            cells += [f"{german(number(row.get('menge_g') or 0), 0)} g", german(number(row.get("kcal") or 0), 0)]
            cells += [f"{german(number(row.get(key) or 0))} g" for key in ("eiweiss_g", "kohlenhydrate_g", "fett_g")]
        except ValueError:
            continue
        lines.append("| " + " | ".join(str(c).replace("|", "/").strip() for c in cells) + " |")
    total = totals(rows)
    lines += ["", f"**Summe:** {german(total['kcal'], 0)} kcal · {german(total['eiweiss_g'])} g Eiweiß · "
                  f"{german(total['kohlenhydrate_g'])} g Kohlenhydrate · {german(total['fett_g'])} g Fett"]
    block = START + "\n" + "\n".join(lines) + "\n" + END
    path = Path(folder) / DAY_FOLDER / f"{day.isoformat()}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        old = path.read_text(encoding="utf-8")
    except OSError:
        old = ""
    if START in old and END in old and old.index(START) < old.index(END):
        text = old[:old.index(START)] + block + old[old.index(END) + len(END):]
    else:
        text = block + "\n"  # neu, oder die Tabelle vom Plugin: dieselben Zeilen stehen ja in der CSV
    path.write_text(text, encoding="utf-8")
    return path


def describe(result: dict) -> str:
    """Für das Gehirn: was eingetragen ist und wo der Tag steht."""
    row, day, wanted = result["zeile"], result["tag"], result.get("ziele") or {}
    said = (f"Eingetragen: {row['lebensmittel']}, {german(number(row['menge_g']), 0)} g, {row['kcal']} kcal "
            f"({row['mahlzeit']}).")
    return said + " " + day_text(day, wanted)


def day_text(day: dict, wanted: dict | None = None) -> str:
    wanted = wanted or {}
    parts = []
    for key, name in NUTRIENTS:
        unit = " kcal" if key == "kcal" else " g " + name
        value = german(day.get(key, 0.0), 0 if key == "kcal" else 1)
        if key in wanted:
            parts.append(f"{value} von {german(wanted[key], 0)}{unit}")
        else:
            parts.append(f"{value}{unit}")
    return "Heute bisher: " + ", ".join(parts) + "." + ("" if wanted else " Noch keine Ziele (Ziele.md).")
