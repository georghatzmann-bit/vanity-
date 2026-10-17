# Phoenix

**Windows zurücksetzen, ohne alles neu einrichten zu müssen.**
Phoenix merkt sich vor dem Reset, welche Apps und Spiele auf deinem PC sind – und installiert sie danach automatisch wieder. Für Windows 10 und 11 (64-Bit).

---

## Was Phoenix macht

| | |
|---|---|
| **Sichern** – vor dem Reset | Phoenix liest alle installierten Apps, Spiele (Steam, Epic) und deine Hardware aus und speichert das als kleines Profil: auf dem USB-Stick, einer zweiten Festplatte, in OneDrive oder als Wiederherstellungs-Code zum Kopieren. Du musst nichts auswählen – es wird alles gesichert. |
| **Wiederherstellen** – nach dem Reset | Phoenix findet dein Profil von selbst (USB-Stick, Laufwerke, Desktop, Downloads, OneDrive). Du hakst an, was zurück soll – Phoenix installiert es still im Hintergrund, mit Live-Fortschritt. |
| **Schnell-Setup** – ohne Profil | Für einen frischen PC: aus einer geprüften Liste beliebter Programme auswählen und alles in einem Rutsch installieren. |

Installiert wird über **winget**, den offiziellen Paketmanager von Windows. Phoenix lädt also nur Original-Installer der Hersteller.

---

## Download & Installation

1. **`Phoenix-Setup-x.y.z.exe`** herunterladen (Seite *Releases* dieses Projekts).
2. Doppelklick. Windows fragt **einmal nach Administratorrechten** – mit **Ja** bestätigen (Phoenix wird nach `C:\Programme\Phoenix` installiert).
3. Ein kleines Fenster „Installation läuft…“ erscheint, danach startet Phoenix von selbst. Verknüpfungen liegen auf dem Desktop und im Startmenü.

### Blauer Bildschirm „Der Computer wurde durch Windows geschützt“

Das ist **SmartScreen**. Es erscheint, weil Phoenix (noch) nicht digital signiert ist – nicht, weil etwas gefunden wurde.

1. Auf **„Weitere Informationen“** klicken.
2. Auf **„Trotzdem ausführen“** klicken.

> Tipp: Startest du das Setup von einem USB-Stick (FAT32/exFAT), fragt SmartScreen meist gar nicht nach.

### Sonderfall: Smart App Control (frisch zurückgesetztes Windows 11)

Nach einem Reset kann **Smart App Control** aktiv sein. Im Modus *Auswertung* blockiert es nichts. Steht es auf **Ein**, blockiert es unsignierte Programme komplett – dann gibt es **keinen** „Trotzdem ausführen“-Knopf.

- Ausschalten: **Windows-Sicherheit → App- & Browsersteuerung → Smart App Control → Aus**.
- Achtung: Je nach Windows-Version lässt sich Smart App Control danach erst nach einem erneuten Zurücksetzen wieder einschalten. Überlege dir das vorher.
- Windows 10 hat kein Smart App Control.

---

## So gehst du vor (empfohlen)

1. **Phoenix installieren** – auf dem PC, der zurückgesetzt werden soll.
2. **Sichern** → als Ziel den **USB-Stick** wählen. Zusätzlich lohnt sich der **Wiederherstellungs-Code** (z. B. per WhatsApp oder Mail an dich selbst schicken).
3. **Setup auch auf den Stick** – Phoenix kopiert `Phoenix-Setup-*.exe` automatisch mit, wenn die Datei in *Downloads* oder auf dem *Desktop* liegt. Sonst einfach selbst auf den Stick ziehen.
4. **Windows zurücksetzen.**
5. **Setup vom Stick starten** und Phoenix installieren.
6. **Wiederherstellen** → Profil vom Stick wählen → Apps anhaken → los.

> Die Kopie unter `Dokumente\Phoenix` wird beim kompletten Reset **mitgelöscht**. Verlass dich nicht allein darauf.

---

## Was zurückkommt – und was nicht

| | Wird wiederhergestellt? |
|---|---|
| **Apps** (Browser, Discord, Spotify, Office-Tools …) | **Ja**, automatisch – alles, was es bei winget oder im Microsoft Store gibt. |
| Apps ohne winget-Paket | Erscheinen als Liste **„Manuell“** mit Namen und Version – die installierst du selbst. |
| **Spiele** (Steam, Epic Games …) | **Über die Launcher:** Phoenix installiert Steam/Epic und öffnet für jedes Spiel die Installationsseite im Launcher. Der Download läuft dort, nach deiner Anmeldung. |
| Grafiktreiber | **Hinweis:** Phoenix kennt deine Grafikkarte und schlägt die passende Hersteller-App (NVIDIA App / AMD) vor. |
| **Eigene Dateien** (Dokumente, Bilder, Spielstände außerhalb der Cloud) | **Nein** – vorher selbst sichern (OneDrive, externe Festplatte). |
| **Einstellungen, Passwörter, Lizenzen, Logins** | **Nein** – Apps starten wie frisch installiert. Passwörter im Browser-Konto synchronisieren, Lizenzschlüssel notieren. |

---

## Hilfe bei Problemen

**„winget fehlt“ oder „winget funktioniert nicht“**
Phoenix prüft winget beim ersten Start und vor jeder Installation und repariert es selbst. Klappt das nicht:
Microsoft Store öffnen → nach **„App-Installer“** suchen → **Aktualisieren**. Danach Windows Update laufen lassen und Phoenix neu starten.

