//! Defender-Schalter (P8): Status von Microsoft Defender zeigen und Änderungen nur als Plan
//! vorschlagen – Echtzeitschutz aus/an, Funde „nur melden“. Ausgeführt wird erst nach „Ja“
//! (über den Härtungs-Weg, mit Rückgängig), nur für Administratoren und nur über
//! `Set-MpPreference`/`Remove-MpPreference`. Der Manipulationsschutz wird nie umgangen.

use std::collections::HashMap;

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::plan::UndoHint;
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_defender_switch::{Blocked, Change, DefenderStatus, check, commands};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use super::harden::{Step, Texts};
use crate::history::{HistoryKind, Reader};
use crate::protocol::Response;

/// Kennung der Einstellung in Plänen.
pub const DEFENDER_SETTING: &str = "defender.switch";
/// So lange gilt ein gelesener Status für einen Vorschlag.
pub const STATUS_MINUTES: i64 = 10;
/// Anfang aller Plan-Titel (auch für das Protokoll).
pub const TITLE_PREFIX: &str = "Microsoft Defender";

/// Ein Eintrag im Protokoll der Umschaltungen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    /// Zeitpunkt (RFC 3339).
    pub at: String,
    /// Titel (Was – Ergebnis).
    pub title: String,
}

/// Antwort „Defender“.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DefenderState {
    /// Gelesener Status.
    pub status: DefenderStatus,
    /// Darf das Konto umschalten?
    pub admin: bool,
    /// Je Änderung: `None` = möglich, sonst der Grund.
    pub options: Vec<(Change, Option<Blocked>)>,
    /// Letzte Umschaltungen dieses Kontos.
    pub log: Vec<LogEntry>,
}

/// Liest den Status (nur Windows; sonst „nicht verfügbar“).
#[must_use]
pub fn read_status() -> DefenderStatus {
    #[cfg(windows)]
    {
        aegis_hardening::collect::defender_status()
    }
    #[cfg(not(windows))]
    {
        DefenderStatus::default()
    }
}

/// Schritte für einen Plan-Wert (Kennung der Änderung), rein – testbar.
///
/// # Errors
/// Unbekannte Änderung.
pub fn defender_steps(value: &str) -> Result<Vec<Step>, String> {
    let change = Change::parse(value).ok_or_else(|| "Unbekannte Änderung".to_owned())?;
    Ok(commands(change)
        .into_iter()
        .map(|command| Step::Defender { command })
        .collect())
}

fn texts(change: Change) -> Texts {
    match change {
        Change::RealtimeOff => Texts {
            what: "Microsoft Defender: Echtzeitschutz ausschalten",
            why: "Von dir gewählt – z. B. für eine Installation, die Defender fälschlich blockiert.",
            consequence: "Neue und geöffnete Dateien werden nicht mehr laufend geprüft, bis du den Echtzeitschutz wieder einschaltest (Windows schaltet ihn nach einiger Zeit oft von selbst wieder ein). AEGIS prüft weiter, kann Programme aber nicht vor dem Start blockieren.",
        },
        Change::RealtimeOn => Texts {
            what: "Microsoft Defender: Echtzeitschutz einschalten",
            why: "Von dir gewählt.",
            consequence: "Defender prüft Dateien wieder laufend.",
        },
        Change::ReportOnlyOn => Texts {
            what: "Microsoft Defender: Funde nur melden",
            why: "Von dir gewählt – du willst selbst entscheiden, was mit Funden passiert.",
            consequence: "Defender meldet Funde, entfernt oder isoliert sie aber nicht mehr selbst. Windows kann das bei Cloud- oder Manipulationsschutz übersteuern – AEGIS zeigt danach den echten Stand.",
        },
        Change::ReportOnlyOff => Texts {
            what: "Microsoft Defender: Standardaktionen wiederherstellen",
            why: "Von dir gewählt.",
            consequence: "Defender entscheidet wieder selbst über Funde (Windows-Standard).",
        },
    }
}

/// Text zu einem Grund, warum es keinen Plan gibt.
#[must_use]
pub fn blocked_text(blocked: Blocked) -> (&'static str, &'static str) {
    match blocked {
        Blocked::Unavailable => (
            "unavailable",
            "Microsoft Defender ist auf diesem PC nicht erreichbar.",
        ),
        Blocked::Tamper => (
            "tamper",
            "Der Manipulationsschutz ist an. AEGIS umgeht ihn nicht – schalte ihn bei Bedarf selbst in der Windows-Sicherheit aus.",
        ),
        Blocked::Passive => (
            "passive",
            "Ein anderes Antivirenprogramm ist aktiv; Defender läuft nur passiv. Den Echtzeitschutz steuert dann das andere Programm.",
        ),
        Blocked::Policy => (
            "policy",
            "Eine Gruppenrichtlinie schaltet den Echtzeitschutz ab. AEGIS ändert keine Richtlinien – das macht die Verwaltung dieses PCs.",
        ),
        Blocked::AlreadyThere => ("already", "Das ist bereits so eingestellt."),
    }
}

