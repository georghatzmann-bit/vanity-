"""Blender für den Blueprint: finden, Aufträge ausführen (Fortschritt, Fehler, Abbruch, Grafikkarte -> Prozessor).

Mit echtem Blender (Umgebungsvariable JARVIS_TEST_BLENDER = Pfad zu blender) zusätzlich: Jedes Teil liegt in Blender
genau dort, wo es im Blueprint-Fenster (three.js) liegt, und Foto und .blend-Datei entstehen wirklich."""

import json
import os
import stat
import sys
import threading
import unittest
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
from unittest import mock

from jarvis import blender
from jarvis.blaupause import clean_part

posix_only = unittest.skipIf(sys.platform == "win32", "Der Test-Blender ist ein Python-Skript mit Shebang")

# Tut so, als wäre es Blender: liest den Auftrag, meldet Fortschritt wie Cycles, schreibt die Dateien.
FAKE = r'''#!@PYTHON@
import json, sys, time
job = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
mode = "@MODE@"
open(sys.argv[sys.argv.index("--") + 1] + ".gesehen", "w").write(" ".join(sys.argv[1:]))

def report(step, **data):
    print("JARVIS-BLENDER " + json.dumps(dict(schritt=step, **data)), flush=True)

if mode == "gpu-kaputt" and job.get("gpu"):
    print("Error: Failed to create CUDA context", flush=True)
    sys.exit(1)
if mode == "fehler":
    report("fehler", text="Das Modell hat keine Teile, die Blender bauen kann.")
    sys.exit(3)
device = "OPTIX (Test-GPU)" if job.get("gpu") else "CPU"
report("gebaut", teile=len(job["szene"].get("teile", [])), geraet=device)
if job.get("blend"):
    open(job["blend"], "wb").write(b"BLENDER-v402")
    report("gespeichert", blend=job["blend"])
if job.get("bild"):
    if mode == "blender5":  # Blender 5 schreibt den Fortschritt nicht mehr selbst, blender_szene.py meldet ihn
        report("kerne")
        for k in (1, 8, 16):
            report("fortschritt", prozent=round(k * 100 / 16), rest=float(16 - k))
            report("fortschritt", prozent=round(k * 100 / 16), rest=float(16 - k))
    for k in (1, 8, 16):
        if mode == "blender5":
            break
        print("Fra:1 Mem:12M | Time:00:01.00 | Remaining:00:%02d.00 | Mem:1M | Scene, ViewLayer | Sample %d/16"
              % (16 - k, k), flush=True)
        if mode == "langsam":
            time.sleep(0.4)
    open(job["bild"], "wb").write(b"\x89PNG Test")
    if job.get("vorschau"):
        open(job["vorschau"], "wb").write(b"\xff\xd8 Test")
    report("fertig", bild=job["bild"], geraet=device, sekunden=1.0)
'''


