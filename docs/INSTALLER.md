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
| `--uninstall` | `uninstall` – kopiert sich zuerst nach `%TEMP%` und startet sich von dort neu (`--uninstall --target <dir> --user-data <%APPDATA% des startenden Kontos>`, mit Adminrechten, wenn der Ordner sonst nicht beschreibbar ist), damit der Ordner gelöscht werden kann. Zeigt `--user-data` auf einen anderen Ordner als den eigenen `%APPDATA%`, läuft die Kopie unter einem **anderen** Konto (bei der Windows-Abfrage wurde ein Admin-Konto eingegeben): Dann wird `Pulsar.exe --revert-all` nicht gestartet (siehe unten) |
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
| `uninstall://done` | `{ revertOk, dataKept }` – `revertOk: false` = `Pulsar.exe --revert-all` konnte nicht alles zurückstellen (die Oberfläche zeigt dann einen Hinweis, wie man es nachholt); `dataKept: true` = die Pulsar-Daten wurden nicht gelöscht (gewählt oder wegen `revertOk: false`) |

## Oberfläche

Die Oberfläche („Radioteleskop“) ist reine Darstellung über dem unveränderten Vertrag oben: gleiche Befehle,
gleiche Events und Payloads. Ablauf und Event-Logik stecken in `installer/src/flow/useSetupFlow.ts`,
Bild und Ton in `installer/src/hooks/useObservatory.ts`.

- **Prozent → Periode ist Inszenierung.** Der Schirm übersetzt `percent` in eine Drehperiode des Sterns
  (1,337 s bis 5,757 ms, mit Rastplateaus an den Katalog-Pulsaren) und zeigt das als **INSZENIERT**. Gemessen
  (**GEMESSEN**) sind nur die Werte aus den Events: Prozent, Bytes, Rate, Restzeit, Phasendauern.
- **Ton aus:** Schalter in der Titelleiste oder Taste **M** (nicht im Eingabefeld); gespeichert unter
  `pulsar-setup-muted`. Stumm erzeugt keine Audio-Knoten; Bild und Modell laufen weiter.
- **Reduzierte Bewegung:** folgt der Systemeinstellung (live); Stern als Standbild, Stroboskop, Wandlung und
  Zerfall als Endbilder, Seitenwechsel nur über Deckkraft. Der Ton bleibt.
- **Qualitätsstufen:** L2/L1/L0 (Bildrate, Pixeldichte, Detail). Automatisch nur nach unten, wenn Bilder zu
  langsam werden; jeder Wechsel wird protokolliert und steht in `<html data-quality>`.
- **Testparameter im Browser** (`npm run dev:installer`, Demo-Backend): `?slow` (Download viermal langsamer),
  `?lang=en`, `?quality=0|1|2` (Stufe fest), `?motion=reduced`, `?fail=1`, `?mode=update|maintenance|uninstall`,
  `?revertfail`; im Dev-Server zusätzlich `?lab` (Klanglabor).
- **Rundgang:** `node scripts/installer-tour.mjs http://localhost:1421/ <ordner>` macht Screenshots aller Szenen,
  wartet auf Zustände und endet mit Exit-Code 1 bei Konsolenfehlern.

## Was die Installation auf dem PC anlegt

| Was | Wo |
|---|---|
| App | `<dir>\Pulsar.exe` |
| Deinstaller | `<dir>\Uninstall Pulsar.exe` (Kopie der Setup-Exe) |
| Info | `<dir>\install.json` – Version, Datum, Optionen, `scope` (`user`/`machine`) und die Marke `"revertAll": true` (diese Installation kennt `Pulsar.exe --revert-all`) |
| Startmenü | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Pulsar.lnk` |
| Desktop | `<Desktop>\Pulsar.lnk` |
| Autostart | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Pulsar = "<exe>" --minimized` |
| Apps & Features | `HKCU\…\Uninstall\Pulsar` (bzw. `HKLM`, wenn mit Adminrechten installiert) |
| Installationsort merken | `HKCU\Software\Pulsar\Booster` → `InstallDir`, `Version` |

Ohne Adminrechte wird nach `%LOCALAPPDATA%\Programs\Pulsar` installiert. Adminrechte werden nur
angefordert, wenn der gewählte Ordner nicht beschreibbar ist (z. B. `C:\Program Files`).

