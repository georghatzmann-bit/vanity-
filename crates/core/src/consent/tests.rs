use time::Duration;
use time::macros::datetime;

use super::*;
use crate::audit::ExecutionResult;
use crate::plan::{Target, UndoHint};
use crate::testing::{
    ManualClock, sample_plan, sample_plan_builder, test_path, user_answers, user_confirms_second,
};

const MAX_TIME: OffsetDateTime = datetime!(9999-12-31 23:59:59.999_999_999 UTC);

fn origin() -> DecisionOrigin {
    DecisionOrigin::ui_dialog("dialog-1")
}

fn setup() -> (ConsentGate<ManualClock>, ManualClock) {
    setup_with(ConsentConfig::default())
}

fn setup_with(config: ConsentConfig) -> (ConsentGate<ManualClock>, ManualClock) {
    let clock = ManualClock::default();
    let gate = ConsentGate::with_clock(clock.clone(), config).unwrap();
    (gate, clock)
}

fn propose(
    gate: &mut ConsentGate<ManualClock>,
    clock: &ManualClock,
    kind: ActionKind,
) -> (ActionPlan, ProposalTicket) {
    let plan = sample_plan(kind, clock.now()).unwrap();
    let ticket = gate.propose(plan.clone()).unwrap();
    (plan, ticket)
}

fn approve(
    gate: &mut ConsentGate<ManualClock>,
    clock: &ManualClock,
    kind: ActionKind,
) -> (ActionPlan, Approval) {
    let (plan, ticket) = propose(gate, clock, kind);
    match user_answers(gate, ticket.id, &ticket.digest, Decision::Execute, origin()).unwrap() {
        Outcome::Approved(approval) => (plan, approval),
        other => panic!("Freigabe erwartet, erhalten: {other:?}"),
    }
}

fn delete_approval(
    gate: &mut ConsentGate<ManualClock>,
    clock: &ManualClock,
) -> (ActionPlan, PermanentDeleteApproval) {
    let (plan, approval) = approve(gate, clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.advance(gate.config().second_confirmation_delay);
    let pda = user_confirms_second(
        gate,
        approval,
        challenge.challenge_id,
        Decision::Execute,
        origin(),
    )
    .unwrap();
    (plan, pda)
}

fn event_types(gate: &mut ConsentGate<ManualClock>) -> Vec<String> {
    gate.take_audit_events()
        .into_iter()
        .map(|timed| {
            serde_json::to_value(&timed.event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// Grundablauf
// ---------------------------------------------------------------------------------------

#[test]
fn happy_path_execute_redeem_complete() {
    let (mut gate, clock) = setup();
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    assert_eq!(ticket.id, plan.id());
    assert_eq!(ticket.digest, plan.digest());
    assert_eq!(ticket.proposed_at, clock.now());
    assert_eq!(ticket.expires_at, clock.now() + Duration::minutes(10));

    clock.advance(Duration::minutes(3));
    let outcome = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    )
    .unwrap();
    let Outcome::Approved(approval) = outcome else {
        panic!("Freigabe erwartet");
    };
    assert_eq!(approval.plan_id(), plan.id());
    assert_eq!(approval.digest(), plan.digest());
    assert_eq!(approval.kind(), ActionKind::Quarantine);
    assert_eq!(approval.approved_at(), clock.now());
    assert_eq!(approval.expires_at(), clock.now() + Duration::minutes(2));
    assert_eq!(approval.origin(), &origin());
    assert!(!approval.requires_second_confirmation());

    clock.advance(Duration::seconds(30));
    let permit = approval.redeem(&plan, &mut gate).unwrap();
    assert_eq!(permit.plan(), &plan);
    assert_eq!(permit.plan_id(), plan.id());
    assert_eq!(permit.digest(), plan.digest());
    assert_eq!(permit.kind(), ActionKind::Quarantine);
    assert_eq!(permit.redeemed_at(), clock.now());
    assert_eq!(permit.approved_at(), clock.now() - Duration::seconds(30));
    assert_eq!(permit.origin(), &origin());
    assert!(permit.second_confirmation().is_none());
    assert_eq!(permit.ensure_kind(ActionKind::Quarantine).unwrap(), &plan);
    assert_eq!(
        permit
            .ensure_kind(ActionKind::DeletePermanently)
            .unwrap_err(),
        ConsentError::WrongKind {
            expected: ActionKind::DeletePermanently,
            actual: ActionKind::Quarantine
        }
    );
    let event = permit.complete(ExecutionResult::Succeeded);
    assert_eq!(
        event,
        AuditEvent::ActionExecuted {
            plan_id: plan.id(),
            digest: plan.digest(),
            kind: ActionKind::Quarantine,
            result: ExecutionResult::Succeeded
        }
    );
    assert_eq!(
        event_types(&mut gate),
        ["plan_proposed", "decision_recorded", "permit_issued"]
    );
    assert!(gate.take_audit_events().is_empty());
    assert_eq!(gate.pending().count(), 0);
}

#[test]
fn every_kind_except_delete_redeems_directly() {
    let (mut gate, clock) = setup();
    for kind in ActionKind::ALL {
        let (plan, approval) = approve(&mut gate, &clock, kind);
        let result = approval.redeem(&plan, &mut gate);
        if kind == ActionKind::DeletePermanently {
            assert_eq!(
                result.unwrap_err(),
                ConsentError::RequiresSecondConfirmation(plan.id())
            );
        } else {
            assert_eq!(result.unwrap().kind(), kind);
        }
    }
}

#[test]
fn digest_mismatch_rejects_and_consumes_plan() {
    let (mut gate, clock) = setup();
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let other = sample_plan(ActionKind::Quarantine, clock.now())
        .unwrap()
        .digest();
    assert_eq!(
        user_answers(&mut gate, ticket.id, &other, Decision::Execute, origin()).unwrap_err(),
        ConsentError::DigestMismatch(ticket.id)
    );
    // Auch die korrekte Prüfsumme hilft jetzt nicht mehr: Der Plan ist verbraucht.
    assert_eq!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::AlreadyDecided(ticket.id)
    );
    // Beide Versuche stehen im Protokoll – auch die Wiederholung nach dem Verbrauch.
    assert_eq!(
        event_types(&mut gate),
        ["plan_proposed", "decision_rejected", "decision_rejected"]
    );
}

#[test]
fn unknown_plan_id_is_rejected() {
    let (mut gate, clock) = setup();
    let plan = sample_plan(ActionKind::Quarantine, clock.now()).unwrap();
    assert_eq!(
        user_answers(
            &mut gate,
            plan.id(),
            &plan.digest(),
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::UnknownPlan(plan.id())
    );
    // Der Versuch wird als Ablehnung protokolliert (nie als Entscheidung).
    let events = gate.take_audit_events();
    assert_eq!(
        events.iter().map(|t| &t.event).collect::<Vec<_>>(),
        [&AuditEvent::DecisionRejected {
            plan_id: plan.id(),
            reason: ConsentError::UnknownPlan(plan.id()).to_string(),
        }]
    );
}

#[test]
fn replayed_decision_is_rejected() {
    let (mut gate, clock) = setup();
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let first = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    )
    .unwrap();
    assert!(matches!(first, Outcome::Approved(_)));
    for decision in Decision::ALL {
        assert_eq!(
            user_answers(&mut gate, plan.id(), &plan.digest(), decision, origin()).unwrap_err(),
            ConsentError::AlreadyDecided(plan.id())
        );
    }
}

#[test]
fn expired_plan_grants_nothing() {
    let (mut gate, clock) = setup();
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    clock.set(ticket.expires_at);
    assert_eq!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::Expired(ticket.id)
    );
    // Bleibt abgelaufen, auch wenn die Uhr zurückgestellt wird.
    clock.set(ticket.proposed_at);
    assert_eq!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::Expired(ticket.id)
    );
    // Der verspätete Wiederholungsversuch wird ebenfalls protokolliert.
    assert_eq!(
        event_types(&mut gate),
        ["plan_proposed", "plan_expired", "decision_rejected"]
    );
}

#[test]
fn decision_just_before_expiry_is_accepted() {
    let (mut gate, clock) = setup();
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    clock.set(ticket.expires_at - Duration::nanoseconds(1));
    assert!(matches!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            origin()
        ),
        Ok(Outcome::Approved(_))
    ));
}

