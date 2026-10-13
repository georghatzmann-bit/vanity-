//! Betriebssystem-Anbindung. Unter Windows echt (Registry, COM-Verknüpfungen, UAC, Prozesse),
//! auf anderen Systemen harmlose Ersatzfunktionen, damit der Kern dort getestet werden kann.

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use self::win::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use self::other::*;

/// Werte für den Eintrag unter "Apps & Features".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallEntry {
    pub display_name: String,
    pub display_version: String,
    pub publisher: String,
    pub display_icon: String,
    pub install_location: String,
    pub uninstall_string: String,
    pub quiet_uninstall_string: String,
    pub estimated_size_kb: u32,
    pub install_date: String,
    pub url_info_about: String,
}

/// Ergebnis eines UAC-Neustarts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElevateError {
    /// Der Benutzer hat die UAC-Abfrage abgelehnt.
    Declined,
    Failed(String),
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

/// Pfad der Startmenü-Verknüpfung (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Pulsar.lnk`).
pub fn start_menu_shortcut() -> Option<std::path::PathBuf> {
    start_menu_dir().map(|d| d.join(crate::config::shortcut_file_name()))
}

/// Pfad der Desktop-Verknüpfung.
pub fn desktop_shortcut() -> Option<std::path::PathBuf> {
    desktop_dir().map(|d| d.join(crate::config::shortcut_file_name()))
}
