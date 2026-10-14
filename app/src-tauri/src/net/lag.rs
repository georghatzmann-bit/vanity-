//! Lag-Detektiv: Ausreißer-Regel, Momentaufnahme und eingeschätzte Ursache. Vertrag:
//! `docs/API.md`, „Lag-Detektiv“.
//!
//! - Ausreißer-Regel gleich `countSpikes`/`isLiveSpike` in `app/src/lib/grade.ts` (gemeinsame
//!   Prüfdaten `app/src/lib/fixtures/spikes.json`).
//! - Momentaufnahme ([`run_snapshot`]): Ziel noch einmal, Teilroute TTL 1–3, Router, WLAN,
//!   Datenverkehr und CPU – alles gleichzeitig und mit Zeitlimit, nie ein Fehler.
//! - Ursache ([`classify_cause`]): reine Tabelle, erste passende Zeile gewinnt. Die Ursache ist
//!   eine **Einschätzung**; ohne saubere Messung heißt sie „unklar“.

use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::hist_types::TargetKind;
use super::link::{self, LinkKind};
use super::ping;
use super::quickhops::{self, QuickHop, Zone};
use super::types::{PingMethod, PingTarget};
use crate::error::LockExt;
use crate::state::Shared;

// =============================================================================================
// Ausreißer-Regel
// =============================================================================================

/// Live-Fenster: die letzten höchstens 60 Werte des Hauptziels (einschließlich des neuen Werts).
pub const LIVE_WINDOW: usize = 60;
/// Beurteilt wird erst ab so vielen Antworten im Fenster.
pub const LIVE_MIN_ANSWERS: usize = 10;

/// Median (gerade Anzahl → Mittel der beiden mittleren); `None` bei leerer Liste.
fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let mid = v.len() / 2;
    Some(if v.len().is_multiple_of(2) { (v[mid - 1] + v[mid]) / 2.0 } else { v[mid] })
}

/// Grenze für Ausreißer über die Antworten `ok`: `max(2 × Median, Median + 40)`.
pub fn spike_limit(ok: &[f64]) -> Option<f64> {
    median(ok).map(|base| (2.0 * base).max(base + 40.0))
}

/// Median der Antworten einer Messreihe (Verluste zählen nicht).
pub fn baseline(rtts: &[Option<f64>]) -> Option<f64> {
    let ok: Vec<f64> = rtts.iter().flatten().copied().collect();
    median(&ok)
}

/// Anzahl Ausreißer einer Messreihe (`rtt > limit`, echt größer; Verluste nie). Gleich
/// `countSpikes` in `grade.ts` (Prüfdaten); im Backend zählen die Stunden-Summen live.
#[cfg_attr(not(test), allow(dead_code))]
pub fn count_spikes(rtts: &[Option<f64>]) -> u32 {
    let ok: Vec<f64> = rtts.iter().flatten().copied().collect();
    let Some(limit) = spike_limit(&ok) else { return 0 };
    ok.iter().filter(|v| **v > limit).count() as u32
}

/// Live-Regel: Ist der neueste Wert (`window` endet mit ihm) ein Ausreißer? Nur die letzten 60
/// Werte zählen; beurteilt wird erst ab 10 Antworten.
pub fn is_live_spike(window: &[Option<f64>]) -> bool {
    let start = window.len().saturating_sub(LIVE_WINDOW);
    let w = &window[start..];
    let Some(Some(last)) = w.last() else { return false };
    let ok: Vec<f64> = w.iter().flatten().copied().collect();
    if ok.len() < LIVE_MIN_ANSWERS {
        return false;
    }
    spike_limit(&ok).is_some_and(|limit| *last > limit)
}

// =============================================================================================
// Typen
// =============================================================================================

/// Eingeschätzte Ursache eines Ausreißers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LagCause {
    Wifi,
    Router,
    Isp,
    Internet,
    LocalTraffic,
    Unknown,
}

impl LagCause {
    pub const ALL: [LagCause; 6] =
        [LagCause::Wifi, LagCause::Router, LagCause::Isp, LagCause::Internet, LagCause::LocalTraffic, LagCause::Unknown];

    /// Text wie in Datenbank und JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            LagCause::Wifi => "wifi",
            LagCause::Router => "router",
            LagCause::Isp => "isp",
            LagCause::Internet => "internet",
            LagCause::LocalTraffic => "localTraffic",
            LagCause::Unknown => "unknown",
        }
    }

    /// Text → Wert (`None` bei unbekanntem Text).
    pub fn parse(s: &str) -> Option<Self> {
        LagCause::ALL.into_iter().find(|c| c.as_str() == s)
    }
}

/// Begründung einer Einschätzung (Texte `lag.reason.*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    TrafficHigh,
    SpikeGone,
    RssiLow,
    SignalDrop,
    GatewaySlow,
    GatewayLost,
    IspHopSlow,
    IspHopOnly,
    LineBusyPossible,
    PathOk,
    VpnActive,
    WifiLocked,
    ConnectionOther,
    NoHops,
    NoBaseline,
    NoTargetCheck,
    SnapshotsOff,
    CpuHigh,
}

impl Reason {
    /// Alle Werte in Vertragsreihenfolge (Tests; Texte `lag.reason.*`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [Reason; 18] = [
        Reason::TrafficHigh,
        Reason::SpikeGone,
        Reason::RssiLow,
        Reason::SignalDrop,
        Reason::GatewaySlow,
        Reason::GatewayLost,
        Reason::IspHopSlow,
        Reason::IspHopOnly,
        Reason::LineBusyPossible,
        Reason::PathOk,
        Reason::VpnActive,
        Reason::WifiLocked,
        Reason::ConnectionOther,
        Reason::NoHops,
        Reason::NoBaseline,
        Reason::NoTargetCheck,
        Reason::SnapshotsOff,
        Reason::CpuHigh,
    ];
}

/// WLAN-Werte in der Momentaufnahme.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapWifi {
    /// Qualität 0–100
    pub signal: u32,
    pub rssi: Option<i32>,
    /// "2.4" | "5" | "6"
    pub band: Option<String>,
}

/// WLAN-Zustand in der Momentaufnahme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnapWifiState {
    #[serde(rename = "ok")]
    Ok,
    /// 24H2-Standortsperre
    #[serde(rename = "locked")]
    Locked,
    /// Kein WLAN verbunden
    #[serde(rename = "none")]
    NoWifi,
}

/// Momentaufnahme (alle Teile mit Zeitlimit; fehlende Teile bleiben `None`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LagSnapshot {
    pub at: i64,
    /// Art der Hauptverbindung
    pub connection: Option<LinkKind>,
    pub via_vpn: bool,
    /// Ziel bei der Momentaufnahme: Median der Antworten von 3 Messungen (`None` = nicht gemessen
    /// oder keine Antwort)
    pub target_ms: Option<f64>,
    /// Verluste der 3 Messungen (`None` = nicht gemessen)
    pub target_lost: Option<u32>,
    /// TTL 1–3, auch ohne Antwort
    pub hops: Vec<QuickHop>,
    pub gateway_ms: Option<f64>,
    pub gateway_base_ms: Option<f64>,
    pub wifi: Option<SnapWifi>,
    pub wifi_state: Option<SnapWifiState>,
    pub signal_base: Option<f64>,
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
    pub traffic_base_mbps: Option<f64>,
    pub ref_down_mbps: Option<f64>,
    pub ref_up_mbps: Option<f64>,
    /// CPU-Last %
    pub cpu: Option<f64>,
    pub took_ms: u64,
}

