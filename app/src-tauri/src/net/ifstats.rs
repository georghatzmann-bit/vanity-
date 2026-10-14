//! Byte-Zähler der Hauptverbindung (`GetIfEntry2`, ohne Adminrechte) und CPU-Last für den
//! Lag-Detektiv und die Zeitleiste. Vertrag: `docs/API.md`, „Lag-Detektiv“ (`IfCounters`,
//! „Ringpuffer Datenverkehr“).
//!
//! Nur die **Summe des Adapters** („Datenverkehr auf diesem PC“) – welches Programm ihn verursacht,
//! sieht Pulsar nicht (das bräuchte ETW bzw. Adminrechte).

use std::collections::VecDeque;

use serde::Serialize;

use super::NetState;
use crate::error::LockExt;

/// Ringpuffer: Einträge der letzten 6 Minuten …
pub const RING_SPAN_MS: i64 = 6 * 60_000;
/// … höchstens so viele (6 min bei 250 ms Takt).
pub const RING_MAX: usize = 1440;
/// Fenster „Datenverkehr vor dem Ausreißer“: mindestens 3 s (sonst die letzten 2 Einträge).
pub const RATE_WINDOW_MS: i64 = 3_000;
/// Kürzere Fenster ergeben keinen Wert.
pub const RATE_MIN_SPAN_MS: i64 = 500;
/// Grundwert Datenverkehr: die letzten 5 Minuten …
pub const BASELINE_SPAN_MS: i64 = 5 * 60_000;
/// … ohne die letzten 10 s.
pub const BASELINE_SKIP_MS: i64 = 10_000;

/// Zustand der Schnittstelle aus `GetIfEntry2` (für die Umfangsprüfung von Aussetzern).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperStatus {
    /// `OperStatus == IfOperStatusUp`
    pub up: bool,
    /// `MediaConnectState == MediaConnectStateConnected`
    pub media_connected: bool,
}

impl OperStatus {
    /// Verbindung steht (beides „an“). Benutzt von der Umfangsprüfung (`scope.rs`).
    #[allow(dead_code)]
    pub fn connected(&self) -> bool {
        self.up && self.media_connected
    }
}

/// Ein Monitor-Takt: Last zum Zeitpunkt `at`. `None` = unbekannt.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadSample {
    pub at: i64,
    /// CPU-Last 0–100 %
    pub cpu: Option<f32>,
    /// Datenverkehr des Adapters (Fenster `max(3 s, die letzten 2 Einträge)`)
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
    /// Zustand der Hauptverbindung (`None` ohne Hauptverbindung oder außerhalb von Windows)
    pub status: Option<OperStatus>,
}

/// Mbit/s aus einer Zähler-Differenz.
fn mbps(delta_bytes: u64, delta_ms: i64) -> f64 {
    (delta_bytes as f64) * 8.0 / (delta_ms as f64 / 1000.0) / 1_000_000.0
}

/// Ein Eintrag im Ringpuffer.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Entry {
    at: i64,
    rx: u64,
    tx: u64,
}

/// Zeitbegrenzter Ringpuffer der Byte-Zähler (rein, testbar).
#[derive(Debug, Default, Clone)]
pub struct Ring {
    entries: VecDeque<Entry>,
}

