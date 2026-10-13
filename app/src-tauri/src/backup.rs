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

/// Profil-Datenbank öffnen; ist sie beschädigt, wird sie beiseitegelegt und das neueste
/// gültige Backup verwendet (sonst eine leere Datenbank).
pub fn open_with_recovery(paths: &crate::state::Paths, profile: &str) -> CmdResult<Db> {
    let path = paths.db_path(profile);
    let err = match Db::open(&path) {
        Ok(db) => return Ok(db),
        Err(e) => e,
    };
    if !path.is_file() || !is_corrupt(&path) {
        return Err(err);
    }
    let aside = path.with_extension(format!("db.broken-{}", timestamp_name()));
    fs::rename(&path, &aside).map_err(|e| io_err(&e, &path))?;
    remove_wal_files(&path);
    eprintln!("Beschädigte Datenbank nach {} verschoben", aside.display());
    for b in list_db_backups(&paths.backups_dir(profile)) {
        let src = PathBuf::from(&b.path);
        if check_backup_db(&src).is_ok() && copy_over(&src, &path).is_ok() {
            if let Ok(db) = Db::open(&path) {
                return Ok(db);
            }
        }
    }
    Db::open(&path)
}

/// Datenbank aus einem Backup wiederherstellen (Verbindung wird sicher geschlossen und neu geöffnet).
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

    core.tracker.finalize_all(core, false, true);
    let result = (|| -> CmdResult<()> {
        let mut guard = core.db.lock();
        let db_path = guard
            .as_ref()
            .map(|d| d.path().to_path_buf())
            .unwrap_or_else(|| core.paths.db_path(&profile));
        // Sicherheitskopie des aktuellen Stands
        let safety = match guard.as_ref() {
            Some(db) => Some(backup_db(db, &dir)?),
            None => None,
        };
        if let Some(db) = guard.take() {
            db.checkpoint();
            drop(db);
        }
        if let Err(e) = copy_over(&src, &db_path) {
            *guard = Db::open(&db_path).ok();
            return Err(e);
        }
        match Db::open(&db_path) {
            Ok(db) => {
                *guard = Some(db);
                Ok(())
            }
            Err(e) => {
                if let Some(s) = safety {
                    let _ = copy_over(Path::new(&s.path), &db_path);
                }
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
