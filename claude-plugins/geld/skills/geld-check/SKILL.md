---
description: Der tägliche Geld-Check - Shop (Shopify) und Werbung (Windsor.ai) auswerten und genau drei konkrete Vorschläge machen, die Umsatz bringen oder Kosten sparen, mit ehrlicher Schätzung. Umsetzen nur nach Ja. Nimm es bei /geld:geld-check, "Wie verdiene ich mehr?", "Was bringt mir heute Geld?" und für geplante Geld-Checks.
---

# Geld-Check

Ehrlich vorweg: Es gibt kein Geld "von allein". Was geht: Claude findet jeden Tag die Stellen, an denen der Shop oder
die Werbung Geld liegen lässt, rechnet nach und bereitet alles so vor, dass der Nutzer nur noch Ja sagen muss.

## Daten holen

Gleichzeitig (Agent-Werkzeug, wenn das Plugin Assistent installiert ist, sonst selbst über die Konnektoren):
- **Shop** (`assistent:shop` oder Shopify-Konnektor): Umsatz und Bestellungen der letzten 7 Tage gegen die 7 davor,
  Konversionsrate falls verfügbar, abgebrochene Warenkörbe, Bestseller, Ladenhüter (30 Tage ohne Verkauf), Bestand.
- **Werbung** (`assistent:werbung` oder Windsor.ai-Konnektor): Ausgaben, Umsatz und ROAS je Kampagne, 7 gegen 7 Tage.
Fehlt beides, sag in einem Satz, welche Konnektoren der Nutzer auf claude.ai verbinden kann, und hör auf.

## Drei Vorschläge

Such nach diesen Hebeln, in dieser Reihenfolge, und nimm die drei mit dem größten erwarteten Effekt:
1. Werbung, die Geld verbrennt: Kampagnen mit ROAS unter 1,5 über 7 Tage bei nennenswerten Ausgaben: pausieren oder
   Budget halbieren. Gute Kampagnen (ROAS über 3, stabil): Budget um 20 Prozent erhöhen.
2. Fast leere Bestseller nachbestellen (verkaufte Stück pro Tag mal Lieferzeit).
3. Abgebrochene Warenkörbe: eine Erinnerungs-Mail oder ein kleiner Rabatt, wenn noch nicht eingerichtet.
4. Ladenhüter: Bündel, Rabatt oder bessere Produkttexte (Skill produkt-texte).
5. Preise: nur mit Begründung (Mitbewerber über die Websuche, Marge), höchstens 10 Prozent auf einmal.

Jeder Vorschlag: **was** genau (Produkt, Kampagne), **warum** (die Zahl dahinter), **was es bringen könnte** als
Spanne in Euro pro Monat mit Annahme, **Risiko** in einem Halbsatz. Ist die Datenlage dünn (zum Beispiel unter 20
Bestellungen), sag das und schätz vorsichtig.

## Umsetzen

Frag am Ende: "Welche soll ich umsetzen?" Erst nach einem ausdrücklichen Ja für genau diesen Vorschlag änderst du etwas
über die Konnektoren (Budget, Rabatt, Text). Geld ausgeben, Preise ändern und Rabatte anlegen nie ohne dieses Ja.
Löschen, Erstatten und Bezahlen machst du nie selbst.

Speichere den Check als `${user_config.ordner}/Geld-Check <JJJJ-MM-TT>.md` (steht dort `~`, ist das
Benutzerverzeichnis), mit den Vorschlägen und später, was umgesetzt wurde. Beim nächsten Check: Hat ein umgesetzter
Vorschlag etwas gebracht? Sag es ehrlich, auch wenn nicht.
