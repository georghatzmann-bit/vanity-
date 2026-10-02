import datetime as dt
import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from jarvis.config import load_config
from jarvis.hinweise import SOON, URGENT, Hint, Lage, Watcher, app_name, morning_brief
from jarvis.kalender import Event
from jarvis.mail import Message
from tests.test_assistant import FakeBrain, make

NOW = dt.datetime(2026, 10, 2, 15, 0)


def lage(now=NOW, idle=5.0, **values):
    return Lage(now, idle=idle, **values)


class FakeCalendar:
    def __init__(self, events):
        self._events = events

    def events(self, start, end):
        return sorted([e for e in self._events if e.end > start and e.start < end], key=lambda e: e.start)

    def day(self, day):
        begin = dt.datetime.combine(day, dt.time())
        return self.events(begin, begin + dt.timedelta(days=1))


class FakeReminders:
    def __init__(self, items):
        self.items = items

    def upcoming(self, now=None):
        return self.items


class FakeMemory:
    def __init__(self, birthdays=()):
        self.birthdays = list(birthdays)

    def upcoming_birthdays(self, now=None, days=30):
        return [{"shown": name, "own": False} for name in self.birthdays]


def event(title, start, minutes=60, place=""):
    return Event(title, start, start + dt.timedelta(minutes=minutes), place=place, uid=title)


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / "hinweise.json"
        self.watcher = Watcher({}, self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def keys(self, hints):
        return [h.key for h in hints]

    def test_hanging_program_is_reported_once_after_half_a_minute(self):
        hung = [("Discord", "Discord.exe")]
        self.assertEqual(self.watcher.check(lage(hung=hung)), [])
        hints = self.watcher.check(lage(hung=hung))
        self.assertEqual(self.keys(hints), ["haengt:discord.exe"])
        self.assertIn("Discord reagiert seit einer halben Minute nicht mehr", hints[0].text)
        self.assertEqual(hints[0].offer, "Soll ich es neu starten?")
        self.assertIsNotNone(hints[0].action)
        self.assertEqual(self.watcher.check(lage(hung=hung)), [], "nicht jede halbe Minute wieder")
        self.assertEqual(self.watcher.check(lage(hung=[("Explorer", "explorer.exe")])), [])
        self.assertEqual(self.watcher.check(lage(hung=[("Explorer", "explorer.exe")])), [], "Windows selbst nicht")

    def test_program_eating_the_processor(self):
        busy = [("chrome.exe", 64.0), ("svchost.exe", 70.0)]
        found = []
        for _ in range(6):
            found += self.watcher.check(lage(busy=busy))
        self.assertEqual(self.keys(found), ["cpu:chrome.exe"])
        self.assertEqual(found[0].command, "Schließ Chrome")
        # Wenn es sich beruhigt, fängt die Zählung neu an.
        self.watcher.check(lage(busy=[("chrome.exe", 3.0)]))
        self.assertEqual(self.watcher._busy_seen, {})

    def test_program_in_front_and_heavy_tools_may_work_hard(self):
        busy = [("Valorant.exe", 80.0), ("obs64.exe", 60.0)]
        found = []
        for _ in range(7):
            found += self.watcher.check(lage(busy=busy, foreground="Valorant.exe"))
        self.assertEqual(found, [])

    def test_full_memory_names_the_biggest_program(self):
        found = []
        for _ in range(3):
            found += self.watcher.check(lage(ram=95.0, ram_top="chrome.exe"))
        self.assertEqual(len(found), 1)
        self.assertIn("am meisten braucht Chrome", found[0].text)
        self.assertEqual(found[0].command, "Schließ Chrome")

    def test_battery(self):
        self.assertEqual(self.keys(self.watcher.check(lage(battery=(14, False)))), ["akku:knapp"])
        self.assertEqual(self.watcher.check(lage(battery=(12, False))), [])
        urgent = self.watcher.check(lage(battery=(6, False)))
        self.assertEqual(urgent[0].priority, URGENT)
        self.assertEqual(self.watcher.check(lage(battery=(60, True))), [])
        self.assertIsNone(Lage(NOW).battery, "PC ohne Akku: nichts")

    def test_internet_gone_and_back(self):
        self.assertEqual(self.watcher.check(lage(online=False)), [])
        gone = self.watcher.check(lage(online=False))
        self.assertIn("Internetverbindung ist weg", gone[0].text)
        self.assertEqual(self.watcher.check(lage(online=False)), [])
        back = self.watcher.check(lage(online=True))
        self.assertEqual(back[0].text, "Das Internet ist wieder da, Sir.")
        self.assertEqual(self.watcher.check(lage(online=True)), [])

    def test_windows_waiting_for_a_restart(self):
        self.assertEqual(self.watcher.check(lage(reboot=True)), [])
        later = NOW + dt.timedelta(hours=26)
        self.assertEqual(self.watcher.check(lage(now=later.replace(hour=23), reboot=True)), [], "nicht spät abends")
        hints = self.watcher.check(lage(now=later.replace(hour=17), reboot=True))
        self.assertIn("seit gestern auf einen Neustart", hints[0].text)
        self.watcher.check(lage(reboot=False))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["neustart_seit"], "")

    def test_new_program_in_autostart(self):
        self.assertEqual(self.watcher.check(lage(autostart={"Benutzer|Steam": "steam.exe -silent"})), [], "nur merken")
        same = {"Benutzer|Steam": "steam.exe -silent", "Benutzer|Jarvis": "pythonw -m jarvis"}
        self.assertEqual(self.watcher.check(lage(autostart=same)), [])
        hints = self.watcher.check(lage(autostart=dict(same, **{"PC|UpdaterX": r"C:\Temp\x.exe"})))
        self.assertEqual(len(hints), 1)
        self.assertIn("neues Programm mit Windows: UpdaterX", hints[0].text)
        self.assertIn(r"C:\Temp\x.exe", hints[0].command)
        self.assertIn("Nichts löschen", hints[0].command)

    def test_break_after_three_hours(self):
        self.watcher.check(lage(idle=1.0))
        self.watcher._active_since -= 3.2 * 3600
        hints = self.watcher.check(lage(now=NOW + dt.timedelta(seconds=30), idle=2.0))
        self.assertIn("seit drei Stunden am Stück", hints[0].text)
        self.assertEqual(self.watcher.check(lage(now=NOW + dt.timedelta(seconds=60), idle=2.0)), [])
        # Nach einer echten Pause zählt es neu.
        self.watcher.check(lage(now=NOW + dt.timedelta(minutes=20), idle=900))
        self.assertIsNone(self.watcher._active_since)

    def test_evening_reminds_of_early_appointment_tomorrow(self):
        calendar = FakeCalendar([event("Zahnarzt", dt.datetime(2026, 10, 3, 8, 0), place="Praxis Weber")])
        evening = NOW.replace(hour=21, minute=10)
        planned = []
        hints = self.watcher.check(lage(now=evening), calendar=calendar,
                                   push_at=lambda when, text: planned.append((when, text)) or "eingeplant")
        self.assertEqual(hints[0].text, "Sir, morgen um 8 Uhr haben Sie Zahnarzt (Praxis Weber).")
        self.assertEqual(hints[0].offer, "Soll ich Sie um 7 Uhr aufs Handy erinnern?")
        self.assertEqual(hints[0].action(), "eingeplant")
        self.assertEqual(planned[0][0], dt.datetime(2026, 10, 3, 7, 0))
        self.assertIn("Zahnarzt", planned[0][1])
        self.watcher.said(hints[0], evening)
        self.assertEqual(self.watcher.check(lage(now=evening + dt.timedelta(minutes=5)), calendar=calendar), [])

    def test_late_at_night_with_an_early_appointment(self):
        calendar = FakeCalendar([event("Zahnarzt", dt.datetime(2026, 10, 3, 9, 0))])
        night = dt.datetime(2026, 10, 3, 1, 35)
        hints = self.watcher.check(lage(now=night), calendar=calendar)
        self.assertEqual(hints[0].text, "Sir, es ist schon halb 2, und um 9 Uhr wartet Zahnarzt. Nur, damit Sie es wissen.")

    def test_overlapping_appointments(self):
        calendar = FakeCalendar([event("Training", dt.datetime(2026, 10, 3, 18, 0), 90),
                                 event("Kino mit Lisa", dt.datetime(2026, 10, 3, 19, 0))])
        hints = self.watcher.check(lage(), calendar=calendar)
        self.assertIn("morgen überschneiden sich zwei Termine: um 18 Uhr Training und um 19 Uhr Kino mit Lisa", hints[0].text)

    def test_morning_overview_when_georg_comes_back_after_the_night(self):
        calendar = FakeCalendar([event("Zahnarzt", dt.datetime(2026, 10, 2, 10, 0)),
                                 event("Training", dt.datetime(2026, 10, 2, 18, 0))])
        reminders = FakeReminders([{"zeit": "2026-10-02T15:00:00", "text": "Mama anrufen"}])
        night, morning = dt.datetime(2026, 10, 1, 23, 50), dt.datetime(2026, 10, 2, 7, 45)
        self.watcher.check(lage(now=night, idle=600))
        hints = self.watcher.check(lage(now=morning, idle=3.0), calendar=calendar, reminders=reminders,
                                   memory=FakeMemory(["Max"]), weather=lambda: "Heute bis 17 Grad, später Regen")
        self.assertEqual(hints[0].priority, SOON)
        self.assertEqual(hints[0].text, "Guten Morgen, Sir. Heute bis 17 Grad, später Regen. Heute steht an: um 10 Uhr "
                                        "Zahnarzt und um 18 Uhr Training. Erinnerungen: um 15 Uhr Mama anrufen. Max hat "
                                        "heute Geburtstag.")
        # Einmal am Tag.
        self.watcher.check(lage(now=morning + dt.timedelta(hours=1), idle=5000))
        later = self.watcher.check(lage(now=morning + dt.timedelta(hours=1, minutes=1), idle=2.0), calendar=calendar)
        self.assertNotIn("morgens", " ".join(self.keys(later)))

    def test_greeting_at_start_counts_as_the_overview(self):
        self.watcher.mark_brief(dt.date(2026, 10, 2))
        self.watcher.check(lage(now=dt.datetime(2026, 10, 2, 6, 0), idle=20000))
        hints = self.watcher.check(lage(now=dt.datetime(2026, 10, 2, 9, 0), idle=1.0),
                                   calendar=FakeCalendar([event("Zahnarzt", dt.datetime(2026, 10, 2, 10, 0))]))
        self.assertEqual(hints, [])

    def test_while_you_were_away(self):
        self.watcher.check(lage(idle=1500))
        hints = self.watcher.check(lage(now=NOW + dt.timedelta(seconds=30), idle=2.0),
                                   away=lambda: ["Erinnerung: Tee", "Neue Bestellung im Shop: 29 Euro"])
        self.assertEqual(hints[0].text, "Willkommen zurück, Sir. Während Sie weg waren: Erinnerung: Tee. "
                                        "Neue Bestellung im Shop: 29 Euro.")
        self.assertEqual(self.watcher.check(lage(now=NOW + dt.timedelta(seconds=60), idle=2.0),
                                            away=lambda: ["nie gefragt"]), [], "nur beim Zurückkommen")

    def test_sleeping_pc_counts_as_away(self):
        self.watcher.check(lage(now=dt.datetime(2026, 10, 2, 0, 30), idle=120))
        hints = self.watcher.check(lage(now=dt.datetime(2026, 10, 2, 8, 0), idle=3.0),
                                   calendar=FakeCalendar([event("Zahnarzt", dt.datetime(2026, 10, 2, 10, 0))]))
        self.assertTrue(hints and hints[0].key.startswith("morgens:"))

    def test_never_again_mutes_that_kind_of_hint_for_good(self):
        hint = Hint("haengt:discord.exe", "pc", "Discord hängt.", group="haengt:discord.exe")
        self.assertTrue(self.watcher.allowed(hint, NOW))
        self.watcher.feedback(hint, "nie")
        self.assertFalse(self.watcher.allowed(hint, NOW))
        self.assertFalse(Watcher({}, self.path).allowed(hint, NOW), "gilt auch nach einem Neustart")
        other = Hint("haengt:steam.exe", "pc", "Steam hängt.", group="haengt:steam.exe")
        self.assertTrue(self.watcher.allowed(other, NOW))

    def test_switched_off_kinds_stay_quiet(self):
        watcher = Watcher({"hinweise": {"pc": False}}, None)
        hung = [("Discord", "Discord.exe")]
        watcher.check(lage(hung=hung))
        self.assertEqual(watcher.check(lage(hung=hung)), [])
        self.assertEqual(Watcher({"hinweise": {"aktiv": False}}).check(lage(online=False)), [])

    def test_unread_mail_from_a_person(self):
        old = Message("icloud:7", "icloud", 7, "Max Mustermann", "max@example.com", "Samstag?", NOW - dt.timedelta(days=1),
                      True, False)
        news = Message("icloud:8", "icloud", 8, "Shop", "news@shop.de", "Angebote", NOW - dt.timedelta(days=1), True, True)

        class Mail:
            configured = True

            def unread(self, limit=5, days=None):
                return 2, [news, old]

        read = []
        hints = self.watcher.post(NOW, Mail(), [{"name": "Max Mustermann", "mails": []}],
                                  read=lambda who: read.append(who) or "Max schreibt: Samstag passt.")
        self.assertEqual(hints[0].text, "Sir, die Mail von Max Mustermann von gestern ist noch ungelesen, Betreff: Samstag?.")
        self.assertEqual(hints[0].action(), "Max schreibt: Samstag passt.")
        self.assertEqual(self.watcher.post(NOW, Mail(), []), [], "höchstens alle zwei Stunden")

    def test_morning_brief_without_anything_is_empty(self):
        self.assertEqual(morning_brief(NOW.replace(hour=8)), "")
        self.assertEqual(app_name("msedge.exe"), "Edge")
        self.assertEqual(app_name("Discord.exe"), "Discord")


