//! Heimnetz (P7.4): eigene IPv4-Netze mit Standard-Gateway, Nachbartabelle (ARP), ICMP-Echo
//! („Ping“) und die Sicherheit der aktuellen WLAN-Verbindung. Alles nur lesend; der Ping
//! sendet eine kleine Echo-Anfrage – mehr nicht.

use std::io;
use std::net::Ipv4Addr;
use std::ptr;

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIpForwardTable2, GetIpNetTable2, GetUnicastIpAddressTable, ICMP_ECHO_REPLY,
    IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2,
    MIB_IPNET_ROW2, MIB_IPNET_TABLE2, MIB_UNICASTIPADDRESS_ROW, MIB_UNICASTIPADDRESS_TABLE,
};
use windows_sys::Win32::NetworkManagement::WiFi::{
    WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle,
    WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle, WlanQueryInterface,
    wlan_intf_opcode_current_connection,
};
use windows_sys::Win32::Networking::WinSock::{
    AF_INET, NlnsPermanent, NlnsReachable, NlnsStale, SOCKADDR_INET,
};

/// Ein eigenes IPv4-Netz.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNet {
    /// Eigene Adresse.
    pub address: Ipv4Addr,
    /// Präfixlänge (z. B. 24).
    pub prefix: u8,
    /// Standard-Gateway (Router) dieses Netzes, falls vorhanden.
    pub gateway: Option<Ipv4Addr>,
    /// Schnittstelle (Index).
    pub interface: u32,
    /// Art der Schnittstelle (IANA `ifType`: 6 = Ethernet, 71 = WLAN, 131 = Tunnel, …).
    pub if_type: u16,
    /// Metrik der Standardroute (kleiner = bevorzugt), falls vorhanden.
    pub metric: Option<u32>,
}

/// Eintrag der Nachbartabelle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Neighbor {
    /// Adresse.
    pub address: Ipv4Addr,
    /// Hardware-Adresse (MAC).
    pub mac: [u8; 6],
    /// Schnittstelle (Index).
    pub interface: u32,
}

/// Sicherheit der aktuellen WLAN-Verbindung.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiSecurity {
    /// Netzname (SSID, verlustbehaftet als UTF-8).
    pub ssid: String,
    /// Verschlüsselung an?
    pub security_enabled: bool,
    /// `DOT11_AUTH_ALGORITHM`.
    pub auth: i32,
    /// `DOT11_CIPHER_ALGORITHM`.
    pub cipher: i32,
}

fn v4(addr: &SOCKADDR_INET) -> Option<Ipv4Addr> {
    // SAFETY: `si_family` liegt in allen Varianten an derselben Stelle; bei AF_INET ist die
    // IPv4-Variante gültig.
    // aegis-unsafe: winffi-lan-sockaddr
    #[allow(unsafe_code)]
    let raw = unsafe {
        if addr.si_family != AF_INET {
            return None;
        }
        addr.Ipv4.sin_addr.S_un.S_addr
    };
    // S_addr liegt in Netzwerk-Byte-Reihenfolge im Speicher.
    Some(Ipv4Addr::from(raw.to_ne_bytes()))
}

/// Liest eine MIB-Tabelle (`NumEntries` + Zeilen) und gibt sie wieder frei.
fn rows<T: Copy, Table>(table: *mut Table, count: u32, first: *const T) -> Vec<T> {
    let mut out = Vec::new();
    if !table.is_null() {
        for i in 0..usize::try_from(count).unwrap_or(0) {
            // SAFETY: Die Tabelle stammt von der IP-Hilfsbibliothek und enthält `count` Zeilen
            // ab `first`; jede Zeile wird kopiert, bevor die Tabelle freigegeben wird.
            // aegis-unsafe: winffi-lan-row
            #[allow(unsafe_code)]
            out.push(unsafe { *first.add(i) });
        }
        // SAFETY: Mit Get…Table2 angelegt, genau einmal freigegeben.
        // aegis-unsafe: winffi-lan-free
        #[allow(unsafe_code)]
        unsafe {
            FreeMibTable(table.cast());
        }
    }
    out
}

