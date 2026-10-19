//! Heimnetz-Scanner (P7.4): nur das **eigene** private Subnetz, nur auf Knopfdruck. Geräte
//! werden per Ping und Nachbartabelle gefunden, wenige bekannte Dienste (Telnet, RDP, …) per
//! TCP-Verbindungsversuch erkannt; dazu Hinweise zu Router und WLAN. Nichts wird verändert,
//! kein Gerät angemeldet, kein Passwort probiert.

use std::net::Ipv4Addr;

use serde::Serialize;

/// Höchstzahl geprüfter Adressen (größere Netze: nur das /24 um die eigene Adresse).
pub const MAX_HOSTS: usize = 1022;
/// Höchstzahl Geräte, deren Dienste geprüft werden.
pub const MAX_PROBED_DEVICES: usize = 64;

/// Geprüfte Dienste (TCP-Port, Kurzname).
pub const PROBE_PORTS: [(u16, &str); 10] = [
    (21, "ftp"),
    (22, "ssh"),
    (23, "telnet"),
    (80, "http"),
    (139, "netbios"),
    (443, "https"),
    (445, "smb"),
    (3389, "rdp"),
    (5900, "vnc"),
    (8080, "http-alt"),
];

/// Privates Netz nach RFC 1918 (nur dort scannt AEGIS).
#[must_use]
pub fn is_private(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

/// Zu prüfende Adressen im eigenen Netz (ohne Netz-, Broadcast- und eigene Adresse) und ob
/// das Netz größer war als das Geprüfte. `None`, wenn das Netz nicht privat ist.
#[must_use]
pub fn hosts(address: Ipv4Addr, prefix: u8) -> Option<(Vec<Ipv4Addr>, bool)> {
    if !is_private(address) || prefix > 32 {
        return None;
    }
    let full = 32 - u32::from(prefix);
    let max_bits = (MAX_HOSTS + 2).ilog2();
    let (bits, limited) = if full > max_bits {
        (8, true)
    } else {
        (full, false)
    };
    if bits < 2 {
        return Some((Vec::new(), limited));
    }
    let mask = u32::MAX << bits;
    let base = u32::from(address) & mask;
    let last = base | !mask;
    let own = u32::from(address);
    Some((
        ((base + 1)..last)
            .filter(|&a| a != own)
            .map(Ipv4Addr::from)
            .collect(),
        limited,
    ))
}

/// Netz in Kurzschreibweise (`192.168.1.0/24`).
#[must_use]
pub fn network_text(address: Ipv4Addr, prefix: u8) -> String {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix.min(32)))
    };
    format!(
        "{}/{}",
        Ipv4Addr::from(u32::from(address) & mask),
        prefix.min(32)
    )
}

/// MAC als Text (`AA:BB:CC:DD:EE:FF`).
#[must_use]
pub fn mac_text(mac: [u8; 6]) -> String {
    mac.iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Zufällige („private“) MAC: lokal verwaltetes Bit gesetzt – typisch für Handys.
#[must_use]
pub fn private_mac(mac: [u8; 6]) -> bool {
    mac[0] & 0x02 != 0
}

/// Ein gefundenes Gerät.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanDevice {
    /// Adresse.
    pub ip: String,
    /// Hardware-Adresse, falls bekannt.
    pub mac: Option<String>,
    /// Zufällige MAC (Handy/Tablet mit Datenschutz-Adresse)?
    pub private_mac: bool,
    /// Router (Standard-Gateway)?
    pub gateway: bool,
    /// Dieser PC?
    pub this_device: bool,
    /// Antwort auf Ping (ms), falls geantwortet.
    pub rtt_ms: Option<u32>,
    /// Offene geprüfte Dienste (Ports).
    pub open_ports: Vec<u16>,
}

/// WLAN der aktuellen Verbindung (eingeordnet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WifiInfo {
    /// Netzname.
    pub ssid: String,
    /// `open`, `wep`, `wpa`, `wpa2`, `wpa3`, `owe`, `enterprise` oder `unknown`.
    pub security: String,
    /// TKIP (veraltet) im Einsatz?
    pub tkip: bool,
}

