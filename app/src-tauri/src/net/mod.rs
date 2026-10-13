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
    #[cfg(windows)]
    {
        let core = state.inner().clone();
        blocking(move || Ok(dnsctl::config_now(&core))).await
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
        // 1. Dienst muss bekannt sein
        let Some(p) = dns::provider(&provider) else {
            return Err(format!("Unbekannter DNS-Dienst: „{provider}“."));
        };
        // 2. Hauptverbindung + Prüfungen
        let core = state.inner().clone();
        let cfg = blocking({
            let core = core.clone();
            move || dnsctl::config_now(&core).ok_or_else(|| "Keine aktive Netzwerkverbindung gefunden.".to_string())
        })
        .await?;
        if !cfg.can_change {
            return Err(dnsctl::CANNOT_CHANGE.into());
        }
        // 3. Live-Prüfung (ohne Adminrechte)
        dnsctl::live_check(p).await?;
        // 4.–7. Sicherung, Admin-Helfer, Nachkontrolle, Zwischenspeicher leeren
        blocking(move || dnsctl::apply(&core, &provider, &cfg)).await
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
        blocking(move || dnsctl::restore(&core)).await
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
        let core = state.inner().clone();
        // DNS-Plan samt Live-Prüfung vorab (asynchron). Ein Fehler stoppt die Optimierungen nicht.
        let cfg = blocking({
            let core = core.clone();
            move || Ok(dnsctl::config_now(&core))
        })
        .await?;
        let plan = dnsctl::plan_dns(provider.as_deref(), cfg).await;
        blocking(move || dnsctl::auto_optimize(&core, plan, &tweaks)).await
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
        blocking(move || dnsctl::auto_restore(&core)).await
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

/// DNS-Server einer gesicherten Familie als `DnsOp`-Teil (`[]` = automatisch/DHCP).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn family_servers(f: &dns::FamilyBackup) -> Vec<String> {
    if f.dhcp {
        Vec::new()
    } else {
        f.servers.clone()
    }
}

/// `a` und `b` enthalten (ohne Reihenfolge) dieselben Adressen?
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn same_addrs(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|x| b.contains(x))
}

// =============================================================================================
// DNS einstellen / zurückstellen (nur Windows)
// =============================================================================================

#[cfg(windows)]
pub(crate) mod dnsctl {
    use std::net::{IpAddr, SocketAddr};

    use super::*;
    use crate::elevate::{self, DnsOp, ElevateError, ElevatedTask, Elevator, RealElevator};
    use crate::opt::boost::flush_dns;
    use crate::opt::tweaks::{self, SnapshotStore};
    use crate::opt::types::TweakError;
    use crate::util::now_ms;

    /// Meldung, wenn Pulsar den DNS hier nicht ändern kann.
    pub const CANNOT_CHANGE: &str =
        "Pulsar kann den DNS auf diesem System nicht einstellen. Dafür braucht es Windows 10 Version 2004 oder neuer.";

    /// Aktuelle DNS-Einstellung der Hauptverbindung (mit Sicherungs- und Änderbarkeits-Infos).
    pub fn config_now(core: &Shared) -> Option<DnsConfig> {
        let backups = read_dns_backups(core).unwrap_or_default();
        let raw = adapters::read_raw().unwrap_or_default();
        adapters::build_dns_config(
            &raw,
            adapters::is_static_dns,
            elevate::dns_api_available(),
            |id| backups.contains_key(id),
        )
    }

    /// Live-Prüfung: Der Dienst muss `cloudflare.com` innerhalb von 1,5 s beantworten (rcode 0).
    pub async fn live_check(p: &dns::Provider) -> CmdResult<()> {
        let primary: IpAddr = p.v4.0.parse().map_err(|_| "Interner Fehler: ungültige Dienst-Adresse.".to_string())?;
        let server = SocketAddr::new(primary, 53);
        match dns::query(server, "cloudflare.com", dns::QTYPE_A, dns::LIVE_TIMEOUT).await {
            Ok((resp, _)) if resp.rcode == 0 => Ok(()),
            _ => Err(format!("{} antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.", p.name)),
        }
    }

    /// Den aktuellen (fest eingetragenen) DNS-Zustand eines Adapters sichern.
    fn make_backup(adapter_id: &str, name: &str) -> dns::DnsBackup {
        let (v4_dhcp, v4, v6_dhcp, v6) = adapters::static_servers(adapter_id);
        dns::DnsBackup {
            adapter: name.to_string(),
            v4: dns::FamilyBackup { dhcp: v4_dhcp, servers: v4 },
            v6: dns::FamilyBackup { dhcp: v6_dhcp, servers: v6 },
            saved_at: now_ms(),
        }
    }

    /// Ist der gesicherte Zustand jetzt wieder eingestellt?
    pub(crate) fn restored(adapter_id: &str, b: &dns::DnsBackup) -> bool {
        let (_, v4, _, v6) = adapters::static_servers(adapter_id);
        let fam_ok = |now: &[String], want: &dns::FamilyBackup| {
            if want.dhcp {
                now.is_empty()
            } else {
                same_addrs(now, &want.servers)
            }
        };
        fam_ok(&v4, &b.v4) && fam_ok(&v6, &b.v6)
    }

