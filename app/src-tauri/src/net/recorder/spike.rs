//! Live-Ausreißer des Hauptziels: Erkennung, Drosselung (eine Momentaufnahme je 10 s, `count`),
//! zweites `net://lag`, Ruhe-Messung alle 60 s und `spike`-Ereignisse (Lag-Detektiv). Vertrag:
//! `docs/API.md`, „Lag-Detektiv“.
//!
//! Rein (keine Ein-/Ausgabe, keine Sperren): Der Detektor liefert Aufträge (`SnapshotRequest`) und
//! Ereignisse (`EventDraft`), der Hook startet die Momentaufnahme, der Kern schreibt.

use std::net::Ipv4Addr;

use super::SnapshotRequest;
use crate::net::hist_types::{EventDraft, EventKind, NetEvent, KEY_SPIKE};
use crate::net::lag::{self, LagCause, LagEvent};
use crate::net::link::PrimaryLinkLite;
use crate::net::ping::effective_method;
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
    /// Vom Monitor aufgelöste IPv4 (keine → Momentaufnahme ohne Ziel und Teilroute)
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

/// Das laufende 10-s-Fenster eines Ausreißers.
#[derive(Debug, Clone)]
struct OpenSpike {
    key: u64,
    target_id: String,
    event: NetEvent,
    count: u32,
    baseline: f64,
    limit: f64,
    /// Ergebnis der Momentaufnahme (erste Meldung), sobald es da ist
    lag: Option<LagEvent>,
}

/// Erkennt Ausreißer und sammelt `spike`-Ereignisse.
#[derive(Debug, Default)]
pub struct SpikeDetector {
    open: Option<OpenSpike>,
    drafts: Vec<EventDraft>,
    next: u64,
    /// Beginn der laufenden Messung (nach Stopp/Lücke neu) – Ruhe-Messung erst nach 10 s
    since: Option<i64>,
    last_spike: Option<i64>,
    last_idle: Option<i64>,
}

impl SpikeDetector {
    pub fn push(&mut self, tick: &SpikeTick<'_>) -> SpikeOutcome {
        let mut out = SpikeOutcome::default();
        let t = tick.t;
        // Ende des 10-s-Fensters (oder Uhr zurück / anderes Ziel): abschließen, ggf. zweite Meldung
        let expired = self.open.as_ref().is_some_and(|o| t < o.event.t || t - o.event.t >= THROTTLE_MS || o.target_id != tick.target.id);
        if expired {
            out.lag_update = self.finish();
        }
        let since = *self.since.get_or_insert(t);

        out.spike = tick.rtt.is_some() && lag::is_live_spike(tick.window);
        // Während der Ruhezeit: keine Ereignisse, keine Momentaufnahme, keine Ruhe-Messung
        if tick.quiet {
            return out;
        }
        if out.spike {
            self.last_spike = Some(t);
            if let Some(open) = self.open.as_mut() {
                // Innerhalb der 10 s: nur zählen (ein Eintrag je 10 s)
                open.count = open.count.saturating_add(1);
                let draft = Self::draft_of(open, false);
                self.push_draft(draft);
            } else {
                out.snapshot = self.open_spike(tick);
            }
            return out;
        }
        // Ruhe-Messung: kein offenes Fenster, 10 s ohne Ausreißer, höchstens alle 60 s
        let calm_since = self.last_spike.filter(|s| *s <= t).map_or(since, |s| s.max(since));
        let idle_due = self.last_idle.is_none_or(|l| t < l || t - l >= IDLE_EVERY_MS);
        if tick.snapshots && self.open.is_none() && t - calm_since >= THROTTLE_MS && idle_due {
            self.last_idle = Some(t);
            out.snapshot = Some(SnapshotRequest {
                dst: tick.dst.unwrap_or(Ipv4Addr::UNSPECIFIED),
                target: tick.target.clone(),
                rtt: 0.0,
                baseline: 0.0,
                limit: 0.0,
                at: t,
                idle: true,
            });
        }
        out
    }

