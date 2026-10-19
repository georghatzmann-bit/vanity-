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

/// Labor-Stufen (wie `aegis_core::plan::param::LAB_STAGES`).
const LAB_STAGES: [&str; 2] = ["windows_sandbox", "mini_sandbox"];

/// Anfrage „Im Labor ausführen vorschlagen“ (der Dienst prüft erneut und formuliert den Plan).
pub fn propose_lab_run_request(
    path: &str,
    stage: &str,
    seconds: u32,
    network: bool,
) -> Result<Value, String> {
    check_paths(&[path.to_owned()])?;
    if !LAB_STAGES.contains(&stage) {
        return Err("Unbekannte Labor-Stufe.".into());
    }
    if !(5..=600).contains(&seconds) {
        return Err("Beobachtungszeit 5–600 Sekunden.".into());
    }
    if network && stage != "windows_sandbox" {
        return Err("Netzwerk gibt es nur in der Windows Sandbox.".into());
    }
    Ok(json!({
        "type": "propose_lab_run", "path": path, "stage": stage,
        "seconds": seconds, "network": network,
    }))
}

/// Name eines Bildschirmfotos (`bild-NN.png`, wie die Sonde sie schreibt).
fn check_screenshot_name(name: &str) -> Result<(), String> {
    let ok = name.len() <= 32
        && name.ends_with(".png")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with('.');
    if ok {
        Ok(())
    } else {
        Err("Ungültiger Bildname.".into())
    }
}

/// Labor: Zustand der Windows Sandbox und eigene Läufe (nur lesend).
#[tauri::command]
pub async fn service_lab_status() -> Result<Value, String> {
    send(json!({ "type": "lab_status" })).await
}

/// Labor-Lauf vorschlagen – gestartet wird nur nach „Ja“ im Freigabe-Dialog.
#[tauri::command]
pub async fn service_propose_lab_run(
    path: String,
    stage: String,
    seconds: u32,
    network: bool,
) -> Result<Value, String> {
    send(propose_lab_run_request(&path, &stage, seconds, network)?).await
}

/// Bildschirmfoto eines eigenen Laufs der Windows Sandbox (PNG, Base64).
#[tauri::command]
pub async fn service_lab_screenshot(run_id: String, name: String) -> Result<Value, String> {
    check_id(&run_id)?;
    check_screenshot_name(&name)?;
    send(json!({ "type": "lab_screenshot", "run_id": run_id, "name": name })).await
}

/// Anfrage „Prozesse eines Programms beenden/anhalten/fortsetzen vorschlagen“ – die
/// Prozesse sucht der Dienst selbst (nur eigene des Kontos).
pub fn propose_process_request(program: &str, action: &str) -> Result<Value, String> {
    check_paths(&[program.to_owned()])?;
    if !matches!(action, "terminate" | "suspend" | "resume") {
        return Err("Unbekannte Aktion.".into());
    }
    Ok(json!({ "type": "propose_process_action", "program": program, "action": action }))
}

/// Prozess-Aktion vorschlagen – ausgeführt wird nur nach „Ja“ im Freigabe-Dialog.
#[tauri::command]
pub async fn service_propose_process_action(
    program: String,
    action: String,
) -> Result<Value, String> {
    send(propose_process_request(&program, &action)?).await
}

/// Speicher-Scan der eigenen laufenden Programme (nur lesend).
#[tauri::command]
pub async fn service_memory_scan() -> Result<Value, String> {
    send(json!({ "type": "memory_scan" })).await
}

/// Panic-Button: Zustand (nur lesend).
#[tauri::command]
pub async fn service_panic_status() -> Result<Value, String> {
    send(json!({ "type": "panic_status" })).await
}

/// Netz trennen bzw. wieder verbinden vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_panic(on: bool) -> Result<Value, String> {
    send(json!({ "type": "propose_panic", "on": on })).await
}

/// Notfall-Scan (nur lesend; stößt ein Signatur-Update an).
#[tauri::command]
pub async fn service_emergency_scan() -> Result<Value, String> {
    send(json!({ "type": "emergency_scan" })).await
}

/// Anfrage „Alles rückgängig“: mehrere Quarantäne-Einträge in einem Plan wiederherstellen.
pub fn propose_restore_many_request(entry_ids: &[String]) -> Result<Value, String> {
    if entry_ids.is_empty() || entry_ids.len() > MAX_PATHS {
        return Err(format!("1 bis {MAX_PATHS} Einträge erwartet."));
    }
    for id in entry_ids {
        check_id(id)?;
    }
    Ok(json!({ "type": "propose_restore_many", "entry_ids": entry_ids }))
}

