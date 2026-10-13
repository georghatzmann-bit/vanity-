//! Netzwerk: Ping (ICMP/TCP), Live-Monitor, Regionen, Routen-Analyse, DNS, Adapter/WLAN, Speedtest.
//!
//! Befehle und Events sind in `docs/API.md` beschrieben. Unter Linux/macOS (Entwicklung, Tests)
//! gibt es Ersatzwege (z. B. TCP statt ICMP) oder klare Meldungen („Nur unter Windows verfügbar.“).
//! Grundsätze: ehrliche Messwerte (nichts erfinden), nie abstürzen, ohne Adminrechte – außer DNS
//! einstellen/zurückstellen über den Admin-Helfer (`crate::elevate`, mit Windows-Abfrage) –, alles
//! zeitlich begrenzt und abbrechbar.

pub mod adapters;
pub mod dns;
pub mod dnsctl;
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
    #[cfg(windows)]
    {
        use dnsctl::DnsSys;
        let core = state.inner().clone();
        blocking(move || Ok(dnsctl::WinDnsSys.config_now(&core))).await
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Ok(None)
    }
}

#[tauri::command]
pub async fn net_dns_apply(state: State<'_, Shared>, provider: String) -> CmdResult<DnsConfig> {
    #[cfg(not(windows))]
    {
        let _ = (state, provider);
        Err(dns::NOT_WINDOWS.into())
    }
    #[cfg(windows)]
    {
        use dnsctl::DnsSys;
        // 1. Dienst muss bekannt sein
        let Some(p) = dns::provider(&provider) else {
            return Err(format!("Unbekannter DNS-Dienst: „{provider}“."));
        };
        // 2. Hauptverbindung + Prüfungen
        let core = state.inner().clone();
        let cfg = blocking({
            let core = core.clone();
            move || dnsctl::WinDnsSys.config_now(&core).ok_or_else(|| "Keine aktive Netzwerkverbindung gefunden.".to_string())
        })
        .await?;
        if !cfg.can_change {
            return Err(dnsctl::CANNOT_CHANGE.into());
        }
        // 3. Live-Prüfung (ohne Adminrechte, ohne Sperre)
        dnsctl::live_check(p).await?;
        // 4.–7. Sicherung, Admin-Helfer, Nachkontrolle, Zwischenspeicher leeren
        blocking(move || dnsctl::apply(&core, &crate::elevate::RealElevator, &dnsctl::WinDnsSys, &provider, &cfg)).await
    }
}

#[tauri::command]
pub async fn net_dns_restore(state: State<'_, Shared>) -> CmdResult<Option<DnsConfig>> {
    #[cfg(not(windows))]
    {
        let _ = state;
        Err(dns::NOT_WINDOWS.into())
    }
    #[cfg(windows)]
    {
        let core = state.inner().clone();
        blocking(move || dnsctl::restore(&core, &crate::elevate::RealElevator, &dnsctl::WinDnsSys)).await
    }
}

// =============================================================================================
// Netzwerk automatisch optimieren
// =============================================================================================

#[tauri::command]
pub async fn net_auto_optimize(state: State<'_, Shared>, provider: Option<String>, tweaks: Vec<String>) -> CmdResult<AutoReport> {
    #[cfg(not(windows))]
    {
        let _ = (state, provider, tweaks);
        Err(dns::NOT_WINDOWS.into())
    }
    #[cfg(windows)]
    {
        use dnsctl::DnsSys;
        let core = state.inner().clone();
        // DNS-Plan samt Live-Prüfung vorab (asynchron). Ein Fehler stoppt die Optimierungen nicht.
        let cfg = blocking({
            let core = core.clone();
            move || Ok(dnsctl::WinDnsSys.config_now(&core))
        })
        .await?;
        let plan = dnsctl::plan_dns(provider.as_deref(), cfg).await;
        blocking(move || dnsctl::auto_optimize(&core, &crate::opt::env(), &dnsctl::WinDnsSys, plan, &tweaks)).await
    }
}

#[tauri::command]
pub async fn net_auto_restore(state: State<'_, Shared>) -> CmdResult<AutoReport> {
    #[cfg(not(windows))]
    {
        let _ = state;
        Err(dns::NOT_WINDOWS.into())
    }
    #[cfg(windows)]
    {
        let core = state.inner().clone();
        blocking(move || dnsctl::auto_restore(&core, &crate::opt::env(), &dnsctl::WinDnsSys)).await
    }
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

// =============================================================================================
// DNS-Sicherung (kv `net.dnsBackup`) – plattformunabhängig (nur Datenbank + JSON)
// =============================================================================================

/// Die DNS-Sicherungen aus der Datenbank lesen.
pub(crate) fn read_dns_backups(core: &Shared) -> CmdResult<dns::DnsBackups> {
    let v = core.db.with(|db| db.kv_get(dns::KV_DNS_BACKUP))?;
    Ok(dns::parse_backups(&v))
}

/// Die DNS-Sicherungen in die Datenbank schreiben (leer → Schlüssel verschwindet).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn write_dns_backups(core: &Shared, map: &dns::DnsBackups) -> CmdResult<()> {
    core.db.with(|db| db.kv_set(dns::KV_DNS_BACKUP, &dns::backups_to_value(map)))
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
