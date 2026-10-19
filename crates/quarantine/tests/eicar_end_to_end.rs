//! Definition of Done (P2): EICAR wird erkannt, isoliert und wiederhergestellt – über das
//! echte Freigabe-Tor. Ohne „Ja“ bleibt alles byte-genau gleich.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use aegis_core::audit::{AuditEvent, ExecutionResult};
use aegis_core::consent::{
    Clock, ConsentConfig, ConsentGate, Decision, DecisionOrigin, ExecutionPermit, Outcome,
};
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::testing::{
    DirSnapshot, ManualClock, assert_unchanged, eicar, user_answers, user_confirms_second,
    write_fixture,
};
use aegis_core::time::Duration;
use aegis_engine::{Category, Engine};
use aegis_quarantine::{Entry, Vault};

fn origin() -> DecisionOrigin {
    DecisionOrigin::ui_dialog("test-dialog")
}

fn approve(gate: &mut ConsentGate<ManualClock>, plan: &ActionPlan) -> ExecutionPermit {
    let ticket = gate.propose(plan.clone()).unwrap();
    let Outcome::Approved(approval) =
        user_answers(gate, ticket.id, &ticket.digest, Decision::Execute, origin()).unwrap()
    else {
        panic!("Ja muss eine Freigabe ergeben");
    };
    approval.redeem(plan, gate).unwrap()
}

fn quarantine_plan(path: &Path, clock: &ManualClock) -> ActionPlan {
    ActionPlan::builder(ActionKind::Quarantine)
        .target(Target::file(path))
        .what("EICAR-Testdatei in die Quarantäne verschieben")
        .why("Die Engine erkennt die EICAR-Prüfzeichenkette")
        .consequence("Die Datei liegt danach verschlüsselt im Tresor und ist nicht mehr ausführbar")
        .undo(UndoHint::reversible("Quarantäne → Wiederherstellen"))
        .severity(RiskLevel::Dangerous)
        .build(clock.now())
        .unwrap()
}

fn restore_plan(entry: &Entry, clock: &ManualClock) -> ActionPlan {
    ActionPlan::builder(ActionKind::Restore)
        .target(Target::file(&entry.original_path))
        .parameter(param::QUARANTINE_ID, &entry.id)
        .what("Datei aus der Quarantäne wiederherstellen")
        .why("Vom Nutzer gewünscht")
        .consequence("Die Datei liegt wieder am ursprünglichen Ort")
        .undo(UndoHint::reversible("Erneut isolieren"))
        .severity(RiskLevel::Dangerous)
        .build(clock.now())
        .unwrap()
}

fn delete_plan(entry: &Entry, clock: &ManualClock) -> ActionPlan {
    ActionPlan::builder(ActionKind::DeletePermanently)
        .target(Target::file(&entry.original_path))
        .parameter(param::QUARANTINE_ID, &entry.id)
        .what("Quarantäne-Eintrag endgültig löschen")
        .why("Vom Nutzer gewünscht")
        .consequence("Die verschlüsselte Kopie wird gelöscht")
        .undo(UndoHint::irreversible(
            "Kann nicht rückgängig gemacht werden",
        ))
        .severity(RiskLevel::Dangerous)
        .build(clock.now())
        .unwrap()
}

