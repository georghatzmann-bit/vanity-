"""Attrappen für die iPhone-Tests: ein kleines iCloud (CalDAV und CardDAV) und ein IMAP-Postfach.

FakeICloud: Der Eingang (127.0.0.1, wie caldav.icloud.com) leitet mit 301 auf den Server des Kontos
um (localhost, anderer Port, wie p42-caldav.icloud.com). Die Antworten sind 207-Multi-Status wie bei
Apple, mit Standard-Namensraum DAV:, CDATA und Farben mit Deckkraft (#FF2968FF).

FakeImap: steht für imaplib.IMAP4_SSL (unittest.mock) und antwortet so, wie imaplib es weitergibt:
Tupel aus Kopf und Literal, echte RFC-822-Bytes, UIDs, Flags. Merkt sich, ob jemand etwas als gelesen
markiert hätte (FETCH ohne PEEK, RFC822, STORE).
"""

import base64
import email
import email.header
import imaplib
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

DSID = "123456789"
USER = "beispiel@icloud.com"
PASSWORD = "abcd-efgh-ijkl-mnop"

MULTI = ('<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" '
         'xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/" '
         'xmlns:CR="urn:ietf:params:xml:ns:carddav">{}</multistatus>')
OK = "<status>HTTP/1.1 200 OK</status>"
MISSING = "<status>HTTP/1.1 404 Not Found</status>"

# Eine Serie mit Erinnerung (VALARM mit eigener UID) und einer verschobenen Stunde, wie das iPhone sie anlegt
TRAINING = """BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Apple Inc.//iPhone OS 26.0//EN\r
BEGIN:VTIMEZONE\r
TZID:Europe/Berlin\r
BEGIN:DAYLIGHT\r
TZOFFSETFROM:+0100\r
TZOFFSETTO:+0200\r
DTSTART:19810329T020000\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r
TZNAME:MESZ\r
END:DAYLIGHT\r
BEGIN:STANDARD\r
TZOFFSETFROM:+0200\r
TZOFFSETTO:+0100\r
DTSTART:19961027T030000\r
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r
TZNAME:MEZ\r
END:STANDARD\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:TRAINING-1\r
DTSTAMP:20260901T100000Z\r
DTSTART;TZID=Europe/Berlin:20260907T180000\r
DTEND;TZID=Europe/Berlin:20260907T193000\r
RRULE:FREQ=WEEKLY;BYDAY=MO\r
SUMMARY:Training\r
LOCATION:Sporthalle\r
BEGIN:VALARM\r
UID:ALARM-1\r
X-WR-ALARMUID:ALARM-1\r
TRIGGER:-PT30M\r
ACTION:DISPLAY\r
DESCRIPTION:Erinnerung\r
SUMMARY:Alarm-Text\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:TRAINING-1\r
DTSTAMP:20260901T100000Z\r
RECURRENCE-ID;TZID=Europe/Berlin:20261012T180000\r
DTSTART;TZID=Europe/Berlin:20261012T190000\r
DTEND;TZID=Europe/Berlin:20261012T203000\r
SUMMARY:Training\r
LOCATION:Sporthalle\r
END:VEVENT\r
END:VCALENDAR\r
"""

ZAHNARZT = """BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Apple Inc.//iPhone OS 26.0//EN\r
BEGIN:VEVENT\r
UID:ZAHNARZT-1\r
DTSTAMP:20260901T100000Z\r
DTSTART:20261005T080000Z\r
DTEND:20261005T090000Z\r
SUMMARY:Zahnarzt\r
LOCATION:Praxis Dr. Huber\\nHauptstraße 1\\n1010 Wien\r
END:VEVENT\r
END:VCALENDAR\r
"""

MESSE = """BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:MESSE-1\r
DTSTAMP:20260901T100000Z\r
DTSTART;VALUE=DATE:20261006\r
DTEND;VALUE=DATE:20261007\r
SUMMARY:Gamescom-Nachlese\r
END:VEVENT\r
END:VCALENDAR\r
"""

