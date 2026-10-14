//! SQLite-Datenbank pro Profil: Bibliothek (JSON-Objekte), Schlüssel/Wert-Speicher, Spielsitzungen
//! und (ab Schema v2) der Netzwerk-Verlauf (`session_samples`, `ping_hourly`, `net_events`).
//! Vertrag: `docs/API.md`, „Datenbank v2“.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::{db_err, io_err, CmdResult, LockExt};
use crate::models::{PlayStats, Session};
use crate::net::hist_types::{method_str, HourlyRow, NetEvent};
use crate::util::now_ms;

/// Aktuelle Schema-Version (`PRAGMA user_version`).
pub const SCHEMA_VERSION: i64 = 2;

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

/// Netzwerk-Verlauf (Schema v2, wörtlich nach Vertrag).
const SCHEMA_V2: &str = r#"
CREATE TABLE IF NOT EXISTS session_samples (
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_start  INTEGER NOT NULL,
  target_key   TEXT    NOT NULL,
  target_label TEXT    NOT NULL,
  method       TEXT    NOT NULL,
  n            INTEGER NOT NULL,
  data         BLOB    NOT NULL,
  PRIMARY KEY (session_id, chunk_start)
);
CREATE TABLE IF NOT EXISTS ping_hourly (
  hour_start  INTEGER NOT NULL,
  target_key  TEXT    NOT NULL,
  net_id      TEXT    NOT NULL,
  connection  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  method      TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  lost        INTEGER NOT NULL,
  sum_rtt     REAL    NOT NULL,
  sum_jitter  REAL    NOT NULL,
  n_jitter    INTEGER NOT NULL,
  max_rtt     REAL,
  spikes      INTEGER NOT NULL,
  covered_ms  INTEGER NOT NULL,
  PRIMARY KEY (hour_start, target_key, net_id, connection)
);
CREATE TABLE IF NOT EXISTS net_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  t            INTEGER NOT NULL,
  end_t        INTEGER,
  kind         TEXT    NOT NULL,
  target_key   TEXT,
  target_label TEXT,
  method       TEXT,
  net_id       TEXT    NOT NULL DEFAULT '',
  connection   TEXT,
  value        REAL,
  cause        TEXT,
  scope        TEXT,
  session_id   INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_net_events_t ON net_events(t);
CREATE INDEX IF NOT EXISTS idx_net_events_kind_t ON net_events(kind, t);
CREATE INDEX IF NOT EXISTS idx_net_events_session ON net_events(session_id);
"#;

