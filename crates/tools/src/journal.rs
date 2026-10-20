//! Protokoll der Werkzeug-Läufe (JSON im App-Datenordner) – Grundlage für „Rückgängig“.

use std::path::{Path, PathBuf};

use crate::exec::Run;

/// Höchstzahl gemerkter Läufe (älteste fallen weg).
pub const MAX_RUNS: usize = 300;
/// Größte Protokolldatei, die gelesen wird.
const MAX_FILE: u64 = 32 * 1024 * 1024;

/// Protokolldatei.
#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
}

impl Journal {
    /// Protokoll in `path`.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Alle Läufe (neueste zuletzt). Fehlt oder ist kaputt: leer.
    #[must_use]
    pub fn load(&self) -> Vec<Run> {
        let Ok(meta) = std::fs::symlink_metadata(&self.path) else {
            return Vec::new();
        };
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Vec::new();
        }
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Schreibt alle Läufe (Hilfsdatei, dann ersetzen).
    ///
    /// # Errors
    /// Nicht schreibbar.
    pub fn store(&self, runs: &[Run]) -> std::io::Result<()> {
        use std::io::Write;
        let start = runs.len().saturating_sub(MAX_RUNS);
        let body = serde_json::to_vec(runs.get(start..).unwrap_or_default())
            .map_err(std::io::Error::other)?;
        if let Some(dir) = self.path.parent() {
            // Eigener App-Datenordner.
            // aegis-mutation: tools-journal-dir
            #[allow(clippy::disallowed_methods)]
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            // Eigene Hilfsdatei des Protokolls.
            // aegis-mutation: tools-journal-write
            #[allow(clippy::disallowed_methods)]
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&body)?;
            file.sync_all()?;
        }
        // Ersetzt das eigene Protokoll.
        // aegis-mutation: tools-journal-replace
        #[allow(clippy::disallowed_methods)]
        std::fs::rename(&tmp, &self.path)
    }

    /// Hängt einen Lauf an.
    ///
    /// # Errors
    /// Nicht schreibbar.
    pub fn append(&self, run: Run) -> std::io::Result<()> {
        let mut runs = self.load();
        runs.push(run);
        self.store(&runs)
    }

    /// Ersetzt einen Lauf (nach „Rückgängig“).
    ///
    /// # Errors
    /// Nicht schreibbar oder unbekannt.
    pub fn replace(&self, run: &Run) -> std::io::Result<()> {
        let mut runs = self.load();
        let slot = runs
            .iter_mut()
            .find(|r| r.id == run.id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Lauf unbekannt"))?;
        *slot = run.clone();
        self.store(&runs)
    }

    /// Pfad (für Tests).
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}