OMA = """BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:OMA-1\r
DTSTAMP:20260901T100000Z\r
DTSTART;TZID=Europe/Berlin:20261004T150000\r
DTEND;TZID=Europe/Berlin:20261004T170000\r
SUMMARY:Kaffee bei Oma\r
END:VEVENT\r
END:VCALENDAR\r
"""

CARDS = [
    # Mit Jahr, gefaltete Zeile, Foto (das Jarvis gar nicht erst anfordert, aber der Server schickt es mit)
    "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//iPhone OS 26.0//EN\r\nN:Müller;Max;;;\r\nFN:Max Müller\r\n"
    "NICKNAME:Maxi\r\nitem1.EMAIL;type=INTERNET;type=pref:Max.Mueller@Example.com\r\nBDAY;VALUE=date:1990-10-0\r\n 3\r\n"
    "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD\r\nUID:card-max\r\nEND:VCARD\r\n",
    # Ohne Jahr, wie das iPhone es speichert (Platzhalter 1604)
    "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Schmidt;Anna;;;\r\nFN:Anna Schmidt\r\nBDAY;X-APPLE-OMIT-YEAR=1604:1604-12-24\r\n"
    "EMAIL;type=INTERNET:anna@example.org\r\nUID:card-anna\r\nEND:VCARD\r\n",
    # vCard 4 ohne Jahr
    "BEGIN:VCARD\r\nVERSION:4.0\r\nN:Weber;Tom;;;\r\nFN:Tom Weber\r\nBDAY:--0704\r\nUID:card-tom\r\nEND:VCARD\r\n",
    # Kein Geburtstag (der Server filtert, die Attrappe schickt ihn trotzdem mit)
    "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Ohne;Datum;;;\r\nFN:Datum Ohne\r\nUID:card-ohne\r\nEND:VCARD\r\n",
    # Eine Gruppe ist kein Mensch
    "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Familie;;;;\r\nFN:Familie\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nBDAY:2000-01-01\r\n"
    "UID:card-gruppe\r\nEND:VCARD\r\n",
]


def _basic(user, password):
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


