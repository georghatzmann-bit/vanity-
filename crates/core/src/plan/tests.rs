use std::collections::BTreeSet;

use time::Duration;
use time::macros::datetime;

use super::*;
use crate::testing::{sample_plan, sample_plan_builder, test_path};

const T0: OffsetDateTime = datetime!(2026-10-19 10:00:00.123456789 UTC);

fn fixed_id() -> PlanId {
    PlanId::from_uuid(Uuid::from_u128(0x0123_4567_89ab_4def_8123_4567_89ab_cdef))
}

fn base() -> ActionPlanBuilder {
    sample_plan_builder(ActionKind::Quarantine).id(fixed_id())
}

fn err(builder: ActionPlanBuilder) -> PlanError {
    builder.build(T0).unwrap_err()
}

#[test]
fn builds_valid_plan_with_all_fields() {
    let plan = ActionPlan::builder(ActionKind::Quarantine)
        .id(fixed_id())
        .target(Target::file(test_path("Downloads/a.exe")))
        .targets([Target::file(test_path("Downloads/b.exe"))])
        .what("Zwei Dateien in Quarantäne verschieben")
        .why("Signatur „Test.Dummy“ erkannt")
        .consequence("Die Dateien sind danach nicht mehr ausführbar")
        .undo(UndoHint::reversible("Quarantäne → Wiederherstellen"))
        .severity(RiskLevel::Dangerous)
        .parameter("note", "frei")
        .build(T0)
        .unwrap();
    assert_eq!(plan.id(), fixed_id());
    assert_eq!(plan.kind(), ActionKind::Quarantine);
    assert_eq!(plan.targets().len(), 2);
    assert_eq!(plan.what(), "Zwei Dateien in Quarantäne verschieben");
    assert_eq!(plan.why(), "Signatur „Test.Dummy“ erkannt");
    assert_eq!(
        plan.consequence(),
        "Die Dateien sind danach nicht mehr ausführbar"
    );
    assert!(plan.undo().is_reversible());
    assert_eq!(plan.undo().text(), "Quarantäne → Wiederherstellen");
    assert_eq!(plan.severity(), RiskLevel::Dangerous);
    assert_eq!(plan.parameter("note"), Some("frei"));
    assert_eq!(plan.parameter("missing"), None);
    assert_eq!(plan.parameters().len(), 1);
    assert_eq!(plan.created_at(), T0);
}

#[test]
fn random_ids_differ() {
    let a = sample_plan(ActionKind::Quarantine, T0).unwrap();
    let b = sample_plan(ActionKind::Quarantine, T0).unwrap();
    assert_ne!(a.id(), b.id());
    assert_ne!(a.digest(), b.digest());
}

#[test]
fn missing_texts_are_rejected() {
    let mut b = base();
    b.what = None;
    assert_eq!(err(b), PlanError::MissingText { field: "Was genau" });
    let mut b = base();
    b.why = None;
    assert_eq!(err(b), PlanError::MissingText { field: "Warum" });
    let mut b = base();
    b.consequence = None;
    assert_eq!(
        err(b),
        PlanError::MissingText {
            field: "Was passiert dann"
        }
    );
    assert_eq!(
        err(base().what("   \n\t")),
        PlanError::MissingText { field: "Was genau" }
    );
    assert_eq!(
        err(base().why("")),
        PlanError::MissingText { field: "Warum" }
    );
    assert_eq!(
        err(base().consequence(" ")),
        PlanError::MissingText {
            field: "Was passiert dann"
        }
    );
    assert_eq!(
        err(base().undo(UndoHint::reversible(" "))),
        PlanError::MissingText {
            field: "Rückgängig"
        }
    );
}

#[test]
fn invalid_texts_are_rejected() {
    assert!(matches!(
        err(base().what("x".repeat(MAX_TEXT_BYTES + 1))),
        PlanError::InvalidText {
            field: "Was genau",
            ..
        }
    ));
    assert!(base().what("x".repeat(MAX_TEXT_BYTES)).build(T0).is_ok());
    assert!(matches!(
        err(base().why("a\0b")),
        PlanError::InvalidText { field: "Warum", .. }
    ));
}

#[test]
fn missing_undo_and_severity_are_rejected() {
    let mut b = base();
    b.undo = None;
    assert_eq!(err(b), PlanError::MissingUndo);
    let mut b = base();
    b.severity = None;
    assert_eq!(err(b), PlanError::MissingSeverity);
}

