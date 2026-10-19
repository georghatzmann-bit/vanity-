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

**IPC-Rechte.** Die Capability gewährt nur, was die eigene Titelleiste, die Fenster-Ereignisse,
`app_info` und `hide_to_tray` brauchen – nicht `core:default` (das allein öffnet rund 70 Befehle, u. a. App-Menü
ersetzen, Pfade des Nutzers auslesen, Events an das Backend senden) und auch kein anderes
`:default`-Bündel. Jede Berechtigung steht einzeln als `core:<plugin>:allow-<befehl>` bzw.
`allow-<app-befehl>` in `src-tauri/capabilities/default.json` und ist hier begründet:

| Berechtigung                                 | Begründung                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:window:allow-minimize`                 | Knopf „Minimieren“ der eigenen Titelleiste (`minimize()`).                                                                                                                                        |
| `core:window:allow-toggle-maximize`          | Knopf „Maximieren / Wiederherstellen“ (`toggleMaximize()`).                                                                                                                                       |
| `core:window:allow-internal-toggle-maximize` | Doppelklick auf die Titelleiste: Tauris Skript für `data-tauri-drag-region` ruft dafür diesen internen Befehl auf (nicht `toggle_maximize`). Wirkung wie der Knopf.                               |
| `core:window:allow-is-maximized`             | Symbol des Maximieren-Knopfs passend zum Zustand (`isMaximized()`, nach jedem `onResized`). Nur lesend.                                                                                           |
| `core:window:allow-start-dragging`           | Fenster an der Titelleiste verschieben: Tauris Skript für `data-tauri-drag-region` ruft `start_dragging` beim Drücken der linken Maustaste.                                                       |
| `core:window:allow-close`                    | Schließen-Knopf bei ausgeschalteter Infobereich-Einstellung: beendet AEGIS vollständig (`close()`, siehe „Schließen“).                                                                            |
| `core:event:allow-listen`                    | Ereignisse empfangen: `tauri://resize` (für `onResized`) und `aegis://navigate` (Tray-Menü). Nur Empfangen – Senden an das Backend (`allow-emit`, `allow-emit-to`) bleibt gesperrt.               |
| `core:event:allow-unlisten`                  | Empfänger wieder abmelden (z. B. beim Verlassen einer Seite), sonst bleiben sie bis zum Ende aktiv.                                                                                               |
| `allow-app-info`                             | App-Befehl `app_info` (Version, Build-Profil, Plattform für „Über AEGIS“, ob es ein Symbol im Infobereich gibt). Nur lesend; der Befehl selbst macht kein I/O.                                    |
| `allow-hide-to-tray`                         | App-Befehl `hide_to_tray`: Schließen-Knopf bei „Beim Schließen in den Infobereich“ (Standard: an). Versteckt das Fenster nur, wenn es ein Symbol im Infobereich gibt (siehe „Schließen“).         |
| `allow-service-scan`                         | App-Befehl `service_scan`: Dateien/Ordner vom Dienst prüfen lassen. Nur lesend; Pfade werden geprüft (absolut, ≤ 1000).                                                                           |
| `allow-service-list-quarantine`              | App-Befehl `service_list_quarantine`: Quarantäne-Einträge anzeigen. Nur lesend.                                                                                                                   |
| `allow-service-propose-quarantine`           | App-Befehl `service_propose_quarantine`: Isolieren **vorschlagen** – der Dienst prüft selbst und formuliert den Plan; ausgeführt wird erst nach „Ja“.                                             |
| `allow-service-propose-restore`              | App-Befehl `service_propose_restore`: Wiederherstellen vorschlagen (nur Vorschlag).                                                                                                               |
| `allow-service-propose-delete`               | App-Befehl `service_propose_delete`: Endgültiges Löschen vorschlagen (nur Vorschlag; braucht danach zwei Bestätigungen).                                                                          |
| `allow-service-decide`                       | App-Befehl `service_decide`: Antwort aus dem Freigabe-Dialog an den Dienst – gilt nur mit der Einmal-Nonce des Vorschlags.                                                                        |
| `allow-service-confirm-second`               | App-Befehl `service_confirm_second`: Antwort im zweiten Dialog vor endgültigem Löschen (eigene Einmal-Nonce).                                                                                     |
| `allow-service-list-trust`                   | App-Befehl `service_list_trust`: eigene Vertrauensliste anzeigen (Hash + Pfad + Grund, nur lesend).                                                                                               |
| `allow-service-revoke-trust`                 | App-Befehl `service_revoke_trust`: einen eigenen Vertrauens-Eintrag widerrufen – macht AEGIS nur strenger, verändert keine Dateien.                                                               |
| `allow-service-watch-poll`                   | App-Befehl `service_watch_poll`: Meldungen des Echtzeit-Wächters abholen (eigenes Profil + gemeinsame Orte). Nur lesend.                                                                          |
| `allow-service-set-gaming`                   | App-Befehl `service_set_gaming`: Gaming-Modus an/aus – pausiert nur Prüfungen und Hinweise, endet spätestens nach 4 h. Verändert keine Dateien.                                                   |
| `allow-service-history`                      | App-Befehl `service_history`: eigener Verlauf (Scans, Wächter, Entscheidungen) für Berichte und Zeitleiste. Nur lesend.                                                                           |
| `allow-service-get-schedule`                 | App-Befehl `service_get_schedule`: eigener Zeitplan und Update-Einstellung anzeigen. Nur lesend.                                                                                                  |
| `allow-service-set-schedule`                 | App-Befehl `service_set_schedule`: geplanten Scan des eigenen Profils setzen (1/7/30 Tage, Stunde) – geplante Scans prüfen und melden nur.                                                        |
| `allow-service-set-clamav-update`            | App-Befehl `service_set_clamav_update`: tägliches ClamAV-Signatur-Update (Netzwerk) an/aus.                                                                                                       |
| `allow-service-lab-status`                   | App-Befehl `service_lab_status`: Zustand der Windows Sandbox und eigene Labor-Läufe samt Bericht. Nur lesend.                                                                                     |
| `allow-service-propose-lab-run`              | App-Befehl `service_propose_lab_run`: Labor-Lauf vorschlagen (Stufe, Sekunden, Netz) – der Dienst formuliert den Plan, gestartet wird nur nach „Ja“.                                              |
| `allow-service-lab-screenshot`               | App-Befehl `service_lab_screenshot`: Bildschirmfoto eines eigenen Laufs der Windows Sandbox (nur im Bericht genannte Namen). Nur lesend.                                                          |
| `allow-service-lab-report`                   | App-Befehl `service_lab_report`: vollständiger Verhaltensbericht eines eigenen, fertigen Laufs (auf Anfrage). Nur lesend.                                                                         |
| `allow-service-propose-enable-sandbox`       | App-Befehl `service_propose_enable_sandbox`: „Windows Sandbox einschalten“ vorschlagen – nur Administratoren, nur nach „Ja“.                                                                      |
| `allow-service-propose-process-action`       | App-Befehl `service_propose_process_action`: laufende Prozesse eines Programms beenden/anhalten/fortsetzen vorschlagen – nur eigene, nur nach „Ja“.                                               |
| `allow-service-ransom-status`                | App-Befehl `service_ransom_status`: eigene Köderdateien des Ransomware-Schutzes anzeigen. Nur lesend.                                                                                             |
| `allow-service-propose-baits`                | App-Befehl `service_propose_baits`: Köderdateien anlegen/entfernen vorschlagen – angelegt bzw. gelöscht wird nur nach „Ja“.                                                                       |
| `allow-service-memory-scan`                  | App-Befehl `service_memory_scan`: eigene laufende Programme, Module und nachgeladenen Code prüfen. Nur lesend.                                                                                    |
| `allow-service-panic-status`                 | App-Befehl `service_panic_status`: Zustand des Panic-Buttons (Netz getrennt seit …). Nur lesend.                                                                                                  |
| `allow-service-propose-panic`                | App-Befehl `service_propose_panic`: Netz trennen bzw. wieder verbinden vorschlagen – geändert wird die Firewall nur nach „Ja“.                                                                    |
| `allow-service-safe-status`                  | App-Befehl `service_safe_status`: Zustand des eigenen Datei-Safes und – nur wenn entsperrt – seine Einträge. Nur lesend.                                                                          |
| `allow-service-propose-safe-setup`           | App-Befehl `service_propose_safe_setup`: Datei-Safe anlegen vorschlagen. Das Passwort geht nur an den Dienst (nie gespeichert); angelegt wird nur nach „Ja“.                                      |
| `allow-service-safe-unlock`                  | App-Befehl `service_safe_unlock`: Datei-Safe mit dem Passwort entsperren. Der Schlüssel bleibt nur im Speicher des Dienstes (10 min ohne Nutzung). Verändert nichts.                              |
| `allow-service-safe-lock`                    | App-Befehl `service_safe_lock`: Datei-Safe sperren (Schlüssel im Dienst verwerfen).                                                                                                               |
| `allow-service-propose-safe-store`           | App-Befehl `service_propose_safe_store`: Dateien in den Datei-Safe legen vorschlagen – verschoben wird nur nach „Ja“.                                                                             |
| `allow-service-propose-safe-retrieve`        | App-Befehl `service_propose_safe_retrieve`: Eintrag aus dem Datei-Safe holen vorschlagen – angelegt wird nur nach „Ja“, nie überschrieben.                                                        |
| `allow-lab-capture-windows`                  | App-Befehl `lab_capture_windows`: Fensterfotos eines laufenden eigenen Mini-Sandbox-Laufs (Prozess-IDs nennt der Dienst). Nur lesend.                                                             |
| `allow-export-report`                        | App-Befehl `export_report`: Verlauf als HTML-Bericht speichern. Inhalt erzeugt Rust (maskiert, ohne Skripte); den Ort wählt der Nutzer im Speichern-Dialog – die Oberfläche gibt keinen Pfad vor. |
| `dialog:allow-open`                          | Datei- bzw. Ordnerauswahl für Scans („Datei wählen…“). Nur Auswahl; die App liest/schreibt dabei nichts. `save`, `message`, `ask` usw. bleiben gesperrt.                                          |

