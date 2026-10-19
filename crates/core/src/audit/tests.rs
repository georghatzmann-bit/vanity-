use std::io::{self, BufReader, Cursor};

use time::Duration;
use time::macros::datetime;
use uuid::Uuid;

use super::*;
use crate::consent::{Clock, ConsentConfig, ConsentGate, Outcome};
use crate::testing::{ManualClock, sample_plan, test_path};

const T0: OffsetDateTime = datetime!(2026-10-19 08:00:00.5 UTC);

fn pid(n: u128) -> PlanId {
    PlanId::from_uuid(Uuid::from_u128(n))
}

fn digest(n: u8) -> PlanDigest {
    PlanDigest::from_bytes([n; 32])
}

fn challenge() -> ChallengeId {
    serde_json::from_str("\"6f1c2b9e-0d4a-4f5e-9b7c-2a3d4e5f6a7b\"").unwrap()
}

/// Je ein Beispiel für jede Ereignisart.
fn all_events() -> Vec<AuditEvent> {
    vec![
        AuditEvent::PlanProposed {
            plan_id: pid(1),
            digest: digest(1),
            kind: ActionKind::Quarantine,
            severity: RiskLevel::Dangerous,
            what: "Datei „x.exe“ in Quarantäne verschieben".into(),
            targets: vec![Target::file(test_path("x.exe"))],
            expires_at: T0 + Duration::minutes(10),
        },
        AuditEvent::DecisionRecorded {
            plan_id: pid(1),
            digest: digest(1),
            decision: Decision::Execute,
            origin: DecisionOrigin::ui_dialog("dlg-1"),
        },
        AuditEvent::DecisionRejected {
            plan_id: pid(2),
            reason: "Prüfsumme passt nicht".into(),
        },
        AuditEvent::PlanExpired { plan_id: pid(3) },
        AuditEvent::SecondConfirmationRequested {
            plan_id: pid(4),
            challenge_id: challenge(),
            not_before: T0 + Duration::milliseconds(1500),
            expires_at: T0 + Duration::minutes(2),
        },
        AuditEvent::SecondConfirmationRecorded {
            plan_id: pid(4),
            challenge_id: challenge(),
            decision: Decision::Decline,
            origin: DecisionOrigin::ui_dialog("dlg-2"),
        },
        AuditEvent::SecondConfirmationRejected {
            plan_id: pid(4),
            challenge_id: challenge(),
            reason: "zu früh".into(),
        },
        AuditEvent::SecondConfirmationExpired {
            plan_id: pid(4),
            challenge_id: challenge(),
        },
        AuditEvent::ActionExecuted {
            plan_id: pid(1),
            digest: digest(1),
            kind: ActionKind::Quarantine,
            result: ExecutionResult::Succeeded,
        },
        AuditEvent::ActionUndone {
            plan_id: pid(1),
            undo_plan_id: pid(5),
            result: ExecutionResult::PartiallySucceeded {
                message: "eine Datei fehlte".into(),
            },
        },
        AuditEvent::ActionExecuted {
            plan_id: pid(6),
            digest: digest(6),
            kind: ActionKind::TerminateProcess,
            result: ExecutionResult::Failed {
                message: "Zugriff verweigert".into(),
            },
        },
    ]
}

fn sample_log() -> (Vec<u8>, AuditLog<Vec<u8>>) {
    let mut log = AuditLog::new(Vec::new());
    for (i, event) in all_events().into_iter().enumerate() {
        let at = T0 + Duration::seconds(i64::try_from(i).unwrap());
        log.append(at, event).unwrap();
    }
    (log.get_ref().clone(), log)
}

fn lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn join(lines: &[String]) -> Vec<u8> {
    let mut out = String::new();
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    out.into_bytes()
}

fn verify_bytes(bytes: &[u8]) -> Result<VerifyReport, AuditError> {
    verify(Cursor::new(bytes))
}

fn problem_at(bytes: &[u8]) -> (u64, VerifyProblem) {
    match verify_bytes(bytes) {
        Err(AuditError::Verify { line, problem }) => (line, problem),
        other => panic!("Verify-Fehler erwartet, erhalten: {other:?}"),
    }
}

#[test]
fn empty_log_verifies() {
    let report = verify_bytes(b"").unwrap();
    assert_eq!(report.entries(), 0);
    assert_eq!(report.head_hash(), EntryHash::GENESIS);
    assert_eq!(report.last(), None);
    let log = AuditLog::new(Vec::<u8>::new());
    assert_eq!(log.head_hash(), EntryHash::GENESIS);
    assert_eq!(log.anchor(), None);
    assert_eq!(log.next_seq(), 0);
}

