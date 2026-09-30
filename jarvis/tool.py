"""Befehle, die Claude für Jarvis ausführt: `python -m jarvis.tool <befehl> ...`

Jeder Befehl gibt eine kurze deutsche Zeile aus. Exit-Code 0 = erledigt,
1 = Fehler, 3 = Georg muss erst zustimmen.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

from .config import STATE_DIR, load_config

# Georgs letzte Antwort gilt nur als Ja für Löschen oder Installieren, wenn sie aus
# diesen Wörtern besteht. Alles andere ("nein", "warte", "aber", "und ...") ist kein Ja.
CONFIRM_YES = {
    "ja", "jawohl", "jo", "jep", "jup", "jap", "japp", "yes", "yep", "klar", "genau", "gern", "gerne",
    "natürlich", "sicher", "bitte", "los", "okay", "ok", "oke", "okey", "unbedingt", "ordnung", "passt",
    "bestätigt", "go", "mach", "machs", "tu", "tus", "einverstanden", "selbstverständlich", "richtig",
    "fall", "weiter", "ausführen", "lösch", "lösche", "installier", "installiere",
}
# Diese Wörter dürfen dabei sein, reichen allein aber nicht ("Jarvis.", "Das.").
CONFIRM_FILLER = {
    "das", "es", "sir", "jarvis", "doch", "auf", "jeden", "in", "hm", "hmm", "äh", "ähm", "öhm",
    "na", "mal", "dann", "also", "gut", "sehr", "geht", "gehts", "sie", "ihn", "die", "den", "alle", "beide",
}

HELP = """Jarvis-Befehle (python -m jarvis.tool <befehl>):
  erinnern "<wann>" "<text>"   wann: "in 20 minuten", "in 1 stunde 30 minuten", "18:30",
                               "um 8 uhr abends", "morgen um 8", "Montag um 9", "2026-10-01 08:00"
  erinnerungen                 zeigt alle geplanten Erinnerungen
  erinnerung-loeschen <id>     löscht eine Erinnerung
  medien pause|weiter|naechstes|voriges
  lautstaerke lauter|leiser|stumm [schritte]
  lautstaerke <0-100>          stellt die Lautstärke auf so viel Prozent
  bildschirm                   speichert ein Bildschirmfoto und nennt den Pfad
  gaming an|aus
  papierkorb "<pfad>"          verschiebt in den Papierkorb (erst nach Georgs Ja)
  installieren <winget-id>     installiert ein Programm (erst nach Georgs Ja)
  alexa-sagen <raum> "<text>"  Ansage über ein Echo-Gerät
  alexa-geraete                zeigt die eingetragenen Echo-Geräte
  smarthome geraete [filter]   zeigt Geräte aus Home Assistant
  smarthome an|aus <gerät>     schaltet ein Gerät
  smarthome status <gerät>     zeigt den Zustand