class FakeICloud:
    def __init__(self, user=USER, password=PASSWORD):
        self.auth = _basic(user, password)
        self.lock = threading.Lock()
        self.requests = []  # (Methode, Host, Pfad, Kopfzeilen, Inhalt)
        self.throttle = False
        self.redirect_to = ""  # Eingang leitet woanders hin (fremde Adresse)
        self.query_ranges = []
        self.calendars = {
            "home": {"name": "Privat", "color": "#FF2968FF", "comps": ["VEVENT", "VTODO"], "write": True, "ctag": 1,
                     "objects": {}},
            "work": {"name": "Arbeit", "color": "#1BADF8FF", "comps": ["VEVENT"], "write": True, "ctag": 1, "objects": {}},
            "familie": {"name": "Familie", "color": "#63DA38FF", "comps": ["VEVENT"], "write": False, "ctag": 1,
                        "objects": {}},
            "tasks": {"name": "Erinnerungen", "color": "#FF9500FF", "comps": ["VTODO"], "write": True, "ctag": 1,
                      "objects": {}},
        }
        self.cards = list(CARDS)
        self.etags = 0
        self.put_object("home", "TRAINING-1.ics", TRAINING)
        self.put_object("home", "ZAHNARZT-1.ics", ZAHNARZT)
        self.put_object("work", "MESSE-1.ics", MESSE)
        self.put_object("familie", "OMA-1.ics", OMA)
        self.partition = self._serve(self._handler(front=False))
        self.front = self._serve(self._handler(front=True))
        self.base = f"http://localhost:{self.partition.server_address[1]}"
        self.caldav_url = f"http://127.0.0.1:{self.front.server_address[1]}/"
        self.carddav_url = f"http://127.0.0.1:{self.front.server_address[1]}/kontakte/"

    # ---------------------------------------------------------- Daten

    def put_object(self, calendar, name, ics):
        with self.lock:
            self.etags += 1
            self.calendars[calendar]["objects"][name] = {"ics": ics, "etag": f'"etag-{self.etags}"'}
            self.calendars[calendar]["ctag"] += 1
            return f'"etag-{self.etags}"'

    def objects(self, calendar):
        return dict(self.calendars[calendar]["objects"])

    def account(self, password=PASSWORD, user=USER):
        from jarvis.apple import AppleAccount

        return AppleAccount(user, password, self.caldav_url, self.carddav_url, timeout=5,
                            trusted=("127.0.0.1", "localhost"))

    def methods(self):
        return [(r[0], r[2]) for r in self.requests]

    def close(self):
        for server in (self.front, self.partition):
            server.shutdown()
            server.server_close()

    def _serve(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        return server

    # ---------------------------------------------------------- HTTP

    def _handler(self, front):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                length = int(self.headers.get("Content-Length", 0) or 0)
                return self.rfile.read(length) if length else b""

            def _reply(self, code, body=b"", headers=None):
                data = body.encode("utf-8") if isinstance(body, str) else body
                self.send_response(code)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                if data:
                    self.send_header("Content-Type", "application/xml; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)

            def _handle(self):
                body = self._body()
                with outer.lock:  # die Kopfzeilen als HTTPMessage: ohne Unterschied zwischen groß und klein
                    outer.requests.append((self.command, self.headers.get("Host", ""), self.path, self.headers, body))
                if self.headers.get("Authorization") != outer.auth:
                    return self._reply(401, headers={"WWW-Authenticate": 'Basic realm="iCloud"'})
                if outer.throttle:
                    return self._reply(503, headers={"Retry-After": "120"})
                if front:
                    target = outer.redirect_to or outer.base
                    return self._reply(301, headers={"Location": target + self.path})
                return outer._route(self, body)

            do_PROPFIND = do_REPORT = do_PUT = do_GET = do_DELETE = _handle

        return Handler

    def _route(self, request, body):
        path = request.path
        principal = f"/{DSID}/principal/"
        if request.command == "PROPFIND" and path in ("/", "/kontakte/"):
            return request._reply(207, MULTI.format(
                f"<response><href>{path}</href><propstat><prop><current-user-principal><href>{principal}</href>"
                f"</current-user-principal></prop>{OK}</propstat></response>"))
        if request.command == "PROPFIND" and path == principal:
            if b"calendar-home-set" in body:
                home = f"<C:calendar-home-set><href>{self.base}/{DSID}/calendars/</href></C:calendar-home-set>"
            else:
                home = f"<CR:addressbook-home-set><href>{self.base}/{DSID}/carddavhome/</href></CR:addressbook-home-set>"
            return request._reply(207, MULTI.format(f"<response><href>{principal}</href><propstat><prop>{home}</prop>"
                                                    f"{OK}</propstat></response>"))
        if request.command == "PROPFIND" and path == f"/{DSID}/calendars/":
            return request._reply(207, MULTI.format(self._calendar_list()))
        if request.command == "PROPFIND" and path == f"/{DSID}/carddavhome/":
            listing = (f"<response><href>/{DSID}/carddavhome/</href><propstat><prop><resourcetype><collection/>"
                       f"</resourcetype></prop>{OK}</propstat></response>"
                       f"<response><href>/{DSID}/carddavhome/card/</href><propstat><prop><displayname>card</displayname>"
                       f"<resourcetype><collection/><CR:addressbook/></resourcetype></prop>{OK}</propstat></response>")
            return request._reply(207, MULTI.format(listing))
        if request.command == "REPORT" and path == f"/{DSID}/carddavhome/card/":
            cards = "".join(f"<response><href>/{DSID}/carddavhome/card/{n}.vcf</href><propstat><prop>"
                            f"<getetag>\"c{n}\"</getetag><CR:address-data>{escape(card)}</CR:address-data></prop>{OK}"
                            f"</propstat></response>" for n, card in enumerate(self.cards))
            return request._reply(207, MULTI.format(cards))
        found = re.fullmatch(rf"/{DSID}/calendars/([^/]+)/(?:([^/]+\.ics))?", path)
        if not found or found.group(1) not in self.calendars:
            return request._reply(404)
        calendar, name = self.calendars[found.group(1)], found.group(2)
        if request.command == "REPORT" and not name:
            span = re.search(rb'time-range start="([^"]+)" end="([^"]+)"', body)
            self.query_ranges.append(tuple(x.decode() for x in span.groups()) if span else None)
            return request._reply(207, MULTI.format(self._objects_xml(found.group(1))))
        if not name:
            return request._reply(405)
        with self.lock:
            existing = calendar["objects"].get(name)
        if request.command == "GET":
            if existing is None:
                return request._reply(404)
            request.send_response(200)
            data = existing["ics"].encode("utf-8")
            request.send_header("ETag", existing["etag"])
            request.send_header("Content-Type", "text/calendar; charset=utf-8")
            request.send_header("Content-Length", str(len(data)))
            request.end_headers()
            request.wfile.write(data)
            return None
        if not calendar["write"]:
            return request._reply(403)
        if request.command == "PUT":
            if request.headers.get("If-None-Match") == "*" and existing is not None:
                return request._reply(412)
            match = request.headers.get("If-Match")
            if match and (existing is None or existing["etag"] != match):
                return request._reply(412)
            etag = self.put_object(found.group(1), name, body.decode("utf-8"))
            return request._reply(201 if existing is None else 204, headers={"ETag": etag})
        if request.command == "DELETE":
            if existing is None:
                return request._reply(404)
            with self.lock:
                del calendar["objects"][name]
                calendar["ctag"] += 1
            return request._reply(204)
        return request._reply(405)

    def _calendar_list(self):
        parts = [f"<response><href>/{DSID}/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype>"
                 f"</prop>{OK}</propstat><propstat><prop><displayname/><CS:getctag/></prop>{MISSING}</propstat></response>",
                 f"<response><href>/{DSID}/calendars/inbox/</href><propstat><prop><resourcetype><collection/>"
                 f"<C:schedule-inbox/></resourcetype></prop>{OK}</propstat></response>",
                 f"<response><href>/{DSID}/calendars/notification/</href><propstat><prop><resourcetype><collection/>"
                 f"<CS:notification/></resourcetype></prop>{OK}</propstat></response>"]
        for ident, calendar in self.calendars.items():
            rights = "<privilege><read/></privilege>" + ("<privilege><write/></privilege>" if calendar["write"] else "")
            comps = "".join(f'<C:comp name="{c}"/>' for c in calendar["comps"])
            parts.append(
                f"<response><href>/{DSID}/calendars/{ident}/</href><propstat><prop>"
                f"<displayname>{escape(calendar['name'])}</displayname>"
                f"<resourcetype><collection/><C:calendar/></resourcetype>"
                f"<current-user-privilege-set>{rights}</current-user-privilege-set>"
                f"<C:supported-calendar-component-set>{comps}</C:supported-calendar-component-set>"
                f"<CS:getctag>HwoQEgwAA{calendar['ctag']}</CS:getctag>"
                f"<A:calendar-color>{calendar['color']}</A:calendar-color>"
                f"</prop>{OK}</propstat></response>")
        return "".join(parts)

    def _objects_xml(self, ident):
        with self.lock:
            objects = dict(self.calendars[ident]["objects"])
        parts = []
        for number, (name, item) in enumerate(objects.items()):
            # Mal als CDATA, mal mit Entitäten: beides kommt bei iCloud vor
            data = f"<![CDATA[{item['ics']}]]>" if number % 2 == 0 else escape(item["ics"])
            parts.append(f"<response><href>/{DSID}/calendars/{ident}/{name}</href><propstat><prop>"
                         f"<getetag>{escape(item['etag'])}</getetag><C:calendar-data>{data}</C:calendar-data>"
                         f"</prop>{OK}</propstat></response>")
        return "".join(parts)


# ---------------------------------------------------------------------- IMAP


def mail(sender, subject, body, date, extra="", content_type="text/plain; charset=utf-8", encoding="8bit", to="georg@example.com"):
    """Eine Mail als echte RFC-822-Bytes (Kopf als ASCII mit RFC 2047, Inhalt schon kodiert)."""
    head = (f"From: {sender}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\n"
            f"Message-ID: <{abs(hash((sender, subject, date)))}@example.com>\r\nMIME-Version: 1.0\r\n{extra}"
            f"Content-Type: {content_type}\r\nContent-Transfer-Encoding: {encoding}\r\n\r\n")
    data = body if isinstance(body, bytes) else body.encode("utf-8")
    return head.encode("utf-8") + data


SPARKASSE_HTML = base64.encodebytes(
    "<html><head><style>p {color: red}</style><title>Kontoauszug</title></head><body>"
    "<p>Guten Tag,</p><p>Ihr Kontoauszug f&uuml;r Oktober liegt bereit.&nbsp;Bitte melden Sie sich an.</p>"
    "<script>tracking()</script></body></html>".encode("utf-8")).decode("ascii")

MULTIPART = (
    "--GRENZE\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
    "Ihre Bestellung ist unterwegs: Controller f=C3=BCr die Xbox. Lieferung morgen zwischen 10 und 14 Uhr. Wir=\r\n"
    " melden uns, sobald das Paket zugestellt ist.\r\n"
    "--GRENZE\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML-Version</p>\r\n--GRENZE--\r\n")

REPLY = ("Hi Georg,\r\n\r\nalles klar, ich bringe den Grill mit. Gr=FC=DFe aus K=F6ln!\r\n\r\n"
         "Am 01.10.2026 um 18:30 schrieb Georg:\r\n> Kommst du?\r\n-- \r\nMax\r\n")

MAILS = {
    # uid: (Bytes, gelesen?, INTERNALDATE)
    101: (mail("Max Mustermann <max.mustermann@gmail.com>", "Grillen am Samstag?",
               "Hast du Lust am Samstag zu grillen? Um sechs bei mir.", "Thu, 01 Oct 2026 18:30:00 +0200"),
          True, "01-Oct-2026 18:30:00 +0200"),
    102: (mail("=?UTF-8?Q?Sparkasse_K=C3=B6lnBonn?= <info@sparkasse-koelnbonn.de>",
               "=?UTF-8?B?SWhyIEtvbnRvYXVzenVnIGbDvHIgT2t0b2Jlcg==?=", SPARKASSE_HTML,
               "Fri, 02 Oct 2026 08:00:00 +0200", content_type="text/html; charset=utf-8", encoding="base64"),
          False, "02-Oct-2026 08:00:00 +0200"),
    103: (mail("Max Mustermann <max.mustermann@gmail.com>", "Re: Grillen am Samstag?", REPLY,
               "Fri, 02 Oct 2026 09:15:00 +0200", content_type="text/plain; charset=iso-8859-1",
               encoding="quoted-printable"),
          False, "02-Oct-2026 09:15:00 +0200"),
    104: (mail("Amazon.de <versand-bestaetigung@amazon.de>", "=?utf-8?Q?Versandbest=C3=A4tigung?=", MULTIPART,
               "Fri, 02 Oct 2026 10:05:00 +0200", content_type='multipart/alternative; boundary="GRENZE"'),
          False, "02-Oct-2026 10:05:00 +0200"),
}
NEWSLETTER = (mail("Spiele-News <newsletter@spiele.example>", "Die Top-Spiele der Woche", "Jetzt neu: ...",
                   "Fri, 02 Oct 2026 11:00:00 +0200", extra="List-Unsubscribe: <https://spiele.example/abmelden>\r\n"),
              False, "02-Oct-2026 11:00:00 +0200")
# Rohe Umlaute im Kopf (kommt vor) und ein Komma im Namen
RAW_HEADER = (b"From: \"M\xc3\xbcller, J\xc3\xbcrgen\" <j.mueller@web.de>\r\nSubject: R\xc3\xbccksendung best\xc3\xa4tigt\r\n"
              b"Date: Fri, 02 Oct 2026 12:00:00 +0200\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
              b"Die R\xc3\xbccksendung ist angekommen.\r\n", False, "02-Oct-2026 12:00:00 +0200")


class FakeBox:
    """Ein Postfach: Anmeldedaten, Mails, Protokoll."""

    def __init__(self, logins, mails=None, validity=7, utf8=True, flags_after=False):
        self.logins = set(logins)
        self.messages = {}  # uid -> [Bytes, Flags, INTERNALDATE]
        for uid, (raw, seen, internal) in (mails or {}).items():
            self.add(uid, raw, seen, internal)
        self.validity = validity
        self.utf8 = utf8
        self.flags_after = flags_after  # FLAGS erst hinter dem Inhalt (wie manche Server)
        self.log = []
        self.marked_read = []  # FETCH ohne PEEK, RFC822 oder STORE: darf nie passieren
        self.down = False

    def add(self, uid, raw, seen=False, internal="02-Oct-2026 12:00:00 +0200"):
        self.messages[uid] = [raw, {"\\Seen"} if seen else set(), internal]


class FakeImap:
    """Steht für imaplib.IMAP4_SSL. FakeImap.boxes: Server -> FakeBox."""

    boxes = {}
    error = imaplib.IMAP4.error
    abort = imaplib.IMAP4.abort

    def __init__(self, host, port=993, ssl_context=None, timeout=None):
        box = FakeImap.boxes.get(host)
        if box is None:
            raise OSError("Name or service not known")
        if box.down:
            raise TimeoutError("timed out")
        self.box, self.host, self.port = box, host, port
        self.literal = None
        self.selected = False
        self._responses = {}
        box.log.append(("CONNECT", host, port, ssl_context is not None))

    def login(self, user, password):
        self.box.log.append(("LOGIN", user))
        if (user, password) not in self.box.logins:
            raise imaplib.IMAP4.error(b"[AUTHENTICATIONFAILED] Authentication failed.")
        return "OK", [b"LOGIN completed"]

    def select(self, mailbox="INBOX", readonly=False):
        self.box.log.append(("SELECT", mailbox, readonly))
        self.selected = True
        self._responses = {"UIDVALIDITY": [str(self.box.validity).encode()]}
        return "OK", [str(len(self.box.messages)).encode()]

    def response(self, code):
        return code, self._responses.pop(code, [None])

    def logout(self):
        self.box.log.append(("LOGOUT",))
        return "BYE", [b"bye"]

    def _ordered(self):
        return sorted(self.box.messages)

    def uid(self, command, *args):
        command = command.upper()
        literal, self.literal = self.literal, None
        self.box.log.append(("UID", command, args, literal))
        if command == "SEARCH":
            return self._search(list(args), literal)
        if command == "FETCH":
            wanted = {int(x) for x in str(args[0]).split(",")}
            entries = [(seq, uid) for seq, uid in enumerate(self._ordered(), 1) if uid in wanted]
            return self._fetch(entries, args[1])
        if command == "STORE":
            self.box.marked_read.append(("STORE", args))
            return "OK", [None]
        raise imaplib.IMAP4.error(f"BAD {command}")

    def fetch(self, message_set, items):
        self.box.log.append(("FETCH", message_set, items))
        ordered = self._ordered()
        first, _, last = str(message_set).partition(":")
        start, end = int(first), int(last or first)
        entries = [(seq, ordered[seq - 1]) for seq in range(start, end + 1) if 0 < seq <= len(ordered)]
        return self._fetch(entries, items)

    def _search(self, args, literal):
        if args and args[0].upper() == "CHARSET":
            if not self.box.utf8:
                return "NO", [b"[BADCHARSET] (US-ASCII) Nur US-ASCII"]
            args = args[2:]
        uids = []
        for uid in self._ordered():
            raw, flags, _ = self.box.messages[uid]
            if self._matches(raw, flags, list(args), literal):
                uids.append(uid)
        return "OK", [" ".join(str(u) for u in uids).encode()]

    def _matches(self, raw, flags, args, literal):
        text = _searchable(raw)
        index = 0
        while index < len(args):
            key = args[index].upper()
            if key == "ALL":
                index += 1
            elif key == "UNSEEN":
                if "\\Seen" in flags:
                    return False
                index += 1
            elif key == "TEXT":
                if index + 1 < len(args):
                    word = args[index + 1].strip('"')
                    index += 2
                else:
                    word = literal.decode("utf-8")
                    index += 1
                if word.lower() not in text:
                    return False
            else:
                raise imaplib.IMAP4.error(f"BAD SEARCH {key}")
        return True

    def _fetch(self, entries, items):
        items = str(items)
        if re.search(r"BODY\[(?!\])|BODY\[\]", items) and "PEEK" not in items or re.search(r"\bRFC822\b(?!\.)", items):
            self.box.marked_read.append(("FETCH", items))
        data = []
        for seq, uid in entries:
            raw, flags, internal = self.box.messages[uid]
            meta = [f"UID {uid}"]
            flag_text = f"FLAGS ({' '.join(sorted(flags))})"
            if "FLAGS" in items and not self.box.flags_after:
                meta.append(flag_text)
            if "INTERNALDATE" in items:
                meta.append(f'INTERNALDATE "{internal}"')
            section, body = _section(raw, items)
            head = f"{seq} (" + " ".join(meta)
            tail = f" {flag_text})" if "FLAGS" in items and self.box.flags_after else ")"
            if body is None:
                data.append((head + tail).encode())
            else:
                data.append((f"{head} {section} {{{len(body)}}}".encode(), body))
                data.append(tail.encode())
        return "OK", data


def _section(raw, items):
    fields = re.search(r"BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]", items)
    if fields:
        wanted = {f.upper() for f in fields.group(1).split()}
        head = raw.split(b"\r\n\r\n", 1)[0].split(b"\r\n")
        keep, take = [], False
        for line in head:
            if line[:1] in (b" ", b"\t"):
                if take:
                    keep.append(line)
                continue
            take = line.split(b":", 1)[0].decode("ascii", "replace").upper() in wanted
            if take:
                keep.append(line)
        return f"BODY[HEADER.FIELDS ({fields.group(1)})]", b"\r\n".join(keep) + b"\r\n\r\n"
    partial = re.search(r"BODY\.PEEK\[\]<0\.(\d+)>", items)
    if partial:
        return "BODY[]<0>", raw[:int(partial.group(1))]
    if "BODY.PEEK[]" in items:
        return "BODY[]", raw
    return "", None


def _searchable(raw):
    """Kopf und Text einer Mail in Kleinbuchstaben, wie ein Server sie durchsucht."""
    msg = email.message_from_bytes(raw)
    parts = []
    for name in ("From", "Subject", "To"):
        value = msg.get(name)
        if value is not None:
            try:
                parts.append(str(email.header.make_header(email.header.decode_header(value))))
            except Exception:
                parts.append(str(value))
    for part in msg.walk():
        if part.is_multipart():
            continue
        data = part.get_payload(decode=True) or b""
        parts.append(data.decode(part.get_content_charset() or "utf-8", errors="replace"))
    return " ".join(parts).lower()
