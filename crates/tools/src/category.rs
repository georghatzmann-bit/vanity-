//! Dateikategorien nach Endung (Downloads-Sortierer, Regeln).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Kategorie einer Datei.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// Bilder.
    Images,
    /// Dokumente (PDF, Office, Text).
    Documents,
    /// Archive und Abbilder.
    Archives,
    /// Programme und Installationspakete.
    Programs,
    /// Musik.
    Audio,
    /// Videos.
    Video,
    /// Quelltext und Daten.
    Code,
    /// Alles andere.
    Other,
}

/// Alle Kategorien in fester Reihenfolge.
pub const ALL: [Category; 8] = [
    Category::Images,
    Category::Documents,
    Category::Archives,
    Category::Programs,
    Category::Audio,
    Category::Video,
    Category::Code,
    Category::Other,
];

const IMAGES: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg", "ico", "raw",
    "cr2", "nef", "avif", "psd",
];
const DOCUMENTS: &[&str] = &[
    "pdf", "doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "odt", "ods",
    "odp", "rtf", "txt", "md", "epub", "csv",
];
const ARCHIVES: &[&str] = &[
    "zip", "7z", "rar", "tar", "gz", "bz2", "xz", "zst", "iso", "img", "cab",
];
const PROGRAMS: &[&str] = &[
    "exe",
    "msi",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "bat",
    "cmd",
    "ps1",
];
const AUDIO: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus"];
const VIDEO: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v", "mpg", "mpeg",
];
const CODE: &[&str] = &[
    "json", "xml", "yaml", "yml", "toml", "html", "css", "js", "ts", "py", "rs", "c", "cpp", "h",
    "java", "cs", "go", "sql", "sh",
];

/// Endung in Kleinbuchstaben (ohne Punkt).
#[must_use]
pub fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Kategorie nach Endung.
#[must_use]
pub fn category_of(path: &Path) -> Category {
    let ext = extension(path);
    let ext = ext.as_str();
    if IMAGES.contains(&ext) {
        Category::Images
    } else if DOCUMENTS.contains(&ext) {
        Category::Documents
    } else if ARCHIVES.contains(&ext) {
        Category::Archives
    } else if PROGRAMS.contains(&ext) {
        Category::Programs
    } else if AUDIO.contains(&ext) {
        Category::Audio
    } else if VIDEO.contains(&ext) {
        Category::Video
    } else if CODE.contains(&ext) {
        Category::Code
    } else {
        Category::Other
    }
}

/// Ordnername der Kategorie (Deutsch).
#[must_use]
pub fn folder_name(category: Category) -> &'static str {
    match category {
        Category::Images => "Bilder",
        Category::Documents => "Dokumente",
        Category::Archives => "Archive",
        Category::Programs => "Programme",
        Category::Audio => "Musik",
        Category::Video => "Videos",
        Category::Code => "Code",
        Category::Other => "Sonstiges",
    }
}

/// Noch nicht fertig geladen oder Hilfsdatei eines geöffneten Dokuments? Solche Dateien fasst
/// kein Werkzeug an.
#[must_use]
pub fn is_partial(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.starts_with("~$")
        || name.starts_with(".~lock")
        || [
            ".crdownload",
            ".part",
            ".partial",
            ".download",
            ".opdownload",
            ".tmp",
        ]
        .iter()
        .any(|s| name.ends_with(s))
        || name == "desktop.ini"
        || name == "thumbs.db"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kategorien_und_halbe_dateien() {
        assert_eq!(category_of(Path::new("Urlaub.JPG")), Category::Images);
        assert_eq!(category_of(Path::new("Rechnung.pdf")), Category::Documents);
        assert_eq!(category_of(Path::new("setup.exe")), Category::Programs);
        assert_eq!(category_of(Path::new("film.mkv")), Category::Video);
        assert_eq!(category_of(Path::new("ohne")), Category::Other);
        assert!(is_partial(Path::new("x.zip.crdownload")));
        assert!(is_partial(Path::new("~$Brief.docx")));
        assert!(is_partial(Path::new("desktop.ini")));
        assert!(!is_partial(Path::new("Brief.docx")));
        assert_eq!(folder_name(Category::Images), "Bilder");
    }
}
