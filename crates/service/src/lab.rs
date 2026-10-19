//! Labor-Läufe (P4): Eine Datei wird **nur nach „Ja, ausführen“** (Plan `RunInSandbox`) in
//! der Windows Sandbox (Stufe 1) oder der Mini-Sandbox (Stufe 2) gestartet und beobachtet.
//! Die Kopie der Probe liegt in einem eigenen Labor-Ordner des Dienstes und wird nach dem Lauf
//! verworfen; das Original bleibt unverändert. Ergebnis: Verhaltensbericht + Einschätzung, im
//! Verlauf festgehalten. Läufe sieht nur das Konto, das sie gestartet hat.
//!
//! Die Erlaubnis (`ExecutionPermit`) wandert mit in den Lauf und wird erst mit dem echten
//! Ergebnis abgeschlossen; das Prüfprotokoll-Ereignis holt der Dienst bei der nächsten Anfrage
//! ab ([`Lab::take_audit`]). Was die Probe bzw. die Windows Sandbox schreibt, liest der Dienst
//! nur mit den Rechten des Nutzers.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

use aegis_core::audit::{AuditEvent, ExecutionResult};
use aegis_core::consent::ExecutionPermit;
use aegis_core::time::OffsetDateTime;
use aegis_sandbox::report::{Assessment, BehaviorReport};
use serde::Serialize;

/// Höchstgröße einer Probe.
pub const MAX_SAMPLE: u64 = 512 * 1024 * 1024;
/// Höchstzahl gemerkter Läufe je Konto bzw. insgesamt.
const MAX_RUNS_PER_OWNER: usize = 20;
const MAX_RUNS: usize = 100;
/// Höchstzahl gleichzeitiger Läufe insgesamt bzw. je Konto.
pub const MAX_ACTIVE: usize = 2;
const MAX_ACTIVE_PER_OWNER: usize = 1;
/// So lange wartet der Dienst zusätzlich auf den Bericht der Windows Sandbox (Start der VM).
#[cfg(windows)]
const SANDBOX_BOOT: Duration = Duration::from_secs(15 * 60);
/// Nach dem Bericht hat die Windows Sandbox so lange Zeit, sich selbst zu schließen.
#[cfg(windows)]
const SANDBOX_GRACE: Duration = Duration::from_secs(60);
/// Höchstgröße der Ausgabe der Windows Sandbox (Bericht + Bildschirmfotos).
#[cfg(windows)]
const MAX_OUTPUT: u64 = 64 * 1024 * 1024;
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

/// Zustand eines Laufs. Der vollständige Bericht wird nicht mit dem Zustand gesendet (nur auf
/// Anfrage je Lauf, [`Lab::report`]).
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
        /// Bericht (nur über [`Lab::report`]).
        #[serde(skip)]
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

impl LabState {
    fn active(&self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Running { .. } | Self::WaitingForSandbox
        )
    }
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
    /// AppContainer-SID des Laufs (Stufe 2) – die App fotografiert nur Fenster solcher Prozesse.
    pub container: Option<String>,
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
    /// Abgeschlossene Erlaubnisse (für das Prüfprotokoll des Dienstes).
    audit: Mutex<Vec<AuditEvent>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Alles, was ein Lauf zum Start braucht (im Anfrage-Thread mit den Rechten des Nutzers
/// vorbereitet). Nur mit der Erlaubnis des freigegebenen Plans.
pub(crate) struct LabStart {
    /// Erlaubnis des Plans „Im Labor ausführen“ (wird mit dem echten Ergebnis abgeschlossen).
    pub permit: ExecutionPermit,
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
    /// SHA-256 zum Zeitpunkt des Vorschlags (aus dem Plan).
    pub expected_sha256: String,
    /// Konto (SID).
    pub owner: Option<String>,
    /// Token des Nutzers (Windows).
    #[cfg(windows)]
    pub token: aegis_winffi::sandbox::UserToken,
}

/// Name der Kopie im Labor: fester Name + geprüfte Endung des Originals (kein Nutzername auf
/// der Platte – keine Datenströme, Punkte am Ende oder Sonderzeichen).
#[must_use]
pub fn copy_name(original: &str) -> String {
    let ext = Path::new(original)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| (1..=8).contains(&e.len()) && e.bytes().all(|b| b.is_ascii_alphanumeric()))
        .map(str::to_ascii_lowercase);
    ext.map_or_else(|| "probe".to_owned(), |e| format!("probe.{e}"))
}

