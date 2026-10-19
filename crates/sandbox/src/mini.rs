//! Stufe 2 – Mini-Sandbox (Windows): startet die (kopierte) Probe im AppContainer ohne
//! Fähigkeiten (kein Netz), mit niedriger Integrität, im Job mit Grenzen; beobachtet sie für
//! die eingestellte Zeit und beendet danach alle Prozesse des Laufs. Aufrufen nur mit einer
//! Freigabe („Im Labor ausführen“) – das prüft der Dienst.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use aegis_winffi::inspect::Hive;
use aegis_winffi::sandbox::{
    LAB_APPCONTAINER, LabLimits, UserToken, appcontainer_sid, spawn_in_appcontainer,
};

use crate::observe::Observer;
use crate::report::{BehaviorReport, RunEnd, Stage};

/// Grenzen der Mini-Sandbox.
pub const LIMITS: LabLimits = LabLimits {
    memory_bytes: 1024 * 1024 * 1024,
    processes: 16,
    cpu_percent: 50,
};

/// Ein Lauf.
#[derive(Debug, Clone)]
pub struct MiniRun {
    /// Kopie der Probe im Labor-Ordner.
    pub sample: PathBuf,
    /// Arbeitsordner (für den AppContainer beschreibbar).
    pub work_dir: PathBuf,
    /// Beobachtungszeit.
    pub seconds: u32,
    /// Registrierung des Nutzers (für Autostart-Vergleich).
    pub hive: Hive,
    /// Anzeigename der Probe.
    pub sample_name: String,
    /// SHA-256 der Probe.
    pub sha256: Option<String>,
}

/// Ehrliche Grenzen dieser Stufe.
#[must_use]
pub fn notes() -> Vec<String> {
    vec![
        "Mini-Sandbox (AppContainer, niedrige Integrität, Job-Grenzen) – schwächer als eine VM: gleicher Kernel und Desktop.".into(),
        "Netzwerk ist gesperrt; einzelne Verbindungsversuche erkennt diese Stufe nicht.".into(),
        "Zugriffe außerhalb des Labor-Ordners werden verweigert und nicht einzeln aufgezeichnet.".into(),
        "Befehlszeilen der Prozesse werden in dieser Stufe nicht erfasst.".into(),
    ]
}

/// Führt den Lauf aus. `on_pids` erhält regelmäßig die laufenden Prozess-IDs (für
/// Bildschirmfotos in der Sitzung des Nutzers).
pub fn run(run: &MiniRun, token: &UserToken, mut on_pids: impl FnMut(&[u32])) -> BehaviorReport {
    let mut observer = Observer::start(vec![run.work_dir.clone()], run.hive.clone(), true);
    let report = |end: RunEnd, observer: Observer| {
        let observed = observer.finish();
        let mut report = BehaviorReport {
            stage: Stage::MiniSandbox,
            sample: run.sample_name.clone(),
            sha256: run.sha256.clone(),
            seconds: run.seconds,
            end,
            processes: observed.processes,
            files: observed.files,
            registry: observed.registry,
            network: observed.network,
            screenshots: Vec::new(),
            notes: notes(),
        };
        report.truncate();
        report
    };
    let sid = match appcontainer_sid(LAB_APPCONTAINER) {
        Ok(s) => s,
        Err(e) => {
            return report(
                RunEnd::Failed {
                    message: format!("AppContainer nicht verfügbar: {e}"),
                },
                observer,
            );
        }
    };
    let child = match spawn_in_appcontainer(token, &sid, &run.sample, &run.work_dir, LIMITS) {
        Ok(c) => c,
        Err(e) => {
            return report(
                RunEnd::Failed {
                    message: format!("Probe startet nicht: {e}"),
                },
                observer,
            );
        }
    };
    let deadline = Instant::now() + Duration::from_secs(u64::from(run.seconds));
    let mut end = RunEnd::TimedOut;
    while Instant::now() < deadline {
        let pids = child.process_ids().unwrap_or_default();
        let roots: Vec<u32> = if pids.is_empty() {
            vec![child.pid]
        } else {
            pids.clone()
        };
        observer.poll(&roots);
        on_pids(&pids);
        if pids.is_empty() {
            if let Ok(Some(code)) = child.wait_timeout(Duration::ZERO) {
                end = RunEnd::Exited {
                    code: i64::from(code),
                };
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // Ende der Beobachtungszeit: alle Prozesse des Laufs beenden (nur der eigene Job).
    let _ = child.terminate();
    on_pids(&[]);
    report(end, observer)
}
