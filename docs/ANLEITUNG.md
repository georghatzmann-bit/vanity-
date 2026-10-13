# NOVA – Anleitung in einfachen Worten

Hier steht, wie du NOVA startest, wie du die Dateien hochlädst und wie du die Download-Adresse einstellst.
Du brauchst dafür keine Programmierkenntnisse.

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

Der Installer lädt die App von GitHub. Dafür müssen die Dateien einmal in ein „Release“ (eine Veröffentlichung) auf GitHub.

### Weg A – GitHub baut und lädt alles selbst hoch (empfohlen)

1. Öffne im Browser: `https://github.com/georghatzmann-bit/vanity-/releases/new`
2. Klicke auf **Choose a tag**, tippe `v1.0.0` und klicke auf **Create new tag: v1.0.0**.
3. Bei **Target** wähle den Zweig mit NOVA (`claude/nova-launcher-windows-app-3amt0f`, später `main`).
4. Titel: `NOVA 1.0.0`. Dateien musst du **keine** anhängen.
5. Klicke auf **Publish release**.
6. GitHub startet jetzt von selbst einen Windows-Rechner, baut NOVA, testet es und hängt die Dateien an.
   Den Fortschritt siehst du unter `https://github.com/georghatzmann-bit/vanity-/actions`.
7. Warte etwa 15–25 Minuten. **Geklappt**, wenn im Release die Dateien `NovaLauncher.exe`, `NovaLauncher-Setup.exe` und `latest.json` stehen.

### Weg B – von Hand hochladen

1. Öffne `https://github.com/georghatzmann-bit/vanity-/releases/new`
2. Bei **Choose a tag** tippe `v1.0.0` und klicke auf **Create new tag**.
3. Titel: `NOVA 1.0.0`.
4. Ziehe diese drei Dateien aus dem Ordner `release/` in das Feld **Attach binaries**:
   `NovaLauncher.exe`, `NovaLauncher-Setup.exe`, `latest.json`
5. Klicke auf **Publish release**. **Geklappt**, wenn die drei Dateien in der Liste unter dem Release stehen.

> Wichtig: Die drei Dateien müssen **aus demselben Bau** stammen. Sonst passt der Fingerabdruck in `latest.json` nicht zur App und der Installer meldet „Die Datei ist beschädigt angekommen“.

---

## 4. Die Download-Adresse einstellen

Die Adresse steht in **einer** Datei im Projekt: `nova.config.json`.

```json
"manifestUrl": "https://github.com/georghatzmann-bit/vanity-/releases/latest/download/latest.json",
"downloadBaseUrl": "https://github.com/georghatzmann-bit/vanity-/releases/latest/download/"
```

- Solange du die Dateien wie oben bei **diesem** GitHub-Projekt hochlädst, musst du **nichts ändern**. `latest` zeigt immer automatisch auf das neueste Release.
- Willst du einen anderen Ort (z. B. ein anderes GitHub-Projekt oder deine eigene Webseite)? Dann beide Zeilen auf die neue Adresse ändern und neu bauen (Abschnitt 6).
  Beispiel eigene Webseite: `https://meine-seite.de/nova/latest.json` und `https://meine-seite.de/nova/`.
- Das GitHub-Projekt muss **öffentlich** sein, sonst kann der Installer nichts herunterladen.

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

Neue Version veröffentlichen: In `nova.config.json` die `"version"` erhöhen (z. B. auf `1.0.1`), neu bauen und wie in Abschnitt 3 hochladen.
Alle installierten NOVAs melden sich dann mit „Update verfügbar“.

---

## 7. Cover-Bilder (SteamGridDB)

- Für **Steam-Spiele** lädt NOVA die Bilder automatisch, ganz ohne Schlüssel.
- Für **Epic-, GOG- und andere Spiele** brauchst du einen kostenlosen Schlüssel:
  1. Auf `https://www.steamgriddb.com` mit Steam anmelden.
  2. Profil → **Preferences** → **API** → Schlüssel kopieren.
  3. In NOVA: **Einstellungen → Bibliothek → SteamGridDB-API-Schlüssel** einfügen.
  4. **Aufräumen → Alle Cover laden** klicken.
- Spiele ohne Bild bekommen ein automatisch erzeugtes Kunst-Cover. Eigene Bilder gehen über **Spiel → Einstellungen → Bilder**.

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
