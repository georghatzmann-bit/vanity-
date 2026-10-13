//! Installation: Vorprüfung → Download → Prüfung → Dateien → Verknüpfungen → Registrierung.

use crate::config::{config, DOWNLOAD_DIR_NAME, INSTALL_INFO_NAME, UNINSTALLER_NAME};
use crate::download::{self, cancelled_error, io_error, DownloadSpec, ProgressFn, RetryPolicy, VERIFY_END};
use crate::manifest::Location;
use crate::platform::{self, UninstallEntry};
use crate::types::{InstallDone, InstallError, InstallOptions, InstallRecord, Manifest, Progress};
use crate::util::{display_path, log, tr};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// Alles, was eine Installation braucht.
#[derive(Debug, Clone)]
pub struct InstallPlan {
    /// Manifest mit absoluter `app.url`.
    pub manifest: Manifest,
    /// Normalisierter Installationsordner.
    pub dir: PathBuf,
    /// Wirksame Optionen (`dir` = normalisierter Ordner).
    pub options: InstallOptions,
    /// Quelle für `Uninstall Pulsar.exe` (normalerweise die laufende Setup-Exe).
    pub uninstaller_source: Option<PathBuf>,
    /// Mit Adminrechten → Eintrag in HKLM.
    pub elevated: bool,
    /// Verknüpfungen und Registry anlegen (unter Linux ohnehin wirkungslos).
    pub integrate: bool,
    pub retry: RetryPolicy,
    pub app_exe_name: String,
}

impl InstallPlan {
    pub fn new(manifest: Manifest, dir: PathBuf, mut options: InstallOptions) -> Self {
        options.dir = display_path(&dir);
        Self {
            manifest,
            dir,
            options,
            uninstaller_source: std::env::current_exe().ok(),
            elevated: platform::is_elevated(),
            integrate: true,
            retry: RetryPolicy::default(),
            app_exe_name: config().app_exe_name.clone(),
        }
    }

    pub fn exe_path(&self) -> PathBuf {
        self.dir.join(&self.app_exe_name)
    }

    pub fn download_spec(&self) -> Result<DownloadSpec, InstallError> {
        let source = Location::parse(&self.manifest.app.url, None).map_err(|m| InstallError::new("connect", "manifest", m, false))?;
        Ok(DownloadSpec {
            source,
            sha256: self.manifest.app.sha256.clone(),
            size: self.manifest.app.size,
            version: self.manifest.version.clone(),
            work_dir: self.dir.join(DOWNLOAD_DIR_NAME),
            file_name: self.app_exe_name.clone(),
        })
    }
}

/// Standard-Installationsordner: `%LOCALAPPDATA%\Programs\Pulsar`.
pub fn default_install_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Programs")
        .join(&config().app_name)
}