/// Ordnet `DOT11_AUTH_ALGORITHM`/`DOT11_CIPHER_ALGORITHM` ein.
#[must_use]
pub fn wifi_info(ssid: &str, enabled: bool, auth: i32, cipher: i32) -> WifiInfo {
    let wep_cipher = matches!(cipher, 1 | 5 | 257);
    let security = match (enabled, auth) {
        (false, _) | (true, 1) if !wep_cipher => "open",
        _ if wep_cipher || auth == 2 => "wep",
        (_, 3 | 4) => "wpa",
        (_, 6) => "enterprise",
        (_, 7) => "wpa2",
        (_, 8 | 9) => "wpa3",
        (_, 11) => "enterprise",
        (_, 10) => "owe",
        _ => "unknown",
    };
    WifiInfo {
        ssid: ssid.chars().filter(|c| !c.is_control()).take(32).collect(),
        security: security.to_owned(),
        tkip: cipher == 2,
    }
}

/// Hinweis (Kennung für die Oberfläche, Schwere, betroffenes Gerät/Netz).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanHint {
    /// Kennung (`router_telnet`, `wifi_open`, …).
    pub id: String,
    /// `info`, `warn` oder `danger`.
    pub severity: String,
    /// Betroffene Adresse oder WLAN-Name.
    pub target: Option<String>,
}

fn hint(id: &str, severity: &str, target: Option<&str>) -> LanHint {
    LanHint {
        id: id.to_owned(),
        severity: severity.to_owned(),
        target: target.map(str::to_owned),
    }
}

/// Hinweise aus dem Scan.
#[must_use]
pub fn hints(devices: &[LanDevice], wifi: &[WifiInfo], upnp: Option<bool>) -> Vec<LanHint> {
    let mut out = Vec::new();
    for d in devices.iter().filter(|d| !d.this_device) {
        let open = |p: u16| d.open_ports.contains(&p);
        let target = Some(d.ip.as_str());
        if d.gateway {
            if open(23) {
                out.push(hint("router_telnet", "danger", target));
            }
            if open(21) {
                out.push(hint("router_ftp", "warn", target));
            }
            if (open(80) || open(8080)) && !open(443) {
                out.push(hint("router_http_only", "warn", target));
            }
        } else {
            if open(23) {
                out.push(hint("device_telnet", "danger", target));
            }
            if open(3389) {
                out.push(hint("device_rdp", "warn", target));
            }
            if open(5900) {
                out.push(hint("device_vnc", "warn", target));
            }
            if open(445) || open(139) {
                out.push(hint("device_smb", "info", target));
            }
        }
    }
    if upnp == Some(true) {
        let gateway = devices.iter().find(|d| d.gateway).map(|d| d.ip.as_str());
        out.push(hint("router_upnp", "warn", gateway));
    }
    for w in wifi {
        let target = Some(w.ssid.as_str());
        match w.security.as_str() {
            "open" => out.push(hint("wifi_open", "danger", target)),
            "wep" => out.push(hint("wifi_wep", "danger", target)),
            "wpa" => out.push(hint("wifi_wpa", "warn", target)),
            "wpa2" => out.push(hint("wifi_wpa2", "info", target)),
            _ => {}
        }
        if w.tkip && w.security != "wep" {
            out.push(hint("wifi_tkip", "warn", target));
        }
    }
    out
}

/// Ergebnis eines Scans.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LanReport {
    /// Scan möglich (Windows, privates Netz gefunden)?
    pub available: bool,
    /// Grund, falls nicht (`windows_only`, `no_private_network`, `error`).
    pub reason: Option<String>,
    /// Netz (`192.168.1.0/24`).
    pub network: Option<String>,
    /// Eigene Adresse.
    pub address: Option<String>,
    /// Router.
    pub gateway: Option<String>,
    /// Geprüfte Adressen.
    pub scanned: usize,
    /// Netz größer als geprüft (nur /24 um die eigene Adresse)?
    pub limited: bool,
    /// Geräte (Router zuerst, dann nach Adresse).
    pub devices: Vec<LanDevice>,
    /// WLAN-Verbindungen.
    pub wifi: Vec<WifiInfo>,
    /// UPnP am Router aktiv (`None` = unbekannt).
    pub upnp: Option<bool>,
    /// Hinweise.
    pub hints: Vec<LanHint>,
}

impl LanReport {
    /// Nicht verfügbar mit Grund.
    #[must_use]
    pub fn unavailable(reason: &str) -> Self {
        Self {
            reason: Some(reason.to_owned()),
            ..Self::default()
        }
    }
}

/// Sortiert: Router, dieser PC, dann nach Adresse.
pub fn sort_devices(devices: &mut [LanDevice]) {
    devices.sort_by_key(|d| {
        (
            !d.gateway,
            !d.this_device,
            d.ip.parse::<Ipv4Addr>().map_or(u32::MAX, u32::from),
        )
    });
}

