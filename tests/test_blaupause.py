"""Die Blaupause: 3D-Modelle als Hologramm, Befehle per Sprache, Claude zeichnet Teil für Teil."""

import base64
import json
import struct
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from jarvis.blaupause import MAX_PARTS, Blueprint, clean_part, parse_ops
from jarvis.brain import ClaudeBrain
from jarvis.config import load_config
from tests.helpers import RecordingUi, make_fake_claude

posix_only = unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")


def part(pid, form="quader", **extra):
    data = {"op": "teil", "id": pid, "name": pid.title(), "form": form, "masse": [0.2, 0.2, 0.2], "pos": [0, 0.5, 0]}
    data.update(extra)
    return data


def stl(triangles: int) -> str:
    data = b"Jarvis".ljust(80, b" ") + struct.pack("<I", triangles) + b"\0" * (50 * triangles)
    return base64.b64encode(data).decode("ascii")


class CleanTest(unittest.TestCase):
    def test_known_forms_and_limits(self):
        p = clean_part({"id": "Flügel Links!", "form": "box", "masse": [1, "x", 500], "pos": [0, 1e9, float("nan")],
                        "dreh": [0, 1000, 0], "farbe": "rot", "material": "plutonium", "skala": 2})
        self.assertEqual(p["id"], "fluegel_links")
        self.assertEqual(p["form"], "quader")
        self.assertEqual(p["masse"], [1.0, 0.5, 100.0], "unlesbare Zahl: Standard, zu groß: Grenze")
        self.assertEqual(p["pos"], [0.0, 100.0, 0.0])
        self.assertEqual(p["dreh"][1], 720.0)
        self.assertEqual(p["farbe"], "#e53935")
        self.assertEqual(p["material"], "metall")
        self.assertEqual(p["skala"], [2.0, 2.0, 2.0])
        self.assertEqual(clean_part({"form": "kugel", "farbe": "#ABC"})["farbe"], "#aabbcc")
        self.assertEqual(clean_part({"form": "kugel", "farbe": "url(javascript:x)"})["farbe"], "#7fd8ff")

    def test_special_forms_need_their_points(self):
        self.assertIsNone(clean_part({"form": "drehkoerper"}))
        self.assertIsNone(clean_part({"form": "extrusion", "umriss": [[0, 0], [1, 0]]}), "zwei Punkte sind keine Fläche")
        lathe = clean_part({"form": "lathe", "profil": [[-1, 0], [0.5, 1], [0.2, 2]]})
        self.assertEqual(lathe["profil"][0], [0.0, 0.0], "kein negativer Radius")
        tube = clean_part({"form": "rohr", "pfad": [[0, 0, 0], [1, 1, 1]], "radius": 99})
        self.assertEqual(tube["radius"], 10.0)
        self.assertIsNone(clean_part({"form": "teekanne"}))
        self.assertIsNone(clean_part("quader"))

    def test_soft_forms(self):
        """Georg: "die Modelle sehen so arsch aus". Herz, Tiere, Figuren als weiche Form statt aus Klötzen."""
        heart = clean_part({"id": "herz", "form": "blob", "kugeln": [[0, 1, 0, 0.3], [0.2, 1.2, 0, -1], [1, 2], "x"],
                            "staebe": [[0, 0, 0, 0, 1, 0, 0.1]], "glaette": 9})
        self.assertEqual(heart["form"], "weich")
        self.assertEqual(heart["kugeln"], [[0.0, 1.0, 0.0, 0.3], [0.2, 1.2, 0.0, 0.005]], "kein negativer Radius")
        self.assertEqual(heart["staebe"], [[0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.1]])
        self.assertEqual(heart["glaette"], 1.0)
        self.assertEqual(clean_part({"form": "weich", "kugeln": [[0, 1, 0, 0.3]]})["glaette"], 0.12)
        self.assertIsNone(clean_part({"form": "weich"}), "ohne Kugeln und Stäbe keine Form")
        many = clean_part({"form": "weich", "kugeln": [[0, i / 10, 0, 0.1] for i in range(100)]})
        self.assertEqual(len(many["kugeln"]), 32)

    def test_rounded_edges_and_cutouts(self):
        """Hochwertiger aussehende Modelle: abgerundete Kanten an Quadern, Aussparungen in Extrusionen."""
        box = clean_part({"form": "quader", "masse": [0.4, 0.06, 0.3], "rundung": 0.5})
        self.assertEqual(box["rundung"], 0.03, "höchstens halb so dick wie die dünnste Seite")
        self.assertNotIn("rundung", clean_part({"form": "quader", "rundung": "rund"}))
        plate = clean_part({"form": "extrusion", "umriss": [[0, 0], [1, 0], [1, 1], [0, 1]],
                            "loecher": [[[0.2, 0.2], [0.4, 0.2], [0.3, 0.4]], [[0, 0]], "quatsch"]})
        self.assertEqual(plate["loecher"], [[[0.2, 0.2], [0.4, 0.2], [0.3, 0.4]]], "nur echte Flächen")
        self.assertNotIn("loecher", clean_part({"form": "extrusion", "umriss": [[0, 0], [1, 0], [1, 1]], "loecher": {"a": 1}}))

    def test_parse_lines_arrays_and_whole_models(self):
        text = '```jsonl\n{"op":"neu","name":"A"}\nkein json\n{"op":"teil","form":"kugel"},\n```'
        self.assertEqual([o["op"] for o in parse_ops(text)], ["neu", "teil"])
        whole = json.dumps({"name": "Rakete", "teile": [{"form": "kegel"}, {"form": "zylinder"}]})
        self.assertEqual([o["op"] for o in parse_ops(whole)], ["neu", "teil", "teil"])
        self.assertEqual(len(list(parse_ops(json.dumps([{"op": "teil", "form": "kugel"}] * 3)))), 3)


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ui = RecordingUi()
        self.said = []
        self.bp = Blueprint({}, None, self.ui, Path(self.tmp.name), self.said.append)
        for op in ({"op": "neu", "name": "Drohne", "groesse_m": 0.4},
                   part("rumpf", gruppe="Rumpf", pos=[0, 0.5, 0]),
                   part("fluegel_links", gruppe="Flügel", pos=[-0.6, 0.5, 0], name="Flügel links"),
                   part("fluegel_rechts", gruppe="Flügel", pos=[0.6, 0.5, 0], name="Flügel rechts"),
                   part("antenne", "zylinder", masse=[0.01, 0.01, 0.3], pos=[0, 0.9, 0], name="Antenne")):
            self.bp.apply(op)

    def views(self):
        return [e[1] for e in self.ui.of("blueprint") if e[1]["action"] == "view"]

    def test_closed_blueprint_ignores_everything_but_opening(self):
        for said in ("Dreh es", "Mach das größer", "Explosionsansicht", "Zoom rein", "Mach die Musik lauter"):
            with self.subTest(said=said):
                self.assertIsNone(self.bp.command(said))
        self.assertIn("Auf dem Tisch: Drohne", self.bp.open())
        self.assertTrue(self.bp.active)
        self.assertEqual(self.ui.of("blueprint")[-1][1]["action"], "open")
        self.assertIn("geschlossen", self.bp.command("Blaupause schließen"))
        self.assertFalse(self.bp.active)
        self.assertIn("Auf dem Tisch: Drohne", self.bp.command("Öffne die Blaupause"))
        for said in ("Öffne den Blueprint", "Blue Print", "Blueprint Modus", "Blueprint", "Öffne das Bluprint"):
            with self.subTest(said=said):
                self.bp.close()
                self.assertIn("Blueprint, Sir", self.bp.command(said))
                self.assertTrue(self.bp.active)
        self.assertIn("geschlossen", self.bp.command("Blueprint schließen"))

    def test_animations_by_voice(self):
        """Georg: "animier das so, dass es verschmilzt". Sofort, ohne Claude."""
        from jarvis.blaupause import animation_for

        self.bp.open()
        for said, art, answer in (("Animier das so, dass es verschmilzt", "verschmelzen", "Es verschmilzt, Sir."),
                                  ("Lass das Herz schlagen", "pulsieren", "Es schlägt, Sir."),
                                  ("Lass es schmelzen", "schmelzen", "Es schmilzt, Sir."),
                                  ("Jarvis, lass es schweben", "schweben", "Es schwebt, Sir."),
                                  ("Lös es auf", "aufloesen", "Es löst sich auf, Sir."),
                                  ("Verschmelzen", "verschmelzen", "Es verschmilzt, Sir."),
                                  ("Animation aus", "", "Animation aus, Sir.")):
            with self.subTest(said=said):
                self.assertEqual(self.bp.command(said), answer)
                self.assertEqual(self.views()[-1], {"action": "view", "what": "anim", "art": art})
        self.assertIn("Wie soll es sich bewegen", self.bp.command("Animier das"))
        self.assertEqual(self.bp.command("Halt still"), "Steht still, Sir.")
        self.assertEqual(self.views()[-1]["art"], "", "still heißt: auch keine Animation")
        for said in ("Schlag mir eine Farbe vor", "Mach den Rumpf schlanker", "Mach die Flügel länger"):
            with self.subTest(said=said):
                self.assertIsNone(animation_for(said.lower()))

    def test_fetch_a_part_or_a_new_model(self):
        """Georg: "hol das Herz". Ein Teil mit dem Namen kommt nach vorne, sonst baut Claude es."""
        wishes = []
        self.bp.generate = lambda wish, fresh=True: wishes.append((wish, fresh)) or "Sehr wohl, Sir."
        self.assertIsNone(self.bp.command("Hol mir ein Glas Wasser"), "Blueprint zu: kein Modell")
        self.bp.open()
        self.assertEqual(self.bp.command("Hol die Antenne"), "Antenne, Sir.")
        self.assertEqual(self.views()[-1], {"action": "view", "what": "focus", "ids": ["antenne"]})
        self.assertEqual(self.bp.command("Hol die Flügel her"), "Flügel, Sir.")
        self.bp.command("Hol das Herz")
        self.assertEqual(wishes[-1], ("Hol das Herz", True), "kein Teil so: ein neues Modell")
        self.bp.command("Hol noch eine Antenne dazu")
        self.assertEqual(wishes[-1], ("Hol noch eine Antenne dazu", False), "noch eins dazu: eine Änderung")

    def test_everyday_commands_stay_everyday_commands(self):
        """Bei offener Blaupause ist "Mach lauter" oder "Mach den PC aus" keine Änderung am Modell für Claude."""
        self.bp.open()
        wishes = []
        self.bp.generate = lambda wish, fresh=True: wishes.append(wish) or "Sehr wohl, Sir."
        for said in ("Mach lauter", "Mach den PC aus", "Mach einen Screenshot", "Mach Spotify auf",
                     "Stell einen Timer auf 5 Minuten", "Mach die Musik aus", "Gib mir das Wetter"):
            with self.subTest(said=said):
                self.assertIsNone(self.bp.command(said))
        self.assertEqual(wishes, [])
        for said in ("Füg noch zwei Antennen hinzu", "Gib ihm Räder", "Häng einen Greifarm dran", "Mach ein Fenster rein"):
            self.bp.command(said)
        self.assertEqual(len(wishes), 4, "Wünsche zum Modell gehen weiter an Claude")

    def test_empty_table_builds_only_things(self):
        """Offener Blueprint, noch nichts auf dem Tisch: "Mach das Licht an" oder "Mach weiter" ist kein neues Modell."""
        empty = Blueprint({}, None, self.ui, Path(self.tmp.name) / "leer", self.said.append)
        empty.open()
        built = []
        empty.generate = lambda wish, fresh=True: built.append(wish) or "Sehr wohl, Sir."
        for said in ("Mach lauter", "Mach den PC aus", "Mach das Licht an", "Mach die Musik aus", "Mach weiter",
                     "Mach Pause", "Mach Spotify auf"):
            with self.subTest(said=said):
                self.assertIsNone(empty.command(said))
        for said in ("Bau ein Auto", "Bau mir den Eiffelturm", "Zeichne einen Stuhl", "Generiere Iron Man Helm",
                     "Bau Raumschiff in 3D"):
            empty.command(said)
        self.assertEqual(len(built), 5)

    def test_whip_with_the_blueprint_open(self):
        from tests.test_assistant import make

        assistant, _ui, _speaker, _ = make()
        assistant.blueprint = self.bp
        self.bp.open()
        wishes = []
        self.bp.generate = lambda wish, fresh=True: wishes.append(wish) or "Sehr wohl, Sir."
        assistant.handle("Mach schneller", speak=False)
        self.assertEqual(wishes, [], "die Peitsche, kein Wunsch an das Modell")
        self.assertEqual(assistant.brain.asked, [])

    def test_wishes_while_building_are_queued_and_done_right_after(self):
        """Georg: "ich sag was, dann macht er direkt weiter". Während Claude baut, kommt der nächste Wunsch in die
        Warteschlange statt "Ich konstruiere noch"."""
        self.bp.open()
        started = []
        self.bp._brain = type("Brain", (), {"claude_path": "claude"})()

        def work(wish, fresh):
            started.append((wish, fresh))

        self.bp._work = work
        self.bp.generate("Mach die Arme länger", fresh=False)
        self.assertTrue(self.bp.busy)
        self.assertIn(self.bp.generate("Und die Rotoren rot", fresh=False), ["Danach, Sir.", "Kommt gleich, Sir.", "Notiert, Sir."])
        self.assertEqual(self.bp._queue, [("Und die Rotoren rot", False)])
        self.bp.busy = False  # die erste Änderung ist fertig
        self.bp._next()
        self.assertEqual(started[-1], ("Und die Rotoren rot", False), "direkt danach, ohne nochmal zu fragen")
        self.bp.generate("Noch eine Antenne", fresh=False)
        self.assertTrue(self.bp.cancel(), "Stopp leert auch die Warteschlange")
        self.assertEqual(self.bp._queue, [])

    def test_wishes_before_the_first_part_are_changes(self):
        """Georg sagt "Mach sie rot", während Claude die Drohne baut, aber noch kein Teil da ist. Das ist eine
        Änderung für danach, kein neues Modell "sie rot" und nichts für den normalen Chat. Entsteht die Drohne
        nicht, fallen die Änderungen dafür weg, ein neues Modell bleibt dran."""
        gate = threading.Event()
        prompts = []

        def stream(prompt, on_text=None, **_):
            prompts.append(prompt)
            if len(prompts) == 1:
                gate.wait(5)  # Claude liefert für die Drohne nichts
            else:
                on_text(json.dumps(part("rad", form="zylinder")) + "\n")

        brain = types.SimpleNamespace(claude_path="claude", stream_oneshot=stream)
        bp = Blueprint({}, brain, self.ui, Path(self.tmp.name) / "leer", self.said.append)
        bp.open()
        bp.command("Bau mir eine Drohne")
        self.assertTrue(bp.busy)
        for said in ("Mach sie rot", "Füg noch zwei Raketen an", "Bau mir ein Auto"):
            with self.subTest(said=said):
                self.assertIsNotNone(bp.command(said))
        self.assertEqual(bp._queue, [("Mach sie rot", False), ("Füg noch zwei Raketen an", False),
                                     ("Bau mir ein Auto", True)])
        gate.set()
        end = time.monotonic() + 10
        while (bp.busy or len(prompts) < 2) and time.monotonic() < end:
            time.sleep(0.02)
        self.assertEqual(len(prompts), 2)
        self.assertIn("Bau mir ein Auto", prompts[1], "das neue Modell kommt direkt danach")
        self.assertEqual(bp._queue, [])
        self.assertEqual([p["id"] for p in bp.scene["teile"]], ["rad"])
        self.assertIn("Das hat nicht geklappt", self.said[0])

    def test_view_commands_go_to_the_window(self):
        self.bp.open()
        self.assertEqual(self.bp.command("Explosionsansicht"), "Explosionsansicht, Sir.")
        self.bp.command("Dreh es um 90 Grad nach links")
        self.bp.command("Zoom rein")
        self.bp.command("Von oben")
        self.bp.command("Lass es drehen")
        self.bp.command("Röntgenblick")
        self.bp.command("Bau es wieder zusammen")
        whats = [(v["what"], v.get("degrees"), v.get("side"), v.get("on"), v.get("mode")) for v in self.views()]
        self.assertEqual(whats, [("explode", None, None, True, None), ("rotate", -90.0, None, None, None),
                                 ("zoom", None, None, None, None), ("camera", None, "oben", None, None),
                                 ("spin", None, None, True, None), ("look", None, None, None, "draht"),
                                 ("explode", None, None, False, None)])

    def test_bigger_smaller_keeps_the_model_on_the_floor(self):
        self.bp.open()
        self.assertIn("25 Prozent größer", self.bp.command("Mach das größer"))
        rumpf = next(p for p in self.bp.scene["teile"] if p["id"] == "rumpf")
        links = next(p for p in self.bp.scene["teile"] if p["id"] == "fluegel_links")
        self.assertEqual(rumpf["skala"], [1.25, 1.25, 1.25])
        self.assertEqual(links["pos"], [-0.75, 0.625, 0.0], "um die Mitte am Boden vergrößert")
        self.assertIn("50 Prozent kleiner", self.bp.command("Mach es halb so groß"))
        self.bp.command("Rückgängig")
        self.bp.command("Rückgängig")
        self.assertEqual(next(p for p in self.bp.scene["teile"] if p["id"] == "rumpf")["skala"], [1.0, 1.0, 1.0])
        self.assertIn("Prozent größer", self.bp.command("Mach die Flügel doppelt so groß"))
        self.assertEqual(next(p for p in self.bp.scene["teile"] if p["id"] == "rumpf")["skala"], [1.0, 1.0, 1.0],
                         "nur die Flügel")

    def test_color_remove_focus_hide_and_undo(self):
        self.bp.open()
        self.assertIn("rot", self.bp.command("Mach die Flügel rot"))
        self.assertEqual({p["farbe"] for p in self.bp.scene["teile"] if p["gruppe"] == "Flügel"}, {"#e53935"})
        before = [p["farbe"] for p in self.bp.scene["teile"]]
        wishes = []
        self.bp.generate = lambda wish, fresh=True: wishes.append(wish) or "Sehr wohl, Sir."
        self.bp.command("Mach den Hintergrund blau")
        self.assertEqual([p["farbe"] for p in self.bp.scene["teile"]], before, "kein Teil heißt Hintergrund")
        self.assertEqual(wishes, ["Mach den Hintergrund blau"], "das macht Claude")
        self.bp.command("Mach den Schornstein doppelt so groß")
        self.assertEqual(len(wishes), 2)
        del self.bp.generate
        self.assertIn("Das Modell ist jetzt grün", self.bp.command("Mach das ganze Modell grün"))
        self.bp.command("Rückgängig")
        self.assertIn("Entfernt", self.bp.command("Entferne die Antenne"))
        self.assertNotIn("antenne", [p["id"] for p in self.bp.scene["teile"]])
        self.assertEqual(self.bp.command("Rückgängig"), "Rückgängig gemacht, Sir.")
        self.assertIn("antenne", [p["id"] for p in self.bp.scene["teile"]])
        self.assertEqual(self.bp.command("Wiederherstellen"), "Wiederhergestellt, Sir.")
        self.bp.command("Rückgängig")
        self.assertIn("Flügel", self.bp.command("Zeig mir die Flügel genauer"))
        self.assertEqual(self.views()[-1]["ids"], ["fluegel_links", "fluegel_rechts"])
        self.assertIn("finde ich nicht", self.bp.command("Zeig mir das Triebwerk genauer"))
        self.assertIn("Ausgeblendet", self.bp.command("Blende die Antenne aus"))
        self.assertTrue(next(p for p in self.bp.scene["teile"] if p["id"] == "antenne").get("versteckt"))
        self.bp.command("Zeig alles")
        self.assertFalse(next(p for p in self.bp.scene["teile"] if p["id"] == "antenne").get("versteckt"))
        self.bp.select("antenne")
        self.assertIn("Antenne", self.bp.command("Was ist das?"))

    def test_save_load_list_export(self):
        self.bp.open()
        self.assertIn("Gespeichert als Testdrohne", self.bp.command("Speicher das als Testdrohne"))
        saved = self.bp.folder / "testdrohne.json"
        self.assertTrue(saved.is_file())
        self.bp.command("Leere Blaupause")
        self.assertEqual(self.bp.scene["teile"], [])
        self.assertIn("Testdrohne", self.bp.command("Lade die Blaupause Testdrohne"))
        self.assertEqual(len(self.bp.scene["teile"]), 4)
        self.assertEqual(self.bp.scene.get("groesse_m"), 0.4)
        self.assertIn("1 Blueprint", self.bp.command("Zeig mir meine Blaupausen"))
        self.assertIn("1 Blueprint", self.bp.command("Zeig mir meine Blueprints"))
        self.assertIn("STL", self.bp.command("Exportier als STL"))
        self.assertEqual(self.ui.of("blueprint")[-1][1]["action"], "export")
        path = Path(self.bp.export_stl("Testdrohne", stl(2)))
        self.assertEqual(path.name, "testdrohne.stl")
        with self.assertRaises(ValueError):
            self.bp.export_stl("x", stl(2)[:-8])
        with self.assertRaises(ValueError):
            self.bp.export_stl("x", "kein base64!")
        self.assertTrue(self.bp.delete("Testdrohne"))
        self.assertEqual(self.bp.saved(), [])

    def test_window_edits_with_undo(self):
        self.assertTrue(self.bp.edit_part("antenne", {"farbe": "blau", "script": "x"}))
        antenne = next(p for p in self.bp.scene["teile"] if p["id"] == "antenne")
        self.assertEqual(antenne["farbe"], "#1e88e5")
        self.assertNotIn("script", antenne)
        self.assertTrue(self.bp.edit_part("antenne", {"entfernen": True}))
        self.assertFalse(self.bp.edit_part("gibtsnicht", {"farbe": "rot"}))
        self.bp.undo()
        self.assertIn("antenne", [p["id"] for p in self.bp.scene["teile"]])

    def test_limits(self):
        self.bp.apply({"op": "neu", "name": "Viel"})
        for n in range(MAX_PARTS + 5):
            self.bp.apply(part(f"t{n}"))
        self.assertEqual(len(self.bp.scene["teile"]), MAX_PARTS)

    def test_strong_verbs_open_the_blueprint_but_not_for_texts(self):
        for said in ("Generiere ein Passwort", "Generiere mir eine Playlist", "Bau mir einen Tisch", "Mach mir ein Bild"):
            with self.subTest(said=said):
                self.assertIsNone(self.bp.command(said))
        self.assertFalse(self.bp.active)
        self.assertIsNotNone(self.bp.command("Generiere einen Iron-Man-Helm"))
        self.assertTrue(self.bp.active)

    def test_brain_hands_over_3d_wishes(self):
        import datetime as dt

        from jarvis.blaupause import HANDOFF, hand_over

        state = Path(self.tmp.name) / "daten"
        hand_over(state, "Ein Auto in 3D")
        self.assertTrue(self.bp.take_handoff(state))
        self.assertFalse((state / HANDOFF).exists(), "nur einmal")
        self.assertTrue(self.bp.active)
        self.assertIn("Gehirn", self.said[-1], "ohne Gehirn sagt Jarvis, was fehlt")
        self.assertFalse(self.bp.take_handoff(state))
        old = hand_over(state, "Alt")
        data = json.loads(old.read_text(encoding="utf-8"))
        data["zeit"] = (dt.datetime.now() - dt.timedelta(minutes=10)).isoformat(timespec="seconds")
        old.write_text(json.dumps(data), encoding="utf-8")
        self.assertFalse(self.bp.take_handoff(state), "zu alt")

    def test_generation_needs_a_brain(self):
        self.bp.open()
        self.assertIn("Gehirn", self.bp.command("Generiere einen Iron-Man-Helm"))


