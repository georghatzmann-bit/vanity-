"""Georgs iPhone direkt in Jarvis: der Kalender über iCloud (lesen, eintragen, löschen) und die
Geburtstage aus den iCloud-Kontakten. Ohne fremde Dienste, nur mit der Standardbibliothek.

Anmeldung: Apple-ID (E-Mail) und ein app-spezifisches Passwort (account.apple.com, früher
appleid.apple.com > Anmeldung und Sicherheit > App-spezifische Passwörter). Ein Passwort reicht
für Kalender, Mail und Kontakte. Das normale Apple-ID-Passwort nimmt iCloud hier nicht an.

So läuft es ab (wie bei jedem Kalender-Programm, CalDAV):
1. PROPFIND auf https://caldav.icloud.com/ fragt, wer man ist (current-user-principal). iCloud leitet
   dabei oft auf den Server um, auf dem das Konto liegt (p12-caldav.icloud.com). urllib folgt bei
   PROPFIND keiner Umleitung, darum macht das DavClient selbst, aber nur innerhalb von iCloud.
2. Der Principal nennt den Ordner mit allen Kalendern (calendar-home-set).
3. PROPFIND mit Tiefe 1 listet die Kalender: Name, Farbe, ob Jarvis hineinschreiben darf, ob er
   Termine (VEVENT) oder nur Erinnerungen (VTODO) hat, und ein Änderungszeichen (getctag).
4. REPORT calendar-query holt die Termine eines Zeitraums (in UTC). Serien schickt iCloud als Ganzes
   (RRULE mit Ausnahmen), die rechnet kalender.parse_ics selbst aus.
5. Neue Termine: PUT <kalender>/<uid>.ics mit If-None-Match: *. Löschen: DELETE. Bei einer Serie
   nimmt Jarvis nur den einen Termin heraus (EXDATE), nicht die ganze Serie.

iCloud bremst bei zu vielen Anfragen (403, 429 oder 503). Dann bleibt der letzte Stand stehen, und
Jarvis versucht es später wieder. Abgerufen wird alle fünf Minuten, und neu geladen werden nur
Kalender, deren Änderungszeichen sich geändert hat.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import http.client
import json
import logging
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from .kalender import _local, _parse_line, _parse_time, _unescape, _unfold, _zone

log = logging.getLogger(__name__)

ICLOUD_CALDAV = "https://caldav.icloud.com/"
ICLOUD_CARDDAV = "https://contacts.icloud.com/"
# Nur an diese Server schickt Jarvis die Anmeldung, auch nach einer Umleitung.
TRUSTED = (".icloud.com", ".icloud.com.cn")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
USER_AGENT = "Jarvis/1.0 (Windows; CalDAV und CardDAV)"
ACCOUNT_URL = "https://account.apple.com/"  # appleid.apple.com leitet heute hierher
MAX_BYTES = 30_000_000
MAX_REDIRECTS = 5
TIMEOUT = 20.0

DAV = "DAV:"
CALDAV = "urn:ietf:params:xml:ns:caldav"
CARDDAV = "urn:ietf:params:xml:ns:carddav"
CS = "http://calendarserver.org/ns/"
ICAL = "http://apple.com/ns/ical/"

WRONG_PASSWORD = "Apple lehnt das Passwort ab. Bitte ein neues app-spezifisches Passwort erstellen."
# In diese Kalender trägt Jarvis von selbst ein (Name, ohne Groß und Klein), sonst in den ersten beschreibbaren.
PREFERRED = ("jarvis", "privat", "home", "zuhause")


class AppleError(RuntimeError):
    """Ein Satz für Georg, warum es mit iCloud gerade nicht geht. kind: passwort, netz, bremse,
    verboten, weg, konflikt oder fehler."""

    def __init__(self, text: str, kind: str = "fehler") -> None:
        super().__init__(text)
        self.kind = kind


# ---------------------------------------------------------------------- WebDAV


@dataclass
class DavResponse:
    href: str  # schon zur vollen Adresse aufgelöst
    props: dict = field(default_factory=dict)  # "{DAV:}displayname" -> Element (nur Eigenschaften mit 200)
    status: int = 200


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib folgt Umleitungen nur bei GET und POST. DavClient folgt selbst, mit Methode und Inhalt."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _http_error(code: int, method: str) -> AppleError:
    if code == 401:
        return AppleError(WRONG_PASSWORD, "passwort")
    if code == 403 and method in ("PUT", "DELETE"):
        return AppleError("In diesen Kalender darf ich nicht schreiben.", "verboten")
    if code in (403, 429, 503):
        return AppleError("iCloud bremst gerade (zu viele Anfragen). Ich versuche es in ein paar Minuten wieder.", "bremse")
    if code == 404:
        return AppleError("Das gibt es bei iCloud nicht (mehr).", "weg")
    if code == 412:
        return AppleError("Der Termin wurde inzwischen auf einem anderen Gerät geändert.", "konflikt")
    if code >= 500:
        return AppleError(f"iCloud hat gerade ein Problem (Fehler {code}). Ich versuche es später wieder.", "netz")
    return AppleError(f"iCloud meldet Fehler {code}.", "fehler")


def _status_code(line: str | None) -> int:
    found = re.search(r"\s(\d{3})(?:\s|$)", str(line or ""))
    return int(found.group(1)) if found else 0


def parse_multistatus(data: bytes, base: str) -> list[DavResponse]:
    """207-Antwort (Multi-Status) in Antworten mit voller Adresse und ihren Eigenschaften."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise AppleError("iCloud hat unverständlich geantwortet.") from None
    found = []
    for response in root.iter(f"{{{DAV}}}response"):
        href = (response.findtext(f"{{{DAV}}}href") or "").strip()
        if not href:
            continue
        props: dict = {}
        for propstat in response.findall(f"{{{DAV}}}propstat"):
            if _status_code(propstat.findtext(f"{{{DAV}}}status")) != 200:
                continue  # 404 = diese Eigenschaft gibt es hier nicht
            prop = propstat.find(f"{{{DAV}}}prop")
            for child in list(prop) if prop is not None else []:
                props[child.tag] = child
        status = _status_code(response.findtext(f"{{{DAV}}}status")) or 200
        found.append(DavResponse(urllib.parse.urljoin(base, href), props, status))
    return found


