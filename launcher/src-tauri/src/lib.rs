//! Niobium – launcher logic.

mod commands;
mod engine;
mod pipe;
mod proc;

use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

/// The main window waits hidden behind the splash until the UI calls `app_ready`.
/// If that never happens (UI error), it is shown after this time anyway.
const SPLASH_SAFETY_NET: Duration = Duration::from_secs(8);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Niobium used to be called Vanity: copy old settings over once, before the config is read.
            let migration = engine::migrate_from_vanity();
            // Put the parkour list in place for the server DLL and the F9 menu (errors don't matter)
            engine::write_parkour_file(None);
            let engine = Arc::new(engine::Engine::new(app.handle().clone()));
            if let Some(report) = &migration {
                engine.after_migration(report);
            }
            // Backend and game server ports are fixed; set back other saved values (noted in the log)
            engine.pin_fixed_ports();
            app.manage(engine.clone());
            // Report the start state to the UI as soon as it is there
            engine.emit_services();

            // Safety net: never leave the main window hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SPLASH_SAFETY_NET);
                commands::show_main_window(&handle);
            });
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
            commands::get_client_settings,
            commands::set_client_settings,
            commands::set_trickshot_presets,
            commands::niobium_paths,
            commands::app_ready,
            commands::pending_log_lines,
            commands::bubble_builds_support,
            commands::reset_performance_mode_ini,
        ])
        .run(tauri::generate_context!())
        .expect("Niobium couldn't start");
}