#[test]
fn expired_approval_cannot_be_redeemed() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    clock.set(approval.expires_at());
    assert_eq!(
        approval.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );

    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    clock.set(approval.expires_at() - Duration::nanoseconds(1));
    assert!(approval.redeem(&plan, &mut gate).is_ok());
}

#[test]
fn approval_is_invalid_when_clock_jumps_back() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    clock.advance(Duration::seconds(-1));
    assert_eq!(
        approval.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalNotYetValid(plan.id())
    );
}

#[test]
fn approval_for_plan_a_cannot_redeem_plan_b() {
    let (mut gate, clock) = setup();
    let (plan_a, approval_a) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let (plan_b, _ticket_b) = propose(&mut gate, &clock, ActionKind::Quarantine);
    assert_eq!(
        approval_a.redeem(&plan_b, &mut gate).unwrap_err(),
        ConsentError::PlanMismatch {
            expected: plan_a.id(),
            actual: plan_b.id()
        }
    );
}

#[test]
fn approval_cannot_redeem_altered_plan_with_same_id() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let altered = sample_plan_builder(ActionKind::Quarantine)
        .id(plan.id())
        .target(Target::file(test_path("Windows/System32/wichtig.dll")))
        .build(plan.created_at())
        .unwrap();
    assert_eq!(
        approval.redeem(&altered, &mut gate).unwrap_err(),
        ConsentError::DigestMismatch(plan.id())
    );
}

#[test]
fn decline_and_ignore_never_yield_anything() {
    let (mut gate, clock) = setup();
    for kind in ActionKind::ALL {
        for decision in [Decision::Decline, Decision::Ignore] {
            let (plan, ticket) = propose(&mut gate, &clock, kind);
            let outcome =
                user_answers(&mut gate, ticket.id, &ticket.digest, decision, origin()).unwrap();
            match (decision, outcome) {
                (Decision::Decline, Outcome::Declined) | (Decision::Ignore, Outcome::Ignored) => {}
                (_, other) => panic!("unerwartet: {other:?}"),
            }
            // Danach ist keine weitere Antwort möglich – auch kein nachträgliches „Ja“.
            assert_eq!(
                user_answers(
                    &mut gate,
                    plan.id(),
                    &plan.digest(),
                    Decision::Execute,
                    origin()
                )
                .unwrap_err(),
                ConsentError::AlreadyDecided(plan.id())
            );
        }
    }
    let events = gate.take_audit_events();
    assert!(events.iter().all(|timed| !matches!(
        &timed.event,
        AuditEvent::DecisionRecorded {
            decision: Decision::Execute,
            ..
        }
    )));
}