/// Eigene IPv4-Netze mit ihrem Standard-Gateway (Schnittstellen ohne Gateway ebenfalls).
///
/// # Errors
/// Tabellen nicht lesbar.
pub fn local_networks() -> io::Result<Vec<LocalNet>> {
    let mut routes: *mut MIB_IPFORWARD_TABLE2 = ptr::null_mut();
    // SAFETY: Ausgabezeiger gültig; die Tabelle gibt `rows` frei.
    // aegis-unsafe: winffi-lan-routes
    #[allow(unsafe_code)]
    let status = unsafe { GetIpForwardTable2(AF_INET, &mut routes) };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(-1),
        ));
    }
    // SAFETY: `routes` ist gültig (Status 0); Kopf lesen.
    // aegis-unsafe: winffi-lan-routes-head
    #[allow(unsafe_code)]
    let (count, first) = unsafe {
        (
            (*routes).NumEntries,
            (&raw const (*routes).Table).cast::<MIB_IPFORWARD_ROW2>(),
        )
    };
    let routes = rows(routes, count, first);
    let mut addresses: *mut MIB_UNICASTIPADDRESS_TABLE = ptr::null_mut();
    // SAFETY: wie oben.
    // aegis-unsafe: winffi-lan-addresses
    #[allow(unsafe_code)]
    let status = unsafe { GetUnicastIpAddressTable(AF_INET, &mut addresses) };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(-1),
        ));
    }
    // SAFETY: `addresses` ist gültig (Status 0).
    // aegis-unsafe: winffi-lan-addresses-head
    #[allow(unsafe_code)]
    let (count, first) = unsafe {
        (
            (*addresses).NumEntries,
            (&raw const (*addresses).Table).cast::<MIB_UNICASTIPADDRESS_ROW>(),
        )
    };
    let addresses = rows(addresses, count, first);
    let mut out = Vec::new();
    for a in &addresses {
        let Some(address) = v4(&a.Address) else {
            continue;
        };
        if address.is_loopback() || address.is_link_local() {
            continue;
        }
        let route = routes
            .iter()
            .filter(|r| {
                r.InterfaceIndex == a.InterfaceIndex && r.DestinationPrefix.PrefixLength == 0
            })
            .min_by_key(|r| r.Metric);
        let gateway = route
            .and_then(|r| v4(&r.NextHop))
            .filter(|g| !g.is_unspecified());
        // SAFETY: NET_LUID_LH ist eine Union aus einem u64 und Bitfeldern derselben Größe.
        // aegis-unsafe: winffi-lan-luid
        #[allow(unsafe_code)]
        let luid = unsafe { a.InterfaceLuid.Value };
        out.push(LocalNet {
            address,
            prefix: a.OnLinkPrefixLength,
            gateway,
            interface: a.InterfaceIndex,
            if_type: u16::try_from((luid >> 48) & 0xffff).unwrap_or(0),
            metric: route.map(|r| r.Metric),
        });
    }
    Ok(out)
}

/// IPv4-Nachbarn mit bekannter Hardware-Adresse (erreichbar, veraltet oder fest).
///
/// # Errors
/// Tabelle nicht lesbar.
pub fn neighbors() -> io::Result<Vec<Neighbor>> {
    let mut table: *mut MIB_IPNET_TABLE2 = ptr::null_mut();
    // SAFETY: Ausgabezeiger gültig; `rows` gibt frei.
    // aegis-unsafe: winffi-lan-neighbors
    #[allow(unsafe_code)]
    let status = unsafe { GetIpNetTable2(AF_INET, &mut table) };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(-1),
        ));
    }
    // SAFETY: `table` ist gültig (Status 0).
    // aegis-unsafe: winffi-lan-neighbors-head
    #[allow(unsafe_code)]
    let (count, first) = unsafe {
        (
            (*table).NumEntries,
            (&raw const (*table).Table).cast::<MIB_IPNET_ROW2>(),
        )
    };
    Ok(rows(table, count, first)
        .iter()
        .filter(|r| {
            r.PhysicalAddressLength == 6
                && [NlnsReachable, NlnsStale, NlnsPermanent].contains(&r.State)
        })
        .filter_map(|r| {
            let address = v4(&r.Address)?;
            let mut mac = [0u8; 6];
            mac.copy_from_slice(&r.PhysicalAddress[..6]);
            (mac != [0; 6] && mac != [0xff; 6]).then_some(Neighbor {
                address,
                mac,
                interface: r.InterfaceIndex,
            })
        })
        .collect())
}

/// ICMP-Echo an `target`; `Some(Laufzeit in ms)` bei Antwort.
///
/// # Errors
/// ICMP nicht verfügbar.
pub fn ping(target: Ipv4Addr, timeout_ms: u32) -> io::Result<Option<u32>> {
    // SAFETY: keine Parameter.
    // aegis-unsafe: winffi-icmp-open
    #[allow(unsafe_code)]
    let handle: HANDLE = unsafe { IcmpCreateFile() };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let payload = *b"AEGIS-Heimnetz";
    // Antwortpuffer: eine Antwort + Nutzdaten + 8 Byte (laut Doku) + Reserve.
    let mut reply = vec![0u8; size_of::<ICMP_ECHO_REPLY>() + payload.len() + 64];
    // SAFETY: Handle gültig; Nutzdaten und Antwortpuffer leben bis nach dem Aufruf, Längen
    // passen; keine IP-Optionen.
    // aegis-unsafe: winffi-icmp-echo
    #[allow(unsafe_code)]
    let count = unsafe {
        IcmpSendEcho(
            handle,
            u32::from_ne_bytes(target.octets()),
            payload.as_ptr().cast(),
            u16::try_from(payload.len()).unwrap_or(0),
            ptr::null(),
            reply.as_mut_ptr().cast(),
            u32::try_from(reply.len()).unwrap_or(0),
            timeout_ms,
        )
    };
    let result = if count == 0 {
        None
    } else {
        // SAFETY: Bei count > 0 beginnt der Puffer mit einer ICMP_ECHO_REPLY; ungeprüft
        // ausgerichtet lesen.
        // aegis-unsafe: winffi-icmp-reply
        #[allow(unsafe_code)]
        let first = unsafe { ptr::read_unaligned(reply.as_ptr().cast::<ICMP_ECHO_REPLY>()) };
        (first.Status == 0 && first.Address == u32::from_ne_bytes(target.octets()))
            .then_some(first.RoundTripTime)
    };
    // SAFETY: Handle stammt von IcmpCreateFile, genau einmal geschlossen.
    // aegis-unsafe: winffi-icmp-close
    #[allow(unsafe_code)]
    unsafe {
        IcmpCloseHandle(handle);
    }
    Ok(result)
}

