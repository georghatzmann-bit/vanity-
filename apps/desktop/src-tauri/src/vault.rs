//! Passwort-Tresor (P9) in der App: Die Tresordatei liegt im App-Datenordner des Kontos
//! (`vault.aegisvault`), entsperrt wird mit dem Master-Passwort (Argon2id → AES-256-GCM, siehe
//! `aegis-vault-core`). Schlüssel und Einträge liegen nur im Speicher dieses Prozesses und werden
//! beim Sperren überschrieben (Zeroize). Die Oberfläche bekommt Passwörter nur auf ausdrücklichen
//! Klick („Anzeigen“, „Kopieren“).
//!
//! - **Auto-Sperre:** nach einstellbarer Untätigkeit (Standard 5 Minuten).
//! - **Zwischenablage:** „Kopieren“ setzt den Text ohne Verlauf/Cloud und leert ihn nach 30 s,
//!   wenn nichts anderes kopiert wurde.
//! - **Fehlversuche:** ab dem dritten wächst die Wartezeit (bis 60 s).
//! - **Speichern:** erst in eine Hilfsdatei, dann ersetzen; die vorige Fassung bleibt als `.bak`
//!   (nach einem Master-Wechsel die neue – die alte war mit dem alten Passwort lesbar).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aegis_vault_core::generate::{Options, generate};
use aegis_vault_core::import::{MAX_IMPORT, parse_csv};
use aegis_vault_core::strength::{Strength, estimate, reused};
use aegis_vault_core::{EntryInput, EntrySummary, KdfParams, Vault, VaultError};
use serde::Serialize;
use tauri::Manager;
use zeroize::Zeroizing;

/// Name der Tresordatei.
pub const VAULT_FILE: &str = "vault.aegisvault";
/// Zwischenablage nach so vielen Sekunden leeren.
pub const CLIPBOARD_SECONDS: u64 = 30;
/// Standard der Auto-Sperre (Minuten).
pub const DEFAULT_LOCK_MINUTES: u32 = 5;

struct Inner {
    open: Option<(Vault, PathBuf)>,
    last_activity: Instant,
    lock_minutes: u32,
    failures: u32,
    retry_after: Option<Instant>,
    clipboard: Option<(u32, Instant)>,
    /// Anlegen oder Entsperren läuft (Argon2id außerhalb der Sperre): kein zweiter Versuch
    /// gleichzeitig – sonst ließen sich Fehlversuche parallel durchprobieren.
    busy: bool,
    /// Zeitpunkte der letzten Ausfüll-Anfragen der Browser-Erweiterung (Begrenzung).
    #[cfg_attr(not(windows), allow(dead_code))]
    fills: std::collections::VecDeque<Instant>,
    /// Zeitpunkte aller Anfragen der Erweiterung (Begrenzung).
    #[cfg_attr(not(windows), allow(dead_code))]
    requests: std::collections::VecDeque<Instant>,
}

static STATE: LazyLock<Mutex<Inner>> = LazyLock::new(|| {
    Mutex::new(Inner {
        open: None,
        last_activity: Instant::now(),
        lock_minutes: DEFAULT_LOCK_MINUTES,
        failures: 0,
        retry_after: None,
        clipboard: None,
        busy: false,
        fills: std::collections::VecDeque::new(),
        requests: std::collections::VecDeque::new(),
    })
});
static WATCHER: AtomicBool = AtomicBool::new(false);

fn state() -> MutexGuard<'static, Inner> {
    STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

fn vault_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join(VAULT_FILE))
        .map_err(|e| format!("Datenordner unbekannt: {e}"))
}

/// Sperrt bei Untätigkeit und leert die Zwischenablage nach Ablauf (eigener Faden, einmal).
fn start_watcher() {
    if WATCHER.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("aegis-vault-lock".into())
        .spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let mut s = state();
                let idle = Duration::from_secs(u64::from(s.lock_minutes) * 60);
                if s.open.is_some() && s.last_activity.elapsed() >= idle {
                    lock(&mut s);
                }
                if let Some((sequence, at)) = s.clipboard
                    && at.elapsed() >= Duration::from_secs(CLIPBOARD_SECONDS)
                {
                    s.clipboard = None;
                    clear_clipboard(sequence);
                }
            }
        });
    if spawned.is_err() {
        WATCHER.store(false, Ordering::SeqCst);
    }
}

