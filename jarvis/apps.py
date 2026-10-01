"""Programme finden, starten, schließen und installieren.

Starten geht über das Startmenü (Get-StartApps kennt alles, was dort steht, auch Apps
aus dem Microsoft Store), Installieren über winget. Bekannte Programme stehen in
KNOWN_APPS, damit "Installier Spotify" ohne Suche sofort die richtige ID nimmt.
"""

from __future__ import annotations

import difflib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class AppError(RuntimeError):
    pass


class AppNotFound(AppError):
    pass


@dataclass(frozen=True)
class KnownApp:
    name: str
    # winget-IDs, die erste zuerst. Eine Store-ID (z. B. 9NCBCSZSJRSB) kommt aus dem Microsoft Store.
    winget: tuple[str, ...] = ()
    # Prozessnamen zum Schließen
    exe: tuple[str, ...] = ()
    # So sagt man es auch
    aliases: tuple[str, ...] = ()
    # Bleibt nach dem Schließen gern im Tray: dann darf Jarvis es hart beenden.
    tray: bool = False
    # Webseite, falls das Programm nicht installiert ist
    url: str = ""


KNOWN_APPS: tuple[KnownApp, ...] = (
    KnownApp("Spotify", ("Spotify.Spotify", "9NCBCSZSJRSB"), ("Spotify.exe",), ("spotifei",), True, "https://open.spotify.com"),
    KnownApp("Discord", ("Discord.Discord",), ("Discord.exe",), ("discort",), True, "https://discord.com/app"),
    KnownApp("Steam", ("Valve.Steam",), ("steam.exe", "steamwebhelper.exe"), ("steam client",), True),
    KnownApp("Google Chrome", ("Google.Chrome",), ("chrome.exe",), ("chrome", "google chrome", "crome")),
    KnownApp("Firefox", ("Mozilla.Firefox",), ("firefox.exe",), ("mozilla firefox", "feuerfuchs")),
    KnownApp("Microsoft Edge", (), ("msedge.exe",), ("edge",)),
    KnownApp("Brave", ("Brave.Brave",), ("brave.exe",), ("brave browser",)),
    KnownApp("Opera GX", ("Opera.OperaGX",), ("opera.exe",), ("opera", "opera gx browser")),
    KnownApp("VLC", ("VideoLAN.VLC",), ("vlc.exe",), ("vlc media player", "vlc player")),
    KnownApp("OBS Studio", ("OBSProject.OBSStudio",), ("obs64.exe",), ("obs",)),
    KnownApp("WhatsApp", ("9NKSQGP7F2NH",), ("WhatsApp.exe", "WhatsApp.Root.exe"), ("whatsapp desktop",), True,
             "https://web.whatsapp.com"),
    KnownApp("Telegram", ("Telegram.TelegramDesktop",), ("Telegram.exe",), ("telegram desktop",), True),
    KnownApp("Signal", ("OpenWhisperSystems.Signal",), ("Signal.exe",), (), True),
    KnownApp("Zoom", ("Zoom.Zoom",), ("Zoom.exe",), ("zoom meetings",), True),
    KnownApp("Microsoft Teams", ("Microsoft.Teams",), ("ms-teams.exe", "Teams.exe"), ("teams",), True),
    KnownApp("Epic Games Launcher", ("EpicGames.EpicGamesLauncher",), ("EpicGamesLauncher.exe",),
             ("epic", "epic games", "epic launcher"), True),
    KnownApp("Battle.net", ("Blizzard.BattleNet",), ("Battle.net.exe",), ("battlenet", "battle net", "blizzard"), True),
    KnownApp("EA app", ("ElectronicArts.EADesktop",), ("EADesktop.exe",), ("ea", "ea desktop", "origin"), True),
    KnownApp("Ubisoft Connect", ("Ubisoft.Connect",), ("UbisoftConnect.exe", "upc.exe"), ("ubisoft", "uplay"), True),
    KnownApp("GOG Galaxy", ("GOG.Galaxy",), ("GalaxyClient.exe",), ("gog",), True),
    KnownApp("Visual Studio Code", ("Microsoft.VisualStudioCode",), ("Code.exe",), ("vs code", "vscode", "code")),
    KnownApp("Notepad++", ("Notepad++.Notepad++",), ("notepad++.exe",), ("notepad plus plus", "notepad plus")),
    KnownApp("7-Zip", ("7zip.7zip",), ("7zFM.exe",), ("7zip", "seven zip", "sieben zip")),
    KnownApp("WinRAR", ("RARLab.WinRAR",), ("WinRAR.exe",), ("win rar",)),
    KnownApp("TeamSpeak", ("TeamSpeakSystems.TeamSpeakClient",), ("ts3client_win64.exe", "TeamSpeak.exe"),
             ("teamspeak 3", "ts"), True),
    KnownApp("MSI Afterburner", ("Guru3D.Afterburner",), ("MSIAfterburner.exe",), ("afterburner",), True),
    KnownApp("GeForce Experience", ("Nvidia.GeForceExperience",), ("NVIDIA GeForce Experience.exe",), ("geforce",)),
    KnownApp("Logitech G HUB", ("Logitech.GHUB",), ("lghub.exe",), ("g hub", "ghub", "logitech"), True),
    KnownApp("Audacity", ("Audacity.Audacity",), ("Audacity.exe",)),
    KnownApp("Blender", ("BlenderFoundation.Blender",), ("blender.exe",)),
    KnownApp("Minecraft Launcher", ("Mojang.MinecraftLauncher",), ("MinecraftLauncher.exe", "Minecraft.exe"),
             ("minecraft",)),
    KnownApp("Netflix", ("9WZDNCRFJ3TJ",), ("Netflix.exe",), (), False, "https://www.netflix.com"),
    KnownApp("iTunes", ("Apple.iTunes",), ("iTunes.exe",)),
    KnownApp("Thunderbird", ("Mozilla.Thunderbird",), ("thunderbird.exe",), (), True),
    KnownApp("LibreOffice", ("TheDocumentFoundation.LibreOffice",), ("soffice.exe", "soffice.bin"), ("libre office",)),
    KnownApp("PowerToys", ("Microsoft.PowerToys",), ("PowerToys.exe",), ("power toys",), True),
    KnownApp("Windows Terminal", ("Microsoft.WindowsTerminal",), ("WindowsTerminal.exe",), ("terminal",)),
    KnownApp("Git", ("Git.Git",), ()),
    KnownApp("Node.js", ("OpenJS.NodeJS.LTS",), (), ("node", "nodejs", "node js")),
    KnownApp("Wallpaper Engine", (), ("wallpaper32.exe", "wallpaper64.exe"), ("wallpaper",), True),
    KnownApp("Rechner", (), ("CalculatorApp.exe",), ("taschenrechner", "calculator")),
    KnownApp("Editor", (), ("notepad.exe",), ("notepad", "texteditor", "notizblock")),
    KnownApp("Datei-Explorer", (), (), ("explorer", "dateiexplorer", "datei explorer", "dateien", "arbeitsplatz",
                                         "dieser pc")),
    KnownApp("Task-Manager", (), ("Taskmgr.exe",), ("taskmanager", "task manager")),
    KnownApp("Einstellungen", (), ("SystemSettings.exe",), ("windows einstellungen", "settings")),
    KnownApp("Paint", (), ("mspaint.exe",), ("ms paint",)),
    KnownApp("Systemsteuerung", (), (), ("control panel", "system steuerung")),
    KnownApp("Geräte-Manager", (), (), ("gerätemanager", "geräte manager", "device manager")),
    KnownApp("Datenträgerverwaltung", (), (), ("datenträger verwaltung", "festplattenverwaltung")),
    KnownApp("Dienste", (), (), ("services", "windows dienste")),
    KnownApp("Ereignisanzeige", (), (), ("event viewer", "ereignis anzeige")),
    KnownApp("Registrierungs-Editor", (), ("regedit.exe",), ("registry", "regedit", "registrierungseditor")),
    KnownApp("Ressourcenmonitor", (), (), ("resource monitor", "resmon", "ressourcen monitor")),
    KnownApp("Eingabeaufforderung", (), ("cmd.exe",), ("cmd", "kommandozeile", "konsole")),
    KnownApp("PowerShell", (), ("powershell.exe",), ("power shell",)),
    KnownApp("Papierkorb", (), (), ("recycle bin",)),
)

