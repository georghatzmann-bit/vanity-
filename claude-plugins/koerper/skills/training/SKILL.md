---
description: Trainings-Tagebuch - Sätze aus dem Gym eintragen ("Bankdrücken 3x8 mit 80 kg"), sagen was heute ansteht, Fortschritt gegen letzten Monat und letztes Jahr. Nimm es, wenn der Nutzer Sätze, Übungen, Gewichte oder Läufe nennt oder nach Training und Fortschritt fragt.
---

# Trainings-Tagebuch

Der Ordner ist `${user_config.ordner}` (steht dort `~`, ist das Benutzerverzeichnis). Darin:
- `training.csv` mit der Kopfzeile `datum,uebung,satz,wiederholungen,gewicht_kg,dauer_min,strecke_km,notiz`
  (Punkt als Dezimalzeichen, UTF-8, eine Zeile je Satz; Ausdauer: eine Zeile je Einheit mit Dauer und Strecke)
- `Trainingsplan.md` (optional): welcher Tag was, zum Beispiel `Montag: Bankdrücken, Schulterdrücken, Dips`

## Sätze eintragen

Verstehe die üblichen Schreibweisen und trag jede Zeile einzeln ein:
- "Bankdrücken 3x8 80" heißt drei Sätze mit je 8 Wiederholungen und 80 kg.
- "Kniebeuge 100x5, 100x5, 105x3" heißt drei Sätze mit diesen Gewichten und Wiederholungen.
- "Klimmzüge 4x10" ohne Gewicht: gewicht_kg leer lassen (Körpergewicht).
- "5 km in 28 Minuten gelaufen": uebung Laufen, dauer_min 28, strecke_km 5.
Übungen immer gleich benennen (deutscher Name, zum Beispiel "Kreuzheben", nicht mal "Deadlift"), damit der Vergleich
stimmt. Datum heute, außer der Nutzer sagt es anders.

Antworte kurz: was eingetragen ist, und ein Vergleich zum letzten Mal bei dieser Übung ("2,5 kg mehr als letzte Woche").

## Was steht heute an?

1. Gibt es `Trainingsplan.md`, nimm die Übungen für heute. Sonst schlag aus den letzten Einheiten die Muskelgruppe vor,
   die am längsten her ist.
2. Nenne zu jeder Übung das letzte Mal (Datum, Sätze, Gewicht) und einen Vorschlag: Hat er beim letzten Mal alle
   geplanten Wiederholungen geschafft, 2,5 kg mehr (bei Beinen 5 kg), sonst gleich bleiben.
3. Gibt es das Körper-Tagebuch mit schlechter Erholung (siehe gesundheit), schlag eine leichtere Einheit vor.

## Fortschritt

- Stärke je Übung als geschätztes Maximum (e1RM, Epley): Gewicht mal (1 + Wiederholungen / 30), nur Sätze mit höchstens
  12 Wiederholungen. Je Tag zählt der beste Satz.
- Vergleiche den besten Wert der letzten 14 Tage mit vor 4 Wochen und mit vor einem Jahr (30 Tage Spielraum). Fehlen
  Daten, sag das ehrlich ("Vor einem Jahr ist noch nichts eingetragen").
- Volumen je Woche: Summe aus Wiederholungen mal Gewicht.
- Antworte mit Zahlen und einem Satz Einordnung ("Bankdrücken: 96 kg statt 88 kg vor einem Jahr, plus 9 Prozent").
