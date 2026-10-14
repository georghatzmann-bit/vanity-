//! Ereignisse des Anbieter-Protokolls: `outage`, `loss`, `slow` (nie während der Ruhezeit, Lücken
//! und getrennte Verbindung ausgenommen) und die Anforderung der Umfangsprüfung. Vertrag:
//! `docs/API.md`, „Anbieter-Protokoll“.
//!
//! Rein (keine Ein-/Ausgabe, keine Sperren): Der Detektor bekommt die Takte des Hauptziels, fordert
//! beim dritten Verlust in Folge eine Umfangsprüfung an und liefert neue bzw. geänderte Ereignisse
//! als `EventDraft` (Schlüssel `KEY_EVENTS | n`); der Kern schreibt sie.
//!
//! - **Aussetzer:** mindestens 3 Verluste in Folge und mindestens 3 s ohne Antwort (vom ersten
//!   Verlust bis zum Ende des letzten Verlust-Takts: `letzter − erster + Intervall`). Beginn = erster
//!   Verlust, Ende = erste Antwort danach (Stopp/Lücke: letzter Verlust). Nach dem Ende wartet der
//!   Eintrag höchstens [`SCOPE_WAIT_MS`] offen auf das Ergebnis der Umfangsprüfung.
//! - **Verlust:** am Ende jeder Kalenderminute über die letzten `max(60 s, 20 Messungen)` ohne
//!   Aussetzer-Messungen und ohne getrennte Verbindung. Eine noch offene Verlust-Folge (vielleicht ein
//!   Aussetzer) verschiebt die Bewertung, bis sie entschieden ist.
//! - **Langsam:** Kalenderminute mit mindestens 5 Antworten und Durchschnitt über der Schwelle
//!   `max(ispLog.slowMs, Median des Ziels der letzten 14 Tage + 50 ms)`.
//!
//! Direkt folgende Treffer (nächste Kalenderminute) verlängern `loss`/`slow`.

use std::collections::VecDeque;

use serde_json::json;

use crate::net::hist_types::{ConnectionKind, EventDraft, EventKind, NetEvent, OutageScope, KEY_EVENTS};
use crate::net::ifstats::OperStatus;
use crate::net::link::PrimaryLinkLite;
use crate::net::scope::{self, ScopeChecks, ScopeRequest};
use crate::net::types::{PingMethod, PingTarget};

/// Aussetzer: mindestens so viele Verluste in Folge …
pub const OUTAGE_MIN_LOSSES: u32 = 3;
/// … und mindestens so lange ohne Antwort (ms).
pub const OUTAGE_MIN_MS: i64 = 3_000;
/// Nach dem Ende eines Aussetzers höchstens so lange auf die Umfangsprüfung warten (ms).
pub const SCOPE_WAIT_MS: i64 = 5_000;
/// Verlust-Fenster: mindestens 60 s …
pub const LOSS_WINDOW_MS: i64 = 60_000;
/// … bzw. mindestens 20 Messungen; ebenso viele braucht eine Bewertung.
pub const LOSS_MIN_SAMPLES: usize = 20;
/// Mindestens so viele Verluste …
pub const LOSS_MIN_LOST: usize = 2;
/// … und mehr als so viel Prozent.
pub const LOSS_MIN_PCT: f64 = 5.0;
/// Langsame Minute: mindestens so viele Antworten.
pub const SLOW_MIN_ANSWERS: u32 = 5;
/// Relative Schwelle: Median des Ziels + so viel (ms).
pub const SLOW_MEDIAN_MARGIN_MS: f64 = 50.0;
/// Eine Kalenderminute (ms).
const MINUTE_MS: i64 = 60_000;

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

/// Messziel, Netz und Sitzung, mit denen ein Ereignis angelegt wird.
#[derive(Debug, Clone, PartialEq)]
struct Meta {
    target_key: String,
    target_label: String,
    method: PingMethod,
    net_id: String,
    connection: Option<ConnectionKind>,
    session_id: Option<i64>,
    slow_ms: f64,
}

impl Meta {
    fn of(tick: &EventTick<'_>) -> Self {
        Meta {
            target_key: tick.target.id.clone(),
            target_label: tick.target.label.clone(),
            method: tick.method,
            net_id: tick.link.map(|l| l.net_id.clone()).unwrap_or_default(),
            connection: tick.link.map(PrimaryLinkLite::connection),
            session_id: tick.session_id,
            slow_ms: tick.slow_ms,
        }
    }

    fn event(&self, kind: EventKind, t: i64) -> NetEvent {
        let mut e = NetEvent::new(kind, t);
        e.target_key = Some(self.target_key.clone());
        e.target_label = Some(self.target_label.clone());
        e.method = Some(self.method);
        e.net_id = self.net_id.clone();
        e.connection = self.connection;
        e.session_id = self.session_id;
        e
    }
}

/// Ein bestätigter Aussetzer.
#[derive(Debug, Clone)]
struct Outage {
    key: u64,
    event: NetEvent,
    /// Verbindung getrennt bzw. gewechselt (→ `pc`, schlägt jedes Prüfergebnis)
    pc: bool,
    scope: Option<OutageScope>,
    checks: Option<ScopeChecks>,
}

impl Outage {
    fn draft(&self, closed: bool) -> EventDraft {
        let mut event = self.event.clone();
        event.scope = Some(if self.pc { OutageScope::Pc } else { self.scope.unwrap_or(OutageScope::Unknown) });
        event.value = event.end_t.map(|end| (end - event.t).max(0) as f64 / 1000.0);
        event.detail = Some(json!({ "checks": self.checks.unwrap_or_default() }));
        EventDraft { key: self.key, event, closed }
    }
}