impl LagSnapshot {
    /// Form bei `lag.snapshots = false`: alles `None`, keine Stationen, kein VPN, Dauer 0.
    pub fn off(at: i64) -> Self {
        LagSnapshot { at, ..Default::default() }
    }
}

/// Ergebnis einer Momentaufnahme mit Einschätzung (`net_lag_snapshot`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LagCheck {
    pub at: i64,
    pub cause: LagCause,
    pub cpu_high: bool,
    pub reasons: Vec<Reason>,
    pub snapshot: LagSnapshot,
}

/// Event `net://lag` und Eintrag von `net_lag_recent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LagEvent {
    #[serde(flatten)]
    pub check: LagCheck,
    pub target_id: String,
    pub target_label: String,
    pub target_kind: TargetKind,
    /// Antwortzeit des Ausreißers (ms)
    pub rtt: f64,
    /// Median des Fensters
    pub baseline: f64,
    /// Ausreißer-Grenze
    pub limit: f64,
    /// Ausreißer in diesen 10 s
    pub count: u32,
    pub session_id: Option<i64>,
}

/// Eingabe der Ursachen-Entscheidung (rein).
#[derive(Debug, Clone, PartialEq)]
pub struct LagInput {
    /// Momentaufnahme inklusive Grundwerten (`baseMs`, `gatewayBaseMs`, `signalBase`, Bezug)
    pub snapshot: LagSnapshot,
    /// Ausreißer-Grenze (`None` = Momentaufnahme auf Wunsch, Ziel nicht bewertbar)
    pub limit: Option<f64>,
    /// `lag.snapshots` aus den Einstellungen
    pub snapshots_enabled: bool,
    /// Bufferbloat des letzten Speedtests der letzten 30 Tage (`None` = keiner)
    pub last_bufferbloat_ms: Option<f64>,
}

// =============================================================================================
// Ursachen-Entscheidung
// =============================================================================================

/// Messungen des Ziels in der Momentaufnahme.
pub const TARGET_PROBES: u32 = 3;
/// WLAN schwach unter diesem RSSI (dBm, echt kleiner).
pub const RSSI_LOW_DBM: i32 = -70;
/// Signal-Einbruch: Qualität mindestens so viel unter dem Grundwert.
pub const SIGNAL_DROP: f64 = 15.0;
/// Router ohne Grundwert ist auffällig über diesem Wert (ms).
pub const GATEWAY_ABS_MS: f64 = 30.0;
/// Router mit Grundwert: auffällig über `max(2 × Grundwert, Grundwert + 15)`.
pub const GATEWAY_PLUS_MS: f64 = 15.0;
/// Anbieter-Station auffällig über Grundwert + 30 ms …
pub const ISP_HOP_PLUS_MS: f64 = 30.0;
/// … und jede spätere Station über ihrem Grundwert + 20 ms („bleibt erhöht“).
pub const LATER_HOP_PLUS_MS: f64 = 20.0;
/// „Leitung voll“: mehr als 70 % des Bezugs.
pub const TRAFFIC_SHARE: f64 = 0.7;
/// Ohne Bezug: mehr als `max(5 × Grundwert, 20 Mbit/s)`.
pub const TRAFFIC_FACTOR: f64 = 5.0;
pub const TRAFFIC_MIN_MBPS: f64 = 20.0;
/// `lineBusyPossible`, wenn der letzte Speedtest mindestens so viel Bufferbloat hatte (ms).
pub const BUFFERBLOAT_BUSY_MS: f64 = 60.0;
/// `cpuHigh` ab dieser CPU-Last (%).
pub const CPU_HIGH: f64 = 90.0;

/// Zustand des Ziels bei der Momentaufnahme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetState {
    /// Ohne Grenze (auf Wunsch) oder ohne Zielmessung (keine IPv4, Namensauflösung zu langsam)
    NotChecked,
    /// `targetLost >= 2` oder `targetMs > limit`
    Disturbed,
    /// Mindestens 2 Antworten und `targetMs <= limit` – der Ausreißer war schon vorbei
    Normal,
    /// Weder noch (z. B. 1 Verlust und keine verwertbare Zeit)
    Unclear,
}

fn target_state(s: &LagSnapshot, limit: Option<f64>) -> TargetState {
    let (Some(limit), Some(lost)) = (limit, s.target_lost) else { return TargetState::NotChecked };
    let answers = TARGET_PROBES.saturating_sub(lost);
    if lost >= 2 || s.target_ms.is_some_and(|ms| ms > limit) {
        TargetState::Disturbed
    } else if answers >= 2 && s.target_ms.is_some_and(|ms| ms <= limit) {
        TargetState::Normal
    } else {
        TargetState::Unclear
    }
}

/// Zustand des Routers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouterState {
    /// Auffällig (Grund `gatewaySlow`/`gatewayLost`)
    Bad(Reason),
    /// Unauffällig: Wert vorhanden und nicht auffällig
    Ok,
    /// Nicht bewertbar (hat nie geantwortet, kein Grundwert)
    Unknown,
}

fn router_state(gw: Option<f64>, base: Option<f64>) -> RouterState {
    match (gw, base) {
        (None, Some(_)) => RouterState::Bad(Reason::GatewayLost),
        (Some(g), Some(b)) if g > (2.0 * b).max(b + GATEWAY_PLUS_MS) => RouterState::Bad(Reason::GatewaySlow),
        (Some(_), Some(_)) => RouterState::Ok,
        (Some(g), None) if g > GATEWAY_ABS_MS => RouterState::Bad(Reason::GatewaySlow),
        (Some(_), None) => RouterState::Ok,
        (None, None) => RouterState::Unknown,
    }
}

/// Zustand der Anbieter-Stationen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IspState {
    /// Eine Station deutlich erhöht und die Verzögerung bleibt bis zum (noch gestörten) Ziel
    Bad,
    /// Eine Station erhöht, danach wieder normal (meist nur nachrangig beantwortetes ICMP)
    HopOnly,
    /// Mindestens eine Anbieter-Station mit Antwort und Grundwert, keine erhöht
    Ok,
    /// Keine Anbieter-Station mit Antwort und Grundwert
    Unknown,
}

fn isp_state(hops: &[QuickHop], target_disturbed: bool) -> IspState {
    let rated = |h: &QuickHop| h.rtt.zip(h.base_ms);
    let isp: Vec<usize> = hops.iter().enumerate().filter(|(_, h)| h.zone == Some(Zone::Isp) && rated(h).is_some()).map(|(i, _)| i).collect();
    if isp.is_empty() {
        return IspState::Unknown;
    }
    let slow: Vec<usize> = isp.into_iter().filter(|i| rated(&hops[*i]).is_some_and(|(rtt, base)| rtt > base + ISP_HOP_PLUS_MS)).collect();
    if slow.is_empty() {
        return IspState::Ok;
    }
    let persists = |k: usize| hops[k + 1..].iter().filter_map(rated).all(|(rtt, base)| rtt > base + LATER_HOP_PLUS_MS);
    if target_disturbed && slow.iter().any(|k| persists(*k)) {
        IspState::Bad
    } else {
        IspState::HopOnly
    }
}