def _hrefs(element) -> list[str]:
    return [h.text.strip() for h in element.iter(f"{{{DAV}}}href") if h.text and h.text.strip()]


def _text(props: dict, tag: str) -> str:
    element = props.get(tag)
    return (element.text or "").strip() if element is not None else ""


class DavClient:
    """Ein kleiner WebDAV-Client: Basic-Auth, Zeitlimit, Umleitungen nur innerhalb von iCloud."""

    def __init__(self, user: str, password: str, timeout: float = TIMEOUT, opener=None, trusted=TRUSTED) -> None:
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        self._timeout = timeout
        self._open = opener or urllib.request.build_opener(_NoRedirect).open
        self._trusted = tuple(t.lower() for t in trusted)

    def __repr__(self) -> str:
        return "DavClient()"  # nie die Anmeldung

    def _allowed(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" and not (parts.scheme == "http" and host in LOCAL_HOSTS):
            return False  # das Passwort geht nie unverschlüsselt durchs Netz
        return any(host == t or (t.startswith(".") and (host.endswith(t) or host == t[1:])) for t in self._trusted)

    def request(self, method: str, url: str, body: bytes | None = None, headers: dict | None = None):
        """(Status, Kopfzeilen, Inhalt, Adresse, die geantwortet hat)."""
        for _ in range(MAX_REDIRECTS + 1):
            if not self._allowed(url):
                raise AppleError("iCloud wollte die Anmeldung an eine fremde Adresse schicken. Abgebrochen.")
            request = urllib.request.Request(url, data=body, method=method,
                                             headers={"Authorization": self._auth, "User-Agent": USER_AGENT,
                                                      **(headers or {})})
            try:
                with self._open(request, timeout=self._timeout) as response:
                    return response.status, response.headers, response.read(MAX_BYTES), url
            except urllib.error.HTTPError as exc:
                location = exc.headers.get("Location", "") if exc.headers is not None else ""
                exc.close()
                if exc.code in (301, 302, 303, 307, 308) and location:
                    url = urllib.parse.urljoin(url, location)
                    continue
                raise _http_error(exc.code, method) from None
            except AppleError:
                raise
            except TimeoutError:
                raise AppleError("iCloud antwortet nicht (Zeitüberschreitung). Ich versuche es später wieder.", "netz") from None
            except urllib.error.URLError as exc:
                if isinstance(exc.reason, TimeoutError):
                    raise AppleError("iCloud antwortet nicht (Zeitüberschreitung). Ich versuche es später wieder.",
                                     "netz") from None
                if isinstance(exc.reason, ssl.SSLError):
                    raise AppleError("Keine sichere Verbindung zu iCloud möglich. Stimmen Datum und Uhrzeit am PC?",
                                     "netz") from None
                raise AppleError("iCloud ist gerade nicht erreichbar. Ist das Internet da?", "netz") from None
            except (OSError, http.client.HTTPException):
                raise AppleError("iCloud ist gerade nicht erreichbar. Ist das Internet da?", "netz") from None
        raise AppleError("iCloud leitet zu oft um.")

    def propfind(self, url: str, body: str, depth: str = "0") -> tuple[list[DavResponse], str]:
        _, _, data, final = self.request("PROPFIND", url, body.encode("utf-8"),
                                         {"Depth": depth, "Content-Type": "application/xml; charset=utf-8"})
        return parse_multistatus(data, final), final

    def report(self, url: str, body: str, depth: str = "1") -> tuple[list[DavResponse], str]:
        _, _, data, final = self.request("REPORT", url, body.encode("utf-8"),
                                         {"Depth": depth, "Content-Type": "application/xml; charset=utf-8"})
        return parse_multistatus(data, final), final


PRINCIPAL_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"""

CALENDAR_HOME_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"""

ADDRESSBOOK_HOME_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>"""

CALENDARS_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/><d:resourcetype/><d:current-user-privilege-set/>
    <c:supported-calendar-component-set/><cs:getctag/><ical:calendar-color/>
  </d:prop>
</d:propfind>"""

BOOKS_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>"""

MEMBERS_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>"""

# Nur die Felder, die Jarvis braucht: keine Fotos (die machen eine Visitenkarte schnell 100 KB groß).
_CARD_DATA = ("<card:address-data>" + "".join(f'<card:prop name="{name}"/>' for name in
              ("UID", "FN", "N", "NICKNAME", "BDAY", "EMAIL", "X-ADDRESSBOOKSERVER-KIND")) + "</card:address-data>")

CONTACTS_BODY = f"""<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/>{_CARD_DATA}</d:prop>
  <card:filter><card:prop-filter name="BDAY"/></card:filter>
</card:addressbook-query>"""


def _utc_text(when: dt.datetime) -> str:
    """Ortszeit (ohne Zone) -> "20261003T160000Z"."""
    aware = when.astimezone() if when.tzinfo is None else when
    return aware.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def query_body(start: dt.datetime, end: dt.datetime) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="{_utc_text(start)}" end="{_utc_text(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>"""


def _multiget_body(hrefs: list[str]) -> str:
    links = "".join(f"<d:href>{_xml_escape(urllib.parse.urlsplit(h).path)}</d:href>" for h in hrefs)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/>{_CARD_DATA}</d:prop>{links}
</card:addressbook-multiget>"""


def _xml_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _collection(url: str) -> str:
    return url if url.endswith("/") else url + "/"


def _same(a: str, b: str) -> bool:
    """Gleiche Adresse? (iCloud schreibt mal ":443" dazu, mal nicht.)"""
    def norm(url: str) -> tuple:
        parts = urllib.parse.urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return (parts.hostname or "").lower(), port, urllib.parse.unquote(parts.path).rstrip("/")
    return norm(a) == norm(b)


def _calendar_id(url: str) -> str:
    return urllib.parse.unquote(urllib.parse.urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]) or "kalender"


def _color(text: str) -> str:
    """Apple schreibt Farben mit Deckkraft ("#FF2968FF"), die Oberfläche braucht "#FF2968"."""
    found = re.fullmatch(r"#?([0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?", text.strip())
    return f"#{found.group(1).upper()}" if found else ""


def _writable(props: dict) -> bool:
    privileges = props.get(f"{{{DAV}}}current-user-privilege-set")
    if privileges is None:
        return True  # nicht genannt: probieren (iCloud nennt es immer)
    wanted = {f"{{{DAV}}}{name}" for name in ("write", "write-content", "all", "bind")}
    return any(element.tag in wanted for element in privileges.iter())


# ---------------------------------------------------------------------- Das Konto


class AppleAccount:
    """Die Verbindung zu iCloud für eine Apple-ID: Kalender und Kontakte."""

    def __init__(self, email: str, password: str, caldav_url: str = "", carddav_url: str = "",
                 timeout: float = TIMEOUT, trusted=None) -> None:
        self.email = str(email).strip()
        self._dav = DavClient(self.email, password, timeout=timeout, trusted=trusted or TRUSTED)
        self._caldav = caldav_url or ICLOUD_CALDAV
        self._carddav = carddav_url or ICLOUD_CARDDAV
        self._home = ""

    def __repr__(self) -> str:
        return f"AppleAccount({mask_email(self.email)})"

    def _home_set(self, root: str, body: str, tag: str, what: str) -> str:
        responses, _ = self._dav.propfind(root, PRINCIPAL_BODY, "0")
        principal = ""
        for response in responses:
            element = response.props.get(f"{{{DAV}}}current-user-principal")
            hrefs = _hrefs(element) if element is not None else []
            if hrefs:
                principal = urllib.parse.urljoin(response.href, hrefs[0])
                break
        if not principal:
            raise AppleError(f"iCloud nennt zu dieser Apple-ID keine {what}.", "weg")
        responses, final = self._dav.propfind(principal, body, "0")
        for response in responses:
            element = response.props.get(tag)
            hrefs = _hrefs(element) if element is not None else []
            if hrefs:
                return _collection(urllib.parse.urljoin(final, hrefs[0]))
        raise AppleError(f"iCloud nennt zu dieser Apple-ID keine {what}. Ist das in den iCloud-Einstellungen eingeschaltet?",
                         "weg")

    def calendar_home(self, refresh: bool = False) -> str:
        if refresh or not self._home:
            self._home = self._home_set(self._caldav, CALENDAR_HOME_BODY, f"{{{CALDAV}}}calendar-home-set", "Kalender")
        return self._home

    def calendars(self) -> list[dict]:
        """Alle Kalender mit Terminen: {id, url, name, farbe, schreibbar, ctag}. Erinnerungslisten nicht."""
        try:
            responses, _ = self._dav.propfind(self.calendar_home(), CALENDARS_BODY, "1")
        except AppleError as exc:
            if exc.kind != "weg":
                raise
            responses, _ = self._dav.propfind(self.calendar_home(refresh=True), CALENDARS_BODY, "1")
        found = []
        for response in responses:
            kinds = response.props.get(f"{{{DAV}}}resourcetype")
            if kinds is None or kinds.find(f"{{{CALDAV}}}calendar") is None or _same(response.href, self._home):
                continue  # der Ordner selbst, Eingang, Ausgang, Mitteilungen
            parts = response.props.get(f"{{{CALDAV}}}supported-calendar-component-set")
            names = {c.get("name", "").upper() for c in parts.iter(f"{{{CALDAV}}}comp")} if parts is not None else set()
            if names and "VEVENT" not in names:
                continue  # nur Erinnerungen (VTODO)
            ident = _calendar_id(response.href)
            found.append({"id": ident, "url": _collection(response.href),
                          "name": _text(response.props, f"{{{DAV}}}displayname") or ident,
                          "farbe": _color(_text(response.props, f"{{{ICAL}}}calendar-color")),
                          "schreibbar": _writable(response.props), "ctag": _text(response.props, f"{{{CS}}}getctag")})
        return found

    def events(self, calendar_url: str, start: dt.datetime, end: dt.datetime) -> list[dict]:
        """Die Termine eines Zeitraums: [{href, etag, uid, ics}], Serien als Ganzes."""
        responses, _ = self._dav.report(calendar_url, query_body(start, end), "1")
        items = []
        for response in responses:
            data = response.props.get(f"{{{CALDAV}}}calendar-data")
            text = data.text if data is not None else ""
            if not text or "BEGIN:VEVENT" not in text.upper():
                continue
            items.append({"href": response.href, "etag": _text(response.props, f"{{{DAV}}}getetag"),
                          "uid": event_uid(text), "ics": text})
        return items

    def put(self, url: str, ics: str, if_match: str = "", create: bool = False) -> str:
        """Schreibt einen Termin. create: nur, wenn es ihn noch nicht gibt. Gibt das neue ETag zurück."""
        headers = {"Content-Type": "text/calendar; charset=utf-8"}
        if create:
            headers["If-None-Match"] = "*"
        elif if_match:
            headers["If-Match"] = if_match
        _, answer, _, _ = self._dav.request("PUT", url, ics.encode("utf-8"), headers)
        return str(answer.get("ETag", "") or "") if answer is not None else ""

    def get(self, url: str) -> tuple[str, str]:
        """(iCalendar-Text, ETag) eines Termins."""
        _, answer, data, _ = self._dav.request("GET", url)
        etag = str(answer.get("ETag", "") or "") if answer is not None else ""
        return data.decode("utf-8", errors="replace"), etag

    def delete(self, url: str, if_match: str = "") -> None:
        self._dav.request("DELETE", url, None, {"If-Match": if_match} if if_match else {})

    # ---------------------------------------------------------- Kontakte

    def contacts(self) -> list[dict]:
        """Alle Kontakte mit Geburtstag: {name, vorname, spitzname, jahr, monat, tag, mails}."""
        home = self._home_set(self._carddav, ADDRESSBOOK_HOME_BODY, f"{{{CARDDAV}}}addressbook-home-set", "Kontakte")
        responses, _ = self._dav.propfind(home, BOOKS_BODY, "1")
        books = [r.href for r in responses if r.props.get(f"{{{DAV}}}resourcetype") is not None
                 and r.props[f"{{{DAV}}}resourcetype"].find(f"{{{CARDDAV}}}addressbook") is not None]
        people, seen = [], set()
        for book in books:
            try:
                answers, _ = self._dav.report(book, CONTACTS_BODY, "1")
                texts = [r.props[f"{{{CARDDAV}}}address-data"].text or "" for r in answers
                         if r.props.get(f"{{{CARDDAV}}}address-data") is not None]
            except AppleError as exc:
                if exc.kind in ("passwort", "netz"):
                    raise
                # Auch bei 403: das kann "diese Suche gibt es hier nicht" heißen. Bremst iCloud wirklich,
                # scheitert der Ausweg genauso und meldet es.
                log.info("Kontakte: Suche nach Geburtstagen ging nicht (%s), lade einzeln.", exc)
                texts = self._all_cards(book)
            for text in texts:
                for person in parse_vcards(text):
                    mark = (person.get("uid") or person["name"], person.get("monat"), person.get("tag"))
                    if person.get("monat") and mark not in seen:
                        seen.add(mark)
                        people.append(person)
        return people

    def _all_cards(self, book: str) -> list[str]:
        """Ausweg, falls iCloud die Geburtstags-Suche nicht kann: alle Visitenkarten in Hunderter-Paketen."""
        responses, _ = self._dav.propfind(book, MEMBERS_BODY, "1")
        hrefs = [r.href for r in responses if not _same(r.href, book)]
        texts = []
        for start in range(0, len(hrefs), 100):
            answers, _ = self._dav.report(book, _multiget_body(hrefs[start:start + 100]), "1")
            texts += [r.props[f"{{{CARDDAV}}}address-data"].text or "" for r in answers
                      if r.props.get(f"{{{CARDDAV}}}address-data") is not None]
        return texts


# ---------------------------------------------------------------------- iCalendar schreiben


def _escape(text: str) -> str:
    return (str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """Zeilen über 75 Byte umbrechen (RFC 5545), ohne ein Zeichen zu zerteilen."""
    if len(line.encode("utf-8")) <= 75:
        return line
    parts, current, size, limit = [], "", 0, 75
    for char in line:
        width = len(char.encode("utf-8"))
        if size + width > limit:
            parts.append(current)
            current, size, limit = "", 0, 74  # Folgezeilen beginnen mit einem Leerzeichen
        current += char
        size += width
    parts.append(current)
    return "\r\n ".join(parts)


def _join_lines(lines: list[str]) -> str:
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def build_event_ics(uid: str, title: str, start: dt.datetime, end: dt.datetime, all_day: bool = False,
                    place: str = "", now: dt.datetime | None = None) -> str:
    """Ein neuer Termin als iCalendar. Zeiten in UTC: so zeigt das iPhone sie überall richtig an."""
    stamp = _utc_text(now or dt.datetime.now())
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jarvis//Kalender//DE", "CALSCALE:GREGORIAN",
             "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}", f"CREATED:{stamp}", f"LAST-MODIFIED:{stamp}"]
    if all_day:
        last = end if end.date() > start.date() else start + dt.timedelta(days=1)
        lines += [f"DTSTART;VALUE=DATE:{start:%Y%m%d}", f"DTEND;VALUE=DATE:{last:%Y%m%d}"]
    else:
        lines += [f"DTSTART:{_utc_text(start)}", f"DTEND:{_utc_text(end)}"]
    lines.append(f"SUMMARY:{_escape(title)}")
    if place:
        lines.append(f"LOCATION:{_escape(place)}")
    lines += ["SEQUENCE:0", f"TRANSP:{'TRANSPARENT' if all_day else 'OPAQUE'}", "END:VEVENT", "END:VCALENDAR"]
    return _join_lines(lines)


def _vevent_blocks(lines: list[str]) -> list[tuple[int, int, dict]]:
    """(erste Zeile, Zeile mit END:VEVENT, Eigenschaften) je Termin, ohne Erinnerungen (VALARM) darin."""
    blocks, first, nested, props = [], None, 0, {}
    for index, line in enumerate(lines):
        name, params, value = _parse_line(line)
        if first is None:
            if name == "BEGIN" and value.strip().upper() == "VEVENT":
                first, nested, props = index, 0, {}
            continue
        if name == "BEGIN":
            nested += 1
        elif name == "END":
            if nested:
                nested -= 1
            elif value.strip().upper() == "VEVENT":
                blocks.append((first, index, props))
                first = None
        elif not nested and name not in props:
            props[name] = (params, value)
    return blocks


def event_uid(text: str) -> str:
    for _, _, props in _vevent_blocks(_unfold(text)):
        if "UID" in props:
            return props["UID"][1].strip()
    return ""


def _line(name: str, params: dict, value: str) -> str:
    extra = ""
    for key, val in params.items():
        if re.search(r"[:;,]", val):
            val = f'"{val}"'  # TZID="(UTC+01:00) Amsterdam, Berlin"
        extra += f";{key}={val}"
    return f"{name}{extra}:{value}"


def _exdate_like(params: dict, value: str, when: dt.datetime) -> str:
    """EXDATE in derselben Form wie der Beginn der Serie (Datum, UTC, Zeitzone oder Ortszeit)."""
    value = value.strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", value):
        return f"EXDATE;VALUE=DATE:{when:%Y%m%d}"
    if value.upper().endswith("Z"):
        return f"EXDATE:{_utc_text(when)}"
    tzid = params.get("TZID", "")
    if tzid:
        zone = _zone(tzid)
        moment = when.astimezone(zone) if zone is not None else when
        return _line("EXDATE", {"TZID": tzid}, f"{moment:%Y%m%dT%H%M%S}")
    return f"EXDATE:{when:%Y%m%dT%H%M%S}"


def exclude_occurrence(text: str, when: dt.datetime) -> str | None:
    """Nimmt einen Termin (Beginn in Ortszeit) aus seiner Serie heraus, statt die Serie zu löschen.
    Ein einzeln verschobener Termin der Serie fällt dabei ganz weg. None = das ist keine Serie."""
    lines = _unfold(text)
    blocks = _vevent_blocks(lines)
    master = next((b for b in blocks if "RRULE" in b[2] and "RECURRENCE-ID" not in b[2]), None)
    if master is None:
        return None
    exdate, drop = "", None
    for first, last, props in blocks:
        if "RECURRENCE-ID" not in props or "DTSTART" not in props:
            continue
        try:
            begin, all_day = _parse_time(props["DTSTART"][1], props["DTSTART"][0])
        except ValueError:
            continue
        local = begin if all_day else _local(begin)
        if local == when or (all_day and local.date() == when.date()):
            params, value = props["RECURRENCE-ID"]
            exdate, drop = _line("EXDATE", params, value), (first, last)
            break
    if not exdate:
        params, value = master[2]["DTSTART"]
        exdate = _exdate_like(params, value, when)
    out = []
    for index, line in enumerate(lines):
        if drop is not None and drop[0] <= index <= drop[1]:
            continue
        if index == master[1]:
            out.append(exdate)
        out.append(line)
    return _join_lines(out)


# ---------------------------------------------------------------------- Visitenkarten (vCard)


def _bday(params: dict, value: str) -> tuple[int, int, int] | None:
    """BDAY -> (Jahr oder 0, Monat, Tag). Ohne Jahr: "--0503", oder Apples Platzhalter 1604 mit
    X-APPLE-OMIT-YEAR."""
    value = value.strip()
    if params.get("VALUE", "").lower() == "text":
        return None
    found = re.fullmatch(r"(\d{4})-?(\d{2})-?(\d{2})(?:T[\d:]*(?:Z|[+-]\d{2}:?\d{2})?)?", value)
    if found:
        year, month, day = (int(x) for x in found.groups())
        if params.get("X-APPLE-OMIT-YEAR") or year < 1880 or year > dt.date.today().year:
            year = 0
    else:
        found = re.fullmatch(r"--(\d{2})-?(\d{2})", value)
        if not found:
            return None
        year, month, day = 0, int(found.group(1)), int(found.group(2))
    try:
        dt.date(2000, month, day)  # 2000 ist ein Schaltjahr: auch der 29. Februar geht
    except ValueError:
        return None
    return year, month, day


def parse_vcards(text: str) -> list[dict]:
    """Visitenkarten -> [{name, vorname, spitzname, mails, uid, und mit Geburtstag: jahr, monat, tag}]."""
    people, card = [], None
    for line in _unfold(text):
        name, params, value = _parse_line(line)
        name = name.rsplit(".", 1)[-1]  # "ITEM1.EMAIL" -> "EMAIL"
        if name == "BEGIN" and value.strip().upper() == "VCARD":
            card = {"mails": []}
        elif card is None:
            continue
        elif name == "END" and value.strip().upper() == "VCARD":
            person = _person(card)
            if person:
                people.append(person)
            card = None
        elif name == "FN":
            card.setdefault("fn", _unescape(value).strip())
        elif name == "N":
            card.setdefault("n", value)
        elif name == "NICKNAME":
            card.setdefault("nick", _unescape(value).split(",")[0].strip())
        elif name == "BDAY":
            card.setdefault("bday", (params, value))
        elif name == "EMAIL":
            mail = value.strip().lower()
            if "@" in mail and mail not in card["mails"]:
                card["mails"].append(mail)
        elif name == "UID":
            card.setdefault("uid", value.strip())
        elif name == "X-ADDRESSBOOKSERVER-KIND" and value.strip().lower() == "group":
            card["group"] = True
    return people


def _person(card: dict) -> dict | None:
    if card.get("group"):
        return None
    parts = [_unescape(p).strip() for p in re.split(r"(?<!\\);", card.get("n", ""))] + ["", ""]
    family, given = parts[0], parts[1]
    name = " ".join((card.get("fn") or " ".join(x for x in (given, family) if x)).split())
    if not name:
        return None
    person = {"name": name[:80], "vorname": (given or name.split()[0])[:40], "spitzname": card.get("nick", "")[:40],
              "mails": card["mails"][:5], "uid": card.get("uid", "")[:120]}
    birthday = _bday(*card["bday"]) if "bday" in card else None
    if birthday:
        person["jahr"], person["monat"], person["tag"] = birthday
    return person


# ---------------------------------------------------------------------- Der iPhone-Kalender für Jarvis


def _account_key(email: str) -> str:
    return hashlib.sha1(str(email).strip().lower().encode("utf-8")).hexdigest()[:12]


def _safe(name: str) -> str:
    return re.sub(r"[^\w.-]+", "_", name)[:60] + "-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:6]


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)


class ICloudCalendar:
    """Die iPhone-Kalender für kalender.Calendar: Abruf alle fünf Minuten, Zwischenspeicher für
    unterwegs ohne Internet (daten/icloud), Eintragen und Löschen."""

    EVERY = 5 * 60  # Sekunden zwischen zwei Abrufen
    REFETCH = 24 * 3600  # auch ohne Änderung einmal am Tag neu laden (das Zeitfenster wandert mit)
    PAST_DAYS = 31
    AHEAD_DAYS = 370
    OWN_KEEP = 2 * 3600  # so lange gelten eigene Änderungen nicht als Neuigkeit

    def __init__(self, account: AppleAccount | None, folder: Path, choice: str = "", hidden=(), now=None) -> None:
        self.account = account
        self._folder = Path(folder)
        self._choice = str(choice or "").strip().lower()
        self._hidden = {str(h).strip().lower() for h in hidden or [] if str(h).strip()}
        self._now = now or dt.datetime.now
        self._lock = threading.RLock()
        self._fetched = -1e9
        self.error = ""
        self._meta: dict = {"kalender": []}
        self._objects: dict[str, list[dict]] = {}
        self._load()

    # ---------------------------------------------------------- Zwischenspeicher

    def _load(self) -> None:
        try:
            meta = json.loads((self._folder / "kalender.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(meta, dict) or not isinstance(meta.get("kalender"), list):
            return
        if self.account is not None and meta.get("konto") != _account_key(self.account.email):
            return  # ein anderes Konto: der alte Stand gilt nicht
        self._meta = meta
        for calendar in meta["kalender"]:
            try:
                objects = json.loads((self._folder / f"{_safe(calendar['id'])}.json").read_text(encoding="utf-8"))
            except (OSError, ValueError, KeyError):
                objects = []
            self._objects[calendar.get("id", "")] = objects if isinstance(objects, list) else []

    def _save_meta(self) -> None:
        try:
            _write_json(self._folder / "kalender.json", self._meta)
        except OSError as exc:
            log.warning("iCloud-Zwischenspeicher: %s", exc)

    def _save_objects(self, ident: str) -> None:
        try:
            _write_json(self._folder / f"{_safe(ident)}.json", self._objects.get(ident, []))
        except OSError as exc:
            log.warning("iCloud-Zwischenspeicher: %s", exc)

    # ---------------------------------------------------------- Kalender

    def calendars(self) -> list[dict]:
        """{id, name, farbe, schreibbar, gewaehlt, sichtbar} für Oberfläche und Werkzeuge."""
        target = self.target()
        with self._lock:
            return [{"id": c["id"], "name": c.get("name", c["id"]), "farbe": c.get("farbe", ""),
                     "schreibbar": bool(c.get("schreibbar")), "gewaehlt": bool(target and target["id"] == c["id"]),
                     "sichtbar": not self._is_hidden(c)} for c in self._meta.get("kalender", [])]

    def _is_hidden(self, calendar: dict) -> bool:
        return calendar.get("id", "").lower() in self._hidden or calendar.get("name", "").strip().lower() in self._hidden

    def target(self) -> dict | None:
        """Der iPhone-Kalender für neue Termine: der gewählte, sonst Jarvis, Privat, Home oder Zuhause,
        sonst der erste, in den Jarvis schreiben darf."""
        with self._lock:
            writable = [c for c in self._meta.get("kalender", []) if c.get("schreibbar")]
        if self._choice:
            for calendar in writable:
                if self._choice in (calendar["id"].lower(), calendar.get("name", "").strip().lower()):
                    return calendar
        for name in PREFERRED:
            for calendar in writable:
                if calendar.get("name", "").strip().lower() == name:
                    return calendar
        return writable[0] if writable else None

    @property
    def writable(self) -> bool:
        return self.account is not None and self.target() is not None

    def choose(self, ident: str) -> dict | None:
        """Wählt den Kalender für neue Termine (id oder Name). None = gibt es nicht oder nur lesbar."""
        wanted = str(ident or "").strip().lower()
        with self._lock:
            for calendar in self._meta.get("kalender", []):
                if calendar.get("schreibbar") and wanted in (calendar["id"].lower(), calendar.get("name", "").strip().lower()):
                    self._choice = calendar["id"].lower()
                    return calendar
        return None

    def name_of(self, source: str) -> str:
        ident = source.split(":", 1)[1] if source.startswith("icloud:") else ""
        with self._lock:
            for calendar in self._meta.get("kalender", []):
                if calendar["id"] == ident:
                    return calendar.get("name", ident)
        return ident

    def sources(self) -> dict[str, str]:
        """{"icloud:<id>": iCalendar-Text} aller sichtbaren Kalender, die schon einmal geladen wurden."""
        with self._lock:
            return {f"icloud:{c['id']}": "\n".join(o.get("ics", "") for o in self._objects.get(c["id"], []))
                    for c in self._meta.get("kalender", []) if c.get("abgerufen") and not self._is_hidden(c)}

    def calendar_of(self, source: str) -> dict | None:
        ident = source.split(":", 1)[1] if source.startswith("icloud:") else ""
        with self._lock:
            return next((c for c in self._meta.get("kalender", []) if c["id"] == ident), None)

    # ---------------------------------------------------------- Abruf

    def refresh(self, force: bool = False) -> bool:
        """Holt, was sich geändert hat (höchstens alle fünf Minuten). Bei Fehlern bleibt der letzte Stand."""
        if self.account is None:
            return False
        if not force and time.monotonic() - self._fetched < self.EVERY:
            return False
        self._fetched = time.monotonic()
        now = self._now()
        start, end = now - dt.timedelta(days=self.PAST_DAYS), now + dt.timedelta(days=self.AHEAD_DAYS)
        with self._lock:
            known = {c["id"]: c for c in self._meta.get("kalender", [])}
        fetched: dict[str, list[dict]] = {}
        try:
            calendars = self.account.calendars()
            for calendar in calendars:
                old = known.get(calendar["id"]) or {}
                if self._is_hidden(calendar):
                    continue  # ausgeblendet: gar nicht erst laden
                fresh = (old.get("abgerufen") and calendar.get("ctag") and old.get("ctag") == calendar["ctag"]
                         and old.get("url") == calendar["url"] and _age(old["abgerufen"], now) < self.REFETCH)
                if fresh:
                    calendar["abgerufen"] = old["abgerufen"]
                    continue
                fetched[calendar["id"]] = self.account.events(calendar["url"], start, end)
                calendar["abgerufen"] = now.isoformat(timespec="seconds")
        except AppleError as exc:
            self.error = str(exc)
            log.info("iCloud-Kalender: %s", exc)
            # Abgelehntes Passwort: nicht alle fünf Minuten wieder anklopfen. Bremst iCloud: länger warten.
            self._fetched += {"passwort": 55 * 60, "bremse": 10 * 60}.get(exc.kind, 0)
            return False
        with self._lock:
            gone = set(self._objects) - {c["id"] for c in calendars}
            self._meta = {"konto": _account_key(self.account.email), "kalender": calendars,
                          "zeit": now.isoformat(timespec="seconds")}
            for ident, objects in fetched.items():
                self._objects[ident] = objects
                self._save_objects(ident)
            for ident in gone:
                self._objects.pop(ident, None)
                try:
                    (self._folder / f"{_safe(ident)}.json").unlink()
                except OSError:
                    pass
            self._save_meta()
        self.error = ""
        return True

    def refresh_stale(self) -> bool:
        """Für kurze Aufrufe (jarvis.tool): nur abrufen, wenn der Stand auf der Platte älter als fünf Minuten ist."""
        if _age(str(self._meta.get("zeit", "")), self._now()) < self.EVERY:
            return False
        return self.refresh(force=True)

    # ---------------------------------------------------------- Eintragen und Löschen

    def add(self, title: str, start: dt.datetime, end: dt.datetime, all_day: bool = False, place: str = "",
            uid: str = "") -> tuple[str, str]:
        """Trägt einen Termin in den gewählten iPhone-Kalender ein. Gibt (Quelle, UID) zurück."""
        target = self.target()
        if self.account is None or target is None:
            raise AppleError("Ich finde keinen iPhone-Kalender, in den ich schreiben darf.", "verboten")
        uid = uid or str(uuid.uuid4()).upper()
        ics = build_event_ics(uid, title, start, end, all_day, place, self._now())
        url = target["url"] + urllib.parse.quote(uid) + ".ics"
        try:
            etag = self.account.put(url, ics, create=True)
        except AppleError as exc:
            if exc.kind != "konflikt":
                raise
            etag = ""  # gab es schon (ein zweiter Versuch nach einem Abbruch): dann ist er ja drin
        source = f"icloud:{target['id']}"
        with self._lock:
            objects = self._objects.setdefault(target["id"], [])
            objects[:] = [o for o in objects if o.get("uid") != uid] + [{"href": url, "etag": etag, "uid": uid, "ics": ics}]
            if not target.get("abgerufen"):  # sonst zeigt sources() den Kalender noch nicht
                target["abgerufen"] = self._now().isoformat(timespec="seconds")
            self._save_objects(target["id"])
            self._save_meta()
        self.note_own(f"{source}|{uid}|{start.date().isoformat()}")
        return source, uid

    def delete(self, source: str, uid: str, start: dt.datetime) -> None:
        """Löscht einen Termin. Gehört er zu einer Serie, nur diesen einen (EXDATE)."""
        calendar = self.calendar_of(source)
        with self._lock:
            found = next((o for o in self._objects.get(calendar["id"], []) if o.get("uid") == uid), None) if calendar else None
        if self.account is None or calendar is None or found is None:
            raise AppleError("Diesen Termin finde ich im iPhone-Kalender nicht mehr.", "weg")
        if not calendar.get("schreibbar"):
            raise AppleError(f"Im Kalender {calendar.get('name', '')} darf ich nichts löschen.", "verboten")
        changed = exclude_occurrence(found.get("ics", ""), start)
        if changed is None:
            try:
                self.account.delete(found["href"], if_match=found.get("etag", ""))
            except AppleError as exc:
                if exc.kind == "konflikt":
                    self.account.delete(found["href"])  # inzwischen geändert: Georg will ihn trotzdem weg haben
                elif exc.kind != "weg":
                    raise
            with self._lock:
                objects = self._objects.get(calendar["id"], [])
                objects[:] = [o for o in objects if o is not found]
                self._save_objects(calendar["id"])
        else:
            try:
                etag = self.account.put(found["href"], changed, if_match=found.get("etag", ""))
            except AppleError as exc:
                if exc.kind != "konflikt":
                    raise
                fresh, fresh_etag = self.account.get(found["href"])  # auf dem iPhone geändert: neu holen
                changed = exclude_occurrence(fresh, start)
                if changed is None:
                    raise AppleError("Der Termin wurde gerade auf dem iPhone geändert. Bitte dort löschen.",
                                     "konflikt") from None
                etag = self.account.put(found["href"], changed, if_match=fresh_etag)
            with self._lock:
                found["ics"], found["etag"] = changed, etag
                self._save_objects(calendar["id"])
        self.note_own(f"{source}|{uid}|{start.date().isoformat()}")

    # ---------------------------------------------------------- eigene Änderungen

    def note_own(self, key: str) -> None:
        """Merkt sich eine Änderung, die Jarvis selbst gemacht hat (auch aus jarvis.tool): Die sagt
        er nicht als Neuigkeit im Kalender an."""
        path = self._folder / "eigene.json"
        now = time.time()
        with self._lock:
            items = [i for i in self._read_own() if now - float(i.get("zeit", 0)) < self.OWN_KEEP]
            items.append({"key": key, "zeit": now})
            try:
                _write_json(path, items[-200:])
            except OSError as exc:
                log.debug("Eigene Änderungen: %s", exc)

    def own_keys(self) -> set[str]:
        now = time.time()
        return {str(i.get("key")) for i in self._read_own() if now - float(i.get("zeit", 0)) < self.OWN_KEEP}

    def _read_own(self) -> list[dict]:
        try:
            items = json.loads((self._folder / "eigene.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    def forget_cache(self) -> None:
        """Beim Trennen: Zwischenspeicher weg."""
        with self._lock:
            self._meta, self._objects = {"kalender": []}, {}
            try:
                for path in [*self._folder.glob("*.json"), *self._folder.glob("*.txt")]:
                    path.unlink()
            except OSError as exc:
                log.debug("iCloud-Zwischenspeicher: %s", exc)


def _age(stamp: str, now: dt.datetime) -> float:
    try:
        return (now - dt.datetime.fromisoformat(stamp)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


# ---------------------------------------------------------------------- Hilfen


def app_password(text: str) -> str:
    """"ABCD efgh ijkl mnop" -> "abcd-efgh-ijkl-mnop" (so zeigt Apple es an). Anderes bleibt, wie es ist."""
    raw = str(text or "").strip()
    letters = re.sub(r"[\s\-]", "", raw)
    if re.fullmatch(r"[A-Za-z]{16}", letters):
        letters = letters.lower()
        return "-".join(letters[i:i + 4] for i in range(0, 16, 4))
    return raw


def looks_like_app_password(text: str) -> bool:
    return bool(re.fullmatch(r"[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}", app_password(text)))


def mask_email(email: str) -> str:
    """"georg@icloud.com" -> "ge•••g@icloud.com" (für die Anzeige)."""
    local, at, domain = str(email or "").strip().partition("@")
    if not at:
        return "•••"
    shown = local[:1] + "•••" if len(local) <= 3 else local[:2] + "•••" + local[-1]
    return f"{shown}@{domain}"


def account_from_config(cfg: dict, state_dir: Path, secrets=None) -> AppleAccount | None:
    """Das iCloud-Konto aus [apple] apple_id und dem verschlüsselten Passwort, sonst None."""
    email = str((cfg.get("apple") or {}).get("apple_id") or "").strip()
    if not email:
        return None
    if secrets is None:
        from .geheim import Secrets

        secrets = Secrets(Path(state_dir) / "geheim.json")
    password = secrets.get("apple")
    if not password:
        return None
    return AppleAccount(email, password)


def calendar_for(account: AppleAccount | None, cfg: dict, state_dir: Path) -> ICloudCalendar | None:
    if account is None:
        return None
    apple = cfg.get("apple") or {}
    hidden = apple.get("ausblenden") or []
    return ICloudCalendar(account, Path(state_dir) / "icloud", str(apple.get("kalender") or ""),
                          hidden if isinstance(hidden, list) else [hidden])


def sync_birthdays(account: AppleAccount | None, memory, state_dir: Path, force: bool = False,
                   every: float = 6 * 3600) -> int | None:
    """Holt die Geburtstage aus den iCloud-Kontakten ins Gedächtnis (höchstens alle sechs Stunden).
    Gibt die Zahl der Geburtstage zurück, None = diesmal nicht abgerufen."""
    if account is None or memory is None:
        return None
    stamp = Path(state_dir) / "icloud" / "kontakte-abgerufen.txt"
    if not force:
        try:
            if time.time() - stamp.stat().st_mtime < every:
                return None
        except OSError:
            pass
    try:
        people = account.contacts()
    except AppleError as exc:
        log.info("iCloud-Kontakte: %s", exc)
        return None
    count = memory.set_address_book(people)
    try:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(dt.datetime.now().isoformat(timespec="seconds"), encoding="utf-8")
    except OSError:
        pass
    log.info("iCloud-Kontakte: %d Geburtstage", count)
    return count
