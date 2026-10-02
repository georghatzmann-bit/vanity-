"""Sofort-Befehle ohne Claude: Webseiten, Suchen, Abspielen, Einstellungen, Schalter,
Wetter, Rechnen und mehrere Befehle in einem Satz."""

import datetime as dt
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import calc, intents, web
from jarvis.weather import spoken_weather
from tests.test_assistant import FakeBrain, make


def intent_of(text):
    found = intents.match(text)
    if found is None:
        return None
    data = {k: v for k, v in found.data.items() if k not in ("value", "when")}
    return (found.name, found.arg, data) if data else (found.name, found.arg)


class RecognitionTest(unittest.TestCase):
    def test_websites_searches_and_playing(self):
        cases = {
            "Geh auf Reddit": ("web", "Reddit"),
            "Öffne amazon.de": ("web", "amazon.de"),
            "Öffne die Seite von Billa": ("web", "Billa"),
            "Öffne YouTube im Browser": ("web", "YouTube"),
            "Such auf YouTube nach Katzenvideos": ("search", "Katzenvideos", {"site": "youtube"}),
            "Such Katzenvideos auf YouTube": ("search", "Katzenvideos", {"site": "youtube"}),
            "Hey Jarvis, google mal Pizza in der Nähe": ("search", "Pizza in der Nähe", {"site": "google"}),
            "Such nach dem besten Gaming-Monitor": ("search", "dem besten Gaming-Monitor", {"site": "google"}),
            "Such mir ein Rezept für Lasagne": ("search", "ein Rezept für Lasagne", {"site": "google"}),
            "Such bei willhaben nach einem Sofa": ("search", "einem Sofa", {"site": "willhaben"}),
            "Zeig mir Bilder vom Eiffelturm": ("images", "Eiffelturm"),
            "Navigiere nach Graz": ("route", "Graz"),
            "Zeig mir Hallstatt auf der Karte": ("map", "Hallstatt"),
            "Spiel Bohemian Rhapsody auf YouTube": ("play", "Bohemian Rhapsody", {"site": "youtube"}),
            "Spiel auf Spotify Queen": ("play", "Queen", {"site": "spotify"}),
            "Spiel Thunderstruck": ("play", "Thunderstruck", {"site": ""}),
            "Spiel ein Lied von Queen": ("play", "Queen", {"site": ""}),
        }
        for said, expected in cases.items():
            with self.subTest(said=said):
                self.assertEqual(intent_of(said), expected)

    def test_settings_switches_weather_and_sums(self):
        cases = {
            "Öffne die Bluetooth-Einstellungen": ("settings_page", "bluetooth"),
            "Zeig mir die Einstellungen für WLAN": ("settings_page", "wlan"),
            "Mach den Dunkelmodus an": ("dark_on", ""),
            "Dunkel-Modus aus": ("dark_off", ""),
            "Schalte auf hellen Modus": ("dark_off", ""),
            "Bluetooth aus": ("radio", "bluetooth", {"on": False}),
            "Mach das WLAN an": ("radio", "wifi", {"on": True}),
            "Wie wird das Wetter morgen?": ("weather", "morgen", {"place": "", "ask": ""}),
            "Regnet es?": ("weather", "jetzt", {"place": "", "ask": "regen"}),
            "Brauche ich heute einen Schirm?": ("weather", "heute", {"place": "", "ask": "regen"}),
            "Wie warm ist es in Graz?": ("weather", "jetzt", {"place": "graz", "ask": "temperatur"}),
            "Wie wird das Wetter am Wochenende in Salzburg?": ("weather", "wochenende", {"place": "salzburg", "ask": ""}),
            "Was ist 15 mal 23?": ("calc", "15 mal 23"),
            "Wie viel sind 20 Prozent von 80?": ("calc", "20 Prozent von 80"),
            "Was ist 1 durch 0": ("calc", "1 durch 0", {"error": "durch null"}),
        }
        for said, expected in cases.items():
            with self.subTest(said=said):
                self.assertEqual(intent_of(said), expected)

    def test_what_stays_with_the_old_rules_or_claude(self):
        cases = {
            "Öffne YouTube": ("open", "youtube"),
            "Öffne Spotify": ("open", "spotify"),
            "Spiel Musik ab": ("media_play", ""),
            "Spiel die Musik weiter": ("media_play", ""),
            "Öffne die Einstellungen": ("open", "einstellungen"),
            "Lautstärke auf 30": ("volume_set", "30"),
            "Schreib Max auf Discord, bin gleich da": ("message", "discord", {"person": "Max", "text": "bin gleich da"}),
        }
        for said, expected in cases.items():
            with self.subTest(said=said):
                self.assertEqual(intent_of(said), expected)
        for said in ("Such auf meinem PC nach der Rechnung", "Spiel ein Spiel mit mir", "Spiel meine Playlist",
                     "Ist Bluetooth an?", "Was ist die Hauptstadt von Frankreich?", "Öffne die Wetter-App",
                     "Wie spät ist es in New York?"):
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertTrue(found is None or found.name in ("open",), found)

    def test_several_commands_in_one_sentence(self):
        def parts(text):
            found = intents.match_parts(text)
            return [(p, i.name, i.arg, i.data.get("site", "")) for p, i in found] if found else None

        self.assertEqual(parts("Öffne Spotify und Discord"),
                         [("Öffne Spotify", "open", "spotify", ""), ("öffne Discord", "open", "discord", "")])
        self.assertEqual([p[1] for p in parts("Mach den Gaming-Modus an und öffne Steam")], ["gaming_on", "open"])
        self.assertEqual(len(parts("Öffne Spotify, Discord und Steam")), 3)
        # Seite öffnen und dort suchen: gleich die Suche auf der Seite
        self.assertEqual(parts("Öffne YouTube und such nach Katzen"),
                         [("Öffne YouTube such nach Katzen", "search", "Katzen", "youtube")])
        # Ein Teil, den nur Claude kann: dann macht Claude den ganzen Satz
        self.assertIsNone(parts("Öffne Spotify und erzähl mir einen Witz"))
        self.assertIsNone(parts("Öffne Spotify"))


