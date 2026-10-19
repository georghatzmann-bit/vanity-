//! Prüfprotokoll: nur anhängbar, JSON Lines, mit Hash-Kette.
//!
//! Bezug zur Goldenen Regel: Jede Vorlage, Entscheidung, Ablehnung, jeder Verfall, jedes
//! Einlösen (auch jeder verweigerte Versuch) und jede Ausführung wird festgehalten.
//! Nachträgliches Ändern, Löschen, Einfügen oder Vertauschen von Zeilen wird von [`verify`]
//! erkannt.
//!
//! # Format
//!
//! Eine Zeile pro [`AuditEntry`], kanonisches JSON (feste Feldreihenfolge
//! `seq, at, event, prev_hash, hash`, keine Leerzeichen, abschließendes `\n`):
//!
//! ```text
//! hash = SHA-256( prev_hash (32 Byte roh) || kanonisches JSON des Eintrags ohne "hash" )
//! ```
//!
//! Der erste Eintrag hat `seq = 0` und `prev_hash = 000…0` ([`EntryHash::GENESIS`]).
//! Eine Zeile ist höchstens [`MAX_ENTRY_BYTES`] lang (inklusive `\n`): [`AuditLog`] schreibt
//! keine längeren, [`verify`] liest keine längeren (Schutz vor Speichererschöpfung), und
//! das Freigabe-Tor nimmt keinen Plan an, dessen Vorlage nicht hineinpasst.
//!
//! # Wiederaufnahme nach einem Absturz
//!
//! Bricht ein Schreibvorgang ab, endet die Datei mit einer unvollständigen Zeile.
//! [`verify_prefix`] prüft dann den intakten Anfang und nennt dessen Länge in Byte; der
//! Dienst schneidet den Rest ab (eine eigene, freigegebene Ausnahme) oder beginnt eine neue
//! Datei und setzt mit [`AuditLog::resume`] fort.
//!
//! # Grenzen (ehrlich)
//!
//! * **Abschneiden am Ende** lässt sich aus der Datei allein nicht erkennen: Fehlen die
//!   letzten Zeilen, ist der Rest immer noch eine gültige Kette. Dagegen hilft ein externer
//!   Anker – [`AuditLog::head_hash`] bzw. [`AuditLog::anchor`] regelmäßig an anderer Stelle
//!   speichern (z. B. Registrierung, zweite Datei, Server) und mit [`verify_with_anchor`]
//!   prüfen.
//! * Die Kette hat keinen geheimen Schlüssel. Wer die Datei schreiben kann, kann ab einer
//!   Stelle alles neu berechnen; auch das deckt nur der externe Anker auf.
//!
//! Das Modul öffnet selbst keine Dateien: [`AuditLog`] schreibt in ein beliebiges
//! [`Write`], [`verify`] liest aus einem beliebigen [`BufRead`].

use std::fmt;
use std::io::{BufRead, Read, Write};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};

use crate::canonical;
use crate::consent::{ChallengeId, Decision, DecisionOrigin};
use crate::plan::{ActionKind, PlanDigest, PlanId, Target};
use crate::risk::RiskLevel;

/// Höchstlänge einer Protokollzeile in Byte (inklusive Zeilenende): 64 MiB.
pub const MAX_ENTRY_BYTES: usize = 64 * 1024 * 1024;

/// Höchstlänge eines Ereignisses als JSON, damit die ganze Zeile (Nummer, Zeit, Hashes)
/// sicher in [`MAX_ENTRY_BYTES`] passt.
pub(crate) const MAX_EVENT_BYTES: usize = MAX_ENTRY_BYTES - 1024;

// ---------------------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------------------

/// SHA-256 eines Protokolleintrags (64 Hex-Zeichen in Kleinbuchstaben).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct EntryHash([u8; 32]);

impl EntryHash {
    /// Vorgänger des ersten Eintrags (32 Null-Bytes).
    pub const GENESIS: Self = Self([0; 32]);

