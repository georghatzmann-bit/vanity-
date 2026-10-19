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
}

/// Zustand des Dienstes.
pub struct Service<C: Clock, W: Durable> {
    engine: Arc<Engine>,
    vault: Vault,
    gate: ConsentGate<C>,
    audit: AuditLog<W>,
    audit_failed: bool,
    proposals: HashMap<PlanId, (ActionPlan, String)>,
    second: HashMap<ChallengeId, PendingSecond>,
    recent_proposals: Vec<OffsetDateTime>,
    protected: Vec<PathBuf>,
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Neuer Dienst-Zustand.
    pub fn new(engine: Engine, vault: Vault, gate: ConsentGate<C>, audit: AuditLog<W>) -> Self {
        let protected = vec![vault.dir().to_path_buf()];
        Self {
            engine: Arc::new(engine),
            vault,
            gate,
            audit,
            audit_failed: false,
            proposals: HashMap::new(),
            second: HashMap::new(),
            recent_proposals: Vec::new(),
            protected,
        }
    }

    /// Ordner, deren Inhalt nie Ziel einer Anfrage sein darf (AEGIS-Datenordner).
    #[must_use]
    pub fn with_protected(mut self, dirs: Vec<PathBuf>) -> Self {
        self.protected = dirs;
        self
    }

    /// Die Engine – für Scans **außerhalb** der Sperre des Dienst-Zustands.
    #[must_use]
    pub fn engine(&self) -> Arc<Engine> {
        Arc::clone(&self.engine)
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
                Ok(()) => scan_as_user(&self.engine, &paths, user),
                Err(e) => Response::error("input", e),
            },
            Request::ListQuarantine {} => match self.vault.list() {
                Ok(entries) => Response::Quarantine { entries },
                Err(e) => Response::error("quarantine", e.to_string()),
            },
            Request::ProposeQuarantine { paths } => match self.check_paths(&paths) {
                Ok(()) => match examine_as_user(&self.engine, &paths, user) {
                    Ok(findings) => self.propose_quarantine(&paths, &findings),
                    Err(e) => e,
                },
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
            } => self.decide(plan_id, &digest, &nonce, decision, &dialog_id, user),
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
        let now = self.gate.clock().now();
        self.recent_proposals
            .retain(|t| now - *t < Duration::minutes(1));
        if self.proposals.len() >= MAX_OPEN_PROPOSALS
            || self.recent_proposals.len() >= MAX_PROPOSALS_PER_MINUTE
        {
            return Response::error(
                "busy",
                "Zu viele offene Vorschläge – bitte zuerst die vorhandenen beantworten",
            );
        }
        self.recent_proposals.push(now);
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

    /// Legt einen Quarantäne-Vorschlag an; `findings` stammen aus [`examine_as_user`]
    /// (außerhalb der Sperre geprüft).
    pub fn propose_quarantine(&mut self, paths: &[PathBuf], findings: &[Finding]) -> Response {
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
            Ok(plan) => self.register(plan),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    fn propose_entry(&mut self, kind: ActionKind, entry_id: &str) -> Response {
        let entry = match self.vault.entry(entry_id) {
            Ok(e) => e,
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
        user: &dyn UserAccess,
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
            Ok(Outcome::Approved(approval)) => self.execute_approved(approval, &plan, user),
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
                    if !self.audit_before_execution() {
                        drop(permit);
                        return audit_unavailable();
                    }
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

fn audit_unavailable() -> Response {
    Response::error(
        "audit",
        "Prüfprotokoll nicht schreibbar – aus Sicherheitsgründen wird nichts ausgeführt",
    )
}

/// Scannt mit den Rechten des Nutzers (sieht nur, was er selbst lesen darf).
pub fn scan_as_user(engine: &Engine, paths: &[PathBuf], user: &dyn UserAccess) -> Response {
    match user.enter() {
        Ok(_scope) => Response::ScanReport {
            report: Box::new(engine.scan_paths(paths)),
        },
        Err(e) => identity_error(&e),
    }
}

/// Prüft Dateien für einen Vorschlag mit den Rechten des Nutzers.
///
/// # Errors
/// Fertige Fehler-Antwort, wenn der Identitätswechsel scheitert.
pub fn examine_as_user(
    engine: &Engine,
    paths: &[PathBuf],
    user: &dyn UserAccess,
) -> Result<Vec<Finding>, Response> {
    let _scope = user.enter().map_err(|e| identity_error(&e))?;
    Ok(paths.iter().map(|p| engine.scan_file(p)).collect())
}

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