/// Sperrt: Schlüssel und Einträge werden überschrieben, eine eigene Kopie in der
/// Zwischenablage wird geleert.
fn lock(s: &mut Inner) {
    s.open = None;
    if let Some((sequence, _)) = s.clipboard.take() {
        clear_clipboard(sequence);
    }
}

/// Beim Beenden der App: sperren und die Zwischenablage leeren.
pub fn shutdown() {
    lock(&mut state());
}

#[cfg(windows)]
fn clear_clipboard(sequence: u32) {
    let _ = aegis_winffi::clipboard::clear_if_unchanged(sequence);
}

#[cfg(not(windows))]
fn clear_clipboard(_sequence: u32) {}

/// Was mit der Sicherung `.bak` geschieht.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Backup {
    /// Vorige Fassung sichern.
    Previous,
    /// Neue Fassung auch als Sicherung (nach dem Master-Wechsel).
    Fresh,
}

/// Schreibt die Tresordatei: Hilfsdatei, dann ersetzen; vorher die alte als `.bak`.
fn save_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    save_file_with(path, bytes, Backup::Previous)
}

fn save_file_with(path: &Path, bytes: &[u8], backup: Backup) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("Ordner unbekannt")?;
    let tmp = path.with_extension("aegisvault.tmp");
    let bak = path.with_extension("aegisvault.bak");
    // Legt nur den eigenen App-Datenordner an (falls er fehlt).
    // aegis-mutation: desktop-vault-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir).map_err(|e| format!("Ordner nicht anlegbar: {e}"))?;
    {
        // Schreibt nur die eigene Hilfsdatei neben der Tresordatei (verschlüsselter Inhalt).
        // aegis-mutation: desktop-vault-write
        #[allow(clippy::disallowed_methods)]
        let mut file =
            std::fs::File::create(&tmp).map_err(|e| format!("Speichern nicht möglich: {e}"))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("Speichern nicht möglich: {e}"))?;
    }
    if backup == Backup::Previous && path.exists() {
        // Sicherung der vorigen Fassung (eigene Datei, wird beim nächsten Speichern ersetzt).
        // aegis-mutation: desktop-vault-backup
        #[allow(clippy::disallowed_methods)]
        let _ = std::fs::copy(path, &bak);
    }
    // Ersetzt die eigene Tresordatei durch die eben geschriebene Fassung.
    // aegis-mutation: desktop-vault-replace
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(&tmp, path).map_err(|e| format!("Speichern nicht möglich: {e}"))?;
    if backup == Backup::Fresh {
        // Neue Fassung auch als Sicherung: Die alte bliebe mit dem alten Passwort lesbar.
        // aegis-mutation: desktop-vault-backup-fresh
        #[allow(clippy::disallowed_methods)]
        std::fs::copy(path, &bak).map_err(|e| format!("Sicherung nicht ersetzt: {e}"))?;
    }
    Ok(())
}

fn save(s: &Inner) -> Result<(), String> {
    save_with(s, Backup::Previous)
}

fn save_with(s: &Inner, backup: Backup) -> Result<(), String> {
    let (vault, path) = s.open.as_ref().ok_or(LOCKED)?;
    let bytes = Zeroizing::new(vault.to_bytes().map_err(|e| e.to_string())?);
    save_file_with(path, &bytes, backup)
}

/// Größte Tresordatei, die gelesen wird.
const MAX_VAULT_FILE: u64 = 64 * 1024 * 1024;

/// Hebt „läuft“ beim Verlassen auf (auch bei Fehlern).
struct Busy;

impl Busy {
    fn take() -> Result<Self, String> {
        let mut s = state();
        if s.busy {
            return Err("busy".into());
        }
        if s.retry_after.is_some_and(|t| t > Instant::now()) {
            return Err("wait".into());
        }
        s.busy = true;
        Ok(Self)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        state().busy = false;
    }
}

