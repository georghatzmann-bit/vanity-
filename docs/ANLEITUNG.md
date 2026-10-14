# PULSAR – Anleitung in einfachen Worten

Hier steht, wie du Pulsar installierst, was die Knöpfe machen, wie du die Dateien hochlädst und wie du die
Download-Adresse einstellst. Du brauchst dafür keine Programmierkenntnisse.

## Der schnellste Weg

1. Lade den Installer herunter:
   `https://github.com/georghatzmann-bit/vanity-/releases/download/pulsar-latest/Pulsar-Setup.exe`
2. Doppelklick auf die Datei. Bei der blauen Windows-Warnung: **Weitere Informationen** → **Trotzdem ausführen**.
3. Durch den Installer klicken. **Geklappt**, wenn „Pulsar ist bereit!“ erscheint.

---

## 1. Was ist was?

| Datei | Wofür |
|---|---|
| `Pulsar-Setup.exe` | Der Installer. Diese Datei gibst du weiter oder startest sie selbst. Sie lädt die App aus dem Internet. |
| `Pulsar.exe` | Die eigentliche App. Die lädt der Installer herunter. Du kannst sie aber auch direkt starten. |
| `latest.json` | Ein kleiner Zettel für den Installer: Welche Version ist aktuell, wo liegt die App, und ihr „Fingerabdruck“ (Prüfsumme), damit niemand eine falsche Datei unterschieben kann. |

Alle drei Dateien entstehen zusammen im Ordner `release/`.

---

## 2. Pulsar in 2 Minuten verstehen

**Cockpit** – Das siehst du nach dem Start. Links die **Verbindungsnote** (A+ ist perfekt, F ist kritisch),
in der Mitte dein **Live-Ping** als Kurve, rechts der große **BOOST**-Knopf.

**BOOST** – Ein Klick macht deinen PC bereit zum Spielen:
1. Energieplan auf Höchstleistung (die CPU darf immer mit vollem Takt laufen)
2. Dein Spiel bekommt Vorrang vor anderen Programmen
3. DNS-Zwischenspeicher wird geleert (frische Serveradressen)

Noch ein Klick (oder das Spiel endet) – und Pulsar stellt **alles wieder so her, wie es war**.
Tastenkürzel: `Strg + B`, auch mitten im Spiel.

**Boost & Spielen** – Auf der Spiele-Seite: startet den Boost **und** das Spiel. Während du spielst, misst Pulsar
den Ping zu dem Server, den du für das Spiel eingestellt hast. Danach gibt es einen **Bericht** mit Note.

**Was Pulsar ehrlich NICHT kann:** Pulsar hat kein eigenes Servernetz. Es kann deinen Ping also nicht
„umleiten“ oder verkürzen – das kann kein Programm ohne eigene Server. Pulsar zeigt dir stattdessen genau,
**wo** es hakt (dein WLAN? dein Anbieter? das Internet?) und räumt auf deinem PC alles aus dem Weg, was bremst.

---

## 3. Die Seiten im Überblick

