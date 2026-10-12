//! Minimaler HTTP/1.1-Testserver (nur std): Range-Anfragen, Weiterleitungen, gezielte
//! Verbindungsabbrüche, Drosselung. Jede Verbindung beantwortet genau eine Anfrage.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub path: String,
    pub range: Option<String>,
    pub status: u16,
}

#[derive(Default)]
pub struct ServerState {
    pub files: HashMap<String, Vec<u8>>,
    pub redirects: HashMap<String, String>,
    pub requests: Vec<Recorded>,
    /// Einmalig: die nächste Antwort für diesen Pfad nach N Body-Bytes abbrechen.
    pub drop_after: Option<(String, u64)>,
    /// Range-Header ignorieren (immer 200 mit kompletter Datei).
    pub ignore_range: bool,
    /// Pause pro 64-KiB-Block.
    pub throttle: Option<Duration>,
}

pub struct TestServer {
    pub base: String,
    pub state: Arc<Mutex<ServerState>>,
}

impl TestServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let state = Arc::new(Mutex::new(ServerState::default()));
        let shared = state.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let st = shared.clone();
                thread::spawn(move || handle(stream, st));
            }
        });
        Self { base: format!("http://{addr}"), state }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn add_file(&self, path: &str, data: impl Into<Vec<u8>>) {
        self.state.lock().unwrap().files.insert(path.to_string(), data.into());
    }

    pub fn add_redirect(&self, from: &str, to: &str) {
        self.state.lock().unwrap().redirects.insert(from.to_string(), to.to_string());
    }

    pub fn drop_once_after(&self, path: &str, bytes: u64) {
        self.state.lock().unwrap().drop_after = Some((path.to_string(), bytes));
    }

    pub fn set_ignore_range(&self, v: bool) {
        self.state.lock().unwrap().ignore_range = v;
    }

    pub fn set_throttle(&self, d: Option<Duration>) {
        self.state.lock().unwrap().throttle = d;
    }

    pub fn requests_for(&self, path: &str) -> Vec<Recorded> {
        self.state.lock().unwrap().requests.iter().filter(|r| r.path == path).cloned().collect()
    }
}

/// Eine garantiert geschlossene Adresse (für Verbindungsfehler).
pub fn closed_url(path: &str) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    format!("http://127.0.0.1:{port}{path}")
}

fn handle(mut stream: TcpStream, state: Arc<Mutex<ServerState>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 64 * 1024 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut range = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }

    let (file, redirect, drop_after, ignore_range, throttle) = {
        let mut st = state.lock().unwrap();
        let file = st.files.get(&path).cloned();
        let redirect = st.redirects.get(&path).cloned();
        let drop_after = match &st.drop_after {
            Some((p, n)) if *p == path && file.is_some() => {
                let n = *n;
                st.drop_after = None;
                Some(n)
            }
            _ => None,
        };
        (file, redirect, drop_after, st.ignore_range, st.throttle)
    };

    let record = |status: u16| {
        state.lock().unwrap().requests.push(Recorded { path: path.clone(), range: range.clone(), status });
    };

    if let Some(to) = redirect {
        record(302);
        let _ = write!(stream, "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let Some(data) = file else {
        record(404);
        let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
        return;
    };
    let len = data.len() as u64;
    let start = match range.as_deref().filter(|_| !ignore_range) {
        Some(r) => r.strip_prefix("bytes=").and_then(|r| r.split('-').next()).and_then(|s| s.trim().parse::<u64>().ok()),
        None => None,
    };
    let (status, body_start, extra) = match start {
        Some(s) if s >= len => {
            record(416);
            let _ = write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return;
        }
        Some(s) => (206u16, s, format!("Content-Range: bytes {s}-{}/{len}\r\n", len - 1)),
        None => (200u16, 0, String::new()),
    };
    record(status);
    let reason = if status == 206 { "Partial Content" } else { "OK" };
    let body = &data[body_start as usize..];
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{extra}Connection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    let limit = drop_after.map(|n| n.min(body.len() as u64) as usize).unwrap_or(body.len());
    for piece in body[..limit].chunks(64 * 1024) {
        if stream.write_all(piece).is_err() {
            return;
        }
        if let Some(t) = throttle {
            thread::sleep(t);
        }
    }
    let _ = stream.flush();
    if drop_after.is_some() {
        let _ = stream.shutdown(Shutdown::Both);
    }
}
