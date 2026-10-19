//! **Harmloser** Verhaltens-Simulator für Tests des Labors (keine Schadfunktion): legt im
//! eigenen Arbeitsordner zwei Dateien an (Text und Zufallsdaten mit hoher Entropie), versucht
//! eine Verbindung zu 127.0.0.1:9 und – nur mit `--autostart` – einen harmlosen
//! Autostart-Eintrag über `reg.exe`. Gedacht nur für die Sandbox-Tests.

use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn write(name: &str, data: &[u8]) {
    // Harmloser Simulator: schreibt nur in seinen eigenen Arbeitsordner (Labor).
    // aegis-mutation: simulator-write
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::File::create(name);
    if let Ok(mut f) = file {
        let _ = f.write_all(data);
    }
}

fn main() {
    write("sim-notiz.txt", b"Harmloser AEGIS-Labor-Simulator.\n");
    // Pseudozufall (xorshift) – hohe Entropie wie verschlüsselte Daten.
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let data: Vec<u8> = (0..64 * 1024)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x.to_le_bytes()[0]
        })
        .collect();
    write("sim-daten.bin", &data);
    let addr = SocketAddr::from(([127, 0, 0, 1], 9));
    let _ = TcpStream::connect_timeout(&addr, Duration::from_millis(500));
    if std::env::args().any(|a| a == "--autostart") {
        // Harmloser Autostart-Versuch (nur in der Sandbox gedacht).
        // aegis-mutation: simulator-reg
        #[allow(clippy::disallowed_methods)]
        let _ = std::process::Command::new("reg.exe")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "AEGIS-Labor-Simulator",
                "/d",
                "harmlos",
                "/f",
            ])
            .status();
    }
    std::thread::sleep(Duration::from_millis(1500));
}
