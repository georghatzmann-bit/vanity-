//! Umfang eines Aussetzers (`OutageScope`): PC, Heimnetz, Internet oder nur das Messziel. Vertrag:
//! `docs/API.md`, „Anbieter-Protokoll“ („Umfang eines Aussetzers“).
//!
//! Ablauf: Beim dritten Verlust in Folge fordert der Recorder eine Prüfung an
//! ([`ScopeRequest`]); der Hook startet [`check`] per `spawn` (höchstens 2 s). Die Prüfung ermittelt
//! die Hauptverbindung frisch, liest `GetIfEntry2` und schickt je 2 ICMP-Echos an das Gateway
//! (600 ms) und an zwei unabhängige Internet-Hosts (800 ms). Die Entscheidung selbst ist die reine
//! Funktion [`classify`].
//!
//! Die Einzelergebnisse (`detail.checks` des `outage`-Eintrags) legt [`check`] zusätzlich in einer
//! kleinen Ablage je Aussetzer ab ([`take_checks`]); der Recorder holt sie in `on_scope` ab. So
//! bleibt die vorgegebene Schnittstelle `Recorder::on_scope(outage_t, scope)` unverändert.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use super::hist_types::OutageScope;
use super::ifstats::OperStatus;
use super::link::PrimaryLinkLite;
use crate::error::LockExt;
use crate::state::Shared;

/// Unabhängige Internet-Hosts der Umfangsprüfung.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXTERNAL_HOSTS: [[u8; 4]; 2] = [[1, 1, 1, 1], [9, 9, 9, 9]];
/// Gesamtzeit der Umfangsprüfung (ms).
pub const SCOPE_TIMEOUT_MS: u64 = 2000;
/// Zeitlimit je ICMP-Echo an das Gateway (ms).
#[cfg_attr(not(windows), allow(dead_code))]
pub const GATEWAY_TIMEOUT_MS: u64 = 600;
/// Zeitlimit je ICMP-Echo an einen externen Host (ms).
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXTERNAL_TIMEOUT_MS: u64 = 800;
/// Hauptverbindung frisch ermitteln: höchstens so lange (ms) – danach gilt die Prüfung als
/// unvollständig (`unknown`).
pub const LINK_TIMEOUT_MS: u64 = 800;

/// Anforderung des Recorders beim dritten Verlust in Folge (höchstens eine je Aussetzer).
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeRequest {
    /// Beginn des Aussetzers (ms) – damit das Ergebnis dem richtigen Ereignis zugeordnet wird
    pub outage_t: i64,
    /// Hauptverbindung zu Beginn des Aussetzers
    pub link_start: Option<PrimaryLinkLite>,
    /// Router-Grundwert vorhanden (Router antwortet sonst)
    pub gateway_base: Option<f64>,
    /// IPv4 des Hauptziels (dieselbe wie `SnapshotRequest.dst`, `0.0.0.0` → `None`): Die
    /// Hauptverbindung wird für dieses Ziel ermittelt wie beim Hook – sonst wirkt ein
    /// Split-Tunnel-VPN wie ein Verbindungswechsel.
    pub dst: Option<Ipv4Addr>,
}

/// Messwerte der Umfangsprüfung (Eingabe der reinen Entscheidung).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScopeInput {
    /// `GetIfEntry2` der Hauptverbindung (`None` = nicht lesbar)
    pub status: Option<OperStatus>,
    /// Hauptverbindung zu Beginn und jetzt (frisch ermittelt)
    pub link_start: Option<PrimaryLinkLite>,
    pub link_now: Option<PrimaryLinkLite>,
    /// Router antwortet (`None` = nicht geprüft/kein Gateway)
    pub gateway_ok: Option<bool>,
    pub gateway_base: Option<f64>,
    /// Je externem Host: hat geantwortet
    pub external_ok: Vec<bool>,
    /// Prüfung lief ins Zeitlimit bzw. ist hier nicht möglich
    pub incomplete: bool,
}

/// Einzelergebnisse für `detail.checks` (`null` = nicht geprüft bzw. nicht lesbar).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ScopeChecks {
    /// Verbindung steht (`OperStatus` und `MediaConnectState`)
    pub link: Option<bool>,
    /// Router hat geantwortet
    pub gw: Option<bool>,
    /// Mindestens ein externer Host hat geantwortet
    pub ext: Option<bool>,
}

