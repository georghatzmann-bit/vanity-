import datetime as dt
import unittest

import tests.helpers  # noqa: F401  (Pfad setzen)
from jarvis import intents
from jarvis.stt import clean_transcript
from jarvis.text import SentenceSplitter, speakable, starts_sources, strip_sources


class SpeakableTest(unittest.TestCase):
    def test_removes_markdown_links_and_emojis(self):
        text = "## Wetter\n**Morgen** wird es *sonnig* 🌞, siehe [hier](https://wetter.at).\n- 18 Grad\n- `kein` Regen"
        self.assertEqual(speakable(text), "Wetter Morgen wird es sonnig, siehe hier. 18 Grad kein Regen")

    def test_code_blocks_disappear_and_urls_shrink_to_the_host(self):
        self.assertEqual(speakable("Erledigt.\n```\nrm -rf\n```\nMehr auf https://x.y"), "Erledigt. Mehr auf x.y")
        self.assertEqual(speakable("Schauen Sie auf www.orf.at, dort steht alles."), "Schauen Sie auf orf.at, dort steht alles.")
        self.assertEqual(speakable("Siehe https://example.com/pfad?x=1 für Details."), "Siehe example.com für Details.")
        self.assertEqual(speakable("Mehr unter www.wetter.at."), "Mehr unter wetter.at.")

    def test_keeps_plain_text(self):
        self.assertEqual(speakable("Spotify läuft, Sir."), "Spotify läuft, Sir.")

    def test_numbers_at_the_start_stay(self):
        for text in ("3. Oktober ist ein Feiertag.", "1. FC Köln hat 2:1 gewonnen.", "Am 3. Oktober ist Feiertag.",
                     "Es ist 18:30 Uhr, Sir.", "Das sind z. B. Äpfel, ca. 20 Stück.", "Die Nr. 5 lebt."):
            with self.subTest(text=text):
                self.assertEqual(speakable(text), text)

    def test_real_lists_lose_their_markers(self):
        self.assertEqual(speakable("1. Äpfel\n2. Birnen\n3. Kirschen"), "Äpfel Birnen Kirschen")
        self.assertEqual(speakable("1) Äpfel"), "Äpfel")
        self.assertEqual(speakable("- Punkt eins\n- Punkt zwei"), "Punkt eins Punkt zwei")

    def test_tables_and_math(self):
        self.assertEqual(speakable("| Spalte | Wert |\n|---|---|\n| a | 1 |"), "Spalte Wert a 1")
        self.assertEqual(speakable("--- | ---"), "")
        self.assertEqual(speakable("Es sind 3 * 4 = 12 Stück."), "Es sind 3 mal 4 gleich 12 Stück.")