#[test]
fn needs_at_least_one_target() {
    let mut b = base();
    b.targets.clear();
    assert_eq!(err(b), PlanError::NoTargets);
}

#[test]
fn too_many_targets_are_rejected() {
    let mut b = base();
    b.targets = (0..=MAX_TARGETS)
        .map(|i| Target::other(format!("Ziel {i}")))
        .collect();
    assert_eq!(err(b), PlanError::TooManyTargets { max: MAX_TARGETS });
}

#[test]
fn delete_and_terminate_must_be_irreversible() {
    for kind in [ActionKind::DeletePermanently, ActionKind::TerminateProcess] {
        let builder = sample_plan_builder(kind).undo(UndoHint::reversible("geht angeblich"));
        assert_eq!(err(builder), PlanError::MustBeIrreversible { kind });
        assert!(sample_plan(kind, T0).is_ok());
    }
    // Andere Aktionen dürfen ehrlich als nicht umkehrbar gekennzeichnet werden.
    assert!(
        base()
            .undo(UndoHint::irreversible("vorsichtshalber"))
            .build(T0)
            .is_ok()
    );
}

#[test]
fn targets_must_match_kind() {
    let process = Target::process(77, test_path("p.exe"));
    let file = Target::file(test_path("f.bin"));
    let setting = Target::setting("a.b");
    let registry = Target::registry_value(r"HKCU\Software\Test", "Wert");
    let other = Target::other("Etwas anderes");

    let mut b = base();
    b.targets = vec![file.clone(), process.clone()];
    assert_eq!(
        err(b),
        PlanError::TargetNotAllowed {
            kind: ActionKind::Quarantine,
            index: 1
        }
    );

    let mut b = sample_plan_builder(ActionKind::TerminateProcess);
    b.targets = vec![file.clone()];
    assert!(matches!(
        err(b),
        PlanError::TargetNotAllowed { index: 0, .. }
    ));

    let mut b =
        sample_plan_builder(ActionKind::ChangeSetting).parameter(param::VALUE_TYPE, "REG_SZ");
    b.targets = vec![setting.clone(), registry.clone(), other.clone()];
    assert!(b.build(T0).is_ok());

    let mut b = sample_plan_builder(ActionKind::ChangeSetting);
    b.targets = vec![file.clone()];
    assert!(matches!(err(b), PlanError::TargetNotAllowed { .. }));

    let mut b = sample_plan_builder(ActionKind::AddTrust);
    b.targets = vec![file.clone(), process.clone(), other.clone()];
    assert!(b.build(T0).is_ok());

    let mut b = sample_plan_builder(ActionKind::RemoveTrust);
    b.targets = vec![registry];
    assert!(matches!(err(b), PlanError::TargetNotAllowed { .. }));

    // Vollständige Matrix gegen die dokumentierten Regeln.
    for kind in ActionKind::ALL {
        for target in [&file, &process, &setting, &other] {
            let expected = match kind {
                ActionKind::Quarantine
                | ActionKind::Restore
                | ActionKind::DeletePermanently
                | ActionKind::MoveFile
                | ActionKind::RenameFile
                | ActionKind::RunInSandbox => matches!(target, Target::File { .. }),
                ActionKind::SuspendProcess
                | ActionKind::ResumeProcess
                | ActionKind::TerminateProcess => matches!(target, Target::Process { .. }),
                ActionKind::ChangeSetting => {
                    matches!(target, Target::Setting { .. } | Target::Other { .. })
                }
                ActionKind::AddTrust | ActionKind::RemoveTrust => {
                    !matches!(target, Target::Setting { .. })
                }
            };
            assert_eq!(
                kind.accepts_target(target),
                expected,
                "{kind:?} / {target:?}"
            );
        }
    }
}

