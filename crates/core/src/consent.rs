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
//!            approval.redeem(&plan, &mut gate) ──► ExecutionPermit ──► Ausführer (als Wert)
//! ```
//!
//! # Wer darf entscheiden?
//!
//! [`ConsentGate::decide`] und [`ConsentGate::confirm_second`] sind die einzigen Stellen,
//! an denen aus einer Antwort eine Freigabe wird. Beide stehen in `clippy.toml` unter
//! `disallowed-methods`: Jeder Aufruf – in jedem Crate, auch in `aegis-core` selbst – braucht
//! eine Markierung `// aegis-consent: <kennung>` und einen Eintrag in
//! `crates/core/mutation-allowlist.txt` (erzwungen vom Test `mutation_guard`). Im Betrieb
//! ist das genau eine Stelle: der Pipe-Handler des Dienstes, der die Antwort aus dem
//! UI-Dialog weiterreicht. Ein „Auto-Quarantäne“- oder Panic-Button-Code, der sich selbst
//! freigibt, fällt so in Clippy und im Security-Review auf. Tests nutzen
//! `aegis_core::testing::user_answers` bzw. `user_confirms_second` (nur mit gestellter Uhr).
//!
//! In Code (mit der Test-Uhr; im Dienst `ConsentGate::new` mit Systemuhr – dort ruft der
//! Pipe-Handler an der markierten Stelle `gate.decide(…)` auf):
//!
//! ```
//! use aegis_core::audit::ExecutionResult;
//! use aegis_core::consent::{Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, Outcome};
//! use aegis_core::plan::ActionKind;
//! use aegis_core::testing::{ManualClock, sample_plan, user_answers};
//!
//! let clock = ManualClock::default();
//! let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default())?;
//! let plan = sample_plan(ActionKind::Quarantine, clock.now())?;
//! let ticket = gate.propose(plan.clone())?; // UI zeigt Plan + Prüfsumme
//! let outcome = user_answers(
//!     &mut gate,
//!     ticket.id,
//!     &ticket.digest,
//!     Decision::Execute,
//!     DecisionOrigin::ui_dialog("dialog-1"),
//! )?;
//! let Outcome::Approved(approval) = outcome else {
//!     return Ok(()); // Nein / Ignorieren / Vertrauen: nichts ausführen
//! };
//! let permit = approval.redeem(&plan, &mut gate)?; // Freigabe ist jetzt verbraucht
//! // … der Ausführer bekommt `permit` als Wert und liest Ziele nur aus `permit.plan()` …
//! let executed = permit.complete(ExecutionResult::Succeeded); // → Prüfprotokoll
//! let mut events = gate.take_audit_events(); // Vorlage, Entscheidung, Einlösen
//! events.push(aegis_core::audit::TimedEvent { at: clock.now(), event: executed });
//! # assert_eq!(events.len(), 4);
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
//!    `expires_at` (spätestens das Ende des Ausführungsfensters der ersten Freigabe – die
//!    erste Freigabe lässt sich nicht über ihre Frist hinaus „verlängern“). Die UI zeigt
//!    daraufhin einen **eigenen**, zweiten Dialog.
//! 2. [`ConsentGate::confirm_second`]`(approval, challenge_id, decision, origin)` –
//!    verbraucht Freigabe **und** Rückfrage. Nur [`Decision::Execute`] im Fenster
//!    `[not_before, expires_at)` ergibt eine [`PermanentDeleteApproval`]; jede andere
//!    Antwort oder Zeit schlägt fehl, und es wird nichts gelöscht. Das zweite „Ja“ öffnet
//!    ein neues, kurzes Ausführungsfenster.
//! 3. [`PermanentDeleteApproval::redeem`]`(&plan, &mut gate)` ergibt die [`ExecutionPermit`].
//!
//! # Prüfprotokoll
//!
//! Das Tor schreibt selbst keine Dateien. Jede Zustandsänderung und jeder abgewiesene
//! Versuch (Vorlage, Entscheidung, Ablehnung – auch unbekannter oder schon beantworteter
//! Pläne –, Verfall, zweite Bestätigung, Einlösen und verweigertes Einlösen, nicht
//! eingelöste Freigaben) wird als [`TimedEvent`] gesammelt; der Dienst holt sie nach jedem
//! Aufruf mit [`ConsentGate::take_audit_events`] ab und schreibt sie in das
//! [`crate::audit::AuditLog`]. Beim Herunterfahren liefert [`ConsentGate::close`] die
//! restlichen Ereignisse und lässt alles Offene protokolliert verfallen. Die Ausführung
//! selbst protokolliert der Ausführer über [`ExecutionPermit::complete`] (Ergebnis ist
//! `#[must_use]`).

