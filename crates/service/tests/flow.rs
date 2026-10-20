//! Ablauf über das echte Protokoll (JSON wie von der Oberfläche).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Cursor;

use aegis_core::audit::{AuditLog, verify};
use aegis_core::consent::{ConsentConfig, ConsentGate};
use aegis_core::testing::{DirSnapshot, ManualClock, assert_unchanged, eicar, write_fixture};
use aegis_core::time::Duration;
use aegis_engine::Engine;
use aegis_quarantine::{OwnProcess, Vault};
use aegis_service::handler::harden::{HardenSystem, Raw, Step};
use aegis_service::{Request, Service};
use serde_json::{Value, json};

struct Harness {
    service: Service<ManualClock, Vec<u8>>,
    clock: ManualClock,
    _vault_dir: tempfile::TempDir,
}

fn harness() -> Harness {
    let vault_dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let service = Service::new(
        Engine::with_builtin_rules().unwrap(),
        Vault::open(vault_dir.path()).unwrap(),
        gate,
        AuditLog::new(Vec::new()),
    );
    Harness {
        service,
        clock,
        _vault_dir: vault_dir,
    }
}

impl Harness {
    /// Sendet JSON wie die Oberfläche und liefert die Antwort als JSON.
    fn send(&mut self, request: Value) -> Value {
        let req: Request = serde_json::from_value(request).unwrap();
        serde_json::to_value(self.service.handle(req, &OwnProcess)).unwrap()
    }

    fn answer(&mut self, proposal: &Value, decision: &str) -> Value {
        let p = &proposal["proposal"];
        self.send(json!({
            "type": "decide",
            "plan_id": p["ticket"]["id"],
            "digest": p["ticket"]["digest"],
            "nonce": p["nonce"],
            "decision": decision,
            "dialog_id": "dialog-1",
        }))
    }
}

#[test]
fn eicar_ueber_das_protokoll() {
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "Downloads/eicar.com", &eicar()).unwrap();

    assert_eq!(
        h.send(json!({"type": "hello", "client": "test", "protocol": 1}))["type"],
        "hello"
    );
    let scan = h.send(json!({"type": "scan", "paths": [home.path()]}));
    assert_eq!(scan["report"]["findings"][0]["risk"], "dangerous");
    assert_eq!(scan["report"]["findings"][0]["category"], "test_file");

    // Vorschlag: Der Dienst formuliert den Plan selbst.
    let proposal = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    assert_eq!(proposal["type"], "proposal");
    let plan = &proposal["proposal"]["plan"];
    assert_eq!(plan["kind"], "quarantine");
    assert!(plan["what"].as_str().unwrap().contains("eicar.com"));
    assert!(plan["why"].as_str().unwrap().contains("EICAR"));

    // „Ja“ → isoliert.
    let done = h.answer(&proposal, "execute");
    assert_eq!(done["type"], "executed", "{done}");
    assert_eq!(done["result"]["status"], "succeeded");
    assert!(!path.exists());
    // Wiederholte Antwort wird abgelehnt.
    assert_eq!(h.answer(&proposal, "execute")["code"], "unknown");

    // Wiederherstellen.
    let list = h.send(json!({"type": "list_quarantine"}));
    let id = list["entries"][0]["id"].clone();
    let restore = h.send(json!({"type": "propose_restore", "entry_id": id}));
    assert_eq!(h.answer(&restore, "execute")["type"], "executed");
    assert_eq!(std::fs::read(&path).unwrap(), eicar());

    // Erneut isolieren und endgültig löschen – zweite Bestätigung nötig.
    let again = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    h.answer(&again, "execute");
    let id = h.send(json!({"type": "list_quarantine"}))["entries"][0]["id"].clone();
    let delete = h.send(json!({"type": "propose_delete", "entry_id": id}));
    assert_eq!(delete["proposal"]["plan"]["undo"]["type"], "irreversible");
    let second = h.answer(&delete, "execute");
    assert_eq!(second["type"], "second_confirmation_required");
    assert_eq!(
        h.send(json!({"type": "list_quarantine"}))["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let confirm = |h: &mut Harness, decision: &str| {
        h.send(json!({
            "type": "confirm_second",
            "challenge_id": second["challenge"]["challenge_id"],
            "nonce": second["nonce"],
            "decision": decision,
            "dialog_id": "dialog-2",
        }))
    };
    // Zu früh → abgelehnt, und die Rückfrage ist verbraucht.
    assert_eq!(confirm(&mut h, "execute")["type"], "error");
    assert_eq!(
        h.send(json!({"type": "list_quarantine"}))["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Neuer Anlauf mit Wartezeit.
    let delete = h.send(json!({"type": "propose_delete", "entry_id": id}));
    let second = h.answer(&delete, "execute");
    h.clock.advance(Duration::seconds(2));
    let done = h.send(json!({
        "type": "confirm_second",
        "challenge_id": second["challenge"]["challenge_id"],
        "nonce": second["nonce"],
        "decision": "execute",
        "dialog_id": "dialog-3",
    }));
    assert_eq!(done["type"], "executed", "{done}");
    assert!(
        h.send(json!({"type": "list_quarantine"}))["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ohne_ja_oder_mit_falscher_nonce_passiert_nichts() {
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();

    for decision in ["decline", "ignore", "trust"] {
        let p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
        let r = h.answer(&p, decision);
        assert_ne!(r["type"], "executed", "{decision}: {r}");
    }
    // Falsche Nonce.
    let mut p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    p["proposal"]["nonce"] = json!("00".repeat(16));
    assert_eq!(h.answer(&p, "execute")["code"], "nonce");
    // Unbekannter Plan / gefälschte Prüfsumme.
    let mut p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    p["proposal"]["ticket"]["digest"] = json!("ab".repeat(32));
    assert_eq!(h.answer(&p, "execute")["code"], "consent");
    // Ohne Antwort: Frist läuft ab.
    let p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    h.clock.advance(Duration::minutes(11));
    assert_eq!(h.answer(&p, "execute")["code"], "unknown");
    // Relative Pfade und zu viele Pfade werden abgelehnt.
    assert_eq!(
        h.send(json!({"type": "scan", "paths": ["relativ/x"]}))["code"],
        "input"
    );
    assert_eq!(
        h.send(json!({"type": "propose_quarantine", "paths": []}))["code"],
        "input"
    );

    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

#[test]
fn pruefprotokoll_ist_lueckenlos() {
    let vault_dir = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let clock = ManualClock::default();
    let gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let mut log = Vec::new();
    {
        let mut service = Service::new(
            Engine::with_builtin_rules().unwrap(),
            Vault::open(vault_dir.path()).unwrap(),
            gate,
            AuditLog::new(&mut log),
        );
        let req: Request =
            serde_json::from_value(json!({"type": "propose_quarantine", "paths": [path]})).unwrap();
        let p = serde_json::to_value(service.handle(req, &OwnProcess)).unwrap();
        let req: Request = serde_json::from_value(json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"], "digest": p["proposal"]["ticket"]["digest"],
            "nonce": p["proposal"]["nonce"], "decision": "execute", "dialog_id": "d"
        })).unwrap();
        service.handle(req, &OwnProcess);
        assert!(service.take_unwritten_events().is_empty());
    }
    let report = verify(Cursor::new(&log)).unwrap();
    let text = String::from_utf8(log).unwrap();
    assert!(report.entries() >= 3, "{text}");
    for needle in ["plan_proposed", "decision_recorded", "action_executed"] {
        assert!(text.contains(needle), "fehlt: {needle}\n{text}");
    }
}

// ---------------------------------------------------------------------------------------
// Regressionstests aus dem P2-Sicherheits-Review.
// ---------------------------------------------------------------------------------------

/// Protokoll, das ab einem Zeitpunkt nicht mehr schreiben bzw. sichern kann.
struct FlakyLog {
    broken: std::rc::Rc<std::cell::Cell<bool>>,
}

impl std::io::Write for FlakyLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.broken.get() {
            Err(std::io::Error::other("Platte voll"))
        } else {
            Ok(buf.len())
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl aegis_core::audit::Durable for FlakyLog {
    fn sync_durable(&mut self) -> std::io::Result<()> {
        if self.broken.get() {
            Err(std::io::Error::other("Platte voll"))
        } else {
            Ok(())
        }
    }
}

/// Review-Fund D: Fällt das Protokoll zwischen Vorschlag und Antwort aus, wird nichts
/// ausgeführt – die Freigabe muss auf der Platte stehen, bevor etwas verändert wird.
#[test]
fn ohne_schreibbares_protokoll_wird_nichts_ausgefuehrt() {
    let vault_dir = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "f.txt", b"x").unwrap();
    let clock = ManualClock::default();
    let gate = ConsentGate::with_clock(clock, ConsentConfig::default()).unwrap();
    let broken = std::rc::Rc::new(std::cell::Cell::new(false));
    let mut service = Service::new(
        Engine::with_builtin_rules().unwrap(),
        Vault::open(vault_dir.path()).unwrap(),
        gate,
        AuditLog::new(FlakyLog {
            broken: broken.clone(),
        }),
    );
    let mut send = |v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(service.handle(req, &OwnProcess)).unwrap()
    };
    let p = send(json!({"type": "propose_quarantine", "paths": [path]}));
    broken.set(true);
    let r = send(json!({
        "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
        "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
        "decision": "execute", "dialog_id": "d"
    }));
    assert_eq!(r["code"], "audit", "{r}");
    assert_eq!(std::fs::read(&path).unwrap(), b"x", "nichts ausgeführt");
}

/// Review-Fund 1 (Teil Pfade) und 6: nur zulässige Pfade, Datenordner tabu, begrenzte
/// Anzahl offener Vorschläge.
#[test]
fn pfadregeln_und_grenzen() {
    let mut h = harness();
    let vault = h.service.quarantine_entries().map(|_| ()).is_ok();
    assert!(vault);
    for bad in ["/a/../etc/passwd", "relativ", "/a/./b"] {
        let r = h.send(json!({"type": "scan", "paths": [bad]}));
        assert_eq!(r["code"], "input", "{bad}: {r}");
    }
    // Der Tresor-Ordner ist nie ein Ziel.
    let inside = h._vault_dir.path().join("vault.key");
    let r = h.send(json!({"type": "propose_quarantine", "paths": [inside]}));
    assert_eq!(r["code"], "input", "{r}");
    let r = h.send(json!({"type": "scan", "paths": [h._vault_dir.path()]}));
    assert_eq!(r["code"], "input", "{r}");
    // Zu viele Pfad-Bytes.
    let long = format!("/{}", "a".repeat(300 * 1024));
    let r = h.send(json!({"type": "scan", "paths": [long]}));
    assert_eq!(r["code"], "input");
    // Offene Vorschläge sind begrenzt.
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.txt", b"a").unwrap();
    let mut codes = Vec::new();
    for _ in 0..70 {
        let r = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
        codes.push(
            r["type"].as_str().unwrap_or_default().to_owned() + r["code"].as_str().unwrap_or(""),
        );
    }
    assert!(codes.iter().any(|c| c == "errorbusy"), "{codes:?}");
}

/// Re-Review N3/N4: Vorschläge und Quarantäne-Einträge gehören dem anfragenden Konto – ein
/// anderes Konto kann weder antworten noch die Einträge sehen.
#[test]
fn konten_sind_getrennt() {
    struct Account(&'static str);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some(self.0.to_owned())
        }
    }
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "a.txt", b"a").unwrap();
    let mut as_user = |who: &Account, v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, who)).unwrap()
    };
    let (a, b) = (Account("S-1-A"), Account("S-1-B"));
    let p = as_user(&a, json!({"type": "propose_quarantine", "paths": [path]}));
    let answer = |p: &Value| {
        json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
            "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
            "decision": "execute", "dialog_id": "d"
        })
    };
    // B kennt Nonce und Plan (z. B. mitgelesen) – darf aber nicht antworten.
    assert_eq!(as_user(&b, answer(&p))["code"], "unknown");
    assert!(path.exists());
    let p = as_user(&a, json!({"type": "propose_quarantine", "paths": [path]}));
    let r = as_user(&a, answer(&p));
    assert_eq!(r["type"], "executed", "{r}");
    let id = r["entries"][0]["id"].clone();
    let listed = |v: Value| v["entries"].as_array().map_or(0, Vec::len);
    assert_eq!(listed(as_user(&a, json!({"type": "list_quarantine"}))), 1);
    assert_eq!(listed(as_user(&b, json!({"type": "list_quarantine"}))), 0);
    let r = as_user(&b, json!({"type": "propose_delete", "entry_id": id}));
    assert_eq!(r["code"], "quarantine", "{r}");
}