#[test]
fn invalid_targets_are_rejected() {
    let cases: Vec<(Target, &str)> = vec![
        (Target::file("relativ/datei.txt"), "Pfad muss absolut sein"),
        (Target::file(""), "Pfad ist leer"),
        (
            Target::file(test_path("a/../b")),
            "Pfad darf kein „..“ enthalten",
        ),
        (
            Target::file(test_path("a\0b")),
            "Pfad enthält ein NUL-Zeichen",
        ),
        (
            Target::file(test_path(&"x".repeat(MAX_TEXT_BYTES))),
            "Pfad ist zu lang",
        ),
    ];
    for (target, reason) in cases {
        let mut b = base();
        b.targets = vec![target];
        assert_eq!(err(b), PlanError::InvalidTarget { index: 0, reason });
    }

    let mut b = sample_plan_builder(ActionKind::TerminateProcess);
    b.targets = vec![Target::process(0, test_path("p.exe"))];
    assert_eq!(
        err(b),
        PlanError::InvalidTarget {
            index: 0,
            reason: "Prozess-ID 0 ist nicht erlaubt"
        }
    );
    let mut b = sample_plan_builder(ActionKind::TerminateProcess);
    b.targets = vec![Target::process(5, "p.exe")];
    assert!(matches!(err(b), PlanError::InvalidTarget { .. }));

    for target in [
        Target::setting(" "),
        Target::other(""),
        Target::registry_value("", "x"),
        Target::registry_value("HKCU\\X", "a\0"),
        Target::setting("x".repeat(MAX_TEXT_BYTES + 1)),
    ] {
        let mut b = sample_plan_builder(ActionKind::ChangeSetting);
        b.targets = vec![target.clone()];
        assert!(
            matches!(err(b), PlanError::InvalidTarget { index: 0, .. }),
            "{target:?}"
        );
    }
    // Leerer Wertname = Standardwert, erlaubt.
    let mut b =
        sample_plan_builder(ActionKind::ChangeSetting).parameter(param::VALUE_TYPE, "REG_SZ");
    b.targets = vec![Target::registry_value(r"HKCU\Software\Test", "")];
    assert!(b.build(T0).is_ok());
}

#[cfg(unix)]
#[test]
fn non_unicode_paths_are_rejected() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let mut b = base();
    b.targets = vec![Target::file(Path::new(OsStr::from_bytes(b"/tmp/\xff")))];
    assert_eq!(
        err(b),
        PlanError::InvalidTarget {
            index: 0,
            reason: "Pfad ist kein gültiges Unicode"
        }
    );
}

#[cfg(windows)]
#[test]
fn non_unicode_paths_are_rejected() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    let wide: Vec<u16> = r"C:\x".encode_utf16().chain([0xD800]).collect();
    let mut b = base();
    b.targets = vec![Target::file(PathBuf::from(OsString::from_wide(&wide)))];
    assert_eq!(
        err(b),
        PlanError::InvalidTarget {
            index: 0,
            reason: "Pfad ist kein gültiges Unicode"
        }
    );
}

#[test]
fn duplicate_targets_are_rejected() {
    let file = Target::file(test_path("doppelt.exe"));
    let mut b = base();
    b.targets = vec![file.clone(), Target::file(test_path("anders.exe")), file];
    assert_eq!(err(b), PlanError::DuplicateTarget { index: 2 });
}

#[test]
fn move_file_requires_valid_destination() {
    let mut b = sample_plan_builder(ActionKind::MoveFile);
    b.parameters.clear();
    assert_eq!(
        err(b),
        PlanError::MissingParameter {
            kind: ActionKind::MoveFile,
            key: param::DESTINATION
        }
    );
    let b = sample_plan_builder(ActionKind::MoveFile).parameter(param::DESTINATION, "relativ");
    assert!(matches!(err(b), PlanError::InvalidParameter { key, .. } if key == "destination"));
    assert!(sample_plan(ActionKind::MoveFile, T0).is_ok());
}

#[test]
fn rename_requires_single_target_and_valid_name() {
    let b = sample_plan_builder(ActionKind::RenameFile).target(Target::file(test_path("zwei")));
    assert_eq!(
        err(b),
        PlanError::ExactlyOneTarget {
            kind: ActionKind::RenameFile
        }
    );
    let mut b = sample_plan_builder(ActionKind::RenameFile);
    b.parameters.clear();
    assert_eq!(
        err(b),
        PlanError::MissingParameter {
            kind: ActionKind::RenameFile,
            key: param::NEW_NAME
        }
    );
    for bad in ["a/b", r"a\b", ".", "..", " "] {
        let b = sample_plan_builder(ActionKind::RenameFile).parameter(param::NEW_NAME, bad);
        assert!(
            matches!(err(b), PlanError::InvalidParameter { key, .. } if key == "new_name"),
            "{bad}"
        );
    }
}

