//! Ablauf des Setups: signierte Angaben holen, gewählte Pakete laden und prüfen, die geprüften
//! Installationsprogramme nach „Installieren“ starten. Nichts passiert ohne Klick; jede Datei
//! wird vor dem Start erneut gegen die signierte Prüfsumme geprüft.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use aegis_update::{Artifact, Kind, Manifest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Ordnername unter „Programme“.
pub const PRODUCT_DIR: &str = "AEGIS Suite";
/// Programmdatei der App im Installationsordner.
pub const APP_EXE: &str = "aegis.exe";

#[derive(Debug, Default)]
struct State {
    manifest: Option<Manifest>,
    /// Geprüft geladene Dateien (Art, Pfad, signierte Angabe).
    downloaded: Vec<(Kind, PathBuf, Artifact)>,
    /// Installationsordner nach erfolgreicher Installation.
    installed: Option<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard: MutexGuard<'_, Option<State>> =
        STATE.lock().unwrap_or_else(PoisonError::into_inner);
    f(guard.get_or_insert_with(State::default))
}

/// Grundangaben für die erste Seite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// Version des Setups.
    version: String,
    /// Signaturschlüssel eingebaut (sonst kann das Setup nichts prüfen und lädt nichts).
    enabled: bool,
    /// Vorschlag für den Installationsordner.
    default_dir: String,
    /// Windows (nur dort wird installiert).
    windows: bool,
}

/// Ein ladbares Paket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    kind: &'static str,
    name: String,
    size: u64,
}

/// Was die signierten Angaben anbieten.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    version: String,
    notes: String,
    components: Vec<Component>,
}

/// Fortschritt beim Laden.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    name: String,
    done: u64,
    total: u64,
    /// `download`, `verify`, `ok`.
    stage: &'static str,
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::App => "app",
        Kind::Browser => "browser",
        Kind::Setup => "setup",
    }
}

fn default_dir() -> PathBuf {
    let base = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
    base.join(PRODUCT_DIR)
}

/// Prüft den gewünschten Installationsordner: absoluter Pfad auf einem Laufwerk (`X:\…`),
/// keine Anführungszeichen, Steuerzeichen oder unzulässigen Zeichen, nicht zu lang. NSIS nimmt
/// `/D=` als letztes Argument ohne Anführungszeichen – deshalb so streng.
///
/// # Errors
/// Pfad unzulässig.
pub fn install_dir(text: &str) -> Result<PathBuf, String> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    if !drive {
        return Err(
            "Bitte einen vollständigen Ordner wie C:\\Programme\\AEGIS Suite angeben.".into(),
        );
    }
    if text.len() > 200
        || text
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '?' | '*' | '/'))
        || text[2..].contains(':')
        || text.split('\\').any(|part| part == ".." || part == ".")
        || text.ends_with(' ')
        || text.ends_with('.')
    {
        return Err("Dieser Ordnername ist nicht zulässig.".into());
    }
    Ok(PathBuf::from(text.trim_end_matches('\\')))
}

/// Angaben für die erste Seite.
#[tauri::command]
pub fn setup_info<R: Runtime>(app: AppHandle<R>) -> Info {
    Info {
        version: app.package_info().version.to_string(),
        enabled: aegis_update::enabled(),
        default_dir: default_dir().display().to_string(),
        windows: cfg!(windows),
    }
}

/// Holt und prüft die signierten Angaben der neuesten Version (Netz nur nach Klick).
#[tauri::command]
pub async fn setup_check() -> Result<Offer, String> {
    if !aegis_update::enabled() {
        return Err("Dieses Setup wurde ohne Signaturschlüssel gebaut und kann Downloads nicht prüfen. Lade das Installationsprogramm direkt von der Release-Seite.".into());
    }
    let manifest = tauri::async_runtime::spawn_blocking(fetch_manifest)
        .await
        .map_err(|e| e.to_string())??;
    let offer = Offer {
        version: manifest.version.clone(),
        notes: manifest.notes.clone(),
        components: manifest
            .files
            .iter()
            .filter(|f| matches!(f.kind, Kind::App | Kind::Browser))
            .map(|f| Component {
                kind: kind_name(f.kind),
                name: f.name.clone(),
                size: f.size,
            })
            .collect(),
    };
    if !offer.components.iter().any(|c| c.kind == "app") {
        return Err("Die Angaben enthalten kein Installationsprogramm.".into());
    }
    with_state(|s| {
        s.manifest = Some(manifest);
        s.downloaded.clear();
    });
    Ok(offer)
}

