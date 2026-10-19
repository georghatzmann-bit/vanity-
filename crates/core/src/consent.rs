//! Das Freigabe-Tor: Nur eine ausdrückliche Nutzerentscheidung „Ja, ausführen“ für genau
//! einen Plan ergibt eine Berechtigung.
//!
//! # Ablauf
//!
//! ```text
//!  ActionPlan ──propose──► ConsentGate (ausstehend, Frist: decision_ttl, Standard 10 min)
//!                              │  keine Antwort → verfällt, es passiert nichts
//!  UI: Ja / Nein / Ignorieren / Vertrauen
//!                              │
//!            decide(id, digest, decision, origin)   ← jede Antwort verbraucht den Plan
//!                              │
//!   Execute ──► Approval (kurzes Ausführungsfenster, Standard 2 min)
//!   Decline ──► nichts         Ignore ──► nichts         Trust ──► TrustGrant
//!                              │
//!            approval.redeem(&plan, clock) ──► ExecutionPermit ──► Ausführer (als Wert)
//! ```
//!
//! In Code (mit der Test-Uhr; im Dienst `ConsentGate::new` mit Systemuhr):
//!
//! ```
//! use aegis_core::audit::ExecutionResult;
//! use aegis_core::consent::{Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, Outcome};
//! use aegis_core::plan::ActionKind;
//! use aegis_core::testing::{ManualClock, sample_plan};
//!
//! let clock = ManualClock::default();
//! let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default())?;
//! let plan = sample_plan(ActionKind::Quarantine, clock.now())?;
//! let ticket = gate.propose(plan.clone())?; // UI zeigt Plan + Prüfsumme
//! let outcome = gate.decide(
//!     ticket.id,
//!     &ticket.digest,
//!     Decision::Execute,
//!     DecisionOrigin::ui_dialog("dialog-1"),
//! )?;
//! let Outcome::Approved(approval) = outcome else {
//!     return Ok(()); // Nein / Ignorieren / Vertrauen: nichts ausführen
//! };
//! let permit = approval.redeem(&plan, gate.clock())?; // Freigabe ist jetzt verbraucht
//! // … der Ausführer bekommt `permit` als Wert und liest Ziele nur aus `permit.plan()` …
//! let executed = permit.complete(ExecutionResult::Succeeded); // → Prüfprotokoll
//! # let _ = executed;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Endgültiges Löschen (zweite, getrennte Bestätigung)
//!
//! Eine [`Approval`] für [`ActionKind::DeletePermanently`] lässt sich nicht direkt
//! einlösen ([`ConsentError::RequiresSecondConfirmation`]). Stattdessen:
//!
//! 1. [`ConsentGate::request_second_confirmation`]`(&approval)` – erzeugt eine
//!    [`SecondConfirmationChallenge`] mit `not_before` (frühestens
//!    [`ConsentConfig::second_confirmation_delay`], Standard und Minimum 1,5 s später) und
//!    `expires_at`. Die UI zeigt daraufhin einen **eigenen**, zweiten Dialog.
//! 2. [`ConsentGate::confirm_second`]`(approval, challenge_id, decision, origin)` –
//!    verbraucht Freigabe **und** Rückfrage. Nur [`Decision::Execute`] im Fenster
//!    `[not_before, expires_at)` ergibt eine [`PermanentDeleteApproval`]; jede andere
//!    Antwort oder Zeit schlägt fehl, und es wird nichts gelöscht.
//! 3. [`PermanentDeleteApproval::redeem`]`(&plan, clock)` ergibt die [`ExecutionPermit`].
//!
//! # Prüfprotokoll
//!
//! Das Tor schreibt selbst keine Dateien. Jede Zustandsänderung (Vorlage, Entscheidung,
//! Ablehnung, Verfall, zweite Bestätigung) wird als [`TimedEvent`] gesammelt; der Dienst
//! holt sie nach jedem Aufruf mit [`ConsentGate::take_audit_events`] ab und schreibt sie in
//! das [`crate::audit::AuditLog`]. Die Ausführung selbst protokolliert der Ausführer über
//! [`ExecutionPermit::complete`].

mod tokens;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::audit::{AuditEvent, TimedEvent};
use crate::plan::{ActionKind, ActionPlan, PlanDigest, PlanId};

pub use tokens::{
    Approval, ExecutionPermit, PermanentDeleteApproval, SecondConfirmation, TrustGrant,
};

/// Höchstlänge einer Dialog-Kennung in [`DecisionOrigin`].
pub const MAX_DIALOG_ID_BYTES: usize = 128;