def fake_blender(folder: Path, mode: str = "ok") -> Path:
    path = folder / f"blender-{mode}"
    path.write_text(FAKE.replace("@PYTHON@", sys.executable).replace("@MODE@", mode), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


SCENE = {"name": "Drohne", "teile": [clean_part({"id": "rumpf", "form": "quader"})]}


class FindTest(unittest.TestCase):
    def test_setting_file_or_folder_comes_first(self):
        with TemporaryDirectory() as tmp:
            exe = Path(tmp) / ("blender.exe" if os.name == "nt" else "blender")
            exe.write_bytes(b"")
            self.assertEqual(blender.find_blender(str(exe)), exe)
            self.assertEqual(blender.find_blender(tmp), exe, "ein Ordner: blender darin")

    def test_nothing_found(self):
        with mock.patch("jarvis.blender.candidates", return_value=[Path("/gibt/es/nicht/blender")]):
            self.assertIsNone(blender.find_blender())

    def test_newest_installed_version_first(self):
        paths = [PureWindowsPath(r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe"),
                 PureWindowsPath(r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"),
                 PureWindowsPath(r"C:\Program Files\Blender Foundation\Blender 4.10\blender.exe")]
        ordered = sorted(paths, key=blender._version_key, reverse=True)
        self.assertEqual([blender._version_key(p) for p in ordered], [(5, 0), (4, 10), (4, 2)])

    def test_file_names_windows_likes(self):
        self.assertEqual(blender.file_name("Aufklärungsdrohne MK II"), "Aufklärungsdrohne MK II")
        self.assertEqual(blender.file_name('Helm: "Mark 42" <neu>?'), "Helm Mark 42 neu")
        self.assertEqual(blender.file_name(" .. "), "Blueprint")
        self.assertEqual(blender.file_name("x" * 200), "x" * 60)


@posix_only
class JobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.work = self.base / "arbeit"

    def test_photo_with_progress(self):
        steps = []
        photo = blender.render(fake_blender(self.base), SCENE, self.base / "Blaupausen", "Drohne", self.work,
                               on_progress=steps.append)
        self.assertTrue(photo.image.is_file())
        self.assertEqual(photo.image.parent, self.base / "Blaupausen" / "Fotos")
        self.assertTrue(photo.image.name.startswith("Drohne "))
        self.assertEqual(photo.preview, self.work / "blueprint-foto.jpg")
        self.assertEqual(photo.device, "OPTIX (Test-GPU)")
        self.assertEqual([s["prozent"] for s in steps], [6, 50, 100])
        self.assertEqual(steps[0]["rest"], 15.0)
        self.assertEqual(list(self.work.glob("blender-auftrag-*.json")), [], "der Auftrag wird aufgeräumt")

    def test_progress_from_blender_5(self):
        steps = []
        blender.render(fake_blender(self.base, "blender5"), SCENE, self.base, "Drohne", self.work, on_progress=steps.append)
        self.assertEqual(steps[0], {"prozent": None, "rest": None, "hinweis": "kerne"}, "erst die Rechenkerne")
        self.assertEqual([s["prozent"] for s in steps[1:]], [6, 50, 100], "jeder Stand einmal")
        self.assertEqual(steps[1]["rest"], 15.0)

    def test_graphics_card_trouble_falls_back_to_the_processor(self):
        photo = blender.render(fake_blender(self.base, "gpu-kaputt"), SCENE, self.base, "Drohne", self.work)
        self.assertEqual(photo.device, "CPU")
        self.assertTrue(photo.image.is_file())

    def test_blenders_reason_comes_through(self):
        with self.assertRaises(blender.BlenderError) as caught:
            blender.render(fake_blender(self.base, "fehler"), SCENE, self.base, "Drohne", self.work)
        self.assertIn("keine Teile", str(caught.exception))

    def test_stop_cancels_blender(self):
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        with self.assertRaises(blender.BlenderError) as caught:
            blender.render(fake_blender(self.base, "langsam"), SCENE, self.base, "Drohne", self.work, cancel=cancel)
        self.assertEqual(str(caught.exception), "abgebrochen")

    def test_blend_files_never_overwrite_each_other(self):
        exe = fake_blender(self.base)
        first = blender.make_blend(exe, SCENE, self.base, "Drohne", self.work)
        second = blender.make_blend(exe, SCENE, self.base, "Drohne", self.work)
        self.assertNotEqual(first, second)
        self.assertTrue(first.is_file() and second.is_file())
        self.assertEqual(first.parent, self.base / "Blender")

    def test_blender_runs_without_window_and_user_settings(self):
        blender.make_blend(fake_blender(self.base), SCENE, self.base, "Drohne", self.work)
        seen = next(self.work.glob("*.gesehen")).read_text()  # die Kommandozeile, die der Test-Blender bekam
        self.assertTrue(seen.startswith("-b --factory-startup --python-exit-code 3 --python "))
        self.assertIn(str(blender.SCRIPT), seen)


# Teile in allen Formen, gedreht und gestreckt. Erwartet: die Hüllquader aus three.js (blaupause.js, geometryFor
# und partMatrix), umgerechnet auf Blender (x, -z, y).
SAMPLER = [
    {"id": "box", "form": "quader", "masse": [0.6, 0.2, 0.35], "pos": [-1.8, 0.5, 0], "dreh": [30, 90, 15]},
    {"id": "rbox", "form": "quader", "masse": [0.5, 0.3, 0.2], "rundung": 0.05, "pos": [-0.6, 0.5, -0.3],
     "dreh": [120, 0, -45]},
    {"id": "kugel", "form": "kugel", "masse": [0.2], "pos": [0.6, 0.5, 0.4], "dreh": [30, 0, 0], "skala": [1.5, 0.5, 1]},
    {"id": "zyl", "form": "zylinder", "masse": [0.1, 0.2, 0.6], "pos": [1.8, 0.5, 0], "dreh": [0, 30, 0],
     "skala": [1.3, 0.8, 1.1]},
    {"id": "zyl0", "form": "zylinder", "masse": [0, 0.15, 0.3], "pos": [-1.8, 1.4, -0.3], "dreh": [120, 0, 30]},
    {"id": "kegel", "form": "kegel", "masse": [0.15, 0.5], "pos": [-0.6, 1.4, 0.4], "dreh": [120, 90, 0]},
    {"id": "ring", "form": "ring", "masse": [0.3, 0.04], "pos": [0.6, 1.4, -0.3], "dreh": [120, 30, -45],
     "skala": [1.3, 0.8, 1.1]},
    {"id": "kapsel", "form": "kapsel", "masse": [0.1, 0.4], "pos": [1.8, 1.4, -0.3], "dreh": [120, 0, 120],
     "skala": [1.3, 0.8, 1.1]},
    {"id": "dreh", "form": "drehkoerper", "profil": [[0, 0], [0.2, 0.05], [0.25, 0.3], [0.1, 0.5], [0, 0.55]],
     "pos": [-1.8, 2.3, 0.4], "dreh": [15, 30, 0]},
    {"id": "ext", "form": "extrusion", "umriss": [[-0.3, -0.1], [0.3, -0.1], [0.2, 0.2], [-0.25, 0.15]], "tiefe": 0.08,
     "pos": [-0.6, 2.3, 0], "dreh": [0, 120, 15]},
    {"id": "extl", "form": "extrusion", "umriss": [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]],
     "loecher": [[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]]], "tiefe": 0.05, "fase": 0.01,
     "pos": [0.6, 2.3, 0.4], "dreh": [0, 120, 30], "skala": [1.3, 0.8, 1.1]},
    {"id": "rohr", "form": "rohr", "pfad": [[0, 0, 0], [0.2, 0.3, 0.1], [0.4, 0.3, -0.2], [0.5, 0, 0]], "radius": 0.03,
     "pos": [1.8, 2.3, 0.4], "dreh": [120, 90, -45], "skala": [1.3, 0.8, 1.1]},
]
EXPECTED = {
    "box": [[-1.975, -0.283, 0.217], [-1.625, 0.283, 0.783]], "rbox": [[-0.862, 0.041, 0.301], [-0.338, 0.559, 0.699]],
    "kugel": [[0.3, -0.58, 0.368], [0.9, -0.22, 0.632]], "zyl": [[1.55, -0.23, 0.26], [2.05, 0.23, 0.74]],
    "zyl0": [[-1.875, 0.188, 1.33], [-1.595, 0.512, 1.6]], "kegel": [[-0.75, -0.617, 1.275], [-0.45, -0.108, 1.655]],
    "ring": [[0.277, 0.007, 1.096], [0.923, 0.593, 1.704]], "kapsel": [[1.566, 0.114, 1.248], [2.034, 0.486, 1.552]],
    "dreh": [[-2.05, -0.719, 2.297], [-1.55, -0.22, 2.831]], "ext": [[-0.792, -0.263, 2.126], [-0.425, 0.293, 2.545]],
    "extl": [[0.412, -0.692, 2.018], [0.788, -0.108, 2.582]], "rohr": [[1.548, -0.594, 2.271], [1.951, -0.218, 2.965]],
}

BBOX = r'''
import json, sys
sys.path.insert(0, sys.argv[sys.argv.index("--") + 1])
import blender_szene as bs
import bpy
scene = json.load(open(sys.argv[sys.argv.index("--") + 2], encoding="utf-8"))
bs.clear()
root, objects = bs.build(scene)
depsgraph = bpy.context.evaluated_depsgraph_get()
out = {}
for part, obj in zip(scene["teile"], objects):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    points = [obj.matrix_world @ v.co for v in mesh.vertices]
    evaluated.to_mesh_clear()
    out[part["id"]] = [[min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]]
print("BBOX " + json.dumps(out))
'''


@unittest.skipUnless(os.environ.get("JARVIS_TEST_BLENDER"), "nur mit echtem Blender (JARVIS_TEST_BLENDER=Pfad)")
class RealBlenderTest(unittest.TestCase):
    def setUp(self):
        self.exe = Path(os.environ["JARVIS_TEST_BLENDER"])
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def test_parts_sit_where_the_hologram_shows_them(self):
        import subprocess

        scene_file = self.base / "szene.json"
        scene_file.write_text(json.dumps({"name": "Probe", "teile": [clean_part(p) for p in SAMPLER]}), encoding="utf-8")
        script = self.base / "bbox.py"
        script.write_text(BBOX, encoding="utf-8")
        out = subprocess.run([str(self.exe), "-b", "--factory-startup", "--python", str(script), "--",
                              str(blender.SCRIPT.parent), str(scene_file)], capture_output=True, text=True, timeout=300)
        line = next(x for x in out.stdout.splitlines() if x.startswith("BBOX "))
        boxes = json.loads(line[5:])
        for pid, (low, high) in EXPECTED.items():
            with self.subTest(teil=pid):
                size = max(h - lo for lo, h in zip(low, high))
                worst = max(abs(a - b) for want, got in zip((low, high), boxes[pid]) for a, b in zip(want, got))
                self.assertLess(worst / size, 0.04, f"{pid}: {boxes[pid]} statt {[low, high]}")

    def test_photo_and_blend_file(self):
        scene = {"name": "Probe", "groesse_m": 0.5, "teile": [clean_part(p) for p in SAMPLER]}
        steps = []
        photo = blender.render(self.exe, scene, self.base, "Probe", self.base / "arbeit", on_progress=steps.append,
                               size=(160, 90), samples=4, seconds=60)
        self.assertGreater(photo.image.stat().st_size, 1000)
        self.assertEqual(photo.image.read_bytes()[:4], b"\x89PNG")
        self.assertEqual(photo.preview.read_bytes()[:2], b"\xff\xd8")
        self.assertTrue(steps and steps[-1]["prozent"] == 100)
        blend = blender.make_blend(self.exe, scene, self.base, "Probe", self.base / "arbeit")
        self.assertEqual(blend.read_bytes()[:2], b"\x28\xb5", "komprimiert (zstd)")


if __name__ == "__main__":
    unittest.main()