mod tokens;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::audit::{AuditEvent, TimedEvent};
use crate::plan::{ActionKind, ActionPlan, PlanDigest, PlanId};
use crate::risk::RiskLevel;

pub use tokens::{
    Approval, ExecutionPermit, PermanentDeleteApproval, SecondConfirmation, TrustGrant,
};

/// Höchstlänge einer Dialog-Kennung in [`DecisionOrigin`].
pub const MAX_DIALOG_ID_BYTES: usize = 128;

/// Kleinste erlaubte Wartezeit vor der zweiten Bestätigung (1,5 s).
pub const MIN_SECOND_CONFIRMATION_DELAY: Duration = Duration::milliseconds(1500);

/// Größte erlaubte Wartezeit vor der zweiten Bestätigung (1 min).
pub const MAX_SECOND_CONFIRMATION_DELAY: Duration = Duration::minutes(1);

/// Größtes erlaubtes Ausführungsfenster einer Freigabe (15 min). Gilt auch für die Frist
/// der zweiten Rückfrage.
pub const MAX_EXECUTION_WINDOW: Duration = Duration::minutes(15);

/// Größte erlaubte Antwortfrist eines Plans (24 h) – „keine Reaktion = Plan verfällt“ muss
/// absehbar gelten.
pub const MAX_DECISION_TTL: Duration = Duration::hours(24);

