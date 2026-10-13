//! Admin-Helfer: führt eine feste Liste erlaubter Aufgaben mit Adminrechten aus – mit EINER UAC-Abfrage.
//!
//! Ablauf: `run_elevated(&tasks)` schreibt die Aufgaben als JSON in eine Temp-Datei und startet
//! `Pulsar.exe --elevated <aufgaben.json> --result <ergebnis.json>` mit dem Verb `runas`.
//! Der Helfer prüft jede Aufgabe gegen die Erlaubt-Liste, führt sie aus und schreibt das Ergebnis.
//! Läuft Pulsar schon als Admin, werden die Aufgaben direkt im eigenen Prozess ausgeführt.

use serde::{Deserialize, Serialize};

/// Registry-Zweig für Admin-Aufgaben (HKCU braucht keinen Helfer).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Hive {
    Hklm,
}

/// Eine erlaubte Admin-Aufgabe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ElevTask {
    /// REG_DWORD setzen (nur Pfade aus der Erlaubt-Liste)
    SetDword { hive: Hive, path: String, name: String, value: u32 },
    /// Registry-Wert löschen (zurück auf Windows-Standard)
    DeleteValue { hive: Hive, path: String, name: String },
    /// DNS-Server einer Verbindung fest einstellen (`adapter_guid` = "{…}")
    SetDns { adapter_guid: String, servers: Vec<String> },
    /// DNS einer Verbindung wieder automatisch (DHCP) beziehen
    ResetDns { adapter_guid: String },
}

/// Ergebnis einer Aufgabe (gleiche Reihenfolge wie die Aufgaben).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElevResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ElevError {
    /// Die UAC-Abfrage wurde abgelehnt
    Cancelled,
    /// Helfer konnte nicht gestartet werden / kein Ergebnis
    Failed(String),
}

impl std::fmt::Display for ElevError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElevError::Cancelled => write!(f, "Die Admin-Abfrage wurde abgelehnt."),
            ElevError::Failed(e) => write!(f, "{e}"),
        }
    }
}

/// Führt die Aufgaben mit Adminrechten aus (blockierend – aus `spawn_blocking` aufrufen).
pub fn run_elevated(tasks: &[ElevTask]) -> Result<Vec<ElevResult>, ElevError> {
    let _ = tasks;
    Err(ElevError::Failed("Der Admin-Helfer ist noch nicht fertig.".into()))
}