/// Datenverkehr vor dem Ausreißer hoch? Mit Bezug: mehr als 70 % von Download bzw. Upload; ohne
/// Bezug: `rx + tx > max(5 × Grundwert, 20)`.
fn traffic_high(s: &LagSnapshot) -> bool {
    let over = |v: Option<f64>, r: Option<f64>| matches!((v, r), (Some(v), Some(r)) if r > 0.0 && v > TRAFFIC_SHARE * r);
    if s.ref_down_mbps.is_some() || s.ref_up_mbps.is_some() {
        return over(s.rx_mbps, s.ref_down_mbps) || over(s.tx_mbps, s.ref_up_mbps);
    }
    if s.rx_mbps.is_none() && s.tx_mbps.is_none() {
        return false;
    }
    let sum = s.rx_mbps.unwrap_or(0.0) + s.tx_mbps.unwrap_or(0.0);
    sum > (TRAFFIC_FACTOR * s.traffic_base_mbps.unwrap_or(0.0)).max(TRAFFIC_MIN_MBPS)
}

/// `cpuHigh` = CPU-Last ≥ 90 % (nur Hinweis, keine Ursache).
pub fn cpu_high(cpu: Option<f64>) -> bool {
    cpu.is_some_and(|c| c >= CPU_HIGH)
}

/// Ursachen-Entscheidung (rein, erste passende Zeile der Vertragstabelle gewinnt). `cpuHigh` kommt
/// als zusätzlicher Grund ans Ende.
pub fn classify_cause(input: &LagInput) -> (LagCause, Vec<Reason>) {
    let s = &input.snapshot;
    let (cause, mut reasons) = classify_rows(input);
    if cpu_high(s.cpu) && !reasons.contains(&Reason::CpuHigh) {
        reasons.push(Reason::CpuHigh);
    }
    (cause, reasons)
}

fn classify_rows(input: &LagInput) -> (LagCause, Vec<Reason>) {
    use LagCause as C;
    use Reason as R;
    let s = &input.snapshot;

    // 0: Momentaufnahmen aus · VPN
    if !input.snapshots_enabled {
        return (C::Unknown, vec![R::SnapshotsOff]);
    }
    if s.via_vpn {
        return (C::Unknown, vec![R::VpnActive]);
    }
    // 1: Datenverkehr auf diesem PC (vor dem Ausreißer)
    if traffic_high(s) {
        return (C::LocalTraffic, vec![R::TrafficHigh]);
    }

    let is_wifi = s.connection == Some(LinkKind::Wifi);
    let wifi = s.wifi.as_ref().filter(|_| is_wifi);
    let rssi_low = wifi.and_then(|w| w.rssi).is_some_and(|r| r < RSSI_LOW_DBM);
    let signal_drop = wifi.zip(s.signal_base).is_some_and(|(w, base)| f64::from(w.signal) <= base - SIGNAL_DROP);
    let mut weak = Vec::new();
    if rssi_low {
        weak.push(R::RssiLow);
    }
    if signal_drop {
        weak.push(R::SignalDrop);
    }

    // 2: Ziel wieder normal – der Ausreißer war schon vorbei
    let target = target_state(s, input.limit);
    if target == TargetState::Normal {
        let mut r = vec![R::SpikeGone];
        r.extend(weak);
        return (C::Unknown, r);
    }

    // 3–5: Router je nach Verbindungsart
    let router = router_state(s.gateway_ms, s.gateway_base_ms);
    let router_reason = match router {
        RouterState::Bad(r) => Some(r),
        _ => None,
    };
    match s.connection {
        Some(LinkKind::Wifi) if router_reason.is_some() || (!weak.is_empty() && router != RouterState::Ok) => {
            let mut r: Vec<Reason> = router_reason.into_iter().collect();
            r.extend(weak);
            return (C::Wifi, r);
        }
        Some(LinkKind::Ethernet) if router_reason.is_some() => return (C::Router, router_reason.into_iter().collect()),
        Some(LinkKind::Other) if router_reason.is_some() => return (C::Unknown, vec![R::ConnectionOther]),
        _ => {}
    }

    // 6–7: Router unauffällig – Anbieter oder Internet
    let isp = isp_state(&s.hops, target == TargetState::Disturbed);
    if router == RouterState::Ok && isp == IspState::Bad {
        let mut r = vec![R::IspHopSlow];
        if input.last_bufferbloat_ms.is_none_or(|b| b >= BUFFERBLOAT_BUSY_MS) {
            r.push(R::LineBusyPossible);
        }
        if rssi_low {
            r.push(R::RssiLow);
        }
        return (C::Isp, r);
    }
    if router == RouterState::Ok && isp == IspState::Ok && target == TargetState::Disturbed {
        let mut r = vec![R::PathOk];
        if rssi_low {
            r.push(R::RssiLow);
        }
        return (C::Internet, r);
    }

    // 8: unklar – mit den Gründen, warum
    let mut r = Vec::new();
    if isp == IspState::HopOnly {
        r.push(R::IspHopOnly);
    }
    if is_wifi && s.wifi_state == Some(SnapWifiState::Locked) {
        r.push(R::WifiLocked);
    }
    let any_answer = s.hops.iter().any(|h| h.rtt.is_some());
    if !any_answer {
        r.push(R::NoHops);
    }
    if (any_answer && isp == IspState::Unknown) || router == RouterState::Unknown {
        r.push(R::NoBaseline);
    }
    if target == TargetState::NotChecked {
        r.push(R::NoTargetCheck);
    }
    (C::Unknown, r)
}

// =============================================================================================
// Grundwerte (Ruhe-Messungen)
// =============================================================================================

/// Grundwert = Median der letzten so vielen Ruhe-Messungen.
pub const BASE_SAMPLES: usize = 5;

fn push_capped(q: &mut VecDeque<f64>, v: f64) {
    if !v.is_finite() {
        return;
    }
    q.push_back(v);
    while q.len() > BASE_SAMPLES {
        q.pop_front();
    }
}

fn median_of(q: &VecDeque<f64>) -> Option<f64> {
    let v: Vec<f64> = q.iter().copied().collect();
    median(&v)
}

/// Grundwerte je TTL (neu, wenn sich die Adresse ändert), Router und WLAN-Signal (neu, wenn sich
/// das Gateway ändert) aus den Ruhe-Messungen.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Baselines {
    /// Index = TTL − 1: (Adresse, letzte Werte)
    hops: Vec<(Option<String>, VecDeque<f64>)>,
    /// Gateway, zu dem Router- und Signal-Grundwert gehören
    gateway: Option<Ipv4Addr>,
    router: VecDeque<f64>,
    signal: VecDeque<f64>,
}

impl Baselines {
    /// Ergebnis einer Ruhe-Messung einrechnen.
    pub fn learn(&mut self, snap: &LagSnapshot, gateway: Option<Ipv4Addr>) {
        if gateway != self.gateway {
            *self = Baselines { gateway, ..Default::default() };
        }
        for hop in &snap.hops {
            let (Some(rtt), Some(addr)) = (hop.rtt, hop.address.as_ref()) else { continue };
            let idx = usize::from(hop.ttl.max(1)) - 1;
            if self.hops.len() <= idx {
                self.hops.resize(idx + 1, (None, VecDeque::new()));
            }
            let slot = &mut self.hops[idx];
            if slot.0.as_ref() != Some(addr) {
                *slot = (Some(addr.clone()), VecDeque::new());
            }
            push_capped(&mut slot.1, rtt);
        }
        if let Some(g) = snap.gateway_ms {
            push_capped(&mut self.router, g);
        }
        if let Some(w) = snap.wifi.as_ref() {
            push_capped(&mut self.signal, f64::from(w.signal));
        }
    }

