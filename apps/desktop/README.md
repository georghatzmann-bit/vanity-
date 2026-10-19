# @aegis/desktop – AEGIS Suite Desktop-App

Tauri 2 (Rust, `src-tauri/`) + React (`src/`). Start: `pnpm --filter @aegis/desktop tauri dev`.

## Sicherheitsrahmen des App-Fensters

| Maßnahme                                                         | Wo                                                          | Geprüft durch                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Strikte CSP ohne `'unsafe-inline'` und ohne `data:`              | `src-tauri/tauri.conf.json`                                 | `src/csp.test.ts`, `e2e/security.spec.ts`             |
| Nur einzeln begründete IPC-Rechte, App-Befehle nur mit Recht     | `src-tauri/capabilities/default.json`, `src-tauri/build.rs` | `tests/tauri-config.test.ts`, Rust-Tests in `main.rs` |
| Navigations-Wächter: nur die eigene Oberfläche im Fenster        | `src-tauri/src/navigation.rs`                               | Rust-Tests in `navigation.rs`, Konfig-Test            |
| `freezePrototype: true`, `withGlobalTauri: false`                | `src-tauri/tauri.conf.json`                                 | `tests/tauri-config.test.ts`, e2e (nachgebildet)      |
| Kein Inline-Code im ausgelieferten `index.html`                  | `index.html`, Build                                         | `src/csp.test.ts`, e2e (gebautes `dist`)              |
| WebView-Code ohne Node-Typen                                     | `tsconfig.app.json`                                         | `tests/tsconfig.test.ts`                              |
| Installer pro Nutzer, Deutsch zuerst (Englisch als 2. Sprache)   | `bundle.windows.nsis`                                       | `tests/tauri-config.test.ts`                          |
| Startfehler sichtbar (Protokoll + Meldungsfenster unter Windows) | `src-tauri/src/startup_error.rs`                            | Rust-Tests in `startup_error.rs`                      |

**CSP.** `style-src 'self'`: React und Motion setzen Stile über das CSSOM (`element.style`), das
die CSP nicht betrifft – `'unsafe-inline'` ist dafür nicht nötig. Ohne `'unsafe-inline'` kann
ein eingeschleustes `<style>`-Element oder `style`-Attribut (etwa über einen Dateinamen im
Bestätigungsdialog) die Knöpfe „Nein“ / „Ja, ausführen“ nicht überdecken oder umgestalten.
`img-src`/`font-src 'self'`: Vite bettet keine Datei als `data:`-URI ein (`vite.config.ts`).
Die Vorschau (`vite preview`, Grundlage der e2e-Tests) sendet dieselben Direktiven; Tauri ordnet
sie nur anders an und ergänzt Hashes der gebündelten Skripte (semantisch gleich, siehe `src/csp.ts`).

**IPC-Rechte.** Die Capability gewährt nur, was die eigene Titelleiste, die Fenster-Ereignisse
und `app_info` brauchen – nicht `core:default` (das allein öffnet rund 70 Befehle, u. a. App-Menü
ersetzen, Pfade des Nutzers auslesen, Events an das Backend senden) und auch kein anderes
`:default`-Bündel. Jede Berechtigung steht einzeln als `core:<plugin>:allow-<befehl>` bzw.
`allow-<app-befehl>` in `src-tauri/capabilities/default.json` und ist hier begründet:

