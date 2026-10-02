"""Das Jarvis-Fenster. Python legt Ereignisse in eine Warteschlange, die Seite holt
sie alle 80 ms mit `poll()` ab. So gibt es keine Probleme mit Threads."""

from __future__ import annotations

import collections
import logging
import os
import re
import threading
from pathlib import Path

from ..ui import Ui

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent / "web"

# Knöpfe "App-Passwort erstellen" in "Verbinden > Mail" (mail_help): nur diese Seiten
MAIL_HELP = {
    "icloud": "https://account.apple.com/",
    "gmail": "https://myaccount.google.com/apppasswords",
    "yahoo": "https://login.yahoo.com/account/security",
    "gmx": "https://www.gmx.net/mail/sicherheit/zwei-faktor-authentifizierung/",
    "webde": "https://web.de/email/sicherheit/zwei-faktor-authentifizierung/",
}

# Beispieldaten für den Demo-Modus der Oberfläche, in genau der Form von apple_info() und mail_accounts()
# (gui/web/app.js braucht eine eigene Kopie davon).
DEMO_APPLE = {
    "verbunden": True,
    "email": "ge•••g@icloud.com",
    "kalender": [
        {"id": "home", "name": "Privat", "farbe": "#FF2968", "schreibbar": True, "gewaehlt": True},
        {"id": "work", "name": "Arbeit", "farbe": "#1BADF8", "schreibbar": True, "gewaehlt": False},
        {"id": "familie", "name": "Familie", "farbe": "#63DA38", "schreibbar": False, "gewaehlt": False},
    ],
    "mail": {
        "ungelesen": 3,
        "letzte": [
            {"id": "icloud:4711", "von": "Max Mustermann", "adresse": "max@example.com", "betreff": "Grillen am Samstag?",
             "datum": "2026-10-02T09:15", "ungelesen": True, "newsletter": False,
             "vorschau": "Hast du Lust, am Samstag zu grillen? Um sechs bei mir."},
            {"id": "icloud:4710", "von": "Amazon", "adresse": "versand-bestaetigung@amazon.de",
             "betreff": "Versandbestätigung", "datum": "2026-10-02T08:40", "ungelesen": True, "newsletter": False,
             "vorschau": "Ihre Bestellung ist unterwegs: Controller für die Xbox."},
            {"id": "gmail:812", "von": "Sparkasse", "adresse": "info@sparkasse.de", "betreff": "Ihr Kontoauszug für Oktober",
             "datum": "2026-10-01T18:05", "ungelesen": True, "newsletter": False,
             "vorschau": "Ihr Kontoauszug für Oktober liegt bereit."},
        ],
        "fehler": "",
    },
    "geburtstage": 14,
    "fehler": "",
}
DEMO_MAIL_ACCOUNTS = [
    {"id": "icloud", "anbieter": "icloud", "name": "iCloud", "email": "ge•••g@icloud.com", "server": "imap.mail.me.com",
     "automatisch": True, "fehler": ""},
    {"id": "gmail", "anbieter": "gmail", "name": "Gmail", "email": "ge•••r@gmail.com", "server": "imap.gmail.com",
     "automatisch": False, "fehler": ""},
]


class GuiBridge(Ui):
    """Sammelt alles, was die Oberfläche anzeigen soll."""

    MAX_EVENTS = 500

    def __init__(self) -> None:
        self._events: collections.deque = collections.deque(maxlen=self.MAX_EVENTS)
        self._level: float | None = None
        self._lock = threading.Lock()
        self.info: dict = {"hotkey": "", "mic": "", "model": "", "muted": False, "version": "", "weather": ""}

    def _push(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)

    def drain(self) -> list[dict]:
        with self._lock:
            events = list(self._events)
            self._events.clear()
            if self._level is not None:
                events.append({"type": "level", "value": round(self._level, 3)})
                self._level = None
        return events

    def state(self, value: str) -> None:
        self._push({"type": "state", "value": value})

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        event = {"type": "message", "role": role, "text": text, "final": final}
        if id:
            event["id"] = id
        if model:
            event["model"] = model
        self._push(event)

    def level(self, value: float) -> None:
        # Nur der neueste Pegel zählt, sonst läuft die Warteschlange voll.
        with self._lock:
            self._level = max(0.0, min(1.0, float(value)))

    def toast(self, text: str, kind: str = "info") -> None:
        self._push({"type": "toast", "text": text, "kind": kind})

    def config(self, **values) -> None:
        self.info.update({k: v for k, v in values.items() if v is not None})
        self._push({"type": "config", **values})

    def progress(self, step: dict) -> None:
        self._push({"type": "progress", "step": dict(step)})

    def workshop(self, event: dict) -> None:
        # Laufender Text kommt oft: nur der neueste zählt, sonst läuft die Warteschlange voll.
        if event.get("state") == "text":
            with self._lock:
                for old in [e for e in self._events if e.get("type") == "workshop" and e.get("state") == "text"]:
                    self._events.remove(old)
        self._push({"type": "workshop", **event})

    def stats(self, cpu: float, ram: float, gpu: dict | None = None) -> None:
        event = {"type": "stats", "cpu": round(cpu, 1), "ram": round(ram, 1)}
        if gpu:
            event["gpu"] = gpu
        self._push(event)

    def suggestion(self, offer: dict | None) -> None:
        self._push({"type": "suggestion", "offer": offer})


