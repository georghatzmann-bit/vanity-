//! Ablauf des Setups: signierte Angaben holen, gewählte Pakete laden und prüfen, die geprüften
//! Installationsprogramme nach „Installieren“ starten. Nichts passiert ohne Klick; jede Datei
//! liegt in einem neuen, zufällig benannten Ordner, bleibt vom Speichern bis zum Ende der
//! Installation gegen Austausch gesperrt und wird direkt vor dem Start erneut geprüft.
//! Installiert wird immer nach „Programme“ (der Schutzdienst läuft als SYSTEM).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use aegis_update::{Artifact, Kind, Manifest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Ein eingebettetes Paket (Offline-Setup, siehe `build.rs`).
pub struct Package {
    /// Art.
    pub kind: Kind,
    /// Name beim Entpacken.
    pub name: &'static str,
    /// SHA-256 beim Bauen.
    pub sha256: &'static str,
    /// Inhalt.
    pub bytes: &'static [u8],
}

mod payload {
    use super::{Kind, Package};

    // Vom Build-Skript: Pfad und SHA-256 jedes Pakets (leer = nicht eingebettet).
    const APP: &[u8] = include_bytes!(env!("AEGIS_SETUP_APP"));
    const BROWSER: &[u8] = include_bytes!(env!("AEGIS_SETUP_BROWSER"));

    /// Eingebettete Pakete (leer im Online-Setup).
    pub fn packages() -> Vec<Package> {
        [
            (
                Kind::App,
                "AEGIS-Suite-Setup.exe",
                env!("AEGIS_SETUP_APP_SHA256"),
                APP,
            ),
            (
                Kind::Browser,
                "AEGIS-Browser-Setup.exe",
                env!("AEGIS_SETUP_BROWSER_SHA256"),
                BROWSER,
            ),
        ]
        .into_iter()
        .filter(|(_, _, sha256, bytes)| !bytes.is_empty() && !sha256.is_empty())
        .map(|(kind, name, sha256, bytes)| Package {
            kind,
            name,
            sha256,
            bytes,
        })
        .collect()
    }
}

/// Signierte Angabe eines eingebetteten Pakets (für dieselbe Prüfung wie beim Download).
fn embedded_artifact(package: &Package) -> Artifact {
    Artifact {
        kind: package.kind,
        name: package.name.to_owned(),
        url: String::new(),
        sha256: package.sha256.to_owned(),
        size: u64::try_from(package.bytes.len()).unwrap_or(u64::MAX),
    }
}

/// Ordnername unter „Programme“.
pub const PRODUCT_DIR: &str = "AEGIS Suite";
/// Programmdatei der App im Installationsordner.
pub const APP_EXE: &str = "aegis.exe";

/// Geprüft gespeichertes Paket (das Handle hält die Sperre gegen Austausch).
#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Downloaded {
    kind: Kind,
    path: PathBuf,
    artifact: Artifact,
    file: std::fs::File,
}

#[derive(Debug, Default)]
struct State {
    manifest: Option<Manifest>,
    /// Geprüft geladene Pakete.
    downloaded: Vec<Downloaded>,
    /// Installationsordner nach erfolgreicher Installation.
    installed: Option<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
/// Läuft gerade ein Laden oder eine Installation? (kein doppelter Start)
static BUSY: AtomicBool = AtomicBool::new(false);

/// Hält `BUSY`, solange es lebt.
struct Busy;

impl Busy {
    fn take() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "Das Setup arbeitet schon – bitte warten.".to_owned())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

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
    /// Installationsordner (immer unter „Programme“).
    default_dir: String,
    /// Windows (nur dort wird installiert).
    windows: bool,
    /// Offline-Setup: Pakete sind eingebettet, es wird nichts geladen.
    offline: bool,
    /// Eingebettete Pakete.
    components: Vec<Component>,
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
    published: String,
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
        offline: !payload::packages().is_empty(),
        components: payload::packages()
            .iter()
            .map(|p| Component {
                kind: kind_name(p.kind),
                name: p.name.to_owned(),
                size: u64::try_from(p.bytes.len()).unwrap_or(u64::MAX),
            })
            .collect(),
    }
}

