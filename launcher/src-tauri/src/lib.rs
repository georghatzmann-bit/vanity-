//! Vanity – Launcher-Logik.

mod commands;
mod engine;
mod pipe;
mod proc;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let engine = Arc::new(engine::Engine::new(app.handle().clone()));
            app.manage(engine.clone());
            // Startzustand an die Oberfläche melden, sobald sie da ist
            engine.emit_services();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::platform,
            commands::update_settings,
            commands::detect_build,
            commands::add_build,
            commands::remove_build,
            commands::add_profile,
            commands::update_profile,
            commands::remove_profile,
            commands::set_active_profile,
            commands::add_friend,
            commands::remove_friend,
            commands::list_crashes,
            commands::share_addresses,
            commands::host_and_play,
            commands::stop_all,
            commands::join_ip,
            commands::server_exec,
            commands::server_config,
            commands::server_start_match,
            commands::spawn_bots,
            commands::remove_bots,
        ])
        .run(tauri::generate_context!())
        .expect("Vanity konnte nicht gestartet werden");
}