| Seite | Was du dort machst |
|---|---|
| **Cockpit** | Note, Live-Ping, Boost, PC-Auslastung, letzte Runde, Schnellzugriff. Bei einem Ausreißer zeigt der **Lag-Detektiv** neben dem Ping die vermutete Ursache. Der Kopfhörer-Knopf **Hör dein Netz** macht den Ping hörbar |
| **Spiele** | Deine Spiele (automatisch gefunden oder per Hand). Pro Spiel: Messziel, echte Spielserver, Auto-Boost |
| **Netzwerk → Regionen** | Ping zu Rechenzentren weltweit. Die beste Region als Messziel fürs Cockpit setzen |
| **Netzwerk → Route** | Station für Station: Wo auf dem Weg zum Server hängt es? Pulsar sagt dir: Heimnetz, Anbieter oder Internet |
| **Netzwerk → DNS** | Vergleicht DNS-Dienste (Cloudflare, Google, Quad9 …) und stellt auf Knopfdruck den schnellsten ein (Knopf mit dem Namen des Dienstes, z. B. **Cloudflare einstellen** – Windows fragt einmal nach). **Zurückstellen** holt deine alte Einstellung jederzeit zurück |
| **Netzwerk → Speedtest** | Download, Upload und die **Bufferbloat-Note**: Wie stark steigt dein Ping, wenn die Leitung ausgelastet ist? |
| **Netzwerk → Verbindung** | Kabel oder WLAN? Signalstärke, Band, Kanal, Adapter, Gateway, DNS. Darunter die Karte **Lag-Detektiv** mit den letzten Ausreißern und warum Pulsar welche Ursache vermutet |
| **Netzwerk → WLAN** | WLAN-Netze in der Nähe, wie voll die Kanäle sind und welcher Kanal für deinen Router besser wäre. Dazu der **Raum-Scan**: in mehreren Räumen messen und den besten Platz finden |
| **Netzwerk → Warum laggt es?** | Eine geführte Prüfung von etwa einer Minute. Danach sagt Pulsar in einem Satz, was es vermutet, und was du tun kannst (Anleitung unten) |
| **Optimieren** | **Netzwerk automatisch optimieren** (siehe unten), sechs Windows-Einstellungen mit Schalter – jede mit **Rückgängig**. Energieplan, Boost-Profil. **Alles zurückstellen** oben auf der Seite stellt den DNS und alle Optimierungen zurück |
| **Berichte → Runden** | Jede Spielrunde: Ping-Verlauf, Spitzen, Verlust, Note. Klick auf eine Runde öffnet die **Match-Zeitleiste**; dort speichert **Als Bild speichern** die Runde als Bild (PNG) zum Teilen |
| **Berichte → Kalender** | Wann war deine Verbindung bisher am ruhigsten? Wochentag × Uhrzeit, gefärbt nach Note – ein Rückblick, keine Vorhersage |
| **Berichte → Anbieter-Protokoll** | Aussetzer, Paketverlust, langsame Zeiten und Speedtests mit Uhrzeit. Als HTML (zum Drucken) oder CSV speichern |
| **Berichte → Ausreißer** | Wie oft welche Ursache in den letzten 30 Tagen vermutet wurde |
| **Einstellungen** | Aussehen (4 Themes), Sound (mit **Hör dein Netz**), Messung (mit Momentaufnahmen und deinen Vertragswerten), Boost, Overlay, Verhalten, Spiele, Daten (mit **Messverlauf löschen**), Über |

**Overlay:** `Alt + Shift + P` blendet ein kleines Fenster mit Ping, Schwankung, Verlust und Auslastung über dem
Spiel ein (funktioniert im Fenster- und randlosen Modus, nicht im exklusiven Vollbild).

### Netzwerk automatisch optimieren

Pulsar sucht den schnellsten DNS-Dienst und prüft zwei Netzwerk-Einstellungen von Windows. Du siehst vorher genau,
was sich ändert, und alles lässt sich exakt zurückstellen.

1. Links auf **Optimieren** klicken.
2. In der Karte **Netzwerk automatisch optimieren** auf **Jetzt prüfen** klicken. Pulsar vergleicht etwa
   15 Sekunden lang die DNS-Dienste. Dabei ändert es noch nichts.
3. Den Plan prüfen („Das schlägt Pulsar vor“). Jeder Punkt hat einen Schalter – nur eingeschaltete Punkte werden geändert:
   - **DNS-Dienst wechseln** – nur, wenn ein Dienst deutlich schneller ist als deiner (mindestens 15 % und 3 ms).
     Sonst steht dort „Dein DNS ist schon schnell – bleibt“.
   - **TCP-Pakete sofort senden** – hilft nur Spielen, die TCP nutzen. Die meisten Shooter nutzen UDP.
   - **Netzwerk-Drosselung aus** – bringt meist nur wenig.
4. Auf **Jetzt einstellen** klicken.
5. Windows fragt, ob die App Änderungen an deinem Gerät vornehmen darf → **Ja**.
   Weil Pulsar nicht digital signiert ist, nennt Windows den Herausgeber „unbekannt“ – das ist bei Pulsar normal.
   Klickst du **Nein**, ändert sich nichts.

**Geklappt**, wenn „Fertig – alles eingestellt“ erscheint und jeder Punkt „Erledigt“ zeigt. Der neue DNS gilt sofort:
Unter **Netzwerk → DNS** steht bei ihm „Von Pulsar eingestellt“. Die zwei Netzwerk-Einstellungen wirken erst
**nach einem Neustart** von Windows.