Dieselbe Liste steht als `JUSTIFIED_PERMISSIONS` in `tests/tauri-config.test.ts` und als
`EXPECTED_PERMISSIONS` in `src-tauri/src/main.rs` (Rust-Test, prüft auch diese Tabelle).

Bewusst **nicht** gewährt: `core:window:allow-hide` (direkt verstecken – ohne Symbol im
Infobereich liefe AEGIS dann unsichtbar weiter, ohne Rückweg; das prüft Rust in `hide_to_tray`),
`core:window:allow-show`/`allow-set-focus`/`allow-unminimize`
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
| `getCurrentWindow().close()`                                    | `plugin:window\|close`                    | `core:window:allow-close`                    |
| `getCurrentWindow().onResized()`, `.listen('aegis://navigate')` | `plugin:event\|listen`                    | `core:event:allow-listen`                    |
| Abmelden (Rückgabe von `onResized`/`listen`)                    | `plugin:event\|unlisten`                  | `core:event:allow-unlisten`                  |
| `invoke('app_info')`                                            | `app_info`                                | `allow-app-info`                             |
| `invoke('hide_to_tray')`                                        | `hide_to_tray`                            | `allow-hide-to-tray`                         |
| `invoke('service_scan')`                                        | `service_scan`                            | `allow-service-scan`                         |
| `invoke('service_list_quarantine')`                             | `service_list_quarantine`                 | `allow-service-list-quarantine`              |
| `invoke('service_propose_quarantine')`                          | `service_propose_quarantine`              | `allow-service-propose-quarantine`           |
| `invoke('service_propose_restore')`                             | `service_propose_restore`                 | `allow-service-propose-restore`              |
| `invoke('service_propose_delete')`                              | `service_propose_delete`                  | `allow-service-propose-delete`               |
| `invoke('service_decide')`                                      | `service_decide`                          | `allow-service-decide`                       |
| `invoke('service_confirm_second')`                              | `service_confirm_second`                  | `allow-service-confirm-second`               |
| `invoke('service_list_trust')`                                  | `service_list_trust`                      | `allow-service-list-trust`                   |
| `invoke('service_revoke_trust')`                                | `service_revoke_trust`                    | `allow-service-revoke-trust`                 |
| `invoke('service_watch_poll')`                                  | `service_watch_poll`                      | `allow-service-watch-poll`                   |
| `invoke('service_set_gaming')`                                  | `service_set_gaming`                      | `allow-service-set-gaming`                   |
| `invoke('service_history')`                                     | `service_history`                         | `allow-service-history`                      |
| `invoke('service_get_schedule')`                                | `service_get_schedule`                    | `allow-service-get-schedule`                 |
| `invoke('service_set_schedule')`                                | `service_set_schedule`                    | `allow-service-set-schedule`                 |
| `invoke('service_set_clamav_update')`                           | `service_set_clamav_update`               | `allow-service-set-clamav-update`            |
| `invoke('service_lab_status')`                                  | `service_lab_status`                      | `allow-service-lab-status`                   |
| `invoke('service_propose_lab_run')`                             | `service_propose_lab_run`                 | `allow-service-propose-lab-run`              |
| `invoke('service_lab_screenshot')`                              | `service_lab_screenshot`                  | `allow-service-lab-screenshot`               |
| `invoke('service_lab_report')`                                  | `service_lab_report`                      | `allow-service-lab-report`                   |
| `invoke('service_propose_enable_sandbox')`                      | `service_propose_enable_sandbox`          | `allow-service-propose-enable-sandbox`       |
| `invoke('service_propose_process_action')`                      | `service_propose_process_action`          | `allow-service-propose-process-action`       |
| `invoke('service_ransom_status')`                               | `service_ransom_status`                   | `allow-service-ransom-status`                |
| `invoke('service_propose_baits')`                               | `service_propose_baits`                   | `allow-service-propose-baits`                |
| `invoke('service_memory_scan')`                                 | `service_memory_scan`                     | `allow-service-memory-scan`                  |
| `invoke('service_panic_status')`                                | `service_panic_status`                    | `allow-service-panic-status`                 |
| `invoke('service_propose_panic')`                               | `service_propose_panic`                   | `allow-service-propose-panic`                |
| `invoke('service_safe_status')`                                 | `service_safe_status`                     | `allow-service-safe-status`                  |
| `invoke('service_propose_safe_setup')`                          | `service_propose_safe_setup`              | `allow-service-propose-safe-setup`           |
| `invoke('service_safe_unlock')`                                 | `service_safe_unlock`                     | `allow-service-safe-unlock`                  |
| `invoke('service_safe_lock')`                                   | `service_safe_lock`                       | `allow-service-safe-lock`                    |
| `invoke('service_propose_safe_store')`                          | `service_propose_safe_store`              | `allow-service-propose-safe-store`           |
| `invoke('service_propose_safe_retrieve')`                       | `service_propose_safe_retrieve`           | `allow-service-propose-safe-retrieve`        |
| `invoke('lab_capture_windows')`                                 | `lab_capture_windows`                     | `allow-lab-capture-windows`                  |
| `invoke('export_report')`                                       | `export_report`                           | `allow-export-report`                        |
| `open()` aus `@tauri-apps/plugin-dialog`                        | `plugin:dialog\|open`                     | `dialog:allow-open`                          |

