//! Signierte Updates (P13): Nur auf Klick wird das Manifest der neuesten Version geladen
//! (HTTPS, GitHub Releases), seine Ed25519-Signatur gegen den eingebauten Schlüssel geprüft,
//! die Datei geladen und gegen SHA-256 und Größe geprüft. Installiert wird erst nach
//! „Jetzt installieren“ – unmittelbar davor wird die Datei erneut geprüft.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use aegis_update::{Kind, Manifest};
use serde::Serialize;

#[derive(Debug, Default)]
struct State {
    manifest: Option<Manifest>,
    downloaded: Option<PathBuf>,
}

static STATE: Mutex<State> = Mutex::new(State {
    manifest: None,
    downloaded: None,
});

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Stand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    /// Updates in diesem Build möglich (Schlüssel eingebaut)?
    enabled: bool,
    /// Laufende Version.
    current: String,
    /// Neueste Version laut signiertem Manifest.
    latest: Option<String>,
    /// Hinweise zur neuesten Version.
    notes: String,
    /// Neuer als die laufende?
    newer: bool,
    /// Geprüft heruntergeladen?
    ready: bool,
}

fn view(current: &str) -> UpdateView {
    let s = state();
    let latest = s.manifest.as_ref().map(|m| m.version.clone());
    UpdateView {
        enabled: aegis_update::enabled(),
        current: current.to_owned(),
        newer: latest
            .as_deref()
            .is_some_and(|l| aegis_update::newer(current, l)),
        notes: s
            .manifest
            .as_ref()
            .map(|m| {
                m.notes
                    .chars()
                    .filter(|c| !c.is_control() || *c == '\n')
                    .take(2000)
                    .collect()
            })
            .unwrap_or_default(),
        latest,
        ready: s.downloaded.is_some(),
    }
}

fn current<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// Stand ohne Netz (was zuletzt geprüft wurde).
#[tauri::command]
pub fn update_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> UpdateView {
    view(&current(&app))
}

/// Lädt und prüft das signierte Manifest der neuesten Version (nur auf Klick).
#[tauri::command]
pub async fn update_check<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateView, String> {
    if !aegis_update::enabled() {
        return Ok(view(&current(&app)));
    }
    let manifest = tauri::async_runtime::spawn_blocking(fetch_manifest)
        .await
        .map_err(|e| e.to_string())??;
    {
        let mut s = state();
        s.manifest = Some(manifest);
        s.downloaded = None;
    }
    Ok(view(&current(&app)))
}

fn fetch_manifest() -> Result<Manifest, String> {
    #[cfg(windows)]
    {
        let body = aegis_update::get_following(
            aegis_update::MANIFEST_HOST,
            aegis_update::MANIFEST_PATH,
            |host, path| fetch(host, path, aegis_update::MAX_MANIFEST, 20_000),
        )?;
        aegis_update::verify(&body).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Updates gibt es nur unter Windows.".into())
    }
}

/// Ein einzelner HTTPS-Abruf ohne automatische Weiterleitung.
#[cfg(windows)]
fn fetch(
    host: &str,
    path: &str,
    limit: usize,
    timeout_ms: i32,
) -> Result<aegis_update::Fetched, String> {
    let response = aegis_winffi::http::https_get(host, path, &[], limit, timeout_ms)
        .map_err(|e| format!("Keine Verbindung zu {host}: {e}"))?;
    Ok(aegis_update::Fetched {
        status: response.status,
        body: response.body,
        location: response.location,
    })
}

/// Lädt das Installationsprogramm der neuesten Version und prüft SHA-256 und Größe.
#[tauri::command]
pub async fn update_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateView, String> {
    let manifest = state()
        .manifest
        .clone()
        .ok_or("Bitte zuerst nach Updates suchen.")?;
    if !aegis_update::newer(&current(&app), &manifest.version) {
        return Err("Es gibt keine neuere Version.".into());
    }
    let artifact = manifest
        .files
        .iter()
        .find(|f| f.kind == Kind::App)
        .cloned()
        .ok_or("Das Update enthält kein Installationsprogramm.")?;
    let path = tauri::async_runtime::spawn_blocking(move || download(&artifact))
        .await
        .map_err(|e| e.to_string())??;
    state().downloaded = Some(path);
    Ok(view(&current(&app)))
}

fn download(artifact: &aegis_update::Artifact) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        let (host, path) =
            aegis_update::host_and_path(&artifact.url).ok_or("Unzulässige Adresse.")?;
        let limit = usize::try_from(artifact.size).map_err(|e| e.to_string())?;
        let body = aegis_update::get_following(host, &path, |host, path| {
            fetch(host, path, limit, 600_000)
        })?;
        aegis_update::check_file(&body, artifact).map_err(|e| e.to_string())?;
        let dir = std::env::temp_dir().join(format!(
            "AEGIS-Update-{}",
            aegis_update::sha256_hex(artifact.sha256.as_bytes())
                .get(..16)
                .unwrap_or_default()
        ));
        // Eigener Ordner für das geprüfte Installationsprogramm.
        // aegis-mutation: update-download-dir
        #[allow(clippy::disallowed_methods)]
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(format!("{}-{}", std::process::id(), artifact.name));
        // Neue Datei mit dem geprüften Inhalt (nie überschreiben).
        // aegis-mutation: update-download-write
        #[allow(clippy::disallowed_methods)]
        let mut file = std::fs::File::create_new(&target).map_err(|e| e.to_string())?;
        file.write_all(&body)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(target)
    }
    #[cfg(not(windows))]
    {
        let _ = artifact;
        Err("Updates gibt es nur unter Windows.".into())
    }
}

/// Startet das geprüfte Installationsprogramm (der Nutzer hat „Jetzt installieren“ gewählt)
/// und beendet die App, damit ihre Dateien ersetzt werden können.
#[tauri::command]
pub fn update_install<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let (path, artifact) = {
        let s = state();
        let path = s
            .downloaded
            .clone()
            .ok_or("Kein geprüftes Update geladen.")?;
        let artifact = s
            .manifest
            .as_ref()
            .and_then(|m| m.files.iter().find(|f| f.kind == Kind::App).cloned())
            .ok_or("Kein geprüftes Update geladen.")?;
        (path, artifact)
    };
    // Unmittelbar vor dem Start erneut prüfen (die Datei liegt im Temp-Ordner des Kontos).
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    aegis_update::check_file(&bytes, &artifact).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        aegis_winffi::shell::launch(&path, "").map_err(|e| e.to_string())?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Updates gibt es nur unter Windows.".into())
    }
}