#[cfg(windows)]
fn fetch(
    host: &str,
    path: &str,
    limit: usize,
    timeout_ms: i32,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<aegis_update::Fetched, String> {
    let response =
        aegis_winffi::http::https_get_progress(host, path, &[], limit, timeout_ms, progress)
            .map_err(|e| format!("Keine Verbindung zu {host}: {e}"))?;
    Ok(aegis_update::Fetched {
        status: response.status,
        body: response.body,
        location: response.location,
    })
}

fn fetch_manifest() -> Result<Manifest, String> {
    #[cfg(windows)]
    {
        let body = aegis_update::get_following(
            aegis_update::MANIFEST_HOST,
            aegis_update::MANIFEST_PATH,
            |host, path| {
                fetch(
                    host,
                    path,
                    aegis_update::MAX_MANIFEST,
                    20_000,
                    &mut |_, _| (),
                )
            },
        )?;
        aegis_update::verify(&body).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Das Setup installiert nur unter Windows.".into())
    }
}

/// Lädt die gewählten Pakete (immer die App, auf Wunsch den Browser) und prüft jedes gegen
/// Größe und SHA-256 der signierten Angaben. Fortschritt als `setup://progress`.
#[tauri::command]
pub async fn setup_download<R: Runtime>(app: AppHandle<R>, browser: bool) -> Result<(), String> {
    let manifest = with_state(|s| s.manifest.clone()).ok_or("Bitte zuerst die Angaben laden.")?;
    let wanted: Vec<Artifact> = manifest
        .files
        .iter()
        .filter(|f| f.kind == Kind::App || (browser && f.kind == Kind::Browser))
        .cloned()
        .collect();
    let handle = app.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        wanted
            .into_iter()
            .map(|artifact| {
                download(&handle, &artifact).map(|path| (artifact.kind, path, artifact))
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|e| e.to_string())??;
    with_state(|s| s.downloaded = files);
    Ok(())
}

fn download<R: Runtime>(app: &AppHandle<R>, artifact: &Artifact) -> Result<PathBuf, String> {
    let emit = |done: u64, stage: &'static str| {
        let _ = app.emit(
            "setup://progress",
            Progress {
                name: artifact.name.clone(),
                done,
                total: artifact.size,
                stage,
            },
        );
    };
    #[cfg(windows)]
    {
        use std::io::Write;
        let (host, path) =
            aegis_update::host_and_path(&artifact.url).ok_or("Unzulässige Adresse.")?;
        let limit = usize::try_from(artifact.size).map_err(|e| e.to_string())?;
        let mut last = 0u64;
        let body = aegis_update::get_following(host, &path, |host, path| {
            fetch(host, path, limit, 600_000, &mut |done, _| {
                // Höchstens alle 256 KiB eine Meldung.
                if done >= last + 256 * 1024 || done == artifact.size {
                    last = done;
                    emit(done, "download");
                }
            })
        })?;
        emit(artifact.size, "verify");
        aegis_update::check_file(&body, artifact).map_err(|e| e.to_string())?;
        let dir = std::env::temp_dir().join(format!(
            "AEGIS-Setup-{}",
            artifact.sha256.get(..16).unwrap_or_default()
        ));
        // Eigener Ordner für die geprüften Installationsprogramme.
        // aegis-mutation: setup-download-dir
        #[allow(clippy::disallowed_methods)]
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(format!("{}-{}", std::process::id(), artifact.name));
        // Neue Datei mit dem geprüften Inhalt (nie überschreiben).
        // aegis-mutation: setup-download-write
        #[allow(clippy::disallowed_methods)]
        let mut file = std::fs::File::create_new(&target).map_err(|e| e.to_string())?;
        file.write_all(&body)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        emit(artifact.size, "ok");
        Ok(target)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, artifact, emit);
        Err("Das Setup installiert nur unter Windows.".into())
    }
}

