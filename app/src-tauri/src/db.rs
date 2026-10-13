//! SQLite-Datenbank pro Profil: Bibliothek (JSON-Objekte), Schlüssel/Wert-Speicher und Spielsitzungen.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::error::{db_err, io_err, CmdResult, LockExt};
use crate::models::{ImportReport, PlayStats, Session};
use crate::util::now_ms;

/// Aktuelle Schema-Version (`PRAGMA user_version`).
pub const SCHEMA_VERSION: i64 = 1;

/// Kennung und Version des Export-Formats.
pub const EXPORT_FORMAT: &str = "nova-library";
pub const EXPORT_VERSION: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wishlist (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  seconds INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start);
"#;

/// Erlaubte Tabellennamen für die generischen Befehle (schützt vor SQL-Injection).
pub fn table_name(t: &str) -> CmdResult<&'static str> {
    match t.trim() {
        "games" => Ok("games"),
        "collections" => Ok("collections"),
        "wishlist" => Ok("wishlist"),
        other => Err(format!("Unbekannte Tabelle: „{other}“")),
    }
}

/// Prüft, dass `value` ein Objekt mit Text-`id` ist, und liefert das JSON.
pub fn validate_item(id: &str, value: &Value) -> CmdResult<String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 256 {
        return Err("Ungültige ID.".into());
    }
    let obj = value
        .as_object()
        .ok_or_else(|| "Ungültige Daten: Es wird ein Objekt erwartet.".to_string())?;
    match obj.get("id") {
        Some(Value::String(s)) if !s.trim().is_empty() => {}
        _ => return Err("Ungültige Daten: Das Objekt braucht eine Text-„id“.".into()),
    }
    serde_json::to_string(value).map_err(|e| format!("Ungültige Daten: {e}"))
}

fn row_to_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        game_id: r.get(1)?,
        start: r.get(2)?,
        end: r.get(3)?,
        seconds: r.get(4)?,
    })
}

/// Eine geöffnete Profil-Datenbank.
pub struct Db {
    conn: Connection,
    path: PathBuf,
}

