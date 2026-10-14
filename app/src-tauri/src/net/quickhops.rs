//! Schnelle Teilroute für den Lag-Detektiv: TTL 1–3 parallel per ICMP, ohne Reverse-DNS, und die
//! Zonenregel der Teilroute (gleiche Regel in `app/src/lib/zones.ts`, Prüfdaten
//! `app/src/lib/fixtures/zones.json`). Vertrag: `docs/API.md`, „Lag-Detektiv“.
//!
//! `trace::win::run` und `ZoneTracker` bleiben unverändert – die Teilroute hat ihre eigene,
//! genauere Regel (CGNAT, doppeltes NAT).

// Außerhalb von Windows bleiben die ICMP-Wege ungenutzt (nur Tests).
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Zone einer Station.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Lan,
    Isp,
    Internet,
    Target,
}

impl Zone {
    /// Text wie in JSON (`net_events.detail`).
    pub fn as_str(self) -> &'static str {
        match self {
            Zone::Lan => "lan",
            Zone::Isp => "isp",
            Zone::Internet => "internet",
            Zone::Target => "target",
        }
    }
}

/// Eine Station der Teilroute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickHop {
    pub ttl: u8,
    /// Adresse der Station (`None` = keine Antwort). Nur live, nie gespeichert.
    pub address: Option<String>,
    /// Kleinere von 2 Antworten (ms)
    pub rtt: Option<f64>,
    /// `None` = stumme Station
    pub zone: Option<Zone>,
    /// Anbieter-Station hinter Carrier-NAT (Anzeige „Anbieter (CGNAT)“)
    pub cgnat: bool,
    /// Grundwert aus den Ruhe-Messungen (ms)
    pub base_ms: Option<f64>,
}

/// Standard: Stationen 1–3.
pub const DEFAULT_HOPS: u8 = 3;
/// Höchstens so viele Stationen (Schutz vor zu vielen gleichzeitigen Echos).
pub const MAX_HOPS: u8 = 8;
/// Zeitlimit je Echo.
pub const HOP_TIMEOUT: Duration = Duration::from_millis(600);
/// So viele öffentliche Stationen gehören noch zum Anbieter.
pub const ISP_PUBLIC_HOPS: u32 = 3;
/// Echos je Station.
pub const ECHOS_PER_HOP: usize = 2;

/// Carrier-NAT (`100.64.0.0/10`).
pub fn is_cgnat(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (64..=127).contains(&o[1])
        }
        IpAddr::V6(_) => false,
    }
}

/// Private Adresse im Sinne der Zonenregel (RFC 1918, Link-Local, Loopback; IPv6 ULA und
/// Link-Local) – **ohne** Carrier-NAT, das eine eigene Regel hat.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback() || (s[0] & 0xFE00) == 0xFC00 || (s[0] & 0xFFC0) == 0xFE80
        }
    }
}

/// Zonenregel der Teilroute (rein): Stationen in TTL-Reihenfolge (Index 0 = TTL 1) → Zone
/// (`None` = stumm).
///
/// - Gateway-Adresse oder TTL 1 mit privater Adresse → `lan`
/// - `100.64.0.0/10` → `isp` (CGNAT)
/// - private Adresse nach der ersten öffentlichen oder CGNAT-Station → `isp` (CGNAT)
/// - private Adresse vor jeder öffentlichen/CGNAT-Station (doppeltes NAT, Mesh) → `lan`
/// - die ersten 3 öffentlichen Stationen → `isp`, danach `internet`
///
/// Das Ziel (`target`) kennt nur der Aufrufer ([`assign_zones`], [`quick_hops`]).
pub fn zones(addrs: &[Option<IpAddr>], gateway: Option<Ipv4Addr>) -> Vec<Option<Zone>> {
    let mut beyond_home = false;
    let mut public_seen = 0u32;
    addrs
        .iter()
        .enumerate()
        .map(|(i, addr)| {
            let ip = (*addr)?;
            let is_gateway = matches!((ip, gateway), (IpAddr::V4(a), Some(g)) if a == g);
            Some(if is_gateway || (i == 0 && is_private(ip)) {
                Zone::Lan
            } else if is_cgnat(ip) {
                beyond_home = true;
                Zone::Isp
            } else if is_private(ip) {
                if beyond_home {
                    Zone::Isp
                } else {
                    Zone::Lan
                }
            } else {
                beyond_home = true;
                public_seen += 1;
                if public_seen <= ISP_PUBLIC_HOPS {
                    Zone::Isp
                } else {
                    Zone::Internet
                }
            })
        })
        .collect()
}

