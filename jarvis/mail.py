"""E-Mails lesen: iCloud-Mail (kommt mit dem iPhone), dazu Gmail, GMX, web.de, Yahoo oder ein eigener
Server. Nur IMAP aus der Standardbibliothek, ohne fremde Dienste.

Jarvis liest nur: Er holt Mails mit BODY.PEEK und öffnet den Posteingang schreibgeschützt (EXAMINE).
So bleibt alles ungelesen, was ungelesen war. Er löscht nichts, verschiebt nichts und sendet nichts.

Eigenheiten, die hier berücksichtigt sind:
- iCloud liefert bei FETCH RFC822 nichts (leer), und im ENVELOPE stehen manchmal ungültige
  Anführungszeichen. Darum holt Jarvis nur BODY.PEEK[...] und liest die Kopfzeilen selbst.
- Gmail, Yahoo, iCloud und GMX/web.de mit Zwei-Faktor-Schutz brauchen ein App-Passwort. Bei GMX und
  web.de muss IMAP außerdem in den Einstellungen erlaubt sein. Bei Gmail ist IMAP seit 2025 immer an.
- Betreffs in RFC 2047 ("=?UTF-8?Q?...?="), quoted-printable, Mails nur aus HTML und Kopfzeilen mit
  rohen Umlauten werden lesbar gemacht.

Wichtige neue Mails (von Kontakten aus dem Gedächtnis, keine Newsletter) sagt Jarvis höchstens alle
zehn Minuten an (assistant.check_mail).
"""

from __future__ import annotations

import concurrent.futures
import contextlib
import datetime as dt
import email
import email.header
import email.utils
import imaplib
import json
import logging
import os
import re
import ssl
import threading
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

log = logging.getLogger(__name__)

TIMEOUT = 20.0
ANNOUNCE_EVERY = 10 * 60  # höchstens alle zehn Minuten eine Mail-Ansage
PREVIEW_BYTES = 16384  # so viel einer Mail für Absender, Betreff und den Anfang des Textes
FULL_BYTES = 2_000_000  # eine ganze Mail (ohne riesige Anhänge)
SCAN = 300  # "Was schreibt Max?": so viele der neuesten Mails je Konto durchsehen
WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]

PROVIDERS = {
    "icloud": {"name": "iCloud", "server": "imap.mail.me.com", "port": 993},
    "gmail": {"name": "Gmail", "server": "imap.gmail.com", "port": 993},
    "gmx": {"name": "GMX", "server": "imap.gmx.net", "port": 993},
    "webde": {"name": "web.de", "server": "imap.web.de", "port": 993},
    "yahoo": {"name": "Yahoo", "server": "imap.mail.yahoo.com", "port": 993},
}
# Anbieter an der Adresse erkennen
_DOMAINS = {
    "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud", "gmail.com": "gmail", "googlemail.com": "gmail",
    "gmx.de": "gmx", "gmx.net": "gmx", "gmx.at": "gmx", "gmx.ch": "gmx", "web.de": "webde", "yahoo.com": "yahoo",
    "yahoo.de": "yahoo", "ymail.com": "yahoo",
}
_ALIASES = {"web.de": "webde", "web": "webde", "googlemail": "gmail", "google": "gmail", "apple": "icloud",
            "eigener": "imap", "eigen": "imap", "andere": "imap", "anderer": "imap", "server": "imap"}
_WRONG = {
    "icloud": "Apple lehnt das Passwort ab. Bitte ein neues app-spezifisches Passwort erstellen.",
    "gmail": ("Gmail lehnt das Passwort ab. Gmail braucht ein App-Passwort: Google-Konto > Sicherheit > "
              "Bestätigung in zwei Schritten > App-Passwörter."),
    "gmx": ("GMX lehnt die Anmeldung ab. Bitte in den GMX-Einstellungen unter POP3/IMAP den Zugriff erlauben. "
            "Mit Zwei-Faktor-Schutz braucht es ein anwendungsspezifisches Passwort."),
    "webde": ("web.de lehnt die Anmeldung ab. Bitte in den web.de-Einstellungen unter POP3/IMAP den Zugriff erlauben. "
              "Mit Zwei-Faktor-Schutz braucht es ein anwendungsspezifisches Passwort."),
    "yahoo": "Yahoo lehnt das Passwort ab. Yahoo braucht ein App-Passwort: Kontosicherheit > App-Passwort erstellen.",
}
# Absender, die nie ein Mensch sind
_NOREPLY = re.compile(r"(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|newsletters?|news|mailer-daemon|postmaster|"
                      r"bounces?|notifications?|marketing|mailings?)(?:[._+-]|$)", re.I)
# Bei diesen Mail-Anbietern sagt die Adresse nichts über den Absender ("max.mueller@gmail.com" ist Max Mueller)
_GENERIC_DOMAINS = {"gmail", "googlemail", "gmx", "web", "icloud", "me", "mac", "yahoo", "ymail", "outlook", "hotmail",
                    "live", "t-online", "posteo", "aol", "freenet", "arcor", "mail", "protonmail", "proton", "msn"}

HEADERS = ("(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS "
           "(FROM TO SUBJECT DATE LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)])")
PREVIEW = f"(UID FLAGS INTERNALDATE BODY.PEEK[]<0.{PREVIEW_BYTES}>)"
FULL = f"(UID FLAGS INTERNALDATE BODY.PEEK[]<0.{FULL_BYTES}>)"


class MailError(RuntimeError):
    """Ein Satz für Georg, warum es mit den Mails gerade nicht geht. kind: passwort, netz, fehler."""

    def __init__(self, text: str, kind: str = "fehler") -> None:
        super().__init__(text)
        self.kind = kind