    /// Hash aus rohen Bytes.
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

impl fmt::Display for EntryHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&canonical::hex_lower(&self.0))
    }
}

impl fmt::Debug for EntryHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EntryHash({self})")
    }
}

/// Fehler beim Lesen eines [`EntryHash`] aus Text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Ungültiger Protokoll-Hash (erwartet: 64 Hex-Zeichen in Kleinbuchstaben)")]
pub struct InvalidEntryHash;

impl FromStr for EntryHash {
    type Err = InvalidEntryHash;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        canonical::parse_hex32(s).map(Self).ok_or(InvalidEntryHash)
    }
}

impl From<EntryHash> for String {
    fn from(value: EntryHash) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for EntryHash {
    type Error = InvalidEntryHash;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

// ---------------------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------------------

/// Ergebnis einer Ausführung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionResult {
    /// Vollständig erfolgreich.
    Succeeded,
    /// Teilweise erfolgreich.
    PartiallySucceeded {
        /// Erklärung (deutsch).
        message: String,
    },
    /// Fehlgeschlagen (es wurde nichts oder nur Umkehrbares verändert).
    Failed {
        /// Erklärung (deutsch).
        message: String,
    },
}

impl ExecutionResult {
    /// `true` bei [`ExecutionResult::Succeeded`].
    #[must_use]
    pub const fn is_success(&self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

/// Ein protokolliertes Ereignis.
///
/// `#[must_use]`: Ein erzeugtes Ereignis (etwa aus [`crate::consent::ExecutionPermit::complete`])
/// muss ins Protokoll – stillschweigendes Verwerfen meldet der Compiler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[non_exhaustive]
#[must_use = "Ein Protokoll-Ereignis muss ins Prüfprotokoll geschrieben werden"]
pub enum AuditEvent {
    /// Plan wurde zur Entscheidung vorgelegt.
    PlanProposed {
        /// Plan.
        plan_id: PlanId,
        /// Prüfsumme.
        digest: PlanDigest,
        /// Aktion.
        kind: ActionKind,
        /// Schweregrad.
        severity: RiskLevel,
        /// „Was genau?“
        what: String,
        /// Ziele.
        targets: Vec<Target>,
        /// Fristende.
        #[serde(with = "time::serde::rfc3339")]
        expires_at: OffsetDateTime,
    },
    /// Gültige Entscheidung erfasst (jede der vier Antworten).
    DecisionRecorded {
        /// Plan.
        plan_id: PlanId,
        /// Prüfsumme.
        digest: PlanDigest,
        /// Antwort.
        decision: Decision,
        /// Herkunft.
        origin: DecisionOrigin,
    },
    /// Antwort verworfen (falsche Prüfsumme, ungültige Herkunft, unbekannter, abgelaufener
    /// oder schon beantworteter Plan …) – nichts geschieht; ein vorgelegter Plan ist verbraucht.
    DecisionRejected {
        /// Plan.
        plan_id: PlanId,
        /// Grund (deutsch).
        reason: String,
    },
    /// Plan ohne (rechtzeitige) Antwort verfallen – auch verdrängt oder beim Beenden des
    /// Tors – nichts geschieht.
    PlanExpired {
        /// Plan.
        plan_id: PlanId,
    },
    /// Zweite Bestätigung (endgültiges Löschen) angefordert.
    SecondConfirmationRequested {
        /// Plan.
        plan_id: PlanId,
        /// Rückfrage.
        challenge_id: ChallengeId,
        /// Frühester Zeitpunkt.
        #[serde(with = "time::serde::rfc3339")]
        not_before: OffsetDateTime,
        /// Fristende.
        #[serde(with = "time::serde::rfc3339")]
        expires_at: OffsetDateTime,
    },
    /// Antwort auf die zweite Rückfrage erfasst.
    SecondConfirmationRecorded {
        /// Plan.
        plan_id: PlanId,
        /// Rückfrage.
        challenge_id: ChallengeId,
        /// Antwort.
        decision: Decision,
        /// Herkunft.
        origin: DecisionOrigin,
    },
    /// Antwort auf die zweite Rückfrage verworfen (zu früh, zu spät, falsche Freigabe …).
    SecondConfirmationRejected {
        /// Plan.
        plan_id: PlanId,
        /// Rückfrage.
        challenge_id: ChallengeId,
        /// Grund (deutsch).
        reason: String,
    },
    /// Zweite Rückfrage ohne Antwort verfallen – nichts wird gelöscht.
    SecondConfirmationExpired {
        /// Plan.
        plan_id: PlanId,
        /// Rückfrage.
        challenge_id: ChallengeId,
    },
    /// Freigabe eingelöst: Die Ausführungserlaubnis wurde ausgestellt. Danach muss ein
    /// [`AuditEvent::ActionExecuted`] folgen – fehlt es, ist die Ausführung nicht
    /// abgeschlossen protokolliert worden.
    PermitIssued {
        /// Plan.
        plan_id: PlanId,
        /// Prüfsumme.
        digest: PlanDigest,
        /// Aktion.
        kind: ActionKind,
    },
    /// Einlösen einer Freigabe verweigert (anderer oder veränderter Plan, abgelaufen,
    /// fremdes Tor …) – nichts geschieht, die Freigabe ist verbraucht.
    RedeemRejected {
        /// Plan der Freigabe.
        plan_id: PlanId,
        /// Grund (deutsch).
        reason: String,
    },
    /// Freigabe nicht (rechtzeitig) eingelöst und verfallen – nichts geschieht.
    ApprovalExpired {
        /// Plan.
        plan_id: PlanId,
    },
    /// Freigegebene Aktion ausgeführt.
    ActionExecuted {
        /// Plan.
        plan_id: PlanId,
        /// Prüfsumme.
        digest: PlanDigest,
        /// Aktion.
        kind: ActionKind,
        /// Ergebnis.
        result: ExecutionResult,
    },
    /// Eine frühere Aktion wurde (über einen eigenen, bestätigten Plan) rückgängig gemacht.
    ActionUndone {
        /// Ursprünglicher Plan.
        plan_id: PlanId,
        /// Plan, der das Rückgängigmachen ausgeführt hat.
        undo_plan_id: PlanId,
        /// Ergebnis.
        result: ExecutionResult,
    },
}

impl AuditEvent {
    /// Betroffener Plan.
    #[must_use]
    pub const fn plan_id(&self) -> PlanId {
        match self {
            Self::PlanProposed { plan_id, .. }
            | Self::DecisionRecorded { plan_id, .. }
            | Self::DecisionRejected { plan_id, .. }
            | Self::PlanExpired { plan_id }
            | Self::SecondConfirmationRequested { plan_id, .. }
            | Self::SecondConfirmationRecorded { plan_id, .. }
            | Self::SecondConfirmationRejected { plan_id, .. }
            | Self::SecondConfirmationExpired { plan_id, .. }
            | Self::PermitIssued { plan_id, .. }
            | Self::RedeemRejected { plan_id, .. }
            | Self::ApprovalExpired { plan_id }
            | Self::ActionExecuted { plan_id, .. }
            | Self::ActionUndone { plan_id, .. } => *plan_id,
        }
    }
}

/// Passt das Ereignis (als JSON) sicher in eine Protokollzeile? `false` auch, wenn es sich
/// gar nicht darstellen lässt.
pub(crate) fn fits_in_log(event: &AuditEvent) -> bool {
    matches!(check_event_size(event), Ok(true))
}

/// `Ok(false)`: zu groß; `Err`: nicht als JSON darstellbar. Bricht beim Überschreiten der
/// Grenze ab, ohne das ganze Ereignis aufzubereiten.
fn check_event_size(event: &AuditEvent) -> Result<bool, serde_json::Error> {
    /// Zählt Bytes und bricht ab, sobald die Grenze überschritten ist.
    struct Budget(usize);
    impl Write for Budget {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(buf.len())
                .ok_or_else(|| std::io::Error::other("zu groß"))?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    match serde_json::to_writer(Budget(MAX_EVENT_BYTES), event) {
        Ok(()) => Ok(true),
        // Der einzige E/A-Fehler hier ist das erschöpfte Budget.
        Err(err) if err.is_io() => Ok(false),
        Err(err) => Err(err),
    }
}

/// Ereignis mit Zeitpunkt, wie es [`crate::consent::ConsentGate::take_audit_events`] liefert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedEvent {
    /// Zeitpunkt.
    pub at: OffsetDateTime,
    /// Ereignis.
    pub event: AuditEvent,
}

// ---------------------------------------------------------------------------------------
// Eintrag
// ---------------------------------------------------------------------------------------

/// Eine Zeile des Prüfprotokolls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditEntry {
    /// Laufende Nummer ab 0, lückenlos.
    pub seq: u64,
    /// Zeitpunkt (UTC).
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Ereignis.
    pub event: AuditEvent,
    /// Hash des vorherigen Eintrags ([`EntryHash::GENESIS`] beim ersten).
    pub prev_hash: EntryHash,
    /// Hash dieses Eintrags (siehe Modul-Doku).
    pub hash: EntryHash,
}

/// Eintrag ohne `hash` – Grundlage der Hash-Berechnung. Feldreihenfolge wie [`AuditEntry`].
#[derive(Serialize)]
struct EntryBody<'a> {
    seq: u64,
    #[serde(with = "time::serde::rfc3339")]
    at: OffsetDateTime,
    event: &'a AuditEvent,
    prev_hash: EntryHash,
}

impl AuditEntry {
    /// Berechnet den Hash aus `prev_hash` und dem kanonischen JSON ohne `hash`.
    ///
    /// # Errors
    /// [`AuditError::Serialize`], wenn der Eintrag nicht darstellbar ist.
    pub fn compute_hash(&self) -> Result<EntryHash, AuditError> {
        let body = serde_json::to_vec(&EntryBody {
            seq: self.seq,
            at: self.at,
            event: &self.event,
            prev_hash: self.prev_hash,
        })?;
        Ok(EntryHash(canonical::sha256_parts(&[
            self.prev_hash.as_bytes(),
            &body,
        ])))
    }
}

/// Externer Anker: Nummer und Hash eines Eintrags, getrennt vom Protokoll aufbewahrt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditAnchor {
    /// Laufende Nummer.
    pub seq: u64,
    /// Hash des Eintrags.
    pub hash: EntryHash,
}

