//! Prüfprozess: Fremde Dateien werden in `aegis-scanworker` geprüft, nicht im Dienst.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use aegis_core::risk::RiskLevel;
use aegis_core::testing::{DirSnapshot, assert_unchanged, eicar, write_fixture};
use aegis_quarantine::OwnProcess;
use aegis_service::worker::Scanner;

fn worker() -> Scanner {
    Scanner::Worker {
        exe: PathBuf::from(env!("CARGO_BIN_EXE_aegis-scanworker")),
        clamav: false,
    }
}

#[test]
fn pruefprozess_findet_eicar_und_veraendert_nichts() {
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "sub/eicar.com", &eicar()).unwrap();
    write_fixture(home.path(), "harmlos.txt", b"Hallo").unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();
    let report = worker()
        .scan(&[home.path().to_path_buf()], &OwnProcess)
        .unwrap();
    assert_eq!(report.findings.len(), 2);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.path == path && f.risk == RiskLevel::Dangerous)
    );
    let findings = worker().examine(&[path], &OwnProcess).unwrap();
    assert_eq!(findings[0].risk, RiskLevel::Dangerous);
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

/// Ein abstürzender Prüfprozess (harmloser Ersatz) bringt den Dienst nicht zu Fall – die
/// Datei gilt als „nicht prüfbar“.
#[cfg(unix)]
#[test]
fn absturz_des_pruefprozesses_ist_nicht_pruefbar() {
    let dir = tempfile::tempdir().unwrap();
    write_fixture(
        dir.path(),
        "kaputt",
        b"#!/bin/sh\ncat > /dev/null\nexit 101\n",
    )
    .unwrap();
    aegis_core::testing::set_fixture_mode(dir.path(), "kaputt", 0o700).unwrap();
    let broken = Scanner::Worker {
        exe: dir.path().join("kaputt"),
        clamav: false,
    };
    let err = broken
        .scan(&[dir.path().to_path_buf()], &OwnProcess)
        .unwrap_err();
    assert!(err.contains("abgebrochen"), "{err}");
    let f = aegis_service::handler::examine_as_user(&broken, &[dir.path().join("x")], &OwnProcess);
    assert_eq!(f[0].risk, RiskLevel::Info);
    assert!(
        f[0].not_scannable
            .as_deref()
            .unwrap()
            .contains("abgebrochen")
    );
}

/// Hintergrundprüfungen lesen nie mit den Rechten des Dienstes: Ohne angemeldeten
/// Profil-Besitzer gilt das „nur Nutzer“-Token – eine Datei, die nur ihr Besitzer lesen darf
/// (Temp-Ordner des Kontos), bleibt unlesbar; allgemein lesbare Dateien werden geprüft.
#[cfg(windows)]
#[test]
fn hintergrund_liest_nur_was_alle_nutzer_lesen_duerfen() {
    use aegis_service::worker::BackgroundAccess;
    let home = tempfile::tempdir().unwrap();
    let private = write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let shared = BackgroundAccess {
        profile: None,
        require_owner: false,
    };
    let findings = worker()
        .examine(std::slice::from_ref(&private), &shared)
        .unwrap();
    assert!(
        findings[0].not_scannable.is_some(),
        "privat: {:?}",
        findings[0]
    );
    assert!(findings[0].risk < RiskLevel::Dangerous);
    let windir =
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let public = windir.join(r"System32\drivers\etc\hosts");
    let findings = worker().examine(&[public], &shared).unwrap();
    assert!(findings[0].not_scannable.is_none(), "{:?}", findings[0]);
    // Mit eigenen Rechten lesbar (Gegenprobe).
    let own = worker().examine(&[private], &OwnProcess).unwrap();
    assert_eq!(own[0].risk, RiskLevel::Dangerous);
}

#[test]
fn speicher_wird_im_pruefprozess_geprueft() {
    use base64::Engine as _;
    let mut memory = vec![0x90u8; 4096];
    memory.extend_from_slice(&eicar());
    memory.extend_from_slice(&[0u8; 512]);
    let blocks = vec![
        aegis_service::worker::MemoryBlock {
            label: "Speicher von test.exe (PID 1) @ 0x1000".into(),
            data: base64::engine::general_purpose::STANDARD.encode(&memory),
        },
        aegis_service::worker::MemoryBlock {
            label: "Speicher von test.exe (PID 1) @ 0x9000".into(),
            data: base64::engine::general_purpose::STANDARD.encode([0u8; 1024]),
        },
    ];
    let findings = worker().scan_memory(blocks, &OwnProcess).unwrap();
    assert_eq!(findings.len(), 2);
    assert_eq!(findings[0].risk, RiskLevel::Dangerous);
    assert!(findings[0].path.to_string_lossy().contains("@ 0x1000"));
    assert!(findings[1].risk <= RiskLevel::Info);
}

#[test]
fn entropie_wird_im_pruefprozess_gemessen() {
    let dir = tempfile::tempdir().unwrap();
    let text = write_fixture(
        dir.path(),
        "notiz.txt",
        "Einkaufsliste: Brot, Milch, Käse. ".repeat(300).as_bytes(),
    )
    .unwrap();
    let mut noise = Vec::with_capacity(65536);
    let mut x: u32 = 88_172_645;
    for _ in 0..65536 {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        noise.push(x.to_le_bytes()[1]);
    }
    let enc = write_fixture(dir.path(), "notiz.txt.crypt", &noise).unwrap();
    let missing = dir.path().join("fehlt.txt");
    let values = worker()
        .entropy(&[text, enc, missing], &OwnProcess)
        .unwrap();
    assert!(values[0].unwrap() < 5.0, "{values:?}");
    assert!(values[1].unwrap() > 7.5, "{values:?}");
    assert_eq!(values[2], None);
}
