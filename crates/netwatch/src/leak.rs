//! Leck-Check (P7.5) mit Have I Been Pwned:
//!
//! - **Passwörter** über die Range-API mit k-Anonymität: Die Oberfläche bildet den SHA-1-Wert
//!   selbst und gibt nur die ersten fünf Hex-Zeichen weiter; verglichen wird lokal. Weder
//!   Passwort noch vollständiger Hash verlassen die Oberfläche.
//! - **E-Mail-Adressen** nur mit dem eigenen API-Schlüssel des Nutzers (HIBP verlangt ihn).
//!
//! Hier nur Prüfen und Lesen (rein); abgerufen wird in der App auf Knopfdruck.

use serde::{Deserialize, Serialize};

/// Server und Pfad der Range-API.
pub const RANGE_HOST: &str = "api.pwnedpasswords.com";
/// Server der HIBP-API (E-Mail).
pub const API_HOST: &str = "haveibeenpwned.com";
/// Größte akzeptierte Antwort.
pub const MAX_RESPONSE: usize = 2 * 1024 * 1024;

/// Fünf Hex-Zeichen (Großbuchstaben).
#[must_use]
pub fn valid_prefix(prefix: &str) -> bool {
    prefix.len() == 5
        && prefix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// Ein Eintrag der Range-Antwort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RangeEntry {
    /// Restliche 35 Hex-Zeichen des SHA-1-Werts.
    pub suffix: String,
    /// Wie oft das Passwort in Lecks vorkam.
    pub count: u64,
}

/// Liest die Range-Antwort (`SUFFIX:ANZAHL` je Zeile); Füll-Einträge (Anzahl 0) entfallen.
#[must_use]
pub fn parse_range(body: &str) -> Vec<RangeEntry> {
    body.lines()
        .filter_map(|line| {
            let (suffix, count) = line.trim().split_once(':')?;
            let suffix = suffix.to_ascii_uppercase();
            let count: u64 = count.trim().parse().ok()?;
            (suffix.len() == 35 && suffix.bytes().all(|b| b.is_ascii_hexdigit()) && count > 0)
                .then_some(RangeEntry { suffix, count })
        })
        .take(4096)
        .collect()
}

/// Plausible E-Mail-Adresse (eine `@`, Domain mit Punkt, keine Leer-/Steuerzeichen).
#[must_use]
pub fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= 254
        && !local.is_empty()
        && local.len() <= 64
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// API-Schlüssel: 16–64 Zeichen aus Buchstaben und Ziffern.
#[must_use]
pub fn valid_api_key(key: &str) -> bool {
    (16..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Prozent-Kodierung für einen Pfadabschnitt (alles außer `A-Za-z0-9-._~`).
#[must_use]
pub fn encode_segment(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Pfad der E-Mail-Abfrage.
#[must_use]
pub fn breach_path(email: &str) -> String {
    format!(
        "/api/v3/breachedaccount/{}?truncateResponse=false",
        encode_segment(&email.trim().to_lowercase())
    )
}

/// Ein Datenleck (Auszug der HIBP-Felder).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breach {
    /// Kennung.
    #[serde(rename(deserialize = "Name"))]
    pub name: String,
    /// Titel.
    #[serde(rename(deserialize = "Title"), default)]
    pub title: String,
    /// Betroffene Domain.
    #[serde(rename(deserialize = "Domain"), default)]
    pub domain: String,
    /// Datum des Lecks (`JJJJ-MM-TT`).
    #[serde(rename(deserialize = "BreachDate"), default)]
    pub breach_date: String,
    /// Betroffene Datenarten (englisch, wie von HIBP).
    #[serde(rename(deserialize = "DataClasses"), default)]
    pub data_classes: Vec<String>,
    /// Von HIBP bestätigt?
    #[serde(rename(deserialize = "IsVerified"), default)]
    pub verified: bool,
}

/// Ergebnis der E-Mail-Abfrage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EmailResult {
    /// In Lecks gefunden.
    Found {
        /// Lecks (neueste zuerst).
        breaches: Vec<Breach>,
    },
    /// Nicht gefunden.
    NotFound,
    /// Fehler (`invalid_key`, `rate_limited`, `unavailable`, `bad_response`).
    Error {
        /// Kennung.
        code: String,
    },
}

/// Wertet Status und Inhalt der E-Mail-Abfrage aus.
#[must_use]
pub fn email_result(status: u16, body: &[u8]) -> EmailResult {
    let error = |code: &str| EmailResult::Error {
        code: code.to_owned(),
    };
    match status {
        200 => match serde_json::from_slice::<Vec<Breach>>(body) {
            Ok(mut breaches) => {
                for b in &mut breaches {
                    for field in [&mut b.name, &mut b.title, &mut b.domain, &mut b.breach_date] {
                        *field = field
                            .chars()
                            .filter(|c| !c.is_control())
                            .take(120)
                            .collect();
                    }
                    b.data_classes.truncate(30);
                }
                breaches.sort_by(|a, b| b.breach_date.cmp(&a.breach_date));
                breaches.truncate(500);
                EmailResult::Found { breaches }
            }
            Err(_) => error("bad_response"),
        },
        404 => EmailResult::NotFound,
        401 | 403 => error("invalid_key"),
        429 => error("rate_limited"),
        _ => error("unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_und_praefix() {
        assert!(valid_prefix("21BD1"));
        assert!(!valid_prefix("21bd1"));
        assert!(!valid_prefix("21BD"));
        assert!(!valid_prefix("21BDG"));
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:10\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\nkaputt\n011053FD0102E94D6AE2F8B83D76FAF94F6:1";
        let entries = parse_range(body);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].count, 10);
        assert_eq!(entries[1].suffix, "011053FD0102E94D6AE2F8B83D76FAF94F6");
    }

    #[test]
    fn email_eingaben() {
        assert!(valid_email("anna@example.de"));
        assert!(!valid_email("anna@example"));
        assert!(!valid_email("anna example@x.de"));
        assert!(!valid_email("a@b@c.de"));
        assert!(!valid_email("@x.de"));
        assert!(valid_api_key("0123456789abcdef0123456789abcdef"));
        assert!(!valid_api_key("kurz"));
        assert!(!valid_api_key("0123456789abcdef0123456789abcde\n"));
        assert_eq!(
            breach_path(" Anna+Test@Example.de "),
            "/api/v3/breachedaccount/anna%2Btest%40example.de?truncateResponse=false"
        );
    }

    #[test]
    fn email_antworten() {
        let body = br#"[{"Name":"Alt","Title":"Alt","Domain":"alt.example","BreachDate":"2015-01-01","DataClasses":["Email addresses","Passwords"],"IsVerified":true},
                        {"Name":"Neu","BreachDate":"2023-05-01"}]"#;
        let EmailResult::Found { breaches } = email_result(200, body) else {
            panic!("erwartet: gefunden");
        };
        assert_eq!(breaches[0].name, "Neu");
        assert_eq!(breaches[1].data_classes.len(), 2);
        assert_eq!(email_result(404, b""), EmailResult::NotFound);
        assert_eq!(
            email_result(401, b""),
            EmailResult::Error {
                code: "invalid_key".into()
            }
        );
        assert_eq!(
            email_result(429, b""),
            EmailResult::Error {
                code: "rate_limited".into()
            }
        );
        assert_eq!(
            email_result(200, b"kein json"),
            EmailResult::Error {
                code: "bad_response".into()
            }
        );
    }
}
