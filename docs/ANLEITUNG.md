# NOVA – Anleitung in einfachen Worten

Hier steht, wie du NOVA startest, wie du die Dateien hochlädst und wie du die Download-Adresse einstellst.
Du brauchst dafür keine Programmierkenntnisse.

## Der schnellste Weg

1. Lade den Installer herunter:
   `https://github.com/georghatzmann-bit/vanity-/releases/download/nova-latest/NovaLauncher-Setup.exe`
2. Doppelklick auf die Datei. Bei der blauen Windows-Warnung: **Weitere Informationen** → **Trotzdem ausführen**.
3. Durch den Installer klicken. **Geklappt**, wenn „NOVA ist bereit!“ erscheint.

---

## 1. Was ist was?

| Datei | Wofür |
|---|---|
| `NovaLauncher-Setup.exe` | Der Installer. Diese Datei gibst du weiter oder startest sie selbst. Sie lädt die App aus dem Internet. |
| `NovaLauncher.exe` | Die eigentliche App. Die lädt der Installer herunter. Du kannst sie aber auch direkt starten. |
| `latest.json` | Ein kleiner Zettel für den Installer: Welche Version ist aktuell, wo liegt die App, und ihr „Fingerabdruck“ (Prüfsumme), damit niemand eine falsche Datei unterschieben kann. |

Alle drei Dateien entstehen zusammen im Ordner `release/`.

---

## 2. NOVA sofort ausprobieren (ohne Installer)

1. Doppelklick auf `NovaLauncher.exe`.
2. Falls Windows „Der Computer wurde durch Windows geschützt“ zeigt: auf **Weitere Informationen** klicken, dann auf **Trotzdem ausführen**.
   Das kommt, weil die Datei (noch) keine kostenpflichtige Microsoft-Signatur hat. Das ist bei neuen Programmen normal.
3. Du siehst die Startanimation mit dem leuchtenden Stern. **Geklappt**, wenn danach die Startseite erscheint.
4. Klicke auf **Bibliothek automatisch füllen**. NOVA sucht Steam-, Epic-, GOG-Spiele und Programme aus dem Startmenü.

---

## 3. Die Dateien hochladen (GitHub-Release)

Der Installer lädt die App aus dem GitHub-Release **`nova-latest`** in deinem Projekt `vanity-`.
Warum ein eigenes Release mit festem Namen? In `vanity-` liegen auch Jarvis und der Konto-Retter.
Das „neueste Release“ von GitHub zeigt deshalb manchmal auf ein anderes Projekt. `nova-latest` gehört nur NOVA.

### Weg A – automatisch (eingerichtet)

Du musst nichts tun. Bei jeder Änderung, die ich (oder du) zu GitHub schicke, passiert Folgendes:

1. GitHub startet einen Windows-Rechner, baut NOVA und testet es: Startet die App? Startet der Installer? Klappen Download, Prüfsumme, Installation und Deinstallation?
2. Nur wenn **alles grün** ist, ersetzt GitHub die Dateien im Release `nova-latest`.
3. Nachsehen: `https://github.com/georghatzmann-bit/vanity-/releases/tag/nova-latest`
   **Geklappt**, wenn dort `NovaLauncher.exe`, `NovaLauncher-Setup.exe` und `latest.json` stehen.

Den Fortschritt siehst du unter `https://github.com/georghatzmann-bit/vanity-/actions` (Eintrag „Windows Build & Test“, dauert etwa 15–25 Minuten).

### Weg B – von Hand hochladen

1. Öffne `https://github.com/georghatzmann-bit/vanity-/releases/new`
2. Klicke auf **Choose a tag**, tippe `nova-latest` und klicke auf **Create new tag**.
   Gibt es das Release schon, öffne stattdessen `…/releases/tag/nova-latest` und klicke auf das Stift-Symbol (**Edit**).
3. Titel: `NOVA (neueste Version)`.
4. Ziehe diese drei Dateien aus dem Ordner `release/` in das Feld **Attach binaries**:
   `NovaLauncher.exe`, `NovaLauncher-Setup.exe`, `latest.json` (alte Dateien vorher mit dem Mülleimer-Symbol löschen).
5. Den Haken **Set as the latest release** **nicht** setzen (sonst verdrängst du Jarvis/Konto-Retter).
6. Klicke auf **Publish release** bzw. **Update release**. **Geklappt**, wenn die drei Dateien in der Liste stehen.

> Wichtig: Die drei Dateien müssen **aus demselben Bau** stammen. Sonst passt der Fingerabdruck in `latest.json` nicht zur App und der Installer meldet „Die Datei ist beschädigt angekommen“.

---

## 4. Die Download-Adresse einstellen

Die Adresse steht in **einer** Datei im Projekt: `nova.config.json`.

```json
"manifestUrl": "https://github.com/georghatzmann-bit/vanity-/releases/download/nova-latest/latest.json",
"downloadBaseUrl": "https://github.com/georghatzmann-bit/vanity-/releases/download/nova-latest/"
```