/// „Vertrauen“: Datei kommt mit Hash + Pfad auf die Vertrauensliste, Scans zeigen sie als
/// vertraut (Stufe bleibt ehrlich), Widerruf hebt das auf. Nichts an der Datei verändert.
#[test]
fn vertrauen_widerrufen() {
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "trainer.txt", b"aimbot wallhack no recoil").unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();
    let p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    let r = h.answer(&p, "trust");
    assert_eq!(r["type"], "trusted", "{r}");
    assert_eq!(r["entries"].as_array().unwrap().len(), 1);
    let scan = h.send(json!({"type": "scan", "paths": [path]}));
    let f = &scan["report"]["findings"][0];
    assert_eq!(f["risk"], "game_tool");
    assert!(
        f["trusted"]["reason"]
            .as_str()
            .unwrap()
            .contains("Spiel-Tool"),
        "{f}"
    );
    assert_eq!(f["recommendation"], "none");
    let list = h.send(json!({"type": "list_trust"}));
    let id = list["entries"][0]["id"].clone();
    assert_eq!(
        h.send(json!({"type": "revoke_trust", "id": id}))["type"],
        "trust_revoked"
    );
    let scan = h.send(json!({"type": "scan", "paths": [path]}));
    assert!(scan["report"]["findings"][0]["trusted"].is_null());
    // Geänderter Inhalt = andere Datei: nicht mehr vertraut.
    let p = h.send(json!({"type": "propose_quarantine", "paths": [path]}));
    h.answer(&p, "trust");
    write_fixture(home.path(), "trainer.txt", b"aimbot wallhack no recoil v2").unwrap();
    let scan = h.send(json!({"type": "scan", "paths": [path]}));
    assert!(scan["report"]["findings"][0]["trusted"].is_null());
    let _ = before;
}

