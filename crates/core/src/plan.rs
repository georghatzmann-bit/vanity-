//! Aktionspläne: die vollständige, prüfbare Beschreibung einer beabsichtigten Veränderung.
//!
//! Bezug zur Goldenen Regel: Bevor AEGIS irgendetwas verändert, verschiebt, beendet oder
//! löscht, beschreibt ein [`ActionPlan`] dem Nutzer
//!
//! * **Was genau?** – [`ActionPlan::what`] und die betroffenen [`Target`]s,
//! * **Warum?** – [`ActionPlan::why`],
//! * **Was passiert dann?** – [`ActionPlan::consequence`],
//! * **Rückgängig wie?** – [`UndoHint`].
//!
//! Ein Plan ist reine Beschreibung und berechtigt zu **nichts**. Er kann frei serialisiert
//! und über die Pipe an die UI geschickt werden. Auch ein deserialisierter Plan wird
//! vollständig geprüft (wie im [`ActionPlanBuilder`]) und gewährt keinerlei Freigabe – die
//! entsteht ausschließlich in [`crate::consent::ConsentGate::decide`].
//!
//! Die [`PlanDigest`] ist eine SHA-256-Prüfsumme über eine kanonische Binärkodierung aller
//! Felder (feste Reihenfolge, Längenpräfixe, keine `HashMap`). Eine Freigabe ist an genau
//! diese Prüfsumme gebunden: Ändert sich irgendein Feld, passt die Freigabe nicht mehr.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::canonical::{self, CanonicalWriter};
use crate::risk::RiskLevel;

/// Höchstlänge (in Bytes) für Freitexte, Pfade und Parameterwerte.
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
/// Höchstzahl an Zielen pro Plan.
pub const MAX_TARGETS: usize = 100_000;
/// Höchstzahl an Ausführungsparametern pro Plan.
pub const MAX_PARAMETERS: usize = 64;
/// Höchstlänge eines Parameter-Schlüssels in Bytes.
pub const MAX_PARAMETER_KEY_BYTES: usize = 64;

/// Bekannte Schlüssel für [`ActionPlan::parameters`].
///
/// Alles, was ein Ausführer zusätzlich zu den Zielen braucht (Zielordner, neuer Name …),
/// **muss** als Parameter im Plan stehen. Nur so ist es an die Prüfsumme gebunden und für
/// den Nutzer sichtbar. Ausführer dürfen keine Angaben von außerhalb des Plans übernehmen.
pub mod param {
    /// Zielordner für [`super::ActionKind::MoveFile`] (absoluter Pfad, Pflicht).
    pub const DESTINATION: &str = "destination";
    /// Neuer Dateiname für [`super::ActionKind::RenameFile`] (ein einzelner, unter Windows
    /// gültiger Dateiname, Pflicht).
    pub const NEW_NAME: &str = "new_name";
    /// Kennung des Quarantäne-Eintrags für [`super::ActionKind::Restore`] und
    /// [`super::ActionKind::DeletePermanently`] aus der Quarantäne (das Datei-Ziel ist der
    /// ursprüngliche Ort, der dem Nutzer angezeigt wird).
    pub const QUARANTINE_ID: &str = "quarantine_id";
    /// Neuer Wert für [`super::ActionKind::ChangeSetting`] (Pflicht; darf leer sein). So ist
    /// das „Ja“ des Nutzers an den Wert gebunden, auf den geändert wird – ein Ausführer
    /// nimmt ihn ausschließlich von hier.
    pub const VALUE: &str = "value";
    /// Typ des neuen Werts bei Registrierungswerten (Pflicht, sobald ein
    /// [`super::Target::RegistryValue`] im Plan steht): einer von [`REGISTRY_VALUE_TYPES`].
    pub const VALUE_TYPE: &str = "value_type";
    /// Stufe eines Labor-Laufs ([`super::ActionKind::RunInSandbox`], Pflicht): einer von
    /// [`LAB_STAGES`].
    pub const LAB_STAGE: &str = "lab_stage";
    /// Erlaubte Werte für [`LAB_STAGE`].
    pub const LAB_STAGES: [&str; 2] = ["windows_sandbox", "mini_sandbox"];
    /// Beobachtungszeit eines Labor-Laufs in Sekunden (Pflicht, 5–600).
    pub const LAB_SECONDS: &str = "lab_seconds";
    /// Netzwerk im Labor (Pflicht): `off` oder `on` (`on` nur in der Windows Sandbox).
    pub const LAB_NETWORK: &str = "lab_network";
    /// Erlaubte Werte für [`VALUE_TYPE`].
    pub const REGISTRY_VALUE_TYPES: [&str; 6] = [
        "REG_SZ",
        "REG_EXPAND_SZ",
        "REG_MULTI_SZ",
        "REG_DWORD",
        "REG_QWORD",
        "REG_BINARY",
    ];
}

const FIELD_WHAT: &str = "Was genau";
const FIELD_WHY: &str = "Warum";
const FIELD_CONSEQUENCE: &str = "Was passiert dann";
const FIELD_UNDO: &str = "Rückgängig";

