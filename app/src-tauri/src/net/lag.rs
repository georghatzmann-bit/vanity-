//! Lag-Detektiv: Ausreißer-Regel, Momentaufnahme und eingeschätzte Ursache. Vertrag:
//! `docs/API.md`, „Lag-Detektiv“.
//!
//! Gerüst (Phase 0a): Typen, Ausreißer-Regel (gleich `countSpikes`/`isLiveSpike` in
//! `app/src/lib/grade.ts`, gemeinsame Prüfdaten `app/src/lib/fixtures/spikes.json`) und Speicher der
//! letzten 20 Ereignisse sind fertig. `classify_cause` und `run_snapshot` liefern noch „unklar“
//! ohne Messung (Umsetzung: F1).
#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::hist_types::TargetKind;
use super::link::LinkKind;
use super::quickhops::QuickHop;
use super::types::PingTarget;
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

/// Anzahl Ausreißer einer Messreihe (`rtt > limit`, echt größer; Verluste nie).
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

/// Ursachen-Entscheidung (rein, erste passende Zeile der Vertragstabelle gewinnt).
pub fn classify_cause(input: &LagInput) -> (LagCause, Vec<Reason>) {
    let _ = input;
    (LagCause::Unknown, Vec::new())
}

/// `cpuHigh` = CPU-Last ≥ 90 % (nur Hinweis, keine Ursache).
pub fn cpu_high(cpu: Option<f64>) -> bool {
    cpu.is_some_and(|c| c >= 90.0)
}

// =============================================================================================
// Momentaufnahme
// =============================================================================================

/// Was die Momentaufnahme messen soll.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPlan {
    /// Schon aufgelöste IPv4 des Messziels (keine neue Namensauflösung)
    pub dst: Option<Ipv4Addr>,
    /// Messziel (Methode und Zeitlimit wie beim Monitor)
    pub target: Option<PingTarget>,
    /// Ausreißer-Grenze (`None` = auf Wunsch, Ziel nur gemessen)
    pub limit: Option<f64>,
    /// `false` = Ruhe-Messung ohne Zielmessung (nur Grundwerte)
    pub measure_target: bool,
}

/// Gesamtzeit einer Momentaufnahme (ms).
pub const SNAPSHOT_TIMEOUT_MS: u64 = 1500;

/// Momentaufnahme ausführen und einschätzen. Nie ein Fehler: fehlende Teile bleiben `None`.
/// Wird vom Hook bzw. vom Befehl per `spawn` gestartet (der Monitor-Takt wartet nie darauf).
pub async fn run_snapshot(core: Shared, plan: SnapshotPlan, now: i64) -> LagCheck {
    let _ = (core, plan);
    LagCheck { at: now, cause: LagCause::Unknown, cpu_high: false, reasons: Vec::new(), snapshot: LagSnapshot::off(now) }
}

/// `net_lag_snapshot`: Namensauflösung höchstens 300 ms, dann [`run_snapshot`] mit `limit = None`.
pub async fn snapshot_on_demand(core: Shared, target: PingTarget) -> LagCheck {
    let now = crate::util::now_ms();
    let plan = SnapshotPlan { dst: None, target: Some(target), limit: None, measure_target: true };
    run_snapshot(core, plan, now).await
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
    use serde_json::Value;

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
}