#[test]
fn trust_yields_only_a_trust_grant() {
    let (mut gate, clock) = setup();
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::TerminateProcess);
    let Outcome::Trusted(grant) = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Trust,
        origin(),
    )
    .unwrap() else {
        panic!("TrustGrant erwartet");
    };
    assert_eq!(grant.plan_id(), plan.id());
    assert_eq!(grant.digest(), plan.digest());
    assert_eq!(grant.kind(), ActionKind::TerminateProcess);
    assert_eq!(grant.severity(), plan.severity());
    assert_eq!(grant.what(), plan.what());
    assert_eq!(grant.targets(), plan.targets());
    assert_eq!(grant.granted_at(), clock.now());
    assert_eq!(grant.origin(), &origin());
    assert_eq!(grant.into_targets(), plan.targets().to_vec());
    assert_eq!(
        user_answers(
            &mut gate,
            plan.id(),
            &plan.digest(),
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::AlreadyDecided(plan.id())
    );
}

#[test]
fn duplicate_plan_ids_are_rejected_forever() {
    let (mut gate, clock) = setup();
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    assert_eq!(
        gate.propose(plan.clone()).unwrap_err(),
        ConsentError::DuplicatePlan(plan.id())
    );
    let _declined = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Decline,
        origin(),
    )
    .unwrap();
    assert_eq!(
        gate.propose(plan.clone()).unwrap_err(),
        ConsentError::DuplicatePlan(plan.id())
    );

    let (expired_plan, _) = propose(&mut gate, &clock, ActionKind::Quarantine);
    clock.advance(Duration::minutes(11));
    assert_eq!(gate.expire_stale(), vec![expired_plan.id()]);
    assert_eq!(
        gate.propose(expired_plan.clone()).unwrap_err(),
        ConsentError::DuplicatePlan(expired_plan.id())
    );
}

#[test]
fn invalid_origin_rejects_and_consumes_plan() {
    const CHARSET: &str = "Dialog-Kennung darf nur A–Z, a–z, 0–9, „-“, „_“, „.“ und „:“ enthalten";
    let (mut gate, clock) = setup();
    let long = "d".repeat(MAX_DIALOG_ID_BYTES + 1);
    for (dialog_id, reason) in [
        ("", "Dialog-Kennung ist leer"),
        ("  ", "Dialog-Kennung ist leer"),
        (long.as_str(), "Dialog-Kennung ist zu lang"),
        ("a\u{202e}b", CHARSET),
        ("x\ny", CHARSET),
        ("mit leerzeichen", CHARSET),
        ("ümlaut", CHARSET),
    ] {
        let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
        let bad = DecisionOrigin::ui_dialog(dialog_id);
        assert_eq!(
            user_answers(&mut gate, ticket.id, &ticket.digest, Decision::Execute, bad).unwrap_err(),
            ConsentError::InvalidOrigin(reason),
            "{dialog_id:?}"
        );
        assert_eq!(
            user_answers(
                &mut gate,
                plan.id(),
                &plan.digest(),
                Decision::Execute,
                origin()
            )
            .unwrap_err(),
            ConsentError::AlreadyDecided(plan.id())
        );
    }
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let fine = DecisionOrigin::ui_dialog(format!("ui:{}", "d".repeat(MAX_DIALOG_ID_BYTES - 3)));
    assert!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Decline,
            fine
        )
        .is_ok()
    );
}

// ---------------------------------------------------------------------------------------
// Endgültiges Löschen
// ---------------------------------------------------------------------------------------

#[test]
fn permanent_delete_requires_second_confirmation() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    assert!(approval.requires_second_confirmation());
    assert_eq!(
        approval.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::RequiresSecondConfirmation(plan.id())
    );
}

#[test]
fn second_confirmation_happy_path() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let first_at = approval.approved_at();
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    assert_eq!(challenge.plan_id, plan.id());
    assert_eq!(
        challenge.not_before,
        clock.now() + Duration::milliseconds(1500)
    );
    assert_eq!(challenge.expires_at, clock.now() + Duration::minutes(2));

    clock.set(challenge.not_before);
    let second_origin = DecisionOrigin::ui_dialog("dialog-2");
    let pda = user_confirms_second(
        &mut gate,
        approval,
        challenge.challenge_id,
        Decision::Execute,
        second_origin.clone(),
    )
    .unwrap();
    assert_eq!(pda.plan_id(), plan.id());
    assert_eq!(pda.digest(), plan.digest());
    assert_eq!(pda.expires_at(), clock.now() + Duration::minutes(2));
    assert_eq!(pda.confirmation().challenge_id(), challenge.challenge_id);
    assert_eq!(pda.confirmation().confirmed_at(), clock.now());
    assert_eq!(pda.confirmation().origin(), &second_origin);

    clock.advance(Duration::seconds(10));
    let permit = pda.redeem(&plan, &mut gate).unwrap();
    assert_eq!(permit.kind(), ActionKind::DeletePermanently);
    assert_eq!(permit.approved_at(), first_at);
    assert_eq!(permit.origin(), &origin());
    let confirmation = permit.second_confirmation().unwrap();
    assert_eq!(confirmation.challenge_id(), challenge.challenge_id);
    assert_eq!(
        serde_json::to_value(confirmation).unwrap()["origin"]["dialog_id"],
        "dialog-2"
    );
    assert_eq!(
        event_types(&mut gate),
        [
            "plan_proposed",
            "decision_recorded",
            "second_confirmation_requested",
            "second_confirmation_recorded",
            "permit_issued"
        ]
    );
}

#[test]
fn second_confirmation_too_early_fails_and_consumes() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.set(challenge.not_before - Duration::nanoseconds(1));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::SecondConfirmationTooEarly {
            plan_id: plan.id(),
            not_before: challenge.not_before
        }
    );
    // Die Rückfrage ist verbraucht – auch mit einer neuen Freigabe nicht nutzbar.
    let (_, other) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.advance(Duration::seconds(5));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            other,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::UnknownChallenge(challenge.challenge_id)
    );
    let events = event_types(&mut gate);
    assert!(events.contains(&"second_confirmation_rejected".to_owned()));
    assert!(!events.contains(&"second_confirmation_recorded".to_owned()));
}

