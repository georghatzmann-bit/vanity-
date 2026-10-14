//! Gemeinsame Typen des Netzwerk-Verlaufs (Datenbank v2, Lag-Detektiv, Zeitleiste, Kalender,
//! Anbieter-Protokoll). Vertrag: `docs/API.md`, Abschnitt „Datenbank v2“. Alles camelCase wie in
//! `app/src/lib/types/history.ts`.
//!
//! Die Texte in der Datenbank (`kind`, `scope`, `connection` …) sind genau die serde-Namen; `as_str`
//! und `parse` übersetzen in beide Richtungen (unbekannte Werte → `None`, nie ein Absturz).
// Die Helfer benutzen erst die Recorder- und Lesemodule (Phase 0b/1) – bis dahin nur Tests.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::lag::LagCause;
use super::types::PingMethod;

/// „Für diese Sitzung gibt es keine Messwerte.“ (`backend.noSamples`)
pub const NO_SAMPLES: &str = "Für diese Sitzung gibt es keine Messwerte.";
/// „Ungültiger Zeitraum.“ (`backend.badRange`)
pub const BAD_RANGE: &str = "Ungültiger Zeitraum.";
/// „Unbekannter Bereich.“ (`backend.badScope`)
pub const BAD_SCOPE: &str = "Unbekannter Bereich.";

/// Längster Zeitraum der Lesebefehle (400 Tage in ms).
pub const MAX_RANGE_MS: i64 = 400 * 24 * 3_600_000;
/// Höchstzahl Ereignisse je `net_events_list`.
pub const MAX_EVENTS_LIMIT: u32 = 20_000;
/// Standard für `net_events_list(limit)`.
pub const DEFAULT_EVENTS_LIMIT: u32 = 5_000;

/// Zeitraum der Lesebefehle prüfen: `from <= to` und höchstens 400 Tage.
pub fn check_range(from: i64, to: i64) -> Result<(), String> {
    if from > to || to.saturating_sub(from) > MAX_RANGE_MS {
        Err(BAD_RANGE.into())
    } else {
        Ok(())
    }
}

/// `limit` von `net_events_list` begrenzen (Standard 5000, höchstens 20 000, mindestens 1).
pub fn clamp_events_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_EVENTS_LIMIT).clamp(1, MAX_EVENTS_LIMIT)
}

macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            /// Alle Werte in Vertragsreihenfolge.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// Text wie in Datenbank und JSON.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            /// Text → Wert (`None` bei unbekanntem Text).
            pub fn parse(s: &str) -> Option<Self> {
                match s {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

text_enum! {
    /// Art eines Eintrags in `net_events`.
    EventKind {
        /// Aussetzer (mindestens 3 Verluste in Folge und 3 s ohne Antwort)
        Outage => "outage",
        /// Paketverlust über 5 % in einem Fenster
        Loss => "loss",
        /// Minuten-Durchschnitt über der Schwelle
        Slow => "slow",
        /// Live-Ausreißer (höchstens ein Eintrag je 10 s)
        Spike => "spike",
        /// Erfolgreicher Speedtest
        Speedtest => "speedtest",
        /// Ruhezeit wegen Pulsars eigenem Speedtest bzw. WLAN-Scan
        Quiet => "quiet",
    }
}

text_enum! {
    /// Umfang eines Aussetzers (`src/net/scope.rs`).
    OutageScope {
        /// PC getrennt, Standby, Verbindungswechsel – nie ein Aussetzer der Internetverbindung
        Pc => "pc",
        /// Router antwortet nicht, obwohl er sonst antwortet
        HomeNetwork => "homeNetwork",
        /// Router ok (oder nicht bewertbar), beide externen Hosts stumm
        Internet => "internet",
        /// Mindestens ein externer Host antwortet – nur das Messziel ist weg
        TargetOnly => "targetOnly",
        /// Prüfung nicht möglich
        Unknown => "unknown",
    }
}

text_enum! {
    /// Verbindungsart einer Messung (`vpn` hat Vorrang vor der Adapterart).
    ConnectionKind {
        Wifi => "wifi",
        Ethernet => "ethernet",
        Other => "other",
        Vpn => "vpn",
    }
}

text_enum! {
    /// Art des Messziels, abgeleitet aus der Ziel-ID.
    TargetKind {
        /// `aws-…` (Rechenzentrums-Region)
        Region => "region",
        /// `valve-…`, `riot-…` (Spielserver)
        Server => "server",
        Other => "other",
    }
}

impl TargetKind {
    /// `aws-…` = Region, `valve-…`/`riot-…` = Spielserver, sonst `other`.
    pub fn from_target_id(id: &str) -> Self {
        if id.starts_with("aws-") {
            TargetKind::Region
        } else if id.starts_with("valve-") || id.starts_with("riot-") {
            TargetKind::Server
        } else {
            TargetKind::Other
        }
    }
}

/// Messart als Datenbank-Text.
pub fn method_str(m: PingMethod) -> &'static str {
    match m {
        PingMethod::Icmp => "icmp",
        PingMethod::Tcp => "tcp",
    }
}

/// Datenbank-Text → Messart (`None` bei unbekanntem Text).
pub fn parse_method(s: &str) -> Option<PingMethod> {
    match s {
        "icmp" => Some(PingMethod::Icmp),
        "tcp" => Some(PingMethod::Tcp),
        _ => None,
    }
}

/// Ein Eintrag aus `net_events` (gemeinsamer Ereignistyp).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetEvent {
    /// Laufende Nummer (`net_events.id`; 0 = noch nicht geschrieben)
    pub id: i64,
    /// Beginn (ms UTC)
    pub t: i64,
    /// Ende (ms UTC); `None` bei `spike` und `speedtest`
    pub end_t: Option<i64>,
    pub kind: EventKind,
    /// Messziel (`PingTarget.id`); `None` bei `speedtest`/`quiet`
    pub target_key: Option<String>,
    pub target_label: Option<String>,
    pub method: Option<PingMethod>,
    /// Netz-Kennung (Hash, `""` = unbekannt)
    pub net_id: String,
    pub connection: Option<ConnectionKind>,
    /// Bedeutung je `kind` (Dauer in s, Verlust in %, ms, Mbit/s …)
    pub value: Option<f64>,
    /// Nur `spike`: eingeschätzte Ursache
    pub cause: Option<LagCause>,
    /// Nur `outage`: Umfang
    pub scope: Option<OutageScope>,
    pub session_id: Option<i64>,
    /// Geparstes JSON (höchstens 1 KiB in der Datenbank) oder `None`
    pub detail: Option<Value>,
}

impl NetEvent {
    /// Leeres Ereignis einer Art (alle optionalen Felder leer) – Ausgangspunkt für die Recorder-Teile.
    pub fn new(kind: EventKind, t: i64) -> Self {
        NetEvent {
            id: 0,
            t,
            end_t: None,
            kind,
            target_key: None,
            target_label: None,
            method: None,
            net_id: String::new(),
            connection: None,
            value: None,
            cause: None,
            scope: None,
            session_id: None,
            detail: None,
        }
    }

    /// `detail.count` (Ausreißer je 10 s) bzw. 1.
    pub fn count(&self) -> i64 {
        self.detail
            .as_ref()
            .and_then(|d| d.get("count"))
            .and_then(Value::as_i64)
            .filter(|c| *c > 0)
            .unwrap_or(1)
    }
}

/// Ein Ereignis, das der Recorder noch in `net_events` schreiben muss (neu oder geändert).
///
/// Die Recorder-Teile (`spike`, `events`, Kern) liefern offene Ereignisse bei jeder Änderung erneut
/// mit demselben `key`; der Kern merkt sich je `key` die rowid (erst `INSERT`, danach `UPDATE`).
#[derive(Debug, Clone, PartialEq)]
pub struct EventDraft {
    /// Eindeutig im Recorder: obere 4 Bit = Quelle ([`KEY_CORE`], [`KEY_SPIKE`], [`KEY_EVENTS`]),
    /// darunter eine laufende Nummer der Quelle.
    pub key: u64,
    pub event: NetEvent,
    /// `true` = abgeschlossen; danach kommt dieser `key` nicht wieder.
    pub closed: bool,
}

/// Quelle „Recorder-Kern“ (`speedtest`, `quiet`).
pub const KEY_CORE: u64 = 1 << 60;
/// Quelle „Ausreißer“ (`recorder/spike.rs`).
pub const KEY_SPIKE: u64 = 2 << 60;
/// Quelle „outage/loss/slow“ (`recorder/events.rs`).
pub const KEY_EVENTS: u64 = 3 << 60;

