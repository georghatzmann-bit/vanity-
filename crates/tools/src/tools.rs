//! Die Werkzeuge 1, 2, 6–10: jeweils nur lesend eine Vorschau ([`Plan`]) bzw. ein Bericht.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::category::{Category, category_of, folder_name, is_partial};
use crate::guard::allowed;
use crate::plan::{Op, Plan, Tool};
use crate::rules::{Condition, Rule, host_matches, movable_files, origin_host};
use crate::walk::{FileInfo, Limits, dirs_deepest_first, files};

/// Neue Dateien erst nach dieser Ruhezeit anfassen (Sekunden).
pub const SETTLE: i64 = 60;

/// 1 Downloads-Sortierer: Dateien direkt im Ordner in Unterordner je Kategorie.
#[must_use]
pub fn sort_downloads(folder: &Path, categories: &[Category], now: i64) -> Plan {
    let mut ops = Vec::new();
    if allowed(folder) {
        for f in movable_files(folder, now, SETTLE) {
            let c = category_of(&f.path);
            if (categories.is_empty() || categories.contains(&c))
                && let Some(name) = f.path.file_name()
            {
                ops.push(Op::Move {
                    to: folder.join(folder_name(c)).join(name),
                    from: f.path.clone(),
                    size: f.size,
                    modified: f.modified,
                });
            }
        }
    }
    Plan::new(Tool::SortDownloads, ops, now)
}

/// Zuordnung Herkunft → Unterordner (Werkzeug 2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
pub struct SourceMapping {
    /// Host, z. B. `claude.ai` (auch Unteradressen).
    pub host: String,
    /// Unterordner, z. B. `Claude-Tools`.
    pub target: String,
}

/// 2 Quellen-Ordner: Dateien nach Herkunft (Mark-of-the-Web) in Unterordner.
#[must_use]
pub fn source_folders(folder: &Path, mappings: &[SourceMapping], now: i64) -> Plan {
    let mut ops = Vec::new();
    let valid: Vec<&SourceMapping> = mappings
        .iter()
        .filter(|m| !m.host.is_empty() && crate::rules::valid_folder_name(&m.target))
        .collect();
    if allowed(folder) && !valid.is_empty() {
        for f in movable_files(folder, now, SETTLE) {
            let Some(origin) = origin_host(&f.path) else {
                continue;
            };
            if let Some(m) = valid.iter().find(|m| host_matches(&origin, &m.host))
                && let Some(name) = f.path.file_name()
            {
                ops.push(Op::Move {
                    to: folder.join(&m.target).join(name),
                    from: f.path.clone(),
                    size: f.size,
                    modified: f.modified,
                });
            }
        }
    }
    Plan::new(Tool::SourceFolders, ops, now)
}

/// Regel-Vorlage für Werkzeug 2 (der Nutzer legt sie an und schaltet sie ein).
#[must_use]
pub fn source_rule(folder: &Path, mapping: &SourceMapping) -> Rule {
    Rule {
        id: String::new(),
        name: format!("Von {} → {}", mapping.host, mapping.target),
        enabled: false,
        watch: false,
        folder: folder.to_path_buf(),
        condition: Condition {
            source_host: mapping.host.clone(),
            ..Condition::default()
        },
        target: mapping.target.clone(),
        watch_since: None,
    }
}

/// Eine Gruppe gleicher Dateien.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DuplicateGroup {
    /// Größe je Datei.
    pub size: u64,
    /// Prüfsumme (SHA-256).
    pub hash: String,
    /// Dateien; die erste bleibt (älteste).
    pub files: Vec<FileInfo>,
}

fn hash_file(path: &Path, limit: u64) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file.take(limit));
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        sha2::Digest::update(&mut hasher, buffer.get(..n)?);
    }
    Some(
        sha2::Digest::finalize(hasher)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// Wer eine Datei wirklich ist: aufgelöster Pfad (Groß/klein, Kurznamen, Links), unter
/// Windows ohne Unterschied der Schreibweise. Zwei Pfade derselben Datei sind kein Duplikat.
fn identity(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let text = canonical.to_string_lossy().into_owned();
    Some(if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    })
}