    // -----------------------------------------------------------------------------------------
    // net_dns_apply
    // -----------------------------------------------------------------------------------------

    /// Schritte 4–7 von `net_dns_apply` (blockierend).
    pub fn apply(core: &Shared, provider: &str, cfg: &DnsConfig) -> CmdResult<DnsConfig> {
        let p = dns::provider(provider).ok_or_else(|| format!("Unbekannter DNS-Dienst: „{provider}“."))?;
        // 4. Sicherung anlegen (falls für diesen Adapter noch keine existiert)
        let mut backups = read_dns_backups(core)?;
        let new_backup = dns::insert_if_absent(&mut backups, &cfg.adapter_id, make_backup(&cfg.adapter_id, &cfg.adapter));
        if new_backup {
            write_dns_backups(core, &backups)?;
        }
        // 5. Admin-Helfer mit einem DnsOp (IPv6 nur, wenn der Adapter echte IPv6-DNS hat)
        let v6 = if cfg.ipv6_servers.is_empty() { None } else { Some(p.v6_servers()) };
        let op = DnsOp { adapter: cfg.adapter_id.clone(), v4: Some(p.v4_servers()), v6 };
        let outcome = RealElevator.run(&ElevatedTask { dns: vec![op], reg: Vec::new() });
        if let Err(e) = outcome {
            // Neu angelegte Sicherung wieder entfernen
            if new_backup {
                backups.remove(&cfg.adapter_id);
                let _ = write_dns_backups(core, &backups);
            }
            return Err(e.to_string());
        }
        // 6. Nachkontrolle ohne Adminrechte
        let (_, v4now, _, _) = adapters::static_servers(&cfg.adapter_id);
        if !same_addrs(&v4now, &p.v4_servers()) {
            return Err("Windows hat die DNS-Änderung nicht übernommen.".into());
        }
        // 7. Zwischenspeicher leeren, neues DnsConfig
        let _ = flush_dns();
        Ok(config_now(core).unwrap_or_default())
    }

    // -----------------------------------------------------------------------------------------
    // net_dns_restore
    // -----------------------------------------------------------------------------------------

    /// Einen `DnsOp` je gesichertem Adapter bauen; Einträge ohne vorhandenen Schlüssel still verwerfen.
    pub(crate) fn restore_ops(backups: &mut dns::DnsBackups) -> (Vec<DnsOp>, bool) {
        let mut pruned = false;
        backups.retain(|id, _| {
            let keep = adapters::interface_exists(id);
            pruned |= !keep;
            keep
        });
        let ops = backups
            .iter()
            .map(|(id, b)| DnsOp { adapter: id.clone(), v4: Some(family_servers(&b.v4)), v6: Some(family_servers(&b.v6)) })
            .collect();
        (ops, pruned)
    }

    pub fn restore(core: &Shared) -> CmdResult<Option<DnsConfig>> {
        let mut backups = read_dns_backups(core)?;
        if backups.is_empty() {
            return Err("Pulsar hat den DNS nicht geändert – es gibt nichts zurückzustellen.".into());
        }
        let (ops, pruned) = restore_ops(&mut backups);
        if pruned {
            write_dns_backups(core, &backups)?;
        }
        if ops.is_empty() {
            // Alle gesicherten Adapter gibt es nicht mehr – nichts zu tun
            return Ok(config_now(core));
        }
        RealElevator.run(&ElevatedTask { dns: ops, reg: Vec::new() }).map_err(|e| e.to_string())?;
        // Erfolgreich zurückgestellte Einträge entfernen
        let ids: Vec<String> = backups.keys().cloned().collect();
        for id in ids {
            if restored(&id, &backups[&id]) {
                backups.remove(&id);
            }
        }
        write_dns_backups(core, &backups)?;
        let _ = flush_dns();
        Ok(config_now(core))
    }

    // -----------------------------------------------------------------------------------------
    // Automatisch optimieren / zurückstellen
    // -----------------------------------------------------------------------------------------

    /// Was mit dem DNS geschehen soll (nach Live-Prüfung).
    pub enum DnsPlan {
        /// Kein Dienst angefragt.
        Skip,
        /// DNS bleibt; Grund für `dnsError`.
        Error(String),
        /// Diesen Dienst einstellen (mit der aktuellen Hauptverbindung).
        Apply(&'static dns::Provider, DnsConfig),
    }

    /// DNS-Plan samt Live-Prüfung bestimmen (asynchron, ohne Adminrechte).
    pub async fn plan_dns(provider: Option<&str>, cfg: Option<DnsConfig>) -> DnsPlan {
        let Some(id) = provider else { return DnsPlan::Skip };
        let Some(p) = dns::provider(id) else {
            return DnsPlan::Error(format!("Unbekannter DNS-Dienst: „{id}“."));
        };
        match cfg {
            None => DnsPlan::Error("Keine aktive Netzwerkverbindung gefunden.".into()),
            Some(c) if !c.can_change => DnsPlan::Error(CANNOT_CHANGE.into()),
            Some(c) => match live_check(p).await {
                Ok(()) => DnsPlan::Apply(p, c),
                Err(e) => DnsPlan::Error(e),
            },
        }
    }

