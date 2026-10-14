//! Stunden-Summen je Ziel, Netz und Verbindungsart (`ping_hourly`, Pulsar-Kalender). Vertrag:
//! `docs/API.md`, „Datenbank v2“ (Datenbasis) und „Pulsar-Kalender“.
//!
//! - Je Messwert: `n`, `lost`, `sum_rtt`, `max_rtt`, `spikes` in der Stunde (UTC) des Messwerts.
//! - **Schwankung:** `|rtt_i − rtt_i−1|` aufeinanderfolgender **Antworten** desselben Ziels (Verluste
//!   werden übersprungen, wie `rttStats` in `grade.ts`) – auch über Schreibgrenzen hinweg, weil der
//!   letzte Wert je Ziel beim Herausnehmen ([`HourlyAcc::take`]) erhalten bleibt.
//! - **Messzeit (`covered_ms`):** echter Abstand zur vorigen Messung desselben Ziels, je Abstand
//!   höchstens `2 × Intervall`, zugeordnet der Stunde der **späteren** Messung. Die erste Messung
//!   nach Start, Lücke oder Wechsel von Netz/Verbindungsart/Messart bringt keine Messzeit.
//! - **Lücke** ([`HourlyAcc::gap`], Standby/Uhr/Stopp): keine Schwankung und keine Messzeit über die
//!   Lücke hinweg; schon gesammelte Summen bleiben.
//!
//! Alles rein (keine Ein-/Ausgabe, keine Sperren) – geschrieben wird vom Kern per Upsert.

use std::collections::HashMap;

use crate::net::hist_types::{ConnectionKind, HourlyRow, TargetKind};
use crate::net::types::PingMethod;

/// Eine Stunde in ms.
pub const HOUR_MS: i64 = 3_600_000;

/// Auf die volle Stunde (UTC) abrunden.
pub fn hour_start(t: i64) -> i64 {
    t.div_euclid(HOUR_MS) * HOUR_MS
}

/// Höchstens so viel Messzeit bringt ein Abstand zwischen zwei Messungen (`2 × Intervall`).
pub fn covered_cap_ms(interval_ms: u64) -> i64 {
    i64::try_from(interval_ms).unwrap_or(i64::MAX / 4).saturating_mul(2)
}

/// Wozu eine Stundenzeile gehört.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HourKey {
    pub target_key: String,
    pub label: String,
    pub kind: TargetKind,
    pub method: PingMethod,
    pub net_id: String,
    pub connection: ConnectionKind,
}

/// Primärschlüssel einer Zeile in `ping_hourly`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RowKey {
    hour_start: i64,
    target_key: String,
    net_id: String,
    connection: ConnectionKind,
}

/// Letzte Messung eines Ziels (für Schwankung und Messzeit).
#[derive(Debug, Clone)]
struct LastSeen {
    t: i64,
    /// Letzte **Antwort** (ein Verlust löscht sie nicht)
    rtt: Option<f64>,
    method: PingMethod,
    net_id: String,
    connection: ConnectionKind,
}

/// Sammelt Stunden-Deltas (Jitter und `covered_ms` auch über Schreibgrenzen hinweg).
#[derive(Debug, Default)]
pub struct HourlyAcc {
    rows: HashMap<RowKey, HourlyRow>,
    last: HashMap<String, LastSeen>,
}