/// Fehler beim Erstellen, Prüfen oder Einlesen eines Plans.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum PlanError {
    /// Pflichttext fehlt oder ist leer.
    #[error("Pflichtangabe „{field}“ fehlt oder ist leer")]
    MissingText {
        /// Betroffenes Feld (deutsche Bezeichnung).
        field: &'static str,
    },
    /// Text ist zu lang oder enthält ein NUL-Zeichen.
    #[error("Angabe „{field}“ ist ungültig: {reason}")]
    InvalidText {
        /// Betroffenes Feld (deutsche Bezeichnung).
        field: &'static str,
        /// Grund.
        reason: &'static str,
    },
    /// Rückgängig-Hinweis fehlt.
    #[error("Pflichtangabe „Rückgängig“ fehlt")]
    MissingUndo,
    /// Risikostufe fehlt.
    #[error("Pflichtangabe „Risikostufe“ fehlt")]
    MissingSeverity,
    /// Kein Ziel angegeben.
    #[error("Der Plan nennt kein Ziel – mindestens ein Ziel ist Pflicht")]
    NoTargets,
    /// Zu viele Ziele.
    #[error("Der Plan nennt zu viele Ziele (höchstens {max})")]
    TooManyTargets {
        /// Obergrenze.
        max: usize,
    },
    /// Ein Ziel ist ungültig.
    #[error("Ziel Nr. {index} ist ungültig: {reason}")]
    InvalidTarget {
        /// Position (ab 0).
        index: usize,
        /// Grund.
        reason: &'static str,
    },
    /// Ein Ziel kommt doppelt vor.
    #[error("Ziel Nr. {index} kommt doppelt vor")]
    DuplicateTarget {
        /// Position (ab 0) des zweiten Vorkommens.
        index: usize,
    },
    /// Ziel passt nicht zur Aktion (z. B. Datei bei „Prozess beenden“).
    #[error("Ziel Nr. {index} passt nicht zur Aktion „{kind}“")]
    TargetNotAllowed {
        /// Aktion.
        kind: ActionKind,
        /// Position (ab 0).
        index: usize,
    },
    /// Die Aktion ist nicht umkehrbar, der Plan behauptet aber das Gegenteil.
    #[error("„{kind}“ ist nicht rückgängig zu machen – der Plan muss das ehrlich angeben")]
    MustBeIrreversible {
        /// Aktion.
        kind: ActionKind,
    },
    /// Die Aktion braucht genau ein Ziel.
    #[error("„{kind}“ braucht genau ein Ziel")]
    ExactlyOneTarget {
        /// Aktion.
        kind: ActionKind,
    },
    /// Pflichtparameter fehlt.
    #[error("„{kind}“ braucht den Parameter „{key}“")]
    MissingParameter {
        /// Aktion.
        kind: ActionKind,
        /// Schlüssel.
        key: &'static str,
    },
    /// Parameter ist ungültig.
    #[error("Parameter „{key}“ ist ungültig: {reason}")]
    InvalidParameter {
        /// Schlüssel.
        key: String,
        /// Grund.
        reason: &'static str,
    },
    /// Zu viele Parameter.
    #[error("Der Plan hat zu viele Parameter (höchstens {max})")]
    TooManyParameters {
        /// Obergrenze.
        max: usize,
    },
    /// Zeitstempel unbrauchbar (vor 1970, nach 9999 oder nicht in UTC darstellbar).
    #[error("Der Erstellungszeitpunkt des Plans ist ungültig")]
    InvalidTimestamp,
    /// Plan-ID ungültig (nicht lesbar oder Null-UUID).
    #[error("Die Plan-ID ist ungültig")]
    InvalidPlanId,
    /// Prüfsumme nicht lesbar (erwartet: 64 Hex-Zeichen in Kleinbuchstaben).
    #[error("Die Prüfsumme ist ungültig (erwartet: 64 Hex-Zeichen in Kleinbuchstaben)")]
    InvalidDigest,
}

// ---------------------------------------------------------------------------------------
// PlanId
// ---------------------------------------------------------------------------------------

/// Eindeutige Kennung eines Plans (UUID v4).
///
/// Eine Plan-ID ist kein Berechtigungsnachweis – sie benennt nur, worüber entschieden wird.
/// Das [`crate::consent::ConsentGate`] nimmt jede ID nur ein einziges Mal an.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlanId(Uuid);

impl PlanId {
    /// Neue, zufällige ID (UUID v4).
    #[must_use]
    pub fn new_random() -> Self {
        Self(Uuid::new_v4())
    }

    /// ID aus einer vorhandenen UUID (z. B. aus der UI zurückgeschickt).
    #[must_use]
    pub const fn from_uuid(uuid: Uuid) -> Self {
        Self(uuid)
    }

    /// Zugrunde liegende UUID.
    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl fmt::Display for PlanId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0.hyphenated(), f)
    }
}

impl FromStr for PlanId {
    type Err = PlanError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s)
            .map(Self)
            .map_err(|_| PlanError::InvalidPlanId)
    }
}

// ---------------------------------------------------------------------------------------
// PlanDigest
// ---------------------------------------------------------------------------------------

/// SHA-256-Prüfsumme über die kanonische Darstellung eines [`ActionPlan`].
///
/// Darstellung (Display/FromStr/serde): 64 Hex-Zeichen in Kleinbuchstaben.
/// Die UI schickt die Prüfsumme des angezeigten Plans mit jeder Entscheidung zurück; nur
/// wenn sie exakt passt, kann eine Freigabe entstehen.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct PlanDigest([u8; 32]);