/// Holt und prüft die signierten Angaben der neuesten Version (Netz nur nach Klick).
#[tauri::command]
pub async fn setup_check<R: Runtime>(app: AppHandle<R>) -> Result<Offer, String> {
    if !aegis_update::enabled() {
        return Err("Dieses Setup wurde ohne Signaturschlüssel gebaut und kann Downloads nicht prüfen. Lade das Installationsprogramm direkt von der Release-Seite.".into());
    }
    let manifest = tauri::async_runtime::spawn_blocking(fetch_manifest)
        .await
        .map_err(|e| e.to_string())??;
    let own = app.package_info().version.to_string();
    if aegis_update::newer(&manifest.version, &own) {
        return Err(format!(
            "Die Angaben nennen Version {}, älter als dieses Setup ({own}) – abgelehnt (kein Zurückstufen).",
            manifest.version
        ));
    }
    if !aegis_update::fresh(&manifest.published, &aegis_update::today()) {
        return Err(format!(
            "Die Angaben stammen vom {} und sind damit zu alt (oder das Datum stimmt nicht) – möglicherweise eine veraltete Kopie.",
            manifest.published
        ));
    }
    let offer = Offer {
        version: manifest.version.clone(),
        published: manifest.published.clone(),
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
    let busy = Busy::take()?;
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
            .map(|artifact| download(&handle, artifact))
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|e| e.to_string())??;
    with_state(|s| s.downloaded = files);
    drop(busy);
    Ok(())
}

fn download<R: Runtime>(app: &AppHandle<R>, artifact: Artifact) -> Result<Downloaded, String> {
    let (name, total) = (artifact.name.clone(), artifact.size);
    let emit = |done: u64, stage: &'static str| {
        let _ = app.emit(
            "setup://progress",
            Progress {
                name: name.clone(),
                done,
                total,
                stage,
            },
        );
    };
    #[cfg(windows)]
    {
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
        aegis_update::check_file(&body, &artifact).map_err(|e| e.to_string())?;
        let (path, file) = store_locked(&body, &artifact)?;
        emit(artifact.size, "ok");
        Ok(Downloaded {
            kind: artifact.kind,
            path,
            artifact,
            file,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, artifact, emit);
        Err("Das Setup installiert nur unter Windows.".into())
    }
}