/// Kleinste erlaubte Wartezeit vor der zweiten Bestätigung (1,5 s).
pub const MIN_SECOND_CONFIRMATION_DELAY: Duration = Duration::milliseconds(1500);

/// Größtes erlaubtes Ausführungsfenster einer Freigabe (15 min).
pub const MAX_EXECUTION_WINDOW: Duration = Duration::minutes(15);

// ---------------------------------------------------------------------------------------
// Entscheidung und Herkunft
// ---------------------------------------------------------------------------------------

/// Antwort des Nutzers auf einen Plan – genau das, was die UI schickt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// „Ja, ausführen“ – die einzige Antwort, die zu einer [`Approval`] führt.
    Execute,
    /// „Nein“ – nichts passiert.
    Decline,
    /// „Ignorieren“ – nichts passiert (der Fund wird nicht weiter gemeldet).
    Ignore,
    /// „Vertrauen“ – nichts wird ausgeführt; es entsteht nur ein [`TrustGrant`].
    Trust,
}

impl Decision {
    /// Alle Antworten.
    pub const ALL: [Self; 4] = [Self::Execute, Self::Decline, Self::Ignore, Self::Trust];

    /// Beschriftung des Knopfs (deutsch).
    #[must_use]
    pub const fn label_de(self) -> &'static str {
        match self {
            Self::Execute => "Ja, ausführen",
            Self::Decline => "Nein",
            Self::Ignore => "Ignorieren",
            Self::Trust => "Vertrauen",
        }
    }

    /// Beschriftung des Knopfs (englisch).
    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::Execute => "Yes, execute",
            Self::Decline => "No",
            Self::Ignore => "Ignore",
            Self::Trust => "Trust",
        }
    }
}

impl fmt::Display for Decision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label_de())
    }
}

/// Woher eine Entscheidung stammt – für das Prüfprotokoll.
///
/// Belegt, dass die Antwort aus einem interaktiven Dialog kam. Die Angabe wird von der UI
/// geliefert und ist **keine** Authentifizierung (die leistet die Pipe-Zugriffsprüfung des
/// Dienstes); sie macht im Protokoll nachvollziehbar, welcher Dialog geantwortet hat.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[non_exhaustive]
pub enum DecisionOrigin {
    /// Interaktiver Bestätigungsdialog der UI.
    #[non_exhaustive]
    UiDialog {
        /// Kennung des Dialogs bzw. der UI-Sitzung (1–128 Zeichen aus `A–Z a–z 0–9 - _ . :`).
        dialog_id: String,
    },
}

impl DecisionOrigin {
    /// Entscheidung aus dem UI-Dialog mit der angegebenen Kennung.
    #[must_use]
    pub fn ui_dialog(dialog_id: impl Into<String>) -> Self {
        Self::UiDialog {
            dialog_id: dialog_id.into(),
        }
    }

