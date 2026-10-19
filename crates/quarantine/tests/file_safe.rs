//! Datei-Safe (P5): anlegen, hineinlegen, auflisten, herausholen – jeweils nur mit „Ja“ für
//! genau diesen Plan; nie überschreiben; ohne Passwort nicht lesbar.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use aegis_core::consent::{
    Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, ExecutionPermit, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::testing::{ManualClock, user_answers, write_fixture};
use aegis_quarantine::OwnProcess;
use aegis_quarantine::safe::{self, SAFE_SETTING};

/// Langer, tatsächlicher Pfad (Windows: kein Kurzname, kein `\\?\`).
fn real_tempdir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap();
    let text = real.to_string_lossy().into_owned();
    let path = text
        .strip_prefix(r"\\?\")
        .map_or(real.clone(), PathBuf::from);
    (dir, path)
}

fn approve(gate: &mut ConsentGate<ManualClock>, plan: &ActionPlan) -> ExecutionPermit {
    let ticket = gate.propose(plan.clone()).unwrap();
    let Outcome::Approved(approval) = user_answers(
        gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        DecisionOrigin::ui_dialog("test-dialog"),
    )
    .unwrap() else {
        panic!("Ja muss eine Freigabe ergeben");
    };
    approval.redeem(plan, gate).unwrap()
}

fn plan(kind: ActionKind) -> aegis_core::plan::ActionPlanBuilder {
    ActionPlan::builder(kind)
        .what("Datei-Safe")
        .why("Vom Nutzer gewünscht")
        .consequence("Siehe Plan")
        .undo(UndoHint::reversible("Wieder herausholen"))
        .severity(RiskLevel::Info)
}

fn create_plan(dir: &Path, clock: &ManualClock) -> ActionPlan {
    plan(ActionKind::ChangeSetting)
        .target(Target::setting(SAFE_SETTING))
        .target(Target::other(dir.to_string_lossy()))
        .parameter(param::VALUE, "on")
        .build(clock.now())
        .unwrap()
}

#[test]
fn safe_nur_mit_passwort_und_ohne_ueberschreiben() {
    let (_home, home) = real_tempdir();
    let dir = safe::safe_dir(&home);
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();

    // Ohne Safe: entsperren schlägt fehl.
    assert!(safe::unlock(&OwnProcess, &dir, "ein-langes-passwort").is_err());
    assert!(safe::prepare("kurz").is_err());

    // Anlegen nur über den Plan.
    let prepared = safe::prepare("ein-langes-passwort").unwrap();
    let permit = approve(&mut gate, &create_plan(&dir, &clock));
    safe::create(&permit, &OwnProcess, &prepared).unwrap();
    assert!(safe::exists(&dir));
    // Zweites Anlegen überschreibt nichts.
    let again = approve(&mut gate, &create_plan(&dir, &clock));
    assert!(
        safe::create(
            &again,
            &OwnProcess,
            &safe::prepare("anderes-passwort!").unwrap()
        )
        .is_err()
    );

    assert!(safe::unlock(&OwnProcess, &dir, "falsches-passwort").is_err());
    let key = safe::unlock(&OwnProcess, &dir, "ein-langes-passwort").unwrap();
    assert_eq!(key.as_ref(), prepared.key().as_ref());

    // Hineinlegen.
    let secret = b"Steuerunterlagen 2026 - harmloser Testinhalt".to_vec();
    let file = write_fixture(&home, "Dokumente/steuer.txt", &secret).unwrap();
    let store = plan(ActionKind::SafeStore)
        .target(Target::file(&file))
        .build(clock.now())
        .unwrap();
    let results = safe::store(&approve(&mut gate, &store), &OwnProcess, &dir, &key).unwrap();
    assert_eq!(results.len(), 1);
    let entry = results[0].1.clone().unwrap();
    assert!(!file.exists(), "Original entfernt");
    for item in std::fs::read_dir(&dir).unwrap() {
        let bytes = std::fs::read(item.unwrap().path()).unwrap();
        assert!(
            !bytes.windows(10).any(|w| w == &secret[..10]),
            "kein Klartext"
        );
        assert!(
            !String::from_utf8_lossy(&bytes).contains("steuer.txt"),
            "Name verschlüsselt"
        );
    }
    let listed = safe::list(&OwnProcess, &dir, &key).unwrap();
    assert_eq!(listed, vec![entry.clone()]);
    // Mit falschem Schlüssel: nichts lesbar.
    let wrong: aegis_quarantine::crypto::Key = zeroize::Zeroizing::new([9u8; 32]);
    assert!(safe::list(&OwnProcess, &dir, &wrong).unwrap().is_empty());

    // Herausholen: belegtes Ziel wird nie überschrieben.
    let blocker = write_fixture(&home, "Dokumente/steuer.txt", b"neue Datei").unwrap();
    let retrieve = |target: &Path, gate: &mut ConsentGate<ManualClock>| {
        let p = plan(ActionKind::SafeRetrieve)
            .target(Target::file(target))
            .parameter(param::SAFE_ENTRY, &entry.id)
            .build(clock.now())
            .unwrap();
        safe::retrieve(&approve(gate, &p), &OwnProcess, &dir, &key)
    };
    assert!(retrieve(&blocker, &mut gate).is_err());
    assert_eq!(std::fs::read(&blocker).unwrap(), b"neue Datei");
    assert_eq!(
        safe::list(&OwnProcess, &dir, &key).unwrap().len(),
        1,
        "bleibt im Safe"
    );

    let elsewhere = home.join("Dokumente").join("steuer (aus dem Safe).txt");
    let back = retrieve(&elsewhere, &mut gate).unwrap();
    assert_eq!(back.id, entry.id);
    assert_eq!(std::fs::read(&elsewhere).unwrap(), secret);
    assert!(safe::list(&OwnProcess, &dir, &key).unwrap().is_empty());
}

#[test]
fn falscher_plan_wird_abgelehnt() {
    let (_home, home) = real_tempdir();
    let dir = safe::safe_dir(&home);
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let other = plan(ActionKind::ChangeSetting)
        .target(Target::setting("etwas.anderes"))
        .target(Target::other(dir.to_string_lossy()))
        .parameter(param::VALUE, "on")
        .build(clock.now())
        .unwrap();
    let prepared = safe::prepare("ein-langes-passwort").unwrap();
    assert!(safe::create(&approve(&mut gate, &other), &OwnProcess, &prepared).is_err());
    assert!(!dir.exists(), "nichts angelegt");
}
