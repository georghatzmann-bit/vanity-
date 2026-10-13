//! Kleine Hilfsfunktionen, die in mehreren Modulen gebraucht werden.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::error::{io_err, CmdResult};

/// Aktuelle Zeit in Millisekunden seit 1970 (UTC).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Änderungszeit einer Datei in Millisekunden (0, wenn unbekannt).
pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lokaler Zeitstempel für Dateinamen: `YYYYMMDD-HHMMSS`.
pub fn timestamp_name() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// `YYYYMMDD-HHMMSS` (lokale Zeit) zurück in Millisekunden umrechnen.
pub fn parse_timestamp_name(s: &str) -> Option<i64> {
    use chrono::{NaiveDateTime, TimeZone};
    let core = s.get(0..15)?;
    let naive = NaiveDateTime::parse_from_str(core, "%Y%m%d-%H%M%S").ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp_millis())
}

/// SHA-256 als Hex-Text.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Die ersten 8 Hex-Zeichen des SHA-256 eines Textes (für Cache-Dateinamen).
pub fn hash8(s: &str) -> String {
    sha256_hex(s.as_bytes())[..8].to_string()
}

/// Macht aus einer beliebigen ID einen sicheren Ordnernamen (kein `..`, keine Trennzeichen).
pub fn safe_segment(id: &str) -> String {
    let mut out: String = id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    while out.starts_with('.') {
        out.replace_range(0..1, "_");
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Prüft, ob eine ID nur aus erlaubten Zeichen besteht (für Dateinamen aus der Oberfläche).
pub fn is_plain_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('.')
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Nur Buchstaben/Ziffern, klein geschrieben – zum unscharfen Vergleichen von Namen.
pub fn normalize_name(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Dateinamen in einen lesbaren Anzeigenamen umwandeln (`Elden_Ring` → `Elden Ring`).
pub fn prettify_name(stem: &str) -> String {
    let replaced: String = stem
        .chars()
        .map(|c| if c == '_' { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        stem.trim().to_string()
    } else {
        collapsed
    }
}

/// Datei sicher schreiben: erst in eine temporäre Datei, dann umbenennen.
pub fn write_atomic(path: &Path, data: &[u8]) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(&e, parent))?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| io_err(&e, &tmp))?;
        f.write_all(data).map_err(|e| io_err(&e, &tmp))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(&e, path)
    })
}

/// Gesamtgröße eines Ordners in Bytes (rekursiv, Fehler werden ignoriert).
pub fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Entfernt `\\?\`-Präfixe, damit Pfade in der Oberfläche normal aussehen.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// Pfad aus der Oberfläche übernehmen (Leerzeichen und Anführungszeichen entfernen).
pub fn clean_path(s: &str) -> PathBuf {
    let t = s.trim().trim_matches('"').trim();
    PathBuf::from(t)
}

/// Umgebungsvariablen im Windows-Stil (`%NAME%`) ersetzen.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let name = &after[..end];
            match std::env::var(name) {
                Ok(v) if !name.is_empty() => out.push_str(&v),
                _ => {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// Heimatordner des Benutzers.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segment_blocks_traversal() {
        assert_eq!(safe_segment("../evil"), "_._evil");
        assert_eq!(safe_segment("a/b\\c"), "a_b_c");
        assert_eq!(safe_segment(""), "_");
        assert_eq!(safe_segment("game-123_x"), "game-123_x");
    }

    #[test]
    fn prettify_and_normalize() {
        assert_eq!(prettify_name("Elden_Ring__Nightreign"), "Elden Ring Nightreign");
        assert_eq!(normalize_name("The Witcher 3: Wild Hunt"), "thewitcher3wildhunt");
    }

    #[test]
    fn timestamp_roundtrip() {
        let name = timestamp_name();
        let ms = parse_timestamp_name(&name).expect("parse");
        assert!((now_ms() - ms).abs() < 5_000);
        assert!(parse_timestamp_name("kaputt").is_none());
    }

    #[test]
    fn plain_names() {
        assert!(is_plain_name("20240101-120000"));
        assert!(!is_plain_name("../x"));
        assert!(!is_plain_name("a/b"));
        assert!(!is_plain_name(""));
    }
}
