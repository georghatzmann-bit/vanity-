//! Eigenschaftstest der Goldenen Regel.
//!
//! Zufällige Folgen aus Vorlegen, Entscheiden, Uhr vorstellen (auch zurück), Einlösen,
//! zweiter Bestätigung und Aufräumen. Ein unabhängiges Protokoll der Aufrufe (nicht der
//! Ergebnisse des Tors) prüft danach jede entstandene `ExecutionPermit`:
//!
//! * Sie gehört zu einem Plan, dessen **erste** Antwort `Decision::Execute` mit passender
//!   Prüfsumme und gültiger Herkunft vor Fristende war,
//! * sie wurde im Ausführungsfenster eingelöst,
//! * bei endgültigem Löschen gab es zusätzlich eine zweite Bestätigung `Execute` im Fenster
//!   `[Anforderung + Wartezeit, Anforderung + Frist)`,
//! * höchstens eine Erlaubnis pro Plan.
//!
//! Zusätzlich: „Nein“/„Ignorieren“/„Vertrauen“ ergeben nie eine Freigabe, gültige erste
//! Antworten werden nie abgewiesen, und alle Protokoll-Ereignisse bilden eine gültige Kette.
// Integrationstest: Auch Hilfsfunktionen außerhalb von #[test] dürfen wie Tests per
// unwrap/expect/panic abbrechen (clippy.toml erlaubt das sonst nur direkt in #[test]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};

use aegis_core::audit::{AuditLog, ExecutionResult, verify};
use aegis_core::consent::{
    Approval, ChallengeId, Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin,
    ExecutionPermit, Outcome, PermanentDeleteApproval, SecondConfirmationChallenge,
};
use aegis_core::plan::{ActionKind, ActionPlan, PlanDigest, PlanId};
use aegis_core::testing::{ManualClock, sample_plan, user_answers, user_confirms_second};
use aegis_core::time::{Duration, OffsetDateTime};
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

/// Aktionen, aus denen Pläne gezogen werden (endgültiges Löschen doppelt gewichtet).
const KINDS: [ActionKind; 5] = [
    ActionKind::Quarantine,
    ActionKind::DeletePermanently,
    ActionKind::DeletePermanently,
    ActionKind::TerminateProcess,
    ActionKind::ChangeSetting,
];

/// Auswahl eines Plans bzw. einer Rückfrage: das zur Freigabe passende Element (wie ein
/// korrekter Dienst) oder ein beliebiges per Index (wie ein fehlerhafter/böswilliger Aufrufer).
#[derive(Debug, Clone, Copy)]
enum Choice {
    Matching,
    Index(usize),
}

#[derive(Debug, Clone)]
enum Op {
    Propose {
        kind: usize,
    },
    Decide {
        plan: usize,
        decision: Decision,
        tamper_digest: bool,
        valid_origin: bool,
    },
    Advance {
        millis: i64,
    },
    Redeem {
        approval: Choice,
        plan: Choice,
    },
    RequestSecond {
        approval: Choice,
    },
    ConfirmSecond {
        approval: Choice,
        challenge: Choice,
        decision: Decision,
        valid_origin: bool,
        /// Wie ein Nutzer, der wartet, bis der Knopf freigegeben ist (`not_before` + Versatz).
        wait_millis: Option<i64>,
    },
    RedeemDelete {
        pda: usize,
        plan: Choice,
    },
    ExpireStale,
}

fn decision_strategy() -> impl Strategy<Value = Decision> {
    prop_oneof![
        4 => Just(Decision::Execute),
        1 => Just(Decision::Decline),
        1 => Just(Decision::Ignore),
        1 => Just(Decision::Trust),
    ]
}

/// Index ab dem neuesten Element (0 = zuletzt erzeugt), bevorzugt 0 – so erreicht der
/// Generator auch mehrschrittige Abläufe wie das endgültige Löschen.
fn index_strategy() -> impl Strategy<Value = usize> {
    prop_oneof![3 => Just(0usize), 1 => 0..6usize]
}

