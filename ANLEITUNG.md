# Jarvis 2 in 4 Schritten

Diese Anleitung ist für dich, Georg. Jarvis läuft danach unsichtbar im Hintergrund und ist immer da, wenn du „Hey Jarvis“ sagst.

## 1. JarvisSetup.exe laden und starten

1. Falls ein älteres Jarvis läuft: unten rechts neben der Uhr Rechtsklick auf das Jarvis-Symbol > **Jarvis beenden**.
2. Diese Datei laden: https://github.com/georghatzmann-bit/vanity-/releases/latest/download/JarvisSetup.exe
3. Doppelklick auf `JarvisSetup.exe`. Fragt Windows nach („Der Computer wurde durch Windows geschützt“): **Weitere Informationen** > **Trotzdem ausführen**. Das kommt, weil der Installer nicht mit einem gekauften Zertifikat signiert ist.
4. Den Haken bei **„Jarvis mit Windows starten“** drin lassen. Admin-Rechte braucht der Installer nicht. Beim ersten Mal dauert er ein paar Minuten.

Deine Einstellungen von vorher bleiben erhalten.

## 2. Gratis-Schlüssel für die Spracherkennung (Groq, 2 Minuten)

Damit versteht Jarvis dich viel besser und schneller. Kostet nichts.

1. https://console.groq.com/keys öffnen und mit Google anmelden.
2. **Create API Key** klicken, einen Namen eingeben (zum Beispiel „Jarvis“), **Submit**.
3. Den Schlüssel (beginnt mit `gsk_`) kopieren. Er wird nur einmal angezeigt.

## 3. Premium-Stimme (ElevenLabs, etwa 6 $ im Monat)

Das ist der große Unterschied: Jarvis klingt dann wie ein Mensch.

1. https://elevenlabs.io öffnen und ein Konto anlegen.
2. Unter **Upgrade** das Abo **Starter** wählen (etwa 6 $ im Monat, reicht für mehrere hundert Antworten).
3. https://elevenlabs.io/app/settings/api-keys öffnen > **Create API Key** > Namen eingeben > ohne Einschränkungen erstellen.
4. Den Schlüssel (beginnt mit `sk_`) kopieren.

## 4. Schlüssel in die Einrichtung

Die Einrichtung öffnet sich nach der Installation von selbst. Später: Rechtsklick aufs Jarvis-Symbol neben der Uhr > **Einstellungen**.

1. **Mikrofon:** dein Mikrofon anklicken und „Hey Jarvis“ sagen. Darunter den **Groq-Schlüssel** einfügen und **Prüfen** klicken. Es klappt, wenn „Aktiv“ erscheint.
2. **Stimme:** **Premium** wählen, den **ElevenLabs-Schlüssel** einfügen und **Prüfen** klicken. Dann Stimmen anhören (Play-Knopf) und eine anklicken. **Auf Deutsch** spielt den Begrüßungssatz mit dieser Stimme. Weiter unten gibt es **deutsche Stimmen aus der Bibliothek**: anhören und **Übernehmen**.
3. **Wohnort**, **Gehirn** (prüft dein Claude-Abo) und **Extras** wie gewohnt.

Zum Schluss **Jarvis starten**.

## So benutzt du Jarvis

Jarvis läuft im Hintergrund. Du siehst nur das Symbol unten rechts neben der Uhr.

- **„Hey Jarvis“** sagen (englisch ausgesprochen), kurz warten, Befehl auf Deutsch sprechen.
- Oder **Strg + Alt + J** drücken: Jarvis hört sofort zu, ganz ohne „Hey Jarvis“.
- Oben in der Bildschirmmitte erscheint dabei eine kleine **Jarvis-Anzeige**: was du gesagt hast und was Jarvis antwortet. Sie stiehlt keinen Fokus und bleibt bei Vollbild-Spielen und im Gaming-Modus weg.
- **Das große Jarvis-Fenster** öffnest du mit einem Klick auf das Symbol neben der Uhr, mit einem Doppelklick auf das Desktop-Symbol oder mit „Hey Jarvis, zeig dich“. Schließen versteckt es nur, Jarvis hört weiter zu. Beenden: Rechtsklick aufs Symbol > Jarvis beenden.
- **Strg + Alt + M** schaltet das Mikrofon stumm und wieder an.
- **„Stopp“** oder der Stopp-Knopf unterbricht Jarvis sofort.

