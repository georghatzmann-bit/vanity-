"""Georgs iPhone über iCloud: Anmeldung mit Umleitung, Kalender lesen, eintragen und löschen,
Änderungen, Zwischenspeicher für offline, Geburtstage aus den Kontakten."""

import datetime as dt
import io
import json
import tempfile
import unittest
from pathlib import Path

import tests.helpers  # noqa: F401
from tests.fake_icloud import CARDS, ZAHNARZT, FakeICloud
from jarvis.apple import (AppleError, ICloudCalendar, _utc_text, app_password, build_event_ics, exclude_occurrence,
                          looks_like_app_password, mask_email, parse_vcards, sync_birthdays)
from jarvis.kalender import Calendar, CalendarError, parse_ics
from jarvis.memory import Memory


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


def berlin(*args):
    from zoneinfo import ZoneInfo

    return dt.datetime(*args, tzinfo=ZoneInfo("Europe/Berlin")).astimezone().replace(tzinfo=None)


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.icloud = FakeICloud()

    def tearDown(self):
        self.icloud.close()

    def test_calendars_after_the_redirect_to_the_account_server(self):
        calendars = {c["name"]: c for c in self.icloud.account().calendars()}
        # Erinnerungen (nur VTODO), Eingang und Mitteilungen sind keine Terminkalender
        self.assertEqual(set(calendars), {"Privat", "Arbeit", "Familie"})
        self.assertEqual(calendars["Privat"]["farbe"], "#FF2968")
        self.assertTrue(calendars["Privat"]["schreibbar"])
        self.assertFalse(calendars["Familie"]["schreibbar"])
        self.assertTrue(calendars["Privat"]["url"].startswith(self.icloud.base + "/"))
        self.assertTrue(calendars["Privat"]["ctag"])
        first = self.icloud.requests[0]
        self.assertEqual((first[0], first[3].get("Depth")), ("PROPFIND", "0"))
        self.assertTrue(first[3].get("Content-Type", "").startswith("application/xml"))
        self.assertIn("Jarvis", first[3].get("User-Agent", ""))
        hosts = [r[1].split(":")[0] for r in self.icloud.requests]
        self.assertEqual(hosts[0], "127.0.0.1", "zuerst der Eingang (wie caldav.icloud.com)")
        self.assertEqual(set(hosts[1:]), {"localhost"}, "danach nur noch der Server des Kontos")
        self.assertTrue(all(r[3].get("Authorization", "").startswith("Basic ") for r in self.icloud.requests))

    def test_wrong_password_is_explained(self):
        with self.assertRaises(AppleError) as caught:
            self.icloud.account(password="mein-normales-passwort").calendars()
        self.assertEqual(str(caught.exception),
                         "Apple lehnt das Passwort ab. Bitte ein neues app-spezifisches Passwort erstellen.")
        self.assertEqual(caught.exception.kind, "passwort")

    def test_password_never_goes_to_a_foreign_server(self):
        self.icloud.redirect_to = "https://anderswo.example"
        with self.assertRaisesRegex(AppleError, "fremde Adresse"):
            self.icloud.account().calendars()
        self.assertEqual(len(self.icloud.requests), 1, "nur der Eingang hat die Anmeldung gesehen")

    def test_throttling_and_no_internet(self):
        self.icloud.throttle = True
        with self.assertRaises(AppleError) as caught:
            self.icloud.account().calendars()
        self.assertEqual(caught.exception.kind, "bremse")
        self.assertIn("iCloud bremst gerade", str(caught.exception))
        self.icloud.throttle = False
        account = self.icloud.account()
        self.icloud.close()
        with self.assertRaises(AppleError) as caught:
            account.calendars()
        self.assertEqual(caught.exception.kind, "netz")
        self.icloud = FakeICloud()  # für tearDown

    def test_events_of_a_time_range_in_utc(self):
        account = self.icloud.account()
        home = next(c for c in account.calendars() if c["id"] == "home")
        items = account.events(home["url"], dt.datetime(2026, 10, 1), dt.datetime(2026, 11, 1))
        self.assertEqual({i["uid"] for i in items}, {"TRAINING-1", "ZAHNARZT-1"})
        self.assertTrue(all(i["etag"].startswith('"etag-') for i in items))
        start, end = self.icloud.query_ranges[-1]
        self.assertEqual(start, _utc_text(dt.datetime(2026, 10, 1)))
        self.assertRegex(end, r"^\d{8}T\d{6}Z$")
        report = [r for r in self.icloud.requests if r[0] == "REPORT"][-1]
        self.assertEqual(report[3].get("Depth"), "1")

    def test_birthdays_from_the_contacts(self):
        people = {p["name"]: p for p in self.icloud.account().contacts()}
        self.assertEqual(set(people), {"Max Müller", "Anna Schmidt", "Tom Weber"})
        self.assertEqual((people["Max Müller"]["jahr"], people["Max Müller"]["monat"], people["Max Müller"]["tag"]),
                         (1990, 10, 3))
        self.assertEqual(people["Max Müller"]["mails"], ["max.mueller@example.com"])
        self.assertEqual(people["Max Müller"]["spitzname"], "Maxi")
        self.assertEqual((people["Anna Schmidt"]["jahr"], people["Anna Schmidt"]["monat"]), (0, 12), "Platzhalter 1604")
        self.assertEqual((people["Tom Weber"]["jahr"], people["Tom Weber"]["monat"], people["Tom Weber"]["tag"]), (0, 7, 4))
        report = [r for r in self.icloud.requests if r[0] == "REPORT"][-1]
        self.assertIn(b'prop-filter name="BDAY"', report[4])
        self.assertNotIn(b"PHOTO", report[4], "keine Fotos anfordern")