// ---------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------

/// Was bei der Prüfung einer Zeile nicht stimmt.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum VerifyProblem {
    /// Letzte Zeile ohne Zeilenende (Schreibvorgang abgebrochen?).
    IncompleteLine,
    /// Zeile länger als [`MAX_ENTRY_BYTES`] (beschädigt oder manipuliert).
    LineTooLong,
    /// Kein gültiges UTF-8.
    InvalidUtf8,
    /// Leere Zeile.
    EmptyLine,
    /// Kein lesbarer Eintrag.
    Malformed(String),
    /// Zeile weicht von der kanonischen Darstellung ab.
    NonCanonical,
    /// Laufende Nummer passt nicht (Zeile gelöscht, eingefügt oder vertauscht).
    SequenceMismatch {
        /// Erwartet.
        expected: u64,
        /// Gefunden.
        found: u64,
    },
    /// Verweis auf den Vorgänger passt nicht.
    PrevHashMismatch,
    /// Hash passt nicht zum Inhalt (Zeile verändert).
    HashMismatch,
}

impl fmt::Display for VerifyProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IncompleteLine => f.write_str("Zeile ist unvollständig (kein Zeilenende)"),
            Self::LineTooLong => f.write_str("Zeile ist länger als erlaubt"),
            Self::InvalidUtf8 => f.write_str("Zeile ist kein gültiges UTF-8"),
            Self::EmptyLine => f.write_str("leere Zeile"),
            Self::Malformed(detail) => write!(f, "Eintrag nicht lesbar ({detail})"),
            Self::NonCanonical => f.write_str("Zeile weicht von der kanonischen Form ab"),
            Self::SequenceMismatch { expected, found } => write!(
                f,
                "laufende Nummer {found} statt {expected} (Zeile gelöscht, eingefügt oder vertauscht)"
            ),
            Self::PrevHashMismatch => f.write_str("Verweis auf den vorherigen Eintrag passt nicht"),
            Self::HashMismatch => f.write_str("Hash passt nicht zum Inhalt (Eintrag verändert)"),
        }
    }
}

