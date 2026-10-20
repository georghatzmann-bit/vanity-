//! Wiederherstellungspunkte (Werkzeug 17): vorhandene Punkte zeigen und einen neuen Punkt nur
//! als Plan vorschlagen. Angelegt wird erst nach „Ja“ (über den Härtungs-Weg), nur für
//! Administratoren, mit festem Befehl (`Checkpoint-Computer`) und bereinigter Beschreibung.
//! Ein Punkt wird nie gelöscht und nie zurückgespielt – das bleibt bei Windows
//! („Systemwiederherstellung“).

use std::collections::HashMap;

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::plan::UndoHint;
use aegis_core::risk::RiskLevel;
use aegis_hardening::restore::{RestorePoint, clean_description};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use super::harden::{Step, Texts};
use crate::protocol::Response;

/// Kennung der Einstellung in Plänen.
pub const RESTORE_SETTING: &str = "system.restore_point";

/// Antwort „Wiederherstellungspunkte“.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreState {
    /// Vorhandene Punkte (neueste zuerst); `None`, wenn Windows sie nicht liefert
    /// (Computerschutz aus oder nicht lesbar).
    pub points: Option<Vec<RestorePoint>>,
    /// Darf das Konto Punkte anlegen?
    pub admin: bool,
}

/// Liest die Punkte (nur Windows).
#[must_use]
pub fn read_points() -> Option<Vec<RestorePoint>> {
    #[cfg(windows)]
    {
        aegis_hardening::collect::restore_points().ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Antwort aus gelesenen Punkten.
#[must_use]
pub fn restore_response(points: Option<Vec<RestorePoint>>, user: &dyn UserAccess) -> Response {
    Response::RestorePoints {
        state: RestoreState {
            points,
            admin: user.is_admin(),
        },
    }
}

/// Schritte für einen Plan-Wert (die bereinigte Beschreibung), rein – testbar.
///
/// # Errors
/// Beschreibung leer oder nicht bereinigt.
pub fn restore_steps(value: &str) -> Result<Vec<Step>, String> {
    match clean_description(value) {
        Some(description) if description == value => Ok(vec![Step::RestorePoint { description }]),
        _ => Err("Ungültige Beschreibung".to_owned()),
    }
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Schlägt einen neuen Wiederherstellungspunkt vor (nur Administratoren).
    pub fn propose_restore_point(&mut self, description: &str, user: &dyn UserAccess) -> Response {
        if !user.is_admin() {
            return Response::error(
                "admin",
                "Wiederherstellungspunkte gelten für den ganzen PC – dafür braucht AEGIS Administratorrechte.",
            );
        }
        if let Some(busy) = self.proposal_limit(&user.identity()) {
            return busy;
        }
        let Some(description) = clean_description(description) else {
            return Response::error(
                "input",
                "Bitte eine kurze Beschreibung angeben (Buchstaben, Ziffern, Leerzeichen).",
            );
        };
        let steps = match restore_steps(&description) {
            Ok(s) => s,
            Err(e) => return Response::error("input", e),
        };
        let plan = self.fix_plan_public(
            RESTORE_SETTING,
            &description,
            &steps,
            &Texts {
                what: "Wiederherstellungspunkt anlegen",
                why: "Von dir gewählt – ein Sicherungsstand der Systemeinstellungen vor Änderungen.",
                consequence: "Windows legt einen neuen Wiederherstellungspunkt an (dauert oft eine Minute). Deine Dateien bleiben unberührt. Windows legt höchstens einen Punkt je 24 Stunden an und braucht dafür den eingeschalteten Computerschutz – AEGIS prüft danach, ob der Punkt wirklich da ist.",
            },
            UndoHint::reversible(
                "Ein Punkt verändert nichts an deinem System. Entfernen oder zurückspielen kannst du ihn in Windows unter „Systemwiederherstellung“ – AEGIS löscht keine Punkte.",
            ),
            RiskLevel::Info,
        );
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
    fn nur_bereinigte_beschreibung() {
        let steps = restore_steps("Vor AEGIS-Härtung").unwrap();
        assert!(steps[0].describe().contains("Vor AEGIS-Härtung"));
        assert!(restore_steps("a'; b").is_err());
        assert!(restore_steps("").is_err());
    }
}
