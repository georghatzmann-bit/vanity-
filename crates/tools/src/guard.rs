//! Orte, die kein Werkzeug anfasst: Windows, Programme, Systemdaten, Laufwerkswurzeln,
//! Papierkorb. Werkzeuge arbeiten nur in Ordnern, die der Nutzer gewählt hat.

use std::path::{Component, Path, PathBuf};

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// Geschützte Wurzeln dieses Systems.
#[must_use]
pub fn protected_roots() -> Vec<PathBuf> {
    [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ]
    .iter()
    .filter_map(|n| env_dir(n))
    .collect()
}

/// Darf ein Werkzeug unter `path` arbeiten?
#[must_use]
pub fn allowed(path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemorte_sind_tabu() {
        assert!(!allowed(Path::new("relativ/x")));
        assert!(!allowed(Path::new("/")));
        assert!(!allowed(Path::new("/home")));
        assert!(!allowed(Path::new("/home/a/../../etc")));
        assert!(!allowed(Path::new("C:\\Windows\\System32\\x")));
        assert!(allowed(Path::new("/home/anna/windows/projekt")));
        assert!(!allowed(Path::new("/d/$Recycle.Bin/S-1/x")));
        assert!(allowed(Path::new("/home/anna/Downloads")));
    }
}
