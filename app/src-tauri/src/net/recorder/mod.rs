//! Aufzeichnung des Netzwerk-Verlaufs im Monitor-Takt (Datenbank v2). Vertrag: `docs/API.md`,
//! „Datenbank v2“ und „Aufzeichnung“.
//!
//! Aufteilung: `mod.rs` (Kern: Takt, Puffer, Lückenregel, Schreiben), `chunk.rs` (Block-Format,
//! Match-Zeitleiste), `hourly.rs` (Stunden-Summen, Kalender), `spike.rs` (Live-Ausreißer,
//! Lag-Detektiv), `events.rs` (outage/loss/slow, Anbieter-Protokoll).
//!
//! `ingest` und alle Recorder-Methoden sind **rein** (keine Ein-/Ausgabe, keine Sperren, kein
//! Spawn); das Schreiben übernimmt [`flush_now`] bzw. der Hook.
//!
//! Gerüst (Phase 0a): Signaturen stehen fest, `apply_settings` ist fertig; `ingest` liefert noch
//! keine Aufträge und es wird nichts geschrieben (Umsetzung: Datenbasis-Kern, Phase 0b).
#![allow(dead_code)]

pub mod chunk;
pub mod events;
pub mod hourly;
pub mod spike;

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde_json::Value;

use super::hist_types::{ClearScope, OutageScope};
use super::ifstats::LoadSample;
use super::lag::LagEvent;
use super::link::PrimaryLinkLite;
use super::scope::ScopeRequest;
use super::types::{PingSample, PingTarget, SpeedResult};
use crate::db::DbHandle;
use crate::error::{CmdResult, LockExt};
use crate::state::Core;

/// Was der Hook vor `ingest` aus den kleinen Sperren/Atomics liest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IngestCtx {
    /// `now < quiet_until` (Pulsars eigener Speedtest/WLAN-Scan)
    pub quiet: bool,
    /// Aktuelle Spielsitzung `(session_id, started_at)`
    pub session: Option<(i64, i64)>,
    /// Zwischengespeicherte Hauptverbindung
    pub link: Option<PrimaryLinkLite>,
}

/// Auftrag für eine Momentaufnahme des Lag-Detektivs.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotRequest {
    /// Vom Monitor schon aufgelöste IPv4 des Messziels
    pub dst: Ipv4Addr,
    pub target: PingTarget,
    /// Antwortzeit des Ausreißers (ms)
    pub rtt: f64,
    /// Median des Fensters
    pub baseline: f64,
    /// Ausreißer-Grenze
    pub limit: f64,
    pub at: i64,
    /// `true` = Ruhe-Messung (Grundwerte, ohne Zielmessung, kein `net://lag`)
    pub idle: bool,
}

/// Aufträge eines Takts an den Hook.
#[derive(Debug, Clone, Default)]
pub struct IngestActions {
    pub snapshot: Option<SnapshotRequest>,
    pub scope_check: Option<ScopeRequest>,
    /// Spätestens alle 60 s schreiben
    pub flush_due: bool,
    /// Hauptverbindung neu ermitteln (höchstens alle 30 s)
    pub refresh_link: bool,
    /// Zweites `net://lag` mit dem endgültigen `count`
    pub lag_update: Option<LagEvent>,
}

/// Die Einstellungen, die der Recorder liest (tolerant aus kv `settings`).
#[derive(Debug, Clone, PartialEq)]
pub struct RecorderSettings {
    /// `history.record` – aus: nichts in die Datenbank schreiben, Puffer verwerfen
    pub record: bool,
    /// `ispLog.slowMs` (30–1000)
    pub slow_ms: f64,
    /// `lag.snapshots`
    pub snapshots: bool,
    /// `ispLog.contractDownMbps` / `contractUpMbps` (Bezug für „Leitung voll“, wenn kein Speedtest)
    pub contract_down_mbps: Option<f64>,
    pub contract_up_mbps: Option<f64>,
}

impl Default for RecorderSettings {
    fn default() -> Self {
        RecorderSettings { record: true, slow_ms: 100.0, snapshots: true, contract_down_mbps: None, contract_up_mbps: None }
    }
}

impl RecorderSettings {
    /// Aus dem Einstellungs-JSON lesen; fehlender oder falscher Typ = Standardwert, nie ein Fehler.
    pub fn from_value(v: &Value) -> Self {
        let d = RecorderSettings::default();
        let bool_at = |ns: &str, key: &str, def: bool| v.get(ns).and_then(|o| o.get(key)).and_then(Value::as_bool).unwrap_or(def);
        let num_at = |ns: &str, key: &str| v.get(ns).and_then(|o| o.get(key)).and_then(Value::as_f64).filter(|x| x.is_finite());
        let mbps = |key: &str| num_at("ispLog", key).filter(|x| *x >= 1.0 && *x <= 10_000.0);
        RecorderSettings {
            record: bool_at("history", "record", d.record),
            slow_ms: num_at("ispLog", "slowMs").map_or(d.slow_ms, |x| x.clamp(30.0, 1000.0)),
            snapshots: bool_at("lag", "snapshots", d.snapshots),
            contract_down_mbps: mbps("contractDownMbps"),
            contract_up_mbps: mbps("contractUpMbps"),
        }
    }
}

/// Schreib-Koordination (außerhalb der Recorder-Sperre, in `NetState.flush`): höchstens ein
/// Hintergrund-Flush gleichzeitig; Lesebefehle warten über `write_lock` auf einen laufenden Flush.
#[derive(Debug, Default)]
pub struct FlushGate {
    pub write_lock: Mutex<()>,
    pub in_flight: AtomicBool,
}

