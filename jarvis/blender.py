"""Blender für den Blueprint: "Render das" macht aus dem Modell ein Foto wie aus dem Fotostudio, "Öffne das in
Blender" legt eine .blend-Datei an und öffnet sie zum Weiterbauen.

Jarvis schreibt den Auftrag als JSON und startet Blender ohne Fenster mit blender_szene.py (das läuft in Blender
und baut jedes Teil aus seinen Maßen nach). Gerendert wird mit Cycles auf der Grafikkarte (OptiX, CUDA, HIP, oneAPI,
Metal), sonst auf dem Prozessor; klappt es auf der Grafikkarte nicht, gleich noch einmal auf dem Prozessor. Fotos
und .blend-Dateien liegen im Blaupausen-Ordner unter "Fotos" und "Blender".

Blender sucht Jarvis selbst: Einstellung [blaupause] blender_pfad, PATH, die üblichen Ordner (Programme, Steam),
die Dateizuordnung für .blend. Fehlt es, installiert der Blueprint es über winget (kostenlos, etwa 400 MB).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

SCRIPT = Path(__file__).with_name("blender_szene.py")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LINE = "JARVIS-BLENDER "
_SAMPLE = re.compile(r"\|\s*Sample (\d+)/(\d+)")
_REMAINING = re.compile(r"Remaining:\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)")
_VERSION = re.compile(r"(\d+)(?:\.(\d+))?")


class BlenderError(RuntimeError):
    pass


@dataclass
class Photo:
    image: Path  # PNG in voller Größe (zum Behalten)
    preview: Path | None  # JPEG fürs Fenster
    device: str
    seconds: float


# ---------------------------------------------------------------------- Blender finden


def _version_key(path: Path) -> tuple[int, int]:
    found = _VERSION.search(path.parent.name)
    return (int(found.group(1)), int(found.group(2) or 0)) if found else (0, 0)


def _registered() -> list[Path]:
    """Was Windows für .blend-Dateien startet (Installer und Microsoft Store tragen das ein)."""
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return []
    found = []
    for hive, sub in ((winreg.HKEY_CURRENT_USER, r"Software\Classes\blendfile\shell\open\command"),
                      (winreg.HKEY_CLASSES_ROOT, r"blendfile\shell\open\command")):
        try:
            with winreg.OpenKey(hive, sub) as key:
                command = str(winreg.QueryValueEx(key, "")[0])
        except OSError:
            continue
        exe = re.match(r'\s*"([^"]+)"|\s*(\S+)', command)
        if exe:
            path = Path(exe.group(1) or exe.group(2))
            found.append(path.with_name("blender.exe") if path.name.lower() == "blender-launcher.exe" else path)
    return found


def _steam() -> list[Path]:
    try:
        from .spiele import Env, parse_vdf
    except ImportError:
        return []
    root = Env().steam_root()
    if root is None:
        return []
    libraries = [Path(root)]
    try:
        data = parse_vdf((Path(root) / "steamapps" / "libraryfolders.vdf").read_text(encoding="utf-8", errors="replace"))
        for entry in (data.get("libraryfolders") or {}).values():
            path = entry.get("path") if isinstance(entry, dict) else None
            if path:
                libraries.append(Path(path))
    except OSError:
        pass
    return [lib / "steamapps" / "common" / "Blender" / "blender.exe" for lib in libraries]


def candidates(setting: str = "") -> list[Path]:
    """Wo Blender sein könnte, das Wahrscheinlichste zuerst."""
    out: list[Path] = []
    if setting:
        path = Path(os.path.expandvars(str(setting))).expanduser()
        out.append(path / ("blender.exe" if os.name == "nt" else "blender") if path.is_dir() else path)
    which = shutil.which("blender")
    if which:
        out.append(Path(which))
    if os.name == "nt":
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramW6432", ""),
                 os.environ.get("ProgramFiles(x86)", ""), str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs")]
        installed = []
        for root in dict.fromkeys(r for r in roots if r):
            try:
                installed += list((Path(root) / "Blender Foundation").glob("Blender*/blender.exe"))
            except OSError:
                continue
        out += sorted(installed, key=_version_key, reverse=True)
        out += _registered()
        out += _steam()
    else:
        out += [Path("/Applications/Blender.app/Contents/MacOS/Blender"), Path("/snap/bin/blender"),
                Path("/usr/bin/blender"), Path.home() / "blender" / "blender"]
    return out


def find_blender(setting: str = "") -> Path | None:
    for path in candidates(setting):
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def can_install() -> bool:
    """Fehlt Blender, installiert Jarvis es selbst: geht nur unter Windows (winget)."""
    return os.name == "nt"


def install() -> str:
    """Blender über winget installieren (wie "Installiere Blender"). Gibt Jarvis' Satz zurück."""
    from .apps import install as install_app

    return install_app("blender", timeout=1500)


