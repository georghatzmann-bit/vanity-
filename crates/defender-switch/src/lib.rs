//! Defender-Schalter (P8): Microsoft Defender Antivirus transparent ein- und ausschalten bzw.
//! „nur melden“ lassen – **nur über dokumentierte Wege** (`Set-MpPreference` /
//! `Remove-MpPreference`) und nur nach einem Plan mit „Ja“ im Dienst.
//!
//! - Der Manipulationsschutz (Tamper Protection) wird **nie** umgangen: Ist er an, gibt es
//!   keinen Plan zum Ausschalten, sondern eine Anleitung für die Windows-Sicherheit.
//! - Angefasst wird nur der Virenschutz – nie Firewall, SmartScreen, Windows Update oder
//!   Exploit-Schutz.
//! - Diese Bibliothek bewertet und formuliert nur (rein, testbar); gelesen wird über WMI in
//!   `aegis-hardening`, ausgeführt im Dienst.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Schweregrade der Standardaktionen („…ThreatDefaultAction“).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Niedrig.
    Low,
    /// Mittel.
    Moderate,
    /// Hoch.
    High,
    /// Schwerwiegend.
    Severe,
}

impl Level {
    /// Alle Stufen.
    pub const ALL: [Self; 4] = [Self::Low, Self::Moderate, Self::High, Self::Severe];

    /// Name im Cmdlet bzw. in `MSFT_MpPreference`.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Moderate => "Moderate",
            Self::High => "High",
            Self::Severe => "Severe",
        }
    }

    fn german(self) -> &'static str {
        match self {
            Self::Low => "niedrig",
            Self::Moderate => "mittel",
            Self::High => "hoch",
            Self::Severe => "schwerwiegend",
        }
    }
}

/// Aktion „nur melden“ (`NoAction`).
pub const NO_ACTION: u8 = 9;

/// Name einer Standardaktion (`ThreatAction`-Wert) – nur bekannte Werte.
#[must_use]
pub fn action_name(value: u8) -> Option<&'static str> {
    Some(match value {
        1 => "Clean",
        2 => "Quarantine",
        3 => "Remove",
        6 => "Allow",
        8 => "UserDefined",
        9 => "NoAction",
        10 => "Block",
        _ => return None,
    })
}

/// Standardaktionen je Stufe (`None` bzw. 0 = Windows-Standard).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreatActions {
    /// Niedrig.
    pub low: Option<u8>,
    /// Mittel.
    pub moderate: Option<u8>,
    /// Hoch.
    pub high: Option<u8>,
    /// Schwerwiegend.
    pub severe: Option<u8>,
}

impl ThreatActions {
    /// Wert einer Stufe (0 = Standard → `None`).
    #[must_use]
    pub fn get(&self, level: Level) -> Option<u8> {
        match level {
            Level::Low => self.low,
            Level::Moderate => self.moderate,
            Level::High => self.high,
            Level::Severe => self.severe,
        }
        .filter(|v| *v != 0)
    }

    /// Alle vier Stufen auf „nur melden“?
    #[must_use]
    pub fn report_only(&self) -> bool {
        Level::ALL.iter().all(|l| self.get(*l) == Some(NO_ACTION))
    }
}

/// Zustand von Microsoft Defender (wie gelesen).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefenderStatus {
    /// Defender-Schnittstelle (WMI) erreichbar.
    pub available: bool,
    /// Dienst läuft (`AMServiceEnabled`).
    pub service: Option<bool>,
    /// Virenschutz aktiv (`AntivirusEnabled`).
    pub antivirus: Option<bool>,
    /// Echtzeitschutz (`RealTimeProtectionEnabled`).
    pub realtime: Option<bool>,
    /// Cloud-Schutz (`MAPSReporting` ≠ 0).
    pub cloud: Option<bool>,
    /// Manipulationsschutz (`IsTamperProtected`).
    pub tamper: Option<bool>,
    /// Betriebsart (`AMRunningMode`: „Normal“, „Passive Mode“, …).
    pub running_mode: Option<String>,
    /// Alter der Signaturen (Tage).
    pub signature_age_days: Option<u32>,
    /// Gruppenrichtlinie schaltet den Echtzeitschutz ab.
    pub policy_realtime_off: bool,
    /// Standardaktionen für Funde.
    pub actions: ThreatActions,
    /// Wurden die Einstellungen (`MSFT_MpPreference`) gelesen? Sonst sind `cloud` und
    /// `actions` unbekannt.
    #[serde(default)]
    pub preferences: bool,
}