impl ScopeChecks {
    pub fn from_input(input: &ScopeInput) -> Self {
        ScopeChecks {
            link: input.status.map(|s| s.connected()),
            gw: input.gateway_ok,
            ext: (!input.external_ok.is_empty()).then(|| input.external_ok.iter().any(|ok| *ok)),
        }
    }
}

/// Hat sich die Hauptverbindung während des Aussetzers geändert (anderer Adapter, anderes Netz,
/// VPN verbunden/getrennt)? Nur vergleichbar, wenn beide bekannt sind.
pub fn link_changed(start: Option<&PrimaryLinkLite>, now: Option<&PrimaryLinkLite>) -> bool {
    match (start, now) {
        (Some(a), Some(b)) => a.luid != b.luid || a.net_id != b.net_id || a.vpn != b.vpn,
        _ => false,
    }
}

/// Reine Entscheidung nach der Vertragsliste:
/// - `pc`: Verbindung getrennt, keine Hauptverbindung/kein Gateway, Hauptverbindung oder Netz
///   gewechselt;
/// - `unknown`: Prüfung unvollständig bzw. nicht möglich;
/// - `homeNetwork`: Router stumm, obwohl er sonst antwortet (Grundwert vorhanden);
/// - `targetOnly`: mindestens ein externer Host antwortet;
/// - `internet`: Router ok bzw. nicht bewertbar und beide externen Hosts stumm.
pub fn classify(input: &ScopeInput) -> OutageScope {
    if input.status.is_some_and(|s| !s.connected()) {
        return OutageScope::Pc;
    }
    if input.incomplete {
        return OutageScope::Unknown;
    }
    let Some(now) = input.link_now.as_ref() else { return OutageScope::Pc };
    if now.gateway.is_none() || link_changed(input.link_start.as_ref(), Some(now)) {
        return OutageScope::Pc;
    }
    if input.gateway_ok == Some(false) && input.gateway_base.is_some() {
        return OutageScope::HomeNetwork;
    }
    if input.external_ok.is_empty() {
        return OutageScope::Unknown;
    }
    if input.external_ok.iter().any(|ok| *ok) {
        OutageScope::TargetOnly
    } else {
        OutageScope::Internet
    }
}

// ---------------------------------------------------------------------------------------------
// Ablage der Einzelergebnisse (je Aussetzer, höchstens wenige Einträge)
// ---------------------------------------------------------------------------------------------

/// So viele Ergebnisse bleiben höchstens liegen (nie abgeholte fallen vorne heraus).
const CHECKS_KEEP: usize = 8;

static CHECKS: Mutex<Vec<(i64, ScopeChecks)>> = Mutex::new(Vec::new());

/// Einzelergebnisse für den Aussetzer ablegen, der bei `outage_t` begann.
pub fn store_checks(outage_t: i64, checks: ScopeChecks) {
    let mut list = CHECKS.lock_safe();
    list.retain(|(t, _)| *t != outage_t);
    list.push((outage_t, checks));
    while list.len() > CHECKS_KEEP {
        list.remove(0);
    }
}

/// Einzelergebnisse abholen (einmalig; `None` = keine Prüfung abgeschlossen, z. B. Zeitlimit).
pub fn take_checks(outage_t: i64) -> Option<ScopeChecks> {
    let mut list = CHECKS.lock_safe();
    let pos = list.iter().position(|(t, _)| *t == outage_t)?;
    Some(list.remove(pos).1)
}

// ---------------------------------------------------------------------------------------------
// Prüfung (Netz)
// ---------------------------------------------------------------------------------------------

/// Antwortet `ip` auf mindestens eines von zwei gleichzeitig gesendeten ICMP-Echos?
#[cfg_attr(not(windows), allow(dead_code))]
async fn answers(ip: Ipv4Addr, timeout_ms: u64) -> bool {
    let timeout = Duration::from_millis(timeout_ms);
    let (a, b) = tokio::join!(super::ping::icmp_probe(IpAddr::V4(ip), timeout), super::ping::icmp_probe(IpAddr::V4(ip), timeout));
    a.is_some() || b.is_some()
}

/// Hauptverbindung für `dst` frisch ermitteln (dieselbe Ziel-IPv4 wie der Hook; blockierend in
/// `spawn_blocking`, höchstens [`LINK_TIMEOUT_MS`]) und – wenn gerade niemand anderes erneuert – in
/// `NetState.link` ablegen.
/// `None` = Zeitlimit bzw. Fehler (die Hauptverbindung selbst kann fehlen: `Some(None)`).
#[cfg_attr(not(windows), allow(dead_code))]
async fn fresh_link(core: &Shared, dst: Option<Ipv4Addr>) -> Option<Option<PrimaryLinkLite>> {
    use std::sync::atomic::Ordering;
    let now = crate::util::now_ms();
    let job = tauri::async_runtime::spawn_blocking(move || super::link::refresh(dst, now));
    let found = match tokio::time::timeout(Duration::from_millis(LINK_TIMEOUT_MS), job).await {
        Ok(Ok(found)) => found,
        _ => return None,
    };
    let lite = found.as_ref().map(super::link::PrimaryLink::lite);
    if core.net.link_refreshing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        let luid = found.as_ref().map(|l| l.luid);
        *core.net.link.lock_safe() = found;
        core.net.load.lock_safe().set_luid(luid);
        core.net.link_refreshing.store(false, Ordering::SeqCst);
    }
    Some(lite)
}

/// Messwerte sammeln (Windows).
#[cfg(windows)]
async fn gather(core: &Shared, req: &ScopeRequest) -> ScopeInput {
    let mut input = ScopeInput { link_start: req.link_start.clone(), gateway_base: req.gateway_base, ..Default::default() };
    let Some(link_now) = fresh_link(core, req.dst).await else {
        input.incomplete = true;
        return input;
    };
    if let Some(l) = link_now.as_ref().or(req.link_start.as_ref()) {
        let luid = l.luid;
        input.status = tauri::async_runtime::spawn_blocking(move || super::ifstats::read_if(luid).map(|r| r.status)).await.ok().flatten();
    }
    let gateway = link_now.as_ref().and_then(|l| l.gateway);
    let gw = async move {
        match gateway {
            Some(ip) => Some(answers(ip, GATEWAY_TIMEOUT_MS).await),
            None => None,
        }
    };
    let [a, b] = EXTERNAL_HOSTS;
    let (gateway_ok, ext_a, ext_b) =
        tokio::join!(gw, answers(Ipv4Addr::from(a), EXTERNAL_TIMEOUT_MS), answers(Ipv4Addr::from(b), EXTERNAL_TIMEOUT_MS));
    input.link_now = link_now;
    input.gateway_ok = gateway_ok;
    input.external_ok = vec![ext_a, ext_b];
    input
}

/// Außerhalb von Windows: keine Prüfung möglich (→ `unknown`).
#[cfg(not(windows))]
async fn gather(core: &Shared, req: &ScopeRequest) -> ScopeInput {
    let _ = core;
    ScopeInput { link_start: req.link_start.clone(), gateway_base: req.gateway_base, incomplete: true, ..Default::default() }
}

