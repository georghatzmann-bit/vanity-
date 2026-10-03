"""Videos wirklich ansehen: herunterladen (yt-dlp), in Bilder zerlegen (PyAV) und den Ton mitschreiben
(faster-whisper). Alles läuft auf dem PC, ohne Abo.

Georg zum Video "Claude kann keine Videos gucken, er liest nur das Transkript": "Das musst du installieren, das
ist so wichtig." Claude und Jarvis' Gehirn bekommen deshalb Übersichtsbilder (je neun Szenen mit Zeitstempel) und
das Transkript mit Zeiten. Das spart Tokens: Ein Übersichtsbild kostet etwa so viel wie ein einzelnes Foto, ein
zehnminütiges Video sind so vier Bilder statt mehrerer hundert. Einzelbilder liegen daneben, falls Claude genauer
hinsehen muss.

python -m jarvis.video "<link oder datei>" [--bilder 36] [--ohne-ton]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

log = logging.getLogger(__name__)

MAX_FRAMES = 36  # vier Übersichtsbilder
PER_SHEET = 9
KEEP_DAYS = 14
MAX_DOWNLOAD = 900 * 1024 * 1024
FORMAT = "best[height<=720][ext=mp4]/best[height<=720]/best"  # eine Datei mit Ton, ohne FFmpeg zum Zusammenfügen
TRANSCRIPT_CHARS = 9000  # so viel Transkript zeigt die Ausgabe, der Rest steht in bericht.md
_URL = re.compile(r"^https?://", re.I)


class VideoError(RuntimeError):
    pass


def cache_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    return (Path(base) / "Jarvis" / "videos") if base else Path(tempfile.gettempdir()) / "jarvis-videos"


def clock(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))  # 0,96 s ist das Bild zu 0:01
    hours, rest = divmod(seconds, 3600)
    return (f"{hours}:" if hours else "") + f"{rest // 60:0{2 if hours else 1}d}:{rest % 60:02d}"


def frame_times(duration: float, wanted: int) -> list[float]:
    """Gleichmäßig über das Video verteilt, mindestens zwei Sekunden auseinander, nie ganz am Rand."""
    if duration <= 0:
        return [0.0]
    count = max(1, min(int(wanted), int(duration // 2) or 1))
    step = duration / count
    return [round(step * (k + 0.5), 2) for k in range(count)]


def _folder_for(source: str) -> Path:
    key = source
    if not _URL.match(source):
        path = Path(source).expanduser()
        try:
            key = f"{path.resolve()}|{path.stat().st_mtime_ns}"
        except OSError:
            pass
    return cache_dir() / hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def tidy(now: float | None = None) -> None:
    """Alte Videos wegräumen (sie liegen nur im Zwischenspeicher von Jarvis)."""
    root = cache_dir()
    limit = (now or time.time()) - KEEP_DAYS * 86400
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_dir() and not entry.is_symlink() and entry.stat().st_mtime < limit:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _python() -> str:
    """python.exe statt pythonw.exe (Jarvis läuft ohne Konsole): yt-dlp und pip brauchen eine Ausgabe."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        return str(exe.parent / "python.exe")
    return str(exe)


