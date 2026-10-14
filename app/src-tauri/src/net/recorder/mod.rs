//! Aufzeichnung des Netzwerk-Verlaufs im Monitor-Takt (Datenbank v2). Vertrag: `docs/API.md`,
//! „Datenbank v2“ und „Aufzeichnung“.
//!
//! Aufteilung: `mod.rs` (Kern: Takt, Puffer, Lückenregel, Schreiben), `chunk.rs` (Block-Format,
//! Match-Zeitleiste), `hourly.rs` (Stunden-Summen, Kalender), `spike.rs` (Live-Ausreißer,
//! Lag-Detektiv), `events.rs` (outage/loss/slow, Anbieter-Protokoll).
//!
//! `ingest` und alle Recorder-Methoden sind **rein** (keine Ein-/Ausgabe, keine Sperren, kein
//! Spawn); das Schreiben übernimmt [`flush_with`] (synchron, in `spawn_blocking` bzw. vor
//! Lesebefehlen), das Starten der Hintergrund-Aufträge der Hook (`net/hook.rs`).
//!
//! **Schreiben:** Die Teile liefern ihre fertigen Daten (`take`/`take_drafts`) erst beim Schreiben.
//! Der Kern sammelt sie in einem Stapel (`Batch`) und schreibt alle offenen Stapel in **einer**
//! Transaktion. Schlägt das fehl, bleiben die Stapel im Kern (höchstens 10 Minuten, danach fällt das
//! Älteste weg). Offene Ereignisse werden per `key` verfolgt: erst `INSERT`, danach `UPDATE` über
//! die gemerkte rowid.

pub mod chunk;
pub mod events;
pub mod hourly;
pub mod spike;

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::hist_types::{method_str, ClearScope, ConnectionKind, EventDraft, EventKind, HourlyRow, NetEvent, OutageScope, TargetKind, KEY_CORE};
use super::ifstats::LoadSample;
use super::lag::{LagCheck, LagEvent};
use super::link::{PrimaryLinkLite, REFRESH_EVERY_MS};
use super::scope::ScopeRequest;
use super::types::{PingMethod, PingSample, PingTarget, SpeedResult};
use crate::db::DbHandle;
use crate::error::{db_err, CmdResult, LockExt};
use crate::state::Core;

/// Spätestens so oft wird geschrieben (ms).
pub const FLUSH_EVERY_MS: i64 = 60_000;
/// So lange bleiben nicht schreibbare Daten höchstens im Speicher (ms).
pub const REQUEUE_MAX_MS: i64 = 10 * 60_000;
/// Längstes `detail` in `net_events` (Bytes, JSON).
pub const DETAIL_MAX_BYTES: usize = 1024;
/// Eigenes Fenster des Hauptziels (wie der Monitor und die Live-Ausreißer-Regel).
pub const WINDOW: usize = 60;
/// Bezug „Leitung voll“: Speedtests höchstens so alt (ms).
pub const REFERENCE_MAX_AGE_MS: i64 = 30 * 24 * 3_600_000;
/// Relative `slow`-Schwelle: Median der Stunden-Ø der letzten 14 Tage …
pub const SLOW_MEDIAN_SPAN_MS: i64 = 14 * 24 * 3_600_000;
/// … aus mindestens so vielen Messstunden (`covered_ms >= 30 min`) …
pub const SLOW_MEDIAN_MIN_HOURS: usize = 5;
/// … und höchstens stündlich neu berechnet.
pub const SLOW_MEDIAN_REFRESH_MS: i64 = 3_600_000;
/// Eine Messstunde hat mindestens so viel echte Messzeit (ms).
pub const MEASURED_HOUR_MS: i64 = 30 * 60_000;

/// Lückenregel: Mehr als `max(3 × Intervall, 5 s)` zwischen zwei Takten ist eine Lücke (Standby,
/// Ruhezustand), kein Verlust.
pub fn gap_limit_ms(interval_ms: u64) -> i64 {
    i64::try_from(interval_ms).unwrap_or(i64::MAX / 4).saturating_mul(3).max(5_000)
}

/// Grund der Ruhezeit (`quiet`-Ereignis, `detail.reason`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum QuietReason {
    /// Pulsars eigener Speedtest
    #[default]
    Speedtest,
    /// Aktiver WLAN-Scan
    WifiScan,
}

impl QuietReason {
    pub fn as_str(self) -> &'static str {
        match self {
            QuietReason::Speedtest => "speedtest",
            QuietReason::WifiScan => "wifiScan",
        }
    }
}

/// Was der Hook vor `ingest` aus den kleinen Sperren/Atomics liest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IngestCtx {
    /// `now < quiet_until` (Pulsars eigener Speedtest/WLAN-Scan)
    pub quiet: bool,
    /// Grund der Ruhezeit (nur bei `quiet` von Bedeutung)
    pub quiet_reason: QuietReason,
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
    /// IPv4 des Messziels für die VPN-Erkennung beim Erneuern (`None` → `1.1.1.1`)
    pub link_target: Option<Ipv4Addr>,
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
/// Sperr-Reihenfolge: `write_lock` → `recorder` (kurz) → `db`.
#[derive(Debug, Default)]
pub struct FlushGate {
    pub write_lock: Mutex<()>,
    pub in_flight: AtomicBool,
}

/// Letzter Speedtest als Bezug für „Leitung voll“ (Lag-Detektiv) und `lineBusyPossible`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeedRef {
    pub at: i64,
    pub down_mbps: f64,
    pub up_mbps: f64,
    pub bufferbloat_ms: Option<f64>,
}

/// Daten eines Schreibvorgangs (einer je Flush; nicht geschriebene Stapel bleiben im Kern).
#[derive(Debug, Default, Clone)]
struct Batch {
    /// Zeitpunkt, zu dem die Daten den Teilen entnommen wurden
    at: i64,
    chunks: Vec<chunk::Chunk>,
    hourly: Vec<HourlyRow>,
    drafts: Vec<EventDraft>,
}

impl Batch {
    fn is_empty(&self) -> bool {
        self.chunks.is_empty() && self.hourly.is_empty() && self.drafts.is_empty()
    }
}

/// Eine laufende Ruhezeit (`quiet`-Ereignis).
#[derive(Debug, Clone)]
struct QuietOpen {
    key: u64,
    event: NetEvent,
}

/// Zwischengespeicherter Median für die relative `slow`-Schwelle.
#[derive(Debug, Clone, PartialEq)]
struct MedianCache {
    target_key: String,
    net_id: String,
    at: i64,
}

/// Was der Flush vor dem Herausnehmen aus der Datenbank laden muss.
#[derive(Debug, Clone, Default, PartialEq)]
struct LoadPlan {
    settings: bool,
    median: Option<(String, String)>,
}

/// Ergebnis des Ladens (außerhalb der Recorder-Sperre).
#[derive(Debug, Clone, Default)]
struct Loaded {
    settings: Option<Value>,
    reference: Option<SpeedRef>,
    median: Option<(String, String, Option<f64>)>,
}

/// Der Recorder (in `NetState.recorder: Mutex<Recorder>`).
#[derive(Debug, Default)]
pub struct Recorder {
    settings: RecorderSettings,
    /// kv `settings` schon gelesen (erster Flush) oder von `kv_set` gespiegelt
    settings_loaded: bool,
    /// Datenbank-Epoche: Daten mit alter Epoche werden nie geschrieben
    epoch: u64,
    chunk: chunk::ChunkWriter,
    hourly: hourly::HourlyAcc,
    spike: spike::SpikeDetector,
    events: events::EventDetector,
    /// Eigenes Fenster des Hauptziels (höchstens 60 Werte)
    window: VecDeque<Option<f64>>,
    /// Ziel-ID, Host und Messart des Fensters (Wechsel → Fenster leeren)
    window_key: Option<(String, String, PingMethod)>,
    /// Zeit des letzten Takts (Lückenregel)
    last_tick: Option<i64>,
    /// Netz und Sitzung des letzten Takts (für Ereignisse außerhalb des Takts)
    last_net: Option<PrimaryLinkLite>,
    last_session: Option<i64>,
    last_flush_req: Option<i64>,
    last_link_req: Option<i64>,
    /// Laufende Ruhezeit
    quiet: Option<QuietOpen>,
    /// Laufende Nummer der Kern-Ereignisse (`KEY_CORE | n`)
    next_key: u64,
    /// Router-Grundwert des Lag-Detektivs (für die Umfangsprüfung)
    gateway_base: Option<f64>,
    /// Letzter Speedtest (Bezug)
    reference: Option<SpeedRef>,
    median: Option<MedianCache>,
    /// Kern-Ereignisse und Test-Daten, die beim nächsten Flush in den Stapel kommen
    pending: Batch,
    /// Herausgenommen, aber noch nicht geschrieben (Schreibfehler), älteste zuerst
    outbox: VecDeque<Batch>,
    /// Gemerkte rowids offener Ereignisse (`EventDraft.key` → `net_events.id`)
    rowids: HashMap<u64, i64>,
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
        let mut actions = IngestActions::default();
        let Some(main) = targets.first() else { return actions };

