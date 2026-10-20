//! Desktop-Symbole: Positionen speichern und wiederherstellen (Werkzeug 4). Gelesen und gesetzt
//! wird über die Shell-Schnittstelle des Desktops (Windows); hier nur die Daten.

use serde::{Deserialize, Serialize};

/// Position eines Symbols.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Icon {
    /// Anzeigename (zum Wiederfinden).
    pub name: String,
    /// X in Pixeln.
    pub x: i32,
    /// Y in Pixeln.
    pub y: i32,
}

/// Gespeichertes Layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    /// Name.
    pub name: String,
    /// Gespeichert am (Unix-Sekunden).
    pub saved: i64,
    /// Symbole.
    pub icons: Vec<Icon>,
}

/// Höchstzahl Symbole je Layout.
pub const MAX_ICONS: usize = 2000;

impl Layout {
    /// Prüft Name und Größe.
    ///
    /// # Errors
    /// Ungültig.
    pub fn validated(mut self) -> Result<Self, String> {
        self.name = self
            .name
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(80)
            .collect();
        if self.name.is_empty() {
            return Err("Bitte einen Namen angeben.".into());
        }
        if self.icons.len() > MAX_ICONS {
            return Err("Zu viele Symbole.".into());
        }
        Ok(self)
    }
}