# ---------------------------------------------------------------------- Konten und Mails


@dataclass
class Account:
    id: str
    provider: str
    email: str
    server: str
    port: int = 993
    auto: bool = False  # iCloud über die Apple-ID: kommt und geht mit dem iPhone

    @property
    def label(self) -> str:
        return PROVIDERS.get(self.provider, {}).get("name") or self.server

    def as_dict(self) -> dict:
        from .apple import mask_email

        return {"id": self.id, "anbieter": self.provider, "name": self.label, "email": mask_email(self.email),
                "server": self.server, "automatisch": self.auto}


@dataclass
class Message:
    id: str  # "icloud:4711": Konto und UID
    account: str
    uid: int
    sender: str  # Anzeigename, leer wenn keiner
    address: str
    subject: str
    date: dt.datetime | None
    unread: bool
    bulk: bool  # Newsletter, Benachrichtigung, noreply
    snippet: str = ""
    text: str = ""  # nur beim Lesen einer ganzen Mail
    to: str = ""

    @property
    def who(self) -> str:
        """So sagt Jarvis den Absender: "Amazon", "Max Mustermann", "Sparkasse"."""
        return speakable_sender(self.sender, self.address)

    def as_dict(self) -> dict:
        return {"id": self.id, "von": self.who, "adresse": self.address, "betreff": self.subject,
                "datum": self.date.isoformat(timespec="minutes") if self.date else "", "ungelesen": self.unread,
                "newsletter": self.bulk, "vorschau": self.snippet}

    def line(self) -> str:
        """Eine Zeile für jarvis.tool."""
        when = f"{self.date:%a %d.%m. %H:%M}" if self.date else "?"
        marks = (" [neu]" if self.unread else "") + (" [Newsletter]" if self.bulk else "")
        sender = f"{self.sender} <{self.address}>" if self.sender else self.address
        return f"{self.id}  {when}{marks}  {sender}  {self.subject or '(ohne Betreff)'}"


# ---------------------------------------------------------------------- Mails lesbar machen


def _bytes_text(data: bytes, charset: str | None = None) -> str:
    names = [charset] if charset and charset.lower() not in ("unknown-8bit", "x-unknown") else []
    for name in [*names, "utf-8", "cp1252"]:
        try:
            return data.decode(name)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("latin-1")


def _header(value) -> str:
    """Kopfzeile lesbar: RFC 2047 ("=?UTF-8?Q?Gr=C3=BC=C3=9Fe?="), rohe Umlaute, Zeilenumbrüche."""
    if value is None:
        return ""
    try:
        parts = email.header.decode_header(value if isinstance(value, email.header.Header) else str(value))
    except Exception:
        parts = [(str(value), None)]
    text = "".join(_bytes_text(data, charset) if isinstance(data, bytes) else str(data) for data, charset in parts)
    text = text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")
    return " ".join(text.split())


def _sender(value) -> tuple[str, str]:
    """(Anzeigename, Adresse) aus From:, auch mit Umlauten und Komma im Namen."""
    raw = value if isinstance(value, str) else _header(value)
    name, address = email.utils.parseaddr(raw)
    return _header(name).strip(" \"'"), address.strip().lower()


def _date(value, internal: str) -> dt.datetime | None:
    """Datum in Ortszeit (ohne Zone): aus Date:, sonst wann die Mail ankam (INTERNALDATE)."""
    if value:
        try:
            when = email.utils.parsedate_to_datetime(str(value))
        except (TypeError, ValueError, IndexError):
            when = None
        if when is not None:
            if when.tzinfo is None:  # "-0000": UTC ohne Ortsangabe
                when = when.replace(tzinfo=dt.timezone.utc)
            return when.astimezone().replace(tzinfo=None)
    if internal:
        try:
            stamp = imaplib.Internaldate2tuple(f'INTERNALDATE "{internal}"'.encode("ascii"))
        except (ValueError, OverflowError, UnicodeEncodeError):
            stamp = None
        if stamp:
            return dt.datetime(*stamp[:6])  # schon Ortszeit
    return None


def _is_bulk(msg, address: str) -> bool:
    """Newsletter, Werbung, Benachrichtigungen: Jarvis sagt sie nie von selbst an."""
    if msg.get("List-Unsubscribe") or msg.get("List-Id"):
        return True
    if str(msg.get("Precedence", "")).strip().lower() in ("bulk", "list", "junk"):
        return True
    auto = str(msg.get("Auto-Submitted", "")).strip().lower()
    if auto and auto != "no":
        return True
    return bool(_NOREPLY.search(address.split("@")[0]))


