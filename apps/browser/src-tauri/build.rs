//! Build-Skript des Browsers: App-eigene Befehle brauchen je eine ausdrückliche Berechtigung
//! in `capabilities/default.json` (wie in der Desktop-App).

/// App-eigene Tauri-Befehle (Namen wie in `generate_handler!`).
const APP_COMMANDS: &[&str] = &[
    "browser_state",
    "tab_open",
    "tab_close",
    "tab_select",
    "tab_go",
    "tab_back",
    "tab_forward",
    "tab_reload",
    "tab_allow_http",
    "content_visible",
    "settings_save",
    "lists_update",
    "bookmark_add",
    "bookmark_remove",
    "ghost_open",
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