    /// Doppelte und leere IDs entfernen.
    fn unique(ids: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for id in ids {
            let id = id.trim();
            if !id.is_empty() && !out.iter().any(|x| x == id) {
                out.push(id.to_string());
            }
        }
        out
    }

    /// Mindestens eine zurückgestellte/angewendete Optimierung wirkt erst nach Neustart?
    fn needs_restart(applied: &[String]) -> bool {
        applied.iter().any(|id| id == tweaks::NAGLE || id == tweaks::NET_THROTTLE)
    }

    pub fn auto_optimize(core: &Shared, plan: DnsPlan, tweak_ids: &[String]) -> CmdResult<AutoReport> {
        let mut report = AutoReport::default();
        let env = crate::opt::env();
        let mut store = SnapshotStore::load(core)?;

        // Optimierungen aufteilen: Admin-IDs über den Helfer, die anderen direkt
        let (admin, normal): (Vec<String>, Vec<String>) = unique(tweak_ids).into_iter().partition(|id| tweaks::is_admin_id(id));
        for id in normal {
            match tweaks::apply_one(&id, true, &env, &mut store) {
                Ok(()) => report.applied.push(id),
                Err(error) => report.failed.push(TweakError { id, error }),
            }
        }
        let batch = tweaks::prepare_admin(&admin, true, &env, &mut store);

        // DNS vorbereiten
        let mut backups = read_dns_backups(core)?;
        let mut dns_new_backup = false;
        let mut dns_ops: Vec<DnsOp> = Vec::new();
        let mut dns_target: Option<(String, Vec<String>)> = None;
        match plan {
            DnsPlan::Skip => {}
            DnsPlan::Error(e) => report.dns_error = Some(e),
            DnsPlan::Apply(p, cfg) => {
                dns_new_backup = dns::insert_if_absent(&mut backups, &cfg.adapter_id, make_backup(&cfg.adapter_id, &cfg.adapter));
                if dns_new_backup {
                    write_dns_backups(core, &backups)?;
                }
                let v6 = if cfg.ipv6_servers.is_empty() { None } else { Some(p.v6_servers()) };
                dns_ops.push(DnsOp { adapter: cfg.adapter_id.clone(), v4: Some(p.v4_servers()), v6 });
                dns_target = Some((cfg.adapter_id.clone(), p.v4_servers()));
            }
        }

        // Alles mit EINER Windows-Abfrage
        let task = ElevatedTask { dns: dns_ops, reg: batch.reg_ops() };
        let outcome = if task.is_empty() { Ok(()) } else { RealElevator.run(&task) };

        let (applied, failed) = batch.settle(&outcome, &env, &mut store);
        report.applied.extend(applied);
        report.failed.extend(failed);

        if let Err(ElevateError::Declined) = &outcome {
            report.declined = true;
            if let Some((adapter_id, _)) = &dns_target {
                if dns_new_backup {
                    backups.remove(adapter_id);
                    let _ = write_dns_backups(core, &backups);
                }
            }
        } else if let Some((adapter_id, want_v4)) = &dns_target {
            let (_, v4now, _, _) = adapters::static_servers(adapter_id);
            if same_addrs(&v4now, want_v4) {
                report.dns_changed = true;
            } else {
                report.dns_error = report.dns_error.or_else(|| Some("Windows hat die DNS-Änderung nicht übernommen.".into()));
            }
            let _ = flush_dns();
        }

        report.restart = needs_restart(&report.applied);
        report.dns = config_now(core);
        Ok(report)
    }

    pub fn auto_restore(core: &Shared) -> CmdResult<AutoReport> {
        let mut report = AutoReport::default();
        let env = crate::opt::env();
        let mut store = SnapshotStore::load(core)?;

        // Nur nagle/netThrottle zurückstellen (die anderen über opt_revert_all)
        let admin: Vec<String> = store.ids().into_iter().filter(|id| tweaks::is_admin_id(id)).collect();
        let batch = tweaks::prepare_admin(&admin, false, &env, &mut store);

        let mut backups = read_dns_backups(core)?;
        let (dns_ops, pruned) = restore_ops(&mut backups);
        if pruned {
            write_dns_backups(core, &backups)?;
        }

        let task = ElevatedTask { dns: dns_ops, reg: batch.reg_ops() };
        let outcome = if task.is_empty() { Ok(()) } else { RealElevator.run(&task) };

        let (applied, failed) = batch.settle(&outcome, &env, &mut store);
        report.applied.extend(applied);
        report.failed.extend(failed);

        if let Err(ElevateError::Declined) = &outcome {
            report.declined = true;
        } else if !backups.is_empty() {
            let ids: Vec<String> = backups.keys().cloned().collect();
            for id in ids {
                if restored(&id, &backups[&id]) {
                    backups.remove(&id);
                    report.dns_changed = true;
                }
            }
            write_dns_backups(core, &backups)?;
            let _ = flush_dns();
        }

        report.restart = needs_restart(&report.applied);
        report.dns = config_now(core);
        Ok(report)
    }
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
