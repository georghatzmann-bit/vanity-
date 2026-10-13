//! Einzelne Messungen: ICMP-Echo (Windows, ohne Adminrechte über `IcmpSendEcho`) und
//! TCP-Verbindungsaufbau (überall). Dazu die reine Statistik über eine Messreihe.
//!
//! Unter Linux/macOS gibt es kein ICMP ohne Rechte – dort wird ICMP stillschweigend durch TCP
//! ersetzt (nur für Entwicklung und Tests).

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use super::types::{PingMethod, PingStats, PingTarget};

/// Standard-Port für TCP-Messungen.
pub const DEFAULT_TCP_PORT: u16 = 443;
/// Zeitlimit je Messung.
pub const PING_TIMEOUT: Duration = Duration::from_millis(1500);
/// Abstand zwischen zwei Messungen einer Reihe.
pub const PING_SPACING: Duration = Duration::from_millis(200);
/// Zeitlimit für die Namensauflösung.
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);
/// Standardzahl der Messungen in `net_ping_once`.
pub const DEFAULT_COUNT: u32 = 4;
/// Obergrenze für `count` (schützt vor Minuten langen Aufrufen).
pub const MAX_COUNT: u32 = 20;

/// `count` aus der Oberfläche auf einen sinnvollen Bereich bringen.
pub fn clamp_count(count: Option<u32>) -> u32 {
    count.unwrap_or(DEFAULT_COUNT).clamp(1, MAX_COUNT)
}

/// Port eines Ziels (für TCP; ICMP braucht keinen).
pub fn target_port(target: &PingTarget) -> u16 {
    target.port.filter(|p| *p > 0).unwrap_or(DEFAULT_TCP_PORT)
}

/// Statistik über eine Messreihe – rein, ohne Nebenwirkungen. Entspricht `summarize()` in
/// `app/src/lib/grade.ts`: Jitter ist die mittlere absolute Abweichung aufeinanderfolgender
/// *erfolgreicher* Messungen, `loss` der Anteil verlorener Pakete (0–1).
pub fn summarize(target_id: &str, rtts: &[Option<f64>]) -> PingStats {
    let ok: Vec<f64> = rtts.iter().filter_map(|r| *r).filter(|v| v.is_finite()).collect();
    let n = rtts.len();
    let jitter = if ok.len() >= 2 {
        let acc: f64 = ok.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
        Some(acc / (ok.len() - 1) as f64)
    } else {
        None
    };
    let avg = if ok.is_empty() { None } else { Some(ok.iter().sum::<f64>() / ok.len() as f64) };
    PingStats {
        target_id: target_id.to_string(),
        last: rtts.last().copied().flatten(),
        avg,
        min: ok.iter().copied().reduce(f64::min),
        max: ok.iter().copied().reduce(f64::max),
        jitter,
        loss: if n == 0 { 0.0 } else { (n - ok.len()) as f64 / n as f64 },
        samples: n as u32,
    }
}

/// Statistik für ein Ziel, das gar nicht erreichbar war (z. B. Name nicht auflösbar).
pub fn all_lost(target_id: &str, count: u32) -> PingStats {
    summarize(target_id, &vec![None; count as usize])
}

/// Median einer Liste (None, wenn leer).
pub fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut s: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if s.is_empty() {
        return None;
    }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() / 2;
    Some(if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 })
}

/// Mittlere absolute Abweichung aufeinanderfolgender Werte (Jitter). None bei < 2 Werten.
pub fn mean_abs_diff(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    let acc: f64 = values.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
    Some(acc / (values.len() - 1) as f64)
}

/// Dauer in Millisekunden (Gleitkomma).
pub fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Fehlertext für einen nicht auflösbaren Namen.
pub fn resolve_error(host: &str) -> String {
    format!("Der Name „{host}“ konnte nicht aufgelöst werden.")
}