/// Umfangsprüfung ausführen (≤ 2 s, vom Hook per `spawn` gestartet). Nie ein Fehler: Zeitlimit oder
/// kein Windows → `unknown`. Die Einzelergebnisse landen in der Ablage ([`take_checks`]).
pub async fn check(core: Shared, req: ScopeRequest) -> OutageScope {
    match tokio::time::timeout(Duration::from_millis(SCOPE_TIMEOUT_MS), gather(&core, &req)).await {
        Ok(input) => {
            store_checks(req.outage_t, ScopeChecks::from_input(&input));
            classify(&input)
        }
        Err(_) => OutageScope::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::link::LinkKind;

    fn link(luid: u64, net_id: &str, gateway: bool, vpn: bool) -> PrimaryLinkLite {
        PrimaryLinkLite {
            luid,
            if_index: 7,
            kind: LinkKind::Ethernet,
            gateway: gateway.then(|| Ipv4Addr::new(192, 168, 178, 1)),
            net_id: net_id.into(),
            vpn,
            at: 0,
        }
    }

    const UP: OperStatus = OperStatus { up: true, media_connected: true };

    fn base() -> ScopeInput {
        ScopeInput {
            status: Some(UP),
            link_start: Some(link(1, "abc", true, false)),
            link_now: Some(link(1, "abc", true, false)),
            gateway_ok: Some(true),
            gateway_base: Some(1.2),
            external_ok: vec![false, false],
            incomplete: false,
        }
    }

    #[test]
    fn outage_scope_gateway_down() {
        let mut i = base();
        i.gateway_ok = Some(false);
        assert_eq!(classify(&i), OutageScope::HomeNetwork);
        // Router antwortet nie (kein Grundwert) → nicht bewertbar, entscheidet über die Hosts
        i.gateway_base = None;
        assert_eq!(classify(&i), OutageScope::Internet);
        i.external_ok = vec![true, false];
        assert_eq!(classify(&i), OutageScope::TargetOnly);
        // Router stumm mit Grundwert schlägt die externen Hosts
        i.gateway_base = Some(0.9);
        assert_eq!(classify(&i), OutageScope::HomeNetwork);
    }

    #[test]
    fn scope_internet_vs_target_only() {
        let mut i = base();
        assert_eq!(classify(&i), OutageScope::Internet);
        i.external_ok = vec![false, true];
        assert_eq!(classify(&i), OutageScope::TargetOnly);
        i.external_ok = vec![true, true];
        assert_eq!(classify(&i), OutageScope::TargetOnly);
        // Gateway nicht geprüft (None) zählt wie „ok“ (nicht bewertbar)
        i.gateway_ok = None;
        i.external_ok = vec![false, false];
        assert_eq!(classify(&i), OutageScope::Internet);
        // Keine externen Ergebnisse → unklar
        i.external_ok = vec![];
        assert_eq!(classify(&i), OutageScope::Unknown);
        // Zeitlimit / kein Windows
        let mut j = base();
        j.incomplete = true;
        assert_eq!(classify(&j), OutageScope::Unknown);
    }

    #[test]
    fn scope_link_change_is_pc() {
        let mut i = base();
        i.link_now = Some(link(2, "abc", true, false));
        assert_eq!(classify(&i), OutageScope::Pc, "anderer Adapter");
        i.link_now = Some(link(1, "def", true, false));
        assert_eq!(classify(&i), OutageScope::Pc, "anderes Netz (WLAN-Wechsel)");
        i.link_now = Some(link(1, "abc", true, true));
        assert_eq!(classify(&i), OutageScope::Pc, "VPN verbunden");
        i.link_now = Some(link(1, "abc", false, false));
        assert_eq!(classify(&i), OutageScope::Pc, "kein Gateway");
        i.link_now = None;
        assert_eq!(classify(&i), OutageScope::Pc, "keine Hauptverbindung");
        // Verbindung getrennt – auch wenn die Prüfung sonst unvollständig ist
        let mut j = base();
        j.status = Some(OperStatus { up: true, media_connected: false });
        assert_eq!(classify(&j), OutageScope::Pc);
        j.incomplete = true;
        assert_eq!(classify(&j), OutageScope::Pc);
        j.status = Some(OperStatus { up: false, media_connected: true });
        assert_eq!(classify(&j), OutageScope::Pc);
        // Unbekannter Beginn ist kein Wechsel
        let mut k = base();
        k.link_start = None;
        assert_eq!(classify(&k), OutageScope::Internet);
        assert!(!link_changed(None, k.link_now.as_ref()));
    }

    #[test]
    fn checks_from_input_and_store() {
        let mut i = base();
        i.external_ok = vec![false, true];
        assert_eq!(ScopeChecks::from_input(&i), ScopeChecks { link: Some(true), gw: Some(true), ext: Some(true) });
        let empty = ScopeInput { incomplete: true, ..Default::default() };
        assert_eq!(ScopeChecks::from_input(&empty), ScopeChecks::default());
        let v = serde_json::to_value(ScopeChecks { link: Some(false), gw: None, ext: Some(false) }).unwrap();
        assert_eq!(v, serde_json::json!({ "link": false, "gw": null, "ext": false }));

        // Eindeutige Zeiten (die Ablage ist prozessweit)
        let t = 9_000_000_000_001;
        store_checks(t, ScopeChecks { link: Some(true), ..Default::default() });
        assert_eq!(take_checks(t), Some(ScopeChecks { link: Some(true), ..Default::default() }));
        assert_eq!(take_checks(t), None, "nur einmal abholbar");
    }
}
