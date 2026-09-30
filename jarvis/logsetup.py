"""Logdatei (logs/jarvis.log) und saubere Konsolenausgabe."""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import warnings
from pathlib import Path

NOISY = ("httpx", "httpcore", "huggingface_hub", "urllib3", "filelock", "faster_whisper", "websockets", "asyncio", "PIL", "pywebview")


def setup_logging(log_dir: Path, verbose: bool = False) -> Path:
    """Alles ab DEBUG in die Logdatei, in die Konsole nur Warnungen (mit -v alles)."""
    log_file = log_dir / "jarvis.log"
    _ensure_streams(log_dir)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8", delay=True
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
        )
        root.addHandler(file_handler)
    except OSError as exc:
        print(f"Logdatei {log_file} kann nicht angelegt werden: {exc}")

    if sys.stderr is not None:
        console = logging.StreamHandler(sys.stderr)
        console.setLevel(logging.DEBUG if verbose else logging.WARNING)
        console.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        root.addHandler(console)

    for name in NOISY:
        logging.getLogger(name).setLevel(logging.DEBUG if verbose else logging.WARNING)
    if not verbose:
        warnings.filterwarnings("ignore", message=".*unauthenticated requests.*")
        warnings.filterwarnings("ignore", category=UserWarning, module="onnxruntime")
        # Weniger Download-Balken und Hinweise von Hugging Face.
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    return log_file


def _ensure_streams(log_dir: Path) -> None:
    """Ohne Konsole (pythonw, Autostart) sind stdout/stderr None. Manche Bibliotheken
    schreiben trotzdem hinein, deshalb leiten wir sie in eine Datei um."""
    if sys.stdout is not None and sys.stderr is not None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                try:
                    stream.reconfigure(encoding="utf-8", errors="replace")
                except (ValueError, OSError):
                    pass
        return
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        sink = open(log_dir / "konsole.log", "a", encoding="utf-8", buffering=1)
    except OSError:
        sink = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink
