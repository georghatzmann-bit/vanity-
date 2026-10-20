//! `aegis-service` – Hintergrunddienst der AEGIS Suite.
//!
//! ```text
//! aegis-service run [--data-dir ORDNER] [--endpoint NAME]   Konsole (Entwicklung)
//! aegis-service service                                      vom Windows-Dienststeuerungs-Manager
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use aegis_service::server::{ServerConfig, run};

fn usage() -> ! {
    eprintln!(
        "Aufruf: aegis-service run [--data-dir ORDNER] [--endpoint NAME] | aegis-service service | aegis-service install | aegis-service uninstall"
    );
    std::process::exit(2);
}

fn parse_run(args: &[String]) -> ServerConfig {
    let Some(mut config) = ServerConfig::default_for_platform() else {
        eprintln!("Kein Datenordner bestimmbar – bitte --data-dir angeben.");
        std::process::exit(2);
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match (arg.as_str(), it.next()) {
            ("--data-dir", Some(v)) if PathBuf::from(v).is_absolute() => {
                config.data_dir = PathBuf::from(v)
            }
            ("--endpoint", Some(v)) => config.endpoint.clone_from(v),
            _ => usage(),
        }
    }
    config
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") => {
            let config = parse_run(&args[1..]);
            eprintln!(
                "aegis-service: {} · Daten: {}",
                config.endpoint,
                config.data_dir.display()
            );
            if let Err(e) = run(&config, &Arc::new(AtomicBool::new(false))) {
                eprintln!("aegis-service konnte nicht starten: {e}");
                std::process::exit(1);
            }
        }
        // Nur vom Installationsprogramm (mit Administratorrechten) aufgerufen.
        #[cfg(windows)]
        Some("install") => {
            let result = std::env::current_exe()
                .map_err(|e| e.to_string())
                .and_then(|exe| aegis_service::scm::install(&exe).map_err(|e| e.to_string()));
            if let Err(e) = result {
                eprintln!("aegis-service: Installation fehlgeschlagen: {e}");
                std::process::exit(1);
            }
        }
        #[cfg(windows)]
        Some("uninstall") => {
            if let Err(e) = aegis_service::scm::uninstall() {
                eprintln!("aegis-service: Entfernen fehlgeschlagen: {e}");
                std::process::exit(1);
            }
        }
        #[cfg(windows)]
        Some("service") => {
            if let Err(e) = aegis_service::scm::start() {
                eprintln!("aegis-service (Dienstmodus) konnte nicht starten: {e}");
                std::process::exit(1);
            }
        }
        _ => usage(),
    }
}
