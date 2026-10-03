"""Befehle, die Claude für Jarvis ausführt: `python -m jarvis.tool <befehl> ...`

Jeder Befehl gibt eine kurze deutsche Zeile aus. Exit-Code 0 = erledigt,
1 = Fehler, 3 = Georg muss erst zustimmen.
"""

from __future__ import annotations

import json
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
  oeffnen "<name>"             startet ein Programm aus dem Startmenü oder eine bekannte Webseite
  schliessen "<name>"          schließt ein Programm
  programme [filter]           zeigt, was im Startmenü steht
  installieren "<name|id>"     installiert ein Programm (Name wie "spotify" oder winget-ID)
  deinstallieren <winget-id>   deinstalliert ein Programm (ohne volle Freigabe erst nach Georgs Ja)
  admin "<PowerShell-Befehl>"  führt etwas mit Administratorrechten aus (Windows fragt Georg)
  nachricht <app> "<person>" "<text>"
                               schickt eine Chatnachricht, app: discord, telegram, whatsapp
                               (Discord-Kanal: "#kanalname" als person)
  discord chat|kanal|server|sprachkanal "<name>"
                               öffnet das in Discord über die Schnellsuche (ohne Maus)
  discord anrufen "<person>"   startet einen Discord-Anruf
  discord stumm|taub           schaltet Mikrofon oder Ton in Discord um (zurück ins Spiel)
  werkstatt "<auftrag>"        gibt einen Programmier- oder Bauauftrag an die Werkstatt
  werkstatt-weiter "<wunsch>"  arbeitet am letzten Werkstatt-Projekt weiter
  werkstatt-projekt "<name>" "<wunsch>"
                               arbeitet an einem bestimmten Werkstatt-Projekt weiter
  werkstatt-projekte           zeigt alle Werkstatt-Projekte
  blueprint "<wunsch>"         baut ein 3D-Modell als Hologramm im Blueprint (Gegenstände, Fahrzeuge, Rüstung ...)
  blueprint-aendern "<wunsch>" ändert das Modell, das gerade im Blueprint liegt
                               (alte Namen: blaupause, blaupause-aendern)
  weltlage "<ort>"             zeigt einen Ort auf der Satelliten-Erde (die Erde fliegt hin)
  weltlage-bericht <welt|deutschland|wirtschaft>   Lagebericht: Jarvis fliegt zu jeder Meldung und liest sie vor
  merken "<fakt>"              merkt sich etwas über Georg für immer ("Georg spielt gern Valorant")
  vergessen "<wörter>"         vergisst Gemerktes, in dem diese Wörter vorkommen
  gedaechtnis                  zeigt, was Jarvis über Georg weiß, seine Kontakte und Gewohnheiten
  einkauf                      zeigt Georgs Einkaufsliste
  einkauf dazu "<ding>" ["<ding>" ...]   setzt etwas auf die Einkaufsliste ("Mandelmus")
  einkauf weg "<ding>" ["<ding>" ...]    hakt etwas ab (gekauft)
  befehl "<name>" "<was>"      legt einen eigenen Befehl an: sagt Georg den Namen, erledigt Jarvis "<was>"
                               (z. B. befehl "Zockmodus" "Öffne Discord und Steam und mach den Gaming-Modus an")
  befehle                      zeigt Georgs eigene Befehle
  befehl-loeschen "<name>"     löscht einen eigenen Befehl
  notiz "<text>" ["<titel>"]   schreibt eine Notiz ins Notizbuch (ohne Titel: Schnellnotizen)
  bericht "<titel>" "<datei.md>"  legt einen Bericht (Recherche) ins Notizbuch
  notizbuch-suchen "<wörter>"  sucht im Notizbuch (Tagebuch, Personen, Berichte, Notizen)
  notizbuch-tag heute|gestern|<JJJJ-MM-TT>   zeigt die Gespräche eines Tages
  notizbuch-netz "<titel oder wörter>"   zeigt, womit eine Seite im Wissensnetz verknüpft ist (mit Grund),
                               sonst die Seiten, die zu den Wörtern passen
  faehigkeiten                 zeigt alle Fähigkeiten (Anleitungen für wiederkehrende Aufgaben)
  faehigkeit "<name>" "<wann sie passt>" "<datei.md>"   speichert eine gelernte Fähigkeit
  faehigkeit-loeschen "<name>" löscht eine gelernte Fähigkeit
  erinnern "<wann>" "<text>"   wann: "in 20 minuten", "in 1 stunde 30 minuten", "18:30",
                               "um 8 uhr abends", "morgen um 8", "Montag um 9", "2026-10-01 08:00"
  erinnerungen                 zeigt alle geplanten Erinnerungen
  zeitplan "<wann>" "<befehl>" erledigt einen Befehl regelmäßig von selbst, wann z. B. "jeden Morgen um 8",
                               "werktags um 18 Uhr", "freitags um 20 Uhr" (Befehl in Georgs Worten)
  zeitplaene                   zeigt alle Zeitpläne
  zeitplan-loeschen "<wörter>" löscht einen Zeitplan
  erinnerung-loeschen <id>     löscht eine Erinnerung
  medien pause|weiter|naechstes|voriges
  lautstaerke lauter|leiser|stumm [schritte]
  lautstaerke <0-100>          stellt die Lautstärke auf so viel Prozent
  bildschirm [fenster]         speichert ein kleines Bildschirmfoto (nur das vordere Fenster) und nennt den Pfad
  bildschirm-text [fenster]    liest den Text auf dem Bildschirm direkt am PC, mit Positionen (schnell)
  fenster                      zeigt alle offenen Fenster
  ui "<fenster>"               zeigt Knöpfe, Felder und Menüs eines Fensters
  ui-klick "<fenster>" "<knopf>"   drückt einen Knopf ohne Maus
  ui-schreiben "<fenster>" "<feld>" "<text>"   schreibt in ein Feld ohne Tastatur ("" = erstes Feld)
  gaming an|aus
  papierkorb "<pfad>"          verschiebt in den Papierkorb (ohne volle Freigabe erst nach Georgs Ja)
  herunterfahren [sekunden]    fährt den PC herunter (Georg kann in der Zeit abbrechen, Vorgabe 15)
  neustarten [sekunden]        startet den PC neu
  energiesparen | ruhezustand | abmelden
  herunterfahren-abbrechen     hält ein geplantes Herunterfahren oder einen Neustart auf
  alexa-sagen <raum> "<text>"  Ansage über ein Echo-Gerät
  alexa-geraete                zeigt die eingetragenen Echo-Geräte
  alexa-befehl <raum> "<text>" ein Echo führt einen Sprachbefehl aus (alles, was Alexa kann)
  licht an|aus [raum] [prozent]  schaltet oder dimmt das Licht (Home Assistant)
  wol-vorbereiten              stellt Windows so ein, dass der PC per Netzwerk eingeschaltet werden kann
  wecken <mac-adresse>         schaltet ein anderes Gerät im Netz per Wake-on-LAN ein
  smarthome geraete [filter]   zeigt Geräte aus Home Assistant
  smarthome an|aus <gerät>     schaltet ein Gerät
  smarthome status <gerät>     zeigt den Zustand