**Zurückstellen:** In derselben Karte auf **Netzwerk zurückstellen** klicken und die Windows-Abfrage mit **Ja** bestätigen.
Den Knopf zeigt die Karte direkt nach dem Einstellen und auch später, solange Pulsar etwas eingestellt hat.
Dann sind DNS und die zwei Netzwerk-Einstellungen wieder genau wie vorher (die Netzwerk-Einstellungen nach dem nächsten Neustart).
**Geklappt**, wenn „Zurückgestellt“ erscheint.

**Ehrlich:** Ein schnellerer DNS beschleunigt nur das Nachschlagen von Adressen – Spielstart, Shop, Matchmaking und
Webseiten laden etwas flotter. Den Ping **im** Spiel ändert er nicht. Die zwei Netzwerk-Einstellungen bringen meist nur wenig.

### „Warum laggt es?“ – Schritt für Schritt

Am besten prüfst du dann, wenn es gerade laggt. Spiel vorher schließen oder pausieren.

1. Links auf **Netzwerk** klicken, dann oben auf den Reiter **Warum laggt es?**
   (oder im Cockpit beim Schnellzugriff auf **Warum laggt es?**, oder `Strg + K` und „laggt“ tippen).
2. Schalter **mit Speedtest**: Lass ihn an, wenn du kein knappes Datenvolumen hast. Daneben steht, wie viel er höchstens
   verbraucht. Bei einer getakteten Verbindung (z. B. Handy-Hotspot) ist er zuerst aus.
3. Auf **Prüfung starten** klicken. Pulsar prüft jetzt nacheinander: Verbindung, Router, Server, Route, Datenverkehr und
   – wenn eingeschaltet – den Speedtest. Das dauert etwa eine Minute. Mit **Abbrechen** hörst du jederzeit auf.
4. **Geklappt**, wenn oben die Karte **Einschätzung** erscheint. Dort steht in einem Satz, was Pulsar vermutet
   (zum Beispiel „Wenn deine Leitung voll ist, steigt dein Ping um 78 ms“).
5. Unter **Was du tun kannst** stehen nummerierte Schritte. Arbeite sie der Reihe nach ab. Knöpfe wie **WLAN-Tab öffnen**
   bringen dich direkt zur passenden Seite.
6. Darunter stehen **weitere Befunde** (zum Beispiel „Dein WLAN-Kanal ist stark belegt“). Mit **Erneut prüfen**
   siehst du, ob es besser geworden ist.

Steht dort „In dieser Minute war nichts Auffälliges messbar“, war während der Prüfung alles normal. Kommt der Lag nur manchmal, schau später in die
Karte **Lag-Detektiv** (Netzwerk → Verbindung) oder ins **Anbieter-Protokoll** (Berichte).

**Ehrlich:** Das Ergebnis ist eine Einschätzung nach festen Regeln, keine Gewissheit. Andere Geräte im Haushalt sieht
Pulsar nicht. Lag kann auch vom Spielserver selbst kommen – das kann Pulsar nicht messen. Pulsar ändert bei der Prüfung
nichts an Windows oder am Router, und es verspricht keinen niedrigeren Ping.

---

## 4. Die Dateien hochladen (GitHub-Release)

Der Installer lädt die App aus dem GitHub-Release **`pulsar-latest`** in deinem Projekt `vanity-`.
Warum ein eigenes Release mit festem Namen? In `vanity-` liegen auch andere Projekte.
Das „neueste Release“ von GitHub zeigt deshalb manchmal auf etwas anderes. `pulsar-latest` gehört nur Pulsar.

### Weg A – automatisch (eingerichtet)

Du musst nichts tun. Bei jeder Änderung, die zu GitHub geschickt wird, passiert Folgendes:

1. GitHub startet einen Windows-Rechner, baut Pulsar und testet es: Startet die App? Startet der Installer?
   Klappen Download, Prüfsumme, Installation und Deinstallation? Funktionieren Ping, Regionen, DNS, Tweaks und Boost?
