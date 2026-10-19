//! Eigenschaften der ausgelieferten Programme (läuft vor den Ende-zu-Ende-Tests).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

/// Der Prüfprozess läuft mit eingeschränktem Token, niedriger Integrität und ohne Zugriff auf
/// die Oberfläche (Job-Grenzen). Bibliotheken der Oberfläche (user32 & Co.) könnten dort beim
/// Start scheitern (Code 0xC0000142) – er darf sie gar nicht erst laden.
#[cfg(windows)]
#[test]
fn pruefprozess_laedt_keine_oberflaechen_bibliotheken() {
    let bytes = std::fs::read(env!("CARGO_BIN_EXE_aegis-scanworker")).unwrap();
    let pe = goblin::pe::PE::parse(&bytes).unwrap();
    let libs: Vec<String> = pe
        .libraries
        .iter()
        .map(|l| l.to_ascii_lowercase())
        .collect();
    println!("Importe des Prüfprozesses: {libs:?}");
    for gui in [
        "user32.dll",
        "gdi32.dll",
        "shell32.dll",
        "ole32.dll",
        "oleaut32.dll",
        "comctl32.dll",
        "comdlg32.dll",
        "winspool.drv",
    ] {
        assert!(!libs.iter().any(|l| l == gui), "{gui} in {libs:?}");
    }
}
