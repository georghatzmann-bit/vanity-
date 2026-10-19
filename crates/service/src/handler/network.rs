//! Netzwerk (P7): Verbindungen je Programm mit Land und Verlauf, Firewall-Übersicht und – nur
//! per Plan mit „Ja“ – eine AEGIS-Regel „Netz für Programm sperren“ (ausgehend blockieren) bzw.
//! deren Entfernen. Fremde Firewall-Regeln fasst AEGIS nie an.
//!
//! Kontotrennung: Jedes Konto sieht nur Verbindungen seiner eigenen Programme; Administratoren
//! sehen alle (Windows zeigt ihnen das ohnehin). Der Verlauf ist je Konto und liegt nur im
//! Speicher des Dienstes (seit Dienststart, höchstens 30 Tage, 2000 Ziele).

use std::collections::HashMap;

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::plan::UndoHint;
use aegis_core::risk::RiskLevel;
use aegis_netwatch::conn::{Connection, History, RawConnection, SeenDestination};
use aegis_netwatch::firewall::{
    FirewallRule, Summary, block_rule_name, is_aegis_rule, notable, summarize, valid_program,
};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use super::harden::{Step, Texts};
use crate::protocol::Response;

/// Einstellung „Firewall-Regel von AEGIS“ (Wert `add:<Programm>` bzw. `remove:<Programm>`).
pub const BLOCK_SETTING: &str = "network.block";
/// Höchstzahl Verbindungen in der Antwort.
const MAX_SHOWN: usize = 500;

/// Eine Verbindung mit Konto (für die Kontotrennung).
pub type OwnedConnection = (Option<String>, RawConnection);

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct NetworkState {
    /// Unter Windows gelesen?
    pub available: bool,
    /// Aktuelle Verbindungen (neue Ziele zuerst).
    pub connections: Vec<Connection>,
    /// Verlauf des Kontos (zuletzt gesehen zuerst, höchstens 300).
    pub history: Vec<SeenDestination>,
    /// Darf das Konto Firewall-Regeln anlegen (Administrator)? Sieht es alle Verbindungen?
    pub admin: bool,
}

/// Eine Firewall-Regel mit Hinweis.
#[derive(Debug, Clone, Serialize)]
pub struct RuleView {
    /// Regel.
    #[serde(flatten)]
    pub rule: FirewallRule,
    /// Hinweis (Deutsch, Englisch).
    pub note: Option<(String, String)>,
}

/// Firewall-Übersicht.
#[derive(Debug, Clone, Serialize)]
pub struct FirewallState {
    /// Unter Windows gelesen?
    pub available: bool,
    /// Zahlen.
    pub summary: Summary,
    /// Auffällige Regeln.
    pub notable: Vec<RuleView>,
    /// Regeln von AEGIS (entfernbar per Plan).
    pub aegis: Vec<RuleView>,
    /// Administrator?
    pub admin: bool,
}

