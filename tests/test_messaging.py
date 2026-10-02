"""Chatnachrichten ohne Claude: Erkennung im Satz und der Ablauf in der App."""

import unittest

import tests.helpers  # noqa: F401
from jarvis import messaging
from jarvis.intents import match
from jarvis.messaging import MessagingError, clean_text, send


class FakeDesktop:
    """Tut so, als wäre es Windows. Merkt sich jede Aktion.

    steal_at: nach so vielen Tastenaktionen klickt Georg ins Spiel (einmal pro Zahl).
    found: findet die Discord-Schnellsuche die Person (dann ändert sich der Fenstertitel)?
    """

    def __init__(self, running=True, comes_to_front=True, steal_at=(), window=True, found=True,
                 title="#allgemein | Gilde - Discord", busy_for=0.0, held_for=0.0):
        self.actions = []
        self.front = "explorer.exe"
        self.title = title
        self._running = running
        self._comes = comes_to_front
        self._steal = list(steal_at)
        self._window = window
        self._found = found
        self._query = None
        self._busy_until = busy_for  # so lange bewegt Georg noch die Maus
        self._held_until = held_for  # so lange hält Georg eine Taste (W, Umschalt) gedrückt
        self._keys = 0
        self.clock = 0.0

    def _app_for(self, uri):
        return "discord.exe" if uri.startswith("discord") else "telegram.exe" if uri.startswith("tg") else "whatsapp.exe"

    def open_uri(self, uri):
        self.actions.append(("open", uri))
        if self._comes:
            self.front = self._app_for(uri)

    def focus_app(self, names, hint=""):
        self.actions.append(("focus_app", hint))
        if self._running and self._window and self._comes:
            self.front = names[0]
            return True
        return False

    def running(self, names):
        return self._running

    def foreground_process(self):
        return self.front

    def foreground_window(self):
        return 4242

    def window_title(self):
        return self.title

    def idle_seconds(self):
        return 0.0 if self.clock < self._busy_until else 5.0

    def keys_held(self):
        return self.clock < self._held_until

    def _key(self):
        self._keys += 1
        if self._steal and self._keys >= self._steal[0]:
            self._steal.pop(0)
            self.front = "game.exe"  # Georg klickt ins Spiel

    def press(self, *keys):
        self.actions.append(("press", keys))
        if keys == ("enter",) and self._query is not None:
            if self._found:
                self.title = self._query + " - Discord"
            self._query = None
        self._key()

    def type(self, text):
        self.actions.append(("type", text))
        last = [a for a in self.actions if a[0] == "press"]
        if last and last[-1][1] in (("ctrl", "k"), ("ctrl", "f")):
            self._query = text
        self._key()

    def focus(self, hwnd):
        self.actions.append(("focus", hwnd))

    def sleep(self, seconds):
        self.clock += seconds

    def now(self):
        return self.clock


DISCORD_TO_MAX = [
    ("focus_app", "Discord"),
    ("press", ("esc",)),
    ("press", ("ctrl", "k")),
    ("type", "@Max"),
    ("press", ("enter",)),
    ("press", ("ctrl", "a")),
    ("press", ("backspace",)),
    ("type", "Bin gleich da"),
    ("press", ("enter",)),
    ("focus", 4242),
]