**App-Befehle nur mit Recht.** `src-tauri/build.rs` meldet die App-Befehle über
`tauri_build::AppManifest::commands` an. Damit gibt es ein ACL-Manifest der App, und Tauri lässt
App-Befehle nur noch mit ausdrücklicher Berechtigung zu (`allow-app-info`, `allow-hide-to-tray`, `allow-service-*`)
– ohne dieses Manifest stünde jeder App-Befehl jedem lokalen Fenster offen. Die
Berechtigungsdateien `src-tauri/permissions/autogenerated/*.toml` erzeugt das Build-Skript.

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

**Schließen.** Die Oberfläche entscheidet, Rust versteckt: Mit „Beim Schließen in den
Infobereich“ (Standard: an) ruft sie den App-Befehl `hide_to_tray` auf, sonst `close()`.
`hide_to_tray` versteckt das Fenster nur, wenn es ein Symbol im Infobereich gibt
(`window::close_to_tray_available`), und meldet sonst `noTray` – dann beendet die Oberfläche
AEGIS mit `close()`. Ob es das Symbol gibt, meldet `app_info` (`trayAvailable`); nur dann heißt
der Knopf „Schließen – AEGIS läuft im Infobereich weiter“, sonst „AEGIS beenden“, und die
Einstellung ist gesperrt und erklärt, warum. Unter Linux verspricht AEGIS den Infobereich nie:
Ob dort überhaupt ein Infobereich das Symbol anzeigt, lässt sich nicht feststellen (GNOME hat
ohne Erweiterung keinen; das Anlegen gelingt trotzdem). Grenze unter Windows: `tray-icon` meldet
ein gescheitertes `Shell_NotifyIcon` nicht – das Symbol erscheint aber, sobald Explorer (wieder)
läuft, und ein zweiter Start holt das Fenster immer zurück. Jede Schließ-Anforderung des
Hauptfensters beendet in Rust die ganze App (`src-tauri/src/window.rs`) – auch das Tray-Symbol
hält dann keinen unsichtbaren Prozess am Leben. Das gilt ebenso für Alt+F4 und „Fenster
schließen“ in der Taskleiste: Diese Wege laufen an der Oberfläche vorbei und beenden AEGIS immer.