# Programme, die Windows immer hat: falls sie im Startmenü anders heißen.
_BUILTIN_COMMANDS = {
    "Rechner": "calc.exe",
    "Editor": "notepad.exe",
    "Datei-Explorer": "explorer.exe",
    "Task-Manager": "taskmgr.exe",
    "Einstellungen": "ms-settings:",
    "Paint": "mspaint.exe",
    "Systemsteuerung": "control.exe",
    "Geräte-Manager": "devmgmt.msc",
    "Datenträgerverwaltung": "diskmgmt.msc",
    "Dienste": "services.msc",
    "Ereignisanzeige": "eventvwr.msc",
    "Registrierungs-Editor": "regedit.exe",
    "Ressourcenmonitor": "resmon.exe",
    "Eingabeaufforderung": "cmd.exe",
    "PowerShell": "powershell.exe",
    "Papierkorb": "shell:RecycleBinFolder",
}

from .web import SITES as WEBSITES  # noqa: E402  (Name -> (Anzeige, Adresse))

# Startmenü-Einträge, die niemand öffnen will, wenn er nur den Programmnamen sagt.
_JUNK = re.compile(r"uninstall|deinstall|readme|liesmich|help|hilfe|website|webseite|support|manual|handbuch|release notes|license|lizenz", re.I)


