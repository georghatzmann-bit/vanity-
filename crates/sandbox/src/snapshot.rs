//! Vorher/Nachher-Vergleich eines Ordners (nur lesend): Welche Dateien hat die Probe angelegt,
//! geändert oder gelöscht? Folgt keinen Links und begrenzt Anzahl und Tiefe.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::report::{Change, FileChange, MAX_ITEMS};

/// Höchstzahl erfasster Einträge.
pub const MAX_ENTRIES: usize = 200_000;
/// Höchste Ordnertiefe.
pub const MAX_DEPTH: usize = 32;

/// Zustand einer Datei.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileState {
    /// Größe.
    pub size: u64,
    /// Änderungszeit.
    pub modified: Option<SystemTime>,
}

/// Momentaufnahme eines Ordners.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DirSnapshot {
    /// Dateien (Pfad → Zustand).
    pub files: BTreeMap<PathBuf, FileState>,
    /// Wurde wegen der Grenzen abgebrochen?
    pub truncated: bool,
}

impl DirSnapshot {
    /// Nimmt den Zustand von `root` auf (Links werden nicht verfolgt).
    #[must_use]
    pub fn capture(root: &Path) -> Self {
        let mut snap = Self::default();
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if snap.files.len() >= MAX_ENTRIES {
                    snap.truncated = true;
                    return snap;
                }
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                let ft = meta.file_type();
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() {
                    if depth + 1 < MAX_DEPTH {
                        stack.push((entry.path(), depth + 1));
                    } else {
                        snap.truncated = true;
                    }
                } else if ft.is_file() {
                    snap.files.insert(
                        entry.path(),
                        FileState {
                            size: meta.len(),
                            modified: meta.modified().ok(),
                        },
                    );
                }
            }
        }
        snap
    }

    /// Unterschiede zu einer späteren Aufnahme; neue/geänderte Dateien mit Entropie.
    #[must_use]
    pub fn diff(&self, after: &Self) -> Vec<FileChange> {
        let mut out = Vec::new();
        for (path, state) in &after.files {
            let change = match self.files.get(path) {
                None => Change::Created,
                Some(old) if old != state => Change::Modified,
                Some(_) => continue,
            };
            out.push(FileChange {
                path: path.to_string_lossy().into_owned(),
                change,
                size: state.size,
                entropy: crate::entropy::of_file(path).ok(),
            });
            if out.len() >= MAX_ITEMS {
                return out;
            }
        }
        for path in self.files.keys() {
            if !after.files.contains_key(path) {
                out.push(FileChange {
                    path: path.to_string_lossy().into_owned(),
                    change: Change::Deleted,
                    size: 0,
                    entropy: None,
                });
                if out.len() >= MAX_ITEMS {
                    break;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aegis_core::testing::{remove_fixture, write_fixture};

    #[test]
    fn angelegt_geaendert_geloescht_mit_entropie() {
        let dir = tempfile::tempdir().unwrap();
        write_fixture(dir.path(), "bleibt.txt", b"gleich").unwrap();
        write_fixture(dir.path(), "aendern.txt", b"alt").unwrap();
        write_fixture(dir.path(), "weg.txt", b"weg").unwrap();
        let before = DirSnapshot::capture(dir.path());
        write_fixture(dir.path(), "aendern.txt", b"neu und laenger").unwrap();
        remove_fixture(dir.path(), "weg.txt").unwrap();
        let random: Vec<u8> = (0..=255u8).cycle().take(8192).collect();
        write_fixture(dir.path(), "sub/neu.bin", &random).unwrap();
        let after = DirSnapshot::capture(dir.path());
        let changes = before.diff(&after);
        let find = |name: &str| {
            changes
                .iter()
                .find(|c| c.path.ends_with(name))
                .unwrap_or_else(|| panic!("{name} fehlt: {changes:?}"))
        };
        assert_eq!(find("aendern.txt").change, Change::Modified);
        assert_eq!(find("weg.txt").change, Change::Deleted);
        let new = find("neu.bin");
        assert_eq!(new.change, Change::Created);
        assert!(new.entropy.unwrap() > 7.9);
        assert!(!changes.iter().any(|c| c.path.ends_with("bleibt.txt")));
        assert_eq!(changes.len(), 3);
    }
}
