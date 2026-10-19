//! Rückfall-Kopien: sichern (nur neue Dateien im eigenen Ordner), zurückholen und ausdünnen
//! nur mit „Ja“ für genau diesen Plan; nie überschreiben, neueste Version bleibt immer.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use aegis_core::consent::{
    Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, ExecutionPermit, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::testing::{ManualClock, user_answers, user_confirms_second, write_fixture};
use aegis_quarantine::OwnProcess;
use aegis_quarantine::backup::BackupStore;

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
        DecisionOrigin::ui_dialog("d"),
    )
    .unwrap() else {
        panic!("Ja");
    };
    approval.redeem(plan, gate).unwrap()
}

fn store_file(store: &BackupStore, path: &Path, modified: i64) {
    let file = std::fs::File::open(path).unwrap();
    store.store(None, path, file, modified).unwrap();
}

#[test]
fn sichern_zurueckholen_ausduennen() {
    let (_home, home) = real_tempdir();
    let (_data, data) = real_tempdir();
    let store = BackupStore::open(&data.join("backup")).unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let doc = write_fixture(&home, "Dokumente/plan.txt", b"Version 1").unwrap();
    assert!(store.needs(None, &doc, 1, 9).unwrap());
    store_file(&store, &doc, 1);
    assert!(!store.needs(None, &doc, 1, 9).unwrap(), "unverändert");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write_fixture(&home, "Dokumente/plan.txt", b"Version 2 (verschluesselt?)").unwrap();
    assert!(store.needs(None, &doc, 2, 27).unwrap());
    store_file(&store, &doc, 2);
    let usage = store.usage(None).unwrap();
    assert_eq!((usage.files, usage.versions), (1, 2));
    // Kein Klartext im eigenen Ordner.
    for entry in walk(&data) {
        let bytes = std::fs::read(&entry).unwrap();
        assert!(
            !bytes.windows(9).any(|w| w == b"Version 1"),
            "{}",
            entry.display()
        );
    }
    let versions = store.versions(None, 10).unwrap();
    let old = versions.last().unwrap().clone();

    // Zurückholen: belegtes Ziel wird nie überschrieben.
    let restore = |target: &Path, gate: &mut ConsentGate<ManualClock>| {
        let plan = ActionPlan::builder(ActionKind::RestoreBackup)
            .target(Target::file(target))
            .parameter(param::BACKUP_ENTRY, &old.id)
            .what("x")
            .why("x")
            .consequence("x")
            .undo(UndoHint::reversible("x"))
            .severity(RiskLevel::Info)
            .build(clock.now())
            .unwrap();
        store.restore(&approve(gate, &plan), &OwnProcess)
    };
    assert!(restore(&doc, &mut gate).is_err());
    assert_eq!(std::fs::read(&doc).unwrap(), b"Version 2 (verschluesselt?)");
    let back = home.join("Dokumente").join("plan (Rueckfallkopie).txt");
    restore(&back, &mut gate).unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), b"Version 1");

    // Export der neuesten Versionen in einen gewählten Ordner (z. B. USB-Laufwerk).
    let (_usb, usb) = real_tempdir();
    let plan = ActionPlan::builder(ActionKind::ExportBackup)
        .target(Target::file(&usb))
        .what("x")
        .why("x")
        .consequence("x")
        .undo(UndoHint::reversible("x"))
        .severity(RiskLevel::Info)
        .build(clock.now())
        .unwrap();
    let (folder, written, failed) = store.export(&approve(&mut gate, &plan), &OwnProcess).unwrap();
    assert_eq!((written, failed), (1, 0));
    assert!(folder.starts_with(&usb));
    let exported: Vec<PathBuf> = walk(&folder);
    assert_eq!(exported.len(), 1);
    assert_eq!(std::fs::read(&exported[0]).unwrap(), b"Version 2 (verschluesselt?)");
    assert!(exported[0].ends_with("plan.txt"));

    // Ausdünnen: zweite Bestätigung, neueste Version bleibt.
    let future = aegis_core::time::OffsetDateTime::now_utc() + aegis_core::time::Duration::days(1);
    let plan = ActionPlan::builder(ActionKind::DeletePermanently)
        .target(Target::file(data.join("backup")))
        .parameter(
            param::BACKUP_BEFORE,
            future
                .format(&aegis_core::time::format_description::well_known::Rfc3339)
                .unwrap(),
        )
        .what("x")
        .why("x")
        .consequence("x")
        .undo(UndoHint::irreversible("x"))
        .severity(RiskLevel::Info)
        .build(clock.now())
        .unwrap();
    let ticket = gate.propose(plan.clone()).unwrap();
    let Outcome::Approved(approval) = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        DecisionOrigin::ui_dialog("d"),
    )
    .unwrap() else {
        panic!("Ja");
    };
    let challenge = gate.request_second_confirmation(&approval).unwrap();
    clock.advance(aegis_core::time::Duration::seconds(3));
    let second = user_confirms_second(
        &mut gate,
        approval,
        challenge.challenge_id,
        Decision::Execute,
        DecisionOrigin::ui_dialog("d2"),
    )
    .unwrap();
    let permit = second.redeem(&plan, &mut gate).unwrap();
    assert_eq!(store.prune(&permit, None).unwrap(), 1);
    let usage = store.usage(None).unwrap();
    assert_eq!((usage.files, usage.versions), (1, 1), "neueste bleibt");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}
