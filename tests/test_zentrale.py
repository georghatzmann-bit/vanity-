"""Die Kommandozentrale (zentrale.py) und ihr Lagebild über die Konnektoren (lage.py)."""

import datetime as dt
import io
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from tests.helpers import make_fake_claude
from jarvis import lage
from jarvis.brain import ClaudeBrain
from jarvis.config import load_config
from jarvis.reminders import ReminderStore
from jarvis.steps import describe
from jarvis.zentrale import Listener, Zentrale, euro, wants_briefing, wants_refresh, wants_view

posix_only = unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")

MORNING = dt.datetime(2026, 10, 3, 7, 15)

LAGE = {
    "post": {"neu": 17, "ungelesen": 5, "zahlen": {"wichtig": 1, "offen": 4, "beantwortet": 11, "werbung": 1},
             "mails": [
                 {"von": "Tobias Lenz", "betreff": "Budgetfreigabe Q4", "zeit": "07:03", "status": "wichtig", "id": "18a1"},
                 {"von": "Katrin", "betreff": "Kooperation", "zeit": "06:41", "status": "beantwortet", "id": "18a2"},
                 {"von": "Adtech", "betreff": "Ihre Kampagnen", "zeit": "gestern", "status": "werbung", "id": "18a3"}]},
    "kalender": {"heute": [{"start": "09:30", "ende": "10:00", "titel": "Gespräch Team"},
                           {"start": "14:00", "ende": "15:30", "titel": "Vertragsabschluss", "wichtig": True}],
                 "woche": 3},
    "shop": {"name": "Laden", "umsatz_heute": 312.5, "umsatz_gestern": 840, "bestellungen_heute": 4,
             "bestellungen_gestern": 9, "offen": 2},
    "hinweise": ["Die Budgetfreigabe braucht heute bis 12 Uhr Ihre Antwort."],
}


class RecordingZentraleUi:
    def __init__(self):
        self.events = []

    def zentrale(self, event):
        self.events.append(event)

    def of(self, action):
        return [e for e in self.events if e.get("action") == action]


class FakeAssistant:
    def __init__(self, folder: Path):
        self.reminders = ReminderStore(folder / "erinnerungen.json")
        self.gaming = False
        self.away = 5.0
        self.offer = False

    def idle(self):
        return self.away

    def weather_today(self):
        return "Heute in Wien 9 bis 18 Grad, leicht bewölkt"

    def offer_open(self):
        return self.offer


class FakeBrain:
    claude_path = "claude"
    connectors = True

    def __init__(self, answer="", error=None, delay=0.0):
        self.answer = answer
        self.error = error
        self.delay = delay
        self.jobs = []

    def connector_job(self, prompt, system_file, model="sonnet", effort="low", allow=None, cancel=None, timeout=180):
        self.jobs.append({"prompt": prompt, "system": Path(system_file).read_text(encoding="utf-8"), "model": model,
                          "effort": effort, "allow": allow})
        time.sleep(self.delay)
        if self.error:
            raise self.error
        return self.answer


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def tagesschau(request, timeout=6):
    url = request.full_url
    if "channels" in url:
        body = {"channels": [
            {"title": "Im Livestream: tagesschau24", "streams": {"adaptivestreaming": "https://example.org/live.m3u8"}},
            {"title": "tagesschau in 100 Sekunden", "streams": {"h264m": "https://example.org/100s.mp4"},
             "teaserImage": {"imageVariants": {"16x9-512": "https://images.tagesschau.de/a.jpg"}}}]}
    else:
        body = {"news": [
            {"title": "Erste Meldung", "topline": "Welt", "shareURL": "https://www.tagesschau.de/eins.html",
             "teaserImage": {"imageVariants": {"16x9-512": "https://images.tagesschau.de/b.jpg"}}},
            {"title": "Ein Video", "type": "video"},
            {"title": "Erste Meldung"},
            {"title": "Zweite Meldung", "shareURL": "https://boese.example/x", "teaserImage": {"imageVariants": {
                "16x9-512": "https://boese.example/bild.jpg"}}}]}
    return _Response(json.dumps(body).encode("utf-8"))


