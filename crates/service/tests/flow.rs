//! Ablauf über das echte Protokoll (JSON wie von der Oberfläche).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Cursor;

use aegis_core::audit::{AuditLog, verify};
use aegis_core::consent::{ConsentConfig, ConsentGate};
use aegis_core::testing::{DirSnapshot, ManualClock, assert_unchanged, eicar, write_fixture};
use aegis_core::time::Duration;
use aegis_engine::Engine;
use aegis_quarantine::Vault;
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
        serde_json::to_value(self.service.handle(req)).unwrap()
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
        let p = serde_json::to_value(service.handle(req)).unwrap();
        let req: Request = serde_json::from_value(json!({
            "type": "decide", "plan_id": p["proposal"]["ticket"]["id"], "digest": p["proposal"]["ticket"]["digest"],
            "nonce": p["proposal"]["nonce"], "decision": "execute", "dialog_id": "d"
        })).unwrap();
        service.handle(req);
        assert!(service.take_unwritten_events().is_empty());
    }
    let report = verify(Cursor::new(&log)).unwrap();
    let text = String::from_utf8(log).unwrap();
    assert!(report.entries() >= 3, "{text}");
    for needle in ["plan_proposed", "decision_recorded", "action_executed"] {
        assert!(text.contains(needle), "fehlt: {needle}\n{text}");
    }
}