        // Lückenregel (Standby, Ruhezustand, Uhr zurückgestellt)
        let prev = self.last_tick;
        if let Some(last) = prev {
            if now < last || now - last > gap_limit_ms(interval_ms) {
                self.on_gap(last);
            }
        }
        self.last_tick = Some(now);

        // Neues Hauptziel (neuer `net_monitor_start`): eigenes Fenster leeren, offene Ereignisse schließen
        let key = (main.id.clone(), main.host.clone(), main.method);
        if self.window_key.as_ref() != Some(&key) {
            if self.window_key.is_some() {
                let t = prev.filter(|p| *p <= now).unwrap_or(now);
                self.spike.close(t);
                self.events.gap(t);
                self.chunk.close();
            }
            self.window.clear();
            self.window_key = Some(key);
        }

        let session = ctx.session.filter(|(_, started_at)| now >= *started_at).map(|(id, _)| id);
        self.last_session = session;
        self.last_net = ctx.link.clone();
        self.track_quiet(now, &ctx, session);

        let link = ctx.link.as_ref();
        let net_id = link.map(|l| l.net_id.clone()).unwrap_or_default();
        let connection = link.map_or(ConnectionKind::Other, PrimaryLinkLite::connection);
        let dst = match ips.first().copied().flatten() {
            Some(IpAddr::V4(v4)) => Some(v4),
            _ => None,
        };

        for (i, target) in targets.iter().enumerate() {
            let sample = samples.get(i).filter(|s| s.target_id == target.id).or_else(|| samples.iter().find(|s| s.target_id == target.id));
            let Some(sample) = sample else { continue };
            let rtt = sample.rtt.filter(|v| v.is_finite() && *v >= 0.0);
            let method = super::ping::effective_method(target.method);
            let mut is_spike = false;
            if i == 0 {
                self.window.push_back(rtt);
                while self.window.len() > WINDOW {
                    self.window.pop_front();
                }
                let window: Vec<Option<f64>> = self.window.iter().copied().collect();
                let outcome = self.spike.push(&spike::SpikeTick {
                    t: now,
                    rtt,
                    window: &window,
                    target,
                    dst,
                    quiet: ctx.quiet,
                    session_id: session,
                    link,
                    snapshots: self.settings.snapshots,
                });
                is_spike = outcome.spike;
                actions.snapshot = outcome.snapshot;
                actions.lag_update = outcome.lag_update;
                actions.scope_check = self.events.push(&events::EventTick {
                    t: now,
                    rtt,
                    interval_ms,
                    target,
                    method,
                    link,
                    status: load.status,
                    session_id: session,
                    quiet: ctx.quiet,
                    slow_ms: self.settings.slow_ms,
                    gateway_base: self.gateway_base,
                });
                if let Some(session_id) = session {
                    let key = chunk::ChunkKey { session_id, target_key: target.id.clone(), target_label: target.label.clone(), method };
                    self.chunk.push(&key, now, rtt, load, interval_ms);
                }
            }
            let key = hourly::HourKey {
                target_key: target.id.clone(),
                label: target.label.clone(),
                kind: TargetKind::from_target_id(&target.id),
                method,
                net_id: net_id.clone(),
                connection,
            };
            self.hourly.push(&key, now, rtt, is_spike, interval_ms);
        }