/// Größte erlaubte Obergrenze gleichzeitig ausstehender Pläne.
pub const MAX_PENDING_LIMIT: usize = 100_000;

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
    /// Wie lange ein Plan auf eine Antwort wartet (Standard 10 min, höchstens 24 h).
    /// Danach verfällt er ohne Wirkung.
    pub decision_ttl: Duration,
    /// Wie lange eine Freigabe eingelöst werden kann (Standard 2 min, höchstens 15 min).
    pub execution_window: Duration,
    /// Mindestabstand zwischen erster und zweiter Bestätigung beim endgültigen Löschen
    /// (Standard und Minimum 1,5 s, höchstens 1 min und kürzer als das Ausführungsfenster).
    pub second_confirmation_delay: Duration,
    /// Wie lange die zweite Rückfrage ab ihrer Anforderung gilt (Standard 2 min, höchstens
    /// 15 min). Sie endet nie später als das Ausführungsfenster der ersten Freigabe.
    pub second_confirmation_ttl: Duration,
    /// Höchstzahl gleichzeitig ausstehender Pläne (Standard 10 000, höchstens 100 000).
    /// Ist sie erreicht, verdrängt ein Plan mit höherem Schweregrad den ältesten Plan mit
    /// dem niedrigsten Schweregrad (der dabei protokolliert verfällt).
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
        if !self.decision_ttl.is_positive() || self.decision_ttl > MAX_DECISION_TTL {
            return Err(ConsentError::InvalidConfig(
                "Antwortfrist muss zwischen 0 und 24 Stunden liegen",
            ));
        }
        if !self.execution_window.is_positive() || self.execution_window > MAX_EXECUTION_WINDOW {
            return Err(ConsentError::InvalidConfig(
                "Ausführungsfenster muss zwischen 0 und 15 Minuten liegen",
            ));
        }
        if self.second_confirmation_delay < MIN_SECOND_CONFIRMATION_DELAY
            || self.second_confirmation_delay > MAX_SECOND_CONFIRMATION_DELAY
        {
            return Err(ConsentError::InvalidConfig(
                "Wartezeit vor der zweiten Bestätigung muss zwischen 1,5 s und 1 Minute liegen",
            ));
        }
        if self.second_confirmation_delay >= self.execution_window {
            return Err(ConsentError::InvalidConfig(
                "Wartezeit vor der zweiten Bestätigung muss kürzer als das Ausführungsfenster sein",
            ));
        }
        if self.second_confirmation_ttl <= self.second_confirmation_delay {
            return Err(ConsentError::InvalidConfig(
                "Frist der zweiten Bestätigung muss länger als die Wartezeit sein",
            ));
        }
        if self.second_confirmation_ttl > MAX_EXECUTION_WINDOW {
            return Err(ConsentError::InvalidConfig(
                "Frist der zweiten Bestätigung darf höchstens 15 Minuten betragen",
            ));
        }
        if self.max_pending == 0 || self.max_pending > MAX_PENDING_LIMIT {
            return Err(ConsentError::InvalidConfig(
                "Zahl der ausstehenden Pläne muss zwischen 1 und 100 000 liegen",
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
    /// Zu viele ausstehende Pläne (und keiner mit niedrigerem Schweregrad, der weichen könnte).
    #[error("Zu viele offene Pläne (höchstens {limit}) – neuer Plan abgelehnt")]
    TooManyPending {
        /// Obergrenze.
        limit: usize,
    },
    /// Der Plan passt nicht ins Prüfprotokoll (zu groß) – er wird nicht vorgelegt.
    #[error("Plan {0} ist zu groß für das Prüfprotokoll – er wird nicht vorgelegt")]
    PlanNotAuditable(PlanId),
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
    /// Ohne Antwort verfallen (oder Antwort kam zu spät, oder verdrängt).
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

/// Eine ausgestellte, noch nicht verbrauchte Freigabe ([`Approval`] oder
/// [`PermanentDeleteApproval`]). Das Tor merkt sie sich, um Einlösen, verweigertes Einlösen
/// und Verfall protokollieren zu können.
#[derive(Debug, Clone, Copy)]
struct IssuedToken {
    plan_id: PlanId,
    expires_at: OffsetDateTime,
}

/// Was eine Freigabe beim Einlösen über sich mitteilt (siehe `ConsentGate::settle_redeem`).
#[derive(Debug, Clone, Copy)]
struct RedeemRequest {
    plan_id: PlanId,
    digest: PlanDigest,
    nonce: ApprovalNonce,
    issuer: GateId,
    valid_from: OffsetDateTime,
    expires_at: OffsetDateTime,
    needs_second_confirmation: bool,
}

/// Das Freigabe-Tor (siehe Modul-Doku).
///
/// Invarianten:
/// * Jede Plan-ID wird genau einmal angenommen und genau einmal beantwortet; jede Antwort
///   – auch eine fehlerhafte – verbraucht den Plan.
/// * Nur [`Decision::Execute`] mit passender Prüfsumme vor Fristende ergibt eine
///   [`Approval`]; nur das Tor, das sie ausgestellt hat, löst sie ein.
/// * Unbeantwortete Pläne und nicht eingelöste Freigaben verfallen ohne Wirkung – und
///   protokolliert.
/// * Jeder abgewiesene Versuch (Antwort, zweite Bestätigung, Einlösen) wird protokolliert.
///
/// Wichtig für den Dienst: Verbrauchte Plan-IDs merkt sich das Tor nur im Speicher. Nach
/// einem Neustart (neues Tor) dürfen daher keine gespeicherten Pläne erneut vorgelegt
/// werden – jeder Plan wird frisch gebaut (neue, zufällige Plan-ID).
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
    issued: BTreeMap<ApprovalNonce, IssuedToken>,
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
            issued: BTreeMap::new(),
            audit: Vec::new(),
        })
    }

    /// Die Uhr des Tors.
    pub const fn clock(&self) -> &C {
        &self.clock
    }

    /// Die Konfiguration.
    pub const fn config(&self) -> &ConsentConfig {
        &self.config
    }

    /// Legt einen Plan zur Entscheidung vor.
    ///
    /// Ist die Obergrenze [`ConsentConfig::max_pending`] erreicht, verdrängt der Plan den
    /// ältesten ausstehenden Plan mit dem niedrigsten Schweregrad – aber nur, wenn dieser
    /// weniger schwer ist (der verdrängte Plan verfällt ohne Wirkung, protokolliert als
    /// [`AuditEvent::PlanExpired`]). So kann eine Flut harmloser Meldungen nie verhindern,
    /// dass der Nutzer nach einem gefährlichen Fund gefragt wird.
    ///
    /// # Errors
    /// * [`ConsentError::DuplicatePlan`] – ID ist ausstehend oder wurde schon verbraucht,
    /// * [`ConsentError::TooManyPending`] – Obergrenze erreicht, nichts Leichteres zu verdrängen,
    /// * [`ConsentError::PlanNotAuditable`] – der Plan passt nicht ins Prüfprotokoll,
    /// * [`ConsentError::TimeOverflow`].
    pub fn propose(&mut self, plan: ActionPlan) -> Result<ProposalTicket, ConsentError> {
        let id = plan.id();
        if self.pending.contains_key(&id) || self.retired.contains_key(&id) {
            return Err(ConsentError::DuplicatePlan(id));
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
        let event = AuditEvent::PlanProposed {
            plan_id: id,
            digest: ticket.digest,
            kind: plan.kind(),
            severity: plan.severity(),
            what: plan.what().to_owned(),
            targets: plan.targets().to_vec(),
            expires_at,
        };
        // Was nicht protokolliert werden kann, wird gar nicht erst vorgelegt.
        if !crate::audit::fits_in_log(&event) {
            return Err(ConsentError::PlanNotAuditable(id));
        }
        if self.pending.len() >= self.config.max_pending {
            self.expire_stale();
            if self.pending.len() >= self.config.max_pending
                && !self.evict_less_severe(plan.severity(), now)
            {
                return Err(ConsentError::TooManyPending {
                    limit: self.config.max_pending,
                });
            }
        }
        self.record(now, event);
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
    /// (auch bei falscher Prüfsumme, ungültiger Herkunft oder Fristablauf). Jeder
    /// abgewiesene Versuch – auch für unbekannte oder schon beantwortete Pläne
    /// (Wiederholung) – wird als [`AuditEvent::DecisionRejected`] protokolliert.
    ///
    /// **Gesperrt per `clippy.toml`:** Nur der Pipe-Handler des Dienstes darf die Antwort
    /// aus dem UI-Dialog hier einreichen (Markierung `// aegis-consent: …` + Eintrag in
    /// `crates/core/mutation-allowlist.txt`). Kein anderer Code „entscheidet“ für den Nutzer.
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
        let now = self.clock.now();
        let Some(entry) = self.pending.remove(&id) else {
            let err = match self.retired.get(&id) {
                None => ConsentError::UnknownPlan(id),
                Some(Retired::Expired) => ConsentError::Expired(id),
                Some(Retired::Decided | Retired::Rejected) => ConsentError::AlreadyDecided(id),
            };
            self.record(
                now,
                AuditEvent::DecisionRejected {
                    plan_id: id,
                    reason: err.to_string(),
                },
            );
            return Err(err);
        };
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
                let nonce = self.issue(id, expires_at);
                Outcome::Approved(Approval::new(
                    id,
                    entry.ticket.digest,
                    entry.plan.kind(),
                    now,
                    expires_at,
                    nonce,
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

    /// Entfernt alle abgelaufenen Pläne, zweiten Rückfragen und nicht eingelösten
    /// Freigaben (ohne Wirkung, jeweils protokolliert) und liefert die IDs der betroffenen
    /// Pläne (sortiert, ohne Duplikate). Eine hier verfallene Freigabe lässt sich danach
    /// auch bei zurückgestellter Uhr nicht mehr einlösen.
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
        let stale_tokens: Vec<ApprovalNonce> = self
            .issued
            .iter()
            .filter(|(_, token)| now >= token.expires_at)
            .map(|(nonce, _)| *nonce)
            .collect();
        for nonce in stale_tokens {
            if let Some(token) = self.issued.remove(&nonce) {
                self.challenged.remove(&nonce);
                self.record(
                    now,
                    AuditEvent::ApprovalExpired {
                        plan_id: token.plan_id,
                    },
                );
                expired.push(token.plan_id);
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
    /// Die Rückfrage endet spätestens mit dem Ausführungsfenster der Freigabe
    /// (`expires_at = min(jetzt + second_confirmation_ttl, approval.expires_at())`); bliebe
    /// danach keine Zeit mehr für die Wartezeit, wird sie gar nicht erst ausgestellt.
    ///
    /// # Errors
    /// * [`ConsentError::SecondConfirmationNotRequired`] – keine Lösch-Freigabe,
    /// * [`ConsentError::ForeignApproval`] – Freigabe von einem anderen Tor,
    /// * [`ConsentError::ApprovalExpired`] / [`ConsentError::ApprovalNotYetValid`] – auch,
    ///   wenn bis zum Fristende keine Zeit mehr für die Wartezeit bleibt,
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
        if now >= approval.expires_at() || !self.issued.contains_key(&approval.nonce()) {
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
            .ok_or(ConsentError::TimeOverflow)?
            .min(approval.expires_at());
        if not_before >= expires_at {
            return Err(ConsentError::ApprovalExpired(plan_id));
        }
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

    /// Nimmt die zweite Bestätigung entgegen. Verbraucht **immer** Freigabe und Rückfrage;
    /// jeder abgewiesene Versuch (auch mit unbekannter Rückfrage) wird als
    /// [`AuditEvent::SecondConfirmationRejected`] protokolliert. Nur [`Decision::Execute`]
    /// im Fenster `[not_before, expires_at)` ergibt eine [`PermanentDeleteApproval`].
    ///
    /// **Gesperrt per `clippy.toml`** wie [`ConsentGate::decide`]: nur der Pipe-Handler des
    /// Dienstes reicht hier die Antwort aus dem zweiten UI-Dialog ein.
    ///
    /// # Errors
    /// * [`ConsentError::UnknownChallenge`] – unbekannt, verbraucht oder verfallen,
    /// * [`ConsentError::ForeignApproval`], [`ConsentError::ChallengeMismatch`],
    /// * [`ConsentError::ApprovalExpired`] – Freigabe schon verfallen (aufgeräumt),
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
        let now = self.clock.now();
        // Die Freigabe ist ab hier verbraucht – was auch immer folgt.
        let own = approval.issuer() == self.gate_id;
        let still_issued = own && self.issued.remove(&approval.nonce()).is_some();
        if own {
            self.challenged.remove(&approval.nonce());
        }
        let Some(challenge) = self.challenges.remove(&challenge_id) else {
            let err = ConsentError::UnknownChallenge(challenge_id);
            self.record(
                now,
                AuditEvent::SecondConfirmationRejected {
                    plan_id: approval.plan_id(),
                    challenge_id,
                    reason: err.to_string(),
                },
            );
            return Err(err);
        };
        let plan_id = challenge.plan_id;
        let failure = if !own {
            Some(ConsentError::ForeignApproval)
        } else if challenge.nonce != approval.nonce()
            || challenge.plan_id != approval.plan_id()
            || challenge.digest != approval.digest()
        {
            Some(ConsentError::ChallengeMismatch(challenge_id))
        } else if !still_issued {
            Some(ConsentError::ApprovalExpired(plan_id))
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
            return Err(self.reject_second(now, plan_id, challenge_id, err));
        }
        if decision != Decision::Execute {
            self.record(
                now,
                AuditEvent::SecondConfirmationRecorded {
                    plan_id,
                    challenge_id,
                    decision,
                    origin,
                },
            );
            return Err(ConsentError::SecondConfirmationDeclined { plan_id, decision });
        }
        // Erst die Frist berechnen, dann protokollieren: Ein „Ja“ ohne ausgestellte
        // Freigabe darf nicht als erfasste Bestätigung im Protokoll stehen.
        let Some(expires_at) = now.checked_add(self.config.execution_window) else {
            return Err(self.reject_second(now, plan_id, challenge_id, ConsentError::TimeOverflow));
        };
        self.record(
            now,
            AuditEvent::SecondConfirmationRecorded {
                plan_id,
                challenge_id,
                decision,
                origin: origin.clone(),
            },
        );
        let nonce = self.issue(plan_id, expires_at);
        Ok(PermanentDeleteApproval::new(
            plan_id,
            challenge.digest,
            approval.approved_at(),
            approval.origin().clone(),
            SecondConfirmation::new(challenge_id, now, origin),
            expires_at,
            nonce,
            self.gate_id,
        ))
    }

    /// Holt alle seit dem letzten Aufruf gesammelten Protokoll-Ereignisse ab (in
    /// zeitlicher Reihenfolge). Der Dienst schreibt sie in das Prüfprotokoll
    /// ([`crate::audit::AuditLog::append_all`]).
    #[must_use = "Protokoll-Ereignisse müssen ins Prüfprotokoll geschrieben werden"]
    pub fn take_audit_events(&mut self) -> Vec<TimedEvent> {
        std::mem::take(&mut self.audit)
    }

    /// Beendet das Tor (z. B. beim Herunterfahren des Dienstes): Alle ausstehenden Pläne,
    /// zweiten Rückfragen und nicht eingelösten Freigaben verfallen ohne Wirkung und werden
    /// als verfallen protokolliert. Liefert alle noch nicht abgeholten Ereignisse.
    ///
    /// Danach lässt sich keine Freigabe dieses Tors mehr einlösen (das Einlösen braucht das
    /// Tor).
    #[must_use = "Protokoll-Ereignisse müssen ins Prüfprotokoll geschrieben werden"]
    pub fn close(mut self) -> Vec<TimedEvent> {
        let now = self.clock.now();
        for id in std::mem::take(&mut self.pending).into_keys() {
            self.record(now, AuditEvent::PlanExpired { plan_id: id });
        }
        for (challenge_id, ch) in std::mem::take(&mut self.challenges) {
            self.record(
                now,
                AuditEvent::SecondConfirmationExpired {
                    plan_id: ch.plan_id,
                    challenge_id,
                },
            );
        }
        for token in std::mem::take(&mut self.issued).into_values() {
            self.record(
                now,
                AuditEvent::ApprovalExpired {
                    plan_id: token.plan_id,
                },
            );
        }
        self.audit
    }

    /// Prüft das Einlösen einer Freigabe und protokolliert das Ergebnis
    /// ([`AuditEvent::PermitIssued`] bzw. [`AuditEvent::RedeemRejected`]). Verbraucht die
    /// Freigabe in jedem Fall. Liefert bei Erfolg den Zeitpunkt des Einlösens.
    fn settle_redeem(
        &mut self,
        request: RedeemRequest,
        plan: &ActionPlan,
    ) -> Result<OffsetDateTime, ConsentError> {
        let now = self.clock.now();
        let own = request.issuer == self.gate_id;
        let still_issued = own && self.issued.remove(&request.nonce).is_some();
        if own {
            self.challenged.remove(&request.nonce);
        }
        let checked = redeem_checks(own, still_issued, &request, plan, now);
        match checked {
            Ok(()) => {
                self.record(
                    now,
                    AuditEvent::PermitIssued {
                        plan_id: request.plan_id,
                        digest: request.digest,
                        kind: plan.kind(),
                    },
                );
                Ok(now)
            }
            Err(err) => {
                self.record(
                    now,
                    AuditEvent::RedeemRejected {
                        plan_id: request.plan_id,
                        reason: err.to_string(),
                    },
                );
                Err(err)
            }
        }
    }

    /// Verdrängt den ältesten ausstehenden Plan mit dem niedrigsten Schweregrad, sofern er
    /// weniger schwer als `severity` ist. `true`, wenn Platz geschaffen wurde.
    fn evict_less_severe(&mut self, severity: RiskLevel, now: OffsetDateTime) -> bool {
        let victim = self
            .pending
            .iter()
            .filter(|(_, entry)| entry.plan.severity() < severity)
            .min_by_key(|(_, entry)| (entry.plan.severity(), entry.ticket.proposed_at))
            .map(|(id, _)| *id);
        let Some(id) = victim else {
            return false;
        };
        self.pending.remove(&id);
        self.retire(id, Retired::Expired);
        self.record(now, AuditEvent::PlanExpired { plan_id: id });
        true
    }

    fn issue(&mut self, plan_id: PlanId, expires_at: OffsetDateTime) -> ApprovalNonce {
        let nonce = ApprovalNonce(Uuid::new_v4());
        self.issued.insert(
            nonce,
            IssuedToken {
                plan_id,
                expires_at,
            },
        );
        nonce
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

    fn reject_second(
        &mut self,
        now: OffsetDateTime,
        plan_id: PlanId,
        challenge_id: ChallengeId,
        err: ConsentError,
    ) -> ConsentError {
        self.record(
            now,
            AuditEvent::SecondConfirmationRejected {
                plan_id,
                challenge_id,
                reason: err.to_string(),
            },
        );
        err
    }
}

/// Prüfungen beim Einlösen, in dieser Reihenfolge: eigenes Tor, gleicher Plan, keine
/// ausstehende zweite Bestätigung, noch nicht verfallen, im Ausführungsfenster.
fn redeem_checks(
    own: bool,
    still_issued: bool,
    request: &RedeemRequest,
    plan: &ActionPlan,
    now: OffsetDateTime,
) -> Result<(), ConsentError> {
    if !own {
        return Err(ConsentError::ForeignApproval);
    }
    tokens::check_binding(request.plan_id, request.digest, plan)?;
    if request.needs_second_confirmation {
        return Err(ConsentError::RequiresSecondConfirmation(request.plan_id));
    }
    if !still_issued {
        return Err(ConsentError::ApprovalExpired(request.plan_id));
    }
    tokens::check_window(request.plan_id, now, request.valid_from, request.expires_at)
}

#[cfg(test)]
mod tests;
