//! Einstellungen des Browsers und die daraus folgenden Schalter für WebView2 (Chromium):
//! WebRTC ohne lokale Adressen, kein Hintergrund-Netz der Engine, im Tor-Modus alles über den
//! SOCKS-Proxy (auch DNS). Die Schalter hängen nur von der Fensterart ab – WebView2 verlangt
//! für einen Datenordner während der ganzen Laufzeit dieselben Schalter.
//!
//! DNS-over-HTTPS: WebView2 bietet dafür keinen Schalter (Chromium steuert DoH nur über
//! Richtlinien bzw. interne Einstellungen). Der Browser nutzt deshalb das DNS von Windows; ab
//! Windows 11 lässt sich dort DNS-over-HTTPS einschalten – die Oberfläche sagt das ehrlich.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::address::Search;

/// Einstellungen (gespeichert als JSON im Datenordner des Browsers). Unbekannte Felder älterer
/// Fassungen (z. B. `doh`) werden ignoriert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Nur HTTPS (http wird angehoben; Ausnahmen nur je Sitzung nach Nachfrage).
    pub https_only: bool,
    /// Werbe-/Tracker-Blocker (braucht geladene Listen).
    pub block_trackers: bool,
    /// JavaScript erlaubt (aus: viele Seiten funktionieren nicht mehr). Gilt für neue Tabs.
    pub javascript: bool,
    /// Suchmaschine.
    pub search: Search,
    /// Startseite (`None`: leere Seite).
    pub home: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            https_only: true,
            block_trackers: true,
            javascript: true,
            search: Search::default(),
            home: None,
        }
    }
}

impl Settings {
    /// Prüft und bereinigt Einstellungen aus der Oberfläche.
    #[must_use]
    pub fn cleaned(mut self) -> Self {
        self.home = self
            .home
            .and_then(|h| Url::parse(h.trim()).ok())
            .filter(|u| u.scheme() == "https")
            .map(|u| u.to_string())
            .filter(|h| h.len() <= 2048);
        self
    }
}

/// Fester, allgemeiner Browser-Kennzeichner (gleich für alle Nutzer – weniger Fingerabdruck).
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Art eines Profils (je Art ein eigener Datenordner mit festen Schaltern).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// Normales Fenster.
    Normal,
    /// Ghost (InPrivate).
    Ghost,
    /// Ghost über einen SOCKS5-Proxy auf `127.0.0.1:<port>` (Tor/Arti).
    Tor(u16),
}

impl Profile {
    /// Name des Datenordners.
    #[must_use]
    pub fn folder(self) -> String {
        match self {
            Self::Normal => "profile".to_owned(),
            Self::Ghost => "ghost".to_owned(),
            Self::Tor(port) => format!("ghost-tor-{port}"),
        }
    }
}

/// Schalter für WebView2 (Chromium-Kommandozeile). Wry fügt eigene Schalter (auch den Proxy)
/// nicht mehr hinzu, sobald welche gesetzt sind – deshalb steht hier alles selbst.
///
/// # Errors
/// Tor mit Port 0.
pub fn browser_args(profile: Profile) -> Result<String, String> {
    let mut disabled = vec![
        // Wie wry: keine Edge-eigenen Dialoge außerhalb des Fensters.
        "msWebOOUI",
        "msPdfOOUI",
        // Keine Hintergrund-Dienste der Engine an Dritte.
        "AutofillServerCommunication",
        "OptimizationHints",
        "InterestFeedContentSuggestions",
    ];
    let mut args = vec!["--disable-background-networking".to_owned()];
    match profile {
        Profile::Normal => {
            // WebRTC nur über die öffentliche Standardroute: keine lokalen IP-Adressen an
            // Seiten, Videoanrufe funktionieren weiter. SmartScreen (Phishing-/Schadseiten-
            // Schutz, fragt bei Microsoft nach) bleibt an.
            args.push("--force-webrtc-ip-handling-policy=default_public_interface_only".into());
        }
        Profile::Ghost => {
            args.push("--force-webrtc-ip-handling-policy=default_public_interface_only".into());
            // Ghost: keine Adressen an Microsoft (dafür kein SmartScreen-Schutz – die
            // Oberfläche sagt das).
            disabled.push("msSmartScreenProtection");
        }
        Profile::Tor(port) => {
            let proxy = tor_proxy(port)?;
            // Alles über den Proxy, auch DNS (Namen löst der Proxy auf); WebRTC ohne UDP am
            // Proxy vorbei.
            args.push(format!(
                "--proxy-server={}",
                proxy.as_str().trim_end_matches('/')
            ));
            args.push("--host-resolver-rules=\"MAP * ~NOTFOUND , EXCLUDE 127.0.0.1\"".into());
            args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
            disabled.push("msSmartScreenProtection");
        }
    }
    args.push(format!("--disable-features={}", disabled.join(",")));
    Ok(args.join(" "))
}

/// Proxy für den Ghost-Modus mit Tor (`socks5://127.0.0.1:<port>`).
///
/// # Errors
/// Port 0.
pub fn tor_proxy(port: u16) -> Result<Url, String> {
    if port == 0 {
        return Err("ungültiger Port".into());
    }
    Url::parse(&format!("socks5://127.0.0.1:{port}")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sichere_standards() {
        let s = Settings::default();
        assert!(s.https_only && s.block_trackers && s.javascript);
        let normal = browser_args(Profile::Normal).unwrap();
        assert!(normal.contains("default_public_interface_only"));
        assert!(normal.contains("msWebOOUI,msPdfOOUI"));
        assert!(!normal.contains("proxy-server"));
        assert!(!normal.contains("msSmartScreenProtection"));
        let ghost = browser_args(Profile::Ghost).unwrap();
        assert!(ghost.contains("msSmartScreenProtection") && !ghost.contains("proxy-server"));
        // Alte Einstellungen mit DoH-Feld lassen sich weiter lesen.
        let old: Settings =
            serde_json::from_str("{\"doh\":\"quad9\",\"httpsOnly\":false}").unwrap();
        assert!(!old.https_only);
    }

    /// P12-R1: Der Tor-Modus muss den Proxy selbst setzen (sonst gingen Seiten direkt raus).
    #[test]
    fn tor_geht_ueber_den_proxy_auch_dns() {
        let tor = browser_args(Profile::Tor(9150)).unwrap();
        assert!(
            tor.contains("--proxy-server=socks5://127.0.0.1:9150"),
            "{tor}"
        );
        assert!(tor.contains("--host-resolver-rules=\"MAP * ~NOTFOUND , EXCLUDE 127.0.0.1\""));
        assert!(tor.contains("disable_non_proxied_udp"));
        assert!(browser_args(Profile::Tor(0)).is_err());
        assert_eq!(Profile::Tor(9050).folder(), "ghost-tor-9050");
        assert_ne!(Profile::Normal.folder(), Profile::Ghost.folder());
    }

    #[test]
    fn startseite_nur_https() {
        let s = Settings {
            home: Some("javascript:alert(1)".into()),
            ..Settings::default()
        }
        .cleaned();
        assert_eq!(s.home, None);
        let s = Settings {
            home: Some(" https://example.org ".into()),
            ..Settings::default()
        }
        .cleaned();
        assert_eq!(s.home.as_deref(), Some("https://example.org/"));
        let parsed: Settings = serde_json::from_str("{\"javascript\":false}").unwrap();
        assert!(!parsed.javascript && parsed.https_only);
        assert_eq!(tor_proxy(9150).unwrap().as_str(), "socks5://127.0.0.1:9150");
        assert!(tor_proxy(0).is_err());
    }
}