impl HourlyAcc {
    /// Messwert eines Ziels (`spike` = Live-Ausreißer-Regel hat angeschlagen). `rtt = None` = verloren.
    pub fn push(&mut self, key: &HourKey, t: i64, rtt: Option<f64>, spike: bool, interval_ms: u64) {
        let rtt = rtt.filter(|v| v.is_finite() && *v >= 0.0);
        // Vorige Messung desselben Ziels in derselben Umgebung (sonst neu beginnen)
        let prev = self
            .last
            .get(&key.target_key)
            .filter(|p| p.method == key.method && p.net_id == key.net_id && p.connection == key.connection && t >= p.t);
        let covered = prev.map_or(0, |p| (t - p.t).clamp(0, covered_cap_ms(interval_ms)));
        let jitter = match (prev.and_then(|p| p.rtt), rtt) {
            (Some(a), Some(b)) => Some((b - a).abs()),
            _ => None,
        };
        let last_rtt = rtt.or_else(|| prev.and_then(|p| p.rtt));

        let hour = hour_start(t);
        let row_key = RowKey { hour_start: hour, target_key: key.target_key.clone(), net_id: key.net_id.clone(), connection: key.connection };
        let row = self.rows.entry(row_key).or_insert_with(|| empty_row(key, hour));
        // Name, Art und Messart: zuletzt geschrieben gilt (wie der Upsert)
        row.label.clone_from(&key.label);
        row.kind = key.kind;
        row.method = key.method;
        row.n += 1;
        match rtt {
            Some(v) => {
                row.sum_rtt += v;
                row.max_rtt = Some(row.max_rtt.map_or(v, |m| m.max(v)));
            }
            None => row.lost += 1,
        }
        if let Some(j) = jitter {
            row.sum_jitter += j;
            row.n_jitter += 1;
        }
        // Ausreißerquote = spikes / Antworten → nur Antworten zählen
        if spike && rtt.is_some() {
            row.spikes += 1;
        }
        row.covered_ms += covered;

        self.last.insert(
            key.target_key.clone(),
            LastSeen { t, rtt: last_rtt, method: key.method, net_id: key.net_id.clone(), connection: key.connection },
        );
    }

    /// Lücke (Standby, Uhr): kein Jitter und keine Messzeit über die Lücke hinweg.
    pub fn gap(&mut self) {
        self.last.clear();
    }

    /// Gesammelte Deltas herausnehmen (Upsert addiert sie in der Datenbank), nach Stunde und Ziel
    /// sortiert. Der letzte Wert je Ziel bleibt (Schwankung und Messzeit über die Schreibgrenze).
    pub fn take(&mut self) -> Vec<HourlyRow> {
        let mut rows: Vec<HourlyRow> = self.rows.drain().map(|(_, r)| r).collect();
        rows.sort_by(|a, b| {
            (a.hour_start, &a.target_key, &a.net_id, a.connection.as_str()).cmp(&(b.hour_start, &b.target_key, &b.net_id, b.connection.as_str()))
        });
        rows
    }

    /// Nach einem fehlgeschlagenen Schreiben wieder einreihen (addiert wie der Upsert). Der Kern
    /// behält fehlgeschlagene Stapel selbst (Phase 0b) und ruft das nicht auf; es rechnet trotzdem richtig.
    #[allow(dead_code)]
    pub fn requeue(&mut self, rows: Vec<HourlyRow>) {
        for r in rows {
            let key = RowKey { hour_start: r.hour_start, target_key: r.target_key.clone(), net_id: r.net_id.clone(), connection: r.connection };
            match self.rows.get_mut(&key) {
                Some(cur) => {
                    cur.n += r.n;
                    cur.lost += r.lost;
                    cur.sum_rtt += r.sum_rtt;
                    cur.sum_jitter += r.sum_jitter;
                    cur.n_jitter += r.n_jitter;
                    cur.spikes += r.spikes;
                    cur.covered_ms += r.covered_ms;
                    cur.max_rtt = match (cur.max_rtt, r.max_rtt) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                }
                None => {
                    self.rows.insert(key, r);
                }
            }
        }
    }

    /// Alles verwerfen.
    pub fn clear(&mut self) {
        self.rows.clear();
        self.last.clear();
    }

}

