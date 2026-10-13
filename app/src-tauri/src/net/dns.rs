//! DNS: eigene UDP-Anfragen (ohne zusätzliche Bibliothek) für den Vergleich öffentlicher
//! DNS-Dienste, Rückwärts-Auflösung für die Routen-Analyse, das Lesen des aktuellen Resolvers und
//! die Sicherung (kv `net.dnsBackup`) für „DNS automatisch einstellen“.
//!
//! Das eigentliche Setzen des DNS läuft über den Admin-Helfer (`crate::elevate`), damit die
//! einmalige Windows-Abfrage reicht. Alle Prüfungen (Live-Test, Nachkontrolle) laufen ohne
//! Adminrechte.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ping;
use super::types::{DnsProgress, DnsResult};

/// Zeitlimit je DNS-Anfrage.
pub const QUERY_TIMEOUT: Duration = Duration::from_millis(1000);
/// Zeitlimit der Live-Prüfung vor dem Einstellen eines DNS-Dienstes.
#[cfg_attr(not(windows), allow(dead_code))]
pub const LIVE_TIMEOUT: Duration = Duration::from_millis(1500);
/// Zeitbudget für eine Rückwärts-Auflösung (Routen-Analyse, nur Windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub const REVERSE_BUDGET: Duration = Duration::from_millis(300);
pub const DEFAULT_ROUNDS: u32 = 3;
pub const MAX_ROUNDS: u32 = 10;
/// Schlüssel der DNS-Sicherung im Schlüssel/Wert-Speicher.
pub const KV_DNS_BACKUP: &str = "net.dnsBackup";
/// Meldung außerhalb von Windows.
#[cfg_attr(windows, allow(dead_code))]
pub const NOT_WINDOWS: &str = "Nur unter Windows verfügbar.";

pub const QTYPE_A: u16 = 1;
pub const QTYPE_PTR: u16 = 12;
const QCLASS_IN: u16 = 1;

/// Domains, die im Vergleich nachgeschlagen werden (Spiele-Dienste, die jeder Spieler braucht).
pub const DOMAINS: [&str; 5] = ["steampowered.com", "epicgames.com", "riotgames.com", "cloudflare.com", "discord.com"];

/// Ein öffentlicher DNS-Dienst.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    /// IPv4 primär und sekundär
    pub v4: (&'static str, Option<&'static str>),
    /// IPv6-Adressen
    pub v6: &'static [&'static str],
    /// Darf „Automatisch optimieren“ diesen Dienst wählen? (Die Auswahl trifft die Oberfläche.)
    #[allow(dead_code)]
    pub auto: bool,
}

/// Feste DNS-Dienste laut Vertragstabelle.
pub const PROVIDERS: [Provider; 7] = [
    Provider { id: "cloudflare", name: "Cloudflare", v4: ("1.1.1.1", Some("1.0.0.1")), v6: &["2606:4700:4700::1111", "2606:4700:4700::1001"], auto: true },
    Provider { id: "google", name: "Google", v4: ("8.8.8.8", Some("8.8.4.4")), v6: &["2001:4860:4860::8888", "2001:4860:4860::8844"], auto: true },
    Provider { id: "quad9", name: "Quad9", v4: ("9.9.9.9", Some("149.112.112.112")), v6: &["2620:fe::fe", "2620:fe::9"], auto: true },
    Provider { id: "opendns", name: "OpenDNS", v4: ("208.67.222.222", Some("208.67.220.220")), v6: &["2620:119:35::35", "2620:119:53::53"], auto: true },
    Provider { id: "adguard", name: "AdGuard", v4: ("94.140.14.14", Some("94.140.15.15")), v6: &["2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff"], auto: false },
    Provider { id: "dns0", name: "DNS0.eu", v4: ("193.110.81.0", Some("185.253.5.0")), v6: &["2a0f:fc80::", "2a0f:fc81::"], auto: false },
    Provider { id: "mullvad", name: "Mullvad", v4: ("194.242.2.2", None), v6: &["2a07:e340::2"], auto: false },
];

