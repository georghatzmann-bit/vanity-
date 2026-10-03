"""Stream-Modus wie im Video "POV: you built Jarvis to run your life".

"Ich will streamen" oder "Ich streame gleich CS2": Jarvis stellt OBS auf die Spiel-Szene (und startet es dafür,
wenn es noch zu ist), prüft Mikrofon und Kamera, öffnet das Twitch-Dashboard und sagt in einem Satz, dass alles
bereit ist. Dazu, was auf Steam gerade angesagt ist ("Übrigens, Sir: ... ist gerade auf Platz 2 der Steam-
Bestseller"). "Geh live" startet den Stream in OBS, "Beende den Stream" hört auf. "Zeig mir den Trailer" spielt den
Trailer aus dem Steam-Shop im Jarvis-Fenster (sonst den ersten YouTube-Treffer). Alles ohne Claude, darum schnell.

OBS steuert Jarvis über den WebSocket-Server, der in OBS ab Version 28 eingebaut ist (Werkzeuge >
WebSocket-Server-Einstellungen). Ist OBS zu, startet Jarvis es gleich mit der richtigen Szene (--scene). Ist der
Server in OBS aus, aber mit Passwort eingerichtet (so legt OBS ihn an), schaltet Jarvis ihn vor dem Start ein.
Ohne Passwort lässt er ihn aus: Der Server hört im ganzen Netz, ohne Passwort könnte jeder OBS steuern.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import random
import re
import socket
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
TWITCH_DASHBOARD = "https://dashboard.twitch.tv/stream-manager"
FEATURED = "https://store.steampowered.com/api/featuredcategories?cc=de&l=german"
APP_DETAILS = "https://store.steampowered.com/api/appdetails"
STORE_SEARCH = "https://store.steampowered.com/api/storesearch/"
USER_AGENT = "Jarvis/2.0 (Stream-Modus)"
TREND_SECONDS = 60 * 60
# Keine Spiele: Hardware und Zubehör aus den Bestsellern
NOT_GAMES = re.compile(r"steam (?:deck|machine|controller|frame|link)|valve index|soundtrack|\bdlc\b|season pass", re.I)
# Woran man die Szene zum Spielen erkennt, und welche es sicher nicht ist
SCENE_WANTED = ("gameplay", "game", "ingame", "spiel", "zocken", "live", "main", "haupt", "stream")
SCENE_AVOID = ("start", "soon", "gleich", "pause", "brb", "break", "end", "ende", "outro", "intro", "afk", "warte",
               "chatting", "just chatting", "offline")


class ObsError(RuntimeError):
    pass


# ---------------------------------------------------------------------- OBS-WebSocket (Version 5, ohne Zusatzpaket)


class ObsClient:
    """Ein kleiner WebSocket-Client für OBS: verbinden, mit Passwort anmelden, Anfragen stellen."""

    def __init__(self, host: str = "127.0.0.1", port: int = 4455, password: str = "", timeout: float = 3.0,
                 connect: Callable | None = None) -> None:
        self.host, self.port, self.password, self.timeout = host, int(port), password or "", timeout
        self._connect = connect or socket.create_connection
        self._sock = None
        self._buffer = b""

    def __enter__(self) -> "ObsClient":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        try:
            self._sock = self._connect((self.host, self.port), self.timeout)
        except OSError as exc:
            raise ObsError("OBS antwortet nicht (WebSocket-Server aus?)") from exc
        try:
            self._handshake()
        except OSError as exc:
            self.close()
            raise ObsError("OBS hat die Verbindung unterbrochen.") from exc
        except BaseException:
            self.close()
            raise

    def _handshake(self) -> None:
        self._sock.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (f"GET / HTTP/1.1\r\nHost: {self.host}:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n")
        self._sock.sendall(request.encode("ascii"))
        head = self._read_until(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ObsError("OBS hat die Verbindung abgelehnt.")
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if expected not in head:
            raise ObsError("Unerwartete Antwort von OBS.")
        hello = self._recv_json()
        if hello.get("op") != 0:
            raise ObsError("OBS hat nicht gegrüßt.")
        identify = {"rpcVersion": 1, "eventSubscriptions": 0}
        auth = (hello.get("d") or {}).get("authentication")
        if auth:
            if not self.password:
                raise ObsError("OBS will ein Passwort.")
            secret = base64.b64encode(hashlib.sha256((self.password + auth["salt"]).encode()).digest()).decode()
            identify["authentication"] = base64.b64encode(hashlib.sha256((secret + auth["challenge"]).encode())
                                                          .digest()).decode()
        self._send_json({"op": 1, "d": identify})
        answer = self._recv_json()
        if answer.get("op") != 2:
            raise ObsError("OBS hat die Anmeldung nicht angenommen.")

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._send_frame(0x8, struct.pack("!H", 1000))
            except OSError:
                pass
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def request(self, kind: str, data: dict | None = None) -> dict:
        try:
            return self._request(kind, data)
        except OSError as exc:  # zum Beispiel WinError 10054, wenn OBS gerade zugeht
            raise ObsError("OBS hat die Verbindung unterbrochen.") from exc

    def _request(self, kind: str, data: dict | None) -> dict:
        rid = uuid.uuid4().hex
        self._send_json({"op": 6, "d": {"requestType": kind, "requestId": rid, "requestData": data or {}}})
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            message = self._recv_json()
            body = message.get("d") or {}
            if message.get("op") == 7 and body.get("requestId") == rid:
                status = body.get("requestStatus") or {}
                if not status.get("result"):
                    raise ObsError(str(status.get("comment") or f"OBS: {kind} ging nicht (Code {status.get('code')})"))
                return body.get("responseData") or {}
        raise ObsError("OBS hat nicht geantwortet.")

    # Rahmen nach RFC 6455: der Client maskiert, der Server nicht

    def _send_json(self, data: dict) -> None:
        self._send_frame(0x1, json.dumps(data).encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        head = bytearray([0x80 | opcode])
        size = len(payload)
        if size < 126:
            head.append(0x80 | size)
        elif size < 65536:
            head.append(0x80 | 126)
            head += struct.pack("!H", size)
        else:
            head.append(0x80 | 127)
            head += struct.pack("!Q", size)
        mask = os.urandom(4)
        head += mask
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(head) + body)

    def _read(self, count: int) -> bytes:
        while len(self._buffer) < count:
            try:
                chunk = self._sock.recv(65536)
            except socket.timeout as exc:
                raise ObsError("OBS hat nicht geantwortet.") from exc
            if not chunk:
                raise ObsError("OBS hat die Verbindung beendet.")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buffer:
            if len(self._buffer) > 65536:
                raise ObsError("Unerwartete Antwort von OBS.")
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ObsError("OBS hat die Verbindung beendet.")
            self._buffer += chunk
        head, self._buffer = self._buffer.split(marker, 1)
        return head + marker

    def _recv_json(self) -> dict:
        message = b""
        while True:
            first, second = self._read(2)
            opcode = first & 0x0F
            size = second & 0x7F
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if second & 0x80 else b""
            payload = self._read(size)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 0
                reason = {4009: "Das Passwort für OBS stimmt nicht."}.get(code, f"OBS hat beendet (Code {code}).")
                raise ObsError(reason)
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode in (0x1, 0x0):
                message += payload
                if first & 0x80:
                    try:
                        return json.loads(message.decode("utf-8"))
                    except ValueError as exc:
                        raise ObsError("OBS hat Unlesbares geschickt.") from exc


# ---------------------------------------------------------------------- Rechner (in Tests ersetzbar)


class Env:
    def appdata(self) -> Path:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")

    def obs_exe(self) -> Path | None:
        """obs64.exe: aus der Registry (Installationsordner), sonst an den üblichen Orten."""
        candidates = []
        if os.name == "nt":
            try:
                import winreg

                for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                    for sub in (r"SOFTWARE\OBS Studio", r"SOFTWARE\WOW6432Node\OBS Studio"):
                        try:
                            with winreg.OpenKey(root, sub) as key:
                                candidates.append(Path(winreg.QueryValueEx(key, "")[0]) / "bin" / "64bit" / "obs64.exe")
                        except OSError:
                            continue
            except ImportError:
                pass
        for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
            base = os.environ.get(var)
            if base:
                candidates.append(Path(base) / "obs-studio" / "bin" / "64bit" / "obs64.exe")
        return next((c for c in candidates if c.is_file()), None)

    def obs_running(self) -> bool:
        try:
            import psutil

            return any((p.info.get("name") or "").lower() in ("obs64.exe", "obs.exe", "obs")
                       for p in psutil.process_iter(["name"]))
        except Exception:
            return False

    def launch(self, exe: Path, args: list[str]) -> None:
        # OBS muss in seinem eigenen Ordner starten, sonst findet es seine Sprachdateien nicht
        subprocess.Popen([str(exe), *args], cwd=str(exe.parent), close_fds=True,
                         creationflags=DETACHED | NO_WINDOW if os.name == "nt" else 0)

    def open_url(self, url: str) -> None:
        if os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            import webbrowser

            webbrowser.open(url)

    def cameras(self) -> list[str] | None:
        """Angeschlossene Kameras (Namen), None = weiß nicht (kein Windows oder Fehler)."""
        if os.name != "nt":
            return None
        script = ("Get-PnpDevice -PresentOnly -Status OK -Class Camera,Image -ErrorAction SilentlyContinue | "
                  "Select-Object -ExpandProperty FriendlyName | ConvertTo-Json -Compress")
        try:
            done = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                                  capture_output=True, text=True, timeout=8, creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.debug("Kameras: %s", exc)
            return None
        text = (done.stdout or "").strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except ValueError:
            return None
        names = data if isinstance(data, list) else [data]
        return [str(n) for n in names if n]


# ---------------------------------------------------------------------- OBS-Einstellungen lesen


@dataclass
class ObsSetup:
    port: int = 4455
    password: str = ""
    enabled: bool = False
    auth: bool = True
    config: Path | None = None
    scenes: list[str] = field(default_factory=list)


def read_setup(appdata: Path) -> ObsSetup:
    """Was OBS gespeichert hat: WebSocket (Port, Passwort, an/aus) und die Szenen der aktuellen Sammlung."""
    setup = ObsSetup()
    folder = appdata / "obs-studio"
    config = folder / "plugin_config" / "obs-websocket" / "config.json"
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
        setup.config = config
        setup.port = int(data.get("server_port") or 4455)
        setup.password = str(data.get("server_password") or "")
        setup.enabled = bool(data.get("server_enabled"))
        setup.auth = bool(data.get("auth_required", True))
    except (OSError, ValueError, TypeError):
        pass
    # die Szenen der Sammlung, die OBS zuletzt offen hatte (user.ini ab OBS 31, global.ini davor)
    wanted = ""
    for ini in (folder / "user.ini", folder / "global.ini"):
        try:
            found = re.search(r"^SceneCollectionFile=(.+)$", ini.read_text(encoding="utf-8-sig", errors="replace"), re.M)
        except OSError:
            continue
        if found:
            wanted = found.group(1).strip()
            break
    scenes_dir = folder / "basic" / "scenes"
    files = sorted(scenes_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True) if scenes_dir.is_dir() else []
    pick = next((f for f in files if wanted and f.stem == wanted), files[0] if files else None)
    if pick is not None:
        try:
            data = json.loads(pick.read_text(encoding="utf-8"))
            setup.scenes = [str(s.get("name")) for s in data.get("scene_order") or [] if isinstance(s, dict) and s.get("name")]
        except (OSError, ValueError):
            pass
    return setup


def gameplay_scene(scenes: list[str], game: str = "") -> str:
    """Die Szene zum Spielen: eine mit dem Spiel im Namen, sonst "Gameplay" & Co., sonst die erste, die keine
    Warte-, Pausen- oder Endszene ist."""
    low = [(s, s.lower()) for s in scenes]
    if game:
        words = [w for w in re.split(r"\W+", game.lower()) if len(w) > 1]
        for name, l in low:
            if words and all(w in l for w in words):
                return name
    for word in SCENE_WANTED:
        for name, l in low:
            if word in l and not any(a in l for a in SCENE_AVOID):
                return name
    for name, l in low:
        if not any(a in l for a in SCENE_AVOID):
            return name
    return scenes[0] if scenes else ""


# ---------------------------------------------------------------------- Sätze

def _norm(text: str) -> str:
    text = re.sub(r"[.,!?;:\"„“]", " ", str(text or "").lower())
    text = re.sub(r"^\s*(?:hey |hallo |ok |okay )?jarvis\b", " ", text)
    return " ".join(text.split())


_PREPARE = re.compile(
    r"^(?:ich (?:will|möchte|werde|wollte|würde gern|würde gerne) (?:(?P<a>.+?) )?streamen|"
    r"ich streame(?: (?P<b>.+))?|"
    r"(?:mach|bereite|richte)(?: mir)? (?:den |alles für den |meinen )?stream (?:fertig|bereit|vor)|"
    r"stream (?:vorbereiten|fertig machen)|stream ?modus(?: an)?|(?:ich bin|wir sind) gleich live|"
    r"bereit (?:machen )?(?:zum|für den) streamen|lass uns (?:streamen|(?:den )?stream (?:vorbereiten|starten)))$")
_LIVE = re.compile(r"^(?:jetzt )?(?:(?:geh|gehen wir|wir gehen|lass uns)(?: jetzt)? live(?: gehen)?(?: auf twitch)?|"
                   r"(?:starte|start) (?:den |meinen )?stream|stream starten|live gehen)(?: jetzt)?(?: bitte)?$")
_END = re.compile(r"^(?:beende|stopp|stoppe|stop) (?:den |meinen )?stream$|^stream (?:beenden|stoppen|aus)$|"
                  r"^(?:geh|gehen wir) offline$")
_TRAILER = re.compile(r"^(?:zeig|zeige|spiel|spiele|öffne)(?: mir| uns)? (?:den |mal den )?(?:game |spiel |offiziellen )?trailer"
                      r"(?: (?:von|zu|zum|für|vom) (?P<game>.+?))?(?: an| ab)?$|"
                      r"^(?:zeig|zeige)(?: mir| uns)? (?:den |das )?(?P<game2>.+?)[ -]trailer$")
# "Ich will heute nicht streamen", "Ich streame morgen", "Ich streame gerade": jetzt nichts vorbereiten
_NOT_NOW = re.compile(r"\b(?:nicht|nie|niemals|kein|keine|keinen|morgen|übermorgen|später|nächste[nrs]?|wochenende|"
                      r"gerade|schon|bereits)\b")
# "Ich will einen Film streamen": Georg will etwas anschauen, nicht selbst senden
_WATCH = re.compile(r"\b(?:film|filme|filmen|serie|serien|folge|folgen|musik|song|songs|podcast|video|videos|netflix|"
                    r"disney|prime|youtube|spotify|fußball|bundesliga)\b")
_GAME_WORDS = re.compile(r"\b(?:gleich|jetzt|heute|abend|nachher|noch|mal|eigentlich|gern|gerne|auch|bald|endlich|wieder|"
                         r"lieber|ein bisschen|ein wenig|eine runde|eine partie|etwas|was)\b")


def wants_prepare(text: str) -> str | None:
    """"Ich will streamen" -> "", "Ich streame gleich CS2" -> "cs2", None = kein Stream-Satz."""
    found = _PREPARE.match(_norm(text))
    if not found:
        return None
    game = (found.group("a") or found.group("b") or "").strip()
    if _NOT_NOW.search(game) or _WATCH.search(game):
        return None
    return " ".join(_GAME_WORDS.sub(" ", game).split())


def wants_live(text: str) -> bool:
    return bool(_LIVE.match(_norm(text)))


def wants_end(text: str) -> bool:
    return bool(_END.match(_norm(text)))


def wants_trailer(text: str) -> str | None:
    """"Zeig mir den Trailer" -> "", "Zeig mir den Trailer von Crimson Desert" -> "crimson desert"."""
    found = _TRAILER.match(_norm(text))
    if not found:
        return None
    return (found.group("game") or found.group("game2") or "").strip()


# ---------------------------------------------------------------------- der Stream-Modus


class Stream:
    """Bereitet den Stream vor, geht live, zeigt Trailer. ui.trailer(...) öffnet den Trailer im Fenster."""

    def __init__(self, cfg: dict, assistant=None, ui=None, env: Env | None = None, opener=None,
                 client: Callable[..., ObsClient] | None = None, show_window: Callable[[], None] | None = None) -> None:
        section = cfg.get("stream", {}) or {}
        self.twitch = str(section.get("twitch", TWITCH_DASHBOARD) or TWITCH_DASHBOARD)
        self.scene = str(section.get("szene", "") or "")
        self.tips = bool(section.get("tipps", True))
        self._assistant = assistant
        self._ui = ui
        self._env = env or Env()
        self._opener = opener or urllib.request.urlopen
        self._client = client or ObsClient
        self._show_window = show_window
        self._trend: tuple[float, list[dict]] = (0.0, [])
        self.last_game: dict | None = None  # zuletzt erwähnt (für "Zeig mir den Trailer")
        self.live = False

    # ---------------------------------------------------------------- Netz

    def _get(self, url: str, timeout: float = 3.0) -> dict:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with self._opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))

    def trending(self) -> list[dict]:
        """Die Steam-Bestseller (nur Spiele), eine Stunde lang gemerkt: [{"id", "name", "platz"}]."""
        at, cached = self._trend
        if cached and time.monotonic() - at < TREND_SECONDS:
            return cached
        try:
            data = self._get(FEATURED)
        except Exception as exc:
            log.debug("Steam-Bestseller: %s", exc)
            return cached
        games, seen = [], set()
        for item in (data.get("top_sellers") or {}).get("items") or []:
            name = str(item.get("name") or "").strip()
            appid = item.get("id")
            if not name or not appid or item.get("type") not in (0, None) or NOT_GAMES.search(name) or appid in seen:
                continue
            seen.add(appid)
            games.append({"id": str(appid), "name": name, "platz": len(games) + 1})
        self._trend = (time.monotonic(), games)
        return games

    def _owned(self) -> set[str]:
        games = getattr(self._assistant, "games", None)
        try:
            return {re.sub(r"\W+", "", g.name.lower()) for g in games.installed()} if games is not None else set()
        except Exception:
            return set()

    def tip(self, playing: str = "") -> str:
        """"Übrigens, Sir: ..." mit einem angesagten Spiel, das Georg noch nicht hat (leer = keins)."""
        if not self.tips:
            return ""
        owned = self._owned()
        playing = re.sub(r"\W+", "", playing.lower())
        for game in self.trending()[:6]:
            key = re.sub(r"\W+", "", game["name"].lower())
            if key in owned or (playing and (playing in key or key in playing)):
                continue
            self.last_game = game
            place = "ganz oben" if game["platz"] == 1 else f"auf Platz {game['platz']}"
            return (f"Übrigens, Sir: {game['name']} ist gerade {place} der Steam-Bestseller. "
                    "Vielleicht etwas für einen der nächsten Streams.")
        return ""

    # ---------------------------------------------------------------- OBS

    def _obs(self, wanted_scene: str, game: str, start_streaming: bool = False) -> tuple[str, str]:
        """OBS auf die Szene stellen (und auf Wunsch gleich live gehen). (Satz, Szene)."""
        env = self._env
        setup = read_setup(env.appdata())
        scene = wanted_scene or gameplay_scene(setup.scenes, game)
        if env.obs_running():
            if not setup.enabled:
                return ("OBS läuft schon. Die Szene stelle ich um, sobald in OBS unter Werkzeuge, WebSocket-Server-"
                        "Einstellungen der Server an ist.", scene)
            try:
                with self._client("127.0.0.1", setup.port, setup.password) as obs:
                    if not scene:
                        scenes = [s.get("sceneName") for s in obs.request("GetSceneList").get("scenes") or []]
                        scene = gameplay_scene([s for s in reversed(scenes) if s], game)
                    if scene:
                        obs.request("SetCurrentProgramScene", {"sceneName": scene})
                    if start_streaming:
                        status = obs.request("GetStreamStatus")
                        if not status.get("outputActive"):
                            obs.request("StartStream")
            except ObsError as exc:
                log.info("OBS: %s", exc)
                return f"OBS hört gerade nicht auf mich: {exc}", scene
            return (f"Ihr OBS steht auf der Szene {scene}." if scene else "OBS ist bereit."), scene
        exe = env.obs_exe()
        if exe is None:
            return "OBS finde ich nicht. Sagen Sie „Installiere OBS“, dann richte ich es ein.", scene
        self._enable_socket(setup)
        args = ["--disable-shutdown-check"]
        if scene:
            args += ["--scene", scene]
        if start_streaming:
            args.append("--startstreaming")
        try:
            env.launch(exe, args)
        except OSError as exc:
            return f"OBS ließ sich nicht starten: {exc}", scene
        return (f"OBS startet auf der Szene {scene}." if scene else "OBS startet."), scene

    def _enable_socket(self, setup: ObsSetup) -> None:
        """Den WebSocket-Server von OBS einschalten, aber nur mit Passwort (er hört im ganzen Netz)."""
        if setup.config is None or setup.enabled or not setup.auth or not setup.password:
            return
        try:
            data = json.loads(setup.config.read_text(encoding="utf-8"))
            data["server_enabled"] = True
            setup.config.write_text(json.dumps(data, indent=4), encoding="utf-8")
            log.info("OBS: WebSocket-Server eingeschaltet (mit Passwort)")
        except (OSError, ValueError) as exc:
            log.debug("OBS-WebSocket einschalten: %s", exc)

    # ---------------------------------------------------------------- vorbereiten, live, Ende

    def prepare(self, game: str = "") -> str:
        """Alles für den Stream, gleichzeitig: OBS, Kamera, Twitch, ein Tipp. Ein Satz zurück."""
        results: dict = {}

        def cameras() -> None:
            results["kameras"] = self._env.cameras()

        def trend() -> None:
            results["tipp"] = self.tip(game)

        workers = [threading.Thread(target=cameras, daemon=True), threading.Thread(target=trend, daemon=True)]
        for w in workers:
            w.start()
        obs_line, _scene = self._obs(self.scene, game)
        try:
            self._env.open_url(self.twitch)
            twitch = "Ihr Twitch ist offen"
        except OSError as exc:
            log.info("Twitch: %s", exc)
            twitch = "Twitch ließ sich nicht öffnen"
        for w in workers:
            w.join(timeout=6)
        mic = str(getattr(self._assistant, "mic_name", "") or "")
        cams = results.get("kameras")
        if cams is None:
            devices = "Ihr Mikrofon ist verbunden" if mic else ""
        elif cams:
            devices = "Mikrofon und Kamera sind verbunden" if mic else "Die Kamera ist verbunden, ein Mikrofon finde ich nicht"
        else:
            devices = "Das Mikrofon ist verbunden, eine Kamera finde ich nicht" if mic else "Mikrofon und Kamera finde ich nicht"
        start = random.choice(["Verstanden, Sir, machen wir uns bereit.", "Sehr wohl, Sir. Alles für den Stream."])
        parts = [start, obs_line] + [p + "." for p in (devices, twitch) if p]
        parts.append("Sagen Sie Bescheid, wenn es live gehen soll, Sir.")
        tip = results.get("tipp") or ""
        if tip:
            parts.append(tip)
        zentrale = getattr(self._assistant, "zentrale", None)
        if zentrale is not None:
            zentrale.log("stream", "Stream vorbereitet" + (f": {game}" if game else ""))
        return " ".join(parts)

    def go_live(self) -> str:
        line, _scene = self._obs(self.scene, "", start_streaming=True)
        if line.startswith(("OBS finde", "OBS ließ", "OBS hört")):
            return line
        if "sobald" in line:
            return "OBS läuft, aber der WebSocket-Server ist aus. Drücken Sie in OBS auf Stream starten, Sir."
        if line.startswith("OBS startet"):
            self.live = True
            return "OBS startet und geht gleich live, Sir. Viel Erfolg."
        self.live = True
        zentrale = getattr(self._assistant, "zentrale", None)
        if zentrale is not None:
            zentrale.log("stream", "Live gegangen")
        return "Sie sind live, Sir. Viel Erfolg."

    def end(self) -> str:
        setup = read_setup(self._env.appdata())
        if not self._env.obs_running():
            return "OBS läuft gar nicht, Sir."
        try:
            with self._client("127.0.0.1", setup.port, setup.password) as obs:
                if obs.request("GetStreamStatus").get("outputActive"):
                    obs.request("StopStream")
        except ObsError as exc:
            return f"Das klappt gerade nicht: {exc} Beenden Sie den Stream bitte in OBS."
        self.live = False
        return "Der Stream ist beendet, Sir. Gut gemacht."

    # ---------------------------------------------------------------- Trailer

    def find_game(self, name: str) -> dict | None:
        url = STORE_SEARCH + "?" + urllib.parse.urlencode({"term": name, "l": "german", "cc": "DE"})
        try:
            data = self._get(url)
        except Exception as exc:
            log.debug("Steam-Suche: %s", exc)
            return None
        items = [i for i in data.get("items") or [] if isinstance(i, dict) and i.get("id")]
        return {"id": str(items[0]["id"]), "name": str(items[0].get("name") or name)} if items else None

    def trailer_url(self, appid: str) -> tuple[str, str]:
        """(HLS-Adresse des Trailers aus dem Steam-Shop, Vorschaubild), leer = keiner."""
        url = APP_DETAILS + "?" + urllib.parse.urlencode({"appids": appid, "l": "german", "cc": "DE"})
        try:
            data = (self._get(url).get(str(appid)) or {}).get("data") or {}
        except Exception as exc:
            log.debug("Steam-Trailer: %s", exc)
            return "", ""
        movies = [m for m in data.get("movies") or [] if isinstance(m, dict)]
        movies.sort(key=lambda m: not m.get("highlight"))
        for movie in movies:
            for key in ("hls_h264", "dash_h264"):
                link = str(movie.get(key) or "")
                if link.startswith("https://") and key == "hls_h264":
                    return link, str(movie.get("thumbnail") or "")
            mp4 = (movie.get("mp4") or {}).get("max") or (movie.get("webm") or {}).get("max")
            if isinstance(mp4, str) and mp4.startswith("https://"):
                return mp4, str(movie.get("thumbnail") or "")
        return "", ""

    def trailer(self, name: str = "") -> str:
        game = self.find_game(name) if name else self.last_game
        if game is None and not name:
            return "Von welchem Spiel, Sir?"
        title = game["name"] if game else name.title()
        link, poster = self.trailer_url(game["id"]) if game else ("", "")
        if link and self._ui is not None and hasattr(self._ui, "trailer"):
            self._ui.trailer({"titel": title, "url": link, "bild": poster})
            if self._show_window is not None and not getattr(self._assistant, "gaming", False):
                try:
                    self._show_window()
                except Exception as exc:
                    log.debug("Trailer, Fenster: %s", exc)
            return f"Sehr wohl, Sir. Der Trailer zu {title}."
        from . import web

        video = web.first_video(f"{title} trailer")
        target = web.video_url(video) if video else web.search_url("youtube", f"{title} trailer")[1]
        try:
            self._env.open_url(target)
        except OSError as exc:
            return f"Der Trailer ließ sich nicht öffnen: {exc}"
        return f"Sehr wohl, Sir. Der Trailer zu {title} läuft auf YouTube."

    # ---------------------------------------------------------------- Sätze

    def command(self, text: str) -> str | None:
        game = wants_prepare(text)
        if game is not None:
            return self.prepare(game)
        if wants_live(text):
            return self.go_live()
        if wants_end(text):
            return self.end()
        name = wants_trailer(text)
        if name is not None:
            return self.trailer(name)
        return None
