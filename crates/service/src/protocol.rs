//! Protokoll zwischen Oberfläche und Dienst: JSON-Nachrichten mit 4-Byte-Längenpräfix
//! (Little Endian), höchstens [`MAX_FRAME`] Byte.
//!
//! Antworten der Oberfläche auf einen Vorschlag tragen eine **Nonce**, die nur der Dienst
//! kennt und die nur einmal gilt. So kann eine aufgezeichnete Antwort nicht erneut gesendet
//! werden – auch nicht, wenn derselbe Plan später noch einmal vorgelegt wird.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use aegis_core::audit::ExecutionResult;
use aegis_core::consent::{ChallengeId, Decision, ProposalTicket, SecondConfirmationChallenge};
use aegis_core::plan::{ActionKind, ActionPlan, PlanDigest, PlanId};
use aegis_engine::ScanReport;
use aegis_quarantine::Entry;
use serde::{Deserialize, Serialize};

use crate::history::HistoryEntry;
use crate::schedule::{Schedule, UpdateRecord};
use crate::trust::TrustEntry;
use crate::watch::{WatchEvent, WatchStatus};

/// Protokollversion.
pub const PROTOCOL_VERSION: u32 = 1;
/// Größte erlaubte Nachricht (16 MiB).
pub const MAX_FRAME: u32 = 16 * 1024 * 1024;