/// Echtzeit-Wächter: meldet Funde nur dem passenden Konto, vertraute Dateien gar nicht;
/// Gaming-Modus wird angezeigt. Der Wächter verändert nichts.
#[test]
fn waechter_meldungen_ueber_das_protokoll() {
    use aegis_service::watch::{WatchConfig, start};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Account(&'static str, Option<std::path::PathBuf>);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some(self.0.to_owned())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            self.1.clone()
        }
    }

    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    start(
        WatchConfig {
            folders: vec![(home.path().to_path_buf(), Some(home.path().to_path_buf()))],
            profile_roots: Vec::new(),
            exclude: Vec::new(),
            protected: Vec::new(),
            custom_protected: Vec::new(),
            removable: false,
            processes: false,
            settle: std::time::Duration::from_millis(100),
            identity: aegis_service::watch::ScanIdentity::OwnProcess,
        },
        h.service.scanner(),
        h.service.watch(),
        Arc::clone(&stop),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let trainer = write_fixture(home.path(), "trainer.txt", b"aimbot wallhack no recoil").unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();

    let owner = Account("S-1-A", Some(home.path().to_path_buf()));
    let poll = |h: &mut Harness, who: &Account| {
        let req: Request =
            serde_json::from_value(json!({"type": "watch_poll", "after": 0})).unwrap();
        serde_json::to_value(h.service.handle(req, who)).unwrap()
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut r = poll(&mut h, &owner);
    while std::time::Instant::now() < deadline && r["events"].as_array().unwrap().len() < 2 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        r = poll(&mut h, &owner);
    }
    assert_eq!(r["type"], "watch");
    assert_eq!(r["events"].as_array().unwrap().len(), 2, "{r}");
    assert_eq!(r["status"]["active"], true);
    // Anderes Profil bzw. unbekanntes Profil: nichts davon sichtbar.
    let other = Account("S-1-B", Some(std::path::PathBuf::from("/anderes/profil")));
    assert!(
        poll(&mut h, &other)["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        poll(&mut h, &Account("S-1-C", None))["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // „Vertrauen“ für das Spiel-Tool → wird nicht mehr gemeldet (Konto ohne Trennung = OwnProcess).
    let p = h.send(json!({"type": "propose_quarantine", "paths": [trainer]}));
    assert_eq!(h.answer(&p, "trust")["type"], "trusted");
    let events = h.send(json!({"type": "watch_poll", "after": 0}));
    let events = events["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(events[0]["path"].as_str().unwrap().ends_with("eicar.com"));

    let g = h.send(json!({"type": "set_gaming", "on": true}));
    assert_eq!(g["status"]["gaming"], true);
    assert!(g["events"].as_array().unwrap().is_empty());
    assert!(g["gaming_left"].as_u64().unwrap() > 3 * 60 * 60);
    assert_eq!(
        h.send(json!({"type": "set_gaming", "on": false}))["status"]["gaming"],
        false
    );

    stop.store(true, Ordering::SeqCst);
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

/// Verlauf: Scans, Antworten und Ausführungen landen je Konto im Verlauf; Zeitplan setzen,
/// fällige Läufe melden nur (nichts verändert); Update-Ergebnis wird festgehalten.
#[test]
fn verlauf_zeitplan_und_update() {
    struct Account(&'static str, std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some(self.0.to_owned())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.1.clone())
        }
    }
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let path = write_fixture(home.path(), "Downloads/eicar.com", &eicar()).unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();
    let a = Account("S-1-A", home.path().to_path_buf());
    let b = Account("S-1-B", std::path::PathBuf::from("/anderes"));
    let mut send = |who: &Account, v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, who)).unwrap()
    };

    send(&a, json!({"type": "scan", "paths": [home.path()]}));
    let p = send(&a, json!({"type": "propose_quarantine", "paths": [path]}));
    let r = send(
        &a,
        json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
            "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
            "decision": "decline", "dialog_id": "d"
        }),
    );
    assert_eq!(r["type"], "nothing_done");
    let hist = send(&a, json!({"type": "history"}));
    let entries = hist["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{hist}");
    assert_eq!(entries[0]["kind"], "decision");
    assert!(
        entries[0]["title"]
            .as_str()
            .unwrap()
            .contains("abgelehnt, nichts verändert")
    );
    assert_eq!(entries[1]["kind"], "scan");
    assert_eq!(entries[1]["risk"], "dangerous");
    assert!(
        entries[1]["title"]
            .as_str()
            .unwrap()
            .contains("1 auffällig")
    );
    assert!(
        send(&b, json!({"type": "history"}))["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Zeitplan: ungültige Eingaben abgelehnt, gültige gespeichert (je Konto).
    assert_eq!(
        send(
            &a,
            json!({"type": "set_schedule", "enabled": true, "every_days": 3, "hour_utc": 0})
        )["code"],
        "input"
    );
    let s = send(
        &a,
        json!({"type": "set_schedule", "enabled": true, "every_days": 7, "hour_utc": 0}),
    );
    assert_eq!(s["type"], "schedule", "{s}");
    assert_eq!(s["schedule"]["every_days"], 7);
    assert!(send(&b, json!({"type": "get_schedule"}))["schedule"].is_null());
    // Rechnerweit: nur Administratoren (Konto A ist keiner).
    assert_eq!(
        send(&a, json!({"type": "set_clamav_update", "on": false}))["code"],
        "admin"
    );
    let off = {
        let req: Request =
            serde_json::from_value(json!({"type": "set_clamav_update", "on": false})).unwrap();
        serde_json::to_value(h.service.handle(req, &OwnProcess)).unwrap()
    };
    assert_eq!(off["clamav_update"], false);

    // Fällig (Stunde 0 UTC ist immer erreicht) → einmal, dann nicht mehr.
    let work = h.service.take_due_work();
    assert_eq!(work.schedules.len(), 1);
    assert!(!work.update, "Update abgeschaltet");
    assert!(h.service.take_due_work().schedules.is_empty());
    let schedule = &work.schedules[0];
    let folders: Vec<_> = aegis_service::schedule::SCHEDULED_FOLDERS
        .iter()
        .map(|f| schedule.profile.join(f))
        .filter(|p| p.is_dir())
        .collect();
    let report = h.service.scanner().scan(&folders, &OwnProcess);
    h.service.record_scheduled(schedule, report);
    h.service.record_update(Err("kein Netz".into()));
    let mut send = |who: &Account, v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, who)).unwrap()
    };
    let hist = send(&a, json!({"type": "history"}));
    let entries = hist["entries"].as_array().unwrap();
    assert_eq!(entries[0]["kind"], "update");
    assert_eq!(entries[1]["kind"], "schedule");
    assert!(
        entries[1]["title"]
            .as_str()
            .unwrap()
            .contains("1 auffällig"),
        "{hist}"
    );
    // Gemeinsames Update sieht auch B, den geplanten Scan von A nicht.
    let other = send(&b, json!({"type": "history"}));
    assert_eq!(other["entries"].as_array().unwrap().len(), 1);
    // Fund des geplanten Scans wird wie vom Wächter gemeldet.
    let watch = send(&a, json!({"type": "watch_poll", "after": 0}));
    assert_eq!(watch["events"][0]["kind"], "schedule");
    assert_eq!(
        send(&a, json!({"type": "get_schedule"}))["last_update"]["ok"],
        false
    );
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

