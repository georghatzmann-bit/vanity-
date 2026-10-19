//! Stärke-Schätzung (einfach und ehrlich: Zeichenvorrat × Länge, Abzüge für Muster und
//! bekannte Passwörter) und Wiederverwendung.

use std::collections::HashMap;

use serde::Serialize;

use crate::entry::Entry;

/// Häufige Passwörter und Bestandteile (eigene Auswahl; der Leck-Check prüft gründlicher).
const COMMON: &[&str] = &[
    "password",
    "passwort",
    "123456",
    "12345678",
    "123456789",
    "qwerty",
    "qwertz",
    "abc123",
    "111111",
    "iloveyou",
    "admin",
    "welcome",
    "willkommen",
    "hallo",
    "monkey",
    "dragon",
    "letmein",
    "football",
    "fussball",
    "sommer",
    "winter",
    "geheim",
    "master",
    "login",
    "schalke",
    "bayern",
    "borussia",
    "ficken",
    "123123",
    "000000",
    "654321",
    "asdf",
];

/// Ergebnis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Sehr schwach.
    VeryWeak,
    /// Schwach.
    Weak,
    /// Mittel.
    Fair,
    /// Stark.
    Strong,
    /// Sehr stark.
    VeryStrong,
}

/// Geschätzte Stärke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Strength {
    /// Stufe.
    pub level: Level,
    /// Geschätzte Bits.
    pub bits: u32,
}

fn pool(password: &str) -> u32 {
    let mut pool = 0;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        pool += 10;
    }
    if password
        .chars()
        .any(|c| c.is_ascii_punctuation() || c == ' ')
    {
        pool += 33;
    }
    if !password.is_ascii() {
        pool += 64;
    }
    pool.max(1)
}

/// Schätzt die Stärke.
#[must_use]
pub fn estimate(password: &str) -> Strength {
    let chars: Vec<char> = password.chars().collect();
    if chars.is_empty() {
        return Strength {
            level: Level::VeryWeak,
            bits: 0,
        };
    }
    // Effektive Länge: Wiederholungen und Folgen („aaaa“, „1234“, „abcd“) zählen kaum.
    let mut effective = 1.0_f64;
    for w in chars.windows(2) {
        let (a, b) = (u32::from(w[0]), u32::from(w[1]));
        effective += if a == b || a + 1 == b || b + 1 == a {
            0.25
        } else {
            1.0
        };
    }
    let lower = password.to_lowercase();
    let deconfused: String = lower
        .chars()
        .map(|c| match c {
            '0' => 'o',
            '1' | '!' => 'i',
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '7' => 't',
            _ => c,
        })
        .collect();
    for word in COMMON {
        if lower.contains(word) || deconfused.contains(word) {
            effective -= (word.chars().count() as f64 - 1.0).max(0.0);
        }
    }
    let bits_f = effective.max(1.0) * f64::from(pool(password)).log2();
    let bits = bits_f.clamp(0.0, 512.0) as u32;
    let level = match bits {
        0..28 => Level::VeryWeak,
        28..36 => Level::Weak,
        36..60 => Level::Fair,
        60..80 => Level::Strong,
        _ => Level::VeryStrong,
    };
    Strength { level, bits }
}

/// Kennungen der Einträge, deren Passwort auch in einem anderen Eintrag vorkommt.
#[must_use]
pub fn reused(entries: &[Entry]) -> Vec<String> {
    let mut by: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in entries.iter().filter(|e| !e.password.is_empty()) {
        by.entry(e.password.as_str())
            .or_default()
            .push(e.id.as_str());
    }
    let mut out: Vec<String> = by
        .values()
        .filter(|ids| ids.len() > 1)
        .flatten()
        .map(|s| (*s).to_owned())
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staerke() {
        assert_eq!(estimate("").level, Level::VeryWeak);
        assert_eq!(estimate("123456").level, Level::VeryWeak);
        assert_eq!(estimate("Passw0rt!").level, Level::VeryWeak);
        assert!(matches!(
            estimate("aaaaaaaaaaaa").level,
            Level::VeryWeak | Level::Weak
        ));
        assert_eq!(estimate("k7#Qm2!vXp9&Lr4z").level, Level::VeryStrong);
        assert!(estimate("korrekt pferd batterie heftklammer").bits > 80);
    }
}
