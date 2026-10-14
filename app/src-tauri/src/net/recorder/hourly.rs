//! Stunden-Summen je Ziel, Netz und Verbindungsart (`ping_hourly`, Pulsar-Kalender). Vertrag:
//! `docs/API.md`, „Datenbank v2“ und „Pulsar-Kalender“.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; `HourlyAcc` sammelt noch nichts
//! (Umsetzung: F3).
#![allow(dead_code)]

use crate::net::hist_types::{ConnectionKind, HourlyRow, TargetKind};
use crate::net::types::PingMethod;

/// Eine Stunde in ms.
pub const HOUR_MS: i64 = 3_600_000;

/// Auf die volle Stunde (UTC) abrunden.
pub fn hour_start(t: i64) -> i64 {
    t.div_euclid(HOUR_MS) * HOUR_MS
}

/// Wozu eine Stundenzeile gehört.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HourKey {
    pub target_key: String,
    pub label: String,
    pub kind: TargetKind,
    pub method: PingMethod,
    pub net_id: String,
    pub connection: ConnectionKind,
}

/// Sammelt Stunden-Deltas (Jitter und `covered_ms` auch über Schreibgrenzen hinweg).
#[derive(Debug, Default)]
pub struct HourlyAcc {}

impl HourlyAcc {
    /// Messwert eines Ziels (`spike` = Live-Ausreißer-Regel hat angeschlagen).
    pub fn push(&mut self, key: &HourKey, t: i64, rtt: Option<f64>, spike: bool, interval_ms: u64) {
        let _ = (key, t, rtt, spike, interval_ms);
    }

    /// Lücke (Standby, Uhr): kein Jitter und keine Messzeit über die Lücke hinweg.
    pub fn gap(&mut self) {}

    /// Gesammelte Deltas herausnehmen (Upsert addiert sie in der Datenbank).
    pub fn take(&mut self) -> Vec<HourlyRow> {
        Vec::new()
    }

    /// Nach einem fehlgeschlagenen Schreiben wieder einreihen.
    pub fn requeue(&mut self, rows: Vec<HourlyRow>) {
        let _ = rows;
    }

    /// Alles verwerfen.
    pub fn clear(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hour_start_rounds_down_utc() {
        assert_eq!(hour_start(0), 0);
        assert_eq!(hour_start(3_599_999), 0);
        assert_eq!(hour_start(3_600_000), 3_600_000);
        assert_eq!(hour_start(-1), -3_600_000);
    }
}
