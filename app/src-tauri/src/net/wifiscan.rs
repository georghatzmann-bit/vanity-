//! WLAN-Scanner: alle Netze in der Nähe (`WlanScan` + `WlanGetNetworkBssList`, ohne Adminrechte)
//! und WLAN-Zustand mit 24H2-Standortsperre. Vertrag: `docs/API.md`, „WLAN-Scanner und Raum-Scan“.
//!
//! Datenschutz: SSIDs und BSSIDs fremder Netze bleiben nur im Speicher (Rückgabe an die
//! Oberfläche) – nie gespeichert, nie geloggt.
//!
//! Die Zuordnungen (Kanal, Kanalbreite aus den Informationselementen, Fehlerarten, Doppelte) sind
//! reine Funktionen und werden auch unter Linux getestet. Außerhalb von Windows liefert der Scan
//! eine leere Liste und der Zustand `noService`.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::adapters;
use super::types::WifiInfo;
use crate::error::{CmdResult, LockExt};
use crate::state::Shared;

/// `backend.wifiLocked`
pub const WIFI_LOCKED: &str = "WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei. Bitte unter Einstellungen › Datenschutz und Sicherheit › Standort die Standortdienste und „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.";

/// Höchstens so viele Netze in der Liste (nach RSSI absteigend).
pub const MAX_NETWORKS: usize = 512;
/// Nach `WlanScan` höchstens so lange auf das Ende des Scans warten (ms).
pub const SCAN_WAIT_MS: u64 = 4_000;
/// Gesamtzeit eines aktiven Scans höchstens (ms) – Grundlage der Ruhezeit.
pub const SCAN_MAX_MS: i64 = 6_000;
/// Ruhezeit nach einem aktiven Scan (ms).
pub const QUIET_AFTER_MS: i64 = 2_000;

const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_SERVICE_DISABLED: u32 = 1058;
const ERROR_SERVICE_NOT_ACTIVE: u32 = 1062;
const ERROR_SERVICE_DEPENDENCY_FAIL: u32 = 1068;

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

impl From<adapters::WifiState> for WifiStateInfo {
    fn from(s: adapters::WifiState) -> Self {
        let state = s.kind();
        WifiStateInfo { state, wifi: s.into_info() }
    }
}

// ---------------------------------------------------------------------------------------------
// Reine Zuordnungen
// ---------------------------------------------------------------------------------------------

/// Win32-Fehlercode einer `wlanapi`-Funktion → Art des Zustands.
/// 1058/1062/1068 (Dienst deaktiviert/nicht gestartet/abhängiger Dienst fehlt) → `NoService`,
/// 5 (`ERROR_ACCESS_DENIED`, 24H2-Standortsperre) → `Locked`, sonst `NotConnected`.
pub fn wlan_error_kind(code: u32) -> WifiStateKind {
    match code {
        ERROR_SERVICE_DISABLED | ERROR_SERVICE_NOT_ACTIVE | ERROR_SERVICE_DEPENDENCY_FAIL => WifiStateKind::NoService,
        ERROR_ACCESS_DENIED => WifiStateKind::Locked,
        _ => WifiStateKind::NotConnected,
    }
}

/// Fehlertext für einen gesperrten Zugriff (`ERROR_ACCESS_DENIED`), sonst `None`.
pub fn locked_error(code: u32) -> Option<String> {
    (wlan_error_kind(code) == WifiStateKind::Locked).then(|| WIFI_LOCKED.to_string())
}

/// Kanalnummer aus der Mittenfrequenz (kHz). 2,4 GHz: 1–14; 5 GHz: (MHz − 5000) / 5;
/// 6 GHz: (MHz − 5950) / 5, Sonderfall 5935 MHz → Kanal 2.
pub fn channel_from_khz(khz: u32) -> Option<u32> {
    let mhz = khz / 1000;
    match mhz {
        2484 => Some(14),
        2412..=2472 if (mhz - 2407).is_multiple_of(5) => Some((mhz - 2407) / 5),
        5935 => Some(2),
        5150..=5925 if mhz.is_multiple_of(5) => Some((mhz - 5000) / 5),
        5955..=7115 if (mhz - 5950).is_multiple_of(5) => Some((mhz - 5950) / 5),
        _ => None,
    }
}

/// BSSID als Text `aa:bb:cc:dd:ee:ff`.
pub fn bssid_text(b: &[u8; 6]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":")
}

/// Verschlüsselt? (Capability-Bit 0x0010 „Privacy“)
pub fn secured(capability: u16) -> bool {
    capability & 0x0010 != 0
}

/// Liegen die Informationselemente vollständig im Windows-Puffer?
/// `entry_offset` = Abstand des Eintrags vom Anfang der Liste, `total` = `dwTotalSize`.
pub fn ie_in_bounds(entry_offset: usize, ie_offset: u32, ie_size: u32, total: u32) -> bool {
    if ie_size == 0 {
        return false;
    }
    entry_offset
        .checked_add(ie_offset as usize)
        .and_then(|x| x.checked_add(ie_size as usize))
        .is_some_and(|end| end <= total as usize)
}