impl Ring {
    /// Neu beginnen (Zähler gesunken, Hauptverbindung gewechselt, `GetIfEntry2` gescheitert).
    pub fn reset(&mut self) {
        self.entries.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Zählerstand anhängen. Sinkt ein Zähler oder läuft die Uhr zurück, beginnt die Reihe neu (kein
    /// Wert statt eines falschen).
    pub fn push(&mut self, at: i64, rx: u64, tx: u64) {
        if let Some(last) = self.entries.back() {
            if rx < last.rx || tx < last.tx || at < last.at {
                self.entries.clear();
            } else if at == last.at {
                // Gleiche Zeit: nur den neueren Stand behalten
                self.entries.pop_back();
            }
        }
        self.entries.push_back(Entry { at, rx, tx });
        let cutoff = at - RING_SPAN_MS;
        while self.entries.front().is_some_and(|e| e.at < cutoff) {
            self.entries.pop_front();
        }
        while self.entries.len() > RING_MAX {
            self.entries.pop_front();
        }
    }

    /// Ist die Reihe veraltet (Monitor läuft nicht mehr)? Wie die Lückenregel: mehr als
    /// `max(3 × letzter Abstand, 5 s)` seit dem letzten Eintrag.
    fn stale(&self, now: i64) -> bool {
        let n = self.entries.len();
        let (Some(last), Some(prev)) = (self.entries.back(), n.checked_sub(2).and_then(|i| self.entries.get(i))) else { return true };
        let step = (last.at - prev.at).max(0);
        now < last.at || now - last.at > step.saturating_mul(3).max(5_000)
    }

    /// Datenverkehr `(rx, tx)` in Mbit/s über das Fenster `max(3 s, die letzten 2 Einträge)`; nur mit
    /// `Δt >= 0,5 s`, sonst `None`. Veraltet (Monitor läuft nicht) → `None`.
    pub fn rates(&self, now: i64) -> (Option<f64>, Option<f64>) {
        if self.stale(now) {
            return (None, None);
        }
        let Some(last) = self.entries.back().copied() else { return (None, None) };
        let n = self.entries.len();
        // Der jüngste Eintrag, der mindestens 3 s vor dem letzten liegt – sonst der älteste
        let start = self.entries.iter().take(n - 1).rev().find(|e| last.at - e.at >= RATE_WINDOW_MS).or_else(|| self.entries.front()).copied();
        let Some(start) = start.filter(|s| *s != last) else { return (None, None) };
        let dt = last.at - start.at;
        if dt < RATE_MIN_SPAN_MS {
            return (None, None);
        }
        (Some(mbps(last.rx.saturating_sub(start.rx), dt)), Some(mbps(last.tx.saturating_sub(start.tx), dt)))
    }

    /// Grundwert Datenverkehr: Median (rx + tx, Mbit/s) der Ringpuffer-Werte der letzten 5 Minuten
    /// ohne die letzten 10 s. Werte unter 1 s Takt werden auf mindestens 1 s zusammengefasst.
    pub fn baseline(&self, now: i64) -> Option<f64> {
        let from = now - BASELINE_SPAN_MS;
        let to = now - BASELINE_SKIP_MS;
        let mut values = Vec::new();
        let mut start: Option<Entry> = None;
        for e in self.entries.iter().copied().filter(|e| e.at >= from && e.at <= to) {
            match start {
                None => start = Some(e),
                Some(s) if e.at - s.at >= 1_000 => {
                    values.push(mbps(e.rx.saturating_sub(s.rx) + e.tx.saturating_sub(s.tx), e.at - s.at));
                    start = Some(e);
                }
                Some(_) => {}
            }
        }
        super::ping::median(&values)
    }
}

/// Eine Lesung von `GetIfEntry2`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IfRead {
    pub rx: u64,
    pub tx: u64,
    pub status: OperStatus,
}

/// Zähler einer Schnittstelle lesen (kurz, ohne Netz). `None` bei Fehler (z. B. Adapter weg) und
/// außerhalb von Windows.
pub fn read_if(luid: u64) -> Option<IfRead> {
    #[cfg(windows)]
    {
        use windows::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
        use windows::Win32::NetworkManagement::Ndis::{IfOperStatusUp, MediaConnectStateConnected, NET_LUID_LH};
        let mut row = MIB_IF_ROW2 { InterfaceLuid: NET_LUID_LH { Value: luid }, ..Default::default() };
        // SAFETY: `row` ist vollständig angelegt, die LUID gesetzt; Windows füllt die Zeile.
        let ret = unsafe { GetIfEntry2(&mut row) };
        if ret.0 != 0 {
            return None;
        }
        Some(IfRead {
            rx: row.InOctets,
            tx: row.OutOctets,
            status: OperStatus { up: row.OperStatus == IfOperStatusUp, media_connected: row.MediaConnectState == MediaConnectStateConnected },
        })
    }
    #[cfg(not(windows))]
    {
        let _ = luid;
        None
    }
}

/// CPU-Last über eine eigene `sysinfo`-Instanz (nur `refresh_cpu_usage`; das Dashboard bleibt
/// unberührt). Der erste Wert ist erst nach der zweiten Auffrischung gültig.
#[derive(Debug, Default)]
struct Cpu {
    sys: Option<sysinfo::System>,
    last_refresh: Option<std::time::Instant>,
    primed: bool,
    value: Option<f32>,
}

impl Cpu {
    fn sample(&mut self) -> Option<f32> {
        let now = std::time::Instant::now();
        if self.last_refresh.is_some_and(|t| now.duration_since(t) < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL) {
            return self.value;
        }
        let sys = self.sys.get_or_insert_with(sysinfo::System::new);
        sys.refresh_cpu_usage();
        self.last_refresh = Some(now);
        if self.primed {
            let v = sys.global_cpu_usage();
            self.value = v.is_finite().then(|| v.clamp(0.0, 100.0));
        }
        self.primed = true;
        self.value
    }
}

/// Misst je Takt Byte-Zähler und CPU (eigene `sysinfo`-Instanz) und hält den Ringpuffer
/// (6 Minuten, höchstens 1440 Einträge). Liegt in `NetState.load`.
#[derive(Debug, Default)]
pub struct LoadSampler {
    /// LUID der Hauptverbindung (aus `PrimaryLink`; `None` = keine)
    luid: Option<u64>,
    ring: Ring,
    cpu: Cpu,
}

impl LoadSampler {
    /// Hauptverbindung setzen (nach jedem `link::refresh`). Ein Wechsel startet den Ringpuffer neu.
    pub fn set_luid(&mut self, luid: Option<u64>) {
        let luid = luid.filter(|l| *l != 0);
        if luid != self.luid {
            self.ring.reset();
        }
        self.luid = luid;
    }