#[test]
fn second_confirmation_too_late_fails() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.set(challenge.expires_at);
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::SecondConfirmationExpired(plan.id())
    );
}

#[test]
fn second_confirmation_other_answers_fail() {
    let (mut gate, clock) = setup();
    for decision in [Decision::Decline, Decision::Ignore, Decision::Trust] {
        let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
        let challenge = gate.request_second_confirmation(&approval).unwrap();
        clock.advance(Duration::seconds(2));
        assert_eq!(
            user_confirms_second(
                &mut gate,
                approval,
                challenge.challenge_id,
                decision,
                origin()
            )
            .unwrap_err(),
            ConsentError::SecondConfirmationDeclined {
                plan_id: plan.id(),
                decision
            }
        );
        let types = event_types(&mut gate);
        assert_eq!(types.last().unwrap(), "second_confirmation_recorded");
    }
}

#[test]
fn second_confirmation_with_invalid_origin_fails() {
    let (mut gate, clock) = setup();
    let (_, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.advance(Duration::seconds(2));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            DecisionOrigin::ui_dialog("")
        )
        .unwrap_err(),
        ConsentError::InvalidOrigin("Dialog-Kennung ist leer")
    );
}

#[test]
fn second_confirmation_not_required_for_other_kinds() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::SecondConfirmationNotRequired(plan.id())
    );
    // Die Freigabe ist dabei nicht verbraucht worden.
    assert!(approval.redeem(&plan, &mut gate).is_ok());
}

#[test]
fn only_one_challenge_per_approval() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let _challenge = gate.request_second_confirmation(&approval).unwrap();
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::SecondConfirmationAlreadyRequested(plan.id())
    );
}

#[test]
fn challenge_requires_valid_approval_window() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(approval.expires_at());
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );
    clock.set(approval.approved_at() - Duration::seconds(1));
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::ApprovalNotYetValid(plan.id())
    );
}

#[test]
fn foreign_approvals_are_rejected() {
    let (mut gate_a, clock) = setup();
    let mut gate_b = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let (_, approval_a) = approve(&mut gate_a, &clock, ActionKind::DeletePermanently);
    assert_eq!(
        gate_b.request_second_confirmation(&approval_a).unwrap_err(),
        ConsentError::ForeignApproval
    );
    let (_, approval_b) = approve(&mut gate_b, &clock, ActionKind::DeletePermanently);
    let challenge_b = gate_b.request_second_confirmation(&approval_b).unwrap();
    clock.advance(Duration::seconds(2));
    assert_eq!(
        user_confirms_second(
            &mut gate_b,
            approval_a,
            challenge_b.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::ForeignApproval
    );
}

#[test]
fn challenge_of_other_approval_is_rejected() {
    let (mut gate, clock) = setup();
    let (_, approval_x) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let (_, approval_y) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let _challenge_x = gate.request_second_confirmation(&approval_x).unwrap();
    let challenge_y = gate.request_second_confirmation(&approval_y).unwrap();
    clock.advance(Duration::seconds(2));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval_x,
            challenge_y.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::ChallengeMismatch(challenge_y.challenge_id)
    );
}

#[test]
fn permanent_delete_approval_redeem_checks() {
    let (mut gate, clock) = setup();
    let (_, pda) = delete_approval(&mut gate, &clock);
    let (other_plan, _) = propose(&mut gate, &clock, ActionKind::DeletePermanently);
    assert!(matches!(
        pda.redeem(&other_plan, &mut gate).unwrap_err(),
        ConsentError::PlanMismatch { .. }
    ));

    let (plan, pda) = delete_approval(&mut gate, &clock);
    clock.set(pda.expires_at());
    assert_eq!(
        pda.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );

    let (plan, pda) = delete_approval(&mut gate, &clock);
    clock.advance(Duration::seconds(-1));
    assert_eq!(
        pda.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalNotYetValid(plan.id())
    );

    let (plan, pda) = delete_approval(&mut gate, &clock);
    let altered = sample_plan_builder(ActionKind::DeletePermanently)
        .id(plan.id())
        .undo(UndoHint::irreversible("Anderer Text"))
        .build(plan.created_at())
        .unwrap();
    assert_eq!(
        pda.redeem(&altered, &mut gate).unwrap_err(),
        ConsentError::DigestMismatch(plan.id())
    );
}

// ---------------------------------------------------------------------------------------
// Verfall, Auflistung, Grenzen
// ---------------------------------------------------------------------------------------

#[test]
fn expire_stale_removes_plans_and_challenges() {
    let (mut gate, clock) = setup();
    let (old, _) = propose(&mut gate, &clock, ActionKind::Quarantine);
    clock.advance(Duration::minutes(5));
    let (young, _) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let (_, delete) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&delete).unwrap();
    assert_eq!(gate.pending().count(), 2);
    assert!(gate.get_pending(old.id()).is_some());

    clock.advance(Duration::minutes(5));
    // Abgelaufene Pläne werden nicht mehr angezeigt …
    assert_eq!(
        gate.pending().map(|p| p.plan().id()).collect::<Vec<_>>(),
        vec![young.id()]
    );
    assert!(gate.get_pending(old.id()).is_none());
    // … und beim Aufräumen ohne Wirkung entfernt.
    let mut expected = vec![old.id(), challenge.plan_id];
    expected.sort_unstable();
    assert_eq!(gate.expire_stale(), expected);
    assert!(gate.expire_stale().is_empty());
    assert_eq!(
        user_confirms_second(
            &mut gate,
            delete,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::UnknownChallenge(challenge.challenge_id)
    );
    let pending = gate.get_pending(young.id()).unwrap();
    assert_eq!(pending.plan(), &young);
    assert_eq!(pending.ticket().id, young.id());
    let events = event_types(&mut gate);
    assert!(events.contains(&"plan_expired".to_owned()));
    assert!(events.contains(&"second_confirmation_expired".to_owned()));
}

