//! Netzwerk: Ping (ICMP/TCP), Live-Monitor, Regionen, Routen-Analyse, DNS, Adapter/WLAN, Speedtest.
//!
//! Befehle und Events sind in `docs/API.md` beschrieben. Unter Linux/macOS (Entwicklung, Tests)
//! gibt es Ersatzwege (z. B. TCP statt ICMP) oder klare Meldungen („Nur unter Windows verfügbar.“).
//! Grundsätze: ehrliche Messwerte (nichts erfinden), nie abstürzen, ohne Adminrechte – außer DNS
//! einstellen/zurückstellen über den Admin-Helfer (`crate::elevate`, mit Windows-Abfrage) –, alles
//! zeitlich begrenzt und abbrechbar.

pub mod adapters;
pub mod cost;
pub mod dns;
pub mod dnsctl;
pub mod hist_types;
pub mod history_events;
pub mod history_hourly;
pub mod history_timeline;
pub mod hook;
pub mod ifstats;
pub mod lag;
pub mod link;
pub mod monitor;
pub mod ping;
pub mod quickhops;
pub mod recorder;
pub mod regions;
pub mod scope;
pub mod servers;
pub mod speed;
pub mod trace;
pub mod types;
pub mod wifiscan;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::error::{blocking, CmdResult, LockExt};
use crate::state::{Core, Shared};
use hist_types::{EventSummaryRow, EventsPage, HourlyRow, SessionTimeline};
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
/// Event des Lag-Detektivs (`LagEvent`).
#[allow(dead_code)]
pub const EVENT_LAG: &str = "net://lag";

/// Laufzeit-Zustand (Live-Monitor, laufender Speedtest, Serverlisten, Netzwerk-Verlauf).
///
/// Sperr-Reihenfolge (verbindlich, `docs/API.md`): `recorder` → freigeben → `db`. `link`,
/// `quiet_until` und `current_session` sind eigene kleine Sperren bzw. Atomics und werden nie
/// zusammen mit `db` gehalten.
#[derive(Default)]
pub struct NetState {
    monitor: Mutex<Option<monitor::MonitorHandle>>,
    speed: speed::SpeedControl,
    servers: servers::ServerCache,
    /// Aufzeichnung des Verlaufs (Datenbank v2)
    pub(crate) recorder: Mutex<recorder::Recorder>,
    /// Schreib-Koordination des Recorders (außerhalb seiner Sperre)
    pub(crate) flush: recorder::FlushGate,
    /// Byte-Zähler und CPU je Monitor-Takt
    pub(crate) load: Mutex<ifstats::LoadSampler>,
    /// Zwischengespeicherte Hauptverbindung
    pub(crate) link: Mutex<Option<link::PrimaryLink>>,
    /// Ermittlung der Hauptverbindung läuft (nie zwei gleichzeitig)
    pub(crate) link_refreshing: AtomicBool,
    /// Ruhezeit bis (ms): Pulsars eigener Speedtest/WLAN-Scan
    pub(crate) quiet_until: AtomicI64,
    /// Aktuelle Spielsitzung `(session_id, started_at)` – schiebt der Tracker
    pub(crate) current_session: Mutex<Option<(i64, i64)>>,
    /// Lag-Detektiv (letzte Ereignisse, Grundwerte)
    pub(crate) lag: lag::LagState,
    /// WLAN-Scan (aktive Scans serialisiert)
    #[allow(dead_code)] // benutzt ab Phase 0b/1
    pub(crate) wifi_scan: wifiscan::ScanGate,
}

impl NetState {
    /// Laufenden Monitor anhalten (kein Fehler, wenn keiner läuft; synchron, wartet nie). Meldet dem
    /// Recorder den Stopp (offene Ereignisse und Block schließen). Liefert `true`, wenn ein Monitor
    /// lief – dann plant der Aufrufer das Schreiben ([`hook::schedule_flush`]) bzw. schreibt beim
    /// Beenden selbst ([`NetState::flush_now`]).
    pub fn stop_monitor(&self) -> bool {
        let Some(h) = self.monitor.lock_safe().take() else { return false };
        h.stop();
        self.recorder.lock_safe().on_stop(crate::util::now_ms());
        true
    }