const DAY_MS: i64 = 24 * 3_600_000;
/// Rohdaten (`session_samples`): nur die neuesten so vielen Sitzungen mit Messwerten …
pub const SAMPLES_KEEP_SESSIONS: usize = 50;
/// … höchstens so alt …
pub const SAMPLES_MAX_AGE_MS: i64 = 90 * DAY_MS;
/// … und zusammen höchstens so groß (`SUM(length(data))`, 8 MB).
pub const SAMPLES_MAX_BYTES: i64 = 8_000_000;
/// Stunden-Summen (`ping_hourly`) höchstens so alt.
pub const HOURLY_MAX_AGE_MS: i64 = 400 * DAY_MS;
/// Ausreißer (`spike`): höchstens so viele Zeilen …
pub const SPIKE_MAX_ROWS: i64 = 10_000;
/// … höchstens so alt …
pub const SPIKE_MAX_AGE_MS: i64 = 180 * DAY_MS;
/// … und ab diesem Alter ohne `detail`.
pub const SPIKE_DETAIL_AGE_MS: i64 = 30 * DAY_MS;
/// Alle anderen Ereignisse höchstens so alt …
pub const EVENTS_MAX_AGE_MS: i64 = 365 * DAY_MS;
/// … und je Art höchstens so viele Zeilen.
pub const EVENTS_MAX_ROWS_PER_KIND: i64 = 20_000;
/// Name der Kopie vor der Migration auf v2 (`backups/pulsar-vor-v2-<JJJJMMTT-HHMMSS>.db`).
pub const PRE_V2_PREFIX: &str = "pulsar-vor-v2-";

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
        // Verlauf aufräumen ist nie ein Grund, die Datenbank nicht zu öffnen
        if let Err(e) = db.cleanup_history(now_ms()) {
            eprintln!("Messverlauf konnte nicht aufgeräumt werden: {e}");
        }
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Lesender Zugriff auf die Verbindung (Lesebefehle des Netzwerk-Verlaufs).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Schreibender Zugriff (eigene Transaktionen, z. B. das Schreiben des Recorders).
    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
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
        if version == 1 {
            self.copy_before_v2();
        }
        if version < 2 {
            let tx = self.conn.transaction().map_err(db_err)?;
            tx.execute_batch(SCHEMA_V2).map_err(db_err)?;
            tx.execute_batch("PRAGMA user_version = 2").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        // Zukünftige Migrationen: if version < 3 { … }
        Ok(())
    }

    /// Vor der Migration v1 → v2: Kopie `backups/pulsar-vor-v2-<Zeit>.db`, wenn es schon Sitzungen
    /// gibt (eine ältere Pulsar-Version öffnet die migrierte Datei nicht mehr). Best effort: Fehler
    /// werden nur geloggt.
    fn copy_before_v2(&self) {
        let has_sessions: bool = self
            .conn
            .query_row("SELECT EXISTS(SELECT 1 FROM sessions)", [], |r| r.get(0))
            .unwrap_or(false);
        if !has_sessions {
            return;
        }
        let Some(dir) = self.path.parent().map(|p| p.join("backups")) else { return };
        let stamp = crate::util::timestamp_name();
        let dest = std::iter::once(dir.join(format!("{PRE_V2_PREFIX}{stamp}.db")))
            .chain((2..100).map(|i| dir.join(format!("{PRE_V2_PREFIX}{stamp}-{i}.db"))))
            .find(|p| !p.exists());
        let Some(dest) = dest else { return };
        if let Err(e) = self.backup_into(&dest) {
            eprintln!("Kopie vor dem Datenbank-Update konnte nicht angelegt werden: {e}");
        }
    }

    /// Netzwerk-Verlauf aufräumen (Regeln je Tabelle und Ereignisart, `docs/API.md` „Datenbank
    /// v2“). Eine Transaktion; liefert die Zahl gelöschter bzw. gekürzter Zeilen.
    pub fn cleanup_history(&mut self, now: i64) -> CmdResult<u64> {
        let tx = self.conn.transaction().map_err(db_err)?;
        let mut changed = 0usize;
        // session_samples: 90 Tage, dann die 50 neuesten Sitzungen und höchstens 8 MB
        changed += tx
            .execute("DELETE FROM session_samples WHERE chunk_start < ?1", params![now - SAMPLES_MAX_AGE_MS])
            .map_err(db_err)?;
        let per_session: Vec<(i64, i64)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT session_id, SUM(length(data)) FROM session_samples
                     GROUP BY session_id ORDER BY MAX(chunk_start) DESC, session_id DESC",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))))
                .map_err(db_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?
        };
        for id in samples_to_drop(&per_session) {
            changed += tx
                .execute("DELETE FROM session_samples WHERE session_id = ?1", params![id])
                .map_err(db_err)?;
        }
        // ping_hourly: 400 Tage
        changed += tx
            .execute("DELETE FROM ping_hourly WHERE hour_start < ?1", params![now - HOURLY_MAX_AGE_MS])
            .map_err(db_err)?;
        // spike: 180 Tage, 10 000 Zeilen, ab 30 Tagen ohne detail
        changed += tx
            .execute("DELETE FROM net_events WHERE kind = 'spike' AND t < ?1", params![now - SPIKE_MAX_AGE_MS])
            .map_err(db_err)?;
        changed += tx
            .execute(
                "DELETE FROM net_events WHERE kind = 'spike' AND id NOT IN
                 (SELECT id FROM net_events WHERE kind = 'spike' ORDER BY t DESC, id DESC LIMIT ?1)",
                params![SPIKE_MAX_ROWS],
            )
            .map_err(db_err)?;
        changed += tx
            .execute(
                "UPDATE net_events SET detail = NULL WHERE kind = 'spike' AND t < ?1 AND detail IS NOT NULL",
                params![now - SPIKE_DETAIL_AGE_MS],
            )
            .map_err(db_err)?;
        // alle anderen Arten: 365 Tage, je Art 20 000 Zeilen (Ausreißer verdrängen nichts)
        changed += tx
            .execute("DELETE FROM net_events WHERE kind <> 'spike' AND t < ?1", params![now - EVENTS_MAX_AGE_MS])
            .map_err(db_err)?;
        let kinds: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT DISTINCT kind FROM net_events WHERE kind <> 'spike'")
                .map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?
        };
        for kind in kinds {
            changed += tx
                .execute(
                    "DELETE FROM net_events WHERE kind = ?1 AND id NOT IN
                     (SELECT id FROM net_events WHERE kind = ?1 ORDER BY t DESC, id DESC LIMIT ?2)",
                    params![kind, EVENTS_MAX_ROWS_PER_KIND],
                )
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(changed as u64)
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

/// Welche Sitzungen ihre Rohdaten verlieren: `per_session` = `(session_id, Bytes)`, neueste zuerst.
/// Behalten werden die 50 neuesten, solange die Summe 8 MB nicht übersteigt (die neueste bleibt
/// immer).
fn samples_to_drop(per_session: &[(i64, i64)]) -> Vec<i64> {
    let mut total = 0i64;
    per_session
        .iter()
        .enumerate()
        .filter_map(|(i, (id, bytes))| {
            total = total.saturating_add(*bytes);
            (i >= SAMPLES_KEEP_SESSIONS || (i > 0 && total > SAMPLES_MAX_BYTES)).then_some(*id)
        })
        .collect()
}

// =============================================================================================
// Schreib-Bausteine des Netzwerk-Verlaufs (laufen in der Transaktion des Recorders)
// =============================================================================================

/// Ein Block Sitzungs-Messwerte, fremdschlüsselsicher: Gibt es die Sitzung nicht (mehr), wird er
/// still verworfen; ein schon vorhandener Block bleibt. `true` = geschrieben.
#[allow(clippy::too_many_arguments)]
pub fn insert_samples_chunk(
    conn: &Connection,
    session_id: i64,
    chunk_start: i64,
    target_key: &str,
    target_label: &str,
    method: &str,
    n: i64,
    data: &[u8],
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "INSERT INTO session_samples(session_id, chunk_start, target_key, target_label, method, n, data)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS(SELECT 1 FROM sessions WHERE id = ?1)
         ON CONFLICT(session_id, chunk_start) DO NOTHING",
        params![session_id, chunk_start, target_key, target_label, method, n, data],
    )?;
    Ok(changed > 0)
}