class WebTest(unittest.TestCase):
    def test_sites_and_domains(self):
        self.assertEqual(web.site("YouTube"), ("YouTube", "https://www.youtube.com"))
        self.assertEqual(web.site("die Seite von willhaben"), ("willhaben", "https://www.willhaben.at"))
        self.assertEqual(web.site("youtubemusic"), ("YouTube Music", "https://music.youtube.com"))
        self.assertEqual(web.site("amazon.de"), ("Amazon", "https://amazon.de"))
        self.assertEqual(web.site("orf punkt at"), ("ORF", "https://orf.at"))
        self.assertEqual(web.site("www.beispiel.com/seite"), ("beispiel.com", "https://beispiel.com/seite"))
        self.assertIsNone(web.site("Zauberei"))

    def test_search_urls(self):
        self.assertEqual(web.search_url("youtube", "Katzen Videos"),
                         ("YouTube", "https://www.youtube.com/results?search_query=Katzen+Videos"))
        self.assertEqual(web.search_url("spotify", "Queen live")[1], "https://open.spotify.com/search/Queen%20live")
        self.assertEqual(web.search_url("unbekannt", "x")[0], "Google")
        self.assertTrue(web.directions_url("Graz Hauptplatz").endswith("destination=Graz+Hauptplatz"))
        self.assertTrue(web.first_hit_url("billa").startswith("https://duckduckgo.com/?q=%5C"))

    def test_first_youtube_video(self):
        page = 'x"videoRenderer":{"videoId":"fJ9rUzIMcZQ","thumbnail":{}} y"videoId":"aaaaaaaaaaa"'
        self.assertEqual(web.first_video("queen", fetch=lambda url, timeout: page), "fJ9rUzIMcZQ")
        self.assertIsNone(web.first_video("queen", fetch=lambda url, timeout: "<html>nichts</html>"))

        def broken(url, timeout):
            raise OSError("kein Netz")

        self.assertIsNone(web.first_video("queen", fetch=broken))


