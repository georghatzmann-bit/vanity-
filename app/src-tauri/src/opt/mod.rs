//! Optimieren: Windows-Einstellungen für Spiele (mit Sicherung und „Rückgängig“), Energiepläne
//! und der Boost-Modus. Alles läuft ohne Adminrechte.

pub mod types;

use tauri::{AppHandle, State};

use crate::error::CmdResult;
use crate::state::Shared;
use types::*;

/// Laufzeit-Zustand (aktiver Boost …).
#[derive(Default)]
pub struct OptState {}

fn todo<T>() -> CmdResult<T> {
    Err("Diese Funktion ist noch nicht fertig.".into())
}

#[tauri::command]
pub async fn opt_tweaks(state: State<'_, Shared>) -> CmdResult<Vec<Tweak>> {
    let _ = state;
    todo()
}

#[tauri::command]
pub async fn opt_apply(state: State<'_, Shared>, ids: Vec<String>, enable: bool) -> CmdResult<ApplyReport> {
    let _ = (state, ids, enable);
    todo()
}

#[tauri::command]
pub async fn opt_revert_all(state: State<'_, Shared>) -> CmdResult<ApplyReport> {
    let _ = state;
    todo()
}

#[tauri::command]
pub async fn opt_power_plans() -> CmdResult<Vec<PowerPlan>> {
    todo()
}

#[tauri::command]
pub async fn opt_power_set(guid: String) -> CmdResult<()> {
    let _ = guid;
    todo()
}

#[tauri::command]
pub async fn opt_flush_dns() -> CmdResult<()> {
    todo()
}

#[tauri::command]
pub async fn boost_start(app: AppHandle, state: State<'_, Shared>, profile: BoostProfile, game_id: Option<String>, pid: Option<u32>) -> CmdResult<BoostState> {
    let _ = (app, state, profile, game_id, pid);
    todo()
}

#[tauri::command]
pub async fn boost_stop(app: AppHandle, state: State<'_, Shared>) -> CmdResult<BoostState> {
    let _ = (app, state);
    todo()
}

#[tauri::command]
pub async fn boost_state(state: State<'_, Shared>) -> CmdResult<BoostState> {
    let _ = state;
    Ok(BoostState::default())
}
