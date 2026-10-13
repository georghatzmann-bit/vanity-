//! Deinstallation: App beenden → Verknüpfungen → Registry → Dateien → (optional) Benutzerdaten.

use crate::args::CliArgs;
use crate::config::{config, APP_DATA_ID, DOWNLOAD_DIR_NAME, INSTALL_INFO_NAME, TEMP_UNINSTALL_PREFIX, UNINSTALLER_NAME};
use crate::platform::{self, ElevateError};
use crate::types::UninstallProgress;
use crate::util::{display_path, log, same_path, tr};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct UninstallPlan {
    pub dir: PathBuf,
    pub keep_data: bool,
    /// Benutzerdaten-Ordner der App (`%APPDATA%\com.pulsar.booster`, `%LOCALAPPDATA%\com.pulsar.booster`).
    pub data_dirs: Vec<PathBuf>,
    /// Verknüpfungen und Registry entfernen (unter Linux ohnehin wirkungslos).
    pub integrate: bool,
    /// Die laufende Exe – sie kann sich nicht selbst löschen.
    pub self_exe: Option<PathBuf>,
    pub app_exe_name: String,
}

impl UninstallPlan {
    pub fn new(dir: PathBuf, keep_data: bool) -> Self {
        Self {
            dir,
            keep_data,
            data_dirs: default_data_dirs(),
            integrate: true,
            self_exe: std::env::current_exe().ok(),
            app_exe_name: config().app_exe_name.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallOutcome {
    /// Die laufende Exe liegt im Installationsordner und muss nach dem Beenden gelöscht werden.
    pub self_delete_pending: bool,
    pub dir_removed: bool,
    pub warnings: Vec<String>,
}

/// WebView2-Daten der Setup-App selbst – nach einer Deinstallation mit entfernen.
pub fn setup_data_dirs() -> Vec<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(crate::config::SETUP_DATA_ID)).into_iter().collect()
}

pub fn default_data_dirs() -> Vec<PathBuf> {
    [dirs::config_dir(), dirs::data_local_dir()].into_iter().flatten().map(|d| d.join(APP_DATA_ID)).collect()
}

fn remove_file_if_exists(p: &Path) -> std::io::Result<()> {
    match crate::util::retry_io(|| std::fs::remove_file(p)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Führt die Deinstallation aus (blockierend). `Err` nur, wenn die App-Dateien nicht entfernt werden konnten.
pub fn run_uninstall(plan: &UninstallPlan, progress: &dyn Fn(UninstallProgress)) -> Result<UninstallOutcome, String> {
    let step = |step: &'static str, percent: f64| progress(UninstallProgress { step, percent });
    let mut outcome = UninstallOutcome::default();
    log(format!("Deinstallation aus {} (Daten behalten: {})", plan.dir.display(), plan.keep_data));

    // ---- App beenden
    step("stop", 5.0);
    platform::kill_processes(&plan.app_exe_name)?;

    // Gehören Verknüpfungen/Registry zu genau diesem Ordner? (Schützt eine andere Installation.)
    let owns_integration = match platform::read_install_state() {
        Some((dir, _)) => same_path(&dir, &plan.dir),
        None => true,
    };
    let integrate = plan.integrate && owns_integration;
    if plan.integrate && !owns_integration {
        outcome.warnings.push("Registry zeigt auf einen anderen Ordner – Verknüpfungen/Registry bleiben".into());
    }

    // ---- Verknüpfungen + Autostart
    step("shortcuts", 20.0);
    if integrate {
        for lnk in [platform::start_menu_shortcut(), platform::desktop_shortcut()].into_iter().flatten() {
            if let Err(e) = remove_file_if_exists(&lnk) {
                outcome.warnings.push(format!("{}: {e}", lnk.display()));
            }
        }
        if let Err(e) = platform::set_autostart(None) {
            outcome.warnings.push(format!("Autostart: {e}"));
        }
    }

    // ---- Registry
    step("registry", 40.0);
    if integrate {
        outcome.warnings.extend(platform::unregister_uninstall());
        if let Err(e) = platform::delete_install_state() {
            outcome.warnings.push(format!("InstallDir: {e}"));
        }
    }

    // ---- Dateien
    step("files", 60.0);
    let exe = plan.dir.join(&plan.app_exe_name);
    remove_file_if_exists(&exe).map_err(|e| {
        log(format!("{} konnte nicht gelöscht werden: {e}", exe.display()));
        format!("{}: {}", tr("Datei konnte nicht gelöscht werden", "Could not delete file"), exe.display())
    })?;
    if let Err(e) = remove_file_if_exists(&plan.dir.join(INSTALL_INFO_NAME)) {
        outcome.warnings.push(format!("{INSTALL_INFO_NAME}: {e}"));
    }
    let uninstaller = plan.dir.join(UNINSTALLER_NAME);
    let is_self = plan.self_exe.as_ref().is_some_and(|s| uninstaller.exists() && same_path(s, &uninstaller));
    if is_self && cfg!(windows) {
        outcome.self_delete_pending = true;
    } else if let Err(e) = remove_file_if_exists(&uninstaller) {
        outcome.warnings.push(format!("{UNINSTALLER_NAME}: {e}"));
    }
    let _ = std::fs::remove_dir_all(plan.dir.join(DOWNLOAD_DIR_NAME));
    step("files", 75.0);
    // Den Ordner nur löschen, wenn er leer ist (niemals fremde Dateien mitlöschen).
    if !outcome.self_delete_pending {
        outcome.dir_removed = std::fs::remove_dir(&plan.dir).is_ok() || !plan.dir.exists();
    }

    // ---- Benutzerdaten
    step("data", 85.0);
    if !plan.keep_data {
        for d in &plan.data_dirs {
            // Sicherheitsnetz: nur Ordner mit genau dem App-Bezeichner.
            if d.file_name().and_then(|n| n.to_str()) != Some(APP_DATA_ID) {
                continue;
            }
            match std::fs::remove_dir_all(d) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => outcome.warnings.push(format!("{}: {e}", d.display())),
                _ => {}
            }
        }
    }

    for w in &outcome.warnings {
        log(format!("Hinweis: {w}"));
    }
    step("done", 100.0);
    Ok(outcome)
}

/// Läuft diese Exe als temporäre Deinstaller-Kopie (`%TEMP%\pulsar-uninstall-*.exe`)?
pub fn is_temp_copy(exe: &Path) -> bool {
    let name_ok = exe
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().starts_with(TEMP_UNINSTALL_PREFIX));
    name_ok && exe.parent().is_some_and(|p| same_path(p, &std::env::temp_dir()))
}

/// Installationsordner für die Deinstallation: `--target`, sonst Registry.
pub fn uninstall_dir(cli: &CliArgs) -> Option<PathBuf> {
    cli.target.clone().or_else(|| crate::install::detect_installed().map(|(d, _)| d))
}

/// `--uninstall` ohne `--target`, gestartet aus dem Installationsordner: nach `%TEMP%` kopieren,
/// die Kopie mit `--uninstall --target <dir>` starten und sofort beenden (`Some(exit_code)`).
pub fn relocate_if_needed(cli: &CliArgs) -> Option<i32> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();
    let registered = platform::read_install_state().map(|(d, _)| d);
    let inside = registered.as_ref().is_some_and(|d| same_path(d, &exe_dir))
        || exe_dir.join(INSTALL_INFO_NAME).is_file()
        || exe.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(UNINSTALLER_NAME));
    if !inside || is_temp_copy(&exe) {
        return None;
    }
    let temp = std::env::temp_dir().join(format!("{TEMP_UNINSTALL_PREFIX}{}.exe", crate::util::random_suffix()));
    if let Err(e) = std::fs::copy(&exe, &temp) {
        log(format!("Temporäre Kopie fehlgeschlagen ({e}) – Deinstallation läuft direkt"));
        return None;
    }
    let mut args = vec!["--uninstall".to_string(), "--target".to_string(), display_path(&exe_dir)];
    if cli.quiet {
        args.push("--quiet".into());
    }
    let need_admin = !platform::is_elevated() && !crate::disk::probe_writable(&exe_dir);
    let started = if need_admin {
        platform::shell_execute_elevated(&temp, &args)
    } else {
        platform::spawn_detached(&temp, &args).map_err(ElevateError::Failed)
    };
    match started {
        Ok(()) => {
            log(format!("Deinstaller-Kopie gestartet: {}", temp.display()));
            Some(0)
        }
        Err(ElevateError::Declined) => {
            let _ = std::fs::remove_file(&temp);
            Some(1)
        }
        Err(e) => {
            log(format!("Deinstaller-Kopie konnte nicht starten: {e:?}"));
            let _ = std::fs::remove_file(&temp);
            None
        }
    }
}

