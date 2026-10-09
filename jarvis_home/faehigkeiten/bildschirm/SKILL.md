---
name: bildschirm
description: Sehen, was auf dem Bildschirm steht, oder ein Programm ohne Maus bedienen (Knöpfe drücken, in Felder schreiben), wenn es dafür keinen eigenen Jarvis-Befehl gibt.
---

# Bildschirm lesen und Programme ohne Maus bedienen

Georg zockt oft nebenbei. Nimm ihm nie Maus oder Tastatur weg, wenn es anders geht.

Lesen (schnell zuerst):
1. `python -m jarvis.tool bildschirm-text` liest den Text auf dem Bildschirm direkt am PC, mit Positionen, in ein, zwei Sekunden. `bildschirm-text fenster` nur das vordere Fenster.
2. Nur wenn du Bilder, Farben oder das Layout brauchst: `python -m jarvis.tool bildschirm` (kleines Foto, `bildschirm fenster` nur das vordere Fenster), danach die Datei mit dem Read-Werkzeug ansehen.

Bedienen ohne Maus (stört Georg nicht):
- `python -m jarvis.tool fenster` zeigt alle offenen Fenster.
- `python -m jarvis.tool ui "<fenster>"` zeigt Knöpfe, Felder und Menüs eines Fensters.
- `python -m jarvis.tool ui-klick "<fenster>" "<knopf>"` drückt einen Knopf.
- `python -m jarvis.tool ui-schreiben "<fenster>" "<feld>" "<text>"` schreibt in ein Feld ("" = erstes Feld).

Für Discord, Telegram und WhatsApp gibt es immer eigene Befehle (`nachricht`, `discord ...`), die sind schneller. Maus und Tastatur nimmst du nur, wenn wirklich nichts anderes geht, und sagst es vorher kurz.