impl PlanDigest {
    /// Prüfsumme aus rohen Bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Rohe Bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for PlanDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&canonical::hex_lower(&self.0))
    }
}

impl fmt::Debug for PlanDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PlanDigest({self})")
    }
}

impl FromStr for PlanDigest {
    type Err = PlanError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        canonical::parse_hex32(s)
            .map(Self)
            .ok_or(PlanError::InvalidDigest)
    }
}

impl From<PlanDigest> for String {
    fn from(value: PlanDigest) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for PlanDigest {
    type Error = PlanError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

// ---------------------------------------------------------------------------------------
// ActionKind
// ---------------------------------------------------------------------------------------

/// Art der beabsichtigten Veränderung.
///
/// Jede Art legt fest, welche [`Target`]s erlaubt sind ([`ActionKind::accepts_target`]),
/// ob sie ehrlich als „nicht rückgängig“ gekennzeichnet werden muss
/// ([`ActionKind::must_be_irreversible`]) und ob eine zweite Bestätigung nötig ist
/// ([`ActionKind::requires_second_confirmation`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ActionKind {
    /// Datei in die (verschlüsselte) Quarantäne verschieben.
    Quarantine,
    /// Datei aus der Quarantäne an ihren Ort zurücklegen. Das [`Target::File`] ist genau der
    /// Ort, an den zurückgelegt wird (der ursprüngliche Pfad); ein abweichender Zielordner
    /// ([`param::DESTINATION`]) ist nicht erlaubt.
    Restore,
    /// Datei endgültig löschen – braucht eine zweite, getrennte Bestätigung.
    DeletePermanently,
    /// Prozess anhalten (einfrieren).
    SuspendProcess,
    /// Angehaltenen Prozess fortsetzen.
    ResumeProcess,
    /// Prozess beenden – nicht rückgängig zu machen.
    TerminateProcess,
    /// Einstellung oder Registrierungswert ändern – auf den Wert [`param::VALUE`]
    /// (bei Registrierungswerten mit Typ [`param::VALUE_TYPE`]).
    ChangeSetting,
    /// Datei verschieben (Zielordner in [`param::DESTINATION`]).
    MoveFile,
    /// Datei umbenennen (neuer Name in [`param::NEW_NAME`]).
    RenameFile,
    /// Ziel in die Vertrauensliste aufnehmen.
    AddTrust,
    /// Ziel aus der Vertrauensliste entfernen.
    RemoveTrust,
    /// Datei im Labor (Windows Sandbox bzw. Mini-Sandbox) starten und beobachten. Die Datei
    /// selbst bleibt unverändert; das Labor wird danach verworfen.
    RunInSandbox,
}

impl ActionKind {
    /// Alle bekannten Arten.
    pub const ALL: [Self; 12] = [
        Self::Quarantine,
        Self::Restore,
        Self::DeletePermanently,
        Self::SuspendProcess,
        Self::ResumeProcess,
        Self::TerminateProcess,
        Self::ChangeSetting,
        Self::MoveFile,
        Self::RenameFile,
        Self::AddTrust,
        Self::RemoveTrust,
        Self::RunInSandbox,
    ];

    /// Stabile Kennung (identisch mit der serde-Darstellung, Teil der Prüfsumme).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Quarantine => "quarantine",
            Self::Restore => "restore",
            Self::DeletePermanently => "delete_permanently",
            Self::SuspendProcess => "suspend_process",
            Self::ResumeProcess => "resume_process",
            Self::TerminateProcess => "terminate_process",
            Self::ChangeSetting => "change_setting",
            Self::MoveFile => "move_file",
            Self::RenameFile => "rename_file",
            Self::AddTrust => "add_trust",
            Self::RemoveTrust => "remove_trust",
            Self::RunInSandbox => "run_in_sandbox",
        }
    }

    /// Deutsche Bezeichnung für die UI.
    #[must_use]
    pub const fn label_de(self) -> &'static str {
        match self {
            Self::Quarantine => "In Quarantäne verschieben",
            Self::Restore => "Aus Quarantäne wiederherstellen",
            Self::DeletePermanently => "Endgültig löschen",
            Self::SuspendProcess => "Prozess anhalten",
            Self::ResumeProcess => "Prozess fortsetzen",
            Self::TerminateProcess => "Prozess beenden",
            Self::ChangeSetting => "Einstellung ändern",
            Self::MoveFile => "Datei verschieben",
            Self::RenameFile => "Datei umbenennen",
            Self::AddTrust => "Als vertrauenswürdig markieren",
            Self::RemoveTrust => "Vertrauen entziehen",
            Self::RunInSandbox => "Im Labor ausführen",
        }
    }

    /// Englische Bezeichnung (zweite Sprache).
    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::Quarantine => "Move to quarantine",
            Self::Restore => "Restore from quarantine",
            Self::DeletePermanently => "Delete permanently",
            Self::SuspendProcess => "Suspend process",
            Self::ResumeProcess => "Resume process",
            Self::TerminateProcess => "Terminate process",
            Self::ChangeSetting => "Change setting",
            Self::MoveFile => "Move file",
            Self::RenameFile => "Rename file",
            Self::AddTrust => "Mark as trusted",
            Self::RemoveTrust => "Remove trust",
            Self::RunInSandbox => "Run in the lab",
        }
    }

    /// `true`, wenn die Aktion grundsätzlich nicht umkehrbar ist und der Plan das mit
    /// [`UndoHint::Irreversible`] ehrlich angeben muss.
    #[must_use]
    pub const fn must_be_irreversible(self) -> bool {
        matches!(self, Self::DeletePermanently | Self::TerminateProcess)
    }

    /// `true`, wenn eine Freigabe zusätzlich eine zweite, zeitlich getrennte Bestätigung
    /// braucht (siehe [`crate::consent::PermanentDeleteApproval`]).
    #[must_use]
    pub const fn requires_second_confirmation(self) -> bool {
        matches!(self, Self::DeletePermanently)
    }

    /// Ob ein Ziel zu dieser Aktion passt (z. B. nur Prozesse bei „Prozess beenden“).
    #[must_use]
    pub const fn accepts_target(self, target: &Target) -> bool {
        match self {
            Self::Quarantine
            | Self::Restore
            | Self::DeletePermanently
            | Self::MoveFile
            | Self::RenameFile
            | Self::RunInSandbox => matches!(target, Target::File { .. }),
            Self::SuspendProcess | Self::ResumeProcess | Self::TerminateProcess => {
                matches!(target, Target::Process { .. })
            }
            Self::ChangeSetting => matches!(
                target,
                Target::Setting { .. } | Target::RegistryValue { .. } | Target::Other { .. }
            ),
            Self::AddTrust | Self::RemoveTrust => matches!(
                target,
                Target::File { .. } | Target::Process { .. } | Target::Other { .. }
            ),
        }
    }
}

