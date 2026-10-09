---
name: morgen-briefing
description: Morgen-Briefing oder Tagesüberblick, wenn Georg "Guten Morgen", "Was steht heute an?" oder "Briefing" sagt.
---

# Morgen-Briefing

Kurz und gesprochen, höchstens sechs Sätze, wie ein Butler beim Frühstück. Keine Listen vorlesen.

Sammle in einem Rutsch (parallel, wenn möglich):
1. Wetter für Georgs Ort (steht in der Persönlichkeit) mit der Websuche: Temperatur jetzt und am Nachmittag, Regen ja oder nein.
2. Termine und Erinnerungen von heute: die Termine über Georgs Kalender-Konnektor (Werkzeuge `mcp__claude_ai_Google_Calendar__...`, sonst ein anderer Kalender-Konnektor) und `python -m jarvis.tool erinnerungen`. Liegen zwei Termine zu dicht beieinander oder fehlt Zeit für die Fahrt, sag es. Ist kein Kalender-Konnektor da, lass die Termine weg.
3. Geburtstage heute oder in den nächsten Tagen stehen in `<gedaechtnis>` oder in `python -m jarvis.tool gedaechtnis`.
4. Wichtige neue Mails über Georgs Mail-Konnektor (Werkzeuge `mcp__claude_ai_Gmail__...`): die ungelesenen seit gestern. Nur was zählt: Menschen, die Georg kennt, Rechnungen, Termine, Pakete. Newsletter und Werbung lässt du weg. Daraus höchstens ein, zwei Sätze, zum Beispiel: "Max hat wegen Samstag geschrieben, und Ihr Paket kommt heute." Ist nichts Wichtiges dabei oder kein Mail-Konnektor da, lass die Mails weg.
5. Zwei, drei Schlagzeilen mit der Websuche, bevorzugt zu Georgs Interessen (Spiele, Technik, was im Gedächtnis steht). Je eine halbe Zeile.
6. Hat Georg einen Shopify-Konnektor (Werkzeuge `mcp__claude_ai_Shopify__...`): ein Satz zu neuen Bestellungen und was auf den Versand wartet. Sonst lass es weg.
7. Wenn es passt: ein Hinweis aus dem Tagebuch von gestern (`python -m jarvis.tool notizbuch-tag gestern`), z. B. eine offene Aufgabe.

Reihenfolge beim Sprechen: Begrüßung mit Wetter, dann Termine und Geburtstage, dann wichtige Mails, dann Schlagzeilen und der Shop, zum Schluss ein Angebot ("Soll ich Discord und Spotify öffnen, Sir?"), wenn es zu seinen Gewohnheiten passt.
