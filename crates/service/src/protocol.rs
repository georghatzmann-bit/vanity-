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
    /// „Vertrauen“ – nichts ausgeführt; die Vertrauensliste folgt in P3.
    Trusted { note: String },
    /// Erste Bestätigung für endgültiges Löschen erhalten – jetzt den zweiten Dialog zeigen.
    SecondConfirmationRequired {
        challenge: SecondConfirmationChallenge,
        nonce: String,
    },
    /// Fehler – es wurde nichts ausgeführt, sofern nicht anders gesagt.
    Error { code: String, message: String },
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
    let mut buf = vec![0u8; usize::try_from(len).map_err(io::Error::other)?];
    reader.read_exact(&mut buf)?;
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