@posix_only
class GenerateTest(unittest.TestCase):
    """Claude zeichnet: Teile kommen einzeln ins Fenster, Unsinn wird verworfen, Änderungen bauen um."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        self.home = home
        cfg = load_config()
        cfg["brain"]["claude_path"] = str(make_fake_claude(home))
        (home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(cfg["brain"], home, home / "daten")
        self.addCleanup(self.brain.close)
        self.ui = RecordingUi()
        self.said = []
        self.bp = Blueprint(cfg, self.brain, self.ui, home / "Werkstatt", self.said.append)

    def wait(self):
        end = time.monotonic() + 15
        while self.bp.busy and time.monotonic() < end:
            time.sleep(0.05)

    def calls(self):
        return [json.loads(line) for line in (self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()]

    def test_a_prestarted_claude_takes_the_next_wish(self):
        """Georg: "er macht das schnell". Der Claude-Prozess für den nächsten Wunsch läuft schon (unter Windows
        2 bis 3 Sekunden Start gespart): Er bekommt die Aufgabe als JSON-Zeile, ein zweiter Prozess startet nicht."""
        path = self.bp._system_file()
        self.assertTrue(self.brain.prestart_oneshot(path, "sonnet", "low"))
        spare_pid = self.brain._spare["proc"].pid
        self.assertTrue(self.brain.prestart_oneshot(path, "sonnet", "low"), "zweimal schadet nicht")
        self.assertEqual(self.brain._spare["proc"].pid, spare_pid, "kein zweiter Prozess")
        text = self.brain.stream_oneshot("Blaupause: Neues Modell. Georg sagt: „Helm“", path, model="sonnet", effort="low")
        self.assertIn("schale", text)
        call = self.calls()[-1]
        self.assertEqual(call["pid"], spare_pid, "der vorgestartete Prozess hat gearbeitet")
        self.assertTrue(call["live"], "mit --input-format stream-json")
        self.assertTrue(call["prompt"].startswith("Blaupause: Neues Modell"))
        self.assertIsNone(self.brain._spare, "verbraucht")
        self.brain.prestart_oneshot(path, "opus", "high")
        self.brain.stream_oneshot("Blaupause: Neues Modell. Georg sagt: „Helm“", path, model="sonnet", effort="low")
        self.assertNotEqual(self.calls()[-1]["model"], "opus", "anderes Modell: frisch gestartet statt falsch vorgewärmt")
        self.bp.open()
        self.bp.close()
        self.assertIsNone(self.brain._spare, "zu: kein Prozess bleibt hängen")

    def test_new_model_part_by_part_and_then_a_change(self):
        answer = self.bp.command("Generiere einen Iron-Man-Helm")
        self.assertIn("konstruiere", answer.lower() + " konstruiere")
        self.assertTrue(self.bp.active, "die Blaupause geht dabei auf")
        self.wait()
        self.assertEqual(self.bp.scene["name"], "Testhelm")
        self.assertEqual([p["id"] for p in self.bp.scene["teile"]], ["schale", "visier"])
        self.assertEqual(self.bp.scene["groesse_m"], 0.3)
        self.assertIn(self.said[0], ["Fertig, Sir. Testhelm.", "Testhelm steht, Sir."], "kurz, ohne Erklärung")
        actions = [e[1]["action"] for e in self.ui.of("blueprint")]
        self.assertIn("busy", actions)
        self.assertEqual(actions[-1], "done")
        added = [e[1]["op"]["teil"]["id"] for e in self.ui.of("blueprint")
                 if e[1]["action"] == "op" and e[1]["op"]["op"] == "teil"]
        self.assertEqual(added, ["schale", "visier"], "jedes Teil kommt einzeln ins Fenster")
        call = self.calls()[-1]
        self.assertIn("--system-prompt-file", call["args"])
        self.assertIn("--strict-mcp-config", call["args"])
        self.assertEqual(call["args"][call["args"].index("--tools") + 1], "")
        self.assertEqual(call["no_claude_md"], "1")
        self.assertTrue(call["prompt"].startswith("Blaupause: Neues Modell"))

        self.bp.select("visier")
        self.assertIsNotNone(self.bp.command("Füg noch eine Antenne hinzu"))
        self.wait()
        self.assertEqual([p["id"] for p in self.bp.scene["teile"]], ["schale", "visier", "antenne"])
        self.assertEqual(next(p for p in self.bp.scene["teile"] if p["id"] == "visier")["farbe"], "#00ff00")
        self.assertEqual(self.said[-1], "Erledigt, Sir.", "Änderungen: nur Erledigt, ohne Erklärung")
        prompt = self.calls()[-1]["prompt"]
        self.assertIn("Ändere das vorhandene Modell", prompt)
        self.assertIn('"schale"', prompt, "Claude sieht das Modell")
        self.assertIn('Ausgewählt ist das Teil mit id "visier"', prompt)
        self.assertEqual(self.bp.command("Rückgängig"), "Rückgängig gemacht, Sir.")
        self.assertEqual([p["id"] for p in self.bp.scene["teile"]], ["schale", "visier"], "eine Konstruktion, ein Rückgängig")

    def test_stop_cancels(self):
        self.bp.open()
        self.bp.generate("langsam", fresh=True)
        time.sleep(0.6)
        self.assertTrue(self.bp.cancel())
        self.wait()
        self.assertFalse(self.bp.busy)
        self.assertEqual(self.said, [], "abgebrochen: keine Ansage")


class BlenderTest(unittest.TestCase):
    """\"Render das\" und \"Öffne das in Blender\": Blender arbeitet im Hintergrund, das Fenster zeigt Fortschritt und Foto."""

    def setUp(self):
        from jarvis import blender

        self.blender = blender
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ui = RecordingUi()
        self.said = []
        self.bp = Blueprint({}, None, self.ui, Path(self.tmp.name), self.said.append)
        self.bp.apply({"op": "neu", "name": "Drohne"})
        self.bp.apply(part("rumpf"))
        self.bp.open()
        self.exe = Path(self.tmp.name) / "blender"
        self.photo = blender.Photo(Path(self.tmp.name) / "foto.png", None, "OPTIX (RTX)", 4.2)

    def renders(self):
        return [(e[1]["state"], e[1]) for e in self.ui.of("blueprint") if e[1]["action"] == "render"]

    def wait(self):
        if self.bp._blender_thread is not None:
            self.bp._blender_thread.join(5)

    def test_voice_commands_reach_blender(self):
        for said in ("Render das", "Rendere es mal", "Mach ein Foto davon", "Zeig es mir fotorealistisch"):
            with self.subTest(said=said), mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                    mock.patch("jarvis.blender.render", return_value=self.photo) as render:
                self.assertEqual(self.bp.command(said), "Ich rendere es, Sir.")
                self.wait()
                self.assertEqual(render.call_args.args[:2], (self.exe, self.bp.scene))
        for said in ("Öffne das in Blender", "Bearbeite es in Blender", "Blender öffnen"):
            with self.subTest(said=said), mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                    mock.patch("jarvis.blender.make_blend", return_value=Path("modell.blend")), \
                    mock.patch("jarvis.blender.open_blend") as opened:
                self.assertEqual(self.bp.command(said), "Ich öffne es in Blender, Sir.")
                self.wait()
                opened.assert_called_once_with(self.exe, Path("modell.blend"))
        self.assertIsNone(self.bp.command("Wie spät ist es?"))

    def test_closed_blueprint_only_takes_clear_words(self):
        self.bp.close()
        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                mock.patch("jarvis.blender.render", return_value=self.photo):
            for said in ("Mach ein Foto", "Öffne Blender", "Blender"):
                with self.subTest(said=said):
                    self.assertIsNone(self.bp.command(said), "Kamera, App: nicht der Blueprint")
            self.assertEqual(self.bp.command("Render das"), "Ich rendere es, Sir.")
            self.assertTrue(self.bp.active, "das Foto erscheint im Blueprint")
            self.wait()

    def test_photo_shows_up_and_jarvis_says_so(self):
        steps = [{"prozent": 50, "rest": 3.0}, {"prozent": 100, "rest": None}]

        def render(*args, on_progress=None, **kwargs):
            for step in steps:
                on_progress(step)
            return self.photo

        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), mock.patch("jarvis.blender.render", render):
            self.bp.render_photo()
            self.wait()
        states = [s for s, _ in self.renders()]
        self.assertEqual(states, ["start", "progress", "progress", "done"])
        self.assertEqual(self.renders()[1][1]["percent"], 50)
        self.assertEqual(self.renders()[-1][1]["device"], "OPTIX (RTX)")
        self.assertIs(self.bp.photo, self.photo)
        self.assertEqual(self.said, ["Das Foto ist fertig, Sir."])

    def test_nothing_on_the_table(self):
        empty = Blueprint({}, None, self.ui, Path(self.tmp.name), self.said.append)
        empty.open()
        self.assertEqual(empty.command("Mach ein Foto davon"), "Auf dem Tisch liegt noch nichts, Sir.")
        self.assertFalse(empty.busy, "kein neues Modell namens Foto")
        self.assertEqual(empty.command("Öffne das in Blender"), "Auf dem Tisch liegt noch nichts, Sir.")

    def test_missing_blender_gets_installed_first(self):
        with mock.patch("jarvis.blender.find_blender", side_effect=[None, self.exe]), \
                mock.patch("jarvis.blender.can_install", return_value=True), \
                mock.patch("jarvis.blender.install", return_value="Blender ist installiert.") as install, \
                mock.patch("jarvis.blender.render", return_value=self.photo):
            self.assertIn("Ich installiere es", self.bp.command("Render das"))
            self.wait()
        install.assert_called_once()
        self.assertEqual([s for s, _ in self.renders()], ["install", "start", "done"])
        with mock.patch("jarvis.blender.find_blender", return_value=None), \
                mock.patch("jarvis.blender.can_install", return_value=False):
            self.assertEqual(self.bp.command("Render das"), "Blender ist auf diesem Rechner nicht installiert, Sir.")

    def test_failure_and_stop(self):
        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                mock.patch("jarvis.blender.render", side_effect=self.blender.BlenderError("Blender endete mit Code 1.")):
            self.bp.render_photo()
            self.wait()
        self.assertEqual(self.renders()[-1][0], "error")
        self.assertEqual(self.said, ["Blender hat nicht mitgespielt, Sir. Blender endete mit Code 1."])

        started = threading.Event()

        def slow(*args, cancel=None, **kwargs):
            started.set()
            cancel.wait(5)
            raise self.blender.BlenderError("abgebrochen")

        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), mock.patch("jarvis.blender.render", slow):
            self.bp.render_photo()
            started.wait(5)
            self.assertEqual(self.bp.render_photo(), "Blender ist noch beschäftigt, Sir.")
            self.assertTrue(self.bp.cancel(), "\"Stopp\" hält auch Blender an")
            self.wait()
        self.assertEqual(self.renders()[-1][0], "cancelled")
        self.assertEqual(len(self.said), 1, "abgebrochen: keine Ansage")

    def test_photo_wish_while_building_comes_right_after(self):
        """\"Render das\", während Claude noch baut: erst fertig bauen, dann das Foto vom ganzen Modell."""
        self.bp.busy = True
        self.assertEqual(self.bp.command("Render das"), "Sobald es steht, Sir.")
        self.assertIsNone(self.bp._blender_thread)
        self.bp.busy = False
        self.bp.apply(part("fluegel"))
        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                mock.patch("jarvis.blender.render", return_value=self.photo) as render:
            self.bp._after()
            self.wait()
        self.assertEqual(len(render.call_args.args[1]["teile"]), 2, "mit dem neuen Teil")
        self.assertEqual(self.said, ["Das Foto ist fertig, Sir."])
        self.bp.busy = True
        self.bp.command("Render das")
        self.assertTrue(self.bp.cancel())
        self.assertEqual(self.bp._blender_after, "", "Stopp vergisst auch das Foto")
        self.bp.busy = False

    def test_photo_from_the_angle_georg_is_looking_from(self):
        self.assertTrue(self.bp.set_view({"azimut": 270.5, "hoehe": 95}))
        self.assertEqual(self.bp.view, {"azimut": -89.5, "hoehe": 89.0})
        for bad in (None, {"azimut": "links"}, {"azimut": float("nan"), "hoehe": 1}, {"hoehe": 3}):
            with self.subTest(view=bad):
                self.assertFalse(self.bp.set_view(bad))
        self.assertEqual(self.bp.view, {"azimut": -89.5, "hoehe": 89.0}, "Unsinn ändert nichts")
        with mock.patch("jarvis.blender.find_blender", return_value=self.exe), \
                mock.patch("jarvis.blender.render", return_value=self.photo) as render, \
                mock.patch("jarvis.blender.make_blend", return_value=Path("m.blend")) as make, \
                mock.patch("jarvis.blender.open_blend"):
            self.bp.render_photo()
            self.wait()
            self.bp.open_in_blender()
            self.wait()
        self.assertEqual(render.call_args.kwargs["view"], {"azimut": -89.5, "hoehe": 89.0})
        self.assertEqual(make.call_args.kwargs["view"], {"azimut": -89.5, "hoehe": 89.0})

    def test_window_gets_the_photo(self):
        from jarvis.gui.app import Api, GuiBridge

        api = Api(GuiBridge(), types.SimpleNamespace(blueprint=self.bp), mute=None)
        self.assertFalse(api.blueprint_photo()["ok"])
        self.photo.image.write_bytes(b"\x89PNG Foto")
        self.bp.photo = self.photo
        shown = api.blueprint_photo()
        self.assertTrue(shown["ok"])
        self.assertEqual(base64.b64decode(shown["src"].split(",", 1)[1]), b"\x89PNG Foto")
        self.assertTrue(shown["src"].startswith("data:image/png;base64,"))
        preview = Path(self.tmp.name) / "vorschau.jpg"
        preview.write_bytes(b"\xff\xd8 klein")
        self.bp.photo = self.blender.Photo(self.photo.image, preview, "CPU", 60.0)
        self.assertTrue(api.blueprint_photo()["src"].startswith("data:image/jpeg;base64,"), "fürs Fenster das JPEG")


