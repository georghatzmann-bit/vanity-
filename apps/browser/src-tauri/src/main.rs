//! AEGIS Browser (P12): ein Fenster mit eigener Leiste („chrome“, React) und je Tab einem
//! WebView darunter. Webseiten bekommen keinerlei App-Rechte (die Capability gilt nur für die
//! Leiste). Navigation nur `http`/`https`, HTTPS-only mit Ausnahme je Sitzung, Pop-ups werden
//! zu Tabs, Werbe-/Tracker-Blocker (Windows, WebView2) auf Filterlisten, DNS-over-HTTPS,
//! Ghost-Fenster (InPrivate, optional über einen laufenden Tor-/Arti-SOCKS-Proxy).
//!
//! Ehrlich: Der Browser reduziert Tracking, er anonymisiert nicht – der offizielle Tor Browser
//! ist stärker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

mod browser;
mod store;

fn main() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let state = browser::Browser::load(app.handle())?;
            tauri::Manager::manage(app, state);
            browser::open_window(app.handle(), browser::WindowKind::Normal)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            browser::browser_state,
            browser::tab_open,
            browser::tab_close,
            browser::tab_select,
            browser::tab_go,
            browser::tab_back,
            browser::tab_forward,
            browser::tab_reload,
            browser::tab_allow_http,
            browser::content_visible,
            browser::settings_save,
            browser::lists_update,
            browser::bookmark_add,
            browser::bookmark_remove,
            browser::ghost_open,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("AEGIS Browser konnte nicht starten: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    /// Webseiten (Tabs) dürfen keine App-Befehle aufrufen: Die einzige Capability gilt nur für
    /// die Leisten-WebViews und erlaubt keine Kern-Bündel.
    #[test]
    fn rechte_nur_fuer_die_leiste() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap_or_default();
        assert_eq!(cap["webviews"], serde_json::json!(["chrome-*"]));
        assert!(cap.get("windows").is_none());
        assert!(cap.get("remote").is_none());
        let permissions = cap["permissions"].as_array().cloned().unwrap_or_default();
        assert!(!permissions.is_empty());
        for p in permissions {
            let p = p.as_str().unwrap_or_default();
            assert!(
                p.starts_with("allow-")
                    || p == "core:event:allow-listen"
                    || p == "core:event:allow-unlisten",
                "{p}"
            );
        }
    }
}