/// Der Recorder (in `NetState.recorder: Mutex<Recorder>`).
#[derive(Debug, Default)]
pub struct Recorder {
    settings: RecorderSettings,
    /// Datenbank-Epoche: Daten mit alter Epoche werden nie geschrieben
    epoch: u64,
    chunk: chunk::ChunkWriter,
    hourly: hourly::HourlyAcc,
    spike: spike::SpikeDetector,
    events: events::EventDetector,
}

impl Recorder {
    /// Ein Monitor-Takt (rein). `targets[0]` ist das Hauptziel.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest(
        &mut self,
        now: i64,
        interval_ms: u64,
        targets: &[PingTarget],
        ips: &[Option<IpAddr>],
        samples: &[PingSample],
        load: &LoadSample,
        ctx: IngestCtx,
    ) -> IngestActions {
        let _ = (now, interval_ms, targets, ips, samples, load, ctx);
        IngestActions::default()
    }

    /// Monitor gestoppt: offene Ereignisse und Block schließen (der Aufrufer plant das Schreiben).
    pub fn on_stop(&mut self, now: i64) {
        let _ = now;
    }

    /// Erfolgreichen Speedtest vormerken (`speedtest`-Ereignis, Bezug „Leitung voll“).
    /// `local_mbps` = Datenverkehr des Adapters vor dem Test.
    pub fn push_speedtest(&mut self, now: i64, result: &SpeedResult, link: Option<&PrimaryLinkLite>, local_mbps: Option<f64>) {
        let _ = (now, result, link, local_mbps);
    }

    /// Ergebnis einer Momentaufnahme übernehmen (an `spike` weiterreichen).
    pub fn on_snapshot(&mut self, ev: &LagEvent) {
        self.spike.on_snapshot(ev);
    }

    /// Ergebnis einer Umfangsprüfung übernehmen (an `events` weiterreichen).
    pub fn on_scope(&mut self, outage_t: i64, scope: OutageScope) {
        self.events.on_scope(outage_t, scope);
    }

    /// Einstellungen übernehmen (kv `settings`, tolerant). `history.record = false` verwirft die
    /// Puffer sofort.
    pub fn apply_settings(&mut self, settings: &Value) {
        self.settings = RecorderSettings::from_value(settings);
        if !self.settings.record {
            self.clear_buffers(ClearScope::All);
        }
    }

    pub fn settings(&self) -> &RecorderSettings {
        &self.settings
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Vor einer Wiederherstellung: gepufferte Sitzungsdaten und gemerkte rowids verwerfen, Epoche
    /// erhöhen.
    pub fn discard_session_data(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.chunk.clear();
    }

    /// Kurz-Sitzung (< 10 s) gelöscht: deren Blöcke verwerfen.
    pub fn discard_session(&mut self, session_id: i64) {
        self.chunk.discard_session(session_id);
    }

    /// Puffer leeren (`net_history_clear`, `history.record = false`).
    pub fn clear_buffers(&mut self, scope: ClearScope) {
        self.spike.clear();
        self.events.clear();
        if scope == ClearScope::All {
            self.chunk.clear();
            self.hourly.clear();
        }
    }
}

/// Offene Puffer synchron schreiben (Lesebefehle, `native::finalize`). Bei einem Fehler bleiben die
/// Daten gepuffert (vorne wieder eingereiht).
pub fn flush_now(core: &Core) -> CmdResult<()> {
    flush_with(&core.net.recorder, &core.net.flush, &core.db)
}

/// Schreiben mit ausdrücklichem Recorder und ausdrücklicher Datenbank (auch für den Selbsttest
/// gegen eine temporäre Datenbank): unter der Recorder-Sperre herausnehmen, freigeben, dann eine
/// Transaktion.
pub fn flush_with(recorder: &Mutex<Recorder>, gate: &FlushGate, db: &DbHandle) -> CmdResult<()> {
    let _ = (recorder, gate, db);
    Ok(())
}

/// `net_history_clear(scope)`: erst den passenden Puffer leeren, dann löschen. Liefert die Zahl
/// gelöschter Zeilen.
pub fn history_clear(core: &Core, scope: ClearScope) -> CmdResult<u64> {
    core.net.recorder.lock_safe().clear_buffers(scope);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_are_read_tolerantly() {
        assert_eq!(RecorderSettings::from_value(&json!(null)), RecorderSettings::default());
        assert_eq!(RecorderSettings::from_value(&json!({ "history": { "record": "nein" } })), RecorderSettings::default());
        let s = RecorderSettings::from_value(&json!({
            "history": { "record": false },
            "ispLog": { "slowMs": 5, "contractDownMbps": 500, "contractUpMbps": 0 },
            "lag": { "snapshots": false }
        }));
        assert!(!s.record);
        assert_eq!(s.slow_ms, 30.0, "auf 30–1000 gekappt");
        assert!(!s.snapshots);
        assert_eq!(s.contract_down_mbps, Some(500.0));
        assert_eq!(s.contract_up_mbps, None, "0 ist kein gültiger Vertragswert");
        assert_eq!(RecorderSettings::from_value(&json!({ "ispLog": { "slowMs": 5000 } })).slow_ms, 1000.0);
    }

    #[test]
    fn stub_recorder_is_quiet() {
        let mut r = Recorder::default();
        let t = PingTarget { id: "aws-x".into(), label: "X".into(), host: "127.0.0.1".into(), port: None, method: crate::net::types::PingMethod::Tcp };
        let a = r.ingest(1, 1000, &[t], &[None], &[], &LoadSample::default(), IngestCtx::default());
        assert!(a.snapshot.is_none() && a.scope_check.is_none() && a.lag_update.is_none());
        let e = r.epoch();
        r.discard_session_data();
        assert_eq!(r.epoch(), e + 1);
        r.apply_settings(&json!({ "history": { "record": false } }));
        assert!(!r.settings().record);
    }
}
