//! Labor-Läufe (P4): Eine Datei wird **nur nach „Ja, ausführen“** (Plan `RunInSandbox`) in
//! der Windows Sandbox (Stufe 1) oder der Mini-Sandbox (Stufe 2) gestartet und beobachtet.
//! Die Kopie der Probe liegt in einem eigenen Labor-Ordner des Dienstes und wird nach dem Lauf
//! verworfen; das Original bleibt unverändert. Ergebnis: Verhaltensbericht + Einschätzung, im
//! Verlauf festgehalten. Läufe sieht nur das Konto, das sie gestartet hat.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

use aegis_core::time::OffsetDateTime;
use aegis_sandbox::report::{Assessment, BehaviorReport};
use serde::Serialize;

/// Höchstgröße einer Probe.
pub const MAX_SAMPLE: u64 = 512 * 1024 * 1024;
/// Höchstzahl gemerkter Läufe je Konto bzw. insgesamt.
const MAX_RUNS_PER_OWNER: usize = 20;
const MAX_RUNS: usize = 200;
/// Höchstzahl gleichzeitiger Läufe.
pub const MAX_ACTIVE: usize = 2;
/// So lange wartet der Dienst zusätzlich auf den Bericht der Windows Sandbox (Start der VM).
#[cfg(windows)]
const SANDBOX_BOOT: Duration = Duration::from_secs(15 * 60);
/// Höchstgröße eines Bildschirmfotos.
pub const MAX_SHOT: u64 = 8 * 1024 * 1024;

/// Stufe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabStage {
    /// Windows Sandbox (VM).
    WindowsSandbox,
    /// Mini-Sandbox (AppContainer).
    MiniSandbox,
}

impl LabStage {
    /// Aus dem Plan-Parameter.
    #[must_use]
    pub fn from_param(value: &str) -> Option<Self> {
        match value {
            "windows_sandbox" => Some(Self::WindowsSandbox),
            "mini_sandbox" => Some(Self::MiniSandbox),
            _ => None,
        }
    }

    /// Plan-Parameter.
    #[must_use]
    pub const fn as_param(self) -> &'static str {
        match self {
            Self::WindowsSandbox => "windows_sandbox",
            Self::MiniSandbox => "mini_sandbox",
        }
    }
}

/// Zustand eines Laufs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LabState {
    /// Labor wird vorbereitet.
    Preparing,
    /// Probe läuft (Stufe 2: Prozess-IDs für Bildschirmfotos in der Sitzung des Nutzers).
    Running {
        /// Laufende Prozesse.
        pids: Vec<u32>,
    },
    /// Windows Sandbox läuft – Bericht folgt, wenn die Sonde fertig ist.
    WaitingForSandbox,
    /// Fertig.
    Done {
        /// Bericht.
        report: Box<BehaviorReport>,
        /// Einschätzung.
        assessment: Assessment,
    },
    /// Nicht möglich.
    Failed {
        /// Grund.
        message: String,
    },
}

/// Ein Lauf (für die Anzeige).
#[derive(Debug, Clone, Serialize)]
pub struct LabRun {
    /// Kennung.
    pub id: String,
    /// Name der Probe.
    pub sample: String,
    /// Stufe.
    pub stage: LabStage,
    /// Beobachtungszeit.
    pub seconds: u32,
    /// Beginn (RFC 3339).
    pub started: String,
    /// Zustand.
    pub state: LabState,
    /// Konto.
    #[serde(skip)]
    pub owner: Option<String>,
    /// Ausgabe-Ordner mit Bildschirmfotos (Stufe 1).
    #[serde(skip)]
    pub output: Option<PathBuf>,
}

