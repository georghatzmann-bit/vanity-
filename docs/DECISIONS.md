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
