//! `net_events_list` und `net_events_summary`: Ereignisse aus `net_events` lesen
//! (Anbieter-Protokoll, Ausreißer). Vertrag: `docs/API.md`, „Anbieter-Protokoll“.
//!
//! Reine Datenbank (kein Netz). Zeilen mit unbekannter Art (z. B. aus einer späteren Version) werden
//! übersprungen; unbekannte Texte in den übrigen Spalten werden zu `null`, ein kaputtes `detail` zu
//! `null` (nie ein Absturz).

use std::collections::BTreeMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Row};
use serde_json::Value;

use super::hist_types::{
    check_range, clamp_events_limit, parse_method, ConnectionKind, EventKind, EventSummaryRow, EventsPage, NetEvent, OutageScope,
};
use super::lag::LagCause;
use crate::db::Db;
use crate::error::{db_err, CmdResult};

/// Eine Stunde (ms).
const HOUR_MS: i64 = 3_600_000;

/// Bekannte Arten aus `kinds` (unbekannte Werte werden ignoriert, doppelte zählen einmal).
/// `None` = alle Arten.
fn wanted_kinds(kinds: Option<&[String]>) -> Vec<EventKind> {
    match kinds {
        None => EventKind::ALL.to_vec(),
        Some(list) => EventKind::ALL.iter().copied().filter(|k| list.iter().any(|s| s == k.as_str())).collect(),
    }
}

/// `?5, ?6, …` für `IN (…)`.
fn placeholders(n: usize, first: usize) -> String {
    (0..n).map(|i| format!("?{}", first + i)).collect::<Vec<_>>().join(", ")
}

/// Ereignisse mit `from <= t <= to` (optional nur bestimmte Arten, nur ein Netz), aufsteigend nach
/// `t`; mehr als `limit` → die neuesten `limit` und `truncated = true`. Unbekannte Arten in `kinds`
/// werden ignoriert – bleibt keine bekannte übrig, ist die Liste leer. Zeitraum über 400 Tage oder
/// `from > to` → „Ungültiger Zeitraum.“ (der Befehl prüft das schon vorher; doppelt hält besser).
pub fn list(db: &Db, from: i64, to: i64, kinds: Option<&[String]>, net_id: Option<&str>, limit: u32) -> CmdResult<EventsPage> {
    check_range(from, to)?;
    let limit = clamp_events_limit(Some(limit));
    let kinds = wanted_kinds(kinds);
    if kinds.is_empty() {
        return Ok(EventsPage { events: Vec::new(), truncated: false });
    }
    // Die neuesten `limit + 1` lesen: die eine Zeile mehr zeigt, ob gekürzt wurde
    let sql = format!(
        "SELECT id, t, end_t, kind, target_key, target_label, method, net_id, connection, value, cause, scope, session_id, detail
         FROM net_events
         WHERE t >= ?1 AND t <= ?2 AND (?3 IS NULL OR net_id = ?3) AND kind IN ({})
         ORDER BY t DESC, id DESC
         LIMIT ?4",
        placeholders(kinds.len(), 5)
    );
    let mut args: Vec<SqlValue> = vec![
        SqlValue::Integer(from),
        SqlValue::Integer(to),
        net_id.map_or(SqlValue::Null, |n| SqlValue::Text(n.to_string())),
        SqlValue::Integer(i64::from(limit) + 1),
    ];
    args.extend(kinds.iter().map(|k| SqlValue::Text(k.as_str().to_string())));
    let mut stmt = db.conn().prepare(&sql).map_err(db_err)?;
    let rows = stmt.query_map(params_from_iter(args), row_to_event).map_err(db_err)?;
    let mut events = Vec::new();
    for row in rows {
        if let Some(e) = row.map_err(db_err)? {
            events.push(e);
        }
    }
    let max = usize::try_from(limit).unwrap_or(usize::MAX);
    let truncated = events.len() > max;
    events.truncate(max);
    events.reverse();
    Ok(EventsPage { events, truncated })
}

/// Zeile → `NetEvent`; unbekannte Art → `None`, unbekannte Texte in den übrigen Spalten → `None`
/// im jeweiligen Feld, kaputtes `detail` → `None`.
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

/// Gruppenschlüssel nach dem Übersetzen der Texte (unbekannte Texte landen gemeinsam bei `null`).
type SummaryKey = (i64, &'static str, Option<&'static str>, Option<&'static str>, Option<&'static str>, String);

/// Eine Gruppe, wie SQLite sie liefert (Texte noch roh).
type RawGroup = (i64, String, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, i64);

