//! AEGIS Suite – Desktop-App.
// Unter Windows kein zusätzliches Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = tauri::Builder::default().run(tauri::generate_context!()) {
        eprintln!("AEGIS konnte nicht starten: {err}");
        std::process::exit(1);
    }
}
