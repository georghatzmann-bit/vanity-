# Kreativ-Plan: NOVA

**Name & Idee:** NOVA – ein Stern, der plötzlich hell aufleuchtet. Logo: vierzackiger Stern in einer Umlaufbahn.
**Farbwelt:** warmes Glühen (Koralle → Magenta → Violett) auf tiefem Schwarz – bewusst anders als die vielen blauen Launcher.
**Bewegung „Schwerkraft“:** Elemente fliegen federnd herein und rasten weich ein; Sternenhimmel mit Maus-Parallax.
**Klangwelt „Glas & Sterne“:** kristalline Glockentöne in einer pentatonischen Tonleiter, live per Web Audio erzeugt (keine Dateien, keine fremden Rechte).

## Übernommen
Fast alle Punkte aus Teil 1–5 des Auftrags.

## Geändert – und warum
1. **Installer ebenfalls mit Tauri** statt NSIS/Inno: nur so sieht er wirklich eigen aus (gleiches Design, gleiche Sounds). Er bleibt eine einzelne Exe (~5 MB).
2. **Eigene, animierte Diagramme** statt Chart-Bibliothek: leichter, schneller, passend zum Look.
3. **`latest.json`** mit Version, Link und Prüfsumme wird automatisch erzeugt – nichts muss von Hand gepflegt werden; Installer und Update-Check nutzen dieselbe Datei.
4. **Eine Datenbank pro Profil** – Spielzeiten vermischen sich nie.
5. **Overlay**: über Spielen im Fenster-/randlosen Modus. Exklusives Vollbild bräuchte Code-Injektion ins Spiel (Anti-Cheat-Risiko) – bewusst weggelassen.
6. **Windows-Build in der Cloud** (GitHub Actions) zusätzlich zum Cross-Compile, damit auf echtem Windows gebaut und getestet wird.

## Zusätzlich erfunden
Generierte Kunst-Cover · Steam-Bilder ohne API-Key · Start-Ritual beim Spielstart · Spielzeit-Kalender (Heatmap) ·
„Wann spielst du?“-Uhr · Backlog-Rechner · Lupen-Dock · Theme-Wechsel als Lichtkreis · echte Programm-Icons ·
schlaue Sammlungen · Spielzeit nachtragen · Sitzungsliste · Tray-Menü mit zuletzt gespielten Spielen.
