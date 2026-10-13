//! Automatische Datenbank-Backups und Wiederherstellung einer beschädigten Datenbank.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use tauri::State;

use crate::db::{Db, SCHEMA_VERSION};
use crate::error::{blocking, io_err, CmdResult};
use crate::models::LibraryBackup;
use crate::state::{Core, Shared};
use crate::util::{display_path, is_plain_name, mtime_ms, now_ms, parse_timestamp_name, timestamp_name};

/// So viele automatische Datenbank-Backups werden behalten.
pub const KEEP_DB_BACKUPS: usize = 10;
/// Abstand der automatischen Backups.
const AUTO_BACKUP_AGE_MS: i64 = 24 * 60 * 60 * 1000;

// =============================================================================================
// ZIP
// =============================================================================================

// =============================================================================================
// Spielstand-Backups
// =============================================================================================

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..1000)
        .map(|i| dir.join(format!("{stem}-{i}.{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

// =============================================================================================
// Datenbank-Backups
// =============================================================================================

fn db_backup_info(path: &Path) -> Option<LibraryBackup> {
    let meta = fs::metadata(path).ok()?;
    let file = path.file_name()?.to_string_lossy().to_string();
    let stamp = file.strip_prefix("pulsar-").unwrap_or(&file);
    Some(LibraryBackup {
        created_at: parse_timestamp_name(stamp).unwrap_or_else(|| mtime_ms(&meta)),
        file,
        path: display_path(path),
        size: meta.len(),
    })
}

fn is_db_backup_name(name: &str) -> bool {
    is_plain_name(name) && name.starts_with("pulsar-") && name.ends_with(".db")
}

/// Datenbank-Backups eines Ordners, neueste zuerst.
pub fn list_db_backups(dir: &Path) -> Vec<LibraryBackup> {
    let mut list: Vec<LibraryBackup> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| is_db_backup_name(&e.file_name().to_string_lossy()))
                .filter_map(|e| db_backup_info(&e.path()))
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.file.cmp(&a.file)));
    list
}

fn prune_db_backups(dir: &Path, keep: usize) {
    for old in list_db_backups(dir).into_iter().skip(keep) {
        let _ = fs::remove_file(&old.path);
    }
}

/// Sofort ein Backup der Datenbank anlegen (ältere über 10 werden gelöscht).
pub fn backup_db(db: &Db, dir: &Path) -> CmdResult<LibraryBackup> {
    fs::create_dir_all(dir).map_err(|e| io_err(&e, dir))?;
    let path = unique_path(dir, &format!("pulsar-{}", timestamp_name()), "db");
    db.backup_into(&path)?;
    prune_db_backups(dir, KEEP_DB_BACKUPS);
    db_backup_info(&path).ok_or_else(|| "Das Backup konnte nicht angelegt werden.".into())
}

/// Backup anlegen, wenn das neueste älter als 24 Stunden ist (oder keins existiert).
pub fn auto_backup_if_due(core: &Core) -> CmdResult<Option<LibraryBackup>> {
    let dir = core.paths.backups_dir(&core.active_profile_id());
    let newest = list_db_backups(&dir).first().map(|b| b.created_at);
    if newest.map(|t| now_ms() - t < AUTO_BACKUP_AGE_MS).unwrap_or(false) {
        return Ok(None);
    }
    core.db.with(|db| backup_db(db, &dir)).map(Some)
}

/// Automatisches Backup im Hintergrund (beim Start und nach einem Profilwechsel).
pub fn auto_backup_in_background(core: Arc<Core>) {
    let _ = std::thread::Builder::new()
        .name("pulsar-backup".into())
        .spawn(move || {
            // Start nicht verzögern
            std::thread::sleep(std::time::Duration::from_secs(5));
            if let Err(e) = auto_backup_if_due(&core) {
                eprintln!("Automatisches Backup fehlgeschlagen: {e}");
            }
        });
}

