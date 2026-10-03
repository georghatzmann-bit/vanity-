"""Claude-Plugins: Georgs eigener Plugin-Marktplatz für sein Claude (Claude Code im Terminal und im Code-Bereich der
Claude-App), nicht für Jarvis.

Georg zu den Videos: "Adde das bitte alles als Plugins zu Claude, nicht zu Jarvis". Der Marktplatz "jarvis-plugins"
liegt im Jarvis-Ordner (.claude-plugin/marketplace.json, die Plugins unter claude-plugins/): Gedächtnis, Lernen,
Assistent, Körper, Geld und Video. Jarvis meldet ihn beim Start einmal bei Claude Code an und installiert die Plugins,
die Ordner für Körper, Assistent und Geld liegen im Notizbuch. Video nutzt Jarvis' eigenes Python (jarvis/video.py). Claude Code lädt Plugins aus einem lokalen Marktplatz
direkt aus dem Ordner, ein Jarvis-Update bringt neue Fassungen also von selbst mit.

Das offizielle "claude-code-setup" von Anthropic und die fremden Plugins aus den Videos (Everything Claude Code,
Task Observer, Claude Mem) kommen von GitHub. Das kann Claude Code nur mit Git, darum gibt es sie nur, wenn Git da
ist ("Installiere Git"). Jarvis' eigenes Gehirn lädt keins davon (--setting-sources project).

Graphify (Graphify Labs, Apache-2.0) ist kein Plugin, auch wenn das Video "/plugin, Link einfügen" sagt: Es ist ein
Programm mit Skill. Jarvis holt uv (winget), installiert damit die geprüfte Fassung und lässt `graphify install` den
Skill unter ~/.claude/skills/graphify anlegen. Danach baut `/graphify .` in Claude Code eine Karte des Projekts.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from .config import ROOT, STATE_DIR

log = logging.getLogger(__name__)

MARKETPLACE = "jarvis-plugins"
OWN = ("gedaechtnis", "lernen", "assistent", "koerper", "geld", "video")
NAMES = {"gedaechtnis": "Gedächtnis", "lernen": "Lernen", "assistent": "Assistent", "koerper": "Körper", "geld": "Geld",
         "video": "Video", "graphify": "Graphify",
         "claude-code-setup": "Claude Code Setup", "ecc": "Everything Claude Code", "task-observer": "Task Observer",
         "mem-thedotmack": "Claude Mem"}
FOLDERS = {"assistent": "Assistent", "koerper": "Körper", "geld": "Geld"}  # userConfig "ordner" im Notizbuch
OFFICIAL_MARKET = "claude-plugins-official"
OFFICIAL_SOURCE = "anthropics/claude-plugins-official"
OFFICIAL = ("claude-code-setup",)
EXTRAS = ("ecc", "task-observer", "mem-thedotmack")  # nur auf Wunsch: brauchen Node.js, Bash oder viel Kontext
GRAPHIFY_VERSION = "0.9.74"  # Paket graphifyy, geprüfter Stand vom 3.10.2026 (keine Telemetrie, Abfragen bleiben lokal)
UV_PACKAGE = "astral-sh.uv"
STATE_FILE = "claude-plugins.json"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# Einrichten beim Start, "Richte die Claude-Plugins ein" und das Nachholen nach Git laufen nacheinander:
# zwei gleichzeitige `claude plugin install` schreiben sonst in dieselben Einstellungen von Claude Code.
_SETUP_LOCK = threading.Lock()


def marketplace_root(root: Path | None = None) -> Path:
    return Path(root or ROOT)


def has_marketplace(root: Path | None = None) -> bool:
    return (marketplace_root(root) / ".claude-plugin" / "marketplace.json").is_file()


def skill_file(plugin: str, skill: str, root: Path | None = None) -> Path:
    return marketplace_root(root) / "claude-plugins" / plugin / "skills" / skill / "SKILL.md"


def photo_hint(cfg: dict, root: Path | None = None) -> str:
    """Für Fotos über Telegram: Essen kommt ins selbe Ernährungs-Tagebuch wie beim Claude-Plugin Körper. Eintragen
    macht jarvis.tool essen (ins Notizbuch schreibt bei Jarvis nur Python), die Richtwerte liegen beim Plugin."""
    guide = skill_file("koerper", "ernaehrung", root).parent
    tables = [guide / name for name in ("naehrwerte.md", "portionen.md") if (guide / name).is_file()]
    where = (" Richtwerte je 100 g und übliche Portionen stehen in " + " und ".join(str(t) for t in tables) +
             " (mit dem Read-Werkzeug lesen).") if tables else ""
    return ("Ist es eine Mahlzeit: jedes Lebensmittel einzeln erkennen (auch Soße, Öl, Getränk) und die Menge in Gramm "
            "schätzen." + where + ' Dann je Lebensmittel `python -m jarvis.tool essen "<Lebensmittel>" <Gramm> <kcal> '
            '<Eiweiß g> <Kohlenhydrate g> <Fett g>` aufrufen, die Werte für die ganze Menge. Die Ausgabe nennt die '
            "Tagessumme. Antworte kurz: was du erkannt hast, die Summe der Mahlzeit, der Tag bisher, und wo du unsicher "
            "bist.")


def jarvis_python() -> str:
    """Jarvis' eigenes Python für das Video-Plugin: python.exe, nicht pythonw.exe (Jarvis läuft ohne Konsole, Claude
    braucht aber die Ausgabe)."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        return str(exe.parent / "python.exe")
    return str(exe)


