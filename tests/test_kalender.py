"""Termine: eigene, aus einem iCal-Abo (Google, Outlook), Vorwarnung, Absagen, Sätze."""

import datetime as dt
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis.kalender import Calendar, match_calendar, parse_ics


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


# Ein Google-Kalender wie im echten Export: Zeitzonen, Serie mit Ausnahme und geänderter Stunde,
# ganztägiger Termin, abgesagter Termin, UTC-Zeit, Outlook-Zone.
ICS = """BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r
BEGIN:VEVENT\r
DTSTART;TZID=Europe/Berlin:20261005T090000\r
DTEND;TZID=Europe/Berlin:20261005T100000\r
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261031T235959Z\r
EXDATE;TZID=Europe/Berlin:20261007T090000\r
UID:serie@google.com\r
SUMMARY:Daily Standup\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Europe/Berlin:20261012T113000\r
DTEND;TZID=Europe/Berlin:20261012T123000\r
RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000\r
UID:serie@google.com\r
SUMMARY:Daily Standup (verschoben)\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;VALUE=DATE:20261003\r
DTEND;VALUE=DATE:20261004\r
UID:tag@google.com\r
SUMMARY:Tag der Deutschen Einheit\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART:20261003T100000Z\r
DTEND:20261003T110000Z\r
UID:zahnarzt@google.com\r
SUMMARY:Zahnarzt\r
LOCATION:Praxis Dr. Huber\\, Wien\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Europe/Berlin:20261004T150000\r
DTEND;TZID=Europe/Berlin:20261004T160000\r
UID:abgesagt@google.com\r
STATUS:CANCELLED\r
SUMMARY:Fällt aus\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID="W. Europe Standard Time":20261006T180000\r
DURATION:PT90M\r
UID:outlook@example.com\r
SUMMARY:Training mit einem sehr langen Titel, der in der Datei umgebrochen\r
  wird\r
END:VEVENT\r
END:VCALENDAR\r
"""


def berlin(*args):
    """Berliner Zeit in die Ortszeit dieses Rechners (die Tests laufen auch in UTC)."""
    from zoneinfo import ZoneInfo

    return dt.datetime(*args, tzinfo=ZoneInfo("Europe/Berlin")).astimezone().replace(tzinfo=None)


class IcsTest(unittest.TestCase):
    def events(self):
        return parse_ics(ICS, "kalender1", dt.datetime(2026, 10, 1), dt.datetime(2026, 10, 20))

    def test_series_exceptions_and_moves(self):
        standups = [e for e in self.events() if e.title.startswith("Daily Standup")]
        starts = [(e.title, e.start) for e in standups]
        self.assertIn(("Daily Standup", berlin(2026, 10, 5, 9, 0)), starts)
        self.assertNotIn(("Daily Standup", berlin(2026, 10, 7, 9, 0)), starts, "Ausnahme (EXDATE)")
        self.assertNotIn(("Daily Standup", berlin(2026, 10, 12, 9, 0)), starts, "ersetzt durch die verschobene Stunde")
        self.assertIn(("Daily Standup (verschoben)", berlin(2026, 10, 12, 11, 30)), starts)
        self.assertIn(("Daily Standup", berlin(2026, 10, 14, 9, 0)), starts)
        self.assertEqual(len(standups), 4)  # 5., 12. (verschoben), 14. und 19., aber nicht der 7.
        self.assertEqual(standups[0].end - standups[0].start, dt.timedelta(hours=1))

    def test_all_day_utc_cancelled_and_outlook_zone(self):
        events = {e.title: e for e in self.events()}
        self.assertTrue(events["Tag der Deutschen Einheit"].all_day)
        self.assertEqual(events["Tag der Deutschen Einheit"].start, dt.datetime(2026, 10, 3))
        self.assertEqual(events["Zahnarzt"].start, berlin(2026, 10, 3, 12, 0))
        self.assertEqual(events["Zahnarzt"].place, "Praxis Dr. Huber, Wien")
        self.assertNotIn("Fällt aus", events)
        training = events["Training mit einem sehr langen Titel, der in der Datei umgebrochen wird"]
        self.assertEqual((training.start, training.end - training.start), (berlin(2026, 10, 6, 18, 0), dt.timedelta(minutes=90)))

    def test_window_and_garbage(self):
        self.assertEqual(parse_ics(ICS, "k", dt.datetime(2027, 1, 1), dt.datetime(2027, 2, 1)), [])
        self.assertEqual(parse_ics("kein Kalender", "k", dt.datetime(2026, 1, 1), dt.datetime(2027, 1, 1)), [])


