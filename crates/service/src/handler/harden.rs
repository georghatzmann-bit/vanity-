//! Härtung beheben (P6.2): Jeder Vorschlag ist ein Plan mit genau den Schritten, die danach
//! ausgeführt werden (Registrierungswert, Firewall-Profil, Gastkonto) – erst nach „Ja“. Vor dem
//! Ändern merkt sich der Dienst den alten Stand; „Rückgängig“ ist ein eigener Plan.
//!
//! - Rechnerweite Änderungen nur für Administratoren; der Proxy nur für das eigene Konto.
//! - Gruppenrichtlinien werden nie geändert – steht dort etwas, sagt AEGIS das ehrlich.
//! - Beim Ausführen werden die Schritte neu bestimmt und müssen genau denen im Plan entsprechen,
//!   sonst passiert nichts („Zustand hat sich geändert – bitte neu prüfen“).

use std::collections::HashMap;

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
/// Gemerkte Stände (älteste fallen heraus).
const MAX_RECORDS: usize = 50;

/// Wo ein Registrierungswert liegt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    /// `HKLM`.
    Machine,
    /// `HKU\<SID>` des anfragenden Kontos.
    User(String),
}

/// Roher Registrierungswert (Typ + Bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raw {
    /// Typ (4 = `REG_DWORD`).
    pub kind: u32,
    /// Daten.
    pub bytes: Vec<u8>,
}

impl Raw {
    fn dword(value: u32) -> Self {
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
    /// Gastkonto aktivieren bzw. deaktivieren.
    Guest {
        /// Name des Kontos (sprachabhängig, z. B. „Gast“).
        name: String,
        /// Aktiv?
        active: bool,
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
        }
    }

