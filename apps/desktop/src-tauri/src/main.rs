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
        .invoke_handler(tauri::generate_handler![app_info::app_info])
        .on_window_event(window::on_window_event)
        .setup(move |app| {
            // Zuerst, vor dem ersten Zeichnen: kein dunkles Aufblitzen bei hellem System.
            window::match_system_background(app.handle());
            app.manage(app_info::AppInfo::detect(
                app.package_info().version.to_string(),
            ));
            // Ohne Tray läuft AEGIS weiter; ein zweiter Start holt das Fenster dann zurück,
            // falls die Oberfläche es versteckt hat.
            if let Err(error) = tray::create(app.handle()) {
                startup_error::log_notice(
                    &setup_version,
                    &format!("Symbol im Infobereich nicht verfügbar: {error}"),
                );
            }
            Ok(())
        })
        .build(context);

    match built {
        Ok(app) => app.run(|_app, event| {
            if let RunEvent::Ready = event {
                // Setup und Fenster stehen: ab hier ist eine Panic kein Startfehler mehr.
                startup_error::startup_finished();
            }
        }),
        Err(error) => {
            startup_error::report_failure(&version, &error.to_string());
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    /// Die IPC-Rechte des Hauptfensters – genau diese, je einzeln begründet in
    /// `apps/desktop/README.md`. Eine Änderung hier ist eine bewusste Sicherheitsentscheidung.
    /// `show`/`set_focus` fehlen bewusst: Das Fenster holt nur Rust nach vorn (Tray, zweiter
    /// Start); die Oberfläche ruft sie nie auf.
    const EXPECTED_PERMISSIONS: [&str; 10] = [
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-is-maximized",
        "core:window:allow-start-dragging",
        "core:window:allow-hide",
        "core:window:allow-close",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "allow-app-info",
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

    /// Laufzeit-Prüfung der Rechte mit Tauris Test-Laufzeit und der echten, beim Build
    /// aufgelösten ACL (Capability + App-Manifest aus `build.rs`).
    mod ipc {
        use serde_json::{Value, json};
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
        use tauri::webview::InvokeRequest;
        use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

        use crate::app_info::AppInfo;
        use crate::window::MAIN_WINDOW_LABEL;

        fn app() -> App<MockRuntime> {
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![crate::app_info::app_info])
                .build(tauri::generate_context!(test = true))
                .unwrap();
            app.manage(AppInfo::new("0.1.0", None));
            app
        }

        fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
            WebviewWindowBuilder::new(app, label, WebviewUrl::default())
                .build()
                .unwrap()
        }

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
                ("plugin:window|hide", json!({})),
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