class FakeWeb:
    def __init__(self, text):
        self.text = text
        self.calls = 0

    def __call__(self, request, timeout=None):
        self.calls += 1
        return io.BytesIO(self.text.encode("utf-8"))


class CalendarTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.clock = Clock(dt.datetime(2026, 10, 2, 10, 0))  # Freitag
        self.web = FakeWeb(ICS)
        self.calendar = Calendar(Path(self.folder.name) / "kalender.json", ["webcal://calendar.google.com/x/basic.ics"],
                                 now=self.clock, opener=self.web)

    def tearDown(self):
        self.folder.cleanup()

    def test_own_and_subscribed_events_together(self):
        self.calendar.refresh()
        self.calendar.add("Training", dt.datetime(2026, 10, 3, 18, 0))
        titles = [e.title for e in self.calendar.day(dt.date(2026, 10, 3))]
        self.assertEqual(titles, ["Tag der Deutschen Einheit", "Zahnarzt", "Training"])
        said = self.calendar.describe_day(dt.date(2026, 10, 3))
        self.assertTrue(said.startswith("Morgen haben Sie 3 Termine, Sir: Tag der Deutschen Einheit, um "), said)
        self.assertIn("Zahnarzt (Praxis Dr. Huber, Wien) und um 18 Uhr Training.", said)
        self.assertEqual(self.calendar.describe_day(dt.date(2026, 10, 2)), "Heute steht nichts mehr im Kalender, Sir.")
        self.assertIn("Termine heute und morgen:", self.calendar.context())

    def test_offline_uses_the_last_copy(self):
        self.calendar.refresh()
        broken = Calendar(Path(self.folder.name) / "kalender.json", ["https://calendar.google.com/x/basic.ics"],
                          now=self.clock, opener=mock.Mock(side_effect=OSError("kein Netz")))
        self.assertIn("Zahnarzt", [e.title for e in broken.day(dt.date(2026, 10, 3))], "vom letzten Abruf")
        broken.refresh(force=True)
        self.assertIn("kein Netz", list(broken.errors.values())[0])

    def test_warning_once_before_start(self):
        self.calendar.add("Training", dt.datetime(2026, 10, 2, 10, 12))
        self.assertEqual([e.title for e in self.calendar.due_warnings(15)], ["Training"])
        self.assertEqual(self.calendar.due_warnings(15), [], "nur einmal")

    def test_cancelled_moved_and_new_events_are_noticed(self):
        self.clock.when = dt.datetime(2026, 10, 4, 20, 0)  # Sonntagabend, die nächsten 48 Stunden: Mo und Di
        self.calendar.refresh()
        self.assertEqual(self.calendar.changes(), [], "beim ersten Blick nur merken")
        changed = ICS.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;", "RRULE:FREQ=WEEKLY;BYDAY=WE;")
        changed = changed.replace("DTSTART;TZID=\"W. Europe Standard Time\":20261006T180000",
                                  "DTSTART;TZID=\"W. Europe Standard Time\":20261006T190000")
        changed = changed.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nDTSTART;TZID=Europe/Berlin:20261005T170000\r\n"
                                  "UID:neu@google.com\r\nSUMMARY:Elternabend\r\nEND:VEVENT\r\nEND:VCALENDAR")
        self.web.text = changed
        self.calendar.refresh(force=True)
        said = self.calendar.changes()
        self.assertEqual(len(said), 3, said)
        self.assertTrue(any(s.startswith("Ihr Termin morgen um ") and "Daily Standup wurde abgesagt." in s for s in said), said)
        self.assertTrue(any(s.startswith("Training mit einem sehr langen Titel") and "verschoben" in s for s in said), said)
        self.assertTrue(any(s.startswith("Neu im Kalender: morgen um ") and s.endswith("Elternabend.") for s in said), said)
        self.assertEqual(self.calendar.changes(), [])

    def test_remove_only_own_events(self):
        self.calendar.refresh()
        self.calendar.add("Zahnarzt Kontrolle", dt.datetime(2026, 10, 9, 8, 0))
        self.assertEqual([e.title for e in self.calendar.remove("den Termin Zahnarzt")], ["Zahnarzt Kontrolle"])
        self.assertEqual(self.calendar.remove("Zahnarzt"), [], "der aus Google bleibt")