class SendTest(unittest.TestCase):
    def test_discord_message_goes_through_the_quick_switcher(self):
        desk = FakeDesktop()
        said = send("Discord", "Max", "bin gleich da.", desk)
        self.assertEqual(said, "An Max auf Discord gesendet.")
        self.assertEqual(desk.actions, DISCORD_TO_MAX)
        self.assertLess(desk.clock, 2.5, "schnell: unter zweieinhalb Sekunden Wartezeit")

    def test_whatsapp_picks_the_first_result(self):
        desk = FakeDesktop()
        send("whats app", "Anna", "Ich komme später!", desk)
        presses = [a[1] for a in desk.actions if a[0] == "press"]
        self.assertEqual(presses, [("ctrl", "f"), ("down",), ("enter",), ("ctrl", "a"), ("backspace",), ("enter",)])

    def test_app_without_window_comes_through_its_link(self):
        desk = FakeDesktop(window=False)
        send("discord", "Max", "Hallo", desk)
        self.assertEqual(desk.actions[:2], [("focus_app", "Discord"), ("open", "discord://-/channels/@me")])

    def test_app_that_does_not_come_to_the_front_gets_nothing_typed(self):
        desk = FakeDesktop(comes_to_front=False)
        with self.assertRaises(MessagingError) as ctx:
            send("discord", "Max", "Hallo", desk)
        self.assertIn("nichts geschrieben", str(ctx.exception))
        self.assertFalse([a for a in desk.actions if a[0] in ("press", "type")])

    def test_a_click_into_the_game_is_repaired(self):
        # Nach Esc und Strg+K klickt Georg ins Spiel: Jarvis holt Discord zurück und macht es noch mal
        desk = FakeDesktop(steal_at=[2])
        said = send("discord", "Max", "Geheimer Text", desk)
        self.assertEqual(said, "An Max auf Discord gesendet.")
        typed = [a[1] for a in desk.actions if a[0] == "type"]
        self.assertEqual(typed, ["@Max", "Geheimer Text"], "die Suche nur einmal getippt, die Nachricht genau einmal")
        self.assertEqual(desk.actions.count(("focus_app", "Discord")), 2)

    def test_interrupted_while_typing_the_text_sends_it_once(self):
        # Der Text ist schon im Feld, dann klickt Georg weg: beim zweiten Versuch wird das Feld geleert
        desk = FakeDesktop(steal_at=[7])  # Esc, Strg+K, @Max, Enter, Strg+A, Rück, Text: dann weg
        send("discord", "Max", "Bin gleich da", desk)
        typed = [a[1] for a in desk.actions if a[0] == "type"]
        self.assertEqual(typed, ["@Max", "Bin gleich da", "@Max", "Bin gleich da"])
        sends = [i for i, a in enumerate(desk.actions) if a == ("press", ("enter",))]
        last_text = max(i for i, a in enumerate(desk.actions) if a == ("type", "Bin gleich da"))
        self.assertEqual(desk.actions[last_text - 2:last_text], [("press", ("ctrl", "a")), ("press", ("backspace",))])
        self.assertEqual(sum(1 for i in sends if i > last_text), 1, "nur einmal abgeschickt")

    def test_constant_interruptions_give_up_before_anything_goes_out(self):
        desk = FakeDesktop(steal_at=[2, 4, 6, 8, 10, 12])
        with self.assertRaises(MessagingError) as ctx:
            send("discord", "Max", "Geheimer Text", desk)
        self.assertIn("abgebrochen", str(ctx.exception))
        self.assertNotIn(("type", "Geheimer Text"), desk.actions)

    def test_unknown_person_gets_nothing(self):
        desk = FakeDesktop(found=False)
        with self.assertRaises(MessagingError) as ctx:
            send("discord", "Maxx", "Hallo", desk)
        self.assertIn("finde ich in Discord nicht", str(ctx.exception))
        self.assertNotIn(("type", "Hallo"), desk.actions)
        self.assertIn(("press", ("esc",)), desk.actions)

    def test_already_open_chat_and_titles_without_chat_are_fine(self):
        desk = FakeDesktop(found=False, title="@Max - Discord")
        send("discord", "Max", "Hallo", desk)
        self.assertIn(("type", "Hallo"), desk.actions)
        desk = FakeDesktop(found=False, title="Discord")
        send("discord", "Max", "Hallo", desk)
        self.assertIn(("type", "Hallo"), desk.actions)

    def test_waits_until_georg_lets_go_of_the_mouse(self):
        desk = FakeDesktop(busy_for=0.6)
        send("discord", "Max", "Hallo", desk)
        self.assertGreaterEqual(desk.clock, 0.6)

    def test_waits_while_a_key_is_held(self):
        # Georg läuft noch mit W oder sprintet mit Umschalt: erst loslassen, dann Discord holen und tippen
        desk = FakeDesktop(held_for=0.8)
        send("discord", "Max", "Hallo", desk)
        self.assertGreaterEqual(desk.clock, 0.8)
        self.assertEqual(desk.actions[-2:], [("press", ("enter",)), ("focus", 4242)])
        desk = FakeDesktop(held_for=1.6)  # länger als das erste Warten: dann wartet jeder Tastendruck
        send("discord", "Max", "Hallo", desk)
        self.assertIn(("type", "Hallo"), desk.actions)

    def test_keys_held_the_whole_time_sends_nothing(self):
        desk = FakeDesktop(held_for=999)
        with self.assertRaises(MessagingError) as caught:
            send("discord", "Max", "Hallo", desk)
        self.assertIn("Tasten gedrückt", str(caught.exception))
        self.assertNotIn(("type", "Hallo"), desk.actions)

    def test_channel_messages(self):
        desk = FakeDesktop()
        send("discord", "#allgemein-chat", "Wer ist heute online?", desk)
        self.assertIn(("type", "#allgemein-chat"), desk.actions)

    def test_app_that_was_closed_gets_time_to_load(self):
        desk = FakeDesktop(running=False)
        send("discord", "Max", "Hallo", desk)
        self.assertGreater(desk.clock, 3.0)
        self.assertNotIn(("focus_app", "Discord"), desk.actions)

    def test_unknown_app_and_missing_parts(self):
        with self.assertRaises(MessagingError):
            send("icq", "Max", "Hallo", FakeDesktop())
        with self.assertRaises(MessagingError):
            send("discord", "", "Hallo", FakeDesktop())

    def test_clean_text(self):
        self.assertEqual(clean_text("  bin gleich da.  "), "Bin gleich da")
        self.assertEqual(clean_text("Spielen wir heute?"), "Spielen wir heute?")
        self.assertEqual(clean_text("warte..."), "Warte...")


