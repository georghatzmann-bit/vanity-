// Im Release-Build kein zusätzliches Konsolenfenster unter Windows öffnen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vanity_launcher_lib::run()
}
