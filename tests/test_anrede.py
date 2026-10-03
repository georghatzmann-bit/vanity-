"""Anrede und Ton: "Sir" wie im Film oder "Chef" wie im Video, per Sprache umschaltbar, überall gleich."""

import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import anrede
from jarvis.anrede import apply, clean, match_talk, persona_section, set_word


class AddressTest(unittest.TestCase):
    def tearDown(self):
        set_word("Sir")

    def test_apply_only_whole_words(self):
        self.assertEqual(apply("Sehr wohl, Sir."), "Sehr wohl, Sir.")
        set_word("chef")
        self.assertEqual(anrede.word(), "Chef")
        self.assertEqual(apply("Sehr wohl, Sir. Die Sirene ist aus, Sir!"), "Sehr wohl, Chef. Die Sirene ist aus, Chef!")
        self.assertEqual(apply(""), "")
        self.assertEqual(apply("Sir Lewis Hamilton hat gewonnen, Sir."), "Sir Lewis Hamilton hat gewonnen, Chef.",
                         "der Titel vor einem Namen bleibt")

    def test_clean_falls_back_to_sir(self):
        self.assertEqual(clean("  boss "), "Boss")
        for bad in ("", "x" * 30, "<script>", "a;b"):
            self.assertEqual(clean(bad), "Sir", bad)
        self.assertEqual(anrede.from_config({"ich": {"anrede": "Meister"}}), "Meister")
        self.assertEqual(anrede.from_config({}), "Sir")
        self.assertEqual(anrede.tone_from_config({"ich": {"ton": "LOCKER"}}), "locker")
        self.assertEqual(anrede.tone_from_config({"ich": {"ton": "frech"}}), "butler")

    def test_spoken_commands(self):
        self.assertEqual(match_talk("Jarvis, nenn mich ab jetzt Chef!"), ("anrede", "Chef"))
        self.assertEqual(match_talk("Sag Boss zu mir"), ("anrede", "Boss"))
        self.assertEqual(match_talk("Nenn mich wieder Sir"), ("anrede", "Sir"))
        self.assertEqual(match_talk("Sprich lockerer"), ("ton", "locker"))
        self.assertEqual(match_talk("Rede wie im Video"), ("ton", "locker"))
        self.assertEqual(match_talk("Sei wieder förmlich"), ("ton", "butler"))
        for other in ("Nenn mich nicht so", "Sag mir das Wetter", "Öffne Spotify", "Sprich lauter", "Sag Hallo zu mir",
                      "Nenn mich bitte"):
            self.assertIsNone(match_talk(other), other)

    def test_persona_section(self):
        self.assertEqual(persona_section("butler", "Sir"), "")
        text = persona_section("locker", "Chef")
        self.assertIn("„Chef“", text)
        self.assertIn("Gute Fahrt, Chef.", text)


class PersonaTest(unittest.TestCase):
    def test_persona_uses_the_word_and_the_tone(self):
        from jarvis.persona import build_persona

        with tempfile.TemporaryDirectory() as folder:
            home, state = Path(folder) / "home", Path(folder) / "daten"
            home.mkdir()
            (home / "CLAUDE.md").write_text('Sprich Georg mit "Sir" an.\n- "Spotify läuft, Sir."\n', encoding="utf-8")
            cfg = {"ich": {"anrede": "Chef", "ton": "locker"}, "notizbuch": {"aktiv": False}}
            with mock.patch("jarvis.skills.load_skills", return_value=[]):
                text = build_persona(home, state, cfg).read_text(encoding="utf-8")
            self.assertIn('Sprich Georg mit "Chef" an.', text)
            self.assertIn('"Spotify läuft, Chef."', text)
            self.assertIn("Dein Ton", text)
            self.assertNotIn("Sir", text)
            with mock.patch("jarvis.skills.load_skills", return_value=[]):
                plain = build_persona(home, state, {"notizbuch": {"aktiv": False}}).read_text(encoding="utf-8")
            self.assertIn('"Sir"', plain)
            self.assertNotIn("Dein Ton", plain)


