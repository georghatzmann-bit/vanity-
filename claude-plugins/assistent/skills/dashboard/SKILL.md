---
description: Baut aus einem Vorlagebild (Screenshot, Skizze, Dribbble-Bild) ein echtes Dashboard als HTML-Datei mit echten Daten aus den Konnektoren - wie im Video in fünf Minuten. Nimm es bei /assistent:dashboard und wenn der Nutzer "Bau mir ein Dashboard wie auf dem Bild" sagt.
---

# Dashboard aus einem Bild

## Ablauf

1. Sieh dir das Vorlagebild genau an (Read-Werkzeug). Notiere: Raster (Spalten, Kartengrößen), Farben, Schrift,
   welche Kacheln es gibt (Zahl, Diagramm, Liste, Kalender).
2. Ordne jeder Kachel echte Daten zu. Quellen in dieser Reihenfolge: Konnektoren (Shop, Werbung, Kalender, Mail über
   die Spezialisten des Plugins), Dateien des Nutzers (CSV, Körper-Tagebuch), sonst ein klar sichtbarer Platzhalter
   "keine Daten". Nie Zahlen erfinden.
3. Bau eine einzige HTML-Datei: `${user_config.ordner}/Dashboards/<name>.html` (steht dort `~`, ist das
   Benutzerverzeichnis). Alles inline (CSS, JavaScript, Daten als JSON im Skript), keine externen Bibliotheken, keine
   Schriften aus dem Netz, damit sie ohne Internet aufgeht. Diagramme als SVG.
4. Gestaltung: dunkler Hintergrund (sehr dunkles Blaugrau statt Schwarz), eine Akzentfarbe, Grün/Orange/Rot nur für
   Zustände, Abstände im 4-Pixel-Raster, gut lesbare Zahlen, Fokus-Rahmen für Tastatur, auf dem Handy (360 Pixel)
   einspaltig. Status nie nur über Farbe, immer mit Text.
5. Oben rechts "Stand: <Datum, Uhrzeit>". Öffne die Datei danach im Browser (unter Windows `start "" "<pfad>"`).
6. Sag in zwei Sätzen, was drin ist und wie man sie aktualisiert ("Sag: Aktualisiere das Dashboard").

## Aktualisieren

Bei "Aktualisiere das Dashboard": dieselbe Datei mit frischen Daten neu schreiben, Aufbau und Aussehen bleiben.