/// Ist eine SSDP-Antwort von `gateway` (UPnP-Gerät)?
#[must_use]
pub fn ssdp_reply(text: &str) -> bool {
    let first = text.lines().next().unwrap_or("");
    first.starts_with("HTTP/1.1 200")
        && text.lines().any(|l| {
            l.to_ascii_lowercase().starts_with("st:") || l.to_ascii_lowercase().starts_with("usn:")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(ip: &str, gateway: bool, ports: &[u16]) -> LanDevice {
        LanDevice {
            ip: ip.to_owned(),
            mac: None,
            private_mac: false,
            gateway,
            this_device: false,
            rtt_ms: Some(1),
            open_ports: ports.to_vec(),
        }
    }

    #[test]
    fn nur_eigenes_privates_netz() {
        let (list, limited) = hosts(Ipv4Addr::new(192, 168, 1, 20), 24).unwrap();
        assert_eq!(list.len(), 253);
        assert!(!limited);
        assert!(!list.contains(&Ipv4Addr::new(192, 168, 1, 20)));
        assert!(!list.contains(&Ipv4Addr::new(192, 168, 1, 0)));
        assert!(!list.contains(&Ipv4Addr::new(192, 168, 1, 255)));
        let (list, limited) = hosts(Ipv4Addr::new(10, 1, 2, 3), 8).unwrap();
        assert!(limited);
        assert_eq!(list.len(), 253);
        assert!(list.iter().all(|a| a.octets()[..3] == [10, 1, 2]));
        let (list, limited) = hosts(Ipv4Addr::new(172, 16, 5, 9), 22).unwrap();
        assert_eq!(list.len(), 1021);
        assert!(!limited);
        assert!(hosts(Ipv4Addr::new(8, 8, 8, 8), 24).is_none());
        assert!(hosts(Ipv4Addr::new(100, 64, 0, 1), 24).is_none());
        assert!(
            hosts(Ipv4Addr::new(192, 168, 0, 1), 31)
                .unwrap()
                .0
                .is_empty()
        );
        assert_eq!(
            network_text(Ipv4Addr::new(192, 168, 1, 20), 24),
            "192.168.1.0/24"
        );
    }

    #[test]
    fn mac_und_wlan() {
        assert_eq!(mac_text([0xaa, 0, 1, 2, 3, 0xff]), "AA:00:01:02:03:FF");
        assert!(private_mac([0x02, 0, 0, 0, 0, 1]));
        assert!(!private_mac([0x00, 0x1a, 0, 0, 0, 1]));
        assert_eq!(wifi_info("Heim", false, 1, 0).security, "open");
        assert_eq!(wifi_info("Heim", true, 1, 5).security, "wep");
        assert_eq!(wifi_info("Heim", true, 4, 2).security, "wpa");
        assert!(wifi_info("Heim", true, 4, 2).tkip);
        assert_eq!(wifi_info("Heim", true, 7, 4).security, "wpa2");
        assert_eq!(wifi_info("Heim", true, 9, 4).security, "wpa3");
        assert_eq!(wifi_info("Firma", true, 6, 4).security, "enterprise");
        assert_eq!(wifi_info("a\u{7}b", true, 7, 4).ssid, "ab");
    }

    #[test]
    fn hinweise() {
        let devices = vec![
            device("192.168.1.1", true, &[23, 80]),
            device("192.168.1.30", false, &[3389, 445]),
            LanDevice {
                this_device: true,
                ..device("192.168.1.20", false, &[23])
            },
        ];
        let wifi = vec![wifi_info("Heim", true, 7, 2)];
        let ids: Vec<String> = hints(&devices, &wifi, Some(true))
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(
            ids,
            [
                "router_telnet",
                "router_http_only",
                "device_rdp",
                "device_smb",
                "router_upnp",
                "wifi_wpa2",
                "wifi_tkip"
            ]
        );
        assert!(hints(&[device("192.168.1.1", true, &[80, 443])], &[], None).is_empty());
    }

    #[test]
    fn sortierung_und_ssdp() {
        let mut d = vec![
            device("192.168.1.9", false, &[]),
            device("192.168.1.10", false, &[]),
            device("192.168.1.1", true, &[]),
        ];
        sort_devices(&mut d);
        assert_eq!(d[0].ip, "192.168.1.1");
        assert_eq!(d[1].ip, "192.168.1.9");
        assert!(ssdp_reply("HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n"));
        assert!(!ssdp_reply("NOTIFY * HTTP/1.1\r\n"));
    }
}