/// Gültiger Name eines Bildschirmfotos der Sonde (`bild-NN.png`, nur ASCII).
#[must_use]
pub fn valid_screenshot_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 11
        && name.is_ascii()
        && b.starts_with(b"bild-")
        && b.ends_with(b".png")
        && b[5..7].iter().all(u8::is_ascii_digit)
}

impl Lab {
    /// Labor mit Ordner im Datenbereich (Betrieb).
    #[must_use]
    pub fn new(dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            dir,
            runs: Mutex::new(Vec::new()),
            audit: Mutex::new(Vec::new()),
        })
    }

    /// Läufe eines Kontos, neueste zuerst (ohne vollständige Berichte).
    #[must_use]
    pub fn runs_of(&self, owner: Option<&str>) -> Vec<LabRun> {
        lock(&self.runs)
            .iter()
            .rev()
            .filter(|r| r.owner.as_deref() == owner)
            .cloned()
            .collect()
    }

    /// Vollständiger Bericht eines eigenen, fertigen Laufs.
    ///
    /// # Errors
    /// Unbekannter Lauf oder noch nicht fertig.
    pub fn report(&self, owner: Option<&str>, id: &str) -> Result<BehaviorReport, String> {
        let runs = lock(&self.runs);
        let run = runs
            .iter()
            .find(|r| r.id == id && r.owner.as_deref() == owner)
            .ok_or("Unbekannter Labor-Lauf")?;
        match &run.state {
            LabState::Done { report, .. } => Ok((**report).clone()),
            _ => Err("Der Lauf ist noch nicht fertig".into()),
        }
    }

    /// Laufende Läufe (für die Grenze gleichzeitiger Läufe).
    #[must_use]
    pub fn active(&self) -> usize {
        lock(&self.runs).iter().filter(|r| r.state.active()).count()
    }

    /// Merkt ein Prüfprotokoll-Ereignis eines Hintergrund-Ablaufs vor.
    pub(crate) fn push_audit(&self, event: AuditEvent) {
        lock(&self.audit).push(event);
    }

    /// Prüfprotokoll-Ereignisse abgeschlossener Läufe (holt der Dienst ab).
    pub fn take_audit(&self) -> Vec<AuditEvent> {
        std::mem::take(&mut *lock(&self.audit))
    }

    fn set_state(&self, id: &str, state: LabState) {
        if let Some(run) = lock(&self.runs).iter_mut().find(|r| r.id == id) {
            run.state = state;
        }
    }

    #[cfg(windows)]
    fn update(&self, id: &str, f: impl FnOnce(&mut LabRun)) {
        if let Some(run) = lock(&self.runs).iter_mut().find(|r| r.id == id) {
            f(run);
        }
    }

    /// Pfad eines Bildschirmfotos eines eigenen Laufs der Stufe 1 (nur im Bericht genannte
    /// Namen). Gelesen wird es mit [`read_screenshot`] – mit den Rechten des Nutzers.
    ///
    /// # Errors
    /// Unbekannter Lauf/Name.
    pub fn screenshot_path(
        &self,
        owner: Option<&str>,
        id: &str,
        name: &str,
    ) -> Result<PathBuf, String> {
        if !valid_screenshot_name(name) {
            return Err("Unbekanntes Bildschirmfoto".into());
        }
        let runs = lock(&self.runs);
        let run = runs
            .iter()
            .find(|r| r.id == id && r.owner.as_deref() == owner)
            .ok_or("Unbekannter Labor-Lauf")?;
        let listed = match &run.state {
            LabState::Done { report, .. } => report.screenshots.iter().any(|s| s == name),
            _ => false,
        };
        let output = run.output.as_ref().ok_or("Kein Bildschirmfoto vorhanden")?;
        if !listed {
            return Err("Unbekanntes Bildschirmfoto".into());
        }
        Ok(output.join(name))
    }

    /// Startet einen Lauf im Hintergrund. `on_done` hält das Ergebnis im Verlauf fest.
    ///
    /// # Errors
    /// Zu viele gleichzeitige Läufe – die Erlaubnis kommt unverbraucht zurück.
    pub(crate) fn start(
        self: &Arc<Self>,
        start: LabStart,
        on_done: impl FnOnce(&LabRun) + Send + 'static,
    ) -> Result<(), Box<(LabStart, String)>> {
        let run = LabRun {
            id: start.id.clone(),
            sample: start.sample_name.clone(),
            stage: start.stage,
            seconds: start.seconds,
            started: OffsetDateTime::now_utc()
                .format(&aegis_core::time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
            state: LabState::Preparing,
            container: None,
            owner: start.owner.clone(),
            output: None,
        };
        {
            // Grenzen und Eintragen in einem Schritt (keine Lücke zwischen Prüfen und Starten).
            let mut runs = lock(&self.runs);
            let active = runs.iter().filter(|r| r.state.active()).count();
            let active_own = runs
                .iter()
                .filter(|r| r.state.active() && r.owner == run.owner)
                .count();
            if active >= MAX_ACTIVE || active_own >= MAX_ACTIVE_PER_OWNER {
                return Err(Box::new((
                    start,
                    "Es läuft schon ein Labor-Lauf – bitte warten, bis er fertig ist".into(),
                )));
            }
            // Platz schaffen: nur fertige Läufe werden vergessen.
            let owner_runs = runs.iter().filter(|r| r.owner == run.owner).count();
            if owner_runs >= MAX_RUNS_PER_OWNER
                && let Some(i) = runs
                    .iter()
                    .position(|r| r.owner == run.owner && !r.state.active())
            {
                runs.remove(i);
            }
            while runs.len() >= MAX_RUNS {
                let Some(i) = runs.iter().position(|r| !r.state.active()) else {
                    break;
                };
                runs.remove(i);
            }
            runs.push(run);
        }
        let lab = Arc::clone(self);
        std::thread::spawn(move || {
            let id = start.id.clone();
            let (permit, state) = lab.execute(start);
            let result = match &state {
                LabState::Failed { message } => ExecutionResult::Failed {
                    message: message.clone(),
                },
                _ => ExecutionResult::Succeeded,
            };
            lock(&lab.audit).push(permit.complete(result));
            lab.set_state(&id, state);
            if let Some(run) = lock(&lab.runs).iter().find(|r| r.id == id) {
                on_done(run);
            }
        });
        Ok(())
    }

    #[cfg(not(windows))]
    fn execute(&self, start: LabStart) -> (ExecutionPermit, LabState) {
        let _ = (
            &start.sample,
            start.network,
            &self.dir,
            &start.expected_sha256,
        );
        (
            start.permit,
            LabState::Failed {
                message: "Das Labor gibt es nur unter Windows.".into(),
            },
        )
    }

    #[cfg(windows)]
    fn execute(&self, mut start: LabStart) -> (ExecutionPermit, LabState) {
        let Some(base) = &self.dir else {
            return (
                start.permit,
                LabState::Failed {
                    message: "Kein Labor-Ordner".into(),
                },
            );
        };
        // Die Probe bekommt nie Administratorrechte (verknüpftes, nicht erhöhtes Token).
        start.token = start.token.into_unelevated();
        let run_dir = base.join(&start.id);
        let result = match start.stage {
            LabStage::MiniSandbox => self.run_mini(&run_dir, &start),
            LabStage::WindowsSandbox => self.run_windows_sandbox(&run_dir, &start),
        };
        // Die Kopie der Probe (und was sie im Labor geschrieben hat) verwerfen; bei Stufe 1
        // bleiben nur Bericht und Bildschirmfotos.
        let keep = matches!(start.stage, LabStage::WindowsSandbox).then(|| run_dir.join("bericht"));
        cleanup(&run_dir, keep.as_deref());
        let state = match result {
            Ok(mut report) => {
                report.truncate();
                let assessment = report.assess();
                LabState::Done {
                    report: Box::new(report),
                    assessment,
                }
            }
            Err(message) => LabState::Failed { message },
        };
        (start.permit, state)
    }

    #[cfg(windows)]
    fn run_mini(&self, run_dir: &Path, start: &LabStart) -> Result<BehaviorReport, String> {
        use aegis_winffi::sandbox::{
            appcontainer_sid, create_dir_with_sddl, delete_appcontainer_profile,
            ensure_appcontainer_profile, lab_appcontainer_name,
        };
        let user = start
            .owner
            .clone()
            .ok_or("Mini-Sandbox nur mit angemeldetem Konto")?;
        // Eigenes AppContainer-Profil je Lauf, angelegt und gelöscht als der Nutzer.
        let container = lab_appcontainer_name(&start.id);
        {
            let _as_user = start
                .token
                .impersonate()
                .map_err(|e| format!("Rechte des Nutzers nicht übernehmbar: {e}"))?;
            ensure_appcontainer_profile(&container)
                .map_err(|e| format!("AppContainer-Profil nicht anlegbar: {e}"))?;
        }
        let result = (|| {
            let sid = appcontainer_sid(&container).map_err(|e| e.to_string())?;
            self.update(&start.id, |r| r.container = Some(sid.clone()));
            create_dir_with_sddl(run_dir, &aegis_sandbox::acl::mini_work_dir(&sid, &user)?)
                .map_err(|e| format!("Labor-Ordner nicht anlegbar: {e}"))?;
            let name = copy_name(&start.sample_name);
            let (copy, sha) = copy_sample(&start.sample, run_dir, &name)?;
            check_hash(&sha, &start.expected_sha256)?;
            let id = start.id.clone();
            Ok(aegis_sandbox::mini::run(
                &aegis_sandbox::mini::MiniRun {
                    sample: copy,
                    work_dir: run_dir.to_path_buf(),
                    seconds: start.seconds,
                    hive: aegis_winffi::inspect::Hive::User(user.clone()),
                    sample_name: start.sample_name.clone(),
                    sha256: Some(sha),
                    container: container.clone(),
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
            ))
        })();
        if let Ok(_as_user) = start.token.impersonate() {
            let _ = delete_appcontainer_profile(&container);
        }
        result
    }

    #[cfg(windows)]
    fn run_windows_sandbox(
        &self,
        run_dir: &Path,
        start: &LabStart,
    ) -> Result<BehaviorReport, String> {
        use aegis_sandbox::acl::{wsb_output, wsb_read_only};
        use aegis_sandbox::wsb::{Network, PROBE_EXE, WsbConfig};
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
        let name = copy_name(&start.sample_name);
        create_dir_with_sddl(run_dir, &wsb_read_only(&user)?).map_err(|e| e.to_string())?;
        let probe_dir = run_dir.join("probe");
        let output = run_dir.join("bericht");
        create_dir_with_sddl(&probe_dir, &wsb_read_only(&user)?).map_err(|e| e.to_string())?;
        create_dir_with_sddl(&output, &wsb_output(&user)?).map_err(|e| e.to_string())?;
        let (_, sha) = copy_sample(&start.sample, &probe_dir, &name)?;
        check_hash(&sha, &start.expected_sha256)?;
        let probe_file = std::fs::File::open(&probe).map_err(|e| e.to_string())?;
        copy_sample(&probe_file, &probe_dir, PROBE_EXE)?;
        let config = WsbConfig {
            probe_dir: probe_dir.clone(),
            output_dir: output.clone(),
            sample_name: name,
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
        let vm = spawn_as_user(&start.token, &exe, &wsb)
            .map_err(|e| format!("Windows Sandbox startet nicht: {e}"))?;
        self.update(&start.id, |r| {
            r.output = Some(output.clone());
            r.state = LabState::WaitingForSandbox;
        });
        let deadline =
            Instant::now() + SANDBOX_BOOT + Duration::from_secs(u64::from(start.seconds));
        let report_path = output.join("report.json");
        let mut report_seen: Option<Instant> = None;
        let outcome = loop {
            std::thread::sleep(Duration::from_secs(3));
            if dir_size(&output) > MAX_OUTPUT {
                let _ = vm.terminate();
                break Err(
                    "Die Windows Sandbox hat zu viele Daten geschrieben – Lauf beendet.".to_owned(),
                );
            }
            let exists = std::fs::symlink_metadata(&report_path).is_ok();
            if exists && report_seen.is_none() {
                report_seen = Some(Instant::now());
            }
            // Bericht erst lesen, wenn die VM beendet ist (bzw. nach kurzer Frist beendet wurde) –
            // bis dahin könnte die Probe ihn noch verändern.
            let grace_over = report_seen.is_some_and(|t| t.elapsed() > SANDBOX_GRACE);
            if exists && (!vm.running() || grace_over) {
                let _ = vm.terminate();
                break Ok(());
            }
            if Instant::now() >= deadline {
                let _ = vm.terminate();
                if exists {
                    break Ok(());
                }
                break Err("Die Windows Sandbox hat keinen Bericht geliefert (Zeitlimit) – sie wurde beendet.".to_owned());
            }
        };
        outcome?;
        let text = {
            let _as_user = start
                .token
                .impersonate()
                .map_err(|e| format!("Rechte des Nutzers nicht übernehmbar: {e}"))?;
            read_user_file(&report_path, aegis_sandbox::report::MAX_REPORT_BYTES)?
        };
        let mut report: BehaviorReport = serde_json::from_slice(&text)
            .map_err(|e| format!("Bericht der Windows Sandbox unlesbar: {e}"))?;
        report.sha256 = Some(sha);
        report.sample = start.sample_name.clone();
        report.stage = aegis_sandbox::Stage::WindowsSandbox;
        report.seconds = start.seconds;
        report.screenshots.retain(|s| valid_screenshot_name(s));
        report.screenshots.truncate(32);
        // Hinweise stammen vom Dienst, nicht aus der VM.
        report.notes = wsb_notes(start.network);
        Ok(report)
    }
}

/// Ehrliche Hinweise zu Stufe 1 (vom Dienst, nicht aus der VM).
#[cfg_attr(not(windows), allow(dead_code))]
fn wsb_notes(network: bool) -> Vec<String> {
    let mut notes = vec![
        "Windows Sandbox (eigene, wegwerfbare VM). Der Bericht wurde in der VM erstellt – die Probe lief dort mit Administratorrechten und hätte ihn verfälschen können.".to_owned(),
    ];
    if network {
        notes.push(
            "Netzwerk war eingeschaltet: Die Probe konnte ins Internet und ins Heimnetz.".into(),
        );
    }
    notes
}

/// Bricht ab, wenn die Probe nicht mehr die geprüfte Datei ist.
#[cfg_attr(not(windows), allow(dead_code))]
fn check_hash(actual: &str, expected: &str) -> Result<(), String> {
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("Die Datei hat sich seit dem Vorschlag verändert – nichts gestartet.".into())
    }
}

/// Größe aller Dateien eines (eigenen) Ordners, ohne Links zu folgen.
#[cfg(windows)]
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten().take(10_000) {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            total = total.saturating_add(meta.len());
            if meta.is_dir() && depth < 4 {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    total
}

/// Liest eine Datei, die ein Nutzer (bzw. die Windows Sandbox als Nutzer) schreiben konnte –
/// **im Identitätswechsel aufrufen**. Ohne Links, ohne weitere Hardlinks, mit Größengrenze.
///
/// # Errors
/// Nicht lesbar, Link, mehrere Namen oder zu groß.
pub fn read_user_file(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let (file, meta) =
        aegis_engine::scan::open_regular(path).map_err(|e| format!("nicht lesbar: {e}"))?;
    #[cfg(windows)]
    if aegis_winffi::fs::link_count(&file).map_err(|e| e.to_string())? != 1 {
        return Err("Datei hat mehrere Namen (Hardlink) – nicht gelesen".into());
    }
    if meta.len() > max {
        return Err("Datei zu groß".into());
    }
    let mut data = Vec::new();
    file.take(max)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    Ok(data)
}

/// Bildschirmfoto lesen (im Identitätswechsel) und als PNG prüfen.
///
/// # Errors
/// Nicht lesbar oder kein gültiges PNG.
pub fn read_screenshot(path: &Path) -> Result<Vec<u8>, String> {
    let data = read_user_file(path, MAX_SHOT).map_err(|e| format!("Bildschirmfoto {e}"))?;
    aegis_sandbox::png::check_png(&data).map_err(|e| format!("Bildschirmfoto: {e}"))?;
    Ok(data)
}

/// Sonde neben dem Dienst (nur im Programmordner).
#[cfg(windows)]
fn locate_probe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let probe = exe.parent()?.join(aegis_sandbox::wsb::PROBE_EXE);
    probe.is_file().then_some(probe)
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

/// Läuft gerade DISM (höchstens einmal gleichzeitig)?
static DISM_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Schaltet das Windows-Feature „Windows Sandbox“ ein (DISM, fester Systempfad, ohne
/// Neustart, höchstens 30 Minuten). Nur mit der Erlaubnis des Plans „Windows Sandbox
/// einschalten“ (Administrator).
///
/// # Errors
/// DISM läuft schon, fehlt, startet nicht, dauert zu lange oder meldet einen Fehler.
pub(crate) fn enable_windows_sandbox(permit: &ExecutionPermit) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let _ = permit.plan();
    if DISM_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Windows Sandbox wird bereits eingeschaltet".into());
    }
    let result = run_dism();
    DISM_RUNNING.store(false, Ordering::SeqCst);
    result
}

fn run_dism() -> Result<(), String> {
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
        let child = std::process::Command::new(&dism)
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
            .spawn();
        let mut child = child.map_err(|e| format!("DISM startet nicht: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                // Beendet nur das selbst gestartete DISM nach Ablauf der Frist.
                // aegis-mutation: service-lab-dism-timeout
                #[allow(clippy::disallowed_methods)]
                let _ = child.kill();
                return Err("DISM hat zu lange gebraucht (30 Minuten) – abgebrochen".into());
            }
            std::thread::sleep(Duration::from_secs(2));
        };
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

    fn run(id: &str, owner: &str, state: LabState) -> LabRun {
        LabRun {
            id: id.into(),
            sample: "a.exe".into(),
            stage: LabStage::MiniSandbox,
            seconds: 30,
            started: String::new(),
            state,
            container: None,
            owner: Some(owner.into()),
            output: Some(PathBuf::from("/labor/x/bericht")),
        }
    }

    #[test]
    fn fremde_laeufe_unsichtbar() {
        let lab = Lab::new(None);
        lock(&lab.runs).push(run("1", "S-A", LabState::Preparing));
        assert_eq!(lab.runs_of(Some("S-A")).len(), 1);
        assert!(lab.runs_of(Some("S-B")).is_empty());
        assert_eq!(lab.active(), 1);
        assert!(
            lab.screenshot_path(Some("S-B"), "1", "bild-01.png")
                .is_err()
        );
        assert!(lab.report(Some("S-B"), "1").is_err());
        assert!(lab.report(Some("S-A"), "1").is_err(), "noch nicht fertig");
    }

    #[test]
    fn bildnamen_ohne_absturz_und_nur_aus_dem_bericht() {
        for bad in [
            "bild-€.png",
            "bild-ü1.png",
            "bild-0a.png",
            "../bild-01.png",
            "bild-01.PNG",
            "",
        ] {
            assert!(!valid_screenshot_name(bad), "{bad:?}");
        }
        assert!(valid_screenshot_name("bild-07.png"));
        let lab = Lab::new(None);
        let report: BehaviorReport = serde_json::from_value(serde_json::json!({
            "stage": "windows_sandbox", "sample": "a.exe", "seconds": 30,
            "end": {"type": "timed_out"}, "screenshots": ["bild-01.png"]
        }))
        .unwrap();
        let assessment = report.assess();
        lock(&lab.runs).push(run(
            "1",
            "S-A",
            LabState::Done {
                report: Box::new(report),
                assessment,
            },
        ));
        assert!(lab.screenshot_path(Some("S-A"), "1", "bild-€.png").is_err());
        assert!(
            lab.screenshot_path(Some("S-A"), "1", "bild-02.png")
                .is_err()
        );
        let path = lab
            .screenshot_path(Some("S-A"), "1", "bild-01.png")
            .unwrap();
        assert!(path.ends_with("bericht/bild-01.png"));
        assert_eq!(lab.report(Some("S-A"), "1").unwrap().screenshots.len(), 1);
        // Der Zustand im Status enthält den Bericht nicht.
        let status = serde_json::to_value(lab.runs_of(Some("S-A"))).unwrap();
        assert!(status[0]["state"].get("report").is_none(), "{status}");
        assert!(status[0]["state"]["assessment"].is_object());
    }

    #[test]
    fn kopie_heisst_probe_mit_gepruefter_endung() {
        assert_eq!(copy_name("Setup 2.0.EXE"), "probe.exe");
        assert_eq!(
            copy_name("a.txt:x.exe"),
            "probe.exe",
            "nur die Endung zählt"
        );
        assert_eq!(copy_name("a.exe."), "probe");
        assert_eq!(copy_name("ohne"), "probe");
        assert_eq!(copy_name("x.verylongext"), "probe");
        assert!(check_hash(&"AB".repeat(32), &"ab".repeat(32)).is_ok());
        assert!(check_hash(&"ab".repeat(32), &"cd".repeat(32)).is_err());
    }

    #[test]
    fn bericht_hinweise_kommen_vom_dienst() {
        assert_eq!(wsb_notes(false).len(), 1);
        assert!(wsb_notes(true)[1].contains("Heimnetz"));
    }
}
