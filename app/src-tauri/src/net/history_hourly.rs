//! `net_history_hourly`: Stunden-Summen aus `ping_hourly` lesen (Pulsar-Kalender, Anbieter-Protokoll).
//! Vertrag: `docs/API.md`, „Pulsar-Kalender“.
//!
//! Gerüst (Phase 0a): liefert noch eine leere Liste (Umsetzung: F3).
#![allow(dead_code)]

use super::hist_types::HourlyRow;
use crate::db::Db;
use crate::error::CmdResult;

/// Zeilen mit `from <= hourStart <= to`, optional nur ein Ziel bzw. ein Netz, nach `hourStart`
/// sortiert. Der Zeitraum ist schon geprüft (`hist_types::check_range`).
pub fn hourly(db: &Db, from: i64, to: i64, target_key: Option<&str>, net_id: Option<&str>) -> CmdResult<Vec<HourlyRow>> {
    let _ = (db, from, to, target_key, net_id);
    Ok(Vec::new())
}
