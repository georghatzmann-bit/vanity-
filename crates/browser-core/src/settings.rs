//! Einstellungen des Browsers und die daraus folgenden Schalter für WebView2 (Chromium):
//! DNS-over-HTTPS, WebRTC ohne lokale Adressen, kein Hintergrund-Netz der Engine. Alles mit
//! sicheren Standards; jede Netz-Funktion ist abschaltbar.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::address::Search;

/// DNS-over-HTTPS-Anbieter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Doh {
    /// Aus (DNS des Systems).
    Off,
    /// Quad9 (Schweiz, filtert bekannte Schadseiten).
    #[default]
    Quad9,
    /// Mullvad (Schweden).
    Mullvad,
    /// Cloudflare.
    Cloudflare,
}

impl Doh {
    /// Vorlage der Anfrage-Adresse (`None`: aus).
    #[must_use]
    pub fn template(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Quad9 => Some("https://dns.quad9.net/dns-query"),
            Self::Mullvad => Some("https://dns.mullvad.net/dns-query"),
            Self::Cloudflare => Some("https://cloudflare-dns.com/dns-query"),
        }
    }
}

/// Einstellungen (gespeichert als JSON im Datenordner des Browsers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Nur HTTPS (http wird angehoben; Ausnahmen nur je Sitzung nach Nachfrage).
    pub https_only: bool,
    /// Werbe-/Tracker-Blocker (braucht geladene Listen).
    pub block_trackers: bool,
    /// JavaScript erlaubt (aus: viele Seiten funktionieren nicht mehr).
    pub javascript: bool,
    /// DNS-over-HTTPS.
    pub doh: Doh,
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
            doh: Doh::default(),
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

/// Schalter für WebView2 (Chromium-Kommandozeile). Gelten für alle Tabs eines Fensters.
#[must_use]
pub fn browser_args(settings: &Settings) -> String {
    let mut args = vec![
        // WebRTC nur über den Proxy/die Standardroute: keine lokalen IP-Adressen an Seiten.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
        // Kein „Safe Browsing“-Abgleich an Dritte, keine Hintergrund-Dienste der Engine.
        "--disable-background-networking".to_owned(),
        "--disable-features=msSmartScreenProtection,AutofillServerCommunication,OptimizationHints,InterestFeedContentSuggestions".to_owned(),
    ];
    if let Some(template) = settings.doh.template() {
        // DNS-over-HTTPS im sicheren Modus (kein Rückfall auf das System-DNS).
        args.push("--enable-features=DnsOverHttps".to_owned());
        args.push("--dns-over-https-mode=secure".to_owned());
        args.push(format!("--dns-over-https-templates={template}"));
    }
    args.join(" ")
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
        assert_eq!(s.doh, Doh::Quad9);
        let args = browser_args(&s);
        assert!(args.contains("--dns-over-https-templates=https://dns.quad9.net/dns-query"));
        assert!(args.contains("disable_non_proxied_udp"));
        let off = Settings {
            doh: Doh::Off,
            ..Settings::default()
        };
        assert!(!browser_args(&off).contains("dns-over-https"));
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
