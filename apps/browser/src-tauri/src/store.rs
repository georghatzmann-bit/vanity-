//! Eigene Dateien des Browsers im App-Datenordner: Einstellungen, Lesezeichen, Filterlisten.
//! Schreiben über eine Hilfsdatei mit eindeutigem Namen, dann ersetzen.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Größte eigene JSON-Datei, die gelesen wird.
const MAX_JSON: u64 = 4 * 1024 * 1024;

/// Datenordner des Browsers.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Store in `dir`.
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Pfad einer eigenen Datei.
    #[must_use]
    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Liest eine eigene JSON-Datei (fehlt oder unlesbar: Standard).
    #[must_use]
    pub fn read_json<T: DeserializeOwned + Default>(&self, name: &str) -> T {
        read_limited(&self.path(name), MAX_JSON)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Liest eine eigene Textdatei (höchstens `max` Byte).
    #[must_use]
    pub fn read_text(&self, name: &str, max: usize) -> Option<String> {
        read_limited(&self.path(name), u64::try_from(max).unwrap_or(u64::MAX))
            .and_then(|b| String::from_utf8(b).ok())
    }

    /// Schreibt eine eigene JSON-Datei.
    ///
    /// # Errors
    /// Nicht schreibbar.
    pub fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        self.write(name, &body)
    }

    /// Schreibt eine eigene Datei (Hilfsdatei, dann ersetzen).
    ///
    /// # Errors
    /// Nicht schreibbar.
    pub fn write(&self, name: &str, body: &[u8]) -> Result<(), String> {
        use std::io::Write;
        // Eigener Datenordner des Browsers.
        // aegis-mutation: browser-store-dir
        #[allow(clippy::disallowed_methods)]
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let target = self.path(name);
        let tmp = self.path(&format!(
            "{name}.{}.tmp",
            std::process::id()
                ^ (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.subsec_nanos()))
        ));
        // Eigene Hilfsdatei (Einstellungen, Lesezeichen, Filterlisten).
        // aegis-mutation: browser-store-write
        #[allow(clippy::disallowed_methods)]
        let mut file = std::fs::File::create_new(&tmp).map_err(|e| e.to_string())?;
        let written = file.write_all(body).and_then(|()| file.sync_all());
        drop(file);
        // Ersetzt die eigene Datei durch die eben geschriebene Fassung.
        // aegis-mutation: browser-store-replace
        #[allow(clippy::disallowed_methods)]
        let result = written.and_then(|()| std::fs::rename(&tmp, &target));
        if result.is_err() {
            discard(&tmp);
        }
        result.map_err(|e| e.to_string())
    }
}

/// Entfernt die eigene, eben angelegte Hilfsdatei nach einem Fehler (keine Reste).
fn discard(tmp: &Path) {
    // Nur die eigene Hilfsdatei mit eindeutigem Namen, die dieser Aufruf angelegt hat.
    // aegis-mutation: browser-store-discard
    #[allow(clippy::disallowed_methods)]
    let _ = std::fs::remove_file(tmp);
}

fn read_limited(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    std::fs::read(path).ok()
}