/// Einen Dienst anhand der ID finden.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Provider {
    /// IPv4-Adressen (primär, dann sekundär) als Text.
    pub fn v4_servers(&self) -> Vec<String> {
        let mut out = vec![self.v4.0.to_string()];
        if let Some(s) = self.v4.1 {
            out.push(s.to_string());
        }
        out
    }

    /// IPv6-Adressen als Text.
    pub fn v6_servers(&self) -> Vec<String> {
        self.v6.iter().map(|s| s.to_string()).collect()
    }
}

/// ID des bekannten Dienstes, dessen primäre oder sekundäre IPv4-Adresse `servers[0]` ist.
pub fn provider_for(servers: &[String]) -> Option<String> {
    let first: IpAddr = servers.first()?.parse().ok()?;
    PROVIDERS.iter().find_map(|p| {
        let matches = p.v4.0.parse::<IpAddr>().ok() == Some(first)
            || p.v4.1.and_then(|s| s.parse::<IpAddr>().ok()) == Some(first);
        matches.then(|| p.id.to_string())
    })
}

/// `rounds` auf 1–10 begrenzen.
pub fn clamp_rounds(rounds: Option<u32>) -> u32 {
    rounds.unwrap_or(DEFAULT_ROUNDS).clamp(1, MAX_ROUNDS)
}

// ---------------------------------------------------------------------------------------------
// DNS-Server-Text lesen
// ---------------------------------------------------------------------------------------------

/// Veraltete IPv6-Platzhalter, die Windows einträgt (kein echter Resolver).
pub const IPV6_PLACEHOLDERS: [&str; 3] = ["fec0:0:0:ffff::1", "fec0:0:0:ffff::2", "fec0:0:0:ffff::3"];

/// Adressliste aus einem `NameServer`-Wert lesen (durch Komma und/oder Leerzeichen getrennt).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_name_server(value: &str) -> Vec<IpAddr> {
    value
        .split([',', ' ', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<IpAddr>().ok())
        .collect()
}

/// Ist das ein echter IPv6-Resolver (kein veralteter Platzhalter)?
pub fn is_real_ipv6_dns(ip: &std::net::Ipv6Addr) -> bool {
    !IPV6_PLACEHOLDERS.iter().any(|p| p.parse::<std::net::Ipv6Addr>().ok() == Some(*ip))
}

// ---------------------------------------------------------------------------------------------
// Pakete bauen und lesen
// ---------------------------------------------------------------------------------------------

/// Eine Standard-Anfrage (ein Frage-Eintrag, Rekursion erwünscht) bauen.
pub fn build_query(id: u16, name: &str, qtype: u16) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    out.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // AN/NS/AR
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("Ungültiger DNS-Name: {name}"));
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&QCLASS_IN.to_be_bytes());
    Ok(out)
}

/// Ein Antwort-Eintrag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsRecord {
    A(Ipv4Addr),
    Ptr(String),
    Other(u16),
}

/// Gelesene Antwort.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsResponse {
    pub id: u16,
    /// 0 = ok, 3 = Name existiert nicht (NXDOMAIN), 2 = Serverfehler, 5 = abgelehnt
    pub rcode: u8,
    pub answers: Vec<DnsRecord>,
}

fn be16(buf: &[u8], pos: usize) -> Result<u16, &'static str> {
    let b = buf.get(pos..pos + 2).ok_or("Antwort zu kurz")?;
    Ok(u16::from_be_bytes([b[0], b[1]]))
}

