# Konto-Retter

Hilfe nach einem Epic-Games-Hack – Schritt für Schritt, auf Deutsch, für Windows 10 und 11.

> Kein offizielles Programm von Epic Games oder Discord. Deine Daten bleiben verschlüsselt auf deinem PC.

## Installieren

1. Auf GitHub rechts auf **Releases** klicken und dort **Konto-Retter-Setup-1.2.1.exe** herunterladen.
2. Die Datei doppelklicken. Mehr ist nicht nötig: Das Programm installiert sich, legt ein Symbol auf den Desktop und einen Eintrag ins Startmenü und startet von selbst.
3. Falls Windows **„Der Computer wurde durch Windows geschützt“** zeigt: auf **Weitere Informationen** und dann auf **Trotzdem ausführen** klicken. Das kommt bei jedem Programm, das nicht mit einem gekauften Zertifikat signiert ist.

Du merkst, dass es geklappt hat, wenn auf dem Desktop das lila Schild-Symbol **Konto-Retter** liegt.

> Windows 11 mit eingeschalteter **intelligenter App-Steuerung** (Smart App Control) blockiert Programme ohne gekaufte Signatur ganz, ohne „Trotzdem ausführen“. Dann hilft nur: Windows-Sicherheit > App- & Browsersteuerung > Intelligente App-Steuerung > Aus. Bei den meisten PCs ist sie aber aus.

**Deinstallieren:** Einstellungen > Apps > Installierte Apps > Konto-Retter > Deinstallieren.

## Was der Konto-Retter kann

| Bereich | Was er macht |
|---|---|
| **Konto retten** | Kurze Anleitung in 6 Schritten: SMS und Authenticator einrichten, E-Mail-2FA aus, abmelden und „Passwort vergessen“, „Kein Zugriff auf diese E-Mail“, Codes eingeben, neue E-Mail eintragen. Jeder Schritt hat die passende Epic-Seite zum Öffnen. Der Fortschritt wird gespeichert. |
| **Konten** | Mehrere Epic-Konten im Launcher? Mit einem Klick wechseln: Der Konto-Retter schließt den Epic Games Launcher, setzt den gespeicherten „Angemeldet bleiben“-Zugang ein und startet ihn neu. Zugänge bleiben verschlüsselt auf diesem PC. |
| **PDF auslesen** | Epic-Konto-PDF („Kontoinformationen herunterladen“), Epic-Kaufbelege, gespeicherte Epic-Seiten oder Epic-Mails hineinziehen. Konto-ID, Anzeigename, Rechnungsnummern, verknüpfte Konsolen, Zeitpunkt des Hacks und mehr werden automatisch erkannt. Die passwortgeschützte Epic-PDF wird unterstützt (Passwort steht in der zweiten Epic-Mail und wird nicht gespeichert). |
| **Meine Daten** | Alle Nachweise an einer Stelle, jeweils mit Kopieren-Knopf. Als Textdatei speicherbar. |
| **Support-Text** | Fertiger Text für den Epic-Support auf Deutsch und Englisch: erste Anfrage, Nachfrage oder Kurzfassung. Füllt sich automatisch und zeigt, welche Angaben noch fehlen. |
| **Discord** | Discord starten, beenden und stumm schalten – per Klick. „Stumm“ blendet die Windows-Benachrichtigungen von Discord aus und schaltet die Discord-Töne im Windows-Lautstärkemixer stumm. Ein Klick stellt alles wieder her. |

### Gut zu wissen

- **Discord-Töne stumm** heißt: Auch der Sprachchat ist stumm. Beim Schließen des Konto-Retters geht der Ton automatisch wieder an. Willst du nur die Pings stumm haben, stell in Discord den Status „Bitte nicht stören“ ein – das darf aus Sicherheitsgründen nur Discord selbst.
- Lief Discord beim Wieder-Einschalten gerade nicht, schaltet der Konto-Retter den Ton automatisch ein, sobald Discord wieder läuft. Notfalls geht es auch von Hand: Rechtsklick auf das Lautsprecher-Symbol > Lautstärkemixer > bei Discord den Ton einschalten.
- Bei der Deinstallation werden die Windows-Benachrichtigungen von Discord wieder eingeschaltet, falls der Konto-Retter sie ausgeschaltet hatte.
- Der Konto-Retter fasst dein Discord-Konto nie an und liest keine Discord-Anmeldedaten.
- Epic ändert seine Hilfe-Seiten gelegentlich. Öffnet ein Link nicht die richtige Seite, findest du alles auch über epicgames.com/help.
- Gespeichert wird in `%APPDATA%\Konto-Retter` – verschlüsselt mit dem Windows-Datenschutz (nur dein Windows-Benutzer kann die Daten lesen).

## Für Entwickler

```
npm ci            # Abhängigkeiten
npm start         # Programm starten
npm test          # Tests (die Windows-Tests laufen nur unter Windows)
npm run dist      # Installer bauen -> dist\Konto-Retter-Setup-<version>.exe
```

- Unter Linux braucht `npm run dist` Wine inklusive 32-Bit-Teil (`wine`, `wine32:i386`).
- Bei jedem Push baut GitHub Actions (`.github/workflows/build.yml`) den Installer auf Windows, installiert ihn testweise, klickt das Programm automatisch durch (`test/e2e/smoke.mjs`) und stellt die Setup.exe als Release bereit.
- Beispiel-PDFs für die Tests (erfundene Daten): `node test/fixtures/make-fixtures.mjs` (braucht Playwright und qpdf).
- Programmsymbol neu erzeugen: `npm run icons` (braucht Pillow).

### Aufbau

```
src/main/       Hauptprozess: Fenster, Speichern, PDF lesen, Discord-Steuerung, Link-Freigabe
src/shared/     Schritte, Datenfelder, PDF-Erkennung, Support-Texte (auch in den Tests benutzt)
src/renderer/   Oberfläche (HTML, CSS, eine Datei pro Bereich)
resources/      PowerShell-Hilfsskript für die Discord-Töne
build/          Programmsymbol
test/           Tests und Beispiel-PDFs
```