    /// Einen Takt messen (< 1 ms, außerhalb der Recorder-Sperre).
    pub fn sample(&mut self, now: i64) -> LoadSample {
        let cpu = self.cpu.sample();
        self.sample_with(now, cpu, read_if)
    }

    /// Wie [`sample`](Self::sample), mit eingespeister Zähler-Lesung (Tests).
    fn sample_with(&mut self, now: i64, cpu: Option<f32>, read: impl Fn(u64) -> Option<IfRead>) -> LoadSample {
        let status = match self.luid.and_then(read) {
            Some(r) => {
                self.ring.push(now, r.rx, r.tx);
                Some(r.status)
            }
            None => {
                self.ring.reset();
                None
            }
        };
        let (rx_mbps, tx_mbps) = self.ring.rates(now);
        LoadSample { at: now, cpu, rx_mbps, tx_mbps, status }
    }

    /// Datenverkehr `(rx, tx)` in Mbit/s aus dem Ringpuffer (Fenster wie oben).
    pub fn rates(&self, now: i64) -> (Option<f64>, Option<f64>) {
        self.ring.rates(now)
    }

    /// Grundwert Datenverkehr: Median (rx + tx) der letzten 5 Minuten ohne die letzten 10 s.
    pub fn traffic_baseline(&self, now: i64) -> Option<f64> {
        self.ring.baseline(now)
    }

    /// Letzte CPU-Last (eigene Instanz, kein neuer Aufruf).
    pub fn cpu(&self) -> Option<f32> {
        self.cpu.value
    }
}

/// Ergebnis von `net_if_counters`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IfCounters {
    /// GUID der Hauptverbindung
    pub adapter_id: String,
    /// Name der Hauptverbindung
    pub adapter: String,
    /// Zähler seit Windows-Start (`InOctets`/`OutOctets`)
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub at: i64,
    /// Aus dem Ringpuffer; `None`, wenn der Monitor nicht läuft
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
}

