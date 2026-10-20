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

use aegis_update::{Artifact, Kind, Manifest, RELEASE_PREFIX, sha256_hex, sign};

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
    // Neue Datei für den geheimen Schlüssel des Herausgebers (nie überschreiben).
    // aegis-mutation: release-keygen-secret
    #[allow(clippy::disallowed_methods)]
    let mut file = std::fs::File::create_new(secret_path)
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
        if !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        {
            return Err(format!(
                "{name}: Dateiname nur mit Buchstaben, Ziffern und ._-+ (z. B. AEGIS-Suite-0.2.0-x64-setup.exe)."
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
        published: String::new(),
        notes: String::new(),
        files: artifacts,
    };
    let signed = sign::sign(&manifest, &secret)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?
    );
    Ok(())
}
