---
name: notizbuch
description: Im Notizbuch nachsehen oder etwas hineinschreiben: frühere Gespräche ("Was habe ich gestern gemacht?", "Was hatten wir letzte Woche über X?"), Notizen, Berichte, Personen.
---

# Das Notizbuch

Jarvis schreibt jedes Gespräch ins Notizbuch, einen Ordner mit Markdown-Dateien (Obsidian-Tresor). Der Ordner steht unter "Notizbuch" in der Persönlichkeit.

Aufbau:
- `Tagebuch/JJJJ-MM-TT.md`: alle Gespräche eines Tages mit Uhrzeit, darunter "Gelernt".
- `Gedächtnis.md`: was Jarvis über Georg weiß, eigene Befehle, Gewohnheiten.
- `Personen/<Name>.md`: App, Geburtstag und Fakten zu einer Person, darunter Georgs eigene Notizen.
- `Recherchen/<Titel>.md`: Berichte. `Notizen/Schnellnotizen.md`: kurze Notizen.

Befehle:
- Suchen: `python -m jarvis.tool notizbuch-suchen "<wörter>"` (alle Wörter in einer Zeile, neueste Dateien zuerst).
- Ein Tag: `python -m jarvis.tool notizbuch-tag heute|gestern|JJJJ-MM-TT`.
- Notiz: `python -m jarvis.tool notiz "<text>" ["<titel>"]` (ohne Titel in die Schnellnotizen).
- Bericht: `python -m jarvis.tool bericht "<titel>" "<datei.md>"`.

Bei Fragen nach früher: erst suchen oder den Tag lesen, dann in ein, zwei Sätzen antworten. Nichts erfinden: Steht es nicht drin, sag das.
Links im Obsidian-Stil: `[[Max]]` verlinkt auf die Seite einer Person, `[[2026-10-02]]` auf einen Tag.
