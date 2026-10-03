"""Claude-Verbrauch wie im Video ("Claude · Weekly Usage"): wie viel vom Kontingent schon weg ist.

Claude Code meldet das selbst. Bei jeder Antwort schickt der Claude-Server mit, wie ausgelastet das Fünf-Stunden-
und das Wochenfenster sind, und Claude Code gibt es im stream-json als `rate_limit_event` weiter (mit echtem
Claude Code nachgeprüft). Jarvis' Gehirn liest es mit (brain._StreamReader), hier wird es gespeichert, fürs
Fenster aufbereitet und auf "Wie viel Claude habe ich noch?" sofort beantwortet, ohne Claude zu fragen.

Werte sind Anteile (0,34 = 34 Prozent), Zeiten Unix-Sekunden.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

FILE = "claude-verbrauch.json"
WINDOWS = (("woche", "seven_day"), ("fuenf_stunden", "five_hour"))
HISTORY = 240  # so viele Wochenwerte für den Verlauf (Sparkline), etwa eine Woche reger Nutzung
SPARING = 0.9  # ab hier wählt Jarvis lieber ein sparsameres Modell
WEEKDAYS = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")

_lock = threading.Lock()
_cache: dict[str, dict] = {}
listeners: list = []  # werden mit dem neuen Stand aufgerufen (das Fenster)
DIR: Path | None = None  # anderer Ordner als daten/ (die Tests nehmen einen eigenen)


def _path(state_dir: Path | None = None) -> Path:
    if state_dir is None:
        from .config import STATE_DIR

        state_dir = DIR or STATE_DIR
    return Path(state_dir) / FILE


def load(state_dir: Path | None = None) -> dict:
    path = _path(state_dir)
    with _lock:
        if str(path) in _cache:
            return dict(_cache[str(path)])
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data = data if isinstance(data, dict) else {}
        _cache[str(path)] = data
        return dict(data)


def _fraction(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(number, 1.5)) if number == number else None  # NaN raus


def _seconds(value) -> int | None:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def note(info, state_dir: Path | None = None, now: float | None = None) -> dict | None:
    """Ein rate_limit_info aus Claude Code übernehmen. Unbrauchbares bleibt draußen."""
    if not isinstance(info, dict):
        return None
    now = time.time() if now is None else now
    windows = info.get("unifiedWindows") if isinstance(info.get("unifiedWindows"), dict) else {}
    if not windows and not info.get("status") and info.get("utilization") is None:
        return None  # nichts über das Kontingent darin: den alten Stand nicht anfassen
    old = load(state_dir)
    data = {"stand": int(now), "status": str(info.get("status") or ""), "art": str(info.get("rateLimitType") or ""),
            "endet": _seconds(info.get("resetsAt")), "extra": bool(info.get("isUsingOverage"))}
    for ours, theirs in WINDOWS:
        window = windows.get(theirs) if isinstance(windows.get(theirs), dict) else {}
        share = _fraction(window.get("utilization"))
        if share is None and data["art"] == theirs:
            share = _fraction(info.get("utilization"))
        if share is None:
            share = (old.get(ours) or {}).get("anteil")  # nicht mitgeschickt: den letzten Stand behalten
        if share is not None:
            data[ours] = {"anteil": round(share, 4), "endet": _seconds(window.get("resetsAt"))
                          or (old.get(ours) or {}).get("endet")}
    if "woche" not in data and "fuenf_stunden" not in data and not data["status"]:
        return None
    history = [p for p in old.get("verlauf") or [] if isinstance(p, list) and len(p) == 2]
    week = (data.get("woche") or {}).get("anteil")
    if week is not None and (not history or abs(history[-1][1] - week) >= 0.001):
        history.append([int(now), week])
    data["verlauf"] = history[-HISTORY:]
    path = _path(state_dir)
    with _lock:
        _cache[str(path)] = data
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            log.debug("Claude-Verbrauch: %s", exc)
    for listener in list(listeners):
        try:
            listener(view(data, now))
        except Exception as exc:
            log.debug("Claude-Verbrauch, Anzeige: %s", exc)
    return data


def share(data: dict, window: str = "woche", now: float | None = None) -> float | None:
    """Anteil eines Fensters. Ist es schon zurückgesetzt, steht es bei null (bis Claude Code Neues meldet)."""
    now = time.time() if now is None else now
    part = data.get(window) if isinstance(data.get(window), dict) else None
    if not part or part.get("anteil") is None:
        return None
    if part.get("endet") and part["endet"] <= now:
        return 0.0
    return float(part["anteil"])


def sparing(data: dict | None = None, now: float | None = None) -> bool:
    """Wird das Kontingent knapp (Woche ab 90 Prozent, oder Claude warnt)? Dann lieber ein sparsameres Modell."""
    data = load() if data is None else data
    week = share(data, "woche", now)
    return bool((week is not None and week >= SPARING) or data.get("status") == "allowed_warning")


def when(stamp: int | None, now: float | None = None) -> str:
    """Zurücksetzen gesprochen: "um 18 Uhr", "morgen um 7:30", "Donnerstag um 16 Uhr"."""
    if not stamp:
        return ""
    moment = dt.datetime.fromtimestamp(stamp)
    today = dt.datetime.fromtimestamp(time.time() if now is None else now).date()
    clock = f"{moment.hour} Uhr" if moment.minute == 0 else f"{moment.hour}:{moment.minute:02d}"
    days = (moment.date() - today).days
    if days <= 0:
        return f"um {clock}"
    if days == 1:
        return f"morgen um {clock}"
    if days < 7:
        return f"{WEEKDAYS[moment.weekday()]} um {clock}"
    return f"am {moment.day}.{moment.month}. um {clock}"


def view(data: dict | None = None, now: float | None = None) -> dict:
    """Fürs Fenster: Prozente, Zurücksetzen, Verlauf, Zustand."""
    data = load() if data is None else data
    now = time.time() if now is None else now
    week, five = share(data, "woche", now), share(data, "fuenf_stunden", now)
    return {"da": week is not None or five is not None,
            "woche": None if week is None else round(week * 100),
            "fuenf_stunden": None if five is None else round(five * 100),
            "woche_endet": when((data.get("woche") or {}).get("endet"), now),
            "fuenf_endet": when((data.get("fuenf_stunden") or {}).get("endet"), now),
            "status": data.get("status") or "", "knapp": sparing(data, now), "extra": bool(data.get("extra")),
            "verlauf": [round(p[1] * 100, 1) for p in data.get("verlauf") or []][-60:],
            "stand": data.get("stand") or 0}


def describe(data: dict | None = None, now: float | None = None) -> str:
    """Die Antwort auf "Wie viel Claude habe ich noch?" (mit "Sir", das ersetzt anrede.py)."""
    shown = view(data, now)
    if not shown["da"]:
        return ("Dazu habe ich noch keine Zahl, Sir. Claude meldet den Verbrauch bei der nächsten Frage, die ich an "
                "Claude gebe.")
    if shown["status"] == "rejected":
        back = shown["woche_endet"] if (shown["woche"] or 0) >= 100 else shown["fuenf_endet"]
        return "Das Claude-Kontingent ist gerade aufgebraucht, Sir." + (f" Es geht {back} weiter." if back else "")
    parts = []
    if shown["woche"] is not None:
        parts.append(f"Diese Woche sind {shown['woche']} Prozent Ihres Claude-Kontingents verbraucht, Sir"
                     + (f". Es setzt sich {shown['woche_endet']} zurück." if shown["woche_endet"] else "."))
    if shown["fuenf_stunden"] is not None:
        parts.append(f"Im Fünf-Stunden-Fenster sind es {shown['fuenf_stunden']} Prozent"
                     + (f", wieder frei {shown['fuenf_endet']}." if shown["fuenf_endet"] else "."))
    if shown["knapp"]:
        parts.append("Das wird knapp, deshalb nehme ich für schwere Aufgaben vorerst das sparsamere Modell.")
    return " ".join(parts)


_ABOUT = re.compile(r"\b(?:claude|kontingent|limit|abo|nutzung|verbrauch)", re.I)
_LEFT = re.compile(r"\b(?:noch|übrig|uebrig|verbraucht|verbrauch|frei|offen|prozent|kontingent|limit|nutzung|weg)\b", re.I)
_STRONG = re.compile(r"\b(?:übrig|uebrig|verbraucht|verbrauch|prozent|kontingent|limit|nutzung)\b", re.I)
_HOW_MUCH = re.compile(r"^(?:sag mal |sag mir )?(?:wie ?viel|wieviel|was)\b", re.I)
_HOW_IS = re.compile(r"^wie (?:ist|steht) (?:mein|es um mein|das|der|die)(?: claude)?[- ]?(?:claude[- ]?)?"
                     r"(?:kontingent|limit|verbrauch|nutzung)\b", re.I)
_BARE = re.compile(r"^(?:claude[- ]?)?(?:verbrauch|kontingent|nutzung)(?: diese woche)?$", re.I)
_NOT = re.compile(r"\b(?:strom|wasser|gas|speicher|ram|arbeitsspeicher|cpu|prozessor|akku|daten ?volumen|kostet|kosten|"
                  r"preis|netflix|spotify)\b", re.I)


def is_question(text: str) -> bool:
    """"Wie viel Claude habe ich noch?", "Wie viel Kontingent ist übrig?", "Wie steht mein Claude-Verbrauch?"."""
    raw = " ".join(str(text or "").split()).strip(" .!")
    raw = re.sub(r"^(?:hey |hallo |ok |okay )?jarvis[, ]+", "", raw, flags=re.I)
    raw = raw.rstrip("?").strip()
    if not raw or len(raw) > 120 or _NOT.search(raw):
        return False
    if _HOW_IS.match(raw) or _BARE.match(raw):
        return True
    if not (_HOW_MUCH.match(raw) and _ABOUT.search(raw)):
        return False
    # "Was hat Claude noch gesagt?" ist keine Frage nach dem Verbrauch: bei "was" zählen nur die starken Wörter
    words = _STRONG if raw.lower().startswith(("was", "sag mal was", "sag mir was")) else _LEFT
    return bool(words.search(raw))
