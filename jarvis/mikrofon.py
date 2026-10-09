"""Benutzt gerade ein anderes Programm das Mikrofon (Discord, TeamSpeak, ein Spiel mit Sprachchat)?

Georg: "er checkt net, wann ich net mehr reden will, weil bin parallel im Discord, und dann denkt er, ich rede mit
ihm". Im Gespräch (ohne Weckwort) hört Jarvis deshalb nicht weiter zu, solange ein anderes Programm das Mikrofon
offen hat. "Jarvis" und "Hey Jarvis" gehen weiter.

Windows führt das selbst mit (Einstellungen > Datenschutz > Mikrofon, "Zuletzt verwendet"): Unter
CapabilityAccessManager\\ConsentStore\\microphone steht pro Programm, wann es das Mikrofon zuletzt geöffnet
(LastUsedTimeStart) und wieder freigegeben hat (LastUsedTimeStop). Steht Stop auf 0, hält das Programm das Mikrofon
gerade offen. Jarvis hört selbst dauernd zu und steht dort auch, er zählt nicht mit.
"""

from __future__ import annotations

import logging
import ntpath
import os
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

KEY = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
CACHE_SECONDS = 3.0
# Ohne Prozessliste: ein Eintrag, der seit einem Tag "offen" steht, ist eher ein abgestürztes Programm.
STALE_SECONDS = 24 * 3600
# Jarvis selbst (und sein Python) hält das Mikrofon immer offen.
OWN_NAMES = {"python.exe", "pythonw.exe", "py.exe", "jarvis.exe"}
# Werkzeuge, die das Mikrofon immer offen halten (Rauschfilter, virtuelle Mischpulte): kein Sprachchat.
ALWAYS_ON = {"nvidia broadcast", "nvidia rtx voice", "rtx voice", "voicemeeter", "voicemeeterpro", "voicemeeter8",
             "voicemeeter8x64", "voicemeeterpro_x64", "voicemeeter_x64", "steelseriessonar", "steelseriesgg",
             "krisp", "wavelink", "elgato wave link", "razer synapse", "lghub", "lghub_agent",
             "realtekaudioconsole", "audiodg"}
# Bekannte Sprachchats mit ihrem Namen für die Meldung, sonst der Dateiname ohne .exe.
KNOWN = {"discord": "Discord", "discordptb": "Discord", "discordcanary": "Discord", "ts3client_win64": "TeamSpeak",
         "teamspeak": "TeamSpeak", "teams": "Teams", "ms-teams": "Teams", "zoom": "Zoom", "skype": "Skype",
         "steam": "Steam", "steamwebhelper": "Steam", "whatsapp": "WhatsApp", "telegram": "Telegram",
         "obs64": "OBS", "mumble": "Mumble", "slack": "Slack", "signal": "Signal"}
# Packaged-Apps (Store) heißen nach ihrem Paket, etwa "5319275A.WhatsAppDesktop_cv1g1gvanyjgm".
PACKAGED = {"whatsapp": "WhatsApp", "teams": "Teams", "discord": "Discord", "zoom": "Zoom", "skype": "Skype",
            "telegram": "Telegram", "soundrecorder": "Sprachrekorder"}

_lock = threading.Lock()
_cache: dict = {"until": 0.0, "names": []}


def _filetime_to_unix(value: int) -> float:
    return value / 10_000_000 - 11_644_473_600


def _read(winreg, key) -> tuple[int, int] | None:
    try:
        start = int(winreg.QueryValueEx(key, "LastUsedTimeStart")[0])
        stop = int(winreg.QueryValueEx(key, "LastUsedTimeStop")[0])
    except (OSError, ValueError, TypeError):
        return None
    return start, stop


