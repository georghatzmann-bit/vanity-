//! AEGIS Suite – Desktop-App.
// Unter Windows kein zusätzliches Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_info;
mod navigation;
mod report;
mod service;
mod startup_error;
mod tray;
mod window;
mod winsec;

use navigation::NavigationPolicy;
use tauri::{Manager, RunEvent};

fn main() {
    let context = tauri::generate_context!();
    let version = context.package_info().version.to_string();
    let config = context.config();
    let use_https_scheme = config
        .app
        .windows
        .iter()
        .any(|window| window.use_https_scheme);
    // Den Vite-Server nur im Entwicklungs-Build zulassen (`cfg(dev)` setzt tauri-build, solange
    // `tauri build` nicht das Feature `custom-protocol` einschaltet).
    let dev_url = if cfg!(dev) {
        config.build.dev_url.clone()
    } else {
        None
    };
    let policy = NavigationPolicy::new(use_https_scheme, dev_url.as_ref());

    // Fehler beim Anlegen des Fensters meldet Tauri als Panic im Setup – auch die sollen
    // sichtbar werden (Protokoll + Meldungsfenster), nicht nur Fehler aus `build`.
    startup_error::watch_startup_panics(version.clone());

    let setup_version = version.clone();
    let built = tauri::Builder::default()
        // Zuerst: Ein zweiter Start gibt hier an die laufende Instanz ab und endet sofort.
        // Dessen Argumente und Arbeitsordner werden bewusst ignoriert – nur das Fenster kommt
        // nach vorn.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::reveal_main(app);
        }))
        .plugin(navigation::guard(policy))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info::app_info,
            window::hide_to_tray,
            service::service_scan,
            service::service_list_quarantine,
            service::service_propose_quarantine,
            service::service_propose_restore,
            service::service_propose_delete,
            service::service_decide,
            service::service_confirm_second,
            service::service_list_trust,
            service::service_revoke_trust,
            service::service_watch_poll,
            service::service_set_gaming,
            service::service_history,
            service::service_get_schedule,
            service::service_set_schedule,
            service::service_set_clamav_update,
            service::service_lab_status,
            service::service_propose_lab_run,
            service::service_lab_screenshot,
            service::service_lab_report,
            service::service_propose_enable_sandbox,
            service::service_propose_process_action,
            service::service_ransom_status,
            service::service_propose_baits,
            service::service_set_protected_folders,
            service::service_backup_status,
            service::service_propose_backup,
            service::service_propose_backup_restore,
            service::service_propose_backup_export,
            service::service_propose_backup_prune,
            winsec::open_windows_security,
            service::service_memory_scan,
            service::service_emergency_scan,
            service::service_propose_restore_many,
            service::service_panic_status,
            service::service_propose_panic,
            service::service_safe_status,
            service::service_propose_safe_setup,
            service::service_safe_unlock,
            service::service_safe_lock,
            service::service_propose_safe_store,
            service::service_propose_safe_retrieve,
            service::lab_capture_windows,
            report::export_report
        ])
        .on_window_event(window::on_window_event)
        .setup(move |app| {
            // Zuerst, vor dem ersten Zeichnen: kein dunkles Aufblitzen bei hellem System.
            window::match_system_background(app.handle());
            // Ohne Tray läuft AEGIS weiter, verspricht aber kein Weiterlaufen im Infobereich:
            // „Schließen“ versteckt das Fenster dann nicht (`hide_to_tray`), sondern beendet.
            if let Err(error) = tray::create(app.handle()) {
                startup_error::log_notice(
                    &setup_version,
                    &format!("Symbol im Infobereich nicht verfügbar: {error}"),
                );
            }
            let tray_available =
                window::close_to_tray_available(app.tray_by_id(tray::TRAY_ID).is_some());
            app.manage(app_info::AppInfo::detect(
                app.package_info().version.to_string(),
                tray_available,
            ));
            Ok(())
        })
        .build(context);

    match built {
        Ok(app) => app.run(|_app, event| on_run_event(&event)),
        Err(error) => {
            startup_error::report_failure(&version, &error.to_string());
            std::process::exit(1);
        }
    }
}

/// Ereignisse der laufenden App: Sobald sie bereit ist (Setup und Fenster stehen), ist eine
/// Panic kein Startfehler mehr.
fn on_run_event(event: &RunEvent) {
    if let RunEvent::Ready = event {
        startup_error::startup_finished();
    }
}

