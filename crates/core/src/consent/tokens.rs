//! Berechtigungs-Typen: [`Approval`], [`PermanentDeleteApproval`], [`ExecutionPermit`],
//! [`TrustGrant`].
//!
//! Gemeinsame Eigenschaften (Goldene Regel):
//! * private Felder, Konstruktoren nur `pub(crate)` – außerhalb von `aegis-core` kann
//!   niemand eine Berechtigung „basteln“;
//! * **kein** `Clone`, `Copy`, `Default`, `Serialize`, `Deserialize` – eine Berechtigung
//!   kann weder vervielfältigt noch über Pipe/Datei eingeschleust werden;
//! * Einlösen nimmt `self` als Wert – nach dem Einlösen existiert sie nicht mehr.
//!
//! Die Compile-Fail-Tests in `tests/ui` belegen das. Hinweis: deren `.stderr`-Dateien
//! zitieren unter Umständen Quelltext aus dieser Datei. Nach Änderungen hier
//! `TRYBUILD=overwrite cargo test -p aegis-core --test compile_fail` ausführen und jede
//! `.stderr`-Datei lesen (schlägt sie aus dem beabsichtigten Grund fehl?).

use serde::Serialize;
use time::OffsetDateTime;

use super::{
    ApprovalNonce, ChallengeId, Clock, ConsentError, ConsentGate, DecisionOrigin, GateId,
    RedeemRequest,
};
use crate::audit::{AuditEvent, ExecutionResult};
use crate::plan::{ActionKind, ActionPlan, PlanDigest, PlanId, Target};
use crate::risk::RiskLevel;

/// Freigabe aus einer Nutzerentscheidung „Ja, ausführen“ für genau einen Plan.
///
/// Entsteht ausschließlich in [`super::ConsentGate::decide`]. Gebunden an Plan-ID,
/// Prüfsumme und das ausstellende Tor, einmalig (wird beim Einlösen verbraucht) und
/// kurzlebig ([`super::ConsentConfig::execution_window`]). Wird sie nicht rechtzeitig
/// eingelöst, protokolliert das Tor ihren Verfall ([`AuditEvent::ApprovalExpired`]).
///
/// Für [`ActionKind::DeletePermanently`] kann sie nicht direkt eingelöst werden, sondern
/// nur über [`super::ConsentGate::request_second_confirmation`] und
/// [`super::ConsentGate::confirm_second`] in eine [`PermanentDeleteApproval`] überführt werden.
#[derive(Debug)]
#[must_use = "Eine Freigabe muss eingelöst werden – sonst verfällt sie (es passiert nichts)"]
pub struct Approval {
    plan_id: PlanId,
    digest: PlanDigest,
    kind: ActionKind,
    approved_at: OffsetDateTime,
    expires_at: OffsetDateTime,
    nonce: ApprovalNonce,
    issuer: GateId,
    origin: DecisionOrigin,
}

impl Approval {
    #[allow(clippy::too_many_arguments)]
    pub(crate) const fn new(
        plan_id: PlanId,
        digest: PlanDigest,
        kind: ActionKind,
        approved_at: OffsetDateTime,
        expires_at: OffsetDateTime,
        nonce: ApprovalNonce,
        issuer: GateId,
        origin: DecisionOrigin,
    ) -> Self {
        Self {
            plan_id,
            digest,
            kind,
            approved_at,
            expires_at,
            nonce,
            issuer,
            origin,
        }
    }

    /// Plan, für den die Freigabe gilt.
    #[must_use]
    pub const fn plan_id(&self) -> PlanId {
        self.plan_id
    }

    /// Prüfsumme des freigegebenen Plans.
    #[must_use]
    pub const fn digest(&self) -> PlanDigest {
        self.digest
    }

    /// Art der freigegebenen Aktion.
    #[must_use]
    pub const fn kind(&self) -> ActionKind {
        self.kind
    }

    /// Zeitpunkt der Entscheidung.
    #[must_use]
    pub const fn approved_at(&self) -> OffsetDateTime {
        self.approved_at
    }