class CalcTest(unittest.TestCase):
    def test_spoken_sums(self):
        cases = {
            "15 mal 23": "345", "100 durch 7": "ungefähr 14,2857", "2 hoch 10": "1024", "Wurzel aus 144": "12",
            "20 Prozent von 80": "16", "3,5 + 1,25": "4,75", "1.000 mal 3": "3000", "zwei mal drei": "6",
            "(3 + 4) * 2": "14", "12 x 12": "144", "5 zum Quadrat": "25", "10 geteilt durch 4": "2,5",
            "15 minus 20": "minus 5", "1000 mal 1000": "1.000.000",
        }
        for said, expected in cases.items():
            with self.subTest(said=said):
                self.assertEqual(calc.spoken(calc.evaluate(said)), expected)

    def test_not_a_sum(self):
        for said in ("ein Quasar", "das Wetter", "5", "Hallo 5 mal", "9 hoch 999", "1 durch 0"):
            with self.subTest(said=said), self.assertRaises(calc.CalcError):
                calc.evaluate(said)


WEATHER = {
    "place": "Wien",
    "current": {"temperature_2m": 18.2, "weather_code": 1, "precipitation": 0.0},
    "daily": {
        "time": ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"],
        "weather_code": [3, 80, 0, 61, 2],
        "temperature_2m_max": [24.1, 17.4, 25.0, 15.2, 20.0],
        "temperature_2m_min": [14.0, 9.2, 11.0, 8.6, 10.0],
        "precipitation_probability_max": [0, 70, 5, 45, 10],
    },
}
TODAY = dt.date(2026, 10, 1)  # ein Donnerstag


class WeatherTest(unittest.TestCase):
    def say(self, when, ask=""):
        return spoken_weather(WEATHER, when, ask, TODAY)

    def test_sentences(self):
        self.assertEqual(self.say("jetzt"), "Gerade 18 Grad in Wien, überwiegend klar, Sir.")
        self.assertEqual(self.say("heute"), "Heute in Wien 14 bis 24 Grad, bewölkt. Gerade sind es 18 Grad, Sir.")
        self.assertEqual(self.say("morgen"),
                         "Morgen in Wien 9 bis 17 Grad, Regenschauer, Regenrisiko 70 Prozent. Ein Schirm wäre klug, Sir.")
        self.assertEqual(self.say("wochenende"),
                         "Am Samstag in Wien 11 bis 25 Grad, klar. Am Sonntag 9 bis 15 Grad, leichter Regen, "
                         "Regenrisiko 45 Prozent, Sir.")
        self.assertEqual(self.say("freitag"), self.say("morgen"))

    def test_questions(self):
        self.assertEqual(self.say("jetzt", "regen"), "Nein, Sir, gerade ist es in Wien trocken.")
        self.assertEqual(self.say("morgen", "regen"),
                         "Ja, Sir. Morgen 70 Prozent Regenrisiko in Wien. Nehmen Sie einen Schirm mit.")
        self.assertEqual(self.say("sonntag", "regen"), "Vielleicht, Sir. Am Sonntag liegt das Regenrisiko in Wien bei 45 Prozent.")
        self.assertEqual(self.say("übermorgen", "regen"), "Nein, Sir. Übermorgen bleibt es in Wien trocken.")
        self.assertEqual(self.say("morgen", "temperatur"), "Morgen in Wien 9 bis 17 Grad, Sir.")


