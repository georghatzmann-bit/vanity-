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
use aegis_tools::platform::Platform as _;
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
        watch_since: Some(0),
    }
    .validated()
    .unwrap();
    let plan = plan_for_rule(&rule, now(), 60);
    assert!(plan.ops.is_empty(), "ausgeschaltete Regel plant nichts");
    rule.enabled = true;
    // Eben erst „im Hintergrund“ eingeschaltet: der Bestand bleibt (nur neue Dateien).
    rule.watch_since = Some(now());
    assert!(plan_for_rule(&rule, now(), 60).ops.is_empty());
    rule.watch_since = Some(0);
    let plan = plan_for_rule(&rule, now(), 60);
    assert_eq!(plan.ops.len(), 1);
    let mut other = rule.clone();
    other.id = "andere".into();
    assert_eq!(Approved::by_rule(&plan, &other).unwrap_err(), Refused::Rule);
    let mut paused = rule.clone();
    paused.watch = false;
    assert_eq!(
        Approved::by_rule(&plan, &paused).unwrap_err(),
        Refused::Rule
    );
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

#[test]
fn shredder_nur_mit_zweiter_bestaetigung_und_ohne_rueckgaengig() {
    use aegis_tools::plan::{Op, Plan, Tool};
    let (dir, downloads, platform) = setup();
    let path = write_fixture(dir.path(), "Downloads/geheim.txt", b"vertraulich").unwrap();
    let (size, modified) = aegis_tools::walk::file_state(&path).unwrap();
    let plan = Plan::new(
        Tool::Shredder,
        vec![Op::Shred {
            path: path.clone(),
            size,
            modified,
        }],
        now(),
    );
    assert!(plan.needs_final());
    // Ein „Ausführen“ allein reicht nicht, auch keine Regel, auch keine falsche Kennung.
    assert_eq!(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap_err(),
        Refused::NeedsFinal
    );
    let expected = aegis_tools::plan::token();
    assert_eq!(
        Approved::by_user_final(&plan, &plan.digest(), vec![], now(), &expected, "falsch")
            .unwrap_err(),
        Refused::NeedsFinal
    );
    assert!(path.exists());
    let approved =
        Approved::by_user_final(&plan, &plan.digest(), vec![], now(), &expected, &expected)
            .unwrap();
    let mut run = execute(approved, &platform, now());
    assert_eq!(run.done(), 1);
    assert!(!path.exists());
    assert!(
        std::fs::read_dir(&downloads).unwrap().next().is_none(),
        "kein Rest"
    );
    assert!(run.items[0].undo.is_none());
    undo(&mut run, &platform, now());
    assert!(!path.exists());
}

#[test]
fn umbenenner_vorschau_ausfuehren_rueckgaengig() {
    use aegis_tools::rename::{Options, plan};
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/IMG_2.jpg", b"b").unwrap();
    write_fixture(dir.path(), "Downloads/IMG_1.jpg", b"a").unwrap();
    write_fixture(dir.path(), "Downloads/Urlaub 02.jpg", b"schon da").unwrap();
    let before = DirSnapshot::capture(dir.path()).unwrap();
    let options = Options {
        pattern: "Urlaub {n}".into(),
        start: 1,
        digits: 2,
        ..Options::default()
    };
    let p = plan(&downloads, &options, now());
    assert_unchanged(&before, &DirSnapshot::capture(dir.path()).unwrap());
    // IMG_1 → Urlaub 01; IMG_2 → „Urlaub 02“ gibt es schon → übergangen; die vorhandene
    // „Urlaub 02“ bekommt die nächste Nummer. Nichts wird überschrieben.
    assert_eq!(p.ops.len(), 2, "{:?}", p.ops);
    let mut run = execute(
        Approved::by_user(&p, &p.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    assert_eq!(run.done(), 2);
    assert!(downloads.join("Urlaub 01.jpg").exists());
    assert!(downloads.join("IMG_2.jpg").exists());
    assert_eq!(
        std::fs::read(downloads.join("Urlaub 03.jpg")).unwrap(),
        b"schon da"
    );
    assert!(undo(&mut run, &platform, now()).is_empty());
    assert!(downloads.join("IMG_1.jpg").exists());
    assert_eq!(
        std::fs::read(downloads.join("Urlaub 02.jpg")).unwrap(),
        b"schon da"
    );
}

#[test]
fn schalter_nur_aus_der_festen_liste_mit_rueckgaengig() {
    use aegis_tools::plan::{Op, Plan, Tool};
    use aegis_tools::tweaks::Value;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct Fake(RefCell<HashMap<(String, String), Value>>);
    impl aegis_tools::platform::Platform for Fake {
        fn recycle(&self, _: &Path) -> std::io::Result<aegis_tools::platform::Recycled> {
            Err(std::io::Error::other("x"))
        }
        fn restore(&self, _: &aegis_tools::platform::Recycled, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::other("x"))
        }
        fn wallpaper(&self) -> std::io::Result<PathBuf> {
            Err(std::io::Error::other("x"))
        }
        fn set_wallpaper(&self, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::other("x"))
        }
        fn autostart_enabled(&self, _: &aegis_tools::autostart::EntryRef) -> std::io::Result<bool> {
            Err(std::io::Error::other("x"))
        }
        fn set_autostart(
            &self,
            _: &aegis_tools::autostart::EntryRef,
            _: bool,
        ) -> std::io::Result<()> {
            Err(std::io::Error::other("x"))
        }
        fn apply_desktop_layout(
            &self,
            _: &aegis_tools::desktop::Layout,
        ) -> std::io::Result<aegis_tools::desktop::Layout> {
            Err(std::io::Error::other("x"))
        }
        fn registry_get(&self, key: &str, name: &str) -> std::io::Result<Value> {
            Ok(self
                .0
                .borrow()
                .get(&(key.to_owned(), name.to_owned()))
                .cloned()
                .unwrap_or(Value::Absent))
        }
        fn registry_set(&self, key: &str, name: &str, value: &Value) -> std::io::Result<()> {
            self.0
                .borrow_mut()
                .insert((key.to_owned(), name.to_owned()), value.clone());
            Ok(())
        }
    }

    let fake = Fake(RefCell::new(HashMap::new()));
    let ext = aegis_tools::tweaks::find("show_extensions").unwrap();
    let plan = Plan::new(
        Tool::ExplorerTweaks,
        vec![
            Op::Registry {
                key: ext.key.into(),
                name: ext.name.into(),
                value: ext.on.owned(),
            },
            // Nicht in der Liste → wird nie gesetzt.
            Op::Registry {
                key: r"Software\Microsoft\Windows\CurrentVersion\Run".into(),
                name: "Boese".into(),
                value: Value::Text("x.exe".into()),
            },
        ],
        now(),
    );
    let mut run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &fake,
        now(),
    );
    assert_eq!(run.done(), 1);
    assert_eq!(run.items[1].status, Status::Skipped);
    assert_eq!(
        fake.registry_get(ext.key, ext.name).unwrap(),
        Value::Dword(0)
    );
    assert!(undo(&mut run, &fake, now()).is_empty());
    assert_eq!(fake.registry_get(ext.key, ext.name).unwrap(), Value::Absent);
}