    /// Ende des Ausführungsfensters (ausschließlich).
    #[must_use]
    pub const fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }

    /// Herkunft der Entscheidung (für das Prüfprotokoll).
    #[must_use]
    pub const fn origin(&self) -> &DecisionOrigin {
        &self.origin
    }

    /// `true`, wenn vor der Ausführung eine zweite Bestätigung nötig ist.
    #[must_use]
    pub const fn requires_second_confirmation(&self) -> bool {
        self.kind.requires_second_confirmation()
    }

    pub(super) const fn nonce(&self) -> ApprovalNonce {
        self.nonce
    }

    pub(super) const fn issuer(&self) -> GateId {
        self.issuer
    }

    /// Löst die Freigabe für `plan` beim ausstellenden Tor `gate` ein und verbraucht sie – in
    /// jedem Fall, auch bei Fehlern.
    ///
    /// Das Tor prüft Fristen mit seiner eigenen (versiegelten) Uhr und protokolliert das
    /// Ergebnis: [`AuditEvent::PermitIssued`] bei Erfolg, [`AuditEvent::RedeemRejected`] bei
    /// jedem verweigerten Versuch – etwa dem Versuch, einen veränderten Plan auszuführen.
    ///
    /// # Errors
    /// * [`ConsentError::ForeignApproval`] – Freigabe stammt von einem anderen Tor,
    /// * [`ConsentError::PlanMismatch`] – Freigabe gilt für einen anderen Plan,
    /// * [`ConsentError::DigestMismatch`] – Planinhalt weicht vom freigegebenen ab,
    /// * [`ConsentError::RequiresSecondConfirmation`] – endgültiges Löschen,
    /// * [`ConsentError::ApprovalExpired`] / [`ConsentError::ApprovalNotYetValid`] –
    ///   außerhalb des Ausführungsfensters oder bereits als verfallen protokolliert.
    pub fn redeem<C: Clock>(
        self,
        plan: &ActionPlan,
        gate: &mut ConsentGate<C>,
    ) -> Result<ExecutionPermit, ConsentError> {
        let now = gate.settle_redeem(
            RedeemRequest {
                plan_id: self.plan_id,
                digest: self.digest,
                nonce: self.nonce,
                issuer: self.issuer,
                valid_from: self.approved_at,
                expires_at: self.expires_at,
                needs_second_confirmation: self.kind.requires_second_confirmation(),
            },
            plan,
        )?;
        Ok(ExecutionPermit {
            plan: plan.clone(),
            digest: self.digest,
            approved_at: self.approved_at,
            redeemed_at: now,
            origin: self.origin,
            second_confirmation: None,
        })
    }
}

/// Angaben zur zweiten Bestätigung beim endgültigen Löschen (nur zur Information/Protokoll –
/// berechtigt allein zu nichts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecondConfirmation {
    challenge_id: ChallengeId,
    #[serde(with = "time::serde::rfc3339")]
    confirmed_at: OffsetDateTime,
    origin: DecisionOrigin,
}

impl SecondConfirmation {
    pub(super) const fn new(
        challenge_id: ChallengeId,
        confirmed_at: OffsetDateTime,
        origin: DecisionOrigin,
    ) -> Self {
        Self {
            challenge_id,
            confirmed_at,
            origin,
        }
    }

    /// Kennung der zweiten Rückfrage.
    #[must_use]
    pub const fn challenge_id(&self) -> ChallengeId {
        self.challenge_id
    }

    /// Zeitpunkt der zweiten Bestätigung.
    #[must_use]
    pub const fn confirmed_at(&self) -> OffsetDateTime {
        self.confirmed_at
    }

    /// Herkunft der zweiten Bestätigung.
    #[must_use]
    pub const fn origin(&self) -> &DecisionOrigin {
        &self.origin
    }
}

/// Freigabe für endgültiges Löschen: erste Freigabe **plus** zweite, zeitlich getrennte
/// Bestätigung. Entsteht ausschließlich in [`super::ConsentGate::confirm_second`] und gilt
/// nur bei ihrem Tor.
#[derive(Debug)]
#[must_use = "Eine Freigabe muss eingelöst werden – sonst verfällt sie (es passiert nichts)"]
pub struct PermanentDeleteApproval {
    plan_id: PlanId,
    digest: PlanDigest,
    approved_at: OffsetDateTime,
    first_origin: DecisionOrigin,
    confirmation: SecondConfirmation,
    expires_at: OffsetDateTime,
    nonce: ApprovalNonce,
    issuer: GateId,
}

impl PermanentDeleteApproval {
    #[allow(clippy::too_many_arguments)]
    pub(super) const fn new(
        plan_id: PlanId,
        digest: PlanDigest,
        approved_at: OffsetDateTime,
        first_origin: DecisionOrigin,
        confirmation: SecondConfirmation,
        expires_at: OffsetDateTime,
        nonce: ApprovalNonce,
        issuer: GateId,
    ) -> Self {
        Self {
            plan_id,
            digest,
            approved_at,
            first_origin,
            confirmation,
            expires_at,
            nonce,
            issuer,
        }
    }

