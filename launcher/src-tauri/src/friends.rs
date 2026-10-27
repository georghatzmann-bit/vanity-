//! Playing with friends, the parts that touch the network (see docs/02-architecture.md,
//! "Playing with friends"):
//! - the host's addresses (`local_interfaces`),
//! - the tiny read-only "Rift host info" endpoint the host runs while hosting
//!   (`HostInfoServer`: TCP 7777, only on VPN/home-network addresses, one small JSON answer),
//! - the friend's check of that endpoint (`fetch_host_info`).
//! The rules themselves (which address, invite format, versions) live in `niobium_core::friends`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use niobium_core::friends::{self, HostInfo, HOST_INFO_MAX_BYTES, HOST_INFO_PATH, HOST_INFO_PORT};

/// The PC's IPv4 addresses with their adapter names (Windows: the name the user sees).
pub fn local_interfaces() -> Vec<(String, Ipv4Addr)> {
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    addrs
        .into_iter()
        .filter_map(|a| match a.ip() {
            std::net::IpAddr::V4(v4) => Some((a.name.clone(), v4)),
            _ => None,
        })
        .collect()
}

/// What the endpoint answers; updated from the server's pipe status.
#[derive(Debug, Clone)]
pub struct HostInfoState {
    pub version: String,
    pub cl: Option<u32>,
    /// The server's last pipe phase (`None` until it reports)
    pub server_phase: Option<String>,
    pub players: u32,
    pub port: u16,
}

impl HostInfoState {
    fn answer(&self) -> HostInfo {
        HostInfo {
            app: "rift".into(),
            version: self.version.clone(),
            cl: self.cl,
            phase: friends::host_phase(self.server_phase.as_deref()).into(),
            players: self.players,
            port: self.port,
        }
    }
}

/// At most this many answers per window; more connections are closed without an answer.
const RATE_MAX: u32 = 20;
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// New VPN addresses (e.g. Tailscale connected after Host & Play) are picked up this often.
const RESCAN: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// The endpoint. Runs while hosting; `stop` (or dropping it) ends it within a fraction of a second.
pub struct HostInfoServer {
    stop: Arc<AtomicBool>,
    pub state: Arc<Mutex<HostInfoState>>,
}

impl HostInfoServer {
    /// Starts one thread that listens on every allowed address (`friends::may_listen_on`) – never
    /// on 0.0.0.0. `log` gets one line per address it listens on (or can't).
    pub fn start(state: HostInfoState, log: impl Fn(String) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(state));
        let (stop2, state2) = (stop.clone(), state.clone());
        std::thread::spawn(move || serve(stop2, state2, log));
        Self { stop, state }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for HostInfoServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve(stop: Arc<AtomicBool>, state: Arc<Mutex<HostInfoState>>, log: impl Fn(String)) {
    let mut listeners: Vec<(Ipv4Addr, TcpListener)> = Vec::new();
    let mut tried: Vec<Ipv4Addr> = Vec::new();
    let mut last_scan: Option<Instant> = None;
    let (mut window_start, mut answered) = (Instant::now(), 0u32);
    while !stop.load(Ordering::SeqCst) {
        if last_scan.is_none_or(|t| t.elapsed() >= RESCAN) {
            last_scan = Some(Instant::now());
            for (adapter, ip) in local_interfaces() {
                if !friends::may_listen_on(ip, &adapter) || tried.contains(&ip) {
                    continue;
                }
                tried.push(ip);
                match TcpListener::bind(SocketAddr::from((ip, HOST_INFO_PORT))).and_then(|l| l.set_nonblocking(true).map(|_| l)) {
                    Ok(l) => {
                        log(format!("Friends can check your game at {ip} (host info, TCP {HOST_INFO_PORT})"));
                        listeners.push((ip, l));
                    }
                    Err(e) => log(format!("Host info can't listen on {ip}: {e}")),
                }
            }
        }
        let mut busy = false;
        for (_, l) in &listeners {
            if let Ok((stream, _)) = l.accept() {
                busy = true;
                if window_start.elapsed() >= RATE_WINDOW {
                    window_start = Instant::now();
                    answered = 0;
                }
                if answered >= RATE_MAX {
                    continue; // dropped: closes the connection
                }
                answered += 1;
                let answer = state.lock().map(|s| s.answer()).ok();
                if let Some(answer) = answer {
                    handle(stream, &answer);
                }
            }
        }
        if !busy {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Reads one small request and answers `GET /rift-host` with the JSON; anything else gets 404.
fn handle(mut stream: TcpStream, answer: &HostInfo) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut buf = [0u8; 1024];
    let mut n = 0;
    while n < buf.len() {
        match stream.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => {
                n += k;
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let wanted = format!("GET {HOST_INFO_PATH} ");
    let wanted_q = format!("GET {HOST_INFO_PATH}?");
    let ok = buf[..n].starts_with(wanted.as_bytes()) || buf[..n].starts_with(wanted_q.as_bytes());
    let body = if ok { serde_json::to_string(answer).unwrap_or_default() } else { String::new() };
    let status = if ok { "200 OK" } else { "404 Not Found" };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// Why the friend's Rift got no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCheckError {
    /// The PC answered, but nothing listens on TCP 7777 (not hosting, older Rift, or a firewall
    /// that rejects instead of dropping)
    Refused,
    /// No answer in time (wrong address, not in the same VPN network, PC off, firewall drops it)
    NoAnswer,
    /// Something answered, but not Rift
    NotRift,
}

/// Asks the host's Rift (3 s at most). Never through a proxy: the address is a VPN/home one.
pub fn fetch_host_info(ip: &str) -> Result<HostInfo, HostCheckError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(Some(Duration::from_secs(4)))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("http://{ip}:{HOST_INFO_PORT}{HOST_INFO_PATH}");
    let mut resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(ureq::Error::Io(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => return Err(HostCheckError::Refused),
        Err(ureq::Error::ConnectionFailed) => return Err(HostCheckError::Refused),
        Err(_) => return Err(HostCheckError::NoAnswer),
    };
    if resp.status() != 200 {
        return Err(HostCheckError::NotRift);
    }
    let body = resp
        .body_mut()
        .with_config()
        .limit(HOST_INFO_MAX_BYTES as u64)
        .read_to_string()
        .map_err(|_| HostCheckError::NotRift)?;
    friends::parse_host_info(&body).ok_or(HostCheckError::NotRift)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_only_the_host_info_path() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let info = HostInfoState { version: "19.10".into(), cl: Some(18675304), server_phase: Some("joinable".into()), players: 2, port: 7777 }.answer();
        let info2 = info.clone();
        let t = std::thread::spawn(move || {
            for _ in 0..2 {
                let (s, _) = l.accept().unwrap();
                handle(s, &info2);
            }
        });
        let ask = |req: &str| {
            let mut s = TcpStream::connect(addr).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        let ok = ask("GET /rift-host HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(ok.starts_with("HTTP/1.1 200 OK"));
        let body = ok.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(friends::parse_host_info(body), Some(info));
        let other = ask("POST /rift-host HTTP/1.1\r\n\r\n");
        assert!(other.starts_with("HTTP/1.1 404"));
        t.join().unwrap();
    }
}
