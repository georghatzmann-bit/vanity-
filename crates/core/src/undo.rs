//! Rückgängig-Einträge: Was nach einer Ausführung nötig wäre, um sie umzukehren.
//!
//! Bezug zur Goldenen Regel: Ein [`UndoRecord`] ist nur eine Beschreibung. Das
//! Rückgängigmachen selbst ist wieder eine Veränderung und läuft deshalb über einen eigenen
//! [`crate::plan::ActionPlan`] mit eigener Bestätigung; im Prüfprotokoll erscheint es als
//! [`crate::audit::AuditEvent::ActionUndone`].

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::plan::{PlanId, Target};

/// Rückgängig-Information zu einem ausgeführten Plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoRecord {
    /// Ausgeführter Plan.
    pub plan_id: PlanId,
    /// Zeitpunkt der Ausführung.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Schritte in der Reihenfolge, in der sie zum Umkehren auszuführen sind.
    pub steps: Vec<UndoStep>,
}

/// Ein einzelner Schritt zum Umkehren.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[non_exhaustive]
pub enum UndoStep {
    /// Datei zurücklegen (z. B. aus der Quarantäne oder nach Verschieben/Umbenennen).
    RestoreFile {
        /// Aktueller Ort (z. B. Quarantäne-Eintrag).
        from: PathBuf,
        /// Ursprünglicher Ort.
        to: PathBuf,
    },
    /// Angehaltenen Prozess fortsetzen.
    ResumeProcess {
        /// Prozess-ID.
        pid: u32,
    },
    /// Früheren Wert einer Einstellung wiederherstellen.
    RestoreSetting {
        /// Kennung der Einstellung.
        id: String,
        /// Vorheriger Wert als JSON.
        previous_value_json: String,
    },
    /// Früheren Registrierungswert wiederherstellen.
    RestoreRegistryValue {
        /// Schlüssel.
        key: String,
        /// Name des Werts (leer = Standardwert).
        name: String,
        /// Vorheriger Wert als JSON (`null` = Wert existierte nicht).
        previous_value_json: String,
    },
    /// Eintrag aus der Vertrauensliste wieder entfernen.
    RemoveTrust {
        /// Ziel, dem vertraut wurde.
        target: Target,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::test_path;

    #[test]
    fn serde_roundtrip() {
        let record = UndoRecord {
            plan_id: PlanId::new_random(),
            created_at: time::macros::datetime!(2026-10-19 12:00:00.5 UTC),
            steps: vec![
                UndoStep::RestoreFile {
                    from: test_path("quarantine/1.bin"),
                    to: test_path("Downloads/tool.exe"),
                },
                UndoStep::ResumeProcess { pid: 4711 },
                UndoStep::RestoreSetting {
                    id: "realtime.enabled".into(),
                    previous_value_json: "true".into(),
                },
                UndoStep::RestoreRegistryValue {
                    key: r"HKCU\Software\Test".into(),
                    name: String::new(),
                    previous_value_json: "null".into(),
                },
                UndoStep::RemoveTrust {
                    target: Target::setting("demo"),
                },
            ],
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"restore_file""#));
        assert!(json.contains(r#""type":"resume_process""#));
        let back: UndoRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, record);
    }

    #[test]
    fn rejects_unknown_fields() {
        let json = r#"{"type":"resume_process","pid":1,"extra":true}"#;
        assert!(serde_json::from_str::<UndoStep>(json).is_err());
    }
}