class DiscordActionTest(unittest.TestCase):
    def test_open_chat_channel_and_server_stay_in_front(self):
        for kind, query in (("person", "@Max"), ("channel", "#allgemein"), ("server", "*Gilde")):
            with self.subTest(kind=kind):
                desk = FakeDesktop()
                messaging.discord_open(query.lstrip("@#*"), kind, desk)
                self.assertIn(("type", query), desk.actions)
                self.assertNotIn(("focus", 4242), desk.actions, "Georg will Discord sehen")

    def test_voice_channel_goes_back_to_the_game(self):
        desk = FakeDesktop()
        messaging.discord_open("Zocken", "voice", desk)
        self.assertIn(("type", "!Zocken"), desk.actions)
        self.assertEqual(desk.actions[-1], ("focus", 4242))

    def test_mute_and_deafen_press_discords_keys_and_go_back(self):
        desk = FakeDesktop()
        messaging.discord_key("mute", desk)
        self.assertEqual(desk.actions, [("focus_app", "Discord"), ("press", ("ctrl", "shift", "m")), ("focus", 4242)])
        with self.assertRaises(MessagingError):
            messaging.discord_key("deafen", FakeDesktop(running=False))

    def test_call(self):
        desk = FakeDesktop()
        messaging.discord_call("Max", desk)
        self.assertEqual(desk.actions[-1], ("press", ("ctrl", "quote")))


class DirectSpeechTest(unittest.TestCase):
    def test_first_person_sentences_become_messages(self):
        cases = {
            "dass ich später komme": "Ich komme später",
            "dass ich in zehn Minuten da bin.": "Ich bin in zehn Minuten da",
            "dass ich dich später anrufe": "Ich rufe dich später an",
            "dass ich heute nicht mitkommen kann": "Ich kann heute nicht mitkommen",
            "dass wir heute Abend zocken": "Wir zocken heute Abend",
            "dass ich gleich zurückkomme": "Ich komme gleich zurück",
            "dass ich vorbeikomme": "Ich komme vorbei",
            "dass ich gleich antworte": "Ich antworte gleich",
            "dass ich mich verspäte": "Ich verspäte mich",
        }
        for said, message in cases.items():
            with self.subTest(said=said):
                self.assertEqual(messaging.direct_speech(said), message)

    def test_unclear_sentences_stay_with_claude(self):
        for said in ("dass er sich beeilen soll", "dass ich ihn später anrufe", "ob er heute zockt",
                     "dass ich komme, wenn ich fertig bin", "bin gleich da"):
            with self.subTest(said=said):
                self.assertIsNone(messaging.direct_speech(said))