impl fmt::Display for ActionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label_de())
    }
}

// ---------------------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------------------

/// Ein Ziel, auf das sich ein Plan bezieht.
///
/// Pfade müssen absolut, gültiges Unicode und ohne `..` sein (geprüft im Plan), damit der
/// Nutzer genau das sieht, worauf später zugegriffen wird.
///
/// Hinweis für die UI: Datei- und Prozessnamen stammen vom System und können
/// Steuerzeichen (z. B. Unicode-Bidi-Overrides) enthalten. Die UI muss sie sichtbar
/// maskieren, damit kein Name eine harmlose Endung vortäuschen kann.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[non_exhaustive]
pub enum Target {
    /// Eine Datei.
    File {
        /// Absoluter Pfad.
        path: PathBuf,
    },
    /// Ein laufender Prozess.
    Process {
        /// Prozess-ID (nicht 0).
        pid: u32,
        /// Absoluter Pfad der ausführbaren Datei (schützt vor wiederverwendeten PIDs).
        image_path: PathBuf,
    },
    /// Ein Wert in der Windows-Registrierung.
    RegistryValue {
        /// Schlüssel, z. B. `HKCU\Software\…`.
        key: String,
        /// Name des Werts (leer = Standardwert).
        name: String,
    },
    /// Eine AEGIS- oder Systemeinstellung mit stabiler Kennung.
    Setting {
        /// Kennung der Einstellung.
        id: String,
    },
    /// Sonstiges Ziel, frei beschrieben.
    Other {
        /// Beschreibung.
        description: String,
    },
}

impl Target {
    /// Datei-Ziel.
    #[must_use]
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Self::File { path: path.into() }
    }

    /// Prozess-Ziel.
    #[must_use]
    pub fn process(pid: u32, image_path: impl Into<PathBuf>) -> Self {
        Self::Process {
            pid,
            image_path: image_path.into(),
        }
    }

    /// Registrierungswert-Ziel.
    #[must_use]
    pub fn registry_value(key: impl Into<String>, name: impl Into<String>) -> Self {
        Self::RegistryValue {
            key: key.into(),
            name: name.into(),
        }
    }

    /// Einstellungs-Ziel.
    #[must_use]
    pub fn setting(id: impl Into<String>) -> Self {
        Self::Setting { id: id.into() }
    }

    /// Sonstiges Ziel.
    #[must_use]
    pub fn other(description: impl Into<String>) -> Self {
        Self::Other {
            description: description.into(),
        }
    }

    /// Stabile Kennung der Ziel-Art (identisch mit dem serde-Feld `type`).
    #[must_use]
    pub const fn type_str(&self) -> &'static str {
        match self {
            Self::File { .. } => "file",
            Self::Process { .. } => "process",
            Self::RegistryValue { .. } => "registry_value",
            Self::Setting { .. } => "setting",
            Self::Other { .. } => "other",
        }
    }

    fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::File { path } => check_path(path),
            Self::Process { pid, image_path } => {
                if *pid == 0 {
                    return Err("Prozess-ID 0 ist nicht erlaubt");
                }
                check_path(image_path)
            }
            Self::RegistryValue { key, name } => {
                check_value(key, false)?;
                check_value(name, true)
            }
            Self::Setting { id } => check_value(id, false),
            Self::Other { description } => check_value(description, false),
        }
    }

    fn encode(&self, w: &mut CanonicalWriter) {
        w.str(self.type_str());
        match self {
            Self::File { path } => {
                w.field("path");
                w.bytes(path.as_os_str().as_encoded_bytes());
            }
            Self::Process { pid, image_path } => {
                w.field("pid");
                w.u64(u64::from(*pid));
                w.field("image_path");
                w.bytes(image_path.as_os_str().as_encoded_bytes());
            }
            Self::RegistryValue { key, name } => {
                w.field("key");
                w.str(key);
                w.field("name");
                w.str(name);
            }
            Self::Setting { id } => {
                w.field("id");
                w.str(id);
            }
            Self::Other { description } => {
                w.field("description");
                w.str(description);
            }
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::File { path } => write!(f, "Datei {}", path.display()),
            Self::Process { pid, image_path } => {
                write!(f, "Prozess {pid} ({})", image_path.display())
            }
            Self::RegistryValue { key, name } if name.is_empty() => {
                write!(f, "Registrierungswert {key} (Standard)")
            }
            Self::RegistryValue { key, name } => write!(f, "Registrierungswert {key}\\{name}"),
            Self::Setting { id } => write!(f, "Einstellung {id}"),
            Self::Other { description } => f.write_str(description),
        }
    }
}