| Berechtigung                                 | Begründung                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:window:allow-minimize`                 | Knopf „Minimieren“ der eigenen Titelleiste (`minimize()`).                                                                                                                          |
| `core:window:allow-toggle-maximize`          | Knopf „Maximieren / Wiederherstellen“ (`toggleMaximize()`).                                                                                                                         |
| `core:window:allow-internal-toggle-maximize` | Doppelklick auf die Titelleiste: Tauris Skript für `data-tauri-drag-region` ruft dafür diesen internen Befehl auf (nicht `toggle_maximize`). Wirkung wie der Knopf.                 |
| `core:window:allow-is-maximized`             | Symbol des Maximieren-Knopfs passend zum Zustand (`isMaximized()`, nach jedem `onResized`). Nur lesend.                                                                             |
| `core:window:allow-start-dragging`           | Fenster an der Titelleiste verschieben: Tauris Skript für `data-tauri-drag-region` ruft `start_dragging` beim Drücken der linken Maustaste.                                         |
| `core:window:allow-hide`                     | Schließen-Knopf bei „Beim Schließen in den Infobereich“ (Standard: an): Fenster verstecken, AEGIS läuft im Infobereich weiter.                                                      |
| `core:window:allow-close`                    | Schließen-Knopf bei ausgeschalteter Infobereich-Einstellung: beendet AEGIS vollständig (`close()`, siehe „Schließen“).                                                              |
| `core:event:allow-listen`                    | Ereignisse empfangen: `tauri://resize` (für `onResized`) und `aegis://navigate` (Tray-Menü). Nur Empfangen – Senden an das Backend (`allow-emit`, `allow-emit-to`) bleibt gesperrt. |
| `core:event:allow-unlisten`                  | Empfänger wieder abmelden (z. B. beim Verlassen einer Seite), sonst bleiben sie bis zum Ende aktiv.                                                                                 |
| `allow-app-info`                             | App-Befehl `app_info` (Version, Build-Profil, Plattform für „Über AEGIS“). Nur lesend; der Befehl selbst macht kein I/O.                                                            |

Dieselbe Liste steht als `JUSTIFIED_PERMISSIONS` in `tests/tauri-config.test.ts` und als
`EXPECTED_PERMISSIONS` in `src-tauri/src/main.rs` (Rust-Test, prüft auch diese Tabelle).

Bewusst **nicht** gewährt: `core:window:allow-show`/`allow-set-focus`/`allow-unminimize`
(nach vorn holen nur das Tray-Menü und ein zweiter Start – in Rust, ohne IPC; die Oberfläche
braucht das nie), `core:window:allow-destroy`/`allow-create` (Fenster ohne Schließ-Ereignis
zerstören bzw. neue Fenster), alle `allow-set-*` (Größe, Position, Titel, Rahmen, Fokus,
„immer im Vordergrund“ …), `allow-start-resize-dragging` (Größe ändern an den Rändern
erledigt Tauri für rahmenlose Fenster selbst, ohne IPC), `core:event:allow-emit*`,
`core:app:*`, `core:menu:*`, `core:tray:*`, `core:path:*`, `core:webview:*`.

**Aufruf ↔ Recht.** Mit Tauri spricht nur `src/platform/platform.ts` (dazu Tauris eigenes
Zieh-Skript für `data-tauri-drag-region` in `src/shell/TitleBar.tsx`). Jeder Aufruf dort hat
genau ein Recht, jedes Recht mindestens einen Aufruf – geprüft in `tests/tauri-config.test.ts`
(Quelltext ↔ Capability) und zur Laufzeit in `src-tauri/src/main.rs` (Test-Laufzeit mit der
echten ACL: jeder Aufruf der Oberfläche läuft, alles andere wird abgelehnt).

| Aufruf der Oberfläche                                           | Tauri-Befehl                              | Recht                                        |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `getCurrentWindow().minimize()`                                 | `plugin:window\|minimize`                 | `core:window:allow-minimize`                 |
| `getCurrentWindow().toggleMaximize()`                           | `plugin:window\|toggle_maximize`          | `core:window:allow-toggle-maximize`          |
| Doppelklick auf `data-tauri-drag-region`                        | `plugin:window\|internal_toggle_maximize` | `core:window:allow-internal-toggle-maximize` |
| `getCurrentWindow().isMaximized()`                              | `plugin:window\|is_maximized`             | `core:window:allow-is-maximized`             |
| Ziehen an `data-tauri-drag-region`                              | `plugin:window\|start_dragging`           | `core:window:allow-start-dragging`           |
| `getCurrentWindow().hide()`                                     | `plugin:window\|hide`                     | `core:window:allow-hide`                     |
| `getCurrentWindow().close()`                                    | `plugin:window\|close`                    | `core:window:allow-close`                    |
| `getCurrentWindow().onResized()`, `.listen('aegis://navigate')` | `plugin:event\|listen`                    | `core:event:allow-listen`                    |
| Abmelden (Rückgabe von `onResized`/`listen`)                    | `plugin:event\|unlisten`                  | `core:event:allow-unlisten`                  |
| `invoke('app_info')`                                            | `app_info`                                | `allow-app-info`                             |

