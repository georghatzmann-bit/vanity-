//! Orte, die kein Werkzeug anfasst: Windows, Programme, Systemdaten, Laufwerkswurzeln,
//! Papierkorb, Startmenü/Autostart, eigene Daten. Werkzeuge arbeiten nur in Ordnern, die der
//! Nutzer gewählt hat – und nie über Links oder Abzweigungen (Junctions) hinweg.

use std::path::{Component, Path, PathBuf, Prefix};

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// Geschützte Wurzeln dieses Systems und des Kontos.
#[must_use]
pub fn protected_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ]
    .iter()
    .filter_map(|n| env_dir(n))
    .collect();
    if let Some(local) = env_dir("LOCALAPPDATA") {
        // Programme je Konto, App-Aliase, eigene Daten.
        out.push(local.join("Programs"));
        out.push(local.join(r"Microsoft\WindowsApps"));
        out.push(local.join("app.aegissuite.desktop"));
    }
    if let Some(roaming) = env_dir("APPDATA") {
        // Startmenü und Autostart-Ordner, eigene Daten.
        out.push(roaming.join(r"Microsoft\Windows\Start Menu"));
        out.push(roaming.join("app.aegissuite.desktop"));
    }
    out
}

/// Nur ein gewöhnlicher Laufwerkspfad (`C:\…`) bzw. ein Unix-Pfad; keine Geräte-, Verbatim-
/// oder Netzwerkpfade (`\\?\`, `\\.\`, `\\server\share`).
fn plain_prefix(path: &Path) -> bool {
    match path.components().next() {
        Some(Component::Prefix(p)) => matches!(p.kind(), Prefix::Disk(_)),
        Some(Component::RootDir) => true,
        _ => false,
    }
}

/// Rein nach dem Text: Ort erlaubt?
fn lexically_allowed(path: &Path) -> bool {
    if !path.is_absolute()
        || !plain_prefix(path)
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return false;
    }
    // Laufwerkswurzel oder `/` allein: nie.
    let normal = path
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if normal < 2 {
        return false;
    }
    let p = lower(path);
    // Überall tabu: Papierkorb und Systemdaten der Laufwerke.
    if ["\\$recycle.bin", "\\system volume information"]
        .iter()
        .any(|s| p.contains(s))
    {
        return false;
    }
    // Direkt unter einer Laufwerkswurzel tabu (auch ohne Umgebungsvariablen).
    if [":\\windows", ":\\program files", ":\\programdata"]
        .iter()
        .any(|s| p.get(1..).is_some_and(|rest| rest.starts_with(s)))
    {
        return false;
    }
    !protected_roots().iter().any(|root| {
        let r = lower(root);
        !r.is_empty() && (p == r || p.starts_with(&format!("{r}\\")))
    })
}

/// Ist der Eintrag ein Link oder eine Abzweigung? (Windows: Reparse-Punkte mit
/// Namensersatz – symbolische Links und Junctions; Cloud-Platzhalter zählen nicht.)
#[must_use]
pub fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Kein vorhandener Teil des Pfads (vom Laufwerk bis zum Ziel) ist ein Link oder eine
/// Abzweigung. Fehlende Teile (noch anzulegende Zielordner) zählen nicht.
#[must_use]
pub fn link_free(path: &Path) -> bool {
    path.ancestors().all(|a| {
        a.as_os_str().is_empty() || std::fs::symlink_metadata(a).map_or(true, |m| !is_link(&m))
    })
}

/// Vorhandener Anfang des Pfads in Langform (8.3-Namen aufgelöst) samt Rest.
fn resolved(path: &Path) -> Option<PathBuf> {
    let existing = path
        .ancestors()
        .find(|a| std::fs::symlink_metadata(a).is_ok())?;
    let canonical = std::fs::canonicalize(existing).ok()?;
    let rest = path.strip_prefix(existing).ok()?;
    // Windows liefert `\\?\C:\…`; nur gewöhnliche Laufwerke (kein `\\?\UNC\…`).
    let text = canonical.to_string_lossy().into_owned();
    let plain = match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.to_ascii_uppercase().starts_with("UNC\\") => PathBuf::from(rest),
        Some(_) => return None,
        None => canonical,
    };
    Some(plain.join(rest))
}

/// Darf ein Werkzeug unter `path` arbeiten? Prüft den Text, dann den aufgelösten Ort (Kurz-
/// namen wie `PROGRA~1`) und dass kein vorhandener Teil ein Link oder eine Abzweigung ist.
#[must_use]
pub fn allowed(path: &Path) -> bool {
    lexically_allowed(path)
        && link_free(path)
        && resolved(path).is_some_and(|r| lexically_allowed(&r))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Ordner im Profil (je System ein absoluter Pfad).
    fn home(rest: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\anna").join(rest)
        } else {
            PathBuf::from("/home/anna").join(rest)
        }
    }

    #[test]
    fn systemorte_sind_tabu() {
        assert!(!allowed(Path::new("relativ/x")));
        assert!(!allowed(Path::new("/")));
        assert!(!allowed(Path::new("/home")));
        assert!(!allowed(Path::new("/home/a/../../etc")));
        assert!(!lexically_allowed(Path::new("C:\\Windows\\System32\\x")));
        assert!(lexically_allowed(&home("windows/projekt")));
        assert!(!lexically_allowed(Path::new("/d/$Recycle.Bin/S-1/x")));
        assert!(lexically_allowed(&home("Downloads")));
    }

    #[cfg(windows)]
    #[test]
    fn geraete_und_netzpfade_sind_tabu() {
        assert!(!lexically_allowed(Path::new(r"\\?\C:\Windows\System32\x")));
        assert!(!lexically_allowed(Path::new(r"\\.\C:\Users\anna\x")));
        assert!(!lexically_allowed(Path::new(
            r"\\localhost\C$\Users\anna\x"
        )));
        assert!(lexically_allowed(Path::new(r"C:\Users\anna\Downloads")));
    }
}