class RoutingTest(unittest.TestCase):
    """Bei offener Blaupause gehören "Mach das größer" und "Dreh es" zum Modell, sonst nicht."""

    def test_assistant_routes_to_the_blueprint(self):
        from tests.test_assistant import FakeBrain, make

        with TemporaryDirectory() as tmp:
            brain = FakeBrain()
            assistant, ui, _speaker, _ = make(brain)
            bp = Blueprint({}, types.SimpleNamespace(claude_path=""), ui, Path(tmp), lambda text: None)
            assistant.blueprint = bp
            bp.apply({"op": "neu", "name": "Helm"})
            bp.apply(part("schale", "kugel", masse=[0.5]))
            assistant.handle("Explosionsansicht")
            self.assertEqual(brain.asked, ["Explosionsansicht"], "zu: geht an Claude")
            self.assertIn("Blueprint", assistant.handle("Blaupause"))
            self.assertEqual(assistant.handle("Explosionsansicht"), "Explosionsansicht, Sir.")
            self.assertIn("Prozent größer", assistant.handle("Mach das größer"))
            self.assertEqual(len(brain.asked), 1, "nichts davon ging an Claude")
            # Ein Programm bleibt Sache der Werkstatt, auch bei offener Blaupause
            from jarvis.blaupause import _SOFTWARE
            self.assertTrue(_SOFTWARE.search("bau mir einen discord-bot"))
            self.assertIsNone(bp.command("Bau mir einen Discord-Bot"))


if __name__ == "__main__":
    unittest.main()