2. Nur wenn **alles grün** ist, ersetzt GitHub die Dateien im Release `pulsar-latest`.
3. Nachsehen: `https://github.com/georghatzmann-bit/vanity-/releases/tag/pulsar-latest`
   **Geklappt**, wenn dort `Pulsar.exe`, `Pulsar-Setup.exe` und `latest.json` stehen.

Den Fortschritt siehst du unter `https://github.com/georghatzmann-bit/vanity-/actions` (Eintrag „Windows Build & Test“, dauert etwa 15–25 Minuten).

### Weg B – von Hand hochladen

1. Öffne `https://github.com/georghatzmann-bit/vanity-/releases/new`
2. Klicke auf **Choose a tag**, tippe `pulsar-latest` und klicke auf **Create new tag**.
   Gibt es das Release schon, öffne stattdessen `…/releases/tag/pulsar-latest` und klicke auf das Stift-Symbol (**Edit**).
3. Titel: `PULSAR (neueste Version)`.
4. Ziehe diese drei Dateien aus dem Ordner `release/` in das Feld **Attach binaries**:
   `Pulsar.exe`, `Pulsar-Setup.exe`, `latest.json` (alte Dateien vorher mit dem Mülleimer-Symbol löschen).
5. Den Haken **Set as the latest release** **nicht** setzen.
6. Klicke auf **Publish release** bzw. **Update release**. **Geklappt**, wenn die drei Dateien in der Liste stehen.

> Wichtig: Die drei Dateien müssen **aus demselben Bau** stammen. Sonst passt der Fingerabdruck in `latest.json` nicht zur App und der Installer meldet „Die Datei ist beschädigt angekommen“.

---

## 5. Die Download-Adresse einstellen

Die Adresse steht in **einer** Datei im Projekt: `pulsar.config.json`.

```json
"manifestUrl": "https://github.com/georghatzmann-bit/vanity-/releases/download/pulsar-latest/latest.json",
"downloadBaseUrl": "https://github.com/georghatzmann-bit/vanity-/releases/download/pulsar-latest/"
```

- Solange die Dateien im Release `pulsar-latest` von `vanity-` liegen, musst du **nichts ändern**.
- Willst du einen anderen Ort (z. B. ein eigenes GitHub-Projekt nur für Pulsar oder deine Webseite)? Dann beide Zeilen auf die neue Adresse ändern und neu bauen (Abschnitt 7).
  Beispiel eigene Webseite: `https://meine-seite.de/pulsar/latest.json` und `https://meine-seite.de/pulsar/`.
- Das GitHub-Projekt muss **öffentlich** sein, sonst kann der Installer nichts herunterladen. (`vanity-` ist öffentlich.)

**Ohne neu zu bauen:** Lege neben die `Pulsar-Setup.exe` eine Datei `pulsar-setup.json` mit diesem Inhalt:

```json
{ "manifestUrl": "https://meine-seite.de/pulsar/latest.json" }
```

Der Installer nimmt dann diese Adresse.

---

## 6. Den Installer benutzen

1. Doppelklick auf `Pulsar-Setup.exe` (bei der Windows-Warnung: **Weitere Informationen** → **Trotzdem ausführen**).
2. Das Intro mit Ton läuft ab: Der Pulsar baut sich auf, Druckwellen laufen nach außen, „Signal steht“. Oben rechts kannst du den Ton ausschalten.
3. **Los geht's** → Ordner bestätigen → Optionen wählen → **Installieren**.
4. Der Fortschrittsring füllt sich. Unten stehen Tempo und Restzeit, rechts kleine Tipps zu Pulsar.
   Bricht das Internet ab, klicke auf **Erneut versuchen**. Der Download macht an der Stelle weiter, an der er aufgehört hat.
5. **Geklappt**, wenn „Pulsar ist bereit!“ erscheint. Mit **Pulsar jetzt starten** öffnest du die App.

Wohin installieren? Der vorgeschlagene Ordner braucht keine Adminrechte. Wenn du Pulsar den DNS oder die zwei
Netzwerk-Einstellungen ändern lässt, ist der Ordner **Programme** sicherer (warum, steht in den häufigen Fragen):
bei **Speicherort** auf **Ändern** klicken und `C:\Program Files` wählen. Windows fragt dann einmal nach.

