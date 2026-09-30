"""Lädt config.example.toml als Standardwerte und legt config.toml darüber."""

from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_PATH = ROOT / "config.example.toml"
CONFIG_PATH = ROOT / "config.toml"
HOME_DIR = ROOT / "jarvis_home"


def _merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: Path | None = None) -> dict:
    with EXAMPLE_PATH.open("rb") as f:
        config = tomllib.load(f)
    user_path = path or CONFIG_PATH
    if user_path.exists():
        with user_path.open("rb") as f:
            config = _merge(config, tomllib.load(f))
    return config


def save_setting(section: str, key: str, value: str, path: Path | None = None) -> None:
    """Schreibt einen Text-Wert in config.toml und lässt Kommentare und den Rest stehen."""
    path = path or CONFIG_PATH
    if not path.exists():
        path.write_text(EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    new_line = f'{key} = "{escaped}"'
    lines = path.read_text(encoding="utf-8").splitlines()

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