#[test]
fn valid_chain_verifies() {
    let (bytes, log) = sample_log();
    let report = verify_bytes(&bytes).unwrap();
    let count = u64::try_from(all_events().len()).unwrap();
    assert_eq!(report.entries(), count);
    assert_eq!(report.head_hash(), log.head_hash());
    assert_eq!(report.last(), log.anchor());
    assert_eq!(log.next_seq(), count);
    assert!(!log.is_poisoned());
    assert_eq!(log.into_inner(), bytes);
}

#[test]
fn lines_are_canonical_and_hash_matches_formula() {
    let (bytes, _) = sample_log();
    let mut prev = EntryHash::GENESIS;
    for (index, line) in lines(&bytes).iter().enumerate() {
        let entry: AuditEntry = serde_json::from_str(line).unwrap();
        assert_eq!(entry.seq, u64::try_from(index).unwrap());
        assert_eq!(entry.prev_hash, prev);
        assert_eq!(entry.at.offset(), UtcOffset::UTC);
        assert_eq!(&serde_json::to_string(&entry).unwrap(), line);
        // hash = SHA-256(prev_hash || JSON ohne "hash")
        let suffix = format!(",\"hash\":\"{}\"}}", entry.hash);
        let body = format!("{}}}", line.strip_suffix(&suffix).unwrap());
        assert_eq!(
            entry.hash.as_bytes(),
            &canonical::sha256_parts(&[prev.as_bytes(), body.as_bytes()])
        );
        assert_eq!(entry.compute_hash().unwrap(), entry.hash);
        prev = entry.hash;
    }
    let first = lines(&bytes).remove(0);
    assert!(
        first.starts_with(
            r#"{"seq":0,"at":"2026-10-19T08:00:00.5Z","event":{"type":"plan_proposed""#
        )
    );
}

#[test]
fn modified_field_is_detected() {
    let (bytes, _) = sample_log();
    let mut tampered = lines(&bytes);
    tampered[1] = tampered[1].replace("\"execute\"", "\"decline\"");
    assert_eq!(
        problem_at(&join(&tampered)),
        (2, VerifyProblem::HashMismatch)
    );

    let mut tampered = lines(&bytes);
    tampered[0] = tampered[0].replace("x.exe", "y.exe");
    assert_eq!(
        problem_at(&join(&tampered)),
        (1, VerifyProblem::HashMismatch)
    );

    let mut tampered = lines(&bytes);
    tampered[3] = tampered[3].replace("08:00:03.5Z", "08:00:04.5Z");
    assert_eq!(
        problem_at(&join(&tampered)),
        (4, VerifyProblem::HashMismatch)
    );
}

#[test]
fn reformatted_line_is_detected() {
    let (bytes, _) = sample_log();
    let mut tampered = lines(&bytes);
    tampered[2] = tampered[2].replacen("{\"seq\":2", "{ \"seq\":2", 1);
    assert_eq!(
        problem_at(&join(&tampered)),
        (3, VerifyProblem::NonCanonical)
    );
}

#[test]
fn deleted_line_is_detected() {
    let (bytes, _) = sample_log();
    let mut tampered = lines(&bytes);
    tampered.remove(4);
    assert_eq!(
        problem_at(&join(&tampered)),
        (
            5,
            VerifyProblem::SequenceMismatch {
                expected: 4,
                found: 5
            }
        )
    );
    let mut tampered = lines(&bytes);
    tampered.remove(0);
    assert_eq!(
        problem_at(&join(&tampered)),
        (
            1,
            VerifyProblem::SequenceMismatch {
                expected: 0,
                found: 1
            }
        )
    );
}

#[test]
fn inserted_line_is_detected() {
    let (bytes, _) = sample_log();
    // Kopie einer vorhandenen Zeile einschieben.
    let mut tampered = lines(&bytes);
    let copy = tampered[2].clone();
    tampered.insert(3, copy);
    assert_eq!(
        problem_at(&join(&tampered)),
        (
            4,
            VerifyProblem::SequenceMismatch {
                expected: 3,
                found: 2
            }
        )
    );

    // Gefälschte Zeile mit passender Nummer, aber aus einer anderen Kette.
    let mut forged_log = AuditLog::new(Vec::new());
    for i in 0..4 {
        forged_log
            .append(
                T0,
                AuditEvent::PlanExpired {
                    plan_id: pid(100 + i),
                },
            )
            .unwrap();
    }
    let forged = lines(forged_log.get_ref())[3].clone();
    let mut tampered = lines(&bytes);
    tampered.insert(3, forged);
    assert_eq!(
        problem_at(&join(&tampered)),
        (4, VerifyProblem::PrevHashMismatch)
    );
}

