//! Vanity – Launcher-Logik.
//!
//! Phase 1 enthält nur das Fenster. Ab Phase 2 kommen hier dazu:
//! Builds erkennen, Fortnite starten, DLLs laden, Logs mitlesen.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Vanity konnte nicht gestartet werden");
}
