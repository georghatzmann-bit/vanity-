//! Härtung beheben (P6.2): Jeder Vorschlag ist ein Plan mit genau den Schritten, die danach
//! ausgeführt werden (Registrierungswert, Firewall-Profil, Gastkonto) – erst nach „Ja“. Vor dem
//! Ändern merkt sich der Dienst den alten Stand; „Rückgängig“ ist ein eigener Plan.
//!
//! - Rechnerweite Änderungen nur für Administratoren; der Proxy nur für das eigene Konto.
//! - Gruppenrichtlinien werden nie geändert – steht dort etwas, sagt AEGIS das ehrlich.
//! - Beim Ausführen werden die Schritte neu bestimmt und müssen genau denen im Plan entsprechen,
//!   sonst passiert nichts („Zustand hat sich geändert – bitte neu prüfen“). Zusätzlich bindet
//!   eine Prüfsumme der Schritte im Plan-Wert das „Ja“ genau an diese Schritte.
//! - Werte im Profil des Kontos (`HKU\<SID>`) liest und schreibt der Dienst nur mit dessen
//!   Rechten (Identitätswechsel).
//! - Gemerkte Stände: höchstens 10 je Konto, nur kleine `DWORD`-/Text-/Binärwerte.

use std::collections::HashMap;
use std::sync::Arc;

use aegis_core::audit::{Durable, ExecutionResult};
use aegis_core::consent::{Clock, ExecutionPermit};
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_hardening::FixKind;
use aegis_hardening::collect::FixState;
use aegis_quarantine::UserAccess;
use serde::{Deserialize, Serialize};

use super::Service;
use crate::protocol::Response;

/// Einstellung „Härtung beheben“ (Wert: Art des Schritts).
pub const FIX_SETTING: &str = "hardening.fix";
/// Einstellung „Härtung rückgängig“ (Wert: Kennung des gemerkten Stands).
pub const UNDO_SETTING: &str = "hardening.undo";
/// Gemerkte Stände je Konto (die ältesten dieses Kontos fallen heraus).
const MAX_RECORDS_PER_OWNER: usize = 10;
/// Größter merkbarer Text-/`DWORD`-Wert bzw. Binärwert (Byte).
const MAX_REMEMBERED_TEXT: usize = 2048;
const MAX_REMEMBERED_BINARY: usize = 4096;

/// Wo ein Registrierungswert liegt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    /// `HKLM`.
    Machine,
    /// `HKU\<SID>` des anfragenden Kontos.
    User(String),
}

/// Roher Registrierungswert (Typ + Bytes, gespeichert als Base64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raw {
    /// Typ (1 = `REG_SZ`, 2 = `REG_EXPAND_SZ`, 3 = `REG_BINARY`, 4 = `REG_DWORD`).
    pub kind: u32,
    /// Daten.
    #[serde(with = "b64")]
    pub bytes: Vec<u8>,
}

mod b64 {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

impl Raw {
    /// Darf dieser alte Wert gemerkt werden? (Nur kleine `DWORD`-, Text- und Binärwerte –
    /// alles andere wäre ungewöhnlich und würde den Einstellungsspeicher aufblähen.)
    #[must_use]
    pub fn rememberable(&self) -> bool {
        match self.kind {
            1 | 2 | 4 => self.bytes.len() <= MAX_REMEMBERED_TEXT,
            3 => self.bytes.len() <= MAX_REMEMBERED_BINARY,
            _ => false,
        }
    }

    pub(super) fn dword(value: u32) -> Self {
        Self {
            kind: 4,
            bytes: value.to_le_bytes().to_vec(),
        }
    }

    fn text(&self) -> String {
        match (self.kind, self.bytes.as_slice()) {
            (4, [a, b, c, d]) => format!("{} (DWORD)", u32::from_le_bytes([*a, *b, *c, *d])),
            (1 | 2, bytes) => {
                let units: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&units);
                format!(
                    "„{}“",
                    text.trim_end_matches('\0')
                        .chars()
                        .take(120)
                        .collect::<String>()
                )
            }
            (3, bytes) => format!("{} Byte (Binär)", bytes.len()),
            (kind, bytes) => format!("Typ {kind}, {} Byte", bytes.len()),
        }
    }
}

/// Ein Schritt eines Plans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// Registrierungswert setzen (`None` = Wert entfernen; nur beim Rückgängigmachen).
    Registry {
        /// Ort.
        place: Place,
        /// Schlüssel.
        key: String,
        /// Wertname.
        name: String,
        /// Neuer Wert.
        value: Option<Raw>,
    },
    /// Windows-Firewall-Profil ein- bzw. ausschalten (`netsh`-Name des Profils).
    Firewall {
        /// `domainprofile`, `privateprofile` oder `publicprofile`.
        profile: String,
        /// Einschalten?
        on: bool,
    },
    /// Geplante Aufgabe ein- bzw. ausschalten (`schtasks /Change`).
    Task {
        /// Pfad der Aufgabe (`\Ordner\Name`).
        path: String,
        /// Aktiv?
        enabled: bool,
    },
    /// Gastkonto aktivieren bzw. deaktivieren.
    Guest {
        /// Name des Kontos (sprachabhängig, z. B. „Gast“).
        name: String,
        /// Aktiv?
        active: bool,
    },
    /// AEGIS-Firewall-Regel „ausgehend blockieren“ für ein Programm anlegen bzw. entfernen.
    BlockProgram {
        /// Regelname (`AEGIS-Block-…`).
        name: String,
        /// Programmpfad.
        program: String,
        /// Anlegen (sonst entfernen)?
        present: bool,
    },
    /// Microsoft Defender über `Set-/Remove-MpPreference` (fester Befehl, P8).
    Defender {
        /// Befehl.
        command: aegis_defender_switch::Command,
    },
    /// Wiederherstellungspunkt anlegen (`Checkpoint-Computer`, P11; bereinigte Beschreibung).
    RestorePoint {
        /// Beschreibung (nur Buchstaben, Ziffern, Leerzeichen, `.,-_()`).
        description: String,
    },
}

const FIREWALL_PROFILES: [&str; 3] = ["domainprofile", "privateprofile", "publicprofile"];

impl Step {
    /// Was der Schritt tut – steht so im Plan.
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Registry {
                place,
                key,
                name,
                value,
            } => {
                let root = match place {
                    Place::Machine => "HKLM".to_owned(),
                    Place::User(sid) => format!("HKU\\{sid}"),
                };
                match value {
                    Some(v) => format!("{root}\\{key}\\{name} = {}", v.text()),
                    None => format!("{root}\\{key}\\{name} entfernen"),
                }
            }
            Self::Firewall { profile, on } => {
                let name = match profile.as_str() {
                    "domainprofile" => "Domäne",
                    "privateprofile" => "Privat",
                    _ => "Öffentlich",
                };
                format!(
                    "Windows-Firewall, Profil „{name}“: {}",
                    if *on { "einschalten" } else { "ausschalten" }
                )
            }
            Self::Guest { name, active } => format!(
                "Gastkonto „{name}“: {}",
                if *active {
                    "aktivieren"
                } else {
                    "deaktivieren"
                }
            ),
            Self::Task { path, enabled } => format!(
                "Geplante Aufgabe „{path}“: {}",
                if *enabled {
                    "aktivieren"
                } else {
                    "deaktivieren"
                }
            ),
            Self::BlockProgram {
                name,
                program,
                present: true,
            } => format!(
                "Windows-Firewall: Regel „{name}“ anlegen – ausgehende Verbindungen von {program} blockieren"
            ),
            Self::BlockProgram {
                name,
                program,
                present: false,
            } => format!("Windows-Firewall: Regel „{name}“ ({program}) entfernen"),
            Self::Defender { command } => command.describe(),
            Self::RestorePoint { description } => {
                format!("Wiederherstellungspunkt „{description}“ anlegen")
            }
        }
    }

    /// Betrifft der Schritt den ganzen PC (nur Administratoren)?
    #[must_use]
    pub fn machine_wide(&self) -> bool {
        !matches!(
            self,
            Self::Registry {
                place: Place::User(_),
                ..
            }
        )
    }
}

