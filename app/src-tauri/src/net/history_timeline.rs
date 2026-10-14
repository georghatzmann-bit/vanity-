//! `net_session_timeline`: Messwerte und Ereignisse einer Spielsitzung lesen (Match-Zeitleiste).
//! Vertrag: `docs/API.md`, „Match-Zeitleiste“.
//!
//! Reine Datenbank (kein Netz): Blöcke aus `session_samples` nach `chunk_start`, Punkte gekappt auf
//! `[sessions.start, sessions.end]`, kaputte Blöcke werden übersprungen. Mehr als 43 200 Punkte
//! werden zusammengefasst. Ereignisse: alle mit dieser `session_id` (ohne `speedtest`) und
//! `quiet`-Zeiträume, die die Sitzung berühren.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::hist_types::{
    parse_method, ConnectionKind, EventKind, NetEvent, OutageScope, SessionTimeline, TargetChange, TimelinePoint, TimelineTarget, NO_SAMPLES,
};
use super::lag::LagCause;
use super::recorder::chunk::decode_chunk;
use crate::db::Db;
use crate::error::{db_err, CmdResult};

/// Mehr Punkte werden zusammengefasst (12 h bei 1 s).
pub const MAX_POINTS: usize = 43_200;

/// Ereignisarten der Zeitleiste (`speedtest` gehört nicht dazu).
const TIMELINE_KINDS: [EventKind; 5] = [EventKind::Spike, EventKind::Outage, EventKind::Loss, EventKind::Slow, EventKind::Quiet];

/// Zeitleiste einer Sitzung aus `session_samples` und `net_events` (reine Datenbank).
pub fn session_timeline(db: &Db, session_id: i64) -> CmdResult<SessionTimeline> {
    read_timeline(db.conn(), session_id).map_err(db_err)?.ok_or_else(|| NO_SAMPLES.to_string())
}

/// `None` = keine Messwerte (unbekannte Sitzung, aufgeräumt, nie gemessen, alle Blöcke kaputt).
fn read_timeline(conn: &Connection, session_id: i64) -> rusqlite::Result<Option<SessionTimeline>> {
    let session = conn
        .query_row("SELECT game_id, start, end FROM sessions WHERE id = ?1", params![session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })
        .optional()?;
    let Some((game_id, start, end)) = session else { return Ok(None) };

    let mut stmt = conn.prepare(
        "SELECT chunk_start, target_key, target_label, method, data FROM session_samples
         WHERE session_id = ?1 ORDER BY chunk_start ASC",
    )?;
    let rows = stmt.query_map(params![session_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Vec<u8>>(4)?))
    })?;

    let mut targets: Vec<TimelineTarget> = Vec::new();
    let mut target_changes: Vec<TargetChange> = Vec::new();
    let mut points: Vec<TimelinePoint> = Vec::new();
    let mut current: Option<String> = None;
    for row in rows {
        let (chunk_start, key, label, method, data) = row?;
        // Unbekannte Messart oder kaputter Block → überspringen (nie ein Absturz)
        let Some(method) = parse_method(&method) else { continue };
        let Some(decoded) = decode_chunk(chunk_start, &data) else { continue };
        let kept: Vec<TimelinePoint> = decoded
            .into_iter()
            .filter(|p| p.t >= start && p.t <= end)
            .map(|p| (p.t, p.rtt, p.cpu.map(f64::from), p.rx_mbps, p.tx_mbps))
            .collect();
        let Some(first) = kept.first() else { continue };
        if !targets.iter().any(|t| t.key == key) {
            targets.push(TimelineTarget { key: key.clone(), label, method });
        }
        if current.as_ref().is_some_and(|c| *c != key) {
            target_changes.push(TargetChange { t: first.0, key: key.clone() });
        }
        current = Some(key);
        points.extend(kept);
    }
    if points.is_empty() {
        return Ok(None);
    }
    // Nach Zeit (stabil): nach einer zurückgestellten Uhr können sich Blöcke überlappen
    points.sort_by_key(|p| p.0);
    let (merged, points) = merge_points(points);
    let events = read_events(conn, session_id, start, end)?;
    Ok(Some(SessionTimeline { session_id, game_id, start, end, targets, target_changes, merged, points, events }))
}

