//! Systemnahe Schritte (Papierkorb, Hintergrundbild, Autostart, Desktop-Symbole). Unter Windows
//! über `aegis-winffi`; sonst (Entwicklung, Tests) ein eigener Papierkorb-Ordner.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::autostart::EntryRef;

/// Wie eine Datei aus dem Papierkorb zurückkommt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recycled {
    /// Inhalt im Papierkorb (`$R…` bzw. eigener Papierkorb).
    pub data: PathBuf,
    /// Begleitdatei mit dem Originalpfad (`$I…`), falls vorhanden.
    pub info: Option<PathBuf>,
}

/// Systemnahe Schritte.
pub trait Platform {
    /// Datei in den Papierkorb.
    ///
    /// # Errors
    /// Nicht möglich.
    fn recycle(&self, path: &Path) -> io::Result<Recycled>;
    /// Datei aus dem Papierkorb an ihren Ort zurück (nie überschreibend).
    ///
    /// # Errors
    /// Nicht mehr im Papierkorb oder Ziel belegt.
    fn restore(&self, item: &Recycled, original: &Path) -> io::Result<()>;
    /// Aktuelles Hintergrundbild.
    ///
    /// # Errors
    /// Nicht lesbar.
    fn wallpaper(&self) -> io::Result<PathBuf>;
    /// Hintergrundbild setzen.
    ///
    /// # Errors
    /// Nicht möglich.
    fn set_wallpaper(&self, path: &Path) -> io::Result<()>;
    /// Ist der Autostart-Eintrag an?
    ///
    /// # Errors
    /// Unbekannt.
    fn autostart_enabled(&self, entry: &EntryRef) -> io::Result<bool>;
    /// Autostart-Eintrag an/aus (wie der Task-Manager; nichts wird gelöscht).
    ///
    /// # Errors
    /// Nicht möglich.
    fn set_autostart(&self, entry: &EntryRef, enable: bool) -> io::Result<()>;
    /// Setzt die Desktop-Symbole wie im gespeicherten Layout und liefert das vorherige Layout
    /// (zum Rückgängigmachen).
    ///
    /// # Errors
    /// Nicht möglich.
    fn apply_desktop_layout(
        &self,
        layout: &crate::desktop::Layout,
    ) -> io::Result<crate::desktop::Layout>;
    /// Wert unter `HKCU` lesen.
    ///
    /// # Errors
    /// Nicht lesbar oder unbekannter Typ.
    fn registry_get(&self, key: &str, name: &str) -> io::Result<crate::tweaks::Value>;
    /// Wert unter `HKCU` setzen (`Absent` = entfernen).
    ///
    /// # Errors
    /// Nicht möglich.
    fn registry_set(&self, key: &str, name: &str, value: &crate::tweaks::Value) -> io::Result<()>;
}

fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "nur unter Windows")
}

/// Ohne Windows: eigener Papierkorb-Ordner, Systemschritte nicht verfügbar.
#[derive(Debug, Clone)]
pub struct LocalPlatform {
    /// Ordner des eigenen Papierkorbs.
    pub trash: PathBuf,
}

impl Platform for LocalPlatform {
    fn recycle(&self, path: &Path) -> io::Result<Recycled> {
        let dir = self.trash.join(uuid::Uuid::new_v4().simple().to_string());
        // Eigener Papierkorb-Ordner (nur ohne Windows: Entwicklung und Tests).
        // aegis-mutation: tools-local-trash-dir
        #[allow(clippy::disallowed_methods)]
        std::fs::create_dir_all(&dir)?;
        let data = dir.join(
            path.file_name()
                .ok_or_else(|| io::Error::other("kein Name"))?,
        );
        // Verschiebt die vom Nutzer freigegebene Datei in den eigenen Papierkorb.
        // aegis-mutation: tools-local-trash-move
        #[allow(clippy::disallowed_methods)]
        std::fs::rename(path, &data)?;
        Ok(Recycled { data, info: None })
    }

    fn restore(&self, item: &Recycled, original: &Path) -> io::Result<()> {
        if std::fs::symlink_metadata(original).is_ok() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Ziel belegt"));
        }
        if !item.data.starts_with(&self.trash) {
            return Err(io::Error::other("nicht aus dem eigenen Papierkorb"));
        }
        // Holt die Datei aus dem eigenen Papierkorb an ihren Ort zurück (Rückgängig).
        // aegis-mutation: tools-local-trash-restore
        #[allow(clippy::disallowed_methods)]
        std::fs::rename(&item.data, original)
    }

    fn wallpaper(&self) -> io::Result<PathBuf> {
        Err(unsupported())
    }

    fn set_wallpaper(&self, _path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    fn autostart_enabled(&self, _entry: &EntryRef) -> io::Result<bool> {
        Err(unsupported())
    }

    fn set_autostart(&self, _entry: &EntryRef, _enable: bool) -> io::Result<()> {
        Err(unsupported())
    }

    fn apply_desktop_layout(
        &self,
        _layout: &crate::desktop::Layout,
    ) -> io::Result<crate::desktop::Layout> {
        Err(unsupported())
    }

    fn registry_get(&self, _key: &str, _name: &str) -> io::Result<crate::tweaks::Value> {
        Err(unsupported())
    }

    fn registry_set(
        &self,
        _key: &str,
        _name: &str,
        _value: &crate::tweaks::Value,
    ) -> io::Result<()> {
        Err(unsupported())
    }
}
