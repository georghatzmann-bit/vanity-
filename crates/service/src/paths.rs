//! Einheitlicher Pfadvergleich für Kontotrennung (Wächter, Verlauf, Vertrauensliste):
//! unter Windows wie NTFS (`CompareStringOrdinal`, beide Trennzeichen, ohne abschließende
//! Trenner), sonst komponentenweise.

use std::path::{Path, PathBuf};

#[cfg(windows)]
fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.trim_end_matches('\\').to_owned()
}

/// Gleicher Pfad?
#[must_use]
pub fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        aegis_winffi::ordinal_eq_ignore_case(&normalized(a), &normalized(b))
    }
    #[cfg(not(windows))]
    {
        a.components().eq(b.components())
    }
}

/// Liegt `path` in `dir` (oder ist es)?
#[must_use]
pub fn is_within(path: &Path, dir: &Path) -> bool {
    #[cfg(windows)]
    {
        let p = normalized(path);
        let d = normalized(dir);
        let dl = d.encode_utf16().count();
        let units: Vec<u16> = p.encode_utf16().collect();
        if units.len() < dl {
            return false;
        }
        let head = String::from_utf16_lossy(&units[..dl]);
        aegis_winffi::ordinal_eq_ignore_case(&head, &d)
            && (units.len() == dl || units[dl] == u16::from(b'\\'))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(dir)
    }
}

/// Profilordner, zu dem `path` gehört: `<Wurzel>\<Name>`, wenn der Pfad unter einer der
/// Profil-Wurzeln liegt (auch für Profile, die erst nach dem Start entstanden sind).
#[must_use]
pub fn profile_of(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        if is_within(path, root) && !same_path(path, root) {
            // Erste Komponente unter der Wurzel (Groß-/Kleinschreibung darf abweichen).
            return path
                .components()
                .nth(root.components().count())
                .map(|name| root.join(name.as_os_str()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vergleiche() {
        assert!(same_path(Path::new("/u/a/"), Path::new("/u/a")));
        assert!(is_within(Path::new("/u/a/x"), Path::new("/u/a")));
        assert!(!is_within(Path::new("/u/ab/x"), Path::new("/u/a")));
        let roots = vec![PathBuf::from("/home")];
        assert_eq!(
            profile_of(Path::new("/home/neu/Downloads/x.exe"), &roots),
            Some(PathBuf::from("/home/neu"))
        );
        assert_eq!(profile_of(Path::new("/media/usb/x"), &roots), None);
        assert_eq!(profile_of(Path::new("/home"), &roots), None);
    }
}