class PhoneCalendarTest(unittest.TestCase):
    def setUp(self):
        self.icloud = FakeICloud()
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)
        self.clock = Clock(dt.datetime(2026, 10, 2, 10, 0))  # Freitag
        self.phone = ICloudCalendar(self.icloud.account(), self.state / "icloud", now=self.clock)
        self.calendar = Calendar(self.state / "kalender.json", now=self.clock, apple=self.phone)
        self.calendar.refresh()

    def tearDown(self):
        self.icloud.close()
        self.folder.cleanup()

    def events(self, start=dt.datetime(2026, 10, 1), end=dt.datetime(2026, 10, 25)):
        return self.calendar.events(start, end)

    def test_series_moved_hour_all_day_and_read_only_calendars(self):
        found = [(e.title, e.start) for e in self.events()]
        self.assertIn(("Training", berlin(2026, 10, 5, 18, 0)), found)
        self.assertIn(("Training", berlin(2026, 10, 12, 19, 0)), found, "die verschobene Stunde")
        self.assertNotIn(("Training", berlin(2026, 10, 12, 18, 0)), found)
        self.assertIn(("Training", berlin(2026, 10, 19, 18, 0)), found)
        self.assertIn(("Kaffee bei Oma", berlin(2026, 10, 4, 15, 0)), found, "auch aus geteilten Kalendern")
        self.assertIn(("Gamescom-Nachlese", dt.datetime(2026, 10, 6)), found)
        self.assertFalse([t for t, _ in found if "Alarm" in t or t == "Erinnerung"], "VALARM ist kein Termin")
        events = {e.title: e for e in self.events()}
        self.assertEqual(events["Zahnarzt"].place, "Praxis Dr. Huber", "nur die erste Zeile der Adresse")
        self.assertEqual(events["Training"].place, "Sporthalle")
        self.assertEqual(self.calendar.source_name(events["Zahnarzt"].source), "Privat")
        local = berlin(2026, 10, 5, 10, 0)  # 08:00 UTC
        self.assertIn(f"um {local.hour} Uhr Zahnarzt (Praxis Dr. Huber)", self.calendar.describe_day(dt.date(2026, 10, 5)))

    def test_new_events_go_to_the_preferred_calendar(self):
        self.assertEqual(self.phone.target()["name"], "Privat")
        self.assertIsNone(self.phone.choose("Familie"), "nur lesen")
        self.assertEqual(self.phone.choose("Arbeit")["id"], "work")
        self.assertEqual(self.phone.target()["name"], "Arbeit")
        self.icloud.calendars["jarvis"] = {"name": "Jarvis", "color": "#000000FF", "comps": ["VEVENT"], "write": True,
                                           "ctag": 1, "objects": {}}
        fresh = ICloudCalendar(self.icloud.account(), self.state / "icloud", now=self.clock)
        fresh.refresh(force=True)
        self.assertEqual(fresh.target()["name"], "Jarvis")

    def test_add_lands_in_the_iphone(self):
        event = self.calendar.add("Training mit Max", dt.datetime(2026, 10, 3, 18, 0), place="Park")
        self.assertEqual(event.source, "icloud:home")
        put = [r for r in self.icloud.requests if r[0] == "PUT"][-1]
        self.assertEqual(put[3].get("If-None-Match"), "*")
        self.assertEqual(put[3].get("Content-Type"), "text/calendar; charset=utf-8")
        self.assertTrue(put[2].endswith(f"/home/{event.uid}.ics"))
        ics = put[4].decode("utf-8")
        self.assertIn("SUMMARY:Training mit Max\r\n", ics)
        self.assertIn(f"DTSTART:{_utc_text(dt.datetime(2026, 10, 3, 18, 0))}\r\n", ics)
        self.assertIn("LOCATION:Park\r\n", ics)
        self.assertIn(f"{event.uid}.ics", self.icloud.objects("home"))
        today = self.calendar.day(dt.date(2026, 10, 3))
        self.assertEqual([e.id for e in today if e.title == "Training mit Max"], [event.id], "sofort da, dieselbe Kennung")
        all_day = self.calendar.add("Omas Geburtstag", dt.datetime(2026, 10, 4), all_day=True)
        ics = self.icloud.objects("home")[f"{all_day.uid}.ics"]["ics"]
        self.assertIn("DTSTART;VALUE=DATE:20261004", ics)
        self.assertIn("DTEND;VALUE=DATE:20261005", ics)

    def test_add_without_internet_is_uploaded_later(self):
        self.icloud.throttle = True
        event = self.calendar.add("Kino", dt.datetime(2026, 10, 3, 20, 0))
        self.assertEqual(event.source, "jarvis", "vorerst bei Jarvis")
        self.assertEqual([e.title for e in self.calendar.day(dt.date(2026, 10, 3))], ["Kino"])
        self.icloud.throttle = False
        self.calendar.refresh(force=True)
        own = json.loads((self.state / "kalender.json").read_text(encoding="utf-8"))
        self.assertEqual(own, [], "nachgetragen und bei Jarvis weg")
        self.assertTrue(any("SUMMARY:Kino" in o["ics"] for o in self.icloud.objects("home").values()))
        self.assertEqual([e.title for e in self.calendar.day(dt.date(2026, 10, 3))], ["Kino"], "nicht doppelt")

    def test_remove_a_single_event_and_one_of_a_series(self):
        gone = self.calendar.remove("den Termin Zahnarzt")
        self.assertEqual(gone[0].title, "Zahnarzt")
        self.assertNotIn("ZAHNARZT-1.ics", self.icloud.objects("home"))
        self.assertNotIn("Zahnarzt", [e.title for e in self.events()])
        gone = self.calendar.remove("Training")
        self.assertEqual(gone[0].start, berlin(2026, 10, 5, 18, 0), "nur der nächste Termin der Serie")
        series = self.icloud.objects("home")["TRAINING-1.ics"]["ics"]
        self.assertIn("EXDATE;TZID=Europe/Berlin:20261005T180000", series)
        put = [r for r in self.icloud.requests if r[0] == "PUT"][-1]
        self.assertTrue(put[3].get("If-Match", "").startswith('"etag-'))
        starts = [e.start for e in self.events() if e.title == "Training"]
        self.assertEqual(starts, [berlin(2026, 10, 12, 19, 0), berlin(2026, 10, 19, 18, 0)])
        # Die einzeln verschobene Stunde fällt ganz weg: aus RECURRENCE-ID wird ein EXDATE
        gone = self.calendar.remove("Training")
        self.assertEqual(gone[0].start, berlin(2026, 10, 12, 19, 0))
        series = self.icloud.objects("home")["TRAINING-1.ics"]["ics"]
        self.assertIn("EXDATE;TZID=Europe/Berlin:20261012T180000", series)
        self.assertNotIn("RECURRENCE-ID", series)
        self.assertEqual([e.start for e in self.events() if e.title == "Training"], [berlin(2026, 10, 19, 18, 0)])

    def test_read_only_events_stay(self):
        self.assertEqual(self.calendar.remove("Kaffee bei Oma"), [])
        self.assertIn("OMA-1.ics", self.icloud.objects("familie"))
        self.assertEqual(self.calendar.not_found("Kaffee bei Oma"),
                         "Einen Termin „Kaffee bei Oma“ finde ich nicht, Sir. Termine aus Kalender-Abos ändern Sie bitte dort.")

    def test_failed_delete_is_a_sentence(self):
        self.icloud.throttle = True
        with self.assertRaises(CalendarError) as caught:
            self.calendar.remove("Zahnarzt")
        self.assertTrue(str(caught.exception).startswith("Den Termin konnte ich im iPhone nicht löschen, Sir. iCloud bremst"))
        self.assertIn("ZAHNARZT-1.ics", self.icloud.objects("home"))

    def test_changes_on_the_iphone_are_announced_but_not_jarvis_own(self):
        self.clock.when = dt.datetime(2026, 10, 4, 20, 0)  # Sonntagabend
        self.calendar.refresh(force=True)
        self.assertEqual(self.calendar.changes(), [], "beim ersten Blick nur merken")
        self.calendar.add("Elternabend", dt.datetime(2026, 10, 5, 17, 0))
        self.icloud.put_object("home", "ZAHNARZT-1.ics", ZAHNARZT.replace("T080000Z", "T100000Z").replace("T090000Z", "T110000Z"))
        self.icloud.put_object("home", "NEU-1.ics", ZAHNARZT.replace("ZAHNARZT-1", "NEU-1").replace("Zahnarzt", "Mittagessen")
                               .replace("20261005T080000Z", _utc_text(dt.datetime(2026, 10, 5, 12, 0)))
                               .replace("20261005T090000Z", _utc_text(dt.datetime(2026, 10, 5, 13, 0))))
        self.calendar.refresh(force=True)
        said = self.calendar.changes()
        self.assertTrue(any(s.startswith("Zahnarzt wurde verschoben, jetzt morgen um ") for s in said), said)
        self.assertIn("Neu im Kalender: morgen um 12 Uhr Mittagessen (Praxis Dr. Huber).", said)
        self.assertFalse([s for s in said if "Elternabend" in s], "selbst eingetragen ist keine Neuigkeit")
        self.calendar.remove("Mittagessen")
        self.calendar.refresh(force=True)
        self.assertEqual(self.calendar.changes(), [], "selbst gelöscht ist keine Absage")

    def test_unchanged_calendars_are_not_loaded_again(self):
        reports = sum(1 for r in self.icloud.requests if r[0] == "REPORT")
        self.phone.refresh(force=True)
        self.assertEqual(sum(1 for r in self.icloud.requests if r[0] == "REPORT"), reports, "Änderungszeichen gleich")
        self.icloud.put_object("work", "NEU.ics", ZAHNARZT.replace("ZAHNARZT-1", "W-1"))
        self.phone.refresh(force=True)
        new = [r[2] for r in self.icloud.requests if r[0] == "REPORT"][reports:]
        self.assertEqual(len(new), 1)
        self.assertTrue(new[0].endswith("/work/"))

    def test_last_state_without_internet_and_after_a_restart(self):
        self.icloud.close()
        again = ICloudCalendar(self.icloud.account(), self.state / "icloud", now=self.clock)
        calendar = Calendar(self.state / "kalender.json", now=self.clock, apple=again)
        calendar.refresh(force=True)
        self.assertIn("iCloud ist gerade nicht erreichbar", calendar.errors["icloud"])
        self.assertIn("Zahnarzt", [e.title for e in calendar.events(dt.datetime(2026, 10, 1), dt.datetime(2026, 10, 9))])
        self.icloud = FakeICloud()

    def test_another_apple_id_does_not_see_the_old_cache(self):
        other = ICloudCalendar(self.icloud.account(user="andere@icloud.com"), self.state / "icloud", now=self.clock)
        self.assertEqual(other.sources(), {})

    def test_subscription_of_the_same_calendar_is_not_doubled(self):
        calendar = Calendar(self.state / "kalender.json", ["https://p01-caldav.icloud.com/published/x.ics"],
                            now=self.clock, opener=lambda *a, **k: io.BytesIO(ZAHNARZT.encode()), apple=self.phone)
        calendar.refresh(force=True)
        self.assertEqual([e.title for e in calendar.day(dt.date(2026, 10, 5))].count("Zahnarzt"), 1)


