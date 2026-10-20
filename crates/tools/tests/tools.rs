//! Werkzeuge mit harmlosen Dummy-Dateien: Vorschau verändert nichts, Ausführen nur mit
//! Freigabe genau dieser Vorschau, alles lässt sich zurücknehmen.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use aegis_core::testing::{
    DirSnapshot, assert_unchanged, create_fixture_dir, set_fixture_modified, write_fixture,
};
use aegis_tools::category::Category;
use aegis_tools::exec::{Status, execute, undo};
use aegis_tools::journal::Journal;
use aegis_tools::plan::{Approved, Refused};
use aegis_tools::platform::LocalPlatform;
use aegis_tools::rules::{Condition, Rule, plan_for_rule};
use aegis_tools::tools::{cleaner, duplicates, empty_folders, large_old, sort_downloads, space};

const NOW_OFFSET: i64 = 3600;

fn now() -> i64 {
    aegis_tools::walk::unix(Ok(SystemTime::now())) + NOW_OFFSET
}

fn setup() -> (tempfile::TempDir, PathBuf, LocalPlatform) {
    let dir = tempfile::tempdir().unwrap();
    let downloads = dir.path().join("Downloads");
    let trash = dir.path().join("trash");
    (dir, downloads, LocalPlatform { trash })
}

fn age(dir: &Path, name: &str, days: u64) {
    set_fixture_modified(
        dir,
        name,
        SystemTime::now() - Duration::from_secs(days * 86_400),
    )
    .unwrap();
}

#[test]
fn sortierer_nichts_ohne_ja_dann_ausfuehren_und_rueckgaengig() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/Urlaub.jpg", b"bild").unwrap();
    write_fixture(dir.path(), "Downloads/Rechnung.pdf", b"pdf").unwrap();
    write_fixture(dir.path(), "Downloads/halb.zip.crdownload", b"x").unwrap();
    // Ein Ziel, das schon belegt ist: wird nie überschrieben.
    write_fixture(dir.path(), "Downloads/Bilder/Urlaub.jpg", b"anderes").unwrap();
    let before = DirSnapshot::capture(dir.path()).unwrap();
    let plan = sort_downloads(&downloads, &[], now());
    assert_eq!(plan.ops.len(), 2, "{:?}", plan.ops);
    assert_unchanged(&before, &DirSnapshot::capture(dir.path()).unwrap());

    // Falsche Prüfsumme oder abgelaufene Vorschau: nichts.
    assert_eq!(
        Approved::by_user(&plan, "falsch", vec![], now()).unwrap_err(),
        Refused::Digest
    );
    assert_eq!(
        Approved::by_user(&plan, &plan.digest(), vec![], now() + 31 * 60).unwrap_err(),
        Refused::Expired
    );
    assert_unchanged(&before, &DirSnapshot::capture(dir.path()).unwrap());

    let approved = Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap();
    let mut run = execute(approved, &platform, now());
    assert_eq!(run.done(), 2, "{:?}", run.items);
    assert!(downloads.join("Bilder/Urlaub (2).jpg").exists());
    assert_eq!(
        std::fs::read(downloads.join("Bilder/Urlaub.jpg")).unwrap(),
        b"anderes"
    );
    assert!(downloads.join("Dokumente/Rechnung.pdf").exists());
    assert!(downloads.join("halb.zip.crdownload").exists());

    let journal = Journal::new(dir.path().join("journal.json"));
    journal.append(run.clone()).unwrap();
    assert!(undo(&mut run, &platform, now()).is_empty());
    journal.replace(&run).unwrap();
    assert!(downloads.join("Urlaub.jpg").exists());
    assert!(downloads.join("Rechnung.pdf").exists());
    assert_eq!(journal.load()[0].items[0].status, Status::Undone);
}

#[test]
fn abgewaehlt_und_veraendert_wird_uebersprungen() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/a.txt", b"a").unwrap();
    write_fixture(dir.path(), "Downloads/b.txt", b"b").unwrap();
    let plan = sort_downloads(&downloads, &[Category::Documents], now());
    assert_eq!(plan.ops.len(), 2);
    // Nach der Vorschau verändert → übersprungen.
    write_fixture(dir.path(), "Downloads/a.txt", b"anders").unwrap();
    // b.txt wird abgewählt (Reihenfolge der Schritte ist nicht festgelegt).
    let b = plan
        .ops
        .iter()
        .position(|op| op.label().contains("b.txt"))
        .unwrap();
    let approved = Approved::by_user(&plan, &plan.digest(), vec![b], now()).unwrap();
    let run = execute(approved, &platform, now());
    assert_eq!(run.done(), 0);
    assert!(run.items.iter().all(|i| i.status == Status::Skipped));
    assert!(downloads.join("a.txt").exists() && downloads.join("b.txt").exists());
}