/// Namen lesen (mit Kompressions-Zeigern). Liefert den Namen und die Position nach dem Namen.
pub fn read_name(buf: &[u8], start: usize) -> Result<(String, usize), &'static str> {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = start;
    let mut end: Option<usize> = None;
    let mut jumps = 0;
    loop {
        let len = *buf.get(pos).ok_or("Name unvollständig")? as usize;
        if len == 0 {
            pos += 1;
            break;
        }
        if len & 0xC0 == 0xC0 {
            let ptr = (be16(buf, pos)? & 0x3FFF) as usize;
            if end.is_none() {
                end = Some(pos + 2);
            }
            jumps += 1;
            if jumps > 16 || ptr >= buf.len() {
                return Err("Ungültiger Kompressions-Zeiger");
            }
            pos = ptr;
            continue;
        }
        if len > 63 {
            return Err("Ungültiges Label");
        }
        let bytes = buf.get(pos + 1..pos + 1 + len).ok_or("Label unvollständig")?;
        labels.push(String::from_utf8_lossy(bytes).into_owned());
        pos += 1 + len;
        if labels.len() > 128 {
            return Err("Name zu lang");
        }
    }
    Ok((labels.join("."), end.unwrap_or(pos)))
}

/// Antwortpaket lesen. Fragen werden übersprungen, Antworten (A, PTR) ausgelesen.
pub fn parse_response(buf: &[u8]) -> Result<DnsResponse, &'static str> {
    if buf.len() < 12 {
        return Err("Antwort zu kurz");
    }
    let id = be16(buf, 0)?;
    let flags = be16(buf, 2)?;
    if flags & 0x8000 == 0 {
        return Err("Keine Antwort (QR-Bit fehlt)");
    }
    let rcode = (flags & 0x000F) as u8;
    let qd = be16(buf, 4)? as usize;
    let an = be16(buf, 6)? as usize;
    let mut pos = 12;
    for _ in 0..qd {
        let (_, next) = read_name(buf, pos)?;
        pos = next + 4;
    }
    let mut answers = Vec::with_capacity(an);
    for _ in 0..an {
        let (_, next) = read_name(buf, pos)?;
        pos = next;
        let rtype = be16(buf, pos)?;
        let rdlen = be16(buf, pos + 8)? as usize;
        let rdata_start = pos + 10;
        let rdata = buf.get(rdata_start..rdata_start + rdlen).ok_or("Antwortdaten unvollständig")?;
        let rec = match rtype {
            QTYPE_A if rdlen == 4 => DnsRecord::A(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3])),
            QTYPE_PTR => DnsRecord::Ptr(read_name(buf, rdata_start)?.0),
            other => DnsRecord::Other(other),
        };
        answers.push(rec);
        pos = rdata_start + rdlen;
    }
    Ok(DnsResponse { id, rcode, answers })
}

/// `1.2.3.4` → `4.3.2.1.in-addr.arpa`
pub fn reverse_name(ip: Ipv4Addr) -> String {
    let o = ip.octets();
    format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
}

// ---------------------------------------------------------------------------------------------
// Anfragen senden
// ---------------------------------------------------------------------------------------------

/// Warum eine Anfrage keinen Wert geliefert hat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryError {
    Timeout,
    Io(String),
    Bad(String),
}

fn next_id() -> u16 {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let salt = uuid::Uuid::new_v4().as_u128() as u16;
    salt ^ (COUNTER.fetch_add(1, Ordering::Relaxed) as u16)
}

