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
