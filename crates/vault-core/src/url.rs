//! Adressvergleich fürs Ausfüllen in der Browser-Erweiterung: Ein Eintrag passt nur zur
//! eigenen Adresse (gleicher Host oder Unteradresse) – nie umgekehrt, nie zu Ähnlichem.

/// Schema und Host einer Adresse (`https://login.bank.example/x` → `("https", "login.bank.example")`).
#[must_use]
pub fn origin_parts(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next()?.to_owned()
    } else {
        host_port.split(':').next()?.to_owned()
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)))
    .then_some((scheme, host))
}

/// Gespeicherte Adresse ohne Schema (`bank.example`) als https behandeln.
fn stored_parts(url: &str) -> Option<(String, String)> {
    origin_parts(url).or_else(|| origin_parts(&format!("https://{}", url.trim())))
}

/// Passt die gespeicherte Adresse zur Seite (`origin`)?
/// Host gleich oder Seite ist Unteradresse; eine https-Adresse passt nie zu http.
#[must_use]
pub fn matches(stored: &str, origin: &str) -> bool {
    let (Some((s_scheme, s_host)), Some((o_scheme, o_host))) =
        (stored_parts(stored), origin_parts(origin))
    else {
        return false;
    };
    if s_scheme == "https" && o_scheme != "https" {
        return false;
    }
    o_host == s_host || o_host.ends_with(&format!(".{s_host}"))
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
}
