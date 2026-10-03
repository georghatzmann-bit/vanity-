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
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
ENABLE_HINT = re.compile(r"https://login\.tailscale\.com/\S+")
# Ist HTTPS im Tailscale-Konto noch aus, gibt "tailscale serve" einen Link zum Erlauben aus und wartet,
# bis Georg dort klickt. So lange wartet Jarvis im Hintergrund mit (Sekunden).
ENABLE_WAIT = 600.0
WAITING = ("Im Browser ist die Tailscale-Seite offen: dort einmal HTTPS erlauben (Enable). "
           "Danach schaltet Jarvis es von selbst ein.")

_pending_lock = threading.Lock()
_pending: dict | None = None  # {"proc", "enable_url"}: ein tailscale serve, das noch auf die Freigabe wartet


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


def _result(ok: bool, url: str = "", enable_url: str = "", error: str = "", pending: bool = False) -> dict:
    return {"ok": ok, "url": url, "enable_url": enable_url, "pending": pending, "error": error}


def _read(pipe, lines: queue.Queue) -> None:
    try:
        for line in pipe:
            lines.put(line)
    except (OSError, ValueError):
        pass
    finally:
        try:
            pipe.close()
        except (OSError, ValueError):
            pass
        lines.put(None)


def _last(out: list[str]) -> str:
    rows = [row.strip() for row in "".join(out).splitlines() if row.strip()]
    return rows[-1][:200] if rows else ""


def _stop(proc) -> None:
    try:
        proc.kill()
        proc.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _drain(lines: queue.Queue, out: list[str]) -> None:
    while True:
        try:
            line = lines.get_nowait()
        except queue.Empty:
            return
        if line is None:
            return
        out.append(line)


def _await(proc, lines: queue.Queue, out: list[str], url: str, on_done: Callable[[dict], None] | None) -> None:
    """tailscale serve wartet darauf, dass Georg HTTPS erlaubt. Kommt das, ist "Sicher von überall" an."""
    global _pending
    try:
        code = proc.wait(timeout=ENABLE_WAIT)
    except subprocess.TimeoutExpired:
        _stop(proc)
        result = _result(False, error="HTTPS wurde in Tailscale nicht erlaubt. Einfach nochmal einschalten.")
    else:
        time.sleep(0.1)  # die letzten Zeilen der Ausgabe
        _drain(lines, out)
        result = _result(True, url) if code == 0 else _result(False, error=_last(out) or "tailscale serve ging nicht.")
    with _pending_lock:
        if _pending is not None and _pending.get("proc") is proc:
            _pending = None
    log.info("Tailscale serve nach der Freigabe: %s", "an" if result["ok"] else result["error"])
    if on_done is not None:
        try:
            on_done(result)
        except Exception as exc:
            log.debug("Tailscale fertig: %s", exc)


def serve(port: int, exe: str | None = None, wait: float = 20.0,
          on_done: Callable[[dict], None] | None = None) -> dict:
    """Richtet https://<pc>.ts.net -> http://127.0.0.1:<port> ein.
    {"ok", "url", "enable_url", "pending", "error"}. Muss HTTPS erst im Tailscale-Konto erlaubt werden,
    gibt tailscale einen Link aus und wartet. Dann kommt sofort pending mit dem Link zurück, tailscale
    wartet im Hintergrund weiter, und on_done meldet, wie es ausging (früher lief das in eine Zeitgrenze,
    und der Link ging verloren)."""
    global _pending
    exe = exe if exe is not None else find()
    info = status(exe)
    if not info["installed"]:
        return _result(False, error="Tailscale ist nicht installiert.")
    if not info["running"]:
        return _result(False, error=info["error"] or "Tailscale ist nicht verbunden.")
    url = f"https://{info['name']}/"
    with _pending_lock:
        if _pending is not None and _pending["proc"].poll() is None:
            return _result(False, enable_url=_pending["enable_url"], error=WAITING, pending=True)
    try:
        proc = subprocess.Popen([exe, "serve", "--bg", "--https=443", f"http://127.0.0.1:{int(port)}"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    except OSError as exc:
        return _result(False, error=f"tailscale serve ging nicht: {exc}")
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=_read, args=(proc.stdout, lines), name="jarvis-tailscale", daemon=True).start()
    out: list[str] = []
    deadline = time.monotonic() + wait
    finished = False
    while not finished:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            line = lines.get(timeout=min(0.2, left))
        except queue.Empty:
            continue
        if line is None:
            finished = True
            break
        out.append(line)
        link = ENABLE_HINT.search(line)
        if link and proc.poll() is None:
            enable = link.group(0).rstrip(".,)")
            with _pending_lock:
                _pending = {"proc": proc, "enable_url": enable}
            threading.Thread(target=_await, args=(proc, lines, out, url, on_done), name="jarvis-tailscale-wartet",
                             daemon=True).start()
            log.info("Tailscale wartet auf die Freigabe von HTTPS: %s", enable)
            return _result(False, enable_url=enable, error=WAITING, pending=True)
    try:
        code = proc.wait(timeout=5 if finished else 1)
    except subprocess.TimeoutExpired:
        _stop(proc)
        last = _last(out)
        return _result(False, error="Tailscale antwortet nicht. Ist die Tailscale-App gestartet und angemeldet?"
                                    + (f" ({last})" if last else ""))
    text = "".join(out)
    if code != 0:
        link = ENABLE_HINT.search(text)
        if link:
            return _result(False, enable_url=link.group(0).rstrip(".,)"),
                           error="HTTPS ist in Ihrem Tailscale-Konto noch aus. Einmal erlauben, dann nochmal klicken.")
        return _result(False, error=_last(out) or "tailscale serve ging nicht.")
    return _result(True, url)


def stop(exe: str | None = None) -> bool:
    global _pending
    with _pending_lock:
        waiting, _pending = _pending, None
    if waiting is not None and waiting["proc"].poll() is None:
        _stop(waiting["proc"])  # wartete noch auf die Freigabe: nicht mehr nötig
    exe = exe if exe is not None else find()
    if not exe:
        return False
    code, _ = _run(exe, "serve", "--https=443", "off")
    return code == 0
