# Jarvis

Dein eigener J.A.R.V.I.S. für Windows: Du sagst „Hey Jarvis“ oder drückst Strg + Alt + J, sprichst deinen Befehl, und Jarvis erledigt ihn auf deinem PC. Er antwortet wie der Butler aus Iron Man, mit einer menschlichen Stimme, lernt deine Gewohnheiten und ist auch über Handy, Alexa und Discord erreichbar. Er läuft unsichtbar im Hintergrund, mit einer kleinen Anzeige oben am Bildschirm und einem großen HUD-Fenster auf Wunsch.

**Schnellstart:** [JarvisSetup.exe](https://github.com/georghatzmann-bit/vanity-/releases/latest/download/JarvisSetup.exe) laden, doppelklicken, die Einrichtung durchklicken. Klappt auch auf einem leeren PC: Python, Spracherkennung, Stimmen und Claude Code holt der Installer selbst. Schritt für Schritt in der [ANLEITUNG.md](ANLEITUNG.md).

![Das Jarvis-Fenster](docs/bilder/hauptfenster.jpg)

```
Mikrofon → "Hey Jarvis" (openWakeWord, lokal), "Jarvis" (Porcupine, gratis Schlüssel) oder Strg+Alt+J
Handy    → eigene Web-App im WLAN (QR-Code), Alexa → eigener Skill über ntfy.sh (verschlüsselt)
         → Satzende per Silero VAD (lokal)
         → Sprache zu Text: Groq Whisper large-v3-turbo (gratis Schlüssel), Ersatz faster-whisper lokal
         → Sofort-Befehle direkt: Programme, Webseiten, Chatnachrichten, Discord ohne Maus, Erinnerungen,
           Herunterfahren, Licht, Gedächtnis, Werkstatt-Projekte, Lautstärke, Musik, Uhrzeit
         → Bauaufträge ("Bau mir …"): Werkstatt mit eigenem Claude-Prozess (Opus/Sonnet) und Projektordner
         → alles andere: Claude Code (dein Claude-Pro-Abo), läuft dauerhaft, Antwort wird gestreamt
         → Stimme: ElevenLabs (Premium, Streaming), Ersatz Microsoft Neural (gratis), offline Piper
         → Anzeige oben am Bildschirm, HUD-Fenster, Tray-Symbol, Handy-App, Alexa
```

## Was Jarvis kann

- **Immer da, nie im Weg:** Autostart unsichtbar (nur das Symbol neben der Uhr). Beim Weckwort erscheint das Fenster ganz vorn, ohne den Fokus zu stehlen, und verschwindet nach dem Gespräch wieder. Bei Vollbild-Spielen und im Gaming-Modus bleibt es weg.
- **Wie Jarvis aus dem Film:** kurz, ruhig, trockener britischer Humor, kein „Als KI …“. Für dich ist er einfach Jarvis, Claude bleibt unsichtbar.
- **Volle Freigabe:** Jarvis installiert, deinstalliert, räumt in den Papierkorb, führt Administrator-Befehle aus (Windows fragt einmal), fährt herunter und startet neu, ohne nachzufragen. Herunterfahren hat 15 Sekunden Vorlauf, „Stopp“ hält es auf. Nur vor Käufen und vor Nachrichten, deren Inhalt du nicht selbst gesagt hast, fragt er. Abschaltbar in der Einrichtung (`[rechte] volle_freigabe`).
- **Sofort-Befehle ohne Claude** (unter einer Sekunde): „Was kannst du?“, „Öffne Spotify“, „Schließ Discord“, „Installier mir Steam“, „Geh auf Reddit“, „Spiel Thunderstruck“, „Dunkelmodus an“, „Wie wird das Wetter morgen?“, „Was ist 15 mal 23?“, „Fahr den PC herunter“, „Gute Nacht“ (bietet das Herunterfahren an), „Weck mich um 7“, „Mach einen Screenshot“, „Minimiere alles“, „Wie viel Speicher ist frei?“, „Mach das Licht im Wohnzimmer an“, Lautstärke, Musik, Erinnerungen, Timer, mehrere Befehle auf einmal.
- **Discord ohne Maus:** „Schreib Max auf Discord, bin gleich da“, „Geh in den Sprachkanal Zocken“, „Ruf Max auf Discord an“, „Discord stumm“. Jarvis nutzt Discords Schnellsuche und Tastenkürzel, prüft am Fenstertitel, ob er richtig gelandet ist, versucht es bei einer Störung (Maus bewegt, anderes Fenster vorn) von selbst noch zweimal und bringt dich danach zurück ins Spiel. Auch WhatsApp und Telegram.
- **Discord-Server gestalten im Hintergrund:** Jarvis' eigener Bot legt Kanäle, Rollen, Regeln und Begrüßung an, über die offizielle Discord-Schnittstelle, ohne dein Spiel zu stören.
- **Lernt dich kennen:** „Merk dir, …“, Kontakte mit ihrer App („Sag Max …“), Gewohnheiten auch mit Discord-Sprachkanal („Sir, um diese Zeit öffnen Sie meist Discord und Spotify. Soll ich?“), Geburtstage mit Angebot zu gratulieren, jede Nacht ein kurzer Rückblick auf die Gespräche. Alles bleibt lokal (`daten\gedaechtnis.json`) und ist im Fenster einsehbar.
- **Handy-App:** im WLAN per QR-Code koppeln, dann schreiben, diktieren, Schnellaktionen, Vorschläge beantworten und die Werkstatt verfolgen. Von unterwegs mit Tailscale. Dazu Wake-on-LAN: den PC per Handy einschalten, und Benachrichtigungen über die App ntfy: Erinnerungen und „Aus der Werkstatt“ kommen aufs Handy, wenn du nicht am PC sitzt.
- **Alexa:** „Alexa, sag Jarvis, er soll Discord öffnen.“ Ein eigener Skill (Von Alexa gehostet), den Jarvis fertig zum Kopieren anbietet. Die Nachrichten laufen verschlüsselt über ntfy.sh, ohne Home Assistant und ohne Router-Einstellungen. Mit Home Assistant zusätzlich Ansagen auf Echos und Licht.
- **Bildschirm lesen und Programme ohne Maus bedienen:** Texterkennung von Windows (in etwa einer Sekunde) und UI Automation: Knöpfe drücken und Felder ausfüllen, ohne Maus und Tastatur zu nehmen.
- **Werkstatt für Programmier-Aufträge:** „Bau mir einen Discord-Bot, der …“ läuft im Hintergrund in einem eigenen Projektordner, mit Plan, Tests, `LIESMICH.txt` und `start.bat`. Große Aufträge mit Opus, kleine mit Sonnet. Das Fenster zeigt alles als Blaupause und alle Projekte als Übersicht mit Starten und Weiterbauen.
- **Gaming-Modus:** Energieplan Höchstleistung, ausgewählte Programme zu, Jarvis selbst mit niedriger Priorität und ohne Einblendungen, keine Vorschläge.
- **Schnell:** Claude läuft dauerhaft im Hintergrund (keine Startzeit pro Frage), der erste Satz wird gesprochen, während Claude noch schreibt, ElevenLabs beginnt nach 0,25 s zu sprechen.
- **Grafische Einrichtung** und ein **Installer im Jarvis-Look**, Selbsttest (`werkzeuge\Selbsttest.bat`) und Protokoll (`logs\jarvis.log`).

| Werkstatt-Projekte | Handy-App |
|---|---|
| ![Werkstatt: alle Projekte](docs/bilder/projekte.jpg) | ![Jarvis auf dem Handy](docs/bilder/handy.jpg) |

| Verbinden: Handy, Alexa, Discord | Gedächtnis |
|---|---|
| ![Verbinden](docs/bilder/verbinden.jpg) | ![Gedächtnis](docs/bilder/gedaechtnis.jpg) |

## Kosten

- **Claude-Pro-Abo:** das Gehirn.
- **Groq:** gratis (großzügiges Tageslimit, darüber übernimmt der eigene PC).
- **ElevenLabs:** optional. Gratis-Konto mit 10.000 Credits im Monat und einer selbst entworfenen Stimme. Fertige Stimmen ab Starter (etwa 6 $ im Monat). Ohne Schlüssel spricht die gratis Microsoft-Stimme.
- **Alexa-Skill, ntfy.sh, Discord-Bot, Tailscale:** gratis.

## Anpassen

Das Wichtigste stellst du in der Einrichtung und im Fenster unter „Verbinden“ ein. Alles steht in `config.toml` (Vorlage mit Erklärungen: `config.example.toml`):

- `[stt]` `groq_key`, `engine = "auto" | "groq" | "lokal"`
- `[tts]` `engine = "elevenlabs" | "edge" | "windows"`, `elevenlabs_key`, `elevenlabs_voice`
- `[mute]` `hotkey` (Stumm), `listen_hotkey` (Zuhören, Standard Strg+Alt+J)
- `[listen]` `silence_seconds`, `vad`; `[wakeword]` `picovoice_key` (dann reicht „Jarvis“)
- `[rechte]` `volle_freigabe`; `[gedaechtnis]` `vorschlaege`
- `[gui]` `start_hidden`, `close_to_tray`, `overlay`, `on_wake`
- `[brain]` `models`, `effort`, `disallowed_tools`, `timeout_seconds`
- `[werkstatt]` `ordner`, `modell = "auto" | "opus" | "sonnet"`, `effort`
- `[server]` Handy-App, `[handy]` Benachrichtigungen (ntfy), `[alexa]` Skill, `[discord]` `bot_token`, `[homeassistant]` Echos und Licht
- `[gaming]` `close_apps`, `power_plan`
- `jarvis_home/CLAUDE.md`: Jarvis' Persönlichkeit und seine Befehle

Ältere `config.toml` werden beim Start einmalig angepasst (`[intern] config_version`).

## Jarvis-Befehle für Claude

```
oeffnen "<name>"   schliessen "<name>"   programme [filter]   installieren "<name|winget-id>"
deinstallieren <id>   papierkorb "<pfad>"   admin "<PowerShell-Befehl>"
nachricht <discord|whatsapp|telegram> "<person|#kanal>" "<text>"
discord chat|kanal|server|sprachkanal|anrufen "<name>"   discord stumm|taub
discord-bot status|struktur|plan|kanal|rolle|nachricht|einladung|kanal-loeschen
werkstatt "<auftrag>"   werkstatt-weiter "<wunsch>"   werkstatt-projekt "<name>" "<wunsch>"   werkstatt-projekte
merken "<fakt>"   vergessen "<wörter>"   gedaechtnis
erinnern "in 20 minuten" "Tee"   erinnerungen   erinnerung-loeschen <id>
bildschirm [fenster]   bildschirm-text [fenster]   fenster   ui "<fenster>"   ui-klick   ui-schreiben
herunterfahren|neustarten [sekunden]   energiesparen|ruhezustand|abmelden   herunterfahren-abbrechen
medien pause|weiter|naechstes|voriges   lautstaerke 30|lauter|leiser|stumm   gaming an|aus
alexa-sagen <raum> "<text>"   alexa-befehl <raum> "<text>"   licht an|aus [raum] [prozent]
wol-vorbereiten   wecken <mac>   smarthome geraete|an|aus|status
```

Zum Ausprobieren im Jarvis-Ordner: `"%LOCALAPPDATA%\Jarvis\venv\Scripts\python.exe" -m jarvis.tool hilfe`

## Sicherheit

- Endgültig löschen, formatieren und die Registry ausräumen sind für Claude gesperrt (`disallowed_tools`). Dateien gehen nur in den Papierkorb. Ganze Laufwerke, dein Benutzerordner sowie Desktop, Dokumente und Downloads selbst kommen nie hinein.
- Ohne volle Freigabe tun `papierkorb`, `deinstallieren` und Herunterfahren erst nach deinem „Ja“ etwas. `admin`-Befehle, die endgültig löschen oder formatieren, fragen immer, auch mit voller Freigabe.
- Die Handy-App braucht einen langen Schlüssel (steht im QR-Code), „Neu koppeln“ sperrt alte Handys aus. Der Alexa-Weg ist mit einem eigenen Schlüssel verschlüsselt und signiert, alte oder doppelte Nachrichten werden verworfen. Der Discord-Token bleibt auf deinem PC.
- Wake Word und Satzende laufen lokal. An Groq geht nur die Aufnahme nach „Hey Jarvis“, an Claude nur der erkannte Text. Das Gedächtnis bleibt auf deinem PC.

## Windows-Details

- Installiert nach `%LOCALAPPDATA%\Programs\Jarvis`, die Python-Umgebung liegt unter `%LOCALAPPDATA%\Jarvis\venv`. Fehlt Python, holt der Installer es (winget, sonst python.org), ebenso Claude Code, die Microsoft-Laufzeit und WebView2.
- Start über `pythonw.exe Jarvis.pyw`: kein Konsolenfenster, eigenes Symbol, eigene Taskleisten-Gruppe (`Jarvis.Assistent`). Autostart über `HKCU\...\Run` mit `--hintergrund`.
- Es läuft immer nur ein Jarvis. Ein zweiter Start holt das Fenster des laufenden nach vorn.
- Der Build (`.github/workflows/setup-exe.yml`) installiert die EXE auf einem frischen Windows still zur Probe, prüft Startmenü-Suche, Anzeige, Texterkennung, Bedienung ohne Maus, unsichtbaren Start, zweiten Start, ein Update über ein laufendes Jarvis und die Deinstallation, und veröffentlicht sie dann als Release.
- Ein Update beendet ein laufendes Jarvis selbst, Einstellungen (`config.toml`) und Gedächtnis (`daten\`) bleiben. Tray-Menü > „Neueste Version laden“ holt die neueste `JarvisSetup.exe`.

## Für Entwickler

```
jarvis/
  __main__.py     Start, Modi (Fenster, Hintergrund, Konsole, Text, Tests), Dienste (Handy, Alexa, Vorschläge)
  assistant.py    Kern: Befehl annehmen, Sofort-Befehle, Claude fragen, sprechen, Gedächtnis, Rechte
  brain.py        Claude Code dauerhaft (stream-json), Modell-Fallback, Fehlerarten, Gedächtnis im Gespräch
  intents.py      Sofort-Befehle erkennen (ohne Claude)
  memory.py       Gedächtnis: Fakten, Kontakte, Gewohnheiten, Vorschläge, nächtlicher Rückblick
  steps.py        Arbeitsschritte: aus Claudes Werkzeugen wird "Installiert Spotify"
  workshop.py     Werkstatt: Bauaufträge im Hintergrund, Projekte, Opus/Sonnet
  messaging.py keys.py       Chatnachrichten und Discord ohne Maus (Tastatur, Fenstertitel, Wiederholung)
  discord_bot.py  Jarvis' Discord-Bot (REST): Server gestalten im Hintergrund
  screen.py       Bildschirmfoto, Texterkennung, UI Automation
  remote.py server.py        Handy-App: Verlauf, Zustand, QR-Code, Web-Eingang
  push.py         Benachrichtigungen aufs Handy (ntfy)
  alexa.py alexa_skill.py    Alexa: Brücke über ntfy.sh und der Skill-Code
  presence.py     Fenster beim Weckwort zeigen und danach wieder verstecken
  apps.py         Programme: Startmenü-Index, bekannte Apps, winget, Schließen
  voice.py audio.py stt.py   Sprachschleife, Mikrofon, Silero VAD, Groq und faster-whisper
  tts.py elevenlabs.py       Stimme: ElevenLabs-Streaming, Microsoft, Piper, Windows
  overlay.py desktop.py tray.py autostart.py pc.py homeassistant.py persona.py reminders.py tool.py
  gui/app.py      Fenster (pywebview), Api für die Seite, Ereignis-Brücke
  gui/web/        index.html app.js style.css     HUD-Fenster (Kern als Canvas)
                  werkstatt.js projekte.js werkstatt.css   Werkstatt als Blaupause, Projekt-Übersicht
                  koppeln.js gedaechtnis.js       Verbinden (Handy, Alexa, Discord), Gedächtnis
                  setup.html setup.js setup.css   Einrichtung (Api: setup_wizard.SetupApi)
                  handy/          die Handy-App (PWA)
                  Alle Seiten laufen auch im normalen Browser als Demo.
jarvis_home/CLAUDE.md   Jarvis' Persönlichkeit
installer/      Inno-Setup-Skript, Bilder und Windows-Proben für den Build
tests/          python -m unittest discover -s tests
```

Die Tests laufen ohne Mikrofon, ohne echtes Claude und ohne Internet (nachgebautes `claude`, ElevenLabs, Groq, Discord und ntfy).
