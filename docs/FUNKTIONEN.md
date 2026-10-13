# PULSAR – Alle Funktionen mit Bildern

Die Bilder stammen aus der Oberfläche im Browser mit Demo-Daten (`node scripts/feature-shots.mjs`).
In der echten App sehen die Seiten genauso aus – nur mit deinen Werten statt der Demo-Zahlen.

> Ehrlich vorweg: Pulsar hat **kein eigenes Servernetz**. Es misst, erklärt und optimiert, was sich auf deinem PC
> optimieren lässt. Einen Ping „umleiten“ kann es nicht – das kann kein Programm ohne eigene Server.

---

## Start

### Startanimation
![Intro](screenshots/funktionen/01-intro.jpg)
Der Pulsar baut sich auf: Kern, Strahlen, Ring, Druckwellen im Takt, Sternenstaub. Danach gleitet das Logo in die
Titelleiste. Abschaltbar unter **Einstellungen → Aussehen → Startanimation**.

---

## Cockpit

### Übersicht
![Cockpit](screenshots/funktionen/02-cockpit.jpg)
- **„Weiterspielen“-Banner** (oben, wie bei NOVA): Hintergrundbild und Logo deines zuletzt gespielten Spiels, Spielzeit, wann zuletzt gespielt, Note der letzten Runde mit Ø-Ping und Spitzen. Knöpfe: **Boost & Spielen**, **Spielen**, **Details**. Oben rechts steht, wohin Pulsar während des Spiels misst. Läuft ein Spiel, zeigt das Banner die laufende Zeit und **Beenden**. Spiele ohne breites Bild bekommen ein schwebendes Cover.
- Das Spielbild färbt den Hintergrund der App leicht ein.
- **Verbindungsnote** (links): A+ bis F aus Ping, Schwankung (Jitter) und Paketverlust. Mit einem Satz, was sie bedeutet.
- **Live-Ping** (Mitte): Messung jede Sekunde zum eingestellten Messziel (Rechenzentrum oder echter Spielserver). Kurve für 60 s, 5 min oder 15 min; Ø, Min, Max, Schwankung, Verlust. Die rote gestrichelte Linie ist deine Warnschwelle.
- **BOOST** (rechts): der große Knopf.
- Oben rechts: Kabel oder WLAN und die Verbindungsgeschwindigkeit.
- In der Seitenleiste: **Zuletzt gespielt** mit Spiel-Icons – Klick öffnet das Spiel, der Play-Knopf startet es mit Boost.

### Kürzlich gespielt, PC-Auslastung, letzte Runde, Favoriten
![Kürzlich gespielt](screenshots/funktionen/02b-cockpit-kuerzlich-gespielt.jpg)
- **Kürzlich gespielt**: Cover-Reihe mit Pfeilen zum Blättern (Überfahren: 3D-Neigung, Lichtreflex, Play-Knopf).
- **PC-Auslastung** (CPU, RAM, GPU) und **Schnellzugriff** auf Regionen, Route, DNS, Speedtest.
- **Letzte Runde**: Bericht mit Ping-Verlauf und Note.
- **Favoriten**: zweite Cover-Reihe mit deinen Lieblingsspielen.

### BOOST
![Boost](screenshots/funktionen/03-cockpit-boost-hover.jpg)
![Boost aktiv](screenshots/funktionen/04-cockpit-boost-aktiv.jpg)
Ein Klick (oder `Strg + B`):
1. **Energieplan auf Höchstleistung** – die CPU darf immer mit vollem Takt laufen.
2. **Spiel bevorzugen** – Windows gibt dem Spielprozess mehr CPU-Zeit (Priorität „Hoch“).
3. **DNS-Zwischenspeicher leeren** – frische Serveradressen.

Jede Aktion wird einzeln gemeldet (grün = erledigt, gelb = nicht möglich, z. B. bei Anti-Cheat-geschützten Spielen).
**Beenden** stellt alles wieder her: den alten Energieplan und die alte Priorität. Auch beim Schließen von Pulsar.
Das Boost-Profil (was genau passiert) stellst du unter **Optimieren** ein.