#[test]
fn parameters_are_validated() {
    for bad_key in ["", "Groß", "mit leerzeichen", "ü", &"k".repeat(65)] {
        let b = base().parameter(bad_key, "v");
        assert!(
            matches!(err(b), PlanError::InvalidParameter { .. }),
            "{bad_key:?}"
        );
    }
    assert!(base().parameter("ok_key.v-1", "").build(T0).is_ok());
    assert!(matches!(
        err(base().parameter("k", "a\0")),
        PlanError::InvalidParameter { .. }
    ));
    let mut b = base();
    for i in 0..=MAX_PARAMETERS {
        b = b.parameter(format!("k{i}"), "v");
    }
    assert_eq!(
        err(b),
        PlanError::TooManyParameters {
            max: MAX_PARAMETERS
        }
    );
}

#[test]
fn timestamps_are_normalised_and_validated() {
    let local = datetime!(2026-10-19 12:00:00.123456789 +02:00);
    let plan = base().build(local).unwrap();
    assert_eq!(plan.created_at().offset(), UtcOffset::UTC);
    assert_eq!(plan.created_at(), T0);
    // Gleicher Zeitpunkt in anderer Zone → gleiche Prüfsumme.
    assert_eq!(plan.digest(), base().build(T0).unwrap().digest());

    assert_eq!(
        base()
            .build(datetime!(1969-12-31 23:59:59 UTC))
            .unwrap_err(),
        PlanError::InvalidTimestamp
    );
    assert_eq!(
        base()
            .build(datetime!(9999-12-31 23:00 -05:00))
            .unwrap_err(),
        PlanError::InvalidTimestamp
    );
    assert!(base().build(datetime!(9999-12-31 23:59:59 UTC)).is_ok());
}

#[test]
fn nil_id_is_rejected() {
    let b = base().id(PlanId::from_uuid(Uuid::nil()));
    assert_eq!(err(b), PlanError::InvalidPlanId);
}

#[test]
fn digest_changes_when_any_field_changes() {
    let reference = base().build(T0).unwrap();
    let variants: Vec<(&str, ActionPlan)> = vec![
        (
            "id",
            base()
                .id(PlanId::from_uuid(Uuid::from_u128(42)))
                .build(T0)
                .unwrap(),
        ),
        ("kind", {
            let mut b = base();
            b.kind = ActionKind::Restore;
            b.build(T0).unwrap()
        }),
        (
            "targets (zusätzlich)",
            base()
                .target(Target::file(test_path("x")))
                .build(T0)
                .unwrap(),
        ),
        ("targets (anders)", {
            let mut b = base();
            b.targets = vec![Target::file(test_path("Downloads/beispiel.exf"))];
            b.build(T0).unwrap()
        }),
        ("targets (Reihenfolge)", {
            let mut b = base().target(Target::file(test_path("zweite")));
            b.targets.reverse();
            b.build(T0).unwrap()
        }),
        ("what", base().what("Anders").build(T0).unwrap()),
        ("why", base().why("Anders").build(T0).unwrap()),
        (
            "consequence",
            base().consequence("Anders").build(T0).unwrap(),
        ),
        (
            "undo (Text)",
            base()
                .undo(UndoHint::reversible("Anders"))
                .build(T0)
                .unwrap(),
        ),
        ("undo (Art)", {
            let reversible = base().build(T0).unwrap();
            base()
                .undo(UndoHint::irreversible(reversible.undo().text()))
                .build(T0)
                .unwrap()
        }),
        (
            "severity",
            base().severity(RiskLevel::Dangerous).build(T0).unwrap(),
        ),
        ("parameters", base().parameter("k", "v").build(T0).unwrap()),
        (
            "parameters (Wert)",
            base().parameter("k", "w").build(T0).unwrap(),
        ),
        (
            "created_at (+1 ns)",
            base().build(T0 + Duration::nanoseconds(1)).unwrap(),
        ),
    ];
    let mut digests = BTreeSet::new();
    assert!(digests.insert(reference.digest()));
    for (name, plan) in &variants {
        assert_ne!(plan.digest(), reference.digest(), "Feld {name}");
        assert!(digests.insert(plan.digest()), "Kollision bei {name}");
    }
    // Wiederholte Berechnung ist stabil.
    assert_eq!(reference.digest(), reference.clone().digest());
}