/// Eine Anfrage senden und die Antwortzeit messen (ms). Antworten mit falscher ID werden
/// übersprungen, bis das Zeitlimit erreicht ist.
pub async fn query(server: SocketAddr, name: &str, qtype: u16, timeout: Duration) -> Result<(DnsResponse, f64), QueryError> {
    let id = next_id();
    let packet = build_query(id, name, qtype).map_err(QueryError::Bad)?;
    let bind: SocketAddr = if server.is_ipv4() { SocketAddr::from(([0, 0, 0, 0], 0)) } else { SocketAddr::from(([0u16; 8], 0)) };
    let sock = tokio::net::UdpSocket::bind(bind).await.map_err(|e| QueryError::Io(e.to_string()))?;
    sock.connect(server).await.map_err(|e| QueryError::Io(e.to_string()))?;
    let start = Instant::now();
    sock.send(&packet).await.map_err(|e| QueryError::Io(e.to_string()))?;
    let mut buf = vec![0u8; 1500];
    loop {
        let left = timeout.checked_sub(start.elapsed()).ok_or(QueryError::Timeout)?;
        let n = match tokio::time::timeout(left, sock.recv(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(QueryError::Io(e.to_string())),
            Err(_) => return Err(QueryError::Timeout),
        };
        match parse_response(&buf[..n]) {
            Ok(resp) if resp.id == id => return Ok((resp, ping::ms(start.elapsed()))),
            Ok(_) => continue,
            Err(e) => return Err(QueryError::Bad(e.into())),
        }
    }
}

/// Rückwärts-Auflösung einer IPv4-Adresse über den angegebenen Resolver, streng zeitlich begrenzt.
#[cfg_attr(not(windows), allow(dead_code))]
pub async fn reverse_lookup(ip: Ipv4Addr, server: SocketAddr, budget: Duration) -> Option<String> {
    let (resp, _) = query(server, &reverse_name(ip), QTYPE_PTR, budget).await.ok()?;
    if resp.rcode != 0 {
        return None;
    }
    resp.answers.into_iter().find_map(|r| match r {
        DnsRecord::Ptr(name) if !name.is_empty() => Some(name),
        _ => None,
    })
}

// ---------------------------------------------------------------------------------------------
// Aktueller Resolver
// ---------------------------------------------------------------------------------------------

/// DNS-Server der Hauptverbindung (Windows: Adapter mit Standard-Gateway; sonst `/etc/resolv.conf`).
pub fn system_dns_servers() -> Vec<IpAddr> {
    #[cfg(windows)]
    {
        super::adapters::primary_dns_servers()
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/etc/resolv.conf")
            .map(|s| parse_resolv_conf(&s))
            .unwrap_or_default()
    }
}

/// `nameserver`-Zeilen aus einer resolv.conf lesen.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_resolv_conf(text: &str) -> Vec<IpAddr> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#') && !l.starts_with(';'))
        .filter_map(|l| l.strip_prefix("nameserver"))
        .filter_map(|rest| rest.split_whitespace().next())
        .filter_map(|ip| ip.trim_end_matches('%').parse::<IpAddr>().ok().or_else(|| ip.split('%').next()?.parse().ok()))
        .collect()
}

/// Anzeigename für den aktuell eingestellten DNS.
pub fn current_name(ip: IpAddr) -> String {
    if super::trace::is_private(ip) {
        format!("Router ({ip})")
    } else {
        format!("Aktueller DNS ({ip})")
    }
}

// ---------------------------------------------------------------------------------------------
// Vergleich
// ---------------------------------------------------------------------------------------------

/// Ein Dienst im Vergleich.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub primary: IpAddr,
    pub secondary: Option<String>,
    pub current: bool,
}

/// Kandidaten zusammenstellen: die festen Dienste plus der aktuelle Resolver (falls er nicht
/// ohnehin einer der festen ist – dann wird dieser als „aktuell“ markiert).
pub fn candidates(current: &[IpAddr]) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = PROVIDERS
        .iter()
        .filter_map(|p| {
            let primary: IpAddr = p.v4.0.parse().ok()?;
            let current = current.iter().any(|c| c == &primary || p.v4.1.and_then(|s| s.parse::<IpAddr>().ok()).is_some_and(|s| s == *c));
            Some(Candidate { id: p.id.into(), name: p.name.into(), primary, secondary: p.v4.1.map(str::to_string), current })
        })
        .collect();
    if let Some(first) = current.first().copied() {
        if !out.iter().any(|c| c.current) {
            out.push(Candidate {
                id: "current".into(),
                name: current_name(first),
                primary: first,
                secondary: current.get(1).map(|ip| ip.to_string()),
                current: true,
            });
        }
    }
    out
}