---

## Spiele

### Übersicht, Hover, Favoriten, Suche
![Spiele](screenshots/funktionen/05-spiele.jpg)
![Hover](screenshots/funktionen/06-spiele-hover.jpg)
![Favoriten](screenshots/funktionen/07-spiele-favoriten.jpg)
![Suche](screenshots/funktionen/08-spiele-suche.jpg)
- Steam-, Epic- und GOG-Spiele werden automatisch gefunden (**Automatisch suchen**), alles andere per **Manuell hinzufügen** oder indem du eine `.exe` ins Fenster ziehst.
- Cover, Hintergrundbilder, Logos und Icons kommen von Steam bzw. aus der Programmdatei – ohne Anmeldung.
- Beim Überfahren: **Boost & Spielen** (startet Boost + Spiel) oder nur **Spielen**.
- Filter: Spiele/Programme, Favoriten, Quelle; Sortierung; Kachelgröße; Liste oder Raster. Suche findet auch Abkürzungen („cs2“).

### Spiel-Seite
![Spiel](screenshots/funktionen/09-spiel-uebersicht.jpg)
![Messziel](screenshots/funktionen/10-spiel-messziel.jpg)
![Berichte](screenshots/funktionen/11-spiel-berichte.jpg)
![Spiel-Einstellungen](screenshots/funktionen/12-spiel-einstellungen.jpg)
- Kopf: Cover, Logo, Quelle, Verbindungsnote der letzten Runde, **Boost & Spielen**, Favorit, Menü.
- Kennzahlen: Spielzeit gesamt, letzte Sitzung, Sitzungen, zuletzt gespielt, Ø Ping.
- **Übersicht:** Spielzeit der letzten 30 Tage, letzte Runde, **Messziel für dieses Spiel** (Region) und **echte Spielserver** für Counter-Strike 2, Dota 2, Deadlock und League of Legends – Pulsar misst dann die Server des Spiels.
- **Berichte:** alle Runden dieses Spiels.
- **Einstellungen:** Auto-Boost nur für dieses Spiel, eigenes Boost-Profil, Startart (.exe, Link, Verknüpfung), Startparameter, Arbeitsordner, zusätzliche Prozessnamen (für Launcher-Spiele), Name, Art, Bilder (automatisch oder eigene).

---

## Netzwerk

### Regionen
![Regionen](screenshots/funktionen/13-netzwerk-regionen.jpg)
![Regionen gemessen](screenshots/funktionen/14-netzwerk-regionen-gemessen.jpg)
Ping zu rund 25 Rechenzentren weltweit (AWS), nach Erdteil sortiert, mit Note, Schwankung und Verlust.
**Favoriten messen** oder **Alle messen**; die beste Region wird hervorgehoben. **Als Messziel** macht sie zum Ziel des Live-Pings im Cockpit.
Rechts: **Echte Spielserver** – Valve (CS2, Dota 2, Deadlock) und Riot (LoL) veröffentlichen die Adressen ihrer Server; Pulsar misst sie direkt. Die Auswahl zeigt das Icon des Spiels, wenn es in deiner Liste ist.

### Route
![Route](screenshots/funktionen/15-netzwerk-route.jpg)
Station für Station zum Ziel. Jede Station ist eingeordnet: **Dein Netz** (Router/WLAN), **Dein Anbieter**, **Internet**, **Ziel** – vor der ersten Analyse erklärt eine kleine Grafik die vier Zonen. Schnellziele: aktuelles Messziel, Cloudflare, Google, Steam.
Das Fazit sagt dir in einem Satz, wo der größte Sprung passiert – und was du daran ändern kannst.

