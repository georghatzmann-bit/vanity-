//! Mini-Sandbox (Stufe 2) unter Windows mit dem **harmlosen** Simulator (`examples/
//! lab_simulator.rs`): läuft isoliert im AppContainer, der Bericht listet seine Dateien.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(windows)]

use std::path::PathBuf;

use aegis_sandbox::mini::{MiniRun, run};
use aegis_sandbox::report::{Change, RunEnd};
use aegis_winffi::inspect::Hive;
use aegis_winffi::sandbox::{
    UserToken, appcontainer_sid, create_dir_with_sddl, delete_appcontainer_profile,
    ensure_appcontainer_profile, lab_appcontainer_name,
};

fn simulator() -> Vec<u8> {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().join("examples");
    std::fs::read(dir.join("lab_simulator.exe")).expect("Beispiel lab_simulator gebaut")
}

#[test]
fn simulator_laeuft_isoliert_und_bericht_listet_dateien() {
    let temp = tempfile::tempdir().unwrap();
    let container = lab_appcontainer_name("test-lauf");
    ensure_appcontainer_profile(&container).unwrap();
    let sid = appcontainer_sid(&container).unwrap();
    assert!(sid.starts_with("S-1-15-2-"), "{sid}");
    let user = aegis_winffi::system::process_user_sid(std::process::id()).unwrap();
    let work = temp.path().join("labor");
    // Dieselbe Zugriffsliste wie im Betrieb.
    create_dir_with_sddl(
        &work,
        &aegis_sandbox::acl::mini_work_dir(&sid, &user).unwrap(),
    )
    .unwrap();
    let sample =
        aegis_core::testing::write_fixture(&work, "lab_simulator.exe", &simulator()).unwrap();
    let token = UserToken::for_console().unwrap();
    let mut seen_pids = false;
    let report = run(
        &MiniRun {
            sample: sample.clone(),
            work_dir: work.clone(),
            seconds: 20,
            hive: Hive::CurrentUser,
            sample_name: "lab_simulator.exe".into(),
            sha256: None,
            container: container.clone(),
        },
        &token,
        |pids| seen_pids |= !pids.is_empty(),
    );
    assert!(
        matches!(report.end, RunEnd::Exited { code: 0 }),
        "{:?} / {:?}",
        report.end,
        report.notes
    );
    assert!(seen_pids);
    let created = |name: &str| {
        report
            .files
            .iter()
            .find(|f| f.path.ends_with(name) && f.change == Change::Created)
            .unwrap_or_else(|| panic!("{name} fehlt im Bericht: {:?}", report.files))
            .clone()
    };
    created("sim-notiz.txt");
    assert!(created("sim-daten.bin").entropy.unwrap() > 7.9);
    assert!(
        report
            .processes
            .iter()
            .any(|p| p.image.ends_with("lab_simulator.exe"))
    );
    // Ohne Netz: der Versuch zu 127.0.0.1:9 kam nicht durch.
    assert!(report.network.iter().all(|n| n.blocked));
    // Kein Autostart-Eintrag (nicht versucht bzw. im AppContainer verweigert).
    assert!(report.registry.is_empty(), "{:?}", report.registry);
    let a = report.assess();
    assert!(
        a.summary_de.starts_with("Dieses Programm") || a.summary_de.contains("nichts Auffälliges")
    );
    let _ = PathBuf::new();
    delete_appcontainer_profile(&container).unwrap();
    assert!(delete_appcontainer_profile("Fremd.Profil").is_err());
}