const CHANGES: [Change; 4] = [
    Change::RealtimeOff,
    Change::RealtimeOn,
    Change::ReportOnlyOn,
    Change::ReportOnlyOff,
];

impl<C: Clock, W: Durable> Service<C, W> {
    /// Antwort auf „Defender“: Status (eben gelesen), Möglichkeiten, Protokoll.
    pub fn defender_finish(&mut self, status: DefenderStatus, user: &dyn UserAccess) -> Response {
        let now = self.now();
        self.defender_status = Some((now, status.clone()));
        let owner = user.identity();
        let profile = user.profile().map(crate::watch::long_name);
        let log = super::lock_history(&self.history)
            .list(Reader {
                owner: owner.as_deref(),
                profile: profile.as_deref(),
            })
            .into_iter()
            .filter(|e| e.kind == HistoryKind::Action && e.title.starts_with(TITLE_PREFIX))
            .take(20)
            .map(|e| LogEntry {
                at: e
                    .at
                    .format(&aegis_core::time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
                title: e.title,
            })
            .collect();
        Response::Defender {
            state: Box::new(DefenderState {
                options: CHANGES
                    .iter()
                    .map(|c| (*c, check(*c, &status).err()))
                    .collect(),
                status,
                admin: user.is_admin(),
                log,
            }),
        }
    }

    fn fresh_defender_status(&self, now: OffsetDateTime) -> Option<&DefenderStatus> {
        self.defender_status
            .as_ref()
            .filter(|(at, _)| now - *at < Duration::minutes(STATUS_MINUTES) && *at <= now)
            .map(|(_, s)| s)
    }

    /// Schlägt eine Änderung an Defender vor (nur Administratoren, nur aus frischem Status).
    pub fn propose_defender(&mut self, change: &str, user: &dyn UserAccess) -> Response {
        let Some(change) = Change::parse(change) else {
            return Response::error("input", "Unbekannte Änderung");
        };
        if !user.is_admin() {
            return Response::error(
                "admin",
                "Microsoft Defender gilt für den ganzen PC – dafür braucht AEGIS Administratorrechte.",
            );
        }
        let now = self.now();
        let Some(status) = self.fresh_defender_status(now) else {
            return Response::error(
                "status",
                "Bitte zuerst den Status neu lesen – AEGIS schlägt nur auf Grundlage des aktuellen Stands vor.",
            );
        };
        if let Err(blocked) = check(change, status) {
            let (code, text) = blocked_text(blocked);
            return Response::error(code, text);
        }
        let steps = match defender_steps(change.as_str()) {
            Ok(s) => s,
            Err(e) => return Response::error("input", e),
        };
        let undo = if change.weakens() {
            "Ein Klick auf „Wieder einschalten“ bzw. „Standard wiederherstellen“ (oder „Rückgängig“ auf der Seite „Härtung“) stellt den alten Stand wieder her."
        } else {
            "Lässt sich jederzeit wieder umschalten."
        };
        let plan = self.fix_plan_public(
            DEFENDER_SETTING,
            change.as_str(),
            &steps,
            &texts(change),
            UndoHint::reversible(undo),
            if change.weakens() {
                RiskLevel::Dangerous
            } else {
                RiskLevel::Info
            },
        );
        // Nach der Ausführung soll der Status neu gelesen werden (echter Stand).
        self.defender_status = None;
        match plan {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schritte_nur_fuer_bekannte_aenderungen() {
        let steps = defender_steps("realtime_off").unwrap();
        assert_eq!(steps.len(), 1);
        assert!(steps[0].describe().contains("Echtzeitschutz ausschalten"));
        assert_eq!(defender_steps("report_only_on").unwrap().len(), 4);
        assert!(defender_steps("firewall_off").is_err());
        assert!(defender_steps("").is_err());
        for c in CHANGES {
            assert!(texts(c).what.starts_with(TITLE_PREFIX));
        }
        assert_eq!(blocked_text(Blocked::Tamper).0, "tamper");
    }
}