#[test]
fn labor_vorschlag_prueft_eingaben() {
    let mut h = harness();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), "probe.txt", b"harmlos").unwrap();
    let before = DirSnapshot::capture(dir.path()).unwrap();
    let propose = |h: &mut Harness, stage: &str, seconds: u32, network: bool| {
        h.send(json!({
            "type": "propose_lab_run", "path": path, "stage": stage,
            "seconds": seconds, "network": network
        }))
    };

    assert_eq!(propose(&mut h, "kernel", 30, false)["code"], "input");
    assert_eq!(propose(&mut h, "mini_sandbox", 3, false)["code"], "input");
    assert_eq!(propose(&mut h, "mini_sandbox", 601, false)["code"], "input");
    assert_eq!(
        propose(&mut h, "mini_sandbox", 30, true)["code"],
        "input",
        "Netzwerk nur in der Windows Sandbox"
    );
    let status = h.send(json!({"type": "lab_status"}));
    assert_eq!(status["type"], "lab", "{status}");
    assert!(status["runs"].as_array().unwrap().is_empty());
    assert_eq!(status["mini_available"], cfg!(windows));
    assert_eq!(
        h.send(json!({"type": "lab_screenshot", "run_id": "1", "name": "bild-01.png"}))["code"],
        "lab"
    );

    let mini = propose(&mut h, "mini_sandbox", 30, false);
    if cfg!(windows) {
        assert_eq!(mini["type"], "proposal", "{mini}");
        let p = &mini["proposal"]["plan"];
        assert_eq!(p["kind"], "run_in_sandbox");
        assert_eq!(p["parameters"]["lab_stage"], "mini_sandbox");
        assert_eq!(p["parameters"]["lab_sha256"].as_str().unwrap().len(), 64);
        // „Vertrauen“ würde die unbekannte Probe auf die Vertrauensliste setzen – abgelehnt,
        // der Vorschlag bleibt offen.
        assert_eq!(h.answer(&mini, "trust")["code"], "trust");
        assert!(
            h.send(json!({"type": "list_trust"}))["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(h.answer(&mini, "decline")["type"], "nothing_done");
    } else {
        assert_eq!(mini["code"], "sandbox", "{mini}");
    }
    assert_unchanged(&before, &DirSnapshot::capture(dir.path()).unwrap());
}

#[test]
fn prozess_aktionen_nur_als_vorschlag() {
    let mut h = harness();
    let bad = h.send(
        json!({"type": "propose_process_action", "program": "/x/a.exe", "action": "explode"}),
    );
    assert_eq!(bad["code"], "input");
    let rel = h
        .send(json!({"type": "propose_process_action", "program": "a.exe", "action": "terminate"}));
    assert_eq!(rel["code"], "input");
    let none = h.send(json!({
        "type": "propose_process_action",
        "program": if cfg!(windows) { r"C:\gibt\es\nicht.exe" } else { "/gibt/es/nicht" },
        "action": "terminate"
    }));
    assert_eq!(none["code"], "process", "{none}");
    // Den eigenen Prozess (AEGIS) bietet der Dienst nie an.
    let me = std::env::current_exe().unwrap();
    let own = h.send(json!({"type": "propose_process_action", "program": me, "action": "suspend"}));
    assert_eq!(own["code"], "process", "{own}");
}

#[test]
fn koederdateien_nur_per_plan_und_nur_unveraendert_entfernt() {
    struct Account(std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some("S-1-K".into())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.0.clone())
        }
    }
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    // Langer, tatsächlicher Pfad ohne `\\?\` (wie ein echtes Profil).
    let home_path = {
        let c = std::fs::canonicalize(home.path()).unwrap();
        let text = c.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map_or(c.clone(), std::path::PathBuf::from)
    };
    aegis_core::testing::create_fixture_dir(&home_path, "Documents").unwrap();
    aegis_core::testing::create_fixture_dir(&home_path, "Desktop").unwrap();
    let before = DirSnapshot::capture(&home_path).unwrap();
    let a = Account(home_path.clone());
    let mut send = |v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, &a)).unwrap()
    };
    assert!(
        send(json!({"type": "ransom_status"}))["baits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let p = send(json!({"type": "propose_baits", "on": true}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert_eq!(
        p["proposal"]["plan"]["targets"].as_array().unwrap().len(),
        5,
        "Einstellung + 4 Dateien"
    );
    // Ohne „Ja“: nichts angelegt.
    let no = send(json!({
        "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
        "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
        "decision": "decline", "dialog_id": "d"
    }));
    assert_eq!(no["type"], "nothing_done");
    assert_unchanged(&before, &DirSnapshot::capture(&home_path).unwrap());

    // Eine gleichnamige eigene Datei des Nutzers wird nie überschrieben.
    let own = aegis_core::testing::write_fixture(
        &home_path,
        &format!("Desktop/{}", aegis_quarantine::bait::BAIT_NAMES[0]),
        b"meine Datei",
    )
    .unwrap();
    let p = send(json!({"type": "propose_baits", "on": true}));
    let yes = send(json!({
        "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
        "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
        "decision": "execute", "dialog_id": "d"
    }));
    assert_eq!(yes["type"], "executed", "{yes}");
    assert_eq!(yes["result"]["status"], "partially_succeeded", "{yes}");
    assert_eq!(std::fs::read(&own).unwrap(), b"meine Datei");
    let baits = send(json!({"type": "ransom_status"}))["baits"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(baits.len(), 3);
    for b in &baits {
        assert_eq!(
            std::fs::read(b.as_str().unwrap()).unwrap(),
            aegis_quarantine::bait::BAIT_CONTENT
        );
    }
    // Einer wird „verändert“ (wie von Ransomware) – er bleibt beim Entfernen liegen.
    let changed = std::path::PathBuf::from(baits[0].as_str().unwrap());
    let rel = changed
        .strip_prefix(&home_path)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    aegis_core::testing::remove_fixture(&home_path, &rel).unwrap();
    aegis_core::testing::write_fixture(&home_path, &rel, b"verschluesselt").unwrap();
    let p = send(json!({"type": "propose_baits", "on": false}));
    let off = send(json!({
        "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
        "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
        "decision": "execute", "dialog_id": "d"
    }));
    assert_eq!(off["type"], "executed", "{off}");
    assert_eq!(off["result"]["status"], "partially_succeeded", "{off}");
    assert_eq!(std::fs::read(&changed).unwrap(), b"verschluesselt");
    for b in &baits[1..] {
        assert!(!std::path::Path::new(b.as_str().unwrap()).exists());
    }
    let left = send(json!({"type": "ransom_status"}))["baits"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(left, 1, "veränderter Köder bleibt in der Liste");
    assert_eq!(
        std::fs::read(&own).unwrap(),
        b"meine Datei",
        "eigene Datei bleibt"
    );
}

#[test]
fn panic_button_nur_als_vorschlag() {
    let mut h = harness();
    let status = h.send(json!({"type": "panic_status"}));
    assert_eq!(status["type"], "panic");
    assert!(status["since"].is_null());
    assert_eq!(status["available"], cfg!(windows));
    let off = h.send(json!({"type": "propose_panic", "on": false}));
    if cfg!(windows) {
        // „Wieder verbinden“ ist immer möglich (räumt auch halbe Regeln auf) – nur mit „Ja“.
        assert_eq!(off["type"], "proposal", "{off}");
        assert_eq!(h.answer(&off, "decline")["type"], "nothing_done");
    } else {
        assert_eq!(off["code"], "panic");
    }
    let on = h.send(json!({"type": "propose_panic", "on": true}));
    if cfg!(windows) {
        assert_eq!(on["type"], "proposal", "{on}");
        assert_eq!(on["proposal"]["plan"]["kind"], "change_setting");
        // Ohne „Ja“ passiert nichts.
        assert_eq!(h.answer(&on, "decline")["type"], "nothing_done");
        assert!(h.send(json!({"type": "panic_status"}))["since"].is_null());
    } else {
        assert_eq!(on["code"], "panic");
    }
}

#[test]
fn haertung_nur_lesend_mit_ehrlichem_score() {
    let mut h = harness();
    let r = h.send(json!({"type": "hardening_status"}));
    assert_eq!(r["type"], "hardening", "{r}");
    let state = &r["state"];
    assert_eq!(state["checks"].as_array().unwrap().len(), 13);
    if cfg!(windows) {
        assert_eq!(state["available"], true);
    } else {
        // Ohne Windows ist nichts lesbar: kein erfundener Score, alles „unbekannt“.
        assert_eq!(state["available"], false);
        assert!(state["score"]["value"].is_null(), "{r}");
        assert!(
            state["checks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["status"] == "unknown")
        );
        assert!(state["history"].as_array().unwrap().is_empty());
    }
    // Ohne „neu prüfen“ kommt das gemerkte Ergebnis (10 Minuten), danach ein neues.
    let again = h.send(json!({"type": "hardening_status"}));
    assert_eq!(again["state"]["checked_at"], state["checked_at"]);
    h.clock.advance(aegis_core::time::Duration::minutes(11));
    let later = h.send(json!({"type": "hardening_status"}));
    assert_ne!(later["state"]["checked_at"], state["checked_at"]);
    // Beheben nur als Vorschlag; unbekannte Schritte und fremde Stände gibt es nicht.
    let r = h.send(json!({"type": "propose_hardening_fix", "fix": "format_c"}));
    assert_eq!(r["code"], "input", "{r}");
    let r = h.send(json!({"type": "propose_hardening_undo", "id": "x"}));
    assert_eq!(r["code"], "unknown", "{r}");
    let r = h.send(json!({"type": "propose_hardening_fix", "fix": "disable_smb1"}));
    if cfg!(windows) {
        // Echter Rechner: Vorschlag, fehlende Rechte oder „ist bereits aus“ (dann kein Plan).
        assert!(
            r["type"] == "proposal" || r["code"] == "admin" || r["code"] == "hardening",
            "{r}"
        );
    } else {
        assert_eq!(r["code"], "hardening", "{r}");
    }
}

#[test]
fn persistenz_nur_lesend_und_deaktivieren_nur_aus_dem_check() {
    let mut h = harness();
    let r = h.send(json!({"type": "persistence_status"}));
    assert_eq!(r["type"], "persistence", "{r}");
    if !cfg!(windows) {
        assert_eq!(r["state"]["available"], false);
        assert!(r["state"]["entries"].as_array().unwrap().is_empty());
    }
    let r = h.send(json!({"type": "propose_autorun_disable", "id": "0123456789abcdef"}));
    assert_eq!(r["code"], "unknown", "{r}");
}

#[test]
fn speicher_scan_nur_lesend() {
    let mut h = harness();
    let r = h.send(json!({"type": "memory_scan"}));
    if cfg!(windows) {
        assert_eq!(r["type"], "memory_scan", "{r}");
    } else {
        assert_eq!(r["code"], "scan");
    }
}

#[test]
fn datei_safe_nur_per_plan_und_passwort_nie_gespeichert() {
    struct Account(std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some("S-1-SAFE".into())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.0.clone())
        }
    }
    const PASSWORT: &str = "Mein-sehr-geheimes-Passwort-42";
    let vault_dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::default();
    let gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let mut log = Vec::new();
    let home = tempfile::tempdir().unwrap();
    let home_path = {
        let c = std::fs::canonicalize(home.path()).unwrap();
        let text = c.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map_or(c.clone(), std::path::PathBuf::from)
    };
    let a = Account(home_path.clone());
    let file = write_fixture(
        &home_path,
        "Documents/vertrag.txt",
        b"harmloser Vertragstext",
    )
    .unwrap();
    let mut outputs = Vec::new();
    {
        let mut service = Service::new(
            Engine::with_builtin_rules().unwrap(),
            Vault::open(vault_dir.path()).unwrap(),
            gate,
            AuditLog::new(&mut log),
        );
        let mut send = |v: Value| {
            let req: Request = serde_json::from_value(v).unwrap();
            assert!(
                !format!("{req:?}").contains(PASSWORT),
                "Debug zeigt kein Passwort"
            );
            let out = serde_json::to_value(service.handle(req, &a)).unwrap();
            outputs.push(out.to_string());
            out
        };
        let decide = |p: &Value, decision: &str| {
            json!({
                "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
                "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
                "decision": decision, "dialog_id": "d"
            })
        };
        let status = send(json!({"type": "safe_status"}));
        assert_eq!(status["type"], "safe", "{status}");
        assert_eq!(status["exists"], false);
        assert_eq!(
            send(json!({"type": "safe_unlock", "password": PASSWORT}))["code"],
            "safe"
        );
        assert_eq!(
            send(json!({"type": "propose_safe_setup", "password": "kurz"}))["code"],
            "password"
        );

        // Anlegen: ohne „Ja“ entsteht nichts; Vertrauen gibt es nicht.
        let p = send(json!({"type": "propose_safe_setup", "password": PASSWORT}));
        assert_eq!(p["type"], "proposal", "{p}");
        assert_eq!(send(decide(&p, "trust"))["code"], "trust");
        assert_eq!(send(decide(&p, "decline"))["type"], "nothing_done");
        assert_eq!(send(json!({"type": "safe_status"}))["exists"], false);
        let p = send(json!({"type": "propose_safe_setup", "password": PASSWORT}));
        let done = send(decide(&p, "execute"));
        assert_eq!(done["result"]["status"], "succeeded", "{done}");
        let status = send(json!({"type": "safe_status"}));
        assert_eq!(
            (status["exists"].clone(), status["unlocked"].clone()),
            (json!(true), json!(true))
        );

        // Dateien des Safes selbst lassen sich nicht hineinlegen (Schlüssel ginge verloren).
        let header = home_path.join("AppData/Local/AEGIS/Datei-Safe/safe.json");
        assert_eq!(
            send(json!({"type": "propose_safe_store", "paths": [header]}))["code"],
            "input"
        );
        // Hineinlegen nur mit „Ja“.
        let p = send(json!({"type": "propose_safe_store", "paths": [file]}));
        assert_eq!(p["proposal"]["plan"]["kind"], "safe_store", "{p}");
        assert_eq!(send(decide(&p, "decline"))["type"], "nothing_done");
        assert!(file.exists());
        let p = send(json!({"type": "propose_safe_store", "paths": [file]}));
        let done = send(decide(&p, "execute"));
        assert_eq!(done["result"]["status"], "succeeded", "{done}");
        assert!(!file.exists());
        let entries = send(json!({"type": "safe_status"}))["entries"].clone();
        assert_eq!(entries.as_array().unwrap().len(), 1);
        let id = entries[0]["id"].as_str().unwrap().to_owned();

        // Gesperrt: kein Vorschlag, keine Einträge; falsches Passwort zählt.
        send(json!({"type": "safe_lock"}));
        let status = send(json!({"type": "safe_status"}));
        assert_eq!(status["unlocked"], false);
        assert!(status["entries"].as_array().unwrap().is_empty());
        assert_eq!(
            send(json!({"type": "propose_safe_retrieve", "id": id}))["code"],
            "locked"
        );
        for _ in 0..5 {
            assert_eq!(
                send(json!({"type": "safe_unlock", "password": "falsches-passwort"}))["code"],
                "password"
            );
        }
        assert_eq!(
            send(json!({"type": "safe_unlock", "password": PASSWORT}))["code"],
            "wait"
        );
        clock.advance(Duration::seconds(61));
        assert_eq!(
            send(json!({"type": "safe_unlock", "password": PASSWORT}))["unlocked"],
            true
        );

        // Herausholen an den ursprünglichen Ort.
        let p = send(json!({"type": "propose_safe_retrieve", "id": id}));
        assert_eq!(p["proposal"]["plan"]["kind"], "safe_retrieve", "{p}");
        let done = send(decide(&p, "execute"));
        assert_eq!(done["result"]["status"], "succeeded", "{done}");
        assert_eq!(std::fs::read(&file).unwrap(), b"harmloser Vertragstext");

        // Nach 10 min ohne Nutzung gesperrt.
        clock.advance(Duration::minutes(11));
        assert_eq!(send(json!({"type": "safe_status"}))["unlocked"], false);
        assert!(service_events_empty(&mut service));
    }
    let text = String::from_utf8(log).unwrap();
    assert!(
        text.contains("safe_store") && text.contains("safe_retrieve"),
        "{text}"
    );
    assert!(!text.contains(PASSWORT), "Passwort nicht im Prüfprotokoll");
    assert!(
        outputs.iter().all(|o| !o.contains(PASSWORT)),
        "Passwort in keiner Antwort"
    );
}

fn service_events_empty<W: aegis_core::audit::Durable>(
    service: &mut Service<ManualClock, W>,
) -> bool {
    service.take_unwritten_events().is_empty()
}

#[test]
fn notfall_scan_nur_lesend_dann_sammel_isolieren_und_alles_rueckgaengig() {
    struct Account(std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some("S-1-NOTFALL".into())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.0.clone())
        }
    }
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let home_path = {
        let c = std::fs::canonicalize(home.path()).unwrap();
        let text = c.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map_or(c.clone(), std::path::PathBuf::from)
    };
    let a = Account(home_path.clone());
    let dl = write_fixture(&home_path, "Downloads/rechnung.com", &eicar()).unwrap();
    let app = write_fixture(&home_path, "AppData/Roaming/upd/updater.exe", &eicar()).unwrap();
    write_fixture(&home_path, "AppData/Roaming/upd/readme.txt", &eicar()).unwrap();
    write_fixture(&home_path, "Desktop/notiz.txt", b"harmlos").unwrap();
    let before = DirSnapshot::capture(&home_path).unwrap();
    let mut send = |v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, &a)).unwrap()
    };
    let r = send(json!({"type": "emergency_scan"}));
    assert_eq!(r["type"], "emergency_scan", "{r}");
    let areas = r["areas"].as_array().unwrap();
    let area = |id: &str| areas.iter().find(|x| x["id"] == id).unwrap().clone();
    assert_eq!(area("downloads")["findings"][0]["risk"], "dangerous");
    let appdata = area("appdata");
    assert_eq!(
        appdata["checked"], 1,
        "nur die .exe, nicht die .txt: {appdata}"
    );
    assert_eq!(appdata["findings"][0]["risk"], "dangerous");
    assert!(area("desktop")["findings"].as_array().unwrap().is_empty());
    assert!(
        r["update"].as_str().unwrap().contains("ClamAV")
            || r["update"].as_str().unwrap().contains("Signatur")
    );
    // Der Scan selbst ändert nichts.
    assert_unchanged(&before, &DirSnapshot::capture(&home_path).unwrap());

    // Sammel-Isolieren: ein Plan für alle gewählten Funde.
    let p = send(json!({"type": "propose_quarantine", "paths": [dl, app]}));
    assert_eq!(
        p["proposal"]["plan"]["targets"].as_array().unwrap().len(),
        2,
        "{p}"
    );
    let decide = |p: &Value, d: &str| {
        json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
            "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
            "decision": d, "dialog_id": "d"
        })
    };
    let done = send(decide(&p, "execute"));
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert!(!dl.exists() && !app.exists());
    let ids: Vec<Value> = done["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    assert_eq!(ids.len(), 2);

    // „Alles rückgängig machen“: ein Plan, ohne „Ja“ passiert nichts.
    let undo = send(json!({"type": "propose_restore_many", "entry_ids": ids}));
    assert_eq!(undo["proposal"]["plan"]["kind"], "restore", "{undo}");
    assert_eq!(
        undo["proposal"]["plan"]["targets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(send(decide(&undo, "decline"))["type"], "nothing_done");
    assert!(!dl.exists());
    let undo = send(json!({"type": "propose_restore_many", "entry_ids": ids}));
    let done = send(decide(&undo, "execute"));
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(std::fs::read(&dl).unwrap(), eicar());
    assert_eq!(std::fs::read(&app).unwrap(), eicar());
    // Fremde/unbekannte Einträge: kein Vorschlag.
    assert_eq!(
        send(json!({"type": "propose_restore_many", "entry_ids": ["x"]}))["code"],
        "quarantine"
    );
    assert_eq!(
        send(json!({"type": "propose_restore_many", "entry_ids": []}))["code"],
        "input"
    );
}

#[test]
fn eigene_schutzordner_nur_lesbare_ordner_und_nur_beobachtung() {
    struct Account(std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some("S-1-SCHUTZ".into())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.0.clone())
        }
    }
    let mut h = harness();
    let home = tempfile::tempdir().unwrap();
    let fotos = aegis_core::testing::create_fixture_dir(home.path(), "Fotos").unwrap();
    let datei = write_fixture(home.path(), "notiz.txt", b"x").unwrap();
    let before = DirSnapshot::capture(home.path()).unwrap();
    let a = Account(home.path().to_path_buf());
    let mut send = |v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, &a)).unwrap()
    };
    let status = send(json!({"type": "ransom_status"}));
    assert_eq!(status["type"], "ransom", "{status}");
    assert_eq!(status["default_folders"].as_array().unwrap().len(), 3);
    assert!(status["folders"].as_array().unwrap().is_empty());
    let set = send(json!({"type": "set_protected_folders", "folders": [fotos]}));
    assert_eq!(set["folders"].as_array().unwrap().len(), 1, "{set}");
    assert_eq!(
        send(json!({"type": "set_protected_folders", "folders": [datei]}))["code"],
        "input",
        "Datei statt Ordner"
    );
    assert_eq!(
        send(json!({"type": "set_protected_folders", "folders": [home.path().join("fehlt")]}))["code"],
        "input"
    );
    let many: Vec<_> = (0..21).map(|_| fotos.clone()).collect();
    assert_eq!(
        send(json!({"type": "set_protected_folders", "folders": many}))["code"],
        "input"
    );
    let cleared = send(json!({"type": "set_protected_folders", "folders": []}));
    assert!(cleared["folders"].as_array().unwrap().is_empty());
    assert_unchanged(&before, &DirSnapshot::capture(home.path()).unwrap());
}