### DNS
![DNS](screenshots/funktionen/16-netzwerk-dns.jpg)
![DNS-Ergebnis](screenshots/funktionen/17-netzwerk-dns-ergebnis.jpg)
![DNS eingestellt](screenshots/funktionen/17b-netzwerk-dns-eingestellt.jpg)
Vergleicht Cloudflare, Google, Quad9, OpenDNS, AdGuard, DNS0.eu, Mullvad und deinen aktuellen DNS – jeweils für neue und bekannte Adressen. Vor dem ersten Vergleich zeigt die Seite, welche Dienste geprüft werden. Sie zeigt auch, was gerade eingestellt ist (z. B. „automatisch vom Router“).
- **Empfehlung:** Ist ein Dienst deutlich schneller als deiner (mindestens 15 % und 3 ms), schlägt Pulsar ihn vor – **Schnellsten einstellen** stellt ihn für deine Hauptverbindung ein. Sonst steht dort „Dein DNS ist schon schnell“. Jeden anderen Dienst kannst du mit **Einstellen** in seiner Zeile wählen.
- **Sicher:** Pulsar prüft vorher, ob der Dienst gerade antwortet, und sichert deine alte Einstellung. Für den Wechsel fragt Windows einmal nach (Adminrechte); sagst du **Nein**, ändert sich nichts. Danach steht beim Dienst „Von Pulsar eingestellt“.
- **Zurückstellen** holt die alte Einstellung jederzeit exakt zurück – beim Deinstallieren automatisch.
- Kann Pulsar den DNS auf einem PC nicht selbst einstellen (dafür braucht es Windows 10 Version 2004 oder neuer), zeigt die Seite die **Schritt-für-Schritt-Anleitung** fürs Eintragen von Hand mit Knopf, der die Netzwerkeinstellungen öffnet.

Ehrlich dazu: Ein schnellerer DNS beschleunigt nur das Nachschlagen von Adressen – Spielstarts, Shop und Matchmaking werden etwas flotter. Am Ping im Spiel ändert er nichts.

### Speedtest mit Bufferbloat-Note
![Speedtest läuft](screenshots/funktionen/18-netzwerk-speedtest-laeuft.jpg)
![Speedtest-Ergebnis](screenshots/funktionen/19-netzwerk-speedtest-ergebnis.jpg)
Download und Upload (über Cloudflare) – und das Wichtigste fürs Spielen: **Wie stark steigt dein Ping, wenn die Leitung ausgelastet ist?**
Das ist Bufferbloat, der häufigste Grund für Lags, „obwohl das Internet schnell ist“. Note A+ bis F mit Erklärung; vor dem ersten Test zeigt die Seite die Notenskala (A+ unter 5 ms Anstieg … F ab 400 ms).

### Verbindung
![Verbindung](screenshots/funktionen/20-netzwerk-verbindung.jpg)
Alle Netzwerkadapter mit Geschwindigkeit, IP, Router und DNS; die Hauptverbindung ist markiert.
Bei WLAN: Signalstärke als Ring, Band (2,4/5/6 GHz), Kanal, Standard, Datenrate – plus Tipps (z. B. „Für Online-Spiele ist ein Kabel die beste Wahl“).

---

## Optimieren
![Optimieren](screenshots/funktionen/21-optimieren.jpg)
![Angewendet](screenshots/funktionen/22-optimieren-angewendet.jpg)
Sechs Einstellungen mit ehrlicher Wirkung – jede mit Schalter, Wirkung (hoch/mittel/klein) und **Rückgängig**:
- **Energieplan „Höchstleistung“**
- **Windows-Spielmodus**
- **Game-Bar-Aufnahme aus**
- **Mausbeschleunigung aus**
- **TCP-Pakete sofort senden** („Nagle aus“) – hilft nur Spielen, die TCP nutzen; die meisten Shooter nutzen UDP
- **Netzwerk-Drosselung aus** – Windows bremst das Netzwerk nicht mehr, während Musik oder Videos laufen; bringt meist nur wenig

Die ersten vier gehen ohne Adminrechte. Die zwei Netzwerk-Einstellungen tragen die Hinweise **Windows fragt nach**
(dafür braucht Pulsar kurz Adminrechte – mehrere davon zusammen mit einer einzigen Abfrage) und **Neustart nötig**
(sie wirken erst nach einem Neustart von Windows).
Pulsar sichert vor jeder Änderung den Originalwert und stellt ihn exakt wieder her (**Alles zurückstellen** oben rechts).
Rechts: Energieplan wählen, DNS-Zwischenspeicher leeren und das **Boost-Profil** (Energieplan, Priorität, DNS – was der BOOST-Knopf macht).

