//! Requests to Epic's CDN: which hosts, retries, and what a status code means.
//!
//! The HTTP client itself is behind the [`Transport`] trait (the launcher uses ureq; tests use a
//! made-up CDN in memory), so the retry rules here can be tested without a network.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::chunk::{self, ChunkError};
use super::manifest::ChunkInfo;

/// Epic's official CDN hosts, in the order they are tried (rotated on every retry). All four serve
/// the same files from the same storage.
pub const CDN_HOSTS: [&str; 4] = [
    "fastly-download.epicgames.com",
    "epicgames-download1.akamaized.net",
    "download.epicgames.com",
    "cloudflare.epicgamescdn.com",
];

pub const CDN_BASE_PATH: &str = "/Builds/Fortnite/CloudDir/";

/// A chunk file is at most a few MB; anything bigger is not a chunk.
pub const MAX_CHUNK_DOWNLOAD: u64 = 8 << 20;

pub fn chunk_url(host: &str, chunk_path: &str) -> String {
    if host.contains("://") {
        format!("{host}{CDN_BASE_PATH}{chunk_path}")
    } else {
        format!("https://{host}{CDN_BASE_PATH}{chunk_path}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    /// The server answered with this HTTP status (GET only; HEAD returns every status as Ok).
    Status(u16),
    Timeout,
    /// Pause / cancel came in while the body was arriving.
    Stopped,
    Other(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Status(s) => write!(f, "HTTP {s}"),
            NetError::Timeout => write!(f, "timed out"),
            NetError::Stopped => write!(f, "stopped"),
            NetError::Other(e) => write!(f, "{e}"),
        }
    }
}

/// One HTTP request, no retries.
pub trait Transport: Send + Sync {
    /// HEAD request: the HTTP status (200, 404, 403, …).
    fn head(&self, url: &str) -> Result<u16, NetError>;
    /// GET request: the body of a 2xx answer (at most `max_bytes`); other statuses are `Status`.
    /// Checks `stop` while the body arrives and gives up with `Stopped` (so Pause/Cancel don't
    /// wait for a slow chunk or manifest to finish).
    fn get(&self, url: &str, max_bytes: u64, stop: &AtomicBool) -> Result<Vec<u8>, NetError>;
}

#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Tries per request (all hosts together).
    pub tries: u32,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy { tries: 7, backoff_min: Duration::from_millis(500), backoff_max: Duration::from_secs(8) }
    }
}

impl RetryPolicy {
    /// Wait before retry number `n` (0 = first retry): 0.5, 1, 2, 4, 8, 8 … s.
    pub fn backoff(&self, n: u32) -> Duration {
        let d = self.backoff_min.saturating_mul(1u32 << n.min(16));
        d.min(self.backoff_max)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// 404 from two hosts: Epic deleted it.
    Missing,
    /// 403 from two hosts: Epic refuses the download.
    Blocked,
    /// Still failing after all tries (timeouts, 5xx, connection drops).
    Network(String),
    /// Downloaded several times, but the data never matched the manifest.
    Damaged(String),
    /// Pause / cancel.
    Stopped,
}

/// Sleeps `d`, but wakes up early (returns false) when `stop` is set.
pub fn sleep_unless(stop: &AtomicBool, d: Duration) -> bool {
    let end = Instant::now() + d;
    loop {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let now = Instant::now();
        if now >= end {
            return true;
        }
        std::thread::sleep((end - now).min(Duration::from_millis(50)));
    }
}

pub struct Cdn {
    pub transport: Arc<dyn Transport>,
    pub hosts: Vec<String>,
    pub policy: RetryPolicy,
}

enum Attempt<T> {
    Done(T),
    NotFound,
    Forbidden,
    Retry(String),
    Damaged(String),
}

impl Cdn {
    /// Epic's four hosts and the default retry rules.
    pub fn epic(transport: Arc<dyn Transport>) -> Cdn {
        Cdn { transport, hosts: CDN_HOSTS.iter().map(|h| h.to_string()).collect(), policy: RetryPolicy::default() }
    }