#[test]
fn swapped_lines_are_detected() {
    let (bytes, _) = sample_log();
    let mut tampered = lines(&bytes);
    tampered.swap(5, 6);
    assert_eq!(
        problem_at(&join(&tampered)),
        (
            6,
            VerifyProblem::SequenceMismatch {
                expected: 5,
                found: 6
            }
        )
    );
}

#[test]
fn renumbered_lines_are_detected() {
    // Angreifer löscht eine Zeile und nummeriert neu, ohne die Hashes neu zu berechnen.
    let (bytes, _) = sample_log();
    let mut tampered = lines(&bytes);
    tampered.remove(2);
    for (index, line) in tampered.iter_mut().enumerate().skip(2) {
        let mut entry: AuditEntry = serde_json::from_str(line).unwrap();
        entry.seq = u64::try_from(index).unwrap();
        *line = serde_json::to_string(&entry).unwrap();
    }
    assert_eq!(
        problem_at(&join(&tampered)),
        (3, VerifyProblem::PrevHashMismatch)
    );
}

#[test]
fn tail_truncation_needs_external_anchor() {
    let (bytes, log) = sample_log();
    let anchor = log.anchor().unwrap();
    let mut truncated = lines(&bytes);
    truncated.truncate(5);
    let truncated = join(&truncated);
    // Ehrliche Grenze: ohne Anker ist das gekürzte Protokoll eine gültige Kette …
    assert_eq!(verify_bytes(&truncated).unwrap().entries(), 5);
    // … mit extern gespeichertem Anker fällt das Kürzen auf.
    assert!(matches!(
        verify_with_anchor(Cursor::new(&truncated), &anchor),
        Err(AuditError::AnchorNotFound { seq }) if seq == anchor.seq
    ));
    // Vollständiges Protokoll besteht die Anker-Prüfung, auch mit einem älteren Anker.
    assert!(verify_with_anchor(Cursor::new(&bytes), &anchor).is_ok());
    let older = AuditAnchor {
        seq: 2,
        hash: serde_json::from_str::<AuditEntry>(&lines(&bytes)[2])
            .unwrap()
            .hash,
    };
    assert!(verify_with_anchor(Cursor::new(&bytes), &older).is_ok());
    // Falscher Anker-Hash.
    let wrong = AuditAnchor {
        seq: 2,
        hash: EntryHash::GENESIS,
    };
    assert!(matches!(
        verify_with_anchor(Cursor::new(&bytes), &wrong),
        Err(AuditError::AnchorMismatch { seq: 2 })
    ));
}

#[test]
fn broken_lines_are_reported() {
    let (bytes, _) = sample_log();
    let mut incomplete = bytes.clone();
    incomplete.pop();
    assert_eq!(problem_at(&incomplete), (11, VerifyProblem::IncompleteLine));

    let mut with_empty = lines(&bytes);
    with_empty.insert(1, String::new());
    assert_eq!(
        problem_at(&join(&with_empty)),
        (2, VerifyProblem::EmptyLine)
    );

    let mut invalid_utf8 = b"\xff\xfe".to_vec();
    invalid_utf8.push(b'\n');
    assert_eq!(problem_at(&invalid_utf8), (1, VerifyProblem::InvalidUtf8));

    assert!(matches!(
        problem_at(b"{\"seq\":0}\n"),
        (1, VerifyProblem::Malformed(_))
    ));
    assert!(matches!(
        problem_at(b"kein json\n"),
        (1, VerifyProblem::Malformed(_))
    ));

    let mut extra_field = lines(&bytes);
    extra_field[0] = extra_field[0].replacen("{\"seq\":0", "{\"admin\":true,\"seq\":0", 1);
    assert!(matches!(
        problem_at(&join(&extra_field)),
        (1, VerifyProblem::Malformed(_))
    ));

    let mut crlf = lines(&bytes);
    crlf[0].push('\r');
    assert!(matches!(
        problem_at(&join(&crlf)),
        (1, VerifyProblem::Malformed(_) | VerifyProblem::NonCanonical)
    ));
}

