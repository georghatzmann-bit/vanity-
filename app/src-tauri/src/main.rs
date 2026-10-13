// Verhindert ein zusätzliches Konsolenfenster unter Windows (nur im Release-Build)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Admin-Helfer (mit UAC gestartet): Aufgaben ausführen und sofort wieder beenden
    if let Some(code) = pulsar_lib::elevated_entry() {
        std::process::exit(code);
    }
    pulsar_lib::run()
}
