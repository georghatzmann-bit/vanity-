//! Signierte Updates der AEGIS Suite (P13) – reine Logik ohne Netz:
//!
//! - Das Update-Manifest (`latest.json`) nennt Version, Dateien, Adressen, SHA-256 und Größe.
//! - Es ist mit Ed25519 signiert; der öffentliche Schlüssel ist in die App eingebaut
//!   ([`PUBLIC_KEY`], aus `release/update-public.key`). Ohne Schlüssel gibt es keine Updates –
//!   das sagt die Oberfläche ehrlich.
//! - Jede geladene Datei wird vor dem Start gegen SHA-256 und Größe geprüft; Adressen nur
//!   `https://github.com/georghatzmann-bit/vanity-/releases/download/…`.
#![forbid(unsafe_code)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Eingebauter öffentlicher Schlüssel (Base64, 32 Byte) – leer, solange keiner erzeugt ist.
pub const PUBLIC_KEY: &str = include_str!("../../../release/update-public.key");

/// Erlaubter Anfang aller Download-Adressen.
pub const RELEASE_PREFIX: &str = "https://github.com/georghatzmann-bit/vanity-/releases/download/";
/// Host und Pfad des Manifests der neuesten Version.
pub const MANIFEST_HOST: &str = "github.com";
/// Pfad des Manifests der neuesten Version.
pub const MANIFEST_PATH: &str = "/georghatzmann-bit/vanity-/releases/latest/download/latest.json";
/// Größtes Manifest.
pub const MAX_MANIFEST: usize = 256 * 1024;
/// Größte Datei eines Updates.
pub const MAX_FILE: u64 = 512 * 1024 * 1024;

/// Art einer Datei.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Installationsprogramm der App (NSIS, still installierbar).
    App,
    /// Installationsprogramm des Privacy-Browsers (NSIS, für das Konto).
    Browser,
    /// Setup-Programm (lädt die App selbst).
    Setup,
}

/// Eine Datei des Updates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    /// Art.
    pub kind: Kind,
    /// Dateiname (ohne Pfad).
    pub name: String,
    /// Download-Adresse.
    pub url: String,
    /// SHA-256 (64 Hex-Zeichen, klein).
    pub sha256: String,
    /// Größe in Byte.
    pub size: u64,
}

/// Das Manifest einer Version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Version (`1.2.3`).
    pub version: String,
    /// Veröffentlicht (RFC 3339).
    pub published: String,
    /// Kurze Hinweise zur Version.
    pub notes: String,
    /// Dateien.
    pub files: Vec<Artifact>,
}

/// Manifest mit Signatur (Inhalt von `latest.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    /// Manifest als JSON-Text (genau diese Bytes sind signiert).
    pub manifest: String,
    /// Ed25519-Signatur (Base64, 64 Byte).
    pub signature: String,
}

/// Warum ein Update abgelehnt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Kein öffentlicher Schlüssel eingebaut (Updates abgeschaltet).
    NoKey,
    /// Manifest unlesbar oder zu groß.
    Format(String),
    /// Signatur falsch.
    Signature,
    /// Adresse, Name oder Prüfsumme unzulässig.
    Invalid(String),
    /// Datei passt nicht (SHA-256 oder Größe).
    Mismatch,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKey => write!(
                f,
                "Updates sind in diesem Build abgeschaltet (kein Signaturschlüssel eingebaut)."
            ),
            Self::Format(e) => write!(f, "Update-Angaben unlesbar: {e}"),
            Self::Signature => write!(f, "Signatur der Update-Angaben ungültig – abgelehnt."),
            Self::Invalid(e) => write!(f, "Update-Angaben unzulässig: {e}"),
            Self::Mismatch => write!(
                f,
                "Die geladene Datei passt nicht zu den signierten Angaben – verworfen."
            ),
        }
    }
}

/// Öffentlicher Schlüssel aus Base64 (`None`: leer oder ungültig).
#[must_use]
pub fn public_key(text: &str) -> Option<VerifyingKey> {
    let bytes = STANDARD.decode(text.trim()).ok()?;
    let bytes: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

fn valid_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.ends_with(".exe")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.starts_with('.')
}

/// Version als Zahlen (`1.2.3` → `[1, 2, 3]`); `None` bei anderem Format.
#[must_use]
pub fn parse_version(text: &str) -> Option<[u64; 3]> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// Ist `candidate` neuer als `current`?
#[must_use]
pub fn newer(current: &str, candidate: &str) -> bool {
    parse_version(current)
        .zip(parse_version(candidate))
        .is_some_and(|(a, b)| b > a)
}

