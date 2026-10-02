"""Mails lesen über IMAP (nur lesen): Kodierungen, Suche, Konten, Ansagen und Sätze."""

import datetime as dt
import json
import logging
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from tests.fake_icloud import MAILS, NEWSLETTER, RAW_HEADER, FakeBox, FakeImap, mail
from jarvis.geheim import Secrets
from jarvis.mail import (Account, Mailbox, MailClient, MailError, Message, html_text, is_important, match_mail,
                         snippet, speakable_sender, spoken_new, spoken_unread)

GMAIL = Account("gmail", "gmail", "georg.test@gmail.com", "imap.gmail.com")


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


def local(*args):
    """Berliner Zeit in die Ortszeit dieses Rechners (die Tests laufen auch in UTC)."""
    from zoneinfo import ZoneInfo

    return dt.datetime(*args, tzinfo=ZoneInfo("Europe/Berlin")).astimezone().replace(tzinfo=None)


def box(**kwargs):
    mails = {**MAILS, 105: NEWSLETTER, 106: RAW_HEADER}
    return FakeBox({("georg.test@gmail.com", "app-passwort")}, mails, **kwargs)


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.box = box()
        patcher = mock.patch.object(FakeImap, "boxes", {"imap.gmail.com": self.box})
        patcher.start()
        self.addCleanup(patcher.stop)
        imap = mock.patch("imaplib.IMAP4_SSL", FakeImap)
        imap.start()
        self.addCleanup(imap.stop)
        self.client = MailClient(GMAIL, "app-passwort")

    def assert_nothing_changed(self):
        self.assertEqual(self.box.marked_read, [], "Jarvis markiert nichts als gelesen")
        self.assertTrue(all(entry[2] is True for entry in self.box.log if entry[0] == "SELECT"), "nur EXAMINE")
        self.assertEqual(self.box.messages[102][1], set())

    def test_latest_with_all_the_encodings(self):
        found = {m.uid: m for m in self.client.latest(10)}
        self.assertEqual(sorted(found), [101, 102, 103, 104, 105, 106])
        sparkasse = found[102]
        self.assertEqual((sparkasse.sender, sparkasse.address), ("Sparkasse KölnBonn", "info@sparkasse-koelnbonn.de"))
        self.assertEqual(sparkasse.subject, "Ihr Kontoauszug für Oktober")
        self.assertEqual(sparkasse.snippet, "Guten Tag, Ihr Kontoauszug für Oktober liegt bereit. Bitte melden Sie sich an.")
        self.assertTrue(sparkasse.unread)
        self.assertFalse(sparkasse.bulk)
        amazon = found[104]
        self.assertEqual((amazon.who, amazon.subject), ("Amazon", "Versandbestätigung"))
        self.assertTrue(amazon.snippet.startswith("Ihre Bestellung ist unterwegs: Controller für die Xbox. Lieferung "
                                                  "morgen zwischen 10 und 14 Uhr. Wir melden uns"), amazon.snippet)
        reply = found[103]
        self.assertEqual(reply.snippet, "Hi Georg, alles klar, ich bringe den Grill mit. Grüße aus Köln!",
                         "latin-1, quoted-printable, ohne Zitat und Signatur")
        self.assertEqual(reply.date, local(2026, 10, 2, 9, 15))
        self.assertFalse(found[101].unread)
        self.assertTrue(found[105].bulk, "Newsletter (List-Unsubscribe)")
        raw = found[106]
        self.assertEqual((raw.sender, raw.subject), ("Müller, Jürgen", "Rücksendung bestätigt"), "rohe Umlaute im Kopf")
        self.assertEqual(raw.id, "gmail:106")
        self.assert_nothing_changed()
        items = [entry[2] for entry in self.box.log if entry[0] == "FETCH"]
        self.assertTrue(items and all("BODY.PEEK[]<0." in i for i in items))

    def test_unread_read_and_flags_after_the_body(self):
        self.box.flags_after = True  # wie manche Server: FLAGS hinter dem Inhalt
        count, newest = self.client.unread(3)
        self.assertEqual(count, 5)
        self.assertEqual([m.uid for m in newest], [104, 105, 106])
        self.assertTrue(all(m.unread for m in newest))
        whole = self.client.read(102)
        self.assertIn("Ihr Kontoauszug für Oktober liegt bereit.", whole.text)
        self.assertNotIn("color", whole.text, "kein CSS")
        self.assertNotIn("tracking", whole.text, "kein Skript")
        self.assertIsNone(self.client.read(999))
        self.assert_nothing_changed()

    def test_search_with_and_without_utf8(self):
        self.assertEqual([m.uid for m in self.client.search(["Grill"])], [101, 103], "wie IMAP: auch in \"grillen\"")
        self.assertEqual([m.uid for m in self.client.search(["bringe", "Grill"])], [103])
        self.assertEqual([m.uid for m in self.client.search(["Rücksendung"])], [106])
        search = [e for e in self.box.log if e[:2] == ("UID", "SEARCH")][-1]
        self.assertEqual(search[2][:2], ("CHARSET", "UTF-8"))
        self.assertEqual(search[3], "Rücksendung".encode("utf-8"), "Umlaute als Literal")
        self.box.utf8 = False  # Server ohne UTF-8-Suche: der Teil ohne Umlaute
        self.assertEqual([m.uid for m in self.client.search(["Rücksendung"])], [106])
        self.assertEqual([e for e in self.box.log if e[:2] == ("UID", "SEARCH")][-1][2], ("TEXT", '"cksendung"'))
        self.assertEqual(self.client.search(["x"]), [])
        self.assert_nothing_changed()

    def test_latest_from(self):
        self.assertEqual(self.client.latest_from("Max").uid, 103)
        self.assertEqual(self.client.latest_from("Jürgen Müller").uid, 106)
        self.assertEqual(self.client.latest_from("sparkasse").uid, 102)
        self.assertIsNone(self.client.latest_from("Lisa"))

    def test_wrong_password_and_no_connection(self):
        with self.assertRaises(MailError) as caught:
            MailClient(GMAIL, "normales-passwort").check()
        self.assertEqual(caught.exception.kind, "passwort")
        self.assertIn("Gmail braucht ein App-Passwort", str(caught.exception))
        self.box.down = True
        with self.assertRaises(MailError) as caught:
            self.client.check()
        self.assertEqual(str(caught.exception), "Gmail antwortet nicht (Zeitüberschreitung).")
        with self.assertRaises(MailError) as caught:
            MailClient(Account("x", "imap", "a@b.de", "imap.unbekannt.example"), "pw").check()
        self.assertIn("nicht erreichbar", str(caught.exception))

    def test_icloud_also_takes_the_name_without_domain(self):
        icloud = FakeBox({("beispiel", "abcd-efgh-ijkl-mnop")}, MAILS)
        with mock.patch.object(FakeImap, "boxes", {"imap.mail.me.com": icloud}):
            client = MailClient(Account("icloud", "icloud", "beispiel@icloud.com", "imap.mail.me.com"), "abcd-efgh-ijkl-mnop")
            self.assertTrue(client.check())
        self.assertEqual([e[1] for e in icloud.log if e[0] == "LOGIN"], ["beispiel@icloud.com", "beispiel"])


class MailboxTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)
        self.secrets = Secrets(self.state / "geheim.json")
        self.icloud = FakeBox({("beispiel@icloud.com", "abcd-efgh-ijkl-mnop")}, {})
        self.gmail = box()
        boxes = mock.patch.object(FakeImap, "boxes", {"imap.mail.me.com": self.icloud, "imap.gmail.com": self.gmail})
        boxes.start()
        self.addCleanup(boxes.stop)
        imap = mock.patch("imaplib.IMAP4_SSL", FakeImap)
        imap.start()
        self.addCleanup(imap.stop)
        self.clock = Clock(dt.datetime(2026, 10, 2, 12, 0))
        quiet = mock.patch.object(logging.getLogger("jarvis.geheim"), "level", logging.ERROR)  # Linux: nur kodiert
        quiet.start()
        self.addCleanup(quiet.stop)

    def tearDown(self):
        self.folder.cleanup()

    def mailbox(self, apple_id=""):
        return Mailbox(self.state, self.secrets, apple_id, now=self.clock)

    def test_accounts_add_and_remove(self):
        mailbox = self.mailbox()
        self.assertFalse(mailbox.configured)
        self.secrets.set("apple", "abcd-efgh-ijkl-mnop")
        mailbox = self.mailbox("beispiel@icloud.com")
        self.assertEqual([(a.id, a.auto) for a in mailbox.accounts()], [("icloud", True)])
        with self.assertRaisesRegex(MailError, "Gmail lehnt das Passwort ab"):
            mailbox.add("gmail", "georg.test@gmail.com", "falsch")
        self.assertEqual(len(mailbox.accounts()), 1, "nichts gespeichert")
        account = mailbox.add("", "georg.test@gmail.com", "app-passwort")  # Anbieter an der Adresse erkannt
        self.assertEqual((account.id, account.server), ("gmail", "imap.gmail.com"))
        stored = (self.state / "mail-konten.json").read_text(encoding="utf-8")
        self.assertNotIn("app-passwort", stored)
        self.assertEqual(json.loads(stored)[0]["email"], "georg.test@gmail.com")
        self.assertEqual(self.secrets.get("mail:gmail"), "app-passwort")
        self.assertEqual(account.as_dict()["email"], "ge•••t@gmail.com")
        with self.assertRaisesRegex(MailError, "IMAP-Server angeben"):
            mailbox.add("andere", "georg@firma.example", "pw")
        with self.assertRaisesRegex(MailError, "schon verbunden"):
            mailbox.add("icloud", "Beispiel@iCloud.com", "abcd-efgh-ijkl-mnop")
        with self.assertRaisesRegex(MailError, "keine E-Mail-Adresse"):
            mailbox.add("gmail", "georg", "pw")
        self.assertTrue(mailbox.remove("gmail"))
        self.assertFalse(mailbox.remove("gmail"))
        self.assertEqual(self.secrets.get("mail:gmail"), "")

    def test_gmail_app_password_with_spaces_and_custom_server(self):
        mailbox = self.mailbox()
        self.gmail.logins.add(("georg.test@gmail.com", "abcdefghijklmnop"))
        mailbox.add("gmail", "georg.test@gmail.com", "abcd efgh ijkl mnop")
        FakeImap.boxes["mail.firma.example"] = FakeBox({("georg@firma.example", "pw")}, {})
        account = mailbox.add("eigener", "georg@firma.example", "pw", server="mail.firma.example:1993")
        self.assertEqual((account.provider, account.port), ("imap", 1993))

    def test_spoken_answers(self):
        mailbox = self.mailbox()
        self.assertEqual(mailbox.answer("neu"), "Ihre Mails sind noch nicht verbunden, Sir. Das geht im Jarvis-Fenster "
                                               "unter Verbinden.")
        self.assertIsNone(mailbox.answer("von", "Max"))
        mailbox.add("gmail", "georg.test@gmail.com", "app-passwort")
        for uid in (105, 106):
            del self.gmail.messages[uid]
        self.gmail.add(90, mail("Alt <alt@example.com>", "Vom Januar", "x", "Thu, 01 Jan 2026 10:00:00 +0100"),
                       internal="01-Jan-2026 10:00:00 +0100")  # ungelesen, aber nicht neu
        self.assertEqual(mailbox.answer("neu"), "Drei neue, Sir: von Amazon, Max Mustermann und Sparkasse KölnBonn.")
        search = [e for e in self.gmail.log if e[:2] == ("UID", "SEARCH")][-1]
        self.assertEqual(search[2], ("UNSEEN", "SINCE", "25-Sep-2026"))
        self.assertEqual(mailbox.overview()["ungelesen"], 4, "die Oberfläche zeigt alle ungelesenen")
        when = local(2026, 10, 2, 9, 15)
        self.assertEqual(mailbox.answer("von", "Max"),
                         f"Max hat heute um {when.hour}:{when.minute:02d} geschrieben, Sir. Betreff: Grillen am "
                         "Samstag? Hi Georg, alles klar, ich bringe den Grill mit. Grüße aus Köln!")
        self.assertIsNone(mailbox.answer("von", "Lisa"))
        self.gmail.down = True
        self.assertEqual(mailbox.answer("neu"), "Die Mails kann ich gerade nicht abrufen, Sir. Gmail antwortet nicht "
                                                "(Zeitüberschreitung).")
        self.assertIsNone(mailbox.answer("von", "Max"))

    def test_all_accounts_together(self):
        self.secrets.set("apple", "abcd-efgh-ijkl-mnop")
        mailbox = self.mailbox("beispiel@icloud.com")
        mailbox.add("gmail", "georg.test@gmail.com", "app-passwort")
        self.icloud.add(7, mail("Anna <anna@example.org>", "Kino?", "Heute Abend Kino?", "Fri, 02 Oct 2026 11:30:00 +0200"))
        latest = mailbox.latest(3)
        self.assertEqual([m.id for m in latest], ["gmail:106", "icloud:7", "gmail:105"], "nach Datum, über alle Konten")
        self.assertEqual(mailbox.read("icloud:7").text, "Heute Abend Kino?")
        with self.assertRaisesRegex(MailError, "kenne ich nicht"):
            mailbox.read("yahoo:1")
        self.assertEqual([m.id for m in mailbox.search(["Kino"])], ["icloud:7"])
        overview = mailbox.overview(limit=2)
        self.assertEqual(overview["ungelesen"], 6)
        self.assertEqual([m["id"] for m in overview["letzte"]], ["gmail:106", "icloud:7"])
        self.assertEqual(set(overview["letzte"][0]), {"id", "von", "adresse", "betreff", "datum", "ungelesen",
                                                       "newsletter", "vorschau"})
        self.gmail.down = True
        self.assertEqual([m.id for m in mailbox.latest(3)], ["icloud:7"], "ein Konto weg: die anderen gehen weiter")
        self.assertIn("gmail", mailbox.errors)

    def test_announcements_only_for_people_and_at_most_every_ten_minutes(self):
        mailbox = self.mailbox()
        mailbox.add("gmail", "georg.test@gmail.com", "app-passwort")
        people = [{"name": "Max", "mails": []}, {"name": "Anna Schmidt", "mails": ["anna@example.org"]}]
        self.assertEqual(mailbox.poll(people, force=True), [], "beim ersten Blick ist nichts neu")
        self.gmail.add(107, mail("Max Mustermann <max.mustermann@gmail.com>", "Kino heute?", "Um acht?",
                                 "Fri, 02 Oct 2026 12:30:00 +0200"))
        self.gmail.add(108, NEWSLETTER[0])
        self.gmail.add(109, mail("Unbekannt <wer@example.net>", "Hallo", "Hi", "Fri, 02 Oct 2026 12:31:00 +0200"))
        self.assertEqual([m.uid for m in mailbox.poll(people)], [], "höchstens alle paar Minuten")
        self.assertEqual([m.uid for m in mailbox.poll(people, force=True)], [107])
        self.assertEqual(mailbox.take_announcement(), "Sir, eine neue Mail von Max Mustermann: Kino heute?")
        self.gmail.add(110, mail("Anna <anna@example.org>", "Treffen", "Morgen?", "Fri, 02 Oct 2026 12:40:00 +0200"))
        self.gmail.add(111, mail("Anna <anna@example.org>", "Nochmal", "Und?", "Fri, 02 Oct 2026 12:41:00 +0200"))
        self.assertEqual([m.uid for m in mailbox.poll(people, force=True)], [110, 111])
        self.assertEqual(mailbox.take_announcement(), "", "zehn Minuten Pause")
        mailbox._said_at -= 601
        self.gmail.messages[111][1].add("\\Seen")  # auf dem iPhone gelesen
        mailbox.poll(people, force=True)
        self.assertEqual(mailbox.take_announcement(), "Sir, eine neue Mail von Anna: Treffen.")
        self.assertEqual(self.gmail.marked_read, [])
        state = json.loads((self.state / "mail-stand.json").read_text(encoding="utf-8"))
        self.assertEqual(state["gmail"], {"uidvalidity": "7", "letzte": 111})

    def test_rejected_password_pauses_and_a_missing_mailbox_is_named(self):
        mailbox = self.mailbox()
        mailbox.add("gmail", "georg.test@gmail.com", "app-passwort")
        self.secrets.set("apple", "abcd-efgh-ijkl-mnop")
        both = self.mailbox("beispiel@icloud.com")
        self.gmail.down = True
        self.assertEqual(both.answer("neu"), "Keine neuen Mails, Sir. Gmail war gerade nicht erreichbar.")
        self.gmail.down = False
        self.gmail.logins.clear()  # Passwort beim Anbieter widerrufen
        logins = lambda: sum(1 for e in self.gmail.log if e[0] == "LOGIN")  # noqa: E731
        both.poll([], force=True)
        tried = logins()
        self.assertIn("Gmail lehnt das Passwort ab", both.errors["gmail"])
        both.poll([], force=True)
        self.assertEqual(logins(), tried, "eine Stunde Ruhe, statt alle paar Minuten abgelehnt zu werden")
        self.assertIn("icloud", json.loads((self.state / "mail-stand.json").read_text(encoding="utf-8")))

    def test_renumbered_mailbox_is_a_first_look_again(self):
        mailbox = self.mailbox()
        mailbox.add("gmail", "georg.test@gmail.com", "app-passwort")
        mailbox.poll([{"name": "Max"}], force=True)
        self.gmail.validity = 8
        self.gmail.add(120, mail("Max <max@example.com>", "Neu", "x", "Fri, 02 Oct 2026 13:00:00 +0200"))
        self.assertEqual(mailbox.poll([{"name": "Max"}], force=True), [])