        // Während der Ruhezeit nie Momentaufnahme oder Umfangsprüfung (zusätzlich zu den Teilen)
        if ctx.quiet {
            actions.snapshot = None;
            actions.scope_check = None;
        }
        // Spätestens alle 60 s schreiben (der erste Takt lädt dabei die Einstellungen)
        if self.last_flush_req.is_none_or(|t| now < t || now - t >= FLUSH_EVERY_MS) {
            actions.flush_due = true;
            self.last_flush_req = Some(now);
        }
        // Hauptverbindung höchstens alle 30 s erneuern
        let stale = ctx.link.as_ref().is_none_or(|l| now < l.at || now - l.at >= REFRESH_EVERY_MS);
        if stale && self.last_link_req.is_none_or(|t| now < t || now - t >= REFRESH_EVERY_MS) {
            actions.refresh_link = true;
            actions.link_target = dst;
            self.last_link_req = Some(now);
        }
        actions
    }

    /// Lücke zwischen zwei Takten: offene Ereignisse am letzten `t` schließen, Block schließen,
    /// Fenster leeren. Die Lücke zählt weder als Verlust noch als Messzeit.
    fn on_gap(&mut self, last: i64) {
        self.spike.close(last);
        self.events.gap(last);
        self.chunk.close();
        self.hourly.gap();
        self.window.clear();
        self.close_quiet();
    }

    /// Ruhezeit verfolgen: Beginn → `quiet`-Ereignis anlegen, jeder weitere Takt verlängert es,
    /// Ende → schließen.
    fn track_quiet(&mut self, now: i64, ctx: &IngestCtx, session: Option<i64>) {
        if !ctx.quiet {
            self.close_quiet();
            return;
        }
        match self.quiet.as_mut() {
            Some(open) => {
                open.event.end_t = Some(now);
                let draft = EventDraft { key: open.key, event: open.event.clone(), closed: false };
                self.push_draft(draft);
            }
            None => {
                let mut event = NetEvent::new(EventKind::Quiet, now);
                event.end_t = Some(now);
                if let Some(l) = ctx.link.as_ref() {
                    event.net_id = l.net_id.clone();
                    event.connection = Some(l.connection());
                }
                event.session_id = session;
                event.detail = Some(json!({ "reason": ctx.quiet_reason.as_str() }));
                let key = self.new_key();
                self.quiet = Some(QuietOpen { key, event: event.clone() });
                self.push_draft(EventDraft { key, event, closed: false });
            }
        }
    }

    fn close_quiet(&mut self) {
        if let Some(open) = self.quiet.take() {
            self.push_draft(EventDraft { key: open.key, event: open.event, closed: true });
        }
    }

    fn new_key(&mut self) -> u64 {
        self.next_key = self.next_key.wrapping_add(1) & !(0xF << 60);
        KEY_CORE | self.next_key
    }

    /// Kern-Ereignis vormerken (ersetzt einen noch nicht geschriebenen Stand mit gleichem `key`).
    fn push_draft(&mut self, draft: EventDraft) {
        if !self.settings.record {
            return;
        }
        merge_draft(&mut self.pending.drafts, draft);
    }

    /// Monitor gestoppt: offene Ereignisse und Block schließen (der Aufrufer plant das Schreiben).
    pub fn on_stop(&mut self, now: i64) {
        let t = self.last_tick.filter(|t| *t <= now).unwrap_or(now);
        self.spike.close(t);
        self.events.close(t);
        self.chunk.close();
        self.hourly.gap();
        self.close_quiet();
    }

    /// Erfolgreichen Speedtest vormerken (`speedtest`-Ereignis, Bezug „Leitung voll“).
    /// `local_mbps` = Datenverkehr des Adapters vor dem Test.
    pub fn push_speedtest(&mut self, now: i64, result: &SpeedResult, link: Option<&PrimaryLinkLite>, local_mbps: Option<f64>) {
        let finite = |v: f64| Some(v).filter(|x| x.is_finite() && *x >= 0.0);
        if let (Some(down), Some(up)) = (finite(result.download_mbps), finite(result.upload_mbps)) {
            self.reference = Some(SpeedRef { at: now, down_mbps: down, up_mbps: up, bufferbloat_ms: finite(result.bufferbloat_ms) });
        }
        let mut event = NetEvent::new(EventKind::Speedtest, now);
        event.value = finite(result.download_mbps);
        let connection = link.map(PrimaryLinkLite::connection);
        if let Some(l) = link {
            event.net_id = l.net_id.clone();
        }
        event.connection = connection;
        event.session_id = self.last_session;
        let mut detail = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
        if let Some(obj) = detail.as_object_mut() {
            obj.insert("connection".into(), json!(connection.map(ConnectionKind::as_str)));
            obj.insert("localMbps".into(), json!(local_mbps.filter(|v| v.is_finite())));
        }
        event.detail = Some(detail);
        let key = self.new_key();
        self.push_draft(EventDraft { key, event, closed: true });
    }

    /// Ergebnis einer Momentaufnahme übernehmen (an `spike` weiterreichen, Router-Grundwert merken).
    pub fn on_snapshot(&mut self, ev: &LagEvent) {
        self.note_baselines(&ev.check);
        self.spike.on_snapshot(ev);
    }

    /// Ergebnis einer Ruhe-Messung (ohne `net://lag`): nur die Grundwerte merken.
    pub fn on_idle_snapshot(&mut self, check: &LagCheck) {
        self.note_baselines(check);
    }

    fn note_baselines(&mut self, check: &LagCheck) {
        if let Some(base) = check.snapshot.gateway_base_ms.filter(|v| v.is_finite()) {
            self.gateway_base = Some(base);
        }
    }

    /// Ergebnis einer Umfangsprüfung übernehmen (an `events` weiterreichen).
    pub fn on_scope(&mut self, outage_t: i64, scope: OutageScope) {
        self.events.on_scope(outage_t, scope);
    }

    /// Einstellungen übernehmen (kv `settings`, tolerant). `history.record = false` verwirft die
    /// Puffer sofort.
    pub fn apply_settings(&mut self, settings: &Value) {
        self.settings = RecorderSettings::from_value(settings);
        self.settings_loaded = true;
        if !self.settings.record {
            self.clear_buffers(ClearScope::All);
        }
    }

    pub fn settings(&self) -> &RecorderSettings {
        &self.settings
    }

    #[allow(dead_code)] // gelesen vom Lag-Detektiv (F1) bzw. in Tests
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Bezug für „Leitung voll“ `(Download, Upload)` in Mbit/s: letzter Speedtest der letzten 30
    /// Tage, sonst die eingetragenen Maximal-Werte, sonst keiner.
    #[allow(dead_code)] // gelesen vom Lag-Detektiv (F1) bzw. in Tests
    pub fn reference_mbps(&self, now: i64) -> (Option<f64>, Option<f64>) {
        match self.recent_reference(now) {
            Some(r) => (Some(r.down_mbps), Some(r.up_mbps)),
            None => (self.settings.contract_down_mbps, self.settings.contract_up_mbps),
        }
    }

    /// Bufferbloat des letzten Speedtests der letzten 30 Tage (`None` = keiner).
    #[allow(dead_code)] // gelesen vom Lag-Detektiv (F1) bzw. in Tests
    pub fn last_bufferbloat_ms(&self, now: i64) -> Option<f64> {
        self.recent_reference(now).and_then(|r| r.bufferbloat_ms)
    }

    #[allow(dead_code)] // gelesen vom Lag-Detektiv (F1) bzw. in Tests
    fn recent_reference(&self, now: i64) -> Option<SpeedRef> {
        self.reference.filter(|r| now - r.at <= REFERENCE_MAX_AGE_MS)
    }

    /// Router-Grundwert des Lag-Detektivs (zuletzt gemeldet).
    #[allow(dead_code)] // gelesen vom Lag-Detektiv (F1) bzw. in Tests
    pub fn gateway_base(&self) -> Option<f64> {
        self.gateway_base
    }

    /// Vor einer Wiederherstellung: gepufferte Sitzungsdaten und gemerkte rowids verwerfen, Epoche
    /// erhöhen.
    pub fn discard_session_data(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.chunk.clear();
        self.pending.chunks.clear();
        for b in &mut self.outbox {
            b.chunks.clear();
        }
        self.rowids.clear();
    }

    /// Kurz-Sitzung (< 10 s) gelöscht: deren Blöcke verwerfen.
    pub fn discard_session(&mut self, session_id: i64) {
        self.chunk.discard_session(session_id);
        self.pending.chunks.retain(|c| c.key.session_id != session_id);
        for b in &mut self.outbox {
            b.chunks.retain(|c| c.key.session_id != session_id);
        }
    }

    /// Puffer leeren (`net_history_clear`, `history.record = false`) und gemerkte rowids vergessen.
    pub fn clear_buffers(&mut self, scope: ClearScope) {
        self.spike.clear();
        self.events.clear();
        self.pending.drafts.clear();
        for b in &mut self.outbox {
            b.drafts.clear();
        }
        self.rowids.clear();
        if scope == ClearScope::All {
            self.chunk.clear();
            self.hourly.clear();
            self.pending.chunks.clear();
            self.pending.hourly.clear();
            self.outbox.clear();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Schreiben (Teile, die unter der Recorder-Sperre laufen)
    // -----------------------------------------------------------------------------------------

    /// Was vor dem Herausnehmen geladen werden muss (Einstellungen beim ersten Mal, Median).
    fn load_plan(&self, now: i64) -> LoadPlan {
        let median = match (&self.window_key, &self.median) {
            (Some((target, _, _)), cache) => {
                let net = self.last_net.as_ref().map(|l| l.net_id.clone()).unwrap_or_default();
                let fresh = cache
                    .as_ref()
                    .is_some_and(|c| c.target_key == *target && c.net_id == net && now >= c.at && now - c.at < SLOW_MEDIAN_REFRESH_MS);
                (!fresh).then(|| (target.clone(), net))
            }
            _ => None,
        };
        LoadPlan { settings: !self.settings_loaded, median }
    }

    fn apply_loaded(&mut self, loaded: Loaded, now: i64) {
        if let Some(v) = loaded.settings {
            // Inzwischen von `kv_set` gespiegelt → das ist neuer
            if !self.settings_loaded {
                self.apply_settings(&v);
            }
        }
        if let Some(r) = loaded.reference {
            if self.reference.is_none_or(|own| own.at < r.at) {
                self.reference = Some(r);
            }
        }
        if let Some((target_key, net_id, median)) = loaded.median {
            self.events.set_target_median(&target_key, &net_id, median);
            self.median = Some(MedianCache { target_key, net_id, at: now });
        }
    }

    /// Fertige Daten aller Teile in einen neuen Stapel nehmen und alle offenen Stapel liefern.
    fn take_batches(&mut self, now: i64) -> Vec<Batch> {
        let mut batch = std::mem::take(&mut self.pending);
        batch.at = now;
        batch.chunks.extend(self.chunk.take());
        batch.hourly.extend(self.hourly.take());
        for d in self.spike.take_drafts().into_iter().chain(self.events.take_drafts()) {
            merge_draft(&mut batch.drafts, d);
        }
        if !batch.is_empty() {
            self.outbox.push_back(batch);
        }
        self.outbox.drain(..).collect()
    }

    /// Nach einem Schreibfehler: vorne wieder einreihen, höchstens 10 Minuten behalten.
    fn requeue(&mut self, batches: Vec<Batch>, epoch: u64, now: i64) {
        for mut b in batches.into_iter().rev() {
            if epoch != self.epoch {
                // Wiederherstellung dazwischen: Sitzungs-Blöcke der alten Datenbank nie schreiben
                b.chunks.clear();
            }
            self.outbox.push_front(b);
        }
        let cutoff = now - REQUEUE_MAX_MS;
        while self.outbox.front().is_some_and(|b| b.at < cutoff) {
            self.outbox.pop_front();
        }
    }

    /// Nach dem Schreiben: rowids offener Ereignisse merken, abgeschlossene vergessen.
    fn remember_rowids(&mut self, written: Vec<(u64, i64, bool)>, epoch: u64) {
        if epoch != self.epoch {
            return;
        }
        for (key, id, closed) in written {
            if closed {
                self.rowids.remove(&key);
            } else {
                self.rowids.insert(key, id);
            }
        }
    }

    #[cfg(test)]
    fn window_len(&self) -> usize {
        self.window.len()
    }

    #[cfg(test)]
    fn outbox_len(&self) -> usize {
        self.outbox.len()
    }
}

/// Ein Ereignis in eine Liste aufnehmen; ein älterer Stand mit gleichem `key` wird ersetzt
/// (`closed` bleibt gesetzt, wenn es einmal gesetzt war).
fn merge_draft(list: &mut Vec<EventDraft>, draft: EventDraft) {
    match list.iter_mut().find(|d| d.key == draft.key) {
        Some(slot) => {
            let closed = slot.closed || draft.closed;
            *slot = EventDraft { closed, ..draft };
        }
        None => list.push(draft),
    }
}

/// `detail` als JSON mit höchstens 1 KiB: erst `snap.hops` kürzen, dann `snap` weglassen – nie zu
/// ungültigem JSON abschneiden. Passt es dann noch nicht, entfällt `detail` ganz (`None`).
pub fn cap_detail(detail: &Value) -> Option<String> {
    let text = serde_json::to_string(detail).ok()?;
    if text.len() <= DETAIL_MAX_BYTES {
        return Some(text);
    }
    let mut v = detail.clone();
    loop {
        let hops = v.get_mut("snap").and_then(|s| s.get_mut("hops")).and_then(Value::as_array_mut);
        match hops {
            Some(h) if !h.is_empty() => {
                h.pop();
            }
            _ => break,
        }
        let text = serde_json::to_string(&v).ok()?;
        if text.len() <= DETAIL_MAX_BYTES {
            return Some(text);
        }
    }
    if let Some(obj) = v.as_object_mut() {
        obj.remove("snap");
    }
    let text = serde_json::to_string(&v).ok()?;
    (text.len() <= DETAIL_MAX_BYTES).then_some(text)
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
    flush_at(recorder, gate, db, crate::util::now_ms())
}

fn flush_at(recorder: &Mutex<Recorder>, gate: &FlushGate, db: &DbHandle, now: i64) -> CmdResult<()> {
    let _write = gate.write_lock.lock_safe();
    // 1. Einstellungen (erstes Mal), Bezug und Median laden – ohne Recorder-Sperre
    let plan = recorder.lock_safe().load_plan(now);
    if plan != LoadPlan::default() {
        match db.with(|db| load_from_db(db.conn(), &plan, now).map_err(db_err)) {
            Ok(loaded) => recorder.lock_safe().apply_loaded(loaded, now),
            Err(e) => eprintln!("Messverlauf: Einstellungen konnten nicht gelesen werden: {e}"),
        }
    }
    // 2. Unter der Sperre herausnehmen
    let (batches, rowids, epoch) = {
        let mut rec = recorder.lock_safe();
        if !rec.settings.record {
            rec.clear_buffers(ClearScope::All);
            return Ok(());
        }
        let batches = rec.take_batches(now);
        (batches, rec.rowids.clone(), rec.epoch)
    };
    if batches.is_empty() {
        return Ok(());
    }
    // 3. Eine Transaktion (Recorder ist frei)
    let result = db.with(|db| write_batches(db.conn_mut(), &batches, &rowids).map_err(db_err));
    // 4. Ergebnis zurück in den Recorder
    let mut rec = recorder.lock_safe();
    match result {
        Ok(written) => {
            rec.remember_rowids(written, epoch);
            Ok(())
        }
        Err(e) => {
            rec.requeue(batches, epoch, now);
            Err(e)
        }
    }
}

/// Einstellungen, Bezug (letzter Speedtest der letzten 30 Tage) und Median lesen.
fn load_from_db(conn: &Connection, plan: &LoadPlan, now: i64) -> rusqlite::Result<Loaded> {
    let mut loaded = Loaded::default();
    if plan.settings {
        let text: Option<String> = conn.query_row("SELECT value FROM kv WHERE key = 'settings'", [], |r| r.get(0)).optional()?;
        loaded.settings = Some(text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null));
        let last: Option<(i64, Option<f64>, Option<String>)> = conn
            .query_row(
                "SELECT t, value, detail FROM net_events WHERE kind = 'speedtest' AND t >= ?1 ORDER BY t DESC, id DESC LIMIT 1",
                params![now - REFERENCE_MAX_AGE_MS],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        loaded.reference = last.and_then(|(at, value, detail)| {
            let d: Value = detail.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let num = |k: &str| d.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
            Some(SpeedRef { at, down_mbps: value.or_else(|| num("downloadMbps"))?, up_mbps: num("uploadMbps")?, bufferbloat_ms: num("bufferbloatMs") })
        });
    }
    if let Some((target_key, net_id)) = &plan.median {
        let mut stmt = conn.prepare(
            "SELECT SUM(sum_rtt), SUM(n - lost) FROM ping_hourly
             WHERE target_key = ?1 AND net_id = ?2 AND hour_start >= ?3
             GROUP BY hour_start HAVING SUM(covered_ms) >= ?4",
        )?;
        let rows = stmt.query_map(params![target_key, net_id, now - SLOW_MEDIAN_SPAN_MS, MEASURED_HOUR_MS], |r| {
            Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut avgs = Vec::new();
        for row in rows {
            let (sum, answered) = row?;
            if answered > 0 && sum.is_finite() {
                avgs.push(sum / answered as f64);
            }
        }
        let median = (avgs.len() >= SLOW_MEDIAN_MIN_HOURS).then(|| super::ping::median(&avgs)).flatten();
        loaded.median = Some((target_key.clone(), net_id.clone(), median));
    }
    Ok(loaded)
}

/// Alle Stapel in einer Transaktion schreiben. Liefert je geschriebenem Ereignis
/// `(key, rowid, closed)` (letzter Stand je `key`).
fn write_batches(conn: &mut Connection, batches: &[Batch], rowids: &HashMap<u64, i64>) -> rusqlite::Result<Vec<(u64, i64, bool)>> {
    let tx = conn.transaction()?;
    let mut ids: HashMap<u64, i64> = rowids.clone();
    let mut written: Vec<(u64, i64, bool)> = Vec::new();
    for b in batches {
        for c in &b.chunks {
            crate::db::insert_samples_chunk(
                &tx,
                c.key.session_id,
                c.chunk_start,
                &c.key.target_key,
                &c.key.target_label,
                method_str(c.key.method),
                i64::from(c.n),
                &c.data,
            )?;
        }
        for r in &b.hourly {
            crate::db::upsert_hourly(&tx, r)?;
        }
        for d in &b.drafts {
            let detail = d.event.detail.as_ref().and_then(cap_detail);
            let updated = match ids.get(&d.key) {
                Some(id) => crate::db::update_event(&tx, *id, &d.event, detail.as_deref())?.then_some(*id),
                None => None,
            };
            let id = match updated {
                Some(id) => id,
                // Neu – oder die gemerkte Zeile gibt es nicht mehr (z. B. Verlauf gelöscht)
                None => crate::db::insert_event(&tx, &d.event, detail.as_deref())?,
            };
            ids.insert(d.key, id);
            match written.iter_mut().find(|w| w.0 == d.key) {
                Some(w) => *w = (d.key, id, w.2 || d.closed),
                None => written.push((d.key, id, d.closed)),
            }
        }
    }
    tx.commit()?;
    Ok(written)
}

/// `net_history_clear(scope)`: erst den passenden Puffer leeren (und gemerkte rowids vergessen),
/// dann löschen. Wartet auf einen laufenden Flush. Liefert die Zahl gelöschter Zeilen.
pub fn history_clear(core: &Core, scope: ClearScope) -> CmdResult<u64> {
    history_clear_with(&core.net.recorder, &core.net.flush, &core.db, scope)
}

fn history_clear_with(recorder: &Mutex<Recorder>, gate: &FlushGate, db: &DbHandle, scope: ClearScope) -> CmdResult<u64> {
    let _write = gate.write_lock.lock_safe();
    recorder.lock_safe().clear_buffers(scope);
    db.with(|db| {
        let tx = db.conn_mut().transaction().map_err(db_err)?;
        let mut n = tx.execute("DELETE FROM net_events", []).map_err(db_err)?;
        if scope == ClearScope::All {
            n += tx.execute("DELETE FROM ping_hourly", []).map_err(db_err)?;
            n += tx.execute("DELETE FROM session_samples", []).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(n as u64)
    })
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

    // -----------------------------------------------------------------------------------------
    // Hilfen: eigener Recorder + temporäre Datenbank (wie der Selbsttest)
    // -----------------------------------------------------------------------------------------

    struct Env {
        _dir: tempfile::TempDir,
        rec: Mutex<Recorder>,
        gate: FlushGate,
        db: DbHandle,
    }

    impl Env {
        fn new() -> Env {
            let dir = tempfile::tempdir().unwrap();
            let db = DbHandle::new();
            db.replace(Some(crate::db::Db::open(&dir.path().join("pulsar.db")).unwrap()));
            Env { _dir: dir, rec: Mutex::new(Recorder::default()), gate: FlushGate::default(), db }
        }

        fn flush(&self, now: i64) -> CmdResult<()> {
            flush_at(&self.rec, &self.gate, &self.db, now)
        }

        fn count(&self, sql: &str) -> i64 {
            self.db.with(|db| db.conn().query_row(sql, [], |r| r.get(0)).map_err(db_err)).unwrap()
        }

        fn exec(&self, sql: &str) {
            self.db.with(|db| db.conn().execute_batch(sql).map_err(db_err)).unwrap();
        }

        fn rec(&self) -> std::sync::MutexGuard<'_, Recorder> {
            self.rec.lock_safe()
        }
    }

    fn target(id: &str, host: &str, method: PingMethod) -> PingTarget {
        PingTarget { id: id.into(), label: format!("Ziel {id}"), host: host.into(), port: None, method }
    }

    fn main_target() -> PingTarget {
        target("aws-eu-central-1", "127.0.0.1", PingMethod::Tcp)
    }

    fn tick(r: &mut Recorder, t: i64, interval_ms: u64, target: &PingTarget, rtt: Option<f64>, ctx: IngestCtx) -> IngestActions {
        let samples = [PingSample { target_id: target.id.clone(), t, rtt }];
        r.ingest(t, interval_ms, std::slice::from_ref(target), &[None], &samples, &LoadSample { at: t, ..Default::default() }, ctx)
    }

    fn quiet_ctx(reason: QuietReason) -> IngestCtx {
        IngestCtx { quiet: true, quiet_reason: reason, ..Default::default() }
    }

    fn link(net_id: &str, kind: crate::net::link::LinkKind) -> PrimaryLinkLite {
        PrimaryLinkLite { luid: 1, if_index: 2, kind, gateway: None, net_id: net_id.into(), vpn: false, at: 0 }
    }

    fn speed(down: f64) -> SpeedResult {
        SpeedResult {
            download_mbps: down,
            upload_mbps: 40.0,
            idle_latency_ms: 12.0,
            idle_jitter_ms: 1.0,
            loaded_latency_down_ms: Some(80.0),
            loaded_latency_up_ms: None,
            bufferbloat_ms: 68.0,
            grade: "B".into(),
            server: "FRA".into(),
            at: 0,
        }
    }

    fn hourly_row(hour_start: i64) -> HourlyRow {
        HourlyRow {
            hour_start,
            target_key: "aws-eu-central-1".into(),
            net_id: String::new(),
            connection: ConnectionKind::Ethernet,
            kind: TargetKind::Region,
            label: "Frankfurt".into(),
            method: PingMethod::Icmp,
            n: 10,
            lost: 0,
            sum_rtt: 200.0,
            sum_jitter: 5.0,
            n_jitter: 9,
            max_rtt: Some(30.0),
            spikes: 0,
            covered_ms: 10_000,
        }
    }

    fn chunk_for(session_id: i64, chunk_start: i64) -> chunk::Chunk {
        chunk::Chunk {
            key: chunk::ChunkKey { session_id, target_key: "aws-eu-central-1".into(), target_label: "Frankfurt".into(), method: PingMethod::Icmp },
            chunk_start,
            n: 0,
            data: vec![chunk::FORMAT_VERSION],
        }
    }

    const NO_HISTORY_EVENTS: &str = "SELECT COUNT(*) FROM net_events WHERE kind IN ('outage','loss','slow','spike')";

    // -----------------------------------------------------------------------------------------
    // Tests „Datenbank v2“ (Kern)
    // -----------------------------------------------------------------------------------------

    #[test]
    fn flush_writes_one_transaction() {
        let env = Env::new();
        let sid = env.db.with(|db| db.session_insert("g", 1_000, 61_000, 60)).unwrap().id;
        {
            let mut r = env.rec();
            r.push_speedtest(5_000, &speed(450.0), None, None);
            r.pending.chunks.push(chunk_for(sid, 1_000));
            r.pending.hourly.push(hourly_row(0));
        }
        env.flush(10_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.count("SELECT COUNT(*) FROM session_samples"), 1);
        assert_eq!(env.count("SELECT COUNT(*) FROM ping_hourly"), 1);
        assert_eq!(env.rec().outbox_len(), 0);

        // Ein Teil scheitert (Tabelle fehlt) → nichts aus diesem Stapel wird geschrieben
        {
            let mut r = env.rec();
            r.push_speedtest(20_000, &speed(460.0), None, None);
            r.pending.chunks.push(chunk_for(sid, 61_000));
            r.pending.hourly.push(hourly_row(0));
        }
        env.exec("ALTER TABLE ping_hourly RENAME TO ping_hourly_weg");
        assert!(env.flush(30_000).is_err());
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1, "Ereignis zurückgerollt");
        assert_eq!(env.count("SELECT COUNT(*) FROM session_samples"), 1, "Block zurückgerollt");
        assert_eq!(env.rec().outbox_len(), 1, "Stapel bleibt im Speicher");
        env.exec("ALTER TABLE ping_hourly_weg RENAME TO ping_hourly");
        env.flush(40_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 2);
        assert_eq!(env.count("SELECT COUNT(*) FROM session_samples"), 2);
        assert_eq!(env.count("SELECT n FROM ping_hourly"), 20, "Upsert addiert, nichts doppelt");
        assert_eq!(env.rec().outbox_len(), 0);
        // Nichts mehr offen → ein weiterer Flush schreibt nichts
        env.flush(50_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 2);
    }

    #[test]
    fn flush_failure_requeues_max_10min() {
        let env = Env::new();
        let t0 = 1_000_000_000;
        env.exec("ALTER TABLE net_events RENAME TO net_events_weg");
        for (i, at) in [t0, t0 + 5 * 60_000, t0 + 11 * 60_000].into_iter().enumerate() {
            env.rec().push_speedtest(at, &speed(400.0 + i as f64), None, None);
            assert!(env.flush(at).is_err());
        }
        assert_eq!(env.rec().outbox_len(), 2, "der älteste Stapel (> 10 min) ist verworfen");
        env.exec("ALTER TABLE net_events_weg RENAME TO net_events");
        env.flush(t0 + 11 * 60_000 + 1_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 2);
        assert_eq!(env.count("SELECT CAST(MIN(value) AS INTEGER) FROM net_events"), 401);
        assert_eq!(env.rec().outbox_len(), 0);
    }

    #[test]
    fn record_off_writes_nothing() {
        let env = Env::new();
        env.db.with(|db| db.kv_set("settings", &json!({ "history": { "record": false } }))).unwrap();
        let t = main_target();
        {
            let mut r = env.rec();
            for i in 0..5 {
                tick(&mut r, 1_000 + i * 1_000, 1_000, &t, None, quiet_ctx(QuietReason::Speedtest));
            }
            r.push_speedtest(6_000, &speed(450.0), None, None);
        }
        env.flush(7_000).unwrap();
        assert!(!env.rec().settings().record, "beim ersten Schreiben aus kv gelesen");
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 0);
        assert_eq!(env.count("SELECT COUNT(*) FROM ping_hourly"), 0);
        // Weitere Daten werden gar nicht erst gesammelt
        {
            let mut r = env.rec();
            r.push_speedtest(8_000, &speed(450.0), None, None);
            assert!(r.pending.drafts.is_empty());
            assert_eq!(r.reference_mbps(8_000).0, Some(450.0), "Bezug zählt trotzdem (nur im Speicher)");
        }
        // Wieder an (kv_set spiegelt sofort) → es wird geschrieben
        env.rec().apply_settings(&json!({ "history": { "record": true } }));
        env.rec().push_speedtest(9_000, &speed(450.0), None, None);
        env.flush(10_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        // Ausschalten verwirft auch schon gepufferte Daten
        env.rec().push_speedtest(11_000, &speed(450.0), None, None);
        env.rec().apply_settings(&json!({ "history": { "record": false } }));
        env.flush(12_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
    }

    #[test]
    fn orphan_session_does_not_block_flush() {
        let env = Env::new();
        {
            let mut r = env.rec();
            r.pending.chunks.push(chunk_for(999, 1_000));
            r.pending.hourly.push(hourly_row(0));
            r.push_speedtest(2_000, &speed(450.0), None, None);
        }
        env.flush(3_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM session_samples"), 0, "Block der gelöschten Sitzung still verworfen");
        assert_eq!(env.count("SELECT COUNT(*) FROM ping_hourly"), 1);
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.rec().outbox_len(), 0);
    }

    #[test]
    fn open_event_written_then_updated() {
        let env = Env::new();
        let t = main_target();
        let ctx = || IngestCtx { link: Some(link("net1", crate::net::link::LinkKind::Wifi)), ..quiet_ctx(QuietReason::Speedtest) };
        tick(&mut env.rec(), 1_000, 1_000, &t, Some(20.0), ctx());
        env.flush(1_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.count("SELECT end_t FROM net_events"), 1_000);
        tick(&mut env.rec(), 2_000, 1_000, &t, Some(20.0), ctx());
        tick(&mut env.rec(), 3_000, 1_000, &t, Some(20.0), ctx());
        env.flush(3_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1, "kein Duplikat");
        assert_eq!(env.count("SELECT end_t FROM net_events"), 3_000, "per UPDATE nachgezogen");
        assert_eq!(env.rec().rowids.len(), 1);
        // Ruhezeit vorbei → abgeschlossen mit dem letzten Stand
        tick(&mut env.rec(), 4_000, 1_000, &t, Some(20.0), IngestCtx::default());
        env.flush(4_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.count("SELECT end_t FROM net_events"), 3_000);
        assert!(env.rec().rowids.is_empty(), "abgeschlossen → rowid vergessen");
        let (kind, connection, net_id, detail): (String, String, String, String) = env
            .db
            .with(|db| {
                db.conn()
                    .query_row("SELECT kind, connection, net_id, detail FROM net_events", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(db_err)
            })
            .unwrap();
        assert_eq!((kind.as_str(), connection.as_str(), net_id.as_str()), ("quiet", "wifi", "net1"));
        assert_eq!(serde_json::from_str::<Value>(&detail).unwrap(), json!({ "reason": "speedtest" }));
    }

    #[test]
    fn open_event_reinserted_when_row_vanished() {
        let env = Env::new();
        let t = main_target();
        tick(&mut env.rec(), 1_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::WifiScan));
        env.flush(1_500).unwrap();
        // Zeile von außen gelöscht (z. B. Aufräumen) → nächster Stand wird neu angelegt, nicht verloren
        env.exec("DELETE FROM net_events");
        tick(&mut env.rec(), 2_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::WifiScan));
        env.flush(2_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.count("SELECT end_t FROM net_events"), 2_000);
    }

    #[test]
    fn restore_epoch_discards_buffer() {
        let env = Env::new();
        let t = main_target();
        let sid = env.db.with(|db| db.session_insert("g", 0, 60_000, 60)).unwrap().id;
        tick(&mut env.rec(), 1_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::Speedtest));
        env.flush(1_500).unwrap();
        assert_eq!(env.rec().rowids.len(), 1);
        {
            let mut r = env.rec();
            r.pending.chunks.push(chunk_for(sid, 1_000));
            r.pending.hourly.push(hourly_row(0));
            let epoch = r.epoch();
            r.discard_session_data();
            assert_eq!(r.epoch(), epoch + 1);
            assert!(r.pending.chunks.is_empty(), "Blöcke verworfen");
            assert_eq!(r.pending.hourly.len(), 1, "Stunden-Summen bleiben");
            assert!(r.rowids.is_empty(), "rowids vergessen");
        }
        // Ein Schreibfehler über eine Wiederherstellung hinweg: Blöcke der alten Epoche nie schreiben
        env.rec().pending.chunks.push(chunk_for(sid, 2_000));
        env.exec("ALTER TABLE ping_hourly RENAME TO ping_hourly_weg");
        let epoch_before = env.rec().epoch();
        assert!(env.flush(3_000).is_err());
        {
            let mut r = env.rec();
            let batches = r.take_batches(3_000);
            assert_eq!(batches[0].chunks.len(), 1);
            r.requeue(batches, epoch_before, 3_000);
            assert_eq!(r.outbox[0].chunks.len(), 1, "gleiche Epoche → Block bleibt");
            let batches = r.take_batches(3_000);
            r.discard_session_data();
            r.requeue(batches, epoch_before, 3_000);
            assert!(r.outbox[0].chunks.is_empty(), "alte Epoche → Block verworfen");
        }
        env.exec("ALTER TABLE ping_hourly_weg RENAME TO ping_hourly");
        env.flush(4_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM session_samples"), 0);
    }

    #[test]
    fn discard_short_session_drops_its_chunks() {
        let mut r = Recorder::default();
        r.pending.chunks.push(chunk_for(1, 0));
        r.pending.chunks.push(chunk_for(2, 0));
        r.outbox.push_back(Batch { at: 0, chunks: vec![chunk_for(1, 60_000)], ..Default::default() });
        r.discard_session(1);
        assert_eq!(r.pending.chunks.len(), 1);
        assert_eq!(r.pending.chunks[0].key.session_id, 2);
        assert!(r.outbox[0].chunks.is_empty());
    }

    #[test]
    fn history_clear_empties_buffer() {
        let env = Env::new();
        let t = main_target();
        tick(&mut env.rec(), 1_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::Speedtest));
        env.rec().push_speedtest(1_200, &speed(450.0), None, None);
        env.rec().pending.hourly.push(hourly_row(0));
        env.flush(1_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 2);
        // Noch nicht geschrieben: ein neuer Stand der Ruhezeit, ein Speedtest, Stunden-Summen
        tick(&mut env.rec(), 2_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::Speedtest));
        env.rec().push_speedtest(2_100, &speed(450.0), None, None);
        env.rec().pending.hourly.push(hourly_row(0));
        let n = history_clear_with(&env.rec, &env.gate, &env.db, ClearScope::Events).unwrap();
        assert_eq!(n, 2);
        {
            let r = env.rec();
            assert!(r.pending.drafts.is_empty(), "Ereignis-Puffer geleert");
            assert!(r.rowids.is_empty(), "rowids vergessen");
            assert_eq!(r.pending.hourly.len(), 1, "bei „events“ bleiben die Stunden-Summen");
        }
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 0);
        // Nur die Testzeile (Kabel) zählen – die Takte selbst schreiben seit F3 eigene Stunden-Summen
        assert_eq!(env.count("SELECT COUNT(*) FROM ping_hourly WHERE connection = 'ethernet'"), 1);
        // Die Ruhezeit läuft weiter → beim nächsten Schreiben neu angelegt (nicht ins Leere aktualisiert)
        tick(&mut env.rec(), 3_000, 1_000, &t, Some(20.0), quiet_ctx(QuietReason::Speedtest));
        env.flush(3_500).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events"), 1);
        assert_eq!(env.count("SELECT n FROM ping_hourly WHERE connection = 'ethernet'"), 20);
        // „all“ leert alles
        env.rec().pending.hourly.push(hourly_row(0));
        let n = history_clear_with(&env.rec, &env.gate, &env.db, ClearScope::All).unwrap();
        assert_eq!(n, 3, "1 Ereignis + Stunden-Summen der Testzeile und der Takte");
        assert!(env.rec().pending.hourly.is_empty());
        env.flush(4_000).unwrap();
        assert_eq!(env.count("SELECT COUNT(*) FROM ping_hourly"), 0);
    }

    #[test]
    fn sleep_gap_is_not_outage() {
        let env = Env::new();
        let t = main_target();
        let mut now = 1_000_000;
        {
            let mut r = env.rec();
            for _ in 0..20 {
                tick(&mut r, now, 1_000, &t, Some(20.0), IngestCtx::default());
                now += 1_000;
            }
            // Zwei Verluste direkt vor dem Standby, dann eine Stunde nichts
            tick(&mut r, now, 1_000, &t, None, IngestCtx::default());
            tick(&mut r, now + 1_000, 1_000, &t, None, IngestCtx::default());
            assert_eq!(r.window_len(), 22);
            now += 1_000 + 3_600_000;
            tick(&mut r, now, 1_000, &t, None, IngestCtx::default());
            assert_eq!(r.window_len(), 1, "Lücke leert das Fenster");
            for _ in 0..20 {
                now += 1_000;
                tick(&mut r, now, 1_000, &t, Some(21.0), IngestCtx::default());
            }
            // 5 s sind bei 1-s-Takt noch keine Lücke, 5,001 s schon
            let len = r.window_len();
            now += 5_000;
            tick(&mut r, now, 1_000, &t, Some(21.0), IngestCtx::default());
            assert_eq!(r.window_len(), len + 1);
            now += 5_001;
            tick(&mut r, now, 1_000, &t, Some(21.0), IngestCtx::default());
            assert_eq!(r.window_len(), 1);
            // 10-s-Takt: Grenze 30 s
            now += 30_000;
            tick(&mut r, now, 10_000, &t, Some(21.0), IngestCtx::default());
            assert_eq!(r.window_len(), 2);
            // Uhr zurückgestellt
            tick(&mut r, now - 60_000, 10_000, &t, Some(21.0), IngestCtx::default());
            assert_eq!(r.window_len(), 1, "Uhr zurück → Lücke");
            r.on_stop(now);
        }
        env.flush(now + 1_000).unwrap();
        assert_eq!(env.count(NO_HISTORY_EVENTS), 0, "keine Aussetzer/Verluste aus der Lücke");
    }

    #[test]
    fn window_resets_on_target_change() {
        let mut r = Recorder::default();
        let a = main_target();
        for i in 0..70 {
            tick(&mut r, 1_000 + i * 1_000, 1_000, &a, Some(20.0), IngestCtx::default());
        }
        assert_eq!(r.window_len(), WINDOW, "höchstens 60 Werte");
        let mut now = 71_000;
        let b = target("valve-cs2-fra", "127.0.0.1", PingMethod::Tcp);
        tick(&mut r, now, 1_000, &b, Some(30.0), IngestCtx::default());
        assert_eq!(r.window_len(), 1, "anderes Ziel");
        now += 1_000;
        tick(&mut r, now, 1_000, &b, Some(30.0), IngestCtx::default());
        assert_eq!(r.window_len(), 2);
        now += 1_000;
        tick(&mut r, now, 1_000, &target("valve-cs2-fra", "10.0.0.1", PingMethod::Tcp), Some(30.0), IngestCtx::default());
        assert_eq!(r.window_len(), 1, "anderer Host");
        now += 1_000;
        tick(&mut r, now, 1_000, &target("valve-cs2-fra", "10.0.0.1", PingMethod::Icmp), Some(30.0), IngestCtx::default());
        assert_eq!(r.window_len(), 1, "andere Messart");
        // Verluste und ungültige Werte zählen als Verlust im Fenster
        now += 1_000;
        tick(&mut r, now, 1_000, &target("valve-cs2-fra", "10.0.0.1", PingMethod::Icmp), Some(f64::NAN), IngestCtx::default());
        assert_eq!(r.window.back(), Some(&None));
    }

    #[test]
    fn detail_capped_1kib() {
        let small = json!({ "count": 2, "baseline": 20.0 });
        assert_eq!(cap_detail(&small).unwrap(), serde_json::to_string(&small).unwrap());
        // Viele Stationen → hinten gekürzt, snap bleibt
        let hops: Vec<Value> = (1..=60).map(|ttl| json!([ttl, 12.5, "isp"])).collect();
        let spike = json!({ "count": 3, "baseline": 20.0, "limit": 60.0, "cpuHigh": false, "reasons": ["gatewaySlow"],
                            "snap": { "conn": "wifi", "vpn": false, "hops": hops, "gw": 3.0, "gwB": 2.0, "tgt": 80.0 } });
        let text = cap_detail(&spike).unwrap();
        assert!(text.len() <= DETAIL_MAX_BYTES);
        let v: Value = serde_json::from_str(&text).unwrap();
        let kept = v["snap"]["hops"].as_array().unwrap();
        assert!(!kept.is_empty() && kept.len() < 60);
        assert_eq!(kept[0], json!([1, 12.5, "isp"]), "die ersten Stationen bleiben");
        assert_eq!(v["count"], 3);
        // snap selbst zu groß → snap fällt weg, der Rest bleibt
        let big = json!({ "count": 1, "snap": { "hops": [], "conn": "x".repeat(2_000) } });
        let v: Value = serde_json::from_str(&cap_detail(&big).unwrap()).unwrap();
        assert_eq!(v, json!({ "count": 1 }));
        // Ohne snap und trotzdem zu groß → kein detail statt kaputtem JSON
        assert_eq!(cap_detail(&json!({ "x": "y".repeat(2_000) })), None);
    }

    fn quiet_run(reason: QuietReason) {
        let env = Env::new();
        let t = main_target();
        let mut now = 1_000_000;
        {
            let mut r = env.rec();
            for _ in 0..30 {
                tick(&mut r, now, 1_000, &t, Some(20.0), IngestCtx::default());
                now += 1_000;
            }
            // Ruhezeit: Verluste, Ausreißer und langsame Werte
            for i in 0..40 {
                let rtt = match i % 4 {
                    0 | 1 => None,
                    2 => Some(900.0),
                    _ => Some(400.0),
                };
                let a = tick(&mut r, now, 1_000, &t, rtt, quiet_ctx(reason));
                assert!(a.snapshot.is_none(), "keine Momentaufnahme in der Ruhezeit");
                assert!(a.scope_check.is_none(), "keine Umfangsprüfung in der Ruhezeit");
                now += 1_000;
            }
            for _ in 0..5 {
                tick(&mut r, now, 1_000, &t, Some(20.0), IngestCtx::default());
                now += 1_000;
            }
            r.on_stop(now);
        }
        env.flush(now).unwrap();
        assert_eq!(env.count(NO_HISTORY_EVENTS), 0, "keine Ereignisse während der Ruhezeit");
        assert_eq!(env.count("SELECT COUNT(*) FROM net_events WHERE kind = 'quiet'"), 1);
        assert_eq!(env.count("SELECT end_t - t FROM net_events WHERE kind = 'quiet'"), 39_000);
        let detail: String = env.db.with(|db| db.conn().query_row("SELECT detail FROM net_events", [], |r| r.get(0)).map_err(db_err)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&detail).unwrap()["reason"], reason.as_str());
    }

    #[test]
    fn no_events_during_own_speedtest() {
        quiet_run(QuietReason::Speedtest);
    }

    #[test]
    fn no_events_during_wifi_scan() {
        quiet_run(QuietReason::WifiScan);
    }

    #[test]
    fn speedtest_is_logged() {
        let env = Env::new();
        let wifi = link("abc123", crate::net::link::LinkKind::Wifi);
        env.rec().push_speedtest(5_000, &speed(452.5), Some(&wifi), Some(3.5));
        env.flush(6_000).unwrap();
        let (kind, value, net_id, connection, end_t, target_key, detail): (String, f64, String, String, Option<i64>, Option<String>, String) = env
            .db
            .with(|db| {
                db.conn()
                    .query_row("SELECT kind, value, net_id, connection, end_t, target_key, detail FROM net_events", [], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
                    })
                    .map_err(db_err)
            })
            .unwrap();
        assert_eq!((kind.as_str(), value, net_id.as_str(), connection.as_str()), ("speedtest", 452.5, "abc123", "wifi"));
        assert_eq!((end_t, target_key), (None, None));
        let d: Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(d["downloadMbps"], 452.5);
        assert_eq!(d["uploadMbps"], 40.0);
        assert_eq!(d["bufferbloatMs"], 68.0);
        assert_eq!(d["server"], "FRA");
        assert_eq!(d["connection"], "wifi");
        assert_eq!(d["localMbps"], 3.5);
        assert_eq!(env.rec().reference_mbps(6_000), (Some(452.5), Some(40.0)));
        assert_eq!(env.rec().last_bufferbloat_ms(6_000), Some(68.0));

        // Neuer Start: Bezug wird beim ersten Schreiben aus net_events geladen
        let fresh = Mutex::new(Recorder::default());
        flush_at(&fresh, &env.gate, &env.db, 10_000).unwrap();
        let r = fresh.lock_safe();
        assert_eq!(r.reference_mbps(10_000), (Some(452.5), Some(40.0)));
        assert_eq!(r.last_bufferbloat_ms(10_000), Some(68.0));
        // Älter als 30 Tage → Vertragswerte, sonst keiner
        let later = 5_000 + REFERENCE_MAX_AGE_MS + 1;
        assert_eq!(r.reference_mbps(later), (None, None));
        assert_eq!(r.last_bufferbloat_ms(later), None);
    }

    #[test]
    fn reference_falls_back_to_contract() {
        let mut r = Recorder::default();
        r.apply_settings(&json!({ "ispLog": { "contractDownMbps": 500, "contractUpMbps": 50 } }));
        assert_eq!(r.reference_mbps(0), (Some(500.0), Some(50.0)));
        r.push_speedtest(1_000, &speed(420.0), None, None);
        assert_eq!(r.reference_mbps(2_000), (Some(420.0), Some(40.0)));
    }

    #[test]
    fn settings_loaded_once_kv_set_wins() {
        let env = Env::new();
        env.db.with(|db| db.kv_set("settings", &json!({ "ispLog": { "slowMs": 250 } }))).unwrap();
        assert_eq!(env.rec().settings().slow_ms, 100.0);
        env.flush(1_000).unwrap();
        assert_eq!(env.rec().settings().slow_ms, 250.0, "erstes Schreiben liest kv");
        env.rec().apply_settings(&json!({ "ispLog": { "slowMs": 300 } }));
        env.flush(2_000).unwrap();
        assert_eq!(env.rec().settings().slow_ms, 300.0, "gespiegelte Einstellung bleibt");
    }

    #[test]
    fn slow_median_from_measured_hours() {
        let env = Env::new();
        let hour = 3_600_000;
        let now = 100 * hour;
        env.db
            .with(|db| {
                for (i, avg) in [20.0, 22.0, 24.0, 26.0, 28.0, 90.0].iter().enumerate() {
                    let mut row = hourly_row((90 + i as i64) * hour);
                    row.n = 100;
                    row.lost = 0;
                    row.sum_rtt = avg * 100.0;
                    row.covered_ms = 40 * 60_000;
                    crate::db::upsert_hourly(db.conn(), &row).map_err(db_err)?;
                }
                // Zu wenig Messzeit → zählt nicht
                let mut thin = hourly_row(80 * hour);
                thin.sum_rtt = 5_000.0;
                crate::db::upsert_hourly(db.conn(), &thin).map_err(db_err)
            })
            .unwrap();
        let plan = LoadPlan { settings: false, median: Some(("aws-eu-central-1".into(), String::new())) };
        let loaded = env.db.with(|db| load_from_db(db.conn(), &plan, now).map_err(db_err)).unwrap();
        assert_eq!(loaded.median, Some(("aws-eu-central-1".into(), String::new(), Some(25.0))));
        let other = LoadPlan { settings: false, median: Some(("aws-eu-central-1".into(), "anderes-netz".into())) };
        let loaded = env.db.with(|db| load_from_db(db.conn(), &other, now).map_err(db_err)).unwrap();
        assert_eq!(loaded.median, Some(("aws-eu-central-1".into(), "anderes-netz".into(), None)), "weniger als 5 Messstunden");

        // Der Recorder fragt den Median für sein Hauptziel an und hält ihn eine Stunde
        let t = main_target();
        tick(&mut env.rec(), now, 1_000, &t, Some(20.0), IngestCtx::default());
        assert!(env.rec().load_plan(now).median.is_some());
        env.flush(now).unwrap();
        assert!(env.rec().load_plan(now + 1_000).median.is_none());
        assert!(env.rec().load_plan(now + SLOW_MEDIAN_REFRESH_MS).median.is_some());
    }

    #[test]
    fn flush_and_link_refresh_are_throttled() {
        let mut r = Recorder::default();
        let t = main_target();
        let a = tick(&mut r, 1_000, 1_000, &t, Some(20.0), IngestCtx::default());
        assert!(a.flush_due, "erster Takt lädt die Einstellungen");
        assert!(a.refresh_link, "ohne Hauptverbindung erneuern");
        let a = tick(&mut r, 2_000, 1_000, &t, Some(20.0), IngestCtx::default());
        assert!(!a.flush_due && !a.refresh_link);
        let mut now = 2_000;
        let mut flushes = 0;
        let mut refreshes = 0;
        while now < 1_000 + 120_000 {
            now += 1_000;
            let a = tick(&mut r, now, 1_000, &t, Some(20.0), IngestCtx::default());
            flushes += usize::from(a.flush_due);
            refreshes += usize::from(a.refresh_link);
        }
        assert_eq!(flushes, 2, "alle 60 s");
        assert_eq!(refreshes, 4, "alle 30 s");
        // Frische Hauptverbindung → kein Erneuern, auch wenn die letzte Anfrage lange her ist
        now += 40_000;
        let fresh = PrimaryLinkLite { at: now - 1_000, ..link("n", crate::net::link::LinkKind::Ethernet) };
        let a = tick(&mut r, now, 10_000, &t, Some(20.0), IngestCtx { link: Some(fresh), ..Default::default() });
        assert!(!a.refresh_link);
    }

    #[test]
    fn hourly_gets_all_targets_and_link() {
        // Mit Stub-Teilen ist nur prüfbar, dass mehrere Ziele ohne Absturz durchlaufen und das
        // Hauptziel das Fenster füllt.
        let mut r = Recorder::default();
        let a = main_target();
        let b = target("valve-cs2-fra", "127.0.0.2", PingMethod::Icmp);
        let samples = [
            PingSample { target_id: b.id.clone(), t: 1_000, rtt: Some(30.0) },
            PingSample { target_id: a.id.clone(), t: 1_000, rtt: Some(20.0) },
        ];
        r.ingest(1_000, 1_000, &[a.clone(), b], &[None, None], &samples, &LoadSample::default(), IngestCtx::default());
        assert_eq!(r.window.back(), Some(&Some(20.0)), "Werte über die Ziel-ID zugeordnet");
        // Keine Ziele → nichts
        let acts = r.ingest(2_000, 1_000, &[], &[], &[], &LoadSample::default(), IngestCtx::default());
        assert!(!acts.flush_due);
    }

    #[test]
    fn gap_limit_rule() {
        assert_eq!(gap_limit_ms(250), 5_000);
        assert_eq!(gap_limit_ms(1_000), 5_000);
        assert_eq!(gap_limit_ms(2_000), 6_000);
        assert_eq!(gap_limit_ms(10_000), 30_000);
    }

    #[test]
    fn merge_keeps_closed_flag() {
        let mut list = Vec::new();
        let e = NetEvent::new(EventKind::Quiet, 1);
        merge_draft(&mut list, EventDraft { key: 1, event: e.clone(), closed: true });
        let mut later = e.clone();
        later.end_t = Some(5);
        merge_draft(&mut list, EventDraft { key: 1, event: later, closed: false });
        merge_draft(&mut list, EventDraft { key: 2, event: e, closed: false });
        assert_eq!(list.len(), 2);
        assert!(list[0].closed);
        assert_eq!(list[0].event.end_t, Some(5));
    }
}