"""


def last_said() -> str:
    """Was Georg zu dieser Anfrage gesagt hat. Jarvis schreibt es vor jeder Frage in eine Datei
    (der Claude-Prozess läuft weiter, seine Umgebung bleibt also alt); sonst die Umgebung."""
    path = os.environ.get("JARVIS_SAID_FILE", "")
    if path:
        try:
            return Path(path).read_text(encoding="utf-8")
        except OSError:
            pass
    return os.environ.get("JARVIS_USER_SAID", "")


def confirmed(said: str | None = None) -> bool:
    text = last_said() if said is None else said
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


def full_permission(cfg: dict | None = None) -> bool:
    """Georg hat Jarvis volle Freigabe erteilt ([rechte] volle_freigabe): kein Nachfragen."""
    cfg = cfg if cfg is not None else load_config()
    return bool(cfg.get("rechte", {}).get("volle_freigabe", True))


def _user() -> str:
    from .config import user_name

    try:
        return user_name(load_config())
    except Exception:
        return "Georg"


def _birthday_line(birthday: dict) -> str:
    """"Max Müller am 03.10. (in 2 Tagen)" für die Gedächtnis-Übersicht."""
    days = birthday["in_tagen"]
    when = "heute" if days == 0 else "morgen" if days == 1 else f"in {days} Tagen"
    day = birthday["datum"]
    return f"{birthday['shown']} am {day[8:10]}.{day[5:7]}. ({when})"


def need_confirmation(action: str) -> int:
    print(
        f"Noch nicht bestätigt. Frag {_user()} zuerst, ob du {action} wirklich tun sollst, "
        "und führe den Befehl erst nach dem Ja noch einmal aus."
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

    if command == "werkstatt-projekte":
        from .workshop import Workshop

        items = Workshop(cfg, None, None, print).projects()
        if not items:
            print("Die Werkstatt ist noch leer.")
        for item in items[:40]:
            print(f"{item['name']}  [{item['state'] or '?'}, {item['updated']}]  {item['task'][:80]}  ({item['folder']})")
        return 0

    if command == "werkstatt-projekt":
        from .workshop import hand_over

        if len(rest) < 2:
            print('Aufruf: werkstatt-projekt "<name>" "<wunsch>"')
            return 1
        if os.environ.get("JARVIS_WERKSTATT"):
            print("Du bist schon in der Werkstatt. Bau es selbst, hier im Projektordner.")
            return 1
        hand_over(STATE_DIR, " ".join(rest[1:]), continue_last=True, project=rest[0])
        print(f"Die Werkstatt übernimmt. Sag {_user()} nur kurz, dass du am Projekt weitermachst.")
        return 0

    if command in ("werkstatt", "werkstatt-weiter"):
        from .workshop import hand_over

        task = " ".join(rest).strip()
        if not task:
            print(f'Aufruf: {command} "<auftrag>"')
            return 1
        if os.environ.get("JARVIS_WERKSTATT"):
            print("Du bist schon in der Werkstatt. Bau es selbst, hier im Projektordner.")
            return 1
        hand_over(STATE_DIR, task, continue_last=command == "werkstatt-weiter")
        print(f"Die Werkstatt übernimmt (das Fenster zeigt die Arbeit). Sag {_user()} nur kurz, dass du in der "
              "Werkstatt bist, und mach den Auftrag nicht selbst.")
        return 0

    if command in ("blueprint", "blueprint-aendern", "blaupause", "blaupause-aendern"):
        from .blaupause import hand_over as blueprint_hand_over

        wish = " ".join(rest).strip()
        if not wish:
            print(f'Aufruf: {command} "<wunsch>"')
            return 1
        blueprint_hand_over(STATE_DIR, wish, change=command.endswith("-aendern"))
        print(f"Der Blueprint übernimmt (das Hologramm baut sich im Fenster auf). Sag {_user()} nur kurz, dass du "
              "es baust, und beschreib das Modell nicht selbst.")
        return 0

    if command in ("weltlage", "weltlage-bericht"):
        from .weltlage import KINDS, hand_over as world_hand_over

        what = " ".join(rest).strip()
        if command == "weltlage-bericht":
            kind = what.lower() or "welt"
            if kind not in KINDS:
                print("Aufruf: weltlage-bericht <welt|deutschland|wirtschaft>")
                return 1
            world_hand_over(STATE_DIR, kind=kind)
            print(f"Die Weltlage übernimmt: Jarvis liest die Meldungen vor. Sag {_user()} nichts weiter dazu.")
            return 0
        if not what:
            print('Aufruf: weltlage "<ort>"')
            return 1
        world_hand_over(STATE_DIR, where=what)
        print(f"Die Erde fliegt hin. Sag {_user()} in einem Satz, was dort zu sehen ist oder wo es liegt.")
        return 0

    if command in ("merken", "merke", "gedaechtnis", "gedächtnis", "vergessen", "vergiss"):
        from .memory import Memory, set_user

        set_user(_user())
        memory = Memory(STATE_DIR / "gedaechtnis.json")
        what = " ".join(rest).strip()
        if command in ("merken", "merke"):
            if not what:
                print('Aufruf: merken "<fakt>"')
                return 1
            print(f"Gemerkt: {memory.remember(what, source='jarvis')}")
            return 0
        if command in ("vergessen", "vergiss"):
            count = memory.forget(what)
            print(f"{count} Eintrag/Einträge vergessen." if count else "Dazu war nichts gespeichert.")
            return 0
        facts, contacts, routines = memory.facts(), memory.contacts(), memory.routines()
        print("Fakten:" if facts else "Noch keine Fakten.")
        for fact in facts:
            print(f"- {fact['text']}")
        if contacts:
            print("Kontakte: " + ", ".join(f"{c['name']} ({c.get('app', '?')})" for c in contacts[:20]))
        for routine in routines:
            print(f"Gewohnheit: {routine.describe()}")
        soon = memory.upcoming_birthdays(days=30)
        if soon:  # aus den Fakten und aus den iPhone-Kontakten
            print("Geburtstage in den nächsten 30 Tagen: " + "; ".join(_birthday_line(b) for b in soon[:10]))
        return 0

    if command in ("einkauf", "einkaufsliste"):
        from .einkauf import join
        from .memory import Memory, set_user

        set_user(_user())
        memory = Memory(STATE_DIR / "gedaechtnis.json")
        action = (rest[0].lower() if rest else "")
        items = [i.strip() for i in rest[1:] if i.strip()]
        if action in ("dazu", "add", "neu", "auf"):
            if not items:
                print('Aufruf: einkauf dazu "<ding>"')
                return 1
            added = memory.shop_add(items)
            print(f"Auf der Einkaufsliste: {join(added)}." if added else "Stand schon auf der Liste.")
        elif action in ("weg", "gekauft", "ab", "loeschen", "löschen"):
            if not items:
                print('Aufruf: einkauf weg "<ding>"')
                return 1
            removed = memory.shop_remove(items)
            print(f"Abgehakt: {join(removed)}." if removed else "Das stand nicht auf der Liste.")
        elif action in ("leeren", "alles-gekauft"):
            memory.shop_clear()
            print("Die Einkaufsliste ist leer.")
        elif action:
            print('Aufruf: einkauf | einkauf dazu "<ding>" | einkauf weg "<ding>" | einkauf leeren')
            return 1
        listed = memory.shopping()
        print("Einkaufsliste: " + (join(listed) + "." if listed else "leer."))
        return 0

    if command in ("befehl", "befehle", "befehl-loeschen", "befehl-löschen"):
        from .memory import Memory

        memory = Memory(STATE_DIR / "gedaechtnis.json")
        if command == "befehle":
            commands = memory.custom_commands()
            if not commands:
                print("Noch keine eigenen Befehle.")
            for c in commands:
                print(f"{c['name']}: {c['aktion']}")
            return 0
        if command in ("befehl-loeschen", "befehl-löschen"):
            removed = memory.unteach(" ".join(rest))
            print(f"Befehl gelöscht: {removed['name']}" if removed else "Diesen Befehl gibt es nicht.")
            return 0 if removed else 1
        if len(rest) < 2:
            print('Aufruf: befehl "<name>" "<was jarvis dann tun soll>"')
            return 1
        try:
            saved = memory.teach(rest[0], " ".join(rest[1:]))
        except ValueError as exc:
            print(f"Fehler: {exc}")
            return 1
        print(f"Eigener Befehl gespeichert: „{saved['name']}“ = {saved['aktion']}")
        return 0

    if command in ("notiz", "bericht", "notizbuch-suchen", "notizbuch-tag", "notizbuch-netz"):
        from .notebook import Notebook, folder_from_config

        notebook = Notebook(folder_from_config(cfg), user=_user())
        if command == "notiz":
            if not rest:
                print('Aufruf: notiz "<text>" ["<titel>"]')
                return 1
            path = notebook.note(rest[0], rest[1] if len(rest) > 1 else "Schnellnotizen")
            print(f"Notiert in {path}")
            return 0
        if command == "bericht":
            if len(rest) < 2:
                print('Aufruf: bericht "<titel>" "<datei.md>"')
                return 1
            source = Path(rest[1])
            text = source.read_text(encoding="utf-8-sig") if source.exists() else " ".join(rest[1:])
            path = notebook.report(rest[0], text)
            print(f"Bericht liegt im Notizbuch: {path}")
            return 0
        if command == "notizbuch-netz":
            from .wissensnetz import network_text

            words = " ".join(rest).strip()
            if not words:
                print('Aufruf: notizbuch-netz "<titel oder wörter>"')
                return 1
            print(network_text(notebook.folder, words))
            return 0
        if command == "notizbuch-suchen":
            hits = notebook.search(" ".join(rest))
            if not hits:
                print("Nichts gefunden.")
            for name, number, line in hits:
                print(f"{name}:{number}: {line}")
            return 0
        import datetime as dt

        word = (rest[0] if rest else "heute").lower()
        today = dt.date.today()
        day = {"heute": today, "gestern": today - dt.timedelta(days=1),
               "vorgestern": today - dt.timedelta(days=2)}.get(word)
        if day is None:
            try:
                day = dt.date.fromisoformat(word)
            except ValueError:
                print("Aufruf: notizbuch-tag heute|gestern|JJJJ-MM-TT")
                return 1
        text = notebook.day_text(day)
        print(text[-12000:] if text else f"Am {day:%d.%m.%Y} steht nichts im Tagebuch.")
        return 0

    if command in ("faehigkeiten", "fähigkeiten", "faehigkeit", "fähigkeit", "faehigkeit-loeschen", "fähigkeit-löschen"):
        from .config import HOME_DIR
        from .skills import load_skills, remove_skill, save_skill

        if command in ("faehigkeiten", "fähigkeiten"):
            for skill in load_skills(HOME_DIR, STATE_DIR):
                mark = " [gelernt]" if skill.learned else ""
                print(f"{skill.name}{mark}: {skill.description}  ({skill.path})")
            return 0
        if command in ("faehigkeit-loeschen", "fähigkeit-löschen"):
            done = remove_skill(STATE_DIR, " ".join(rest))
            print("Fähigkeit gelöscht." if done else "Diese gelernte Fähigkeit gibt es nicht (mitgelieferte bleiben).")
            return 0 if done else 1
        if len(rest) < 3:
            print('Aufruf: faehigkeit "<name>" "<wann sie passt, ein Satz>" "<datei.md>"')
            return 1
        source = Path(rest[2])
        body = source.read_text(encoding="utf-8-sig") if source.exists() else " ".join(rest[2:])
        from .memory import is_secret

        if is_secret(body) and re.search(r"(?:passwort|kennwort|password|pin)\s*[:=]\s*\S+", body, re.I):
            print("Fehler: In der Anleitung steht ein Passwort. Das gehört nicht hinein.")
            return 1
        path = save_skill(STATE_DIR, rest[0], rest[1], body)
        print(f"Fähigkeit gespeichert: {path}. Sie steht ab dem nächsten Gespräch in deiner Liste.")
        return 0

    if command in ("zeitplan", "zeitplaene", "zeitpläne", "zeitplan-loeschen", "zeitplan-löschen"):
        from .zeitplan import Schedules, describe, parse_schedule

        schedules = Schedules(STATE_DIR / "zeitplaene.json")
        if command in ("zeitplaene", "zeitpläne"):
            items = schedules.all()
            if not items:
                print("Keine Zeitpläne.")
            for item in items:
                print(f"{item['id']}  {describe(item)}")
            return 0
        if command in ("zeitplan-loeschen", "zeitplan-löschen"):
            gone = schedules.remove(" ".join(rest))
            print(f"Gelöscht: {describe(gone)}" if gone else "Kein passender Zeitplan.")
            return 0 if gone else 1
        if len(rest) < 2:
            print('Aufruf: zeitplan "<wann>" "<befehl>", z. B. zeitplan "werktags um 18 Uhr" "Öffne Discord"')
            return 1
        # Gesprochen ist "am Wochenende" auch ein Termin, hier hat Claude schon "regelmäßig" gewählt
        when = re.sub(r"^\s*am\s+wochenende\b", "jedes Wochenende", rest[0], flags=re.I)
        parsed = parse_schedule(f"{when} {' '.join(rest[1:])}")
        if parsed is None:
            print('Fehler: Zeit nicht verstanden. Beispiele: "jeden Morgen um 8", "werktags um 18 Uhr", '
                  '"montags und donnerstags um 17:30", "am Wochenende um 10".')
            return 1
        item = schedules.add(*parsed)
        print(f"Zeitplan eingerichtet: {describe(item)}")
        return 0

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

    if command in ("nachricht", "nachrichten", "message"):
        from . import messaging

        if len(rest) < 3:
            print('Aufruf: nachricht <discord|telegram|whatsapp> "<person>" "<text>"')
            return 1
        try:
            print(messaging.send(rest[0], rest[1], " ".join(rest[2:])))
            return 0
        except messaging.MessagingError as exc:
            print(f"Nicht gesendet: {exc}")
            return 1

    if command == "discord":
        from . import messaging

        action = rest[0].lower() if rest else ""
        name = " ".join(rest[1:])
        kinds = {"chat": "person", "person": "person", "kanal": "channel", "channel": "channel",
                 "server": "server", "sprachkanal": "voice", "voice": "voice"}
        try:
            if action in ("stumm", "mute"):
                messaging.discord_key("mute")
                print("Discord-Mikrofon umgeschaltet.")
            elif action in ("taub", "deafen"):
                messaging.discord_key("deafen")
                print("Discord-Ton umgeschaltet.")
            elif action in ("anrufen", "call") and name:
                print(f"Anruf an {messaging.discord_call(name)} gestartet.")
            elif action in kinds and name:
                print(f"{messaging.discord_open(name, kinds[action])} ist offen.")
            else:
                print('Aufruf: discord chat|kanal|server|sprachkanal|anrufen "<name>" oder discord stumm|taub')
                return 1
            return 0
        except messaging.MessagingError as exc:
            print(f"Nicht geklappt: {exc}")
            return 1

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
        from . import screen

        # Im Temp-Ordner, damit Bildschirmfotos nicht in OneDrive landen. Klein: Claude liest es schneller.
        window = bool(rest and rest[0].lower() in ("fenster", "window"))
        path = screen.capture(Path(tempfile.gettempdir()) / "jarvis-bildschirm.jpg", window=window)
        print(f"Bildschirmfoto gespeichert: {path} (mit dem Read-Werkzeug ansehen)")
        return 0

    if command in ("bildschirm-text", "lesen"):
        from . import screen

        lines = screen.read_text(window=bool(rest and rest[0].lower() in ("fenster", "window")))
        print(screen.as_text(lines) if lines else "Kein Text erkannt.")
        return 0

    if command == "fenster":
        from . import screen

        for row in screen.windows():
            print(f"{row.get('titel', '')}  [{row.get('programm', '')}]")
        return 0

    if command in ("ui", "ui-klick", "ui-schreiben"):
        from . import screen

        if not rest:
            print('Aufruf: ui "<fenster>" | ui-klick "<fenster>" "<knopf>" | ui-schreiben "<fenster>" "<feld>" "<text>"')
            return 1
        if command == "ui":
            for row in screen.elements(rest[0]):
                print(f"{row.get('art', '')}: {row.get('name', '')}{'' if row.get('an', True) else ' (aus)'}")
            return 0
        if command == "ui-klick" and len(rest) >= 2:
            print(screen.click(rest[0], " ".join(rest[1:])))
            return 0
        if command == "ui-schreiben" and len(rest) >= 3:
            print(screen.type_into(rest[0], rest[1], " ".join(rest[2:])))
            return 0
        print("Zu wenige Angaben.")
        return 1

    power = {"herunterfahren": "shutdown", "ausschalten": "shutdown", "neustarten": "restart", "neustart": "restart",
             "energiesparen": "sleep", "standby": "sleep", "ruhezustand": "hibernate", "abmelden": "logoff"}
    if command in power:
        from . import pc

        action = power[command]
        if not (full_permission(cfg) or confirmed()):
            return need_confirmation({"shutdown": "den PC herunterfahren", "restart": "den PC neu starten",
                                      "sleep": "den PC in den Energiesparmodus schicken",
                                      "hibernate": "den PC in den Ruhezustand schicken",
                                      "logoff": f"{_user()} abmelden"}[action])
        delay = int(rest[0]) if rest and rest[0].isdigit() else (15 if action in ("shutdown", "restart") else 5)
        print(pc.power(action, delay) + f" {_user()} kann bis dahin 'Jarvis, abbrechen' sagen.")
        return 0

    if command in ("herunterfahren-abbrechen", "abbrechen"):
        from . import pc

        print("Aufgehalten, der PC bleibt an." if pc.power_abort() else "Es war nichts geplant.")
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
        if not (full_permission(cfg) or confirmed()):
            return need_confirmation(f"{rest[0]} in den Papierkorb verschieben")
        print(pc.to_recycle_bin(" ".join(rest)))
        return 0

    if command in ("installieren", "installiere", "install"):
        from . import pc

        if not rest:
            print('Aufruf: installieren "<name oder winget-id>", die ID findest du mit: winget search <name>')
            return 1
        print(pc.install(" ".join(rest)))
        return 0

    if command in ("deinstallieren", "deinstalliere", "uninstall"):
        from . import apps

        if not rest:
            print("Aufruf: deinstallieren <winget-id>")
            return 1
        if not (full_permission(cfg) or confirmed()):
            return need_confirmation(f"{rest[0]} deinstallieren")
        print(apps.uninstall(" ".join(rest)))
        return 0

    if command in ("oeffnen", "öffnen", "starten", "open"):
        from . import apps

        if not rest:
            print('Aufruf: oeffnen "<name>"')
            return 1
        try:
            print(apps.open_app(" ".join(rest)))
        except apps.AppNotFound as exc:
            print(f"{exc} Mit 'python -m jarvis.tool programme <teil des namens>' siehst du, was es gibt.")
            return 1
        return 0

    if command in ("schliessen", "schließen", "beenden", "close"):
        from . import apps

        if not rest:
            print('Aufruf: schliessen "<name>"')
            return 1
        print(apps.close_app(" ".join(rest)))
        return 0

    if command in ("programme", "apps"):
        from . import apps

        wanted = apps.normalize(" ".join(rest))
        rows = [(name, app_id) for name, app_id in apps.START_MENU.apps() if wanted in apps.normalize(name)]
        if not rows:
            print("Nichts Passendes im Startmenü.")
        for name, app_id in rows[:80]:
            print(f"{name}  [{app_id}]")
        return 0

    if command == "admin":
        from . import pc

        if not rest:
            print('Aufruf: admin "<PowerShell-Befehl>"')
            return 1
        line = " ".join(rest)
        # Endgültiges Löschen und Formatieren fragt Jarvis auch mit voller Freigabe einmal nach.
        if pc.needs_confirmation(line) and not confirmed():
            return need_confirmation(f"das mit Administratorrechten ausführen ({line[:80]})")
        print(pc.run_admin(line))
        return 0

    if command in ("alexa-sagen", "alexa", "ansage"):
        from .homeassistant import HomeAssistant

        if len(rest) < 2:
            print('Aufruf: alexa-sagen <raum> "<text>"')
            return 1
        print(HomeAssistant(cfg.get("homeassistant", {})).announce(rest[0], " ".join(rest[1:])))
        return 0

    if command == "wol-vorbereiten":
        from . import pc

        print(pc.prepare_wake_on_lan())
        print("Im BIOS muss 'Wake on LAN' (oder 'Power On By PCI-E') ebenfalls eingeschaltet sein.")
        return 0

    if command == "wecken":
        from . import pc

        if not rest:
            print("Aufruf: wecken <mac-adresse>")
            return 1
        print(pc.wake(rest[0]))
        return 0

    if command == "alexa-befehl":
        from .homeassistant import HomeAssistant

        if len(rest) < 2:
            print('Aufruf: alexa-befehl <raum> "<text>"')
            return 1
        print(HomeAssistant(cfg.get("homeassistant", {})).alexa_command(rest[0], " ".join(rest[1:])))
        return 0

    if command == "licht":
        from .homeassistant import HomeAssistant

        if not rest or rest[0] not in ("an", "aus", "ein"):
            print("Aufruf: licht an|aus [raum] [prozent]")
            return 1
        pct = int(rest[-1]) if len(rest) > 1 and rest[-1].isdigit() else None
        room = " ".join(r for r in rest[1:] if not r.isdigit())
        print(HomeAssistant(cfg.get("homeassistant", {})).light(room, rest[0] != "aus", pct))
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
