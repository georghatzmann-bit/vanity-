"""Nachrichten an Personen in Discord, Telegram und WhatsApp, in wenigen Sekunden.

Ohne Umweg über Claude: Jarvis holt die App über ihren Link nach vorn, öffnet die
Schnellsuche, tippt den Namen, öffnet den Chat, tippt den Text und schickt ihn ab.
Danach ist wieder das Fenster vorne, in dem Georg vorher war.

Sicherheit: Vor jedem einzelnen Tastendruck prüft Jarvis, ob die App wirklich vorne ist.
Ist sie es nicht (z. B. weil gerade ein anderes Fenster aufgegangen ist), bricht er ab,
statt den Text irgendwo anders hineinzutippen.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass

log = logging.getLogger(__name__)


class MessagingError(RuntimeError):
    """Etwas ging nicht. Der Text ist für Georg gedacht."""


@dataclass(frozen=True)
class Messenger:
    key: str
    name: str
    processes: tuple[str, ...]
    uri: str
    search: tuple[str, ...]  # Tasten für die Schnellsuche
    prefix: str = ""  # vor den Namen ("@" sucht bei Discord nur Personen)
    pick: tuple[tuple[str, ...], ...] = (("enter",),)  # Tasten, die den ersten Treffer öffnen
    results: float = 0.8  # so lange brauchen die Suchtreffer


APPS: dict[str, Messenger] = {
    "discord": Messenger(
        "discord", "Discord", ("discord.exe", "discordptb.exe", "discordcanary.exe"),
        "discord://-/channels/@me", ("ctrl", "k"), prefix="@",
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

    def foreground_process(self) -> str:
        from .keys import foreground_process

        return foreground_process()

    def foreground_window(self) -> int:
        from .keys import foreground_window

        return foreground_window()

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


def send(app_name: str, person: str, text: str, desk: Desktop | None = None) -> str:
    """Schickt `text` an `person` in der App. Gibt einen kurzen Satz zurück oder wirft
    MessagingError mit einer Erklärung für Georg."""
    app = find_app(app_name)
    if app is None:
        raise MessagingError(f"{app_name} kenne ich nicht. Ich kann Discord, Telegram und WhatsApp.")
    person = " ".join(str(person).split()).strip(" ,:@")
    text = clean_text(text)
    if not person or not text:
        raise MessagingError("Mir fehlt der Name oder der Text.")
    desk = desk or Desktop()
    before = desk.foreground_window()
    cold = not desk.running(app.processes)
    try:
        desk.open_uri(app.uri)
    except OSError as exc:
        raise MessagingError(f"{app.name} ist auf diesem PC nicht installiert.") from exc

    def in_front() -> bool:
        return desk.foreground_process() in app.processes

    end = desk.now() + (25.0 if cold else 5.0)
    while not in_front():
        if desk.now() > end:
            raise MessagingError(f"{app.name} kam nicht nach vorn, deshalb habe ich nichts geschrieben.")
        desk.sleep(0.1)
    if cold:
        desk.sleep(3.0)  # frisch gestartet: erst fertig laden lassen

    def step(action, *args) -> None:
        if not in_front():
            raise MessagingError(f"{app.name} war plötzlich nicht mehr vorne. Ich habe abgebrochen, bevor etwas rausging.")
        action(*args)

    step(desk.press, *app.search)
    desk.sleep(0.35)
    step(desk.type, app.prefix + person)
    desk.sleep(app.results)
    for keys in app.pick:
        step(desk.press, *keys)
        desk.sleep(0.15)
    desk.sleep(0.5)  # Chat öffnet sich
    step(desk.type, text)
    desk.sleep(0.1)
    step(desk.press, "enter")
    log.info("Nachricht an %s über %s gesendet (%d Zeichen).", person, app.name, len(text))
    desk.sleep(0.2)
    if before:
        desk.focus(before)  # zurück zu dem, was Georg gerade gemacht hat
    return f"An {person} auf {app.name} gesendet."