/// Ein gemerkter Stand vor dem Beheben (für „Rückgängig“).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixRecord {
    /// Kennung.
    pub id: String,
    /// Art des Schritts (`disable_smb1` …).
    pub fix: String,
    /// Konto, das behoben hat.
    pub owner: Option<String>,
    /// Zeitpunkt (RFC 3339).
    pub at: String,
    /// Schritte, die den alten Stand wiederherstellen.
    pub undo: Vec<Step>,
}

/// Für die Oberfläche: rückgängig machbare Schritte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UndoInfo {
    /// Kennung.
    pub id: String,
    /// Art.
    pub fix: String,
    /// Zeitpunkt.
    pub at: String,
}

/// Name der Art (wie im Protokoll der Oberfläche).
#[must_use]
pub fn fix_name(fix: FixKind) -> &'static str {
    match fix {
        FixKind::EnableUac => "enable_uac",
        FixKind::DisableSmb1 => "disable_smb1",
        FixKind::DisableRdp => "disable_rdp",
        FixKind::EnableRdpNla => "enable_rdp_nla",
        FixKind::DisableGuest => "disable_guest",
        FixKind::EnableFirewall => "enable_firewall",
        FixKind::DisableProxy => "disable_proxy",
        FixKind::EnableDriverBlocklist => "enable_driver_blocklist",
        FixKind::OpenSettings => "open_settings",
    }
}

/// Art aus dem Namen.
#[must_use]
pub fn parse_fix(name: &str) -> Option<FixKind> {
    [
        FixKind::EnableUac,
        FixKind::DisableSmb1,
        FixKind::DisableRdp,
        FixKind::EnableRdpNla,
        FixKind::DisableGuest,
        FixKind::EnableFirewall,
        FixKind::DisableProxy,
        FixKind::EnableDriverBlocklist,
        FixKind::OpenSettings,
    ]
    .into_iter()
    .find(|f| fix_name(*f) == name)
}

fn machine(key: &str, name: &str, value: u32) -> Step {
    Step::Registry {
        place: Place::Machine,
        key: key.to_owned(),
        name: name.to_owned(),
        value: Some(Raw::dword(value)),
    }
}

/// Gültiger Kontoname für `net user` (kein Schalter, keine Steuerzeichen).
fn plausible_account(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && !name.starts_with('/')
        && !name
            .chars()
            .any(|c| c.is_control() || "\"/\\[]:;|=,+*?<>".contains(c))
}

/// Die Schritte eines Behebens (rein, ohne Systemzugriff – testbar). Was schon in Ordnung ist,
/// wird abgelehnt (so kann ein Beheben nie einen strengeren Stand lockern).
///
/// # Errors
/// Nicht behebbar (bereits in Ordnung, Gruppenrichtlinie, kein Konto …).
pub fn fix_steps(fix: FixKind, sid: Option<&str>, state: &FixState) -> Result<Vec<Step>, String> {
    use aegis_hardening::facts::UacLevel;
    let uac = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    match fix {
        FixKind::EnableUac => match state.uac {
            Some(UacLevel::Default | UacLevel::AlwaysNotify) => {
                Err("Die Benutzerkontensteuerung ist bereits mindestens auf „Standard“.".into())
            }
            None => Err("Stand der Benutzerkontensteuerung nicht lesbar.".into()),
            Some(_) => Ok(vec![
                machine(uac, "EnableLUA", 1),
                machine(uac, "ConsentPromptBehaviorAdmin", 5),
                machine(uac, "PromptOnSecureDesktop", 1),
            ]),
        },
        FixKind::DisableSmb1 => match state.smb1 {
            Some(true) => Ok(vec![machine(
                r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters",
                "SMB1",
                0,
            )]),
            Some(false) => Err("SMBv1 ist bereits aus.".into()),
            None => Err("Stand von SMBv1 nicht lesbar.".into()),
        },
        FixKind::DisableRdp if state.rdp_policy => Err(
            "Remotedesktop ist per Gruppenrichtlinie festgelegt – AEGIS ändert keine Richtlinien (bitte die IT bzw. „gpedit.msc“).".into(),
        ),
        FixKind::DisableRdp => match state.rdp {
            Some(r) if r.enabled => Ok(vec![machine(
                r"SYSTEM\CurrentControlSet\Control\Terminal Server",
                "fDenyTSConnections",
                1,
            )]),
            Some(_) => Err("Remotedesktop ist bereits aus.".into()),
            None => Err("Stand von Remotedesktop nicht lesbar.".into()),
        },
        FixKind::EnableRdpNla if state.nla_policy => Err(
            "Die Anmeldung auf Netzwerkebene ist per Gruppenrichtlinie festgelegt – AEGIS ändert keine Richtlinien.".into(),
        ),
        FixKind::EnableRdpNla => match state.rdp {
            Some(r) if !r.nla => Ok(vec![machine(
                r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp",
                "UserAuthentication",
                1,
            )]),
            Some(_) => Err("NLA ist bereits verlangt.".into()),
            None => Err("Stand von Remotedesktop nicht lesbar.".into()),
        },
        FixKind::DisableGuest => match &state.guest {
            Some((name, true)) if plausible_account(name) => Ok(vec![Step::Guest {
                name: name.clone(),
                active: false,
            }]),
            Some((_, true)) => Err(
                "Der Name des Gastkontos ist ungewöhnlich – AEGIS ändert es nicht selbst (bitte in der Computerverwaltung prüfen).".into(),
            ),
            Some((_, false)) => Err("Das Gastkonto ist bereits deaktiviert.".into()),
            None => Err("Gastkonto nicht gefunden.".into()),
        },
        FixKind::EnableFirewall if state.firewall_policy => Err(
            "Eine Gruppenrichtlinie schaltet die Firewall ab – AEGIS ändert keine Richtlinien.".into(),
        ),
        FixKind::EnableFirewall if state.firewall_service_disabled => Err(
            "Der Dienst der Windows-Firewall ist deaktiviert – einschalten geht nur in den Windows-Diensten (bitte prüfen, wer ihn abgeschaltet hat).".into(),
        ),
        FixKind::EnableFirewall => {
            let steps: Vec<Step> = state
                .firewall_off
                .iter()
                .filter(|p| FIREWALL_PROFILES.contains(&p.as_str()))
                .map(|p| Step::Firewall {
                    profile: p.clone(),
                    on: true,
                })
                .collect();
            if steps.is_empty() {
                Err("Die Firewall ist für alle Profile bereits an.".into())
            } else {
                Ok(steps)
            }
        }
        FixKind::DisableProxy => {
            let Some(sid) = sid.filter(|s| s.starts_with("S-1-")) else {
                return Err("Kein Benutzerkonto – kein Proxy zu ändern.".into());
            };
            let key = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings".to_owned();
            let place = Place::User(sid.to_owned());
            let mut steps = Vec::new();
            if state.proxy_enabled {
                steps.push(Step::Registry {
                    place: place.clone(),
                    key: key.clone(),
                    name: "ProxyEnable".into(),
                    value: Some(Raw::dword(0)),
                });
            }
            if state.auto_config {
                // Das Proxy-Skript wird entfernt (der alte Wert bleibt für „Rückgängig“).
                steps.push(Step::Registry {
                    place: place.clone(),
                    key: key.clone(),
                    name: "AutoConfigURL".into(),
                    value: None,
                });
            }
            if let Some(blob) = &state.connections_without_proxy {
                // Programme lesen den Proxy aus diesen Verbindungseinstellungen.
                steps.push(Step::Registry {
                    place,
                    key: format!(r"{key}\Connections"),
                    name: "DefaultConnectionSettings".into(),
                    value: Some(Raw {
                        kind: 3,
                        bytes: blob.clone(),
                    }),
                });
            }
            if steps.is_empty() {
                Err("Für dein Konto ist kein Proxy eingerichtet.".into())
            } else {
                Ok(steps)
            }
        }
        FixKind::EnableDriverBlocklist if state.driver_policy => Err(
            "Die Treiber-Regeln sind per Gruppenrichtlinie (Device Guard) festgelegt – AEGIS ändert keine Richtlinien.".into(),
        ),
        FixKind::EnableDriverBlocklist => match state.driver_blocklist {
            Some(false) => Ok(vec![machine(
                r"SYSTEM\CurrentControlSet\Control\CI\Config",
                "VulnerableDriverBlocklistEnable",
                1,
            )]),
            Some(true) => Err("Die Sperrliste für verwundbare Treiber ist bereits an.".into()),
            None => Err("Stand der Sperrliste nicht lesbar.".into()),
        },
        FixKind::OpenSettings => {
            Err("Dieser Punkt wird in den Windows-Einstellungen geändert – AEGIS öffnet sie nur.".into())
        }
    }
}

