# ◉ PULSAR – Game Booster für Windows

Pulsar misst deine Verbindung live und gibt ihr eine Note (A+ bis F), macht deinen PC mit **einem Klick**
bereit zum Spielen (Boost) und bringt die Werkzeuge mit, um Lags wirklich zu verstehen: Regionen-Ping,
Routen-Analyse, DNS-Vergleich, Speedtest mit Bufferbloat-Note, WLAN-Check. Dazu ein In-Game-Overlay,
Berichte zu jeder Runde und ein eigener, animierter Setup-Installer.

Alles **ohne Konto und ohne Abo**. Pulsar läuft als **normaler Benutzer** – Adminrechte braucht es nur, wenn du den
DNS wechselst oder die zwei Netzwerk-Optimierungen einschaltest; dann fragt Windows einmal nach (wer das nutzt,
installiert Pulsar besser nach „Programme“, siehe [docs/INSTALLER.md](docs/INSTALLER.md)). Jede Änderung wird vorher
gesichert und lässt sich exakt zurückstellen (beim Deinstallieren automatisch; klappt das nicht ganz, bleiben die
Sicherungen erhalten). Und ehrlich: Pulsar hat kein eigenes Servernetz und verspricht keinen „Ping-Zauber“. Es misst,
optimiert, was sich lokal optimieren lässt, und erklärt den Rest.

## Funktionen auf einen Blick

- **Live-Ping mit Note** (A+ bis F) – zu Rechenzentren oder echten Spielservern (CS2, Dota 2, Deadlock, LoL)
- **Boost per Klick** – Energieplan, Vorrang fürs Spiel, DNS-Zwischenspeicher leeren; alles wird wieder zurückgenommen
- **Netzwerk-Werkzeuge** – Regionen-Ping, Route, Speedtest mit Bufferbloat-Note, WLAN-Check
- **DNS automatisch einstellen** – vergleicht DNS-Dienste und stellt auf Knopfdruck den schnellsten ein; „Zurückstellen“ jederzeit.
  Ehrlich: Das beschleunigt das Nachschlagen von Adressen (Laden, Verbinden), nicht den Ping im Spiel.
- **Netzwerk automatisch optimieren** – schnellster DNS plus zwei Netzwerk-Einstellungen von Windows mit einer
  einzigen Windows-Abfrage. Die zwei Einstellungen bringen meist nur wenig und wirken erst nach einem Neustart.
- **Optimieren** – Windows-Einstellungen mit Schalter, jede mit Rückgängig
- **Spiele, Berichte, Overlay** – Bibliothek mit Covern, Bericht zu jeder Runde, Ping-Overlay im Spiel

**Anleitung in einfachen Worten:** [docs/ANLEITUNG.md](docs/ANLEITUNG.md)

**Alle Funktionen mit Bildern:** [docs/FUNKTIONEN.md](docs/FUNKTIONEN.md)

## Schnellstart

```cmd
npm install
npm run doctor      :: prüft, ob alles zum Bauen da ist
npm run build:all   :: baut App + Installer
```

Ergebnis in `release/`:

| Datei | Inhalt |
|---|---|
| `release/Pulsar.exe` | die App |
| `release/Pulsar-Setup.exe` | der animierte Installer (lädt die App aus dem Internet) |
| `release/latest.json` | Version, Download-Links und SHA-256-Prüfsummen für den Installer |

Unter Linux wird automatisch für Windows cross-kompiliert (`rustup target add x86_64-pc-windows-msvc`, `cargo install cargo-xwin`).

## Entwickeln

| Befehl | Was |
|---|---|
| `npm run dev` | App-Oberfläche im Browser mit Demo-Daten (http://localhost:1420) |
| `npm run dev:installer` | Installer-Oberfläche im Browser (http://localhost:1421, `?fail=1`, `?mode=uninstall`, `?mode=uninstall&revertfail` = Zurückstellen unvollständig) |
| `npm run tauri:dev` | echte App mit Rust-Backend |
| `npm run typecheck` / `npm test` / `npm run test:rust` | Prüfungen und Tests |
| `Pulsar.exe --selftest <bericht.json>` | Eingebauter Selbsttest (Scan, Cover, Ping, Regionen, Spielserver, DNS, Adapter, Tweaks, Boost, Starten, Spielzeit), Exit-Code 0 = alles ok – so prüft die Windows-CI |
| `Pulsar.exe --revert-all` | Stellt ohne Fenster alles zurück, was Pulsar an Windows geändert hat (gesicherter DNS und alle Optimierungen) – höchstens eine Windows-Abfrage. Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben. Der Deinstaller ruft das automatisch auf (nur bei Installationen mit der Marke `"revertAll": true` in `install.json`); klappt es nicht ganz, löscht er die Pulsar-Daten nicht. |
| `node scripts/feature-shots.mjs` | Screenshots aller Funktionen (Demo-Daten) für `docs/FUNKTIONEN.md`; vorher `npm run dev` und `npm run dev:installer` starten |
| `node scripts/e2e-app.mjs <app> <ordner>` | Ende-zu-Ende-Test der echten App per WebDriver (Linux mit `xvfb-run`) |
| `node scripts/e2e-installer-linux.mjs <setup> <nutzlast> <ordner>` | Ende-zu-Ende-Test des echten Installers inkl. Abbruch + Fortsetzen |

`Pulsar.exe --elevated <auftrag>` benutzt nur Pulsar selbst intern: Nach der Windows-Abfrage startet sich Pulsar damit
kurz als Admin-Helfer, der nur fest erlaubte Änderungen (DNS, zwei Netzwerk-Werte) ausführt. Nicht von Hand aufrufen.
Details: [docs/API.md](docs/API.md), Abschnitt „Admin-Helfer“.

Was getestet wurde und was nicht: [docs/TESTBERICHT.md](docs/TESTBERICHT.md)

## Aufbau

```
pulsar.config.json      zentrale Einstellungen (Version, Download-Adresse)
shared/                 gemeinsames Design-System, Sound-Engine, UI-Bausteine, Pulsar-Logo
app/                    Pulsar (React + Tauri/Rust)
  src/                  Oberfläche: Cockpit, Spiele, Netzwerk, Optimieren, Berichte, Einstellungen, Overlay
  src-tauri/            Backend: Ping/Monitor, Regionen, Route, DNS (vergleichen + einstellen), Speedtest,
                        Adapter/WLAN, Tweaks, Boost, Admin-Helfer, SQLite, Scanner, Start/Spielzeit, Bilder, Tray …
installer/              Pulsar Setup (React + Tauri/Rust): Download, SHA-256, Verknüpfungen, Deinstaller
scripts/                build-all, doctor, Screenshot-Rundgänge, Ende-zu-Ende-Tests
docs/                   Anleitung, Funktionen, API-Verträge, Testbericht, Kreativ-Plan
.github/workflows/      Windows-Build mit Tests und automatischem Release "pulsar-latest"
```

Technik: Tauri 2 · React 19 · TypeScript · Vite · Tailwind 4 · Motion · SQLite (rusqlite) · Web Audio · Windows-APIs (ICMP, IP Helper, WLAN, powercfg, UAC).
