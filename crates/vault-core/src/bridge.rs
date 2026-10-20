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
/// Längster Benutzername bzw. längstes Passwort beim Speichern (Bytes).
pub const MAX_FIELD: usize = 1024;

fn sha256_hex(text: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Einträge mit passender Adresse und gleichem Benutzernamen (Groß/klein egal).
fn same_login<'a>(
    vault: &'a Vault,
    origin: &'a str,
    username: &'a str,
) -> impl Iterator<Item = &'a crate::entry::Entry> + 'a {
    vault.entries().iter().filter(move |e| {
        e.username.trim().eq_ignore_ascii_case(username.trim())
            && e.urls.iter().any(|u| matches(u, origin))
    })
}

/// Speichert einen Login aus der Erweiterung (nur [`Request::Save`]; sonst `invalid`).
/// Mit `id` wird nur das Passwort dieses Eintrags ersetzt – und nur, wenn er zur Seite und zum
/// Benutzernamen passt; ohne `id` entsteht ein neuer Eintrag (Titel = Host).
#[must_use]
pub fn save(request: &Request, vault: &mut Vault, now: i64) -> Response {
    let Request::Save {
        origin,
        username,
        password,
        id,
    } = request
    else {
        return Response::error("invalid");
    };
    if let Some(id) = id {
        let Some(existing) = same_login(vault, origin, username).find(|e| &e.id == id) else {
            return Response::error("no_match");
        };
        // EntryInput überschreibt sich beim Verlassen selbst (ZeroizeOnDrop).
        let input = crate::entry::EntryInput {
            title: existing.title.clone(),
            username: existing.username.clone(),
            password: password.clone(),
            urls: existing.urls.clone(),
            notes: existing.notes.clone(),
            folder: existing.folder.clone(),
            tags: existing.tags.clone(),
            favorite: existing.favorite,
        };
        let result = vault.update(id, &input, now);
        return match result {
            Ok(()) => Response::Saved { updated: true },
            Err(_) => Response::error("invalid"),
        };
    }
    let host = crate::url::origin_parts(origin)
        .map(|(_, h)| h)
        .unwrap_or_default();
    let input = crate::entry::EntryInput {
        title: host,
        username: username.clone(),
        password: password.clone(),
        urls: vec![origin.clone()],
        notes: String::new(),
        folder: String::new(),
        tags: Vec::new(),
        favorite: false,
    };
    let result = vault.add(&input, now);
    match result {
        Ok(_) => Response::Saved { updated: false },
        Err(_) => Response::error("invalid"),
    }
}

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
    /// Ist ein eben abgeschickter Login neu, geändert oder schon gespeichert? Das Passwort kommt
    /// nur als SHA-256 (hex) – der Klartext erst nach „Speichern“.
    Check {
        /// Adresse der Seite.
        origin: String,
        /// Benutzername.
        username: String,
        /// SHA-256 des Passworts (64 Hex-Zeichen, klein).
        password_sha256: String,
    },
    /// Login speichern (der Nutzer hat in der Erweiterung „Speichern“/„Aktualisieren“ geklickt).
    Save {
        /// Adresse der Seite.
        origin: String,
        /// Benutzername.
        username: String,
        /// Passwort.
        password: String,
        /// Bestehender Eintrag (aus `Check`), dessen Passwort ersetzt wird.
        id: Option<String>,
    },
}

/// Ergebnis von [`Request::Check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    /// Kein passender Eintrag.
    New,
    /// Gleicher Benutzer, anderes Passwort.
    Update,
    /// Schon so gespeichert.
    Same,
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
    /// Ergebnis der Prüfung vor dem Speichern.
    Check {
        /// Neu, geändert oder gleich.
        state: CheckState,
        /// Eintrag bei `update`.
        id: Option<String>,
    },
    /// Gespeichert.
    Saved {
        /// Bestehender Eintrag aktualisiert (sonst neu angelegt).
        updated: bool,
    },
    /// Tresor gesperrt.
    Locked,
    /// Fehler (`invalid`, `no_match`, `rate_limited`, `app_not_running`, `forbidden`).
    Error {
        /// Kennung.
        code: String,
    },
}

