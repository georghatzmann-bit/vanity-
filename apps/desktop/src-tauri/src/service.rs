//! Verbindung zum Dienst `aegis-service` (Scans, Quarantäne, Freigaben).
//!
//! Die App führt selbst **nichts** aus: Sie reicht Anfragen an den Dienst weiter, der jeden
//! Plan selbst formuliert und nur nach „Ja“ (mit Einmal-Nonce) handelt. Jede Anfrage wird
//! hier auf erlaubte Werte geprüft, bevor sie die App verlässt.
//!
//! Transport: Named Pipe `\\.\pipe\aegis-service` (Windows) bzw. Unix-Socket des
//! Entwicklungsdienstes. Nachrichten: 4-Byte-Länge (LE) + JSON, wie `aegis_service::protocol`.

use std::io::{self, Read, Write};

use serde_json::{Value, json};

/// Größte Nachricht (wie im Dienst).
const MAX_FRAME: u32 = 16 * 1024 * 1024;
/// Höchstzahl Pfade pro Anfrage (wie im Dienst).
const MAX_PATHS: usize = 1000;
/// Längste erlaubte Pfadangabe (Windows-Langpfade).
const MAX_PATH_CHARS: usize = 32_767;
/// Längste Kennung (Plan, Prüfsumme, Nonce, Dialog).
const MAX_ID_CHARS: usize = 128;

/// Endpunkt des Dienstes.
fn endpoint() -> Option<String> {
    #[cfg(windows)]
    {
        Some(r"\\.\pipe\aegis-service".to_owned())
    }
    #[cfg(not(windows))]
    {
        let state = std::env::var_os("XDG_STATE_HOME")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state"))
            })?;
        Some(
            state
                .join("aegis-service/aegis.sock")
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[cfg(unix)]
fn connect(endpoint: &str) -> io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(endpoint)
}

/// `SECURITY_IMPERSONATION` (2 « 16): Der Dienst darf mit den Rechten des Nutzers auf dessen
/// Dateien zugreifen – nicht mehr (keine Delegation ins Netz).
#[cfg(windows)]
const SECURITY_IMPERSONATION: u32 = 2 << 16;

#[cfg(windows)]
fn connect(endpoint: &str) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Öffnet die Pipe des Dienstes zum Senden der Anfrage – keine Datei, keine Nutzerdaten.
    // aegis-mutation: desktop-service-pipe-open
    #[allow(clippy::disallowed_methods)]
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .security_qos_flags(SECURITY_IMPERSONATION)
        .open(endpoint)?;
    // Vor dem ersten Senden: Antwortet wirklich der Dienst (Konto SYSTEM)? Ein Programm, das
    // den Pipe-Namen besetzt, um Antworten zu fälschen oder Rechte zu übernehmen, läuft
    // nicht als SYSTEM. Entwicklungs-Builds erlauben einen Dienst aus der Konsole.
    match aegis_winffi::server_identity(&pipe)? {
        aegis_winffi::ServerIdentity::LocalSystem => Ok(pipe),
        aegis_winffi::ServerIdentity::Other if cfg!(debug_assertions) => Ok(pipe),
        aegis_winffi::ServerIdentity::Other => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Die Gegenstelle ist nicht der AEGIS-Dienst (läuft nicht als SYSTEM) – nichts gesendet",
        )),
    }
}

/// Sendet eine Nachricht und liest die Antwort.
fn roundtrip<S: Read + Write>(stream: &mut S, request: &Value) -> io::Result<Value> {
    let payload = serde_json::to_vec(request).map_err(io::Error::other)?;
    let len = u32::try_from(payload.len())
        .ok()
        .filter(|l| *l <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Anfrage zu groß"))?;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()?;
    let mut header = [0u8; 4];
    stream.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header);
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Antwort zu groß",
        ));
    }
    let mut body = Vec::with_capacity(usize::try_from(len.min(64 * 1024)).unwrap_or(0));
    Read::by_ref(stream)
        .take(u64::from(len))
        .read_to_end(&mut body)?;
    if body.len() != usize::try_from(len).unwrap_or(usize::MAX) {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Antwort unvollständig",
        ));
    }
    serde_json::from_slice(&body).map_err(io::Error::other)
}

/// Fehlertext für die Oberfläche (Deutsch; die UI zeigt ihn als „Dienst nicht erreichbar“).
fn unreachable(error: &io::Error) -> String {
    format!("Der AEGIS-Dienst ist nicht erreichbar ({error}).")
}

async fn send(request: Value) -> Result<Value, String> {
    let endpoint = endpoint().ok_or("Kein Endpunkt des Dienstes bestimmbar.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut stream = connect(&endpoint).map_err(|e| unreachable(&e))?;
        roundtrip(&mut stream, &request).map_err(|e| unreachable(&e))
    })
    .await
    .map_err(|e| format!("Interner Fehler: {e}"))?
}