/// Anzeige „Anbieter (CGNAT)“: Anbieter-Station mit CGNAT- oder privater Adresse.
pub fn cgnat_flag(addr: Option<IpAddr>, zone: Option<Zone>) -> bool {
    zone == Some(Zone::Isp) && addr.is_some_and(|ip| is_cgnat(ip) || is_private(ip))
}

/// Zonen einer Teilroute (neu) setzen. Stationen, die schon als `target` erkannt sind (Antwort vom
/// Ziel selbst), bleiben `target`.
pub fn assign_zones(hops: &mut [QuickHop], gateway: Option<Ipv4Addr>) {
    let addrs: Vec<Option<IpAddr>> = hops.iter().map(|h| h.address.as_deref().and_then(|a| a.parse().ok())).collect();
    let zs = zones(&addrs, gateway);
    for ((hop, zone), addr) in hops.iter_mut().zip(zs).zip(addrs) {
        if hop.zone == Some(Zone::Target) {
            hop.cgnat = false;
            continue;
        }
        hop.zone = zone;
        hop.cgnat = cgnat_flag(addr, zone);
    }
}

/// Antworten der Echos einer Station: Absender (erste Antwort), kleinste Zeit, Ziel erreicht?
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HopReplies {
    pub from: Option<Ipv4Addr>,
    pub rtt: Option<f64>,
    pub reached: bool,
}

impl HopReplies {
    /// Eine Antwort einrechnen (`rtt = None`: Antwort ohne verwertbare Zeit, z. B. „nicht erreichbar“).
    pub fn add(&mut self, from: Ipv4Addr, rtt: Option<f64>, reached: bool) {
        self.from.get_or_insert(from);
        if let Some(r) = rtt.filter(|r| r.is_finite() && *r >= 0.0) {
            self.rtt = Some(self.rtt.map_or(r, |old: f64| old.min(r)));
        }
        self.reached |= reached;
    }

    fn into_hop(self, ttl: u8) -> QuickHop {
        QuickHop {
            ttl,
            address: self.from.map(|a| a.to_string()),
            rtt: self.rtt,
            zone: self.reached.then_some(Zone::Target),
            cgnat: false,
            base_ms: None,
        }
    }
}

/// Stationen aus den Antworten bauen (TTL 1..n, auch stumme) und die Zonen setzen (ohne Gateway –
/// die Momentaufnahme setzt sie mit dem Gateway neu).
pub fn build_hops(replies: Vec<HopReplies>) -> Vec<QuickHop> {
    let mut hops: Vec<QuickHop> =
        replies.into_iter().enumerate().map(|(i, r)| r.into_hop(u8::try_from(i + 1).unwrap_or(u8::MAX))).collect();
    assign_zones(&mut hops, None);
    hops
}

/// TTL 1..=n parallel, je 2 Echos (`spawn_blocking`, Zeitlimit `timeout` je Echo, ohne
/// Reverse-DNS). `rtt` = kleinere Antwort. Außerhalb von Windows → leere Liste.
#[cfg(windows)]
pub async fn quick_hops(dst: Ipv4Addr, n: u8, timeout: Duration) -> Vec<QuickHop> {
    use super::ping::icmp;
    use futures_util::future::join_all;

    let n = n.clamp(1, MAX_HOPS);
    let probes = (1..=n).flat_map(|ttl| (0..ECHOS_PER_HOP).map(move |_| ttl)).map(|ttl| async move {
        let res = tokio::task::spawn_blocking(move || icmp::send_echo(dst, Some(ttl), timeout)).await;
        (ttl, res)
    });
    let results = join_all(probes).await;
    let mut replies = vec![HopReplies::default(); usize::from(n)];
    for (ttl, res) in results {
        let Some(slot) = replies.get_mut(usize::from(ttl).saturating_sub(1)) else { continue };
        if let Ok(Ok(Some(reply))) = res {
            if reply.from.is_unspecified() {
                continue;
            }
            let answered = reply.status == icmp::STATUS_SUCCESS || reply.status == icmp::STATUS_TTL_EXPIRED;
            let reached = reply.status == icmp::STATUS_SUCCESS && reply.from == dst;
            slot.add(reply.from, answered.then_some(reply.rtt_ms), reached);
        }
    }
    build_hops(replies)
}

