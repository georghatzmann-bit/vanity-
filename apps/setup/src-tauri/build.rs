//! Build-Skript des Setups: eigene Befehle brauchen je eine ausdrückliche Berechtigung in
//! `capabilities/default.json` (wie in der Desktop-App).
//!
//! Offline-Setup: Zeigt `AEGIS_SETUP_PAYLOAD_DIR` auf einen Ordner mit `aegis-suite-setup.exe`
//! (Pflicht) und `aegis-browser-setup.exe` (optional), werden beide samt SHA-256 in das Setup
//! eingebettet (`include_bytes!`, nur Daten) – es installiert dann ohne Download. Ohne die
//! Variable: Online-Setup. Das Skript schreibt keine Dateien.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Eigene Tauri-Befehle (Namen wie in `generate_handler!`).
const APP_COMMANDS: &[&str] = &[
    "setup_info",
    "setup_check",
    "setup_download",
    "setup_install",
    "setup_launch",
];

/// Eingebettete Pakete: (Name der Umgebungsvariablen, Dateiname im Paket-Ordner, Pflicht?).
const PACKAGES: [(&str, &str, bool); 2] = [
    ("AEGIS_SETUP_APP", "aegis-suite-setup.exe", true),
    ("AEGIS_SETUP_BROWSER", "aegis-browser-setup.exe", false),
];

/// Gibt Pfad und SHA-256 jedes Pakets an den Compiler weiter (`include_bytes!` im Setup).
/// Ohne Paket: die leere Datei `payload/empty.bin` und keine Prüfsumme.
fn payload() {
    println!("cargo:rerun-if-env-changed=AEGIS_SETUP_PAYLOAD_DIR");
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(PathBuf::new, PathBuf::from);
    let empty = manifest.join("payload").join("empty.bin");
    let dir = std::env::var_os("AEGIS_SETUP_PAYLOAD_DIR").map(PathBuf::from);
    for (var, file, required) in PACKAGES {
        let found = dir.as_deref().map(|d| d.join(file)).and_then(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            std::fs::read(&path).ok().map(|bytes| (path, bytes))
        });
        if dir.is_some() && required && found.is_none() {
            eprintln!("{file} fehlt in AEGIS_SETUP_PAYLOAD_DIR");
            std::process::exit(1);
        }
        let (path, hash) = found.map_or_else(
            || (empty.clone(), String::new()),
            |(path, bytes)| {
                let hash = Sha256::digest(&bytes)
                    .iter()
                    .fold(String::new(), |mut s, b| {
                        let _ = write!(s, "{b:02x}");
                        s
                    });
                (path, hash)
            },
        );
        println!("cargo:rustc-env={var}={}", Path::new(&path).display());
        println!("cargo:rustc-env={var}_SHA256={hash}");
    }
}

fn main() {
    payload();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        // Wie `tauri_build::build()`: Meldung ausgeben und den Build abbrechen.
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