def _loader(args: list[str], timeout: float = 900):
    import subprocess

    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}  # Titel mit Umlauten und Emojis
    return subprocess.run([_python(), "-m", "yt_dlp", *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, env=env,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _install_loader(daily: bool) -> bool:
    """yt-dlp holen oder auf die neueste Fassung bringen. TikTok und YouTube ändern oft etwas, dann hilft meist das
    (als Nachbesserung höchstens einmal am Tag). Mit [default] kommt auch der Baustein für YouTube mit (yt-dlp-ejs)."""
    import subprocess

    mark = cache_dir() / "yt-dlp-aktualisiert"
    try:
        if daily and mark.is_file() and time.time() - mark.stat().st_mtime < 86400:
            return False
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.write_text(dt.date.today().isoformat(), encoding="utf-8")
        done = subprocess.run([_python(), "-m", "pip", "install", "--upgrade", "--disable-pip-version-check",
                               "--no-input", "yt-dlp[default]"], capture_output=True, text=True, timeout=600,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return done.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _program(name: str) -> str | None:
    """Ein Programm auf PATH oder dort, wo winget es verlinkt (gerade erst installiert: PATH ist dann noch alt)."""
    found = shutil.which(name)
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    for place in ([Path(local) / "Microsoft" / "WinGet" / "Links"] if local else []) + [Path.home() / ".deno" / "bin"]:
        for candidate in (place / f"{name}.exe", place / name):
            if candidate.is_file():
                return str(candidate)
    return None


def _runtimes() -> list[str]:
    """YouTube verlangt seit Ende 2025 ein JavaScript-Programm. yt-dlp nimmt von sich aus nur Deno, und nur von PATH:
    Node.js (oft schon da) und ein gerade installiertes Deno schalten wir dazu."""
    args = []
    deno = _program("deno")
    if deno and not shutil.which("deno"):
        args += ["--js-runtimes", f"deno:{deno}"]
    node = _program("node")
    if node:
        args += ["--js-runtimes", f"node:{node}"]
    return args


def download(url: str, folder: Path) -> tuple[Path, dict]:
    """Lädt das Video mit yt-dlp (TikTok, YouTube, Instagram und über tausend andere Seiten)."""
    import importlib.util

    if importlib.util.find_spec("yt_dlp") is None:
        _install_loader(daily=False)
        importlib.invalidate_caches()
        if importlib.util.find_spec("yt_dlp") is None:
            raise VideoError("yt-dlp fehlt und ließ sich nicht installieren (kein Internet?). Ein Jarvis-Update bringt "
                             "es mit.")
    folder.mkdir(parents=True, exist_ok=True)
    # Ein Kanal- oder Playlist-Link lädt nur das erste Video, nie alle
    args = ["--no-playlist", "--playlist-items", "1", "-f", FORMAT, "-o", str(folder / "video.%(ext)s"), "--max-filesize",
            str(MAX_DOWNLOAD), "--no-progress", "--no-warnings", "--dump-json", "--no-simulate", *_runtimes(), url]
    done = _loader(args)
    if done.returncode != 0 and _install_loader(daily=True):
        done = _loader(args)
    if done.returncode != 0:
        why = [line for line in (done.stderr or "").splitlines() if line.strip()]
        text = "Das Video ließ sich nicht laden: " + (why[-1][:300] if why else f"Code {done.returncode}")
        if re.search(r"youtu\.?be", url, re.I) and not _program("deno"):
            text += (" Für YouTube fehlt vermutlich Deno, ein kleines JavaScript-Programm (bei Jarvis: „Installiere "
                     "Deno“, sonst winget-ID DenoLand.Deno). Danach noch einmal versuchen.")
        raise VideoError(text)
    info: dict = {}
    for line in reversed((done.stdout or "").splitlines()):
        if line.strip().startswith("{"):
            try:
                info = json.loads(line)
                break
            except ValueError:
                continue
    files = sorted(p for p in folder.glob("video.*") if p.suffix not in (".part", ".json", ".ytdl"))
    if not files:
        raise VideoError("Das Video ließ sich nicht laden (keine Datei angekommen).")
    meta = {"titel": info.get("title") or "", "von": info.get("uploader") or info.get("channel") or "",
            "dauer": info.get("duration") or 0, "quelle": info.get("webpage_url") or url,
            "datum": info.get("upload_date") or "", "beschreibung": (info.get("description") or "")[:2000]}
    return files[0], meta


LONG_VIDEO = 180  # Sekunden: darüber springt Jarvis von Schlüsselbild zu Schlüsselbild statt alles zu entschlüsseln


def _sequential(container, stream, times: list[float]) -> list[tuple[float, object]]:
    """Kurze Videos: einmal durch, alle Kerne (im Test 48 Sekunden TikTok in 3,5 statt 33 Sekunden)."""
    base, picks, k = stream.time_base, [], 0
    for frame in container.decode(stream):
        at = float(frame.pts * base) if frame.pts is not None else 0.0
        while k < len(times) and at + 0.04 >= times[k]:
            picks.append((at, frame.to_image()))
            k += 1
        if k >= len(times):
            break
    return picks


def _by_keyframes(container, stream, times: list[float]) -> list[tuple[float, object]]:
    """Lange Videos: erst nur die Schlüsselbilder zählen (die liegen meist an Szenenwechseln), dann zu dem neben
    jedem Zeitpunkt springen und genau ein Bild entschlüsseln."""
    base = stream.time_base
    stream.codec_context.skip_frame = "NONKEY"
    keys = [float(f.pts * base) for f in container.decode(stream) if f.pts is not None]
    stream.codec_context.skip_frame = "DEFAULT"
    step = (times[1] - times[0]) if len(times) > 1 else 10.0
    wanted = []
    for target in times:
        near = min(keys, key=lambda key: abs(key - target)) if keys else None
        at = near if near is not None and abs(near - target) <= step / 2 else target
        if not wanted or at > wanted[-1] + 0.01:
            wanted.append(at)
    picks = []
    for target in wanted:
        try:
            container.seek(int(target / base), stream=stream, backward=True, any_frame=False)
        except Exception:  # manche Dateien lassen sich nicht anspringen: dann von vorn
            container.seek(0)
        for frame in container.decode(stream):
            at = float(frame.pts * base) if frame.pts is not None else target
            if at + 0.04 >= target:
                picks.append((at, frame.to_image()))
                break
    return picks


def grab_frames(video: Path, times: list[float], folder: Path, width: int = 960) -> list[tuple[float, Path]]:
    """Die Bilder zu den Zeitpunkten, verkleinert, als JPEG im Ordner bilder."""
    import av

    folder.mkdir(parents=True, exist_ok=True)
    with av.open(str(video)) as container:
        if not container.streams.video:
            raise VideoError("In der Datei ist kein Bild, nur Ton.")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        picks = (_by_keyframes if times and times[-1] > LONG_VIDEO else _sequential)(container, stream, times)
    found: list[tuple[float, Path]] = []
    for at, image in picks:
        if image.width > width:
            image = image.resize((width, max(1, round(image.height * width / image.width))))
        path = folder / f"bild_{len(found) + 1:03d}_{clock(at).replace(':', '-')}.jpg"
        image.convert("RGB").save(path, quality=82)
        found.append((at, path))
    return found


def sheets(frames: list[tuple[float, Path]], folder: Path, per: int = PER_SHEET) -> list[Path]:
    """Je neun Bilder mit Zeitstempel auf einem Übersichtsbild (3 x 3)."""
    from PIL import Image, ImageDraw

    out = []
    for number, start in enumerate(range(0, len(frames), per), 1):
        part = frames[start:start + per]
        with Image.open(part[0][1]) as first:
            aspect = first.height / first.width
        cell_w = 400 if aspect <= 1 else 260
        cell_h = round(cell_w * aspect)
        cols = 3
        rows = (len(part) + cols - 1) // cols
        label = 22
        sheet = Image.new("RGB", (cols * cell_w, rows * (cell_h + label)), (12, 14, 20))
        draw = ImageDraw.Draw(sheet)
        for k, (at, path) in enumerate(part):
            x, y = (k % cols) * cell_w, (k // cols) * (cell_h + label)
            with Image.open(path) as image:
                sheet.paste(image.convert("RGB").resize((cell_w, cell_h)), (x, y + label))
            draw.text((x + 6, y + 4), f"{clock(at)}  (Bild {start + k + 1})", fill=(255, 214, 102))
        path = folder / f"uebersicht_{number}.jpg"
        sheet.save(path, quality=80)
        out.append(path)
    return out


def audio_samples(video: Path):
    """Der Ton als 16 kHz mono (float32), so wie ihn Whisper erwartet. None, wenn das Video stumm ist."""
    import av
    import numpy as np

    with av.open(str(video)) as container:
        if not container.streams.audio:
            return None
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        chunks = []
        for frame in container.decode(container.streams.audio[0]):
            for part in resampler.resample(frame):
                chunks.append(part.to_ndarray().reshape(-1))
        try:
            for part in resampler.resample(None):  # den Rest aus dem Resampler holen
                chunks.append(part.to_ndarray().reshape(-1))
        except Exception:
            pass
    if not chunks:
        return None
    return np.concatenate(chunks).astype("float32") / 32768.0


def pieces(samples, rate: int = 16000, shortest: float = 12, longest: float = 28) -> list[tuple[int, int]]:
    """Den Ton in Stücke von 12 bis 28 Sekunden schneiden, jeweils an der leisesten Stelle (zwischen zwei Sätzen)."""
    import numpy as np

    frame = rate // 10
    total = len(samples)
    if total <= longest * rate:
        return [(0, total)]
    count = total // frame
    energy = np.sqrt(np.mean(np.square(samples[:count * frame].reshape(count, frame)), axis=1))
    cuts, pos = [0], 0
    while count - pos > longest * 10:
        low, high = pos + int(shortest * 10), pos + int(longest * 10)
        pos = low + int(np.argmin(energy[low:high]))
        cuts.append(pos)
    bounds = [c * frame for c in cuts] + [total]
    return list(zip(bounds[:-1], bounds[1:]))


def _parakeet():
    """Jarvis' eigene Spracherkennung (Parakeet), wenn sie da ist: kein zweites Modell nötig."""
    try:
        from .localvoice import ParakeetSpeechToText, installed

        return ParakeetSpeechToText() if installed()["stt"] else None
    except Exception as exc:
        log.debug("Parakeet für Videos: %s", exc)
        return None


def transcribe(video: Path, model: str = "small") -> tuple[list[dict], str]:
    """Der Ton als Text mit Zeiten. (Teile, Sprache); ohne Ton oder Erkennung leer. Erst Parakeet (ist bei Jarvis
    schon da), sonst Whisper (lädt beim ersten Mal das Modell)."""
    import numpy as np

    samples = audio_samples(video)
    if samples is None or not len(samples):
        return [], ""
    parakeet = _parakeet()
    if parakeet is not None:
        parts = []
        for start, end in pieces(samples):
            chunk = samples[start:end]
            if float(np.max(np.abs(chunk), initial=0.0)) < 0.01:
                continue  # Stille
            text = parakeet.transcribe(chunk).strip()
            if text:
                parts.append({"von": round(start / 16000, 1), "bis": round(end / 16000, 1), "text": text})
        return parts, ""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return [], ""
    try:
        whisper = WhisperModel(model, device="cpu", compute_type="int8", local_files_only=True)
    except Exception:
        whisper = WhisperModel(model, device="cpu", compute_type="int8")
    segments, info = whisper.transcribe(samples, beam_size=1, vad_filter=True, condition_on_previous_text=False)
    parts = [{"von": round(s.start, 1), "bis": round(s.end, 1), "text": s.text.strip()} for s in segments if s.text.strip()]
    return parts, getattr(info, "language", "") or ""


def watch(source: str, max_frames: int = MAX_FRAMES, with_sound: bool = True, model: str = "small",
          refresh: bool = False) -> dict:
    """Ein Video ansehen. Ergebnis mit Ordner, Übersichtsbildern, Einzelbildern und Transkript (bericht.md)."""
    source = str(source or "").strip().strip('"')
    if not source:
        raise VideoError("Welches Video? Ein Link oder eine Datei.")
    tidy()
    folder = _folder_for(source)
    saved = folder / "bericht.json"
    if saved.is_file() and not refresh:
        try:
            result = json.loads(saved.read_text(encoding="utf-8"))
            if result.get("bilder") and all(Path(p).is_file() for p in result["bilder"]) \
                    and result.get("mit_ton", False) >= with_sound and result.get("max_bilder") == max_frames:
                os.utime(folder)  # frisch gehalten, damit tidy() es nicht wegräumt
                return result
        except (OSError, ValueError):
            pass
    if _URL.match(source):
        video, meta = _downloaded(folder)
        if video is None or refresh:
            video, meta = download(source, folder)
            (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    else:
        video = Path(source).expanduser()
        if not video.is_file():
            raise VideoError(f"Die Datei gibt es nicht: {video}")
        folder.mkdir(parents=True, exist_ok=True)
        meta = {"titel": video.stem, "von": "", "dauer": 0, "quelle": str(video), "datum": "", "beschreibung": ""}
    duration = float(meta.get("dauer") or 0) or _duration(video)
    meta["dauer"] = round(duration, 1)
    pictures = folder / "bilder"
    shutil.rmtree(pictures, ignore_errors=True)
    frames = grab_frames(video, frame_times(duration, max_frames), pictures)
    if not frames:
        raise VideoError("Aus dem Video ließen sich keine Bilder holen.")
    overview = sheets(frames, folder)
    parts, language = transcribe(video, model) if with_sound else ([], "")
    result = {**meta, "ordner": str(folder), "datei": str(video), "bilder": [str(p) for p in overview],
              "einzelbilder": [{"zeit": clock(t), "datei": str(p)} for t, p in frames], "transkript": parts,
              "sprache": language, "mit_ton": bool(with_sound), "max_bilder": max_frames,
              "angesehen": dt.datetime.now().isoformat(timespec="minutes")}
    (folder / "bericht.md").write_text(report(result), encoding="utf-8")
    saved.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return result


def _downloaded(folder: Path) -> tuple[Path | None, dict]:
    """Schon geladen (zum Beispiel erst ohne Ton angesehen, jetzt mit): nicht noch einmal herunterladen."""
    try:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, {}
    files = sorted(p for p in folder.glob("video.*") if p.suffix not in (".part", ".json", ".ytdl"))
    return (files[0], meta) if files and isinstance(meta, dict) else (None, {})


def _duration(video: Path) -> float:
    import av

    with av.open(str(video)) as container:
        if container.duration:
            return container.duration / 1_000_000
        stream = container.streams.video[0] if container.streams.video else None
        if stream is not None and stream.duration:
            return float(stream.duration * stream.time_base)
    return 0.0


def transcript_text(parts: list[dict]) -> str:
    return "\n".join(f"[{clock(p['von'])}] {p['text']}" for p in parts)


def report(result: dict) -> str:
    lines = [f"# {result.get('titel') or 'Video'}", ""]
    for label, key in (("Von", "von"), ("Quelle", "quelle"), ("Datum", "datum")):
        if result.get(key):
            lines.append(f"- {label}: {result[key]}")
    lines.append(f"- Länge: {clock(result.get('dauer') or 0)}")
    if result.get("beschreibung"):
        lines += ["", "## Beschreibung", "", result["beschreibung"]]
    lines += ["", "## Übersichtsbilder", ""] + [f"- {p}" for p in result.get("bilder", [])]
    lines += ["", "## Transkript" + (f" ({result['sprache']})" if result.get("sprache") else ""), ""]
    lines.append(transcript_text(result.get("transkript") or []) or "(kein Ton oder nichts gesprochen)")
    return "\n".join(lines) + "\n"


def describe(result: dict) -> str:
    """Was Claude liest: wo die Bilder liegen und was gesagt wird."""
    head = [f"Video: {result.get('titel') or 'ohne Titel'}" + (f" von {result['von']}" if result.get("von") else ""),
            f"Länge {clock(result.get('dauer') or 0)}, {len(result.get('einzelbilder') or [])} Bilder auf "
            f"{len(result.get('bilder') or [])} Übersichtsbildern."]
    if result.get("beschreibung"):
        head.append("Beschreibung: " + " ".join(result["beschreibung"].split())[:500])
    head.append("Übersichtsbilder (der Reihe nach mit dem Read-Werkzeug ansehen, je neun Szenen mit Zeit):")
    head += [f"  {p}" for p in result.get("bilder") or []]
    head.append(f"Einzelbilder für Details: {Path(result['ordner']) / 'bilder'}")
    text = transcript_text(result.get("transkript") or [])
    if text:
        more = len(text) > TRANSCRIPT_CHARS
        head.append("Transkript" + (f" ({result['sprache']})" if result.get("sprache") else "") + ":")
        head.append(text[:TRANSCRIPT_CHARS] + (f"\n... (ganz in {Path(result['ordner']) / 'bericht.md'})" if more else ""))
    else:
        head.append("Transkript: kein Ton oder nichts gesprochen.")
    return "\n".join(head)


def main(argv: list[str] | None = None, cfg: dict | None = None, prog: str = "python -m jarvis.video") -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog=prog, description="Ein Video ansehen (Bilder und Ton).")
    parser.add_argument("quelle", help="Link (TikTok, YouTube, Instagram ...) oder Datei")
    parser.add_argument("--bilder", type=int, default=MAX_FRAMES, help="höchstens so viele Bilder (Standard 36)")
    parser.add_argument("--ohne-ton", action="store_true", help="kein Transkript (schneller)")
    parser.add_argument("--neu", action="store_true", help="nicht aus dem Zwischenspeicher")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # falsche Angaben: argparse hat schon erklärt, was fehlt
        return int(exc.code or 0)
    if cfg is None:
        try:
            from .config import load_config

            cfg = load_config()
        except Exception:
            cfg = {}
    model = str((cfg.get("stt") or {}).get("model") or "small")
    try:
        result = watch(args.quelle, max_frames=max(1, min(args.bilder, 120)), with_sound=not args.ohne_ton,
                       model=model, refresh=args.neu)
    except VideoError as exc:
        print(f"Nicht angesehen: {exc}")
        return 1
    except Exception as exc:  # kaputte Datei, voller Datenträger ...: lesbar für Claude statt Traceback
        log.debug("Video", exc_info=True)
        print(f"Nicht angesehen: {type(exc).__name__}: {exc}"[:500])
        return 1
    print(describe(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