/// Sekunden seit dem letzten Empfang aus `ullHostTimestamp` (FILETIME, 100 ns seit 1601).
/// `None`, wenn nicht lesbar (0, deutlich in der Zukunft oder älter als ein Tag).
pub fn age_from_host_ts(host_ts: u64, now_ms: i64) -> Option<u32> {
    if host_ts == 0 || now_ms <= 0 {
        return None;
    }
    let now_ft = (now_ms as u64).checked_add(11_644_473_600_000)?.checked_mul(10_000)?;
    // Kleine Uhr-Abweichungen (bis 5 s) gelten als „gerade eben“
    if host_ts > now_ft {
        return (host_ts - now_ft <= 50_000_000).then_some(0);
    }
    let age = (now_ft - host_ts) / 10_000_000;
    (age <= 86_400).then_some(age as u32)
}

/// Breite aus den Feldern einer VHT-Operation (Breite, CCFS0, CCFS1).
fn vht_width(width: u8, ccfs0: u8, ccfs1: u8) -> Option<u16> {
    match width {
        0 => None, // 20/40 MHz → HT entscheidet
        1 if ccfs1 == 0 => Some(80),
        1 if ccfs0.abs_diff(ccfs1) == 8 => Some(160),
        1 => Some(160),     // 80+80 MHz: belegt wie 160 MHz
        2 | 3 => Some(160), // veraltete Werte (160 bzw. 80+80)
        _ => None,
    }
}

/// Kanalbreite (MHz) aus den Informationselementen eines Beacons: HT Operation (61),
/// VHT Operation (192), HE Operation (255/36, 6-GHz-Info und VHT-Info) und EHT Operation (255/106).
/// Jedes Längenbyte wird geprüft; ein Element, das über das Ende hinausragt, macht das Ergebnis
/// `None` (Puffer unzuverlässig). Kein bekanntes Element → `None` (unbekannt).
pub fn parse_width(ies: &[u8]) -> Option<u16> {
    let mut ht: Option<u16> = None;
    let mut vht: Option<u16> = None;
    let mut he: Option<u16> = None;
    let mut eht: Option<u16> = None;
    let mut i = 0usize;
    while i < ies.len() {
        let id = ies[i];
        let len = *ies.get(i + 1)? as usize;
        let start = i + 2;
        let end = start.checked_add(len)?;
        let data = ies.get(start..end)?;
        match id {
            // HT Operation: Byte 1 Bit 0–1 Lage des Zweitkanals, Bit 2 „jede Breite erlaubt“
            61 if data.len() >= 22 => {
                let info = data[1];
                ht = Some(if info & 0x03 != 0 && info & 0x04 != 0 { 40 } else { 20 });
            }
            192 if data.len() >= 5 => {
                vht = vht_width(data[0], data[1], data[2]).or(vht);
            }
            255 if !data.is_empty() => match data[0] {
                // HE Operation: Ext-ID, Parameter (3), BSS-Farbe (1), Basis-MCS (2), dann optional
                // VHT-Info (3, Bit 14), Co-Hosted-BSSID (1, Bit 15), 6-GHz-Info (5, Bit 17)
                36 if data.len() >= 7 => {
                    let params = u32::from(data[1]) | (u32::from(data[2]) << 8) | (u32::from(data[3]) << 16);
                    let mut p = 7usize;
                    if params & (1 << 14) != 0 {
                        if let Some(v) = data.get(p..p + 3) {
                            he = vht_width(v[0], v[1], v[2]).or(he);
                        }
                        p += 3;
                    }
                    if params & (1 << 15) != 0 {
                        p += 1;
                    }
                    if params & (1 << 17) != 0 {
                        if let Some(six) = data.get(p..p + 5) {
                            he = Some(match six[1] & 0x03 {
                                0 => 20,
                                1 => 40,
                                2 => 80,
                                _ => 160,
                            });
                        }
                    }
                }
                // EHT Operation: Ext-ID, Parameter (1), Basis-MCS (4), dann optional Info (3, Bit 0)
                106 if data.len() >= 6 && data[1] & 0x01 != 0 => {
                    if let Some(info) = data.get(6..9) {
                        eht = match info[0] & 0x07 {
                            0 => Some(20),
                            1 => Some(40),
                            2 => Some(80),
                            3 => Some(160),
                            4 => Some(320),
                            _ => eht,
                        };
                    }
                }
                _ => {}
            },
            _ => {}
        }
        i = end;
    }
    eht.or(he).or(vht).or(ht)
}

/// Rohdaten eines `WLAN_BSS_ENTRY` (einzeln gelesene Felder).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawBss {
    pub ssid: Vec<u8>,
    pub bssid: [u8; 6],
    pub rssi: i32,
    pub quality: u32,
    /// `DOT11_PHY_TYPE`
    pub phy: i32,
    pub capability: u16,
    pub center_khz: u32,
    pub width_mhz: Option<u16>,
    pub host_ts: u64,
}

