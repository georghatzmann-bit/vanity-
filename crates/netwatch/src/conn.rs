//! Netzwerk-Monitor (P7.1): Verbindungen je Programm einordnen (lokal/privat/Internet, Land,
//! Dienst) und neue Ziele erkennen. Rein – gelesen wird im Dienst, verändert wird nichts.

use std::collections::HashMap;
use std::net::IpAddr;

use serde::{Deserialize, Serialize};

/// Bereich einer Adresse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Eigener Rechner.
    Loopback,
    /// Heimnetz/Firmennetz (RFC 1918, ULA).
    Private,
    /// Link-lokal (169.254/16, fe80::/10).
    LinkLocal,
    /// Multicast/Broadcast.
    Multicast,
    /// Internet.
    Public,
}

/// Ordnet eine Adresse ein.
#[must_use]
pub fn scope(ip: IpAddr) -> Scope {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                Scope::Loopback
            } else if v4.is_private() || v4.octets()[0] == 100 && v4.octets()[1] & 0xc0 == 64 {
                // 100.64/10 (Carrier-NAT) zählt wie privat.
                Scope::Private
            } else if v4.is_link_local() {
                Scope::LinkLocal
            } else if v4.is_multicast() || v4.is_broadcast() {
                Scope::Multicast
            } else {
                Scope::Public
            }
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return scope(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            if v6.is_loopback() {
                Scope::Loopback
            } else if first & 0xfe00 == 0xfc00 {
                Scope::Private
            } else if first & 0xffc0 == 0xfe80 {
                Scope::LinkLocal
            } else if v6.is_multicast() {
                Scope::Multicast
            } else {
                Scope::Public
            }
        }
    }
}

/// Bekannter Dienst eines Ports.
#[must_use]
pub fn service(port: u16) -> Option<&'static str> {
    Some(match port {
        20 | 21 => "FTP",
        22 => "SSH",
        23 => "Telnet",
        25 | 465 | 587 => "E-Mail (SMTP)",
        53 => "DNS",
        80 | 8080 => "HTTP",
        110 | 995 => "E-Mail (POP3)",
        143 | 993 => "E-Mail (IMAP)",
        443 | 8443 => "HTTPS",
        445 => "Windows-Freigabe (SMB)",
        853 => "DNS über TLS",
        1194 => "VPN (OpenVPN)",
        1723 => "VPN (PPTP)",
        3389 => "Remotedesktop",
        5222 => "Chat (XMPP)",
        5900 => "VNC",
        6881..=6889 => "BitTorrent",
        9001 | 9030 => "Tor",
        _ => return None,
    })
}

/// Zustand einer TCP-Verbindung (MIB_TCP_STATE).
#[must_use]
pub fn state_name(state: u32) -> &'static str {
    match state {
        1 => "closed",
        2 => "listen",
        3 => "syn_sent",
        4 => "syn_received",
        5 => "established",
        6 => "fin_wait1",
        7 => "fin_wait2",
        8 => "close_wait",
        9 => "closing",
        10 => "last_ack",
        11 => "time_wait",
        12 => "delete_tcb",
        _ => "unknown",
    }
}

/// Eine Verbindung (wie gelesen).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawConnection {
    /// Prozess.
    pub pid: u32,
    /// Programm (Pfad) – falls lesbar.
    pub program: Option<String>,
    /// Gegenstelle.
    pub remote: IpAddr,
    /// Port der Gegenstelle.
    pub port: u16,
    /// Zustand.
    pub state: u32,
}

/// Eine eingeordnete Verbindung für die Oberfläche.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    /// Prozess.
    pub pid: u32,
    /// Programm (Pfad) – falls lesbar.
    pub program: Option<String>,
    /// Gegenstelle.
    pub remote: String,
    /// Port der Gegenstelle.
    pub port: u16,
    /// Bekannter Dienst.
    pub service: Option<String>,
    /// Zustand.
    pub state: String,
    /// Bereich.
    pub scope: Scope,
    /// Land (nur Internet).
    pub country: Option<String>,
    /// Erstmals gesehen (Unix-Sekunden).
    pub first_seen: i64,
    /// Neues Ziel dieses Programms (seit Beginn der Beobachtung)?
    pub new: bool,
}

/// Ein Ziel im Verlauf.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenDestination {
    /// Programm (Dateiname, klein).
    pub program: String,
    /// Gegenstelle.
    pub remote: String,
    /// Land.
    pub country: Option<String>,
    /// Erstmals gesehen (Unix-Sekunden).
    pub first: i64,
    /// Zuletzt gesehen (Unix-Sekunden).
    pub last: i64,
    /// Anzahl Beobachtungen.
    pub count: u32,
}

/// Programm-Kennung für den Verlauf: Dateiname in Kleinbuchstaben (ohne Pfad).
#[must_use]
pub fn program_key(program: Option<&str>) -> String {
    program
        .and_then(|p| p.rsplit(['\\', '/']).next())
        .map_or_else(|| "?".to_owned(), str::to_lowercase)
}

/// Verlauf der Ziele je Programm (begrenzt, älteste fallen heraus).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct History {
    entries: Vec<SeenDestination>,
    /// Beginn der Beobachtung (Unix-Sekunden); vorher Gesehenes zählt nicht als „neu“.
    started: Option<i64>,
}

/// Höchstzahl Ziele im Verlauf.
pub const MAX_HISTORY: usize = 2000;
/// Einträge älter als so viele Tage entfallen.
pub const HISTORY_DAYS: i64 = 30;