**Admin-Abfrage abgelehnt**
Phoenix fragt vor dem Installieren **einmal** nach Adminrechten. Hast du „Nein“ geklickt, macht Phoenix ohne weiter: Programme, die Adminrechte brauchen, fragen dann einzeln nach – oder schlagen fehl. Auf dem Abschluss-Bildschirm mit **„… erneut versuchen“** nochmal starten und diesmal **Ja** klicken.

**Etwas ist schiefgegangen – Log exportieren**
**Einstellungen** (Zahnrad) → **Log exportieren**. Die Datei landet auf dem Desktop und hilft bei der Fehlersuche. Alle Logs liegen außerdem unter `%APPDATA%\Phoenix\logs`.

**Phoenix deinstallieren**
Windows-Einstellungen → Apps → Phoenix → Deinstallieren. Deine Profile und Logs in `%APPDATA%\Phoenix` bleiben erhalten.

---

## Für Entwickler

Electron-App (Main-Prozess CommonJS, Renderer mit Vite, `three` + `gsap`). Verträge, IPC und Datenformate: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

```bash
# Abhängigkeiten (Node 22). Die Spiegel beschleunigen die Electron-Downloads, sind aber optional.
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install

npm start            # Renderer bauen + Electron starten (unter Linux/macOS automatisch im Mock-Modus)
npm run dev          # nur Vite-Dev-Server; im Browser läuft die Mock-API (src/renderer/core/mock-api.js)
npm test             # Unit-Tests der PURE-Module (node:test)
```

| Variable | Wirkung |
|---|---|
| `PHOENIX_MOCK=1` | Fake-Scan und Fake-Installationen auch unter Windows (Demo, E2E). |
| `PHOENIX_MOCK_SPEED=0.2` | Mock-Abläufe schneller (< 1) oder langsamer (> 1). |
| `PHOENIX_DEVTOOLS=1` | DevTools auch in der gepackten App. |

**Setup.exe bauen**

```bash
npm run dist              # unter Windows: vite build + electron-builder --win nsis --x64
npm run dist:linux-host   # unter Linux/macOS, ohne Wine (scripts/dist.mjs)
```

- Ergebnis: `release/Phoenix-Setup-<version>.exe` (≈ 107 MB). `dist/` ist die Vite-Ausgabe, nicht das Installer-Verzeichnis.
- `scripts/dist.mjs` setzt `CSC_IDENTITY_AUTO_DISCOVERY=false`, nutzt die npmmirror-Spiegel, solange keine eigenen gesetzt sind (`PHOENIX_NO_MIRROR=1` = offizielle Server), und prüft danach mit `scripts/verify-dist.mjs` den Inhalt von `app.asar`.
- Ohne Wine: electron-builder bearbeitet Icon/Version/Manifest per `resedit` (reines JS) und braucht Wine nur, um das Uninstaller-Programm aus einem Zwischen-Installer zu erzeugen. `dist.mjs` legt dafür über `ELECTRON_BUILDER_WINE_TOOLSET_DIR` ein Mini-„wine“ an, das den Uninstaller mit electron-builders eigenem `UninstallerReader` extrahiert (byte-identisch zum Wine-Build). Beim Update von electron-builder prüfen: der Shim nutzt den internen Pfad `app-builder-lib/out/targets/nsis/nsisUtil`.
- CI: `.github/workflows/build.yml` (Windows-Runner) – `npm ci`, `npm test`, Build, Setup.exe als Artefakt; ein Tag `vX.Y.Z` erzeugt zusätzlich ein GitHub-Release mit dieser Version.

**Weitere Skripte**

- `npm run icon` – erzeugt `build/icon.svg`, `build/icon.png` (1024) und `build/icon.ico` (16–256, jede Größe nativ gerendert) aus dem Logo in `src/renderer/components/icons.js`. Braucht Playwright (Chromium) und Python mit Pillow.
- `PWSH=/pfad/zu/pwsh node scripts/check-ps.mjs` – parst alle eingebetteten PowerShell-Skripte und `Ensure-Winget.ps1` mit dem echten PowerShell-Parser.

**Installer-Entscheidungen** (`package.json` → `build`)

- **Installation pro Maschine (`perMachine: true`) – bewusst, aus Sicherheitsgründen.** Phoenix startet für Installationen einen Worker mit Adminrechten, und zwar dieselbe `Phoenix.exe` mit `--worker`. Läge sie im benutzerbeschreibbaren `%LOCALAPPDATA%\Programs`, könnte jedes Programm, das als normaler Benutzer läuft, die Exe, `app.asar` oder eine DLL daneben austauschen und bekäme beim nächsten „Ja“ in der UAC-Abfrage volle Adminrechte. Unter `C:\Program Files\Phoenix` können nur Admins schreiben. Der Preis: eine UAC-Abfrage beim Setup (und beim Deinstallieren).
- **oneClick + runAfterFinish:** Kein Assistent. Danach startet electron-builder die App über `StdUtils::ExecShellAsUser`, also **ohne** Adminrechte (wichtig für Drag & Drop und für Installer, die pro Benutzer installieren).
- **Keine Registry-Einträge** (`build/installer.nsh` bleibt minimal). Den ersten Start erkennt Phoenix selbst über `userData/installed-version`. `deleteAppDataOnUninstall: false` lässt Profile und Logs beim Deinstallieren stehen.
- `appId` `de.phoenix.restore` (= AppUserModelID), `electronLanguages: de, en-US` (spart ≈ 9 MB). Unsigniert – SmartScreen/Smart App Control siehe oben; echte Abhilfe wäre Code-Signing.
