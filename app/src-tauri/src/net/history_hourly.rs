//! `net_history_hourly`: Stunden-Summen aus `ping_hourly` lesen (Pulsar-Kalender, Anbieter-Protokoll).
//! Vertrag: `docs/API.md`, „Pulsar-Kalender“.
//!
//! Reine Datenbank: Rohsummen je Stunde, Ziel, Netz und Verbindungsart – gewichtet und bewertet wird
//! in der Oberfläche (`lib/calendar.ts`). Zeilen mit unbekannten Texten (z. B. aus einer späteren
//! Version) werden übersprungen, nie ein Absturz.

use rusqlite::params;

use super::hist_types::{check_range, parse_method, ConnectionKind, HourlyRow, TargetKind};
use crate::db::Db;
use crate::error::{db_err, CmdResult};

/// Zeilen mit `from <= hourStart <= to`, optional nur ein Ziel bzw. ein Netz, nach `hourStart`
/// (dann Ziel, Netz, Verbindungsart) sortiert. Zeitraum über 400 Tage oder `from > to` →
/// „Ungültiger Zeitraum.“ (der Befehl prüft das schon vorher; doppelt hält besser).
pub fn hourly(db: &Db, from: i64, to: i64, target_key: Option<&str>, net_id: Option<&str>) -> CmdResult<Vec<HourlyRow>> {
    check_range(from, to)?;
    let mut stmt = db
        .conn()
        .prepare_cached(
            "SELECT hour_start, target_key, net_id, connection, kind, label, method, n, lost, sum_rtt,
                    sum_jitter, n_jitter, max_rtt, spikes, covered_ms
             FROM ping_hourly
             WHERE hour_start >= ?1 AND hour_start <= ?2
               AND (?3 IS NULL OR target_key = ?3)
               AND (?4 IS NULL OR net_id = ?4)
             ORDER BY hour_start, target_key, net_id, connection",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![from, to, target_key, net_id], |r| {
            Ok(RawRow {
                hour_start: r.get(0)?,
                target_key: r.get(1)?,
                net_id: r.get(2)?,
                connection: r.get(3)?,
                kind: r.get(4)?,
                label: r.get(5)?,
                method: r.get(6)?,
                n: r.get(7)?,
                lost: r.get(8)?,
                sum_rtt: r.get(9)?,
                sum_jitter: r.get(10)?,
                n_jitter: r.get(11)?,
                max_rtt: r.get(12)?,
                spikes: r.get(13)?,
                covered_ms: r.get(14)?,
            })
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(r) = row.map_err(db_err)?.into_row() {
            out.push(r);
        }
    }
    Ok(out)
}

/// Zeile wie in der Datenbank (Texte noch nicht geprüft).
struct RawRow {
    hour_start: i64,
    target_key: String,
    net_id: String,
    connection: String,
    kind: String,
    label: String,
    method: String,
    n: i64,
    lost: i64,
    sum_rtt: f64,
    sum_jitter: f64,
    n_jitter: i64,
    max_rtt: Option<f64>,
    spikes: i64,
    covered_ms: i64,
}