def _found(name: str, places: list[Path]) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for place in places:
        for candidate in (place / f"{name}.exe", place / name):
            if candidate.is_file():
                return str(candidate)
    return None


def find_uv() -> str | None:
    """uv auf PATH oder dort, wo winget und der uv-Installer es hinlegen (gerade installiert: PATH noch alt)."""
    local = os.environ.get("LOCALAPPDATA")
    places = [Path(local) / "Microsoft" / "WinGet" / "Links"] if local else []
    return _found("uv", places + [Path.home() / ".local" / "bin", Path.home() / ".cargo" / "bin"])


def find_graphify() -> str | None:
    """Das Programm graphify, das `uv tool install` in seinen Ordner für Programme legt (meist ~/.local/bin)."""
    return _found("graphify", [Path(os.environ.get("UV_TOOL_BIN_DIR") or Path.home() / ".local" / "bin")])


def graphify_skill() -> Path:
    """Wo `graphify install` den Skill für Claude Code anlegt (wie Graphify: CLAUDE_CONFIG_DIR zählt)."""
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config) if config else Path.home() / ".claude") / "skills" / "graphify" / "SKILL.md"


def find_git() -> str | None:
    """Git auf PATH oder an den üblichen Orten. Direkt nach "Installiere Git" kennt der laufende Jarvis den neuen PATH
    noch nicht, Claude Code bekommt den Ordner dann über _environment() mit."""
    found = shutil.which("git")
    if found:
        return found
    places = [os.environ.get(name) for name in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)")]
    local = os.environ.get("LOCALAPPDATA")
    candidates = [Path(base) / "Git" / "cmd" / "git.exe" for base in places if base]
    if local:
        candidates.append(Path(local) / "Programs" / "Git" / "cmd" / "git.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


class Plugins:
    """Meldet den Marktplatz an und installiert die Plugins über `claude plugin ...` (ohne Fenster, ohne Anmeldung)."""

    def __init__(self, cfg: dict, state_dir: Path | None = None, claude: str | None = None, root: Path | None = None,
                 runner=None, git: bool | None = None, tools=None, get_uv=None) -> None:
        self._cfg = cfg or {}
        self._state = Path(state_dir or STATE_DIR) / STATE_FILE
        self._root = marketplace_root(root)
        self._claude = claude
        self._run = runner or subprocess.run
        self._git = git
        self._tools = tools or subprocess.run  # uv und graphify (nicht claude)
        self._get_uv = get_uv or _install_uv

    # ------------------------------------------------------------------ Claude Code

    @property
    def claude(self) -> str | None:
        if self._claude is None:
            from .brain import find_claude

            self._claude = find_claude(self._cfg.get("brain") or {}) or ""
        return self._claude or None

    @property
    def git(self) -> bool:
        if self._git is None:
            self._git = bool(find_git())
        return self._git

    def _cli(self, *args: str, timeout: float = 180) -> dict:
        """Ein Aufruf von `claude plugin ...` mit --json. {"ok", "message", ...} (ok=False, wenn es nicht ging)."""
        claude = self.claude
        if not claude:
            return {"ok": False, "message": "Claude Code ist nicht installiert."}
        try:
            done = self._run([claude, "plugin", *args, "--json"], capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=timeout, creationflags=NO_WINDOW, env=_environment())
        except (OSError, subprocess.SubprocessError) as exc:
            return {"ok": False, "message": f"Claude Code ließ sich nicht starten ({type(exc).__name__})."}
        reply = _last_json(done.stdout)
        if isinstance(reply, dict):
            reply.setdefault("ok", reply.get("outcome") == "ok" and done.returncode == 0)
            return reply
        if isinstance(reply, list):
            return {"ok": done.returncode == 0, "items": reply}
        text = (done.stderr or done.stdout or "").strip().splitlines()
        return {"ok": done.returncode == 0, "message": text[-1] if text else ""}

    def installed(self) -> dict[str, bool]:
        """Installierte Plugins: "name@marktplatz" -> eingeschaltet."""
        reply = self._cli("list", timeout=60)
        out = {}
        for item in reply.get("items") or []:
            if isinstance(item, dict) and item.get("id"):
                out[str(item["id"])] = bool(item.get("enabled", True))
        return out

    def marketplaces(self) -> dict[str, dict]:
        reply = self._cli("marketplace", "list", timeout=60)
        return {str(m.get("name")): m for m in reply.get("items") or [] if isinstance(m, dict) and m.get("name")}

    # ------------------------------------------------------------------ Einrichten

    def _folder(self, plugin: str) -> str:
        from .notebook import folder_from_config

        return str(folder_from_config(self._cfg) / FOLDERS[plugin])

    def install(self, plugin: str, market: str = MARKETPLACE) -> dict:
        args = ["install", f"{plugin}@{market}", "--scope", "user"]
        if market == MARKETPLACE and plugin in FOLDERS:
            args += ["--config", f"ordner={self._folder(plugin)}"]
        if market == MARKETPLACE and plugin == "video":
            args += ["--config", f"python={jarvis_python()}", "--config", f"jarvis={self._root}"]
        return self._cli(*args)

    def setup(self, extras: tuple[str, ...] = ()) -> dict:
        """Marktplatz anmelden (oder auf den Jarvis-Ordner umstellen) und alles installieren. Doppelt schadet nicht."""
        with _SETUP_LOCK:
            result = {"ok": False, "installiert": [], "fehler": [], "ohne_git": [], "text": ""}
            if not self.claude:
                result["text"] = "Claude Code ist nicht installiert, Sir. Das richtet die Einrichtung ein."
                return result
            if not has_marketplace(self._root):
                result["text"] = "Die Plugins fehlen im Jarvis-Ordner, Sir. Ein Update von Jarvis bringt sie mit."
                return result
            added = self._cli("marketplace", "add", str(self._root))
            if not added.get("ok"):
                result["text"] = "Claude Code hat den Plugin-Marktplatz nicht angenommen: " + str(added.get("message", ""))[:200]
                return result
            for plugin in OWN:
                done = self.install(plugin)
                (result["installiert"] if done.get("ok") else result["fehler"]).append(plugin)
            github = [(OFFICIAL_MARKET, p) for p in OFFICIAL] + [(MARKETPLACE, p) for p in extras if p in EXTRAS]
            if github and not self.git:
                result["ohne_git"] = [p for _, p in github]
            elif github:
                if OFFICIAL and OFFICIAL_MARKET not in self.marketplaces():
                    self._cli("marketplace", "add", OFFICIAL_SOURCE, timeout=300)
                for market, plugin in github:
                    done = self.install(plugin, market)
                    (result["installiert"] if done.get("ok") else result["fehler"]).append(plugin)
            graph = self.graphify()
            (result["installiert"] if graph["ok"] else result["fehler"]).append("graphify")
            if not graph["ok"]:
                result["graphify"] = graph["text"]
            result["ok"] = not [p for p in result["fehler"] if p in OWN]
            result["text"] = summary(result)
            now = dt.datetime.now().isoformat(timespec="minutes")
            self._save({"root": str(self._root), "plugins": list(OWN), "ok": result["ok"], "zeit": now,
                        "installiert": result["installiert"], "ohne_git": result["ohne_git"],
                        "graphify": GRAPHIFY_VERSION if graph["ok"] else "",
                        "graphify_fehler": "" if graph["ok"] else GRAPHIFY_VERSION, "graphify_versuch": now})
            log.info("Claude-Plugins: %s", result["text"])
            return result

    def due(self) -> bool:
        """Beim Start: einrichten, wenn es noch nie lief, Jarvis umgezogen ist oder ein neues Plugin dazukam."""
        state = self._load()
        return not (state.get("ok") and state.get("root") == str(self._root)
                    and set(OWN) <= set(state.get("plugins") or []))

    def graphify_due(self) -> bool:
        """Graphify fehlt oder ist nicht die geprüfte Fassung. Ging es schief (kein Internet), erst am nächsten Tag
        wieder, sonst lädt Jarvis bei jedem Start erneut."""
        state = self._load()
        if state.get("graphify") == GRAPHIFY_VERSION and graphify_skill().is_file():
            return False
        if state.get("graphify_fehler") != GRAPHIFY_VERSION:  # noch nie, neue Fassung, oder der Skill ist weg
            return True
        try:
            last = dt.datetime.fromisoformat(str(state.get("graphify_versuch") or ""))
        except ValueError:
            return True
        return (dt.datetime.now() - last).total_seconds() > 86400

    def graphify(self) -> dict:
        """Graphify für Georgs Claude: uv (holt Jarvis mit winget, wenn es fehlt), damit die geprüfte Fassung, dann
        `graphify install` (Skill unter ~/.claude/skills/graphify und ein kurzer Eintrag in ~/.claude/CLAUDE.md)."""
        uv = find_uv() or self._get_uv()
        if not uv:
            return {"ok": False, "text": "uv fehlt und ließ sich nicht installieren"}
        done = self._tool(uv, "tool", "install", f"graphifyy=={GRAPHIFY_VERSION}", timeout=900)
        if done.returncode != 0:
            return {"ok": False, "text": "uv konnte Graphify nicht installieren: " + _last_line(done)}
        self._tool(uv, "tool", "update-shell", timeout=60)  # ~/.local/bin auf PATH (dort liegt meist auch claude)
        where = self._tool(uv, "tool", "dir", "--bin", timeout=60)
        folder = Path((where.stdout or "").strip().splitlines()[-1]) if where.returncode == 0 and where.stdout.strip() else None
        exe = (_found("graphify", [folder]) if folder else None) or find_graphify()
        if not exe:
            return {"ok": False, "text": "Graphify ist installiert, aber das Programm graphify fehlt"}
        done = self._tool(exe, "install", timeout=300)
        if done.returncode != 0 or not graphify_skill().is_file():
            return {"ok": False, "text": "graphify install hat nicht geklappt: " + _last_line(done)}
        return {"ok": True, "text": "Graphify ist eingerichtet"}

    def _tool(self, *cmd: str, timeout: float) -> subprocess.CompletedProcess:
        env = _environment()
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")  # graphify schreibt Sonderzeichen, Windows sonst cp1252
        try:
            return self._tools(list(cmd), capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=timeout, creationflags=NO_WINDOW, env=env)
        except (OSError, subprocess.SubprocessError) as exc:
            return subprocess.CompletedProcess(list(cmd), -1, "", f"{type(exc).__name__}: {exc}")

    def waiting_for_git(self) -> list[str]:
        """Was beim letzten Einrichten auf Git gewartet hat (offizielles Plugin, gewünschte fremde)."""
        return [str(p) for p in self._load().get("ohne_git") or []]

    def auto(self) -> dict | None:
        if not self.claude or not has_marketplace(self._root) or not (self.due() or self.graphify_due()):
            return None
        return self.setup()

    def status(self) -> dict:
        state = self._load()
        mine = self.installed() if self.claude else {}
        return {"claude": bool(self.claude), "git": self.git, "eingerichtet": bool(state.get("ok")),
                "zeit": state.get("zeit", ""),
                "plugins": [{"name": p, "titel": NAMES.get(p, p), "an": mine.get(f"{p}@{MARKETPLACE}"),
                             "installiert": f"{p}@{MARKETPLACE}" in mine} for p in OWN],
                "offiziell": [{"name": p, "titel": NAMES.get(p, p), "installiert": f"{p}@{OFFICIAL_MARKET}" in mine}
                              for p in OFFICIAL],
                "extras": [{"name": p, "titel": NAMES.get(p, p), "installiert": f"{p}@{MARKETPLACE}" in mine}
                           for p in EXTRAS],
                "graphify": {"installiert": graphify_skill().is_file(), "version": state.get("graphify", ""),
                             "uv": bool(find_uv())}}

    def _load(self) -> dict:
        try:
            data = json.loads(self._state.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        try:
            self._state.parent.mkdir(parents=True, exist_ok=True)
            self._state.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError as exc:
            log.debug("Claude-Plugins, Zustand: %s", exc)


_SETUP = re.compile(
    r"^(?:bitte )?(?:(?:richte|installier|installiere|aktualisier|aktualisiere|hol|hole)\s+(?:mir\s+)?(?:die\s+|meine\s+)?"
    r"(?:claude[- ]?plugins|plugins (?:für|fuer|von) claude)(?:\s+(?:ein|neu|nochmal))?|"
    r"(?:claude[- ]?plugins|plugins für claude) (?:einrichten|installieren|aktualisieren))$", re.I)
_EXTRA = re.compile(
    r"^(?:bitte )?(?:installier|installiere|hol|hole)\s+(?:mir\s+)?(?:auch\s+)?(?:das\s+plugin\s+)?"
    r"(?P<name>everything claude code|ecc|task observer|claude mem|graphify|graph[iy] ?f[iy]|grafify|"
    r"alle (?:claude[- ]?)?plugins(?: aus den videos)?)"
    r"(?:\s+(?:für|fuer|in) claude)?$", re.I)


def match_command(text: str) -> tuple[str, ...] | None:
    """"Richte die Claude-Plugins ein" -> (); "Installiere Everything Claude Code" -> ("ecc",); sonst None."""
    raw = " ".join(str(text or "").split()).strip(" .!?")
    raw = re.sub(r"^(?:hey |hallo |ok |okay )?jarvis[, ]+", "", raw, flags=re.I)
    if _SETUP.match(raw):
        return ()
    found = _EXTRA.match(raw)
    if not found:
        return None
    name = found.group("name").lower()
    if name.startswith("alle"):
        return EXTRAS
    if name.startswith(("graph", "graf")):
        return ("graphify",)
    return ({"everything claude code": "ecc", "ecc": "ecc", "task observer": "task-observer",
             "claude mem": "mem-thedotmack"}[name],)


def summary(result: dict) -> str:
    own = [NAMES[p] for p in OWN if p in result.get("installiert", [])]
    others = [NAMES.get(p, p) for p in result.get("installiert", []) if p not in OWN]
    parts = []
    if own:
        parts.append("Claude hat jetzt " + _join(own) + ".")
    if others:
        parts.append("Dazu " + _join(others) + ".")
    if result.get("fehler"):
        names = [NAMES.get(p, p) + (f" ({result['graphify']})" if p == "graphify" and result.get("graphify") else "")
                 for p in result["fehler"]]
        parts.append("Nicht geklappt: " + _join(names) + ".")
    if result.get("ohne_git"):
        names = [NAMES.get(p, p) for p in result["ohne_git"]]
        parts.append(_join(names) + (" braucht" if len(names) == 1 else " brauchen") + " Git, das fehlt noch. "
                     "Sagen Sie „Installiere Git“, dann kommt das gleich hinterher.")
    return " ".join(parts) or "Nichts zu tun."


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " und " + items[-1]


def _last_json(text: str):
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith(("{", "[")):
            try:
                return json.loads(line)
            except ValueError:
                continue
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _last_line(done: subprocess.CompletedProcess) -> str:
    lines = [line.strip() for line in ((done.stderr or "") + "\n" + (done.stdout or "")).splitlines() if line.strip()]
    return (lines[-1] if lines else f"Code {done.returncode}")[:200]


def _install_uv() -> str | None:
    """uv mit winget, nur für Georg (ohne Administratorrechte), wie "Installiere uv"."""
    from . import apps

    try:
        apps.install(UV_PACKAGE, timeout=600)
    except Exception as exc:
        log.info("uv für Graphify: %s", exc)
    return find_uv()


def _environment() -> dict:
    """Wie ein normales Terminal: ohne die Schalter, mit denen Jarvis sein eigenes Gehirn abschottet."""
    env = dict(os.environ)
    env.pop("CLAUDE_CODE_DISABLE_CLAUDE_MDS", None)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    git = find_git()
    if git and not shutil.which("git"):
        env["PATH"] = str(Path(git).parent) + os.pathsep + env.get("PATH", "")
    return env


def main(argv: list[str] | None = None) -> int:
    """python -m jarvis.claude_plugins [einrichten|status] [ecc task-observer mem-thedotmack]"""
    from .config import load_config

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = list(sys.argv[1:] if argv is None else argv)
    action = args[0] if args else "einrichten"
    plugins = Plugins(load_config())
    if action == "status":
        print(json.dumps(plugins.status(), ensure_ascii=False, indent=1))
        return 0
    result = plugins.setup(extras=tuple(a for a in args[1:] if a in EXTRAS))
    print(result["text"])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