fn empty_row(key: &HourKey, hour_start: i64) -> HourlyRow {
    HourlyRow {
        hour_start,
        target_key: key.target_key.clone(),
        net_id: key.net_id.clone(),
        connection: key.connection,
        kind: key.kind,
        label: key.label.clone(),
        method: key.method,
        n: 0,
        lost: 0,
        sum_rtt: 0.0,
        sum_jitter: 0.0,
        n_jitter: 0,
        max_rtt: None,
        spikes: 0,
        covered_ms: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbHandle;
    use crate::error::{db_err, LockExt};
    use crate::net::ifstats::LoadSample;
    use crate::net::link::{LinkKind, PrimaryLinkLite};
    use crate::net::recorder::{flush_at, FlushGate, IngestCtx, Recorder};
    use crate::net::types::{PingSample, PingTarget};
    use std::sync::Mutex;

    fn key(net: &str, conn: ConnectionKind) -> HourKey {
        HourKey {
            target_key: "aws-eu-central-1".into(),
            label: "Frankfurt".into(),
            kind: TargetKind::Region,
            method: PingMethod::Icmp,
            net_id: net.into(),
            connection: conn,
        }
    }

    fn eth() -> HourKey {
        key("net-a", ConnectionKind::Ethernet)
    }

    #[test]
    fn hour_start_rounds_down_utc() {
        assert_eq!(hour_start(0), 0);
        assert_eq!(hour_start(3_599_999), 0);
        assert_eq!(hour_start(3_600_000), 3_600_000);
        assert_eq!(hour_start(-1), -3_600_000);
        assert_eq!(covered_cap_ms(250), 500);
        assert_eq!(covered_cap_ms(u64::MAX), i64::MAX / 4 * 2);
    }

    #[test]
    fn hourly_sums_and_jitter_across_flush() {
        let mut acc = HourlyAcc::default();
        let k = eth();
        // 20, verloren | Schreibgrenze | 26, 23 → Schwankung |26−20| + |23−26| = 9 aus 2 Differenzen
        acc.push(&k, 1_000, Some(20.0), false, 1_000);
        acc.push(&k, 2_000, None, false, 1_000);
        let first = acc.take();
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].n, first[0].lost, first[0].n_jitter, first[0].covered_ms), (2, 1, 0, 1_000));
        assert_eq!(first[0].max_rtt, Some(20.0));
        // Über die Schreibgrenze hinweg: der letzte Wert bleibt
        acc.push(&k, 3_000, Some(26.0), true, 1_000);
        acc.push(&k, 4_000, Some(23.0), false, 1_000);
        let second = acc.take();
        assert_eq!(second.len(), 1);
        let r = &second[0];
        assert_eq!((r.n, r.lost, r.n_jitter, r.spikes, r.covered_ms), (2, 0, 2, 1, 2_000));
        assert!((r.sum_jitter - 9.0).abs() < 1e-9);
        assert!((r.sum_rtt - 49.0).abs() < 1e-9);
        assert_eq!(r.max_rtt, Some(26.0));
        assert!(acc.take().is_empty(), "nach dem Herausnehmen leer");
    }

    #[test]
    fn covered_ms_caps_gaps() {
        // Je Takt (250 ms, 1 s, 10 s): eine Stunde lückenlos messen → 1 h minus ein Takt Messzeit
        for interval in [250_u64, 1_000, 10_000] {
            let mut acc = HourlyAcc::default();
            let step = i64::try_from(interval).unwrap();
            let mut t = 0;
            while t < HOUR_MS {
                acc.push(&eth(), t, Some(20.0), false, interval);
                t += step;
            }
            let rows = acc.take();
            assert_eq!(rows.len(), 1, "Takt {interval}");
            assert_eq!(rows[0].covered_ms, HOUR_MS - step, "Takt {interval}: erster Wert bringt keine Messzeit");
            assert_eq!(rows[0].n, HOUR_MS / step);
        }
        // Abstand größer als 2 × Intervall (aber unter der Lückengrenze) → gekappt
        let mut acc = HourlyAcc::default();
        acc.push(&eth(), 0, Some(20.0), false, 1_000);
        acc.push(&eth(), 4_500, Some(20.0), false, 1_000);
        assert_eq!(acc.take()[0].covered_ms, 2_000);
        // 250-ms-Takt mit verspäteten Antworten: je Abstand höchstens 500 ms
        acc.push(&eth(), 5_500, Some(20.0), false, 250);
        acc.push(&eth(), 6_500, Some(20.0), false, 250);
        assert_eq!(acc.take()[0].covered_ms, 1_000);
        // Lücke (Standby) → keine Messzeit und keine Schwankung über die Lücke
        acc.gap();
        acc.push(&eth(), 20_000, Some(20.0), false, 1_000);
        acc.push(&eth(), 21_000, Some(24.0), false, 1_000);
        acc.gap();
        acc.push(&eth(), 9_000_000, Some(60.0), false, 1_000);
        let r = acc.take();
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].covered_ms, r[0].n_jitter), (1_000, 1));
        assert_eq!((r[1].covered_ms, r[1].n_jitter), (0, 0), "nichts über die Lücke");
        // Uhr zurückgestellt → keine negative Messzeit, keine Schwankung
        acc.push(&eth(), 5_000, Some(20.0), false, 1_000);
        let r = acc.take();
        assert_eq!((r[0].covered_ms, r[0].n_jitter), (0, 0));
    }

    #[test]
    fn covered_goes_to_hour_of_later_measurement() {
        let mut acc = HourlyAcc::default();
        acc.push(&eth(), HOUR_MS - 500, Some(20.0), false, 1_000);
        acc.push(&eth(), HOUR_MS + 500, Some(22.0), false, 1_000);
        let rows = acc.take();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].hour_start, rows[0].covered_ms, rows[0].n_jitter), (0, 0, 0));
        assert_eq!((rows[1].hour_start, rows[1].covered_ms, rows[1].n_jitter), (HOUR_MS, 1_000, 1));
    }

    #[test]
    fn hourly_split_by_net_and_connection() {
        let mut acc = HourlyAcc::default();
        acc.push(&eth(), 0, Some(20.0), false, 1_000);
        acc.push(&eth(), 1_000, Some(21.0), false, 1_000);
        // Wechsel auf WLAN im selben Netz → eigene Zeile, neu beginnen
        let wifi = key("net-a", ConnectionKind::Wifi);
        acc.push(&wifi, 2_000, Some(40.0), false, 1_000);
        acc.push(&wifi, 3_000, Some(44.0), false, 1_000);
        // Anderes Netz per Kabel
        let other = key("net-b", ConnectionKind::Ethernet);
        acc.push(&other, 4_000, Some(30.0), false, 1_000);
        // Zweites Ziel läuft unabhängig daneben
        let mut valve = eth();
        valve.target_key = "valve-cs2-fra".into();
        valve.kind = TargetKind::Server;
        acc.push(&valve, 4_000, Some(15.0), false, 1_000);
        let rows = acc.take();
        assert_eq!(rows.len(), 4);
        let find = |t: &str, n: &str, c: ConnectionKind| rows.iter().find(|r| r.target_key == t && r.net_id == n && r.connection == c).cloned().unwrap();
        let e = find("aws-eu-central-1", "net-a", ConnectionKind::Ethernet);
        assert_eq!((e.n, e.n_jitter, e.covered_ms), (2, 1, 1_000));
        let w = find("aws-eu-central-1", "net-a", ConnectionKind::Wifi);
        assert_eq!((w.n, w.n_jitter, w.covered_ms), (2, 1, 1_000), "kein Abstand/Sprung über den Wechsel");
        assert!((w.sum_jitter - 4.0).abs() < 1e-9);
        let b = find("aws-eu-central-1", "net-b", ConnectionKind::Ethernet);
        assert_eq!((b.n, b.n_jitter, b.covered_ms), (1, 0, 0));
        let v = find("valve-cs2-fra", "net-a", ConnectionKind::Ethernet);
        assert_eq!((v.kind, v.n), (TargetKind::Server, 1));
    }

    #[test]
    fn spikes_only_count_answers_and_requeue_adds_up() {
        let mut acc = HourlyAcc::default();
        acc.push(&eth(), 0, None, true, 1_000);
        acc.push(&eth(), 1_000, Some(f64::NAN), false, 1_000);
        let rows = acc.take();
        assert_eq!((rows[0].n, rows[0].lost, rows[0].spikes, rows[0].max_rtt), (2, 2, 0, None));
        acc.push(&eth(), 2_000, Some(30.0), true, 1_000);
        acc.requeue(rows);
        let again = acc.take();
        assert_eq!(again.len(), 1);
        assert_eq!((again[0].n, again[0].lost, again[0].spikes, again[0].max_rtt), (3, 2, 1, Some(30.0)));
        acc.push(&eth(), 3_000, Some(30.0), false, 1_000);
        acc.clear();
        assert!(acc.take().is_empty());
    }

    // ---------------------------------------------------------------------------------------------
    // Über den Recorder-Kern bis in die Datenbank (Ingest → Flush → Upsert → net_history_hourly)
    // ---------------------------------------------------------------------------------------------

    fn ctx(net: &str, kind: LinkKind) -> IngestCtx {
        IngestCtx { link: Some(PrimaryLinkLite { luid: 1, if_index: 2, kind, gateway: None, net_id: net.into(), vpn: false, at: 0 }), ..Default::default() }
    }

    fn tick(r: &Mutex<Recorder>, t: i64, target: &PingTarget, rtt: Option<f64>, c: IngestCtx) {
        let samples = [PingSample { target_id: target.id.clone(), t, rtt }];
        r.lock_safe().ingest(t, 1_000, std::slice::from_ref(target), &[None], &samples, &LoadSample { at: t, ..Default::default() }, c);
    }

    #[test]
    fn recorder_writes_hourly_rows_across_flush() {
        let dir = tempfile::tempdir().unwrap();
        let db = DbHandle::new();
        db.replace(Some(crate::db::Db::open(&dir.path().join("pulsar.db")).unwrap()));
        let rec = Mutex::new(Recorder::default());
        let gate = FlushGate::default();
        let target = PingTarget { id: "aws-eu-central-1".into(), label: "Frankfurt".into(), host: "127.0.0.1".into(), port: None, method: PingMethod::Icmp };
        let base = 10 * HOUR_MS;
        tick(&rec, base, &target, Some(20.0), ctx("net-a", LinkKind::Ethernet));
        tick(&rec, base + 1_000, &target, Some(24.0), ctx("net-a", LinkKind::Ethernet));
        flush_at(&rec, &gate, &db, base + 1_500).unwrap();
        tick(&rec, base + 2_000, &target, Some(22.0), ctx("net-a", LinkKind::Ethernet));
        tick(&rec, base + 3_000, &target, None, ctx("net-a", LinkKind::Ethernet));
        tick(&rec, base + 4_000, &target, Some(30.0), ctx("net-a", LinkKind::Wifi));
        flush_at(&rec, &gate, &db, base + 5_000).unwrap();
        let rows = db.with(|db| crate::net::history_hourly::hourly(db, 0, base + HOUR_MS, None, None)).unwrap();
        assert_eq!(rows.len(), 2, "Kabel und WLAN getrennt");
        let e = rows.iter().find(|r| r.connection == ConnectionKind::Ethernet).unwrap();
        assert_eq!((e.hour_start, e.n, e.lost, e.n_jitter, e.covered_ms), (base, 4, 1, 2, 3_000));
        assert!((e.sum_jitter - 6.0).abs() < 1e-9, "|24−20| + |22−24| über die Schreibgrenze");
        assert_eq!(e.max_rtt, Some(24.0));
        assert_eq!((e.kind, e.label.as_str(), e.method, e.net_id.as_str()), (TargetKind::Region, "Frankfurt", crate::net::ping::effective_method(PingMethod::Icmp), "net-a"));
        let w = rows.iter().find(|r| r.connection == ConnectionKind::Wifi).unwrap();
        assert_eq!((w.n, w.covered_ms, w.n_jitter), (1, 0, 0));
        let n: i64 = db.with(|db| db.conn().query_row("SELECT SUM(n) FROM ping_hourly", [], |r| r.get(0)).map_err(db_err)).unwrap();
        assert_eq!(n, 5);
    }
}