fn choice_strategy() -> impl Strategy<Value = Choice> {
    prop_oneof![2 => Just(Choice::Matching), 1 => index_strategy().prop_map(Choice::Index)]
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..KINDS.len()).prop_map(|kind| Op::Propose { kind }),
        4 => (index_strategy(), decision_strategy(), prop::bool::weighted(0.15), prop::bool::weighted(0.9))
            .prop_map(|(plan, decision, tamper_digest, valid_origin)| Op::Decide {
                plan,
                decision,
                tamper_digest,
                valid_origin,
            }),
        3 => prop_oneof![
            3 => 0i64..=3_000,
            3 => 1_500i64..=10_000,
            1 => 0i64..=150_000,
            1 => 0i64..=700_000,
            1 => -3_000i64..=0,
        ]
        .prop_map(|millis| Op::Advance { millis }),
        2 => (choice_strategy(), choice_strategy()).prop_map(|(approval, plan)| Op::Redeem { approval, plan }),
        3 => choice_strategy().prop_map(|approval| Op::RequestSecond { approval }),
        4 => (
            choice_strategy(),
            choice_strategy(),
            decision_strategy(),
            prop::bool::weighted(0.9),
            prop::option::weighted(0.6, 0i64..=5_000),
        )
            .prop_map(|(approval, challenge, decision, valid_origin, wait_millis)| {
                Op::ConfirmSecond {
                    approval,
                    challenge,
                    decision,
                    valid_origin,
                    wait_millis,
                }
            }),
        3 => (index_strategy(), choice_strategy()).prop_map(|(pda, plan)| Op::RedeemDelete { pda, plan }),
        1 => Just(Op::ExpireStale),
    ]
}

/// Erste Antwort auf einen Plan (nur sie zählt).
#[derive(Debug, Clone, Copy)]
struct FirstAnswer {
    at: OffsetDateTime,
    decision: Decision,
    digest_ok: bool,
    origin_ok: bool,
}

/// Erster Bestätigungsversuch zu einer Rückfrage.
#[derive(Debug, Clone, Copy)]
struct SecondAnswer {
    at: OffsetDateTime,
    decision: Decision,
    origin_ok: bool,
    approval_matches: bool,
}

#[derive(Debug, Default)]
struct Stats {
    approvals: usize,
    permits: usize,
    delete_permits: usize,
    rejected_second: usize,
}

struct Harness {
    clock: ManualClock,
    gate: ConsentGate<ManualClock>,
    config: ConsentConfig,
    plans: Vec<ActionPlan>,
    proposed_at: BTreeMap<PlanId, OffsetDateTime>,
    first_answer: BTreeMap<PlanId, FirstAnswer>,
    approvals: Vec<Option<Approval>>,
    requested: BTreeSet<usize>,
    challenges: Vec<SecondConfirmationChallenge>,
    challenge_requested_at: BTreeMap<ChallengeId, OffsetDateTime>,
    second_answer: BTreeMap<ChallengeId, SecondAnswer>,
    pdas: Vec<Option<(PermanentDeleteApproval, ChallengeId)>>,
    permitted: BTreeSet<PlanId>,
    stats: Stats,
}

/// Wählt ein Element ab dem Ende (0 = neuestes).
fn pick<T>(items: &[T], index: usize) -> Option<usize> {
    (!items.is_empty()).then(|| items.len() - 1 - index % items.len())
}

fn origin(valid: bool) -> DecisionOrigin {
    DecisionOrigin::ui_dialog(if valid { "dlg-prop" } else { "" })
}

fn tampered(digest: PlanDigest) -> PlanDigest {
    let mut bytes = *digest.as_bytes();
    bytes[0] ^= 0x01;
    PlanDigest::from_bytes(bytes)
}

