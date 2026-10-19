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
Strikte CSP, `withGlobalTauri: false`, `freezePrototype: true`, minimale Capabilities.
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
Der Start-Klang wird nur gespielt, wenn der AudioContext ohne Nutzergeste starten darf;
sonst bleibt es still (Chromium protokolliert dann eine Warnung, keinen Fehler). Ob die App
Autoplay in WebView2 erlauben soll, wird in P1 mit den Einstellungen entschieden.