"""


def confirmed(said: str | None = None) -> bool:
    text = os.environ.get("JARVIS_USER_SAID", "") if said is None else said
    if "?" in text:
        return False
    text = re.sub(r"[’`´]", "'", text.lower())
    text = re.sub(r"(\w)'s\b", r"\1 es", text)  # "Mach's", "Tu's", "Los geht's"
    words = [re.sub(r"^(?:ja+)+$", "ja", w) for w in re.findall(r"\w+", text)]  # "Jaja"
    if not words or len(words) > 10:
        return False
    if any(w not in CONFIRM_YES and w not in CONFIRM_FILLER for w in words):
        return False
    return any(w in CONFIRM_YES for w in words)


def need_confirmation(action: str) -> int:
    print(
        f"Noch nicht bestätigt. Frag Georg zuerst, ob du {action} wirklich tun sollst, "
        "und führe den Befehl erst nach seinem Ja noch einmal aus."
    )
    return 3


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("hilfe", "help", "-h", "--help"):
        print(HELP)
        return 0
    command, rest = args[0].lower(), args[1:]
    try:
        return _dispatch(command, rest)
    except Exception as exc:  # jede Meldung soll für Claude lesbar bleiben
        print(f"Fehler: {exc}")
        return 1


def _dispatch(command: str, rest: list[str]) -> int:
    cfg = load_config()

    if command == "erinnern":
        from .reminders import ReminderStore, parse_when, spoken_when

        if len(rest) < 2:
            print('Aufruf: erinnern "<wann>" "<text>"')
            return 1
        when = parse_when(rest[0])
        reminder = ReminderStore(STATE_DIR / "erinnerungen.json").add(when, " ".join(rest[1:]))
        print(f"Erinnerung gespeichert für {spoken_when(when)}: {reminder['text']} (id {reminder['id']})")
        return 0

    if command == "erinnerungen":
        from .reminders import ReminderStore

        items = ReminderStore(STATE_DIR / "erinnerungen.json").upcoming()
        if not items:
            print("Keine Erinnerungen geplant.")
        for r in items:
            print(f"{r['id']}  {r['zeit'].replace('T', ' ')}  {r['text']}")
        return 0

    if command in ("erinnerung-loeschen", "erinnerung-löschen"):
        from .reminders import ReminderStore

        store = ReminderStore(STATE_DIR / "erinnerungen.json")
        ids = set(rest)
        if not ids & {r["id"] for r in store.all()}:
            print("Keine passende Erinnerung gefunden.")
            return 1
        store.remove(ids)
        print("Erinnerung gelöscht.")
        return 0

    if command == "medien":
        from . import pc

        print(pc.media(rest[0] if rest else "pause"))
        return 0

    if command in ("lautstaerke", "lautstärke"):
        from . import pc

        if rest and rest[0].rstrip("%").isdigit():
            print(pc.set_volume(int(rest[0].rstrip("%"))))
            return 0
        steps = int(rest[1]) if len(rest) > 1 and rest[1].isdigit() else 5
        print(pc.volume(rest[0] if rest else "lauter", steps))
        return 0

    if command == "bildschirm":
        from . import pc

        # Im Temp-Ordner, damit Bildschirmfotos nicht in OneDrive landen.
        path = pc.screenshot(Path(tempfile.gettempdir()) / "jarvis-bildschirm.png")
        print(f"Bildschirmfoto gespeichert: {path} (mit dem Read-Werkzeug ansehen)")
        return 0

    if command == "gaming":
        from . import pc

        on = not rest or rest[0].lower() in ("an", "ein", "on")
        print(pc.gaming_mode(on, cfg.get("gaming", {})))
        return 0

    if command == "papierkorb":
        from . import pc

        if not rest:
            print('Aufruf: papierkorb "<pfad>"')
            return 1
        pc.trash_target(" ".join(rest))  # ganze Ordner gar nicht erst nachfragen
        if not confirmed():
            return need_confirmation(f"{rest[0]} in den Papierkorb verschieben")
        print(pc.to_recycle_bin(" ".join(rest)))
        return 0

    if command == "installieren":
        from . import pc

        if not rest:
            print("Aufruf: installieren <winget-id>, die ID findest du mit: winget search <name>")
            return 1
        if not confirmed():
            return need_confirmation(f"{rest[0]} installieren")
        print(pc.install(rest[0]))
        return 0

    if command in ("alexa-sagen", "alexa", "ansage"):
        from .homeassistant import HomeAssistant

        if len(rest) < 2:
            print('Aufruf: alexa-sagen <raum> "<text>"')
            return 1
        print(HomeAssistant(cfg.get("homeassistant", {})).announce(rest[0], " ".join(rest[1:])))
        return 0

    if command in ("alexa-geraete", "alexa-geräte"):
        from .homeassistant import HomeAssistant

        ha = HomeAssistant(cfg.get("homeassistant", {}))
        if not ha.alexa:
            print("Noch keine Echo-Geräte eingetragen (config.toml, [homeassistant.alexa]).")
        for room, target in ha.alexa.items():
            print(f"{room}: {target}")
        return 0

    if command == "smarthome":
        from .homeassistant import HomeAssistant

        ha = HomeAssistant(cfg.get("homeassistant", {}))
        action = rest[0].lower() if rest else "geraete"
        name = " ".join(rest[1:])
        if action in ("geraete", "geräte", "liste"):
            rows = ha.devices(name)
            if not rows:
                print("Keine passenden Geräte gefunden.")
            for entity, friendly, state in rows[:60]:
                print(f"{entity}  {friendly}  [{state}]")
            return 0
        if action in ("an", "ein", "aus"):
            if not name:
                print("Aufruf: smarthome an|aus <gerät>")
                return 1
            print(ha.turn(name, action != "aus"))
            return 0
        if action == "status":
            entity = ha.find(name)
            state = ha.state(entity)
            print(f"{entity}: {state.get('state', 'unbekannt')}")
            return 0
        print("Aufruf: smarthome geraete|an|aus|status ...")
        return 1

    print(f"Unbekannter Befehl: {command}\n")
    print(HELP)
    return 1


if __name__ == "__main__":
    sys.exit(main())
