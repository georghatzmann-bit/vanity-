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

/// Feste Einstellungsseiten, die die Seite „Härtung“ öffnen darf.
const SETTINGS_PAGES: [(&str, &str); 5] = [
    ("windows_update", "ms-settings:windowsupdate"),
    ("device_encryption", "ms-settings:deviceencryption"),
    ("virus_protection", "windowsdefender://threat/"),
    ("core_isolation", "windowsdefender://coreisolation/"),
    // Einstellungen „Viren- & Bedrohungsschutz“ (dort schaltet der Nutzer den Manipulationsschutz).
    ("defender_settings", "windowsdefender://threatsettings/"),
];

/// Adresse einer erlaubten Einstellungsseite (sonst `None`).
fn settings_uri(page: &str) -> Option<&'static str> {
    SETTINGS_PAGES
        .iter()
        .find(|(id, _)| *id == page)
        .map(|(_, uri)| *uri)
}

/// Öffnet eine Windows-Einstellungsseite aus einer festen Liste (Windows Update,
/// Geräteverschlüsselung, Viren- & Bedrohungsschutz). AEGIS ändert dort nichts selbst.
///
/// # Errors
/// Unbekannte Seite, nicht unter Windows bzw. Explorer nicht startbar.
#[tauri::command]
pub fn open_windows_settings(page: String) -> Result<(), String> {
    let uri = settings_uri(&page).ok_or("Unbekannte Einstellungsseite.")?;
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot unbekannt")?;
        let explorer = std::path::PathBuf::from(root).join("explorer.exe");
        // Öffnet nur eine Einstellungsseite von Windows aus der festen Liste – verändert nichts.
        // aegis-mutation: desktop-open-windows-settings
        #[allow(clippy::disallowed_methods)]
        std::process::Command::new(explorer)
            .arg(uri)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Einstellungen nicht startbar: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = uri;
        Err("Windows-Einstellungen gibt es nur unter Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::settings_uri;

    #[test]
    fn nur_feste_seiten() {
        assert_eq!(
            settings_uri("windows_update"),
            Some("ms-settings:windowsupdate")
        );
        assert_eq!(settings_uri("ms-settings:privacy"), None);
        assert_eq!(settings_uri("../cmd"), None);
    }
}
