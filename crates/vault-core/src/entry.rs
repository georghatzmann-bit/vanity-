//! Einträge des Tresors.

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Grenzen je Feld (Zeichen).
pub const MAX_TITLE: usize = 200;
/// Benutzername.
pub const MAX_USERNAME: usize = 300;
/// Passwort.
pub const MAX_PASSWORD: usize = 1024;
/// Notizen.
pub const MAX_NOTES: usize = 20_000;
/// Adresse.
pub const MAX_URL: usize = 2048;
/// Anzahl Adressen bzw. Schlagwörter.
pub const MAX_LIST: usize = 20;

/// Ein Eintrag (Geheimnisse werden beim Verwerfen überschrieben).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// Kennung (UUID).
    pub id: String,
    /// Titel.
    pub title: String,
    /// Benutzername.
    pub username: String,
    /// Passwort.
    pub password: String,
    /// Adressen.
    pub urls: Vec<String>,
    /// Notizen.
    pub notes: String,
    /// Ordner (leer = keiner).
    pub folder: String,
    /// Schlagwörter.
    pub tags: Vec<String>,
    /// Favorit.
    pub favorite: bool,
    /// Angelegt (Unix-Sekunden).
    pub created: i64,
    /// Geändert (Unix-Sekunden).
    pub modified: i64,
    /// Passwort zuletzt geändert (Unix-Sekunden).
    pub password_changed: i64,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry")
            .field("id", &self.id)
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

/// Eingabe aus der Oberfläche (neu oder geändert).
#[derive(Clone, Default, PartialEq, Eq, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EntryInput {
    /// Titel.
    pub title: String,
    /// Benutzername.
    pub username: String,
    /// Passwort.
    pub password: String,
    /// Adressen.
    #[serde(default)]
    pub urls: Vec<String>,
    /// Notizen.
    #[serde(default)]
    pub notes: String,
    /// Ordner.
    #[serde(default)]
    pub folder: String,
    /// Schlagwörter.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Favorit.
    #[serde(default)]
    pub favorite: bool,
}

impl std::fmt::Debug for EntryInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EntryInput")
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

/// Richtungs-Steuerzeichen (könnten Titel optisch verfälschen).
fn bidi(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn clean(text: &str, max: usize, multiline: bool) -> String {
    text.chars()
        .filter(|c| !bidi(*c) && (!c.is_control() || (multiline && (*c == '\n' || *c == '\t'))))
        .take(max)
        .collect()
}

impl EntryInput {
    /// Bereinigt (Steuerzeichen, Längen, leere Listeneinträge) – Pflicht vor dem Übernehmen.
    ///
    /// # Errors
    /// Ohne Titel.
    pub fn validated(&self) -> Result<Self, String> {
        let title = clean(&self.title, MAX_TITLE, false).trim().to_owned();
        if title.is_empty() {
            return Err("Bitte einen Titel angeben.".into());
        }
        let list = |items: &[String], max: usize| -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for i in items {
                let v = clean(i, max, false).trim().to_owned();
                if !v.is_empty() && !out.contains(&v) && out.len() < MAX_LIST {
                    out.push(v);
                }
            }
            out
        };
        let urls = list(&self.urls, MAX_URL);
        // Nur Adressen, die beim Ausfüllen eindeutig zuzuordnen sind (http/https, echter Host).
        if let Some(bad) = urls.iter().find(|u| !crate::url::valid_stored(u)) {
            return Err(format!(
                "Diese Adresse kann AEGIS keiner Seite zuordnen: {bad} (z. B. https://bank.example)"
            ));
        }
        Ok(Self {
            title,
            username: clean(&self.username, MAX_USERNAME, false).trim().to_owned(),
            // Passwörter nicht trimmen – Leerzeichen können Absicht sein.
            password: clean(&self.password, MAX_PASSWORD, false),
            urls,
            notes: clean(&self.notes, MAX_NOTES, true),
            folder: clean(&self.folder, MAX_TITLE, false).trim().to_owned(),
            tags: list(&self.tags, 60),
            favorite: self.favorite,
        })
    }
}

/// Übersicht ohne Geheimnisse (für Listen und die Browser-Erweiterung).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    /// Kennung.
    pub id: String,
    /// Titel.
    pub title: String,
    /// Benutzername.
    pub username: String,
    /// Adressen.
    pub urls: Vec<String>,
    /// Ordner.
    pub folder: String,
    /// Schlagwörter.
    pub tags: Vec<String>,
    /// Favorit.
    pub favorite: bool,
    /// Geändert.
    pub modified: i64,
    /// Passwort zuletzt geändert.
    pub password_changed: i64,
    /// Hat Notizen?
    pub has_notes: bool,
    /// Hat ein Passwort?
    pub has_password: bool,
}

impl Entry {
    /// Übersicht ohne Passwort und Notizen.
    #[must_use]
    pub fn summary(&self) -> EntrySummary {
        EntrySummary {
            id: self.id.clone(),
            title: self.title.clone(),
            username: self.username.clone(),
            urls: self.urls.clone(),
            folder: self.folder.clone(),
            tags: self.tags.clone(),
            favorite: self.favorite,
            modified: self.modified,
            password_changed: self.password_changed,
            has_notes: !self.notes.is_empty(),
            has_password: !self.password.is_empty(),
        }
    }

    /// Passwort als `Zeroizing`-Kopie.
    #[must_use]
    pub fn secret(&self) -> Zeroizing<String> {
        Zeroizing::new(self.password.clone())
    }

    /// Passt der Suchbegriff (Titel, Benutzer, Adressen, Ordner, Schlagwörter; ohne Groß/Klein)?
    #[must_use]
    pub fn matches(&self, query: &str) -> bool {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return true;
        }
        [&self.title, &self.username, &self.folder]
            .iter()
            .any(|f| f.to_lowercase().contains(&q))
            || self.urls.iter().any(|u| u.to_lowercase().contains(&q))
            || self.tags.iter().any(|t| t.to_lowercase().contains(&q))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eingabe_wird_bereinigt() {
        let input = EntryInput {
            title: "  Bank \u{202e} \u{7} ".into(),
            username: "anna\n".into(),
            password: " geheim mit Leerzeichen ".into(),
            urls: vec![
                "https://bank.example".into(),
                String::new(),
                "https://bank.example".into(),
            ],
            notes: "Zeile 1\nZeile 2\u{0}".into(),
            folder: " Finanzen ".into(),
            tags: vec!["wichtig".into(); 30],
            favorite: true,
        };
        let v = input.validated().unwrap();
        assert_eq!(v.title, "Bank");
        assert_eq!(v.username, "anna");
        assert_eq!(v.password, " geheim mit Leerzeichen ");
        assert_eq!(v.urls, vec!["https://bank.example"]);
        assert_eq!(v.notes, "Zeile 1\nZeile 2");
        assert_eq!(v.folder, "Finanzen");
        assert_eq!(v.tags, vec!["wichtig"]);
        assert!(EntryInput::default().validated().is_err());
        let mut bad = v.clone();
        bad.urls = vec!["github.io".into()];
        assert!(bad.validated().is_err());
        bad.urls = vec!["javascript:alert(1)".into()];
        assert!(bad.validated().is_err());
        assert!(!format!("{v:?}").contains("geheim"));
    }
}