Deinstallieren: Windows-Einstellungen → **Apps** → **Installierte Apps** → „Pulsar“ → **Deinstallieren**.
Dort kannst du wählen, ob deine Berichte und Einstellungen erhalten bleiben. Vorher stellt der Deinstaller alle
Windows-Einstellungen zurück, die Pulsar geändert hat (DNS und alles unter **Optimieren**). Hat Pulsar dabei etwas
mit Adminrechten geändert, fragt Windows einmal nach – bestätige mit **Ja**. Einen laufenden Boost beendest du vorher
selbst (`Strg + B`): Beim Deinstallieren wird Pulsar sofort geschlossen und kann den alten Energieplan dann nicht mehr
selbst zurückstellen.

Klappt das Zurückstellen nicht ganz (zum Beispiel, weil du bei der Windows-Abfrage **Nein** klickst), wird Pulsar
trotzdem entfernt. Deine Pulsar-Daten bleiben dann aber **immer** erhalten – auch wenn du „Meine Daten behalten“
abgewählt hast. Darin stecken die Sicherungen deiner alten Einstellungen. Am Ende zeigt der Deinstaller einen
gelben Hinweis. So holst du es nach: Pulsar neu installieren und auf der Seite **Optimieren** oben auf
**Alles zurückstellen** klicken – oder gleich wieder deinstallieren und diesmal der Windows-Abfrage zustimmen.

Updates: Pulsar prüft beim Start, ob es eine neue Version gibt. Dann steht unter **Einstellungen → Über Pulsar** ein Knopf **Jetzt aktualisieren**. Ein Klick lädt den neuen Installer und aktualisiert alles.

> **Wichtig beim Update auf die Version mit Messverlauf:** Pulsar baut beim ersten Start die Datenbank um (für Kalender,
> Zeitleiste, Ausreißer und Anbieter-Protokoll). Vorher legt es eine Kopie an: `pulsar-vor-v2-<Datum>.db` im Ordner
> `backups` (siehe „Wo liegen meine Daten?“). Danach startet eine **ältere** Pulsar-Version mit dieser Datenbank nicht
> mehr – sie meldet, dass die Daten aus einer neueren Version stammen. Willst du wirklich zurück zur alten Version,
> geht das nur mit dieser Kopie.

---

## 7. Selbst neu bauen (nur wenn du etwas änderst)

Du brauchst dafür einmalig: **Node.js** (nodejs.org), **Rust** (rustup.rs) und unter Windows die **Build Tools für Visual Studio** mit „Desktopentwicklung mit C++“.

1. Öffne die Eingabeaufforderung (Windows-Taste, `cmd` tippen, Enter).
2. Wechsle in den Projektordner, zum Beispiel:
   `cd C:\Users\Georg\Documents\vanity-`
3. Prüfen, ob alles da ist:
   `npm run doctor`
   **Geklappt**, wenn am Ende „Alles bereit!“ steht. Sonst steht dort genau, was fehlt.
4. Einmalig die Pakete laden:
   `npm install`
5. Bauen:
   `npm run build:all`
   Das dauert beim ersten Mal 10–20 Minuten. **Geklappt**, wenn am Ende „✔ Fertig“ und die Pfade stehen:
   - `release\Pulsar.exe`
   - `release\Pulsar-Setup.exe`
   - `release\latest.json`

Neue Version veröffentlichen: In `pulsar.config.json` die `"version"` erhöhen (z. B. auf `1.0.1`) und die Änderung zu GitHub schicken (Weg A macht den Rest) – oder neu bauen und wie in Abschnitt 4, Weg B hochladen.
Alle installierten Pulsars melden sich dann mit „Update verfügbar“.

---

## 8. Häufige Fragen

**Braucht Pulsar Adminrechte?** Nein, Pulsar läuft immer als normaler Benutzer. Energieplan, Spielmodus,
Game-Bar-Aufnahme, Mausbeschleunigung und die Priorität der Spielprozesse ändert es ohne Adminrechte.
Nur drei Dinge brauchen Adminrechte: den **DNS wechseln** und die zwei Netzwerk-Einstellungen
**TCP-Pakete sofort senden** und **Netzwerk-Drosselung aus**. Dafür fragt Windows einmal nach. Pulsar startet sich
dann ganz kurz als Helfer, der nur genau diese Änderungen machen darf, und beendet sich sofort wieder.
Sagst du **Nein**, ändert sich nichts.