/// Hostname oder IP in eine Adresse umwandeln. IPv4 wird bevorzugt (ICMP kann nur IPv4);
/// `want_v4_only` erzwingt IPv4.
pub async fn resolve_host(host: &str, want_v4_only: bool) -> Result<IpAddr, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Kein Ziel angegeben.".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if want_v4_only && ip.is_ipv6() {
            return Err(format!("„{host}“ ist eine IPv6-Adresse – diese Messung braucht IPv4."));
        }
        return Ok(ip);
    }
    let lookup = tokio::time::timeout(RESOLVE_TIMEOUT, tokio::net::lookup_host((host, 0)));
    let addrs: Vec<SocketAddr> = match lookup.await {
        Ok(Ok(it)) => it.collect(),
        Ok(Err(_)) | Err(_) => return Err(resolve_error(host)),
    };
    let v4 = addrs.iter().map(|a| a.ip()).find(|ip| ip.is_ipv4());
    match v4 {
        Some(ip) => Ok(ip),
        None if want_v4_only => Err(format!("„{host}“ hat keine IPv4-Adresse.")),
        None => addrs.first().map(|a| a.ip()).ok_or_else(|| resolve_error(host)),
    }
}

/// Adresse für ein Messziel auflösen (ICMP → nur IPv4, sonst nicht unter Windows / ohne Fallback).
pub async fn resolve_target(target: &PingTarget) -> Result<IpAddr, String> {
    let v4_only = effective_method(target.method) == PingMethod::Icmp;
    resolve_host(&target.host, v4_only).await
}

/// Welche Methode tatsächlich benutzt wird (außerhalb von Windows: ICMP → TCP).
pub fn effective_method(method: PingMethod) -> PingMethod {
    if cfg!(windows) {
        method
    } else {
        PingMethod::Tcp
    }
}

/// Eine einzelne Messung zu einer bereits aufgelösten Adresse. `None` = keine Antwort innerhalb
/// des Zeitlimits (oder Fehler – wird wie ein Verlust gezählt).
pub async fn probe(target: &PingTarget, ip: IpAddr) -> Option<f64> {
    match effective_method(target.method) {
        PingMethod::Tcp => tcp_probe(SocketAddr::new(ip, target_port(target)), PING_TIMEOUT).await,
        PingMethod::Icmp => icmp_probe(ip, PING_TIMEOUT).await,
    }
}

/// Dauer des TCP-Verbindungsaufbaus (SYN → SYN/ACK) in ms.
pub async fn tcp_probe(addr: SocketAddr, timeout: Duration) -> Option<f64> {
    let start = Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(stream)) => {
            let rtt = ms(start.elapsed());
            drop(stream);
            Some(rtt)
        }
        _ => None,
    }
}

/// ICMP-Echo (nur Windows). Läuft blockierend in einem Hilfsthread.
#[cfg(windows)]
pub async fn icmp_probe(ip: IpAddr, timeout: Duration) -> Option<f64> {
    let IpAddr::V4(v4) = ip else { return None };
    let res = tokio::task::spawn_blocking(move || icmp::send_echo(v4, None, timeout)).await;
    match res {
        Ok(Ok(Some(reply))) if reply.status == icmp::STATUS_SUCCESS => Some(reply.rtt_ms),
        _ => None,
    }
}

/// Außerhalb von Windows gibt es kein ICMP ohne Rechte – TCP auf Port 443 als Ersatz.
#[cfg(not(windows))]
pub async fn icmp_probe(ip: IpAddr, timeout: Duration) -> Option<f64> {
    tcp_probe(SocketAddr::new(ip, DEFAULT_TCP_PORT), timeout).await
}

/// Eine Messreihe: `count` Messungen im Abstand von [`PING_SPACING`]. Fehler nur, wenn das Ziel
/// nicht aufgelöst werden kann.
pub async fn ping_series(target: &PingTarget, count: u32) -> Result<PingStats, String> {
    let ip = resolve_target(target).await?;
    let mut rtts = Vec::with_capacity(count as usize);
    for i in 0..count {
        if i > 0 {
            tokio::time::sleep(PING_SPACING).await;
        }
        rtts.push(probe(target, ip).await);
    }
    Ok(summarize(&target.id, &rtts))
}

// =============================================================================================
// Windows: ICMP über die IP-Helper-API (braucht keine Adminrechte, kein Raw-Socket)
// =============================================================================================