class RecognitionTest(unittest.TestCase):
    def test_messages_are_recognised_with_their_original_text(self):
        cases = {
            "Schreib Max auf Discord, bin gleich da.": ("discord", "Max", "bin gleich da."),
            "Hey Jarvis, schick Anna über WhatsApp: Ich komme 10 Minuten später!":
                ("whatsapp", "Anna", "Ich komme 10 Minuten später!"),
            "Schreib bitte Max Müller auf Discord bin in fünf Minuten online":
                ("discord", "Max Müller", "bin in fünf Minuten online"),
            "Schick eine Nachricht an Lisa auf Telegram, kannst du mich anrufen?":
                ("telegram", "Lisa", "kannst du mich anrufen?"),
            "Schreib auf Discord an Tom: Spielen wir heute Abend?": ("discord", "Tom", "Spielen wir heute Abend?"),
        }
        for said, (app, person, text) in cases.items():
            with self.subTest(said=said):
                intent = match(said)
                self.assertEqual((intent.name, intent.arg, intent.data), ("message", app, {"person": person, "text": text}))

    def test_without_app_and_indirect_speech(self):
        cases = {
            "Schreib Max auf Discord, dass ich später komme.": ("discord", "Max", "Ich komme später"),
            "Sag Max, dass ich gleich komme": ("", "Max", "Ich komme gleich"),
            "Sag Max Bescheid, dass ich später anrufe": ("", "Max", "Ich rufe später an"),
            "Schreib Max: bin gleich da": ("", "Max", "bin gleich da"),
            "Schreib Max bitte, dass ich komme": ("", "Max", "Ich komme"),
            "Richte Anna aus, dass wir heute zocken": ("", "Anna", "Wir zocken heute"),
            "Sag Lisa, ich bin in zehn Minuten da": ("", "Lisa", "ich bin in zehn Minuten da"),
            "Schreib in den Kanal allgemein: Wer ist heute online?": ("discord", "#allgemein", "Wer ist heute online?"),
            "Schreib Max zurück: ok": ("", "Max", "ok"),
            "Schreib Max: Lisa und ich kommen später": ("", "Max", "Lisa und ich kommen später"),
        }
        for said, (app, person, text) in cases.items():
            with self.subTest(said=said):
                intent = match(said)
                self.assertEqual((intent.name, intent.arg, intent.data), ("message", app, {"person": person, "text": text}))

    def test_other_sentences_are_not_messages(self):
        for said in (
            "Schreib Max auf Discord, dass er sich beeilen soll.",  # wer ist "er"? Claude formuliert um
            "Sag Max, ob er heute Zeit hat",
            "Sag mal, wie spät ist es?",
            "Sag Bescheid, wenn du fertig bist",
            "Schreib Python-Code, der Dateien sortiert",
            "Schreib ein Gedicht, das sich reimt",
            "Sag Jarvis, du bist toll",
            "Schreib mir auf Discord eine Erinnerung",
            "Schreib ein Gedicht über den Herbst",
            "Schreib Python-Code, der Dateien sortiert",
            "Schreib meinem Bruder auf WhatsApp, bin da",
            "Schreib auf Discord an Tom bin gleich da",  # ohne Komma unklar, wo der Name aufhört
            # Keine Person: andere Sprachassistenten, Merkzettel, Zeitangaben
            "Sag Alexa, Licht aus", "Sag Siri, sie soll leise sein", "Schreib Notiz: Milch kaufen",
            "Schreib Folgendes: Hallo Welt", "Sag Folgendes: ich bin Jarvis", "Schreib morgen Max: hallo",
            "Sag Max morgen, dass ich komme",  # erst morgen schicken: das macht Claude
            "Schreib Tom, Lisa und Max: Treffen um 8",  # an mehrere, nicht "Lisa und Max: ..." an Tom
        ):
            with self.subTest(said=said):
                intent = match(said)
                self.assertTrue(intent is None or intent.name != "message", intent)


class DiscordRecognitionTest(unittest.TestCase):
    def test_discord_actions(self):
        cases = {
            "Geh in den Sprachkanal Zocken": ("voice", "zocken"),
            "Tritt dem Voice-Channel Lobby bei": ("voice", "lobby"),
            "Geh in Discord in den Sprachkanal Lobby": ("voice", "lobby"),
            "Geh auf Discord in den Kanal memes": ("channel", "memes"),
            "Öffne den Chat mit Max": ("person", "max"),
            "Geh auf den Server Gilde": ("server", "gilde"),
            "Geh in den Kanal memes": ("channel", "memes"),
            "Öffne den Kanal ankündigungen auf Discord": ("channel", "ankündigungen"),
            "Ruf Max auf Discord an": ("call", "max"),
            "Schalte mich in Discord stumm": ("mute", ""),
            "Mute mich in Discord": ("mute", ""),
            "Discord taub": ("deafen", ""),
        }
        for said, (kind, target) in cases.items():
            with self.subTest(said=said):
                intent = match(said)
                self.assertEqual((intent.name, intent.arg, intent.data.get("target", "")), ("discord", kind, target))

    def test_not_discord(self):
        for said in ("Öffne den Kanal von MrBeast", "Öffne den Chat mit Anna auf WhatsApp", "Öffne Discord",
                     "Wie viele Server hat Discord?"):
            with self.subTest(said=said):
                intent = match(said)
                self.assertTrue(intent is None or intent.name != "discord", intent)

    def test_assistant_uses_the_quick_switcher_and_remembers_the_app(self):
        from unittest import mock

        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, ui, _speaker, _ = make(brain)
        with mock.patch.object(messaging, "discord_open", return_value="zocken") as opened:
            answer = assistant.handle("Geh in den Sprachkanal Zocken")
        opened.assert_called_once_with("zocken", "voice")
        self.assertEqual(answer, "Sprachkanal Zocken, Sir.")
        self.assertEqual(brain.asked, [])
        with mock.patch.object(messaging, "send", return_value="ok") as sent:
            assistant.handle("Sag Max, dass ich gleich komme")
        sent.assert_called_once_with("discord", "Max", "Ich komme gleich")
        with mock.patch.object(messaging, "discord_key", side_effect=MessagingError("Discord läuft gerade nicht, Sir.")):
            self.assertEqual(assistant.handle("Discord stumm"), "Discord läuft gerade nicht, Sir.")


