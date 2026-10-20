//! Wiederherstellungspunkte von Windows (Werkzeug 17): vorhandene Punkte lesen (WMI,
//! `root\default:SystemRestore`) und die Beschreibung eines neuen Punkts prüfen. Angelegt wird
//! ein Punkt nur über einen Plan des Dienstes nach „Ja“ (`Checkpoint-Computer`).

use serde::Serialize;

/// Ein vorhandener Wiederherstellungspunkt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    /// Laufende Nummer.
    pub sequence: u32,
    /// Beschreibung.
    pub description: String,
    /// Angelegt (`JJJJ-MM-TT hh:mm`, UTC).
    pub created: String,
    /// Art (Windows-Kennzahl, z. B. 0 = Programm installiert, 12 = Einstellungen geändert).
    pub kind: u32,
}

/// Längste Beschreibung (Windows erlaubt 64 Zeichen).
pub const MAX_DESCRIPTION: usize = 64;

/// Bereinigte Beschreibung eines neuen Punkts: nur Buchstaben, Ziffern, Leerzeichen und
/// `.,-_()`, höchstens 64 Zeichen. `None`, wenn nichts übrig bleibt.
#[must_use]
pub fn clean_description(text: &str) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || " .,-_()".contains(*c))
        .take(MAX_DESCRIPTION)
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    (!cleaned.is_empty()).then_some(cleaned)
}

/// WMI-Zeit (`20261020123456.000000-000`) als `2026-10-20 12:34`.
#[must_use]
pub fn wmi_time(text: &str) -> Option<String> {
    let digits = text.get(..12)?;
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{} {}:{}",
        digits.get(..4)?,
        digits.get(4..6)?,
        digits.get(6..8)?,
        digits.get(8..10)?,
        digits.get(10..12)?
    ))
}

/// Neueste zuerst, höchstens 64.
#[must_use]
pub fn newest_first(mut points: Vec<RestorePoint>) -> Vec<RestorePoint> {
    points.sort_by_key(|p| std::cmp::Reverse(p.sequence));
    points.truncate(64);
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beschreibung_wird_bereinigt() {
        assert_eq!(
            clean_description("  Vor AEGIS-Härtung (Okt.)  ").as_deref(),
            Some("Vor AEGIS-Härtung (Okt.)")
        );
        assert_eq!(
            clean_description("a'; Remove-Item C:\\ -Recurse; '").as_deref(),
            Some("a Remove-Item C -Recurse")
        );
        assert_eq!(clean_description("'\"`$;|&"), None);
        assert_eq!(
            clean_description(&"x".repeat(100)).map(|s| s.len()),
            Some(64)
        );
    }

    #[test]
    fn zeit_und_reihenfolge() {
        assert_eq!(
            wmi_time("20261020123456.000000-000").as_deref(),
            Some("2026-10-20 12:34")
        );
        assert_eq!(wmi_time("kaputt"), None);
        let p = |sequence| RestorePoint {
            sequence,
            description: String::new(),
            created: String::new(),
            kind: 12,
        };
        let sorted = newest_first(vec![p(1), p(3), p(2)]);
        assert_eq!(
            sorted.iter().map(|p| p.sequence).collect::<Vec<_>>(),
            [3, 2, 1]
        );
    }
}