#[test]
fn duplikate_verschachtelte_ordner_nie_die_einzige_kopie() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/einzig.bin", b"nur einmal da").unwrap();
    write_fixture(dir.path(), "Downloads/sub/auch.bin", b"auch nur einmal").unwrap();
    // Dieselbe Wurzel doppelt und ein Unterordner: keine Gruppe, kein Schritt.
    let roots = vec![downloads.clone(), downloads.clone(), downloads.join("sub")];
    let (groups, plan) = duplicates(&roots, 1, now());
    assert!(groups.is_empty(), "{groups:?}");
    assert!(plan.ops.is_empty());
    let _ = platform;
}

#[cfg(unix)]
#[test]
fn zielordner_als_link_wird_nie_verfolgt() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/a.zip", b"zip").unwrap();
    create_fixture_dir(dir.path(), "aussen").unwrap();
    // `Downloads/Archive` zeigt woandershin: der Schritt darf dort nichts ablegen.
    aegis_core::testing::create_fixture_symlink(
        dir.path(),
        "Downloads/Archive",
        &dir.path().join("aussen"),
    )
    .unwrap();
    let plan = sort_downloads(&downloads, &[Category::Archives], now());
    assert_eq!(plan.ops.len(), 1, "{:?}", plan.ops);
    let run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    assert_eq!(run.done(), 0, "{:?}", run.items);
    assert!(downloads.join("a.zip").exists());
    assert!(!dir.path().join("aussen/a.zip").exists());
    // Ein gewählter Ordner, der selbst ein Link ist, ist kein erlaubter Ort.
    assert!(!aegis_tools::guard::allowed(&downloads.join("Archive")));
}

#[test]
fn leere_pruefsumme_gibt_keine_freigabe() {
    let plan = sort_downloads(Path::new("/nicht/vorhanden"), &[], now());
    assert!(Approved::by_user(&plan, "", vec![], now()).is_err());
}

#[test]
fn kaputtes_protokoll_wird_beiseitegelegt_nicht_ueberschrieben() {
    let (dir, downloads, platform) = setup();
    write_fixture(dir.path(), "Downloads/x.pdf", b"pdf").unwrap();
    write_fixture(dir.path(), "journal.json", b"[{\"kaputt\"").unwrap();
    let journal = Journal::new(dir.path().join("journal.json"));
    let plan = sort_downloads(&downloads, &[], now());
    let run = execute(
        Approved::by_user(&plan, &plan.digest(), vec![], now()).unwrap(),
        &platform,
        now(),
    );
    journal.append(run).unwrap();
    assert_eq!(journal.load().len(), 1);
    let aside = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("broken-"))
        .count();
    assert_eq!(aside, 1, "unlesbare Fassung bleibt erhalten");
}

#[cfg(windows)]
#[test]
fn windows_papierkorb_und_zurueck() {
    use aegis_tools::win::WindowsPlatform;
    let dir = tempfile::tempdir().unwrap();
    let file = write_fixture(dir.path(), "papierkorb-test.txt", b"harmlos").unwrap();
    let platform = WindowsPlatform;
    let item = platform.recycle(&file).unwrap();
    assert!(!file.exists());
    platform.restore(&item, &file).unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"harmlos");
}
