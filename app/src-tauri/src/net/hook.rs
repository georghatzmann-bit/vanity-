//! Der Monitor-Hook: führt die Aufträge aus, die `Recorder::ingest` zurückgibt (Schreiben,
//! Hauptverbindung erneuern, Momentaufnahme, Umfangsprüfung, zweites `net://lag`). Alles per
//! `spawn`/`spawn_blocking` – der Monitor-Takt wartet nie darauf. Vertrag: `docs/API.md`,
//! „Aufzeichnung“ und „Sperr-Reihenfolge und Laufzeit“.
//!
//! Jede Sperre wird hier nur kurz und einzeln gehalten (`recorder`, `link`, `load`,
//! `current_session`), nie zusammen mit `db` oder `tracker`.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::hist_types::{OutageScope, TargetKind};
use super::lag::{self, LagCause, LagCheck, LagEvent, LagSnapshot, Reason, SnapshotPlan};
use super::recorder::{IngestActions, SnapshotRequest};
use super::scope::{self, ScopeRequest};
use super::{link, EVENT_LAG};
use crate::error::LockExt;
use crate::state::Shared;

/// Setzt ein Belegt-Flag beim Verlassen zurück (auch bei Panik im Hintergrund-Task).
struct FlagGuard<'a>(&'a AtomicBool);

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Flag belegen; `false`, wenn es schon belegt ist.
fn try_take(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}

/// Aufträge eines Takts ausführen (kehrt sofort zurück).
pub fn run_actions(app: &AppHandle, core: Shared, actions: IngestActions) {
    if actions.flush_due {
        schedule_flush(&core);
    }
    if actions.refresh_link {
        refresh_link(&core, actions.link_target);
    }
    if let Some(req) = actions.snapshot {
        start_snapshot(app, &core, req);
    }
    if let Some(req) = actions.scope_check {
        start_scope_check(&core, req);
    }
    if let Some(ev) = actions.lag_update {
        // Zweite Meldung am Ende des 10-s-Fensters (endgültiges `count`)
        core.net.lag.remember(ev.clone());
        let _ = app.emit(EVENT_LAG, &ev);
    }
}

/// Schreiben im Hintergrund planen (`spawn_blocking`, höchstens einer gleichzeitig; ein laufender
/// Flush nimmt die neuen Daten beim nächsten Mal mit). Wartet nie.
pub fn schedule_flush(core: &Shared) {
    if !try_take(&core.net.flush.in_flight) {
        return;
    }
    let core = core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = FlagGuard(&core.net.flush.in_flight);
        core.net.flush_now(&core);
    });
}

/// Hauptverbindung neu ermitteln (`spawn_blocking`, nie zwei gleichzeitig) und die LUID an den
/// Lastmesser weitergeben.
fn refresh_link(core: &Shared, target: Option<Ipv4Addr>) {
    if !try_take(&core.net.link_refreshing) {
        return;
    }
    let core = core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = FlagGuard(&core.net.link_refreshing);
        let fresh = link::refresh(target, crate::util::now_ms());
        let luid = fresh.as_ref().map(|l| l.luid);
        *core.net.link.lock_safe() = fresh;
        core.net.load.lock_safe().set_luid(luid);
    });
}

/// `LagEvent` aus Auftrag und Ergebnis bauen (erste Meldung, `count = 1`).
fn lag_event(req: &SnapshotRequest, check: LagCheck, session_id: Option<i64>) -> LagEvent {
    LagEvent {
        check,
        target_id: req.target.id.clone(),
        target_label: req.target.label.clone(),
        target_kind: TargetKind::from_target_id(&req.target.id),
        rtt: req.rtt,
        baseline: req.baseline,
        limit: req.limit,
        count: 1,
        session_id,
    }
}

/// Momentaufnahme ohne Messung (Momentaufnahmen in den Einstellungen aus): `unknown`/`snapshotsOff`.
fn check_off(at: i64) -> LagCheck {
    LagCheck { at, cause: LagCause::Unknown, cpu_high: false, reasons: vec![Reason::SnapshotsOff], snapshot: LagSnapshot::off(at) }
}

/// Ergebnis melden: Recorder (Ursache für den `spike`-Eintrag), Speicher für `net_lag_recent`, Event.
fn deliver(app: &AppHandle, core: &Shared, ev: LagEvent) {
    core.net.recorder.lock_safe().on_snapshot(&ev);
    core.net.lag.remember(ev.clone());
    let _ = app.emit(EVENT_LAG, &ev);
}

