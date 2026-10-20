//! Durchläuft Ordner nur lesend und folgt nie Links oder Abzweigungen (Reparse-Punkte).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Eine gefundene Datei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileInfo {
    /// Pfad.
    pub path: PathBuf,
    /// Größe in Byte.
    pub size: u64,
    /// Letzte Änderung (Unix-Sekunden).
    pub modified: i64,
    /// Angelegt an diesem Ort (Unix-Sekunden; sonst wie `modified`).
    #[serde(skip)]
    pub created: i64,
}

/// Unix-Sekunden einer Zeit (0, wenn unbekannt).
#[must_use]
pub fn unix(time: std::io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Ist der Eintrag ein Link, eine Abzweigung oder eine Systemdatei? Dann wird er übergangen.
#[must_use]
pub fn skip(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // REPARSE_POINT (Abzweigung, Cloud-Platzhalter), SYSTEM oder ausgelagert (OFFLINE,
        // RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS – Lesen würde die Datei zurückholen).
        const REPARSE: u32 = 0x400;
        const SYSTEM: u32 = 0x4;
        const OFFLINE: u32 = 0x1000;
        const RECALL_ON_OPEN: u32 = 0x4_0000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
        if meta.file_attributes()
            & (REPARSE | SYSTEM | OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS)
            != 0
        {
            return true;
        }
    }
    false
}

/// Größe und Änderungszeit eines Pfads ohne Links zu folgen (`None`: fehlt, Link, Ordner).
#[must_use]
pub fn file_state(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    (meta.is_file() && !skip(&meta)).then(|| (meta.len(), unix(meta.modified())))
}

/// Grenzen eines Durchlaufs.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Tiefe (0 = nur der Ordner selbst).
    pub depth: usize,
    /// Höchstzahl Dateien.
    pub files: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            depth: 32,
            files: 200_000,
        }
    }
}

/// Namen, die sich nicht als Text darstellen lassen (Windows: einzelne Surrogate), fasst kein
/// Werkzeug an – Vorschau, Prüfsumme und Protokoll brauchen den genauen Namen.
fn readable(path: &Path) -> bool {
    path.to_str().is_some()
}

/// Alle Dateien unter `root` (ohne Links, Reparse-Punkte, Systemdateien).
#[must_use]
pub fn files(root: &Path, limits: Limits) -> Vec<FileInfo> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if skip(&meta) || !readable(&entry.path()) {
                continue;
            }
            if meta.is_dir() {
                if depth < limits.depth {
                    stack.push((entry.path(), depth + 1));
                }
            } else if meta.is_file() {
                let modified = unix(meta.modified());
                let created = unix(meta.created());
                out.push(FileInfo {
                    path: entry.path(),
                    size: meta.len(),
                    modified,
                    created: if created == 0 { modified } else { created },
                });
                if out.len() >= limits.files {
                    return out;
                }
            }
        }
    }
    out
}

/// Unterordner unter `root` (ohne Links), tiefste zuerst; höchstens `limits.files` Ordner.
#[must_use]
pub fn dirs_deepest_first(root: &Path, limits: Limits) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() && !skip(&meta) && readable(&entry.path()) && depth < limits.depth {
                out.push((entry.path(), depth + 1));
                stack.push((entry.path(), depth + 1));
                // Obergrenze auch für Ordner (sehr große Bäume).
                if out.len() >= limits.files {
                    stack.clear();
                    break;
                }
            }
        }
    }
    let mut out: Vec<(PathBuf, usize)> = out;
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.into_iter().map(|(p, _)| p).collect()
}