class IcsTest(unittest.TestCase):
    def test_new_event_text(self):
        ics = build_event_ics("ABC-1", "Essen; mit Anna, Max", dt.datetime(2026, 10, 3, 18, 0),
                              dt.datetime(2026, 10, 3, 19, 30), place="Zum Löwen", now=dt.datetime(2026, 10, 2, 10, 0))
        self.assertIn("SUMMARY:Essen\\; mit Anna\\, Max\r\n", ics)
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        events = parse_ics(ics, "x", dt.datetime(2026, 10, 1), dt.datetime(2026, 10, 9))
        self.assertEqual([(e.title, e.start, e.end, e.place) for e in events],
                         [("Essen; mit Anna, Max", dt.datetime(2026, 10, 3, 18, 0), dt.datetime(2026, 10, 3, 19, 30),
                           "Zum Löwen")])
        long = build_event_ics("ABC-2", "Ü" * 80, dt.datetime(2026, 10, 3, 18, 0), dt.datetime(2026, 10, 3, 19, 0))
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in long.split("\r\n")), "gefaltet")
        self.assertEqual(parse_ics(long, "x", dt.datetime(2026, 10, 1), dt.datetime(2026, 10, 9))[0].title, "Ü" * 80)

    def test_exclude_in_utc_date_and_floating_series(self):
        base = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s\r\nDTSTART{start}\r\nRRULE:FREQ=DAILY;COUNT=5\r\n"
                "SUMMARY:Serie\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        utc = exclude_occurrence(base.format(start=":20261005T160000Z"), berlin(2026, 10, 6, 18, 0))
        self.assertIn("EXDATE:20261006T160000Z\r\nEND:VEVENT", utc)
        day = exclude_occurrence(base.format(start=";VALUE=DATE:20261005"), dt.datetime(2026, 10, 7))
        self.assertIn("EXDATE;VALUE=DATE:20261007", day)
        days = [e.start.date() for e in parse_ics(day, "x", dt.datetime(2026, 10, 1), dt.datetime(2026, 10, 20))]
        self.assertNotIn(dt.date(2026, 10, 7), days)
        self.assertEqual(len(days), 4)
        floating = exclude_occurrence(base.format(start=":20261005T090000"), dt.datetime(2026, 10, 8, 9, 0))
        self.assertIn("EXDATE:20261008T090000", floating)
        self.assertIsNone(exclude_occurrence(ZAHNARZT, dt.datetime(2026, 10, 5, 10, 0)), "keine Serie")


