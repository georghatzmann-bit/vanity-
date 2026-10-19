//! Ablauf über das echte Protokoll (JSON wie von der Oberfläche).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Cursor;

use aegis_core::audit::{AuditLog, verify};
use aegis_core::consent::{ConsentConfig, ConsentGate};
use aegis_core::testing::{DirSnapshot, ManualClock, assert_unchanged, eicar, write_fixture};
use aegis_core::time::Duration;
use aegis_engine::Engine;
use aegis_quarantine::{OwnProcess, Vault};
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