/// Prüfsumme der Schritte (bindet das „Ja“ genau an sie).
#[must_use]
pub fn steps_digest(steps: &[Step]) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_vec(steps).unwrap_or_default();
    Sha256::digest(&json)
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Plan-Wert `<Basis>#<Prüfsumme>` zerlegen.
#[must_use]
pub fn split_value(value: &str) -> (&str, &str) {
    value.rsplit_once('#').unwrap_or((value, ""))
}

pub(super) struct Texts {
    pub(super) what: &'static str,
    pub(super) why: &'static str,
    pub(super) consequence: &'static str,
}

fn texts(fix: FixKind) -> Texts {
    match fix {
        FixKind::EnableUac => Texts {
            what: "Benutzerkontensteuerung auf „Standard“ stellen",
            why: "Ohne Benutzerkontensteuerung laufen Programme mit vollen Administratorrechten – Schadsoftware kann so unbemerkt das System verändern.",
            consequence: "Windows fragt wieder nach, bevor Programme Änderungen am System vornehmen (abgedunkelter, sicherer Desktop). War sie ganz aus, wirkt das erst nach einem Neustart.",
        },
        FixKind::DisableSmb1 => Texts {
            what: "SMBv1 abschalten",
            why: "SMBv1 ist ein veraltetes Freigabe-Protokoll mit bekannten Lücken (z. B. von WannaCry genutzt).",
            consequence: "Sehr alte Geräte (z. B. NAS von vor 2010) erreichen deine Freigaben ggf. nicht mehr. Wirkt nach einem Neustart.",
        },
        FixKind::DisableRdp => Texts {
            what: "Remotedesktop abschalten",
            why: "Offener Remotedesktop ist ein häufiges Einfallstor (Passwort-Raten aus dem Netz).",
            consequence: "Niemand kann sich mehr per Remotedesktop an diesem PC anmelden – auch du nicht von unterwegs. Laufende Sitzungen bleiben bis zum Abmelden.",
        },
        FixKind::EnableRdpNla => Texts {
            what: "Anmeldung auf Netzwerkebene (NLA) für Remotedesktop verlangen",
            why: "Ohne NLA zeigt Windows den Anmeldebildschirm jedem im Netz – das erleichtert Angriffe.",
            consequence: "Wer sich per Remotedesktop verbindet, muss sich vorher anmelden. Sehr alte Remotedesktop-Programme funktionieren ggf. nicht mehr.",
        },
        FixKind::DisableGuest => Texts {
            what: "Gastkonto deaktivieren",
            why: "Ein aktives Gastkonto erlaubt Anmeldungen ohne Passwort.",
            consequence: "Niemand kann sich mehr als Gast anmelden. Dateien bleiben unberührt.",
        },
        FixKind::EnableFirewall => Texts {
            what: "Windows-Firewall einschalten",
            why: "Ohne Firewall sind Dienste dieses PCs aus dem Netz erreichbar.",
            consequence: "Die Firewall schützt die genannten Netzwerkprofile wieder mit ihren bestehenden Regeln. Programme, die Verbindungen von außen brauchen, fragen ggf. nach.",
        },
        FixKind::DisableProxy => Texts {
            what: "Proxy deines Kontos abschalten",
            why: "Ein eingetragener Proxy kann deinen Datenverkehr umleiten und mitlesen – Schadsoftware nutzt das.",
            consequence: "Programme verbinden sich wieder direkt. Brauchst du den Proxy (z. B. Firma), stell ihn danach wieder ein oder mach diesen Schritt rückgängig.",
        },
        FixKind::EnableDriverBlocklist => Texts {
            what: "Microsoft-Sperrliste für verwundbare Treiber einschalten",
            why: "Angreifer laden alte, verwundbare Treiber, um sich Kernel-Rechte zu verschaffen und Schutzprogramme abzuschalten. Die Sperrliste von Microsoft verhindert das Laden bekannter Fälle.",
            consequence: "Windows lädt Treiber von der Sperrliste nicht mehr – wirkt nach einem Neustart. Sehr selten braucht ein altes Gerät einen gesperrten Treiber; dann hilft ein Hersteller-Update oder „Rückgängig“.",
        },
        FixKind::OpenSettings => Texts {
            what: "Windows-Einstellungen öffnen",
            why: "",
            consequence: "",
        },
    }
}

fn step_targets(plan: &ActionPlan) -> Vec<String> {
    plan.targets()
        .iter()
        .filter_map(|t| match t {
            Target::Other { description } => Some(description.clone()),
            _ => None,
        })
        .collect()
}

/// Zugriff auf das System: lesen und ändern. Unter Windows echt ([`RealSystem`]), in Tests
/// ein Ersatz – so lässt sich der Ausführungsweg überall prüfen.
pub trait HardenSystem: Send + Sync + std::fmt::Debug {
    /// Stand, den ein Plan für `fix` braucht (nur lesend, ohne WMI).
    ///
    /// # Errors
    /// Nicht lesbar bzw. nicht unter Windows.
    fn fix_state(&self, fix: FixKind, sid: Option<&str>) -> Result<FixState, String>;
    /// Der Schritt, der den jetzigen Stand wiederherstellt.
    ///
    /// # Errors
    /// Alter Stand nicht lesbar.
    fn before(&self, step: &Step, user: &dyn UserAccess) -> Result<Step, String>;
    /// Führt einen Schritt aus – nur mit der Erlaubnis eines Plans.
    ///
    /// # Errors
    /// Schritt fehlgeschlagen.
    fn apply(
        &self,
        permit: &ExecutionPermit,
        step: &Step,
        user: &dyn UserAccess,
    ) -> Result<(), String>;
    /// Aktueller Stand von Microsoft Defender (nur lesend, für die Prüfung vor dem Ausführen).
    fn defender_status(&self) -> aegis_defender_switch::DefenderStatus {
        super::defender::read_status()
    }
}

