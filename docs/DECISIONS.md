# Entscheidungen (ADR-Kurzform)

## D-001 – Entwicklung im Linux-Container, Windows-Verifikation über CI
**Kontext:** Der Entwicklungs-Container hat weder WebView2 noch MSVC/Windows-SDK.
**Entscheidung:** Plattformneutraler Code wird lokal gebaut und getestet. Windows-Code steht
hinter `cfg(windows)` und wird lokal mit `cargo clippy --target x86_64-pc-windows-msvc`
(ohne Linken) geprüft. Echte Windows-Builds, Tests und der NSIS-Installer laufen in GitHub
Actions (`windows-latest`). Das Windows-SDK wird **nicht** per `xwin` in den Container geladen,
weil dafür Microsofts Lizenzbedingungen akzeptiert werden müssten.

## D-002 – Monorepo mit pnpm + Cargo-Workspace
`@aegis/ui` wird als Quellpaket (TypeScript direkt) von Vite eingebunden – kein eigener
Build-Schritt, schnelle Iteration. Rust-Abhängigkeiten zentral in `[workspace.dependencies]`.

## D-003 – Zusätzliches Crate `crates/core` für die Goldene Regel
**Kontext:** Die Ordnerstruktur sieht kein gemeinsames Crate vor, aber jedes Fachmodul braucht
dieselben Freigabe-Typen. **Entscheidung:** `aegis-core` enthält `ActionPlan`, `ConsentGate`,
`Approval`, Prüfprotokoll, Risikostufen und Test-Hilfen. Verändernde APIs nehmen
`Approval` als Wert – die Regel wird damit vom Compiler erzwungen, nicht nur per Konvention.

## D-004 – Design-Tokens: Tailwind 4 CSS-first + TypeScript-Spiegel
Tokens liegen als CSS-Variablen (`@theme`) vor; ein TS-Spiegel dient Canvas/Motion.
Ein Test stellt sicher, dass beide übereinstimmen und alle Text/Hintergrund-Paare WCAG AA erfüllen.

## D-005 – Schriften lokal gebündelt
Inter Variable (UI) und JetBrains Mono (Hashes/Technik), beide SIL OFL 1.1, über
`@fontsource-variable/*` lokal eingebunden. Keine CDN-Abrufe (offline, keine Telemetrie).

## D-006 – TypeScript 6.0 statt 7.0
`typescript-eslint` 8.71 unterstützt TypeScript `<6.1`. Wechsel auf 7.x, sobald unterstützt.

## D-007 – Playwright 1.56.1 gepinnt
Passt zum vorinstallierten Chromium im Container; in CI identisch. Update bewusst später.

## D-008 – Tauri-Härtung
Strikte CSP ohne `unsafe-inline`, `withGlobalTauri: false`, `freezePrototype: true`, keine
Capabilities (`permissions: []`) bis ein IPC-Befehl sie braucht, Navigationswächter.
Installation pro Nutzer (NSIS `currentUser`); der Windows-Dienst bekommt einen eigenen,
UAC-pflichtigen Installationsschritt.

## D-009 – Bezeichner `app.aegissuite.desktop`
Vorläufiger Tauri-Identifier (keine Domain registriert). Änderung vor dem ersten Release möglich.

## D-010 – Projektlizenz offen
Rechtliche Entscheidung des Nutzers. Bis dahin keine Lizenzangabe, `publish = false`/`private`.

## D-011 – Ausführende Funktionen nehmen `ExecutionPermit`, nicht `Approval`
Die Erlaubnis enthält eine Kopie des freigegebenen Plans; Ausführer lesen Ziele und Parameter
nur daraus. So kann man einer Ausführung keinen anderen Plan unterschieben.

## D-012 – Versiegelte Uhr
`redeem` prüft Fristen mit der Uhr des Tors statt mit einem übergebenen Zeitpunkt. `Clock` ist
versiegelt: außerhalb von `aegis-core` gibt es nur `SystemClock` (und `ManualClock` im
Test-Feature). Produktionscode kann Fristen nicht mit erfundenen Zeiten umgehen.

## D-013 – Plan-Parameter sind Teil des Digests
`ActionPlan` hat eine sortierte Parameter-Tabelle (z. B. `destination`, `new_name`). Ohne sie
müssten Ausführer Werte von außerhalb des freigegebenen Plans nehmen.

## D-014 – Freigabe-Tor ohne I/O
`ConsentGate` sammelt Audit-Ereignisse; der Dienst holt sie ab und schreibt das Protokoll.
Der Kern bleibt deterministisch und ohne Dateizugriff testbar.