/// Fehler des Prüfprotokolls.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum AuditError {
    /// Lesen/Schreiben fehlgeschlagen.
    #[error("Ein-/Ausgabefehler im Prüfprotokoll: {0}")]
    Io(#[from] std::io::Error),
    /// Eintrag nicht als JSON darstellbar.
    #[error("Eintrag für das Prüfprotokoll konnte nicht serialisiert werden: {0}")]
    Serialize(#[from] serde_json::Error),
    /// Nach einem Schreibfehler werden keine weiteren Einträge angenommen.
    #[error("Prüfprotokoll nach einem Schreibfehler gesperrt – bitte prüfen und neu öffnen")]
    Poisoned,
    /// Zeitpunkt nicht in UTC/RFC 3339 darstellbar.
    #[error("Zeitpunkt des Eintrags ist ungültig")]
    InvalidTimestamp,
    /// Laufende Nummer erschöpft.
    #[error("Laufende Nummer des Prüfprotokolls erschöpft")]
    SequenceOverflow,
    /// Eintrag länger als [`MAX_ENTRY_BYTES`] – nicht geschrieben (das Protokoll bleibt nutzbar).
    #[error(
        "Eintrag für das Prüfprotokoll ist zu groß (höchstens {limit} Byte) – nicht geschrieben"
    )]
    EntryTooLarge {
        /// Höchstlänge einer Zeile in Byte.
        limit: usize,
    },
    /// Protokoll beschädigt oder manipuliert.
    #[error("Prüfprotokoll beschädigt oder manipuliert (Zeile {line}): {problem}")]
    Verify {
        /// Zeilennummer ab 1.
        line: u64,
        /// Befund.
        problem: VerifyProblem,
    },
    /// Externer Anker fehlt – das Protokoll wurde vermutlich gekürzt.
    #[error(
        "Anker (Eintrag {seq}) fehlt im Prüfprotokoll – das Protokoll wurde vermutlich gekürzt"
    )]
    AnchorNotFound {
        /// Laufende Nummer des Ankers.
        seq: u64,
    },
    /// Externer Anker passt nicht – das Protokoll wurde verändert.
    #[error("Anker (Eintrag {seq}) passt nicht – das Protokoll wurde verändert")]
    AnchorMismatch {
        /// Laufende Nummer des Ankers.
        seq: u64,
    },
}