/// Läuft PULSAR länger am Stück (z. B. im Infobereich), stündlich prüfen, ob das tägliche Backup fällig ist.
pub fn auto_backup_daily(core: Arc<Core>) {
    let _ = std::thread::Builder::new()
        .name("pulsar-backup-daily".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60 * 60));
            if let Err(e) = auto_backup_if_due(&core) {
                eprintln!("Automatisches Backup fehlgeschlagen: {e}");
            }
        });
}

/// Prüft, ob eine Datei eine lesbare Pulsar-Datenbank ist.
fn check_backup_db(path: &Path) -> CmdResult<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    if version > SCHEMA_VERSION {
        return Err("Das Backup stammt aus einer neueren Pulsar-Version.".into());
    }
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('games','sessions','kv')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    if tables < 3 {
        return Err("Die Datei ist kein Pulsar-Backup.".into());
    }
    Ok(())
}

fn remove_wal_files(db_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut s = db_path.as_os_str().to_owned();
        s.push(suffix);
        let _ = fs::remove_file(PathBuf::from(s));
    }
}

fn copy_over(src: &Path, dest: &Path) -> CmdResult<()> {
    let tmp = dest.with_extension("db.restore");
    fs::copy(src, &tmp).map_err(|e| io_err(&e, src))?;
    remove_wal_files(dest);
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(&e, dest)
    })
}

/// Ist die Datei eindeutig beschädigt (kein Sperr- oder Rechteproblem)?
fn is_corrupt(path: &Path) -> bool {
    use rusqlite::ErrorCode;
    let corrupt_code = |e: &rusqlite::Error| {
        matches!(e, rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt))
    };
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Err(e) => corrupt_code(&e),
        Ok(c) => match c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)) {
            Ok(s) => s != "ok",
            Err(e) => corrupt_code(&e),
        },
    }
}

/// Marke in kv: Nach dem Wiederherstellen einer beschädigten Datenbank ließen sich die Sicherungen
/// von Windows-Änderungen nicht lesen – Pulsar weiß nicht sicher, ob alles zurückgestellt werden
/// kann. `--revert-all` endet dann mit 1, damit der Deinstaller die Daten (samt beschädigter Datei)
/// behält. Wert: `{ "at": ms, "file": Pfad der beiseitegelegten Datei }`.
pub const KV_RECOVERY_UNKNOWN: &str = "opt.recoveryUnknown";

/// Die von Pulsar verwalteten Schlüssel nur lesend aus einer (beschädigten) Datei holen.
/// `None` = nicht sicher lesbar.
fn read_managed_raw(path: &Path) -> Option<Vec<(&'static str, serde_json::Value)>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut out = Vec::new();
    for key in crate::library::MANAGED_KV_KEYS {
        let text: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .map(Some)
            .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(e) })
            .ok()?;
        let value = match text {
            Some(t) => serde_json::from_str(&t).ok()?,
            None => serde_json::Value::Null,
        };
        out.push((key, value));
    }
    Some(out)
}