## D-015 – Mutations-Sperre per Clippy + Allowlist-Test
Statt einer reinen Konvention sperrt `clippy.toml` verändernde std-APIs. `OpenOptions::open`
bleibt erlaubt (Lesen braucht es), gesperrt sind die Schreib-/Anlege-/Kürz-Schalter.
Ausnahmen brauchen Markierung + Eintrag in `crates/core/mutation-allowlist.txt`.

## D-016 – Design-Quellen
`tokens.css` ist die Quelle, `tokens.ts` wird per Test dagegen geprüft. Logo-Assets
(`packages/ui/assets/*.svg`) erzeugt `scripts/export-logo.mjs` aus `geometry.ts`; App-Icons
werden mit `tauri icon` aus `logo-mark.svg` erzeugt.

## D-017 – CSP-Einzelquelle und lokale Schriften
`tauri.conf.json` ist die einzige CSP-Quelle; `vite preview` sendet dieselbe Richtlinie
(`apps/desktop/src/csp.ts`), damit Playwright unter App-Bedingungen testet. Schriften werden
nie als `data:` eingebettet (`font-src 'self'`).

## D-018 – Start-Klang und Autoplay
Vor der ersten Nutzergeste (`navigator.userActivation`) wird kein AudioContext erzeugt – der
Start-Klang beim Kaltstart bleibt still, ohne Browser-Warnung. Ob die App Autoplay in WebView2
erlauben soll, damit der Start-Klang hörbar ist, wird in P1 mit den Einstellungen entschieden.

## D-019 – Eigener Router und eigenes i18n
Hash-Router und typisiertes i18n (de als Quelle, en typgeprüft) ohne Fremdabhängigkeit.
Einstellungen unter `aegis.settings` (v1) im localStorage; Daten einer neueren Version werden
nie überschrieben.

## D-020 – Freigabe-Dialog: Schutz vor versehentlichem „Ja“
Fokus startet auf „Nein“, Esc = Nein, kein Schließen-X, Klick daneben tut nichts. „Ja“,
„Vertrauen“ und „Ignorieren“ sind nach dem Öffnen (und bei Planwechsel/Wechsel des obersten
Dialogs) 600 ms gesperrt; ein Druck, der während der Sperre beginnt, zählt nicht. Endgültiges
Löschen: zweiter Dialog mit Countdown statt Bestätigungswort.

## D-021 – Schließen und Infobereich
Ob in den Infobereich versteckt wird, entscheidet Rust (`hide_to_tray`) – nur wenn das
Tray-Symbol existiert. Alt+F4/Taskleiste beenden AEGIS immer. Der Schutz-Dienst (ab P2) läuft
unabhängig von der Oberfläche.

## D-022 – Fehlerdialog über `rfd`
Statt eigenem `unsafe`-FFI (MessageBoxW) nutzt die App `rfd` (MIT) – weniger eigenes unsafe.

## D-023 – Eigenes Crate `aegis-winffi` für `unsafe`
Alle Bibliotheken unter `crates/` tragen `#![forbid(unsafe_code)]`. Die einzige Ausnahme ist
`aegis-winffi` (Named Pipe mit SDDL, Datenordner-DACL): jede `unsafe`-Stelle mit
`// SAFETY:` und `// aegis-unsafe:`-Markierung in der Allowlist. So bleibt FFI an einer
prüfbaren Stelle.

## D-024 – Nur der Dienst nimmt Nutzerantworten an
`ConsentGate::decide`/`confirm_second` sind per `clippy.toml` gesperrt; einzige Ausnahme ist
der Handler in `crates/service`. Die App gibt die Antwort nur weiter (mit Plan-ID, Digest,
Nonce). Die App hält kein eigenes Tor.

## D-025 – Eigener Pipe-Client in der App
Die App spricht das Dienstprotokoll mit einem kleinen eigenen Client (`src-tauri/src/service.rs`),
statt das Dienst-Crate einzubinden – die App zieht so weder Engine noch Quarantäne nach und
prüft Eingaben selbst, bevor sie etwas sendet.

## D-026 – Dateiauswahl über `tauri-plugin-dialog`
Pfade wählt der Nutzer im System-Dialog (nur `dialog:allow-open`). Die Oberfläche bekommt
keinen Dateisystem-Zugriff; sie reicht nur die gewählten Pfade an den Dienst.

## D-027 – Quarantäne-Format
AES-256-GCM in 1-MiB-Blöcken (Nonce = 7-Byte-Präfix + Zähler + Letzter-Block-Flag, Kopf als
AAD) – große Dateien ohne ganzen Inhalt im Speicher, Abschneiden/Umordnen fällt auf.
Wiederherstellen schreibt erst eine versteckte Teil-Datei neben dem Ziel, prüft SHA-256 und
Größe und legt sie erst dann an den ursprünglichen Ort; ein belegtes Ziel wird nicht überschrieben.