fn check_path(path: &Path) -> Result<(), &'static str> {
    let Some(text) = path.to_str() else {
        return Err("Pfad ist kein gültiges Unicode");
    };
    if text.is_empty() {
        return Err("Pfad ist leer");
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("Pfad ist zu lang");
    }
    if text.contains('\0') {
        return Err("Pfad enthält ein NUL-Zeichen");
    }
    if !path.is_absolute() {
        return Err("Pfad muss absolut sein");
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Pfad darf kein „..“ enthalten");
    }
    Ok(())
}

fn check_value(value: &str, allow_empty: bool) -> Result<(), &'static str> {
    if !allow_empty && value.trim().is_empty() {
        return Err("Angabe ist leer");
    }
    if value.len() > MAX_TEXT_BYTES {
        return Err("Angabe ist zu lang");
    }
    if value.contains('\0') {
        return Err("Angabe enthält ein NUL-Zeichen");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// UndoHint
// ---------------------------------------------------------------------------------------

/// Antwort auf „Rückgängig wie?“.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum UndoHint {
    /// Umkehrbar – `how` erklärt, wie (z. B. „Über Quarantäne → Wiederherstellen“).
    Reversible {
        /// Erklärung für den Nutzer.
        how: String,
    },
    /// Nicht umkehrbar – `warning` sagt das deutlich.
    Irreversible {
        /// Deutliche Warnung für den Nutzer.
        warning: String,
    },
}

impl UndoHint {
    /// Umkehrbar, mit Erklärung.
    #[must_use]
    pub fn reversible(how: impl Into<String>) -> Self {
        Self::Reversible { how: how.into() }
    }

    /// Nicht umkehrbar, mit Warnung.
    #[must_use]
    pub fn irreversible(warning: impl Into<String>) -> Self {
        Self::Irreversible {
            warning: warning.into(),
        }
    }

    /// `true` bei [`UndoHint::Reversible`].
    #[must_use]
    pub const fn is_reversible(&self) -> bool {
        matches!(self, Self::Reversible { .. })
    }

    /// Erklärung bzw. Warnung.
    #[must_use]
    pub fn text(&self) -> &str {
        match self {
            Self::Reversible { how } => how,
            Self::Irreversible { warning } => warning,
        }
    }