/// Anfrage der Oberfläche.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Verbindungsaufbau.
    Hello { client: String, protocol: u32 },
    /// Dateien/Ordner prüfen (nur lesend).
    Scan { paths: Vec<PathBuf> },
    /// Quarantäne auflisten.
    ListQuarantine {},
    /// Isolieren vorschlagen – der Dienst prüft die Dateien selbst und formuliert den Plan.
    ProposeQuarantine { paths: Vec<PathBuf> },
    /// Wiederherstellen vorschlagen.
    ProposeRestore { entry_id: String },
    /// Endgültiges Löschen vorschlagen.
    ProposeDelete { entry_id: String },
    /// Vertrauensliste des eigenen Kontos.
    ListTrust {},
    /// Eintrag der Vertrauensliste widerrufen (macht AEGIS nur strenger – keine Rückfrage).
    RevokeTrust { id: String },
    /// Meldungen des Echtzeit-Wächters nach Nummer `after` abholen (nur lesend).
    WatchPoll { after: u64 },
    /// Gaming-Modus an/aus (keine Prüfungen und Hinweise; endet spätestens nach 4 h).
    SetGaming { on: bool },
    /// Verlauf für Berichte und Zeitleiste (nur lesend, nur eigene/gemeinsame Einträge).
    History {},
    /// Eigener Zeitplan und Update-Einstellung.
    GetSchedule {},
    /// Eigenen geplanten Scan setzen (nur prüfen und melden).
    SetSchedule {
        enabled: bool,
        every_days: u16,
        hour_utc: u8,
    },
    /// ClamAV-Signaturen täglich aktualisieren (Netzwerk) an/aus.
    SetClamavUpdate { on: bool },
    /// Labor: Zustand der Windows Sandbox und eigene Läufe (nur lesend).
    LabStatus {},
    /// Labor-Lauf vorschlagen – der Dienst prüft die Datei selbst und formuliert den Plan.
    ProposeLabRun {
        path: PathBuf,
        stage: String,
        seconds: u32,
        network: bool,
    },
    /// Bildschirmfoto eines eigenen Labor-Laufs (Stufe 1).
    LabScreenshot { run_id: String, name: String },
    /// Vollständiger Verhaltensbericht eines eigenen, fertigen Labor-Laufs.
    LabReport { run_id: String },
    /// Windows Sandbox einschalten vorschlagen (nur Administratoren; Neustart nötig).
    ProposeEnableSandbox {},
    /// Laufende Prozesse eines Programms beenden/anhalten/fortsetzen vorschlagen.
    ProposeProcessAction { program: PathBuf, action: String },
    /// Ransomware-Schutz: eigene Köderdateien (nur lesend).
    RansomStatus {},
    /// Rückfall-Kopien: Zustand und neueste Versionen (nur lesend).
    BackupStatus {},
    /// Härtung: Systemzustand lesen und bewerten (nur lesend, dauert einige Sekunden).
    /// Ohne `fresh` darf der Dienst ein bis zu 10 Minuten altes Ergebnis liefern.
    HardeningStatus {
        #[serde(default)]
        fresh: bool,
    },
    /// Einen Punkt der Härtung beheben vorschlagen (`fix`: z. B. `disable_smb1`) – nur nach „Ja“.
    ProposeHardeningFix { fix: String },
    /// Ein Beheben rückgängig machen vorschlagen – nur nach „Ja“.
    ProposeHardeningUndo { id: String },
    /// Persistenz-Check: Autostart-Einträge lesen und bewerten (nur lesend, dauert).
    PersistenceStatus {},
    /// Einen Autostart-Eintrag aus dem letzten Check deaktivieren vorschlagen – nur nach „Ja“.
    ProposeAutorunDisable { id: String },
    /// Rückfall-Kopien ein- (`on`, Grenze in MiB) bzw. ausschalten vorschlagen.
    ProposeBackup { on: bool, quota_mb: u64 },
    /// Eine Version zurückholen vorschlagen.
    ProposeBackupRestore { id: String },
    /// Neueste Versionen in einen Ordner (z. B. externes Laufwerk) exportieren vorschlagen.
    ProposeBackupExport { folder: PathBuf },
    /// Versionen älter als `days` Tage löschen vorschlagen (zweite Bestätigung).
    ProposeBackupPrune { days: u32 },
    /// Eigene Schutzordner setzen (nur Beobachtung, verändert nichts; höchstens 20).
    SetProtectedFolders { folders: Vec<PathBuf> },
    /// Köderdateien anlegen (`on`) bzw. entfernen vorschlagen.
    ProposeBaits { on: bool },
    /// Speicher-Scan der eigenen laufenden Programme (nur lesend).
    MemoryScan {},
    /// Panic-Button: Zustand (nur lesend).
    PanicStatus {},
    /// Netz trennen (`on`) bzw. wieder verbinden vorschlagen.
    ProposePanic { on: bool },
    /// Notfall-Scan (Autostarts, Downloads, Desktop, Temp, AppData, Programme + Speicher;
    /// stößt ein Signatur-Update an). Nur lesend.
    EmergencyScan {},
    /// Mehrere Quarantäne-Einträge in einem Plan wiederherstellen („Alles rückgängig“).
    ProposeRestoreMany { entry_ids: Vec<String> },
    /// Datei-Safe: Zustand und – wenn entsperrt – Einträge (nur lesend).
    SafeStatus {},
    /// Datei-Safe anlegen vorschlagen (das Passwort bleibt nur im Speicher des Dienstes).
    ProposeSafeSetup { password: Password },
    /// Datei-Safe entsperren (Schlüssel bleibt höchstens 10 min ohne Nutzung im Speicher).
    SafeUnlock { password: Password },
    /// Datei-Safe sperren (Schlüssel aus dem Speicher entfernen).
    SafeLock {},
    /// Dateien in den Safe legen vorschlagen.
    ProposeSafeStore { paths: Vec<PathBuf> },
    /// Eintrag aus dem Safe holen vorschlagen.
    ProposeSafeRetrieve { id: String },
    /// Antwort des Nutzers im Freigabe-Dialog.
    Decide {
        plan_id: PlanId,
        digest: PlanDigest,
        nonce: String,
        decision: Decision,
        dialog_id: String,
    },
    /// Antwort im zweiten Dialog vor endgültigem Löschen.
    ConfirmSecond {
        challenge_id: ChallengeId,
        nonce: String,
        decision: Decision,
        dialog_id: String,
    },
}

/// Passwort in einer Anfrage: erscheint nie in `Debug`-Ausgaben und wird beim Verwerfen
/// überschrieben.
#[derive(Clone, PartialEq, Eq)]
pub struct Password(zeroize::Zeroizing<String>);

impl Password {
    /// Neues Passwort (z. B. in Tests oder in der App).
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self(zeroize::Zeroizing::new(text.into()))
    }

    /// Der Text.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Password(***)")
    }
}

