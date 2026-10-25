# Vanity

Ein moderner Launcher für **OG-Fortnite-Privatserver** – nur für den eigenen Gebrauch, nur mit
alten Builds, die man selbst besitzt. Kein Kontakt zu Epics echten Servern, keine Funktionen
für das aktuelle Fortnite.

> Vanity ist nicht mit Epic Games verbunden. „Fortnite“ ist eine Marke von Epic Games, Inc.

> **Quellen:** Vanity baut auf freien Projekten auf – Backend aus LawinServer, Game Server aus Magnesium/Erbium, Umleitung aus Tellurium.
> **Versionen:** Vanity startet jede Version ab 1.7 (Chapter 1 bis Chapter 6 und neuer). Getestet ist bisher 19.10; alle anderen laufen als „ungetestet“ mit – Details in [`docs/02-architektur.md`](docs/02-architektur.md#versionen).
>
> Vanity basiert beim Ingame-Menü auf **ATLAS Console** von cipherfps, ralz und Mitwirkenden. Alle Lizenzen: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Recherche + Plan | fertig – siehe [`docs/00-recherche-und-plan.md`](docs/00-recherche-und-plan.md) |
| 1 | Launcher-Oberfläche | fertig |
| 2 | Fortnite 19.10 starten + Logs | im Installer – [`docs/03-test-vollversion.md`](docs/03-test-vollversion.md) |
| 3 | Backend + Lobby | im Installer (Backend aus LawinServer) |
| 4 | Game Server, Match auf 127.0.0.1 | im Installer (`vanity_server.dll` aus Magnesium) – Steuerung vorerst über das Server-Fenster |
| 5 | Ingame-Menü (F9) | im Installer (`vanity_client.dll`, Basis ATLAS Console) – wartet auf Test |
| 6 | Bots | im Server-Fenster (Magnesium) – Launcher-Steuerung folgt |
| 7 | Trickshot-Modus + Match-Steuerung | Steuer-Pipe Launcher ↔ Server eingebaut (Playlist, Lategame, Start, Bots, Befehle); Trickshot-Presets über das Server-Fenster – wartet auf Test |
| 8 | Feinschliff, Absturz-Analyse, Installer | Absturz-Analyse + Installer fertig, Feinschliff läuft |

## Aufbau

```
launcher/     Tauri 2 – Oberfläche (React, TypeScript, Tailwind, shadcn/ui) + Logik in Rust
backend/      eingebautes Backend (Node + TypeScript)          – ab Phase 3
native/       Spiel-DLLs in C++20 (Visual Studio 2022, x64)    – ab Phase 2
docs/         Plan und Test-Checklisten
```

## Selbst bauen (optional)

Normalerweise baut GitHub Actions den Windows-Installer aus diesem Quellcode
(Reiter **Actions** → letzter Lauf → **Artifacts**). Wer selbst bauen will:

1. [Node 22](https://nodejs.org), [pnpm](https://pnpm.io), [Rust](https://rustup.rs) und die
   [Tauri-Voraussetzungen für Windows](https://v2.tauri.app/start/prerequisites/) installieren.
2. Im Ordner `launcher/`:
   ```
   pnpm install
   pnpm tauri dev      # startet den Launcher zum Ausprobieren
   pnpm tauri build    # baut den Installer
   ```

## Lizenz

GPL-3.0 – siehe [`LICENSE`](LICENSE). Verwendete Projekte und ihre Lizenzen stehen in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
