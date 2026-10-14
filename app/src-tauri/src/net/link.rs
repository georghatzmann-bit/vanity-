//! Hauptverbindung, Netz-Kennung und VPN (Vertrag: `docs/API.md`, „Hauptverbindung, Netz und
//! Verbindungsart“). Zwischengespeichert in `NetState.link`, damit der Monitor-Takt nie
//! `GetAdaptersAddresses` aufruft.
//!
//! Alles ohne Adminrechte: Adapter über `GetAdaptersAddresses`, die MAC-Adresse des Gateways aus
//! der Nachbartabelle (`GetIpNetTable2`), der Weg zum Messziel über `GetBestInterfaceEx`. Die MAC
//! selbst wird nie gespeichert – nur ein Hash als `net_id`. Außerhalb von Windows gilt der Ersatzweg
//! aus dem Vertrag (`other`, kein Gateway, `net_id = ""`, kein VPN).

// Außerhalb von Windows bleiben die Windows-Wege ungenutzt (nur Tests).
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::adapters::RawAdapter;
use super::hist_types::ConnectionKind;

/// Art der Hauptverbindung (ohne VPN – das ist ein eigenes Merkmal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wifi,
    Ethernet,
    /// USB-Tethering, LTE-Stick, unbekannte Adapter
    Other,
}

impl LinkKind {
    /// Aus dem Adaptertyp (`IfType` 6 = Ethernet, 71 = WLAN).
    pub fn from_if_type(if_type: u32) -> Self {
        match if_type {
            6 => LinkKind::Ethernet,
            71 => LinkKind::Wifi,
            _ => LinkKind::Other,
        }
    }
}

/// Die Hauptverbindung zum Zeitpunkt `at`.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimaryLink {
    /// `NET_LUID` (für `GetIfEntry2`)
    pub luid: u64,
    pub if_index: u32,
    /// Adapter-GUID (`AdapterInfo.id`)
    pub adapter_id: String,
    /// Anzeigename des Adapters (für `IfCounters.adapter`)
    pub adapter: String,
    pub kind: LinkKind,
    /// Nur IPv4 (ein reines IPv6-Gateway gilt als „kein Gateway“)
    pub gateway: Option<Ipv4Addr>,
    /// Kennung des Netzes (12 Hex-Zeichen, `""` = unbekannt)
    pub net_id: String,
    /// Verkehr läuft vermutlich über ein VPN
    pub vpn: bool,
    /// Zeitpunkt der Ermittlung (ms)
    pub at: i64,
}

/// Die Teile der Hauptverbindung, die der Recorder je Takt braucht (billig zu kopieren).
#[derive(Debug, Clone, PartialEq)]
pub struct PrimaryLinkLite {
    pub luid: u64,
    pub if_index: u32,
    pub kind: LinkKind,
    pub gateway: Option<Ipv4Addr>,
    pub net_id: String,
    pub vpn: bool,
    pub at: i64,
}

impl PrimaryLink {
    pub fn lite(&self) -> PrimaryLinkLite {
        PrimaryLinkLite {
            luid: self.luid,
            if_index: self.if_index,
            kind: self.kind,
            gateway: self.gateway,
            net_id: self.net_id.clone(),
            vpn: self.vpn,
            at: self.at,
        }
    }
}

impl PrimaryLinkLite {
    /// Verbindungsart für `ping_hourly`/`net_events` (`vpn` hat Vorrang).
    pub fn connection(&self) -> ConnectionKind {
        if self.vpn {
            return ConnectionKind::Vpn;
        }
        match self.kind {
            LinkKind::Wifi => ConnectionKind::Wifi,
            LinkKind::Ethernet => ConnectionKind::Ethernet,
            LinkKind::Other => ConnectionKind::Other,
        }
    }
}

