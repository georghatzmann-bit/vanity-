# Jarvis in 5 Schritten

Diese Anleitung ist für dich, Georg. Du brauchst nur Doppelklicks.

## 1. Neue Version holen

1. Falls Jarvis läuft: Fenster schließen.
2. Diese ZIP-Datei laden: https://github.com/georghatzmann-bit/vanity-/archive/refs/heads/claude/project-thread-0revfw.zip
3. Am besten bekommt Jarvis einen eigenen Ordner außerhalb von OneDrive, zum Beispiel `C:\Jarvis`. Öffne die ZIP, darin ist ein Ordner. Öffne ihn, markiere alles (Strg+A), kopiere es (Strg+C) und füge es in `C:\Jarvis` ein (Strg+V). Fragt Windows nach: "Dateien im Ziel ersetzen".
4. Kopier deine alte `config.toml` aus dem bisherigen Jarvis-Ordner mit nach `C:\Jarvis`. Dann bleibt dein Mikrofon eingestellt.

## 2. Einrichten

Doppelklick auf **`setup.bat`**. Das installiert alles Neue (Oberfläche, Tray-Icon und so weiter). Beim ersten Mal dauert es ein paar Minuten. Die großen Programmdateien legt es unter `%LOCALAPPDATA%\Jarvis` ab, damit OneDrive sie nicht hochlädt.

## 3. Mikrofon wählen (nur einmal)

Doppelklick auf **`mikrofon.bat`**, die Nummer deines Mikrofons eintippen, kurz reinsprechen, Enter.

## 4. Selbsttest

Doppelklick auf **`selbsttest.bat`**. Jarvis prüft alles: Lautsprecher, Stimme, Mikrofon (sprich dabei kurz), Spracherkennung, die ganze Kette mit einer Computerstimme und ob Claude antwortet.

- Überall `[ OK ]`: perfekt.
- Steht irgendwo `[FEHLER]`: Darunter steht mit `->`, was zu tun ist.
- Kommst du nicht weiter: Schick den Inhalt von `logs\selbsttest.txt` an Claude im Jarvis-Projekt.

## 5. Starten

Doppelklick auf **`start.bat`**. Es öffnet sich das Jarvis-Fenster mit dem Arc Reactor. Dann:

- **"Hey Jarvis"** sagen (englisch ausgesprochen), auf den Ton warten, Befehl auf Deutsch sprechen.
- Oder unten im Fenster **tippen** und Enter drücken.
- **Strg+Alt+M** schaltet das Mikrofon stumm und wieder an, egal welches Fenster vorne ist. Das geht auch mit dem Mikrofon-Knopf im Fenster.
- **"Hey Jarvis, Stopp"** oder der Stopp-Knopf unterbricht Jarvis, auch mitten im Satz.

## Was du sagen kannst

- "Wie spät ist es?", "Welcher Tag ist heute?" (antwortet sofort, ohne Claude)
- "Mach die Musik leiser", "Nächstes Lied", "Musik pausieren"
- "Öffne YouTube", "Starte Spotify"
- "Wie wird das Wetter morgen?"
- "Erinnere mich in 20 Minuten an den Tee"
- "Was steht gerade auf meinem Bildschirm?"
- "Gaming-Modus an"
- "Guten Morgen" (kurzes Briefing mit Wetter, Erinnerungen und Schlagzeilen)
- "Lösch die Datei alt.txt auf dem Desktop": Jarvis fragt erst nach und legt sie nach deinem "Ja" in den Papierkorb.
- "Neue Unterhaltung" (Jarvis vergisst das bisherige Gespräch)

## Was du selbst noch erledigen musst

Nur das, was der Selbsttest anmeckert, plus die Dinge, die du haben willst:

1. **Wohnort eintragen** (für das Wetter): `config.toml` mit dem Editor öffnen, ganz oben bei `[ich]` zum Beispiel `ort = "Wien"` eintragen.
2. **Mikrofon-Zugriff**, falls der Selbsttest "absolute Stille" meldet: Windows-Einstellungen > Datenschutz und Sicherheit > Mikrofon > "Desktop-Apps den Zugriff auf das Mikrofon erlauben" einschalten.
3. **WebView2**, falls der Selbsttest sagt, dass es fehlt: https://developer.microsoft.com/microsoft-edge/webview2/ (dort den "Evergreen Bootstrapper" laden und starten). Bei Windows 11 ist es normalerweise schon da.
4. **Mit Windows starten** (optional): Doppelklick auf `autostart-an.bat`. Ausschalten mit `autostart-aus.bat`.
5. **Gaming-Modus** (optional): In `config.toml` unter `[gaming]` eintragen, welche Programme dabei zugehen sollen, zum Beispiel `close_apps = ["OneDrive", "Teams"]`.
6. **Alexa** (optional): siehe unten.

Ein Tipp: Liegt Jarvis noch in OneDrive oder in einem Ordner namens `.claude`, meldet der Selbsttest das als Warnung. Es funktioniert trotzdem, ein eigener Ordner wie `C:\Jarvis` ist aber schneller und macht weniger Ärger.

## Alexa einrichten (optional)

Jarvis spricht über Home Assistant mit deinen Echos. Das kostet nichts, braucht aber einmal etwas Einrichtung:

1. **Home Assistant** installieren, zum Beispiel auf einem Raspberry Pi: https://www.home-assistant.io/installation/
2. In Home Assistant **HACS** installieren und darüber **"Alexa Media Player"**. Dann mit deinem Amazon-Konto anmelden. Deine Echos erscheinen als `media_player.echo_...`.
3. In Home Assistant unten links auf deinen Namen > **Sicherheit** > **Langlebige Zugriffstoken** > Token erstellen und kopieren.
4. In `config.toml` eintragen:
   ```toml
   [homeassistant]
   url = "http://homeassistant.local:8123"
   token = "HIER DEN LANGEN TOKEN EINFÜGEN"

   [homeassistant.alexa]
   wohnzimmer = "media_player.echo_wohnzimmer"
   kueche = "media_player.echo_dot_kueche"
   ```
5. `selbsttest.bat` starten. Bei "Home Assistant / Alexa" sollte `[ OK ]` stehen.
6. Ausprobieren: "Hey Jarvis, sag im Wohnzimmer Bescheid, dass das Essen fertig ist." oder "Schalte das Wohnzimmerlicht an."

**Umgekehrt, Alexa sagt Jarvis etwas** (für Fortgeschrittene): In `config.toml` unter `[server]` `enabled = true` und ein langes `token` setzen. In Home Assistant in `configuration.yaml`:

```yaml
rest_command:
  jarvis:
    url: "http://DEIN-PC-NAME:8765/befehl"
    method: POST
    headers:
      Authorization: "Bearer DEIN-SERVER-TOKEN"
    content_type: "application/json"
    payload: '{"text": "{{ text }}", "alexa": "{{ raum }}"}'
```

Dann kann eine Home-Assistant-Automation oder ein Skript zum Beispiel `rest_command.jarvis` mit `text: "Gaming-Modus an"` aufrufen. Jarvis erledigt es auf dem PC und antwortet, wenn `raum` gesetzt ist, über das Echo in diesem Raum. Beim ersten Start fragt die Windows-Firewall, ob Jarvis im Heimnetz erreichbar sein darf: "Private Netzwerke" erlauben.

## Wenn etwas nicht klappt

- **Jarvis reagiert nicht auf "Hey Jarvis":** `start.bat --mic-test` zeigt den Pegel und wie gut "Hey Jarvis" erkannt wird. Mehr dazu in der README.
- **Claude lehnt ab:** Jarvis probiert automatisch andere Modelle und zuletzt einen einfachen Modus. Hilft das nicht, `start.bat --claude-test` starten und die Tabelle an Claude im Jarvis-Projekt schicken.
- **"Jarvis läuft schon":** Jarvis ist schon offen, oft versteckt als Symbol unten rechts neben der Uhr. Dort mit Rechtsklick beenden oder das Fenster öffnen.
- **Mikrofon abgesteckt:** Jarvis merkt das und versucht es alle paar Sekunden wieder. Steckst du es wieder ein, hört er von selbst weiter zu.
- **Irgendwas anderes:** In `logs\jarvis.log` steht genau, was passiert ist. Die Datei kannst du Claude schicken.