/// Alle Läufe.
#[derive(Debug)]
pub struct Lab {
    dir: Option<PathBuf>,
    runs: Mutex<Vec<LabRun>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Alles, was ein Lauf zum Start braucht (im Anfrage-Thread mit den Rechten des Nutzers
/// vorbereitet).
pub struct LabStart {
    /// Kennung.
    pub id: String,
    /// Original (nur gelesen, mit den Rechten des Nutzers geöffnet).
    pub sample: std::fs::File,
    /// Anzeigename.
    pub sample_name: String,
    /// Stufe.
    pub stage: LabStage,
    /// Beobachtungszeit.
    pub seconds: u32,
    /// Netzwerk (nur Stufe 1).
    pub network: bool,
    /// Konto (SID).
    pub owner: Option<String>,
    /// Token des Nutzers (Windows).
    #[cfg(windows)]
    pub token: aegis_winffi::sandbox::UserToken,
}

impl Lab {
    /// Labor mit Ordner im Datenbereich (Betrieb).
    #[must_use]
    pub fn new(dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            dir,
            runs: Mutex::new(Vec::new()),
        })
    }

    /// Läufe eines Kontos, neueste zuerst.
    #[must_use]
    pub fn runs_of(&self, owner: Option<&str>) -> Vec<LabRun> {
        lock(&self.runs)
            .iter()
            .rev()
            .filter(|r| r.owner.as_deref() == owner)
            .cloned()
            .collect()
    }

    /// Laufende Läufe (für die Grenze gleichzeitiger Läufe).
    #[must_use]
    pub fn active(&self) -> usize {
        lock(&self.runs)
            .iter()
            .filter(|r| {
                matches!(
                    r.state,
                    LabState::Preparing | LabState::Running { .. } | LabState::WaitingForSandbox
                )
            })
            .count()
    }

    fn set_state(&self, id: &str, state: LabState) {
        if let Some(run) = lock(&self.runs).iter_mut().find(|r| r.id == id) {
            run.state = state;
        }
    }

    #[cfg(windows)]
    fn set_output(&self, id: &str, output: PathBuf) {
        if let Some(run) = lock(&self.runs).iter_mut().find(|r| r.id == id) {
            run.output = Some(output);
        }
    }

    /// Bildschirmfoto eines eigenen Laufs der Stufe 1 (nur Namen aus dem Bericht).
    ///
    /// # Errors
    /// Unbekannter Lauf/Name oder nicht lesbar.
    pub fn screenshot(&self, owner: Option<&str>, id: &str, name: &str) -> Result<Vec<u8>, String> {
        let (output, listed) = {
            let runs = lock(&self.runs);
            let run = runs
                .iter()
                .find(|r| r.id == id && r.owner.as_deref() == owner)
                .ok_or("Unbekannter Labor-Lauf")?;
            let listed = match &run.state {
                LabState::Done { report, .. } => report.screenshots.iter().any(|s| s == name),
                _ => false,
            };
            (run.output.clone(), listed)
        };
        let valid = name.len() == 12
            && name.starts_with("bild-")
            && name.ends_with(".png")
            && name[5..7].bytes().all(|b| b.is_ascii_digit());
        let output = output.ok_or("Kein Bildschirmfoto vorhanden")?;
        if !listed || !valid {
            return Err("Unbekanntes Bildschirmfoto".into());
        }
        let (file, meta) = aegis_engine::scan::open_regular(&output.join(name))
            .map_err(|e| format!("Bildschirmfoto nicht lesbar: {e}"))?;
        if meta.len() > MAX_SHOT {
            return Err("Bildschirmfoto zu groß".into());
        }
        let mut data = Vec::new();
        file.take(MAX_SHOT)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        Ok(data)
    }

