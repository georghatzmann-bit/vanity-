//! Signierte Updates (P13): Nur auf Klick wird das Manifest der neuesten Version geladen
//! (HTTPS, GitHub Releases), seine Ed25519-Signatur gegen den eingebauten Schlüssel geprüft,
//! die Datei geladen und gegen SHA-256 und Größe geprüft. Installiert wird erst nach
//! „Jetzt installieren“ – unmittelbar davor wird die Datei erneut geprüft. Sie liegt in einem
//! neuen, zufällig benannten Ordner und bleibt vom Speichern bis zum Start gegen Austausch
//! gesperrt (eigenes Handle, andere dürfen nur lesen). Zu alte Angaben werden abgelehnt.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use aegis_update::{Kind, Manifest};
use serde::Serialize;

/// Geprüft gespeichertes Installationsprogramm (Handle hält die Sperre).
#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Downloaded {
    path: PathBuf,
    file: std::fs::File,
}

#[derive(Debug, Default)]
struct State {
    manifest: Option<Manifest>,
    downloaded: Option<Downloaded>,
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
    /// Veröffentlicht am (`JJJJ-MM-TT`).
    published: Option<String>,
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
        published: s.manifest.as_ref().map(|m| m.published.clone()),
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
        let manifest = aegis_update::verify(&body).map_err(|e| e.to_string())?;
        if !aegis_update::fresh(&manifest.published, &aegis_update::today()) {
            return Err(format!(
                "Die Update-Angaben stammen vom {} und sind damit zu alt (oder das Datum stimmt nicht) – möglicherweise eine veraltete Kopie. Bitte später erneut versuchen.",
                manifest.published
            ));
        }
        Ok(manifest)
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
    let downloaded = tauri::async_runtime::spawn_blocking(move || download(&artifact))
        .await
        .map_err(|e| e.to_string())??;
    state().downloaded = Some(downloaded);
    Ok(view(&current(&app)))
}

fn download(artifact: &aegis_update::Artifact) -> Result<Downloaded, String> {
    #[cfg(windows)]
    {
        let (host, path) =
            aegis_update::host_and_path(&artifact.url).ok_or("Unzulässige Adresse.")?;
        let limit = usize::try_from(artifact.size).map_err(|e| e.to_string())?;
        let body = aegis_update::get_following(host, &path, |host, path| {
            fetch(host, path, limit, 600_000)
        })?;
        aegis_update::check_file(&body, artifact).map_err(|e| e.to_string())?;
        let (path, file) = store_locked(&body, artifact)?;
        Ok(Downloaded { path, file })
    }
    #[cfg(not(windows))]
    {
        let _ = artifact;
        Err("Updates gibt es nur unter Windows.".into())
    }
}

/// Speichert das geprüfte Installationsprogramm in einem neuen, zufällig benannten Ordner des
/// Temp-Ordners – in einer neuen Datei, die gegen Austausch gesperrt bleibt, solange das
/// zurückgegebene Handle offen ist – und prüft es aus dieser Datei erneut.
#[cfg(windows)]
fn store_locked(
    body: &[u8],
    artifact: &aegis_update::Artifact,
) -> Result<(PathBuf, std::fs::File), String> {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write(artifact.sha256.as_bytes());
    hasher.write_u32(std::process::id());
    let dir = std::env::temp_dir().join(format!("AEGIS-Update-{:016x}", hasher.finish()));
    // Neuer eigener Ordner (schlägt fehl, wenn es ihn schon gibt – kein fremder Ordner).
    // aegis-mutation: update-download-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&artifact.name);
    let mut file = aegis_winffi::fs::create_locked(&path).map_err(|e| e.to_string())?;
    aegis_update::store_checked(&mut file, body, artifact)?;
    drop(file);
    // Für den Start nur lesend neu öffnen (ein Handle mit Schreibrecht verhindert den Start)
    // – weiter gegen Austausch gesperrt – und aus diesem Handle erneut prüfen.
    let mut file = aegis_winffi::fs::open_read_locked(&path).map_err(|e| e.to_string())?;
    aegis_update::recheck(&mut file, artifact)?;
    Ok((path, file))
}

/// Startet das geprüfte Installationsprogramm (der Nutzer hat „Jetzt installieren“ gewählt)
/// als Update (`/UPDATE`: Dateien ersetzen, keine Deinstallation, Daten bleiben) und beendet
/// die App, damit ihre Dateien ersetzt werden können.
#[tauri::command]
pub fn update_install<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let mut s = state();
    let artifact = s
        .manifest
        .as_ref()
        .and_then(|m| m.files.iter().find(|f| f.kind == Kind::App).cloned())
        .ok_or("Kein geprüftes Update geladen.")?;
    let downloaded = s
        .downloaded
        .as_mut()
        .ok_or("Kein geprüftes Update geladen.")?;
    // Unmittelbar vor dem Start erneut prüfen – aus der gesperrten Datei selbst.
    aegis_update::recheck(&mut downloaded.file, &artifact)?;
    #[cfg(windows)]
    {
        aegis_winffi::shell::launch(&downloaded.path, "/UPDATE").map_err(|e| e.to_string())?;
        drop(s);
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        drop(s);
        let _ = app;
        Err("Updates gibt es nur unter Windows.".into())
    }
}
