//! Netzwerkadapter (`GetAdaptersAddresses`) und WLAN-Verbindung (`wlanapi`). Beides ohne
//! Adminrechte. Die Zuordnungen (Adaptertyp, Hauptverbindung, Band, Standard) sind reine
//! Funktionen und werden auch unter Linux getestet.
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use super::dns;
use super::types::{AdapterInfo, DnsConfig, WifiInfo};

/// Rohdaten eines Adapters, wie Windows sie liefert (vor Filterung und Zuordnung).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawAdapter {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `IfType` (6 = Ethernet, 71 = WLAN, 24 = Loopback, 131 = Tunnel …)
    pub if_type: u32,
    pub up: bool,
    pub ipv4: Vec<Ipv4Addr>,
    pub gateway: Option<IpAddr>,
    pub dns: Vec<IpAddr>,
    /// IPv6-DNS-Server (ohne die veralteten Platzhalter `fec0:0:0:ffff::1/2/3`)
    pub dns6: Vec<Ipv6Addr>,
    /// Sendegeschwindigkeit in Bit/s (0 oder u64::MAX = unbekannt)
    pub link_speed_bps: u64,
    pub ipv4_metric: u32,
    /// IP-Adresse kommt per DHCP
    pub dhcp: bool,
}

const IF_TYPE_ETHERNET: u32 = 6;
const IF_TYPE_WIFI: u32 = 71;
const IF_TYPE_LOOPBACK: u32 = 24;
const IF_TYPE_TUNNEL: u32 = 131;

/// Adaptertyp als Text für die Oberfläche.
pub fn kind_from_if_type(if_type: u32) -> &'static str {
    match if_type {
        IF_TYPE_ETHERNET => "ethernet",
        IF_TYPE_WIFI => "wifi",
        _ => "other",
    }
}

/// Virtuelle Adapter (VM-Netze, Hyper-V-Switches) sind für die Spielverbindung uninteressant.
pub fn is_virtual(description: &str) -> bool {
    let d = description.to_ascii_lowercase();
    ["virtual", "vmware", "hyper-v", "virtualbox", "vethernet", "npcap", "loopback"]
        .iter()
        .any(|k| d.contains(k))
}

/// Bit/s → Mbit/s (None, wenn unbekannt).
pub fn speed_mbps(bps: u64) -> Option<u64> {
    if bps == 0 || bps == u64::MAX {
        None
    } else {
        Some(bps / 1_000_000)
    }
}

