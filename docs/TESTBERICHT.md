# NOVA – Testbericht (ehrlich)

Stand: 13.10.2026, Version 1.0.0. Gebaut und getestet wurde in einer Linux-Umgebung und auf einem
Windows-Rechner von GitHub (windows-latest). Ein echter Spiele-PC mit Steam/Epic/GOG stand **nicht** zur Verfügung.

## Automatische Tests

| Bereich | Wie | Ergebnis |
|---|---|---|
| Oberflächen-Logik (Suche, Doppelte, Statistik, Würfel, Erfolge, Übersetzungen, kaputte Daten) | 18 Vitest-Tests (`npm test`) | ✅ grün (Linux + Windows) |
| App-Backend (VDF/ACF, Steam/Epic-Manifeste, Ordner-Scan, Prozess-Erkennung, DB, Sitzungen, Statistik, Export/Import, Spielstand-Zip inkl. Zip-Slip-Schutz, Backups, Farbpalette, Versionen) | 73 Rust-Tests (`npm run test:rust`) | ✅ grün unter Linux; Windows siehe CI |
| Installer-Backend (Manifest, Download, Fortsetzen nach Abbruch, 200/206/416, Prüfsumme, Abbrechen, Speicherplatz, Installation/Deinstallation, Selbsttest) | 27 Rust-Tests | ✅ grün unter Linux; unter Windows zwei Testfehler gefunden und behoben (parallele Registry-Tests, Linux-Pfad im Test) |
| Typprüfung beider Oberflächen | `npm run typecheck` | ✅ |

## Ende-zu-Ende mit der echten App (Rust + Oberfläche)

`scripts/e2e-app.mjs` steuert die echte App per WebDriver:

| Prüfung | Linux | Windows (CI) |
|---|---|---|
| App startet, Startanimation sichtbar, Hauptfenster lädt | ✅ | siehe CI |
| Steam-Bibliothek wird gefunden (nachgebaute Steam-Installation), Redistributables gefiltert | ✅ | siehe CI |
| Echtes Steam-Cover von Steams Server geladen und angezeigt | ✅ (Portal 2) | siehe CI |
| Spiel starten, „Läuft gerade“ erkannt, Beenden-Knopf beendet den Prozess | ✅ | siehe CI |
| Spielzeit gemessen und in der Datenbank gespeichert | ✅ (17 s) | siehe CI |
| Einstellungen/Theme bleiben nach Neustart, Export/Import, Backup, PC-Auslastung | ✅ | siehe CI |

`scripts/e2e-installer-linux.mjs` steuert den echten Installer: Intro → Willkommen → Ordner → Optionen →
Download (mit absichtlichem Verbindungsabbruch bei 45 %) → Fortsetzen per Range-Anfrage → Prüfsumme →
Installation → Fertig. **11/11 ✅** (Linux).

Auf Windows (CI) zusätzlich: App startet und läuft stabil, Installer startet, **Installer-Selbsttest**
(Download von lokalem Server, SHA-256, Installation, Startmenü- und Desktop-Verknüpfung,
Eintrag in „Apps & Features“, Deinstallation, alles wieder entfernt).

## Oberfläche im Browser (Demo-Daten)

`scripts/ui-tour.mjs` und `scripts/installer-tour.mjs` klicken alle Seiten durch und machen Screenshots
(alle vier Themes geprüft). Keine Fehler in der Konsole. Gefundene und behobene Fehler u. a.:
unsichtbare Intro-Ebene blockierte alle Klicks, verdecktes Suchfeld, „0“ im Banner, falsche Initialen bei Apostroph.

## Nicht getestet (ehrlich)

- **Echte Spiele-Launcher**: Epic-, GOG- und Startmenü-Scan sowie Steam über die echte Registry laufen nur mit
  nachgebauten Daten bzw. auf einem leeren CI-Rechner – nie mit einer echten Spielesammlung.
- **SteamGridDB** mit echtem API-Schlüssel (der Code ist da, die Antworten werden in Tests geparst).
- **Tastenkürzel fürs Overlay** über einem laufenden Vollbildspiel, **Controller** im Big-Picture-Modus,
  **Tray-Menü**, **Autostart** und **Windows-Benachrichtigungen** – brauchen einen echten Desktop mit Mensch davor.
- **UAC** (Installation nach „C:\Program Files“ mit Adminrechten) – der CI-Rechner läuft bereits als Admin.
- **Update über den Installer** (`--update`) – erst prüfbar, wenn eine zweite Version veröffentlicht ist.
- **Sounds hören**: Die Töne werden erzeugt (Code läuft fehlerfrei), angehört hat sie niemand.
- **SmartScreen**: Die Exe-Dateien sind nicht kostenpflichtig signiert. Windows warnt beim ersten Start
  („Weitere Informationen“ → „Trotzdem ausführen“).