#[test]
fn digest_of_process_and_other_targets_covers_every_field() {
    let a = sample_plan_builder(ActionKind::TerminateProcess)
        .id(fixed_id())
        .build(T0)
        .unwrap();
    let mut b = sample_plan_builder(ActionKind::TerminateProcess).id(fixed_id());
    b.targets = vec![Target::process(4243, test_path("Programme/beispiel.exe"))];
    let mut c = sample_plan_builder(ActionKind::TerminateProcess).id(fixed_id());
    c.targets = vec![Target::process(4242, test_path("Programme/anders.exe"))];
    let digests: BTreeSet<_> = [a, b.build(T0).unwrap(), c.build(T0).unwrap()]
        .iter()
        .map(ActionPlan::digest)
        .collect();
    assert_eq!(digests.len(), 3);

    let reg = |key: &str, name: &str| {
        let mut b = sample_plan_builder(ActionKind::ChangeSetting)
            .id(fixed_id())
            .parameter(param::VALUE_TYPE, "REG_SZ");
        b.targets = vec![Target::registry_value(key, name)];
        b.build(T0).unwrap().digest()
    };
    // Schlüssel/Name-Grenze ist eindeutig kodiert.
    assert_ne!(reg("ab", "c"), reg("a", "bc"));
    let one = |target: Target| {
        let mut b = sample_plan_builder(ActionKind::ChangeSetting).id(fixed_id());
        b.targets = vec![target];
        b.build(T0).unwrap().digest()
    };
    assert_ne!(one(Target::setting("x")), one(Target::other("x")));
}

/// Goldene Werte: Schlägt dieser Test fehl, hat sich die kanonische Kodierung verändert.
/// Das ändert alle Prüfsummen und muss bewusst als neue Version (`…-V2`) geschehen.
/// Der Plan wird direkt (ohne Plattform-Pfadprüfung) gebaut, damit beide Werte auf jedem
/// Betriebssystem geprüft werden. Die Werte wurden unabhängig (Python-Nachbau der
/// dokumentierten Kodierung) gegengerechnet.
#[test]
fn digest_golden_values() {
    let golden = |path: &str| ActionPlan {
        id: fixed_id(),
        kind: ActionKind::Quarantine,
        targets: vec![Target::file(path)],
        what: "Was".into(),
        why: "Warum".into(),
        consequence: "Folge".into(),
        undo: UndoHint::reversible("Zurück"),
        severity: RiskLevel::Suspicious,
        parameters: BTreeMap::from([("k".to_owned(), "v".to_owned())]),
        created_at: T0,
    };
    assert_eq!(
        golden("/golden/datei.exe").digest().to_string(),
        GOLDEN_UNIX
    );
    assert_eq!(
        golden(r"C:\golden\datei.exe").digest().to_string(),
        GOLDEN_WINDOWS
    );
}

const GOLDEN_UNIX: &str = "87832a206f7c56c667e3cbdf1a41283098ac581f97776b97a7c40bdc41197e2e";
const GOLDEN_WINDOWS: &str = "7d397070913841d2c6ae3f3ea5df5e2244fa8f89bf5cb21f85496669cc8e59ea";

#[test]
fn digest_stable_across_serde_roundtrip() {
    for kind in ActionKind::ALL {
        let plan = sample_plan_builder(kind)
            .parameter("extra", "wert")
            .build(T0)
            .unwrap();
        let json = serde_json::to_string(&plan).unwrap();
        let back: ActionPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(back, plan);
        assert_eq!(back.digest(), plan.digest(), "{kind:?}");
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}

#[test]
fn json_shape_matches_ui_contract() {
    let plan = base().build(T0).unwrap();
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["kind"], "quarantine");
    assert_eq!(json["severity"], "suspicious");
    assert_eq!(json["targets"][0]["type"], "file");
    assert_eq!(json["undo"]["type"], "reversible");
    assert_eq!(json["created_at"], "2026-10-19T10:00:00.123456789Z");
    assert_eq!(json["id"], "01234567-89ab-4def-8123-456789abcdef");
}