    /// Neues 10-s-Fenster: `spike`-Ereignis anlegen und die Momentaufnahme anfordern. Ohne IPv4 des
    /// Ziels kommt `0.0.0.0` (die Momentaufnahme misst dann weder Ziel noch Teilroute).
    fn open_spike(&mut self, tick: &SpikeTick<'_>) -> Option<SnapshotRequest> {
        let rtt = tick.rtt?;
        let ok: Vec<f64> = tick.window.iter().rev().take(lag::LIVE_WINDOW).flatten().copied().collect();
        let limit = lag::spike_limit(&ok)?;
        let baseline = lag::baseline(&tick.window[tick.window.len().saturating_sub(lag::LIVE_WINDOW)..])?;
        let mut event = NetEvent::new(EventKind::Spike, tick.t);
        event.target_key = Some(tick.target.id.clone());
        event.target_label = Some(tick.target.label.clone());
        event.method = Some(effective_method(tick.target.method));
        if let Some(l) = tick.link {
            event.net_id = l.net_id.clone();
            event.connection = Some(l.connection());
        }
        event.value = Some(rtt);
        event.cause = Some(LagCause::Unknown);
        event.session_id = tick.session_id;
        self.next = self.next.wrapping_add(1) & !(0xF << 60);
        let open = OpenSpike { key: KEY_SPIKE | self.next, target_id: tick.target.id.clone(), event, count: 1, baseline, limit, lag: None };
        let draft = Self::draft_of(&open, false);
        self.open = Some(open);
        self.push_draft(draft);
        Some(SnapshotRequest {
            dst: tick.dst.unwrap_or(Ipv4Addr::UNSPECIFIED),
            target: tick.target.clone(),
            rtt,
            baseline,
            limit,
            at: tick.t,
            idle: false,
        })
    }

    /// Aktueller Stand des offenen Ereignisses (Ursache und `detail` aus der Momentaufnahme).
    fn draft_of(open: &OpenSpike, closed: bool) -> EventDraft {
        let mut event = open.event.clone();
        if let Some(ev) = open.lag.as_ref() {
            event.cause = Some(ev.check.cause);
        }
        event.detail = Some(lag::spike_detail(open.count, open.baseline, open.limit, open.lag.as_ref().map(|e| &e.check)));
        EventDraft { key: open.key, event, closed }
    }

    fn push_draft(&mut self, draft: EventDraft) {
        match self.drafts.iter_mut().find(|d| d.key == draft.key) {
            Some(slot) => {
                let closed = slot.closed || draft.closed;
                *slot = EventDraft { closed, ..draft };
            }
            None => self.drafts.push(draft),
        }
    }

    /// Fenster abschließen: letzter Stand als abgeschlossenes Ereignis; bei `count > 1` die zweite
    /// Meldung mit dem endgültigen `count` (nur, wenn die Momentaufnahme schon da ist).
    fn finish(&mut self) -> Option<LagEvent> {
        let open = self.open.take()?;
        let draft = Self::draft_of(&open, true);
        self.push_draft(draft);
        if open.count > 1 {
            open.lag.map(|mut ev| {
                ev.count = open.count;
                ev
            })
        } else {
            None
        }
    }

    /// Ergebnis der Momentaufnahme übernehmen (Ursache, Detail des `spike`-Eintrags). Gehört es zu
    /// keinem offenen Fenster mehr, wird es nicht mehr gespeichert (die Live-Meldung kam trotzdem).
    pub fn on_snapshot(&mut self, ev: &LagEvent) {
        let Some(open) = self.open.as_mut() else { return };
        if open.event.t != ev.check.at || open.target_id != ev.target_id {
            return;
        }
        open.lag = Some(ev.clone());
        let draft = Self::draft_of(open, false);
        self.push_draft(draft);
    }

    /// Offenes 10-s-Fenster schließen (Stopp, Lücke). Die Ruhe-Messung wartet danach wieder 10 s.
    pub fn close(&mut self, t: i64) {
        let _ = t;
        let _ = self.finish();
        self.since = None;
    }

    /// Neue bzw. geänderte `spike`-Ereignisse herausnehmen.
    pub fn take_drafts(&mut self) -> Vec<EventDraft> {
        std::mem::take(&mut self.drafts)
    }

