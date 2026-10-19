//! Kleine JSON-Dateien des Dienstes im eigenen Datenordner (Vertrauensliste, Verlauf,
//! Einstellungen): lesen mit Größengrenze, schreiben atomar (Teil-Datei → umbenennen).

use std::io::{self, Read, Write};
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Höchstgröße einer Datei beim Lesen.
const MAX_FILE: u64 = 16 * 1024 * 1024;

/// Liest eine JSON-Datei; fehlt sie, `None`.
///
/// # Errors
/// Datei beschädigt oder nicht lesbar – der Dienst startet dann nicht (lieber sichtbar als
/// still mit leerem Zustand).
pub fn load<T: DeserializeOwned>(path: &Path, what: &str) -> io::Result<Option<T>> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut text = String::new();
            file.take(MAX_FILE).read_to_string(&mut text)?;
            serde_json::from_str(&text).map(Some).map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{what} {} beschädigt: {e}", path.display()),
                )
            })
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Schreibt `value` atomar nach `path`.
///
/// # Errors
/// Schreiben fehlgeschlagen (die alte Datei bleibt dann erhalten).
pub fn save<T: Serialize + ?Sized>(path: &Path, value: &T) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let part = path.with_extension("json.part");
    remove_part(&part)?;
    {
        let mut file = create_part(&part)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    commit(&part, path)
}

// ---------------------------------------------------------------------------------------
// Verändernde Aufrufe – nur eigene Dateien im Datenordner, jeweils markiert.
// ---------------------------------------------------------------------------------------

fn remove_part(path: &Path) -> io::Result<()> {
    // Eigene, liegengebliebene Teil-Datei im Datenordner entfernen.
    // aegis-mutation: service-store-remove-part
    #[allow(clippy::disallowed_methods)]
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn create_part(path: &Path) -> io::Result<std::fs::File> {
    // Neue Teil-Datei im eigenen Datenordner.
    // aegis-mutation: service-store-create-part
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    file
}

fn commit(from: &Path, to: &Path) -> io::Result<()> {
    // Eigene Datei im Datenordner atomar ersetzen.
    // aegis-mutation: service-store-commit
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(from, to)
}
