//! Durchgängiger Ablauf der Goldenen Regel – nur über die öffentliche API, so wie Dienst,
//! UI und Ausführer späterer Phasen sie nutzen.
//!
//! Der „Ausführer“ hier ist ein harmloser Test-Simulator: Er verschiebt eine Dummy-Datei
//! innerhalb eines Temp-Ordners (über die freigegebenen Test-Helfer) – und zwar nur, wenn
//! er eine `ExecutionPermit` als Wert bekommt.
// Integrationstest: Auch Hilfsfunktionen außerhalb von #[test] dürfen wie Tests per
// unwrap/expect/panic abbrechen (clippy.toml erlaubt das sonst nur direkt in #[test]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Cursor;
use std::path::Path;

use aegis_core::audit::{AuditEvent, AuditLog, ExecutionResult, verify};
use aegis_core::consent::{
    Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, ExecutionPermit, Outcome,
    ProposalTicket,
};
use aegis_core::plan::{ActionKind, ActionPlan, PlanDigest, PlanId, Target, UndoHint};
use aegis_core::risk::RiskLevel;
use aegis_core::testing::{
    DirSnapshot, ManualClock, assert_unchanged, rename_fixture, user_answers, write_fixture,
};
use aegis_core::time::Duration;

/// Simulierter Quarantäne-Ausführer: verlangt die Erlaubnis als Wert.
fn simulated_quarantine(permit: ExecutionPermit, sandbox: &Path) -> AuditEvent {
    let plan = permit.ensure_kind(ActionKind::Quarantine).unwrap();
    for target in plan.targets() {
        let Target::File { path } = target else {
            panic!("unerwartetes Ziel {target}");
        };
        let name = path.file_name().unwrap().to_str().unwrap();
        rename_fixture(sandbox, name, &format!("quarantaene/{name}")).unwrap();
    }
    permit.complete(ExecutionResult::Succeeded)
}

/// Was die UI über die Pipe zurückschickt.
#[derive(serde::Serialize, serde::Deserialize)]
struct UiAnswer {
    id: PlanId,
    digest: PlanDigest,
    decision: Decision,
    origin: DecisionOrigin,
}

fn quarantine_plan(sandbox: &Path, clock: &ManualClock) -> ActionPlan {
    ActionPlan::builder(ActionKind::Quarantine)
        .target(Target::file(sandbox.join("dummy.exe")))
        .what("Datei „dummy.exe“ in Quarantäne verschieben")
        .why("Test-Simulator: harmlose Dummy-Datei")
        .consequence("Die Datei liegt danach verschlüsselt in der Quarantäne")
        .undo(UndoHint::reversible("Quarantäne → Wiederherstellen"))
        .severity(RiskLevel::Suspicious)
        .build(clock.now())
        .unwrap()
}

/// Simulierte UI: liest Plan + Quittung als JSON und antwortet als JSON.
fn ui_round_trip(plan: &ActionPlan, ticket: &ProposalTicket, decision: Decision) -> String {
    let shown_plan: ActionPlan =
        serde_json::from_str(&serde_json::to_string(plan).unwrap()).unwrap();
    let shown_ticket: ProposalTicket =
        serde_json::from_str(&serde_json::to_string(ticket).unwrap()).unwrap();
    assert_eq!(shown_plan.digest(), shown_ticket.digest);
    serde_json::to_string(&UiAnswer {
        id: shown_ticket.id,
        digest: shown_ticket.digest,
        decision,
        origin: DecisionOrigin::ui_dialog("ui-dialog-42"),
    })
    .unwrap()
}

