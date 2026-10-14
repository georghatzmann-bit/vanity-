//! Ereignisse des Anbieter-Protokolls: `outage`, `loss`, `slow` (nie während der Ruhezeit, Lücken
//! und getrennte Verbindung ausgenommen) und die Anforderung der Umfangsprüfung. Vertrag:
//! `docs/API.md`, „Anbieter-Protokoll“.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; der Detektor meldet noch nichts
//! (Umsetzung: F7).
#![allow(dead_code)]

use crate::net::hist_types::{EventDraft, OutageScope};
use crate::net::ifstats::OperStatus;
use crate::net::link::PrimaryLinkLite;
use crate::net::scope::ScopeRequest;
use crate::net::types::{PingMethod, PingTarget};

/// Ein Takt des Hauptziels.
#[derive(Debug, Clone)]
pub struct EventTick<'a> {
    pub t: i64,
    pub rtt: Option<f64>,
    pub interval_ms: u64,
    pub target: &'a PingTarget,
    /// Tatsächlich benutzte Messart
    pub method: PingMethod,
    pub link: Option<&'a PrimaryLinkLite>,
    /// Zustand der Hauptverbindung im Takt (Trennung → `scope = pc`)
    pub status: Option<OperStatus>,
    pub session_id: Option<i64>,
    pub quiet: bool,
    /// `ispLog.slowMs`
    pub slow_ms: f64,
    /// Router-Grundwert des Lag-Detektivs (für die Umfangsprüfung)
    pub gateway_base: Option<f64>,
}

/// Erkennt Aussetzer, Verlust und langsame Minuten.
#[derive(Debug, Default)]
pub struct EventDetector {}

impl EventDetector {
    /// Takt verarbeiten; beim dritten Verlust in Folge kommt die Umfangsprüfung zurück.
    pub fn push(&mut self, tick: &EventTick<'_>) -> Option<ScopeRequest> {
        let _ = tick;
        None
    }

    /// Median des Ziels der letzten 14 Tage (für die relative `slow`-Schwelle; `None` = zu wenig
    /// Messstunden). Setzt der Kern nach dem Laden aus `ping_hourly`.
    pub fn set_target_median(&mut self, target_key: &str, net_id: &str, median: Option<f64>) {
        let _ = (target_key, net_id, median);
    }

    /// Ergebnis der Umfangsprüfung für den Aussetzer, der bei `outage_t` begann.
    pub fn on_scope(&mut self, outage_t: i64, scope: OutageScope) {
        let _ = (outage_t, scope);
    }

    /// Lücke: offene Ereignisse am letzten `t` schließen, Fenster leeren.
    pub fn gap(&mut self, last_t: i64) {
        let _ = last_t;
    }

    /// Stopp: offene Ereignisse schließen.
    pub fn close(&mut self, t: i64) {
        let _ = t;
    }

    /// Neue bzw. geänderte Ereignisse herausnehmen.
    pub fn take_drafts(&mut self) -> Vec<EventDraft> {
        Vec::new()
    }

    /// Alles verwerfen.
    pub fn clear(&mut self) {}
}
