//! Befehle für Bibliothek (Tabellen, Schlüssel/Wert) und Spielzeit.

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::error::{blocking, CmdResult, LockExt};
use crate::models::{PlayStats, Session};
use crate::state::Shared;

/// Element für `db_put_many`.
#[derive(Debug, Deserialize)]
pub struct PutItem {
    pub id: String,
    pub value: Value,
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
pub async fn kv_get(state: State<'_, Shared>, key: String) -> CmdResult<Value> {
    let core = state.inner().clone();
    blocking(move || core.db.with(|db| db.kv_get(&key))).await
}

/// Schlüssel, die nur Pulsar selbst schreibt: die Sicherungen von Windows-Änderungen (und die Marke,
/// dass sie nach einer beschädigten Datenbank unsicher sind). Sie gehen beim Zurückstellen an den
/// Admin-Helfer und beschreiben den aktuellen Zustand von Windows.
pub const MANAGED_KV_KEYS: [&str; 3] =
    [crate::net::dns::KV_DNS_BACKUP, crate::opt::tweaks::KV_SNAPSHOTS, crate::backup::KV_RECOVERY_UNKNOWN];

/// Darf die Oberfläche diesen Schlüssel schreiben?
fn kv_writable(key: &str) -> CmdResult<()> {
    if MANAGED_KV_KEYS.contains(&key.trim()) {
        return Err("Dieser Eintrag wird von Pulsar selbst verwaltet.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn kv_set(state: State<'_, Shared>, key: String, value: Option<Value>) -> CmdResult<()> {
    kv_writable(&key)?;
    let core = state.inner().clone();
    let value = value.unwrap_or(Value::Null);
    blocking(move || {
        core.db.with(|db| db.kv_set(&key, &value))?;
        // Einstellungen sofort in den Recorder spiegeln (`history.record = false` wirkt sofort).
        // Sperr-Reihenfolge: Datenbank ist hier schon wieder frei.
        if key == KV_SETTINGS {
            core.net.recorder.lock_safe().apply_settings(&value);
        }
        Ok(())
    })
    .await
}

/// kv-Schlüssel der Einstellungen der Oberfläche.
pub const KV_SETTINGS: &str = "settings";

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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_keys_are_not_writable_from_the_ui() {
        assert!(kv_writable("settings").is_ok());
        for key in ["net.dnsBackup", "opt.snapshots", " opt.snapshots "] {
            assert_eq!(kv_writable(key), Err("Dieser Eintrag wird von Pulsar selbst verwaltet.".to_string()), "{key}");
        }
    }
}