/// Speichert ein geprüftes Paket in einem neuen, zufällig benannten Ordner des Temp-Ordners –
/// in einer neuen Datei, die gegen Austausch gesperrt bleibt, solange das Handle offen ist –
/// und prüft es aus dieser Datei erneut.
#[cfg(windows)]
fn store_locked(body: &[u8], artifact: &Artifact) -> Result<(PathBuf, std::fs::File), String> {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write(artifact.sha256.as_bytes());
    hasher.write_u32(std::process::id());
    let dir = std::env::temp_dir().join(format!("AEGIS-Setup-{:016x}", hasher.finish()));
    // Neuer eigener Ordner (schlägt fehl, wenn es ihn schon gibt – kein fremder Ordner).
    // aegis-mutation: setup-download-dir
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

/// Packt die eingebetteten Pakete (AEGIS Suite immer, Browser auf Wunsch) aus – in neue,
/// gesperrte Dateien – und prüft sie gegen die beim Bauen berechnete Prüfsumme.
fn unpack<R: Runtime>(app: &AppHandle<R>, browser: bool) -> Result<Vec<Downloaded>, String> {
    payload::packages()
        .iter()
        .filter(|p| p.kind == Kind::App || (browser && p.kind == Kind::Browser))
        .map(|p| {
            let artifact = embedded_artifact(p);
            let _ = app.emit(
                "setup://progress",
                Progress {
                    name: artifact.name.clone(),
                    done: artifact.size,
                    total: artifact.size,
                    stage: "verify",
                },
            );
            #[cfg(windows)]
            {
                let (path, file) = store_locked(p.bytes, &artifact)?;
                Ok(Downloaded {
                    kind: artifact.kind,
                    path,
                    artifact,
                    file,
                })
            }
            #[cfg(not(windows))]
            {
                let _ = artifact;
                Err("Das Setup installiert nur unter Windows.".to_owned())
            }
        })
        .collect()
}

/// Startet die geprüften Installationsprogramme (der Nutzer hat „Installieren“ gewählt):
/// zuerst AEGIS Suite still nach „Programme“ (Windows fragt nach Administratorrechten), danach
/// – falls gewählt – den Browser für dieses Konto. Offline-Setup: Die Pakete kommen aus dem
/// Setup selbst (`browser` wählt den Browser); sonst die zuvor geladenen.
#[tauri::command]
pub async fn setup_install<R: Runtime>(app: AppHandle<R>, browser: bool) -> Result<(), String> {
    let busy = Busy::take()?;
    let dir = install_dir(&default_dir().display().to_string())?;
    let mut files = with_state(|s| std::mem::take(&mut s.downloaded));
    if files.is_empty() && !payload::packages().is_empty() {
        let handle = app.clone();
        files = tauri::async_runtime::spawn_blocking(move || unpack(&handle, browser))
            .await
            .map_err(|e| e.to_string())??;
    }
    if !files.iter().any(|d| d.kind == Kind::App) {
        with_state(|s| s.downloaded = files);
        return Err("Bitte zuerst herunterladen.".into());
    }
    let target = dir.clone();
    let (files, result) = tauri::async_runtime::spawn_blocking(move || {
        // Die App zuerst, der Browser danach.
        files.sort_by_key(|d| d.kind != Kind::App);
        let mut result = Ok(());
        for d in &mut files {
            let args = if d.kind == Kind::App {
                format!("/S /D={}", target.display())
            } else {
                "/S".to_owned()
            };
            result = run_checked(d, &args);
            if result.is_err() {
                break;
            }
        }
        (files, result)
    })
    .await
    .map_err(|e| e.to_string())?;
    // Die Dateien bleiben bis hierher gesperrt; danach gibt das Setup sie frei.
    drop(files);
    result?;
    with_state(|s| s.installed = Some(dir));
    drop(busy);
    Ok(())
}

/// Prüft die gesperrte Datei unmittelbar vor dem Start erneut und startet sie (Warten auf das
/// Ende, Exit-Code ausgewertet).
fn run_checked(d: &mut Downloaded, args: &str) -> Result<(), String> {
    aegis_update::recheck(&mut d.file, &d.artifact)?;
    #[cfg(windows)]
    {
        let code = aegis_winffi::shell::run_and_wait(&d.path, args).map_err(|e| {
            format!(
                "{} ließ sich nicht starten (Administratorrechte abgelehnt?): {e}",
                d.artifact.name
            )
        })?;
        if code != 0 {
            return Err(format!(
                "{} meldet Fehler {code} – die Installation ist nicht vollständig.",
                d.artifact.name
            ));
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
    fn eingebettete_pakete_werden_wie_downloads_geprueft() {
        // Entwicklungs-Build: nichts eingebettet (Online-Setup).
        assert!(payload::packages().is_empty());
        let package = Package {
            kind: Kind::App,
            name: "AEGIS-Suite-Setup.exe",
            sha256: "56d3fe6e0a2c2e0b3f8ad2b8d1d2c8fb5d8a5d0f1b3b7f1bfa5d3f2c55ad2c88",
            bytes: b"harmlos",
        };
        let artifact = embedded_artifact(&package);
        assert_eq!(artifact.size, 7);
        // Falsche Prüfsumme: abgelehnt (genau wie bei einem Download).
        assert!(aegis_update::check_file(package.bytes, &artifact).is_err());
        let ok = Package {
            sha256: Box::leak(aegis_update::sha256_hex(b"harmlos").into_boxed_str()),
            ..package
        };
        assert!(aegis_update::check_file(ok.bytes, &embedded_artifact(&ok)).is_ok());
        assert_eq!(kind_name(Kind::Browser), "browser");
    }

    /// Regression (Testversion): Das gesperrte, geprüfte Paket muss sich starten lassen und
    /// darf sich währenddessen nicht ändern lassen. Prüfling: eine Kopie von `whoami.exe`.
    #[cfg(windows)]
    #[test]
    fn entpacktes_paket_ist_startbar_und_gegen_austausch_gesperrt() {
        let system = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap()
            .join("System32")
            .join("whoami.exe");
        let bytes = std::fs::read(&system).unwrap();
        let artifact = Artifact {
            kind: Kind::App,
            name: "AEGIS-Test-whoami.exe".into(),
            url: String::new(),
            sha256: aegis_update::sha256_hex(&bytes),
            size: u64::try_from(bytes.len()).unwrap(),
        };
        let (path, file) = store_locked(&bytes, &artifact).unwrap();
        // Gesperrt: Schreiben und Umbenennen scheitern, solange das Setup das Handle hält.
        // aegis-mutation: setup-test-write-denied
        #[allow(clippy::disallowed_methods)]
        let write = std::fs::OpenOptions::new().write(true).open(&path);
        assert!(write.is_err());
        // aegis-mutation: setup-test-rename-denied
        #[allow(clippy::disallowed_methods)]
        let renamed = std::fs::rename(&path, path.with_extension("bak"));
        assert!(renamed.is_err());
        // Startbar wie im Setup (ShellExecuteEx) – vorher: „Ein anderes Programm greift
        // gerade auf diese Datei zu“.
        assert_eq!(aegis_winffi::shell::run_and_wait(&path, "").unwrap(), 0);
        drop(file);
    }
}
