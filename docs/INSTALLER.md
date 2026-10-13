# Pulsar Setup – Vertrag zwischen Installer-Oberfläche und Installer-Backend

Der Installer ist eine eigene kleine Tauri-App (`installer/`). Er ist eine einzelne Datei
`Pulsar-Setup.exe`, lädt die eigentliche App (`Pulsar.exe`) aus dem Internet,
prüft sie per SHA-256, installiert sie und kann sie wieder deinstallieren oder aktualisieren.

## Konfiguration

Die zentrale Datei `pulsar.config.json` (Projektwurzel) wird beim Bauen in die Setup-Exe eingebettet.
Wichtig ist `manifestUrl`: Dort liegt `latest.json` (wird von `npm run build:all` erzeugt):

```json
{
  "name": "Pulsar",
  "version": "1.0.0",
  "notes": "Was ist neu …",
  "pubDate": "2026-10-13T12:00:00Z",
  "app":   { "url": "https://…/Pulsar.exe",       "sha256": "…", "size": 12345678 },
  "setup": { "url": "https://…/Pulsar-Setup.exe", "sha256": "…", "size": 7654321 }
}
```

Reihenfolge, wer die Manifest-Adresse bestimmt (erste gewinnt):
1. Kommandozeile `--manifest <url-oder-dateipfad>`
2. Umgebungsvariable `PULSAR_MANIFEST_URL`
3. Datei `pulsar-setup.json` neben der Setup-Exe (`{ "manifestUrl": "…" }`)
4. Eingebettete `pulsar.config.json`

`manifestUrl` darf auch ein lokaler Pfad oder `file://`-Link sein (für Tests).
Relative `app.url` werden relativ zur Manifest-Adresse aufgelöst.

## Startmodi (Kommandozeile)

| Aufruf | Modus |
|---|---|
| ohne Argumente | `install` – oder `maintenance`, wenn Pulsar schon installiert ist |
| `--update` | `update` – lädt die neueste App-Version in den vorhandenen Ordner und startet sie danach |
| `--uninstall` | `uninstall` – kopiert sich zuerst nach `%TEMP%` und startet sich von dort neu (`--uninstall --target <dir>`), damit der Ordner gelöscht werden kann |
| `--elevated --preset <base64-json>` | nach UAC-Neustart mit Adminrechten: Optionen übernehmen und direkt installieren |
| `--selftest --dir <dir> [--manifest <url>] [--report <datei>]` | ohne Oberfläche: komplette Installation + Deinstallation, schreibt JSON-Bericht, Exit-Code 0 = alles ok |

## Befehle

| Befehl | Argumente | Rückgabe |
|---|---|---|
| `setup_info` | – | `SetupInfo` |
| `fetch_manifest` | – | `Manifest` |
| `disk_space` | `path` | `DiskInfo` |
| `start_install` | `options: InstallOptions` | `()` sofort; Fortschritt über Events. Erneuter Aufruf nach Fehler setzt den Download fort |
| `cancel_install` | – | `()` |
| `relaunch_elevated` | `options: InstallOptions` | `()` startet sich mit UAC neu und beendet sich; `Err`, wenn abgelehnt |
| `app_running` | – | `bool` |
| `close_app` | – | `()` beendet laufende `Pulsar.exe` |
| `launch_app` | – | `()` startet die installierte App (nie mit Adminrechten) |
| `start_uninstall` | `keepData: bool` | `()` sofort; Fortschritt über Events |
| `open_url` | `url` | `()` |
| `quit` | – | `()` |

```ts
type SetupMode = "install" | "maintenance" | "update" | "uninstall";
interface SetupInfo {
  mode: SetupMode;
  setupVersion: string;
  appName: string;
  defaultDir: string;              // %LOCALAPPDATA%\Programs\Pulsar
  installed?: { dir: string; version: string };
  elevated: boolean;
  systemLang: "de" | "en";
  preset?: InstallOptions;         // nach UAC-Neustart gesetzt -> direkt installieren
  manifestUrl: string;
}
interface Manifest { version: string; notes?: string; pubDate?: string; app: { url: string; sha256?: string; size?: number } }
interface DiskInfo { path: string; free: number; total: number; required: number; exists: boolean; writable: boolean; needsAdmin: boolean; valid: boolean; message?: string }
interface InstallOptions { dir: string; desktopShortcut: boolean; startMenu: boolean; autostart: boolean; launchAfter: boolean }
```

## Events