/// Mindestabstand zwischen zwei Ermittlungen (vom Monitor-Hook ausgelöst).
pub const REFRESH_EVERY_MS: i64 = 30_000;
/// Ziel der VPN-Erkennung, wenn kein Messziel bekannt ist.
pub const DEFAULT_ROUTE_PROBE: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);
/// Präfix des Netz-Hashes über die MAC-Adresse des Gateways.
const NET_ID_PREFIX: &str = "pulsar-net-v1|";
/// Länge der Netz-Kennung (Hex-Zeichen).
const NET_ID_LEN: usize = 12;

/// `IfType` 53 (`IF_TYPE_PROP_VIRTUAL`, z. B. WireGuard/Wintun) und 131 (`IF_TYPE_TUNNEL`).
const TUNNEL_IF_TYPES: [u32; 2] = [53, 131];
/// Beschreibungen typischer VPN-Adapter (Groß-/Kleinschreibung egal).
const VPN_NAMES: [&str; 6] = ["wireguard", "wintun", "tap-windows", "openvpn", "nordlynx", "anyconnect"];

/// Die Hauptverbindung in den Rohdaten (gleiche Wahl wie `net_adapters`: aktiver Adapter mit
/// Standard-Gateway und kleinster Metrik).
pub fn pick_primary(raw: &[RawAdapter]) -> Option<&RawAdapter> {
    let infos = super::adapters::build_infos(raw);
    let main = infos.iter().find(|a| a.primary)?;
    raw.iter().find(|r| r.id == main.id)
}