/// Stunden-Summen addieren (Upsert; `max_rtt` mit `CASE`, weil SQLites `max(a, NULL)` NULL wäre).
pub fn upsert_hourly(conn: &Connection, row: &HourlyRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ping_hourly(hour_start, target_key, net_id, connection, kind, label, method,
                                 n, lost, sum_rtt, sum_jitter, n_jitter, max_rtt, spikes, covered_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(hour_start, target_key, net_id, connection) DO UPDATE SET
           n = n + excluded.n, lost = lost + excluded.lost, sum_rtt = sum_rtt + excluded.sum_rtt,
           sum_jitter = sum_jitter + excluded.sum_jitter, n_jitter = n_jitter + excluded.n_jitter,
           spikes = spikes + excluded.spikes, covered_ms = covered_ms + excluded.covered_ms,
           max_rtt = CASE WHEN max_rtt IS NULL THEN excluded.max_rtt
                          WHEN excluded.max_rtt IS NULL THEN max_rtt
                          ELSE max(max_rtt, excluded.max_rtt) END,
           kind = excluded.kind, label = excluded.label, method = excluded.method",
        params![
            row.hour_start,
            row.target_key,
            row.net_id,
            row.connection.as_str(),
            row.kind.as_str(),
            row.label,
            method_str(row.method),
            row.n,
            row.lost,
            row.sum_rtt,
            row.sum_jitter,
            row.n_jitter,
            row.max_rtt,
            row.spikes,
            row.covered_ms,
        ],
    )?;
    Ok(())
}

/// Neues Ereignis anlegen; `detail` ist schon auf 1 KiB gekappt. Liefert die rowid.
pub fn insert_event(conn: &Connection, e: &NetEvent, detail: Option<&str>) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO net_events(t, end_t, kind, target_key, target_label, method, net_id, connection,
                                value, cause, scope, session_id, detail)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            e.t,
            e.end_t,
            e.kind.as_str(),
            e.target_key,
            e.target_label,
            e.method.map(method_str),
            e.net_id,
            e.connection.map(|c| c.as_str()),
            e.value.filter(|v| v.is_finite()),
            e.cause.map(|c| c.as_str()),
            e.scope.map(|s| s.as_str()),
            e.session_id,
            detail,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Offenes Ereignis auf den aktuellen Stand bringen (`end_t`, `value`, `cause`, `scope`, `detail`).