    /// Startet einen Lauf im Hintergrund. `on_done` hält das Ergebnis im Verlauf fest.
    pub fn start(
        self: &Arc<Self>,
        start: LabStart,
        on_done: impl FnOnce(&LabRun) + Send + 'static,
    ) {
        let run = LabRun {
            id: start.id.clone(),
            sample: start.sample_name.clone(),
            stage: start.stage,
            seconds: start.seconds,
            started: OffsetDateTime::now_utc()
                .format(&aegis_core::time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
            state: LabState::Preparing,
            owner: start.owner.clone(),
            output: None,
        };
        {
            let mut runs = lock(&self.runs);
            let owner_runs = runs.iter().filter(|r| r.owner == run.owner).count();
            if owner_runs >= MAX_RUNS_PER_OWNER
                && let Some(i) = runs.iter().position(|r| r.owner == run.owner)
            {
                runs.remove(i);
            }
            runs.push(run);
            while runs.len() > MAX_RUNS {
                runs.remove(0);
            }
        }
        let lab = Arc::clone(self);
        std::thread::spawn(move || {
            let id = start.id.clone();
            let state = lab.execute(start);
            lab.set_state(&id, state);
            if let Some(run) = lock(&lab.runs).iter().find(|r| r.id == id) {
                on_done(run);
            }
        });
    }

    #[cfg(not(windows))]
    fn execute(&self, start: LabStart) -> LabState {
        let _ = (&start.sample, start.network, &self.dir);
        LabState::Failed {
            message: "Das Labor gibt es nur unter Windows.".into(),
        }
    }

    #[cfg(windows)]
    fn execute(&self, start: LabStart) -> LabState {
        let Some(base) = &self.dir else {
            return LabState::Failed {
                message: "Kein Labor-Ordner".into(),
            };
        };
        let run_dir = base.join(&start.id);
        let result = match start.stage {
            LabStage::MiniSandbox => self.run_mini(&run_dir, &start),
            LabStage::WindowsSandbox => self.run_windows_sandbox(&run_dir, &start),
        };
        // Die Kopie der Probe (und was sie im Labor geschrieben hat) verwerfen; bei Stufe 1
        // bleiben nur Bericht und Bildschirmfotos.
        let keep = matches!(start.stage, LabStage::WindowsSandbox).then(|| run_dir.join("bericht"));
        cleanup(&run_dir, keep.as_deref());
        match result {
            Ok(mut report) => {
                report.truncate();
                let assessment = report.assess();
                LabState::Done {
                    report: Box::new(report),
                    assessment,
                }
            }
            Err(message) => LabState::Failed { message },
        }
    }

    #[cfg(windows)]
    fn run_mini(&self, run_dir: &Path, start: &LabStart) -> Result<BehaviorReport, String> {
        use aegis_winffi::sandbox::{LAB_APPCONTAINER, appcontainer_sid, create_dir_with_sddl};
        let sid = appcontainer_sid(LAB_APPCONTAINER).map_err(|e| e.to_string())?;
        create_dir_with_sddl(
            run_dir,
            &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{sid})"),
        )
        .map_err(|e| format!("Labor-Ordner nicht anlegbar: {e}"))?;
        let (copy, sha) = copy_sample(&start.sample, run_dir, &start.sample_name)?;
        let hive = start.owner.clone().map_or(
            aegis_winffi::inspect::Hive::CurrentUser,
            aegis_winffi::inspect::Hive::User,
        );
        let id = start.id.clone();
        let report = aegis_sandbox::mini::run(
            &aegis_sandbox::mini::MiniRun {
                sample: copy,
                work_dir: run_dir.to_path_buf(),
                seconds: start.seconds,
                hive,
                sample_name: start.sample_name.clone(),
                sha256: Some(sha),
            },
            &start.token,
            |pids| {
                self.set_state(
                    &id,
                    LabState::Running {
                        pids: pids.to_vec(),
                    },
                );
            },
        );
        Ok(report)
    }