/// Liest die Tresordatei (höchstens [`MAX_VAULT_FILE`]).
fn read_vault(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let missing = || "Kein Tresor gefunden.".to_owned();
    let file = std::fs::File::open(path).map_err(|_| missing())?;
    let len = file.metadata().map_err(|_| missing())?.len();
    if len > MAX_VAULT_FILE {
        return Err("Die Tresordatei ist zu groß.".into());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(MAX_VAULT_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| missing())?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_VAULT_FILE {
        return Err("Die Tresordatei ist zu groß.".into());
    }
    Ok(bytes)
}

const LOCKED: &str = "locked";

fn with_open<T>(f: impl FnOnce(&mut Inner) -> Result<T, String>) -> Result<T, String> {
    let mut s = state();
    if s.open.is_none() {
        return Err(LOCKED.into());
    }
    s.last_activity = Instant::now();
    f(&mut s)
}

fn vault_mut(s: &mut Inner) -> Result<&mut Vault, String> {
    s.open.as_mut().map(|(v, _)| v).ok_or_else(|| LOCKED.into())
}

/// Zustand für die Oberfläche.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// Gibt es eine Tresordatei?
    pub exists: bool,
    /// Entsperrt?
    pub unlocked: bool,
    /// Auto-Sperre in Minuten.
    pub lock_minutes: u32,
    /// Sekunden bis zum nächsten erlaubten Versuch (nach Fehlversuchen).
    pub retry_in: u64,
}

/// Status des Tresors.
#[tauri::command]
pub fn vault_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<VaultStatus, String> {
    let path = vault_path(&app)?;
    let s = state();
    Ok(VaultStatus {
        exists: path.exists(),
        unlocked: s.open.is_some(),
        lock_minutes: s.lock_minutes,
        retry_in: s
            .retry_after
            .map_or(0, |t| t.saturating_duration_since(Instant::now()).as_secs()),
    })
}

