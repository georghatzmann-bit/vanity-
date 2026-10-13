//! Deinstallation: App beenden und Windows-Einstellungen zurückstellen → Verknüpfungen → Registry →
//! Dateien → (optional) Benutzerdaten.

use crate::args::CliArgs;
use crate::config::{config, APP_DATA_ID, DOWNLOAD_DIR_NAME, INSTALL_INFO_NAME, TEMP_UNINSTALL_PREFIX, UNINSTALLER_NAME};
use crate::platform::{self, ElevateError};
use crate::types::UninstallProgress;
use crate::util::{display_path, log, same_path, tr};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Damit stellt die App alle Windows-Einstellungen zurück, die sie geändert hat (DNS, Optimierungen).
/// Vertrag: `docs/API.md`, Abschnitt „Deinstallieren: `Pulsar.exe --revert-all`“.
pub const REVERT_ARGS: [&str; 1] = ["--revert-all"];
/// So lange darf `Pulsar.exe --revert-all` höchstens laufen (inkl. Windows-Abfrage), danach wird es beendet.
pub const REVERT_TIMEOUT: Duration = Duration::from_secs(120);
/// So oft wird nachgesehen, ob der Prozess fertig ist.
const REVERT_POLL: Duration = Duration::from_millis(100);
/// Höchstens so viel von der Fehlerausgabe landet im Protokoll.
const REVERT_LOG_LIMIT: usize = 4096;

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
    /// Höchstens so lange auf `Pulsar.exe --revert-all` warten.
    pub revert_timeout: Duration,
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
            revert_timeout: REVERT_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallOutcome {
    /// Die laufende Exe liegt im Installationsordner und muss nach dem Beenden gelöscht werden.
    pub self_delete_pending: bool,
    pub dir_removed: bool,
    /// Was beim Zurückstellen der Windows-Einstellungen passiert ist.
    pub revert: RevertResult,
    pub warnings: Vec<String>,
}

/// Ergebnis von `Pulsar.exe --revert-all`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RevertResult {
    /// Keine App-Datei im Ordner – nichts aufzurufen.
    #[default]
    NoApp,
    /// Beendet mit diesem Exit-Code (`None` = ohne Code, z. B. von außen beendet).
    /// 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben.
    Exited(Option<i32>),
    /// Zeitlimit überschritten – der Prozess wurde beendet.
    TimedOut,
    /// Konnte nicht gestartet werden oder das Warten ging schief.
    Failed(String),
}

impl RevertResult {
    /// Alles zurückgestellt (oder nichts zu tun)?
    pub fn is_ok(&self) -> bool {
        matches!(self, RevertResult::NoApp | RevertResult::Exited(Some(0)))
    }

    /// Kurzer Text fürs Protokoll.
    pub fn describe(&self) -> String {
        match self {
            RevertResult::NoApp => "keine App-Datei gefunden – nichts zurückzustellen".into(),
            RevertResult::Exited(Some(0)) => "alles zurückgestellt (oder nichts zu tun)".into(),
            RevertResult::Exited(Some(1)) => "etwas ist übrig geblieben (Exit-Code 1)".into(),
            RevertResult::Exited(Some(code)) => format!("beendet mit Exit-Code {code}"),
            RevertResult::Exited(None) => "ohne Exit-Code beendet".into(),
            RevertResult::TimedOut => "Zeitlimit überschritten – Prozess beendet".into(),
            RevertResult::Failed(e) => format!("fehlgeschlagen: {e}"),
        }
    }
}

/// Ein Prozess, auf dessen Ende gewartet wird (in Tests eine Attrappe).
pub trait Waitable {
    /// `Ok(Some(code))` = beendet, `Ok(None)` = läuft noch.
    fn try_wait_code(&mut self) -> std::io::Result<Option<Option<i32>>>;
    /// Hart beenden und aufräumen.
    fn kill_now(&mut self);
}

impl Waitable for std::process::Child {
    fn try_wait_code(&mut self) -> std::io::Result<Option<Option<i32>>> {
        self.try_wait().map(|s| s.map(|status| status.code()))
    }

    fn kill_now(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}

/// Wartet höchstens `timeout` auf das Ende (Abfrage alle `poll`) und beendet den Prozess sonst.
pub fn wait_or_kill(p: &mut impl Waitable, timeout: Duration, poll: Duration) -> RevertResult {
    let start = Instant::now();
    loop {
        match p.try_wait_code() {
            Ok(Some(code)) => return RevertResult::Exited(code),
            Ok(None) => {}
            Err(e) => {
                p.kill_now();
                return RevertResult::Failed(e.to_string());
            }
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            p.kill_now();
            return RevertResult::TimedOut;
        }
        std::thread::sleep(poll.min(timeout - elapsed));
    }
}

/// Liest die Fehlerausgabe im Hintergrund (sonst könnte der Prozess beim Schreiben hängen bleiben)
/// und behält davon höchstens `REVERT_LOG_LIMIT` Bytes.
fn collect_stderr(child: &mut std::process::Child) -> Option<std::sync::mpsc::Receiver<String>> {
    let mut pipe = child.stderr.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = REVERT_LOG_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).trim().to_string());
    });
    Some(rx)
}

/// Startet `<exe> --revert-all` verborgen und wartet höchstens `timeout`. Fehler werden nur gemeldet,
/// sie brechen die Deinstallation nie ab.
pub fn run_revert(exe: &Path, timeout: Duration) -> RevertResult {
    if !exe.is_file() {
        return RevertResult::NoApp;
    }
    let mut child = match platform::spawn_hidden(exe, &REVERT_ARGS) {
        Ok(c) => c,
        Err(e) => return RevertResult::Failed(e.to_string()),
    };
    let stderr = collect_stderr(&mut child);
    let result = wait_or_kill(&mut child, timeout, REVERT_POLL);
    // Nicht ewig auf die Ausgabe warten (falls noch jemand die Leitung offen hält).
    if let Some(text) = stderr.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()) {
        if !text.is_empty() {
            log(format!("Ausgabe von {}: {text}", REVERT_ARGS.join(" ")));
        }
    }
    result
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

    // Von Pulsar geänderte Windows-Einstellungen (DNS, Optimierungen) zurückstellen, solange die App
    // noch da ist. Braucht das Adminrechte, fragt Windows dabei höchstens einmal nach.
    let app_exe = plan.dir.join(&plan.app_exe_name);
    outcome.revert = run_revert(&app_exe, plan.revert_timeout);
    log(format!("Windows-Einstellungen zurückstellen: {}", outcome.revert.describe()));
    if outcome.revert != RevertResult::NoApp {
        // Falls nach einem Abbruch noch ein Pulsar-Prozess (z. B. der Admin-Helfer) die Datei sperrt.
        if let Err(e) = platform::kill_processes(&plan.app_exe_name) {
            log(format!("Nach dem Zurückstellen: {e}"));
        }
    }
    if !outcome.revert.is_ok() {
        outcome.warnings.push(format!("Einstellungen zurückstellen: {}", outcome.revert.describe()));
    }

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