    fn encode(&self, w: &mut CanonicalWriter) {
        match self {
            Self::Reversible { how } => {
                w.str("reversible");
                w.str(how);
            }
            Self::Irreversible { warning } => {
                w.str("irreversible");
                w.str(warning);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// ActionPlan
// ---------------------------------------------------------------------------------------

/// Ein geprüfter Aktionsplan.
///
/// Felder sind privat: Ein Plan entsteht nur über [`ActionPlan::builder`] oder geprüftes
/// Deserialisieren und ist danach unveränderlich – jede „Änderung“ wäre ein neuer Plan mit
/// neuer Prüfsumme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ActionPlanWire")]
pub struct ActionPlan {
    id: PlanId,
    kind: ActionKind,
    targets: Vec<Target>,
    what: String,
    why: String,
    consequence: String,
    undo: UndoHint,
    severity: RiskLevel,
    parameters: BTreeMap<String, String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

/// Wire-Format beim Deserialisieren; wird vollständig geprüft, bevor ein Plan entsteht.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionPlanWire {
    id: PlanId,
    kind: ActionKind,
    targets: Vec<Target>,
    what: String,
    why: String,
    consequence: String,
    undo: UndoHint,
    severity: RiskLevel,
    #[serde(default)]
    parameters: BTreeMap<String, String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

impl TryFrom<ActionPlanWire> for ActionPlan {
    type Error = PlanError;

    fn try_from(wire: ActionPlanWire) -> Result<Self, Self::Error> {
        Self::validated(Self {
            id: wire.id,
            kind: wire.kind,
            targets: wire.targets,
            what: wire.what,
            why: wire.why,
            consequence: wire.consequence,
            undo: wire.undo,
            severity: wire.severity,
            parameters: wire.parameters,
            created_at: wire.created_at,
        })
    }
}

impl ActionPlan {
    /// Beginnt einen neuen Plan für die angegebene Aktion.
    pub fn builder(kind: ActionKind) -> ActionPlanBuilder {
        ActionPlanBuilder::new(kind)
    }

    /// Plan-ID.
    #[must_use]
    pub const fn id(&self) -> PlanId {
        self.id
    }

    /// Art der Aktion.
    #[must_use]
    pub const fn kind(&self) -> ActionKind {
        self.kind
    }

    /// Betroffene Ziele (mindestens eins, ohne Duplikate).
    #[must_use]
    pub fn targets(&self) -> &[Target] {
        &self.targets
    }

    /// „Was genau?“
    #[must_use]
    pub fn what(&self) -> &str {
        &self.what
    }

    /// „Warum?“
    #[must_use]
    pub fn why(&self) -> &str {
        &self.why
    }

    /// „Was passiert dann?“
    #[must_use]
    pub fn consequence(&self) -> &str {
        &self.consequence
    }

    /// „Rückgängig wie?“
    #[must_use]
    pub const fn undo(&self) -> &UndoHint {
        &self.undo
    }

    /// Schweregrad des Anlasses.
    #[must_use]
    pub const fn severity(&self) -> RiskLevel {
        self.severity
    }

    /// Ausführungsparameter (sortiert, Teil der Prüfsumme), siehe [`param`].
    #[must_use]
    pub const fn parameters(&self) -> &BTreeMap<String, String> {
        &self.parameters
    }

    /// Einzelner Ausführungsparameter.
    #[must_use]
    pub fn parameter(&self, key: &str) -> Option<&str> {
        self.parameters.get(key).map(String::as_str)
    }

    /// Erstellungszeitpunkt (UTC).
    #[must_use]
    pub const fn created_at(&self) -> OffsetDateTime {
        self.created_at
    }

    /// Deterministische Prüfsumme über alle Felder (siehe Modul-Doku).
    #[must_use]
    pub fn digest(&self) -> PlanDigest {
        PlanDigest(canonical::sha256(&self.canonical_bytes()))
    }

    /// Kanonische Bytefolge (Version 1). Jede Änderung an diesem Format ändert alle
    /// Prüfsummen und muss bewusst als neue Version erfolgen.
    pub(crate) fn canonical_bytes(&self) -> Vec<u8> {
        let mut w = CanonicalWriter::new("AEGIS-ACTIONPLAN-V1");
        w.field("id");
        w.bytes(self.id.as_uuid().as_bytes());
        w.field("kind");
        w.str(self.kind.as_str());
        w.field("targets");
        w.len(self.targets.len());
        for target in &self.targets {
            target.encode(&mut w);
        }
        w.field("what");
        w.str(&self.what);
        w.field("why");
        w.str(&self.why);
        w.field("consequence");
        w.str(&self.consequence);
        w.field("undo");
        self.undo.encode(&mut w);
        w.field("severity");
        w.str(self.severity.as_str());
        w.field("parameters");
        w.len(self.parameters.len());
        for (key, value) in &self.parameters {
            w.str(key);
            w.str(value);
        }
        w.field("created_at");
        w.i128(self.created_at.unix_timestamp_nanos());
        w.into_bytes()
    }

    /// Prüft alle Regeln; einziger Weg, auf dem ein `ActionPlan` entsteht.
    fn validated(mut plan: Self) -> Result<Self, PlanError> {
        if plan.id.as_uuid().is_nil() {
            return Err(PlanError::InvalidPlanId);
        }
        check_text(FIELD_WHAT, &plan.what)?;
        check_text(FIELD_WHY, &plan.why)?;
        check_text(FIELD_CONSEQUENCE, &plan.consequence)?;
        check_text(FIELD_UNDO, plan.undo.text())?;
        if plan.kind.must_be_irreversible() && plan.undo.is_reversible() {
            return Err(PlanError::MustBeIrreversible { kind: plan.kind });
        }

        if plan.targets.is_empty() {
            return Err(PlanError::NoTargets);
        }
        if plan.targets.len() > MAX_TARGETS {
            return Err(PlanError::TooManyTargets { max: MAX_TARGETS });
        }
        let mut seen = BTreeSet::new();
        for (index, target) in plan.targets.iter().enumerate() {
            target
                .validate()
                .map_err(|reason| PlanError::InvalidTarget { index, reason })?;
            if !plan.kind.accepts_target(target) {
                return Err(PlanError::TargetNotAllowed {
                    kind: plan.kind,
                    index,
                });
            }
            if !seen.insert(target) {
                return Err(PlanError::DuplicateTarget { index });
            }
        }

        if plan.parameters.len() > MAX_PARAMETERS {
            return Err(PlanError::TooManyParameters {
                max: MAX_PARAMETERS,
            });
        }
        for (key, value) in &plan.parameters {
            check_parameter(key, value)?;
        }
        match plan.kind {
            ActionKind::MoveFile => {
                let destination = required_parameter(&plan, param::DESTINATION)?;
                check_path(Path::new(destination)).map_err(|reason| {
                    PlanError::InvalidParameter {
                        key: param::DESTINATION.to_owned(),
                        reason,
                    }
                })?;
            }
            ActionKind::RenameFile => {
                if plan.targets.len() != 1 {
                    return Err(PlanError::ExactlyOneTarget { kind: plan.kind });
                }
                let new_name = required_parameter(&plan, param::NEW_NAME)?;
                check_file_name(new_name).map_err(|reason| PlanError::InvalidParameter {
                    key: param::NEW_NAME.to_owned(),
                    reason,
                })?;
            }
            ActionKind::ChangeSetting => {
                required_parameter(&plan, param::VALUE)?;
                let registry = plan
                    .targets
                    .iter()
                    .any(|target| matches!(target, Target::RegistryValue { .. }));
                match plan.parameter(param::VALUE_TYPE) {
                    Some(value_type) if !param::REGISTRY_VALUE_TYPES.contains(&value_type) => {
                        return Err(PlanError::InvalidParameter {
                            key: param::VALUE_TYPE.to_owned(),
                            reason: "unbekannter Typ (erlaubt: REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ, REG_DWORD, REG_QWORD, REG_BINARY)",
                        });
                    }
                    None if registry => {
                        required_parameter(&plan, param::VALUE_TYPE)?;
                    }
                    _ => {}
                }
            }
            ActionKind::RunInSandbox => {
                if plan.targets.len() != 1 {
                    return Err(PlanError::ExactlyOneTarget { kind: plan.kind });
                }
                let invalid = |key: &str, reason| PlanError::InvalidParameter {
                    key: key.to_owned(),
                    reason,
                };
                let stage = required_parameter(&plan, param::LAB_STAGE)?;
                if !param::LAB_STAGES.contains(&stage) {
                    return Err(invalid(
                        param::LAB_STAGE,
                        "unbekannte Stufe (erlaubt: windows_sandbox, mini_sandbox)",
                    ));
                }
                let seconds = required_parameter(&plan, param::LAB_SECONDS)?;
                if !seconds.parse::<u32>().is_ok_and(|s| (5..=600).contains(&s)) {
                    return Err(invalid(
                        param::LAB_SECONDS,
                        "Beobachtungszeit 5–600 Sekunden",
                    ));
                }
                match required_parameter(&plan, param::LAB_NETWORK)? {
                    "off" => {}
                    "on" if stage == "windows_sandbox" => {}
                    "on" => {
                        return Err(invalid(
                            param::LAB_NETWORK,
                            "Netzwerk gibt es nur in der Windows Sandbox",
                        ));
                    }
                    _ => return Err(invalid(param::LAB_NETWORK, "erlaubt: off, on")),
                }
            }
            ActionKind::Restore if plan.parameter(param::DESTINATION).is_some() => {
                return Err(PlanError::InvalidParameter {
                    key: param::DESTINATION.to_owned(),
                    reason: "Wiederherstellen legt die Datei an das Ziel zurück – ein abweichender Zielordner ist nicht erlaubt",
                });
            }
            _ => {}
        }

        plan.created_at = plan
            .created_at
            .checked_to_offset(UtcOffset::UTC)
            .ok_or(PlanError::InvalidTimestamp)?;
        if !(1970..=9999).contains(&plan.created_at.year()) {
            return Err(PlanError::InvalidTimestamp);
        }
        Ok(plan)
    }
}

fn check_text(field: &'static str, value: &str) -> Result<(), PlanError> {
    if value.trim().is_empty() {
        return Err(PlanError::MissingText { field });
    }
    if value.len() > MAX_TEXT_BYTES {
        return Err(PlanError::InvalidText {
            field,
            reason: "Text ist zu lang",
        });
    }
    if value.contains('\0') {
        return Err(PlanError::InvalidText {
            field,
            reason: "Text enthält ein NUL-Zeichen",
        });
    }
    Ok(())
}

fn check_parameter(key: &str, value: &str) -> Result<(), PlanError> {
    let invalid = |reason| PlanError::InvalidParameter {
        key: key.to_owned(),
        reason,
    };
    if key.is_empty() || key.len() > MAX_PARAMETER_KEY_BYTES {
        return Err(invalid("Schlüssel ist leer oder zu lang"));
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-'))
    {
        return Err(invalid(
            "Schlüssel darf nur a–z, 0–9, „_“, „.“ und „-“ enthalten",
        ));
    }
    check_value(value, true).map_err(invalid)
}

fn required_parameter<'a>(plan: &'a ActionPlan, key: &'static str) -> Result<&'a str, PlanError> {
    plan.parameter(key).ok_or(PlanError::MissingParameter {
        kind: plan.kind,
        key,
    })
}

fn check_file_name(name: &str) -> Result<(), &'static str> {
    check_value(name, false)?;
    if name.contains(['/', '\\']) {
        return Err("Name darf keine Pfadtrenner enthalten");
    }
    if name == "." || name == ".." {
        return Err("Name darf nicht „.“ oder „..“ sein");
    }
    check_portable_name(name)?;
    // Genau ein normaler Bestandteil: Unter Windows ersetzt z. B. „D:x“ beim Anhängen den
    // ganzen Basis-Pfad – aus „umbenennen“ würde „auf ein anderes Laufwerk verschieben“.
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) if part == name => Ok(()),
        _ => Err("Name muss ein einzelner Dateiname sein"),
    }
}

/// Unicode-Steuerzeichen für die Schreibrichtung – sie können z. B. eine Endung vortäuschen
/// („rechnung\u{202e}fdp.exe“ wird als „rechnungexe.pdf“ angezeigt).
const fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

/// Unter Windows reservierte Gerätenamen – auch mit Endung („nul.txt“) oder angehängten
/// Leerzeichen („CON .txt“) sprechen sie das Gerät an statt einer Datei.
fn is_reserved_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let upper = stem.to_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let Some(rest) = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"))
    else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None)
    )
}