    /// Runs `op` on host after host. 404 or 403 from two different hosts is final; anything else
    /// is retried with a growing wait, up to `policy.tries` times.
    fn with_retries<T>(&self, stop: &AtomicBool, mut op: impl FnMut(&str) -> Attempt<T>) -> Result<T, FetchError> {
        let (mut not_found, mut forbidden, mut waits) = (0, 0, 0);
        let mut last = String::from("no answer");
        let mut damaged = false;
        for attempt in 0..self.policy.tries.max(1) {
            if stop.load(Ordering::SeqCst) {
                return Err(FetchError::Stopped);
            }
            let host = &self.hosts[attempt as usize % self.hosts.len()];
            match op(host) {
                Attempt::Done(v) => return Ok(v),
                Attempt::NotFound => {
                    not_found += 1;
                    if not_found >= 2.min(self.hosts.len()) {
                        return Err(FetchError::Missing);
                    }
                    continue; // straight to the next host
                }
                Attempt::Forbidden => {
                    forbidden += 1;
                    if forbidden >= 2.min(self.hosts.len()) {
                        return Err(FetchError::Blocked);
                    }
                    continue;
                }
                Attempt::Retry(e) => {
                    last = e;
                    damaged = false;
                }
                Attempt::Damaged(e) => {
                    last = e;
                    damaged = true;
                }
            }
            // a request cut short by Pause/Cancel is not a network error
            if stop.load(Ordering::SeqCst) {
                return Err(FetchError::Stopped);
            }
            if attempt + 1 < self.policy.tries && !sleep_unless(stop, self.policy.backoff(waits)) {
                return Err(FetchError::Stopped);
            }
            waits += 1;
        }
        Err(if damaged { FetchError::Damaged(last) } else { FetchError::Network(last) })
    }

    /// HEAD check: is the chunk still on the CDN?
    pub fn check_chunk(&self, chunk_path: &str, stop: &AtomicBool) -> Result<(), FetchError> {
        self.with_retries(stop, |host| match self.transport.head(&chunk_url(host, chunk_path)) {
            Ok(200..=299) => Attempt::Done(()),
            Ok(404) | Ok(410) => Attempt::NotFound,
            Ok(403) => Attempt::Forbidden,
            Ok(s) => Attempt::Retry(format!("HTTP {s}")),
            Err(e) => Attempt::Retry(e.to_string()),
        })
    }

    /// Downloads a chunk and returns its checked, unpacked data.
    pub fn fetch_chunk(&self, chunk_path: &str, info: &ChunkInfo, stop: &AtomicBool) -> Result<Vec<u8>, FetchError> {
        self.with_retries(stop, |host| match self.transport.get(&chunk_url(host, chunk_path), MAX_CHUNK_DOWNLOAD, stop) {
            Ok(raw) => match chunk::decode(&raw, info) {
                Ok(data) => Attempt::Done(data),
                // An error page instead of a chunk, or damaged on the way: try again
                Err(e @ (ChunkError::NotAChunk | ChunkError::Truncated)) => Attempt::Retry(e.to_string()),
                Err(e) => Attempt::Damaged(e.to_string()),
            },
            Err(NetError::Status(404)) | Err(NetError::Status(410)) => Attempt::NotFound,
            Err(NetError::Status(403)) => Attempt::Forbidden,
            Err(e) => Attempt::Retry(e.to_string()),
        })
    }
}

/// Downloads a manifest from the archive URLs (first that answers wins). Returns the bytes only
/// if their SHA-1 is the pinned one. `Err(true)` = got a file but it was the wrong one.
pub fn fetch_manifest(transport: &dyn Transport, urls: &[String], sha1_hex: &str, max_bytes: u64, stop: &AtomicBool) -> Result<Vec<u8>, bool> {
    let mut wrong = false;
    for url in urls {
        for attempt in 0..3u32 {
            if stop.load(Ordering::SeqCst) {
                return Err(false);
            }
            match transport.get(url, max_bytes, stop) {
                Ok(bytes) => {
                    if super::sha1_hex(&bytes) == sha1_hex {
                        return Ok(bytes);
                    }
                    wrong = true;
                    break; // a changed file: try the other archive
                }
                Err(NetError::Status(404)) => break,
                Err(_) => {
                    if !sleep_unless(stop, Duration::from_millis(500 << attempt)) {
                        return Err(false);
                    }
                }
            }
        }
    }
    Err(wrong)
}

#[cfg(test)]
pub(crate) mod mock {
    //! A made-up CDN in memory, with switches for the failures the tests need.

    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    pub type GetHook = Box<dyn Fn(u32) + Send>;