pub fn read_install_record(dir: &Path) -> Option<InstallRecord> {
    let bytes = std::fs::read(dir.join(INSTALL_INFO_NAME)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Vorhandene Installation laut Registry (nur wenn die App-Exe noch existiert).
pub fn detect_installed() -> Option<(PathBuf, String)> {
    let (dir, version) = platform::read_install_state()?;
    if !dir.join(&config().app_exe_name).is_file() {
        return None;
    }
    let version = if version.trim().is_empty() {
        read_install_record(&dir).map(|r| r.version).unwrap_or_default()
    } else {
        version
    };
    Some((dir, version))
}

/// Update-Modus: vorhandenen Ordner und bisherige Verknüpfungs-Entscheidungen übernehmen.
pub fn effective_update_options(given: &InstallOptions, installed_dir: &Path) -> InstallOptions {
    let mut o = given.clone();
    o.dir = display_path(installed_dir);
    if let Some(rec) = read_install_record(installed_dir) {
        o.desktop_shortcut = rec.options.desktop_shortcut;
        o.start_menu = rec.options.start_menu;
        o.autostart = rec.options.autostart;
    }
    o
}

fn setup_exe_size(plan: &InstallPlan) -> u64 {
    plan.uninstaller_source.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0)
}

fn format_mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

fn not_enough_space(phase: &'static str, needed: u64, free: u64) -> InstallError {
    InstallError::new(
        phase,
        "disk",
        format!(
            "{} ({} {}, {} {}).",
            tr("Nicht genug Speicherplatz", "Not enough disk space"),
            format_mb(needed),
            tr("benötigt", "required"),
            format_mb(free),
            tr("frei", "free")
        ),
        true,
    )
}

/// Ordner anlegen und prüfen, ob der Platz für Download + Deinstaller reicht.
pub fn prepare_target(plan: &InstallPlan) -> Result<(), InstallError> {
    std::fs::create_dir_all(&plan.dir).map_err(|e| io_error("download", &e, &display_path(&plan.dir)))?;
    let spec = plan.download_spec()?;
    let have = std::fs::metadata(spec.part_path()).map(|m| m.len()).unwrap_or(0);
    let size = plan.manifest.app.size.unwrap_or(crate::config::DEFAULT_REQUIRED_BYTES);
    let needed = size.saturating_sub(have) + setup_exe_size(plan) + 1024 * 1024;
    if let Some((free, total)) = platform::disk_free_total(&plan.dir) {
        if total > 0 && free < needed {
            return Err(not_enough_space("download", needed, free));
        }
    }
    Ok(())
}

/// Komplette Installation. Fortschritt über `progress`, Abbruch über `cancel`.
pub async fn run_install(
    client: &reqwest::Client,
    plan: &InstallPlan,
    progress: &ProgressFn,
    cancel: &CancellationToken,
) -> Result<InstallDone, InstallError> {
    log(format!("Installation nach {} (Version {})", plan.dir.display(), plan.manifest.version));
    prepare_target(plan)?;
    let spec = plan.download_spec()?;
    download::download(client, &spec, progress, cancel, &plan.retry).await?;
    if cancel.is_cancelled() {
        return Err(cancelled_error("verify"));
    }
    let verified = download::verify(&spec, progress, cancel).await?;
    if cancel.is_cancelled() {
        return Err(cancelled_error("install"));
    }
    // Dateioperationen, COM-Verknüpfungen und Registry blockieren – nicht auf dem Async-Thread.
    let (plan, progress) = (plan.clone(), progress.clone());
    tokio::task::spawn_blocking(move || finish_install(&plan, &spec, verified, &progress))
        .await
        .map_err(|e| InstallError::new("install", "unknown", e.to_string(), true))?
}

fn replace_file(src: &Path, dst: &Path, app_exe_name: &str) -> Result<(), InstallError> {
    if platform::is_process_running(app_exe_name) {
        return Err(running_error());
    }
    match crate::util::retry_io(|| std::fs::rename(src, dst)) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if platform::is_process_running(app_exe_name) {
                return Err(running_error());
            }
            // Fallback: kopieren (z. B. anderes Laufwerk), dann Quelle löschen.
            match crate::util::retry_io(|| std::fs::copy(src, dst)) {
                Ok(_) => {
                    let _ = std::fs::remove_file(src);
                    Ok(())
                }
                Err(e) => {
                    log(format!("Ersetzen fehlgeschlagen: rename: {rename_err}, copy: {e}"));
                    Err(io_error("install", &e, &display_path(dst)))
                }
            }
        }
    }
}

fn running_error() -> InstallError {
    InstallError::new(
        "install",
        "running",
        tr(
            "Pulsar läuft gerade. Bitte die App schließen, damit sie ersetzt werden kann.",
            "Pulsar is currently running. Please close the app so it can be replaced.",
        ),
        true,
    )
}

