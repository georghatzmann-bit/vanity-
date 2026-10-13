//! Befehle für Bibliothek (Tabellen, Schlüssel/Wert) und Spielzeit.

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::error::{blocking, CmdResult};
use crate::models::{PlayStats, Session};
use crate::state::Shared;
use crate::util::now_ms;

/// Element für `db_put_many`.
#[derive(Debug, Deserialize)]
pub struct PutItem {
    pub id: String,
    pub value: Value,
}

/// Größte manuell nachtragbare Dauer (1000 Stunden).
const MAX_MANUAL_SECONDS: f64 = 1000.0 * 3600.0;

/// Start/Ende für nachgetragene Spielzeit: beginnt bei `at`, endet aber nie in der Zukunft.
pub fn manual_session_bounds(seconds: i64, at: Option<i64>, now: i64) -> (i64, i64) {
    let dur = seconds * 1000;
    let mut start = at.unwrap_or(now - dur);
    if start + dur > now {
        start = now - dur;
    }
    let start = start.max(0);
    (start, start + dur)
}

#[tauri::command]
pub async fn db_list(state: State<'_, Shared>, table: String) -> CmdResult<Vec<Value>> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.list(&table))).await
}

#[tauri::command]
pub async fn db_put(state: State<'_, Shared>, table: String, id: String, value: Value) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.put(&table, &id, &value))).await
}

#[tauri::command]
pub async fn db_put_many(state: State<'_, Shared>, table: String, items: Vec<PutItem>) -> CmdResult<()> {
    let core = state.inner().clone();
    let items: Vec<(String, Value)> = items.into_iter().map(|i| (i.id, i.value)).collect();
    blocking(move || core.db.with(|db| db.put_many(&table, &items))).await
}

#[tauri::command]
pub async fn db_delete(state: State<'_, Shared>, table: String, id: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.delete(&table, &id))).await
}

#[tauri::command]
pub async fn games_merge(state: State<'_, Shared>, keep_id: String, remove_ids: Vec<String>) -> CmdResult<usize> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.merge_games(&keep_id, &remove_ids))).await
}

#[tauri::command]
pub async fn kv_get(state: State<'_, Shared>, key: String) -> CmdResult<Value> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.kv_get(&key))).await
}

#[tauri::command]
pub async fn kv_set(state: State<'_, Shared>, key: String, value: Option<Value>) -> CmdResult<()> {
    let core = state.inner().clone();
    let value = value.unwrap_or(Value::Null);
    blocking(move || core.db.with(|db| db.kv_set(&key, &value))).await
}

#[tauri::command]
pub async fn playtime_stats(state: State<'_, Shared>) -> CmdResult<Vec<PlayStats>> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.playtime_stats())).await
}

#[tauri::command]
pub async fn sessions_range(state: State<'_, Shared>, from: f64, to: f64) -> CmdResult<Vec<Session>> {
    if !from.is_finite() || !to.is_finite() {
        return Err("Ungültiger Zeitraum.".into());
    }
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.sessions_range(from as i64, to as i64))).await
}

#[tauri::command]
pub async fn sessions_for_game(
    state: State<'_, Shared>,
    game_id: String,
    limit: Option<f64>,
) -> CmdResult<Vec<Session>> {
    let limit = limit.filter(|l| l.is_finite() && *l > 0.0).unwrap_or(100.0) as i64;
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.sessions_for_game(&game_id, limit))).await
}

#[tauri::command]
pub async fn session_delete(state: State<'_, Shared>, id: f64) -> CmdResult<()> {
    if !id.is_finite() {
        return Err("Ungültige Sitzung.".into());
    }
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.session_delete(id as i64))).await
}

#[tauri::command]
pub async fn playtime_add(
    state: State<'_, Shared>,
    game_id: String,
    seconds: f64,
    at: Option<f64>,
) -> CmdResult<Session> {
    if game_id.trim().is_empty() {
        return Err("Ungültige Spiel-ID.".into());
    }
    if !seconds.is_finite() || !(1.0..=MAX_MANUAL_SECONDS).contains(&seconds) {
        return Err("Bitte gib eine gültige Spielzeit ein (1 Sekunde bis 1000 Stunden).".into());
    }
    let secs = seconds.round() as i64;
    let at = at.filter(|a| a.is_finite() && *a > 0.0).map(|a| a as i64);
    let (start, end) = manual_session_bounds(secs, at, now_ms());
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.session_insert(&game_id, start, end, secs))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_bounds() {
        let now = 10_000_000;
        // Vergangenes Datum: beginnt bei `at`
        assert_eq!(manual_session_bounds(60, Some(1_000_000), now), (1_000_000, 1_060_000));
        // "Jetzt" → endet jetzt statt in der Zukunft
        assert_eq!(manual_session_bounds(60, Some(now), now), (now - 60_000, now));
        assert_eq!(manual_session_bounds(60, None, now), (now - 60_000, now));
    }
}