/// `--uninstall --quiet`: ohne Oberfläche deinstallieren (Benutzerdaten bleiben erhalten).
pub fn run_quiet(cli: &CliArgs) -> i32 {
    let code = match uninstall_dir(cli) {
        None => {
            crate::util::eprint_line(tr("Keine Installation gefunden.", "No installation found."));
            1
        }
        Some(dir) => {
            let plan = UninstallPlan::new(dir.clone(), true);
            match run_uninstall(&plan, &|p| crate::util::eprint_line(format!("{:>5.1}% {}", p.percent, p.step))) {
                Ok(outcome) => {
                    // Ohne Oberfläche läuft kein WebView – dessen Datenordner kann sofort weg.
                    for d in setup_data_dirs() {
                        let _ = std::fs::remove_dir_all(d);
                    }
                    if let Some(exe) = plan.self_exe.as_ref().filter(|e| outcome.self_delete_pending || is_temp_copy(e)) {
                        let dir_arg = (!outcome.dir_removed).then_some(dir.as_path());
                        let _ = platform::schedule_self_delete(exe, dir_arg, &[]);
                    }
                    0
                }
                Err(e) => {
                    crate::util::eprint_line(&e);
                    1
                }
            }
        }
    };
    if code != 0 {
        if let Ok(exe) = std::env::current_exe() {
            if is_temp_copy(&exe) {
                let _ = platform::schedule_self_delete(&exe, None, &[]);
            }
        }
    }
    code
}
