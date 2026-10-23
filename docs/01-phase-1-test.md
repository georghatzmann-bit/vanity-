# Phase 1 – Test-Checkliste (Oberfläche)

In Phase 1 ist nur das **Design** fertig. Die Knöpfe zeigen, wie es später aussieht, starten
aber noch nichts. Fortnite, Backend und DLLs kommen ab Phase 2.

## So bekommst du den Launcher

**Weg A – fertiger Installer (empfohlen):**

1. Auf GitHub im Repo `vanity-` oben auf **Actions** klicken
   (https://github.com/georghatzmann-bit/vanity-/actions).
2. Den obersten Lauf „Launcher“ mit grünem Haken öffnen (Branch `claude/eloquent-wozniak-en0j35`).
3. Ganz unten bei **Artifacts** auf `Vanity-Installer-…` klicken → ZIP herunterladen.
4. ZIP entpacken und `Vanity_0.1.0_x64-setup.exe` starten.
5. Windows zeigt evtl. „Der Computer wurde durch Windows geschützt“, weil der Installer nicht
   signiert ist → **Weitere Informationen** → **Trotzdem ausführen**.
   Installiert wird nur für deinen Benutzer, ohne Admin-Rechte.

**Weg B – selbst bauen:** siehe `README.md` → „Selbst bauen“.

## Was du testen sollst

Hake ab, was passt. Wenn etwas komisch aussieht: Screenshot an mich.

### Fenster
- [ ] Das Fenster hat keinen Windows-Rahmen, sondern eine eigene dunkle Titelleiste.
- [ ] Oben links an der Titelleiste ziehen → das Fenster bewegt sich.
- [ ] Doppelklick auf die Titelleiste → maximiert / wieder klein.
- [ ] Die drei Knöpfe oben rechts: Minimieren, Maximieren, Schließen (rot beim Drüberfahren).
- [ ] Fenster am Rand kleiner ziehen → unter ca. 1200 Pixel Breite wird die Seitenleiste
      schmal (nur Symbole). Beim Drüberfahren erscheint der Name.

### Startseite
- [ ] **Host & Play** klicken → die sieben Schritte laufen nacheinander durch, die drei
      Dienst-Karten werden orange („Startet …“) und dann grün („Läuft“).
- [ ] Während es läuft, auf eine andere Seite und zurück wechseln → der Ablauf läuft weiter.
- [ ] Am Ende erscheint unten rechts „Lobby erreicht (Vorschau)“.
- [ ] **Alles stoppen** → alles wieder grau („Gestoppt“).
- [ ] Unten links in der Seitenleiste zeigt „Dienste“ denselben Zustand.

### Seiten durchklicken
- [ ] **Bibliothek**: Karte für 19.10, „Build hinzufügen“ → „Prüfen“ hakt vier Punkte ab.
- [ ] **Server & Freunde**: Unsinn ins IP-Feld tippen → rote Meldung; `100.101.12.7` → Knopf wird aktiv.
- [ ] **Match-Steuerung**: Reiter Match / Bots / Trickshot, Regler und Schalter bewegen sich.
      Bei Bots „Gegner“ wählen → Schwierigkeit wird aktiv und ein Hinweis erscheint.
- [ ] **Ingame-Menü**: Schalter links ändern die Vorschau rechts. Auf „F9“ klicken, andere
      Taste drücken → wird übernommen (Esc bricht ab).
- [ ] **Profile**: „Neues Profil“ anlegen → erscheint als neue Karte; „Aktivieren“ funktioniert.
- [ ] **Live-Log**: Beispielzeilen laufen ein, Filter (Spiel/Server/…) und Suche funktionieren,
      „Anmeldung erkannt“ ist violett markiert.
- [ ] **Absturz-Analyse**: drei Beispiel-Abstürze, „Technische Details“ klappt auf.
- [ ] **Einstellungen**: „Glas-Effekt“ aus → Flächen werden fest. „Animationen reduzieren“ an
      → Seitenwechsel ohne Bewegung. Beides bleibt nach Neustart von Vanity gespeichert.
- [ ] **Über & Credits**: Klick auf ein Projekt öffnet die Seite im Browser.

### Gefühl
- [ ] Animationen wirken flüssig, nicht träge.
- [ ] Texte sind gut lesbar, nichts ist abgeschnitten oder überlappt.
- [ ] Gefällt dir die Farbe (Violett)? Wenn nicht: sag mir, welche du lieber hättest.

## Rückmeldung

Schreib mir einfach: „Phase 1 läuft“ – oder was dir aufgefallen ist (gern mit Screenshot).
Danach geht es mit **Phase 2** weiter: Build wirklich importieren, Fortnite 19.10 starten,
Live-Log aus dem echten Spiel.