class AssistantQuickTest(unittest.TestCase):
    """Alles ohne Claude, mit Schritt im Fenster, und schnell."""

    def run_quick(self, text, **patches):
        from jarvis.config import load_config

        cfg = load_config()
        cfg.setdefault("ich", {})["ort"] = "Wien"
        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain, cfg)
        opened = []
        with mock.patch("jarvis.pc.open_uri", side_effect=opened.append), \
                mock.patch("jarvis.apps._launch", side_effect=opened.append), \
                mock.patch("os.name", "nt"), \
                mock.patch("jarvis.apps.START_MENU.find", return_value=None):
            stack = [mock.patch(target, **kw) for target, kw in patches.items()]
            for patch in stack:
                patch.start()
            try:
                answer = assistant.handle(text)
            finally:
                for patch in stack:
                    patch.stop()
        steps = [(e[1]["label"], e[1]["state"]) for e in ui.of("progress")]
        return answer, opened, steps, brain

    def test_websites_and_searches_open_at_once(self):
        answer, opened, steps, brain = self.run_quick("Such auf YouTube nach Katzenvideos")
        self.assertEqual(opened, ["https://www.youtube.com/results?search_query=Katzenvideos"])
        self.assertIn("Katzenvideos", answer)
        self.assertEqual(steps, [("Sucht auf YouTube: Katzenvideos", "running"), ("Sucht auf YouTube: Katzenvideos", "done")])
        self.assertEqual(brain.asked, [])
        answer, opened, _, brain = self.run_quick("Geh auf amazon.de")
        self.assertEqual(opened, ["https://amazon.de"])
        self.assertEqual(brain.asked, [])

    def test_play_on_youtube_starts_the_first_video(self):
        answer, opened, _, brain = self.run_quick(
            "Spiel Bohemian Rhapsody", **{"jarvis.web.first_video": {"return_value": "fJ9rUzIMcZQ"}})
        self.assertEqual(opened, ["https://www.youtube.com/watch?v=fJ9rUzIMcZQ"])
        self.assertIn("Bohemian Rhapsody", answer)
        self.assertEqual(brain.asked, [])
        # "Spiel Minecraft" startet das Spiel, statt ein Video zu suchen
        with mock.patch("jarvis.apps.open_app", return_value="Minecraft Launcher startet.") as open_app:
            answer, opened, _, _ = self.run_quick("Spiel Minecraft", **{"jarvis.web.first_video": {"return_value": "x" * 11}})
        open_app.assert_called_once_with("Minecraft")
        self.assertEqual(opened, [])

    def test_settings_dark_mode_and_radio(self):
        answer, opened, _, brain = self.run_quick("Öffne die Bluetooth-Einstellungen")
        self.assertEqual(opened, ["ms-settings:bluetooth"])
        with mock.patch("jarvis.pc.dark_mode") as dark:
            answer, _, steps, brain = self.run_quick("Mach den Dunkelmodus an")
        dark.assert_called_once_with(True)
        self.assertEqual(answer, "Dunkler Modus, Sir.")
        with mock.patch("jarvis.pc.radio") as radio:
            answer, _, _, brain = self.run_quick("Bluetooth aus")
        radio.assert_called_once_with("bluetooth", False)
        self.assertEqual(answer, "Bluetooth ist aus, Sir.")
        from jarvis import pc

        with mock.patch("jarvis.pc.radio", side_effect=pc.RadioMissing("kein Bluetooth")):
            answer, _, _, brain = self.run_quick("Bluetooth an")
        self.assertEqual(answer, "Ich finde an diesem PC kein Bluetooth, Sir.")
        self.assertEqual(brain.asked, [])

    def test_weather_and_sums(self):
        from jarvis.weather import Weather

        with mock.patch.object(Weather, "forecast", return_value=dict(WEATHER, place="Wien")):
            answer, _, steps, brain = self.run_quick("Wie wird das Wetter morgen?")
        self.assertTrue(answer.startswith("Morgen in Wien"), answer)
        self.assertEqual(brain.asked, [])
        answer, _, _, brain = self.run_quick("Was ist 15 mal 23?")
        self.assertIn("345", answer)
        self.assertEqual(brain.asked, [])

    def test_weather_falls_back_to_claude_without_internet(self):
        from jarvis.weather import Weather

        with mock.patch.object(Weather, "forecast", side_effect=OSError("kein Netz")):
            _, _, steps, brain = self.run_quick("Wie wird das Wetter morgen?")
        self.assertEqual(len(brain.asked), 1)
        self.assertEqual(steps[-1][1], "error")

    def test_several_commands(self):
        answer, opened, steps, brain = self.run_quick(
            "Öffne YouTube und Reddit", **{"jarvis.apps.open_app": {"side_effect": lambda name: f"{name.title()} ist offen."}})
        self.assertEqual(answer, "Youtube ist offen. Reddit ist offen, Sir.")
        self.assertEqual(brain.asked, [])
        self.assertEqual([s for s in steps if s[1] == "done"], [("Öffnet YouTube", "done"), ("Öffnet Reddit", "done")])

    def test_a_failing_part_goes_to_claude(self):
        from jarvis import apps

        def open_app(name):
            if name.lower() == "zaubertrank":
                raise apps.AppNotFound("weg")
            return "Spotify startet."

        answer, _, _, brain = self.run_quick("Öffne Spotify und Zaubertrank",
                                             **{"jarvis.apps.open_app": {"side_effect": open_app}})
        self.assertEqual(brain.asked, ["öffne Zaubertrank"])
        self.assertIn("Spotify", answer)