### Netzwerk automatisch optimieren
![Netzwerk automatisch optimieren](screenshots/funktionen/21b-optimieren-netzwerk-auto.jpg)
![Netzwerk optimiert](screenshots/funktionen/21c-optimieren-netzwerk-fertig.jpg)
Die Karte oben auf der Seite erledigt DNS und Netzwerk in einem Rutsch:
1. **Jetzt prüfen** vergleicht die DNS-Dienste (etwa 15 Sekunden) und prüft die zwei Netzwerk-Einstellungen. Dabei ändert Pulsar noch nichts.
2. Der Plan **„Das schlägt Pulsar vor“** zeigt jeden Punkt mit Schalter – nur eingeschaltete Punkte werden geändert:
   - **DNS-Dienst wechseln**, z. B. „Router → Cloudflare“ mit den gemessenen Zeiten (neu gegen alt) – nur, wenn ein Dienst deutlich schneller ist (mindestens 15 % und 3 ms), sonst „Dein DNS ist schon schnell – bleibt“. Die Automatik wählt nur Cloudflare, Google, Quad9 oder OpenDNS. Hast du selbst einen anderen bekannten Dienst gewählt (z. B. AdGuard), ist der Wechsel ausgeschaltet.
   - **TCP-Pakete sofort senden** und **Netzwerk-Drosselung aus**, falls sie noch nicht eingestellt sind.
3. **Jetzt einstellen** ändert alles Eingeschaltete mit **einer** Windows-Abfrage. Lehnst du ab, ändert sich nichts.
4. Das Ergebnis zeigt jeden Punkt einzeln (**Erledigt** oder **Nicht geändert** mit Grund) und den Hinweis **Neustart nötig** für die Netzwerk-Einstellungen. Der neue DNS gilt sofort, der DNS-Zwischenspeicher wird geleert.

Danach zeigt die Karte, was Pulsar eingestellt hat, und **Alles zurückstellen** holt DNS und die zwei Netzwerk-Einstellungen
exakt zurück – wieder mit einer Windows-Abfrage. Beim Deinstallieren passiert das automatisch.
Ehrlich dazu: Ein schnellerer DNS beschleunigt das Laden und Verbinden (Spielstart, Shop, Matchmaking), den Ping im Spiel ändert er nicht.
Die zwei Netzwerk-Einstellungen bringen meist nur wenig und wirken erst nach einem Neustart.

---

## Berichte
![Berichte](screenshots/funktionen/23-berichte.jpg)
Jede Spielrunde bekommt einen Bericht: Note, Ping-Verlauf, Ø/Max, Spitzen, Verlust, Messziel, ob geboostet.
Oben: beste und schlechteste Runde und der Trend der letzten Runden.

---

## Einstellungen
![Aussehen](screenshots/funktionen/24-einstellungen-aussehen.jpg)
![Messung](screenshots/funktionen/25-einstellungen-messung.jpg)
![Overlay](screenshots/funktionen/26-einstellungen-overlay.jpg)
![Über Pulsar](screenshots/funktionen/27-einstellungen-ueber.jpg)
- **Aussehen:** 4 Themes (Pulsar, Glut, Toxic, Frost) mit Lichtkreis-Übergang, eigene Akzentfarbe, Animationen (voll/verringert/aus), Startanimation, Sprache.
- **Sound:** alle Klänge werden live erzeugt (keine Dateien); Lautstärke, Hover-Töne, Probehören.
- **Messung:** Messziel im Cockpit, Messabstand, Warnschwelle, Windows-Benachrichtigungen.
- **Boost:** automatisch boosten, sobald ein Spiel startet.
- **Overlay:** an/aus, Tastenkürzel (aufnehmen), Ecke, Deckkraft, angezeigte Werte.
- **Verhalten:** Schließen minimiert in den Infobereich, mit Windows starten.
- **Spiele:** beim Start nach neuen Spielen suchen, SteamGridDB-Schlüssel (freiwillig).
- **Daten & Sicherung:** automatische Backups (täglich, die letzten 10) wiederherstellen, jetzt sichern, Bild-Zwischenspeicher leeren.
- **Über Pulsar:** Version, Update prüfen und **Jetzt aktualisieren**, Datenordner, Tastenkürzel.