    fn validate(&self) -> Result<(), ConsentError> {
        match self {
            Self::UiDialog { dialog_id } => {
                if dialog_id.trim().is_empty() {
                    return Err(ConsentError::InvalidOrigin("Dialog-Kennung ist leer"));
                }
                if dialog_id.len() > MAX_DIALOG_ID_BYTES {
                    return Err(ConsentError::InvalidOrigin("Dialog-Kennung ist zu lang"));
                }
                // Bewusst eng: keine Steuer- oder Bidi-Zeichen, die das Protokoll verfälschen.
                if !dialog_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
                {
                    return Err(ConsentError::InvalidOrigin(
                        "Dialog-Kennung darf nur A–Z, a–z, 0–9, „-“, „_“, „.“ und „:“ enthalten",
                    ));
                }
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Uhr
// ---------------------------------------------------------------------------------------

/// Versiegelung von [`Clock`]: Nur `aegis-core` kann Uhren bereitstellen.
pub(crate) mod sealed {
    /// Nicht außerhalb von `aegis-core` implementierbar.
    pub trait Sealed {}
}

/// Zeitquelle des Freigabe-Tors und beim Einlösen von Freigaben.
///
/// Der Trait ist **versiegelt**: Außerhalb von `aegis-core` gibt es nur [`SystemClock`] und
/// – ausschließlich mit dem Test-Feature `testing` – `aegis_core::testing::ManualClock`.
/// So kann Produktionscode Fristen (Antwortfrist, Ausführungsfenster, Wartezeit der
/// zweiten Bestätigung) nicht mit einer selbst gebauten Uhr aushebeln.
pub trait Clock: sealed::Sealed {
    /// Aktuelle Zeit.
    fn now(&self) -> OffsetDateTime;
}

impl sealed::Sealed for SystemClock {}

/// Systemuhr (UTC).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

// ---------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------

/// Fristen und Grenzen des Freigabe-Tors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsentConfig {
    /// Wie lange ein Plan auf eine Antwort wartet (Standard 10 min). Danach verfällt er
    /// ohne Wirkung.
    pub decision_ttl: Duration,
    /// Wie lange eine Freigabe eingelöst werden kann (Standard 2 min, höchstens 15 min).
    pub execution_window: Duration,
    /// Mindestabstand zwischen erster und zweiter Bestätigung beim endgültigen Löschen
    /// (Standard und Minimum 1,5 s).
    pub second_confirmation_delay: Duration,
    /// Wie lange die zweite Rückfrage ab ihrer Anforderung gilt (Standard 2 min).
    pub second_confirmation_ttl: Duration,
    /// Höchstzahl gleichzeitig ausstehender Pläne (Standard 10 000).
    pub max_pending: usize,
}

impl Default for ConsentConfig {
    fn default() -> Self {
        Self {
            decision_ttl: Duration::minutes(10),
            execution_window: Duration::minutes(2),
            second_confirmation_delay: MIN_SECOND_CONFIRMATION_DELAY,
            second_confirmation_ttl: Duration::minutes(2),
            max_pending: 10_000,
        }
    }
}

impl ConsentConfig {
    /// Prüft die Einstellungen.
    ///
    /// # Errors
    /// [`ConsentError::InvalidConfig`] mit Begründung.
    pub fn validate(&self) -> Result<(), ConsentError> {
        if !self.decision_ttl.is_positive() {
            return Err(ConsentError::InvalidConfig(
                "Antwortfrist muss größer als 0 sein",
            ));
        }
        if !self.execution_window.is_positive() || self.execution_window > MAX_EXECUTION_WINDOW {
            return Err(ConsentError::InvalidConfig(
                "Ausführungsfenster muss zwischen 0 und 15 Minuten liegen",
            ));
        }
        if self.second_confirmation_delay < MIN_SECOND_CONFIRMATION_DELAY {
            return Err(ConsentError::InvalidConfig(
                "Wartezeit vor der zweiten Bestätigung muss mindestens 1,5 s betragen",
            ));
        }
        if self.second_confirmation_ttl <= self.second_confirmation_delay {
            return Err(ConsentError::InvalidConfig(
                "Frist der zweiten Bestätigung muss länger als die Wartezeit sein",
            ));
        }
        if self.max_pending == 0 {
            return Err(ConsentError::InvalidConfig(
                "Mindestens ein ausstehender Plan muss möglich sein",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Kennungen, Tickets, Ergebnisse
// ---------------------------------------------------------------------------------------

/// Kennung einer zweiten Rückfrage (geht an die UI und kommt mit der Antwort zurück).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChallengeId(Uuid);

impl ChallengeId {
    fn new_random() -> Self {
        Self(Uuid::new_v4())
    }

    /// Zugrunde liegende UUID.
    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl fmt::Display for ChallengeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0.hyphenated(), f)
    }
}

impl FromStr for ChallengeId {
    type Err = ConsentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s)
            .map(Self)
            .map_err(|_| ConsentError::InvalidChallengeId)
    }
}

/// Zufällige Einmal-Kennung einer Freigabe (bindet die zweite Rückfrage an genau eine
/// Freigabe).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ApprovalNonce(Uuid);

/// Zufällige Kennung eines Freigabe-Tors (eine Freigabe gilt nur bei ihrem Aussteller).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct GateId(Uuid);

/// Quittung für einen vorgelegten Plan – geht zusammen mit dem Plan an die UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalTicket {
    /// Plan-ID.
    pub id: PlanId,
    /// Prüfsumme, die die UI mit der Entscheidung zurückschicken muss.
    pub digest: PlanDigest,
    /// Zeitpunkt der Vorlage.
    #[serde(with = "time::serde::rfc3339")]
    pub proposed_at: OffsetDateTime,
    /// Ohne Antwort bis hierhin (ausschließlich) verfällt der Plan.
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

/// Ein ausstehender Plan mit seiner Quittung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingPlan {
    plan: ActionPlan,
    ticket: ProposalTicket,
}

impl PendingPlan {
    /// Der Plan.
    #[must_use]
    pub const fn plan(&self) -> &ActionPlan {
        &self.plan
    }

    /// Die Quittung.
    #[must_use]
    pub const fn ticket(&self) -> &ProposalTicket {
        &self.ticket
    }
}

/// Zweite Rückfrage vor endgültigem Löschen – geht an die UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecondConfirmationChallenge {
    /// Kennung, die mit der Antwort zurückkommen muss.
    pub challenge_id: ChallengeId,
    /// Betroffener Plan.
    pub plan_id: PlanId,
    /// Frühester Zeitpunkt der zweiten Bestätigung (einschließlich).
    #[serde(with = "time::serde::rfc3339")]
    pub not_before: OffsetDateTime,
    /// Ende der Frist (ausschließlich).
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

/// Ergebnis von [`ConsentGate::decide`].
#[derive(Debug)]
#[must_use = "Das Ergebnis einer Entscheidung muss ausgewertet werden"]
pub enum Outcome {
    /// „Ja, ausführen“ – Freigabe für genau diesen Plan.
    Approved(Approval),
    /// „Nein“ – nichts passiert.
    Declined,
    /// „Ignorieren“ – nichts passiert.
    Ignored,
    /// „Vertrauen“ – nichts wird ausgeführt; nur die Vertrauensliste darf ergänzt werden.
    Trusted(TrustGrant),
}

// ---------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------

/// Fehler des Freigabe-Tors. In **jedem** Fehlerfall gilt: Es wird nichts ausgeführt.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ConsentError {
    /// Plan ist unbekannt.
    #[error("Unbekannter Plan {0} – es wird nichts ausgeführt")]
    UnknownPlan(PlanId),
    /// Plan-ID wurde schon einmal vorgelegt.
    #[error("Plan {0} wurde bereits vorgelegt – jede Plan-ID gilt nur einmal")]
    DuplicatePlan(PlanId),
    /// Zu viele ausstehende Pläne.
    #[error("Zu viele offene Pläne (höchstens {limit}) – neuer Plan abgelehnt")]
    TooManyPending {
        /// Obergrenze.
        limit: usize,
    },
    /// Prüfsumme passt nicht zum Plan.
    #[error("Prüfsumme passt nicht zu Plan {0} – es wird nichts ausgeführt")]
    DigestMismatch(PlanId),
    /// Plan ist abgelaufen.
    #[error("Plan {0} ist abgelaufen – es wird nichts ausgeführt")]
    Expired(PlanId),
    /// Über den Plan wurde bereits entschieden.
    #[error("Über Plan {0} wurde bereits entschieden – jede Entscheidung gilt nur einmal")]
    AlreadyDecided(PlanId),
    /// Herkunftsangabe ungültig.
    #[error("Herkunft der Entscheidung ist ungültig: {0}")]
    InvalidOrigin(&'static str),
    /// Konfiguration ungültig.
    #[error("Ungültige Einstellung des Freigabe-Tors: {0}")]
    InvalidConfig(&'static str),
    /// Zeitberechnung außerhalb des darstellbaren Bereichs.
    #[error("Zeitberechnung außerhalb des gültigen Bereichs – es wird nichts ausgeführt")]
    TimeOverflow,
    /// Freigabe gilt für einen anderen Plan.
    #[error("Freigabe gilt für Plan {expected}, nicht für Plan {actual}")]
    PlanMismatch {
        /// Plan der Freigabe.
        expected: PlanId,
        /// Vorgelegter Plan.
        actual: PlanId,
    },
    /// Freigabe ist abgelaufen.
    #[error("Freigabe für Plan {0} ist abgelaufen – bitte erneut bestätigen")]
    ApprovalExpired(PlanId),
    /// Freigabe ist (noch) nicht gültig – die Uhr ist zurückgesprungen.
    #[error("Freigabe für Plan {0} ist noch nicht gültig (Uhrzeit zurückgesprungen?)")]
    ApprovalNotYetValid(PlanId),
    /// Endgültiges Löschen braucht die zweite Bestätigung.
    #[error("Endgültiges Löschen (Plan {0}) braucht eine zweite, getrennte Bestätigung")]
    RequiresSecondConfirmation(PlanId),
    /// Zweite Bestätigung ist für diesen Plan nicht vorgesehen.
    #[error("Plan {0} braucht keine zweite Bestätigung")]
    SecondConfirmationNotRequired(PlanId),
    /// Zweite Bestätigung für diese Freigabe wurde schon angefordert.
    #[error("Die zweite Bestätigung für Plan {0} wurde bereits angefordert")]
    SecondConfirmationAlreadyRequested(PlanId),
    /// Freigabe stammt von einem anderen Freigabe-Tor.
    #[error("Die Freigabe stammt nicht von diesem Freigabe-Tor")]
    ForeignApproval,
    /// Rückfrage unbekannt (oder bereits verbraucht/verfallen).
    #[error("Unbekannte zweite Rückfrage {0} – es wird nichts gelöscht")]
    UnknownChallenge(ChallengeId),
    /// Rückfrage-Kennung nicht lesbar.
    #[error("Die Kennung der zweiten Rückfrage ist ungültig")]
    InvalidChallengeId,
    /// Rückfrage gehört zu einer anderen Freigabe.
    #[error("Die zweite Rückfrage {0} gehört nicht zu dieser Freigabe – es wird nichts gelöscht")]
    ChallengeMismatch(ChallengeId),
    /// Zweite Bestätigung kam zu früh.
    #[error(
        "Zweite Bestätigung für Plan {plan_id} kam zu früh (frühestens {not_before}) – es wird nichts gelöscht"
    )]
    SecondConfirmationTooEarly {
        /// Plan.
        plan_id: PlanId,
        /// Frühester erlaubter Zeitpunkt.
        not_before: OffsetDateTime,
    },
    /// Zweite Bestätigung kam zu spät.
    #[error("Zweite Bestätigung für Plan {0} kam zu spät – es wird nichts gelöscht")]
    SecondConfirmationExpired(PlanId),
    /// Zweite Bestätigung wurde nicht erteilt.
    #[error(
        "Zweite Bestätigung für Plan {plan_id} nicht erteilt („{decision}“) – es wird nichts gelöscht"
    )]
    SecondConfirmationDeclined {
        /// Plan.
        plan_id: PlanId,
        /// Gegebene Antwort.
        decision: Decision,
    },
    /// Erlaubnis gilt für eine andere Aktion.
    #[error("Erlaubnis gilt für „{actual}“, nicht für „{expected}“")]
    WrongKind {
        /// Erwartete Aktion.
        expected: ActionKind,
        /// Tatsächliche Aktion.
        actual: ActionKind,
    },
}

