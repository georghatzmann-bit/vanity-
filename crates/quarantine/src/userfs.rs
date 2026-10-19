//! Zugriff auf **Nutzerdateien** (Original beim Isolieren, Ziel beim Wiederherstellen).
//!
//! Der Dienst läuft als SYSTEM. Damit er nichts tut, was der anfragende Nutzer selbst nicht
//! dürfte, öffnet/legt er Nutzerdateien nur innerhalb von [`UserAccess::enter`] an – unter
//! Windows mit der Identität des Pipe-Clients. Außerdem:
//!
//! - keine Links, auch nicht in Zwischenordnern (sonst zeigt der Plan einen anderen Pfad, als
//!   tatsächlich verändert wird),
//! - Original exklusiv geöffnet und über das Handle entfernt (Windows),
//! - Wiederherstellen legt nur **neue** Dateien an – nie überschreiben, keine fehlenden Ordner
//!   anlegen.
//!
//! Unter Unix (nur Entwicklung/Tests) prüft der Code dieselben Regeln mit Standardmitteln;
//! dort gibt es kleine Zeitfenster zwischen Prüfen und Öffnen (dokumentiert, nicht Ziel-OS).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Rechte des anfragenden Nutzers für die Dauer des Rückgabewerts.
pub struct UserScope(Option<Box<dyn std::any::Any>>);

impl UserScope {
    /// Kein Identitätswechsel (gleicher Prozess, Tests).
    #[must_use]
    pub fn unchanged() -> Self {
        Self(None)
    }

    /// Hält einen Identitätswechsel, bis der Wert verworfen wird.
    #[must_use]
    pub fn holding<T: 'static>(guard: T) -> Self {
        Self(Some(Box::new(guard)))
    }
}

impl std::fmt::Debug for UserScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("UserScope").field(&self.0.is_some()).finish()
    }
}

/// Wie Nutzerdateien angefasst werden.
pub trait UserAccess {
    /// Wechselt auf die Rechte des anfragenden Nutzers.
    ///
    /// # Errors
    /// Identitätswechsel nicht möglich – dann wird nichts angefasst.
    fn enter(&self) -> io::Result<UserScope>;
}

/// Ohne Identitätswechsel: der eigene Prozess ist der Nutzer (Tests, Werkzeuge).
#[derive(Debug, Clone, Copy, Default)]
pub struct OwnProcess;

impl UserAccess for OwnProcess {
    fn enter(&self) -> io::Result<UserScope> {
        Ok(UserScope::unchanged())
    }
}

/// Geöffnetes Original.
#[derive(Debug)]
pub struct Original {
    pub(crate) file: File,
    #[cfg_attr(windows, allow(dead_code))]
    path: PathBuf,
    #[cfg(unix)]
    id: (u64, u64),
}

/// Neu angelegtes Wiederherstellungs-Ziel.
#[derive(Debug)]
pub struct Restored {
    pub(crate) file: File,
    #[cfg_attr(windows, allow(dead_code))]
    path: PathBuf,
    #[cfg(unix)]
    id: (u64, u64),
}

#[cfg(unix)]
fn rejected(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg.to_owned())
}

#[cfg(windows)]
mod imp {
    use super::{Original, Restored};
    use std::io;
    use std::path::Path;

    pub fn open_original(path: &Path) -> io::Result<Original> {
        Ok(Original {
            file: aegis_winffi::open_exclusive(path)?,
            path: path.to_owned(),
        })
    }

    pub fn remove_original(original: Original) -> io::Result<()> {
        aegis_winffi::delete_by_handle(&original.file)
        // Entfernt wird beim Schließen des Handles (Ende dieser Funktion).
    }

    pub fn create_restored(path: &Path) -> io::Result<Restored> {
        Ok(Restored {
            file: aegis_winffi::create_new(path)?,
            path: path.to_owned(),
        })
    }

    pub fn discard_restored(restored: Restored) -> io::Result<()> {
        aegis_winffi::delete_by_handle(&restored.file)
    }
}

#[cfg(unix)]
mod imp {
    use super::{Original, Restored, rejected};
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    fn id(meta: &std::fs::Metadata) -> (u64, u64) {
        (meta.dev(), meta.ino())
    }

    /// Kein Link in einem Zwischenordner: der aufgelöste Ordner ist der angefragte.
    fn parent_is_real(path: &Path) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| rejected("Pfad ohne Ordner"))?;
        if std::fs::canonicalize(parent)? == parent {
            Ok(())
        } else {
            Err(rejected(
                "Pfad führt über eine Verknüpfung woanders hin – abgelehnt",
            ))
        }
    }

    pub fn open_original(path: &Path) -> io::Result<Original> {
        parent_is_real(path)?;
        let before = std::fs::symlink_metadata(path)?;
        if !before.file_type().is_file() {
            return Err(rejected(
                "keine reguläre Datei (Links und Ordner werden nicht isoliert)",
            ));
        }
        let file = File::open(path)?;
        let meta = file.metadata()?;
        if id(&meta) != id(&before) {
            return Err(rejected("Datei wurde während der Prüfung ersetzt"));
        }
        if meta.nlink() != 1 {
            return Err(rejected(
                "Datei hat mehrere Hardlinks – Isolieren würde sie nicht entfernen",
            ));
        }
        Ok(Original {
            id: id(&meta),
            file,
            path: path.to_owned(),
        })
    }

    fn same_file_still_there(path: &Path, expected: (u64, u64)) -> io::Result<()> {
        if id(&std::fs::symlink_metadata(path)?) == expected {
            Ok(())
        } else {
            Err(rejected("Datei wurde inzwischen ersetzt – nichts entfernt"))
        }
    }

    pub fn remove_original(original: Original) -> io::Result<()> {
        same_file_still_there(&original.path, original.id)?;
        // Entfernt das Original NACH geprüfter verschlüsselter Kopie – nur aus
        // `Vault::quarantine`, also nur mit ExecutionPermit („Ja, ausführen“).
        // aegis-mutation: quarantine-remove-original
        #[allow(clippy::disallowed_methods)]
        std::fs::remove_file(&original.path)
    }

    pub fn create_restored(path: &Path) -> io::Result<Restored> {
        parent_is_real(path)?;
        // Nur neu anlegen (create_new folgt keinem Link am Ziel) – nie überschreiben.
        // aegis-mutation: quarantine-restore-create
        #[allow(clippy::disallowed_methods)]
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)?;
        let meta = file.metadata()?;
        let restored = Restored {
            id: id(&meta),
            file,
            path: path.to_owned(),
        };
        same_file_still_there(path, restored.id)?;
        Ok(restored)
    }

    pub fn discard_restored(restored: Restored) -> io::Result<()> {
        same_file_still_there(&restored.path, restored.id)?;
        // Eigene, unvollständige Wiederherstellung verwerfen (gerade selbst angelegt).
        // aegis-mutation: quarantine-restore-discard
        #[allow(clippy::disallowed_methods)]
        std::fs::remove_file(&restored.path)
    }
}

pub(crate) use imp::{create_restored, discard_restored, open_original, remove_original};

/// Prüft nur, ob ein Ziel schon belegt ist (für eine verständliche Meldung vorab).
pub(crate) fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}
