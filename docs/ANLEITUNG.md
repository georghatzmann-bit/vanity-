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
| **Cockpit** | Note, Live-Ping, Boost, PC-Auslastung, letzte Runde, Schnellzugriff |
| **Spiele** | Deine Spiele (automatisch gefunden oder per Hand). Pro Spiel: Messziel, echte Spielserver, Auto-Boost |
| **Netzwerk → Regionen** | Ping zu Rechenzentren weltweit. Die beste Region als Messziel fürs Cockpit setzen |
| **Netzwerk → Route** | Station für Station: Wo auf dem Weg zum Server hängt es? Pulsar sagt dir: Heimnetz, Anbieter oder Internet |
| **Netzwerk → DNS** | Vergleicht DNS-Dienste (Cloudflare, Google, Quad9 …) und stellt auf Knopfdruck den schnellsten ein (**Schnellsten einstellen**, Windows fragt einmal nach). **Zurückstellen** holt deine alte Einstellung jederzeit zurück |
| **Netzwerk → Speedtest** | Download, Upload und die **Bufferbloat-Note**: Wie stark steigt dein Ping, wenn die Leitung ausgelastet ist? |
| **Netzwerk → Verbindung** | Kabel oder WLAN? Signalstärke, Band, Kanal, Adapter, Gateway, DNS |
| **Optimieren** | **Netzwerk automatisch optimieren** (siehe unten), sechs Windows-Einstellungen mit Schalter – jede mit **Rückgängig**. Energieplan, Boost-Profil |
| **Berichte** | Jede Spielrunde: Ping-Verlauf, Spitzen, Verlust, Note |
| **Einstellungen** | Aussehen (4 Themes), Sound, Messung, Boost, Overlay, Verhalten, Spiele, Daten, Über |

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

**Zurückstellen:** In derselben Karte auf **Alles zurückstellen** klicken und die Windows-Abfrage mit **Ja** bestätigen.
Dann sind DNS und die zwei Netzwerk-Einstellungen wieder genau wie vorher (die Netzwerk-Einstellungen nach dem nächsten Neustart).

**Ehrlich:** Ein schnellerer DNS beschleunigt nur das Nachschlagen von Adressen – Spielstart, Shop, Matchmaking und
Webseiten laden etwas flotter. Den Ping **im** Spiel ändert er nicht. Die zwei Netzwerk-Einstellungen bringen meist nur wenig.

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

Deinstallieren: Windows-Einstellungen → **Apps** → **Installierte Apps** → „Pulsar“ → **Deinstallieren**.
Dort kannst du wählen, ob deine Berichte und Einstellungen erhalten bleiben. Vorher stellt der Deinstaller alle
Windows-Einstellungen zurück, die Pulsar geändert hat (DNS und alles unter **Optimieren**). Hat Pulsar dabei etwas
mit Adminrechten geändert, fragt Windows einmal nach – bestätige mit **Ja**. Einen laufenden Boost beendest du vorher
selbst (`Strg + B`): Beim Deinstallieren wird Pulsar sofort geschlossen und kann den alten Energieplan dann nicht mehr
selbst zurückstellen.

Updates: Pulsar prüft beim Start, ob es eine neue Version gibt. Dann steht unter **Einstellungen → Über Pulsar** ein Knopf **Jetzt aktualisieren**. Ein Klick lädt den neuen Installer und aktualisiert alles.

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

**Ändert Pulsar meinen DNS?** Nur, wenn du es willst: mit **Schnellsten einstellen** bzw. **Einstellen** unter
**Netzwerk → DNS** oder mit **Netzwerk automatisch optimieren**. Vorher sichert Pulsar deine alte Einstellung
(zum Beispiel „automatisch vom Router“), dann fragt Windows einmal nach. **Zurückstellen** holt die alte Einstellung
jederzeit exakt zurück – beim Deinstallieren passiert das automatisch. Pulsar ändert nur die Hauptverbindung.
Was ein schnellerer DNS bringt: Adressen werden schneller gefunden – Spielstart, Shop, Matchmaking und Webseiten laden
etwas flotter. Was er **nicht** bringt: Den Ping im Spiel ändert er nicht, der hängt vom Weg zum Spielserver ab.
Die Automatik wechselt deshalb nur, wenn ein Dienst deutlich schneller ist (mindestens 15 % und 3 ms), und wählt nur
Cloudflare, Google, Quad9 oder OpenDNS. AdGuard, DNS0.eu und Mullvad kannst du von Hand einstellen.

**Wie stelle ich alles zurück?**

| Was | So geht's |
|---|---|
| Nur den DNS | **Netzwerk → DNS** → **Zurückstellen** (Windows fragt einmal nach) |
| DNS und die zwei Netzwerk-Einstellungen | **Optimieren** → Karte **Netzwerk automatisch optimieren** → **Alles zurückstellen** (eine Windows-Abfrage) |
| Alle Schalter unter Optimieren | **Optimieren** → **Alles zurückstellen** oben rechts (den DNS stellst du wie oben zurück) |
| Wirklich alles | Passiert beim **Deinstallieren** automatisch: DNS und alle Optimierungen, mit höchstens einer Windows-Abfrage |

Die zwei Netzwerk-Einstellungen sind erst nach einem Neustart von Windows wieder wie vorher.
Lehnst du die Windows-Abfrage beim Deinstallieren ab, bleiben DNS und die zwei Netzwerk-Einstellungen so, wie Pulsar
sie eingestellt hat. Am sichersten stellst du sie deshalb vorher in Pulsar zurück. Den DNS kannst du auch selbst
zurückstellen: Windows-Einstellungen → **Netzwerk und Internet** → deine Verbindung → **DNS-Serverzuweisung** →
**Bearbeiten** → **Automatisch (DHCP)** (wenn er vorher automatisch vom Router kam, so ist es fast immer).

**Warum sagt der Ping im Spiel etwas anderes?** Das Spiel misst zu dem Server, auf dem du gerade spielst. Pulsar misst zu dem Messziel, das du eingestellt hast. Für CS2, Dota 2, Deadlock und League of Legends kannst du unter **Spiel → Einstellungen** die echten Server des Spiels wählen – dann passen die Werte zusammen.

**Mein Anti-Cheat mag die Priorität nicht.** Manche Spiele (z. B. mit Vanguard oder EAC) lassen sich nicht in der Priorität ändern. Pulsar meldet das ehrlich im Boost-Zustand („Zugriff verweigert“) – alles andere vom Boost wirkt trotzdem.

**Wo liegen meine Daten?**

| Was | Ordner |
|---|---|
| Spiele, Berichte, Einstellungen | `%APPDATA%\com.pulsar.booster` |
| Bilder-Zwischenspeicher | `%LOCALAPPDATA%\com.pulsar.booster` |
| Automatische Backups (täglich, die letzten 10) | `%APPDATA%\com.pulsar.booster\profiles\default\backups` |

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
