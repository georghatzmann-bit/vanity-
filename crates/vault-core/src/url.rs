//! Adressvergleich fürs Ausfüllen in der Browser-Erweiterung: Ein Eintrag passt nur zur
//! eigenen Adresse (gleicher Host oder Unteradresse, gleicher Port) – nie umgekehrt, nie zu
//! Ähnlichem. Die Zerlegung folgt dem Browser (WHATWG): `\` trennt wie `/`, Benutzerangaben
//! (`user@`) gehören nicht zum Host.

/// Öffentliche bzw. geteilte Endungen, unter denen fremde Leute eigene Unteradressen haben:
/// Ein Eintrag für genau diese Endung passt zu nichts, Unteradressen nur exakt.
const SHARED_SUFFIXES: &[&str] = &[
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "co.at",
    "or.at",
    "gv.at",
    "com.au",
    "co.jp",
    "co.nz",
    "com.br",
    "com.cn",
    "com.tr",
    "co.in",
    "github.io",
    "gitlab.io",
    "pages.dev",
    "netlify.app",
    "vercel.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "blogspot.com",
    "wordpress.com",
    "azurewebsites.net",
    "cloudfront.net",
    "appspot.com",
    "workers.dev",
    "duckdns.org",
    "ngrok.io",
    "ngrok-free.app",
];

/// Zerlegte Adresse: Schema, Host (klein, ohne Endpunkt) und Port (Standard ergänzt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    /// `https` oder `http`.
    pub scheme: String,
    /// Host in Kleinbuchstaben (IPv6 ohne Klammern).
    pub host: String,
    /// Port (443/80, wenn nicht angegeben).
    pub port: u16,
}

impl Origin {
    fn is_ip(&self) -> bool {
        self.host.contains(':') || self.host.parse::<std::net::Ipv4Addr>().is_ok()
    }
}

/// Zerlegt eine http(s)-Adresse; `None` bei allem anderen oder Ungültigem.
#[must_use]
pub fn parse_origin(url: &str) -> Option<Origin> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    // Wie im Browser: Bei http(s) beendet auch `\` die Autorität.
    let authority = rest.split(['/', '\\', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
        let (host, after) = stripped.split_once(']')?;
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':')?),
        };
        if !host.contains(':') {
            return None;
        }
        (host.to_owned(), port)
    } else {
        match host_port.split_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (host_port.to_owned(), None),
        }
    };
    let port = match port {
        None | Some("") => default_port,
        Some(p) if p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => p.parse().ok()?,
        Some(_) => return None,
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
        && !host.starts_with('.')
        && !host.contains("..");
    valid.then_some(Origin { scheme, host, port })
}

/// Schema und Host einer Adresse (`https://login.bank.example/x` → `("https", "login.bank.example")`).
#[must_use]
pub fn origin_parts(url: &str) -> Option<(String, String)> {
    parse_origin(url).map(|o| (o.scheme, o.host))
}

/// Gespeicherte Adresse ohne Schema (`bank.example`) als https behandeln.
fn stored_origin(url: &str) -> Option<Origin> {
    let url = url.trim();
    if url.contains("://") {
        parse_origin(url)
    } else {
        parse_origin(&format!("https://{url}"))
    }
}

/// Taugt der gespeicherte Host als Ziel? Ein einzelnes Wort (außer `localhost`) oder eine
/// geteilte Endung wie `github.io` passt zu nichts.
fn usable_host(o: &Origin) -> bool {
    o.is_ip()
        || o.host == "localhost"
        || (o.host.contains('.') && !SHARED_SUFFIXES.contains(&o.host.as_str()))
}

/// Liegt `host` unter einer geteilten Endung (`kunde.github.io`)? Dann nur exakt.
fn under_shared_suffix(host: &str) -> bool {
    SHARED_SUFFIXES
        .iter()
        .any(|s| host.strip_suffix(s).is_some_and(|p| p.ends_with('.')))
}

