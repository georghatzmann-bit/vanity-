# Jarvis

Dein eigener Sprachassistent wie bei Iron Man: Du sagst "Hey Jarvis", sprichst deinen Befehl, Claude Code erledigt ihn auf deinem PC, und Jarvis antwortet mit einer menschlichen Stimme.

```
Mikrofon → "Hey Jarvis" (openWakeWord, lokal)
         → Sprache zu Text (faster-whisper, lokal)
         → Gehirn: Claude Code (dein Claude Pro Abo)
         → Jarvis-Stimme (Microsoft Neural über edge-tts, gratis)
```

## Einrichten (Windows)

1. **Python 3.11 oder neuer** installieren: https://www.python.org/downloads/ (Haken bei "Add python.exe to PATH").
2. **Claude Code** installieren und anmelden. In PowerShell:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude
   ```
   Beim ersten Start mit deinem Pro-Konto anmelden, danach mit `/exit` beenden.
3. Dieses Repo herunterladen (grüner Button "Code" → "Download ZIP" und entpacken, oder `git clone`).
4. Im Jarvis-Ordner in PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1
   ```

## Starten

**Zuerst einmal das Mikrofon wählen:** `mikrofon.bat` doppelklicken, die Nummer deines Mikrofons eintippen, kurz reinsprechen und mit Enter speichern. Das musst du nur einmal machen (oder wenn du das Mikrofon wechselst).

- `start.bat` doppelklicken, dann "Hey Jarvis" sagen (englisch ausgesprochen), kurz auf den Ton warten und deinen Befehl auf Deutsch sprechen.
- `start.bat --text` zum Testen per Tastatur, ohne Mikrofon.
- "Jarvis, neue Unterhaltung" setzt das Gedächtnis zurück.
- **Stumm/Laut:** `Strg+Alt+M` schaltet das Mikrofon aus und wieder ein, egal welches Fenster vorne ist. Du kannst auch "Hey Jarvis, Mikrofon aus" sagen. Solange Jarvis stumm ist, ist das Mikrofon komplett geschlossen.

Beispiele: "Öffne YouTube", "Wie wird das Wetter morgen in Wien?", "Such auf meinem Desktop nach der Rechnung von letzter Woche", "Mach die Lautstärke leiser".

## Jarvis reagiert nicht?

Starte `start.bat --mic-test`. Das zeigt alle Mikrofone und einen Live-Pegel:

- **Der Pegel bleibt bei 0:** Windows blockiert das Mikrofon. Öffne *Einstellungen > Datenschutz und Sicherheit > Mikrofon* und schalte "Desktop-Apps den Zugriff auf das Mikrofon erlauben" ein.
- **Der Pegel bewegt sich kaum, wenn du sprichst:** Es ist das falsche Mikrofon. Starte `mikrofon.bat` und wähle das richtige.
- **Der Pegel bewegt sich, aber "Hey-Jarvis" bleibt niedrig:** Sprich "Hey Jarvis" englisch aus ("Hey Dschaarwis"). Wenn der beste Wert bei etwa 0.3 bis 0.5 landet, stell in `config.toml` unter `[wakeword]` `threshold = 0.35` ein.

Im normalen Betrieb zeigt Jarvis "fast erkannt: 0.38" an, wenn er dich knapp nicht verstanden hat.

## Claude lehnt ab?

Manchmal schlägt Claudes Sicherheitsfilter fälschlich an, sogar bei "hi". Jarvis startet Claude Code deshalb ohne deine persönlichen Skills, Plugins und CLAUDE.md-Dateien (`isolated = true`) und versucht bei einer Ablehnung automatisch das nächste Modell aus `models`. Welches Modell geantwortet hat, steht in eckigen Klammern hinter "Jarvis".

`start.bat --claude-test` probiert jedes Modell einmal mit und ohne deine Einstellungen aus und zeigt eine kleine Tabelle, an der man sieht, woran es liegt.

## Anpassen

Alles steht in `config.toml`:

- **Stimme:** `voice` unter `[tts]`, z. B. `de-DE-KillianNeural` oder `de-DE-FlorianMultilingualNeural`. Mit `rate` und `pitch` klingt sie schneller, langsamer, tiefer.
- **Empfindlichkeit:** `threshold` unter `[wakeword]` höher stellen, wenn Jarvis zu oft aus Versehen reagiert.
- **Mikrofon:** am einfachsten mit `mikrofon.bat`, sonst `input_device` unter `[audio]`.
- **Stumm-Taste:** `hotkey` unter `[mute]`, z. B. `"f9"`.
- **Genauigkeit:** `model = "medium"` unter `[stt]` versteht besser, ist aber langsamer.
- **Persönlichkeit:** `jarvis_home/CLAUDE.md` beschreibt, wie Jarvis redet und was er darf.

## Sicherheit

Claude Code darf ohne Nachfrage Programme öffnen, Dateien lesen und schreiben und im Web suchen. Löschen, Herunterfahren und Formatieren sind in `config.toml` unter `disallowed_tools` gesperrt, und `jarvis_home/CLAUDE.md` verbietet riskante Aktionen zusätzlich.

## Grenzen

- Eine Antwort dauert ein paar Sekunden, weil jede Anfrage an Claude übers Internet geht.
- Claude Pro hat ein Nutzungslimit pro 5 Stunden.
- Ohne Internet hört Jarvis zu, kann aber nicht antworten.

## Wie es weitergeht

Der komplette Plan steht im Projekt ("Jarvis Bauplan"). Als Nächstes kommen schnellere Antworten (Jarvis spricht, während Claude noch arbeitet), die Arc-Reactor-Oberfläche und die Alexa-Anbindung.