#[test]
fn resume_continues_the_chain() {
    let (bytes, log) = sample_log();
    let report = verify_bytes(&bytes).unwrap();
    let mut resumed = AuditLog::resume(bytes.clone(), &report);
    assert_eq!(resumed.head_hash(), log.head_hash());
    assert_eq!(resumed.anchor(), log.anchor());
    assert_eq!(resumed.next_seq(), report.entries());
    let entry = resumed
        .append(
            T0 + Duration::hours(1),
            AuditEvent::PlanExpired { plan_id: pid(9) },
        )
        .unwrap();
    assert_eq!(entry.seq, report.entries());
    assert_eq!(entry.prev_hash, report.head_hash());
    let all = resumed.into_inner();
    assert_eq!(verify_bytes(&all).unwrap().entries(), report.entries() + 1);
}

struct FailingWriter {
    fail: bool,
}

impl Write for FailingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.fail {
            Err(io::Error::other("Datenträger voll"))
        } else {
            Ok(buf.len())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn write_failure_poisons_the_log() {
    let mut log = AuditLog::new(FailingWriter { fail: false });
    log.append(T0, AuditEvent::PlanExpired { plan_id: pid(1) })
        .unwrap();
    let head = log.head_hash();
    let seq = log.next_seq();
    log.writer.fail = true;
    let err = log
        .append(T0, AuditEvent::PlanExpired { plan_id: pid(2) })
        .unwrap_err();
    assert!(matches!(err, AuditError::Io(_)));
    assert!(err.to_string().contains("Datenträger voll"));
    assert!(log.is_poisoned());
    assert_eq!(log.head_hash(), head);
    assert_eq!(log.next_seq(), seq);
    log.writer.fail = false;
    assert!(matches!(
        log.append(T0, AuditEvent::PlanExpired { plan_id: pid(3) }),
        Err(AuditError::Poisoned)
    ));
}

struct FailingReader;

impl io::Read for FailingReader {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("Lesefehler"))
    }
}

#[test]
fn read_failure_is_reported() {
    assert!(matches!(
        verify(BufReader::new(FailingReader)),
        Err(AuditError::Io(_))
    ));
}

#[test]
fn timestamps_are_normalised_to_utc() {
    let mut log = AuditLog::new(Vec::new());
    let entry = log
        .append(
            datetime!(2026-10-19 10:00:00.5 +02:00),
            AuditEvent::PlanExpired { plan_id: pid(1) },
        )
        .unwrap();
    assert_eq!(entry.at, T0);
    assert_eq!(entry.at.offset(), UtcOffset::UTC);
    assert!(
        String::from_utf8(log.into_inner())
            .unwrap()
            .contains("\"at\":\"2026-10-19T08:00:00.5Z\"")
    );

    let mut log = AuditLog::new(Vec::new());
    assert!(matches!(
        log.append(
            datetime!(9999-12-31 23:00 -05:00),
            AuditEvent::PlanExpired { plan_id: pid(1) }
        ),
        Err(AuditError::InvalidTimestamp)
    ));
    assert!(!log.is_poisoned());
}

#[test]
fn sequence_overflow_is_an_error() {
    let report = VerifyReport {
        entries: u64::MAX,
        last: None,
    };
    let mut log = AuditLog::resume(Vec::new(), &report);
    assert!(matches!(
        log.append(T0, AuditEvent::PlanExpired { plan_id: pid(1) }),
        Err(AuditError::SequenceOverflow)
    ));
}

#[cfg(unix)]
#[test]
fn unrepresentable_event_is_a_serialize_error() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let mut log = AuditLog::new(Vec::new());
    let event = AuditEvent::PlanProposed {
        plan_id: pid(1),
        digest: digest(1),
        kind: ActionKind::Quarantine,
        severity: RiskLevel::Info,
        what: "x".into(),
        targets: vec![Target::file(std::path::Path::new(OsStr::from_bytes(
            b"/\xff",
        )))],
        expires_at: T0,
    };
    assert!(matches!(
        log.append(T0, event),
        Err(AuditError::Serialize(_))
    ));
    assert!(!log.is_poisoned());
    assert!(log.get_ref().is_empty());
}

#[test]
fn every_event_roundtrips_and_names_its_plan() {
    let expected_ids = [1, 1, 2, 3, 4, 4, 4, 4, 1, 1, 6];
    for (event, id) in all_events().into_iter().zip(expected_ids) {
        assert_eq!(event.plan_id(), pid(id));
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(serde_json::from_str::<AuditEvent>(&json).unwrap(), event);
    }
    let json = serde_json::to_value(&all_events()[8]).unwrap();
    assert_eq!(json["type"], "action_executed");
    assert_eq!(json["result"]["status"], "succeeded");
}