#[test]
fn regel_handelt_nur_eingeschaltet() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/tool.zip", b"zip").unwrap();
    let mut rule = Rule {
        id: String::new(),
        name: "Archive".into(),
        enabled: false,
        watch: true,
        folder: downloads.clone(),
        condition: Condition {
            extensions: vec!["zip".into()],
            ..Condition::default()
        },
        target: "Archive".into(),
    }
    .validated()
    .unwrap();
    let plan = plan_for_rule(&rule, now(), 60);
    assert!(plan.ops.is_empty(), "ausgeschaltete Regel plant nichts");
    rule.enabled = true;
    let plan = plan_for_rule(&rule, now(), 60);
    assert_eq!(plan.ops.len(), 1);
    let mut other = rule.clone();
    other.id = "andere".into();
    assert_eq!(Approved::by_rule(&plan, &other).unwrap_err(), Refused::Rule);
    let run = execute(Approved::by_rule(&plan, &rule).unwrap(), &platform, now());
    assert_eq!(run.done(), 1);
    assert!(downloads.join("Archive/tool.zip").exists());
}

#[test]
fn duplikate_alte_dateien_cleaner_in_den_papierkorb_und_zurueck() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/a/foto.jpg", b"gleicher inhalt").unwrap();
    write_fixture(dir.path(), "Downloads/b/foto-kopie.jpg", b"gleicher inhalt").unwrap();
    write_fixture(dir.path(), "Downloads/c/anders.jpg", b"anderer inhalt!").unwrap();
    age(dir.path(), "Downloads/a/foto.jpg", 10);
    let (groups, plan) = duplicates(std::slice::from_ref(&downloads), 1, now());
    assert_eq!(groups.len(), 1);
    assert!(
        groups[0].files[0].path.ends_with("a/foto.jpg"),
        "älteste bleibt"
    );
    assert_eq!(plan.ops.len(), 1);
    let mut run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    assert_eq!(run.done(), 1);
    assert!(!downloads.join("b/foto-kopie.jpg").exists());
    assert!(undo(&mut run, &platform, now()).is_empty());
    assert!(downloads.join("b/foto-kopie.jpg").exists());

    write_fixture(dir.path(), "Downloads/gross.bin", &vec![0u8; 4096]).unwrap();
    age(dir.path(), "Downloads/gross.bin", 400);
    let plan = large_old(std::slice::from_ref(&downloads), 1000, 365, now());
    assert_eq!(plan.ops.len(), 1);

    let temp = dir.path().join("Temp");
    write_fixture(dir.path(), "Temp/alt.tmp", b"x").unwrap();
    write_fixture(dir.path(), "Temp/neu.tmp", b"y").unwrap();
    age(dir.path(), "Temp/alt.tmp", 5);
    let plan = cleaner(&[temp], 2, now());
    assert_eq!(plan.ops.len(), 1, "{:?}", plan.ops);
}

#[test]
fn leere_ordner_und_speicherplatz() {
    let (dir, downloads, platform) = setup();
    create_fixture_dir(dir.path(), "Downloads").unwrap();
    create_fixture_dir(dir.path(), "Downloads/leer").unwrap();
    create_fixture_dir(dir.path(), "Downloads/leer/auch-leer").unwrap();
    write_fixture(dir.path(), "Downloads/voll/datei.txt", b"inhalt").unwrap();
    let plan = empty_folders(&downloads, now());
    assert_eq!(plan.ops.len(), 2, "{:?}", plan.ops);
    let mut run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    assert_eq!(run.done(), 2);
    assert!(!downloads.join("leer").exists());
    assert!(undo(&mut run, &platform, now()).is_empty());
    assert!(downloads.join("leer/auch-leer").is_dir());

    let s = space(&downloads, None);
    assert_eq!(s.total, 6);
    assert_eq!(s.files, 1);
    assert!(s.children[0].path.ends_with("voll"));
}

#[test]
fn rueckgaengig_ueberschreibt_nie() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/brief.docx", b"v1").unwrap();
    let plan = sort_downloads(&downloads, &[], now());
    let mut run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    // Am alten Ort entsteht inzwischen eine neue Datei gleichen Namens.
    write_fixture(dir.path(), "Downloads/brief.docx", b"neu").unwrap();
    let errors = undo(&mut run, &platform, now());
    assert_eq!(errors.len(), 1);
    assert_eq!(std::fs::read(downloads.join("brief.docx")).unwrap(), b"neu");
    assert!(downloads.join("Dokumente/brief.docx").exists());
}
