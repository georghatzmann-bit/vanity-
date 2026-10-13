//! SQLite-Datenbank pro Profil: Bibliothek (JSON-Objekte), Schlüssel/Wert-Speicher und Spielsitzungen.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::{db_err, io_err, CmdResult, LockExt};
use crate::models::{PlayStats, Session};
use crate::util::now_ms;

/// Aktuelle Schema-Version (`PRAGMA user_version`).
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
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
        "reports" => Ok("reports"),
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
                "Die Datenbank stammt aus einer neueren Pulsar-Version. Bitte aktualisiere Pulsar.".into(),
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
            None => Err("Die Datenbank ist nicht geöffnet. Bitte Pulsar neu starten.".into()),
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
        assert_eq!(db.sessions_range(0, i64::MAX).unwrap().len(), 1);
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