    /// Plan, für den die Freigabe gilt.
    #[must_use]
    pub const fn plan_id(&self) -> PlanId {
        self.plan_id
    }

    /// Prüfsumme des freigegebenen Plans.
    #[must_use]
    pub const fn digest(&self) -> PlanDigest {
        self.digest
    }

    /// Ende des Ausführungsfensters (ausschließlich).
    #[must_use]
    pub const fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }

    /// Angaben zur zweiten Bestätigung.
    #[must_use]
    pub const fn confirmation(&self) -> &SecondConfirmation {
        &self.confirmation
    }

    /// Löst die Freigabe für `plan` beim ausstellenden Tor ein und verbraucht sie – in jedem
    /// Fall, auch bei Fehlern (protokolliert wie bei [`Approval::redeem`]).
    ///
    /// # Errors
    /// Wie [`Approval::redeem`] (ohne `RequiresSecondConfirmation`).
    pub fn redeem<C: Clock>(
        self,
        plan: &ActionPlan,
        gate: &mut ConsentGate<C>,
    ) -> Result<ExecutionPermit, ConsentError> {
        let now = gate.settle_redeem(
            RedeemRequest {
                plan_id: self.plan_id,
                digest: self.digest,
                nonce: self.nonce,
                issuer: self.issuer,
                valid_from: self.confirmation.confirmed_at,
                expires_at: self.expires_at,
                needs_second_confirmation: false,
            },
            plan,
        )?;
        Ok(ExecutionPermit {
            plan: plan.clone(),
            digest: self.digest,
            approved_at: self.approved_at,
            redeemed_at: now,
            origin: self.first_origin,
            second_confirmation: Some(self.confirmation),
        })
    }
}

/// Ausführungserlaubnis: Das, was ausführende Funktionen **als Wert** verlangen.
///
/// Enthält eine Kopie genau des freigegebenen Plans – ein Ausführer liest Ziele und
/// Parameter ausschließlich aus [`ExecutionPermit::plan`] und kann so keinen anderen Plan
/// unterschieben. Für [`ActionKind::DeletePermanently`] existiert eine Erlaubnis nur nach
/// zweiter Bestätigung ([`ExecutionPermit::second_confirmation`] ist dann gesetzt).
///
/// Nach der Ausführung erzeugt [`ExecutionPermit::complete`] den Protokolleintrag und
/// verbraucht die Erlaubnis endgültig.
#[derive(Debug)]
#[must_use = "Eine Ausführungserlaubnis muss genutzt und mit `complete` abgeschlossen werden"]
pub struct ExecutionPermit {
    plan: ActionPlan,
    digest: PlanDigest,
    approved_at: OffsetDateTime,
    redeemed_at: OffsetDateTime,
    origin: DecisionOrigin,
    second_confirmation: Option<SecondConfirmation>,
}

impl ExecutionPermit {
    /// Der freigegebene Plan (einzige Quelle für Ziele und Parameter).
    #[must_use]
    pub const fn plan(&self) -> &ActionPlan {
        &self.plan
    }

    /// Plan-ID.
    #[must_use]
    pub const fn plan_id(&self) -> PlanId {
        self.plan.id()
    }

    /// Prüfsumme des freigegebenen Plans.
    #[must_use]
    pub const fn digest(&self) -> PlanDigest {
        self.digest
    }

    /// Art der Aktion.
    #[must_use]
    pub const fn kind(&self) -> ActionKind {
        self.plan.kind()
    }

    /// Zeitpunkt der (ersten) Entscheidung.
    #[must_use]
    pub const fn approved_at(&self) -> OffsetDateTime {
        self.approved_at
    }

    /// Zeitpunkt des Einlösens.
    #[must_use]
    pub const fn redeemed_at(&self) -> OffsetDateTime {
        self.redeemed_at
    }

    /// Herkunft der (ersten) Entscheidung.
    #[must_use]
    pub const fn origin(&self) -> &DecisionOrigin {
        &self.origin
    }

    /// Zweite Bestätigung (nur bei endgültigem Löschen gesetzt).
    #[must_use]
    pub const fn second_confirmation(&self) -> Option<&SecondConfirmation> {
        self.second_confirmation.as_ref()
    }

    /// Prüft, dass die Erlaubnis für die erwartete Aktion gilt, und liefert den Plan.
    ///
    /// # Errors
    /// [`ConsentError::WrongKind`], wenn die Aktion abweicht.
    pub fn ensure_kind(&self, expected: ActionKind) -> Result<&ActionPlan, ConsentError> {
        if self.plan.kind() == expected {
            Ok(&self.plan)
        } else {
            Err(ConsentError::WrongKind {
                expected,
                actual: self.plan.kind(),
            })
        }
    }

