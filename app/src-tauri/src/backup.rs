//! Spielstand-Backups (ZIP), Bibliothek exportieren/importieren und automatische DB-Backups.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{Db, SCHEMA_VERSION};
use crate::error::{blocking, io_err, CmdResult};
use crate::models::{ImportReport, LibraryBackup, SaveBackup};
use crate::state::{Core, Shared};
use crate::tracker::{is_specific_dir, normalize_path, DirContext};
use crate::util::{
    clean_path, display_path, is_plain_name, mtime_ms, now_ms, parse_timestamp_name, safe_segment,
    timestamp_name, write_atomic,
};

/// So viele automatische Datenbank-Backups werden behalten.
pub const KEEP_DB_BACKUPS: usize = 10;
/// Abstand der automatischen Backups.
const AUTO_BACKUP_AGE_MS: i64 = 24 * 60 * 60 * 1000;

fn zip_err(e: zip::result::ZipError) -> String {
    match e {
        zip::result::ZipError::Io(io) => format!("Fehler beim Lesen/Schreiben des Archivs: {io}"),
        zip::result::ZipError::InvalidArchive(_) | zip::result::ZipError::UnsupportedArchive(_) => {
            "Das Backup-Archiv ist beschädigt oder ungültig.".into()
        }
        other => format!("Archivfehler: {other}"),
    }
}

// =============================================================================================
// ZIP
// =============================================================================================