/// Verluste in Folge (vielleicht ein Aussetzer).
#[derive(Debug, Clone)]
struct LossRun {
    first_t: i64,
    last_t: i64,
    count: u32,
    /// Zeiten der Verluste (für das Verlust-Fenster, wenn es kein Aussetzer wird)
    losses: Vec<i64>,
    link_start: Option<PrimaryLinkLite>,
    requested: bool,
    pc: bool,
    scope: Option<OutageScope>,
    checks: Option<ScopeChecks>,
    /// Ab der Bestätigung als Aussetzer
    outage: Option<Outage>,
}

/// Ein beendeter Aussetzer, der noch auf die Umfangsprüfung wartet.
#[derive(Debug, Clone)]
struct Ending {
    outage: Outage,
    deadline: i64,
}

/// Ein offenes `loss`- bzw. `slow`-Ereignis (verlängert sich über direkt folgende Minuten).
#[derive(Debug, Clone)]
struct OpenWindow {
    key: u64,
    event: NetEvent,
    /// Ende der letzten Treffer-Minute (ms)
    last_end: i64,
    minutes: u32,
}

/// Summen der laufenden Kalenderminute (langsam).
#[derive(Debug, Clone, Copy, PartialEq)]
struct MinuteAcc {
    start: i64,
    answers: u32,
    sum: f64,
}

/// Erkennt Aussetzer, Verlust und langsame Minuten.
#[derive(Debug, Default)]
pub struct EventDetector {
    next: u64,
    drafts: Vec<EventDraft>,
    /// Zeit des letzten verarbeiteten Takts (ohne Ruhezeit)
    last_t: Option<i64>,
    /// Ziel/Netz/Sitzung des letzten Takts
    meta: Option<Meta>,
    run: Option<LossRun>,
    endings: Vec<Ending>,
    /// Verlust-Fenster: `(t, verloren)`, nach `t` sortiert
    samples: VecDeque<(i64, bool)>,
    /// Bewertung der Minute bis zu dieser Grenze wartet auf eine offene Verlust-Folge
    pending_loss: Option<(i64, Meta)>,
    minute: Option<MinuteAcc>,
    loss_open: Option<OpenWindow>,
    slow_open: Option<OpenWindow>,
    /// `(target_key, net_id, Median)` für die relative `slow`-Schwelle
    median: Option<(String, String, Option<f64>)>,
}

/// Auf eine Nachkommastelle runden.
fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn minute_start(t: i64) -> i64 {
    t.div_euclid(MINUTE_MS) * MINUTE_MS
}

impl EventDetector {
    /// Takt verarbeiten; beim dritten Verlust in Folge kommt die Umfangsprüfung zurück.
    pub fn push(&mut self, tick: &EventTick<'_>) -> Option<ScopeRequest> {
        let t = tick.t;
        self.expire_endings(t);
        // Ruhezeit: nichts protokollieren, angefangene Folgen und Fenster verwerfen
        if tick.quiet {
            if let Some(last) = self.last_t {
                self.interrupt(last);
            }
            return None;
        }
        // Uhr zurück (der Kern meldet das als Lücke; hier nur zur Sicherheit)
        if self.last_t.is_some_and(|last| t < last) {
            if let Some(last) = self.last_t {
                self.interrupt(last);
            }
        }
        if let Some(prev) = self.last_t {
            let boundary = minute_start(prev) + MINUTE_MS;
            if t >= boundary {
                self.on_minute_end(boundary);
            }
        }

        let disconnected = tick.status.is_some_and(|s| !s.connected());
        let mut request = None;
        match tick.rtt {
            None => request = self.on_loss(tick, disconnected),
            Some(rtt) => {
                self.finish_run(t);
                if !disconnected {
                    self.push_sample(t, false);
                    let start = minute_start(t);
                    let acc = self.minute.get_or_insert(MinuteAcc { start, answers: 0, sum: 0.0 });
                    if acc.start != start {
                        *acc = MinuteAcc { start, answers: 0, sum: 0.0 };
                    }
                    acc.answers += 1;
                    acc.sum += rtt;
                }
            }
        }
        // Aufgeschobene Verlust-Bewertung, sobald die Folge entschieden ist
        if self.run.as_ref().is_none_or(|r| r.outage.is_some()) {
            if let Some((boundary, meta)) = self.pending_loss.take() {
                self.evaluate_loss(boundary, &meta);
            }
        }
        self.meta = Some(Meta::of(tick));
        self.last_t = Some(t);
        request
    }

