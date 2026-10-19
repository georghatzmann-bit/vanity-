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
use aegis_quarantine::{Entry, OwnProcess, Vault};

/// Test-Ordner unter dem langen, tatsächlichen Pfad: Unter Windows liefert der Temp-Ordner
/// oft Kurznamen (`RUNNER~1`), die die Quarantäne – richtig – als abweichenden Pfad ablehnt.
/// (Im Betrieb schreibt der Dienst Kurznamen vorher um.)
struct Home {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let text = real.to_string_lossy().into_owned();
        let path = text
            .strip_prefix(r"\\?\")
            .map_or(real.clone(), std::path::PathBuf::from);
        Self { _dir: dir, path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

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
    let home = Home::new();
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
        .quarantine(
            approve(&mut gate, &quarantine_plan(&eicar_path, &clock)),
            &OwnProcess,
        )
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
        .restore(
            approve(&mut gate, &restore_plan(&entries[0], &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert!(restored.failures.is_empty());
    assert_eq!(std::fs::read(&eicar_path).unwrap(), eicar());
    assert!(vault.list().unwrap().is_empty());

    // 4. Erneut isolieren, dann endgültig löschen – nur mit zweiter Bestätigung.
    vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&eicar_path, &clock)),
            &OwnProcess,
        )
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
        .delete_permanently(second.redeem(&plan, &mut gate).unwrap(), &OwnProcess)
        .unwrap();
    assert!(deleted.failures.is_empty());
    assert!(vault.list().unwrap().is_empty());
    assert!(!eicar_path.exists());
}

#[test]
fn ohne_ja_bleibt_alles_gleich() {
    let home = Home::new();
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
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "probe.bin", b"Inhalt der Probe").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&path, &clock)),
            &OwnProcess,
        )
        .unwrap();
    let entry = vault.list().unwrap().remove(0);

    // Ziel belegt → nichts überschrieben.
    write_fixture(home.path(), "probe.bin", b"neue Datei").unwrap();
    let out = vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
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
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
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
            .delete_permanently(
                approve(&mut gate, &restore_plan(&entry, &clock)),
                &OwnProcess
            )
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
    assert!(
        vault
            .restore(approve(&mut gate, &wrong), &OwnProcess)
            .is_err()
    );
    // Pfadteile als Kennung lehnt schon der Plan ab.
    let traversal = ActionPlan::builder(ActionKind::Restore)
        .target(Target::file(&entry.original_path))
        .parameter(param::QUARANTINE_ID, "../vault")
        .what("x")
        .why("x")
        .consequence("x")
        .undo(UndoHint::reversible("x"))
        .severity(RiskLevel::Info)
        .build(clock.now());
    assert!(traversal.is_err());
}

#[cfg(unix)]
#[test]
fn links_werden_nicht_isoliert() {
    let home = Home::new();
    let outside = tempfile::tempdir().unwrap();
    let target = write_fixture(outside.path(), "wichtig.txt", b"Nutzerdaten").unwrap();
    let link =
        aegis_core::testing::create_fixture_symlink(home.path(), "link.txt", &target).unwrap();
    let vault_dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let out = vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&link, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert!(std::fs::symlink_metadata(&link).is_ok());
    assert_eq!(std::fs::read(&target).unwrap(), b"Nutzerdaten");
}

#[test]
fn tresor_wieder_oeffnen_und_beschaedigte_daten() {
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.bin", b"Daten").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    {
        let vault = Vault::open(vault_dir.path()).unwrap();
        vault
            .quarantine(
                approve(&mut gate, &quarantine_plan(&path, &clock)),
                &OwnProcess,
            )
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
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
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

// ---------------------------------------------------------------------------------------
// Regressionstests aus dem P2-Sicherheits-Review (Links in Zwischenordnern, Hardlinks,
// Überschreiben, fehlende Ordner, Dateirechte).
// ---------------------------------------------------------------------------------------

/// Review-Fund B: Wird der ursprüngliche Ordner nach dem Isolieren durch einen Link auf einen
/// anderen Ordner ersetzt, darf das Wiederherstellen nicht dorthin schreiben.
#[cfg(unix)]
#[test]
fn wiederherstellen_folgt_keinem_link_im_ordner() {
    use aegis_core::testing::{create_fixture_symlink, remove_fixture};
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a/payload.dll", b"Bytes").unwrap();
    let protected = aegis_core::testing::create_fixture_dir(home.path(), "geschuetzt").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let out = vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&path, &clock)),
            &OwnProcess,
        )
        .unwrap();
    let entry = out.entries[0].clone();
    remove_fixture(home.path(), "a").unwrap();
    create_fixture_symlink(home.path(), "a", &protected).unwrap();
    let result = vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(result.failures.len(), 1, "{:?}", result.failures);
    assert!(
        !protected.join("payload.dll").exists(),
        "nichts durch den Link geschrieben"
    );
    assert_eq!(
        vault.list().unwrap(),
        vec![entry],
        "Eintrag bleibt im Tresor"
    );
}