/// `false` = Zeile gibt es nicht (mehr).
pub fn update_event(conn: &Connection, id: i64, e: &NetEvent, detail: Option<&str>) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE net_events SET end_t = ?2, value = ?3, cause = ?4, scope = ?5, detail = ?6 WHERE id = ?1",
        params![
            id,
            e.end_t,
            e.value.filter(|v| v.is_finite()),
            e.cause.map(|c| c.as_str()),
            e.scope.map(|s| s.as_str()),
            detail,
        ],
    )?;
    Ok(changed > 0)
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
        let db = Db::open(&dir.path().join("p").join("pulsar.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn schema_version_and_wal() {
        let (_d, db) = temp_db();
        let v: i64 = db.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        assert_eq!(v, SCHEMA_VERSION);
        for t in ["session_samples", "ping_hourly", "net_events"] {
            let n: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "{t}");
        }
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

        db.kv_set("settings", &json!({"theme": "pulsar"})).unwrap();
        assert_eq!(db.kv_get("settings").unwrap()["theme"], "pulsar");
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
        let path = dir.path().join("pulsar.db");
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
        let dest = dir.path().join("backups").join("pulsar-20240101-000000.db");
        db.backup_into(&dest).unwrap();
        assert!(dest.exists());
        assert!(db.backup_into(&dest).is_err(), "vorhandene Datei nicht überschreiben");
        let copy = Db::open(&dest).unwrap();
        assert_eq!(copy.list("games").unwrap().len(), 1);
    }
    fn count(db: &Db, sql: &str) -> i64 {
        db.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migrates_v1_to_v2() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p").join("pulsar.db");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        {
            // Eine echte v1-Datei wie aus der Vorversion
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("PRAGMA user_version = 1").unwrap();
            conn.execute("INSERT INTO sessions(game_id, start, end, seconds) VALUES('g', 1000, 61000, 60)", []).unwrap();
            conn.execute("INSERT INTO kv(key, value) VALUES('settings', '{\"theme\":\"pulsar\"}')", []).unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(count(&db, "PRAGMA user_version"), 2);
        assert_eq!(db.sessions_range(0, i64::MAX).unwrap().len(), 1, "Sitzung bleibt");
        assert_eq!(db.kv_get("settings").unwrap()["theme"], "pulsar", "kv bleibt");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events"), 0);
        let copies: Vec<String> = std::fs::read_dir(path.parent().unwrap().join("backups"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert!(copies[0].starts_with(PRE_V2_PREFIX) && copies[0].ends_with(".db"), "{copies:?}");
        // Die Kopie ist noch v1 (für eine ältere Pulsar-Version)
        let copy = Connection::open(path.parent().unwrap().join("backups").join(&copies[0])).unwrap();
        let v: i64 = copy.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        drop(db);
        // Zweites Öffnen: keine weitere Kopie
        let _db = Db::open(&path).unwrap();
        assert_eq!(std::fs::read_dir(path.parent().unwrap().join("backups")).unwrap().count(), 1);
    }

    #[test]
    fn migration_without_sessions_makes_no_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pulsar.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("PRAGMA user_version = 1").unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(count(&db, "PRAGMA user_version"), 2);
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn samples_cascade_on_session_delete() {
        let (_d, mut db) = temp_db();
        let s = db.session_insert("g", 1_000, 61_000, 60).unwrap();
        let other = db.session_insert("h", 1_000, 61_000, 60).unwrap();
        assert!(insert_samples_chunk(&db.conn, s.id, 1_000, "aws-x", "X", "icmp", 1, &[1, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap());
        assert!(insert_samples_chunk(&db.conn, other.id, 1_000, "aws-x", "X", "icmp", 0, &[1]).unwrap());
        assert!(!insert_samples_chunk(&db.conn, s.id, 1_000, "aws-x", "X", "icmp", 0, &[1]).unwrap(), "vorhandener Block bleibt");
        assert!(!insert_samples_chunk(&db.conn, 999, 1_000, "aws-x", "X", "icmp", 0, &[1]).unwrap(), "ohne Sitzung verworfen");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM session_samples"), 2);
        db.session_delete(s.id).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM session_samples"), 1);
        db.delete("games", "h").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM session_samples"), 0, "Spiel gelöscht → Sitzungen → Messwerte");
    }

    fn hourly_row(max_rtt: Option<f64>) -> HourlyRow {
        use crate::net::hist_types::{ConnectionKind, TargetKind};
        use crate::net::types::PingMethod;
        HourlyRow {
            hour_start: 3_600_000,
            target_key: "aws-eu-central-1".into(),
            net_id: "abc".into(),
            connection: ConnectionKind::Wifi,
            kind: TargetKind::Region,
            label: "Frankfurt".into(),
            method: PingMethod::Icmp,
            n: 10,
            lost: 1,
            sum_rtt: 200.0,
            sum_jitter: 9.0,
            n_jitter: 8,
            max_rtt,
            spikes: 1,
            covered_ms: 10_000,
        }
    }

    #[test]
    fn hourly_upsert_adds_up() {
        let (_d, db) = temp_db();
        let read_max = |db: &Db| -> Option<f64> { db.conn.query_row("SELECT max_rtt FROM ping_hourly", [], |r| r.get(0)).unwrap() };
        upsert_hourly(&db.conn, &hourly_row(None)).unwrap();
        assert_eq!(read_max(&db), None);
        upsert_hourly(&db.conn, &hourly_row(Some(40.0))).unwrap();
        assert_eq!(read_max(&db), Some(40.0), "NULL + Wert = Wert");
        upsert_hourly(&db.conn, &hourly_row(None)).unwrap();
        assert_eq!(read_max(&db), Some(40.0), "Wert + NULL = Wert");
        let mut r = hourly_row(Some(80.0));
        r.label = "Frankfurt am Main".into();
        upsert_hourly(&db.conn, &r).unwrap();
        upsert_hourly(&db.conn, &hourly_row(Some(10.0))).unwrap();
        assert_eq!(read_max(&db), Some(80.0), "größter Wert bleibt");
        let (n, lost, sum_rtt, sum_jitter, n_jitter, spikes, covered): (i64, i64, f64, f64, i64, i64, i64) = db
            .conn
            .query_row("SELECT n, lost, sum_rtt, sum_jitter, n_jitter, spikes, covered_ms FROM ping_hourly", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .unwrap();
        assert_eq!((n, lost, n_jitter, spikes, covered), (50, 5, 40, 5, 50_000));
        assert_eq!((sum_rtt, sum_jitter), (1000.0, 45.0));
        let label: String = db.conn.query_row("SELECT label FROM ping_hourly", [], |r| r.get(0)).unwrap();
        assert_eq!(label, "Frankfurt", "zuletzt geschrieben");
        // Anderes Netz oder andere Verbindungsart → eigene Zeile
        let mut other = hourly_row(None);
        other.net_id = "def".into();
        upsert_hourly(&db.conn, &other).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM ping_hourly"), 2);
    }

    fn event(kind: crate::net::hist_types::EventKind, t: i64) -> NetEvent {
        NetEvent::new(kind, t)
    }

    #[test]
    fn event_insert_and_update() {
        use crate::net::hist_types::{EventKind, OutageScope};
        let (_d, db) = temp_db();
        let mut e = event(EventKind::Outage, 1_000);
        let id = insert_event(&db.conn, &e, None).unwrap();
        e.end_t = Some(5_000);
        e.value = Some(4.0);
        e.scope = Some(OutageScope::Internet);
        assert!(update_event(&db.conn, id, &e, Some("{\"checks\":{}}")).unwrap());
        assert!(!update_event(&db.conn, id + 1, &e, None).unwrap(), "fehlende Zeile");
        let (end_t, value, scope, detail): (Option<i64>, Option<f64>, Option<String>, Option<String>) = db
            .conn
            .query_row("SELECT end_t, value, scope, detail FROM net_events WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!((end_t, value, scope.as_deref(), detail.as_deref()), (Some(5_000), Some(4.0), Some("internet"), Some("{\"checks\":{}}")));
    }

    #[test]
    fn history_cleanup_rules() {
        use crate::net::hist_types::EventKind;
        let (_d, mut db) = temp_db();
        let now = 1_000 * DAY_MS;
        // --- session_samples: 60 Sitzungen, die älteste 100 Tage alt
        let mut ids = Vec::new();
        for i in 0..60i64 {
            let start = now - (60 - i) * DAY_MS - DAY_MS / 2 + if i == 0 { -40 * DAY_MS } else { 0 };
            let s = db.session_insert("g", start, start + 60_000, 60).unwrap();
            insert_samples_chunk(&db.conn, s.id, start, "aws-x", "X", "icmp", 0, &[1u8; 100]).unwrap();
            ids.push(s.id);
        }
        // --- ping_hourly: 401 und 399 Tage alt
        let mut old = hourly_row(None);
        old.hour_start = now - 401 * DAY_MS;
        upsert_hourly(&db.conn, &old).unwrap();
        let mut young = hourly_row(None);
        young.hour_start = now - 399 * DAY_MS;
        upsert_hourly(&db.conn, &young).unwrap();
        // --- net_events: Ausreißer-Flut mit 15 000 Zeilen, dazu Aussetzer und Speedtests
        {
            let tx = db.conn.transaction().unwrap();
            for i in 0..15_000i64 {
                let mut e = event(EventKind::Spike, now - i * 600_000); // alle 10 min → ~104 Tage
                e.detail = Some(serde_json::json!({ "count": 1 }));
                insert_event(&tx, &e, Some("{\"count\":1}")).unwrap();
            }
            for d in [10, 200, 364, 366] {
                insert_event(&tx, &event(EventKind::Outage, now - d * DAY_MS), None).unwrap();
                insert_event(&tx, &event(EventKind::Speedtest, now - d * DAY_MS), None).unwrap();
            }
            insert_event(&tx, &event(EventKind::Spike, now - 181 * DAY_MS), None).unwrap();
            tx.commit().unwrap();
        }
        let changed = db.cleanup_history(now).unwrap();
        assert!(changed > 0);

        // Rohdaten: die älteste (100 Tage) fällt weg, danach nur die 50 neuesten
        let kept: Vec<i64> = {
            let mut stmt = db.conn.prepare("SELECT DISTINCT session_id FROM session_samples ORDER BY session_id").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(kept, ids[10..].to_vec());
        assert_eq!(db.sessions_range(0, i64::MAX).unwrap().len(), 60, "Sitzungen selbst bleiben");
        // Stunden: 400-Tage-Grenze
        assert_eq!(count(&db, "SELECT COUNT(*) FROM ping_hourly"), 1);
        // Ausreißer: höchstens 10 000, Aussetzer und Speedtests bleiben (bis 365 Tage)
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events WHERE kind = 'spike'"), SPIKE_MAX_ROWS);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events WHERE kind = 'outage'"), 3);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events WHERE kind = 'speedtest'"), 3);
        assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM net_events WHERE kind = 'spike' AND t < {}", now - SPIKE_MAX_AGE_MS)), 0);
        // detail ab 30 Tagen NULL, jüngere behalten es
        let old_with_detail = count(&db, &format!("SELECT COUNT(*) FROM net_events WHERE kind='spike' AND detail IS NOT NULL AND t < {}", now - SPIKE_DETAIL_AGE_MS));
        assert_eq!(old_with_detail, 0);
        let young_with_detail = count(&db, &format!("SELECT COUNT(*) FROM net_events WHERE kind='spike' AND detail IS NOT NULL AND t >= {}", now - SPIKE_DETAIL_AGE_MS));
        assert_eq!(young_with_detail, 30 * 144 + 1);
        // Ein zweiter Lauf ändert nichts mehr
        assert_eq!(db.cleanup_history(now).unwrap(), 0);
    }

    #[test]
    fn samples_size_cap_drops_oldest_sessions() {
        assert_eq!(samples_to_drop(&[(3, 5_000_000), (2, 4_000_000), (1, 1)]), vec![2, 1]);
        assert_eq!(samples_to_drop(&[(3, 9_000_000)]), Vec::<i64>::new(), "die neueste bleibt immer");
        let many: Vec<(i64, i64)> = (0..55).map(|i| (100 - i, 10)).collect();
        assert_eq!(samples_to_drop(&many), (46..=50).rev().collect::<Vec<i64>>());
    }

    #[test]
    fn events_per_kind_cap() {
        use crate::net::hist_types::EventKind;
        let (_d, mut db) = temp_db();
        let now = 1_000 * DAY_MS;
        {
            let tx = db.conn.transaction().unwrap();
            for i in 0..(EVENTS_MAX_ROWS_PER_KIND + 5) {
                insert_event(&tx, &event(EventKind::Loss, now - i * 1000), None).unwrap();
            }
            insert_event(&tx, &event(EventKind::Quiet, now - 5 * 1000 * EVENTS_MAX_ROWS_PER_KIND), None).unwrap();
            tx.commit().unwrap();
        }
        db.cleanup_history(now).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events WHERE kind = 'loss'"), EVENTS_MAX_ROWS_PER_KIND);
        assert_eq!(count(&db, "SELECT MIN(t) FROM net_events WHERE kind = 'loss'"), now - (EVENTS_MAX_ROWS_PER_KIND - 1) * 1000);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM net_events WHERE kind = 'quiet'"), 1, "andere Art bleibt");
    }
}