class SentenceTest(unittest.TestCase):
    def message(self, sender, address, subject="", bulk=False, uid=1):
        return Message(f"gmail:{uid}", "gmail", uid, sender, address, subject, None, True, bulk)

    def test_understood(self):
        cases = {
            "Hab ich neue Mails?": ("neu", ""), "Neue E-Mails?": ("neu", ""), "Habe ich ungelesene E-Mails?": ("neu", ""),
            "Sind neue Mails da?": ("neu", ""), "Gibt es neue E-Mails?": ("neu", ""), "Jarvis, hab ich Post?": ("neu", ""),
            "Check mal meine Mails": ("neu", ""), "Wie viele ungelesene Mails habe ich?": ("neu", ""),
            "Irgendwelche neuen Mails?": ("neu", ""), "Hab ich neue Mails bekommen?": ("neu", ""),
            "Was schreibt Max?": ("von", "Max"), "Was hat mir Max geschrieben?": ("von", "Max"),
            "Hat Anna geschrieben?": ("von", "Anna"), "Was schreibt die Sparkasse?": ("von", "Sparkasse"),
            "Lies mir die letzte Mail von Max vor": ("von", "Max"),
        }
        for said, expected in cases.items():
            self.assertEqual(match_mail(said), expected, said)
        for said in ("Was schreibt Max auf Discord?", "Was schreibt man in eine Bewerbung?", "Was hat er geschrieben?",
                     "Schreib Max eine Mail", "Fass meine Mails zusammen", "Beantworte die Mail von Max",
                     "Hab ich neue Nachrichten?", "Was schreibt man?"):
            self.assertIsNone(match_mail(said), said)

    def test_spoken(self):
        self.assertEqual(spoken_unread(0, []), "Keine neuen Mails, Sir.")
        one = self.message("Max Mustermann", "max@example.com", "Kino?")
        self.assertEqual(spoken_unread(1, [one]), "Eine neue, Sir: von Max Mustermann, Betreff: Kino?")
        many = [self.message("", "info@sparkasse.de", uid=2), self.message("Amazon.de", "a@amazon.de", uid=3), one]
        self.assertEqual(spoken_unread(12, many), "Zwölf neue, Sir, unter anderem von Sparkasse, Amazon und Max Mustermann.")
        self.assertEqual(spoken_unread(25, many[:1]), "25 neue, Sir, unter anderem von Sparkasse.")
        news = [self.message("Spiele-News", "newsletter@spiele.example", bulk=True, uid=9), many[1]]
        self.assertEqual(spoken_unread(5, news), "Fünf neue, Sir, unter anderem von Amazon.", "Menschen und Firmen vor Newslettern")
        self.assertEqual(spoken_unread(2, news), "Zwei neue, Sir: von Spiele-News und Amazon.", "wenige: alle")
        self.assertEqual(spoken_unread(9, news[:1]), "Neun neue, Sir. Die neuesten sind Newsletter und Benachrichtigungen.")
        self.assertEqual(spoken_new([one, self.message("Max Mustermann", "max@example.com", "Und?", uid=4)]),
                         "Sir, zwei neue Mails von Max Mustermann.")
        self.assertEqual(spoken_new([one, many[0]]), "Sir, neue Mails von Max Mustermann und Sparkasse.")
        answer = self.message("Anna", "anna@example.org", "AW: Re: WG: Treffen")
        self.assertEqual(spoken_new([answer]), "Sir, eine neue Mail von Anna: Treffen.")

    def test_senders_and_importance(self):
        self.assertEqual(speakable_sender("Amazon.de", "versand@amazon.de"), "Amazon")
        self.assertEqual(speakable_sender("", "info@sparkasse-koelnbonn.de"), "Sparkasse-koelnbonn")
        self.assertEqual(speakable_sender("", "max.mueller@gmail.com"), "Max Mueller")
        self.assertEqual(speakable_sender('"Anna" via Gruppe', "a@example.org"), "Anna")
        people = [{"name": "Max", "mails": []}, {"name": "Jürgen Müller", "mails": ["j@firma.example"]}]
        self.assertTrue(is_important(self.message("Max Power", "mp@example.com"), people))
        self.assertTrue(is_important(self.message("", "max.mustermann@gmail.com"), people))
        self.assertTrue(is_important(self.message("J. M.", "j@firma.example"), people))
        self.assertTrue(is_important(self.message("Juergen Mueller", "jm@example.com"), people))
        self.assertFalse(is_important(self.message("Maximilian", "x@example.com"), people), "ganze Wörter")
        self.assertFalse(is_important(self.message("Max", "max@example.com", bulk=True), people), "kein Newsletter")

    def test_text_helpers(self):
        self.assertEqual(html_text("<style>x{}</style><p>Hallo&nbsp;Georg</p><p>Zweite&#x20;Zeile</p><br/>Ende"),
                         "Hallo Georg\n\nZweite Zeile\n\nEnde")
        self.assertEqual(snippet("Kurz.\n\n-- \nSignatur"), "Kurz.")
        self.assertEqual(snippet("Wort " * 100, limit=20), "Wort Wort Wort Wort …")


if __name__ == "__main__":
    unittest.main()