/// Mehr als 43 200 Punkte → je `merged` aufeinanderfolgende Punkte zusammenfassen: Zeit = erster
/// Punkt, Ping = Mittel der Antworten oder `None`, wenn mehr als die Hälfte verloren ging (wie
/// `compressTimeline`), CPU/rx/tx = Mittel der bekannten Werte.
pub fn merge_points(points: Vec<TimelinePoint>) -> (u32, Vec<TimelinePoint>) {
    if points.len() <= MAX_POINTS {
        return (1, points);
    }
    let merged = points.len().div_ceil(MAX_POINTS);
    let mean = |vals: &mut dyn Iterator<Item = f64>| {
        let (sum, n) = vals.fold((0.0, 0u32), |(s, n), v| (s + v, n + 1));
        (n > 0).then(|| sum / f64::from(n))
    };
    let out = points
        .chunks(merged)
        .filter_map(|group| {
            let first = group.first()?;
            let answers: Vec<f64> = group.iter().filter_map(|p| p.1).collect();
            let lost = group.len() - answers.len();
            let rtt = if lost * 2 > group.len() { None } else { mean(&mut answers.iter().copied()) };
            Some((
                first.0,
                rtt,
                mean(&mut group.iter().filter_map(|p| p.2)),
                mean(&mut group.iter().filter_map(|p| p.3)),
                mean(&mut group.iter().filter_map(|p| p.4)),
            ))
        })
        .collect();
    (u32::try_from(merged).unwrap_or(u32::MAX), out)
}

/// Ereignisse der Sitzung (ohne `speedtest`) und `quiet`-Zeiträume, die `[start, end]` berühren,
/// nach `t` sortiert.
fn read_events(conn: &Connection, session_id: i64, start: i64, end: i64) -> rusqlite::Result<Vec<NetEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, t, end_t, kind, target_key, target_label, method, net_id, connection, value, cause, scope, session_id, detail
         FROM net_events
         WHERE (session_id = ?1 AND kind IN ('spike', 'outage', 'loss', 'slow', 'quiet'))
            OR (kind = 'quiet' AND t <= ?3 AND COALESCE(end_t, t) >= ?2)
         ORDER BY t ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![session_id, start, end], row_to_event)?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(e) = row? {
            if TIMELINE_KINDS.contains(&e.kind) {
                out.push(e);
            }
        }
    }
    Ok(out)
}