/// Startet die geprüften Installationsprogramme (der Nutzer hat „Installieren“ gewählt):
/// zuerst AEGIS Suite still in `dir` (Windows fragt nach Administratorrechten), danach – falls
/// gewählt – den Browser für dieses Konto.
#[tauri::command]
pub async fn setup_install(dir: String) -> Result<(), String> {
    let dir = install_dir(&dir)?;
    let files = with_state(|s| s.downloaded.clone());
    if !files.iter().any(|(k, _, _)| *k == Kind::App) {
        return Err("Bitte zuerst herunterladen.".into());
    }
    let target = dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Die App zuerst, der Browser danach.
        let mut ordered = files;
        ordered.sort_by_key(|(k, _, _)| *k != Kind::App);
        for (kind, path, artifact) in &ordered {
            let args = if *kind == Kind::App {
                format!("/S /D={}", target.display())
            } else {
                "/S".to_owned()
            };
            run_checked(path, artifact, &args)?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    with_state(|s| s.installed = Some(dir));
    Ok(())
}

/// Prüft die Datei unmittelbar vor dem Start erneut und startet sie.
fn run_checked(path: &Path, artifact: &Artifact, args: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    aegis_update::check_file(&bytes, artifact).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let code = aegis_winffi::shell::run_and_wait(path, args).map_err(|e| {
            format!(
                "{} ließ sich nicht starten (Administratorrechte abgelehnt?): {e}",
                artifact.name
            )
        })?;
        if code != 0 {
            return Err(format!("{} meldet Fehler {code}.", artifact.name));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        Err("Das Setup installiert nur unter Windows.".into())
    }
}

/// AEGIS starten (nach erfolgreicher Installation, auf Klick).
#[tauri::command]
pub fn setup_launch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = with_state(|s| s.installed.clone()).ok_or("AEGIS ist noch nicht installiert.")?;
    let exe = dir.join(APP_EXE);
    if !exe.is_file() {
        return Err("AEGIS wurde nicht im gewählten Ordner gefunden.".into());
    }
    #[cfg(windows)]
    {
        aegis_winffi::shell::launch(&exe, "").map_err(|e| e.to_string())?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Das Setup installiert nur unter Windows.".into())
    }
}

/// Ordner wählen (Windows-Dialog).
#[tauri::command]
pub async fn setup_pick_dir(current: String) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let start = install_dir(&current)
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(default_dir);
        let picked = tauri::async_runtime::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_title("Installationsordner wählen")
                .set_directory(start)
                .pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(picked.map(|p| {
            // Unter dem gewählten Ordner einen eigenen „AEGIS Suite“-Ordner anlegen lassen.
            if p.file_name().is_some_and(|n| n == PRODUCT_DIR) {
                p.display().to_string()
            } else {
                p.join(PRODUCT_DIR).display().to_string()
            }
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = current;
        Err("Ordner wählen gibt es nur unter Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installationsordner_streng() {
        assert_eq!(
            install_dir(r"C:\Program Files\AEGIS Suite\").unwrap(),
            PathBuf::from(r"C:\Program Files\AEGIS Suite")
        );
        assert!(install_dir(r"D:\Apps\AEGIS").is_ok());
        for bad in [
            "",
            "AEGIS",
            r"\\server\share\AEGIS",
            r"C:\a\..\Windows",
            "C:\\a\" /S",
            r"C:\a:b",
            "C:/Programme/AEGIS",
            "C:\\a\u{7}",
            r"C:\a\b.",
        ] {
            assert!(install_dir(bad).is_err(), "{bad}");
        }
        assert!(install_dir(&format!(r"C:\{}", "a".repeat(250))).is_err());
        assert!(default_dir().ends_with(PRODUCT_DIR));
    }

    #[test]
    fn ohne_angaben_kein_download_und_keine_installation() {
        let result = tauri::async_runtime::block_on(setup_install(r"C:\AEGIS".into()));
        assert!(result.is_err());
        assert_eq!(kind_name(Kind::Browser), "browser");
    }
}