impl DefenderStatus {
    /// Läuft Defender nur passiv (anderes Antivirenprogramm aktiv)?
    #[must_use]
    pub fn passive(&self) -> bool {
        self.running_mode
            .as_deref()
            .is_some_and(|m| m.to_ascii_lowercase().contains("passive"))
    }
}

/// Gewünschte Änderung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    /// Echtzeitschutz aus.
    RealtimeOff,
    /// Echtzeitschutz an.
    RealtimeOn,
    /// Funde nur melden.
    ReportOnlyOn,
    /// Standardaktionen wiederherstellen.
    ReportOnlyOff,
}

impl Change {
    /// Kennung (Plan-Wert, Protokoll).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RealtimeOff => "realtime_off",
            Self::RealtimeOn => "realtime_on",
            Self::ReportOnlyOn => "report_only_on",
            Self::ReportOnlyOff => "report_only_off",
        }
    }

    /// Aus der Kennung.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::RealtimeOff,
            Self::RealtimeOn,
            Self::ReportOnlyOn,
            Self::ReportOnlyOff,
        ]
        .into_iter()
        .find(|c| c.as_str() == text)
    }

    /// Schwächt die Änderung den Schutz?
    #[must_use]
    pub fn weakens(self) -> bool {
        matches!(self, Self::RealtimeOff | Self::ReportOnlyOn)
    }
}

/// Warum es keinen Plan gibt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    /// Defender ist nicht erreichbar (nicht installiert/entfernt).
    Unavailable,
    /// Manipulationsschutz ist an – AEGIS umgeht ihn nicht.
    Tamper,
    /// Ein anderes Antivirenprogramm ist aktiv, Defender läuft nur passiv.
    Passive,
    /// Eine Gruppenrichtlinie legt den Echtzeitschutz fest.
    Policy,
    /// Der Zustand ist schon so.
    AlreadyThere,
}

/// Darf für `change` ein Plan entstehen?
///
/// # Errors
/// Der Grund, warum nicht.
pub fn check(change: Change, status: &DefenderStatus) -> Result<(), Blocked> {
    if !status.available {
        return Err(Blocked::Unavailable);
    }
    // Schwächen nur, wenn sicher bekannt ist, dass der Manipulationsschutz aus ist.
    if change.weakens() {
        match status.tamper {
            Some(true) => return Err(Blocked::Tamper),
            None => return Err(Blocked::Unavailable),
            Some(false) => {}
        }
    }
    let realtime = matches!(change, Change::RealtimeOff | Change::RealtimeOn);
    if realtime && status.realtime.is_none() {
        return Err(Blocked::Unavailable);
    }
    if !realtime && !status.preferences {
        return Err(Blocked::Unavailable);
    }
    if status.passive() && realtime {
        return Err(Blocked::Passive);
    }
    if status.policy_realtime_off && change == Change::RealtimeOn {
        return Err(Blocked::Policy);
    }
    let already = match change {
        Change::RealtimeOff => status.realtime == Some(false),
        Change::RealtimeOn => status.realtime == Some(true),
        Change::ReportOnlyOn => status.actions.report_only(),
        Change::ReportOnlyOff => Level::ALL.iter().all(|l| status.actions.get(*l).is_none()),
    };
    if already {
        Err(Blocked::AlreadyThere)
    } else {
        Ok(())
    }
}