#[test]
fn rueckfall_kopien_nur_nach_opt_in_und_nie_ueberschreibend() {
    struct Account(std::path::PathBuf);
    impl aegis_quarantine::UserAccess for Account {
        fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
            Ok(aegis_quarantine::UserScope::unchanged())
        }
        fn identity(&self) -> Option<String> {
            Some("S-1-RUECK".into())
        }
        fn profile(&self) -> Option<std::path::PathBuf> {
            Some(self.0.clone())
        }
    }
    let data = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        aegis_quarantine::backup::BackupStore::open(&data.path().join("rueckfall")).unwrap(),
    );
    let mut h = harness();
    h.service = std::mem::replace(&mut h.service, harness().service)
        .with_backup(std::sync::Arc::clone(&store), data.path().join("rueckfall"));
    let home = tempfile::tempdir().unwrap();
    let home_path = {
        let c = std::fs::canonicalize(home.path()).unwrap();
        let text = c.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map_or(c.clone(), std::path::PathBuf::from)
    };
    let doc = write_fixture(&home_path, "Documents/brief.txt", b"Version 1").unwrap();
    let a = Account(home_path.clone());
    let send = |h: &mut Harness, v: Value| {
        let req: Request = serde_json::from_value(v).unwrap();
        serde_json::to_value(h.service.handle(req, &a)).unwrap()
    };
    let decide = |p: &Value, d: &str| {
        json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"],
            "digest": p["proposal"]["ticket"]["digest"], "nonce": p["proposal"]["nonce"],
            "decision": d, "dialog_id": "d"
        })
    };
    let status = send(&mut h, json!({"type": "backup_status"}));
    assert_eq!(status["state"]["enabled"], false, "{status}");
    // Ohne Einschalten: kein Lauf.
    assert!(h.service.take_due_backups().is_empty());
    assert_eq!(
        send(
            &mut h,
            json!({"type": "propose_backup", "on": true, "quota_mb": 7})
        )["code"],
        "input"
    );
    let p = send(
        &mut h,
        json!({"type": "propose_backup", "on": true, "quota_mb": 1024}),
    );
    assert_eq!(p["type"], "proposal", "{p}");
    assert_eq!(send(&mut h, decide(&p, "decline"))["type"], "nothing_done");
    assert!(h.service.take_due_backups().is_empty());
    let p = send(
        &mut h,
        json!({"type": "propose_backup", "on": true, "quota_mb": 1024}),
    );
    assert_eq!(
        send(&mut h, decide(&p, "execute"))["result"]["status"],
        "succeeded"
    );

    // Lauf sichert (liest nur).
    let jobs = h.service.take_due_backups();
    assert_eq!(jobs.len(), 1);
    let before = DirSnapshot::capture(&home_path).unwrap();
    let outcome = aegis_service::handler::backup::run_job(&store, &jobs[0], &a, &|| false);
    assert_eq!(outcome.copied, 1, "{outcome:?}");
    assert_unchanged(&before, &DirSnapshot::capture(&home_path).unwrap());
    h.service.record_backup(&jobs[0], &outcome);
    assert!(
        h.service.take_due_backups().is_empty(),
        "erst nach dem Abstand"
    );
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write_fixture(&home_path, "Documents/brief.txt", b"Version 2 kaputt").unwrap();
    h.clock.advance(Duration::minutes(31));
    let jobs = h.service.take_due_backups();
    assert_eq!(
        aegis_service::handler::backup::run_job(&store, &jobs[0], &a, &|| false).copied,
        1
    );
    let status = send(&mut h, json!({"type": "backup_status"}));
    assert_eq!(status["state"]["usage"]["versions"], 2, "{status}");
    let old = status["state"]["versions"][1]["id"].clone();

    // Zurückholen: nie überschreiben – neuer Name.
    let p = send(&mut h, json!({"type": "propose_backup_restore", "id": old}));
    let target = p["proposal"]["plan"]["targets"][0]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(std::path::Path::new(&target), doc.as_path(), "{p}");
    let done = send(&mut h, decide(&p, "execute"));
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(std::fs::read(&target).unwrap(), b"Version 1");
    assert_eq!(std::fs::read(&doc).unwrap(), b"Version 2 kaputt");

    // Export in einen gewählten Ordner – nur mit „Ja“.
    let usb = tempfile::tempdir().unwrap();
    let p = send(
        &mut h,
        json!({"type": "propose_backup_export", "folder": usb.path()}),
    );
    assert_eq!(p["proposal"]["plan"]["kind"], "export_backup", "{p}");
    assert_eq!(send(&mut h, decide(&p, "decline"))["type"], "nothing_done");
    assert_eq!(std::fs::read_dir(usb.path()).unwrap().count(), 0);
    let p = send(
        &mut h,
        json!({"type": "propose_backup_export", "folder": usb.path()}),
    );
    let done = send(&mut h, decide(&p, "execute"));
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(std::fs::read_dir(usb.path()).unwrap().count(), 1);

    // Ausdünnen: zweite Bestätigung nötig.
    let p = send(&mut h, json!({"type": "propose_backup_prune", "days": 30}));
    assert_eq!(p["proposal"]["plan"]["kind"], "delete_permanently", "{p}");
    let second = send(&mut h, decide(&p, "execute"));
    assert_eq!(second["type"], "second_confirmation_required", "{second}");
    h.clock.advance(Duration::seconds(2));
    let done = send(
        &mut h,
        json!({
            "type": "confirm_second",
            "challenge_id": second["challenge"]["challenge_id"],
            "nonce": second["nonce"],
            "decision": "execute",
            "dialog_id": "d2",
        }),
    );
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    // Ausschalten: vorhandene Versionen bleiben.
    let p = send(
        &mut h,
        json!({"type": "propose_backup", "on": false, "quota_mb": 0}),
    );
    send(&mut h, decide(&p, "execute"));
    let status = send(&mut h, json!({"type": "backup_status"}));
    assert_eq!(status["state"]["enabled"], false);
    assert!(status["state"]["usage"]["versions"].as_u64().unwrap() >= 1);
}