/// „Alles rückgängig machen“ vorschlagen – wiederhergestellt wird nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_restore_many(entry_ids: Vec<String>) -> Result<Value, String> {
    send(propose_restore_many_request(&entry_ids)?).await
}

/// Höchstlänge eines Passworts (Zeichen).
const MAX_PASSWORD_CHARS: usize = 256;

/// Anfrage mit Passwort (Datei-Safe). Das Passwort wird nur an den Dienst weitergereicht –
/// nie gespeichert oder protokolliert.
pub fn safe_password_request(kind: &str, password: &str) -> Result<Value, String> {
    if password.is_empty()
        || password.chars().count() > MAX_PASSWORD_CHARS
        || password.contains('\0')
    {
        return Err(format!("Passwort: 1 bis {MAX_PASSWORD_CHARS} Zeichen."));
    }
    Ok(json!({ "type": kind, "password": password }))
}

/// Datei-Safe: Zustand und – wenn entsperrt – Einträge (nur lesend).
#[tauri::command]
pub async fn service_safe_status() -> Result<Value, String> {
    send(json!({ "type": "safe_status" })).await
}

/// Datei-Safe anlegen vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_safe_setup(password: String) -> Result<Value, String> {
    send(safe_password_request("propose_safe_setup", &password)?).await
}

/// Datei-Safe entsperren (verändert nichts; der Schlüssel bleibt nur im Dienst).
#[tauri::command]
pub async fn service_safe_unlock(password: String) -> Result<Value, String> {
    send(safe_password_request("safe_unlock", &password)?).await
}

/// Datei-Safe sperren.
#[tauri::command]
pub async fn service_safe_lock() -> Result<Value, String> {
    send(json!({ "type": "safe_lock" })).await
}

/// Dateien in den Safe legen vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_safe_store(paths: Vec<String>) -> Result<Value, String> {
    check_paths(&paths)?;
    send(json!({ "type": "propose_safe_store", "paths": paths })).await
}

/// Eintrag aus dem Safe holen vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_safe_retrieve(id: String) -> Result<Value, String> {
    check_id(&id)?;
    send(json!({ "type": "propose_safe_retrieve", "id": id })).await
}

/// Rückfall-Kopien: Zustand und neueste Versionen (nur lesend).
#[tauri::command]
pub async fn service_backup_status() -> Result<Value, String> {
    send(json!({ "type": "backup_status" })).await
}

/// Erlaubte Schritte der Härtung (wie im Dienst).
const HARDENING_FIXES: [&str; 8] = [
    "enable_uac",
    "disable_smb1",
    "disable_rdp",
    "enable_rdp_nla",
    "disable_guest",
    "enable_firewall",
    "disable_proxy",
    "enable_driver_blocklist",
];

/// Härtung: einen Punkt beheben vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_hardening_fix(fix: String) -> Result<Value, String> {
    if !HARDENING_FIXES.contains(&fix.as_str()) {
        return Err("Unbekannter Schritt.".into());
    }
    send(json!({ "type": "propose_hardening_fix", "fix": fix })).await
}

/// Härtung: ein Beheben rückgängig machen vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_hardening_undo(id: String) -> Result<Value, String> {
    check_id(&id)?;
    send(json!({ "type": "propose_hardening_undo", "id": id })).await
}

/// Persistenz-Check: Autostart-Einträge lesen und bewerten (nur lesend).
#[tauri::command]
pub async fn service_persistence_status() -> Result<Value, String> {
    send(json!({ "type": "persistence_status" })).await
}

/// Autostart-Eintrag aus dem letzten Check deaktivieren vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_autorun_disable(id: String) -> Result<Value, String> {
    check_id(&id)?;
    send(json!({ "type": "propose_autorun_disable", "id": id })).await
}

/// winget-Kennung: Buchstaben, Ziffern, `.`, `-`, `_`, `+`; beginnt nicht mit einem Schalter.
fn check_package_id(value: &str) -> Result<(), String> {
    let ok = value.len() <= 128
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'));
    if ok {
        Ok(())
    } else {
        Err("Ungültige Paket-Kennung.".to_owned())
    }
}

/// Geräte & Privatsphäre: Kamera-/Mikrofon-Nutzung des Kontos, Tastaturen, USB-Laufwerke
/// (nur lesend).
#[tauri::command]
pub async fn service_devices_status() -> Result<Value, String> {
    send(json!({ "type": "devices_status" })).await
}

/// Netzwerk: Verbindungen je Programm (eigene; Administratoren: alle) und Verlauf (nur lesend).
#[tauri::command]
pub async fn service_network_status() -> Result<Value, String> {
    send(json!({ "type": "network_status" })).await
}

/// Firewall-Übersicht (nur lesend).
#[tauri::command]
pub async fn service_firewall_status() -> Result<Value, String> {
    send(json!({ "type": "firewall_status" })).await
}

