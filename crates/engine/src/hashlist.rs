//! Abgleich mit Hash-Listen (SHA-256), z. B. aus freien Bedrohungslisten.
//! Format: eine Zeile pro Eintrag `<sha256-hex> [Bezeichnung]`, `#` leitet Kommentare ein.

use std::collections::HashMap;

use crate::hash::from_hex;

/// Eine geladene Hash-Liste.
#[derive(Debug, Clone, Default)]
pub struct HashList {
    name: String,
    entries: HashMap<[u8; 32], String>,
    skipped_lines: usize,
}

impl HashList {
    /// Liest eine Liste aus Text; ungültige Zeilen werden gezählt, nicht übernommen.
    #[must_use]
    pub fn parse(name: impl Into<String>, text: &str) -> Self {
        let mut list = Self {
            name: name.into(),
            ..Self::default()
        };
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let (hex, label) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
            match from_hex(hex) {
                Some(hash) => {
                    list.entries.insert(hash, label.trim().to_owned());
                }
                None => list.skipped_lines += 1,
            }
        }
        list
    }

    /// Name der Liste (für Begründungen).
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Anzahl gültiger Einträge.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Ist die Liste leer?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Anzahl verworfener (ungültiger) Zeilen.
    #[must_use]
    pub fn skipped_lines(&self) -> usize {
        self.skipped_lines
    }

    /// Bezeichnung des Eintrags, falls der Hash enthalten ist.
    #[must_use]
    pub fn lookup(&self, hash: &[u8; 32]) -> Option<&str> {
        self.entries.get(hash).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parst_kommentare_und_fehler() {
        let h = "a".repeat(64);
        let text = format!(
            "# Kopf\n{h} Trojaner.Test  # Kommentar\n\nkaputt\n{} \n",
            "B".repeat(64)
        );
        let list = HashList::parse("probe", &text);
        assert_eq!(list.len(), 2);
        assert_eq!(list.skipped_lines(), 1);
        assert_eq!(list.lookup(&[0xaa; 32]), Some("Trojaner.Test"));
        assert_eq!(list.lookup(&[0xbb; 32]), Some(""));
        assert_eq!(list.lookup(&[0; 32]), None);
        assert_eq!(list.name(), "probe");
        assert!(!list.is_empty());
    }
}