#[test]
fn pending_limit_is_enforced() {
    let config = ConsentConfig {
        max_pending: 2,
        ..ConsentConfig::default()
    };
    let (mut gate, clock) = setup_with(config);
    let _a = propose(&mut gate, &clock, ActionKind::Quarantine);
    let _b = propose(&mut gate, &clock, ActionKind::Quarantine);
    let third = sample_plan(ActionKind::Quarantine, clock.now()).unwrap();
    assert_eq!(
        gate.propose(third.clone()).unwrap_err(),
        ConsentError::TooManyPending { limit: 2 }
    );
    // Nach Ablauf der alten Pläne ist wieder Platz (abgelaufene werden aufgeräumt).
    clock.advance(Duration::minutes(10));
    assert!(gate.propose(third).is_ok());
}

#[test]
fn config_validation() {
    let ok = ConsentConfig::default();
    assert!(ok.validate().is_ok());
    assert_eq!(ok.decision_ttl, Duration::minutes(10));
    assert_eq!(ok.execution_window, Duration::minutes(2));
    assert_eq!(ok.second_confirmation_delay, Duration::milliseconds(1500));
    let invalid = [
        ConsentConfig {
            decision_ttl: Duration::ZERO,
            ..ok
        },
        ConsentConfig {
            execution_window: Duration::ZERO,
            ..ok
        },
        ConsentConfig {
            execution_window: Duration::minutes(16),
            ..ok
        },
        ConsentConfig {
            second_confirmation_delay: Duration::seconds(1),
            ..ok
        },
        ConsentConfig {
            second_confirmation_ttl: Duration::milliseconds(1500),
            ..ok
        },
        ConsentConfig {
            max_pending: 0,
            ..ok
        },
    ];
    for config in invalid {
        assert!(
            matches!(config.validate(), Err(ConsentError::InvalidConfig(_))),
            "{config:?}"
        );
        assert!(ConsentGate::with_clock(ManualClock::default(), config).is_err());
    }
    let longer = ConsentConfig {
        second_confirmation_delay: Duration::seconds(5),
        ..ok
    };
    assert!(longer.validate().is_ok());
    let gate = ConsentGate::new(ok).unwrap();
    assert_eq!(gate.config(), &ok);
    let now = gate.clock().now();
    assert!(now.year() >= 2024);
}

#[test]
fn time_overflow_never_panics_and_grants_nothing() {
    // Vorlage am Rand des darstellbaren Bereichs.
    let (mut gate, clock) = setup();
    clock.set(MAX_TIME - Duration::minutes(5));
    let plan = sample_plan(ActionKind::Quarantine, clock.now()).unwrap();
    assert_eq!(gate.propose(plan).unwrap_err(), ConsentError::TimeOverflow);

    // Entscheidung, deren Ausführungsfenster nicht mehr darstellbar wäre.
    clock.set(MAX_TIME - Duration::minutes(11));
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    clock.set(MAX_TIME - Duration::seconds(90));
    assert_eq!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::TimeOverflow
    );
    assert_eq!(
        user_answers(
            &mut gate,
            plan.id(),
            &plan.digest(),
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::AlreadyDecided(plan.id())
    );

    // Frist der zweiten Rückfrage nicht mehr darstellbar.
    clock.set(MAX_TIME - Duration::minutes(12));
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(MAX_TIME - Duration::seconds(150));
    let approval = expect_approval(user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    ));
    clock.set(MAX_TIME - Duration::seconds(60));
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::TimeOverflow
    );

    // Wartezeit der zweiten Rückfrage nicht mehr darstellbar.
    clock.set(MAX_TIME - Duration::minutes(11));
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(MAX_TIME - Duration::minutes(2));
    let approval = expect_approval(user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    ));
    assert_eq!(approval.expires_at(), MAX_TIME);
    clock.set(MAX_TIME - Duration::seconds(1));
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::TimeOverflow
    );

    // Ausführungsfenster nach der zweiten Bestätigung nicht mehr darstellbar.
    clock.set(MAX_TIME - Duration::minutes(12));
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(MAX_TIME - Duration::minutes(3));
    let approval = expect_approval(user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    ));
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.set(MAX_TIME - Duration::seconds(90));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::TimeOverflow
    );
}

