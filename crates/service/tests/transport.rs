//! Ende-zu-Ende über den echten Transport: Unix-Socket (lokal) bzw. Named Pipe mit
//! Zugriffsliste (Windows, in der CI).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aegis_core::testing::{eicar, write_fixture};
use aegis_service::server::{build_service, serve};
use aegis_service::transport::roundtrip;
use serde_json::{Value, json};

fn ask<S: std::io::Read + std::io::Write>(stream: &mut S, request: &Value) -> Value {
    let bytes = roundtrip(stream, &serde_json::to_vec(request).unwrap()).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn conversation<S: std::io::Read + std::io::Write>(stream: &mut S, home: &std::path::Path) {
    let hello = ask(
        stream,
        &json!({"type": "hello", "client": "test", "protocol": 1}),
    );
    assert_eq!(hello["type"], "hello");
    let scan = ask(stream, &json!({"type": "scan", "paths": [home]}));
    assert_eq!(scan["report"]["findings"][0]["category"], "test_file");
    let bad = ask(stream, &json!({"type": "execute_now"}));
    assert_eq!(bad["code"], "invalid");
    let path = home.join("eicar.com");
    let proposal = ask(
        stream,
        &json!({"type": "propose_quarantine", "paths": [path]}),
    );
    let p = &proposal["proposal"];
    let done = ask(
        stream,
        &json!({
            "type": "decide", "plan_id": p["ticket"]["id"], "digest": p["ticket"]["digest"],
            "nonce": p["nonce"], "decision": "decline", "dialog_id": "t"
        }),
    );
    assert_eq!(done["type"], "nothing_done");
    assert!(path.exists(), "„Nein“ verändert nichts");
}

#[cfg(unix)]
#[test]
fn unix_socket_ende_zu_ende() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let endpoint = data
        .path()
        .join("aegis.sock")
        .to_string_lossy()
        .into_owned();
    let service = Arc::new(Mutex::new(build_service(data.path()).unwrap()));
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let (endpoint, stop) = (endpoint.clone(), Arc::clone(&stop));
        std::thread::spawn(move || serve(&endpoint, &service, &stop))
    };
    let mut stream = None;
    for _ in 0..100 {
        if let Ok(s) = aegis_service::transport::unix::connect(std::path::Path::new(&endpoint)) {
            stream = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut stream = stream.expect("Dienst nicht erreichbar");
    conversation(&mut stream, home.path());
    drop(stream);
    stop.store(true, Ordering::SeqCst);
    let _ = aegis_service::transport::unix::connect(std::path::Path::new(&endpoint));
    server.join().unwrap().unwrap();
    assert!(data.path().join("audit/audit.jsonl").exists());
}

#[cfg(windows)]
#[test]
fn named_pipe_ende_zu_ende() {
    use aegis_service::transport::windows::{connect, create_instance};
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_fixture(home.path(), "eicar.com", &eicar()).unwrap();
    let endpoint = format!(r"\\.\pipe\aegis-test-{}", std::process::id());
    let service = Arc::new(Mutex::new(build_service(data.path()).unwrap()));
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let (endpoint, stop) = (endpoint.clone(), Arc::clone(&stop));
        std::thread::spawn(move || serve(&endpoint, &service, &stop))
    };
    let mut stream = None;
    for _ in 0..100 {
        if let Ok(s) = connect(&endpoint) {
            stream = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut stream = stream.expect("Pipe nicht erreichbar");
    conversation(&mut stream, home.path());
    // Eine zweite Erst-Instanz unter demselben Namen ist nicht möglich (Schutz vor Übernahme).
    assert!(create_instance(&endpoint, true).is_err());
    drop(stream);
    stop.store(true, Ordering::SeqCst);
    let _ = connect(&endpoint);
    server.join().unwrap().unwrap();
}