// ---------------------------------------------------------------------------------------
// Freigabe-Tor
// ---------------------------------------------------------------------------------------

/// Warum eine Plan-ID nicht mehr aussteht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retired {
    /// Gültige Entscheidung erfasst.
    Decided,
    /// Ohne Antwort verfallen (oder Antwort kam zu spät).
    Expired,
    /// Antwort verworfen (falsche Prüfsumme, ungültige Herkunft …).
    Rejected,
}

#[derive(Debug, Clone)]
struct PendingChallenge {
    plan_id: PlanId,
    digest: PlanDigest,
    nonce: ApprovalNonce,
    not_before: OffsetDateTime,
    expires_at: OffsetDateTime,
}

/// Das Freigabe-Tor (siehe Modul-Doku).
///
/// Invarianten:
/// * Jede Plan-ID wird genau einmal angenommen und genau einmal beantwortet; jede Antwort
///   – auch eine fehlerhafte – verbraucht den Plan.
/// * Nur [`Decision::Execute`] mit passender Prüfsumme vor Fristende ergibt eine
///   [`Approval`].
/// * Unbeantwortete Pläne verfallen ohne Wirkung.
///
/// Speicherbedarf: Verbrauchte Plan-IDs werden dauerhaft gemerkt (Schutz vor erneuter
/// Vorlage), etwa 50 Byte pro Plan.
#[derive(Debug)]
pub struct ConsentGate<C: Clock = SystemClock> {
    clock: C,
    config: ConsentConfig,
    gate_id: GateId,
    pending: BTreeMap<PlanId, PendingPlan>,
    retired: BTreeMap<PlanId, Retired>,
    challenges: BTreeMap<ChallengeId, PendingChallenge>,
    challenged: BTreeSet<ApprovalNonce>,
    audit: Vec<TimedEvent>,
}

impl ConsentGate<SystemClock> {
    /// Freigabe-Tor mit Systemuhr.
    ///
    /// # Errors
    /// [`ConsentError::InvalidConfig`], wenn `config` ungültig ist.
    pub fn new(config: ConsentConfig) -> Result<Self, ConsentError> {
        Self::with_clock(SystemClock, config)
    }
}

impl<C: Clock> ConsentGate<C> {
    /// Freigabe-Tor mit eigener Uhr (Tests: `ManualClock`).
    ///
    /// # Errors
    /// [`ConsentError::InvalidConfig`], wenn `config` ungültig ist.
    pub fn with_clock(clock: C, config: ConsentConfig) -> Result<Self, ConsentError> {
        config.validate()?;
        Ok(Self {
            clock,
            config,
            gate_id: GateId(Uuid::new_v4()),
            pending: BTreeMap::new(),
            retired: BTreeMap::new(),
            challenges: BTreeMap::new(),
            challenged: BTreeSet::new(),
            audit: Vec::new(),
        })
    }

    /// Die Uhr des Tors (für [`Approval::redeem`]).
    pub const fn clock(&self) -> &C {
        &self.clock
    }

    /// Die Konfiguration.
    pub const fn config(&self) -> &ConsentConfig {
        &self.config
    }

