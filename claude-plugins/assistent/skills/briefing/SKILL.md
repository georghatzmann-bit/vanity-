---
description: Das Tagesbriefing wie ein persönlicher Assistent - Termine (auch verschobene), wichtige Mails, Shop, Werbung, Training und Erholung, Wetter - in einer Minute zu lesen. Nimm es bei /assistent:briefing, "Briefing", "Was steht heute an?", "Guten Morgen" und für geplante Morgen-Aufgaben.
---

# Tagesbriefing

Ein Briefing ist in einer Minute gelesen und sagt, was heute zählt. Kein Bericht, keine Rohdaten.

## So holst du die Daten

Starte die Spezialisten gleichzeitig (Agent-Werkzeug, mehrere Aufrufe in einer Nachricht), jeweils mit einem klaren,
kurzen Auftrag:

- `assistent:kalender`: Termine heute und morgen früh, was seit gestern verschoben oder abgesagt wurde, freie Zeiten.
- `assistent:posteingang`: wichtige Mails seit gestern (höchstens fünf), Newsletter nur zählen.
- `assistent:shop`: nur wenn ein Shop-Konnektor da ist: Bestellungen und Umsatz seit gestern, offene Sendungen, Bestand.
- `assistent:werbung`: nur wenn ein Werbe-Konnektor da ist: Ausgaben und ROAS gestern, Auffälliges.

Lies dazu selbst, falls vorhanden:
- Körper-Tagebuch (Plugin Körper): `gesundheit.csv` und `training.csv` im Körper-Ordner (Standard:
  `~/Jarvis-Notizbuch/Körper`). Daraus: Schlaf und Erholung der letzten Nacht im Vergleich zu den sieben Tagen davor,
  das letzte Training und was heute dran ist.
- Die Einkaufsliste, wenn Jarvis läuft (`python -m jarvis.tool einkauf` im Jarvis-Ordner), sonst überspringen.
- Das Wetter über die Websuche, wenn der Wohnort bekannt ist.

Fehlt ein Konnektor, lass den Bereich einfach weg und erwähne ihn am Ende einmal in einem Halbsatz.

## So schreibst du es

Reihenfolge, jeweils ein bis drei Sätze, Wichtiges zuerst:
1. **Heute**: der wichtigste Termin, Änderungen ("Der Termin um 18 Uhr wurde auf Dienstag verschoben, steht schon im
   Kalender"), freie Zeit mit einem konkreten Vorschlag ("In der freien Stunde würde ich joggen gehen").
2. **Mails**: was eine Antwort braucht, mit Absender.
3. **Geld**: Shop und Werbung in Zahlen mit Vergleich zu gestern, eine Auffälligkeit.
4. **Körper**: Schlaf, Erholung ("Ihre Erholung ist heute gut"), was im Training ansteht.
5. **Sonst**: Wetter, Einkaufsliste, Geburtstage.

Zum Schluss höchstens drei Vorschläge, was der Nutzer heute tun könnte. Du erledigst nichts davon ungefragt.

Speichere das Briefing zusätzlich als Markdown in `${user_config.ordner}/Briefings/<JJJJ-MM-TT>.md` (Ordner anlegen,
wenn er fehlt; steht dort `~`, ist das Benutzerverzeichnis). Gibt es die Datei schon, ersetze sie.

## Jeden Morgen von selbst

Fragt der Nutzer, wie das jeden Tag automatisch kommt: In der Claude-App eine geplante Aufgabe anlegen ("Jeden Tag um
7 Uhr: /assistent:briefing"). Mit Jarvis geht es auch per Sprache: "Jeden Morgen um 7 Briefing", dann kommt es bei
Abwesenheit auf das Handy (Telegram).
