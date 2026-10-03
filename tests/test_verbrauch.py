"""Claude-Kontingent wie im Video: Claude Code meldet es als rate_limit_event, Jarvis speichert es, zeigt es im
Fenster, beantwortet "Wie viel Claude habe ich noch?" selbst und denkt sparsamer, wenn es knapp wird."""

import datetime as dt
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path

import tests.helpers  # noqa: F401
from jarvis import verbrauch

NOW = dt.datetime(2026, 10, 3, 12, 0).timestamp()  # Samstag mittag


def real(now: float) -> dict:
    """So hat es echtes Claude Code (2.1.288) im stream-json gemeldet, die Zeiten passend zu now."""
    week = int(now + 4 * 86400 + 4 * 3600)
    return {"status": "allowed", "resetsAt": week, "rateLimitType": "seven_day", "isUsingOverage": False,
            "unifiedWindows": {"five_hour": {"utilization": 0.12, "resetsAt": int(now + 7 * 3600)},
                               "seven_day": {"utilization": 0.34, "resetsAt": week}}}


REAL = real(NOW)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.old_dir, verbrauch.DIR = verbrauch.DIR, self.tmp
        self.addCleanup(setattr, verbrauch, "DIR", self.old_dir)
        verbrauch._cache.clear()
        self.addCleanup(verbrauch._cache.clear)


