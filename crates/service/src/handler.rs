//! Verarbeitung der Anfragen – die **einzige** Stelle im Betrieb, an der aus einer
//! Nutzerantwort eine Freigabe wird (`ConsentGate::decide`/`confirm_second`, per
//! Mutations-Wächter erzwungen).
//!
//! Der Dienst formuliert jeden Plan selbst (aus eigener Prüfung bzw. aus dem
//! Quarantäne-Eintrag) – die Oberfläche kann nur auswählen und antworten.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use aegis_core::audit::{AuditEvent, AuditLog, TimedEvent};
use aegis_core::consent::{
    Approval, ChallengeId, Clock, ConsentGate, Decision, DecisionOrigin, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, PlanId, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_engine::Engine;
use aegis_quarantine::{Entry, Vault};

use crate::protocol::{PROTOCOL_VERSION, Proposal, Request, Response};

/// Höchstzahl Pfade pro Anfrage.
pub const MAX_PATHS: usize = 1000;

struct PendingSecond {
    approval: Approval,
    plan: ActionPlan,
    nonce: String,
}

/// Zustand des Dienstes.
pub struct Service<C: Clock, W: Write> {
    engine: Engine,
    vault: Vault,
    gate: ConsentGate<C>,
    audit: AuditLog<W>,
    audit_failed: bool,
    proposals: HashMap<PlanId, (ActionPlan, String)>,
    second: HashMap<ChallengeId, PendingSecond>,
}

impl<C: Clock, W: Write> Service<C, W> {
    /// Neuer Dienst-Zustand.
    pub fn new(engine: Engine, vault: Vault, gate: ConsentGate<C>, audit: AuditLog<W>) -> Self {
        Self {
            engine,
            vault,
            gate,
            audit,
            audit_failed: false,
            proposals: HashMap::new(),
            second: HashMap::new(),
        }
    }

    /// Zugriff auf das Freigabe-Tor (Tests, Diagnose).
    pub fn gate(&self) -> &ConsentGate<C> {
        &self.gate
    }

    /// Verarbeitet eine Anfrage. Abgelaufene Vorschläge werden vorher verworfen
    /// (Standard bei Nicht-Reaktion: nichts tun).
    pub fn handle(&mut self, request: Request) -> Response {
        for id in self.gate.expire_stale() {
            self.proposals.remove(&id);
        }
        let response = match request {
            Request::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => Response::error(
                "protocol",
                format!("Protokoll {protocol} nicht unterstützt (Dienst: {PROTOCOL_VERSION})"),
            ),
            Request::Hello { .. } => Response::Hello {
                service: format!("aegis-service {}", env!("CARGO_PKG_VERSION")),
                protocol: PROTOCOL_VERSION,
            },
            Request::Scan { paths } => match check_paths(&paths) {
                Ok(()) => Response::ScanReport {
                    report: Box::new(self.engine.scan_paths(&paths)),
                },
                Err(e) => Response::error("input", e),
            },
            Request::ListQuarantine {} => match self.vault.list() {
                Ok(entries) => Response::Quarantine { entries },
                Err(e) => Response::error("quarantine", e.to_string()),
            },
            Request::ProposeQuarantine { paths } => match check_paths(&paths) {
                Ok(()) => self.propose_quarantine(&paths),
                Err(e) => Response::error("input", e),
            },
            Request::ProposeRestore { entry_id } => {
                self.propose_entry(ActionKind::Restore, &entry_id)
            }
            Request::ProposeDelete { entry_id } => {
                self.propose_entry(ActionKind::DeletePermanently, &entry_id)
            }
            Request::Decide {
                plan_id,
                digest,
                nonce,
                decision,
                dialog_id,
            } => self.decide(plan_id, &digest, &nonce, decision, &dialog_id),
            Request::ConfirmSecond {
                challenge_id,
                nonce,
                decision,
                dialog_id,
            } => self.confirm_second(challenge_id, &nonce, decision, &dialog_id),
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

    fn register(&mut self, plan: ActionPlan) -> Response {
        match self.gate.propose(plan.clone()) {
            Ok(ticket) => match new_nonce() {
                Some(nonce) => {
                    self.proposals
                        .insert(ticket.id, (plan.clone(), nonce.clone()));
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

    fn propose_quarantine(&mut self, paths: &[PathBuf]) -> Response {
        if paths.is_empty() {
            return Response::error("input", "Keine Datei ausgewählt");
        }
        let findings: Vec<_> = paths.iter().map(|p| self.engine.scan_file(p)).collect();
        let worst = findings.iter().max_by_key(|f| f.risk);
        let severity = worst.map_or(RiskLevel::Info, |f| f.risk.max(RiskLevel::Info));
        let names: Vec<String> = paths
            .iter()
            .take(5)
            .map(|p| {
                p.file_name().map_or_else(
                    || p.display().to_string(),
                    |n| n.to_string_lossy().into_owned(),
                )
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
            Ok(plan) => self.register(plan),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    fn propose_entry(&mut self, kind: ActionKind, entry_id: &str) -> Response {
        let entry = match self.vault.entry(entry_id) {
            Ok(e) => e,
            Err(e) => return Response::error("quarantine", e.to_string()),
        };
        let name = entry.original_path.display().to_string();
        let builder = ActionPlan::builder(kind)
            .target(Target::file(&entry.original_path))
            .parameter(param::QUARANTINE_ID, &entry.id)
            .why(format!(
                "Von dir gewählt. Ursprünglicher Grund der Isolierung: {}",
                entry.reason
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
            Ok(plan) => self.register(plan),
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
    ) -> Response {
        // Nonce zuerst: unbekannte oder wiederholte Antworten erreichen das Tor gar nicht.
        let Some((plan, expected)) = self.proposals.remove(&plan_id) else {
            return Response::error(
                "unknown",
                "Unbekannter oder bereits beantworteter Vorschlag – nichts ausgeführt",
            );
        };
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
            Ok(Outcome::Approved(approval)) => self.execute_approved(approval, &plan),
            Ok(Outcome::Declined) => Response::NothingDone {
                decision: Decision::Decline,
            },
            Ok(Outcome::Ignored) => Response::NothingDone {
                decision: Decision::Ignore,
            },
            Ok(Outcome::Trusted(_grant)) => Response::Trusted {
                note: "Nichts ausgeführt. Die Vertrauensliste (Hash + Pfad + Grund) folgt in P3."
                    .into(),
            },
            Err(e) => Response::error("consent", e.to_string()),
        }
    }

    fn execute_approved(&mut self, approval: Approval, plan: &ActionPlan) -> Response {
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
        let result = match plan.kind() {
            ActionKind::Quarantine => self.vault.quarantine(permit),
            ActionKind::Restore => self.vault.restore(permit),
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
    ) -> Response {
        let Some(pending) = self.second.remove(&challenge_id) else {
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
                    let result = self.vault.delete_permanently(permit);
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

fn check_paths(paths: &[PathBuf]) -> Result<(), String> {
    if paths.len() > MAX_PATHS {
        return Err(format!("Höchstens {MAX_PATHS} Pfade pro Anfrage"));
    }
    if let Some(p) = paths.iter().find(|p| !p.is_absolute()) {
        return Err(format!("Nur absolute Pfade erlaubt: {}", p.display()));
    }
    Ok(())
}

fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