**Infobereich (Tray).** Symbol = App-Symbol, Tooltip „AEGIS Suite“, Menü „AEGIS öffnen“,
„Dashboard“, „Einstellungen“, Trenner, „Beenden“. Linksklick auf das Symbol zeigt das Fenster
(zeigen, wiederherstellen, fokussieren). „Dashboard“/„Einstellungen“ senden erst
`aegis://navigate` und zeigen dann das Fenster. Das Menü verändert nichts am System. Unter
Linux braucht das Symbol `libayatana-appindicator3` (Tauri-Voraussetzung; fehlt die Bibliothek,
bricht der Start mit einer Meldung im Startprotokoll ab); Klicks auf das Symbol meldet Linux
nicht, dort gibt es nur das Menü. Meldet das System beim Anlegen einen Fehler, startet AEGIS
ohne Tray-Symbol, vermerkt das im Startprotokoll und versteckt das Fenster beim Schließen
nicht (siehe „Schließen“).

**Nur eine Instanz** (`tauri-plugin-single-instance`). Ein zweiter Start holt das vorhandene
Fenster nach vorn (zeigen, wiederherstellen, fokussieren) und endet sofort; seine Argumente und
sein Arbeitsordner werden ignoriert. So bleibt ein in den Infobereich verstecktes Fenster auch
ohne Tray-Symbol erreichbar.

