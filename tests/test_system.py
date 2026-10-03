"""Das System (wie im Video "AgenticOS"): Wissensnetz, Sitzung für Sitzung, Agents und Skills."""

import datetime as dt
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.memory import Memory, match_memory, session_theme
from jarvis.system import QUICK, System, match_system
from jarvis.wissensnetz import Netz, clean_text, words


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


def write(folder: Path, name: str, text: str, age_hours: float = 0) -> Path:
    path = folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if age_hours:
        stamp = time.time() - age_hours * 3600
        os.utime(path, (stamp, stamp))
    return path


class FakeWorkshop:
    def __init__(self, projects):
        self.items = projects

    def projects(self):
        return self.items


class FakeMemory:
    def __init__(self, facts=(), sessions=()):
        self._facts = [{"text": f} for f in facts]
        self._sessions = list(sessions)

    def facts(self):
        return self._facts

    def sessions(self):
        return self._sessions


def vault(folder: Path) -> None:
    """Ein kleines Notizbuch wie bei Georg."""
    write(folder, "Start.md", "# Jarvis-Notizbuch\n\n- [[2026-10-02]]\n- [[Max]]")
    write(folder, "Gedächtnis.md", "# Gedächtnis\n\n- Georgs bester Freund heißt Max.")
    write(folder, ".obsidian/workspace.md", "geheim")
    write(folder, "Tagebuch/2026-10-02.md",
          "# Freitag, 2. Oktober 2026\n\nAlle Gespräche des Tages. Zurück zum [[Start]].\n\n## Gespräche\n"
          "- **20:01** Georg: Schreib [[Max]], dass ich später komme\n"
          "- **20:05** Georg: Recherchiere die besten Gaming-Mäuse\n  - Jarvis: Der Bericht liegt im Notizbuch.")
    write(folder, "Personen/Max.md", "# Max\n\n<!-- jarvis:anfang -->\n- Schreibt mit Georg über: Discord\n<!-- jarvis:ende -->")
    write(folder, "Recherchen/Die besten Gaming-Mäuse.md",
          "# Die besten Gaming-Mäuse\n\n*Von Jarvis. Zurück zum [[Start]].*\n\nLogitech G Pro Superlight: leichter Sensor, "
          "Funk, Akku hält 70 Stunden. Razer Viper: Sensor mit 30000 DPI, Funk. Für Shooter zählt das Gewicht der Maus.",
          age_hours=48)
    write(folder, "Recherchen/Streaming-Setup.md",
          "# Streaming-Setup\n\nFür Twitch reicht OBS mit einem Overlay, ein gutes Mikrofon und eine Webcam. "
          "Das Overlay zeigt Alerts für neue Follower. Mikrofon: Rode NT-USB.")
    write(folder, "Notizen/Stream-Ideen.md",
          "# Stream-Ideen\n\n- Overlay mit Alerts für Twitch bauen\n- Mikrofon-Filter in OBS testen")
    write(folder, "Notizen/Schnellnotizen.md", "# Schnellnotizen\n\nZurück zum [[Start]].\n\n- **2.10. 18:00** Milch kaufen")


class WissensnetzTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        vault(self.folder)
        self.workshop = FakeWorkshop([
            {"name": "stream-overlay", "task": "Ein Twitch-Overlay mit Alerts für OBS bauen", "folder": "C:/x",
             "updated": "2026-10-02T21:00", "state": "running"},
            {"name": "wetter-app", "task": "Eine kleine Wetter-App für den Desktop", "folder": "C:/y",
             "updated": "2026-09-20T10:00", "state": "done"},
        ])
        self.memory = FakeMemory(
            facts=["Georgs bester Freund heißt Max.", "Georg baut gerade das Projekt stream-overlay."],
            sessions=[{"start": "2026-10-02T20:00", "ende": "2026-10-02T20:40", "anzahl": 5,
                       "themen": ["Recherchiere die besten Gaming-Mäuse"]}])
        self.netz = Netz(self.folder, self.workshop, self.memory, now=Clock(dt.datetime(2026, 10, 3, 9, 30)))

    def tearDown(self):
        self.temp.cleanup()

    def graph(self):
        return self.netz.build(fresh=True)

    @staticmethod
    def edge(graph, a, b):
        for e in graph["kanten"]:
            if {e["a"], e["b"]} == {a, b}:
                return e
        return None

    def test_every_kind_of_node_is_there(self):
        graph = self.graph()
        nodes = {n["id"]: n for n in graph["knoten"]}
        self.assertEqual(nodes["Gedächtnis"]["art"], "gedaechtnis")
        self.assertEqual(nodes["Gedächtnis"]["datei"], "Gedächtnis.md")
        self.assertEqual(self.netz.path_of("Gedächtnis"), self.folder / "Gedächtnis.md", "Klick öffnet die Seite")
        self.assertEqual(nodes["Die besten Gaming-Mäuse"]["datei"], "Recherchen/Die besten Gaming-Mäuse.md")
        self.assertEqual(self.netz.path_of("projekt:stream-overlay"), Path("C:/x"))
        self.assertIsNone(self.netz.path_of("sitzung:2026-10-02T20:00"))
        self.assertIsNone(self.netz.path_of("gibt-es-nicht"))
        self.assertEqual(nodes["Gedächtnis"]["fakten"], 2)
        self.assertEqual(nodes["Max"]["art"], "person")
        self.assertEqual(nodes["Die besten Gaming-Mäuse"]["art"], "recherche")
        self.assertEqual(nodes["Stream-Ideen"]["art"], "notiz")
        self.assertEqual(nodes["2026-10-02"]["art"], "tag")
        self.assertEqual(nodes["2026-10-02"]["titel"], "Fr 2.10.")
        self.assertEqual(nodes["projekt:stream-overlay"]["art"], "projekt")
        self.assertTrue(nodes["projekt:stream-overlay"]["laeuft"])
        self.assertFalse(nodes["projekt:wetter-app"]["laeuft"])
        session = nodes["sitzung:2026-10-02T20:00"]
        self.assertEqual((session["art"], session["titel"], session["anzahl"]), ("sitzung", "Fr 20:00", 5))
        self.assertNotIn("Start", nodes, "die Startseite verbindet sonst alles mit allem")
        self.assertFalse(any("workspace" in n for n in nodes), ".obsidian gehört Obsidian")
        self.assertTrue(nodes["Stream-Ideen"]["neu"])
        self.assertFalse(nodes["Die besten Gaming-Mäuse"]["neu"], "vor zwei Tagen geschrieben")
        self.assertNotIn("Zurück zum", nodes["Schnellnotizen"]["auszug"])
        self.assertEqual([n["art"] for n in graph["knoten"]][0], "gedaechtnis", "das Gedächtnis zuerst")
        self.assertEqual(graph["zahlen"]["knoten"], len(graph["knoten"]))
        self.assertEqual(graph["stand"], "09:30")

    def test_links_memory_and_mentions(self):
        graph = self.graph()
        self.assertEqual(self.edge(graph, "2026-10-02", "Max")["art"], "link", "[[Max]] im Tagebuch")
        self.assertEqual(self.edge(graph, "Gedächtnis", "Max")["art"], "gedaechtnis")
        self.assertEqual(self.edge(graph, "Gedächtnis", "projekt:stream-overlay")["warum"], "steht im Gedächtnis")
        self.assertIsNone(self.edge(graph, "Gedächtnis", "projekt:wetter-app"))
        self.assertEqual(self.edge(graph, "Gedächtnis", "sitzung:2026-10-02T20:00")["warum"], "Sitzung für Sitzung")
        self.assertIsNotNone(self.edge(graph, "sitzung:2026-10-02T20:00", "2026-10-02"), "die Sitzung gehört zum Tag")
        mention = self.edge(graph, "2026-10-02", "Die besten Gaming-Mäuse")
        self.assertEqual(mention["art"], "erwaehnt", "der Tag nennt die Recherche beim Namen")
        degrees = {n["id"]: n["grad"] for n in graph["knoten"]}
        self.assertGreaterEqual(degrees["Max"], 2)

    def test_automatic_links_with_a_reason(self):
        graph = self.graph()
        auto = [e for e in graph["kanten"] if e["art"] == "auto"]
        self.assertTrue(auto, "ohne [[Links]] trotzdem verknüpft")
        pairs = {frozenset((e["a"], e["b"])): e for e in auto}
        overlay = pairs.get(frozenset(("projekt:stream-overlay", "Stream-Ideen")))
        self.assertIsNotNone(overlay, "Projekt und Notiz zum Stream-Overlay gehören zusammen")
        self.assertTrue(overlay["warum"].startswith("gemeinsam: "))
        self.assertIn("Overlay", overlay["warum"], "das Wort, wie es geschrieben steht")
        self.assertIsNotNone(pairs.get(frozenset(("Streaming-Setup", "Stream-Ideen"))))
        for edge in auto:
            self.assertNotIn("Schnellnotizen", (edge["a"], edge["b"]), "Milch kaufen passt zu nichts")
            self.assertNotIn("projekt:wetter-app", (edge["a"], edge["b"]))
        per_node = {}
        for edge in auto:
            for end in (edge["a"], edge["b"]):
                per_node[end] = per_node.get(end, 0) + 1
        self.assertEqual(graph["zahlen"]["auto"], len(auto))

    def test_rebuilds_only_when_something_changed(self):
        first = self.netz.build()
        self.assertIs(self.netz.build(), first, "in den ersten Sekunden aus dem Speicher")
        with mock.patch("jarvis.wissensnetz.REBUILD_SECONDS", 0):
            self.assertIs(self.netz.build(), first, "nichts geändert")
            write(self.folder, "Notizen/Neue Idee.md", "# Neue Idee\n\nEin Overlay für Twitch mit Umfragen")
            second = self.netz.build()
        self.assertIsNot(second, first)
        self.assertIn("Neue Idee", {n["id"] for n in second["knoten"]})

    def test_related_pages_for_a_new_report(self):
        found = self.netz.related("Die besten Streaming-Mikrofone",
                                  "Für Twitch und OBS: Rode NT-USB, Shure MV7. Max nutzt das Rode.")
        self.assertIn("Streaming-Setup", found)
        self.assertIn("Max", found, "Personen beim Namen")
        self.assertNotIn("Schnellnotizen", found)
        self.assertEqual(len(found), 4, "drei Themen und die Person")
        pages = self.netz.related("Overlay", "Ein Overlay für Twitch mit Alerts", arts=("recherche", "notiz"))
        self.assertNotIn("stream-overlay", pages, "Projekte haben keine Seite im Notizbuch")
        self.assertEqual(self.netz.related("Kuchenrezept", "Mehl, Zucker, Eier und Butter verrühren"), [])

    def test_without_notebook_workshop_or_memory(self):
        empty = Netz(None).build()
        self.assertEqual([n["id"] for n in empty["knoten"]], ["Gedächtnis"])
        self.assertEqual(empty["kanten"], [])

        class Broken:
            def projects(self):
                raise RuntimeError("kaputt")

            def facts(self):
                raise RuntimeError("kaputt")

        graph = Netz(self.folder, Broken(), Broken()).build()
        self.assertIn("Max", {n["id"] for n in graph["knoten"]})

    def test_words_and_clean_text(self):
        self.assertEqual(words("Stream-Overlays für Twitch und Streaming"),
                         ["stream-overlay", "stream", "overlay", "twitch", "stream"])
        self.assertEqual(words("Sir, ich habe das heute erledigt"), [])
        self.assertEqual(clean_text("# Titel\n\nZurück zum [[Start]].\n- **Fett** und [[Max|Maxi]] <!-- jarvis:anfang -->"),
                         "- Fett und Maxi")


