//! Heimnetz-Scanner (P7.4): läuft in der App mit den Rechten des Nutzers, nur auf Knopfdruck
//! und nur im eigenen privaten Subnetz (RFC 1918) einer LAN-/WLAN-Verbindung (nie über VPN-Tunnel). Gefunden wird per Ping und
//! Nachbartabelle; geprüft wird nur, ob wenige bekannte Dienste (Telnet, RDP, …) eine
//! Verbindung annehmen – ohne Anmeldung, ohne Passwörter, ohne etwas zu verändern.

use aegis_netwatch::lan::LanReport;

/// Prüft das eigene Heimnetz (dauert je nach Netzgröße einige Sekunden).
#[tauri::command]
pub async fn home_network_scan() -> Result<LanReport, String> {
    tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn scan() -> LanReport {
    LanReport::unavailable("windows_only")
}

#[cfg(windows)]
fn scan() -> LanReport {
    windows::scan().unwrap_or_else(|_| LanReport::unavailable("error"))
}

#[cfg(windows)]
mod windows {
    use std::collections::{BTreeMap, HashSet};
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use aegis_netwatch::lan::{
        LanDevice, LanReport, MAX_PROBED_DEVICES, PROBE_PORTS, hints, home_interface, hosts,
        is_private, mac_text, network_text, private_mac, sort_devices, ssdp_reply, wifi_info,
    };
    use aegis_winffi::lan;

    const PING_MS: u32 = 600;
    const PING_THREADS: usize = 64;
    const PORT_TIMEOUT: Duration = Duration::from_millis(400);
    const SSDP_WAIT: Duration = Duration::from_secs(2);

    pub fn scan() -> io::Result<LanReport> {
        let networks = lan::local_networks()?;
        // Nur LAN/WLAN mit Standardroute; bei mehreren die mit der kleinsten Metrik.
        let Some(net) = networks
            .iter()
            .filter(|n| is_private(n.address) && home_interface(n.if_type))
            .filter(|n| n.gateway.is_some())
            .min_by_key(|n| n.metric.unwrap_or(u32::MAX))
        else {
            return Ok(LanReport::unavailable("no_private_network"));
        };
        let Some((targets, limited)) = hosts(net.address, net.prefix) else {
            return Ok(LanReport::unavailable("no_private_network"));
        };
        let in_net: HashSet<Ipv4Addr> = targets.iter().copied().collect();
        let replies = ping_all(&targets);
        let mut devices: BTreeMap<Ipv4Addr, LanDevice> = BTreeMap::new();
        let mut add = |ip: Ipv4Addr, mac: Option<[u8; 6]>, rtt: Option<u32>| {
            let d = devices.entry(ip).or_insert_with(|| LanDevice {
                ip: ip.to_string(),
                mac: None,
                private_mac: false,
                gateway: Some(ip) == net.gateway,
                this_device: ip == net.address,
                rtt_ms: None,
                open_ports: Vec::new(),
            });
            if let Some(mac) = mac {
                d.mac = Some(mac_text(mac));
                d.private_mac = private_mac(mac);
            }
            if rtt.is_some() {
                d.rtt_ms = rtt;
            }
        };
        add(net.address, None, None);
        for (ip, rtt) in &replies {
            add(*ip, None, Some(*rtt));
        }
        for n in lan::neighbors().unwrap_or_default() {
            if n.interface == net.interface && in_net.contains(&n.address) {
                add(n.address, Some(n.mac), None);
            }
        }
        if let Some(gateway) = net.gateway.filter(|g| in_net.contains(g)) {
            add(gateway, None, None);
        }
        let probe: Vec<Ipv4Addr> = devices
            .values()
            .filter(|d| !d.this_device)
            .filter_map(|d| d.ip.parse().ok())
            .take(MAX_PROBED_DEVICES)
            .collect();
        let ports = Mutex::new(BTreeMap::new());
        std::thread::scope(|s| {
            for ip in &probe {
                let ports = &ports;
                s.spawn(move || {
                    let open = open_ports(*ip);
                    if let Ok(mut map) = ports.lock() {
                        map.insert(*ip, open);
                    }
                });
            }
        });
        for (ip, open) in ports.into_inner().unwrap_or_default() {
            if let Some(d) = devices.get_mut(&ip) {
                d.open_ports = open;
            }
        }
        let upnp = net.gateway.and_then(upnp_at);
        let wifi: Vec<_> = lan::wifi_security()
            .unwrap_or_default()
            .iter()
            .map(|w| wifi_info(&w.ssid, w.security_enabled, w.auth, w.cipher))
            .collect();
        let mut devices: Vec<LanDevice> = devices.into_values().collect();
        sort_devices(&mut devices);
        let hints = hints(&devices, &wifi, upnp);
        Ok(LanReport {
            available: true,
            reason: None,
            network: Some(network_text(net.address, net.prefix)),
            address: Some(net.address.to_string()),
            gateway: net.gateway.map(|g| g.to_string()),
            scanned: targets.len(),
            limited,
            devices,
            wifi,
            upnp,
            hints,
        })
    }

    /// Ping an alle Adressen, verteilt auf mehrere Threads.
    fn ping_all(targets: &[Ipv4Addr]) -> BTreeMap<Ipv4Addr, u32> {
        let found = Mutex::new(BTreeMap::new());
        let chunk = targets.len().div_ceil(PING_THREADS).max(1);
        std::thread::scope(|s| {
            for part in targets.chunks(chunk) {
                let found = &found;
                s.spawn(move || {
                    for ip in part {
                        if let Ok(Some(rtt)) = lan::ping(*ip, PING_MS)
                            && let Ok(mut map) = found.lock()
                        {
                            map.insert(*ip, rtt);
                        }
                    }
                });
            }
        });
        found.into_inner().unwrap_or_default()
    }

    /// Nimmt das Gerät auf den geprüften Ports Verbindungen an? (Verbindung wird sofort
    /// wieder geschlossen, es wird nichts gesendet.)
    fn open_ports(ip: Ipv4Addr) -> Vec<u16> {
        PROBE_PORTS
            .iter()
            .filter(|(port, _)| {
                TcpStream::connect_timeout(&SocketAddr::from((ip, *port)), PORT_TIMEOUT).is_ok()
            })
            .map(|(port, _)| *port)
            .collect()
    }

    /// Antwortet der Router auf eine UPnP-Suche (SSDP)? `None` = nicht prüfbar.
    fn upnp_at(gateway: Ipv4Addr) -> Option<bool> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket
            .set_read_timeout(Some(Duration::from_millis(300)))
            .ok()?;
        let request = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: upnp:rootdevice\r\n\r\n";
        socket
            .send_to(
                request.as_bytes(),
                (Ipv4Addr::new(239, 255, 255, 250), 1900),
            )
            .ok()?;
        let deadline = Instant::now() + SSDP_WAIT;
        let mut buffer = [0u8; 2048];
        while Instant::now() < deadline {
            if let Ok((len, SocketAddr::V4(from))) = socket.recv_from(&mut buffer)
                && *from.ip() == gateway
                && ssdp_reply(&String::from_utf8_lossy(&buffer[..len]))
            {
                return Some(true);
            }
        }
        Some(false)
    }
}