    #[derive(Default)]
    pub struct MockCdn {
        /// path below CloudDir (or full URL for manifests) → bytes
        pub files: Mutex<HashMap<String, Vec<u8>>>,
        /// hosts that answer every request with this status
        pub host_status: Mutex<HashMap<String, u16>>,
        /// paths that fail with a 503 this many more times
        pub flaky: Mutex<HashMap<String, u32>>,
        /// paths whose data arrives damaged this many more times
        pub corrupt: Mutex<HashMap<String, u32>>,
        pub heads: AtomicU32,
        pub gets: AtomicU32,
        /// every GET url in order
        pub log: Mutex<Vec<String>>,
        /// called on every GET (e.g. to press Pause in the middle)
        pub on_get: Mutex<Option<GetHook>>,
        /// every GET body takes this long to arrive (a slow line)
        pub slow_body: Mutex<Duration>,
    }

    impl MockCdn {
        fn split<'a>(&self, url: &'a str) -> (String, &'a str) {
            let rest = url.strip_prefix("https://").unwrap_or(url);
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            let path = path.strip_prefix(CDN_BASE_PATH.trim_start_matches('/')).unwrap_or(path);
            (host.to_string(), path)
        }

        fn status_for(&self, url: &str) -> Option<u16> {
            let (host, path) = self.split(url);
            if let Some(s) = self.host_status.lock().unwrap().get(&host) {
                return Some(*s);
            }
            let mut flaky = self.flaky.lock().unwrap();
            if let Some(n) = flaky.get_mut(path) {
                if *n > 0 {
                    *n -= 1;
                    return Some(503);
                }
            }
            None
        }

        fn lookup(&self, url: &str) -> Option<Vec<u8>> {
            let files = self.files.lock().unwrap();
            let (_, path) = self.split(url);
            files.get(path).or_else(|| files.get(url)).cloned()
        }
    }

    impl Transport for MockCdn {
        fn head(&self, url: &str) -> Result<u16, NetError> {
            self.heads.fetch_add(1, Ordering::SeqCst);
            if let Some(s) = self.status_for(url) {
                return Ok(s);
            }
            Ok(if self.lookup(url).is_some() { 200 } else { 404 })
        }

