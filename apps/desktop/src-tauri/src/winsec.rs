//! „Windows-Sicherheit öffnen“: zeigt die Windows-Einstellung „Ransomware-Schutz /
//! Überwachter Ordnerzugriff“. AEGIS ändert dort nichts – das macht der Nutzer selbst in
//! Windows.

/// Öffnet die Seite „Ransomware-Schutz“ der Windows-Sicherheit (fester Aufruf, keine Eingaben).
///
/// # Errors
/// Nicht unter Windows bzw. Explorer nicht startbar.
#[tauri::command]
pub fn open_windows_security() -> Result<(), String> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot unbekannt")?;
        let explorer = std::path::PathBuf::from(root).join("explorer.exe");
        // Öffnet nur eine Einstellungsseite von Windows (fester Pfad, feste Adresse) –
        // verändert nichts.
        // aegis-mutation: desktop-open-windows-security
        #[allow(clippy::disallowed_methods)]
        std::process::Command::new(explorer)
            .arg("windowsdefender://ransomwareprotection/")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Windows-Sicherheit nicht startbar: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("Die Windows-Sicherheit gibt es nur unter Windows.".into())
    }
}