class UsageTest(Base):
    def test_what_claude_code_reports_is_kept(self):
        data = verbrauch.note(REAL, now=NOW)
        self.assertEqual(data["woche"], {"anteil": 0.34, "endet": REAL["unifiedWindows"]["seven_day"]["resetsAt"]})
        self.assertEqual(data["fuenf_stunden"]["anteil"], 0.12)
        saved = json.loads((self.tmp / verbrauch.FILE).read_text(encoding="utf-8"))
        self.assertEqual(saved["woche"]["anteil"], 0.34, "überlebt einen Neustart")
        verbrauch._cache.clear()
        shown = verbrauch.view(now=NOW)
        self.assertEqual((shown["woche"], shown["fuenf_stunden"]), (34, 12))
        self.assertEqual(shown["woche_endet"], "Mittwoch um 16 Uhr")
        self.assertEqual(shown["fuenf_endet"], "um 19 Uhr")
        self.assertFalse(shown["knapp"])

    def test_history_for_the_sparkline_and_missing_windows(self):
        verbrauch.note(REAL, now=NOW)
        verbrauch.note(REAL, now=NOW + 60)  # unverändert: kein neuer Punkt
        later = json.loads(json.dumps(REAL))
        later["unifiedWindows"] = {"five_hour": {"utilization": 0.3, "resetsAt": int(NOW + 7 * 3600)}}
        data = verbrauch.note(later, now=NOW + 120)
        self.assertEqual(data["woche"]["anteil"], 0.34, "die Woche nicht mitgeschickt: der letzte Stand bleibt")
        self.assertEqual(data["fuenf_stunden"]["anteil"], 0.3)
        more = json.loads(json.dumps(REAL))
        more["unifiedWindows"]["seven_day"]["utilization"] = 0.41
        data = verbrauch.note(more, now=NOW + 180)
        self.assertEqual([p[1] for p in data["verlauf"]], [0.34, 0.41])
        self.assertIsNone(verbrauch.note({"irgendwas": 1}, now=NOW))
        self.assertIsNone(verbrauch.note("kaputt", now=NOW))

    def test_after_the_reset_the_week_starts_at_zero(self):
        verbrauch.note(REAL, now=NOW)
        self.assertEqual(verbrauch.share(verbrauch.load(), "woche", now=NOW + 5 * 86400), 0.0)

    def test_running_low(self):
        low = json.loads(json.dumps(REAL))
        low["unifiedWindows"]["seven_day"]["utilization"] = 0.93
        self.assertTrue(verbrauch.sparing(verbrauch.note(low, now=NOW), now=NOW))
        warned = dict(REAL, status="allowed_warning")
        self.assertTrue(verbrauch.sparing(verbrauch.note(warned, now=NOW), now=NOW))
        self.assertIn("Das wird knapp", verbrauch.describe(now=NOW))

    def test_spoken_answers(self):
        self.assertIn("noch keine Zahl", verbrauch.describe(now=NOW))
        verbrauch.note(REAL, now=NOW)
        said = verbrauch.describe(now=NOW)
        self.assertIn("Diese Woche sind 34 Prozent Ihres Claude-Kontingents verbraucht, Sir.", said)
        self.assertIn("Es setzt sich Mittwoch um 16 Uhr zurück.", said)
        self.assertIn("Im Fünf-Stunden-Fenster sind es 12 Prozent, wieder frei um 19 Uhr.", said)
        gone = json.loads(json.dumps(REAL))
        gone["status"] = "rejected"
        gone["unifiedWindows"]["five_hour"]["utilization"] = 1.0
        verbrauch.note(gone, now=NOW)
        self.assertEqual(verbrauch.describe(now=NOW),
                         "Das Claude-Kontingent ist gerade aufgebraucht, Sir. Es geht um 19 Uhr weiter.")

    def test_after_the_reset_nothing_is_used_up_or_short(self):
        gone = json.loads(json.dumps(REAL))
        five = gone["unifiedWindows"]["five_hour"]["resetsAt"]
        gone.update(status="rejected", rateLimitType="five_hour", resetsAt=five)
        gone["unifiedWindows"]["five_hour"]["utilization"] = 1.0
        verbrauch.note(gone, now=NOW)
        self.assertIn("aufgebraucht", verbrauch.describe(now=NOW))
        later = NOW + 8 * 3600  # 20 Uhr: das Fünf-Stunden-Fenster ist um 19 Uhr frei geworden, Claude noch nicht gefragt
        said = verbrauch.describe(now=later)
        self.assertNotIn("aufgebraucht", said)
        self.assertIn("Im Fünf-Stunden-Fenster sind es 0 Prozent.", said)
        self.assertEqual(verbrauch.view(now=later)["status"], "")
        warned = dict(REAL, status="allowed_warning")
        verbrauch.note(warned, now=NOW)
        self.assertTrue(verbrauch.sparing(now=NOW))
        self.assertFalse(verbrauch.sparing(now=NOW + 5 * 86400), "nach dem Wochenwechsel wieder gründlich")
        self.assertEqual(verbrauch.view(now=NOW + 5 * 86400)["woche_endet"], "", "kein Zurücksetzen in der Vergangenheit")

    def test_reset_times_in_words(self):
        base = dt.datetime(2026, 10, 3, 12, 0)
        self.assertEqual(verbrauch.when(int((base + dt.timedelta(hours=6, minutes=30)).timestamp()), NOW), "um 18:30")
        self.assertEqual(verbrauch.when(int((base + dt.timedelta(days=1, hours=-5)).timestamp()), NOW), "morgen um 7 Uhr")
        self.assertEqual(verbrauch.when(int((base + dt.timedelta(days=10)).timestamp()), NOW), "am 13.10. um 12 Uhr")
        self.assertEqual(verbrauch.when(None, NOW), "")
        self.assertEqual(verbrauch.when(int(NOW - 3600), NOW), "", "schon vorbei")

    def test_questions(self):
        for text in ("Wie viel Claude habe ich noch?", "Jarvis, wie viel Kontingent habe ich noch?",
                     "Wie steht mein Claude-Verbrauch?", "Wie viel Prozent vom Claude-Abo sind verbraucht?",
                     "Was ist noch vom Kontingent übrig?", "Claude-Verbrauch"):
            self.assertTrue(verbrauch.is_question(text), text)
        for text in ("Wie viel Speicher ist frei?", "Wie viel kostet Claude Pro?", "Was kann Claude?",
                     "Was hat Claude noch gesagt?", "Wie viel Akku habe ich noch?", "Öffne Claude"):
            self.assertFalse(verbrauch.is_question(text), text)

    def test_the_window_hears_about_it(self):
        seen = []
        verbrauch.listeners.append(seen.append)
        self.addCleanup(verbrauch.listeners.remove, seen.append)
        verbrauch.note(REAL, now=NOW)
        self.assertEqual(seen[-1]["woche"], 34)

        from jarvis.gui.app import Api, GuiBridge

        bridge = GuiBridge()
        bridge.usage({"woche": 10})
        bridge.usage({"woche": 11})
        self.assertEqual([e for e in bridge.drain() if e["type"] == "usage"], [{"type": "usage", "woche": 11}],
                         "nur der neueste Stand")
        self.assertEqual(Api(bridge, None, None).usage_state()["woche"], 34)