**Startfehler.** Kann AEGIS nicht starten (Fehler aus `Builder::build` oder eine Panic beim
Anlegen des Fensters, etwa ohne WebView2-Laufzeit), schreibt die App eine Zeile nach
`%LOCALAPPDATA%\AEGIS\logs\startup.log` (Linux: `$XDG_STATE_HOME/aegis/logs/startup.log`,
sonst `~/.local/state/aegis/logs/startup.log`), zeigt unter Windows ein natives
Meldungsfenster (deutsch, dann englisch; über `rfd`, ohne eigenes `unsafe`) und gibt die
Meldung auf stderr aus. Die Datei gehört AEGIS: nur anhängen, nie kürzen oder löschen, ab
1 MiB nichts mehr (die beiden Schreibstellen stehen in `crates/core/mutation-allowlist.txt`).
**Keine Links:** Unter dem Ordner des Nutzers (`LOCALAPPDATA`, `XDG_STATE_HOME`) legt AEGIS
seine Ordner (`AEGIS\logs`, `aegis/logs`) einzeln an; ist einer davon ein Link, eine
Abzweigung (Junction) oder ein anderer Analysepunkt, wird nichts geschrieben. Die Datei wird
ohne Folgen eines Links geöffnet (`O_NOFOLLOW` bzw. `FILE_FLAG_OPEN_REPARSE_POINT`) und erst
nach Prüfung des geöffneten Handles beschrieben (normale Datei, kein Analysepunkt; unter Unix
genau ein Name und dieselbe Datei wie unter dem Pfad). `LOCALAPPDATA` als Netz- oder
Gerätepfad (`\\server\…`, `\\?\…`) wird abgelehnt, und unter Windows legt AEGIS diesen Ordner
nie selbst an. Grenzen: Gegen ein Programm mit demselben Konto, das die Ordner _während_ des
Schreibens austauscht, oder gegen Hardlinks unter Windows hülfe nur eigener Windows-FFI-Code
(handle-relatives Öffnen, Zahl der Links); die App läuft bestimmungsgemäß nicht erhöht.
Fehlermeldungen werden vor dem Schreiben zu einer Zeile: Steuerzeichen, Zeilen- und
Absatztrenner (U+2028/U+2029) werden Leerzeichen, unsichtbare Format- und Bidi-Zeichen
(z. B. U+202E) erscheinen als Marke `⟨U+202E⟩` – auch im Meldungsfenster.

