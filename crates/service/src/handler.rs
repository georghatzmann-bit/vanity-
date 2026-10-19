//! Verarbeitung der Anfragen – die **einzige** Stelle im Betrieb, an der aus einer
//! Nutzerantwort eine Freigabe wird (`ConsentGate::decide`/`confirm_second`, per
//! Mutations-Wächter erzwungen).
//!
//! Der Dienst formuliert jeden Plan selbst (aus eigener Prüfung bzw. aus dem
//! Quarantäne-Eintrag) – die Oberfläche kann nur auswählen und antworten.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aegis_core::audit::{AuditEvent, AuditLog, Durable, TimedEvent};
use aegis_core::consent::{
    Approval, ChallengeId, Clock, ConsentGate, Decision, DecisionOrigin, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, PlanId, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_engine::{Engine, Finding};

use crate::history::{History, HistoryKind, NewEntry, Reader};
use crate::schedule::{Schedule, SettingsStore, UpdateRecord, check_schedule_input};
use crate::trust::{TrustEntry, TrustStore};
use crate::watch::{Viewer, WatchShared};
use crate::worker::Scanner;
use aegis_quarantine::{Entry, UserAccess, Vault};

use crate::protocol::{PROTOCOL_VERSION, Proposal, Request, Response};

mod safe;

/// Höchstzahl Pfade pro Anfrage.
pub const MAX_PATHS: usize = 1000;
/// Höchstlänge aller Pfade einer Anfrage zusammen (Byte) – hält Pläne und Protokoll klein.
pub const MAX_PATH_BYTES: usize = 256 * 1024;
/// Höchstzahl offener Vorschläge (darüber: „bitte erst beantworten“).
pub const MAX_OPEN_PROPOSALS: usize = 64;
/// Höchstzahl neuer Vorschläge pro Minute.
pub const MAX_PROPOSALS_PER_MINUTE: usize = 60;
/// Nach dieser Zeit verfällt eine unbeantwortete zweite Rückfrage auch hier.
const SECOND_TTL_MINUTES: i64 = 15;

struct PendingSecond {
    approval: Approval,
    plan: ActionPlan,
    nonce: String,
    created: OffsetDateTime,
    owner: Option<String>,
}

/// Offener Vorschlag: Plan, Einmal-Nonce und das Konto, das ihn angefordert hat (nur dieses
/// darf antworten).
struct Pending {
    plan: ActionPlan,
    nonce: String,
    owner: Option<String>,
    /// SHA-256 der Ziele aus der Prüfung beim Vorschlag (für „Vertrauen“ – so liest der Dienst
    /// unter seiner Sperre keine Dateien mehr).
    hashes: HashMap<PathBuf, String>,
}

/// Zustand des Dienstes.
pub struct Service<C: Clock, W: Durable> {
    scanner: Arc<Scanner>,
    vault: Vault,
    gate: ConsentGate<C>,
    audit: AuditLog<W>,
    audit_failed: bool,
    proposals: HashMap<PlanId, Pending>,
    second: HashMap<ChallengeId, PendingSecond>,
    recent_proposals: HashMap<Option<String>, Vec<OffsetDateTime>>,
    protected: Vec<PathBuf>,
    trust: TrustStore,
    watch: Arc<WatchShared>,
    history: Arc<Mutex<History>>,
    settings: SettingsStore,
    lab: Arc<crate::lab::Lab>,
    safe: safe::SafeState,
}

/// Einstellung „Windows-Feature Windows Sandbox“.
pub const SANDBOX_FEATURE_SETTING: &str = "windows.feature.Containers-DisposableClientVM";

/// Bildschirmfoto eines eigenen Labor-Laufs: Pfad aus dem Lauf (nur im Bericht genannte
/// Namen), gelesen mit den Rechten des Nutzers und als PNG geprüft. Ohne Dienst-Sperre
/// aufrufbar (das Lesen kann warten).
pub fn lab_screenshot_response(
    lab: &crate::lab::Lab,
    user: &dyn UserAccess,
    run_id: &str,
    name: &str,
) -> Response {
    use base64::Engine as _;
    let path = match lab.screenshot_path(user.identity().as_deref(), run_id, name) {
        Ok(p) => p,
        Err(e) => return Response::error("lab", e),
    };
    let data = match user.enter() {
        Ok(_scope) => crate::lab::read_screenshot(&path),
        Err(e) => Err(format!("Rechte des Nutzers nicht übernehmbar: {e}")),
    };
    match data {
        Ok(png) => Response::LabScreenshot {
            png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        },
        Err(e) => Response::error("lab", e),
    }
}

/// Wahl für einen Labor-Lauf (aus der Anfrage; der Dienst prüft sie).
#[derive(Debug, Clone)]
pub struct LabOptions {
    /// Stufe (`windows_sandbox` | `mini_sandbox`).
    pub stage: String,
    /// Beobachtungszeit.
    pub seconds: u32,
    /// Netzwerk (nur Stufe 1).
    pub network: bool,
}

/// Arbeit, die der Zeitplaner außerhalb der Sperre erledigt.
#[derive(Debug, Default)]
pub struct DueWork {
    /// Fällige geplante Scans (bereits als gelaufen markiert).
    pub schedules: Vec<Schedule>,
    /// Signatur-Update fällig?
    pub update: bool,
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Neuer Dienst-Zustand.
    pub fn new(engine: Engine, vault: Vault, gate: ConsentGate<C>, audit: AuditLog<W>) -> Self {
        let protected = vec![vault.dir().to_path_buf()];
        Self {
            scanner: Arc::new(Scanner::InProcess(Arc::new(engine))),
            vault,
            gate,
            audit,
            audit_failed: false,
            proposals: HashMap::new(),
            second: HashMap::new(),
            recent_proposals: HashMap::new(),
            protected,
            trust: TrustStore::in_memory(),
            watch: WatchShared::new(),
            history: Arc::new(Mutex::new(History::in_memory())),
            settings: SettingsStore::in_memory(),
            lab: crate::lab::Lab::new(None),
            safe: safe::SafeState::default(),
        }
    }

    /// Dauerhafte Vertrauensliste (Betrieb).
    #[must_use]
    pub fn with_trust(mut self, trust: TrustStore) -> Self {
        self.trust = trust;
        self
    }

    /// Zustand des Echtzeit-Wächters (Betrieb: derselbe, den der Wächter füllt).
    #[must_use]
    pub fn with_watch(mut self, watch: Arc<WatchShared>) -> Self {
        self.watch = watch;
        self
    }

    /// Dauerhafter Verlauf (Betrieb).
    #[must_use]
    pub fn with_history(mut self, history: History) -> Self {
        self.history = Arc::new(Mutex::new(history));
        self
    }

    /// Dauerhafte Dienst-Einstellungen (Betrieb).
    #[must_use]
    pub fn with_settings(mut self, settings: SettingsStore) -> Self {
        self.settings = settings;
        self
    }

    /// Labor mit eigenem Ordner im Datenbereich (Betrieb).
    #[must_use]
    pub fn with_lab(mut self, lab: Arc<crate::lab::Lab>) -> Self {
        self.lab = lab;
        self
    }

    /// Das Labor (Tests, Diagnose).
    #[must_use]
    pub fn lab(&self) -> Arc<crate::lab::Lab> {
        Arc::clone(&self.lab)
    }

    /// Schlägt einen Labor-Lauf vor; `findings` stammen aus [`examine_as_user`].
    pub fn propose_lab_run(
        &mut self,
        path: &Path,
        findings: &[Finding],
        options: &LabOptions,
        owner: Option<String>,
    ) -> Response {
        use crate::lab::LabStage;
        let Some(stage) = LabStage::from_param(&options.stage) else {
            return Response::error("input", "Unbekannte Labor-Stufe");
        };
        if !(5..=600).contains(&options.seconds) {
            return Response::error("input", "Beobachtungszeit 5–600 Sekunden");
        }
        if options.network && stage != LabStage::WindowsSandbox {
            return Response::error("input", "Netzwerk gibt es nur in der Windows Sandbox");
        }
        if stage == LabStage::WindowsSandbox {
            let status = aegis_sandbox::detect::status();
            if !status.enabled {
                return Response::error("sandbox", status.message_de());
            }
        } else if !cfg!(windows) {
            return Response::error("sandbox", "Die Mini-Sandbox gibt es nur unter Windows");
        }
        if let Err(e) = self.check_paths(&[path.to_path_buf()]) {
            return Response::error("input", e);
        }
        let name = path.file_name().map_or_else(
            || path.display().to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        if stage == LabStage::WindowsSandbox
            && let Err(e) = aegis_sandbox::wsb::check_sample_name(&name)
        {
            return Response::error("input", e);
        }
        // Prüfsumme zum Zeitpunkt des Vorschlags: Beim Start muss die Datei noch dieselbe sein.
        let Some(sha256) = findings
            .iter()
            .find(|f| crate::paths::same_path(&f.path, path))
            .and_then(|f| f.sha256.clone())
        else {
            return Response::error(
                "input",
                "Die Datei konnte nicht gelesen bzw. geprüft werden – kein Labor-Lauf möglich",
            );
        };
        let worst = findings.iter().max_by_key(|f| f.risk);
        let severity = worst.map_or(RiskLevel::Info, |f| f.risk.max(RiskLevel::Info));
        let (label, consequence) = match stage {
            LabStage::WindowsSandbox => (
                "Windows Sandbox",
                format!(
                    "Eine Kopie startet in der Windows Sandbox (eigene, wegwerfbare VM), {}. AEGIS zeichnet Prozesse, Dateien, Autostart-Einträge, Verbindungsversuche und Bildschirmfotos auf; danach schließt sich die Sandbox.",
                    if options.network {
                        "MIT Netzwerk – das Programm kann ins Internet und ins Heimnetz"
                    } else {
                        "ohne Netzwerk"
                    }
                ),
            ),
            LabStage::MiniSandbox => (
                "Mini-Sandbox",
                "Eine Kopie startet in der Mini-Sandbox (AppContainer ohne Netzwerk, niedrige Integrität, begrenzte Rechenzeit und Prozesse). Schwächer als eine VM: gleicher Kernel und Desktop. AEGIS zeichnet Prozesse, Dateien und Autostart-Versuche auf und beendet danach alle Prozesse des Laufs.".to_owned(),
            ),
        };
        let why = worst.filter(|f| f.risk > RiskLevel::Clean).map_or_else(
            || "Von dir ausgewählt, um das Verhalten abgeschottet zu beobachten.".to_owned(),
            |f| f.summary_de.clone(),
        );
        let plan = ActionPlan::builder(ActionKind::RunInSandbox)
            .target(Target::file(path))
            .what(format!(
                "{} im Labor ({label}) {} Sekunden lang starten und beobachten",
                quoted(&name),
                options.seconds
            ))
            .why(why)
            .consequence(consequence)
            .undo(UndoHint::reversible(
                "Das Labor wird nach dem Lauf verworfen; die Originaldatei bleibt unverändert.",
            ))
            .severity(severity)
            .parameter(param::LAB_STAGE, stage.as_param())
            .parameter(param::LAB_SECONDS, options.seconds.to_string())
            .parameter(
                param::LAB_NETWORK,
                if options.network { "on" } else { "off" },
            )
            .parameter(param::LAB_SHA256, &sha256)
            .build(self.gate.clock().now());
        let hashes = findings
            .iter()
            .filter_map(|f| f.sha256.clone().map(|h| (f.path.clone(), h)))
            .collect();
        match plan {
            Ok(plan) => self.register(plan, owner, hashes),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    fn propose_enable_sandbox(&mut self, user: &dyn UserAccess) -> Response {
        if !user.is_admin() {
            return Response::error(
                "admin",
                "Die Windows Sandbox einschalten können nur Administratoren (AEGIS als Administrator starten).",
            );
        }
        let status = aegis_sandbox::detect::status();
        if !status.supported || status.enabled {
            return Response::error("sandbox", status.message_de());
        }
        let plan = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(SANDBOX_FEATURE_SETTING))
            .parameter(param::VALUE, "on")
            .what("Windows-Feature „Windows Sandbox“ einschalten")
            .why("Damit das Labor unbekannte Programme in einer eigenen, wegwerfbaren VM prüfen kann (Stufe 1).")
            .consequence("Windows lädt und installiert das Feature (DISM). Danach ist ein Neustart nötig; erst dann steht die Windows Sandbox bereit.")
            .undo(UndoHint::reversible(
                "Über „Windows-Features aktivieren oder deaktivieren“ wieder ausschalten (Neustart nötig).",
            ))
            .severity(RiskLevel::Info)
            .build(self.gate.clock().now());
        match plan {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Startet einen freigegebenen Labor-Lauf im Hintergrund. Die Erlaubnis wandert in den
    /// Lauf und wird dort mit dem echten Ergebnis abgeschlossen.
    fn start_lab(
        &mut self,
        permit: aegis_core::consent::ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        use crate::lab::{LabStage, LabStart};
        let fail =
            |this: &mut Self, permit: aegis_core::consent::ExecutionPermit, message: String| {
                let event = permit.complete(aegis_core::audit::ExecutionResult::Failed {
                    message: message.clone(),
                });
                this.record(event);
                if this.audit.sync().is_err() {
                    this.audit_failed = true;
                }
                Response::error("lab", format!("{message} – nichts gestartet"))
            };
        let Ok(plan) = permit.ensure_kind(ActionKind::RunInSandbox).cloned() else {
            return fail(self, permit, "Falsche Aktion".into());
        };
        let (Some(Target::File { path }), 1) =
            (plan.targets().first().cloned(), plan.targets().len())
        else {
            return fail(self, permit, "Genau ein Ziel erwartet".into());
        };
        let (Some(stage), Some(seconds), Some(expected_sha256)) = (
            plan.parameter(param::LAB_STAGE)
                .and_then(LabStage::from_param),
            plan.parameter(param::LAB_SECONDS)
                .and_then(|s| s.parse().ok()),
            plan.parameter(param::LAB_SHA256).map(str::to_owned),
        ) else {
            return fail(self, permit, "Plan unvollständig".into());
        };
        let network = plan.parameter(param::LAB_NETWORK) == Some("on");
        // Original mit den Rechten des Nutzers öffnen (nur lesen, ohne Links).
        let opened = {
            let scope = user.enter();
            match scope {
                Err(e) => Err(format!("Rechte des Nutzers nicht übernehmbar: {e}")),
                Ok(_scope) => {
                    #[cfg(windows)]
                    let token = aegis_winffi::sandbox::UserToken::from_current_identity()
                        .map_err(|e| e.to_string());
                    #[cfg(not(windows))]
                    let token: Result<(), String> = Ok(());
                    aegis_engine::scan::open_regular(&path)
                        .map_err(|e| format!("Datei nicht lesbar: {e}"))
                        .and_then(|(file, meta)| {
                            if meta.len() > crate::lab::MAX_SAMPLE {
                                Err("Datei ist zu groß für das Labor".into())
                            } else {
                                token.map(|t| (file, t))
                            }
                        })
                }
            }
        };
        let (file, token) = match opened {
            Ok(v) => v,
            Err(message) => return fail(self, permit, message),
        };
        #[cfg(not(windows))]
        let () = token;
        let id = aegis_core::uuid::Uuid::new_v4().hyphenated().to_string();
        let history = Arc::clone(&self.history);
        let owner = user.identity();
        let sample_name = path
            .file_name()
            .map_or_else(|| "probe".to_owned(), |n| n.to_string_lossy().into_owned());
        let started = self.lab.start(
            LabStart {
                permit,
                id,
                sample: file,
                sample_name,
                stage,
                seconds,
                network,
                expected_sha256,
                owner: owner.clone(),
                #[cfg(windows)]
                token,
            },
            move |run| {
                let (risk, title, detail) = match &run.state {
                    crate::lab::LabState::Done { assessment, .. } => (
                        Some(assessment.risk),
                        format!("Labor – {}: {}", run.sample, assessment.summary_de),
                        String::new(),
                    ),
                    crate::lab::LabState::Failed { message } => (
                        None,
                        format!("Labor – {}: nicht möglich", run.sample),
                        message.clone(),
                    ),
                    _ => (None, format!("Labor – {}", run.sample), String::new()),
                };
                lock_history(&history).add(
                    OffsetDateTime::now_utc(),
                    NewEntry {
                        kind: HistoryKind::Lab,
                        risk,
                        title,
                        detail,
                        paths: vec![path],
                        owner,
                        scope: None,
                    },
                );
            },
        );
        if let Err(refused) = started {
            let (start, message) = *refused;
            return fail(self, start.permit, message);
        }
        // Das Ergebnis (Erfolg oder Fehler) protokolliert der Lauf selbst, sobald er fertig ist.
        Response::Executed {
            kind: ActionKind::RunInSandbox,
            result: aegis_core::audit::ExecutionResult::Succeeded,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Schaltet die Windows Sandbox ein (DISM, im Hintergrund) – nur mit Erlaubnis; das Ergebnis
    /// kommt mit dem echten Ausgang ins Prüfprotokoll.
    fn enable_sandbox_feature(
        &mut self,
        permit: aegis_core::consent::ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let is_feature = permit
            .ensure_kind(ActionKind::ChangeSetting)
            .is_ok_and(|plan| {
                matches!(plan.targets(), [Target::Setting { id }] if id == SANDBOX_FEATURE_SETTING)
                    && plan.parameter(param::VALUE) == Some("on")
            });
        if !is_feature || !user.is_admin() {
            let event = permit.complete(aegis_core::audit::ExecutionResult::Failed {
                message: "Diese Einstellung ändert der Dienst nicht".into(),
            });
            self.record(event);
            return Response::error(
                "unsupported",
                "Diese Einstellung wird nicht unterstützt – nichts geändert",
            );
        }
        let history = Arc::clone(&self.history);
        let lab = Arc::clone(&self.lab);
        let owner = user.identity();
        std::thread::spawn(move || {
            let result = crate::lab::enable_windows_sandbox(&permit);
            let audit_result = match &result {
                Ok(()) => aegis_core::audit::ExecutionResult::Succeeded,
                Err(message) => aegis_core::audit::ExecutionResult::Failed {
                    message: message.clone(),
                },
            };
            lab.push_audit(permit.complete(audit_result));
            let (title, detail) = match result {
                Ok(()) => (
                    "Windows Sandbox eingeschaltet – bitte neu starten".to_owned(),
                    String::new(),
                ),
                Err(e) => ("Windows Sandbox nicht eingeschaltet".to_owned(), e),
            };
            lock_history(&history).add(
                OffsetDateTime::now_utc(),
                NewEntry {
                    kind: HistoryKind::Action,
                    risk: None,
                    title,
                    detail,
                    paths: Vec::new(),
                    owner,
                    scope: None,
                },
            );
        });
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result: aegis_core::audit::ExecutionResult::Succeeded,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Schlägt vor, laufende Prozesse eines Programms zu beenden, anzuhalten oder fortzusetzen.
    /// Der Dienst sucht die Prozesse selbst (nur eigene des Kontos; Administratoren auch
    /// fremde) und nennt jede Prozess-ID samt Programm im Plan.
    pub fn propose_process_action(
        &mut self,
        program: &Path,
        action: &str,
        user: &dyn UserAccess,
    ) -> Response {
        let kind = match action {
            "terminate" => ActionKind::TerminateProcess,
            "suspend" => ActionKind::SuspendProcess,
            "resume" => ActionKind::ResumeProcess,
            _ => return Response::error("input", "Unbekannte Aktion (terminate, suspend, resume)"),
        };
        if !program.is_absolute() {
            return Response::error("input", "Programmpfad muss absolut sein");
        }
        let targets = match running_processes_of(program, user) {
            Ok(t) if t.is_empty() => {
                return Response::error(
                    "process",
                    "Kein laufender Prozess dieses Programms (deines Kontos) gefunden",
                );
            }
            Ok(t) => t,
            Err(e) => return Response::error("process", e),
        };
        let name = quoted(&program.display().to_string());
        let count = targets.len();
        let mut builder = ActionPlan::builder(kind)
            .why("Von dir gewählt – z. B. nach einer Meldung des Echtzeit-Wächters.")
            .severity(RiskLevel::RiskyTool);
        for (pid, image) in targets {
            builder = builder.target(Target::process(pid, image));
        }
        let builder = match kind {
            ActionKind::TerminateProcess => builder
                .what(format!("{name} beenden ({count} Prozess(e))"))
                .consequence("Das Programm wird sofort beendet; ungespeicherte Daten darin gehen verloren. Dateien bleiben unverändert.")
                .undo(UndoHint::irreversible(
                    "Ein beendetes Programm lässt sich nur neu starten.",
                )),
            ActionKind::SuspendProcess => builder
                .what(format!("{name} anhalten ({count} Prozess(e))"))
                .consequence("Das Programm friert ein und tut nichts mehr, bis du es fortsetzt oder beendest.")
                .undo(UndoHint::reversible("Über „Fortsetzen“ läuft es weiter.")),
            _ => builder
                .what(format!("{name} fortsetzen ({count} Prozess(e))"))
                .consequence("Das angehaltene Programm läuft weiter.")
                .undo(UndoHint::reversible("Erneut „Anhalten“.")),
        };
        match builder.build(self.gate.clock().now()) {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt eine freigegebene Prozess-Aktion aus – je Ziel im Identitätswechsel des Nutzers
    /// (Windows prüft selbst, ob er den Prozess anfassen darf), mit Prüfung von ID und Programm.
    fn control_processes(
        &mut self,
        permit: aegis_core::consent::ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let plan = permit.plan().clone();
        let mut failures = Vec::new();
        let mut done = 0usize;
        for target in plan.targets() {
            let Target::Process { pid, image_path } = target else {
                failures.push((PathBuf::new(), "Kein Prozess-Ziel".to_owned()));
                continue;
            };
            let result = match user.enter() {
                Ok(_scope) => control_one(*pid, image_path, plan.kind()),
                Err(e) => Err(format!("Rechte des Nutzers nicht übernehmbar: {e}")),
            };
            match result {
                Ok(()) => done += 1,
                Err(message) => {
                    failures.push((image_path.clone(), format!("PID {pid}: {message}")))
                }
            }
        }
        let result = if failures.is_empty() {
            aegis_core::audit::ExecutionResult::Succeeded
        } else if done > 0 {
            aegis_core::audit::ExecutionResult::PartiallySucceeded {
                message: format!(
                    "{} von {} nicht möglich",
                    failures.len(),
                    done + failures.len()
                ),
            }
        } else {
            aegis_core::audit::ExecutionResult::Failed {
                message: failures.first().map_or_else(String::new, |f| f.1.clone()),
            }
        };
        let event = permit.complete(result.clone());
        self.record(event);
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
        self.add_history(NewEntry {
            kind: HistoryKind::Action,
            risk: None,
            title: format!(
                "{} – {}",
                plan.what(),
                if failures.is_empty() {
                    "erledigt"
                } else {
                    "teilweise/nicht möglich"
                }
            ),
            detail: failures
                .iter()
                .map(|f| f.1.clone())
                .collect::<Vec<_>>()
                .join("; "),
            paths: plan
                .targets()
                .iter()
                .filter_map(|t| match t {
                    Target::Process { image_path, .. } => Some(image_path.clone()),
                    _ => None,
                })
                .take(1)
                .collect(),
            owner: user.identity(),
            scope: None,
        });
        Response::Executed {
            kind: plan.kind(),
            result,
            entries: Vec::new(),
            failures,
        }
    }

    /// Köderdateien des Kontos (für die Anzeige).
    #[must_use]
    pub fn baits_of(&self, owner: Option<&str>) -> Vec<PathBuf> {
        self.settings
            .get()
            .baits
            .iter()
            .filter(|b| b.owner.as_deref() == owner)
            .flat_map(|b| b.files.clone())
            .collect()
    }

    /// Alle Köderdateien an den Wächter geben.
    pub fn sync_baits(&self) {
        let all: Vec<PathBuf> = self
            .settings
            .get()
            .baits
            .iter()
            .flat_map(|b| b.files.clone())
            .collect();
        self.watch.ransom().set_canaries(all);
    }

    /// Schlägt vor, Köderdateien anzulegen (`on`) bzw. zu entfernen.
    pub fn propose_baits(&mut self, on: bool, user: &dyn UserAccess) -> Response {
        use aegis_quarantine::bait::{BAIT_SETTING, bait_paths};
        let owner = user.identity();
        let existing = self.baits_of(owner.as_deref());
        let paths = if on {
            let Some(profile) = user.profile() else {
                return Response::error("ransom", "Kein Benutzerprofil – Köder nicht möglich");
            };
            bait_paths(&profile)
                .into_iter()
                .filter(|p| !existing.iter().any(|e| crate::paths::same_path(e, p)))
                .collect::<Vec<_>>()
        } else {
            existing
        };
        if paths.is_empty() {
            return Response::error(
                "ransom",
                if on {
                    "Köderdateien sind schon angelegt (oder es fehlen Dokumente/Desktop/Bilder)"
                } else {
                    "Es gibt keine Köderdateien zu entfernen"
                },
            );
        }
        let list = paths
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let mut builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(BAIT_SETTING))
            .parameter(param::VALUE, if on { "on" } else { "off" })
            .severity(RiskLevel::Info);
        for p in &paths {
            builder = builder.target(Target::other(p.display().to_string()));
        }
        let builder = if on {
            builder
                .what(format!("{} Köderdateien des Ransomware-Schutzes anlegen", paths.len()))
                .why("Ransomware verschlüsselt wahllos Dateien – wird eine Köderdatei verändert, warnt AEGIS sofort.")
                .consequence(format!("Neue, harmlose Dateien (Text) entstehen: {list}. Bitte nicht ändern; AEGIS meldet jede Änderung."))
                .undo(UndoHint::reversible("„Köder entfernen“ löscht genau diese Dateien wieder (nur unverändert)."))
        } else {
            builder
                .what(format!("{} Köderdateien entfernen", paths.len()))
                .why("Von dir gewählt.")
                .consequence(format!("Diese Dateien werden gelöscht, sofern sie unverändert sind: {list}. Danach warnt AEGIS nur noch bei Massenänderungen."))
                .undo(UndoHint::reversible("„Köder anlegen“ legt sie neu an."))
        };
        match builder.build(self.gate.clock().now()) {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Panic-Button: Netz trennen (`on`) bzw. wieder verbinden vorschlagen.
    pub fn propose_panic(&mut self, on: bool, user: &dyn UserAccess) -> Response {
        let active = self.settings.get().panic_since.is_some();
        if !cfg!(windows) {
            return Response::error("panic", "Den Panic-Button gibt es nur unter Windows");
        }
        if on == active {
            return Response::error(
                "panic",
                if on {
                    "Das Netz ist bereits getrennt"
                } else {
                    "Das Netz ist nicht getrennt"
                },
            );
        }
        let builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(crate::panic::PANIC_SETTING))
            .parameter(param::VALUE, if on { "on" } else { "off" });
        let builder = if on {
            builder
                .what("Panic-Button: Rechner vom Netz trennen")
                .why("Zum Beispiel bei einem Ransomware-Verdacht: Ohne Netz kann Schadsoftware keine Daten hinaus schicken, keine Befehle holen und andere Geräte nicht erreichen.")
                .consequence("Die Windows-Firewall sperrt jede ein- und ausgehende Verbindung (zwei AEGIS-Regeln; ist die Firewall aus, wird sie eingeschaltet und bleibt an). Internet, Heimnetz und Updates sind getrennt – für alle Konten dieses Rechners. Laufende Programme werden NICHT beendet.")
                .undo(UndoHint::reversible("„Wieder verbinden“ entfernt genau diese beiden Regeln."))
                .severity(RiskLevel::Suspicious)
        } else {
            builder
                .what("Panic-Button aufheben: Rechner wieder verbinden")
                .why("Von dir gewählt – z. B. nachdem das verdächtige Programm beendet bzw. isoliert ist.")
                .consequence("Die beiden AEGIS-Sperrregeln werden gelöscht; Verbindungen sind wieder wie vorher erlaubt. Die Firewall bleibt eingeschaltet.")
                .undo(UndoHint::reversible("Panic-Button erneut auslösen."))
                .severity(RiskLevel::Info)
        };
        match builder.build(self.gate.clock().now()) {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt den freigegebenen Panic-Plan aus.
    fn apply_panic(
        &mut self,
        permit: aegis_core::consent::ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let plan = permit.plan().clone();
        let on = plan.parameter(param::VALUE) == Some("on");
        let commands = if on {
            crate::panic::block_commands()
        } else {
            crate::panic::restore_commands()
        };
        let outcome = crate::panic::run(&permit, &commands);
        let result = match &outcome {
            Ok(()) => {
                let since = on.then(|| {
                    self.gate
                        .clock()
                        .now()
                        .format(&aegis_core::time::format_description::well_known::Rfc3339)
                        .unwrap_or_default()
                });
                match self.settings.update(|s| s.panic_since = since) {
                    Ok(()) => aegis_core::audit::ExecutionResult::Succeeded,
                    Err(e) => aegis_core::audit::ExecutionResult::PartiallySucceeded {
                        message: format!("Zustand nicht gespeichert: {e}"),
                    },
                }
            }
            Err(message) => aegis_core::audit::ExecutionResult::Failed {
                message: message.clone(),
            },
        };
        let event = permit.complete(result.clone());
        self.record(event);
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
        self.add_history(NewEntry {
            kind: HistoryKind::Action,
            risk: on.then_some(RiskLevel::Suspicious),
            title: format!(
                "{} – {}",
                plan.what(),
                if outcome.is_ok() {
                    "erledigt"
                } else {
                    "nicht möglich"
                }
            ),
            detail: outcome.err().unwrap_or_default(),
            paths: Vec::new(),
            owner: user.identity(),
            scope: None,
        });
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Führt den freigegebenen Köder-Plan aus (Dateien aus dem Plan, Nutzerrechte).
    fn apply_baits(
        &mut self,
        permit: aegis_core::consent::ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let plan = permit.plan().clone();
        let on = plan.parameter(param::VALUE) == Some("on");
        let owner = user.identity();
        if !on {
            // Erst aus der Liste des Wächters nehmen, dann löschen (kein Fehlalarm).
            let planned: Vec<PathBuf> = plan
                .targets()
                .iter()
                .filter_map(|t| match t {
                    Target::Other { description } => Some(PathBuf::from(description)),
                    _ => None,
                })
                .collect();
            let all: Vec<PathBuf> = self
                .settings
                .get()
                .baits
                .iter()
                .flat_map(|b| b.files.clone())
                .filter(|f| !planned.iter().any(|p| crate::paths::same_path(p, f)))
                .collect();
            self.watch.ransom().set_canaries(all);
        }
        let results = if on {
            aegis_quarantine::bait::create_baits(&permit, user)
        } else {
            aegis_quarantine::bait::remove_baits(&permit, user)
        };
        let results = match results {
            Ok(r) => r,
            Err(message) => {
                let event = permit.complete(aegis_core::audit::ExecutionResult::Failed {
                    message: message.clone(),
                });
                self.record(event);
                self.sync_baits();
                return Response::error("ransom", format!("{message} – nichts geändert"));
            }
        };
        let ok: Vec<PathBuf> = results
            .iter()
            .filter(|(_, r)| r.is_ok())
            .map(|(p, _)| p.clone())
            .collect();
        let failures: Vec<(PathBuf, String)> = results
            .into_iter()
            .filter_map(|(p, r)| r.err().map(|e| (p, e)))
            .collect();
        let save = self.settings.update(|s| {
            let set = if let Some(set) = s.baits.iter_mut().find(|b| b.owner == owner) {
                set
            } else {
                s.baits.push(crate::schedule::BaitSet {
                    owner: owner.clone(),
                    files: Vec::new(),
                });
                let last = s.baits.len() - 1;
                &mut s.baits[last]
            };
            if on {
                set.files.extend(ok.iter().cloned());
            } else {
                set.files
                    .retain(|f| !ok.iter().any(|p| crate::paths::same_path(p, f)));
            }
            s.baits.retain(|b| !b.files.is_empty());
        });
        self.sync_baits();
        let result = if failures.is_empty() && save.is_ok() {
            aegis_core::audit::ExecutionResult::Succeeded
        } else if !ok.is_empty() {
            aegis_core::audit::ExecutionResult::PartiallySucceeded {
                message: format!("{} Datei(en) nicht möglich", failures.len()),
            }
        } else {
            aegis_core::audit::ExecutionResult::Failed {
                message: failures.first().map_or_else(
                    || "Einstellung nicht gespeichert".to_owned(),
                    |f| f.1.clone(),
                ),
            }
        };
        let event = permit.complete(result.clone());
        self.record(event);
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
        self.add_history(NewEntry {
            kind: HistoryKind::Action,
            risk: None,
            title: format!("{} – {} erledigt", plan.what(), ok.len()),
            detail: failures
                .iter()
                .map(|(p, e)| format!("{}: {e}", p.display()))
                .collect::<Vec<_>>()
                .join("; "),
            paths: ok.clone(),
            owner: owner.clone(),
            scope: user.profile(),
        });
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result,
            entries: Vec::new(),
            failures,
        }
    }

    /// Der Verlauf (auch der Wächter schreibt hinein).
    #[must_use]
    pub fn history(&self) -> Arc<Mutex<History>> {
        Arc::clone(&self.history)
    }

    fn add_history(&self, entry: NewEntry) {
        let at = self.gate.clock().now();
        lock_history(&self.history).add(at, entry);
    }

    /// Hält einen Scan im Verlauf fest (Anzahl, höchste Stufe, auffällige Pfade).
    pub fn record_scan(&self, response: &Response, user: &dyn UserAccess) {
        let Response::ScanReport { report } = response else {
            return;
        };
        self.add_history(scan_entry(
            HistoryKind::Scan,
            report,
            "Scan",
            user.identity(),
            None,
        ));
    }

    fn record_decision(
        &self,
        plan: Option<&ActionPlan>,
        response: &Response,
        user: &dyn UserAccess,
    ) {
        let Some(plan) = plan else { return };
        let paths: Vec<PathBuf> = plan
            .targets()
            .iter()
            .filter_map(|t| match t {
                Target::File { path } => Some(path.clone()),
                _ => None,
            })
            .collect();
        let (kind, title, detail) = match response {
            Response::Executed { result, .. } => {
                let (state, message) = match result {
                    aegis_core::audit::ExecutionResult::Succeeded => ("ausgeführt", String::new()),
                    aegis_core::audit::ExecutionResult::PartiallySucceeded { message } => {
                        ("teilweise ausgeführt", message.clone())
                    }
                    aegis_core::audit::ExecutionResult::Failed { message } => {
                        ("fehlgeschlagen", message.clone())
                    }
                };
                (
                    HistoryKind::Action,
                    format!("{} – {state}", plan.what()),
                    message,
                )
            }
            Response::NothingDone { decision } => (
                HistoryKind::Decision,
                format!(
                    "{} – {}, nichts verändert",
                    plan.what(),
                    match decision {
                        Decision::Ignore => "ignoriert",
                        _ => "abgelehnt",
                    }
                ),
                String::new(),
            ),
            Response::Trusted { .. } => (
                HistoryKind::Decision,
                format!("{} – vertraut, nichts verändert", plan.what()),
                String::new(),
            ),
            _ => return,
        };
        self.add_history(NewEntry {
            kind,
            risk: Some(plan.severity()),
            title,
            detail,
            paths,
            owner: user.identity(),
            scope: None,
        });
    }

    /// Fällige geplante Scans und Updates; geplante Scans werden sofort als gelaufen
    /// markiert (kein doppelter Start, auch wenn der Lauf scheitert).
    pub fn take_due_work(&mut self) -> DueWork {
        self.drain_lab_audit();
        let now = self.gate.clock().now();
        let schedules: Vec<Schedule> = self
            .settings
            .get()
            .schedules
            .iter()
            .filter(|s| s.due(now))
            .cloned()
            .collect();
        if !schedules.is_empty() {
            let _ = self.settings.update(|s| {
                for sched in &mut s.schedules {
                    if sched.due(now) {
                        sched.last_run = Some(now);
                    }
                }
            });
        }
        let update = self.settings.get().update_due(now)
            && aegis_engine::clamav::ClamAv::locate().is_some_and(|c| c.updater().is_some());
        DueWork { schedules, update }
    }

    /// Ergebnis eines geplanten Scans: Verlauf + Meldung (wie beim Wächter).
    pub fn record_scheduled(
        &self,
        schedule: &Schedule,
        result: Result<aegis_engine::ScanReport, String>,
    ) {
        let entry = match result {
            Ok(report) => {
                for f in report.findings.iter().filter(|f| f.risk > RiskLevel::Info) {
                    self.watch.report(
                        crate::watch::WatchKind::Schedule,
                        f.path.clone(),
                        Some(schedule.profile.clone()),
                        schedule.owner.clone(),
                        f.clone(),
                    );
                }
                scan_entry(
                    HistoryKind::Schedule,
                    &report,
                    "Geplanter Scan",
                    schedule.owner.clone(),
                    Some(schedule.profile.clone()),
                )
            }
            Err(e) => NewEntry {
                kind: HistoryKind::Schedule,
                risk: None,
                title: "Geplanter Scan nicht möglich".into(),
                detail: e,
                paths: Vec::new(),
                owner: schedule.owner.clone(),
                scope: Some(schedule.profile.clone()),
            },
        };
        self.add_history(entry);
    }

    /// Ergebnis eines Signatur-Updates.
    pub fn record_update(&mut self, result: Result<String, String>) {
        let at = self.gate.clock().now();
        let (ok, message) = match result {
            Ok(m) => (true, m),
            Err(m) => (false, m),
        };
        let _ = self.settings.update(|s| {
            s.last_update = Some(UpdateRecord {
                at,
                ok,
                message: message.clone(),
            });
        });
        self.add_history(NewEntry {
            kind: HistoryKind::Update,
            risk: None,
            title: if ok {
                "ClamAV-Signaturen aktualisiert".into()
            } else {
                "ClamAV-Signaturen nicht aktualisiert".into()
            },
            detail: message,
            paths: Vec::new(),
            owner: None,
            scope: None,
        });
    }

    fn schedule_response(&self, user: &dyn UserAccess) -> Response {
        let settings = self.settings.get();
        let clam = aegis_engine::clamav::ClamAv::locate();
        Response::Schedule {
            info: Box::new(crate::protocol::ScheduleInfo {
                schedule: settings.schedule_of(user.identity().as_deref()).cloned(),
                clamav_available: clam.is_some(),
                clamav_update_available: clam.is_some_and(|c| c.updater().is_some()),
                clamav_update: settings.clamav_update,
                can_change_global: user.is_admin(),
                last_update: settings.last_update.clone(),
            }),
        }
    }

    fn set_schedule(
        &mut self,
        enabled: bool,
        every_days: u16,
        hour_utc: u8,
        user: &dyn UserAccess,
    ) -> Response {
        if let Err(e) = check_schedule_input(every_days, hour_utc) {
            return Response::error("input", e);
        }
        let owner = user.identity();
        let profile = match (user.profile(), &owner) {
            (Some(p), _) => crate::watch::long_name(p),
            (None, None) => {
                match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
                    Some(home) => PathBuf::from(home),
                    None => return Response::error("profile", "Profilordner unbekannt"),
                }
            }
            (None, Some(_)) => {
                return Response::error("profile", "Profilordner des Kontos nicht ermittelbar");
            }
        };
        let saved = self.settings.update(|s| {
            let last_run = s.schedule_of(owner.as_deref()).and_then(|x| x.last_run);
            s.schedules.retain(|x| x.owner != owner);
            s.schedules.push(Schedule {
                owner: owner.clone(),
                profile,
                enabled,
                every_days,
                hour_utc,
                last_run,
            });
        });
        match saved {
            Ok(()) => self.schedule_response(user),
            Err(e) => Response::error("settings", e.to_string()),
        }
    }

    /// Der gemeinsame Zustand des Wächters.
    #[must_use]
    pub fn watch(&self) -> Arc<WatchShared> {
        Arc::clone(&self.watch)
    }

    /// Markiert Funde, denen das Konto vertraut (Hash **und** Pfad).
    pub fn mark_trusted(&self, findings: &mut [Finding], owner: Option<&str>) {
        for f in findings {
            let Some(sha) = &f.sha256 else { continue };
            if let Some(entry) = self.trust.lookup(sha, &f.path, owner) {
                f.trusted = Some(aegis_engine::TrustMark {
                    id: entry.id.clone(),
                    reason: entry.reason.clone(),
                    since: entry
                        .created_at
                        .format(&aegis_core::time::format_description::well_known::Rfc3339)
                        .unwrap_or_default(),
                });
                f.recommendation = aegis_engine::Recommendation::None;
            }
        }
    }

    /// Wie [`Service::mark_trusted`] für eine Scan-Antwort.
    pub fn mark_trusted_response(&self, response: &mut Response, owner: Option<&str>) {
        if let Response::ScanReport { report } | Response::MemoryScan { report, .. } = response {
            self.mark_trusted(&mut report.findings, owner);
        }
    }

    /// Meldungen des Wächters für dieses Konto: eigenes Profil + gemeinsame Orte; Dateien,
    /// denen das Konto vertraut, werden nicht gemeldet.
    fn watch_poll(&self, after: u64, user: &dyn UserAccess) -> Response {
        let owner = user.identity();
        let profile = user.profile().map(crate::watch::long_name);
        let viewer = match &owner {
            None => Viewer::All,
            Some(sid) => Viewer::Account {
                sid,
                profile: profile.as_deref(),
            },
        };
        let mut events = self.watch.events_after(after, viewer);
        for event in &mut events {
            self.mark_trusted(std::slice::from_mut(&mut event.finding), owner.as_deref());
        }
        events.retain(|e| e.finding.trusted.is_none());
        Response::Watch {
            events,
            status: self.watch.status(viewer),
            gaming_left: self.watch.gaming_left(match &owner {
                None => None,
                Some(_) => profile.as_deref(),
            }),
        }
    }

    /// Ordner, deren Inhalt nie Ziel einer Anfrage sein darf (AEGIS-Datenordner).
    #[must_use]
    pub fn with_protected(mut self, dirs: Vec<PathBuf>) -> Self {
        self.protected = dirs;
        self
    }

    /// Prüfung im eingeschränkten Prüfprozess statt im Dienst (Betrieb).
    #[must_use]
    pub fn with_scanner(mut self, scanner: Scanner) -> Self {
        self.scanner = Arc::new(scanner);
        self
    }

    /// Der Prüfer – für Scans **außerhalb** der Sperre des Dienst-Zustands.
    #[must_use]
    pub fn scanner(&self) -> Arc<Scanner> {
        Arc::clone(&self.scanner)
    }

    /// Prüft Pfade einer Anfrage (für Aufrufer, die außerhalb der Sperre scannen).
    ///
    /// # Errors
    /// Text für die Fehler-Antwort.
    pub fn check_paths(&self, paths: &[PathBuf]) -> Result<(), String> {
        check_paths(paths, &self.protected)
    }

    /// Zugriff auf das Freigabe-Tor (Tests, Diagnose).
    pub fn gate(&self) -> &ConsentGate<C> {
        &self.gate
    }

    /// Verarbeitet eine Anfrage. Abgelaufene Vorschläge werden vorher verworfen
    /// (Standard bei Nicht-Reaktion: nichts tun). Nutzerdateien fasst der Dienst nur mit den
    /// Rechten von `user` an (Windows: Identität des Pipe-Clients).
    pub fn handle(&mut self, request: Request, user: &dyn UserAccess) -> Response {
        self.drain_lab_audit();
        for id in self.gate.expire_stale() {
            self.proposals.remove(&id);
        }
        let now = self.gate.clock().now();
        let open = &self.proposals;
        self.safe.expire(now, &|id| open.contains_key(id));
        self.second
            .retain(|_, p| now - p.created < Duration::minutes(SECOND_TTL_MINUTES));
        let response = match request {
            Request::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => Response::error(
                "protocol",
                format!("Protokoll {protocol} nicht unterstützt (Dienst: {PROTOCOL_VERSION})"),
            ),
            Request::Hello { .. } => Response::Hello {
                service: format!("aegis-service {}", env!("CARGO_PKG_VERSION")),
                protocol: PROTOCOL_VERSION,
            },
            Request::Scan { paths } => match self.check_paths(&paths) {
                Ok(()) => {
                    let mut response = scan_as_user(&self.scanner, &paths, user);
                    self.mark_trusted_response(&mut response, user.identity().as_deref());
                    self.record_scan(&response, user);
                    response
                }
                Err(e) => Response::error("input", e),
            },
            Request::ListTrust {} => Response::Trust {
                entries: self.trust.list(user.identity().as_deref()),
            },
            Request::RevokeTrust { id } => {
                match self.trust.revoke(&id, user.identity().as_deref()) {
                    Ok(true) => Response::TrustRevoked { id },
                    Ok(false) => Response::error("unknown", "Eintrag nicht gefunden"),
                    Err(e) => Response::error("trust", e.to_string()),
                }
            }
            Request::WatchPoll { after } => self.watch_poll(after, user),
            Request::History {} => {
                let owner = user.identity();
                let profile = user.profile().map(crate::watch::long_name);
                let history = lock_history(&self.history);
                Response::History {
                    entries: history.list(Reader {
                        owner: owner.as_deref(),
                        profile: profile.as_deref(),
                    }),
                    save_failed: history.save_failed(),
                }
            }
            Request::GetSchedule {} => self.schedule_response(user),
            Request::LabStatus {} => Response::Lab {
                sandbox: aegis_sandbox::detect::status(),
                mini_available: cfg!(windows),
                runs: self.lab.runs_of(user.identity().as_deref()),
            },
            Request::LabScreenshot { run_id, name } => {
                lab_screenshot_response(&self.lab, user, &run_id, &name)
            }
            Request::LabReport { run_id } => {
                match self.lab.report(user.identity().as_deref(), &run_id) {
                    Ok(report) => Response::LabReport {
                        report: Box::new(report),
                    },
                    Err(e) => Response::error("lab", e),
                }
            }
            Request::ProposeEnableSandbox {} => self.propose_enable_sandbox(user),
            Request::ProposeProcessAction { program, action } => {
                self.propose_process_action(&program, &action, user)
            }
            Request::RansomStatus {} => Response::Ransom {
                baits: self.baits_of(user.identity().as_deref()),
            },
            Request::ProposeBaits { on } => self.propose_baits(on, user),
            Request::MemoryScan {} => {
                let mut response = memory_scan(&self.scanner, user);
                self.mark_trusted_response(&mut response, user.identity().as_deref());
                response
            }
            Request::PanicStatus {} => Response::Panic {
                since: self.settings.get().panic_since.clone(),
                available: cfg!(windows),
            },
            Request::ProposePanic { on } => self.propose_panic(on, user),
            Request::SafeStatus {} => self.safe_status(user),
            Request::SafeCreate { password } => self.propose_safe_create(&password, user),
            Request::SafeUnlock { password } => self.safe_unlock(&password, user),
            Request::SafeLock {} => self.safe_lock(user),
            Request::ProposeSafeStore { paths } => match self.check_paths(&paths) {
                Ok(()) => match long_paths(&paths, user) {
                    Ok(paths) => self.propose_safe_store(&paths, user),
                    Err(e) => e,
                },
                Err(e) => Response::error("input", e),
            },
            Request::ProposeSafeRetrieve { id } => self.propose_safe_retrieve(&id, user),
            Request::ProposeLabRun {
                path,
                stage,
                seconds,
                network,
            } => {
                let paths = [path];
                match self.check_paths(&paths) {
                    Ok(()) => match long_paths(&paths, user)
                        .map(|paths| (examine_as_user(&self.scanner, &paths, user), paths))
                    {
                        Ok((findings, paths)) => self.propose_lab_run(
                            &paths[0],
                            &findings,
                            &LabOptions {
                                stage,
                                seconds,
                                network,
                            },
                            user.identity(),
                        ),
                        Err(e) => e,
                    },
                    Err(e) => Response::error("input", e),
                }
            }
            Request::SetSchedule {
                enabled,
                every_days,
                hour_utc,
            } => self.set_schedule(enabled, every_days, hour_utc, user),
            Request::SetClamavUpdate { on } if !user.is_admin() => Response::error(
                "admin",
                if on {
                    "Nur Administratoren können das Signatur-Update für den ganzen Rechner ändern (AEGIS als Administrator starten)."
                } else {
                    "Nur Administratoren können das Signatur-Update für den ganzen Rechner abschalten (AEGIS als Administrator starten)."
                },
            ),
            Request::SetClamavUpdate { on } => {
                match self.settings.update(|s| s.clamav_update = on) {
                    Ok(()) => self.schedule_response(user),
                    Err(e) => Response::error("settings", e.to_string()),
                }
            }
            Request::SetGaming { on } => {
                // Gaming-Modus gilt nur für das eigene Profil – andere Konten werden weiter
                // geprüft und benachrichtigt.
                let profile = user.profile().map(crate::watch::long_name);
                match (user.identity(), profile) {
                    (None, _) => {
                        self.watch.set_gaming(None, on);
                        self.watch_poll(u64::MAX, user)
                    }
                    (Some(_), Some(p)) => {
                        self.watch.set_gaming(Some(&p), on);
                        self.watch_poll(u64::MAX, user)
                    }
                    (Some(_), None) => {
                        Response::error("profile", "Profilordner des Kontos nicht ermittelbar")
                    }
                }
            }
            Request::ListQuarantine {} => match self.vault.list() {
                Ok(entries) => {
                    let me = user.identity();
                    Response::Quarantine {
                        entries: entries
                            .into_iter()
                            .filter(|e| e.visible_to(me.as_deref()))
                            .collect(),
                    }
                }
                Err(e) => Response::error("quarantine", e.to_string()),
            },
            Request::ProposeQuarantine { paths } => match self.check_paths(&paths) {
                Ok(()) => match long_paths(&paths, user)
                    .map(|paths| (examine_as_user(&self.scanner, &paths, user), paths))
                {
                    Ok((findings, paths)) => {
                        self.propose_quarantine(&paths, &findings, user.identity())
                    }
                    Err(e) => e,
                },
                Err(e) => Response::error("input", e),
            },
            Request::ProposeRestore { entry_id } => {
                self.propose_entry(ActionKind::Restore, &entry_id, user)
            }
            Request::ProposeDelete { entry_id } => {
                self.propose_entry(ActionKind::DeletePermanently, &entry_id, user)
            }
            Request::Decide {
                plan_id,
                digest,
                nonce,
                decision,
                dialog_id,
            } => {
                let plan = self
                    .proposals
                    .get(&plan_id)
                    .filter(|p| p.owner == user.identity())
                    .map(|p| p.plan.clone());
                let response = self.decide(plan_id, &digest, &nonce, decision, &dialog_id, user);
                self.record_decision(plan.as_ref(), &response, user);
                response
            }
            Request::ConfirmSecond {
                challenge_id,
                nonce,
                decision,
                dialog_id,
            } => {
                let plan = self
                    .second
                    .get(&challenge_id)
                    .filter(|p| p.owner == user.identity())
                    .map(|p| p.plan.clone());
                let response =
                    self.confirm_second(challenge_id, &nonce, decision, &dialog_id, user);
                self.record_decision(plan.as_ref(), &response, user);
                response
            }
        };
        self.flush_gate_events();
        response
    }

    fn flush_gate_events(&mut self) {
        let mut events = self.gate.take_audit_events();
        if self.audit.append_all(&mut events).is_err() {
            self.audit_failed = true;
        }
    }

    /// Abgeschlossene Labor-Läufe bzw. Einstellungen ins Prüfprotokoll übernehmen.
    pub fn drain_lab_audit(&mut self) {
        let events = self.lab.take_audit();
        if events.is_empty() {
            return;
        }
        for event in events {
            self.record(event);
        }
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
    }

    fn record(&mut self, event: AuditEvent) {
        let at = self.gate.clock().now();
        if self.audit.append(at, event).is_err() {
            self.audit_failed = true;
        }
    }

    fn register(
        &mut self,
        plan: ActionPlan,
        owner: Option<String>,
        hashes: HashMap<PathBuf, String>,
    ) -> Response {
        let now = self.gate.clock().now();
        for times in self.recent_proposals.values_mut() {
            times.retain(|t| now - *t < Duration::minutes(1));
        }
        self.recent_proposals.retain(|_, times| !times.is_empty());
        let open_of_owner = self.proposals.values().filter(|p| p.owner == owner).count();
        let recent_of_owner = self.recent_proposals.get(&owner).map_or(0, Vec::len);
        // Grenzen je Konto: Ein Nutzer kann die Freigaben anderer nicht blockieren.
        if open_of_owner >= MAX_OPEN_PROPOSALS || recent_of_owner >= MAX_PROPOSALS_PER_MINUTE {
            return Response::error(
                "busy",
                "Zu viele offene Vorschläge – bitte zuerst die vorhandenen beantworten",
            );
        }
        match self.gate.propose(plan.clone()) {
            Ok(ticket) => match new_nonce() {
                Some(nonce) => {
                    self.recent_proposals
                        .entry(owner.clone())
                        .or_default()
                        .push(now);
                    self.proposals.insert(
                        ticket.id,
                        Pending {
                            plan: plan.clone(),
                            nonce: nonce.clone(),
                            owner,
                            hashes,
                        },
                    );
                    Response::Proposal {
                        proposal: Box::new(Proposal {
                            plan,
                            ticket,
                            nonce,
                        }),
                    }
                }
                None => Response::error(
                    "random",
                    "Zufallsquelle nicht verfügbar – nichts vorgeschlagen",
                ),
            },
            Err(e) => Response::error("propose", e.to_string()),
        }
    }

    /// Legt einen Quarantäne-Vorschlag an; `findings` stammen aus [`examine_as_user`]
    /// (außerhalb der Sperre geprüft).
    pub fn propose_quarantine(
        &mut self,
        paths: &[PathBuf],
        findings: &[Finding],
        owner: Option<String>,
    ) -> Response {
        if paths.is_empty() {
            return Response::error("input", "Keine Datei ausgewählt");
        }
        if let Err(e) = self.check_paths(paths) {
            return Response::error("input", e);
        }
        let worst = findings.iter().max_by_key(|f| f.risk);
        let severity = worst.map_or(RiskLevel::Info, |f| f.risk.max(RiskLevel::Info));
        let names: Vec<String> = paths
            .iter()
            .take(5)
            .map(|p| {
                quoted(&p.file_name().map_or_else(
                    || p.display().to_string(),
                    |n| n.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        let more = paths.len().saturating_sub(names.len());
        let what = format!(
            "{} {} in die Quarantäne verschieben: {}{}",
            paths.len(),
            if paths.len() == 1 { "Datei" } else { "Dateien" },
            names.join(", "),
            if more > 0 {
                format!(" und {more} weitere")
            } else {
                String::new()
            }
        );
        let why = worst.filter(|f| f.risk > RiskLevel::Clean).map_or_else(
            || "Von dir ausgewählt – AEGIS hat dabei nichts Auffälliges gefunden.".to_owned(),
            |f| f.summary_de.clone(),
        );
        let plan = ActionPlan::builder(ActionKind::Quarantine)
            .targets(paths.iter().map(Target::file))
            .what(what)
            .why(why)
            .consequence("Die Dateien werden verschlüsselt in den Tresor verschoben und sind nicht mehr ausführbar. Programme, die sie öffnen wollen, finden sie nicht mehr.")
            .undo(UndoHint::reversible("Jederzeit über Quarantäne → Wiederherstellen an den ursprünglichen Ort."))
            .severity(severity)
            .build(self.gate.clock().now());
        let hashes = findings
            .iter()
            .filter_map(|f| f.sha256.clone().map(|h| (f.path.clone(), h)))
            .collect();
        match plan {
            Ok(plan) => self.register(plan, owner, hashes),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    fn propose_entry(
        &mut self,
        kind: ActionKind,
        entry_id: &str,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let entry = match self.vault.entry(entry_id) {
            Ok(e) if e.visible_to(owner.as_deref()) => e,
            Ok(_) => {
                return Response::error("quarantine", "Dieser Eintrag gehört einem anderen Konto");
            }
            Err(e) => return Response::error("quarantine", e.to_string()),
        };
        let name = quoted(&entry.original_path.display().to_string());
        let builder = ActionPlan::builder(kind)
            .target(Target::file(&entry.original_path))
            .parameter(param::QUARANTINE_ID, &entry.id)
            .why(format!(
                "Von dir gewählt. Ursprünglicher Grund der Isolierung: {}",
                escape_text(&entry.reason)
            ))
            .severity(RiskLevel::Info);
        let builder = if kind == ActionKind::Restore {
            builder
                .what(format!("Datei aus der Quarantäne wiederherstellen: {name}"))
                .consequence("Die Datei liegt wieder am ursprünglichen Ort und kann wieder geöffnet und ausgeführt werden. Liegt dort inzwischen etwas, wird nichts überschrieben.")
                .undo(UndoHint::reversible("Erneut prüfen und isolieren."))
        } else {
            builder
                .what(format!("Quarantäne-Eintrag endgültig löschen: {name}"))
                .consequence("Die verschlüsselte Kopie wird gelöscht. Danach lässt sich die Datei nicht mehr wiederherstellen.")
                .undo(UndoHint::irreversible("Kann nicht rückgängig gemacht werden."))
        };
        match builder.build(self.gate.clock().now()) {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    fn decide(
        &mut self,
        plan_id: PlanId,
        digest: &aegis_core::plan::PlanDigest,
        nonce: &str,
        decision: Decision,
        dialog_id: &str,
        user: &dyn UserAccess,
    ) -> Response {
        // „Vertrauen“ gilt nur für Isolieren-Vorschläge (nicht für Labor oder Einstellungen –
        // sonst käme eine unbekannte Probe auf die Vertrauensliste). Der Vorschlag bleibt offen.
        if decision == Decision::Trust
            && self
                .proposals
                .get(&plan_id)
                .is_some_and(|p| p.plan.kind() != ActionKind::Quarantine)
        {
            return Response::error(
                "trust",
                "„Vertrauen“ gibt es für diesen Vorschlag nicht – nichts verändert",
            );
        }
        // Nonce zuerst: unbekannte oder wiederholte Antworten erreichen das Tor gar nicht.
        let Some(pending) = self
            .proposals
            .remove(&plan_id)
            .filter(|p| p.owner == user.identity())
        else {
            return Response::error(
                "unknown",
                "Unbekannter oder bereits beantworteter Vorschlag – nichts ausgeführt",
            );
        };
        let Pending {
            plan,
            nonce: expected,
            hashes,
            ..
        } = pending;
        if !constant_time_eq(expected.as_bytes(), nonce.as_bytes()) {
            return Response::error(
                "nonce",
                "Antwort passt nicht zum Vorschlag – nichts ausgeführt",
            );
        }
        if self.audit_failed && decision == Decision::Execute {
            return Response::error(
                "audit",
                "Prüfprotokoll nicht schreibbar – aus Sicherheitsgründen wird nichts ausgeführt",
            );
        }
        // Einzige Stelle im Betrieb, an der aus der Antwort im Dialog eine Freigabe wird.
        // aegis-consent: service-pipe-decide
        #[allow(clippy::disallowed_methods)]
        let outcome = self.gate.decide(
            plan_id,
            digest,
            decision,
            DecisionOrigin::ui_dialog(dialog_id),
        );
        match outcome {
            Ok(Outcome::Approved(approval)) => self.execute_approved(approval, &plan, user),
            Ok(Outcome::Declined) => Response::NothingDone {
                decision: Decision::Decline,
            },
            Ok(Outcome::Ignored) => Response::NothingDone {
                decision: Decision::Ignore,
            },
            Ok(Outcome::Trusted(grant)) => self.trust_files(&grant, &plan, &hashes, user),
            Err(e) => Response::error("consent", e.to_string()),
        }
    }

    /// „Vertrauen“: Die Dateien des Plans (Hash + Pfad, mit den Rechten des Nutzers gelesen)
    /// kommen auf die Vertrauensliste des Kontos. Sonst wird nichts verändert.
    fn trust_files(
        &mut self,
        grant: &aegis_core::consent::TrustGrant,
        plan: &ActionPlan,
        hashes: &HashMap<PathBuf, String>,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let now = self.gate.clock().now();
        let mut entries = Vec::new();
        let mut skipped = Vec::new();
        for target in grant.targets() {
            let Target::File { path } = target else {
                continue;
            };
            // Hash aus der Prüfung beim Vorschlag (mit den Rechten des Nutzers gelesen).
            match hashes.get(path) {
                Some(sha) => entries.push(TrustEntry {
                    id: aegis_core::uuid::Uuid::new_v4().hyphenated().to_string(),
                    sha256: sha.clone(),
                    path: path.clone(),
                    reason: escape_text(plan.why()),
                    created_at: now,
                    owner: owner.clone(),
                }),
                None => skipped.push(format!(
                    "{}: beim Vorschlag nicht lesbar",
                    escape_text(&path.display().to_string())
                )),
            }
        }
        if let Err(e) = self.trust.add(entries.clone()) {
            return Response::error(
                "trust",
                format!("Vertrauensliste nicht speicherbar: {e} – nichts vertraut"),
            );
        }
        let mut note = format!(
            "Nichts ausgeführt. {} Datei(en) stehen jetzt auf deiner Vertrauensliste (Hash + Pfad) – jederzeit widerrufbar.",
            entries.len()
        );
        if !skipped.is_empty() {
            note.push_str(&format!(" Nicht lesbar: {}", skipped.join("; ")));
        }
        Response::Trusted { note, entries }
    }

    /// Schreibt alle bisherigen Ereignisse (u. a. die Freigabe) und sichert das Protokoll
    /// dauerhaft. Erst danach darf etwas verändert werden.
    fn audit_before_execution(&mut self) -> bool {
        self.flush_gate_events();
        if !self.audit_failed && self.audit.sync().is_err() {
            self.audit_failed = true;
        }
        !self.audit_failed
    }

    fn execute_approved(
        &mut self,
        approval: Approval,
        plan: &ActionPlan,
        user: &dyn UserAccess,
    ) -> Response {
        if plan.kind() == ActionKind::DeletePermanently {
            return match (
                self.gate.request_second_confirmation(&approval),
                new_nonce(),
            ) {
                (Ok(challenge), Some(nonce)) => {
                    self.second.insert(
                        challenge.challenge_id,
                        PendingSecond {
                            approval,
                            plan: plan.clone(),
                            nonce: nonce.clone(),
                            created: self.gate.clock().now(),
                            owner: user.identity(),
                        },
                    );
                    Response::SecondConfirmationRequired { challenge, nonce }
                }
                (Err(e), _) => Response::error("consent", e.to_string()),
                (_, None) => Response::error(
                    "random",
                    "Zufallsquelle nicht verfügbar – nichts ausgeführt",
                ),
            };
        }
        let permit = match approval.redeem(plan, &mut self.gate) {
            Ok(p) => p,
            Err(e) => return Response::error("consent", e.to_string()),
        };
        if !self.audit_before_execution() {
            // Die Erlaubnis verfällt ungenutzt: nichts ohne lückenloses Protokoll.
            drop(permit);
            return audit_unavailable();
        }
        let result = match plan.kind() {
            ActionKind::Quarantine => self.vault.quarantine(permit, user),
            ActionKind::Restore => self.vault.restore(permit, user),
            ActionKind::RunInSandbox => return self.start_lab(permit, user),
            ActionKind::TerminateProcess
            | ActionKind::SuspendProcess
            | ActionKind::ResumeProcess => {
                return self.control_processes(permit, user);
            }
            ActionKind::SafeStore => return self.apply_safe_store(permit, user),
            ActionKind::SafeRetrieve => return self.apply_safe_retrieve(permit, user),
            ActionKind::ChangeSetting => {
                let bait = plan.targets().iter().any(|t| {
                    matches!(t, Target::Setting { id } if id == aegis_quarantine::bait::BAIT_SETTING)
                });
                let panic = plan.targets().iter().any(
                    |t| matches!(t, Target::Setting { id } if id == crate::panic::PANIC_SETTING),
                );
                let safe = plan.targets().iter().any(|t| {
                    matches!(t, Target::Setting { id } if id == aegis_quarantine::safe::SAFE_SETTING)
                });
                return if bait {
                    self.apply_baits(permit, user)
                } else if panic {
                    self.apply_panic(permit, user)
                } else if safe {
                    self.apply_safe_create(permit, user)
                } else {
                    self.enable_sandbox_feature(permit, user)
                };
            }
            other => {
                // Andere Arten führt dieser Dienst (noch) nicht aus; die Erlaubnis verfällt.
                let event = permit.complete(aegis_core::audit::ExecutionResult::Failed {
                    message: format!("Aktion {} wird hier nicht unterstützt", other.as_str()),
                });
                self.record(event);
                return Response::error(
                    "unsupported",
                    "Diese Aktion wird vom Dienst noch nicht unterstützt – nichts ausgeführt",
                );
            }
        };
        self.report(plan.kind(), result)
    }

    fn report(
        &mut self,
        kind: ActionKind,
        result: Result<aegis_quarantine::Outcome, aegis_quarantine::QuarantineError>,
    ) -> Response {
        match result {
            Ok(outcome) => {
                let exec = match &outcome.event {
                    AuditEvent::ActionExecuted { result, .. } => result.clone(),
                    _ => aegis_core::audit::ExecutionResult::Succeeded,
                };
                self.record(outcome.event);
                if self.audit.sync().is_err() {
                    self.audit_failed = true;
                }
                Response::Executed {
                    kind,
                    result: exec,
                    entries: outcome.entries,
                    failures: outcome.failures,
                }
            }
            Err(e) => Response::error("execute", e.to_string()),
        }
    }

    fn confirm_second(
        &mut self,
        challenge_id: ChallengeId,
        nonce: &str,
        decision: Decision,
        dialog_id: &str,
        user: &dyn UserAccess,
    ) -> Response {
        let Some(pending) = self
            .second
            .remove(&challenge_id)
            .filter(|p| p.owner == user.identity())
        else {
            return Response::error(
                "unknown",
                "Unbekannte oder bereits beantwortete Rückfrage – nichts gelöscht",
            );
        };
        if !constant_time_eq(pending.nonce.as_bytes(), nonce.as_bytes()) {
            return Response::error(
                "nonce",
                "Antwort passt nicht zur Rückfrage – nichts gelöscht",
            );
        }
        if self.audit_failed && decision == Decision::Execute {
            return Response::error(
                "audit",
                "Prüfprotokoll nicht schreibbar – aus Sicherheitsgründen wird nichts gelöscht",
            );
        }
        // Zweite, getrennte Bestätigung vor endgültigem Löschen – nur hier im Betrieb.
        // aegis-consent: service-pipe-confirm-second
        #[allow(clippy::disallowed_methods)]
        let confirmed = self.gate.confirm_second(
            pending.approval,
            challenge_id,
            decision,
            DecisionOrigin::ui_dialog(dialog_id),
        );
        match confirmed {
            Ok(delete_approval) => match delete_approval.redeem(&pending.plan, &mut self.gate) {
                Ok(permit) => {
                    if !self.audit_before_execution() {
                        drop(permit);
                        return audit_unavailable();
                    }
                    let result = self.vault.delete_permanently(permit, user);
                    self.report(ActionKind::DeletePermanently, result)
                }
                Err(e) => Response::error("consent", e.to_string()),
            },
            Err(_) if decision != Decision::Execute => Response::NothingDone { decision },
            Err(e) => Response::error("consent", e.to_string()),
        }
    }

    /// Offene Einträge (für Tests/Diagnose).
    ///
    /// # Errors
    /// Wie [`Vault::list`].
    pub fn quarantine_entries(&self) -> Result<Vec<Entry>, aegis_quarantine::QuarantineError> {
        self.vault.list()
    }

    /// Gibt ausstehende Prüfprotokoll-Ereignisse zurück (für Tests).
    pub fn take_unwritten_events(&mut self) -> Vec<TimedEvent> {
        self.gate.take_audit_events()
    }
}

fn audit_unavailable() -> Response {
    Response::error(
        "audit",
        "Prüfprotokoll nicht schreibbar – aus Sicherheitsgründen wird nichts ausgeführt",
    )
}

/// Windows: Kurznamen (`RUNNER~1`) in lange Namen umschreiben – mit den Rechten des Nutzers,
/// ohne Links aufzulösen. Pläne zeigen dann den echten Namen, und die Quarantäne vergleicht
/// ihn mit dem tatsächlichen Pfad. Nicht vorhandene Pfade bleiben unverändert.
///
/// # Errors
/// Fertige Fehler-Antwort, wenn der Identitätswechsel scheitert.
pub fn long_paths(paths: &[PathBuf], user: &dyn UserAccess) -> Result<Vec<PathBuf>, Response> {
    #[cfg(windows)]
    {
        let _scope = user.enter().map_err(|e| identity_error(&e))?;
        Ok(paths
            .iter()
            .map(|p| aegis_winffi::long_path(p).unwrap_or_else(|_| p.clone()))
            .collect())
    }
    #[cfg(not(windows))]
    {
        let _ = user;
        Ok(paths.to_vec())
    }
}

fn lock_history(history: &Mutex<History>) -> std::sync::MutexGuard<'_, History> {
    history
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Verlaufseintrag für einen Scan.
fn scan_entry(
    kind: HistoryKind,
    report: &aegis_engine::ScanReport,
    label: &str,
    owner: Option<String>,
    scope: Option<PathBuf>,
) -> NewEntry {
    let notable: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|f| f.risk > RiskLevel::Info)
        .collect();
    let detail = notable
        .iter()
        .take(crate::history::MAX_PATHS)
        .map(|f| format!("{}: {}", f.path.display(), f.summary_de))
        .collect::<Vec<_>>()
        .join("\n");
    NewEntry {
        kind,
        risk: notable.iter().map(|f| f.risk).max(),
        title: format!(
            "{label}: {} Dateien geprüft, {} auffällig{}{}",
            report.findings.len(),
            notable.len(),
            match report
                .findings
                .iter()
                .filter(|f| f.not_scannable.is_some() && f.risk <= RiskLevel::Info)
                .count()
            {
                0 => String::new(),
                n => format!(", {n} nicht prüfbar"),
            },
            if report.truncated {
                " (abgebrochen: zu viele Dateien)"
            } else {
                ""
            }
        ),
        detail,
        paths: notable.iter().map(|f| f.path.clone()).collect(),
        owner,
        scope,
    }
}

/// Scannt mit den Rechten des Nutzers (sieht nur, was er selbst lesen darf) – im Betrieb im
/// eingeschränkten Prüfprozess.
/// Kurznamen (8.3) werden vorher wie beim Vorschlag in lange Namen umgeschrieben – so passen
/// Funde zur Vertrauensliste und zeigen den echten Namen.
pub fn scan_as_user(scanner: &Scanner, paths: &[PathBuf], user: &dyn UserAccess) -> Response {
    let paths = match long_paths(paths, user) {
        Ok(p) => p,
        Err(response) => return response,
    };
    match scanner.scan(&paths, user) {
        Ok(report) => Response::ScanReport {
            report: Box::new(report),
        },
        Err(e) => Response::error("scan", e),
    }
}

/// Prüft Dateien für einen Vorschlag mit den Rechten des Nutzers. Scheitert die Prüfung
/// (z. B. Absturz des Prüfprozesses an einer bösartig aufgebauten Datei), darf der Nutzer
/// trotzdem isolieren: Die Dateien gelten dann als „nicht prüfbar“.
#[must_use]
pub fn examine_as_user(
    scanner: &Scanner,
    paths: &[PathBuf],
    user: &dyn UserAccess,
) -> Vec<Finding> {
    scanner.examine(paths, user).unwrap_or_else(|e| {
        paths
            .iter()
            .map(|p| Finding::unscannable(p.clone(), &e))
            .collect()
    })
}

#[cfg(windows)]
fn identity_error(e: &std::io::Error) -> Response {
    Response::error(
        "identity",
        format!("Rechte des Nutzers nicht übernehmbar ({e}) – nichts geprüft"),
    )
}

/// Pfadregeln: absolut, ohne `.`/`..`, unter Windows nur Laufwerkspfade (`C:\…`; keine
/// Netzwerk-, Geräte- oder `\\?\`-Pfade), nichts im AEGIS-Datenordner, begrenzte Größe.
fn check_paths(paths: &[PathBuf], protected: &[PathBuf]) -> Result<(), String> {
    if paths.len() > MAX_PATHS {
        return Err(format!("Höchstens {MAX_PATHS} Pfade pro Anfrage"));
    }
    let bytes: usize = paths.iter().map(|p| p.as_os_str().len()).sum();
    if bytes > MAX_PATH_BYTES {
        return Err("Pfade zu lang".into());
    }
    for p in paths {
        check_path(p)?;
        if protected.iter().any(|d| starts_with_folded(p, d)) {
            return Err(format!(
                "Der AEGIS-Datenordner ist kein zulässiges Ziel: {}",
                escape_text(&p.display().to_string())
            ));
        }
    }
    Ok(())
}

fn check_path(p: &Path) -> Result<(), String> {
    let shown = || escape_text(&p.display().to_string());
    if !p.is_absolute() {
        return Err(format!("Nur absolute Pfade erlaubt: {}", shown()));
    }
    // Auf dem Rohtext prüfen: `Path::components` lässt innere „.“ stillschweigend weg.
    if p.as_os_str()
        .to_string_lossy()
        .split(['/', '\\'])
        .any(|part| part == "." || part == "..")
    {
        return Err(format!("Pfad mit „.“ oder „..“ nicht erlaubt: {}", shown()));
    }
    #[cfg(windows)]
    {
        use std::path::Component;
        use std::path::Prefix;
        let local_drive = matches!(
            p.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
        );
        if !local_drive {
            return Err(format!(
                "Nur Pfade auf Laufwerken (z. B. C:\\…) erlaubt, keine Netzwerk- oder Gerätepfade: {}",
                shown()
            ));
        }
    }
    Ok(())
}

/// Liegt `path` in `dir`? Unter Windows ohne Groß-/Kleinschreibung.
fn starts_with_folded(path: &Path, dir: &Path) -> bool {
    if cfg!(windows) {
        let fold = |p: &Path| p.to_string_lossy().to_uppercase().replace('/', "\\");
        let (p, d) = (fold(path), fold(dir));
        let d = d.trim_end_matches('\\');
        p == d || p.starts_with(&format!("{d}\\"))
    } else {
        path.starts_with(dir)
    }
}

/// Macht unsichtbare und richtungsändernde Zeichen sichtbar (`\u{202E}`), damit ein
/// Dateiname im Freigabe-Dialog nicht anders aussieht, als er ist.
#[must_use]
pub fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let hidden = c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}' | '\u{00AD}'
                | '\u{180E}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}');
        if hidden {
            out.push_str(&format!("\\u{{{:04X}}}", u32::from(c)));
        } else {
            out.push(c);
        }
    }
    out
}

/// Name in deutschen Anführungszeichen, unsichtbare Zeichen sichtbar gemacht.
fn quoted(name: &str) -> String {
    format!("„{}“", escape_text(name))
}

fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Höchstwerte des Speicher-Scans.
#[cfg(windows)]
const MEMORY_MAX_PROCESSES: usize = 300;
#[cfg(windows)]
const MEMORY_MAX_MODULES: usize = 2000;
#[cfg(windows)]
const MEMORY_PER_PROCESS: usize = 16 * 1024 * 1024;
#[cfg(windows)]
const MEMORY_TOTAL: usize = 256 * 1024 * 1024;

/// Speicher-Scan: Programme, geladene Module und ausführbarer privater Speicher der eigenen
/// laufenden Prozesse. Gelesen wird im Identitätswechsel des Nutzers, geprüft nur im
/// Prüfprozess; es wird nichts verändert.
pub fn memory_scan(scanner: &crate::worker::Scanner, user: &dyn UserAccess) -> Response {
    #[cfg(windows)]
    {
        use base64::Engine as _;
        let me = user.identity();
        let Ok(all) = aegis_winffi::inspect::processes() else {
            return Response::error("scan", "Prozessliste nicht lesbar");
        };
        let own: Vec<u32> = all
            .into_iter()
            .map(|p| p.pid)
            .filter(|pid| *pid != 0 && *pid != 4)
            .filter(|pid| me.is_some() && aegis_winffi::system::process_user_sid(*pid).ok() == me)
            .take(MEMORY_MAX_PROCESSES)
            .collect();
        let mut files: Vec<PathBuf> = Vec::new();
        let mut blocks = Vec::new();
        let mut skipped = Vec::new();
        let mut total = 0usize;
        {
            let _scope = match user.enter() {
                Ok(s) => s,
                Err(e) => return Response::error("identity", e.to_string()),
            };
            for pid in &own {
                let image = aegis_winffi::system::process_image_path(*pid).ok();
                if let Some(image) = &image
                    && !files.iter().any(|f| crate::paths::same_path(f, image))
                {
                    files.push(image.clone());
                }
                if let Ok(mods) = aegis_winffi::memory::modules(*pid, 512) {
                    for m in mods {
                        if files.len() < MEMORY_MAX_MODULES
                            && !files.iter().any(|f| crate::paths::same_path(f, &m))
                        {
                            files.push(m);
                        }
                    }
                }
                if total >= MEMORY_TOTAL {
                    continue;
                }
                match aegis_winffi::memory::executable_private_regions(
                    *pid,
                    MEMORY_PER_PROCESS.min(MEMORY_TOTAL - total),
                ) {
                    Ok(regions) => {
                        for r in regions {
                            total += r.data.len();
                            let name = image
                                .as_ref()
                                .map_or_else(|| format!("PID {pid}"), |i| i.display().to_string());
                            blocks.push(crate::worker::MemoryBlock {
                                label: format!("Speicher von {name} (PID {pid}) @ {:#x}", r.base),
                                data: base64::engine::general_purpose::STANDARD.encode(&r.data),
                            });
                        }
                    }
                    Err(e) => skipped.push(aegis_engine::scan::Skipped {
                        path: image.unwrap_or_else(|| PathBuf::from(format!("PID {pid}"))),
                        reason: format!("Speicher nicht lesbar: {e}"),
                    }),
                }
            }
        }
        let modules = files.len();
        let regions = blocks.len();
        let mut findings = Vec::new();
        for chunk in files.chunks(200) {
            match scanner.examine(chunk, user) {
                Ok(found) => findings.extend(found),
                Err(e) => skipped.push(aegis_engine::scan::Skipped {
                    path: chunk.first().cloned().unwrap_or_default(),
                    reason: e,
                }),
            }
        }
        // Speicher in Paketen bis zur Größe einer Anfrage.
        let mut batch = Vec::new();
        let mut size = 0usize;
        let flush = |batch: &mut Vec<crate::worker::MemoryBlock>,
                     findings: &mut Vec<Finding>,
                     skipped: &mut Vec<aegis_engine::scan::Skipped>| {
            if batch.is_empty() {
                return;
            }
            match scanner.scan_memory(std::mem::take(batch), user) {
                Ok(found) => findings.extend(found),
                Err(e) => skipped.push(aegis_engine::scan::Skipped {
                    path: PathBuf::from("Speicher"),
                    reason: e,
                }),
            }
        };
        for block in blocks {
            let len = block.data.len() * 3 / 4;
            if size + len > crate::worker::MAX_MEMORY_PER_REQUEST {
                flush(&mut batch, &mut findings, &mut skipped);
                size = 0;
            }
            size += len;
            batch.push(block);
        }
        flush(&mut batch, &mut findings, &mut skipped);
        findings.retain(|f| f.risk > RiskLevel::Info || f.not_scannable.is_some());
        findings.truncate(1000);
        skipped.truncate(200);
        Response::MemoryScan {
            report: Box::new(aegis_engine::ScanReport {
                findings,
                skipped,
                truncated: false,
            }),
            processes: own.len(),
            modules,
            regions,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (scanner, user);
        Response::error("scan", "Den Speicher-Scan gibt es nur unter Windows")
    }
}

/// Laufende Prozesse eines Programms, die das Konto anfassen darf: eigene; Administratoren alle.
#[cfg(windows)]
fn running_processes_of(
    program: &Path,
    user: &dyn UserAccess,
) -> Result<Vec<(u32, PathBuf)>, String> {
    let me = user.identity();
    let admin = user.is_admin();
    let all = aegis_winffi::inspect::processes().map_err(|e| e.to_string())?;
    Ok(all
        .into_iter()
        .filter(|p| p.pid != std::process::id())
        .filter_map(|p| {
            let image = aegis_winffi::system::process_image_path(p.pid).ok()?;
            if !crate::paths::same_path(&image, program) {
                return None;
            }
            let owner = aegis_winffi::system::process_user_sid(p.pid).ok();
            (admin || (owner.is_some() && owner == me)).then_some((p.pid, image))
        })
        .take(32)
        .collect())
}

#[cfg(not(windows))]
fn running_processes_of(
    _program: &Path,
    _user: &dyn UserAccess,
) -> Result<Vec<(u32, PathBuf)>, String> {
    Err("Prozess-Aktionen gibt es nur unter Windows".into())
}

/// Eine Prozess-Aktion (im Identitätswechsel aufrufen).
#[cfg(windows)]
fn control_one(pid: u32, image: &Path, kind: ActionKind) -> Result<(), String> {
    use aegis_winffi::control::{ProcessAction, control_process};
    let action = match kind {
        ActionKind::TerminateProcess => ProcessAction::Terminate,
        ActionKind::SuspendProcess => ProcessAction::Suspend,
        ActionKind::ResumeProcess => ProcessAction::Resume,
        _ => return Err("Keine Prozess-Aktion".into()),
    };
    control_process(pid, image, action).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn control_one(_pid: u32, _image: &Path, _kind: ActionKind) -> Result<(), String> {
    Err("Prozess-Aktionen gibt es nur unter Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsichtbare_zeichen_werden_sichtbar() {
        assert_eq!(
            escape_text("rechnung\u{202E}fdp.exe"),
            r"rechnung\u{202E}fdp.exe"
        );
        assert_eq!(escape_text("a\u{200B}b\nc"), r"a\u{200B}b\u{000A}c");
        assert_eq!(quoted("x.pdf"), "„x.pdf“");
        assert_eq!(escape_text("Größe – ok"), "Größe – ok");
    }

    #[test]
    fn pfade_im_schutzordner() {
        let dir = Path::new("/daten/aegis");
        assert!(starts_with_folded(Path::new("/daten/aegis/vault.key"), dir));
        assert!(starts_with_folded(dir, dir));
        assert!(!starts_with_folded(Path::new("/daten/aegis-x/a"), dir));
        assert!(check_paths(&[PathBuf::from("/daten/aegis/q")], &[dir.to_path_buf()]).is_err());
        assert!(check_paths(&[PathBuf::from("/a/./b")], &[]).is_err());
        assert!(check_paths(&[PathBuf::from("/a/b")], &[]).is_ok() || cfg!(windows));
    }
}
