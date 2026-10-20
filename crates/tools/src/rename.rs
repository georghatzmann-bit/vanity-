//! Batch-Umbenenner (Werkzeug 15): neue Namen nach Muster, nur im selben Ordner, nie
//! überschreibend; die Vorschau zeigt jeden alten und neuen Namen.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

use crate::guard::allowed;
use crate::plan::{Op, Plan, Tool};
use crate::rules::valid_folder_name;
use crate::walk::{Limits, files};

/// Groß-/Kleinschreibung.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Case {
    /// Unverändert.
    #[default]
    Keep,
    /// klein.
    Lower,
    /// GROSS.
    Upper,
}

/// Einstellungen.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    /// Muster für den Namen ohne Endung: `{name}`, `{n}` (Nummer), `{date}` (JJJJ-MM-TT der
    /// Änderung). Leer = `{name}`.
    pub pattern: String,
    /// Suchen …
    pub find: String,
    /// … und ersetzen.
    pub replace: String,
    /// Erste Nummer.
    pub start: u32,
    /// Stellen der Nummer (mit Nullen aufgefüllt).
    pub digits: u8,
    /// Schreibweise.
    pub case: Case,
    /// Nur Dateien mit diesen Endungen (leer = alle).
    pub extensions: Vec<String>,
}

fn date(unix: i64) -> String {
    // Tage seit 1970 → Datum (proleptischer Gregorianischer Kalender, UTC).
    let days = unix.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Neuer Name (ohne Prüfung auf Kollision).
#[must_use]
pub fn new_name(stem: &str, ext: &str, number: u32, modified: i64, options: &Options) -> String {
    let pattern = if options.pattern.trim().is_empty() {
        "{name}"
    } else {
        options.pattern.as_str()
    };
    let width = usize::from(options.digits.min(8));
    let mut base = pattern
        .replace("{name}", stem)
        .replace("{n}", &format!("{number:0width$}"))
        .replace("{date}", &date(modified));
    if !options.find.is_empty() {
        base = base.replace(&options.find, &options.replace);
    }
    base = match options.case {
        Case::Keep => base,
        Case::Lower => base.to_lowercase(),
        Case::Upper => base.to_uppercase(),
    };
    let base = base.trim().to_owned();
    if ext.is_empty() {
        base
    } else {
        format!("{base}.{ext}")
    }
}

/// Vorschau: Dateien direkt im Ordner, nach Name sortiert, nummeriert ab `start`.
#[must_use]
pub fn plan(folder: &Path, options: &Options, now: i64) -> Plan {
    let mut ops = Vec::new();
    if allowed(folder) {
        let mut list = files(
            folder,
            Limits {
                depth: 0,
                files: 10_000,
            },
        );
        list.sort_by(|a, b| a.path.cmp(&b.path));
        let wanted: Vec<String> = options
            .extensions
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        let existing: HashSet<String> = list
            .iter()
            .filter_map(|f| f.path.file_name())
            .map(|n| n.to_string_lossy().to_lowercase())
            .collect();
        let mut taken: HashSet<String> = HashSet::new();
        let mut number = options.start;
        for f in list {
            let ext = crate::category::extension(&f.path);
            if !wanted.is_empty() && !wanted.contains(&ext) {
                continue;
            }
            let Some(stem) = f.path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            let original_ext = f
                .path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = new_name(&stem, &original_ext, number, f.modified, options);
            number = number.saturating_add(1);
            let old = f
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let key = name.to_lowercase();
            // Gleich, ungültig, schon vergeben oder ein anderer vorhandener Name: übergehen.
            if name == old
                || !valid_folder_name(&name)
                || taken.contains(&key)
                || (existing.contains(&key) && key != old.to_lowercase())
            {
                continue;
            }
            taken.insert(key);
            ops.push(Op::Move {
                to: folder.join(&name),
                from: f.path.clone(),
                size: f.size,
                modified: f.modified,
            });
        }
    }
    Plan::new(Tool::Rename, ops, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muster_und_datum() {
        let o = Options {
            pattern: "Urlaub {n} {date}".into(),
            start: 1,
            digits: 3,
            ..Options::default()
        };
        assert_eq!(
            new_name("IMG_1", "JPG", 7, 0, &o),
            "Urlaub 007 1970-01-01.JPG"
        );
        assert_eq!(date(1_760_918_400), "2025-10-20");
        let o = Options {
            find: "_".into(),
            replace: " ".into(),
            case: Case::Lower,
            ..Options::default()
        };
        assert_eq!(new_name("Mein_Bild", "PNG", 1, 0, &o), "mein bild.PNG");
    }
}