def normalize(name: str) -> str:
    """Kleinbuchstaben, ohne Satzzeichen und Zusätze wie "(x64)"."""
    name = name.lower().replace("&", " und ")
    name = re.sub(r"\((?:x64|x86|64-bit|32-bit|64 bit|32 bit)\)", " ", name)
    name = re.sub(r"[^\w+]+", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def _squash(name: str) -> str:
    return normalize(name).replace(" ", "")


def find_known(name: str) -> KnownApp | None:
    """Das bekannte Programm zu einem gesprochenen Namen ("Spotify", "VS Code")."""
    wanted = _squash(name)
    if not wanted:
        return None
    table: dict[str, KnownApp] = {}
    for app in KNOWN_APPS:
        for alias in (app.name, *app.aliases, *app.winget):
            table.setdefault(_squash(alias), app)
    if wanted in table:
        return table[wanted]
    close = difflib.get_close_matches(wanted, list(table), n=1, cutoff=0.85)
    return table[close[0]] if close else None


# ---------------------------------------------------------------------- Startmenü

class StartMenu:
    """Alles, was im Startmenü steht, mit Name und AppID (über Get-StartApps).

    Die Liste liegt im Speicher: beim Start im Hintergrund geladen (warm), danach alle
    zehn Minuten im Hintergrund erneuert. "Öffne ..." wartet so nie auf PowerShell
    (das dauert unter Windows 1 bis 3 Sekunden), nur beim allerersten Mal, falls die
    Liste da noch nicht fertig ist."""

    MAX_AGE = 10 * 60
    # Fehlt ein Name, wird die Liste im Hintergrund erneuert, aber höchstens so oft.
    MISS_REFRESH = 20

    def __init__(self, loader=None) -> None:
        self._loader = loader or load_start_apps
        self._apps: list[tuple[str, str]] = []
        self._loaded_at = -1e9
        self._lock = threading.Lock()
        self._refreshing = False
        self._loaded = threading.Event()

    def _load(self) -> list[tuple[str, str]]:
        asked = time.monotonic()
        with self._lock:
            if self._loaded_at >= asked:
                return list(self._apps)  # ein anderer Thread hat gerade frisch geladen
            try:
                self._apps = self._loader()
            except Exception as exc:
                log.warning("Startmenü nicht lesbar: %s", exc)
            self._loaded_at = time.monotonic()
            self._loaded.set()
            return list(self._apps)

    def warm(self) -> None:
        """Lädt die Liste im Hintergrund, damit das erste "Öffne ..." nicht wartet."""
        self.refresh_later()

    def refresh_later(self) -> None:
        if self._refreshing:
            return
        self._refreshing = True

        def run() -> None:
            try:
                self._load()
            finally:
                self._refreshing = False

        threading.Thread(target=run, name="jarvis-startmenue", daemon=True).start()

    def apps(self, refresh: bool = False) -> list[tuple[str, str]]:
        if refresh:
            return self._load()
        if not self._loaded.is_set():
            if self._refreshing:
                self._loaded.wait(timeout=10)  # das erste Laden läuft schon: darauf warten
            if not self._loaded.is_set():
                return self._load()
        elif time.monotonic() - self._loaded_at > self.MAX_AGE:
            self.refresh_later()  # die alte Liste gilt, bis die neue da ist
        return list(self._apps)

    def find(self, name: str, strict: bool = False) -> tuple[str, str] | None:
        """Der beste Eintrag für einen gesprochenen Namen, oder None. strict: nur der genaue
        Name (bei Webseiten: "Amazon" soll nicht "Amazon Music" starten).
        Fehlt der Name, wird die Liste im Hintergrund erneuert (vielleicht gerade erst
        installiert); gewartet wird darauf nicht."""
        found = best_match(name, self.apps(), strict=strict)
        if found is None and time.monotonic() - self._loaded_at > self.MISS_REFRESH:
            self.refresh_later()
        return found


def best_match(name: str, apps: list[tuple[str, str]], strict: bool = False) -> tuple[str, str] | None:
    wanted = normalize(name)
    if not wanted or not apps:
        return None
    known = find_known(name)
    names = {wanted, wanted.replace(" ", "")}
    if known is not None:
        names |= {normalize(known.name), *(normalize(a) for a in known.aliases)}
    candidates = [(entry, normalize(entry[0])) for entry in apps if not _JUNK.search(entry[0])]
    # 1. genau so, 2. ohne Leerzeichen gleich, 3. fängt so an, 4. enthält das Wort, 5. ähnlich
    for entry, norm in candidates:
        if norm in names:
            return entry
    for entry, norm in candidates:
        if norm.replace(" ", "") in {n.replace(" ", "") for n in names}:
            return entry
    if strict:
        return None
    starts = [(len(norm), entry) for entry, norm in candidates if any(norm.startswith(n + " ") for n in names)]
    if starts:
        return min(starts)[1]
    contains = [
        (len(norm), entry) for entry, norm in candidates
        if any(re.search(rf"(?:^| ){re.escape(n)}(?: |$)", norm) for n in names if len(n) >= 3)
    ]
    if contains:
        return min(contains)[1]
    by_norm = {norm: entry for entry, norm in candidates}
    close = difflib.get_close_matches(wanted, list(by_norm), n=1, cutoff=0.8)
    return by_norm[close[0]] if close else None


def load_start_apps() -> list[tuple[str, str]]:
    if os.name != "nt":
        return []
    script = (
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
        "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=NO_WINDOW,
    )
    data = json.loads(result.stdout.strip() or "[]")
    if isinstance(data, dict):
        data = [data]
    return [(str(d["Name"]), str(d["AppID"])) for d in data if d.get("Name") and d.get("AppID")]


START_MENU = StartMenu()


def website(name: str, known: KnownApp | None = None) -> tuple[str, str] | None:
    """(Anzeige, Adresse), wenn der Name eine Webseite ist ("YouTube", "amazon.de"), sonst None."""
    from . import web

    found = web.site(name)
    if found is None and known is not None and known.url:
        found = (known.name, known.url)
    return found


def open_app(name: str, start_menu: StartMenu | None = None) -> str:
    """Startet ein Programm oder öffnet eine bekannte Webseite. Gibt einen kurzen Satz zurück.

    Ist der Name auch eine Webseite, zählt im Startmenü nur der genaue Name ("YouTube" als
    App ja, "Amazon Music" für "Amazon" nein), sonst öffnet sich gleich die Seite."""
    name = name.strip().strip("\"'")
    if not name:
        raise AppNotFound("Kein Programmname.")
    menu = start_menu or START_MENU
    known = find_known(name)
    site = website(name, known)
    entry = menu.find(name, strict=site is not None) if os.name == "nt" else None
    if entry is not None:
        _launch(f"shell:AppsFolder\\{entry[1]}")
        return f"{entry[0]} startet."
    if known is not None and known.name in _BUILTIN_COMMANDS:
        _launch(_BUILTIN_COMMANDS[known.name])
        return f"{known.name} ist offen."
    if site is not None:
        _launch(site[1])
        return f"{site[0]} ist offen."
    raise AppNotFound(f"{name} finde ich nicht im Startmenü.")


def _launch(target: str) -> None:
    if os.name != "nt":
        raise AppError("Das geht nur unter Windows.")
    try:
        os.startfile(target)  # type: ignore[attr-defined]
    except OSError:
        subprocess.Popen(["explorer.exe", target], creationflags=NO_WINDOW)


# ---------------------------------------------------------------------- Schließen

def running_processes() -> list[tuple[str, int]]:
    """(Prozessname, PID) aller laufenden Programme."""
    try:
        import psutil

        rows = []
        for proc in psutil.process_iter(["name", "pid"]):
            if proc.info.get("name"):
                rows.append((proc.info["name"], proc.info["pid"]))
        return rows
    except ImportError:
        pass
    result = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=20, creationflags=NO_WINDOW,
    )
    rows = []
    for line in result.stdout.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[1].strip('"').isdigit():
            rows.append((parts[0].strip('"'), int(parts[1].strip('"'))))
    return rows


