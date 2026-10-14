//! Byte-Zähler der Hauptverbindung (`GetIfEntry2`, ohne Adminrechte) und CPU-Last für den
//! Lag-Detektiv und die Zeitleiste. Vertrag: `docs/API.md`, „Lag-Detektiv“ (`IfCounters`,
//! „Ringpuffer Datenverkehr“).
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; Werte bleiben `None` (Umsetzung: F1).
#![allow(dead_code)]

use serde::Serialize;

use super::NetState;

/// Zustand der Schnittstelle aus `GetIfEntry2` (für die Umfangsprüfung von Aussetzern).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperStatus {
    /// `OperStatus == IfOperStatusUp`
    pub up: bool,
    /// `MediaConnectState == MediaConnectStateConnected`
    pub media_connected: bool,
}

impl OperStatus {
    /// Verbindung steht (beides „an“).
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

/// Misst je Takt Byte-Zähler und CPU (eigene `sysinfo`-Instanz) und hält den Ringpuffer
/// (6 Minuten, höchstens 1440 Einträge). Liegt in `NetState.load`.
#[derive(Debug, Default)]
pub struct LoadSampler {
    /// LUID der Hauptverbindung (aus `PrimaryLink`; `None` = keine)
    luid: Option<u64>,
}

impl LoadSampler {
    /// Hauptverbindung setzen (nach jedem `link::refresh`). Ein Wechsel startet den Ringpuffer neu.
    pub fn set_luid(&mut self, luid: Option<u64>) {
        self.luid = luid;
    }

    /// Einen Takt messen (< 1 ms, außerhalb der Recorder-Sperre).
    pub fn sample(&mut self, now: i64) -> LoadSample {
        LoadSample { at: now, ..Default::default() }
    }

    /// Datenverkehr `(rx, tx)` in Mbit/s aus dem Ringpuffer (Fenster wie oben).
    pub fn rates(&self, now: i64) -> (Option<f64>, Option<f64>) {
        let _ = now;
        (None, None)
    }

    /// Grundwert Datenverkehr: Median (rx + tx) der letzten 5 Minuten ohne die letzten 10 s.
    pub fn traffic_baseline(&self, now: i64) -> Option<f64> {
        let _ = now;
        None
    }

    /// Letzte CPU-Last (eigene Instanz, kein neuer Aufruf).
    pub fn cpu(&self) -> Option<f32> {
        None
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

/// `net_if_counters`: Zähler der Hauptverbindung (synchron und kurz, kein Netz). `None` ohne
/// Hauptverbindung, bei Fehler und außerhalb von Windows.
pub fn counters(net: &NetState, now: i64) -> Option<IfCounters> {
    let _ = (net, now);
    None
}