#[test]
fn nothing_happens_without_yes_and_everything_is_audited() {
    let sandbox = tempfile::tempdir().unwrap();
    write_fixture(sandbox.path(), "dummy.exe", b"harmlose Dummy-Datei").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let mut log = AuditLog::new(Vec::new());
    let untouched = DirSnapshot::capture(sandbox.path()).unwrap();

    // 1. „Nein“ → nichts passiert.
    let plan = quarantine_plan(sandbox.path(), &clock);
    let ticket = gate.propose(plan.clone()).unwrap();
    let answer: UiAnswer =
        serde_json::from_str(&ui_round_trip(&plan, &ticket, Decision::Decline)).unwrap();
    let outcome = user_answers(
        &mut gate,
        answer.id,
        &answer.digest,
        answer.decision,
        answer.origin,
    )
    .unwrap();
    assert!(matches!(outcome, Outcome::Declined));
    assert_unchanged(&untouched, &DirSnapshot::capture(sandbox.path()).unwrap());

    // 2. Keine Reaktion → Plan verfällt, nichts passiert.
    let plan = quarantine_plan(sandbox.path(), &clock);
    let ticket = gate.propose(plan).unwrap();
    clock.advance(Duration::minutes(10));
    assert_eq!(gate.expire_stale(), vec![ticket.id]);
    assert_unchanged(&untouched, &DirSnapshot::capture(sandbox.path()).unwrap());

    // 3. „Ja, ausführen“ → genau dieser Plan wird ausgeführt, genau einmal.
    let plan = quarantine_plan(sandbox.path(), &clock);
    let ticket = gate.propose(plan.clone()).unwrap();
    clock.advance(Duration::seconds(5));
    let answer: UiAnswer =
        serde_json::from_str(&ui_round_trip(&plan, &ticket, Decision::Execute)).unwrap();
    let Outcome::Approved(approval) = user_answers(
        &mut gate,
        answer.id,
        &answer.digest,
        answer.decision,
        answer.origin,
    )
    .unwrap() else {
        panic!("Freigabe erwartet");
    };
    assert_unchanged(&untouched, &DirSnapshot::capture(sandbox.path()).unwrap());
    let mut events = gate.take_audit_events();
    log.append_all(&mut events).unwrap();
    assert!(events.is_empty());
    let permit = approval.redeem(&plan, &mut gate).unwrap();
    let executed = simulated_quarantine(permit, sandbox.path());
    // Wie der Dienst: erst das Einlösen (aus dem Tor), dann die Ausführung protokollieren.
    let mut events = gate.take_audit_events();
    log.append_all(&mut events).unwrap();
    log.append(clock.now(), executed).unwrap();
    let after = DirSnapshot::capture(sandbox.path()).unwrap();
    let diff = untouched.diff(&after);
    assert_eq!(diff.removed.len(), 1);
    assert_eq!(diff.added.len(), 2); // Ordner „quarantaene“ + Datei

    // 4. Protokoll: vollständig und unverändert prüfbar.
    let bytes = log.into_inner();
    let report = verify(Cursor::new(&bytes)).unwrap();
    assert_eq!(report.entries(), 8);
    let text = String::from_utf8(bytes).unwrap();
    assert_eq!(text.matches("\"type\":\"decision_recorded\"").count(), 2);
    assert_eq!(text.matches("\"type\":\"plan_expired\"").count(), 1);
    assert_eq!(text.matches("\"type\":\"permit_issued\"").count(), 1);
    assert_eq!(text.matches("\"type\":\"action_executed\"").count(), 1);
    assert!(text.contains("\"dialog_id\":\"ui-dialog-42\""));
}

#[test]
fn a_plan_changed_after_display_cannot_be_executed() {
    let sandbox = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let plan = quarantine_plan(sandbox.path(), &clock);
    let ticket = gate.propose(plan.clone()).unwrap();

    // Die UI hat eine veränderte Fassung angezeigt (anderes Ziel) und deren Prüfsumme bestätigt.
    let mut shown = serde_json::to_value(&plan).unwrap();
    shown["targets"][0]["path"] = serde_json::json!(sandbox.path().join("andere.exe"));
    let shown: ActionPlan = serde_json::from_value(shown).unwrap();
    assert_eq!(shown.id(), ticket.id);
    let outcome = user_answers(
        &mut gate,
        ticket.id,
        &shown.digest(),
        Decision::Execute,
        DecisionOrigin::ui_dialog("ui"),
    );
    assert!(outcome.is_err());
    // Auch ein späteres korrektes „Ja“ ist wirkungslos: Der Plan ist verbraucht.
    assert!(
        user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            DecisionOrigin::ui_dialog("ui")
        )
        .is_err()
    );
}

#[test]
fn deserialized_plan_grants_nothing() {
    // Ein Plan aus der Pipe ist nur eine Beschreibung: Ohne Vorlage + Entscheidung im Tor
    // gibt es keine Freigabe.
    let sandbox = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let plan = quarantine_plan(sandbox.path(), &clock);
    let from_pipe: ActionPlan =
        serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();
    assert!(
        user_answers(
            &mut gate,
            from_pipe.id(),
            &from_pipe.digest(),
            Decision::Execute,
            DecisionOrigin::ui_dialog("ui")
        )
        .is_err()
    );
    // Der Versuch wird protokolliert – als Ablehnung, nie als Entscheidung.
    let events = gate.take_audit_events();
    assert_eq!(events.len(), 1);
    assert!(matches!(
        &events[0].event,
        AuditEvent::DecisionRejected { plan_id, .. } if *plan_id == from_pipe.id()
    ));
}