class SentenceTest(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 2, 10, 0)  # Freitag

    def test_add(self):
        cases = {
            "Trag morgen um 18 Uhr Training ein": ("Training", dt.datetime(2026, 10, 3, 18, 0), None, False),
            "Trag mir für Samstag 20 Uhr Kino mit Anna ein": ("Kino mit Anna", dt.datetime(2026, 10, 3, 20, 0), None, False),
            "Neuer Termin: Montag 9 Uhr Meeting mit Max": ("Meeting mit Max", dt.datetime(2026, 10, 5, 9, 0), None, False),
            "Termin: am 15.10. um 14:30 Zahnarzt": ("Zahnarzt", dt.datetime(2026, 10, 15, 14, 30), None, False),
            "Trag Mittwoch von 18 bis 19 Uhr Sport ein": ("Sport", dt.datetime(2026, 10, 7, 18, 0), dt.datetime(2026, 10, 7, 19, 0), False),
            "Trag am Sonntag Omas Geburtstag ein": ("Omas Geburtstag", dt.datetime(2026, 10, 4), None, True),
            "Trag heute um 8 Uhr abends Kino ein": ("Kino", dt.datetime(2026, 10, 2, 20, 0), None, False),
            "Trag morgen um 18.30 Uhr Essen mit Lisa ein": ("Essen mit Lisa", dt.datetime(2026, 10, 3, 18, 30), None, False),
        }
        for said, expected in cases.items():
            self.assertEqual(match_calendar(said, self.NOW), ("add", expected), said)

    def test_questions_and_removal(self):
        self.assertEqual(match_calendar("Was steht heute an?", self.NOW), ("ask", dt.date(2026, 10, 2)))
        self.assertEqual(match_calendar("Was habe ich morgen vor?", self.NOW), ("ask", dt.date(2026, 10, 3)))
        self.assertEqual(match_calendar("Welche Termine habe ich diese Woche?", self.NOW), ("ask", "woche"))
        self.assertEqual(match_calendar("Wann ist mein nächster Termin?", self.NOW), ("ask", "next"))
        self.assertEqual(match_calendar("Habe ich am Montag Termine?", self.NOW), ("ask", dt.date(2026, 10, 5)))
        self.assertEqual(match_calendar("Sag den Termin Training ab", self.NOW), ("remove", "Training"))

    def test_not_calendar(self):
        for said in ("Trag das ein", "Trag mich bei Discord ein", "Schreib Max an", "Öffne den Kalender",
                     "Erinnere mich morgen um 8 an den Müll"):
            self.assertIsNone(match_calendar(said, self.NOW), said)


class AssistantTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.folder = tempfile.TemporaryDirectory()
        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant.calendar = Calendar(Path(self.folder.name) / "kalender.json")
        self.assistant._disk_checked = float("inf")

    def tearDown(self):
        self.folder.cleanup()

    def test_add_ask_and_cancel_without_claude(self):
        answer = self.assistant.handle("Trag übermorgen um 18 Uhr Training ein")
        self.assertEqual(answer, "Eingetragen, Sir: übermorgen um 18 Uhr Training.")
        answer = self.assistant.handle("Trag übermorgen von 18 bis 19 Uhr Kino ein")
        self.assertIn("Achtung, da ist schon um 18 Uhr Training.", answer)
        self.assertIn("um 18 Uhr Training", self.assistant.handle("Was steht übermorgen an?"))
        self.assertIn("Gestrichen, Sir:", self.assistant.handle("Lösch den Termin Kino"))
        self.assertEqual(self.brain.asked, [])

    def test_warning_is_announced(self):
        now = dt.datetime.now()
        self.assistant.calendar.add("Zahnarzt", now + dt.timedelta(minutes=10))
        with mock.patch.object(self.assistant, "_push"):
            self.assistant.check_calendar()
        self.assertTrue(self.speaker.said[-1].startswith("Sir, in "))
        self.assertTrue(self.speaker.said[-1].endswith(" Minuten: Zahnarzt."))