/// Prüft Signatur und Inhalt von `latest.json` gegen den Schlüssel `key`.
///
/// # Errors
/// Format, Signatur oder Inhalt unzulässig.
pub fn verify_with(bytes: &[u8], key: &VerifyingKey) -> Result<Manifest, Error> {
    if bytes.len() > MAX_MANIFEST {
        return Err(Error::Format("zu groß".into()));
    }
    let signed: Signed = serde_json::from_slice(bytes).map_err(|e| Error::Format(e.to_string()))?;
    let signature: [u8; 64] = STANDARD
        .decode(signed.signature.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(Error::Signature)?;
    key.verify_strict(
        signed.manifest.as_bytes(),
        &Signature::from_bytes(&signature),
    )
    .map_err(|_| Error::Signature)?;
    let manifest: Manifest =
        serde_json::from_str(&signed.manifest).map_err(|e| Error::Format(e.to_string()))?;
    if parse_version(&manifest.version).is_none() {
        return Err(Error::Invalid("Version".into()));
    }
    if manifest.files.is_empty() || manifest.files.len() > 8 {
        return Err(Error::Invalid("Dateien".into()));
    }
    for file in &manifest.files {
        if !valid_name(&file.name)
            || !valid_hex(&file.sha256)
            || file.size == 0
            || file.size > MAX_FILE
            || !file.url.starts_with(RELEASE_PREFIX)
            || !file.url.ends_with(&format!("/{}", file.name))
            || file.url.contains("..")
            || file.url.contains(['?', '#', '\\', ' '])
        {
            return Err(Error::Invalid(file.name.chars().take(60).collect()));
        }
    }
    Ok(manifest)
}

/// Wie [`verify_with`], mit dem eingebauten Schlüssel.
///
/// # Errors
/// Kein Schlüssel eingebaut oder Manifest unzulässig.
pub fn verify(bytes: &[u8]) -> Result<Manifest, Error> {
    let key = public_key(PUBLIC_KEY).ok_or(Error::NoKey)?;
    verify_with(bytes, &key)
}

/// Ist ein Schlüssel eingebaut (Updates möglich)?
#[must_use]
pub fn enabled() -> bool {
    public_key(PUBLIC_KEY).is_some()
}

/// SHA-256 als Hex-Text.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Passt die geladene Datei zur signierten Angabe?
///
/// # Errors
/// Größe oder Prüfsumme weichen ab.
pub fn check_file(bytes: &[u8], artifact: &Artifact) -> Result<(), Error> {
    if u64::try_from(bytes.len()).ok() != Some(artifact.size)
        || sha256_hex(bytes) != artifact.sha256
    {
        return Err(Error::Mismatch);
    }
    Ok(())
}

/// Host und Pfad einer erlaubten Download-Adresse (für den HTTPS-Abruf).
#[must_use]
pub fn host_and_path(url: &str) -> Option<(&'static str, String)> {
    let name = url.strip_prefix(RELEASE_PREFIX)?;
    let ok = !name.is_empty()
        && name.split('/').count() == 2
        && name.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        });
    ok.then(|| {
        (
            "github.com",
            format!("{}{name}", &RELEASE_PREFIX["https://github.com".len()..]),
        )
    })
}

/// Hosts, auf die GitHub Release-Downloads weiterleitet (Inhalt ist trotzdem per Signatur
/// bzw. SHA-256 geprüft; die Liste begrenzt nur, wohin AEGIS sich verbindet).
pub const DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Höchstens so viele Weiterleitungen je Abruf.
pub const MAX_REDIRECTS: usize = 5;

/// Antwort eines einzelnen HTTPS-Abrufs (ohne automatische Weiterleitung).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    /// HTTP-Status.
    pub status: u16,
    /// Inhalt.
    pub body: Vec<u8>,
    /// Ziel bei 3xx.
    pub location: Option<String>,
}

/// Ziel einer Weiterleitung, nur `https` auf einen der [`DOWNLOAD_HOSTS`] (oder ein relativer
/// Pfad auf demselben Host).
#[must_use]
pub fn redirect_target(current_host: &str, location: &str) -> Option<(&'static str, String)> {
    let clean = |p: &str| {
        !p.is_empty()
            && p.starts_with('/')
            && !p.starts_with("//")
            && !p
                .chars()
                .any(|c| c.is_control() || c == ' ' || c == '\\' || c == '#')
    };
    let (host, path) = if let Some(rest) = location.strip_prefix("https://") {
        let (authority, path) = rest.find('/').map_or((rest, "/"), |i| rest.split_at(i));
        let authority = authority.strip_suffix(":443").unwrap_or(authority);
        (authority.to_ascii_lowercase(), path.to_owned())
    } else if location.starts_with('/') {
        (current_host.to_ascii_lowercase(), location.to_owned())
    } else {
        return None;
    };
    let host = DOWNLOAD_HOSTS.into_iter().find(|h| *h == host)?;
    clean(&path).then_some((host, path))
}