/// Netz-Kennung (rein): erste 12 Hex-Zeichen von SHA-256 über `"pulsar-net-v1|" + MAC` des
/// Gateways; ohne lesbare MAC über `adapter_id + "|" + gateway`; ohne Gateway `""`. Bewusst ohne
/// Adapter-GUID, solange die MAC lesbar ist: derselbe Router per WLAN und per Kabel ergibt dasselbe
/// Netz.
pub fn net_id_from(mac: Option<&[u8]>, adapter_id: &str, gateway: Option<Ipv4Addr>) -> String {
    let Some(gw) = gateway else { return String::new() };
    let mac = mac.filter(|m| !m.is_empty() && m.iter().any(|b| *b != 0));
    let input = match mac {
        Some(m) => format!("{NET_ID_PREFIX}{}", mac_text(m)),
        None => format!("{adapter_id}|{gw}"),
    };
    let digest = Sha256::digest(input.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex.chars().take(NET_ID_LEN).collect()
}

/// MAC als `aa:bb:cc:dd:ee:ff` (nur intern für den Hash).
fn mac_text(mac: &[u8]) -> String {
    mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

/// VPN-Erkennung (rein): anderer Schnittstellen-Index für das Ziel als die Hauptverbindung, oder ein
/// aktiver Tunnel-Adapter (`IfType` 53/131 bzw. typische VPN-Beschreibung) mit Standard-Gateway.
pub fn vpn_from(best_index: Option<u32>, primary_index: u32, adapters: &[RawAdapter]) -> bool {
    let other_route = primary_index != 0 && best_index.is_some_and(|b| b != 0 && b != primary_index);
    let tunnel = adapters.iter().any(|a| {
        let d = a.description.to_ascii_lowercase();
        a.up && a.gateway.is_some() && (TUNNEL_IF_TYPES.contains(&a.if_type) || VPN_NAMES.iter().any(|n| d.contains(n)))
    });
    other_route || tunnel
}

/// Nur ein IPv4-Gateway zählt (ein reines IPv6-Gateway gilt als „kein Gateway“).
fn ipv4_gateway(gw: Option<IpAddr>) -> Option<Ipv4Addr> {
    match gw {
        Some(IpAddr::V4(g)) if !g.is_unspecified() => Some(g),
        _ => None,
    }
}

/// Hauptverbindung aus den Rohdaten bauen (rein; MAC und bester Index kommen von außen).
pub fn build_link(
    raw: &[RawAdapter],
    gateway_mac: impl Fn(u64, Ipv4Addr) -> Option<Vec<u8>>,
    best_index: Option<u32>,
    now: i64,
) -> Option<PrimaryLink> {
    let main = pick_primary(raw)?;
    let gateway = ipv4_gateway(main.gateway);
    let mac = gateway.and_then(|g| gateway_mac(main.luid, g));
    Some(PrimaryLink {
        luid: main.luid,
        if_index: main.if_index,
        adapter_id: main.id.clone(),
        adapter: main.name.clone(),
        kind: LinkKind::from_if_type(main.if_type),
        gateway,
        net_id: net_id_from(mac.as_deref(), &main.id, gateway),
        vpn: vpn_from(best_index, main.if_index, raw),
        at: now,
    })
}

/// Hauptverbindung neu ermitteln (blockierend – nur in `spawn_blocking` aufrufen). `target` = IPv4
/// des Messziels für die VPN-Erkennung (ohne Ziel: `1.1.1.1`). `None` = keine Hauptverbindung oder
/// Adapter nicht lesbar.
pub fn refresh(target: Option<Ipv4Addr>, now: i64) -> Option<PrimaryLink> {
    #[cfg(windows)]
    {
        let raw = super::adapters::read_raw().ok()?;
        let best = win::best_index(target.unwrap_or(DEFAULT_ROUTE_PROBE));
        build_link(&raw, win::gateway_mac, best, now)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Some(PrimaryLink {
            luid: 0,
            if_index: 0,
            adapter_id: String::new(),
            adapter: String::new(),
            kind: LinkKind::Other,
            gateway: None,
            net_id: String::new(),
            vpn: false,
            at: now,
        })
    }
}

#[cfg(windows)]
mod win {
    use std::net::Ipv4Addr;
    use std::ptr::addr_of;

    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetBestInterfaceEx, GetIpNetTable2, MIB_IPNET_ROW2, MIB_IPNET_TABLE2};
    use windows::Win32::Networking::WinSock::{NlnsIncomplete, NlnsUnreachable, AF_INET, IN_ADDR, IN_ADDR_0, SOCKADDR, SOCKADDR_IN};

    /// Schnittstellen-Index, über den Windows `dst` erreichen würde (`None` bei Fehler).
    pub fn best_index(dst: Ipv4Addr) -> Option<u32> {
        let sa = SOCKADDR_IN {
            sin_family: AF_INET,
            sin_port: 0,
            sin_addr: IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes(dst.octets()) } },
            sin_zero: [0; 8],
        };
        let mut index = 0u32;
        // SAFETY: `sa` ist eine vollständige SOCKADDR_IN und lebt bis nach dem Aufruf; `index` ist
        // ein gültiger Ausgabe-Zeiger.
        let ret = unsafe { GetBestInterfaceEx(&sa as *const SOCKADDR_IN as *const SOCKADDR, &mut index) };
        (ret == 0 && index != 0).then_some(index)
    }

    /// Gibt die Tabelle beim Verlassen frei.
    struct Table(*mut MIB_IPNET_TABLE2);
    impl Drop for Table {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: Zeiger stammt aus GetIpNetTable2 und wird genau einmal freigegeben.
                unsafe { FreeMibTable(self.0 as *const core::ffi::c_void) };
            }
        }
    }

    /// MAC-Adresse des Gateways aus der Nachbartabelle (nur IPv4, nur auf der Hauptverbindung, nicht
    /// „unerreichbar“/„unvollständig“). Ohne Adminrechte.
    pub fn gateway_mac(luid: u64, gateway: Ipv4Addr) -> Option<Vec<u8>> {
        let mut raw: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
        // SAFETY: Ausgabe-Zeiger ist gültig; Windows legt die Tabelle an, `Table` gibt sie frei.
        let ret = unsafe { GetIpNetTable2(AF_INET, &mut raw) };
        let table = Table(raw);
        if ret.0 != 0 || table.0.is_null() {
            return None;
        }
        let want = u32::from_ne_bytes(gateway.octets());
        // SAFETY: Die Tabelle enthält `NumEntries` Zeilen ab `Table`; alle Felder werden einzeln und
        // innerhalb dieser Grenzen gelesen.
        unsafe {
            let count = (*table.0).NumEntries as usize;
            let rows = addr_of!((*table.0).Table) as *const MIB_IPNET_ROW2;
            for i in 0..count {
                let row = &*rows.add(i);
                if row.InterfaceLuid.Value != luid || row.Address.si_family != AF_INET {
                    continue;
                }
                if row.Address.Ipv4.sin_addr.S_un.S_addr != want {
                    continue;
                }
                if row.State == NlnsUnreachable || row.State == NlnsIncomplete {
                    continue;
                }
                let len = (row.PhysicalAddressLength as usize).min(row.PhysicalAddress.len());
                let mac = row.PhysicalAddress[..len].to_vec();
                if mac.iter().any(|b| *b != 0) {
                    return Some(mac);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(id: &str, if_type: u32, gateway: Option<&str>, if_index: u32, description: &str) -> RawAdapter {
        RawAdapter {
            id: id.into(),
            name: format!("Name {id}"),
            description: description.into(),
            if_type,
            up: true,
            ipv4: vec![Ipv4Addr::new(192, 168, 178, 20)],
            gateway: gateway.map(|g| g.parse().unwrap()),
            ipv4_metric: 25,
            luid: u64::from(if_index) * 1000,
            if_index,
            ..Default::default()
        }
    }

    #[test]
    fn connection_prefers_vpn() {
        let mut l = PrimaryLink {
            luid: 1,
            if_index: 2,
            adapter_id: "{a}".into(),
            adapter: "WLAN".into(),
            kind: LinkKind::Wifi,
            gateway: Some(Ipv4Addr::new(192, 168, 178, 1)),
            net_id: "abc".into(),
            vpn: false,
            at: 5,
        }
        .lite();
        assert_eq!(l.connection(), ConnectionKind::Wifi);
        l.vpn = true;
        assert_eq!(l.connection(), ConnectionKind::Vpn);
        assert_eq!(LinkKind::from_if_type(6), LinkKind::Ethernet);
        assert_eq!(LinkKind::from_if_type(71), LinkKind::Wifi);
        assert_eq!(LinkKind::from_if_type(243), LinkKind::Other);
        assert_eq!(serde_json::to_value(LinkKind::Ethernet).unwrap(), "ethernet");
    }

    #[test]
    fn vpn_detected_by_best_interface() {
        let eth = adapter("{eth}", 6, Some("192.168.178.1"), 7, "Intel(R) Ethernet");
        let wg = RawAdapter { gateway: None, ..adapter("{wg}", 53, None, 31, "WireGuard Tunnel") };
        let list = vec![eth, wg];
        assert!(vpn_from(Some(31), 7, &list), "Ziel läuft über eine andere Schnittstelle");
        assert!(!vpn_from(Some(7), 7, &list), "Ziel über die Hauptverbindung");
        assert!(!vpn_from(None, 7, &list), "GetBestInterfaceEx gescheitert");
        assert!(!vpn_from(Some(31), 0, &list), "Index der Hauptverbindung unbekannt");
    }

    #[test]
    fn tunnel_adapter_with_gateway() {
        let eth = adapter("{eth}", 6, Some("192.168.178.1"), 7, "Intel(R) Ethernet");
        for (if_type, description) in [(53, "Irgendein Adapter"), (131, "Tunnel"), (6, "TAP-Windows Adapter V9"), (6, "Cisco AnyConnect Secure Mobility Client"), (71, "NordLynx Tunnel")] {
            let vpn = adapter("{vpn}", if_type, Some("10.8.0.1"), 40, description);
            assert!(vpn_from(Some(7), 7, &[eth.clone(), vpn]), "{description}");
        }
        // Ausgeschaltet zählt nicht
        let off = RawAdapter { up: false, ..adapter("{vpn}", 53, Some("10.8.0.1"), 40, "WireGuard") };
        assert!(!vpn_from(Some(7), 7, &[eth, off]));
    }

    #[test]
    fn tunnel_without_gateway_is_not_vpn() {
        let eth = adapter("{eth}", 6, Some("192.168.178.1"), 7, "Intel(R) Ethernet");
        let wintun = adapter("{wt}", 53, None, 40, "Wintun Userspace Tunnel");
        let teredo = adapter("{te}", 131, None, 41, "Microsoft Teredo Tunneling Adapter");
        assert!(!vpn_from(Some(7), 7, &[eth, wintun, teredo]));
    }

    #[test]
    fn net_id_from_gateway_mac() {
        let gw = Some(Ipv4Addr::new(192, 168, 178, 1));
        let mac = [0x3c, 0xa6, 0x2f, 0x01, 0x02, 0x03];
        let a = net_id_from(Some(&mac), "{wlan}", gw);
        let b = net_id_from(Some(&mac), "{kabel}", gw);
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, b, "derselbe Router per WLAN und per Kabel = dasselbe Netz");
        assert!(!a.starts_with("3ca62f"), "die MAC selbst steht nie in der Kennung");
        // Ohne lesbare MAC: Adapter + Gateway
        let c = net_id_from(None, "{wlan}", gw);
        let d = net_id_from(Some(&[0, 0, 0, 0, 0, 0]), "{wlan}", gw);
        assert_eq!(c, d, "Null-MAC gilt als nicht lesbar");
        assert_ne!(c, a);
        assert_ne!(c, net_id_from(None, "{kabel}", gw));
        assert_eq!(net_id_from(Some(&mac), "{wlan}", None), "", "kein Gateway → unbekannt");
        // Feste Prüfsumme (Format darf sich nie ändern, sonst zerfällt der Verlauf in neue Netze)
        let expected: String = Sha256::digest(b"pulsar-net-v1|3c:a6:2f:01:02:03").iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(a, expected[..12]);
    }

    #[test]
    fn build_link_uses_primary_and_ipv4_gateway() {
        let wifi = RawAdapter { ipv4_metric: 50, ..adapter("{wlan}", 71, Some("192.168.178.1"), 9, "Intel(R) Wi-Fi 6") };
        let eth = RawAdapter { ipv4_metric: 10, ..adapter("{eth}", 6, Some("192.168.178.1"), 7, "Realtek PCIe GbE") };
        let mac = |luid: u64, gw: Ipv4Addr| (luid == 7000 && gw == Ipv4Addr::new(192, 168, 178, 1)).then(|| vec![1, 2, 3, 4, 5, 6]);
        let l = build_link(&[wifi.clone(), eth], mac, Some(7), 42).unwrap();
        assert_eq!((l.adapter_id.as_str(), l.kind, l.if_index, l.luid, l.at), ("{eth}", LinkKind::Ethernet, 7, 7000, 42));
        assert_eq!(l.gateway, Some(Ipv4Addr::new(192, 168, 178, 1)));
        assert_eq!(l.net_id, net_id_from(Some(&[1, 2, 3, 4, 5, 6]), "x", l.gateway));
        assert!(!l.vpn);
        assert_eq!(l.adapter, "Name {eth}");
        // Reines IPv6-Gateway → kein Gateway, keine Netz-Kennung
        let v6 = RawAdapter { gateway: Some("fe80::1".parse().unwrap()), ..wifi };
        let l = build_link(&[v6], mac, None, 1).unwrap();
        assert_eq!((l.kind, l.gateway, l.net_id.as_str()), (LinkKind::Wifi, None, ""));
        // Ohne Adapter mit Gateway: keine Hauptverbindung
        assert!(build_link(&[], mac, None, 1).is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn fallback_outside_windows() {
        let l = refresh(None, 9).unwrap();
        assert_eq!(l.kind, LinkKind::Other);
        assert_eq!(l.gateway, None);
        assert_eq!(l.net_id, "");
        assert!(!l.vpn);
    }
}
