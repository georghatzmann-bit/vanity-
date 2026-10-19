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

/// Langer, tatsächlicher Pfad (Windows-Temp kann Kurznamen wie `RUNNER~1` enthalten; der
/// Dienst vergleicht mit dem tatsächlichen Pfad und lehnt Abweichungen ab).
fn real_dir(p: &std::path::Path) -> std::path::PathBuf {
    let c = std::fs::canonicalize(p).unwrap();
    let text = c.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => std::path::PathBuf::from(rest),
        None => c,
    }
}

fn conversation<S: std::io::Read + std::io::Write>(stream: &mut S, home: &std::path::Path) {
    let home = &real_dir(home);
    let hello = ask(
        stream,
        &json!({"type": "hello", "client": "test", "protocol": 1}),
    );
    assert_eq!(hello["type"], "hello");
    let scan = ask(stream, &json!({"type": "scan", "paths": [home]}));
    assert_eq!(
        scan["report"]["findings"][0]["category"], "test_file",
        "Antwort des Dienstes: {scan}"
    );
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

    // „Ja“: isolieren und wiederherstellen über den echten Transport (unter Windows mit
    // Identitätswechsel auf den Client und Zugriff über Handles).
    let yes = |stream: &mut S, proposal: &Value| {
        let p = &proposal["proposal"];
        ask(
            stream,
            &json!({
                "type": "decide", "plan_id": p["ticket"]["id"], "digest": p["ticket"]["digest"],
                "nonce": p["nonce"], "decision": "execute", "dialog_id": "t"
            }),
        )
    };
    let proposal = ask(
        stream,
        &json!({"type": "propose_quarantine", "paths": [path]}),
    );
    let done = yes(stream, &proposal);
    assert_eq!(done["type"], "executed", "{done}");
    assert!(!path.exists(), "isoliert");
    let id = done["entries"][0]["id"].clone();
    let proposal = ask(stream, &json!({"type": "propose_restore", "entry_id": id}));
    let done = yes(stream, &proposal);
    assert_eq!(done["type"], "executed", "{done}");
    assert_eq!(std::fs::read(&path).unwrap(), eicar(), "wiederhergestellt");
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

#[cfg(windows)]
#[test]
fn identitaetswechsel_und_server_pruefung() {
    use aegis_service::protocol::{read_frame, write_frame};
    use aegis_service::transport::windows::{
        ServerIdentity, accept, connect, create_instance, impersonate_client, server_identity,
        thread_is_impersonating,
    };
    let name = format!(r"\\.\pipe\aegis-imp-{}", std::process::id());
    let instance = create_instance(&name, true).unwrap();
    let server = std::thread::spawn(move || {
        let connection = accept(instance).unwrap();
        let mut reader = &connection;
        read_frame(&mut reader).unwrap();
        assert!(!thread_is_impersonating().unwrap());
        {
            let _as_client = impersonate_client(&connection).unwrap();
            assert!(thread_is_impersonating().unwrap());
        }
        assert!(
            !thread_is_impersonating().unwrap(),
            "zurück zur eigenen Identität"
        );
    });
    let mut client = None;
    for _ in 0..100 {
        if let Ok(c) = connect(&name) {
            client = Some(c);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let client = client.expect("Pipe nicht erreichbar");
    // In der CI läuft der Test-Server nicht als SYSTEM – die App würde nichts senden.
    assert_eq!(server_identity(&client).unwrap(), ServerIdentity::Other);
    let mut writer = &client;
    write_frame(&mut writer, b"{}").unwrap();
    server.join().unwrap();
}