#[test]
fn deserialization_validates_like_the_builder() {
    let plan = sample_plan(ActionKind::DeletePermanently, T0).unwrap();
    let mut json = serde_json::to_value(&plan).unwrap();
    json["undo"] = serde_json::json!({"type": "reversible", "how": "Papierkorb"});
    let error = serde_json::from_value::<ActionPlan>(json).unwrap_err();
    assert!(error.to_string().contains("nicht rückgängig"), "{error}");

    let mut json = serde_json::to_value(&plan).unwrap();
    json["targets"] = serde_json::json!([]);
    assert!(serde_json::from_value::<ActionPlan>(json).is_err());

    let mut json = serde_json::to_value(&plan).unwrap();
    json["approved"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ActionPlan>(json).is_err());

    let mut json = serde_json::to_value(&plan).unwrap();
    json["targets"][0]["sneaky"] = serde_json::json!(1);
    assert!(serde_json::from_value::<ActionPlan>(json).is_err());

    // Fehlende Parameter gelten als leer.
    let mut json = serde_json::to_value(&plan).unwrap();
    json.as_object_mut().unwrap().remove("parameters");
    assert_eq!(serde_json::from_value::<ActionPlan>(json).unwrap(), plan);
}

#[test]
fn plan_digest_text_form() {
    let digest = base().build(T0).unwrap().digest();
    let text = digest.to_string();
    assert_eq!(text.len(), 64);
    assert!(
        text.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(text.parse::<PlanDigest>().unwrap(), digest);
    assert_eq!(
        text.to_uppercase().parse::<PlanDigest>(),
        Err(PlanError::InvalidDigest)
    );
    assert_eq!("abc".parse::<PlanDigest>(), Err(PlanError::InvalidDigest));
    assert_eq!(PlanDigest::from_bytes(*digest.as_bytes()), digest);
    assert_eq!(format!("{digest:?}"), format!("PlanDigest({text})"));
    let json = serde_json::to_string(&digest).unwrap();
    assert_eq!(json, format!("\"{text}\""));
    assert_eq!(serde_json::from_str::<PlanDigest>(&json).unwrap(), digest);
    assert!(serde_json::from_str::<PlanDigest>("\"zz\"").is_err());
    assert_eq!(String::from(digest), text);
}

#[test]
fn plan_id_text_form() {
    let id = fixed_id();
    assert_eq!(id.to_string(), "01234567-89ab-4def-8123-456789abcdef");
    assert_eq!(id.to_string().parse::<PlanId>().unwrap(), id);
    assert_eq!("kein-uuid".parse::<PlanId>(), Err(PlanError::InvalidPlanId));
    assert_eq!(
        id.as_uuid().as_u128(),
        0x0123_4567_89ab_4def_8123_4567_89ab_cdef
    );
    let json = serde_json::to_string(&id).unwrap();
    assert_eq!(json, "\"01234567-89ab-4def-8123-456789abcdef\"");
    assert_eq!(serde_json::from_str::<PlanId>(&json).unwrap(), id);
    assert_eq!(PlanId::new_random().as_uuid().get_version_num(), 4);
}

#[test]
fn kind_metadata() {
    for kind in ActionKind::ALL {
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, format!("\"{}\"", kind.as_str()));
        assert_eq!(serde_json::from_str::<ActionKind>(&json).unwrap(), kind);
        assert!(!kind.label_de().is_empty());
        assert!(!kind.label_en().is_empty());
        assert_eq!(kind.to_string(), kind.label_de());
        assert_eq!(
            kind.must_be_irreversible(),
            matches!(
                kind,
                ActionKind::DeletePermanently | ActionKind::TerminateProcess
            )
        );
        assert_eq!(
            kind.requires_second_confirmation(),
            kind == ActionKind::DeletePermanently
        );
    }
    let labels: BTreeSet<_> = ActionKind::ALL.iter().map(|k| k.label_de()).collect();
    assert_eq!(labels.len(), ActionKind::ALL.len());
    let labels_en: BTreeSet<_> = ActionKind::ALL.iter().map(|k| k.label_en()).collect();
    assert_eq!(labels_en.len(), ActionKind::ALL.len());
}

