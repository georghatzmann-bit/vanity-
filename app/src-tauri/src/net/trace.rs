//! Routen-Analyse (Traceroute): ICMP-Echos mit steigender TTL über die IP-Helper-API – ohne
//! Adminrechte. Je Station drei Messungen, Event `net://trace` je Station.
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::IpAddr;
use std::time::Duration;

/// Fehlertext außerhalb von Windows.
#[cfg_attr(windows, allow(dead_code))]
pub const NOT_WINDOWS: &str = "Nur unter Windows verfügbar.";
pub const DEFAULT_MAX_HOPS: u8 = 30;
pub const MAX_HOPS_LIMIT: u8 = 64;
/// Messungen je Station.
pub const PROBES: usize = 3;
/// Zeitlimit je Messung.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);
/// Nach so vielen stummen Stationen in Folge wird abgebrochen (Ziel filtert ICMP).
pub const MAX_SILENT_HOPS: u32 = 8;
/// So viele öffentliche Stationen nach dem Heimnetz gelten noch als Anbieter-Netz.
pub const ISP_HOPS: u32 = 3;

/// `maxHops` auf 1–64 begrenzen.
pub fn clamp_hops(max_hops: Option<u8>) -> u8 {
    max_hops.unwrap_or(DEFAULT_MAX_HOPS).clamp(1, MAX_HOPS_LIMIT)
}

/// Private bzw. nicht im Internet geroutete Adressen (Heimnetz, Carrier-NAT, Link-Local).
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64.0.0/10 (CGNAT)
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || (s[0] & 0xFE00) == 0xFC00 // fc00::/7 (ULA)
                || (s[0] & 0xFFC0) == 0xFE80 // fe80::/10 (Link-Local)
        }
    }
}

/// Ordnet Stationen entlang einer Route grob ein – reine Logik, testbar.
///
/// `lan` = private Adresse, `isp` = die ersten [`ISP_HOPS`] öffentlichen Stationen (und stumme
/// Stationen davor), `internet` = alles danach, `target` = das Ziel.
#[derive(Debug, Default)]
pub struct ZoneTracker {
    public_seen: u32,
}

impl ZoneTracker {
    pub fn classify(&mut self, address: Option<IpAddr>, is_target: bool) -> &'static str {
        if is_target {
            return "target";
        }
        match address {
            Some(ip) if is_private(ip) => "lan",
            Some(_) => {
                self.public_seen += 1;
                if self.public_seen <= ISP_HOPS {
                    "isp"
                } else {
                    "internet"
                }
            }
            None => {
                if self.public_seen < ISP_HOPS {
                    "isp"
                } else {
                    "internet"
                }
            }
        }
    }
}

#[cfg(windows)]
pub use win::run;

#[cfg(windows)]
mod win {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use futures_util::future::join_all;
    use tauri::{AppHandle, Emitter};

    use super::*;
    use crate::net::dns;
    use crate::net::ping::{self, icmp};
    use crate::net::types::{TraceHop, TraceResult};
    use crate::net::EVENT_TRACE;

    /// Route zum Ziel verfolgen. Sendet je Station `net://trace`.
    pub async fn run(app: &AppHandle, host: &str, max_hops: u8) -> Result<TraceResult, String> {
        let host = host.trim().to_string();
        let ip = ping::resolve_host(&host, true).await?;
        let IpAddr::V4(dst) = ip else {
            return Err(format!("„{host}“ hat keine IPv4-Adresse."));
        };
        let resolver: Option<SocketAddr> = dns::system_dns_servers().first().map(|ip| SocketAddr::new(*ip, 53));

        let mut tracker = ZoneTracker::default();
        let mut hops: Vec<TraceHop> = Vec::new();
        let mut reached = false;
        let mut silent = 0u32;

        for ttl in 1..=max_hops {
            let probes = join_all((0..PROBES).map(|_| {
                tokio::task::spawn_blocking(move || icmp::send_echo(dst, Some(ttl), PROBE_TIMEOUT))
            }))
            .await;

            let mut rtts: Vec<Option<f64>> = Vec::with_capacity(PROBES);
            let mut address: Option<Ipv4Addr> = None;
            let mut hit_target = false;
            for p in probes {
                match p {
                    Ok(Ok(Some(reply))) if reply.status == icmp::STATUS_SUCCESS || reply.status == icmp::STATUS_TTL_EXPIRED => {
                        rtts.push(Some(reply.rtt_ms));
                        address.get_or_insert(reply.from);
                        if reply.status == icmp::STATUS_SUCCESS && reply.from == dst {
                            hit_target = true;
                        }
                    }
                    Ok(Ok(Some(reply))) => {
                        // z. B. „Ziel nicht erreichbar“ von einem Router: Absender merken, Zeit zählt nicht
                        address.get_or_insert(reply.from);
                        rtts.push(None);
                    }
                    _ => rtts.push(None),
                }
            }

            let zone = tracker.classify(address.map(IpAddr::V4), hit_target);
            let hostname = match (address, resolver) {
                (Some(a), Some(r)) => dns::reverse_lookup(a, r, dns::REVERSE_BUDGET).await,
                _ => None,
            };
            let hop = TraceHop { hop: ttl, address: address.map(|a| a.to_string()), hostname, rtts, zone: zone.into() };
            let _ = app.emit(EVENT_TRACE, &hop);
            hops.push(hop);

            if hit_target {
                reached = true;
                break;
            }
            if address.is_none() {
                silent += 1;
                if silent >= MAX_SILENT_HOPS {
                    break;
                }
            } else {
                silent = 0;
            }
        }

        Ok(TraceResult { target: host, address: Some(dst.to_string()), hops, reached })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Option<IpAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn private_ranges() {
        for p in ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.178.1", "100.64.12.1", "100.127.0.1", "127.0.0.1", "169.254.1.1", "fe80::1", "fd00::1", "::1"] {
            assert!(is_private(p.parse().unwrap()), "{p} ist privat");
        }
        for p in ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "62.155.240.129", "2606:4700::1111"] {
            assert!(!is_private(p.parse().unwrap()), "{p} ist öffentlich");
        }
    }

    #[test]
    fn zones_along_a_typical_route() {
        let mut z = ZoneTracker::default();
        assert_eq!(z.classify(ip("192.168.178.1"), false), "lan");
        assert_eq!(z.classify(ip("100.64.12.1"), false), "lan");
        assert_eq!(z.classify(ip("62.155.240.129"), false), "isp");
        assert_eq!(z.classify(None, false), "isp", "stumme Station früh = noch Anbieter");
        assert_eq!(z.classify(ip("80.157.204.182"), false), "isp");
        assert_eq!(z.classify(ip("80.157.204.183"), false), "isp");
        assert_eq!(z.classify(ip("52.93.35.126"), false), "internet");
        assert_eq!(z.classify(None, false), "internet");
        assert_eq!(z.classify(ip("3.123.1.77"), true), "target");
    }

    #[test]
    fn target_wins_even_if_private_and_hops_are_clamped() {
        let mut z = ZoneTracker::default();
        assert_eq!(z.classify(ip("192.168.1.10"), true), "target");
        assert_eq!(clamp_hops(None), 30);
        assert_eq!(clamp_hops(Some(0)), 1);
        assert_eq!(clamp_hops(Some(200)), 64);
    }
}
