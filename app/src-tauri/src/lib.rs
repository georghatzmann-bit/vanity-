//! Pulsar – Game Booster, Rust-Backend (Tauri v2).
//!
//! Einstiegspunkt: [`run`]. Alle Befehle sind in `invoke_handler` registriert und folgen dem
//! Vertrag in `docs/API.md`.

mod appinfo;
mod backup;
mod config;
mod db;
mod error;
mod icons;
mod images;
mod launch;
mod library;
mod models;
mod native;
mod net;
mod opt;
mod scan;
mod selftest;
mod state;
mod system;
mod tracker;
mod update;
mod util;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, RunEvent};
use tauri_plugin_window_state::StateFlags;

use crate::error::LockExt;
use crate::state::{Core, Paths, Shared, DEFAULT_PROFILE};

const IDENTIFIER: &str = "com.pulsar.booster";
const DEFAULT_OVERLAY_SHORTCUT: &str = "Alt+Shift+P";

fn fallback_dir(base: Option<PathBuf>) -> PathBuf {
    base.unwrap_or_else(std::env::temp_dir).join(IDENTIFIER)
}

/// Fehler beim Start sichtbar machen (unter Windows gibt es keine Konsole).
fn fatal(msg: &str) {
    eprintln!("{msg}");
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
        let title: Vec<u16> = "Pulsar".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
        }
    }
}

fn setup(app: &mut tauri::App, started_minimized: bool) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| fallback_dir(dirs::data_dir()));
    let local_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| fallback_dir(dirs::data_local_dir()));
    let paths = Paths::new(data_dir, local_dir);
    for dir in [paths.data_dir.clone(), paths.images_dir(), paths.thumbs_dir()] {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("Ordner konnte nicht angelegt werden: {}: {e}", dir.display());
        }
    }

    let core: Shared = Arc::new(Core::new(paths, started_minimized));
    match backup::open_with_recovery(&core.paths, DEFAULT_PROFILE) {
        Ok(db) => {
            core.db.replace(Some(db));
        }
        Err(e) => eprintln!("Datenbank konnte nicht geöffnet werden: {e}"),
    }
    app.manage(core.clone());

    tracker::Tracker::start(core.clone(), handle.clone());
    backup::auto_backup_in_background(core.clone());
    backup::auto_backup_daily(core.clone());

    if let Err(e) = native::setup_tray(&handle) {
        eprintln!("Tray-Symbol konnte nicht angelegt werden: {e}");
    }
    if let Err(e) = native::apply_shortcut(&handle, &core, DEFAULT_OVERLAY_SHORTCUT) {
        eprintln!("{e}");
    } else {
        core.native.lock_safe().settings.overlay_shortcut = DEFAULT_OVERLAY_SHORTCUT.into();
    }

    // Eingebauter Selbsttest für automatische Prüfungen (CI)
    if let Some(report) = selftest::report_path() {
        selftest::spawn(handle.clone(), report);
    }

    if let Some(main) = app.get_webview_window("main") {
        if started_minimized {
            let _ = main.hide();
        } else {
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
    Ok(())
}

/// Startet die App.
pub fn run() {
    let started_minimized = std::env::args().any(|a| a == "--minimized");

    let builder = tauri::Builder::default()
        // Muss als erstes Plugin registriert werden
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            native::on_second_instance(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS)
                .with_denylist(&["overlay"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--minimized"])
                // gleicher Registry-Name wie beim Installer (HKCU\…\Run\Pulsar)
                .app_name("Pulsar")
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(native::on_shortcut)
                .build(),
        )
        .setup(move |app| setup(app, started_minimized))
        .on_window_event(native::on_window_event)
        .invoke_handler(tauri::generate_handler![
            // App
            appinfo::app_info,
            native::quit_app,
            // Datenbank (Spiele, Berichte, Einstellungen)
            library::db_list,
            library::db_put,
            library::db_put_many,
            library::db_delete,
            library::kv_get,
            library::kv_set,
            // Spielzeit
            library::playtime_stats,
            library::sessions_range,
            library::sessions_for_game,
            library::session_delete,
            // Spiele finden
            scan::scan_library,
            scan::inspect_paths,
            scan::paths_exist,
            // Starten & Erkennung
            launch::set_tracked_games,
            launch::launch_game,
            launch::stop_game,
            launch::running_games,
            launch::open_path,
            launch::reveal_path,
            launch::open_url,
            // Bilder
            images::images_fetch,
            images::image_set_custom,
            images::exe_icon,
            images::cache_size,
            images::cache_clear,
            // System
            system::system_stats,
            // Netzwerk
            net::net_ping_once,
            net::net_monitor_start,
            net::net_monitor_stop,
            net::net_regions,
            net::net_regions_ping,
            net::net_game_servers,
            net::net_traceroute,
            net::net_dns_benchmark,
            net::net_dns_current,
            net::net_dns_apply,
            net::net_dns_restore,
            net::net_adapters,
            net::net_wifi,
            net::net_speedtest,
            net::net_speedtest_cancel,
            // Optimieren & Boost
            opt::opt_tweaks,
            opt::opt_apply,
            opt::opt_revert_all,
            opt::opt_power_plans,
            opt::opt_power_set,
            opt::opt_flush_dns,
            opt::boost_start,
            opt::boost_stop,
            opt::boost_state,
            // Sicherungen
            backup::backups_list,
            backup::backup_now,
            backup::backup_restore,
            // Native Integration
            native::apply_native_settings,
            native::overlay_toggle,
            native::tray_set_recent,
            update::update_check,
            update::update_install,
        ]);

    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event {
                // Offene Sitzungen speichern, Datenbank schließen
                if let Some(core) = handle.try_state::<Shared>() {
                    native::finalize(&core);
                }
            }
        }),
        Err(e) => fatal(&format!("Pulsar konnte nicht gestartet werden:\n{e}")),
    }
}