# ---------------------------------------------------------------------- Blender arbeiten lassen


def _remaining(line: str) -> float | None:
    found = _REMAINING.search(line)
    if not found:
        return None
    return int(found.group(1) or 0) * 3600 + int(found.group(2)) * 60 + float(found.group(3))


def with_soft_meshes(scene: dict) -> dict:
    """Weiche Teile (Herz, Tiere, Figuren) rechnet Blender nicht selbst: Jarvis legt ihr Netz bei (weich.py)."""
    from . import weich

    parts = []
    for part in scene.get("teile") or []:
        if isinstance(part, dict) and part.get("form") == "weich" and "netz" not in part:
            try:
                net = weich.blender_mesh(part)
            except Exception as exc:  # ein kaputtes Teil hält das Bild nicht auf
                log.info("Weiches Teil %s: %s", part.get("id"), exc)
                net = None
            part = dict(part, netz=net) if net else part
        parts.append(part)
    return dict(scene, teile=parts)


def run_job(blender: Path, job: dict, work_dir: Path, on_progress: Callable[[dict], None] | None = None,
            cancel: threading.Event | None = None, timeout: float = 900) -> list[dict]:
    """Blender ohne Fenster mit blender_szene.py starten. Gibt die JARVIS-BLENDER-Meldungen zurück.
    on_progress bekommt beim Rendern {"prozent": 0..100, "rest": Sekunden oder None}, während Blender beim ersten
    Mal die Rechenkerne der Grafikkarte lädt {"prozent": None, "rest": None, "hinweis": "kerne"}."""
    work_dir.mkdir(parents=True, exist_ok=True)
    job = dict(job, szene=with_soft_meshes(job.get("szene") or {}))
    job_file = work_dir / f"blender-auftrag-{os.getpid()}-{threading.get_ident()}.json"
    job_file.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    cmd = [str(blender), "-b", "--factory-startup", "--python-exit-code", "3", "--python", str(SCRIPT), "--",
           str(job_file)]
    reports: list[dict] = []
    tail: list[str] = []
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    except OSError as exc:
        job_file.unlink(missing_ok=True)
        raise BlenderError(f"Blender startet nicht: {exc}") from None
    stopped = threading.Event()

    def watchdog() -> None:
        end = time.monotonic() + timeout
        while proc.poll() is None:
            if (cancel is not None and cancel.is_set()) or time.monotonic() > end:
                stopped.set()
                try:
                    proc.kill()
                except OSError:
                    pass
                return
            time.sleep(0.2)

    threading.Thread(target=watchdog, name="jarvis-blender-wache", daemon=True).start()
    last = -1

    def progress(step: dict) -> None:
        nonlocal last
        if on_progress is None or (step.get("prozent") is not None and step["prozent"] == last):
            return
        if step.get("prozent") is not None:
            last = step["prozent"]
        try:
            on_progress(step)
        except Exception as exc:
            log.debug("Blender, Fortschritt: %s", exc)

    try:
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.rstrip()
            if line.startswith(LINE):
                try:
                    report = json.loads(line[len(LINE):])
                except ValueError:
                    continue
                reports.append(report)
                if report.get("schritt") == "fortschritt":  # aus blender_szene.py (Blender 5 schreibt sonst nichts)
                    progress({"prozent": report.get("prozent"), "rest": report.get("rest")})
                elif report.get("schritt") == "kerne":  # beim ersten Mal auf der Grafikkarte: dauert
                    progress({"prozent": None, "rest": None, "hinweis": "kerne"})
                continue
            if line:
                tail.append(line)
                del tail[:-25]
            sample = _SAMPLE.search(line)  # Blender bis 4.x schreibt den Fortschritt selbst
            if sample:
                done, total = int(sample.group(1)), max(1, int(sample.group(2)))
                progress({"prozent": min(100, round(done * 100 / total)), "rest": _remaining(line)})
        code = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
        if proc.stdout is not None:
            proc.stdout.close()
        job_file.unlink(missing_ok=True)
    if stopped.is_set():
        if cancel is not None and cancel.is_set():
            raise BlenderError("abgebrochen")
        raise BlenderError("Blender hat zu lange gebraucht.")
    errors = [r.get("text") for r in reports if r.get("schritt") == "fehler" and r.get("text")]
    if errors:
        raise BlenderError(str(errors[-1]))
    if code != 0:
        # Die echte Ursache, nicht Warnungen wie "CUEW initialization failed: Error opening the library"
        reason = next((t for t in reversed(tail) if re.search(r"^Error:|\bERROR\b|Exception|Traceback|Fehler", t)
                       and "WARNING" not in t), "")
        raise BlenderError(reason[:200] or f"Blender endete mit Code {code}.")
    return reports


