//! Zielordner prüfen: Pfad normalisieren, freier Platz, Schreibrechte, Adminbedarf.

use crate::types::DiskInfo;
use crate::util::tr;
use std::path::{Path, PathBuf};

/// Windows-Pfad prüfen und normalisieren (reine Textverarbeitung, daher auch unter Linux testbar).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn normalize_windows_path(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_matches('"').trim().replace('/', "\\");
    if s.is_empty() {
        return Err(tr("Bitte einen Installationsordner wählen.", "Please choose an installation folder."));
    }
    let relative = || tr("Bitte einen vollständigen Pfad angeben (z. B. C:\\Spiele\\Nova).", "Please enter a full path (e.g. C:\\Games\\Nova).");
    let (prefix, rest) = if let Some(unc) = s.strip_prefix("\\\\") {
        // \\server\share\...
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        if server.is_empty() || share.is_empty() || server == "?" || server == "." {
            return Err(relative());
        }
        (format!("\\\\{server}\\{share}"), parts.next().unwrap_or_default().to_string())
    } else {
        let b = s.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return Err(relative());
        }
        (format!("{}:", (b[0] as char).to_ascii_uppercase()), s[3..].to_string())
    };
    let mut parts: Vec<String> = Vec::new();
    for comp in rest.split('\\') {
        match comp {
            "" | "." => continue,
            ".." => {
                parts.pop();
                continue;
            }
            _ => {}
        }
        if comp.chars().any(|c| (c as u32) < 32 || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
            return Err(format!("{}: {comp}", tr("Der Pfad enthält ungültige Zeichen", "The path contains invalid characters")));
        }
        if comp.ends_with(' ') || comp.ends_with('.') {
            return Err(format!("{}: \"{comp}\"", tr("Ungültiger Ordnername", "Invalid folder name")));
        }
        let stem = comp.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit()
                && stem.as_bytes()[3] != b'0');
        if reserved {
            return Err(format!("{}: {comp}", tr("Reservierter Name", "Reserved name")));
        }
        parts.push(comp.to_string());
    }
    let out = if parts.is_empty() { format!("{prefix}\\") } else { format!("{prefix}\\{}", parts.join("\\")) };
    if out.chars().count() > 200 {
        return Err(tr("Der Pfad ist zu lang.", "The path is too long."));
    }
    Ok(out)
}

/// Unix-Pfad prüfen und normalisieren (`~` wird aufgelöst).
#[cfg_attr(windows, allow(dead_code))]
pub fn normalize_unix_path(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_matches('"').trim();
    if s.is_empty() {
        return Err(tr("Bitte einen Installationsordner wählen.", "Please choose an installation folder."));
    }
    if s.contains('\0') {
        return Err(tr("Der Pfad enthält ungültige Zeichen.", "The path contains invalid characters."));
    }
    let expanded = if s == "~" || s.starts_with("~/") {
        match dirs::home_dir() {
            Some(home) => format!("{}{}", home.display(), &s[1..]),
            None => s.to_string(),
        }
    } else {
        s.to_string()
    };
    let p = Path::new(&expanded);
    if !p.is_absolute() {
        return Err(tr("Bitte einen vollständigen Pfad angeben.", "Please enter a full path."));
    }
    Ok(crate::util::lexical_normalize(p).to_string_lossy().into_owned())
}

/// Umgebungsvariablen wie `%LOCALAPPDATA%` auflösen (nur Windows sinnvoll).
fn expand_env_vars(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
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
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Plattformgerechte Normalisierung.
pub fn normalize_path(raw: &str) -> Result<PathBuf, String> {
    if cfg!(windows) {
        normalize_windows_path(&expand_env_vars(raw)).map(PathBuf::from)
    } else {
        normalize_unix_path(raw).map(PathBuf::from)
    }
}

/// Nächster existierender Ordner (der Pfad selbst oder ein übergeordneter).
pub fn nearest_existing_ancestor(p: &Path) -> Option<PathBuf> {
    let mut cur = Some(p);
    while let Some(c) = cur {
        if c.exists() {
            return Some(c.to_path_buf());
        }
        cur = c.parent();
    }
    None
}

/// Testet Schreibrechte durch Anlegen und Löschen einer Testdatei.
pub fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".nova-write-test-{}.tmp", crate::util::random_suffix()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(f) => {
            drop(f);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Liegt der Pfad unter `%ProgramFiles%` bzw. `%ProgramFiles(x86)%`?
pub fn is_under_program_files(p: &Path) -> bool {
    crate::platform::program_files_dirs().iter().any(|pf| crate::util::path_starts_with(p, pf))
}

/// Platzbedarf: Manifest-Größe × 1,1 plus Deinstaller (Kopie der Setup-Exe), sonst 40 MB.
pub fn required_bytes(manifest_size: Option<u64>) -> u64 {
    let setup = std::env::current_exe().ok().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    match manifest_size {
        Some(size) if size > 0 => size + size / 10 + setup.min(64 * 1024 * 1024),
        _ => crate::config::DEFAULT_REQUIRED_BYTES,
    }
}

/// Ergebnis von `disk_space(path)`.
pub fn disk_info(raw: &str, required: u64, elevated: bool) -> DiskInfo {
    let mut info = DiskInfo { path: raw.trim().to_string(), required, ..Default::default() };
    let path = match normalize_path(raw) {
        Ok(p) => p,
        Err(msg) => {
            info.message = Some(msg);
            return info;
        }
    };
    info.path = crate::util::display_path(&path);
    info.exists = path.exists();
    if info.exists && !path.is_dir() {
        info.message = Some(tr("Der Pfad ist eine Datei, kein Ordner.", "The path is a file, not a folder."));
        return info;
    }
    let Some(anchor) = nearest_existing_ancestor(&path) else {
        info.message = Some(tr("Das Laufwerk existiert nicht.", "The drive does not exist."));
        return info;
    };
    if !anchor.is_dir() {
        info.message = Some(tr("Ein Teil des Pfades ist eine Datei.", "Part of the path is a file."));
        return info;
    }
    if let Some((free, total)) = crate::platform::disk_free_total(&anchor) {
        info.free = free;
        info.total = total;
    }
    info.writable = probe_writable(&anchor);
    info.needs_admin = !info.writable || (is_under_program_files(&path) && !elevated);
    info.valid = true;
    if info.total > 0 && info.free < required {
        info.message = Some(tr("Nicht genug freier Speicherplatz.", "Not enough free disk space."));
    }
    info
}