/// Ordner rekursiv in ein ZIP (Deflate) packen. Gibt die Anzahl der Dateien zurück.
pub fn zip_dir(src: &Path, dest: &Path) -> CmdResult<u64> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(&e, parent))?;
    }
    let tmp = dest.with_extension("zip.tmp");
    let result = (|| -> CmdResult<u64> {
        let file = File::create(&tmp).map_err(|e| io_err(&e, &tmp))?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let base = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut count = 0u64;
        for entry in walkdir::WalkDir::new(src).min_depth(1).follow_links(false).sort_by_file_name() {
            let entry = entry.map_err(|e| {
                let p = e.path().map(|p| p.to_path_buf()).unwrap_or_else(|| src.to_path_buf());
                match e.into_io_error() {
                    Some(io) => io_err(&io, &p),
                    None => format!("Fehler beim Lesen von {}", p.display()),
                }
            })?;
            let rel = entry
                .path()
                .strip_prefix(src)
                .map_err(|_| "Ungültiger Pfad im Spielstand-Ordner.".to_string())?;
            let name = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            if name.is_empty() {
                continue;
            }
            if entry.file_type().is_dir() {
                zip.add_directory(format!("{name}/"), base).map_err(zip_err)?;
            } else if entry.file_type().is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                zip.start_file(name, base.large_file(size >= 0xFFFF_0000))
                    .map_err(zip_err)?;
                let mut f = File::open(entry.path()).map_err(|e| io_err(&e, entry.path()))?;
                io::copy(&mut f, &mut zip).map_err(|e| io_err(&e, entry.path()))?;
                count += 1;
            }
        }
        zip.finish().map_err(zip_err)?;
        Ok(count)
    })();
    match result {
        Ok(n) => {
            fs::rename(&tmp, dest).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                io_err(&e, dest)
            })?;
            Ok(n)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Sicherer relativer Pfad für einen Archiv-Eintrag (`None` = gefährlich, z. B. `../`, `C:\`).
pub fn safe_entry_path(name: &str) -> Option<PathBuf> {
    if name.contains('\0') {
        return None;
    }
    let unified = name.replace('\\', "/");
    if unified.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in unified.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            p if p.contains(':') => return None,
            p => out.push(p),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Prüft alle Einträge eines Archivs, bevor irgendetwas verändert wird.
pub fn validate_zip(path: &Path) -> CmdResult<()> {
    let file = File::open(path).map_err(|e| io_err(&e, path))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(zip_err)?;
    for i in 0..archive.len() {
        let f = archive.by_index(i).map_err(zip_err)?;
        let name = f.name().to_string();
        let trivial = name.replace('\\', "/").trim_matches('/').is_empty();
        if !trivial && (f.enclosed_name().is_none() || safe_entry_path(&name).is_none()) {
            return Err(format!("Das Backup enthält einen unsicheren Pfad („{name}“) und wird nicht wiederhergestellt."));
        }
    }
    Ok(())
}

/// Archiv in einen Ordner entpacken (mit Schutz gegen „Zip Slip“).
pub fn unzip_into(zip_path: &Path, dest: &Path) -> CmdResult<u64> {
    let file = File::open(zip_path).map_err(|e| io_err(&e, zip_path))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(zip_err)?;
    fs::create_dir_all(dest).map_err(|e| io_err(&e, dest))?;
    let mut count = 0;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(zip_err)?;
        let name = f.name().to_string();
        let Some(rel) = safe_entry_path(&name) else {
            if name.replace('\\', "/").trim_matches('/').is_empty() {
                continue;
            }
            return Err(format!("Das Backup enthält einen unsicheren Pfad („{name}“)."));
        };
        if f.enclosed_name().is_none() {
            return Err(format!("Das Backup enthält einen unsicheren Pfad („{name}“)."));
        }
        let out = dest.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| io_err(&e, &out))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err(&e, parent))?;
        }
        let mut w = File::create(&out).map_err(|e| io_err(&e, &out))?;
        io::copy(&mut f, &mut w).map_err(|e| io_err(&e, &out))?;
        count += 1;
    }
    Ok(count)
}

fn has_content(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut rd| rd.next().is_some()).unwrap_or(false)
}

/// Inhalt eines Ordners löschen (der Ordner selbst bleibt).
fn empty_dir(dir: &Path) -> CmdResult<()> {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(&e, dir)),
    };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let res = if is_dir { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        res.map_err(|err| io_err(&err, &p))?;
    }
    Ok(())
}

/// Darf dieser Ordner beim Wiederherstellen geleert werden? (kein Laufwerk, kein Benutzer-/Systemordner)
pub fn is_safe_restore_dir(dir: &Path) -> bool {
    is_specific_dir(&normalize_path(&dir.to_string_lossy()), &DirContext::current())
}

/// Spielstand aus einem Archiv wiederherstellen: prüfen → aktuellen Stand sichern → leeren → entpacken.
/// Schlägt das Entpacken fehl, wird der vorherige Stand zurückgespielt.
pub fn restore_save(zip_path: &Path, folder: &Path, safety_dest: &Path) -> CmdResult<()> {
    validate_zip(zip_path)?;
    fs::create_dir_all(folder).map_err(|e| io_err(&e, folder))?;
    let safety = if has_content(folder) {
        zip_dir(folder, safety_dest)?;
        Some(safety_dest.to_path_buf())
    } else {
        None
    };
    let result = empty_dir(folder).and_then(|_| unzip_into(zip_path, folder).map(|_| ()));
    if let Err(e) = result {
        if let Some(s) = &safety {
            let _ = empty_dir(folder);
            let _ = unzip_into(s, folder);
        }
        return Err(format!("{e} Der vorherige Spielstand wurde wiederhergestellt."));
    }
    Ok(())
}

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

fn save_info(game_id: &str, path: &Path) -> Option<SaveBackup> {
    let meta = fs::metadata(path).ok()?;
    let id = path.file_stem()?.to_string_lossy().to_string();
    Some(SaveBackup {
        created_at: parse_timestamp_name(&id).unwrap_or_else(|| mtime_ms(&meta)),
        id,
        game_id: game_id.to_string(),
        path: display_path(path),
        size: meta.len(),
    })
}

/// Alle Spielstand-Backups eines Spiels, neueste zuerst.
pub fn list_saves(dir: &Path, game_id: &str) -> Vec<SaveBackup> {
    let mut list: Vec<SaveBackup> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("zip")).unwrap_or(false))
                .filter_map(|p| save_info(game_id, &p))
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    list
}

fn game_saves_dir(core: &Core, game_id: &str) -> CmdResult<PathBuf> {
    if game_id.trim().is_empty() {
        return Err("Ungültige Spiel-ID.".into());
    }
    Ok(core
        .paths
        .savegames_dir(&core.active_profile_id())
        .join(safe_segment(game_id)))
}

fn backup_file(dir: &Path, backup_id: &str) -> CmdResult<PathBuf> {
    if !is_plain_name(backup_id) {
        return Err("Ungültige Backup-ID.".into());
    }
    let p = dir.join(format!("{backup_id}.zip"));
    if !p.is_file() {
        return Err("Das Backup wurde nicht gefunden.".into());
    }
    Ok(p)
}

fn existing_dir(folder: &str) -> CmdResult<PathBuf> {
    let p = clean_path(folder);
    if folder.trim().is_empty() {
        return Err("Es wurde kein Spielstand-Ordner festgelegt.".into());
    }
    if !p.is_dir() {
        return Err(format!("Der Ordner wurde nicht gefunden: {}", p.display()));
    }
    Ok(p)
}

// =============================================================================================
// Datenbank-Backups
// =============================================================================================

fn db_backup_info(path: &Path) -> Option<LibraryBackup> {
    let meta = fs::metadata(path).ok()?;
    let file = path.file_name()?.to_string_lossy().to_string();
    let stamp = file.strip_prefix("nova-").unwrap_or(&file);
    Some(LibraryBackup {
        created_at: parse_timestamp_name(stamp).unwrap_or_else(|| mtime_ms(&meta)),
        file,
        path: display_path(path),
        size: meta.len(),
    })
}

fn is_db_backup_name(name: &str) -> bool {
    is_plain_name(name) && name.starts_with("nova-") && name.ends_with(".db")
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
    let path = unique_path(dir, &format!("nova-{}", timestamp_name()), "db");
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
        .name("nova-backup".into())
        .spawn(move || {
            // Start nicht verzögern
            std::thread::sleep(std::time::Duration::from_secs(5));
            if let Err(e) = auto_backup_if_due(&core) {
                eprintln!("Automatisches Backup fehlgeschlagen: {e}");
            }
        });
}

/// Läuft NOVA länger am Stück (z. B. im Infobereich), stündlich prüfen, ob das tägliche Backup fällig ist.
pub fn auto_backup_daily(core: Arc<Core>) {
    let _ = std::thread::Builder::new()
        .name("nova-backup-daily".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60 * 60));
            if let Err(e) = auto_backup_if_due(&core) {
                eprintln!("Automatisches Backup fehlgeschlagen: {e}");
            }
        });
}

/// Prüft, ob eine Datei eine lesbare Nova-Datenbank ist.
fn check_backup_db(path: &Path) -> CmdResult<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    if version > SCHEMA_VERSION {
        return Err("Das Backup stammt aus einer neueren Nova-Version.".into());
    }
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('games','sessions','kv')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Das Backup ist beschädigt.".to_string())?;
    if tables < 3 {
        return Err("Die Datei ist kein Nova-Backup.".into());
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
pub async fn save_backup_create(state: State<'_, Shared>, game_id: String, folder: String) -> CmdResult<SaveBackup> {
    let core = state.inner().clone();
    blocking(move || {
        let src = existing_dir(&folder)?;
        if !has_content(&src) {
            return Err("Der Spielstand-Ordner ist leer – es gibt nichts zu sichern.".into());
        }
        let dir = game_saves_dir(&core, &game_id)?;
        fs::create_dir_all(&dir).map_err(|e| io_err(&e, &dir))?;
        let dest = unique_path(&dir, &timestamp_name(), "zip");
        zip_dir(&src, &dest)?;
        save_info(&game_id, &dest).ok_or_else(|| "Das Backup konnte nicht angelegt werden.".into())
    })
    .await
}

#[tauri::command]
pub async fn save_backup_list(state: State<'_, Shared>, game_id: String) -> CmdResult<Vec<SaveBackup>> {
    let core = state.inner().clone();
    blocking(move || {
        let dir = game_saves_dir(&core, &game_id)?;
        Ok(list_saves(&dir, &game_id))
    })
    .await
}

#[tauri::command]
pub async fn save_backup_restore(
    state: State<'_, Shared>,
    game_id: String,
    backup_id: String,
    folder: String,
) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || {
        let dir = game_saves_dir(&core, &game_id)?;
        let zip_path = backup_file(&dir, &backup_id)?;
        let target = clean_path(&folder);
        if folder.trim().is_empty() {
            return Err("Es wurde kein Spielstand-Ordner festgelegt.".into());
        }
        if !is_safe_restore_dir(&target) {
            return Err("Dieser Ordner ist zu allgemein für eine Wiederherstellung (z. B. ein Laufwerk oder der Benutzerordner). Bitte wähle den genauen Spielstand-Ordner.".into());
        }
        let safety = unique_path(&dir, &format!("{}-auto", timestamp_name()), "zip");
        restore_save(&zip_path, &target, &safety)
    })
    .await
}

#[tauri::command]
pub async fn save_backup_delete(state: State<'_, Shared>, game_id: String, backup_id: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || {
        let dir = game_saves_dir(&core, &game_id)?;
        let p = backup_file(&dir, &backup_id)?;
        fs::remove_file(&p).map_err(|e| io_err(&e, &p))
    })
    .await
}

#[tauri::command]
pub async fn library_export(state: State<'_, Shared>, path: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || {
        let dest = clean_path(&path);
        if path.trim().is_empty() {
            return Err("Bitte wähle einen Speicherort.".into());
        }
        if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("Der Ordner wurde nicht gefunden: {}", parent.display()));
            }
        }
        let data = core.db.with(|db| db.export_library())?;
        let json = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
        write_atomic(&dest, &json)
    })
    .await
}

#[tauri::command]
pub async fn library_import(state: State<'_, Shared>, path: String, mode: String) -> CmdResult<ImportReport> {
    let replace = match mode.trim() {
        "merge" => false,
        "replace" => true,
        _ => return Err("Ungültiger Import-Modus (erwartet: merge oder replace).".into()),
    };
    let core = state.inner().clone();
    blocking(move || {
        let src = clean_path(&path);
        let meta = fs::metadata(&src).map_err(|e| io_err(&e, &src))?;
        if meta.len() > 512 * 1024 * 1024 {
            return Err("Die Datei ist zu groß.".into());
        }
        let text = fs::read(&src).map_err(|e| io_err(&e, &src))?;
        let data: serde_json::Value = serde_json::from_slice(&text)
            .map_err(|_| "Die Datei ist keine gültige Nova-Bibliotheksdatei (JSON fehlerhaft).".to_string())?;
        let dir = core.paths.backups_dir(&core.active_profile_id());
        core.db.with(|db| {
            // Vor dem Import sichern, damit nichts verloren gehen kann
            backup_db(db, &dir)?;
            db.import_library(&data, replace)
        })
    })
    .await
}

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
    use std::io::Write;

    fn write(p: &Path, content: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn zip_roundtrip_and_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("Users").join("max").join("Saved Games").join("Hades");
        write(&saves.join("slot1.sav"), "eins");
        write(&saves.join("profiles").join("p.json"), "{}");
        fs::create_dir_all(saves.join("leer")).unwrap();
        let zip = tmp.path().join("backups").join("20240101-120000.zip");
        assert_eq!(zip_dir(&saves, &zip).unwrap(), 2);

        // Spielstand ändern, dann wiederherstellen
        write(&saves.join("slot1.sav"), "kaputt");
        write(&saves.join("neu.sav"), "neu");
        let safety = tmp.path().join("backups").join("20240101-130000-auto.zip");
        restore_save(&zip, &saves, &safety).unwrap();
        assert_eq!(fs::read_to_string(saves.join("slot1.sav")).unwrap(), "eins");
        assert_eq!(fs::read_to_string(saves.join("profiles").join("p.json")).unwrap(), "{}");
        assert!(saves.join("leer").is_dir());
        assert!(!saves.join("neu.sav").exists(), "Ordner wird vorher geleert");
        // Sicherheitskopie enthält den Stand vor der Wiederherstellung
        let check = tmp.path().join("check");
        unzip_into(&safety, &check).unwrap();
        assert_eq!(fs::read_to_string(check.join("neu.sav")).unwrap(), "neu");

        let list = list_saves(&tmp.path().join("backups"), "g1");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "20240101-130000-auto");
        assert!(list[0].created_at > list[1].created_at);
    }

    #[test]
    fn zip_slip_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let evil = tmp.path().join("evil.zip");
        {
            let mut z = ZipWriter::new(File::create(&evil).unwrap());
            let o = SimpleFileOptions::default();
            z.start_file("ok.txt", o).unwrap();
            z.write_all(b"ok").unwrap();
            z.start_file("../../outside.txt", o).unwrap();
            z.write_all(b"boese").unwrap();
            z.finish().unwrap();
        }
        let target = tmp.path().join("a").join("b").join("saves");
        write(&target.join("wichtig.sav"), "bleibt");
        let safety = tmp.path().join("safety.zip");
        let err = restore_save(&evil, &target, &safety).unwrap_err();
        assert!(err.contains("unsicheren Pfad"), "{err}");
        assert_eq!(fs::read_to_string(target.join("wichtig.sav")).unwrap(), "bleibt", "nichts verändert");
        assert!(!tmp.path().join("a").join("outside.txt").exists());
        assert!(!safety.exists());
        assert!(unzip_into(&evil, &tmp.path().join("x")).is_err());
    }

    #[test]
    fn entry_path_sanitizer() {
        assert_eq!(safe_entry_path("a/b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(safe_entry_path("./a//b"), Some(PathBuf::from("a").join("b")));
        assert_eq!(safe_entry_path("../x"), None);
        assert_eq!(safe_entry_path("a\\..\\..\\x"), None);
        assert_eq!(safe_entry_path("/etc/passwd"), None);
        assert_eq!(safe_entry_path("C:\\Windows\\x"), None);
        assert_eq!(safe_entry_path(""), None);
    }

    #[test]
    fn unsafe_restore_dirs() {
        assert!(!is_safe_restore_dir(Path::new("/")));
        assert!(!is_safe_restore_dir(Path::new("/home")));
        if let Some(h) = crate::util::home_dir() {
            assert!(!is_safe_restore_dir(&h));
            assert!(is_safe_restore_dir(&h.join("Saved Games").join("Hades")));
        }
    }

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
        let db = Db::open(&tmp.path().join("nova.db")).unwrap();
        let dir = tmp.path().join("backups");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..12 {
            fs::write(dir.join(format!("nova-2020010{}-0000{:02}.db", i % 9 + 1, i)), b"x").unwrap();
        }
        let b = backup_db(&db, &dir).unwrap();
        let list = list_db_backups(&dir);
        assert_eq!(list.len(), KEEP_DB_BACKUPS);
        assert_eq!(list[0].file, b.file, "neuestes zuerst");
        assert!(check_backup_db(Path::new(&b.path)).is_ok());
        assert!(check_backup_db(&dir.join(&list[1].file)).is_err(), "Müll-Datei ist kein Backup");
    }
}