/// Ersatz für den Systemzugriff der Härtung: merkt sich, was ausgeführt würde.
#[derive(Debug, Default)]
struct FakeSystem {
    state: std::sync::Mutex<aegis_hardening::collect::FixState>,
    applied: std::sync::Mutex<Vec<Step>>,
    reads: std::sync::atomic::AtomicUsize,
    defender: std::sync::Mutex<aegis_defender_switch::DefenderStatus>,
}

impl HardenSystem for FakeSystem {
    fn defender_status(&self) -> aegis_defender_switch::DefenderStatus {
        self.defender.lock().unwrap().clone()
    }

    fn fix_state(
        &self,
        _fix: aegis_hardening::FixKind,
        _sid: Option<&str>,
    ) -> Result<aegis_hardening::collect::FixState, String> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.state.lock().unwrap().clone())
    }

    fn before(
        &self,
        step: &Step,
        _user: &dyn aegis_quarantine::UserAccess,
    ) -> Result<Step, String> {
        Ok(match step.clone() {
            Step::Registry {
                place, key, name, ..
            } => Step::Registry {
                place,
                key,
                name,
                value: Some(Raw {
                    kind: 4,
                    bytes: 1u32.to_le_bytes().to_vec(),
                }),
            },
            Step::Firewall { profile, on } => Step::Firewall { profile, on: !on },
            Step::Guest { name, active } => Step::Guest {
                name,
                active: !active,
            },
            Step::Task { path, enabled } => Step::Task {
                path,
                enabled: !enabled,
            },
            Step::BlockProgram {
                name,
                program,
                present,
            } => Step::BlockProgram {
                name,
                program,
                present: !present,
            },
            Step::Defender { command } => Step::Defender {
                command: match command {
                    aegis_defender_switch::Command::Realtime { enabled } => {
                        aegis_defender_switch::Command::Realtime { enabled: !enabled }
                    }
                    aegis_defender_switch::Command::ThreatAction { level, .. } => {
                        aegis_defender_switch::Command::ThreatAction {
                            level,
                            action: None,
                        }
                    }
                },
            },
            Step::RestorePoint { description } => Step::RestorePoint { description },
        })
    }

    fn apply(
        &self,
        _permit: &aegis_core::consent::ExecutionPermit,
        step: &Step,
        _user: &dyn aegis_quarantine::UserAccess,
    ) -> Result<(), String> {
        self.applied.lock().unwrap().push(step.clone());
        Ok(())
    }
}

