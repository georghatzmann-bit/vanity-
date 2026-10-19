//! Passwort-Generator (Zufall aus dem System, gleichverteilt per Verwerfen).

use serde::Deserialize;
use zeroize::Zeroizing;

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!#$%&()*+,-./:;<=>?@[]^_{|}~";
/// Leicht verwechselbare Zeichen.
const AMBIGUOUS: &str = "Il1O0o|";

/// Einstellungen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Options {
    /// Länge (8–128).
    pub length: usize,
    /// Kleinbuchstaben.
    pub lower: bool,
    /// Großbuchstaben.
    pub upper: bool,
    /// Ziffern.
    pub digits: bool,
    /// Sonderzeichen.
    pub symbols: bool,
    /// Verwechselbare Zeichen meiden.
    pub avoid_ambiguous: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: true,
        }
    }
}

/// Gleichverteilte Zahl in `0..n` (n > 0).
fn uniform(n: usize) -> Option<usize> {
    let n32 = u32::try_from(n).ok()?;
    let limit = u32::MAX - (u32::MAX % n32);
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).ok()?;
        let v = u32::from_le_bytes(b);
        if v < limit {
            return usize::try_from(v % n32).ok();
        }
    }
}

/// Erzeugt ein Passwort; aus jeder gewählten Gruppe mindestens ein Zeichen.
///
/// # Errors
/// Keine Gruppe gewählt, Länge außerhalb 8–128, Zufallsquelle nicht verfügbar.
pub fn generate(options: &Options) -> Result<Zeroizing<String>, String> {
    if !(8..=128).contains(&options.length) {
        return Err("Länge 8 bis 128".into());
    }
    let groups: Vec<Vec<char>> = [
        (options.lower, LOWER),
        (options.upper, UPPER),
        (options.digits, DIGITS),
        (options.symbols, SYMBOLS),
    ]
    .iter()
    .filter(|(on, _)| *on)
    .map(|(_, set)| {
        set.chars()
            .filter(|c| !(options.avoid_ambiguous && AMBIGUOUS.contains(*c)))
            .collect()
    })
    .collect();
    if groups.is_empty() {
        return Err("Mindestens eine Zeichengruppe wählen".into());
    }
    let all: Vec<char> = groups.iter().flatten().copied().collect();
    let random = || "Zufallsquelle nicht verfügbar".to_owned();
    let mut chars: Zeroizing<Vec<char>> = Zeroizing::new(Vec::with_capacity(options.length));
    for g in &groups {
        chars.push(g[uniform(g.len()).ok_or_else(random)?]);
    }
    while chars.len() < options.length {
        chars.push(all[uniform(all.len()).ok_or_else(random)?]);
    }
    // Mischen (Fisher-Yates), damit die Pflichtzeichen nicht vorne stehen.
    for i in (1..chars.len()).rev() {
        let j = uniform(i + 1).ok_or_else(random)?;
        chars.swap(i, j);
    }
    Ok(Zeroizing::new(chars.iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erzeugt_wie_gewuenscht() {
        let p = generate(&Options::default()).unwrap();
        assert_eq!(p.chars().count(), 20);
        assert!(p.chars().any(|c| c.is_ascii_lowercase()));
        assert!(p.chars().any(|c| c.is_ascii_uppercase()));
        assert!(p.chars().any(|c| c.is_ascii_digit()));
        assert!(p.chars().any(|c| SYMBOLS.contains(c)));
        assert!(!p.chars().any(|c| AMBIGUOUS.contains(c)));
        let digits = generate(&Options {
            length: 8,
            lower: false,
            upper: false,
            digits: true,
            symbols: false,
            avoid_ambiguous: false,
        })
        .unwrap();
        assert!(digits.chars().all(|c| c.is_ascii_digit()));
        assert_ne!(generate(&Options::default()).unwrap(), p);
        assert!(
            generate(&Options {
                length: 4,
                ..Options::default()
            })
            .is_err()
        );
        assert!(
            generate(&Options {
                lower: false,
                upper: false,
                digits: false,
                symbols: false,
                ..Options::default()
            })
            .is_err()
        );
    }
}