/// Eine Zeile aus `ping_hourly` (Rohsummen, damit die Oberfläche richtig gewichtet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyRow {
    /// ms UTC, auf die volle Stunde abgerundet
    pub hour_start: i64,
    pub target_key: String,
    pub net_id: String,
    pub connection: ConnectionKind,
    pub kind: TargetKind,
    pub label: String,
    pub method: PingMethod,
    pub n: i64,
    pub lost: i64,
    pub sum_rtt: f64,
    pub sum_jitter: f64,
    pub n_jitter: i64,
    pub max_rtt: Option<f64>,
    pub spikes: i64,
    pub covered_ms: i64,
}

/// Ein Messziel einer Sitzung (`session_samples.target_key/target_label/method`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTarget {
    pub key: String,
    pub label: String,
    pub method: PingMethod,
}

/// Wechsel des Messziels innerhalb einer Sitzung.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetChange {
    pub t: i64,
    pub key: String,
}

/// Ein Punkt der Zeitleiste: `[t, rtt | null, cpu | null, rxMbps | null, txMbps | null]`.
pub type TimelinePoint = (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>);

/// Ergebnis von `net_session_timeline`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTimeline {
    pub session_id: i64,
    pub game_id: String,
    pub start: i64,
    pub end: i64,
    /// In der Reihenfolge des ersten Auftretens
    pub targets: Vec<TimelineTarget>,
    pub target_changes: Vec<TargetChange>,
    /// 1 = gespeicherte Punkte, sonst Anzahl zusammengefasster Punkte je Punkt
    pub merged: u32,
    pub points: Vec<TimelinePoint>,
    /// Ereignisse der Sitzung (`spike`, `outage`, `loss`, `slow`, `quiet`), nach `t` sortiert
    pub events: Vec<NetEvent>,
}

/// Ergebnis von `net_events_list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    pub events: Vec<NetEvent>,
    /// Mehr als `limit` Treffer: nur die neuesten `limit` geliefert
    pub truncated: bool,
}

/// Eine Zeile von `net_events_summary` (gruppiert je UTC-Stunde).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummaryRow {
    pub hour_start: i64,
    pub kind: EventKind,
    pub cause: Option<LagCause>,
    pub scope: Option<OutageScope>,
    pub connection: Option<ConnectionKind>,
    pub net_id: String,
    /// Anzahl Zeilen
    pub rows: i64,
    /// Summe von `detail.count` bzw. 1 je Zeile
    pub count_sum: i64,
    /// Σ(`end_t − t`) / 1000
    pub duration_s: f64,
}

/// Bereich von `net_history_clear`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearScope {
    /// Nur `net_events`
    Events,
    /// Alle drei Verlaufstabellen
    All,
}

