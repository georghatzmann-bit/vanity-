"""Nachrichten an Personen in Discord, Telegram und WhatsApp, in zwei bis drei Sekunden.

Ohne Umweg über Claude und ohne Maus: Jarvis holt die App nach vorn, öffnet die
Schnellsuche, tippt den Namen, öffnet den Chat, tippt den Text und schickt ihn ab.
Danach ist wieder das Fenster vorne, in dem Georg vorher war (z. B. sein Spiel).

Sicherheit: Vor jedem einzelnen Tastendruck prüft Jarvis, ob die App wirklich vorne ist.
Ist sie es nicht (Georg hat ins Spiel geklickt, ein anderes Fenster ging auf), tippt er
nichts woanders hinein, wartet kurz, bis Maus und Tastatur ruhig sind, und versucht es
noch einmal von vorn. Halb getippter Text im Chatfeld wird dabei vorher gelöscht, damit
nichts doppelt ankommt. Nach dem Abschicken wird nie wiederholt.

Bei Discord zeigt der Fenstertitel den offenen Chat. Ändert er sich nach der Suche nicht,
hat die Schnellsuche niemanden gefunden: Dann schreibt Jarvis lieber gar nichts, statt
die Nachricht in den falschen Chat zu schicken.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass

log = logging.getLogger(__name__)


class MessagingError(RuntimeError):
    """Etwas ging nicht. Der Text ist für Georg gedacht."""


class _Retry(Exception):
    """Ein Versuch ging schief, ein neuer kann klappen (z. B. Georg hat dazwischengeklickt)."""

    def __init__(self, reason: str, final: str, attempts: int = 3) -> None:
        super().__init__(reason)
        self.final = final  # was Georg hört, wenn auch der letzte Versuch so endet
        self.attempts = attempts  # so viele Versuche lohnen sich höchstens


@dataclass(frozen=True)
class Messenger:
    key: str
    name: str
    processes: tuple[str, ...]
    uri: str
    search: tuple[str, ...]  # Tasten für die Schnellsuche
    prefix: str = ""  # vor den Namen ("@" sucht bei Discord nur Personen)
    pick: tuple[tuple[str, ...], ...] = (("enter",),)  # Tasten, die den ersten Treffer öffnen
    results: float = 0.7  # so lange brauchen die Suchtreffer
    reset: tuple[tuple[str, ...], ...] = ()  # vorher offene Menüs schließen
    titles: bool = False  # der Fenstertitel zeigt den offenen Chat (Prüfung, ob die Suche traf)
    clear: bool = True  # Chatfeld vor dem Tippen leeren (Reste eines unterbrochenen Versuchs)


APPS: dict[str, Messenger] = {
    "discord": Messenger(
        "discord", "Discord", ("discord.exe", "discordptb.exe", "discordcanary.exe"),
        "discord://-/channels/@me", ("ctrl", "k"), prefix="@", reset=(("esc",),), titles=True,
    ),
    "telegram": Messenger(
        "telegram", "Telegram", ("telegram.exe",), "tg://", ("ctrl", "f"),
    ),
    "whatsapp": Messenger(
        "whatsapp", "WhatsApp", ("whatsapp.exe", "whatsapp.root.exe"), "whatsapp://", ("ctrl", "f"),
        pick=(("down",), ("enter",)), results=1.0,
    ),
}

ALIASES = {"whats app": "whatsapp", "whatsapp": "whatsapp", "discord": "discord", "telegram": "telegram"}

# Discord-Schnellsuche: "@" Personen, "#" Textkanäle, "!" Sprachkanäle, "*" Server
DISCORD_PREFIX = {"person": "@", "channel": "#", "voice": "!", "server": "*"}
# Discord-Tasten (nur, wenn Discord vorne ist): Mikrofon stumm, taub (nichts hören)
DISCORD_KEYS = {"mute": ("ctrl", "shift", "m"), "deafen": ("ctrl", "shift", "d")}

ATTEMPTS = 3


def find_app(name: str) -> Messenger | None:
    key = ALIASES.get(" ".join(str(name).lower().split()))
    return APPS.get(key) if key else None


class Desktop:
    """Die echte Windows-Seite. Für Tests gibt es eine Attrappe mit denselben Methoden."""

    def open_uri(self, uri: str) -> None:
        os.startfile(uri)  # type: ignore[attr-defined]

    def running(self, names: tuple[str, ...]) -> bool:
        try:
            import psutil

            wanted = set(names)
            return any((p.info.get("name") or "").lower() in wanted for p in psutil.process_iter(["name"]))
        except Exception:
            return False

    def focus_app(self, names: tuple[str, ...], hint: str = "") -> bool:
        """Holt das offene Fenster der App direkt nach vorn (schneller als über ihren Link)."""
        from .keys import bring_to_front, find_window

        hwnd = find_window(names, hint)
        try:
            return bool(hwnd) and bring_to_front(hwnd)
        except Exception as exc:
            log.debug("Fenster nach vorn: %s", exc)
            return False

    def foreground_process(self) -> str:
        from .keys import foreground_process

        return foreground_process()

    def foreground_window(self) -> int:
        from .keys import foreground_window

        return foreground_window()

    def window_title(self) -> str:
        from .keys import window_title

        return window_title()

    def idle_seconds(self) -> float:
        from .keys import idle_seconds

        return idle_seconds()

    def keys_held(self) -> bool:
        from .keys import keys_held

        return keys_held()

    def press(self, *keys: str) -> None:
        from .keys import press

        press(*keys)

    def type(self, text: str) -> None:
        from .keys import type_text

        type_text(text)

    def focus(self, hwnd: int) -> None:
        from .keys import focus

        focus(hwnd)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def now(self) -> float:
        return time.monotonic()


def clean_text(text: str) -> str:
    """Gesprochener Text als Chatnachricht: eine Zeile, großer Anfang, ohne Schlusspunkt."""
    text = " ".join(str(text).split())
    text = text.strip(" ,;:-–—")
    if text.endswith(".") and not text.endswith(".."):
        text = text[:-1]
    return text[:1].upper() + text[1:] if text else text


# ---------------------------------------------------------------------- indirekte Rede

# Trennbare Vorsilben: "dass ich später anrufe" -> "Ich rufe später an". Längere zuerst.
_SEPARABLE = ("zurück", "vorbei", "weiter", "heraus", "herein", "hinaus", "fertig", "heim", "fest", "los",
              "weg", "mit", "nach", "vor", "auf", "aus", "ein", "an", "ab", "zu", "her", "hin", "bei", "um")
# Sieht aus wie Vorsilbe + Verb, ist aber keins ("antworte" ist nicht "worte an").
_NOT_SEPARABLE = {"antworte", "antworten", "umarme", "umarmen", "anbete", "zucke", "zucken", "mitteile"}
# Wen meint "ihn" oder "sie"? Das kann nur Claude entscheiden.
_UNCLEAR = re.compile(r"\b(?:er|ihn|ihm|sie|ihr|ihnen|sein|seine|seinen|seinem|ihre|ihren|ihrem)\b", re.I)


def _split_verb(verb: str) -> tuple[str, str]:
    """"anrufe" -> ("rufe", "an"), "komme" -> ("komme", "")."""
    low = verb.lower()
    if low in _NOT_SEPARABLE or low.endswith(("iere", "ieren")):
        return verb, ""
    for prefix in _SEPARABLE:
        rest = low[len(prefix):]
        if low.startswith(prefix) and len(rest) >= 4 and rest[0] not in "aeiouäöü":
            return verb[len(prefix):], verb[:len(prefix)]
    return verb, ""


def direct_speech(text: str) -> str | None:
    """"dass ich später komme" -> "Ich komme später". Nur für "ich" und "wir" ohne unklare
    Fürwörter, alles andere (z. B. "dass er sich beeilen soll") formuliert Claude um."""
    found = re.match(r"^\s*dass\s+(ich|wir)\s+(.+?)[\s.!]*$", str(text), re.I)
    if not found:
        return None
    subject, rest = found.group(1).lower(), found.group(2)
    if _UNCLEAR.search(rest) or "," in rest:
        return None
    words = rest.split()
    verb, middle = words[-1], words[:-1]
    if not re.fullmatch(r"[a-zäöüß]+", verb, re.I) or len(verb) < 2:
        return None
    stem, particle = _split_verb(verb)
    sentence = " ".join([subject.capitalize(), stem, *middle, *([particle] if particle else [])])
    return sentence


# ---------------------------------------------------------------------- Ablauf in der App


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", str(text).lower())


class _Session:
    """Ein Auftrag in einer Chat-App: nach vorn holen, suchen, tippen, mit Prüfung vor jeder Taste."""

    def __init__(self, app: Messenger, desk: Desktop) -> None:
        self.app = app
        self.desk = desk
        self.before = desk.foreground_window()
        self.cold = not desk.running(app.processes)
        self.slow = 1.0  # wird bei jedem neuen Versuch größer: mehr Zeit für langsame Rechner

    def in_front(self) -> bool:
        return self.desk.foreground_process() in self.app.processes

    def step(self, action, *args) -> None:
        self.hands_off()
        if not self.in_front():
            raise _Retry(
                "nicht mehr vorne",
                f"{self.app.name} war immer wieder nicht vorne. Ich habe abgebrochen, bevor etwas rausging.",
            )
        action(*args)

    def hands_off(self) -> None:
        """Hält Georg gerade eine Taste (W zum Laufen, Umschalt zum Sprinten), wartet Jarvis kurz.
        Sonst rutschen Buchstaben in die Nachricht, und Umschalt+Enter macht nur eine neue Zeile."""
        end = self.desk.now() + 1.5 * self.slow
        while self.desk.keys_held():
            if self.desk.now() >= end:
                raise _Retry("Tasten gedrückt", f"Sie hatten die ganze Zeit Tasten gedrückt, Sir. Ich habe in "
                                                f"{self.app.name} nichts geschickt. Sagen Sie es einfach noch einmal.")
            self.desk.sleep(0.05)

    def wait_quiet(self, seconds: float) -> None:
        """Wartet, bis Georg Maus und Tastatur kurz loslässt und keine Taste mehr hält (höchstens
        `seconds`). So holt Jarvis die App nicht nach vorn, während Georg gerade läuft oder zielt."""
        end = self.desk.now() + seconds
        while self.desk.now() < end and (self.desk.idle_seconds() < 0.35 or self.desk.keys_held()):
            self.desk.sleep(0.05)

    def bring_forward(self) -> None:
        app, desk = self.app, self.desk
        if self.in_front():
            return
        if not self.cold and desk.focus_app(app.processes, app.name) and self.in_front():
            return
        try:
            desk.open_uri(app.uri)
        except OSError as exc:
            raise MessagingError(f"{app.name} ist auf diesem PC nicht installiert.") from exc
        end = desk.now() + (25.0 if self.cold else 5.0)
        while not self.in_front():
            if desk.now() > end:
                raise MessagingError(f"{app.name} kam nicht nach vorn, deshalb habe ich nichts geschrieben.")
            desk.sleep(0.1)
        if self.cold:
            desk.sleep(3.0)  # frisch gestartet: erst fertig laden lassen
            self.cold = False

    def jump(self, query: str, who: str) -> None:
        """Schnellsuche: `query` eintippen und den ersten Treffer öffnen."""
        app, desk = self.app, self.desk
        title = desk.window_title() if app.titles else ""
        for keys in app.reset:
            self.step(desk.press, *keys)
            desk.sleep(0.05)
        self.step(desk.press, *app.search)
        desk.sleep(0.3 * self.slow)
        self.step(desk.type, query)
        desk.sleep(app.results * self.slow)
        for keys in app.pick:
            self.step(desk.press, *keys)
            desk.sleep(0.12)
        if not app.titles:
            desk.sleep(0.5 * self.slow)
            return
        if not self._moved(title, who):
            self.step(desk.press, "esc")  # Schnellsuche schließen
            raise _Retry("Suche ohne Treffer", f"{who} finde ich in {app.name} nicht, Sir. Ich habe nichts geschickt.", 2)
        desk.sleep(0.15)

    def _moved(self, before: str, who: str) -> bool:
        """Hat die Schnellsuche einen Chat geöffnet? Der Fenstertitel verrät es."""
        end = self.desk.now() + 1.0 * self.slow
        while True:
            if self.desk.window_title() != before:
                return True
            if self.desk.now() >= end:
                break
            self.desk.sleep(0.05)
        # Schon im richtigen Chat, oder der Titel zeigt gar keinen Chat (dann lässt es sich nicht prüfen)
        return _norm(who) in _norm(before) or _norm(before) in ("", _norm(self.app.name))

    def write(self, text: str) -> None:
        desk = self.desk
        if self.app.clear:
            self.step(desk.press, "ctrl", "a")
            self.step(desk.press, "backspace")
        self.step(desk.type, text)
        desk.sleep(0.1)
        self.step(desk.press, "enter")

    def back(self) -> None:
        """Zurück in das Fenster, in dem Georg vorher war, aber nur, wenn noch die App vorne ist
        (hat Georg selbst woanders hingeklickt, bleibt er dort)."""
        if self.before and self.in_front():
            self.desk.sleep(0.15)
            self.desk.focus(self.before)

    def run(self, work, back: bool = True) -> None:
        """`work()` mit bis zu ATTEMPTS Versuchen. Abschicken passiert nur im letzten Schritt
        von `work`, ein Fehler danach gibt es nicht: wiederholt wird also nie doppelt."""
        self.wait_quiet(1.0)
        try:
            for attempt in range(1, ATTEMPTS + 1):
                try:
                    self.bring_forward()
                    work()
                    return
                except _Retry as exc:
                    if attempt >= min(ATTEMPTS, exc.attempts):
                        raise MessagingError(exc.final) from None
                    log.info("%s: %s, neuer Versuch (%d)", self.app.name, exc, attempt + 1)
                    self.slow *= 1.6
                    self.wait_quiet(3.0)
        finally:
            if back:
                self.back()


def _app_or_error(app_name: str) -> Messenger:
    app = find_app(app_name)
    if app is None:
        raise MessagingError(f"{app_name} kenne ich nicht. Ich kann Discord, Telegram und WhatsApp.")
    return app


def send(app_name: str, person: str, text: str, desk: Desktop | None = None) -> str:
    """Schickt `text` an `person` in der App. Gibt einen kurzen Satz zurück oder wirft
    MessagingError mit einer Erklärung für Georg. `person` darf bei Discord mit "#" anfangen
    (Textkanal): "#allgemein"."""
    app = _app_or_error(app_name)
    person = " ".join(str(person).split()).strip(" ,:@")
    text = clean_text(text)
    if not person.strip("#") or not text:
        raise MessagingError("Mir fehlt der Name oder der Text.")
    session = _Session(app, desk or Desktop())
    query = person if person.startswith("#") else app.prefix + person

    def work() -> None:
        session.jump(query, person.lstrip("#"))
        session.write(text)

    session.run(work)
    log.info("Nachricht an %s über %s gesendet (%d Zeichen).", person, app.name, len(text))
    return f"An {person} auf {app.name} gesendet."


def discord_open(target: str, kind: str = "person", desk: Desktop | None = None) -> str:
    """Öffnet in Discord einen Chat, Kanal, Sprachkanal oder Server über die Schnellsuche.
    Discord bleibt danach vorne, Georg will es ja sehen (beim Sprachkanal nicht nötig)."""
    app = APPS["discord"]
    target = " ".join(str(target).split()).strip(" ,:@#!*")
    if not target:
        raise MessagingError("Mir fehlt, was ich in Discord öffnen soll.")
    session = _Session(app, desk or Desktop())
    session.run(lambda: session.jump(DISCORD_PREFIX.get(kind, "@") + target, target), back=kind == "voice")
    return target


def discord_call(person: str, desk: Desktop | None = None) -> str:
    """Ruft jemanden in Discord an: Chat öffnen, dann Strg+' (Anruf starten)."""
    app = APPS["discord"]
    person = " ".join(str(person).split()).strip(" ,:@")
    if not person:
        raise MessagingError("Mir fehlt, wen ich anrufen soll.")
    session = _Session(app, desk or Desktop())

    def work() -> None:
        session.jump("@" + person, person)
        session.step(session.desk.press, "ctrl", "quote")

    session.run(work, back=False)
    return person


def discord_key(action: str, desk: Desktop | None = None) -> None:
    """Stumm oder taub umschalten (Discords eigene Tasten, wirken nur, wenn Discord vorne ist).
    Danach wieder zurück ins Spiel."""
    app = APPS["discord"]
    keys = DISCORD_KEYS[action]
    desk = desk or Desktop()
    if not desk.running(app.processes):
        raise MessagingError("Discord läuft gerade nicht, Sir.")
    session = _Session(app, desk)
    session.run(lambda: session.step(desk.press, *keys))
