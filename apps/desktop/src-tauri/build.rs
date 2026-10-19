//! Build-Skript der Desktop-App.
//!
//! `AppManifest::commands` legt ein ACL-Manifest für die App-eigenen Befehle an. Sobald es
//! existiert, verlangt Tauri auch für App-Befehle eine ausdrückliche Berechtigung in einer
//! Capability (`allow-<befehl>`), statt sie jedem lokalen Fenster zu erlauben. Neue Befehle
//! werden hier eingetragen und in `capabilities/default.json` einzeln freigegeben.

/// App-eigene Tauri-Befehle (Namen wie in `generate_handler!`).
const APP_COMMANDS: &[&str] = &[
    "app_info",
    "hide_to_tray",
    "service_scan",
    "service_list_quarantine",
    "service_propose_quarantine",
    "service_propose_restore",
    "service_propose_delete",
    "service_decide",
    "service_confirm_second",
    "service_list_trust",
    "service_revoke_trust",
    "service_watch_poll",
    "service_set_gaming",
    "service_history",
    "service_get_schedule",
    "service_set_schedule",
    "service_set_clamav_update",
    "service_lab_status",
    "service_propose_lab_run",
    "service_lab_screenshot",
    "service_propose_enable_sandbox",
    "lab_capture_windows",
    "export_report",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        // Wie `tauri_build::build()`: Meldung ausgeben und den Build abbrechen.
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
