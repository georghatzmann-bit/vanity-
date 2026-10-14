//! Speedtest über Cloudflare (`speed.cloudflare.com`): Ruhe-Latenz, Download mit vier parallelen
//! Strömen, Upload, dazu die Latenz unter Last (Bufferbloat). Alles zeitlich begrenzt und jederzeit
//! abbrechbar.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::ping;
use super::types::{SpeedProgress, SpeedResult};
use super::EVENT_SPEED;

pub const HOST: &str = "speed.cloudflare.com";
pub const IDLE_SAMPLES: usize = 10;
pub const IDLE_SPACING: Duration = Duration::from_millis(100);
pub const LATENCY_TIMEOUT: Duration = Duration::from_millis(2000);
pub const DOWNLOAD_DURATION: Duration = Duration::from_secs(8);
pub const UPLOAD_DURATION: Duration = Duration::from_secs(6);
pub const DOWNLOAD_STREAMS: usize = 4;
pub const UPLOAD_STREAMS: usize = 3;
/// Abstand der Latenzmessungen unter Last.
const LOAD_PROBE_SPACING: Duration = Duration::from_millis(250);
/// Abstand der Fortschritts-Events.
const PROGRESS_SPACING: Duration = Duration::from_millis(200);
/// Die erste Sekunde (Anlaufphase) zählt nicht für den Endwert.
const RAMP_UP: Duration = Duration::from_secs(1);
const UPLOAD_CHUNK: usize = 64 * 1024;
pub const CANCELLED: &str = "Abgebrochen.";
pub const ALREADY_RUNNING: &str = "Es läuft bereits ein Speedtest.";

/// Ruhezeit ab dem Start eines Tests (`quiet_until = now + 60 s`, `docs/API.md` „Ruhezeit“).
pub const QUIET_START_MS: i64 = 60_000;
/// Ruhezeit nach dem Ende eines Tests (auch bei Abbruch/Fehler: `quiet_until = now + 5 s`).
pub const QUIET_END_MS: i64 = 5_000;

/// Steuerung des laufenden Tests (im `NetState`).
#[derive(Default)]
pub struct SpeedControl {
    running: AtomicBool,
    cancel: AtomicBool,
    /// Ende des letzten Tests (ms, 0 = noch keiner) – für den Grund der Ruhezeit
    last_end: AtomicI64,
}

impl SpeedControl {
    /// Test als laufend markieren; `false`, wenn schon einer läuft.
    pub fn try_begin(&self) -> bool {
        if self.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return false;
        }
        self.cancel.store(false, Ordering::SeqCst);
        true
    }

    pub fn end(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.last_end.store(crate::util::now_ms(), Ordering::SeqCst);
    }

    /// Ende des letzten Tests (ms, 0 = noch keiner).
    pub fn last_end(&self) -> i64 {
        self.last_end.load(Ordering::SeqCst)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Abbruch anfordern (wirkt nur, wenn ein Test läuft).
    pub fn cancel(&self) {
        if self.is_running() {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// Setzt `running` beim Verlassen von `run` zurück und verkürzt die Ruhezeit auf `now + 5 s` –
/// auch bei Fehlern und Abbruch.
struct RunGuard<'a> {
    ctl: &'a SpeedControl,
    quiet: &'a AtomicI64,
    /// Wert, den der Start gesetzt hat (`None` = es galt schon eine längere Ruhezeit). Hat
    /// inzwischen jemand anderes verlängert (z. B. ein WLAN-Scan), bleibt dessen Ruhezeit.
    set_at_start: Option<i64>,
}

impl<'a> RunGuard<'a> {
    /// Ruhezeit `now + 60 s` setzen (nie verkürzen).
    fn begin(ctl: &'a SpeedControl, quiet: &'a AtomicI64, now: i64) -> Self {
        let until = now + QUIET_START_MS;
        let prev = quiet.fetch_max(until, Ordering::SeqCst);
        RunGuard { ctl, quiet, set_at_start: (prev < until).then_some(until) }
    }

    fn finish(&self, now: i64) {
        let end = now + QUIET_END_MS;
        let shortened = self
            .set_at_start
            .is_some_and(|ours| self.quiet.compare_exchange(ours, end, Ordering::SeqCst, Ordering::SeqCst).is_ok());
        if !shortened {
            // Jemand hat die Ruhezeit seit dem Start geändert: nur verlängern, nie verkürzen
            self.quiet.fetch_max(end, Ordering::SeqCst);
        }
        self.ctl.end();
    }
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.finish(crate::util::now_ms());
    }
}

// ---------------------------------------------------------------------------------------------
// Reine Rechenhilfen
// ---------------------------------------------------------------------------------------------

/// Note für den Latenz-Anstieg unter Last (ms).
pub fn bufferbloat_grade(increase_ms: f64) -> &'static str {
    if !increase_ms.is_finite() {
        return "F";
    }
    if increase_ms < 5.0 {
        "A+"
    } else if increase_ms < 30.0 {
        "A"
    } else if increase_ms < 60.0 {
        "B"
    } else if increase_ms < 200.0 {
        "C"
    } else if increase_ms < 400.0 {
        "D"
    } else {
        "F"
    }
}