/// Das echte System (Windows); anderswo ist nichts behebbar.
#[derive(Debug, Default)]
pub struct RealSystem;

impl HardenSystem for RealSystem {
    fn fix_state(&self, fix: FixKind, sid: Option<&str>) -> Result<FixState, String> {
        #[cfg(windows)]
        {
            Ok(aegis_hardening::collect::fix_state(
                fix,
                sid.filter(|s| s.starts_with("S-1-")),
            ))
        }
        #[cfg(not(windows))]
        {
            let _ = (fix, sid);
            Err("Beheben gibt es nur unter Windows.".into())
        }
    }

    fn before(&self, step: &Step, user: &dyn UserAccess) -> Result<Step, String> {
        sys::before(step, user)
    }

    fn apply(
        &self,
        permit: &ExecutionPermit,
        step: &Step,
        user: &dyn UserAccess,
    ) -> Result<(), String> {
        sys::apply(permit, step, user)
    }
}

/// Ergebnis des Ausführens.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// Alles ausgeführt; Schritte zum Rückgängigmachen.
    Done(Vec<Step>),
    /// Fehlgeschlagen, alles zurückgenommen.
    Failed(String),
    /// Fehlgeschlagen und nicht alles zurückgenommen: was noch gilt, steht in `remaining`
    /// (dessen Rückgängig-Schritte).
    Partial {
        /// Meldung.
        message: String,
        /// Schritte, die den noch geltenden Teil zurücknehmen.
        remaining: Vec<Step>,
    },
}

/// Führt die Schritte aus. Schlägt einer fehl, werden die schon ausgeführten zurückgenommen –
/// gelingt das nicht ganz, wird das ehrlich gemeldet. Alte Werte, die zu groß oder ungewöhnlich
/// sind, werden nicht gemerkt: dann wird nichts geändert.
pub fn apply_steps(
    system: &dyn HardenSystem,
    permit: &ExecutionPermit,
    steps: &[Step],
    user: &dyn UserAccess,
) -> Applied {
    let mut undo: Vec<Step> = Vec::new();
    for step in steps {
        let result = system.before(step, user).and_then(|inverse| {
            if let Step::Registry {
                value: Some(old), ..
            } = &inverse
                && !old.rememberable()
            {
                return Err(
                    "der alte Wert ist ungewöhnlich (Typ oder Größe) – ohne „Rückgängig“ wird nichts geändert"
                        .to_owned(),
                );
            }
            system.apply(permit, step, user).map(|()| inverse)
        });
        match result {
            Ok(inverse) => undo.push(inverse),
            Err(e) => {
                let message = format!("{}: {e}", step.describe());
                let mut remaining: Vec<Step> = Vec::new();
                for back in undo.iter().rev() {
                    if system.apply(permit, back, user).is_err() {
                        remaining.push(back.clone());
                    }
                }
                return if remaining.is_empty() {
                    Applied::Failed(message)
                } else {
                    Applied::Partial {
                        message: format!(
                            "{message}. Nicht zurückgenommen (gilt noch): {}",
                            remaining
                                .iter()
                                .map(Step::describe)
                                .collect::<Vec<_>>()
                                .join("; ")
                        ),
                        remaining,
                    }
                };
            }
        }
    }
    undo.reverse();
    Applied::Done(undo)
}

#[cfg(windows)]
mod sys {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use aegis_core::consent::ExecutionPermit;
    use aegis_quarantine::UserAccess;
    use aegis_winffi::inspect::Hive;
    use aegis_winffi::registry::{RawValue, delete_value, read_raw, write_raw};

    use super::{Place, Raw, Step};

    fn hive(place: &Place) -> Hive {
        match place {
            Place::Machine => Hive::LocalMachine,
            Place::User(sid) => Hive::User(sid.clone()),
        }
    }

    /// Werte im Profil des Kontos nur mit dessen Rechten (Identitätswechsel).
    fn as_owner<T>(
        place: &Place,
        user: &dyn UserAccess,
        f: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        match place {
            Place::Machine => f(),
            Place::User(_) => {
                let _scope = user
                    .enter()
                    .map_err(|e| format!("Rechte des Kontos nicht übernehmbar: {e}"))?;
                f()
            }
        }
    }

    /// Der Schritt, der den jetzigen Stand wiederherstellt.
    pub(super) fn before(step: &Step, user: &dyn UserAccess) -> Result<Step, String> {
        Ok(match step {
            Step::Registry {
                place, key, name, ..
            } => Step::Registry {
                place: place.clone(),
                key: key.clone(),
                name: name.clone(),
                value: as_owner(place, user, || {
                    read_raw(&hive(place), key, name)
                        .map_err(|e| format!("alter Wert nicht lesbar: {e}"))
                })?
                .map(|v| Raw {
                    kind: v.kind,
                    bytes: v.bytes,
                }),
            },
            Step::Firewall { profile, on } => Step::Firewall {
                profile: profile.clone(),
                on: !on,
            },
            Step::Guest { name, active } => Step::Guest {
                name: name.clone(),
                active: !active,
            },
            Step::Task { path, enabled } => Step::Task {
                path: path.clone(),
                enabled: !enabled,
            },
            Step::BlockProgram {
                name,
                program,
                present,
            } => Step::BlockProgram {
                name: name.clone(),
                program: program.clone(),
                present: !present,
            },
            Step::Defender { command } => Step::Defender {
                command: defender_before(command)?,
            },
            // Legt nur etwas an, das Windows selbst verwaltet – kein Gegenstück (AEGIS löscht
            // keine Wiederherstellungspunkte).
            Step::RestorePoint { description } => Step::RestorePoint {
                description: description.clone(),
            },
        })
    }

    /// Befehl, der den jetzigen (echt gelesenen) Stand von Defender wiederherstellt.
    fn defender_before(
        command: &aegis_defender_switch::Command,
    ) -> Result<aegis_defender_switch::Command, String> {
        use aegis_defender_switch::{Command, action_name};
        let status = aegis_hardening::collect::defender_status();
        Ok(match *command {
            Command::Realtime { .. } => Command::Realtime {
                enabled: status
                    .realtime
                    .ok_or_else(|| "Echtzeitschutz-Stand nicht lesbar".to_owned())?,
            },
            Command::ThreatAction { level, .. } => {
                if !status.preferences {
                    return Err("Defender-Einstellungen nicht lesbar".into());
                }
                let action = status.actions.get(level);
                if action.is_some_and(|a| action_name(a).is_none()) {
                    return Err("Unbekannte Standardaktion – nichts geändert".into());
                }
                Command::ThreatAction { level, action }
            }
        })
    }