fn check_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err(format!("1 bis {MAX_PATHS} Pfade erwartet."));
    }
    for p in paths {
        if p.is_empty()
            || p.chars().count() > MAX_PATH_CHARS
            || p.contains('\0')
            || !std::path::Path::new(p).is_absolute()
        {
            return Err("Ungültiger Pfad (nur absolute Pfade).".to_owned());
        }
    }
    Ok(())
}

fn check_id(value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= MAX_ID_CHARS
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    if ok {
        Ok(())
    } else {
        Err("Ungültige Kennung.".to_owned())
    }
}

fn check_decision(value: &str) -> Result<(), String> {
    if matches!(value, "execute" | "decline" | "ignore" | "trust") {
        Ok(())
    } else {
        Err("Ungültige Entscheidung.".to_owned())
    }
}

/// Anfrage „Prüfen“ (nur lesend).
pub fn scan_request(paths: &[String]) -> Result<Value, String> {
    check_paths(paths)?;
    Ok(json!({ "type": "scan", "paths": paths }))
}

/// Anfrage „Isolieren vorschlagen“.
pub fn propose_quarantine_request(paths: &[String]) -> Result<Value, String> {
    check_paths(paths)?;
    Ok(json!({ "type": "propose_quarantine", "paths": paths }))
}

/// Anfrage „Wiederherstellen/Löschen vorschlagen“.
pub fn propose_entry_request(kind: &str, entry_id: &str) -> Result<Value, String> {
    check_id(entry_id)?;
    Ok(json!({ "type": kind, "entry_id": entry_id }))
}

/// Antwort im Freigabe-Dialog.
pub fn decide_request(
    plan_id: &str,
    digest: &str,
    nonce: &str,
    decision: &str,
    dialog_id: &str,
) -> Result<Value, String> {
    for id in [plan_id, digest, nonce, dialog_id] {
        check_id(id)?;
    }
    check_decision(decision)?;
    Ok(json!({
        "type": "decide", "plan_id": plan_id, "digest": digest, "nonce": nonce,
        "decision": decision, "dialog_id": dialog_id,
    }))
}

/// Antwort im zweiten Dialog vor endgültigem Löschen.
pub fn confirm_second_request(
    challenge_id: &str,
    nonce: &str,
    decision: &str,
    dialog_id: &str,
) -> Result<Value, String> {
    for id in [challenge_id, nonce, dialog_id] {
        check_id(id)?;
    }
    check_decision(decision)?;
    Ok(json!({
        "type": "confirm_second", "challenge_id": challenge_id, "nonce": nonce,
        "decision": decision, "dialog_id": dialog_id,
    }))
}

/// Dateien/Ordner prüfen (nur lesend).
#[tauri::command]
pub async fn service_scan(paths: Vec<String>) -> Result<Value, String> {
    send(scan_request(&paths)?).await
}

/// Quarantäne auflisten.
#[tauri::command]
pub async fn service_list_quarantine() -> Result<Value, String> {
    send(json!({ "type": "list_quarantine" })).await
}

/// Isolieren vorschlagen (der Dienst prüft und formuliert den Plan).
#[tauri::command]
pub async fn service_propose_quarantine(paths: Vec<String>) -> Result<Value, String> {
    send(propose_quarantine_request(&paths)?).await
}

/// Wiederherstellen vorschlagen.
#[tauri::command]
pub async fn service_propose_restore(entry_id: String) -> Result<Value, String> {
    send(propose_entry_request("propose_restore", &entry_id)?).await
}

/// Endgültiges Löschen vorschlagen.
#[tauri::command]
pub async fn service_propose_delete(entry_id: String) -> Result<Value, String> {
    send(propose_entry_request("propose_delete", &entry_id)?).await
}

/// Antwort des Nutzers im Freigabe-Dialog weiterreichen.
#[tauri::command]
pub async fn service_decide(
    plan_id: String,
    digest: String,
    nonce: String,
    decision: String,
    dialog_id: String,
) -> Result<Value, String> {
    send(decide_request(
        &plan_id, &digest, &nonce, &decision, &dialog_id,
    )?)
    .await
}

/// Eigene Vertrauensliste (nur lesend).
#[tauri::command]
pub async fn service_list_trust() -> Result<Value, String> {
    send(json!({ "type": "list_trust" })).await
}

/// Widerruft einen Eintrag der eigenen Vertrauensliste (macht AEGIS nur strenger).
#[tauri::command]
pub async fn service_revoke_trust(id: String) -> Result<Value, String> {
    check_id(&id)?;
    send(json!({ "type": "revoke_trust", "id": id })).await
}