## Was du sagen kannst

Sofort, ohne Wartezeit:

- „Öffne Spotify“, „Starte Discord“, „Mach Steam zu“, „Öffne YouTube“, „Öffne den Ordner Downloads“
- „Installier mir Spotify“ oder „Lad mir Discord runter“ (Jarvis installiert und meldet sich, wenn es fertig ist)
- „Gaming-Modus an“ / „Gaming-Modus aus“
- „Wie spät ist es?“, „Lauter“, „Lautstärke auf 30“, „Nächstes Lied“, „Musik pausieren“
- „Sperr den PC“, „Zeig dich“, „Versteck dich“

Mit Nachdenken (ein paar Sekunden):

- „Wie wird das Wetter morgen?“, „Was gibt es Neues?“
- „Erinnere mich in 20 Minuten an den Tee“
- „Mach den Dunkelmodus an“, „Schalte Bluetooth aus“
- „Was steht gerade auf meinem Bildschirm?“
- „Guten Morgen“ (Wetter, Erinnerungen, Schlagzeilen)

Jarvis macht das einfach. Nur vor **Löschen, Deinstallieren, Herunterfahren und Neustarten** und bevor er **in deinem Namen etwas sendet oder kauft**, fragt er einmal nach. Braucht etwas Administratorrechte, zeigt Windows die übliche Abfrage: einmal **Ja** klicken.

## Wenn etwas nicht klappt

- **Jarvis reagiert nicht auf „Hey Jarvis“:** Einstellungen > Mikrofon. Dort siehst du den Pegel und ob „Hey Jarvis“ ankommt. Klappt es nur knapp, „Empfindlicher“ einschalten. Strg + Alt + J geht immer.
- **Die Stimme klingt wieder nach Computer:** Dann ist das ElevenLabs-Guthaben aufgebraucht oder das Internet weg. Jarvis sagt das einmal an. Unter Einstellungen > Stimme steht, wie viele Zeichen noch übrig sind.
- **Jarvis versteht dich schlecht:** Prüfen, ob der Groq-Schlüssel unter Einstellungen > Mikrofon „Aktiv“ zeigt. Ohne Groq erkennt dein PC selbst, das ist langsamer und ungenauer.
- **Jarvis lehnt etwas ab:** Anders formulieren hilft meistens. Unter Einstellungen > Gehirn steht Claudes genaue Meldung mit einem Knopf zum Kopieren.
- **Mikrofon blockiert** (die Einrichtung meldet absolute Stille): Windows-Einstellungen > Datenschutz und Sicherheit > Mikrofon > „Desktop-Apps den Zugriff auf das Mikrofon erlauben“ einschalten.
- **Irgendwas anderes:** `werkzeuge\Selbsttest.bat` prüft alles. In `logs\jarvis.log` (im Jarvis-Ordner unter `%LOCALAPPDATA%\Programs\Jarvis`) steht genau, was passiert ist. Beides kannst du Claude im Jarvis-Projekt schicken.

Deinstallieren: Windows-Einstellungen > Apps > Jarvis > Deinstallieren. Das nimmt auch den Autostart mit.

## Alexa einrichten (optional)

Jarvis spricht über Home Assistant mit deinen Echos. Das kostet nichts, braucht aber einmal etwas Einrichtung:

1. **Home Assistant** installieren, zum Beispiel auf einem Raspberry Pi: https://www.home-assistant.io/installation/
2. In Home Assistant **HACS** installieren und darüber **„Alexa Media Player“**. Dann mit deinem Amazon-Konto anmelden. Deine Echos erscheinen als `media_player.echo_...`.
3. In Home Assistant unten links auf deinen Namen > **Sicherheit** > **Langlebige Zugriffstoken** > Token erstellen und kopieren.
4. In der Jarvis-Einrichtung bei **Extras > Alexa** die Adresse (zum Beispiel `http://homeassistant.local:8123`) und den Token einfügen und auf **Verbindung testen** klicken.
5. Ausprobieren: „Hey Jarvis, sag im Wohnzimmer Bescheid, dass das Essen fertig ist.“
