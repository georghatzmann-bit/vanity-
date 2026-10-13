//! Tauri-Befehle und Zustand der Setup-App (Vertrag: docs/INSTALLER.md).

use crate::args::{encode_preset, CliArgs};
use crate::config::{config, setup_version};
use crate::download::{cancelled_error, ProgressFn};
use crate::install::{self, InstallPlan};
use crate::manifest::{self, Location, ManifestOrigin, ManifestSource};
use crate::platform::{self, ElevateError};
use crate::types::{
    DiskInfo, InstallDone, InstallError, InstallOptions, InstalledInfo, Manifest, Progress, SetupInfo, SetupMode, UninstallDonePayload, UninstallErrorPayload,
};
use crate::uninstall::{self, UninstallPlan};
use crate::util::{display_path, lang, log, tr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

pub const EVT_INSTALL_PROGRESS: &str = "install://progress";
pub const EVT_INSTALL_ERROR: &str = "install://error";
pub const EVT_INSTALL_DONE: &str = "install://done";
pub const EVT_UNINSTALL_PROGRESS: &str = "uninstall://progress";
pub const EVT_UNINSTALL_ERROR: &str = "uninstall://error";
pub const EVT_UNINSTALL_DONE: &str = "uninstall://done";

pub struct AppState {
    pub cli: CliArgs,
    pub manifest_source: ManifestSource,
    pub mode: SetupMode,
    pub elevated: bool,
    cached_manifest: Mutex<Option<Manifest>>,
    install_cancel: Mutex<Option<CancellationToken>>,
    last_install_dir: Mutex<Option<PathBuf>>,
    uninstall_running: AtomicBool,
    uninstall_done: AtomicBool,
    uninstall_dir: Mutex<Option<PathBuf>>,
    self_delete_pending: AtomicBool,
    exit_handled: AtomicBool,
}

/// Mutex sperren, ohne bei einer "vergifteten" Sperre in Panik zu geraten.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Startmodus aus Kommandozeile und vorhandener Installation.
pub fn compute_mode(cli: &CliArgs, installed: bool) -> SetupMode {
    if cli.uninstall {
        SetupMode::Uninstall
    } else if cli.update {
        if installed {
            SetupMode::Update
        } else {
            SetupMode::Install
        }
    } else if cli.preset.is_some() || !installed {
        SetupMode::Install
    } else {
        SetupMode::Maintenance
    }
}

impl AppState {
    pub fn new(cli: CliArgs) -> Self {
        let manifest_source = manifest::manifest_source_for_process(cli.manifest.as_deref());
        let installed = install::detect_installed().is_some();
        let mode = compute_mode(&cli, installed);
        let elevated = platform::is_elevated();
        log(format!("Modus {mode:?}, Manifest {} ({:?}), Admin: {elevated}", manifest_source.location, manifest_source.origin));
        Self {
            cli,
            manifest_source,
            mode,
            elevated,
            cached_manifest: Mutex::new(None),
            install_cancel: Mutex::new(None),
            last_install_dir: Mutex::new(None),
            uninstall_running: AtomicBool::new(false),
            uninstall_done: AtomicBool::new(false),
            uninstall_dir: Mutex::new(None),
            self_delete_pending: AtomicBool::new(false),
            exit_handled: AtomicBool::new(false),
        }
    }

    fn installed_info(&self) -> Option<InstalledInfo> {
        if self.mode == SetupMode::Uninstall {
            if let Some(dir) = &self.cli.target {
                let version = install::read_install_record(dir).map(|r| r.version).unwrap_or_default();
                return Some(InstalledInfo { dir: display_path(dir), version });
            }
        }
        install::detect_installed().map(|(dir, version)| InstalledInfo { dir: display_path(&dir), version })
    }

    /// Ordner der installierten App (für `launch_app`).
    fn app_dir(&self) -> Option<PathBuf> {
        lock(&self.last_install_dir).clone().or_else(|| install::detect_installed().map(|(d, _)| d))
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn setup_info(state: State<'_, AppState>) -> Result<SetupInfo, String> {
    Ok(SetupInfo {
        mode: state.mode,
        setup_version: setup_version(),
        app_name: config().app_name.clone(),
        default_dir: display_path(&install::default_install_dir()),
        installed: state.installed_info(),
        elevated: state.elevated,
        system_lang: lang().to_string(),
        preset: state.cli.preset.clone(),
        manifest_url: state.manifest_source.location.clone(),
    })
}

#[tauri::command]
pub async fn fetch_manifest(state: State<'_, AppState>) -> Result<Manifest, String> {
    let location = Location::parse(&state.manifest_source.location, None)?;
    let client = manifest::shared_client()?;
    let m = manifest::fetch_manifest(&client, &location).await.map_err(|e| e.message)?;
    *lock(&state.cached_manifest) = Some(m.clone());
    Ok(m)
}

#[tauri::command]
pub async fn disk_space(state: State<'_, AppState>, path: String) -> Result<DiskInfo, String> {
    let size = lock(&state.cached_manifest).as_ref().and_then(|m| m.app.size);
    let elevated = state.elevated;
    blocking(move || crate::disk::disk_info(&path, crate::disk::required_bytes(size), elevated)).await
}

/// Ordner und Optionen für `start_install` festlegen (Update: vorhandener Ordner + alte Auswahl).
fn effective_install_target(state: &AppState, options: InstallOptions) -> Result<(PathBuf, InstallOptions), String> {
    if state.mode == SetupMode::Update {
        if let Some((dir, _)) = install::detect_installed() {
            let opts = install::effective_update_options(&options, &dir);
            return Ok((dir, opts));
        }
    }
    let dir = if options.dir.trim().is_empty() { install::default_install_dir() } else { crate::disk::normalize_path(&options.dir)? };
    let mut options = options;
    options.dir = display_path(&dir);
    Ok((dir, options))
}

async fn install_task(
    app: &AppHandle,
    dir: PathBuf,
    options: InstallOptions,
    progress: &ProgressFn,
    cancel: &CancellationToken,
) -> Result<InstallDone, InstallError> {
    let state = app.state::<AppState>();
    progress(Progress::step("connect", 0.0));
    let client = manifest::shared_client().map_err(|m| InstallError::new("connect", "network", m, true))?;
    let location = Location::parse(&state.manifest_source.location, None).map_err(|m| InstallError::new("connect", "manifest", m, false))?;
    let fetched = tokio::select! {
        r = manifest::fetch_manifest(&client, &location) => r,
        _ = cancel.cancelled() => return Err(cancelled_error("connect")),
    };
    let manifest = match fetched {
        Ok(m) => {
            *lock(&state.cached_manifest) = Some(m.clone());
            m
        }
        Err(e) => match lock(&state.cached_manifest).clone() {
            Some(m) => {
                log(format!("Manifest nicht erneut ladbar ({}), nutze zwischengespeichertes", e.message));
                m
            }
            None => return Err(InstallError::new("connect", e.code, e.message, true)),
        },
    };
    let mut plan = InstallPlan::new(manifest, dir, options);
    plan.elevated = state.elevated;
    install::run_install(&client, &plan, progress, cancel).await
}

#[tauri::command]
pub async fn start_install(app: AppHandle, state: State<'_, AppState>, options: InstallOptions) -> Result<(), String> {
    let token = {
        let mut guard = lock(&state.install_cancel);
        if guard.is_some() {
            return Err(tr("Die Installation läuft bereits.", "The installation is already running."));
        }
        let token = CancellationToken::new();
        *guard = Some(token.clone());
        token
    };
    let (dir, options) = match effective_install_target(&state, options) {
        Ok(v) => v,
        Err(e) => {
            *lock(&state.install_cancel) = None;
            return Err(e);
        }
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let progress: ProgressFn = {
            let app = handle.clone();
            Arc::new(move |p: Progress| {
                let _ = app.emit(EVT_INSTALL_PROGRESS, p);
            })
        };
        let result = install_task(&handle, dir.clone(), options, &progress, &token).await;
        let state = handle.state::<AppState>();
        // Erst freigeben, dann melden – damit ein sofortiger Neuversuch der Oberfläche klappt.
        *lock(&state.install_cancel) = None;
        match result {
            Ok(done) => {
                *lock(&state.last_install_dir) = Some(dir);
                let _ = handle.emit(EVT_INSTALL_DONE, done);
            }
            Err(e) => {
                log(format!("Installation fehlgeschlagen: {e}"));
                let _ = handle.emit(EVT_INSTALL_ERROR, e);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_install(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(token) = lock(&state.install_cancel).as_ref() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn relaunch_elevated(app: AppHandle, state: State<'_, AppState>, options: InstallOptions) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut args = vec!["--elevated".to_string(), "--preset".to_string(), encode_preset(&options)];
    if state.mode == SetupMode::Update {
        args.push("--update".into());
    }
    if state.manifest_source.origin != ManifestOrigin::Embedded {
        args.push("--manifest".into());
        args.push(state.manifest_source.location.clone());
    }
    match blocking(move || platform::shell_execute_elevated(&exe, &args)).await? {
        Ok(()) => {
            log("Neustart mit Adminrechten – dieses Fenster wird beendet");
            app.exit(0);
            Ok(())
        }
        Err(ElevateError::Declined) => Err("Administratorrechte wurden abgelehnt.".to_string()),
        Err(ElevateError::Unsupported) => Err(tr(
            "Administratorrechte werden nur unter Windows unterstützt.",
            "Administrator rights are only supported on Windows.",
        )),
        Err(ElevateError::Failed(m)) => Err(format!(
            "{}: {m}",
            tr("Neustart mit Administratorrechten fehlgeschlagen", "Restart with administrator rights failed")
        )),
    }
}

#[tauri::command]
pub async fn app_running() -> Result<bool, String> {
    blocking(|| platform::is_process_running(&config().app_exe_name)).await
}

#[tauri::command]
pub async fn close_app() -> Result<(), String> {
    blocking(|| platform::kill_processes(&config().app_exe_name)).await?.map(|_| ())
}

#[tauri::command]
pub async fn launch_app(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.app_dir().ok_or_else(|| tr("Pulsar ist nicht installiert.", "Pulsar is not installed."))?;
    let exe = dir.join(&config().app_exe_name);
    if !exe.is_file() {
        return Err(format!("{}: {}", tr("Datei nicht gefunden", "File not found"), exe.display()));
    }
    let elevated = state.elevated;
    blocking(move || platform::launch_unelevated(&exe, &dir, elevated)).await?
}

#[tauri::command]
pub async fn start_uninstall(app: AppHandle, state: State<'_, AppState>, keep_data: bool) -> Result<(), String> {
    if state.uninstall_running.swap(true, Ordering::SeqCst) {
        return Err(tr("Die Deinstallation läuft bereits.", "The uninstallation is already running."));
    }
    let Some(dir) = uninstall::uninstall_dir(&state.cli).or_else(|| lock(&state.last_install_dir).clone()) else {
        state.uninstall_running.store(false, Ordering::SeqCst);
        return Err(tr("Keine Installation gefunden.", "No installation found."));
    };
    let other_user = uninstall::started_by_other_user(&state.cli);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut plan = UninstallPlan::new(dir.clone(), keep_data);
        plan.other_user = other_user;
        let emitter = handle.clone();
        let result = uninstall::run_uninstall(&plan, &move |p| {
            let _ = emitter.emit(EVT_UNINSTALL_PROGRESS, p);
        });
        let state = handle.state::<AppState>();
        state.uninstall_running.store(false, Ordering::SeqCst);
        match result {
            Ok(outcome) => {
                if outcome.self_delete_pending {
                    state.self_delete_pending.store(true, Ordering::SeqCst);
                }
                if !outcome.dir_removed {
                    *lock(&state.uninstall_dir) = Some(dir);
                }
                state.uninstall_done.store(true, Ordering::SeqCst);
                let done = UninstallDonePayload { revert_ok: outcome.revert.is_ok(), data_kept: outcome.data_kept };
                let _ = handle.emit(EVT_UNINSTALL_DONE, done);
            }
            Err(message) => {
                log(format!("Deinstallation fehlgeschlagen: {message}"));
                let _ = handle.emit(EVT_UNINSTALL_ERROR, UninstallErrorPayload { message });
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let u = url.trim().to_string();
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err(tr("Nur Web-Links können geöffnet werden.", "Only web links can be opened."));
    }
    blocking(move || platform::open_url(&u)).await?
}

#[tauri::command]
pub fn quit(app: AppHandle) -> Result<(), String> {
    on_exit(&app);
    app.exit(0);
    Ok(())
}

/// Beim Beenden: temporäre Deinstaller-Kopie (bzw. den Deinstaller im gelöschten Ordner) entfernen.
pub fn on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if state.exit_handled.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(token) = lock(&state.install_cancel).as_ref() {
        token.cancel();
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let temp_copy = uninstall::is_temp_copy(&exe);
    if temp_copy || state.self_delete_pending.load(Ordering::SeqCst) {
        let done = state.uninstall_done.load(Ordering::SeqCst);
        let dir = if done { lock(&state.uninstall_dir).clone() } else { None };
        let purge = if done { uninstall::setup_data_dirs() } else { Vec::new() };
        log(format!("Selbstlöschung geplant: {}", exe.display()));
        if let Err(e) = platform::schedule_self_delete(&exe, dir.as_deref(), &purge) {
            log(format!("Selbstlöschung fehlgeschlagen: {e}"));
        }
    }
}