/// Bytes in einer Zeitspanne → Mbit/s.
pub fn mbps(bytes: u64, secs: f64) -> f64 {
    if secs <= 0.0 {
        return 0.0;
    }
    (bytes as f64 * 8.0) / secs / 1_000_000.0
}

/// Endwert einer Phase: ohne Anlaufphase, wenn die Messung lang genug war.
pub fn phase_mbps(total_bytes: u64, bytes_after_ramp: Option<u64>, elapsed: Duration) -> f64 {
    match bytes_after_ramp {
        Some(at_ramp) if elapsed > RAMP_UP * 2 => mbps(total_bytes.saturating_sub(at_ramp), (elapsed - RAMP_UP).as_secs_f64()),
        _ => mbps(total_bytes, elapsed.as_secs_f64()),
    }
}

/// Größter Anstieg der Latenz unter Last gegenüber der Ruhe-Latenz (nie negativ).
pub fn bufferbloat_ms(idle: f64, loaded_down: Option<f64>, loaded_up: Option<f64>) -> f64 {
    [loaded_down, loaded_up]
        .into_iter()
        .flatten()
        .map(|l| l - idle)
        .fold(0.0, f64::max)
}

/// `colo=FRA` aus `/cdn-cgi/trace` lesen.
pub fn parse_colo(trace: &str) -> Option<String> {
    trace
        .lines()
        .find_map(|l| l.trim().strip_prefix("colo="))
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
}

/// Wachsende Download-Größen (Bytes), danach konstant.
pub fn download_size(step: usize) -> u64 {
    const SIZES: [u64; 6] = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
    SIZES[step.min(SIZES.len() - 1)]
}

/// Wachsende Upload-Größen (Bytes), danach konstant.
pub fn upload_size(step: usize) -> u64 {
    const SIZES: [u64; 5] = [1_000_000, 4_000_000, 8_000_000, 16_000_000, 32_000_000];
    SIZES[step.min(SIZES.len() - 1)]
}

// ---------------------------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------------------------

/// Ergebnis einer Last-Phase.
struct PhaseOutcome {
    total_bytes: u64,
    bytes_after_ramp: Option<u64>,
    elapsed: Duration,
    latencies: Vec<f64>,
}

/// Gemeinsamer Zustand einer Last-Phase.
struct Shared {
    bytes: AtomicU64,
    latencies: Mutex<Vec<f64>>,
}

