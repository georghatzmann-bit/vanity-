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