    /// Offene Puffer des Recorders synchron schreiben (vor Lesebefehlen, beim Beenden). Fehler
    /// werden nur geloggt – die Daten bleiben gepuffert.
    pub fn flush_now(&self, core: &Core) {
        if let Err(e) = recorder::flush_now(core) {
            eprintln!("Messverlauf konnte nicht gespeichert werden: {e}");
        }
    }

    /// Was der Monitor-Hook vor `Recorder::ingest` braucht (kleine Sperren, nie zusammen gehalten).
    pub(crate) fn ingest_ctx(&self, now: i64) -> recorder::IngestCtx {
        // Grund der Ruhezeit: Pulsars Speedtest (läuft oder endete eben – danach gelten noch 5 s),
        // sonst ein aktiver WLAN-Scan
        let speed_end = self.speed.last_end();
        let speedtest = self.speed.is_running() || (speed_end > 0 && now - speed_end <= speed::QUIET_END_MS + 1_000);
        recorder::IngestCtx {
            quiet: now < self.quiet_until.load(Ordering::SeqCst),
            quiet_reason: if speedtest { recorder::QuietReason::Speedtest } else { recorder::QuietReason::WifiScan },
            session: *self.current_session.lock_safe(),
            link: self.link.lock_safe().as_ref().map(link::PrimaryLink::lite),
        }
    }