/// AEGIS-Firewall-Regel für ein Programm anlegen (`block`) bzw. entfernen vorschlagen – nur
/// nach „Ja“.
#[tauri::command]
pub async fn service_propose_firewall_block(program: String, block: bool) -> Result<Value, String> {
    if program.is_empty() || program.len() > 260 || program.chars().any(char::is_control) {
        return Err("Ungültiger Programmpfad.".to_owned());
    }
    send(json!({ "type": "propose_firewall_block", "program": program, "block": block })).await
}

/// Software-Updates: winget nach neueren Versionen fragen (nur lesend, braucht Netz).
#[tauri::command]
pub async fn service_software_updates() -> Result<Value, String> {
    send(json!({ "type": "software_updates" })).await
}

/// Ein Paket aus der letzten Abfrage aktualisieren vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_software_update(id: String) -> Result<Value, String> {
    check_package_id(&id)?;
    send(json!({ "type": "propose_software_update", "id": id })).await
}

/// Härtung: Systemzustand lesen und bewerten (nur lesend). `fresh`: neu prüfen statt ein
/// bis zu 10 Minuten altes Ergebnis.
#[tauri::command]
pub async fn service_hardening_status(fresh: bool) -> Result<Value, String> {
    send(json!({ "type": "hardening_status", "fresh": fresh })).await
}

/// Rückfall-Kopien ein-/ausschalten vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_backup(on: bool, quota_mb: u64) -> Result<Value, String> {
    send(json!({ "type": "propose_backup", "on": on, "quota_mb": quota_mb })).await
}

/// Version zurückholen vorschlagen – nur nach „Ja“, nie überschreibend.
#[tauri::command]
pub async fn service_propose_backup_restore(id: String) -> Result<Value, String> {
    check_id(&id)?;
    send(json!({ "type": "propose_backup_restore", "id": id })).await
}

/// Neueste Versionen in einen gewählten Ordner exportieren vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_backup_export(folder: String) -> Result<Value, String> {
    check_paths(std::slice::from_ref(&folder))?;
    send(json!({ "type": "propose_backup_export", "folder": folder })).await
}

/// Alte Versionen ausdünnen vorschlagen – nur nach „Ja“ und zweiter Bestätigung.
#[tauri::command]
pub async fn service_propose_backup_prune(days: u32) -> Result<Value, String> {
    send(json!({ "type": "propose_backup_prune", "days": days })).await
}

/// Eigene Schutzordner setzen (nur Beobachtung; höchstens 20, leer = keine).
#[tauri::command]
pub async fn service_set_protected_folders(folders: Vec<String>) -> Result<Value, String> {
    if !folders.is_empty() {
        check_paths(&folders)?;
    }
    if folders.len() > 20 {
        return Err("Höchstens 20 Ordner.".into());
    }
    send(json!({ "type": "set_protected_folders", "folders": folders })).await
}

/// Ransomware-Schutz: eigene Köderdateien (nur lesend).
#[tauri::command]
pub async fn service_ransom_status() -> Result<Value, String> {
    send(json!({ "type": "ransom_status" })).await
}

/// Köderdateien anlegen bzw. entfernen vorschlagen – nur nach „Ja“.
#[tauri::command]
pub async fn service_propose_baits(on: bool) -> Result<Value, String> {
    send(json!({ "type": "propose_baits", "on": on })).await
}

/// „Windows Sandbox einschalten“ vorschlagen (nur Administratoren, nur nach „Ja“).
#[tauri::command]
pub async fn service_propose_enable_sandbox() -> Result<Value, String> {
    send(json!({ "type": "propose_enable_sandbox" })).await
}

/// Fensterfotos eines laufenden Mini-Sandbox-Laufs (Stufe 2). Die Probe läuft auf dem
/// Desktop des Nutzers; der Dienst (Sitzung 0) sieht ihn nicht – deshalb fotografiert die App
/// (nur lesend). Prozess-IDs und AppContainer-SID nennt der Dienst für den eigenen Lauf, nie
/// die Oberfläche; fotografiert werden nur Fenster von Prozessen genau dieses AppContainers
/// (eine inzwischen wiederverwendete Prozess-ID gehört nicht dazu).
#[tauri::command]
pub async fn lab_capture_windows(run_id: String) -> Result<Vec<String>, String> {
    check_id(&run_id)?;
    let status = send(json!({ "type": "lab_status" })).await?;
    let Some((pids, container)) = running_pids(&status, &run_id) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || capture(&pids, &container))
        .await
        .map_err(|e| format!("Interner Fehler: {e}"))
}