impl Serialize for Password {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Password {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        if text.len() > 1024 {
            return Err(serde::de::Error::custom("Passwort zu lang"));
        }
        Ok(Self::new(text))
    }
}

/// Ein offener Vorschlag für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct Proposal {
    /// Der vollständige Plan (Was? Warum? Was passiert dann? Rückgängig?).
    pub plan: ActionPlan,
    /// Kennung, Prüfsumme, Frist.
    pub ticket: ProposalTicket,
    /// Einmal-Nonce für die Antwort.
    pub nonce: String,
}

/// Antwort des Dienstes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Verbindungsaufbau.
    Hello { service: String, protocol: u32 },
    /// Ergebnis eines Scans.
    ScanReport { report: Box<ScanReport> },
    /// Einträge der Quarantäne.
    Quarantine { entries: Vec<Entry> },
    /// Neuer Vorschlag – die Oberfläche zeigt den Freigabe-Dialog.
    Proposal { proposal: Box<Proposal> },
    /// Ausgeführt (nach „Ja“).
    Executed {
        kind: ActionKind,
        result: ExecutionResult,
        entries: Vec<Entry>,
        failures: Vec<(PathBuf, String)>,
    },
    /// Nichts getan („Nein“ oder „Ignorieren“).
    NothingDone { decision: Decision },
    /// „Vertrauen“ – nichts ausgeführt, die Dateien stehen jetzt auf der Vertrauensliste.
    Trusted {
        note: String,
        entries: Vec<TrustEntry>,
    },
    /// Vertrauensliste.
    Trust { entries: Vec<TrustEntry> },
    /// Eintrag widerrufen.
    TrustRevoked { id: String },
    /// Verlauf, neueste zuerst.
    History {
        entries: Vec<HistoryEntry>,
        /// Konnte der Verlauf zuletzt nicht gespeichert werden?
        save_failed: bool,
    },
    /// Zeitplan und Update-Einstellung.
    Schedule {
        #[serde(flatten)]
        info: Box<ScheduleInfo>,
    },
    /// Labor.
    Lab {
        sandbox: aegis_sandbox::detect::SandboxStatus,
        /// Gibt es die Mini-Sandbox (Windows)?
        mini_available: bool,
        runs: Vec<crate::lab::LabRun>,
    },
    /// Bildschirmfoto (PNG, Base64).
    LabScreenshot { png_base64: String },
    /// Ergebnis des Speicher-Scans (Funde wie beim Scan; dazu, was geprüft wurde).
    MemoryScan {
        report: Box<aegis_engine::ScanReport>,
        processes: usize,
        modules: usize,
        regions: usize,
    },
    /// Ransomware-Schutz des Kontos.
    Ransom {
        /// Angelegte Köderdateien.
        baits: Vec<PathBuf>,
        /// Standard-Schutzordner des Profils (Dokumente, Bilder, Desktop).
        default_folders: Vec<PathBuf>,
        /// Eigene Schutzordner.
        folders: Vec<PathBuf>,
        /// Kürzlich gestartete eigene Programme (für „Einfrieren“).
        recent: Vec<PathBuf>,
        /// Windows „Überwachter Ordnerzugriff“: `on` | `off` | `audit` | `None` (unbekannt).
        controlled_folder_access: Option<String>,
    },
    /// Panic-Button: aktiv seit (RFC 3339) bzw. `None`.
    Panic {
        since: Option<String>,
        available: bool,
    },
    /// Ergebnis des Notfall-Scans je Bereich.
    EmergencyScan {
        areas: Vec<crate::emergency::EmergencyArea>,
        /// Funde im Arbeitsspeicher: Prozess + Programm (in Reihenfolge der Funde im
        /// Bereich `memory`).
        memory: Vec<crate::emergency::MemoryHit>,
        /// Stand des Signatur-Updates.
        update: String,
    },
    /// Rückfall-Kopien des Kontos.
    Backup {
        state: Box<crate::handler::backup::BackupState>,
    },
    /// Härtung & Sicherheits-Score.
    Hardening {
        state: Box<crate::handler::hardening::HardeningState>,
    },
    /// Persistenz-Check.
    Persistence {
        state: Box<crate::handler::persistence::PersistenceState>,
        /// Rückgängig machbare Schritte des Kontos.
        undo: Vec<crate::handler::harden::UndoInfo>,
    },
    /// Datei-Safe des Kontos.
    Safe {
        /// Gibt es einen Safe?
        exists: bool,
        /// Ist er gerade entsperrt?
        unlocked: bool,
        /// Einträge (nur wenn entsperrt).
        entries: Vec<aegis_quarantine::safe::SafeEntry>,
        /// Mindestlänge des Passworts.
        min_password: usize,
        /// Nach so vielen Minuten ohne Nutzung sperrt der Dienst den Safe.
        idle_minutes: u32,
    },
    /// Verhaltensbericht eines Labor-Laufs.
    LabReport {
        report: Box<aegis_sandbox::report::BehaviorReport>,
    },
    /// Meldungen und Zustand des Echtzeit-Wächters.
    Watch {
        events: Vec<WatchEvent>,
        status: WatchStatus,
        /// Restdauer des Gaming-Modus (Sekunden).
        gaming_left: Option<u64>,
    },
    /// Erste Bestätigung für endgültiges Löschen erhalten – jetzt den zweiten Dialog zeigen.
    SecondConfirmationRequired {
        challenge: SecondConfirmationChallenge,
        nonce: String,
    },
    /// Fehler – es wurde nichts ausgeführt, sofern nicht anders gesagt.
    Error { code: String, message: String },
}