/// Aus den Rohdaten die Liste für die Oberfläche bauen: nur aktive, echte Adapter; die
/// Hauptverbindung (Standard-Gateway mit kleinster Metrik) zuerst.
pub fn build_infos(raw: &[RawAdapter]) -> Vec<AdapterInfo> {
    let active = |a: &&RawAdapter| a.up && a.if_type != IF_TYPE_LOOPBACK && a.if_type != IF_TYPE_TUNNEL;
    let mut usable: Vec<&RawAdapter> = raw.iter().filter(active).filter(|a| !is_virtual(&a.description)).collect();
    // In einer VM (Hyper-V, Azure, VMware) ist der „virtuelle“ Adapter die echte Verbindung:
    // gibt es keinen physischen Adapter mit Gateway, zählen virtuelle Adapter mit Gateway dazu.
    if !usable.iter().any(|a| a.gateway.is_some()) {
        usable.extend(raw.iter().filter(active).filter(|a| is_virtual(&a.description) && a.gateway.is_some()));
    }
    let primary_id = usable
        .iter()
        .filter(|a| a.gateway.is_some())
        .min_by_key(|a| a.ipv4_metric)
        .map(|a| a.id.clone());
    let mut out: Vec<AdapterInfo> = usable
        .into_iter()
        .map(|a| AdapterInfo {
            id: a.id.clone(),
            name: a.name.clone(),
            description: a.description.clone(),
            kind: kind_from_if_type(a.if_type).into(),
            up: a.up,
            speed_mbps: speed_mbps(a.link_speed_bps),
            ipv4: a.ipv4.iter().map(|ip| ip.to_string()).collect(),
            gateway: a.gateway.map(|g| g.to_string()),
            dns: a.dns.iter().map(|ip| ip.to_string()).collect(),
            primary: primary_id.as_deref() == Some(a.id.as_str()),
        })
        .collect();
    out.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Die GUID (`{…}`) der Hauptverbindung, falls sie als solche erkennbar ist – für `nagle`.
pub fn primary_adapter_guid(raw: &[RawAdapter]) -> Option<String> {
    let infos = build_infos(raw);
    let main = infos.iter().find(|a| a.primary).or_else(|| infos.first())?;
    crate::elevate::is_braced_guid(&main.id).then(|| main.id.clone())
}

/// DNS-Einstellung der Hauptverbindung aus den Rohdaten.
/// - `static_dns`: ob für diesen Adapter feste IPv4-DNS-Server eingetragen sind
///   (None = unbekannt → DHCP-Flag des Adapters).
/// - `dns_api_ok`: ob Pulsar den DNS hier überhaupt setzen kann (`SetInterfaceDnsSettings`).
/// - `backed_up`: ob für diesen Adapter eine Sicherung in kv `net.dnsBackup` existiert.
pub fn build_dns_config(
    raw: &[RawAdapter],
    static_dns: impl Fn(&str) -> Option<bool>,
    dns_api_ok: bool,
    backed_up: impl Fn(&str) -> bool,
) -> Option<DnsConfig> {
    let infos = build_infos(raw);
    let main = infos.iter().find(|a| a.primary).or_else(|| infos.first())?;
    let raw_main = raw.iter().find(|r| r.id == main.id);
    let dhcp = match static_dns(&main.id) {
        Some(is_static) => !is_static,
        None => raw_main.map(|r| r.dhcp).unwrap_or(true),
    };
    let ipv6_servers: Vec<String> = raw_main
        .map(|r| r.dns6.iter().filter(|ip| dns::is_real_ipv6_dns(ip)).map(|ip| ip.to_string()).collect())
        .unwrap_or_default();
    Some(DnsConfig {
        provider: dns::provider_for(&main.dns),
        can_change: dns_api_ok && crate::elevate::is_braced_guid(&main.id),
        changed_by_pulsar: backed_up(&main.id),
        adapter_id: main.id.clone(),
        adapter: main.name.clone(),
        servers: main.dns.clone(),
        ipv6_servers,
        dhcp,
    })
}

// ---------------------------------------------------------------------------------------------
// WLAN – reine Zuordnungen
// ---------------------------------------------------------------------------------------------

/// Frequenzband aus der Mittenfrequenz (kHz).
pub fn band_from_khz(khz: u32) -> Option<&'static str> {
    match khz {
        2_400_000..=2_500_000 => Some("2.4"),
        5_150_000..=5_925_000 => Some("5"),
        5_925_001..=7_125_000 => Some("6"),
        _ => None,
    }
}

/// Band aus der Kanalnummer (Faustregel, falls keine Frequenz bekannt ist; 6-GHz-Kanäle sind
/// nicht eindeutig von 5-GHz-Kanälen zu unterscheiden).
pub fn band_from_channel(channel: u32) -> Option<&'static str> {
    match channel {
        1..=14 => Some("2.4"),
        32..=177 => Some("5"),
        178..=233 => Some("6"),
        _ => None,
    }
}

/// WLAN-Standard als Text (`DOT11_PHY_TYPE`).
pub fn phy_name(phy: i32) -> String {
    match phy {
        1 => "802.11 (FHSS)",
        2 => "802.11 (DSSS)",
        4 => "Wi-Fi 2 (802.11a)",
        5 => "Wi-Fi 1 (802.11b)",
        6 => "Wi-Fi 3 (802.11g)",
        7 => "Wi-Fi 4 (802.11n)",
        8 => "Wi-Fi 5 (802.11ac)",
        9 => "802.11ad (WiGig)",
        10 => "Wi-Fi 6 (802.11ax)",
        11 => "Wi-Fi 7 (802.11be)",
        _ => "Unbekannt",
    }
    .to_string()
}

/// Windows liefert die Signalqualität 0–100; nach Microsoft-Dokumentation entspricht das linear
/// -100 dBm (0) bis -50 dBm (100). Nur als Ersatz, wenn kein gemessener RSSI vorliegt.
pub fn rssi_from_quality(quality: u32) -> i32 {
    (quality.min(100) as i32) / 2 - 100
}

