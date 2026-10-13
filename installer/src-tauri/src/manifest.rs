//! Manifest (`latest.json`): Adresse bestimmen, laden (http/https, file://, lokaler Pfad), prüfen,
//! relative `app.url` auflösen.

use crate::config::{config, MANIFEST_ENV, SETUP_OVERRIDE_FILE};
use crate::types::{Manifest, ManifestFile};
use crate::util::tr;
use reqwest::Url;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// Ort einer Ressource: Web-Adresse oder lokale Datei.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Http(Url),
    File(PathBuf),
}

fn has_prefix_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix))
}

impl Location {
    /// `http(s)://…`, `file://…` oder ein Dateipfad (relativ zu `base_dir`, sonst zum Arbeitsordner).
    pub fn parse(raw: &str, base_dir: Option<&Path>) -> Result<Location, String> {
        let s = raw.trim().trim_matches('"').trim();
        if s.is_empty() {
            return Err(tr("Keine Manifest-Adresse angegeben.", "No manifest address configured."));
        }
        if has_prefix_ci(s, "http://") || has_prefix_ci(s, "https://") {
            return Url::parse(s)
                .map(Location::Http)
                .map_err(|_| format!("{}: {s}", tr("Ungültige Adresse", "Invalid address")));
        }
        if has_prefix_ci(s, "file:") {
            let url = Url::parse(s).map_err(|_| format!("{}: {s}", tr("Ungültiger Dateilink", "Invalid file link")))?;
            return url
                .to_file_path()
                .map(Location::File)
                .map_err(|_| format!("{}: {s}", tr("Ungültiger Dateilink", "Invalid file link")));
        }
        let p = PathBuf::from(s);
        let abs = if p.is_absolute() {
            p
        } else if let Some(base) = base_dir {
            base.join(p)
        } else {
            std::path::absolute(&p).unwrap_or(p)
        };
        Ok(Location::File(crate::util::lexical_normalize(&abs)))
    }

    /// Löst eine (evtl. relative) Referenz relativ zu diesem Ort auf.
    pub fn join(&self, reference: &str) -> Result<Location, String> {
        let r = reference.trim();
        if r.is_empty() {
            return Err(tr("Das Manifest enthält keine Download-Adresse.", "The manifest contains no download address."));
        }
        if has_prefix_ci(r, "http://") || has_prefix_ci(r, "https://") || has_prefix_ci(r, "file:") {
            return Location::parse(r, None);
        }
        match self {
            Location::Http(base) => base
                .join(r)
                .map(Location::Http)
                .map_err(|_| format!("{}: {r}", tr("Ungültige Download-Adresse", "Invalid download address"))),
            Location::File(path) => {
                let rp = Path::new(r);
                if rp.is_absolute() {
                    return Ok(Location::File(rp.to_path_buf()));
                }
                // Auch URL-artige Trenner (`sub/Pulsar.exe`) zulassen.
                let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
                let mut out = parent;
                for part in r.split(['/', '\\']) {
                    out.push(part);
                }
                Ok(Location::File(crate::util::lexical_normalize(&out)))
            }
        }
    }

    /// Adresse als Text (`https://…` bzw. `file:///…`).
    pub fn to_url_string(&self) -> String {
        match self {
            Location::Http(u) => u.to_string(),
            Location::File(p) => Url::from_file_path(p).map(|u| u.to_string()).unwrap_or_else(|_| p.to_string_lossy().into_owned()),
        }
    }

    pub fn is_loopback(&self) -> bool {
        match self {
            Location::Http(u) => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")),
            Location::File(_) => false,
        }
    }
}

/// Woher die Manifest-Adresse stammt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestOrigin {
    CommandLine,
    Environment,
    OverrideFile,
    Embedded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestSource {
    pub location: String,
    pub origin: ManifestOrigin,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverrideFile {
    #[serde(default)]
    manifest_url: Option<String>,
}

/// Reihenfolge: `--manifest` → `PULSAR_MANIFEST_URL` → `pulsar-setup.json` neben der Exe → eingebettet.
pub fn resolve_manifest_source(cli: Option<&str>, env: Option<&str>, exe_dir: Option<&Path>, embedded: &str) -> ManifestSource {
    if let Some(v) = cli.map(str::trim).filter(|v| !v.is_empty()) {
        return ManifestSource { location: absolutize(v, None), origin: ManifestOrigin::CommandLine };
    }
    if let Some(v) = env.map(str::trim).filter(|v| !v.is_empty()) {
        return ManifestSource { location: absolutize(v, None), origin: ManifestOrigin::Environment };
    }
    if let Some(dir) = exe_dir {
        let file = dir.join(SETUP_OVERRIDE_FILE);
        if let Ok(text) = std::fs::read_to_string(&file) {
            match serde_json::from_str::<OverrideFile>(text.trim_start_matches('\u{feff}')) {
                Ok(OverrideFile { manifest_url: Some(v) }) if !v.trim().is_empty() => {
                    return ManifestSource { location: absolutize(v.trim(), Some(dir)), origin: ManifestOrigin::OverrideFile };
                }
                Ok(_) => {}
                Err(e) => crate::util::log(format!("{} ignoriert: {e}", file.display())),
            }
        }
    }
    ManifestSource { location: embedded.trim().to_string(), origin: ManifestOrigin::Embedded }
}

/// Relative Dateipfade absolut machen, damit sie auch nach einem Neustart (UAC) stimmen.
fn absolutize(v: &str, base: Option<&Path>) -> String {
    match Location::parse(v, base) {
        Ok(Location::File(p)) => p.to_string_lossy().into_owned(),
        _ => v.to_string(),
    }
}

/// Manifest-Adresse für diesen Prozess.
pub fn manifest_source_for_process(cli: Option<&str>) -> ManifestSource {
    let env = std::env::var(MANIFEST_ENV).ok();
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    resolve_manifest_source(cli, env.as_deref(), exe_dir.as_deref(), &config().manifest_url)
}

/// Fehler beim Laden des Manifests: `code` ist `network` oder `manifest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub code: &'static str,
    pub message: String,
}