    /// Ein Verlust: Folge beginnen bzw. verlängern, Umfangsprüfung anfordern, Aussetzer bestätigen.
    fn on_loss(&mut self, tick: &EventTick<'_>, disconnected: bool) -> Option<ScopeRequest> {
        let t = tick.t;
        let run = self.run.get_or_insert_with(|| LossRun {
            first_t: t,
            last_t: t,
            count: 0,
            losses: Vec::new(),
            link_start: tick.link.cloned(),
            requested: false,
            pc: false,
            scope: None,
            checks: None,
            outage: None,
        });
        run.count = run.count.saturating_add(1);
        run.last_t = t;
        if !disconnected {
            run.losses.push(t);
        }
        if disconnected || scope::link_changed(run.link_start.as_ref(), tick.link) {
            run.pc = true;
        }
        let mut request = None;
        if run.count >= OUTAGE_MIN_LOSSES && !run.requested {
            run.requested = true;
            request = Some(ScopeRequest { outage_t: run.first_t, link_start: run.link_start.clone(), gateway_base: tick.gateway_base });
        }
        let interval = i64::try_from(tick.interval_ms).unwrap_or(i64::MAX / 4);
        let silent_ms = (run.last_t - run.first_t).saturating_add(interval);
        if run.outage.is_none() && run.count >= OUTAGE_MIN_LOSSES && silent_ms >= OUTAGE_MIN_MS {
            self.next = self.next.wrapping_add(1) & !(0xF << 60);
            let event = Meta::of(tick).event(EventKind::Outage, run.first_t);
            run.outage = Some(Outage { key: KEY_EVENTS | self.next, event, pc: false, scope: None, checks: None });
        }
        if let Some(o) = run.outage.as_mut() {
            o.event.end_t = Some(t);
            o.pc = run.pc;
            o.scope = run.scope;
            o.checks = run.checks;
            let draft = o.draft(false);
            push_draft(&mut self.drafts, draft);
        }
        request
    }

    /// Die Verlust-Folge endet (Antwort bei `end`): Aussetzer abschließen bzw. die Verluste ins
    /// Verlust-Fenster übernehmen.
    fn finish_run(&mut self, end: i64) {
        let Some(run) = self.run.take() else { return };
        match run.outage {
            Some(mut o) => {
                o.event.end_t = Some(end);
                self.end_outage(o, end);
            }
            None => {
                for t in run.losses {
                    self.push_sample(t, true);
                }
            }
        }
    }

    /// Aussetzer beendet: abschließen, wenn der Umfang feststeht, sonst kurz auf die Prüfung warten.
    fn end_outage(&mut self, o: Outage, now: i64) {
        if o.pc || o.scope.is_some() {
            push_draft(&mut self.drafts, o.draft(true));
        } else {
            push_draft(&mut self.drafts, o.draft(false));
            self.endings.push(Ending { outage: o, deadline: now.saturating_add(SCOPE_WAIT_MS) });
        }
    }

    /// Wartende Aussetzer nach Fristablauf (oder zurückgestellter Uhr) mit `unknown` abschließen.
    fn expire_endings(&mut self, t: i64) {
        let mut i = 0;
        while i < self.endings.len() {
            let e = &self.endings[i];
            if t >= e.deadline || t < e.outage.event.t {
                let e = self.endings.remove(i);
                push_draft(&mut self.drafts, e.outage.draft(true));
            } else {
                i += 1;
            }
        }
    }

    fn push_sample(&mut self, t: i64, lost: bool) {
        self.samples.push_back((t, lost));
        // Genug für die nächste Bewertung behalten: 2 Minuten bzw. doppelt so viele wie nötig
        while self.samples.len() > 2 * LOSS_MIN_SAMPLES && self.samples.front().is_some_and(|(s, _)| *s < t - 2 * LOSS_WINDOW_MS) {
            self.samples.pop_front();
        }
    }

    /// Ende einer Kalenderminute (`boundary` = Beginn der neuen Minute).
    fn on_minute_end(&mut self, boundary: i64) {
        let Some(meta) = self.meta.clone() else { return };
        self.evaluate_slow(boundary, &meta);
        if let Some((old, old_meta)) = self.pending_loss.take() {
            // Noch eine Grenze offen (sehr langer Takt): mit dem bekannten Stand bewerten
            self.evaluate_loss(old, &old_meta);
        }
        if self.run.as_ref().is_some_and(|r| r.outage.is_none()) {
            self.pending_loss = Some((boundary, meta));
        } else {
            self.evaluate_loss(boundary, &meta);
        }
    }

    /// Relative Schwelle für das Ziel/Netz von `meta`.
    fn threshold(&self, meta: &Meta) -> f64 {
        let relative = match &self.median {
            Some((target, net, Some(median))) if *target == meta.target_key && *net == meta.net_id && median.is_finite() => {
                Some(median + SLOW_MEDIAN_MARGIN_MS)
            }
            _ => None,
        };
        relative.map_or(meta.slow_ms, |r| r.max(meta.slow_ms))
    }

    fn evaluate_slow(&mut self, boundary: i64, meta: &Meta) {
        let minute = self.minute.take().filter(|m| m.start == boundary - MINUTE_MS);
        let threshold = self.threshold(meta);
        let hit = minute.filter(|m| m.answers >= SLOW_MIN_ANSWERS).map(|m| m.sum / f64::from(m.answers)).filter(|avg| *avg > threshold);
        match hit {
            Some(avg) => {
                let start = boundary - MINUTE_MS;
                let extend = self.slow_open.as_ref().is_some_and(|o| o.last_end == start);
                if !extend {
                    self.close_window(WindowKind::Slow);
                    let key = self.new_key();
                    let event = meta.event(EventKind::Slow, start);
                    self.slow_open = Some(OpenWindow { key, event, last_end: start, minutes: 0 });
                }
                if let Some(o) = self.slow_open.as_mut() {
                    o.last_end = boundary;
                    o.minutes += 1;
                    o.event.end_t = Some(boundary);
                    o.event.value = Some(o.event.value.map_or(r1(avg), |v| v.max(r1(avg))));
                    o.event.detail = Some(json!({ "threshold": r1(threshold), "minutes": o.minutes }));
                    let draft = EventDraft { key: o.key, event: o.event.clone(), closed: false };
                    push_draft(&mut self.drafts, draft);
                }
            }
            None => self.close_window(WindowKind::Slow),
        }
    }