def entries(winreg=None):
    """(Pfad oder Paketname, Start, Stop, gepackt) für jedes Programm, das das Mikrofon schon einmal hatte."""
    if winreg is None:
        if os.name != "nt":
            return []
        import winreg  # type: ignore[no-redef]
    found = []
    try:
        root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY)
    except OSError:
        return []
    with root:
        index = 0
        while True:
            try:
                name = winreg.EnumKey(root, index)
            except OSError:
                break
            index += 1
            try:
                sub = winreg.OpenKey(root, name)
            except OSError:
                continue
            with sub:
                if name.lower() != "nonpackaged":
                    times = _read(winreg, sub)
                    if times:
                        found.append((name, times[0], times[1], True))
                    continue
                inner = 0
                while True:
                    try:
                        program = winreg.EnumKey(sub, inner)
                    except OSError:
                        break
                    inner += 1
                    try:
                        with winreg.OpenKey(sub, program) as entry:
                            times = _read(winreg, entry)
                    except OSError:
                        continue
                    if times:
                        found.append((program.replace("#", "\\"), times[0], times[1], False))
    return found


def _own(path: str) -> bool:
    """Jarvis selbst: sein Python (auch das aus dem Installer) oder etwas aus seinem Ordner."""
    if ntpath.basename(path).lower() in OWN_NAMES:
        return True
    lowered = ntpath.normcase(path)
    mine = {ntpath.normcase(p) for p in (sys.executable, getattr(sys, "_base_executable", "")) if p}
    if lowered in mine:
        return True
    root = ntpath.normcase(str(Path(__file__).resolve().parents[1]))
    return lowered.startswith(root.rstrip("\\") + "\\")


def _running() -> set[str] | None:
    """Laufende Programme (Dateinamen klein), None ohne psutil."""
    try:
        import psutil
    except ImportError:
        return None
    names = set()
    try:
        for proc in psutil.process_iter(["name"]):
            name = (proc.info.get("name") or "").lower()
            if name:
                names.add(name)
    except Exception as exc:
        log.debug("Prozessliste: %s", exc)
        return None
    return names


def label(path: str, packaged: bool = False) -> str:
    """Kurzer Name für die Meldung: "Discord", "TeamSpeak" oder der Dateiname."""
    if packaged:
        lowered = path.lower()
        for part, name in PACKAGED.items():
            if part in lowered:
                return name
        return path.split("_")[0].split(".")[-1] or path
    stem = ntpath.splitext(ntpath.basename(path))[0]
    return KNOWN.get(stem.lower(), stem)


def others(raw=None, running: set[str] | None = None, now: float | None = None) -> list[str]:
    """Namen der Programme, die das Mikrofon gerade offen haben, ohne Jarvis selbst."""
    now = time.time() if now is None else now
    names: list[str] = []
    for path, start, stop, packaged in (entries() if raw is None else raw):
        if stop != 0 or start <= 0:
            continue
        if not packaged and (_own(path) or ntpath.splitext(ntpath.basename(path))[0].lower() in ALWAYS_ON):
            continue
        if not packaged and running is not None and ntpath.basename(path).lower() not in running:
            continue  # das Programm läuft gar nicht mehr (abgestürzt, Windows hat Stop nicht nachgetragen)
        if (packaged or running is None) and now - _filetime_to_unix(start) > STALE_SECONDS:
            continue
        name = label(path, packaged)
        if name not in names:
            names.append(name)
    return names


def in_use_by_others() -> list[str]:
    """Wie others(), aber höchstens alle paar Sekunden echt nachgesehen (Registrierung und Prozessliste)."""
    if os.name != "nt":
        return []
    now = time.monotonic()
    with _lock:
        if now < _cache["until"]:
            return list(_cache["names"])
    try:
        raw = entries()
        names = others(raw, _running() if any(e[2] == 0 for e in raw) else None)
    except Exception as exc:
        log.debug("Mikrofon belegt?: %s", exc)
        names = []
    with _lock:
        _cache.update(until=now + CACHE_SECONDS, names=names)
    return list(names)
