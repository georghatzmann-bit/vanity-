//! Datentypen des Netzwerk-Bereichs (Vertrag mit `app/src/lib/types.ts`, alles camelCase).

use serde::{Deserialize, Serialize};

/// Wie gemessen wird: ICMP-Echo (klassischer Ping) oder Dauer des TCP-Verbindungsaufbaus.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PingMethod {
    Icmp,
    Tcp,
}

/// Ein Messziel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingTarget {
    pub id: String,
    pub label: String,
    /// Hostname oder IP-Adresse
    pub host: String,
    /// Nur für `tcp` (Standard 443)
    #[serde(default)]
    pub port: Option<u16>,
    pub method: PingMethod,
}

/// Ein einzelner Messwert. `rtt = None` bedeutet: Paket verloren / Zeitüberschreitung.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingSample {
    pub target_id: String,
    /// Zeitpunkt in ms seit 1970
    pub t: i64,
    /// Antwortzeit in ms
    pub rtt: Option<f64>,
}

/// Zusammenfassung über ein Messfenster.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingStats {
    pub target_id: String,
    pub last: Option<f64>,
    pub avg: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Mittlere Abweichung aufeinanderfolgender Messungen (ms)
    pub jitter: Option<f64>,
    /// Paketverlust 0.0 – 1.0
    pub loss: f64,
    pub samples: u32,
}

/// Event `net://ping` – ein Takt des Live-Monitors.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorUpdate {
    pub samples: Vec<PingSample>,
    /// Statistik über die letzten 60 Messungen je Ziel
    pub stats: Vec<PingStats>,
}

/// Eine Server-Region (Rechenzentrum), zu der gemessen werden kann.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub id: String,
    /// Anzeigename, z. B. „Frankfurt“
    pub name: String,
    /// ISO-Ländercode, z. B. „DE“
    pub country: String,
    /// "eu" | "na" | "sa" | "asia" | "oce" | "me" | "af"
    pub area: String,
    /// z. B. „AWS“, „Valve“, „Riot“
    pub provider: String,
    pub target: PingTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionPing {
    pub id: String,
    pub stats: PingStats,
}

/// Eine Station auf dem Weg zum Ziel (Event `net://trace` und Teil von [`TraceResult`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub hop: u8,
    /// IP-Adresse der Station (None = keine Antwort)
    pub address: Option<String>,
    pub hostname: Option<String>,
    /// Drei Messungen in ms (None = keine Antwort)
    pub rtts: Vec<Option<f64>>,
    /// "lan" | "isp" | "internet" | "target" – grobe Einordnung für die Anzeige
    pub zone: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub target: String,
    pub address: Option<String>,
    pub hops: Vec<TraceHop>,
    pub reached: bool,
}

/// Ergebnis eines DNS-Dienstes im Vergleich.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    pub id: String,
    pub name: String,
    pub primary: String,
    pub secondary: Option<String>,
    /// Antwortzeit für eine bekannte (zwischengespeicherte) Adresse, Median in ms
    pub cached_ms: Option<f64>,
    /// Antwortzeit für eine neue Adresse (muss nachgeschlagen werden), Median in ms
    pub uncached_ms: Option<f64>,
    pub failed: u32,
    /// Ist dieser Dienst gerade eingestellt?
    pub current: bool,
}

/// Event `net://dns`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsProgress {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsConfig {
    pub adapter_id: String,
    pub adapter: String,
    pub servers: Vec<String>,
    /// DNS kommt automatisch vom Router (DHCP)
    pub dhcp: bool,
    /// Pulsar hat den DNS geändert und kann ihn zurückstellen
    pub changed_by_pulsar: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// "ethernet" | "wifi" | "other"
    pub kind: String,
    pub up: bool,
    pub speed_mbps: Option<u64>,
    pub ipv4: Vec<String>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
    /// Hauptverbindung (hat das Standard-Gateway mit der kleinsten Metrik)
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiInfo {
    pub ssid: String,
    /// Signalqualität 0–100
    pub signal: u32,
    pub rssi: Option<i32>,
    /// "2.4" | "5" | "6"
    pub band: Option<String>,
    pub channel: Option<u32>,
    /// z. B. „Wi-Fi 6 (802.11ax)“
    pub phy: String,
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
}

/// Event `net://speed`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedProgress {
    /// "latency" | "download" | "upload" | "done"
    pub phase: String,
    /// 0.0 – 1.0 innerhalb der Phase
    pub progress: f64,
    pub mbps: Option<f64>,
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub idle_latency_ms: f64,
    pub idle_jitter_ms: f64,
    pub loaded_latency_down_ms: Option<f64>,
    pub loaded_latency_up_ms: Option<f64>,
    /// Größter Anstieg der Antwortzeit unter Last (ms)
    pub bufferbloat_ms: f64,
    /// "A+" | "A" | "B" | "C" | "D" | "F"
    pub grade: String,
    /// Messserver, z. B. „FRA“
    pub server: String,
    pub at: i64,
}
