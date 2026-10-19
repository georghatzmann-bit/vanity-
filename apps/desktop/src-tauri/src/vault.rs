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
//! - **Speichern:** erst in eine Hilfsdatei, dann ersetzen; die vorige Fassung bleibt als `.bak`.

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
}

static STATE: LazyLock<Mutex<Inner>> = LazyLock::new(|| {
    Mutex::new(Inner {
        open: None,
        last_activity: Instant::now(),
        lock_minutes: DEFAULT_LOCK_MINUTES,
        failures: 0,
        retry_after: None,
        clipboard: None,
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
                    s.open = None;
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

#[cfg(windows)]
fn clear_clipboard(sequence: u32) {
    let _ = aegis_winffi::clipboard::clear_if_unchanged(sequence);
}

#[cfg(not(windows))]
fn clear_clipboard(_sequence: u32) {}

/// Schreibt die Tresordatei: Hilfsdatei, dann ersetzen; vorher die alte als `.bak`.
fn save_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    if path.exists() {
        // Sicherung der vorigen Fassung (eigene Datei, wird beim nächsten Speichern ersetzt).
        // aegis-mutation: desktop-vault-backup
        #[allow(clippy::disallowed_methods)]
        let _ = std::fs::copy(path, &bak);
    }
    // Ersetzt die eigene Tresordatei durch die eben geschriebene Fassung.
    // aegis-mutation: desktop-vault-replace
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(&tmp, path).map_err(|e| format!("Speichern nicht möglich: {e}"))
}

fn save(s: &Inner) -> Result<(), String> {
    let (vault, path) = s.open.as_ref().ok_or(LOCKED)?;
    let bytes = vault.to_bytes().map_err(|e| e.to_string())?;
    save_file(path, &bytes)
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
    if path.exists() {
        return Err("Es gibt bereits einen Tresor.".into());
    }
    let vault = tauri::async_runtime::spawn_blocking(move || {
        Vault::create(&master, KdfParams::DEFAULT).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let bytes = vault.to_bytes().map_err(|e| e.to_string())?;
    save_file(&path, &bytes)?;
    let mut s = state();
    s.open = Some((vault, path));
    s.last_activity = Instant::now();
    drop(s);
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
    {
        let s = state();
        if s.retry_after.is_some_and(|t| t > Instant::now()) {
            return Err("wait".into());
        }
    }
    // Lesen nur der eigenen Tresordatei (höchstens 64 MiB).
    let bytes = std::fs::read(&path).map_err(|_| "Kein Tresor gefunden.".to_owned())?;
    let result = tauri::async_runtime::spawn_blocking(move || Vault::open(&bytes, &master))
        .await
        .map_err(|e| e.to_string())?;
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
    state().open = None;
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
            save(s)
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
}
