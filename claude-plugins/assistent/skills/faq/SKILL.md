---
description: Beantwortet Kundenfragen und wiederkehrende Fragen aus einer eigenen FAQ-Datei (wie im Video - damit gehen etwa 90 Prozent der Fragen ohne Nachdenken) und pflegt diese Datei. Nimm es bei /assistent:faq, wenn eine Kundenanfrage zu beantworten ist, und wenn der Nutzer eine neue Antwort festhalten will.
---

# FAQ-Datei

Die Datei liegt in `${user_config.ordner}/FAQ.md` (steht dort `~`, ist das Benutzerverzeichnis). Sie gehört dem
Nutzer: Er kann sie jederzeit selbst bearbeiten.

## Aufbau der Datei

```markdown
# FAQ

## Versand
### Wie lange dauert der Versand?
2 bis 4 Werktage innerhalb Deutschlands. Ab 50 Euro versandkostenfrei.
Stand: 2026-10-03
```

Abschnitte nach Thema (Versand, Zahlung, Rückgabe, Produkte, Sonstiges), jede Frage als `###`, darunter die Antwort
und die Zeile `Stand:` mit dem Datum.

## Eine Frage beantworten

1. Lies die FAQ-Datei. Gibt es sie noch nicht, lege sie mit dem Aufbau oben und den Abschnitten an (ohne Inhalte zu
   erfinden) und sag dem Nutzer, dass er die ersten Antworten diktieren kann.
2. Passt eine Antwort, formuliere daraus eine freundliche, kurze Antwort an den Kunden (Sie-Form, ohne Floskeln).
   Ist die Antwort älter als 6 Monate (`Stand:`), weise den Nutzer darauf hin.
3. Passt keine, erfinde nichts. Schreib einen Entwurf mit [bitte ergänzen] an der Stelle und frag den Nutzer nach der
   richtigen Antwort. Danach: in die FAQ aufnehmen (siehe unten).
4. Antworten an Kunden schickst du nie selbst ab. Du lieferst den Text oder legst einen Entwurf an.

## Eine Antwort festhalten

Sagt der Nutzer "Nimm das in die FAQ auf" oder beantwortet er eine offene Frage: Trag sie im passenden Abschnitt ein
(gibt es die Frage schon, ersetze die Antwort), mit heutigem Datum bei `Stand:`. Sag in einem Satz, was jetzt drinsteht.