/// Konto ohne Administratorrechte (Windows-SID).
struct Standard;

impl aegis_quarantine::UserAccess for Standard {
    fn enter(&self) -> std::io::Result<aegis_quarantine::UserScope> {
        Ok(aegis_quarantine::UserScope::unchanged())
    }

    fn identity(&self) -> Option<String> {
        Some("S-1-5-21-1-2-3-1001".into())
    }
}

impl Harness {
    fn send_as(&mut self, request: Value, user: &dyn aegis_quarantine::UserAccess) -> Value {
        let req: Request = serde_json::from_value(request).unwrap();
        serde_json::to_value(self.service.handle(req, user)).unwrap()
    }

    fn answer_as(
        &mut self,
        proposal: &Value,
        decision: &str,
        user: &dyn aegis_quarantine::UserAccess,
    ) -> Value {
        let p = &proposal["proposal"];
        self.send_as(
            json!({
                "type": "decide",
                "plan_id": p["ticket"]["id"],
                "digest": p["ticket"]["digest"],
                "nonce": p["nonce"],
                "decision": decision,
                "dialog_id": "dialog-1",
            }),
            user,
        )
    }
}

fn harden_harness() -> (Harness, std::sync::Arc<FakeSystem>) {
    let mut h = harness();
    let fake = std::sync::Arc::new(FakeSystem::default());
    {
        let mut st = fake.state.lock().unwrap();
        st.smb1 = Some(true);
        st.firewall_off = vec!["privateprofile".into()];
        st.proxy_enabled = true;
    }
    h.service.set_harden_system(fake.clone());
    (h, fake)
}