        fn get(&self, url: &str, max_bytes: u64, stop: &AtomicBool) -> Result<Vec<u8>, NetError> {
            let n = self.gets.fetch_add(1, Ordering::SeqCst) + 1;
            self.log.lock().unwrap().push(url.to_string());
            if let Some(f) = self.on_get.lock().unwrap().as_ref() {
                f(n);
            }
            // a body that arrives slowly: wait, but give up as soon as `stop` is set
            let slow = *self.slow_body.lock().unwrap();
            if !slow.is_zero() && !sleep_unless(stop, slow) {
                return Err(NetError::Stopped);
            }
            if let Some(s) = self.status_for(url) {
                return Err(NetError::Status(s));
            }
            let mut data = self.lookup(url).ok_or(NetError::Status(404))?;
            if data.len() as u64 > max_bytes {
                return Err(NetError::Other("too big".into()));
            }
            let (_, path) = self.split(url);
            let mut corrupt = self.corrupt.lock().unwrap();
            if let Some(n) = corrupt.get_mut(path) {
                if *n > 0 {
                    *n -= 1;
                    let last = data.len() - 1;
                    data[last] ^= 0xff;
                }
            }
            Ok(data)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockCdn;
    use super::*;
    use crate::epic::fixtures::{encode_chunk, FixtureChunk};

    fn fast(t: Arc<MockCdn>) -> Cdn {
        Cdn {
            transport: t,
            hosts: CDN_HOSTS.iter().map(|h| h.to_string()).collect(),
            policy: RetryPolicy { tries: 7, backoff_min: Duration::from_millis(1), backoff_max: Duration::from_millis(4) },
        }
    }

    #[test]
    fn backoff_grows_and_stops_at_8s() {
        let p = RetryPolicy::default();
        let secs: Vec<f32> = (0..7).map(|n| p.backoff(n).as_secs_f32()).collect();
        assert_eq!(secs, vec![0.5, 1.0, 2.0, 4.0, 8.0, 8.0, 8.0]);
        assert_eq!(chunk_url(CDN_HOSTS[0], "ChunksV4/01/x.chunk"), "https://fastly-download.epicgames.com/Builds/Fortnite/CloudDir/ChunksV4/01/x.chunk");
    }

    #[test]
    fn missing_needs_two_hosts() {
        let t = Arc::new(MockCdn::default());
        let cdn = fast(t.clone());
        let stop = AtomicBool::new(false);
        assert_eq!(cdn.check_chunk("ChunksV4/00/a.chunk", &stop), Err(FetchError::Missing));
        assert_eq!(t.heads.load(Ordering::SeqCst), 2);
        t.files.lock().unwrap().insert("ChunksV4/00/a.chunk".into(), vec![1]);
        assert_eq!(cdn.check_chunk("ChunksV4/00/a.chunk", &stop), Ok(()));
        // one host with a broken edge: the second host is asked
        t.host_status.lock().unwrap().insert(CDN_HOSTS[0].into(), 404);
        assert_eq!(cdn.check_chunk("ChunksV4/00/a.chunk", &stop), Ok(()));
    }

    #[test]
    fn blocked_and_server_errors() {
        let t = Arc::new(MockCdn::default());
        t.files.lock().unwrap().insert("p".into(), vec![1]);
        for h in CDN_HOSTS {
            t.host_status.lock().unwrap().insert(h.into(), 403);
        }
        let cdn = fast(t.clone());
        let stop = AtomicBool::new(false);
        assert_eq!(cdn.check_chunk("p", &stop), Err(FetchError::Blocked));
        // 5xx everywhere: all tries used, then a network error
        for h in CDN_HOSTS {
            t.host_status.lock().unwrap().insert(h.into(), 503);
        }
        let before = t.heads.load(Ordering::SeqCst);
        assert!(matches!(cdn.check_chunk("p", &stop), Err(FetchError::Network(_))));
        assert_eq!(t.heads.load(Ordering::SeqCst) - before, 7);
    }

    #[test]
    fn retries_switch_host_and_check_the_data() {
        let c = FixtureChunk::new(3, 5000);
        let raw = encode_chunk(&c, 3, true);
        let info = c.info(raw.len() as u64);
        let t = Arc::new(MockCdn::default());
        t.files.lock().unwrap().insert("c".into(), raw);
        t.flaky.lock().unwrap().insert("c".into(), 2);
        let cdn = fast(t.clone());
        let stop = AtomicBool::new(false);
        assert_eq!(cdn.fetch_chunk("c", &info, &stop).unwrap(), c.data);
        let log = t.log.lock().unwrap().clone();
        assert_eq!(log.len(), 3);
        assert!(log[0].contains(CDN_HOSTS[0]) && log[1].contains(CDN_HOSTS[1]) && log[2].contains(CDN_HOSTS[2]));
        // damaged twice, then fine
        t.corrupt.lock().unwrap().insert("c".into(), 2);
        assert_eq!(cdn.fetch_chunk("c", &info, &stop).unwrap(), c.data);
        // always damaged
        t.corrupt.lock().unwrap().insert("c".into(), 100);
        assert!(matches!(cdn.fetch_chunk("c", &info, &stop), Err(FetchError::Damaged(_))));
        // stop wins
        stop.store(true, Ordering::SeqCst);
        assert_eq!(cdn.fetch_chunk("c", &info, &stop), Err(FetchError::Stopped));
    }

    #[test]
    fn a_body_cut_short_by_stop_is_stopped_not_a_network_error() {
        let c = FixtureChunk::new(4, 3000);
        let raw = encode_chunk(&c, 3, true);
        let info = c.info(raw.len() as u64);
        let t = Arc::new(MockCdn::default());
        t.files.lock().unwrap().insert("c".into(), raw);
        *t.slow_body.lock().unwrap() = Duration::from_secs(20);
        // one try only: the stop must not turn into "Network" on the last attempt
        let cdn = Cdn { policy: RetryPolicy { tries: 1, ..RetryPolicy::default() }, ..fast(t.clone()) };
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        let presser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            s2.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        assert_eq!(cdn.fetch_chunk("c", &info, &stop), Err(FetchError::Stopped));
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        presser.join().unwrap();
    }

    #[test]
    fn manifest_must_match_its_pin() {
        let t = MockCdn::default();
        let stop = AtomicBool::new(false);
        let urls = vec!["https://a/m".to_string(), "https://b/m".to_string()];
        t.files.lock().unwrap().insert("https://b/m".into(), b"MANIFEST".to_vec());
        let sha = crate::epic::sha1_hex(b"MANIFEST");
        // the first archive doesn't have it, the second does
        assert_eq!(fetch_manifest(&t, &urls, &sha, 1000, &stop).unwrap(), b"MANIFEST");
        // a changed file is refused
        assert_eq!(fetch_manifest(&t, &urls, &"0".repeat(40), 1000, &stop), Err(true));
        // nobody has it
        assert_eq!(fetch_manifest(&t, &urls[..1], &sha, 1000, &stop), Err(false));
    }
}