- Solange die Dateien im Release `nova-latest` von `vanity-` liegen, musst du **nichts ändern**.
- Willst du einen anderen Ort (z. B. ein eigenes GitHub-Projekt nur für NOVA oder deine Webseite)? Dann beide Zeilen auf die neue Adresse ändern und neu bauen (Abschnitt 6).
  Beispiel eigene Webseite: `https://meine-seite.de/nova/latest.json` und `https://meine-seite.de/nova/`.
- Das GitHub-Projekt muss **öffentlich** sein, sonst kann der Installer nichts herunterladen. (`vanity-` ist öffentlich.)

**Ohne neu zu bauen:** Lege neben die `NovaLauncher-Setup.exe` eine Datei `nova-setup.json` mit diesem Inhalt:

```json
{ "manifestUrl": "https://meine-seite.de/nova/latest.json" }
```

Der Installer nimmt dann diese Adresse.

---

## 5. Den Installer benutzen

1. Doppelklick auf `NovaLauncher-Setup.exe` (bei der Windows-Warnung: **Weitere Informationen** → **Trotzdem ausführen**).
2. Das Intro mit Ton läuft ab. Oben rechts kannst du den Ton ausschalten.
3. **Los geht's** → Ordner bestätigen → Optionen wählen → **Installieren**.
4. Der Fortschrittsring füllt sich. Unten stehen Tempo und Restzeit.
   Bricht das Internet ab, klicke auf **Erneut versuchen**. Der Download macht an der Stelle weiter, an der er aufgehört hat.
5. **Geklappt**, wenn „NOVA ist bereit!“ erscheint. Mit **NOVA jetzt starten** öffnest du die App.

Deinstallieren: Windows-Einstellungen → **Apps** → **Installierte Apps** → „Nova Launcher“ → **Deinstallieren**.
Dort kannst du wählen, ob deine Bibliothek und Spielzeit erhalten bleiben.

Updates: NOVA prüft beim Start, ob es eine neue Version gibt. Dann erscheint oben ein Knopf. Ein Klick lädt den neuen Installer und aktualisiert alles.

---

## 6. Selbst neu bauen (nur wenn du etwas änderst)

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
   - `release\NovaLauncher.exe`
   - `release\NovaLauncher-Setup.exe`
   - `release\latest.json`

Neue Version veröffentlichen: In `nova.config.json` die `"version"` erhöhen (z. B. auf `1.0.1`) und die Änderung zu GitHub schicken (Weg A macht den Rest) – oder neu bauen und wie in Abschnitt 3, Weg B hochladen.
Alle installierten NOVAs melden sich dann mit „Update verfügbar“.

---

## 7. Cover, Hintergründe, Logos und Icons

Du musst nichts tun – NOVA holt die Bilder selbst, ganz ohne Anmeldung oder Schlüssel:
- **Steam-Spiele:** Cover, großes Hintergrundbild, Logo und Icon direkt von Steam.
- **Epic-, GOG- und andere Spiele:** NOVA sucht das Spiel per Name bei Steam und nimmt dessen Bilder (klappt bei den meisten bekannten Spielen).
- **Icons:** kommen aus der Programmdatei des Spiels (scharf, 256 Pixel). Programme wie OBS oder Discord bekommen so ihr echtes Symbol.
- Fehlt einem Spiel ein Bild, versucht NOVA es beim Start von selbst wieder (höchstens alle 3 Tage).

Nur für Spiele, die es bei Steam nicht gibt (z. B. Alan Wake 2, Minecraft), hilft ein kostenloser **SteamGridDB-Schlüssel**:
1. Auf `https://www.steamgriddb.com` mit Steam anmelden.
2. Profil → **Preferences** → **API** → Schlüssel kopieren.
3. In NOVA: **Einstellungen → Bibliothek → SteamGridDB-API-Schlüssel** einfügen.
4. **Aufräumen → Alle Cover laden** klicken.

Spiele ganz ohne Bild bekommen ein automatisch gemaltes Cover (mit Icon, wenn eins da ist). Eigene Bilder gehen über **Spiel → Einstellungen → Bilder**.

---

## 8. Wo liegen meine Daten?

| Was | Ordner |
|---|---|
| Bibliothek, Spielzeit, Einstellungen | `%APPDATA%\com.nova.launcher` |
| Bilder-Zwischenspeicher | `%LOCALAPPDATA%\com.nova.launcher` |
| Automatische Backups (täglich, die letzten 10) | `%APPDATA%\com.nova.launcher\profiles\<Profil>\backups` |

Tipp: Unter **Einstellungen → Daten & Sicherung** kannst du alles in eine Datei exportieren und auf einem anderen PC wieder importieren.

---

## 9. Tastenkürzel

| Kürzel | Was passiert |
|---|---|
| `Strg + K` | Befehlspalette: alles suchen und starten |
| `Strg + F` | In der Bibliothek suchen |
| `Strg + D` | Würfel: „Was soll ich spielen?“ |
| `Strg + B` | Big Picture (Vollbild fürs Sofa, mit Controller) |
| `Strg + ,` | Einstellungen |
| `Strg + 1 … 7` | Seiten wechseln |
| `Alt + Shift + N` | Mini-Overlay über dem Spiel (änderbar) |