/// Ruft `https://<host><path>` ab und folgt höchstens [`MAX_REDIRECTS`] geprüften
/// Weiterleitungen (siehe [`redirect_target`]). `fetch` macht genau einen Abruf.
///
/// # Errors
/// Abruf fehlgeschlagen, Status nicht 200, unzulässige oder zu viele Weiterleitungen.
pub fn get_following(
    host: &str,
    path: &str,
    mut fetch: impl FnMut(&str, &str) -> Result<Fetched, String>,
) -> Result<Vec<u8>, String> {
    let mut host = host.to_owned();
    let mut path = path.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        let response = fetch(&host, &path)?;
        match response.status {
            200 => return Ok(response.body),
            301 | 302 | 303 | 307 | 308 => {
                let (next_host, next_path) = response
                    .location
                    .as_deref()
                    .and_then(|l| redirect_target(&host, l))
                    .ok_or("Unzulässige Weiterleitung.")?;
                next_host.clone_into(&mut host);
                path = next_path;
            }
            status => return Err(format!("Der Server antwortet mit {status}.")),
        }
    }
    Err("Zu viele Weiterleitungen.".into())
}

/// Signieren (nur Release-Werkzeug).
#[cfg(feature = "sign")]
pub mod sign {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use ed25519_dalek::{Signer, SigningKey};

    use super::{Manifest, Signed};

