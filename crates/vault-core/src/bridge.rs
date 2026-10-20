//! Brücke zur Browser-Erweiterung (P9.3): Anfragen kommen über den Native-Messaging-Host und
//! eine nur für das eigene Konto offene Pipe. Die Adresse (`origin`) bestimmt der Browser bzw.
//! die Erweiterung aus dem Tab – nie die Webseite. Logins gibt es nur für passende Adressen.

use serde::{Deserialize, Serialize};

use crate::url::matches;
use crate::vault::Vault;

/// Höchstzahl gemeldeter Logins je Seite.
pub const MAX_LOGINS: usize = 20;
/// Größte Anfrage (Bytes).
pub const MAX_REQUEST: usize = 8 * 1024;

/// Anfrage der Erweiterung.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Ist der Tresor entsperrt?
    Status {},
    /// Logins (ohne Passwort) für die Seite.
    Logins {
        /// Adresse der Seite (`https://host`).
        origin: String,
    },
    /// Benutzername und Passwort eines Logins – nur, wenn er zur Seite passt.
    Fill {
        /// Kennung des Eintrags.
        id: String,
        /// Adresse der Seite.
        origin: String,
    },
}

/// Ein Login (ohne Passwort).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Login {
    /// Kennung.
    pub id: String,
    /// Titel.
    pub title: String,
    /// Benutzername.
    pub username: String,
}

/// Antwort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Zustand.
    Status {
        /// Entsperrt?
        unlocked: bool,
    },
    /// Passende Logins.
    Logins {
        /// Logins.
        logins: Vec<Login>,
    },
    /// Zugangsdaten zum Ausfüllen.
    Fill {
        /// Benutzername.
        username: String,
        /// Passwort.
        password: String,
    },
    /// Tresor gesperrt.
    Locked,
    /// Fehler (`invalid`, `no_match`, `rate_limited`, `app_not_running`, `forbidden`).
    Error {
        /// Kennung.
        code: String,
    },
}

impl Drop for Response {
    fn drop(&mut self) {
        // Zugangsdaten nicht im freigegebenen Speicher liegen lassen.
        if let Self::Fill { username, password } = self {
            zeroize::Zeroize::zeroize(username);
            zeroize::Zeroize::zeroize(password);
        }
    }
}

impl Response {
    /// Fehler mit Kennung.
    #[must_use]
    pub fn error(code: &str) -> Self {
        Self::Error {
            code: code.to_owned(),
        }
    }
}

fn valid_origin(origin: &str) -> bool {
    origin.len() <= 2048
        && (origin.starts_with("https://") || origin.starts_with("http://"))
        && crate::url::origin_parts(origin).is_some()
}

/// Liest eine Anfrage (Größe, Format, Felder geprüft).
///
/// # Errors
/// Ungültige Anfrage.
pub fn parse(bytes: &[u8]) -> Result<Request, String> {
    if bytes.len() > MAX_REQUEST {
        return Err("zu groß".into());
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    match &request {
        Request::Status {} => {}
        Request::Logins { origin } => {
            if !valid_origin(origin) {
                return Err("ungültige Adresse".into());
            }
        }
        Request::Fill { id, origin } => {
            if !valid_origin(origin) || id.is_empty() || id.len() > 64 {
                return Err("ungültige Anfrage".into());
            }
        }
    }
    Ok(request)
}

/// Beantwortet eine Anfrage (`vault` = `None`: gesperrt).
#[must_use]
pub fn handle(request: &Request, vault: Option<&Vault>) -> Response {
    let Some(vault) = vault else {
        return match request {
            Request::Status {} => Response::Status { unlocked: false },
            _ => Response::Locked,
        };
    };
    match request {
        Request::Status {} => Response::Status { unlocked: true },
        Request::Logins { origin } => Response::Logins {
            logins: vault
                .entries()
                .iter()
                .filter(|e| !e.password.is_empty() && e.urls.iter().any(|u| matches(u, origin)))
                .take(MAX_LOGINS)
                .map(|e| Login {
                    id: e.id.clone(),
                    title: e.title.clone(),
                    username: e.username.clone(),
                })
                .collect(),
        },
        Request::Fill { id, origin } => match vault.get(id) {
            Some(e) if e.urls.iter().any(|u| matches(u, origin)) => Response::Fill {
                username: e.username.clone(),
                password: e.password.clone(),
            },
            _ => Response::error("no_match"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::EntryInput;
    use crate::vault::KdfParams;

    fn vault() -> (Vault, String) {
        let mut v = Vault::create("ein langes Master-Passwort", KdfParams::DEFAULT).unwrap();
        let mut e = EntryInput::default();
        e.title = "Bank".into();
        e.username = "anna".into();
        e.password = "geheim".into();
        e.urls = vec!["https://bank.example".into()];
        let id = v.add(&e, 1).unwrap();
        (v, id)
    }

    #[test]
    fn nur_passende_seiten() {
        let (v, id) = vault();
        let logins = handle(
            &Request::Logins {
                origin: "https://online.bank.example".into(),
            },
            Some(&v),
        );
        let Response::Logins { ref logins } = logins else {
            panic!("erwartet: Logins");
        };
        assert_eq!(logins.len(), 1);
        assert!(!serde_json::to_string(&logins).unwrap().contains("geheim"));
        assert_eq!(
            handle(
                &Request::Fill {
                    id: id.clone(),
                    origin: "https://bank.example.evil.test".into()
                },
                Some(&v)
            ),
            Response::error("no_match")
        );
        assert_eq!(
            handle(
                &Request::Fill {
                    id: id.clone(),
                    origin: "http://bank.example".into()
                },
                Some(&v)
            ),
            Response::error("no_match")
        );
        assert!(matches!(
            handle(
                &Request::Fill {
                    id,
                    origin: "https://bank.example".into()
                },
                Some(&v)
            ),
            Response::Fill { .. }
        ));
        assert_eq!(
            handle(&Request::Status {}, None),
            Response::Status { unlocked: false }
        );
        assert_eq!(
            handle(
                &Request::Logins {
                    origin: "https://bank.example".into()
                },
                None
            ),
            Response::Locked
        );
    }

    #[test]
    fn anfragen_werden_geprueft() {
        assert_eq!(parse(br#"{"type":"status"}"#).unwrap(), Request::Status {});
        assert!(parse(br#"{"type":"logins","origin":"https://bank.example"}"#).is_ok());
        assert!(parse(br#"{"type":"logins","origin":"javascript:alert(1)"}"#).is_err());
        assert!(parse(br#"{"type":"fill","id":"","origin":"https://bank.example"}"#).is_err());
        assert!(parse(br#"{"type":"export_all"}"#).is_err());
        assert!(parse(br#"{"type":"status","x":1}"#).is_err());
        assert!(parse(&vec![b' '; MAX_REQUEST + 1]).is_err());
    }
}