/// Ein einzelner Befehl (fester Wortlaut, keine Nutzereingaben).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    /// Echtzeitschutz an/aus.
    Realtime {
        /// Einschalten?
        enabled: bool,
    },
    /// Standardaktion einer Stufe setzen (`None` = Windows-Standard).
    ThreatAction {
        /// Stufe.
        level: Level,
        /// Aktion.
        action: Option<u8>,
    },
}

impl Command {
    /// PowerShell-Befehl (`None` bei unbekannter Aktion).
    #[must_use]
    pub fn powershell(&self) -> Option<String> {
        match *self {
            Self::Realtime { enabled } => Some(format!(
                "Set-MpPreference -DisableRealtimeMonitoring ${}",
                if enabled { "false" } else { "true" }
            )),
            Self::ThreatAction {
                level,
                action: None | Some(0),
            } => Some(format!(
                "Remove-MpPreference -{}ThreatDefaultAction",
                level.name()
            )),
            Self::ThreatAction {
                level,
                action: Some(a),
            } => action_name(a).map(|name| {
                format!(
                    "Set-MpPreference -{}ThreatDefaultAction {name}",
                    level.name()
                )
            }),
        }
    }

    /// Beschreibung für Plan und Protokoll (mit dem genauen Befehl).
    #[must_use]
    pub fn describe(&self) -> String {
        let what = match *self {
            Self::Realtime { enabled } => format!(
                "Microsoft Defender: Echtzeitschutz {}",
                if enabled {
                    "einschalten"
                } else {
                    "ausschalten"
                }
            ),
            Self::ThreatAction {
                level,
                action: None | Some(0),
            } => format!(
                "Microsoft Defender: Standardaktion für Stufe „{}“ auf Windows-Standard zurücksetzen",
                level.german()
            ),
            Self::ThreatAction {
                level,
                action: Some(a),
            } => format!(
                "Microsoft Defender: Standardaktion für Stufe „{}“ auf „{}“ setzen",
                level.german(),
                action_name(a).unwrap_or("?")
            ),
        };
        format!("{what} ({})", self.powershell().unwrap_or_default())
    }
}

/// Befehle für eine Änderung.
#[must_use]
pub fn commands(change: Change) -> Vec<Command> {
    match change {
        Change::RealtimeOff => vec![Command::Realtime { enabled: false }],
        Change::RealtimeOn => vec![Command::Realtime { enabled: true }],
        Change::ReportOnlyOn => Level::ALL
            .iter()
            .map(|l| Command::ThreatAction {
                level: *l,
                action: Some(NO_ACTION),
            })
            .collect(),
        Change::ReportOnlyOff => Level::ALL
            .iter()
            .map(|l| Command::ThreatAction {
                level: *l,
                action: None,
            })
            .collect(),
    }
}

