# NOVA – Testbericht (ehrlich)

Stand: 13.10.2026, Version 1.0.0. Gebaut und getestet wurde in einer Linux-Umgebung und auf einem
Windows-Rechner von GitHub (windows-latest). Ein echter Spiele-PC mit Steam/Epic/GOG stand **nicht** zur Verfügung.

## Automatische Tests

| Bereich | Wie | Ergebnis |
|---|---|---|
| Oberflächen-Logik (Suche, Doppelte, Statistik, Würfel, Erfolge, Übersetzungen, kaputte Daten) | 18 Vitest-Tests (`npm test`) | ✅ grün (Linux + Windows) |
| App-Backend (VDF/ACF, Steam/Epic-Manifeste, Ordner-Scan, Prozess-Erkennung, DB, Sitzungen, Zusammenführen, Statistik, Export/Import, Spielstand-Zip inkl. Zip-Slip-Schutz, Backups, Farbpalette, Bildquellen und Namensabgleich, Versionen) | 78 Rust-Tests (`npm run test:rust`) | ✅ grün (Linux + Windows) |
| Installer-Backend (Manifest, Download, Fortsetzen nach Abbruch, 200/206/416, Prüfsumme, Abbrechen, Speicherplatz, Installation/Deinstallation, Selbsttest) | 27 Rust-Tests | ✅ grün (Linux + Windows); unter Windows zuerst zwei Testfehler gefunden und behoben (parallele Registry-Tests, Linux-Pfad im Test) |
| Typprüfung beider Oberflächen | `npm run typecheck` | ✅ |

## Ende-zu-Ende mit der echten App (Rust + Oberfläche)

Unter Linux steuert `scripts/e2e-app.mjs` die echte App per WebDriver (klickt wie ein Mensch).
Auf dem Windows-Rechner von GitHub konnte sich der Edge-WebDriver nicht mit WebView2 verbinden
(„DevToolsActivePort file doesn't exist“). Deshalb hat die App einen **eingebauten Selbsttest**:
`NovaLauncher.exe --selftest bericht.json` ruft dieselben Befehle auf, die auch die Oberfläche benutzt,
und meldet das Ergebnis. Der Windows-Lauf schlägt fehl, wenn auch nur ein Schritt nicht klappt.

| Prüfung | Linux (WebDriver) | Windows (CI, Selbsttest) |
|---|---|---|
| App startet, Startanimation, Hauptfenster lädt | ✅ | ✅ (Screenshots im CI-Artefakt) |
| Steam-Bibliothek gefunden (nachgebaute Steam-Installation, unter Windows über die echte Registry `HKCU\Software\Valve\Steam`) | ✅ | ✅ „Portal 2“ gefunden |
| Startmenü-, Epic- und GOG-Scan | ✅ (leer) | ✅ 46 Programme aus dem Startmenü (z. B. 7-Zip, Firefox) |
| Echtes Steam-Cover, Hintergrund, Logo **und Icon** von Steams Server | ✅ | ✅ |
| Spiel ohne Steam-ID (wie bei Epic/GOG): Bilder per Namenssuche („Hades II“ → richtiges Spiel) | ✅ | ✅ |
| Echtes Programm-Icon aus einer .exe (explorer.exe) | – (nur Windows) | ✅ |
| Icon, wenn nur der Installationsordner bekannt ist (Haupt-.exe wird gesucht) | – (nur Windows) | ✅ |
| PC-Auslastung (CPU, RAM, GPU) | ✅ | ✅ CPU, 16 GB RAM, GPU-Last |
| Spiel starten, „Läuft gerade“ erkannt | ✅ | ✅ nach 0,5 s |
| Beenden-Knopf beendet den Prozess | ✅ | ✅ |
| Spielzeit gemessen und in der Datenbank gespeichert | ✅ (17 s) | ✅ (13 s, 1 Sitzung) |
| Einstellungen/Theme bleiben nach Neustart, Export/Import, Backup | ✅ | – (nur Linux geprüft) |

`scripts/e2e-installer-linux.mjs` steuert den echten Installer: Intro → Willkommen → Ordner → Optionen →
Download (mit absichtlichem Verbindungsabbruch bei 45 %) → Fortsetzen per Range-Anfrage → Prüfsumme →
Installation → Fertig. **11/11 ✅** (Linux).

Auf Windows (CI) zusätzlich: Installer startet, **Installer-Selbsttest** ✅
(Download von lokalem Server, SHA-256, Installation, Startmenü- und Desktop-Verknüpfung,
Eintrag in „Apps & Features“, Deinstallation, alles wieder entfernt).
Außerdem hat der Installer-Selbsttest einmal gegen das **echte GitHub-Release `nova-latest`** geladen
und installiert – ✅.

## Oberfläche im Browser (Demo-Daten)

`scripts/ui-tour.mjs` und `scripts/installer-tour.mjs` klicken alle Seiten durch und machen Screenshots
(alle vier Themes geprüft). Keine Fehler in der Konsole. Gefundene und behobene Fehler u. a.:
unsichtbare Intro-Ebene blockierte alle Klicks, verdecktes Suchfeld, „0“ im Banner, falsche Initialen bei Apostroph.

## Nicht getestet (ehrlich)

- **Echte Spielesammlung**: Steam lief mit nachgebauten Daten, Epic und GOG auf einem Rechner ohne diese Launcher.
  Mit einer echten, großen Sammlung (und echten Epic-/GOG-Installationen) wurde NOVA nie ausprobiert.
- **Klicken in der Windows-Oberfläche**: Auf Windows sind die Abläufe über den Selbsttest geprüft, und die Screenshots
  zeigen die richtig gezeichnete App. Ein automatisches Durchklicken aller Seiten gab es nur unter Linux und im Browser.
- **SteamGridDB** mit echtem API-Schlüssel (der Code ist da, die Antworten werden in Tests geparst).
- **Namenssuche bei vielen echten Spielen:** geprüft mit „Hades II“ und in Tests mit Beispielantworten. Spiele, die es bei Steam
  nicht gibt (z. B. Alan Wake 2, Minecraft) oder die Steam nicht mehr anzeigt (z. B. Rocket League), bekommen ohne SteamGridDB-Schlüssel kein Bild.
- **Tastenkürzel fürs Overlay** über einem laufenden Vollbildspiel, **Controller** im Big-Picture-Modus,
  **Tray-Menü**, **Autostart** und **Windows-Benachrichtigungen** – brauchen einen echten Desktop mit Mensch davor.
- **UAC** (Installation nach „C:\Program Files“ mit Adminrechten) – der CI-Rechner läuft bereits als Admin.
- **Update über den Installer** (`--update`) – erst prüfbar, wenn eine zweite Version veröffentlicht ist.
- **Sounds hören**: Die Töne werden erzeugt (Code läuft fehlerfrei), angehört hat sie niemand.
- **SmartScreen**: Die Exe-Dateien sind nicht kostenpflichtig signiert. Windows warnt beim ersten Start
  („Weitere Informationen“ → „Trotzdem ausführen“).
