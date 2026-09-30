import datetime as dt
import unittest

import tests.helpers  # noqa: F401  (Pfad setzen)
from jarvis import intents
from jarvis.stt import clean_transcript
from jarvis.text import SentenceSplitter, speakable


class SpeakableTest(unittest.TestCase):
    def test_removes_markdown_links_and_emojis(self):
        text = "## Wetter\n**Morgen** wird es *sonnig* 🌞, siehe [hier](https://wetter.at).\n- 18 Grad\n- `kein` Regen"
        self.assertEqual(speakable(text), "Wetter Morgen wird es sonnig, siehe hier. 18 Grad kein Regen")

    def test_code_blocks_and_urls_disappear(self):
        self.assertEqual(speakable("Erledigt.\n```\nrm -rf\n```\nMehr auf https://x.y"), "Erledigt. Mehr auf")

    def test_keeps_plain_text(self):
        self.assertEqual(speakable("Spotify läuft, Sir."), "Spotify läuft, Sir.")


class SentenceSplitterTest(unittest.TestCase):
    def feed_all(self, chunks):
        splitter = SentenceSplitter()
        out = []
        for chunk in chunks:
            out += splitter.feed(chunk)
        return out, splitter.flush()

    def test_sentences_come_out_as_soon_as_they_end(self):
        splitter = SentenceSplitter()
        self.assertEqual(splitter.feed("Guten Tag, Sir"), [])
        self.assertEqual(splitter.feed(". Heute ist Mitt"), ["Guten Tag, Sir."])
        self.assertEqual(splitter.feed("woch."), [])
        self.assertEqual(splitter.flush(), ["Heute ist Mittwoch."])

    def test_abbreviations_and_dates_do_not_split(self):
        out, rest = self.feed_all(["Das ist z. B. am 3. Oktober so, Sir. ", "Noch etwas?"])
        self.assertEqual(out, ["Das ist z. B. am 3. Oktober so, Sir."])
        self.assertEqual(rest, ["Noch etwas?"])

    def test_short_fragments_wait_for_more(self):
        out, rest = self.feed_all(["Ja. ", "Das Licht ist jetzt aus, Sir. "])
        self.assertEqual(out, ["Ja. Das Licht ist jetzt aus, Sir."])
        self.assertEqual(rest, [])

    def test_paragraph_break_ends_a_sentence(self):
        out, rest = self.feed_all(["Einen Moment, ich schaue nach", "\n\n", "Heute ist Mittwoch."])
        self.assertEqual(out, ["Einen Moment, ich schaue nach"])
        self.assertEqual(rest, ["Heute ist Mittwoch."])


class IntentTest(unittest.TestCase):
    def test_matches(self):
        cases = {
            "Wie spät ist es?": "time",
            "Jarvis, wie viel Uhr ist es jetzt?": "time",
            "Welcher Tag ist heute?": "date",
            "Stopp.": "stop",
            "Hey Jarvis, Mikrofon aus bitte": "mute",
            "Mach das Mikrofon aus": "mute",
            "Neue Unterhaltung": "reset",
            "Mach die Musik lauter": "volume_up",
            "Leiser!": "volume_down",
            "Musik pausieren": "media_pause",
            "Nächstes Lied": "media_next",
        }
        for text, name in cases.items():
            with self.subTest(text=text):
                self.assertEqual(intents.match(text).name, name)

    def test_everything_else_goes_to_claude(self):
        for text in (
            "Wie spät ist es in Tokio?",
            "Öffne YouTube",
            "Mach den PC stumm",
            "Schalte das Mikrofon in Discord aus",
            "Stopp die Musik auf Spotify und öffne Netflix",
            "Wie wird das Wetter morgen?",
        ):
            with self.subTest(text=text):
                self.assertIsNone(intents.match(text))

    def test_spoken_time_and_date(self):
        self.assertEqual(intents.spoken_time(dt.datetime(2026, 9, 30, 14, 0)), "Es ist 14 Uhr, Sir.")
        self.assertEqual(intents.spoken_time(dt.datetime(2026, 9, 30, 9, 5)), "Es ist 9 Uhr 5, Sir.")
        self.assertEqual(intents.spoken_date(dt.date(2026, 9, 30)), "Heute ist Mittwoch, der 30. September, Sir.")


class TranscriptTest(unittest.TestCase):
    def test_whisper_noise_is_dropped(self):
        self.assertEqual(clean_transcript("Untertitel im Auftrag des ZDF, 2021"), "")
        self.assertEqual(clean_transcript("Untertitel der Amara.org-Community"), "")
        self.assertEqual(clean_transcript("Vielen Dank fürs Zuschauen!"), "")
        self.assertEqual(clean_transcript(" ... "), "")
        self.assertEqual(clean_transcript("Ähm."), "")

    def test_real_commands_stay(self):
        self.assertEqual(clean_transcript(" Öffne YouTube. "), "Öffne YouTube.")
        self.assertEqual(clean_transcript("Mach ZDF an"), "Mach ZDF an")
        self.assertEqual(clean_transcript("Vielen Dank, Jarvis."), "Vielen Dank, Jarvis.")


if __name__ == "__main__":
    unittest.main()