## IPC-Vertrag (für die Oberfläche)

| Art                  | Name                 | Daten                                                                                                                                                                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Befehl               | `app_info`           | → `{ "version": string, "buildProfile": "debug" \| "release", "os": "windows" \| "linux" \| "macos" \| string, "osVersion": string \| null, "arch": string, "tauriVersion": string, "trayAvailable": boolean }` |
| Befehl               | `hide_to_tray`       | → `"hidden"` (Fenster versteckt) \| `"noTray"` (kein Symbol im Infobereich – nichts versteckt)                                                                                                                  |
| Ereignis (Rust → UI) | `aegis://navigate`   | `{ "page": "dashboard" \| "settings" }`                                                                                                                                                                         |
| Fenster-API          | `getCurrentWindow()` | `minimize()`, `toggleMaximize()`, `isMaximized()`, `onResized()`, `close()`, `listen()` (nur `aegis://navigate`) und `data-tauri-drag-region` (Ziehen, Doppelklick) – sonst nichts                              |

`osVersion`: Windows `10.0.<Build>.<UBR>` (Windows 11 meldet ebenfalls 10.0, Build ≥ 22000),
Linux `PRETTY_NAME` aus `os-release`, sonst `null`. Die Werte werden einmal beim Start erhoben.

## Tests

- `pnpm test` – Vitest: `src/**/*.test.ts(x)` (App) und `tests/*.test.ts` (Konfiguration,
  IPC-Vertrag Oberfläche ↔ Rust in `tests/ipc-contract.test.ts`, CI-Workflows unter
  `.github/workflows`, tsconfig).
- `pnpm test:e2e` – Playwright gegen `vite preview` mit derselben CSP und eingefrorenem
  `Object.prototype` wie im Tauri-Fenster.
- `cargo test -p aegis-desktop` – Rust-Tests (Navigations-Wächter, Rechte-Liste, IPC-Rechte zur
  Laufzeit mit der echten ACL, Tray-Menü → Aktion und Tray-Aktionen mit Tauris Test-Laufzeit,
  `hide_to_tray` ohne Symbol, Form von `app_info`, Schließen des Hauptfensters beendet die App,
  Fenster-Konfiguration und -Hintergrund, Pfad/Zeile/Meldung des Startprotokolls samt
  Link-Abwehr, einmaliger Meldung und Ende der Startphase).
- `pnpm typecheck` – `tsconfig.app.json` (WebView-Code, nur Browser-Typen) und
  `tsconfig.node.json` (Tests, e2e, Vite-/Playwright-Konfiguration, mit Node-Typen).
