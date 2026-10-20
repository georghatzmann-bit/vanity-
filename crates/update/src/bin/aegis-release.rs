//! Release-Werkzeug (nur für den Herausgeber, nicht Teil der App):
//!
//! ```text
//! aegis-release keygen <geheime-datei>
//!     Erzeugt ein Schlüsselpaar. Der geheime Schlüssel kommt in eine NEUE Datei (nie
//!     überschrieben, nie einchecken!), der öffentliche wird ausgegeben – er gehört nach
//!     release/update-public.key.
//! aegis-release sign <geheime-datei> <version> <tag> <datei.exe>...
//!     Gibt latest.json (signiertes Manifest) aus: SHA-256 und Größe je Datei, Adressen unter
//!     https://github.com/georghatzmann-bit/vanity-/releases/download/<tag>/<name>.
//!     Art nach Dateiname: `AEGIS-Setup*` = Setup, `AEGIS-Browser*` = Browser, sonst App.
//! ```
#![forbid(unsafe_code)]

use std::path::Path;

use aegis_update::{Artifact, Kind, Manifest, RELEASE_PREFIX, sha256_hex, sign, valid_name};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("keygen") if args.len() == 2 => keygen(Path::new(&args[1])),
        Some("sign") if args.len() >= 5 => sign_files(&args[1], &args[2], &args[3], &args[4..]),
        _ => Err("Aufruf: aegis-release keygen <geheime-datei> | aegis-release sign <geheime-datei> <version> <tag> <datei.exe>...".to_owned()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn keygen(secret_path: &Path) -> Result<(), String> {
    use std::io::Write;
    let (secret, public) = sign::keypair()?;
    let mut options = std::fs::OpenOptions::new();
    // Neue Datei (nie überschreiben) für den geheimen Schlüssel.
    // aegis-mutation: release-keygen-options
    #[allow(clippy::disallowed_methods)]
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        // Nur für den Eigentümer lesbar.
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Neue Datei für den geheimen Schlüssel des Herausgebers (nie überschreiben).
    // aegis-mutation: release-keygen-secret
    #[allow(clippy::disallowed_methods)]
    let mut file = options
        .open(secret_path)
        .map_err(|e| format!("{}: {e} (Datei existiert schon?)", secret_path.display()))?;
    file.write_all(secret.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())?;
    println!("{public}");
    eprintln!(
        "Öffentlicher Schlüssel oben → release/update-public.key. Geheimen Schlüssel sicher aufbewahren, nie einchecken."
    );
    Ok(())
}

fn sign_files(secret_path: &str, version: &str, tag: &str, files: &[String]) -> Result<(), String> {
    if aegis_update::parse_version(version).is_none() {
        return Err("Version muss die Form 1.2.3 haben.".into());
    }
    if tag.is_empty()
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Ungültiger Tag.".into());
    }
    let secret = std::fs::read_to_string(secret_path).map_err(|e| e.to_string())?;
    let mut artifacts = Vec::new();
    for file in files {
        let path = Path::new(file);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or("Dateiname fehlt")?;
        if !valid_name(&name) {
            return Err(format!(
                "{name}: Dateiname nur mit Buchstaben, Ziffern und ._- und Endung .exe (z. B. AEGIS-Suite-0.2.0-x64-setup.exe)."
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{file}: {e}"))?;
        let lower = name.to_ascii_lowercase();
        let kind = if lower.starts_with("aegis-setup") {
            Kind::Setup
        } else if lower.starts_with("aegis-browser") {
            Kind::Browser
        } else {
            Kind::App
        };
        artifacts.push(Artifact {
            kind,
            url: format!("{RELEASE_PREFIX}{tag}/{name}"),
            name,
            sha256: sha256_hex(&bytes),
            size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        });
    }
    let manifest = Manifest {
        version: version.to_owned(),
        published: aegis_update::today(),
        notes: String::new(),
        files: artifacts,
    };
    let signed = sign::sign(&manifest, &secret)?;
    // Selbstprüfung: Das Ergebnis muss die Prüfung der App bestehen.
    let public = aegis_update::public_key(&sign::public_of(&secret)?)
        .ok_or("öffentlicher Schlüssel ungültig")?;
    let bytes = serde_json::to_vec(&signed).map_err(|e| e.to_string())?;
    aegis_update::verify_with(&bytes, &public).map_err(|e| format!("Selbstprüfung: {e}"))?;
    if aegis_update::public_key(aegis_update::PUBLIC_KEY).is_some_and(|k| k != public) {
        eprintln!(
            "Achtung: Der Schlüssel passt nicht zu release/update-public.key – diese Angaben würde die App ablehnen."
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?
    );
    Ok(())
}