/// Neuen Tresor anlegen (nur wenn noch keiner existiert).
#[tauri::command]
pub async fn vault_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    master: String,
) -> Result<(), String> {
    let master = Zeroizing::new(master);
    let path = vault_path(&app)?;
    let busy = Busy::take()?;
    if path.exists() {
        return Err("Es gibt bereits einen Tresor.".into());
    }
    let vault = tauri::async_runtime::spawn_blocking(move || {
        Vault::create(&master, KdfParams::DEFAULT).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let bytes = vault.to_bytes().map_err(|e| e.to_string())?;
    // Während Argon2id lief, könnte ein Tresor entstanden sein – nie überschreiben.
    if path.exists() {
        return Err("Es gibt bereits einen Tresor.".into());
    }
    save_file(&path, &bytes)?;
    let mut s = state();
    s.open = Some((vault, path));
    s.last_activity = Instant::now();
    drop(s);
    drop(busy);
    start_watcher();
    Ok(())
}

/// Entsperren.
#[tauri::command]
pub async fn vault_unlock<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    master: String,
) -> Result<(), String> {
    let master = Zeroizing::new(master);
    let path = vault_path(&app)?;
    // Nur ein Versuch zugleich; die Wartezeit nach Fehlversuchen gilt für alle.
    let busy = Busy::take()?;
    let bytes = read_vault(&path)?;
    let result = tauri::async_runtime::spawn_blocking(move || Vault::open(&bytes, &master))
        .await
        .map_err(|e| e.to_string())?;
    drop(busy);
    let mut s = state();
    match result {
        Ok(vault) => {
            s.open = Some((vault, path));
            s.failures = 0;
            s.retry_after = None;
            s.last_activity = Instant::now();
            drop(s);
            start_watcher();
            Ok(())
        }
        Err(VaultError::WrongPassword) => {
            s.failures = s.failures.saturating_add(1);
            if s.failures >= 3 {
                let wait = 2u64.saturating_pow(s.failures - 2).min(60);
                s.retry_after = Some(Instant::now() + Duration::from_secs(wait));
            }
            Err("wrong_password".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Sperren (Schlüssel und Einträge werden überschrieben).
#[tauri::command]
pub fn vault_lock() {
    lock(&mut state());
}

/// Auto-Sperre einstellen (1–60 Minuten).
#[tauri::command]
pub fn vault_set_lock_minutes(minutes: u32) -> Result<(), String> {
    if !(1..=60).contains(&minutes) {
        return Err("1 bis 60 Minuten".into());
    }
    state().lock_minutes = minutes;
    Ok(())
}

/// Liste für die Oberfläche (ohne Passwörter).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultList {
    /// Einträge.
    pub entries: Vec<EntrySummary>,
    /// Ordner.
    pub folders: Vec<String>,
    /// Kennungen mit schwachem Passwort.
    pub weak: Vec<String>,
    /// Kennungen mit mehrfach verwendetem Passwort.
    pub reused: Vec<String>,
}

/// Einträge (ohne Geheimnisse), dazu Ordner und Gesundheit.
#[tauri::command]
pub fn vault_list() -> Result<VaultList, String> {
    with_open(|s| {
        let vault = vault_mut(s)?;
        let entries = vault.entries();
        let weak = entries
            .iter()
            .filter(|e| !e.password.is_empty())
            .filter(|e| {
                matches!(
                    estimate(&e.password).level,
                    aegis_vault_core::strength::Level::VeryWeak
                        | aegis_vault_core::strength::Level::Weak
                )
            })
            .map(|e| e.id.clone())
            .collect();
        Ok(VaultList {
            entries: entries
                .iter()
                .map(aegis_vault_core::Entry::summary)
                .collect(),
            folders: vault.folders(),
            weak,
            reused: reused(entries),
        })
    })
}

/// Geheimnisse eines Eintrags (nur auf Klick „Anzeigen“/„Bearbeiten“).
#[derive(Debug, Serialize)]
pub struct Secret {
    /// Passwort.
    pub password: String,
    /// Notizen.
    pub notes: String,
}

/// Passwort und Notizen eines Eintrags.
#[tauri::command]
pub fn vault_reveal(id: String) -> Result<Secret, String> {
    with_open(|s| {
        let e = vault_mut(s)?.get(&id).ok_or("Eintrag nicht gefunden.")?;
        Ok(Secret {
            password: e.password.clone(),
            notes: e.notes.clone(),
        })
    })
}

/// Eintrag anlegen (`id` leer) oder ändern; speichert sofort.
#[tauri::command]
pub fn vault_save(id: Option<String>, entry: EntryInput) -> Result<String, String> {
    with_open(|s| {
        let now = now_unix();
        let vault = vault_mut(s)?;
        let id = match id.filter(|i| !i.is_empty()) {
            Some(id) => {
                vault.update(&id, &entry, now).map_err(|e| e.to_string())?;
                id
            }
            None => vault.add(&entry, now).map_err(|e| e.to_string())?,
        };
        save(s)?;
        Ok(id)
    })
}

/// Eintrag löschen (die Oberfläche hat vorher nachgefragt); speichert sofort.
#[tauri::command]
pub fn vault_delete(id: String) -> Result<(), String> {
    with_open(|s| {
        vault_mut(s)?.remove(&id).map_err(|e| e.to_string())?;
        save(s)
    })
}

/// Benutzername oder Passwort in die Zwischenablage (30 s, ohne Verlauf).
#[tauri::command]
pub fn vault_copy(id: String, field: String) -> Result<u64, String> {
    with_open(|s| {
        let e = vault_mut(s)?.get(&id).ok_or("Eintrag nicht gefunden.")?;
        let text = Zeroizing::new(match field.as_str() {
            "password" => e.password.clone(),
            "username" => e.username.clone(),
            _ => return Err("Unbekanntes Feld".into()),
        });
        let sequence = copy_text(&text)?;
        s.clipboard = Some((sequence, Instant::now()));
        Ok(CLIPBOARD_SECONDS)
    })
}

#[cfg(windows)]
fn copy_text(text: &str) -> Result<u32, String> {
    aegis_winffi::clipboard::set_private_text(text)
        .map_err(|e| format!("Zwischenablage belegt: {e}"))
}

#[cfg(not(windows))]
fn copy_text(_text: &str) -> Result<u32, String> {
    Err("windows_only".into())
}

/// Passwort erzeugen.
#[tauri::command]
pub fn vault_generate(options: Options) -> Result<String, String> {
    generate(&options).map(|p| p.to_string())
}

/// Stärke eines Passworts schätzen (für den Bearbeiten-Dialog).
#[tauri::command]
pub fn vault_strength(password: String) -> Strength {
    let password = Zeroizing::new(password);
    estimate(&password)
}

/// Ergebnis des Imports.
#[derive(Debug, Serialize)]
pub struct ImportResult {
    /// Übernommen.
    pub imported: usize,
    /// Übersprungen.
    pub skipped: usize,
}

/// CSV-Export (vom Nutzer gewählte Datei) übernehmen; speichert sofort.
#[tauri::command]
pub fn vault_import(path: String) -> Result<ImportResult, String> {
    let path = PathBuf::from(path);
    let meta = std::fs::metadata(&path).map_err(|_| "Datei nicht lesbar.".to_owned())?;
    if !meta.is_file() || meta.len() > u64::try_from(MAX_IMPORT).unwrap_or(u64::MAX) {
        return Err("Die Datei ist zu groß oder keine Datei.".into());
    }
    // Liest nur die vom Nutzer gewählte Exportdatei.
    let text = Zeroizing::new(std::fs::read_to_string(&path).map_err(|_| "Datei nicht lesbar.")?);
    let imported = parse_csv(&text)?;
    with_open(|s| {
        let now = now_unix();
        let vault = vault_mut(s)?;
        let mut count = 0;
        for entry in &imported.entries {
            if vault.add(entry, now).is_ok() {
                count += 1;
            }
        }
        save(s)?;
        Ok(ImportResult {
            imported: count,
            skipped: imported.skipped + (imported.entries.len() - count),
        })
    })
}

/// Master-Passwort ändern; speichert sofort.
#[tauri::command]
pub async fn vault_change_master(old: String, new: String) -> Result<(), String> {
    let old = Zeroizing::new(old);
    let new = Zeroizing::new(new);
    // Die Ableitung (zweimal Argon2id) außerhalb des Faden-Pools der Oberfläche.
    tauri::async_runtime::spawn_blocking(move || {
        with_open(|s| {
            vault_mut(s)?
                .change_master(&old, &new)
                .map_err(|e| match e {
                    VaultError::WrongPassword => "wrong_password".to_owned(),
                    other => other.to_string(),
                })?;
            save_with(s, Backup::Fresh)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ausfüll-Anfragen der Erweiterung je Minute (danach „rate_limited“).
#[cfg_attr(not(windows), allow(dead_code))]
const FILLS_PER_MINUTE: usize = 30;
/// Anfragen der Erweiterung insgesamt je Minute.
#[cfg_attr(not(windows), allow(dead_code))]
const REQUESTS_PER_MINUTE: usize = 120;

/// Gleitendes Fenster von einer Minute: `true`, wenn noch Platz ist (und trägt ein).
#[cfg_attr(not(windows), allow(dead_code))]
fn admit(queue: &mut std::collections::VecDeque<Instant>, max: usize) -> bool {
    let now = Instant::now();
    while queue
        .front()
        .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
    {
        queue.pop_front();
    }
    if queue.len() >= max {
        return false;
    }
    queue.push_back(now);
    true
}

/// Beantwortet eine Anfrage der Browser-Erweiterung (über Host und Pipe).
#[cfg_attr(not(windows), allow(dead_code))]
fn bridge_answer(line: &[u8]) -> aegis_vault_core::bridge::Response {
    use aegis_vault_core::bridge::{Request, Response, handle, parse};
    let Ok(request) = parse(line) else {
        return Response::error("invalid");
    };
    let mut s = state();
    if s.open.is_some() {
        let s = &mut *s;
        if !admit(&mut s.requests, REQUESTS_PER_MINUTE)
            || (matches!(request, Request::Fill { .. }) && !admit(&mut s.fills, FILLS_PER_MINUTE))
        {
            return Response::error("rate_limited");
        }
    }
    handle(&request, s.open.as_ref().map(|(v, _)| v))
}

/// Startet die Brücke zur Browser-Erweiterung: eine Pipe nur für das eigene Konto; Anfragen
/// werden nur vom Host `aegis-vault-host.exe` aus dem eigenen Programmordner angenommen.
/// Grenze (ehrlich): Ein Programm desselben Kontos kann den Host ebenfalls starten – wie bei
/// jedem Passwort-Manager schützt das Konto, nicht die Pfadprüfung.
#[cfg(windows)]
pub fn start_bridge() {
    let _ = std::thread::Builder::new()
        .name("aegis-vault-bridge".into())
        .spawn(bridge_loop);
}

/// Neue Instanz der eigenen Pipe – nur, wenn sie wirklich dem eigenen Konto gehört.
#[cfg(windows)]
fn own_instance(name: &str, sid: &str, first: bool) -> Option<std::os::windows::io::OwnedHandle> {
    let instance = aegis_winffi::pipe::create_user_instance(name, first).ok()?;
    (aegis_winffi::pipe::pipe_owner_sid(&instance)
        .ok()
        .as_deref()
        == Some(sid))
    .then_some(instance)
}

#[cfg(windows)]
fn bridge_loop() {
    use aegis_winffi::pipe::{accept, current_user_sid, disconnect, vault_pipe_name};
    let Ok(sid) = current_user_sid() else {
        return;
    };
    let name = vault_pipe_name(&sid);
    let Some(host) = std::env::current_exe()
        .ok()
        .map(|p| p.with_file_name("aegis-vault-host.exe"))
    else {
        return;
    };
    // Immer eine lauschende Instanz: Die nächste entsteht, bevor die verbundene geschlossen
    // wird – so ist der Name nie frei und kein anderes Konto kann ihn belegen. Muss die Pipe
    // doch neu entstehen, dann nur als erste Instanz (sonst stoppt die Brücke).
    let Some(mut listening) = own_instance(&name, &sid, true) else {
        return;
    };
    loop {
        let Ok(conn) = accept(listening) else {
            match own_instance(&name, &sid, true) {
                Some(i) => {
                    listening = i;
                    continue;
                }
                None => return,
            }
        };
        let next = own_instance(&name, &sid, false);
        serve(&conn, &host, &sid);
        let _ = disconnect(&conn);
        drop(conn);
        match next.or_else(|| own_instance(&name, &sid, true)) {
            Some(i) => listening = i,
            None => return,
        }
    }
}

/// Eine Verbindung: Gegenstelle prüfen (Programm und Konto), eine Zeile lesen, antworten –
/// höchstens 2 s, dann wird getrennt.
#[cfg(windows)]
fn serve(conn: &std::fs::File, host: &Path, sid: &str) {
    use std::io::{BufRead, Read, Write};
    let Ok(pid) = aegis_winffi::pipe::client_process_id(conn) else {
        return;
    };
    let image = aegis_winffi::system::process_image_path(pid).ok();
    let same_program = image.is_some_and(|c| {
        c.to_string_lossy()
            .eq_ignore_ascii_case(&host.to_string_lossy())
    });
    let same_account = aegis_winffi::system::process_user_sid(pid)
        .ok()
        .is_some_and(|s| s == sid);
    if !same_program || !same_account {
        return;
    }
    let (done, finished) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let mut reader = conn;
            let mut line = Zeroizing::new(Vec::new());
            let limit = u64::try_from(aegis_vault_core::bridge::MAX_REQUEST + 1).unwrap_or(8193);
            let read =
                std::io::BufReader::new((&mut reader).take(limit)).read_until(b'\n', &mut line);
            if read.is_ok() {
                let answer = Zeroizing::new(
                    serde_json::to_vec(&bridge_answer(line.trim_ascii())).unwrap_or_default(),
                );
                let mut writer = conn;
                let _ = writer
                    .write_all(&answer)
                    .and_then(|()| writer.write_all(b"\n"));
                let _ = writer.flush();
            }
            let _ = done.send(());
        });
        // Hängt die Gegenstelle, trennt die Brücke nach 2 s (beendet das blockierte Lesen).
        if finished.recv_timeout(Duration::from_secs(2)).is_err() {
            let _ = aegis_winffi::pipe::disconnect(conn);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speichern_mit_sicherung() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join(VAULT_FILE);
        save_file(&path, b"eins").unwrap();
        save_file(&path, b"zwei").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"zwei");
        assert_eq!(
            std::fs::read(path.with_extension("aegisvault.bak")).unwrap(),
            b"eins"
        );
        assert!(!path.with_extension("aegisvault.tmp").exists());
    }

    #[test]
    fn bruecke_gesperrt_und_ungueltig() {
        use aegis_vault_core::bridge::Response;
        state().open = None;
        assert_eq!(
            bridge_answer(br#"{"type":"status"}"#),
            Response::Status { unlocked: false }
        );
        assert_eq!(
            bridge_answer(br#"{"type":"fill","id":"x","origin":"https://bank.example"}"#),
            Response::Locked
        );
        assert_eq!(bridge_answer(b"kaputt"), Response::error("invalid"));
    }
}