/// Außerhalb von Windows gibt es kein ICMP ohne Rechte → leere Liste.
#[cfg(not(windows))]
pub async fn quick_hops(dst: Ipv4Addr, n: u8, timeout: Duration) -> Vec<QuickHop> {
    let _ = (dst, n, timeout);
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../src/lib/fixtures/zones.json")).expect("zones.json")
    }

    fn zone_of(v: &Value) -> Option<Zone> {
        v.as_str().map(|s| serde_json::from_value(Value::String(s.into())).expect("Zone"))
    }

    #[test]
    fn zones_in_ttl_order() {
        let f = fixtures();
        let cases = f["cases"].as_array().expect("cases");
        assert!(cases.len() >= 4);
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let gateway: Option<Ipv4Addr> = c["gateway"].as_str().map(|g| g.parse().unwrap());
            let target = c["target"].as_u64().map(|i| i as usize);
            let mut hops: Vec<QuickHop> = c["hops"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, a)| QuickHop {
                    ttl: (i + 1) as u8,
                    address: a.as_str().map(String::from),
                    rtt: None,
                    zone: (Some(i) == target).then_some(Zone::Target),
                    cgnat: false,
                    base_ms: None,
                })
                .collect();
            assign_zones(&mut hops, gateway);
            let want_zones: Vec<Option<Zone>> = c["zones"].as_array().unwrap().iter().map(zone_of).collect();
            let want_cgnat: Vec<bool> = c["cgnat"].as_array().unwrap().iter().map(|b| b.as_bool().unwrap()).collect();
            assert_eq!(hops.iter().map(|h| h.zone).collect::<Vec<_>>(), want_zones, "Zonen: {name}");
            assert_eq!(hops.iter().map(|h| h.cgnat).collect::<Vec<_>>(), want_cgnat, "CGNAT: {name}");
            // Die reine Regel (ohne Ziel) stimmt bis auf das Ziel überein
            let addrs: Vec<Option<IpAddr>> = c["hops"].as_array().unwrap().iter().map(|a| a.as_str().map(|s| s.parse().unwrap())).collect();
            let plain = zones(&addrs, gateway);
            for (i, (p, w)) in plain.iter().zip(&want_zones).enumerate() {
                if Some(i) != target {
                    assert_eq!(p, w, "zones(): {name}, TTL {}", i + 1);
                }
            }
        }
    }

    #[test]
    fn replies_keep_smaller_rtt_and_first_sender() {
        let mut r = HopReplies::default();
        let a: Ipv4Addr = "192.168.178.1".parse().unwrap();
        r.add(a, Some(3.5), false);
        r.add("10.0.0.1".parse().unwrap(), Some(1.25), false);
        r.add(a, None, false);
        assert_eq!(r.from, Some(a));
        assert_eq!(r.rtt, Some(1.25));
        assert!(!r.reached);
        let target = HopReplies { from: Some("3.123.1.77".parse().unwrap()), rtt: Some(9.0), reached: true };
        let hops = build_hops(vec![r, HopReplies::default(), target]);
        assert_eq!(hops.len(), 3);
        assert_eq!((hops[0].ttl, hops[0].zone), (1, Some(Zone::Lan)));
        assert_eq!((hops[1].address.clone(), hops[1].zone, hops[1].rtt), (None, None, None));
        assert_eq!(hops[2].zone, Some(Zone::Target));
        let v = serde_json::to_value(&hops[2]).unwrap();
        assert_eq!(v["zone"], "target");
        assert_eq!(v["baseMs"], Value::Null);
        assert_eq!(Zone::Isp.as_str(), "isp");
    }

    #[test]
    fn address_ranges() {
        for p in ["10.1.2.3", "172.16.0.1", "192.168.178.1", "169.254.1.1", "fe80::1", "fd00::1"] {
            assert!(is_private(p.parse().unwrap()), "{p}");
        }
        for p in ["100.64.0.1", "8.8.8.8", "2606:4700::1111"] {
            assert!(!is_private(p.parse().unwrap()), "{p}");
        }
        assert!(is_cgnat("100.64.0.1".parse().unwrap()) && is_cgnat("100.127.255.255".parse().unwrap()));
        assert!(!is_cgnat("100.128.0.1".parse().unwrap()) && !is_cgnat("100.63.255.255".parse().unwrap()));
    }

    #[cfg(not(windows))]
    #[test]
    fn empty_outside_windows() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(quick_hops(Ipv4Addr::new(1, 1, 1, 1), 3, HOP_TIMEOUT)).is_empty());
    }
}