class EverywhereTest(unittest.TestCase):
    def tearDown(self):
        set_word("Sir")

    def test_window_voice_and_answers(self):
        from jarvis.memory import Memory
        from jarvis.ui import MultiUi
        from tests.helpers import RecordingUi
        from tests.test_assistant import FakeBrain, make

        set_word("Chef")
        seen = RecordingUi()
        MultiUi(seen).message("jarvis", "Erledigt, Sir.")
        MultiUi(seen).message("user", "Danke Sir")
        MultiUi(seen).toast("Gespeichert, Sir.")
        self.assertEqual([e[2] if e[0] == "message" else e[1] for e in seen.events],
                         ["Erledigt, Chef.", "Danke Sir", "Gespeichert, Chef."])
        assistant, ui, speaker, _ = make(FakeBrain())
        with tempfile.TemporaryDirectory() as folder:
            assistant.memory = Memory(Path(folder) / "gedaechtnis.json")
            self.assertEqual(assistant.handle("Was steht auf der Einkaufsliste?", speak=True),
                             "Ihre Einkaufsliste ist leer, Chef.", "auch für Telegram, Alexa und das Handy")
        self.assertEqual(speaker.said[-1], "Ihre Einkaufsliste ist leer, Chef.")
        assistant.say("Gute Fahrt, Sir.")
        self.assertEqual(speaker.said[-1], "Gute Fahrt, Chef.")

    def test_push_uses_the_word(self):
        import datetime as dt

        from jarvis.push import Push

        set_word("Chef")
        push = Push({"handy": {"push": True, "push_kanal": "jarvis-test-kanal-1234567890"}})
        sent = []
        push._post = lambda payload: sent.append(payload) or True
        self.assertTrue(push.send("Erinnerung, Sir: Training.", wait=True))
        self.assertEqual(sent[0]["message"], "Erinnerung, Chef: Training.")
        with mock.patch("threading.Thread"):
            push.schedule("Termin, Sir.", dt.datetime.now() + dt.timedelta(hours=1))

    def test_spoken_switch_saves_and_restarts_claude(self):
        from tests.test_assistant import FakeBrain, make

        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain)
        saved = {}
        with mock.patch("jarvis.config.save_setting", side_effect=lambda s, k, v, *a: saved.__setitem__((s, k), v)), \
                mock.patch("jarvis.persona.build_persona") as persona:
            self.assertEqual(assistant.handle("Nenn mich Chef", speak=False), "Sehr gern, Chef. Ab jetzt sage ich Chef.")
            self.assertEqual(saved[("ich", "anrede")], "Chef")
            self.assertEqual(anrede.word(), "Chef")
            self.assertEqual(assistant.handle("Sei wieder förmlich", speak=False), "Sehr wohl, Sir. Wieder ganz Butler.")
            self.assertEqual((saved[("ich", "ton")], saved[("ich", "anrede")]), ("butler", "Sir"))
            self.assertEqual(assistant.handle("Sprich lockerer", speak=False), "Alles klar, Chef. Ab jetzt etwas lockerer.")
        self.assertEqual(persona.call_count, 3)
        self.assertGreaterEqual(brain.reset, 3, "neue Unterhaltung mit der neuen Persönlichkeit")
        self.assertEqual(brain.asked, [], "ohne Claude")


class UpgradeTest(unittest.TestCase):
    def test_existing_setup_gets_chef_and_the_loose_tone(self):
        from jarvis.config import EXAMPLE_PATH, load_config, upgrade_config

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            text = EXAMPLE_PATH.read_text(encoding="utf-8").split("[intern]")[0]
            text = text.replace('anrede = "Sir"\n', "").replace('ton = "butler"\n', "")
            path.write_text(text + "\n[intern]\nconfig_version = 9\n", encoding="utf-8")
            self.assertEqual(sorted(upgrade_config(path)), ["ich.anrede = Chef", "ich.ton = locker"])
            cfg = load_config(path)
            self.assertEqual((cfg["ich"]["anrede"], cfg["ich"]["ton"]), ("Chef", "locker"))
            self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8"))["intern"]["config_version"], 10)

    def test_new_setup_keeps_sir(self):
        from jarvis.config import EXAMPLE_PATH, load_config, upgrade_config

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text(EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
            upgrade_config(path)
            self.assertEqual(load_config(path)["ich"]["anrede"], "Sir")


if __name__ == "__main__":
    unittest.main()