impl FetchError {
    fn manifest(message: impl Into<String>) -> Self {
        Self { code: "manifest", message: message.into() }
    }
    fn network(message: impl Into<String>) -> Self {
        Self { code: "network", message: message.into() }
    }
}

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// HTTP-Client mit 20 s Verbindungs-Timeout und automatischen Weiterleitungen.
pub fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .user_agent(format!("PulsarSetup/{}", crate::config::setup_version()))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("{}: {e}", tr("HTTP-Client konnte nicht erstellt werden", "Could not create HTTP client")))
}

/// Gemeinsamer Client für die App (wird einmal erzeugt).
pub fn shared_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = build_client()?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

/// Verständliche Kurzmeldung für Netzwerkfehler.
pub fn describe_network_error(e: &reqwest::Error) -> String {
    crate::util::log(format!("Netzwerkfehler: {e:?}"));
    if e.is_timeout() {
        tr("Zeitüberschreitung – der Server antwortet nicht.", "Timed out – the server is not responding.")
    } else if e.is_connect() {
        tr(
            "Keine Verbindung zum Server. Bitte die Internetverbindung prüfen.",
            "Could not connect to the server. Please check your internet connection.",
        )
    } else if e.is_redirect() {
        tr("Zu viele Weiterleitungen.", "Too many redirects.")
    } else if e.is_body() || e.is_decode() {
        tr("Die Verbindung wurde unterbrochen.", "The connection was interrupted.")
    } else {
        tr("Netzwerkfehler.", "Network error.")
    }
}

/// Lädt und prüft das Manifest. `app.url` ist danach immer absolut.
pub async fn fetch_manifest(client: &reqwest::Client, location: &Location) -> Result<Manifest, FetchError> {
    let bytes = match location {
        Location::File(path) => match tokio::fs::read(path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(FetchError::manifest(format!(
                    "{}: {}",
                    tr("Manifest-Datei nicht gefunden", "Manifest file not found"),
                    path.display()
                )))
            }
            Err(e) => {
                return Err(FetchError::manifest(format!(
                    "{}: {e}",
                    tr("Manifest-Datei konnte nicht gelesen werden", "Could not read manifest file")
                )))
            }
        },
        Location::Http(url) => {
            let resp = client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json, */*")
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .send()
                .await
                .map_err(|e| FetchError::network(describe_network_error(&e)))?;
            let status = resp.status();
            if !status.is_success() {
                let code = status.as_u16();
                let msg = if code == 404 {
                    tr(
                        "Update-Informationen wurden nicht gefunden (HTTP 404).",
                        "Update information was not found (HTTP 404).",
                    )
                } else {
                    format!("{} (HTTP {code}).", tr("Der Update-Server meldet einen Fehler", "The update server returned an error"))
                };
                return Err(if status.is_server_error() || code == 408 || code == 429 {
                    FetchError::network(msg)
                } else {
                    FetchError::manifest(msg)
                });
            }
            if resp.content_length().is_some_and(|l| l as usize > MAX_MANIFEST_BYTES) {
                return Err(FetchError::manifest(tr("Das Manifest ist zu groß.", "The manifest is too large.")));
            }
            resp.bytes().await.map_err(|e| FetchError::network(describe_network_error(&e)))?.to_vec()
        }
    };
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(FetchError::manifest(tr("Das Manifest ist zu groß.", "The manifest is too large.")));
    }
    parse_manifest(&bytes, location)
}

/// Prüft das JSON und löst `app.url` relativ zum Manifest-Ort auf.
pub fn parse_manifest(bytes: &[u8], location: &Location) -> Result<Manifest, FetchError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}').trim();
    let invalid = |detail: String| {
        FetchError::manifest(format!("{} ({detail})", tr("Das Manifest ist ungültig", "The manifest is invalid")))
    };
    let mut m: Manifest = serde_json::from_str(text).map_err(|e| invalid(e.to_string()))?;
    m.version = m.version.trim().to_string();
    if m.version.is_empty() {
        return Err(invalid("version".into()));
    }
    if m.app.url.trim().is_empty() {
        return Err(invalid("app.url".into()));
    }
    m.app.sha256 = m.app.sha256.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    if let Some(h) = &m.app.sha256 {
        if h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid("app.sha256".into()));
        }
    }
    m.app.size = m.app.size.filter(|s| *s > 0);
    let resolved = location.join(&m.app.url).map_err(FetchError::manifest)?;
    m.app = ManifestFile { url: resolved.to_url_string(), ..m.app };
    Ok(m)
}
