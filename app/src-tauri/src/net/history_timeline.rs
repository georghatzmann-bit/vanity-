//! `net_session_timeline`: Messwerte und Ereignisse einer Spielsitzung lesen (Match-Zeitleiste).
//! Vertrag: `docs/API.md`, „Match-Zeitleiste“.
//!
//! Gerüst (Phase 0a): liefert noch „Für diese Sitzung gibt es keine Messwerte.“ (Umsetzung: F2).
#![allow(dead_code)]

use super::hist_types::{SessionTimeline, NO_SAMPLES};
use crate::db::Db;
use crate::error::CmdResult;

/// Mehr Punkte werden zusammengefasst (12 h bei 1 s).
pub const MAX_POINTS: usize = 43_200;

/// Zeitleiste einer Sitzung aus `session_samples` und `net_events` (reine Datenbank).
pub fn session_timeline(db: &Db, session_id: i64) -> CmdResult<SessionTimeline> {
    let _ = (db, session_id);
    Err(NO_SAMPLES.into())
}
