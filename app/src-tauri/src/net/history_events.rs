//! `net_events_list` und `net_events_summary`: Ereignisse aus `net_events` lesen
//! (Anbieter-Protokoll, Ausreißer). Vertrag: `docs/API.md`, „Anbieter-Protokoll“.
//!
//! Gerüst (Phase 0a): liefert noch leere Listen (Umsetzung: F7).
#![allow(dead_code)]

use super::hist_types::{EventSummaryRow, EventsPage};
use crate::db::Db;
use crate::error::CmdResult;

/// Ereignisse mit `from <= t <= to` (optional nur bestimmte Arten, nur ein Netz), aufsteigend nach
/// `t`; mehr als `limit` → die neuesten `limit` und `truncated = true`. Unbekannte Arten werden
/// ignoriert. Zeitraum und `limit` sind schon geprüft.
pub fn list(db: &Db, from: i64, to: i64, kinds: Option<&[String]>, net_id: Option<&str>, limit: u32) -> CmdResult<EventsPage> {
    let _ = (db, from, to, kinds, net_id, limit);
    Ok(EventsPage { events: Vec::new(), truncated: false })
}

/// Zählungen ohne Grenze, gruppiert je UTC-Stunde, Art, Ursache, Umfang, Verbindung und Netz.
pub fn summary(db: &Db, from: i64, to: i64, net_id: Option<&str>) -> CmdResult<Vec<EventSummaryRow>> {
    let _ = (db, from, to, net_id);
    Ok(Vec::new())
}
