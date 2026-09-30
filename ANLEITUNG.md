# Jarvis in 3 Schritten

Diese Anleitung ist für dich, Georg. Du brauchst nur einen Doppelklick.

## 1. Jarvis holen

1. Falls Jarvis läuft: Fenster schließen (oder unten rechts neben der Uhr auf das Jarvis-Symbol, Rechtsklick, Beenden).
2. Diese ZIP-Datei laden: https://github.com/georghatzmann-bit/vanity-/archive/refs/heads/claude/project-thread-0revfw.zip
3. Tipp, damit Windows nicht bei jeder Datei nachfragt: Rechtsklick auf die ZIP > Eigenschaften > unten Haken bei **"Zulassen"** > OK.
4. Jarvis bekommt am besten einen eigenen Ordner außerhalb von OneDrive, zum Beispiel `C:\Jarvis`. Öffne die ZIP, darin ist ein Ordner. Öffne ihn, markiere alles (Strg+A), kopiere es (Strg+C) und füge es in `C:\Jarvis` ein (Strg+V). Fragt Windows nach: "Dateien im Ziel ersetzen".
5. Hattest du Jarvis schon woanders: Kopier deine alte `config.toml` mit nach `C:\Jarvis`. Dann sind deine Einstellungen gleich wieder da.

## 2. Doppelklick auf `Jarvis.bat`

Beim ersten Mal installiert Jarvis alles, was er braucht. Das dauert ein paar Minuten, ein Fenster zeigt dir, was gerade passiert. Fehlt Python, fragt er, ob er es installieren soll: einfach Enter drücken.

Fragt Windows nach, weil die Datei aus dem Internet kommt: Beim blauen Fenster "Der Computer wurde durch Windows geschützt" auf **"Weitere Informationen"** und dann **"Trotzdem ausführen"** klicken, bei "Sicherheitswarnung" auf **"Ausführen"**. Das kommt nur beim ersten Mal (und gar nicht, wenn du bei der ZIP "Zulassen" angehakt hast).

Danach liegt ein **Jarvis-Symbol auf dem Desktop** (und im Startmenü). Ab jetzt startest du Jarvis nur noch damit.

## 3. Die Einrichtung

Beim ersten Start öffnet sich die Einrichtung von selbst. Sie führt dich durch alles, du klickst nur:

1. **Mikrofon:** Mikrofon anklicken, reinsprechen, der Balken zeigt den Pegel. Sag "Hey Jarvis" (englisch ausgesprochen), dann leuchtet es auf. Ganz oben steht "Windows-Standard" und darunter, welches Mikrofon das gerade ist. Ist es das falsche, klick einfach dein richtiges an. "Aktuell" zeigt, welches Jarvis nimmt.
2. **Stimme:** Stimmen anhören und die schönste nehmen.
3. **Wohnort:** für das Wetter.
4. **Claude:** Jarvis prüft, ob Claude antwortet. Fehlt Claude Code oder bist du nicht angemeldet, gibt es dafür einen Knopf.
5. **Extras** (alles optional): Stumm-Taste, mit Windows starten, Alexa.

Danach startet das Jarvis-Fenster. Die Einrichtung kannst du jederzeit über **Einstellungen** (oben rechts im Jarvis-Fenster) wieder öffnen.

## So benutzt du Jarvis

- **"Hey Jarvis"** sagen (englisch ausgesprochen), auf den Ton warten, Befehl auf Deutsch sprechen.
- Oder auf den **Kreis** in der Mitte klicken: Dann hört Jarvis sofort zu, ganz ohne "Hey Jarvis".
- Oder unten im Fenster **tippen** und Enter drücken. Solange der Verlauf leer ist, stehen dort Beispiele zum Anklicken.
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

## Was du vielleicht noch willst