class _HtmlText(HTMLParser):
    BLOCKS = {"p", "div", "br", "tr", "li", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section",
              "article", "blockquote", "hr", "header", "footer"}
    SKIP = {"script", "style", "head", "title", "noscript", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_text(html: str) -> str:
    """HTML-Mail als schlichter Text: ohne Stil, Skripte und Tags, Absätze bleiben."""
    parser = _HtmlText()
    try:
        parser.feed(html)
        parser.close()
        text = "".join(parser.parts)
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    return _tidy(text)


_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿­͏"), None)


def _tidy(text: str) -> str:
    text = text.translate(_INVISIBLE).replace("\r\n", "\n").replace("\r", "\n")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _payload(part) -> str:
    try:
        data = part.get_payload(decode=True)
    except Exception:
        data = None
    if data is None:
        raw = part.get_payload()
        return raw if isinstance(raw, str) else ""
    return _bytes_text(data, part.get_content_charset())


def message_text(msg) -> str:
    """Der Text einer Mail: lieber der Klartext-Teil, sonst das HTML als Text. Anhänge nicht."""
    plain = html = None
    for part in msg.walk():
        if part.is_multipart():
            continue
        if str(part.get("Content-Disposition", "")).strip().lower().startswith("attachment"):
            continue
        kind = part.get_content_type()
        if kind == "text/plain" and plain is None:
            plain = _payload(part)
        elif kind == "text/html" and html is None:
            html = _payload(part)
    if plain and plain.strip():
        return _tidy(plain)
    if html:
        return html_text(html)
    return _tidy(plain or "")


def snippet(text: str, limit: int = 200) -> str:
    """Der Anfang des Textes, ohne Zitate und Signatur: "Hast du Lust, am Samstag ..."."""
    lines: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(">"):
            continue
        if line in ("--", "-- ", "—") or re.match(r"^-{2,}\s*(?:original|ursprüngliche|forwarded)", line, re.I):
            break
        if re.match(r"^(?:am|on)\s.+(?:schrieb|wrote)\b.*:$", line, re.I):
            break
        lines.append(line)
        if sum(len(x) for x in lines) > limit * 2:
            break
    text = " ".join(" ".join(lines).split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:-") + " …"


def speakable_sender(name: str, address: str) -> str:
    """"Amazon.de" -> "Amazon", "info@sparkasse.de" -> "Sparkasse", "max.mueller@gmail.com" -> "Max Mueller"."""
    name = re.sub(r"\s+(?:via|über)\s+.+$", "", str(name or "").strip()).strip().strip("\"'").strip()
    if name and "@" not in name:
        found = re.fullmatch(r"(.+?)\.(?:de|com|at|ch|net|org|eu|io|co\.uk)", name, re.I)
        return found.group(1) if found and " " not in found.group(1) else name
    local, _, domain = str(address or "").partition("@")
    parts = domain.lower().split(".")
    base = parts[-2] if len(parts) >= 2 else parts[0]
    if base and base not in _GENERIC_DOMAINS:
        return base[:1].upper() + base[1:]
    words = [w for w in re.split(r"[._+-]+", local) if w and not w.isdigit()]
    return " ".join(w[:1].upper() + w[1:] for w in words) or address or "jemandem"


def _fold(text: str) -> str:
    """Zum Vergleichen: klein, Umlaute ausgeschrieben ("Müller" = "mueller")."""
    text = str(text or "").lower()
    for umlaut, plain in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, plain)
    return " ".join(text.split())


def sender_matches(message: Message, name: str) -> bool:
    """Passt der Absender zu einem Namen? "Max" passt zu "Max Mustermann" und "max.mueller@...",
    "Jürgen Müller" auch zu "Müller, Jürgen". Nur ganze Wörter: "Max" ist nicht "Maximilian"."""
    words = re.findall(r"[a-z0-9]+", _fold(name))
    if not words:
        return False
    hay = set(re.findall(r"[a-z0-9]+", _fold(f"{message.sender} {message.address}")))
    return all(word in hay for word in words)


def is_important(message: Message, people) -> bool:
    """Eine Mail von jemandem aus Georgs Kontakten (Gedächtnis, iPhone-Adressbuch), kein Newsletter."""
    if message.bulk:
        return False
    for person in people or []:
        if message.address and message.address in [str(m).lower() for m in person.get("mails", [])]:
            return True
        name = str(person.get("name", ""))
        if len(_fold(name)) >= 3 and sender_matches(message, name):
            return True
    return False


# ---------------------------------------------------------------------- IMAP


_START = re.compile(rb"^\d+ \(")
_UID = re.compile(rb"\bUID (\d+)")
_FLAGS = re.compile(rb"\bFLAGS \(([^)]*)\)")
_INTERNAL = re.compile(rb'\bINTERNALDATE "([^"]+)"')


def parse_fetch(data) -> list[dict]:
    """imaplib-FETCH-Antwort -> [{uid, flags, internal, body}]. Kommen FLAGS erst nach dem Inhalt
    (manche Server), stehen sie im Rest dahinter."""
    entries: list[dict] = []
    current = None
    for item in data or []:
        if isinstance(item, tuple):
            head = item[0] if isinstance(item[0], bytes) else b""
            if current is None or _START.match(head):
                current = {"meta": head, "body": b""}
                entries.append(current)
            else:
                current["meta"] += b" " + head
            if len(item) > 1 and isinstance(item[1], bytes) and not current["body"]:
                current["body"] = item[1]
        elif isinstance(item, bytes):
            if _START.match(item):
                current = {"meta": item, "body": b""}
                entries.append(current)
            elif current is not None:
                current["meta"] += b" " + item
    found = []
    for entry in entries:
        meta = entry["meta"]
        uid, flags, internal = _UID.search(meta), _FLAGS.search(meta), _INTERNAL.search(meta)
        found.append({"uid": int(uid.group(1)) if uid else None,
                      "flags": flags.group(1).decode("ascii", "replace") if flags else "",
                      "internal": internal.group(1).decode("ascii", "replace") if internal else "",
                      "body": entry["body"]})
    return found


def _quote(word: str) -> str:
    return '"' + word.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ascii_part(word: str) -> str:
    """Für Server ohne UTF-8-Suche: der längste Teil ohne Umlaute ("Rücksendung" -> "cksendung")."""
    parts = re.findall(r"[A-Za-z0-9]{3,}", word)
    return max(parts, key=len) if parts else ""


@dataclass
class _Session:
    conn: object
    exists: int
    validity: str


def _network_error(account: Account, exc: Exception) -> MailError:
    if isinstance(exc, TimeoutError):
        return MailError(f"{account.label} antwortet nicht (Zeitüberschreitung).", "netz")
    if isinstance(exc, ssl.SSLError):
        return MailError(f"Keine sichere Verbindung zu {account.label} möglich.", "netz")
    return MailError(f"{account.label} ist gerade nicht erreichbar. Ist das Internet da?", "netz")


class MailClient:
    """Ein Postfach über IMAP, nur lesend. Jede Abfrage: anmelden, Posteingang schreibgeschützt öffnen,
    lesen, abmelden."""

    def __init__(self, account: Account, password: str, timeout: float = TIMEOUT, imap=None) -> None:
        self.account = account
        self._password = password
        self._timeout = timeout
        self._imap = imap

    def __repr__(self) -> str:
        return f"MailClient({self.account.id})"  # nie das Passwort

    def _connect(self):
        imap_class = self._imap or imaplib.IMAP4_SSL
        names = [self.account.email]
        local, _, domain = self.account.email.partition("@")
        if self.account.provider == "icloud" and domain.lower() in ("icloud.com", "me.com", "mac.com"):
            names.append(local)  # iCloud nimmt manchmal nur den Teil vor dem @
        for name in names:
            try:
                conn = imap_class(self.account.server, self.account.port, ssl_context=ssl.create_default_context(),
                                  timeout=self._timeout)
            except (OSError, imaplib.IMAP4.error) as exc:
                raise _network_error(self.account, exc) from None
            try:
                conn.login(name, self._password)
                return conn
            except imaplib.IMAP4.abort as exc:
                _close(conn)
                raise _network_error(self.account, exc) from None
            except imaplib.IMAP4.error as exc:
                log.info("Anmeldung bei %s abgelehnt: %s", self.account.label, str(exc)[:200])
                _close(conn)
            except UnicodeEncodeError:
                _close(conn)
                raise MailError(f"{self.account.label} nimmt Umlaute im Passwort nicht an. Bitte ein App-Passwort nehmen.",
                                "passwort") from None
            except OSError as exc:
                _close(conn)
                raise _network_error(self.account, exc) from None
        raise MailError(_WRONG.get(self.account.provider) or
                        f"{self.account.label} lehnt die Anmeldung ab. Stimmen Adresse und Passwort?", "passwort")

    @contextlib.contextmanager
    def _session(self):
        conn = self._connect()
        try:
            typ, data = conn.select("INBOX", readonly=True)  # EXAMINE: nichts wird als gelesen markiert
            if typ != "OK":
                raise MailError(f"{self.account.label}: Den Posteingang kann ich nicht öffnen.")
            exists = int((data[0] or b"0").split()[0]) if data and data[0] else 0
            validity = ""
            try:
                code, values = conn.response("UIDVALIDITY")
                validity = (values[0] or b"").decode("ascii", "replace") if values and values[0] else ""
            except Exception:
                pass
            yield _Session(conn, exists, validity)
        except MailError:
            raise
        except imaplib.IMAP4.abort as exc:
            raise _network_error(self.account, exc) from None
        except imaplib.IMAP4.error as exc:
            raise MailError(f"{self.account.label} meldet einen Fehler ({str(exc)[:120]}).") from None
        except (OSError, ValueError) as exc:
            raise _network_error(self.account, exc) from None
        finally:
            _close(conn)

    def check(self) -> bool:
        """Anmelden und den Posteingang öffnen (für "Verbinden"). Fehler: MailError."""
        with self._session():
            return True

    # ---------------------------------------------------------- Abfragen

    def _uids(self, answer) -> list[int]:
        typ, data = answer
        if typ != "OK":
            raise MailError(f"{self.account.label}: Die Suche ging nicht.")
        words = b" ".join(d for d in data or [] if isinstance(d, bytes)).split()
        return sorted(int(w) for w in words if w.isdigit())

    def _fetch(self, session: _Session, uids: list[int], items: str, text: bool = False) -> list[Message]:
        if not uids:
            return []
        typ, data = session.conn.uid("FETCH", ",".join(str(u) for u in uids), items)
        if typ != "OK":
            raise MailError(f"{self.account.label}: Die Mails ließen sich nicht abrufen.")
        return [self._message(entry, text) for entry in parse_fetch(data) if entry["uid"]]

    def _fetch_newest(self, session: _Session, count: int, items: str) -> list[Message]:
        """Die neuesten Mails über ihre Nummer im Posteingang (ohne alle UIDs zu suchen)."""
        if session.exists <= 0 or count <= 0:
            return []
        first = max(1, session.exists - count + 1)
        typ, data = session.conn.fetch(f"{first}:{session.exists}", items)
        if typ != "OK":
            raise MailError(f"{self.account.label}: Die Mails ließen sich nicht abrufen.")
        return [self._message(entry) for entry in parse_fetch(data) if entry["uid"]]

    def _message(self, entry: dict, text: bool = False) -> Message:
        msg = email.message_from_bytes(entry["body"] or b"")
        name, address = _sender(msg.get("From"))
        body = message_text(msg) if msg.get_payload() else ""
        return Message(f"{self.account.id}:{entry['uid']}", self.account.id, entry["uid"], name, address,
                       _header(msg.get("Subject")), _date(msg.get("Date"), entry["internal"]),
                       "\\seen" not in entry["flags"].lower(), _is_bulk(msg, address), snippet(body),
                       body[:60000] if text else "", _header(msg.get("To")))

    def unread(self, limit: int = 5) -> tuple[int, list[Message]]:
        """(Zahl der ungelesenen, die neuesten davon)."""
        with self._session() as session:
            uids = self._uids(session.conn.uid("SEARCH", "UNSEEN"))
            return len(uids), self._fetch(session, uids[-limit:], HEADERS)

    def latest(self, count: int = 10) -> list[Message]:
        with self._session() as session:
            return self._fetch_newest(session, count, PREVIEW)

    def read(self, uid: int) -> Message | None:
        with self._session() as session:
            found = self._fetch(session, [int(uid)], FULL, text=True)
            return found[0] if found else None

    def search(self, words: list[str], count: int = 10) -> list[Message]:
        terms = [w for w in words if len(w) >= 2][:6]
        if not terms:
            return []
        with self._session() as session:
            uids = self._search_text(session.conn, terms)
            return self._fetch(session, uids[-count:], PREVIEW)

    def _search_text(self, conn, terms: list[str]) -> list[int]:
        """Volltextsuche auf dem Server. Umlaute gehen als UTF-8 (ein Wort als Literal). Kann der
        Server das nicht, sucht Jarvis nach dem Teil ohne Umlaute."""
        plain = [t for t in terms if t.isascii()]
        other = sorted((t for t in terms if not t.isascii()), key=len, reverse=True)
        if other:
            rest = [p for p in (_ascii_part(t) for t in other[1:]) if p]
            criteria = ["CHARSET", "UTF-8"] + [x for t in plain + rest for x in ("TEXT", _quote(t))] + ["TEXT"]
            try:
                conn.literal = other[0].encode("utf-8")
                return self._uids(conn.uid("SEARCH", *criteria))
            except (MailError, imaplib.IMAP4.error) as exc:
                log.info("%s sucht nicht in UTF-8 (%s), suche ohne Umlaute.", self.account.label, str(exc)[:120])
            finally:
                conn.literal = None
        terms = plain + [p for p in (_ascii_part(t) for t in other) if p]
        if not terms:
            return []
        return self._uids(conn.uid("SEARCH", *[x for t in terms for x in ("TEXT", _quote(t))]))

    def latest_from(self, name: str) -> Message | None:
        """Die neueste Mail von jemandem ("Max", "Amazon"), aus den letzten 300 im Posteingang."""
        with self._session() as session:
            hits = [m for m in self._fetch_newest(session, SCAN, HEADERS) if sender_matches(m, name)]
            if not hits:
                return None
            newest = max(hits, key=lambda m: m.uid)
            found = self._fetch(session, [newest.uid], PREVIEW)
            return found[0] if found else newest

    def new_unseen(self, validity: str, last: int) -> tuple[str, int, set[int], list[Message]]:
        """Für die Ansagen: (UIDVALIDITY, höchste UID, alle ungelesenen UIDs, neue ungelesene Mails seit `last`).
        Beim ersten Blick (oder wenn das Postfach neu nummeriert wurde) ist nichts neu."""
        with self._session() as session:
            unseen = self._uids(session.conn.uid("SEARCH", "UNSEEN"))
            top = self._max_uid(session)
            if not last or validity != session.validity:
                return session.validity, top, set(unseen), []
            fresh = [u for u in unseen if u > last][-20:]
            return session.validity, max(top, last), set(unseen), self._fetch(session, fresh, HEADERS)

    def _max_uid(self, session: _Session) -> int:
        if session.exists <= 0:
            return 0
        typ, data = session.conn.fetch(str(session.exists), "(UID)")
        found = [e["uid"] for e in parse_fetch(data) if e["uid"]] if typ == "OK" else []
        return max(found) if found else 0


def _close(conn) -> None:
    try:
        conn.logout()
    except Exception:
        pass


# ---------------------------------------------------------------------- Alle Postfächer


class Mailbox:
    """Alle Mail-Konten zusammen: iCloud über die Apple-ID und weitere (daten/mail-konten.json).
    Die Passwörter liegen verschlüsselt im Tresor (geheim.py)."""

    def __init__(self, folder: Path, secrets, apple_id: str = "", every_minutes: float = 5.0, imap=None,
                 now=None) -> None:
        self._folder = Path(folder)
        self._secrets = secrets
        self._apple_id = str(apple_id or "").strip()
        self._imap = imap
        self._every = max(1.0, float(every_minutes or 5)) * 60
        self._now = now or dt.datetime.now
        self._lock = threading.RLock()
        self._polled = -1e9
        self._said_at = -1e9
        self._waiting: list[Message] = []
        self._overview: tuple[float, dict | None] = (-1e9, None)
        self._paused: dict[str, float] = {}  # Konto -> bis wann keine Ansage-Abrufe (abgelehntes Passwort)
        self.errors: dict[str, str] = {}

    def __repr__(self) -> str:
        return f"Mailbox({len(self.accounts())} Konten)"

    # ---------------------------------------------------------- Konten

    def _stored(self) -> list[dict]:
        try:
            items = json.loads((self._folder / "mail-konten.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [i for i in items if isinstance(i, dict) and i.get("id")] if isinstance(items, list) else []

    def _store(self, items: list[dict]) -> None:
        path = self._folder / "mail-konten.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, path)

    def accounts(self) -> list[Account]:
        found = []
        if self._apple_id and self._secrets.has("apple"):
            icloud = PROVIDERS["icloud"]
            found.append(Account("icloud", "icloud", self._apple_id, icloud["server"], icloud["port"], auto=True))
        for item in self._stored():
            found.append(Account(str(item["id"]), str(item.get("anbieter", "imap")), str(item.get("email", "")),
                                 str(item.get("server", "")), int(item.get("port", 993) or 993)))
        return found

    @property
    def configured(self) -> bool:
        return bool(self.accounts())

    def add(self, provider: str, address: str, password: str, server: str = "") -> Account:
        """Prüft die Anmeldung und speichert das Konto. Fehler: MailError mit einem Satz für Georg."""
        from .apple import app_password

        address = str(address or "").strip()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", address):
            raise MailError("Das ist keine E-Mail-Adresse.")
        provider = str(provider or "").strip().lower()
        provider = _ALIASES.get(provider, provider) or _DOMAINS.get(address.split("@")[1].lower(), "")
        password = str(password or "")
        if provider == "icloud":
            password = app_password(password)
        elif provider == "gmail":
            password = re.sub(r"\s+", "", password)  # Google zeigt es in Vierergruppen mit Leerzeichen
        else:
            password = password.strip()
        if not password:
            raise MailError("Bitte das Passwort eintragen (meist ein App-Passwort des Anbieters).")
        if provider in PROVIDERS:
            host, port = PROVIDERS[provider]["server"], PROVIDERS[provider]["port"]
        else:
            host, _, port_text = str(server or "").strip().partition(":")
            if not re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}", host):
                raise MailError("Diesen Anbieter kenne ich nicht. Bitte den IMAP-Server angeben, z. B. imap.example.de.")
            provider, port = "imap", int(port_text) if port_text.isdigit() else 993
        with self._lock:
            taken = {a.id for a in self.accounts()}
            ident = provider
            number = 2
            while ident in taken:
                ident, number = f"{provider}-{number}", number + 1
            account = Account(ident, provider, address, host, int(port))
            MailClient(account, password, imap=self._imap).check()
            self._secrets.set(f"mail:{ident}", password)
            self._store(self._stored() + [{"id": ident, "anbieter": provider, "email": address, "server": host,
                                           "port": int(port)}])
        self._overview = (-1e9, None)
        return account

    def remove(self, ident: str) -> bool:
        with self._lock:
            items = self._stored()
            keep = [i for i in items if i.get("id") != ident]
            if len(keep) == len(items):
                return False
            self._store(keep)
            self._secrets.delete(f"mail:{ident}")
        self._overview = (-1e9, None)
        return True

    def check_all(self) -> dict[str, str]:
        """Für den Selbsttest: Konto -> "" (Anmeldung geht) oder der Grund, warum nicht."""
        found = {}
        for account in self.accounts():
            try:
                self._client(account).check()
                found[account.id] = ""
            except MailError as exc:
                found[account.id] = str(exc)
        return found

    def _client(self, account: Account) -> MailClient:
        password = self._secrets.get("apple" if account.auto else f"mail:{account.id}")
        if not password:
            raise MailError(f"Das Passwort für {account.label} fehlt. Bitte das Konto neu verbinden.", "passwort")
        return MailClient(account, password, imap=self._imap)

    def _each(self, work) -> list[tuple[Account, object]]:
        """Arbeit für alle Konten gleichzeitig. Fehler je Konto stehen danach in self.errors."""
        accounts = self.accounts()
        results: list[tuple[Account, object]] = []
        errors: dict[str, str] = {}

        def run(account: Account):
            return work(self._client(account))

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, len(accounts)))) as pool:
            futures = {pool.submit(run, account): account for account in accounts}
            for future, account in futures.items():
                try:
                    results.append((account, future.result()))
                except MailError as exc:
                    errors[account.id] = str(exc)
                except Exception as exc:
                    log.warning("Mail %s: %s", account.id, exc)
                    errors[account.id] = f"{account.label}: unerwarteter Fehler."
        self.errors = errors
        if accounts and not results:
            raise MailError(next(iter(errors.values()), "Die Mails sind gerade nicht erreichbar."))
        return results

    # ---------------------------------------------------------- Lesen

    def unread(self, limit: int = 5) -> tuple[int, list[Message]]:
        results = self._each(lambda client: client.unread(limit))
        count = sum(found[0] for _, found in results)
        messages = [m for _, found in results for m in found[1]]
        return count, _newest_first(messages)[:limit]

    def latest(self, count: int = 10) -> list[Message]:
        results = self._each(lambda client: client.latest(count))
        return _newest_first([m for _, found in results for m in found])[:count]

    def search(self, words: list[str], count: int = 10) -> list[Message]:
        results = self._each(lambda client: client.search(words, count))
        return _newest_first([m for _, found in results for m in found])[:count]

    def latest_from(self, name: str) -> Message | None:
        results = self._each(lambda client: client.latest_from(name))
        found = [m for _, m in results if m is not None]
        return _newest_first(found)[0] if found else None

    def read(self, message_id: str) -> Message:
        ident, _, uid = str(message_id).strip().rpartition(":")
        account = next((a for a in self.accounts() if a.id == ident), None)
        if account is None or not uid.isdigit():
            raise MailError(f"Eine Mail {message_id} kenne ich nicht. Die Kennung steht in der Liste (z. B. icloud:4711).")
        found = self._client(account).read(int(uid))
        if found is None:
            raise MailError(f"Die Mail {message_id} gibt es nicht mehr.")
        return found

    def forget_overview(self) -> None:
        """Beim nächsten overview() frisch abrufen ("Jetzt abrufen")."""
        self._overview = (-1e9, None)

    def overview(self, limit: int = 5, max_age: float = 60.0) -> dict:
        """Für die Oberfläche: {ungelesen, letzte: [...], fehler}. Höchstens einmal pro Minute frisch."""
        stamp, cached = self._overview
        if cached is not None and time.monotonic() - stamp < max_age:
            return cached
        if not self.accounts():
            return {"ungelesen": 0, "letzte": [], "fehler": ""}
        try:
            count, _ = self.unread(limit)
            latest = self.latest(limit)
            result = {"ungelesen": count, "letzte": [m.as_dict() for m in latest],
                      "fehler": "; ".join(self.errors.values())}
        except MailError as exc:
            result = {"ungelesen": 0, "letzte": [], "fehler": str(exc)}
        self._overview = (time.monotonic(), result)
        return result

    # ---------------------------------------------------------- Gesprochen

    def answer(self, kind: str, who: str = "") -> str | None:
        """Sätze ohne Claude: ("neu", "") -> "Drei neue, Sir: ...", ("von", "Max") -> die letzte Mail von
        Max. None = das soll Claude machen."""
        if kind == "neu":
            if not self.accounts():
                return "Ihre Mails sind noch nicht verbunden, Sir. Das geht im Jarvis-Fenster unter Verbinden."
            try:
                count, messages = self.unread()
            except MailError as exc:
                return f"Die Mails kann ich gerade nicht abrufen, Sir. {exc}"
            said = spoken_unread(count, messages)
            missing = [a.label for a in self.accounts() if a.id in self.errors]
            if missing:  # ein Postfach war nicht erreichbar: dann zählt Jarvis nur die anderen
                said += f" {_join(missing)} {'war' if len(missing) == 1 else 'waren'} gerade nicht erreichbar."
            return said
        if kind == "von" and self.accounts():
            try:
                message = self.latest_from(who)
            except MailError as exc:
                log.info("Mail von %s: %s", who, exc)
                return None
            if message is not None:
                return spoken_from(message, who, self._now())
        return None

    # ---------------------------------------------------------- Ansagen

    def poll(self, people=(), force: bool = False) -> list[Message]:
        """Neue, ungelesene Mails von wichtigen Absendern seit dem letzten Blick (höchstens alle paar
        Minuten). Sie warten danach auf take_announcement()."""
        if not force and time.monotonic() - self._polled < self._every:
            return []
        self._polled = time.monotonic()
        state = self._state()
        found: list[Message] = []
        unseen: dict[str, set[int]] = {}
        for account in self.accounts():
            if time.monotonic() < self._paused.get(account.id, 0.0):
                continue  # Passwort abgelehnt: nicht alle paar Minuten wieder anklopfen
            known = state.get(account.id) or {}
            try:
                validity, top, unseen[account.id], fresh = self._client(account).new_unseen(
                    str(known.get("uidvalidity", "")), int(known.get("letzte", 0) or 0))
            except MailError as exc:
                self.errors[account.id] = str(exc)
                log.info("Mail %s: %s", account.id, exc)
                if exc.kind == "passwort":
                    self._paused[account.id] = time.monotonic() + 3600
                continue
            self._paused.pop(account.id, None)
            self.errors.pop(account.id, None)
            state[account.id] = {"uidvalidity": validity, "letzte": top}
            found += [m for m in fresh if m.unread and is_important(m, people)]
        self._save_state(state)
        with self._lock:
            # Was Georg inzwischen gelesen hat (z. B. auf dem iPhone), muss Jarvis nicht mehr ansagen.
            self._waiting = [m for m in self._waiting if m.account not in unseen or m.uid in unseen[m.account]]
            waiting = {m.id for m in self._waiting}
            self._waiting += [m for m in found if m.id not in waiting]
        if found:
            self._overview = (-1e9, None)
        return found

    def take_announcement(self) -> str:
        """Der Satz für die wartenden wichtigen Mails, höchstens alle zehn Minuten. "" = nichts."""
        with self._lock:
            if not self._waiting or time.monotonic() - self._said_at < ANNOUNCE_EVERY:
                return ""
            messages, self._waiting = self._waiting, []
            self._said_at = time.monotonic()
        return spoken_new(messages)

    def _state(self) -> dict:
        try:
            data = json.loads((self._folder / "mail-stand.json").read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_state(self, state: dict) -> None:
        try:
            path = self._folder / "mail-stand.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(state), encoding="utf-8")
            os.replace(temp, path)
        except OSError as exc:
            log.debug("Mail-Stand: %s", exc)


def _newest_first(messages: list[Message]) -> list[Message]:
    return sorted(messages, key=lambda m: (m.date or dt.datetime.min, m.uid), reverse=True)


def mailbox_from_config(cfg: dict, state_dir: Path, secrets=None, imap=None) -> Mailbox:
    """Alle Postfächer wie eingestellt. iCloud-Mail ist dabei, sobald das iPhone verbunden ist
    (abschalten mit [apple] mail = false)."""
    if secrets is None:
        from .geheim import Secrets

        secrets = Secrets(Path(state_dir) / "geheim.json")
    apple = cfg.get("apple") or {}
    apple_id = str(apple.get("apple_id") or "").strip() if apple.get("mail", True) else ""
    every = (cfg.get("mail") or {}).get("abruf_minuten", 5)
    return Mailbox(Path(state_dir), secrets, apple_id, every_minutes=float(every or 5), imap=imap)


# ---------------------------------------------------------------------- Sätze


_NUMBERS = ["keine", "eine", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf"]


def _number(count: int) -> str:
    return _NUMBERS[count] if 0 <= count < len(_NUMBERS) else str(count)


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text[-1] in ".!?…" else text + "."


def _when(when: dt.datetime | None, now: dt.datetime) -> str:
    if when is None:
        return "neulich"
    clock = f"{when.hour} Uhr" if when.minute == 0 else f"{when.hour}:{when.minute:02d}"
    days = (now.date() - when.date()).days
    if days <= 0:
        return f"heute um {clock}"
    if days == 1:
        return f"gestern um {clock}"
    if days < 7:
        return f"am {WEEKDAYS[when.weekday()]}"
    return f"am {when.day}.{when.month}."


def spoken_unread(count: int, messages: list[Message]) -> str:
    """"Drei neue, Sir: von Amazon, Max und Sparkasse." """
    if count <= 0:
        return "Keine neuen Mails, Sir."
    if count == 1 and messages:
        about = f", Betreff: {messages[0].subject}" if messages[0].subject else ""
        return _sentence(f"Eine neue, Sir: von {messages[0].who}{about}")
    names: list[str] = []
    for message in messages:
        if message.who not in names:
            names.append(message.who)
    number = _number(count)
    number = number[:1].upper() + number[1:]
    if not names:
        return f"{number} neue, Sir."
    if count <= len(messages):
        return f"{number} neue, Sir: von {_join(names[:3])}."
    return f"{number} neue, Sir, die neuesten von {_join(names[:3])}."


def spoken_from(message: Message, who: str, now: dt.datetime) -> str:
    """"Max hat heute um 14:05 geschrieben, Sir. Betreff: Grillen. Hast du Lust ...?" """
    name = " ".join(str(who or "").split()) or message.who
    parts = [f"{name[:1].upper() + name[1:]} hat {_when(message.date, now)} geschrieben, Sir."]
    if message.subject:
        parts.append(_sentence(f"Betreff: {message.subject}"))
    if message.snippet:
        parts.append(_sentence(message.snippet))
    return " ".join(parts)


def spoken_new(messages: list[Message]) -> str:
    """Die Ansage für neue wichtige Mails: "Sir, eine neue Mail von Max: Grillen am Samstag." """
    if not messages:
        return ""
    names: list[str] = []
    for message in messages:
        if message.who not in names:
            names.append(message.who)
    if len(messages) == 1:
        about = f": {messages[0].subject}" if messages[0].subject else ""
        return _sentence(f"Sir, eine neue Mail von {names[0]}{about}")
    if len(names) == 1:
        return f"Sir, {_number(len(messages))} neue Mails von {names[0]}."
    return f"Sir, neue Mails von {_join(names[:3])}."


# ---------------------------------------------------------------------- Gesprochenes verstehen

_MAILS = r"(?:e-?mails?|mails?)"
_CALL = r"^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?"
_NEW = re.compile(
    _CALL + r"(?:"
    rf"(?:hab|habe|hast|hätte)\s+(?:ich|du)\s+(?:(?:irgendwelche|neue|neuen|ungelesene|eine\s+neue|ne\s+neue|noch|schon)\s+)*"
    rf"(?:{_MAILS}|post)(?:\s+(?:bekommen|gekriegt|für\s+mich))?"
    rf"|(?:sind|gibt\s+es|gibt's|gibts|kamen|kam|ist)\s+(?:(?:irgendwelche|neue|ungelesene|eine|noch)\s+)*"
    rf"{_MAILS}(?:\s+(?:da|gekommen|reingekommen|angekommen|für\s+mich))?"
    rf"|(?:irgendwelche\s+)?(?:neue|neuen|ungelesene|ungelesenen)\s+{_MAILS}"
    rf"|wie\s+viele\s+(?:neue|ungelesene)\s+{_MAILS}(?:\s+(?:hab|habe)\s+ich)?"
    rf"|(?:schau|guck|sieh|check|checke|prüf|prüfe)\s+(?:mal\s+)?(?:bitte\s+)?(?:nach\s+)?(?:meine|die|nach\s+neuen)\s+{_MAILS}"
    r")(?:\s+(?:da|noch|schon|heute|eigentlich|denn|bitte))*\s*[?.!]*$",
    re.I,
)
_FROM = re.compile(
    _CALL + r"(?:"
    r"was\s+(?:schreibt|schrieb)\s+(?:mir\s+|uns\s+)?(?P<a>.+?)"
    r"|was\s+(?:hat|wollte|will)\s+(?:mir\s+)?(?P<b>.+?)\s+(?:mir\s+)?(?:geschrieben|gemailt|geschickt)"
    r"|(?:hat|hab)\s+(?P<c>.+?)\s+(?:mir\s+)?(?:geschrieben|gemailt|(?:eine\s+)?(?:e-?)?mail\s+geschickt)"
    r"|(?:lies|lese)\s+(?:mir\s+)?(?:bitte\s+)?(?:die\s+)?(?:letzte|neueste)\s+(?:e-?)?mail\s+von\s+(?P<d>.+?)(?:\s+vor)?"
    r"|was\s+steht\s+in\s+der\s+(?:letzten|neuesten)\s+(?:e-?)?mail\s+von\s+(?P<e>.+?)"
    r")(?:\s+(?:denn|so|eigentlich|mir|da|bitte))*\s*[?.!]*$",
    re.I,
)
# Kein Absender, sondern ein Gespräch ("Was schreibt man ...?") oder ein Chat ("... auf Discord")
_NOT_A_NAME = {"man", "er", "sie", "es", "du", "ihr", "wir", "jemand", "wer", "was", "keiner", "niemand", "das",
               "der", "die", "ich", "mir", "dir", "uns", "einer", "eine", "alle", "jeder", "die zeitung"}
_CHAT = re.compile(r"\b(?:discord|whatsapp|telegram|signal|chat|gruppe|kanal|server|forum|reddit|twitter|instagram|"
                   r"facebook|sms|imessage|nachricht|nachrichten|zeitung|internet|news)\b", re.I)


def match_mail(text: str):
    """("neu", "") für "Hab ich neue Mails?", ("von", "Max") für "Was schreibt Max?", sonst None."""
    raw = " ".join(str(text).split()).strip()
    if _NEW.match(raw):
        return "neu", ""
    found = _FROM.match(raw)
    if not found or _CHAT.search(raw):
        return None
    who = next((g for g in found.groupdict().values() if g), "").strip(" ,.!?")
    who = re.sub(r"^(?:der|die|das|mein|meine|meinem|meiner|meines|von)\s+", "", who, flags=re.I).strip()
    if not who or who.lower() in _NOT_A_NAME or len(who.split()) > 3 or not re.search(r"[A-Za-zÄÖÜäöüß]{2}", who):
        return None
    return "von", who
