//! Lesezeichen (nur `http`/`https`, begrenzte Länge und Anzahl).

use serde::{Deserialize, Serialize};
use url::Url;

/// Höchstzahl Lesezeichen.
pub const MAX_BOOKMARKS: usize = 1000;

/// Ein Lesezeichen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    /// Titel.
    pub title: String,
    /// Adresse.
    pub url: String,
}

impl Bookmark {
    /// Prüft und bereinigt ein Lesezeichen.
    ///
    /// # Errors
    /// Keine gültige Web-Adresse.
    pub fn new(title: &str, url: &str) -> Result<Self, String> {
        let parsed = Url::parse(url.trim()).map_err(|_| "Keine gültige Adresse.".to_owned())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.as_str().len() > 2048 {
            return Err("Nur Web-Adressen (http/https).".into());
        }
        let title: String = title
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        Ok(Self {
            title: if title.is_empty() {
                crate::address::display_host(&parsed)
            } else {
                title
            },
            url: parsed.to_string(),
        })
    }
}

/// Fügt hinzu (gleiche Adresse: ersetzt den Titel). Höchstens [`MAX_BOOKMARKS`].
///
/// # Errors
/// Zu viele Lesezeichen.
pub fn add(list: &mut Vec<Bookmark>, bookmark: Bookmark) -> Result<(), String> {
    if let Some(slot) = list.iter_mut().find(|b| b.url == bookmark.url) {
        *slot = bookmark;
        return Ok(());
    }
    if list.len() >= MAX_BOOKMARKS {
        return Err("Zu viele Lesezeichen.".into());
    }
    list.push(bookmark);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_webadressen() {
        assert!(Bookmark::new("x", "javascript:alert(1)").is_err());
        assert!(Bookmark::new("x", "file:///C:/").is_err());
        let b = Bookmark::new("  ", "https://www.example.org/a").unwrap();
        assert_eq!(b.title, "example.org");
        let mut list = Vec::new();
        add(&mut list, b.clone()).unwrap();
        add(&mut list, Bookmark::new("Neu", &b.url).unwrap()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Neu");
    }
}