#[test]
fn execution_result_helpers() {
    assert!(ExecutionResult::Succeeded.is_success());
    assert!(
        !ExecutionResult::Failed {
            message: "x".into()
        }
        .is_success()
    );
    assert!(
        !ExecutionResult::PartiallySucceeded {
            message: "x".into()
        }
        .is_success()
    );
}

#[test]
fn entry_hash_text_form() {
    let hash = EntryHash::from_bytes([0xab; 32]);
    let text = hash.to_string();
    assert_eq!(text, "ab".repeat(32));
    assert_eq!(text.parse::<EntryHash>().unwrap(), hash);
    assert_eq!("AB".repeat(32).parse::<EntryHash>(), Err(InvalidEntryHash));
    assert_eq!(format!("{hash:?}"), format!("EntryHash({text})"));
    assert_eq!(EntryHash::GENESIS.as_bytes(), &[0; 32]);
    assert_eq!(String::from(hash), text);
    let json = serde_json::to_string(&hash).unwrap();
    assert_eq!(serde_json::from_str::<EntryHash>(&json).unwrap(), hash);
    assert!(serde_json::from_str::<EntryHash>("\"00\"").is_err());
    assert!(InvalidEntryHash.to_string().contains("Hex"));
    let anchor = AuditAnchor { seq: 3, hash };
    let json = serde_json::to_string(&anchor).unwrap();
    assert_eq!(serde_json::from_str::<AuditAnchor>(&json).unwrap(), anchor);
}

#[test]
fn messages_are_german() {
    let problems = [
        VerifyProblem::IncompleteLine,
        VerifyProblem::InvalidUtf8,
        VerifyProblem::EmptyLine,
        VerifyProblem::Malformed("x".into()),
        VerifyProblem::NonCanonical,
        VerifyProblem::SequenceMismatch {
            expected: 1,
            found: 2,
        },
        VerifyProblem::PrevHashMismatch,
        VerifyProblem::HashMismatch,
    ];
    for problem in problems {
        let message = AuditError::Verify { line: 7, problem }.to_string();
        assert!(message.starts_with("Prüfprotokoll beschädigt oder manipuliert (Zeile 7): "));
    }
    assert!(AuditError::Poisoned.to_string().contains("gesperrt"));
    assert!(
        AuditError::InvalidTimestamp
            .to_string()
            .contains("Zeitpunkt")
    );
    assert!(
        AuditError::SequenceOverflow
            .to_string()
            .contains("erschöpft")
    );
    assert!(
        AuditError::AnchorNotFound { seq: 1 }
            .to_string()
            .contains("gekürzt")
    );
    assert!(
        AuditError::AnchorMismatch { seq: 1 }
            .to_string()
            .contains("verändert")
    );
}

#[test]
fn gate_events_form_a_verifiable_log() {
    let clock = ManualClock::new(T0);
    let mut gate = ConsentGate::with_clock(clock.clone(), ConsentConfig::default()).unwrap();
    let mut log = AuditLog::new(Vec::new());

    let plan = sample_plan(ActionKind::Quarantine, clock.now()).unwrap();
    let ticket = gate.propose(plan.clone()).unwrap();
    clock.advance(Duration::seconds(20));
    let Outcome::Approved(approval) = gate
        .decide(
            ticket.id,
            &ticket.digest,
            Decision::Execute,
            DecisionOrigin::ui_dialog("dlg"),
        )
        .unwrap()
    else {
        panic!("Freigabe erwartet");
    };
    log.append_all(gate.take_audit_events()).unwrap();
    let permit = approval.redeem(&plan, gate.clock()).unwrap();
    log.append(clock.now(), permit.complete(ExecutionResult::Succeeded))
        .unwrap();

    let ignored = gate
        .propose(sample_plan(ActionKind::Quarantine, clock.now()).unwrap())
        .unwrap();
    clock.advance(Duration::minutes(11));
    assert_eq!(gate.expire_stale(), vec![ignored.id]);
    log.append_all(gate.take_audit_events()).unwrap();

    let bytes = log.into_inner();
    let report = verify_bytes(&bytes).unwrap();
    assert_eq!(report.entries(), 5);
    let types: Vec<String> = lines(&bytes)
        .iter()
        .map(|line| {
            let entry: AuditEntry = serde_json::from_str(line).unwrap();
            serde_json::to_value(&entry.event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        types,
        [
            "plan_proposed",
            "decision_recorded",
            "action_executed",
            "plan_proposed",
            "plan_expired"
        ]
    );
}
