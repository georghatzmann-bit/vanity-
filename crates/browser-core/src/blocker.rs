//! Werbe- und Tracker-Blocker auf Filterlisten im Adblock-Plus-Format (EasyList,
//! EasyPrivacy). Die Listen werden **nicht** mitgeliefert (eigene Lizenzen: GPL-3.0 bzw.
//! CC BY-SA 3.0); die App lädt sie nur auf Wunsch des Nutzers. Ohne Listen blockiert der
//! Blocker nichts – das sagt die Oberfläche ehrlich.
//!
//! Erkennungsmaschine: `adblock` (Brave, MPL-2.0), nur Netzwerkregeln (keine Kosmetik).

use adblock::Engine;
use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use serde::{Deserialize, Serialize};

/// Eine bekannte Filterliste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum List {
    /// EasyList (Werbung).
    EasyList,
    /// EasyPrivacy (Tracker).
    EasyPrivacy,
}

impl List {
    /// Alle bekannten Listen.
    pub const ALL: [Self; 2] = [Self::EasyList, Self::EasyPrivacy];

    /// Host der Bezugsquelle (HTTPS).
    #[must_use]
    pub fn host(self) -> &'static str {
        "easylist.to"
    }

    /// Pfad auf dem Host.
    #[must_use]
    pub fn path(self) -> &'static str {
        match self {
            Self::EasyList => "/easylist/easylist.txt",
            Self::EasyPrivacy => "/easylist/easyprivacy.txt",
        }
    }

    /// Dateiname im Datenordner.
    #[must_use]
    pub fn file_name(self) -> &'static str {
        match self {
            Self::EasyList => "easylist.txt",
            Self::EasyPrivacy => "easyprivacy.txt",
        }
    }
}

/// Größte Liste, die angenommen wird (Byte).
pub const MAX_LIST: usize = 8 * 1024 * 1024;

/// Ist `text` plausibel eine Filterliste im Adblock-Plus-Format? (Kopfzeile, Größe, Text.)
#[must_use]
pub fn plausible_list(text: &str) -> bool {
    text.len() <= MAX_LIST
        && text.lines().next().is_some_and(|l| {
            l.trim_start_matches('\u{feff}')
                .starts_with("[Adblock Plus")
        })
        && !text.contains('\0')
}

/// Art einer Anfrage (wie WebView2 sie meldet), für Regeln mit `$script`, `$image` …
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Seite selbst.
    Document,
    /// Eingebettete Seite.
    Subdocument,
    /// Skript.
    Script,
    /// Bild.
    Image,
    /// Stilvorlage.
    Stylesheet,
    /// Schrift.
    Font,
    /// Medien.
    Media,
    /// XHR/Fetch.
    Xhr,
    /// WebSocket.
    Websocket,
    /// Sonstiges.
    Other,
}

impl Kind {
    /// Aus dem Namen, den die WebView-Anbindung meldet (`script`, `image`, `xhr` …).
    #[must_use]
    pub fn from_name(name: &str) -> Self {
        match name {
            "document" => Self::Document,
            "subdocument" => Self::Subdocument,
            "script" => Self::Script,
            "image" => Self::Image,
            "stylesheet" => Self::Stylesheet,
            "font" => Self::Font,
            "media" => Self::Media,
            "xhr" => Self::Xhr,
            "websocket" => Self::Websocket,
            _ => Self::Other,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Subdocument => "subdocument",
            Self::Script => "script",
            Self::Image => "image",
            Self::Stylesheet => "stylesheet",
            Self::Font => "font",
            Self::Media => "media",
            Self::Xhr => "xmlhttprequest",
            Self::Websocket => "websocket",
            Self::Other => "other",
        }
    }
}

/// Zählt als Netzwerkregel (keine Kommentare, keine Kosmetik wie `##.werbung`, die der
/// Browser nicht anwendet).
fn network_rule(line: &str) -> bool {
    let line = line.trim();
    !line.is_empty()
        && !line.starts_with('!')
        && !line.starts_with('[')
        && !["##", "#@#", "#?#", "#$#", "#%#", "#@?#", "#@$#"]
            .iter()
            .any(|m| line.contains(m))
}

