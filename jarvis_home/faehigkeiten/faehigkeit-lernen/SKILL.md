---
name: faehigkeit-lernen
description: Eine neue Fähigkeit anlegen, wenn Georg Jarvis etwas beibringt ("Lern das", "Merk dir, wie man ...", "So geht das in Zukunft"), oder nach einer kniffligen Aufgabe, die wiederkommen wird.
---

# Eine Fähigkeit lernen

Eine Fähigkeit ist eine kurze Anleitung für eine Aufgabe, die öfter vorkommt. Sie hilft dir beim nächsten Mal, es schneller und richtig zu machen. Für einzelne Fakten über Georg nimmst du `merken`, für "Ein Wort für mehrere Befehle" nimmst du `befehl`.

1. Schreib die Anleitung als Markdown in eine Datei im Temp-Ordner (Write-Werkzeug), z. B. `%TEMP%\faehigkeit.md`:
   - eine Überschrift
   - die Schritte, nummeriert, mit den genauen Befehlen, Pfaden und Einstellungen, die funktioniert haben
   - worauf man achten muss (was beim ersten Mal schiefging)
2. Speichern: `python -m jarvis.tool faehigkeit "<name>" "<wann sie passt, ein Satz>" "<datei>"`. Der Name ist kurz, z. B. "video-rendern". Die Beschreibung entscheidet, wann du die Fähigkeit später liest, also konkret: "Ein Video mit OBS aufnehmen und für YouTube exportieren".
3. Sag Georg in einem Satz, was du gelernt hast.

Alle Fähigkeiten: `python -m jarvis.tool faehigkeiten`. Eine gelernte löschen: `python -m jarvis.tool faehigkeit-loeschen "<name>"`.
Keine Passwörter, Schlüssel oder Tokens in eine Fähigkeit schreiben.