impl History {
    /// Nimmt eine Abfrage auf und ordnet die Verbindungen ein. `lookup` liefert das Land.
    pub fn observe(
        &mut self,
        now: i64,
        raw: &[RawConnection],
        lookup: &dyn Fn(IpAddr) -> Option<String>,
    ) -> Vec<Connection> {
        let baseline = self.started.is_none();
        let started = *self.started.get_or_insert(now);
        let cutoff = now - HISTORY_DAYS * 86_400;
        self.entries.retain(|e| e.last >= cutoff);
        let mut index: HashMap<(String, String), usize> = self
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| ((e.program.clone(), e.remote.clone()), i))
            .collect();
        let mut out = Vec::new();
        for c in raw {
            let sc = scope(c.remote);
            let country = (sc == Scope::Public).then(|| lookup(c.remote)).flatten();
            let remote = c.remote.to_string();
            let key = (program_key(c.program.as_deref()), remote.clone());
            let (first, new) = match index.get(&key) {
                Some(&i) => {
                    let e = &mut self.entries[i];
                    e.last = now;
                    e.count = e.count.saturating_add(1);
                    (e.first, false)
                }
                None => {
                    index.insert(key.clone(), self.entries.len());
                    self.entries.push(SeenDestination {
                        program: key.0,
                        remote: remote.clone(),
                        country: country.clone(),
                        first: now,
                        last: now,
                        count: 1,
                    });
                    // Bei der ersten Abfrage ist alles schon da – nichts davon ist „neu“.
                    (now, !baseline && now > started && sc == Scope::Public)
                }
            };
            out.push(Connection {
                pid: c.pid,
                program: c.program.clone(),
                remote,
                port: c.port,
                service: service(c.port).map(str::to_owned),
                state: state_name(c.state).to_owned(),
                scope: sc,
                country,
                first_seen: first,
                new,
            });
        }
        if self.entries.len() > MAX_HISTORY {
            self.entries.sort_by_key(|e| std::cmp::Reverse(e.last));
            self.entries.truncate(MAX_HISTORY);
        }
        out
    }

    /// Verlauf (zuletzt gesehen zuerst).
    #[must_use]
    pub fn entries(&self) -> Vec<SeenDestination> {
        let mut list = self.entries.clone();
        list.sort_by_key(|e| std::cmp::Reverse(e.last));
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(program: &str, ip: &str, port: u16) -> RawConnection {
        RawConnection {
            pid: 7,
            program: Some(program.into()),
            remote: ip.parse().unwrap(),
            port,
            state: 5,
        }
    }

    #[test]
    fn bereiche() {
        assert_eq!(scope("127.0.0.1".parse().unwrap()), Scope::Loopback);
        assert_eq!(scope("192.168.0.4".parse().unwrap()), Scope::Private);
        assert_eq!(scope("100.70.1.1".parse().unwrap()), Scope::Private);
        assert_eq!(scope("169.254.1.1".parse().unwrap()), Scope::LinkLocal);
        assert_eq!(scope("224.0.0.251".parse().unwrap()), Scope::Multicast);
        assert_eq!(scope("8.8.8.8".parse().unwrap()), Scope::Public);
        assert_eq!(scope("fd00::1".parse().unwrap()), Scope::Private);
        assert_eq!(scope("fe80::1".parse().unwrap()), Scope::LinkLocal);
        assert_eq!(scope("::1".parse().unwrap()), Scope::Loopback);
        assert_eq!(scope("::ffff:10.0.0.1".parse().unwrap()), Scope::Private);
        assert_eq!(scope("2a00:1450::1".parse().unwrap()), Scope::Public);
        assert_eq!(service(443), Some("HTTPS"));
        assert_eq!(service(9001), Some("Tor"));
        assert_eq!(service(12345), None);
        assert_eq!(state_name(5), "established");
    }

    #[test]
    fn neue_ziele_erst_nach_der_ersten_abfrage() {
        let mut h = History::default();
        let lookup = |_: IpAddr| Some("DE".to_owned());
        let first = h.observe(100, &[raw(r"C:\A\browser.exe", "1.2.3.4", 443)], &lookup);
        assert!(!first[0].new, "Grundlinie");
        assert_eq!(first[0].country.as_deref(), Some("DE"));
        let next = h.observe(
            110,
            &[
                raw(r"C:\A\browser.exe", "1.2.3.4", 443),
                raw(r"C:\Temp\x.exe", "5.6.7.8", 9001),
                raw(r"C:\Temp\x.exe", "192.168.1.1", 80),
            ],
            &lookup,
        );
        assert!(!next[0].new);
        assert!(next[1].new, "neues Internet-Ziel");
        assert_eq!(next[1].service.as_deref(), Some("Tor"));
        assert!(!next[2].new, "Heimnetz ist nie „neu“");
        assert_eq!(next[2].country, None);
        let list = h.entries();
        assert_eq!(list.len(), 3);
        assert_eq!(
            list.iter().find(|e| e.remote == "1.2.3.4").unwrap().count,
            2
        );
        // Nach 30 Tagen ohne Kontakt fällt ein Ziel heraus.
        h.observe(110 + 31 * 86_400, &[], &lookup);
        assert!(h.entries().is_empty());
    }

    #[test]
    fn verlauf_begrenzt() {
        let mut h = History::default();
        let lookup = |_: IpAddr| None;
        let many: Vec<RawConnection> = (0..2100u32)
            .map(|i| {
                raw(
                    "a.exe",
                    &std::net::Ipv4Addr::from(0x0101_0000 + i).to_string(),
                    443,
                )
            })
            .collect();
        h.observe(1, &many, &lookup);
        assert_eq!(h.entries().len(), MAX_HISTORY);
        assert_eq!(program_key(Some(r"C:\X\Browser.EXE")), "browser.exe");
        assert_eq!(program_key(None), "?");
    }
}
