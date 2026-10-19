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