    /// Führt einen Defender-Befehl aus und liest danach den echten Stand nach.
    fn defender_apply(command: &aegis_defender_switch::Command) -> Result<(), String> {
        let script = command
            .powershell()
            .ok_or_else(|| "Unbekannte Defender-Aktion".to_owned())?;
        run(
            r"WindowsPowerShell\v1.0\powershell.exe",
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ],
        )?;
        let status = aegis_hardening::collect::defender_status();
        match aegis_defender_switch::verify(command, &status) {
            Some(true) => Ok(()),
            Some(false) => Err(
                "Windows hat die Änderung nicht übernommen (Manipulationsschutz, Richtlinie oder anderes Antivirenprogramm) – der gewünschte Stand ist nicht erreicht.".into(),
            ),
            None => Err(
                "Windows meldet den Stand danach nicht – nicht nachprüfbar. Bitte den Status neu lesen.".into(),
            ),
        }
    }

    /// Legt einen Wiederherstellungspunkt an und prüft danach, ob Windows ihn wirklich angelegt
    /// hat (höchstens einer je 24 Stunden, nur mit eingeschaltetem Computerschutz).
    fn restore_point_apply(description: &str) -> Result<(), String> {
        // Nur die bereinigte Beschreibung (ohne Anführungszeichen) gelangt in den Befehl.
        if aegis_hardening::restore::clean_description(description).as_deref() != Some(description)
        {
            return Err("Ungültige Beschreibung".into());
        }
        let newest = |points: &[aegis_hardening::restore::RestorePoint]| {
            points.iter().map(|p| p.sequence).max().unwrap_or(0)
        };
        let before = aegis_hardening::collect::restore_points()
            .map(|p| newest(&p))
            .unwrap_or(0);
        let script = format!(
            "Checkpoint-Computer -Description '{description}' -RestorePointType MODIFY_SETTINGS -ErrorAction Stop"
        );
        run_for(
            r"WindowsPowerShell\v1.0\powershell.exe",
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ],
            Duration::from_secs(300),
        )?;
        let created = aegis_hardening::collect::restore_points().is_ok_and(|points| {
            points
                .iter()
                .any(|p| p.sequence > before && p.description == description)
        });
        if created {
            Ok(())
        } else {
            Err("Windows hat keinen neuen Punkt angelegt – meist, weil es heute schon einen gibt (höchstens einer je 24 Stunden) oder der Computerschutz für Laufwerk C: aus ist.".into())
        }
    }

    fn tool(name: &str) -> Result<PathBuf, String> {
        aegis_winffi::accounts::system_dir()
            .map(|dir| dir.join(name))
            .map_err(|e| format!("Systemordner unbekannt: {e}"))
    }

    /// Startet ein Windows-Werkzeug vom festen Systemort (höchstens 30 s).
    fn run(exe: &str, args: &[&str]) -> Result<(), String> {
        run_for(exe, args, Duration::from_secs(30))
    }

    /// Wie [`run`], mit eigener Frist (Wiederherstellungspunkte brauchen länger).
    fn run_for(exe: &str, args: &[&str], limit: Duration) -> Result<(), String> {
        let path = tool(exe)?;
        // Führt einen Schritt eines freigegebenen Härtungs-Plans aus (netsh, net, schtasks bzw.
        // PowerShell für Set-/Remove-MpPreference
        // am festen Systemort, Argumente aus dem Plan).
        // aegis-mutation: service-harden-tool
        #[allow(clippy::disallowed_methods)]
        let child = std::process::Command::new(&path)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = child.map_err(|e| format!("{exe} startet nicht: {e}"))?;
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("{exe} meldet Code {}", status.code().unwrap_or(-1)))
                };
            }
            if Instant::now() >= deadline {
                // Beendet nur das selbst gestartete Werkzeug nach Ablauf der Frist.
                // aegis-mutation: service-harden-tool-timeout
                #[allow(clippy::disallowed_methods)]
                let _ = child.kill();
                return Err(format!("{exe} hat zu lange gebraucht"));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    pub(super) fn apply(
        permit: &ExecutionPermit,
        step: &Step,
        user: &dyn UserAccess,
    ) -> Result<(), String> {
        let _ = permit.plan();
        match step {
            Step::Registry {
                place,
                key,
                name,
                value: Some(v),
            } => as_owner(place, user, || {
                write_raw(
                    &hive(place),
                    key,
                    name,
                    &RawValue {
                        kind: v.kind,
                        bytes: v.bytes.clone(),
                    },
                )
                .map_err(|e| e.to_string())
            }),
            Step::Registry {
                place,
                key,
                name,
                value: None,
            } => as_owner(place, user, || {
                delete_value(&hive(place), key, name).map_err(|e| e.to_string())
            }),
            Step::Firewall { profile, on } => run(
                "netsh.exe",
                &[
                    "advfirewall",
                    "set",
                    profile,
                    "state",
                    if *on { "on" } else { "off" },
                ],
            ),
            Step::Guest { name, active } => run(
                "net.exe",
                &[
                    "user",
                    name,
                    if *active { "/active:yes" } else { "/active:no" },
                ],
            ),
            Step::Task { path, enabled } => run(
                "schtasks.exe",
                &[
                    "/Change",
                    "/TN",
                    path,
                    if *enabled { "/ENABLE" } else { "/DISABLE" },
                ],
            ),
            Step::BlockProgram {
                name,
                program,
                present: true,
            } => run(
                "netsh.exe",
                &[
                    "advfirewall",
                    "firewall",
                    "add",
                    "rule",
                    &format!("name={name}"),
                    "dir=out",
                    "action=block",
                    &format!("program={program}"),
                    "enable=yes",
                ],
            ),
            Step::BlockProgram {
                name,
                present: false,
                ..
            } => run(
                "netsh.exe",
                &[
                    "advfirewall",
                    "firewall",
                    "delete",
                    "rule",
                    &format!("name={name}"),
                ],
            ),
            Step::Defender { command } => defender_apply(command),
            Step::RestorePoint { description } => restore_point_apply(description),
        }
    }
}

#[cfg(not(windows))]
mod sys {
    use aegis_core::consent::ExecutionPermit;
    use aegis_quarantine::UserAccess;

    use super::Step;

    pub(super) fn before(_step: &Step, _user: &dyn UserAccess) -> Result<Step, String> {
        Err("nur unter Windows".into())
    }

    pub(super) fn apply(
        permit: &ExecutionPermit,
        _step: &Step,
        _user: &dyn UserAccess,
    ) -> Result<(), String> {
        let _ = permit.plan();
        Err("nur unter Windows".into())
    }
}