impl RawRow {
    /// Texte prüfen; unbekannte Verbindungsart/Messart → `None` (Zeile überspringen), unbekannte
    /// Zielart → aus der Ziel-ID ableiten. Rohsummen nie negativ.
    fn into_row(self) -> Option<HourlyRow> {
        let connection = ConnectionKind::parse(&self.connection)?;
        let method = parse_method(&self.method)?;
        let kind = TargetKind::parse(&self.kind).unwrap_or_else(|| TargetKind::from_target_id(&self.target_key));
        let finite = |v: f64| if v.is_finite() && v >= 0.0 { v } else { 0.0 };
        Some(HourlyRow {
            hour_start: self.hour_start,
            target_key: self.target_key,
            net_id: self.net_id,
            connection,
            kind,
            label: self.label,
            method,
            n: self.n.max(0),
            lost: self.lost.clamp(0, self.n.max(0)),
            sum_rtt: finite(self.sum_rtt),
            sum_jitter: finite(self.sum_jitter),
            n_jitter: self.n_jitter.max(0),
            max_rtt: self.max_rtt.filter(|v| v.is_finite()),
            spikes: self.spikes.max(0),
            covered_ms: self.covered_ms.max(0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::upsert_hourly;
    use crate::net::hist_types::{BAD_RANGE, MAX_RANGE_MS};
    use crate::net::types::PingMethod;

    const H: i64 = 3_600_000;

    fn open() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("pulsar.db")).unwrap();
        (dir, db)
    }

    fn row(hour_start: i64, target: &str, net: &str, conn: ConnectionKind) -> HourlyRow {
        HourlyRow {
            hour_start,
            target_key: target.into(),
            net_id: net.into(),
            connection: conn,
            kind: TargetKind::from_target_id(target),
            label: format!("Ziel {target}"),
            method: PingMethod::Icmp,
            n: 3_600,
            lost: 4,
            sum_rtt: 3_596.0 * 21.5,
            sum_jitter: 3_000.0,
            n_jitter: 3_590,
            max_rtt: Some(88.0),
            spikes: 2,
            covered_ms: 3_599_000,
        }
    }

    #[test]
    fn range_filter_and_order() {
        let (_dir, db) = open();
        // Absichtlich ungeordnet eingefügt
        for r in [
            row(5 * H, "aws-eu-central-1", "a", ConnectionKind::Ethernet),
            row(2 * H, "aws-eu-central-1", "a", ConnectionKind::Ethernet),
            row(2 * H, "aws-eu-central-1", "a", ConnectionKind::Wifi),
            row(9 * H, "valve-cs2-fra", "a", ConnectionKind::Ethernet),
            row(H, "aws-eu-central-1", "a", ConnectionKind::Ethernet),
        ] {
            upsert_hourly(db.conn(), &r).unwrap();
        }
        // Grenzen einschließlich: 2 h bis 9 h
        let rows = hourly(&db, 2 * H, 9 * H, None, None).unwrap();
        let got: Vec<(i64, &str, ConnectionKind)> = rows.iter().map(|r| (r.hour_start, r.target_key.as_str(), r.connection)).collect();
        assert_eq!(
            got,
            vec![
                (2 * H, "aws-eu-central-1", ConnectionKind::Ethernet),
                (2 * H, "aws-eu-central-1", ConnectionKind::Wifi),
                (5 * H, "aws-eu-central-1", ConnectionKind::Ethernet),
                (9 * H, "valve-cs2-fra", ConnectionKind::Ethernet),
            ]
        );
        // Rohsummen unverändert zurück
        assert_eq!(rows[0], row(2 * H, "aws-eu-central-1", "a", ConnectionKind::Ethernet));
        assert_eq!(rows[3].kind, TargetKind::Server);
        // Nur ein Ziel
        let only = hourly(&db, 0, 10 * H, Some("valve-cs2-fra"), None).unwrap();
        assert_eq!(only.len(), 1);
        // Keine Daten → leere Liste
        assert!(hourly(&db, 20 * H, 30 * H, None, None).unwrap().is_empty());
    }

    #[test]
    fn invalid_range_errors() {
        let (_dir, db) = open();
        assert_eq!(hourly(&db, 10, 5, None, None).unwrap_err(), BAD_RANGE);
        assert_eq!(hourly(&db, 0, MAX_RANGE_MS + 1, None, None).unwrap_err(), BAD_RANGE);
        assert!(hourly(&db, 0, MAX_RANGE_MS, None, None).unwrap().is_empty());
        assert!(hourly(&db, 7, 7, None, None).unwrap().is_empty(), "from = to ist erlaubt");
    }

    #[test]
    fn net_filter() {
        let (_dir, db) = open();
        upsert_hourly(db.conn(), &row(H, "aws-eu-central-1", "netz-a", ConnectionKind::Ethernet)).unwrap();
        upsert_hourly(db.conn(), &row(H, "aws-eu-central-1", "netz-b", ConnectionKind::Ethernet)).unwrap();
        upsert_hourly(db.conn(), &row(H, "aws-eu-central-1", "", ConnectionKind::Other)).unwrap();
        upsert_hourly(db.conn(), &row(2 * H, "valve-cs2-fra", "netz-b", ConnectionKind::Vpn)).unwrap();
        let b = hourly(&db, 0, 3 * H, None, Some("netz-b")).unwrap();
        assert_eq!(b.len(), 2);
        assert!(b.iter().all(|r| r.net_id == "netz-b"));
        let unknown = hourly(&db, 0, 3 * H, None, Some("")).unwrap();
        assert_eq!(unknown.len(), 1, "\"\" = unbekanntes Netz ist ein eigener Filterwert");
        let both = hourly(&db, 0, 3 * H, Some("valve-cs2-fra"), Some("netz-b")).unwrap();
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].connection, ConnectionKind::Vpn);
    }

    #[test]
    fn unknown_texts_are_skipped_not_fatal() {
        let (_dir, db) = open();
        upsert_hourly(db.conn(), &row(H, "aws-eu-central-1", "a", ConnectionKind::Ethernet)).unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO ping_hourly VALUES(7200000,'x','a','satellit','region','X','icmp',1,0,1,0,0,NULL,0,1);
                 INSERT INTO ping_hourly VALUES(7200000,'y','a','wifi','neu','Y','quic',1,0,1,0,0,NULL,0,1);
                 INSERT INTO ping_hourly VALUES(7200000,'riot-euw','a','wifi','neu','Z','tcp',2,5,-1,0,0,NULL,0,-3);",
            )
            .unwrap();
        let rows = hourly(&db, 0, 3 * H, None, None).unwrap();
        assert_eq!(rows.len(), 2);
        let z = &rows[1];
        assert_eq!((z.target_key.as_str(), z.kind, z.lost, z.sum_rtt, z.covered_ms), ("riot-euw", TargetKind::Server, 2, 0.0, 0));
    }
}