class LageTest(unittest.TestCase):
    """Im Hintergrund darf Jarvis über die Konnektoren nur lesen."""

    def test_only_reading_connector_tools(self):
        allowed = ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread",
                   "mcp__claude_ai_Google_Calendar__list_events", "mcp__claude_ai_Shopify__list-orders",
                   "mcp__claude_ai_Shopify__run-analytics-query", "mcp__claude_ai_Windsor_ai__get_data", "ToolSearch",
                   "mcp__claude_ai_Shopify__get-shop-info", "mcp__claude_ai_Google_Calendar__list_calendars",
                   "mcp__x__listEvents", "mcp__claude_ai_Shopify__graphql_query"]
        denied = ["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__create_draft",
                  "mcp__claude_ai_Gmail__label_thread", "mcp__claude_ai_Gmail__trash_thread",
                  "mcp__claude_ai_Google_Calendar__create_event", "mcp__claude_ai_Google_Calendar__respond_to_event",
                  "mcp__claude_ai_Shopify__update-product", "mcp__claude_ai_Shopify__graphql_mutation",
                  "mcp__claude_ai_Windsor_ai__execute_action", "Bash", "PowerShell", "Write", "WebFetch", "",
                  # nur ein Hauptwort wie "shop" oder "messages" reicht nicht, es braucht ein lesendes Verb
                  "mcp__claude_ai_Shopify__switch-shop", "mcp__claude_ai_Shopify__open-digital-products-install",
                  "mcp__claude_ai_Gmail__clear_messages", "mcp__claude_ai_Gmail__star_messages",
                  "mcp__claude_ai_Gmail__batchModifyMessages", "mcp__x__createEvent"]
        for tool in allowed:
            self.assertTrue(lage.read_only(tool)[0], tool)
        for tool in denied:
            ok, why = lage.read_only(tool)
            self.assertFalse(ok, tool)
            self.assertTrue(why, tool)

    def test_answer_is_checked_and_trimmed(self):
        text = "Gern!\n```json\n" + json.dumps({
            "post": {"neu": "17", "ungelesen": -3, "mails": [
                {"von": "  Max   Muster ", "betreff": "x" * 200, "zeit": "7:05", "status": "SPAM", "id": "a/b?c"},
                {"von": "Bank", "betreff": "Auszug", "zeit": "gestern", "status": "wichtig"},
                "kaputt"]},
            "kalender": {"heute": [{"start": "14:00", "ende": "15:00", "titel": "Abschluss", "wichtig": 1},
                                   {"start": "Tag", "titel": "Feiertag"}, {"start": "09:00", "titel": ""}]},
            "shop": {"umsatz_heute": "312,50", "bestellungen_heute": 4.0, "waehrung": "eur"},
            "werbung": {"konten": []},
            "hinweise": ["Eins", "", 5, "Zwei", "Drei", "Vier"],
            "unbekannt": {"geheim": True}}) + "\n```\nViel Spaß."
        data = lage.parse(text)
        self.assertEqual(set(data), {"post", "kalender", "shop", "hinweise"})
        post = data["post"]
        self.assertEqual(post["neu"], 17)
        self.assertIsNone(post["ungelesen"])
        self.assertEqual([m["status"] for m in post["mails"]], ["wichtig", "offen"], "Wichtiges zuerst")
        self.assertEqual(post["mails"][1]["von"], "Max Muster")
        self.assertEqual(post["mails"][1]["zeit"], "07:05")
        self.assertEqual(post["mails"][1]["id"], "abc")
        self.assertLessEqual(len(post["mails"][1]["betreff"]), 71)
        self.assertEqual(post["zahlen"], {"wichtig": 1, "offen": 1, "beantwortet": 0, "werbung": 0})
        self.assertEqual([e["start"] for e in data["kalender"]["heute"]], ["Tag", "14:00"])
        self.assertTrue(data["kalender"]["heute"][1]["wichtig"])
        self.assertEqual(data["shop"]["umsatz_heute"], 312.5)
        self.assertEqual(data["shop"]["waehrung"], "EUR")
        self.assertEqual(data["hinweise"], ["Eins", "Zwei", "Drei"])
        with self.assertRaises(ValueError):
            lage.parse("Leider nichts gefunden.")

    def test_prompt_names_day_and_connectors(self):
        text = lage.prompt(["Gmail", "Shopify"], MORNING)
        self.assertIn("Samstag, der 03.10.2026", text)
        self.assertIn("Konnektoren: Gmail, Shopify", text)
        self.assertIn('"zahlen"', text)


class ZentraleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.ui = RecordingZentraleUi()
        self.assistant = FakeAssistant(self.folder)
        self.now = MORNING
        self.said = []
        self.shown = []

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, brain=None, cfg=None):
        return Zentrale(cfg or {}, brain, self.ui, self.folder, self.assistant, tell=self.said.append,
                        now=lambda: self.now, opener=tagesschau, show_window=lambda: self.shown.append(True))

    def with_lage(self, zentrale, data=LAGE):
        zentrale.lage = lage.clean(data)
        zentrale.lage_at = self.now - dt.timedelta(minutes=5)
        return zentrale

    def test_snapshot_shows_the_day(self):
        z = self.with_lage(self.make())
        self.assistant.reminders.add(dt.datetime(2026, 10, 3, 17, 30), "Paket abholen")
        self.assertEqual(z.snapshot()["nachrichten"]["schlagzeilen"], [], "das Fenster wartet nie auf die Tagesschau")
        z.news()
        data = z.snapshot()
        self.assertEqual([k["name"] for k in data["kennzahlen"]][0], "Umsatz heute")
        self.assertEqual(data["kennzahlen"][0]["wert"], "312,50 €")
        self.assertEqual(data["kennzahlen"][-1]["name"], "Rückfragen an Sie")
        self.assertEqual(data["kennzahlen"][-1]["wert"], "1", "die wichtige Mail")
        self.assertEqual(data["konto"]["titel"], "Shop · Laden")
        plan = [(e["start"], e["art"]) for e in data["tagesplan"]["eintraege"]]
        self.assertEqual(plan, [("09:30", "termin"), ("14:00", "termin"), ("17:30", "erinnerung")])
        self.assertTrue([e for e in data["tagesplan"]["eintraege"] if e["titel"] == "Vertragsabschluss"][0]["wichtig"])
        self.assertEqual(data["post"]["mails"][0]["status"], "wichtig")
        self.assertEqual(data["lage"]["alter"], 5)
        self.assertEqual(data["nachrichten"]["live"], "https://example.org/live.m3u8")
        self.assertEqual(data["nachrichten"]["video"], "https://example.org/100s.mp4")
        titles = [h["titel"] for h in data["nachrichten"]["schlagzeilen"]]
        self.assertEqual(titles, ["Erste Meldung", "Zweite Meldung"], "ohne Video und ohne Doppelte")
        self.assertEqual(data["nachrichten"]["schlagzeilen"][1]["bild"], "", "nur Bilder der Tagesschau")
        self.assertEqual(data["nachrichten"]["schlagzeilen"][1]["link"], "")
        self.assertEqual([a["id"] for a in data["agenten"]][:3], ["post", "kalender", "shop"])

    def test_without_connectors_jarvis_own_day(self):
        z = self.make()
        Listener(z).progress({"tool": "Jarvis", "label": "Öffnet Spotify", "state": "done"})
        data = z.snapshot()
        self.assertEqual(data["kennzahlen"][0]["name"], "Heute erledigt")
        self.assertEqual(data["kennzahlen"][0]["wert"], "1")
        self.assertNotIn("shop", [a["id"] for a in data["agenten"]], "ohne Shop keine Shop-Karte")
        self.assertFalse(data["post"]["verbunden"])
        self.assertFalse(data["lage"]["moeglich"])

    def test_briefing_reads_mails_shop_and_calendar(self):
        z = self.with_lage(self.make())
        z.news()
        parts = z.briefing()
        areas = [p["bereich"] for p in parts]
        self.assertEqual(areas, ["kopf", "aktivitaet", "post", "kennzahlen", "tagesplan", "rueckfragen", "nachrichten",
                                 "orb"])
        self.assertTrue(parts[0]["text"].startswith("Guten Morgen, Sir. Ich bin seit 7:15 Uhr im Dienst. Heute in Wien"))
        self.assertIn("war ich bereits beschäftigt", parts[1]["text"])
        self.assertEqual(parts[6]["text"], "In den Nachrichten: Erste Meldung.")
        parts = parts[:1] + parts[2:]
        post = parts[1]
        self.assertIn("Seit gestern sind 17 neue Nachrichten eingegangen.", post["text"])
        self.assertIn("11 sind schon beantwortet, 4 können warten und eine will Ihnen etwas verkaufen.", post["text"])
        self.assertIn("Und eine sollten Sie sich tatsächlich ansehen: Tobias Lenz, Budgetfreigabe Q4.", post["text"])
        self.assertEqual(post["ziel"], "18a1")
        self.assertEqual(post["titel"], "Eine Mail sollten Sie ansehen")
        self.assertIn("Heute 4 Bestellungen mit 312,50 € Umsatz.", parts[2]["text"])
        self.assertIn("Heute stehen 2 Termine an. Der wichtigste um 14 Uhr: Vertragsabschluss.", parts[3]["text"])
        self.assertEqual(parts[3]["ziel"], "14:00 Vertragsabschluss")
        self.assertEqual(parts[-1]["text"], "Das wäre alles für den Moment, Sir. Was kann ich für Sie tun?")
        self.assistant.reminders.add(dt.datetime(2026, 10, 3, 17, 30), "Paket abholen.")
        plan = [p for p in z.briefing() if p["bereich"] == "tagesplan"][0]["text"]
        self.assertTrue(plan.endswith(" Dazu eine Erinnerung um 17:30 Uhr: Paket abholen."), plan)
        self.assistant.reminders.add(dt.datetime(2026, 10, 3, 16, 0), "Zahnarzt anrufen")
        plan = [p for p in z.briefing() if p["bereich"] == "tagesplan"][0]["text"]
        self.assertTrue(plan.endswith(" Dazu 2 Erinnerungen, die nächste um 16 Uhr: Zahnarzt anrufen."), plan)

    def test_briefing_without_voice_is_one_answer(self):
        z = self.with_lage(self.make())
        text = z.command("Briefing", speak=False)
        self.assertIn("Beginnen wir mit Ihren Mails.", text)
        self.assertIn("Was kann ich für Sie tun?", text)
        self.assertEqual(z.briefed, MORNING.date())
        self.assertEqual(z.events_today()[-1]["text"], "Briefing gehalten")

    def test_briefing_speaks_part_by_part_and_highlights(self):
        z = self.with_lage(self.make())
        first = z.command("Guten Morgen")
        self.assertTrue(first.startswith("Guten Morgen, Sir."))
        deadline = time.monotonic() + 5
        while z.briefed is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(z.briefed, MORNING.date())
        focused = [e["bereich"] for e in self.ui.of("focus")]
        self.assertEqual(focused[0], "kopf")
        self.assertEqual(focused[1:5], ["aktivitaet", "post", "kennzahlen", "tagesplan"])
        self.assertIn("nachrichten", focused, "die Schlagzeilen holt das Briefing selbst")
        self.assertEqual(focused[-1], "", "am Ende leuchtet nichts mehr")
        self.assertEqual(self.said[0], z.briefing()[1]["text"])
        self.assertTrue(self.ui.of("show"))
        self.assertEqual(self.shown, [True], "das Fenster kommt nach vorne")

    def test_no_window_while_gaming_and_stop_ends_briefing(self):
        z = self.with_lage(self.make())
        self.assistant.gaming = True
        gate = threading.Event()
        z._spoken = lambda timeout=None: gate.wait(2)
        z.command("Briefing")
        self.assertEqual(self.shown, [], "nicht über ein Spiel legen")
        self.assertTrue(z.cancel())
        gate.set()
        time.sleep(0.3)
        self.assertEqual(self.said, [], "nach Stopp kein weiterer Abschnitt")
        self.assertIsNone(z.briefed)
        self.assertFalse(z.cancel(), "läuft keins mehr")

    def test_sentences_for_the_zentrale(self):
        for text in ("Briefing", "Gib mir das Briefing", "Was steht heute an?", "Jarvis, wie sieht mein Tag aus"):
            self.assertTrue(wants_briefing(text, 15), text)
        self.assertTrue(wants_briefing("Guten Morgen, Jarvis", 8))
        self.assertFalse(wants_briefing("Guten Morgen", 15), "nachmittags nur ein Gruß")
        self.assertFalse(wants_briefing("Mach das Briefing auf Englisch fertig und schick es an Max", 8))
        self.assertTrue(wants_view("Zeig die Zentrale"))
        self.assertTrue(wants_view("Kommandozentrale"))
        self.assertTrue(wants_refresh("Aktualisiere die Zentrale"))
        self.assertTrue(wants_refresh("Hol die neuesten Mails"))
        self.assertFalse(wants_refresh("Schreib Max eine Mail"))

    def test_refresh_reads_in_background_and_reminds_before_the_important_event(self):
        answer = "```json\n" + json.dumps(LAGE) + "\n```"
        brain = FakeBrain(answer)
        z = self.make(brain)
        self.assertTrue(z.refresh("Test"))
        self.assertTrue(z.wait_lage(5))
        job = brain.jobs[0]
        self.assertIs(job["allow"], lage.read_only)
        self.assertEqual(job["model"], "sonnet")
        self.assertIn("NUR mit einem JSON-Objekt", job["system"])
        self.assertEqual(z.lage["post"]["neu"], 17)
        agents = {a["id"]: a for a in z.snapshot()["agenten"]}
        self.assertEqual(agents["post"]["status"], "wartet", "eine wichtige Mail wartet auf Georg")
        self.assertEqual(agents["kalender"]["status"], "fertig")
        self.assertIn("Lagebild aktualisiert: 17 Mails, 2 Termine, 4 Bestellungen", [e["text"] for e in z.events_today()])
        reminders = self.assistant.reminders.upcoming(self.now)
        self.assertEqual([(r["zeit"], r["text"]) for r in reminders],
                         [("2026-10-03T13:45:00", "In einer Viertelstunde: Vertragsabschluss")])
        z._remind_important()
        self.assertEqual(len(self.assistant.reminders.upcoming(self.now)), 1, "nicht doppelt")
        self.assertNotIn("In einer Viertelstunde", json.dumps(z.snapshot()["tagesplan"], ensure_ascii=False))
        plan = [p for p in z.briefing() if p["bereich"] == "tagesplan"][0]
        self.assertIn("Und ich erinnere Sie rechtzeitig daran.", plan["text"])
        # Der Stand bleibt bis zum nächsten Start (am selben Tag)
        again = self.make()
        self.assertEqual(again.lage["post"]["neu"], 17)
        self.assertEqual(again.events_today()[-1]["text"], z.events_today()[-1]["text"])

    def test_failed_refresh_keeps_working(self):
        brain = FakeBrain(error=RuntimeError("Claude Code fehlt\nmehr"))
        z = self.make(brain)
        self.assertTrue(z.refresh())
        self.assertTrue(z.wait_lage(5))
        self.assertEqual(z.lage_error, "Claude Code fehlt")
        self.assertEqual({a["status"] for a in z.snapshot()["agenten"] if a["id"] in ("post", "kalender")}, {"fehler"})
        self.assertEqual(z.lage, {})
        z.briefing()  # geht trotzdem

    def test_failing_refresh_waits_longer_each_time(self):
        brain = FakeBrain(error=RuntimeError("Limit erreicht"))
        z = self.make(brain)
        waits = []
        for _ in range(6):
            z._next_try = 0.0
            z.tick()
            self.assertTrue(z.wait_lage(5))
            waits.append(round((z._next_try - time.monotonic()) / 60))
        self.assertEqual(waits, [5, 10, 20, 40, 60, 60], "Minuten bis zum nächsten Versuch")
        z.tick()
        self.assertEqual(len(brain.jobs), 6, "vor Ablauf der Wartezeit kein neuer Versuch")
        brain.error, brain.answer = None, "{}"
        self.assertTrue(z.refresh("Georg fragt"), "von Hand geht es jederzeit")
        self.assertTrue(z.wait_lage(5))
        self.assertEqual((z._failures, z.lage_error), (0, ""))

    def test_tick_refreshes_only_when_sensible(self):
        brain = FakeBrain("{}")
        z = self.make(brain)
        self.assistant.gaming = True
        z.tick()
        self.assistant.gaming = False
        self.assistant.away = 3600
        z.tick()
        self.assertEqual(brain.jobs, [], "nicht beim Spielen und nicht, wenn Georg weg ist")
        self.assistant.away = 5
        z.tick()
        self.assertTrue(z.wait_lage(5))
        self.assertEqual(len(brain.jobs), 1)
        z.tick()
        self.assertEqual(len(brain.jobs), 1, "frisch genug")

    def test_window_closed_means_fewer_runs(self):
        brain = FakeBrain("{}")
        z = self.make(brain)
        z.tick()
        self.assertTrue(z.wait_lage(5))
        self.assistant.window_visible = lambda: False
        self.now = MORNING + dt.timedelta(minutes=45)
        z.tick()
        self.assertEqual(len(brain.jobs), 1, "Fenster zu: niemand sieht die Zentrale, das schont das Claude-Abo")
        self.now = MORNING + dt.timedelta(minutes=125)
        z._next_try = 0  # die fünf Minuten Abstand zwischen zwei Versuchen sind hier egal
        z.tick()
        self.assertTrue(z.wait_lage(5))
        self.assertEqual(len(brain.jobs), 2, "nach zwei Stunden auch im Hintergrund")
        self.assistant.window_visible = lambda: True
        self.now = MORNING + dt.timedelta(minutes=160)
        z._next_try = 0
        z.tick()
        self.assertTrue(z.wait_lage(5))
        self.assertEqual(len(brain.jobs), 3, "Fenster offen: alle 30 Minuten")

    def test_listener_logs_what_jarvis_did(self):
        z = self.make()
        listener = Listener(z)
        listener.progress({"tool": "Jarvis", "label": "Öffnet Spotify", "state": "done"})
        listener.progress({"tool": "Jarvis", "label": "Öffnet Spotify", "state": "done"})
        listener.progress({"tool": "Read", "label": "Liest notizen.md", "state": "done", "kind": "read"})
        listener.progress({"tool": "mcp__claude_ai_Gmail__search_threads", "label": "Nutzt Gmail", "state": "done"})
        listener.progress({"tool": "Bash", "label": "Installiert Steam", "state": "done", "kind": "install"})
        listener.progress({"tool": "Write", "label": "Schreibt bot.py", "state": "done", "kind": "file", "workshop": True})
        listener.workshop({"state": "done", "summary": "Der Bot ist fertig, Sir. Starten Sie ihn mit start.bat."})
        listener.blueprint({"action": "done", "ok": True, "scene": {"name": "Drohne"}})
        listener.blueprint({"action": "render", "state": "done"})
        listener.world({"action": "news", "items": [{}, {}], "title": "Lage · Welt"})
        texts = [e["text"] for e in z.events_today()]
        self.assertEqual(texts, ["Öffnet Spotify", "Nutzt Gmail", "Installiert Steam", "Werkstatt: Der Bot ist fertig, Sir.",
                                 "Blueprint: Drohne gebaut", "Blueprint: Foto aus Blender", "Lagebericht: 2 Meldungen"])

    def test_helpers_show_on_their_cards(self):
        z = self.make()
        listener = Listener(z)
        step = describe("t1", "Agent", {"description": "Preise vergleichen", "subagent_type": "recherche"})
        self.assertEqual(step.to_dict()["agent"], "recherche")
        listener.progress(step.to_dict())
        card = {a["id"]: a for a in z.snapshot()["agenten"]}["recherche"]
        self.assertEqual((card["status"], card["text"]), ("arbeitet", "Preise vergleichen"))
        step.finish()
        listener.progress(step.to_dict())
        card = {a["id"]: a for a in z.snapshot()["agenten"]}["recherche"]
        self.assertEqual(card["status"], "fertig")
        self.assertEqual(z.events_today()[-1]["text"], "Recherche: Preise vergleichen")

    def test_helpers_rest_after_half_an_hour_and_old_days_are_tidied(self):
        z = self.make()
        z.agent("recherche", "fertig", "Preise verglichen")
        z.agent("post", "fertig", "3 neue Mails")
        self.now = MORNING + dt.timedelta(minutes=45)
        cards = {a["id"]: a for a in z.snapshot()["agenten"]}
        self.assertEqual((cards["recherche"]["status"], cards["recherche"]["text"]), ("bereit", "Bereit für Ihre Fragen"))
        self.assertEqual(cards["post"]["status"], "fertig", "das Lagebild bleibt bis zum nächsten")
        old = self.folder / "zentrale" / "aktivitaet-2026-09-01.json"
        recent = self.folder / "zentrale" / "aktivitaet-2026-10-01.json"
        old.parent.mkdir(parents=True, exist_ok=True)
        for path in (old, recent):
            path.write_text("[]", encoding="utf-8")
        self.make()
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_headlines_retry_soon_after_a_failure(self):
        calls = []

        def offline_then_online(request, timeout=6):
            calls.append(request.full_url)
            if len(calls) <= 2:
                raise OSError("Das WLAN ist noch nicht da")
            return tagesschau(request, timeout)

        z = Zentrale({}, None, RecordingZentraleUi(), self.folder, self.assistant, now=lambda: self.now,
                     opener=offline_then_online)
        self.assertFalse(z.cached_news()["geladen"], "noch nie versucht: die Kachel sagt \"werden geladen\"")
        first = z.news()
        self.assertEqual(first["schlagzeilen"], [])
        self.assertTrue(first["geladen"])
        self.assertEqual(len(calls), 2)
        z.news()
        self.assertEqual(len(calls), 2, "nicht jede Sekunde")
        z._news_at -= 61  # eine Minute später
        self.assertEqual([h["titel"] for h in z.news()["schlagzeilen"]], ["Erste Meldung", "Zweite Meldung"])
        z._news_at -= 61
        z.news()
        self.assertEqual(len(calls), 4, "mit Schlagzeilen wieder nur alle 15 Minuten")

    def test_new_day_starts_empty(self):
        z = self.make()
        z.log("befehl", "Gestern")
        self.now = MORNING + dt.timedelta(days=1)
        self.assertEqual(z.events_today(), [])

    def test_euro(self):
        self.assertEqual(euro(1234.5), "1.234,50 €")
        self.assertEqual(euro(840), "840 €")
        self.assertEqual(euro(None), "–")


