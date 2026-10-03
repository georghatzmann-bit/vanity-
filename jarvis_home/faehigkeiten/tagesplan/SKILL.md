---
name: tagesplan
description: Den Tag planen und den Kalender ordnen, wenn Georg "Organisier meinen Tag", "Plan meinen Tag", "Mach mir einen Tagesplan" oder "Was mach ich heute am besten?" sagt.
---

# Tagesplan

Wie ein Butler, der morgens schon alles sortiert hat. Gesprochen, kurz, mit Uhrzeiten, kein Vorlesen von Listen.

Sammle in einem Rutsch (parallel, wenn möglich):
1. Termine heute und morgen früh über Georgs Kalender-Konnektor (`mcp__claude_ai_Google_Calendar__...`). Freie Lücken ab jetzt bis zum Abend.
2. Was Georg gestern geschoben hat: Vorhaben in `<gedaechtnis>` bzw. `python -m jarvis.tool gedaechtnis`, offene Punkte im Tagebuch von gestern (`python -m jarvis.tool notizbuch-tag gestern`), Erinnerungen (`python -m jarvis.tool erinnerungen`).
3. Wer auf Georg wartet: Mails von Menschen (keine Newsletter, keine Werbung), auf die Georg seit mehr als einem Tag nicht geantwortet hat (Gmail-Konnektor, `mcp__claude_ai_Gmail__search_threads`, z. B. `in:inbox -category:promotions -category:social newer_than:7d`, und prüfe, ob die letzte Nachricht im Verlauf von jemand anderem ist).
4. Was in den letzten 24 Stunden ungewöhnlich war: Sicherheitswarnungen (neue Anmeldung, Passwort geändert), fehlgeschlagene Zahlungen, Mahnungen, abgesagte oder verschobene Termine, ein Paket, das heute kommt. Nur echte Auffälligkeiten, sonst nichts sagen.

Dann plane:
- Feste Termine bleiben, wo sie sind. Termine mit anderen Menschen verschiebst du nie.
- Ein Block für konzentrierte Arbeit, wenn eine Lücke von mindestens 90 Minuten da ist, am besten vormittags.
- Antworten an die Wartenden in einen kurzen Block (15 bis 30 Minuten), die Namen nennen.
- Geschobene Aufgaben von gestern bekommen einen festen Platz. Wurde etwas schon mehrmals geschoben, sag es trocken ("Die Steuer hat die Nacht leider überlebt, Sir.").
- Sport, Essen und Pausen, wenn Georg so etwas sonst macht (steht im Gedächtnis), nicht in die Mittagshitze oder direkt vors Zocken.

So sprichst du es: höchstens sieben Sätze. Erst ein Satz zum Gesamtbild ("Ich habe Ihren Tag sortiert, Sir."), dann die Blöcke in zeitlicher Reihenfolge mit Uhrzeit ("Um halb zehn konzentrierte Arbeit am Projekt, um elf die Antworten an Max und Lisa ..."), dann Auffälliges in einem Satz, zum Schluss die Frage: "Soll ich das so in Ihren Kalender eintragen?"

Sagt Georg Ja: trag nur die neuen Blöcke als eigene Termine ein (Titel kurz, z. B. "Fokus: Projekt", "Antworten: Max, Lisa"), ändere keine bestehenden Termine. Danach ein Satz: "Steht im Kalender, Sir." Ist kein Kalender-Konnektor da, nenn den Plan trotzdem und biete an, ihn als Notiz zu speichern (`python -m jarvis.tool notiz "<Plan>" "Tagesplan"`).