### Pro Benutzer oder nach „Programme“? (ehrliche Restgefahr)

Pulsar selbst läuft immer als normaler Benutzer. Nur für den DNS und die zwei Netzwerk-Einstellungen startet es sich
kurz als Admin-Helfer (`Pulsar.exe --elevated …`, Vertrag: `docs/API.md`, „Admin-Helfer“) – Windows fragt dann nach.

- **Installation pro Benutzer** (Standard, `%LOCALAPPDATA%\Programs\Pulsar`): In diesen Ordner darf jedes Programm
  schreiben, das unter deinem Konto läuft. Ein schädliches Programm könnte dort `Pulsar.exe` austauschen oder eine
  DLL danebenlegen. Stimmst du danach der nächsten Windows-Abfrage von Pulsar zu, liefe dieser fremde Code mit
  Adminrechten. Pulsar beschränkt die DLL-Suche des Helfers zwar auf System32, das schützt aber nur später nachgeladene
  DLLs – nicht vor einer ausgetauschten Exe. Microsoft sieht die Windows-Abfrage (UAC) ausdrücklich nicht als
  Sicherheitsgrenze an.
- **Installation nach „Programme“**: Im Setup bei **Speicherort** auf **Ändern** klicken und `C:\Program Files`
  wählen (das Setup hängt `\Pulsar` an) oder `C:\Program Files\Pulsar` eintippen. Das Setup meldet „Für diesen
  Ordner braucht das Setup Administratorrechte“, startet sich nach einer Windows-Abfrage mit Adminrechten neu und
  trägt Pulsar in `HKLM` ein. Dort können normale Programme die Pulsar-Dateien nicht verändern.
- **Empfehlung:** Wer DNS oder die zwei Netzwerk-Einstellungen von Pulsar ändern lässt, installiert besser nach
  „Programme“. Wer diese Funktionen nicht nutzt, sieht nie eine Windows-Abfrage von Pulsar – dann reicht die
  Installation pro Benutzer.
- Die Benutzerdaten (mit den Sicherungen) liegen in beiden Fällen in `%APPDATA%\com.pulsar.booster` – also dort,
  wo Programme unter deinem Konto schreiben dürfen. Der Helfer ändert trotzdem nie mehr als DNS-Adressen und genau
  drei erlaubte Registry-Werte: Er prüft jeden Auftrag selbst, bevor er etwas ändert.

## Ablauf der Deinstallation

`run_uninstall` (`installer/src-tauri/src/uninstall.rs`) – gleich für die Oberfläche, `--uninstall --quiet` und den Selbsttest.
Die Schritt-Namen in `uninstall://progress` bleiben `stop | shortcuts | registry | files | data | done`.

| Schritt | Was passiert |
|---|---|
| `stop` | 1. Laufende `Pulsar.exe` beenden (hart – ein laufender Boost kann sich dabei nicht mehr selbst zurücknehmen).<br>2. **Windows-Einstellungen zurückstellen:** Trägt `<dir>\install.json` die Marke `"revertAll": true` und liegt `<dir>\Pulsar.exe` noch da, startet der Deinstaller `Pulsar.exe --revert-all` verborgen (Windows: `CREATE_NO_WINDOW`, Arbeitsordner `%TEMP%`). Ohne Marke (oder ohne lesbare `install.json`) ist es eine ältere Version, die `--revert-all` nicht kennt und sonst mit Fenster starten würde: Dann wird nichts gestartet, im Protokoll steht „ältere Version – nichts zurückzustellen“. Die App stellt den gesicherten DNS und alle Sicherungen aus **Optimieren** wieder her – mit höchstens einer Windows-Abfrage, keiner, wenn schon Adminrechte bestehen oder nichts zu tun ist (Vertrag: `docs/API.md`, „Deinstallieren: `Pulsar.exe --revert-all`“). Der Deinstaller wartet höchstens **120 s** und beendet den Prozess sonst. Danach werden übrig gebliebene `Pulsar.exe`-Prozesse noch einmal beendet, damit die Datei gelöscht werden kann. |
| `shortcuts` | Startmenü- und Desktop-Verknüpfung, Autostart entfernen |
| `registry` | „Apps & Features“-Eintrag und `HKCU\Software\Pulsar\Booster` entfernen |
| `files` | `Pulsar.exe`, `install.json`, Deinstaller, Download-Reste löschen; den Ordner nur, wenn er danach leer ist |
| `data` | Nur ohne „Meine Daten behalten“ **und** nur, wenn das Zurückstellen vollständig war: `%APPDATA%\com.pulsar.booster` und `%LOCALAPPDATA%\com.pulsar.booster` |

