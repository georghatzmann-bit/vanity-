---
description: Baut oder aktualisiert das Körper-Dashboard (eine HTML-Datei) aus Ernährung, Training und Gesundheit - Kalorien und Eiweiß gegen die Ziele, Stärke-Fortschritt, Schlaf, HRV, Ruhepuls und Erholung. Nimm es bei /koerper:koerper-dashboard, "Zeig mein Dashboard" oder "Aktualisiere das Körper-Dashboard".
---

# Körper-Dashboard

Lies aus `${user_config.ordner}` (steht dort `~`, ist das Benutzerverzeichnis) `ernaehrung.csv`, `training.csv`,
`gesundheit.csv` und `Ziele.md`, was davon da ist. Schreib daraus `${user_config.ordner}/Dashboard.html` und öffne die
Datei im Browser (unter Windows `start "" "<pfad>"`).

## Inhalt

1. Oben: **Erholung heute** (gut, mittel, eher niedrig, mit Begründung in Worten), Kalorien heute gegen das Ziel,
   Eiweiß heute gegen das Ziel, letztes Training.
2. **Ernährung**: Kalorien und Eiweiß der letzten 14 Tage als Balken mit Ziellinie.
3. **Training**: bester geschätzter Maximalwert (e1RM) je Hauptübung über die Zeit als Linie, Wochenvolumen als Balken.
4. **Körper**: Schlaf, HRV und Ruhepuls der letzten 30 Tage, Gewicht als 7-Tage-Schnitt.
Fehlt eine Datei, zeig die Kachel mit "Noch keine Daten" und einem Satz, wie man sie füllt.

## Technik und Aussehen

- Eine einzige Datei: CSS und JavaScript inline, Daten als JSON im Skript, Diagramme als SVG, keine Bibliotheken und
  keine Schriften aus dem Netz. Geht auch ohne Internet.
- Dunkler Hintergrund (sehr dunkles Blaugrau, nicht Schwarz), gedämpftes Weiß für Text, eine Akzentfarbe. Grün, Orange
  und Rot nur für Zustände und immer mit Text dazu. Abstände im 4-Pixel-Raster, Ecken 8 Pixel, Systemschrift.
- Auf dem Handy (360 Pixel) einspaltig, Diagramme passen sich der Breite an, Tastatur-Fokus sichtbar.
- Oben rechts "Stand: <Datum, Uhrzeit>".

Antworte danach in zwei Sätzen: was das Wichtigste im Dashboard ist und wo die Datei liegt.
