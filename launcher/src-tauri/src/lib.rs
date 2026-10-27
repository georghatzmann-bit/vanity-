//! Rift – launcher logic.

mod commands;
mod download;
mod engine;
mod firewall;
mod friends;
mod pipe;
mod proc;

use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent, Window, WindowEvent};

/// The main window waits hidden behind the splash until the UI calls `app_ready`.
/// If that never happens (UI error), it is shown after this time anyway.
const SPLASH_SAFETY_NET: Duration = Duration::from_secs(8);

/// "Close Rift?" must show within this time (the UI answers `close_prompt_shown`). If it
/// doesn't (page error, WebView crashed or hangs), Rift stops everything and quits by itself –
/// the window has no frame of its own, so it could never be closed otherwise.
const CLOSE_PROMPT_TIMEOUT: Duration = Duration::from_secs(4);

/// Closing the main window (title bar X, Alt+F4, taskbar): if something still runs or starts,
/// the window stays open and the UI asks "Close Rift?" (event `app:close-requested`); its
/// "Stop & close" calls `quit_app`. With nothing running it closes at once – the exit handler in
/// `run` still makes sure the backend is stopped. If the UI never shows the question, Rift
/// stops everything and quits after `CLOSE_PROMPT_TIMEOUT`.
fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let Some(engine) = app.try_state::<Arc<engine::Engine>>() else { return };
    // None = `quit_app` already stopped everything
    let Some(mut running) = engine.close_check() else { return };
    // a running build download is paused when Rift closes (Resume continues next time)
    if let Some(downloads) = app.try_state::<Arc<download::Downloads>>() {
        running.extend(downloads.running_names());
    }
    if running.is_empty() {
        return;
    }
    api.prevent_close();
    // The question must be seen, also when closed from the taskbar while minimized
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let id = engine.ask_close();
    let _ = app.emit(engine::EVENT_CLOSE_REQUESTED, engine::CloseRequest { running, id });

    // Fallback: no answer from the UI → stop everything and quit anyway
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_PROMPT_TIMEOUT);
        let engine = handle.state::<Arc<engine::Engine>>();
        if engine.close_prompt_unanswered(id) && engine.close_check().is_some() {
            eprintln!("[Rift] The close question didn't show – stopping everything and closing.");
            engine.shutdown();
            handle.exit(0);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Rift used to be called Niobium (and Vanity before that): copy old settings over once, before the config is read.
            let migration = engine::migrate_from_vanity();
            // Put the parkour list in place for the server DLL and the F9 menu (errors don't matter)
            engine::write_parkour_file(None);
            let engine = Arc::new(engine::Engine::new(app.handle().clone()));
            // Bubble Builds: a GameUserSettings.ini backup left over from a crash or a close during
            // a game is put back first, before anything else can touch that file.
            engine.recover_gus_backup();
            if let Some(report) = &migration {
                engine.after_migration(report);
            }
            // Backend and game server ports are fixed; set back other saved values (noted in the log)
            engine.pin_fixed_ports();
            app.manage(engine.clone());
            // Build downloads (unfinished ones from the last run come back as "paused")
            app.manage(Arc::new(download::Downloads::load()));
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
        .on_window_event(on_window_event)
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
            commands::invite_info,
            commands::check_join,
            commands::join_game,
            commands::firewall_status,
            commands::firewall_allow,
            commands::firewall_remove,
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
            commands::pending_toasts,
            commands::bubble_builds_support,
            commands::quit_app,
            commands::close_prompt_shown,
            commands::bots_support,
            download::catalog_list,
            download::download_start,
            download::download_pause,
            download::download_resume,
            download::download_cancel,
            download::download_status,
            download::default_download_folder,
        ])
        .build(tauri::generate_context!())
        .expect("Rift couldn't start");
    app.run(|handle, event| {
        // Safety net: however Rift ends, nothing it started keeps running
        // (Fortnite, the game server, their helpers, the backend).
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(engine) = handle.try_state::<Arc<engine::Engine>>() {
                engine.shutdown();
            }
            // Downloads stop between chunks; the journal lets them continue next time
            if let Some(downloads) = handle.try_state::<Arc<download::Downloads>>() {
                downloads.pause_all();
            }
        }
    });
}
