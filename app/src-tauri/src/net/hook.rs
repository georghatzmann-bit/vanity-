//! Der Monitor-Hook: führt die Aufträge aus, die `Recorder::ingest` zurückgibt (Schreiben,
//! Hauptverbindung erneuern, Momentaufnahme, Umfangsprüfung, zweites `net://lag`). Alles per
//! `spawn`/`spawn_blocking` – der Monitor-Takt wartet nie darauf. Vertrag: `docs/API.md`,
//! „Aufzeichnung“ und „Sperr-Reihenfolge und Laufzeit“.
//!
//! Gerüst (Phase 0a): tut noch nichts (Umsetzung: Datenbasis-Kern, Phase 0b).

use tauri::AppHandle;

use super::recorder::IngestActions;
use crate::state::Shared;

/// Aufträge eines Takts ausführen (kehrt sofort zurück).
pub fn run_actions(app: &AppHandle, core: Shared, actions: IngestActions) {
    let _ = (app, core, actions);
}