#[test]
fn eicar_erkannt_isoliert_wiederhergestellt_geloescht() {
    let home = tempfile::tempdir().unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let eicar_path = write_fixture(home.path(), "Downloads/eicar.com", &eicar()).unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();

    // 1. Erkennen.
    let finding = Engine::with_builtin_rules().unwrap().scan_file(&eicar_path);
    assert_eq!(
        (finding.risk, finding.category),
        (RiskLevel::Dangerous, Category::TestFile)
    );

    // 2. Isolieren – nur mit „Ja“.
    let outcome = vault
        .quarantine(approve(&mut gate, &quarantine_plan(&eicar_path, &clock)))
        .unwrap();
    assert!(outcome.failures.is_empty());
    assert!(matches!(
        outcome.event,
        AuditEvent::ActionExecuted {
            result: ExecutionResult::Succeeded,
            ..
        }
    ));
    assert!(!eicar_path.exists(), "Original ist entfernt");
    let entries = vault.list().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].sha256, finding.sha256.clone().unwrap());
    assert_eq!(outcome.undo.unwrap().steps.len(), 1);
    // Der Tresor enthält die Datei nicht im Klartext.
    for item in std::fs::read_dir(vault_dir.path()).unwrap() {
        let bytes = std::fs::read(item.unwrap().path()).unwrap();
        assert!(!bytes.windows(20).any(|w| w == &eicar()[..20]));
    }

    // 3. Wiederherstellen – byte-genau.
    clock.advance(Duration::seconds(5));
    let restored = vault
        .restore(approve(&mut gate, &restore_plan(&entries[0], &clock)))
        .unwrap();
    assert!(restored.failures.is_empty());
    assert_eq!(std::fs::read(&eicar_path).unwrap(), eicar());
    assert!(vault.list().unwrap().is_empty());

    // 4. Erneut isolieren, dann endgültig löschen – nur mit zweiter Bestätigung.
    vault
        .quarantine(approve(&mut gate, &quarantine_plan(&eicar_path, &clock)))
        .unwrap();
    let entry = vault.list().unwrap().remove(0);
    let plan = delete_plan(&entry, &clock);
    let ticket = gate.propose(plan.clone()).unwrap();
    let Outcome::Approved(first) = user_answers(
        &mut gate,
        ticket.id,
        &ticket.digest,
        Decision::Execute,
        origin(),
    )
    .unwrap() else {
        panic!()
    };
    let challenge = gate.request_second_confirmation(&first).unwrap();
    clock.advance(Duration::seconds(2));
    let second = user_confirms_second(
        &mut gate,
        first,
        challenge.challenge_id,
        Decision::Execute,
        origin(),
    )
    .unwrap();
    let deleted = vault
        .delete_permanently(second.redeem(&plan, &mut gate).unwrap())
        .unwrap();
    assert!(deleted.failures.is_empty());
    assert!(vault.list().unwrap().is_empty());
    assert!(!eicar_path.exists());
}

#[test]
fn ohne_ja_bleibt_alles_gleich() {
    let home = tempfile::tempdir().unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let eicar_path = write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    write_fixture(home.path(), "dummy.txt", b"harmlos").unwrap();
    // Tresor existiert (inkl. Schlüssel), bevor der Zustand festgehalten wird.
    let _vault = Vault::open(vault_dir.path()).unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let before = (
        DirSnapshot::capture(home.path()).unwrap(),
        DirSnapshot::capture(vault_dir.path()).unwrap(),
    );

    // Scan, dann jede Antwort außer „Ja“ – und Verfallen ohne Antwort.
    let _ = Engine::with_builtin_rules()
        .unwrap()
        .scan_paths(&[home.path().to_path_buf()]);
    for decision in [Decision::Decline, Decision::Ignore, Decision::Trust] {
        let ticket = gate.propose(quarantine_plan(&eicar_path, &clock)).unwrap();
        let outcome =
            user_answers(&mut gate, ticket.id, &ticket.digest, decision, origin()).unwrap();
        assert!(!matches!(outcome, Outcome::Approved(_)));
    }
    gate.propose(quarantine_plan(&eicar_path, &clock)).unwrap();
    clock.advance(Duration::minutes(11));
    assert_eq!(gate.expire_stale().len(), 1);

    let after = (
        DirSnapshot::capture(home.path()).unwrap(),
        DirSnapshot::capture(vault_dir.path()).unwrap(),
    );
    assert_unchanged(&before.0, &after.0);
    assert_unchanged(&before.1, &after.1);
}