// ---------------------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------------------

/// Schreibt Einträge an ein [`Write`] an (eine Zeile pro Eintrag, nach jedem Eintrag
/// `flush`). Dauerhaftes Sichern (`fsync`) ist Sache des Aufrufers.
///
/// Schlägt ein Schreibvorgang fehl, ist der Zustand der Datei unklar (evtl. halbe Zeile);
/// das Protokoll nimmt dann keine weiteren Einträge an ([`AuditError::Poisoned`]).
#[derive(Debug)]
pub struct AuditLog<W: Write> {
    writer: W,
    next_seq: u64,
    head: EntryHash,
    last: Option<AuditAnchor>,
    poisoned: bool,
}

impl<W: Write> AuditLog<W> {
    /// Neues, leeres Protokoll.
    pub const fn new(writer: W) -> Self {
        Self {
            writer,
            next_seq: 0,
            head: EntryHash::GENESIS,
            last: None,
            poisoned: false,
        }
    }

    /// Setzt ein bestehendes Protokoll fort. `report` stammt aus [`verify`] über genau die
    /// Datei, an die `writer` anhängt.
    pub const fn resume(writer: W, report: &VerifyReport) -> Self {
        Self {
            writer,
            next_seq: report.entries,
            head: report.head_hash(),
            last: report.last,
            poisoned: false,
        }
    }