    fn machine_wide(&self) -> bool {
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

/// Die Schritte eines Behebens (rein, ohne Systemzugriff – testbar).
///
/// # Errors
/// Nicht behebbar (bereits in Ordnung, Gruppenrichtlinie, kein Konto …).
pub fn fix_steps(fix: FixKind, sid: Option<&str>, state: &FixState) -> Result<Vec<Step>, String> {
    let uac = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    match fix {
        FixKind::EnableUac => Ok(vec![
            machine(uac, "EnableLUA", 1),
            machine(uac, "ConsentPromptBehaviorAdmin", 5),
            machine(uac, "PromptOnSecureDesktop", 1),
        ]),
        FixKind::DisableSmb1 => Ok(vec![machine(
            r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters",
            "SMB1",
            0,
        )]),
        FixKind::DisableRdp if state.rdp_policy => Err(
            "Remotedesktop ist per Gruppenrichtlinie festgelegt – AEGIS ändert keine Richtlinien (bitte die IT bzw. „gpedit.msc“).".into(),
        ),
        FixKind::DisableRdp => Ok(vec![machine(
            r"SYSTEM\CurrentControlSet\Control\Terminal Server",
            "fDenyTSConnections",
            1,
        )]),
        FixKind::EnableRdpNla if state.nla_policy => Err(
            "Die Anmeldung auf Netzwerkebene ist per Gruppenrichtlinie festgelegt – AEGIS ändert keine Richtlinien.".into(),
        ),
        FixKind::EnableRdpNla => Ok(vec![machine(
            r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp",
            "UserAuthentication",
            1,
        )]),
        FixKind::DisableGuest => match &state.guest {
            Some((name, true)) if plausible_account(name) => Ok(vec![Step::Guest {
                name: name.clone(),
                active: false,
            }]),
            Some((_, false)) => Err("Das Gastkonto ist bereits deaktiviert.".into()),
            _ => Err("Gastkonto nicht gefunden.".into()),
        },
        FixKind::EnableFirewall if state.firewall_policy => Err(
            "Eine Gruppenrichtlinie schaltet die Firewall ab – AEGIS ändert keine Richtlinien.".into(),
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
            let mut steps = vec![Step::Registry {
                place: Place::User(sid.to_owned()),
                key: key.clone(),
                name: "ProxyEnable".into(),
                value: Some(Raw::dword(0)),
            }];
            if state.auto_config {
                // Das Proxy-Skript wird entfernt (der alte Wert bleibt für „Rückgängig“).
                steps.push(Step::Registry {
                    place: Place::User(sid.to_owned()),
                    key,
                    name: "AutoConfigURL".into(),
                    value: None,
                });
            }
            Ok(steps)
        }
        FixKind::OpenSettings => {
            Err("Dieser Punkt wird in den Windows-Einstellungen geändert – AEGIS öffnet sie nur.".into())
        }
    }
}

struct Texts {
    what: &'static str,
    why: &'static str,
    consequence: &'static str,
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

/// Liest den Stand für einen Plan (Windows; sonst nichts behebbar).
fn read_state(user: &dyn UserAccess) -> Result<FixState, String> {
    #[cfg(windows)]
    {
        let sid = user.identity().filter(|s| s.starts_with("S-1-"));
        Ok(aegis_hardening::collect::fix_state(sid.as_deref()))
    }
    #[cfg(not(windows))]
    {
        let _ = user;
        Err("Beheben gibt es nur unter Windows.".into())
    }
}

/// Führt die Schritte aus und liefert die Schritte zum Rückgängigmachen. Schlägt ein Schritt
/// fehl, werden die schon ausgeführten zurückgenommen. Nur mit der Erlaubnis eines Plans.
fn apply_steps(permit: &ExecutionPermit, steps: &[Step]) -> Result<Vec<Step>, String> {
    let mut undo: Vec<Step> = Vec::new();
    for step in steps {
        match sys::before(step).and_then(|inverse| sys::apply(permit, step).map(|()| inverse)) {
            Ok(inverse) => undo.push(inverse),
            Err(e) => {
                for back in undo.iter().rev() {
                    let _ = sys::apply(permit, back);
                }
                return Err(format!("{}: {e}", step.describe()));
            }
        }
    }
    undo.reverse();
    Ok(undo)
}

#[cfg(windows)]
mod sys {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use aegis_core::consent::ExecutionPermit;
    use aegis_winffi::inspect::Hive;
    use aegis_winffi::registry::{RawValue, delete_value, read_raw, write_raw};

    use super::{Place, Raw, Step};

    fn hive(place: &Place) -> Hive {
        match place {
            Place::Machine => Hive::LocalMachine,
            Place::User(sid) => Hive::User(sid.clone()),
        }
    }

    /// Der Schritt, der den jetzigen Stand wiederherstellt.
    pub(super) fn before(step: &Step) -> Result<Step, String> {
        Ok(match step {
            Step::Registry {
                place, key, name, ..
            } => Step::Registry {
                place: place.clone(),
                key: key.clone(),
                name: name.clone(),
                value: read_raw(&hive(place), key, name)
                    .map_err(|e| format!("alter Wert nicht lesbar: {e}"))?
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
        })
    }

    fn tool(name: &str) -> Result<PathBuf, String> {
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot unbekannt")?;
        Ok(PathBuf::from(root).join("System32").join(name))
    }

    /// Startet ein Windows-Werkzeug vom festen Systemort (höchstens 30 s).
    fn run(exe: &str, args: &[&str]) -> Result<(), String> {
        let path = tool(exe)?;
        // Führt einen Schritt eines freigegebenen Härtungs-Plans aus (netsh bzw. net am festen
        // Systemort, Argumente aus dem Plan).
        // aegis-mutation: service-harden-tool
        #[allow(clippy::disallowed_methods)]
        let child = std::process::Command::new(&path)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = child.map_err(|e| format!("{exe} startet nicht: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
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

    pub(super) fn apply(permit: &ExecutionPermit, step: &Step) -> Result<(), String> {
        let _ = permit.plan();
        match step {
            Step::Registry {
                place,
                key,
                name,
                value: Some(v),
            } => write_raw(
                &hive(place),
                key,
                name,
                &RawValue {
                    kind: v.kind,
                    bytes: v.bytes.clone(),
                },
            )
            .map_err(|e| e.to_string()),
            Step::Registry {
                place,
                key,
                name,
                value: None,
            } => delete_value(&hive(place), key, name).map_err(|e| e.to_string()),
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
        }
    }
}

#[cfg(not(windows))]
mod sys {
    use aegis_core::consent::ExecutionPermit;

    use super::Step;

    pub(super) fn before(_step: &Step) -> Result<Step, String> {
        Err("nur unter Windows".into())
    }

    pub(super) fn apply(permit: &ExecutionPermit, _step: &Step) -> Result<(), String> {
        let _ = permit.plan();
        Err("nur unter Windows".into())
    }
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

    fn fix_plan(
        &self,
        setting: &str,
        value: &str,
        steps: &[Step],
        texts: &Texts,
        undo: UndoHint,
    ) -> Result<ActionPlan, String> {
        let mut builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(setting))
            .parameter(param::VALUE, value);
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
            .severity(RiskLevel::Info)
            .build(self.now())
            .map_err(|e| e.to_string())
    }

    /// Schlägt vor, einen Punkt der Härtung zu beheben.
    pub fn propose_fix(&mut self, fix: &str, user: &dyn UserAccess) -> Response {
        let Some(fix) = parse_fix(fix) else {
            return Response::error("input", "Unbekannter Schritt");
        };
        let state = match read_state(user) {
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
                "Diese Einstellung gilt für den ganzen PC – nur ein Administrator kann sie ändern.",
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
            return Response::error("admin", "Nur ein Administrator kann das zurücknehmen.");
        }
        let fix = parse_fix(&record.fix).map_or("Härtung", |f| texts(f).what);
        let texts = Texts {
            what: "Härtung rückgängig machen",
            why: "Von dir gewählt.",
            consequence: "Der Stand vor dem Beheben wird wiederhergestellt.",
        };
        let plan = self.fix_plan(
            UNDO_SETTING,
            &record.id,
            &record.undo,
            &texts,
            UndoHint::reversible(format!(
                "„{fix}“ kannst du jederzeit erneut vorschlagen lassen."
            )),
        );
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e),
        }
    }

    /// Führt ein freigegebenes Beheben bzw. Rückgängigmachen aus.
    pub(super) fn apply_fix(&mut self, permit: ExecutionPermit, user: &dyn UserAccess) -> Response {
        let plan = permit.plan().clone();
        let value = plan.parameter(param::VALUE).unwrap_or_default().to_owned();
        let undo = plan
            .targets()
            .iter()
            .any(|t| matches!(t, Target::Setting { id } if id == UNDO_SETTING));
        let owner = user.identity();
        // Schritte neu bestimmen – sie müssen genau denen im Plan entsprechen.
        let steps: Result<(Vec<Step>, Option<FixKind>), String> = if undo {
            self.settings
                .get()
                .hardening_undo
                .iter()
                .find(|r| r.id == value && r.owner == owner)
                .map(|r| (r.undo.clone(), None))
                .ok_or_else(|| "Nichts zum Rückgängigmachen gefunden".to_owned())
        } else {
            parse_fix(&value)
                .ok_or_else(|| "Unbekannter Schritt".to_owned())
                .and_then(|fix| {
                    let state = read_state(user)?;
                    fix_steps(fix, owner.as_deref(), &state).map(|s| (s, Some(fix)))
                })
        };
        let outcome = steps.and_then(|(steps, fix)| {
            let described: Vec<String> = steps.iter().map(Step::describe).collect();
            if described != step_targets(&plan) {
                return Err("Der Zustand hat sich seit dem Vorschlag geändert – nichts geändert, bitte neu prüfen.".into());
            }
            if steps.iter().any(Step::machine_wide) && !user.is_admin() {
                return Err("Nur ein Administrator kann das ändern.".into());
            }
            apply_steps(&permit, &steps).map(|inverse| (inverse, fix))
        });
        let at = self
            .now()
            .format(&aegis_core::time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let (result, detail) = match outcome {
            Ok((inverse, Some(fix))) => {
                let record = FixRecord {
                    id: aegis_core::uuid::Uuid::new_v4().hyphenated().to_string(),
                    fix: fix_name(fix).to_owned(),
                    owner: owner.clone(),
                    at,
                    undo: inverse,
                };
                let saved = self.settings.update(|s| {
                    s.hardening_undo.push(record);
                    let excess = s.hardening_undo.len().saturating_sub(MAX_RECORDS);
                    s.hardening_undo.drain(..excess);
                });
                match saved {
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
            Ok((_, None)) => {
                let _ = self
                    .settings
                    .update(|s| s.hardening_undo.retain(|r| r.id != value));
                (ExecutionResult::Succeeded, String::new())
            }
            Err(message) => (
                ExecutionResult::Failed {
                    message: message.clone(),
                },
                message,
            ),
        };
        // Der Score passt danach nicht mehr – beim nächsten Aufruf neu prüfen.
        self.hardening_cache.clear();
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
            firewall_policy: false,
            guest: Some(("Gast".into(), true)),
            rdp_policy: false,
            nla_policy: false,
            auto_config: true,
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
}