/// Messwerte eines Kandidaten (rein, testbar): erste Anfrage je Domain = „neu“, Wiederholungen =
/// „bekannt“. Median je Gruppe.
#[derive(Debug, Default, Clone)]
pub struct Measurements {
    pub uncached: Vec<f64>,
    pub cached: Vec<f64>,
    pub failed: u32,
}

impl Measurements {
    pub fn record(&mut self, round: u32, rtt: Option<f64>) {
        match rtt {
            Some(v) if round == 0 => self.uncached.push(v),
            Some(v) => self.cached.push(v),
            None => self.failed += 1,
        }
    }

    pub fn into_result(self, c: &Candidate) -> DnsResult {
        DnsResult {
            id: c.id.clone(),
            name: c.name.clone(),
            primary: c.primary.to_string(),
            secondary: c.secondary.clone(),
            cached_ms: ping::median(&self.cached),
            uncached_ms: ping::median(&self.uncached),
            failed: self.failed,
            current: c.current,
        }
    }
}

/// Ergebnisliste sortieren: schnellste „neue“ Antwort zuerst, ohne Messwert ans Ende.
pub fn sort_results(results: &mut [DnsResult]) {
    results.sort_by(|a, b| {
        let ka = a.uncached_ms.or(a.cached_ms).unwrap_or(f64::INFINITY);
        let kb = b.uncached_ms.or(b.cached_ms).unwrap_or(f64::INFINITY);
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.name.cmp(&b.name))
    });
}

/// Den Vergleich ausführen. Dienste laufen parallel, die Anfragen eines Dienstes nacheinander.
/// `on_progress` wird nach jeder Anfrage aufgerufen.
pub async fn benchmark(rounds: u32, current: &[IpAddr], on_progress: impl Fn(DnsProgress) + Sync) -> Vec<DnsResult> {
    let cands = candidates(current);
    let total = (cands.len() as u32) * rounds * DOMAINS.len() as u32;
    let done = AtomicU32::new(0);
    let on_progress = &on_progress;
    let done = &done;
    let mut results: Vec<DnsResult> = join_all(cands.iter().map(|c| async move {
        let server = SocketAddr::new(c.primary, 53);
        let mut m = Measurements::default();
        for round in 0..rounds {
            for domain in DOMAINS {
                let rtt = match query(server, domain, QTYPE_A, QUERY_TIMEOUT).await {
                    Ok((resp, ms)) if resp.rcode == 0 => Some(ms),
                    _ => None,
                };
                m.record(round, rtt);
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                on_progress(DnsProgress { done: d, total });
            }
        }
        m.into_result(c)
    }))
    .await;
    sort_results(&mut results);
    results
}

// ---------------------------------------------------------------------------------------------
// Sicherung (kv `net.dnsBackup`)
// ---------------------------------------------------------------------------------------------

/// Die gesicherten DNS-Server einer Adressfamilie. `dhcp` = es war nichts fest eingetragen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyBackup {
    pub dhcp: bool,
    pub servers: Vec<String>,
}

/// Der gesicherte DNS-Zustand eines Adapters (Original vor der ersten Änderung durch Pulsar).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsBackup {
    pub adapter: String,
    pub v4: FamilyBackup,
    pub v6: FamilyBackup,
    pub saved_at: i64,
}

pub type DnsBackups = BTreeMap<String, DnsBackup>;

/// Sicherungen aus dem gespeicherten JSON lesen; beschädigte Einträge werden übersprungen.
pub fn parse_backups(v: &Value) -> DnsBackups {
    let mut out = DnsBackups::new();
    if let Some(obj) = v.as_object() {
        for (id, entry) in obj {
            if let Ok(b) = serde_json::from_value::<DnsBackup>(entry.clone()) {
                out.insert(id.clone(), b);
            }
        }
    }
    out
}