---

## Weitere Funktionen

### Befehlspalette
![Befehlspalette](screenshots/funktionen/28-befehlspalette.jpg)
`Strg + K` oder `/`: Spiele starten, Seiten öffnen, Boost, Speedtest, Route, Netzwerk automatisch optimieren, Theme wechseln – alles per Tastatur.

### Spiele automatisch finden
![Suchen](screenshots/funktionen/29-spiele-suchen.jpg)
Steam, Epic, GOG, Startmenü und eigene Ordner. Radar-Animation, Doppelte werden erkannt, Vorauswahl der neuen Spiele.

### Manuell hinzufügen
![Manuell](screenshots/funktionen/30-manuell-hinzufuegen.jpg)
Programm, Link (z. B. `steam://`) oder Verknüpfung – mit Startparametern.

### Boost & Spielen (Start-Ritual)
![Start-Ritual](screenshots/funktionen/31-boost-und-spielen.jpg)
Cover zoomt ins Zentrum, Lichtringe, Partikel – währenddessen wird der Boost aktiviert und das Spiel gestartet. Pulsar misst mit und erstellt danach den Bericht.

### Themes
![Glut](screenshots/funktionen/32-theme-ember.jpg)
![Toxic](screenshots/funktionen/32-theme-toxic.jpg)
![Frost](screenshots/funktionen/32-theme-frost.jpg)

### Overlay im Spiel
![Overlay](screenshots/funktionen/33-overlay.jpg)
`Alt + Shift + P`: kleines, durchsichtiges Fenster mit Note, Ping, Schwankung, Verlust, CPU/GPU/RAM und Uhr – immer im Vordergrund, verschiebbar, Ecke und Deckkraft einstellbar. Funktioniert im Fenster- und randlosen Modus (nicht im exklusiven Vollbild).

### Infobereich (Tray)
Pulsar läuft neben der Uhr weiter: Boost an/aus, Speedtest, zuletzt gespielte Spiele starten, Fenster öffnen.

---

## Der Installer

![Intro](screenshots/funktionen/40-setup-intro.jpg)
![Willkommen](screenshots/funktionen/41-setup-willkommen.jpg)
![Ordner](screenshots/funktionen/42-setup-ordner.jpg)
![Optionen](screenshots/funktionen/43-setup-optionen.jpg)
![Download](screenshots/funktionen/44-setup-download.jpg)
![Fertig](screenshots/funktionen/45-setup-fertig.jpg)
![Fehler](screenshots/funktionen/46-setup-fehler.jpg)
![Wartung](screenshots/funktionen/47-setup-wartung.jpg)
![Deinstallieren](screenshots/funktionen/48-setup-deinstallieren.jpg)

- **Intro** mit Druckwellen, Sternenstaub und „Signal wird aufgebaut … Signal steht.“ (mit Ton, abschaltbar).
- **Willkommen** → **Speicherort** (freier Platz, Adminrechte nur wenn nötig) → **Optionen** (Desktop, Startmenü, Autostart, danach starten) → **Installation**.
- Download mit Fortschrittsring, Tempo, Restzeit und wechselnden Tipps; SHA-256-Prüfung; Verknüpfungen; Eintrag in „Apps & Features“.
- Bricht das Internet ab: **Erneut versuchen** setzt den Download an der Stelle fort.
- Ist Pulsar schon installiert: **Aktualisieren/Reparieren** oder **Deinstallieren** (mit „Meine Daten behalten“). Vor dem Löschen stellt der Deinstaller alle Windows-Einstellungen zurück, die Pulsar geändert hat (DNS und Optimierungen) – braucht das Adminrechte, fragt Windows einmal nach.
