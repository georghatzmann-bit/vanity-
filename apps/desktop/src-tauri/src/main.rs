//! AEGIS Suite – Desktop-App.
// Unter Windows kein zusätzliches Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_info;
mod navigation;
mod startup_error;
mod tray;
mod window;

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
        .invoke_handler(tauri::generate_handler![
            app_info::app_info,
            window::hide_to_tray
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
                crate::window::hide_to_tray
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
    const EXPECTED_PERMISSIONS: [&str; 10] = [
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