# Diese Prozesse beendet Jarvis nie, auch wenn der Name passt.
_NEVER_CLOSE = {
    "explorer.exe", "dwm.exe", "winlogon.exe", "csrss.exe", "lsass.exe", "services.exe", "svchost.exe",
    "system", "smss.exe", "wininit.exe", "python.exe", "pythonw.exe", "claude.exe", "node.exe",
    "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "fontdrvhost.exe", "sihost.exe",
}


def matching_processes(name: str, processes: list[tuple[str, int]]) -> tuple[KnownApp | None, list[tuple[str, int]]]:
    known = find_known(name)
    if known is not None and known.exe:
        wanted = {e.lower() for e in known.exe}
        hits = [(n, pid) for n, pid in processes if n.lower() in wanted]
        if hits:
            return known, hits
    key = _squash(name)
    if len(key) < 3:
        return known, []
    hits = []
    for proc_name, pid in processes:
        if proc_name.lower() in _NEVER_CLOSE:
            continue
        stem = _squash(re.sub(r"\.exe$", "", proc_name, flags=re.I))
        if stem == key or (len(key) >= 4 and stem.startswith(key)):
            hits.append((proc_name, pid))
    return known, hits


def close_app(name: str, wait: float = 4.0) -> str:
    """Schließt ein Programm normal (wie mit dem X). Programme, die im Tray weiterlaufen
    (Discord, Steam ...), beendet Jarvis danach ganz."""
    if os.name != "nt":
        raise AppError("Das geht nur unter Windows.")
    known, hits = matching_processes(name, running_processes())
    label = known.name if known else name.strip()
    if not hits:
        raise AppNotFound(f"{label} läuft gerade nicht.")
    images = sorted({n for n, _ in hits}, key=str.lower)
    for image in images:
        _run(["taskkill", "/IM", image])
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not _still_running(images):
            return f"{label} ist zu."
        time.sleep(0.3)
    if known is not None and known.tray:
        for image in images:
            _run(["taskkill", "/F", "/T", "/IM", image])
        time.sleep(0.5)
        if not _still_running(images):
            return f"{label} ist zu."
    raise AppError(f"{label} ist noch offen, vielleicht fragt es, ob etwas gespeichert werden soll.")