    #[cfg(windows)]
    fn run_windows_sandbox(
        &self,
        run_dir: &Path,
        start: &LabStart,
    ) -> Result<BehaviorReport, String> {
        use aegis_sandbox::wsb::{Network, PROBE_EXE, WsbConfig, check_sample_name};
        use aegis_winffi::sandbox::{create_dir_with_sddl, spawn_as_user};
        let user = start
            .owner
            .clone()
            .ok_or("Windows Sandbox nur mit angemeldetem Konto")?;
        let status = aegis_sandbox::detect::status();
        if !status.enabled {
            return Err(status.message_de().to_owned());
        }
        let probe = locate_probe().ok_or("Sonde aegis-sandbox-probe fehlt neben dem Dienst")?;
        check_sample_name(&start.sample_name)?;
        let base = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;{user})");
        create_dir_with_sddl(run_dir, &base).map_err(|e| e.to_string())?;
        let probe_dir = run_dir.join("probe");
        let output = run_dir.join("bericht");
        create_dir_with_sddl(&probe_dir, &base).map_err(|e| e.to_string())?;
        create_dir_with_sddl(
            &output,
            &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{user})"),
        )
        .map_err(|e| e.to_string())?;
        let (_, sha) = copy_sample(&start.sample, &probe_dir, &start.sample_name)?;
        let probe_file = std::fs::File::open(&probe).map_err(|e| e.to_string())?;
        copy_sample(&probe_file, &probe_dir, PROBE_EXE)?;
        let config = WsbConfig {
            probe_dir: probe_dir.clone(),
            output_dir: output.clone(),
            sample_name: start.sample_name.clone(),
            seconds: start.seconds,
            network: if start.network {
                Network::Simulated
            } else {
                Network::Off
            },
        };
        let wsb = run_dir.join("labor.wsb");
        write_new(&wsb, config.to_xml()?.as_bytes())?;
        let exe = aegis_sandbox::detect::sandbox_exe().ok_or("WindowsSandbox.exe fehlt")?;
        spawn_as_user(&start.token, &exe, &wsb)
            .map_err(|e| format!("Windows Sandbox startet nicht: {e}"))?;
        self.set_output(&start.id, output.clone());
        self.set_state(&start.id, LabState::WaitingForSandbox);
        let deadline =
            Instant::now() + SANDBOX_BOOT + Duration::from_secs(u64::from(start.seconds));
        let report_path = output.join("report.json");
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(3));
            if let Ok((file, meta)) = aegis_engine::scan::open_regular(&report_path)
                && meta.len() <= 16 * 1024 * 1024
            {
                let mut text = String::new();
                if file
                    .take(16 * 1024 * 1024)
                    .read_to_string(&mut text)
                    .is_ok()
                    && let Ok(mut report) = serde_json::from_str::<BehaviorReport>(&text)
                {
                    report.sha256 = Some(sha);
                    report.sample = start.sample_name.clone();
                    report.stage = aegis_sandbox::Stage::WindowsSandbox;
                    report
                        .screenshots
                        .retain(|s| s.starts_with("bild-") && s.ends_with(".png"));
                    return Ok(report);
                }
            }
        }
        Err("Die Windows Sandbox hat keinen Bericht geliefert (Zeitlimit).".into())
    }
}

/// Sonde neben dem Dienst.
#[cfg(windows)]
fn locate_probe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = aegis_sandbox::wsb::PROBE_EXE;
    let dir = exe.parent()?;
    [dir.join(name), dir.parent()?.join(name)]
        .into_iter()
        .find(|p| p.is_file())
}

