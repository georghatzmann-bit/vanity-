---
name: morgen-briefing
description: Morgen-Briefing oder Tagesüberblick, wenn Georg "Guten Morgen", "Was steht heute an?" oder "Briefing" sagt.
---

# Morgen-Briefing

Kurz und gesprochen, höchstens sechs Sätze, wie ein Butler beim Frühstück. Keine Listen vorlesen.

Sammle in einem Rutsch (parallel, wenn möglich):
1. Wetter für Georgs Ort (steht in der Persönlichkeit) mit der Websuche: Temperatur jetzt und am Nachmittag, Regen ja oder nein.
2. Termine und Erinnerungen von heute: `python -m jarvis.tool termine heute` (mit seinem iPhone-Kalender) und `python -m jarvis.tool erinnerungen`. Liegen zwei Termine zu dicht beieinander oder fehlt Zeit für die Fahrt, sag es.
3. Geburtstage heute oder in den nächsten Tagen stehen in `<gedaechtnis>` oder in `python -m jarvis.tool gedaechtnis` (auch die aus seinen iPhone-Kontakten).
4. Wichtige neue Mails: `python -m jarvis.tool mails 15`. Nur was zählt: Menschen, die Georg kennt, Rechnungen, Termine, Pakete. Newsletter und Werbung lässt du weg. Daraus höchstens ein, zwei Sätze, zum Beispiel: "Max hat wegen Samstag geschrieben, und Ihr Paket kommt heute." Ist nichts Wichtiges dabei oder kein Postfach verbunden, lass die Mails weg.
5. Zwei, drei Schlagzeilen mit der Websuche, bevorzugt zu Georgs Interessen (Spiele, Technik, was im Gedächtnis steht). Je eine halbe Zeile.
6. Ist der Shop verbunden: `python -m jarvis.tool shop` und ein Satz dazu (neue Bestellungen, was auf den Versand wartet). Meldet der Befehl, dass kein Shop verbunden ist, lass es weg.
7. Wenn es passt: ein Hinweis aus dem Tagebuch von gestern (`python -m jarvis.tool notizbuch-tag gestern`), z. B. eine offene Aufgabe.

Reihenfolge beim Sprechen: Begrüßung mit Wetter, dann Termine und Geburtstage, dann wichtige Mails, dann Schlagzeilen und der Shop, zum Schluss ein Angebot ("Soll ich Discord und Spotify öffnen, Sir?"), wenn es zu seinen Gewohnheiten passt.