impl ClearScope {
    /// `"events"` | `"all"`, sonst „Unbekannter Bereich.“
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "events" => Ok(ClearScope::Events),
            "all" => Ok(ClearScope::All),
            _ => Err(BAD_SCOPE.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn texts_roundtrip_and_unknown_is_none() {
        for k in EventKind::ALL {
            assert_eq!(EventKind::parse(k.as_str()), Some(*k));
            assert_eq!(serde_json::to_value(k).unwrap(), json!(k.as_str()));
        }
        for s in OutageScope::ALL {
            assert_eq!(OutageScope::parse(s.as_str()), Some(*s));
        }
        for c in ConnectionKind::ALL {
            assert_eq!(ConnectionKind::parse(c.as_str()), Some(*c));
        }
        assert_eq!(OutageScope::HomeNetwork.as_str(), "homeNetwork");
        assert_eq!(OutageScope::TargetOnly.as_str(), "targetOnly");
        assert_eq!(EventKind::parse("nope"), None);
        assert_eq!(ConnectionKind::parse(""), None);
        assert_eq!(parse_method("icmp"), Some(PingMethod::Icmp));
        assert_eq!(parse_method("udp"), None);
        assert_eq!(method_str(PingMethod::Tcp), "tcp");
    }

    #[test]
    fn target_kind_from_id() {
        assert_eq!(TargetKind::from_target_id("aws-eu-central-1"), TargetKind::Region);
        assert_eq!(TargetKind::from_target_id("valve-cs2-fra"), TargetKind::Server);
        assert_eq!(TargetKind::from_target_id("riot-euw"), TargetKind::Server);
        assert_eq!(TargetKind::from_target_id("gateway"), TargetKind::Other);
    }

    #[test]
    fn range_and_limit_rules() {
        assert!(check_range(0, 0).is_ok());
        assert!(check_range(0, MAX_RANGE_MS).is_ok());
        assert_eq!(check_range(0, MAX_RANGE_MS + 1), Err(BAD_RANGE.to_string()));
        assert_eq!(check_range(10, 5), Err(BAD_RANGE.to_string()));
        assert_eq!(clamp_events_limit(None), 5_000);
        assert_eq!(clamp_events_limit(Some(0)), 1);
        assert_eq!(clamp_events_limit(Some(99_999)), 20_000);
        assert_eq!(ClearScope::parse("events"), Ok(ClearScope::Events));
        assert_eq!(ClearScope::parse("all"), Ok(ClearScope::All));
        assert_eq!(ClearScope::parse("x"), Err(BAD_SCOPE.to_string()));
    }

    #[test]
    fn net_event_json_shape() {
        let mut e = NetEvent::new(EventKind::Spike, 1_000);
        e.cause = Some(LagCause::LocalTraffic);
        e.detail = Some(json!({ "count": 3 }));
        e.connection = Some(ConnectionKind::Wifi);
        e.method = Some(PingMethod::Icmp);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["endT"], Value::Null);
        assert_eq!(v["kind"], "spike");
        assert_eq!(v["cause"], "localTraffic");
        assert_eq!(v["connection"], "wifi");
        assert_eq!(v["method"], "icmp");
        assert_eq!(v["netId"], "");
        assert_eq!(v["sessionId"], Value::Null);
        assert_eq!(e.count(), 3);
        assert_eq!(NetEvent::new(EventKind::Outage, 0).count(), 1);
        let back: NetEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn timeline_and_rows_json_shape() {
        let tl = SessionTimeline {
            session_id: 7,
            game_id: "g".into(),
            start: 1,
            end: 2,
            targets: vec![TimelineTarget { key: "aws-eu-central-1".into(), label: "Frankfurt".into(), method: PingMethod::Tcp }],
            target_changes: vec![TargetChange { t: 1, key: "aws-eu-central-1".into() }],
            merged: 1,
            points: vec![(1, Some(20.5), None, Some(1.0), None)],
            events: vec![],
        };
        let v = serde_json::to_value(&tl).unwrap();
        assert_eq!(v["sessionId"], 7);
        assert_eq!(v["targetChanges"][0]["key"], "aws-eu-central-1");
        assert_eq!(v["points"][0], json!([1, 20.5, null, 1.0, null]));

        let row = HourlyRow {
            hour_start: 3_600_000,
            target_key: "aws-eu-central-1".into(),
            net_id: "abc".into(),
            connection: ConnectionKind::Ethernet,
            kind: TargetKind::Region,
            label: "Frankfurt".into(),
            method: PingMethod::Icmp,
            n: 10,
            lost: 1,
            sum_rtt: 200.0,
            sum_jitter: 8.0,
            n_jitter: 8,
            max_rtt: None,
            spikes: 0,
            covered_ms: 10_000,
        };
        let v = serde_json::to_value(&row).unwrap();
        for key in ["hourStart", "targetKey", "netId", "sumRtt", "sumJitter", "nJitter", "maxRtt", "coveredMs"] {
            assert!(v.get(key).is_some(), "{key} fehlt");
        }
        assert_eq!(v["kind"], "region");

        let s = EventSummaryRow {
            hour_start: 0,
            kind: EventKind::Outage,
            cause: None,
            scope: Some(OutageScope::Internet),
            connection: None,
            net_id: String::new(),
            rows: 1,
            count_sum: 1,
            duration_s: 4.0,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["countSum"], 1);
        assert_eq!(v["durationS"], 4.0);
        assert_eq!(v["scope"], "internet");
        let page = serde_json::to_value(EventsPage { events: vec![], truncated: true }).unwrap();
        assert_eq!(page, json!({ "events": [], "truncated": true }));
    }
}