/// Review-Fund C: Ein Link in einem Zwischenordner – der Plan zeigt einen anderen Pfad, als
/// tatsächlich entfernt würde. Abgelehnt, Original unverändert.
#[cfg(unix)]
#[test]
fn isolieren_folgt_keinem_link_im_ordner() {
    use aegis_core::testing::create_fixture_symlink;
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let real = write_fixture(home.path(), "echt/x.cfg", b"wichtig").unwrap();
    create_fixture_symlink(home.path(), "link", &home.path().join("echt")).unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let out = vault
        .quarantine(
            approve(
                &mut gate,
                &quarantine_plan(&home.path().join("link/x.cfg"), &clock),
            ),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert!(
        out.failures[0].1.contains("Verknüpfung"),
        "{:?}",
        out.failures
    );
    assert_eq!(std::fs::read(&real).unwrap(), b"wichtig");
    assert!(vault.list().unwrap().is_empty());
}

/// Dateien mit mehreren Namen (Hardlinks) werden nicht isoliert – der Inhalt bliebe unter
/// dem anderen Namen erreichbar.
#[test]
fn hardlinks_werden_nicht_isoliert() {
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.bin", b"Daten").unwrap();
    aegis_core::testing::create_fixture_hardlink(home.path(), "b.bin", "a.bin").unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let out = vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&path, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert!(
        out.failures[0].1.contains("Hardlinks"),
        "{:?}",
        out.failures
    );
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

/// Fehlt der ursprüngliche Ordner, wird er nicht angelegt; nichts überschrieben.
#[test]
fn wiederherstellen_legt_keine_ordner_an_und_ueberschreibt_nie() {
    use aegis_core::testing::remove_fixture;
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "sub/a.txt", b"alt").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let entry = vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&path, &clock)),
            &OwnProcess,
        )
        .unwrap()
        .entries
        .remove(0);
    remove_fixture(home.path(), "sub").unwrap();
    let out = vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert!(
        out.failures[0].1.contains("existiert nicht mehr"),
        "{:?}",
        out.failures
    );
    assert!(!home.path().join("sub").exists());
    // Ordner wieder da, aber Ziel belegt: nichts überschrieben.
    write_fixture(home.path(), "sub/a.txt", b"neu").unwrap();
    let out = vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(out.failures.len(), 1);
    assert_eq!(std::fs::read(&path).unwrap(), b"neu");
    // Ziel frei: klappt, Tresor-Teildateien sind weg.
    remove_fixture(home.path(), "sub/a.txt").unwrap();
    vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &OwnProcess,
        )
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"alt");
    let leftovers: Vec<_> = std::fs::read_dir(vault_dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != "vault.key")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// Review-Fund (niedrig): Schlüssel und Tresor-Ordner nur für den Eigentümer (Unix).
#[cfg(unix)]
#[test]
fn schluessel_nur_fuer_eigentuemer() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let dir = base.path().join("q");
    let _vault = Vault::open(&dir).unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.join("vault.key")), 0o600);
    assert_eq!(mode(&dir), 0o700);
}

/// Re-Review N4: Einträge gehören dem Konto, das isoliert hat – ein anderes Konto kann sie
/// weder wiederherstellen noch endgültig löschen.
#[test]
fn eintraege_gehoeren_dem_konto() {
    struct Account(&'static str);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some(self.0.to_owned())
        }
    }
    let home = Home::new();
    let vault_dir = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.txt", b"Daten von A").unwrap();
    let clock = ManualClock::default();
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let vault = Vault::open(vault_dir.path()).unwrap();
    let entry = vault
        .quarantine(
            approve(&mut gate, &quarantine_plan(&path, &clock)),
            &Account("S-1-A"),
        )
        .unwrap()
        .entries
        .remove(0);
    assert_eq!(entry.owner.as_deref(), Some("S-1-A"));
    assert!(entry.visible_to(Some("S-1-A")));
    assert!(!entry.visible_to(Some("S-1-B")));
    assert!(!entry.visible_to(None));
    let out = vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &Account("S-1-B"),
        )
        .unwrap();
    assert!(
        out.failures[0].1.contains("anderen Konto"),
        "{:?}",
        out.failures
    );
    assert!(!path.exists());
    vault
        .restore(
            approve(&mut gate, &restore_plan(&entry, &clock)),
            &Account("S-1-A"),
        )
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"Daten von A");
}

#[test]
fn schluessel_unter_windows_an_den_rechner_gebunden() {
    let dir = tempfile::tempdir().unwrap();
    // Alter, ungeschützter Schlüssel (32 Byte) wird beim Öffnen übernommen.
    aegis_core::testing::write_fixture(dir.path(), "vault.key", &[7u8; 32]).unwrap();
    drop(aegis_quarantine::Vault::open(dir.path()).unwrap());
    let bytes = std::fs::read(dir.path().join("vault.key")).unwrap();
    if cfg!(windows) {
        assert!(bytes.starts_with(b"AEGISK2\n"), "geschützt neu geschrieben");
        assert!(
            !bytes.windows(32).any(|w| w == [7u8; 32]),
            "kein Klartext-Schlüssel"
        );
    } else {
        assert_eq!(bytes, [7u8; 32]);
    }
    // Erneut öffnen geht (geschützte Form wird gelesen).
    drop(aegis_quarantine::Vault::open(dir.path()).unwrap());
    // Beschädigter Schlüssel: Fehler statt neuem Schlüssel (Einträge blieben sonst unlesbar).
    let broken = tempfile::tempdir().unwrap();
    aegis_core::testing::write_fixture(broken.path(), "vault.key", b"AEGISK2\nkaputt").unwrap();
    assert!(aegis_quarantine::Vault::open(broken.path()).is_err());
}
