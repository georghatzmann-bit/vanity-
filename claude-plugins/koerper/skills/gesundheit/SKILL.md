---
description: Gesundheits-Übersicht (Medical Hub wie im Video) - Schlaf, HRV, Ruhepuls, Gewicht und Schritte eintragen oder aus Exporten (Apple Health, Garmin, Whoop, Oura) übernehmen, Erholung heute einschätzen, Verlauf zeigen. Nimm es bei Schlaf, Puls, HRV, Gewicht, Erholung oder "Wie geht es meinem Körper?". Keine Diagnosen.
---

# Gesundheits-Übersicht

Der Ordner ist `${user_config.ordner}` (steht dort `~`, ist das Benutzerverzeichnis). Darin `gesundheit.csv` mit der
Kopfzeile `datum,schlaf_h,hrv_ms,ruhepuls,gewicht_kg,schritte,notiz,quelle` (eine Zeile je Tag, das Datum ist der
Morgen nach der Nacht, Punkt als Dezimalzeichen, leere Felder erlaubt). Gibt es den Tag schon, ergänze die Zeile.

## Eintragen

- Von Hand: "Heute 7 Stunden geschlafen, HRV 58, Ruhepuls 52" (quelle: Angabe).
- Aus einem Export, wenn der Nutzer eine Datei nennt:
  - Apple Health: In der Health-App auf das Profilbild, "Alle Gesundheitsdaten exportieren", die `export.zip`
    auf den PC. Die Datei `export.xml` ist groß: lies sie mit einem kleinen Skript Stück für Stück (zum Beispiel Python
    mit `xml.etree.ElementTree.iterparse`), nimm `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` (HRV, Tagesschnitt),
    `HKQuantityTypeIdentifierRestingHeartRate`, `HKCategoryTypeIdentifierSleepAnalysis` (Schlafphasen zusammenzählen),
    `HKQuantityTypeIdentifierBodyMass` und `HKQuantityTypeIdentifierStepCount` (Tagessumme).
  - Garmin Connect, Whoop, Oura: deren CSV-Export, Spalten passend zuordnen.
  Übernimm nur die letzten 90 Tage, außer der Nutzer will mehr (quelle: der Dienst).

## Erholung heute

Vergleiche den neuesten Tag mit dem Median der sieben Tage davor:
- **gut**: HRV mindestens 95 Prozent vom Median, Ruhepuls höchstens 3 Schläge darüber, Schlaf mindestens 7 Stunden
- **eher niedrig**: HRV unter 85 Prozent, oder Ruhepuls 5 und mehr Schläge darüber, oder unter 6 Stunden Schlaf
- sonst **mittel**
Fehlen Werte, nimm, was da ist, und sag, worauf die Einschätzung beruht. Antworte in einem Satz wie ein Assistent
("Ihre Erholung ist heute gut: HRV 62 statt sonst 58, Ruhepuls normal, 7,5 Stunden Schlaf") und schlag passend zum
Ergebnis etwas vor (leichtes Training, früher schlafen).

## Verlauf

"Wie war die Woche?": Schnitt, bester und schlechtester Tag je Wert, Trend gegen die Woche davor. Gewicht als
7-Tage-Schnitt, damit Tagesschwankungen nicht täuschen.

## Grenzen

Das ist eine Übersicht für den Alltag, keine Diagnose. Bei Brustschmerzen, Atemnot, Ohnmacht, sehr hohem oder sehr
niedrigem Puls oder wenn sich etwas ernsthaft falsch anfühlt: sag klar, dass der Nutzer ärztliche Hilfe holen soll
(Notruf 112 bei akuten Beschwerden), statt die Werte zu deuten.