/// Zeile → `NetEvent`; unbekannte Art → `None`, unbekannte Texte in den übrigen Spalten → `None`
/// im jeweiligen Feld, kaputtes `detail` → `None` (nie ein Absturz).
fn row_to_event(r: &Row<'_>) -> rusqlite::Result<Option<NetEvent>> {
    let kind: String = r.get(3)?;
    let Some(kind) = EventKind::parse(&kind) else { return Ok(None) };
    let text = |i: usize| -> rusqlite::Result<Option<String>> { r.get::<_, Option<String>>(i) };
    let detail = text(13)?.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(Some(NetEvent {
        id: r.get(0)?,
        t: r.get(1)?,
        end_t: r.get(2)?,
        kind,
        target_key: text(4)?,
        target_label: text(5)?,
        method: text(6)?.as_deref().and_then(parse_method),
        net_id: text(7)?.unwrap_or_default(),
        connection: text(8)?.as_deref().and_then(ConnectionKind::parse),
        value: r.get::<_, Option<f64>>(9)?.filter(|v| v.is_finite()),
        cause: text(10)?.as_deref().and_then(LagCause::parse),
        scope: text(11)?.as_deref().and_then(OutageScope::parse),
        session_id: r.get(12)?,
        detail,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_event, insert_samples_chunk};
    use crate::net::recorder::chunk::{encode_chunk, ChunkPoint};
    use serde_json::json;

    const T0: i64 = 1_760_000_000_000;

    fn open() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("pulsar.db")).unwrap();
        (dir, db)
    }

    fn session(db: &Db, start: i64, end: i64) -> i64 {
        db.session_insert("game-1", start, end, (end - start) / 1000).unwrap().id
    }

    fn p(t: i64, rtt: Option<f64>) -> ChunkPoint {
        ChunkPoint { t, rtt, cpu: Some(40), rx_mbps: Some(2.5), tx_mbps: Some(0.3) }
    }

    /// Block mit `n` Punkten im Sekundentakt ab `start`.
    fn chunk(db: &Db, sid: i64, start: i64, n: i64, target: (&str, &str, &str), rtt: impl Fn(i64) -> Option<f64>) {
        let pts: Vec<ChunkPoint> = (0..n).map(|i| p(start + i * 1000, rtt(i))).collect();
        let data = encode_chunk(start, &pts);
        assert!(insert_samples_chunk(db.conn(), sid, start, target.0, target.1, target.2, n, &data).unwrap());
    }

    const AWS: (&str, &str, &str) = ("aws-eu-central-1", "Frankfurt (AWS)", "tcp");
    const CS2: (&str, &str, &str) = ("valve-cs2-fra", "CS2 Frankfurt (Valve)", "icmp");

    #[test]
    fn points_in_order_across_chunks() {
        let (_d, db) = open();
        let sid = session(&db, T0, T0 + 600_000);
        // absichtlich in umgekehrter Reihenfolge eingefügt
        chunk(&db, sid, T0 + 61_000, 30, AWS, |i| Some(30.0 + i as f64));
        chunk(&db, sid, T0, 61, AWS, |i| if i == 5 { None } else { Some(20.0) });
        let tl = session_timeline(&db, sid).unwrap();
        assert_eq!(tl.session_id, sid);
        assert_eq!(tl.game_id, "game-1");
        assert_eq!((tl.start, tl.end), (T0, T0 + 600_000));
        assert_eq!(tl.merged, 1);
        assert_eq!(tl.points.len(), 91);
        assert!(tl.points.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(tl.points[0], (T0, Some(20.0), Some(40.0), Some(2.5), Some(0.3)));
        assert_eq!(tl.points[5].1, None);
        assert_eq!(tl.points[61], (T0 + 61_000, Some(30.0), Some(40.0), Some(2.5), Some(0.3)));
        assert!(tl.target_changes.is_empty());
        // camelCase wie in der Oberfläche
        let v = serde_json::to_value(&tl).unwrap();
        assert!(v.get("targetChanges").is_some() && v.get("sessionId").is_some() && v.get("gameId").is_some());
        assert_eq!(v["points"][5], json!([T0 + 5000, null, 40.0, 2.5, 0.3]));
    }

    #[test]
    fn targets_with_label_and_method() {
        let (_d, db) = open();
        let sid = session(&db, T0, T0 + 600_000);
        chunk(&db, sid, T0, 40, AWS, |_| Some(25.0));
        chunk(&db, sid, T0 + 40_000, 60, CS2, |_| Some(12.0));
        chunk(&db, sid, T0 + 100_000, 10, CS2, |_| Some(12.0));
        chunk(&db, sid, T0 + 110_000, 10, AWS, |_| Some(25.0));
        let tl = session_timeline(&db, sid).unwrap();
        assert_eq!(
            tl.targets,
            vec![
                TimelineTarget { key: AWS.0.into(), label: AWS.1.into(), method: crate::net::types::PingMethod::Tcp },
                TimelineTarget { key: CS2.0.into(), label: CS2.1.into(), method: crate::net::types::PingMethod::Icmp },
            ]
        );
        assert_eq!(
            tl.target_changes,
            vec![TargetChange { t: T0 + 40_000, key: CS2.0.into() }, TargetChange { t: T0 + 110_000, key: AWS.0.into() }]
        );
    }

    #[test]
    fn points_clamped_to_session() {
        let (_d, db) = open();
        let sid = session(&db, T0 + 10_000, T0 + 50_000);
        // Block beginnt vor der Sitzung und reicht über ihr Ende hinaus
        chunk(&db, sid, T0, 61, AWS, |_| Some(20.0));
        // Block ganz außerhalb → zählt nicht (auch nicht als Ziel)
        chunk(&db, sid, T0 + 70_000, 5, CS2, |_| Some(10.0));
        let tl = session_timeline(&db, sid).unwrap();
        assert_eq!(tl.points.len(), 41);
        assert_eq!(tl.points.first().map(|p| p.0), Some(T0 + 10_000));
        assert_eq!(tl.points.last().map(|p| p.0), Some(T0 + 50_000));
        assert_eq!(tl.targets.len(), 1);
        assert!(tl.target_changes.is_empty());
    }

    #[test]
    fn unknown_session_errors() {
        let (_d, db) = open();
        assert_eq!(session_timeline(&db, 4711).unwrap_err(), NO_SAMPLES);
        // Sitzung ohne Messwerte
        let sid = session(&db, T0, T0 + 60_000);
        assert_eq!(session_timeline(&db, sid).unwrap_err(), NO_SAMPLES);
        // nur kaputte Blöcke bzw. unbekannte Messart
        insert_samples_chunk(db.conn(), sid, T0, AWS.0, AWS.1, AWS.2, 1, &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
        insert_samples_chunk(db.conn(), sid, T0 + 1, AWS.0, AWS.1, AWS.2, 1, &[1, 0]).unwrap();
        let ok = encode_chunk(T0 + 2, &[p(T0 + 2, Some(1.0))]);
        insert_samples_chunk(db.conn(), sid, T0 + 2, AWS.0, AWS.1, "udp", 1, &ok).unwrap();
        assert_eq!(session_timeline(&db, sid).unwrap_err(), NO_SAMPLES);
        // ein guter Block neben kaputten wird gelesen
        chunk(&db, sid, T0 + 3_000, 3, AWS, |_| Some(5.0));
        assert_eq!(session_timeline(&db, sid).unwrap().points.len(), 3);
    }

    #[test]
    fn merges_above_43200() {
        // 50 000 Punkte → je 2 zusammengefasst
        let pts: Vec<TimelinePoint> = (0..50_000i64)
            .map(|i| {
                let rtt = match i % 4 {
                    // Paar (0,1): beide Antworten → Mittel
                    0 => Some(10.0),
                    1 => Some(20.0),
                    // Paar (2,3): eine von zwei verloren → genau die Hälfte → Mittel der Antwort
                    2 => None,
                    _ => Some(40.0),
                };
                (i * 1000, rtt, Some(if i % 2 == 0 { 10.0 } else { 30.0 }), if i % 2 == 0 { None } else { Some(4.0) }, None)
            })
            .collect();
        let (merged, out) = merge_points(pts);
        assert_eq!(merged, 2);
        assert_eq!(out.len(), 25_000);
        assert!(out.len() <= MAX_POINTS);
        assert_eq!(out[0], (0, Some(15.0), Some(20.0), Some(4.0), None));
        assert_eq!(out[1], (2000, Some(40.0), Some(20.0), Some(4.0), None));
        // mehr als die Hälfte verloren → null
        let pts: Vec<TimelinePoint> = (0..(MAX_POINTS as i64 * 3)).map(|i| (i, if i % 3 == 0 { Some(9.0) } else { None }, None, None, None)).collect();
        let (merged, out) = merge_points(pts);
        assert_eq!(merged, 3);
        assert_eq!(out.len(), MAX_POINTS);
        assert!(out.iter().all(|p| p.1.is_none()));
        // bis 43 200 bleibt alles, wie es ist
        let pts: Vec<TimelinePoint> = (0..MAX_POINTS as i64).map(|i| (i, Some(1.0), None, None, None)).collect();
        let (merged, out) = merge_points(pts.clone());
        assert_eq!((merged, out), (1, pts));
    }

    #[test]
    fn merges_above_43200_from_db() {
        let (_d, db) = open();
        // 13 h bei 1 s = 46 800 Punkte → je 2 zusammengefasst
        let start = T0;
        let end = start + 13 * 3_600_000;
        let sid = session(&db, start, end);
        let pts_per_chunk = 60;
        let mut t = start;
        let conn = db.conn();
        conn.execute_batch("BEGIN").unwrap();
        while t < end {
            let pts: Vec<ChunkPoint> = (0..pts_per_chunk).map(|i| p(t + i * 1000, Some(20.0))).collect();
            insert_samples_chunk(conn, sid, t, AWS.0, AWS.1, AWS.2, pts_per_chunk, &encode_chunk(t, &pts)).unwrap();
            t += pts_per_chunk * 1000;
        }
        conn.execute_batch("COMMIT").unwrap();
        let tl = session_timeline(&db, sid).unwrap();
        assert_eq!(tl.merged, 2);
        assert_eq!(tl.points.len(), 23_400);
        assert_eq!(tl.points[1].0, start + 2000);
    }

    /// Ende zu Ende: Monitor-Takte (250 ms) einer Sitzung → Recorder → Schreiben → Zeitleiste.
    #[test]
    fn recorder_ticks_end_up_in_timeline() {
        use crate::db::DbHandle;
        use crate::net::ifstats::LoadSample;
        use crate::net::recorder::{flush_with, FlushGate, IngestCtx, Recorder};
        use crate::net::types::{PingMethod, PingSample, PingTarget};
        use std::sync::Mutex;

        let dir = tempfile::tempdir().unwrap();
        let handle = DbHandle::new();
        handle.replace(Some(Db::open(&dir.path().join("pulsar.db")).unwrap()));
        let start = crate::util::now_ms() / 1000 * 1000 - 120_000;
        let sid = handle.with(|db| Ok(session(db, start, start + 100_000))).unwrap();
        let rec = Mutex::new(Recorder::default());
        let gate = FlushGate::default();
        let target = PingTarget { id: AWS.0.into(), label: AWS.1.into(), host: "127.0.0.1".into(), port: None, method: PingMethod::Tcp };
        // 30 s bei 250 ms; vor dem Sitzungsbeginn gemessene Werte gehören nicht dazu
        for i in 0..120i64 {
            let t = start - 5_000 + i * 250;
            let rtt = if i % 40 == 39 { None } else { Some(20.0 + (i % 4) as f64) };
            let samples = [PingSample { target_id: target.id.clone(), t, rtt }];
            let load = LoadSample { at: t, cpu: Some(35.0), rx_mbps: Some(8.0), tx_mbps: Some(1.0), status: None };
            let ctx = IngestCtx { session: Some((sid, start)), ..Default::default() };
            let _ = rec.lock().unwrap().ingest(t, 250, std::slice::from_ref(&target), &[None], &samples, &load, ctx);
        }
        rec.lock().unwrap().on_stop(start + 25_000);
        flush_with(&rec, &gate, &handle).unwrap();
        let tl = handle.with(|db| session_timeline(db, sid)).unwrap();
        // 25 s in der Sitzung (start … start + 24,75 s) → 25 Punkte, einer je Sekunde
        assert_eq!(tl.points.len(), 25);
        assert_eq!(tl.points[0].0, start);
        assert!(tl.points.windows(2).all(|w| w[1].0 - w[0].0 == 1000));
        assert!(tl.points.iter().all(|p| p.2 == Some(35.0) && p.3 == Some(8.0) && p.4 == Some(1.0)));
        // Mittel 20/21/22/23 = 21,5 (bzw. ohne den verlorenen Wert)
        assert_eq!(tl.points[0].1, Some(21.5));
        assert_eq!(tl.targets.len(), 1);
        assert_eq!(tl.targets[0].label, AWS.1);
    }

    #[test]
    fn events_of_session_only() {
        let (_d, db) = open();
        let sid = session(&db, T0, T0 + 600_000);
        let other = session(&db, T0 + 700_000, T0 + 800_000);
        chunk(&db, sid, T0, 10, AWS, |_| Some(20.0));
        let conn = db.conn();
        let ev = |kind: EventKind, t: i64, end_t: Option<i64>, session: Option<i64>| {
            let mut e = NetEvent::new(kind, t);
            e.end_t = end_t;
            e.session_id = session;
            e
        };
        let mut spike = ev(EventKind::Spike, T0 + 30_000, None, Some(sid));
        spike.cause = Some(LagCause::Router);
        spike.target_key = Some(AWS.0.into());
        spike.method = Some(crate::net::types::PingMethod::Tcp);
        spike.connection = Some(ConnectionKind::Wifi);
        insert_event(conn, &spike, Some(r#"{"count":2,"baseline":20,"limit":60,"cpuHigh":false,"reasons":[]}"#)).unwrap();
        let mut outage = ev(EventKind::Outage, T0 + 10_000, Some(T0 + 14_000), Some(sid));
        outage.scope = Some(OutageScope::HomeNetwork);
        insert_event(conn, &outage, None).unwrap();
        insert_event(conn, &ev(EventKind::Loss, T0 + 60_000, Some(T0 + 120_000), Some(sid)), Some(r#"{"lost":4,"n":60}"#)).unwrap();
        insert_event(conn, &ev(EventKind::Slow, T0 + 120_000, Some(T0 + 180_000), Some(sid)), Some("kaputt{")).unwrap();
        // Speedtest der Sitzung gehört nicht in die Zeitleiste
        insert_event(conn, &ev(EventKind::Speedtest, T0 + 200_000, None, Some(sid)), None).unwrap();
        // Ereignisse anderer Sitzungen bzw. ohne Sitzung nicht
        insert_event(conn, &ev(EventKind::Spike, T0 + 40_000, None, Some(other)), None).unwrap();
        insert_event(conn, &ev(EventKind::Outage, T0 + 50_000, Some(T0 + 51_000), None), None).unwrap();
        // Ruhezeit ohne Sitzung, aber im Zeitraum → ja; außerhalb → nein
        insert_event(conn, &ev(EventKind::Quiet, T0 - 5_000, Some(T0 + 20_000), None), Some(r#"{"reason":"speedtest"}"#)).unwrap();
        insert_event(conn, &ev(EventKind::Quiet, T0 + 650_000, Some(T0 + 660_000), None), None).unwrap();
        // unbekannte Art wird übersprungen
        conn.execute("INSERT INTO net_events(t, kind, session_id) VALUES(?1, 'neu', ?2)", params![T0 + 1, sid]).unwrap();

        let tl = session_timeline(&db, sid).unwrap();
        let kinds: Vec<(EventKind, i64)> = tl.events.iter().map(|e| (e.kind, e.t)).collect();
        assert_eq!(
            kinds,
            vec![
                (EventKind::Quiet, T0 - 5_000),
                (EventKind::Outage, T0 + 10_000),
                (EventKind::Spike, T0 + 30_000),
                (EventKind::Loss, T0 + 60_000),
                (EventKind::Slow, T0 + 120_000),
            ]
        );
        let spike = &tl.events[2];
        assert_eq!(spike.cause, Some(LagCause::Router));
        assert_eq!(spike.connection, Some(ConnectionKind::Wifi));
        assert_eq!(spike.method, Some(crate::net::types::PingMethod::Tcp));
        assert_eq!(spike.count(), 2);
        assert_eq!(tl.events[1].scope, Some(OutageScope::HomeNetwork));
        assert_eq!(tl.events[0].detail, Some(json!({ "reason": "speedtest" })));
        assert_eq!(tl.events[4].detail, None, "kaputtes detail → null");
    }
}