/// Nach erfolgreichem Download: Dateien an ihren Platz, Verknüpfungen, Registrierung, Aufräumen.
pub fn finish_install(plan: &InstallPlan, spec: &DownloadSpec, verified: bool, progress: &ProgressFn) -> Result<InstallDone, InstallError> {
    let part = spec.part_path();
    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let step = |phase: &'static str, percent: f64| {
        progress(Progress { phase, downloaded: size, total: size, speed: 0.0, eta: 0, percent });
    };

    // ---- Dateien
    step("install", VERIFY_END);
    if platform::is_process_running(&plan.app_exe_name) {
        return Err(running_error());
    }
    let uninstaller_size = setup_exe_size(plan);
    if let Some((free, total)) = platform::disk_free_total(&plan.dir) {
        let needed = uninstaller_size + 512 * 1024;
        if total > 0 && free < needed {
            return Err(not_enough_space("install", needed, free));
        }
    }
    std::fs::create_dir_all(&plan.dir).map_err(|e| io_error("install", &e, &display_path(&plan.dir)))?;
    let exe = plan.exe_path();
    replace_file(&part, &exe, &plan.app_exe_name)?;
    step("install", 94.0);

    let uninstaller = plan.dir.join(UNINSTALLER_NAME);
    if let Some(src) = &plan.uninstaller_source {
        if crate::util::same_path(src, &uninstaller) {
            log("Setup läuft selbst als Deinstaller – Kopie übersprungen");
        } else {
            crate::util::retry_io(|| std::fs::copy(src, &uninstaller))
                .map_err(|e| io_error("install", &e, &display_path(&uninstaller)))?;
        }
    }
    let record = InstallRecord {
        version: plan.manifest.version.clone(),
        installed_at: crate::util::now_rfc3339(),
        options: plan.options.clone(),
        verified,
        scope: if plan.elevated { "machine".into() } else { "user".into() },
        // Diese App-Version kennt `--revert-all` – der Deinstaller darf es aufrufen.
        revert_all: true,
    };
    let info_path = plan.dir.join(INSTALL_INFO_NAME);
    std::fs::write(&info_path, serde_json::to_vec_pretty(&record).unwrap_or_default())
        .map_err(|e| io_error("install", &e, &display_path(&info_path)))?;
    step("install", 96.0);

    // ---- Verknüpfungen + Autostart
    if plan.integrate && platform::integration_supported() {
        step("shortcuts", 96.0);
        let description = config().app_name.clone();
        let shortcuts = [
            (platform::start_menu_shortcut(), plan.options.start_menu),
            (platform::desktop_shortcut(), plan.options.desktop_shortcut),
        ];
        for (lnk, wanted) in shortcuts {
            let Some(lnk) = lnk else { continue };
            if wanted {
                if let Err(e) = platform::create_shortcut(&lnk, &exe, &plan.dir, &description) {
                    log(format!("Verknüpfung {} fehlgeschlagen: {e}", lnk.display()));
                }
            } else if lnk.exists() {
                let _ = std::fs::remove_file(&lnk);
            }
        }
        let autostart = plan.options.autostart.then_some(exe.as_path());
        if let Err(e) = platform::set_autostart(autostart) {
            log(format!("Autostart fehlgeschlagen: {e}"));
        }
        step("shortcuts", 98.0);

        // ---- Apps & Features + Installationsort
        step("register", 98.0);
        let entry = uninstall_entry(plan, &exe, &uninstaller);
        let mut registered = false;
        if plan.elevated {
            match platform::register_uninstall(&entry, true) {
                Ok(()) => registered = true,
                Err(e) => log(format!("HKLM-Eintrag fehlgeschlagen, nutze HKCU: {e}")),
            }
        }
        if !registered {
            platform::register_uninstall(&entry, false).map_err(|e| register_error(&e))?;
        }
        platform::write_install_state(&plan.dir, &plan.manifest.version).map_err(|e| register_error(&e))?;
        step("register", 99.5);
    }

    // ---- Aufräumen
    let _ = std::fs::remove_dir_all(&spec.work_dir);
    log(format!("Installation fertig: {} (geprüft: {verified})", exe.display()));
    step("done", 100.0);
    Ok(InstallDone {
        dir: display_path(&plan.dir),
        exe_path: display_path(&exe),
        version: plan.manifest.version.clone(),
        verified,
    })
}

fn register_error(detail: &str) -> InstallError {
    log(format!("Registrierung fehlgeschlagen: {detail}"));
    InstallError::new(
        "register",
        "permission",
        tr(
            "Die Installation konnte nicht in Windows registriert werden.",
            "The installation could not be registered with Windows.",
        ),
        true,
    )
}

fn uninstall_entry(plan: &InstallPlan, exe: &Path, uninstaller: &Path) -> UninstallEntry {
    let cfg = config();
    let size: u64 = [exe, uninstaller, &plan.dir.join(INSTALL_INFO_NAME)]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
    let uninstall = format!("\"{}\" --uninstall", uninstaller.display());
    UninstallEntry {
        display_name: cfg.app_name.clone(),
        display_version: plan.manifest.version.clone(),
        publisher: cfg.publisher.clone(),
        display_icon: format!("\"{}\",0", exe.display()),
        install_location: display_path(&plan.dir),
        quiet_uninstall_string: format!("{uninstall} --quiet"),
        uninstall_string: uninstall,
        estimated_size_kb: (size / 1024).min(u32::MAX as u64) as u32,
        install_date: crate::util::today_yyyymmdd(),
        url_info_about: cfg.website_url.clone(),
    }
}