class ReminderRecognitionTest(unittest.TestCase):
    def test_reminders_and_timers_without_claude(self):
        import datetime as dt

        from jarvis.intents import match_reminder

        now = dt.datetime(2026, 10, 1, 14, 0)
        cases = {
            "Erinnere mich in 20 Minuten an den Tee.": ("remind", "14:20", "den Tee"),
            "Erinnere mich um 18 Uhr ans Training": ("remind", "18:00", "das Training"),
            "Erinnere mich morgen um 8 daran, den Müll rauszubringen": ("remind", "08:00", "den Müll rauszubringen"),
            "Kannst du mich in 10 Minuten an die Wäsche erinnern?": ("remind", "14:10", "die Wäsche"),
            "Stell einen Timer auf 10 Minuten": ("timer", "14:10", "Der Timer ist abgelaufen."),
            "Starte einen Timer für eine halbe Stunde": ("timer", "14:30", "Der Timer ist abgelaufen."),
            # Jarvis sagt es zu Georg: nicht "Erinnerung, Sir: ich die Wäsche aufhänge" oder "meinen Tee"
            "Erinnere mich in 2 Stunden daran, dass ich die Wäsche aufhänge": ("remind", "16:00", "die Wäsche aufhängen"),
            "Erinnere mich in 2 Stunden, dass ich die Wäsche aufhängen muss": ("remind", "16:00", "die Wäsche aufhängen"),
            "Erinnere mich um 21 Uhr daran, dass ich meine Tabletten nehme": ("remind", "21:00", "Ihre Tabletten nehmen"),
            "Erinnere mich um 15 Uhr daran, dass ich mich bei Bosch bewerbe": ("remind", "15:00", "bei Bosch bewerben"),
            "Erinnere mich um 15 Uhr daran, dass ich das Passwort ändere": ("remind", "15:00", "das Passwort ändern"),
            "Erinnere mich um 15 Uhr daran, dass ich morgen frei habe": ("remind", "15:00", "morgen frei haben"),
            "Erinnere mich in 10 Minuten an meinen Tee": ("remind", "14:10", "Ihren Tee"),
            "Erinnere mich in einer Stunde daran, dass der Paketbote kommt": ("remind", "15:00", "der Paketbote kommt"),
        }
        for said, (name, clock, what) in cases.items():
            with self.subTest(said=said):
                intent = match_reminder(said, now)
                self.assertEqual((intent.name, intent.data["when"].strftime("%H:%M"), intent.data["what"]), (name, clock, what))
        self.assertIsNone(match_reminder("Erinnere mich irgendwann an das", now), "unklare Zeit: Claude fragt nach")

    def test_assistant_stores_the_reminder(self):
        import tempfile
        from pathlib import Path

        from jarvis.reminders import ReminderStore
        from tests.test_assistant import FakeBrain, make

        with tempfile.TemporaryDirectory() as folder:
            store = ReminderStore(Path(folder) / "erinnerungen.json")
            brain = FakeBrain()
            assistant, _ui, _speaker, _ = make(brain, reminders=store)
            answer = assistant.handle("Erinnere mich in 20 Minuten an den Tee")
            self.assertTrue(answer.startswith("Sehr wohl, Sir. Ich erinnere Sie"))
            self.assertEqual([r["text"] for r in store.all()], ["den Tee"])
            self.assertEqual(brain.asked, [])


class ToolTest(unittest.TestCase):
    def test_tool_command(self):
        from unittest import mock

        from jarvis import tool

        with mock.patch.object(messaging, "send", return_value="An Max auf Discord gesendet.") as sent, \
                mock.patch("builtins.print") as printed:
            self.assertEqual(tool.main(["nachricht", "discord", "Max", "Bin", "gleich", "da"]), 0)
        sent.assert_called_once_with("discord", "Max", "Bin gleich da")
        printed.assert_called_with("An Max auf Discord gesendet.")


if __name__ == "__main__":
    unittest.main()