/// Zeitplan des Kontos und Update-Einstellung.
#[derive(Debug, Clone, Serialize)]
pub struct ScheduleInfo {
    /// Eigener Zeitplan.
    pub schedule: Option<Schedule>,
    /// Ist ClamAV installiert?
    pub clamav_available: bool,
    /// Ist `freshclam` installiert?
    pub clamav_update_available: bool,
    /// Tägliches Signatur-Update an?
    pub clamav_update: bool,
    /// Darf das Konto rechnerweite Einstellungen ändern (erhöhter Administrator)?
    pub can_change_global: bool,
    /// Letztes Update.
    pub last_update: Option<UpdateRecord>,
}

impl Response {
    /// Fehler-Antwort.
    #[must_use]
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Self::Error {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

/// Liest eine Nachricht.
///
/// # Errors
/// Lesefehler, zu große Nachricht.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len);
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Nachricht zu groß",
        ));
    }
    // Schrittweise lesen: Eine Längenangabe allein reserviert keinen Speicher.
    let mut buf = Vec::with_capacity(usize::try_from(len.min(64 * 1024)).unwrap_or(0));
    reader.take(u64::from(len)).read_to_end(&mut buf)?;
    if buf.len() != usize::try_from(len).unwrap_or(usize::MAX) {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Nachricht unvollständig",
        ));
    }
    Ok(buf)
}

/// Schreibt eine Nachricht.
///
/// # Errors
/// Schreibfehler, zu große Nachricht.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .ok()
        .filter(|l| *l <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Nachricht zu groß"))?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rahmen_rundweg_und_grenzen() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{\"type\":\"list_quarantine\"}").unwrap();
        let payload = read_frame(&mut buf.as_slice()).unwrap();
        let req: Request = serde_json::from_slice(&payload).unwrap();
        assert_eq!(req, Request::ListQuarantine {});
        let mut huge = (MAX_FRAME + 1).to_le_bytes().to_vec();
        huge.extend_from_slice(b"x");
        assert!(read_frame(&mut huge.as_slice()).is_err());
        assert!(read_frame(&mut [1u8, 0].as_slice()).is_err());
    }

    #[test]
    fn unbekannte_felder_werden_abgelehnt() {
        let bad = r#"{"type":"list_quarantine","extra":1}"#;
        assert!(serde_json::from_str::<Request>(bad).is_err());
        let bad = r#"{"type":"execute_without_asking"}"#;
        assert!(serde_json::from_str::<Request>(bad).is_err());
    }
}