**App-Befehle nur mit Recht.** `src-tauri/build.rs` meldet die App-Befehle über
`tauri_build::AppManifest::commands` an. Damit gibt es ein ACL-Manifest der App, und Tauri lässt
App-Befehle nur noch mit ausdrücklicher Berechtigung zu (`allow-app-info`) – ohne dieses
Manifest stünde jeder App-Befehl jedem lokalen Fenster offen. Die Berechtigungsdatei
`src-tauri/permissions/autogenerated/app_info.toml` erzeugt das Build-Skript.

**Navigation.** Die CSP regelt keine Navigation des ganzen Fensters. Das Plugin
`aegis-navigation-guard` (`src-tauri/src/navigation.rs`) bricht jede Navigation ab, die nicht
zum Ursprung der gebündelten Oberfläche führt (`http://tauri.localhost` unter Windows,
`tauri://localhost` sonst); nur im Entwicklungs-Build (`cfg(dev)`) zusätzlich zum Vite-Server
aus `build.devUrl`. So kann kein Link eine fremde Seite im AEGIS-Fenster öffnen, die die
Bestätigungs-Oberfläche nachahmt. Neue Fenster lehnt wry ohnehin ab. Externe Links bekommen
später einen eigenen, vom Nutzer bestätigten Öffner.

## Fenster, Infobereich und Start (Rust-Seite)

**Rahmenloses Fenster.** `decorations: false` – Titelleiste und Fensterknöpfe zeichnet die
Oberfläche. `shadow: true` behält unter Windows den 1-px-Rand, den Schatten und (Windows 11)
die runden Ecken. Das Fenster bleibt in der Größe veränderbar (mindestens 1024 × 680).

**Kein Aufblitzen beim Start.** Bis die Oberfläche zum ersten Mal zeichnet, zeigt das Fenster
seine Hintergrundfarbe. `backgroundColor` in `tauri.conf.json` ist das dunkle `--aegis-bg`;
im Setup – vor dem ersten Zeichnen – stellt `window::match_system_background` sie auf das
Farbschema des Systems um (helles System, unter Windows Standard für Apps: `#f5f7fa`). So
passt der erste Frame zu „Darstellung: System“ (Standard), statt kurz dunkel aufzublitzen.
Beide Farben prüft ein Rust-Test gegen `packages/ui/src/tokens/tokens.css`. Grenze: Wer
„Dunkel“/„Hell“ fest gewählt hat und das System anders eingestellt ist, sieht beim Start
kurz die Systemfarbe – die Einstellung liegt im Speicher der WebView, den Rust nicht liest.

**Schließen.** Die Oberfläche entscheidet: Mit „Beim Schließen in den Infobereich“ (Standard:
an) ruft sie `hide()` auf, sonst `close()`. Jede Schließ-Anforderung des Hauptfensters beendet
in Rust die ganze App (`src-tauri/src/window.rs`) – auch das Tray-Symbol hält dann keinen
unsichtbaren Prozess am Leben. Das gilt ebenso für Alt+F4 und „Fenster schließen“ in der
Taskleiste: Diese Wege laufen an der Oberfläche vorbei und beenden AEGIS immer.

