---
name: morgen-briefing
description: Morgen-Briefing oder Tagesüberblick, wenn Georg "Guten Morgen", "Was steht heute an?" oder "Briefing" sagt.
---

# Morgen-Briefing

Kurz und gesprochen, höchstens fünf Sätze, wie ein Butler beim Frühstück. Keine Listen vorlesen.

Sammle in einem Rutsch (parallel, wenn möglich):
1. Wetter für Georgs Ort (steht in der Persönlichkeit) mit der Websuche: Temperatur jetzt und am Nachmittag, Regen ja oder nein.
2. Erinnerungen von heute: `python -m jarvis.tool erinnerungen`.
3. Geburtstage heute oder in den nächsten Tagen stehen in `<gedaechtnis>` oder in `python -m jarvis.tool gedaechtnis`.
4. Zwei, drei Schlagzeilen mit der Websuche, bevorzugt zu Georgs Interessen (Spiele, Technik, was im Gedächtnis steht). Je eine halbe Zeile.
5. Wenn es passt: ein Hinweis aus dem Tagebuch von gestern (`python -m jarvis.tool notizbuch-tag gestern`), z. B. eine offene Aufgabe.

Reihenfolge beim Sprechen: Begrüßung mit Wetter, dann Termine und Geburtstage, dann Schlagzeilen, zum Schluss ein Angebot ("Soll ich Discord und Spotify öffnen, Sir?"), wenn es zu seinen Gewohnheiten passt.