/// Rohdaten → Netz für die Liste (`None` bei unbekanntem Band, z. B. 60 GHz).
pub fn build_network(raw: &RawBss, connected_bssids: &[[u8; 6]], now_ms: i64) -> Option<WifiNetwork> {
    let band = adapters::band_from_khz(raw.center_khz)?;
    let channel = channel_from_khz(raw.center_khz)?;
    let rssi = if raw.rssi < 0 { raw.rssi } else { adapters::rssi_from_quality(raw.quality) };
    Some(WifiNetwork {
        ssid: String::from_utf8_lossy(&raw.ssid).into_owned(),
        bssid: bssid_text(&raw.bssid),
        rssi,
        signal: raw.quality.min(100),
        channel,
        band: band.to_string(),
        center_khz: raw.center_khz,
        width_mhz: raw.width_mhz,
        phy: adapters::phy_name(raw.phy),
        secured: secured(raw.capability),
        connected: connected_bssids.contains(&raw.bssid),
        age_s: age_from_host_ts(raw.host_ts, now_ms),
    })
}

/// Gleiche BSSID auf mehreren Schnittstellen → der stärkste Eintrag (verbunden bleibt verbunden);
/// höchstens 512 Netze, nach RSSI absteigend.
pub fn dedupe_strongest(list: Vec<WifiNetwork>) -> Vec<WifiNetwork> {
    let mut by_bssid: HashMap<String, WifiNetwork> = HashMap::new();
    for n in list {
        match by_bssid.get_mut(&n.bssid) {
            Some(old) => {
                let connected = old.connected || n.connected;
                if n.rssi > old.rssi {
                    *old = n;
                }
                old.connected = connected;
            }
            None => {
                by_bssid.insert(n.bssid.clone(), n);
            }
        }
    }
    let mut out: Vec<WifiNetwork> = by_bssid.into_values().collect();
    out.sort_by(|a, b| b.rssi.cmp(&a.rssi).then_with(|| a.bssid.cmp(&b.bssid)));
    out.truncate(MAX_NETWORKS);
    out
}

// ---------------------------------------------------------------------------------------------
// Gleichzeitigkeit und Ruhezeit
// ---------------------------------------------------------------------------------------------

/// Serialisiert aktive Scans (`refresh = true`): ein zweiter Aufruf wartet und bekommt dasselbe
/// Ergebnis. Liegt in `NetState.wifi_scan`.
#[derive(Debug, Default)]
pub struct ScanGate {
    active: tokio::sync::Mutex<()>,
    /// Zähler abgeschlossener aktiver Scans
    done: AtomicU64,
    /// Ergebnis des letzten aktiven Scans
    last: std::sync::Mutex<Option<CmdResult<WifiScan>>>,
}

impl ScanGate {
    /// Führt `run` aus – außer, während des Wartens auf die Sperre wurde ein anderer aktiver Scan
    /// fertig: dann dessen Ergebnis.
    pub async fn run<F, Fut>(&self, run: F) -> CmdResult<WifiScan>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = CmdResult<WifiScan>>,
    {
        let seen = self.done.load(Ordering::SeqCst);
        let _guard = self.active.lock().await;
        if self.done.load(Ordering::SeqCst) != seen {
            if let Some(shared) = self.last.lock_safe().clone() {
                return shared;
            }
        }
        let result = run().await;
        *self.last.lock_safe() = Some(result.clone());
        self.done.fetch_add(1, Ordering::SeqCst);
        result
    }
}

/// Ruhezeit für einen aktiven Scan beginnen: bis höchstens `now + 6 s + 2 s` (nie kürzer als eine
/// schon gesetzte Ruhezeit, z. B. vom Speedtest). Liefert den gesetzten Wert.
pub fn quiet_begin(quiet: &AtomicI64, now: i64) -> i64 {
    let until = now + SCAN_MAX_MS + QUIET_AFTER_MS;
    quiet.fetch_max(until, Ordering::SeqCst);
    until
}