    /// Grundwert einer Station (nur, wenn sie dieselbe Adresse hat).
    pub fn hop_base(&self, ttl: u8, address: Option<&str>) -> Option<f64> {
        let (addr, q) = self.hops.get(usize::from(ttl.max(1)) - 1)?;
        (addr.as_deref() == address && address.is_some()).then(|| median_of(q)).flatten()
    }

    /// Router-Grundwert (nur für dasselbe Gateway).
    pub fn router_base(&self, gateway: Option<Ipv4Addr>) -> Option<f64> {
        (gateway == self.gateway).then(|| median_of(&self.router)).flatten()
    }

    /// Grundwert WLAN-Signal (Qualität 0–100, nur für dasselbe Gateway).
    pub fn signal_base(&self, gateway: Option<Ipv4Addr>) -> Option<f64> {
        (gateway == self.gateway).then(|| median_of(&self.signal)).flatten()
    }
}

// =============================================================================================
// Momentaufnahme
// =============================================================================================

/// Was die Momentaufnahme messen soll.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPlan {
    /// Schon aufgelöste IPv4 des Messziels (keine neue Namensauflösung; `None` oder `0.0.0.0` =
    /// keine – dann ohne Ziel- und Stationsmessung)
    pub dst: Option<Ipv4Addr>,
    /// Messziel (Methode wie beim Monitor)
    pub target: Option<PingTarget>,
    /// Ausreißer-Grenze (`None` = auf Wunsch, Ziel nur gemessen)
    pub limit: Option<f64>,
    /// `false` = Ruhe-Messung ohne Zielmessung (nur Grundwerte)
    pub measure_target: bool,
}

/// Gesamtzeit einer Momentaufnahme (ms).
pub const SNAPSHOT_TIMEOUT_MS: u64 = 1500;
/// Zeitlimit je Zielmessung: die 3 Messungen starten im Abstand von 100 ms und enden spätestens
/// 1,3 s nach dem Start, damit die Momentaufnahme in 1,5 s bleibt.
pub const TARGET_PROBE_TIMEOUT: Duration = Duration::from_millis(1100);
/// Abstand der Zielmessungen.
pub const TARGET_PROBE_SPACING: Duration = Duration::from_millis(100);
/// Zeitlimit für den WLAN-Zustand.
pub const WIFI_TIMEOUT: Duration = Duration::from_millis(1200);
/// Namensauflösung bei der Momentaufnahme auf Wunsch.
pub const ON_DEMAND_RESOLVE: Duration = Duration::from_millis(300);
/// Hauptverbindung ermitteln bei der Momentaufnahme auf Wunsch.
pub const ON_DEMAND_LINK: Duration = Duration::from_millis(500);

/// Eine Messung des Ziels mit derselben Methode wie der Monitor.
async fn probe_target(target: &PingTarget, dst: Ipv4Addr) -> Option<f64> {
    match ping::effective_method(target.method) {
        PingMethod::Tcp => ping::tcp_probe(SocketAddr::new(dst.into(), ping::target_port(target)), TARGET_PROBE_TIMEOUT).await,
        PingMethod::Icmp => ping::icmp_probe(dst.into(), TARGET_PROBE_TIMEOUT).await,
    }
}

/// Ziel 3× im Abstand von 100 ms → (Median der Antworten, Verluste). `(None, None)` = nicht gemessen.
async fn measure_target(target: Option<&PingTarget>, dst: Option<Ipv4Addr>) -> (Option<f64>, Option<u32>) {
    let (Some(target), Some(dst)) = (target, dst) else { return (None, None) };
    let probes = (0..TARGET_PROBES).map(|i| async move {
        tokio::time::sleep(TARGET_PROBE_SPACING * i).await;
        probe_target(target, dst).await
    });
    let rtts = futures_util::future::join_all(probes).await;
    let ok: Vec<f64> = rtts.iter().flatten().copied().filter(|v| v.is_finite()).collect();
    let lost = TARGET_PROBES.saturating_sub(u32::try_from(ok.len()).unwrap_or(TARGET_PROBES));
    (median(&ok), Some(lost))
}

/// Router: 2 ICMP-Echos (ohne TTL), 600 ms, kleinere Antwort. Außerhalb von Windows `None`.
async fn ping_gateway(gateway: Option<Ipv4Addr>) -> Option<f64> {
    #[cfg(windows)]
    {
        use super::ping::icmp;
        let gw = gateway?;
        let echos = (0..2).map(|_| tokio::task::spawn_blocking(move || icmp::send_echo(gw, None, quickhops::HOP_TIMEOUT)));
        let results = futures_util::future::join_all(echos).await;
        results
            .into_iter()
            .filter_map(|r| match r {
                Ok(Ok(Some(reply))) if reply.status == icmp::STATUS_SUCCESS && reply.rtt_ms.is_finite() => Some(reply.rtt_ms),
                _ => None,
            })
            .reduce(f64::min)
    }
    #[cfg(not(windows))]
    {
        let _ = gateway;
        None
    }
}