/// Momentaufnahme bzw. Ruhe-Messung starten (`spawn`, ganze Aufnahme höchstens 1,5 s; nie zwei
/// gleichzeitig – weitere Ausreißer zählt der Detektor nur mit).
fn start_snapshot(app: &AppHandle, core: &Shared, req: SnapshotRequest) {
    let snapshots = core.net.recorder.lock_safe().settings().snapshots;
    let session_id = core.net.current_session.lock_safe().map(|(id, _)| id);
    if !snapshots {
        // Ruhe-Messungen entfallen; ein Ausreißer wird ohne zusätzliche Pakete gemeldet
        if !req.idle {
            deliver(app, core, lag_event(&req, check_off(req.at), session_id));
        }
        return;
    }
    if !try_take(&core.net.lag.running) {
        // Läuft eine Ausreißer-Messung, gehört dieser Ausreißer dazu (der Detektor zählt ihn mit).
        // Läuft nur eine Ruhe-Messung, käme sonst nie ein `net://lag`: sofort „unklar“ melden.
        if let Some(check) = busy_check(&req, core.net.lag.idle_running.load(Ordering::SeqCst)) {
            deliver(app, core, lag_event(&req, check, session_id));
        }
        return;
    }
    // Vor dem Start setzen (nur der Halter von `running` setzt es zurück)
    core.net.lag.idle_running.store(req.idle, Ordering::SeqCst);
    let app = app.clone();
    let core = core.clone();
    tauri::async_runtime::spawn(async move {
        let _busy = FlagGuard(&core.net.lag.running);
        let _idle = FlagGuard(&core.net.lag.idle_running);
        let plan = SnapshotPlan {
            dst: Some(req.dst),
            target: Some(req.target.clone()),
            limit: (!req.idle).then_some(req.limit),
            measure_target: !req.idle,
        };
        let limit = Duration::from_millis(lag::SNAPSHOT_TIMEOUT_MS);
        let result = tokio::time::timeout(limit, lag::run_snapshot(core.clone(), plan, req.at)).await;
        if req.idle {
            // Ruhe-Messung: nur Grundwerte, kein `net://lag`; verspätet → verworfen
            if let Ok(check) = result {
                core.net.recorder.lock_safe().on_idle_snapshot(&check);
            }
            return;
        }
        let check = result.unwrap_or_else(|_| {
            // Zeitlimit: Teilergebnisse verwerfen, Ausreißer trotzdem melden („unklar“)
            let mut snapshot = LagSnapshot::off(req.at);
            snapshot.took_ms = lag::SNAPSHOT_TIMEOUT_MS;
            LagCheck { at: req.at, cause: LagCause::Unknown, cpu_high: false, reasons: Vec::new(), snapshot }
        });
        deliver(&app, &core, lag_event(&req, check, session_id));
    });
}

/// Momentaufnahme belegt: Was ist mit einem neuen Auftrag? Ein echter Ausreißer während einer
/// Ruhe-Messung wird sofort ohne Messung gemeldet (`unknown`, ohne Gründe); sonst nichts (Ruhe-
/// Messung entfällt, Ausreißer zählt zur laufenden Ausreißer-Messung).
fn busy_check(req: &SnapshotRequest, idle_running: bool) -> Option<LagCheck> {
    (!req.idle && idle_running).then(|| LagCheck {
        at: req.at,
        cause: LagCause::Unknown,
        cpu_high: false,
        reasons: Vec::new(),
        snapshot: LagSnapshot::off(req.at),
    })
}

/// Umfangsprüfung eines Aussetzers starten (`spawn`, Ergebnis an den Recorder; Zeitlimit →
/// `unknown`).
fn start_scope_check(core: &Shared, req: ScopeRequest) {
    let core = core.clone();
    tauri::async_runtime::spawn(async move {
        let outage_t = req.outage_t;
        // Etwas Luft über dem Zeitlimit der Prüfung selbst
        let limit = Duration::from_millis(scope::SCOPE_TIMEOUT_MS + 500);
        let result = tokio::time::timeout(limit, scope::check(core.clone(), req)).await.unwrap_or(OutageScope::Unknown);
        core.net.recorder.lock_safe().on_scope(outage_t, result);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::types::{PingMethod, PingTarget};

    #[test]
    fn flag_guard_releases() {
        let flag = AtomicBool::new(false);
        assert!(try_take(&flag));
        assert!(!try_take(&flag), "nie zwei gleichzeitig");
        {
            let _g = FlagGuard(&flag);
        }
        assert!(try_take(&flag));
    }

    #[test]
    fn lag_event_and_off_shape() {
        let req = SnapshotRequest {
            dst: Ipv4Addr::new(1, 2, 3, 4),
            target: PingTarget { id: "valve-cs2-fra".into(), label: "CS2 Frankfurt".into(), host: "x".into(), port: None, method: PingMethod::Icmp },
            rtt: 182.0,
            baseline: 20.0,
            limit: 60.0,
            at: 5_000,
            idle: false,
        };
        let ev = lag_event(&req, check_off(5_000), Some(7));
        assert_eq!(ev.target_kind, TargetKind::Server);
        assert_eq!((ev.rtt, ev.baseline, ev.limit, ev.count, ev.session_id), (182.0, 20.0, 60.0, 1, Some(7)));
        assert_eq!(ev.check.cause, LagCause::Unknown);
        assert_eq!(ev.check.reasons, vec![Reason::SnapshotsOff]);
        let snap = &ev.check.snapshot;
        assert!(snap.hops.is_empty() && !snap.via_vpn && snap.took_ms == 0 && snap.target_ms.is_none());
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["targetId"], "valve-cs2-fra");
        assert_eq!(v["cause"], "unknown");
    }

    #[test]
    fn spike_during_idle_measurement_is_reported_as_unknown() {
        let mut req = SnapshotRequest {
            dst: Ipv4Addr::new(1, 2, 3, 4),
            target: PingTarget { id: "valve-cs2-fra".into(), label: "CS2 Frankfurt".into(), host: "x".into(), port: None, method: PingMethod::Icmp },
            rtt: 182.0,
            baseline: 20.0,
            limit: 60.0,
            at: 9_000,
            idle: false,
        };
        let state = lag::LagState::default();
        assert!(try_take(&state.running), "Ruhe-Messung läuft");
        state.idle_running.store(true, Ordering::SeqCst);
        let check = busy_check(&req, state.idle_running.load(Ordering::SeqCst)).expect("Ausreißer wird gemeldet");
        assert_eq!((check.at, check.cause, check.cpu_high), (9_000, LagCause::Unknown, false));
        assert!(check.reasons.is_empty() && check.snapshot.hops.is_empty() && check.snapshot.took_ms == 0);
        // Laufende Ausreißer-Messung: zusammenfassen, keine zweite Meldung
        assert!(busy_check(&req, false).is_none());
        // Eine weitere Ruhe-Messung entfällt still
        req.idle = true;
        assert!(busy_check(&req, true).is_none());
    }
}