/// Prozess-IDs und AppContainer-SID eines laufenden Mini-Sandbox-Laufs aus der Antwort `lab`.
pub fn running_pids(status: &Value, run_id: &str) -> Option<(Vec<u32>, String)> {
    let run = status["runs"]
        .as_array()?
        .iter()
        .find(|r| r["id"] == run_id && r["stage"] == "mini_sandbox")
        .filter(|r| r["state"]["state"] == "running")?;
    let container = run["container"]
        .as_str()
        .filter(|c| c.starts_with("S-1-15-2-"))?
        .to_owned();
    let pids: Vec<u32> = run["state"]["pids"]
        .as_array()?
        .iter()
        .filter_map(|p| p.as_u64().and_then(|p| u32::try_from(p).ok()))
        .filter(|p| *p != 0)
        .take(64)
        .collect();
    (!pids.is_empty()).then_some((pids, container))
}

/// Höchstzahl Fensterfotos je Abruf.
#[cfg(windows)]
const MAX_WINDOW_SHOTS: usize = 4;

#[cfg(windows)]
fn capture(pids: &[u32], container: &str) -> Vec<String> {
    use base64::Engine as _;
    let own: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|&pid| {
            aegis_winffi::inspect::process_appcontainer_sid(pid).as_deref() == Some(container)
        })
        .collect();
    aegis_winffi::inspect::capture_windows(&own, MAX_WINDOW_SHOTS)
        .into_iter()
        .filter_map(|c| aegis_sandbox::png::encode_bgra(c.width, c.height, &c.bgra).ok())
        .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
        .collect()
}

#[cfg(not(windows))]
fn capture(_pids: &[u32], _container: &str) -> Vec<String> {
    Vec::new()
}

/// Vollständiger Verhaltensbericht eines eigenen Labor-Laufs (nur lesend).
#[tauri::command]
pub async fn service_lab_report(run_id: String) -> Result<Value, String> {
    check_id(&run_id)?;
    send(json!({ "type": "lab_report", "run_id": run_id })).await
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
        assert!(propose_lab_run_request(&abs, "mini_sandbox", 30, false).is_ok());
        assert!(propose_lab_run_request(&abs, "windows_sandbox", 600, true).is_ok());
        assert!(propose_lab_run_request(&abs, "mini_sandbox", 30, true).is_err());
        assert!(propose_lab_run_request(&abs, "kernel", 30, false).is_err());
        assert!(propose_lab_run_request(&abs, "mini_sandbox", 4, false).is_err());
        assert!(propose_lab_run_request("relativ", "mini_sandbox", 30, false).is_err());
        assert!(check_screenshot_name("bild-01.png").is_ok());
        assert!(propose_process_request(&abs, "terminate").is_ok());
        assert!(propose_process_request(&abs, "kill -9").is_err());
        assert!(propose_process_request("a.exe", "suspend").is_err());
        assert!(check_screenshot_name("../x.png").is_err());
        assert!(check_screenshot_name("bild.exe").is_err());
        assert!(propose_restore_many_request(&["a-1".into(), "b-2".into()]).is_ok());
        assert!(propose_restore_many_request(&[]).is_err());
        assert!(propose_restore_many_request(&["a,b".into()]).is_err());
        assert!(safe_password_request("safe_unlock", "ein-passwort").is_ok());
        assert!(safe_password_request("safe_unlock", "").is_err());
        assert!(safe_password_request("safe_unlock", &"x".repeat(257)).is_err());
        assert!(safe_password_request("propose_safe_setup", "a\0b").is_err());
    }

    #[test]
    fn fensterfotos_nur_fuer_laufende_eigene_mini_laeufe() {
        let status = json!({ "runs": [
            { "id": "a", "stage": "mini_sandbox", "container": "S-1-15-2-1-2",
              "state": { "state": "running", "pids": [12, 0, 13] } },
            { "id": "b", "stage": "windows_sandbox", "container": "S-1-15-2-1-2",
              "state": { "state": "running", "pids": [14] } },
            { "id": "c", "stage": "mini_sandbox", "container": "S-1-15-2-1-2",
              "state": { "state": "preparing" } },
            { "id": "d", "stage": "mini_sandbox", "container": "S-1-5-18",
              "state": { "state": "running", "pids": [15] } },
            { "id": "e", "stage": "mini_sandbox",
              "state": { "state": "running", "pids": [16] } },
        ]});
        assert_eq!(
            running_pids(&status, "a"),
            Some((vec![12, 13], "S-1-15-2-1-2".to_owned()))
        );
        for id in ["b", "c", "d", "e", "x"] {
            assert!(running_pids(&status, id).is_none(), "{id}");
        }
        assert!(running_pids(&json!({}), "a").is_none());
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