/// WLAN-Zustand (nur bei WLAN als Hauptverbindung).
async fn read_wifi(want: bool) -> (Option<SnapWifi>, Option<SnapWifiState>) {
    use super::adapters::{self, WifiState};
    if !want {
        return (None, None);
    }
    let state = tokio::time::timeout(WIFI_TIMEOUT, tokio::task::spawn_blocking(adapters::wifi_state)).await;
    match state {
        Ok(Ok(WifiState::Connected(w))) => (Some(SnapWifi { signal: w.signal.min(100), rssi: w.rssi, band: w.band }), Some(SnapWifiState::Ok)),
        Ok(Ok(WifiState::Locked)) => (None, Some(SnapWifiState::Locked)),
        Ok(Ok(WifiState::NotConnected | WifiState::NoService)) => (None, Some(SnapWifiState::NoWifi)),
        _ => (None, None),
    }
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

/// Momentaufnahme ausführen und einschätzen. Nie ein Fehler: fehlende Teile bleiben `None`.
/// Wird vom Hook bzw. vom Befehl per `spawn` gestartet (der Monitor-Takt wartet nie darauf). Bei
/// einer Ruhe-Messung (`measure_target = false`) lernt der Detektiv die Grundwerte.
pub async fn run_snapshot(core: Shared, plan: SnapshotPlan, now: i64) -> LagCheck {
    let started = Instant::now();
    // Ohne Netz, aus Zwischenspeichern (vor den eigenen Paketen)
    let link = core.net.link_lite();
    let gateway = link.as_ref().and_then(|l| l.gateway);
    let kind = link.as_ref().map(|l| l.kind);
    let via_vpn = link.as_ref().is_some_and(|l| l.vpn);
    let (rx, tx, traffic_base, cpu) = {
        let load = core.net.load.lock_safe();
        let (rx, tx) = load.rates(now);
        (rx, tx, load.traffic_baseline(now), load.cpu())
    };
    let (enabled, (ref_down, ref_up), bufferbloat) = {
        let rec = core.net.recorder.lock_safe();
        (rec.settings().snapshots, rec.reference_mbps(now), rec.last_bufferbloat_ms(now))
    };
    let bases = core.net.lag.bases.lock_safe().clone();

    let dst = plan.dst.filter(|d| !d.is_unspecified());
    let target = plan.target.as_ref().filter(|_| plan.measure_target);
    let hops_fut = async move {
        match dst {
            Some(d) => quickhops::quick_hops(d, quickhops::DEFAULT_HOPS, quickhops::HOP_TIMEOUT).await,
            None => Vec::new(),
        }
    };
    let ((target_ms, target_lost), mut hops, gw, (wifi, wifi_state)) =
        tokio::join!(measure_target(target, dst), hops_fut, ping_gateway(gateway), read_wifi(kind == Some(LinkKind::Wifi)));

    quickhops::assign_zones(&mut hops, gateway);
    for h in &mut hops {
        h.base_ms = bases.hop_base(h.ttl, h.address.as_deref());
    }
    // Antwortet das Gateway nicht, aber TTL 1 (Heimnetz), gilt TTL 1 als Router-Wert
    let gateway_ms = gw.or_else(|| hops.first().filter(|h| h.zone == Some(Zone::Lan)).and_then(|h| h.rtt));
    let snapshot = LagSnapshot {
        at: now,
        connection: kind,
        via_vpn,
        target_ms,
        target_lost,
        hops,
        gateway_ms,
        gateway_base_ms: bases.router_base(gateway),
        wifi,
        wifi_state,
        signal_base: bases.signal_base(gateway),
        rx_mbps: finite(rx),
        tx_mbps: finite(tx),
        traffic_base_mbps: finite(traffic_base),
        ref_down_mbps: finite(ref_down),
        ref_up_mbps: finite(ref_up),
        cpu: cpu.map(f64::from).filter(|c| c.is_finite()),
        took_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    };
    if !plan.measure_target {
        core.net.lag.bases.lock_safe().learn(&snapshot, gateway);
    }
    // Auf Wunsch (ohne Grenze) misst der Detektiv auch, wenn Momentaufnahmen bei Ausreißern aus sind
    let input = LagInput { snapshot, limit: plan.limit, snapshots_enabled: enabled || plan.limit.is_none(), last_bufferbloat_ms: bufferbloat };
    let (cause, reasons) = classify_cause(&input);
    LagCheck { at: now, cause, cpu_high: cpu_high(input.snapshot.cpu), reasons, snapshot: input.snapshot }
}

/// Ergebnis, wenn die Momentaufnahme ihr Zeitlimit überschreitet: „unklar“, Teilergebnisse verworfen.
pub fn timed_out(at: i64) -> LagCheck {
    let mut snapshot = LagSnapshot::off(at);
    snapshot.took_ms = SNAPSHOT_TIMEOUT_MS;
    LagCheck { at, cause: LagCause::Unknown, cpu_high: false, reasons: Vec::new(), snapshot }
}

/// Setzt ein Belegt-Flag beim Verlassen zurück.
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Hauptverbindung sicherstellen (Monitor lief evtl. nie): fehlt sie oder ist sie älter als 30 s,
/// wird sie neu ermittelt (höchstens 500 ms, nie zwei gleichzeitig).
async fn ensure_link(core: &Shared, dst: Option<Ipv4Addr>, now: i64) {
    let fresh = core.net.link.lock_safe().as_ref().is_some_and(|l| now >= l.at && now - l.at < link::REFRESH_EVERY_MS);
    if fresh || core.net.link_refreshing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    let _busy = Busy(&core.net.link_refreshing);
    let job = tokio::task::spawn_blocking(move || link::refresh(dst, now));
    if let Ok(Ok(found)) = tokio::time::timeout(ON_DEMAND_LINK, job).await {
        let luid = found.as_ref().map(|l| l.luid);
        *core.net.link.lock_safe() = found;
        core.net.load.lock_safe().set_luid(luid);
    }
}

/// `net_lag_snapshot`: Namensauflösung höchstens 300 ms (sonst ohne Ziel- und Stationsmessung),
/// dann [`run_snapshot`] mit `limit = None` (Ziel nur gemessen, nicht bewertet). Nie ein Fehler.
pub async fn snapshot_on_demand(core: Shared, target: PingTarget) -> LagCheck {
    let now = crate::util::now_ms();
    let dst = match tokio::time::timeout(ON_DEMAND_RESOLVE, ping::resolve_host(&target.host, true)).await {
        Ok(Ok(std::net::IpAddr::V4(v4))) => Some(v4),
        _ => None,
    };
    ensure_link(&core, dst, now).await;
    let plan = SnapshotPlan { dst, target: Some(target), limit: None, measure_target: true };
    let limit = Duration::from_millis(SNAPSHOT_TIMEOUT_MS);
    tokio::time::timeout(limit, run_snapshot(core, plan, now)).await.unwrap_or_else(|_| timed_out(now))
}

// =============================================================================================
// Detail für `net_events` (Ausreißer)
// =============================================================================================

/// Auf eine Nachkommastelle runden (kompaktes `detail`).
fn r1(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite()).map(|x| (x * 10.0).round() / 10.0)
}

/// `detail` eines `spike`-Eintrags: `{ count, baseline, limit, cpuHigh, reasons, snap }` mit
/// `snap = { conn, vpn, hops: [ttl, rtt|null, zone|null][], gw, gwB, tgt, rssi, sig, rx, tx, cpu }` –
/// Stationen **ohne Adressen**, keine SSID/BSSID/MAC.
pub fn spike_detail(count: u32, baseline: f64, limit: f64, check: Option<&LagCheck>) -> Value {
    let mut d = json!({ "count": count, "baseline": r1(Some(baseline)), "limit": r1(Some(limit)), "cpuHigh": false, "reasons": [] });
    if let Some(c) = check {
        let s = &c.snapshot;
        d["cpuHigh"] = json!(c.cpu_high);
        d["reasons"] = json!(c.reasons);
        d["snap"] = json!({
            "conn": s.connection,
            "vpn": s.via_vpn,
            "hops": s.hops.iter().map(|h| json!([h.ttl, r1(h.rtt), h.zone.map(Zone::as_str)])).collect::<Vec<_>>(),
            "gw": r1(s.gateway_ms),
            "gwB": r1(s.gateway_base_ms),
            "tgt": r1(s.target_ms),
            "rssi": s.wifi.as_ref().and_then(|w| w.rssi),
            "sig": s.wifi.as_ref().map(|w| w.signal),
            "rx": r1(s.rx_mbps),
            "tx": r1(s.tx_mbps),
            "cpu": r1(s.cpu),
        });
    }
    d
}

// =============================================================================================
// Laufzeit-Zustand
// =============================================================================================

/// Höchstzahl gemerkter Ereignisse für `net_lag_recent`.
pub const RECENT_MAX: usize = 20;

/// Zustand des Detektivs in `NetState.lag`: letzte 20 Ereignisse, laufende Momentaufnahme,
/// Grundwerte aus den Ruhe-Messungen.
#[derive(Debug, Default)]
pub struct LagState {
    recent: Mutex<VecDeque<LagEvent>>,
    /// Läuft gerade eine Momentaufnahme? (nie zwei gleichzeitig)
    pub running: AtomicBool,
    /// Grundwerte je TTL, Router und Signal (aus den Ruhe-Messungen)
    pub bases: Mutex<Baselines>,
}

