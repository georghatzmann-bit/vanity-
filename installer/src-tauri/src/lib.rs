//! Nova Setup – Backend der Installer-App (`NovaLauncher-Setup.exe`).
//!
//! Lädt `NovaLauncher.exe` laut Manifest herunter (fortsetzbar), prüft SHA-256, installiert pro
//! Benutzer (Adminrechte nur bei Bedarf), legt Verknüpfungen und den "Apps & Features"-Eintrag an,
//! aktualisiert und deinstalliert. Vertrag mit der Oberfläche: `docs/INSTALLER.md`.

pub mod args;
pub mod commands;
pub mod config;
pub mod disk;
pub mod download;
pub mod install;
pub mod manifest;
pub mod platform;
pub mod selftest;
pub mod types;
pub mod uninstall;
pub mod util;

#[cfg(test)]
mod tests;

use args::CliArgs;

pub fn run() {
    let cli = CliArgs::from_env();
    util::log(format!("Start {} {:?}", config::setup_version(), std::env::args().skip(1).collect::<Vec<_>>()));

    // Ohne Oberfläche: Selbsttest.
    if cli.selftest {
        platform::attach_parent_console();
        std::process::exit(selftest::run_from_cli(&cli));
    }

    // Deinstallation aus dem Installationsordner: erst nach %TEMP% umziehen, damit der Ordner gelöscht werden kann.
    if cli.uninstall && cli.target.is_none() && cfg!(windows) {
        if let Some(code) = uninstall::relocate_if_needed(&cli) {
            std::process::exit(code);
        }
    }

    // Ohne Oberfläche: stille Deinstallation (QuietUninstallString).
    if cli.uninstall && cli.quiet {
        platform::attach_parent_console();
        std::process::exit(uninstall::run_quiet(&cli));
    }

    // Die Oberfläche braucht WebView2 (unter Windows 10 evtl. nicht vorhanden).
    if !platform::ensure_webview2() {
        std::process::exit(1);
    }

    let state = commands::AppState::new(cli);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::setup_info,
            commands::fetch_manifest,
            commands::disk_space,
            commands::start_install,
            commands::cancel_install,
            commands::relaunch_elevated,
            commands::app_running,
            commands::close_app,
            commands::launch_app,
            commands::start_uninstall,
            commands::open_url,
            commands::quit,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::on_exit(handle);
            }
        }),
        Err(e) => {
            util::log(format!("Tauri-Start fehlgeschlagen: {e}"));
            platform::show_error_box(
                "Nova Setup",
                &format!("{}\n\n{e}", util::tr("Das Setup konnte nicht gestartet werden.", "The setup could not be started.")),
            );
            std::process::exit(1);
        }
    }
}
