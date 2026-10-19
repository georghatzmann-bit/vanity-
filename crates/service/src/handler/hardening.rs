//! Härtung & Sicherheits-Score (P6, nur lesend): Der Dienst liest die Systemfakten (außerhalb
//! der Dienst-Sperre, dauert einige Sekunden), bewertet sie mit `aegis-hardening` und merkt sich
//! je Tag einen Score für den Verlauf. Behoben wird hier nichts.

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::time::OffsetDateTime;
use aegis_hardening::{CheckResult, Score, SystemFacts, evaluate, score};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use crate::protocol::Response;
use crate::schedule::ScorePoint;

/// Tage im Score-Verlauf.
pub const HISTORY_DAYS: usize = 90;
/// Höchstzahl Hosts-Einträge bzw. Ports in der Antwort.
const MAX_SHOWN: usize = 300;
/// So lange gilt ein Ergebnis ohne „neu prüfen“ (Minuten).
pub const CACHE_MINUTES: i64 = 10;

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct HardeningState {
    /// Werden die Fakten auf diesem System gelesen (Windows)?
    pub available: bool,
    /// Score.
    pub score: Score,
    /// Ergebnisse je Prüfung.
    pub checks: Vec<CheckResult>,
    /// Gelesene Fakten (Hosts-Einträge und Ports gekürzt).
    pub facts: SystemFacts,
    /// Score je Tag (älteste zuerst).
    pub history: Vec<ScorePoint>,
    /// Zeitpunkt der Prüfung (RFC 3339).
    pub checked_at: String,
}

/// Liest die Fakten (nur lesend, ohne Dienst-Sperre aufrufen). Der Proxy wird für das
/// anfragende Konto gelesen.
#[must_use]
pub fn collect_facts(user: &dyn UserAccess) -> SystemFacts {
    #[cfg(windows)]
    {
        let sid = user.identity().filter(|s| s.starts_with("S-"));
        aegis_hardening::collect::collect(sid.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = user;
        SystemFacts::default()
    }
}

/// Fügt den Score des Tages ein (ersetzt einen früheren Wert desselben Tages).
pub fn record_point(history: &mut Vec<ScorePoint>, date: String, value: u8) {
    history.retain(|p| p.date != date);
    history.push(ScorePoint { date, value });
    history.sort_by(|a, b| a.date.cmp(&b.date));
    let excess = history.len().saturating_sub(HISTORY_DAYS);
    history.drain(..excess);
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Ein höchstens [`CACHE_MINUTES`] altes Ergebnis für das Konto (sonst `None`).
    pub fn hardening_cached(&self, user: &dyn UserAccess) -> Option<Response> {
        let now = self.now();
        self.hardening_cache
            .get(&user.identity())
            .filter(|(at, _)| now - *at < aegis_core::time::Duration::minutes(CACHE_MINUTES))
            .map(|(_, state)| Response::Hardening {
                state: Box::new(state.clone()),
            })
    }

    /// Bewertet gelesene Fakten, merkt den Score des Tages und antwortet.
    pub fn hardening_finish(&mut self, mut facts: SystemFacts, user: &dyn UserAccess) -> Response {
        let checks = evaluate(&facts);
        let score = score(&checks);
        let now: OffsetDateTime = self.now();
        let date = format!(
            "{:04}-{:02}-{:02}",
            now.year(),
            u8::from(now.month()),
            now.day()
        );
        if let Some(value) = score.value {
            // Verlauf ist ein Komfort: Ein Speicherfehler verhindert die Antwort nicht.
            let _ = self
                .settings
                .update(|s| record_point(&mut s.hardening, date.clone(), value));
        }
        if let Some(hosts) = facts.hosts.as_mut() {
            hosts.truncate(MAX_SHOWN);
        }
        if let Some(ports) = facts.listening.as_mut() {
            ports.truncate(MAX_SHOWN);
        }
        let state = HardeningState {
            available: cfg!(windows),
            score,
            checks,
            facts,
            history: self.settings.get().hardening.clone(),
            checked_at: now
                .format(&aegis_core::time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        };
        if self.hardening_cache.len() >= 32 {
            self.hardening_cache.clear();
        }
        self.hardening_cache
            .insert(user.identity(), (now, state.clone()));
        Response::Hardening {
            state: Box::new(state),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verlauf_je_tag_und_begrenzt() {
        let mut h = Vec::new();
        record_point(&mut h, "2026-10-01".into(), 50);
        record_point(&mut h, "2026-10-01".into(), 60);
        record_point(&mut h, "2026-09-30".into(), 40);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].date, "2026-09-30");
        assert_eq!(h[1].value, 60);
        for d in 0..200 {
            record_point(
                &mut h,
                format!("2027-{:02}-{:02}", d / 28 + 1, d % 28 + 1),
                70,
            );
        }
        assert_eq!(h.len(), HISTORY_DAYS);
        assert!(h[0].date.starts_with("2027"));
    }
}