impl LagState {
    /// Ereignis merken; ein Ereignis mit gleichem `at` + `targetId` wird ersetzt (zweite Meldung mit
    /// dem endgültigen `count`). Höchstens 20, die ältesten fallen heraus.
    pub fn remember(&self, ev: LagEvent) {
        let mut q = self.recent.lock_safe();
        if let Some(slot) = q.iter_mut().find(|e| e.check.at == ev.check.at && e.target_id == ev.target_id) {
            *slot = ev;
            return;
        }
        q.push_back(ev);
        while q.len() > RECENT_MAX {
            q.pop_front();
        }
    }

    /// Die gemerkten Ereignisse, neueste zuerst (`net_lag_recent`).
    pub fn recent(&self) -> Vec<LagEvent> {
        self.recent.lock_safe().iter().rev().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(v: &Value) -> Option<f64> {
        v.as_f64()
    }

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../src/lib/fixtures/spikes.json")).expect("spikes.json")
    }

    #[test]
    fn spike_rule_matches_fixtures() {
        let f = fixtures();
        let cases = f["count"].as_array().expect("count");
        assert!(cases.len() >= 8);
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let rtts: Vec<Option<f64>> = c["rtts"].as_array().unwrap().iter().map(opt).collect();
            let ok: Vec<f64> = rtts.iter().flatten().copied().collect();
            assert_eq!(spike_limit(&ok), opt(&c["limit"]), "Grenze: {name}");
            assert_eq!(u64::from(count_spikes(&rtts)), c["spikes"].as_u64().unwrap(), "Ausreißer: {name}");
        }
    }

    #[test]
    fn live_rule_matches_fixtures() {
        let f = fixtures();
        let cases = f["live"].as_array().expect("live");
        assert!(cases.len() >= 3);
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let window: Vec<Option<f64>> = c["window"].as_array().unwrap().iter().map(opt).collect();
            assert_eq!(is_live_spike(&window), c["spike"].as_bool().unwrap(), "live: {name}");
        }
    }

    #[test]
    fn texts_and_json_shape() {
        for c in LagCause::ALL {
            assert_eq!(LagCause::parse(c.as_str()), Some(c));
            assert_eq!(serde_json::to_value(c).unwrap(), c.as_str());
        }
        assert_eq!(serde_json::to_value(Reason::LineBusyPossible).unwrap(), "lineBusyPossible");
        let names: std::collections::HashSet<String> = Reason::ALL.iter().map(|r| serde_json::to_value(r).unwrap().as_str().unwrap().to_string()).collect();
        assert_eq!(names.len(), 18, "alle Gründe mit eigenem Namen");
        assert_eq!(serde_json::to_value(SnapWifiState::NoWifi).unwrap(), "none");
        let ev = LagEvent {
            check: LagCheck { at: 5, cause: LagCause::Isp, cpu_high: true, reasons: vec![Reason::CpuHigh], snapshot: LagSnapshot::off(5) },
            target_id: "aws-eu-central-1".into(),
            target_label: "Frankfurt".into(),
            target_kind: TargetKind::Region,
            rtt: 180.0,
            baseline: 20.0,
            limit: 60.0,
            count: 2,
            session_id: None,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["at"], 5);
        assert_eq!(v["cause"], "isp");
        assert_eq!(v["cpuHigh"], true);
        assert_eq!(v["targetKind"], "region");
        assert_eq!(v["snapshot"]["hops"], serde_json::json!([]));
        assert_eq!(v["snapshot"]["viaVpn"], false);
        assert_eq!(v["snapshot"]["tookMs"], 0);
        assert!(v["snapshot"]["targetMs"].is_null());
        let back: LagEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, ev);
        assert!(cpu_high(Some(90.0)) && !cpu_high(Some(89.9)) && !cpu_high(None));
    }

    #[test]
    fn recent_keeps_20_newest_first_and_replaces_by_at() {
        let st = LagState::default();
        let ev = |at: i64, count: u32| LagEvent {
            check: LagCheck { at, cause: LagCause::Unknown, cpu_high: false, reasons: vec![], snapshot: LagSnapshot::off(at) },
            target_id: "t".into(),
            target_label: "T".into(),
            target_kind: TargetKind::Other,
            rtt: 1.0,
            baseline: 1.0,
            limit: 41.0,
            count,
            session_id: None,
        };
        for at in 0..25 {
            st.remember(ev(at, 1));
        }
        st.remember(ev(24, 3));
        let list = st.recent();
        assert_eq!(list.len(), 20);
        assert_eq!(list[0].check.at, 24);
        assert_eq!(list[0].count, 3, "zweite Meldung ersetzt die erste");
        assert_eq!(list[19].check.at, 5);
    }

    // -----------------------------------------------------------------------------------------
    // Ursachen-Tabelle
    // -----------------------------------------------------------------------------------------

    fn hop(ttl: u8, rtt: Option<f64>, zone: Option<Zone>, base: Option<f64>) -> QuickHop {
        QuickHop { ttl, address: rtt.map(|_| format!("62.155.240.{ttl}")), rtt, zone, cgnat: false, base_ms: base }
    }

    /// Ethernet, Router ok (1 ms, Grundwert 1), Anbieter-Stationen normal, Ziel noch gestört (180 ms).
    fn base_snapshot() -> LagSnapshot {
        LagSnapshot {
            at: 1,
            connection: Some(LinkKind::Ethernet),
            target_ms: Some(180.0),
            target_lost: Some(0),
            hops: vec![hop(1, Some(1.0), Some(Zone::Lan), Some(1.0)), hop(2, Some(8.0), Some(Zone::Isp), Some(7.0)), hop(3, Some(10.0), Some(Zone::Isp), Some(9.0))],
            gateway_ms: Some(1.0),
            gateway_base_ms: Some(1.0),
            rx_mbps: Some(1.0),
            tx_mbps: Some(0.2),
            traffic_base_mbps: Some(1.0),
            cpu: Some(20.0),
            took_ms: 700,
            ..Default::default()
        }
    }

    fn input(s: LagSnapshot) -> LagInput {
        LagInput { snapshot: s, limit: Some(60.0), snapshots_enabled: true, last_bufferbloat_ms: Some(20.0) }
    }

    fn classify(s: LagSnapshot) -> (LagCause, Vec<Reason>) {
        classify_cause(&input(s))
    }

    fn wifi_snapshot(rssi: i32, signal: u32) -> LagSnapshot {
        LagSnapshot {
            connection: Some(LinkKind::Wifi),
            wifi: Some(SnapWifi { signal, rssi: Some(rssi), band: Some("5".into()) }),
            wifi_state: Some(SnapWifiState::Ok),
            signal_base: Some(80.0),
            ..base_snapshot()
        }
    }

    #[test]
    fn cause_table() {
        use LagCause as C;
        use Reason as R;
        // Zeile 7: alles unauffällig, Ziel noch gestört → Internet
        assert_eq!(classify(base_snapshot()), (C::Internet, vec![R::PathOk]));

        // Zeile 0: aus · VPN
        let off = LagInput { snapshots_enabled: false, ..input(base_snapshot()) };
        assert_eq!(classify_cause(&off), (C::Unknown, vec![R::SnapshotsOff]));
        assert_eq!(classify(LagSnapshot { via_vpn: true, ..base_snapshot() }), (C::Unknown, vec![R::VpnActive]));

        // Zeile 1: Datenverkehr – mit Bezug 70 % (echt größer), ohne Bezug max(5 × Grundwert, 20)
        let with_ref = |rx: f64, tx: f64| LagSnapshot { rx_mbps: Some(rx), tx_mbps: Some(tx), ref_down_mbps: Some(100.0), ref_up_mbps: Some(20.0), ..base_snapshot() };
        assert_eq!(classify(with_ref(70.1, 0.0)).0, C::LocalTraffic);
        assert_eq!(classify(with_ref(70.0, 0.0)).0, C::Internet, "genau 70 % ist noch nicht voll");
        assert_eq!(classify(with_ref(1.0, 14.1)), (C::LocalTraffic, vec![R::TrafficHigh]), "Upload voll (Cloud-Backup)");
        assert_eq!(classify(with_ref(1.0, 14.0)).0, C::Internet);
        let no_ref = |sum: f64, base: Option<f64>| LagSnapshot { rx_mbps: Some(sum), tx_mbps: Some(0.0), traffic_base_mbps: base, ..base_snapshot() };
        assert_eq!(classify(no_ref(20.1, Some(1.0))).0, C::LocalTraffic);
        assert_eq!(classify(no_ref(20.0, Some(1.0))).0, C::Internet);
        assert_eq!(classify(no_ref(30.0, Some(8.0))).0, C::Internet, "5 × 8 = 40 > 30");
        assert_eq!(classify(no_ref(40.1, Some(8.0))).0, C::LocalTraffic);
        assert_eq!(classify(no_ref(25.0, None)).0, C::LocalTraffic, "ohne Grundwert gilt 20");

        // Zeile 2: Ausreißer vorbei → unklar (mit WLAN-Zusatz)
        let gone = LagSnapshot { target_ms: Some(22.0), target_lost: Some(1), ..base_snapshot() };
        assert_eq!(classify(gone), (C::Unknown, vec![R::SpikeGone]));
        let gone_wifi = LagSnapshot { target_ms: Some(22.0), ..wifi_snapshot(-75, 50) };
        assert_eq!(classify(gone_wifi), (C::Unknown, vec![R::SpikeGone, R::RssiLow, R::SignalDrop]));
        assert_eq!(classify(LagSnapshot { target_ms: Some(60.0), ..base_snapshot() }).0, C::Unknown, "genau auf der Grenze = normal");

        // Zeile 3: WLAN – Router auffällig oder schwaches Signal ohne unauffälligen Router
        let slow_gw = LagSnapshot { gateway_ms: Some(17.0), gateway_base_ms: Some(1.0), ..wifi_snapshot(-60, 80) };
        assert_eq!(classify(slow_gw), (C::Wifi, vec![R::GatewaySlow]));
        let edge_gw = LagSnapshot { gateway_ms: Some(16.0), gateway_base_ms: Some(1.0), ..wifi_snapshot(-60, 80) };
        assert_eq!(classify(edge_gw).0, C::Internet, "+15 ms ist noch unauffällig");
        let lost_gw = LagSnapshot { gateway_ms: None, ..wifi_snapshot(-60, 80) };
        assert_eq!(classify(lost_gw), (C::Wifi, vec![R::GatewayLost]));
        let weak_no_router = LagSnapshot { gateway_ms: None, gateway_base_ms: None, ..wifi_snapshot(-71, 80) };
        assert_eq!(classify(weak_no_router), (C::Wifi, vec![R::RssiLow]));
        let edge_rssi = LagSnapshot { gateway_ms: None, gateway_base_ms: None, ..wifi_snapshot(-70, 80) };
        assert_ne!(classify(edge_rssi).0, C::Wifi, "−70 dBm ist noch nicht schwach");
        let drop = LagSnapshot { gateway_ms: None, gateway_base_ms: None, ..wifi_snapshot(-60, 65) };
        assert_eq!(classify(drop), (C::Wifi, vec![R::SignalDrop]), "Signal = Grundwert − 15");

        // Zeile 4: Ethernet + Router auffällig
        let eth_gw = LagSnapshot { gateway_ms: Some(40.0), gateway_base_ms: Some(10.0), ..base_snapshot() };
        assert_eq!(classify(eth_gw), (C::Router, vec![R::GatewaySlow]));
        let eth_x2 = LagSnapshot { gateway_ms: Some(40.0), gateway_base_ms: Some(20.0), ..base_snapshot() };
        assert_eq!(classify(eth_x2).0, C::Internet, "40 ≤ max(2 × 20, 35)");
        assert_eq!(classify(LagSnapshot { gateway_ms: Some(31.0), gateway_base_ms: None, ..base_snapshot() }).0, C::Router, "ohne Grundwert > 30");

        // Zeile 5: other + Router auffällig
        let other = LagSnapshot { connection: Some(LinkKind::Other), gateway_ms: Some(40.0), ..base_snapshot() };
        assert_eq!(classify(other), (C::Unknown, vec![R::ConnectionOther]));

        // Zeile 6: Router ok, Anbieter bleibt erhöht, Ziel gestört → Anbieter
        let isp_hops = vec![hop(1, Some(1.0), Some(Zone::Lan), Some(1.0)), hop(2, Some(38.0), Some(Zone::Isp), Some(7.0)), hop(3, Some(30.0), Some(Zone::Isp), Some(9.0))];
        let isp = LagSnapshot { hops: isp_hops.clone(), ..base_snapshot() };
        assert_eq!(classify(isp.clone()), (C::Isp, vec![R::IspHopSlow]), "Bufferbloat 20 ms → keine volle Leitung");
        let isp_bb = LagInput { last_bufferbloat_ms: Some(60.0), ..input(isp.clone()) };
        assert_eq!(classify_cause(&isp_bb).1, vec![R::IspHopSlow, R::LineBusyPossible]);
        // +30 ist nicht auffällig, +20 bei der Folgestation bleibt nicht erhöht
        let edge = LagSnapshot { hops: vec![hop(1, Some(1.0), Some(Zone::Lan), Some(1.0)), hop(2, Some(37.0), Some(Zone::Isp), Some(7.0))], ..base_snapshot() };
        assert_eq!(classify(edge).0, C::Internet);
        let later_edge = LagSnapshot { hops: vec![hop(2, Some(38.0), Some(Zone::Isp), Some(7.0)), hop(3, Some(29.0), Some(Zone::Isp), Some(9.0))], ..base_snapshot() };
        assert_eq!(classify(later_edge), (C::Unknown, vec![R::IspHopOnly]));

        // Pflicht: eine Anbieter-Station langsam, Ziel normal → nicht Anbieter
        let gone_isp = LagSnapshot { hops: isp_hops.clone(), target_ms: Some(25.0), ..base_snapshot() };
        assert_eq!(classify(gone_isp), (C::Unknown, vec![R::SpikeGone]));
        // Pflicht: eine Anbieter-Station langsam, danach normal → unklar/ispHopOnly
        let only = LagSnapshot {
            hops: vec![hop(1, Some(1.0), Some(Zone::Lan), Some(1.0)), hop(2, Some(80.0), Some(Zone::Isp), Some(7.0)), hop(3, Some(10.0), Some(Zone::Isp), Some(9.0))],
            ..base_snapshot()
        };
        assert_eq!(classify(only), (C::Unknown, vec![R::IspHopOnly]));
        // Pflicht: schwaches WLAN, Router ok, Anbieter bleibt erhöht → Anbieter mit rssiLow
        let weak_isp = LagSnapshot { hops: isp_hops, ..wifi_snapshot(-74, 78) };
        assert_eq!(classify(weak_isp), (C::Isp, vec![R::IspHopSlow, R::RssiLow]));

        // Zeile 8: unklar mit Gründen
        let no_hops = LagSnapshot { hops: vec![hop(1, None, None, None), hop(2, None, None, None)], ..base_snapshot() };
        assert_eq!(classify(no_hops), (C::Unknown, vec![R::NoHops]));
        let no_base = LagSnapshot { hops: vec![hop(1, Some(1.0), Some(Zone::Lan), None), hop(2, Some(8.0), Some(Zone::Isp), None)], ..base_snapshot() };
        assert_eq!(classify(no_base), (C::Unknown, vec![R::NoBaseline]));
        let locked = LagSnapshot { connection: Some(LinkKind::Wifi), wifi_state: Some(SnapWifiState::Locked), hops: vec![], ..base_snapshot() };
        assert_eq!(classify(locked), (C::Unknown, vec![R::WifiLocked, R::NoHops]));
        let on_demand = LagInput { limit: None, ..input(base_snapshot()) };
        assert_eq!(classify_cause(&on_demand), (C::Unknown, vec![R::NoTargetCheck]), "auf Wunsch: Ziel nicht bewertbar");
        let unmeasured = LagSnapshot { target_ms: None, target_lost: None, ..base_snapshot() };
        assert_eq!(classify(unmeasured), (C::Unknown, vec![R::NoTargetCheck]));
    }

    #[test]
    fn router_never_answered_is_not_bad() {
        // Kein Router-Wert und kein Grundwert: weder auffällig noch unauffällig
        assert_eq!(router_state(None, None), RouterState::Unknown);
        let s = LagSnapshot { gateway_ms: None, gateway_base_ms: None, ..base_snapshot() };
        let (cause, reasons) = classify(s.clone());
        assert_eq!(cause, LagCause::Unknown, "ohne bewertbaren Router kein „Internet“");
        assert!(reasons.contains(&Reason::NoBaseline));
        // Auch per Kabel kein „Router“
        assert_ne!(classify(LagSnapshot { connection: Some(LinkKind::Ethernet), ..s }).0, LagCause::Router);
    }

    #[test]
    fn cpu_high_flag() {
        let (cause, reasons) = classify(LagSnapshot { cpu: Some(95.0), ..base_snapshot() });
        assert_eq!(cause, LagCause::Internet, "CPU ist keine Ursache");
        assert_eq!(reasons, vec![Reason::PathOk, Reason::CpuHigh]);
        let (_, reasons) = classify(LagSnapshot { cpu: Some(89.9), ..base_snapshot() });
        assert!(!reasons.contains(&Reason::CpuHigh));
        let off = LagInput { snapshots_enabled: false, ..input(LagSnapshot { cpu: Some(99.0), ..base_snapshot() }) };
        assert_eq!(classify_cause(&off).1, vec![Reason::SnapshotsOff, Reason::CpuHigh]);
    }

    #[test]
    fn line_busy_possible_rules() {
        let isp = LagSnapshot {
            hops: vec![hop(1, Some(1.0), Some(Zone::Lan), Some(1.0)), hop(2, Some(60.0), Some(Zone::Isp), Some(7.0)), hop(3, Some(70.0), Some(Zone::Isp), Some(9.0))],
            ..base_snapshot()
        };
        let with = |bb: Option<f64>| classify_cause(&LagInput { last_bufferbloat_ms: bb, ..input(isp.clone()) }).1.contains(&Reason::LineBusyPossible);
        assert!(with(None), "kein Speedtest → möglich");
        assert!(with(Some(60.0)), "ab 60 ms Bufferbloat");
        assert!(with(Some(140.0)));
        assert!(!with(Some(59.9)));
    }

    #[test]
    fn baselines_median_of_last_5_and_reset_on_change() {
        let gw = Some(Ipv4Addr::new(192, 168, 178, 1));
        let mut b = Baselines::default();
        for (i, v) in [5.0, 1.0, 2.0, 3.0, 4.0, 100.0].into_iter().enumerate() {
            let snap = LagSnapshot {
                hops: vec![hop(2, Some(v), Some(Zone::Isp), None)],
                gateway_ms: Some(v),
                wifi: Some(SnapWifi { signal: 70 + i as u32, rssi: Some(-55), band: None }),
                ..Default::default()
            };
            b.learn(&snap, gw);
        }
        // Letzte 5: 1, 2, 3, 4, 100 → Median 3
        assert_eq!(b.hop_base(2, Some("62.155.240.2")), Some(3.0));
        assert_eq!(b.router_base(gw), Some(3.0));
        assert_eq!(b.signal_base(gw), Some(73.0));
        assert_eq!(b.hop_base(2, Some("80.1.1.1")), None, "andere Adresse");
        assert_eq!(b.hop_base(3, Some("62.155.240.2")), None);
        assert_eq!(b.router_base(Some(Ipv4Addr::new(10, 0, 0, 1))), None, "anderes Gateway");
        // Neue Adresse bei TTL 2 → Grundwert beginnt neu
        b.learn(&LagSnapshot { hops: vec![QuickHop { address: Some("80.1.1.1".into()), ..hop(2, Some(9.0), Some(Zone::Isp), None) }], ..Default::default() }, gw);
        assert_eq!(b.hop_base(2, Some("80.1.1.1")), Some(9.0));
        // Anderes Gateway → alles neu
        b.learn(&LagSnapshot::default(), None);
        assert_eq!(b.router_base(None), None);
    }

    #[test]
    fn spike_detail_has_no_addresses() {
        let snap = LagSnapshot {
            hops: vec![QuickHop { ttl: 1, address: Some("192.168.178.1".into()), rtt: Some(1.234), zone: Some(Zone::Lan), cgnat: false, base_ms: Some(1.0) }],
            wifi: Some(SnapWifi { signal: 61, rssi: Some(-66), band: Some("2.4".into()) }),
            ..base_snapshot()
        };
        let check = LagCheck { at: 1, cause: LagCause::Wifi, cpu_high: false, reasons: vec![Reason::RssiLow], snapshot: snap };
        let d = spike_detail(3, 20.04, 60.0, Some(&check));
        assert_eq!(d["count"], 3);
        assert_eq!(d["baseline"], 20.0);
        assert_eq!(d["reasons"], json!(["rssiLow"]));
        assert_eq!(d["snap"]["hops"], json!([[1, 1.2, "lan"]]));
        assert_eq!(d["snap"]["conn"], "ethernet");
        assert_eq!(d["snap"]["rssi"], -66);
        let text = d.to_string();
        assert!(!text.contains("192.168"), "keine Stationsadresse: {text}");
        let bare = spike_detail(1, 20.0, 60.0, None);
        assert!(bare.get("snap").is_none());
        assert_eq!(bare["reasons"], json!([]));
    }

    #[test]
    fn timed_out_is_unknown() {
        let c = timed_out(7);
        assert_eq!((c.cause, c.snapshot.took_ms, c.reasons.len()), (LagCause::Unknown, SNAPSHOT_TIMEOUT_MS, 0));
    }
}