class SourcesTest(unittest.TestCase):
    def test_start_of_a_sources_block(self):
        for text in ("Sources:", "Sources:\n- [ORF](https://orf.at)", "**Quellen:**", "## Sources", "Quelle: ORF", "  **Sources**:"):
            with self.subTest(text=text):
                self.assertTrue(starts_sources(text))
        for text in ("Quellen zufolge wird es warm.", "Die Quelle: ORF", "In Wien sind es 14 Grad."):
            with self.subTest(text=text):
                self.assertFalse(starts_sources(text))

    def test_strip_sources(self):
        answer = "In Wien sind es 14 Grad, Sir.\n\nSources:\n- [ORF](https://wetter.orf.at/wien/)\n- [wetter.com](https://x.y)"
        self.assertEqual(strip_sources(answer), "In Wien sind es 14 Grad, Sir.")
        self.assertEqual(strip_sources("Das war es.\n**Quellen:**\n- ORF"), "Das war es.")
        self.assertEqual(strip_sources("Keine Quellen hier. "), "Keine Quellen hier.")


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

    def test_short_words_do_not_hide_sentence_ends(self):
        out, rest = self.feed_all(["Ja, das ist gut so. Soll ich noch etwas tun? ", "Gerne."])
        self.assertEqual(out, ["Ja, das ist gut so.", "Soll ich noch etwas tun?"])
        out, rest = self.feed_all(["Wir nehmen Plan B. Das ist sicherer, Sir. ", "Gut."])
        self.assertEqual(out, ["Wir nehmen Plan B.", "Das ist sicherer, Sir."])
        out, rest = self.feed_all(["Das war im Jahr 2024. Danach kam 2025."])
        self.assertEqual(out, ["Das war im Jahr 2024."])

    def test_multi_letter_abbreviations_still_hold(self):
        for text in ("Das sind z. B. Äpfel. ", "Das ist d. h. richtig so. ", "Das Treffen ist am So. um 9 Uhr. ",
                     "Das kostet ca. 20 Euro. ", "Es kommt Dr. Müller. "):
            with self.subTest(text=text):
                out, rest = self.feed_all([text, "Noch etwas?"])
                self.assertEqual(out, [text.strip()])

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

    def test_more_ways_to_say_it(self):
        cases = {
            "Stopp, Jarvis.": "stop",
            "Stopp. Stopp.": "stop",
            "Okay stop.": "stop",
            "Hör auf.": "stop",
            "Aufhören": "stop",
            "Das reicht.": "stop",
            "Schon gut.": "stop",
            "Wie spät ist es gerade?": "time",
            "Wie spät ist es eigentlich?": "time",
            "Wieviel Uhr haben wir?": "time",
            "Wie viel Uhr?": "time",
            "Welcher Tag ist heute, Jarvis?": "date",
            "Noch lauter.": "volume_up",
            "Etwas lauter bitte.": "volume_up",
            "Viel lauter!": "volume_up",
            "Lautstärke hoch.": "volume_up",
            "Lautstärke runter.": "volume_down",
            "Etwas leiser.": "volume_down",
            "Mach die Musik aus.": "media_pause",
            "Musik stopp.": "media_pause",
            "Stopp die Musik.": "media_pause",
        }
        for text, name in cases.items():
            with self.subTest(text=text):
                self.assertEqual(intents.match(text).name, name)

    def test_mute_and_reset(self):
        for text in ("Mikrofon aus", "Mach das Mikrofon aus.", "Mikrofon ausschalten.", "Schlafmodus.", "Geh schlafen.",
                     "Hör auf zuzuhören.", "Hör nicht mehr zu.", "Stumm schalten.", "Mikrofon aus, Jarvis."):
            with self.subTest(text=text):
                self.assertEqual(intents.match(text).name, "mute")
        for text in ("Neue Unterhaltung.", "Neues Gespräch.", "Vergiss alles.", "Fang von vorne an.",
                     "Lass uns ein neues Gespräch anfangen."):
            with self.subTest(text=text):
                self.assertEqual(intents.match(text).name, "reset")

    def test_questions_and_sentences_never_mute_or_reset(self):
        for text in (
            "Ist mein Mikrofon aus?",
            "Warum ist das Mikrofon aus?",
            "Schick den PC in den Schlafmodus.",
            "Wie komme ich aus dem Schlafmodus?",
            "Das Mikrofon aus dem Schrank ist kaputt",
            "Ich möchte ein neues Gespräch mit meiner Mutter vorbereiten",
            "Vergiss alles über Python",
            "Mikrofon aus?",
            "Neues Gespräch?",
        ):
            with self.subTest(text=text):
                self.assertIsNone(intents.match(text))

    def test_volume_set(self):
        for text, value in (("Lautstärke auf 50", "50"), ("Stell die Lautstärke auf 30 Prozent.", "30"),
                            ("Mach die Lautstärke auf 50 %", "50"), ("Lautstärke auf 150", "100")):
            with self.subTest(text=text):
                self.assertEqual(intents.match(text), intents.Intent("volume_set", value))

    def test_normalize(self):
        self.assertEqual(intents.normalize("Stopp, Jarvis."), "stopp")
        self.assertEqual(intents.normalize("Hey Jarvis, stopp. Stopp!"), "stopp")
        self.assertEqual(intents.normalize("Lauter, lauter!"), "lauter")

    def test_everything_else_goes_to_claude(self):
        for text in (
            "Wie spät ist es in Tokio?",
            "Öffne Spotify und Discord",
            "Installiere Spotify und starte es",
            "Mach den PC stumm",
            "Schalte das Mikrofon in Discord aus",
            "Stopp die Musik auf Spotify und öffne Netflix",
            "Wie war das Wetter gestern?",  # "Wie wird das Wetter morgen?" kann Jarvis jetzt selbst
            "Wie spät ist es in New York?",
            "Halt, warte kurz",
            "Stopp die Zeit",
            "Datum von Ostern",
            "Welcher Tag ist morgen?",
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


class GreetingTest(unittest.TestCase):
    def test_morning_with_weather_and_todays_reminders(self):
        import datetime as dt

        from jarvis.greeting import build_greeting

        now = dt.datetime(2026, 10, 1, 8, 15)
        upcoming = [
            {"zeit": "2026-10-01T18:30:00", "text": "Mama anrufen"},
            {"zeit": "2026-10-01T09:00:00", "text": "Tee"},
            {"zeit": "2026-10-02T09:00:00", "text": "Morgen erst"},
        ]
        text = build_greeting(now, {"temp": 12, "text": "leicht bewölkt"}, upcoming)
        self.assertTrue(text.startswith("Guten Morgen, Sir."))
        self.assertIn("Draußen: 12 Grad, leicht bewölkt.", text)
        self.assertIn("Heute stehen noch 2 Erinnerungen an, die nächste um 09:00: Tee.", text)

    def test_evening_without_anything(self):
        import datetime as dt

        from jarvis.greeting import build_greeting

        self.assertEqual(build_greeting(dt.datetime(2026, 10, 1, 21, 0)), "Guten Abend, Sir. Alle Systeme bereit.")