class Api:
    """Was die Seite in Python aufrufen darf (window.pywebview.api.*).
    Interne Dinge beginnen mit _, damit pywebview sie nicht an die Seite gibt."""

    def __init__(self, bridge: GuiBridge, assistant, mute, on_setup=None, on_listen=None) -> None:
        self._bridge = bridge
        self._assistant = assistant
        self._mute = mute
        self._on_setup = on_setup
        self._on_listen = on_listen
        self._on_touched = None  # setzt __main__ (Hintergrund-Modus)
        self._start_server = None  # setzt __main__: startet den Web-Eingang für die Handy-App
        self._start_alexa = None  # setzt __main__: startet die Alexa-Verbindung

    def hello(self) -> dict:
        info = dict(self._bridge.info)
        info["muted"] = bool(self._mute and self._mute.muted)
        return info

    def poll(self) -> list:
        return self._bridge.drain()

    def send_text(self, text) -> bool:
        text = str(text or "").strip()
        if not text:
            return False
        self._assistant.submit(text)
        return True

    def toggle_mute(self) -> bool:
        if self._mute is None:
            return False
        self._mute.toggle()
        return self._mute.muted

    def stop(self) -> None:
        self._assistant.stop()
        # Der Stopp-Knopf hält auch ein angekündigtes Herunterfahren auf.
        abort = getattr(self._assistant, "abort_power", None)
        if abort is not None and abort():
            self._assistant.announce("Abgebrochen, Sir. Der PC bleibt an.")

    def listen_now(self) -> dict:
        """Klick auf den Kreis im Fenster: sofort zuhören, ohne "Hey Jarvis"."""
        if self._mute is not None and self._mute.muted:
            return {"ok": False, "reason": "muted"}
        if self._on_listen is None or not self._on_listen():
            return {"ok": False, "reason": "novoice"}
        return {"ok": True, "reason": ""}

    def reminders(self) -> list:
        """Termine und Erinnerungen (heute und morgen) für die Spalte "Heute", der Zeit nach."""
        import datetime as dt

        now = dt.datetime.now()
        rows = []
        store = getattr(self._assistant, "reminders", None)
        for r in store.upcoming(now) if store is not None else []:
            try:
                when = dt.datetime.fromisoformat(r["zeit"])
            except (KeyError, ValueError):
                continue
            days = (when.date() - now.date()).days
            if days > 1:
                break
            rows.append({"uhr": when.strftime("%H:%M"), "text": str(r.get("text", "")),
                         "tag": "heute" if days == 0 else "morgen", "art": "erinnerung", "_at": when})
        calendar = getattr(self._assistant, "calendar", None)
        if calendar is not None:
            try:
                end = dt.datetime.combine(now.date() + dt.timedelta(days=2), dt.time())
                for event in calendar.events(now, end):
                    days = (event.start.date() - now.date()).days
                    rows.append({"uhr": "Tag" if event.all_day else event.start.strftime("%H:%M"),
                                 "text": event.title + (f" · {event.place}" if event.place else ""),
                                 "tag": "heute" if days <= 0 else "morgen", "art": "termin",
                                 "_at": event.start if not event.all_day else dt.datetime.combine(event.start.date(), dt.time())})
            except Exception as exc:
                log.debug("Kalender: %s", exc)
        rows.sort(key=lambda row: row["_at"])
        return [{k: v for k, v in row.items() if k != "_at"} for row in rows[:8]]

    # ------------------------------------------------------------------ Shop (Shopify)

    def _shop_vault(self):
        from ..config import STATE_DIR
        from ..geheim import Secrets

        return Secrets(STATE_DIR / "geheim.json")

    def shop_info(self) -> dict:
        """Für "Verbinden > Shop" und die Shop-Karte: verbunden, Name, heute, Woche, offen."""
        from ..shop import ShopError, money

        shop = getattr(self._assistant, "shop", None)
        if shop is None or not shop.configured:
            return {"verbunden": False, "adresse": getattr(shop, "domain", "") if shop else "", "fehler": ""}
        try:
            info = shop.info()
            summary = shop.summary()
        except ShopError as exc:
            return {"verbunden": True, "adresse": shop.domain, "name": shop.name or shop.domain, "fehler": str(exc)}
        cur = summary["waehrung"]
        return {"verbunden": True, "adresse": shop.domain, "name": info["name"], "fehler": "",
                "heute": {"anzahl": summary["heute"]["anzahl"], "umsatz": money(summary["heute"]["umsatz"], cur)},
                "woche": {"anzahl": summary["woche"]["anzahl"], "umsatz": money(summary["woche"]["umsatz"], cur)},
                "offen": summary["offen"], "bestseller": [t for t, _ in summary["bestseller"]]}

    def shop_connect(self, address, client_id, secret) -> dict:
        """Shop-Adresse, Client-ID und Client-Secret prüfen (holt einen Token und den Shop-Namen) und
        speichern: Adresse und ID in config.toml, das Secret verschlüsselt im Tresor."""
        from ..config import STATE_DIR, save_setting
        from ..shop import Shop, ShopError, normalize_domain

        try:
            domain = normalize_domain(address)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        client_id, secret = str(client_id or "").strip(), str(secret or "").strip()
        if len(client_id) < 8 or len(secret) < 8:
            return {"ok": False, "error": "Bitte Client-ID und Client-Secret aus dem Dev Dashboard einfügen "
                                         "(Einstellungen > Anmeldedaten)."}

        class _Once:  # nur für die Probe: das Secret erst nach Erfolg speichern
            def get(self, key):
                return secret

        probe = Shop({"shop": {"adresse": domain, "client_id": client_id}}, _Once())
        try:
            info = probe.info()
        except ShopError as exc:
            return {"ok": False, "error": str(exc)}
        try:
            vault = self._shop_vault()
            vault.set("shopify", secret)
            save_setting("shop", "adresse", domain)
            save_setting("shop", "client_id", client_id)
        except Exception as exc:
            return {"ok": False, "error": f"Konnte nicht speichern: {exc}"}
        section = self._assistant._cfg.setdefault("shop", {})
        section.update({"adresse": domain, "client_id": client_id})
        self._assistant.shop = Shop(self._assistant._cfg, vault, state_path=STATE_DIR / "shop.json")
        return {"ok": True, "error": "", "name": info["name"]}

    def shop_disconnect(self) -> dict:
        from ..config import STATE_DIR, save_setting
        from ..shop import Shop

        try:
            vault = self._shop_vault()
            vault.delete("shopify")
            save_setting("shop", "adresse", "")
            save_setting("shop", "client_id", "")
        except Exception as exc:
            return {"ok": False, "error": f"Konnte nicht trennen: {exc}"}
        self._assistant._cfg.setdefault("shop", {}).update({"adresse": "", "client_id": ""})
        self._assistant.shop = Shop(self._assistant._cfg, vault, state_path=STATE_DIR / "shop.json")
        return {"ok": True, "error": ""}

    def shop_help(self, which="admin") -> bool:
        """Knopf "Öffnen": der Shopify-Admin (dort geht es weiter ins Dev Dashboard)."""
        from .. import pc

        url = {"admin": "https://admin.shopify.com/", "dev": "https://dev.shopify.com/dashboard"}.get(str(which))
        if not url:
            return False
        try:
            pc.open_uri(url)
            return True
        except Exception as exc:
            log.info("Shop-Hilfe: %s", exc)
            return False

    # ------------------------------------------------------------------ Kalender

    def calendar_info(self) -> dict:
        """Für "Verbinden > Kalender": eingetragene Abos (gekürzt) und ob sie gerade erreichbar sind."""
        calendar = getattr(self._assistant, "calendar", None)
        feeds = list(self._assistant._cfg.get("kalender", {}).get("abos", []) or [])
        errors = calendar.errors if calendar is not None else {}
        from ..kalender import _feed_url, _short

        return {"feeds": [{"url": url, "shown": _short(_feed_url(url) or url),
                           "error": errors.get(_feed_url(url), "")} for url in feeds],
                "count": len(calendar.upcoming(24 * 7)) if calendar is not None else 0}

    def calendar_add(self, url) -> dict:
        """Eine geheime iCal-Adresse prüfen und speichern. Zeigt die nächsten Termine daraus."""
        import datetime as dt

        from ..config import save_setting
        from ..kalender import Calendar, _feed_url

        url = str(url or "").strip()
        if not _feed_url(url):
            return {"ok": False, "error": "Das ist keine iCal-Adresse. Sie beginnt mit https:// oder webcal:// und endet meist auf .ics."}
        from ..config import STATE_DIR

        probe = Calendar(STATE_DIR / "kalender.json", [url])
        probe.refresh(force=True)
        if probe.errors:
            return {"ok": False, "error": "Diese Adresse liefert keinen Kalender: " + next(iter(probe.errors.values()))}
        now = dt.datetime.now()
        events = [e for e in probe.upcoming(24 * 14) if e.source != "jarvis"]
        feeds = list(self._assistant._cfg.get("kalender", {}).get("abos", []) or [])
        if url not in feeds:
            feeds.append(url)
        try:
            save_setting("kalender", "abos", feeds)
        except Exception as exc:
            return {"ok": False, "error": f"Konnte nicht speichern: {exc}"}
        self._assistant._cfg.setdefault("kalender", {})["abos"] = feeds
        self._renew_calendar()
        return {"ok": True, "error": "", "count": len(events),
                "next": [e.spoken(now, with_day=True) for e in events[:3]]}

    def calendar_help(self, which) -> bool:
        """Knöpfe "Öffnen" bei Google und Outlook (nur diese beiden Seiten)."""
        from .. import pc

        url = {"google": "https://calendar.google.com/calendar/r/settings",
               "outlook": "https://outlook.live.com/calendar/0/options/calendar/SharedCalendars"}.get(str(which))
        if not url:
            return False
        try:
            pc.open_uri(url)
            return True
        except Exception as exc:
            log.info("Kalender-Hilfe: %s", exc)
            return False

    def calendar_remove(self, url) -> dict:
        from ..config import save_setting

        feeds = [f for f in self._assistant._cfg.get("kalender", {}).get("abos", []) or [] if f != url]
        try:
            save_setting("kalender", "abos", feeds)
        except Exception as exc:
            return {"ok": False, "error": f"Konnte nicht speichern: {exc}"}
        self._assistant._cfg.setdefault("kalender", {})["abos"] = feeds
        self._renew_calendar()
        return {"ok": True, "error": ""}

    def _icloud(self):
        """Das verbundene iCloud-Konto (apple.AppleAccount) oder None."""
        from ..apple import AppleAccount

        account = getattr(self._assistant, "icloud", None)
        return account if isinstance(account, AppleAccount) else None

    def _phone(self):
        """Der iPhone-Kalender (apple.ICloudCalendar) oder None."""
        from ..apple import ICloudCalendar

        phone = getattr(getattr(self._assistant, "calendar", None), "apple", None)
        return phone if isinstance(phone, ICloudCalendar) else None

    def _renew_calendar(self) -> None:
        """Kalender neu aufbauen (nach einer Änderung der Abos oder der iPhone-Verbindung)."""
        from ..config import STATE_DIR
        from ..kalender import calendar_from_config

        self._assistant.calendar = calendar_from_config(self._assistant._cfg, STATE_DIR, account=self._icloud())

    # ------------------------------------------------------------------ iPhone (iCloud) und Mail

    def apple_info(self) -> dict:
        """Für "Verbinden > iPhone". Ohne Netzwerk außer der Mail-Übersicht (höchstens einmal pro Minute):
        {verbunden, email (teilweise verdeckt), kalender: [{id, name, farbe, schreibbar, gewaehlt}],
         mail: {ungelesen, letzte: [{id, von, adresse, betreff, datum, ungelesen, newsletter, vorschau}], fehler},
         geburtstage: Zahl, fehler}"""
        from ..apple import mask_email

        cfg = getattr(self._assistant, "_cfg", {}) or {}
        apple_id = str((cfg.get("apple") or {}).get("apple_id") or "").strip()
        account, phone = self._icloud(), self._phone()
        info = {"verbunden": account is not None, "email": mask_email(apple_id) if apple_id else "", "kalender": [],
                "mail": {"ungelesen": 0, "letzte": [], "fehler": ""}, "geburtstage": 0, "fehler": ""}
        if apple_id and account is None:
            info["fehler"] = "Das gespeicherte Passwort fehlt oder lässt sich nicht lesen. Bitte neu verbinden."
        if phone is not None:
            info["kalender"] = [{key: c[key] for key in ("id", "name", "farbe", "schreibbar", "gewaehlt")}
                                for c in phone.calendars() if c["sichtbar"]]
            info["fehler"] = phone.error or info["fehler"]
        mailbox = getattr(self._assistant, "mail", None)
        if mailbox is not None and getattr(mailbox, "configured", False):
            try:
                info["mail"] = mailbox.overview()
            except Exception as exc:
                log.info("Mail-Übersicht: %s", exc)
        memory = getattr(self._assistant, "memory", None)
        if memory is not None and hasattr(memory, "address_book"):
            info["geburtstage"] = len(memory.address_book())
        return info

    def apple_connect(self, email, passwort) -> dict:
        """iPhone verbinden: Apple-ID und app-spezifisches Passwort. Prüft sofort bei iCloud, speichert das
        Passwort verschlüsselt und holt Kalender, Kontakte und Mail. {ok, fehler, ...wie apple_info}"""
        from ..apple import AppleAccount, AppleError, app_password, looks_like_app_password
        from ..config import STATE_DIR, save_setting
        from ..geheim import Secrets
        from ..mail import mailbox_from_config

        email = str(email or "").strip()
        password = app_password(passwort)
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            return {"ok": False, "fehler": "Bitte die Apple-ID eintragen: die E-Mail-Adresse, mit der Sie sich am iPhone "
                                           "anmelden."}
        if not password:
            return {"ok": False, "fehler": "Bitte das app-spezifische Passwort eintragen."}
        account = AppleAccount(email, password)
        try:
            calendars = account.calendars()
        except AppleError as exc:
            text = str(exc)
            if exc.kind == "passwort" and not looks_like_app_password(password):
                text += (" Das normale Apple-ID-Passwort geht hier nicht, nur ein app-spezifisches "
                         "(vier Gruppen aus je vier Buchstaben).")
            return {"ok": False, "fehler": text}
        try:
            Secrets(STATE_DIR / "geheim.json").set("apple", password)
            save_setting("apple", "apple_id", email)
        except Exception as exc:
            log.warning("iCloud speichern: %s", exc)
            return {"ok": False, "fehler": f"Konnte die Verbindung nicht speichern: {exc}"}
        cfg = self._assistant._cfg
        cfg.setdefault("apple", {})["apple_id"] = email
        self._assistant.icloud = account
        self._renew_calendar()
        phone = self._phone()
        if phone is not None:
            phone.refresh(force=True)  # gleich die Termine, damit die Oberfläche sie zeigt
        self._assistant.mail = mailbox_from_config(cfg, STATE_DIR)
        self._sync_contacts_later()
        result = self.apple_info()
        result["ok"] = True
        if not calendars:
            result["fehler"] = "Verbunden, aber in iCloud ist noch kein Kalender eingeschaltet."
        return result

    def _sync_contacts_later(self) -> None:
        from ..apple import sync_birthdays
        from ..config import STATE_DIR

        account, memory = self._icloud(), getattr(self._assistant, "memory", None)
        wanted = (self._assistant._cfg.get("apple") or {}).get("geburtstage", True)
        if account is None or memory is None or not wanted:
            return
        threading.Thread(target=lambda: sync_birthdays(account, memory, STATE_DIR, force=True),
                         name="jarvis-kontakte", daemon=True).start()

    def apple_choose_calendar(self, ident) -> dict:
        """In welchen iPhone-Kalender neue Termine kommen. {ok, fehler, kalender: [...]}"""
        from ..config import save_setting

        phone = self._phone()
        if phone is None:
            return {"ok": False, "fehler": "Das iPhone ist nicht verbunden.", "kalender": []}
        chosen = phone.choose(str(ident or ""))
        if chosen is not None:
            try:
                save_setting("apple", "kalender", chosen.get("name", chosen["id"]))
            except Exception as exc:
                log.warning("Kalender-Wahl speichern: %s", exc)
            self._assistant._cfg.setdefault("apple", {})["kalender"] = chosen.get("name", chosen["id"])
        listed = [{key: c[key] for key in ("id", "name", "farbe", "schreibbar", "gewaehlt")} for c in phone.calendars()
                  if c["sichtbar"]]
        if chosen is None:
            return {"ok": False, "fehler": "In diesen Kalender darf ich nicht schreiben.", "kalender": listed}
        return {"ok": True, "fehler": "", "kalender": listed}

    def apple_refresh(self) -> dict:
        """Knopf "Jetzt abrufen": Kalender sofort, Kontakte im Hintergrund. Gibt apple_info() zurück."""
        phone = self._phone()
        if phone is not None:
            phone.refresh(force=True)
        self._sync_contacts_later()
        mailbox = getattr(self._assistant, "mail", None)
        if mailbox is not None and hasattr(mailbox, "forget_overview"):
            mailbox.forget_overview()
        return self.apple_info()

    def apple_disconnect(self) -> dict:
        """iPhone trennen: Passwort, Zwischenspeicher und Geburtstage aus den Kontakten sind weg. {ok, fehler}"""
        from ..config import STATE_DIR, save_setting
        from ..geheim import Secrets
        from ..mail import mailbox_from_config

        for thread in threading.enumerate():
            if thread.name == "jarvis-kontakte":
                thread.join(10)  # ein laufender Abgleich schriebe die Geburtstage sonst gleich wieder hinein
        phone = self._phone()
        if phone is not None:
            phone.forget_cache()
        try:
            Secrets(STATE_DIR / "geheim.json").delete("apple")
            save_setting("apple", "apple_id", "")
        except Exception as exc:
            return {"ok": False, "fehler": f"Konnte die Verbindung nicht löschen: {exc}"}
        cfg = self._assistant._cfg
        cfg.setdefault("apple", {})["apple_id"] = ""
        self._assistant.icloud = None
        memory = getattr(self._assistant, "memory", None)
        if memory is not None and hasattr(memory, "set_address_book"):
            memory.set_address_book([])
        self._renew_calendar()
        self._assistant.mail = mailbox_from_config(cfg, STATE_DIR)
        return {"ok": True, "fehler": ""}

    def apple_help(self) -> bool:
        """Knopf "App-spezifisches Passwort erstellen": die Apple-Kontoseite (früher appleid.apple.com)."""
        from .. import pc
        from ..apple import ACCOUNT_URL

        try:
            pc.open_uri(ACCOUNT_URL)
            return True
        except Exception as exc:
            log.info("Apple-Kontoseite: %s", exc)
            return False

    def mail_accounts(self) -> list:
        """Alle Postfächer: [{id, anbieter, name, email (teilweise verdeckt), server, automatisch, fehler}].
        automatisch = iCloud über die Apple-ID (kommt und geht mit dem iPhone)."""
        mailbox = getattr(self._assistant, "mail", None)
        if mailbox is None or not hasattr(mailbox, "accounts"):
            return []
        errors = getattr(mailbox, "errors", {}) or {}
        return [dict(a.as_dict(), fehler=errors.get(a.id, "")) for a in mailbox.accounts()]

    def mail_add(self, provider, email, passwort, server="") -> dict:
        """Ein Postfach dazu: provider "icloud", "gmail", "gmx", "webde", "yahoo" oder "imap" (dann server
        "imap.example.de" oder "imap.example.de:993"). Prüft die Anmeldung sofort. {ok, fehler, konto}"""
        from ..config import STATE_DIR
        from ..mail import MailError, mailbox_from_config

        mailbox = getattr(self._assistant, "mail", None)
        if mailbox is None or not hasattr(mailbox, "add"):
            mailbox = self._assistant.mail = mailbox_from_config(self._assistant._cfg, STATE_DIR)
        try:
            account = mailbox.add(str(provider or ""), str(email or ""), str(passwort or ""), str(server or ""))
        except MailError as exc:
            return {"ok": False, "fehler": str(exc), "konto": None}
        return {"ok": True, "fehler": "", "konto": account.as_dict()}

    def mail_remove(self, ident) -> dict:
        """Ein Postfach entfernen (das Passwort ist danach auch weg). {ok, fehler}"""
        mailbox = getattr(self._assistant, "mail", None)
        if mailbox is None or not hasattr(mailbox, "remove"):
            return {"ok": False, "fehler": "Es ist kein Postfach verbunden."}
        if str(ident) == "icloud" and any(a.id == "icloud" and a.auto for a in mailbox.accounts()):
            return {"ok": False, "fehler": "iCloud-Mail kommt mit dem iPhone. Zum Abschalten das iPhone trennen."}
        if not mailbox.remove(str(ident or "")):
            return {"ok": False, "fehler": "Dieses Postfach gibt es nicht."}
        return {"ok": True, "fehler": ""}

    def mail_help(self, provider) -> bool:
        """Knopf "App-Passwort erstellen" beim Anbieter (nur diese Seiten)."""
        from .. import pc

        url = MAIL_HELP.get(str(provider or ""))
        if not url:
            return False
        try:
            pc.open_uri(url)
            return True
        except Exception as exc:
            log.info("Mail-Hilfe: %s", exc)
            return False

    # ------------------------------------------------------------------ Handy

    def phone_info(self) -> dict:
        """Alles für "Jarvis aufs Handy": an/aus, Adresse, QR-Code, MAC-Adresse fürs Einschalten."""
        from ..remote import app_url, local_ip, mac_address, qr_svg

        cfg = getattr(self._assistant, "_cfg", {}) or {}
        server_cfg = cfg.get("server", {}) or {}
        token = str(server_cfg.get("token") or "")
        enabled = bool(server_cfg.get("enabled")) and len(token) >= 12
        server = getattr(self._assistant, "server", None)
        running = bool(server is not None and server.running)
        ip = local_ip()
        port = server.port if running else int(server_cfg.get("port", 8765) or 8765)
        lan = app_url(token, ip, port) if enabled else ""
        # Über Tailscale (HTTPS): die bessere Adresse, geht überall und mit Sprechtaste
        secure = str(server_cfg.get("https") or "").rstrip("/")
        url = f"{secure}/app/#t={token}" if enabled and secure.startswith("https://") else lan
        return {"enabled": enabled, "running": running, "url": url, "qr": qr_svg(url) if url else "",
                "ip": ip, "port": port, "mac": mac_address(ip), "lan_url": lan, "secure": bool(enabled and secure)}

    def tailscale_info(self) -> dict:
        """Für "Sicher von überall": Ist Tailscale da, angemeldet, und läuft die HTTPS-Adresse schon?"""
        from .. import tailscale

        info = tailscale.status()
        server_cfg = (getattr(self._assistant, "_cfg", {}) or {}).get("server", {}) or {}
        info["url"] = str(server_cfg.get("https") or "")
        return info

    def tailscale_enable(self, on) -> dict:
        """HTTPS über Tailscale an (oder aus). Danach zeigt der QR-Code die sichere Adresse."""
        from .. import tailscale
        from ..config import save_setting

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return {"ok": False, "error": "Jarvis läuft nicht."}
        server_cfg = cfg.setdefault("server", {})
        if not on:
            tailscale.stop()
            server_cfg["https"] = ""
            save_setting("server", "https", "")
            return {"ok": True, "error": "", "url": ""}
        server = getattr(self._assistant, "server", None)
        port = server.port if server is not None and server.running else int(server_cfg.get("port", 8765) or 8765)
        result = tailscale.serve(port)
        if result["ok"]:
            server_cfg["https"] = result["url"]
            save_setting("server", "https", result["url"])
        return result

    def tailscale_help(self, which) -> bool:
        """Knöpfe: Tailscale herunterladen oder HTTPS im Tailscale-Konto erlauben."""
        from .. import pc

        url = str(which or "")
        if url == "download":
            url = "https://tailscale.com/download"
        if not (url.startswith("https://tailscale.com/") or url.startswith("https://login.tailscale.com/")):
            return False
        try:
            pc.open_uri(url)
            return True
        except Exception as exc:
            log.info("Tailscale-Seite: %s", exc)
            return False

    def phone_enable(self, on) -> dict:
        """Handy-Verbindung an oder aus. Beim ersten Mal entsteht ein geheimer Schlüssel."""
        from ..config import save_setting
        from ..remote import new_token

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.phone_info()
        server_cfg = cfg.setdefault("server", {})
        try:
            if on:
                if len(str(server_cfg.get("token") or "")) < 12:
                    server_cfg["token"] = new_token()
                    save_setting("server", "token", server_cfg["token"])
                server_cfg["enabled"] = True
                save_setting("server", "enabled", True)
                if self._start_server is not None:
                    self._start_server()
            else:
                server_cfg["enabled"] = False
                save_setting("server", "enabled", False)
                server = getattr(self._assistant, "server", None)
                if server is not None:
                    server.stop()
                    self._assistant.server = None
        except Exception as exc:
            log.warning("Handy-Verbindung: %s", exc)
            self._bridge.toast(f"Die Handy-Verbindung ließ sich nicht umstellen: {exc}", "error")
        return self.phone_info()

    def phone_new_key(self) -> dict:
        """Neu koppeln: neuer Schlüssel, alte Handys kommen nicht mehr hinein."""
        from ..config import save_setting
        from ..remote import new_token

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.phone_info()
        server_cfg = cfg.setdefault("server", {})
        server_cfg["token"] = new_token()
        save_setting("server", "token", server_cfg["token"])
        server = getattr(self._assistant, "server", None)
        if server is not None:
            server.stop()
            self._assistant.server = None
        if server_cfg.get("enabled") and self._start_server is not None:
            self._start_server()
        return self.phone_info()

    def push_info(self) -> dict:
        """Benachrichtigungen aufs Handy (ntfy): an/aus und der Kanal zum Abonnieren."""
        from ..push import RELAY

        handy = ((getattr(self._assistant, "_cfg", {}) or {}).get("handy", {})) or {}
        topic = str(handy.get("push_kanal") or "")
        relay = str(handy.get("vermittlung") or RELAY).rstrip("/")
        return {"enabled": bool(handy.get("push")) and topic.startswith("jarvis-"), "topic": topic,
                "url": f"{relay}/{topic}" if topic else ""}

    def push_enable(self, on) -> dict:
        """Benachrichtigungen an oder aus. Beim ersten Mal entsteht ein geheimer Kanalname."""
        from ..config import save_setting
        from ..push import Push, new_topic

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.push_info()
        handy = cfg.setdefault("handy", {})
        try:
            if on and not str(handy.get("push_kanal") or "").startswith("jarvis-"):
                handy["push_kanal"] = new_topic()
                save_setting("handy", "push_kanal", handy["push_kanal"])
            handy["push"] = bool(on)
            save_setting("handy", "push", bool(on))
            self._assistant.push = Push(cfg)
        except Exception as exc:
            log.warning("Benachrichtigungen: %s", exc)
            self._bridge.toast(f"Die Benachrichtigungen ließen sich nicht umstellen: {exc}", "error")
        return self.push_info()

    def push_test(self) -> dict:
        import datetime as dt

        push = getattr(self._assistant, "push", None)
        if push is None or not push.enabled:
            return {"ok": False, "error": "Die Benachrichtigungen sind aus."}
        ok = push.send(f"Guten Tag, Sir. Die Benachrichtigungen funktionieren ({dt.datetime.now():%H:%M:%S}).", wait=True)
        return {"ok": ok, "error": "" if ok else "ntfy.sh war gerade nicht erreichbar. Bitte gleich noch einmal."}

    def wol_prepare(self) -> dict:
        """PC fürs Einschalten per Netzwerk vorbereiten (Windows fragt nach Administratorrechten)."""
        from .. import pc

        try:
            text = pc.prepare_wake_on_lan().strip()
            return {"ok": text.startswith("Bereit"), "text": text or "Keine Antwort."}
        except Exception as exc:
            return {"ok": False, "text": f"Das ging nicht: {exc}"}

    # ------------------------------------------------------------------ Discord-Bot

    def connections(self) -> dict:
        """Was gerade verbunden ist, für die Punkte am Knopf "Verbinden" (ohne Netzwerkabfrage)."""
        cfg = getattr(self._assistant, "_cfg", {}) or {}
        server = getattr(self._assistant, "server", None)
        bridge = getattr(self._assistant, "alexa", None)
        token = str(((cfg.get("discord", {}) or {}).get("bot_token")) or "")
        mailbox = getattr(self._assistant, "mail", None)
        return {"phone": bool(server is not None and server.running),
                "alexa": bool(bridge is not None and bridge.connected),
                "discord": len(token) > 50,
                "iphone": self._icloud() is not None,
                "mail": bool(mailbox is not None and getattr(mailbox, "configured", False) is True)}

    def discord_info(self) -> dict:
        from ..discord_bot import DiscordBot, DiscordError

        token = str(((getattr(self._assistant, "_cfg", {}) or {}).get("discord", {}) or {}).get("bot_token") or "")
        if not token:
            return {"configured": False, "name": "", "guilds": [], "error": ""}
        bot = DiscordBot(token)
        try:
            me = bot.me()
            return {"configured": True, "name": str(me.get("username") or "Jarvis"),
                    "guilds": [str(g.get("name") or "") for g in bot.guilds()], "error": ""}
        except DiscordError as exc:
            return {"configured": True, "name": "", "guilds": [], "error": str(exc)}

    def discord_save(self, token) -> dict:
        """Bot-Token prüfen und speichern."""
        from ..config import save_setting
        from ..discord_bot import DiscordBot, DiscordError

        token = str(token or "").strip().strip('"')
        if token.lower().startswith("bot "):
            token = token[4:].strip()
        bot = DiscordBot(token)
        if not bot.configured:
            return {"configured": False, "name": "", "guilds": [], "error": "Das sieht nicht wie ein Bot-Token aus. Bitte den ganzen Token kopieren."}
        try:
            me = bot.me()
        except DiscordError as exc:
            return {"configured": False, "name": "", "guilds": [], "error": str(exc)}
        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is not None:
            cfg.setdefault("discord", {})["bot_token"] = token
        save_setting("discord", "bot_token", token)
        return {"configured": True, "name": str(me.get("username") or "Jarvis"),
                "guilds": [str(g.get("name") or "") for g in bot.guilds()], "error": ""}

    def discord_invite(self) -> dict:
        """Öffnet den Link, mit dem Georg den Bot auf seinen Server holt."""
        from .. import pc
        from ..discord_bot import DiscordBot, DiscordError

        token = str(((getattr(self._assistant, "_cfg", {}) or {}).get("discord", {}) or {}).get("bot_token") or "")
        try:
            url = DiscordBot(token).invite_url()
            pc.open_uri(url)
            return {"ok": True, "url": url}
        except (DiscordError, OSError) as exc:
            return {"ok": False, "url": "", "error": str(exc)}

    def discord_portal(self) -> bool:
        from .. import pc

        try:
            pc.open_uri("https://discord.com/developers/applications")
            return True
        except OSError:
            return False

    # ------------------------------------------------------------------ Alexa

    def alexa_info(self) -> dict:
        from ..alexa import CONSOLE_URL

        cfg = getattr(self._assistant, "_cfg", {}) or {}
        alexa = cfg.get("alexa", {}) or {}
        bridge = getattr(self._assistant, "alexa", None)
        return {"enabled": bool(alexa.get("aktiv")) and bool(alexa.get("kanal")),
                "connected": bool(bridge is not None and bridge.connected), "console": CONSOLE_URL}

    def alexa_enable(self, on) -> dict:
        """Alexa-Verbindung an oder aus. Beim ersten Mal entstehen Kanal und Schlüssel."""
        from ..alexa import new_secrets
        from ..config import save_setting

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.alexa_info()
        alexa = cfg.setdefault("alexa", {})
        try:
            if on and (not str(alexa.get("kanal") or "").startswith("jarvis-") or len(str(alexa.get("schluessel") or "")) != 64):
                fresh = new_secrets()
                alexa.update(fresh)
                save_setting("alexa", "kanal", fresh["kanal"])
                save_setting("alexa", "schluessel", fresh["schluessel"])
            alexa["aktiv"] = bool(on)
            save_setting("alexa", "aktiv", bool(on))
            if on and self._start_alexa is not None:
                self._start_alexa()
            if not on and getattr(self._assistant, "alexa", None) is not None:
                self._assistant.alexa.stop()
                self._assistant.alexa = None
        except Exception as exc:
            log.warning("Alexa-Verbindung: %s", exc)
            self._bridge.toast(f"Die Alexa-Verbindung ließ sich nicht umstellen: {exc}", "error")
        return self.alexa_info()

    def alexa_copy(self, which) -> dict:
        """"modell" (Sprachmodell als JSON) oder "code" (lambda_function.py) in die Zwischenablage."""
        import json

        from .. import pc
        from ..alexa import RELAY, interaction_model, skill_code

        alexa = (getattr(self._assistant, "_cfg", {}) or {}).get("alexa", {}) or {}
        if which == "modell":
            text = json.dumps(interaction_model(), ensure_ascii=False, indent=2)
        elif which == "code" and alexa.get("kanal") and alexa.get("schluessel"):
            text = skill_code(alexa["kanal"], alexa["schluessel"], str(alexa.get("vermittlung") or RELAY))
        else:
            return {"ok": False, "text": ""}
        try:
            copied = pc.copy_text(text)
        except Exception as exc:
            log.debug("Zwischenablage: %s", exc)
            copied = False
        return {"ok": copied, "text": text}

    def alexa_console(self) -> bool:
        from .. import pc
        from ..alexa import CONSOLE_URL

        try:
            pc.open_uri(CONSOLE_URL)
            return True
        except Exception as exc:
            log.info("Alexa-Konsole: %s", exc)
            return False

    def alexa_test(self) -> dict:
        """Ein Befehl auf demselben Weg wie vom Echo: kommt eine Antwort zurück?"""
        bridge = getattr(self._assistant, "alexa", None)
        if bridge is None:
            return {"ok": False, "error": "Die Alexa-Verbindung ist aus."}
        try:
            return {"ok": True, "answer": bridge.self_test()}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------ Gedächtnis

    def memory_state(self) -> dict:
        """Was Jarvis über Georg weiß: Fakten, Kontakte, Gewohnheiten (für die Gedächtnis-Ansicht)."""
        memory = getattr(self._assistant, "memory", None)
        if memory is None:
            return {"facts": [], "contacts": [], "routines": [], "birthdays": [], "commands": []}
        try:
            return {
                "facts": [{"text": f.get("text", ""), "source": f.get("quelle", ""), "since": f.get("seit", "")}
                          for f in reversed(memory.facts())][:60],
                "contacts": [{"name": c.get("name", ""), "app": c.get("app", ""), "count": c.get("anzahl", 0)}
                             for c in memory.contacts()[:12]],
                "routines": [r.as_dict() for r in memory.routines()][:10],
                "birthdays": [{"shown": b["shown"], "date": b["datum"], "days": b["in_tagen"], "own": b["own"]}
                              for b in memory.upcoming_birthdays(days=366)][:12],
                "commands": [{"key": c["key"], "name": c.get("name", ""), "action": c.get("aktion", ""),
                              "count": c.get("anzahl", 0)} for c in memory.custom_commands()][:40],
                "skills": self._skills(),
                "notebook": bool(getattr(self._assistant, "notebook", None)),
                "schedules": self._schedules(),
            }
        except Exception as exc:
            log.debug("Gedächtnis-Stand: %s", exc)
            return {"facts": [], "contacts": [], "routines": [], "birthdays": [], "commands": []}

    def remember(self, text) -> bool:
        from ..memory import match_memory

        memory = getattr(self._assistant, "memory", None)
        text = " ".join(str(text or "").split())
        if memory is None or not text:
            return False
        # Wie gesprochen: "Merk dir, dass ich Pizza mag" -> "Georg sagt: Ich mag Pizza"
        found = match_memory(text)
        if found and found[0] == "teach":  # "Wenn ich Zockmodus sage, öffne Discord"
            try:
                return bool(memory.teach(*found[1]))
            except ValueError:
                return False
        if not found or found[0] != "remember":
            found = match_memory("Merk dir " + text)
        return bool(memory.remember(found[1] if found and found[0] == "remember" else text))

    def forget(self, text) -> bool:
        memory = getattr(self._assistant, "memory", None)
        return bool(memory is not None and str(text or "").strip() and memory.remove(str(text)))

    @staticmethod
    def _skills() -> list[dict]:
        from ..config import HOME_DIR, STATE_DIR
        from ..skills import load_skills

        try:
            return [{"name": k.path.parent.name, "description": k.description, "learned": k.learned}
                    for k in load_skills(HOME_DIR, STATE_DIR)]
        except Exception as exc:
            log.debug("Fähigkeiten: %s", exc)
            return []

    def _schedules(self) -> list[dict]:
        from ..zeitplan import describe_days

        schedules = getattr(self._assistant, "schedules", None)
        if schedules is None:
            return []
        try:
            return [{"id": i["id"], "days": describe_days(i["tage"]), "time": i["uhrzeit"], "command": i["befehl"]}
                    for i in schedules.all()]
        except Exception as exc:
            log.debug("Zeitpläne: %s", exc)
            return []

    def schedule_forget(self, schedule_id) -> bool:
        schedules = getattr(self._assistant, "schedules", None)
        if schedules is None:
            return False
        item = next((i for i in schedules.all() if i["id"] == str(schedule_id)), None)
        return bool(item and schedules.remove(item["befehl"] + " " + item["uhrzeit"]))

    def skill_forget(self, name) -> bool:
        """Mülleimer an einer selbst gelernten Fähigkeit."""
        from ..config import STATE_DIR
        from ..skills import remove_skill

        return bool(str(name or "").strip()) and remove_skill(STATE_DIR, str(name))

    def notebook_open(self) -> dict:
        """Knopf "Notizbuch öffnen": der Ordner im Explorer (oder in Obsidian, wenn so eingestellt)."""
        notebook = getattr(self._assistant, "notebook", None)
        if notebook is None:
            return {"ok": False, "error": "Das Notizbuch ist in den Einstellungen ausgeschaltet."}
        try:
            notebook.sync(getattr(self._assistant, "memory", None))
            if os.name == "nt":
                os.startfile(str(notebook.folder))
            return {"ok": True, "folder": str(notebook.folder)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def command_forget(self, key) -> bool:
        """Mülleimer an einem eigenen Befehl in der Gedächtnis-Ansicht."""
        memory = getattr(self._assistant, "memory", None)
        return bool(memory is not None and str(key or "").strip() and memory.unteach(str(key)))

    def answer_suggestion(self, answer) -> bool:
        """Knöpfe am Vorschlag: "Ja", "Nein" oder "Nie wieder"."""
        answer = {"ja": "Ja", "nein": "Nein", "nie": "Nie wieder"}.get(str(answer), "")
        if not answer:
            return False
        self._assistant.submit(answer)
        return True

    def toggle_gaming(self) -> bool:
        """Schalter in der Spalte links: Gaming-Modus an oder aus."""
        self._assistant.toggle_gaming()
        return not bool(getattr(self._assistant, "gaming", False))

    def touched(self) -> None:
        """Die Seite meldet: Georg hat ins Fenster geklickt. Dann verschwindet es nicht von selbst."""
        if self._on_touched is not None:
            self._on_touched()

    # ------------------------------------------------------------------ Werkstatt

    def workshop_state(self) -> dict | None:
        """Der aktuelle Werkstatt-Auftrag (oder None), damit die Ansicht nach einem Neuladen stimmt."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return None
        try:
            return shop.snapshot()
        except Exception as exc:
            log.debug("Werkstatt-Stand: %s", exc)
            return None

    def workshop_projects(self) -> list:
        """Alle Werkstatt-Projekte für die Projektliste."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return []
        try:
            return shop.projects()[:60]
        except Exception as exc:
            log.debug("Werkstatt-Projekte: %s", exc)
            return []

    def workshop_new(self, text) -> bool:
        """Neuer Auftrag aus der Projektliste."""
        shop = getattr(self._assistant, "workshop", None)
        text = str(text or "").strip()
        if shop is None or not text or shop.busy:
            return False

        def work() -> None:
            self._assistant.announce(shop.start(text))

        threading.Thread(target=work, name="jarvis-werkstatt-neu", daemon=True).start()
        return True

    def workshop_continue(self, folder, text) -> bool:
        """"Weiterarbeiten" an einem Projekt aus der Liste."""
        shop = getattr(self._assistant, "workshop", None)
        text = str(text or "").strip()
        if shop is None or not text:
            return False
        project = next((p for p in shop.projects() if p["folder"] == str(folder)), None)
        if project is None:
            return False

        def work() -> None:
            said = shop.follow_up(text, project)
            self._assistant.announce(said)

        threading.Thread(target=work, name="jarvis-werkstatt-weiter", daemon=True).start()
        return True

    def workshop_run(self, folder) -> bool:
        """"Starten": die start.bat eines Projekts."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None or not folder:
            return False
        try:
            target = Path(str(folder)).resolve()
            if Path(shop.base).resolve() not in target.parents or not (target / "start.bat").is_file():
                return False
            from ..workshop import _start_file

            _start_file(target / "start.bat", target)
            return True
        except OSError as exc:
            log.info("Projekt starten: %s", exc)
            return False

    def workshop_cancel(self) -> bool:
        """Stopp-Knopf in der Werkstatt."""
        shop = getattr(self._assistant, "workshop", None)
        return bool(shop is not None and shop.cancel())

    def open_folder(self, path) -> bool:
        """Öffnet einen Projektordner im Explorer. Nur Ordner in der Werkstatt, sonst nichts."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None or not path:
            return False
        try:
            target = Path(str(path)).resolve()
            base = Path(shop.base).resolve()
        except (OSError, ValueError):
            return False
        if base not in target.parents or not target.is_dir():
            return False
        try:
            if os.name == "nt":
                os.startfile(str(target))  # type: ignore[attr-defined]
            else:
                import subprocess

                subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as exc:
            log.info("Ordner öffnen: %s", exc)
            return False
        return True

    def new_conversation(self) -> None:
        # Erst die laufende Antwort stoppen, sonst landet sie im frisch geleerten Verlauf.
        self._assistant.stop()
        self._assistant.new_conversation()

    def open_setup(self) -> bool:
        """Zahnrad: Einrichtung öffnen. Jarvis schließt sich dafür und startet danach neu."""
        if self._on_setup is None:
            return False
        try:
            self._on_setup()
            return True
        except Exception as exc:
            log.warning("Einrichtung öffnen: %s", exc)
            self._bridge.toast(f"Die Einrichtung ließ sich nicht öffnen: {exc}", "error")
            return False


def webview_available() -> tuple[bool, str]:
    """Prüft, ob das Fenster gehen kann. Gibt (ok, Grund) zurück."""
    try:
        import webview  # noqa: F401
    except Exception as exc:
        return False, f"pywebview fehlt ({exc})"
    if not (WEB_DIR / "index.html").exists():
        return False, "gui/web/index.html fehlt"
    import os

    if os.name == "nt" and not webview2_installed():
        return False, "Microsoft Edge WebView2 fehlt"
    return True, ""


def webview2_installed() -> bool:
    """WebView2 ist bei Windows 11 dabei, bei Windows 10 manchmal nicht."""
    try:
        import winreg
    except ImportError:
        return True
    key = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    alt = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for root, path in (
        (winreg.HKEY_LOCAL_MACHINE, key),
        (winreg.HKEY_LOCAL_MACHINE, alt),
        (winreg.HKEY_CURRENT_USER, alt),
    ):
        try:
            with winreg.OpenKey(root, path) as handle:
                version, _ = winreg.QueryValueEx(handle, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def place_on_screen(width: int, height: int) -> dict:
    """Größe und Lage für ein Fenster, in logischen Punkten (so rechnet pywebview).

    Das Fenster soll auf den Bildschirm passen, auch bei 150 % Skalierung auf Full HD (dann
    sind nur etwa 1280 x 680 Punkte frei), und mittig über der Taskleiste stehen. Die Lage
    geben wir selbst vor: pywebview 6 setzt die Mitte unter Windows zu spät, das Fenster
    landet sonst an der Standard-Stelle von Windows (nach rechts unten versetzt) und ragt auf
    kleinen Bildschirmen über den Rand."""
    place = {"width": width, "height": height, "x": None, "y": None}
    if os.name != "nt":
        return place
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        area = wintypes.RECT()
        user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0)  # SPI_GETWORKAREA
        left, top = area.left, area.top
        free_w, free_h = area.right - area.left, area.bottom - area.top
        aware = 0
        try:
            user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            aware = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext())
        except Exception:
            pass
        if aware:
            # Das Programm sieht echte Pixel, das Fenster wird aber in Punkten angegeben.
            scale = ctypes.windll.shcore.GetScaleFactorForDevice(0) / 100 or 1.0
            left, top = int(left / scale), int(top / scale)
            free_w, free_h = int(free_w / scale), int(free_h / scale)
        if free_w > 400 and free_h > 300:
            width = min(width, free_w - 40)
            height = min(height, free_h - 40)
            place.update(
                width=width,
                height=height,
                x=left + (free_w - width) // 2,
                y=top + (free_h - height) // 2,
            )
    except Exception as exc:
        log.debug("Bildschirmgröße unbekannt: %s", exc)
    return place


