//! Live-Monitor: ein Hintergrund-Task misst in festem Takt alle Ziele parallel und sendet je Takt
//! das Event `net://ping` mit den neuen Messwerten und der Statistik über die letzten 60 Messungen.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use tauri::{AppHandle, Emitter};

use super::ping;
use super::types::{MonitorUpdate, PingSample, PingStats, PingTarget};
use super::EVENT_PING;

/// Länge des gleitenden Fensters je Ziel.
pub const WINDOW: usize = 60;
pub const MIN_INTERVAL_MS: u32 = 250;
pub const MAX_INTERVAL_MS: u32 = 10_000;
pub const DEFAULT_INTERVAL_MS: u32 = 1000;

/// Takt aus der Oberfläche auf 250–10000 ms begrenzen.
pub fn clamp_interval(interval_ms: Option<u32>) -> Duration {
    Duration::from_millis(u64::from(
        interval_ms.unwrap_or(DEFAULT_INTERVAL_MS).clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    ))
}

/// Griff auf den laufenden Monitor: Stopp-Flag plus Task, damit `stop()` sofort wirkt.
pub struct MonitorHandle {
    stop: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl MonitorHandle {
    /// Monitor anhalten (Flag setzen und Task abbrechen).
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        self.task.abort();
    }
}

/// Gleitendes Fenster der letzten [`WINDOW`] Messungen je Ziel – reine Logik, testbar.
#[derive(Debug, Default)]
pub struct RollingWindow {
    per_target: Vec<(String, VecDeque<Option<f64>>)>,
}

impl RollingWindow {
    pub fn new(targets: &[PingTarget]) -> Self {
        Self {
            per_target: targets
                .iter()
                .map(|t| (t.id.clone(), VecDeque::with_capacity(WINDOW + 1)))
                .collect(),
        }
    }

    /// Messwert anhängen; die ältesten fallen heraus, sobald das Fenster voll ist.
    pub fn push(&mut self, target_id: &str, rtt: Option<f64>) {
        if let Some((_, q)) = self.per_target.iter_mut().find(|(id, _)| id == target_id) {
            q.push_back(rtt);
            while q.len() > WINDOW {
                q.pop_front();
            }
        }
    }

    /// Statistik je Ziel in der Reihenfolge der Ziele.
    pub fn stats(&self) -> Vec<PingStats> {
        self.per_target
            .iter()
            .map(|(id, q)| {
                let values: Vec<Option<f64>> = q.iter().copied().collect();
                ping::summarize(id, &values)
            })
            .collect()
    }
}

/// Startet den Monitor-Task. Der Aufrufer legt den Griff in `NetState` ab.
pub fn start(app: AppHandle, targets: Vec<PingTarget>, interval: Duration) -> MonitorHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let task = tauri::async_runtime::spawn(async move {
        run(app, targets, interval, flag).await;
    });
    MonitorHandle { stop, task }
}

/// Die Schleife des Monitors. Namen werden einmal aufgelöst und bei Fehlern in jedem Takt erneut
/// versucht; ein nicht auflösbares Ziel zählt als Verlust.
async fn run(app: AppHandle, targets: Vec<PingTarget>, interval: Duration, stop: Arc<AtomicBool>) {
    let mut window = RollingWindow::new(&targets);
    let mut ips: Vec<Option<IpAddr>> = vec![None; targets.len()];

    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();

        // Fehlende Adressen (erneut) auflösen – parallel, zeitlich begrenzt
        let pending: Vec<usize> = (0..targets.len()).filter(|i| ips[*i].is_none()).collect();
        if !pending.is_empty() {
            let resolved = join_all(pending.iter().map(|i| ping::resolve_target(&targets[*i]))).await;
            for (i, r) in pending.into_iter().zip(resolved) {
                ips[i] = r.ok();
            }
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let results = join_all(targets.iter().zip(ips.iter()).map(|(t, ip)| async move {
            match ip {
                Some(ip) => ping::probe(t, *ip).await,
                None => None,
            }
        }))
        .await;
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let now = crate::util::now_ms();
        let samples: Vec<PingSample> = targets
            .iter()
            .zip(results)
            .map(|(t, rtt)| {
                window.push(&t.id, rtt);
                PingSample { target_id: t.id.clone(), t: now, rtt }
            })
            .collect();
        let update = MonitorUpdate { samples, stats: window.stats() };
        let _ = app.emit(EVENT_PING, &update);

        let elapsed = tick.elapsed();
        if elapsed < interval {
            tokio::time::sleep(interval - elapsed).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::types::PingMethod;

    fn target(id: &str) -> PingTarget {
        PingTarget { id: id.into(), label: id.into(), host: "127.0.0.1".into(), port: None, method: PingMethod::Tcp }
    }

    #[test]
    fn interval_is_clamped() {
        assert_eq!(clamp_interval(None), Duration::from_millis(1000));
        assert_eq!(clamp_interval(Some(10)), Duration::from_millis(250));
        assert_eq!(clamp_interval(Some(99_999)), Duration::from_millis(10_000));
        assert_eq!(clamp_interval(Some(700)), Duration::from_millis(700));
    }

    #[test]
    fn rolling_window_keeps_last_60_per_target() {
        let mut w = RollingWindow::new(&[target("a"), target("b")]);
        for i in 0..100 {
            w.push("a", Some(i as f64));
        }
        w.push("b", None);
        w.push("b", Some(20.0));
        w.push("unbekannt", Some(1.0)); // wird ignoriert

        let stats = w.stats();
        assert_eq!(stats.len(), 2);
        let a = &stats[0];
        assert_eq!(a.target_id, "a");
        assert_eq!(a.samples, 60);
        assert_eq!(a.min, Some(40.0), "die ältesten 40 Werte sind herausgefallen");
        assert_eq!(a.max, Some(99.0));
        assert_eq!(a.last, Some(99.0));
        assert_eq!(a.jitter, Some(1.0));
        let b = &stats[1];
        assert_eq!(b.samples, 2);
        assert_eq!(b.loss, 0.5);
        assert_eq!(b.last, Some(20.0));
    }
}