/// kbit/s → Mbit/s (None bei 0).
pub fn rate_mbps(kbps: u32) -> Option<f64> {
    if kbps == 0 {
        None
    } else {
        Some(f64::from(kbps) / 1000.0)
    }
}

/// Rohdaten der WLAN-Verbindung, wie `wlanapi` sie liefert.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawWifi {
    pub ssid: String,
    /// Signalqualität 0–100
    pub quality: u32,
    /// Gemessener RSSI (dBm) aus der BSS-Liste, falls bekannt
    pub rssi: Option<i32>,
    pub channel: Option<u32>,
    /// Mittenfrequenz in kHz, falls bekannt
    pub center_khz: Option<u32>,
    /// `DOT11_PHY_TYPE`
    pub phy: i32,
    pub rx_kbps: u32,
    pub tx_kbps: u32,
}

/// Rohdaten der WLAN-Verbindung → Anzeige.
pub fn build_wifi(raw: RawWifi) -> WifiInfo {
    let band = raw
        .center_khz
        .and_then(band_from_khz)
        .or_else(|| raw.channel.and_then(band_from_channel));
    WifiInfo {
        ssid: raw.ssid,
        signal: raw.quality.min(100),
        rssi: Some(raw.rssi.unwrap_or_else(|| rssi_from_quality(raw.quality))),
        band: band.map(str::to_string),
        channel: raw.channel,
        phy: phy_name(raw.phy),
        rx_mbps: rate_mbps(raw.rx_kbps),
        tx_mbps: rate_mbps(raw.tx_kbps),
    }
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

#[cfg(windows)]
pub use win::{interface_exists, is_static_dns, list, primary_dns_servers, read_raw, static_servers, wifi};

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, ERROR_SUCCESS, HANDLE};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_MULTICAST,
        IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_DHCP_ENABLED,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::NetworkManagement::WiFi::{
        dot11_BSS_type_infrastructure, wlan_interface_state_connected, wlan_intf_opcode_channel_number,
        wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory,
        WlanGetNetworkBssList, WlanOpenHandle, WlanQueryInterface, WLAN_BSS_LIST, WLAN_CONNECTION_ATTRIBUTES,
        WLAN_INTERFACE_INFO_LIST,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKET_ADDRESS};

    use super::*;

    /// Socket-Adresse aus `GetAdaptersAddresses` lesen (IPv4 und IPv6).
    unsafe fn socket_ip(sa: &SOCKET_ADDRESS) -> Option<IpAddr> {
        if sa.lpSockaddr.is_null() {
            return None;
        }
        let family = (*sa.lpSockaddr).sa_family;
        if family == AF_INET && sa.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN>() {
            let sin = std::ptr::read_unaligned(sa.lpSockaddr as *const SOCKADDR_IN);
            Some(IpAddr::V4(Ipv4Addr::from(sin.sin_addr.S_un.S_addr.to_ne_bytes())))
        } else if family == AF_INET6 && sa.iSockaddrLength >= 24 {
            // sin6_addr liegt bei Offset 8 (family 2, port 2, flowinfo 4)
            let bytes = std::ptr::read_unaligned((sa.lpSockaddr as *const u8).add(8) as *const [u8; 16]);
            Some(IpAddr::V6(Ipv6Addr::from(bytes)))
        } else {
            None
        }
    }

    /// Alle Adapter roh einlesen.
    pub fn read_raw() -> Result<Vec<RawAdapter>, String> {
        let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
        let mut size: u32 = 16 * 1024;
        let mut attempts = 0;
        let buf: Vec<u64> = loop {
            let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
            // SAFETY: Puffer ist `size` Byte groß und 8-Byte-ausgerichtet; Windows füllt ihn oder
            // meldet die nötige Größe in `size`.
            let ret = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC.0 as u32,
                    flags,
                    None,
                    Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                    &mut size,
                )
            };
            attempts += 1;
            if ret == ERROR_SUCCESS.0 {
                break buf;
            }
            if ret == ERROR_NO_DATA.0 {
                return Ok(Vec::new());
            }
            if ret == ERROR_BUFFER_OVERFLOW.0 && attempts < 4 {
                continue;
            }
            return Err(format!("Die Netzwerkadapter konnten nicht gelesen werden (Fehler {ret})."));
        };

        let mut out = Vec::new();
        let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        // SAFETY: Die verkettete Liste liegt vollständig im Puffer; alle Zeiger stammen von Windows.
        unsafe {
            while !p.is_null() {
                let a = &*p;
                let mut raw = RawAdapter {
                    id: if a.AdapterName.is_null() { String::new() } else { a.AdapterName.to_string().unwrap_or_default() },
                    name: if a.FriendlyName.is_null() { String::new() } else { a.FriendlyName.to_string().unwrap_or_default() },
                    description: if a.Description.is_null() { String::new() } else { a.Description.to_string().unwrap_or_default() },
                    if_type: a.IfType,
                    up: a.OperStatus == IfOperStatusUp,
                    link_speed_bps: a.TransmitLinkSpeed,
                    ipv4_metric: a.Ipv4Metric,
                    dhcp: a.Anonymous2.Flags & IP_ADAPTER_DHCP_ENABLED != 0,
                    ..Default::default()
                };
                let mut u = a.FirstUnicastAddress;
                while !u.is_null() {
                    if let Some(IpAddr::V4(v4)) = socket_ip(&(*u).Address) {
                        raw.ipv4.push(v4);
                    }
                    u = (*u).Next;
                }
                let mut g = a.FirstGatewayAddress;
                while !g.is_null() {
                    if let Some(ip) = socket_ip(&(*g).Address) {
                        // IPv4-Gateway bevorzugen
                        if raw.gateway.is_none() || (raw.gateway.is_some_and(|x| x.is_ipv6()) && ip.is_ipv4()) {
                            raw.gateway = Some(ip);
                        }
                    }
                    g = (*g).Next;
                }
                let mut d = a.FirstDnsServerAddress;
                while !d.is_null() {
                    match socket_ip(&(*d).Address) {
                        // IPv4-Resolver (die eigenen UDP-Anfragen laufen über IPv4)
                        Some(IpAddr::V4(v4)) => {
                            if !raw.dns.contains(&v4.into()) {
                                raw.dns.push(IpAddr::V4(v4));
                            }
                        }
                        // IPv6-Resolver ohne die veralteten Platzhalter
                        Some(IpAddr::V6(v6)) if super::dns::is_real_ipv6_dns(&v6) && !raw.dns6.contains(&v6) => {
                            raw.dns6.push(v6);
                        }
                        _ => {}
                    }
                    d = (*d).Next;
                }
                out.push(raw);
                p = a.Next;
            }
        }
        Ok(out)
    }

    /// Den fest eingetragenen `NameServer` eines Adapters lesen (Tcpip für IPv4, Tcpip6 für IPv6).
    /// Lesen von HKLM braucht keine Adminrechte. `None` = Schlüssel/Wert fehlt.
    fn read_name_server(base: &str, adapter_id: &str) -> Option<String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        use winreg::RegKey;
        if !crate::elevate::is_braced_guid(adapter_id) {
            return None;
        }
        let path = format!(r"SYSTEM\CurrentControlSet\Services\{base}\Parameters\Interfaces\{adapter_id}");
        let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY).ok()?;
        key.get_value("NameServer").ok()
    }

    /// Feste IPv4-DNS-Server eingetragen? (None = Adapter/Schlüssel unbekannt.)
    pub fn is_static_dns(adapter_id: &str) -> Option<bool> {
        read_name_server("Tcpip", adapter_id).map(|v| !v.trim().is_empty())
    }

    /// Die fest eingetragenen DNS-Server eines Adapters je Familie (für die Sicherung).
    /// `(v4_dhcp, v4_servers, v6_dhcp, v6_servers)`.
    pub fn static_servers(adapter_id: &str) -> (bool, Vec<String>, bool, Vec<String>) {
        let read = |base| {
            let v = read_name_server(base, adapter_id).unwrap_or_default();
            let servers: Vec<String> = super::dns::parse_name_server(&v).iter().map(|ip| ip.to_string()).collect();
            (servers.is_empty(), servers)
        };
        let (v4_dhcp, v4) = read("Tcpip");
        let (v6_dhcp, v6) = read("Tcpip6");
        (v4_dhcp, v4, v6_dhcp, v6)
    }

    /// Gibt es den Netzwerk-Schlüssel dieses Adapters noch? (Für das Zurückstellen des DNS.)
    pub fn interface_exists(adapter_id: &str) -> bool {
        use crate::opt::registry::{HklmRead, RegistryRead};
        crate::elevate::is_braced_guid(adapter_id)
            && HklmRead.key_exists(&format!("{}\\{}", crate::elevate::KEY_INTERFACES, adapter_id))
    }

    /// Adapterliste für die Oberfläche.
    pub fn list() -> Result<Vec<AdapterInfo>, String> {
        Ok(build_infos(&read_raw()?))
    }

    /// DNS-Server der Hauptverbindung (leer, wenn nichts bekannt).
    pub fn primary_dns_servers() -> Vec<IpAddr> {
        let raw = read_raw().unwrap_or_default();
        let infos = build_infos(&raw);
        infos
            .iter()
            .find(|a| a.primary)
            .or_else(|| infos.first())
            .map(|a| a.dns.iter().filter_map(|s| s.parse().ok()).collect())
            .unwrap_or_default()
    }

    /// Aktuelle WLAN-Verbindung (None = kein verbundenes WLAN).
    pub fn wifi() -> Result<Option<WifiInfo>, String> {
        // SAFETY: Aufrufe nach wlanapi-Dokumentation; jeder von Windows gelieferte Speicher wird mit
        // WlanFreeMemory freigegeben, das Handle am Ende geschlossen.
        unsafe {
            let mut negotiated = 0u32;
            let mut handle = HANDLE::default();
            if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
                // Kein WLAN-Dienst (z. B. Desktop ohne WLAN-Karte)
                return Ok(None);
            }
            let result = wifi_with_handle(handle);
            let _ = WlanCloseHandle(handle, None);
            Ok(result)
        }
    }

    unsafe fn wifi_with_handle(handle: HANDLE) -> Option<WifiInfo> {
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(handle, None, &mut list) != 0 || list.is_null() {
            return None;
        }
        let count = (*list).dwNumberOfItems as usize;
        let first = (*list).InterfaceInfo.as_ptr();
        let mut found = None;
        for i in 0..count {
            let info = &*first.add(i);
            if info.isState != wlan_interface_state_connected {
                continue;
            }
            let guid = info.InterfaceGuid;

            let mut size = 0u32;
            let mut data: *mut c_void = std::ptr::null_mut();
            if WlanQueryInterface(handle, &guid, wlan_intf_opcode_current_connection, None, &mut size, &mut data, None) != 0 || data.is_null() {
                continue;
            }
            let attrs = std::ptr::read_unaligned(data as *const WLAN_CONNECTION_ATTRIBUTES);
            WlanFreeMemory(data);
            let assoc = attrs.wlanAssociationAttributes;
            let ssid_len = (assoc.dot11Ssid.uSSIDLength as usize).min(assoc.dot11Ssid.ucSSID.len());
            let ssid = String::from_utf8_lossy(&assoc.dot11Ssid.ucSSID[..ssid_len]).into_owned();

            let mut ch_size = 0u32;
            let mut ch_data: *mut c_void = std::ptr::null_mut();
            let channel = if WlanQueryInterface(handle, &guid, wlan_intf_opcode_channel_number, None, &mut ch_size, &mut ch_data, None) == 0 && !ch_data.is_null() {
                let v = if ch_size >= 4 { Some(std::ptr::read_unaligned(ch_data as *const u32)) } else { None };
                WlanFreeMemory(ch_data);
                v.filter(|c| *c > 0)
            } else {
                None
            };

            // Genaue Frequenz und gemessener RSSI aus der BSS-Liste (nur der verbundene Zugangspunkt)
            let mut bss: *mut WLAN_BSS_LIST = std::ptr::null_mut();
            let (khz, rssi) = if WlanGetNetworkBssList(
                handle,
                &guid,
                Some(&assoc.dot11Ssid),
                dot11_BSS_type_infrastructure,
                attrs.wlanSecurityAttributes.bSecurityEnabled.as_bool(),
                None,
                &mut bss,
            ) == 0
                && !bss.is_null()
            {
                let n = (*bss).dwNumberOfItems as usize;
                let entries = (*bss).wlanBssEntries.as_ptr();
                let mut hit = (None, None);
                for j in 0..n {
                    let e = std::ptr::read_unaligned(entries.add(j));
                    if e.dot11Bssid == assoc.dot11Bssid {
                        hit = (Some(e.ulChCenterFrequency).filter(|f| *f > 0), Some(e.lRssi).filter(|r| *r < 0));
                        break;
                    }
                }
                WlanFreeMemory(bss as *const c_void);
                hit
            } else {
                (None, None)
            };

            found = Some(build_wifi(RawWifi {
                ssid,
                quality: assoc.wlanSignalQuality,
                rssi,
                channel,
                center_khz: khz,
                phy: assoc.dot11PhyType.0,
                rx_kbps: assoc.ulRxRate,
                tx_kbps: assoc.ulTxRate,
            }));
            break;
        }
        WlanFreeMemory(list as *const c_void);
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str, if_type: u32, up: bool, gateway: Option<&str>, metric: u32) -> RawAdapter {
        RawAdapter {
            id: id.into(),
            name: id.to_uppercase(),
            description: format!("Karte {id}"),
            if_type,
            up,
            ipv4: vec![Ipv4Addr::new(192, 168, 1, 10)],
            gateway: gateway.map(|g| g.parse().unwrap()),
            dns: vec![IpAddr::from([192, 168, 1, 1])],
            dns6: vec![],
            link_speed_bps: 1_000_000_000,
            ipv4_metric: metric,
            dhcp: true,
        }
    }

    #[test]
    fn kinds_speed_and_virtual_detection() {
        assert_eq!(kind_from_if_type(6), "ethernet");
        assert_eq!(kind_from_if_type(71), "wifi");
        assert_eq!(kind_from_if_type(131), "other");
        assert_eq!(speed_mbps(2_500_000_000), Some(2500));
        assert_eq!(speed_mbps(0), None);
        assert_eq!(speed_mbps(u64::MAX), None);
        assert!(is_virtual("Hyper-V Virtual Ethernet Adapter"));
        assert!(is_virtual("VMware Virtual Ethernet Adapter for VMnet8"));
        assert!(!is_virtual("Intel(R) Ethernet Controller I225-V"));
        assert!(!is_virtual("WireGuard Tunnel"));
    }

    #[test]
    fn build_infos_filters_and_picks_primary() {
        let adapters = vec![
            raw("wifi", 71, true, Some("192.168.1.1"), 35),
            raw("eth", 6, true, Some("192.168.1.1"), 25),
            raw("down", 6, false, Some("192.168.1.1"), 5),
            raw("lo", 24, true, None, 75),
            RawAdapter { description: "Hyper-V Virtual Ethernet Adapter".into(), ..raw("vm", 6, true, Some("172.20.0.1"), 1) },
            raw("nogw", 6, true, None, 1),
        ];
        let infos = build_infos(&adapters);
        let ids: Vec<&str> = infos.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["eth", "nogw", "wifi"], "Hauptverbindung zuerst, dann nach Name");
        assert!(infos[0].primary && !infos[1].primary && !infos[2].primary);
        assert_eq!(infos[0].kind, "ethernet");
        assert_eq!(infos[2].kind, "wifi");
        assert_eq!(infos[0].speed_mbps, Some(1000));
        assert_eq!(infos[0].ipv4, vec!["192.168.1.10"]);
        assert_eq!(infos[0].gateway.as_deref(), Some("192.168.1.1"));
        assert_eq!(infos[0].dns, vec!["192.168.1.1"]);
        assert!(build_infos(&[]).is_empty());
    }

    #[test]
    fn build_infos_keeps_virtual_adapter_when_it_is_the_only_connection() {
        // Wie auf einer VM (z. B. GitHub-Runner): nur ein Hyper-V-Adapter mit Gateway
        let adapters = vec![
            RawAdapter { description: "Microsoft Hyper-V Network Adapter".into(), ..raw("vm", 6, true, Some("10.1.0.1"), 10) },
            raw("lo", 24, true, None, 75),
        ];
        let infos = build_infos(&adapters);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].id, "vm");
        assert!(infos[0].primary);
        assert!(build_dns_config(&adapters, |_| None, false, |_| false).is_some());
    }

    #[test]
    fn dns_config_uses_primary_and_registry_hint() {
        let adapters = vec![raw("wifi", 71, true, Some("192.168.1.1"), 35), raw("eth", 6, true, Some("192.168.1.1"), 25)];
        let cfg = build_dns_config(&adapters, |_| Some(true), false, |_| false).unwrap();
        assert_eq!(cfg.adapter_id, "eth");
        assert_eq!(cfg.adapter, "ETH");
        assert!(!cfg.dhcp, "feste Server eingetragen → kein DHCP");
        assert!(!cfg.changed_by_pulsar);
        assert_eq!(cfg.servers, vec!["192.168.1.1"]);
        assert!(!cfg.can_change, "id ist keine Adapter-GUID");
        let cfg2 = build_dns_config(&adapters, |_| None, false, |_| false).unwrap();
        assert!(cfg2.dhcp, "ohne Registry-Hinweis zählt das DHCP-Flag");
        assert!(build_dns_config(&[], |_| None, false, |_| false).is_none());
    }

    #[test]
    fn dns_config_fills_provider_ipv6_and_change_flags() {
        const GUID: &str = "{4d36e972-e325-11ce-bfc1-08002be10318}";
        let mut a = RawAdapter {
            dns: vec![IpAddr::from([1, 1, 1, 1])],
            dns6: vec![
                "2606:4700:4700::1111".parse().unwrap(),
                "fec0:0:0:ffff::1".parse().unwrap(), // Platzhalter: raus
            ],
            ..raw(GUID, 6, true, Some("192.168.1.1"), 10)
        };
        a.name = "Ethernet".into();
        let adapters = vec![a];
        let cfg = build_dns_config(&adapters, |_| Some(true), true, |id| id == GUID).unwrap();
        assert_eq!(cfg.provider.as_deref(), Some("cloudflare"));
        assert_eq!(cfg.ipv6_servers, vec!["2606:4700:4700::1111"], "Platzhalter gefiltert");
        assert!(cfg.can_change, "GUID gültig + API vorhanden");
        assert!(cfg.changed_by_pulsar, "Sicherung vorhanden");
        assert_eq!(primary_adapter_guid(&adapters).as_deref(), Some(GUID));

        // Ohne API kein canChange
        let cfg2 = build_dns_config(&adapters, |_| Some(true), false, |_| false).unwrap();
        assert!(!cfg2.can_change);
        assert_eq!(primary_adapter_guid(&[raw("eth", 6, true, Some("192.168.1.1"), 1)]), None);
    }

    #[test]
    fn wifi_band_phy_and_rssi_mapping() {
        assert_eq!(band_from_khz(2_437_000), Some("2.4"));
        assert_eq!(band_from_khz(5_220_000), Some("5"));
        assert_eq!(band_from_khz(6_115_000), Some("6"));
        assert_eq!(band_from_khz(0), None);
        assert_eq!(band_from_channel(6), Some("2.4"));
        assert_eq!(band_from_channel(44), Some("5"));
        assert_eq!(band_from_channel(0), None);
        assert_eq!(phy_name(10), "Wi-Fi 6 (802.11ax)");
        assert_eq!(phy_name(8), "Wi-Fi 5 (802.11ac)");
        assert_eq!(phy_name(11), "Wi-Fi 7 (802.11be)");
        assert_eq!(phy_name(99), "Unbekannt");
        assert_eq!(rssi_from_quality(0), -100);
        assert_eq!(rssi_from_quality(100), -50);
        assert_eq!(rssi_from_quality(250), -50);
        assert_eq!(rate_mbps(0), None);
        assert_eq!(rate_mbps(1_201_000), Some(1201.0));

        let w = build_wifi(RawWifi {
            ssid: "Netz".into(),
            quality: 86,
            rssi: Some(-51),
            channel: Some(44),
            center_khz: Some(5_220_000),
            phy: 10,
            rx_kbps: 1_201_000,
            tx_kbps: 1_201_000,
        });
        assert_eq!(w.band.as_deref(), Some("5"));
        assert_eq!(w.rssi, Some(-51));
        assert_eq!(w.signal, 86);
        assert_eq!(w.phy, "Wi-Fi 6 (802.11ax)");
        assert_eq!(w.ssid, "Netz");
        let w2 = build_wifi(RawWifi { ssid: "Netz".into(), quality: 120, channel: Some(6), phy: 7, ..Default::default() });
        assert_eq!(w2.signal, 100);
        assert_eq!(w2.rssi, Some(-50));
        assert_eq!(w2.band.as_deref(), Some("2.4"));
        assert_eq!(w2.rx_mbps, None);
    }
}