if __name__ == "__main__":
    unittest.main()


class PowerTest(unittest.TestCase):
    """Herunterfahren & Co.: mit voller Freigabe sofort, mit Vorlauf und "Abbrechen"."""

    def test_recognition(self):
        from jarvis.intents import match

        cases = {
            "Fahr den PC herunter": "power_off", "Mach den PC aus": "power_off", "PC aus": "power_off",
            "Starte den PC neu": "power_restart", "Neustart": "power_restart",
            "Schick den PC in den Energiesparmodus": "power_sleep", "Melde mich ab": "power_logoff",
            "Herunterfahren abbrechen": "power_abort", "Doch nicht": "power_abort",
            "Fahr herunter": "power_off", "Fahr dich runter": "power_off", "Ruhezustand": "power_sleep",
            "Was kannst du?": "help", "Was kannst du alles?": "help", "Hilfe": "help",
            "Danke": "thanks", "Danke Jarvis": "thanks", "Super, danke": "thanks", "Vielen Dank": "thanks",
            "Energiesparmodus": "power_sleep",
        }
        for said, name in cases.items():
            with self.subTest(said=said):
                self.assertEqual(match(said).name, name)
        self.assertIsNone(match("Soll ich den PC herunterfahren?"))

    def test_full_permission_shuts_down_with_a_grace_period(self):
        from unittest import mock

        from jarvis import pc
        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, _ui, _speaker, _ = make(brain)
        with mock.patch.object(pc, "power", return_value="ok") as power, \
                mock.patch.object(pc, "power_pending", return_value=False):
            answer = assistant.handle("Fahr den PC herunter")
        power.assert_called_once_with("shutdown", 15)
        self.assertIn("15 Sekunden", answer)
        self.assertEqual(brain.asked, [])
        with mock.patch.object(pc, "power_abort", return_value=True) as abort:
            self.assertEqual(assistant.handle("Abbrechen"), "Abgebrochen, Sir. Der PC bleibt an.")
        abort.assert_called_once()

    def test_without_full_permission_claude_asks_first(self):
        from unittest import mock

        from jarvis import pc
        from jarvis.config import load_config
        from tests.test_assistant import FakeBrain, make

        cfg = load_config()
        cfg["rechte"] = {"volle_freigabe": False}
        brain = FakeBrain(chunks=["Wirklich herunterfahren, Sir?"])
        assistant, _ui, _speaker, _ = make(brain, cfg=cfg)
        with mock.patch.object(pc, "power") as power:
            assistant.handle("Fahr den PC herunter")
        power.assert_not_called()
        self.assertEqual(brain.asked, ["Fahr den PC herunter"])

    def test_persona_says_what_jarvis_may_do(self):
        import tempfile
        from pathlib import Path

        from jarvis.config import HOME_DIR
        from jarvis.persona import build_persona

        with tempfile.TemporaryDirectory() as folder:
            full = build_persona(HOME_DIR, Path(folder), {"rechte": {"volle_freigabe": True}}).read_text(encoding="utf-8")
            self.assertIn("volle Freigabe", full)
            self.assertNotIn("Nur bei folgenden Dingen", full)
            careful = build_persona(HOME_DIR, Path(folder), {"rechte": {"volle_freigabe": False}}).read_text(encoding="utf-8")
            self.assertIn("Nur bei folgenden Dingen", careful)
            self.assertNotIn("<!--", careful)

    def test_tool_needs_no_yes_with_full_permission(self):
        from unittest import mock

        from jarvis import pc, tool

        with mock.patch.object(tool, "load_config", return_value={"rechte": {"volle_freigabe": True}}), \
                mock.patch.object(pc, "power", return_value="Der PC fährt in 15 Sekunden herunter.") as power, \
                mock.patch("builtins.print"):
            self.assertEqual(tool.main(["herunterfahren"]), 0)
        power.assert_called_once_with("shutdown", 15)
        with mock.patch.object(tool, "load_config", return_value={"rechte": {"volle_freigabe": False}}), \
                mock.patch.object(tool, "last_said", return_value="Fahr runter"), \
                mock.patch.object(pc, "power") as power, mock.patch("builtins.print"):
            self.assertEqual(tool.main(["herunterfahren"]), 3)
        power.assert_not_called()