impl Db {
    /// Öffnet (oder erstellt) die Datenbank, aktiviert WAL und führt Migrationen aus.
    pub fn open(path: &Path) -> CmdResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(&e, parent))?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(db_err)?;
        // journal_mode liefert eine Zeile zurück → query_row statt execute
        let _: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .map_err(db_err)?;
        conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
            .map_err(db_err)?;
        let mut db = Db {
            conn,
            path: path.to_path_buf(),
        };
        db.migrate()?;
        db.cleanup_empty_sessions()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&mut self) -> CmdResult<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db_err)?;
        if version > SCHEMA_VERSION {
            return Err(
                "Die Datenbank stammt aus einer neueren Nova-Version. Bitte aktualisiere Nova.".into(),
            );
        }
        if version < 1 {
            let tx = self.conn.transaction().map_err(db_err)?;
            tx.execute_batch(SCHEMA_V1).map_err(db_err)?;
            tx.execute_batch("PRAGMA user_version = 1").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        // Zukünftige Migrationen: if version < 2 { … }
        Ok(())
    }

    /// Entfernt Sitzungs-Reste ohne Dauer (z. B. nach einem Absturz innerhalb der ersten Minute).
    fn cleanup_empty_sessions(&self) -> CmdResult<()> {
        self.conn
            .execute("DELETE FROM sessions WHERE seconds <= 0", [])
            .map_err(db_err)?;
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Generische Tabellen
    // -----------------------------------------------------------------------------------------

    pub fn list(&self, table: &str) -> CmdResult<Vec<Value>> {
        let t = table_name(table)?;
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT data FROM {t} ORDER BY rowid"))
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let text = row.map_err(db_err)?;
            // Beschädigte Zeilen überspringen statt die ganze Bibliothek zu verlieren
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if v.is_object() {
                    out.push(v);
                }
            }
        }
        Ok(out)
    }

    pub fn put(&self, table: &str, id: &str, value: &Value) -> CmdResult<()> {
        let t = table_name(table)?;
        let json = validate_item(id, value)?;
        self.conn
            .execute(
                &format!(
                    "INSERT INTO {t}(id, data, updated_at) VALUES(?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
                ),
                params![id.trim(), json, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn put_many(&mut self, table: &str, items: &[(String, Value)]) -> CmdResult<()> {
        let t = table_name(table)?;
        // Erst alles prüfen, dann in einer Transaktion schreiben
        let mut prepared = Vec::with_capacity(items.len());
        for (id, value) in items {
            prepared.push((id.trim().to_string(), validate_item(id, value)?));
        }
        let now = now_ms();
        let tx = self.conn.transaction().map_err(db_err)?;
        {
            let mut stmt = tx
                .prepare(&format!(
                    "INSERT INTO {t}(id, data, updated_at) VALUES(?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
                ))
                .map_err(db_err)?;
            for (id, json) in &prepared {
                stmt.execute(params![id, json, now]).map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)
    }

    pub fn delete(&mut self, table: &str, id: &str) -> CmdResult<()> {
        let t = table_name(table)?;
        let tx = self.conn.transaction().map_err(db_err)?;
        tx.execute(&format!("DELETE FROM {t} WHERE id = ?1"), params![id])
            .map_err(db_err)?;
        if t == "games" {
            tx.execute("DELETE FROM sessions WHERE game_id = ?1", params![id])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    // -----------------------------------------------------------------------------------------
    // Schlüssel/Wert
    // -----------------------------------------------------------------------------------------

    pub fn kv_get(&self, key: &str) -> CmdResult<Value> {
        let text: Option<String> = self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        Ok(text
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null))
    }

    pub fn kv_set(&self, key: &str, value: &Value) -> CmdResult<()> {
        if key.trim().is_empty() {
            return Err("Ungültiger Schlüssel.".into());
        }
        if value.is_null() {
            self.conn
                .execute("DELETE FROM kv WHERE key = ?1", params![key])
                .map_err(db_err)?;
            return Ok(());
        }
        let json = serde_json::to_string(value).map_err(|e| format!("Ungültige Daten: {e}"))?;
        self.conn
            .execute(
                "INSERT INTO kv(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, json],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Sitzungen
    // -----------------------------------------------------------------------------------------

    pub fn session_insert(&self, game_id: &str, start: i64, end: i64, seconds: i64) -> CmdResult<Session> {
        self.conn
            .execute(
                "INSERT INTO sessions(game_id, start, end, seconds) VALUES(?1, ?2, ?3, ?4)",
                params![game_id, start, end, seconds],
            )
            .map_err(db_err)?;
        Ok(Session {
            id: self.conn.last_insert_rowid(),
            game_id: game_id.to_string(),
            start,
            end,
            seconds,
        })
    }

    /// Aktualisiert Ende/Dauer. Liefert `false`, wenn die Sitzung nicht (mehr) existiert.
    pub fn session_update(&self, id: i64, end: i64, seconds: i64) -> CmdResult<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE sessions SET end = ?2, seconds = ?3 WHERE id = ?1",
                params![id, end, seconds],
            )
            .map_err(db_err)?;
        Ok(n > 0)
    }

    pub fn session_delete(&self, id: i64) -> CmdResult<()> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(db_err)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn session_get(&self, id: i64) -> CmdResult<Option<Session>> {
        self.conn
            .query_row(
                "SELECT id, game_id, start, end, seconds FROM sessions WHERE id = ?1",
                params![id],
                row_to_session,
            )
            .optional()
            .map_err(db_err)
    }

    /// Sitzungen, die im Bereich `[from, to)` beginnen (älteste zuerst).
    pub fn sessions_range(&self, from: i64, to: i64) -> CmdResult<Vec<Session>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, game_id, start, end, seconds FROM sessions
                 WHERE start >= ?1 AND start < ?2 ORDER BY start ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![from, to], row_to_session)
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// Sitzungen eines Spiels, neueste zuerst.
    pub fn sessions_for_game(&self, game_id: &str, limit: i64) -> CmdResult<Vec<Session>> {
        let limit = if limit <= 0 { 100 } else { limit.min(100_000) };
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, game_id, start, end, seconds FROM sessions
                 WHERE game_id = ?1 ORDER BY start DESC, id DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![game_id, limit], row_to_session)
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    pub fn sessions_all(&self) -> CmdResult<Vec<Session>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, game_id, start, end, seconds FROM sessions ORDER BY start ASC, id ASC")
            .map_err(db_err)?;
        let rows = stmt.query_map([], row_to_session).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// Eine Zeile pro Spiel mit Sitzungen.
    pub fn playtime_stats(&self) -> CmdResult<Vec<PlayStats>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.game_id, SUM(s.seconds), COUNT(*), MAX(s.end), MIN(s.start),
                   (SELECT s2.seconds FROM sessions s2 WHERE s2.game_id = s.game_id
                    ORDER BY s2.start DESC, s2.id DESC LIMIT 1)
                 FROM sessions s GROUP BY s.game_id ORDER BY s.game_id",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PlayStats {
                    game_id: r.get(0)?,
                    total_seconds: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    sessions: r.get(2)?,
                    last_played_at: r.get(3)?,
                    first_played_at: r.get(4)?,
                    last_session_seconds: r.get(5)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    // -----------------------------------------------------------------------------------------
    // Export / Import
    // -----------------------------------------------------------------------------------------

    /// Alles als ein JSON-Dokument (Format `nova-library`, Version 1).
    pub fn export_library(&self) -> CmdResult<Value> {
        let mut kv = Map::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT key, value FROM kv ORDER BY key")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(db_err)?;
            for row in rows {
                let (k, v) = row.map_err(db_err)?;
                kv.insert(k, serde_json::from_str(&v).unwrap_or(Value::String(v)));
            }
        }
        let sessions = serde_json::to_value(self.sessions_all()?).unwrap_or(Value::Array(vec![]));
        Ok(serde_json::json!({
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "exportedAt": now_ms(),
            "games": self.list("games")?,
            "collections": self.list("collections")?,
            "wishlist": self.list("wishlist")?,
            "sessions": sessions,
            "kv": Value::Object(kv),
        }))
    }

    /// Importiert ein Export-Dokument. `replace = true` ersetzt alles, sonst wird zusammengeführt.
    pub fn import_library(&mut self, data: &Value, replace: bool) -> CmdResult<ImportReport> {
        let obj = data
            .as_object()
            .ok_or_else(|| "Keine gültige Nova-Bibliotheksdatei.".to_string())?;
        if obj.get("format").and_then(|f| f.as_str()) != Some(EXPORT_FORMAT) {
            return Err("Keine gültige Nova-Bibliotheksdatei.".into());
        }
        let version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
        if version > EXPORT_VERSION {
            return Err("Diese Datei stammt aus einer neueren Nova-Version.".into());
        }
        if version < 1 {
            return Err("Keine gültige Nova-Bibliotheksdatei (Version fehlt).".into());
        }

        fn items(obj: &Map<String, Value>, key: &str) -> Vec<(String, String)> {
            obj.get(key)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            let id = v.get("id")?.as_str()?.trim().to_string();
                            validate_item(&id, v).ok().map(|json| (id, json))
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        let games = items(obj, "games");
        let collections = items(obj, "collections");
        let wishlist = items(obj, "wishlist");
        let sessions: Vec<(String, i64, i64, i64)> = obj
            .get("sessions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| {
                        let gid = s
                            .get("gameId")
                            .or_else(|| s.get("game_id"))?
                            .as_str()?
                            .to_string();
                        let start = s.get("start")?.as_f64()? as i64;
                        let end = s.get("end").and_then(|e| e.as_f64()).map(|e| e as i64).unwrap_or(start);
                        let seconds = s.get("seconds")?.as_f64()? as i64;
                        if gid.is_empty() || seconds <= 0 {
                            return None;
                        }
                        Some((gid, start, end.max(start), seconds))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let kv: Vec<(String, String)> = obj
            .get("kv")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter(|(k, v)| !k.trim().is_empty() && !v.is_null())
                    .filter_map(|(k, v)| serde_json::to_string(v).ok().map(|j| (k.clone(), j)))
                    .collect()
            })
            .unwrap_or_default();

        let now = now_ms();
        let mut report = ImportReport::default();
        let tx = self.conn.transaction().map_err(db_err)?;
        if replace {
            tx.execute_batch(
                "DELETE FROM games; DELETE FROM collections; DELETE FROM wishlist;
                 DELETE FROM sessions; DELETE FROM kv;",
            )
            .map_err(db_err)?;
        }
        for (table, list, counter) in [
            ("games", &games, &mut report.games),
            ("collections", &collections, &mut report.collections),
            ("wishlist", &wishlist, &mut report.wishlist),
        ] {
            let mut stmt = tx
                .prepare(&format!(
                    "INSERT INTO {table}(id, data, updated_at) VALUES(?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
                ))
                .map_err(db_err)?;
            for (id, json) in list.iter() {
                stmt.execute(params![id, json, now]).map_err(db_err)?;
                *counter += 1;
            }
        }
        {
            let mut exists = tx
                .prepare("SELECT 1 FROM sessions WHERE game_id = ?1 AND start = ?2 LIMIT 1")
                .map_err(db_err)?;
            let mut insert = tx
                .prepare("INSERT INTO sessions(game_id, start, end, seconds) VALUES(?1, ?2, ?3, ?4)")
                .map_err(db_err)?;
            for (gid, start, end, seconds) in &sessions {
                let dup = exists
                    .query_row(params![gid, start], |_| Ok(()))
                    .optional()
                    .map_err(db_err)?
                    .is_some();
                if dup {
                    continue;
                }
                insert
                    .execute(params![gid, start, end, seconds])
                    .map_err(db_err)?;
                report.sessions += 1;
            }
        }
        {
            // Beim Zusammenführen vorhandene Einstellungen nicht überschreiben
            let sql = if replace {
                "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            } else {
                "INSERT OR IGNORE INTO kv(key, value) VALUES(?1, ?2)"
            };
            let mut stmt = tx.prepare(sql).map_err(db_err)?;
            for (k, v) in &kv {
                stmt.execute(params![k, v]).map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(report)
    }

    // -----------------------------------------------------------------------------------------
    // Backups
    // -----------------------------------------------------------------------------------------

    /// Konsistente Kopie der Datenbank in eine neue Datei schreiben (`VACUUM INTO`).
    pub fn backup_into(&self, dest: &Path) -> CmdResult<()> {
        if dest.exists() {
            return Err(format!("Die Datei existiert bereits: {}", dest.display()));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(&e, parent))?;
        }
        let target = dest.to_string_lossy().to_string();
        self.conn
            .execute("VACUUM INTO ?1", params![target])
            .map_err(db_err)?;
        Ok(())
    }

    /// WAL-Inhalt in die Hauptdatei schreiben (vor dem Schließen/Ersetzen).
    pub fn checkpoint(&self) {
        let _ = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}

/// Gemeinsamer Zugriff auf die aktive Datenbank (wird beim Profilwechsel ausgetauscht).
#[derive(Default)]
pub struct DbHandle {
    inner: Mutex<Option<Db>>,
}

impl DbHandle {
    pub fn new() -> Self {
        Self::default()
    }

    /// Führt `f` mit der geöffneten Datenbank aus.
    pub fn with<T>(&self, f: impl FnOnce(&mut Db) -> CmdResult<T>) -> CmdResult<T> {
        let mut guard = self.inner.lock_safe();
        match guard.as_mut() {
            Some(db) => f(db),
            None => Err("Die Datenbank ist nicht geöffnet. Bitte Nova neu starten.".into()),
        }
    }

    /// Ersetzt die Verbindung (alte wird sauber geschlossen) und gibt die alte zurück.
    pub fn replace(&self, db: Option<Db>) -> Option<Db> {
        let mut guard = self.inner.lock_safe();
        if let Some(old) = guard.as_ref() {
            old.checkpoint();
        }
        std::mem::replace(&mut *guard, db)
    }

    /// Direkter Zugriff auf den Mutex (z. B. um während einer Wiederherstellung zu sperren).
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Option<Db>> {
        self.inner.lock_safe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("p").join("nova.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn schema_version_and_wal() {
        let (_d, db) = temp_db();
        let v: i64 = db.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        let mode: String = db.conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn crud_roundtrip() {
        let (_d, mut db) = temp_db();
        let g1 = json!({"id": "g1", "name": "Alpha"});
        let g2 = json!({"id": "g2", "name": "Beta"});
        db.put("games", "g1", &g1).unwrap();
        db.put_many("games", &[("g2".into(), g2.clone()), ("g1".into(), json!({"id":"g1","name":"Alpha 2"}))])
            .unwrap();
        let list = db.list("games").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["name"], "Alpha 2");
        assert!(db.put("games", "x", &json!([1, 2])).is_err());
        assert!(db.put("games", "x", &json!({"name": "ohne id"})).is_err());
        assert!(db.put("evil; DROP TABLE games", "x", &g1).is_err());
        assert!(db.list("sessions").is_err());

        db.session_insert("g1", 1000, 61_000, 60).unwrap();
        db.delete("games", "g1").unwrap();
        assert_eq!(db.list("games").unwrap().len(), 1);
        assert!(db.sessions_for_game("g1", 10).unwrap().is_empty(), "Sitzungen mitgelöscht");

        db.kv_set("settings", &json!({"theme": "nova"})).unwrap();
        assert_eq!(db.kv_get("settings").unwrap()["theme"], "nova");
        assert_eq!(db.kv_get("fehlt").unwrap(), Value::Null);
        db.kv_set("settings", &Value::Null).unwrap();
        assert_eq!(db.kv_get("settings").unwrap(), Value::Null);
    }

    #[test]
    fn sessions_and_stats() {
        let (_d, db) = temp_db();
        db.session_insert("a", 1_000, 61_000, 60).unwrap();
        db.session_insert("a", 100_000, 220_000, 120).unwrap();
        let s3 = db.session_insert("b", 50_000, 80_000, 30).unwrap();
        let open = db.session_insert("b", 300_000, 300_000, 0).unwrap();
        assert!(db.session_update(open.id, 330_000, 30).unwrap());
        assert!(!db.session_update(9999, 1, 1).unwrap());

        let stats = db.playtime_stats().unwrap();
        assert_eq!(stats.len(), 2);
        let a = stats.iter().find(|s| s.game_id == "a").unwrap();
        assert_eq!(a.total_seconds, 180);
        assert_eq!(a.sessions, 2);
        assert_eq!(a.first_played_at, Some(1_000));
        assert_eq!(a.last_played_at, Some(220_000));
        assert_eq!(a.last_session_seconds, Some(120));
        let b = stats.iter().find(|s| s.game_id == "b").unwrap();
        assert_eq!(b.total_seconds, 60);
        assert_eq!(b.last_session_seconds, Some(30));

        let range = db.sessions_range(50_000, 300_000).unwrap();
        assert_eq!(range.iter().map(|s| s.start).collect::<Vec<_>>(), vec![50_000, 100_000]);

        let recent = db.sessions_for_game("a", 1).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].start, 100_000);

        db.session_delete(s3.id).unwrap();
        assert!(db.session_get(s3.id).unwrap().is_none());
    }

    #[test]
    fn empty_sessions_removed_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nova.db");
        {
            let db = Db::open(&path).unwrap();
            db.session_insert("a", 1, 1, 0).unwrap();
            db.session_insert("a", 5, 20_000, 20).unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.sessions_all().unwrap().len(), 1);
    }

    #[test]
    fn export_import_roundtrip() {
        let (_d, db) = temp_db();
        db.put("games", "g1", &json!({"id":"g1","name":"Alpha"})).unwrap();
        db.put("collections", "c1", &json!({"id":"c1","name":"Favs"})).unwrap();
        db.put("wishlist", "w1", &json!({"id":"w1","name":"Wunsch"})).unwrap();
        db.session_insert("g1", 1_000, 11_000, 10).unwrap();
        db.session_insert("g1", 20_000, 80_000, 60).unwrap();
        db.kv_set("settings", &json!({"theme":"neon"})).unwrap();
        let export = db.export_library().unwrap();
        assert_eq!(export["format"], "nova-library");
        assert_eq!(export["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(export["sessions"][0]["gameId"], "g1");

        // Ersetzen in eine leere Datenbank
        let (_d2, mut other) = temp_db();
        other.put("games", "old", &json!({"id":"old"})).unwrap();
        let rep = other.import_library(&export, true).unwrap();
        assert_eq!(rep, ImportReport { games: 1, collections: 1, wishlist: 1, sessions: 2 });
        assert_eq!(other.list("games").unwrap().len(), 1, "replace entfernt alte Spiele");
        assert_eq!(other.kv_get("settings").unwrap()["theme"], "neon");
        assert_eq!(other.export_library().unwrap()["games"], export["games"]);

        // Zusammenführen: doppelte Sitzungen werden übersprungen, Einstellungen bleiben
        other.kv_set("settings", &json!({"theme":"polar"})).unwrap();
        other.put("games", "g2", &json!({"id":"g2"})).unwrap();
        let rep2 = other.import_library(&export, false).unwrap();
        assert_eq!(rep2.sessions, 0);
        assert_eq!(rep2.games, 1);
        assert_eq!(other.list("games").unwrap().len(), 2);
        assert_eq!(other.kv_get("settings").unwrap()["theme"], "polar");
        assert_eq!(other.sessions_all().unwrap().len(), 2);

        // Ungültige Dateien
        assert!(other.import_library(&json!({"format":"anders"}), false).is_err());
        assert!(other.import_library(&json!({"format":"nova-library","version":99}), false).is_err());
    }

    #[test]
    fn vacuum_backup() {
        let (dir, db) = temp_db();
        db.put("games", "g1", &json!({"id":"g1"})).unwrap();
        let dest = dir.path().join("backups").join("nova-20240101-000000.db");
        db.backup_into(&dest).unwrap();
        assert!(dest.exists());
        assert!(db.backup_into(&dest).is_err(), "vorhandene Datei nicht überschreiben");
        let copy = Db::open(&dest).unwrap();
        assert_eq!(copy.list("games").unwrap().len(), 1);
    }
}
