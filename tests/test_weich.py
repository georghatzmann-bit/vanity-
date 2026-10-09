"""Weiche Formen (Herz, Tiere, Figuren): Kugeln und Stäbe fließen ineinander, das Netz ist geschlossen und zeigt
nach außen. Dasselbe Netz bekommt Blender für "Render das"."""

import math
import unittest

import numpy as np

import tests.helpers  # noqa: F401
from jarvis import blender, weich
from jarvis.blaupause import clean_part

HEART = [[-0.28, 1.3, 0, 0.36], [0.28, 1.3, 0, 0.36], [0, 1.0, 0, 0.36], [0, 0.65, 0, 0.24], [0, 0.35, 0, 0.12]]


def check(test, made):
    verts, tris, normals = made
    edges = np.sort(np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    test.assertTrue((counts == 2).all(), "geschlossen: jede Kante gehört zu genau zwei Dreiecken")
    tri = verts[tris]
    face = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    test.assertGreater((np.einsum("ij,ij->i", face, normals[tris].mean(axis=1)) > 0).mean(), 0.999, "zeigt nach außen")
    return float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6)


class MeshTest(unittest.TestCase):
    def test_a_ball_is_a_ball(self):
        volume = check(self, weich.mesh([[0, 1, 0, 0.5]], k=0.1))
        self.assertAlmostEqual(volume, 4 / 3 * math.pi * 0.5 ** 3, delta=0.03)

    def test_balls_flow_into_each_other(self):
        apart = [[-0.3, 1, 0, 0.3], [0.3, 1, 0, 0.3]]
        hard = check(self, weich.mesh(apart, k=0.0))
        soft = check(self, weich.mesh(apart, k=0.3))
        self.assertGreater(soft, hard * 1.05, "weich gefüllt zwischen den Kugeln")
        far = check(self, weich.mesh([[-2, 1, 0, 0.3], [2, 1, 0, 0.3]], k=0.2))
        self.assertAlmostEqual(far, 2 * 4 / 3 * math.pi * 0.3 ** 3, delta=0.02, msg="weit weg: zwei Kugeln")

    def test_heart_and_rods(self):
        verts, _tris, _n = weich.mesh(HEART, k=0.25)
        check(self, (verts, _tris, _n))
        self.assertAlmostEqual(float(verts[:, 1].min()), 0.23, delta=0.03, msg="die Spitze unten")
        self.assertAlmostEqual(float(verts[:, 0].max()), 0.64, delta=0.03)
        arm, tris, normals = weich.mesh([], [[0, 0, 0, 1, 0, 0, 0.1]], k=0.1)
        check(self, (arm, tris, normals))
        self.assertAlmostEqual(float(arm[:, 0].min()), -0.1, delta=0.02)
        self.assertAlmostEqual(float(arm[:, 0].max()), 1.1, delta=0.02)
        self.assertIsNone(weich.mesh([], []))

    def test_for_blender(self):
        net = weich.blender_mesh({"kugeln": HEART, "glaette": 0.25}, resolution=32)
        self.assertTrue(all(isinstance(i, int) for face in net["flaechen"] for i in face))
        self.assertEqual(max(max(f) for f in net["flaechen"]) + 1, len(net["punkte"]))
        scene = {"name": "Herz", "teile": [clean_part({"id": "herz", "form": "weich", "kugeln": HEART}),
                                           clean_part({"id": "aorta", "form": "rohr", "pfad": [[0, 1, 0], [0, 2, 0]]}),
                                           {"id": "kaputt", "form": "weich", "kugeln": "quatsch"}]}
        sent = blender.with_soft_meshes(scene)
        self.assertIn("netz", sent["teile"][0])
        self.assertNotIn("netz", sent["teile"][1], "nur weiche Teile")
        self.assertNotIn("netz", sent["teile"][2], "kaputtes Teil: ohne Netz, kein Absturz")
        self.assertNotIn("netz", scene["teile"][0], "das Modell selbst bleibt, wie es ist")


if __name__ == "__main__":
    unittest.main()
