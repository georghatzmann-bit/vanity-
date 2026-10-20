//! Adresszeile: Was der Nutzer tippt, wird entweder eine Web-Adresse (nur `http`/`https`,
//! mit HTTPS-only auf `https` angehoben) oder eine Suche bei der gewählten Suchmaschine.
//! Andere Schemata (`javascript:`, `file:`, `data:` …) werden nie geöffnet.

use serde::{Deserialize, Serialize};
use url::Url;

/// Suchmaschine (nur datensparsame Anbieter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Search {
    /// DuckDuckGo.
    #[default]
    DuckDuckGo,
    /// Startpage.
    Startpage,
    /// Brave Search.
    Brave,
}

impl Search {
    fn base(self) -> &'static str {
        match self {
            Self::DuckDuckGo => "https://duckduckgo.com/",
            Self::Startpage => "https://www.startpage.com/do/search",
            Self::Brave => "https://search.brave.com/search",
        }
    }

    /// Adresse der Suche nach `query`.
    ///
    /// # Errors
    /// Nur theoretisch (feste Basisadresse).
    pub fn url(self, query: &str) -> Result<Url, Refused> {
        let mut url = Url::parse(self.base()).map_err(|_| Refused::Invalid)?;
        url.query_pairs_mut().append_pair("q", query);
        Ok(url)
    }
}

/// Warum eine Eingabe nicht geöffnet wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// Leere Eingabe.
    Empty,
    /// Schema ist nicht erlaubt (nur http/https).
    Scheme(String),
    /// Zu lang.
    TooLong,
    /// Keine gültige Adresse.
    Invalid,
}

/// Höchstlänge einer Eingabe.
pub const MAX_INPUT: usize = 8 * 1024;

fn looks_like_host(text: &str) -> bool {
    let host = text.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once(':').map_or(host, |(h, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            host
        }
    });
    !host.is_empty()
        && !text.contains(char::is_whitespace)
        && (host == "localhost"
            || (host.contains('.') && !host.starts_with('.') && !host.ends_with('.')))
        && host.chars().all(|c| {
            c.is_alphanumeric() || c == '.' || c == '-' || c == '[' || c == ']' || c == ':'
        })
}

/// Wandelt eine Eingabe in die zu öffnende Adresse. `https_only`: `http://` wird zu
/// `https://` (die App fragt nach, falls die Seite kein HTTPS kann).
///
/// # Errors
/// Leer, zu lang oder nicht erlaubtes Schema.
pub fn resolve(input: &str, search: Search, https_only: bool) -> Result<Url, Refused> {
    let text = input.trim();
    if text.is_empty() {
        return Err(Refused::Empty);
    }
    if text.len() > MAX_INPUT {
        return Err(Refused::TooLong);
    }
    let candidate = match Url::parse(text) {
        Ok(url) if url.scheme() == "http" || url.scheme() == "https" => Some(url),
        // `localhost:8080` parst als Schema „localhost“ – das ist eine Adresse ohne Schema.
        Ok(url) if url.cannot_be_a_base() && looks_like_host(text) => {
            Url::parse(&format!("https://{text}")).ok()
        }
        Ok(url) => return Err(Refused::Scheme(url.scheme().to_owned())),
        Err(_) if looks_like_host(text) => Url::parse(&format!("https://{text}")).ok(),
        Err(_) => None,
    };
    match candidate {
        Some(url) if url.host_str().is_some() => Ok(if https_only { upgrade(url) } else { url }),
        _ => search.url(text),
    }
}

/// `http://` → `https://` (Port 80 fällt weg). Andere Adressen bleiben.
#[must_use]
pub fn upgrade(mut url: Url) -> Url {
    if url.scheme() == "http" {
        let port = url.port();
        // `set_scheme` zwischen speziellen Schemata gelingt immer.
        let _ = url.set_scheme("https");
        if port == Some(80) {
            let _ = url.set_port(None);
        }
    }
    url
}

/// Darf der Browser diese Adresse öffnen (Navigation der Seite selbst, Links, Umleitungen)?
/// Nur `http`/`https` und `about:blank`.
#[must_use]
pub fn navigable(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}

/// Darf eine eingebettete Seite (iframe) diese Adresse laden? Web-Adressen sowie die
/// Inhalts-Schemata, die Seiten für eigene Rahmen brauchen (`about:blank`/`about:srcdoc`,
/// `data:`, `blob:`). Alles andere (`file:`, `javascript:`, Programm-Schemata …) nie.
/// Ob `http` erlaubt ist, entscheidet zusätzlich HTTPS-only.
#[must_use]
pub fn frame_navigable(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "data" | "blob")
        || matches!(url.as_str(), "about:blank" | "about:srcdoc")
}

/// Kurzform für die Anzeige (Host, ohne `www.`).
#[must_use]
pub fn display_host(url: &Url) -> String {
    url.host_str()
        .map(|h| h.trim_start_matches("www.").to_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adressen_und_suche() {
        let s = Search::DuckDuckGo;
        assert_eq!(
            resolve("example.org", s, true).unwrap().as_str(),
            "https://example.org/"
        );
        assert_eq!(
            resolve("http://example.org/a?b=1", s, true)
                .unwrap()
                .as_str(),
            "https://example.org/a?b=1"
        );
        assert_eq!(
            resolve("http://example.org:80/", s, true).unwrap().as_str(),
            "https://example.org/"
        );
        assert_eq!(
            resolve("http://example.org/", s, false).unwrap().as_str(),
            "http://example.org/"
        );
        assert_eq!(
            resolve("localhost:8080", s, true).unwrap().as_str(),
            "https://localhost:8080/"
        );
        let search = resolve("wie warm ist es heute", s, true).unwrap();
        assert_eq!(search.host_str(), Some("duckduckgo.com"));
        assert!(search.as_str().contains("q=wie+warm"));
        assert_eq!(
            resolve("rust", Search::Brave, true).unwrap().host_str(),
            Some("search.brave.com")
        );
    }

    #[test]
    fn gefaehrliche_schemata_nie() {
        let s = Search::DuckDuckGo;
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "data:text/html,<b>x</b>",
            "ms-settings:privacy",
            "vbscript:x",
        ] {
            assert!(
                matches!(resolve(bad, s, true), Err(Refused::Scheme(_))),
                "{bad}"
            );
        }
        assert_eq!(resolve("   ", s, true), Err(Refused::Empty));
        assert_eq!(
            resolve(&"a".repeat(MAX_INPUT + 1), s, true),
            Err(Refused::TooLong)
        );
        assert!(!navigable(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(navigable(&Url::parse("about:blank").unwrap()));
        assert!(!navigable(&Url::parse("about:config").unwrap()));
        for ok in [
            "https://a.example/",
            "about:srcdoc",
            "data:text/html,x",
            "blob:https://a.example/1",
        ] {
            assert!(frame_navigable(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in [
            "file:///c:/x",
            "javascript:alert(1)",
            "ms-msdt:/id",
            "search-ms:query=x",
            "about:config",
        ] {
            assert!(!frame_navigable(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn anzeige() {
        assert_eq!(
            display_host(&Url::parse("https://www.example.org/x").unwrap()),
            "example.org"
        );
    }
}
