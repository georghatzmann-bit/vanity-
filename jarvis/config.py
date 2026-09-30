"""Lädt config.example.toml als Standardwerte und legt config.toml darüber."""

from __future__ import annotations

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
                lines[i] = new_line
                break
        else:
            lines.insert(start + 1, new_line)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