TITLE_BAR_COLOR = "#080b11"  # wie der Hintergrund des HUD (style.css --hud-bg)


class Window:
    """Öffnet das Fenster und hält es am Laufen. `start()` blockiert, bis es geschlossen wird.
    Mit `hidden` startet Jarvis unsichtbar (nur Tray-Symbol), das Fenster kommt später."""

    def __init__(self, api: Api, on_started, on_closed, cfg: dict, hidden: bool = False, icon: str | None = None) -> None:
        self._api = api
        self._on_started = on_started
        self._on_closed = on_closed
        self._cfg = cfg
        self._window = None
        self._hidden = hidden
        self._icon = icon
        self._closed_lock = threading.Lock()
        self._closed_done = False
        self.allow_close = True

    @property
    def hidden(self) -> bool:
        return self._hidden

    def start(self) -> None:
        import webview

        place = place_on_screen(int(self._cfg.get("width", 1280)), int(self._cfg.get("height", 800)))
        width, height = place["width"], place["height"]
        self._window = webview.create_window(
            "Jarvis",
            # Ein lokaler Pfad: pywebview liefert die Seite über einen kleinen lokalen Server aus.
            url=str(WEB_DIR / "index.html"),
            js_api=self._api,
            width=width,
            height=height,
            x=place["x"],
            y=place["y"],
            min_size=(min(800, width), min(600, height)),
            background_color="#05080d",
            text_select=True,
            hidden=self._hidden,
        )
        self._window.events.closing += self._closing
        self._window.events.closed += self._closed
        try:
            self._window.events.minimized += self._minimized
        except AttributeError:
            pass
        try:
            # Läuft im Fenster-Thread, bevor das Fenster zum ersten Mal erscheint.
            self._window.events.before_show += self._style_title_bar
        except AttributeError:
            pass  # ältere pywebview-Version: dann färbt show() die Leiste
        try:
            options = {"debug": bool(self._cfg.get("debug", False))}
            if self._icon:
                options["icon"] = self._icon
            try:
                webview.start(self._on_started, **options)
            except TypeError:
                # Ältere pywebview-Version ohne icon=
                options.pop("icon", None)
                webview.start(self._on_started, **options)
        finally:
            # Aufräumen, bevor das Programm endet (das closed-Ereignis läuft in einem
            # eigenen Thread und käme sonst evtl. zu spät).
            self._closed()

    def _closed(self) -> None:
        with self._closed_lock:
            if self._closed_done:
                return
            self._closed_done = True
            try:
                self._on_closed()
            except Exception:
                log.exception("Aufräumen nach dem Schließen")

    def _closing(self):
        if self.allow_close:
            return True
        # Ins Tray-Icon verstecken statt beenden.
        self.hide()
        return False

    def _minimized(self) -> None:
        # Hintergrund-Modus: Minimieren lässt Jarvis ganz verschwinden (auch aus der Taskleiste),
        # er hört weiter zu. Zurück kommt er mit "Hey Jarvis", Strg+Alt+J oder dem Tray-Symbol.
        if self._cfg.get("minimize_to_background", True) and self.allow_close is False:
            self.hide()

    def show_quiet(self) -> None:
        """Erscheint ganz vorn, ohne den Fokus zu nehmen (beim Weckwort)."""
        from .. import desktop

        hwnd = desktop.find_window("Jarvis") if self._window is not None else 0
        if not hwnd or not desktop.show_quietly(hwnd):
            self.show()
            return
        self._quiet = True
        self._hidden = False
        try:
            self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
        except Exception:
            pass

    def settle(self) -> None:
        """Georg hat das Fenster angefasst: ab jetzt ein ganz normales Fenster."""
        if getattr(self, "_quiet", False):
            from .. import desktop

            desktop.release_topmost(desktop.find_window("Jarvis"))
            self._quiet = False

    def _style_title_bar(self) -> None:
        """Dunkle Titelleiste in der Farbe des HUD, auch wenn Windows auf "hell" steht."""
        from ..desktop import style_title_bar

        style_title_bar("Jarvis", TITLE_BAR_COLOR)

    def show(self) -> None:
        if self._window is not None:
            self._style_title_bar()
            self._window.show()
            self._window.restore()
            self._hidden = False
            try:
                self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
            except Exception:
                pass

    def hide(self) -> None:
        if self._window is not None:
            self.settle()  # nicht als "immer oben" verstecken, sonst bleibt es beim nächsten Zeigen so
            self._window.hide()
            self._hidden = True

    def toggle(self) -> None:
        self.show() if self._hidden else self.hide()

    def destroy(self) -> None:
        self.allow_close = True
        if self._window is not None:
            self._window.destroy()