    /// Neues Schlüsselpaar: (geheim, öffentlich), je Base64.
    ///
    /// # Errors
    /// Kein Zufall vom Betriebssystem.
    pub fn keypair() -> Result<(String, String), String> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
        let key = SigningKey::from_bytes(&seed);
        seed.fill(0);
        Ok((
            STANDARD.encode(key.to_bytes()),
            STANDARD.encode(key.verifying_key().to_bytes()),
        ))
    }

    /// Signiert ein Manifest mit dem geheimen Schlüssel (Base64).
    ///
    /// # Errors
    /// Schlüssel ungültig.
    pub fn sign(manifest: &Manifest, secret: &str) -> Result<Signed, String> {
        let bytes: [u8; 32] = STANDARD
            .decode(secret.trim())
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("geheimer Schlüssel ungültig")?;
        let key = SigningKey::from_bytes(&bytes);
        let text = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
        let signature = key.sign(text.as_bytes());
        Ok(Signed {
            manifest: text,
            signature: STANDARD.encode(signature.to_bytes()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn manifest(url: &str) -> Manifest {
        Manifest {
            version: "1.2.0".into(),
            published: "2026-10-20T00:00:00Z".into(),
            notes: "Test".into(),
            files: vec![Artifact {
                kind: Kind::App,
                name: "AEGIS-Suite_1.2.0_x64-setup.exe".into(),
                url: url.into(),
                sha256: sha256_hex(b"harmlos"),
                size: 7,
            }],
        }
    }

    fn signed(m: &Manifest, key: &SigningKey) -> Vec<u8> {
        let text = serde_json::to_string(m).unwrap_or_default();
        let sig = key.sign(text.as_bytes());
        serde_json::to_vec(&Signed {
            manifest: text,
            signature: STANDARD.encode(sig.to_bytes()),
        })
        .unwrap_or_default()
    }

    const URL: &str = "https://github.com/georghatzmann-bit/vanity-/releases/download/v1.2.0/AEGIS-Suite_1.2.0_x64-setup.exe";

    #[test]
    fn nur_richtig_signierte_manifeste() {
        let k = key();
        let m = manifest(URL);
        let ok = verify_with(&signed(&m, &k), &k.verifying_key()).unwrap();
        assert_eq!(ok, m);
        // Anderer Schlüssel, verändertes Manifest: abgelehnt.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert_eq!(
            verify_with(&signed(&m, &other), &k.verifying_key()),
            Err(Error::Signature)
        );
        let mut tampered: Signed = serde_json::from_slice(&signed(&m, &k)).unwrap();
        tampered.manifest = tampered.manifest.replace("1.2.0", "9.9.9");
        assert_eq!(
            verify_with(&serde_json::to_vec(&tampered).unwrap(), &k.verifying_key()),
            Err(Error::Signature)
        );
    }

    #[test]
    fn nur_eigene_release_adressen_und_passende_dateien() {
        let k = key();
        for bad in [
            "https://evil.example/AEGIS-Suite_1.2.0_x64-setup.exe",
            "http://github.com/georghatzmann-bit/vanity-/releases/download/v1/AEGIS-Suite_1.2.0_x64-setup.exe",
            "https://github.com/georghatzmann-bit/vanity-/releases/download/../x/AEGIS-Suite_1.2.0_x64-setup.exe",
            "https://github.com/georghatzmann-bit/vanity-/releases/download/v1/anders.exe",
        ] {
            assert!(
                matches!(
                    verify_with(&signed(&manifest(bad), &k), &k.verifying_key()),
                    Err(Error::Invalid(_))
                ),
                "{bad}"
            );
        }
        let m = manifest(URL);
        assert!(check_file(b"harmlos", &m.files[0]).is_ok());
        assert_eq!(check_file(b"harmlos!", &m.files[0]), Err(Error::Mismatch));
        assert_eq!(
            host_and_path(URL),
            Some((
                "github.com",
                URL.strip_prefix("https://github.com")
                    .unwrap_or_default()
                    .to_owned()
            ))
        );
        for bad in [
            "..",
            "v1/../x.exe",
            "v1/x.exe?y",
            "v1/a/b.exe",
            "v1/",
            "v1/x%2F.exe",
        ] {
            assert_eq!(
                host_and_path(&format!("{RELEASE_PREFIX}{bad}")),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn weiterleitungen_nur_zu_github() {
        assert_eq!(
            redirect_target(
                "github.com",
                "https://objects.githubusercontent.com/a/b?x=1&y=%2F"
            ),
            Some(("objects.githubusercontent.com", "/a/b?x=1&y=%2F".to_owned()))
        );
        assert_eq!(
            redirect_target(
                "github.com",
                "/georghatzmann-bit/vanity-/releases/download/v1/x"
            ),
            Some((
                "github.com",
                "/georghatzmann-bit/vanity-/releases/download/v1/x".to_owned()
            ))
        );
        assert_eq!(
            redirect_target("github.com", "https://GitHub.com:443/x"),
            Some(("github.com", "/x".to_owned()))
        );
        for bad in [
            "http://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://user@github.com/x",
            "https://github.com:8443/x",
            "//evil.example/x",
            "https://github.com/a b",
            "https://github.com/a\\b",
            "ftp://github.com/x",
            "x",
        ] {
            assert_eq!(redirect_target("github.com", bad), None, "{bad}");
        }
        // Relativ nur auf erlaubtem Host.
        assert_eq!(redirect_target("evil.example", "/x"), None);
    }

    #[test]
    fn abruf_folgt_hoechstens_fuenf_weiterleitungen() {
        let hop = |location: &str| Fetched {
            status: 302,
            body: Vec::new(),
            location: Some(location.to_owned()),
        };
        let mut calls = Vec::new();
        let body = get_following("github.com", "/a", |h, p| {
            calls.push(format!("{h}{p}"));
            Ok(if h == "github.com" {
                hop("https://objects.githubusercontent.com/b")
            } else {
                Fetched {
                    status: 200,
                    body: b"ok".to_vec(),
                    location: None,
                }
            })
        });
        assert_eq!(body, Ok(b"ok".to_vec()));
        assert_eq!(calls, ["github.com/a", "objects.githubusercontent.com/b"]);
        let mut count = 0;
        let endless = get_following("github.com", "/a", |_, _| {
            count += 1;
            Ok(hop("/a"))
        });
        assert!(endless.is_err());
        assert_eq!(count, MAX_REDIRECTS + 1);
        assert!(
            get_following("github.com", "/a", |_, _| Ok(hop("https://evil.example/"))).is_err()
        );
        assert!(
            get_following("github.com", "/a", |_, _| Ok(Fetched {
                status: 404,
                body: Vec::new(),
                location: None
            }))
            .is_err()
        );
    }

    #[test]
    fn versionen() {
        assert!(newer("0.1.0", "0.2.0"));
        assert!(newer("0.9.9", "1.0.0"));
        assert!(!newer("1.0.0", "1.0.0"));
        assert!(!newer("1.0.0", "0.9.0"));
        assert!(!newer("1.0.0", "1.0"));
        assert_eq!(parse_version("v2.10.3"), Some([2, 10, 3]));
    }

    #[test]
    fn ohne_schluessel_keine_updates() {
        assert!(public_key("").is_none());
        assert!(public_key("kein-base64!").is_none());
    }
}