impl Harness {
    fn new() -> Self {
        let clock = ManualClock::default();
        let config = ConsentConfig::default();
        let gate = ConsentGate::with_clock(clock.clone(), config).unwrap();
        Self {
            clock,
            gate,
            config,
            plans: Vec::new(),
            proposed_at: BTreeMap::new(),
            first_answer: BTreeMap::new(),
            approvals: Vec::new(),
            requested: BTreeSet::new(),
            challenges: Vec::new(),
            challenge_requested_at: BTreeMap::new(),
            second_answer: BTreeMap::new(),
            pdas: Vec::new(),
            permitted: BTreeSet::new(),
            stats: Stats::default(),
        }
    }

    fn now(&self) -> OffsetDateTime {
        self.clock.now()
    }

    /// Freigabe zur Auswahl; `Matching` = die neueste noch vorhandene, auf die `fits` passt.
    fn choose_approval(
        &self,
        choice: Choice,
        fits: impl Fn(usize, &Approval) -> bool,
    ) -> Option<usize> {
        match choice {
            Choice::Matching => (0..self.approvals.len())
                .rev()
                .find(|&i| self.approvals[i].as_ref().is_some_and(|a| fits(i, a))),
            Choice::Index(index) => pick(&self.approvals, index),
        }
    }

    /// Plan zur Auswahl; `Matching` = der Plan mit der ID der Freigabe.
    fn choose_plan(&self, choice: Choice, approved: PlanId) -> Option<ActionPlan> {
        match choice {
            Choice::Matching => self.plans.iter().find(|p| p.id() == approved).cloned(),
            Choice::Index(index) => pick(&self.plans, index).map(|i| self.plans[i].clone()),
        }
    }

    /// Rückfrage zur Auswahl; `Matching` = die neueste Rückfrage zum Plan der Freigabe.
    fn choose_challenge(
        &self,
        choice: Choice,
        approved: PlanId,
    ) -> Option<SecondConfirmationChallenge> {
        match choice {
            Choice::Matching => self
                .challenges
                .iter()
                .rev()
                .find(|c| c.plan_id == approved)
                .cloned(),
            Choice::Index(index) => {
                pick(&self.challenges, index).map(|i| self.challenges[i].clone())
            }
        }
    }

    /// War die erste Antwort auf `id` ein gültiges „Ja“ vor Fristende?
    fn valid_execute_answer(&self, id: PlanId) -> Option<FirstAnswer> {
        let answer = *self.first_answer.get(&id)?;
        let deadline = *self.proposed_at.get(&id)? + self.config.decision_ttl;
        (answer.decision == Decision::Execute
            && answer.digest_ok
            && answer.origin_ok
            && answer.at < deadline)
            .then_some(answer)
    }