/// Nach dem Wiederherstellen: Die Sicherungen von Windows-Änderungen auf den Stand der beschädigten
/// Datei bringen (auch „keine“) – ein Backup von gestern kennt neuere Änderungen nicht oder enthält
/// längst erledigte. Ließ sich der Stand nicht lesen, bleibt der Stand des Backups (meist richtig)
/// und die Marke [`KV_RECOVERY_UNKNOWN`] wird gesetzt.
fn carry_over_managed(db: &Db, managed: &Option<Vec<(&'static str, serde_json::Value)>>, aside: &Path) {
    let written = match managed {
        Some(values) => values.iter().try_for_each(|(key, value)| db.kv_set(key, value)),
        None => Err("Die Sicherungen der beschädigten Datenbank ließen sich nicht lesen.".into()),
    };
    if let Err(e) = written {
        eprintln!("{e}");
        let mark = serde_json::json!({ "at": now_ms(), "file": display_path(aside) });
        if let Err(e) = db.kv_set(KV_RECOVERY_UNKNOWN, &mark) {
            eprintln!("Die Marke für unsichere Sicherungen konnte nicht gesetzt werden: {e}");
        }
    }
}

/// Profil-Datenbank öffnen; ist sie beschädigt, wird sie beiseitegelegt und das neueste
/// gültige Backup verwendet (sonst eine leere Datenbank). Die Sicherungen von Windows-Änderungen
/// kommen dabei aus der beschädigten Datei (siehe [`carry_over_managed`]).
pub fn open_with_recovery(paths: &crate::state::Paths, profile: &str) -> CmdResult<Db> {
    let path = paths.db_path(profile);
    let err = match Db::open(&path) {
        Ok(db) => return Ok(db),
        Err(e) => e,
    };
    if !path.is_file() || !is_corrupt(&path) {
        return Err(err);
    }
    // Vor dem Beiseitelegen: den aktuellen Stand der Sicherungen retten (falls lesbar)
    let managed = read_managed_raw(&path);
    let aside = path.with_extension(format!("db.broken-{}", timestamp_name()));
    fs::rename(&path, &aside).map_err(|e| io_err(&e, &path))?;
    remove_wal_files(&path);
    eprintln!("Beschädigte Datenbank nach {} verschoben", aside.display());
    for b in list_db_backups(&paths.backups_dir(profile)) {
        let src = PathBuf::from(&b.path);
        if check_backup_db(&src).is_ok() && copy_over(&src, &path).is_ok() {
            if let Ok(db) = Db::open(&path) {
                carry_over_managed(&db, &managed, &aside);
                return Ok(db);
            }
        }
    }
    let db = Db::open(&path)?;
    carry_over_managed(&db, &managed, &aside);
    Ok(db)
}

/// Die aktuellen Werte der von Pulsar verwalteten Schlüssel (Sicherungen von Windows-Änderungen).
fn managed_values(db: &Db) -> CmdResult<Vec<(&'static str, serde_json::Value)>> {
    crate::library::MANAGED_KV_KEYS.iter().map(|k| Ok((*k, db.kv_get(k)?))).collect()
}

/// Datenbank aus einem Backup wiederherstellen (Verbindung wird sicher geschlossen und neu geöffnet).
/// Die Sicherungen von Windows-Änderungen (`net.dnsBackup`, `opt.snapshots`) bleiben dabei, wie sie
/// gerade sind.
pub fn restore_db(core: &Core, file: &str) -> CmdResult<()> {
    if !is_db_backup_name(file) {
        return Err("Ungültiger Backup-Name.".into());
    }
    let profile = core.active_profile_id();
    let dir = core.paths.backups_dir(&profile);
    let src = dir.join(file);
    if !src.is_file() {
        return Err("Das Backup wurde nicht gefunden.".into());
    }
    check_backup_db(&src)?;

    // Keine Windows-Änderung darf gleichzeitig laufen: sie liest und schreibt die Sicherungen
    let _change = crate::elevate::change_lock();
    core.tracker.finalize_all(core, false, true);
    let result = (|| -> CmdResult<()> {
        let mut guard = core.db.lock();
        // Ohne geöffnete Datenbank sind die aktuellen Sicherungen von Windows-Änderungen unbekannt
        // (und es gäbe keine Sicherheitskopie) – dann lieber nichts überschreiben.
        let Some(current) = guard.as_ref() else {
            return Err("Die aktuelle Datenbank ist nicht geöffnet – Wiederherstellen ist gerade nicht möglich.".into());
        };
        let db_path = current.path().to_path_buf();
        // Die Sicherungen von Windows-Änderungen beschreiben den aktuellen Zustand von Windows,
        // keine Nutzerdaten: Sie bleiben, wie sie jetzt sind (auch „keine“), damit Zurückstellen
        // weiter stimmt und keine veraltete Sicherung zurückkommt.
        let kept = managed_values(current)?;
        // Sicherheitskopie des aktuellen Stands
        let safety = backup_db(current, &dir)?;
        if let Some(db) = guard.take() {
            db.checkpoint();
            drop(db);
        }
        if let Err(e) = copy_over(&src, &db_path) {
            *guard = Db::open(&db_path).ok();
            return Err(e);
        }
        let reopened = Db::open(&db_path).and_then(|db| {
            for (key, value) in &kept {
                db.kv_set(key, value)?;
            }
            Ok(db)
        });
        match reopened {
            Ok(db) => {
                *guard = Some(db);
                Ok(())
            }
            Err(e) => {
                let _ = copy_over(Path::new(&safety.path), &db_path);
                *guard = Db::open(&db_path).ok();
                Err(format!("Das Backup konnte nicht geöffnet werden: {e}"))
            }
        }
    })();
    core.tracker.resume();
    result
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn backups_list(state: State<'_, Shared>) -> CmdResult<Vec<LibraryBackup>> {
    let core = state.inner().clone();
    blocking(move || Ok(list_db_backups(&core.paths.backups_dir(&core.active_profile_id())))).await
}

#[tauri::command]
pub async fn backup_now(state: State<'_, Shared>) -> CmdResult<LibraryBackup> {
    let core = state.inner().clone();
    blocking(move || {
        let dir = core.paths.backups_dir(&core.active_profile_id());
        core.db.with(|db| backup_db(db, &dir))
    })
    .await
}

#[tauri::command]
pub async fn backup_restore(state: State<'_, Shared>, file: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || restore_db(&core, file.trim())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_db_is_recovered_from_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        {
            let db = Db::open(&paths.db_path("p1")).unwrap();
            db.put("games", "g1", &serde_json::json!({"id": "g1"})).unwrap();
            backup_db(&db, &paths.backups_dir("p1")).unwrap();
        }
        fs::write(paths.db_path("p1"), vec![0x42u8; 8192]).unwrap();
        let db = open_with_recovery(&paths, "p1").unwrap();
        assert_eq!(db.list("games").unwrap().len(), 1, "Daten aus dem Backup");
        let broken = fs::read_dir(paths.profile_dir("p1"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".broken-"));
        assert!(broken, "kaputte Datei wird aufgehoben");
    }

    #[test]
    fn recovery_marks_unreadable_windows_backups() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        {
            let db = Db::open(&paths.db_path("p1")).unwrap();
            db.kv_set("opt.snapshots", &json!({ "gameMode": { "values": {}, "savedAt": 1 } })).unwrap();
            backup_db(&db, &paths.backups_dir("p1")).unwrap();
        }
        // Völlig unlesbar: Stand des Backups bleibt (meist richtig), dazu die Marke
        fs::write(paths.db_path("p1"), vec![0x42u8; 8192]).unwrap();
        let db = open_with_recovery(&paths, "p1").unwrap();
        assert!(!db.kv_get("opt.snapshots").unwrap().is_null());
        assert!(!db.kv_get(KV_RECOVERY_UNKNOWN).unwrap().is_null());
    }

    #[test]
    fn recovery_takes_windows_backups_from_the_broken_file_when_readable() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        let path = paths.db_path("p1");
        {
            // Backup von gestern: alte DNS-Sicherung, keine Optimierungs-Sicherung
            let db = Db::open(&path).unwrap();
            db.kv_set("net.dnsBackup", &json!({ "{alt}": { "adapter": "Alt" } })).unwrap();
            backup_db(&db, &paths.backups_dir("p1")).unwrap();
            // Heute: DNS zurückgestellt, neue Optimierungs-Sicherung
            db.kv_set("net.dnsBackup", &serde_json::Value::Null).unwrap();
            db.kv_set("opt.snapshots", &json!({ "gameMode": { "values": {}, "savedAt": 2 } })).unwrap();
            db.checkpoint();
        }
        let managed = read_managed_raw(&path).unwrap();
        let db = Db::open(&paths.db_path("p2")).unwrap();
        db.kv_set("net.dnsBackup", &json!({ "{alt}": { "adapter": "Alt" } })).unwrap();
        carry_over_managed(&db, &Some(managed), &path);
        assert!(db.kv_get("net.dnsBackup").unwrap().is_null(), "erledigte Sicherung kommt nicht zurück");
        assert_eq!(db.kv_get("opt.snapshots").unwrap()["gameMode"]["savedAt"], json!(2), "neue Sicherung bleibt");
        assert!(db.kv_get(KV_RECOVERY_UNKNOWN).unwrap().is_null(), "Stand bekannt → keine Marke");
    }

    #[test]
    fn restore_needs_an_open_database() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let dir = core.paths.backups_dir(&core.active_profile_id());
        let file = core.db.with(|db| backup_db(db, &dir)).unwrap().file;
        core.db.replace(None);
        assert!(restore_db(&core, &file).unwrap_err().contains("nicht geöffnet"));
    }

    #[test]
    fn restore_keeps_current_windows_backups() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let dir = core.paths.backups_dir(&core.active_profile_id());
        // Stand im Backup: alte DNS-Sicherung, keine Optimierungs-Sicherung, ein Spiel
        let file = core
            .db
            .with(|db| {
                db.put("games", "g1", &json!({ "id": "g1" }))?;
                db.kv_set("net.dnsBackup", &json!({ "{alt}": { "adapter": "Alt" } }))?;
                db.kv_set("settings", &json!({ "theme": "alt" }))?;
                backup_db(db, &dir)
            })
            .unwrap()
            .file;
        // Heute: neue Optimierungs-Sicherung, DNS-Sicherung ist weg, andere Einstellungen
        let snaps = json!({ "gameMode": { "values": { "AutoGameModeEnabled": null }, "savedAt": 2 } });
        core.db
            .with(|db| {
                db.delete("games", "g1")?;
                db.kv_set("net.dnsBackup", &serde_json::Value::Null)?;
                db.kv_set("opt.snapshots", &snaps)?;
                db.kv_set("settings", &json!({ "theme": "neu" }))
            })
            .unwrap();

        restore_db(&core, &file).unwrap();
        core.db
            .with(|db| {
                assert_eq!(db.list("games")?.len(), 1, "Nutzerdaten aus dem Backup");
                assert_eq!(db.kv_get("settings")?, json!({ "theme": "alt" }));
                assert_eq!(db.kv_get("net.dnsBackup")?, serde_json::Value::Null, "veraltete Sicherung kommt nicht zurück");
                assert_eq!(db.kv_get("opt.snapshots")?, snaps, "aktuelle Sicherung bleibt");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn newer_db_version_is_not_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        let path = paths.db_path("p1");
        drop(Db::open(&path).unwrap());
        Connection::open(&path).unwrap().execute_batch("PRAGMA user_version = 99").unwrap();
        let err = open_with_recovery(&paths, "p1").err().unwrap();
        assert!(err.contains("neueren"), "{err}");
        assert!(path.is_file());
    }

    #[test]
    fn db_backups_keep_ten() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("pulsar.db")).unwrap();
        let dir = tmp.path().join("backups");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..12 {
            fs::write(dir.join(format!("pulsar-2020010{}-0000{:02}.db", i % 9 + 1, i)), b"x").unwrap();
        }
        let b = backup_db(&db, &dir).unwrap();
        let list = list_db_backups(&dir);
        assert_eq!(list.len(), KEEP_DB_BACKUPS);
        assert_eq!(list[0].file, b.file, "neuestes zuerst");
        assert!(check_backup_db(Path::new(&b.path)).is_ok());
        assert!(check_backup_db(&dir.join(&list[1].file)).is_err(), "Müll-Datei ist kein Backup");
    }
}