    /// Verlust-Fenster bis `boundary` bewerten.
    fn evaluate_loss(&mut self, boundary: i64, meta: &Meta) {
        let before: Vec<(i64, bool)> = self.samples.iter().copied().filter(|(t, _)| *t < boundary).collect();
        let recent = before.iter().filter(|(t, _)| *t >= boundary - LOSS_WINDOW_MS).count();
        let take = recent.max(LOSS_MIN_SAMPLES).min(before.len());
        let window = &before[before.len() - take..];
        let n = window.len();
        let lost = window.iter().filter(|(_, l)| *l).count();
        let pct = if n > 0 { lost as f64 * 100.0 / n as f64 } else { 0.0 };
        if n >= LOSS_MIN_SAMPLES && lost >= LOSS_MIN_LOST && pct > LOSS_MIN_PCT {
            let first_t = window.first().map_or(boundary - LOSS_WINDOW_MS, |(t, _)| *t);
            let extend = self.loss_open.as_ref().is_some_and(|o| o.last_end == boundary - MINUTE_MS);
            if !extend {
                self.close_window(WindowKind::Loss);
                let key = self.new_key();
                let event = meta.event(EventKind::Loss, first_t);
                self.loss_open = Some(OpenWindow { key, event, last_end: boundary, minutes: 0 });
            }
            if let Some(o) = self.loss_open.as_mut() {
                o.last_end = boundary;
                o.minutes += 1;
                o.event.end_t = Some(boundary);
                let pct = r1(pct);
                if o.event.value.is_none_or(|v| pct > v) {
                    o.event.value = Some(pct);
                    o.event.detail = Some(json!({ "lost": lost, "n": n }));
                }
                let draft = EventDraft { key: o.key, event: o.event.clone(), closed: false };
                push_draft(&mut self.drafts, draft);
            }
        } else {
            self.close_window(WindowKind::Loss);
        }
    }

    fn close_window(&mut self, kind: WindowKind) {
        let open = match kind {
            WindowKind::Loss => self.loss_open.take(),
            WindowKind::Slow => self.slow_open.take(),
        };
        if let Some(o) = open {
            push_draft(&mut self.drafts, EventDraft { key: o.key, event: o.event, closed: true });
        }
    }

    fn new_key(&mut self) -> u64 {
        self.next = self.next.wrapping_add(1) & !(0xF << 60);
        KEY_EVENTS | self.next
    }

    /// Lücke, Stopp oder Ruhezeit: offene Ereignisse schließen (Aussetzer am letzten Verlust),
    /// Folge, Fenster und Minute verwerfen.
    fn interrupt(&mut self, last_t: i64) {
        if let Some(run) = self.run.take() {
            if let Some(mut o) = run.outage {
                o.event.end_t = Some(run.last_t);
                self.end_outage(o, last_t);
            }
        }
        self.close_window(WindowKind::Loss);
        self.close_window(WindowKind::Slow);
        self.samples.clear();
        self.pending_loss = None;
        self.minute = None;
        self.last_t = None;
    }

    /// Median des Ziels der letzten 14 Tage (für die relative `slow`-Schwelle; `None` = zu wenig
    /// Messstunden). Setzt der Kern nach dem Laden aus `ping_hourly`.
    pub fn set_target_median(&mut self, target_key: &str, net_id: &str, median: Option<f64>) {
        self.median = Some((target_key.to_string(), net_id.to_string(), median));
    }

    /// Ergebnis der Umfangsprüfung für den Aussetzer, der bei `outage_t` begann. Eine erkannte
    /// Trennung (`pc`) bleibt; kommt das Ergebnis zu spät, bleibt `unknown`.
    pub fn on_scope(&mut self, outage_t: i64, scope: OutageScope) {
        let checks = scope::take_checks(outage_t);
        if let Some(run) = self.run.as_mut().filter(|r| r.first_t == outage_t) {
            run.scope = Some(scope);
            run.checks = checks;
            if let Some(o) = run.outage.as_mut() {
                o.scope = Some(scope);
                o.checks = checks;
                let draft = o.draft(false);
                push_draft(&mut self.drafts, draft);
            }
            return;
        }
        if let Some(pos) = self.endings.iter().position(|e| e.outage.event.t == outage_t) {
            let mut e = self.endings.remove(pos);
            e.outage.scope = Some(scope);
            e.outage.checks = checks;
            push_draft(&mut self.drafts, e.outage.draft(true));
        }
    }

    /// Lücke: offene Ereignisse am letzten `t` schließen, Fenster leeren.
    pub fn gap(&mut self, last_t: i64) {
        self.interrupt(last_t);
    }

    /// Stopp: offene Ereignisse schließen.
    pub fn close(&mut self, t: i64) {
        self.interrupt(t);
    }

    /// Neue bzw. geänderte Ereignisse herausnehmen.
    pub fn take_drafts(&mut self) -> Vec<EventDraft> {
        std::mem::take(&mut self.drafts)
    }

    /// Alles verwerfen.
    pub fn clear(&mut self) {
        let median = self.median.take();
        let next = self.next;
        *self = EventDetector { next, median, ..Default::default() };
    }
}

#[derive(Debug, Clone, Copy)]
enum WindowKind {
    Loss,
    Slow,
}