Zum Zurückstellen:
- `--revert-all` rufen nur Installationen mit der Marke `"revertAll": true` in `install.json` auf. Das Setup schreibt
  sie bei jeder Installation und jedem Update. Ältere Installationen bekommen sie also mit dem nächsten Update.
- Das Ergebnis (Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben, Zeitüberschreitung,
  Startfehler, „ältere Version“, „Pulsar.exe fehlt“, „anderes Konto“) und die Fehlerausgabe der App landen im Setup-Protokoll
  `%TEMP%\pulsar-setup.log`.
- **Anderes Konto:** Läuft die Deinstallation mit Adminrechten eines anderen Kontos als dem, das sie gestartet hat
  (`--user-data`, siehe oben), würde `--revert-all` dessen Datenordner lesen, dort keine Datenbank finden und
  fälschlich „nichts zu tun“ melden – DNS und HKLM-Werte gelten aber für den ganzen PC. Deshalb wird es dann nicht
  gestartet; das gilt als „nicht alles zurückgestellt“.
- **Nicht alles zurückgestellt** (Exit-Code ≠ 0, ohne Exit-Code beendet, Zeitüberschreitung, Startfehler, anderes Konto,
  oder die Marke ist da, aber `Pulsar.exe` fehlt): Die Deinstallation läuft weiter, aber die Pulsar-Daten werden **nicht**
  gelöscht – auch nicht, wenn „Meine Daten behalten“ abgewählt war. Dort liegen die Sicherungen (kv `opt.snapshots`,
  `net.dnsBackup`), mit denen eine neue Installation alles exakt zurückstellen kann. Der Deinstaller sagt das ehrlich:
  als Hinweis im Protokoll („Einige Windows-Einstellungen konnten nicht sicher zurückgestellt werden – deine
  Pulsar-Daten bleiben erhalten, damit eine neue Installation sie zurückstellen kann.“, Deutsch oder Englisch je nach
  Systemsprache), bei `--uninstall --quiet` zusätzlich auf der Fehlerausgabe, und in der Oberfläche als Warnung auf der
  Fertig-Seite (`uninstall://done` mit `revertOk: false`) samt Anleitung: Pulsar neu installieren und auf der Seite
  **Optimieren** oben auf **Alles zurückstellen** klicken – oder gleich wieder deinstallieren und der Windows-Abfrage zustimmen.
- Ein Fehler bricht die Deinstallation **nie** ab. Lehnt man die Windows-Abfrage ab, bleiben DNS und die zwei
  Netzwerk-Einstellungen so, wie Pulsar sie eingestellt hat; Verknüpfungen, Registry-Einträge und App-Dateien werden
  trotzdem entfernt, die Pulsar-Daten bleiben (siehe oben).
- Es passiert vor dem Löschen der Benutzerdaten, denn dort liegen die Sicherungen.
- Auch `--uninstall --quiet` stellt zurück; ohne Adminrechte kann dabei die Windows-Abfrage erscheinen.
  `--quiet` behält die Benutzerdaten ohnehin immer.
- Der Selbsttest (`--selftest`) prüft, dass `install.json` die Marke trägt, und meldet den Schritt `uninstall` rot,
  wenn `--revert-all` mit einem anderen Exit-Code als 0, ohne Exit-Code oder nach Zeitüberschreitung endet – oder gar
  nicht aufgerufen wurde. Ein Startfehler bleibt dort nur ein Hinweis (in den Unit-Tests ist die „App“ eine Attrappe).
- Grenze: Arbeitest du mit einem Standardkonto und gibst beim Deinstallieren das Kennwort eines **anderen**
  Admin-Kontos ein, läuft der Deinstaller unter diesem Admin-Konto. Er sieht dann die Pulsar-Daten deines Kontos nicht:
  Er stellt nichts zurück und löscht diese Daten auch nicht. Stelle in diesem Fall vorher in Pulsar alles zurück.