/// Den Test ausführen. Sendet `net://speed` und liefert das Ergebnis.
pub async fn run(app: &AppHandle, ctl: &SpeedControl, quiet_until: &AtomicI64) -> Result<SpeedResult, String> {
    if !ctl.try_begin() {
        return Err(ALREADY_RUNNING.into());
    }
    // Ruhezeit: während Pulsars eigenem Test keine Ereignisse und keine Momentaufnahmen
    let _guard = RunGuard::begin(ctl, quiet_until, crate::util::now_ms());
    let progress = |p: SpeedProgress| {
        let _ = app.emit(EVENT_SPEED, &p);
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("Pulsar/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Der Speedtest konnte nicht gestartet werden.".to_string())?;

    let ip = ping::resolve_host(HOST, false)
        .await
        .map_err(|_| "Keine Verbindung zum Internet".to_string())?;
    let addr = SocketAddr::new(ip, 443);
    let server = fetch_colo(&client).await.unwrap_or_else(|| "Cloudflare".into());

    // 1) Ruhe-Latenz
    let mut idle: Vec<f64> = Vec::with_capacity(IDLE_SAMPLES);
    for i in 0..IDLE_SAMPLES {
        if ctl.cancelled() {
            return Err(CANCELLED.into());
        }
        let sample = ping::tcp_probe(addr, LATENCY_TIMEOUT).await;
        if let Some(v) = sample {
            idle.push(v);
        }
        progress(SpeedProgress { phase: "latency".into(), progress: (i + 1) as f64 / IDLE_SAMPLES as f64, mbps: None, latency_ms: sample });
        tokio::time::sleep(IDLE_SPACING).await;
    }
    if idle.is_empty() {
        return Err("Der Messserver antwortet nicht. Bitte Internetverbindung prüfen.".into());
    }
    let idle_latency = ping::median(&idle).unwrap_or(0.0);
    let idle_jitter = ping::mean_abs_diff(&idle).unwrap_or(0.0);

    // 2) Download
    let down = {
        let shared = Arc::new(Shared { bytes: AtomicU64::new(0), latencies: Mutex::new(Vec::new()) });
        let deadline = Instant::now() + DOWNLOAD_DURATION;
        let workers: Vec<_> = (0..DOWNLOAD_STREAMS)
            .map(|_| download_stream(client.clone(), shared.clone(), deadline))
            .collect();
        loaded_phase("download", DOWNLOAD_DURATION, join_all(workers), addr, shared, ctl, &progress).await?
    };
    if down.total_bytes == 0 {
        return Err("Der Download-Test hat keine Daten empfangen.".into());
    }
    let download_mbps = phase_mbps(down.total_bytes, down.bytes_after_ramp, down.elapsed);

    // 3) Upload
    let up = {
        let shared = Arc::new(Shared { bytes: AtomicU64::new(0), latencies: Mutex::new(Vec::new()) });
        let completed = Arc::new(AtomicU64::new(0));
        let deadline = Instant::now() + UPLOAD_DURATION;
        let workers: Vec<_> = (0..UPLOAD_STREAMS)
            .map(|_| upload_stream(client.clone(), shared.clone(), completed.clone(), deadline))
            .collect();
        let mut outcome = loaded_phase("upload", UPLOAD_DURATION, join_all(workers), addr, shared, ctl, &progress).await?;
        // Nur bestätigt übertragene Bytes zählen (die Zähler der Ströme laufen dem Netz voraus)
        outcome.total_bytes = completed.load(Ordering::Relaxed);
        outcome.bytes_after_ramp = None;
        outcome
    };
    let upload_mbps = mbps(up.total_bytes, up.elapsed.as_secs_f64());

    let loaded_down = ping::median(&down.latencies);
    let loaded_up = ping::median(&up.latencies);
    let bloat = bufferbloat_ms(idle_latency, loaded_down, loaded_up);
    progress(SpeedProgress { phase: "done".into(), progress: 1.0, mbps: None, latency_ms: None });
    Ok(SpeedResult {
        download_mbps,
        upload_mbps,
        idle_latency_ms: idle_latency,
        idle_jitter_ms: idle_jitter,
        loaded_latency_down_ms: loaded_down,
        loaded_latency_up_ms: loaded_up,
        bufferbloat_ms: bloat,
        grade: bufferbloat_grade(bloat).into(),
        server,
        at: crate::util::now_ms(),
    })
}

/// Messserver-Kürzel (z. B. „FRA“) abfragen.
async fn fetch_colo(client: &reqwest::Client) -> Option<String> {
    let resp = client
        .get(format!("https://{HOST}/cdn-cgi/trace"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    parse_colo(&resp.text().await.ok()?)
}

/// Eine Last-Phase: Arbeiter laufen bis zur Frist, daneben Latenzmessung und Fortschritt.
/// Bricht innerhalb von ~100 ms ab, sobald `ctl.cancel()` gerufen wurde.
async fn loaded_phase<W>(
    phase: &str,
    duration: Duration,
    work: W,
    addr: SocketAddr,
    shared: Arc<Shared>,
    ctl: &SpeedControl,
    progress: &impl Fn(SpeedProgress),
) -> Result<PhaseOutcome, String>
where
    W: std::future::Future<Output = Vec<()>>,
{
    let start = Instant::now();
    let deadline = start + duration;

    let prober = {
        let shared = shared.clone();
        async move {
            while Instant::now() < deadline {
                let t = Instant::now();
                // Keine Antwort unter Last = Latenz über dem Zeitlimit → als Zeitlimit zählen
                let sample = ping::tcp_probe(addr, LATENCY_TIMEOUT).await.unwrap_or(ping::ms(LATENCY_TIMEOUT));
                if let Ok(mut l) = shared.latencies.lock() {
                    l.push(sample);
                }
                let spent = t.elapsed();
                if spent < LOAD_PROBE_SPACING {
                    tokio::time::sleep(LOAD_PROBE_SPACING - spent).await;
                }
            }
        }
    };

    let reporter = {
        let shared = shared.clone();
        async move {
            let mut after_ramp: Option<u64> = None;
            while Instant::now() < deadline {
                tokio::time::sleep(PROGRESS_SPACING).await;
                let elapsed = start.elapsed();
                let bytes = shared.bytes.load(Ordering::Relaxed);
                if after_ramp.is_none() && elapsed >= RAMP_UP {
                    after_ramp = Some(bytes);
                }
                let last = shared.latencies.lock().ok().and_then(|l| l.last().copied());
                progress(SpeedProgress {
                    phase: phase.into(),
                    progress: (elapsed.as_secs_f64() / duration.as_secs_f64()).min(1.0),
                    mbps: Some(mbps(bytes, elapsed.as_secs_f64())),
                    latency_ms: last,
                });
            }
            after_ramp
        }
    };

    let canceller = async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if ctl.cancelled() {
                return;
            }
        }
    };

    tokio::select! {
        (_, _, after_ramp) = async { tokio::join!(work, prober, reporter) } => {
            let latencies = shared.latencies.lock().map(|l| l.clone()).unwrap_or_default();
            Ok(PhaseOutcome {
                total_bytes: shared.bytes.load(Ordering::Relaxed),
                bytes_after_ramp: after_ramp,
                elapsed: start.elapsed(),
                latencies,
            })
        }
        _ = canceller => Err(CANCELLED.into()),
    }
}

/// Ein Download-Strom: lädt bis zur Frist immer größere Antworten und zählt die Bytes.
async fn download_stream(client: reqwest::Client, shared: Arc<Shared>, deadline: Instant) {
    let mut step = 0;
    while Instant::now() < deadline {
        let url = format!("https://{HOST}/__down?bytes={}", download_size(step));
        step += 1;
        let resp = match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let mut body = resp.bytes_stream();
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(b) => {
                    shared.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                }
                Err(_) => break,
            }
            if Instant::now() >= deadline {
                return;
            }
        }
    }
}

