//! Ende-zu-Ende: Die Engine erkennt EICAR und Prüfmarken – und verändert dabei nichts
//! („Nichts ohne Ja“, Zustand byte-genau gleich).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aegis_core::risk::RiskLevel;
use aegis_core::testing::{DirSnapshot, assert_unchanged, eicar, write_fixture};
use aegis_engine::hashlist::HashList;
use aegis_engine::{Category, Engine, EngineConfig, Recommendation};

fn marker() -> Vec<u8> {
    [
        b"AEGIS-HARMLESS-TEST-".as_slice(),
        b"SIGNATURE-DANGEROUS-7c1e",
    ]
    .concat()
}

#[test]
fn eicar_wird_erkannt_und_nichts_veraendert() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let eicar_path = write_fixture(root, "downloads/eicar.com", &eicar()).unwrap();
    write_fixture(root, "downloads/notizen.txt", b"Einkaufsliste: Milch, Brot").unwrap();
    write_fixture(root, "downloads/Rechnung.pdf.exe", b"kein echtes Programm").unwrap();
    write_fixture(root, "marker.bin", &marker()).unwrap();
    write_fixture(root, "tief/a/b/c/leer.dat", b"").unwrap();

    let before = DirSnapshot::capture(root).unwrap();
    let engine = Engine::with_builtin_rules().unwrap();
    let report = engine.scan_paths(&[root.to_path_buf()]);
    let after = DirSnapshot::capture(root).unwrap();
    assert_unchanged(&before, &after);

    assert_eq!(report.findings.len(), 5);
    assert!(report.skipped.is_empty());
    let by_name = |n: &str| {
        report
            .findings
            .iter()
            .find(|f| f.path.ends_with(n))
            .unwrap()
    };

    let e = by_name("eicar.com");
    assert_eq!(e.path, eicar_path);
    assert_eq!(
        (e.risk, e.category),
        (RiskLevel::Dangerous, Category::TestFile)
    );
    assert_eq!(e.recommendation, Recommendation::Quarantine);
    assert_eq!(
        e.sha256.as_deref(),
        Some("275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f")
    );
    assert!(e.summary_de.contains("EICAR"));

    assert_eq!(by_name("marker.bin").risk, RiskLevel::Dangerous);
    assert_eq!(by_name("notizen.txt").risk, RiskLevel::Clean);
    let doppelt = by_name("Rechnung.pdf.exe");
    assert!(
        doppelt
            .reasons
            .iter()
            .any(|r| r.code == "name.double_extension")
    );
    assert!(
        doppelt.risk < RiskLevel::Dangerous,
        "Heuristik allein ist nie „Gefährlich“"
    );
    assert_eq!(report.notable().count(), 3);
}

#[test]
fn hash_liste_und_grenzen() {
    let dir = tempfile::tempdir().unwrap();
    let p = write_fixture(dir.path(), "probe.bin", b"bekannt-schlecht (Test)").unwrap();
    let probe = Engine::with_builtin_rules().unwrap().scan_file(&p);
    let list = HashList::parse(
        "testliste",
        &format!("{} Test.Eintrag\n", probe.sha256.unwrap()),
    );
    let engine = Engine::new(EngineConfig {
        hash_lists: vec![list],
        limits: aegis_engine::ScanLimits {
            max_analyze_bytes: 4,
            ..Default::default()
        },
        ..EngineConfig::default()
    });
    let f = engine.scan_file(&p);
    assert_eq!(f.risk, RiskLevel::Dangerous);
    assert!(f.reasons.iter().any(|r| r.code == "hashlist.match"));
    assert!(
        f.not_scannable
            .as_deref()
            .unwrap()
            .starts_with("Nur teilweise geprüft")
    );
}

#[test]
fn nicht_lesbares_wird_ehrlich_gemeldet() {
    let engine = Engine::with_builtin_rules().unwrap();
    let f = engine.scan_file(std::path::Path::new("/gibt/es/nicht/x.exe"));
    assert!(f.sha256.is_none());
    assert!(f.not_scannable.unwrap().starts_with("Nicht lesbar"));
    let report = engine.scan_paths(&["/gibt/es/nicht".into()]);
    assert_eq!(report.skipped.len(), 1);
}

#[cfg(unix)]
#[test]
fn links_werden_nicht_verfolgt() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write_fixture(outside.path(), "geheim.txt", b"x").unwrap();
    aegis_core::testing::create_fixture_symlink(dir.path(), "link", outside.path()).unwrap();
    let report = Engine::with_builtin_rules()
        .unwrap()
        .scan_paths(&[dir.path().to_path_buf()]);
    assert!(report.findings.is_empty());
    assert_eq!(report.skipped.len(), 1);
    assert!(report.skipped[0].reason.contains("Link"));
}