    /// Hauptverbindung (kurz) für Recorder-Einträge.
    pub(crate) fn link_lite(&self) -> Option<link::PrimaryLinkLite> {
        self.link.lock_safe().as_ref().map(link::PrimaryLink::lite)
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
    if core.net.stop_monitor() {
        hook::schedule_flush(&core);
    }
    if targets.is_empty() {
        return Ok(());
    }
    let interval = monitor::clamp_interval(interval_ms);
    core.net.set_monitor(monitor::start(app, targets, interval));
    Ok(())
}

#[tauri::command]
pub async fn net_monitor_stop(state: State<'_, Shared>) -> CmdResult<()> {
    if state.net.stop_monitor() {
        hook::schedule_flush(state.inner());
    }
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
    // Datenverkehr des Adapters vor dem Test (für das Anbieter-Protokoll)
    let local_mbps = {
        let (rx, tx) = core.net.load.lock_safe().rates(crate::util::now_ms());
        rx.zip(tx).map(|(r, t)| r + t)
    };
    // Setzt die Ruhezeit (Start: now + 60 s, Ende: now + 5 s)
    let result = speed::run(&app, &core.net.speed, &core.net.quiet_until).await?;
    // Protokollieren (`speedtest`-Ereignis) und gleich schreiben; ein Fehler beim Speichern ändert
    // das Ergebnis nicht.
    let link = core.net.link_lite();
    core.net.recorder.lock_safe().push_speedtest(crate::util::now_ms(), &result, link.as_ref(), local_mbps);
    hook::schedule_flush(&core);
    Ok(result)
}

#[tauri::command]
pub async fn net_speedtest_cancel(state: State<'_, Shared>) -> CmdResult<()> {
    state.net.speed.cancel();
    Ok(())
}

// =============================================================================================
// Lag-Detektiv
// =============================================================================================

#[tauri::command]
pub async fn net_if_counters(state: State<'_, Shared>) -> CmdResult<Option<ifstats::IfCounters>> {
    let core = state.inner().clone();
    let now = crate::util::now_ms();
    // Hauptverbindung bei Bedarf ermitteln: blockierend nur in `spawn_blocking`, nie zwei gleichzeitig
    lag::ensure_link(&core, None, now).await;
    Ok(ifstats::counters(&core.net, now))
}

#[tauri::command]
pub async fn net_lag_snapshot(state: State<'_, Shared>, target: PingTarget) -> CmdResult<lag::LagCheck> {
    Ok(lag::snapshot_on_demand(state.inner().clone(), target).await)
}

#[tauri::command]
pub async fn net_lag_recent(state: State<'_, Shared>) -> CmdResult<Vec<lag::LagEvent>> {
    Ok(state.net.lag.recent())
}

// =============================================================================================
// Netzwerk-Verlauf (Zeitleiste, Kalender, Anbieter-Protokoll)
// =============================================================================================

#[tauri::command]
pub async fn net_session_timeline(state: State<'_, Shared>, session_id: i64) -> CmdResult<SessionTimeline> {
    let core = state.inner().clone();
    blocking(move || {
        core.net.flush_now(&core);
        core.db.with(|db| history_timeline::session_timeline(db, session_id))
    })
    .await
}

#[tauri::command]
pub async fn net_history_hourly(
    state: State<'_, Shared>,
    from: i64,
    to: i64,
    target_key: Option<String>,
    net_id: Option<String>,
) -> CmdResult<Vec<HourlyRow>> {
    hist_types::check_range(from, to)?;
    let core = state.inner().clone();
    blocking(move || {
        core.net.flush_now(&core);
        core.db.with(|db| history_hourly::hourly(db, from, to, target_key.as_deref(), net_id.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn net_events_list(
    state: State<'_, Shared>,
    from: i64,
    to: i64,
    kinds: Option<Vec<String>>,
    net_id: Option<String>,
    limit: Option<u32>,
) -> CmdResult<EventsPage> {
    hist_types::check_range(from, to)?;
    let limit = hist_types::clamp_events_limit(limit);
    let core = state.inner().clone();
    blocking(move || {
        core.net.flush_now(&core);
        core.db.with(|db| history_events::list(db, from, to, kinds.as_deref(), net_id.as_deref(), limit))
    })
    .await
}

#[tauri::command]
pub async fn net_events_summary(state: State<'_, Shared>, from: i64, to: i64, net_id: Option<String>) -> CmdResult<Vec<EventSummaryRow>> {
    hist_types::check_range(from, to)?;
    let core = state.inner().clone();
    blocking(move || {
        core.net.flush_now(&core);
        core.db.with(|db| history_events::summary(db, from, to, net_id.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn net_history_clear(state: State<'_, Shared>, scope: String) -> CmdResult<u64> {
    let scope = hist_types::ClearScope::parse(&scope)?;
    let core = state.inner().clone();
    blocking(move || recorder::history_clear(&core, scope)).await
}

// =============================================================================================
// WLAN-Scanner, getaktete Verbindung
// =============================================================================================

#[tauri::command]
pub async fn net_wifi_scan(state: State<'_, Shared>, refresh: Option<bool>) -> CmdResult<wifiscan::WifiScan> {
    wifiscan::scan(state.inner().clone(), refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn net_wifi_state() -> CmdResult<wifiscan::WifiStateInfo> {
    wifiscan::state().await
}

#[tauri::command]
pub async fn net_metered() -> CmdResult<Option<bool>> {
    Ok(cost::metered().await)
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
        assert!(!s.stop_monitor(), "kein Monitor lief");
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
        assert_eq!(EVENT_LAG, "net://lag");
    }

    #[test]
    fn ingest_ctx_reads_quiet_session_and_link() {
        let s = NetState::default();
        let ctx = s.ingest_ctx(1_000);
        assert!(!ctx.quiet && ctx.session.is_none() && ctx.link.is_none());
        s.quiet_until.store(2_000, Ordering::SeqCst);
        *s.current_session.lock_safe() = Some((7, 500));
        let ctx = s.ingest_ctx(1_000);
        assert!(ctx.quiet);
        assert_eq!(ctx.session, Some((7, 500)));
        assert!(!s.ingest_ctx(2_000).quiet, "Ruhezeit endet genau bei quiet_until");
        assert_eq!(ctx.quiet_reason, recorder::QuietReason::WifiScan, "kein Speedtest → WLAN-Scan");
        assert!(s.speed.try_begin());
        assert_eq!(s.ingest_ctx(1_000).quiet_reason, recorder::QuietReason::Speedtest);
        s.speed.end();
        let now = crate::util::now_ms();
        assert_eq!(s.ingest_ctx(now + 1_000).quiet_reason, recorder::QuietReason::Speedtest, "Nachlauf nach dem Test");
        assert_eq!(s.ingest_ctx(now + 60_000).quiet_reason, recorder::QuietReason::WifiScan);
        assert!(s.link_lite().is_none());
    }
}