/// Stimmt der gelesene Zustand nach einem Befehl? (`None` = nicht prüfbar.)
#[must_use]
pub fn verify(command: &Command, status: &DefenderStatus) -> Option<bool> {
    match *command {
        Command::Realtime { enabled } => status.realtime.map(|r| r == enabled),
        Command::ThreatAction { level, action } => status
            .preferences
            .then(|| status.actions.get(level) == action.filter(|a| *a != 0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> DefenderStatus {
        DefenderStatus {
            available: true,
            service: Some(true),
            antivirus: Some(true),
            realtime: Some(true),
            cloud: Some(true),
            tamper: Some(false),
            running_mode: Some("Normal".into()),
            signature_age_days: Some(0),
            policy_realtime_off: false,
            actions: ThreatActions::default(),
            preferences: true,
        }
    }

    #[test]
    fn manipulationsschutz_wird_nie_umgangen() {
        let mut s = on();
        s.tamper = Some(true);
        assert_eq!(check(Change::RealtimeOff, &s), Err(Blocked::Tamper));
        assert_eq!(check(Change::ReportOnlyOn, &s), Err(Blocked::Tamper));
        // Wieder einschalten ist immer erlaubt (falls aus).
        s.realtime = Some(false);
        assert_eq!(check(Change::RealtimeOn, &s), Ok(()));
    }

    #[test]
    fn pruefungen() {
        let s = on();
        assert_eq!(check(Change::RealtimeOff, &s), Ok(()));
        assert_eq!(check(Change::RealtimeOn, &s), Err(Blocked::AlreadyThere));
        assert_eq!(check(Change::ReportOnlyOff, &s), Err(Blocked::AlreadyThere));
        assert_eq!(check(Change::ReportOnlyOn, &s), Ok(()));
        assert_eq!(
            check(Change::RealtimeOff, &DefenderStatus::default()),
            Err(Blocked::Unavailable)
        );
        let mut passive = on();
        passive.running_mode = Some("Passive Mode".into());
        assert_eq!(check(Change::RealtimeOff, &passive), Err(Blocked::Passive));
        // Unbekannter Manipulationsschutz oder ungelesene Einstellungen: nichts schwächen.
        let mut unknown = on();
        unknown.tamper = None;
        assert_eq!(
            check(Change::RealtimeOff, &unknown),
            Err(Blocked::Unavailable)
        );
        let mut unread = on();
        unread.preferences = false;
        assert_eq!(
            check(Change::ReportOnlyOff, &unread),
            Err(Blocked::Unavailable)
        );
        assert_eq!(
            verify(
                &Command::ThreatAction {
                    level: Level::Low,
                    action: None
                },
                &unread
            ),
            None
        );
        let mut policy = on();
        policy.realtime = Some(false);
        policy.policy_realtime_off = true;
        assert_eq!(check(Change::RealtimeOn, &policy), Err(Blocked::Policy));
    }

    #[test]
    fn befehle_fest_und_pruefbar() {
        assert_eq!(
            commands(Change::RealtimeOff)[0].powershell().unwrap(),
            "Set-MpPreference -DisableRealtimeMonitoring $true"
        );
        assert_eq!(
            commands(Change::RealtimeOn)[0].powershell().unwrap(),
            "Set-MpPreference -DisableRealtimeMonitoring $false"
        );
        let report = commands(Change::ReportOnlyOn);
        assert_eq!(report.len(), 4);
        assert_eq!(
            report[3].powershell().unwrap(),
            "Set-MpPreference -SevereThreatDefaultAction NoAction"
        );
        assert_eq!(
            commands(Change::ReportOnlyOff)[0].powershell().unwrap(),
            "Remove-MpPreference -LowThreatDefaultAction"
        );
        let unknown = Command::ThreatAction {
            level: Level::Low,
            action: Some(77),
        };
        assert!(unknown.powershell().is_none());
        for c in [
            Change::RealtimeOff,
            Change::ReportOnlyOn,
            Change::ReportOnlyOff,
        ] {
            assert_eq!(Change::parse(c.as_str()), Some(c));
        }
        assert!(Change::parse("disable_firewall").is_none());
    }

    #[test]
    fn nachpruefen_und_serde() {
        let mut s = on();
        assert_eq!(verify(&Command::Realtime { enabled: true }, &s), Some(true));
        s.realtime = None;
        assert_eq!(verify(&Command::Realtime { enabled: true }, &s), None);
        s.actions.low = Some(NO_ACTION);
        let set = Command::ThreatAction {
            level: Level::Low,
            action: Some(NO_ACTION),
        };
        assert_eq!(verify(&set, &s), Some(true));
        let json = serde_json::to_string(&set).unwrap();
        assert_eq!(
            serde_json::from_str::<Command>(&json).unwrap(),
            set,
            "{json}"
        );
        assert!(
            serde_json::from_str::<Command>(r#"{"type":"realtime","enabled":true,"x":1}"#).is_err()
        );
        let mut all = ThreatActions::default();
        assert!(!all.report_only());
        all = ThreatActions {
            low: Some(9),
            moderate: Some(9),
            high: Some(9),
            severe: Some(9),
        };
        assert!(all.report_only());
    }
}