/// Zählungen ohne Grenze, gruppiert je UTC-Stunde, Art, Ursache, Umfang, Verbindung und Netz:
/// `rows` = Zeilen, `countSum` = Σ `detail.count` (ganze Zahl > 0) bzw. 1, `durationS` =
/// Σ(`end_t − t`)/1000 (ohne Ende bzw. negativ → 0). Sortiert nach Stunde, dann Art, Ursache,
/// Umfang, Verbindung, Netz.
pub fn summary(db: &Db, from: i64, to: i64, net_id: Option<&str>) -> CmdResult<Vec<EventSummaryRow>> {
    check_range(from, to)?;
    let mut stmt = db
        .conn()
        .prepare_cached(
            "SELECT (t - (t % 3600000)) - (CASE WHEN t % 3600000 < 0 THEN 3600000 ELSE 0 END) AS hour,
                    kind, cause, scope, connection, net_id,
                    COUNT(*),
                    SUM(CASE WHEN json_valid(detail)
                                  AND json_type(detail, '$.count') = 'integer'
                                  AND json_extract(detail, '$.count') > 0
                             THEN json_extract(detail, '$.count') ELSE 1 END),
                    SUM(CASE WHEN end_t IS NOT NULL AND end_t > t THEN end_t - t ELSE 0 END)
             FROM net_events
             WHERE t >= ?1 AND t <= ?2 AND (?3 IS NULL OR net_id = ?3)
             GROUP BY hour, kind, cause, scope, connection, net_id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params![from, to, net_id], |r| -> rusqlite::Result<RawGroup> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
        })
        .map_err(db_err)?;
    let mut groups: BTreeMap<SummaryKey, (i64, i64, i64)> = BTreeMap::new();
    for row in rows {
        let (hour, kind, cause, scope, connection, net, n, count, dur_ms) = row.map_err(db_err)?;
        let Some(kind) = EventKind::parse(&kind) else { continue };
        let key = (
            hour.div_euclid(HOUR_MS) * HOUR_MS,
            kind.as_str(),
            cause.as_deref().and_then(LagCause::parse).map(LagCause::as_str),
            scope.as_deref().and_then(OutageScope::parse).map(OutageScope::as_str),
            connection.as_deref().and_then(ConnectionKind::parse).map(ConnectionKind::as_str),
            net.unwrap_or_default(),
        );
        let slot = groups.entry(key).or_insert((0, 0, 0));
        slot.0 = slot.0.saturating_add(n.max(0));
        slot.1 = slot.1.saturating_add(count.max(0));
        slot.2 = slot.2.saturating_add(dur_ms.max(0));
    }
    Ok(groups
        .into_iter()
        .filter_map(|((hour_start, kind, cause, scope, connection, net_id), (rows, count_sum, dur_ms))| {
            Some(EventSummaryRow {
                hour_start,
                kind: EventKind::parse(kind)?,
                cause: cause.and_then(LagCause::parse),
                scope: scope.and_then(OutageScope::parse),
                connection: connection.and_then(ConnectionKind::parse),
                net_id,
                rows,
                count_sum,
                duration_s: dur_ms as f64 / 1000.0,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::insert_event;
    use crate::net::hist_types::{BAD_RANGE, MAX_RANGE_MS};
    use crate::net::types::PingMethod;
    use serde_json::json;

    const T0: i64 = 1_760_000_400_000; // volle Stunde (UTC)

    fn open() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("pulsar.db")).unwrap();
        (dir, db)
    }

    fn ev(kind: EventKind, t: i64, net: &str) -> NetEvent {
        let mut e = NetEvent::new(kind, t);
        e.net_id = net.into();
        if !matches!(kind, EventKind::Speedtest | EventKind::Quiet) {
            e.target_key = Some("aws-eu-central-1".into());
            e.target_label = Some("Frankfurt".into());
            e.method = Some(PingMethod::Icmp);
        }
        e.connection = Some(ConnectionKind::Ethernet);
        e
    }

    fn put(db: &Db, e: &NetEvent) -> i64 {
        let detail = e.detail.as_ref().map(|d| d.to_string());
        insert_event(db.conn(), e, detail.as_deref()).unwrap()
    }

    #[test]
    fn kinds_filter_limit_order_truncated() {
        assert_eq!(T0 % HOUR_MS, 0);
        let (_dir, db) = open();
        // Absichtlich nicht in Zeitreihenfolge eingefügt
        for (i, kind) in [EventKind::Slow, EventKind::Outage, EventKind::Loss, EventKind::Spike, EventKind::Speedtest, EventKind::Quiet]
            .into_iter()
            .enumerate()
        {
            let t = T0 + 60_000 * (6 - i as i64);
            put(&db, &ev(kind, t, "net-a"));
        }
        let mut other = ev(EventKind::Outage, T0 + 30_000, "net-b");
        other.scope = Some(OutageScope::Internet);
        other.end_t = Some(T0 + 34_000);
        other.detail = Some(json!({ "checks": { "link": true, "gw": true, "ext": false } }));
        put(&db, &other);
        // Unbekannte Art und kaputtes detail: nie ein Absturz
        db.conn().execute("INSERT INTO net_events(t, kind, net_id) VALUES(?1, 'zukunft', 'net-a')", [T0 + 1]).unwrap();
        db.conn()
            .execute("INSERT INTO net_events(t, kind, net_id, detail, connection) VALUES(?1, 'loss', 'net-a', '{kaputt', 'mond')", [T0 + 2])
            .unwrap();
        // Außerhalb des Zeitraums
        put(&db, &ev(EventKind::Outage, T0 - 1, "net-a"));
        put(&db, &ev(EventKind::Outage, T0 + 10 * 60_000 + 1, "net-a"));

        let to = T0 + 10 * 60_000;
        let all = list(&db, T0, to, None, None, 5000).unwrap();
        assert!(!all.truncated);
        assert_eq!(all.events.len(), 8, "{:?}", all.events);
        assert!(all.events.windows(2).all(|w| w[0].t <= w[1].t), "aufsteigend nach t");
        let broken = all.events.iter().find(|e| e.t == T0 + 2).unwrap();
        assert_eq!((broken.detail.as_ref(), broken.connection), (None, None));
        let o = all.events.iter().find(|e| e.net_id == "net-b").unwrap();
        assert_eq!(o.scope, Some(OutageScope::Internet));
        assert_eq!(o.end_t, Some(T0 + 34_000));
        assert_eq!(o.detail, Some(json!({ "checks": { "link": true, "gw": true, "ext": false } })));
        assert_eq!(o.method, Some(PingMethod::Icmp));

        // Arten-Filter (unbekannte Werte werden ignoriert)
        let kinds: Vec<String> = ["outage", "speedtest", "gibtsnicht"].iter().map(|s| s.to_string()).collect();
        let some = list(&db, T0, to, Some(&kinds), None, 5000).unwrap();
        assert_eq!(some.events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["outage", "speedtest", "outage"]);
        let none = list(&db, T0, to, Some(&["gibtsnicht".to_string()]), None, 5000).unwrap();
        assert!(none.events.is_empty() && !none.truncated);

        // Netz-Filter
        let b = list(&db, T0, to, None, Some("net-b"), 5000).unwrap();
        assert_eq!(b.events.len(), 1);
        let a = list(&db, T0, to, None, Some("net-a"), 5000).unwrap();
        assert_eq!(a.events.len(), 7);

        // Grenze: die neuesten `limit`, trotzdem aufsteigend
        let page = list(&db, T0, to, None, None, 3).unwrap();
        assert!(page.truncated);
        assert_eq!(page.events.iter().map(|e| e.t).collect::<Vec<_>>(), vec![T0 + 240_000, T0 + 300_000, T0 + 360_000]);
        let exact = list(&db, T0, to, None, None, 8).unwrap();
        assert!(!exact.truncated);
        assert_eq!(exact.events.len(), 8);

        // Zeitraum
        assert_eq!(list(&db, to, T0, None, None, 10).unwrap_err(), BAD_RANGE);
        assert_eq!(list(&db, 0, MAX_RANGE_MS + 1, None, None, 10).unwrap_err(), BAD_RANGE);
        // JSON-Form
        let v = serde_json::to_value(&page).unwrap();
        assert_eq!(v["truncated"], true);
        assert!(v["events"][0].get("endT").is_some());
    }

    #[test]
    fn summary_counts_by_hour_cause_scope() {
        let (_dir, db) = open();
        // Stunde 0: zwei Ausreißer derselben Ursache (count 3 und 2), einer anderer Ursache
        for (t, cause, count) in [(T0 + 1_000, LagCause::Wifi, 3), (T0 + 50_000, LagCause::Wifi, 2), (T0 + 90_000, LagCause::Isp, 1)] {
            let mut e = ev(EventKind::Spike, t, "net-a");
            e.cause = Some(cause);
            e.value = Some(180.0);
            e.detail = Some(json!({ "count": count }));
            put(&db, &e);
        }
        // Stunde 0: zwei Aussetzer der Internetverbindung (4 s + 6 s), einer pc (2 s)
        for (t, len, scope) in
            [(T0 + 100_000, 4_000, OutageScope::Internet), (T0 + 200_000, 6_000, OutageScope::Internet), (T0 + 300_000, 2_000, OutageScope::Pc)]
        {
            let mut e = ev(EventKind::Outage, t, "net-a");
            e.end_t = Some(t + len);
            e.scope = Some(scope);
            e.detail = Some(json!({ "checks": { "link": true, "gw": null, "ext": false } }));
            put(&db, &e);
        }
        // Stunde 1: ein Verlust-Fenster per WLAN (60 s), ein Speedtest ohne Ende, ein Ausreißer mit
        // kaputtem detail (zählt 1)
        let mut loss = ev(EventKind::Loss, T0 + HOUR_MS + 5, "net-a");
        loss.connection = Some(ConnectionKind::Wifi);
        loss.end_t = Some(T0 + HOUR_MS + 60_005);
        loss.detail = Some(json!({ "lost": 4, "n": 60 }));
        put(&db, &loss);
        put(&db, &ev(EventKind::Speedtest, T0 + HOUR_MS + 10, "net-a"));
        db.conn()
            .execute(
                "INSERT INTO net_events(t, kind, net_id, cause, detail) VALUES(?1, 'spike', 'net-a', 'router', '{\"count\":')",
                [T0 + HOUR_MS + 20],
            )
            .unwrap();
        // Anderes Netz, unbekannte Art
        let mut b = ev(EventKind::Spike, T0 + 2_000, "net-b");
        b.cause = Some(LagCause::Wifi);
        b.detail = Some(json!({ "count": 7 }));
        put(&db, &b);
        db.conn().execute("INSERT INTO net_events(t, kind, net_id) VALUES(?1, 'zukunft', 'net-a')", [T0 + 3]).unwrap();

        let rows = summary(&db, T0, T0 + 2 * HOUR_MS, Some("net-a")).unwrap();
        let find = |hour: i64, kind: EventKind, cause: Option<LagCause>, scope: Option<OutageScope>| {
            rows.iter().find(|r| r.hour_start == hour && r.kind == kind && r.cause == cause && r.scope == scope).cloned()
        };
        let wifi = find(T0, EventKind::Spike, Some(LagCause::Wifi), None).unwrap();
        assert_eq!((wifi.rows, wifi.count_sum, wifi.duration_s), (2, 5, 0.0));
        let isp = find(T0, EventKind::Spike, Some(LagCause::Isp), None).unwrap();
        assert_eq!((isp.rows, isp.count_sum), (1, 1));
        let inet = find(T0, EventKind::Outage, None, Some(OutageScope::Internet)).unwrap();
        assert_eq!((inet.rows, inet.count_sum, inet.duration_s), (2, 2, 10.0));
        assert_eq!(inet.connection, Some(ConnectionKind::Ethernet));
        let pc = find(T0, EventKind::Outage, None, Some(OutageScope::Pc)).unwrap();
        assert_eq!(pc.duration_s, 2.0);
        let l = find(T0 + HOUR_MS, EventKind::Loss, None, None).unwrap();
        assert_eq!((l.rows, l.duration_s, l.connection), (1, 60.0, Some(ConnectionKind::Wifi)));
        let st = find(T0 + HOUR_MS, EventKind::Speedtest, None, None).unwrap();
        assert_eq!((st.rows, st.count_sum, st.duration_s), (1, 1, 0.0));
        let broken = find(T0 + HOUR_MS, EventKind::Spike, Some(LagCause::Router), None).unwrap();
        assert_eq!(broken.count_sum, 1, "kaputtes detail zählt 1");
        assert!(rows.iter().all(|r| r.net_id == "net-a"));
        assert_eq!(rows.len(), 7, "{rows:?}");
        assert!(rows.windows(2).all(|w| w[0].hour_start <= w[1].hour_start), "nach Stunde sortiert");

        // Ohne Netzfilter kommt net-b dazu
        let all = summary(&db, T0, T0 + 2 * HOUR_MS, None).unwrap();
        let nb = all.iter().find(|r| r.net_id == "net-b").unwrap();
        assert_eq!((nb.hour_start, nb.count_sum), (T0, 7));
        assert_eq!(summary(&db, 5, 1, None).unwrap_err(), BAD_RANGE);
    }
}
