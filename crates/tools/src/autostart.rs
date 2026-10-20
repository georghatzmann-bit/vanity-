//! Autostart-Manager (Werkzeug 11): Einträge des Kontos aus- oder einschalten wie der
//! Task-Manager (Schalter `StartupApproved`) – nichts wird gelöscht, alles ist umkehrbar.
//! Rechnerweite Einträge zeigt die App nur an (Ändern dort: Persistenz-Check über den Dienst).

use serde::{Deserialize, Serialize};

/// Ort eines Autostart-Eintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Location {
    /// `HKCU\…\Run`.
    RunUser,
    /// Autostart-Ordner des Kontos.
    StartupFolderUser,
    /// `HKLM\…\Run` (nur Anzeige).
    RunMachine,
    /// Autostart-Ordner aller Nutzer (nur Anzeige).
    StartupFolderMachine,
}

impl Location {
    /// Darf die App (mit Nutzerrechten) den Schalter setzen?
    #[must_use]
    pub fn editable(self) -> bool {
        matches!(self, Self::RunUser | Self::StartupFolderUser)
    }

    /// Schlüssel der Schalter unter `HKCU` (nur für änderbare Orte).
    #[must_use]
    pub fn approved_key(self) -> Option<&'static str> {
        match self {
            Self::RunUser => {
                Some(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run")
            }
            Self::StartupFolderUser => Some(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
            ),
            Self::RunMachine | Self::StartupFolderMachine => None,
        }
    }
}

/// Verweis auf einen Eintrag.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntryRef {
    /// Ort.
    pub location: Location,
    /// Name (Wertname bzw. Dateiname der Verknüpfung).
    pub name: String,
}

/// Ein Autostart-Eintrag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Verweis.
    pub entry: EntryRef,
    /// Befehl bzw. Ziel.
    pub command: String,
    /// An?
    pub enabled: bool,
    /// Änderbar mit Nutzerrechten?
    pub editable: bool,
}

/// Ist ein Eintrag laut `StartupApproved` an (fehlt der Wert: an)?
#[must_use]
pub fn approved_enabled(bytes: Option<&[u8]>) -> bool {
    bytes.and_then(|b| b.first()).is_none_or(|b| b % 2 == 0)
}

/// Wert für `StartupApproved` (wie der Task-Manager: 02/03, dann die Zeit als FILETIME).
#[must_use]
pub fn approved_value(enable: bool, filetime: u64) -> Vec<u8> {
    let mut value = vec![if enable { 2 } else { 3 }, 0, 0, 0];
    value.extend_from_slice(&filetime.to_le_bytes());
    value
}

/// Name gültig (kein Pfad, keine Steuerzeichen)?
#[must_use]
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 260
        && !name.contains(['\\', '/', '\0'])
        && !name.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schalter_wie_task_manager() {
        assert!(approved_enabled(None));
        assert!(approved_enabled(Some(&[2, 0, 0, 0])));
        assert!(!approved_enabled(Some(&[3, 0, 0, 0])));
        assert_eq!(approved_value(false, 1).len(), 12);
        assert_eq!(approved_value(true, 0)[0], 2);
        assert!(Location::RunUser.editable());
        assert!(!Location::RunMachine.editable());
        assert!(Location::RunMachine.approved_key().is_none());
        assert!(!valid_name("..\\x"));
        assert!(valid_name("OneDrive"));
    }
}