#[test]
fn haertung_beheben_und_rueckgaengig_nur_nach_ja() {
    let (mut h, fake) = harden_harness();
    let p = h.send(json!({"type": "propose_hardening_fix", "fix": "disable_smb1"}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert!(
        fake.applied.lock().unwrap().is_empty(),
        "ohne Ja passiert nichts"
    );
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(fake.applied.lock().unwrap().len(), 1);
    let status = h.send(json!({"type": "hardening_status", "fresh": true}));
    let undo = status["state"]["undo"].as_array().unwrap().clone();
    assert_eq!(undo.len(), 1);
    assert_eq!(undo[0]["fix"], "disable_smb1");
    // Rückgängig: eigener Plan, als schwächend gekennzeichnet.
    let back = h.send(json!({"type": "propose_hardening_undo", "id": undo[0]["id"]}));
    assert_eq!(back["proposal"]["plan"]["severity"], "suspicious", "{back}");
    assert!(
        back["proposal"]["plan"]["consequence"]
            .as_str()
            .unwrap()
            .contains("schwächer")
    );
    assert_eq!(h.answer(&back, "execute")["result"]["status"], "succeeded");
    assert_eq!(fake.applied.lock().unwrap().len(), 2);
    let status = h.send(json!({"type": "hardening_status", "fresh": true}));
    assert!(status["state"]["undo"].as_array().unwrap().is_empty());
}

#[test]
fn treiber_sperrliste_nur_nach_ja_und_nur_als_admin() {
    let (mut h, fake) = harden_harness();
    fake.state.lock().unwrap().driver_blocklist = Some(false);
    let r = h.send_as(
        json!({"type": "propose_hardening_fix", "fix": "enable_driver_blocklist"}),
        &Standard,
    );
    assert_eq!(r["code"], "admin", "{r}");
    let p = h.send(json!({"type": "propose_hardening_fix", "fix": "enable_driver_blocklist"}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert!(
        p["proposal"]["plan"]["consequence"]
            .as_str()
            .unwrap()
            .contains("Neustart")
    );
    assert_eq!(h.answer(&p, "decline")["type"], "nothing_done");
    assert!(
        fake.applied.lock().unwrap().is_empty(),
        "Nein ändert nichts"
    );
    let p = h.send(json!({"type": "propose_hardening_fix", "fix": "enable_driver_blocklist"}));
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    let applied = fake.applied.lock().unwrap();
    assert_eq!(applied.len(), 1);
    assert!(
        applied[0]
            .describe()
            .ends_with("VulnerableDriverBlocklistEnable = 1 (DWORD)")
    );
}

#[test]
fn haertung_geaenderter_zustand_bricht_ab() {
    let (mut h, fake) = harden_harness();
    let p = h.send(json!({"type": "propose_hardening_fix", "fix": "enable_firewall"}));
    assert_eq!(p["type"], "proposal", "{p}");
    fake.state.lock().unwrap().firewall_off = vec!["privateprofile".into(), "publicprofile".into()];
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "failed", "{done}");
    assert!(fake.applied.lock().unwrap().is_empty());
}

#[test]
fn haertung_admin_regel_konten_und_grenze() {
    let (mut h, fake) = harden_harness();
    // Rechnerweit: Standardkonto wird abgewiesen, bevor etwas gelesen wird.
    let r = h.send_as(
        json!({"type": "propose_hardening_fix", "fix": "disable_smb1"}),
        &Standard,
    );
    assert_eq!(r["code"], "admin", "{r}");
    assert_eq!(fake.reads.load(std::sync::atomic::Ordering::SeqCst), 0);
    // Eigener Proxy: erlaubt; höchstens 10 gemerkte Stände je Konto.
    for _ in 0..12 {
        let p = h.send_as(
            json!({"type": "propose_hardening_fix", "fix": "disable_proxy"}),
            &Standard,
        );
        assert_eq!(p["type"], "proposal", "{p}");
        let done = h.answer_as(&p, "execute", &Standard);
        assert_eq!(done["result"]["status"], "succeeded", "{done}");
    }
    let mine = h.send_as(json!({"type": "hardening_status"}), &Standard);
    let undo = mine["state"]["undo"].as_array().unwrap().clone();
    assert_eq!(undo.len(), 10);
    // Ein anderes Konto sieht diese Stände nicht und kann sie nicht zurücknehmen.
    let other = h.send(json!({"type": "propose_hardening_undo", "id": undo[0]["id"]}));
    assert_eq!(other["code"], "unknown", "{other}");
}

#[derive(Debug, Default)]
struct FakePackages {
    upgraded: std::sync::Mutex<Vec<(String, String)>>,
}

impl aegis_service::handler::updates::PackageManager for FakePackages {
    fn list(&self) -> Result<Vec<aegis_hardening::updates::Upgrade>, String> {
        let pkg = |name: &str, id: &str, truncated| aegis_hardening::updates::Upgrade {
            name: name.into(),
            id: id.into(),
            version: "1.0".into(),
            available: "2.0.1".into(),
            source: "winget".into(),
            truncated,
        };
        Ok(vec![
            pkg("Beispiel", "Beispiel.App", false),
            pkg("Langer Name…", "Lang.Kennung…", true),
        ])
    }

    fn upgrade(&self, permit: &aegis_core::consent::ExecutionPermit) -> Result<String, String> {
        let (id, version) = aegis_service::handler::updates::plan_package(permit)?;
        self.upgraded.lock().unwrap().push((id, version));
        Ok("aktualisiert".into())
    }
}

#[test]
fn software_updates_nur_nach_ja_und_nur_als_admin() {
    let mut h = harness();
    let fake = std::sync::Arc::new(FakePackages::default());
    h.service.set_package_manager(fake.clone());
    // Ohne Liste kein Vorschlag.
    let r = h.send(json!({"type": "propose_software_update", "id": "Beispiel.App"}));
    assert_eq!(r["code"], "unknown", "{r}");
    let list = h.send(json!({"type": "software_updates"}));
    assert_eq!(list["type"], "updates", "{list}");
    assert_eq!(list["state"]["packages"].as_array().unwrap().len(), 2);
    assert!(
        fake.upgraded.lock().unwrap().is_empty(),
        "Liste ändert nichts"
    );
    let r = h.send_as(
        json!({"type": "propose_software_update", "id": "Beispiel.App"}),
        &Standard,
    );
    assert_eq!(r["code"], "admin", "{r}");
    let r = h.send(json!({"type": "propose_software_update", "id": "Lang.Kennung…"}));
    assert_eq!(r["code"], "updates", "{r}");
    let p = h.send(json!({"type": "propose_software_update", "id": "Beispiel.App"}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert_eq!(p["proposal"]["plan"]["kind"], "update_software");
    assert_eq!(p["proposal"]["plan"]["undo"]["type"], "irreversible", "{p}");
    assert_eq!(h.answer(&p, "decline")["type"], "nothing_done");
    assert!(
        fake.upgraded.lock().unwrap().is_empty(),
        "Nein ändert nichts"
    );
    let p = h.send(json!({"type": "propose_software_update", "id": "Beispiel.App"}));
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(
        *fake.upgraded.lock().unwrap(),
        vec![("Beispiel.App".to_owned(), "2.0.1".to_owned())]
    );
    // Danach ist die Liste veraltet: erst neu suchen.
    let r = h.send(json!({"type": "propose_software_update", "id": "Beispiel.App"}));
    assert_eq!(r["code"], "unknown", "{r}");
}

#[test]
fn firewall_regel_nur_nach_ja_admin_und_rueckgaengig() {
    let (mut h, fake) = harden_harness();
    let dir = tempfile::tempdir().unwrap();
    let exe = write_fixture(dir.path(), "tool.exe", b"MZ harmlos").unwrap();
    let program = exe.display().to_string();
    // Unter Linux gibt es keinen Laufwerksbuchstaben – dort lehnt AEGIS jeden Pfad ab.
    let r = h.send(json!({"type": "propose_firewall_block", "program": program, "block": true}));
    if !cfg!(windows) {
        assert_eq!(r["code"], "input", "{r}");
        let r = h.send(
            json!({"type": "propose_firewall_block", "program": r"C:\Temp\x.exe", "block": true}),
        );
        assert_eq!(r["code"], "input", "Programm fehlt: {r}");
        return;
    }
    assert_eq!(r["type"], "proposal", "{r}");
    let r2 = h.send_as(
        json!({"type": "propose_firewall_block", "program": program, "block": true}),
        &Standard,
    );
    assert_eq!(r2["code"], "admin", "{r2}");
    assert_eq!(h.answer(&r, "decline")["type"], "nothing_done");
    assert!(fake.applied.lock().unwrap().is_empty());
    let p = h.send(json!({"type": "propose_firewall_block", "program": program, "block": true}));
    assert_eq!(h.answer(&p, "execute")["result"]["status"], "succeeded");
    assert_eq!(fake.applied.lock().unwrap().len(), 1);
    let status = h.send(json!({"type": "hardening_status", "fresh": true}));
    let undo = status["state"]["undo"].as_array().unwrap().clone();
    assert!(undo[0]["fix"].as_str().unwrap().starts_with("firewall:"));
}

#[test]
fn netzwerk_und_firewall_nur_lesend() {
    let mut h = harness();
    let r = h.send(json!({"type": "network_status"}));
    assert_eq!(r["type"], "network", "{r}");
    let r = h.send(json!({"type": "firewall_status"}));
    assert_eq!(r["type"], "firewall", "{r}");
    if !cfg!(windows) {
        assert_eq!(r["state"]["available"], false);
    }
}

#[test]
fn defender_schalter_nur_nach_ja_admin_und_nie_gegen_manipulationsschutz() {
    use aegis_defender_switch::{Command, DefenderStatus};
    let (mut h, fake) = harden_harness();
    let on = DefenderStatus {
        available: true,
        service: Some(true),
        antivirus: Some(true),
        realtime: Some(true),
        cloud: Some(true),
        tamper: Some(false),
        running_mode: Some("Normal".into()),
        preferences: true,
        ..DefenderStatus::default()
    };
    *fake.defender.lock().unwrap() = on.clone();
    // Ohne frisch gelesenen Status gibt es keinen Vorschlag.
    let r = h.send(json!({"type": "propose_defender", "change": "realtime_off"}));
    assert_eq!(r["code"], "status", "{r}");
    // Manipulationsschutz an: kein Plan, nur der Hinweis.
    let tamper = DefenderStatus {
        tamper: Some(true),
        ..on.clone()
    };
    let state = serde_json::to_value(h.service.defender_finish(tamper, &OwnProcess)).unwrap();
    assert_eq!(state["type"], "defender", "{state}");
    let r = h.send(json!({"type": "propose_defender", "change": "realtime_off"}));
    assert_eq!(r["code"], "tamper", "{r}");
    // Nur Administratoren, nur bekannte Änderungen.
    h.service.defender_finish(on.clone(), &OwnProcess);
    let r = h.send_as(
        json!({"type": "propose_defender", "change": "realtime_off"}),
        &Standard,
    );
    assert_eq!(r["code"], "admin", "{r}");
    let r = h.send(json!({"type": "propose_defender", "change": "firewall_off"}));
    assert_eq!(r["code"], "input", "{r}");
    let r = h.send(json!({"type": "propose_defender", "change": "realtime_on"}));
    assert_eq!(r["code"], "already", "{r}");
    // Vorschlag, „Nein“ → nichts; dann „Ja“ → genau ein Defender-Befehl.
    let p = h.send(json!({"type": "propose_defender", "change": "realtime_off"}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert_eq!(p["proposal"]["plan"]["severity"], "dangerous", "{p}");
    assert_eq!(h.answer(&p, "decline")["type"], "nothing_done");
    assert!(fake.applied.lock().unwrap().is_empty());
    h.service.defender_finish(on.clone(), &OwnProcess);
    let p = h.send(json!({"type": "propose_defender", "change": "realtime_off"}));
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(
        fake.applied.lock().unwrap().as_slice(),
        &[Step::Defender {
            command: Command::Realtime { enabled: false }
        }]
    );
    // Nach der Ausführung gilt der alte Status nicht mehr – erst neu lesen.
    let r = h.send(json!({"type": "propose_defender", "change": "realtime_on"}));
    assert_eq!(r["code"], "status", "{r}");
    // Kein allgemeines „Rückgängig“ (das umginge die Defender-Prüfungen); Protokoll zeigt die
    // Umschaltung.
    let status = h.send(json!({"type": "hardening_status", "fresh": true}));
    let undo = status["state"]["undo"].as_array().unwrap().clone();
    assert!(
        undo.iter()
            .all(|u| !u["fix"].as_str().unwrap_or("").starts_with("defender:")),
        "{status}"
    );
    let state = serde_json::to_value(h.service.defender_finish(on, &OwnProcess)).unwrap();
    let log = state["state"]["log"].as_array().unwrap();
    assert!(
        log[0]["title"]
            .as_str()
            .unwrap()
            .starts_with("Microsoft Defender: Echtzeitschutz ausschalten"),
        "{state}"
    );
    // Zwischen Vorschlag und „Ja“ wird der Manipulationsschutz eingeschaltet → nichts geändert.
    let before = fake.applied.lock().unwrap().len();
    let p = h.send(json!({"type": "propose_defender", "change": "realtime_off"}));
    assert_eq!(p["type"], "proposal", "{p}");
    fake.defender.lock().unwrap().tamper = Some(true);
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "failed", "{done}");
    assert!(done.to_string().contains("Manipulationsschutz"), "{done}");
    assert_eq!(fake.applied.lock().unwrap().len(), before);
}

#[test]
fn wiederherstellungspunkt_nur_nach_ja_admin_und_bereinigt() {
    let (mut h, fake) = harden_harness();
    // Nur lesen: liefert (ohne Windows) keine Liste, aber eine Antwort.
    let r = h.send(json!({"type": "restore_points"}));
    assert_eq!(r["type"], "restore_points", "{r}");
    assert!(r["state"]["points"].is_null(), "{r}");
    // Nur Administratoren; leere Beschreibung abgelehnt.
    let r = h.send_as(
        json!({"type": "propose_restore_point", "description": "Vor Härtung"}),
        &Standard,
    );
    assert_eq!(r["code"], "admin", "{r}");
    let r = h.send(json!({"type": "propose_restore_point", "description": "'\";|"}));
    assert_eq!(r["code"], "input", "{r}");
    // „Nein“ → nichts; „Ja“ → genau ein Schritt mit bereinigter Beschreibung.
    let p = h.send(json!({"type": "propose_restore_point", "description": "Vor Härtung'; x"}));
    assert_eq!(p["type"], "proposal", "{p}");
    assert!(p.to_string().contains("Vor Härtung x"), "{p}");
    assert_eq!(h.answer(&p, "decline")["type"], "nothing_done");
    assert!(fake.applied.lock().unwrap().is_empty());
    let p = h.send(json!({"type": "propose_restore_point", "description": "Vor Härtung"}));
    let done = h.answer(&p, "execute");
    assert_eq!(done["result"]["status"], "succeeded", "{done}");
    assert_eq!(
        fake.applied.lock().unwrap().as_slice(),
        &[Step::RestorePoint {
            description: "Vor Härtung".into()
        }]
    );
    // Kein „Rückgängig“-Eintrag (AEGIS löscht keine Punkte).
    let status = h.send(json!({"type": "hardening_status", "fresh": true}));
    assert!(
        status["state"]["undo"].as_array().is_none_or(Vec::is_empty),
        "{status}"
    );
}