class GreetingAndToolTest(unittest.TestCase):
    def test_greeting_names_todays_events(self):
        from jarvis.greeting import build_greeting

        text = build_greeting(dt.datetime(2026, 10, 2, 8, 0), {"temp": 12, "text": "sonnig"}, [],
                              ["um 12 Uhr Mittagessen", "um 18 Uhr Training"])
        self.assertEqual(text, "Guten Morgen, Sir. Draußen: 12 Grad, sonnig. Im Kalender heute: um 12 Uhr Mittagessen und um 18 Uhr Training.")

    def test_tool_commands(self):
        from jarvis import tool
        from jarvis.config import load_config

        with tempfile.TemporaryDirectory() as folder:
            cfg = load_config()
            cfg["kalender"] = {"abos": [], "vorwarnung_minuten": 15}
            out = io.StringIO()
            with mock.patch.object(tool, "STATE_DIR", Path(folder)), mock.patch.object(tool, "load_config", return_value=cfg), \
                    redirect_stdout(out):
                self.assertEqual(tool.main(["termin", "übermorgen um 18 uhr", "Training", "90"]), 0)
                self.assertEqual(tool.main(["termin", "übermorgen", "Omas Geburtstag"]), 0)
                self.assertEqual(tool.main(["termine", "übermorgen"]), 0)
                self.assertEqual(tool.main(["termin-loeschen", "Training"]), 0)
                self.assertEqual(tool.main(["termin-loeschen", "Training"]), 1)
            text = out.getvalue()
            self.assertIn("Termin eingetragen: übermorgen um 18 Uhr Training", text)
            self.assertIn("ganztags  Omas Geburtstag", text)
            self.assertIn("18:00-19:30  Training", text)
            self.assertIn("Gelöscht: Training", text)


if __name__ == "__main__":
    unittest.main()


class WindowTest(unittest.TestCase):
    def test_add_feed_shows_events_in_today_column(self):
        from jarvis.gui.app import Api

        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            api = Api.__new__(Api)
            api._assistant = mock.Mock(_cfg={"kalender": {"abos": []}}, reminders=None, calendar=Calendar(state / "k.json"))
            now = dt.datetime.now()
            soon = (now + dt.timedelta(hours=2)).replace(second=0, microsecond=0)
            ics = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@google.com\r\nSUMMARY:Arzt\r\n"
                   f"DTSTART:{soon:%Y%m%dT%H%M%S}\r\nDTEND:{soon + dt.timedelta(hours=1):%Y%m%dT%H%M%S}\r\n"
                   "END:VEVENT\r\nEND:VCALENDAR\r\n")
            with mock.patch("jarvis.config.STATE_DIR", state), mock.patch("jarvis.config.CONFIG_PATH", state / "config.toml"), \
                    mock.patch("jarvis.kalender.urllib.request.urlopen", side_effect=lambda *a, **k: io.BytesIO(ics.encode())):
                self.assertFalse(api.calendar_add("http://unsicher.example/kal.ics")["ok"])
                result = api.calendar_add("webcal://calendar.google.com/calendar/ical/x/basic.ics")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["count"], 1)
            self.assertIn('abos = ["webcal://calendar.google.com/calendar/ical/x/basic.ics"]',
                          (state / "config.toml").read_text(encoding="utf-8"))
            rows = api.reminders()
            self.assertIn({"uhr": soon.strftime("%H:%M"), "text": "Arzt", "tag": "heute" if soon.date() == now.date() else "morgen",
                           "art": "termin"}, rows)
            info = api.calendar_info()
            self.assertEqual(info["feeds"][0]["shown"], "https://calendar.google.com/…")
            with mock.patch("jarvis.config.STATE_DIR", state), mock.patch("jarvis.config.CONFIG_PATH", state / "config.toml"):
                self.assertTrue(api.calendar_remove("webcal://calendar.google.com/calendar/ical/x/basic.ics")["ok"])
            self.assertEqual(api.calendar_info()["feeds"], [])
