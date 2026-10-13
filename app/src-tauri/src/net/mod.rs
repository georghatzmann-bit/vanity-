//! Netzwerk: Ping (ICMP/TCP), Live-Monitor, Regionen, Routen-Analyse, DNS, Adapter/WLAN, Speedtest.
//!
//! Befehle und Events sind in `docs/API.md` beschrieben. Unter Linux/macOS (Entwicklung, Tests)
//! gibt es Ersatzwege (z. B. TCP statt ICMP), damit alles ausprobiert werden kann.

pub mod types;

use tauri::{AppHandle, State};

use crate::error::CmdResult;
use crate::state::Shared;
use types::*;

/// Laufzeit-Zustand (Live-Monitor, laufender Speedtest …).
#[derive(Default)]
pub struct NetState {}

fn todo<T>() -> CmdResult<T> {
    Err("Diese Funktion ist noch nicht fertig.".into())
}

#[tauri::command]
pub async fn net_ping_once(target: PingTarget, count: Option<u32>) -> CmdResult<PingStats> {
    let _ = (target, count);
    todo()
}

#[tauri::command]
pub async fn net_monitor_start(app: AppHandle, state: State<'_, Shared>, targets: Vec<PingTarget>, interval_ms: Option<u32>) -> CmdResult<()> {
    let _ = (app, state, targets, interval_ms);
    todo()
}

#[tauri::command]
pub async fn net_monitor_stop(state: State<'_, Shared>) -> CmdResult<()> {
    let _ = state;
    Ok(())
}

#[tauri::command]
pub async fn net_regions() -> CmdResult<Vec<Region>> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn net_regions_ping(ids: Option<Vec<String>>, count: Option<u32>) -> CmdResult<Vec<RegionPing>> {
    let _ = (ids, count);
    todo()
}

#[tauri::command]
pub async fn net_game_servers(state: State<'_, Shared>, game: String) -> CmdResult<Vec<Region>> {
    let _ = (state, game);
    todo()
}

#[tauri::command]
pub async fn net_traceroute(app: AppHandle, host: String, max_hops: Option<u8>) -> CmdResult<TraceResult> {
    let _ = (app, host, max_hops);
    todo()
}

#[tauri::command]
pub async fn net_dns_benchmark(app: AppHandle, rounds: Option<u32>) -> CmdResult<Vec<DnsResult>> {
    let _ = (app, rounds);
    todo()
}

#[tauri::command]
pub async fn net_dns_current(state: State<'_, Shared>) -> CmdResult<Option<DnsConfig>> {
    let _ = state;
    todo()
}

#[tauri::command]
pub async fn net_dns_apply(state: State<'_, Shared>, primary: String, secondary: Option<String>) -> CmdResult<()> {
    let _ = (state, primary, secondary);
    todo()
}

#[tauri::command]
pub async fn net_dns_restore(state: State<'_, Shared>) -> CmdResult<()> {
    let _ = state;
    todo()
}

#[tauri::command]
pub async fn net_adapters() -> CmdResult<Vec<AdapterInfo>> {
    todo()
}

#[tauri::command]
pub async fn net_wifi() -> CmdResult<Option<WifiInfo>> {
    todo()
}

#[tauri::command]
pub async fn net_speedtest(app: AppHandle, state: State<'_, Shared>) -> CmdResult<SpeedResult> {
    let _ = (app, state);
    todo()
}

#[tauri::command]
pub async fn net_speedtest_cancel(state: State<'_, Shared>) -> CmdResult<()> {
    let _ = state;
    Ok(())
}