    /// Hängt ein Ereignis an und liefert den geschriebenen Eintrag.
    ///
    /// # Errors
    /// [`AuditError::Poisoned`], [`AuditError::InvalidTimestamp`],
    /// [`AuditError::SequenceOverflow`], [`AuditError::Serialize`],
    /// [`AuditError::EntryTooLarge`], [`AuditError::Io`].
    pub fn append(
        &mut self,
        at: OffsetDateTime,
        event: AuditEvent,
    ) -> Result<AuditEntry, AuditError> {
        if self.poisoned {
            return Err(AuditError::Poisoned);
        }
        // Vor jeder weiteren Arbeit (Hash, Puffer): Ein zu großes Ereignis wird gar nicht erst
        // aufbereitet. Mit dem Rest der Zeile (unter 1 KiB) bleibt sie unter MAX_ENTRY_BYTES.
        if !check_event_size(&event)? {
            return Err(AuditError::EntryTooLarge {
                limit: MAX_ENTRY_BYTES,
            });
        }
        let at = at
            .checked_to_offset(UtcOffset::UTC)
            .ok_or(AuditError::InvalidTimestamp)?;
        let following_seq = self
            .next_seq
            .checked_add(1)
            .ok_or(AuditError::SequenceOverflow)?;
        let mut entry = AuditEntry {
            seq: self.next_seq,
            at,
            event,
            prev_hash: self.head,
            hash: EntryHash::GENESIS,
        };
        entry.hash = entry.compute_hash()?;
        let mut line = serde_json::to_vec(&entry)?;
        line.push(b'\n');
        if let Err(err) = self
            .writer
            .write_all(&line)
            .and_then(|()| self.writer.flush())
        {
            self.poisoned = true;
            return Err(AuditError::Io(err));
        }
        self.next_seq = following_seq;
        self.head = entry.hash;
        self.last = Some(AuditAnchor {
            seq: entry.seq,
            hash: entry.hash,
        });
        Ok(entry)
    }

    /// Hängt die Ereignisse der Reihe nach an (z. B. aus
    /// [`crate::consent::ConsentGate::take_audit_events`]) und entfernt jedes erst, nachdem es
    /// geschrieben wurde. Schlägt ein Eintrag fehl, bleiben er und alle folgenden in `events`
    /// – nichts geht verloren; der Dienst kann sie z. B. in eine neue Protokolldatei schreiben.
    ///
    /// ```
    /// # use aegis_core::audit::{AuditEvent, AuditLog, TimedEvent};
    /// # use aegis_core::plan::PlanId;
    /// # let at = aegis_core::time::OffsetDateTime::UNIX_EPOCH;
    /// let mut events = vec![TimedEvent { at, event: AuditEvent::PlanExpired { plan_id: PlanId::new_random() } }];
    /// let mut log = AuditLog::new(Vec::new());
    /// log.append_all(&mut events)?;
    /// assert!(events.is_empty());
    /// # Ok::<(), aegis_core::audit::AuditError>(())
    /// ```
    ///
    /// # Errors
    /// Wie [`AuditLog::append`]; bricht beim ersten Fehler ab.
    pub fn append_all(&mut self, events: &mut Vec<TimedEvent>) -> Result<(), AuditError> {
        let mut written = 0;
        let mut result = Ok(());
        for timed in events.iter() {
            if let Err(err) = self.append(timed.at, timed.event.clone()) {
                result = Err(err);
                break;
            }
            written += 1;
        }
        events.drain(..written);
        result
    }

