---
description: Ernährungs-Tagebuch - aus einem Essensfoto oder einer Beschreibung Mengen schätzen, Nährwerte (kcal, Eiweiß, Kohlenhydrate, Fett) ausrechnen und eintragen, Tagessumme gegen die Ziele. Nimm es, wenn der Nutzer ein Foto von Essen schickt, sagt, was er gegessen hat, oder nach Kalorien, Eiweiß oder seiner Ernährung fragt.
---

# Ernährungs-Tagebuch

Der Ordner ist `${user_config.ordner}` (steht dort `~`, ist das Benutzerverzeichnis, unter Windows `%USERPROFILE%`).
Darin:
- `ernaehrung.csv` mit der Kopfzeile
  `datum,uhrzeit,mahlzeit,lebensmittel,menge_g,kcal,eiweiss_g,kohlenhydrate_g,fett_g,quelle`
  (Komma getrennt, Punkt als Dezimalzeichen, Text mit Komma in Anführungszeichen, UTF-8)
- `Ernährung/<JJJJ-MM-TT>.md`: der Tag zum Lesen (Tabelle wie unten)
- `Ziele.md` (optional): Tagesziele, zum Beispiel `kcal: 2400`, `eiweiss_g: 160`

Fehlt etwas, leg es an. Lösch nie Zeilen, die nicht von dieser Mahlzeit stammen.

## Eine Mahlzeit eintragen

1. **Erkennen**: Sieh dir das Foto an (Read-Werkzeug) oder nimm die Beschreibung. Zähl jedes Lebensmittel einzeln auf,
   auch Soßen, Öl, Getränke.
2. **Menge schätzen** in Gramm (Getränke in Milliliter). Anhaltspunkte: Tellergröße (flacher Teller etwa 26 cm),
   Besteck, Hand, Verpackung. Übliche Portionen stehen in `portionen.md` neben dieser Anleitung.
3. **Nährwerte**: Steht ein Etikett auf dem Foto, nimm das (quelle: Etikett). Sonst die Richtwerte aus `naehrwerte.md`
   neben dieser Anleitung (quelle: Schätzung). Fehlt ein Lebensmittel dort, such es mit der Websuche (quelle: Web).
   Rechne: Wert je 100 g mal Menge durch 100, auf ganze kcal und eine Nachkommastelle bei Gramm runden.
4. **Mahlzeit** aus der Uhrzeit: bis 10:30 Frühstück, bis 14:30 Mittagessen, bis 17:30 Snack, danach Abendessen,
   außer der Nutzer sagt es anders.
5. **Eintragen**: je Lebensmittel eine Zeile in `ernaehrung.csv`, dazu die Tagesdatei:

   ```markdown
   # Ernährung 2026-10-03

   | Uhrzeit | Mahlzeit | Lebensmittel | Menge | kcal | Eiweiß | KH | Fett |
   |---|---|---|---|---|---|---|---|
   | 12:40 | Mittagessen | Nudeln mit Tomatensoße | 300 g | 465 | 15,9 g | 90 g | 4,5 g |

   **Summe:** 465 kcal · 15,9 g Eiweiß · 90 g Kohlenhydrate · 4,5 g Fett
   ```
6. **Antwort** (kurz, wie im Chat): was du erkannt hast mit Menge, die Summe der Mahlzeit, der Tag bisher gegen die
   Ziele ("Heute 1450 von 2400 kcal, Eiweiß 95 von 160 g"). Sag ehrlich, wo die Schätzung unsicher ist
   ("Die Soße kann ich nur raten, eher 50 bis 100 g"). Nachfragen nur, wenn du gar nicht erkennen kannst, was es ist.

## Korrigieren und Fragen

- "Das waren eher 200 g": die Zeilen dieser Mahlzeit in CSV und Tagesdatei ersetzen, Summe neu.
- "Wie viel Eiweiß hatte ich heute?", "Wie war die Woche?": aus `ernaehrung.csv` rechnen (Tag, Schnitt der letzten
  sieben Tage, Tage über oder unter dem Ziel).
- Ziele festlegen: in `Ziele.md` speichern. Ohne Ziele nur Summen zeigen und einmal anbieten, Ziele festzulegen.

## Grenzen

Das ist eine Schätzung für den Alltag, keine medizinische Ernährungsberatung. Bei Diabetes, Essstörungen,
Schwangerschaft oder Allergien keine Ziele vorschlagen, sondern auf Ärztin oder Ernährungsberatung verweisen.