#[test]
fn target_display_and_type() {
    let cases = [
        (Target::file(test_path("a.txt")), "file", "Datei "),
        (
            Target::process(9, test_path("p.exe")),
            "process",
            "Prozess 9 (",
        ),
        (
            Target::registry_value(r"HKCU\X", "Name"),
            "registry_value",
            r"Registrierungswert HKCU\X\Name",
        ),
        (
            Target::registry_value(r"HKCU\X", ""),
            "registry_value",
            r"Registrierungswert HKCU\X (Standard)",
        ),
        (Target::setting("s.id"), "setting", "Einstellung s.id"),
        (Target::other("Freitext"), "other", "Freitext"),
    ];
    for (target, type_str, display_prefix) in cases {
        assert_eq!(target.type_str(), type_str);
        assert!(target.to_string().starts_with(display_prefix), "{target}");
        let json = serde_json::to_value(&target).unwrap();
        assert_eq!(json["type"], type_str);
        assert_eq!(serde_json::from_value::<Target>(json).unwrap(), target);
    }
}

#[test]
fn undo_hint_helpers() {
    let r = UndoHint::reversible("so");
    let i = UndoHint::irreversible("weg");
    assert!(r.is_reversible());
    assert!(!i.is_reversible());
    assert_eq!(r.text(), "so");
    assert_eq!(i.text(), "weg");
    assert_eq!(
        serde_json::to_string(&i).unwrap(),
        r#"{"type":"irreversible","warning":"weg"}"#
    );
}

#[test]
fn error_messages_are_german() {
    let messages = [
        PlanError::MissingText { field: "Warum" }.to_string(),
        PlanError::NoTargets.to_string(),
        PlanError::MustBeIrreversible {
            kind: ActionKind::DeletePermanently,
        }
        .to_string(),
        PlanError::TargetNotAllowed {
            kind: ActionKind::TerminateProcess,
            index: 0,
        }
        .to_string(),
        PlanError::InvalidDigest.to_string(),
    ];
    assert_eq!(messages[0], "Pflichtangabe „Warum“ fehlt oder ist leer");
    assert!(messages[1].contains("kein Ziel"));
    assert!(messages[2].contains("„Endgültig löschen“"));
    assert!(messages[3].contains("„Prozess beenden“"));
    assert!(messages[4].contains("Prüfsumme"));
}

#[test]
fn canonical_bytes_start_with_domain() {
    let bytes = base().build(T0).unwrap().canonical_bytes();
    assert!(
        bytes
            .windows(b"AEGIS-ACTIONPLAN-V1".len())
            .any(|w| w == b"AEGIS-ACTIONPLAN-V1")
    );
}

// ---------------------------------------------------------------------------------------
// Regressionen aus dem Security-Review
// ---------------------------------------------------------------------------------------

#[test]
fn change_setting_binds_the_new_value() {
    // Ohne neuen Wert gibt es keinen Plan – sonst müsste ein Ausführer ihn von außen nehmen.
    for target in [
        Target::setting("realtime.enabled"),
        Target::registry_value(
            r"HKLM\SOFTWARE\Policies\Microsoft\Windows Defender",
            "DisableAntiSpyware",
        ),
    ] {
        let mut b = sample_plan_builder(ActionKind::ChangeSetting);
        b.targets = vec![target];
        b.parameters.clear();
        assert_eq!(
            err(b),
            PlanError::MissingParameter {
                kind: ActionKind::ChangeSetting,
                key: param::VALUE
            }
        );
    }
    // Registrierungswerte brauchen zusätzlich einen bekannten Typ.
    let registry = Target::registry_value(r"HKCU\Software\Test", "Wert");
    let mut b = sample_plan_builder(ActionKind::ChangeSetting);
    b.targets = vec![registry.clone()];
    assert_eq!(
        err(b),
        PlanError::MissingParameter {
            kind: ActionKind::ChangeSetting,
            key: param::VALUE_TYPE
        }
    );
    let mut b =
        sample_plan_builder(ActionKind::ChangeSetting).parameter(param::VALUE_TYPE, "REG_WHATEVER");
    b.targets = vec![registry.clone()];
    assert!(matches!(
        err(b),
        PlanError::InvalidParameter { key, .. } if key == param::VALUE_TYPE
    ));
    for value_type in param::REGISTRY_VALUE_TYPES {
        let mut b =
            sample_plan_builder(ActionKind::ChangeSetting).parameter(param::VALUE_TYPE, value_type);
        b.targets = vec![registry.clone()];
        assert!(b.build(T0).is_ok(), "{value_type}");
    }
    // Ein leerer Wert ist erlaubt (z. B. leere Zeichenkette).
    assert!(
        sample_plan_builder(ActionKind::ChangeSetting)
            .parameter(param::VALUE, "")
            .build(T0)
            .is_ok()
    );
    // Der Wert ist Teil der Prüfsumme: „aus“ statt „an“ ist ein anderer Plan.
    let with = |value: &str| {
        sample_plan_builder(ActionKind::ChangeSetting)
            .id(fixed_id())
            .parameter(param::VALUE, value)
            .build(T0)
            .unwrap()
            .digest()
    };
    assert_ne!(with("true"), with("false"));
    let typed = |value_type: &str| {
        let mut b = sample_plan_builder(ActionKind::ChangeSetting)
            .id(fixed_id())
            .parameter(param::VALUE, "1")
            .parameter(param::VALUE_TYPE, value_type);
        b.targets = vec![Target::registry_value(r"HKCU\Software\Test", "Wert")];
        b.build(T0).unwrap().digest()
    };
    assert_ne!(typed("REG_DWORD"), typed("REG_SZ"));
}