    /// Hash des letzten Eintrags ([`EntryHash::GENESIS`], wenn leer) – als externer Anker
    /// gegen Abschneiden am Ende regelmäßig getrennt speichern.
    pub const fn head_hash(&self) -> EntryHash {
        self.head
    }

    /// Anker des letzten Eintrags (`None`, wenn leer).
    pub const fn anchor(&self) -> Option<AuditAnchor> {
        self.last
    }

    /// Nummer des nächsten Eintrags.
    pub const fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// `true` nach einem Schreibfehler.
    pub const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Zugriff auf das Ziel (nur lesend).
    pub const fn get_ref(&self) -> &W {
        &self.writer
    }

    /// Gibt das Ziel zurück.
    pub fn into_inner(self) -> W {
        self.writer
    }
}

// ---------------------------------------------------------------------------------------
// Prüfen
// ---------------------------------------------------------------------------------------

/// Ergebnis einer erfolgreichen Prüfung.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifyReport {
    entries: u64,
    last: Option<AuditAnchor>,
}

/// Ergebnis von [`verify_prefix`]: der geprüfte, intakte Anfang des Protokolls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefixReport {
    report: VerifyReport,
    valid_len: u64,
    torn_tail_len: u64,
}

impl PrefixReport {
    /// Prüfergebnis für den intakten Anfang (für [`AuditLog::resume`]).
    #[must_use]
    pub const fn report(&self) -> &VerifyReport {
        &self.report
    }

    /// Länge des intakten Anfangs in Byte – hier wird abgeschnitten bzw. fortgesetzt.
    #[must_use]
    pub const fn valid_len(&self) -> u64 {
        self.valid_len
    }

    /// Länge der abgebrochenen letzten Zeile in Byte (0 = Datei endet sauber).
    #[must_use]
    pub const fn torn_tail_len(&self) -> u64 {
        self.torn_tail_len
    }
}

impl VerifyReport {
    /// Anzahl geprüfter Einträge.
    #[must_use]
    pub const fn entries(&self) -> u64 {
        self.entries
    }

    /// Hash des letzten Eintrags ([`EntryHash::GENESIS`], wenn leer).
    #[must_use]
    pub const fn head_hash(&self) -> EntryHash {
        match self.last {
            Some(anchor) => anchor.hash,
            None => EntryHash::GENESIS,
        }
    }

    /// Anker des letzten Eintrags (`None`, wenn leer).
    #[must_use]
    pub const fn last(&self) -> Option<AuditAnchor> {
        self.last
    }
}

/// Prüft ein vollständiges Protokoll von Anfang an.
///
/// Erkennt veränderte, gelöschte, eingefügte und vertauschte Zeilen sowie eine
/// unvollständige letzte Zeile. Abschneiden ganzer Zeilen am Ende erkennt nur
/// [`verify_with_anchor`].
///
/// # Errors
/// [`AuditError::Verify`] mit Zeilennummer und Befund, [`AuditError::Io`].
pub fn verify<R: BufRead>(reader: R) -> Result<VerifyReport, AuditError> {
    verify_impl(reader, None, false).map(|prefix| prefix.report)
}

/// Wie [`verify`], verlangt zusätzlich, dass der extern gespeicherte `anchor` (Nummer und
/// Hash) im Protokoll vorkommt – so fällt auch Abschneiden am Ende auf.
///
/// # Errors
/// Wie [`verify`], dazu [`AuditError::AnchorNotFound`] und [`AuditError::AnchorMismatch`].
pub fn verify_with_anchor<R: BufRead>(
    reader: R,
    anchor: &AuditAnchor,
) -> Result<VerifyReport, AuditError> {
    verify_impl(reader, Some(anchor), false).map(|prefix| prefix.report)
}