    fn check_permit(&mut self, permit: &ExecutionPermit, plan: &ActionPlan) {
        let id = permit.plan_id();
        assert_eq!(id, plan.id());
        assert_eq!(
            permit.plan(),
            plan,
            "Erlaubnis enthält genau den freigegebenen Plan"
        );
        assert_eq!(permit.digest(), plan.digest());
        let answer = self
            .valid_execute_answer(id)
            .expect("Erlaubnis ohne gültiges erstes „Ja, ausführen“");
        assert_eq!(permit.approved_at(), answer.at);
        let now = self.now();
        if plan.kind() == ActionKind::DeletePermanently {
            let confirmation = permit
                .second_confirmation()
                .expect("Löschen ohne zweite Bestätigung");
            let challenge = confirmation.challenge_id();
            let requested_at = self.challenge_requested_at[&challenge];
            let second = self.second_answer[&challenge];
            assert!(requested_at >= answer.at);
            assert!(requested_at < answer.at + self.config.execution_window);
            assert_eq!(second.decision, Decision::Execute);
            assert!(second.origin_ok && second.approval_matches);
            assert!(second.at >= requested_at + self.config.second_confirmation_delay);
            assert!(second.at < requested_at + self.config.second_confirmation_ttl);
            assert_eq!(confirmation.confirmed_at(), second.at);
            assert!(now >= second.at && now < second.at + self.config.execution_window);
            self.stats.delete_permits += 1;
        } else {
            assert!(permit.second_confirmation().is_none());
            assert!(now >= answer.at && now < answer.at + self.config.execution_window);
        }
        assert!(
            self.permitted.insert(id),
            "zweite Erlaubnis für denselben Plan"
        );
        self.stats.permits += 1;
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::Propose { kind } => {
                let plan = sample_plan(KINDS[kind % KINDS.len()], self.now()).unwrap();
                let ticket = self.gate.propose(plan.clone()).unwrap();
                assert_eq!(ticket.digest, plan.digest());
                self.proposed_at.insert(plan.id(), self.now());
                self.plans.push(plan);
            }
            Op::Decide {
                plan,
                decision,
                tamper_digest,
                valid_origin,
            } => {
                let Some(index) = pick(&self.plans, plan) else {
                    return;
                };
                let plan = self.plans[index].clone();
                let id = plan.id();
                let digest = if tamper_digest {
                    tampered(plan.digest())
                } else {
                    plan.digest()
                };
                let now = self.now();
                let first = !self.first_answer.contains_key(&id);
                let expired = now >= self.proposed_at[&id] + self.config.decision_ttl;
                if first {
                    self.first_answer.insert(
                        id,
                        FirstAnswer {
                            at: now,
                            decision,
                            digest_ok: !tamper_digest,
                            origin_ok: valid_origin,
                        },
                    );
                }
                let legitimate = first && !expired && !tamper_digest && valid_origin;
                match user_answers(&mut self.gate, id, &digest, decision, origin(valid_origin)) {
                    Ok(outcome) => {
                        assert!(legitimate, "Antwort angenommen, obwohl ungültig: {op:?}");
                        match (decision, outcome) {
                            (Decision::Execute, Outcome::Approved(approval)) => {
                                assert_eq!(approval.plan_id(), id);
                                assert_eq!(approval.digest(), plan.digest());
                                self.stats.approvals += 1;
                                self.approvals.push(Some(approval));
                            }
                            (Decision::Decline, Outcome::Declined)
                            | (Decision::Ignore, Outcome::Ignored) => {}
                            (Decision::Trust, Outcome::Trusted(grant)) => {
                                assert_eq!(grant.plan_id(), id);
                                assert_eq!(grant.targets(), plan.targets());
                            }
                            (decision, outcome) => {
                                panic!("{decision:?} ergab unpassendes Ergebnis {outcome:?}")
                            }
                        }
                    }
                    Err(err) => assert!(!legitimate, "gültige Antwort abgewiesen: {err}"),
                }
            }
            Op::Advance { millis } => self.clock.advance(Duration::milliseconds(millis)),
            Op::Redeem { approval, plan } => {
                let Some(a) =
                    self.choose_approval(approval, |_, a| !a.requires_second_confirmation())
                else {
                    return;
                };
                let Some(approved) = self.approvals[a].as_ref().map(Approval::plan_id) else {
                    return;
                };
                let Some(plan) = self.choose_plan(plan, approved) else {
                    return;
                };
                let Some(approval) = self.approvals[a].take() else {
                    return;
                };
                if let Ok(permit) = approval.redeem(&plan, &mut self.gate) {
                    assert_ne!(plan.kind(), ActionKind::DeletePermanently);
                    self.check_permit(&permit, &plan);
                    let _event = permit.complete(ExecutionResult::Succeeded);
                }
            }
            Op::RequestSecond { approval } => {
                let Some(a) = self.choose_approval(approval, |i, a| {
                    a.requires_second_confirmation() && !self.requested.contains(&i)
                }) else {
                    return;
                };
                let Some(approval) = self.approvals[a].as_ref() else {
                    return;
                };
                let now = self.now();
                if let Ok(challenge) = self.gate.request_second_confirmation(approval) {
                    assert!(approval.requires_second_confirmation());
                    assert!(now >= approval.approved_at() && now < approval.expires_at());
                    assert!(
                        self.requested.insert(a),
                        "zweite Rückfrage für dieselbe Freigabe"
                    );
                    assert_eq!(challenge.plan_id, approval.plan_id());
                    self.challenge_requested_at
                        .insert(challenge.challenge_id, now);
                    self.challenges.push(challenge);
                }
            }
            Op::ConfirmSecond {
                approval,
                challenge,
                decision,
                valid_origin,
                wait_millis,
            } => {
                let Some(a) = self.choose_approval(approval, |i, _| self.requested.contains(&i))
                else {
                    return;
                };
                let Some(approved) = self.approvals[a].as_ref().map(Approval::plan_id) else {
                    return;
                };
                let Some(challenge) = self.choose_challenge(challenge, approved) else {
                    return;
                };
                let Some(approval) = self.approvals[a].take() else {
                    return;
                };
                if let Some(wait) = wait_millis
                    && self.now() < challenge.not_before
                {
                    self.clock
                        .set(challenge.not_before + Duration::milliseconds(wait));
                }
                let now = self.now();
                let approval_plan = approval.plan_id();
                let first = !self.second_answer.contains_key(&challenge.challenge_id);
                if first {
                    self.second_answer.insert(
                        challenge.challenge_id,
                        SecondAnswer {
                            at: now,
                            decision,
                            origin_ok: valid_origin,
                            approval_matches: approval_plan == challenge.plan_id,
                        },
                    );
                }
                match user_confirms_second(
                    &mut self.gate,
                    approval,
                    challenge.challenge_id,
                    decision,
                    origin(valid_origin),
                ) {
                    Ok(pda) => {
                        let requested_at = self.challenge_requested_at[&challenge.challenge_id];
                        assert!(first, "Rückfrage zweimal verwendet");
                        assert_eq!(decision, Decision::Execute);
                        assert!(valid_origin);
                        assert_eq!(approval_plan, challenge.plan_id);
                        assert!(now >= requested_at + self.config.second_confirmation_delay);
                        assert!(now < requested_at + self.config.second_confirmation_ttl);
                        assert_eq!(pda.plan_id(), challenge.plan_id);
                        self.pdas.push(Some((pda, challenge.challenge_id)));
                    }
                    Err(_) => self.stats.rejected_second += 1,
                }
            }
            Op::RedeemDelete { pda, plan } => {
                let Some(d) = pick(&self.pdas, pda) else {
                    return;
                };
                let Some(approved) = self.pdas[d].as_ref().map(|(pda, _)| pda.plan_id()) else {
                    return;
                };
                let Some(plan) = self.choose_plan(plan, approved) else {
                    return;
                };
                let Some((pda, _)) = self.pdas[d].take() else {
                    return;
                };
                if let Ok(permit) = pda.redeem(&plan, &mut self.gate) {
                    assert_eq!(plan.kind(), ActionKind::DeletePermanently);
                    self.check_permit(&permit, &plan);
                    let _event = permit.complete(ExecutionResult::Succeeded);
                }
            }
            Op::ExpireStale => {
                for id in self.gate.expire_stale() {
                    assert!(self.proposed_at.contains_key(&id));
                }
            }
        }
    }

    /// Alle Ereignisse des Tors bilden eine gültige Hash-Kette.
    fn finish(mut self) -> Stats {
        let mut events = self.gate.take_audit_events();
        let mut log = AuditLog::new(Vec::new());
        log.append_all(&mut events).unwrap();
        assert!(events.is_empty());
        let report = verify(std::io::Cursor::new(log.into_inner())).unwrap();
        assert!(report.entries() >= u64::try_from(self.plans.len()).unwrap());
        self.stats
    }
}

