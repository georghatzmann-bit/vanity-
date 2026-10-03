"""Videos ansehen: Bilder mit Zeitstempel auf Übersichtsbildern, Ton als Transkript, Zwischenspeicher, yt-dlp
(nachgestellt, ohne Internet) und der Befehl für Jarvis' Gehirn."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from fractions import Fraction
from pathlib import Path
from unittest import mock

import numpy as np

import tests.helpers  # noqa: F401
from jarvis import video

HAS_AV = importlib.util.find_spec("av") is not None and importlib.util.find_spec("PIL") is not None


def make_video(path: Path, seconds: int = 12, fps: int = 25, size=(160, 120), tone: bool = True) -> Path:
    """Ein kleines Testvideo: jede Sekunde eine andere Farbe, dazu ein Ton (440 Hz)."""
    import av

    width, height = size
    with av.open(str(path), "w") as out:
        picture = out.add_stream("mpeg4", rate=fps)
        picture.width, picture.height, picture.pix_fmt = width, height, "yuv420p"
        sound = out.add_stream("aac", rate=16000) if tone else None
        if sound is not None:
            sound.layout = "mono"
        for index in range(seconds * fps):
            image = np.zeros((height, width, 3), np.uint8)
            image[:, :, 0] = (index // fps) * 20 % 256
            image[:, : (index % fps) * width // fps, 1] = 200
            for packet in picture.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                out.mux(packet)
        for packet in picture.encode():
            out.mux(packet)
        if sound is not None:
            wave = (0.3 * np.sin(2 * np.pi * 440 * np.arange(seconds * 16000) / 16000)).astype(np.float32)
            for start in range(0, len(wave), 1024):
                frame = av.AudioFrame.from_ndarray(wave[start:start + 1024].reshape(1, -1), format="flt", layout="mono")
                frame.sample_rate, frame.pts, frame.time_base = 16000, start, Fraction(1, 16000)
                for packet in sound.encode(frame):
                    out.mux(packet)
            for packet in sound.encode():
                out.mux(packet)
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.tmp / "AppData")})
        patcher.start()
        self.addCleanup(patcher.stop)


class TimesTest(unittest.TestCase):
    def test_frames_spread_over_the_video(self):
        times = video.frame_times(48, 36)
        self.assertEqual(len(times), 24, "mindestens zwei Sekunden auseinander")
        self.assertEqual((times[0], times[-1]), (1.0, 47.0), "nie ganz am Rand")
        self.assertEqual(len(video.frame_times(22 * 60, 36)), 36)
        self.assertEqual(video.frame_times(1.5, 36), [0.75])
        self.assertEqual(video.frame_times(0, 36), [0.0])

    def test_clock(self):
        self.assertEqual([video.clock(s) for s in (0, 0.96, 41, 62, 3723)], ["0:00", "0:01", "0:41", "1:02", "1:02:03"])

    def test_sound_is_cut_between_sentences(self):
        rate = 16000
        loud = (0.5 * np.sin(np.arange(rate) / 3)).astype(np.float32)
        samples = np.concatenate([np.tile(loud, 20), np.zeros(rate // 2, np.float32), np.tile(loud, 25)])
        cuts = video.pieces(samples)
        self.assertEqual(cuts[0][0], 0)
        self.assertEqual(cuts[-1][1], len(samples))
        self.assertAlmostEqual(cuts[0][1] / rate, 20.0, delta=0.5, msg="an der Pause, nicht mitten im Satz")
        self.assertTrue(all(end - start <= 28 * rate for start, end in cuts))
        self.assertEqual(video.pieces(samples[:10 * rate]), [(0, 10 * rate)], "kurz: ein Stück")


@unittest.skipUnless(HAS_AV, "PyAV oder Pillow fehlt")
class WatchTest(Base):
    def test_a_file_becomes_sheets_frames_and_report(self):
        clip = make_video(self.tmp / "clip.mp4")
        result = video.watch(str(clip), with_sound=False)
        self.assertEqual([f["zeit"] for f in result["einzelbilder"]], ["0:01", "0:03", "0:05", "0:07", "0:09", "0:11"])
        self.assertEqual(len(result["bilder"]), 1, "bis neun Bilder: ein Übersichtsbild")
        self.assertTrue(all(Path(p).is_file() for p in result["bilder"]))
        self.assertTrue(str(result["ordner"]).startswith(str(self.tmp / "AppData" / "Jarvis" / "videos")))
        from PIL import Image

        with Image.open(result["bilder"][0]) as sheet:
            self.assertEqual(sheet.width, 3 * 400, "drei nebeneinander")
        said = video.describe(result)
        self.assertIn("Länge 0:12, 6 Bilder auf 1 Übersichtsbildern.", said)
        self.assertIn(result["bilder"][0], said)
        self.assertIn("Transkript: kein Ton oder nichts gesprochen.", said)
        self.assertIn("# clip", (Path(result["ordner"]) / "bericht.md").read_text(encoding="utf-8"))

    def test_long_videos_jump_from_keyframe_to_keyframe(self):
        clip = make_video(self.tmp / "lang.mp4", seconds=200, fps=2, size=(64, 48), tone=False)
        result = video.watch(str(clip), with_sound=False)
        stamps = [f["datei"] for f in result["einzelbilder"]]
        self.assertGreaterEqual(len(stamps), 30)
        self.assertEqual(len(result["bilder"]), 4, "36 Bilder auf vier Übersichtsbildern")
        self.assertEqual(stamps, sorted(stamps), "der Reihe nach")

    def test_second_look_comes_from_the_cache(self):
        clip = make_video(self.tmp / "clip.mp4", seconds=6)
        first = video.watch(str(clip), with_sound=False)
        with mock.patch.object(video, "grab_frames", side_effect=AssertionError("nicht noch einmal")):
            self.assertEqual(video.watch(str(clip), with_sound=False)["bilder"], first["bilder"])
        with mock.patch.object(video, "transcribe", return_value=([{"von": 0.0, "bis": 6.0, "text": "Hallo"}], "de")):
            with_sound = video.watch(str(clip))
        self.assertEqual(with_sound["transkript"][0]["text"], "Hallo", "mit Ton: neu angesehen")

    def test_sound_with_jarvis_own_speech_recognition(self):
        clip = make_video(self.tmp / "clip.mp4", seconds=40)
        heard = []

        class Parakeet:
            def transcribe(self, chunk):
                heard.append(len(chunk) / 16000)
                return "Moin Chef"

        with mock.patch.object(video, "_parakeet", return_value=Parakeet()):
            parts, language = video.transcribe(clip)
        self.assertGreaterEqual(len(heard), 2, "in Stücken, nicht 40 Sekunden am Stück")
        self.assertTrue(all(length <= 28.1 for length in heard))
        self.assertEqual(parts[0], {"von": 0.0, "bis": round(parts[0]["bis"], 1), "text": "Moin Chef"})
        self.assertAlmostEqual(parts[-1]["bis"], 40, delta=0.2)

    def test_silence_and_missing_sound(self):
        silent = make_video(self.tmp / "stumm.mp4", seconds=4, tone=False)
        self.assertEqual(video.transcribe(silent), ([], ""))
        with self.assertRaises(video.VideoError):
            video.watch(str(self.tmp / "gibt-es-nicht.mp4"))


@unittest.skipUnless(HAS_AV, "PyAV oder Pillow fehlt")
class DownloadTest(Base):
    URL = "https://vm.tiktok.com/ZGdCeHVmb/"

    def setUp(self):
        super().setUp()
        spec = importlib.util.find_spec
        # yt-dlp gilt als installiert (es läuft ja nur nachgestellt), und nie ein echtes pip im Test
        patcher = mock.patch("importlib.util.find_spec",
                             side_effect=lambda name, *a: object() if name == "yt_dlp" else spec(name, *a))
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_loader(self, calls, code=0, stderr=""):
        def run(args, timeout=900):
            calls.append(args)
            if code == 0:
                folder = Path(args[args.index("-o") + 1]).parent
                make_video(folder / "video.mp4", seconds=4)
            info = {"title": "Claude kann keine Videos gucken", "uploader": "jonas.ki", "duration": 4,
                    "webpage_url": "https://www.tiktok.com/@jonas.ki/video/1", "description": "Augen für Claude"}
            return subprocess.CompletedProcess(args, code, json.dumps(info) + "\n" if code == 0 else "", stderr)
        return run

    def test_a_link_is_loaded_with_yt_dlp(self):
        calls = []
        with mock.patch.object(video, "_loader", self.fake_loader(calls)), \
                mock.patch.object(video, "_install_loader", side_effect=AssertionError("kein pip")):
            result = video.watch(self.URL, with_sound=False)
        self.assertEqual(len(calls), 1)
        args = calls[0]
        self.assertEqual(args[-1], self.URL)
        self.assertIn("--no-playlist", args)
        self.assertEqual(args[args.index("--playlist-items") + 1], "1", "ein Kanal-Link lädt nicht alles")
        self.assertEqual(args[args.index("-f") + 1], video.FORMAT, "eine Datei mit Ton, ohne FFmpeg")
        self.assertEqual((result["titel"], result["von"]), ("Claude kann keine Videos gucken", "jonas.ki"))
        self.assertIn("Video: Claude kann keine Videos gucken von jonas.ki", video.describe(result))
        with mock.patch.object(video, "_loader", side_effect=AssertionError("schon geladen")), \
                mock.patch.object(video, "transcribe", return_value=([], "")):
            video.watch(self.URL)  # jetzt mit Ton: das Video liegt schon da

    def test_broken_download_updates_yt_dlp_once_and_explains(self):
        calls = []
        with mock.patch.object(video, "_loader", self.fake_loader(calls, 1, "ERROR: [TikTok] 1: Video not available")), \
                mock.patch.object(video, "_install_loader", return_value=True) as update:
            with self.assertRaises(video.VideoError) as caught:
                video.watch(self.URL)
        self.assertEqual(len(calls), 2, "nach dem Update noch einmal")
        update.assert_called_once_with(daily=True)
        self.assertIn("Video not available", str(caught.exception))
        with mock.patch.object(video, "_loader", self.fake_loader([], 1, "ERROR: [youtube] x: Requested format is not available")), \
                mock.patch.object(video, "_install_loader", return_value=False), \
                mock.patch.object(video, "_program", return_value=None):
            with self.assertRaises(video.VideoError) as caught:
                video.watch("https://www.youtube.com/watch?v=abc")
        self.assertIn("DenoLand.Deno", str(caught.exception))

    def test_missing_yt_dlp_is_installed_first(self):
        with mock.patch("importlib.util.find_spec", return_value=None), \
                mock.patch.object(video, "_install_loader", return_value=False) as install:
            with self.assertRaises(video.VideoError) as caught:
                video.download(self.URL, self.tmp / "x")
        install.assert_called_once_with(daily=False)
        self.assertIn("yt-dlp fehlt", str(caught.exception))

    def test_update_at_most_once_a_day(self):
        with mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            self.assertTrue(video._install_loader(daily=True))
            self.assertFalse(video._install_loader(daily=True), "heute schon")
            self.assertTrue(video._install_loader(daily=False), "fehlt es ganz: sofort")
        self.assertEqual(run.call_count, 2)
        self.assertIn("yt-dlp[default]", run.call_args[0][0])

    def test_javascript_for_youtube(self):
        links = self.tmp / "AppData" / "Microsoft" / "WinGet" / "Links"
        links.mkdir(parents=True)
        (links / "deno.exe").write_bytes(b"")
        with mock.patch.object(video.shutil, "which", return_value=None):
            self.assertEqual(video._runtimes(), ["--js-runtimes", f"deno:{links / 'deno.exe'}"],
                             "gerade mit winget installiert, PATH noch alt")
        with mock.patch.object(video.shutil, "which", side_effect=lambda name: "/usr/bin/node" if name == "node" else None), \
                mock.patch.object(video, "_program", side_effect=lambda name: "/usr/bin/node" if name == "node" else None):
            self.assertEqual(video._runtimes(), ["--js-runtimes", "node:/usr/bin/node"])


class TidyAndToolTest(Base):
    def test_old_videos_are_cleared(self):
        old, new = video.cache_dir() / "alt", video.cache_dir() / "neu"
        for folder in (old, new):
            folder.mkdir(parents=True)
            (folder / "video.mp4").write_bytes(b"x")
        past = time.time() - (video.KEEP_DAYS + 1) * 86400
        os.utime(old, (past, past))
        video.tidy()
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())

    def test_long_transcripts_point_to_the_report(self):
        result = {"titel": "Kurs", "dauer": 3600, "ordner": str(self.tmp), "bilder": [], "einzelbilder": [],
                  "transkript": [{"von": float(k), "bis": k + 1.0, "text": "Satz " * 20} for k in range(200)]}
        said = video.describe(result)
        self.assertLess(len(said), video.TRANSCRIPT_CHARS + 600)
        self.assertIn(str(self.tmp / "bericht.md"), said)

    def test_the_command_for_the_brain(self):
        from jarvis import tool

        out, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(tool, "load_config", return_value={"stt": {"model": "base"}}), redirect_stdout(out), \
                redirect_stderr(errors):
            self.assertEqual(tool.main(["video", str(self.tmp / "fehlt.mp4")]), 1)
            self.assertEqual(tool.main(["video"]), 2, "ohne Link")
        self.assertIn("Nicht angesehen: Die Datei gibt es nicht", out.getvalue())
        self.assertIn("python -m jarvis.tool video", errors.getvalue(), "argparse erklärt den richtigen Aufruf")
        if HAS_AV:
            clip = make_video(self.tmp / "clip.mp4", seconds=4)
            out = io.StringIO()
            with mock.patch.object(tool, "load_config", return_value={"stt": {"model": "base"}}), \
                    mock.patch.object(video, "transcribe", return_value=([], "")) as heard, redirect_stdout(out):
                self.assertEqual(tool.main(["video", str(clip), "--bilder", "4"]), 0)
            heard.assert_called_once()
            self.assertEqual(heard.call_args[0][1], "base", "das Modell aus [stt]")
            self.assertIn("Übersichtsbilder (der Reihe nach mit dem Read-Werkzeug ansehen", out.getvalue())


if __name__ == "__main__":
    unittest.main()
