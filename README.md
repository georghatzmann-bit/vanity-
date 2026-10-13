# ✦ NOVA – Premium Game & App Launcher für Windows

NOVA bündelt alle Spiele und Programme in einer edlen, animierten Oberfläche – mit Spielzeit-Messung,
Statistiken, Erfolgen, Big-Picture-Modus und einem eigenen, animierten Setup-Installer.

**Anleitung in einfachen Worten:** [docs/ANLEITUNG.md](docs/ANLEITUNG.md)

## Schnellstart

```cmd
npm install
npm run doctor      :: prüft, ob alles zum Bauen da ist
npm run build:all   :: baut App + Installer
```

Ergebnis in `release/`:

| Datei | Inhalt |
|---|---|
| `release/NovaLauncher.exe` | die App |
| `release/NovaLauncher-Setup.exe` | der animierte Installer (lädt die App aus dem Internet) |
| `release/latest.json` | Version, Download-Links und SHA-256-Prüfsummen für den Installer |

Unter Linux wird automatisch für Windows cross-kompiliert (`rustup target add x86_64-pc-windows-msvc`, `cargo install cargo-xwin`).

## Entwickeln

| Befehl | Was |
|---|---|
| `npm run dev` | App-Oberfläche im Browser mit Demo-Daten (http://localhost:1420) |
| `npm run dev:installer` | Installer-Oberfläche im Browser (http://localhost:1421, `?fail=1`, `?mode=uninstall`) |
| `npm run tauri:dev` | echte App mit Rust-Backend |
| `npm run typecheck` / `npm test` / `npm run test:rust` | Prüfungen und Tests |
| `node scripts/e2e-app.mjs <app> <ordner>` | Ende-zu-Ende-Test der echten App (Linux mit `xvfb-run`, Windows mit Edge-WebDriver) |
| `node scripts/e2e-installer-linux.mjs <setup> <nutzlast> <ordner>` | Ende-zu-Ende-Test des echten Installers inkl. Abbruch + Fortsetzen |

Was getestet wurde und was nicht: [docs/TESTBERICHT.md](docs/TESTBERICHT.md)

## Aufbau

```
nova.config.json        zentrale Einstellungen (Version, Download-Adresse)
shared/                 gemeinsames Design-System, Sound-Engine, UI-Bausteine
app/                    Nova Launcher (React + Tauri/Rust)
  src/                  Oberfläche: Seiten, Komponenten, Stores, Logik
  src-tauri/            Backend: SQLite, Scanner, Start/Spielzeit, Bilder, Tray, Overlay …
installer/              Nova Setup (React + Tauri/Rust): Download, SHA-256, Verknüpfungen, Deinstaller
scripts/                build-all, doctor, Oberflächen-Rundgänge (Screenshots)
docs/                   Anleitung, API-Verträge, Kreativ-Plan
.github/workflows/      Windows-Build mit Tests und automatischem Release
```

Technik: Tauri 2 · React 19 · TypeScript · Vite · Tailwind 4 · Motion · SQLite (rusqlite) · Web Audio.