impl Drop for Request {
    fn drop(&mut self) {
        // Passwort aus „Speichern“ nicht im freigegebenen Speicher liegen lassen.
        if let Self::Save { password, .. } = self {
            zeroize::Zeroize::zeroize(password);
        }
    }
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
        Request::Check {
            origin,
            username,
            password_sha256,
        } => {
            if !valid_origin(origin)
                || username.len() > MAX_FIELD
                || password_sha256.len() != 64
                || !password_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("ungültige Anfrage".into());
            }
        }
        Request::Save {
            origin,
            username,
            password,
            id,
        } => {
            if !valid_origin(origin)
                || username.len() > MAX_FIELD
                || password.is_empty()
                || password.len() > MAX_FIELD
                || id.as_ref().is_some_and(|i| i.is_empty() || i.len() > 64)
            {
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
        Request::Check {
            origin,
            username,
            password_sha256,
        } => {
            let mut update = None;
            for e in same_login(vault, origin, username) {
                if &sha256_hex(&e.password) == password_sha256 {
                    return Response::Check {
                        state: CheckState::Same,
                        id: None,
                    };
                }
                update.get_or_insert_with(|| e.id.clone());
            }
            match update {
                Some(id) => Response::Check {
                    state: CheckState::Update,
                    id: Some(id),
                },
                None => Response::Check {
                    state: CheckState::New,
                    id: None,
                },
            }
        }
        // Speichern braucht den veränderbaren Tresor (`save`).
        Request::Save { .. } => Response::error("invalid"),
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

    #[test]
    fn pruefen_und_speichern() {
        let (mut v, id) = vault();
        let check = |v: &Vault, user: &str, pw: &str| {
            handle(
                &Request::Check {
                    origin: "https://bank.example".into(),
                    username: user.into(),
                    password_sha256: sha256_hex(pw),
                },
                Some(v),
            )
        };
        assert_eq!(
            check(&v, "ANNA", "geheim"),
            Response::Check {
                state: CheckState::Same,
                id: None
            }
        );
        assert_eq!(
            check(&v, "anna", "neu"),
            Response::Check {
                state: CheckState::Update,
                id: Some(id.clone())
            }
        );
        assert_eq!(
            check(&v, "bert", "x"),
            Response::Check {
                state: CheckState::New,
                id: None
            }
        );
        // Speichern nur über `save`, nie über `handle`.
        let save_req = |user: &str, pw: &str, id: Option<String>, origin: &str| Request::Save {
            origin: origin.into(),
            username: user.into(),
            password: pw.into(),
            id,
        };
        assert_eq!(
            handle(
                &save_req("anna", "neu", None, "https://bank.example"),
                Some(&v)
            ),
            Response::error("invalid")
        );
        // Aktualisieren: nur passender Eintrag (Adresse + Benutzer).
        assert_eq!(
            save(
                &save_req("anna", "neu", Some(id.clone()), "https://evil.test"),
                &mut v,
                5
            ),
            Response::error("no_match")
        );
        assert_eq!(
            save(
                &save_req("bert", "neu", Some(id.clone()), "https://bank.example"),
                &mut v,
                5
            ),
            Response::error("no_match")
        );
        assert_eq!(
            save(
                &save_req("anna", "neu", Some(id.clone()), "https://bank.example"),
                &mut v,
                5
            ),
            Response::Saved { updated: true }
        );
        assert_eq!(v.get(&id).unwrap().password, "neu");
        assert_eq!(v.get(&id).unwrap().title, "Bank");
        // Neu: Titel = Host, Adresse = Seite.
        assert_eq!(
            save(
                &save_req("bert", "pw2", None, "https://shop.example"),
                &mut v,
                6
            ),
            Response::Saved { updated: false }
        );
        let bert = v.entries().iter().find(|e| e.username == "bert").unwrap();
        assert_eq!(bert.title, "shop.example");
        assert_eq!(bert.urls, vec!["https://shop.example"]);
        // Prüfung der Eingaben.
        assert!(parse(br#"{"type":"save","origin":"https://a.example","username":"u","password":"","id":null}"#).is_err());
        assert!(parse(br#"{"type":"check","origin":"https://a.example","username":"u","password_sha256":"xyz"}"#).is_err());
        assert!(parse(br#"{"type":"check","origin":"https://a.example","username":"u","password_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#).is_ok());
    }
}
