//! Härtung & Sicherheits-Score (P6, nur lesend): Der Dienst liest die Systemfakten (außerhalb
//! der Dienst-Sperre, dauert einige Sekunden), bewertet sie mit `aegis-hardening` und merkt sich
//! je Tag und Konto einen Score für den Verlauf (der Proxy ist je Konto). Behoben wird hier
//! nichts. Die rechnerweiten Fakten werden höchstens alle 30 Sekunden neu gelesen – „neu
//! prüfen“ in schneller Folge (auch von mehreren Konten) blockiert so niemanden.

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::time::OffsetDateTime;
use aegis_hardening::{CheckResult, Score, SystemFacts, evaluate, score};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use crate::protocol::Response;
use crate::schedule::{OwnerScores, ScorePoint};

/// Tage im Score-Verlauf.
pub const HISTORY_DAYS: usize = 90;
/// Höchstzahl Hosts-Einträge bzw. Ports in der Antwort.
const MAX_SHOWN: usize = 300;
/// So lange gilt ein Ergebnis ohne „neu prüfen“ (Minuten).
pub const CACHE_MINUTES: i64 = 10;
/// Rechnerweite Fakten werden höchstens so oft neu gelesen (Sekunden).
pub const FACTS_MIN_SECONDS: i64 = 30;
/// Konten mit Score-Verlauf.
const MAX_OWNERS: usize = 50;

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
    /// Darf das Konto rechnerweite Punkte beheben (Administrator)?
    pub admin: bool,
    /// Rückgängig machbare Schritte des Kontos (neueste zuerst).
    pub undo: Vec<super::harden::UndoInfo>,
}

/// Liest die rechnerweiten Fakten (nur lesend, ohne Dienst-Sperre aufrufen; ohne Proxy).
#[must_use]
pub fn collect_machine_facts() -> SystemFacts {
    #[cfg(windows)]
    {
        aegis_hardening::collect::collect(None)
    }
    #[cfg(not(windows))]
    {
        SystemFacts::default()
    }
}

/// Proxy des anfragenden Kontos (nur lesend).
#[must_use]
pub fn user_proxy(user: &dyn UserAccess) -> Option<aegis_hardening::facts::ProxyState> {
    #[cfg(windows)]
    {
        let sid = user.identity().filter(|s| s.starts_with("S-1-"))?;
        aegis_hardening::collect::proxy_of(&sid)
    }
    #[cfg(not(windows))]
    {
        let _ = user;
        None
    }
}

/// Fügt den Score des Tages ein (ersetzt einen früheren Wert desselben Tages). Liefert, ob
/// sich etwas geändert hat.
pub fn record_point(history: &mut Vec<ScorePoint>, date: String, value: u8) -> bool {
    if history.iter().any(|p| p.date == date && p.value == value) {
        return false;
    }
    history.retain(|p| p.date != date);
    history.push(ScorePoint { date, value });
    history.sort_by(|a, b| a.date.cmp(&b.date));
    let excess = history.len().saturating_sub(HISTORY_DAYS);
    history.drain(..excess);
    true
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Ein höchstens [`CACHE_MINUTES`] altes Ergebnis für das Konto (sonst `None`).
    pub fn hardening_cached(&self, user: &dyn UserAccess) -> Option<Response> {
        let now = self.now();
        self.hardening_cache
            .get(&user.identity())
            .filter(|(at, _)| now - *at < aegis_core::time::Duration::minutes(CACHE_MINUTES))
            .map(|(_, state)| {
                let mut state = state.clone();
                state.admin = user.is_admin();
                state.undo = self.fix_undo_list(user);
                Response::Hardening {
                    state: Box::new(state),
                }
            })
    }

    /// Rechnerweite Fakten, wenn sie jünger als [`FACTS_MIN_SECONDS`] sind.
    #[must_use]
    pub fn recent_machine_facts(&self) -> Option<SystemFacts> {
        let now = self.now();
        self.machine_facts
            .as_ref()
            .filter(|(at, _)| now - *at < aegis_core::time::Duration::seconds(FACTS_MIN_SECONDS))
            .map(|(_, f)| f.clone())
    }

    fn history_of(&self, owner: &Option<String>) -> Vec<ScorePoint> {
        self.settings
            .get()
            .hardening
            .iter()
            .find(|o| o.owner == *owner)
            .map_or_else(Vec::new, |o| o.points.clone())
    }

    /// Bewertet rechnerweite Fakten plus den Proxy des Kontos, merkt den Score des Tages (je
    /// Konto) und antwortet.
    pub fn hardening_finish(
        &mut self,
        machine: SystemFacts,
        proxy: Option<aegis_hardening::facts::ProxyState>,
        user: &dyn UserAccess,
    ) -> Response {
        let now: OffsetDateTime = self.now();
        let fresh = self
            .machine_facts
            .as_ref()
            .is_none_or(|(_, f)| *f != machine);
        if fresh {
            self.machine_facts = Some((now, machine.clone()));
        }
        let mut facts = machine;
        facts.proxy = proxy;
        let checks = evaluate(&facts);
        let score = score(&checks);
        let date = format!(
            "{:04}-{:02}-{:02}",
            now.year(),
            u8::from(now.month()),
            now.day()
        );
        let owner = user.identity();
        if let Some(value) = score.value {
            let mut history = self.history_of(&owner);
            if record_point(&mut history, date, value) {
                // Verlauf ist ein Komfort: Ein Speicherfehler verhindert die Antwort nicht.
                let _ = self.settings.update(|s| {
                    s.hardening.retain(|o| o.owner != owner);
                    s.hardening.push(OwnerScores {
                        owner: owner.clone(),
                        points: history,
                    });
                    let excess = s.hardening.len().saturating_sub(MAX_OWNERS);
                    s.hardening.drain(..excess);
                });
            }
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
            history: self.history_of(&owner),
            checked_at: now
                .format(&aegis_core::time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
            admin: user.is_admin(),
            undo: self.fix_undo_list(user),
        };
        if self.hardening_cache.len() >= 32 {
            self.hardening_cache.clear();
        }
        self.hardening_cache.insert(owner, (now, state.clone()));
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
        assert!(record_point(&mut h, "2026-10-01".into(), 50));
        assert!(record_point(&mut h, "2026-10-01".into(), 60));
        assert!(
            !record_point(&mut h, "2026-10-01".into(), 60),
            "unverändert"
        );
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