/// Wurzeln ohne Doppelte und ohne Ordner, die schon in einer anderen Wurzel liegen.
fn distinct_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut resolved: Vec<(PathBuf, PathBuf)> = roots
        .iter()
        .filter(|r| allowed(r))
        .filter_map(|r| std::fs::canonicalize(r).ok().map(|c| (r.clone(), c)))
        .collect();
    resolved.sort_by_key(|(_, c)| c.as_os_str().len());
    let mut kept: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (root, canonical) in resolved {
        let inside = kept.iter().any(|(_, k)| {
            let (k, c) = (identity(k), identity(&canonical));
            k.zip(c).is_some_and(|(k, c)| {
                c == k || c.starts_with(&format!("{k}{}", std::path::MAIN_SEPARATOR))
            })
        });
        if !inside {
            kept.push((root, canonical));
        }
    }
    kept.into_iter().map(|(r, _)| r).collect()
}

/// 6 Duplikat-Finder: gleiche Größe, dann gleicher Inhalt. Behalten wird die älteste Datei
/// (bei Gleichstand der kürzere Pfad); die übrigen gehen in den Papierkorb. Dieselbe Datei
/// unter zwei Pfaden (verschachtelte Ordner, Schreibweise, Links) zählt nur einmal.
#[must_use]
pub fn duplicates(roots: &[PathBuf], min_size: u64, now: i64) -> (Vec<DuplicateGroup>, Plan) {
    let mut by_size: HashMap<u64, Vec<FileInfo>> = HashMap::new();
    for root in distinct_roots(roots) {
        for f in files(&root, Limits::default()) {
            if f.size >= min_size.max(1) && !is_partial(&f.path) {
                by_size.entry(f.size).or_default().push(f);
            }
        }
    }
    let mut groups = Vec::new();
    for (size, candidates) in by_size.into_iter().filter(|(_, v)| v.len() > 1) {
        let mut by_hash: HashMap<String, Vec<FileInfo>> = HashMap::new();
        let mut seen = std::collections::HashSet::new();
        for f in candidates {
            // Ohne feste Identität kein Kandidat; jede Datei nur einmal.
            let Some(id) = identity(&f.path) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            if let Some(h) = hash_file(&f.path, size) {
                by_hash.entry(h).or_default().push(f);
            }
        }
        for (hash, mut same) in by_hash.into_iter().filter(|(_, v)| v.len() > 1) {
            same.sort_by(|a, b| {
                a.modified
                    .cmp(&b.modified)
                    .then_with(|| a.path.as_os_str().len().cmp(&b.path.as_os_str().len()))
                    .then_with(|| a.path.cmp(&b.path))
            });
            groups.push(DuplicateGroup {
                size,
                hash,
                files: same,
            });
        }
    }
    groups.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.hash.cmp(&b.hash)));
    let ops = groups
        .iter()
        .flat_map(|g| g.files.iter().skip(1))
        .map(|f| Op::Recycle {
            path: f.path.clone(),
            size: f.size,
            modified: f.modified,
        })
        .collect();
    (groups, Plan::new(Tool::Duplicates, ops, now))
}

/// Größe eines Unterordners.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderSize {
    /// Ordner.
    pub path: PathBuf,
    /// Byte.
    pub size: u64,
    /// Dateien.
    pub files: u64,
}

/// 7 Speicherplatz-Analyse eines Ordners (nur lesend).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    /// Gesamtgröße.
    pub total: u64,
    /// Dateien.
    pub files: u64,
    /// Unterordner (größte zuerst) samt „Dateien direkt im Ordner“ als der Ordner selbst.
    pub children: Vec<FolderSize>,
    /// Größte Dateien.
    pub largest: Vec<FileInfo>,
    /// Größe je Kategorie.
    pub by_category: Vec<(Category, u64)>,
    /// Freier Platz und Größe des Laufwerks (falls bekannt).
    pub disk: Option<(u64, u64)>,
}