1. **Mikrofon-Zugriff**, falls die Einrichtung sagt, dass nur Stille ankommt: Windows-Einstellungen > Datenschutz und Sicherheit > Mikrofon > "Desktop-Apps den Zugriff auf das Mikrofon erlauben" einschalten.
2. **WebView2**, falls statt des Fensters eine Meldung kommt, dass es fehlt: https://developer.microsoft.com/microsoft-edge/webview2/ (dort den "Evergreen Bootstrapper" laden und starten). Bei Windows 11 ist es normalerweise schon da.
3. **Gaming-Modus** (optional): In `config.toml` unter `[gaming]` eintragen, welche Programme dabei zugehen sollen, zum Beispiel `close_apps = ["OneDrive", "Teams"]`.
4. **Alexa** (optional): siehe unten.

Im Ordner `werkzeuge` liegen kleine Helfer für Sonderfälle (Selbsttest, Mikrofon-Test, Claude-Test, Neu installieren). Was sie machen, steht in `werkzeuge\LIESMICH.txt`.

## Alexa einrichten (optional)

Jarvis spricht über Home Assistant mit deinen Echos. Das kostet nichts, braucht aber einmal etwas Einrichtung:

1. **Home Assistant** installieren, zum Beispiel auf einem Raspberry Pi: https://www.home-assistant.io/installation/
2. In Home Assistant **HACS** installieren und darüber **"Alexa Media Player"**. Dann mit deinem Amazon-Konto anmelden. Deine Echos erscheinen als `media_player.echo_...`.
3. In Home Assistant unten links auf deinen Namen > **Sicherheit** > **Langlebige Zugriffstoken** > Token erstellen und kopieren.
4. In der Jarvis-Einrichtung (Einstellungen oben rechts) bei **Extras > Alexa** die Adresse (zum Beispiel `http://homeassistant.local:8123`) und den Token einfügen und auf **Verbindung testen** klicken. Jarvis findet deine Echos, du gibst jedem einen Raum (zum Beispiel "wohnzimmer").
5. Ausprobieren: "Hey Jarvis, sag im Wohnzimmer Bescheid, dass das Essen fertig ist." oder "Schalte das Wohnzimmerlicht an."

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

- **Jarvis reagiert nicht auf "Hey Jarvis":** Einstellungen > Mikrofon. Dort siehst du den Pegel und ob "Hey Jarvis" ankommt. Klappt es nur knapp, den Schalter "empfindlicher" einschalten. Zum Ausprobieren geht auch ein Klick auf den Kreis.
- **Jarvis nimmt das falsche Mikrofon:** Einstellungen > Mikrofon > dein richtiges Mikrofon anklicken (nicht "Windows-Standard"). Es wird sofort gespeichert. Ist es später mal abgesteckt, hört Jarvis so lange über das Standardmikrofon und sagt dir das.
- **Claude lehnt ab oder meldet einen Fehler:** Jarvis probiert automatisch andere Modelle (Sonnet, Haiku, Opus) und zuletzt einen ganz einfachen Modus. Unter Einstellungen > Claude steht Claudes genaue Meldung mit einem Knopf zum Kopieren. Die kannst du Claude im Jarvis-Projekt schicken.
- **Jarvis antwortet zu langsam:** Einstellungen > Claude > Antwort-Tempo auf **Schnell** stellen. Dann antwortet Haiku, das ist am schnellsten.
- **Irgendwas geht nicht und du weißt nicht was:** `werkzeuge\Selbsttest.bat` prüft alles und sagt bei jedem Punkt, was zu tun ist. Den Inhalt von `logs\selbsttest.txt` kannst du Claude im Jarvis-Projekt schicken.
- **"Jarvis läuft schon":** Jarvis ist schon offen, oft versteckt als Symbol unten rechts neben der Uhr. Dort mit Rechtsklick beenden oder das Fenster öffnen.
- **Mikrofon abgesteckt:** Jarvis merkt das und versucht es alle paar Sekunden wieder. Steckst du es wieder ein, hört er von selbst weiter zu.
- **Irgendwas anderes:** In `logs\jarvis.log` steht genau, was passiert ist. Die Datei kannst du Claude schicken.