/// Der Blocker (ohne Listen: blockiert nichts).
pub struct Blocker {
    engine: Option<Engine>,
    rules: usize,
}

impl std::fmt::Debug for Blocker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Blocker")
            .field("rules", &self.rules)
            .finish_non_exhaustive()
    }
}

impl Blocker {
    /// Ohne Listen.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            engine: None,
            rules: 0,
        }
    }

    /// Aus Listen (Text im Adblock-Plus-Format). Unplausible Listen werden übergangen.
    #[must_use]
    pub fn from_lists(lists: &[&str]) -> Self {
        let mut set = FilterSet::new(false);
        let mut rules = 0;
        for text in lists.iter().filter(|t| plausible_list(t)) {
            rules += text.lines().filter(|l| network_rule(l)).count();
            set.add_filter_list((*text).to_owned(), ParseOptions::default());
        }
        if rules == 0 {
            return Self::empty();
        }
        Self {
            engine: Some(Engine::new_with_filter_set(set)),
            rules,
        }
    }

    /// Zahl der Netzwerkregeln (ungefähr; Zeilen ohne Kommentare und Kosmetik).
    #[must_use]
    pub fn rules(&self) -> usize {
        self.rules
    }

    /// Soll die Anfrage `url` (von der Seite `source`) blockiert werden? Die Seite selbst
    /// (`Kind::Document`) wird nie blockiert – der Nutzer hat sie gewählt.
    #[must_use]
    pub fn blocks(&self, url: &str, source: &str, kind: Kind) -> bool {
        let Some(engine) = &self.engine else {
            return false;
        };
        if kind == Kind::Document {
            return false;
        }
        Request::new(url, source, kind.as_str(), "GET")
            .map(|request| engine.check_network_request(&request).should_block())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "[Adblock Plus 2.0]\n! Titel: Test\n||ads.example^\n||tracker.example^$third-party\n@@||ads.example/erlaubt.js\n##.werbung\nnews.example#@#.banner\n||frame.example^$subdocument\n";

    #[test]
    fn blockiert_nach_regeln() {
        let b = Blocker::from_lists(&[LIST]);
        // Kosmetik zählt nicht mit (wird nicht angewandt).
        assert_eq!(b.rules(), 4);
        let page = "https://news.example/";
        assert!(b.blocks("https://ads.example/banner.js", page, Kind::Script));
        assert!(!b.blocks("https://ads.example/erlaubt.js", page, Kind::Script));
        assert!(b.blocks("https://tracker.example/p.gif", page, Kind::Image));
        // Erstanbieter: `$third-party` greift nicht.
        assert!(!b.blocks(
            "https://tracker.example/p.gif",
            "https://tracker.example/",
            Kind::Image
        ));
        assert!(!b.blocks("https://news.example/bild.png", page, Kind::Image));
        // Eingebettete Werbe-Seiten (iframes) ja, als Hauptseite nie.
        assert!(b.blocks("https://frame.example/ad", page, Kind::Subdocument));
        assert!(!b.blocks("https://frame.example/ad", page, Kind::Document));
        // Die gewählte Seite selbst nie.
        assert!(!b.blocks("https://ads.example/", page, Kind::Document));
    }

    #[test]
    fn ohne_listen_nichts_und_unplausible_listen_zaehlen_nicht() {
        assert!(!Blocker::empty().blocks(
            "https://ads.example/x",
            "https://a.example/",
            Kind::Script
        ));
        let b = Blocker::from_lists(&["<html>keine Liste</html>"]);
        assert_eq!(b.rules(), 0);
        assert!(!plausible_list("||a^\n"));
        assert!(plausible_list("\u{feff}[Adblock Plus 2.0]\n||a^\n"));
        assert_eq!(List::EasyPrivacy.path(), "/easylist/easyprivacy.txt");
    }
}