class WiringTest(Base):
    """Das Gehirn liest mit, die Modellwahl spart, Jarvis antwortet selbst."""

    def test_the_brain_reads_the_event(self):
        from jarvis.brain import _StreamReader

        reader = _StreamReader(lambda text: None, partial=False)
        reader.feed(json.dumps({"type": "rate_limit_event", "rate_limit_info": REAL, "uuid": "u", "session_id": "s"}))
        reader.feed(json.dumps({"type": "rate_limit_event", "rate_limit_info": None}))  # kaputt: nichts passiert
        self.assertEqual(verbrauch.load()["woche"]["anteil"], 0.34)

    def test_sparing_model_choice(self):
        from jarvis.modellwahl import Chooser

        text = "Hilf mir den Fehler in meinem Python-Code zu finden, der Build schlägt fehl"
        self.assertEqual(Chooser({}, sparing=lambda: False).choose(text).level, "gruendlich")
        choice = Chooser({}, sparing=lambda: True).choose(text)
        self.assertEqual((choice.level, choice.reason), ("normal", "Kontingent knapp"))
        wanted = Chooser({}, sparing=lambda: True).choose("Denk gründlich nach: was ist besser, Miete oder Kauf?")
        self.assertEqual(wanted.level, "gruendlich", "ausdrücklich gewünscht bleibt")
        self.assertEqual(Chooser({}, sparing=lambda: 1 / 0).choose(text).level, "gruendlich", "kaputter Zähler bremst nicht")

    def test_jarvis_answers_without_claude(self):
        from tests.test_assistant import FakeBrain, make

        verbrauch.note(real(time.time()))
        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain)
        answer = assistant.handle("Wie viel Claude habe ich noch?", speak=False)
        self.assertIn("34 Prozent", answer)
        self.assertEqual(brain.asked, [], "Claude wird dafür nicht gefragt")


if __name__ == "__main__":
    unittest.main()


class PageTest(unittest.TestCase):
    """Kontingent-Karte und Partikel-Kern stehen im Fenster, und app.js findet alles, was es sucht."""

    def test_page_has_card_and_core(self):
        import re

        web = Path(__file__).resolve().parents[1] / "jarvis" / "gui" / "web"
        page = (web / "index.html").read_text(encoding="utf-8")
        for needle in ('id="usageCard"', 'id="usageWeek"', 'id="usageBar"', 'id="usageNote"', 'id="usageLine"',
                       'id="kern"', 'id="kernStates"', 'data-kern="partikel"', 'data-kern="plasma"', 'src="kern.js"'):
            self.assertIn(needle, page)
        script = (web / "app.js").read_text(encoding="utf-8")
        optional = {"recent", "recentEmpty"}  # die alte Spalte "Zuletzt", app.js prüft das selbst
        for ident in set(re.findall(r"\$\('([A-Za-z]+)'\)", script)) - optional:
            self.assertIn(f'id="{ident}"', page, f"app.js sucht #{ident}")
        self.assertIn("usage_state", script)
        kern = (web / "kern.js").read_text(encoding="utf-8")
        self.assertIn("window.JarvisKern", kern)
        for state in ("idle", "listening", "thinking", "speaking", "muted", "error"):
            self.assertIn(f"{state}:", kern, "jeder Zustand hat eine Farbe")
