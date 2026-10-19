//! AEGIS Suite – Desktop-App.
// Unter Windows kein zusätzliches Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod navigation;

use navigation::NavigationPolicy;

fn main() {
    let context = tauri::generate_context!();
    let config = context.config();
    let use_https_scheme = config
        .app
        .windows
        .iter()
        .any(|window| window.use_https_scheme);
    // Den Vite-Server nur im Entwicklungs-Build zulassen (`cfg(dev)` setzt tauri-build, solange
    // `tauri build` nicht das Feature `custom-protocol` einschaltet).
    let dev_url = if cfg!(dev) {
        config.build.dev_url.clone()
    } else {
        None
    };
    let policy = NavigationPolicy::new(use_https_scheme, dev_url.as_ref());

    if let Err(err) = tauri::Builder::default()
        .plugin(navigation::guard(policy))
        .run(context)
    {
        eprintln!("AEGIS konnte nicht starten: {err}");
        std::process::exit(1);
    }
}