class WiringTest(unittest.TestCase):
    """Jarvis leitet die Sätze an die Zentrale, das Fenster bekommt nur den neuesten Stand."""

    def test_assistant_routes_briefing_and_stop(self):
        from tests.test_assistant import make

        with TemporaryDirectory() as tmp:
            assistant, ui, speaker, _ = make()
            fake = FakeAssistant(Path(tmp))
            assistant.reminders = fake.reminders
            assistant.zentrale = Zentrale({}, None, RecordingZentraleUi(), Path(tmp), assistant,
                                          now=lambda: MORNING, opener=tagesschau)
            answer = assistant.handle("Was steht heute an?", speak=False)
            self.assertTrue(answer.startswith("Guten Morgen, Sir."))
            self.assertIn("Was kann ich für Sie tun?", answer)
            self.assertEqual(assistant.brain.asked, [], "ohne Claude, sofort")
            with mock.patch.object(assistant.zentrale, "cancel") as cancel:
                assistant.stop()
            cancel.assert_called_once()

    def test_window_gets_only_the_newest_state(self):
        from jarvis.gui.app import Api, GuiBridge

        bridge = GuiBridge()
        bridge.zentrale({"action": "update", "data": {"n": 1}})
        bridge.zentrale({"action": "focus", "bereich": "post"})
        bridge.zentrale({"action": "update", "data": {"n": 2}})
        events = bridge.drain()
        self.assertEqual([(e["action"], e.get("data")) for e in events], [("focus", None), ("update", {"n": 2})])
        for name in ("zentrale_state", "zentrale_refresh", "zentrale_briefing", "zentrale_stop", "zentrale_open"):
            self.assertTrue(callable(getattr(Api, name, None)), name)

    def test_window_opens_only_fixed_addresses(self):
        from jarvis.gui.app import Api, GuiBridge

        api = Api(GuiBridge(), mock.Mock(), None)
        with mock.patch("webbrowser.open", return_value=True) as browser:
            self.assertTrue(api.zentrale_open("mail", "18a1'><script>"))
            self.assertTrue(api.zentrale_open("kalender"))
            self.assertFalse(api.zentrale_open("javascript:alert(1)"))
        self.assertEqual([c.args[0] for c in browser.call_args_list],
                         ["https://mail.google.com/mail/u/0/#all/18a1script", "https://calendar.google.com/calendar/r/day"])


