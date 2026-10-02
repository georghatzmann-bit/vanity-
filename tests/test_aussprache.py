"""Aussprache: Was die Stimmen auf dem PC vorlesen, steht ausgeschrieben da (Zahlen, Uhrzeiten, Kürzel, Englisch).
Im Test sprach die lokale Stimme "25.231 Punkte" als Kauderwelsch und ließ danach oft den Rest des Satzes weg."""

import unittest

from jarvis.aussprache import number, ordinal, speak, year


class NumberTest(unittest.TestCase):
    def test_numbers(self):
        cases = {0: "null", 1: "eins", 16: "sechzehn", 21: "einundzwanzig", 30: "dreißig", 101: "hunderteins",
                 312: "dreihundertzwölf", 1000: "tausend", 1100: "tausendeinhundert", 1234: "tausendzweihundertvierunddreißig",
                 6512: "sechstausendfünfhundertzwölf", 25231: "fünfundzwanzigtausendzweihunderteinunddreißig",
                 101000: "hunderteintausend", 1_000_000: "eine Million", 2_500_000: "zwei Millionen fünfhunderttausend",
                 3_000_000_000: "drei Milliarden", -5: "minus fünf"}
        for value, words in cases.items():
            with self.subTest(value=value):
                self.assertEqual(number(value), words)

    def test_years_and_ordinals(self):
        self.assertEqual(year(1990), "neunzehnhundertneunzig")
        self.assertEqual(year(2026), "zweitausendsechsundzwanzig")
        self.assertEqual(ordinal(3, "en"), "dritten")
        self.assertEqual(ordinal(24, "er"), "vierundzwanzigster")
        self.assertEqual(ordinal(7), "siebte")


class SpeakTest(unittest.TestCase):
    def test_plain_text_stays_as_it_is(self):
        for text in ("Sehr wohl, Sir.", "Erledigt.", "Guten Abend, Sir. Alle Systeme laufen einwandfrei.", ""):
            self.assertEqual(speak(text), text)

    def test_what_jarvis_says_every_day(self):
        cases = {
            "Der DAX steht bei 25.231 Punkten, plus 1,2 % zum Vortag.":
                "Der Dax steht bei fünfundzwanzigtausendzweihunderteinunddreißig Punkten, plus eins Komma zwei Prozent zum Vortag.",
            "Ihr Termin ist am 3.10. um 18:30 Uhr, draußen sind es -2 °C.":
                "Ihr Termin ist am dritten Oktober um achtzehn Uhr dreißig, draußen sind es minus zwei Grad.",
            "Am 24.12.2026 um 7:05 Uhr.": "Am vierundzwanzigsten Dezember zweitausendsechsundzwanzig um sieben Uhr fünf.",
            "Z. B. kostet das ca. 9,99 €, inkl. Versand.":
                "Zum Beispiel kostet das circa neun Euro neunundneunzig, inklusive Versand.",
            "Auf Laufwerk D sind noch 312 GB frei.": "Auf Laufwerk D sind noch dreihundertzwölf Gigabyte frei.",
            "Das Update für CS2 ist 1,5 GB groß.": "Das Apdäit für C S zwei ist eins Komma fünf Gigabyte groß.",
            "Der S&P 500 liegt im Plus.": "Der S und P fünfhundert liegt im Plus.",
            "Die USA und die NATO": "Die U S A und die Nato",
            "10-14 Uhr, 24/7": "zehn bis vierzehn Uhr, vierundzwanzig sieben",
            "Mit 120 km/h.": "Mit hundertzwanzig Kilometer pro Stunde.",
            "Seit 1990 und bis 2030": "Seit neunzehnhundertneunzig und bis zweitausenddreißig",
        }
        for text, words in cases.items():
            with self.subTest(text=text):
                self.assertEqual(speak(text), words)

    def test_english_words_are_spelled_the_german_way(self):
        # Im Test hörte die Spracherkennung bei der lokalen Stimme 2 von 18 englischen Wörtern richtig, so umgeschrieben 18.
        self.assertEqual(speak("Drei neue Mails und ein Newsletter von Steam."), "Drei neue Mehls und ein Njuhsletter von Stiem.")
        self.assertEqual(speak("Counter-Strike läuft, das WLAN auch."), "Kaunter-Streik läuft, das Weh-Lahn auch.")
        self.assertEqual(speak("Mailbox und Steamdeck"), "Mailbox und Steamdeck", "nur ganze Wörter")

    def test_version_numbers_and_dates_without_day_stay_readable(self):
        self.assertEqual(speak("Version 2.0.0 ist da."), "Version 2.0.0 ist da.")
        self.assertEqual(speak("Nr. 7"), "Nummer sieben")

    def test_never_breaks_on_odd_input(self):
        for text in ("99:99 Uhr", "32.13.", "€€€", "1,,2", "/ & %", "A" * 500, "12345678901234567890"):
            with self.subTest(text=text[:20]):
                self.assertIsInstance(speak(text), str)


if __name__ == "__main__":
    unittest.main()