/// Kopiert die Probe (aus dem mit Nutzerrechten geöffneten Original) in den Labor-Ordner und
/// berechnet dabei SHA-256. Liefert Pfad der Kopie und Prüfsumme.
#[cfg_attr(not(windows), allow(dead_code))]
fn copy_sample(
    source: &std::fs::File,
    dir: &Path,
    name: &str,
) -> Result<(PathBuf, String), String> {
    use sha2::{Digest, Sha256};
    let target = dir.join(name);
    let mut out = create_new(&target).map_err(|e| format!("Kopie nicht anlegbar: {e}"))?;
    let mut hasher = Sha256::new();
    let mut reader = source.take(MAX_SAMPLE + 1);
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_SAMPLE {
            return Err("Probe ist zu groß für das Labor".into());
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    out.sync_all().map_err(|e| e.to_string())?;
    let sha: [u8; 32] = hasher.finalize().into();
    Ok((target, aegis_engine::hash::to_hex(&sha)))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn create_new(path: &Path) -> io::Result<std::fs::File> {
    // Neue Datei im eigenen Labor-Ordner (Kopie der Probe, Sonde, Konfiguration) – nach
    // Freigabe des Labor-Laufs, nie überschreiben.
    // aegis-mutation: service-lab-create
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    file
}

#[cfg(windows)]
fn write_new(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut file = create_new(path).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())
}

/// Verwirft den Labor-Ordner eines Laufs (nur unter dem eigenen Labor-Ordner), außer `keep`.
#[cfg_attr(not(windows), allow(dead_code))]
fn cleanup(run_dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(run_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        for _ in 0..10 {
            if remove_lab_entry(&path).is_ok() {
                break;
            }
            // Die Windows Sandbox gibt eingebundene Ordner erst nach dem Beenden frei.
            std::thread::sleep(Duration::from_secs(3));
        }
    }
    if keep.is_none() {
        let _ = remove_lab_entry(run_dir);
    }
}

fn remove_lab_entry(path: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    // Verwirft den eigenen Labor-Ordner bzw. Dateien darin nach dem Lauf (Kopie der Probe,
    // vom Programm im Labor geschriebene Dateien) – nie etwas außerhalb des Labor-Ordners;
    // Links werden selbst entfernt, nicht verfolgt.
    // aegis-mutation: service-lab-cleanup
    #[allow(clippy::disallowed_methods)]
    let result = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result
}

/// Schaltet das Windows-Feature „Windows Sandbox“ ein (DISM, fester Systempfad, ohne
/// Neustart). Nur nach Freigabe eines Administrators aufrufen.
///
/// # Errors
/// DISM fehlt, startet nicht oder meldet einen Fehler.
pub fn enable_windows_sandbox() -> Result<(), String> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .ok_or("SystemRoot unbekannt")?;
        let dism = root.join(r"System32\dism.exe");
        // Schaltet nach Freigabe (Plan „Windows Sandbox einschalten“) das Windows-Feature ein –
        // festes Programm, feste Argumente, kein Neustart.
        // aegis-mutation: service-lab-enable-feature
        #[allow(clippy::disallowed_methods)]
        let status = std::process::Command::new(&dism)
            .args([
                "/Online",
                "/Enable-Feature",
                &format!("/FeatureName:{}", aegis_sandbox::detect::FEATURE),
                "/All",
                "/NoRestart",
                "/Quiet",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("DISM startet nicht: {e}"))?;
        // 3010 = Erfolg, Neustart nötig.
        match status.code() {
            Some(0 | 3010) => Ok(()),
            code => Err(format!("DISM meldet Code {}", code.unwrap_or(-1))),
        }
    }
    #[cfg(not(windows))]
    {
        Err("Nur unter Windows".into())
    }
}

/// Räumt beim Start liegengebliebene Labor-Ordner früherer Läufe weg (eigener Labor-Ordner).
pub fn cleanup_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = remove_lab_entry(&entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kopie_mit_pruefsumme_und_grenzen() {
        let dir = tempfile::tempdir().unwrap();
        let src = aegis_core::testing::write_fixture(dir.path(), "a.txt", b"hallo").unwrap();
        let lab = dir.path().join("lab");
        aegis_core::testing::create_fixture_dir(dir.path(), "lab").unwrap();
        let file = std::fs::File::open(&src).unwrap();
        let (copy, sha) = copy_sample(&file, &lab, "probe.txt").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"hallo");
        assert_eq!(sha.len(), 64);
        let file = std::fs::File::open(&src).unwrap();
        assert!(
            copy_sample(&file, &lab, "probe.txt").is_err(),
            "nie überschreiben"
        );
        cleanup(&lab, None);
        assert!(!lab.exists());
        assert!(src.exists(), "Original bleibt");
    }

    #[test]
    fn fremde_laeufe_unsichtbar() {
        let lab = Lab::new(None);
        lock(&lab.runs).push(LabRun {
            id: "1".into(),
            sample: "a.exe".into(),
            stage: LabStage::MiniSandbox,
            seconds: 30,
            started: String::new(),
            state: LabState::Preparing,
            owner: Some("S-A".into()),
            output: None,
        });
        assert_eq!(lab.runs_of(Some("S-A")).len(), 1);
        assert!(lab.runs_of(Some("S-B")).is_empty());
        assert_eq!(lab.active(), 1);
        assert!(lab.screenshot(Some("S-B"), "1", "bild-01.png").is_err());
    }
}