    /// Alles verwerfen (Verlauf gelöscht, Aufzeichnung aus). Ein offenes Fenster zählt danach als neu.
    pub fn clear(&mut self) {
        self.drafts.clear();
        self.open = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::hist_types::{ConnectionKind, TargetKind};
    use crate::net::lag::{LagCheck, LagSnapshot, Reason};
    use crate::net::link::LinkKind;
    use crate::net::types::PingMethod;

    fn target() -> PingTarget {
        PingTarget { id: "aws-eu-central-1".into(), label: "Frankfurt".into(), host: "dynamodb.eu-central-1.amazonaws.com".into(), port: None, method: PingMethod::Tcp }
    }

    fn wifi_link() -> PrimaryLinkLite {
        PrimaryLinkLite { luid: 1, if_index: 2, kind: LinkKind::Wifi, gateway: None, net_id: "abc123def456".into(), vpn: false, at: 0 }
    }

    /// Test-Lauf: eigenes Fenster wie im Recorder.
    struct Run {
        det: SpikeDetector,
        window: Vec<Option<f64>>,
        target: PingTarget,
        link: PrimaryLinkLite,
        snapshots: bool,
        quiet: bool,
    }

    impl Run {
        fn new() -> Run {
            Run { det: SpikeDetector::default(), window: Vec::new(), target: target(), link: wifi_link(), snapshots: true, quiet: false }
        }

        fn tick(&mut self, t: i64, rtt: Option<f64>) -> SpikeOutcome {
            self.window.push(rtt);
            if self.window.len() > 60 {
                self.window.remove(0);
            }
            let tick = SpikeTick {
                t,
                rtt,
                window: &self.window,
                target: &self.target,
                dst: Some(Ipv4Addr::new(3, 123, 1, 77)),
                quiet: self.quiet,
                session_id: Some(4),
                link: Some(&self.link),
                snapshots: self.snapshots,
            };
            self.det.push(&tick)
        }

        /// 20 ruhige Werte (20 ms) ab `t0` im 1-s-Takt.
        fn calm(&mut self, t0: i64, n: i64) -> Vec<SpikeOutcome> {
            (0..n).map(|i| self.tick(t0 + i * 1000, Some(20.0))).collect()
        }
    }

    fn lag_event_for(req: &SnapshotRequest, cause: LagCause) -> LagEvent {
        LagEvent {
            check: LagCheck { at: req.at, cause, cpu_high: false, reasons: vec![Reason::GatewaySlow], snapshot: LagSnapshot::off(req.at) },
            target_id: req.target.id.clone(),
            target_label: req.target.label.clone(),
            target_kind: TargetKind::from_target_id(&req.target.id),
            rtt: req.rtt,
            baseline: req.baseline,
            limit: req.limit,
            count: 1,
            session_id: Some(4),
        }
    }

    #[test]
    fn throttle_10s_merges_count() {
        let mut r = Run::new();
        r.calm(0, 20);
        // Ausreißer bei 20 s → Momentaufnahme
        let first = r.tick(20_000, Some(180.0));
        assert!(first.spike);
        let req = first.snapshot.expect("Momentaufnahme");
        assert!(!req.idle);
        assert_eq!((req.at, req.rtt, req.baseline, req.limit), (20_000, 180.0, 20.0, 60.0));
        assert_eq!(req.dst, Ipv4Addr::new(3, 123, 1, 77));
        // Ergebnis der Momentaufnahme kommt (≤ 1,5 s), weitere Ausreißer nur gezählt
        r.det.on_snapshot(&lag_event_for(&req, LagCause::Wifi));
        let second = r.tick(21_000, Some(20.0));
        assert!(second.snapshot.is_none() && second.lag_update.is_none());
        let third = r.tick(22_000, Some(190.0));
        assert!(third.spike && third.snapshot.is_none(), "höchstens eine Momentaufnahme je 10 s");
        let fourth = r.tick(25_000, Some(200.0));
        assert!(fourth.spike && fourth.snapshot.is_none());
        // Nach 10 s: zweite Meldung mit endgültigem count und gleichem at/targetId
        let end = r.tick(30_000, Some(20.0));
        let upd = end.lag_update.expect("zweites net://lag");
        assert_eq!((upd.check.at, upd.target_id.as_str(), upd.count, upd.check.cause), (20_000, "aws-eu-central-1", 3, LagCause::Wifi));
        // Ein Eintrag: abgeschlossen, count 3, Ursache aus der Momentaufnahme
        let drafts = r.det.take_drafts();
        assert_eq!(drafts.len(), 1);
        let d = &drafts[0];
        assert!(d.closed);
        assert_eq!(d.key >> 60, KEY_SPIKE >> 60);
        assert_eq!(d.event.kind, EventKind::Spike);
        assert_eq!((d.event.t, d.event.end_t, d.event.value), (20_000, None, Some(180.0)));
        assert_eq!(d.event.cause, Some(LagCause::Wifi));
        assert_eq!(d.event.count(), 3);
        assert_eq!(d.event.connection, Some(ConnectionKind::Wifi));
        assert_eq!(d.event.net_id, "abc123def456");
        assert_eq!(d.event.session_id, Some(4));
        let detail = d.event.detail.as_ref().unwrap();
        assert_eq!(detail["reasons"], serde_json::json!(["gatewaySlow"]));
        assert_eq!(detail["limit"], 60.0);
        // Ein neuer Ausreißer danach öffnet ein neues Fenster
        let again = r.tick(31_000, Some(180.0));
        assert!(again.snapshot.is_some());
    }

    #[test]
    fn single_spike_has_no_second_message() {
        let mut r = Run::new();
        r.calm(0, 20);
        let req = r.tick(20_000, Some(180.0)).snapshot.unwrap();
        r.det.on_snapshot(&lag_event_for(&req, LagCause::Isp));
        let end = r.tick(30_000, Some(20.0));
        assert!(end.lag_update.is_none(), "count = 1 → keine zweite Meldung");
        let drafts = r.det.take_drafts();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].event.cause, Some(LagCause::Isp));
    }

    #[test]
    fn snapshots_off_shape() {
        let mut r = Run::new();
        r.snapshots = false;
        let outs = r.calm(0, 80);
        assert!(outs.iter().all(|o| o.snapshot.is_none()), "keine Ruhe-Messungen ohne Momentaufnahmen");
        // Ein Ausreißer wird trotzdem gemeldet (der Hook schickt ihn ohne Pakete als unknown/snapshotsOff)
        let req = r.tick(80_000, Some(180.0)).snapshot.expect("Meldung auch ohne Momentaufnahmen");
        assert!(!req.idle);
        let off = LagEvent {
            check: LagCheck { at: req.at, cause: LagCause::Unknown, cpu_high: false, reasons: vec![Reason::SnapshotsOff], snapshot: LagSnapshot::off(req.at) },
            ..lag_event_for(&req, LagCause::Unknown)
        };
        r.det.on_snapshot(&off);
        let v = serde_json::to_value(&off).unwrap();
        let snap = &v["snapshot"];
        assert_eq!(snap["hops"], serde_json::json!([]));
        assert_eq!(snap["viaVpn"], false);
        assert_eq!(snap["tookMs"], 0);
        for k in ["connection", "targetMs", "targetLost", "gatewayMs", "gatewayBaseMs", "wifi", "wifiState", "signalBase", "rxMbps", "txMbps", "trafficBaseMbps", "refDownMbps", "refUpMbps", "cpu"] {
            assert!(snap[k].is_null(), "{k} ist null");
        }
        r.det.close(81_000);
        let d = r.det.take_drafts();
        assert_eq!(d[0].event.cause, Some(LagCause::Unknown));
        assert_eq!(d[0].event.detail.as_ref().unwrap()["reasons"], serde_json::json!(["snapshotsOff"]));
    }

    #[test]
    fn idle_snapshot_every_60s_after_10s_calm() {
        let mut r = Run::new();
        let outs = r.calm(0, 200);
        let idle: Vec<i64> = outs.iter().filter_map(|o| o.snapshot.as_ref()).inspect(|s| assert!(s.idle)).map(|s| s.at).collect();
        assert_eq!(idle, vec![10_000, 70_000, 130_000, 190_000], "erst nach 10 s, dann alle 60 s");
        // Nach einem Ausreißer frühestens 10 s später
        let mut r = Run::new();
        r.calm(0, 20);
        r.tick(20_000, Some(180.0));
        let outs: Vec<(i64, SpikeOutcome)> = (21..120).map(|s| (s * 1000, r.tick(s * 1000, Some(20.0)))).collect();
        let first_idle = outs.iter().find(|(_, o)| o.snapshot.as_ref().is_some_and(|s| s.idle)).map(|(t, _)| *t);
        assert_eq!(first_idle, Some(70_000), "letzte Ruhe-Messung bei 10 s → nächste bei 70 s");
    }

    #[test]
    fn quiet_time_no_events_no_snapshots() {
        let mut r = Run::new();
        r.calm(0, 20);
        r.quiet = true;
        let out = r.tick(20_000, Some(300.0));
        assert!(out.spike, "der Messwert bleibt ein Ausreißer (Stunden-Summen)");
        assert!(out.snapshot.is_none());
        let outs = r.calm(21_000, 90);
        assert!(outs.iter().all(|o| o.snapshot.is_none()), "keine Ruhe-Messung in der Ruhezeit");
        assert!(r.det.take_drafts().is_empty());
    }

    #[test]
    fn no_ipv4_still_reports() {
        let mut det = SpikeDetector::default();
        let t = target();
        let mut window: Vec<Option<f64>> = vec![Some(20.0); 15];
        window.push(Some(150.0));
        let out = det.push(&SpikeTick { t: 1, rtt: Some(150.0), window: &window, target: &t, dst: None, quiet: false, session_id: None, link: None, snapshots: true });
        let req = out.snapshot.unwrap();
        assert!(req.dst.is_unspecified(), "ohne IPv4 → Momentaufnahme ohne Ziel/Teilroute");
        let d = det.take_drafts();
        assert_eq!(d[0].event.connection, None);
        assert_eq!(d[0].event.net_id, "");
    }

    #[test]
    fn spike_one_row_per_10s() {
        use crate::net::ifstats::LoadSample;
        use crate::net::recorder::{flush_with, FlushGate, IngestCtx, Recorder};
        use crate::net::types::PingSample;
        use std::sync::Mutex;

        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::DbHandle::new();
        db.replace(Some(crate::db::Db::open(&dir.path().join("pulsar.db")).unwrap()));
        let rec = Mutex::new(Recorder::default());
        let gate = FlushGate::default();
        let t = target();
        let ctx = IngestCtx { link: Some(wifi_link()), ..Default::default() };
        let tick = |time: i64, rtt: f64| {
            let samples = [PingSample { target_id: t.id.clone(), t: time, rtt: Some(rtt) }];
            rec.lock().unwrap().ingest(time, 1000, std::slice::from_ref(&t), &[None], &samples, &LoadSample { at: time, ..Default::default() }, ctx.clone())
        };
        for s in 0..20 {
            tick(s * 1000, 20.0);
        }
        // 4 Ausreißer in 10 s, dann ruhig; danach ein zweites Fenster mit 1 Ausreißer
        let a = tick(20_000, 180.0);
        let req = a.snapshot.expect("Momentaufnahme");
        tick(21_000, 190.0);
        flush_with(&rec, &gate, &db).unwrap();
        rec.lock().unwrap().on_snapshot(&lag_event_for(&req, LagCause::Router));
        tick(23_000, 200.0);
        tick(26_000, 210.0);
        for s in 27..40 {
            tick(s * 1000, 20.0);
        }
        tick(40_000, 300.0);
        rec.lock().unwrap().on_stop(41_000);
        flush_with(&rec, &gate, &db).unwrap();
        let rows: Vec<(i64, String, String)> = db
            .with(|d| {
                let mut st = d.conn().prepare("SELECT t, cause, detail FROM net_events WHERE kind = 'spike' ORDER BY t").map_err(crate::error::db_err)?;
                let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(crate::error::db_err)?;
                Ok(it.filter_map(Result::ok).collect())
            })
            .unwrap();
        assert_eq!(rows.len(), 2, "ein Eintrag je 10-s-Fenster: {rows:?}");
        assert_eq!(rows[0].0, 20_000);
        assert_eq!(rows[0].1, "router", "Ursache nach dem ersten Schreiben nachgetragen");
        let d0: serde_json::Value = serde_json::from_str(&rows[0].2).unwrap();
        assert_eq!(d0["count"], 4);
        assert_eq!(rows[1].0, 40_000);
        assert_eq!(rows[1].1, "unknown");
    }
}