/// Meldungen des Echtzeit-Wächters nach Nummer `after` abholen (nur lesend).
#[tauri::command]
pub async fn service_watch_poll(after: u64) -> Result<Value, String> {
    send(json!({ "type": "watch_poll", "after": after })).await
}

/// Gaming-Modus an/aus: pausiert nur Prüfungen und Hinweise (endet spätestens nach 4 h).
#[tauri::command]
pub async fn service_set_gaming(on: bool) -> Result<Value, String> {
    send(json!({ "type": "set_gaming", "on": on })).await
}

/// Verlauf (für den HTML-Export in Rust).
pub async fn history() -> Result<Value, String> {
    send(json!({ "type": "history" })).await
}

/// Verlauf für Berichte und Zeitleiste (nur lesend).
#[tauri::command]
pub async fn service_history() -> Result<Value, String> {
    history().await
}

/// Eigener Zeitplan und Update-Einstellung (nur lesend).
#[tauri::command]
pub async fn service_get_schedule() -> Result<Value, String> {
    send(json!({ "type": "get_schedule" })).await
}

/// Eigenen geplanten Scan setzen – geplante Scans prüfen und melden nur.
#[tauri::command]
pub async fn service_set_schedule(
    enabled: bool,
    every_days: u16,
    hour_utc: u8,
) -> Result<Value, String> {
    if ![1, 7, 30].contains(&every_days) || hour_utc > 23 {
        return Err("Ungültiger Zeitplan.".into());
    }
    send(json!({
        "type": "set_schedule",
        "enabled": enabled,
        "every_days": every_days,
        "hour_utc": hour_utc,
    }))
    .await
}

/// Tägliches ClamAV-Signatur-Update an/aus (Netzwerk).
#[tauri::command]
pub async fn service_set_clamav_update(on: bool) -> Result<Value, String> {
    send(json!({ "type": "set_clamav_update", "on": on })).await
}

/// Antwort im zweiten Dialog weiterreichen.
#[tauri::command]
pub async fn service_confirm_second(
    challenge_id: String,
    nonce: String,
    decision: String,
    dialog_id: String,
) -> Result<Value, String> {
    send(confirm_second_request(
        &challenge_id,
        &nonce,
        &decision,
        &dialog_id,
    )?)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eingaben_werden_geprueft() {
        let abs = if cfg!(windows) { r"C:\x" } else { "/x" }.to_owned();
        assert!(scan_request(std::slice::from_ref(&abs)).is_ok());
        assert!(scan_request(&[]).is_err());
        assert!(scan_request(&["relativ".to_owned()]).is_err());
        assert!(scan_request(&[format!("{abs}\0")]).is_err());
        assert!(scan_request(&vec![abs.clone(); MAX_PATHS + 1]).is_err());
        assert!(propose_entry_request("propose_restore", "../x").is_err());
        assert!(decide_request("a", "b", "c", "execute", "d").is_ok());
        assert!(decide_request("a", "b", "c", "execute_now", "d").is_err());
        assert!(decide_request("a b", "b", "c", "decline", "d").is_err());
        assert!(confirm_second_request("a", "b", "trust", &"x".repeat(200)).is_err());
    }

    #[test]
    fn rahmen_rundweg() {
        // Gegenstelle simulieren: Antwort vorab in den Puffer legen.
        struct Duplex {
            inbound: io::Cursor<Vec<u8>>,
            outbound: Vec<u8>,
        }
        impl Read for Duplex {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.inbound.read(buf)
            }
        }
        impl Write for Duplex {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.outbound.write(buf)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let answer = br#"{"type":"hello"}"#;
        let mut inbound = u32::try_from(answer.len()).unwrap().to_le_bytes().to_vec();
        inbound.extend_from_slice(answer);
        let mut d = Duplex {
            inbound: io::Cursor::new(inbound),
            outbound: Vec::new(),
        };
        let v = roundtrip(&mut d, &json!({"type": "list_quarantine"})).unwrap();
        assert_eq!(v["type"], "hello");
        assert_eq!(&d.outbound[4..], br#"{"type":"list_quarantine"}"#);
        let mut too_big = Duplex {
            inbound: io::Cursor::new((MAX_FRAME + 1).to_le_bytes().to_vec()),
            outbound: Vec::new(),
        };
        assert!(roundtrip(&mut too_big, &json!({})).is_err());
    }

    #[test]
    fn endpunkt_ist_bestimmbar() {
        let ep = endpoint();
        if cfg!(windows) {
            assert_eq!(ep.as_deref(), Some(r"\\.\pipe\aegis-service"));
        } else if std::env::var_os("HOME").is_some() {
            assert!(ep.unwrap().ends_with("aegis-service/aegis.sock"));
        }
    }
}