/// Sicherungen als JSON; leer → `null`, damit der Schlüssel aus der Datenbank verschwindet.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn backups_to_value(map: &DnsBackups) -> Value {
    if map.is_empty() {
        return Value::Null;
    }
    serde_json::to_value(map).unwrap_or(Value::Null)
}

/// Sicherung anlegen, falls für diesen Adapter noch keine existiert (das Original zählt).
/// Liefert `true`, wenn in diesem Aufruf eine neue angelegt wurde.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn insert_if_absent(map: &mut DnsBackups, adapter_id: &str, backup: DnsBackup) -> bool {
    if map.contains_key(adapter_id) {
        return false;
    }
    map.insert(adapter_id.to_string(), backup);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mitgeschnittene Antwort auf `example.com A` (ID 0x1234, Frage + eine Antwort mit
    /// Kompressions-Zeiger auf den Namen in der Frage).
    const CAPTURED: &[u8] = &[
        0x12, 0x34, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // Header
        0x07, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 0x03, b'c', b'o', b'm', 0x00, // Name
        0x00, 0x01, 0x00, 0x01, // A, IN
        0xC0, 0x0C, // Zeiger auf Offset 12
        0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x0E, 0x10, // A, IN, TTL 3600
        0x00, 0x04, 93, 184, 216, 34, // RDLENGTH 4, 93.184.216.34
    ];

    #[test]
    fn build_query_matches_wire_format() {
        let q = build_query(0x1234, "example.com.", QTYPE_A).unwrap();
        assert_eq!(&q[..12], &[0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&q[12..], &CAPTURED[12..29]);
        assert!(build_query(1, "", QTYPE_A).is_err());
        assert!(build_query(1, "a..b", QTYPE_A).is_err());
        assert!(build_query(1, &"x".repeat(64), QTYPE_A).is_err());
    }

    #[test]
    fn parse_captured_response() {
        let r = parse_response(CAPTURED).expect("parse");
        assert_eq!(r.id, 0x1234);
        assert_eq!(r.rcode, 0);
        assert_eq!(r.answers, vec![DnsRecord::A(Ipv4Addr::new(93, 184, 216, 34))]);
    }

    #[test]
    fn parse_rejects_truncated_and_non_answers() {
        assert!(parse_response(&CAPTURED[..10]).is_err());
        assert!(parse_response(&CAPTURED[..40]).is_err(), "abgeschnittene Antwortdaten");
        let q = build_query(7, "example.com", QTYPE_A).unwrap();
        assert!(parse_response(&q).is_err(), "eine Frage ist keine Antwort");
        // Antwort mit NXDOMAIN und ohne Einträge
        let mut nx = CAPTURED[..29].to_vec();
        nx[3] = 0x83;
        nx[7] = 0;
        let r = parse_response(&nx).unwrap();
        assert_eq!(r.rcode, 3);
        assert!(r.answers.is_empty());
    }

    #[test]
    fn parse_ptr_with_compression_and_detects_pointer_loops() {
        // Antwort auf 4.3.2.1.in-addr.arpa PTR → host.example (Name teils per Zeiger)
        let mut buf = vec![0x00, 0x2A, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0];
        let q = build_query(0x2A, "4.3.2.1.in-addr.arpa", QTYPE_PTR).unwrap();
        buf.extend_from_slice(&q[12..]);
        buf.extend_from_slice(&[0xC0, 0x0C, 0x00, 0x0C, 0x00, 0x01, 0, 0, 0, 60]);
        let rdata = [4u8, b'h', b'o', b's', b't', 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 0];
        buf.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        buf.extend_from_slice(&rdata);
        let r = parse_response(&buf).unwrap();
        assert_eq!(r.answers, vec![DnsRecord::Ptr("host.example".into())]);
        assert_eq!(reverse_name(Ipv4Addr::new(1, 2, 3, 4)), "4.3.2.1.in-addr.arpa");

        // Zeiger auf sich selbst darf nicht endlos laufen
        let looped = [0xC0u8, 0x00];
        assert!(read_name(&looped, 0).is_err());
    }

    #[test]
    fn resolv_conf_and_candidates() {
        let servers = parse_resolv_conf("# Kommentar\nnameserver 192.168.178.1\nsearch lan\nnameserver 1.1.1.1 # x\nnameserver fe80::1%eth0\n");
        assert_eq!(servers.len(), 3, "{servers:?}");
        assert_eq!(servers[0], IpAddr::from([192, 168, 178, 1]));

        let c = candidates(&[IpAddr::from([192, 168, 178, 1])]);
        assert_eq!(c.len(), PROVIDERS.len() + 1);
        let cur = c.last().unwrap();
        assert_eq!(cur.id, "current");
        assert!(cur.current && cur.name.starts_with("Router ("), "{}", cur.name);
        assert!(c.iter().filter(|x| x.current).count() == 1);

        // Aktueller DNS ist schon ein bekannter Dienst → kein doppelter Eintrag
        let c2 = candidates(&[IpAddr::from([1, 0, 0, 1])]);
        assert_eq!(c2.len(), PROVIDERS.len());
        assert!(c2.iter().find(|x| x.id == "cloudflare").unwrap().current);

        assert!(candidates(&[]).iter().all(|x| !x.current));
        assert_eq!(clamp_rounds(None), 3);
        assert_eq!(clamp_rounds(Some(0)), 1);
        assert_eq!(clamp_rounds(Some(50)), 10);
    }

    #[test]
    fn measurements_split_cached_and_uncached_and_sort() {
        let c = Candidate { id: "x".into(), name: "X".into(), primary: IpAddr::from([9, 9, 9, 9]), secondary: None, current: false };
        let mut m = Measurements::default();
        m.record(0, Some(30.0));
        m.record(0, Some(10.0));
        m.record(1, Some(5.0));
        m.record(2, None);
        let r = m.into_result(&c);
        assert_eq!(r.uncached_ms, Some(20.0));
        assert_eq!(r.cached_ms, Some(5.0));
        assert_eq!(r.failed, 1);
        assert_eq!(r.primary, "9.9.9.9");

        let mk = |name: &str, u: Option<f64>| DnsResult {
            id: name.into(), name: name.into(), primary: String::new(), secondary: None, cached_ms: None, uncached_ms: u, failed: 0, current: false,
        };
        let mut v = vec![mk("c", None), mk("b", Some(20.0)), mk("a", Some(5.0))];
        sort_results(&mut v);
        assert_eq!(v.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[test]
    fn providers_match_contract_and_detect_by_ip() {
        assert_eq!(PROVIDERS.len(), 7);
        let cf = provider("cloudflare").unwrap();
        assert_eq!(cf.v4_servers(), vec!["1.1.1.1", "1.0.0.1"]);
        assert_eq!(cf.v6_servers(), vec!["2606:4700:4700::1111", "2606:4700:4700::1001"]);
        assert!(cf.auto);
        assert_eq!(provider("mullvad").unwrap().v4_servers(), vec!["194.242.2.2"]);
        assert!(!provider("adguard").unwrap().auto && !provider("dns0").unwrap().auto && !provider("mullvad").unwrap().auto);
        assert!(provider("gibtsnicht").is_none());
        // Nur cloudflare, google, quad9, opendns dürfen automatisch gewählt werden
        let autos: Vec<&str> = PROVIDERS.iter().filter(|p| p.auto).map(|p| p.id).collect();
        assert_eq!(autos, vec!["cloudflare", "google", "quad9", "opendns"]);

        // Erkennung über primäre oder sekundäre Adresse
        assert_eq!(provider_for(&["1.1.1.1".into()]).as_deref(), Some("cloudflare"));
        assert_eq!(provider_for(&["149.112.112.112".into(), "x".into()]).as_deref(), Some("quad9"));
        assert_eq!(provider_for(&["192.168.0.1".into()]), None);
        assert_eq!(provider_for(&[]), None);
    }

    #[test]
    fn parse_name_server_splits_and_filters_ipv6_placeholders() {
        assert_eq!(parse_name_server("1.1.1.1,1.0.0.1"), vec![IpAddr::from([1, 1, 1, 1]), IpAddr::from([1, 0, 0, 1])]);
        assert_eq!(parse_name_server("8.8.8.8 8.8.4.4"), vec![IpAddr::from([8, 8, 8, 8]), IpAddr::from([8, 8, 4, 4])]);
        assert_eq!(parse_name_server("  9.9.9.9 , , 149.112.112.112 ").len(), 2);
        assert!(parse_name_server("").is_empty());
        assert!(parse_name_server("kaputt, ").is_empty());
        let v6: Vec<IpAddr> = parse_name_server("2606:4700:4700::1111");
        assert_eq!(v6, vec!["2606:4700:4700::1111".parse::<IpAddr>().unwrap()]);
        for p in IPV6_PLACEHOLDERS {
            assert!(!is_real_ipv6_dns(&p.parse().unwrap()), "{p}");
        }
        assert!(is_real_ipv6_dns(&"2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn dns_backup_json_roundtrip_and_insert_if_absent() {
        let mut map = DnsBackups::new();
        let b = DnsBackup {
            adapter: "Ethernet".into(),
            v4: FamilyBackup { dhcp: true, servers: vec![] },
            v6: FamilyBackup { dhcp: false, servers: vec!["2606:4700:4700::1111".into()] },
            saved_at: 1_700_000_000_000,
        };
        assert!(insert_if_absent(&mut map, "{GUID}", b.clone()));
        // Vorhandene Sicherung wird nie überschrieben
        let other = DnsBackup { adapter: "Anders".into(), ..b.clone() };
        assert!(!insert_if_absent(&mut map, "{GUID}", other));
        assert_eq!(map["{GUID}"].adapter, "Ethernet");

        let v = backups_to_value(&map);
        assert_eq!(v["{GUID}"]["v4"]["dhcp"], serde_json::json!(true));
        assert_eq!(v["{GUID}"]["v6"]["servers"][0], serde_json::json!("2606:4700:4700::1111"));
        assert_eq!(parse_backups(&v), map);

        // Beschädigte Einträge überspringen
        let broken = serde_json::json!({ "{A}": { "adapter": "x" }, "{B}": b });
        assert_eq!(parse_backups(&broken).keys().collect::<Vec<_>>(), vec!["{B}"]);
        assert_eq!(backups_to_value(&DnsBackups::new()), Value::Null, "leer → Schlüssel löschen");
        assert!(parse_backups(&Value::Null).is_empty());
    }

    #[tokio::test]
    async fn query_roundtrip_against_local_fake_server() {
        let server = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            let (n, from) = server.recv_from(&mut buf).await.unwrap();
            // Antwort: gleiche ID, QR-Bit, Frage kopiert, eine A-Antwort
            let mut resp = buf[..n].to_vec();
            resp[2] = 0x81;
            resp[3] = 0x80;
            resp[7] = 1;
            resp.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 10, 0, 0, 1]);
            server.send_to(&resp, from).await.unwrap();
        });
        let (resp, ms) = query(addr, "steampowered.com", QTYPE_A, Duration::from_secs(2)).await.expect("Antwort");
        assert_eq!(resp.answers, vec![DnsRecord::A(Ipv4Addr::new(10, 0, 0, 1))]);
        assert!((0.0..2000.0).contains(&ms));
    }

    #[tokio::test]
    async fn query_times_out_without_answer() {
        let silent = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        let start = Instant::now();
        let r = query(addr, "example.com", QTYPE_A, Duration::from_millis(150)).await;
        assert_eq!(r.unwrap_err(), QueryError::Timeout);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(reverse_lookup(Ipv4Addr::new(1, 1, 1, 1), addr, Duration::from_millis(100)).await, None);
    }
}