/// Liest alle TCP-Verbindungen mit Programm und Konto (nur lesend, ohne Dienst-Sperre).
#[must_use]
pub fn read_connections() -> Vec<OwnedConnection> {
    #[cfg(windows)]
    {
        let Ok(list) = aegis_winffi::inspect::tcp_connections() else {
            return Vec::new();
        };
        let mut programs: HashMap<u32, (Option<String>, Option<String>)> = HashMap::new();
        list.into_iter()
            .filter(|c| c.pid != 0 && c.pid != 4)
            .take(5000)
            .map(|c| {
                let (owner, program) = programs
                    .entry(c.pid)
                    .or_insert_with(|| {
                        (
                            aegis_winffi::system::process_user_sid(c.pid).ok(),
                            aegis_winffi::system::process_image_path(c.pid)
                                .ok()
                                .map(|p| p.display().to_string()),
                        )
                    })
                    .clone();
                (
                    owner,
                    RawConnection {
                        pid: c.pid,
                        program,
                        remote: c.remote,
                        port: c.port,
                        state: c.state,
                    },
                )
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Verbindungen nach Konto getrennt.
#[must_use]
pub fn by_owner(list: Vec<OwnedConnection>) -> HashMap<Option<String>, Vec<RawConnection>> {
    let mut out: HashMap<Option<String>, Vec<RawConnection>> = HashMap::new();
    for (owner, c) in list {
        out.entry(owner).or_default().push(c);
    }
    out
}

/// Liest die Firewall-Regeln (lokal + Gruppenrichtlinie; nur lesend).
#[must_use]
pub fn read_rules() -> Vec<FirewallRule> {
    #[cfg(windows)]
    {
        use aegis_winffi::inspect::{Hive, read_values_limited};
        let mut out = Vec::new();
        for (key, policy) in [
            (
                r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules",
                false,
            ),
            (
                r"SOFTWARE\Policies\Microsoft\WindowsFirewall\FirewallRules",
                true,
            ),
        ] {
            for v in read_values_limited(&Hive::LocalMachine, key, 8192, 4096) {
                if let Some(rule) = aegis_netwatch::firewall::parse_rule(&v.data, policy) {
                    out.push(rule);
                }
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Firewall-Übersicht aus den gelesenen Regeln.
#[must_use]
pub fn firewall_state(rules: &[FirewallRule], admin: bool) -> FirewallState {
    let view = |r: &FirewallRule| RuleView {
        rule: r.clone(),
        note: notable(r),
    };
    FirewallState {
        available: cfg!(windows),
        summary: summarize(rules),
        notable: rules
            .iter()
            .filter(|r| notable(r).is_some())
            .take(200)
            .map(view)
            .collect(),
        aegis: rules
            .iter()
            .filter(|r| is_aegis_rule(&r.name))
            .take(200)
            .map(view)
            .collect(),
        admin,
    }
}

/// Schritte für einen Plan-Wert (`add:<Programm>` / `remove:<Programm>`), rein – testbar.
///
/// # Errors
/// Ungültiger Wert oder Programmpfad.
pub fn block_steps(value: &str) -> Result<Vec<Step>, String> {
    let (present, program) = if let Some(p) = value.strip_prefix("add:") {
        (true, p)
    } else if let Some(p) = value.strip_prefix("remove:") {
        (false, p)
    } else {
        return Err("Unbekannter Schritt".into());
    };
    if !valid_program(program) {
        return Err("Ungültiger Programmpfad".into());
    }
    Ok(vec![Step::BlockProgram {
        name: block_rule_name(program),
        program: program.to_owned(),
        present,
    }])
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Nimmt Verbindungen in die Verläufe auf (Hintergrund-Abfrage, alle Konten).
    pub fn observe_connections(&mut self, list: Vec<OwnedConnection>) {
        let now = self.now().unix_timestamp();
        let geo = aegis_netwatch::geo::geo();
        for (owner, raw) in by_owner(list) {
            if self.net_history.len() >= 64 && !self.net_history.contains_key(&owner) {
                continue;
            }
            self.net_history
                .entry(owner)
                .or_default()
                .observe(now, &raw, &|ip| geo.country(ip));
        }
    }

    /// Antwort auf „Netzwerk“: aktuelle Verbindungen (eigene bzw. alle für Administratoren)
    /// und der Verlauf des Kontos.
    pub fn network_finish(
        &mut self,
        list: Vec<OwnedConnection>,
        user: &dyn UserAccess,
    ) -> Response {
        let now = self.now().unix_timestamp();
        let me = user.identity();
        let admin = user.is_admin();
        let geo = aegis_netwatch::geo::geo();
        let mut connections = Vec::new();
        for (owner, raw) in by_owner(list) {
            if owner != me && !admin {
                continue;
            }
            if self.net_history.len() >= 64 && !self.net_history.contains_key(&owner) {
                continue;
            }
            let history = self.net_history.entry(owner).or_default();
            connections.extend(history.observe(now, &raw, &|ip| geo.country(ip)));
        }
        connections.sort_by(|a, b| {
            b.new
                .cmp(&a.new)
                .then_with(|| a.program.cmp(&b.program))
                .then_with(|| a.remote.cmp(&b.remote))
        });
        connections.truncate(MAX_SHOWN);
        let mut history = self
            .net_history
            .get(&me)
            .map(History::entries)
            .unwrap_or_default();
        history.truncate(300);
        Response::Network {
            state: Box::new(NetworkState {
                available: cfg!(windows),
                connections,
                history,
                admin,
            }),
        }
    }

    /// Schlägt vor, ausgehende Verbindungen eines Programms per AEGIS-Regel zu sperren
    /// (`present`) bzw. die AEGIS-Regel wieder zu entfernen.
    pub fn propose_firewall_block(
        &mut self,
        program: &str,
        present: bool,
        user: &dyn UserAccess,
    ) -> Response {
        if !user.is_admin() {
            return Response::error(
                "admin",
                "Firewall-Regeln gelten für den ganzen PC – dafür braucht AEGIS Administratorrechte.",
            );
        }
        let value = format!("{}:{program}", if present { "add" } else { "remove" });
        let steps = match block_steps(&value) {
            Ok(s) => s,
            Err(e) => return Response::error("input", e),
        };
        if present && std::fs::symlink_metadata(program).map_or(true, |m| !m.is_file()) {
            return Response::error("input", "Programm nicht gefunden");
        }
        let texts = if present {
            Texts {
                what: "Netz für ein Programm sperren (Windows-Firewall)",
                why: "Von dir gewählt – z. B. weil das Programm unbekannte Ziele im Internet kontaktiert.",
                consequence: "AEGIS legt eine eigene Regel an, die ausgehende Verbindungen genau dieses Programms blockiert. Andere Programme und bestehende Regeln bleiben unverändert; das Programm selbst wird nicht verändert.",
            }
        } else {
            Texts {
                what: "AEGIS-Firewall-Regel entfernen",
                why: "Von dir gewählt.",
                consequence: "Das Programm darf danach wieder ins Netz (soweit andere Regeln es erlauben). Entfernt wird nur die Regel von AEGIS.",
            }
        };
        let plan = self.fix_plan_public(
            BLOCK_SETTING,
            &value,
            &steps,
            &texts,
            UndoHint::reversible(if present {
                "„Rückgängig“ auf der Seite „Netzwerk“ bzw. „Härtung“ entfernt die Regel wieder."
            } else {
                "Die Regel lässt sich jederzeit wieder anlegen („Netz sperren …“)."
            }),
            if present {
                RiskLevel::Info
            } else {
                RiskLevel::Suspicious
            },
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
    fn schritte_nur_fuer_gueltige_programme() {
        let s = block_steps(r"add:C:\Temp\x.exe").unwrap();
        assert_eq!(
            s[0].describe(),
            format!(
                r"Windows-Firewall: Regel „{}“ anlegen – ausgehende Verbindungen von C:\Temp\x.exe blockieren",
                block_rule_name(r"C:\Temp\x.exe")
            )
        );
        assert!(s[0].machine_wide());
        assert!(block_steps(r"remove:C:\Temp\x.exe").is_ok());
        assert!(block_steps(r"add:C:\a\..\x.exe").is_err());
        assert!(block_steps(r"drop:C:\Temp\x.exe").is_err());
        assert!(block_steps(r#"add:C:\Temp\x.exe" dir=in"#).is_err());
    }

    #[test]
    fn verbindungen_nach_konto() {
        let c = |pid| RawConnection {
            pid,
            program: None,
            remote: "1.2.3.4".parse().unwrap(),
            port: 443,
            state: 5,
        };
        let map = by_owner(vec![
            (Some("A".into()), c(1)),
            (Some("B".into()), c(2)),
            (Some("A".into()), c(3)),
        ]);
        assert_eq!(map[&Some("A".to_owned())].len(), 2);
        assert_eq!(map[&Some("B".to_owned())].len(), 1);
    }

    #[test]
    fn firewall_uebersicht() {
        let rules = vec![
            aegis_netwatch::firewall::parse_rule(
                &format!(
                    r"v2.31|Action=Block|Active=TRUE|Dir=Out|App=C:\Temp\x.exe|Name={}|",
                    block_rule_name(r"C:\Temp\x.exe")
                ),
                false,
            )
            .unwrap(),
            aegis_netwatch::firewall::parse_rule(
                r"v2.31|Action=Allow|Active=TRUE|Dir=In|App=C:\Users\a\Downloads\s.exe|Name=S|",
                false,
            )
            .unwrap(),
        ];
        let st = firewall_state(&rules, true);
        assert_eq!(st.aegis.len(), 1);
        assert_eq!(st.notable.len(), 1);
        assert_eq!(st.summary.total, 2);
    }
}
