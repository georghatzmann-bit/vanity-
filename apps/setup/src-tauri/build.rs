//! Build-Skript des Setups: eigene Befehle brauchen je eine ausdrückliche Berechtigung in
//! `capabilities/default.json` (wie in der Desktop-App).

/// Eigene Tauri-Befehle (Namen wie in `generate_handler!`).
const APP_COMMANDS: &[&str] = &[
    "setup_info",
    "setup_check",
    "setup_download",
    "setup_install",
    "setup_launch",
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