class EverydayTest(unittest.TestCase):
    """Alltagssätze, die ohne Claude sofort gehen sollen."""

    def test_recognition(self):
        cases = {
            "Mach Musik an": ("media_play", ""), "Pausiere": ("media_pause", ""), "Lautstärke 50": ("volume_set", "50"),
            "Minimiere alles": ("show_desktop", ""), "Zeig den Desktop": ("show_desktop", ""),
            "Öffne den Desktop": ("folder", "desktop"), "Mach einen Screenshot": ("screenshot", ""),
            "Wie viel Speicher ist frei?": ("disk_free", ""),
        }
        for said, expected in cases.items():
            with self.subTest(said=said):
                found = intents.match(said)
                self.assertEqual((found.name, found.arg), expected)

    def test_alarm_is_a_reminder_at_that_time(self):
        now = dt.datetime(2026, 10, 1, 23, 0)
        for said, when in (("Weck mich um 7", dt.datetime(2026, 10, 2, 7, 0)),
                           ("Weck mich morgen um halb 8", dt.datetime(2026, 10, 2, 7, 30)),
                           ("Stell einen Wecker auf 6:30", dt.datetime(2026, 10, 2, 6, 30)),
                           ("Weck mich morgen um halb sieben", dt.datetime(2026, 10, 2, 6, 30)),
                           ("Weck mich um sieben Uhr", dt.datetime(2026, 10, 2, 7, 0))):
            found = intents.match_reminder(said, now)
            self.assertEqual((found.name, found.data["when"]), ("remind", when), said)
        self.assertEqual(intents.match_reminder("Stell einen Wecker auf 10 Minuten", now).name, "timer")

    def test_call_someone(self):
        found = intents.match("Ruf Max an")
        self.assertEqual((found.name, found.arg, found.data), ("discord", "call", {"target": "max", "any_app": True}))
        for said in ("Ruf die Polizei an", "Ruf 112 an", "Ruf mich an"):
            self.assertIsNone(intents.match(said), said)
        # Vorher Discord-Anrufe bei "meine mutter", "bei pizza hut", "max morgen" und "alle"
        for said in ("Ruf meine Mutter an", "Ruf Mama an", "Ruf bei Pizza Hut an", "Ruf Max morgen an", "Ruf alle an",
                     "Ruf uns an", "Ruf jemanden an"):
            self.assertIsNone(intents.match(said), said)
        self.assertEqual(intents.match("Ruf bitte Tom Müller an").data["target"], "tom müller")

    def test_assistant_does_them(self):
        assistant, ui, speaker, _ = make()
        with mock.patch("jarvis.keys.press") as pressed:
            assistant.handle("Minimiere alles")
            assistant.handle("Mach einen Screenshot")
        self.assertEqual([c.args for c in pressed.call_args_list], [("win", "d"), ("win", "printscreen")])
        parts = [mock.Mock(mountpoint="C:\\", fstype="NTFS", opts="rw,fixed"),
                 mock.Mock(mountpoint="D:\\", fstype="NTFS", opts="rw,fixed"),
                 mock.Mock(mountpoint="E:\\", fstype="", opts="cdrom")]
        usage = {"C:\\": mock.Mock(total=500 * 1024 ** 3, free=120 * 1024 ** 3),
                 "D:\\": mock.Mock(total=2000 * 1024 ** 3, free=830 * 1024 ** 3)}
        with mock.patch("psutil.disk_partitions", return_value=parts), \
                mock.patch("psutil.disk_usage", side_effect=lambda m: usage[m]):
            self.assertEqual(assistant.handle("Wie viel Speicher ist frei?"),
                             "Auf Laufwerk C sind 120 Gigabyte frei, auf D 830, Sir.")
        self.assertEqual(assistant.brain.asked, [])

    def test_call_goes_to_discord_unless_whatsapp_is_known(self):
        assistant, ui, speaker, _ = make()
        with mock.patch("jarvis.messaging.discord_call") as called:
            assistant.handle("Ruf Max an")
        called.assert_called_once_with("max")
        assistant.memory = mock.Mock(contact_app=mock.Mock(return_value="whatsapp"))
        with mock.patch("jarvis.messaging.discord_call") as called:
            assistant.handle("Ruf Anna an")
        called.assert_not_called()
        self.assertEqual(assistant.brain.asked[-1], "Ruf Anna an")