/// Wie [`verify`] (bzw. mit `anchor` wie [`verify_with_anchor`]), aber eine unvollständige
/// **letzte** Zeile – typisch nach einem Absturz mitten im Schreiben – ist kein Fehler:
/// Geliefert werden der Prüfbericht des intakten Anfangs und dessen Länge in Byte, damit der
/// Dienst den Rest abschneiden oder eine neue Datei beginnen und fortsetzen kann. Jeder
/// andere Befund bleibt ein Fehler. Ein Anker muss im intakten Anfang liegen.
///
/// # Errors
/// Wie [`verify_with_anchor`].
pub fn verify_prefix<R: BufRead>(
    reader: R,
    anchor: Option<&AuditAnchor>,
) -> Result<PrefixReport, AuditError> {
    verify_impl(reader, anchor, true)
}

fn verify_impl<R: BufRead>(
    mut reader: R,
    anchor: Option<&AuditAnchor>,
    allow_torn_tail: bool,
) -> Result<PrefixReport, AuditError> {
    // Eine Zeile darf (mit Zeilenende) höchstens MAX_ENTRY_BYTES lang sein; gelesen wird
    // ein Byte mehr, um Überlänge zu erkennen, ohne beliebig viel Speicher zu belegen.
    let read_limit = u64::try_from(MAX_ENTRY_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut expected_seq: u64 = 0;
    let mut prev = EntryHash::GENESIS;
    let mut last = None;
    let mut anchor_seen = false;
    let mut line_no: u64 = 0;
    let mut valid_len: u64 = 0;
    let mut torn_tail_len: u64 = 0;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let read = (&mut reader).take(read_limit).read_until(b'\n', &mut buf)?;
        if read == 0 {
            break;
        }
        line_no = line_no.saturating_add(1);
        let fail = |problem| AuditError::Verify {
            line: line_no,
            problem,
        };
        if buf.last() != Some(&b'\n') {
            if buf.len() > MAX_ENTRY_BYTES {
                return Err(fail(VerifyProblem::LineTooLong));
            }
            if allow_torn_tail {
                torn_tail_len = u64::try_from(buf.len()).unwrap_or(u64::MAX);
                break;
            }
            return Err(fail(VerifyProblem::IncompleteLine));
        }
        let line_len = u64::try_from(buf.len()).unwrap_or(u64::MAX);
        buf.pop();
        let text = std::str::from_utf8(&buf).map_err(|_| fail(VerifyProblem::InvalidUtf8))?;
        if text.is_empty() {
            return Err(fail(VerifyProblem::EmptyLine));
        }
        let entry: AuditEntry = serde_json::from_str(text)
            .map_err(|err| fail(VerifyProblem::Malformed(err.to_string())))?;
        if serde_json::to_vec(&entry)? != buf {
            return Err(fail(VerifyProblem::NonCanonical));
        }
        if entry.seq != expected_seq {
            return Err(fail(VerifyProblem::SequenceMismatch {
                expected: expected_seq,
                found: entry.seq,
            }));
        }
        if entry.prev_hash != prev {
            return Err(fail(VerifyProblem::PrevHashMismatch));
        }
        if entry.compute_hash()? != entry.hash {
            return Err(fail(VerifyProblem::HashMismatch));
        }
        if let Some(anchor) = anchor
            && anchor.seq == entry.seq
        {
            if anchor.hash != entry.hash {
                return Err(AuditError::AnchorMismatch { seq: anchor.seq });
            }
            anchor_seen = true;
        }
        prev = entry.hash;
        last = Some(AuditAnchor {
            seq: entry.seq,
            hash: entry.hash,
        });
        expected_seq = expected_seq
            .checked_add(1)
            .ok_or(AuditError::SequenceOverflow)?;
        valid_len = valid_len.saturating_add(line_len);
    }
    if let Some(anchor) = anchor
        && !anchor_seen
    {
        return Err(AuditError::AnchorNotFound { seq: anchor.seq });
    }
    Ok(PrefixReport {
        report: VerifyReport {
            entries: expected_seq,
            last,
        },
        valid_len,
        torn_tail_len,
    })
}

#[cfg(test)]
mod tests;