| Event | Inhalt |
|---|---|
| `install://progress` | `{ phase, downloaded, total, speed, eta, percent }` – `phase`: `connect \| download \| verify \| install \| shortcuts \| register \| done`; `speed` Bytes/s; `eta` Sekunden; `percent` Gesamtfortschritt 0..100 |
| `install://error` | `{ phase, code, message, retryable }` – `code`: `network \| checksum \| disk \| permission \| manifest \| running \| cancelled \| unknown` |
| `install://done` | `{ dir, exePath, version, verified }` |
| `uninstall://progress` | `{ step, percent }` – `step`: `stop \| shortcuts \| registry \| files \| data \| done` |
| `uninstall://error` | `{ message }` |
| `uninstall://done` | `{}` |

## Was die Installation auf dem PC anlegt

| Was | Wo |
|---|---|
| App | `<dir>\Pulsar.exe` |
| Deinstaller | `<dir>\Uninstall Pulsar.exe` (Kopie der Setup-Exe) |
| Info | `<dir>\install.json` |
| Startmenü | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Pulsar.lnk` |
| Desktop | `<Desktop>\Pulsar.lnk` |
| Autostart | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Pulsar = "<exe>" --minimized` |
| Apps & Features | `HKCU\…\Uninstall\Pulsar` (bzw. `HKLM`, wenn mit Adminrechten installiert) |
| Installationsort merken | `HKCU\Software\Pulsar\Booster` → `InstallDir`, `Version` |

Ohne Adminrechte wird nach `%LOCALAPPDATA%\Programs\Pulsar` installiert. Adminrechte werden nur
angefordert, wenn der gewählte Ordner nicht beschreibbar ist (z. B. `C:\Program Files`).

## Ablauf der Deinstallation

`run_uninstall` (`installer/src-tauri/src/uninstall.rs`) – gleich für die Oberfläche, `--uninstall --quiet` und den Selbsttest.
Die Schritt-Namen in `uninstall://progress` bleiben `stop | shortcuts | registry | files | data | done`.

| Schritt | Was passiert |
|---|---|
| `stop` | 1. Laufende `Pulsar.exe` beenden (hart – ein laufender Boost kann sich dabei nicht mehr selbst zurücknehmen).<br>2. **Windows-Einstellungen zurückstellen:** Liegt `<dir>\Pulsar.exe` noch da, startet der Deinstaller `Pulsar.exe --revert-all` verborgen (Windows: `CREATE_NO_WINDOW`, Arbeitsordner `%TEMP%`). Die App stellt den gesicherten DNS und alle Sicherungen aus **Optimieren** wieder her – mit höchstens einer Windows-Abfrage, keiner, wenn schon Adminrechte bestehen oder nichts zu tun ist (Vertrag: `docs/API.md`, „Deinstallieren: `Pulsar.exe --revert-all`“). Der Deinstaller wartet höchstens **120 s** und beendet den Prozess sonst. Danach werden übrig gebliebene `Pulsar.exe`-Prozesse noch einmal beendet, damit die Datei gelöscht werden kann. |
| `shortcuts` | Startmenü- und Desktop-Verknüpfung, Autostart entfernen |
| `registry` | „Apps & Features“-Eintrag und `HKCU\Software\Pulsar\Booster` entfernen |
| `files` | `Pulsar.exe`, `install.json`, Deinstaller, Download-Reste löschen; den Ordner nur, wenn er danach leer ist |
| `data` | Nur ohne „Meine Daten behalten“: `%APPDATA%\com.pulsar.booster` und `%LOCALAPPDATA%\com.pulsar.booster` |

Zum Zurückstellen:
- Das Ergebnis (Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben, Zeitüberschreitung,
  Startfehler) und die Fehlerausgabe der App landen im Setup-Protokoll `%TEMP%\pulsar-setup.log`. Alles außer
  Exit-Code 0 (oder „keine App-Datei“) kommt zusätzlich als Hinweis dazu; der Selbsttest zeigt das Ergebnis im Schritt `uninstall`.
- Ein Fehler bricht die Deinstallation **nie** ab. Lehnt man die Windows-Abfrage ab, bleiben DNS und die zwei
  Netzwerk-Einstellungen so, wie Pulsar sie eingestellt hat; der Rest wird trotzdem entfernt.
- Es passiert vor dem Löschen der Benutzerdaten, denn dort liegen die Sicherungen (kv `opt.snapshots`, `net.dnsBackup`).
- Auch `--uninstall --quiet` stellt zurück; ohne Adminrechte kann dabei die Windows-Abfrage erscheinen.
