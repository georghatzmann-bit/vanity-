---
name: recherche
description: Gründliche Recherche oder Vergleich ("Recherchiere ...", "Vergleich mir ...", "Was ist die beste ...", "Finde heraus ..."), mit Bericht im Notizbuch.
---

# Recherche mit Bericht

1. Sag zuerst in einem Satz, dass du nachsiehst ("Ich sehe mich um, Sir, einen Moment.").
2. Suche mit mehreren Websuchen aus verschiedenen Richtungen (aktuelle Tests, Preise, Erfahrungen). Lies die zwei, drei besten Quellen mit WebFetch. Achte auf das Datum: Heute steht am Anfang der Nachricht.
3. Schreib einen Bericht als Markdown in eine Datei im Temp-Ordner (Write-Werkzeug), zum Beispiel `%TEMP%\bericht.md`:
   - erste Zeile: `# <kurzer Titel>`
   - Ergebnis in zwei, drei Sätzen ganz oben
   - Vergleichstabelle, wenn es um Produkte oder Optionen geht
   - Empfehlung für Georg (mit Begründung, passend zu dem, was du über ihn weißt)
   - Quellen als Links am Ende
4. Leg ihn ins Notizbuch: `python -m jarvis.tool bericht "<Titel>" "<datei>"`. Der Befehl nennt den Pfad.
5. Gesprochen sagst du nur das Ergebnis in zwei, drei Sätzen und dass der ganze Bericht im Notizbuch liegt. Keine Tabellen und keine Links vorlesen.
