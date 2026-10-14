//! WLAN-Scanner: alle Netze in der Nähe (`WlanScan` + `WlanGetNetworkBssList`, ohne Adminrechte)
//! und WLAN-Zustand mit 24H2-Standortsperre. Vertrag: `docs/API.md`, „WLAN-Scanner und Raum-Scan“.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; der Scan liefert noch eine leere Liste,
//! der Zustand kommt aus `adapters::wifi()` (Umsetzung: F5).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::types::WifiInfo;
use crate::error::CmdResult;
use crate::state::Shared;

/// `backend.wifiLocked`
pub const WIFI_LOCKED: &str = "WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei. Bitte unter Einstellungen › Datenschutz und Sicherheit › Standort die Standortdienste und „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.";

/// Ein WLAN-Netz (BSS) aus dem Scan – nur im Speicher, nie gespeichert oder exportiert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    /// `""` = verstecktes Netz
    pub ssid: String,
    /// `aa:bb:cc:dd:ee:ff`
    pub bssid: String,
    /// dBm
    pub rssi: i32,
    /// Qualität 0–100
    pub signal: u32,
    pub channel: u32,
    /// "2.4" | "5" | "6"
    pub band: String,
    pub center_khz: u32,
    /// 20/40/80/160/320 oder `None`
    pub width_mhz: Option<u16>,
    pub phy: String,
    pub secured: bool,
    pub connected: bool,
    pub age_s: Option<u32>,
}

/// Ergebnis von `net_wifi_scan`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiScan {
    pub at: i64,
    /// `true` = nach einem aktiven Scan gelesen, `false` = Windows-Zwischenspeicher
    pub fresh: bool,
    pub interfaces: u32,
    pub networks: Vec<WifiNetwork>,
}

impl WifiScan {
    /// Leeres Ergebnis (kein WLAN-Dienst, keine Schnittstelle, außerhalb von Windows).
    pub fn empty(at: i64) -> Self {
        WifiScan { at, fresh: false, interfaces: 0, networks: Vec::new() }
    }
}

/// Zustand der WLAN-Verbindung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WifiStateKind {
    Connected,
    NotConnected,
    NoService,
    Locked,
}

/// Ergebnis von `net_wifi_state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiStateInfo {
    pub state: WifiStateKind,
    pub wifi: Option<WifiInfo>,
}

/// Serialisiert aktive Scans (`refresh = true`): ein zweiter Aufruf wartet und bekommt dasselbe
/// Ergebnis. Liegt in `NetState.wifi_scan`.
#[derive(Debug, Default)]
pub struct ScanGate {
    pub active: tokio::sync::Mutex<()>,
    /// Ergebnis des letzten aktiven Scans
    pub last: std::sync::Mutex<Option<WifiScan>>,
}

/// `net_wifi_scan(refresh)`.
pub async fn scan(core: Shared, refresh: bool) -> CmdResult<WifiScan> {
    let _ = (core, refresh);
    Ok(WifiScan::empty(crate::util::now_ms()))
}

/// `net_wifi_state()`. Außerhalb von Windows `noService`.
pub async fn state() -> CmdResult<WifiStateInfo> {
    #[cfg(windows)]
    {
        let wifi = crate::error::blocking(super::adapters::wifi).await?;
        let state = if wifi.is_some() { WifiStateKind::Connected } else { WifiStateKind::NotConnected };
        Ok(WifiStateInfo { state, wifi })
    }
    #[cfg(not(windows))]
    {
        Ok(WifiStateInfo { state: WifiStateKind::NoService, wifi: None })
    }
}