#[test]
fn restore_goes_back_to_the_target_path() {
    let b = sample_plan_builder(ActionKind::Restore).parameter(
        param::DESTINATION,
        test_path("Anderswo").display().to_string(),
    );
    assert!(matches!(
        err(b),
        PlanError::InvalidParameter { key, .. } if key == param::DESTINATION
    ));
    assert!(sample_plan(ActionKind::Restore, T0).is_ok());
}

#[test]
fn rename_rejects_names_with_windows_side_effects() {
    for bad in [
        "D:evil.exe",   // Laufwerk: „umbenennen“ würde auf ein anderes Laufwerk verschieben
        "x.txt:stream", // alternativer Datenstrom
        "CON",          // Gerätenamen …
        "nul.txt",      // … auch mit Endung
        "Com1",         // … ohne Rücksicht auf Groß-/Kleinschreibung
        "LPT9.log",
        "COM\u{b9}",
        "CONOUT$",
        "aux .txt", // … und mit Leerzeichen vor der Endung
        "...",      // Punkte am Ende entfernt Win32 still
        "trail. ",
        "trail ",
        "a\u{202e}gpj.exe", // Schreibrichtung umgekehrt: täuscht „.jpg“ vor
        "a\u{2066}b",
        "a\nb", // Steuerzeichen
        "a\tb",
        "a<b",
        "a>b",
        "a|b",
        "a?b",
        "a*b",
        "a\"b",
    ] {
        let b = sample_plan_builder(ActionKind::RenameFile).parameter(param::NEW_NAME, bad);
        assert!(
            matches!(err(b), PlanError::InvalidParameter { key, .. } if key == "new_name"),
            "{bad:?}"
        );
    }
    for good in [
        "umbenannt.exe",
        ".versteckt",
        "CONFIG.sys",
        "console.log",
        "COM10",
        "LPT",
        "nulled.txt",
        "Bericht März 2026.pdf",
    ] {
        let b = sample_plan_builder(ActionKind::RenameFile).parameter(param::NEW_NAME, good);
        assert!(b.build(T0).is_ok(), "{good:?}");
    }
}

#[test]
fn labor_lauf_braucht_gueltige_parameter() {
    let ok = sample_plan_builder(ActionKind::RunInSandbox);
    assert!(
        ok.clone()
            .build(crate::time::OffsetDateTime::UNIX_EPOCH)
            .is_ok()
    );
    for (key, value) in [
        (param::LAB_STAGE, "vm"),
        (param::LAB_SECONDS, "4"),
        (param::LAB_SECONDS, "601"),
        (param::LAB_SECONDS, "x"),
        (param::LAB_NETWORK, "on"),
        (param::LAB_NETWORK, "vielleicht"),
        (param::LAB_SHA256, "abc"),
        (param::LAB_SHA256, &"zz".repeat(32)),
    ] {
        let b = ok.clone().parameter(key, value);
        assert!(
            matches!(
                b.build(crate::time::OffsetDateTime::UNIX_EPOCH),
                Err(PlanError::InvalidParameter { .. })
            ),
            "{key}={value}"
        );
    }
    let net = ok
        .clone()
        .parameter(param::LAB_STAGE, "windows_sandbox")
        .parameter(param::LAB_NETWORK, "on");
    assert!(net.build(crate::time::OffsetDateTime::UNIX_EPOCH).is_ok());
}