/// Prüft einen einzelnen Namensbestandteil (Datei- oder Ordnername) auf allen Plattformen
/// nach den Windows-Regeln: keine Steuer- oder Schreibrichtungszeichen, keine unter
/// Windows unzulässigen Zeichen (`: < > " | ? *` – `:` adressiert alternative
/// Datenströme), kein Punkt oder Leerzeichen am Ende (Win32 entfernt sie still), kein
/// reservierter Gerätename.
pub(crate) fn check_portable_name(name: &str) -> Result<(), &'static str> {
    if name.chars().any(char::is_control) {
        return Err("Name enthält Steuerzeichen");
    }
    if name.chars().any(is_bidi_control) {
        return Err(
            "Name enthält Unicode-Schreibrichtungszeichen (können die Endung verschleiern)",
        );
    }
    if name.contains([':', '<', '>', '"', '|', '?', '*']) {
        return Err("Name enthält ein unter Windows unzulässiges Zeichen (: < > \" | ? *)");
    }
    if name.ends_with(['.', ' ']) {
        return Err("Name darf nicht auf Punkt oder Leerzeichen enden");
    }
    if is_reserved_device_name(name) {
        return Err("Name ist unter Windows ein reservierter Gerätename (CON, NUL, COM1 …)");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------

/// Baut einen [`ActionPlan`] und prüft ihn in [`ActionPlanBuilder::build`].
///
/// Regeln (Auszug): „Was genau“, „Warum“, „Was passiert dann“ und der Rückgängig-Text sind
/// Pflicht und nicht leer; mindestens ein gültiges, zur Aktion passendes Ziel ohne
/// Duplikate; Risikostufe ist Pflicht; „Endgültig löschen“ und „Prozess beenden“ müssen
/// als nicht umkehrbar gekennzeichnet sein; „Datei verschieben“ braucht
/// [`param::DESTINATION`], „Datei umbenennen“ genau ein Ziel und [`param::NEW_NAME`],
/// „Einstellung ändern“ den neuen Wert [`param::VALUE`] (bei Registrierungswerten auch
/// [`param::VALUE_TYPE`]); „Wiederherstellen“ nimmt keinen [`param::DESTINATION`].
#[derive(Debug, Clone)]
#[must_use = "Ein Builder tut nichts, bis `build` aufgerufen wird"]
pub struct ActionPlanBuilder {
    id: Option<PlanId>,
    kind: ActionKind,
    targets: Vec<Target>,
    what: Option<String>,
    why: Option<String>,
    consequence: Option<String>,
    undo: Option<UndoHint>,
    severity: Option<RiskLevel>,
    parameters: BTreeMap<String, String>,
}

impl ActionPlanBuilder {
    fn new(kind: ActionKind) -> Self {
        Self {
            id: None,
            kind,
            targets: Vec::new(),
            what: None,
            why: None,
            consequence: None,
            undo: None,
            severity: None,
            parameters: BTreeMap::new(),
        }
    }

    /// Feste Plan-ID (Standard: zufällig).
    pub const fn id(mut self, id: PlanId) -> Self {
        self.id = Some(id);
        self
    }

    /// Fügt ein Ziel hinzu.
    pub fn target(mut self, target: Target) -> Self {
        self.targets.push(target);
        self
    }

    /// Fügt mehrere Ziele hinzu.
    pub fn targets(mut self, targets: impl IntoIterator<Item = Target>) -> Self {
        self.targets.extend(targets);
        self
    }

    /// „Was genau?“
    pub fn what(mut self, text: impl Into<String>) -> Self {
        self.what = Some(text.into());
        self
    }

    /// „Warum?“
    pub fn why(mut self, text: impl Into<String>) -> Self {
        self.why = Some(text.into());
        self
    }

    /// „Was passiert dann?“
    pub fn consequence(mut self, text: impl Into<String>) -> Self {
        self.consequence = Some(text.into());
        self
    }

    /// „Rückgängig wie?“
    pub fn undo(mut self, undo: UndoHint) -> Self {
        self.undo = Some(undo);
        self
    }

    /// Schweregrad.
    pub const fn severity(mut self, severity: RiskLevel) -> Self {
        self.severity = Some(severity);
        self
    }

    /// Setzt einen Ausführungsparameter (siehe [`param`]).
    pub fn parameter(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.parameters.insert(key.into(), value.into());
        self
    }

    /// Prüft alle Regeln und erzeugt den Plan. `created_at` wird nach UTC normalisiert.
    ///
    /// # Errors
    /// [`PlanError`] mit dem ersten verletzten Grund.
    pub fn build(self, created_at: OffsetDateTime) -> Result<ActionPlan, PlanError> {
        ActionPlan::validated(ActionPlan {
            id: self.id.unwrap_or_else(PlanId::new_random),
            kind: self.kind,
            targets: self.targets,
            what: self
                .what
                .ok_or(PlanError::MissingText { field: FIELD_WHAT })?,
            why: self
                .why
                .ok_or(PlanError::MissingText { field: FIELD_WHY })?,
            consequence: self.consequence.ok_or(PlanError::MissingText {
                field: FIELD_CONSEQUENCE,
            })?,
            undo: self.undo.ok_or(PlanError::MissingUndo)?,
            severity: self.severity.ok_or(PlanError::MissingSeverity)?,
            parameters: self.parameters,
            created_at,
        })
    }
}

#[cfg(test)]
mod tests;