class AssistantHintTest(unittest.TestCase):
    """Wann Jarvis einen Hinweis sagt, und wie "Ja", "Nein" und "Nie wieder" wirken."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.assistant, self.ui, self.speaker, _ = make(FakeBrain())
        self.assistant.hints = Watcher({}, Path(self.tmp.name) / "hinweise.json")
        self.present = True
        self.fullscreen = False
        patches = [mock.patch.object(type(self.assistant), "_present", lambda _self: self.present),
                   mock.patch.object(type(self.assistant), "_fullscreen", lambda _self: self.fullscreen)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def test_hint_is_spoken_when_georg_is_there(self):
        hint = Hint("ram", "pc", "Sir, der Arbeitsspeicher ist fast voll.", "Soll ich Chrome schließen?",
                    command="Schließ Chrome", priority=SOON)
        self.assistant.offer_hints([hint])
        self.assertEqual(self.speaker.said, ["Sir, der Arbeitsspeicher ist fast voll. Soll ich Chrome schließen?"])
        self.assertTrue(self.assistant.take_follow_up(), "die Antwort geht ohne „Hey Jarvis“")
        self.assertFalse(self.assistant.hints.allowed(hint), "nicht gleich noch einmal")

    def test_nothing_while_gaming_or_away(self):
        self.fullscreen = True
        self.assistant.offer_hints([Hint("x", "pc", "Sir, etwas.")])
        self.present, self.fullscreen = False, False
        self.assistant.check_hints()
        self.assertEqual(self.speaker.said, [])
        self.present = True
        self.assistant.check_hints()
        self.assertEqual(self.speaker.said, ["Sir, etwas."])

    def test_no_hint_right_after_a_conversation(self):
        self.assistant.handle("Wie hoch ist der Eiffelturm?")
        said = len(self.speaker.said)
        self.assistant.offer_hints([Hint("x", "pc", "Sir, etwas.", priority=SOON)])
        self.assertEqual(len(self.speaker.said), said)
        self.assistant._last_turn_end -= self.assistant.AFTER_TALK + 1
        self.assistant.check_hints()
        self.assertEqual(self.speaker.said[-1], "Sir, etwas.")

    def test_urgent_hint_goes_to_the_phone_when_away(self):
        sent = []
        self.assistant.push = mock.Mock(enabled=True, send=lambda text, **kw: sent.append(text))
        self.present = False
        self.assistant.offer_hints([Hint("akku:leer", "pc", "Sir, der Akku ist fast leer.", priority=URGENT)])
        self.assertEqual(sent, ["Sir, der Akku ist fast leer."])
        self.assertEqual(self.speaker.said, [])
        self.assertEqual(self.assistant.take_missed(), ["Der Akku ist fast leer."])

    def test_quiet_gap_between_ordinary_hints(self):
        self.assistant.offer_hints([Hint("a", "pc", "Sir, erstens."), Hint("b", "pc", "Sir, zweitens.")])
        self.assertEqual(self.speaker.said, ["Sir, erstens."])
        self.assistant.check_hints()
        self.assertEqual(self.speaker.said, ["Sir, erstens."])
        self.assistant._last_hint_at -= self.assistant.HINT_GAP + 1
        self.assistant.check_hints()
        self.assertEqual(self.speaker.said, ["Sir, erstens.", "Sir, zweitens."])

    def test_never_again_after_a_hint(self):
        hint = Hint("cpu:chrome.exe", "pc", "Sir, Chrome beschäftigt den Prozessor.", "Soll ich Chrome schließen?",
                    command="Schließ Chrome", group="cpu:chrome.exe")
        self.assistant.offer_hints([hint])
        answer = self.assistant.handle("Nie wieder")
        self.assertEqual(answer, "Verstanden, Sir. Das sage ich Ihnen nicht mehr.")
        self.assertFalse(self.assistant.hints.allowed(Hint("cpu:chrome.exe", "pc", "x", group="cpu:chrome.exe")))

    def test_yes_runs_the_action(self):
        done = []
        hint = Hint("haengt:discord.exe", "pc", "Sir, Discord reagiert nicht mehr.", "Soll ich es neu starten?",
                    action=lambda: done.append(1) or "Discord startet neu, Sir.")
        self.assistant.offer_hints([hint])
        self.assertEqual(self.assistant.handle("Ja, bitte"), "Discord startet neu, Sir.")
        self.assertEqual(done, [1])

    def test_hint_without_question_does_not_swallow_the_next_command(self):
        brain = self.assistant.brain
        self.assistant.offer_hints([Hint("pause", "pausen", "Sir, Zeit für eine Pause.")])
        self.assistant.handle("Wie hoch ist der Eiffelturm?")
        self.assertEqual(brain.asked, ["Wie hoch ist der Eiffelturm?"])
        # Klingt nur am Anfang wie "Nein" oder "Nie": trotzdem ein neuer Befehl
        for command in ("Lass uns über das Wetter reden", "Später schreibst du mir ein Gedicht",
                        "Nie wieder Montag, wie heißt der Song?"):
            self.assistant._last_hint_at = float("-inf")
            self.assistant._last_turn_end = float("-inf")
            self.assistant.offer_hints([Hint("internet:" + command, "internet", "Das Internet ist wieder da, Sir.")])
            self.assistant.handle(command)
            self.assertEqual(brain.asked[-1], command)
        self.assertEqual(self.assistant.hints.muted(), [])

    def test_short_answer_to_a_hint_without_question(self):
        self.assistant.offer_hints([Hint("pause", "pausen", "Sir, Zeit für eine Pause.")])
        self.assertIn(self.assistant.handle("Nicht jetzt"), ("Sehr wohl, Sir.", "Wie Sie wünschen."))
        self.assistant._last_hint_at = float("-inf")
        self.assistant._last_turn_end = float("-inf")
        self.assistant.offer_hints([Hint("pause2", "pausen", "Sir, Zeit für eine Pause.")])
        self.assertEqual(self.assistant.handle("Sag mir das nicht mehr"), "Verstanden, Sir. Das sage ich Ihnen nicht mehr.")
        self.assertEqual(self.assistant.hints.muted(), ["pausen"])

    def test_not_now_to_a_question(self):
        done = []
        for number, answer in enumerate(("Nicht jetzt", "Jetzt nicht", "Bitte nicht", "Nein, jetzt nicht")):
            self.assistant._last_hint_at = float("-inf")
            self.assistant._last_turn_end = float("-inf")
            self.assistant.offer_hints([Hint(f"haengt:{number}", "pc", "Sir, Discord reagiert nicht mehr.",
                                             "Soll ich es neu starten?", action=lambda: done.append(1) or "Neu gestartet.")])
            self.assertIn(self.assistant.handle(answer), ("Sehr wohl, Sir.", "Wie Sie wünschen."), answer)
        self.assertEqual(done, [])
        self.assertEqual(self.assistant.brain.asked, [], "ein „Nicht jetzt“ geht nicht an Claude")

    def test_first_hint_right_after_the_pc_starts(self):
        # time.monotonic() zählt ab dem Hochfahren. Jarvis startet mit Windows: eine Minute danach war
        # noch kein Hinweis und kein Gespräch, der erste Hinweis darf also gleich kommen.
        with mock.patch("jarvis.assistant.time.monotonic", return_value=10.0):
            self.assistant.offer_hints([Hint("x", "pc", "Sir, etwas.")])
        self.assertEqual(self.speaker.said, ["Sir, etwas."])

    def test_missed_announcements_are_kept_short(self):
        self.present = False
        self.assistant.announce("Erinnerung, Sir: Tee")
        self.assistant.announce("Aus der Werkstatt: Der Bot ist fertig, Sir. Er liegt im Ordner.")
        self.present = True
        self.assistant.announce("Das hört Georg selbst.")
        self.assertEqual(self.assistant.take_missed(), ["Erinnerung: Tee", "Aus der Werkstatt: Der Bot ist fertig."])
        self.assertEqual(self.assistant.take_missed(), [])

    def test_watcher_round_with_a_fake_probe(self):
        class Probe:
            def measure(self, now=None, idle=0.0, gpu_temp=None):
                return Lage(dt.datetime.now(), idle=idle, hung=[("Discord", "Discord.exe")])

        probe = Probe()
        with mock.patch("jarvis.keys.idle_seconds", return_value=3.0):
            self.assistant.run_hint_check(self.assistant.hints, probe)
            self.assistant.run_hint_check(self.assistant.hints, probe)
        self.assertTrue(any("Discord reagiert" in s for s in self.speaker.said), self.speaker.said)


class PushScheduleTest(unittest.TestCase):
    def test_schedule_sends_a_delay(self):
        from jarvis.push import Push

        posted = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b"{}"

        def opener(request, timeout=10):
            posted.append(json.loads(request.data.decode("utf-8")))
            return Response()

        push = Push({"handy": {"push": True, "push_kanal": "jarvis-" + "a" * 24}}, opener=opener)
        when = dt.datetime.now() + dt.timedelta(hours=9)
        self.assertTrue(push.schedule("In einer Stunde: Zahnarzt", when))
        self.assertEqual(posted[0]["delay"], str(int(when.timestamp())))
        self.assertFalse(push.schedule("zu spät", dt.datetime.now() - dt.timedelta(minutes=1)))
        self.assertFalse(push.schedule("zu weit", dt.datetime.now() + dt.timedelta(days=5)))


class GreetingTest(unittest.TestCase):
    def test_birthday_in_the_greeting(self):
        from jarvis.greeting import build_greeting

        text = build_greeting(dt.datetime(2026, 10, 2, 8, 0), birthdays=["Max"])
        self.assertEqual(text, "Guten Morgen, Sir. Und Max hat heute Geburtstag.")


if __name__ == "__main__":
    unittest.main()