def _stamp() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H-%M-%S")


def _unique(path: Path) -> Path:
    """Gibt es die Datei schon (zweimal in derselben Sekunde), dann "Name (2).png"."""
    number = 2
    found = path
    while found.exists():
        found = path.with_name(f"{path.stem} ({number}){path.suffix}")
        number += 1
    return found


def file_name(name: str) -> str:
    """Ein Dateiname, den Windows mag: "Aufklärungsdrohne MK II" bleibt lesbar, <>:"/\\|?* fallen weg."""
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(name or ""))
    text = " ".join(text.split()).strip(" .")[:60].strip(" .")
    return text or "Blueprint"


def render(blender: Path, scene: dict, folder: Path, name: str, work_dir: Path,
           on_progress: Callable[[dict], None] | None = None, cancel: threading.Event | None = None,
           size: tuple[int, int] = (1600, 900), samples: int = 128, seconds: float = 150, gpu: bool = True,
           view: dict | None = None) -> Photo:
    """Ein Foto vom Modell: PNG in folder/Fotos, dazu ein JPEG fürs Fenster in work_dir. view = Blickwinkel aus dem
    Blueprint ({"azimut": Grad, "hoehe": Grad}), sonst schräg von vorne rechts."""
    photos = folder / "Fotos"
    photos.mkdir(parents=True, exist_ok=True)
    image = _unique(photos / f"{name} {_stamp()}.png")
    preview = work_dir / "blueprint-foto.jpg"
    job = {"szene": scene, "bild": str(image), "vorschau": str(preview), "breite": size[0], "hoehe": size[1],
           "samples": samples, "samples_cpu": 48, "sekunden": seconds, "gpu": gpu}
    if view:
        job["kamera"] = dict(view)
    started = time.monotonic()
    try:
        # Großzügig: Beim ersten Mal lädt Blender die Rechenkerne der Grafikkarte, das kann Minuten dauern
        reports = run_job(blender, job, work_dir, on_progress, cancel, timeout=seconds + 600)
    except BlenderError as exc:
        if not gpu or str(exc) == "abgebrochen" or "keine Teile" in str(exc):
            raise
        log.info("Blender auf der Grafikkarte ging nicht (%s), jetzt mit dem Prozessor", exc)
        job["gpu"] = False
        reports = run_job(blender, job, work_dir, on_progress, cancel, timeout=seconds + 240)
    if not image.is_file():
        raise BlenderError("Blender hat kein Bild gespeichert.")
    done = next((r for r in reversed(reports) if r.get("schritt") == "fertig"), {})
    return Photo(image, preview if preview.is_file() else None, str(done.get("geraet") or ""),
                 round(time.monotonic() - started, 1))


def make_blend(blender: Path, scene: dict, folder: Path, name: str, work_dir: Path,
               cancel: threading.Event | None = None, view: dict | None = None) -> Path:
    """Eine .blend-Datei mit Modell, Studio, Licht und Kamera (F12 rendert dasselbe Foto). Jedes Mal eine neue
    Datei mit Datum, damit nichts überschrieben wird, woran Georg in Blender weitergebaut hat."""
    target = folder / "Blender"
    target.mkdir(parents=True, exist_ok=True)
    path = _unique(target / f"{name} {_stamp()}.blend")
    job = {"szene": scene, "blend": str(path), "gpu": True}
    if view:
        job["kamera"] = dict(view)
    run_job(blender, job, work_dir, cancel=cancel, timeout=180)
    if not path.is_file():
        raise BlenderError("Blender hat die Datei nicht gespeichert.")
    return path


def open_blend(blender: Path, path: Path) -> None:
    """Blender mit Fenster öffnen (unter Windows über blender-launcher.exe, dann ohne schwarzes Konsolenfenster)."""
    launcher = blender.with_name("blender-launcher.exe")
    exe = launcher if os.name == "nt" and launcher.is_file() else blender
    subprocess.Popen([str(exe), str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, creationflags=NO_WINDOW, close_fds=True)