/// Schwächt das Zurücknehmen den Schutz? (Firewall aus, Gast an, Wert eines Behebens zurück …)
fn weakens(record: &FixRecord) -> bool {
    !record.fix.starts_with("autorun:")
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Rückgängig machbare Schritte des Kontos (neueste zuerst).
    pub(super) fn fix_undo_list(&self, user: &dyn UserAccess) -> Vec<UndoInfo> {
        let owner = user.identity();
        self.settings
            .get()
            .hardening_undo
            .iter()
            .rev()
            .filter(|r| r.owner == owner)
            .map(|r| UndoInfo {
                id: r.id.clone(),
                fix: r.fix.clone(),
                at: r.at.clone(),
            })
            .collect()
    }

    /// Ersatz für den Systemzugriff (Tests).
    #[must_use]
    pub fn with_harden_system(mut self, system: Arc<dyn HardenSystem>) -> Self {
        self.harden_system = system;
        self
    }

    /// Ersatz für den Systemzugriff setzen (Tests).
    pub fn set_harden_system(&mut self, system: Arc<dyn HardenSystem>) {
        self.harden_system = system;
    }

    /// Der Systemzugriff (zum Lesen außerhalb der Dienst-Sperre).
    #[must_use]
    pub fn harden_system(&self) -> Arc<dyn HardenSystem> {
        Arc::clone(&self.harden_system)
    }

    /// Plan aus Schritten (auch für die Firewall-Regeln der Seite „Netzwerk“).
    pub(super) fn fix_plan_public(
        &self,
        setting: &str,
        value: &str,
        steps: &[Step],
        texts: &Texts,
        undo: UndoHint,
        severity: RiskLevel,
    ) -> Result<ActionPlan, String> {
        self.fix_plan(setting, value, steps, texts, undo, severity)
    }

    fn fix_plan(
        &self,
        setting: &str,
        value: &str,
        steps: &[Step],
        texts: &Texts,
        undo: UndoHint,
        severity: RiskLevel,
    ) -> Result<ActionPlan, String> {
        let mut builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(setting))
            .parameter(param::VALUE, format!("{value}#{}", steps_digest(steps)));
        for step in steps {
            builder = builder.target(Target::other(step.describe()));
        }
        builder
            .what(texts.what)
            .why(texts.why)
            .consequence(format!(
                "{} Geändert wird genau: {}.",
                texts.consequence,
                steps
                    .iter()
                    .map(Step::describe)
                    .collect::<Vec<_>>()
                    .join("; ")
            ))
            .undo(undo)
            .severity(severity)
            .build(self.now())
            .map_err(|e| e.to_string())
    }

    /// Vorprüfung eines Behebens (unter der Sperre, ohne Systemzugriff): Art, Administrator,
    /// Grenzen. Danach liest der Aufrufer den Stand **außerhalb** der Sperre.
    ///
    /// # Errors
    /// Antwort für den Nutzer (unbekannt, nur Administratoren, zu viele Vorschläge).
    pub fn fix_precheck(&mut self, fix: &str, user: &dyn UserAccess) -> Result<FixKind, Response> {
        let Some(kind) = parse_fix(fix) else {
            return Err(Response::error("input", "Unbekannter Schritt"));
        };
        if kind == FixKind::OpenSettings {
            return Err(Response::error(
                "hardening",
                "Dieser Punkt wird in den Windows-Einstellungen geändert – AEGIS öffnet sie nur.",
            ));
        }
        if kind != FixKind::DisableProxy && !user.is_admin() {
            return Err(Response::error(
                "admin",
                "Diese Einstellung gilt für den ganzen PC – AEGIS braucht dafür Administratorrechte (App als Administrator starten).",
            ));
        }
        if let Some(busy) = self.proposal_limit(&user.identity()) {
            return Err(busy);
        }
        Ok(kind)
    }

    /// Schlägt vor, einen Punkt der Härtung zu beheben (direkter Aufruf; die Pipe liest den
    /// Stand außerhalb der Sperre und ruft [`Self::propose_fix_with`]).
    pub fn propose_fix(&mut self, fix: &str, user: &dyn UserAccess) -> Response {
        let kind = match self.fix_precheck(fix, user) {
            Ok(k) => k,
            Err(r) => return r,
        };
        let state = self
            .harden_system
            .fix_state(kind, user.identity().as_deref());
        self.propose_fix_with(kind, state, user)
    }

    /// Plan aus einem außerhalb der Sperre gelesenen Stand.
    pub fn propose_fix_with(
        &mut self,
        fix: FixKind,
        state: Result<FixState, String>,
        user: &dyn UserAccess,
    ) -> Response {
        let state = match state {
            Ok(s) => s,
            Err(e) => return Response::error("hardening", e),
        };
        let owner = user.identity();
        let steps = match fix_steps(fix, owner.as_deref(), &state) {
            Ok(s) => s,
            Err(e) => return Response::error("hardening", e),
        };
        if steps.iter().any(Step::machine_wide) && !user.is_admin() {
            return Response::error(
                "admin",
                "Diese Einstellung gilt für den ganzen PC – AEGIS braucht dafür Administratorrechte (App als Administrator starten).",
            );
        }
        let plan = self.fix_plan(
            FIX_SETTING,
            fix_name(fix),
            &steps,
            &texts(fix),
            UndoHint::reversible(
                "AEGIS merkt sich den alten Stand – „Rückgängig“ auf der Seite „Härtung“ stellt ihn wieder her.",
            ),
            RiskLevel::Info,
        );
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e),
        }
    }

    /// Schlägt vor, ein Beheben rückgängig zu machen.
    pub fn propose_fix_undo(&mut self, id: &str, user: &dyn UserAccess) -> Response {
        let owner = user.identity();
        let Some(record) = self
            .settings
            .get()
            .hardening_undo
            .iter()
            .find(|r| r.id == id && r.owner == owner)
            .cloned()
        else {
            return Response::error("unknown", "Nichts zum Rückgängigmachen gefunden");
        };
        if record.undo.iter().any(Step::machine_wide) && !user.is_admin() {
            return Response::error(
                "admin",
                "Nur mit Administratorrechten zurücknehmbar (App als Administrator starten).",
            );
        }
        let weakens = weakens(&record);
        let fix = parse_fix(&record.fix).map_or("Härtung", |f| texts(f).what);
        let texts = if weakens {
            Texts {
                what: "Härtung rückgängig machen",
                why: "Von dir gewählt.",
                consequence: "Achtung: Damit wird der Schutz wieder schwächer – der Stand vor dem Beheben wird wiederhergestellt.",
            }
        } else {
            Texts {
                what: "Autostart-Eintrag wiederherstellen",
                why: "Von dir gewählt.",
                consequence: "Der Eintrag startet danach wieder automatisch.",
            }
        };
        let plan = self.fix_plan(
            UNDO_SETTING,
            &record.id,
            &record.undo,
            &texts,
            UndoHint::reversible(format!(
                "„{fix}“ kannst du jederzeit erneut vorschlagen lassen."
            )),
            if weakens {
                RiskLevel::Suspicious
            } else {
                RiskLevel::Info
            },
        );
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e),
        }
    }

    fn remember(&mut self, record: FixRecord) -> Result<(), String> {
        self.settings
            .update(|s| {
                let owner = record.owner.clone();
                s.hardening_undo.push(record);
                let own = s.hardening_undo.iter().filter(|r| r.owner == owner).count();
                // Nur die ältesten eigenen Stände fallen heraus – nie die anderer Konten.
                let mut excess = own.saturating_sub(MAX_RECORDS_PER_OWNER);
                s.hardening_undo.retain(|r| {
                    if excess > 0 && r.owner == owner {
                        excess -= 1;
                        false
                    } else {
                        true
                    }
                });
            })
            .map_err(|e| e.to_string())
    }

    /// Führt ein freigegebenes Beheben bzw. Rückgängigmachen aus.
    pub(super) fn apply_fix(&mut self, permit: ExecutionPermit, user: &dyn UserAccess) -> Response {
        let plan = permit.plan().clone();
        let full = plan.parameter(param::VALUE).unwrap_or_default().to_owned();
        let (value, digest) = split_value(&full);
        let undo = plan
            .targets()
            .iter()
            .any(|t| matches!(t, Target::Setting { id } if id == UNDO_SETTING));
        let autorun = plan.targets().iter().any(
            |t| matches!(t, Target::Setting { id } if id == super::persistence::AUTORUN_SETTING),
        );
        let block = plan
            .targets()
            .iter()
            .any(|t| matches!(t, Target::Setting { id } if id == super::network::BLOCK_SETTING));
        let defender = plan.targets().iter().any(
            |t| matches!(t, Target::Setting { id } if id == super::defender::DEFENDER_SETTING),
        );
        let restore = plan
            .targets()
            .iter()
            .any(|t| matches!(t, Target::Setting { id } if id == super::restore::RESTORE_SETTING));
        let owner = user.identity();
        let system = Arc::clone(&self.harden_system);
        // Schritte neu bestimmen – sie müssen genau denen im Plan entsprechen.
        let steps: Result<(Vec<Step>, Option<String>), String> = if restore {
            // Nichts zu merken: ein Punkt verändert nichts und wird nie von AEGIS gelöscht.
            super::restore::restore_steps(value).map(|s| (s, None))
        } else if defender {
            // Kein allgemeines „Rückgängig“: Zurückschalten geht über die Defender-Seite mit
            // allen Prüfungen. Vor dem Ausführen den Stand frisch lesen und erneut prüfen –
            // er kann sich seit dem Vorschlag geändert haben (z. B. Manipulationsschutz an).
            aegis_defender_switch::Change::parse(value)
                .ok_or_else(|| "Unbekannte Änderung".to_owned())
                .and_then(|change| {
                    aegis_defender_switch::check(change, &system.defender_status()).map_err(|b| {
                        format!(
                            "Der Stand hat sich seit dem Vorschlag geändert – nichts geändert. {}",
                            super::defender::blocked_text(b).1
                        )
                    })
                })
                .and_then(|()| super::defender::defender_steps(value))
                .map(|s| (s, None))
        } else if block {
            super::network::block_steps(value).map(|s| {
                let program = value
                    .rsplit('\\')
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect::<String>();
                (s, Some(format!("firewall:{program}")))
            })
        } else if autorun {
            super::persistence::parse_value(value)
                .ok_or_else(|| "Ungültiger Eintrag".to_owned())
                .and_then(|(kind, id)| {
                    let name = self
                        .persistence_cache
                        .get(&owner)
                        .and_then(|list| list.iter().find(|v| v.entry.id == id))
                        .map(|v| v.entry.name.clone());
                    let entry = super::persistence::reload(kind, id, name.as_deref(), owner.as_deref()).ok_or_else(
                        || "Der Eintrag hat sich seit dem Vorschlag geändert oder ist weg – nichts geändert.".to_owned(),
                    )?;
                    let name: String = entry.name.chars().take(120).collect();
                    super::persistence::disable_steps(&entry, owner.as_deref())
                        .map(|s| (s, Some(format!("autorun:{name}"))))
                })
        } else if undo {
            self.settings
                .get()
                .hardening_undo
                .iter()
                .find(|r| r.id == value && r.owner == owner)
                .map(|r| (r.undo.clone(), None))
                .ok_or_else(|| "Nichts zum Rückgängigmachen gefunden".to_owned())
        } else {
            parse_fix(value)
                .ok_or_else(|| "Unbekannter Schritt".to_owned())
                .and_then(|fix| {
                    let state = system.fix_state(fix, owner.as_deref())?;
                    fix_steps(fix, owner.as_deref(), &state)
                        .map(|s| (s, Some(fix_name(fix).to_owned())))
                })
        };
        let at = self
            .now()
            .format(&aegis_core::time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let checked = steps.and_then(|(steps, fix)| {
            let described: Vec<String> = steps.iter().map(Step::describe).collect();
            if described != step_targets(&plan) || steps_digest(&steps) != digest {
                return Err("Der Zustand hat sich seit dem Vorschlag geändert – nichts geändert, bitte neu prüfen.".to_owned());
            }
            if steps.iter().any(Step::machine_wide) && !user.is_admin() {
                return Err("Nur mit Administratorrechten möglich.".to_owned());
            }
            Ok((steps, fix))
        });
        let (result, detail) = match checked {
            Err(message) => (
                ExecutionResult::Failed {
                    message: message.clone(),
                },
                message,
            ),
            Ok((steps, fix)) => match apply_steps(system.as_ref(), &permit, &steps, user) {
                Applied::Done(inverse) => match fix {
                    Some(fix) => {
                        let record = FixRecord {
                            id: aegis_core::uuid::Uuid::new_v4().hyphenated().to_string(),
                            fix,
                            owner: owner.clone(),
                            at,
                            undo: inverse,
                        };
                        match self.remember(record) {
                            Ok(()) => (ExecutionResult::Succeeded, String::new()),
                            Err(e) => (
                                ExecutionResult::PartiallySucceeded {
                                    message: format!(
                                        "Geändert, aber der alte Stand ließ sich nicht merken ({e}) – „Rückgängig“ ist nicht möglich."
                                    ),
                                },
                                String::new(),
                            ),
                        }
                    }
                    None => {
                        let _ = self
                            .settings
                            .update(|s| s.hardening_undo.retain(|r| r.id != value));
                        (ExecutionResult::Succeeded, String::new())
                    }
                },
                Applied::Failed(message) => (
                    ExecutionResult::Failed {
                        message: message.clone(),
                    },
                    message,
                ),
                Applied::Partial { message, remaining } => {
                    // Was noch gilt, bleibt rückgängig machbar.
                    let _ = self.remember(FixRecord {
                        id: aegis_core::uuid::Uuid::new_v4().hyphenated().to_string(),
                        fix: fix.unwrap_or_else(|| "teilweise".into()),
                        owner: owner.clone(),
                        at,
                        undo: remaining,
                    });
                    (
                        ExecutionResult::PartiallySucceeded {
                            message: message.clone(),
                        },
                        message,
                    )
                }
            },
        };
        // Score und Autostart-Liste passen danach nicht mehr – beim nächsten Aufruf neu prüfen.
        self.hardening_cache.clear();
        self.persistence_cache.clear();
        self.finish_plan(permit, &result, user, Some(detail));
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> FixState {
        FixState {
            firewall_off: vec!["privateprofile".into(), "publicprofile".into()],
            guest: Some(("Gast".into(), true)),
            auto_config: true,
            proxy_enabled: true,
            uac: Some(aegis_hardening::facts::UacLevel::Never),
            smb1: Some(true),
            rdp: Some(aegis_hardening::facts::RdpState {
                enabled: true,
                nla: false,
            }),
            ..FixState::default()
        }
    }

    #[test]
    fn schritte_sind_fest_und_lesbar() {
        let s = fix_steps(FixKind::DisableSmb1, None, &state()).unwrap();
        assert_eq!(
            s[0].describe(),
            r"HKLM\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters\SMB1 = 0 (DWORD)"
        );
        let uac = fix_steps(FixKind::EnableUac, None, &state()).unwrap();
        assert_eq!(uac.len(), 3);
        assert!(uac.iter().all(Step::machine_wide));
        let fw = fix_steps(FixKind::EnableFirewall, None, &state()).unwrap();
        assert_eq!(fw.len(), 2);
        assert!(fw[0].describe().contains("Privat"));
        let guest = fix_steps(FixKind::DisableGuest, None, &state()).unwrap();
        assert_eq!(guest[0].describe(), "Gastkonto „Gast“: deaktivieren");
        let mut st = state();
        assert!(fix_steps(FixKind::EnableDriverBlocklist, None, &st).is_err());
        st.driver_blocklist = Some(false);
        assert_eq!(
            fix_steps(FixKind::EnableDriverBlocklist, None, &st).unwrap()[0].describe(),
            r"HKLM\SYSTEM\CurrentControlSet\Control\CI\Config\VulnerableDriverBlocklistEnable = 1 (DWORD)"
        );
        st.driver_policy = true;
        assert!(fix_steps(FixKind::EnableDriverBlocklist, None, &st).is_err());
        st.driver_policy = false;
        st.driver_blocklist = Some(true);
        assert!(fix_steps(FixKind::EnableDriverBlocklist, None, &st).is_err());
        assert_eq!(
            parse_fix("enable_driver_blocklist"),
            Some(FixKind::EnableDriverBlocklist)
        );
    }

    #[test]
    fn proxy_nur_fuer_das_eigene_konto() {
        assert!(fix_steps(FixKind::DisableProxy, None, &state()).is_err());
        let s = fix_steps(FixKind::DisableProxy, Some("S-1-5-21-1-2-3-1001"), &state()).unwrap();
        assert_eq!(s.len(), 2);
        assert!(!s.iter().any(Step::machine_wide));
        assert!(
            s[0].describe()
                .starts_with(r"HKU\S-1-5-21-1-2-3-1001\Software")
        );
        assert!(s[1].describe().ends_with("AutoConfigURL entfernen"));
    }

    #[test]
    fn richtlinien_und_erledigtes_werden_nicht_angefasst() {
        let mut st = state();
        st.rdp_policy = true;
        st.nla_policy = true;
        st.firewall_policy = true;
        assert!(fix_steps(FixKind::DisableRdp, None, &st).is_err());
        assert!(fix_steps(FixKind::EnableRdpNla, None, &st).is_err());
        assert!(fix_steps(FixKind::EnableFirewall, None, &st).is_err());
        st.firewall_policy = false;
        st.firewall_off.clear();
        assert!(fix_steps(FixKind::EnableFirewall, None, &st).is_err());
        st.guest = Some(("Gast".into(), false));
        assert!(fix_steps(FixKind::DisableGuest, None, &st).is_err());
        st.guest = Some(("/delete".into(), true));
        assert!(fix_steps(FixKind::DisableGuest, None, &st).is_err());
        assert!(fix_steps(FixKind::OpenSettings, None, &st).is_err());
    }

    #[test]
    fn namen_hin_und_zurueck() {
        for name in [
            "enable_uac",
            "disable_smb1",
            "disable_rdp",
            "enable_rdp_nla",
            "disable_guest",
            "enable_firewall",
            "disable_proxy",
            "open_settings",
        ] {
            assert_eq!(parse_fix(name).map(fix_name), Some(name));
        }
        assert_eq!(parse_fix("format_c"), None);
    }

    #[test]
    fn rohwerte_lesbar() {
        assert_eq!(Raw::dword(5).text(), "5 (DWORD)");
        let text: Vec<u8> = "http://x/p.pac\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            Raw {
                kind: 1,
                bytes: text
            }
            .text(),
            "„http://x/p.pac“"
        );
    }

    #[test]
    fn bereits_strengeres_wird_nicht_gelockert() {
        use aegis_hardening::facts::{RdpState, UacLevel};
        let mut st = state();
        st.uac = Some(UacLevel::AlwaysNotify);
        assert!(fix_steps(FixKind::EnableUac, None, &st).is_err());
        st.uac = Some(UacLevel::Default);
        assert!(fix_steps(FixKind::EnableUac, None, &st).is_err());
        st.smb1 = Some(false);
        assert!(fix_steps(FixKind::DisableSmb1, None, &st).is_err());
        st.rdp = Some(RdpState {
            enabled: false,
            nla: true,
        });
        assert!(fix_steps(FixKind::DisableRdp, None, &st).is_err());
        assert!(fix_steps(FixKind::EnableRdpNla, None, &st).is_err());
        st.proxy_enabled = false;
        st.auto_config = false;
        assert!(fix_steps(FixKind::DisableProxy, Some("S-1-5-21-1-2-3-1001"), &st).is_err());
        st.connections_without_proxy = Some(vec![0x46, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
        let s = fix_steps(FixKind::DisableProxy, Some("S-1-5-21-1-2-3-1001"), &st).unwrap();
        assert_eq!(s.len(), 1);
        assert!(
            s[0].describe()
                .contains("DefaultConnectionSettings = 12 Byte (Binär)")
        );
    }

    #[test]
    fn pruefsumme_und_rohwerte() {
        let a = fix_steps(FixKind::DisableSmb1, None, &state()).unwrap();
        let b = fix_steps(FixKind::DisableRdp, None, &state()).unwrap();
        assert_ne!(steps_digest(&a), steps_digest(&b));
        assert_eq!(steps_digest(&a).len(), 32);
        assert_eq!(split_value("disable_smb1#abc"), ("disable_smb1", "abc"));
        assert_eq!(split_value("x"), ("x", ""));
        let raw = Raw {
            kind: 1,
            bytes: vec![b'a', 0],
        };
        let json = serde_json::to_string(&raw).unwrap();
        assert_eq!(json, r#"{"kind":1,"bytes":"YQA="}"#);
        assert_eq!(serde_json::from_str::<Raw>(&json).unwrap(), raw);
        assert!(raw.rememberable());
        assert!(
            !Raw {
                kind: 3,
                bytes: vec![0; 70_000]
            }
            .rememberable()
        );
        assert!(
            !Raw {
                kind: 7,
                bytes: vec![0; 8]
            }
            .rememberable()
        );
    }

    /// Ersatz: Schritt mit `fail` im Text schlägt fehl; Zurücknehmen von Firewall schlägt fehl.
    #[derive(Debug, Default)]
    struct Flaky(std::sync::Mutex<Vec<String>>);

    impl HardenSystem for Flaky {
        fn fix_state(&self, _f: FixKind, _s: Option<&str>) -> Result<FixState, String> {
            Ok(FixState::default())
        }
        fn before(&self, step: &Step, _u: &dyn UserAccess) -> Result<Step, String> {
            Ok(match step.clone() {
                Step::Firewall { profile, on } => Step::Firewall { profile, on: !on },
                other => other,
            })
        }
        fn apply(
            &self,
            _p: &ExecutionPermit,
            step: &Step,
            _u: &dyn UserAccess,
        ) -> Result<(), String> {
            let text = step.describe();
            if text.contains("fail") || matches!(step, Step::Firewall { on: false, .. }) {
                return Err("geht nicht".into());
            }
            self.0.lock().unwrap().push(text);
            Ok(())
        }
    }

    fn permit() -> ExecutionPermit {
        use aegis_core::consent::{ConsentConfig, ConsentGate, Decision, DecisionOrigin, Outcome};
        use aegis_core::testing::{ManualClock, user_answers};
        let clock = ManualClock::default();
        let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
        let plan = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(FIX_SETTING))
            .parameter(param::VALUE, "x")
            .what("x")
            .why("x")
            .consequence("x")
            .undo(UndoHint::reversible("x"))
            .severity(RiskLevel::Info)
            .build(clock.now())
            .unwrap();
        let ticket = gate.propose(plan.clone()).unwrap();
        let Outcome::Approved(approval) = user_answers(
            &mut gate,
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            DecisionOrigin::ui_dialog("d"),
        )
        .unwrap() else {
            panic!("Ja");
        };
        approval.redeem(&plan, &mut gate).unwrap()
    }

    #[test]
    fn zuruecknehmen_wird_ehrlich_gemeldet() {
        let user = aegis_quarantine::OwnProcess;
        let fw = Step::Firewall {
            profile: "publicprofile".into(),
            on: true,
        };
        let bad = Step::Guest {
            name: "fail".into(),
            active: false,
        };
        // Zurücknehmen gelingt nicht → „teilweise“, was noch gilt, ist benannt.
        let flaky = Flaky::default();
        match apply_steps(&flaky, &permit(), &[fw.clone(), bad.clone()], &user) {
            Applied::Partial { message, remaining } => {
                assert!(message.contains("Öffentlich"), "{message}");
                assert_eq!(remaining.len(), 1);
            }
            other => panic!("{other:?}"),
        }
        // Erster Schritt scheitert → nichts geändert.
        let flaky = Flaky::default();
        assert!(matches!(
            apply_steps(&flaky, &permit(), &[bad, fw], &user),
            Applied::Failed(_)
        ));
        assert!(flaky.0.lock().unwrap().is_empty());
    }
}