/// Ereignis aufnehmen; ein älterer Stand mit gleichem `key` wird ersetzt (`closed` bleibt).
fn push_draft(list: &mut Vec<EventDraft>, draft: EventDraft) {
    match list.iter_mut().find(|d| d.key == draft.key) {
        Some(slot) => {
            let closed = slot.closed || draft.closed;
            *slot = EventDraft { closed, ..draft };
        }
        None => list.push(draft),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::link::LinkKind;
    use std::collections::HashMap;

    const UP: OperStatus = OperStatus { up: true, media_connected: true };

    fn target() -> PingTarget {
        PingTarget { id: "aws-eu-central-1".into(), label: "Frankfurt".into(), host: "127.0.0.1".into(), port: None, method: PingMethod::Icmp }
    }

    fn link(net_id: &str, luid: u64) -> PrimaryLinkLite {
        PrimaryLinkLite { luid, if_index: 3, kind: LinkKind::Ethernet, gateway: None, net_id: net_id.into(), vpn: false, at: 0 }
    }

    /// Kleiner Treiber: Takte mit festem Intervall, Ereignisse nach `key` gesammelt (letzter Stand).
    struct Run {
        det: EventDetector,
        target: PingTarget,
        link: Option<PrimaryLinkLite>,
        status: Option<OperStatus>,
        interval: u64,
        slow_ms: f64,
        quiet: bool,
        events: HashMap<u64, EventDraft>,
        requests: Vec<ScopeRequest>,
    }

    impl Run {
        fn new(interval: u64) -> Self {
            Run {
                det: EventDetector::default(),
                target: target(),
                link: Some(link("net-a", 1)),
                status: Some(UP),
                interval,
                slow_ms: 100.0,
                quiet: false,
                events: HashMap::new(),
                requests: Vec::new(),
            }
        }

        fn tick(&mut self, t: i64, rtt: Option<f64>) {
            let tick = EventTick {
                t,
                rtt,
                interval_ms: self.interval,
                target: &self.target,
                method: PingMethod::Icmp,
                link: self.link.as_ref(),
                status: self.status,
                session_id: Some(7),
                quiet: self.quiet,
                slow_ms: self.slow_ms,
                gateway_base: Some(1.0),
            };
            if let Some(req) = self.det.push(&tick) {
                self.requests.push(req);
            }
            self.collect();
        }

        fn collect(&mut self) {
            for d in self.det.take_drafts() {
                let closed = self.events.get(&d.key).is_some_and(|o| o.closed) || d.closed;
                self.events.insert(d.key, EventDraft { closed, ..d });
            }
        }

        /// `n` Takte ab `from` mit dem Wert aus `f(i)`; liefert die Zeit nach dem letzten Takt.
        fn series(&mut self, from: i64, n: usize, f: impl Fn(usize) -> Option<f64>) -> i64 {
            let step = self.interval as i64;
            let mut t = from;
            for i in 0..n {
                self.tick(t, f(i));
                t += step;
            }
            t
        }

        fn of(&self, kind: EventKind) -> Vec<EventDraft> {
            let mut v: Vec<EventDraft> = self.events.values().filter(|d| d.event.kind == kind).cloned().collect();
            v.sort_by_key(|d| d.event.t);
            v
        }
    }

    #[test]
    fn outage_needs_3_losses_and_3s() {
        // 1-s-Takt: 2 Verluste sind nichts, 3 Verluste (3 s ohne Antwort) sind ein Aussetzer
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let t = r.series(t, 2, |_| None);
        let t = r.series(t, 5, |_| Some(20.0));
        assert!(r.of(EventKind::Outage).is_empty());
        assert!(r.requests.is_empty(), "keine Umfangsprüfung bei 2 Verlusten");
        let start = t;
        let t = r.series(t, 3, |_| None);
        assert_eq!(r.requests.len(), 1, "Umfangsprüfung beim dritten Verlust");
        assert_eq!(r.requests[0].outage_t, start);
        let o = r.of(EventKind::Outage);
        assert_eq!(o.len(), 1);
        assert!(!o[0].closed);
        r.det.on_scope(start, OutageScope::Internet);
        r.collect();
        r.tick(t, Some(20.0));
        let o = r.of(EventKind::Outage);
        assert_eq!(o[0].event.t, start, "Beginn = erster Verlust");
        assert_eq!(o[0].event.end_t, Some(t), "Ende = erste Antwort danach");
        assert_eq!(o[0].event.value, Some(3.0));
        assert_eq!(o[0].event.scope, Some(OutageScope::Internet));
        assert!(o[0].closed);
        assert_eq!(o[0].event.target_key.as_deref(), Some("aws-eu-central-1"));
        assert_eq!(o[0].event.connection, Some(ConnectionKind::Ethernet));
        assert_eq!(o[0].event.net_id, "net-a");
        assert_eq!(o[0].event.session_id, Some(7));

        // 250-ms-Takt: 3 Verluste reichen nicht, erst 3 s ohne Antwort (12 Verluste)
        let mut r = Run::new(250);
        let t = r.series(0, 40, |_| Some(20.0));
        let t2 = r.series(t, 11, |_| None);
        assert_eq!(r.requests.len(), 1, "Prüfung schon beim dritten Verlust angefordert");
        assert!(r.of(EventKind::Outage).is_empty(), "11 × 250 ms = 2,75 s");
        r.tick(t2, None);
        assert_eq!(r.of(EventKind::Outage).len(), 1, "12 × 250 ms = 3 s");
        // Eine kurze Folge im 250-ms-Takt (5 Verluste) wird kein Aussetzer
        let mut r = Run::new(250);
        let t = r.series(0, 40, |_| Some(20.0));
        let t = r.series(t, 5, |_| None);
        r.series(t, 10, |_| Some(20.0));
        assert!(r.of(EventKind::Outage).is_empty());
    }

    #[test]
    fn outage_suppressed_after_sleep_gap() {
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        // 2 Verluste vor dem Standby …
        let t = r.series(t, 2, |_| None);
        // … der Kern meldet die Lücke …
        r.det.gap(t - 1_000);
        r.collect();
        // … und nach dem Aufwachen noch 2 Verluste: zusammen nie ein Aussetzer
        let t = r.series(t + 3_600_000, 2, |_| None);
        r.series(t, 5, |_| Some(20.0));
        assert!(r.of(EventKind::Outage).is_empty());
        assert!(r.requests.is_empty());

        // Ein laufender Aussetzer endet an der Lücke beim letzten Verlust
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let t = r.series(t, 5, |_| None);
        r.det.gap(t - 1_000);
        r.collect();
        let o = r.of(EventKind::Outage);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].event.end_t, Some(t - 1_000), "Ende = letzter Verlust");
        assert_eq!(o[0].event.value, Some(4.0));
    }

    #[test]
    fn link_down_outage_is_pc() {
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let start = t;
        let t = r.series(t, 2, |_| None);
        // Kabel gezogen: der Zähler meldet die Trennung im Takt
        r.status = Some(OperStatus { up: false, media_connected: false });
        let t = r.series(t, 3, |_| None);
        // Prüfung meldet „internet“ – die Trennung schlägt das Ergebnis
        r.det.on_scope(start, OutageScope::Internet);
        r.status = Some(UP);
        r.tick(t, Some(20.0));
        let o = r.of(EventKind::Outage);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].event.scope, Some(OutageScope::Pc));
        assert!(o[0].closed, "pc steht fest – kein Warten auf die Prüfung");

        // Netzwechsel während des Aussetzers (WLAN gewechselt) → pc
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let t = r.series(t, 2, |_| None);
        r.link = Some(link("net-b", 1));
        let t = r.series(t, 2, |_| None);
        r.tick(t, Some(20.0));
        let o = r.of(EventKind::Outage);
        assert_eq!(o[0].event.scope, Some(OutageScope::Pc));
        // Getrennte Takte zählen nicht als Verlust-Fenster
        assert!(r.of(EventKind::Loss).is_empty());
    }

    #[test]
    fn scope_result_after_end_and_timeout() {
        // Ergebnis kommt nach der ersten Antwort → wird noch übernommen
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let start = t;
        let t = r.series(t, 3, |_| None);
        r.tick(t, Some(20.0));
        let o = r.of(EventKind::Outage);
        assert!(!o[0].closed, "wartet auf die Umfangsprüfung");
        assert_eq!(o[0].event.scope, Some(OutageScope::Unknown));
        scope::store_checks(start, ScopeChecks { link: Some(true), gw: Some(true), ext: Some(true) });
        r.det.on_scope(start, OutageScope::TargetOnly);
        r.collect();
        let o = r.of(EventKind::Outage);
        assert!(o[0].closed);
        assert_eq!(o[0].event.scope, Some(OutageScope::TargetOnly));
        assert_eq!(o[0].event.detail, Some(json!({ "checks": { "link": true, "gw": true, "ext": true } })));

        // Kein Ergebnis → nach der Frist als „unklar“ abgeschlossen
        let mut r = Run::new(1_000);
        let t = r.series(10_000_000, 10, |_| Some(20.0));
        let t = r.series(t, 4, |_| None);
        let t = r.series(t, 5, |_| Some(20.0));
        assert!(!r.of(EventKind::Outage)[0].closed);
        r.tick(t + 1_000, Some(20.0));
        let o = r.of(EventKind::Outage);
        assert!(o[0].closed);
        assert_eq!(o[0].event.scope, Some(OutageScope::Unknown));
        assert_eq!(o[0].event.detail, Some(json!({ "checks": { "link": null, "gw": null, "ext": null } })));
        // Ein verspätetes Ergebnis ändert nichts mehr
        r.det.on_scope(10_010_000, OutageScope::Internet);
        r.collect();
        assert_eq!(r.of(EventKind::Outage)[0].event.scope, Some(OutageScope::Unknown));
    }

    /// Takte über `minutes` volle Minuten; `lost(minute, i)` entscheidet je Takt.
    fn minutes(r: &mut Run, from: i64, minutes: usize, lost: impl Fn(usize, usize) -> bool) -> i64 {
        let per_min = (60_000 / r.interval) as usize;
        let mut t = from;
        for m in 0..minutes {
            for i in 0..per_min {
                r.tick(t, if lost(m, i) { None } else { Some(20.0) });
                t += r.interval as i64;
            }
        }
        t
    }

    #[test]
    fn loss_needs_2_lost_and_20_samples() {
        // 1-s-Takt: 60 Messungen je Minute; 3 Verluste (5 %) reichen nicht, 4 (6,7 %) schon
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 1, |_, i| i % 20 == 5);
        r.tick(t, Some(20.0));
        assert!(r.of(EventKind::Loss).is_empty(), "genau 5 % ist nicht > 5 %");
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 1, |_, i| i % 15 == 5);
        r.tick(t, Some(20.0));
        let l = r.of(EventKind::Loss);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].event.value, Some(6.7));
        assert_eq!(l[0].event.detail, Some(json!({ "lost": 4, "n": 60 })));
        assert_eq!(l[0].event.t, 0, "Beginn des Fensters");
        assert_eq!(l[0].event.end_t, Some(60_000), "Ende der Minute");

        // 10-s-Takt: 6 Messungen je Minute → Fenster über die letzten 20 Messungen; vorher nichts
        let mut r = Run::new(10_000);
        let t = minutes(&mut r, 0, 2, |m, i| m == 1 && (i == 1 || i == 4));
        r.tick(t, Some(20.0));
        assert!(r.of(EventKind::Loss).is_empty(), "erst 12 Messungen");
        let mut r = Run::new(10_000);
        let t = minutes(&mut r, 0, 4, |m, i| m == 3 && (i == 1 || i == 4));
        r.tick(t, Some(20.0));
        let l = r.of(EventKind::Loss);
        assert_eq!(l.len(), 1, "20 Messungen, 2 verloren = 10 %");
        assert_eq!(l[0].event.detail, Some(json!({ "lost": 2, "n": 20 })));
        assert_eq!(l[0].event.t, 40_000, "Fenster reicht 20 Messungen zurück");
        // Ein einzelner Verlust ist nie ein Verlust-Fenster
        let mut r = Run::new(10_000);
        let t = minutes(&mut r, 0, 4, |m, i| m == 3 && i == 1);
        r.tick(t, Some(20.0));
        assert!(r.of(EventKind::Loss).is_empty());

        // 250-ms-Takt: 240 Messungen je Minute; 12 Verluste (5 %) nein, 13 ja
        let mut r = Run::new(250);
        let t = minutes(&mut r, 0, 1, |_, i| i % 20 == 3);
        r.tick(t, Some(20.0));
        assert!(r.of(EventKind::Loss).is_empty());
        let mut r = Run::new(250);
        let t = minutes(&mut r, 0, 1, |_, i| i % 20 == 3 || i == 101);
        r.tick(t, Some(20.0));
        assert_eq!(r.of(EventKind::Loss).len(), 1);
    }

    #[test]
    fn loss_excludes_outage() {
        // Ein Aussetzer von 10 Verlusten ist kein Verlust-Fenster
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 2, |m, i| m == 0 && (20..30).contains(&i));
        r.tick(t, Some(20.0));
        assert_eq!(r.of(EventKind::Outage).len(), 1);
        assert!(r.of(EventKind::Loss).is_empty(), "Aussetzer-Messungen zählen nicht");
        // Verlust-Folge über die Minutengrenze, die ein Aussetzer wird: ebenfalls kein Fenster
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 2, |m, i| (m == 0 && i >= 58) || (m == 1 && i < 4));
        r.tick(t, Some(20.0));
        assert_eq!(r.of(EventKind::Outage).len(), 1);
        assert!(r.of(EventKind::Loss).is_empty());
        // Zwei Einzelverluste kurz vor der Minutengrenze zählen trotzdem (Bewertung aufgeschoben)
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 1, |_, i| i == 10 || i == 30 || i == 58 || i == 59);
        r.tick(t, Some(20.0));
        let l = r.of(EventKind::Loss);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].event.detail, Some(json!({ "lost": 4, "n": 60 })));
    }

    #[test]
    fn slow_threshold_relative_to_target() {
        let slow = |r: &mut Run, from: i64, rtt: f64| {
            let mut t = from;
            for _ in 0..60 {
                r.tick(t, Some(rtt));
                t += 1_000;
            }
            r.tick(t, Some(rtt));
            t
        };
        // Ohne Median: Schwelle = slowMs (100)
        let mut r = Run::new(1_000);
        slow(&mut r, 0, 120.0);
        let s = r.of(EventKind::Slow);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].event.value, Some(120.0));
        assert_eq!(s[0].event.detail, Some(json!({ "threshold": 100.0, "minutes": 1 })));
        assert_eq!((s[0].event.t, s[0].event.end_t), (0, Some(60_000)));
        // Ferner Server mit Median 90 ms → Schwelle 140 ms: 120 ms ist normal
        let mut r = Run::new(1_000);
        r.det.set_target_median("aws-eu-central-1", "net-a", Some(90.0));
        slow(&mut r, 0, 120.0);
        assert!(r.of(EventKind::Slow).is_empty(), "Entfernung zum Server ist kein Anbieterfehler");
        let mut r = Run::new(1_000);
        r.det.set_target_median("aws-eu-central-1", "net-a", Some(90.0));
        slow(&mut r, 0, 150.0);
        assert_eq!(r.of(EventKind::Slow)[0].event.detail, Some(json!({ "threshold": 140.0, "minutes": 1 })));
        // Median eines anderen Netzes oder zu wenig Messstunden → nur slowMs
        let mut r = Run::new(1_000);
        r.det.set_target_median("aws-eu-central-1", "net-b", Some(90.0));
        slow(&mut r, 0, 120.0);
        assert_eq!(r.of(EventKind::Slow).len(), 1);
        let mut r = Run::new(1_000);
        r.det.set_target_median("aws-eu-central-1", "net-a", None);
        slow(&mut r, 0, 120.0);
        assert_eq!(r.of(EventKind::Slow).len(), 1);
        // Niedriger Median: slowMs bleibt die Untergrenze
        let mut r = Run::new(1_000);
        r.det.set_target_median("aws-eu-central-1", "net-a", Some(10.0));
        slow(&mut r, 0, 90.0);
        assert!(r.of(EventKind::Slow).is_empty());
        // Weniger als 5 Antworten in der Minute → keine Bewertung
        let mut r = Run::new(15_000);
        let t = r.series(0, 4, |_| Some(500.0));
        r.tick(t, Some(500.0));
        assert!(r.of(EventKind::Slow).is_empty());
    }

    #[test]
    fn consecutive_minutes_extend_event() {
        // Drei langsame Minuten am Stück → ein Ereignis; Pause; dann ein neues
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 3, |_, _| false);
        // (alle 20 ms – erst danach langsam)
        assert!(r.of(EventKind::Slow).is_empty());
        let mut t2 = t;
        for m in 0..3 {
            for _ in 0..60 {
                r.tick(t2, Some(150.0 + m as f64 * 10.0));
                t2 += 1_000;
            }
        }
        let t3 = minutes(&mut r, t2, 2, |_, _| false);
        let mut t4 = t3;
        for _ in 0..60 {
            r.tick(t4, Some(130.0));
            t4 += 1_000;
        }
        r.tick(t4, Some(20.0));
        let s = r.of(EventKind::Slow);
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!((s[0].event.t, s[0].event.end_t), (t, Some(t + 180_000)));
        assert_eq!(s[0].event.value, Some(170.0), "höchster Minuten-Durchschnitt");
        assert_eq!(s[0].event.detail, Some(json!({ "threshold": 100.0, "minutes": 3 })));
        assert!(s[0].closed);
        assert_eq!(s[1].event.t, t3);
        assert!(!s[1].closed, "bis zur nächsten Minutengrenze offen");

        // Verlust: zwei Minuten am Stück → ein Ereignis bis zum Ende der zweiten Minute
        let mut r = Run::new(1_000);
        let t = minutes(&mut r, 0, 3, |m, i| m < 2 && i % 10 == 3);
        r.tick(t, Some(20.0));
        let l = r.of(EventKind::Loss);
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].event.t, l[0].event.end_t), (0, Some(120_000)));
        assert!(l[0].closed, "dritte Minute ohne Treffer schließt");
    }

    #[test]
    fn quiet_and_stop_close_events() {
        let mut r = Run::new(1_000);
        let t = r.series(0, 10, |_| Some(20.0));
        let t = r.series(t, 5, |_| None);
        // Pulsars Speedtest beginnt: Aussetzer endet am letzten Verlust, danach nichts
        r.quiet = true;
        let t = r.series(t, 30, |_| None);
        r.quiet = false;
        let t = r.series(t, 5, |_| Some(20.0));
        let o = r.of(EventKind::Outage);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].event.end_t, Some(14_000));
        assert!(r.requests.len() == 1, "in der Ruhezeit keine weitere Prüfung");
        // Stopp schließt ein offenes langsames Ereignis
        let mut t2 = t;
        for _ in 0..61 {
            r.tick(t2, Some(300.0));
            t2 += 1_000;
        }
        r.det.close(t2 - 1_000);
        r.collect();
        assert!(r.of(EventKind::Slow).iter().all(|d| d.closed));
        // clear() verwirft alles
        r.det.clear();
        assert!(r.det.take_drafts().is_empty());
    }

    #[test]
    fn recorder_writes_outage_loss_slow() {
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
        let ctx = IngestCtx { link: Some(PrimaryLinkLite { vpn: true, ..link("net-a", 1) }), ..Default::default() };
        let mut scope_req = None;
        let mut tick = |time: i64, rtt: Option<f64>| {
            let samples = [PingSample { target_id: t.id.clone(), t: time, rtt }];
            let load = LoadSample { at: time, status: Some(UP), ..Default::default() };
            let a = rec.lock().unwrap().ingest(time, 1000, std::slice::from_ref(&t), &[None], &samples, &load, ctx.clone());
            if let Some(req) = a.scope_check {
                // Wie der Hook: das Ergebnis kommt nach höchstens 2 s zurück
                rec.lock().unwrap().on_scope(req.outage_t, OutageScope::Internet);
                scope_req = Some(req);
            }
        };
        let base = 1_000_000_020_000;
        let mut now = base;
        for i in 0..240 {
            let rtt = match i {
                30..=34 => None,                    // Aussetzer (5 s)
                70 | 80 | 90 | 100 => None,         // Verlust-Fenster in Minute 2
                180..=239 => Some(250.0),           // langsame Minute 4
                _ => Some(20.0),
            };
            tick(now, rtt);
            now += 1_000;
        }
        tick(now, Some(20.0));
        let req = scope_req.expect("Umfangsprüfung angefordert");
        assert_eq!(req.outage_t, base + 30_000);
        rec.lock().unwrap().on_stop(now);
        flush_with(&rec, &gate, &db).unwrap();
        type Row = (String, i64, Option<i64>, Option<f64>, Option<String>, Option<String>, Option<String>);
        let rows: Vec<Row> = db
            .with(|d| {
                let mut st = d
                    .conn()
                    .prepare("SELECT kind, t, end_t, value, scope, connection, detail FROM net_events WHERE kind <> 'spike' ORDER BY t")
                    .map_err(crate::error::db_err)?;
                let it = st
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
                    .map_err(crate::error::db_err)?;
                Ok(it.filter_map(Result::ok).collect())
            })
            .unwrap();
        let kinds: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(kinds, vec!["outage", "loss", "slow"], "{rows:?}");
        let outage = &rows[0];
        assert_eq!((outage.1, outage.2, outage.3), (base + 30_000, Some(base + 35_000), Some(5.0)));
        assert_eq!(outage.4.as_deref(), Some("internet"));
        assert_eq!(outage.5.as_deref(), Some("vpn"), "mit VPN markiert");
        assert_eq!(rows[1].6.as_deref(), Some(r#"{"lost":4,"n":60}"#));
        assert_eq!(rows[2].3, Some(250.0));
        assert!(rows.iter().all(|r| r.4.is_none() || r.0 == "outage"));
    }
}
