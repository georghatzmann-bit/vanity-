# NOVA Setup – Vertrag zwischen Installer-Oberfläche und Installer-Backend

Der Installer ist eine eigene kleine Tauri-App (`installer/`). Er ist eine einzelne Datei
`NovaLauncher-Setup.exe`, lädt die eigentliche App (`NovaLauncher.exe`) aus dem Internet,
prüft sie per SHA-256, installiert sie und kann sie wieder deinstallieren oder aktualisieren.

## Konfiguration

Die zentrale Datei `nova.config.json` (Projektwurzel) wird beim Bauen in die Setup-Exe eingebettet.
Wichtig ist `manifestUrl`: Dort liegt `latest.json` (wird von `npm run build:all` erzeugt):

```json
{
  "name": "Nova Launcher",
  "version": "1.0.0",
  "notes": "Was ist neu …",
  "pubDate": "2026-10-12T12:00:00Z",
  "app":   { "url": "https://…/NovaLauncher.exe",       "sha256": "…", "size": 12345678 },
  "setup": { "url": "https://…/NovaLauncher-Setup.exe", "sha256": "…", "size": 7654321 }
}
```

Reihenfolge, wer die Manifest-Adresse bestimmt (erste gewinnt):
1. Kommandozeile `--manifest <url-oder-dateipfad>`
2. Umgebungsvariable `NOVA_MANIFEST_URL`
3. Datei `nova-setup.json` neben der Setup-Exe (`{ "manifestUrl": "…" }`)
4. Eingebettete `nova.config.json`

`manifestUrl` darf auch ein lokaler Pfad oder `file://`-Link sein (für Tests).
Relative `app.url` werden relativ zur Manifest-Adresse aufgelöst.

## Startmodi (Kommandozeile)

| Aufruf | Modus |
|---|---|
| ohne Argumente | `install` – oder `maintenance`, wenn NOVA schon installiert ist |
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
| `close_app` | – | `()` beendet laufende `NovaLauncher.exe` |
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
  defaultDir: string;              // %LOCALAPPDATA%\Programs\Nova Launcher
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
| App | `<dir>\NovaLauncher.exe` |
| Deinstaller | `<dir>\Uninstall Nova.exe` (Kopie der Setup-Exe) |
| Info | `<dir>\install.json` |
| Startmenü | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Nova Launcher.lnk` |
| Desktop | `<Desktop>\Nova Launcher.lnk` |
| Autostart | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `NovaLauncher = "<exe>" --minimized` |
| Apps & Features | `HKCU\…\Uninstall\NovaLauncher` (bzw. `HKLM`, wenn mit Adminrechten installiert) |
| Installationsort merken | `HKCU\Software\Nova\Launcher` → `InstallDir`, `Version` |

Ohne Adminrechte wird nach `%LOCALAPPDATA%\Programs\Nova Launcher` installiert. Adminrechte werden nur
angefordert, wenn der gewählte Ordner nicht beschreibbar ist (z. B. `C:\Program Files`).