fn run(ops: &[Op]) -> Stats {
    let mut harness = Harness::new();
    for op in ops {
        harness.apply(op);
    }
    harness.finish()
}

proptest! {
    #![proptest_config(Config {
        cases: 512,
        failure_persistence: None,
        ..Config::default()
    })]

    #[test]
    fn permits_only_follow_valid_consent(ops in prop::collection::vec(op_strategy(), 1..100)) {
        run(&ops);
    }
}

/// Stellt sicher, dass der Generator die positiven Pfade tatsächlich erreicht – sonst
/// könnte der Eigenschaftstest „leer“ bestehen.
#[test]
fn generator_reaches_permits_and_permanent_deletes() {
    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::deterministic_rng(RngAlgorithm::ChaCha),
    );
    let strategy = prop::collection::vec(op_strategy(), 1..100);
    let mut total = Stats::default();
    for _ in 0..400 {
        let ops = strategy.new_tree(&mut runner).unwrap().current();
        let stats = run(&ops);
        total.approvals += stats.approvals;
        total.permits += stats.permits;
        total.delete_permits += stats.delete_permits;
        total.rejected_second += stats.rejected_second;
    }
    eprintln!("Generator-Abdeckung über 400 Folgen: {total:?}");
    // Fester Startwert (ChaCha) → reproduzierbar; beobachtet: 646 / 208 / 21 / 112.
    assert!(total.approvals > 300, "{total:?}");
    assert!(total.permits > 100, "{total:?}");
    assert!(total.delete_permits >= 10, "{total:?}");
    assert!(total.rejected_second > 50, "{total:?}");
}

