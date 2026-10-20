//! AEGIS-Setup (P13): kleiner Installations-Assistent. Er lädt die signierten Angaben der
//! neuesten Version von GitHub, lädt nur die gewählten Pakete, prüft Signatur, Größe und
//! SHA-256 und startet die geprüften Installationsprogramme erst nach „Installieren“.
//! Ohne Telemetrie; verbunden wird nur mit GitHub (und auf Wunsch mit Microsoft für WebView2).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

mod navigation;
mod setup;
mod webview2;

fn main() {
    if !webview2::ready() {
        webview2::offer_download();
        return;
    }
    let context = tauri::generate_context!();
    let config = context.config();
    let use_https_scheme = config
        .app
        .windows
        .iter()
        .any(|window| window.use_https_scheme);
    // Vite-Server nur im Entwicklungs-Build.
    let dev_url = if cfg!(dev) {
        config.build.dev_url.clone()
    } else {
        None
    };
    let policy = navigation::NavigationPolicy::new(use_https_scheme, dev_url.as_ref());
    let result = tauri::Builder::default()
        .plugin(navigation::guard(policy))
        .invoke_handler(tauri::generate_handler![
            setup::setup_info,
            setup::setup_check,
            setup::setup_download,
            setup::setup_install,
            setup::setup_launch,
        ])
        .run(context);
    if let Err(error) = result {
        eprintln!("AEGIS-Setup konnte nicht starten: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    /// Das Setup-Fenster hat nur die eigenen Befehle und Ereignisse – keine Kern-Bündel,
    /// keine fremden Herkünfte.
    #[test]
    fn rechte_nur_eigene_befehle() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap_or_default();
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert!(cap.get("remote").is_none());
        let permissions = cap["permissions"].as_array().cloned().unwrap_or_default();
        assert!(!permissions.is_empty());
        for p in permissions {
            let p = p.as_str().unwrap_or_default();
            assert!(
                p.starts_with("allow-setup-")
                    || p == "core:event:allow-listen"
                    || p == "core:event:allow-unlisten",
                "{p}"
            );
        }
    }
}