def _still_running(images: list[str]) -> bool:
    wanted = {i.lower() for i in images}
    return any(n.lower() in wanted for n, _ in running_processes())


# ---------------------------------------------------------------------- Installieren

STORE_ID = re.compile(r"^[0-9A-Z]{12}$")
# winget: "Paket ist schon installiert" bzw. "kein Update verfügbar"
_ALREADY = re.compile(
    r"already installed|bereits installiert|no available upgrade|kein verfügbares upgrade|"
    r"no newer package|keine neueren paketversionen|schon installiert",
    re.I,
)
_NO_INSTALLER = re.compile(r"no applicable installer|kein anwendbares installationsprogramm|no package found|kein paket gefunden", re.I)
WINGET_ALREADY = {-1978335189, 0x8A15002B, -1978335135, 0x8A150061}
WINGET_NO_INSTALLER = {-1978335212, 0x8A150014}


@dataclass
class WingetResult:
    code: int
    output: str

    @property
    def ok(self) -> bool:
        return self.code == 0

    @property
    def already(self) -> bool:
        return self.code in WINGET_ALREADY or bool(_ALREADY.search(self.output))

    @property
    def no_installer(self) -> bool:
        return self.code in WINGET_NO_INSTALLER or bool(_NO_INSTALLER.search(self.output))

    def reason(self) -> str:
        lines = [
            line.strip() for line in re.split(r"[\r\n]+", self.output)
            if line.strip() and not re.fullmatch(r"[\W█▒░\-\\|/]*\d*\s*%?", line.strip())
        ]
        return " ".join(lines[-3:])[:300] or f"winget meldet Code {self.code}"