/// Sicherheit der verbundenen WLAN-Netze (leer ohne WLAN).
///
/// # Errors
/// WLAN-Dienst nicht erreichbar (z. B. kein WLAN-Adapter: leere Liste statt Fehler).
pub fn wifi_security() -> io::Result<Vec<WifiSecurity>> {
    let mut version = 0u32;
    let mut client: HANDLE = ptr::null_mut();
    // SAFETY: Ausgabezeiger gültig; Version 2 (Vista+).
    // aegis-unsafe: winffi-wlan-open
    #[allow(unsafe_code)]
    let status = unsafe { WlanOpenHandle(2, ptr::null(), &mut version, &mut client) };
    if status != 0 {
        // Kein WLAN-Dienst (Desktop ohne WLAN): nichts zu melden.
        return Ok(Vec::new());
    }
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
    // SAFETY: Client gültig; Liste wird mit WlanFreeMemory freigegeben.
    // aegis-unsafe: winffi-wlan-enum
    #[allow(unsafe_code)]
    let status = unsafe { WlanEnumInterfaces(client, ptr::null(), &mut list) };
    let mut out = Vec::new();
    if status == 0 && !list.is_null() {
        // SAFETY: `list` gültig; `dwNumberOfItems` Einträge ab `InterfaceInfo`.
        // aegis-unsafe: winffi-wlan-list
        #[allow(unsafe_code)]
        let interfaces: Vec<WLAN_INTERFACE_INFO> = unsafe {
            let count = usize::try_from((*list).dwNumberOfItems)
                .unwrap_or(0)
                .min(16);
            let first = (&raw const (*list).InterfaceInfo).cast::<WLAN_INTERFACE_INFO>();
            (0..count).map(|i| *first.add(i)).collect()
        };
        for interface in interfaces {
            let mut size = 0u32;
            let mut data: *mut core::ffi::c_void = ptr::null_mut();
            // SAFETY: Client und GUID gültig; Ausgabe wird mit WlanFreeMemory freigegeben.
            // aegis-unsafe: winffi-wlan-query
            #[allow(unsafe_code)]
            let status = unsafe {
                WlanQueryInterface(
                    client,
                    &raw const interface.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    ptr::null(),
                    &mut size,
                    &mut data,
                    ptr::null_mut(),
                )
            };
            if status != 0 || data.is_null() {
                continue;
            }
            if usize::try_from(size).unwrap_or(0) >= size_of::<WLAN_CONNECTION_ATTRIBUTES>() {
                // SAFETY: `data` enthält eine WLAN_CONNECTION_ATTRIBUTES (Größe geprüft).
                // aegis-unsafe: winffi-wlan-attributes
                #[allow(unsafe_code)]
                let attrs =
                    unsafe { ptr::read_unaligned(data.cast::<WLAN_CONNECTION_ATTRIBUTES>()) };
                let ssid = attrs.wlanAssociationAttributes.dot11Ssid;
                let len = usize::try_from(ssid.uSSIDLength).unwrap_or(0).min(32);
                let sec = attrs.wlanSecurityAttributes;
                out.push(WifiSecurity {
                    ssid: String::from_utf8_lossy(&ssid.ucSSID[..len]).into_owned(),
                    security_enabled: sec.bSecurityEnabled != 0,
                    auth: sec.dot11AuthAlgorithm,
                    cipher: sec.dot11CipherAlgorithm,
                });
            }
            // SAFETY: von WlanQueryInterface angelegt, genau einmal freigegeben.
            // aegis-unsafe: winffi-wlan-free-data
            #[allow(unsafe_code)]
            unsafe {
                WlanFreeMemory(data);
            }
        }
        // SAFETY: von WlanEnumInterfaces angelegt, genau einmal freigegeben.
        // aegis-unsafe: winffi-wlan-free-list
        #[allow(unsafe_code)]
        unsafe {
            WlanFreeMemory(list.cast());
        }
    }
    // SAFETY: Client von WlanOpenHandle, genau einmal geschlossen.
    // aegis-unsafe: winffi-wlan-close
    #[allow(unsafe_code)]
    unsafe {
        WlanCloseHandle(client, ptr::null());
    }
    Ok(out)
}