    /// Schließt die Ausführung ab: verbraucht die Erlaubnis und liefert den
    /// Protokolleintrag [`AuditEvent::ActionExecuted`] – der muss ins Prüfprotokoll
    /// (`#[must_use]`; das Workspace-Lint `unused_must_use = deny` verhindert, dass er
    /// stillschweigend verworfen wird).
    #[must_use = "Der Eintrag über die Ausführung muss ins Prüfprotokoll geschrieben werden"]
    pub fn complete(self, result: ExecutionResult) -> AuditEvent {
        AuditEvent::ActionExecuted {
            plan_id: self.plan.id(),
            digest: self.digest,
            kind: self.plan.kind(),
            result,
        }
    }
}

/// Ergebnis der Entscheidung „Vertrauen“: berechtigt ausschließlich dazu, die genannten
/// Ziele in die Vertrauensliste aufzunehmen (Hash + Pfad + Grund + Datum erfasst die
/// Vertrauensliste selbst). Entsteht nur in [`super::ConsentGate::decide`] aus
/// [`super::Decision::Trust`] und führt **keine** Aktion des Plans aus.
///
/// Hinweis: Die Vertrauensliste muss den Datei-Hash sofort beim Eintragen bilden – ändert
/// sich die Datei danach, gilt das Vertrauen nicht für den neuen Inhalt.
#[derive(Debug)]
#[must_use = "Eine Vertrauens-Freigabe muss an die Vertrauensliste übergeben werden"]
pub struct TrustGrant {
    plan_id: PlanId,
    digest: PlanDigest,
    kind: ActionKind,
    severity: RiskLevel,
    what: String,
    targets: Vec<Target>,
    granted_at: OffsetDateTime,
    origin: DecisionOrigin,
}

impl TrustGrant {
    pub(super) fn new(
        plan: &ActionPlan,
        granted_at: OffsetDateTime,
        origin: DecisionOrigin,
    ) -> Self {
        Self {
            plan_id: plan.id(),
            digest: plan.digest(),
            kind: plan.kind(),
            severity: plan.severity(),
            what: plan.what().to_owned(),
            targets: plan.targets().to_vec(),
            granted_at,
            origin,
        }
    }

    /// Plan, zu dem „Vertrauen“ gewählt wurde.
    #[must_use]
    pub const fn plan_id(&self) -> PlanId {
        self.plan_id
    }

    /// Prüfsumme des Plans.
    #[must_use]
    pub const fn digest(&self) -> PlanDigest {
        self.digest
    }

    /// Ursprünglich vorgeschlagene Aktion (wird **nicht** ausgeführt).
    #[must_use]
    pub const fn kind(&self) -> ActionKind {
        self.kind
    }

    /// Schweregrad des Anlasses.
    #[must_use]
    pub const fn severity(&self) -> RiskLevel {
        self.severity
    }

    /// „Was genau?“ des Plans – Grundlage für den Grund-Eintrag der Vertrauensliste.
    #[must_use]
    pub fn what(&self) -> &str {
        &self.what
    }

    /// Ziele, denen vertraut werden soll.
    #[must_use]
    pub fn targets(&self) -> &[Target] {
        &self.targets
    }

    /// Zeitpunkt der Entscheidung.
    #[must_use]
    pub const fn granted_at(&self) -> OffsetDateTime {
        self.granted_at
    }

    /// Herkunft der Entscheidung.
    #[must_use]
    pub const fn origin(&self) -> &DecisionOrigin {
        &self.origin
    }

    /// Verbraucht die Freigabe und liefert die Ziele.
    #[must_use]
    pub fn into_targets(self) -> Vec<Target> {
        self.targets
    }
}

pub(super) fn check_binding(
    plan_id: PlanId,
    digest: PlanDigest,
    plan: &ActionPlan,
) -> Result<(), ConsentError> {
    if plan.id() != plan_id {
        return Err(ConsentError::PlanMismatch {
            expected: plan_id,
            actual: plan.id(),
        });
    }
    if plan.digest() != digest {
        return Err(ConsentError::DigestMismatch(plan_id));
    }
    Ok(())
}

pub(super) fn check_window(
    plan_id: PlanId,
    now: OffsetDateTime,
    valid_from: OffsetDateTime,
    expires_at: OffsetDateTime,
) -> Result<(), ConsentError> {
    if now < valid_from {
        return Err(ConsentError::ApprovalNotYetValid(plan_id));
    }
    if now >= expires_at {
        return Err(ConsentError::ApprovalExpired(plan_id));
    }
    Ok(())
}
