//! Netzwerk: Ping (ICMP/TCP), Live-Monitor, Regionen, Routen-Analyse, DNS, Adapter/WLAN, Speedtest.
//!
//! Befehle und Events sind in `docs/API.md` beschrieben. Unter Linux/macOS (Entwicklung, Tests)
//! gibt es Ersatzwege (z. B. TCP statt ICMP) oder klare Meldungen („Nur unter Windows verfügbar.“).
//! Grundsätze: ehrliche Messwerte (nichts erfinden), nie abstürzen, keine Adminrechte, alles
//! zeitlich begrenzt und abbrechbar.

pub mod adapters;
pub mod dns;
pub mod monitor;
pub mod ping;
pub mod regions;
pub mod servers;
pub mod speed;
pub mod trace;
pub mod types;

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::error::{blocking, CmdResult, LockExt};
use crate::state::Shared;
use types::*;

/// Event des Live-Monitors (`MonitorUpdate`).
pub const EVENT_PING: &str = "net://ping";
/// Event der Routen-Analyse (`TraceHop`, nur Windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub const EVENT_TRACE: &str = "net://trace";
/// Event des DNS-Vergleichs (`DnsProgress`).
pub const EVENT_DNS: &str = "net://dns";
/// Event des Speedtests (`SpeedProgress`).
pub const EVENT_SPEED: &str = "net://speed";

/// Laufzeit-Zustand (Live-Monitor, laufender Speedtest, Serverlisten).
#[derive(Default)]
pub struct NetState {
    monitor: Mutex<Option<monitor::MonitorHandle>>,
    speed: speed::SpeedControl,
    servers: servers::ServerCache,
}

impl NetState {
    /// Laufenden Monitor anhalten (kein Fehler, wenn keiner läuft).
    pub fn stop_monitor(&self) {
        if let Some(h) = self.monitor.lock_safe().take() {
            h.stop();
        }
    }

    fn set_monitor(&self, handle: monitor::MonitorHandle) {
        let previous = self.monitor.lock_safe().replace(handle);
        if let Some(p) = previous {
            p.stop();
        }
    }

    /// Läuft gerade ein Monitor? (für Tests)
    #[cfg(test)]
    pub fn monitor_running(&self) -> bool {
        self.monitor.lock_safe().is_some()
    }
}

// =============================================================================================
// Ping & Monitor
// =============================================================================================

#[tauri::command]
pub async fn net_ping_once(target: PingTarget, count: Option<u32>) -> CmdResult<PingStats> {
    ping::ping_series(&target, ping::clamp_count(count)).await
}

#[tauri::command]
pub async fn net_monitor_start(app: AppHandle, state: State<'_, Shared>, targets: Vec<PingTarget>, interval_ms: Option<u32>) -> CmdResult<()> {
    let core = state.inner().clone();
    core.net.stop_monitor();
    if targets.is_empty() {
        return Ok(());
    }
    let interval = monitor::clamp_interval(interval_ms);
    core.net.set_monitor(monitor::start(app, targets, interval));
    Ok(())
}

#[tauri::command]
pub async fn net_monitor_stop(state: State<'_, Shared>) -> CmdResult<()> {
    state.net.stop_monitor();
    Ok(())
}

// =============================================================================================
// Regionen & Spielserver
// =============================================================================================

#[tauri::command]
pub async fn net_regions() -> CmdResult<Vec<Region>> {
    Ok(regions::all())
}

#[tauri::command]
pub async fn net_regions_ping(ids: Option<Vec<String>>, count: Option<u32>) -> CmdResult<Vec<RegionPing>> {
    let selected = regions::select(ids.as_deref());
    Ok(regions::ping_many(&selected, ping::clamp_count(count)).await)
}

#[tauri::command]
pub async fn net_game_servers(state: State<'_, Shared>, game: String) -> CmdResult<Vec<Region>> {
    let game = servers::normalize_game(&game);
    if game == "lol" {
        return Ok(servers::riot_regions());
    }
    let Some(app_id) = servers::steam_app_id(&game) else {
        return Ok(Vec::new());
    };
    let core = state.inner().clone();
    if let Some(cached) = core.net.servers.get(&game) {
        return Ok(cached);
    }
    let list = servers::fetch_valve(&core.http, &game, app_id).await?;
    core.net.servers.put(&game, list.clone());
    Ok(list)
}

// =============================================================================================
// Routen-Analyse
// =============================================================================================

#[tauri::command]
pub async fn net_traceroute(app: AppHandle, host: String, max_hops: Option<u8>) -> CmdResult<TraceResult> {
    #[cfg(windows)]
    {
        trace::run(&app, &host, trace::clamp_hops(max_hops)).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, host, max_hops);
        Err(trace::NOT_WINDOWS.into())
    }
}

// =============================================================================================
// DNS
// =============================================================================================

#[tauri::command]
pub async fn net_dns_benchmark(app: AppHandle, rounds: Option<u32>) -> CmdResult<Vec<DnsResult>> {
    let rounds = dns::clamp_rounds(rounds);
    let current = blocking(|| Ok(dns::system_dns_servers())).await?;
    let results = dns::benchmark(rounds, &current, |p| {
        let _ = app.emit(EVENT_DNS, &p);
    })
    .await;
    Ok(results)
}

#[tauri::command]
pub async fn net_dns_current(state: State<'_, Shared>) -> CmdResult<Option<DnsConfig>> {
    let _ = state;
    #[cfg(windows)]
    {
        blocking(adapters::dns_config).await
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn net_dns_apply(state: State<'_, Shared>, primary: String, secondary: Option<String>) -> CmdResult<()> {
    let _ = (state, primary, secondary);
    Err(dns::NOT_CHANGED_BY_PULSAR.into())
}

#[tauri::command]
pub async fn net_dns_restore(state: State<'_, Shared>) -> CmdResult<()> {
    let _ = state;
    Err(dns::NOT_CHANGED_BY_PULSAR.into())
}

// =============================================================================================
// Adapter & WLAN
// =============================================================================================

#[tauri::command]
pub async fn net_adapters() -> CmdResult<Vec<AdapterInfo>> {
    #[cfg(windows)]
    {
        blocking(adapters::list).await
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn net_wifi() -> CmdResult<Option<WifiInfo>> {
    #[cfg(windows)]
    {
        blocking(adapters::wifi).await
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

// =============================================================================================
// Speedtest
// =============================================================================================

#[tauri::command]
pub async fn net_speedtest(app: AppHandle, state: State<'_, Shared>) -> CmdResult<SpeedResult> {
    let core = state.inner().clone();
    speed::run(&app, &core.net.speed).await
}

#[tauri::command]
pub async fn net_speedtest_cancel(state: State<'_, Shared>) -> CmdResult<()> {
    state.net.speed.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_default_and_idle() {
        let s = NetState::default();
        assert!(!s.monitor_running());
        s.stop_monitor();
        assert!(!s.monitor_running());
        assert!(!s.speed.is_running());
        assert!(s.servers.get("cs2").is_none());
    }

    #[test]
    fn event_names_match_contract() {
        assert_eq!(EVENT_PING, "net://ping");
        assert_eq!(EVENT_TRACE, "net://trace");
        assert_eq!(EVENT_DNS, "net://dns");
        assert_eq!(EVENT_SPEED, "net://speed");
    }
}