**Infobereich (Tray).** Symbol = App-Symbol, Tooltip „AEGIS Suite“, Menü „AEGIS öffnen“,
„Dashboard“, „Einstellungen“, Trenner, „Beenden“. Linksklick auf das Symbol zeigt das Fenster
(zeigen, wiederherstellen, fokussieren). „Dashboard“/„Einstellungen“ senden erst
`aegis://navigate` und zeigen dann das Fenster. Das Menü verändert nichts am System. Unter
Linux braucht das Symbol `libayatana-appindicator3` (Tauri-Voraussetzung; fehlt die Bibliothek,
bricht der Start mit einer Meldung im Startprotokoll ab); Klicks auf das Symbol meldet Linux
nicht, dort gibt es nur das Menü. Meldet das System beim Anlegen einen Fehler, startet AEGIS
ohne Tray-Symbol und vermerkt das im Startprotokoll.

**Nur eine Instanz** (`tauri-plugin-single-instance`). Ein zweiter Start holt das vorhandene
Fenster nach vorn (zeigen, wiederherstellen, fokussieren) und endet sofort; seine Argumente und
sein Arbeitsordner werden ignoriert. So bleibt ein in den Infobereich verstecktes Fenster auch
ohne Tray-Symbol erreichbar.

**Startfehler.** Kann AEGIS nicht starten (Fehler aus `Builder::build` oder eine Panic beim
Anlegen des Fensters, etwa ohne WebView2-Laufzeit), schreibt die App eine Zeile nach
`%LOCALAPPDATA%\AEGIS\logs\startup.log` (Linux: `$XDG_STATE_HOME/aegis/logs/startup.log`,
sonst `~/.local/state/aegis/logs/startup.log`), zeigt unter Windows ein natives
Meldungsfenster (deutsch, dann englisch; über `rfd`, ohne eigenes `unsafe`) und gibt die
Meldung auf stderr aus. Die Datei gehört AEGIS: nur anhängen, nie kürzen oder löschen, keine
Links, ab 1 MiB nichts mehr (die beiden Schreibstellen stehen in
`crates/core/mutation-allowlist.txt`).

## IPC-Vertrag (für die Oberfläche)

| Art                  | Name                 | Daten                                                                                                                                                                                        |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Befehl               | `app_info`           | → `{ "version": string, "buildProfile": "debug" \| "release", "os": "windows" \| "linux" \| "macos" \| string, "osVersion": string \| null, "arch": string, "tauriVersion": string }`        |
| Ereignis (Rust → UI) | `aegis://navigate`   | `{ "page": "dashboard" \| "settings" }`                                                                                                                                                      |
| Fenster-API          | `getCurrentWindow()` | `minimize()`, `toggleMaximize()`, `isMaximized()`, `onResized()`, `hide()`, `close()`, `listen()` (nur `aegis://navigate`) und `data-tauri-drag-region` (Ziehen, Doppelklick) – sonst nichts |

`osVersion`: Windows `10.0.<Build>.<UBR>` (Windows 11 meldet ebenfalls 10.0, Build ≥ 22000),
Linux `PRETTY_NAME` aus `os-release`, sonst `null`. Die Werte werden einmal beim Start erhoben.

## Tests

- `pnpm test` – Vitest: `src/**/*.test.ts(x)` (App) und `tests/*.test.ts` (Konfiguration,
  IPC-Vertrag Oberfläche ↔ Rust in `tests/ipc-contract.test.ts`, CI-Workflows unter
  `.github/workflows`, tsconfig).
- `pnpm test:e2e` – Playwright gegen `vite preview` mit derselben CSP und eingefrorenem
  `Object.prototype` wie im Tauri-Fenster.
- `cargo test -p aegis-desktop` – Rust-Tests (Navigations-Wächter, Rechte-Liste, IPC-Rechte zur
  Laufzeit mit der echten ACL, Tray-Menü → Aktion, Form von `app_info`, Fenster-Konfiguration
  und -Hintergrund, Pfad/Zeile/Meldung des Startprotokolls).
- `pnpm typecheck` – `tsconfig.app.json` (WebView-Code, nur Browser-Typen) und
  `tsconfig.node.json` (Tests, e2e, Vite-/Playwright-Konfiguration, mit Node-Typen).