#[test]
fn fixed_sequence_normal_flow() {
    let stats = run(&[
        Op::Propose { kind: 0 },
        Op::Decide {
            plan: 0,
            decision: Decision::Execute,
            tamper_digest: false,
            valid_origin: true,
        },
        Op::Advance { millis: 1_000 },
        Op::Redeem {
            approval: Choice::Index(0),
            plan: Choice::Matching,
        },
        // Wiederholung: Freigabe ist verbraucht, neue Antwort wird abgewiesen.
        Op::Redeem {
            approval: Choice::Index(0),
            plan: Choice::Matching,
        },
        Op::Decide {
            plan: 0,
            decision: Decision::Execute,
            tamper_digest: false,
            valid_origin: true,
        },
    ]);
    assert_eq!(stats.approvals, 1);
    assert_eq!(stats.permits, 1);
}

#[test]
fn fixed_sequence_permanent_delete() {
    let stats = run(&[
        Op::Propose { kind: 1 },
        Op::Decide {
            plan: 0,
            decision: Decision::Execute,
            tamper_digest: false,
            valid_origin: true,
        },
        Op::Redeem {
            approval: Choice::Index(0),
            plan: Choice::Matching,
        },
        Op::Propose { kind: 1 },
        Op::Decide {
            plan: 0,
            decision: Decision::Execute,
            tamper_digest: false,
            valid_origin: true,
        },
        Op::RequestSecond {
            approval: Choice::Matching,
        },
        Op::Advance { millis: 1_500 },
        Op::ConfirmSecond {
            approval: Choice::Matching,
            challenge: Choice::Matching,
            decision: Decision::Execute,
            valid_origin: true,
            wait_millis: None,
        },
        Op::RedeemDelete {
            pda: 0,
            plan: Choice::Index(0),
        },
    ]);
    assert_eq!(stats.approvals, 2);
    // Die erste Lösch-Freigabe wurde direkt eingelöst → abgewiesen und verbraucht.
    assert_eq!(stats.permits, 1);
    assert_eq!(stats.delete_permits, 1);
}

#[test]
fn fixed_sequence_nothing_without_yes() {
    let stats = run(&[
        Op::Propose { kind: 0 },
        Op::Propose { kind: 1 },
        Op::Decide {
            plan: 0,
            decision: Decision::Decline,
            tamper_digest: false,
            valid_origin: true,
        },
        Op::Decide {
            plan: 1,
            decision: Decision::Execute,
            tamper_digest: true,
            valid_origin: true,
        },
        Op::Advance { millis: 700_000 },
        Op::ExpireStale,
        Op::Decide {
            plan: 1,
            decision: Decision::Execute,
            tamper_digest: false,
            valid_origin: true,
        },
    ]);
    assert_eq!(stats.approvals, 0);
    assert_eq!(stats.permits, 0);
}