    /// Legt einen Plan zur Entscheidung vor.
    ///
    /// # Errors
    /// * [`ConsentError::DuplicatePlan`] – ID ist ausstehend oder wurde schon verbraucht,
    /// * [`ConsentError::TooManyPending`] – Obergrenze erreicht,
    /// * [`ConsentError::TimeOverflow`].
    pub fn propose(&mut self, plan: ActionPlan) -> Result<ProposalTicket, ConsentError> {
        let id = plan.id();
        if self.pending.contains_key(&id) || self.retired.contains_key(&id) {
            return Err(ConsentError::DuplicatePlan(id));
        }
        if self.pending.len() >= self.config.max_pending {
            self.expire_stale();
            if self.pending.len() >= self.config.max_pending {
                return Err(ConsentError::TooManyPending {
                    limit: self.config.max_pending,
                });
            }
        }
        let now = self.clock.now();
        let expires_at = now
            .checked_add(self.config.decision_ttl)
            .ok_or(ConsentError::TimeOverflow)?;
        let ticket = ProposalTicket {
            id,
            digest: plan.digest(),
            proposed_at: now,
            expires_at,
        };
        self.record(
            now,
            AuditEvent::PlanProposed {
                plan_id: id,
                digest: ticket.digest,
                kind: plan.kind(),
                severity: plan.severity(),
                what: plan.what().to_owned(),
                targets: plan.targets().to_vec(),
                expires_at,
            },
        );
        self.pending.insert(
            id,
            PendingPlan {
                plan,
                ticket: ticket.clone(),
            },
        );
        Ok(ticket)
    }

    /// Nimmt die Entscheidung des Nutzers entgegen. **Verbraucht den Plan in jedem Fall**
    /// (auch bei falscher Prüfsumme, ungültiger Herkunft oder Fristablauf).
    ///
    /// # Errors
    /// * [`ConsentError::UnknownPlan`] – ID nie vorgelegt,
    /// * [`ConsentError::AlreadyDecided`] – bereits beantwortet (Wiederholung),
    /// * [`ConsentError::Expired`] – Frist abgelaufen, nichts wird gewährt,
    /// * [`ConsentError::DigestMismatch`] – Prüfsumme passt nicht,
    /// * [`ConsentError::InvalidOrigin`], [`ConsentError::TimeOverflow`].
    pub fn decide(
        &mut self,
        id: PlanId,
        digest: &PlanDigest,
        decision: Decision,
        origin: DecisionOrigin,
    ) -> Result<Outcome, ConsentError> {
        let Some(entry) = self.pending.remove(&id) else {
            return Err(match self.retired.get(&id) {
                None => ConsentError::UnknownPlan(id),
                Some(Retired::Expired) => ConsentError::Expired(id),
                Some(Retired::Decided | Retired::Rejected) => ConsentError::AlreadyDecided(id),
            });
        };
        let now = self.clock.now();
        if now >= entry.ticket.expires_at {
            self.retire(id, Retired::Expired);
            self.record(now, AuditEvent::PlanExpired { plan_id: id });
            return Err(ConsentError::Expired(id));
        }
        if entry.ticket.digest != *digest {
            return Err(self.reject(now, id, ConsentError::DigestMismatch(id)));
        }
        if let Err(err) = origin.validate() {
            return Err(self.reject(now, id, err));
        }
        let event = AuditEvent::DecisionRecorded {
            plan_id: id,
            digest: entry.ticket.digest,
            decision,
            origin: origin.clone(),
        };
        let outcome = match decision {
            Decision::Execute => {
                let Some(expires_at) = now.checked_add(self.config.execution_window) else {
                    return Err(self.reject(now, id, ConsentError::TimeOverflow));
                };
                Outcome::Approved(Approval::new(
                    id,
                    entry.ticket.digest,
                    entry.plan.kind(),
                    now,
                    expires_at,
                    ApprovalNonce(Uuid::new_v4()),
                    self.gate_id,
                    origin,
                ))
            }
            Decision::Decline => Outcome::Declined,
            Decision::Ignore => Outcome::Ignored,
            Decision::Trust => Outcome::Trusted(TrustGrant::new(&entry.plan, now, origin)),
        };
        self.retire(id, Retired::Decided);
        self.record(now, event);
        Ok(outcome)
    }