fn expect_approval(result: Result<Outcome, ConsentError>) -> Approval {
    match result.unwrap() {
        Outcome::Approved(approval) => approval,
        other => panic!("Freigabe erwartet, erhalten: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// Serialisierung und Texte
// ---------------------------------------------------------------------------------------

#[test]
fn decision_wire_format_and_labels() {
    let expected = [
        (
            Decision::Execute,
            "execute",
            "Ja, ausführen",
            "Yes, execute",
        ),
        (Decision::Decline, "decline", "Nein", "No"),
        (Decision::Ignore, "ignore", "Ignorieren", "Ignore"),
        (Decision::Trust, "trust", "Vertrauen", "Trust"),
    ];
    for (decision, wire, de, en) in expected {
        assert_eq!(
            serde_json::to_string(&decision).unwrap(),
            format!("\"{wire}\"")
        );
        assert_eq!(
            serde_json::from_str::<Decision>(&format!("\"{wire}\"")).unwrap(),
            decision
        );
        assert_eq!(decision.label_de(), de);
        assert_eq!(decision.label_en(), en);
        assert_eq!(decision.to_string(), de);
    }
    assert!(serde_json::from_str::<Decision>("\"yes\"").is_err());
}

#[test]
fn origin_wire_format() {
    let json = serde_json::to_string(&origin()).unwrap();
    assert_eq!(json, r#"{"type":"ui_dialog","dialog_id":"dialog-1"}"#);
    assert_eq!(
        serde_json::from_str::<DecisionOrigin>(&json).unwrap(),
        origin()
    );
    assert!(
        serde_json::from_str::<DecisionOrigin>(
            r#"{"type":"ui_dialog","dialog_id":"d","admin":true}"#
        )
        .is_err()
    );
    assert!(serde_json::from_str::<DecisionOrigin>(r#"{"type":"script"}"#).is_err());
}

#[test]
fn ticket_and_challenge_wire_format() {
    let (mut gate, clock) = setup();
    let (plan, ticket) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let json = serde_json::to_string(&ticket).unwrap();
    assert_eq!(
        serde_json::from_str::<ProposalTicket>(&json).unwrap(),
        ticket
    );
    let pending = serde_json::to_value(gate.get_pending(plan.id()).unwrap()).unwrap();
    assert_eq!(pending["plan"]["id"], plan.id().to_string());
    assert_eq!(pending["ticket"]["digest"], plan.digest().to_string());

    let (_, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    let json = serde_json::to_string(&challenge).unwrap();
    assert_eq!(
        serde_json::from_str::<SecondConfirmationChallenge>(&json).unwrap(),
        challenge
    );
    let id = challenge.challenge_id;
    assert_eq!(id.to_string().parse::<ChallengeId>().unwrap(), id);
    assert_eq!(id.as_uuid().get_version_num(), 4);
    assert_eq!(
        "falsch".parse::<ChallengeId>().unwrap_err(),
        ConsentError::InvalidChallengeId
    );
}

#[test]
fn error_messages_are_german() {
    let id = PlanId::from_uuid(Uuid::from_u128(7));
    let cases = [
        (ConsentError::UnknownPlan(id), "Unbekannter Plan"),
        (ConsentError::Expired(id), "abgelaufen"),
        (ConsentError::DigestMismatch(id), "Prüfsumme"),
        (ConsentError::AlreadyDecided(id), "bereits entschieden"),
        (
            ConsentError::RequiresSecondConfirmation(id),
            "zweite, getrennte Bestätigung",
        ),
        (
            ConsentError::SecondConfirmationDeclined {
                plan_id: id,
                decision: Decision::Decline,
            },
            "„Nein“",
        ),
        (ConsentError::TimeOverflow, "nichts ausgeführt"),
    ];
    for (error, needle) in cases {
        assert!(error.to_string().contains(needle), "{error}");
    }
}

// ---------------------------------------------------------------------------------------
// Regressionen aus dem Security-Review
// ---------------------------------------------------------------------------------------

/// Ereignisse ohne Zeitstempel.
fn events(gate: &mut ConsentGate<ManualClock>) -> Vec<AuditEvent> {
    gate.take_audit_events()
        .into_iter()
        .map(|timed| timed.event)
        .collect()
}

#[test]
fn second_confirmation_cannot_outlive_first_approval() {
    // Rückfrage kurz vor Ende des Ausführungsfensters: Sie endet mit der ersten Freigabe.
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.advance(Duration::minutes(1) + Duration::seconds(58));
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    assert_eq!(challenge.expires_at, approval.expires_at());
    // Fast zwei Minuten nach Ablauf der ersten Freigabe darf es kein „Ja“ mehr geben.
    clock.set(approval.expires_at() + Duration::minutes(1) + Duration::seconds(57));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::SecondConfirmationExpired(plan.id())
    );

    // Bleibt nach der Wartezeit keine Zeit mehr, wird gar keine Rückfrage ausgestellt.
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.advance(Duration::minutes(1) + Duration::seconds(59));
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );
}

#[test]
fn config_caps_keep_deadlines_short() {
    let ok = ConsentConfig::default();
    for config in [
        ConsentConfig {
            decision_ttl: Duration::days(365 * 100),
            ..ok
        },
        ConsentConfig {
            decision_ttl: MAX_DECISION_TTL + Duration::nanoseconds(1),
            ..ok
        },
        ConsentConfig {
            second_confirmation_ttl: Duration::days(365),
            ..ok
        },
        ConsentConfig {
            second_confirmation_delay: Duration::days(30),
            second_confirmation_ttl: Duration::days(31),
            ..ok
        },
        ConsentConfig {
            second_confirmation_delay: Duration::minutes(2),
            second_confirmation_ttl: Duration::minutes(3),
            ..ok
        },
        ConsentConfig {
            // Wartezeit so lang wie das Ausführungsfenster: nie bestätigbar.
            execution_window: Duration::seconds(30),
            second_confirmation_delay: Duration::seconds(30),
            second_confirmation_ttl: Duration::minutes(1),
            ..ok
        },
        ConsentConfig {
            max_pending: usize::MAX,
            ..ok
        },
        ConsentConfig {
            max_pending: MAX_PENDING_LIMIT + 1,
            ..ok
        },
    ] {
        assert!(
            matches!(config.validate(), Err(ConsentError::InvalidConfig(_))),
            "{config:?}"
        );
    }
    for config in [
        ConsentConfig {
            decision_ttl: MAX_DECISION_TTL,
            execution_window: MAX_EXECUTION_WINDOW,
            second_confirmation_delay: MAX_SECOND_CONFIRMATION_DELAY,
            second_confirmation_ttl: MAX_EXECUTION_WINDOW,
            max_pending: MAX_PENDING_LIMIT,
        },
        ConsentConfig {
            max_pending: 1,
            ..ok
        },
    ] {
        assert!(config.validate().is_ok(), "{config:?}");
    }
}

#[test]
fn failed_redeem_of_altered_plan_is_audited() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let _ = gate.take_audit_events();
    let altered = sample_plan_builder(ActionKind::Quarantine)
        .id(plan.id())
        .target(Target::file(test_path("Windows/System32/wichtig.dll")))
        .build(plan.created_at())
        .unwrap();
    let err = approval.redeem(&altered, &mut gate).unwrap_err();
    assert_eq!(err, ConsentError::DigestMismatch(plan.id()));
    assert_eq!(
        events(&mut gate),
        [AuditEvent::RedeemRejected {
            plan_id: plan.id(),
            reason: err.to_string()
        }]
    );

    let (plan_a, approval_a) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let (plan_b, _) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let _ = gate.take_audit_events();
    let err = approval_a.redeem(&plan_b, &mut gate).unwrap_err();
    assert!(matches!(err, ConsentError::PlanMismatch { .. }));
    assert_eq!(
        events(&mut gate),
        [AuditEvent::RedeemRejected {
            plan_id: plan_a.id(),
            reason: err.to_string()
        }]
    );

    // Direktes Einlösen einer Lösch-Freigabe wird ebenfalls protokolliert abgewiesen.
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let _ = gate.take_audit_events();
    let err = approval.redeem(&plan, &mut gate).unwrap_err();
    assert_eq!(err, ConsentError::RequiresSecondConfirmation(plan.id()));
    assert_eq!(
        events(&mut gate),
        [AuditEvent::RedeemRejected {
            plan_id: plan.id(),
            reason: err.to_string()
        }]
    );
}

#[test]
fn successful_redeem_is_audited_with_permit() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::TerminateProcess);
    let _ = gate.take_audit_events();
    let permit = approval.redeem(&plan, &mut gate).unwrap();
    assert_eq!(
        events(&mut gate),
        [AuditEvent::PermitIssued {
            plan_id: plan.id(),
            digest: plan.digest(),
            kind: ActionKind::TerminateProcess
        }]
    );
    let _executed = permit.complete(ExecutionResult::Succeeded);
}

#[test]
fn foreign_gate_cannot_redeem_and_logs_the_attempt() {
    let (mut gate_a, clock) = setup();
    let mut gate_b = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let (plan, approval) = approve(&mut gate_a, &clock, ActionKind::Quarantine);
    assert_eq!(
        approval.redeem(&plan, &mut gate_b).unwrap_err(),
        ConsentError::ForeignApproval
    );
    assert!(matches!(
        events(&mut gate_b).as_slice(),
        [AuditEvent::RedeemRejected { plan_id, .. }] if *plan_id == plan.id()
    ));
    // Die Freigabe bleibt beim ausstellenden Tor offen und verfällt dort protokolliert.
    clock.advance(Duration::minutes(2));
    assert_eq!(gate_a.expire_stale(), vec![plan.id()]);
    assert!(events(&mut gate_a).contains(&AuditEvent::ApprovalExpired { plan_id: plan.id() }));
}

#[test]
fn dropped_approval_expires_and_stays_dead() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let _ = gate.take_audit_events();
    // Nicht eingelöste Freigabe: Ihr Verfall wird protokolliert …
    clock.set(approval.expires_at());
    assert_eq!(gate.expire_stale(), vec![plan.id()]);
    assert_eq!(
        events(&mut gate),
        [AuditEvent::ApprovalExpired { plan_id: plan.id() }]
    );
    // … und auch eine zurückgestellte Uhr erweckt sie nicht wieder.
    clock.set(approval.approved_at());
    assert_eq!(
        approval.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );

    // Ebenso für eine Lösch-Freigabe nach der zweiten Bestätigung.
    let (plan, pda) = delete_approval(&mut gate, &clock);
    let _ = gate.take_audit_events();
    let expires_at = pda.expires_at();
    clock.set(expires_at);
    assert_eq!(gate.expire_stale(), vec![plan.id()]);
    assert!(events(&mut gate).contains(&AuditEvent::ApprovalExpired { plan_id: plan.id() }));
    clock.set(pda.confirmation().confirmed_at());
    assert_eq!(
        pda.redeem(&plan, &mut gate).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );

    // Eine verfallene Lösch-Freigabe bekommt auch keine zweite Rückfrage mehr.
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(approval.expires_at());
    let _ = gate.expire_stale();
    clock.set(approval.approved_at());
    assert_eq!(
        gate.request_second_confirmation(&approval).unwrap_err(),
        ConsentError::ApprovalExpired(plan.id())
    );
}

#[test]
fn unknown_challenge_attempt_is_audited() {
    let (mut gate, clock) = setup();
    let (plan, approval) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let _ = gate.take_audit_events();
    let unknown: ChallengeId = "6f1c2b9e-0d4a-4f5e-9b7c-2a3d4e5f6a7b".parse().unwrap();
    let err = user_confirms_second(&mut gate, approval, unknown, Decision::Execute, origin())
        .unwrap_err();
    assert_eq!(err, ConsentError::UnknownChallenge(unknown));
    assert_eq!(
        events(&mut gate),
        [AuditEvent::SecondConfirmationRejected {
            plan_id: plan.id(),
            challenge_id: unknown,
            reason: err.to_string()
        }]
    );
}

#[test]
fn approval_consumed_by_failed_second_confirmation_cannot_be_reused() {
    // Freigabe X wird mit der Rückfrage von Y versucht → X ist verbraucht und verfällt nicht
    // später noch einmal im Protokoll.
    let (mut gate, clock) = setup();
    let (_, approval_x) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let (_, approval_y) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge_y = gate.request_second_confirmation(&approval_y).unwrap();
    clock.advance(Duration::seconds(2));
    assert!(
        user_confirms_second(
            &mut gate,
            approval_x,
            challenge_y.challenge_id,
            Decision::Execute,
            origin()
        )
        .is_err()
    );
    let _ = gate.take_audit_events();
    clock.advance(Duration::minutes(5));
    let _ = gate.expire_stale();
    // Nur Y verfällt noch – X wurde schon beim Fehlversuch verbraucht.
    let expired: Vec<_> = events(&mut gate)
        .into_iter()
        .filter(|event| matches!(event, AuditEvent::ApprovalExpired { .. }))
        .collect();
    assert_eq!(
        expired,
        [AuditEvent::ApprovalExpired {
            plan_id: approval_y.plan_id()
        }]
    );
}

#[test]
fn time_overflow_after_second_yes_logs_no_recorded_confirmation() {
    let (mut gate, clock) = setup();
    clock.set(MAX_TIME - Duration::minutes(12));
    let (_, ticket) = propose(&mut gate, &clock, ActionKind::DeletePermanently);
    clock.set(MAX_TIME - Duration::minutes(3));
    let approval = expect_approval(user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    ));
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    let _ = gate.take_audit_events();
    clock.set(MAX_TIME - Duration::seconds(90));
    assert_eq!(
        user_confirms_second(
            &mut gate,
            approval,
            challenge.challenge_id,
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::TimeOverflow
    );
    assert_eq!(event_types(&mut gate), ["second_confirmation_rejected"]);
}

#[test]
fn close_expires_everything_open_and_returns_all_events() {
    let (mut gate, clock) = setup();
    let (pending, _) = propose(&mut gate, &clock, ActionKind::Quarantine);
    let (approved, _approval) = approve(&mut gate, &clock, ActionKind::Quarantine);
    let (deleting, delete) = approve(&mut gate, &clock, ActionKind::DeletePermanently);
    let challenge = gate.request_second_confirmation(&delete).unwrap();
    let events: Vec<AuditEvent> = gate.close().into_iter().map(|t| t.event).collect();
    assert_eq!(events.len(), 10, "{events:#?}");
    assert!(events.contains(&AuditEvent::PlanExpired {
        plan_id: pending.id()
    }));
    assert!(events.contains(&AuditEvent::ApprovalExpired {
        plan_id: approved.id()
    }));
    assert!(events.contains(&AuditEvent::ApprovalExpired {
        plan_id: deleting.id()
    }));
    assert!(events.contains(&AuditEvent::SecondConfirmationExpired {
        plan_id: deleting.id(),
        challenge_id: challenge.challenge_id
    }));
}

#[test]
fn full_queue_never_blocks_a_more_severe_plan() {
    let config = ConsentConfig {
        max_pending: 3,
        ..ConsentConfig::default()
    };
    let (mut gate, clock) = setup_with(config);
    let info = |clock: &ManualClock| {
        sample_plan_builder(ActionKind::AddTrust)
            .severity(RiskLevel::Info)
            .build(clock.now())
            .unwrap()
    };
    let oldest = info(&clock);
    gate.propose(oldest.clone()).unwrap();
    clock.advance(Duration::seconds(1));
    gate.propose(info(&clock)).unwrap();
    let suspicious = sample_plan(ActionKind::Quarantine, clock.now()).unwrap();
    gate.propose(suspicious.clone()).unwrap();
    let _ = gate.take_audit_events();

    // Gleich schwer oder leichter: weiterhin abgewiesen.
    assert_eq!(
        gate.propose(info(&clock)).unwrap_err(),
        ConsentError::TooManyPending { limit: 3 }
    );
    // Gefährlich: verdrängt den ältesten Plan mit dem niedrigsten Schweregrad.
    let dangerous = sample_plan_builder(ActionKind::Quarantine)
        .severity(RiskLevel::Dangerous)
        .build(clock.now())
        .unwrap();
    let ticket = gate.propose(dangerous).unwrap();
    assert_eq!(event_types(&mut gate), ["plan_expired", "plan_proposed"]);
    assert!(gate.get_pending(oldest.id()).is_none());
    assert!(gate.get_pending(suspicious.id()).is_some());
    assert!(gate.get_pending(ticket.id).is_some());
    // Der verdrängte Plan ist verbraucht – ein spätes „Ja“ bewirkt nichts.
    assert_eq!(
        user_answers(
            &mut gate,
            oldest.id(),
            &oldest.digest(),
            Decision::Execute,
            origin()
        )
        .unwrap_err(),
        ConsentError::Expired(oldest.id())
    );
}

#[test]
fn plan_too_large_for_the_audit_log_is_not_proposed() {
    let (mut gate, clock) = setup();
    // Steuerzeichen werden im JSON sechsfach so lang („\u0001“): So überschreitet schon ein
    // kleiner Plan die Zeilengrenze des Prüfprotokolls.
    let control = "\u{1}".repeat(crate::plan::MAX_TEXT_BYTES - 64);
    let targets: Vec<Target> = (0..700)
        .map(|i| Target::file(test_path(&format!("{i}-{control}"))))
        .collect();
    let plan = sample_plan_builder(ActionKind::Quarantine)
        .targets(targets)
        .build(clock.now())
        .unwrap();
    assert_eq!(
        gate.propose(plan.clone()).unwrap_err(),
        ConsentError::PlanNotAuditable(plan.id())
    );
    assert!(gate.take_audit_events().is_empty());
    assert!(gate.get_pending(plan.id()).is_none());
}