/// Test-Hilfen: die App mit Tauris Test-Laufzeit, denselben Befehlen und der echten ACL.
#[cfg(test)]
mod test_support {
    use tauri::test::{MockRuntime, mock_builder};
    use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    use crate::app_info::AppInfo;

    /// App wie in `main` (App-Befehle, `AppInfo`), aber ohne Fenster, Tray und Plugins.
    pub fn app() -> App<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                crate::app_info::app_info,
                crate::window::hide_to_tray,
                crate::service::service_scan,
                crate::service::service_list_quarantine,
                crate::service::service_propose_quarantine,
                crate::service::service_propose_restore,
                crate::service::service_propose_delete,
                crate::service::service_decide,
                crate::service::service_confirm_second,
                crate::service::service_list_trust,
                crate::service::service_revoke_trust,
                crate::service::service_watch_poll,
                crate::service::service_set_gaming,
                crate::service::service_history,
                crate::service::service_get_schedule,
                crate::service::service_set_schedule,
                crate::service::service_set_clamav_update,
                crate::service::service_lab_status,
                crate::service::service_propose_lab_run,
                crate::service::service_lab_screenshot,
                crate::service::service_lab_report,
                crate::service::service_propose_enable_sandbox,
                crate::service::service_propose_process_action,
                crate::service::service_ransom_status,
                crate::service::service_propose_baits,
                crate::service::service_set_protected_folders,
                crate::service::service_backup_status,
                crate::service::service_propose_backup,
                crate::service::service_propose_backup_restore,
                crate::service::service_propose_backup_export,
                crate::service::service_propose_backup_prune,
                crate::winsec::open_windows_security,
                crate::service::service_memory_scan,
                crate::service::service_emergency_scan,
                crate::service::service_propose_restore_many,
                crate::service::service_panic_status,
                crate::service::service_propose_panic,
                crate::service::service_safe_status,
                crate::service::service_propose_safe_setup,
                crate::service::service_safe_unlock,
                crate::service::service_safe_lock,
                crate::service::service_propose_safe_store,
                crate::service::service_propose_safe_retrieve,
                crate::service::lab_capture_windows,
                crate::report::export_report
            ])
            .build(tauri::generate_context!(test = true))
            .unwrap();
        app.manage(AppInfo::new("0.1.0", None, false));
        app
    }

    pub fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::default())
            .build()
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    /// Die IPC-Rechte des Hauptfensters – genau diese, je einzeln begründet in
    /// `apps/desktop/README.md`. Eine Änderung hier ist eine bewusste Sicherheitsentscheidung.
    /// `show`/`set_focus` fehlen bewusst: Das Fenster holt nur Rust nach vorn (Tray, zweiter
    /// Start); die Oberfläche ruft sie nie auf.
    /// `hide` fehlt ebenfalls: Verstecken entscheidet Rust (`allow-hide-to-tray`), damit ohne
    /// Symbol im Infobereich kein unsichtbarer Prozess entsteht.
    const EXPECTED_PERMISSIONS: [&str; 54] = [
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-is-maximized",
        "core:window:allow-start-dragging",
        "core:window:allow-close",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "allow-app-info",
        "allow-hide-to-tray",
        "allow-service-scan",
        "allow-service-list-quarantine",
        "allow-service-propose-quarantine",
        "allow-service-propose-restore",
        "allow-service-propose-delete",
        "allow-service-decide",
        "allow-service-confirm-second",
        "allow-service-list-trust",
        "allow-service-revoke-trust",
        "allow-service-watch-poll",
        "allow-service-set-gaming",
        "allow-service-history",
        "allow-service-get-schedule",
        "allow-service-set-schedule",
        "allow-service-set-clamav-update",
        "allow-service-lab-status",
        "allow-service-propose-lab-run",
        "allow-service-lab-screenshot",
        "allow-service-lab-report",
        "allow-service-propose-enable-sandbox",
        "allow-service-propose-process-action",
        "allow-service-ransom-status",
        "allow-service-propose-baits",
        "allow-service-set-protected-folders",
        "allow-service-backup-status",
        "allow-service-propose-backup",
        "allow-service-propose-backup-restore",
        "allow-service-propose-backup-export",
        "allow-service-propose-backup-prune",
        "allow-open-windows-security",
        "allow-service-memory-scan",
        "allow-service-emergency-scan",
        "allow-service-propose-restore-many",
        "allow-service-panic-status",
        "allow-service-propose-panic",
        "allow-service-safe-status",
        "allow-service-propose-safe-setup",
        "allow-service-safe-unlock",
        "allow-service-safe-lock",
        "allow-service-propose-safe-store",
        "allow-service-propose-safe-retrieve",
        "allow-lab-capture-windows",
        "allow-export-report",
        "dialog:allow-open",
    ];

    fn capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap()
    }

    #[test]
    fn hauptfenster_hat_genau_die_begruendeten_rechte() {
        let permissions: Vec<String> = capability()["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(permissions, EXPECTED_PERMISSIONS);
    }

    #[test]
    fn keine_buendel_keine_fernzugriffe_keine_veraendernden_rechte() {
        let cap = capability();
        assert!(
            cap.get("remote").is_none(),
            "keine IPC für entfernte Seiten"
        );
        assert!(cap.get("webviews").is_none());
        for id in EXPECTED_PERMISSIONS {
            assert!(!id.ends_with(":default") && id != "default", "{id}: Bündel");
            for forbidden in [
                "emit",
                "create",
                "destroy",
                "fs:",
                "shell:",
                "process:",
                "app:allow-exit",
                "webview:",
                "menu:",
                "tray:",
                "path:",
            ] {
                assert!(!id.contains(forbidden), "{id} enthält „{forbidden}“");
            }
        }
    }

    #[test]
    fn readme_begruendet_jedes_recht() {
        // Zeilen der Begründungstabelle: | `<recht>` | <Begründung> |
        let justified: Vec<(String, String)> = include_str!("../../README.md")
            .lines()
            .filter_map(|line| {
                let cells: Vec<&str> = line.trim().strip_prefix('|')?.split('|').collect();
                let id = cells.first()?.trim().strip_prefix('`')?.strip_suffix('`')?;
                let reason = cells.get(1)?.trim();
                Some((id.to_owned(), reason.to_owned()))
            })
            .filter(|(id, _)| id.contains("allow-"))
            .collect();
        let ids: Vec<&str> = justified.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids, EXPECTED_PERMISSIONS,
            "Tabelle = Capability, gleiche Reihenfolge"
        );
        for (id, reason) in &justified {
            assert!(reason.chars().count() >= 20, "{id}: Begründung zu kurz");
        }
    }

    #[test]
    fn startphase_endet_erst_wenn_die_app_bereit_ist() {
        // Ohne diesen Schritt bliebe jede spätere Panic ein „Startfehler“ (Meldungsfenster).
        crate::startup_error::begin_startup_without_hook();
        crate::on_run_event(&tauri::RunEvent::MainEventsCleared);
        assert!(crate::startup_error::is_starting());
        crate::on_run_event(&tauri::RunEvent::Ready);
        assert!(!crate::startup_error::is_starting());
    }

    #[test]
    fn main_registriert_die_fenster_ereignisse() {
        // `on_window_event` beendet die App beim Schließen des Hauptfensters (window.rs).
        let main = include_str!("main.rs");
        let production = &main[..main.find("#[cfg(test)]").unwrap()];
        assert!(production.contains(".on_window_event(window::on_window_event)"));
        assert!(production.contains("app.run(|_app, event| on_run_event(&event))"));
    }

    /// Laufzeit-Prüfung der Rechte mit Tauris Test-Laufzeit und der echten, beim Build
    /// aufgelösten ACL (Capability + App-Manifest aus `build.rs`).
    mod ipc {
        use serde_json::{Value, json};
        use tauri::WebviewWindow;
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response};
        use tauri::webview::InvokeRequest;

        use crate::test_support::{app, window};
        use crate::window::MAIN_WINDOW_LABEL;

        /// Abgelehnt von der ACL (nicht etwa wegen falscher Argumente).
        fn assert_denied(response: Result<Value, Value>, cmd: &str) {
            let error = response.expect_err(cmd).to_string();
            assert!(
                error.contains("not allowed"),
                "{cmd}: keine ACL-Ablehnung, sondern {error}"
            );
        }

        fn invoke(
            window: &WebviewWindow<MockRuntime>,
            cmd: &str,
            args: Value,
        ) -> Result<Value, Value> {
            let url = if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            };
            get_ipc_response(
                window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: InvokeBody::Json(args),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_owned(),
                },
            )
            .map(|body| body.deserialize::<Value>().unwrap())
        }

        #[test]
        fn app_info_ist_im_hauptfenster_erlaubt() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            let info = invoke(&main, "app_info", json!({})).unwrap();
            assert_eq!(info["version"], "0.1.0");
            assert!(info["osVersion"].is_null());
            assert_eq!(info["os"], std::env::consts::OS);
        }

        #[test]
        fn app_befehle_brauchen_eine_capability() {
            // Ohne App-Manifest in build.rs liefe app_info in jedem lokalen Fenster.
            let app = app();
            let other = window(&app, "fremd");
            assert_denied(invoke(&other, "app_info", json!({})), "app_info");
        }

        /// Ohne Symbol im Infobereich versteckt `hide_to_tray` nichts – sonst liefe AEGIS
        /// unsichtbar weiter, ohne Rückweg.
        #[test]
        fn hide_to_tray_ohne_symbol_versteckt_nichts() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            assert!(app.tray_by_id(crate::tray::TRAY_ID).is_none());
            assert_eq!(
                invoke(&main, "hide_to_tray", json!({})).unwrap(),
                json!("noTray")
            );
            let other = window(&app, "fremd");
            assert_denied(invoke(&other, "hide_to_tray", json!({})), "hide_to_tray");
        }

        #[test]
        fn app_info_meldet_ob_es_einen_infobereich_gibt() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            assert_eq!(
                invoke(&main, "app_info", json!({})).unwrap()["trayAvailable"],
                json!(false)
            );
        }

        #[test]
        fn gewaehrte_fensterbefehle_laufen() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            assert_eq!(
                invoke(&main, "plugin:window|is_maximized", json!({})).unwrap(),
                json!(false)
            );
        }

        /// Jeder Aufruf der Oberfläche (`src/platform/platform.ts`, Zieh-Skript von Tauri für
        /// `data-tauri-drag-region`) kommt durch die ACL – sonst bliebe ein Fensterknopf stumm.
        #[test]
        fn jeder_aufruf_der_oberflaeche_ist_gewaehrt() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            for (cmd, args) in [
                ("plugin:window|minimize", json!({})),
                ("plugin:window|toggle_maximize", json!({})),
                ("plugin:window|internal_toggle_maximize", json!({})),
                ("plugin:window|is_maximized", json!({})),
                ("plugin:window|start_dragging", json!({})),
                ("hide_to_tray", json!({})),
                (
                    "plugin:event|listen",
                    json!({
                        "event": "aegis://navigate",
                        "target": { "kind": "Window", "label": MAIN_WINDOW_LABEL },
                        "handler": 7
                    }),
                ),
                (
                    "plugin:event|unlisten",
                    json!({ "event": "aegis://navigate", "eventId": 0 }),
                ),
                ("app_info", json!({})),
                // Dienst-Befehle: Ohne laufenden Dienst endet jeder Aufruf mit „nicht
                // erreichbar“ – hier zählt nur, dass die ACL sie durchlässt.
                (
                    "service_scan",
                    json!({ "paths": ["/aegis-test/gibt-es-nicht"] }),
                ),
                ("service_list_quarantine", json!({})),
                (
                    "service_propose_quarantine",
                    json!({ "paths": ["/aegis-test/gibt-es-nicht"] }),
                ),
                (
                    "service_propose_restore",
                    json!({ "entryId": "00000000-0000-4000-8000-000000000000" }),
                ),
                (
                    "service_propose_delete",
                    json!({ "entryId": "00000000-0000-4000-8000-000000000000" }),
                ),
                (
                    "service_decide",
                    json!({ "planId": "p", "digest": "d", "nonce": "n", "decision": "decline", "dialogId": "x" }),
                ),
                (
                    "service_confirm_second",
                    json!({ "challengeId": "c", "nonce": "n", "decision": "decline", "dialogId": "x" }),
                ),
                ("service_list_trust", json!({})),
                (
                    "service_revoke_trust",
                    json!({ "id": "00000000-0000-4000-8000-000000000000" }),
                ),
                ("service_watch_poll", json!({ "after": 0 })),
                ("service_set_gaming", json!({ "on": false })),
                ("service_history", json!({})),
                ("service_get_schedule", json!({})),
                (
                    "service_set_schedule",
                    json!({ "enabled": false, "everyDays": 7, "hourUtc": 9 }),
                ),
                ("service_set_clamav_update", json!({ "on": true })),
                ("service_lab_status", json!({})),
                (
                    "service_propose_lab_run",
                    json!({ "path": "/aegis-test/gibt-es-nicht", "stage": "mini_sandbox", "seconds": 30, "network": false }),
                ),
                (
                    "service_lab_screenshot",
                    json!({ "runId": "r", "name": "bild-01.png" }),
                ),
                ("service_lab_report", json!({ "runId": "r" })),
                ("service_propose_enable_sandbox", json!({})),
                ("service_ransom_status", json!({})),
                ("service_propose_baits", json!({ "on": false })),
                ("service_set_protected_folders", json!({ "folders": [] })),
                ("service_backup_status", json!({})),
                (
                    "service_propose_backup",
                    json!({ "on": false, "quotaMb": 0 }),
                ),
                ("service_propose_backup_restore", json!({ "id": "x" })),
                (
                    "service_propose_backup_export",
                    json!({ "folder": "/aegis-test/gibt-es-nicht" }),
                ),
                ("service_propose_backup_prune", json!({ "days": 30 })),
                ("open_windows_security", json!({})),
                ("service_memory_scan", json!({})),
                ("service_emergency_scan", json!({})),
                ("service_propose_restore_many", json!({ "entryIds": ["x"] })),
                ("service_panic_status", json!({})),
                ("service_propose_panic", json!({ "on": false })),
                ("service_safe_status", json!({})),
                ("service_propose_safe_setup", json!({ "password": "x" })),
                ("service_safe_unlock", json!({ "password": "x" })),
                ("service_safe_lock", json!({})),
                (
                    "service_propose_safe_store",
                    json!({ "paths": ["/aegis-test/gibt-es-nicht"] }),
                ),
                ("service_propose_safe_retrieve", json!({ "id": "x" })),
                (
                    "service_propose_process_action",
                    json!({ "program": "/aegis-test/x", "action": "suspend" }),
                ),
                ("lab_capture_windows", json!({ "runId": "r" })),
                ("export_report", json!({ "english": false })),
                // Zuletzt: schließt das Testfenster.
                ("plugin:window|close", json!({})),
            ] {
                if let Err(error) = invoke(&main, cmd, args) {
                    assert!(
                        !error.to_string().contains("not allowed"),
                        "{cmd}: von der ACL abgelehnt: {error}"
                    );
                }
            }
        }

        #[test]
        fn nicht_gewaehrte_befehle_werden_abgelehnt() {
            let app = app();
            let main = window(&app, MAIN_WINDOW_LABEL);
            for (cmd, args) in [
                (
                    "plugin:window|set_size",
                    json!({ "value": { "Logical": { "width": 1, "height": 1 } } }),
                ),
                ("plugin:window|set_always_on_top", json!({ "value": true })),
                // Nach vorn holen macht nur Rust (Tray, zweiter Start), nie die Oberfläche.
                ("plugin:window|show", json!({})),
                // Verstecken nur über `hide_to_tray` (prüft, ob es ein Tray-Symbol gibt).
                ("plugin:window|hide", json!({})),
                ("plugin:window|set_focus", json!({})),
                ("plugin:window|unminimize", json!({})),
                (
                    "plugin:window|start_resize_dragging",
                    json!({ "value": "East" }),
                ),
                ("plugin:window|destroy", json!({})),
                ("plugin:window|create", json!({})),
                ("plugin:webview|create_webview_window", json!({})),
                (
                    "plugin:event|emit",
                    json!({ "event": "x", "payload": null }),
                ),
                (
                    "plugin:event|emit_to",
                    json!({ "target": { "kind": "Any" }, "event": "x", "payload": null }),
                ),
                ("plugin:app|exit", json!({ "code": 0 })),
                ("plugin:path|resolve_directory", json!({ "directory": 1 })),
                ("plugin:menu|new", json!({})),
                ("plugin:tray|new", json!({})),
                ("unbekannter_befehl", json!({})),
            ] {
                assert_denied(invoke(&main, cmd, args), cmd);
            }
        }
    }
}
