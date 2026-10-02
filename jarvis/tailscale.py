"""Sicher von überall: Tailscale (kostenlos) verbindet PC und Handy wie in einem privaten Netz und
gibt dem PC eine eigene HTTPS-Adresse (z. B. https://georgs-pc.tail1234.ts.net).

Über HTTPS darf die Handy-App mehr als im WLAN über http: das Mikrofon direkt nutzen (Sprechtaste)
und sich als richtige App installieren. Jarvis richtet dafür "tailscale serve" ein: Die HTTPS-Adresse
leitet auf den Web-Eingang von Jarvis auf diesem PC. Nur Geräte in Georgs Tailscale-Netz kommen hin,
und ohne den geheimen Schlüssel aus dem QR-Code geht trotzdem nichts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
ENABLE_HINT = re.compile(r"https://login\.tailscale\.com/\S+")


def find() -> str:
    """Pfad zu tailscale(.exe) oder ""."""
    found = shutil.which("tailscale")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", "")):
        if base:
            path = Path(base) / "Tailscale" / "tailscale.exe"
            if path.exists():
                return str(path)
    return ""


def _run(exe: str, *args: str, timeout: float = 20) -> tuple[int, str]:
    try:
        done = subprocess.run([exe, *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


def status(exe: str | None = None) -> dict:
    """{"installed", "running" (angemeldet und verbunden), "name" (z. B. georgs-pc.tail1234.ts.net), "error"}"""
    exe = exe if exe is not None else find()
    if not exe:
        return {"installed": False, "running": False, "name": "", "error": ""}
    code, out = _run(exe, "status", "--json")
    try:
        data = json.loads(out[out.index("{"):]) if "{" in out else {}
    except ValueError:
        data = {}
    me = data.get("Self") or {}
    name = str(me.get("DNSName") or "").rstrip(".")
    running = data.get("BackendState") == "Running" and bool(name)
    error = "" if running else ("Bitte einmal in Tailscale anmelden (Symbol unten rechts neben der Uhr)."
                                if data.get("BackendState") in ("NeedsLogin", "NoState", "Stopped") or code
                                else "")
    return {"installed": True, "running": running, "name": name, "error": error}


def serve(port: int, exe: str | None = None) -> dict:
    """Richtet https://<pc>.ts.net -> http://127.0.0.1:<port> ein.
    {"ok", "url", "enable_url" (HTTPS muss erst im Tailscale-Konto erlaubt werden), "error"}"""
    exe = exe if exe is not None else find()
    info = status(exe)
    if not info["installed"]:
        return {"ok": False, "url": "", "enable_url": "", "error": "Tailscale ist nicht installiert."}
    if not info["running"]:
        return {"ok": False, "url": "", "enable_url": "", "error": info["error"] or "Tailscale ist nicht verbunden."}
    code, out = _run(exe, "serve", "--bg", "--https=443", f"http://127.0.0.1:{int(port)}", timeout=40)
    link = ENABLE_HINT.search(out)
    if code != 0 or (link and "serve" in link.group(0)):
        if link:
            return {"ok": False, "url": "", "enable_url": link.group(0).rstrip(".,)"),
                    "error": "HTTPS ist in Ihrem Tailscale-Konto noch aus. Einmal erlauben, dann nochmal klicken."}
        return {"ok": False, "url": "", "enable_url": "", "error": out.strip().splitlines()[-1][:200] if out.strip()
                else "tailscale serve ging nicht."}
    return {"ok": True, "url": f"https://{info['name']}/", "enable_url": "", "error": ""}


def stop(exe: str | None = None) -> bool:
    exe = exe if exe is not None else find()
    if not exe:
        return False
    code, _ = _run(exe, "serve", "--https=443", "off")
    return code == 0