**Ändert Pulsar meinen DNS?** Nur, wenn du es willst: mit dem Knopf mit dem Namen des Dienstes (z. B. **Cloudflare
einstellen**) bzw. **Einstellen** unter **Netzwerk → DNS** oder mit **Netzwerk automatisch optimieren**. Vorher sichert Pulsar deine alte Einstellung
(zum Beispiel „automatisch vom Router“), dann fragt Windows einmal nach. **Zurückstellen** holt die alte Einstellung
jederzeit exakt zurück – beim Deinstallieren passiert das automatisch. Pulsar ändert nur die Verbindung, die gerade
die Hauptverbindung ist. Wechselst du danach die Verbindung (z. B. vom Kabel ins WLAN), steht unter **Netzwerk → DNS**
„Pulsar hat den DNS auch an „Ethernet“ geändert“ – **Zurückstellen** stellt auch diese Verbindung zurück.
Was ein schnellerer DNS bringt: Adressen werden schneller gefunden – Spielstart, Shop, Matchmaking und Webseiten laden
etwas flotter. Was er **nicht** bringt: Den Ping im Spiel ändert er nicht, der hängt vom Weg zum Spielserver ab.
Die Automatik wechselt deshalb nur, wenn ein Dienst deutlich schneller ist (mindestens 15 % und 3 ms), und wählt nur
Cloudflare, Google, Quad9 oder OpenDNS. AdGuard, DNS0.eu und Mullvad kannst du von Hand einstellen.

**Wie stelle ich alles zurück?**

| Was | So geht's |
|---|---|
| Nur den DNS | **Netzwerk → DNS** → **Zurückstellen** (Windows fragt einmal nach) – stellt alle Verbindungen zurück, an denen Pulsar den DNS geändert hat |
| DNS und die zwei Netzwerk-Einstellungen | **Optimieren** → Karte **Netzwerk automatisch optimieren** → **Netzwerk zurückstellen** (eine Windows-Abfrage) |
| Alles, was Pulsar eingestellt hat | **Optimieren** → **Alles zurückstellen** oben auf der Seite: DNS, die zwei Netzwerk-Einstellungen und alle Schalter unter Optimieren – mit höchstens einer Windows-Abfrage. Sagst du dort **Nein**, ändert sich gar nichts |
| Beim Deinstallieren | Passiert automatisch: DNS und alle Optimierungen, mit höchstens einer Windows-Abfrage |

Die zwei Netzwerk-Einstellungen sind erst nach einem Neustart von Windows wieder wie vorher.
Lehnst du die Windows-Abfrage beim Deinstallieren ab, bleiben DNS und die zwei Netzwerk-Einstellungen so, wie Pulsar
sie eingestellt hat. Deine Pulsar-Daten mit den Sicherungen bleiben dann erhalten, damit du es nachholen kannst
(siehe Abschnitt 6). Am einfachsten stellst du deshalb vorher in Pulsar zurück. Den DNS kannst du auch selbst
zurückstellen: Windows-Einstellungen → **Netzwerk und Internet** → deine Verbindung → **DNS-Serverzuweisung** →
**Bearbeiten** → **Automatisch (DHCP)** (wenn er vorher automatisch vom Router kam, so ist es fast immer).

**Warum ändert Pulsar meinen DNS nicht?** Sind bei deiner Verbindung **mehr als 3 DNS-Server fest eingetragen**
(je IPv4 bzw. IPv6, doppelte zählen nicht), lässt Pulsar den DNS dort in Ruhe. Mehr kann es nicht sicher sichern und
später exakt zurückstellen. Pulsar sagt dir das: „Bei dieser Verbindung sind mehr als 3 DNS-Server fest eingetragen –
Pulsar ändert den DNS hier nicht, damit er sich sicher zurückstellen lässt.“ Willst du trotzdem wechseln, trage den
DNS von Hand ein (Weg wie oben).

