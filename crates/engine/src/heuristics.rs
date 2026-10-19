//! Heuristiken aus Dateiname, Ort und Herkunft – ohne den Inhalt zu deuten.

use std::path::Path;

use crate::finding::{Reason, Source, Weight};

/// Endungen, die Windows direkt ausführt.
const EXECUTABLE: [&str; 14] = [
    "exe", "scr", "com", "pif", "bat", "cmd", "js", "jse", "vbs", "vbe", "wsf", "hta", "ps1", "msi",
];
/// Endungen, die Nutzer für harmlose Dokumente halten.
const DOCUMENT: [&str; 12] = [
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "jpg", "jpeg", "png", "zip",
];

fn ext_of(name: &str) -> Option<String> {
    name.rsplit_once('.')
        .map(|(_, e)| e.trim().to_ascii_lowercase())
}

/// Ist die Endung direkt ausführbar?
#[must_use]
pub fn is_executable_name(name: &str) -> bool {
    ext_of(name).is_some_and(|e| EXECUTABLE.contains(&e.as_str()))
}

/// Unsichtbare oder richtungsändernde Zeichen (z. B. U+202E), mit denen Endungen getarnt werden.
#[must_use]
pub fn has_deceptive_chars(name: &str) -> bool {
    name.chars().any(|c| {
        matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}')
            || c.is_control()
    })
}

/// Begründungen aus dem Dateinamen und dem Ort.
#[must_use]
pub fn reasons(path: &Path) -> Vec<Reason> {
    let mut out = Vec::new();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let executable = is_executable_name(&name);

    if has_deceptive_chars(&name) {
        out.push(Reason::new(
            "name.deceptive_chars",
            Source::Heuristic,
            Weight::Score(45),
            "Der Dateiname enthält unsichtbare Steuerzeichen – damit werden Endungen getarnt.",
            "The file name contains invisible control characters – used to disguise extensions.",
        ));
    }
    if executable {
        let stem = name.rsplit_once('.').map_or("", |(s, _)| s);
        let inner = ext_of(stem.trim_end());
        if inner.as_deref().is_some_and(|e| DOCUMENT.contains(&e)) {
            out.push(Reason::new(
                "name.double_extension",
                Source::Heuristic,
                Weight::Score(40),
                "Doppelte Endung: Die Datei gibt sich als Dokument aus, ist aber ein Programm.",
                "Double extension: the file pretends to be a document but is a program.",
            ));
        }
        if stem.ends_with("   ") {
            out.push(Reason::new(
                "name.padding",
                Source::Heuristic,
                Weight::Score(25),
                "Viele Leerzeichen vor der Endung – damit wird die echte Endung versteckt.",
                "Many spaces before the extension – used to hide the real extension.",
            ));
        }
        if in_risky_location(path) {
            out.push(Reason::new(
                "location.temp_or_appdata",
                Source::Heuristic,
                Weight::Score(10),
                "Liegt in einem Temp- oder AppData-Ordner – dort legen sich auch Schadprogramme gern ab.",
                "Located in a Temp or AppData folder – malware likes to hide there too.",
            ));
        }
        if downloaded_from_internet(path) {
            out.push(Reason::new(
                "origin.internet",
                Source::Heuristic,
                Weight::Score(5),
                "Aus dem Internet heruntergeladen (Mark-of-the-Web).",
                "Downloaded from the internet (Mark-of-the-Web).",
            ));
        }
    }
    out
}

/// Liegt der Pfad unter Temp oder AppData?
#[must_use]
pub fn in_risky_location(path: &Path) -> bool {
    path.components().any(|c| {
        let part = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(part.as_str(), "temp" | "tmp" | "appdata")
    })
}

/// Mark-of-the-Web: Windows speichert die Herkunft im Datenstrom `Zone.Identifier`
/// (ZoneId 3 = Internet). Nur lesend; auf anderen Systemen immer `false`.
#[must_use]
pub fn downloaded_from_internet(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        std::fs::read_to_string(stream).is_ok_and(|text| zone_is_internet(&text))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// Wertet den Inhalt von `Zone.Identifier` aus (ZoneId 3 oder 4).
#[must_use]
pub fn zone_is_internet(text: &str) -> bool {
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("ZoneId="))
        .any(|z| matches!(z.trim(), "3" | "4"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(p: &str) -> Vec<String> {
        reasons(Path::new(p)).into_iter().map(|r| r.code).collect()
    }

    #[test]
    fn doppelte_endung_und_tarnung() {
        assert_eq!(codes("Rechnung.pdf.exe"), ["name.double_extension"]);
        assert_eq!(
            codes("Rechnung.pdf      .exe"),
            ["name.double_extension", "name.padding"]
        );
        assert!(codes("Rechnung_\u{202E}fdp.exe").contains(&"name.deceptive_chars".to_owned()));
        assert!(codes("notizen.txt").is_empty());
        assert!(codes("setup.exe").is_empty());
    }

    #[test]
    fn ort_und_herkunft() {
        assert_eq!(
            codes("/home/x/AppData/Local/Temp/a.exe"),
            ["location.temp_or_appdata"]
        );
        assert!(!in_risky_location(Path::new("/home/x/Downloads/a.exe")));
        assert!(zone_is_internet("[ZoneTransfer]\r\nZoneId=3\r\n"));
        assert!(!zone_is_internet("[ZoneTransfer]\nZoneId=1\n"));
        assert!(!downloaded_from_internet(Path::new("/gibt/es/nicht.exe")));
    }
}