/// Ein Upload-Strom: sendet bis zur Frist immer größere Anfragen; `completed` zählt nur Bytes
/// von Anfragen, die der Server bestätigt hat.
async fn upload_stream(client: reqwest::Client, shared: Arc<Shared>, completed: Arc<AtomicU64>, deadline: Instant) {
    let mut step = 0;
    while Instant::now() < deadline {
        let size = upload_size(step);
        step += 1;
        let sent = Arc::new(AtomicU64::new(0));
        let counter = shared.clone();
        let sent_in_body = sent.clone();
        let body_stream = futures_util::stream::unfold(0u64, move |done| {
            let counter = counter.clone();
            let sent = sent_in_body.clone();
            async move {
                if done >= size || Instant::now() >= deadline {
                    return None;
                }
                let n = (size - done).min(UPLOAD_CHUNK as u64) as usize;
                counter.bytes.fetch_add(n as u64, Ordering::Relaxed);
                sent.fetch_add(n as u64, Ordering::Relaxed);
                Some((Ok::<Vec<u8>, std::io::Error>(vec![0x50u8; n]), done + n as u64))
            }
        });
        let res = client
            .post(format!("https://{HOST}/__up"))
            .body(reqwest::Body::wrap_stream(body_stream))
            .send()
            .await;
        match res {
            Ok(resp) => {
                let ok = resp.status().is_success();
                let _ = resp.bytes().await;
                if ok {
                    completed.fetch_add(sent.load(Ordering::Relaxed), Ordering::Relaxed);
                }
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grades_follow_thresholds() {
        assert_eq!(bufferbloat_grade(0.0), "A+");
        assert_eq!(bufferbloat_grade(4.9), "A+");
        assert_eq!(bufferbloat_grade(5.0), "A");
        assert_eq!(bufferbloat_grade(29.9), "A");
        assert_eq!(bufferbloat_grade(30.0), "B");
        assert_eq!(bufferbloat_grade(59.9), "B");
        assert_eq!(bufferbloat_grade(60.0), "C");
        assert_eq!(bufferbloat_grade(199.9), "C");
        assert_eq!(bufferbloat_grade(200.0), "D");
        assert_eq!(bufferbloat_grade(399.9), "D");
        assert_eq!(bufferbloat_grade(400.0), "F");
        assert_eq!(bufferbloat_grade(f64::NAN), "F");
    }

    #[test]
    fn speed_math() {
        assert!((mbps(125_000_000, 1.0) - 1000.0).abs() < 1e-9);
        assert!((mbps(12_500_000, 2.0) - 50.0).abs() < 1e-9);
        assert_eq!(mbps(1, 0.0), 0.0);
        // Anlaufphase herausrechnen: 10 MB gesamt, 1 MB in der ersten Sekunde, 5 s gesamt
        let v = phase_mbps(10_000_000, Some(1_000_000), Duration::from_secs(5));
        assert!((v - mbps(9_000_000, 4.0)).abs() < 1e-9, "{v}");
        // Zu kurz gemessen → einfacher Durchschnitt
        let short = phase_mbps(1_000_000, Some(500_000), Duration::from_millis(1500));
        assert!((short - mbps(1_000_000, 1.5)).abs() < 1e-9);
        assert_eq!(phase_mbps(1_000_000, None, Duration::from_secs(4)), mbps(1_000_000, 4.0));
    }

    #[test]
    fn bufferbloat_is_largest_increase_never_negative() {
        assert_eq!(bufferbloat_ms(10.0, Some(31.5), Some(44.2)), 34.2);
        assert_eq!(bufferbloat_ms(10.0, Some(8.0), None), 0.0);
        assert_eq!(bufferbloat_ms(10.0, None, None), 0.0);
        assert_eq!(bufferbloat_ms(10.0, None, Some(12.5)), 2.5);
    }

    #[test]
    fn colo_and_sizes() {
        assert_eq!(parse_colo("fl=1f2\nh=speed.cloudflare.com\nip=1.2.3.4\ncolo=FRA\nhttp=http/2\n"), Some("FRA".into()));
        assert_eq!(parse_colo("h=x\n"), None);
        assert_eq!(parse_colo("colo=\n"), None);
        assert!(download_size(0) < download_size(1) && download_size(1) < download_size(5));
        assert_eq!(download_size(5), download_size(99));
        assert!(upload_size(0) < upload_size(4));
        assert_eq!(upload_size(4), upload_size(50));
    }

    #[test]
    fn control_flags() {
        let c = SpeedControl::default();
        assert!(!c.is_running());
        c.cancel();
        assert!(!c.cancelled(), "ohne laufenden Test kein Abbruch-Flag");
        assert!(c.try_begin());
        assert!(!c.try_begin(), "nur ein Test gleichzeitig");
        c.cancel();
        assert!(c.cancelled());
        c.end();
        assert!(!c.is_running());
        assert!(c.try_begin(), "neuer Start löscht das Abbruch-Flag");
        assert!(!c.cancelled());
        let quiet = AtomicI64::new(0);
        {
            let _g = RunGuard::begin(&c, &quiet, crate::util::now_ms());
        }
        assert!(!c.is_running(), "Guard setzt running zurück");
        assert!(c.last_end() > 0);
    }

    #[test]
    fn quiet_time_60s_then_5s() {
        let c = SpeedControl::default();
        let quiet = AtomicI64::new(0);
        assert!(c.try_begin());
        let g = RunGuard::begin(&c, &quiet, 1_000);
        assert_eq!(quiet.load(Ordering::SeqCst), 61_000, "Start: now + 60 s");
        g.finish(20_000);
        assert_eq!(quiet.load(Ordering::SeqCst), 25_000, "Ende: now + 5 s");
        assert!(!c.is_running());
        std::mem::forget(g);

        // Ein WLAN-Scan hat die Ruhezeit währenddessen verlängert → bleibt
        let quiet = AtomicI64::new(0);
        let g = RunGuard::begin(&c, &quiet, 1_000);
        quiet.store(90_000, Ordering::SeqCst);
        g.finish(20_000);
        assert_eq!(quiet.load(Ordering::SeqCst), 90_000);
        std::mem::forget(g);

        // Längere Ruhezeit vor dem Start wird nicht verkürzt
        let quiet = AtomicI64::new(200_000);
        let g = RunGuard::begin(&c, &quiet, 1_000);
        assert_eq!(quiet.load(Ordering::SeqCst), 200_000);
        g.finish(20_000);
        assert_eq!(quiet.load(Ordering::SeqCst), 200_000);
        std::mem::forget(g);
    }
}