**„TCP-Pakete sofort senden“ lässt sich nicht einschalten?** Diese Einstellung gilt immer nur für **eine** Verbindung.
Hast du sie zum Beispiel am Kabel eingeschaltet und bist jetzt im WLAN, meldet Pulsar, dass „Nagle“ noch an einer
anderen Verbindung eingestellt ist. Dann zuerst zurückstellen (**Netzwerk zurückstellen**
oder **Alles zurückstellen**) und danach neu einschalten. Gibt es die alte Verbindung gar nicht mehr in Windows, räumt
Pulsar die alte Sicherung beim Zurückstellen still auf.

**Wohin installiere ich Pulsar am sichersten?** Standardmäßig landet Pulsar in deinem Benutzerordner
(`%LOCALAPPDATA%\Programs\Pulsar`). Dort dürfen auch andere Programme schreiben, die unter deinem Konto laufen.
Ein schädliches Programm könnte die Pulsar-Dateien verändern – und wenn du danach einer Windows-Abfrage von Pulsar
zustimmst, liefe es mit Adminrechten. Nutzt du den DNS-Wechsel oder die zwei Netzwerk-Einstellungen, installiere
Pulsar deshalb besser nach **Programme**: im Setup bei **Speicherort** auf **Ändern** klicken, `C:\Program Files`
wählen und die Windows-Abfrage bestätigen. Nutzt du diese Funktionen nicht, fragt Pulsar nie nach Adminrechten –
dann ist der Benutzerordner in Ordnung.

**Warum sagt der Ping im Spiel etwas anderes?** Das Spiel misst zu dem Server, auf dem du gerade spielst. Pulsar misst zu dem Messziel, das du eingestellt hast. Für CS2, Dota 2, Deadlock und League of Legends kannst du unter **Spiel → Einstellungen** die echten Server des Spiels wählen – dann passen die Werte zusammen.

**Mein Anti-Cheat mag die Priorität nicht.** Manche Spiele (z. B. mit Vanguard oder EAC) lassen sich nicht in der Priorität ändern. Pulsar meldet das ehrlich im Boost-Zustand („Zugriff verweigert“) – alles andere vom Boost wirkt trotzdem.

**Wie sicher ist die Ursache, die Pulsar nennt?** Es ist eine **Einschätzung**, keine Gewissheit. Bei einem Ausreißer
schaut Pulsar etwa eine Sekunde lang nach: Wie schnell antworten dein Router und die ersten Stationen? Wie stark ist das
WLAN? Wie viel lädt dein PC gerade? Daraus folgt nach festen Regeln eine Vermutung. Dabei gibt es Grenzen: War der
Ausreißer schon vorbei, heißt es „unklar“. Pulsar sieht andere Geräte im Haushalt nicht – lädt dort jemand etwas,
sieht das aus wie „Anschluss/Anbieter“. Über WLAN lassen sich WLAN und Router nicht trennen. Mit VPN bleibt die Ursache
„unklar“. Und viele Router antworten auf solche Anfragen nur langsam oder gar nicht. Deshalb steht überall „vermutlich“
und „Einschätzung“. Ein Bild bekommst du erst über viele Ausreißer (**Berichte → Ausreißer**).

**Warum braucht der WLAN-Scanner die Ortung?** Seit Windows 11 Version 24H2 gibt Windows die Liste der WLAN-Netze nur an
Programme heraus, die den **Standort** benutzen dürfen – aus WLAN-Netzen ließe sich nämlich ungefähr ablesen, wo du
bist. Pulsar ermittelt **keinen** Standort und sendet nichts; es braucht nur die Netzliste. So schaltest du es frei:
Im Tab **WLAN** auf **Windows-Einstellungen öffnen** klicken → **Standortdienste** an → **Desktop-Apps den Zugriff
auf Ihren Standort erlauben** an. Beim ersten Mal fragt Windows vielleicht einmal nach. **Ist der Schalter grau**, regelt
das deine Organisation (z. B. ein Firmen- oder Schul-PC) – dann kannst du es selbst nicht ändern. Ohne Freigabe zeigt
Pulsar keine WLAN-Netze; alles andere funktioniert weiter.