/// Passt die gespeicherte Adresse zur Seite (`origin`)?
/// Host gleich oder Seite ist Unteradresse, Port gleich; eine https-Adresse passt nie zu http.
#[must_use]
pub fn matches(stored: &str, origin: &str) -> bool {
    let (Some(s), Some(o)) = (stored_origin(stored), parse_origin(origin)) else {
        return false;
    };
    if !usable_host(&s) || s.port != o.port {
        return false;
    }
    if s.scheme == "https" && o.scheme != "https" {
        return false;
    }
    if o.host == s.host {
        return true;
    }
    // Unteradressen nur bei Namen (keine IP), nicht unter geteilten Endungen.
    !s.is_ip()
        && s.host != "localhost"
        && !under_shared_suffix(&s.host)
        && o.host.ends_with(&format!(".{}", s.host))
}

/// Ist die Adresse für einen Eintrag brauchbar (http/https, gültiger Host)?
#[must_use]
pub fn valid_stored(url: &str) -> bool {
    stored_origin(url).is_some_and(|o| usable_host(&o))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_eigene_adressen() {
        assert!(matches("https://bank.example", "https://bank.example"));
        assert!(matches(
            "https://bank.example/login",
            "https://online.bank.example"
        ));
        assert!(matches("bank.example", "https://bank.example"));
        assert!(!matches("https://bank.example", "http://bank.example"));
        assert!(!matches(
            "https://bank.example",
            "https://bank.example.evil.test"
        ));
        assert!(!matches("https://bank.example", "https://evilbank.example"));
        assert!(!matches(
            "https://online.bank.example",
            "https://bank.example"
        ));
        assert!(!matches("https://bank.example", "https://user@evil.test"));
        assert!(matches("https://user@bank.example", "https://bank.example"));
        assert!(!matches("javascript:alert(1)", "https://bank.example"));
        assert!(!matches("https://bank.example", "chrome-extension://abc"));
        assert_eq!(
            origin_parts("https://Login.Bank.Example:8443/x?y")
                .unwrap()
                .1,
            "login.bank.example"
        );
    }

    #[test]
    fn ports_endungen_und_browser_zerlegung() {
        // Ports: Standard ergänzt, sonst exakt.
        assert!(matches("https://bank.example", "https://bank.example:443"));
        assert!(!matches(
            "https://bank.example",
            "https://bank.example:8443"
        ));
        assert!(matches(
            "https://bank.example:8443/x",
            "https://bank.example:8443"
        ));
        assert!(!matches("http://localhost:3000", "http://localhost:4000"));
        assert!(matches("http://10.0.0.1:8080", "http://10.0.0.1:8080"));
        assert!(!matches("http://10.0.0.1", "http://110.0.0.1"));
        // Einzelne Wörter und geteilte Endungen passen zu nichts, darunter nur exakt.
        assert!(!matches("com", "https://evil.com"));
        assert!(!matches("https://github.io", "https://attacker.github.io"));
        assert!(matches("https://me.github.io", "https://me.github.io"));
        assert!(!matches("https://me.github.io", "https://x.me.github.io"));
        assert!(!valid_stored("intranet"));
        assert!(valid_stored("localhost:8080"));
        // `\` trennt wie im Browser: Host ist bank.example, nicht evil.test.
        assert!(!matches(
            "https://bank.example\\@evil.test",
            "https://evil.test"
        ));
        assert!(matches(
            "https://bank.example\\@evil.test",
            "https://bank.example"
        ));
        // Kaputte Angaben.
        assert!(parse_origin("https://[::1").is_none());
        assert!(parse_origin("https://bank.example:99999").is_none());
        assert!(parse_origin("https://bank..example").is_none());
        assert_eq!(
            parse_origin("https://[::1]:8443/").map(|o| (o.host, o.port)),
            Some(("::1".into(), 8443))
        );
    }
}