def winget(args: list[str], timeout: float = 600) -> WingetResult:
    if os.name != "nt":
        raise AppError("Das geht nur unter Windows.")
    log_file = Path(tempfile.gettempdir()) / "jarvis-winget.log"
    with open(log_file, "w", encoding="utf-8", errors="replace") as out:
        proc = subprocess.Popen(
            ["winget", *args, "--accept-source-agreements", "--disable-interactivity"],
            stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TimeoutError("winget arbeitet noch") from None
    text = log_file.read_text(encoding="utf-8", errors="replace")
    log.info("winget %s: Code %s", " ".join(args[:3]), code)
    return WingetResult(code, text)


def install(target: str, timeout: float = 600) -> str:
    """Installiert ein Programm über winget: bekannter Name ("spotify") oder winget-ID.
    Erst nur für Georg (ohne Administratorrechte), wenn das nicht geht, für alle
    (dann fragt Windows selbst nach)."""
    target = target.strip().strip("\"'")
    if not target:
        raise AppError("Welches Programm?")
    known = find_known(target)
    ids = list(known.winget) if known and known.winget else [target]
    label = known.name if known else target
    if known is not None and not known.winget:
        raise AppError(f"{label} gibt es nicht über winget.")
    reason = ""
    for package_id in ids:
        base = ["install", "--id", package_id, "--exact", "--silent", "--accept-package-agreements"]
        if STORE_ID.match(package_id):
            base += ["--source", "msstore"]
        attempts = [base] if STORE_ID.match(package_id) else [base + ["--scope", "user"], base]
        for args in attempts:
            result = winget(args, timeout)
            if result.ok:
                START_MENU.apps(refresh=True)
                return f"{label} ist installiert."
            if result.already:
                return f"{label} ist schon installiert."
            reason = result.reason()
            if not result.no_installer:
                break  # echter Fehler: nicht noch einmal ohne Bereich probieren
    raise AppError(f"{label} ließ sich nicht installieren: {reason}")


def uninstall(target: str, timeout: float = 600) -> str:
    target = target.strip().strip("\"'")
    known = find_known(target)
    ids = list(known.winget) if known and known.winget else [target]
    label = known.name if known else target
    reason = ""
    for package_id in ids:
        result = winget(["uninstall", "--id", package_id, "--exact", "--silent"], timeout)
        if result.ok:
            return f"{label} ist deinstalliert."
        reason = result.reason()
    raise AppError(f"{label} ließ sich nicht deinstallieren: {reason}")


def _run(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        creationflags=NO_WINDOW,
    )