#[cfg(windows)]
pub mod icmp {
    use std::ffi::c_void;
    use std::net::Ipv4Addr;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION,
    };

    /// Antwort angekommen.
    pub const STATUS_SUCCESS: u32 = 0;
    /// TTL abgelaufen – Antwort kommt von einer Zwischenstation (Routen-Analyse).
    pub const STATUS_TTL_EXPIRED: u32 = 11013;
    /// Keine Antwort innerhalb des Zeitlimits.
    pub const STATUS_TIMED_OUT: u32 = 11010;

    /// Nutzdaten eines Echo-Pakets (32 Byte wie `ping.exe`).
    const PAYLOAD: [u8; 32] = [0x50; 32];

    /// Eine ICMP-Antwort.
    #[derive(Debug, Clone, Copy)]
    pub struct EchoReply {
        /// Windows-Statuscode (`IP_SUCCESS`, `IP_TTL_EXPIRED_TRANSIT`, …)
        pub status: u32,
        /// Absender der Antwort (beim Ziel: das Ziel; bei TTL-Ablauf: der Router)
        pub from: Ipv4Addr,
        /// Gemessene Antwortzeit in ms
        pub rtt_ms: f64,
    }

    /// Ein Echo senden und auf die Antwort warten (blockierend!). `Ok(None)` = Zeitüberschreitung.
    pub fn send_echo(dst: Ipv4Addr, ttl: Option<u8>, timeout: Duration) -> Result<Option<EchoReply>, String> {
        // SAFETY: Alle Aufrufe folgen der dokumentierten IP-Helper-API; der Antwortpuffer ist groß
        // genug (Antwortstruktur + Nutzdaten + Reserve für ICMP-Fehlermeldungen) und lebt bis nach
        // dem Aufruf. Das Handle wird in jedem Fall wieder geschlossen.
        let handle = unsafe { IcmpCreateFile() }
            .map_err(|e| format!("ICMP steht nicht zur Verfügung: {e}"))?;
        let options = IP_OPTION_INFORMATION {
            Ttl: ttl.unwrap_or(128),
            Tos: 0,
            Flags: 0,
            OptionsSize: 0,
            OptionsData: std::ptr::null_mut(),
        };
        let reply_len = std::mem::size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8 + 64;
        // u64-Puffer, damit die Antwortstruktur ausgerichtet liegt
        let mut buf = vec![0u64; reply_len.div_ceil(8)];
        let timeout_ms = timeout.as_millis().clamp(1, u32::MAX as u128) as u32;
        let start = Instant::now();
        let replies = unsafe {
            IcmpSendEcho(
                handle,
                u32::from_ne_bytes(dst.octets()),
                PAYLOAD.as_ptr() as *const c_void,
                PAYLOAD.len() as u16,
                Some(&options),
                buf.as_mut_ptr() as *mut c_void,
                (buf.len() * 8) as u32,
                timeout_ms,
            )
        };
        let elapsed = start.elapsed();
        let result = if replies == 0 {
            let code = unsafe { GetLastError() }.0;
            match code {
                STATUS_TIMED_OUT => Ok(None),
                // Andere IP-Statuscodes (11000er) heißen „keine brauchbare Antwort“ – kein Absturz
                11000..=11050 => Ok(None),
                _ => Err(format!("ICMP-Fehler {code}")),
            }
        } else {
            let reply: ICMP_ECHO_REPLY = unsafe { std::ptr::read(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
            Ok(Some(EchoReply {
                status: reply.Status,
                from: Ipv4Addr::from(reply.Address.to_ne_bytes()),
                // Eigene Zeitmessung (Sub-Millisekunden); `RoundTripTime` ist nur ganzzahlig.
                rtt_ms: elapsed.as_secs_f64() * 1000.0,
            }))
        };
        unsafe {
            let _ = IcmpCloseHandle(handle);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(method: PingMethod, host: &str, port: Option<u16>) -> PingTarget {
        PingTarget { id: "t".into(), label: "T".into(), host: host.into(), port, method }
    }

    #[test]
    fn summarize_basic_math() {
        let s = summarize("x", &[Some(10.0), Some(14.0), Some(12.0), None]);
        assert_eq!(s.target_id, "x");
        assert_eq!(s.samples, 4);
        assert_eq!(s.last, None, "letzte Messung war ein Verlust");
        assert_eq!(s.avg, Some(12.0));
        assert_eq!(s.min, Some(10.0));
        assert_eq!(s.max, Some(14.0));
        // |14-10| = 4, |12-14| = 2 → 3
        assert_eq!(s.jitter, Some(3.0));
        assert!((s.loss - 0.25).abs() < 1e-9);
    }

    #[test]
    fn summarize_handles_empty_and_all_lost() {
        let e = summarize("e", &[]);
        assert_eq!(e.samples, 0);
        assert_eq!(e.loss, 0.0);
        assert!(e.avg.is_none() && e.min.is_none() && e.max.is_none() && e.jitter.is_none() && e.last.is_none());

        let l = all_lost("l", 3);
        assert_eq!(l.samples, 3);
        assert_eq!(l.loss, 1.0);
        assert!(l.avg.is_none() && l.jitter.is_none());
    }

    #[test]
    fn summarize_jitter_needs_two_successes() {
        let s = summarize("j", &[Some(5.0), None, None]);
        assert_eq!(s.jitter, None);
        assert_eq!(s.avg, Some(5.0));
        assert_eq!(s.last, None);
        let s2 = summarize("j", &[None, Some(7.5)]);
        assert_eq!(s2.last, Some(7.5));
        assert_eq!(s2.loss, 0.5);
    }

    #[test]
    fn median_and_mean_abs_diff() {
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[3.0]), Some(3.0));
        assert_eq!(median(&[5.0, 1.0, 3.0]), Some(3.0));
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert_eq!(median(&[f64::NAN, 2.0]), Some(2.0));
        assert_eq!(mean_abs_diff(&[1.0]), None);
        assert_eq!(mean_abs_diff(&[1.0, 4.0, 2.0]), Some(2.5));
    }

    #[test]
    fn count_and_port_defaults() {
        assert_eq!(clamp_count(None), 4);
        assert_eq!(clamp_count(Some(0)), 1);
        assert_eq!(clamp_count(Some(999)), MAX_COUNT);
        assert_eq!(target_port(&t(PingMethod::Tcp, "h", None)), 443);
        assert_eq!(target_port(&t(PingMethod::Tcp, "h", Some(0))), 443);
        assert_eq!(target_port(&t(PingMethod::Tcp, "h", Some(27015))), 27015);
    }

    #[tokio::test]
    async fn resolve_accepts_literal_ips() {
        assert_eq!(resolve_host("127.0.0.1", true).await.unwrap(), IpAddr::from([127, 0, 0, 1]));
        assert!(resolve_host("::1", true).await.is_err(), "IPv6 ist für ICMP nicht erlaubt");
        assert!(resolve_host("::1", false).await.is_ok());
        assert!(resolve_host("", false).await.is_err());
    }

    #[tokio::test]
    async fn tcp_probe_measures_local_listener_and_detects_closed_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        let rtt = tcp_probe(addr, Duration::from_secs(2)).await;
        assert!(rtt.is_some_and(|v| (0.0..1000.0).contains(&v)), "{rtt:?}");
        drop(listener);
        // Geschlossener Port → Verbindung abgelehnt → Verlust
        assert_eq!(tcp_probe(addr, Duration::from_secs(2)).await, None);
    }

    #[tokio::test]
    async fn ping_series_reports_every_sample() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let target = t(PingMethod::Tcp, "127.0.0.1", Some(port));
        let stats = ping_series(&target, 2).await.expect("series");
        assert_eq!(stats.samples, 2);
        assert_eq!(stats.loss, 0.0);
        assert!(stats.avg.is_some());

        let bad = t(PingMethod::Tcp, "name-den-es-nicht-gibt.invalid", None);
        let err = ping_series(&bad, 1).await.unwrap_err();
        assert!(err.contains("aufgelöst"), "{err}");
    }
}