class FalseFriendsTest(unittest.TestCase):
    """Sätze, die nach Befehl klingen, aber keiner sind: lieber Claude als etwas Falsches tun."""

    def test_negations_and_questions_are_not_commands(self):
        from jarvis.memory import match_memory

        for said in ("Spiel nicht so laut", "Spiel keine Musik mehr", "Wie fahre ich den PC herunter?",
                     "Wie mache ich einen Screenshot unter Windows?", "Ruf mich morgen an", "Minimiere das Risiko"):
            self.assertIsNone(intents.match(said), said)
        for said in ("Merk dir das nicht", "Merk dir nicht alles"):
            self.assertIsNone(match_memory(said), said)
        self.assertEqual(intents.match("Zeig mir, was du kannst").name, "help")


class RestartAndSecretsTest(unittest.TestCase):
    def test_restart_an_app(self):
        self.assertEqual((intents.match("Starte Discord neu").name, intents.match("Starte Discord neu").arg),
                         ("restart_app", "discord"))
        self.assertEqual(intents.match("Kannst du Discord neu starten?").name, "restart_app")
        self.assertEqual(intents.match("Starte den PC neu").name, "power_restart")
        # Vorher Programm-Neustart: "windows" passte auf WindowsTerminal.exe und hätte es beendet
        for said in ("Starte Windows neu", "Windows neu starten", "Starte das System neu"):
            self.assertEqual(intents.match(said).name, "power_restart", said)
        self.assertIsNone(intents.match("Geh auf den Server von Hypixel in Minecraft"), "kein Discord-Server")
        assistant, ui, speaker, _ = make()
        with mock.patch("jarvis.apps.close_app", return_value="Discord ist zu.") as closed, \
                mock.patch("jarvis.apps.open_app", return_value="Discord startet.") as opened, \
                mock.patch("jarvis.assistant.time.sleep"):
            answer = assistant.handle("Starte Discord neu")
        closed.assert_called_once_with("discord")
        opened.assert_called_once_with("discord")
        self.assertIn("Discord", answer)
        self.assertEqual(assistant.brain.asked, [])

    def test_passwords_are_never_remembered(self):
        import tempfile
        from pathlib import Path

        from jarvis.memory import Memory

        assistant, ui, speaker, _ = make()
        with tempfile.TemporaryDirectory() as folder:
            assistant.memory = Memory(Path(folder) / "g.json")
            answer = assistant.handle("Merk dir, mein Passwort ist 1234")
            self.assertIn("Passwort-Manager", answer)
            self.assertEqual(assistant.memory.facts(), [])
            self.assertEqual(assistant.memory.remember("Georgs PIN ist 0000", source="jarvis"), "", "auch nicht über Claude")
            self.assertTrue(assistant.memory.remember("Georg spielt gern Valorant"))


class SecretWordsTest(unittest.TestCase):
    def test_only_real_secrets(self):
        from jarvis.memory import is_secret

        self.assertTrue(is_secret("Meine IBAN ist AT12 3456"))
        self.assertFalse(is_secret("Georg war im Libanon im Urlaub"), "Libanon enthält iban")