#[test]
fn manipulierter_tresor_und_belegtes_ziel() {
    let home = tempfile::tempdir().unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "probe.bin", b"Inhalt der Probe").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    vault
        .quarantine(approve(&mut gate, &quarantine_plan(&path, &clock)))
        .unwrap();
    let entry = vault.list().unwrap().remove(0);

    // Ziel belegt → nichts überschrieben.
    write_fixture(home.path(), "probe.bin", b"neue Datei").unwrap();
    let out = vault
        .restore(approve(&mut gate, &restore_plan(&entry, &clock)))
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert_eq!(std::fs::read(&path).unwrap(), b"neue Datei");
    aegis_core::testing::remove_fixture(home.path(), "probe.bin").unwrap();

    // Container manipuliert → Wiederherstellen schlägt fehl, keine Datei entsteht.
    let container = vault_dir.path().join(format!("{}.aqf", entry.id));
    let mut bytes = std::fs::read(&container).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0x55;
    aegis_core::testing::remove_fixture(vault_dir.path(), &format!("{}.aqf", entry.id)).unwrap();
    write_fixture(vault_dir.path(), &format!("{}.aqf", entry.id), &bytes).unwrap();
    let out = vault
        .restore(approve(&mut gate, &restore_plan(&entry, &clock)))
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert!(!path.exists());
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        0,
        "keine Reste"
    );
    assert_eq!(vault.list().unwrap().len(), 1, "Eintrag bleibt erhalten");

    // Falsche Planart / fehlende Parameter / falsches Ziel werden abgelehnt.
    assert!(
        vault
            .delete_permanently(approve(&mut gate, &restore_plan(&entry, &clock)))
            .is_err()
    );
    let wrong = ActionPlan::builder(ActionKind::Restore)
        .target(Target::file(home.path().join("anderswo.bin")))
        .parameter(param::QUARANTINE_ID, &entry.id)
        .what("x")
        .why("x")
        .consequence("x")
        .undo(UndoHint::reversible("x"))
        .severity(RiskLevel::Info)
        .build(clock.now())
        .unwrap();
    assert!(vault.restore(approve(&mut gate, &wrong)).is_err());
    let traversal = ActionPlan::builder(ActionKind::Restore)
        .target(Target::file(&entry.original_path))
        .parameter(param::QUARANTINE_ID, "../vault")
        .what("x")
        .why("x")
        .consequence("x")
        .undo(UndoHint::reversible("x"))
        .severity(RiskLevel::Info)
        .build(clock.now())
        .unwrap();
    assert!(vault.restore(approve(&mut gate, &traversal)).is_err());
}

#[cfg(unix)]
#[test]
fn links_werden_nicht_isoliert() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = write_fixture(outside.path(), "wichtig.txt", b"Nutzerdaten").unwrap();
    let link =
        aegis_core::testing::create_fixture_symlink(home.path(), "link.txt", &target).unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let out = vault
        .quarantine(approve(&mut gate, &quarantine_plan(&link, &clock)))
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert!(std::fs::symlink_metadata(&link).is_ok());
    assert_eq!(std::fs::read(&target).unwrap(), b"Nutzerdaten");
}

#[test]
fn tresor_wieder_oeffnen_und_beschaedigte_daten() {
    let home = tempfile::tempdir().unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.bin", b"Daten").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    {
        let vault = Vault::open(vault_dir.path()).unwrap();
        vault
            .quarantine(approve(&mut gate, &quarantine_plan(&path, &clock)))
            .unwrap();
        assert_eq!(vault.dir(), vault_dir.path());
    }
    // Neu geöffnet: gleicher Schlüssel, Wiederherstellen klappt.
    let vault = Vault::open(vault_dir.path()).unwrap();
    let entry = vault.list().unwrap().remove(0);
    assert_eq!(vault.entry(&entry.id.to_uppercase()).unwrap(), entry);
    assert!(vault.entry("kein-uuid").is_err());
    assert!(format!("{vault:?}").contains("Vault"));
    vault
        .restore(approve(&mut gate, &restore_plan(&entry, &clock)))
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"Daten");

    // Beschädigte Metadaten werden gemeldet, nicht entfernt.
    write_fixture(
        vault_dir.path(),
        "00000000-0000-4000-8000-000000000000.json",
        b"{kaputt",
    )
    .unwrap();
    assert!(matches!(
        vault.list(),
        Err(aegis_quarantine::QuarantineError::BadEntry(_))
    ));
    assert!(
        vault_dir
            .path()
            .join("00000000-0000-4000-8000-000000000000.json")
            .exists()
    );

    // Beschädigter Schlüssel.
    let other = tempfile::tempdir().unwrap();
    write_fixture(other.path(), "vault.key", b"zu kurz").unwrap();
    assert!(matches!(
        Vault::open(other.path()),
        Err(aegis_quarantine::QuarantineError::BadKey)
    ));
}