/// Analysiert `root`.
#[must_use]
pub fn space(root: &Path, disk: Option<(u64, u64)>) -> Space {
    let all = files(root, Limits::default());
    let mut children: HashMap<PathBuf, FolderSize> = HashMap::new();
    let mut by_category: HashMap<Category, u64> = HashMap::new();
    for f in &all {
        let child = f
            .path
            .strip_prefix(root)
            .ok()
            .and_then(|rel| {
                let mut parts = rel.components();
                let first = parts.next()?;
                parts.next().map(|_| root.join(first))
            })
            .unwrap_or_else(|| root.to_path_buf());
        let entry = children.entry(child.clone()).or_insert(FolderSize {
            path: child,
            size: 0,
            files: 0,
        });
        entry.size += f.size;
        entry.files += 1;
        *by_category.entry(category_of(&f.path)).or_default() += f.size;
    }
    let mut children: Vec<FolderSize> = children.into_values().collect();
    children.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    let mut largest = all.clone();
    largest.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    largest.truncate(50);
    let mut by_category: Vec<(Category, u64)> = by_category.into_iter().collect();
    by_category.sort_by_key(|c| std::cmp::Reverse(c.1));
    Space {
        total: all.iter().map(|f| f.size).sum(),
        files: u64::try_from(all.len()).unwrap_or(u64::MAX),
        children,
        largest,
        by_category,
        disk,
    }
}

/// 8 Große & alte Dateien: mindestens `min_size` Byte und seit `days` Tagen unverändert.
#[must_use]
pub fn large_old(roots: &[PathBuf], min_size: u64, days: u32, now: i64) -> Plan {
    let limit = now - i64::from(days) * 86_400;
    let mut found: Vec<FileInfo> = roots
        .iter()
        .filter(|r| allowed(r))
        .flat_map(|r| files(r, Limits::default()))
        .filter(|f| f.size >= min_size && f.modified <= limit && !is_partial(&f.path))
        .collect();
    found.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    found.truncate(2000);
    let ops = found
        .into_iter()
        .map(|f| Op::Recycle {
            path: f.path,
            size: f.size,
            modified: f.modified,
        })
        .collect();
    Plan::new(Tool::LargeOld, ops, now)
}

/// 9 Leere Ordner unter `root` (tiefste zuerst; ein Ordner mit nur leeren Ordnern ist auch
/// leer). `root` selbst bleibt.
#[must_use]
pub fn empty_folders(root: &Path, now: i64) -> Plan {
    let mut empty: Vec<PathBuf> = Vec::new();
    let mut known = std::collections::HashSet::new();
    if allowed(root) {
        for dir in dirs_deepest_first(
            root,
            Limits {
                depth: 32,
                files: 100_000,
            },
        ) {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let only_empty_dirs = entries.flatten().all(|e| known.contains(&e.path()));
            if only_empty_dirs {
                known.insert(dir.clone());
                empty.push(dir);
            }
        }
    }
    let ops = empty
        .into_iter()
        .map(|path| Op::RemoveEmptyDir { path })
        .collect();
    Plan::new(Tool::EmptyFolders, ops, now)
}

/// Sichere Orte für den Cleaner (nur Dinge, die Windows und Programme neu erzeugen).
#[must_use]
pub fn cleaner_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(temp) = std::env::var_os("TEMP").map(PathBuf::from) {
        out.push(temp);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        out.push(local.join("CrashDumps"));
        out.push(local.join(r"Microsoft\Windows\WER\ReportArchive"));
        out.push(local.join(r"Microsoft\Windows\WER\ReportQueue"));
    }
    out
}

/// 10 Cleaner: Dateien an sicheren Orten, älter als `days` Tage, in den Papierkorb.
#[must_use]
pub fn cleaner(locations: &[PathBuf], days: u32, now: i64) -> Plan {
    let limit = now - i64::from(days.max(1)) * 86_400;
    let ops = locations
        .iter()
        .filter(|l| allowed(l))
        .flat_map(|l| {
            files(
                l,
                Limits {
                    depth: 8,
                    files: 20_000,
                },
            )
        })
        .filter(|f| f.modified <= limit)
        .map(|f| Op::Recycle {
            path: f.path,
            size: f.size,
            modified: f.modified,
        })
        .collect();
    Plan::new(Tool::Cleaner, ops, now)
}