@posix_only
class ConnectorJobTest(unittest.TestCase):
    """Der Hintergrund-Prozess mit einem Test-Claude, das wie das echte zurückfragt."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        cfg = load_config()["brain"]
        cfg["claude_path"] = str(make_fake_claude(self.home))
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(cfg, self.home, self.home / "daten")

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_but_never_sends(self):
        ui = RecordingZentraleUi()
        assistant = FakeAssistant(self.home)
        z = Zentrale({}, self.brain, ui, self.home / "daten", assistant, now=lambda: dt.datetime(2026, 10, 3, 8, 0),
                     opener=tagesschau)
        self.assertTrue(z.can_refresh())
        with mock.patch("jarvis.konnektoren.seen", return_value=[{"name": "Gmail", "ok": True}]):
            self.assertTrue(z.refresh("Test"))
            self.assertTrue(z.wait_lage(30))
        self.assertEqual(z.lage_error, "")
        self.assertEqual(z.lage["post"]["neu"], 3)
        self.assertEqual(z.lage["kalender"]["heute"][0]["titel"], "Spätes Telefonat")
        replies = [json.loads(line) for line in (self.home / "permissions.jsonl").read_text(encoding="utf-8").splitlines()]
        decisions = {r["tool"]: r["reply"]["response"]["response"]["behavior"] for r in replies}
        self.assertEqual(decisions, {"mcp__claude_ai_Gmail__search_threads": "allow",
                                     "mcp__claude_ai_Gmail__send_message": "deny", "Bash": "deny"})
        call = json.loads((self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertIn("Konnektoren: Gmail.", call["prompt"])
        args = call["args"]
        self.assertEqual(args[args.index("--permission-prompt-tool") + 1], "stdio")
        self.assertEqual(args[args.index("--input-format") + 1], "stream-json")
        self.assertIn("--system-prompt-file", args)
        self.assertNotIn("--safe-mode", args, "das würde die Konnektoren abschalten")
        self.assertEqual(args[args.index("--max-turns") + 1], "30", "ein verirrter Lauf leert nicht das Kontingent")
        self.assertEqual(call["no_claude_md"], "1")
        self.assertEqual(call["model"], "sonnet")
        reminder = assistant.reminders.upcoming(dt.datetime(2026, 10, 3, 8, 0))
        self.assertEqual([r["text"] for r in reminder], ["In einer Viertelstunde: Spätes Telefonat"])

    def test_older_claude_without_max_turns(self):
        z = Zentrale({}, self.brain, RecordingZentraleUi(), self.home / "daten", FakeAssistant(self.home),
                     now=lambda: dt.datetime(2026, 10, 3, 8, 0), opener=tagesschau)
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "max-turns"}):
            self.assertTrue(z.refresh())
            self.assertTrue(z.wait_lage(30))
        self.assertEqual(z.lage_error, "", "ohne die Option noch einmal")
        call = json.loads((self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertNotIn("--max-turns", call["args"])

    def test_answer_without_data_is_an_error(self):
        z = Zentrale({}, self.brain, RecordingZentraleUi(), self.home / "daten", FakeAssistant(self.home))
        with mock.patch.dict("os.environ", {"FAKE_LAGE": "kaputt"}):
            self.assertTrue(z.refresh())
            self.assertTrue(z.wait_lage(30))
        self.assertEqual(z.lage_error, "Keine Daten in der Antwort.")


if __name__ == "__main__":
    unittest.main()