    /// Entfernt alle abgelaufenen Pläne und zweiten Rückfragen (ohne Wirkung) und liefert
    /// die IDs der betroffenen Pläne (sortiert, ohne Duplikate).
    pub fn expire_stale(&mut self) -> Vec<PlanId> {
        let now = self.clock.now();
        let stale_plans: Vec<PlanId> = self
            .pending
            .iter()
            .filter(|(_, entry)| now >= entry.ticket.expires_at)
            .map(|(id, _)| *id)
            .collect();
        let mut expired = Vec::with_capacity(stale_plans.len());
        for id in stale_plans {
            self.pending.remove(&id);
            self.retire(id, Retired::Expired);
            self.record(now, AuditEvent::PlanExpired { plan_id: id });
            expired.push(id);
        }
        let stale_challenges: Vec<ChallengeId> = self
            .challenges
            .iter()
            .filter(|(_, ch)| now >= ch.expires_at)
            .map(|(id, _)| *id)
            .collect();
        for challenge_id in stale_challenges {
            if let Some(ch) = self.challenges.remove(&challenge_id) {
                self.record(
                    now,
                    AuditEvent::SecondConfirmationExpired {
                        plan_id: ch.plan_id,
                        challenge_id,
                    },
                );
                expired.push(ch.plan_id);
            }
        }
        expired.sort_unstable();
        expired.dedup();
        expired
    }

    /// Alle noch beantwortbaren Pläne (abgelaufene werden nicht mehr angezeigt).
    pub fn pending(&self) -> impl Iterator<Item = &PendingPlan> {
        let now = self.clock.now();
        self.pending
            .values()
            .filter(move |entry| now < entry.ticket.expires_at)
    }

    /// Ein noch beantwortbarer Plan.
    #[must_use]
    pub fn get_pending(&self, id: PlanId) -> Option<&PendingPlan> {
        let now = self.clock.now();
        self.pending
            .get(&id)
            .filter(|entry| now < entry.ticket.expires_at)
    }

    /// Fordert für eine Freigabe zum endgültigen Löschen die zweite, getrennte Bestätigung
    /// an. Die Freigabe wird dabei nur angesehen, nicht verbraucht.
    ///
    /// # Errors
    /// * [`ConsentError::SecondConfirmationNotRequired`] – keine Lösch-Freigabe,
    /// * [`ConsentError::ForeignApproval`] – Freigabe von einem anderen Tor,
    /// * [`ConsentError::ApprovalExpired`] / [`ConsentError::ApprovalNotYetValid`],
    /// * [`ConsentError::SecondConfirmationAlreadyRequested`] – nur eine Rückfrage je Freigabe,
    /// * [`ConsentError::TimeOverflow`].
    pub fn request_second_confirmation(
        &mut self,
        approval: &Approval,
    ) -> Result<SecondConfirmationChallenge, ConsentError> {
        let plan_id = approval.plan_id();
        if !approval.requires_second_confirmation() {
            return Err(ConsentError::SecondConfirmationNotRequired(plan_id));
        }
        if approval.issuer() != self.gate_id {
            return Err(ConsentError::ForeignApproval);
        }
        let now = self.clock.now();
        if now < approval.approved_at() {
            return Err(ConsentError::ApprovalNotYetValid(plan_id));
        }
        if now >= approval.expires_at() {
            return Err(ConsentError::ApprovalExpired(plan_id));
        }
        if self.challenged.contains(&approval.nonce()) {
            return Err(ConsentError::SecondConfirmationAlreadyRequested(plan_id));
        }
        let not_before = now
            .checked_add(self.config.second_confirmation_delay)
            .ok_or(ConsentError::TimeOverflow)?;
        let expires_at = now
            .checked_add(self.config.second_confirmation_ttl)
            .ok_or(ConsentError::TimeOverflow)?;
        let challenge_id = ChallengeId::new_random();
        self.challenged.insert(approval.nonce());
        self.challenges.insert(
            challenge_id,
            PendingChallenge {
                plan_id,
                digest: approval.digest(),
                nonce: approval.nonce(),
                not_before,
                expires_at,
            },
        );
        self.record(
            now,
            AuditEvent::SecondConfirmationRequested {
                plan_id,
                challenge_id,
                not_before,
                expires_at,
            },
        );
        Ok(SecondConfirmationChallenge {
            challenge_id,
            plan_id,
            not_before,
            expires_at,
        })
    }