class NotebookLinksTest(unittest.TestCase):
    """Automatisch verknüpft: neue Berichte zeigen ihre Verwandten, das Tagebuch verlinkt sie."""

    def setUp(self):
        from jarvis.notebook import Notebook

        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        vault(self.folder)
        self.clock = Clock(dt.datetime(2026, 10, 3, 9, 15))
        self.book = Notebook(self.folder, now=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def test_new_report_links_related_pages_and_the_day(self):
        path = self.book.report("Die besten Streaming-Mikrofone",
                                "Für Twitch und OBS: Rode NT-USB oder Shure MV7. Max nutzt das Rode-Mikrofon.")
        text = path.read_text(encoding="utf-8")
        last = text.rstrip().splitlines()[-1]
        self.assertTrue(last.startswith("Verwandt: [[Streaming-Setup]]"), last)
        self.assertIn("[[Max]]", last)
        self.assertNotIn("stream-overlay", last, "Projekte haben keine Seite")
        day = (self.folder / "Tagebuch" / "2026-10-03.md").read_text(encoding="utf-8")
        self.assertIn("- **09:15** Neuer Bericht: [[Die besten Streaming-Mikrofone]]", day)
        again = self.book.report("Die besten Streaming-Mikrofone", "Noch einmal: Shure MV7 und Rode für Twitch.")
        self.assertIn("[[Die besten Streaming-Mikrofone]]", again.read_text(encoding="utf-8"), "der erste Bericht")

    def test_report_without_relatives_has_no_line(self):
        path = self.book.report("Kuchenrezept", "Mehl, Zucker, Eier und Butter verrühren, dann backen.")
        self.assertNotIn("Verwandt:", path.read_text(encoding="utf-8"))

    def test_sessions_on_the_memory_page(self):
        memory = Memory(self.folder / "g.json", now=self.clock)
        self.clock.when = dt.datetime(2026, 10, 2, 20, 0)
        memory.record("said", "Recherchiere die besten Gaming-Mäuse")
        self.clock.when = dt.datetime(2026, 10, 3, 9, 15)
        memory.record("said", "Öffne Spotify")
        self.book.sync(memory)
        page = (self.folder / "Gedächtnis.md").read_text(encoding="utf-8")
        self.assertIn("## Sitzung für Sitzung", page)
        self.assertIn("- [[2026-10-03]] 09:15–09:15 (läuft): Öffne Spotify", page)
        self.assertIn("- [[2026-10-02]] 20:00–20:00: Recherchiere die besten Gaming-Mäuse", page)
        self.assertLess(page.index("2026-10-03"), page.index("2026-10-02"), "die neueste oben")
        self.assertIn("Georgs bester Freund heißt Max.", page, "Georgs eigener Text bleibt")


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock(dt.datetime(2026, 10, 2, 20, 0))
        self.path = Path(self.temp.name) / "gedaechtnis.json"
        self.memory = Memory(self.path, now=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def say(self, text, minutes=2):
        self.memory.record("said", text)
        self.clock.when += dt.timedelta(minutes=minutes)

    def test_session_by_session(self):
        self.say("Jarvis, recherchiere die besten Gaming-Mäuse")
        self.say("Danke")
        self.say("Öffne Spotify")
        self.say("öffne spotify")
        self.say("Mein Passwort ist hallo123")
        self.clock.when += dt.timedelta(minutes=45)  # Pause: neue Sitzung
        self.say("Bau mir ein Stream-Overlay")
        sessions = self.memory.sessions()
        self.assertEqual(len(sessions), 2)
        first, second = sessions
        self.assertEqual(first["start"], "2026-10-02T20:00")
        self.assertEqual(first["ende"], "2026-10-02T20:08")
        self.assertEqual(first["anzahl"], 5)
        self.assertEqual(first["themen"], ["Recherchiere die besten Gaming-Mäuse", "Öffne Spotify"],
                         "ohne Danke, ohne Doppeltes, ohne Passwort")
        self.assertFalse(first["laufend"])
        self.assertTrue(second["laufend"])
        self.clock.when += dt.timedelta(minutes=30)
        self.assertFalse(self.memory.sessions()[-1]["laufend"], "nach 20 Minuten Pause vorbei")

    def test_sessions_stay_when_what_was_said_is_gone(self):
        self.say("Recherchiere die besten Gaming-Mäuse")
        self.clock.when = dt.datetime(2026, 10, 9, 18, 0)
        self.say("Wie spät ist es?")
        self.assertEqual([e["was"] for e in self.memory.events("said")], ["Wie spät ist es?"], "nach drei Tagen weg")
        reopened = Memory(self.path, now=self.clock)
        self.assertEqual(reopened.sessions()[0]["themen"], ["Recherchiere die besten Gaming-Mäuse"], "bleibt gespeichert")

    def test_at_most_sixty_sessions(self):
        for number in range(65):
            self.say(f"Starte Projekt {number}", minutes=30)
        sessions = self.memory.sessions()
        self.assertEqual(len(sessions), 61, "60 abgeschlossene und die laufende")
        self.assertEqual(sessions[0]["themen"], ["Starte Projekt 4"])

    def test_what_did_we_do_last_time(self):
        self.assertIn("noch nichts", self.memory.session_answer())
        self.say("Recherchiere die besten Gaming-Mäuse")
        self.say("Schreib Max, dass ich später komme")
        self.clock.when = dt.datetime(2026, 10, 3, 9, 0)
        self.say("Was haben wir zuletzt gemacht?")
        self.assertEqual(self.memory.session_answer(),
                         "Zuletzt, gestern ab 20:00 Uhr, Sir: Recherchiere die besten Gaming-Mäuse; "
                         "Schreib Max, dass ich später komme.")
        self.clock.when = dt.datetime(2026, 10, 8, 9, 0)
        self.assertTrue(self.memory.session_answer().startswith("Zuletzt, am Freitag ab 20:00 Uhr, Sir: "),
                        "die Sitzung mit nur der Frage zählt nicht")
        self.clock.when = dt.datetime(2026, 10, 20, 9, 0)
        self.assertTrue(self.memory.session_answer().startswith("Zuletzt, am 2. Oktober ab 20:00 Uhr"))

    def test_running_session_if_there_is_no_earlier_one(self):
        self.say("Öffne Steam")
        self.assertEqual(self.memory.session_answer(), "Gerade eben, heute ab 20:00 Uhr, Sir: Öffne Steam.")

    def test_context_for_the_brain(self):
        self.say("Recherchiere die besten Gaming-Mäuse")
        self.clock.when += dt.timedelta(hours=2)
        self.say("Wie spät ist es?")
        text = self.memory.context()
        self.assertIn("Die letzten Sitzungen mit Georg", text)
        self.assertIn("Fr 2.10. 20:00–20:00 (1 Befehl): Recherchiere die besten Gaming-Mäuse", text)
        self.clock.when += dt.timedelta(days=10)
        self.assertNotIn("Die letzten Sitzungen", self.memory.context(), "nur die der letzten Woche")

    def test_theme_and_question(self):
        self.assertEqual(session_theme("Jarvis, bau mir ein Overlay."), "Bau mir ein Overlay")
        for trivial in ("Ja", "Danke dir!", "Stopp", "Wie spät ist es?", "Guten Morgen", "Was haben wir zuletzt gemacht?"):
            self.assertEqual(session_theme(trivial), "", trivial)
        self.assertEqual(session_theme("Meine PIN ist 1234"), "")
        self.assertTrue(session_theme("x" * 200).endswith("…"))
        for question in ("Was haben wir zuletzt gemacht?", "Jarvis, woran haben wir zuletzt gearbeitet?",
                         "Was haben wir das letzte Mal zusammen gemacht", "Wo waren wir stehen geblieben?",
                         "Was war unsere letzte Sitzung?"):
            self.assertEqual(match_memory(question), ("session", ""), question)
        self.assertIsNone(match_memory("Was haben wir zuletzt gekauft?"))

    def test_assistant_answers_without_claude(self):
        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, *_ = make(brain)
        assistant.memory = self.memory
        assistant._disk_checked = float("inf")
        self.say("Recherchiere die besten Gaming-Mäuse")
        self.clock.when += dt.timedelta(hours=3)
        answer = assistant.handle("Woran haben wir zuletzt gearbeitet?")
        self.assertIn("Recherchiere die besten Gaming-Mäuse", answer)
        self.assertEqual(brain.asked, [])



class FakeZentrale:
    def __init__(self, states=None, shop=False):
        self.states = states or {}
        self.shop = shop

    def agent_states(self):
        base = {k: {"status": "bereit", "text": "", "zeit": "", "fortschritt": None}
                for k in ("post", "kalender", "shop", "recherche", "texte", "technik")}
        base.update(self.states)
        return base

    def has_shop(self):
        return self.shop


class FakeJob:
    def __init__(self, folder, state="running", todos=()):
        self.folder = Path(folder)
        self.state = state
        self.todos = list(todos)


class FakeShop:
    def __init__(self, job=None, projects=()):
        self.job = job
        self.items = list(projects)
        self.started = []
        self.told = []

    @property
    def busy(self):
        return self.job is not None and self.job.state == "running"

    def projects(self):
        return self.items

    def start(self, text):
        self.started.append(text)
        return "Die Werkstatt legt los, Sir."

    def tell(self, text):
        self.told.append(text)
        return "Notiert, Sir."


class SystemTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant._disk_checked = float("inf")
        self.clock = Clock(dt.datetime(2026, 10, 3, 9, 30))
        self.assistant.memory = Memory(self.folder / "g.json", now=self.clock)
        self.assistant.zentrale = FakeZentrale({"recherche": {"status": "arbeitet", "text": "Gaming-Mäuse",
                                                              "zeit": "09:28", "fortschritt": None}})
        self.assistant.workshop = FakeShop(FakeJob("C:/w/2026-10-03_0900_discord-bot", todos=[
            {"text": "a", "state": "completed"}, {"text": "b", "state": "in_progress"}]))
        self.state_dir = self.folder / "daten"
        self.system = System(self.assistant, Path(__file__).resolve().parents[1] / "jarvis_home", self.state_dir,
                             self.ui, now=self.clock)
        self.assistant.system = self.system

    def tearDown(self):
        self.temp.cleanup()

    def agents(self):
        return {a["id"]: a for a in self.system.snapshot()["agenten"]}

    def test_agents_with_live_state_skills_and_tools(self):
        agents = self.agents()
        self.assertEqual(list(agents)[:4], ["jarvis", "recherche", "texte", "technik"])
        self.assertNotIn("shop", agents, "ohne Shop-Konnektor keine Shop-Karte")
        self.assertEqual((agents["recherche"]["status"], agents["recherche"]["text"]), ("arbeitet", "Gaming-Mäuse"))
        self.assertEqual(agents["texte"]["text"], "Schreibt Mails und Posts", "der Ruhetext aus der Zentrale")
        self.assertEqual(agents["werkstatt"]["status"], "arbeitet")
        self.assertEqual(agents["werkstatt"]["text"], "Baut: Discord Bot")
        self.assertEqual(agents["werkstatt"]["fortschritt"], 0.5)
        self.assertEqual(agents["jarvis"]["status"], "bereit")
        self.assertEqual([s["name"] for s in agents["recherche"]["skills"]], ["recherche", "nachrichten"])
        self.assertTrue(all(s["beschreibung"] for s in agents["recherche"]["skills"]))
        self.assertIn("Websuche", agents["recherche"]["werkzeuge"])
        self.assertEqual(agents["blueprint"]["status"], "aus", "ohne Blaupause ausgeschaltet")
        self.assertTrue(agents["werkstatt"]["auftrag"])
        self.assertEqual(self.system.snapshot()["zahlen"]["aktiv"], 2)
        self.assistant.zentrale.shop = True
        self.assertIn("shop", self.agents())

    def test_learned_skills_belong_to_jarvis_and_get_a_button(self):
        from jarvis.skills import save_skill

        save_skill(self.state_dir, "obs-aufnahme", "Ein Video mit OBS aufnehmen und exportieren.", "1. OBS öffnen und aufnehmen")
        jarvis = self.agents()["jarvis"]
        self.assertIn({"name": "obs-aufnahme", "beschreibung": "Ein Video mit OBS aufnehmen und exportieren.", "gelernt": True},
                      jarvis["skills"])
        buttons = {q["id"]: q for q in self.system.quick()}
        self.assertIn("gelernt:obs-aufnahme", buttons)
        self.assertEqual(self.system.skill_sentence("gelernt:obs-aufnahme"), "Nutze deine Fähigkeit obs-aufnahme")
        self.assertIsNone(self.system.skill_sentence("gelernt:gibt-es-nicht"))

    def test_skill_buttons_become_sentences(self):
        self.assertEqual(self.system.skill_sentence("briefing"), "Briefing")
        self.assertIsNone(self.system.skill_sentence("recherche"), "erst sagen, was")
        self.assertEqual(self.system.skill_sentence("recherche", "  beste   Mäuse "), "Recherchiere gründlich: beste Mäuse")
        self.assertIsNone(self.system.skill_sentence("gibt-es-nicht"))
        self.assertGreaterEqual(len(QUICK), 9, "wie im Video: mindestens neun Skills bereit")

    def test_skill_sentences_reach_the_right_place(self):
        from jarvis.blaupause import _MAKE, _STRONG_VERB, _norm as blueprint_norm
        from jarvis.memory import match_memory as memory_match
        from jarvis.notebook import match_notebook
        from jarvis.spiele import _UPDATES
        from jarvis.stream import _PREPARE, _norm as stream_norm
        from jarvis.weltlage import _WORLD, _norm as world_norm
        from jarvis.workshop import is_workshop_request
        from jarvis.zentrale import wants_briefing

        sentence = self.system.skill_sentence
        self.assertTrue(wants_briefing(sentence("briefing"), 15))
        self.assertTrue(_PREPARE.match(stream_norm(sentence("stream"))))
        self.assertTrue(_UPDATES.search(sentence("spiele").lower()))
        self.assertTrue(_WORLD.match(world_norm(sentence("weltlage"))))
        self.assertEqual(memory_match(sentence("sitzung")), ("session", ""))
        self.assertEqual(match_notebook(sentence("notiz", "Milch kaufen")), ("note", "Milch kaufen"))
        self.assertTrue(_PREPARE.match(stream_norm(self.system.agent_sentence("stream", "Valorant"))))
        made = blueprint_norm(self.system.agent_sentence("blueprint", "einen Iron-Man-Helm"))
        self.assertTrue(_MAKE.match(made) and _STRONG_VERB.match(made))
        for agent in ("recherche", "texte", "technik", "post", "kalender", "shop"):
            text = self.system.agent_sentence(agent, "Eine Mail an Max schreiben")
            self.assertFalse(is_workshop_request(text), text)
        for skill in ("heute", "woche", "mails", "pc"):
            self.assertFalse(is_workshop_request(sentence(skill)), skill)
        self.assertIsNone(self.system.agent_sentence("werkstatt", "Ein Spiel"), "die Werkstatt startet direkt")
        self.assertIsNone(self.system.agent_sentence("recherche", "   "))

    def test_show_the_system_by_voice(self):
        answer = self.assistant.handle("Zeig mir das System")
        self.assertTrue(answer.startswith("Das System, Sir."))
        self.assertIn(("system", {"action": "show"}), self.ui.events)
        self.assertEqual(self.brain.asked, [])
        for said in ("Öffne das Wissensnetz", "Jarvis, zeig mir alle Agents", "Agentic OS", "Zeig den Graph"):
            self.assertEqual(match_system(said), "show", said)
        for said in ("Öffne die Systemsteuerung", "Zeig mir das Wetter", "Wie läuft das System?", "Systemsteuerung"):
            self.assertIsNone(match_system(said), said)

    def test_who_is_working(self):
        answer = self.assistant.handle("Welche Agents laufen gerade?")
        self.assertEqual(answer, "Gerade arbeiten Recherche (Gaming-Mäuse) und Werkstatt (Baut: Discord Bot), Sir.")
        self.assistant.zentrale.states = {}
        self.assistant.workshop.job = None
        self.assertEqual(self.assistant.handle("Wer arbeitet gerade?"),
                         "Gerade arbeitet keiner meiner Spezialisten, Sir. Alle sind bereit.")

    def test_automations_and_sessions(self):
        from jarvis.zeitplan import Schedules

        self.assistant.schedules = Schedules(self.folder / "z.json")
        self.assistant.schedules.add([0, 1, 2, 3, 4], dt.time(8, 0), "Briefing")
        self.assistant.memory.teach("Zockmodus", "öffne Discord und Steam")
        self.assistant.memory.record("said", "Recherchiere die besten Gaming-Mäuse")
        snap = self.system.snapshot()
        self.assertEqual(snap["automationen"]["befehle"][0]["name"], "Zockmodus")
        plan = snap["automationen"]["zeitplaene"][0]
        self.assertEqual((plan["tage"], plan["uhrzeit"], plan["befehl"]), ("werktags", "08:00", "Briefing"))
        session = snap["gedaechtnis"]["sitzungen"][0]
        self.assertEqual((session["tag"], session["von"], session["laufend"]), ("Heute", "09:30", True))
        self.assertEqual(session["themen"], ["Recherchiere die besten Gaming-Mäuse"])

    def test_graph_and_open(self):
        from jarvis.notebook import Notebook

        vault(self.folder / "Notizbuch")
        self.assistant.notebook = Notebook(self.folder / "Notizbuch", now=self.clock)
        graph = self.system.graph()
        self.assertTrue(graph["notizbuch"])
        self.assertIn("Max", {n["id"] for n in graph["knoten"]})
        self.assertIn("projekt:x", {n["id"] for n in Netz(None, FakeWorkshop([{"name": "x"}])).build()["knoten"]})
        self.assertEqual(self.system.open_node("gibt-es-nicht")["ok"], False)
        with mock.patch("jarvis.system.open_path", return_value="obsidian") as opened:
            self.assertEqual(self.system.open_node("Max"), {"ok": True, "wie": "obsidian"})
        self.assertEqual(opened.call_args[0][0], self.folder / "Notizbuch" / "Personen" / "Max.md")

    def test_window_api(self):
        from jarvis.gui.app import Api

        api = Api.__new__(Api)
        api._assistant = self.assistant
        sent = []
        self.assistant.submit = lambda text, speak=True: sent.append(text)
        self.assertEqual(api.system_skill("recherche", "Gaming-Mäuse"), {"ok": True, "satz": "Recherchiere gründlich: Gaming-Mäuse"})
        self.assertFalse(api.system_skill("recherche", "")["ok"])
        self.assertEqual(api.system_agent("texte", "Absage an den Vermieter")["satz"],
                         "Gib das an deinen Spezialisten für Texte: Absage an den Vermieter")
        self.assertEqual(sent, ["Recherchiere gründlich: Gaming-Mäuse", "Gib das an deinen Spezialisten für Texte: Absage an den Vermieter"])
        announced = []
        self.assistant.announce = announced.append
        result = api.system_agent("werkstatt", "Highscore einbauen")
        self.assertTrue(result["laufend"], "die Werkstatt baut gerade: der Wunsch geht in die laufende Arbeit")
        for _ in range(50):
            if announced:
                break
            time.sleep(0.02)
        self.assertEqual(self.assistant.workshop.told, ["Highscore einbauen"])
        self.assertEqual(announced, ["Notiert, Sir."])
        self.assertIn("Werkstatt: Highscore einbauen", self.assistant.memory.sessions()[-1]["themen"])
        self.assertFalse(api.system_agent("werkstatt", " ")["ok"])
        self.assertIsNotNone(api.system_state())
        self.assertEqual(api.system_open("gibt-es-nicht")["ok"], False)


if __name__ == "__main__":
    unittest.main()
