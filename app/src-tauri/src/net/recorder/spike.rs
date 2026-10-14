//! Live-Ausreißer des Hauptziels: Erkennung, Drosselung (eine Momentaufnahme je 10 s, `count`),
//! zweites `net://lag`, Ruhe-Messung alle 60 s und `spike`-Ereignisse (Lag-Detektiv). Vertrag:
//! `docs/API.md`, „Lag-Detektiv“.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; der Detektor meldet noch nichts
//! (Umsetzung: F1).
#![allow(dead_code)]

use std::net::Ipv4Addr;

use super::SnapshotRequest;
use crate::net::hist_types::EventDraft;
use crate::net::lag::LagEvent;
use crate::net::link::PrimaryLinkLite;
use crate::net::types::PingTarget;

/// Höchstens eine Momentaufnahme (und ein `spike`-Eintrag) je so viele ms.
pub const THROTTLE_MS: i64 = 10_000;
/// Ruhe-Messung höchstens so oft (ms), frühestens 10 s nach dem letzten Ausreißer.
pub const IDLE_EVERY_MS: i64 = 60_000;

/// Ein Takt des Hauptziels.
#[derive(Debug, Clone)]
pub struct SpikeTick<'a> {
    pub t: i64,
    pub rtt: Option<f64>,
    /// Eigenes Fenster des Recorders (höchstens 60 Werte, endet mit `rtt`)
    pub window: &'a [Option<f64>],
    pub target: &'a PingTarget,
    /// Vom Monitor aufgelöste IPv4 (keine → keine Momentaufnahme mit Ziel/Teilroute)
    pub dst: Option<Ipv4Addr>,
    /// Ruhezeit (Pulsars eigener Speedtest/WLAN-Scan)
    pub quiet: bool,
    pub session_id: Option<i64>,
    pub link: Option<&'a PrimaryLinkLite>,
    /// `lag.snapshots`
    pub snapshots: bool,
}

/// Ergebnis eines Takts.
#[derive(Debug, Clone, Default)]
pub struct SpikeOutcome {
    /// Der Wert war ein Ausreißer (auch während der Drosselung)
    pub spike: bool,
    /// Momentaufnahme starten (Ausreißer oder Ruhe-Messung)
    pub snapshot: Option<SnapshotRequest>,
    /// Zweites `net://lag` am Ende des 10-s-Fensters (endgültiges `count`)
    pub lag_update: Option<LagEvent>,
}

/// Erkennt Ausreißer und sammelt `spike`-Ereignisse.
#[derive(Debug, Default)]
pub struct SpikeDetector {}

impl SpikeDetector {
    pub fn push(&mut self, tick: &SpikeTick<'_>) -> SpikeOutcome {
        let _ = tick;
        SpikeOutcome::default()
    }

    /// Ergebnis der Momentaufnahme übernehmen (Ursache, Detail des `spike`-Eintrags).
    pub fn on_snapshot(&mut self, ev: &LagEvent) {
        let _ = ev;
    }

    /// Offenes 10-s-Fenster schließen (Stopp, Lücke).
    pub fn close(&mut self, t: i64) {
        let _ = t;
    }

    /// Neue bzw. geänderte `spike`-Ereignisse herausnehmen.
    pub fn take_drafts(&mut self) -> Vec<EventDraft> {
        Vec::new()
    }

    /// Alles verwerfen.
    pub fn clear(&mut self) {}
}
