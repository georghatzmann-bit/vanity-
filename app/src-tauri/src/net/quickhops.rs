//! Schnelle Teilroute für den Lag-Detektiv: TTL 1–3 parallel per ICMP, ohne Reverse-DNS, und die
//! Zonenregel der Teilroute (gleiche Regel in `app/src/lib/zones.ts`, Prüfdaten
//! `app/src/lib/fixtures/zones.json`). Vertrag: `docs/API.md`, „Lag-Detektiv“.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; `quick_hops` liefert noch eine leere Liste
//! (Umsetzung: F1). `trace::win::run` und `ZoneTracker` bleiben unverändert.
#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Zone einer Station.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Lan,
    Isp,
    Internet,
    Target,
}

/// Eine Station der Teilroute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickHop {
    pub ttl: u8,
    /// Adresse der Station (`None` = keine Antwort). Nur live, nie gespeichert.
    pub address: Option<String>,
    /// Kleinere von 2 Antworten (ms)
    pub rtt: Option<f64>,
    /// `None` = stumme Station
    pub zone: Option<Zone>,
    /// Anbieter-Station hinter Carrier-NAT (Anzeige „Anbieter (CGNAT)“)
    pub cgnat: bool,
    /// Grundwert aus den Ruhe-Messungen (ms)
    pub base_ms: Option<f64>,
}

/// Standard: Stationen 1–3.
pub const DEFAULT_HOPS: u8 = 3;
/// Zeitlimit je Echo.
pub const HOP_TIMEOUT: Duration = Duration::from_millis(600);

/// TTL 1..=n parallel, je 2 Echos (`spawn_blocking`). Außerhalb von Windows → leere Liste.
pub async fn quick_hops(dst: Ipv4Addr, n: u8, timeout: Duration) -> Vec<QuickHop> {
    let _ = (dst, n, timeout);
    Vec::new()
}

/// Zonenregel der Teilroute (rein): Stationen in TTL-Reihenfolge → Zone (`None` = stumm).
pub fn zones(addrs: &[Option<IpAddr>], gateway: Option<Ipv4Addr>) -> Vec<Option<Zone>> {
    let _ = gateway;
    vec![None; addrs.len()]
}