/// Ruhezeit nach dem Scan auf „Ende + 2 s“ verkürzen – nur, wenn niemand sie inzwischen
/// verlängert hat.
pub fn quiet_end(quiet: &AtomicI64, began: i64, end: i64) {
    let until = end + QUIET_AFTER_MS;
    if quiet.compare_exchange(began, until.min(began), Ordering::SeqCst, Ordering::SeqCst).is_err() {
        quiet.fetch_max(until, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------------------------

/// `net_wifi_scan(refresh)`. `refresh = false` liest sofort den Windows-Zwischenspeicher;
/// `refresh = true` scannt aktiv (serialisiert, mit Ruhezeit) – nie, solange ein Spiel läuft.
pub async fn scan(core: Shared, refresh: bool) -> CmdResult<WifiScan> {
    // Ein aktiver Scan kann auf manchen Treibern kurz den Ping erhöhen: nie während eines Spiels
    let refresh = refresh && core.tracker.running().is_empty();
    if !refresh {
        return crate::error::blocking(|| scan_blocking(false)).await;
    }
    let gate_core = core.clone();
    gate_core
        .net
        .wifi_scan
        .run(|| async move {
            let began = quiet_begin(&core.net.quiet_until, crate::util::now_ms());
            let result = crate::error::blocking(|| scan_blocking(true)).await;
            quiet_end(&core.net.quiet_until, began, crate::util::now_ms());
            result
        })
        .await
}

/// `net_wifi_state()`. Außerhalb von Windows `noService`.
pub async fn state() -> CmdResult<WifiStateInfo> {
    crate::error::blocking(|| Ok(WifiStateInfo::from(adapters::wifi_state()))).await
}

#[cfg(not(windows))]
fn scan_blocking(_refresh: bool) -> CmdResult<WifiScan> {
    Ok(WifiScan::empty(crate::util::now_ms()))
}

#[cfg(windows)]
fn scan_blocking(refresh: bool) -> CmdResult<WifiScan> {
    win::scan(refresh)
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::ptr::addr_of;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use windows::core::GUID;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WiFi::{
        dot11_BSS_type_any, wlan_interface_state_connected, wlan_intf_opcode_current_connection,
        wlan_notification_acm_scan_complete, wlan_notification_acm_scan_fail, WlanCloseHandle, WlanEnumInterfaces,
        WlanFreeMemory, WlanGetNetworkBssList, WlanOpenHandle, WlanQueryInterface, WlanRegisterNotification,
        WlanScan, DOT11_SSID, L2_NOTIFICATION_DATA, WLAN_BSS_ENTRY, WLAN_BSS_LIST, WLAN_CONNECTION_ATTRIBUTES,
        WLAN_INTERFACE_INFO, WLAN_INTERFACE_INFO_LIST, WLAN_NOTIFICATION_SOURCE_ACM, WLAN_NOTIFICATION_SOURCE_NONE,
    };

    use super::*;

    /// Schließt das Handle beim Verlassen (auch bei frühem `return`). `WlanCloseHandle` wartet
    /// laut Dokumentation, bis laufende Rückrufe fertig sind.
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: Handle stammt aus WlanOpenHandle und wird genau einmal geschlossen.
            unsafe {
                let _ = WlanCloseHandle(self.0, None);
            }
        }
    }

    /// Zähler abgeschlossener Scans (für den Rückruf von `WlanRegisterNotification`).
    #[derive(Default)]
    struct ScanDone {
        done: Mutex<u32>,
        cv: Condvar,
    }

    unsafe extern "system" fn on_notify(data: *mut L2_NOTIFICATION_DATA, ctx: *mut c_void) {
        if data.is_null() || ctx.is_null() {
            return;
        }
        // SAFETY: `data` kommt von Windows; `ctx` zeigt auf das `ScanDone` aus `scan`, das bis nach
        // dem Abmelden und `WlanCloseHandle` lebt.
        let (source, code) = unsafe {
            (addr_of!((*data).NotificationSource).read_unaligned(), addr_of!((*data).NotificationCode).read_unaligned())
        };
        if source != WLAN_NOTIFICATION_SOURCE_ACM {
            return;
        }
        let code = code as i32;
        if code == wlan_notification_acm_scan_complete.0 || code == wlan_notification_acm_scan_fail.0 {
            let state = unsafe { &*(ctx as *const ScanDone) };
            *state.done.lock_safe() += 1;
            state.cv.notify_all();
        }
    }

    /// Schnittstellen (GUID, verbunden?).
    unsafe fn interfaces(h: HANDLE) -> Result<Vec<(GUID, bool)>, u32> {
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        let ret = unsafe { WlanEnumInterfaces(h, None, &mut list) };
        if ret != 0 || list.is_null() {
            return Err(ret);
        }
        let mut out = Vec::new();
        // SAFETY: Liste kommt von Windows; Felder einzeln und ohne Ausrichtungsannahme gelesen.
        unsafe {
            let count = addr_of!((*list).dwNumberOfItems).read_unaligned() as usize;
            let first = addr_of!((*list).InterfaceInfo) as *const WLAN_INTERFACE_INFO;
            for i in 0..count.min(64) {
                let p = first.add(i);
                let guid = addr_of!((*p).InterfaceGuid).read_unaligned();
                let st = addr_of!((*p).isState).read_unaligned();
                out.push((guid, st == wlan_interface_state_connected));
            }
            WlanFreeMemory(list as *const c_void);
        }
        Ok(out)
    }

    /// BSSID der aktuellen Verbindung einer Schnittstelle (Fehler → `None`).
    unsafe fn connected_bssid(h: HANDLE, guid: &GUID) -> Option<[u8; 6]> {
        let mut size = 0u32;
        let mut data: *mut c_void = std::ptr::null_mut();
        let ret =
            unsafe { WlanQueryInterface(h, guid, wlan_intf_opcode_current_connection, None, &mut size, &mut data, None) };
        if ret != 0 || data.is_null() {
            return None;
        }
        let out = if (size as usize) >= std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>() {
            let p = data as *const WLAN_CONNECTION_ATTRIBUTES;
            // SAFETY: Puffer ist groß genug; das Feld ist ein Byte-Feld ohne Gültigkeitsregeln.
            Some(unsafe { addr_of!((*p).wlanAssociationAttributes.dot11Bssid).read_unaligned() })
        } else {
            None
        };
        unsafe { WlanFreeMemory(data) };
        out
    }

    /// Alle Einträge einer BSS-Liste lesen – Feld für Feld, nie die ganze Struktur (`bInRegDomain`
    /// ist ein Rust-`bool`; ein Byte ≠ 0/1 wäre undefiniertes Verhalten).
    unsafe fn read_bss_list(list: *const WLAN_BSS_LIST) -> Vec<RawBss> {
        let mut out = Vec::new();
        let start = list as *const u8;
        // SAFETY: Kopf der Liste liegt im Windows-Puffer.
        let (total, n) = unsafe {
            (addr_of!((*list).dwTotalSize).read_unaligned(), addr_of!((*list).dwNumberOfItems).read_unaligned() as usize)
        };
        let entries = unsafe { addr_of!((*list).wlanBssEntries) } as *const WLAN_BSS_ENTRY;
        let header = entries as usize - start as usize;
        let entry_size = std::mem::size_of::<WLAN_BSS_ENTRY>();
        // Nur so viele Einträge, wie laut dwTotalSize wirklich im Puffer liegen
        let fits = (total as usize).saturating_sub(header) / entry_size;
        for j in 0..n.min(fits) {
            // SAFETY: Eintrag j liegt laut dwTotalSize im Puffer; Felder einzeln gelesen, die
            // Informationselemente nur nach der Grenzprüfung.
            unsafe {
                let p = entries.add(j);
                let base = p as *const u8;
                let ssid: DOT11_SSID = addr_of!((*p).dot11Ssid).read_unaligned();
                let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
                let ie_offset = addr_of!((*p).ulIeOffset).read_unaligned();
                let ie_size = addr_of!((*p).ulIeSize).read_unaligned();
                let entry_offset = base as usize - start as usize;
                let width_mhz = if ie_in_bounds(entry_offset, ie_offset, ie_size, total) {
                    let ies = std::slice::from_raw_parts(base.add(ie_offset as usize), ie_size as usize);
                    parse_width(ies)
                } else {
                    None
                };
                out.push(RawBss {
                    ssid: ssid.ucSSID[..len].to_vec(),
                    bssid: addr_of!((*p).dot11Bssid).read_unaligned(),
                    rssi: addr_of!((*p).lRssi).read_unaligned(),
                    quality: addr_of!((*p).uLinkQuality).read_unaligned(),
                    phy: addr_of!((*p).dot11BssPhyType).read_unaligned().0,
                    capability: addr_of!((*p).usCapabilityInformation).read_unaligned(),
                    center_khz: addr_of!((*p).ulChCenterFrequency).read_unaligned(),
                    width_mhz,
                    host_ts: addr_of!((*p).ullHostTimestamp).read_unaligned(),
                });
            }
        }
        out
    }

    /// Wartet höchstens bis `deadline`, bis `want` Scans fertig gemeldet sind.
    fn wait_for(done: &ScanDone, want: u32, deadline: Instant) {
        let mut finished = done.done.lock_safe();
        while *finished < want {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            finished = match done.cv.wait_timeout(finished, left) {
                Ok((g, _)) => g,
                Err(p) => p.into_inner().0,
            };
        }
    }

    pub fn scan(refresh: bool) -> CmdResult<WifiScan> {
        let started = Instant::now();
        // Vor dem Handle angelegt: wird erst nach dem Schließen freigegeben (Rückruf-Kontext)
        let done = Arc::new(ScanDone::default());
        let mut negotiated = 0u32;
        let mut raw_handle = HANDLE::default();
        // SAFETY: Aufrufe nach wlanapi-Dokumentation; Speicher wird mit WlanFreeMemory freigegeben,
        // das Handle über `Handle` geschlossen.
        let ret = unsafe { WlanOpenHandle(2, None, &mut negotiated, &mut raw_handle) };
        if ret != 0 {
            return match locked_error(ret) {
                Some(e) => Err(e),
                None => Ok(WifiScan::empty(crate::util::now_ms())),
            };
        }
        let handle = Handle(raw_handle);
        let h = handle.0;
        let ifaces = match unsafe { interfaces(h) } {
            Ok(list) => list,
            Err(code) => {
                return match locked_error(code) {
                    Some(e) => Err(e),
                    None => Ok(WifiScan::empty(crate::util::now_ms())),
                }
            }
        };
        if ifaces.is_empty() {
            return Ok(WifiScan::empty(crate::util::now_ms()));
        }

        let mut fresh = false;
        if refresh {
            let ctx = Arc::as_ptr(&done) as *const c_void;
            let registered = unsafe {
                WlanRegisterNotification(h, WLAN_NOTIFICATION_SOURCE_ACM, true, Some(on_notify), Some(ctx), None, None)
            } == 0;
            let mut started_scans = 0u32;
            for (guid, _) in &ifaces {
                if unsafe { WlanScan(h, guid, None, None, None) } == 0 {
                    started_scans += 1;
                }
            }
            if started_scans > 0 {
                // Schlägt nur WlanScan fehl, bleibt es beim Zwischenspeicher (fresh = false)
                fresh = true;
                let deadline = Instant::now() + Duration::from_millis(SCAN_WAIT_MS);
                if registered {
                    wait_for(&done, started_scans, deadline);
                } else {
                    std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
                }
            }
            if registered {
                unsafe {
                    let _ = WlanRegisterNotification(h, WLAN_NOTIFICATION_SOURCE_NONE, true, None, None, None, None);
                }
            }
        }

        let now = crate::util::now_ms();
        let mut connected: Vec<[u8; 6]> = Vec::new();
        let mut all = Vec::new();
        let mut locked = 0usize;
        for (guid, is_connected) in &ifaces {
            if *is_connected {
                if let Some(b) = unsafe { connected_bssid(h, guid) } {
                    connected.push(b);
                }
            }
            let mut list: *mut WLAN_BSS_LIST = std::ptr::null_mut();
            let ret = unsafe { WlanGetNetworkBssList(h, guid, None, dot11_BSS_type_any, false, None, &mut list) };
            if ret != 0 || list.is_null() {
                if wlan_error_kind(ret) == WifiStateKind::Locked {
                    locked += 1;
                }
                continue;
            }
            let raw = unsafe { read_bss_list(list) };
            unsafe { WlanFreeMemory(list as *const c_void) };
            all.extend(raw);
            if started.elapsed() > Duration::from_millis(SCAN_MAX_MS as u64) {
                break;
            }
        }
        drop(handle);
        if locked == ifaces.len() {
            return Err(WIFI_LOCKED.to_string());
        }
        let networks = dedupe_strongest(all.iter().filter_map(|r| build_network(r, &connected, now)).collect());
        Ok(WifiScan { at: now, fresh, interfaces: ifaces.len() as u32, networks })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn channel_from_khz_all_bands() {
        assert_eq!(channel_from_khz(2_412_000), Some(1));
        assert_eq!(channel_from_khz(2_437_000), Some(6));
        assert_eq!(channel_from_khz(2_462_000), Some(11));
        assert_eq!(channel_from_khz(2_472_000), Some(13));
        assert_eq!(channel_from_khz(2_484_000), Some(14));
        assert_eq!(channel_from_khz(5_180_000), Some(36));
        assert_eq!(channel_from_khz(5_220_000), Some(44));
        assert_eq!(channel_from_khz(5_500_000), Some(100));
        assert_eq!(channel_from_khz(5_745_000), Some(149));
        assert_eq!(channel_from_khz(5_825_000), Some(165));
        assert_eq!(channel_from_khz(5_935_000), Some(2), "Sonderfall 6-GHz-Kanal 2");
        assert_eq!(channel_from_khz(5_955_000), Some(1));
        assert_eq!(channel_from_khz(6_135_000), Some(37));
        assert_eq!(channel_from_khz(6_415_000), Some(93));
        assert_eq!(channel_from_khz(7_115_000), Some(233));
        assert_eq!(channel_from_khz(0), None);
        assert_eq!(channel_from_khz(2_413_000), None, "kein Kanalraster");
        assert_eq!(channel_from_khz(60_480_000), None);
        // Band passt zum Kanal
        assert_eq!(adapters::band_from_khz(5_935_000), Some("6"));
        assert_eq!(adapters::band_from_khz(5_925_000), Some("5"));
        assert_eq!(bssid_text(&[0x3c, 0xa6, 0x2f, 0x0a, 0x00, 0xff]), "3c:a6:2f:0a:00:ff");
    }

    fn ht(info: u8) -> Vec<u8> {
        let mut v = vec![61, 22, 6, info];
        v.extend([0u8; 20]);
        v
    }

    #[test]
    fn parse_width_ht_vht_he_eht() {
        // Nur HT: 20 bzw. 40 MHz (Zweitkanal oben + jede Breite erlaubt)
        assert_eq!(parse_width(&ht(0x00)), Some(20));
        assert_eq!(parse_width(&ht(0x05)), Some(40));
        assert_eq!(parse_width(&ht(0x01)), Some(20), "Zweitkanal ohne Breiten-Bit");
        // VHT 80 MHz (CCFS1 = 0) überstimmt HT 40
        let mut v = ht(0x05);
        v.extend([192, 5, 1, 42, 0, 0, 0]);
        assert_eq!(parse_width(&v), Some(80));
        // VHT 160 MHz (CCFS1 − CCFS0 = 8)
        assert_eq!(parse_width(&[192, 5, 1, 42, 50, 0, 0]), Some(160));
        // VHT width 0 → HT entscheidet
        let mut v = ht(0x07);
        v.extend([192, 5, 0, 0, 0, 0, 0]);
        assert_eq!(parse_width(&v), Some(40));
        // HE mit 6-GHz-Info (Bit 17), Breite 2 → 80 MHz
        let he6 = [255u8, 12, 36, 0x00, 0x00, 0x02, 0, 0, 0, 37, 0x02, 39, 0, 0];
        assert_eq!(parse_width(&he6), Some(80));
        // HE mit VHT-Info (Bit 14) 160 MHz
        let he_vht = [255u8, 10, 36, 0x00, 0x40, 0x00, 0, 0, 0, 1, 42, 50];
        assert_eq!(parse_width(&he_vht), Some(160));
        // EHT mit Info, Breite 4 → 320 MHz (überstimmt HE 160)
        let mut v = he_vht.to_vec();
        v.extend([255, 9, 106, 0x01, 0, 0, 0, 0, 0x04, 31, 63]);
        assert_eq!(parse_width(&v), Some(320));
        // Unbekannte Elemente (SSID, Raten) werden übersprungen
        let mut v = vec![0u8, 3, b'a', b'b', b'c', 1, 2, 0x82, 0x84];
        v.extend(ht(0x07));
        assert_eq!(parse_width(&v), Some(40));
        // Keine Breitenangabe
        assert_eq!(parse_width(&[0, 1, b'x']), None);
        assert_eq!(parse_width(&[]), None);
    }

    #[test]
    fn parse_width_bad_lengths_none() {
        // Längenbyte ragt über das Ende
        assert_eq!(parse_width(&[61, 22, 6, 0x05]), None);
        assert_eq!(parse_width(&[0, 200, 1, 2, 3]), None);
        // Element ohne Längenbyte am Ende
        let mut v = ht(0x05);
        v.push(192);
        assert_eq!(parse_width(&v), None);
        // Zu kurze Elemente werden nicht gelesen
        assert_eq!(parse_width(&[61, 2, 6, 0x05]), None, "HT kürzer als 22");
        assert_eq!(parse_width(&[192, 2, 1, 42]), None, "VHT kürzer als 5");
        // HE: 6-GHz-Info angekündigt, fehlt aber
        assert_eq!(parse_width(&[255, 7, 36, 0x00, 0x00, 0x02, 0, 0, 0]), None);
        // EHT: Info angekündigt, fehlt aber
        assert_eq!(parse_width(&[255, 6, 106, 0x01, 0, 0, 0, 0]), None);
        assert_eq!(parse_width(&[255, 0]), None);
    }

    #[test]
    fn ie_bounds_check() {
        assert!(ie_in_bounds(8, 400, 100, 508));
        assert!(!ie_in_bounds(8, 400, 101, 508), "ein Byte zu viel");
        assert!(!ie_in_bounds(8, 400, 0, 508), "leer");
        assert!(!ie_in_bounds(usize::MAX, 1, 1, 508), "Überlauf");
        assert!(!ie_in_bounds(8, u32::MAX, u32::MAX, u32::MAX));
        assert!(ie_in_bounds(368, 360, 24, 752));
    }

    #[test]
    fn secured_bit() {
        assert!(secured(0x0011));
        assert!(secured(0x0431));
        assert!(!secured(0x0401));
        assert!(!secured(0));
    }

    fn net(bssid: &str, rssi: i32, connected: bool) -> WifiNetwork {
        WifiNetwork {
            ssid: "Netz".into(),
            bssid: bssid.into(),
            rssi,
            signal: 50,
            channel: 6,
            band: "2.4".into(),
            center_khz: 2_437_000,
            width_mhz: None,
            phy: "Wi-Fi 6 (802.11ax)".into(),
            secured: true,
            connected,
            age_s: None,
        }
    }

    #[test]
    fn dedupe_strongest_bssid() {
        let list = vec![
            net("aa:00:00:00:00:01", -70, true),
            net("aa:00:00:00:00:02", -50, false),
            net("aa:00:00:00:00:01", -60, false),
            net("aa:00:00:00:00:03", -80, false),
        ];
        let out = dedupe_strongest(list);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].bssid, "aa:00:00:00:00:02");
        assert_eq!(out[1].bssid, "aa:00:00:00:00:01");
        assert_eq!(out[1].rssi, -60, "stärkster Eintrag");
        assert!(out[1].connected, "verbunden bleibt verbunden");
        assert_eq!(out[2].rssi, -80);
        // Grenze 512
        let many: Vec<WifiNetwork> =
            (0..600).map(|i| net(&format!("bb:00:00:00:{:02x}:{:02x}", i / 256, i % 256), -40 - (i % 50), false)).collect();
        let out = dedupe_strongest(many);
        assert_eq!(out.len(), MAX_NETWORKS);
        assert!(out.windows(2).all(|w| w[0].rssi >= w[1].rssi), "nach RSSI absteigend");
    }

    #[test]
    fn wlan_error_kind_codes() {
        assert_eq!(wlan_error_kind(1062), WifiStateKind::NoService);
        assert_eq!(wlan_error_kind(1068), WifiStateKind::NoService);
        assert_eq!(wlan_error_kind(1058), WifiStateKind::NoService);
        assert_eq!(wlan_error_kind(5), WifiStateKind::Locked);
        assert_eq!(wlan_error_kind(0), WifiStateKind::NotConnected);
        assert_eq!(wlan_error_kind(87), WifiStateKind::NotConnected);
    }

    #[test]
    fn access_denied_text() {
        assert_eq!(locked_error(5).as_deref(), Some(WIFI_LOCKED));
        assert_eq!(locked_error(1062), None);
        assert!(WIFI_LOCKED.starts_with("WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei."));
        assert!(WIFI_LOCKED.contains("Einstellungen › Datenschutz und Sicherheit › Standort"));
        assert!(WIFI_LOCKED.ends_with("einschalten."));
        // Zustand und JSON-Form
        let v = serde_json::to_value(WifiStateInfo { state: WifiStateKind::Locked, wifi: None }).unwrap();
        assert_eq!(v["state"], "locked");
        assert!(v["wifi"].is_null());
        let v = serde_json::to_value(WifiStateInfo::from(adapters::WifiState::NotConnected)).unwrap();
        assert_eq!(v["state"], "notConnected");
        let v = serde_json::to_value(WifiStateInfo::from(adapters::WifiState::NoService)).unwrap();
        assert_eq!(v["state"], "noService");
    }

    #[test]
    fn build_network_maps_fields() {
        let raw = RawBss {
            ssid: b"FRITZ!Box".to_vec(),
            bssid: [0x3c, 0xa6, 0x2f, 0x11, 0x22, 0x33],
            rssi: -51,
            quality: 86,
            phy: 10,
            capability: 0x0411,
            center_khz: 5_220_000,
            width_mhz: Some(80),
            host_ts: (1_700_000_000_000u64 + 11_644_473_600_000) * 10_000,
        };
        let n = build_network(&raw, &[[0x3c, 0xa6, 0x2f, 0x11, 0x22, 0x33]], 1_700_000_003_000).unwrap();
        assert_eq!(n.ssid, "FRITZ!Box");
        assert_eq!(n.bssid, "3c:a6:2f:11:22:33");
        assert_eq!((n.channel, n.band.as_str(), n.width_mhz), (44, "5", Some(80)));
        assert!(n.secured && n.connected);
        assert_eq!(n.age_s, Some(3));
        assert_eq!(n.phy, "Wi-Fi 6 (802.11ax)");
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["centerKhz"], 5_220_000);
        assert_eq!(v["widthMhz"], 80);
        assert_eq!(v["ageS"], 3);
        // Kein RSSI → aus der Qualität; unbekanntes Band → weg
        let n2 = build_network(&RawBss { rssi: 0, quality: 40, center_khz: 2_412_000, ..raw.clone() }, &[], 0).unwrap();
        assert_eq!((n2.rssi, n2.connected, n2.age_s), (-80, false, None));
        assert!(build_network(&RawBss { center_khz: 60_480_000, ..raw }, &[], 0).is_none());
    }

    #[test]
    fn host_timestamp_age() {
        let now = 1_700_000_000_000i64;
        let ft = |ms: i64| (ms as u64 + 11_644_473_600_000) * 10_000;
        assert_eq!(age_from_host_ts(ft(now - 12_500), now), Some(12));
        assert_eq!(age_from_host_ts(ft(now + 2_000), now), Some(0), "kleine Uhr-Abweichung");
        assert_eq!(age_from_host_ts(ft(now + 60_000), now), None);
        assert_eq!(age_from_host_ts(ft(now - 2 * 86_400_000), now), None);
        assert_eq!(age_from_host_ts(0, now), None);
    }

    #[test]
    fn quiet_time_window() {
        let q = AtomicI64::new(0);
        let began = quiet_begin(&q, 1_000);
        assert_eq!(q.load(Ordering::SeqCst), 1_000 + SCAN_MAX_MS + QUIET_AFTER_MS);
        quiet_end(&q, began, 4_000);
        assert_eq!(q.load(Ordering::SeqCst), 6_000, "Scan-Dauer + 2 s");
        // Speedtest-Ruhezeit (länger) bleibt erhalten
        let q = AtomicI64::new(70_000);
        let began = quiet_begin(&q, 10_000);
        quiet_end(&q, began, 13_000);
        assert_eq!(q.load(Ordering::SeqCst), 70_000);
        // Jemand verlängert während des Scans → nicht verkürzen
        let q = AtomicI64::new(0);
        let began = quiet_begin(&q, 0);
        q.store(100_000, Ordering::SeqCst);
        quiet_end(&q, began, 3_000);
        assert_eq!(q.load(Ordering::SeqCst), 100_000);
    }

    #[tokio::test]
    async fn scan_gate_shares_result() {
        let gate = Arc::new(ScanGate::default());
        let runs = Arc::new(AtomicU64::new(0));
        let mk = |gate: Arc<ScanGate>, runs: Arc<AtomicU64>| async move {
            gate.run(|| async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                Ok(WifiScan { at: 42, fresh: true, interfaces: 1, networks: vec![] })
            })
            .await
        };
        let a = tokio::spawn(mk(gate.clone(), runs.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let b = tokio::spawn(mk(gate.clone(), runs.clone()));
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        assert_eq!(runs.load(Ordering::SeqCst), 1, "zweiter Aufruf wartet und scannt nicht erneut");
        assert_eq!(ra, rb);
        // Danach scannt ein neuer Aufruf wieder
        let _ = mk(gate.clone(), runs.clone()).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn empty_outside_windows_shape() {
        let v = serde_json::to_value(WifiScan::empty(5)).unwrap();
        assert_eq!(v, serde_json::json!({ "at": 5, "fresh": false, "interfaces": 0, "networks": [] }));
    }
}
