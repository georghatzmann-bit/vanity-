"""Lädt config.example.toml als Standardwerte und legt config.toml darüber."""

from __future__ import annotations

import re
import threading
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_PATH = ROOT / "config.example.toml"
CONFIG_PATH = ROOT / "config.toml"
HOME_DIR = ROOT / "jarvis_home"
# Was Jarvis sich merkt (Erinnerungen, welches Modell zuletzt ging) und die Logdateien.
STATE_DIR = ROOT / "daten"
LOG_DIR = ROOT / "logs"


def _merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


# Diese Listen werden mit den Vorgaben zusammengelegt statt ersetzt. So bekommt eine
# alte config.toml neue Sperren (z. B. für Installieren) automatisch dazu.
_UNION_LISTS = (("brain", "disallowed_tools"), ("brain", "allowed_tools"))


def _read_toml(path: Path) -> dict:
    # utf-8-sig: Der Windows-Editor speichert manchmal mit BOM, das mag tomllib nicht.
    text = path.read_text(encoding="utf-8-sig")
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        hint = ""
        if "escape" in str(exc).lower() or "\\" in text:
            hint = (
                " Windows-Pfade bitte in einfache Anführungszeichen setzen, "
                "zum Beispiel claude_path = 'C:\\Users\\Georg\\claude.exe'."
            )
        raise ValueError(f"{path.name}: {exc}.{hint}") from exc


# Vorgaben, die sich geändert haben. Steht in einer älteren config.toml noch die alte
# Vorgabe, bekommt sie einmalig die neue. Was du danach selbst einträgst, bleibt.
CONFIG_VERSION = 8
_UPGRADES = {
    2: [("listen", "silence_seconds", 1.2, 0.9)],
    # Conrad klingt mit etwas langsamerem Tempo und tieferer Stimme natürlicher (gemessen).
    3: [("tts", "rate", "+5%", "-5%"), ("tts", "pitch", "-4Hz", "-8Hz")],
    # Jarvis 2: Satzende per Sprach-KI erkannt (schneller), läuft im Hintergrund weiter,
    # wenn das Fenster zugeht, und das größere Fenster.
    4: [
        ("listen", "silence_seconds", 0.9, 0.7),
        ("gui", "close_to_tray", False, True),
        ("gui", "width", 1200, 1280),
        ("gui", "height", 780, 800),
    ],
    # 0,7 s Stille schnitt Sätze bei kurzen Denkpausen ab, 20 s waren für lange Aufträge zu kurz.
    # Längere Sätze bekommen jetzt von selbst mehr Zeit (audio.CommandRecorder.needed_silence).
    5: [
        ("listen", "silence_seconds", 0.7, 0.9),
        ("listen", "max_seconds", 20, 60),
    ],
    # Die Werkstatt wählt selbst: Opus für große Aufträge, Sonnet für kleine.
    6: [("werkstatt", "modell", "sonnet", "auto")],
    # Georg: "Voice komplett lokal, keine Windows-Stimme". Stimme und Erkennung laufen auf dem PC
    # (die Schlüssel für ElevenLabs und Groq bleiben gespeichert, in der Einrichtung wieder wählbar).
    7: [
        ("tts", "engine", "edge", "lokal"),
        ("tts", "engine", "windows", "lokal"),
        ("tts", "engine", "elevenlabs", "lokal"),
        ("stt", "engine", "auto", "lokal"),
        ("stt", "engine", "groq", "lokal"),
        ("stt", "engine", "cloud", "lokal"),
    ],
}
# Einträge, die aus Listen in einer älteren config.toml verschwinden (Version, Abschnitt, Schlüssel, Einträge).
# Jarvis 2 darf Programme ohne Nachfrage installieren.
_LIST_REMOVALS = {
    4: [("brain", "disallowed_tools", ("Bash(winget install:*)", "PowerShell(winget install:*)"))],
}
# Einträge, die in Listen einer älteren config.toml dazukommen (die Liste ist sonst fest, nicht zusammengelegt).
# 8: Jarvis darf Teilaufgaben an seine Spezialisten abgeben (Werkzeug Agent, helfer.py).
_LIST_ADDITIONS = {
    8: [("brain", "tools", ("Agent",))],
}


