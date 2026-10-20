//! Protokoll der Werkzeug-Läufe (JSON im App-Datenordner) – Grundlage für „Rückgängig“.
//!
//! Lesen-Ändern-Schreiben läuft unter einer prozessweiten Sperre (Hintergrund-Überwachung und
//! Oberfläche schreiben parallel). Ist die Datei unlesbar, wird sie nie überschrieben, sondern
//! beiseitegelegt (`….broken-<Zeit>.json`), damit kein Rückgängig verloren geht.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::exec::Run;

/// Höchstzahl gemerkter Läufe (älteste fallen weg).
pub const MAX_RUNS: usize = 300;
/// Größte Protokolldatei, die gelesen wird.
const MAX_FILE: u64 = 32 * 1024 * 1024;

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Protokolldatei.
#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
}

/// Inhalt der Datei.
enum Loaded {
    /// Fehlt (noch kein Lauf).
    Missing,
    /// Gelesen.
    Runs(Vec<Run>),
    /// Vorhanden, aber unlesbar.
    Broken,
}

impl Journal {
    /// Protokoll in `path`.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read(&self) -> Loaded {
        let Ok(meta) = std::fs::symlink_metadata(&self.path) else {
            return Loaded::Missing;
        };
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Loaded::Broken;
        }
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .map_or(Loaded::Broken, Loaded::Runs)
    }

    /// Alle Läufe (neueste zuletzt). Fehlt oder ist kaputt: leer.
    #[must_use]
    pub fn load(&self) -> Vec<Run> {
        let _guard = lock();
        match self.read() {
            Loaded::Runs(runs) => runs,
            Loaded::Missing | Loaded::Broken => Vec::new(),
        }
    }

    /// Läufe zum Ändern; eine unlesbare Datei wird vorher beiseitegelegt.
    fn editable(&self) -> std::io::Result<Vec<Run>> {
        match self.read() {
            Loaded::Runs(runs) => Ok(runs),
            Loaded::Missing => Ok(Vec::new()),
            Loaded::Broken => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let aside = self.path.with_extension(format!("broken-{stamp}.json"));
                // Eigenes, unlesbares Protokoll beiseitelegen statt überschreiben.
                // aegis-mutation: tools-journal-aside
                #[allow(clippy::disallowed_methods)]
                std::fs::rename(&self.path, &aside)?;
                Ok(Vec::new())
            }
        }
    }

    /// Schreibt alle Läufe (eigene Hilfsdatei, dann ersetzen). Sperre hält der Aufrufer.
    fn store(&self, runs: &[Run]) -> std::io::Result<()> {
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
        let tmp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        {
            // Eigene Hilfsdatei des Protokolls (eindeutiger Name).
            // aegis-mutation: tools-journal-write
            #[allow(clippy::disallowed_methods)]
            let mut file = std::fs::File::create_new(&tmp)?;
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
        let _guard = lock();
        let mut runs = self.editable()?;
        runs.push(run);
        self.store(&runs)
    }

    /// Ersetzt einen Lauf (nach „Rückgängig“).
    ///
    /// # Errors
    /// Nicht schreibbar oder unbekannt.
    pub fn replace(&self, run: &Run) -> std::io::Result<()> {
        let _guard = lock();
        let mut runs = self.editable()?;
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