/// `net_if_counters`: Zähler der Hauptverbindung (synchron und kurz, kein Netz). Liest nur die
/// gemerkte Hauptverbindung (`NetState.link`; ermittelt sie bei Bedarf vorher der Befehl über
/// `lag::ensure_link`). `None` ohne Hauptverbindung, bei Fehler und außerhalb von Windows.
pub fn counters(net: &NetState, now: i64) -> Option<IfCounters> {
    if !cfg!(windows) {
        return None;
    }
    let link = net.link.lock_safe().clone().filter(|l| l.luid != 0)?;
    let read = read_if(link.luid)?;
    let (rx_mbps, tx_mbps) = net.load.lock_safe().rates(now);
    Some(IfCounters { adapter_id: link.adapter_id, adapter: link.adapter, rx_bytes: read.rx, tx_bytes: read.tx, at: now, rx_mbps, tx_mbps })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gleichmäßiger Verkehr im Takt `step`: der Zählerstand bei `t` enthält den Verkehr des
    /// Abschnitts davor.
    fn feed(ring: &mut Ring, from: i64, to: i64, step: i64, rx_mbps: f64, tx_mbps: f64, start: (u64, u64)) -> (u64, u64) {
        let (mut rx, mut tx) = start;
        let mut t = from;
        while t <= to {
            rx += (rx_mbps * 1_000_000.0 / 8.0 * step as f64 / 1000.0) as u64;
            tx += (tx_mbps * 1_000_000.0 / 8.0 * step as f64 / 1000.0) as u64;
            ring.push(t, rx, tx);
            t += step;
        }
        (rx, tx)
    }

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|v| (v - b).abs() < 0.05)
    }

    #[test]
    fn throughput_from_ring() {
        let mut r = Ring::default();
        feed(&mut r, 0, 20_000, 250, 24.0, 3.0, (1_000, 2_000));
        let (rx, tx) = r.rates(20_000);
        assert!(close(rx, 24.0) && close(tx, 3.0), "{rx:?} {tx:?}");
        // Nur ein Eintrag oder zu kurzes Fenster → kein Wert
        let mut one = Ring::default();
        one.push(0, 10, 10);
        assert_eq!(one.rates(0), (None, None));
        one.push(300, 20, 20);
        assert_eq!(one.rates(300), (None, None), "Δt < 0,5 s");
        one.push(600, 30, 30);
        assert!(one.rates(600).0.is_some(), "0,6 s über die ganze Reihe");
        // Monitor gestoppt: Reihe veraltet
        assert_eq!(r.rates(40_000), (None, None));
        // Zeitbegrenzt: 6 Minuten, höchstens 1440
        let mut long = Ring::default();
        feed(&mut long, 0, 30 * 60_000, 250, 1.0, 1.0, (0, 0));
        assert!(long.len() <= RING_MAX);
        let mut slow = Ring::default();
        feed(&mut slow, 0, 30 * 60_000, 10_000, 1.0, 1.0, (0, 0));
        assert_eq!(slow.len(), 37, "6 Minuten bei 10 s Takt");
    }

    #[test]
    fn counter_reset_gives_none() {
        let mut r = Ring::default();
        let (rx, tx) = feed(&mut r, 0, 10_000, 1_000, 8.0, 1.0, (1_000_000, 1_000_000));
        assert!(r.rates(10_000).0.is_some());
        // Zähler sinkt (Adapter neu gestartet) → Reihe beginnt neu, kein Wert
        r.push(11_000, rx / 2, tx);
        assert_eq!(r.len(), 1);
        assert_eq!(r.rates(11_000), (None, None));
        // Sampler: Lesefehler (Adapter weg) startet die Reihe neu; Wechsel der LUID ebenso
        let mut s = LoadSampler::default();
        s.set_luid(Some(5));
        let ok = |_: u64| Some(IfRead { rx: 10, tx: 10, status: OperStatus { up: true, media_connected: true } });
        s.sample_with(0, None, ok);
        let x = s.sample_with(1_000, Some(12.0), ok);
        assert_eq!(x.status.map(|st| st.connected()), Some(true));
        assert_eq!(x.cpu, Some(12.0));
        assert_eq!(s.ring.len(), 2);
        let gone = s.sample_with(2_000, None, |_| None);
        assert_eq!((gone.status, gone.rx_mbps, s.ring.len()), (None, None, 0));
        s.sample_with(3_000, None, ok);
        s.set_luid(Some(6));
        assert_eq!(s.ring.len(), 0, "andere Hauptverbindung");
        s.set_luid(None);
        let none = s.sample_with(4_000, None, ok);
        assert_eq!(none.status, None, "ohne Hauptverbindung kein Zustand");
    }

    #[test]
    fn baseline_5min_at_250ms_and_10s() {
        for step in [250, 10_000] {
            let mut r = Ring::default();
            // 6 Minuten ruhig (2 + 1 Mbit/s), dann 10 s Download mit 80 Mbit/s
            let end_quiet = 6 * 60_000;
            let start = feed(&mut r, 0, end_quiet, step, 2.0, 1.0, (0, 0));
            feed(&mut r, end_quiet + step, end_quiet + 10_000, step, 80.0, 1.0, start);
            let now = end_quiet + 10_000;
            let base = r.baseline(now);
            assert!(close(base, 3.0), "Takt {step}: {base:?}");
            // Der Ausreißer-Moment selbst ist sichtbar
            let (rx, _) = r.rates(now);
            assert!(rx.is_some_and(|v| v > 40.0), "Takt {step}: {rx:?}");
        }
        assert_eq!(Ring::default().baseline(0), None);
    }

    #[test]
    fn window_at_10s_interval() {
        let mut r = Ring::default();
        feed(&mut r, 0, 60_000, 10_000, 16.0, 4.0, (0, 0));
        // Fenster = die letzten 2 Einträge (10 s)
        let (rx, tx) = r.rates(60_000);
        assert!(close(rx, 16.0) && close(tx, 4.0));
        // 25 s nach dem letzten Eintrag: noch nicht veraltet (3 × 10 s), danach schon
        assert!(r.rates(85_000).0.is_some());
        assert_eq!(r.rates(91_000), (None, None));
        // Uhr zurück → neu
        r.push(5_000, 1, 1);
        assert_eq!(r.len(), 1);
    }
}