def upgrade_config(path: Path | None = None) -> list[str]:
    """Passt eine config.toml von einer älteren Jarvis-Version an. Gibt die geänderten Werte zurück."""
    path = path or CONFIG_PATH
    if not path.exists():
        return []
    data = _read_toml(path)
    try:
        version = int((data.get("intern") or {}).get("config_version", 1))
    except (TypeError, ValueError):
        version = 1
    if version >= CONFIG_VERSION:
        return []
    changed: dict[str, str] = {}
    before: dict[str, object] = {}
    for target in range(version + 1, CONFIG_VERSION + 1):
        for section, key, old, new in _UPGRADES.get(target, []):
            current = (data.get(section) or {}).get(key)
            if current == old and type(current) is type(old):
                save_setting(section, key, new, path)
                data.setdefault(section, {})[key] = new  # spätere Stufen bauen darauf auf
                before.setdefault(f"{section}.{key}", current)
                if new == before[f"{section}.{key}"]:
                    changed.pop(f"{section}.{key}", None)  # über Umwege wieder beim alten Wert
                else:
                    changed[f"{section}.{key}"] = f"{section}.{key} = {new}"
        for section, key, items in _LIST_ADDITIONS.get(target, []):
            current = (data.get(section) or {}).get(key)
            if isinstance(current, list) and current and any(item not in current for item in items):
                grown = current + [item for item in items if item not in current]
                save_setting(section, key, grown, path)
                data[section][key] = grown
                changed[f"{section}.{key}"] = f"{section}.{key}: mit {', '.join(items)}"
        for section, key, items in _LIST_REMOVALS.get(target, []):
            current = (data.get(section) or {}).get(key)
            if isinstance(current, list) and any(item in current for item in items):
                kept = [item for item in current if item not in items]
                save_setting(section, key, kept, path)
                data[section][key] = kept
                changed[f"{section}.{key}"] = f"{section}.{key}: ohne {', '.join(items)}"
    save_setting("intern", "config_version", CONFIG_VERSION, path)
    return list(changed.values())  # pro Einstellung nur der neue Endwert


def load_config(path: Path | None = None) -> dict:
    defaults = _read_toml(EXAMPLE_PATH)
    config = defaults
    user_path = path or CONFIG_PATH
    if user_path.exists():
        config = _merge(defaults, _read_toml(user_path))
        for section, key in _UNION_LISTS:
            base = defaults.get(section, {}).get(key) or []
            mine = (config.get(section) or {}).get(key)
            if isinstance(mine, list):
                config[section][key] = list(dict.fromkeys([*base, *mine]))
    return config


def toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, (int, float)):
        return repr(value)
    text = str(value)
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    escaped = "".join(c if ord(c) >= 32 else f"\\u{ord(c):04x}" for c in escaped)
    return f'"{escaped}"'


def save_setting(section: str, key: str, value, path: Path | None = None) -> None:
    """Schreibt einen Wert (Text, Zahl, Ja/Nein) in config.toml und lässt Kommentare
    und den Rest stehen."""
    path = path or CONFIG_PATH
    with _SAVE_LOCK:  # Fenster, Einrichtung, Stimme und Hinweise speichern aus verschiedenen Threads
        _save_setting(path, section, key, value)


_SAVE_LOCK = threading.Lock()


def _save_setting(path: Path, section: str, key: str, value) -> None:
    if not path.exists():
        path.write_text(EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    new_line = f"{key} = {toml_value(value)}"
    lines = path.read_text(encoding="utf-8-sig").splitlines()

    header = f"[{section}]"
    start = next((i for i, line in enumerate(lines) if line.strip() == header), None)
    if start is None:
        lines += ["", header, new_line]
    else:
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")),
            len(lines),
        )
        for i in range(start + 1, end):
            if lines[i].split("=", 1)[0].strip() == key and not lines[i].lstrip().startswith("#"):
                # Eine Liste kann über mehrere Zeilen gehen: alle ersetzen.
                last = _value_end(lines, i)
                lines[i:last + 1] = [new_line]
                break
        else:
            lines.insert(start + 1, new_line)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _value_end(lines: list[str], first: int) -> int:
    """Die letzte Zeile des Werts, der in Zeile `first` beginnt (bei mehrzeiligen Listen)."""
    depth = 0
    quote = ""
    for i in range(first, len(lines)):
        line = lines[i] if i > first else lines[i].split("=", 1)[1]
        for ch in line:
            if quote:
                if ch == quote:
                    quote = ""
            elif ch in "\"'":
                quote = ch
            elif ch == "#":
                break
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
        quote = ""
        if depth <= 0:
            return i
    return first


def user_name(cfg: dict | None = None) -> str:
    """Wie der Nutzer heißt ([ich] name). Ohne Angabe "Georg": für ihn ist Jarvis gebaut."""
    name = str((((cfg or {}).get("ich") or {}).get("name")) or "").strip()
    return name if re.fullmatch(r"[A-Za-zÄÖÜäöüßéèáàÉÈ][\w\-ÄÖÜäöüßéèáà]{0,29}", name) else "Georg"
