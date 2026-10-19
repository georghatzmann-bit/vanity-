//! Verarbeitung der Anfragen – die **einzige** Stelle im Betrieb, an der aus einer
//! Nutzerantwort eine Freigabe wird (`ConsentGate::decide`/`confirm_second`, per
//! Mutations-Wächter erzwungen).
//!
//! Der Dienst formuliert jeden Plan selbst (aus eigener Prüfung bzw. aus dem
//! Quarantäne-Eintrag) – die Oberfläche kann nur auswählen und antworten.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aegis_core::audit::{AuditEvent, AuditLog, Durable, TimedEvent};
use aegis_core::consent::{
    Approval, ChallengeId, Clock, ConsentGate, Decision, DecisionOrigin, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, PlanId, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_engine::{Engine, Finding};

use crate::trust::{TrustEntry, TrustStore};
use crate::watch::{Viewer, WatchShared};
use crate::worker::Scanner;
use aegis_quarantine::{Entry, UserAccess, Vault};

use crate::protocol::{PROTOCOL_VERSION, Proposal, Request, Response};

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
        if let Response::ScanReport { report } = response {
            self.mark_trusted(&mut report.findings, owner);
        }
    }

    /// Meldungen des Wächters für dieses Konto: eigenes Profil + gemeinsame Orte; Dateien,
    /// denen das Konto vertraut, werden nicht gemeldet.
    fn watch_poll(&self, after: u64, user: &dyn UserAccess) -> Response {
        let owner = user.identity();
        let profile = user.profile();
        let viewer = match (&owner, &profile) {
            (None, _) => Viewer::All,
            (Some(_), Some(p)) => Viewer::Profile(p),
            (Some(_), None) => Viewer::SharedOnly,
        };
        let mut events = self.watch.events_after(after, viewer);
        for event in &mut events {
            self.mark_trusted(std::slice::from_mut(&mut event.finding), owner.as_deref());
        }
        events.retain(|e| e.finding.trusted.is_none());
        Response::Watch {
            events,
            status: self.watch.status(),
            gaming_left: self.watch.gaming_left(),
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
        for id in self.gate.expire_stale() {
            self.proposals.remove(&id);
        }
        let now = self.gate.clock().now();
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
            Request::SetGaming { on } => {
                self.watch.set_gaming(on);
                self.watch_poll(u64::MAX, user)
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
            } => self.decide(plan_id, &digest, &nonce, decision, &dialog_id, user),
            Request::ConfirmSecond {
                challenge_id,
                nonce,
                decision,
                dialog_id,
            } => self.confirm_second(challenge_id, &nonce, decision, &dialog_id, user),
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

    fn record(&mut self, event: AuditEvent) {
        let at = self.gate.clock().now();
        if self.audit.append(at, event).is_err() {
            self.audit_failed = true;
        }
    }

    fn register(&mut self, plan: ActionPlan, owner: Option<String>) -> Response {
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
        match plan {
            Ok(plan) => self.register(plan, owner),
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
            Ok(plan) => self.register(plan, owner),
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
            Ok(Outcome::Trusted(grant)) => self.trust_files(&grant, &plan, user),
            Err(e) => Response::error("consent", e.to_string()),
        }
    }

    /// „Vertrauen“: Die Dateien des Plans (Hash + Pfad, mit den Rechten des Nutzers gelesen)
    /// kommen auf die Vertrauensliste des Kontos. Sonst wird nichts verändert.
    fn trust_files(
        &mut self,
        grant: &aegis_core::consent::TrustGrant,
        plan: &ActionPlan,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let now = self.gate.clock().now();
        let mut entries = Vec::new();
        let mut skipped = Vec::new();
        {
            let scope = user.enter();
            if scope.is_err() {
                return Response::error(
                    "identity",
                    "Rechte des Nutzers nicht übernehmbar – nichts vertraut",
                );
            }
            for target in grant.targets() {
                let Target::File { path } = target else {
                    continue;
                };
                let hashed = std::fs::File::open(path)
                    .and_then(|f| aegis_engine::hash::sha256_reader(std::io::BufReader::new(f)));
                match hashed {
                    Ok((sha, _)) => entries.push(TrustEntry {
                        id: aegis_core::uuid::Uuid::new_v4().hyphenated().to_string(),
                        sha256: aegis_engine::hash::to_hex(&sha),
                        path: path.clone(),
                        reason: escape_text(plan.why()),
                        created_at: now,
                        owner: owner.clone(),
                    }),
                    Err(e) => {
                        skipped.push(format!("{}: {e}", escape_text(&path.display().to_string())))
                    }
                }
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

/// Scannt mit den Rechten des Nutzers (sieht nur, was er selbst lesen darf) – im Betrieb im
/// eingeschränkten Prüfprozess.
pub fn scan_as_user(scanner: &Scanner, paths: &[PathBuf], user: &dyn UserAccess) -> Response {
    match scanner.scan(paths, user) {
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