    /// Nimmt die zweite Bestätigung entgegen. Verbraucht **immer** Freigabe und Rückfrage.
    /// Nur [`Decision::Execute`] im Fenster `[not_before, expires_at)` ergibt eine
    /// [`PermanentDeleteApproval`].
    ///
    /// # Errors
    /// * [`ConsentError::UnknownChallenge`] – unbekannt, verbraucht oder verfallen,
    /// * [`ConsentError::ForeignApproval`], [`ConsentError::ChallengeMismatch`],
    /// * [`ConsentError::InvalidOrigin`],
    /// * [`ConsentError::SecondConfirmationTooEarly`] / [`ConsentError::SecondConfirmationExpired`],
    /// * [`ConsentError::SecondConfirmationDeclined`] – jede Antwort außer „Ja, ausführen“,
    /// * [`ConsentError::TimeOverflow`].
    pub fn confirm_second(
        &mut self,
        approval: Approval,
        challenge_id: ChallengeId,
        decision: Decision,
        origin: DecisionOrigin,
    ) -> Result<PermanentDeleteApproval, ConsentError> {
        let Some(challenge) = self.challenges.remove(&challenge_id) else {
            return Err(ConsentError::UnknownChallenge(challenge_id));
        };
        let plan_id = challenge.plan_id;
        let now = self.clock.now();
        let failure = if approval.issuer() != self.gate_id {
            Some(ConsentError::ForeignApproval)
        } else if challenge.nonce != approval.nonce()
            || challenge.plan_id != approval.plan_id()
            || challenge.digest != approval.digest()
        {
            Some(ConsentError::ChallengeMismatch(challenge_id))
        } else if let Err(err) = origin.validate() {
            Some(err)
        } else if now < challenge.not_before {
            Some(ConsentError::SecondConfirmationTooEarly {
                plan_id,
                not_before: challenge.not_before,
            })
        } else if now >= challenge.expires_at {
            Some(ConsentError::SecondConfirmationExpired(plan_id))
        } else {
            None
        };
        if let Some(err) = failure {
            self.record(
                now,
                AuditEvent::SecondConfirmationRejected {
                    plan_id,
                    challenge_id,
                    reason: err.to_string(),
                },
            );
            return Err(err);
        }

        self.record(
            now,
            AuditEvent::SecondConfirmationRecorded {
                plan_id,
                challenge_id,
                decision,
                origin: origin.clone(),
            },
        );
        if decision != Decision::Execute {
            return Err(ConsentError::SecondConfirmationDeclined { plan_id, decision });
        }
        let expires_at = now
            .checked_add(self.config.execution_window)
            .ok_or(ConsentError::TimeOverflow)?;
        Ok(PermanentDeleteApproval::new(
            plan_id,
            challenge.digest,
            approval.approved_at(),
            approval.origin().clone(),
            SecondConfirmation::new(challenge_id, now, origin),
            expires_at,
        ))
    }

    /// Holt alle seit dem letzten Aufruf gesammelten Protokoll-Ereignisse ab (in
    /// zeitlicher Reihenfolge). Der Dienst schreibt sie in das Prüfprotokoll.
    pub fn take_audit_events(&mut self) -> Vec<TimedEvent> {
        std::mem::take(&mut self.audit)
    }

    fn record(&mut self, at: OffsetDateTime, event: AuditEvent) {
        self.audit.push(TimedEvent { at, event });
    }

    fn retire(&mut self, id: PlanId, reason: Retired) {
        self.retired.insert(id, reason);
    }

    fn reject(&mut self, now: OffsetDateTime, id: PlanId, err: ConsentError) -> ConsentError {
        self.retire(id, Retired::Rejected);
        self.record(
            now,
            AuditEvent::DecisionRejected {
                plan_id: id,
                reason: err.to_string(),
            },
        );
        err
    }
}

#[cfg(test)]
mod tests;
