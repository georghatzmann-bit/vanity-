# @aegis/desktop – AEGIS Suite Desktop-App

Tauri 2 (Rust, `src-tauri/`) + React (`src/`). Start: `pnpm --filter @aegis/desktop tauri dev`.

## Sicherheitsrahmen des App-Fensters

| Maßnahme                                                       | Wo                                    | Geprüft durch                                    |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Strikte CSP ohne `'unsafe-inline'` und ohne `data:`            | `src-tauri/tauri.conf.json`           | `src/csp.test.ts`, `e2e/security.spec.ts`        |
| Keine IPC-Rechte (`permissions: []`)                           | `src-tauri/capabilities/default.json` | `tests/tauri-config.test.ts`                     |
| Navigations-Wächter: nur die eigene Oberfläche im Fenster      | `src-tauri/src/navigation.rs`         | Rust-Tests in `navigation.rs`, Konfig-Test       |
| `freezePrototype: true`, `withGlobalTauri: false`              | `src-tauri/tauri.conf.json`           | `tests/tauri-config.test.ts`, e2e (nachgebildet) |
| Kein Inline-Code im ausgelieferten `index.html`                | `index.html`, Build                   | `src/csp.test.ts`, e2e (gebautes `dist`)         |
| WebView-Code ohne Node-Typen                                   | `tsconfig.app.json`                   | `tests/tsconfig.test.ts`                         |
| Installer pro Nutzer, Deutsch zuerst (Englisch als 2. Sprache) | `bundle.windows.nsis`                 | `tests/tauri-config.test.ts`                     |

**CSP.** `style-src 'self'`: React und Motion setzen Stile über das CSSOM (`element.style`), das
die CSP nicht betrifft – `'unsafe-inline'` ist dafür nicht nötig. Ohne `'unsafe-inline'` kann
ein eingeschleustes `<style>`-Element oder `style`-Attribut (etwa über einen Dateinamen im
Bestätigungsdialog) die Knöpfe „Nein“ / „Ja, ausführen“ nicht überdecken oder umgestalten.
`img-src`/`font-src 'self'`: Vite bettet keine Datei als `data:`-URI ein (`vite.config.ts`).
Die Vorschau (`vite preview`, Grundlage der e2e-Tests) sendet dieselben Direktiven; Tauri ordnet
sie nur anders an und ergänzt Hashes der gebündelten Skripte (semantisch gleich, siehe `src/csp.ts`).

**IPC-Rechte.** P0 ruft keinen Tauri-Befehl auf, daher gewährt die Capability nichts – auch
nicht `core:default` (das allein öffnet rund 70 Befehle, u. a. App-Menü ersetzen, Pfade des
Nutzers auslesen, Events an das Backend senden). Eine neue Berechtigung wird einzeln als
`core:<plugin>:allow-<befehl>` eingetragen, nie als `:default`-Bündel, und hier begründet:

| Berechtigung | Begründung |
| ------------ | ---------- |
| –            | –          |

Dieselbe Liste steht als `JUSTIFIED_PERMISSIONS` in `tests/tauri-config.test.ts`.

**Navigation.** Die CSP regelt keine Navigation des ganzen Fensters. Das Plugin
`aegis-navigation-guard` (`src-tauri/src/navigation.rs`) bricht jede Navigation ab, die nicht
zum Ursprung der gebündelten Oberfläche führt (`http://tauri.localhost` unter Windows,
`tauri://localhost` sonst); nur im Entwicklungs-Build (`cfg(dev)`) zusätzlich zum Vite-Server
aus `build.devUrl`. So kann kein Link eine fremde Seite im AEGIS-Fenster öffnen, die die
Bestätigungs-Oberfläche nachahmt. Neue Fenster lehnt wry ohnehin ab. Externe Links bekommen
später einen eigenen, vom Nutzer bestätigten Öffner.

## Tests

- `pnpm test` – Vitest: `src/**/*.test.ts(x)` (App) und `tests/*.test.ts` (Konfiguration,
  CI-Workflows unter `.github/workflows`, tsconfig).
- `pnpm test:e2e` – Playwright gegen `vite preview` mit derselben CSP und eingefrorenem
  `Object.prototype` wie im Tauri-Fenster.
- `cargo test -p aegis-desktop` – Rust-Tests (Navigations-Wächter).
- `pnpm typecheck` – `tsconfig.app.json` (WebView-Code, nur Browser-Typen) und
  `tsconfig.node.json` (Tests, e2e, Vite-/Playwright-Konfiguration, mit Node-Typen).