**Kann ich damit meinem Anbieter etwas nachweisen?** Nein – das **Anbieter-Protokoll ist ein Indiz, kein Nachweis**.
Es zeigt, was Pulsar gemessen hat, solange es lief, und vor allem die Antwortzeit zu Spiel- und Rechenzentrums-Servern.
Für Ansprüche wie Minderung oder Sonderkündigung gilt in Deutschland bei **Festnetz-Anschlüssen** die
**Breitbandmessung der Bundesnetzagentur** (breitbandmessung.de, Desktop-App): PC per LAN-Kabel am Router, VPN aus,
andere Geräte möglichst aus, 30 Messungen an 3 verschiedenen Tagen innerhalb von 14 Tagen. Die genauen, aktuellen Regeln
stehen auf der Seite. Für Mobilfunk gibt es ein eigenes Verfahren. Das Pulsar-Protokoll hilft dir trotzdem: Melde die
Störung beim Anbieter, notiere die Ticketnummer und nimm das Protokoll (**Bericht speichern (HTML)**) als Gesprächsgrundlage
mit. Ein Protokoll, das per WLAN entstanden ist, sagt wenig über den Anschluss. Pulsar gibt keine Rechtsberatung –
Rat gibt es z. B. bei der Verbraucherzentrale.

**Was speichert Pulsar und wie lösche ich es?** Alles bleibt auf deinem PC, nichts wird verschickt. Für Kalender,
Zeitleiste, Ausreißer und Anbieter-Protokoll speichert Pulsar einen **Messverlauf**: Ping-Statistik je Stunde (400 Tage),
Ereignisse wie Aussetzer, Ausreißer und Speedtests (bis 365 Tage) und die Messwerte der letzten 50 Runden (90 Tage).
Das sind typisch 2–6 MB. Dazu kommen deine Räume aus dem Raum-Scan und das Ergebnis der letzten Prüfung „Warum laggt es?“.
Namen und Adressen fremder WLAN-Netze speichert Pulsar nie; in Bildkarte, HTML- und CSV-Bericht stehen keine Adressen
und keine WLAN-Namen.
So löschst du es:
- **Einstellungen → Daten & Sicherung → Messverlauf löschen** (mit Rückfrage). Deine Berichte bleiben.
- Ganz abschalten: dort **Messverlauf dauerhaft speichern** ausschalten. Die Live-Anzeige läuft weiter.
- Räume: im Tab **WLAN** beim Raum auf den Mülleimer klicken.

Wichtig: Die automatischen Sicherungen (Backups) sind Kopien der ganzen Datenbank. Sie enthalten den Verlauf noch, bis
sie ersetzt werden – spätestens nach 10 weiteren Sicherungen (eine pro Tag).

**Warum ist der Speedtest bei Handy-Hotspot aus?** Windows kennt viele Handy-Hotspots als **getaktete Verbindung**
(Datenvolumen begrenzt). Pulsar fragt Windows danach. Ist die Verbindung getaktet, ist der Speedtest in
**Warum laggt es?** zuerst ausgeschaltet – er kann je nach Leitung einige hundert MB verbrauchen (die Zahl steht am
Schalter). Du kannst ihn trotzdem einschalten. Weiß Windows nicht, dass es ein Hotspot ist, kann Pulsar das auch nicht
erkennen – schalte den Speedtest dann selbst aus.

**Wo liegen meine Daten?**

| Was | Ordner |
|---|---|
| Spiele, Berichte, Einstellungen | `%APPDATA%\com.pulsar.booster` |
| Bilder-Zwischenspeicher | `%LOCALAPPDATA%\com.pulsar.booster` |
| Automatische Backups (täglich, die letzten 10) und die Kopie `pulsar-vor-v2-*.db` vom Update | `%APPDATA%\com.pulsar.booster\profiles\default\backups` |

---

## 9. Tastenkürzel

| Kürzel | Was passiert |
|---|---|
| `Strg + K` oder `/` | Befehlspalette: alles suchen und starten |
| `Strg + B` | Boost an/aus |
| `Strg + F` | In den Spielen suchen |
| `Strg + ,` | Einstellungen |
| `Strg + 1 … 6` | Seiten wechseln |
| `Alt + ←` | Zurück |
| `Alt + Shift + P` | Overlay über dem Spiel ein/aus (änderbar) |