class VcardAndHelpersTest(unittest.TestCase):
    def test_vcards(self):
        people = parse_vcards("".join(CARDS))
        self.assertEqual([p["name"] for p in people], ["Max Müller", "Anna Schmidt", "Tom Weber", "Datum Ohne"])
        self.assertNotIn("monat", people[3])
        self.assertEqual(people[0]["vorname"], "Max")

    def test_app_password_and_masking(self):
        self.assertEqual(app_password(" Abcd efgh IJKL-mnop "), "abcd-efgh-ijkl-mnop")
        self.assertEqual(app_password("abcdefghijklmnop"), "abcd-efgh-ijkl-mnop")
        self.assertEqual(app_password("Mein Passwort 1!"), "Mein Passwort 1!")
        self.assertTrue(looks_like_app_password("abcd efgh ijkl mnop"))
        self.assertFalse(looks_like_app_password("geheim123"))
        self.assertEqual(mask_email("georg.beispiel@icloud.com"), "ge•••l@icloud.com")
        self.assertEqual(mask_email("max@me.com"), "m•••@me.com")


class BirthdayTest(unittest.TestCase):
    def setUp(self):
        self.icloud = FakeICloud()
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)
        self.clock = Clock(dt.datetime(2026, 10, 3, 10, 0))
        self.memory = Memory(self.state / "gedaechtnis.json", now=self.clock)

    def tearDown(self):
        self.icloud.close()
        self.folder.cleanup()

    def test_contacts_flow_into_the_birthday_hints(self):
        self.assertEqual(sync_birthdays(self.icloud.account(), self.memory, self.state), 3)
        self.assertIsNone(sync_birthdays(self.icloud.account(), self.memory, self.state), "höchstens alle sechs Stunden")
        self.assertEqual(self.memory.facts(), [], "die Fakten bleiben frei")
        soon = self.memory.upcoming_birthdays(days=90)
        self.assertEqual([(b["shown"], b["in_tagen"]) for b in soon], [("Max Müller", 0), ("Anna Schmidt", 82)])
        occasion = self.memory.occasion()
        self.assertEqual((occasion.question(), occasion.commands()), ("Sir, Max Müller wird heute 36.", []),
                         "ohne bekannten Chat nur ansagen")
        self.assertIn("Geburtstage bald (aus dem iPhone): Max Müller am 3. Oktober.", self.memory.context())
        people = self.memory.mail_people()
        self.assertIn({"name": "Max Müller", "mails": ["max.mueller@example.com"]}, people)

    def test_known_chat_contact_gets_the_offer_and_facts_win(self):
        self.memory.record("message", "Max", app="whatsapp")
        sync_birthdays(self.icloud.account(), self.memory, self.state, force=True)
        occasion = self.memory.occasion()
        self.assertEqual(occasion.question(), "Sir, Max Müller wird heute 36. Soll ich Max auf WhatsApp gratulieren?")
        self.memory.remember("Max hat am 3. Oktober Geburtstag")
        names = [b["who"] for b in self.memory.birthdays()]
        self.assertEqual(names.count("Max"), 1)
        self.assertNotIn("Max Müller", names, "steht schon als Fakt da")
        self.assertIn("Anna Schmidt", names)

    def test_wrong_password_keeps_the_old_list(self):
        sync_birthdays(self.icloud.account(), self.memory, self.state, force=True)
        self.assertIsNone(sync_birthdays(self.icloud.account(password="falsch"), self.memory, self.state, force=True))
        self.assertEqual(len(self.memory.address_book()), 3)


if __name__ == "__main__":
    unittest.main()
