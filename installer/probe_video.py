"""Windows-Prüfung: Videos ansehen (jarvis/video.py) mit dem, was der Installer mitbringt.

Jarvis' lokale Stimme spricht einen Satz, daraus wird ein kleines Video (Bilder mit wechselnder Farbe, der Satz als
Ton). Dann sieht es sich `python -m jarvis.tool video` an, wie es Jarvis' Gehirn tut. Geprüft:
- yt-dlp ist installiert, mit dem Baustein für YouTube (yt-dlp-ejs),
- Bilder und Übersichtsbild entstehen (PyAV und Pillow unter Windows),
- die Spracherkennung (Parakeet) hört den Satz wieder heraus.
Rückgabewert 0 = alles gut.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
from fractions import Fraction
from pathlib import Path

# Läuft aus dem Jarvis-Ordner (Push-Location im Workflow), das Skript liegt woanders
sys.path.insert(0, os.getcwd())

import numpy as np  # noqa: E402

SENTENCE = "Moin Chef, heute zeige ich dir zwei Werkzeuge für Claude."


def make_video(path: Path, speech: np.ndarray, rate: int) -> float:
    import av

    seconds = max(6, int(len(speech) / rate) + 2)
    with av.open(str(path), "w") as out:
        picture = out.add_stream("mpeg4", rate=25)
        picture.width, picture.height, picture.pix_fmt = 320, 240, "yuv420p"
        sound = out.add_stream("aac", rate=rate)
        sound.layout = "mono"
        for index in range(seconds * 25):
            image = np.zeros((240, 320, 3), np.uint8)
            image[:, :, (index // 25) % 3] = 180
            for packet in picture.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                out.mux(packet)
        for packet in picture.encode():
            out.mux(packet)
        wave = np.zeros(seconds * rate, np.float32)
        wave[rate // 2:rate // 2 + len(speech)] = speech.astype(np.float32) / 32768.0
        for start in range(0, len(wave), 1024):
            frame = av.AudioFrame.from_ndarray(wave[start:start + 1024].reshape(1, -1), format="flt", layout="mono")
            frame.sample_rate, frame.pts, frame.time_base = rate, start, Fraction(1, rate)
            for packet in sound.encode(frame):
                out.mux(packet)
        for packet in sound.encode():
            out.mux(packet)
    return seconds


def main() -> int:
    for module in ("yt_dlp", "yt_dlp_ejs", "av", "PIL"):
        if importlib.util.find_spec(module) is None:
            print(f"FEHLT: {module}")
            return 1
    done = subprocess.run([sys.executable, "-m", "yt_dlp", "--version"], capture_output=True, text=True, timeout=120)
    print("yt-dlp", done.stdout.strip(), "(Code", done.returncode, ")")
    if done.returncode != 0:
        return 1

    from jarvis.localvoice import PocketVoice

    started = time.monotonic()
    speech, rate = PocketVoice().synthesize(SENTENCE)
    print(f"Satz gesprochen: {len(speech) / rate:.1f} s in {time.monotonic() - started:.1f} s")
    folder = Path(tempfile.mkdtemp(prefix="jarvis-video-probe-"))
    clip = folder / "probe video äöü.mp4"
    seconds = make_video(clip, speech, rate)
    print(f"Testvideo: {seconds} s")

    started = time.monotonic()
    done = subprocess.run([sys.executable, "-m", "jarvis.tool", "video", str(clip)], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=900)
    took = time.monotonic() - started
    print(done.stdout[-3000:])
    if done.stderr.strip():
        print("stderr:", done.stderr[-2000:])
    print(f"Angesehen in {took:.1f} s, Code {done.returncode}")
    if done.returncode != 0 or "Übersichtsbilder" not in done.stdout:
        print("Das Video wurde nicht angesehen")
        return 1
    sheets = [line.strip() for line in done.stdout.splitlines() if line.strip().endswith(".jpg")]
    if not sheets or not all(Path(sheet).is_file() for sheet in sheets):
        print("Die Übersichtsbilder fehlen:", sheets)
        return 1
    heard = done.stdout.split("Transkript", 1)[-1].lower()  # nur das Gehörte, nicht "Read-Werkzeug" davor
    words = [word for word in ("chef", "werkzeug", "claude") if word in heard]
    print("Wiedererkannt:", words)
    if not words:  # eins reicht: "Claude" schreibt die Erkennung auch mal "Klod"
        print("Die Spracherkennung hat den Satz nicht herausgehört")
        return 1
    print("Video ansehen: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
