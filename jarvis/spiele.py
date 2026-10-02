"""Spiele: installieren, starten und auf Updates prüfen, ohne Claude (darum in etwa einer Sekunde).

"Installiere CS2", "Starte Lethal Company", "Welche Spiele brauchen Updates?", "Deinstalliere Rust".
- Steam: Die Bibliotheken stehen in steamapps/libraryfolders.vdf, jedes installierte Spiel hat dort eine
  appmanifest_<id>.acf (Name, Größe, Zustand: fertig, Update nötig, lädt). Installieren über
  steam://install/<id>: Steam zeigt seinen Dialog. Gibt es nur eine Bibliothek, bestätigt Jarvis ihn selbst
  (Enter), bei mehreren sagt er, welches Laufwerk am meisten Platz hat (wählen kann nur der Dialog). Sobald
  der Download läuft, sagt er, auf welchem Laufwerk: Dort taucht die neue appmanifest auf.
  Starten über steam://rungameid/<id>, Deinstallieren über steam://uninstall/<id> (Steam fragt selbst nach).
- Epic Games: installierte Spiele aus den Manifesten des Launchers (ProgramData), starten über
  com.epicgames.launcher://apps/<AppName>?action=launch. Updates sieht nur der Launcher selbst.
- Abkürzungen ("CS2", "GTA 5", "Repo") kennt Jarvis, alles andere sucht er im Steam-Shop und merkt es sich.
  Passt der Name nicht eindeutig ("Minecraft", "Python"), übernimmt Claude (vielleicht ist es gar kein
  Steam-Spiel, sondern ein Programm für winget).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

STORE_SEARCH = "https://store.steampowered.com/api/storesearch/"
APP_DETAILS = "https://store.steampowered.com/api/appdetails"
USER_AGENT = "Jarvis/2.0 (Sprachassistent)"
CACHE_FILE = "spiele.json"

# Zustände in appmanifest (StateFlags, Bits wie in Steam): 2 Update nötig, 4 fertig installiert,
# 256 Update läuft, 512 pausiert, 1024 Update begonnen, 1048576 lädt herunter
_UPDATE_REQUIRED = 2
_INSTALLED = 4
_UPDATE_RUNNING = 256
_UPDATE_PAUSED = 512
_UPDATE_STARTED = 1024
_DOWNLOADING = 1048576

# Steam-Zusatzpakete: keine Spiele, haben aber auch Updates
TOOLS = {"228980"}

# So sagt Georg es, so heißt es im Steam-Shop (gesucht wird mit dem rechten Namen)
ALIASES = {
    "cs": "Counter-Strike 2", "cs2": "Counter-Strike 2", "counterstrike": "Counter-Strike 2",
    "counterstrike2": "Counter-Strike 2", "csgo": "Counter-Strike 2", "counterstrikego": "Counter-Strike 2",
    "gta": "Grand Theft Auto V", "gta5": "Grand Theft Auto V", "gtav": "Grand Theft Auto V", "gtafive": "Grand Theft Auto V",
    "pubg": "PUBG: BATTLEGROUNDS", "apex": "Apex Legends", "r6": "Tom Clancy's Rainbow Six Siege",
    "rainbowsix": "Tom Clancy's Rainbow Six Siege", "rainbowsixsiege": "Tom Clancy's Rainbow Six Siege",
    "repo": "R.E.P.O.", "rdr2": "Red Dead Redemption 2", "bg3": "Baldur's Gate 3", "poe": "Path of Exile",
    "poe2": "Path of Exile 2", "tf2": "Team Fortress 2", "dota": "Dota 2", "cod": "Call of Duty", "warzone": "Call of Duty",
    "finals": "THE FINALS", "helldivers": "HELLDIVERS 2", "schedule1": "Schedule I", "scheduleone": "Schedule I",
    "eldenring": "ELDEN RING", "cyberpunk": "Cyberpunk 2077", "rust": "Rust",
}
# Nur bei Epic (AppName des Launchers)
EPIC_ONLY = {"fortnite": ("Fortnite", "Fortnite"), "rocketleague": ("Rocket League", "Sugar")}

_NUMBERS = {"eins": "1", "zwei": "2", "drei": "3", "vier": "4", "fünf": "5", "sechs": "6", "sieben": "7", "acht": "8",
            "neun": "9", "zehn": "10", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5"}
_ROMAN = {"ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}


def tokens(name: str) -> list[str]:
    """Ein Spielname als Wörter: klein, ohne ™ und Satzzeichen, Zahlwörter und römische Zahlen als Ziffern
    ("Grand Theft Auto V" -> grand theft auto 5, "CS zwei" -> cs 2, "R.E.P.O." -> repo)."""
    text = str(name or "").lower().replace("&", " and ")
    text = re.sub(r"(?<=\b[a-z])\.(?=[a-z]\.)", "", text)  # R.E.P.O. -> repo.
    text = re.sub(r"\b([a-z])\.", r"\1", text)
    words = re.findall(r"[a-z0-9äöüß]+", text)
    out = []
    for word in words:
        word = _NUMBERS.get(word, word)
        out.append(_ROMAN.get(word, word) if out else word)  # "V" vorne ist kein Fünfer
    # einzelne Buchstaben zusammen: "c s 2" -> "cs 2"
    joined: list[str] = []
    for word in out:
        if joined and len(word) == 1 and word.isalpha() and len(joined[-1]) <= 3 and joined[-1].isalpha():
            joined[-1] += word
        else:
            joined.append(word)
    return joined


def compact(name: str) -> str:
    return "".join(tokens(name))


def acronym(name: str) -> str:
    """Die Anfangsbuchstaben, Zahlen bleiben ganz: "Counter-Strike 2" -> cs2, "Baldur's Gate 3" -> bg3."""
    words = re.findall(r"[a-z0-9äöüß]+", re.sub(r"'s\b", "", str(name or "").lower()))
    out = ""
    for word in words:
        word = _NUMBERS.get(word, word)
        word = _ROMAN.get(word, word) if out else word
        out += word if word.isdigit() else word[0]
    return out


def parse_vdf(text: str) -> dict:
    """Steams Textformat (KeyValues): "Schlüssel" "Wert" und "Schlüssel" { ... }. Schlüssel klein."""
    root: dict = {}
    stack = [root]
    key = None
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|([{}])|(//[^\n]*)|([^\s"{}]+)', text):
        quoted, brace, comment, bare = m.groups()
        if comment is not None:
            continue
        if brace == "{":
            child: dict = {}
            if key is not None:
                stack[-1][key.lower()] = child
            stack.append(child)
            key = None
        elif brace == "}":
            if len(stack) > 1:
                stack.pop()
            key = None
        else:
            token = quoted.replace("\\\\", "\\").replace('\\"', '"') if quoted is not None else bare
            if key is None:
                key = token
            else:
                stack[-1][key.lower()] = token
                key = None
    return root


def parse_size(text: str) -> int:
    """Platzbedarf aus den Systemanforderungen ("Speicherplatz: 85 GB verfügbar"), in Bytes. 0 = unbekannt."""
    plain = re.sub(r"<[^>]+>", " ", str(text or ""))
    best = 0
    for m in re.finditer(r"(?:speicherplatz|festplattenspeicher|festplatte|speicher|storage|hard (?:disk|drive)|disk space)"
                         r"\s*:?\s*(?:mindestens\s+|at least\s+)?(\d+(?:[.,]\d+)?)\s*(tb|gb|mb)", plain, re.I):
        number = float(m.group(1).replace(",", "."))
        unit = {"tb": 1024 ** 4, "gb": 1024 ** 3, "mb": 1024 ** 2}[m.group(2).lower()]
        best = max(best, int(number * unit))
    return best


def gigabytes(size: int) -> str:
    gb = size / 1024 ** 3
    return f"{gb:.0f} GB" if gb >= 10 else f"{gb:.1f} GB".replace(".", ",")


def drive_name(path) -> str:
    """"F:\\SteamLibrary" -> "Laufwerk F" (sonst der Ordner selbst)."""
    text = str(path)
    m = re.match(r"^([A-Za-z]):", text)
    return f"Laufwerk {m.group(1).upper()}" if m else text


@dataclass
class Game:
    name: str
    store: str  # "steam" oder "epic"
    id: str  # Steam: AppID, Epic: AppName
    library: str = ""  # Steam-Bibliothek, in der es liegt
    size: int = 0  # Bytes auf der Platte
    flags: int = 0
    tool: bool = False
    launch_id: str = ""  # Epic: "Namespace:Katalog-ID:AppName" wie in Epics eigenen Verknüpfungen

    @property
    def needs_update(self) -> bool:
        return bool(self.flags & (_UPDATE_REQUIRED | _UPDATE_PAUSED | _UPDATE_STARTED))

    @property
    def downloading(self) -> bool:
        return bool(self.flags & (_UPDATE_RUNNING | _DOWNLOADING))

    @property
    def installed(self) -> bool:
        return self.store == "epic" or bool(self.flags & _INSTALLED)


class Env:
    """Die echte Windows-Seite. Tests nehmen eine Attrappe mit denselben Methoden."""

    def steam_root(self) -> Path | None:
        try:
            import winreg  # type: ignore[import-not-found]
        except ImportError:
            winreg = None
        if winreg is not None:
            for hive, sub, value in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
                                     (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
                                     (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath")):
                try:
                    with winreg.OpenKey(hive, sub) as key:
                        path = Path(str(winreg.QueryValueEx(key, value)[0]))
                    if path.is_dir():
                        return path
                except OSError:
                    continue
        for guess in (r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"):
            if os.name == "nt" and Path(guess).is_dir():
                return Path(guess)
        return None

    def epic_manifests(self) -> Path:
        return Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Epic" / "EpicGamesLauncher" / "Data" / "Manifests"

    def open_uri(self, uri: str) -> None:
        os.startfile(uri)  # type: ignore[attr-defined]

    def running(self, names: tuple[str, ...]) -> bool:
        try:
            import psutil

            wanted = {n.lower() for n in names}
            return any((p.info.get("name") or "").lower() in wanted for p in psutil.process_iter(["name"]))
        except Exception:
            return False

    def free_bytes(self, path: str) -> int:
        try:
            return int(shutil.disk_usage(path).free)
        except OSError:
            return 0

    def confirm_dialog(self, title_part: str, wait: float) -> bool:
        """Steams Dialog (Titel mit dem Spielnamen) nach vorn holen und Enter drücken. Nur wenn genau
        so ein Fenster da ist, sonst bleibt die Tastatur in Ruhe."""
        from .keys import bring_to_front, find_window, press

        end = time.monotonic() + wait
        while time.monotonic() < end:
            hwnd = find_window(("steamwebhelper.exe", "steam.exe"), hint=title_part, dialogs=True)
            if hwnd:
                if not bring_to_front(hwnd):
                    return False
                time.sleep(0.5)  # bis der Dialog Eingaben annimmt
                press("enter")
                return True
            time.sleep(0.3)
        return False

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


class Games:
    """Spiele auf diesem PC (Steam und Epic) und was Jarvis damit tun kann. say(text): Jarvis sagt etwas
    von sich aus (wenn ein Download wirklich losgeht)."""

    def __init__(self, cfg: dict | None = None, state_dir: Path | None = None, say=None, opener=None,
                 env: Env | None = None):
        section = (cfg or {}).get("spiele") or {}
        self.confirm = bool(section.get("steam_bestaetigen", True))
        self._dir = Path(state_dir) if state_dir else None
        self._say = say or (lambda text: None)
        self._opener = opener
        self.env = env or Env()
        self._lock = threading.Lock()
        self._scan: tuple[float, list[Game]] = (0.0, [])
        self._cache: dict | None = None

    def prewarm(self) -> None:
        """Bibliotheken schon beim Start einlesen, damit der erste Spielebefehl sofort geht."""
        threading.Thread(target=lambda: self.installed(fresh=True), name="jarvis-spiele-einlesen", daemon=True).start()

    # ------------------------------------------------------------------ Was ist da?

    def libraries(self) -> list[str]:
        """Alle Steam-Bibliotheken (Ordner), die es gibt. Leer: kein Steam."""
        root = self.env.steam_root()
        if root is None:
            return []
        paths = []
        for vdf in (Path(root) / "steamapps" / "libraryfolders.vdf", Path(root) / "config" / "libraryfolders.vdf"):
            try:
                data = parse_vdf(vdf.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            for entry in (data.get("libraryfolders") or {}).values():
                path = entry.get("path") if isinstance(entry, dict) else entry if isinstance(entry, str) else None
                if path:
                    paths.append(str(path))
            break
        # Die Registry sagt "c:/program files (x86)/steam", die Datei "C:\Program Files (x86)\Steam": ein Ordner
        found: dict[str, str] = {}
        for path in [*paths, str(root)]:
            key = os.path.normcase(os.path.normpath(path.replace("\\", "/")))
            if key not in found and (Path(path) / "steamapps").is_dir():
                found[key] = path
        return list(found.values())

    def installed(self, fresh: bool = False) -> list[Game]:
        """Installierte Spiele (auch die, die gerade laden). Höchstens alle 20 Sekunden neu eingelesen."""
        with self._lock:
            at, games = self._scan
            if not fresh and games and time.monotonic() - at < 20:
                return list(games)
        games = self._steam_games() + self._epic_games()
        with self._lock:
            self._scan = (time.monotonic(), games)
        return list(games)

    def _steam_games(self) -> list[Game]:
        games = []
        for library in self.libraries():
            for acf in sorted((Path(library) / "steamapps").glob("appmanifest_*.acf")):
                try:
                    state = parse_vdf(acf.read_text(encoding="utf-8", errors="replace")).get("appstate") or {}
                except OSError:
                    continue
                appid = str(state.get("appid") or acf.stem.removeprefix("appmanifest_"))
                try:
                    flags = int(state.get("stateflags") or 0)
                except ValueError:
                    flags = 0
                try:
                    size = int(state.get("sizeondisk") or 0)
                except ValueError:
                    size = 0
                name = str(state.get("name") or "").strip() or f"App {appid}"
                games.append(Game(name, "steam", appid, library, size, flags, tool=appid in TOOLS))
        return games

    def _epic_games(self) -> list[Game]:
        games = []
        folder = self.env.epic_manifests()
        try:
            items = sorted(folder.glob("*.item"))
        except OSError:
            return games
        for item in items:
            try:
                data = json.loads(item.read_text(encoding="utf-8", errors="replace"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or data.get("bIsIncompleteInstall"):
                continue
            name = str(data.get("DisplayName") or "").strip()
            app = str(data.get("AppName") or "").strip()
            categories = {str(c).lower() for c in data.get("AppCategories") or []}
            if categories & {"engines", "plugins"} or name.lower().startswith("unreal engine"):
                continue  # keine Spiele
            if name and app and data.get("bIsApplication", True) is not False:
                namespace = str(data.get("CatalogNamespace") or "").strip()
                item_id = str(data.get("CatalogItemId") or "").strip()
                full = f"{namespace}:{item_id}:{app}" if namespace and item_id else app
                games.append(Game(name, "epic", app, str(data.get("InstallLocation") or ""),
                                  int(data.get("InstallSize") or 0), launch_id=full))
        return games

    # ------------------------------------------------------------------ Namen

    @staticmethod
    def wanted(name: str) -> str:
        """Was mit dem gesagten Namen gemeint ist ("cs zwei" -> Counter-Strike 2)."""
        key = compact(name)
        return ALIASES.get(key, name.strip())

    @staticmethod
    def score(query: str, name: str) -> int:
        """Wie gut ein Spielname zum Gesagten passt: 3 genau, 2 Abkürzung, 1 fängt so an, 0 gar nicht."""
        q, n = compact(query), compact(name)
        if not q or not n:
            return 0
        if q == n:
            return 3
        if q == acronym(name) and len(q) >= 2:
            return 2
        if len(q) >= 4 and n.startswith(q):
            return 1
        return 0

    def find_installed(self, name: str) -> Game | None:
        want = self.wanted(name)
        best, best_score = None, 0
        for game in self.installed():
            if game.tool:
                continue
            score = max(self.score(name, game.name), self.score(want, game.name))
            if score > best_score:
                best, best_score = game, score
        return best

    def _load_cache(self) -> dict:
        if self._cache is None:
            self._cache = {"counterstrike2": {"id": "730", "name": "Counter-Strike 2"}}
            if self._dir is not None:
                try:
                    data = json.loads((self._dir / CACHE_FILE).read_text(encoding="utf-8"))
                    if isinstance(data, dict):
                        self._cache = {str(k): v for k, v in data.items() if isinstance(v, dict)}
                except (OSError, ValueError):
                    pass
        return self._cache

    def _remember(self, said: str, appid: str, name: str) -> None:
        cache = self._load_cache()
        cache[compact(said)] = {"id": appid, "name": name}
        if self._dir is None:
            return
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            (self._dir / CACHE_FILE).write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError as exc:
            log.debug("Spiele merken: %s", exc)

    def _get(self, url: str, timeout: float) -> bytes:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        opener = self._opener or urllib.request.urlopen
        with opener(request, timeout=timeout) as response:
            return response.read()

    def search(self, name: str, timeout: float = 4.0) -> list[tuple[str, str]]:
        """Spiele im Steam-Shop: [(AppID, Name)], das passendste zuerst."""
        url = STORE_SEARCH + "?" + urllib.parse.urlencode({"term": name, "l": "german", "cc": "DE"})
        data = json.loads(self._get(url, timeout).decode("utf-8", errors="replace"))
        found = [(str(i.get("id")), str(i.get("name") or "")) for i in data.get("items") or []
                 if isinstance(i, dict) and i.get("id") and str(i.get("type") or "app") == "app"]
        return sorted(found, key=lambda hit: -self.score(name, hit[1]))

    def resolve(self, name: str) -> tuple[str, str, bool] | None:
        """(AppID, Name, sicher) im Steam-Shop. sicher=False: nur ähnlich, lieber nachfragen.
        None: nichts gefunden. Wirft URLError/ValueError, wenn der Shop nicht erreichbar ist."""
        want = self.wanted(name)
        cache = self._load_cache()
        cached = cache.get(compact(name)) or cache.get(compact(want))
        if cached:
            return str(cached["id"]), str(cached["name"]), True
        hits = self.search(want)
        if not hits:
            return None
        appid, title = hits[0]
        sure = max(self.score(want, title), self.score(name, title)) >= 2 or (compact(want) != compact(name) and
                                                                              self.score(want, title) >= 1)
        if sure:
            self._remember(name, appid, title)
        return appid, title, sure

    def size_of(self, appid: str, timeout: float = 2.5) -> int:
        """Platzbedarf laut Steam-Shop (Bytes, 0 = unbekannt)."""
        url = APP_DETAILS + "?" + urllib.parse.urlencode({"appids": appid, "l": "german", "cc": "DE", "filters": "basic"})
        try:
            data = json.loads(self._get(url, timeout).decode("utf-8", errors="replace"))
        except Exception as exc:
            log.debug("Spielgröße %s: %s", appid, exc)
            return 0
        entry = (data or {}).get(str(appid)) or {}
        if not entry.get("success"):
            return 0
        req = (entry.get("data") or {}).get("pc_requirements") or {}
        if isinstance(req, dict):
            return parse_size(" ".join(str(req.get(k) or "") for k in ("minimum", "recommended")))
        return 0

    def best_library(self, libraries: list[str] | None = None) -> tuple[str, int] | None:
        """Die Bibliothek mit dem meisten freien Platz: (Ordner, freie Bytes)."""
        options = [(lib, self.env.free_bytes(lib)) for lib in (self.libraries() if libraries is None else libraries)]
        options = [o for o in options if o[1] > 0]
        if not options:
            return None
        return max(options, key=lambda o: o[1])

    # ------------------------------------------------------------------ Was Jarvis tut

    def install(self, name: str, offer=None) -> str | None:
        """Ein Spiel installieren. None = kein Spiel, das Jarvis findet (Claude soll es versuchen).
        offer(frage, aktion): Jarvis fragt nach ("Soll ich es starten?"), "Ja" führt aktion aus."""
        game = self.find_installed(name)
        if game is not None:
            if game.store == "steam" and game.needs_update:
                ask = "Soll ich die Steam-Downloads öffnen?"
                if offer:
                    offer(ask, self.start_updates)
                return f"{game.name} ist schon installiert, Sir, braucht aber ein Update. {ask}"
            if game.store == "steam" and game.downloading:
                return f"{game.name} lädt gerade herunter, Sir."
            ask = "Soll ich es starten?"
            if offer:
                offer(ask, lambda: self.launch(game.name) or "Das ging leider nicht, Sir.")
            return f"{game.name} ist schon installiert, Sir. {ask}"
        epic = EPIC_ONLY.get(compact(self.wanted(name))) or EPIC_ONLY.get(compact(name))
        if epic is not None:
            title, app = epic
            self.env.open_uri(f"com.epicgames.launcher://apps/{app}?action=install")
            return f"{title} kommt über den Epic-Launcher, Sir. Der Installationsdialog ist offen."
        if not self.libraries():
            return None  # kein Steam: Claude (oder winget) soll es versuchen
        try:
            found = self.resolve(name)
        except Exception as exc:
            log.info("Steam-Shop nicht erreichbar: %s", exc)
            return None
        if found is None:
            return None
        appid, title, sure = found
        if not sure:
            # Nur ähnlich ("Minecraft" -> Minecraft Dungeons, "Python" -> ein Lernspiel): kein Spiel raten.
            # Claude kennt auch Programme und Launcher außerhalb von Steam (winget).
            log.info("Spiel %r: bei Steam nur %r gefunden, Claude übernimmt", name, title)
            return None
        return self._install_steam(appid, title)

    def _install_steam(self, appid: str, title: str) -> str:
        steam_was_running = self.env.running(("steam.exe",))
        size_box: list[int] = []
        sizer = threading.Thread(target=lambda: size_box.append(self.size_of(appid)), name="jarvis-spielgroesse",
                                 daemon=True)
        sizer.start()
        libraries = self.libraries()
        before = {lib: (Path(lib) / "steamapps" / f"appmanifest_{appid}.acf").exists() for lib in libraries}
        self.env.open_uri(f"steam://install/{appid}")
        sizer.join(1.0)  # kurz auf die Größe warten, länger nicht (die Antwort soll sofort kommen)
        size = size_box[0] if size_box else 0
        best = self.best_library(libraries)
        # Nur eine Bibliothek: nichts zu wählen, Jarvis bestätigt selbst. Bei mehreren wählt Georg das Laufwerk.
        auto = self.confirm and len(libraries) == 1 and not (best and size and best[1] < size * 1.05)
        self._background(self._watch_install, appid, title, before, steam_was_running, auto)
        need = f" Es braucht etwa {gigabytes(size)}." if size else ""
        if best is None:
            return f"Sehr wohl, Sir. Der Steam-Dialog für {title} ist offen.{need}"
        library, free = best
        if size and free < size * 1.05:
            return (f"{title} braucht etwa {gigabytes(size)}, Sir, so viel Platz ist auf keinem Laufwerk frei. Am meisten "
                    f"hat {drive_name(library)} mit {gigabytes(free)}. Der Steam-Dialog ist offen.")
        if auto:
            return f"Sehr wohl, Sir. {title} wird installiert.{need}"
        return (f"Sehr wohl, Sir. Der Steam-Dialog für {title} ist offen. Nehmen Sie {drive_name(library)}, dort ist am "
                f"meisten Platz.{need}")

    def _background(self, target, *args) -> None:
        threading.Thread(target=target, args=args, name="jarvis-spiel-installieren", daemon=True).start()

    def _watch_install(self, appid: str, title: str, before: dict, steam_was_running: bool, auto: bool) -> None:
        """Bestätigt Steams Dialog (wenn es nichts zu wählen gibt) und sagt Bescheid, sobald der Download
        wirklich läuft, und wo."""
        try:
            confirmed = False
            if auto:
                confirmed = self.env.confirm_dialog(title, wait=6.0 if steam_was_running else 30.0)
            for _second in range(20 if confirmed else 180):
                for library in self.libraries():
                    manifest = Path(library) / "steamapps" / f"appmanifest_{appid}.acf"
                    if manifest.exists() and not before.get(library):
                        with self._lock:
                            self._scan = (0.0, [])
                        self._say(f"{title} lädt jetzt auf {drive_name(library)} herunter, Sir.")
                        return
                self.env.sleep(1.0)
            if confirmed:
                self._say(f"Der Steam-Dialog für {title} wartet noch, Sir. Bitte wählen Sie dort ein Laufwerk und "
                          "klicken auf Installieren.")
        except Exception as exc:
            log.info("Installation beobachten (%s): %s", title, exc)

    def launch(self, name: str) -> str | None:
        """Ein installiertes Spiel starten. None = kein passendes Spiel installiert."""
        game = self.find_installed(name)
        if game is None:
            return None
        if game.store == "epic":
            target = urllib.parse.quote(game.launch_id or game.id, safe="")
            self.env.open_uri(f"com.epicgames.launcher://apps/{target}?action=launch&silent=true")
        else:
            self.env.open_uri(f"steam://rungameid/{game.id}")
        extra = " Vorher kommt noch ein Update." if game.store == "steam" and game.needs_update else ""
        return f"{game.name} startet, Sir.{extra}"

    def uninstall(self, name: str) -> str | None:
        game = self.find_installed(name)
        if game is None:
            return None
        if game.store == "epic":
            self.env.open_uri("com.epicgames.launcher://store/library")
            return f"{game.name} entfernen Sie im Epic-Launcher unter Bibliothek, Sir. Er ist offen."
        self.env.open_uri(f"steam://uninstall/{game.id}")
        return f"Steam fragt gleich nach, ob {game.name} wirklich weg soll, Sir."

    def updates(self, offer=None) -> str:
        """"Welche Spiele brauchen Updates?" wie im Video: die Bibliotheken durchsehen und zusammenfassen."""
        games = self.installed(fresh=True)
        steam = [g for g in games if g.store == "steam"]
        epic = [g for g in games if g.store == "epic"]
        if not steam and not epic:
            return "Ich finde auf diesem PC keine Steam- oder Epic-Bibliothek, Sir."
        loading = [g.name for g in steam if g.downloading and not g.tool]
        pending = [g for g in steam if g.needs_update and not g.downloading]
        named = [g.name for g in pending if not g.tool]
        parts = ["Ich habe die Bibliotheken geprüft, Sir."]
        if named:
            listed = named + (["ein paar Steam-Zusatzpakete"] if any(g.tool for g in pending) else [])
            parts.append(f"{_join(listed)} hat ein Update." if len(listed) == 1 else f"{_join(listed)} haben Updates.")
        elif pending:
            parts.append("Nur ein paar Steam-Zusatzpakete haben Updates.")
        elif steam:
            real = [g for g in steam if not g.tool]
            if len(real) == 1:
                parts.append(f"{real[0].name} ist aktuell.")
            else:
                parts.append(f"Alle {len(real)} Steam-Spiele sind aktuell." if real else "Steam ist aktuell.")
        if loading:
            parts.append(f"Gerade lädt Steam: {_join(loading)}.")
        if epic:
            parts.append("Bei Epic Games prüft der Launcher die Updates selbst.")
        if pending:
            ask = "Soll ich die Steam-Downloads öffnen?"
            if offer:
                offer(ask, self.start_updates)
            parts.append(ask)
        return " ".join(parts)

    def start_updates(self) -> str:
        # Steam startet wartende Updates selbst (oder mit einem Klick dort). Ein Befehl von außen,
        # der nur das Update anstößt, gibt es nicht: darum die Downloads zeigen statt etwas zu versprechen.
        self.env.open_uri("steam://open/downloads")
        return "Die Steam-Downloads sind offen, Sir. Dort stehen die Updates an."

    def overview(self) -> str:
        games = [g for g in self.installed() if not g.tool]
        if not games:
            return "Ich finde auf diesem PC keine Spiele, Sir."
        names = sorted({g.name for g in games}, key=str.lower)
        shown = names[:6]
        more = f" und {len(names) - len(shown)} weitere" if len(names) > len(shown) else ""
        return f"Sie haben {len(names)} Spiele installiert, Sir: {_join(shown)}{more}."

    # ------------------------------------------------------------------ Sprache

    def command(self, text: str, offer=None) -> str | None:
        """Sätze nur über Spiele (Updates, Übersicht, Deinstallieren). Installieren und Starten kommen über
        die normalen Befehle ("Installiere ...", "Starte ...") und fragen dann hier nach."""
        norm = _norm(text)
        if _UPDATES.search(norm):
            return self.updates(offer)
        if _OVERVIEW.match(norm):
            return self.overview()
        gone = _UNINSTALL.match(norm)
        if gone:
            return self.uninstall(gone.group("name") or gone.group("name2"))
        return None


_UPDATES = re.compile(r"\b(?:welche|gibt es|brauchen|braucht|haben|hat|sind|check|prüf|prüfe|such)\b.*"
                      r"\b(?:spiele?|games?|steam)\b.*(?:\b(?:updates?|aktualisierungen?|aktualisieren)\b|\baktuell$)|"
                      r"\b(?:updates?|aktualisierungen?) (?:für|bei) (?:meine |die |den )?(?:spiele|games|steam)\b|"
                      r"^(?:spiele|games|steam)[ -]?updates?\b")
_OVERVIEW = re.compile(r"^(?:welche|was für|wie viele) (?:spiele|games) (?:habe|hab) ich(?: installiert| drauf)?$|"
                       r"^(?:zeig|nenn|sag)(?: mir)? (?:meine|alle) (?:spiele|games)$")
_UNINSTALL = re.compile(r"^(?:deinstalliere|deinstallier|deinstallieren) (?:das spiel )?(?P<name>.+?)(?: von steam)?$|"
                        r"^(?:lösch|lösche|entferne|entfern) das spiel (?P<name2>.+?)(?: von steam)?$")


def _norm(text: str) -> str:
    norm = " ".join(re.sub(r"[^\wäöüß -]+", " ", str(text or "").lower()).split())
    return re.sub(r"^(?:jarvis |hey jarvis )+", "", norm)


def is_command(text: str) -> bool:
    """Ein fertiger Spielebefehl? (Für die Vorab-Erkennung: dann legt Jarvis schon nach einer halben Sekunde los.)"""
    norm = _norm(text)
    return bool(_UPDATES.search(norm) or _OVERVIEW.match(norm) or _UNINSTALL.match(norm))


def _join(names: list[str]) -> str:
    names = [n for n in names if n]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " und " + names[-1]
